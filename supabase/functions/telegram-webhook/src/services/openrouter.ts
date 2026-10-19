import { config } from "../config.ts";
import { MealItem, sanitizeItems } from "../domain/meal.ts";
import { MEAL_DECISION_SCHEMA, mealSystemPrompt, RecentMeal } from "./prompt.ts";

const ENDPOINT = "https://openrouter.ai/api/v1";

export type Decision = {
  action: "create" | "edit" | "not_meal";
  target_meal_id: string | null;
  description: string;
  eaten_at: string | null;
  items: MealItem[];
  reply: string;
};

export type Media = { kind: "image"; mime: string; data: Uint8Array } | { kind: "audio"; format: string; data: Uint8Array };

export class OpenRouterError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function toContentPart(m: Media) {
  return m.kind === "image"
    ? { type: "image_url", image_url: { url: `data:${m.mime};base64,${base64(m.data)}` } }
    : { type: "input_audio", input_audio: { data: base64(m.data), format: m.format } };
}

export async function analyzeMeal(input: {
  apiKey: string;
  text: string;
  media: Media[];
  localNow: string;
  offset: string;
  recent: RecentMeal[];
  fixMealId: string | null;
}): Promise<Decision> {
  const res = await fetch(`${ENDPOINT}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json", "x-title": "Meal Tracker" },
    body: JSON.stringify({
      model: config.model,
      reasoning: { effort: config.reasoningEffort },
      messages: [
        { role: "system", content: mealSystemPrompt(input) },
        { role: "user", content: [{ type: "text", text: input.text || "(no text)" }, ...input.media.map(toContentPart)] },
      ],
      response_format: { type: "json_schema", json_schema: { name: "meal_decision", strict: true, schema: MEAL_DECISION_SCHEMA } },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new OpenRouterError(body.error?.code ?? res.status, body.error?.message ?? `HTTP ${res.status}`);
  }
  const decision: Decision = JSON.parse(body.choices[0].message.content);
  return { ...decision, items: sanitizeItems(decision.items) };
}

export async function isValidKey(apiKey: string): Promise<boolean> {
  const res = await fetch(`${ENDPOINT}/key`, { headers: { authorization: `Bearer ${apiKey}` } });
  await res.body?.cancel();
  return res.ok;
}

export const looksLikeKey = (s: string) => /^sk-or-[\w-]{20,}$/.test(s.trim());
