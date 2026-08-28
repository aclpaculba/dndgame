-- ============================================================
-- Some rooms on the path are safe zones (no monsters at all) —
-- a moment to rest and use potions before moving on. The party
-- advances out of a safe zone once every currently-alive player
-- has taken one turn there, not by defeating anything.
-- ============================================================
alter table public.sessions
  add column if not exists safe_zone_turns_taken int not null default 0;