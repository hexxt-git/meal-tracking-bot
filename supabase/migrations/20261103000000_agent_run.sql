-- The assistant run in progress for this user. A newer message takes it over: the old run stops, its changes are undone
-- and its messages are handled again together with the new one.
alter table app.users add column agent_run jsonb;
