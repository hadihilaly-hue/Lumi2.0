// ─── SUPABASE CONFIG ──────────────────────────────────────────────────────────
// Replace these with your actual Supabase project values
const SUPABASE_URL     = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY_HERE';

const { createClient } = window.supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function getUser() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.user || null;
}

function isMenloEmail(email) {
  return email && email.toLowerCase().endsWith('@menlo.org');
}

// ─── SIGN IN ──────────────────────────────────────────────────────────────────
async function signInWithGoogle() {
  // Build redirect URL pointing to app.html in the same directory
  const base = window.location.href.replace(/\/[^/]*$/, '/');
  const redirectTo = base + 'app.html';

  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      queryParams: { hd: 'menlo.org' },   // hint to Google to pre-select menlo.org accounts
    },
  });
  if (error) throw error;
}

// ─── SIGN OUT ─────────────────────────────────────────────────────────────────
async function doSignOut() {
  await sb.auth.signOut();
  window.location.replace('index.html');
}

// ─── ROUTE GUARDS ─────────────────────────────────────────────────────────────
// Call on index.html — redirect to app if already signed in with @menlo.org
async function requireGuest() {
  const user = await getUser();
  if (user && isMenloEmail(user.email)) {
    window.location.replace('app.html');
  }
}

// Call on app.html — redirect to index if not signed in (or wrong domain)
// Returns the user if valid, never returns if redirect triggered
async function requireAuth() {
  const user = await getUser();
  if (!user) {
    window.location.replace('index.html');
    return null;
  }
  if (!isMenloEmail(user.email)) {
    await sb.auth.signOut();
    window.location.replace('index.html?error=domain');
    return null;
  }
  return user;
}
