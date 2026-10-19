export type GoalField = "kcal" | "protein" | "carbs" | "fat";

export const GOAL_FIELDS: Record<GoalField, { label: string; unit: string; min: number; max: number; deltas: number[]; fallback: number }> = {
  kcal: { label: "Calories", unit: "kcal", min: 1000, max: 6000, deltas: [-250, -50, 50, 250], fallback: 2000 },
  protein: { label: "Protein", unit: "g", min: 20, max: 400, deltas: [-25, -5, 5, 25], fallback: 120 },
  carbs: { label: "Carbs", unit: "g", min: 0, max: 800, deltas: [-25, -5, 5, 25], fallback: 220 },
  fat: { label: "Fat", unit: "g", min: 20, max: 300, deltas: [-10, -5, 5, 10], fallback: 70 },
};

export const isGoalField = (s: string): s is GoalField => s in GOAL_FIELDS;

export function clampGoal(field: GoalField, value: number): number {
  const f = GOAL_FIELDS[field];
  if (!Number.isFinite(value)) return f.fallback;
  return Math.min(f.max, Math.max(f.min, Math.round(value)));
}
