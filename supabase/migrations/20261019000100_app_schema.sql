-- Bot data lives in a schema the Data API does not expose. The edge function connects to Postgres directly
-- and runs every user-scoped transaction as `bot_user` with `app.tg_id` set, so RLS confines it to one Telegram user.

create schema app;
revoke all on schema app from public, anon, authenticated;

create role bot_user nologin noinherit;
grant bot_user to postgres;
grant usage on schema app to bot_user;

create function app.tg_id() returns bigint
language sql stable
as $$ select nullif(current_setting('app.tg_id', true), '')::bigint $$;

revoke all on function app.tg_id() from public;
grant execute on function app.tg_id() to bot_user;

create table app.users (
  tg_id bigint primary key,
  chat_id bigint not null,
  first_name text,
  onboarding_step text not null default 'key',
  units text not null default 'metric' check (units in ('metric', 'imperial')),
  sex text check (sex in ('male', 'female')),
  age int check (age between 10 and 120),
  height_cm numeric(5, 1) check (height_cm between 80 and 260),
  weight_kg numeric(5, 1) check (weight_kg between 25 and 400),
  activity text check (activity in ('sedentary', 'light', 'moderate', 'active', 'very_active')),
  objective text check (objective in ('lose', 'maintain', 'gain')),
  pace_kg_per_week numeric(3, 2) check (pace_kg_per_week between 0 and 1.5),
  utc_offset_minutes int not null default 0 check (utc_offset_minutes between -720 and 840),
  target_kcal int,
  target_protein_g int,
  target_carbs_g int,
  target_fat_g int,
  fix_meal_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app.meals (
  id uuid primary key default gen_random_uuid(),
  tg_id bigint not null default app.tg_id() references app.users (tg_id) on delete cascade,
  eaten_at timestamptz not null default now(),
  description text not null,
  user_note text,
  items jsonb not null default '[]',
  kcal int not null check (kcal >= 0),
  protein_g numeric(6, 1) not null check (protein_g >= 0),
  carbs_g numeric(6, 1) not null check (carbs_g >= 0),
  fat_g numeric(6, 1) not null check (fat_g >= 0),
  photo_file_ids text[] not null default '{}',
  source_message_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index meals_user_time on app.meals (tg_id, eaten_at desc);

alter table app.users add constraint users_fix_meal_fk
  foreign key (fix_meal_id) references app.meals (id) on delete set null;

-- `before` is the meal row prior to the change; null means the change created the meal.
create table app.meal_revisions (
  id uuid primary key default gen_random_uuid(),
  tg_id bigint not null default app.tg_id() references app.users (tg_id) on delete cascade,
  meal_id uuid not null,
  before jsonb,
  undone_at timestamptz,
  created_at timestamptz not null default now()
);

create index meal_revisions_meal on app.meal_revisions (meal_id);

create table app.processed_updates (
  update_id bigint primary key,
  tg_id bigint not null default app.tg_id(),
  created_at timestamptz not null default now()
);

create table app.rate_limits (
  tg_id bigint not null default app.tg_id(),
  bucket text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (tg_id, bucket, window_start)
);

-- Album photos arrive as separate updates; they are parked here until one update claims the whole group.
create table app.media_group_items (
  media_group_id text not null,
  tg_id bigint not null default app.tg_id(),
  message_id bigint not null,
  file_id text not null,
  caption text,
  claimed boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (media_group_id, message_id)
);

do $$
declare t text;
begin
  foreach t in array array['users', 'meals', 'meal_revisions', 'processed_updates', 'rate_limits', 'media_group_items'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('revoke all on app.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on app.%I to bot_user', t);
    execute format(
      'create policy own_rows on app.%I as permissive for all to bot_user using (tg_id = app.tg_id()) with check (tg_id = app.tg_id())',
      t
    );
  end loop;
end $$;

-- The FK check runs without RLS, so this stops a user pointing fix_meal_id at someone else's meal.
create function app.assert_own_meal() returns trigger
language plpgsql
as $$
begin
  if new.fix_meal_id is not null and not exists (select 1 from app.meals where id = new.fix_meal_id) then
    raise exception 'meal % not visible to user', new.fix_meal_id;
  end if;
  return new;
end $$;

create trigger users_own_fix_meal before insert or update of fix_meal_id on app.users
  for each row execute function app.assert_own_meal();

create function app.touch_updated_at() returns trigger
language plpgsql
as $$ begin new.updated_at := now(); return new; end $$;

create trigger users_touch before update on app.users for each row execute function app.touch_updated_at();
create trigger meals_touch before update on app.meals for each row execute function app.touch_updated_at();

-- Returns true if the hit is within the limit.
create function app.rate_limit_hit(p_bucket text, p_max int, p_window interval) returns boolean
language plpgsql
as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / extract(epoch from p_window)) * extract(epoch from p_window));
  n int;
begin
  insert into app.rate_limits (tg_id, bucket, window_start, hits)
  values (app.tg_id(), p_bucket, w, 1)
  on conflict (tg_id, bucket, window_start) do update set hits = app.rate_limits.hits + 1
  returning hits into n;
  return n <= p_max;
end $$;

-- OpenRouter keys live in Vault, named per user. These definer functions are the only path to them and
-- only ever touch the caller's own secret.
create function app.set_openrouter_key(p_key text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  uid bigint := app.tg_id();
  sid uuid;
begin
  if uid is null then raise exception 'no user context'; end if;
  select id into sid from vault.secrets where name = 'openrouter:' || uid;
  if sid is null then
    perform vault.create_secret(p_key, 'openrouter:' || uid);
  else
    perform vault.update_secret(sid, p_key);
  end if;
end $$;

create function app.get_openrouter_key() returns text
language sql stable security definer
set search_path = ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = 'openrouter:' || app.tg_id() $$;

create function app.delete_openrouter_key() returns void
language sql security definer
set search_path = ''
as $$ delete from vault.secrets where name = 'openrouter:' || app.tg_id() $$;

create function app.delete_account() returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if app.tg_id() is null then raise exception 'no user context'; end if;
  delete from vault.secrets where name = 'openrouter:' || app.tg_id();
  delete from app.rate_limits where tg_id = app.tg_id();
  delete from app.processed_updates where tg_id = app.tg_id();
  delete from app.media_group_items where tg_id = app.tg_id();
  delete from app.users where tg_id = app.tg_id();
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'app.rate_limit_hit(text, int, interval)', 'app.set_openrouter_key(text)', 'app.get_openrouter_key()',
    'app.delete_openrouter_key()', 'app.delete_account()', 'app.assert_own_meal()', 'app.touch_updated_at()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function app.rate_limit_hit(text, int, interval) to bot_user;
grant execute on function app.set_openrouter_key(text) to bot_user;
grant execute on function app.get_openrouter_key() to bot_user;
grant execute on function app.delete_openrouter_key() to bot_user;
grant execute on function app.delete_account() to bot_user;
