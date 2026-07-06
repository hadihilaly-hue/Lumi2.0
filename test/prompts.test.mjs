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
  // The teacher-notes placeholder only exists in the with-profile branch.
  assert.ok(!p.includes('<<LUMI_TEACHER_NOTES>>'));
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
  const p = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile());
  assert.match(p, /You are Lumi, acting as a 24\/7 digital version of Ms\. Huntley for their Chemistry class/);
  // Section headers use the teacher's FIRST name upper-cased.
  assert.match(p, /═══ HOW LAURA WANTS YOU TO HELP STUDENTS ═══\nENGAGE_RULES_MARKER/);
  assert.match(p, /═══ HOW LAURA TALKS AND TEACHES ═══\nTEACHING_VOICE_MARKER/);
  assert.match(p, /═══ ABOUT THIS COURSE ═══\nCOURSE_INFO_MARKER/);
});

test('buildTutorSystem includes the <<LUMI_TEACHER_NOTES>> injection marker', () => {
  // Per-student teacher notes are spliced in downstream at this marker; the
  // assembled prompt must carry it for that injection to land.
  const p = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile());
  assert.ok(p.includes('<<LUMI_TEACHER_NOTES>>'));
});

test('buildTutorSystem shows placeholders when persona fields are missing', () => {
  const p = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', { title: 'Ms.' });
  assert.match(p, /\(No rules specified\)/);
  assert.match(p, /\(No voice specified\)/);
  assert.match(p, /\(No course info\)/);
});

test('buildTutorSystem appends the syllabus section only when syllabus_text is present', () => {
  const withSyl = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile({ syllabus_text: 'SYLLABUS_MARKER' }));
  assert.match(withSyl, /═══ COURSE SYLLABUS ═══\nSYLLABUS_MARKER/);

  const withoutSyl = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile());
  assert.ok(!withoutSyl.includes('COURSE SYLLABUS'));
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
  const p = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile(), completeSamples());
  assert.match(p, /═══ HOW LAURA GIVES FEEDBACK ═══/);
  assert.match(p, /PROGRESSING_MARKER/);
  assert.match(p, /PROFICIENT_MARKER/);
  assert.match(p, /EXEMPLARY_MARKER/);
});

test('buildTutorSystem omits the feedback section when a tier is missing images', () => {
  const partial = completeSamples();
  partial.exemplary.images = []; // no loaded images → tier incomplete
  const p = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile(), partial);
  assert.ok(!p.includes('GIVES FEEDBACK'));
  assert.ok(!p.includes('PROGRESSING_MARKER'));
});

test('buildTutorSystem omits the feedback section when a tier is missing a description', () => {
  const partial = completeSamples();
  partial.proficient.description = '   '; // blank after trim → tier incomplete
  const p = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile(), partial);
  assert.ok(!p.includes('GIVES FEEDBACK'));
});

test('buildTutorSystem omits the feedback section when workSamples is null (default)', () => {
  const p = buildTutorSystem('Science', 'Chemistry', 'Laura Huntley', fullProfile());
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
