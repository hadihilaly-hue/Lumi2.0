// Every Lambda call the teacher portal makes. `auth` is the cognito-auth.js shim
// (classic script, global) — read at call time so this module evaluates cleanly
// offline (test/register.mjs).

import { LAMBDA_URL } from './config.js';
import { parseSuggestedPrompts } from './wizardState.js';

async function accessToken() {
  const { data: { session } } = await auth.getSession();
  return session?.access_token || null;
}

// Generic Lambda fetch — mirror of apiFetch in js/teachers.js (LAMBDA_URL here has
// no trailing slash). 404 -> null; other non-2xx throws so call sites fail
// VISIBLY.
export async function apiFetch(path, { method = 'GET', body } = {}) {
  const token = await accessToken();
  if (!token) throw new Error('apiFetch: no session');
  const res = await fetch(`${LAMBDA_URL}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path.split('?')[0]} ${res.status}`);
  return res.json();
}

// ─── teacher-profile ─────────────────────────────────────────────────────────
// GET /teacher-profile defaults to the caller's own rows; 404 (apiFetch null) =
// brand-new teacher with no profiles yet — same as empty.
export async function fetchOwnProfiles() {
  return (await apiFetch('teacher-profile')) || [];
}

// Returns an array (200 [] when no shared template). Server excludes the
// caller's own rows.
export function fetchTemplateForCourse(course) {
  return apiFetch(`teacher-profile?template_for_course=${encodeURIComponent(course)}`);
}

// POST returns the upserted row directly (teacher_email + updated_at are
// server-set).
export function upsertProfile(profileRow) {
  return apiFetch('teacher-profile', { method: 'POST', body: profileRow });
}

// The Lambda PATCH scopes to the JWT email server-side.
export function patchProfile(body) {
  return apiFetch('teacher-profile', { method: 'PATCH', body });
}

// ─── work-samples / work-artifacts ───────────────────────────────────────────
function idsQuery(profileIds) {
  return profileIds.map(encodeURIComponent).join(',');
}

export function fetchWorkSamples(profileIds) {
  return apiFetch(`work-samples?teacher_profile_ids=${idsQuery(profileIds)}`);
}

export function fetchWorkArtifacts(profileIds) {
  return apiFetch(`work-artifacts?teacher_profile_ids=${idsQuery(profileIds)}`);
}

// POST is a (teacher_profile_id, tier) upsert; updated_at is server-set.
export function upsertWorkSample(body) {
  return apiFetch('work-samples', { method: 'POST', body });
}

export function upsertWorkArtifact(body) {
  return apiFetch('work-artifacts', { method: 'POST', body });
}

export function deleteWorkArtifact(id) {
  return apiFetch(`work-artifacts?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ─── class-enrollments ───────────────────────────────────────────────────────
// Teacher roster via GET /class-enrollments?scope=teaching. Server derives the
// owned classes from the JWT email. Throws on non-2xx (caller toasts).
export async function fetchTeachingEnrollments() {
  const token = await accessToken();
  const res = await fetch(`${LAMBDA_URL}/class-enrollments?scope=teaching`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`class-enrollments ${res.status}`);
  return res.json();
}

// PATCH authz is server-side (caller must own the linked class); 403 throws,
// 404 resolves null.
export function patchEnrollmentNotes(id, teacherNotes) {
  return apiFetch('class-enrollments', { method: 'PATCH', body: { id, teacher_notes: teacherNotes } });
}

// ─── S3 via signed URLs ──────────────────────────────────────────────────────
// Signed GET URL for an object, or '' on any failure (thumbnails/re-extract
// tolerate a missing file).
export async function fetchDownloadUrl(bucket, key) {
  try {
    const token = await accessToken();
    const res = await fetch(`${LAMBDA_URL}/download-url`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bucket, key }),
    });
    if (!res.ok) return '';
    const json = await res.json();
    return json.downloadUrl || '';
  } catch {
    return '';
  }
}

// 1. Request a signed S3 upload URL from the Lambda. 2. PUT the file directly
// to S3 — Content-Type MUST match what we signed for. Resolves the object key.
export async function uploadViaSignedUrl({ bucket, filename, contentType, classId, tier }, file) {
  const token = await accessToken();
  const sigRes = await fetch(`${LAMBDA_URL}/upload-url`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bucket,
      filename,
      contentType,
      classId,
      ...(tier ? { tier } : {}),
    }),
  });
  if (!sigRes.ok) {
    const errText = await sigRes.text();
    throw new Error(`Failed to get S3 upload URL (${sigRes.status}): ${errText}`);
  }
  const { uploadUrl, key } = await sigRes.json();

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: file,
  });
  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`S3 upload failed (${putRes.status}): ${errText}`);
  }
  return key;
}

// ─── GENERATE SUGGESTED PROMPTS (non-blocking) ──────────────────────────────
export async function generateSuggestedPrompts(courseInfo, syllabusText, teacherEmail, courseName) {
  const systemPrompt = `Generate 3 short, tappable suggestion prompts that students of this course might click when they open Lumi. Each should be 6-10 words, specific to the course content, and sound like something a student would say. Return ONLY a JSON array of 3 strings, no other text.

Examples of good prompts for a math course: ["Help me factor polynomials", "Quiz me on quadratic equations", "Walk me through a log problem"]

Here's the course info:
${courseInfo || '(not provided)'}

Here's the syllabus:
${syllabusText || '(not provided)'}`;

  try {
    const token = await accessToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${LAMBDA_URL}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 150,
        temperature: 0.7,
        messages: [{ role: 'user', content: 'Generate the 3 prompts now.' }],
        system: systemPrompt,
      }),
    });

    if (!res.ok) throw new Error('API call failed');
    const json = await res.json();
    const prompts = parseSuggestedPrompts(json.content?.[0]?.text || '');

    // Update the profile with generated prompts. The Lambda PATCH scopes to
    // the JWT email server-side, so teacherEmail is implicit.
    await patchProfile({ course_name: courseName, suggested_prompts: prompts });

    console.log('Generated suggested prompts:', prompts);
  } catch (err) {
    console.warn('Prompt generation failed, using fallback:', err);
    const fallback = [
      "Help me with today's homework",
      "Quiz me on what we've been learning",
      "Explain a concept I'm stuck on"
    ];
    try {
      await patchProfile({ course_name: courseName, suggested_prompts: fallback });
    } catch { /* ignore secondary failure */ }
  }
}
