// Builds the Satori element tree for one 1080x1350 Instagram slide showing a tweet card.
// Satori takes React-shaped objects; `h` builds them without pulling in React.

import type { Tweet } from "../tweet/fetch.ts";
import type { Brand } from "./brand.ts";

export const WIDTH = 1080;
export const HEIGHT = 1350;

const CANVAS_PAD = 72;
// Minimum gap above and below the card when the text is long.
const CANVAS_PAD_Y = 64;
const CARD_PAD = 64;
// The design system caps corners at 10px on the web. The image is shown ~2.8x smaller
// on a phone, so 28px here reads as 10px on screen.
const CARD_RADIUS = 28;
const TEXT_WIDTH = WIDTH - CANVAS_PAD * 2 - CARD_PAD * 2;
// Fixed heights of the non-text parts of the slide, used to work out room for the text.
const HEADER_HEIGHT = 112 + 40; // avatar + gap below
const DATE_HEIGHT = 40 + 28 + 2 + 36; // gap + padding + divider + line
const FOOTER_HEIGHT = 110;
const X_VERIFIED_BLUE = "#1D9BF0";
const X_VERIFIED_GOLD = "#E2B719";

export const FONT = { body: "Inter", display: "Outfit", mono: "JetBrains Mono" } as const;

type Style = Record<string, string | number>;
export interface El {
  type: string;
  props: { style?: Style; children?: unknown; [k: string]: unknown };
  key: null;
}

function h(type: string, props: El["props"], ...children: unknown[]): El {
  const flat = children.flat().filter((c) => c !== null && c !== undefined && c !== false && c !== "");
  return { type, props: { ...props, children: flat.length <= 1 ? flat[0] : flat }, key: null };
}

export interface CardAssets {
  avatar: string; // data URI
  logo?: string; // data URI
  texture?: string; // data URI
}

export interface SlideInfo {
  index: number; // 1-based
  total: number;
}

export function hasFooter(brand: Brand, assets: CardAssets): boolean {
  return Boolean(brand.footer.text || assets.logo);
}

// Height left for the tweet text once everything else on the slide has its space.
export function textMaxHeight(brand: Brand, footerVisible: boolean): number {
  const cardChrome = CARD_PAD * 2 + 4 + HEADER_HEIGHT + (brand.showDate ? DATE_HEIGHT : 0);
  return HEIGHT - CANVAS_PAD_Y * 2 - cardChrome - (footerVisible ? FOOTER_HEIGHT : 0);
}

// The tweet text block on its own, so the renderer can measure it at a given font size.
// `minHeight` pads short slides so every card in a carousel is the same size.
export function buildBody(text: string, brand: Brand, fontSize: number, minHeight = 0): El {
  return h(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        width: TEXT_WIDTH,
        minHeight,
        fontSize,
        lineHeight: 1.35,
        color: brand.colors.text,
      },
    },
    ...renderParagraphs(text, brand, fontSize),
  );
}

export interface CardLayout {
  fontSize: number;
  /** Minimum text block height; set to the tallest slide's so carousel cards match. */
  bodyHeight?: number;
}

export function buildCard(tweet: Tweet, brand: Brand, assets: CardAssets, layout: CardLayout, slide?: SlideInfo): El {
  const c = brand.colors;
  const footerVisible = hasFooter(brand, assets);

  const header = h(
    "div",
    { style: { display: "flex", alignItems: "center", marginBottom: 40 } },
    h("img", { src: assets.avatar, width: 112, height: 112, style: { borderRadius: 56, marginRight: 28 } }),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column" } },
      h(
        "div",
        { style: { display: "flex", alignItems: "center" } },
        h("span", { style: { fontFamily: FONT.display, fontSize: 42, fontWeight: 700, color: c.heading } }, tweet.author.name),
        tweet.author.verified !== "none" &&
          h("img", {
            src: verifiedBadge(tweet.author.verified === "business" ? X_VERIFIED_GOLD : X_VERIFIED_BLUE),
            width: 40,
            height: 40,
            style: { marginLeft: 10 },
          }),
      ),
      h("span", { style: { fontSize: 32, color: c.secondary, marginTop: 2 } }, `@${tweet.author.handle}`),
    ),
  );

  const body = buildBody(tweet.text, brand, layout.fontSize, layout.bodyHeight);

  const date =
    brand.showDate &&
    h(
      "div",
      {
        style: {
          display: "flex",
          marginTop: 40,
          paddingTop: 28,
          borderTop: `2px solid ${c.divider}`,
          fontSize: 28,
          color: c.secondary,
        },
      },
      formatDate(tweet.createdAt, brand.timeZone),
    );

  const card = h(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        width: WIDTH - CANVAS_PAD * 2,
        padding: CARD_PAD,
        backgroundColor: c.card,
        border: `2px solid ${c.border}`,
        borderRadius: CARD_RADIUS,
        boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
      },
    },
    header,
    body,
    date,
  );

  const footer =
    footerVisible &&
    h(
      "div",
      {
        style: {
          position: "absolute",
          bottom: 48,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          fontFamily: FONT.display,
          fontSize: 34,
          fontWeight: 700,
          color: c.heading,
        },
      },
      assets.logo && h("img", { src: assets.logo, width: 60, height: 60, style: { borderRadius: 16, marginRight: 18 } }),
      brand.footer.text && h("span", {}, brand.footer.text),
    );

  const counter =
    slide &&
    slide.total > 1 &&
    h(
      "div",
      {
        style: {
          // Bottom-right, level with the footer and flush with the card's right edge.
          position: "absolute",
          bottom: 52,
          right: CANVAS_PAD,
          display: "flex",
          padding: "8px 22px",
          borderRadius: 999,
          backgroundColor: c.card,
          border: `2px solid ${c.border}`,
          fontFamily: FONT.mono,
          fontSize: 26,
          fontWeight: 700,
          color: c.heading,
        },
      },
      `${slide.index}/${slide.total}`,
    );

  return h(
    "div",
    {
      style: {
        display: "flex",
        position: "relative",
        width: WIDTH,
        height: HEIGHT,
        alignItems: "center",
        justifyContent: "center",
        paddingBottom: footerVisible ? FOOTER_HEIGHT : 0,
        fontFamily: FONT.body,
        backgroundColor: c.canvas,
        ...(assets.texture
          ? { backgroundImage: `url(${assets.texture})`, backgroundSize: "840px 280px", backgroundRepeat: "repeat" }
          : {}),
      },
    },
    card,
    footer,
    counter,
  );
}

// @mentions, #hashtags (must contain a letter, so "#1" isn't one), bare or full links,
// and numbers like 114-111-3, 50.7%, -110, +3.5, $49, .700.
const TOKEN_RE =
  /((?:@\w+|#(?=\w*[a-z])\w+)|(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?|(?:(?<![\w.])[+\-−])?\$?(?:(?<![\w.])\.)?\d+(?:[.,]\d+)*(?:[-–]\d+(?:[.,]\d+)*)*%?)/gi;

// One block per paragraph, wrapped word by word so styled runs can sit inline.
function renderParagraphs(text: string, brand: Brand, fontSize: number): El[] {
  // JetBrains Mono has taller, wider glyphs than Inter; shrink it to sit level with the prose.
  const monoStyle: Style = { fontFamily: FONT.mono, fontWeight: 500, fontSize: Math.round(fontSize * 0.9) };
  return text.split("\n").map((line) => {
    if (line.trim() === "") return h("div", { style: { display: "flex", height: "0.6em" } });
    const parts = line.split(TOKEN_RE);
    return h(
      "div",
      { style: { display: "flex", flexWrap: "wrap", alignItems: "baseline" } },
      ...parts.flatMap((part, i) => {
        if (!part) return [];
        let style: Style = { whiteSpace: "pre" };
        if (i % 2 === 1) {
          const isNumber = /^[+\-−$]?\.?\d/.test(part);
          // Only stat-like numbers (records, %, odds, lines, prices) go mono; plain
          // integers like "Week 4" or "2015" read better in the body font.
          const isStat = isNumber && /[%$+\-−–.]/.test(part);
          if (!isNumber) style = { ...style, color: brand.colors.accent };
          else if (isStat && brand.monoNumbers) style = { ...style, ...monoStyle };
        }
        return part.split(/(?<= )/).map((word) => h("span", { style }, word));
      }),
    );
  });
}

function formatDate(d: Date, timeZone: string): string {
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone });
  return `${time} · ${day}`;
}

function verifiedBadge(fill: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${fill}" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
