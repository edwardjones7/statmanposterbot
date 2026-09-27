// Tweet -> PNG. Runtime-agnostic: the caller supplies fonts and an initialised Resvg
// (Node loads them from disk, the Cloudflare Worker bundles them).

import satori from "satori";
import type { Resvg as ResvgClass } from "@resvg/resvg-wasm";
import type { Tweet } from "../tweet/fetch.ts";
import type { Brand } from "./brand.ts";
import { buildBody, buildCard, hasFooter, textMaxHeight, FONT, WIDTH, HEIGHT, type SlideInfo } from "./card.ts";

export interface RenderDeps {
  fonts: {
    body: ArrayBuffer; // Inter 400
    display: ArrayBuffer; // Outfit 700
    mono: ArrayBuffer; // JetBrains Mono 500
    monoBold: ArrayBuffer; // JetBrains Mono 700
  };
  Resvg: typeof ResvgClass;
  /** Brand images as data URIs, already loaded by the platform. */
  logo?: string;
  texture?: string;
}

/**
 * Renders one PNG per tweet: a single post for one tweet, a carousel for a thread.
 * Every slide in a carousel shares one font size (the size the longest tweet needs),
 * so swiping between slides doesn't jump between text sizes.
 */
export async function renderSlides(tweets: Tweet[], brand: Brand, deps: RenderDeps): Promise<Uint8Array[]> {
  const avatars = new Map<string, Promise<string>>();
  const avatarFor = (url: string) => {
    if (!avatars.has(url)) avatars.set(url, toDataUri(url));
    return avatars.get(url)!;
  };

  const slides = await Promise.all(
    tweets.map(async (tweet) => ({
      tweet,
      assets: { avatar: await avatarFor(tweet.author.avatarUrl), logo: deps.logo, texture: deps.texture },
    })),
  );
  const maxHeight = textMaxHeight(brand, hasFooter(brand, slides[0].assets));
  const sizes = await Promise.all(slides.map(({ tweet }) => fitFontSize(tweet.text, brand, deps, maxHeight)));
  const fontSize = Math.min(...sizes);
  // Carousel cards all take the tallest slide's text height, so the card doesn't
  // change size or jump position as you swipe.
  const bodyHeight =
    slides.length > 1
      ? Math.max(...(await Promise.all(slides.map(({ tweet }) => measureText(tweet.text, brand, deps, fontSize)))))
      : undefined;

  const pngs: Uint8Array[] = [];
  for (const [i, { tweet, assets }] of slides.entries()) {
    const slide: SlideInfo = { index: i + 1, total: slides.length };
    const tree = buildCard(tweet, brand, assets, { fontSize, bodyHeight }, slide);
    const svg = await satori(tree as unknown as SatoriNode, satoriOptions(brand, deps, { width: WIDTH, height: HEIGHT }));
    pngs.push(new deps.Resvg(svg, { fitTo: { mode: "width", value: WIDTH } }).render().asPng());
  }
  return pngs;
}

const MAX_FONT = 60;
const MIN_FONT = 28;

// Laid-out height of the text block. Satori sizes the SVG to its content when no
// height is given, so rendering the block alone measures it exactly.
async function measureText(text: string, brand: Brand, deps: RenderDeps, fontSize: number): Promise<number> {
  const svg = await satori(buildBody(text, brand, fontSize) as unknown as SatoriNode, satoriOptions(brand, deps, { width: WIDTH }));
  return Number(svg.match(/height="([\d.]+)"/)?.[1] ?? Infinity);
}

// Largest even font size whose laid-out text fits.
async function fitFontSize(text: string, brand: Brand, deps: RenderDeps, maxHeight: number): Promise<number> {
  const heightAt = (size: number) => measureText(text, brand, deps, size);

  let lo = MIN_FONT / 2;
  let hi = MAX_FONT / 2;
  if ((await heightAt(hi * 2)) <= maxHeight) return MAX_FONT;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((await heightAt(mid * 2)) <= maxHeight) lo = mid;
    else hi = mid - 1;
  }
  return lo * 2;
}

type SatoriNode = Parameters<typeof satori>[0];

function satoriOptions(brand: Brand, deps: RenderDeps, size: { width: number; height?: number }) {
  return {
    ...size,
    fonts: [
      { name: FONT.body, data: deps.fonts.body, weight: 400 as const, style: "normal" as const },
      { name: FONT.display, data: deps.fonts.display, weight: 700 as const, style: "normal" as const },
      { name: FONT.mono, data: deps.fonts.mono, weight: 500 as const, style: "normal" as const },
      { name: FONT.mono, data: deps.fonts.monoBold, weight: 700 as const, style: "normal" as const },
    ],
    loadAdditionalAsset: async (code: string, segment: string) =>
      code === "emoji" ? emojiDataUri(segment, brand.emoji) : "",
  } as Parameters<typeof satori>[1];
}

async function toDataUri(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed (${res.status}): ${url}`);
  const type = res.headers.get("content-type") ?? "image/jpeg";
  return `data:${type};base64,${bytesToBase64(new Uint8Array(await res.arrayBuffer()))}`;
}

const EMOJI_SOURCES = {
  // Apple artwork via the emoji-datasource project. 64px PNGs: sharp at our text sizes.
  apple: (name: string) => `https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64/${name}.png`,
  // Twemoji, the artwork X uses on the web.
  twemoji: (name: string) => `https://cdn.jsdelivr.net/gh/jdecked/twemoji@16.0.1/assets/svg/${name}.svg`,
};

const emojiCache = new Map<string, Promise<string>>();
function emojiDataUri(segment: string, style: Brand["emoji"]): Promise<string> {
  const key = `${style}:${segment}`;
  let cached = emojiCache.get(key);
  if (!cached) {
    cached = fetchEmoji(segment, style);
    emojiCache.set(key, cached);
  }
  return cached;
}

// Emoji file names are dash-joined hex codepoints, but sets disagree on whether the
// FE0F variation selector is included, so try with it and then without.
async function fetchEmoji(segment: string, style: Brand["emoji"]): Promise<string> {
  const codepoints = Array.from(segment).map((ch) => ch.codePointAt(0)!.toString(16));
  const names = [...new Set([codepoints.join("-"), codepoints.filter((cp) => cp !== "fe0f").join("-")])];
  for (const name of names) {
    try {
      return await toDataUri(EMOJI_SOURCES[style](name));
    } catch {
      // try the next spelling
    }
  }
  return "";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
