import { CLAUDE_PROXY_URL } from './api.js';
import { renderSidebar } from './sidebar.js';
import { getSchedule } from './storage.js';


// Teacher access config — SINGLE SOURCE OF TRUTH is teacher-directory.js, a classic
// <script> loaded before this module (app.html) and by teacher.html/admin.html
// so every page shares ONE definition (AUDIT_FRONTEND H3/F1). This module simply
// re-exports the globals it publishes; edit the list in teacher-directory.js.
// (Reading a classic-script global from a module mirrors the existing `sb`
// pattern from cognito-auth.js.)
if (!globalThis.TEACHER_EMAIL_MAP) {
  console.error('[teachers] teacher-directory.js was not loaded before app.js — TEACHER_EMAIL_MAP is empty. Check the <script src="teacher-directory.js"> tag in app.html.');
}
export const TEACHER_EMAIL_MAP = globalThis.TEACHER_EMAIL_MAP || {};
export const ALLOWED_TEACHER_EMAILS = globalThis.ALLOWED_TEACHER_EMAILS || [];

// Teacher-mode LINK gate (app.html "Switch to Teacher Mode"). Single call-site
// helper so app.js imports the decision instead of hardcoding its own email
// list — the finding F1 fix (two gates were maintained in separate files).
export function isTeacherModeAllowed(email) {
  if (!email) return false;
  const e = email.toLowerCase();
  return ALLOWED_TEACHER_EMAILS.some(a => a.toLowerCase() === e);
}

// ── Test-mode teacher overlay (AUDIT_FRONTEND F2) ────────────────────────────
// In test mode the signed-in teacher's own display name → email pairing used to
// be written straight into the shared TEACHER_EMAIL_MAP at runtime, which
// pollutes shared config and would collide if the teacher's Google full_name
// equals a real curriculum name. Keep it in a SEPARATE overlay instead; every
// name→email lookup goes through resolveTeacherEmail (overlay first, then the
// shared map), so behavior is unchanged but the shared map is never mutated.
const _testModeEmailMap = {};
export function setTestModeTeacher(name, email) {
  if (name && email) _testModeEmailMap[name] = email;
}
export function resolveTeacherEmail(name) {
  if (!name) return undefined;
  return _testModeEmailMap[name] || TEACHER_EMAIL_MAP[name];
}

// ── Teacher profile system — single source of truth: Supabase ──
// Seed profiles are pushed to Supabase on load; _profileCache is the in-memory fallback.
export const _profileCache = {};
export const _profileStatusCache = {}; // { 'course::teacher': 'ready' | 'pending' }

export async function preloadProfileStatuses() {
  const schedule = getSchedule();
  if (!schedule.length) return;
  const emails = [...new Set(schedule.map(s => resolveTeacherEmail(s.teacher)).filter(Boolean))];
  if (!emails.length) return;
  try {
    let data;
    try {
      data = await fetchTeacherProfilesByEmails(emails);
    } catch (err) {
      console.error('[preloadProfileStatuses] fetch failed:', err);
      return;
    }
    // Build a lookup: email__course -> done
    const lookup = {};
    (data || []).forEach(row => { lookup[row.teacher_email + '__' + row.course_name] = row.done; });
    // Map each scheduled class
    schedule.forEach(({ course, teacher }) => {
      const email = resolveTeacherEmail(teacher);
      const key = course + '::' + teacher;
      if (!email) { _profileStatusCache[key] = 'pending'; return; }
      const done = lookup[email + '__' + course];
      _profileStatusCache[key] = done === true ? 'ready' : 'pending';
    });
    renderSidebar();
  } catch (e) { console.warn('[preloadProfileStatuses] failed:', e); }
}

// Generic RDS Lambda fetch (Workstream G). Same auth idiom as
// fetchTeacherProfileLambda below: Supabase JWT as Bearer, JSON in/out.
// 404 -> null (not-found is a data state, not an error); any other non-2xx
// throws so call sites fail VISIBLY — never silently swallow errors.
// `path` starts without a slash (CLAUDE_PROXY_URL ends with one);
// query params go in `path`, write payloads in `body`.
export async function rdsFetch(path, { method = 'GET', body } = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) throw new Error('rdsFetch: no session');
  const res = await fetch(`${CLAUDE_PROXY_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path.split('?')[0]} ${res.status}`);
  return res.json();
}

// Option 2: fetch one teacher profile from the RDS-backed Lambda route, shape-matched
// to the supabase-js path (returns the row object, or null on 404). Auth is the same
// Supabase JWT the chat proxy already uses. The route returns an array (teacher_email
// is non-unique); we filter by course_name server-side and take the first row.
export async function fetchTeacherProfileLambda(email, course) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) return null;
  const url = `${CLAUDE_PROXY_URL}teacher-profile?teacher_email=${encodeURIComponent(email)}&course_name=${encodeURIComponent(course)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`teacher-profile ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? (rows[0] || null) : (rows || null);
}

// Option 2 (list sites): fetch all profile rows for a set of teacher emails via the
// RDS Lambda — one parallel request per email (the route takes a single teacher_email;
// a student's schedule is only a handful of teachers). Returns a flat array of rows.
export async function fetchTeacherProfilesByEmails(emails) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) return [];
  const lists = await Promise.all(emails.map(async (email) => {
    const url = `${CLAUDE_PROXY_URL}teacher-profile?teacher_email=${encodeURIComponent(email)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`teacher-profile ${res.status}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  }));
  return lists.flat();
}

// Single lookup function — Supabase first, then in-memory cache.
// Returns profile if complete, { __notReady } if in progress, null if not found.
export async function getTeacherProfile(teacherName, course) {
  if (!teacherName || !course) return null;
  const email = resolveTeacherEmail(teacherName);
  if (!email) { console.warn('[getTeacherProfile] no email for:', teacherName); return null; }
  const cacheKey = email + '__' + course;

  // AUDIT_FRONTEND F3: serve a warm cache entry instead of re-hitting the Lambda
  // on every open of the same class (previously N opens = N round-trips; the
  // cache below at "_profileCache[cacheKey] = data" was only ever read on a
  // thrown-error fallback). Only short-circuit a fully-hydrated, READY profile
  // (workSamples loaded AND done) — a not-yet-ready profile always re-fetches so
  // a teacher who finishes onboarding mid-session is picked up on the next open.
  const warm = _profileCache[cacheKey];
  if (warm && warm.done && warm.workSamples) {
    console.log('[getTeacherProfile] warm cache hit:', teacherName, course);
    return warm;
  }

  console.log('[getTeacherProfile] loading:', teacherName, course);

  // Fetch the profile (5s timeout) from the RDS-backed Lambda. FAIL VISIBLY —
  // console.error + an { __error } marker the chat consumer turns into a banner.
  try {
    let data = null;
    const timeout = new Promise(resolve => setTimeout(() => resolve(undefined), 5000));
    let raced;
    try {
      raced = await Promise.race([fetchTeacherProfileLambda(email, course), timeout]);
    } catch (err) {
      console.error('[getTeacherProfile] Lambda fetch failed:', teacherName, course, err);
      return { __error: true, message: err?.message || String(err) };
    }
    if (raced === undefined) {
      console.error('[getTeacherProfile] Lambda timed out:', teacherName, course);
      return { __error: true, message: 'Lambda request timed out (5s)' };
    }
    data = raced; // row object, or null on 404
    if (data) {
      console.log('[getTeacherProfile] hit, done:', data.done);
      // Q4: fetch teacher_work_samples rows for this profile (3s budget,
      // never blocks profile usage). Stored as data.workSamples keyed by
      // tier — descriptions live here, images are loaded separately by
      // loadWorkSampleImages() at chat-open time.
      data.workSamples = {};
      if (data.id) {
        try {
          // 3s budget — never blocks profile usage.
          const sQuery = rdsFetch(`work-samples?teacher_profile_id=${encodeURIComponent(data.id)}`)
            .then(rows => ({ data: rows || [], error: null }), error => ({ data: null, error }));
          const sTimeout = new Promise(resolve => setTimeout(() => resolve(null), 3000));
          const sRes = await Promise.race([sQuery, sTimeout]);
          if (sRes && !sRes.error && Array.isArray(sRes.data)) {
            sRes.data.forEach(r => { data.workSamples[r.tier] = r; });
          } else if (sRes?.error) {
            console.warn('[getTeacherProfile] work_samples error:', sRes.error.message);
          }
        } catch (e) {
          console.warn('[getTeacherProfile] work_samples fetch failed:', e);
        }
      }
      _profileCache[cacheKey] = data; // update cache (incl. workSamples)
      if (!data.done) return { __notReady: true };
      return data;
    }
    // No row (404) is a definitive "not found" — do NOT fall back to the
    // in-memory cache.
    console.log('[getTeacherProfile] Lambda: no profile for', email, course);
    return null;
  } catch (e) {
    console.warn('[getTeacherProfile] profile fetch failed:', e);
  }

  // Fallback to the in-memory cache (seeded profiles) — only reached if the
  // fetch threw unexpectedly above.
  const cached = _profileCache[cacheKey];
  if (cached) {
    console.log('[getTeacherProfile] using cached profile');
    if (!cached.done) return { __notReady: true };
    return cached;
  }

  console.warn('[getTeacherProfile] NO PROFILE FOUND for:', teacherName, course);
  return null;
}

// Teacher-notes parsing + prompt-section assembly moved SERVER-SIDE
// (lambda/index.mjs parseNotes/buildTeacherNotesSection) so notes never reach
// the browser. The client only emits the <<LUMI_TEACHER_NOTES>> marker in
// buildTutorSystem and the inject_teacher_notes field in callAPI.

// ─── WORK SAMPLES (Q4) ───────────────────────────────────────────────────────
// Reads profile.workSamples (raw rows from teacher_work_samples), generates
// signed URLs in one batch, fetches each image as base64. Returns a
// consolidated `{ tier: { description, images: [{base64, mediaType}] } }`
// shape ready for buildTutorSystem and buildApiMessages.
//
// Returns null on ANY shortfall — missing tier, no photos, no description,
// signed-URL failure, fetch failure. The "all 3 tiers required" gate. Both
// gates downstream check this same single return value.
export async function loadWorkSampleImages(profile) {
  const ws = profile && profile.workSamples;
  const tiers = ['progressing','proficient','exemplary'];
  if (!ws) return null;
  for (const tier of tiers) {
    const row = ws[tier];
    if (!row || !Array.isArray(row.photo_paths) || row.photo_paths.length === 0) return null;
    if (!(row.description || '').trim()) return null;
  }

  const allPaths = tiers.flatMap(tier => ws[tier].photo_paths.map(path => ({ tier, path })));

  // Get fresh session for auth on Lambda calls.
  let session;
  try {
    const sessRes = await sb.auth.getSession();
    session = sessRes && sessRes.data && sessRes.data.session;
    if (!session) {
      console.warn('[work_samples] no session');
      return null;
    }
  } catch (e) {
    console.warn('[work_samples] getSession failed:', e);
    return null;
  }

  // Fetch signed download URLs in parallel via Lambda /download-url.
  let signedResolutions;
  try {
    signedResolutions = await Promise.all(allPaths.map(async (p) => {
      const res = await fetch(`${CLAUDE_PROXY_URL}download-url`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
              'Content-Type': 'application/json',
        },
        body: JSON.stringify({ bucket: 'work-samples', key: p.path }),
      });
      if (!res.ok) throw new Error('download-url HTTP ' + res.status + ' for ' + p.path);
      const json = await res.json();
      if (!json.downloadUrl) throw new Error('missing downloadUrl for ' + p.path);
      return { signedUrl: json.downloadUrl };
    }));
  } catch (e) {
    console.warn('[work_samples] signed URL fetch failed:', e);
    return null;
  }

  let imageBlobs;
  try {
    imageBlobs = await Promise.all(signedResolutions.map(async (entry, i) => {
      const meta = allPaths[i];
      if (!entry || !entry.signedUrl) throw new Error('missing signed URL for ' + (meta && meta.path));
      const res = await fetch(entry.signedUrl);
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + meta.path);
      const blob = await res.blob();
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const r = reader.result || '';
          const idx = r.indexOf(',');
          resolve(idx >= 0 ? r.slice(idx + 1) : r);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      let mediaType = blob.type;
      if (!/^image\/(jpeg|png|webp|gif)$/i.test(mediaType)) {
        const ext = (meta.path.split('.').pop() || '').toLowerCase();
        mediaType = ext === 'png' ? 'image/png'
                  : ext === 'webp' ? 'image/webp'
                  : 'image/jpeg';
      }
      return { tier: meta.tier, base64, mediaType };
    }));
  } catch (e) {
    console.warn('[work_samples] image fetch failed:', e);
    return null;
  }

  const result = {};
  tiers.forEach(tier => { result[tier] = { description: ws[tier].description.trim(), images: [] }; });
  imageBlobs.forEach(item => { result[item.tier].images.push({ base64: item.base64, mediaType: item.mediaType }); });

  // Final integrity: every tier must have at least one image now.
  if (tiers.some(tier => result[tier].images.length === 0)) return null;
  return result;
}
