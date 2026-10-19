import { Activity, ACTIVITY, LB_PER_KG, Objective, parseHeight, parseWeight, Profile, Sex } from "./nutrition.ts";
import { fmtOffset, TZ_OFFSETS } from "./time.ts";

export type Units = "metric" | "imperial";

export type Step =
  | "key"
  | "units"
  | "sex"
  | "age"
  | "height"
  | "weight"
  | "activity"
  | "objective"
  | "pace"
  | "timezone"
  | "done";

export const PROFILE_START: Step = "units";
export const TEXT_STEPS: Step[] = ["age", "height", "weight"];

export type ProfileState = {
  units: Units;
  sex: Sex | null;
  age: number | null;
  heightCm: number | null;
  weightKg: number | null;
  activity: Activity | null;
  objective: Objective | null;
  paceKgPerWeek: number | null;
};

export type ProfilePatch = Partial<ProfileState & { utcOffsetMinutes: number }>;

const ORDER: Step[] = ["units", "sex", "age", "height", "weight", "activity", "objective", "pace", "timezone", "done"];

export function nextStep(step: Step, patch: ProfilePatch): Step {
  if (step === "objective" && patch.objective === "maintain") return "timezone";
  return ORDER[ORDER.indexOf(step) + 1] ?? "done";
}

/** Step after a key is saved: start the profile on first setup, otherwise stay where the user was. */
export function stepAfterKey(step: Step, hasTargets: boolean): Step {
  if (step !== "key") return step;
  return hasTargets ? "done" : PROFILE_START;
}

export function paceOptions(units: Units, objective: Objective | null): { label: string; kg: number }[] {
  const kgs = objective === "gain" ? [0.25, 0.5] : [0.25, 0.5, 0.75, 1];
  return kgs.map((kg) => ({ kg, label: units === "imperial" ? `${(kg * LB_PER_KG).toFixed(1)} lb/week` : `${kg} kg/week` }));
}

type Answer = { patch: ProfilePatch; label: string };

/** Validates a button answer for `step`. Returns null for stale or forged callback data. */
export function parseChoice(step: Step, value: string, state: ProfileState): Answer | null {
  switch (step) {
    case "units":
      return value === "metric" || value === "imperial" ? { patch: { units: value }, label: value } : null;
    case "sex":
      return value === "male" || value === "female" ? { patch: { sex: value }, label: value } : null;
    case "activity":
      return value in ACTIVITY ? { patch: { activity: value as Activity }, label: ACTIVITY[value as Activity].label } : null;
    case "objective":
      if (value !== "lose" && value !== "maintain" && value !== "gain") return null;
      return { patch: value === "maintain" ? { objective: value, paceKgPerWeek: 0 } : { objective: value }, label: value };
    case "pace": {
      const opt = paceOptions(state.units, state.objective).find((p) => p.kg === Number(value));
      return opt ? { patch: { paceKgPerWeek: opt.kg }, label: opt.label } : null;
    }
    case "timezone": {
      const off = Number(value);
      return TZ_OFFSETS.includes(off) ? { patch: { utcOffsetMinutes: off }, label: fmtOffset(off) } : null;
    }
    default:
      return null;
  }
}

/** Validates a typed answer for a text step. */
export function parseTextAnswer(step: Step, text: string, units: Units): { patch: ProfilePatch } | { error: string } {
  const imperial = units === "imperial";
  if (step === "age") {
    const age = Number(text.trim());
    return Number.isInteger(age) && age >= 10 && age <= 120 ? { patch: { age } } : { error: "Please send your age as a number, e.g. 29." };
  }
  if (step === "height") {
    const cm = parseHeight(text, units);
    return cm && cm >= 80 && cm <= 260 ? { patch: { heightCm: cm } } : { error: `I couldn't read that. Try e.g. ${imperial ? `5'10"` : "178 cm"}.` };
  }
  const kg = parseWeight(text, units);
  return kg && kg >= 25 && kg <= 400 ? { patch: { weightKg: kg } } : { error: `I couldn't read that. Try e.g. ${imperial ? "170 lb" : "75 kg"}.` };
}

export function completeProfile(s: ProfileState): Profile | null {
  const { sex, age, heightCm, weightKg, activity, objective, paceKgPerWeek } = s;
  if (!sex || !age || !heightCm || !weightKg || !activity || !objective || paceKgPerWeek == null) return null;
  return { sex, age, height_cm: heightCm, weight_kg: weightKg, activity, objective, pace_kg_per_week: paceKgPerWeek };
}
