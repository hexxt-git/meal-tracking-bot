-- chat_messages also holds the assistant's replies, so the last few exchanges can be given back to it as context.
alter table app.chat_messages
  add column role text not null default 'user' check (role in ('user', 'assistant')),
  add column attachments text[] not null default '{}';

create index chat_messages_recent on app.chat_messages (tg_id, created_at desc);

-- The newest 10 rows per user are kept regardless of age, so a conversation can be picked up after a quiet spell.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'app-cleanup'),
  command := $$
    delete from app.processed_updates where created_at < now() - interval '3 days';
    delete from app.rate_limits where window_start < now() - interval '2 days';
    delete from app.media_group_items where created_at < now() - interval '1 day';
    delete from app.meal_revisions where created_at < now() - interval '30 days';
    delete from app.chat_messages c
    where c.created_at < now() - interval '3 days'
      and c.message_id not in (
        select message_id from app.chat_messages r where r.tg_id = c.tg_id order by created_at desc limit 10
      );
  $$
);
