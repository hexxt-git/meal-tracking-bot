# Meal Tracker

A Telegram bot ([@mmeal_tracking_bot](https://t.me/mmeal_tracking_bot)) that logs meals from photos, text and voice notes,
estimates calories and macros, and tracks them against personal daily goals.

It runs entirely on Supabase, with one Edge Function plus Postgres and no other server. Meal analysis uses
`google/gemini-3.8-flash` (reasoning effort: medium) through OpenRouter, and each user pays for their own usage with
their own API key.

## Using the bot

1. **Start**: paste an OpenRouter API key into the chat. The key is checked, stored encrypted and the message is deleted.
2. **Setup** (optional, about a minute, all buttons): units, sex, age, height, weight, activity, goal and pace, then
   timezone (picked by current clock time). Daily goals are computed with Mifflin-St Jeor. Protein is 1.8 g/kg (2.0 when
   cutting), fat is 25% of calories and carbs are the rest.
3. **Log**: send a photo (or an album), a description or a voice note. The reply shows the items, the totals and today's
   progress, with **Undo**, **Fix** and **Today** buttons. Corrections like "that was 2 eggs, not 3" update one of the
   last three meals instead of adding a new one. Times work the same way: "had eggs at 8am" logs the meal at 08:00,
   and "I had it this morning at 10AM" moves the last meal to 10:00. The model gets the current local time (the moment
   the message was sent) and resolves relative times against it. Each meal keeps both its eaten and logged time.
4. **Browse**: the bottom keyboard opens **Today**, **History** and **Menu**:
   - **Day view**: progress bars and a tappable meal list; step back through previous days.
   - **Week**: a 7-day chart.
   - **History**: older meals, page by page.
   - **Meal**: item table, with Delete and Undo.
   - **Goals**: steppers per value, or recalculate from your profile.
   - **Profile**, **Settings** (units, timezone, API key, delete account) and CSV export.

The bot works in private chats only and leaves any group it's added to.

## Architecture

```
Telegram ──webhook──▶ Edge Function `telegram-webhook` ──direct Postgres──▶ app schema (RLS)
                         │  verifies secret header, acks at once,             │
                         │  handles the update in the background              ├─ Vault (OpenRouter keys)
                         └──────────────▶ OpenRouter (user's key)             └─ pg_cron: cleanup, keepalive
```

```
supabase/
  config.toml
  migrations/                      schema, RLS, grants, Vault functions, cron jobs (source of truth for the DB)
  functions/telegram-webhook/
    index.ts                       HTTP entry: /health, webhook auth, background dispatch
    src/
      config.ts                    env vars and tunables (model, limits)
      domain/                      pure logic: nutrition math, setup steps and steppers, goals, time/day math
      db/                          all database access (Drizzle)
        client.ts                  connection; `userRunner` scopes each transaction to one Telegram user
        schema.ts                  typed mirror of the migrations
        repos/                     users, meals (+ undo revisions), keys (Vault), limits, albums
      services/                    OpenRouter client, prompt and response schema
      telegram/                    Bot API adapter and types
      bot/
        router.ts                  update → command / button / key / meal
        commands.ts, callbacks.ts  slash commands and button handlers (callback data `kind:arg:…`)
        meals.ts                   meal logging flow (albums, media download, AI decision, create/edit)
        ui.ts, format.ts           view type, buttons, aligned tables, progress bars
        screens/                   panels: journal, onboarding, goals, account/settings, timezone picker
    tests/                         Deno tests for the domain logic
scripts/setup-bot.ts               sets bot name, descriptions, commands, avatar and webhook
assets/                            bot avatar (SVG source + JPG upload)
```

Panels are edited in place: every button press re-renders the message it belongs to instead of sending a new one.
All SQL lives in `src/db/`; handlers only call typed repository methods.

## Security model

- **Webhook auth**: JWT verification is off for the function (Telegram can't send a Supabase key), so every POST must
  carry the `X-Telegram-Bot-Api-Secret-Token` set via `setWebhook`, compared in constant time.
- **No public data API**: tables live in the `app` schema, which PostgREST doesn't expose, and `anon`/`authenticated`
  have no grants on anything in `app` or `public`.
- **Per-user RLS**: the function connects as `postgres` but runs every transaction as `set local role bot_user` with
  `app.tg_id` set to the sender. RLS is forced on every table, so `bot_user` only sees rows where
  `tg_id = app.tg_id()`. A handler bug can't read or write another user's rows, and forged button data (another user's
  meal id, for example) simply matches nothing.
- **API keys**: stored in Supabase Vault and reachable only through `security definer` functions that read or write the
  caller's own secret. Database dumps contain only ciphertext.
- **Abuse limits**: 60 updates per user per hour and 300 AI analyses per user per day, counted in Postgres. Telegram
  retries are deduplicated by `update_id`.

## Data model (`app` schema)

| Table | Purpose |
|---|---|
| `users` | Telegram id, chat id, setup step, profile, timezone offset, daily goals, pending Fix target |
| `meals` | `eaten_at` (when it was eaten, settable by the AI), `logged_at` (when the message was sent), title, AI item breakdown (JSON), totals, Telegram photo file ids, the user's text |
| `meal_revisions` | snapshot before each create/edit/delete, for Undo (kept 30 days) |
| `processed_updates` | Telegram update ids, for deduplication (kept 3 days) |
| `rate_limits` | per-user fixed-window counters (kept 2 days) |
| `media_group_items` | album photos waiting to be processed together (kept 1 day) |

Photos aren't stored; only Telegram `file_id`s are kept.

## Configuration

| File | Used by | Contents |
|---|---|---|
| `.env` (from `.env.example`) | your machine: CLI, `setup:bot` | project ref, DB password, bot token, webhook secret |
| `supabase/.env` (from `supabase/.env.example`) | `secrets:set` → function env | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` |

`SUPABASE_DB_URL` is provided to the function by Supabase automatically. Both `.env` files are git-ignored.

## Deploying from scratch

```sh
bun install
bunx supabase login
bunx supabase link --project-ref <ref>
cp .env.example .env && cp supabase/.env.example supabase/.env      # fill in; secret: openssl rand -hex 32
bun run secrets:set
bun run db:push
bun run deploy
bun run setup:bot
```

If your network blocks Postgres ports (5432/6543), `db:push` can't connect. Run each migration through the Management
API instead (`POST https://api.supabase.com/v1/projects/<ref>/database/query` with your CLI access token), then record
it in `supabase_migrations.schema_migrations`.

In BotFather, set **/setjoingroups → Disable** so the bot can't be added to groups at all.

## Development

```sh
bun run test     # Deno tests (domain logic)
bun run check    # type check + lint
bun run deploy   # redeploy the function
```

## Operations

- **Health**: `GET /functions/v1/telegram-webhook/health` runs a real query and returns `ok`.
- **Keepalive**: free projects pause after about a week without database activity. cron-job.org hits `/health` every
  hour, and a `pg_cron` job (`keepalive`) does the same every 6 hours as a backup.
- **Cleanup**: the `app-cleanup` cron job runs nightly at 03:17 UTC and trims the bookkeeping tables listed above.
- **Free tier**: 500 MB database and 500k function invocations a month. One user logging 10 meals a day uses about
  300 invocations a month.
- **AI cost**: paid by each user on OpenRouter, about $0.01 per photo with Gemini 3.8 Flash (≈ $2–4/month at 10 a day).
