import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';
import { RESPONSE_SCHEMA } from '../src/response-schema.js';

const validBody = { messages: [{ role: 'system', content: 'You are a guide.' }, { role: 'user', content: 'Hello.' }] };

async function start(t, options = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'dream-unity-server-'));
  await Promise.all(['src', 'vendor', 'docs', 'tests', '.git'].map((name) => mkdir(path.join(rootDir, name))));
  await Promise.all([
    ['index.html', '<!doctype html><title>Dream Unity</title>'], ['style.css', 'body { color: white; }'],
    ['src/app.js', 'export const ready = true;'], ['vendor/engine.js', 'export const version = 1;'],
    ['docs/private.json', '{"private":true}'], ['.env', 'SECRET=do-not-serve'],
    ['server.mjs', 'server source'], ['package.json', '{"private":true}'],
    ['.git/config', 'git config'], ['src/.env', 'hidden'], ['src/settings.txt', 'non-asset'],
  ].map(([name, contents]) => writeFile(path.join(rootDir, name), contents)));
  const server = createAppServer({ rootDir, fetchImpl: async () => { throw new Error('Unexpected upstream request.'); }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.abortActiveRequests();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(rootDir, { recursive: true, force: true });
  });
  return { server, port, origin, rootDir };
}

function request(app, route, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: app.port, path: route, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function post(app, body = validBody, headers = {}) {
  return request(app, '/api/chat', { method: 'POST', body: JSON.stringify(body), headers: {
    'content-type': 'application/json', origin: app.origin, ...headers,
  } });
}

test('serves only intended public assets with defensive headers', async (t) => {
  const app = await start(t);
  for (const route of ['/', '/index.html', '/style.css', '/src/app.js?version=1', '/vendor/engine.js']) {
    const response = await request(app, route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['content-security-policy'], /worker-src 'self' blob:/);
    assert.match(response.headers['content-security-policy'], /script-src 'self' https:\/\/cdn\.jsdelivr\.net 'wasm-unsafe-eval'/);
  }
  const head = await request(app, '/src/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.match(head.headers['content-type'], /javascript/);
  assert.ok(Number(head.headers['content-length']) > 0);
});

test('denies documents, configuration, source server, hidden paths, and traversal', async (t) => {
  const app = await start(t);
  for (const route of [
    '/docs/private.json', '/tests/server.test.js', '/server.mjs', '/package.json', '/.env', '/.git/config',
    '/src/.env', '/src/settings.txt', '/src/../server.mjs', '/src/%2e%2e/server.mjs',
    '/src/%252e%252e/server.mjs', '/src%5c..%5cserver.mjs', '/src/%00app.js', '/src/%ZZ',
  ]) assert.equal((await request(app, route)).status, 404, route);
});

test('symlinks cannot expose otherwise denied files', async (t) => {
  const app = await start(t);
  await symlink(path.join(app.rootDir, 'docs/private.json'), path.join(app.rootDir, 'src/leak.json'));
  await symlink(path.join(app.rootDir, '.env'), path.join(app.rootDir, 'src/secret.js'));
  assert.equal((await request(app, '/src/leak.json')).status, 404);
  assert.equal((await request(app, '/src/secret.js')).status, 404);
});

test('DNS rebinding and mismatched listen ports are rejected before routing', async (t) => {
  const app = await start(t);
  for (const host of [`attacker.example:${app.port}`, `127.0.0.1:${app.port + 1}`, `localhost.attacker.test:${app.port}`, `user@127.0.0.1:${app.port}`]) {
    assert.equal((await request(app, '/', { headers: { host } })).status, 403, host);
  }
  assert.equal((await request(app, '/', { headers: { host: `localhost:${app.port}` } })).status, 200);
});

test('chat requires an exact same-origin Origin and never grants CORS', async (t) => {
  const app = await start(t);
  for (const origin of ['https://evil.test', 'null', `${app.origin}/`, `http://localhost:${app.port}`]) {
    const response = await post(app, validBody, { origin });
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const missingOrigin = await request(app, '/api/chat', { method: 'POST', body: JSON.stringify(validBody), headers: { 'content-type': 'application/json' } });
  assert.equal(missingOrigin.status, 403);
  assert.equal((await request(app, '/api/chat', { method: 'OPTIONS', headers: { origin: 'https://evil.test' } })).status, 405);
  assert.equal((await request(app, '/api/health', { headers: { origin: 'https://evil.test' } })).status, 403);
});

test('rejects malformed schemas and client-controlled model/options without upstream calls', async (t) => {
  let calls = 0;
  const app = await start(t, { fetchImpl: async () => { calls += 1; return Response.json({}); } });
  for (const body of [
    null, [], {}, { messages: [] }, { messages: new Array(33).fill({ role: 'user', content: 'Hi' }) },
    { ...validBody, model: 'unapproved' }, { ...validBody, options: { num_ctx: 9999999 } },
    { ...validBody, format: { type: 'string' } },
    { messages: [{ role: 'tool', content: 'Hi' }] }, { messages: [{ role: 'user', content: '' }] },
    { messages: [{ role: 'user', content: ' '.repeat(10) }] }, { messages: [{ role: 'user', content: 'a'.repeat(6001) }] },
    { messages: [{ role: 'user', content: 1 }] }, { messages: [{ role: 'user', content: 'Hi', images: ['data'] }] },
  ]) assert.equal((await post(app, body)).status, 400, JSON.stringify(body)?.slice(0, 100));
  assert.equal(calls, 0);
});

test('body limits apply to announced and streamed request sizes; wrong content type is rejected', async (t) => {
  const app = await start(t);
  assert.equal((await post(app, validBody, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(app, validBody, { 'content-length': 50000 })).status, 413);
  assert.equal((await post(app, { messages: new Array(8).fill({ role: 'user', content: 'x'.repeat(5900) }) })).status, 413);
  const malformed = await request(app, '/api/chat', { method: 'POST', body: '{invalid', headers: { origin: app.origin, 'content-type': 'application/json' } });
  assert.equal(malformed.status, 400);
});

test('streams NDJSON from the server-selected local model with sanitized messages', async (t) => {
  let sent;
  const output = '{"message":{"content":"Hello"},"done":false}\n{"done":true}\n';
  const app = await start(t, { model: 'qwen2.5:1.5b', ollamaUrl: 'http://localhost:11434', fetchImpl: async (url, options) => {
    sent = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(output, { headers: { 'content-type': 'application/x-ndjson' } });
  } });
  const response = await post(app);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /x-ndjson/);
  assert.equal(response.text, output);
  assert.equal(sent.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(sent.options.redirect, 'error');
  assert.deepEqual(sent.body, {
    model: 'qwen2.5:1.5b', messages: validBody.messages, stream: true,
    format: RESPONSE_SCHEMA,
    options: { num_predict: 512, temperature: 0.4, num_ctx: 4096 },
  });
});

test('health distinguishes a present model, a missing model, and an unreachable service', async (t) => {
  let response = () => Response.json({ models: [{ name: 'qwen2.5:1.5b' }] });
  const app = await start(t, { fetchImpl: async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/tags');
    assert.equal(options.redirect, 'error');
    return response();
  } });
  const ready = await request(app, '/api/health');
  assert.equal(ready.status, 200);
  assert.deepEqual(JSON.parse(ready.text), { ok: true, provider: 'local', model: 'qwen2.5:1.5b', ready: true });
  response = () => Response.json({ models: [{ name: 'some-other-model' }] });
  const missing = await request(app, '/api/health');
  assert.equal(missing.status, 503);
  assert.match(JSON.parse(missing.text).error, /ollama pull qwen2\.5:1\.5b/);
  response = () => Response.json({ models: [{ name: 'qwen2.5:1.5b', remote_model: 'cloud-model', remote_host: 'https://cloud.example' }] });
  const remote = await request(app, '/api/health');
  assert.equal(remote.status, 503);
  assert.equal(JSON.parse(remote.text).ready, false);
  assert.match(JSON.parse(remote.text).error, /Choose a locally installed model/);
  assert.doesNotMatch(remote.text, /cloud\.example/);
  response = () => { throw new Error('Private upstream detail'); };
  const unavailable = await request(app, '/api/health');
  assert.equal(unavailable.status, 503);
  assert.match(JSON.parse(unavailable.text).error, /Start Ollama/);
  assert.doesNotMatch(unavailable.text, /Private upstream detail/);
});

test('health understands an untagged model as its latest tag', async (t) => {
  const app = await start(t, { model: 'my-model', fetchImpl: async () => Response.json({ models: [{ model: 'my-model:latest' }] }) });
  assert.equal((await request(app, '/api/health')).status, 200);
});

test('unknown API paths cannot pull models or relay arbitrary requests', async (t) => {
  const app = await start(t);
  for (const route of ['/api/pull', '/api/delete', '/api/proxy?url=http://example.com']) {
    assert.equal((await request(app, route)).status, 404);
    assert.equal((await request(app, route, { method: 'POST', headers: { origin: app.origin } })).status, 405);
  }
});

test('upstream errors are actionable and never relay provider internals', async (t) => {
  const app = await start(t, { fetchImpl: async () => new Response('private provider trace', { status: 500 }) });
  const response = await post(app);
  assert.equal(response.status, 502);
  assert.match(response.text, /Check Ollama/);
  assert.doesNotMatch(response.text, /private provider trace/);
});

test('timeout aborts a pending upstream fetch and reports 504', async (t) => {
  let aborted = false;
  const app = await start(t, { timeoutMs: 25, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  const response = await post(app);
  assert.equal(response.status, 504);
  assert.equal(aborted, true);
  assert.match(response.text, /too long/);
});

test('client disconnect aborts a pending upstream request', async (t) => {
  const started = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const app = await start(t, { fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted.resolve(); reject(signal.reason); }, { once: true });
    started.resolve();
  }) });
  const req = http.request({ hostname: '127.0.0.1', port: app.port, path: '/api/chat', method: 'POST', headers: {
    origin: app.origin, 'content-type': 'application/json',
  } });
  req.on('error', () => {});
  req.end(JSON.stringify(validBody));
  await started.promise;
  req.destroy();
  await Promise.race([aborted.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Upstream was not canceled.')), 1000).unref())]);
});

test('client disconnect while streaming cancels upstream generation', async (t) => {
  const aborted = Promise.withResolvers();
  const app = await start(t, { fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"message":{"content":"First"},"done":false}\n'));
      signal.addEventListener('abort', () => { aborted.resolve(); controller.error(signal.reason); }, { once: true });
    },
  })) });
  const response = await fetch(`${app.origin}/api/chat`, { method: 'POST', headers: {
    origin: app.origin, 'content-type': 'application/json',
  }, body: JSON.stringify(validBody) });
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  await Promise.race([aborted.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Streaming upstream was not canceled.')), 1000).unref())]);
});

test('active requests can be aborted during graceful shutdown', async (t) => {
  const started = Promise.withResolvers();
  let aborted = false;
  const app = await start(t, { fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    started.resolve();
  }) });
  const pending = post(app);
  await started.promise;
  app.server.abortActiveRequests();
  assert.equal((await pending).status, 502);
  assert.equal(aborted, true);
});

test('invalid upstream URLs and model names fail at startup', () => {
  for (const ollamaUrl of [
    'https://example.com', 'http://192.168.1.10:11434', 'http://evil.test', 'http://127.0.0.1:11434/path',
    'http://user:pass@localhost:11434', 'http://localhost:11434?remote=yes', 'file:///etc/passwd',
  ]) assert.throws(() => createAppServer({ ollamaUrl }), /OLLAMA_URL/);
  assert.throws(() => createAppServer({ model: 'model; shell command' }), /OLLAMA_MODEL/);
  assert.throws(() => createAppServer({ timeoutMs: 0 }), /timeoutMs/);
});
