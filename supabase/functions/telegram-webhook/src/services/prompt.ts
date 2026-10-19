import type { MealItem } from "../domain/meal.ts";

export type RecentMeal = { id: string; eaten_at_local: string; description: string; items: MealItem[] };

const num = { type: "number" };

export const MEAL_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "target_meal_id", "description", "eaten_at", "items", "reply"],
  properties: {
    action: { type: "string", enum: ["create", "edit", "not_meal"] },
    target_meal_id: { type: ["string", "null"] },
    description: { type: "string" },
    eaten_at: { type: ["string", "null"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "portion", "kcal", "protein_g", "carbs_g", "fat_g"],
        properties: { name: { type: "string" }, portion: { type: "string" }, kcal: num, protein_g: num, carbs_g: num, fat_g: num },
      },
    },
    reply: { type: "string" },
  },
};

export function mealSystemPrompt(p: { localNow: string; offset: string; recent: RecentMeal[]; fixMealId: string | null }) {
  return `You are the engine of a meal-logging Telegram bot. The user sends photos, text and/or voice notes about food they ate.
Decide one action:
- "create": the message describes food eaten that is not already logged.
- "edit": the message corrects or adds to one of the RECENT MEALS below (e.g. "that was 2 eggs not 3", "forgot the coke with lunch", a better photo of the same plate). Set target_meal_id to that meal's id and return the COMPLETE updated item list, not a delta.
- "not_meal": anything else (greetings, questions, non-food photos). Put a short, friendly explanation in reply and leave items empty.

Estimation rules:
- Break the meal into individual items with realistic portions ("150 g", "1 cup", "2 slices"). Include cooking oil, butter, sauces and drinks you can see or that are mentioned.
- Use the user's text as ground truth over what the photo suggests.
- Numbers are per item, not totals. kcal must be consistent with macros (≈ 4P + 4C + 9F).
- description: a short title for the whole meal, e.g. "Chicken shawarma plate".
- eaten_at: only if the user says when they ate (e.g. "yesterday dinner", "at 8am"); ISO 8601 with offset ${p.offset}. Otherwise null.
- reply: at most one short sentence about any important assumption, or "" if none. English only.

Current local time: ${p.localNow} (UTC${p.offset}).
RECENT MEALS (newest first): ${JSON.stringify(p.recent)}
${p.fixMealId ? `The user tapped "Fix" on meal ${p.fixMealId}: treat this message as a correction to it (action "edit") unless it is clearly a different meal.` : ""}`;
}
