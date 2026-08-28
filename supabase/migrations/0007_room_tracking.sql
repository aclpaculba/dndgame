-- The Ashen Map was previously pure decoration: the client guessed
-- the party's current room from story_history.length on its own,
-- completely disconnected from what the AI actually narrated. This
-- makes the current room a real, server-authoritative piece of
-- session state so the map and the story can never drift apart —
-- they're now reading and writing the exact same value.
alter table public.sessions
  add column if not exists current_room_index int not null default 0;