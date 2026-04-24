// ─── SUPABASE CONFIG ──────────────────────────────────────────────────────────
const SUPABASE_URL      = 'https://mzrzmfkfjfdwsjwblbzz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im16cnptZmtmamZkd3Nqd2JsYnp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5ODM2MTcsImV4cCI6MjA5MDU1OTYxN30.yOiFVEGwIR9urvaMCF3QrfSvdgD0wYldGW3g40aedpo';

const { createClient } = window.supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { flowType: 'implicit' }
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
// TEMPORARY: testing bypass for hadi@hilaly.com — REMOVE BEFORE PRODUCTION
function isMenloEmail(email) {
  if (!email) return false;
  const e = email.toLowerCase();
  return e.endsWith('@menloschool.org') || e === 'hadi@hilaly.com';
}

async function doSignOut() {
  await sb.auth.signOut();
  window.location.href = 'index.html';
}
