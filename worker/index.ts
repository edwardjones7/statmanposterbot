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
import { ACTIONS, fallbackButtons, previewButtons, previewText, type Job, type JobMode, type JobReady } from "../src/job.ts";
import { Instagram, refreshToken, whoAmI } from "../src/instagram.ts";
import { writeCaption, type RunModel } from "../src/caption.ts";
import type { Brand } from "../src/render/brand.ts";
import brandJson from "../brand.json";

const brand = brandJson as Brand;

export interface Env {
  /** Job state and pending caption edits (see migrations/). */
  DB: D1Database;
  /** Slide images (KV: free with no card, unlike R2). */
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
  /** This Worker's public URL. Instagram fetches slide images from it. */
  WORKER_URL: string;
  /** Long-lived Instagram token from the Meta app dashboard. Seeds the token stored in D1. */
  IG_ACCESS_TOKEN?: string;
  /** Local development only: send render jobs to scripts/dev-bridge.ts instead of GitHub. */
  DEV_DISPATCH_URL?: string;
}

const MEDIA_TTL = 60 * 60 * 24 * 30; // slide images are kept 30 days
const EDIT_TTL_MS = 60 * 60 * 1000; // a pending caption edit expires after an hour

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (req.method === "POST" && url.pathname === "/telegram") {
        if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
          return new Response("forbidden", { status: 403 });
        }
        const update = (await req.json()) as TgUpdate;
        // Handled before answering (publishing can outlast waitUntil's time limit). If that
        // makes Telegram time out and re-send the update, the dedupe makes the retry a no-op.
        if (await alreadyProcessed(update.update_id, env)) return new Response("ok");
        await handleUpdate(update, env).catch((err) => console.error("update failed", err));
        return new Response("ok");
      }

      if (parts[0] === "jobs" && parts.length >= 3) {
        if (req.headers.get("Authorization") !== `Bearer ${env.JOB_CALLBACK_SECRET}`) {
          return new Response("forbidden", { status: 403 });
        }
        const [, jobId, action, file] = parts;
        if (req.method === "PUT" && action === "media" && file && /^\d+\.jpg$/.test(file)) {
          await env.STORE.put(mediaKey(jobId, file), await req.arrayBuffer(), { expirationTtl: MEDIA_TTL });
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

  // Every 5 minutes (wrangler.jsonc): keep the Instagram token fresh, and flag render jobs
  // that never reported back (e.g. the GitHub job crashed before it could message Telegram).
  async scheduled(_event, env) {
    await maintainInstagramToken(env).catch((err) => console.error("token maintenance failed", err));
    await env.DB.prepare("DELETE FROM processed_updates WHERE processed_at < ?").bind(Date.now() - 7 * DAY_MS).run();

    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
    const cutoff = new Date(Date.now() - RENDER_TIMEOUT_MS).toISOString();
    const { results } = await env.DB.prepare("SELECT data FROM jobs WHERE status = 'rendering' AND created_at < ?")
      .bind(cutoff)
      .all<{ data: string }>();
    for (const row of results) {
      const job = JSON.parse(row.data) as Job;
      await saveJob({ ...job, status: "failed", error: "render job never reported back" }, env);
      await tg.sendMessage(
        job.chatId,
        `❌ The render job for this link didn't finish:\n${job.tweetUrl}\n\n` +
          `Check the run log: https://github.com/${env.GITHUB_REPO}/actions/workflows/render.yml`,
      );
    }
  },
} satisfies ExportedHandler<Env>;

const RENDER_TIMEOUT_MS = 5 * 60 * 1000;

// ---------- Telegram ----------

interface TgUser {
  id: number;
}
interface TgUpdate {
  update_id: number;
  message?: { message_id: number; from?: TgUser; chat: { id: number }; text?: string };
  callback_query?: { id: string; from: TgUser; data?: string; message?: { message_id: number; chat: { id: number } } };
}

const HELP = [
  "Send me a tweet link and I'll turn it into an Instagram post for you to approve.",
  "",
  "• Threads: send the LAST tweet's link and you'll get a carousel.",
  "• /single <link> posts just that one tweet, even if it's part of a thread.",
  "• /instagram shows whether Instagram is connected.",
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

  if (text === "/instagram") {
    await tg.sendMessage(chatId, await instagramStatus(env));
    return;
  }

  const editingJobId = await pendingEdit(msg.from!.id, env);
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
      // Claim the job atomically, so a double tap or a Telegram retry can't post twice.
      if (!(await claimForPosting(job.id, env))) {
        await tg.answerCallback(cb.id, "Already being posted.");
        return;
      }
      await tg.answerCallback(cb.id, "Posting to Instagram…");
      if (cb.message) await tg.clearButtons(chatId, cb.message.message_id).catch(() => {});
      await publishJob({ ...job, status: "posting" }, env, tg);
      return;
    }
    case ACTIONS.postedManually: {
      await saveJob({ ...job, status: "posted", instagramUrl: "manual" }, env);
      await tg.answerCallback(cb.id, "Marked as posted");
      if (cb.message) await tg.clearButtons(chatId, cb.message.message_id).catch(() => {});
      await tg.sendMessage(chatId, "✔️ Marked as posted manually.");
      return;
    }
    case ACTIONS.edit: {
      await setPendingEdit(cb.from.id, job.id, env);
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
      if (cb.message) await tg.clearButtons(chatId, cb.message.message_id).catch(() => {});
      await tg.sendMessage(chatId, "🗑️ Rejected — nothing was posted.");
      return;
    }
  }
}

async function applyCaptionEdit(jobId: string, caption: string, userId: number, env: Env, tg: Telegram): Promise<void> {
  await clearPendingEdit(userId, env);
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

// ---------- Instagram ----------

async function publishJob(job: Job, env: Env, tg: Telegram): Promise<void> {
  const imageUrls = Array.from({ length: job.slideCount ?? 1 }, (_, i) => `${env.WORKER_URL}/media/${job.id}/${i + 1}.jpg`);
  try {
    const ig = await instagramClient(env);
    const { permalink } = await ig.publish(imageUrls, job.caption ?? "");
    await saveJob({ ...job, status: "posted", instagramUrl: permalink ?? "posted", error: undefined }, env);
    await tg.sendMessage(job.chatId, `🎉 Posted to Instagram!${permalink ? `\n${permalink}` : ""}`);
  } catch (err) {
    // Fallback: hand over everything needed to post by hand, and allow a retry.
    const reason = (err as Error).message;
    await saveJob({ ...job, status: "ready", error: reason }, env);
    const images = await Promise.all(
      imageUrls.map((_, i) => env.STORE.get(mediaKey(job.id, `${i + 1}.jpg`), "arrayBuffer")),
    );
    const files = images.filter((img): img is ArrayBuffer => img !== null).map((img) => new Uint8Array(img));
    await tg.sendMessage(job.chatId, `⚠️ Instagram didn't take the post:\n${reason}\n\nHere it is to post by hand:`);
    if (files.length) await tg.sendImages(job.chatId, files, "document");
    await tg.sendMessage(job.chatId, job.caption ?? "");
    await tg.sendMessage(job.chatId, "Save the files, paste the caption, and post. Then:", fallbackButtons(job.id));
  }
}

/** Moves a job from ready to posting; false if something else already did. */
async function claimForPosting(jobId: string, env: Env): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE jobs SET status = 'posting', data = json_set(data, '$.status', 'posting')
     WHERE id = ? AND status = 'ready'`,
  )
    .bind(jobId)
    .run();
  return result.meta.changes === 1;
}

// The access token lives in D1 because it's replaced on every refresh. IG_ACCESS_TOKEN
// (a Worker secret) seeds it; setting a new secret value replaces the stored token.
async function currentInstagramToken(env: Env): Promise<string | null> {
  if (env.IG_ACCESS_TOKEN && (await getSetting("ig_seed_token", env)) !== env.IG_ACCESS_TOKEN) {
    await setSetting("ig_seed_token", env.IG_ACCESS_TOKEN, env);
    await setSetting("ig_token", env.IG_ACCESS_TOKEN, env);
    await setSetting("ig_token_refreshed_at", String(Date.now()), env);
    await env.DB.prepare("DELETE FROM settings WHERE key = 'ig_user_id'").run();
  }
  return getSetting("ig_token", env);
}

async function instagramClient(env: Env): Promise<Instagram> {
  const token = await currentInstagramToken(env);
  if (!token) throw new Error("Instagram isn't connected yet (no IG_ACCESS_TOKEN)");
  let userId = await getSetting("ig_user_id", env);
  if (!userId) {
    userId = (await whoAmI(token)).userId;
    await setSetting("ig_user_id", userId, env);
  }
  return new Instagram(token, userId);
}

const TOKEN_REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Called from the cron. Tokens expire 60 days after their last refresh; refreshing
// weekly leaves weeks of slack. A failure retries daily and alerts each time.
async function maintainInstagramToken(env: Env): Promise<void> {
  const token = await currentInstagramToken(env);
  if (!token) return;
  const refreshedAt = Number((await getSetting("ig_token_refreshed_at", env)) ?? 0);
  if (Date.now() - refreshedAt < TOKEN_REFRESH_EVERY_MS) return;

  try {
    const fresh = await refreshToken(token);
    await setSetting("ig_token", fresh.token, env);
    await setSetting("ig_token_refreshed_at", String(Date.now()), env);
  } catch (err) {
    await setSetting("ig_token_refreshed_at", String(Date.now() - TOKEN_REFRESH_EVERY_MS + DAY_MS), env);
    const admin = env.TELEGRAM_ALLOWED_USER_IDS.split(",")[0].trim();
    await new Telegram(env.TELEGRAM_BOT_TOKEN).sendMessage(
      admin,
      `⚠️ Couldn't refresh the Instagram access token: ${(err as Error).message}\n\n` +
        "Posting keeps working until the token expires (60 days after its last refresh). " +
        "If this keeps happening, generate a new token in the Meta app dashboard.",
    );
  }
}

async function instagramStatus(env: Env): Promise<string> {
  const token = await currentInstagramToken(env);
  if (!token) return "📷 Instagram: not connected (no IG_ACCESS_TOKEN set).";
  try {
    const { username } = await whoAmI(token);
    const refreshedAt = Number((await getSetting("ig_token_refreshed_at", env)) ?? 0);
    const daysLeft = Math.floor((refreshedAt + 60 * DAY_MS - Date.now()) / DAY_MS);
    return `📷 Instagram: connected as @${username}. Token valid ~${daysLeft} more days (auto-refreshes weekly).`;
  } catch (err) {
    return `📷 Instagram: token rejected: ${(err as Error).message}`;
  }
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

const mediaKey = (jobId: string, file: string) => `media:${jobId}/${file}`;

async function loadJob(id: string, env: Env): Promise<Job | null> {
  const row = await env.DB.prepare("SELECT data FROM jobs WHERE id = ?").bind(id).first<{ data: string }>();
  return row ? (JSON.parse(row.data) as Job) : null;
}

async function saveJob(job: Job, env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs (id, status, created_at, data) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (id) DO UPDATE SET status = ?2, data = ?4`,
  )
    .bind(job.id, job.status, job.createdAt, JSON.stringify(job))
    .run();
}

async function pendingEdit(userId: number, env: Env): Promise<string | null> {
  return env.DB.prepare("SELECT job_id FROM caption_edits WHERE user_id = ? AND expires_at > ?")
    .bind(userId, Date.now())
    .first<string>("job_id");
}

async function setPendingEdit(userId: number, jobId: string, env: Env): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO caption_edits (user_id, job_id, expires_at) VALUES (?, ?, ?)")
    .bind(userId, jobId, Date.now() + EDIT_TTL_MS)
    .run();
}

async function clearPendingEdit(userId: number, env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM caption_edits WHERE user_id = ?").bind(userId).run();
}

async function getSetting(key: string, env: Env): Promise<string | null> {
  return env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<string>("value");
}

async function setSetting(key: string, value: string, env: Env): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(key, value, Date.now())
    .run();
}

/** Records the update; true if it was already recorded (a Telegram re-send). */
async function alreadyProcessed(updateId: number, env: Env): Promise<boolean> {
  const result = await env.DB.prepare("INSERT OR IGNORE INTO processed_updates (update_id, processed_at) VALUES (?, ?)")
    .bind(updateId, Date.now())
    .run();
  return result.meta.changes === 0;
}
