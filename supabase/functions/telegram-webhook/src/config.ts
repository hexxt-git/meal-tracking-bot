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
  albumSettleMs: 2500,
  recentMealsForContext: 3,
} as const;
