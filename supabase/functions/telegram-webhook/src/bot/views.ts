import type { Meal, User } from "../db/index.ts";
import type { Totals } from "../domain/meal.ts";
import { ACTIVITY } from "../domain/nutrition.ts";
import { paceOptions, Step } from "../domain/onboarding.ts";
import { fmtOffset, localTime, TZ_OFFSETS } from "../domain/time.ts";
import { btn, esc, grid } from "../telegram/api.ts";
import type { Keyboard } from "../telegram/types.ts";

export const KEY_PROMPT = `I estimate meals with Gemini through <b>OpenRouter</b>, using your own API key.

1. Create a key at https://openrouter.ai/keys
2. Paste it here (it starts with <code>sk-or-</code>)

I'll delete your message right away and store the key encrypted.`;

export const HELP = `<b>Log a meal:</b> send a photo (or several), a description, or a voice note. Corrections like "that was 2 eggs, not 3" update your last meals.

/today: today's meals and totals
/week: last 7 days
/history: recent meals (with delete)
/goals: your daily targets
/profile: redo body stats and targets
/timezone: change timezone
/export: download all meals as CSV
/setkey · /deletekey: manage your OpenRouter key
/deleteaccount: delete all your data`;

export const LOG_HINT = "Send a photo or describe a meal to log it.";

export const tzKeyboard = (prefix: string): Keyboard => grid(TZ_OFFSETS.map((o) => btn(fmtOffset(o), `${prefix}:${o}`)), 4);

const SKIP_ROW = [btn("Skip for now", "ob:skip")];

export function stepQuestion(u: User): { text: string; keyboard: Keyboard } | null {
  const imperial = u.units === "imperial";
  const choose = (step: Step, options: [string, string][]) => options.map(([label, value]) => btn(label, `ob:${step}:${value}`));
  switch (u.onboardingStep) {
    case "units":
      return { text: "📏 Which units do you use?", keyboard: [choose("units", [["Metric (kg, cm)", "metric"], ["Imperial (lb, ft)", "imperial"]]), SKIP_ROW] };
    case "sex":
      return { text: "Sex (for the metabolic rate formula)?", keyboard: [choose("sex", [["Male", "male"], ["Female", "female"]]), SKIP_ROW] };
    case "age":
      return { text: "🎂 How old are you?", keyboard: [SKIP_ROW] };
    case "height":
      return { text: `📐 Your height? (e.g. ${imperial ? `5'10"` : "178 cm"})`, keyboard: [SKIP_ROW] };
    case "weight":
      return { text: `⚖️ Your current weight? (e.g. ${imperial ? "170 lb" : "75 kg"})`, keyboard: [SKIP_ROW] };
    case "activity":
      return { text: "🏃 How active are you?", keyboard: [...Object.entries(ACTIVITY).map(([k, v]) => choose("activity", [[v.label, k]])), SKIP_ROW] };
    case "objective":
      return {
        text: "🎯 What's your goal?",
        keyboard: [choose("objective", [["Lose weight", "lose"], ["Maintain", "maintain"], ["Gain weight", "gain"]]), SKIP_ROW],
      };
    case "pace":
      return { text: "⏱ How fast?", keyboard: [paceOptions(u.units, u.objective).map((p) => btn(p.label, `ob:pace:${p.kg}`)), SKIP_ROW] };
    case "timezone":
      return { text: "🕒 Last one: your timezone (decides when your day starts).", keyboard: [...tzKeyboard("ob:timezone"), [btn("Keep UTC", "ob:timezone:0")]] };
    default:
      return null;
  }
}

export const fmtTotals = (t: Totals) => `${t.kcal} kcal · P ${Math.round(t.proteinG)} · C ${Math.round(t.carbsG)} · F ${Math.round(t.fatG)}`;

export const fmtTargets = (u: User) =>
  `${u.targetKcal} kcal · protein ${u.targetProteinG} g · carbs ${u.targetCarbsG} g · fat ${u.targetFatG} g`;

export function fmtProgress(t: Totals, u: User) {
  if (u.targetKcal == null) return `${fmtTotals(t)} <i>(no targets: /profile)</i>`;
  return `${t.kcal}/${u.targetKcal} kcal · P ${Math.round(t.proteinG)}/${u.targetProteinG} · C ${Math.round(t.carbsG)}/${u.targetCarbsG} · F ${Math.round(t.fatG)}/${u.targetFatG}`;
}

export function fmtMeal(m: Meal, u: User, note = "") {
  const items = m.items.map((i) => `• ${esc(i.name)} (${esc(i.portion)}): ${i.kcal} kcal`).join("\n");
  const time = localTime(m.eatenAt, u.utcOffsetMinutes).slice(11);
  return `<b>${esc(m.description)}</b> · ${time}\n${items}\n<b>${fmtTotals(m)}</b>${note ? `\n<i>${esc(note)}</i>` : ""}`;
}

export const mealActions = (mealId: string, revisionId: string): Keyboard => [[btn("↩️ Undo", `undo:${revisionId}`), btn("✏️ Fix", `fix:${mealId}`)]];
