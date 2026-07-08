// Default /chat route + server-side teacher-notes injection + /suggested-prompts.
// These paths arm real setTimeout timers (the Promise.race guards in
// fetchTeacherNotes (3s) and the suggested-prompts generation race (8s) — the
// uncleared timers are AUDIT_LAMBDA_BUGS H4). We enable node:test fake timers so
// those pending timers don't keep the event loop alive / slow the run.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadHandler, resetContext, invoke, makeRouter, findQuery, findQueries, flush,
  STUDENT, TEACHER, tokenFor,
} from './harness.mjs';

const res = (rows) => ({ rows, rowCount: rows.length });
const MARKER = '<<LUMI_TEACHER_NOTES>>';

// A minimal Bedrock stream: message_start (usage) → text delta → message_delta (usage).
const CHAT_CHUNKS = [
  { type: 'message_start', message: { usage: { input_tokens: 11 } } },
  { type: 'content_block_delta', delta: { text: 'Hello' } },
  { type: 'message_delta', usage: { output_tokens: 7 } },
];

test('/chat 429s when the caller is over their daily rate limit', async () => {
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: makeRouter({ userId: STUDENT.userId, isTeacher: false, usageCount: 100 }),
    bedrock: { chunks: CHAT_CHUNKS },
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/chat', token: tokenFor(STUDENT),
    body: { messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(r.statusCode, 429);
  assert.match(r.json().error, /Rate limit exceeded \(100\/day\)/);
});

test('/chat under the limit streams SSE and logs usage scoped to the JWT user', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({ userId: STUDENT.userId, isTeacher: false, usageCount: 0 }),
    bedrock: { chunks: CHAT_CHUNKS },
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/chat', token: tokenFor(STUDENT),
    body: { messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['Content-Type'], 'text/event-stream');
  assert.match(r.body, /data: \[DONE\]/);
  assert.match(r.body, /Hello/);
  await flush(); // fire-and-forget logUsage
  const usage = findQuery(ctx, /INSERT INTO public\.api_usage/);
  assert.ok(usage, 'usage should be logged');
  assert.equal(usage.params[0], STUDENT.userId, 'usage row keyed to the JWT user id');
  assert.equal(usage.params[1], STUDENT.email); // lowercased email
});

test('/chat teacher-notes injection is JWT-scoped (a caller can only read notes about themselves)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId, isTeacher: false,
      onRoute: (text) => /SELECT teacher_notes FROM public\.class_enrollments/.test(text)
        ? res([{ teacher_notes: JSON.stringify([{ timestamp: 1, text: 'be encouraging' }]) }])
        : res([]),
    }),
    bedrock: { chunks: CHAT_CHUNKS },
  });
  await invoke(handler, {
    method: 'POST', path: '/chat', token: tokenFor(STUDENT),
    body: {
      messages: [{ role: 'user', content: 'hi' }],
      system: `You are a tutor.${MARKER}`,
      // Attacker supplies a teacher_profile_id but CANNOT supply a student_id —
      // the notes query is keyed on the JWT user id.
      inject_teacher_notes: { teacher_profile_id: 'tp-victim', student_id: 'ATTACKER' },
    },
  });
  const q = findQuery(ctx, /SELECT teacher_notes FROM public\.class_enrollments/);
  assert.ok(q, 'notes fetch should run');
  assert.match(q.text, /WHERE student_id = \$1 AND teacher_profile_id = \$2/);
  assert.equal(q.params[0], STUDENT.userId, 'student_id forced to JWT — not the body value');
  assert.equal(q.params[1], 'tp-victim');
  assert.ok(!q.params.includes('ATTACKER'));
});

test('/chat strips the notes marker even when no injection is requested', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({ userId: STUDENT.userId }),
    bedrock: { chunks: CHAT_CHUNKS },
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/chat', token: tokenFor(STUDENT),
    body: { messages: [{ role: 'user', content: 'hi' }], system: `Base.${MARKER}` },
  });
  assert.equal(r.statusCode, 200);
  // No class_enrollments notes query was issued (no injection requested)...
  assert.equal(findQueries(ctx, /SELECT teacher_notes FROM public\.class_enrollments/).length, 0);
  // ...and the marker never leaks to the client stream.
  assert.doesNotMatch(r.body, /LUMI_TEACHER_NOTES/);
});

// ==================== work-artifacts injection (Q4 v2) ======================

const WA_MARKER = '<<LUMI_WORK_ARTIFACTS>>';

test('/chat work-artifacts injection reads the class artifacts by teacher_profile_id and strips the marker', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId, isTeacher: false,
      onRoute: (text) => {
        if (/FROM public\.teacher_work_artifacts/.test(text)) {
          return res([{ tier: 'proficient', artifact_type: 'comment', text_content: 'Sharpen your thesis.', label: null, created_at: new Date(0) }]);
        }
        if (/FROM public\.teacher_work_samples/.test(text)) {
          return res([{ tier: 'proficient', description: 'clarity of argument' }]);
        }
        return res([]);
      },
    }),
    bedrock: { chunks: CHAT_CHUNKS },
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/chat', token: tokenFor(STUDENT),
    body: {
      messages: [{ role: 'user', content: 'hi' }],
      system: `You are a tutor.${WA_MARKER}`,
      inject_work_artifacts: { teacher_profile_id: 'tp1', first_name: 'Laura' },
    },
  });
  assert.equal(r.statusCode, 200);
  const q = findQuery(ctx, /FROM public\.teacher_work_artifacts/);
  assert.ok(q, 'artifact fetch should run');
  assert.equal(q.params[0], 'tp1');
  assert.match(q.text, /artifact_type <> 'photo'/);      // text-only fetch
  assert.match(q.text, /deleted_at IS NULL/);
  // The marker (and thus the private artifact text) never leaks to the client stream.
  assert.doesNotMatch(r.body, /LUMI_WORK_ARTIFACTS/);
  assert.doesNotMatch(r.body, /Sharpen your thesis/);
});

test('/chat strips the work-artifacts marker even when no injection is requested', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({ userId: STUDENT.userId }),
    bedrock: { chunks: CHAT_CHUNKS },
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/chat', token: tokenFor(STUDENT),
    body: { messages: [{ role: 'user', content: 'hi' }], system: `Base.${WA_MARKER}` },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(findQueries(ctx, /FROM public\.teacher_work_artifacts/).length, 0);
  assert.doesNotMatch(r.body, /LUMI_WORK_ARTIFACTS/);
});

// ==================== Feature H: array-form system (prompt caching) =========

// The client may now send `system` as an array of content blocks
// (SEG1 cached / SEG2 dynamic) with a cache_control breakpoint at the boundary.
// The Lambda must swap markers per-block (WORK_ARTIFACTS lives in SEG1, notes in
// SEG2), preserve cache_control, and forward the array to Bedrock unchanged.
test('/chat array-form system: per-block marker swaps + array forwarded to Bedrock with cache_control', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId, isTeacher: false,
      onRoute: (text) => {
        if (/FROM public\.teacher_work_artifacts/.test(text)) {
          return res([{ tier: 'proficient', artifact_type: 'comment', text_content: 'Sharpen your thesis.', label: null, created_at: new Date(0) }]);
        }
        if (/FROM public\.teacher_work_samples/.test(text)) {
          return res([{ tier: 'proficient', description: 'clarity of argument' }]);
        }
        if (/SELECT teacher_notes FROM public\.class_enrollments/.test(text)) {
          return res([{ teacher_notes: JSON.stringify([{ timestamp: 1, text: 'be encouraging' }]) }]);
        }
        return res([]);
      },
    }),
    bedrock: { chunks: CHAT_CHUNKS },
  });
  // SEG1 carries the teacher-stable WORK_ARTIFACTS marker + a cache breakpoint;
  // SEG2 carries the per-student TEACHER_NOTES marker.
  const seg1 = `You are Lumi. Teacher-stable prefix.${WA_MARKER}`;
  const seg2 = `Student context here.${MARKER}`;
  const r = await invoke(handler, {
    method: 'POST', path: '/chat', token: tokenFor(STUDENT),
    body: {
      messages: [{ role: 'user', content: 'hi' }],
      system: [
        { type: 'text', text: seg1, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: seg2 },
      ],
      inject_work_artifacts: { teacher_profile_id: 'tp1', first_name: 'Laura' },
      inject_teacher_notes: { teacher_profile_id: 'tp1' },
    },
  });
  assert.equal(r.statusCode, 200);

  // The array reached Bedrock as an array, with the cache_control breakpoint intact on SEG1.
  const sent = JSON.parse(ctx.bedrock.commands.at(-1).body);
  assert.ok(Array.isArray(sent.system), 'system forwarded to Bedrock as an array');
  assert.equal(sent.system.length, 2);
  assert.deepEqual(sent.system[0].cache_control, { type: 'ephemeral' }, 'cache_control preserved on SEG1');
  assert.ok(!('cache_control' in sent.system[1]), 'SEG2 has no breakpoint');

  // WORK_ARTIFACTS marker (SEG1 / block 0) was replaced in place; injected text landed in SEG1.
  assert.ok(!sent.system[0].text.includes('LUMI_WORK_ARTIFACTS'), 'WA marker swapped out of SEG1');
  assert.match(sent.system[0].text, /Sharpen your thesis/, 'artifact section injected into SEG1');
  assert.match(sent.system[0].text, /Teacher-stable prefix\./, 'SEG1 base text preserved');

  // TEACHER_NOTES marker (SEG2 / block 1) was replaced in place; notes landed in SEG2, not SEG1.
  assert.ok(!sent.system[1].text.includes('LUMI_TEACHER_NOTES'), 'notes marker swapped out of SEG2');
  assert.match(sent.system[1].text, /be encouraging/, 'notes section injected into SEG2');
  assert.ok(!sent.system[0].text.includes('be encouraging'), 'per-student notes never leak into cached SEG1');

  // Nothing private leaks to the client stream.
  assert.doesNotMatch(r.body, /LUMI_WORK_ARTIFACTS|LUMI_TEACHER_NOTES/);
  assert.doesNotMatch(r.body, /Sharpen your thesis|be encouraging/);
});

test('/chat array-form system: markers stripped across all blocks when no injection is requested', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({ userId: STUDENT.userId }),
    bedrock: { chunks: CHAT_CHUNKS },
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/chat', token: tokenFor(STUDENT),
    body: {
      messages: [{ role: 'user', content: 'hi' }],
      system: [
        { type: 'text', text: `SEG1.${WA_MARKER}`, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `SEG2.${MARKER}` },
      ],
    },
  });
  assert.equal(r.statusCode, 200);
  // No injection requested → no DB fetches, and every marker stripped to nothing.
  assert.equal(findQueries(ctx, /FROM public\.teacher_work_artifacts/).length, 0);
  assert.equal(findQueries(ctx, /SELECT teacher_notes FROM public\.class_enrollments/).length, 0);
  const sent = JSON.parse(ctx.bedrock.commands.at(-1).body);
  assert.equal(sent.system[0].text, 'SEG1.');
  assert.equal(sent.system[1].text, 'SEG2.');
});

// ============================= /suggested-prompts ===========================

test('/suggested-prompts requires teacher_profile_id (400)', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId }) });
  const r = await invoke(handler, {
    method: 'GET', path: '/suggested-prompts', token: tokenFor(STUDENT),
  });
  assert.equal(r.statusCode, 400);
});

test('/suggested-prompts reads the caller notes JWT-scoped; falls back when there are none', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: () => res([]), // no notes row
    }),
  });
  const r = await invoke(handler, {
    method: 'GET', path: '/suggested-prompts', token: tokenFor(STUDENT),
    query: { teacher_profile_id: 'tp-victim' },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().mode, 'fallback');
  const q = findQuery(ctx, /SELECT teacher_notes FROM public\.class_enrollments/);
  assert.equal(q.params[0], STUDENT.userId, 'notes keyed to the JWT user id');
});

test('/suggested-prompts returns 3 influenced chips when notes + model output are valid', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId, usageCount: 0, profileName: 'Sam',
      onRoute: (text) => /SELECT teacher_notes FROM public\.class_enrollments/.test(text)
        ? res([{ teacher_notes: JSON.stringify([{ timestamp: 1, text: 'working on factoring' }]) }])
        : res([]),
    }),
    // Model streams a JSON array of exactly 3 chip strings.
    bedrock: {
      chunks: [
        { type: 'message_start', message: { usage: { input_tokens: 20 } } },
        { type: 'content_block_delta', delta: { text: '["Help me with homework", "Try some factoring?", "How do I factor quadratics?"]' } },
        { type: 'message_delta', usage: { output_tokens: 30 } },
      ],
    },
  });
  const r = await invoke(handler, {
    method: 'GET', path: '/suggested-prompts', token: tokenFor(STUDENT),
    query: { teacher_profile_id: 'tp1', course: 'Algebra' },
  });
  assert.equal(r.statusCode, 200);
  const out = r.json();
  assert.equal(out.mode, 'influenced');
  assert.equal(out.prompts.length, 3);
});

test('/suggested-prompts falls back (not error) when the caller is rate-limited', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId, usageCount: 100, // over the student cap
      onRoute: (text) => /SELECT teacher_notes FROM public\.class_enrollments/.test(text)
        ? res([{ teacher_notes: JSON.stringify([{ timestamp: 1, text: 'note' }]) }])
        : res([]),
    }),
  });
  const r = await invoke(handler, {
    method: 'GET', path: '/suggested-prompts', token: tokenFor(STUDENT),
    query: { teacher_profile_id: 'tp1' },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().mode, 'fallback');
});

test('/chat emits an SSE error event (not a crash) when the model call fails', async () => {
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: makeRouter({ userId: STUDENT.userId, usageCount: 0 }),
    bedrock: { throw: new Error('bedrock unavailable') },
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/chat', token: tokenFor(STUDENT),
    body: { messages: [{ role: 'user', content: 'hi' }] },
  });
  // The stream was already opened (200 SSE), so the failure surfaces as an
  // in-band error event and the stream is closed.
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['Content-Type'], 'text/event-stream');
  assert.match(r.body, /"error"/);
  assert.ok(r.ended, 'stream should be closed after the error');
});
