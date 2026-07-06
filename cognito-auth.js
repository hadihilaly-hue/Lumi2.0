// ─── COGNITO AUTH (Workstream I, Phase 3) ─────────────────────────────────────
// Drop-in replacement for supabase.js + auth.js. Exposes the same globals the
// pages already consume: `sb` (with sb.auth.getSession / signInWithOAuth /
// signOut / onAuthStateChange), `isAllowedEmail`, `doSignOut`.
//
// Flow: authorization code + PKCE against the Cognito hosted endpoints with
// identity_provider=Google (users bounce straight to Google — no Cognito page).
// `session.access_token` carries the Cognito ID TOKEN — the Lambda's verifyAuth
// expects token_use=id and resolves cognito_sub → preserved lumi uuid via the
// app_users table server-side.

// AUDIT_FRONTEND F6: all infra values for this (classic, non-module) script live
// in one CONFIG object. This is a classic script shared by teacher/admin/lumi
// pages, so it cannot import js/config.js — lambdaBaseUrl mirrors that module's
// LAMBDA_HOST (no trailing slash form); keep the two in sync on a host swap.
const CONFIG = {
  cognitoDomain:   'https://lumi-auth-613136968914.auth.us-east-1.amazoncognito.com',
  cognitoClientId: '538k8vb5uh8k7ikim8ql64vf44',
  lambdaBaseUrl:   'https://44d5lnv7ir7q4xgapsukc4tlnq0jtjxz.lambda-url.us-east-1.on.aws',
};
const COGNITO_DOMAIN    = CONFIG.cognitoDomain;
const COGNITO_CLIENT_ID = CONFIG.cognitoClientId;

const AUTH_STORAGE_KEY = 'lumi_auth';       // localStorage: {id_token, refresh_token, expires_at}
const PKCE_STORAGE_KEY = 'lumi_auth_pkce';  // sessionStorage: in-flight sign-in {verifier, state, redirectTo}
const REFRESH_SKEW_MS  = 60_000;            // refresh when less than this is left on the ID token

// ─── helpers ──────────────────────────────────────────────────────────────────

function b64urlFromBytes(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64urlFromBytes(bytes);
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64urlFromBytes(new Uint8Array(digest));
}

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part.padEnd(part.length + ((4 - part.length % 4) % 4), '=')));
  } catch {
    return null;
  }
}

function loadTokens() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveTokens(t) { localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(t)); }
function clearTokens() { localStorage.removeItem(AUTH_STORAGE_KEY); }

function buildSession(tokens) {
  const claims = tokens && decodeJwtPayload(tokens.id_token);
  if (!claims) return null;
  return {
    access_token: tokens.id_token,
    token_type: 'bearer',
    expires_at: Math.floor(tokens.expires_at / 1000),
    user: {
      id: claims.sub,
      email: claims.email,
      user_metadata: {
        full_name: claims.name,
        name: claims.name,
        avatar_url: claims.picture,
      },
      app_metadata: { provider: 'google' },
    },
  };
}

async function tokenEndpoint(params) {
  const res = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: COGNITO_CLIENT_ID, ...params }),
  });
  if (!res.ok) {
    const err = new Error(`token endpoint ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ─── auth state listeners ─────────────────────────────────────────────────────

const authListeners = [];
let pendingSignedInSession = null; // exchange finished before any listener registered

function fireAuthEvent(event, session) {
  if (event === 'SIGNED_IN' && authListeners.length === 0) {
    pendingSignedInSession = session;
    return;
  }
  for (const cb of authListeners) {
    try { cb(event, session); } catch (e) { console.error('[auth] listener error:', e); }
  }
}

// ─── bootstrap: finish an in-flight code exchange on page load ───────────────

const bootPromise = (async () => {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code) return;

  // Scrub ?code/&state from the address bar in EVERY path — including stale
  // callbacks replayed via back/forward, where no exchange runs.
  const scrubUrl = () => {
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    history.replaceState(null, '', url.toString());
  };

  let stored = null;
  try { stored = JSON.parse(sessionStorage.getItem(PKCE_STORAGE_KEY) || 'null'); } catch {}
  if (!stored || stored.state !== state) {
    console.warn('[auth] callback code with missing/mismatched state — ignoring');
    scrubUrl();
    return;
  }
  sessionStorage.removeItem(PKCE_STORAGE_KEY);

  try {
    const tokens = await tokenEndpoint({
      grant_type: 'authorization_code',
      code,
      redirect_uri: stored.redirectUri,
      code_verifier: stored.verifier,
    });
    saveTokens({
      id_token: tokens.id_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    });
  } catch (err) {
    console.error('[auth] code exchange failed:', err.message);
    return;
  } finally {
    scrubUrl();
  }

  // Restore any query/hash the caller's redirectTo carried (redirect_uri had
  // to be the bare registered page URL).
  if (stored.redirectTo && stored.redirectTo !== url.toString() && /[?#]/.test(stored.redirectTo)) {
    window.location.replace(stored.redirectTo);
    return;
  }

  fireAuthEvent('SIGNED_IN', buildSession(loadTokens()));
})();

// ─── refresh (deduped) ────────────────────────────────────────────────────────

let refreshInFlight = null;

async function refreshTokens(tokens) {
  refreshInFlight ??= (async () => {
    try {
      const fresh = await tokenEndpoint({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      });
      const next = {
        id_token: fresh.id_token,
        refresh_token: tokens.refresh_token, // Cognito does not rotate it
        expires_at: Date.now() + fresh.expires_in * 1000,
      };
      saveTokens(next);
      return next;
    } catch (err) {
      // 400 = refresh token expired/revoked → signed out. Anything else
      // (network blip) → keep the current session if it's still valid.
      if (err.status === 400) {
        clearTokens();
        return null;
      }
      return tokens.expires_at > Date.now() ? tokens : null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// ─── the supabase-compatible surface ─────────────────────────────────────────

const sb = {
  auth: {
    async getSession() {
      await bootPromise;
      let tokens = loadTokens();
      if (tokens && tokens.expires_at - Date.now() < REFRESH_SKEW_MS) {
        tokens = await refreshTokens(tokens);
      }
      return { data: { session: buildSession(tokens) }, error: null };
    },

    async signInWithOAuth({ options } = {}) {
      try {
        const redirectTo = options?.redirectTo || window.location.href;
        const redirectUri = redirectTo.split(/[?#]/)[0];
        const verifier = randomToken();
        const state = randomToken();
        sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify({ verifier, state, redirectTo, redirectUri }));
        const challenge = await pkceChallenge(verifier);
        const params = new URLSearchParams({
          client_id: COGNITO_CLIENT_ID,
          response_type: 'code',
          scope: 'openid email profile',
          redirect_uri: redirectUri,
          identity_provider: 'Google',
          code_challenge_method: 'S256',
          code_challenge: challenge,
          state,
        });
        window.location.assign(`${COGNITO_DOMAIN}/oauth2/authorize?${params}`);
        return new Promise(() => {}); // navigating away — never settle
      } catch (error) {
        return { error };
      }
    },

    // Clears local tokens AND the Cognito hosted session (otherwise a
    // sign-out → sign-in-as-someone-else loop silently re-signs-in the same
    // account off the Cognito cookie). Never resolves: the page is navigating,
    // and letting callers run their own follow-up redirect would cancel the
    // logout round trip.
    signOut() {
      clearTokens();
      fireAuthEvent('SIGNED_OUT', null);
      const base = window.location.href.replace(/\/[^/]*$/, '/');
      const params = new URLSearchParams({
        client_id: COGNITO_CLIENT_ID,
        logout_uri: base + 'index.html',
      });
      window.location.assign(`${COGNITO_DOMAIN}/logout?${params}`);
      return new Promise(() => {});
    },

    onAuthStateChange(callback) {
      authListeners.push(callback);
      if (pendingSignedInSession) {
        const s = pendingSignedInSession;
        pendingSignedInSession = null;
        try { callback('SIGNED_IN', s); } catch (e) { console.error('[auth] listener error:', e); }
      }
      return {
        data: {
          subscription: {
            unsubscribe() {
              const i = authListeners.indexOf(callback);
              if (i >= 0) authListeners.splice(i, 1);
            },
          },
        },
      };
    },
  },
};

// ─── HELPERS (same surface auth.js provided) ──────────────────────────────────

// Which email domains may use Lumi — served by the Lambda from
// schools.allowed_domains (Workstream I Phase 4). This client check is UX
// only (friendly error before any data loads); the Lambda enforces the gate.
// Fails OPEN on fetch problems so a network blip can't brick the sign-in page.
const LAMBDA_BASE_URL = CONFIG.lambdaBaseUrl; // AUDIT_FRONTEND F6: see CONFIG at top
let allowedDomainsPromise = null;

async function isAllowedEmail(email) {
  if (!email) return false;
  allowedDomainsPromise ??= (async () => {
    try {
      const res = await fetch(`${LAMBDA_BASE_URL}/allowed-domains`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      return new Set((await res.json()).domains);
    } catch {
      return null;
    }
  })();
  const domains = await allowedDomainsPromise;
  if (!domains) return true; // fail open — server still enforces
  return domains.has(email.toLowerCase().split('@').pop());
}

async function doSignOut() {
  await sb.auth.signOut();
  window.location.href = 'index.html'; // unreachable — signOut navigates; kept for shape parity
}
