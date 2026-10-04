import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createPublicApiHandler } from '../server/public-api.mjs';
import { createNodeApiHandler } from '../api/nexus.mjs';
import { transcribePublicAudio, MAX_AUDIO_BYTES, PUBLIC_TRANSCRIPTION_URL } from '../server/public-audio.mjs';
import { PublicModelError } from '../server/public-model.mjs';

const origin = 'https://start-fresh.example';
const pages = 'https://dream-unity.github.io';
const messages = [{ role: 'user', content: 'Help me take one step.' }];
const reply = { reply: 'What small step matters today?', region: 'maker', focus: 'One small step', memory: null };
const token = 'owner-test-token';
function makeRequest(op = 'chat', { method = op === 'status' ? 'GET' : 'POST', body = { messages }, headers = {}, signal } = {}) {
  return new Request(`${origin}/api/nexus?op=${op}`, {
    method, signal,
    headers: { Origin: origin, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(['GET', 'HEAD', 'OPTIONS'].includes(method) ? {} : { body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
}
function handler(options = {}) {
  return createPublicApiHandler({ getToken: async () => token, generateReply: async () => reply, ...options });
}

test('anonymous status is uncached and checks configuration without inference or credentials in output', async () => {
  let calls = 0;
  const handle = handler({ generateReply: () => { calls++; throw new Error('Not needed.'); } });
  const response = await handle(makeRequest('status'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.deepEqual(await response.json(), { ready: true, configured: true, availability: 'configured', model: 'openai/gpt-4.1-mini', transcription: true });
  assert.equal(calls, 0);
});

test('anonymous chat passes only fixed server model, bounded messages and approved-note context', async () => {
  let received;
  const context = { region: 'maker', memory: [{ kind: 'goal', text: 'Practice painting.' }] };
  const handle = handler({ generateReply: async (input) => { received = input; return reply; } });
  const response = await handle(makeRequest('chat', { body: { messages, context }, headers: { Origin: pages } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), pages);
  assert.deepEqual(await response.json(), reply);
  assert.deepEqual(received.messages, messages);
  assert.deepEqual(received.context, context);
  assert.equal(received.token, token);
  assert.equal(received.model, 'openai/gpt-4.1-mini');
  assert.equal((await handle(makeRequest('chat', { body: { messages, model: 'attacker/model' } }))).status, 400);
});

test('exact origin checks reject lookalikes, missing/null Origin and malicious preflights before owner access', async () => {
  let called = 0;
  const handle = handler({ getToken: () => { called++; return token; }, allowedOrigins: ['https://approved.example', 'https://bad.example/path'] });
  for (const bad of ['null', 'https://dream-unity.github.io.evil.example', `${pages}/`, 'https://bad.example', 'https://attacker.example']) {
    const response = await handle(makeRequest('chat', { headers: { Origin: bad } }));
    assert.equal(response.status, 403, bad);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const missingOrigin = makeRequest();
  missingOrigin.headers.delete('origin');
  assert.equal((await handle(missingOrigin)).status, 403);
  assert.equal((await handle(makeRequest('chat', { method: 'OPTIONS', headers: { Origin: 'https://attacker.example' } }))).status, 403);
  assert.equal(called, 0);
  const approved = await handle(makeRequest('chat', { method: 'OPTIONS', headers: { Origin: 'https://approved.example', 'Access-Control-Request-Headers': 'content-type' } }));
  assert.equal(approved.status, 204);
  assert.equal(approved.headers.get('access-control-allow-origin'), 'https://approved.example');
  assert.equal(approved.headers.get('access-control-allow-headers'), 'Content-Type');
  assert.equal(called, 0);
});

test('unknown operations and methods are rejected without obtaining the owner token', async () => {
  const handle = handler({ getToken: () => { throw new Error('Must not get a token.'); } });
  assert.equal((await handle(makeRequest('other'))).status, 404);
  assert.equal((await handle(makeRequest('chat', { method: 'GET' }))).status, 405);
  assert.equal((await handle(makeRequest('status', { method: 'POST' }))).status, 405);
});

test('invalid JSON, unsupported types, declared and actual oversize uploads never reach inference', async () => {
  let called = 0;
  const handle = handler({ getToken: () => { called++; return token; } });
  const cases = [
    [makeRequest('chat', { body: '{broken' }), 400],
    [makeRequest('chat', { body: [] }), 400],
    [makeRequest('chat', { body: { messages: 'bad' } }), 400],
    [makeRequest('chat', { headers: { 'Content-Type': 'text/plain' } }), 415],
    [makeRequest('chat', { headers: { 'Content-Length': String(33 * 1024) } }), 413],
    [makeRequest('chat', { body: { messages: [{ role: 'user', content: 'a'.repeat(33 * 1024) }] } }), 413],
    [makeRequest('transcribe', { body: new Uint8Array(MAX_AUDIO_BYTES + 1), headers: { 'Content-Type': 'audio/webm' } }), 413],
    [makeRequest('transcribe', { body: new Uint8Array(), headers: { 'Content-Type': 'audio/webm' } }), 400],
    [makeRequest('transcribe', { body: new Uint8Array([1]), headers: { 'Content-Type': 'text/plain' } }), 415],
  ];
  for (const [request, expected] of cases) assert.equal((await handle(request)).status, expected);
  assert.equal(called, 0);
});

test('configuration failures and unexpected exceptions never leak owner or provider diagnostics', async () => {
  const first = await handler({ getToken: () => { throw new Error(`secret ${token}`); } })(makeRequest('status'));
  assert.equal(first.status, 503);
  const status = await first.json();
  assert.equal(status.ready, false);
  assert.equal(status.code, 'PUBLIC_CONFIGURATION_REQUIRED');
  const second = await handler({ generateReply: () => { throw new Error(`provider says secret ${token}`); } })(makeRequest());
  assert.equal(second.status, 503);
  assert.doesNotMatch(await second.text(), /owner-test-token|provider says|stack/);
  const safe = await handler({ generateReply: () => { throw new PublicModelError('The allowance has been used.', { status: 503, code: 'PUBLIC_ALLOWANCE_EXHAUSTED' }); } })(makeRequest());
  assert.equal((await safe.json()).code, 'PUBLIC_ALLOWANCE_EXHAUSTED');
});

test('rate limits expire and active request concurrency is released after completion', async () => {
  let timestamp = 10;
  const limited = handler({ maxRequestsPerMinute: 1, now: () => timestamp });
  assert.equal((await limited(makeRequest(), { clientKey: 'visitor' })).status, 200);
  const blocked = await limited(makeRequest(), { clientKey: 'visitor' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  timestamp += 60_000;
  assert.equal((await limited(makeRequest(), { clientKey: 'visitor' })).status, 200);
  let finish;
  const busy = handler({ maxConcurrent: 1, generateReply: () => new Promise((resolve) => { finish = resolve; }) });
  const active = busy(makeRequest());
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await busy(makeRequest())).status, 429);
  finish(reply);
  assert.equal((await active).status, 200);
  assert.equal((await busy(makeRequest('status'))).status, 200);
});

test('request cancellation and deadline abort upstream work without retry', async () => {
  let activeSignal;
  let calls = 0;
  const generateReply = ({ signal }) => { activeSignal = signal; calls++; return new Promise(() => {}); };
  const controller = new AbortController();
  const cancelled = handler({ generateReply })(makeRequest('chat', { signal: controller.signal }));
  while (!activeSignal) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal((await cancelled).status, 499);
  assert.equal(activeSignal.aborted, true);
  const timeout = await handler({ generateReply, timeoutMs: 15 })(makeRequest());
  assert.equal(timeout.status, 504);
  assert.equal(activeSignal.aborted, true);
  assert.equal(calls, 2);
});

test('a stalled upload is deadline bounded before credentials or inference are obtained', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([123])); } });
  const request = new Request(`${origin}/api/nexus?op=chat`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body, duplex: 'half' });
  let obtained = false;
  const response = await handler({ timeoutMs: 15, getToken: () => { obtained = true; return token; } })(request);
  assert.equal(response.status, 504);
  assert.equal(obtained, false);
});

test('recorded WebM is forwarded through the documented Gateway transcription protocol', async () => {
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
  let forwarded;
  const response = await handler({ fetchImpl: async (url, init) => {
    forwarded = { url, init };
    return Response.json({ text: '  I want to create something.  ', segments: [], durationInSeconds: 2 });
  } })(makeRequest('transcribe', { body: bytes, headers: { 'Content-Type': 'audio/webm;codecs=opus' } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'I want to create something.' });
  assert.equal(forwarded.url, PUBLIC_TRANSCRIPTION_URL);
  assert.equal(forwarded.init.headers.Authorization, `Bearer ${token}`);
  assert.equal(forwarded.init.headers['ai-gateway-protocol-version'], '0.0.1');
  assert.equal(forwarded.init.headers['ai-transcription-model-specification-version'], '4');
  assert.equal(forwarded.init.headers['ai-model-id'], 'openai/whisper-1');
  assert.deepEqual(JSON.parse(forwarded.init.body), { audio: Buffer.from(bytes).toString('base64'), mediaType: 'audio/webm' });
  assert.equal(forwarded.init.redirect, 'error');
});

test('transcription rejects malformed/oversized responses and redacts failed upstream bodies', async () => {
  const options = { audio: new Uint8Array([1]), mediaType: 'audio/mp4', token };
  for (const response of [Response.json({ text: 42 }), Response.json({ text: 'a'.repeat(70_000) }), new Response('not json')]) {
    await assert.rejects(transcribePublicAudio({ ...options, fetchImpl: async () => response }), { code: 'PUBLIC_TRANSCRIPTION_UNAVAILABLE' });
  }
  await assert.rejects(transcribePublicAudio({ ...options, fetchImpl: async () => new Response(`token ${token}`, { status: 402 }) }), { code: 'PUBLIC_ALLOWANCE_EXHAUSTED' });
  assert.deepEqual(await transcribePublicAudio({ ...options, fetchImpl: async () => Response.json({ text: '' }) }), { text: '' });
});

async function startNode(t, handle) {
  const server = http.createServer(createNodeApiHandler(handle));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` };
}

test('Node HTTP adapter preserves raw audio, CORS isolation and JSON reply without visitor auth', async (t) => {
  let forwarded;
  const app = await startNode(t, handler({ transcribe: async (input) => { forwarded = input; return { text: 'A new idea.' }; } }));
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 255, 128]);
  const response = await fetch(`${app.origin}/api/nexus?op=transcribe`, { method: 'POST', body: bytes, headers: { Origin: pages, 'Content-Type': 'audio/webm;codecs=opus' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'A new idea.' });
  assert.deepEqual([...forwarded.audio], [...bytes]);
  assert.equal(forwarded.mediaType, 'audio/webm');
  const denied = await fetch(`${app.origin}/api/nexus?op=chat`, { method: 'POST', body: JSON.stringify({ messages }), headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' } });
  assert.equal(denied.status, 403);
});

test('disconnecting an HTTP visitor aborts the active upstream operation', async (t) => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let stopped;
  const stoppedPromise = new Promise((resolve) => { stopped = resolve; });
  const app = await startNode(t, handler({ generateReply: ({ signal }) => {
    started();
    signal.addEventListener('abort', stopped, { once: true });
    return new Promise(() => {});
  } }));
  const req = http.request({ hostname: '127.0.0.1', port: app.port, path: '/api/nexus?op=chat', method: 'POST', headers: { Origin: pages, 'Content-Type': 'application/json' } });
  req.on('error', () => {});
  req.end(JSON.stringify({ messages }));
  await startedPromise;
  req.destroy();
  await stoppedPromise;
});
