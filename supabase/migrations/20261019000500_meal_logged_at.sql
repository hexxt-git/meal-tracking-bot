-- eaten_at = when the food was eaten (user/AI controlled); logged_at = when the user sent the message that logged it.
alter table app.meals add column logged_at timestamptz;
update app.meals set logged_at = created_at;
alter table app.meals alter column logged_at set not null, alter column logged_at set default now();
