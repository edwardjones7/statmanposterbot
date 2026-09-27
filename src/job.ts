// A job is one tweet (or thread) moving through: rendering → ready → posting → posted
// (or rejected). A failed publish returns it to ready, so it can be retried.
// State lives in the Worker's D1 database; the render job reports back to the Worker over HTTP.

import type { InlineButton } from "./telegram.ts";

export type JobStatus = "rendering" | "ready" | "failed" | "posting" | "rejected" | "posted";
export type JobMode = "auto" | "single";

export interface Job {
  id: string;
  tweetUrl: string;
  mode: JobMode;
  chatId: number;
  status: JobStatus;
  createdAt: string;
  /** The tweet text (threads joined with blank lines), used to write and rewrite captions. */
  sourceText?: string;
  caption?: string;
  slideCount?: number;
  /** The Telegram message holding the caption + buttons, so buttons can be cleared later. */
  previewMessageId?: number;
  error?: string;
  /** Set once published: the Instagram post URL, or "manual" if posted by hand after a fallback. */
  instagramUrl?: string;
}

/** Sent by the render job to `POST /jobs/:id/ready` once the slides are uploaded. */
export interface JobReady {
  sourceText: string;
  slideCount: number;
  /** Warning to show under the preview, e.g. a thread was cut to 10 slides. */
  note?: string;
}

export const ACTIONS = { approve: "a", edit: "e", regenerate: "g", reject: "r", postedManually: "m" } as const;

export function previewButtons(jobId: string): InlineButton[][] {
  return [
    [
      { text: "✅ Post", callback_data: `${ACTIONS.approve}:${jobId}` },
      { text: "✏️ Edit caption", callback_data: `${ACTIONS.edit}:${jobId}` },
    ],
    [
      { text: "🔄 New caption", callback_data: `${ACTIONS.regenerate}:${jobId}` },
      { text: "❌ Reject", callback_data: `${ACTIONS.reject}:${jobId}` },
    ],
  ];
}

export function previewText(caption: string, slideCount: number, tweetUrl: string, note?: string): string {
  const slides = slideCount === 1 ? "1 image" : `${slideCount}-slide carousel`;
  return `📝 Caption\n\n${caption}\n\n———\n${slides} · ${tweetUrl}${note ? `\n${note}` : ""}`;
}

/** After a failed publish: retry, or confirm it was posted by hand from the fallback files. */
export function fallbackButtons(jobId: string): InlineButton[][] {
  return [
    [
      { text: "🔁 Try again", callback_data: `${ACTIONS.approve}:${jobId}` },
      { text: "✔️ I posted it manually", callback_data: `${ACTIONS.postedManually}:${jobId}` },
    ],
    [{ text: "❌ Reject", callback_data: `${ACTIONS.reject}:${jobId}` }],
  ];
}
