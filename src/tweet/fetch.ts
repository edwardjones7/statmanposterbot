// Fetches tweet data from X's public embed ("syndication") endpoint — the one that
// powers embedded tweets on websites. No API key needed. It is unofficial, so all
// knowledge of its response shape lives in this file.

export interface Tweet {
  id: string;
  url: string;
  text: string; // cleaned, display-ready text
  createdAt: Date;
  author: {
    name: string;
    handle: string;
    avatarUrl: string;
    verified: "blue" | "business" | "none";
  };
  parentId?: string; // set when this tweet is a reply (used to rebuild threads)
  parentAuthorHandle?: string;
}

interface RawEntityUrl {
  url: string;
  expanded_url: string;
  display_url: string;
  indices: [number, number];
}

interface RawTweet {
  id_str: string;
  text: string;
  created_at: string;
  display_text_range?: [number, number];
  entities?: { urls?: RawEntityUrl[]; media?: { url: string }[] };
  user: {
    name: string;
    screen_name: string;
    profile_image_url_https: string;
    is_blue_verified?: boolean;
    verified?: boolean;
    verified_type?: string;
  };
  in_reply_to_status_id_str?: string;
  in_reply_to_screen_name?: string;
  parent?: RawTweet;
  note_tweet?: { note_tweet_results?: { result?: { text?: string } } };
}

const TWEET_URL_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)\/status(?:es)?\/(\d+)/i;

export function parseTweetId(input: string): string {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = trimmed.match(TWEET_URL_RE);
  if (!match) throw new Error(`Not a tweet URL: ${input}`);
  return match[2];
}

// The endpoint requires a token derived from the tweet id (same formula X's embed script uses).
function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

// X's embed endpoint is the primary source. It truncates long-form (Premium) tweets to
// ~280 chars without returning the rest, so for those — or if X's endpoint fails —
// we use FxTwitter (api.fxtwitter.com), a free public proxy that returns the full text.
export async function fetchTweet(idOrUrl: string): Promise<Tweet> {
  const id = parseTweetId(idOrUrl);

  let fromX: Tweet | undefined;
  let xError: unknown;
  try {
    const raw = await fetchSyndication(id);
    fromX = normalize(raw);
    if (!raw.note_tweet || raw.note_tweet.note_tweet_results?.result?.text) return fromX;
  } catch (err) {
    xError = err;
  }

  try {
    const fx = await fetchFxTwitter(id);
    return fromX ? { ...fromX, text: fx.text } : fx;
  } catch (fxError) {
    if (fromX) {
      // Never post a silently truncated tweet.
      throw new Error(`Tweet ${id} is long-form and its full text couldn't be fetched: ${(fxError as Error).message}`);
    }
    throw xError;
  }
}

async function fetchSyndication(id: string): Promise<RawTweet> {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=en`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (res.status === 404) throw new Error(`Tweet ${id} not found (deleted, private, or age-restricted)`);
  if (!res.ok) throw new Error(`Tweet fetch failed: HTTP ${res.status}`);

  const raw = (await res.json()) as RawTweet & { __typename?: string };
  if (raw.__typename === "TweetTombstone" || !raw.user) {
    throw new Error(`Tweet ${id} is unavailable`);
  }
  return raw;
}

interface FxTweet {
  id: string;
  url: string;
  created_timestamp: number;
  raw_text: {
    text: string;
    display_text_range?: [number, number];
    facets?: { type: string; original?: string; display?: string }[];
  };
  author: {
    name: string;
    screen_name: string;
    avatar_url: string;
    verification?: { verified: boolean; type?: string };
  };
  replying_to?: string | null;
  replying_to_status?: string | null;
}

async function fetchFxTwitter(id: string): Promise<Tweet> {
  const res = await fetch(`https://api.fxtwitter.com/i/status/${id}`, {
    headers: { "User-Agent": "tweet-to-instagram-pipeline" },
  });
  const body = (await res.json().catch(() => ({}))) as { code?: number; message?: string; tweet?: FxTweet };
  if (!res.ok || !body.tweet) throw new Error(`FxTwitter: ${body.message ?? `HTTP ${res.status}`}`);

  const t = body.tweet;
  const chars = Array.from(t.raw_text.text);
  const [start, end] = t.raw_text.display_text_range ?? [0, chars.length];
  let text = chars.slice(start, end).join("");
  for (const f of t.raw_text.facets ?? []) {
    if (f.type === "url" && f.original && f.display) text = text.replace(f.original, f.display);
  }
  // Media attachments leave a trailing t.co link in the text.
  text = text.replace(/\s*https:\/\/t\.co\/\w+$/, "");

  const v = t.author.verification;
  return {
    id: t.id,
    url: `https://x.com/${t.author.screen_name}/status/${t.id}`,
    text: decodeEntities(text).trim(),
    createdAt: new Date(t.created_timestamp * 1000),
    author: {
      name: t.author.name,
      handle: t.author.screen_name,
      avatarUrl: t.author.avatar_url.replace(/_(normal|bigger|200x200)\./, "_400x400."),
      verified: !v?.verified ? "none" : v.type === "business" ? "business" : "blue",
    },
    parentId: t.replying_to_status ?? undefined,
    parentAuthorHandle: t.replying_to ?? undefined,
  };
}

function normalize(raw: RawTweet): Tweet {
  const u = raw.user;
  return {
    id: raw.id_str,
    url: `https://x.com/${u.screen_name}/status/${raw.id_str}`,
    text: cleanText(raw),
    createdAt: new Date(raw.created_at),
    author: {
      name: u.name,
      handle: u.screen_name,
      // "_normal" is 48px; swap for the 400px version so the avatar is crisp at 1080 wide.
      avatarUrl: u.profile_image_url_https.replace("_normal.", "_400x400."),
      verified: u.verified_type === "Business" ? "business" : u.is_blue_verified || u.verified ? "blue" : "none",
    },
    parentId: raw.in_reply_to_status_id_str ?? raw.parent?.id_str,
    parentAuthorHandle: raw.in_reply_to_screen_name ?? raw.parent?.user?.screen_name,
  };
}

function cleanText(raw: RawTweet): string {
  const longText = raw.note_tweet?.note_tweet_results?.result?.text;
  if (longText) return expandUrls(decodeEntities(longText), raw.entities?.urls ?? []);

  // display_text_range strips leading "@reply @mentions" and trailing media t.co links.
  // Indices are in code points, not UTF-16 units, so slice via Array.from.
  const chars = Array.from(raw.text);
  const [start, end] = raw.display_text_range ?? [0, chars.length];
  let text = chars.slice(start, end).join("");

  text = expandUrls(text, raw.entities?.urls ?? []);
  for (const m of raw.entities?.media ?? []) text = text.replace(m.url, "");
  return decodeEntities(text).trim();
}

function expandUrls(text: string, urls: RawEntityUrl[]): string {
  for (const u of urls) text = text.replace(u.url, u.display_url);
  return text;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
