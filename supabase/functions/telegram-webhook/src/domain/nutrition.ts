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
