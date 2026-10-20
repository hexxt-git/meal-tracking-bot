-- Deployment settings that aren't secrets, read by the cron jobs. Each deployment sets its own:
--   insert into app.config (key, value) values ('functions_url', 'https://<project-ref>.supabase.co/functions/v1');
create table app.config (
  key text primary key,
  value text not null
);

-- Only the postgres role (which runs the cron jobs) reads it; the bot's role has no access.
alter table app.config enable row level security;
alter table app.config force row level security;
revoke all on app.config from public, anon, authenticated;

-- Until functions_url is set, both jobs select no row and make no request.
select cron.schedule('keepalive', '41 */6 * * *', $$
  select net.http_get(value || '/telegram-webhook/health') from app.config where key = 'functions_url';
$$);

select cron.schedule('reminders', '*/15 * * * *', $$
  select net.http_post(
    url := value || '/telegram-webhook/reminders',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  from app.config where key = 'functions_url';
$$);
