// A job is one tweet (or thread) moving through: rendering → ready → approved/rejected → posted.
// State lives in the Worker's KV; the render job reports back to the Worker over HTTP.

import type { InlineButton } from "./telegram.ts";

export type JobStatus = "rendering" | "ready" | "failed" | "approved" | "rejected" | "posted";
export type JobMode = "auto" | "single";

export interface Job {
  id: string;
  tweetUrl: string;
  mode: JobMode;
  chatId: number;
  status: JobStatus;
  createdAt: string;
  caption?: string;
  slideCount?: number;
  /** The Telegram message holding the caption + buttons, so buttons can be cleared later. */
  previewMessageId?: number;
  error?: string;
}

/** Sent by the render job to `POST /jobs/:id/ready`. */
export interface JobReady {
  caption: string;
  slideCount: number;
  previewMessageId: number;
}

export const ACTIONS = { approve: "a", edit: "e", reject: "r" } as const;

export function previewButtons(jobId: string): InlineButton[][] {
  return [
    [
      { text: "✅ Post", callback_data: `${ACTIONS.approve}:${jobId}` },
      { text: "✏️ Edit caption", callback_data: `${ACTIONS.edit}:${jobId}` },
    ],
    [{ text: "❌ Reject", callback_data: `${ACTIONS.reject}:${jobId}` }],
  ];
}

export function previewText(caption: string, slideCount: number, tweetUrl: string): string {
  const slides = slideCount === 1 ? "1 image" : `${slideCount}-slide carousel`;
  return `📝 Caption\n\n${caption}\n\n———\n${slides} · ${tweetUrl}`;
}
