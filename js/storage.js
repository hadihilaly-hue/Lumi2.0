import { lookupSubjectForCourse } from './conversation.js';
import { setSidebarUserSubtitle } from './prompts.js';
import { S, currentUser } from './state.js';
import { TEACHER_EMAIL_MAP, fetchTeacherProfilesByEmails, rdsFetch } from './teachers.js';
import { showToast } from './ui.js';


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

    // TM-3: also pull work samples so we can decide which classes are
    // "ready to test" (= done + welcome_message + all 3 work-sample
    // tiers complete with photos and descriptions). Locked classes
    // still appear in the sidebar but route to teacher.html for
    // completion instead of opening a chat.
    const profileIds = data.map(p => p.id).filter(Boolean);
    const samplesByProfile = {};
    if (profileIds.length) {
      let sampleRows = null;
      try {
        sampleRows = await rdsFetch(`work-samples?teacher_profile_ids=${profileIds.map(encodeURIComponent).join(',')}`);
      } catch (err) {
        console.warn('[test-mode] work_samples fetch failed:', err.message);
      }
      (sampleRows || []).forEach(r => {
        (samplesByProfile[r.teacher_profile_id] ||= {})[r.tier] = r;
      });
    }
    const TIERS = ['progressing', 'proficient', 'exemplary'];
    const hasAllTiers = (profileId) => {
      const byTier = samplesByProfile[profileId];
      if (!byTier) return false;
      return TIERS.every(tier => {
        const r = byTier[tier];
        return r && Array.isArray(r.photo_paths) && r.photo_paths.length > 0
            && (r.description || '').trim().length > 0;
      });
    };

    // Display name for synthetic schedule entries — prefer the session
    // full_name; fall back to the email local-part. Register the
    // name → email mapping so the existing getTeacherProfile lookup
    // path works without a special case for test mode.
    const fullName = currentUser.user_metadata?.full_name
      || currentUser.email.split('@')[0];
    TEACHER_EMAIL_MAP[fullName] = currentUser.email;
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

export function syncScheduleToSupabase(schedule) {
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
  // TODO: No cleanup for dropped classes — old enrollment rows persist. Handle before shipping.
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
      const email = TEACHER_EMAIL_MAP[teacher];
      if (!email) return null;
      if (!block) {
        console.warn('[enrollment] skipping class without block:', course);
        return null;
      }
      return { email, course, block };
    })
    .filter(Boolean);
  if (!pairs.length) return;

  const emails = [...new Set(pairs.map(p => p.email))];
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
      if (!rows.length) return;

      // Hardened (§2): failure now surfaces to the user. student_id in each
      // row is ignored server-side (always the JWT user).
      rdsFetch('class-enrollments', { method: 'POST', body: rows })
        .then(res => console.log('[enrollment] synced', res?.upserted ?? rows.length, 'enrollment(s)'))
        .catch(err => {
          console.error('Enrollment sync failed: upsert error:', err);
          showToast('Could not sync your class enrollments — see console');
        });
    })
    .catch(err => console.error('Enrollment sync failed:', err));
}

// Load all conversations from Supabase into localStorage (called once on fresh device)
export async function loadConvsFromSupabase() {
  if (!currentUser) return;
  try {
    // TM-2: filter by is_teacher_test so test convs never appear in
    // the student sidebar (and vice versa). The Lambda scopes rows to
    // the JWT user server-side.
    const data = await rdsFetch(`conversations?is_teacher_test=${!!S.isTestMode}`);
    if (!data || !data.length) return;

    const convs = {};
    data.forEach(row => {
      const msgs = row.messages || [];
      // Derive preview from first user message
      const firstUser = msgs.find(m => m.role === 'user');
      const preview   = typeof firstUser?.content === 'string'
        ? firstUser.content.slice(0, 60)
        : (Array.isArray(firstUser?.content)
            ? (firstUser.content.find(p => p.type === 'text')?.text || '').slice(0, 60)
            : '');
      // Count exchanges from message pairs
      const exchangeCount = msgs.filter(m => m.role === 'assistant').length;
      // Reconstruct tutorCtx from teacher/course columns
      const tutorCtx = row.teacher && row.course
        ? { ...lookupSubjectForCourse(row.course), course: row.course, teacher: row.teacher }
        : null;

      // Use Supabase UUID as both local ID and sbId
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
    console.warn('Supabase conversation load failed (using localStorage):', err);
  }
}

// Sync a single conversation to Supabase — INSERT first time, UPDATE after
export function syncConvToSupabase(convId) {
  if (!currentUser) return;
  _doSyncConv(convId).catch(err => console.warn('Supabase conv sync:', err));
}

async function _doSyncConv(convId) {
  const convs = getConvs();
  const conv  = convs[convId];
  if (!conv || !conv.messages.length) return;

  const row = {
    user_id:         currentUser.id,
    title:           conv.title   || null,
    messages:        conv.messages,
    teacher:         conv.tutorCtx?.teacher || null,
    course:          conv.tutorCtx?.course  || null,
    // TM-2: stamps the row so admin queries / sidebar reads can split
    // teacher-test convs from real student convs. Default false in the
    // schema; only test-mode writes flip it to true.
    is_teacher_test: !!S.isTestMode,
    updated_at:      new Date().toISOString(),
  };

  if (conv.sbId) {
    // Already exists — update. Lambda PATCH scopes to the JWT user server-side
    // and 404s on an unowned/unknown id (surfaced via the rdsFetch null → warn).
    try {
      const res = await rdsFetch('conversations', { method: 'PATCH', body: { id: conv.sbId, ...row } });
      if (!res) console.warn('Conversation update error:', 'conversation not found (404)');
    } catch (err) { console.warn('Conversation update error:', err); }
  } else {
    // New conversation — insert and capture the UUID
    let newId = null;
    try {
      const res = await rdsFetch('conversations', { method: 'POST', body: row });
      newId = res?.id || null;
    } catch (err) { console.warn('Conversation insert error:', err); return; }
    if (newId) {
      // Store sbId back into local storage
      const c2 = getConvs();
      if (c2[convId]) { c2[convId].sbId = newId; saveConvs(c2); }
    }
  }
}

// Delete a conversation from Supabase by its sbId
export function deleteConvFromSupabase(convId) {
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

// Sync user profile (name, grade, accumulated values) to Supabase
function syncProfileToSupabase() {
  if (!currentUser) return;
  // TM-2: a teacher in test mode is not a student. Don't overwrite their
  // auth user record's profiles row with synthetic student fields.
  if (S.isTestMode) return;
  const name  = localStorage.getItem('lumi_name');
  const grade = localStorage.getItem('lumi_grade');
  const values_profile = {
    values:    [...S.values],
    goals:     [...S.goals],
    interests: [...S.interests],
  };
  // New onboarding fields
  const learning_style      = localStorage.getItem('lumi_learning_style') || null;
  const typical_activities  = localStorage.getItem('lumi_activities') || null;
  const homework_start_time = localStorage.getItem('lumi_hw_start') || null;
  const onboarding_complete = localStorage.getItem('lumi_onboarding_complete') === 'true';
  let pain_points = [];
  try { pain_points = JSON.parse(localStorage.getItem('lumi_pain_points') || '[]'); } catch {}
  let study_style = null;
  try { study_style = JSON.parse(localStorage.getItem('lumi_study_style') || 'null'); } catch {}

  const profileRow = {
    name:           name  || null,
    grade:          grade || null,
    values_profile,
    learning_style,
    pain_points,
    typical_activities,
    homework_start_time,
    study_style,
    onboarding_complete,
  };
  // Hardened (§2): real error surface. id comes from the JWT.
  rdsFetch('profiles', { method: 'POST', body: profileRow }).catch(err => {
    console.warn('Profile sync error:', err);
    showToast('Could not sync your profile — see console');
  });
}

// Load profile from Supabase on new device (only if localStorage has no name)
export async function loadProfileFromSupabase() {
  if (!currentUser) return;
  // TM-2: this pulls student profile state (name, grade, schedule, etc.)
  // into localStorage. In test mode that would overwrite the browser's
  // student-persona state with the teacher's auth user record.
  if (S.isTestMode) return;
  const hasName = !!localStorage.getItem('lumi_name');
  try {
    // GET /profiles returns the caller's row as a single object; null on 404
    // (no profile yet).
    const data = await rdsFetch('profiles');
    if (!data) return;
    // Always restore name/grade (overwrite if Supabase is newer)
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
    console.warn('Supabase profile load failed:', err);
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
    sbId:         existing.sbId || null,    // preserve Supabase UUID across saves
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
  syncConvToSupabase(S.currentId);
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
  } catch {}
}
