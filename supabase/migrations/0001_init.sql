-- ============================================================
-- Stackfall — database schema (Supabase / Postgres)
--
-- There is no Supabase Auth in this version. A "player" is just
-- a row in profiles, looked up by username (case-insensitive).
-- Typing the same username again — from any browser or device —
-- resumes that same profile, including whatever session it was
-- last in. There is no password, so this is meant for playing
-- with people you trust, not as a real security boundary.
--
-- Run this once via the Supabase SQL editor, or via
-- `supabase db push` if you're using migrations locally.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- profiles (one row per player identity) ----------
create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  preferred_ui_mode text not null default 'simple' check (preferred_ui_mode in ('simple','animated')),
  active_session_id uuid,
  created_at timestamptz not null default now()
);

-- "Alice" and "alice" are the same player.
create unique index if not exists profiles_username_lower_idx on public.profiles (lower(username));

alter table public.profiles enable row level security;

-- No auth.uid() to key policies off anymore — anyone using the
-- anon key can read/update profiles. Fine for a casual game with
-- friends; put real auth back in front of this if that changes.
create policy "profiles: read all" on public.profiles
  for select using (true);
create policy "profiles: update all" on public.profiles
  for update using (true);

-- "Log in" = call this with the typed name. Existing username →
-- returns that profile as-is (same id, same active_session_id,
-- same preferred_ui_mode). New username → creates a fresh profile.
create or replace function public.login_or_create_profile(p_username text)
returns public.profiles
language plpgsql
security definer
as $$
declare
  result public.profiles;
  clean_name text := trim(p_username);
begin
  if clean_name = '' then
    raise exception 'Name cannot be empty.';
  end if;

  select * into result from public.profiles where lower(username) = lower(clean_name);
  if result.id is null then
    insert into public.profiles (username) values (clean_name)
    returning * into result;
  end if;
  return result;
end;
$$;

grant execute on function public.login_or_create_profile(text) to anon, authenticated;

-- ---------- sessions (one row per game table) ----------
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id),
  creator_name text not null,
  status text not null default 'active' check (status in ('active','completed')),
  current_turn_index int not null default 0,
  turn_order uuid[] not null default '{}',
  story_narrative text not null default 'The story is being written…',
  story_choices text[] not null default '{}',
  story_history jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sessions enable row level security;

create policy "sessions: read all" on public.sessions
  for select using (true);
create policy "sessions: insert all" on public.sessions
  for insert with check (true);
-- Direct client updates are limited in practice to turn_order (used
-- when joining). All other game-state changes (health, story, turn
-- advance, reset) go through the Edge Functions using the service
-- role key, which bypasses RLS entirely.
create policy "sessions: update all" on public.sessions
  for update using (true) with check (true);

-- ---------- players (one row per player per session) ----------
create table if not exists public.players (
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  display_name text not null,
  health int not null default 100,
  is_alive boolean not null default true,
  position_in_turn_order int not null default 0,
  joined_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

alter table public.players enable row level security;

create policy "players: read all" on public.players
  for select using (true);
create policy "players: insert all" on public.players
  for insert with check (true);
create policy "players: update all" on public.players
  for update using (true) with check (true);

-- ---------- realtime ----------
-- Lets the browser subscribe to live changes instead of polling.
alter publication supabase_realtime add table public.sessions;
alter publication supabase_realtime add table public.players;