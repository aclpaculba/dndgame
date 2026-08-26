-- ============================================================
-- Last Ember — database schema (Supabase / Postgres)
-- Run this once via the Supabase SQL editor, or via
-- `supabase db push` if you're using migrations locally.
-- ============================================================

-- ---------- profiles (one row per auth user) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  preferred_ui_mode text not null default 'simple' check (preferred_ui_mode in ('simple','animated')),
  active_session_id uuid,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles: insert own" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id);

-- Auto-create a profile row whenever someone signs up.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)));
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- sessions (one row per game table) ----------
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id),
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

-- Anyone signed in can see sessions (needed for the lobby list + live sync).
create policy "sessions: read all" on public.sessions
  for select using (auth.role() = 'authenticated');
-- A player may only create a session as themself.
create policy "sessions: insert own" on public.sessions
  for insert with check (auth.uid() = creator_id);
-- Direct client updates are limited to turn_order (used when joining).
-- All other game-state changes (health, story, turn advance, reset) go
-- through the Edge Functions using the service role key, which bypasses RLS.
create policy "sessions: join updates turn_order" on public.sessions
  for update using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- ---------- players (one row per player per session) ----------
create table if not exists public.players (
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  display_name text not null,
  health int not null default 100,
  is_alive boolean not null default true,
  position_in_turn_order int not null default 0,
  joined_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

alter table public.players enable row level security;

create policy "players: read all" on public.players
  for select using (auth.role() = 'authenticated');
create policy "players: insert own" on public.players
  for insert with check (auth.uid() = user_id);
-- Health/is_alive are server-managed (Edge Functions, service role);
-- a player may only ever touch their own display_name from the client.
create policy "players: update own name only" on public.players
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------- realtime ----------
-- Lets the browser subscribe to live changes instead of polling.
alter publication supabase_realtime add table public.sessions;
alter publication supabase_realtime add table public.players;
