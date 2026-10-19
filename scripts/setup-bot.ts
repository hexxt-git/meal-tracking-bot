// Configures the Telegram bot profile and webhook. Run: bun run setup:bot (reads .env).
import { COMMAND_MENU } from "../supabase/functions/telegram-webhook/src/bot/menu.ts";

const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
const ref = Deno.env.get("SUPABASE_PROJECT_REF");
if (!token || !secret || !ref) throw new Error("TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and SUPABASE_PROJECT_REF are required");

async function call(method: string, body: Record<string, unknown> | FormData) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, body instanceof FormData
    ? { method: "POST", body }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  console.log(method, json.ok ? "ok" : json.description);
}

await call("setMyName", { name: "Meal Tracker" });
await call("setMyShortDescription", { short_description: "Log meals from a photo, text or voice note. Tracks calories and macros against your goals." });
await call("setMyDescription", {
  description: "Send a photo, a short description or a voice note of what you ate. Calories, protein, carbs and fat are estimated " +
    "and tracked against daily goals set from a short setup.\n\nUses your own OpenRouter API key, stored encrypted.\n\nTap Start to begin.",
});
await call("setMyCommands", { commands: COMMAND_MENU.map(([command, description]) => ({ command, description })) });

const photo = new FormData();
photo.set("photo", JSON.stringify({ type: "static", photo: "attach://avatar" }));
photo.set("avatar", new Blob([await Deno.readFile(new URL("../assets/avatar.jpg", import.meta.url))], { type: "image/jpeg" }), "avatar.jpg");
await call("setMyProfilePhoto", photo);

await call("setWebhook", {
  url: `https://${ref}.supabase.co/functions/v1/telegram-webhook`,
  secret_token: secret,
  allowed_updates: ["message", "callback_query", "my_chat_member"],
  drop_pending_updates: true,
});
