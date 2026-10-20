-- Reminders after 12/18/24/48 h without a logged meal. The timer runs from the user's latest meal logged_at, so
-- logging anything restarts it; last_reminder_at records the latest one sent so each threshold goes out once.
alter table app.users
  add column reminders_enabled boolean not null default true,
  add column last_reminder_at timestamptz;

create index meals_user_logged on app.meals (tg_id, logged_at desc);

-- The function checks this header against its CRON_SECRET; the value lives in Vault as 'cron_secret'.
select cron.schedule('reminders', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://ytgudxgmriqyotqymqmx.supabase.co/functions/v1/telegram-webhook/reminders',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
$$);
