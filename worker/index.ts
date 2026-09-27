// Cloudflare Worker: the always-on half of the pipeline (free plan).
//
//   POST /telegram                 Telegram webhook: tweet links in, button presses
//   PUT  /jobs/:id/media/:file     render job uploads slide JPEGs → KV
//   POST /jobs/:id/ready|failed    render job reports its result
//   GET  /media/:id/:file          serves slides publicly (Instagram fetches them from here)
//
// Rendering itself runs in GitHub Actions: it needs ~1.5s CPU per slide and the free
// Workers plan allows 10ms. Everything here is network-bound, which doesn't count.

import { Telegram } from "../src/telegram.ts";
import { parseTweetId } from "../src/tweet/fetch.ts";
import { ACTIONS, previewButtons, previewText, type Job, type JobMode, type JobReady } from "../src/job.ts";
import { writeCaption, type RunModel } from "../src/caption.ts";
import type { Brand } from "../src/render/brand.ts";
import brandJson from "../brand.json";

const brand = brandJson as Brand;

export interface Env {
  /** Job records, pending caption edits and slide images (KV: free with no card, unlike R2). */
  STORE: KVNamespace;
  AI: Ai;
  /** Workers AI text model used for captions. */
  CAPTION_MODEL: string;
  TELEGRAM_BOT_TOKEN: string;
  /** Sent by Telegram in X-Telegram-Bot-Api-Secret-Token; proves the webhook call is real. */
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Comma-separated Telegram user IDs allowed to use the bot. */
  TELEGRAM_ALLOWED_USER_IDS: string;
  /** Fine-grained token with Actions: read & write on GITHUB_REPO. */
  GITHUB_TOKEN: string;
  GITHUB_REPO: string; // "owner/name"
  /** Shared with the render job so only it can upload media and report results. */
  JOB_CALLBACK_SECRET: string;
  /** Local development only: send render jobs to scripts/dev-bridge.ts instead of GitHub. */
  DEV_DISPATCH_URL?: string;
}

const JOB_TTL = 60 * 60 * 24 * 30; // keep job records 30 days
const EDIT_TTL = 60 * 60; // a pending caption edit expires after an hour

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (req.method === "POST" && url.pathname === "/telegram") {
        if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
          return new Response("forbidden", { status: 403 });
        }
        const update = (await req.json()) as TgUpdate;
        // Ack immediately; Telegram retries (and duplicates work) if we're slow.
        ctx.waitUntil(handleUpdate(update, env).catch((err) => console.error("update failed", err)));
        return new Response("ok");
      }

      if (parts[0] === "jobs" && parts.length >= 3) {
        if (req.headers.get("Authorization") !== `Bearer ${env.JOB_CALLBACK_SECRET}`) {
          return new Response("forbidden", { status: 403 });
        }
        const [, jobId, action, file] = parts;
        if (req.method === "PUT" && action === "media" && file && /^\d+\.jpg$/.test(file)) {
          await env.STORE.put(mediaKey(jobId, file), await req.arrayBuffer(), { expirationTtl: JOB_TTL });
          return new Response("stored");
        }
        if (req.method === "POST" && (action === "ready" || action === "failed")) {
          return await jobReport(jobId, action, await req.json(), env);
        }
      }

      if (req.method === "GET" && parts[0] === "media" && parts.length === 3) {
        const image = await env.STORE.get(mediaKey(parts[1], parts[2]), "arrayBuffer");
        if (!image) return new Response("not found", { status: 404 });
        return new Response(image, {
          headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
        });
      }

      if (url.pathname === "/") return new Response("statmanposterbot ok");
      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return new Response("error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

// ---------- Telegram ----------

interface TgUser {
  id: number;
}
interface TgUpdate {
  message?: { message_id: number; from?: TgUser; chat: { id: number }; text?: string };
  callback_query?: { id: string; from: TgUser; data?: string; message?: { message_id: number; chat: { id: number } } };
}

const HELP = [
  "Send me a tweet link and I'll turn it into an Instagram post for you to approve.",
  "",
  "• Threads: send the LAST tweet's link and you'll get a carousel.",
  "• /single <link> posts just that one tweet, even if it's part of a thread.",
].join("\n");

function isAllowed(user: TgUser | undefined, env: Env): boolean {
  return !!user && env.TELEGRAM_ALLOWED_USER_IDS.split(",").map((s) => s.trim()).includes(String(user.id));
}

async function handleUpdate(update: TgUpdate, env: Env): Promise<void> {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);

  const cb = update.callback_query;
  if (cb) {
    if (!isAllowed(cb.from, env)) return;
    await handleButton(cb, env, tg);
    return;
  }

  const msg = update.message;
  if (!msg?.text || !isAllowed(msg.from, env)) return; // strangers get silence
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  const link = text.match(/https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/\w+\/status(?:es)?\/\d+/i)?.[0];
  if (link) {
    await startJob(link, text.startsWith("/single") ? "single" : "auto", chatId, env, tg);
    return;
  }

  const editingJobId = await env.STORE.get(editKey(msg.from!.id));
  if (editingJobId && !text.startsWith("/")) {
    await applyCaptionEdit(editingJobId, text, msg.from!.id, env, tg);
    return;
  }

  await tg.sendMessage(chatId, HELP);
}

async function startJob(link: string, mode: JobMode, chatId: number, env: Env, tg: Telegram): Promise<void> {
  parseTweetId(link); // throws on anything that isn't a tweet URL
  const job: Job = {
    id: crypto.randomUUID(),
    tweetUrl: link,
    mode,
    chatId,
    status: "rendering",
    createdAt: new Date().toISOString(),
  };
  await saveJob(job, env);

  const res = await dispatchRender(job, env);
  if (!res.ok) {
    await saveJob({ ...job, status: "failed", error: `Render dispatch HTTP ${res.status}` }, env);
    await tg.sendMessage(chatId, `❌ Couldn't start the render job (HTTP ${res.status}).\n${await res.text()}`);
    return;
  }
  await tg.sendMessage(chatId, "⏳ On it — the preview will be here in about a minute.");
}

function dispatchRender(job: Job, env: Env): Promise<Response> {
  const inputs = { job_id: job.id, tweet_url: job.tweetUrl, mode: job.mode, chat_id: String(job.chatId) };
  if (env.DEV_DISPATCH_URL) {
    return fetch(env.DEV_DISPATCH_URL, { method: "POST", body: JSON.stringify(inputs) });
  }
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/render.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "statmanposterbot",
    },
    body: JSON.stringify({ ref: "main", inputs }),
  });
}

async function handleButton(cb: NonNullable<TgUpdate["callback_query"]>, env: Env, tg: Telegram): Promise<void> {
  const [action, jobId] = (cb.data ?? "").split(":");
  const job = jobId ? await loadJob(jobId, env) : null;
  const chatId = cb.message?.chat.id ?? cb.from.id;

  if (!job) {
    await tg.answerCallback(cb.id, "That post has expired.");
    return;
  }
  if (job.status !== "ready") {
    await tg.answerCallback(cb.id, `Already ${job.status}.`);
    return;
  }

  switch (action) {
    case ACTIONS.approve: {
      await saveJob({ ...job, status: "approved" }, env);
      await tg.answerCallback(cb.id, "Approved");
      if (job.previewMessageId) await tg.clearButtons(chatId, job.previewMessageId);
      // Step 5 replaces this with the Instagram publish.
      await tg.sendMessage(chatId, "✅ Approved. Instagram publishing isn't connected yet (step 5).");
      return;
    }
    case ACTIONS.edit: {
      await env.STORE.put(editKey(cb.from.id), job.id, { expirationTtl: EDIT_TTL });
      await tg.answerCallback(cb.id);
      await tg.sendMessage(chatId, "✏️ Send the new caption as your next message. Current caption to copy and edit:");
      await tg.sendMessage(chatId, job.caption ?? "");
      return;
    }
    case ACTIONS.regenerate: {
      await tg.answerCallback(cb.id, "Writing a new caption…");
      await sendPreview(job, env, tg, { fresh: true });
      return;
    }
    case ACTIONS.reject: {
      await saveJob({ ...job, status: "rejected" }, env);
      await tg.answerCallback(cb.id, "Rejected");
      if (job.previewMessageId) await tg.clearButtons(chatId, job.previewMessageId);
      await tg.sendMessage(chatId, "🗑️ Rejected — nothing was posted.");
      return;
    }
  }
}

async function applyCaptionEdit(jobId: string, caption: string, userId: number, env: Env, tg: Telegram): Promise<void> {
  await env.STORE.delete(editKey(userId));
  const job = await loadJob(jobId, env);
  if (!job || job.status !== "ready") return;

  if (job.previewMessageId) await tg.clearButtons(job.chatId, job.previewMessageId).catch(() => {});
  const preview = await tg.sendMessage(
    job.chatId,
    previewText(caption, job.slideCount ?? 1, job.tweetUrl),
    previewButtons(job.id),
  );
  await saveJob({ ...job, caption, previewMessageId: preview.message_id }, env);
}

// ---------- Render job callbacks ----------

async function jobReport(jobId: string, action: "ready" | "failed", body: unknown, env: Env): Promise<Response> {
  const job = await loadJob(jobId, env);
  if (!job) return new Response("unknown job", { status: 404 });

  if (action === "ready") {
    const r = body as JobReady;
    const readyJob: Job = { ...job, status: "ready", sourceText: r.sourceText, slideCount: r.slideCount };
    await sendPreview(readyJob, env, new Telegram(env.TELEGRAM_BOT_TOKEN), { note: r.note });
  } else {
    await saveJob({ ...job, status: "failed", error: (body as { error?: string }).error }, env);
  }
  return new Response("ok");
}

// ---------- Captions ----------

/** Writes a caption for the job and sends it as a fresh preview with buttons. */
async function sendPreview(job: Job, env: Env, tg: Telegram, opts: { fresh?: boolean; note?: string } = {}): Promise<void> {
  const caption = await writeCaption(job.sourceText ?? "", brand, workersAi(env), { fresh: opts.fresh });
  const notes = [opts.note, caption.fallbackReason && `ℹ️ Template caption used: ${caption.fallbackReason}`]
    .filter(Boolean)
    .join("\n");

  if (job.previewMessageId) await tg.clearButtons(job.chatId, job.previewMessageId).catch(() => {});
  const preview = await tg.sendMessage(
    job.chatId,
    previewText(caption.text, job.slideCount ?? 1, job.tweetUrl, notes || undefined),
    previewButtons(job.id),
  );
  await saveJob({ ...job, caption: caption.text, previewMessageId: preview.message_id }, env);
}

function workersAi(env: Env): RunModel {
  return async (messages, temperature) => {
    const out = (await env.AI.run(env.CAPTION_MODEL as Parameters<Ai["run"]>[0], {
      messages,
      temperature,
      max_tokens: 800,
    })) as { response?: unknown; choices?: { message?: { content?: string } }[] };
    // Older Workers AI models return { response }, OpenAI-compatible ones return { choices }.
    const text = typeof out.response === "string" ? out.response : out.choices?.[0]?.message?.content;
    if (!text) throw new Error("empty model response");
    return text;
  };
}

// ---------- Storage ----------

const jobKey = (id: string) => `job:${id}`;
const editKey = (userId: number) => `editing:${userId}`;
const mediaKey = (jobId: string, file: string) => `media:${jobId}/${file}`;

async function loadJob(id: string, env: Env): Promise<Job | null> {
  return env.STORE.get<Job>(jobKey(id), "json");
}

async function saveJob(job: Job, env: Env): Promise<void> {
  await env.STORE.put(jobKey(job.id), JSON.stringify(job), { expirationTtl: JOB_TTL });
}
