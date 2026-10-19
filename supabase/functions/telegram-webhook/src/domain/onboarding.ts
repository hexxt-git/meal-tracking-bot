import { Activity, ACTIVITY, LB_PER_KG, Objective, Profile, Sex } from "./nutrition.ts";
import { TZ_OFFSETS } from "./time.ts";

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

export const PROFILE_STEPS: Step[] = ["units", "sex", "age", "height", "weight", "activity", "objective", "pace", "timezone"];

export function nextStep(step: Step, objective: Objective | null): Step {
  if (step === "objective" && objective === "maintain") return "timezone";
  return PROFILE_STEPS[PROFILE_STEPS.indexOf(step) + 1] ?? "done";
}

export function prevStep(step: Step, objective: Objective | null): Step | null {
  const prev = PROFILE_STEPS[PROFILE_STEPS.indexOf(step) - 1] ?? null;
  return prev === "pace" && objective === "maintain" ? "objective" : prev;
}

/** Step after a key is saved: start the profile on first setup, otherwise stay where the user was. */
export function stepAfterKey(step: Step, hasTargets: boolean): Step {
  if (step !== "key") return step;
  return hasTargets ? "done" : PROFILE_START;
}

export function paceOptions(units: Units, objective: Objective | null): { label: string; kg: number }[] {
  const kgs = objective === "gain" ? [0.25, 0.5] : [0.25, 0.5, 0.75, 1];
  return kgs.map((kg) => ({ kg, label: units === "imperial" ? `${(kg * LB_PER_KG).toFixed(1)} lb/wk` : `${kg} kg/wk` }));
}

/** Validates a button answer for a choice step. Returns null for stale or forged callback data. */
export function parseChoice(step: Step, value: string, state: ProfileState): ProfilePatch | null {
  switch (step) {
    case "units":
      return value === "metric" || value === "imperial" ? { units: value } : null;
    case "sex":
      return value === "male" || value === "female" ? { sex: value } : null;
    case "activity":
      return value in ACTIVITY ? { activity: value as Activity } : null;
    case "objective":
      if (value !== "lose" && value !== "maintain" && value !== "gain") return null;
      return value === "maintain" ? { objective: value, paceKgPerWeek: 0 } : { objective: value };
    case "pace": {
      const opt = paceOptions(state.units, state.objective).find((p) => p.kg === Number(value));
      return opt ? { paceKgPerWeek: opt.kg } : null;
    }
    case "timezone": {
      const off = Number(value);
      return TZ_OFFSETS.includes(off) ? { utcOffsetMinutes: off } : null;
    }
    default:
      return null;
  }
}

export type NumericStep = "age" | "height" | "weight";

/** Button-driven number entry. Values are in display units (years, cm or inches, kg or lb). */
export type Stepper = {
  min: number;
  max: number;
  deltas: number[];
  initial: number;
  format: (v: number) => string;
  toPatch: (v: number) => ProfilePatch;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const feetInches = (inches: number) => `${Math.floor(inches / 12)}'${inches % 12}"`;

export function stepper(step: NumericStep, s: ProfileState): Stepper {
  const imperial = s.units === "imperial";
  switch (step) {
    case "age":
      return { min: 13, max: 100, deltas: [-5, -1, 1, 5], initial: s.age ?? 30, format: (v) => `${v} years`, toPatch: (v) => ({ age: v }) };
    case "height":
      return imperial
        ? {
          min: 48, max: 90, deltas: [-6, -1, 1, 6],
          initial: s.heightCm ? Math.round(s.heightCm / 2.54) : 67,
          format: feetInches,
          toPatch: (v) => ({ heightCm: round1(v * 2.54) }),
        }
        : {
          min: 120, max: 230, deltas: [-10, -1, 1, 10],
          initial: s.heightCm ? Math.round(s.heightCm) : 170,
          format: (v) => `${v} cm`,
          toPatch: (v) => ({ heightCm: v }),
        };
    case "weight":
      return imperial
        ? {
          min: 66, max: 660, deltas: [-10, -1, 1, 10],
          initial: s.weightKg ? Math.round(s.weightKg * LB_PER_KG) : 155,
          format: (v) => `${v} lb`,
          toPatch: (v) => ({ weightKg: round1(v / LB_PER_KG) }),
        }
        : {
          min: 30, max: 300, deltas: [-5, -1, -0.5, 0.5, 1, 5],
          initial: s.weightKg ?? 70,
          format: (v) => `${v.toFixed(1)} kg`,
          toPatch: (v) => ({ weightKg: v }),
        };
  }
}

/** Clamps and snaps a (possibly forged) stepper value. */
export function clampStep(spec: Stepper, value: number): number {
  if (!Number.isFinite(value)) return spec.initial;
  return Math.min(spec.max, Math.max(spec.min, Math.round(value * 2) / 2));
}

export function completeProfile(s: ProfileState): Profile | null {
  const { sex, age, heightCm, weightKg, activity, objective, paceKgPerWeek } = s;
  if (!sex || !age || !heightCm || !weightKg || !activity || !objective || paceKgPerWeek == null) return null;
  return { sex, age, height_cm: heightCm, weight_kg: weightKg, activity, objective, pace_kg_per_week: paceKgPerWeek };
}
