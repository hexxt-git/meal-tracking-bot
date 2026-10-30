// Imported first by tests that load bot modules: config reads these at import time. Nothing here reaches a real service.
for (const [name, value] of Object.entries({
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_WEBHOOK_SECRET: "test-secret",
  CRON_SECRET: "test-cron",
  SUPABASE_DB_URL: "postgres://user:pass@127.0.0.1:1/test",
}))
  if (!Deno.env.get(name)) Deno.env.set(name, value);

export type TelegramCall = { method: string; body: Record<string, unknown> };

/** Telegram API calls made since the last `resetTelegram()`. */
export const telegramCalls: TelegramCall[] = [];
export const resetTelegram = () => void (telegramCalls.length = 0);

/** Answers requests to any other host; tests that talk to a fake model API set it. */
export let externalFetch: typeof fetch | null = null;
export const setExternalFetch = (f: typeof fetch | null) =>
  void (externalFetch = f);

globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const m = url.match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/);
  if (!m) {
    if (externalFetch) return externalFetch(input, init);
    throw new Error(`Unexpected fetch in a test: ${url}`);
  }
  const body =
    typeof init?.body === "string" ? JSON.parse(init.body) : { form: true };
  telegramCalls.push({ method: m[1], body });
  return Promise.resolve(
    new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: 1000 + telegramCalls.length },
      }),
    ),
  );
};
