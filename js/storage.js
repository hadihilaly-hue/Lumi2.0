import { CLAUDE_PROXY_URL } from './api.js';
import { CONFIG } from './config.js';
import { lookupSubjectForCourse } from './conversation.js';
import { setSidebarUserSubtitle } from './prompts.js';
import { S, currentUser } from './state.js';
import { fetchTeacherProfilesByEmails, rdsFetch, resolveTeacherEmail, setTestModeTeacher } from './teachers.js';
import { showToast } from './ui.js';


const WORK_SAMPLE_TIERS = ['progressing', 'proficient', 'exemplary'];

// Mirrors teacher.html hasAllWorkSampleTiers (Q4 v2, Decision D6): a tier is
// complete with ≥1 artifact of ANY type — a photo in teacher_work_samples OR a
// written example in teacher_work_artifacts. The description is not required.
export function hasAllWorkSampleTiers(samplesByTier, artifactsByTier) {
  const samples = samplesByTier || {};
  const artifacts = artifactsByTier || {};
  return WORK_SAMPLE_TIERS.every(tier => {
    const r = samples[tier];
    const hasPhoto = !!r && Array.isArray(r.photo_paths) && r.photo_paths.length > 0;
    const hasText = Array.isArray(artifacts[tier]) && artifacts[tier].length > 0;
    return hasPhoto || hasText;
  });
}

// ─── SCHEDULE STORAGE ────────────────────────────────────────────────────────
// Schedule: [{ course, teacher, subject }]
export function getSchedule() {
  // TM-2: in test mode, return the in-memory synthetic schedule built
  // from the teacher's own teacher_profiles rows. NEVER read localStorage
  // — that key belongs to the student persona on this browser.
  if (S.isTestMode) return S.testSchedule;
  try { return JSON.parse(localStorage.getItem('lumi_schedule') || '[]'); } catch { return []; }
}
export function saveScheduleLocal(s) { localStorage.setItem('lumi_schedule', JSON.stringify(s)); }

// TM-2: Build the teacher's own classes into a synthetic schedule shape
// for the sidebar to consume. Only called in test mode; result lives on
// S.testSchedule (in-memory only, never persisted). All courses appear
// here — the sidebar locks incomplete ones at render time (TM-3).
export async function loadTestModeSchedule() {
  if (!currentUser?.email) return;
  S.testSchedule = [];
  try {
    // Fail-visible: on fetch failure, log and bail — never render stale data.
    let data;
    try {
      data = await fetchTeacherProfilesByEmails([currentUser.email]);
    } catch (err) {
      console.error('[test-mode] teacher_profiles fetch failed:', err);
      return;
    }

    // TM-3: also pull work samples + text artifacts so we can decide which
    // classes are "ready to test" (= done + welcome_message + all 3 tiers
    // holding at least one artifact of any type). Locked classes still
    // appear in the sidebar but route to teacher.html for completion
    // instead of opening a chat.
    const profileIds = data.map(p => p.id).filter(Boolean);
    const samplesByProfile = {};
    const artifactsByProfile = {};
    if (profileIds.length) {
      const idsQs = profileIds.map(encodeURIComponent).join(',');
      let sampleRows = null;
      try {
        sampleRows = await rdsFetch(`work-samples?teacher_profile_ids=${idsQs}`);
      } catch (err) {
        console.warn('[test-mode] work_samples fetch failed:', err.message);
      }
      (sampleRows || []).forEach(r => {
        (samplesByProfile[r.teacher_profile_id] ||= {})[r.tier] = r;
      });
      let artifactRows = null;
      try {
        artifactRows = await rdsFetch(`work-artifacts?teacher_profile_ids=${idsQs}`);
      } catch (err) {
        console.warn('[test-mode] work_artifacts fetch failed:', err.message);
      }
      (artifactRows || []).forEach(r => {
        const byTier = (artifactsByProfile[r.teacher_profile_id] ||= {});
        (byTier[r.tier] ||= []).push(r);
      });
    }
    const hasAllTiers = (profileId) =>
      hasAllWorkSampleTiers(samplesByProfile[profileId], artifactsByProfile[profileId]);

    // Display name for synthetic schedule entries — prefer the session
    // full_name; fall back to the email local-part. Register the
    // name → email mapping so the existing getTeacherProfile lookup
    // path works without a special case for test mode.
    const fullName = currentUser.user_metadata?.full_name
      || currentUser.email.split('@')[0];
    // F2: register the pairing in the test-mode overlay instead of mutating the
    // shared TEACHER_EMAIL_MAP. resolveTeacherEmail (used by every lookup path)
    // consults the overlay first, so the existing getTeacherProfile flow works
    // unchanged without a special case.
    setTestModeTeacher(fullName, currentUser.email);
    S.testSchedule = data.map(row => ({
      course:  row.course_name,
      teacher: fullName,
      subject: row.subject || lookupSubjectForCourse(row.course_name).subjectName,
      block:   'TEST',
      // TM-3: ready iff fully onboarded — sidebar locks anything else
      // and routes the click back to teacher.html for completion.
      ready:   row.done === true
            && (row.welcome_message || '').trim().length > 0
            && hasAllTiers(row.id),
    }));
    const readyCount = S.testSchedule.filter(c => c.ready).length;
    console.log(`[test-mode] synthesized schedule: ${S.testSchedule.length} class(es), ${readyCount} ready`);
  } catch (e) {
    console.warn('[test-mode] schedule load failed:', e);
  }
}

export function syncScheduleToRds(schedule) {
  if (!currentUser) return;
  // TM-2: never write a teacher's synthetic schedule into their auth
  // user's profiles row — they're not a student.
  if (S.isTestMode) return;
  // Hardened (MIGRATION_HARDENING §2): awaited-in-promise with a real error
  // surface instead of console-only fire-and-forget.
  rdsFetch('profiles', { method: 'POST', body: {
    schedule,
    schedule_updated_at: new Date().toISOString(),
  } }).catch(err => {
    console.warn('Schedule sync error:', err);
    showToast('Could not sync your schedule — see console');
  });

  // Upsert enrollment rows so teachers can see their roster and write per-student notes.
  // Looks up teacher_profile IDs first — skips classes whose teacher hasn't onboarded yet.
  // Also prunes enrollments for classes the student has dropped (see syncEnrollments).
  syncEnrollments(schedule);
}

function syncEnrollments(schedule) {
  if (!currentUser) return;
  // TM-2: enrollment writes would put the teacher's auth.uid() into
  // class_enrollments.student_id and corrupt the roster. Hard skip.
  if (S.isTestMode) return;
  const studentName = localStorage.getItem('lumi_name') || '';
  const pairs = schedule
    .map(({ course, teacher, block }) => {
      const email = resolveTeacherEmail(teacher);
      if (!email) return null;
      if (!block) {
        console.warn('[enrollment] skipping class without block:', course);
        return null;
      }
      return { email, course, block };
    })
    .filter(Boolean);

  // Dropped-class cleanup: delete the caller's enrollment rows whose
  // (teacher_profile_id, block) is no longer in their schedule, so a class the
  // student removed disappears from the teacher's roster. `desiredKeys` is the
  // set of enrollments this sync intends to KEEP; anything the server still has
  // outside that set is pruned. Runs even when desiredKeys is empty (student
  // dropped everything). student_id is always the JWT user server-side, so a
  // student can only ever delete their OWN rows. NOTE: pruning trusts the
  // freshly-resolved desired set — the profile-fetch error branch bails before
  // we get here, so an empty desired set means "no current classes", not
  // "couldn't resolve them".
  const prune = (desiredKeys) =>
    rdsFetch('class-enrollments') // student-scope GET: caller's own rows only
      .then(current => {
        const drop = (current || []).filter(
          e => !desiredKeys.has(e.teacher_profile_id + '__' + e.block)
        );
        if (!drop.length) return 0;
        return Promise.all(drop.map(e =>
          rdsFetch(`class-enrollments?id=${encodeURIComponent(e.id)}`, { method: 'DELETE' })
        )).then(() => drop.length);
      })
      .then(n => { if (n) console.log('[enrollment] pruned', n, 'dropped class(es)'); })
      .catch(err => {
        console.error('Enrollment prune failed:', err);
        showToast('Could not remove dropped classes — see console');
      });

  // No resolvable classes left → desired set is empty → prune everything.
  const emails = [...new Set(pairs.map(p => p.email))];
  if (!emails.length) { prune(new Set()); return; }

  fetchTeacherProfilesByEmails(emails)
    .then(data => ({ data, error: null }), error => ({ data: null, error }))
    .then(({ data, error }) => {
      if (error) { console.error('Enrollment sync failed: could not load teacher profiles:', error); return; }
      // Build lookup: "email__course" → teacher_profile UUID
      const lookup = {};
      (data || []).forEach(p => { lookup[p.teacher_email + '__' + p.course_name] = p.id; });

      const rows = pairs
        .map(({ email, course, block }) => {
          const profileId = lookup[email + '__' + course];
          if (!profileId) return null;
          return { student_id: currentUser.id, teacher_profile_id: profileId, block, student_name: studentName };
        })
        .filter(Boolean);

      const desiredKeys = new Set(rows.map(r => r.teacher_profile_id + '__' + r.block));

      // Upsert the current set first, then prune whatever is no longer desired.
      // Hardened (§2): failure surfaces to the user. student_id in each row is
      // ignored server-side (always the JWT user).
      const upsert = rows.length
        ? rdsFetch('class-enrollments', { method: 'POST', body: rows })
            .then(res => console.log('[enrollment] synced', res?.upserted ?? rows.length, 'enrollment(s)'))
        : Promise.resolve();

      upsert
        .then(() => prune(desiredKeys))
        .catch(err => {
          console.error('Enrollment sync failed: upsert error:', err);
          showToast('Could not sync your class enrollments — see console');
        });
    })
    .catch(err => console.error('Enrollment sync failed:', err));
}

// ─── BOOT: one-round-trip student payload ────────────────────────────────────
// GET /bootstrap returns { profile, schedule, enrollments, availableClasses,
// recentConversations } — the same rows the individual routes return, from the
// same query functions. Resolves null when the deployed Lambda predates the
// route (404) or the call fails, in which case boot falls back to the
// individual calls. Student mode only: test mode never loads profile state.
export async function loadBootstrapFromRds() {
  if (!currentUser || S.isTestMode) return null;
  const t0 = performance.now();
  try {
    const data = await rdsFetch('bootstrap');
    if (CONFIG.debug) {
      console.log(`[boot] /bootstrap ${data ? 'hit' : '404 (fallback)'} in ${Math.round(performance.now() - t0)}ms`);
    }
    return data && typeof data === 'object' ? data : null;
  } catch (err) {
    console.warn('Bootstrap load failed (falling back to individual calls):', err);
    return null;
  }
}

// Load all conversations from RDS into localStorage (called once on fresh device).
// `prefetched` (from /bootstrap) replaces the GET when supplied.
export async function loadConvsFromRds({ prefetched } = {}) {
  if (!currentUser) return;
  try {
    // TM-2: filter by is_teacher_test so test convs never appear in
    // the student sidebar (and vice versa). The Lambda scopes rows to
    // the JWT user server-side.
    const data = prefetched !== undefined
      ? prefetched
      : await rdsFetch(`conversations?is_teacher_test=${!!S.isTestMode}`);
    if (!data || !data.length) return;

    const convs = {};
    data.forEach(row => {
      // PERF #3: the list endpoint is now lightweight — no `messages` blob, but
      // a server-computed `preview` + `exchange_count`. Prefer those; fall back
      // to deriving from `messages` for an older Lambda that still inlines them.
      const msgs = row.messages || [];
      const firstUser = msgs.find(m => m.role === 'user');
      const derivedPreview = typeof firstUser?.content === 'string'
        ? firstUser.content.slice(0, 60)
        : (Array.isArray(firstUser?.content)
            ? (firstUser.content.find(p => p.type === 'text')?.text || '').slice(0, 60)
            : '');
      const preview = (typeof row.preview === 'string' && row.preview) ? row.preview : derivedPreview;
      const exchangeCount = Number.isFinite(row.exchange_count)
        ? row.exchange_count
        : msgs.filter(m => m.role === 'assistant').length;
      // Reconstruct tutorCtx from teacher/course columns
      const tutorCtx = row.teacher && row.course
        ? { ...lookupSubjectForCourse(row.course), course: row.course, teacher: row.teacher }
        : null;

      // Use the RDS row UUID as both local ID and sbId
      const localId = 'sb_' + row.id.replace(/-/g, '').slice(0, 16);
      convs[localId] = {
        id:           localId,
        sbId:         row.id,
        ts:           new Date(row.created_at).getTime(),
        title:        row.title || null,
        preview:      preview || 'Chat',
        messages:     msgs,
        values:       [],
        goals:        [],
        interests:    [],
        exchangeCount,
        tutorCtx,
      };
    });
    saveConvs(convs);
  } catch (err) {
    console.warn('Conversation load failed (using localStorage):', err);
  }
}

// ─── CONVERSATION SYNC (INSERT first time, debounced PATCH after) ──────────────
// Creation (POST) is immediate so the row exists (and sbId is captured) before
// anything else depends on it. Subsequent updates are coalesced per conversation
// with a trailing debounce: a streaming reply calls saveCurrentConv many times,
// but only the last snapshot is worth a PATCH. Metadata edits (title, class)
// bypass the debounce so a rename / generated title lands promptly. Pending
// writes are flushed with `keepalive` when the tab hides or unloads, and a
// PATCH is skipped when the payload is byte-identical to the last one the
// server accepted. A failed PATCH leaves the payload pending so the next flush
// retries it.
export const CONV_SYNC_DEBOUNCE_MS = 1500;

const _convSyncTimers   = new Map(); // convId -> timeout handle
const _convSyncPending  = new Set(); // convIds with an unsent snapshot
const _convLastSynced   = new Map(); // convId -> serialized row last accepted by the server
const _convCreating     = new Map(); // convId -> in-flight POST promise
const _convPatching     = new Map(); // convId -> in-flight PATCH promise (writes are serialized per conv)

// Browsers cap the total body size of outstanding keepalive requests at 64 KiB;
// larger payloads are sent as a normal request instead of being rejected.
const KEEPALIVE_BODY_LIMIT = 60 * 1024;

function _convRow(conv) {
  return {
    user_id:         currentUser.id,
    title:           conv.title   || null,
    messages:        conv.messages,
    teacher:         conv.tutorCtx?.teacher || null,
    course:          conv.tutorCtx?.course  || null,
    // TM-2: stamps the row so admin queries / sidebar reads can split
    // teacher-test convs from real student convs. Default false in the
    // schema; only test-mode writes flip it to true.
    is_teacher_test: !!S.isTestMode,
  };
}

// Serialization used for the changed-since-last-write check (updated_at is
// added at send time and deliberately excluded here).
function _serializeRow(row) { return JSON.stringify(row); }

function _metaChanged(convId, row) {
  const last = _convLastSynced.get(convId);
  if (!last) return false;
  let prev;
  try { prev = JSON.parse(last); } catch { return true; }
  return prev.title !== row.title || prev.teacher !== row.teacher || prev.course !== row.course;
}

export function syncConvToRds(convId) {
  if (!currentUser) return;
  const conv = getConvs()[convId];
  if (!conv || !conv.messages.length) return;

  if (!conv.sbId && !_convCreating.has(convId)) {
    _createConv(convId).catch(err => console.warn('Conv sync:', err));
    return;
  }

  _convSyncPending.add(convId);
  if (conv.sbId && _metaChanged(convId, _convRow(conv))) {
    _clearConvTimer(convId);
    _patchConv(convId).catch(err => console.warn('Conv sync:', err));
    return;
  }
  _clearConvTimer(convId);
  _convSyncTimers.set(convId, setTimeout(() => {
    _convSyncTimers.delete(convId);
    _patchConv(convId).catch(err => console.warn('Conv sync:', err));
  }, CONV_SYNC_DEBOUNCE_MS));
}

function _clearConvTimer(convId) {
  const t = _convSyncTimers.get(convId);
  if (t !== undefined) { clearTimeout(t); _convSyncTimers.delete(convId); }
}

async function _createConv(convId) {
  const conv = getConvs()[convId];
  if (!conv) return;
  const row = _convRow(conv);
  const serialized = _serializeRow(row);
  const p = (async () => {
    let newId;
    try {
      const res = await rdsFetch('conversations', { method: 'POST', body: { ...row, updated_at: new Date().toISOString() } });
      newId = res?.id || null;
    } catch (err) { console.warn('Conversation insert error:', err); return; }
    if (!newId) return;
    const c2 = getConvs();
    if (c2[convId]) { c2[convId].sbId = newId; saveConvs(c2); }
    _convLastSynced.set(convId, serialized);
  })();
  _convCreating.set(convId, p);
  try { await p; } finally { _convCreating.delete(convId); }
  // Anything saved while the POST was in flight is now due as a PATCH.
  if (_convSyncPending.has(convId) && !_convSyncTimers.has(convId)) {
    _convSyncTimers.set(convId, setTimeout(() => {
      _convSyncTimers.delete(convId);
      _patchConv(convId).catch(err => console.warn('Conv sync:', err));
    }, CONV_SYNC_DEBOUNCE_MS));
  }
}

// Send the current snapshot of one conversation. `keepalive` is used by the
// hide/unload flush so the request outlives the document.
async function _patchConv(convId, opts = {}) {
  const creating = _convCreating.get(convId);
  if (creating) await creating;
  // One PATCH in flight per conversation: a save that lands mid-request waits
  // for it to settle, then sends the newest snapshot (no stale overwrite).
  // The unload flush cannot afford to wait (the document may be gone before
  // the earlier request settles), so it fires its keepalive request at once;
  // the row's updated_at lets the server-side history show which was newest.
  if (!opts.keepalive) { while (_convPatching.has(convId)) await _convPatching.get(convId); }
  const p = _patchConvNow(convId, opts);
  _convPatching.set(convId, p);
  try { await p; } finally { if (_convPatching.get(convId) === p) _convPatching.delete(convId); }
}

async function _patchConvNow(convId, { keepalive = false, budget = null } = {}) {
  const conv = getConvs()[convId];
  if (!conv || !conv.messages.length) { _convSyncPending.delete(convId); return; }
  if (!conv.sbId) {
    // Creation failed (or never happened) — retry the insert instead.
    _convSyncPending.delete(convId);
    if (!_convCreating.has(convId)) await _createConv(convId);
    return;
  }
  const row = _convRow(conv);
  const serialized = _serializeRow(row);
  if (_convLastSynced.get(convId) === serialized) { _convSyncPending.delete(convId); return; }

  // Lambda PATCH scopes to the JWT user server-side and 404s on an
  // unowned/unknown id (surfaced via the rdsFetch null → warn).
  const body = { id: conv.sbId, ...row, updated_at: new Date().toISOString() };
  const json = JSON.stringify(body);
  const bytes = new TextEncoder().encode(json).byteLength;
  // The keepalive quota is shared by every outstanding keepalive request, so a
  // flush of several conversations draws from one budget.
  const fits = bytes <= (budget ? budget.remaining : KEEPALIVE_BODY_LIMIT);
  if (keepalive && fits && budget) budget.remaining -= bytes;
  try {
    const res = keepalive && fits
      ? await _rdsPatchKeepalive('conversations', json)
      : await rdsFetch('conversations', { method: 'PATCH', body });
    if (!res) { console.warn('Conversation update error:', 'conversation not found (404)'); return; }
    _convLastSynced.set(convId, serialized);
    // Only clear if nothing newer was saved while the request was in flight.
    if (_serializeRow(_convRow(getConvs()[convId] || conv)) === serialized) _convSyncPending.delete(convId);
  } catch (err) {
    console.warn('Conversation update error:', err);
  }
}

// Same wire format as rdsFetch, plus `keepalive` so the browser lets the
// request complete after pagehide. Mirrors rdsFetch's 404 → null contract.
async function _rdsPatchKeepalive(path, json) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) throw new Error('rdsFetch: no session');
  const res = await fetch(`${CLAUDE_PROXY_URL}${path}`, {
    method: 'PATCH',
    keepalive: true,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: json,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

// Send every pending snapshot now (cancelling their timers). Used on tab hide /
// unload; safe to call any time.
export function flushPendingConvSyncs({ keepalive = true } = {}) {
  // In-flight creations count as pending: wait for the POST (and any PATCH
  // queued behind it) so sign-out / unload can't strand a brand-new thread.
  const ids = [...new Set([..._convSyncPending, ..._convCreating.keys()])];
  for (const id of ids) _clearConvTimer(id);
  const budget = { remaining: KEEPALIVE_BODY_LIMIT };
  return Promise.all(ids.map(async (id) => {
    try {
      const creating = _convCreating.get(id);
      if (creating) await creating;
      if (_convSyncPending.has(id) || _convPatching.has(id)) await _patchConv(id, { keepalive, budget });
    } catch (err) { console.warn('Conv sync:', err); }
  }));
}

export function hasPendingConvSync(convId) { return _convSyncPending.has(convId); }

// Wire the hide/unload flush. Called once at app boot.
export function initConvSyncFlush(doc = globalThis.document, win = globalThis.window) {
  const onHide = () => { flushPendingConvSyncs({ keepalive: true }); };
  doc?.addEventListener?.('visibilitychange', () => { if (doc.visibilityState === 'hidden') onHide(); });
  win?.addEventListener?.('pagehide', onHide);
}

// Test-only: drop all in-memory sync state.
export function __resetConvSyncState() {
  for (const id of _convSyncTimers.keys()) _clearConvTimer(id);
  _convSyncPending.clear();
  _convLastSynced.clear();
  _convCreating.clear();
  _convPatching.clear();
}

// Delete a conversation from RDS by its sbId
export function deleteConvFromRds(convId) {
  if (!currentUser) return;
  const convs = getConvs();
  const sbId  = convs[convId]?.sbId;
  if (!sbId) return;
  // Hardened (§2): failure now surfaces to the user, not just the console.
  rdsFetch(`conversations?id=${encodeURIComponent(sbId)}`, { method: 'DELETE' })
    .catch(err => {
      console.warn('Conversation delete error:', err);
      showToast('Could not delete the conversation on the server — see console');
    });
}

// Load profile from RDS on new device (only if localStorage has no name).
// `prefetched` (from /bootstrap; null = no row) replaces the GET when supplied.
export async function loadProfileFromRds({ prefetched } = {}) {
  if (!currentUser) return;
  // TM-2: this pulls student profile state (name, grade, schedule, etc.)
  // into localStorage. In test mode that would overwrite the browser's
  // student-persona state with the teacher's auth user record.
  if (S.isTestMode) return;
  const hasName = !!localStorage.getItem('lumi_name');
  try {
    // GET /profiles returns the caller's row as a single object; null on 404
    // (no profile yet).
    const data = prefetched !== undefined ? prefetched : await rdsFetch('profiles');
    if (!data) return;
    // Always restore name/grade (overwrite if the server copy is newer)
    if (!hasName && data.name)  localStorage.setItem('lumi_name',  data.name);
    if (!hasName && data.grade) localStorage.setItem('lumi_grade', data.grade);
    setSidebarUserSubtitle();
    if (data.schedule?.length && !localStorage.getItem('lumi_schedule'))
      localStorage.setItem('lumi_schedule', JSON.stringify(data.schedule));
    // Seed global values/goals/interests from profile (loaded conv will override for current session)
    if (data.values_profile) {
      const vp = data.values_profile;
      (vp.values    || []).forEach(v => S.values.add(v));
      (vp.goals     || []).forEach(g => S.goals.add(g));
      (vp.interests || []).forEach(i => S.interests.add(i));
    }
    // Restore new onboarding fields if not already set
    if (data.learning_style && !localStorage.getItem('lumi_learning_style'))
      localStorage.setItem('lumi_learning_style', data.learning_style);
    if (data.pain_points?.length && !localStorage.getItem('lumi_pain_points'))
      localStorage.setItem('lumi_pain_points', JSON.stringify(data.pain_points));
    if (data.typical_activities && !localStorage.getItem('lumi_activities'))
      localStorage.setItem('lumi_activities', data.typical_activities);
    if (data.homework_start_time && !localStorage.getItem('lumi_hw_start'))
      localStorage.setItem('lumi_hw_start', data.homework_start_time);
    if (data.study_style && !localStorage.getItem('lumi_study_style'))
      localStorage.setItem('lumi_study_style', JSON.stringify(data.study_style));
    if (data.onboarding_complete && !localStorage.getItem('lumi_onboarding_complete'))
      localStorage.setItem('lumi_onboarding_complete', 'true');
  } catch (err) {
    console.warn('Profile load failed:', err);
  }
}

// ─── CONVERSATION STORAGE ─────────────────────────────────────────────────────
export function genId() { return 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2,5); }
export function getConvs() {
  // TM-2: in test mode read from the in-memory cache; the lumi_convs
  // localStorage key belongs to the student persona on this browser.
  if (S.isTestMode) return S.testConvs;
  try { return JSON.parse(localStorage.getItem('lumi_convs') || '{}'); } catch { return {}; }
}
export function saveConvs(c) {
  if (S.isTestMode) { S.testConvs = c; return; }
  localStorage.setItem('lumi_convs', JSON.stringify(c));
}

export function saveCurrentConv() {
  if (!S.currentId) return;
  if (!S.messages.length) return;
  const convs   = getConvs();
  const existing = convs[S.currentId] || {};
  const firstUserMsg = S.messages.find(m => m.role === 'user');
  const previewText  = typeof firstUserMsg?.content === 'string'
    ? firstUserMsg.content
    : (Array.isArray(firstUserMsg?.content)
        ? (firstUserMsg.content.find(p => p.type === 'text')?.text || '')
        : '');
  convs[S.currentId] = {
    id:           S.currentId,
    sbId:         existing.sbId || null,    // preserve RDS row UUID across saves
    ts:           existing.ts || Date.now(),
    title:        existing.title || null,
    preview:      previewText.slice(0, 60) || 'New chat',
    messages:     S.messages,
    values:       [...S.values],
    goals:        [...S.goals],
    interests:    [...S.interests],
    exchangeCount: S.exchangeCount,
    tutorCtx:     S.tutorCtx,
  };
  // Cap at 50 conversations — remove oldest
  const keys = Object.keys(convs).sort((a, b) => convs[a].ts - convs[b].ts);
  if (keys.length > 50) keys.slice(0, keys.length - 50).forEach(k => delete convs[k]);
  saveConvs(convs);
  localStorage.setItem('lumi_current', S.currentId);
  syncConvToRds(S.currentId);
  // The class-view rail lists convs by title/preview, so a brand-new chat only
  // becomes visible once its first message is saved.
  try { document.dispatchEvent(new CustomEvent('lumi:conv-changed')); } catch { /* test env */ }
}

// ─── PHASE 5: ROLLING PROGRESS-NOTE FLUSH (best-effort session-end trigger) ────
// Summarize the just-ended class session into the student's rolling progress
// note (spec §3 trigger 1). Fires when the student leaves a session — New chat,
// opening another class, signing out. Fully server-gated + server-internal: a
// real student's tenant has persistence OFF, so this is a no-op write for them,
// and the note never comes back to the client. Skipped in test mode (a teacher
// persona must never write student-shaped state — the TM-2 checklist). Uses the
// server conversation id (sbId); if the session hasn't synced yet or has no
// class/substance, it silently does nothing. Tab-close (sendBeacon) is a
// documented follow-up — this covers the reliable in-app exit points.
export function flushProgressNote() {
  if (S.isTestMode) return;
  const tpid = S.tutorCtx?.notesInjection?.teacher_profile_id;
  if (!tpid || !S.currentId) return;
  const conv = getConvs()[S.currentId];
  const cid = conv?.sbId;
  if (!cid) return;                                                  // not yet persisted server-side
  if (!Array.isArray(conv.messages) || conv.messages.length < 2) return;  // nothing substantive to summarize
  rdsFetch('progress-note/flush', {
    method: 'POST',
    body: { teacher_profile_id: tpid, conversation_id: cid },
  }).catch(err => console.warn('[progress_note] flush:', err));
}

export function migrateOldData() {
  if (localStorage.getItem('lumi_convs')) return;
  const old = localStorage.getItem('lumi_data');
  if (!old) return;
  try {
    const data = JSON.parse(old);
    if (!data.messages?.length) return;
    const id = genId();
    const convs = {};
    convs[id] = {
      id, ts: Date.now(),
      preview: data.messages.find(m => m.role === 'user')?.content?.slice(0, 55) || 'Chat',
      messages: data.messages,
      values: data.values || [], goals: data.goals || [], interests: data.interests || [],
      exchangeCount: data.exchangeCount || 0, tutorCtx: null,
    };
    saveConvs(convs);
    localStorage.setItem('lumi_current', id);
    localStorage.removeItem('lumi_data');
  } catch { /* ignore */ }
}
