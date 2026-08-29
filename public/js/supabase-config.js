// ============================================================
// Supabase project configuration.
// ============================================================
const SUPABASE_URL = 'https://crusicbsdbdqlajgbvsb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNydXNpY2JzZGJkcWxhamdidnNiIiwiaWF0IjoxNzg3NzAzMTU4LCJleHAiOjIxMDMyNzkxNX0.WWdKIiUFA7ewIkVCTSXdnGI0fpLMOg65UifijhL8Fig';

const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) || null;