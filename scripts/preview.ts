// Render tweets to PNGs locally so the card design can be reviewed.
//   npm run preview -- https://x.com/jack/status/20 [more urls...]
//   npm run preview -- --thread <url of the thread's LAST tweet>
//   npm run preview -- --samples --twemoji

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchTweet, type Tweet } from "../src/tweet/fetch.ts";
import { fetchThread } from "../src/tweet/thread.ts";
import { SAMPLES } from "./samples.ts";
import { renderSlides } from "../src/render/render.ts";
import { loadBrand, loadRenderDeps } from "../src/platform/node.ts";

const args = process.argv.slice(2);
const urls = args.filter((a) => !a.startsWith("--"));
const useSamples = args.includes("--samples");
const asThread = args.includes("--thread");
if (urls.length === 0 && !useSamples) {
  console.error("Usage: npm run preview -- [--thread] [--samples] [--twemoji] <tweet url> [more urls...]");
  process.exit(1);
}

const brand = await loadBrand();
if (args.includes("--twemoji")) brand.emoji = "twemoji";
const deps = await loadRenderDeps(brand);

const outDir = path.resolve(import.meta.dirname, "../out");
await mkdir(outDir, { recursive: true });

// Each job becomes one post: a single tweet, or a whole thread as a carousel.
type Job = { label: string; load: () => Promise<Tweet[]> };
const jobs: Job[] = [
  ...(useSamples ? SAMPLES.map((t) => ({ label: t.id, load: async () => [t] })) : []),
  ...urls.map((url) => ({
    label: url,
    load: async () => {
      if (!asThread) return [await fetchTweet(url)];
      const thread = await fetchThread(url);
      if (thread.droppedCount) console.warn(`! thread has ${thread.droppedCount} more tweets than fit a carousel`);
      return thread.tweets;
    },
  })),
];

for (const job of jobs) {
  try {
    const tweets = await job.load();
    const cpu = process.cpuUsage();
    const pngs = await renderSlides(tweets, brand, deps);
    const cpuMs = Math.round(process.cpuUsage(cpu).user / 1000);

    const base = tweets.at(-1)!.id;
    for (const [i, png] of pngs.entries()) {
      const suffix = pngs.length > 1 ? `-${i + 1}of${pngs.length}` : "";
      const file = path.join(outDir, `${base}${suffix}-${brand.emoji}.png`);
      await writeFile(file, png);
      console.log(`✓ ${file}`);
    }
    console.log(`  ${pngs.length} slide(s), ${cpuMs}ms CPU`);
  } catch (err) {
    console.error(`✗ ${job.label}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
