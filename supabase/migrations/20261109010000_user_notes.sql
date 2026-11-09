-- Durable facts the assistant keeps about a user (their own products, usual portions, preferences), shown to it on every run.
create table app.user_notes (
  id uuid primary key default gen_random_uuid(),
  tg_id bigint not null default app.tg_id() references app.users (tg_id) on delete cascade,
  text text not null check (length(text) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index user_notes_user on app.user_notes (tg_id, created_at);

alter table app.user_notes enable row level security;
alter table app.user_notes force row level security;
revoke all on app.user_notes from public, anon, authenticated;
grant select, insert, update, delete on app.user_notes to bot_user;
create policy own_rows on app.user_notes as permissive for all to bot_user
  using (tg_id = app.tg_id()) with check (tg_id = app.tg_id());
