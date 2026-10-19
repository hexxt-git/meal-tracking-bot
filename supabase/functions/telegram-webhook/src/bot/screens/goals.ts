import type { User } from "../../db/index.ts";
import { clampGoal, GOAL_FIELDS, GoalField, isGoalField } from "../../domain/goals.ts";
import { computeTargets } from "../../domain/nutrition.ts";
import { completeProfile } from "../../domain/onboarding.ts";
import type { Ctx } from "../context.ts";
import { btn, num, Reply, table, View } from "../ui.ts";

const COLUMN: Record<GoalField, "targetKcal" | "targetProteinG" | "targetCarbsG" | "targetFatG"> = {
  kcal: "targetKcal",
  protein: "targetProteinG",
  carbs: "targetCarbsG",
  fat: "targetFatG",
};

export function goalsTable(u: User): string {
  return table(
    (Object.keys(GOAL_FIELDS) as GoalField[]).map((f) => {
      const v = u[COLUMN[f]];
      return [GOAL_FIELDS[f].label, v == null ? "not set" : `${num(v)} ${GOAL_FIELDS[f].unit}`];
    }),
    ["l", "r"],
  );
}

export function goalsView(ctx: Ctx): View {
  const canRecalc = completeProfile(ctx.user) != null;
  return {
    text: `<b>Daily goals</b>\n\n${goalsTable(ctx.user)}Tap one to adjust it.`,
    keyboard: [
      (Object.keys(GOAL_FIELDS) as GoalField[]).map((f) => btn(GOAL_FIELDS[f].label, `ge:${f}`)),
      ...(canRecalc ? [[btn("Recalculate from profile", "grc")]] : [[btn("Set up profile", "prof:edit")]]),
      [btn("‹ Menu", "menu")],
    ],
  };
}

function editorView(field: GoalField, value: number): View {
  const f = GOAL_FIELDS[field];
  return {
    text: `<b>${f.label}</b> per day\n\n<pre>   ${num(value)} ${f.unit}   </pre>`,
    keyboard: [
      f.deltas.map((d) => btn(d > 0 ? `+${d}` : `−${-d}`, `ge:${field}:${clampGoal(field, value + d)}`)),
      [btn("Cancel", "goals"), btn("Save", `gs:${field}:${value}`)],
    ],
  };
}

/** `ge:<field>[:<value>]` opens or steps the editor; `gs:<field>:<value>` saves. */
export function editGoal(ctx: Ctx, [field, raw]: string[]): Reply {
  if (!isGoalField(field)) return {};
  const value = clampGoal(field, raw === undefined ? ctx.user[COLUMN[field]] ?? GOAL_FIELDS[field].fallback : Number(raw));
  return { view: editorView(field, value) };
}

export async function saveGoal(ctx: Ctx, [field, raw]: string[]): Promise<Reply> {
  if (!isGoalField(field)) return {};
  ctx.user = await ctx.db.users.update({ [COLUMN[field]]: clampGoal(field, Number(raw)) });
  return { view: goalsView(ctx), toast: "Saved" };
}

export async function recalcGoals(ctx: Ctx): Promise<Reply> {
  const profile = completeProfile(ctx.user);
  if (!profile) return { toast: "Finish your profile first" };
  const t = computeTargets(profile);
  ctx.user = await ctx.db.users.update({ targetKcal: t.kcal, targetProteinG: t.protein_g, targetCarbsG: t.carbs_g, targetFatG: t.fat_g });
  return { view: goalsView(ctx), toast: "Recalculated" };
}
