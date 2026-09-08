// Unit tests for the helpers extracted out of index.mjs into lib/:
// sse.mjs (HttpResponseStream wrapping + SSE writers), s3.mjs (key building +
// presigned URLs), prompt.mjs (marker helpers on string + array system prompts),
// columns.mjs (allowlist picker) and the index.mjs dispatch table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetContext, loadHandler, invoke, tokenFor, STUDENT } from './harness.mjs';

const lib = (name) => import(new URL(`../lib/${name}`, import.meta.url).href);

// ---- sse.mjs -----------------------------------------------------------------

test('sse: jsonResponder wraps once with JSON content-type, writes payload, ends', async () => {
  const { jsonResponder } = await lib('sse.mjs');
  const stream = new globalThis.MockResponseStream();
  jsonResponder(stream)(404, { error: 'nope' });
  assert.equal(stream.statusCode, 404);
  assert.deepEqual(stream.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(stream.json(), { error: 'nope' });
  assert.equal(stream.ended, true);
});

test('sse: openEventStream sets 200 + text/event-stream + no-cache', async () => {
  const { openEventStream } = await lib('sse.mjs');
  const stream = new globalThis.MockResponseStream();
  const s = openEventStream(stream);
  assert.equal(s.statusCode, 200);
  assert.deepEqual(s.headers, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  assert.equal(s.ended, false);
});

test('sse: writeEvent / writeDone / writeError emit the exact wire format', async () => {
  const { writeEvent, writeDone, writeError } = await lib('sse.mjs');
  const stream = new globalThis.MockResponseStream();
  writeEvent(stream, { type: 'content_block_delta', delta: { text: 'hi' } });
  writeError(stream, 'boom');
  writeError(stream, undefined);
  writeDone(stream);
  assert.deepEqual(stream.chunks, [
    'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
    'data: {"error":"boom"}\n\n',
    'data: {"error":"Stream error"}\n\n',
    'data: [DONE]\n\n',
  ]);
});

// ---- s3.mjs ------------------------------------------------------------------

test('s3: buildS3Key — syllabi and work-samples layouts, unsafe chars sanitized', async () => {
  const { buildS3Key } = await lib('s3.mjs');
  const realNow = Date.now;
  Date.now = () => 1234;
  try {
    assert.equal(
      buildS3Key({ bucketType: 'syllabi', userId: 'u1', classId: 'c1', filename: 'my syllabus (v2).pdf' }),
      'teachers/u1/c1/1234-my_syllabus__v2_.pdf'
    );
    assert.equal(
      buildS3Key({ bucketType: 'syllabi', userId: 'u1', filename: 'a.pdf' }),
      'teachers/u1/general/1234-a.pdf'
    );
    assert.equal(
      buildS3Key({ bucketType: 'work-samples', userId: 'u1', classId: 'c1', tier: 'exemplary', filename: 'p.jpg' }),
      'teachers/u1/c1/exemplary/1234-p.jpg'
    );
    assert.equal(
      buildS3Key({ bucketType: 'work-samples', userId: 'u1', filename: 'p.jpg' }),
      'teachers/u1/general/general/1234-p.jpg'
    );
    assert.throws(() => buildS3Key({ bucketType: 'nope', userId: 'u1', filename: 'x' }), /Invalid bucket type/);
  } finally {
    Date.now = realNow;
  }
});

test('s3: generateUploadURL signs a PUT for 300s with the given content type (default octet-stream)', async () => {
  const { generateUploadURL, BUCKETS } = await lib('s3.mjs');
  const ctx = resetContext({ signedUrl: 'https://s3.example/put' });
  const url = await generateUploadURL({ bucketType: 'syllabi', key: 'k', contentType: 'application/pdf' });
  assert.equal(url, 'https://s3.example/put');
  assert.deepEqual(ctx.signRequests[0].command, { Bucket: BUCKETS.syllabi, Key: 'k', ContentType: 'application/pdf' });
  assert.equal(ctx.signRequests[0].opts.expiresIn, 300);
  await generateUploadURL({ bucketType: 'work-samples', key: 'k2' });
  assert.equal(ctx.signRequests[1].command.ContentType, 'application/octet-stream');
  assert.equal(ctx.signRequests[1].command.Bucket, BUCKETS['work-samples']);
  await assert.rejects(generateUploadURL({ bucketType: 'nope', key: 'k' }), /Invalid bucket type/);
});

test('s3: generateDownloadURL signs a GET for 3600s', async () => {
  const { generateDownloadURL, BUCKETS } = await lib('s3.mjs');
  const ctx = resetContext();
  await generateDownloadURL({ bucketType: 'work-samples', key: 'teachers/u/x.jpg' });
  assert.deepEqual(ctx.signRequests[0].command, { Bucket: BUCKETS['work-samples'], Key: 'teachers/u/x.jpg' });
  assert.equal(ctx.signRequests[0].opts.expiresIn, 3600);
  await assert.rejects(generateDownloadURL({ bucketType: 'nope', key: 'k' }), /Invalid bucket type/);
});

// ---- prompt.mjs --------------------------------------------------------------

test('prompt: systemHasMarker / systemReplaceMarker on string system', async () => {
  const { systemHasMarker, systemReplaceMarker } = await lib('prompt.mjs');
  const sys = 'A <<M>> B <<M>> C';
  assert.equal(systemHasMarker(sys, '<<M>>'), true);
  assert.equal(systemHasMarker(sys, '<<X>>'), false);
  assert.equal(systemReplaceMarker(sys, '<<M>>', 'x'), 'A x B x C');
  assert.equal(systemReplaceMarker(sys, '<<X>>', 'x'), sys);
});

test('prompt: array system — only the block containing the marker is rewritten; cache_control preserved; other blocks identical by reference', async () => {
  const { systemHasMarker, systemReplaceMarker } = await lib('prompt.mjs');
  const seg1 = { type: 'text', text: 'stable <<A>>', cache_control: { type: 'ephemeral' } };
  const seg2 = { type: 'text', text: 'dynamic <<B>>' };
  const other = { type: 'image', source: {} };
  const sys = [seg1, seg2, other];
  assert.equal(systemHasMarker(sys, '<<A>>'), true);
  assert.equal(systemHasMarker(sys, '<<Z>>'), false);
  const out = systemReplaceMarker(sys, '<<B>>', 'notes');
  assert.equal(out.length, 3);
  assert.equal(out[0], seg1, 'untouched block keeps identity');
  assert.equal(out[2], other);
  assert.deepEqual(out[1], { type: 'text', text: 'dynamic notes' });
  const out2 = systemReplaceMarker(out, '<<A>>', '');
  assert.deepEqual(out2[0], { type: 'text', text: 'stable ', cache_control: { type: 'ephemeral' } });
  assert.deepEqual(sys[0], seg1, 'input not mutated');
});

test('prompt: non-string/non-array system passes through', async () => {
  const { systemHasMarker, systemReplaceMarker } = await lib('prompt.mjs');
  assert.equal(systemHasMarker(undefined, '<<A>>'), false);
  assert.equal(systemHasMarker(42, '<<A>>'), false);
  assert.equal(systemReplaceMarker(undefined, '<<A>>', 'x'), undefined);
});

test('prompt: parseNotes / buildTeacherNotesSection', async () => {
  const { parseNotes, buildTeacherNotesSection } = await lib('prompt.mjs');
  assert.deepEqual(parseNotes(null), []);
  assert.deepEqual(parseNotes(''), []);
  assert.equal(buildTeacherNotesSection([]), '');
  assert.deepEqual(parseNotes('not json'), []);
  assert.deepEqual(parseNotes('{"a":1}'), [], 'non-array JSON is ignored');
  const notes = parseNotes(JSON.stringify([{ text: 'first note' }, { text: '  ' }, { text: 'second note' }]));
  assert.equal(notes.length, 3);
  const section = buildTeacherNotesSection(notes);
  assert.match(section, /first note\n\nsecond note/);
  assert.match(section, /Never mention, quote, or hint/);
  assert.equal(buildTeacherNotesSection([{ text: '   ' }]), '', 'blank-only notes yield no section');
  // 8000-char cap drops the OLDEST notes first.
  const big = buildTeacherNotesSection([{ text: 'OLD'.padEnd(6000, 'o') }, { text: 'NEW'.padEnd(6000, 'n') }]);
  assert.ok(big.length <= 8000 + 400);
  assert.equal(big.includes('OLD'), false);
  assert.equal(big.includes('NEW'), true);
});

test('prompt: assembleSystemPrompt strips every marker even when no data is available', async () => {
  const { assembleSystemPrompt, TEACHER_NOTES_MARKER, WORK_ARTIFACTS_MARKER, PROGRESS_NOTE_MARKER } = await lib('prompt.mjs');
  resetContext();
  const body = {
    system: `X ${TEACHER_NOTES_MARKER} Y ${WORK_ARTIFACTS_MARKER} Z ${PROGRESS_NOTE_MARKER} W`,
    inject_teacher_notes: { teacher_profile_id: 'tp-1' },
  };
  const out = await assembleSystemPrompt({ body, user: { id: STUDENT.userId, email: STUDENT.email } });
  assert.equal(out.includes(TEACHER_NOTES_MARKER), false);
  assert.equal(out.includes(WORK_ARTIFACTS_MARKER), false);
  assert.equal(out.includes(PROGRESS_NOTE_MARKER), false);
  assert.match(out, /^X\s+Y\s+Z\s+W$/);
});

test('prompt: assembleSystemPrompt returns body.system untouched when no marker is present', async () => {
  const { assembleSystemPrompt } = await lib('prompt.mjs');
  const ctx = resetContext();
  const sys = [{ type: 'text', text: 'plain', cache_control: { type: 'ephemeral' } }];
  const out = await assembleSystemPrompt({ body: { system: sys }, user: { id: STUDENT.userId, email: STUDENT.email } });
  assert.equal(out, sys);
  assert.equal(ctx.queries.length, 0);
});

// ---- columns.mjs -------------------------------------------------------------

test('columns: pickColumns keeps only allowlisted keys and applies type coercions', async () => {
  const { pickColumns, TEACHER_PROFILE_COLS } = await lib('columns.mjs');
  const { cols, vals } = pickColumns(
    { title: 'Dr.', suggested_prompts: ['a', 'b'], evil: 'x', teacher_email: 'spoof@x', course_name: 'Bio', done: undefined },
    TEACHER_PROFILE_COLS
  );
  assert.deepEqual(cols, ['title', 'suggested_prompts'], 'spec order; key columns (course_name, teacher_email) excluded');
  assert.deepEqual(vals, ['Dr.', JSON.stringify(['a', 'b'])], 'jsonb columns are serialized');
  assert.equal(cols.includes('teacher_email'), false, 'identity columns are never client-writable');
  assert.equal(cols.includes('evil'), false);
  const nul = pickColumns({ suggested_prompts: null }, TEACHER_PROFILE_COLS);
  assert.deepEqual(nul.vals, [null], 'null jsonb stays null');
});

// ---- index.mjs dispatch table --------------------------------------------------

test('router: public routes are served without a token; everything else is authenticated', async () => {
  resetContext();
  const { handler } = await loadHandler();
  const pub = await invoke(handler, { path: '/allowed-domains' });
  assert.equal(pub.statusCode, 200);
  const priv = await invoke(handler, { path: '/profiles' });
  assert.equal(priv.statusCode, 401);
});

test('router: an unknown path falls through to the chat route (default handler), not a 404', async () => {
  resetContext();
  const { handler } = await loadHandler();
  const res = await invoke(handler, {
    method: 'POST', path: '/not-a-route', token: tokenFor(STUDENT), body: { messages: [] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream', 'served as an SSE chat stream');
  assert.match(res.body, /data: \[DONE\]/);
});

test('router: __test__ surface still exposes the legacy helper names', async () => {
  resetContext();
  const mod = await loadHandler();
  for (const name of ['isTeacher', 'isEmailAllowed', 'getAllowedDomains', 'buildS3Key', 'pickColumns', 'checkRateLimit']) {
    assert.equal(typeof mod.__test__[name], 'function', name);
  }
});
