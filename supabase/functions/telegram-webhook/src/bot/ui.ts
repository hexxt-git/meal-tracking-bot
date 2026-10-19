import { esc } from "../telegram/api.ts";
import type { Button, Keyboard } from "../telegram/types.ts";

/** One screen: HTML text plus its inline keyboard. Panels are re-rendered in place by editing the message. */
export type View = { text: string; keyboard: Keyboard };

/** What a button press produces: a view to edit into the pressed message, a new message, and/or a toast. */
export type Reply = { view?: View; send?: View; toast?: string };

export const btn = (text: string, data: string): Button => ({ text, callback_data: data });
export const link = (text: string, url: string): Button => ({ text, url });

export function rows(buttons: Button[], perRow: number): Keyboard {
  const out: Keyboard = [];
  for (let i = 0; i < buttons.length; i += perRow) out.push(buttons.slice(i, i + perRow));
  return out;
}

/** Labels of the persistent keyboard under the input field; incoming text equal to one of these is navigation. */
export const REPLY_KEYS = { today: "Today", history: "History", menu: "Menu" } as const;
export const REPLY_KEYBOARD = [[REPLY_KEYS.today, REPLY_KEYS.history, REPLY_KEYS.menu]];

export const LOG_HINT = "Send a photo, a description or a voice note of a meal to log it.";

export const num = (n: number) => Math.round(n).toLocaleString("en-US");

export function bar(value: number, target: number, width = 10): string {
  const filled = target > 0 ? Math.min(width, Math.round((value / target) * width)) : 0;
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Monospace table with padded columns; `align` is "l" or "r" per column. */
export function table(cells: string[][], align: ("l" | "r")[]): string {
  const widths = align.map((_, c) => Math.max(...cells.map((r) => (r[c] ?? "").length)));
  const lines = cells.map((r) =>
    r.map((cell, c) => (align[c] === "r" ? cell.padStart(widths[c]) : cell.padEnd(widths[c]))).join("  ").trimEnd()
  );
  return `<pre>${esc(lines.join("\n"))}</pre>`;
}

export const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
