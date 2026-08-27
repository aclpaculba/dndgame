-- Stackfall: Ashen Edition progression and combat state.
-- Defaults preserve existing sessions while new sessions can use the full ruleset.

alter table public.characters
  drop constraint if exists characters_strength_check,
  drop constraint if exists characters_dexterity_check,
  drop constraint if exists characters_constitution_check,
  drop constraint if exists characters_intelligence_check,
  drop constraint if exists characters_wisdom_check,
  drop constraint if exists characters_charisma_check;

alter table public.characters
  add constraint characters_strength_check check (strength between 1 and 20),
  add constraint characters_dexterity_check check (dexterity between 1 and 20),
  add constraint characters_constitution_check check (constitution between 1 and 20),
  add constraint characters_intelligence_check check (intelligence between 1 and 20),
  add constraint characters_wisdom_check check (wisdom between 1 and 20),
  add constraint characters_charisma_check check (charisma between 1 and 20);

alter table public.characters
  add column if not exists inventory jsonb not null default '{"weapon": null, "off_hand": null, "armor": null, "helm": null, "boots": null, "ring1": null, "ring2": null}'::jsonb,
  add column if not exists marks text[] not null default '{}';

alter table public.players
  add column if not exists max_health int not null default 100,
  add column if not exists souls int not null default 0,
  add column if not exists level int not null default 1,
  add column if not exists unallocated_stat_points int not null default 0,
  add column if not exists ghost_mode boolean not null default false,
  add column if not exists death_count int not null default 0,
  add column if not exists status text not null default 'Healthy'
    check (status in ('Healthy', 'Wounded', 'Critical', 'Dead'));

create index if not exists players_alive_idx on public.players(session_id, is_alive);