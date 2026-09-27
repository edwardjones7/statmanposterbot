// Minimal Telegram Bot API client. Runs in Node (render job) and Workers (bot).

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number };
}

export class Telegram {
  constructor(private readonly token: string) {}

  async call<T = unknown>(method: string, params: Record<string, unknown> | FormData): Promise<T> {
    const isForm = params instanceof FormData;
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: isForm ? undefined : { "Content-Type": "application/json" },
      body: isForm ? params : JSON.stringify(params),
    });
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) throw new Error(`Telegram ${method}: ${body.description ?? res.status}`);
    return body.result as T;
  }

  sendMessage(chatId: number | string, text: string, buttons?: InlineButton[][]): Promise<TgMessage> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }

  /** Uploads images directly (no public URL needed). One image = photo, 2–10 = album. */
  async sendImages(chatId: number | string, images: Uint8Array[]): Promise<void> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    // slice() narrows the buffer type to a plain ArrayBuffer, which Blob accepts in every runtime's typings.
    const blob = (bytes: Uint8Array) => new Blob([bytes.slice()], { type: "image/jpeg" });

    if (images.length === 1) {
      form.set("photo", blob(images[0]), "slide-1.jpg");
      await this.call("sendPhoto", form);
      return;
    }
    const media = images.map((_, i) => ({ type: "photo", media: `attach://slide${i + 1}` }));
    form.set("media", JSON.stringify(media));
    images.forEach((img, i) => form.set(`slide${i + 1}`, blob(img), `slide-${i + 1}.jpg`));
    await this.call("sendMediaGroup", form);
  }

  /** Removes the inline buttons from a message (e.g. once a post is approved). */
  clearButtons(chatId: number | string, messageId: number): Promise<unknown> {
    return this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  answerCallback(callbackQueryId: string, text?: string): Promise<unknown> {
    return this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }
}
