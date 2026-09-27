// Local development bridge, so the whole bot can be tested from a phone without
// deploying anything:
//   1. long-polls Telegram and forwards each update to the local Worker (wrangler dev),
//      standing in for the webhook;
//   2. listens for render dispatches from the Worker and runs scripts/render-job.ts,
//      standing in for GitHub Actions.
//
//   Terminal 1: npm run worker:dev
//   Terminal 2: npm run dev:bridge
//
// Only works while no webhook is set on the bot (Telegram refuses getUpdates otherwise).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { Telegram } from "../src/telegram.ts";

const WORKER = process.env.DEV_WORKER_URL ?? "http://localhost:8787";
const BRIDGE_PORT = 8788;
const token = process.env.TELEGRAM_BOT_TOKEN!;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET!;
if (!token || !webhookSecret) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set (.dev.vars)");

// --- render dispatches → local render job ---
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const inputs = JSON.parse(body) as { job_id: string; tweet_url: string; mode: string; chat_id: string };
    console.log(`▶ render ${inputs.job_id} ${inputs.tweet_url}`);
    const child = spawn("npx", ["tsx", "scripts/render-job.ts"], {
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        JOB_ID: inputs.job_id,
        TWEET_URL: inputs.tweet_url,
        MODE: inputs.mode,
        CHAT_ID: inputs.chat_id,
        WORKER_URL: WORKER,
      },
    });
    child.on("exit", (code) => console.log(`■ render ${inputs.job_id} exited ${code}`));
    res.writeHead(204).end();
  });
}).listen(BRIDGE_PORT, () => console.log(`render dispatch listener on :${BRIDGE_PORT}`));

// --- Telegram long-poll → local Worker webhook ---
const tg = new Telegram(token);
// Skip anything sent while the bridge wasn't running.
const stale = await tg.call<{ update_id: number }[]>("getUpdates", { offset: -1 });
let offset = stale.length ? stale[stale.length - 1].update_id + 1 : 0;
console.log(`forwarding Telegram updates to ${WORKER}/telegram`);
for (;;) {
  try {
    const updates = await tg.call<{ update_id: number }[]>("getUpdates", { offset, timeout: 30 });
    for (const update of updates) {
      offset = update.update_id + 1;
      const res = await fetch(`${WORKER}/telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": webhookSecret },
        body: JSON.stringify(update),
      });
      console.log(`→ update ${update.update_id}: worker ${res.status}`);
    }
  } catch (err) {
    console.error("poll error:", (err as Error).message);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
