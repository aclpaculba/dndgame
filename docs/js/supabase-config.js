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
// ============================================================
const SUPABASE_URL = 'https://crusicbsdbdqlajgbvsb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNydXNpY2JzZGJkcWxhamdidnNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3MDMxNTgsImV4cCI6MjEwMzI3OTE1OH0.WWdKIiUFA7ewIkVCTSXdnGI0fpLMOg65UifijhL8Fig';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
