// Pure admin-dashboard logic: roster derivation from teacher_profiles rows,
// per-class status, and the headline stats. No DOM, no fetch.

export function profileKey(email, course) {
  return `${email}|${course}`;
}

// Index GET /teacher-profile?scope=all rows by "email|course".
export function indexProfiles(rows) {
  const out = {};
  (rows || []).forEach(row => { out[profileKey(row.teacher_email, row.course_name)] = row; });
  return out;
}

// email → display name from the runtime directory (inverse of TEACHER_EMAIL_MAP).
export function emailToName(email, emailMap = {}) {
  for (const [name, e] of Object.entries(emailMap || {})) {
    if (String(e).toLowerCase() === email.toLowerCase()) return name;
  }
  return email.split('@')[0];
}

// Build the { email: { name, classes } } roster from the loaded profile rows.
// Every provisioned class has a row (SIS stub or completed onboarding), so the
// profiles ARE the full expected roster.
export function buildTeacherDatabase(profiles, emailMap = {}) {
  const db = {};
  for (const key of Object.keys(profiles || {})) {
    const row = profiles[key];
    const email = row.teacher_email;
    if (!email) continue;
    if (!db[email]) db[email] = { name: emailToName(email, emailMap), classes: [] };
    if (!db[email].classes.includes(row.course_name)) db[email].classes.push(row.course_name);
  }
  Object.values(db).forEach(t => t.classes.sort((a, b) => a.localeCompare(b)));
  return db;
}

// Subject is not derivable from teacher_profiles (no subject column).
export function lookupSubjectForCourse() {
  return 'General';
}

export function getStatus(profiles, email, course) {
  const row = (profiles || {})[profileKey(email, course)];
  if (!row) return 'not_started';
  if (row.done) return 'complete';
  // SIS import creates a row per class before the teacher has typed anything,
  // so "row exists" alone is not progress — the wizard's first answers are.
  const started = (row.engagement_rules || '').trim() || (row.teaching_voice || '').trim();
  return started ? 'in_progress' : 'not_started';
}

export function statusLabel(s) {
  return s === 'complete' ? 'Complete' : s === 'in_progress' ? 'In Progress' : 'Not Started';
}

// Stats across ALL teachers (never filtered by the search box).
export function computeStats(teacherDb, profiles) {
  let total = 0, complete = 0, inProgress = 0, notStarted = 0;
  for (const [email, teacher] of Object.entries(teacherDb || {})) {
    for (const course of teacher.classes) {
      total++;
      const s = getStatus(profiles, email, course);
      if (s === 'complete') complete++;
      else if (s === 'in_progress') inProgress++;
      else notStarted++;
    }
  }
  return { total, complete, inProgress, notStarted };
}

export function filterTeachers(teacherDb, query) {
  const q = String(query || '').toLowerCase().trim();
  return Object.entries(teacherDb || {})
    .filter(([, t]) => !q || t.name.toLowerCase().includes(q))
    .sort(([, a], [, b]) => a.name.localeCompare(b.name));
}

export function initialsOf(name) {
  return String(name || '').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
}

export function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
