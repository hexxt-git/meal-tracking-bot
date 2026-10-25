function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

export const config = {
  telegramToken: env("TELEGRAM_BOT_TOKEN"),
  webhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),
  /** Sent by the pg_cron job that triggers reminders; also stored in Vault as 'cron_secret'. */
  cronSecret: env("CRON_SECRET"),
  databaseUrl: env("SUPABASE_DB_URL"),
  model: "google/gemini-3.8-flash",
  limits: {
    messagesPerHour: 60,
    analysesPerDay: 300,
  },
  agent: {
    maxOutputTokens: 6000,
    maxTurns: 6,
    timeoutMs: 90_000,
    /** Once a run's billed cost passes this, research is refused; the run can still log and reply. */
    maxRunCostUsd: 0.04,
    /** Requests whose stream fails with a transient error (dropped connection, 5xx, 429) are re-sent this many times. */
    transientRetries: 1,
    /** view_image calls per message; each sends one photo to the model again (about $0.001). */
    maxImageViews: 3,
    /** Earlier messages (both sides, text only) given to the assistant, however old. */
    historyMessages: 10,
    /** Rounds of multiple-choice questions allowed before the assistant must decide on its own. */
    maxQuestions: 2,
    /** A question left unanswered this long is dropped and the next message starts fresh. */
    questionTtlMs: 6 * 3_600_000,
  },
  research: {
    /** OpenRouter search engine. "native" (Google Search for Gemini) measured $0.085 per search, too much for the budget. */
    engine: "exa",
    effort: "minimal",
    timeoutMs: 45_000,
    maxOutputTokens: 800,
  },
  albumSettleMs: 2500,
} as const;
