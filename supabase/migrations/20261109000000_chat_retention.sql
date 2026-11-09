-- Keeps two weeks of chat so a run's context and later reviews can see what was said.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'app-cleanup'),
  command := $$
    delete from app.processed_updates where created_at < now() - interval '3 days';
    delete from app.rate_limits where window_start < now() - interval '2 days';
    delete from app.media_group_items where created_at < now() - interval '1 day';
    delete from app.meal_revisions where created_at < now() - interval '30 days';
    delete from app.chat_messages c
    where c.created_at < now() - interval '14 days'
      and c.message_id not in (
        select message_id from app.chat_messages r where r.tg_id = c.tg_id order by created_at desc limit 10
      );
  $$
);
