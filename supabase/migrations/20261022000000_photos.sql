-- Short random ids for the photos a user sent, so the assistant can name them in its context and open them again.
create table app.photos (
  tg_id bigint not null default app.tg_id() references app.users (tg_id) on delete cascade,
  id text not null,
  file_id text not null,
  created_at timestamptz not null default now(),
  primary key (tg_id, id),
  unique (tg_id, file_id)
);

alter table app.photos enable row level security;
alter table app.photos force row level security;
revoke all on app.photos from public, anon, authenticated;
grant select, insert, delete on app.photos to bot_user;
create policy own_rows on app.photos as permissive for all to bot_user
  using (tg_id = app.tg_id()) with check (tg_id = app.tg_id());

insert into app.photos (tg_id, id, file_id)
select distinct on (m.tg_id, f) m.tg_id, substr(md5(gen_random_uuid()::text), 1, 8), f
from app.meals m, unnest(m.photo_file_ids) f
on conflict do nothing;
