import type { MealItem } from "../domain/meal.ts";

export type RecentMeal = { id: string; eaten_at: string; logged_at: string; description: string; items: MealItem[] };

/** "Now" is when the user sent the message, in their timezone. */
export type TimeContext = { stamp: string; iso: string; offset: string };

const num = { type: "number" };

export const MEAL_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "target_meal_id", "description", "eaten_at", "items", "reply"],
  properties: {
    action: { type: "string", enum: ["create", "edit", "not_meal"] },
    target_meal_id: { type: ["string", "null"], description: "For edit: id of the RECENT MEAL being changed. Otherwise null." },
    description: { type: "string", description: "Short title for the whole meal. For an edit that keeps the title: empty string." },
    eaten_at: {
      type: ["string", "null"],
      description: "When the food was eaten (not when it was logged), as absolute ISO 8601 with the user's UTC offset, " +
        "resolved against the current time. Null when the user gives no time.",
    },
    items: {
      type: "array",
      description: "Complete item list for the meal. For an edit that changes only the time: empty array.",
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

export function mealSystemPrompt(p: { now: TimeContext; recent: RecentMeal[]; fixMealId: string | null }) {
  return `You are the engine of a meal-logging Telegram bot. The user sends photos, text and/or voice notes about food they ate.

CURRENT TIME
It is ${p.now.stamp} (UTC${p.now.offset}) for the user, i.e. ${p.now.iso}. This is when they sent the message.

ACTIONS
- "create": the message describes food eaten that is not already logged.
- "edit": the message changes one of the RECENT MEALS: its contents ("that was 2 eggs not 3", "forgot the coke with lunch", a better photo of the same plate) and/or when it was eaten ("I had it this morning at 10AM", "that was yesterday's dinner"). Set target_meal_id. Return the COMPLETE updated item list, or an empty list and empty description if only the time changes.
- "not_meal": anything else (greetings, questions, non-food photos). Put a short, friendly explanation in reply and leave items empty.

MEAL TIME (eaten_at)
- eaten_at is when the food was eaten. Each recent meal also shows logged_at, when it was sent to the bot; the two differ when the user logs late.
- Whenever the user mentions a time ("this morning at 10", "at 8pm", "2 hours ago", "yesterday", "on Saturday", "for breakfast"), resolve it against the current time above and return an absolute ISO 8601 timestamp with offset ${p.now.offset}.
- Meal words without a clock time mean: breakfast 08:00, lunch 13:00, dinner 19:30, snack at the current time; use the most recent such moment that is not in the future.
- Never return a time in the future. If the user gives no time, return null: a new meal is then recorded as eaten now, and an edited meal keeps its time.
- "It"/"that" with no other context refers to the first RECENT MEAL (the one logged most recently).

ESTIMATION
- Break the meal into individual items with realistic portions ("150 g", "1 cup", "2 slices"). Include cooking oil, butter, sauces and drinks you can see or that are mentioned.
- Use the user's text as ground truth over what the photo suggests.
- Numbers are per item, not totals. kcal must be consistent with macros (≈ 4P + 4C + 9F).
- description: a short title for the whole meal, e.g. "Chicken shawarma plate".
- reply: at most one short sentence about an important assumption (including how you read a time if it was ambiguous), or "" if none. English only.

RECENT MEALS (most recently logged first, local times): ${JSON.stringify(p.recent)}
${p.fixMealId ? `The user tapped "Fix" on meal ${p.fixMealId}: treat this message as a correction to it (action "edit") unless it is clearly a different meal.` : ""}`;
}
