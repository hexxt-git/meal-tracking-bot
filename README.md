# Meal Tracker bot

Telegram bot ([@mmeal_tracking_bot](https://t.me/mmeal_tracking_bot)) that logs meals from photos, text and voice notes.
Runs entirely on Supabase (one Edge Function + Postgres); there's no separate server. Nutrition estimates come from `google/gemini-3.8-flash`
(reasoning effort: medium) via OpenRouter, using each user's own API key.

## Layout

```
supabase/
  migrations/                 DDL, RLS policies, grants, Vault functions (source of truth for the schema)
  functions/telegram-webhook/
    index.ts                  HTTP entry: verifies Telegram's secret header, acks, processes in background
    src/
      config.ts               env + tunables (model, limits)
      domain/                 pure logic: nutrition math, onboarding steps and steppers, goals, time/day math
      db/                     all database access
        client.ts             drizzle client; `userRunner` runs each transaction as `bot_user` for one tg user
        schema.ts             typed mirror of the migrations
        repos/                users, meals (+ undo revisions), keys (Vault), limits, albums
      services/               OpenRouter client + prompt/schema
      telegram/               Bot API adapter and types
      bot/                    router, commands, callbacks, meal logging, UI kit (ui.ts, format.ts)
        screens/              button-driven panels: journal, onboarding, goals, account/settings, timezone picker
    tests/                    deno tests for domain logic
scripts/setup-bot.ts          sets bot name/description/commands/avatar and the webhook
```

## Security model

- The webhook has JWT verification off; requests are authenticated by Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
- Data lives in the `app` schema, which the Data API doesn't expose; `anon`/`authenticated` have no grants on anything.
- The function connects to Postgres directly, and every transaction runs `set local role bot_user` with `app.tg_id` set.
  RLS (forced) limits `bot_user` to that Telegram user's rows, so a handler bug can't read or write another user's data.
- OpenRouter keys are stored in Supabase Vault and are reachable only through `security definer` functions that return
  the caller's own key. The message containing the key is deleted from the chat.
- Per-user rate limits (messages per hour, AI analyses per day) are tracked in Postgres.

## Setup

```sh
bun install
bunx supabase login && bunx supabase link --project-ref <ref>
cp supabase/.env.example supabase/.env   # bot token + random webhook secret
bun run secrets:set
bun run db:push
bun run deploy
bun run setup:bot                        # needs TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, SUPABASE_PROJECT_REF in .env
```

`bun run test` / `bun run check` run the Deno tests, type check and lint.
