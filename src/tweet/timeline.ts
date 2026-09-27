// Watches an account for new posts via FxTwitter's public timeline endpoint (free, no
// key; X's own API charges for reads), and groups them into things worth building:
// standalone posts and self-reply threads.

export interface TimelineTweet {
  id: string;
  text: string;
  createdAt: Date;
  /** Set when this is a reply. */
  parentId?: string;
  parentHandle?: string;
  isRepost: boolean;
}

interface FxTimelineStatus {
  id: string;
  text: string;
  created_timestamp: number;
  replying_to?: { screen_name?: string; status?: string } | null;
  reposted_by?: unknown;
}

export async function fetchTimeline(handle: string): Promise<TimelineTweet[]> {
  const res = await fetch(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(handle)}/statuses`, {
    headers: { "User-Agent": "statmanposterbot (tweet-to-instagram pipeline)" },
  });
  const body = (await res.json().catch(() => ({}))) as { results?: FxTimelineStatus[]; message?: string };
  if (!res.ok || !Array.isArray(body.results)) {
    throw new Error(`FxTwitter timeline: ${body.message ?? `HTTP ${res.status}`}`);
  }
  return body.results.map((t) => ({
    id: t.id,
    text: t.text,
    createdAt: new Date(t.created_timestamp * 1000),
    parentId: t.replying_to?.status ?? undefined,
    parentHandle: t.replying_to?.screen_name ?? undefined,
    isRepost: Boolean(t.reposted_by),
  }));
}

/**
 * The timeline sometimes omits a thread's middle tweets, which would split the thread in
 * two. Fetches each missing parent of a new self-reply (and its parent, and so on) and
 * returns the timeline with them added.
 */
export async function fillMissingParents(
  tweets: TimelineTweet[],
  handle: string,
  sinceId: string,
  fetchOne: (id: string) => Promise<TimelineTweet>,
  maxFetches = 10,
): Promise<TimelineTweet[]> {
  const own = handle.toLowerCase();
  const known = new Map(tweets.map((t) => [t.id, t]));
  const queue = [...tweets];
  let fetches = 0;
  while (queue.length && fetches < maxFetches) {
    const t = queue.shift()!;
    const missing =
      t.parentId &&
      t.parentHandle?.toLowerCase() === own &&
      newer(t.id, sinceId) &&
      newer(t.parentId, sinceId) &&
      !known.has(t.parentId);
    if (!missing) continue;
    fetches++;
    const parentTweet = await fetchOne(t.parentId!).catch(() => null);
    if (!parentTweet) continue;
    known.set(parentTweet.id, parentTweet);
    queue.push(parentTweet);
  }
  return [...known.values()];
}

/** A new standalone post or thread to offer for building. */
export interface Candidate {
  /** First tweet (a thread's root). */
  rootId: string;
  /** Latest tweet in the thread: building from it rebuilds the whole thread. */
  lastId: string;
  /** Tweets in the thread, including ones the timeline didn't list. */
  size: number;
  /** Text of the earliest tweet the timeline returned, for the preview. */
  text: string;
}

export interface Grouped {
  candidates: Candidate[];
  /** Highest tweet id handled; store it and pass it back as `sinceId` next time. */
  advanceTo: string;
}

const byId = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const newer = (id: string, than: string) => BigInt(id) > BigInt(than);

/**
 * Groups tweets newer than `sinceId` into candidates. Tweets younger than `settleMs`
 * (and anything after them) wait for the next poll, so a thread being posted isn't
 * offered half-finished.
 */
export function groupNewTweets(
  tweets: TimelineTweet[],
  handle: string,
  sinceId: string,
  settleMs: number,
  now = Date.now(),
): Grouped {
  const own = handle.toLowerCase();
  const fresh = tweets.filter((t) => !t.isRepost && newer(t.id, sinceId)).sort((a, b) => byId(a.id, b.id));

  // Tweet ids are time-ordered: stop at the first tweet that hasn't settled yet.
  const firstUnsettled = fresh.findIndex((t) => now - t.createdAt.getTime() < settleMs);
  const ready = firstUnsettled === -1 ? fresh : fresh.slice(0, firstUnsettled);
  if (ready.length === 0) return { candidates: [], advanceTo: sinceId };

  // Union self-replies with their parents. A parent the timeline didn't list (it
  // sometimes skips a thread's middle tweets) still links the thread together.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const p = parent.get(id);
    if (!p || p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(byId(ra, rb) > 0 ? ra : rb, byId(ra, rb) > 0 ? rb : ra); // older id is root
  };

  const included: TimelineTweet[] = [];
  for (const t of ready) {
    const selfReply = t.parentId && t.parentHandle?.toLowerCase() === own;
    if (t.parentId && !selfReply) continue; // reply to someone else
    if (selfReply && !newer(t.parentId!, sinceId)) continue; // continues an already-handled post
    included.push(t);
    if (selfReply) union(t.id, t.parentId!);
  }

  const groups = new Map<string, Set<string>>();
  for (const t of included) {
    const root = find(t.id);
    const members = groups.get(root) ?? new Set([root]);
    members.add(t.id);
    if (t.parentId && t.parentHandle?.toLowerCase() === own) members.add(t.parentId);
    groups.set(root, members);
  }

  const textOf = new Map(included.map((t) => [t.id, t.text]));
  const candidates = [...groups.entries()]
    .map(([rootId, members]) => {
      const ids = [...members].sort(byId);
      const listed = ids.filter((id) => textOf.has(id));
      return { rootId, lastId: listed[listed.length - 1], size: ids.length, text: textOf.get(listed[0]) ?? "" };
    })
    .sort((a, b) => byId(a.rootId, b.rootId));

  return { candidates, advanceTo: ready[ready.length - 1].id };
}
