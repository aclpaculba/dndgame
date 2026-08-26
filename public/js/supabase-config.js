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
const SUPABASE_URL = 'https://REPLACE_WITH_YOUR_PROJECT_REF.supabase.co';
const SUPABASE_ANON_KEY = 'REPLACE_WITH_YOUR_ANON_PUBLIC_KEY';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
