-- ============================================================
-- Adds a boss encounter to each session (its own name/health,
-- shown as a health bar alongside the players) and a small
-- inventory to each player. Both feed into the outcome roll:
-- the acting player's relevant ability score shifts the dice
-- roll, and items can be used for a guaranteed, deterministic
-- effect (heal, or damage the boss directly) instead of gambling
-- on a story choice.
-- ============================================================

alter table public.sessions
  add column if not exists boss_name text not null default 'The Nameless Dread',
  add column if not exists boss_max_health int not null default 100,
  add column if not exists boss_health int not null default 100;

alter table public.players
  add column if not exists inventory jsonb not null default '[]'::jsonb;