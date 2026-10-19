-- ISO 3166-1 alpha-2; steers food and brand lookups to what's sold where the user lives.
alter table app.users add column country text check (country ~ '^[A-Z]{2}$');

-- One assistant reply can change several meals; batch_id groups those revisions so one Undo reverts them together.
alter table app.meal_revisions add column batch_id uuid;
update app.meal_revisions set batch_id = id;
alter table app.meal_revisions alter column batch_id set not null, alter column batch_id set default gen_random_uuid();
create index meal_revisions_batch on app.meal_revisions (batch_id);
