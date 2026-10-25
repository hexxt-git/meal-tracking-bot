import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { config } from "../config.ts";
import type {
  AuthStyle,
  Effort,
  ReasoningParam,
} from "../domain/ai-settings.ts";
import { ProviderError } from "./provider-error.ts";

export { parseProviderError, ProviderError } from "./provider-error.ts";

const OPENROUTER = "https://openrouter.ai/api/v1";
const TITLE = "Meal Tracker";

export type Media =
  | { kind: "image"; mime: string; data: Uint8Array }
  | { kind: "audio"; format: string; data: Uint8Array };

/** Where and how to reach a custom OpenAI-compatible API. */
export type Connection = {
  baseUrl: string;
  token: string | null;
  auth: AuthStyle;
  authHeader: string;
  /** Extra headers sent with every request. */
  headers: Record<string, string>;
};

export type ChatProvider =
  | { kind: "openrouter"; apiKey: string }
  | {
      kind: "custom";
      connection: Connection;
      model: string;
      images: boolean;
      reasoningParam: ReasoningParam;
    };

export type ResearchProvider =
  | { kind: "openrouter"; apiKey: string; maxResults: number }
  | { kind: "custom"; connection: Connection; model: string };

const models = createModels();
models.setProvider(openrouterProvider());
models.setProvider(
  createProvider({
    id: "custom",
    name: "Custom",
    baseUrl: "",
    auth: { apiKey: envApiKeyAuth("Custom API key", []) },
    models: [],
    api: openAICompletionsApi(),
  }),
);

function openRouterModel() {
  const model = models.getModel("openrouter", config.model);
  if (!model) throw new Error(`Unknown model ${config.model}`);
  return model;
}

export function chatModel(p: ChatProvider): Model<"openai-completions"> {
  const base = openRouterModel() as Model<"openai-completions">;
  if (p.kind === "openrouter") return base;
  return {
    ...base,
    id: p.model,
    name: p.model,
    provider: "custom",
    baseUrl: p.connection.baseUrl,
    input: p.images ? ["text", "image"] : ["text"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: config.agent.maxOutputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // OpenAI itself takes pi's defaults; elsewhere stick to what nearly every compatible server accepts.
    compat:
      new URL(p.connection.baseUrl).host === "api.openai.com"
        ? undefined
        : {
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: "max_tokens",
          },
  };
}

export function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function connectionHeaders(c: Connection): Record<string, string> {
  const auth = !c.token
    ? {}
    : c.auth === "bearer"
      ? { authorization: `Bearer ${c.token}` }
      : c.auth === "header"
        ? { [c.authHeader]: c.token }
        : {};
  return { ...c.headers, ...auth };
}

/**
 * The OpenAI SDK always sends `Authorization: Bearer <apiKey>`; this replaces it with exactly the connection's
 * headers, so header-style and keyless APIs don't receive a bogus bearer token.
 */
function connectionFetch(c: Connection): typeof fetch {
  const own = connectionHeaders(c);
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    for (const [k, v] of Object.entries(own)) headers.set(k, v);
    return fetch(input, { ...init, headers });
  };
}

type Payload = {
  messages: { role: string; content: string | unknown[] }[];
  [k: string]: unknown;
};

type UsageChunk = { id?: string; usage?: { cost?: number } };

/** What one request was billed. Custom APIs usually don't report cost, so it is 0 for them. */
export type RequestUsage = { generationId: string | null; costUsd: number };

/**
 * Streams through the provider. The payload hook sets what pi has no per-request field for: the reasoning effort in
 * the provider's format, an output cap, and voice notes, which go on the first user message as `input_audio` parts
 * (OpenRouter only).
 */
export function providerStream(
  p: ChatProvider,
  effort: Effort,
  audio: Extract<Media, { kind: "audio" }>[],
  onUsage?: (usage: RequestUsage) => void,
): StreamFn {
  const custom = p.kind === "custom" ? p : null;
  return (model, context, options) =>
    models.streamSimple(model, context, {
      ...options,
      apiKey: p.kind === "openrouter" ? p.apiKey : "unused",
      headers: { ...options?.headers, ...(custom ? {} : { "x-title": TITLE }) },
      ...(custom ? { fetch: connectionFetch(custom.connection) } : {}),
      // Retries failures before streaming starts; a stream cut off midway is retried by the agent.
      maxRetries: 2,
      maxRetryDelayMs: 10_000,
      onPayload: (raw) => {
        const payload = raw as Payload;
        delete payload.reasoning;
        delete payload.reasoning_effort;
        const param = custom ? custom.reasoningParam : "reasoning";
        if (param === "reasoning") payload.reasoning = { effort };
        if (param === "reasoning_effort") payload.reasoning_effort = effort;
        if (!custom)
          payload.max_completion_tokens = config.agent.maxOutputTokens;
        const user = payload.messages.find((m) => m.role === "user");
        if (user && audio.length && !custom) {
          const parts =
            typeof user.content === "string"
              ? [{ type: "text", text: user.content }]
              : user.content;
          user.content = [
            ...parts,
            ...audio.map((a) => ({
              type: "input_audio",
              input_audio: { data: base64(a.data), format: a.format },
            })),
          ];
        }
        return payload;
      },
      onProviderStreamEvent:
        onUsage &&
        ((event) => {
          const chunk = event as UsageChunk;
          if (chunk.usage)
            onUsage({
              generationId: chunk.id ?? null,
              costUsd: chunk.usage.cost ?? 0,
            });
        }),
    });
}

export type Research = {
  answer: string;
  sources: string[];
  costUsd: number;
  generationId: string | null;
};

const RESEARCH_PROMPT =
  "You look up nutrition facts on the web. Reply in at most 6 short lines: the exact product found, " +
  "kcal, protein, carbs and fat per 100 g (or per serving, saying which), the usual pack or serving size, and the source. " +
  "Only report numbers you found in the search results. If nothing matches, start with NOT FOUND and name the closest comparable product with its numbers.";

type CompletionBody = {
  id?: string;
  error?: { code?: number; message?: string };
  choices?: {
    message?: {
      content?: string;
      annotations?: { url_citation?: { url?: string } }[];
    };
  }[];
  /** Perplexity-style source list. */
  citations?: string[];
  usage?: { cost?: number };
};

async function complete(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<CompletionBody> {
  let res: Response;
  try {
    res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ProviderError(0, e instanceof Error ? e.message : String(e));
  }
  const json = (await res.json().catch(() => ({}))) as CompletionBody;
  if (!res.ok || json.error) {
    const status =
      typeof json.error?.code === "number" ? json.error.code : res.status;
    throw new ProviderError(
      status,
      json.error?.message ?? `HTTP ${res.status}`,
    );
  }
  return json;
}

/**
 * One web-searched lookup in its own small request, so search results never enter the agent's context; the agent
 * only sees this short answer. OpenRouter adds search with its web plugin; a custom research model is expected to
 * search on its own.
 */
export async function researchFood(
  p: ResearchProvider,
  query: string,
  country: string | null,
): Promise<Research> {
  const messages = [
    { role: "system", content: RESEARCH_PROMPT },
    {
      role: "user",
      content: `Nutrition facts for: ${query}${country ? ` as sold in ${country}` : ""}`,
    },
  ];
  const body =
    p.kind === "openrouter"
      ? await complete(
          OPENROUTER,
          { authorization: `Bearer ${p.apiKey}`, "x-title": TITLE },
          {
            model: config.model,
            reasoning: { effort: config.research.effort },
            max_tokens: config.research.maxOutputTokens,
            plugins: [
              {
                id: "web",
                engine: config.research.engine,
                max_results: p.maxResults,
              },
            ],
            messages,
          },
          config.research.timeoutMs,
        )
      : await complete(
          p.connection.baseUrl,
          connectionHeaders(p.connection),
          {
            model: p.model,
            max_tokens: config.research.maxOutputTokens,
            messages,
          },
          config.research.timeoutMs,
        );
  const message = body.choices?.[0]?.message ?? {};
  const cited = (message.annotations ?? []).flatMap((a) =>
    a.url_citation?.url ? [a.url_citation.url] : [],
  );
  return {
    answer: String(message.content ?? "").trim(),
    sources: cited.length ? cited : (body.citations ?? []),
    costUsd: body.usage?.cost ?? 0,
    generationId: body.id ?? null,
  };
}

/** Sends a tiny request to check a custom provider's URL, credentials and model. */
export async function testConnection(
  c: Connection,
  model: string,
): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  try {
    const body = await complete(
      c.baseUrl,
      connectionHeaders(c),
      {
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the word OK." }],
      },
      20_000,
    );
    return {
      ok: true,
      reply: String(body.choices?.[0]?.message?.content ?? "").trim(),
    };
  } catch (e) {
    const err =
      e instanceof ProviderError ? e : new ProviderError(0, String(e));
    return {
      ok: false,
      error: err.status ? `HTTP ${err.status}: ${err.message}` : err.message,
    };
  }
}
