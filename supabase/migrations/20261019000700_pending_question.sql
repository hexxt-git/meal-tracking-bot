-- A multiple-choice question the assistant is waiting on, with the input needed to resume once it's answered.
alter table app.users add column pending_question jsonb;
