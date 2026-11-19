-- A request whose photos or voice note Telegram wouldn't deliver. The photo-waits job retries it until `until`.
alter table app.users add column photo_wait jsonb;

-- Every 20 s, but only while some request is waiting, so an idle bot makes no calls.
select cron.schedule('photo-waits', '20 seconds', $$
  select net.http_post(
    url := value || '/telegram-webhook/photo-waits',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  )
  from app.config
  where key = 'functions_url' and exists (select 1 from app.users where photo_wait is not null);
$$);
