import { LB_PER_KG } from "./nutrition.ts";
import type { Units } from "./onboarding.ts";
import { dayStart } from "./time.ts";

export type WeightUnit = "kg" | "lb";

export const MIN_WEIGHT_KG = 20;
export const MAX_WEIGHT_KG = 400;

export const unitFor = (units: Units): WeightUnit =>
  units === "imperial" ? "lb" : "kg";
export const unitsFor = (unit: WeightUnit): Units =>
  unit === "lb" ? "imperial" : "metric";

export const toKg = (value: number, unit: WeightUnit) =>
  Math.round((unit === "lb" ? value / LB_PER_KG : value) * 1000) / 1000;

export const fromKg = (kg: number, unit: WeightUnit) =>
  unit === "lb" ? kg * LB_PER_KG : kg;

/** "70.0 kg" / "154.3 lb" */
export const fmtWeight = (kg: number, unit: WeightUnit) =>
  `${fromKg(kg, unit).toFixed(1)} ${unit}`;

/** "-0.6 kg" / "+1.2 lb" */
export function fmtWeightDelta(kg: number, unit: WeightUnit): string {
  const v = Math.round(fromKg(kg, unit) * 10) / 10;
  return `${v > 0 ? "+" : v < 0 ? "-" : "±"}${Math.abs(v).toFixed(1)} ${unit}`;
}

export const isPlausibleKg = (kg: number) =>
  Number.isFinite(kg) && kg >= MIN_WEIGHT_KG && kg <= MAX_WEIGHT_KG;

/**
 * Latest weight minus the latest weigh-in from at least `days` local days before today.
 * `entries` are newest first; null when there is no entry that old.
 */
export function weightChange(
  entries: { weighedAt: Date; weightKg: number }[],
  days: number,
  offsetMin: number,
  now = Date.now(),
): number | null {
  if (!entries.length) return null;
  const cutoff = dayStart(offsetMin, days - 1, now).getTime();
  const ref = entries.find((e) => e.weighedAt.getTime() < cutoff);
  return ref ? entries[0].weightKg - ref.weightKg : null;
}
