// Instagram captions. An AI model rewrites the tweet in the brand voice; the result is
// checked against the source before use, and the plain template is the fallback.

import type { Brand } from "./render/brand.ts";
import { BANNED_PHRASES, VOICE } from "./voice.ts";

const IG_CAPTION_LIMIT = 2200;
const AI_BODY_LIMIT = 1200;

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}
/** Runs a chat model and returns its text. Workers AI binding in the Worker. */
export type RunModel = (messages: ChatMessage[], temperature: number) => Promise<string>;

export interface Caption {
  text: string;
  source: "ai" | "template";
  /** Why the AI caption wasn't used, when it wasn't. */
  fallbackReason?: string;
}

const SYSTEM_PROMPT = `You write Instagram captions that repurpose X posts.

${VOICE}

Rules:
1. First line is a hook under 100 characters that makes someone stop scrolling. It must be true to the source.
2. Use ONLY facts from the source post. Never invent, round or change a record, line, odds, percentage, team, player or date. Keep records exactly as written, including losses and pushes (e.g. 16-2-1). If unsure about a detail, leave it out.
3. Never promise or imply winnings. Never use hype like "lock", "guaranteed", "can't lose", "free money", "sure thing".
4. Short lines with a blank line between ideas. Emoji sparingly, at most one per line, preferably ones the source already uses.
5. Don't say "tweet", "thread" or "retweet". It's fine to keep phrases like "on X" when they describe a record.
6. End with exactly one of the calls to action above.
7. No hashtags and no URLs (they're added separately). Under ${AI_BODY_LIMIT} characters.
8. Reply with the caption text only. No preamble, no quotes around it.`;

export async function writeCaption(
  sourceText: string,
  brand: Brand,
  runModel: RunModel,
  opts: { fresh?: boolean } = {},
): Promise<Caption> {
  // A "new caption" request starts hotter so it doesn't repeat the last one.
  const temperatures = opts.fresh ? [0.9, 0.7] : [0.6, 0.8];
  let reason = "";

  for (const temperature of temperatures) {
    try {
      const raw = await runModel(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Source post:\n"""\n${sourceText}\n"""` },
        ],
        temperature,
      );
      const body = tidy(raw);
      reason = validate(body, sourceText);
      if (!reason) return { text: withHashtags(body, sourceText, brand), source: "ai" };
    } catch (err) {
      reason = `AI unavailable (${(err as Error).message})`;
    }
  }
  return { text: templateCaption(sourceText, brand), source: "template", fallbackReason: reason };
}

export function templateCaption(sourceText: string, brand: Brand): string {
  return withHashtags(`${sourceText}\n\n${brand.caption.signoff}`, sourceText, brand);
}

// Returns "" if the caption is usable, otherwise why not.
function validate(body: string, sourceText: string): string {
  if (body.length < 40) return "AI caption was empty or too short";
  if (body.length > AI_BODY_LIMIT + 300) return "AI caption was too long";
  const banned = BANNED_PHRASES.find((re) => re.test(body) && !re.test(sourceText));
  if (banned) return `AI caption used banned wording (${banned.source})`;

  // Every number in the caption must appear in the source: no invented stats.
  const sourceNumbers = new Set(numbers(sourceText));
  const invented = numbers(body).filter((n) => !sourceNumbers.has(n));
  if (invented.length) return `AI caption had numbers not in the tweet: ${invented.join(", ")}`;
  return "";
}

// Records, odds, times and plain numbers, normalised (no leading +/−, dashes unified).
function numbers(text: string): string[] {
  return (text.match(/\d+(?:[.,:\-–]\d+)*/g) ?? []).map((n) => n.replace(/–/g, "-"));
}

function tidy(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:caption|here'?s[^\n]*caption[^\n]*):?\s*\n?/i, "") // "Here's a caption:" preambles
    .replace(/^["“]|["”]$/g, "") // wrapping quotes
    .replace(/(?:^|\s)#\w+/g, "") // hashtags are added by code
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Sport mentioned in the text → hashtag, in this order.
const SPORT_TAGS: [RegExp, string][] = [
  [/\bNFL\b/i, "#NFL"],
  [/\b(CFB|college football)\b/i, "#CFB"],
  [/\bWNBA\b/i, "#WNBA"],
  [/\bNBA\b/i, "#NBA"],
  [/\b(CBB|college basketball)\b/i, "#CBB"],
  [/\bCFL\b/i, "#CFL"],
];

function withHashtags(body: string, sourceText: string, brand: Brand): string {
  const sports = SPORT_TAGS.filter(([re]) => re.test(sourceText)).map(([, tag]) => tag);
  const tail = `\n\n${[...new Set([...sports, ...brand.caption.hashtags])].join(" ")}`;
  const room = IG_CAPTION_LIMIT - tail.length;
  return (body.length <= room ? body : `${body.slice(0, room - 1).trimEnd()}…`) + tail;
}
