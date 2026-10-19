// Day, week, history and single-meal panels.
import { sumTotals } from "../../domain/meal.ts";
import { dayStart, groupByLocalDay, localDayLabel, localTime } from "../../domain/time.ts";
import { esc, telegram } from "../../telegram/api.ts";
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
  const meal = await ctx.db.meals.byId(mealId);
  const revisionId = meal && await ctx.db.meals.delete(mealId);
  if (!meal || !revisionId) return { toast: "Already deleted", view: await mealView(ctx, mealId, origin) };
  return {
    view: { text: `Deleted <b>${esc(meal.description)}</b>.`, keyboard: [[btn("Undo", `undo:${revisionId}:${origin}`), backButton(origin)]] },
  };
}

/** Undo from a panel returns to the meal; undo from a log reply rewrites that reply. */
export async function undo(ctx: Ctx, revisionId: string, origin: Origin | undefined): Promise<Reply> {
  const result = await ctx.db.meals.undo(revisionId);
  if (!result) return { toast: "Already undone" };
  if (origin) return { view: await mealView(ctx, result.mealId, origin) };
  const text = result.restored ? `Reverted <b>${esc(result.description)}</b> to its previous version.` : `Removed <b>${esc(result.description)}</b>.`;
  return { view: { text, keyboard: [[btn("Today", "day:0")]] } };
}

export async function exportCsv(ctx: Ctx): Promise<Reply> {
  const meals = await ctx.db.meals.all();
  if (!meals.length) return { toast: "No meals logged yet" };
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = "eaten_at_utc,eaten_local_date,eaten_local_time,logged_at_utc,description,kcal,protein_g,carbs_g,fat_g,items,note";
  const csv = meals.map((m) =>
    [
      m.eatenAt.toISOString(), dayLabel(m.eatenAt, ctx.user), clock(m.eatenAt, ctx.user), m.loggedAt.toISOString(), m.description,
      m.kcal, m.proteinG, m.carbsG, m.fatG, JSON.stringify(m.items), m.userNote,
    ].map(cell).join(",")
  );
  await telegram.sendDocument(ctx.user.chatId, "meals.csv", [header, ...csv].join("\n"), "text/csv");
  return {};
}
