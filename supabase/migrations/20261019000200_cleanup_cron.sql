-- Bookkeeping rows are only useful briefly: Telegram retries for ~24h, rate windows are at most a day, albums settle in seconds.
create extension if not exists pg_cron;

select cron.schedule('app-cleanup', '17 3 * * *', $$
  delete from app.processed_updates where created_at < now() - interval '3 days';
  delete from app.rate_limits where window_start < now() - interval '2 days';
  delete from app.media_group_items where created_at < now() - interval '1 day';
  delete from app.meal_revisions where created_at < now() - interval '30 days';
$$);
