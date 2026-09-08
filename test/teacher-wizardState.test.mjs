import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_WORDS, WELCOME_MIN_CHARS, WELCOME_SOFT_LIMIT,
  countWords, wordCountStatus, charCountStatus,
  isStepValid, nextStepFrom, prevStepFrom, firstInvalidStep,
  tierHasArtifact, missingTiers, hasAllWorkSampleTiers, missingTiersLabel,
  remainingPhotoSlots, isHeicFile, isSupportedImageType, summarizeTier, tierHasSampleContent,
  classStatus, filterClasses,
  parseNotes, sortByLastName, groupBy,
  classSlug, cleanFileName, formatFileSize, baseName, syllabusSummaryText, combineSyllabusText,
  parseSuggestedPrompts, escHtml,
} from '../js/teacher/wizardState.js';
import { TOTAL_STEPS, REVIEW_STEP, WORK_SAMPLES_STEP } from '../js/teacher/config.js';

const words = n => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

// ─── word gate (steps 1–3) ───────────────────────────────────────────────────
test('countWords ignores surrounding/duplicate whitespace and empty input', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords(null), 0);
  assert.equal(countWords('  one   two\nthree  '), 3);
});

test('wordCountStatus enables Continue at exactly MIN_WORDS (50)', () => {
  assert.equal(MIN_WORDS, 50);
  const under = wordCountStatus(words(49));
  assert.equal(under.enabled, false);
  assert.equal(under.label, '49 of 50 words — keep going');
  assert.equal(wordCountStatus('').label, '0 of 50 words');
  const met = wordCountStatus(words(50));
  assert.equal(met.enabled, true);
  assert.equal(met.label, '50 words');
});

test('wordCountStatus step 1 additionally requires a title', () => {
  const noTitle = wordCountStatus(words(60), { requireTitle: true, titleValue: '' });
  assert.equal(noTitle.enabled, false);
  assert.match(noTitle.label, /choose how students address you/);
  const withTitle = wordCountStatus(words(60), { requireTitle: true, titleValue: 'Ms.' });
  assert.equal(withTitle.enabled, true);
  assert.equal(withTitle.label, '60 words');
});

// ─── char gate (step 4 welcome message) ──────────────────────────────────────
test('charCountStatus: 80-char hard minimum, 600 soft cap never blocks', () => {
  assert.equal(WELCOME_MIN_CHARS, 80);
  assert.equal(WELCOME_SOFT_LIMIT, 600);
  const short = charCountStatus('a'.repeat(79));
  assert.equal(short.enabled, false);
  assert.equal(short.label, '79 characters — at least 80 needed');
  assert.equal(charCountStatus('a').label, '1 character — at least 80 needed');
  const ok = charCountStatus('a'.repeat(80));
  assert.equal(ok.enabled, true);
  assert.equal(ok.overSoftLimit, false);
  assert.equal(ok.label, '80 / 600 characters');
  const long = charCountStatus('a'.repeat(601));
  assert.equal(long.enabled, true);
  assert.equal(long.overSoftLimit, true);
  assert.equal(long.label, '601 / 600 characters — long for a first read');
});

// ─── step navigation ─────────────────────────────────────────────────────────
test('step constants and bounds', () => {
  assert.equal(TOTAL_STEPS, 6);
  assert.equal(WORK_SAMPLES_STEP, 5);
  assert.equal(REVIEW_STEP, 6);
  assert.equal(isStepValid(0), false);
  assert.equal(isStepValid(1), true);
  assert.equal(isStepValid(6), true);
  assert.equal(isStepValid(7), false);
});

test('nextStepFrom / prevStepFrom clamp at the ends', () => {
  assert.equal(nextStepFrom(1), 2);
  assert.equal(nextStepFrom(5), 6);
  assert.equal(nextStepFrom(6), 6);
  assert.equal(prevStepFrom(2), 1);
  assert.equal(prevStepFrom(1), 1);
});

// ─── work-sample tier completeness (D6) ──────────────────────────────────────
test('tierHasArtifact: a photo OR a written example counts; description does not', () => {
  assert.equal(tierHasArtifact(undefined, undefined), false);
  assert.equal(tierHasArtifact({ photo_paths: [], description: 'looks for X' }, []), false);
  assert.equal(tierHasArtifact({ photo_paths: ['p/1.jpg'] }, []), true);
  assert.equal(tierHasArtifact(undefined, [{ id: 'a1', artifact_type: 'comment' }]), true);
});

test('hasAllWorkSampleTiers / missingTiers / missingTiersLabel', () => {
  assert.equal(hasAllWorkSampleTiers({}, {}), false);
  assert.deepEqual(missingTiers({}, {}), ['progressing', 'proficient', 'exemplary']);
  assert.equal(missingTiersLabel({}, {}), 'no graded work samples yet');

  const samples = { progressing: { photo_paths: ['a.jpg'] } };
  const artifacts = { exemplary: [{ id: 'x' }] };
  assert.deepEqual(missingTiers(samples, artifacts), ['proficient']);
  assert.equal(missingTiersLabel(samples, artifacts), 'no Proficient example yet');
  assert.equal(hasAllWorkSampleTiers(samples, artifacts), false);

  artifacts.proficient = [{ id: 'y' }];
  assert.equal(hasAllWorkSampleTiers(samples, artifacts), true);
  assert.equal(hasAllWorkSampleTiers(undefined, undefined), false);
});

test('photo slot / file type helpers', () => {
  assert.equal(remainingPhotoSlots({ existingPaths: ['a'], photos: [{}] }), 1);
  assert.equal(remainingPhotoSlots({ existingPaths: [], photos: [] }), 3);
  assert.equal(isHeicFile({ type: 'image/heic', name: 'x' }), true);
  assert.equal(isHeicFile({ type: '', name: 'IMG.HEIF' }), true);
  assert.equal(isHeicFile({ type: 'image/jpeg', name: 'x.jpg' }), false);
  assert.equal(isSupportedImageType('image/jpeg'), true);
  assert.equal(isSupportedImageType('image/webp'), true);
  assert.equal(isSupportedImageType('image/gif'), false);
});

test('summarizeTier / tierHasSampleContent', () => {
  const empty = { existingPaths: [], photos: [], textArtifacts: [], description: '' };
  assert.equal(summarizeTier(empty).countStr, 'nothing added');
  assert.equal(tierHasSampleContent(empty), false);

  const descOnly = { ...empty, description: '  detail  ' };
  assert.equal(summarizeTier(descOnly).countStr, 'description only');
  assert.equal(summarizeTier(descOnly).description, 'detail');
  assert.equal(tierHasSampleContent(descOnly), true);

  const mixed = { existingPaths: ['a'], photos: [{}], textArtifacts: [{ text: 'x' }, { text: '  ' }], description: 'd'.repeat(250) };
  const s = summarizeTier(mixed);
  assert.equal(s.countStr, '2 photos, 1 written example');
  assert.equal(s.description.length, 201);
  assert.ok(s.description.endsWith('…'));

  const textOnly = { ...empty, textArtifacts: [{ text: 'a comment' }] };
  assert.equal(tierHasSampleContent(textOnly), false);
});

// ─── home-view class list ────────────────────────────────────────────────────
test('classStatus / filterClasses', () => {
  const profiles = { Calc: { done: true }, Bio: { done: false } };
  assert.equal(classStatus(profiles.Calc), 'complete');
  assert.equal(classStatus(profiles.Bio), 'not_started');
  assert.equal(classStatus(undefined), 'not_started');
  const classes = ['Calc', 'Bio', 'Art'];
  assert.deepEqual(filterClasses(classes, profiles), classes);
  assert.deepEqual(filterClasses(classes, profiles, { status: 'complete' }), ['Calc']);
  assert.deepEqual(filterClasses(classes, profiles, { search: 'bi' }), ['Bio']);
  assert.deepEqual(filterClasses(classes, profiles, { search: 'gen' }), classes); // subject "General"
  assert.deepEqual(filterClasses(classes, profiles, { search: 'zzz' }), []);
});

// ─── roster ──────────────────────────────────────────────────────────────────
test('parseNotes tolerates null, garbage, and non-arrays', () => {
  assert.deepEqual(parseNotes(null), []);
  assert.deepEqual(parseNotes('not json'), []);
  assert.deepEqual(parseNotes('{"a":1}'), []);
  assert.deepEqual(parseNotes('[{"text":"hi"}]'), [{ text: 'hi' }]);
});

test('firstInvalidStep: review-first entry cannot save past the step 1–4 gates', () => {
  const ok = { title: 'Dr.', engagementRules: words(50), teachingVoice: words(50), courseInfo: words(50), welcomeMessage: 'w'.repeat(80) };
  assert.equal(firstInvalidStep(ok), null);
  assert.equal(firstInvalidStep({ ...ok, title: '' }), 1);
  assert.equal(firstInvalidStep({ ...ok, engagementRules: words(49) }), 1);
  assert.equal(firstInvalidStep({ ...ok, teachingVoice: words(49) }), 2);
  assert.equal(firstInvalidStep({ ...ok, courseInfo: '' }), 3);
  // Legacy completed profile from before the welcome-message step.
  assert.equal(firstInvalidStep({ ...ok, welcomeMessage: '' }), 4);
  assert.equal(firstInvalidStep({ ...ok, welcomeMessage: 'w'.repeat(79) }), 4);
  assert.equal(firstInvalidStep({ ...ok, welcomeMessage: 'w'.repeat(601) }), null); // soft cap never blocks
  assert.equal(firstInvalidStep(), 1);
});

test('sortByLastName sorts by last token, case-insensitive; nameless rows sort with "~"', () => {
  const rows = [
    { student_name: 'zed Alpha' }, { student_name: 'Amy zeta' }, { student_name: 'Bo Beta' },
  ];
  const sorted = sortByLastName(rows).map(r => r.student_name);
  assert.deepEqual(sorted, ['zed Alpha', 'Bo Beta', 'Amy zeta']);
  // Nameless students take the '~' placeholder key (ICU collation puts
  // punctuation before letters, so they lead the list — pre-existing behavior).
  const withNull = sortByLastName([{ student_name: 'Bo Beta' }, { student_name: null }]);
  assert.equal(withNull[0].student_name, '~'.localeCompare('beta') < 0 ? null : 'Bo Beta');
  assert.notEqual(sortByLastName(rows), rows); // non-mutating copy
});

test('groupBy', () => {
  const g = groupBy([{ b: 'A' }, { b: 'B' }, { b: 'A' }], r => r.b);
  assert.deepEqual(Object.keys(g), ['A', 'B']);
  assert.equal(g.A.length, 2);
});

// ─── files / paths ───────────────────────────────────────────────────────────
test('classSlug / cleanFileName / formatFileSize / baseName', () => {
  assert.equal(classSlug('Advanced Calculus I (H)'), 'advanced-calculus-i-h');
  assert.equal(classSlug(''), 'general');
  assert.equal(classSlug('!!!'), 'general');
  assert.equal(cleanFileName('my syllabus (v2).pdf'), 'my_syllabus__v2_.pdf');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(2048), '2 KB');
  assert.equal(formatFileSize(3 * 1024 * 1024), '3.0 MB');
  assert.equal(baseName('syllabi/x/y/file.pdf'), 'file.pdf');
});

test('syllabusSummaryText', () => {
  assert.equal(syllabusSummaryText([], []), null);
  assert.equal(syllabusSummaryText(['a/one.pdf'], []), 'one.pdf');
  assert.equal(syllabusSummaryText(['a/one.pdf'], [{ file: { name: 'two.pdf' } }]), '2 files\none.pdf\ntwo.pdf');
});

test('combineSyllabusText joins and caps', () => {
  const r = combineSyllabusText('old', [{ extractedText: 'new1' }, { extractedText: '' }, { extractedText: 'new2' }]);
  assert.equal(r.text, 'old\n\nnew1\n\nnew2');
  assert.equal(r.truncated, false);
  const capped = combineSyllabusText('x'.repeat(10), [], 4);
  assert.equal(capped.text, 'xxxx');
  assert.equal(capped.truncated, true);
});

test('parseSuggestedPrompts requires exactly three strings in a JSON array', () => {
  assert.deepEqual(parseSuggestedPrompts('Sure: ["a","b","c"] done'), ['a', 'b', 'c']);
  assert.throws(() => parseSuggestedPrompts('no array'), /No JSON array/);
  assert.throws(() => parseSuggestedPrompts('["a","b"]'), /Invalid prompt array/);
});

test('escHtml', () => {
  assert.equal(escHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(escHtml(''), '');
});
