-- The last request that failed or hit the daily budget, so a Retry or Continue anyway button can run it again.
alter table app.users add column retry_run jsonb;

-- Set when the user chose to keep going after the daily budget ran out; applies to that UTC day only.
alter table app.ai_usage add column budget_bypassed boolean not null default false;
