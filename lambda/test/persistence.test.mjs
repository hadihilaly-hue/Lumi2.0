// Phase 5 — cross-session student memory (rolling progress notes).
//
// Covers the four safety-critical behaviours from the build spec:
//   1. The gate: a real-domain student writes/injects NOTHING; a synthetic
//      (@lumidemo.test) student with the tenant flag on does.
//   2. summarize-and-store: happy path upserts; every failure mode leaves the
//      note UNCHANGED (no INSERT).
//   3. Injection: the <<LUMI_PROGRESS_NOTE>> marker is replaced server-side only
//      when gated, and always stripped from the client stream.
//   4. Deletion: student_progress_notes rides the soft-delete cascade; a
//      wrong/absent confirmation deletes nothing.
// Plus unit coverage of the pure validators.
//
// The flush path arms an 8s summarizer timeout race; fake timers keep the
// uncleared loser from holding the event loop (same pattern as chat.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadHandler, resetContext, invoke, makeRouter, findQuery, findQueries,
  STUDENT, tokenFor,
} from './harness.mjs';

const res = (rows) => ({ rows, rowCount: rows.length });

// A synthetic persona student — the ONLY population persistence may activate for.
const SYN = { email: 'ferraro-student@lumidemo.test', sub: 'sub-syn', userId: 'uuid-syn' };

// A valid note object + the model stream that emits it.
const VALID_NOTE = {
  topics_covered: ['factoring quadratics (leading coeff 1)'],
  current_position: 'Mid-way through factoring; comfortable when a=1.',
  struggle_points: ['reaches for the answer under time pressure'],
  what_worked: ['asked to narrate each step out loud'],
  last_session_summary: 'Last time we factored simple quadratics together.',
};
const summaryChunks = (text, outTokens = 120) => [
  { type: 'message_start', message: { usage: { input_tokens: 200 } } },
  { type: 'content_block_delta', delta: { text } },
  { type: 'message_delta', usage: { output_tokens: outTokens } },
];

// onRoute that satisfies the summarizer's reads. Overridable per test.
const summarizerRoutes = (over = {}) => (text) => {
  if (/FROM public\.teacher_profiles WHERE id = \$1/.test(text)) {
    return res([{ course_name: 'Algebra II', teaching_voice: 'convince me', title: 'Mr.' }]);
  }
  if (/SELECT messages FROM public\.conversations/.test(text)) {
    return over.conversation !== undefined ? over.conversation : res([{ messages: [
      { role: 'user', content: 'help me factor x^2+5x+6' },
      { role: 'assistant', content: 'what have you tried so far?' },
    ] }]);
  }
  if (/SELECT note_content FROM public\.student_progress_notes/.test(text)) {
    return over.priorNote !== undefined ? over.priorNote : res([]);
  }
  if (/INSERT INTO public\.student_progress_notes/.test(text)) return res([]);
  return res([]);
};

const synRouter = (opts = {}) => makeRouter({
  userId: SYN.userId, domains: ['lumidemo.test'], persistenceEnabled: true,
  onRoute: summarizerRoutes(opts.over || {}), ...opts.router,
});

// ============================ THE GATE ======================================

test('flush is a no-op for a real-domain student (never writes)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handler } = await loadHandler();
  const ctx = resetContext({
    // STUDENT is @menloschool.org. Even with the tenant flag ON, the synthetic
    // domain allowlist (gate 2) blocks it.
    dbRouter: makeRouter({ userId: STUDENT.userId, persistenceEnabled: true, onRoute: summarizerRoutes() }),
    bedrock: { chunks: summaryChunks(JSON.stringify(VALID_NOTE)) },
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/progress-note/flush', token: tokenFor(STUDENT),
    body: { teacher_profile_id: 'tp1', conversation_id: 'conv1' },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'disabled');
  assert.equal(findQueries(ctx, /INSERT INTO public\.student_progress_notes/).length, 0);
  // The gate short-circuits before ever reading the transcript.
  assert.equal(findQueries(ctx, /SELECT messages FROM public\.conversations/).length, 0);
});

test('flush writes a note for a synthetic student when the tenant flag is on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: synRouter(),
    bedrock: { chunks: summaryChunks(JSON.stringify(VALID_NOTE)) },
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/progress-note/flush', token: tokenFor(SYN),
    body: { teacher_profile_id: 'tp1', conversation_id: 'conv1' },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'updated');
  const ins = findQuery(ctx, /INSERT INTO public\.student_progress_notes/);
  assert.ok(ins, 'note should be upserted');
  assert.equal(ins.params[0], SYN.userId, 'student_id comes from the JWT, not the body');
  assert.equal(ins.params[1], 'tp1');
  // note_content is the validated JSON (stringified for the jsonb param).
  assert.match(ins.params[2], /factoring quadratics/);
});

test('flush is JWT-scoped: the transcript read is bound to the caller id', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: synRouter(),
    bedrock: { chunks: summaryChunks(JSON.stringify(VALID_NOTE)) },
  });
  await invoke(handler, {
    method: 'POST', path: '/progress-note/flush', token: tokenFor(SYN),
    // An attacker cannot summarize someone else's conversation: user_id is forced.
    body: { teacher_profile_id: 'tp1', conversation_id: 'conv-victim' },
  });
  const q = findQuery(ctx, /SELECT messages FROM public\.conversations/);
  assert.match(q.text, /WHERE id = \$1 AND user_id = \$2/);
  assert.equal(q.params[0], 'conv-victim');
  assert.equal(q.params[1], SYN.userId, 'conversation read scoped to the JWT user');
});

test('flush 400s without teacher_profile_id / conversation_id', async () => {
  const { handler } = await loadHandler();
  resetContext({ dbRouter: synRouter() });
  const r = await invoke(handler, {
    method: 'POST', path: '/progress-note/flush', token: tokenFor(SYN),
    body: { teacher_profile_id: 'tp1' },
  });
  assert.equal(r.statusCode, 400);
});

// ===================== SUMMARIZE FAILURE MODES ==============================
// Every failure leaves the note unchanged: NO INSERT, status skipped.

const expectSkip = async (t, { bedrock, over }, reasonRe) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: synRouter({ over }), bedrock });
  const r = await invoke(handler, {
    method: 'POST', path: '/progress-note/flush', token: tokenFor(SYN),
    body: { teacher_profile_id: 'tp1', conversation_id: 'conv1' },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'skipped');
  if (reasonRe) assert.match(r.json().reason, reasonRe);
  assert.equal(findQueries(ctx, /INSERT INTO public\.student_progress_notes/).length, 0,
    'a failed summary must not write');
};

test('summarize skips (no write) on malformed JSON', async (t) => {
  await expectSkip(t, { bedrock: { chunks: summaryChunks('not json at all') } }, /invalid_json/);
});

test('summarize skips (no write) when the note exceeds the token ceiling', async (t) => {
  await expectSkip(t, { bedrock: { chunks: summaryChunks(JSON.stringify(VALID_NOTE), 400) } }, /validation_over_cap/);
});

test('summarize skips (no write) on deficit language', async (t) => {
  const bad = { ...VALID_NOTE, struggle_points: ['struggling with fractions'] };
  await expectSkip(t, { bedrock: { chunks: summaryChunks(JSON.stringify(bad)) } }, /deficit_language/);
});

test('summarize skips (no write) when the model errors', async (t) => {
  await expectSkip(t, { bedrock: { throw: new Error('bedrock down') } }, /bedrock_error/);
});

test('summarize skips (no write) when the conversation is empty', async (t) => {
  await expectSkip(t, {
    bedrock: { chunks: summaryChunks(JSON.stringify(VALID_NOTE)) },
    over: { conversation: res([{ messages: [] }]) },
  }, /empty_transcript/);
});

test('summarize skips (no write) when the conversation is not the caller\'s', async (t) => {
  await expectSkip(t, {
    bedrock: { chunks: summaryChunks(JSON.stringify(VALID_NOTE)) },
    over: { conversation: res([]) },   // scoped query returns nothing
  }, /no_conversation/);
});

// ===================== INJECTION (chat route) ==============================

test('chat injects the progress note for a synthetic student (gated) and never leaks it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({
      userId: SYN.userId, domains: ['lumidemo.test'], persistenceEnabled: true,
      onRoute: (text) => /SELECT note_content FROM public\.student_progress_notes/.test(text)
        ? res([{ note_content: VALID_NOTE }]) : res([]),
    }),
    bedrock: { chunks: [
      { type: 'message_start', message: { usage: { input_tokens: 11 } } },
      { type: 'content_block_delta', delta: { text: 'Hello' } },
      { type: 'message_delta', usage: { output_tokens: 7 } },
    ] },
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/chat', token: tokenFor(SYN),
    body: {
      messages: [{ role: 'user', content: 'hi' }],
      system: 'You are a tutor.<<LUMI_PROGRESS_NOTE>>',
      inject_progress_note: { teacher_profile_id: 'tp1', student_id: 'ATTACKER' },
    },
  });
  assert.equal(r.statusCode, 200);
  const q = findQuery(ctx, /SELECT note_content FROM public\.student_progress_notes/);
  assert.ok(q, 'note fetch should run for a gated student');
  assert.match(q.text, /WHERE student_id = \$1 AND teacher_profile_id = \$2/);
  assert.equal(q.params[0], SYN.userId, 'note read forced to the JWT user id');
  assert.ok(!q.params.includes('ATTACKER'));
  assert.doesNotMatch(r.body, /LUMI_PROGRESS_NOTE/, 'marker never reaches the client');
  assert.doesNotMatch(r.body, /factoring quadratics/, 'note content never reaches the client');
});

test('chat strips the progress-note marker for a real student (no fetch, no leak)', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({
    dbRouter: makeRouter({ userId: STUDENT.userId, persistenceEnabled: true }),
    bedrock: { chunks: [
      { type: 'message_start', message: { usage: { input_tokens: 11 } } },
      { type: 'content_block_delta', delta: { text: 'Hello' } },
      { type: 'message_delta', usage: { output_tokens: 7 } },
    ] },
  });
  const r = await invoke(handler, {
    method: 'POST', path: '/chat', token: tokenFor(STUDENT),
    body: {
      messages: [{ role: 'user', content: 'hi' }],
      system: 'You are a tutor.<<LUMI_PROGRESS_NOTE>>',
      inject_progress_note: { teacher_profile_id: 'tp1' },
    },
  });
  assert.equal(r.statusCode, 200);
  // Real domain fails gate 2 → no note read at all.
  assert.equal(findQueries(ctx, /SELECT note_content FROM public\.student_progress_notes/).length, 0);
  assert.doesNotMatch(r.body, /LUMI_PROGRESS_NOTE/);
});

// ===================== DELETION CASCADE ====================================

test('delete-my-account soft-deletes student_progress_notes in the cascade', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/delete-my-account', token: tokenFor(STUDENT),
    body: { confirm: 'DELETE' },
  });
  assert.equal(r.statusCode, 200);
  const del = findQuery(ctx, /UPDATE public\.student_progress_notes SET deleted_at = now\(\) WHERE student_id = \$1/);
  assert.ok(del, 'progress notes must be soft-deleted with the rest');
  assert.equal(del.params[0], STUDENT.userId);
});

test('delete-my-account with the wrong confirmation deletes nothing', async () => {
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/delete-my-account', token: tokenFor(STUDENT),
    body: { confirm: 'delete' },   // wrong case
  });
  assert.equal(r.statusCode, 400);
  assert.equal(findQueries(ctx, /UPDATE public\.student_progress_notes SET deleted_at/).length, 0);
});

test('my-data export includes the progress note(s)', async () => {
  const { handler } = await loadHandler();
  resetContext({
    dbRouter: makeRouter({
      userId: STUDENT.userId,
      onRoute: (text) => /FROM public\.student_progress_notes WHERE student_id = \$1/.test(text)
        ? res([{ id: 'n1', teacher_profile_id: 'tp1', note_content: VALID_NOTE, source_session_count: 3 }])
        : res([]),
    }),
  });
  const r = await invoke(handler, { method: 'GET', path: '/my-data', token: tokenFor(STUDENT) });
  assert.equal(r.statusCode, 200);
  const notes = r.json().data.student_progress_notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].source_session_count, 3);
});

// ===================== PURE VALIDATORS =====================================

test('validateProgressNote accepts a well-formed note and trims soft caps', async () => {
  const { __test__ } = await loadHandler();
  const big = { ...VALID_NOTE, topics_covered: Array.from({ length: 12 }, (_, i) => `t${i}`) };
  const v = __test__.validateProgressNote(JSON.stringify(big), 120);
  assert.equal(v.ok, true);
  assert.equal(v.note.topics_covered.length, 8, 'topics trimmed to the soft cap');
});

test('validateProgressNote rejects: bad JSON, over-cap, deficit, wrong shape', async () => {
  const { __test__ } = await loadHandler();
  assert.equal(__test__.validateProgressNote('nope', 100).reason, 'invalid_json');
  assert.equal(__test__.validateProgressNote(JSON.stringify(VALID_NOTE), 400).reason, 'validation_over_cap');
  const deficit = { ...VALID_NOTE, current_position: 'she is bad at fractions' };
  assert.equal(__test__.validateProgressNote(JSON.stringify(deficit), 100).reason, 'deficit_language');
  const { last_session_summary, ...missing } = VALID_NOTE;
  assert.equal(__test__.validateProgressNote(JSON.stringify(missing), 100).reason, 'wrong_shape');
});

test('validateProgressNote tolerates an unknown output-token count (does not reject on it)', async () => {
  const { __test__ } = await loadHandler();
  assert.equal(__test__.validateProgressNote(JSON.stringify(VALID_NOTE), 0).ok, true);
});

test('buildProgressNoteSection renders labels + silent-use footer, empty on no note', async () => {
  const { __test__ } = await loadHandler();
  const s = __test__.buildProgressNoteSection(VALID_NOTE);
  assert.match(s, /Topics covered:/);
  assert.match(s, /Do not mention, reference, or reveal/);
  assert.equal(__test__.buildProgressNoteSection(null), '');
  assert.equal(__test__.buildProgressNoteSection({}), '', 'object with no usable fields → empty');
});

test('transcriptFromMessages flattens roles and string/array content', async () => {
  const { __test__ } = await loadHandler();
  const t = __test__.transcriptFromMessages([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi there' }, { type: 'image', source: {} }] },
  ]);
  assert.match(t, /STUDENT: hello/);
  assert.match(t, /TUTOR: hi there/);
  assert.equal(__test__.transcriptFromMessages(null), '');
});

test('isPersistenceEnabled: false for a real domain, true only for a flagged synthetic tenant', async () => {
  const { __test__ } = await loadHandler();
  // Real domain → gate 2 fails before any query.
  resetContext({ dbRouter: makeRouter({ persistenceEnabled: true }) });
  assert.equal(await __test__.isPersistenceEnabled('kid@menloschool.org'), false);
  // Synthetic + tenant flag on → true.
  resetContext({ dbRouter: makeRouter({ domains: ['lumidemo.test'], persistenceEnabled: true }) });
  assert.equal(await __test__.isPersistenceEnabled('kid@lumidemo.test'), true);
  // Synthetic but tenant flag off → false.
  resetContext({ dbRouter: makeRouter({ domains: ['lumidemo.test'], persistenceEnabled: false }) });
  assert.equal(await __test__.isPersistenceEnabled('kid@lumidemo.test'), false);
});

test('isPersistenceEnabled fails closed on a DB error', async () => {
  const { __test__ } = await loadHandler();
  resetContext({ dbRouter: () => { throw new Error('db down'); } });
  assert.equal(await __test__.isPersistenceEnabled('kid@lumidemo.test'), false);
});
