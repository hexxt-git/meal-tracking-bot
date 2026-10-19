import { config } from "../config.ts";
import type { Button, Keyboard } from "./types.ts";

const API = `https://api.telegram.org/bot${config.telegramToken}`;

// deno-lint-ignore no-explicit-any
async function call<T = any>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
  const init = body instanceof FormData
    ? { method: "POST", body }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const json = await (await fetch(`${API}/${method}`, init)).json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

const markup = (keyboard?: Keyboard) => (keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {});

export const telegram = {
  call,

  send: (chatId: number, html: string, keyboard?: Keyboard) =>
    call("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...markup(keyboard) }),

  edit: (chatId: number, messageId: number, html: string, keyboard: Keyboard = []) =>
    call("editMessageText", { chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML", ...markup(keyboard) }),

  answerCallback: (id: string, text?: string) => call("answerCallbackQuery", { callback_query_id: id, ...(text && { text }) }),

  deleteMessage: (chatId: number, messageId: number) => call("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {}),

  typing: (chatId: number) => call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}),

  leave: (chatId: number) => call("leaveChat", { chat_id: chatId }).catch(() => {}),

  sendDocument: (chatId: number, filename: string, content: string, mime: string) => {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("document", new Blob([content], { type: mime }), filename);
    return call("sendDocument", form);
  },

  async download(fileId: string): Promise<Uint8Array> {
    const file = await call<{ file_path: string }>("getFile", { file_id: fileId });
    const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
};

export const btn = (text: string, data: string): Button => ({ text, callback_data: data });

export function grid(buttons: Button[], perRow: number): Keyboard {
  const rows: Keyboard = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
