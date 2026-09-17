// OpenAI provider: request translation (Anthropic blocks → Chat Completions),
// SSE translation back to Anthropic-shaped events, and the /chat route
// end-to-end with LUMI_PROVIDER=gpt and a stubbed globalThis.fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadHandler, resetContext, invoke, makeRouter, findQuery, flush, STUDENT, tokenFor,
} from './harness.mjs';
import { buildRequestBody, translateChunk, consumeSse } from '../lib/openai.mjs';

const realFetch = globalThis.fetch;
const savedEnv = {};
before(() => {
  for (const k of ['LUMI_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_REASONING_EFFORT']) savedEnv[k] = process.env[k];
  process.env.LUMI_PROVIDER = 'gpt';
  process.env.OPENAI_API_KEY = 'sk-test';
  delete process.env.OPENAI_MODEL;
  delete process.env.OPENAI_REASONING_EFFORT;
});
after(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// A fetch stub that records the request and streams the given OpenAI SSE lines.
function stubFetch({ lines, status = 200 }) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const enc = new TextEncoder();
    return {
      ok: status < 400,
      status,
      json: async () => ({ error: { message: 'bad request' } }),
      body: (async function* () {
        for (const l of lines) yield enc.encode(l + '\n\n');
      })(),
    };
  };
  return calls;
}

const OPENAI_LINES = [
  'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] }),
  'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
  'data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }),
  'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
  'data: [DONE]',
];

test('buildRequestBody flattens system blocks and converts image/document blocks', () => {
  const body = buildRequestBody({
    systemPrompt: [
      { type: 'text', text: 'SEG1', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'SEG2' },
    ],
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' } },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'plain' },
    ],
    maxTokens: 300,
    temperature: 0.3,
  });
  assert.equal(body.model, 'gpt-5.5');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_completion_tokens, 300 + 1024);
  assert.equal(body.temperature, undefined, 'temperature is dropped for reasoning models');
  assert.deepEqual(body.messages[0], { role: 'system', content: 'SEG1\n\nSEG2' });
  assert.deepEqual(body.messages[1].content, [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'file', file: { filename: 'document.pdf', file_data: 'data:application/pdf;base64,BBBB' } },
  ]);
  assert.deepEqual(body.messages[2], { role: 'assistant', content: 'ok' });
  assert.deepEqual(body.messages[3], { role: 'user', content: 'plain' });
  assert.ok(!JSON.stringify(body).includes('cache_control'));
});

test('buildRequestBody honours OPENAI_MODEL / OPENAI_REASONING_EFFORT and forwards temperature when reasoning is off', () => {
  process.env.OPENAI_MODEL = 'gpt-x';
  process.env.OPENAI_REASONING_EFFORT = '';
  try {
    const body = buildRequestBody({ systemPrompt: 's', messages: [], maxTokens: 10, temperature: 0.3 });
    assert.equal(body.model, 'gpt-x');
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.max_completion_tokens, 10);
    assert.equal(body.temperature, 0.3);
  } finally {
    delete process.env.OPENAI_MODEL;
    delete process.env.OPENAI_REASONING_EFFORT;
  }
});

test('translateChunk maps deltas to text_delta events and usage to message_delta', () => {
  assert.deepEqual(
    translateChunk({ choices: [{ delta: { content: 'hi' } }] }),
    [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }],
  );
  assert.deepEqual(translateChunk({ choices: [{ delta: {} }] }), []);
  const [ev] = translateChunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } });
  assert.equal(ev.type, 'message_delta');
  assert.deepEqual(ev.usage, { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 2 });
});

test('consumeSse holds back a partial line and skips [DONE]/malformed payloads', () => {
  const { payloads, rest } = consumeSse('data: {"a":1}\n\ndata: nope\n\ndata: [DONE]\n\ndata: {"b"');
  assert.deepEqual(payloads, [{ a: 1 }, { done: true }]);
  assert.equal(rest, 'data: {"b"');
});

test('/chat with LUMI_PROVIDER=gpt streams Anthropic-shaped SSE from the OpenAI stream and logs usage', async () => {
  const calls = stubFetch({ lines: OPENAI_LINES });
  const { handler } = await loadHandler();
  const ctx = resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId, usageCount: 0 }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/chat', token: tokenFor(STUDENT),
    body: { system: 'You are Lumi.', messages: [{ role: 'user', content: 'hi' }], max_tokens: 2500 },
  });
  await flush();

  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['Content-Type'], 'text/event-stream');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/chat\/completions$/);
  assert.equal(calls[0].headers.authorization, 'Bearer sk-test');
  assert.equal(calls[0].body.model, 'gpt-5.5');
  assert.equal(calls[0].body.messages[0].content, 'You are Lumi.');

  // Frontend consumer (js/api.js) needs content_block_delta + delta.type text_delta.
  const deltas = r.body.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6))
    .filter((raw) => raw !== '[DONE]').map((raw) => JSON.parse(raw))
    .filter((ev) => ev.type === 'content_block_delta');
  assert.deepEqual(deltas.map((d) => d.delta.text), ['Hel', 'lo']);
  assert.ok(deltas.every((d) => d.delta.type === 'text_delta'));
  assert.match(r.body, /data: \[DONE\]/);
  assert.ok(!ctx.bedrock.commands, 'Bedrock must not be called');

  const usage = findQuery(ctx, /INSERT INTO public\.api_usage/);
  assert.ok(usage, 'usage logged');
  assert.equal(usage.params[3], 'gpt-5.5');
  assert.equal(usage.params[4], 11);
  assert.equal(usage.params[5], 7);
});

test('/chat with LUMI_PROVIDER=gpt surfaces an OpenAI HTTP error as an in-band SSE error', async () => {
  stubFetch({ lines: [], status: 400 });
  const { handler } = await loadHandler();
  resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId, usageCount: 0 }) });
  const r = await invoke(handler, {
    method: 'POST', path: '/chat', token: tokenFor(STUDENT),
    body: { messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /"error"/);
  assert.match(r.body, /openai 400/);
  assert.ok(r.ended);
});

test('/chat with LUMI_PROVIDER=gpt fails in-band when OPENAI_API_KEY is missing', async () => {
  const calls = stubFetch({ lines: OPENAI_LINES });
  delete process.env.OPENAI_API_KEY;
  try {
    const { handler } = await loadHandler();
    resetContext({ dbRouter: makeRouter({ userId: STUDENT.userId, usageCount: 0 }) });
    const r = await invoke(handler, {
      method: 'POST', path: '/chat', token: tokenFor(STUDENT),
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.match(r.body, /OPENAI_API_KEY/);
    assert.equal(calls.length, 0);
  } finally {
    process.env.OPENAI_API_KEY = 'sk-test';
  }
});
