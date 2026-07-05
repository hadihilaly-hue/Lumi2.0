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
