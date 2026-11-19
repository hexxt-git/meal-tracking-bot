import { config } from "./src/config.ts";
import { retryMediaWaits } from "./src/bot/media-waits.ts";
import { sendReminders } from "./src/bot/reminders.ts";
import { handleUpdate } from "./src/bot/router.ts";
import { ping } from "./src/db/index.ts";
import type { Update } from "./src/telegram/types.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/health")) {
    await ping();
    return new Response("ok");
  }
  if (req.method !== "POST")
    return new Response("method not allowed", { status: 405 });

  const path = new URL(req.url).pathname;
  if (path.endsWith("/reminders") || path.endsWith("/photo-waits")) {
    if (
      !timingSafeEqual(
        req.headers.get("x-cron-secret") ?? "",
        config.cronSecret,
      )
    )
      return new Response("unauthorized", { status: 401 });
    if (path.endsWith("/reminders"))
      return Response.json({ sent: await sendReminders() });
    // A retry can run the whole assistant, far past the cron request's timeout.
    EdgeRuntime.waitUntil(
      retryMediaWaits().catch((e) => console.error("photo-waits", e)),
    );
    return new Response("ok");
  }

  // verify_jwt is off for this function, so this header is the only thing proving the caller is Telegram.
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!timingSafeEqual(secret, config.webhookSecret))
    return new Response("unauthorized", { status: 401 });

  const update: Update = await req.json();
  // Ack immediately; AI calls can outlast Telegram's webhook timeout and would trigger redeliveries.
  EdgeRuntime.waitUntil(
    handleUpdate(update).catch((e) =>
      console.error("update", update.update_id, e),
    ),
  );
  return new Response("ok");
});
