// Pure, unit-tested helpers that reconcile a student-schedule course string
// (e.g. "US History (H)", saved in lumi_schedule) with the canonical
// `course_name` on teacher_profiles (surfaced live via GET /available-classes).
//
// The mismatch: MENLO_CURRICULUM and the SIS/teacher-onboarding side name the
// same class differently ("US History (H)" vs "US History"; "CS1: Intro to
// Computer Science" vs "Intro to Computer Science"; roman-numeral variants;
// trailing honors parentheticals). A student schedule saved before the wizard
// switched to /available-classes (or with an "Add a class" pick from a
// pre-populated MENLO_CURRICULUM entry) will not find its teacher profile by
// exact-match, and openTutor renders "hasn't set up their Lumi profile yet"
// even though the profile exists in RDS.
//
// This module never invents matches. It walks three tiers and stops at the
// first hit:
//   1. exact string
//   2. normalized (lowercase, trim, collapse whitespace, strip a single
//      trailing parenthetical) — resolves "US History (H)" → "US History"
//      only if the DB has "US History"
//   3. curated alias table (schedule-key → canonical-key, both normalized) —
//      a deliberate override for genuine renames like MENLO_CURRICULUM's
//      "CS1: Intro to Computer Science" mapping to the DB's "Intro to
//      Computer Science".
//
// If none match, resolveCanonicalCourse returns null — the caller is expected
// to render the class in the locked / "setting up" state and log a diagnostic,
// never to silently fall back to a different course. "English 2" must NOT be
// coerced into "English 10".

/**
 * Normalize a course name for comparison. Lowercase, collapse whitespace,
 * strip a single trailing parenthetical (honors/level suffix), trim.
 * Pure.
 */
export function normalizeCourseKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s*\([^()]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Curated schedule → canonical alias table (both sides normalized via
 * normalizeCourseKey). Only add an entry when two names refer to the SAME
 * class under different naming conventions. Never add "English 2 → English
 * 10" style guesses.
 *
 * Kept small on purpose: extend after real user data surfaces via
 * findUnresolvedScheduleCourses' diagnostic output, and only when a rename
 * is unambiguous.
 */
export const COURSE_ALIASES = new Map([
  // MENLO_CURRICULUM prefixes CS courses; DB drops the prefix.
  ['cs1: intro to computer science', 'intro to computer science'],
  ['cs2: data structures & algorithms', 'data structures & algorithms'],
  // Roman-numeral ↔ arabic-numeral (the DB uses roman for a few subjects).
  ['algebra 2', 'algebra ii'],
  ['algebra 2 with trig', 'algebra ii with trig'],
  ['spanish 2', 'spanish ii'],
  ['spanish 1', 'spanish i'],
  ['english 2', 'english ii'],
  ['english 1', 'english i'],
]);

/**
 * Resolve a schedule-side course string to the canonical course_name from
 * a list of available-classes rows (each has a `course_name` field).
 *
 * Returns { canonicalCourse, matchType, subject } where matchType is one of
 *   'exact' | 'normalized' | 'alias'
 * and `subject` is the row's `subject` field (may be null).
 *
 * Returns null when no tier hits — the caller must NOT fall back to a
 * fuzzy guess. Alias resolution is symmetric: an alias entry works whether
 * the schedule side or the DB side is written the "long" way.
 *
 * Pure. Deterministic. First match wins (rows are searched in the order
 * given by the caller).
 */
export function resolveCanonicalCourse(scheduleCourse, availableRows) {
  if (!scheduleCourse) return null;
  if (!Array.isArray(availableRows) || availableRows.length === 0) return null;

  // Tier 1 — exact match on the raw string.
  const exact = availableRows.find(r => r && r.course_name === scheduleCourse);
  if (exact) return { canonicalCourse: exact.course_name, matchType: 'exact', subject: exact.subject || null };

  const scheduleNorm = normalizeCourseKey(scheduleCourse);

  // Tier 2 — normalized comparison (case, whitespace, trailing parenthetical).
  const normHit = availableRows.find(r => r && normalizeCourseKey(r.course_name) === scheduleNorm);
  if (normHit) return { canonicalCourse: normHit.course_name, matchType: 'normalized', subject: normHit.subject || null };

  // Tier 3 — curated alias. The alias table is written schedule-key →
  // canonical-key, but we check the reverse direction too so a schedule that
  // happens to already use the DB's "short" form still resolves back to a
  // DB row named the "long" way.
  const forwardTarget = COURSE_ALIASES.get(scheduleNorm);
  if (forwardTarget) {
    const hit = availableRows.find(r => r && normalizeCourseKey(r.course_name) === forwardTarget);
    if (hit) return { canonicalCourse: hit.course_name, matchType: 'alias', subject: hit.subject || null };
  }
  for (const [key, target] of COURSE_ALIASES) {
    if (target === scheduleNorm) {
      const hit = availableRows.find(r => r && normalizeCourseKey(r.course_name) === key);
      if (hit) return { canonicalCourse: hit.course_name, matchType: 'alias', subject: hit.subject || null };
    }
  }

  return null;
}

/**
 * Diagnostic helper: given a schedule course and the available-classes rows,
 * return up to `limit` candidate `course_name`s ordered by a cheap
 * character-overlap score. Never used to auto-resolve — only for a
 * console.warn footprint so a developer can eyeball drift and decide whether
 * a new COURSE_ALIASES entry is warranted.
 *
 * The score is |intersection of normalized-word sets| / |union of normalized
 * word sets|. Ties are broken by the row order in `availableRows` (stable).
 */
export function closestCourseCandidates(scheduleCourse, availableRows, limit = 3) {
  if (!scheduleCourse || !Array.isArray(availableRows) || availableRows.length === 0) return [];
  const scheduleWords = new Set(normalizeCourseKey(scheduleCourse).split(' ').filter(Boolean));
  if (scheduleWords.size === 0) return [];
  const scored = availableRows
    .filter(r => r && r.course_name)
    .map((r, i) => {
      const words = new Set(normalizeCourseKey(r.course_name).split(' ').filter(Boolean));
      let inter = 0;
      for (const w of scheduleWords) if (words.has(w)) inter++;
      const union = new Set([...scheduleWords, ...words]).size;
      const score = union === 0 ? 0 : inter / union;
      return { name: r.course_name, score, idx: i };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .slice(0, limit)
    .map(s => s.name);
  return scored;
}

/**
 * Bulk diagnostic: return every schedule entry that resolveCanonicalCourse
 * can't reconcile, each paired with its closest candidates. Order is the
 * order of `scheduleEntries`.
 *
 * `scheduleEntries` is the shape { course, teacher } stored in
 * getSchedule(); we only read `course`.
 */
export function findUnresolvedScheduleCourses(scheduleEntries, availableRows) {
  const out = [];
  for (const entry of scheduleEntries || []) {
    const course = entry && entry.course;
    if (!course) continue;
    const resolved = resolveCanonicalCourse(course, availableRows);
    if (resolved) continue;
    out.push({
      scheduleCourse: course,
      teacher: (entry && entry.teacher) || null,
      candidates: closestCourseCandidates(course, availableRows, 3),
    });
  }
  return out;
}
