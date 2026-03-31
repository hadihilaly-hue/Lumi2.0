// ─── SUPABASE CONFIG ──────────────────────────────────────────────────────────
// Replace these with your actual Supabase project values
const SUPABASE_URL      = 'https://mzrzmfkfjfdwsjwblbzz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im16cnptZmtmamZkd3Nqd2JsYnp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5ODM2MTcsImV4cCI6MjA5MDU1OTYxN30.yOiFVEGwIR9urvaMCF3QrfSvdgD0wYldGW3g40aedpo';

const { createClient } = window.supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { flowType: 'implicit' }
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function getUser() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.user || null;
}

function isMenloEmail(email) {
  return email && email.toLowerCase().endsWith('@menloschool.org');
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
// Call on index.html — redirect to app if already signed in with @menloschool.org
async function requireGuest() {
  const user = await getUser();
  if (user && isMenloEmail(user.email)) {
    window.location.replace('app.html');
  }
}

// Call on app.html — redirect to index if not signed in (or wrong domain)
// Returns the user if valid, never returns if redirect triggered
async function requireAuth() {
  // First try: session already established
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) {
    const user = session.user;
    if (!isMenloEmail(user.email)) {
      await sb.auth.signOut();
      window.location.replace('index.html?error=domain');
      return null;
    }
    return user;
  }

  // Second try: wait for auth state change (handles OAuth redirect with token in URL hash)
  return new Promise((resolve) => {
    const { data: { subscription } } = sb.auth.onAuthStateChange(async (event, session) => {
      subscription.unsubscribe();
      if (!session?.user) {
        window.location.replace('index.html');
        resolve(null);
        return;
      }
      const user = session.user;
      if (!isMenloEmail(user.email)) {
        await sb.auth.signOut();
        window.location.replace('index.html?error=domain');
        resolve(null);
        return;
      }
      resolve(user);
    });

    // Timeout after 6 seconds — if no auth event, redirect to sign-in
    setTimeout(() => {
      subscription.unsubscribe();
      window.location.replace('index.html');
      resolve(null);
    }, 6000);
  });
}
