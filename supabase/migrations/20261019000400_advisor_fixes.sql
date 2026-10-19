-- Pin search_path on the remaining functions (security advisor: function_search_path_mutable).
alter function app.tg_id() set search_path = '';
alter function app.rate_limit_hit(text, int, interval) set search_path = '';
alter function app.assert_own_meal() set search_path = '';
alter function app.touch_updated_at() set search_path = '';

-- pg_net can't be moved with SET SCHEMA; recreate it outside public. Its functions always live in the `net` schema,
-- so the keepalive cron job keeps working.
drop extension if exists pg_net;
create extension pg_net schema extensions;

-- Covering indexes for FKs (cascade/set-null lookups); revisions are only ever fetched by primary key.
create index meal_revisions_tg_id on app.meal_revisions (tg_id);
create index users_fix_meal_id on app.users (fix_meal_id);
drop index app.meal_revisions_meal;
