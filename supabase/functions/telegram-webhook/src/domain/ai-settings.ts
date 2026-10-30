export const EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export const RESEARCH_DEPTHS = ["off", "quick", "standard", "deep"] as const;
export type ResearchDepth = (typeof RESEARCH_DEPTHS)[number];

export const REPLY_DETAILS = ["short", "normal", "detailed"] as const;
export type ReplyDetail = (typeof REPLY_DETAILS)[number];

/** USD per UTC day; null is no limit. */
export const BUDGETS = [0.1, 0.2, 0.5, 1, null] as const;

export const AUTH_STYLES = ["bearer", "header", "none"] as const;
/** `bearer`: Authorization: Bearer <token>. `header`: <authHeader>: <token>. */
export type AuthStyle = (typeof AUTH_STYLES)[number];

export const REASONING_PARAMS = [
  "none",
  "reasoning_effort",
  "reasoning",
] as const;
/** How the effort is sent: not at all, OpenAI's `reasoning_effort`, or OpenRouter-style `reasoning: { effort }`. */
export type ReasoningParam = (typeof REASONING_PARAMS)[number];

/** The non-secret part of a custom OpenAI-compatible provider; the token and extra headers are kept in Vault. */
export type CustomProvider = {
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  auth: AuthStyle;
  authHeader: string;
  images: boolean;
  reasoningParam: ReasoningParam;
  /** A model on the same API that can search the web, used for research_food instead of OpenRouter. */
  researchModel: string | null;
};

export type AiSettings = {
  effort: Effort;
  researchDepth: ResearchDepth;
  dailyBudgetUsd: number | null;
  replyDetail: ReplyDetail;
  custom: CustomProvider;
};

export type ProviderSecret = {
  token: string | null;
  headers: Record<string, string>;
};

export const DEFAULT_SETTINGS: AiSettings = {
  effort: "minimal",
  researchDepth: "standard",
  dailyBudgetUsd: 0.2,
  replyDetail: "normal",
  custom: {
    enabled: false,
    baseUrl: null,
    model: null,
    auth: "bearer",
    authHeader: "api-key",
    images: true,
    reasoningParam: "none",
    researchModel: null,
  },
};

/** Stored settings over the defaults, so settings added later get their default for existing users. */
export function aiSettings(stored: unknown): AiSettings {
  const s = (stored ?? {}) as Partial<AiSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    custom: { ...DEFAULT_SETTINGS.custom, ...s.custom },
  };
}

/** Lookups per message and search results per lookup. */
export const RESEARCH: Record<
  ResearchDepth,
  { lookups: number; results: number }
> = {
  off: { lookups: 0, results: 0 },
  quick: { lookups: 1, results: 3 },
  standard: { lookups: 2, results: 3 },
  deep: { lookups: 4, results: 5 },
};

/** Research is switched off once the day's spend passes this share of the budget, so logging stays within it. */
export const RESEARCH_CUTOFF_SHARE = 0.6;

export const isCustomReady = (c: CustomProvider) =>
  c.baseUrl != null && c.model != null;

const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|\[.*\])$/i;

/**
 * Normalizes a base URL such as `https://api.example.com/v1` (a pasted `/chat/completions` endpoint is trimmed to its
 * base). Only public https hosts: the request is made from the server, so local and private addresses are refused.
 * Returns an error message for anything else.
 */
export function parseBaseUrl(
  input: string,
): { url: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return {
      error:
        "That isn't a valid URL. Send something like https://api.example.com/v1",
    };
  }
  if (u.protocol !== "https:")
    return { error: "The URL must start with https://" };
  if (u.username || u.password)
    return { error: "Put credentials in the token, not in the URL." };
  // A trailing dot is the same host to DNS ("localhost." is localhost).
  if (PRIVATE_HOST.test(u.hostname.replace(/\.+$/, "")))
    return {
      error:
        "Local and private network addresses can't be reached from the bot's server.",
    };
  const path = u.pathname
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "");
  return { url: `${u.origin}${path}` };
}

export function parseModelId(input: string): string | null {
  const s = input.trim();
  return s.length > 0 && s.length <= 200 && !/\s/.test(s) ? s : null;
}

const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "accept-encoding",
]);

export const isHeaderName = (s: string) =>
  HEADER_NAME.test(s) && !RESERVED_HEADERS.has(s.toLowerCase());

/** `Name: value` per line, at most 10. */
export function parseHeaders(
  input: string,
): { headers: Record<string, string> } | { error: string } {
  const lines = input
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 10) return { error: "At most 10 headers." };
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf(":");
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (i < 1 || !isHeaderName(name) || !value || value.length > 2000) {
      return {
        error: `Couldn't read "${line.slice(0, 40)}". Use one "Name: value" per line.`,
      };
    }
    headers[name] = value;
  }
  return { headers };
}

/** Settings that are typed into the chat rather than picked with buttons. */
export const INPUT_FIELDS = [
  "url",
  "model",
  "token",
  "authHeader",
  "headers",
  "researchModel",
] as const;
export type InputField = (typeof INPUT_FIELDS)[number];

export type AwaitingInput = { field: InputField; at: string };

/** An unanswered prompt stops capturing text after this long, so a later meal message isn't taken as a setting. */
export const INPUT_TTL_MS = 10 * 60_000;

export const isAwaiting = (
  a: AwaitingInput | null,
  now: number,
): a is AwaitingInput => a != null && now - Date.parse(a.at) < INPUT_TTL_MS;
