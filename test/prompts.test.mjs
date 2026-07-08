// js/prompts.js — system-prompt assembly + teacher display helpers.
//
// buildTutorSystem / buildCompanionSystem call studentCtx() internally, which
// pulls from localStorage (name, grade, schedule, learning style, …) and from
// homework.js helpers. With empty localStorage those helpers return their
// documented defaults (study style = 25/5 Short Bursts; hwContext/activeHwForClass
// = ''), so prompt output is deterministic here. Two prompts.js functions are
// DOM-touching (setSidebarUserSubtitle, updateTestModeBanner) — only their
// null-DOM guard paths are asserted (they must not throw when the element is
// absent, which is what the offline document stub gives).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getStudentName,
  teacherDisplayName,
  teacherInitials,
  buildCompanionSystem,
  buildTutorSystem,
  setSidebarUserSubtitle,
  updateTestModeBanner,
} from '../js/prompts.js';
import { S } from '../js/state.js';
import { reset, seedLocalStorage } from './harness.mjs';

beforeEach(() => reset());

// Feature H (prompt caching): the PROFILE branch of buildTutorSystem now returns
// an ARRAY of content blocks ([{text:SEG1, cache_control:{...}}, {text:SEG2}]);
// buildCompanionSystem and the no-profile fallback still return plain strings.
// systemText() flattens either shape into the effective delivered prompt (blocks
// concatenated in order, exactly as Bedrock concatenates system blocks), so the
// existing content assertions below can stay shape-agnostic.
const systemText = (s) => (Array.isArray(s) ? s.map((b) => b.text).join('') : s);

// ── getStudentName ───────────────────────────────────────────────────────────
test('getStudentName returns the stored name, or "there" as fallback', () => {
  assert.equal(getStudentName(), 'there');
  seedLocalStorage({ lumi_name: 'Sam' });
  assert.equal(getStudentName(), 'Sam');
});

// ── teacherDisplayName ───────────────────────────────────────────────────────
test('teacherDisplayName uses title + last name when a title is present', () => {
  assert.equal(teacherDisplayName('Richard Harris', { title: 'Mr.' }), 'Mr. Harris');
  assert.equal(teacherDisplayName('Laura Huntley', { title: 'Ms.' }), 'Ms. Huntley');
});

test('teacherDisplayName falls back to last name with no/empty profile', () => {
  assert.equal(teacherDisplayName('Richard Harris', null), 'Harris');
  assert.equal(teacherDisplayName('Richard Harris', {}), 'Harris');
  assert.equal(teacherDisplayName('Madonna', null), 'Madonna');
});

// ── teacherInitials ──────────────────────────────────────────────────────────
test('teacherInitials: first + last initial for multi-part names', () => {
  assert.equal(teacherInitials('Richard Harris'), 'RH');
  assert.equal(teacherInitials('mary jane watson'), 'MW'); // first + last only
});

test('teacherInitials: single initial for one-word names', () => {
  assert.equal(teacherInitials('Madonna'), 'M');
});

test('teacherInitials: ✦ sentinel for empty / whitespace / non-string', () => {
  assert.equal(teacherInitials(''), '✦');
  assert.equal(teacherInitials('   '), '✦');
  assert.equal(teacherInitials(null), '✦');
  assert.equal(teacherInitials(undefined), '✦');
  assert.equal(teacherInitials(12345), '✦');
});

// ── buildCompanionSystem (general chat persona) ──────────────────────────────
test('buildCompanionSystem injects the student name + grade line', () => {
  seedLocalStorage({ lumi_name: 'Alex', lumi_grade: '11' });
  const p = buildCompanionSystem();
  assert.match(p, /The student's name is Alex and they are in grade 11 at Menlo School\./);
});

test('buildCompanionSystem uses the generic student line when no name is set', () => {
  const p = buildCompanionSystem();
  assert.match(p, /The student attends Menlo School\./);
});

test('buildCompanionSystem folds in schedule, learning style, pain points, and study-style defaults', () => {
  seedLocalStorage({
    lumi_name: 'Alex',
    lumi_grade: '10',
    lumi_schedule: [{ course: 'Chemistry', teacher: 'Laura Huntley' }],
    lumi_learning_style: 'socratic',
    lumi_pain_points: ['timed tests', 'essays'],
  });
  const p = buildCompanionSystem();
  assert.match(p, /Schedule: Chemistry \(Laura Huntley\)\./);
  assert.match(p, /Learning style: learns best through guiding questions\./);
  assert.match(p, /Areas that need extra support[^\n]*: timed tests, essays\./);
  // Default study style (no lumi_study_style stored).
  assert.match(p, /Study style: 25 min work \/ 5 min break \(Short Bursts\)\./);
  assert.match(p, /Bedtime: 10:30 PM/);
});

test('buildCompanionSystem carries the teaching philosophy and the hidden JSON footer', () => {
  const p = buildCompanionSystem();
  assert.match(p, /CRITICAL TEACHING PHILOSOPHY/);
  assert.match(p, /\{"values":\["\.\.\."\],"goals":\["\.\.\."\],"interests":\["\.\.\."\]\}/);
});

// ── buildTutorSystem — no profile (generic fallback) ─────────────────────────
test('buildTutorSystem without a profile returns the generic tutor prompt', () => {
  const p = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', null);
  assert.match(p, /You are tutoring a Menlo School student in Chemistry with Huntley\./);
  assert.match(p, /CRITICAL TEACHING PHILOSOPHY/);
  // The teacher-notes + progress-note placeholders only exist in the
  // with-profile branch.
  assert.ok(!p.includes('<<LUMI_TEACHER_NOTES>>'));
  assert.ok(!p.includes('<<LUMI_PROGRESS_NOTE>>'));
  // No persona sections without a profile.
  assert.ok(!p.includes('═══ HOW'));
});

// ── buildTutorSystem — with profile (persona + notes injection) ──────────────
function fullProfile(overrides = {}) {
  return {
    title: 'Ms.',
    engagement_rules: 'ENGAGE_RULES_MARKER',
    teaching_voice: 'TEACHING_VOICE_MARKER',
    course_info: 'COURSE_INFO_MARKER',
    ...overrides,
  };
}

test('buildTutorSystem injects the teacher persona (display name + all three sections)', () => {
  const p = systemText(buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile()));
  assert.match(p, /You are Lumi, Ms\. Huntley's 24\/7 digital stand-in for their Chemistry class/);
  // Section headers use the teacher's FIRST name upper-cased.
  assert.match(p, /═══ HOW LAURA WANTS YOU TO HELP STUDENTS ═══\nENGAGE_RULES_MARKER/);
  assert.match(p, /═══ HOW LAURA TALKS AND TEACHES ═══\nTEACHING_VOICE_MARKER/);
  assert.match(p, /═══ ABOUT THIS COURSE ═══\nCOURSE_INFO_MARKER/);
});

test('buildTutorSystem includes the <<LUMI_TEACHER_NOTES>> injection marker', () => {
  // Per-student teacher notes are spliced in downstream at this marker; the
  // assembled prompt must carry it for that injection to land.
  const p = systemText(buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile()));
  assert.ok(p.includes('<<LUMI_TEACHER_NOTES>>'));
});

test('buildTutorSystem includes the <<LUMI_WORK_ARTIFACTS>> marker, before the notes marker', () => {
  // Q4 v2: text artifacts are injected server-side at this marker. It must be
  // present in the profile branch and sit in the teacher-stable prefix BEFORE
  // the per-student notes marker (cache-stability, D9).
  const p = systemText(buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile()));
  assert.ok(p.includes('<<LUMI_WORK_ARTIFACTS>>'));
  assert.ok(p.indexOf('<<LUMI_WORK_ARTIFACTS>>') < p.indexOf('<<LUMI_TEACHER_NOTES>>'));
});

test('buildTutorSystem omits the <<LUMI_WORK_ARTIFACTS>> marker without a profile', () => {
  // The generic fallback branch carries no injection markers.
  const p = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', null);
  assert.ok(!p.includes('<<LUMI_WORK_ARTIFACTS>>'));
});

test('buildTutorSystem includes the <<LUMI_PROGRESS_NOTE>> marker in the dynamic tail', () => {
  // Phase 5: the rolling progress note is spliced server-side at this marker.
  // Per docs/PROMPT_CACHING_PLAN.md §3c it must sit immediately AFTER the
  // teacher-notes marker (both in the SEG2 dynamic tail) so the caching split
  // never invalidates the cached static prefix.
  const p = systemText(buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile()));
  assert.ok(p.includes('<<LUMI_PROGRESS_NOTE>>'));
  assert.ok(p.indexOf('<<LUMI_PROGRESS_NOTE>>') > p.indexOf('<<LUMI_TEACHER_NOTES>>'));
  // No dynamic student data may follow the markers except the fixed JSON footer.
  assert.match(p.slice(p.indexOf('<<LUMI_PROGRESS_NOTE>>')), /After EVERY reply, append this JSON/);
});

test('buildTutorSystem shows placeholders when persona fields are missing', () => {
  const p = systemText(buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', { title: 'Ms.' }));
  assert.match(p, /\(No rules specified\)/);
  assert.match(p, /\(No voice specified\)/);
  assert.match(p, /\(No course info\)/);
});

test('buildTutorSystem appends the syllabus section only when syllabus_text is present', () => {
  const withSyl = systemText(buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile({ syllabus_text: 'SYLLABUS_MARKER' })));
  assert.match(withSyl, /═══ COURSE SYLLABUS ═══\nSYLLABUS_MARKER/);

  const withoutSyl = systemText(buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile()));
  assert.ok(!withoutSyl.includes('COURSE SYLLABUS'));
});

// ── buildTutorSystem — Feature H SEG1/SEG2 split (prompt caching) ─────────────
test('buildTutorSystem profile branch returns a 2-block array with ONE cache_control breakpoint at the SEG1/SEG2 boundary', () => {
  const sys = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile());
  assert.ok(Array.isArray(sys), 'profile branch returns an array');
  assert.equal(sys.length, 2);
  assert.equal(sys[0].type, 'text');
  assert.equal(sys[1].type, 'text');
  // Exactly one breakpoint, on SEG1 (the cached prefix).
  assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' });
  assert.ok(!('cache_control' in sys[1]), 'SEG2 carries no breakpoint');
});

test('buildTutorSystem companion + no-profile branches stay plain strings (cache-exempt)', () => {
  assert.equal(typeof buildCompanionSystem(), 'string');
  assert.equal(typeof buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', null), 'string');
});

test('SEG1 is byte-stable across two different students of the same class', () => {
  // The whole point of the split: student identity/context lives in SEG2, so
  // SEG1 (the cached prefix) must be IDENTICAL for two different students who
  // open the same teacher/class — otherwise the cross-student cache never hits.
  seedLocalStorage({
    lumi_name: 'Alice', lumi_grade: '9',
    lumi_learning_style: 'socratic', lumi_pain_points: ['essays'],
    lumi_schedule: [{ course: 'Chemistry', teacher: 'Laura Huntley' }],
  });
  const seg1A = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile({ syllabus_text: 'SYL' }))[0].text;

  reset();
  seedLocalStorage({
    lumi_name: 'Bob', lumi_grade: '12',
    lumi_learning_style: 'step_by_step', lumi_pain_points: ['timed tests'],
    lumi_schedule: [{ course: 'Chemistry', teacher: 'Laura Huntley' }],
  });
  const seg1B = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile({ syllabus_text: 'SYL' }))[0].text;

  assert.equal(seg1A, seg1B, 'SEG1 must not vary with the student');
  // Sanity: SEG1 really is the teacher-stable prefix and carries the marker.
  assert.match(seg1A, /You are Lumi, Ms\. Huntley's/);
  assert.ok(seg1A.includes('<<LUMI_WORK_ARTIFACTS>>'));
});

test('all dynamic (per-student) content lives in SEG2, never in SEG1', () => {
  seedLocalStorage({
    lumi_name: 'Alice', lumi_grade: '9',
    lumi_pain_points: ['essays'],
    lumi_schedule: [{ course: 'Chemistry', teacher: 'Laura Huntley' }],
  });
  const [seg1, seg2] = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile());
  // studentCtx() output (name, grade, schedule, pain points, study style,
  // bedtime) must be in SEG2, not the cached SEG1.
  assert.ok(!seg1.text.includes('Alice'), 'student name must not appear in SEG1');
  assert.ok(!seg1.text.includes('grade 9'), 'grade must not appear in SEG1');
  assert.ok(!seg1.text.includes('Bedtime'), 'student context must not appear in SEG1');
  assert.match(seg2.text, /The student's name is Alice and they are in grade 9/);
  assert.match(seg2.text, /Bedtime: 10:30 PM/);
  // The per-student injection markers also live only in SEG2.
  assert.ok(!seg1.text.includes('<<LUMI_TEACHER_NOTES>>'));
  assert.ok(!seg1.text.includes('<<LUMI_PROGRESS_NOTE>>'));
  assert.ok(seg2.text.includes('<<LUMI_TEACHER_NOTES>>'));
  assert.ok(seg2.text.includes('<<LUMI_PROGRESS_NOTE>>'));
});

// ── buildTutorSystem — graded work-samples gating (Q4) ───────────────────────
function completeSamples() {
  return {
    progressing: { description: 'PROGRESSING_MARKER', images: [{ src: 'a' }] },
    proficient: { description: 'PROFICIENT_MARKER', images: [{ src: 'b' }] },
    exemplary: { description: 'EXEMPLARY_MARKER', images: [{ src: 'c' }] },
  };
}

test('buildTutorSystem includes the feedback section when all three tiers are complete', () => {
  const p = systemText(buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile(), completeSamples()));
  assert.match(p, /═══ HOW LAURA GIVES FEEDBACK ═══/);
  assert.match(p, /PROGRESSING_MARKER/);
  assert.match(p, /PROFICIENT_MARKER/);
  assert.match(p, /EXEMPLARY_MARKER/);
});

test('buildTutorSystem omits the feedback section when a tier is missing images', () => {
  const partial = completeSamples();
  partial.exemplary.images = []; // no loaded images → tier incomplete
  const p = systemText(buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile(), partial));
  assert.ok(!p.includes('GIVES FEEDBACK'));
  assert.ok(!p.includes('PROGRESSING_MARKER'));
});

test('buildTutorSystem omits the feedback section when a tier is missing a description', () => {
  const partial = completeSamples();
  partial.proficient.description = '   '; // blank after trim → tier incomplete
  const p = systemText(buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile(), partial));
  assert.ok(!p.includes('GIVES FEEDBACK'));
});

test('buildTutorSystem omits the feedback section when workSamples is null (default)', () => {
  const p = systemText(buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile()));
  assert.ok(!p.includes('GIVES FEEDBACK'));
});

// ── DOM-guarded prompt helpers: only the null-DOM safety path ─────────────────
test('setSidebarUserSubtitle does not throw when the element is absent', () => {
  seedLocalStorage({ lumi_grade: '11' });
  assert.doesNotThrow(() => setSidebarUserSubtitle());
});

test('updateTestModeBanner is a no-op outside test mode and safe with no element', () => {
  assert.doesNotThrow(() => updateTestModeBanner('Chemistry')); // not test mode → early return
  S.isTestMode = true;
  assert.doesNotThrow(() => updateTestModeBanner('Chemistry')); // element absent → guarded return
});
