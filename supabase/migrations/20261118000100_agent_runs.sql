-- One row per assistant run, for debugging after function logs expire. Inserted when the run starts and updated when
-- it ends, so a run whose function was killed shows up with no finished_at.
create table app.agent_runs (
  id uuid primary key,
  tg_id bigint not null default app.tg_id() references app.users (tg_id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- ok | error | timed_out | superseded | media_unavailable | failed
  outcome text,
  message_ids bigint[] not null default '{}',
  photo_file_ids text[] not null default '{}',
  audio_file_ids text[] not null default '{}',
  -- Set when the run was a retry of a request waiting for Telegram to deliver its media.
  media_until timestamptz,
  media_ms integer,
  model text,
  turns integer,
  searches integer,
  cost_usd numeric,
  generation_ids text[] not null default '{}',
  error text,
  trace text[] not null default '{}'
);

create index agent_runs_user on app.agent_runs (tg_id, started_at desc);

alter table app.agent_runs enable row level security;
alter table app.agent_runs force row level security;
revoke all on app.agent_runs from public, anon, authenticated;
grant select, insert, update on app.agent_runs to bot_user;
create policy own_rows on app.agent_runs as permissive for all to bot_user
  using (tg_id = app.tg_id()) with check (tg_id = app.tg_id());

select cron.alter_job(
  (select jobid from cron.job where jobname = 'app-cleanup'),
  command := $$
    delete from app.processed_updates where created_at < now() - interval '3 days';
    delete from app.rate_limits where window_start < now() - interval '2 days';
    delete from app.media_group_items where created_at < now() - interval '1 day';
    delete from app.meal_revisions where created_at < now() - interval '30 days';
    delete from app.agent_runs where started_at < now() - interval '30 days';
    delete from app.chat_messages c
    where c.created_at < now() - interval '14 days'
      and c.message_id not in (
        select message_id from app.chat_messages r where r.tg_id = c.tg_id order by created_at desc limit 10
      );
  $$
);
