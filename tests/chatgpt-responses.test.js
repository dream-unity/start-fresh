import test from 'node:test';
import assert from 'node:assert/strict';
import { RESPONSE_SCHEMA } from '../src/response-schema.js';
import { CHATGPT_RESPONSES_URL, ChatGPTResponseError, streamChatGPTResponse } from '../server/chatgpt-responses.mjs';

const ACCESS_TOKEN = 'unit-fixture-token-not-a-credential';
const messages = [
  { role: 'system', content: 'Guide the person through Dream Unity.' },
  { role: 'user', content: 'I might write a novel.' },
  { role: 'assistant', content: 'What interests you about that possibility?' },
  { role: 'user', content: 'I want to explore it at the café.' },
];
const model = 'catalog-selected-model';
const answer = JSON.stringify({ reply: 'What could your café 🌌 writing experiment teach you?', region: 'machine', focus: 'A writing possibility', memory: null });
const delta = text => ({ type: 'response.output_text.delta', delta: text });
const complete = (text = answer) => ({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } });
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const collect = async iterator => { const values = []; for await (const value of iterator) values.push(value); return values; };

function streaming(text, { chunkSize = 5, headers = {}, onCancel = () => {} } = {}) {
  const bytes = new TextEncoder().encode(text);
  let position = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (position >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(position, position + chunkSize));
      position += chunkSize;
    },
    cancel: onCancel,
  }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'request-fixture', ...headers } });
}

function invoke(fetchImpl, options = {}) {
  return streamChatGPTResponse({ messages, model, accessToken: ACCESS_TOKEN, fetchImpl, ...options });
}

test('SIWC request uses OAuth on the supported public Responses route and only permitted fields', async () => {
  let request;
  const values = await collect(invoke(async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return streaming(frame(delta(answer)) + frame(complete()));
  }));
  assert.equal(request.url, CHATGPT_RESPONSES_URL);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.deepEqual(Object.keys(request.body).sort(), ['input', 'instructions', 'model', 'store', 'stream', 'text']);
  assert.equal(request.body.model, model);
  assert.equal(request.body.instructions, messages[0].content);
  assert.deepEqual(request.body.input, messages.slice(1));
  assert.equal(request.body.store, false);
  assert.equal(request.body.stream, true);
  assert.deepEqual(request.body.text.format, { type: 'json_schema', name: 'dream_unity_response', strict: true, schema: RESPONSE_SCHEMA });
  assert.deepEqual(values, [{ message: { content: answer }, done: false }, { done: true }]);
});

test('SSE handles CRLF split boundaries, UTF-8 split codepoints, comments and multiline data', async () => {
  const first = JSON.stringify(delta(answer), null, 2).split('\n').map(line => `data: ${line}`).join('\r\n');
  const stream = ': heartbeat\r\n\r\nevent: response.output_text.delta\r\n' + first + '\r\n\r\n' + frame(complete()).replaceAll('\n', '\r\n');
  const values = await collect(invoke(async () => streaming(stream, { chunkSize: 1 })));
  assert.equal(values[0].message.content, answer);
  assert.deepEqual(values.at(-1), { done: true });
});

test('text and [DONE] without response.completed never count as completed inference', async () => {
  for (const tail of ['', 'data: [DONE]\n\n', frame({ type: 'response.output_text.done', text: answer })]) {
    const seen = [];
    await assert.rejects(async () => {
      for await (const value of invoke(async () => streaming(frame(delta(answer)) + tail))) seen.push(value);
    }, { code: 'CHATGPT_STREAM_INTERRUPTED' });
    assert.ok(seen.length > 0);
    assert.ok(seen.every(value => value.done === false));
  }
});

test('an unterminated completed SSE frame cannot turn a cut connection into success', async () => {
  await assert.rejects(collect(invoke(async () => streaming(frame(delta(answer)) + frame(complete()).trimEnd()))), { code: 'CHATGPT_STREAM_INTERRUPTED' });
});

test('subscription limits after text deltas retain their exact code and never yield done', async () => {
  let calls = 0;
  const seen = [];
  const failure = { type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'App usage limit reached', param: 'model' } } };
  await assert.rejects(async () => {
    for await (const item of invoke(async () => { calls += 1; return streaming(frame(delta(answer)) + frame(failure)); })) seen.push(item);
  }, error => {
    assert.ok(error instanceof ChatGPTResponseError);
    assert.equal(error.code, 'subscription_sharing_usage_limit_exceeded');
    assert.equal(error.status, 429);
    assert.equal(error.upstreamStatus, 200);
    assert.equal(error.requestId, 'request-fixture');
    assert.equal(error.param, 'model');
    assert.equal(error.details.error.code, error.code);
    assert.match(error.message, /settings → Usage/);
    return true;
  });
  assert.equal(calls, 1, 'No automatic retry or alternate billing route.');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].done, false);
});

test('incomplete, explicit errors and refusals are distinct non-success outcomes', async () => {
  for (const [event, code] of [
    [{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }, 'CHATGPT_RESPONSE_INCOMPLETE'],
    [{ type: 'error', error: { code: 'subscription_sharing_usage_unavailable', message: 'Temporary admission failure' } }, 'subscription_sharing_usage_unavailable'],
    [{ type: 'response.refusal.delta', delta: 'I cannot help with that request.' }, 'CHATGPT_REFUSAL'],
    [{ type: 'response.completed', response: { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'Cannot answer.' }] }] } }, 'CHATGPT_REFUSAL'],
  ]) await assert.rejects(collect(invoke(async () => streaming(frame(event)))), { code });
});

test('admission errors preserve nonstandard diagnostic shape, actual status and request ID', async () => {
  await assert.rejects(collect(invoke(async () => Response.json({ detail: 'Direct use is not permitted in this region.' }, {
    status: 403, headers: { 'openai-request-id': 'direct-admission-id' },
  }))), error => {
    assert.equal(error.status, 403);
    assert.equal(error.upstreamStatus, 403);
    assert.equal(error.requestId, 'direct-admission-id');
    assert.deepEqual(error.details, { detail: 'Direct use is not permitted in this region.' });
    return true;
  });
});

test('bearer credentials are never retained or reflected in diagnostic errors', async () => {
  const failure = { error: { code: 'example_error', message: `The token ${ACCESS_TOKEN} was rejected`, param: ACCESS_TOKEN }, detail: `Bearer ${ACCESS_TOKEN}` };
  await assert.rejects(collect(invoke(async () => Response.json(failure, { status: 401, headers: { 'x-request-id': ACCESS_TOKEN } }))), error => {
    assert.ok(!JSON.stringify(error).includes(ACCESS_TOKEN));
    assert.ok(!error.message.includes(ACCESS_TOKEN));
    assert.equal(error.accessToken, undefined);
    assert.match(error.message, /redacted/);
    return true;
  });
  await assert.rejects(collect(invoke(async () => { throw new Error(`Transport rejected Bearer ${ACCESS_TOKEN}`); })), error => {
    assert.equal(error.code, 'CHATGPT_NETWORK_ERROR');
    assert.ok(!JSON.stringify(error).includes(ACCESS_TOKEN));
    return true;
  });
});

test('completed inference still requires valid structured Dream Unity output', async () => {
  await assert.rejects(collect(invoke(async () => streaming(frame(delta('Unstructured prose')) + frame(complete('Unstructured prose'))))), { code: 'MODEL_INVALID_RESPONSE' });
  await assert.rejects(collect(invoke(async () => streaming(frame(delta(answer)) + frame(complete(answer + 'extra'))))), { code: 'CHATGPT_STREAM_MISMATCH' });
  await assert.rejects(collect(invoke(async () => streaming(frame({ type: 'response.completed', response: { status: 'incomplete' } })))), { code: 'CHATGPT_RESPONSE_FAILED' });
});

test('a completed response without deltas may supply its actual output once', async () => {
  const values = await collect(invoke(async () => streaming(frame(complete()))));
  assert.deepEqual(values, [{ message: { content: answer }, done: false }, { done: true }]);
});

test('aborting a pending read cancels the upstream stream and never emits done', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let upstreamSignal;
  const pending = collect(invoke(async (_url, options) => {
    upstreamSignal = options.signal;
    return new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  }, { signal: controller.signal }));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(cancelled, true);
});

test('consumer cancellation stops the upstream request without completing inference', async () => {
  let cancelled = false;
  let upstreamSignal;
  for await (const item of invoke(async (_url, options) => {
    upstreamSignal = options.signal;
    return streaming(frame(delta(answer)) + frame(complete()), { chunkSize: 8, onCancel: () => { cancelled = true; } });
  })) {
    assert.equal(item.done, false);
    break;
  }
  assert.equal(cancelled, true);
  assert.equal(upstreamSignal.aborted, true);
});

test('malformed events, unexpected content types and overlarge streams fail clearly', async () => {
  await assert.rejects(collect(invoke(async () => streaming('data: broken JSON\n\n'))), { code: 'CHATGPT_INVALID_STREAM' });
  await assert.rejects(collect(invoke(async () => Response.json({ message: 'not SSE' }))), { code: 'CHATGPT_INVALID_STREAM' });
  await assert.rejects(collect(invoke(async () => streaming(':' + 'x'.repeat(8 * 1024 * 1024), { chunkSize: 1024 * 1024 }))), { code: 'CHATGPT_STREAM_TOO_LARGE' });
});

test('missing authorization and invalid message/model contracts fail before any network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('unexpected request'); };
  await assert.rejects(collect(invoke(fetchImpl, { accessToken: '' })), { code: 'CHATGPT_SIGN_IN_REQUIRED' });
  await assert.rejects(collect(invoke(fetchImpl, { model: '' })), { code: 'CHATGPT_MODEL_REQUIRED' });
  await assert.rejects(collect(invoke(fetchImpl, { messages: [{ role: 'assistant', content: 'No new user turn.' }] })), { code: 'CHATGPT_INVALID_MESSAGES' });
  assert.equal(calls, 0);
});
