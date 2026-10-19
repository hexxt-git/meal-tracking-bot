import type { Meal, User } from "../db/index.ts";
import type { Totals } from "../domain/meal.ts";
import { localDayLabel, localTime } from "../domain/time.ts";
import { esc } from "../telegram/api.ts";
import { bar, num, table, truncate } from "./ui.ts";

export const clock = (d: Date, u: User) => localTime(d, u.utcOffsetMinutes).slice(11);
export const dayLabel = (d: Date, u: User) => localDayLabel(d, u.utcOffsetMinutes);

export const macroLine = (t: Totals) =>
  `<b>${num(t.kcal)} kcal</b>  ·  P ${num(t.proteinG)} g  ·  C ${num(t.carbsG)} g  ·  F ${num(t.fatG)} g`;

export function itemsTable(m: Meal): string {
  if (!m.items.length) return "";
  return table(m.items.map((i) => [truncate(i.name, 22), truncate(i.portion, 10), num(i.kcal)]), ["l", "l", "r"]);
}

/** Totals against targets as an aligned block with bars; plain totals when no targets are set. */
export function progressTable(t: Totals, u: User): string {
  if (u.targetKcal == null) {
    return table([
      ["Calories", `${num(t.kcal)} kcal`],
      ["Protein", `${num(t.proteinG)} g`],
      ["Carbs", `${num(t.carbsG)} g`],
      ["Fat", `${num(t.fatG)} g`],
    ], ["l", "r"]);
  }
  const row = (label: string, value: number, target: number, unit: string) =>
    [label, num(value), `/ ${num(target)}${unit}`, bar(value, target)];
  return table([
    row("Calories", t.kcal, u.targetKcal, ""),
    row("Protein", t.proteinG, u.targetProteinG ?? 0, " g"),
    row("Carbs", t.carbsG, u.targetCarbsG ?? 0, " g"),
    row("Fat", t.fatG, u.targetFatG ?? 0, " g"),
  ], ["l", "r", "l", "l"]);
}

export function mealBody(m: Meal): string {
  const note = m.userNote ? `\n<i>${esc(truncate(m.userNote, 200))}</i>` : "";
  return `${itemsTable(m)}${macroLine(m)}${note}`;
}

export const mealButtonLabel = (m: Meal, u: User, withDate = false) =>
  `${withDate ? `${dayLabel(m.eatenAt, u).slice(4)}  ` : ""}${clock(m.eatenAt, u)}  ${truncate(m.description, 28)}  ·  ${num(m.kcal)}`;
