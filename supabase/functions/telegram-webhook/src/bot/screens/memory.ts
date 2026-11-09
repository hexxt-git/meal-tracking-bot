// Memory: the notes the assistant keeps about the user, with a way to read and delete each one.
import { esc } from "../../telegram/api.ts";
import type { Ctx } from "../context.ts";
import { btn, Reply, rows, View } from "../ui.ts";

const PAGE = 10;
const PREVIEW = 120;

const preview = (s: string) =>
  s.length > PREVIEW ? `${s.slice(0, PREVIEW - 1)}…` : s;

/** `mem:<page>` */
export async function memoryView(ctx: Ctx, page = 0): Promise<View> {
  const notes = await ctx.db.notes.list();
  const back = btn("‹ Settings", "set");
  if (!notes.length)
    return {
      text: '<b>Memory</b>\n\nNothing saved yet. Tell the assistant something worth keeping, like your own product\'s nutrition ("my gainer has 40 g protein per 100 g"), and it will remember it for every later message.',
      keyboard: [[back]],
    };
  const last = Math.ceil(notes.length / PAGE) - 1;
  const p = Math.min(Math.max(0, page), last);
  const shown = notes.slice(p * PAGE, (p + 1) * PAGE);
  const lines = shown.map(
    (n, i) => `${p * PAGE + i + 1}. ${esc(preview(n.text))}`,
  );
  return {
    text: `<b>Memory</b>\n\nWhat the assistant remembers about you. Ask it to change or forget something, or tap a number to delete it.\n\n${lines.join("\n")}`,
    keyboard: [
      ...rows(
        shown.map((n, i) => btn(String(p * PAGE + i + 1), `memv:${n.id}:${p}`)),
        5,
      ),
      [
        ...(p > 0 ? [btn("‹ Prev", `mem:${p - 1}`)] : []),
        ...(p < last ? [btn("Next ›", `mem:${p + 1}`)] : []),
      ],
      [back],
    ].filter((r) => r.length),
  };
}

/** `memv:<id>:<page>` */
export async function noteView(
  ctx: Ctx,
  id: string,
  page: number,
): Promise<View> {
  const n = await ctx.db.notes.byId(id).catch(() => null);
  const back = btn("‹ Back", `mem:${page}`);
  if (!n) return { text: "This note no longer exists.", keyboard: [[back]] };
  return {
    text: `<b>Note</b>\n\n${esc(n.text)}`,
    keyboard: [[btn("Delete", `memd:${n.id}:${page}`), back]],
  };
}

/** `memd:<id>:<page>` */
export async function deleteNote(
  ctx: Ctx,
  id: string,
  page: number,
): Promise<Reply> {
  const gone = await ctx.db.notes.delete(id).catch(() => null);
  return {
    view: await memoryView(ctx, page),
    toast: gone ? "Forgotten" : "Already gone",
  };
}
