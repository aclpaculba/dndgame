-- ============================================================
-- Lets a table's creator delete it from the "Joinable Tables"
-- list in the lobby. There was previously no DELETE policy on
-- sessions at all, so any delete attempt from the client would
-- have been silently rejected by Row Level Security.
--
-- Players and messages for that session cascade-delete
-- automatically (their foreign keys already say
-- "on delete cascade"), so deleting the session row is enough to
-- clean up the whole table in one step.
-- ============================================================

drop policy if exists "sessions: delete all" on public.sessions;
create policy "sessions: delete all" on public.sessions
  for delete using (true);

-- Safety net: make sure the messages table (added ad hoc earlier,
-- not tracked in a prior migration file in this repo) exists with
-- the right shape, RLS, and cascade delete, in case this project's
-- copy of it ever needs to be recreated from these migration files
-- alone.
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  display_name text not null,
  content text not null check (char_length(content) between 1 and 500),
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;

drop policy if exists "messages: read all" on public.messages;
create policy "messages: read all" on public.messages
  for select using (true);

drop policy if exists "messages: insert all" on public.messages;
create policy "messages: insert all" on public.messages
  for insert with check (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;