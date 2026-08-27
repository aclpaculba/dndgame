-- ============================================================
-- Random-character details (race, class, ability scores) were
-- only ever kept in the creating player's own browser — never
-- written anywhere shared — so no one else at the table could
-- see anyone's stats but their own. Storing them directly on
-- the players row means every client, which already fetches all
-- players via `select('*')` and gets live updates over realtime,
-- automatically has everyone's stats too.
-- ============================================================

alter table public.players
  add column if not exists race text not null default 'Human',
  add column if not exists class text not null default 'Fighter',
  add column if not exists strength int not null default 8,
  add column if not exists dexterity int not null default 8,
  add column if not exists constitution int not null default 8,
  add column if not exists intelligence int not null default 8,
  add column if not exists wisdom int not null default 8,
  add column if not exists charisma int not null default 8;