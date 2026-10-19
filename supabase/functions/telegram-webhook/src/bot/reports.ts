import { sumTotals } from "../domain/meal.ts";
import { dayStart, groupByLocalDay, localTime } from "../domain/time.ts";
import { btn, esc, grid, telegram } from "../telegram/api.ts";
import type { Ctx } from "./context.ts";
import { fmtProgress, fmtTargets, fmtTotals } from "./views.ts";

export async function today(ctx: Ctx) {
  const off = ctx.user.utcOffsetMinutes;
  const meals = await ctx.db.meals.since(dayStart(off));
  if (!meals.length) return ctx.reply("Nothing logged today yet. Send a photo or describe a meal.");
  const lines = meals.map((m) => `${localTime(m.eatenAt, off).slice(11)} · ${esc(m.description)}: ${m.kcal} kcal`);
  return ctx.reply(`📅 <b>Today</b>\n${lines.join("\n")}\n\n${fmtProgress(sumTotals(meals), ctx.user)}`);
}

export async function week(ctx: Ctx) {
  const off = ctx.user.utcOffsetMinutes;
  const days = groupByLocalDay(await ctx.db.meals.since(dayStart(off, 6)), off);
  if (!days.size) return ctx.reply("Nothing logged in the last 7 days.");
  const goal = ctx.user.targetKcal ? ` (goal ${ctx.user.targetKcal})` : "";
  const lines = [...days].map(([day, meals]) => `${day}: ${fmtTotals(sumTotals(meals))}`);
  const avg = Math.round([...days.values()].reduce((s, meals) => s + sumTotals(meals).kcal, 0) / days.size);
  return ctx.reply(`📊 <b>Last 7 days</b>${goal}\n${lines.join("\n")}\n\nAverage over ${days.size} logged day(s): <b>${avg} kcal</b>`);
}

export async function history(ctx: Ctx) {
  const meals = await ctx.db.meals.latest(10);
  if (!meals.length) return ctx.reply("No meals logged yet.");
  const lines = meals.map((m, i) => `${i + 1}. ${localTime(m.eatenAt, ctx.user.utcOffsetMinutes)} · ${esc(m.description)}: ${m.kcal} kcal`);
  return ctx.reply(`🧾 <b>Recent meals</b>\n${lines.join("\n")}`, grid(meals.map((m, i) => btn(`🗑 ${i + 1}`, `del:${m.id}`)), 5));
}

export async function exportCsv(ctx: Ctx) {
  const meals = await ctx.db.meals.all();
  if (!meals.length) return ctx.reply("No meals logged yet.");
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = "eaten_at_utc,local_time,description,kcal,protein_g,carbs_g,fat_g,items,note";
  const rows = meals.map((m) =>
    [
      m.eatenAt.toISOString(), localTime(m.eatenAt, ctx.user.utcOffsetMinutes), m.description,
      m.kcal, m.proteinG, m.carbsG, m.fatG, JSON.stringify(m.items), m.userNote,
    ].map(cell).join(",")
  );
  return telegram.sendDocument(ctx.user.chatId, "meals.csv", [header, ...rows].join("\n"), "text/csv");
}

export async function goals(ctx: Ctx, args: string) {
  const nums = args.split(/\s+/).filter(Boolean).map((s) => Math.round(Number(s.replace(/[^\d.]/g, ""))));
  if (nums.length === 4 && nums.every((n) => n > 0) && nums[0] >= 800 && nums[0] <= 10000) {
    const [targetKcal, targetProteinG, targetCarbsG, targetFatG] = nums;
    ctx.user = await ctx.db.users.update({ targetKcal, targetProteinG, targetCarbsG, targetFatG });
    return ctx.reply(`✅ Targets updated\n${fmtTargets(ctx.user)}`);
  }
  if (ctx.user.targetKcal == null) {
    return ctx.reply("No targets yet. Run /profile, or set them directly: <code>/goals 2200 160 220 70</code> (kcal P C F).");
  }
  return ctx.reply(`🎯 <b>Daily targets</b>\n${fmtTargets(ctx.user)}\n\nOverride: <code>/goals 2200 160 220 70</code> (kcal P C F) · Recompute: /profile`);
}
