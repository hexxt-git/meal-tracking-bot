// Day, week, history and single-meal panels.
import { parseMealsCsv, toCsv } from "../../domain/csv.ts";
import { sumTotals } from "../../domain/meal.ts";
import { dayStart, groupByLocalDay, localDayLabel, localTime } from "../../domain/time.ts";
import { esc, telegram } from "../../telegram/api.ts";
import type { FileRef } from "../../telegram/types.ts";
import type { Ctx } from "../context.ts";
import { clock, dayLabel, mealBody, mealButtonLabel, progressTable } from "../format.ts";
import { bar, btn, LOG_HINT, num, Reply, table, View } from "../ui.ts";

const HISTORY_PAGE = 8;

/** Where "Back" from a meal returns to: `d<daysAgo>` or `h<page>`. */
export type Origin = string;

export async function dayView(ctx: Ctx, daysAgo: number): Promise<View> {
  const off = ctx.user.utcOffsetMinutes;
  const from = dayStart(off, daysAgo);
  const meals = await ctx.db.meals.between(from, dayStart(off, daysAgo - 1));
  const title = daysAgo === 0 ? "Today" : daysAgo === 1 ? "Yesterday" : localDayLabel(from, off);

  const body = meals.length ? progressTable(sumTotals(meals), ctx.user) : `No meals logged.${daysAgo === 0 ? `\n${LOG_HINT}` : ""}`;
  const goalsHint = meals.length && ctx.user.targetKcal == null ? "\nNo goals set yet. Set them in Menu → Goals." : "";

  return {
    text: `<b>${title}</b>  ·  ${localDayLabel(from, off)}\n\n${body}${goalsHint}`,
    keyboard: [
      ...meals.map((m) => [btn(mealButtonLabel(m, ctx.user), `meal:${m.id}:d${daysAgo}`)]),
      [btn("‹ Previous day", `day:${daysAgo + 1}`), ...(daysAgo > 0 ? [btn("Next day ›", `day:${daysAgo - 1}`)] : [])],
      [btn("Week", "week"), btn("Menu", "menu")],
    ],
  };
}

export async function weekView(ctx: Ctx): Promise<View> {
  const off = ctx.user.utcOffsetMinutes;
  const days = groupByLocalDay(await ctx.db.meals.since(dayStart(off, 6)), off);
  const goal = ctx.user.targetKcal;
  const lines: string[][] = [];
  for (let i = 6; i >= 0; i--) {
    const start = dayStart(off, i);
    const meals = days.get(localTime(start, off).slice(0, 10)) ?? [];
    const kcal = sumTotals(meals).kcal;
    lines.push([localDayLabel(start, off).slice(0, 6), meals.length ? num(kcal) : "–", meals.length ? bar(kcal, goal ?? 2500) : ""]);
  }
  const logged = [...days.values()];
  const avg = logged.length ? Math.round(logged.reduce((s, m) => s + sumTotals(m).kcal, 0) / logged.length) : 0;
  const summary = logged.length
    ? `Average ${num(avg)} kcal over ${logged.length} logged day${logged.length > 1 ? "s" : ""}${goal ? `  ·  goal ${num(goal)}` : ""}`
    : "Nothing logged in the last 7 days.";
  return {
    text: `<b>Last 7 days</b>\n\n${table(lines, ["l", "r", "l"])}${summary}`,
    keyboard: [[btn("Today", "day:0"), btn("Menu", "menu")]],
  };
}

export async function historyView(ctx: Ctx, page: number): Promise<View> {
  const { meals, hasMore } = await ctx.db.meals.page(page, HISTORY_PAGE);
  const nav = [
    ...(page > 0 ? [btn("‹ Newer", `hist:${page - 1}`)] : []),
    ...(hasMore ? [btn("Older ›", `hist:${page + 1}`)] : []),
  ];
  return {
    text: `<b>History</b>${page ? `  ·  page ${page + 1}` : ""}\n\n${meals.length ? "Tap a meal to see details." : "No meals logged yet."}`,
    keyboard: [
      ...meals.map((m) => [btn(mealButtonLabel(m, ctx.user, true), `meal:${m.id}:h${page}`)]),
      ...(nav.length ? [nav] : []),
      [btn("Menu", "menu")],
    ],
  };
}

const backButton = (origin: Origin) => btn("‹ Back", origin.startsWith("h") ? `hist:${origin.slice(1)}` : `day:${origin.slice(1)}`);

export async function mealView(ctx: Ctx, mealId: string, origin: Origin): Promise<View> {
  const m = await ctx.db.meals.byId(mealId);
  if (!m) return { text: "This meal no longer exists.", keyboard: [[backButton(origin)]] };
  return {
    text: `<b>${esc(m.description)}</b>\n${table([
      ["Eaten", `${dayLabel(m.eatenAt, ctx.user)}  ${clock(m.eatenAt, ctx.user)}`],
      ["Logged", `${dayLabel(m.loggedAt, ctx.user)}  ${clock(m.loggedAt, ctx.user)}`],
    ], ["l", "l"])}${mealBody(m)}`,
    keyboard: [[btn("Delete", `del:${m.id}:${origin}`), backButton(origin)]],
  };
}

export async function deleteMeal(ctx: Ctx, mealId: string, origin: Origin): Promise<Reply> {
  const result = await ctx.db.meals.delete(mealId);
  if (!result) return { toast: "Already deleted", view: await mealView(ctx, mealId, origin) };
  return {
    view: {
      text: `Deleted <b>${esc(result.meal.description)}</b>.`,
      keyboard: [[btn("Undo", `undo:${result.batchId}:${origin}`), backButton(origin)]],
    },
  };
}

/** Undo from a panel returns to the meal; undo from an assistant reply rewrites that reply. */
export async function undo(ctx: Ctx, batchId: string, origin: Origin | undefined): Promise<Reply> {
  const results = await ctx.db.meals.undo(batchId);
  if (!results.length) return { toast: "Already undone" };
  if (origin) return { view: await mealView(ctx, results[0].mealId, origin) };
  // Results run newest first, so the last entry per meal is the state it was reverted to.
  const outcome = new Map(results.map((r) => [r.mealId, r]));
  const lines = outcome.size > 10
    ? [`Reverted ${num(outcome.size)} meals.`]
    : [...outcome.values()].map((r) =>
      r.restored ? `Restored <b>${esc(r.description)}</b> to its previous version.` : `Removed <b>${esc(r.description)}</b>.`
    );
  return { view: { text: lines.join("\n"), keyboard: [[btn("Today", "today")]] } };
}

export async function exportCsv(ctx: Ctx): Promise<Reply> {
  const meals = await ctx.db.meals.all();
  if (!meals.length) return { toast: "No meals logged yet" };
  const csv = toCsv(meals.map((m) => [
    m.eatenAt.toISOString(), dayLabel(m.eatenAt, ctx.user), clock(m.eatenAt, ctx.user), m.loggedAt.toISOString(), m.description,
    m.kcal, m.proteinG, m.carbsG, m.fatG, JSON.stringify(m.items), m.userNote,
  ]));
  await telegram.sendDocument(ctx.user.chatId, "meals.csv", csv, "text/csv");
  return {};
}

const MAX_IMPORT_BYTES = 2_000_000;

export const importHelpView = (): View => ({
  text: `<b>Import CSV</b>

Send a CSV file in the same format as Export CSV, as a file attachment. Meals already in your log (same time and title) are skipped, and the whole import can be undone.`,
  keyboard: [[btn("‹ Menu", "menu")]],
});

export const isCsvFile = (doc: FileRef) =>
  doc.mime_type === "text/csv" || doc.mime_type === "text/comma-separated-values" || /\.csv$/i.test(doc.file_name ?? "");

export async function importCsv(ctx: Ctx, doc: FileRef) {
  if ((doc.file_size ?? 0) > MAX_IMPORT_BYTES) return ctx.send("That file is too large to import (2 MB max).");
  const parsed = parseMealsCsv(new TextDecoder().decode(await telegram.download(doc.file_id)));
  if (!parsed.ok) return ctx.send(`Couldn't import that file. ${esc(parsed.error)} Use a file made with Export CSV.`);
  if (!parsed.meals.length) return ctx.send("No valid meals found in that file.");
  const { imported, duplicates, batchId } = await ctx.db.meals.importMany(parsed.meals);
  const notes = [
    ...(duplicates ? [`${num(duplicates)} already in your log, skipped.`] : []),
    ...(parsed.invalidRows ? [`${num(parsed.invalidRows)} rows couldn't be read, skipped.`] : []),
  ];
  return ctx.send({
    text: `Imported <b>${num(imported)}</b> ${imported === 1 ? "meal" : "meals"}.${notes.length ? `\n${notes.join("\n")}` : ""}`,
    keyboard: [[...(imported ? [btn("Undo", `undo:${batchId}`)] : []), btn("History", "hist:0")]],
  });
}
