import "@supabase/functions-js/edge-runtime.d.ts";

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // verify_jwt is off for this function, so this header is the only thing proving the caller is Telegram.
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!WEBHOOK_SECRET || !timingSafeEqual(secret, WEBHOOK_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }

  const update = await req.json();
  console.log("update", update.update_id);

  // Always 200 so Telegram doesn't retry-storm on our own bugs.
  return new Response("ok");
});
