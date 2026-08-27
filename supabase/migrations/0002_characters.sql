-- Character data used by the table player panel.
create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  race text not null,
  class text not null,
  level int not null default 1,
  strength int not null default 8 check (strength between 8 and 15),
  dexterity int not null default 8 check (dexterity between 8 and 15),
  constitution int not null default 8 check (constitution between 8 and 15),
  intelligence int not null default 8 check (intelligence between 8 and 15),
  wisdom int not null default 8 check (wisdom between 8 and 15),
  charisma int not null default 8 check (charisma between 8 and 15),
  background text not null default '',
  personality text not null default '',
  ideal text not null default '',
  bond text not null default '',
  flaw text not null default '',
  created_at timestamptz not null default now()
);

alter table public.characters enable row level security;
create policy "characters: read all" on public.characters
  for select using (true);
create policy "characters: insert all" on public.characters
  for insert with check (true);
create policy "characters: update all" on public.characters
  for update using (true) with check (true);
create policy "characters: delete all" on public.characters
  for delete using (true);

alter table public.players
  add column if not exists character_id uuid references public.characters(id) on delete set null;

create index if not exists characters_profile_id_idx on public.characters(profile_id);
create index if not exists players_character_id_idx on public.players(character_id);

alter publication supabase_realtime add table public.characters;
