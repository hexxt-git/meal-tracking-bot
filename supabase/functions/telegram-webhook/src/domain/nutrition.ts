export type Sex = "male" | "female";
export type Activity = "sedentary" | "light" | "moderate" | "active" | "very_active";
export type Objective = "lose" | "maintain" | "gain";

export const ACTIVITY: Record<Activity, { factor: number; label: string }> = {
  sedentary: { factor: 1.2, label: "Sedentary (desk job, little exercise)" },
  light: { factor: 1.375, label: "Light (exercise 1–3 days/week)" },
  moderate: { factor: 1.55, label: "Moderate (exercise 3–5 days/week)" },
  active: { factor: 1.725, label: "Active (hard exercise 6–7 days/week)" },
  very_active: { factor: 1.9, label: "Very active (physical job + training)" },
};

export type Profile = {
  sex: Sex;
  age: number;
  height_cm: number;
  weight_kg: number;
  activity: Activity;
  objective: Objective;
  pace_kg_per_week: number;
};

export type Targets = { kcal: number; protein_g: number; carbs_g: number; fat_g: number };

const KCAL_PER_KG_FAT = 7700;

export function computeTargets(p: Profile): Targets {
  const bmr = 10 * p.weight_kg + 6.25 * p.height_cm - 5 * p.age + (p.sex === "male" ? 5 : -161);
  const tdee = bmr * ACTIVITY[p.activity].factor;
  const delta = (p.pace_kg_per_week * KCAL_PER_KG_FAT) / 7;
  const raw = p.objective === "lose" ? tdee - delta : p.objective === "gain" ? tdee + delta : tdee;
  const floor = p.sex === "male" ? 1500 : 1200;
  const kcal = Math.round(Math.max(raw, floor) / 10) * 10;

  const protein_g = Math.round(p.weight_kg * (p.objective === "lose" ? 2.0 : 1.8));
  const fat_g = Math.round((kcal * 0.25) / 9);
  const carbs_g = Math.max(0, Math.round((kcal - protein_g * 4 - fat_g * 9) / 4));
  return { kcal, protein_g, carbs_g, fat_g };
}

export const LB_PER_KG = 2.20462;

/** Accepts "180", "180cm", "5'10", "5'10\"", "5 10", "70in". Returns cm. */
export function parseHeight(input: string, units: "metric" | "imperial"): number | null {
  const s = input.trim().toLowerCase();
  const ftIn = s.match(/^(\d)\s*(?:'|ft|\s)\s*(\d{1,2})?\s*(?:"|in)?$/);
  if (ftIn) return round1((Number(ftIn[1]) * 12 + Number(ftIn[2] ?? 0)) * 2.54);
  const num = s.match(/^(\d+(?:[.,]\d+)?)\s*(cm|in|m)?$/);
  if (!num) return null;
  const n = Number(num[1].replace(",", "."));
  const unit = num[2] ?? (units === "imperial" ? "in" : n < 3 ? "m" : "cm");
  return round1(unit === "in" ? n * 2.54 : unit === "m" ? n * 100 : n);
}

/** Accepts "72", "72kg", "160lb". Returns kg. */
export function parseWeight(input: string, units: "metric" | "imperial"): number | null {
  const m = input.trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*(kg|lbs?)?$/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  const unit = m[2] ?? (units === "imperial" ? "lb" : "kg");
  return round1(unit.startsWith("lb") ? n / LB_PER_KG : n);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
