// Weight log: latest weigh-in, trends and a paged list of entries.
import { dayStart } from "../../domain/time.ts";
import {
  fmtWeight,
  fmtWeightDelta,
  unitFor,
  weightChange,
} from "../../domain/weight.ts";
import type { Ctx } from "../context.ts";
import { clock, dayLabel } from "../format.ts";
import { btn, Reply, table, View } from "../ui.ts";

const PAGE = 8;
const TREND_DAYS = [7, 30];

export async function weightView(ctx: Ctx, page: number): Promise<View> {
  const off = ctx.user.utcOffsetMinutes;
  const unit = unitFor(ctx.user.units);
  const { weights, hasMore } = await ctx.db.weights.page(page, PAGE);
  const nav = [
    ...(page > 0 ? [btn("‹ Newer", `wt:${page - 1}`)] : []),
    ...(hasMore ? [btn("Older ›", `wt:${page + 1}`)] : []),
  ];
  const keyboard = [
    ...weights.map((w) => [
      btn(
        `${dayLabel(w.weighedAt, ctx.user)}  ${clock(w.weighedAt, ctx.user)}  ·  ${fmtWeight(w.weightKg, unit, w.unit)}`,
        `wte:${w.id}:${page}`,
      ),
    ]),
    ...(nav.length ? [nav] : []),
    [btn("Menu", "menu")],
  ];
  if (!weights.length && page === 0)
    return {
      text: '<b>Weight</b>\n\nNo weigh-ins yet. Send your weight, like "70kg" or "154 lb", or a photo of your scale.',
      keyboard,
    };

  // Reaches past the longest trend so there is a reference entry even with gaps in weighing.
  const history = await ctx.db.weights.since(dayStart(off, 90));
  const [latest] = history.length ? history : weights;
  const rows = [
    [
      "Latest",
      `${fmtWeight(latest.weightKg, unit, latest.unit)}  (${dayLabel(latest.weighedAt, ctx.user)})`,
    ],
    ...TREND_DAYS.map((days) => {
      const delta = weightChange(history, days, off);
      return [
        `${days} days`,
        delta == null ? "–" : fmtWeightDelta(delta, unit),
      ];
    }),
  ];
  return {
    text: `<b>Weight</b>${page ? `  ·  page ${page + 1}` : ""}\n\n${table(rows, ["l", "l"])}Tap an entry to delete it.`,
    keyboard,
  };
}

/** `wte:<id>:<page>` */
export async function weightEntryView(
  ctx: Ctx,
  id: string,
  page: number,
): Promise<View> {
  const w = await ctx.db.weights.byId(id);
  const back = btn("‹ Back", `wt:${page}`);
  if (!w)
    return { text: "This weigh-in no longer exists.", keyboard: [[back]] };
  const unit = unitFor(ctx.user.units);
  return {
    text: `<b>${fmtWeight(w.weightKg, unit, w.unit)}</b>${w.unit !== unit ? `  (${fmtWeight(w.weightKg, w.unit, w.unit)})` : ""}\n${dayLabel(w.weighedAt, ctx.user)}  ${clock(w.weighedAt, ctx.user)}`,
    keyboard: [[btn("Delete", `wtd:${w.id}:${page}`), back]],
  };
}

/** `wtd:<id>:<page>` */
export async function deleteWeight(
  ctx: Ctx,
  id: string,
  page: number,
): Promise<Reply> {
  const gone = await ctx.db.weights.delete(id);
  if (gone) {
    const [latest] = await ctx.db.weights.recent(1);
    if (latest)
      ctx.user = await ctx.db.users.update({ weightKg: latest.weightKg });
  }
  return {
    view: await weightView(ctx, page),
    toast: gone ? "Weigh-in deleted" : "Already deleted",
  };
}
