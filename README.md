# Meal tracking bot

Telegram bot that logs meal photos + notes into Supabase. Runs entirely on Supabase Edge Functions (no server).
Nutrition estimates come from `google/gemini-3.8-flash` via OpenRouter, using each user's own API key.

## Setup

```sh
bun install
bunx supabase login
bunx supabase link --project-ref <ref>
cp supabase/.env.example supabase/.env   # fill in
bun run secrets:set
bun run db:push
bun run deploy
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url="https://<ref>.supabase.co/functions/v1/telegram-webhook" \
  -d secret_token="$TELEGRAM_WEBHOOK_SECRET"
```

## Security model

- The webhook has JWT verification off; requests are authenticated by Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
- All tables have RLS on and no grants to `anon`/`authenticated`; only the edge function (secret key) touches data.
