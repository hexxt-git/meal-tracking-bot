-- Telegram edits only carry the new text, so the original is kept here, along with the undo batches of the
-- replies it produced (which tell which meals it logged or changed).
create table app.chat_messages (
  tg_id bigint not null default app.tg_id() references app.users (tg_id) on delete cascade,
  message_id bigint not null,
  text text not null default '',
  sent_at timestamptz not null,
  batch_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (tg_id, message_id)
);

alter table app.chat_messages enable row level security;
alter table app.chat_messages force row level security;
revoke all on app.chat_messages from public, anon, authenticated;
grant select, insert, update, delete on app.chat_messages to bot_user;
create policy own_rows on app.chat_messages as permissive for all to bot_user
  using (tg_id = app.tg_id()) with check (tg_id = app.tg_id());

select cron.alter_job(
  (select jobid from cron.job where jobname = 'app-cleanup'),
  command := $$
    delete from app.processed_updates where created_at < now() - interval '3 days';
    delete from app.rate_limits where window_start < now() - interval '2 days';
    delete from app.media_group_items where created_at < now() - interval '1 day';
    delete from app.meal_revisions where created_at < now() - interval '30 days';
    delete from app.chat_messages where created_at < now() - interval '3 days';
  $$
);
