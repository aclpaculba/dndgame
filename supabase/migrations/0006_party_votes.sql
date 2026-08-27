-- Shared party voting for every story decision and world exit.
alter table public.sessions
  add column if not exists vote_state jsonb not null default '{}'::jsonb;
