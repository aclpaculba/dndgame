-- ============================================================
-- Moves the game from "one boss fight, then the session ends"
-- to continuous progression: the party fights a monster, then
-- another, and every 5th encounter is a boss — stronger and
-- worth far more souls. Beating a boss is what actually advances
-- current_room_index (moves the party along the path); beating a
-- regular monster just spawns the next monster in the same room.
-- Stats, health, and inventory are never reset between encounters
-- or rooms — only a full party wipe ends the session now.
-- ============================================================

alter table public.sessions
  add column if not exists is_boss_encounter boolean not null default false,
  add column if not exists encounter_number int not null default 1;