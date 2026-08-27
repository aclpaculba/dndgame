begin;

-- Remove all current game tables and their activity.
delete from public.messages;
delete from public.players;
delete from public.sessions;

-- Let players start fresh without deleting their saved characters.
update public.profiles
set active_session_id = null;

commit;
