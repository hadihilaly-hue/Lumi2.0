// First-run privacy consent gate (see app.html for notes). Routes an
// un-consented signed-in teacher to the consent screen, then back here.

import { LAMBDA_URL } from './config.js';

async function gate(session) {
  if (!session || !session.user || !session.user.email) return;
  const email = session.user.email.toLowerCase();
  if (localStorage.getItem('lumi_privacy_ok') === email) return;
  try {
    const r = await fetch(LAMBDA_URL + '/consent', { headers: { Authorization: 'Bearer ' + session.access_token } });
    if (!r.ok) return;
    const j = await r.json();
    if (j.accepted) { localStorage.setItem('lumi_privacy_ok', email); return; }
    const dest = (location.pathname.split('/').pop() || 'teacher.html');
    location.replace('privacy.html?consent=1&next=' + encodeURIComponent(dest));
  } catch (_e) { /* fail open */ }
}

export async function runConsentGate() {
  try { const s = (await sb.auth.getSession()).data.session; if (s && s.user) { gate(s); return; } } catch (_e) { /* ignore — the listener below still gates the next sign-in */ }
  sb.auth.onAuthStateChange((ev, s) => { if (ev === 'SIGNED_IN') gate(s); });
}
