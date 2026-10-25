-- Per-user assistant settings (provider, research depth, reasoning effort, budget, reply detail) and the text field a
-- settings prompt is waiting for. Secrets for a custom provider are kept in Vault, not here.
alter table app.users add column ai_settings jsonb not null default '{}';
alter table app.users add column awaiting_input jsonb;

-- Custom provider credentials (token and extra headers, as JSON) live in Vault, named per user, reachable only through
-- these caller-scoped definer functions.
create function app.set_provider_secret(p_secret text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  uid bigint := app.tg_id();
  sid uuid;
begin
  if uid is null then raise exception 'no user context'; end if;
  select id into sid from vault.secrets where name = 'provider:' || uid;
  if sid is null then
    perform vault.create_secret(p_secret, 'provider:' || uid);
  else
    perform vault.update_secret(sid, p_secret);
  end if;
end $$;

create function app.get_provider_secret() returns text
language sql stable security definer
set search_path = ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = 'provider:' || app.tg_id() $$;

create function app.delete_provider_secret() returns void
language sql security definer
set search_path = ''
as $$ delete from vault.secrets where name = 'provider:' || app.tg_id() $$;

create or replace function app.delete_account() returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if app.tg_id() is null then raise exception 'no user context'; end if;
  delete from vault.secrets where name in ('openrouter:' || app.tg_id(), 'provider:' || app.tg_id());
  delete from app.rate_limits where tg_id = app.tg_id();
  delete from app.processed_updates where tg_id = app.tg_id();
  delete from app.media_group_items where tg_id = app.tg_id();
  delete from app.users where tg_id = app.tg_id();
end $$;

revoke all on function app.set_provider_secret(text) from public, anon, authenticated;
revoke all on function app.get_provider_secret() from public, anon, authenticated;
revoke all on function app.delete_provider_secret() from public, anon, authenticated;
grant execute on function app.set_provider_secret(text) to bot_user;
grant execute on function app.get_provider_secret() to bot_user;
grant execute on function app.delete_provider_secret() to bot_user;
