-- What each user's OpenRouter key was billed per UTC day, so the assistant can stay within a daily budget.
create table app.ai_usage (
  tg_id bigint not null default app.tg_id() references app.users (tg_id) on delete cascade,
  day date not null default (now() at time zone 'utc')::date,
  cost_usd numeric(10, 6) not null default 0,
  runs int not null default 0,
  searches int not null default 0,
  primary key (tg_id, day)
);

alter table app.ai_usage enable row level security;
alter table app.ai_usage force row level security;
revoke all on app.ai_usage from public, anon, authenticated;
grant select, insert, update, delete on app.ai_usage to bot_user;
create policy own_rows on app.ai_usage as permissive for all to bot_user
  using (tg_id = app.tg_id()) with check (tg_id = app.tg_id());
