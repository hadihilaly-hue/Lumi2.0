// Pure wizard/portal logic for teacher.html — no DOM, no fetch. Unit-tested in
// test/teacher-wizardState.test.mjs. The DOM layer (wizardUi.js, home.js,
// roster.js) calls these and only does the rendering.

import { TIERS, TOTAL_STEPS } from './config.js';

export const MIN_WORDS = 50;
export const WELCOME_MIN_CHARS = 80;
export const WELCOME_SOFT_LIMIT = 600;
export const MAX_PHOTOS_PER_TIER = 3;

// Text types offered in the per-artifact chip/select. 'photo' is NOT here — it's
// the photo path. Keep the values in sync with the Lambda TYPES allowlist and the
// teacher_work_artifacts_type_check CHECK constraint.
export const TEXT_ARTIFACT_TYPES = [
  { value: 'comment', label: 'Comment' },
  { value: 'essay_feedback', label: 'Essay feedback' },
  { value: 'eval_note', label: 'Eval note' },
  { value: 'other', label: 'Other' },
];
export const MAX_ARTIFACT_TEXT = 2000; // matches the Lambda per-text hard cap
export const MAX_TEXT_ARTIFACTS_PER_TIER = 5; // matches the Lambda per-tier cap (5/tier)

export const SYLLABUS_MAX_FILES = 20;
export const SYLLABUS_MAX_SIZE_BYTES = 10 * 1024 * 1024;
export const SYLLABUS_TEXT_CAP = 100_000;

// ─── WORD / CHAR GATES (steps 1–4) ───────────────────────────────────────────
export function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(w => w.length > 0).length;
}

// Steps 1–3: 50-word minimum. Step 1 additionally requires a title selection
// (`requireTitle` + `titleValue`). Returns the counter label and whether the
// Continue button may be enabled.
export function wordCountStatus(text, { requireTitle = false, titleValue = '' } = {}) {
  const count = countWords(text);
  const wordsMet = count >= MIN_WORDS;
  const titleOk = !requireTitle || !!titleValue;
  const label = wordsMet
    ? (titleOk ? `${count} words` : `${count} words — choose how students address you above`)
    : `${count} of ${MIN_WORDS} words${count > 0 ? ' — keep going' : ''}`;
  return { count, wordsMet, titleOk, label, enabled: wordsMet && titleOk };
}

// Phase 5b: char-count gate for the welcome-message step. Soft limit at
// 600 chars (visual only — never blocks). Required min 80 chars so the
// teacher can't ship an empty or one-word welcome.
export function charCountStatus(text, softLimit = WELCOME_SOFT_LIMIT, minRequired = WELCOME_MIN_CHARS) {
  const count = String(text || '').length;
  let label;
  if (count < minRequired) {
    label = `${count} character${count === 1 ? '' : 's'} — at least ${minRequired} needed`;
  } else if (count > softLimit) {
    label = `${count} / ${softLimit} characters — long for a first read`;
  } else {
    label = `${count} / ${softLimit} characters`;
  }
  return { count, label, enabled: count >= minRequired, overSoftLimit: count > softLimit };
}

// ─── STEP NAVIGATION ─────────────────────────────────────────────────────────
// Steps 1–4 gate their own Continue button live (wordCountStatus /
// charCountStatus); step 5 (work samples) is fully optional — Continue is never
// gated (D6-A-i). So a Continue click on any step is always allowed.
export function isStepValid(step) {
  return step >= 1 && step <= TOTAL_STEPS;
}

export function nextStepFrom(current) {
  if (!isStepValid(current)) return current;
  return current < TOTAL_STEPS ? current + 1 : current;
}

export function prevStepFrom(current) {
  return current > 1 ? current - 1 : current;
}

// ─── WORK-SAMPLE TIER COMPLETENESS (Q4 v2, Decision D6) ──────────────────────
// A tier "counts" when it has at least one artifact of ANY type — a photo OR a
// written (text) example. Description is NOT required.
export function tierHasArtifact(sampleRow, artifactRows) {
  const hasPhoto = !!(sampleRow && Array.isArray(sampleRow.photo_paths) && sampleRow.photo_paths.length > 0);
  const hasText = Array.isArray(artifactRows) && artifactRows.length > 0;
  return hasPhoto || hasText;
}

// Tiers (in canonical order) with no artifact of any type.
export function missingTiers(samplesByTier = {}, artifactsByTier = {}) {
  return TIERS.filter(tier => !tierHasArtifact(samplesByTier[tier], artifactsByTier[tier]));
}

// True iff all three tiers are complete for this profile's caches.
export function hasAllWorkSampleTiers(samplesByTier, artifactsByTier) {
  return missingTiers(samplesByTier || {}, artifactsByTier || {}).length === 0;
}

// Class-card notice copy for the tiers still missing an artifact.
export function missingTiersLabel(samplesByTier, artifactsByTier) {
  const missing = missingTiers(samplesByTier || {}, artifactsByTier || {});
  if (missing.length === TIERS.length) return 'no graded work samples yet';
  const names = missing.map(t => t[0].toUpperCase() + t.slice(1));
  return `no ${names.join(' or ')} example yet`;
}

// Photo slots left in a tier (cap 3 across existing + newly-picked).
export function remainingPhotoSlots(slot) {
  return MAX_PHOTOS_PER_TIER - ((slot.existingPaths || []).length + (slot.photos || []).length);
}

export function isHeicFile(file) {
  return /heic|heif/i.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '');
}

export function isSupportedImageType(mime) {
  return /^image\/(jpe?g|png|webp)$/i.test(mime || '');
}

// Review-step (6) summary line per tier. Returns plain data; the caller renders.
export function summarizeTier(slot) {
  const photoCount = (slot.existingPaths || []).length + (slot.photos || []).length;
  const textCount = (slot.textArtifacts || []).filter(a => (a.text || '').trim()).length;
  const desc = (slot.description || '').trim();
  const short = desc.length > 200 ? desc.slice(0, 200) + '…' : desc;
  const parts = [];
  if (photoCount) parts.push(`${photoCount} photo${photoCount === 1 ? '' : 's'}`);
  if (textCount) parts.push(`${textCount} written example${textCount === 1 ? '' : 's'}`);
  const countStr = parts.length ? parts.join(', ') : (short ? 'description only' : 'nothing added');
  return { photoCount, textCount, description: short, countStr };
}

// Whether a tier has photo/description content that warrants a
// teacher_work_samples row (text-only tiers persist via /work-artifacts).
export function tierHasSampleContent(slot) {
  return !!((slot.description || '').trim() || (slot.existingPaths || []).length || (slot.photos || []).length);
}

// ─── CLASS CARDS ─────────────────────────────────────────────────────────────
export function classStatus(profile) {
  return profile?.done ? 'complete' : 'not_started';
}

// Which of `classes` survive the home-view search box + status pill.
export function filterClasses(classes, profiles, { search = '', status = 'all', subjectFor = () => 'General' } = {}) {
  const term = String(search || '').toLowerCase().trim();
  return (classes || []).filter(course => {
    const subject = subjectFor(course);
    const st = classStatus(profiles[course]);
    if (term && !course.toLowerCase().includes(term) && !subject.toLowerCase().includes(term)) return false;
    if (status !== 'all' && st !== status) return false;
    return true;
  });
}

// ─── ROSTER / NOTES ──────────────────────────────────────────────────────────
export function parseNotes(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Roster order: by last name (last whitespace token), case-insensitive; nameless
// students take a '~' placeholder key.
export function sortByLastName(enrollments) {
  return (enrollments || []).slice().sort((a, b) => {
    const la = ((a.student_name || '').split(' ').slice(-1)[0] || '~').toLowerCase();
    const lb = ((b.student_name || '').split(' ').slice(-1)[0] || '~').toLowerCase();
    return la.localeCompare(lb);
  });
}

export function groupBy(rows, keyFn) {
  const out = {};
  (rows || []).forEach(r => { (out[keyFn(r)] ||= []).push(r); });
  return out;
}

// ─── FILES / PATHS ───────────────────────────────────────────────────────────
export function classSlug(course) {
  return (course || 'general')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'general';
}

export function cleanFileName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

export function baseName(path) {
  return String(path || '').split('/').pop();
}

// Review-step syllabus card text (null → hide the card).
export function syllabusSummaryText(existingPaths, newFiles) {
  const allNames = [...(existingPaths || []).map(baseName), ...(newFiles || []).map(e => e.file.name)];
  if (!allNames.length) return null;
  return allNames.length === 1 ? allNames[0] : `${allNames.length} files\n${allNames.join('\n')}`;
}

// Combined syllabus_text for the profile row, capped for safe prompt injection.
export function combineSyllabusText(existingText, newFiles, cap = SYLLABUS_TEXT_CAP) {
  const newText = (newFiles || []).map(e => e.extractedText).filter(Boolean).join('\n\n');
  const raw = [existingText, newText].filter(Boolean).join('\n\n');
  return { text: raw.length > cap ? raw.slice(0, cap) : raw, truncated: raw.length > cap };
}

// Parse the model's suggested-prompt reply: exactly 3 strings in a JSON array.
export function parseSuggestedPrompts(text) {
  const match = String(text || '').match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON array found');
  const prompts = JSON.parse(match[0]);
  if (!Array.isArray(prompts) || prompts.length !== 3) throw new Error('Invalid prompt array');
  return prompts;
}

export function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
