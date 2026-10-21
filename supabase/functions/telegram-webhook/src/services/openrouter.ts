import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { config } from "../config.ts";
import { OpenRouterError } from "./openrouter-error.ts";

export { OpenRouterError, parseProviderError } from "./openrouter-error.ts";

const ENDPOINT = "https://openrouter.ai/api/v1";

export type Media = { kind: "image"; mime: string; data: Uint8Array } | { kind: "audio"; format: string; data: Uint8Array };

const models = createModels();
models.setProvider(openrouterProvider());

export const chatModel = () => {
  const model = models.getModel("openrouter", config.model);
  if (!model) throw new Error(`Unknown model ${config.model}`);
  return model;
};

export function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

type Payload = {
  messages: { role: string; content: string | unknown[] }[];
  [k: string]: unknown;
};

type UsageChunk = { id?: string; usage?: { cost?: number } };

/** What OpenRouter billed for one request. */
export type RequestUsage = { generationId: string | null; costUsd: number };

/**
 * Streams through OpenRouter with the user's key. The payload hook sets what pi has no per-request field for: a
 * higher reasoning effort on the first request than on follow-ups, an output cap, and voice notes, which go on the
 * first user message as `input_audio` parts.
 */
export function openRouterStream(
  apiKey: string,
  audio: Extract<Media, { kind: "audio" }>[],
  onUsage?: (usage: RequestUsage) => void,
): StreamFn {
  let requests = 0;
  return (model, context, options) =>
    models.streamSimple(model, context, {
      ...options,
      apiKey,
      headers: { ...options?.headers, "x-title": "Meal Tracker" },
      // Retries failures before streaming starts; a stream cut off midway is retried by the agent.
      maxRetries: 2,
      maxRetryDelayMs: 10_000,
      onPayload: (raw) => {
        const payload = raw as Payload;
        payload.reasoning = { effort: requests++ === 0 ? config.agent.firstEffort : config.agent.followUpEffort };
        payload.max_completion_tokens = config.agent.maxOutputTokens;
        const user = payload.messages.find((m) => m.role === "user");
        if (user && audio.length) {
          const parts = typeof user.content === "string" ? [{ type: "text", text: user.content }] : user.content;
          user.content = [...parts, ...audio.map((a) => ({ type: "input_audio", input_audio: { data: base64(a.data), format: a.format } }))];
        }
        return payload;
      },
      onProviderStreamEvent: onUsage && ((event) => {
        const chunk = event as UsageChunk;
        if (chunk.usage) onUsage({ generationId: chunk.id ?? null, costUsd: chunk.usage.cost ?? 0 });
      }),
    });
}

export type Research = { answer: string; sources: string[]; costUsd: number; generationId: string | null };

/**
 * One web-searched lookup in its own small request, so search results never enter the agent's context;
 * the agent only sees this short answer.
 */
export async function researchFood(apiKey: string, query: string, country: string | null): Promise<Research> {
  const where = country ? ` as sold in ${country}` : "";
  const res = await fetch(`${ENDPOINT}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-title": "Meal Tracker" },
    body: JSON.stringify({
      model: config.model,
      reasoning: { effort: config.research.effort },
      max_tokens: config.research.maxOutputTokens,
      plugins: [{ id: "web", engine: config.research.engine, max_results: config.research.maxResults }],
      messages: [
        {
          role: "system",
          content: "You look up nutrition facts on the web. Reply in at most 6 short lines: the exact product found, " +
            "kcal, protein, carbs and fat per 100 g (or per serving, saying which), the usual pack or serving size, and the source. " +
            "Only report numbers you found in the search results. If nothing matches, start with NOT FOUND and name the closest comparable product with its numbers.",
        },
        { role: "user", content: `Nutrition facts for: ${query}${where}` },
      ],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new OpenRouterError(body.error?.code ?? res.status, body.error?.message ?? `HTTP ${res.status}`);
  const message = body.choices?.[0]?.message ?? {};
  const sources = (message.annotations ?? []).flatMap((a: { url_citation?: { url?: string } }) => (a.url_citation?.url ? [a.url_citation.url] : []));
  return { answer: String(message.content ?? "").trim(), sources, costUsd: body.usage?.cost ?? 0, generationId: body.id ?? null };
}

export async function isValidKey(apiKey: string): Promise<boolean> {
  const res = await fetch(`${ENDPOINT}/key`, { headers: { authorization: `Bearer ${apiKey}` } });
  await res.body?.cancel();
  return res.ok;
}

export const looksLikeKey = (s: string) => /^sk-or-[\w-]{20,}$/.test(s.trim());
