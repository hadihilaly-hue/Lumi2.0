import assert from 'node:assert/strict';
import { test } from 'node:test';

import { consumeSseBuffer, streamVisibleText } from '../js/api.js';

// ── consumeSseBuffer ─────────────────────────────────────────────────────────
// The Lambda writes Bedrock's chunks through verbatim, one per `data:` line,
// terminated by `data: [DONE]`. Real deltas carry delta.type: 'text_delta' —
// the Lambda's own fixtures omit it, but the wire format has it, and the client
// check is strict on purpose.

const delta = (t) =>
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })}\n`;

test('consumeSseBuffer: one complete delta yields one text event', () => {
  const { events, rest } = consumeSseBuffer(delta('Hello'));
  assert.deepEqual(events, [{ type: 'text', text: 'Hello' }]);
  assert.equal(rest, '');
});

test('consumeSseBuffer: two events in one buffer come back in order', () => {
  const { events } = consumeSseBuffer(delta('Hel') + delta('lo'));
  assert.deepEqual(events.map(e => e.text), ['Hel', 'lo']);
});

test('consumeSseBuffer: a partial line is held back, not parsed', () => {
  const partial = 'data: {"type":"content_bl';
  const { events, rest } = consumeSseBuffer(partial);
  assert.deepEqual(events, []);
  assert.equal(rest, partial, 'the incomplete line must survive for the next read');
});

test('consumeSseBuffer: a delta split across two reads survives', () => {
  const whole = delta('split me');
  const cut = Math.floor(whole.length / 2);
  const first = consumeSseBuffer(whole.slice(0, cut));
  assert.deepEqual(first.events, []);
  const second = consumeSseBuffer(first.rest + whole.slice(cut));
  assert.deepEqual(second.events, [{ type: 'text', text: 'split me' }]);
});

test('consumeSseBuffer: [DONE] is its own event', () => {
  const { events } = consumeSseBuffer('data: [DONE]\n');
  assert.deepEqual(events, [{ type: 'done' }]);
});

test('consumeSseBuffer: an error event is surfaced, not dropped', () => {
  const { events } = consumeSseBuffer('data: {"error":"Stream error"}\n');
  assert.deepEqual(events, [{ type: 'error', message: 'Stream error' }]);
});

test('consumeSseBuffer: a malformed line is skipped without throwing', () => {
  const { events } = consumeSseBuffer('data: {not json\n' + delta('after'));
  assert.deepEqual(events, [{ type: 'text', text: 'after' }]);
});

test('consumeSseBuffer: non-text chunks produce no text events', () => {
  const buf = [
    JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 11 } } }),
    JSON.stringify({ type: 'message_delta', usage: { output_tokens: 7 } }),
    // delta.type that is not text_delta — the strict check must reject it
    JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', text: 'nope' } }),
    // the Lambda's simplified fixture shape, which omits delta.type
    JSON.stringify({ type: 'content_block_delta', delta: { text: 'also nope' } }),
  ].map(j => `data: ${j}\n`).join('');
  assert.deepEqual(consumeSseBuffer(buf).events, []);
});

// ── streamVisibleText ────────────────────────────────────────────────────────
// The system prompt makes Lumi append a profile JSON blob after every reply.
// parseResponse strips it from the finished string; this keeps it off screen
// while it arrives a character at a time.

const BLOB = '{"values":["curiosity"],"goals":[],"interests":[]}';

test('streamVisibleText: text with no blob is returned unchanged', () => {
  assert.equal(streamVisibleText('Walk me through your reasoning.'),
               'Walk me through your reasoning.');
});

test('streamVisibleText: a complete trailing blob is hidden', () => {
  assert.equal(streamVisibleText(`Nice work.\n${BLOB}`), 'Nice work.');
});

test('streamVisibleText: every partial prefix of the blob is hidden', () => {
  for (const p of ['{', '{"', '{"va', '{"values"', '{"values":[']) {
    assert.equal(streamVisibleText(`Nice work.\n${p}`), 'Nice work.', `prefix ${p}`);
  }
});

test('streamVisibleText: a brace mid-prose is not hidden', () => {
  assert.equal(streamVisibleText('Set A = {1, 2, 3} and go.'), 'Set A = {1, 2, 3} and go.');
});

test('streamVisibleText: empty and nullish input return empty string', () => {
  assert.equal(streamVisibleText(''), '');
  assert.equal(streamVisibleText(null), '');
  assert.equal(streamVisibleText(undefined), '');
});

test('streamVisibleText: only the trailing brace-line is considered', () => {
  const text = `First line.\n{ this is prose }\nSecond line.\n${BLOB}`;
  assert.equal(streamVisibleText(text), 'First line.\n{ this is prose }\nSecond line.');
});
