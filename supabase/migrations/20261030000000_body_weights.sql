-- Weigh-ins, stored in kg with the unit the user gave. batch_id ties an entry to the assistant run that logged it, for Undo.
create table app.body_weights (
  id uuid primary key default gen_random_uuid(),
  tg_id bigint not null default app.tg_id() references app.users (tg_id) on delete cascade,
  weighed_at timestamptz not null default now(),
  weight_kg numeric(6, 3) not null check (weight_kg between 20 and 400),
  unit text not null default 'kg' check (unit in ('kg', 'lb')),
  batch_id uuid,
  source_message_id bigint,
  created_at timestamptz not null default now()
);

create index body_weights_user_time on app.body_weights (tg_id, weighed_at desc);

alter table app.body_weights enable row level security;
alter table app.body_weights force row level security;
revoke all on app.body_weights from public, anon, authenticated;
grant select, insert, update, delete on app.body_weights to bot_user;
create policy own_rows on app.body_weights as permissive for all to bot_user
  using (tg_id = app.tg_id()) with check (tg_id = app.tg_id());
