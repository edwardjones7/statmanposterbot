// Render job, run by GitHub Actions (.github/workflows/render.yml) for each tweet link
// sent to the bot: fetch → render → JPEG → upload to the Worker → Telegram preview.
//
// Env: JOB_ID, TWEET_URL, MODE ("auto" | "single"), CHAT_ID, TELEGRAM_BOT_TOKEN,
//      WORKER_URL + JOB_CALLBACK_SECRET (optional locally: skips upload/reporting).
//
// Run locally:  npx tsx --env-file=.dev.vars scripts/render-job.ts  (with the vars above set)

import sharp from "sharp";
import { fetchTweet, type Tweet } from "../src/tweet/fetch.ts";
import { fetchThread } from "../src/tweet/thread.ts";
import { renderSlides } from "../src/render/render.ts";
import { loadBrand, loadRenderDeps } from "../src/platform/node.ts";
import { templateCaption } from "../src/caption.ts";
import { Telegram } from "../src/telegram.ts";
import { previewText, type JobReady } from "../src/job.ts";

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`Missing env var ${name}`);
  return value;
};

const jobId = env("JOB_ID", `local-${Date.now()}`);
const tweetUrl = env("TWEET_URL");
const mode = env("MODE", "auto");
const chatId = env("CHAT_ID", process.env.TELEGRAM_ALLOWED_USER_IDS?.split(",")[0]);
const tg = new Telegram(env("TELEGRAM_BOT_TOKEN"));
const workerUrl = process.env.WORKER_URL?.replace(/\/$/, "");
const callbackSecret = process.env.JOB_CALLBACK_SECRET;
// Running without a Worker is only for local testing; in CI it means misconfiguration.
if (process.env.GITHUB_ACTIONS && (!workerUrl || !callbackSecret)) {
  throw new Error("WORKER_URL and JOB_CALLBACK_SECRET must be set in GitHub Actions");
}

async function toWorker(path: string, body: BodyInit, contentType: string, method = "POST"): Promise<void> {
  if (!workerUrl) return;
  const res = await fetch(`${workerUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${callbackSecret}`, "Content-Type": contentType },
    body,
  });
  if (!res.ok) throw new Error(`Worker ${method} ${path}: HTTP ${res.status} ${await res.text()}`);
}

try {
  let tweets: Tweet[];
  let note = "";
  if (mode === "single") {
    tweets = [await fetchTweet(tweetUrl)];
  } else {
    const thread = await fetchThread(tweetUrl);
    tweets = thread.tweets;
    if (thread.droppedCount) {
      note = `⚠️ Thread is ${tweets.length + thread.droppedCount} tweets; only the first 10 fit a carousel.`;
    }
  }

  const brand = await loadBrand();
  const pngs = await renderSlides(tweets, brand, await loadRenderDeps(brand));
  // Instagram's publishing API only accepts JPEG.
  const jpegs = await Promise.all(pngs.map((png) => sharp(png).jpeg({ quality: 92, mozjpeg: true }).toBuffer()));
  const images = jpegs.map((buf) => new Uint8Array(buf));
  const sourceText = tweets.map((t) => t.text).join("\n\n");

  for (const [i, img] of images.entries()) {
    await toWorker(`/jobs/${jobId}/media/${i + 1}.jpg`, img as BodyInit, "image/jpeg", "PUT");
  }
  await tg.sendImages(chatId, images);

  if (workerUrl) {
    // The Worker writes the caption (Workers AI) and sends the preview with buttons.
    const ready: JobReady = { sourceText, slideCount: images.length, note: note || undefined };
    await toWorker(`/jobs/${jobId}/ready`, JSON.stringify(ready), "application/json");
  } else {
    // Standalone local run: template caption, no buttons.
    await tg.sendMessage(chatId, previewText(templateCaption(sourceText, brand), images.length, tweetUrl, note));
  }
  console.log(`Job ${jobId}: ${images.length} slide(s) ready`);
} catch (err) {
  const message = (err as Error).message;
  console.error(`Job ${jobId} failed: ${message}`);
  await tg.sendMessage(chatId, `❌ Couldn't make that post.\n\n${message}\n\n${tweetUrl}`).catch(() => {});
  await toWorker(`/jobs/${jobId}/failed`, JSON.stringify({ error: message }), "application/json").catch(() => {});
  process.exitCode = 1;
}
