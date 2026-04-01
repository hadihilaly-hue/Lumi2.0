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
      queryParams: { hd: 'menloschool.org' },   // hint to Google to pre-select menloschool.org accounts
    },
  });
  if (error) throw error;
}

// ─── SIGN OUT ─────────────────────────────────────────────────────────────────
async function doSignOut() {
  await sb.auth.signOut();
  window.location.replace('index.html');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
// getSession with a hard 5s timeout so a paused/slow Supabase never hangs the app
async function getSessionSafe() {
  return Promise.race([
    sb.auth.getSession(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('getSession timeout')), 5000)
    ),
  ]);
}

// ─── ROUTE GUARDS ─────────────────────────────────────────────────────────────
// Call on index.html — redirect to app if already signed in with @menloschool.org
async function requireGuest() {
  try {
    const { data: { session } } = await getSessionSafe();
    const user = session?.user;
    if (user && isMenloEmail(user.email)) {
      window.location.replace('app.html');
    }
  } catch { /* timed out — just show sign-in */ }
}

// Call on app.html — returns user if valid, redirects if not.
// If it's an OAuth redirect (hash token), waits for onAuthStateChange.
// Otherwise checks session with a 4s timeout then redirects if nothing found.
async function requireAuth() {
  const hasHashToken = window.location.hash.includes('access_token');

  if (hasHashToken) {
    // Just came back from Google OAuth — wait for Supabase to exchange the token
    return new Promise((resolve) => {
      const { data: { subscription } } = sb.auth.onAuthStateChange(async (event, session) => {
        subscription.unsubscribe();
        if (!session?.user) { window.location.replace('index.html'); resolve(null); return; }
        const user = session.user;
        if (!isMenloEmail(user.email)) {
          await sb.auth.signOut();
          window.location.replace('index.html?error=domain');
          resolve(null); return;
        }
        resolve(user);
      });
      setTimeout(() => {
        subscription.unsubscribe();
        window.location.replace('index.html');
        resolve(null);
      }, 6000);
    });
  }

  // No OAuth redirect — check for existing session with tight timeout
  try {
    const { data: { session } } = await getSessionSafe();
    if (session?.user) {
      const user = session.user;
      if (!isMenloEmail(user.email)) {
        await sb.auth.signOut();
        window.location.replace('index.html?error=domain');
        return null;
      }
      return user;
    }
  } catch { /* timeout */ }

  // No session found — send to sign-in
  window.location.replace('index.html');
  return null;
}
