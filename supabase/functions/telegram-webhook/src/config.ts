function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

export const config = {
  telegramToken: env("TELEGRAM_BOT_TOKEN"),
  webhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),
  databaseUrl: env("SUPABASE_DB_URL"),
  model: "google/gemini-3.8-flash",
  reasoningEffort: "medium",
  limits: {
    messagesPerHour: 60,
    analysesPerDay: 300,
  },
  agent: {
    maxTurns: 8,
    timeoutMs: 120_000,
    /** "native" runs the model provider's own search (Google Search for Gemini); see README for cost. */
    searchEngine: "native",
    maxSearchesPerRequest: 2,
    /** Rounds of multiple-choice questions allowed before the assistant must decide on its own. */
    maxQuestions: 2,
    /** A question left unanswered this long is dropped and the next message starts fresh. */
    questionTtlMs: 6 * 3_600_000,
  },
  albumSettleMs: 2500,
} as const;
