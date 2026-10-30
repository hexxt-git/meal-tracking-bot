import type { Meal, User } from "../db/index.ts";
import type { Totals } from "../domain/meal.ts";
import { localDayLabel, localTime } from "../domain/time.ts";
import { esc } from "../telegram/api.ts";
import { bar, num, table, truncate } from "./ui.ts";

export const clock = (d: Date, u: User) =>
  localTime(d, u.utcOffsetMinutes).slice(11);
export const dayLabel = (d: Date, u: User) =>
  localDayLabel(d, u.utcOffsetMinutes);

const macroLine = (t: Totals) =>
  `<b>${num(t.kcal)} kcal</b>  ·  P ${num(t.proteinG)} g  ·  C ${num(t.carbsG)} g  ·  F ${num(t.fatG)} g`;

/** One line per item instead of a monospace table, so long names and portions wrap instead of being cut. */
function itemLines(m: Meal): string {
  if (!m.items.length) return "";
  return `${m.items.map((i) => `• ${esc(i.name)}, ${esc(i.portion)}  ·  ${num(i.kcal)} kcal`).join("\n")}\n\n`;
}

// Differences of the rounded values, so they match the numbers shown next to them (85.5 of 132 shows 86, so 46 left).
const diff = (value: number, target: number) =>
  Math.round(target) - Math.round(value);

/** "46 g" / "over 10 g" */
const left = (value: number, target: number, unit: string) => {
  const d = diff(value, target);
  return d < 0 ? `over ${num(-d)} ${unit}` : `${num(d)} ${unit}`;
};

/** "680 kcal left" / "120 kcal over" */
export const kcalLeft = (value: number, target: number) => {
  const d = diff(value, target);
  return d < 0 ? `${num(-d)} kcal over` : `${num(d)} kcal left`;
};

/** "Left: 680 kcal · P 46 g · C 40 g · F over 10 g", skipping macros without a target. */
function leftLine(t: Totals, u: User, targetKcal: number): string {
  const macros = (
    [
      ["P", t.proteinG, u.targetProteinG],
      ["C", t.carbsG, u.targetCarbsG],
      ["F", t.fatG, u.targetFatG],
    ] as const
  ).flatMap(([label, value, target]) =>
    target == null ? [] : [`${label} ${left(value, target, "g")}`],
  );
  return `Left: ${[left(t.kcal, targetKcal, "kcal"), ...macros].join("  ·  ")}`;
}

/** Totals against targets as an aligned block with bars; plain totals when no targets are set. */
export function progressTable(t: Totals, u: User): string {
  if (u.targetKcal == null) {
    return table(
      [
        ["Calories", `${num(t.kcal)} kcal`],
        ["Protein", `${num(t.proteinG)} g`],
        ["Carbs", `${num(t.carbsG)} g`],
        ["Fat", `${num(t.fatG)} g`],
      ],
      ["l", "r"],
    );
  }
  const row = (label: string, value: number, target: number, unit: string) => [
    label,
    num(value),
    `/ ${num(target)}${unit}`,
    bar(value, target),
  ];
  return `${table(
    [
      row("Calories", t.kcal, u.targetKcal, ""),
      row("Protein", t.proteinG, u.targetProteinG ?? 0, " g"),
      row("Carbs", t.carbsG, u.targetCarbsG ?? 0, " g"),
      row("Fat", t.fatG, u.targetFatG ?? 0, " g"),
    ],
    ["l", "r", "l", "l"],
  )}${leftLine(t, u, u.targetKcal)}`;
}

export function mealBody(m: Meal): string {
  const note = m.userNote ? `\n<i>${esc(truncate(m.userNote, 200))}</i>` : "";
  return `${itemLines(m)}${macroLine(m)}${note}`;
}

export const mealButtonLabel = (m: Meal, u: User, withDate = false) =>
  `${withDate ? `${dayLabel(m.eatenAt, u).slice(4)}  ` : ""}${clock(m.eatenAt, u)}  ${truncate(m.description, 28)}  ·  ${num(m.kcal)}`;
