# Meal Tracker

A Telegram bot ([@mmeal_tracking_bot](https://t.me/mmeal_tracking_bot)) that logs meals from photos, text and voice notes,
estimates calories and macros, and tracks them against personal daily goals.

It runs entirely on Supabase, with one Edge Function plus Postgres and no other server. Messages are handled by a
tool-calling agent ([pi](https://github.com/earendil-works/pi) agent loop) on `google/gemini-3.8-flash` (minimal
reasoning effort) through OpenRouter. It can research food on the web, and each user pays for their own usage with
their own API key, within a daily budget of $0.10.

## Using the bot

1. **Start**: paste an OpenRouter API key into the chat. The key is checked, stored encrypted and the message is deleted.
2. **Setup** (optional, about a minute, all buttons): units, sex, age, height, weight, activity, goal and pace, then
   timezone (picked by current clock time) and country (picked by first letter). Daily goals are computed with
   Mifflin-St Jeor. Protein is 1.8 g/kg (2.0 when cutting), fat is 25% of calories and carbs are the rest.
3. **Log**: send a photo (or an album), a description or a voice note. The assistant decides what the message is: new
   meals, a correction to a logged meal ("that was 2 eggs, not 3", "I had it this morning at 10AM"), or a question
   ("how much protein is left today?"). The reply shows every meal it logged, updated or deleted, the totals and today's
   progress, with **Undo** (reverts everything that reply changed), **Fix** and **Today** buttons. **Fix** only tells
   the assistant which meal your next message is about.
   - **Research**: before logging branded, packaged or restaurant food the assistant must look up its nutrition data
     online (a readable label in the photo counts), preferring products sold in your country.
   - **Questions**: when an unknown would swing the estimate a lot (how much of a shared bag you ate, say), it asks
     one multiple-choice question as buttons. Tap an answer or type one. At most two rounds per message.
   - **Times**: the assistant gets the moment the message was sent, in your timezone, and resolves "this morning at
     10" or "yesterday's dinner" against it. Each meal keeps both its eaten and logged time.
4. **Browse**: the bottom keyboard opens **Today**, **History** and **Menu**:
   - **Day view**: progress bars and a tappable meal list; step back through previous days.
   - **Week**: a 7-day chart.
   - **History**: older meals, page by page.
   - **Meal**: item table, with Delete and Undo.
   - **Goals**: steppers per value, or recalculate from your profile.
   - **Profile**, **Settings** (units, timezone, country, API key, delete account).
   - **Export CSV** / **Import CSV**: send back a file in the export format to import it. Meals already in the log are
     skipped and the import can be undone.

The bot works in private chats only and leaves any group it's added to.

## Architecture

```
Telegram ──webhook──▶ Edge Function `telegram-webhook` ──direct Postgres──▶ app schema (RLS)
                         │  verifies secret header, acks at once,             │
                         │  handles the update in the background              ├─ Vault (OpenRouter keys)
                         └──────────────▶ OpenRouter (user's key)             └─ pg_cron: cleanup, keepalive
                                          Gemini, plus Exa web search for research
```

```
supabase/
  config.toml
  migrations/                      schema, RLS, grants, Vault functions, cron jobs (source of truth for the DB)
  functions/telegram-webhook/
    index.ts                       HTTP entry: /health, webhook auth, background dispatch
    src/
      config.ts                    env vars and tunables (model, limits)
      domain/                      pure logic: nutrition math, setup steps and steppers, goals, time/day math,
                                   countries, CSV format, pending questions
      agent/                       the assistant: system prompt, meal tools, agent run (pi agent loop)
      db/                          all database access (Drizzle)
        client.ts                  connection; `userRunner` scopes each transaction to one Telegram user
        schema.ts                  typed mirror of the migrations
        repos/                     users, meals (+ undo revisions), keys (Vault), limits, albums
      services/                    OpenRouter: model, streaming (effort, audio, cost), food research, key checks
      telegram/                    Bot API adapter and types
      bot/
        router.ts                  update → command / button / key / meal
        commands.ts, callbacks.ts  slash commands and button handlers (callback data `kind:arg:…`)
        assistant.ts               message → agent run (albums, media download, questions, reply rendering)
        ui.ts, format.ts           view type, buttons, aligned tables, progress bars
        screens/                   panels: journal (+ CSV), onboarding, goals, account/settings, timezone and country pickers
    tests/                         Deno tests for the domain logic and the agent's change tracking
scripts/setup-bot.ts               sets bot name, descriptions, commands, avatar and webhook
assets/                            bot avatar (SVG source + JPG upload)
```

Panels are edited in place: every button press re-renders the message it belongs to instead of sending a new one.
All SQL lives in `src/db/`; handlers and agent tools only call typed repository methods.

## The assistant

Each message starts one agent run (`src/agent/`). The model gets the current local time, the user's country, units and
targets, and the meals logged in the last 24 hours. It works through these tools in as many turns as it needs (up to
6, 90 seconds at most):

| Tool | Does |
|---|---|
| `log_meal` | records a new meal with its item breakdown and optional eaten time |
| `update_meal` / `delete_meal` | changes a meal logged in the last 24 h (older meals are read-only) |
| `read_meals` | reads meals eaten in the last 7 days |
| `research_food` | one web-searched lookup (Exa via OpenRouter) in its own small request; only the short answer enters the agent's context. At most 2 per message |
| `view_photos` | shows the photos again; they are attached to the first request only |
| `ask_user` | asks a multiple-choice question and ends the run; the answer re-runs it with the Q&A in context |
| `reply` | the final message; called in the same turn as the last change, so simple messages take one request |

Every write in a run shares one undo batch. The function logs each tool call, each request's billed cost and its
OpenRouter generation id (look one up for free with `GET https://openrouter.ai/api/v1/generation?id=…`).

### Cost

Measured on the test photos (billed by OpenRouter):

| Message | Requests | Cost |
|---|---|---|
| Photo of a home-made or unbranded meal | 1 | $0.0055 |
| Text correction ("I had it at 10am") | 1 | $0.003 |
| Question, then the answer | 1 + 1 | $0.0017 + $0.0019 |
| Photo of two branded products, both researched | 2 + 2 research | $0.029 at low effort (research $0.0088 each) |

Reasoning tokens are most of a request's cost: the same photo cost $0.0125 at medium effort, $0.011 at low and
$0.0055 at minimal, with similar estimates. Google's native search through OpenRouter measured $0.085 per search,
so research uses Exa instead. Products already logged in the last day are reused instead of researched again.

A typical day of 7 meal photos, 2 new branded products and a correction comes to about $0.08. Two guards keep
every user under `config.budget.dailyUsd` ($0.10): research is switched off once the day passes $0.06, and requests
stop at $0.10 until midnight UTC. Daily totals are stored in `app.ai_usage`.

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
| `users` | Telegram id, chat id, setup step, profile, timezone offset, country, daily goals, Fix target, open question |
| `meals` | `eaten_at` (when it was eaten, settable by the AI), `logged_at` (when the message was sent), title, AI item breakdown (JSON), totals, Telegram photo file ids, the user's text |
| `meal_revisions` | snapshot before each create/edit/delete, grouped by `batch_id`, for Undo (kept 30 days) |
| `processed_updates` | Telegram update ids, for deduplication (kept 3 days) |
| `rate_limits` | per-user fixed-window counters (kept 2 days) |
| `ai_usage` | billed OpenRouter cost, runs and research lookups per user per UTC day |
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
- **AI cost**: paid by each user on OpenRouter, capped at $0.10 a day per user (see [Cost](#cost)).
- **Logs**: `GET /v1/projects/<ref>/analytics/endpoints/logs` with
  `sql=select timestamp, event_message from logs where source = 'function_logs' order by timestamp desc limit 50`.
