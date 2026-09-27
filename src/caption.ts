// Template caption. Step 4 replaces this with an AI-written caption in the brand voice;
// this stays as the fallback if the AI call fails.

import type { Tweet } from "./tweet/fetch.ts";
import type { Brand } from "./render/brand.ts";

const IG_CAPTION_LIMIT = 2200;

// Sport mentioned in the text → hashtag. Order is the order hashtags appear in.
const SPORT_TAGS: [RegExp, string][] = [
  [/\bNFL\b/i, "#NFL"],
  [/\b(CFB|college football)\b/i, "#CFB"],
  [/\bWNBA\b/i, "#WNBA"],
  [/\bNBA\b/i, "#NBA"],
  [/\b(CBB|college basketball)\b/i, "#CBB"],
  [/\bCFL\b/i, "#CFL"],
];

export function templateCaption(tweets: Tweet[], brand: Brand): string {
  const text = tweets.map((t) => t.text).join("\n\n");
  const sports = SPORT_TAGS.filter(([re]) => re.test(text)).map(([, tag]) => tag);
  const hashtags = [...new Set([...sports, ...brand.caption.hashtags])].join(" ");
  const tail = `\n\n${brand.caption.signoff}\n\n${hashtags}`;

  const room = IG_CAPTION_LIMIT - tail.length;
  const body = text.length <= room ? text : `${text.slice(0, room - 1).trimEnd()}…`;
  return body + tail;
}
