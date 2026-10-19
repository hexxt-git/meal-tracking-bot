-- Free projects pause after ~a week without activity; this pings the function's health endpoint, which runs a real query.
create extension if not exists pg_net;

select cron.schedule('keepalive', '41 */6 * * *', $$
  select net.http_get('https://ytgudxgmriqyotqymqmx.supabase.co/functions/v1/telegram-webhook/health');
$$);
