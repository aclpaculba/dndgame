-- ============================================================
-- Two additions:
--
-- 1. players.boss_damage_contribution tracks how much damage the
--    current player has dealt to the CURRENT boss specifically
--    (reset to 0 every time a new boss encounter spawns). When
--    that boss dies, souls are split across contributors in
--    proportion to this value, instead of the killing blow taking
--    everything.
--
-- 2. profiles gains permanent, cross-session "all time" stats.
--    The players table is per-session (a fresh row every time
--    someone joins a table), so lifetime totals have to live on
--    the profile instead, which persists as long as the username
--    does.
-- ============================================================

alter table public.players
  add column if not exists boss_damage_contribution int not null default 0;

alter table public.profiles
  add column if not exists total_damage_dealt bigint not null default 0,
  add column if not exists total_damage_taken bigint not null default 0,
  add column if not exists enemies_slain int not null default 0,
  add column if not exists bosses_slain int not null default 0,
  add column if not exists sections_cleared int not null default 0,
  add column if not exists highest_single_hit int not null default 0;