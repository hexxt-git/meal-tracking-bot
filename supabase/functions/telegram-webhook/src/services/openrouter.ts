import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { config } from "../config.ts";

const ENDPOINT = "https://openrouter.ai/api/v1";

export type Media = { kind: "image"; mime: string; data: Uint8Array } | { kind: "audio"; format: string; data: Uint8Array };

export class OpenRouterError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

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
  tools?: unknown[];
  [k: string]: unknown;
};

type UsageChunk = {
  choices?: { delta?: { annotations?: { url_citation?: { url?: string } }[] } }[];
  usage?: { cost?: number; server_tool_use?: { web_search_requests?: number } };
};

/** What OpenRouter billed for one request (including server-side search), and the pages it cited. */
export type RequestUsage = { costUsd: number; searches: number; sources: string[] };

/**
 * Streams through OpenRouter with the user's key. The payload hook adds what pi has no field for:
 * OpenRouter's server-side web search (run by the model's provider, i.e. Google Search for Gemini)
 * and voice notes, which go on the first user message as `input_audio` parts.
 */
export function openRouterStream(
  apiKey: string,
  audio: Extract<Media, { kind: "audio" }>[],
  onUsage?: (usage: RequestUsage) => void,
): StreamFn {
  return (model, context, options) =>
    models.streamSimple(model, context, {
      ...options,
      apiKey,
      headers: { ...options?.headers, "x-title": "Meal Tracker" },
      onPayload: (raw) => {
        const payload = raw as Payload;
        payload.reasoning = { effort: config.reasoningEffort };
        payload.tools = [
          ...(payload.tools ?? []),
          { type: "openrouter:web_search", parameters: { engine: config.agent.searchEngine, max_uses: config.agent.maxSearchesPerRequest } },
        ];
        const user = payload.messages.find((m) => m.role === "user");
        if (user && audio.length) {
          const parts = typeof user.content === "string" ? [{ type: "text", text: user.content }] : user.content;
          user.content = [...parts, ...audio.map((a) => ({ type: "input_audio", input_audio: { data: base64(a.data), format: a.format } }))];
        }
        return payload;
      },
      onProviderStreamEvent: onUsage && ((event) => {
        const chunk = event as UsageChunk;
        const sources = (chunk.choices?.[0]?.delta?.annotations ?? []).flatMap((a) => (a.url_citation?.url ? [a.url_citation.url] : []));
        if (sources.length) onUsage({ costUsd: 0, searches: 0, sources });
        if (chunk.usage) {
          onUsage({ costUsd: chunk.usage.cost ?? 0, searches: chunk.usage.server_tool_use?.web_search_requests ?? 0, sources: [] });
        }
      }),
    });
}

/** pi reports provider failures as "<status>: <body>". */
export function parseProviderError(message: string): OpenRouterError {
  const status = Number(message.match(/^(\d{3})\b/)?.[1] ?? 0);
  const detail = message.replace(/^\d{3}:\s*/, "");
  try {
    return new OpenRouterError(status, JSON.parse(detail).message ?? detail);
  } catch {
    return new OpenRouterError(status, detail);
  }
}

export async function isValidKey(apiKey: string): Promise<boolean> {
  const res = await fetch(`${ENDPOINT}/key`, { headers: { authorization: `Bearer ${apiKey}` } });
  await res.body?.cancel();
  return res.ok;
}

export const looksLikeKey = (s: string) => /^sk-or-[\w-]{20,}$/.test(s.trim());
