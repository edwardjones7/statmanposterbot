// Rebuilds a thread by walking parent links backwards from its last tweet.
// X's free endpoints only link a reply to its parent, never to its children, so the
// user has to share the thread's LAST tweet.

import { fetchTweet, type Tweet } from "./fetch.ts";

/** Instagram carousels hold at most 10 items. */
export const MAX_SLIDES = 10;
/** Safety stop so a runaway reply chain can't loop forever. */
const MAX_WALK = 30;

export interface Thread {
  tweets: Tweet[]; // oldest first, at most MAX_SLIDES
  /** Tweets dropped because the thread is longer than a carousel allows. */
  droppedCount: number;
}

export async function fetchThread(lastTweetUrl: string): Promise<Thread> {
  const last = await fetchTweet(lastTweetUrl);
  const handle = last.author.handle.toLowerCase();
  const chain: Tweet[] = [last];

  // Keep walking while the author is replying to themselves.
  let current = last;
  while (
    current.parentId &&
    current.parentAuthorHandle?.toLowerCase() === handle &&
    chain.length < MAX_WALK
  ) {
    current = await fetchTweet(current.parentId);
    chain.push(current);
  }

  const tweets = chain.reverse();
  return {
    tweets: tweets.slice(0, MAX_SLIDES),
    droppedCount: Math.max(0, tweets.length - MAX_SLIDES),
  };
}
