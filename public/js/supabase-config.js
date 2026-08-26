// ============================================================
// Supabase project configuration.
//
// Get these from: your Supabase project → Project Settings → API
//   - "Project URL"        → SUPABASE_URL
//   - "anon public" key    → SUPABASE_ANON_KEY
//
// The anon key is safe to publish — it's designed to be used in
// browser code. Access is controlled by the Row Level Security
// policies in supabase/migrations/0001_init.sql, not by hiding
// this file.
//
// Note: there's no Supabase Auth in this version — players
// identify themselves with just a username (see app.js /
// login_or_create_profile). That means the RLS policies here are
// intentionally open (anyone with the anon key can read/write
// profiles, sessions, and players), which is fine for a casual
// game with friends but is not a real security boundary.
// ============================================================
const SUPABASE_URL = 'https://REPLACE_WITH_YOUR_PROJECT_REF.supabase.co';
const SUPABASE_ANON_KEY = 'REPLACE_WITH_YOUR_ANON_PUBLIC_KEY';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);