import { config } from "../config.ts";
import type { Keyboard, PhotoSize } from "./types.ts";

const API = `https://api.telegram.org/bot${config.telegramToken}`;

class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Retries Telegram 5xx/429 responses, timeouts and network failures. */
async function withRetry<T>(
  fn: () => Promise<T>,
  delaysMs = [1_000, 3_000, 6_000],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const transient =
        e instanceof TypeError ||
        (e instanceof DOMException && e.name === "TimeoutError") ||
        (e instanceof TelegramError && (e.status >= 500 || e.status === 429));
      if (!transient || attempt >= delaysMs.length) throw e;
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}

// deno-lint-ignore no-explicit-any
async function call<T = any>(
  method: string,
  body: Record<string, unknown> | FormData,
  signal?: AbortSignal,
): Promise<T> {
  const init =
    body instanceof FormData
      ? { method: "POST", body, signal }
      : {
          signal,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const res = await fetch(`${API}/${method}`, init);
  const json = await res
    .json()
    .catch(() => ({ ok: false, description: res.statusText }));
  if (!json.ok)
    throw new TelegramError(`${method}: ${json.description}`, res.status);
  return json.result;
}

const markup = (keyboard?: Keyboard) =>
  keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};

const isNotModified = (e: unknown) =>
  e instanceof Error && e.message.includes("message is not modified");

export const telegram = {
  call,

  send: (chatId: number, html: string, keyboard?: Keyboard) =>
    call("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...markup(keyboard),
    }),

  /** Sends with a persistent reply keyboard under the input field. Each inner array is one row of button labels. */
  sendWithReplyKeyboard: (chatId: number, html: string, rows: string[][]) =>
    call("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      reply_markup: {
        keyboard: rows.map((r) => r.map((text) => ({ text }))),
        resize_keyboard: true,
        is_persistent: true,
      },
    }),

  edit: (
    chatId: number,
    messageId: number,
    html: string,
    keyboard: Keyboard = [],
  ) =>
    call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...markup(keyboard),
    }).catch((e) => {
      if (!isNotModified(e)) throw e;
    }),

  answerCallback: (id: string, text?: string) =>
    call("answerCallbackQuery", {
      callback_query_id: id,
      ...(text && { text }),
    }),

  deleteMessage: (chatId: number, messageId: number) =>
    call("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(
      () => {},
    ),

  typing: (chatId: number) =>
    call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(
      () => {},
    ),

  leave: (chatId: number) =>
    call("leaveChat", { chat_id: chatId }).catch(() => {}),

  sendDocument: (
    chatId: number,
    filename: string,
    content: string,
    mime: string,
  ) => {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("document", new Blob([content], { type: mime }), filename);
    return call("sendDocument", form);
  },

  download: (fileId: string): Promise<Uint8Array> =>
    withRetry(async () => {
      // Telegram's file service can hang for minutes when it's failing; give up early and retry instead.
      const signal = AbortSignal.timeout(20_000);
      const file = await call<{ file_path: string }>(
        "getFile",
        { file_id: fileId },
        signal,
      );
      const res = await fetch(
        `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`,
        { signal },
      );
      if (!res.ok)
        throw new TelegramError(`download failed: ${res.status}`, res.status);
      return new Uint8Array(await res.arrayBuffer());
    }),
};

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Telegram sends each photo in several sizes, smallest first; picks the largest within `maxPx` on its long side. */
export function fittedPhoto(
  sizes: PhotoSize[] | undefined,
  maxPx = config.maxPhotoPx,
): string | undefined {
  if (!sizes?.length) return undefined;
  const fits = sizes.filter((s) => Math.max(s.width, s.height) <= maxPx);
  return (fits.at(-1) ?? sizes[0]).file_id;
}
