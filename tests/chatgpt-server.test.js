import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createAppServer } from '../server.mjs';
import { ChatGPTResponseError } from '../server/chatgpt-responses.mjs';

const TOKEN = 'test-oauth-token-do-not-expose';
const requestBody = { messages: [{ role: 'user', content: 'What could I explore?' }], model: 'test-gpt' };

function authFixture() {
  const state = { connected: true, sharing: true, accountId: 'account-A', epoch: 1, selectedModel: 'test-gpt' };
  const calls = { start: [], callback: [], model: [], session: 0, disconnect: 0 };
  const auth = {
    async status() {
      const account = { id: state.accountId, label: 'My ChatGPT account', email: 'test@example.invalid', selectedModel: state.selectedModel, access_token: TOKEN };
      return { connected: state.connected, sharing: state.sharing, account, accounts: [account], refresh_token: 'never-public' };
    },
    async start(options) {
      calls.start.push(options);
      return { authorizationURL: `https://auth.openai.com/api/accounts/authorize?state=transaction-${calls.start.length}&redirect_uri=${encodeURIComponent(options.callbackOrigin + '/auth/callback')}` };
    },
    async callback(url) { calls.callback.push(url); state.connected = true; state.sharing = true; },
    async listModels() { return [{ slug: 'test-gpt', display_name: 'Test GPT', secret: TOKEN }]; },
    async selectModel(model, options) { calls.model.push({ model, options }); state.selectedModel = model; },
    async getSession() { calls.session++; return { accountId: state.accountId, accessToken: TOKEN, selectedModel: state.selectedModel, epoch: state.epoch }; },
    async disconnect() { calls.disconnect++; state.connected = false; state.epoch++; return { message: 'Signed out locally.', revocationConfirmed: true }; },
  };
  return { auth, state, calls };
}

async function start(t, overrides = {}) {
  const fixture = authFixture();
  const received = [];
  const server = createAppServer({
    chatgptAuth: fixture.auth,
    chatgptResponse: async function* (input) { received.push(input); yield { message: { content: 'An answer.' }, done: false }; yield { done: true }; },
    fetchImpl: async () => { throw new Error('Unexpected external network request'); },
    ...overrides,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(async () => {
    server.abortActiveRequests(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, port, origin: `http://127.0.0.1:${port}`, received, ...fixture };
}

function request(app, route, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: app.port, path: route, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}

function post(app, route, body = {}, headers = {}) {
  return request(app, route, { method: 'POST', body: JSON.stringify(body), headers: {
    origin: app.origin, 'content-type': 'application/json', 'x-dream-unity-account': 'account-A', ...headers,
  } });
}

test('plain server and static routes never construct an OAuth session', async (t) => {
  let factories = 0;
  const app = await start(t, { chatgptAuth: null, chatgptAuthFactory: () => { factories++; return authFixture().auth; } });
  await request(app, '/');
  await request(app, '/unknown');
  assert.equal(factories, 0);
  await request(app, '/api/chatgpt/status');
  assert.equal(factories, 1);
});

test('signed-out status is explicit and successful; inference explains the needed sign-in', async (t) => {
  const app = await start(t);
  app.state.connected = false; app.state.sharing = false;
  const status = await request(app, '/api/chatgpt/status');
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.text).connected, false);
  const answer = await post(app, '/api/chatgpt/chat', requestBody);
  assert.equal(answer.status, 401);
  assert.equal(JSON.parse(answer.text).code, 'CHATGPT_SIGN_IN_REQUIRED');
  assert.equal(app.received.length, 0);
});

test('status, account catalog and model catalog cannot expose OAuth credentials', async (t) => {
  const app = await start(t);
  for (const route of ['/api/chatgpt/status', '/api/chatgpt/models']) {
    const response = await request(app, route);
    assert.equal(response.status, 200);
    assert.doesNotMatch(response.text, /test-oauth|never-public|access_token|refresh_token|"secret"/);
  }
  const models = JSON.parse((await request(app, '/api/chatgpt/models')).text).models;
  assert.deepEqual(models, [{ slug: 'test-gpt', display_name: 'Test GPT' }]);
});

test('all writes require exact Origin; sign-in also requires canonical 127.0.0.1', async (t) => {
  const app = await start(t);
  for (const route of ['/api/chatgpt/auth/start', '/api/chatgpt/model', '/api/chatgpt/disconnect', '/api/chatgpt/chat']) {
    const response = await post(app, route, {}, { origin: 'https://attacker.invalid' });
    assert.equal(response.status, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await request(app, '/api/chatgpt/status', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const wrongHost = await post(app, '/api/chatgpt/auth/start', {}, { host: `localhost:${app.port}`, origin: `http://localhost:${app.port}` });
  assert.equal(wrongHost.status, 400);
  assert.equal(JSON.parse(wrongHost.text).code, 'CHATGPT_LOOPBACK_REQUIRED');
  assert.equal(app.calls.start.length, 0);
});

test('OAuth callback needs its one-use state and opaque HttpOnly transaction cookie', async (t) => {
  const app = await start(t);
  const starting = await post(app, '/api/chatgpt/auth/start');
  assert.equal(starting.status, 200);
  assert.equal(app.calls.start[0].includeIdTokenHint, false);
  const authorization = new URL(JSON.parse(starting.text).url);
  const state = authorization.searchParams.get('state');
  const setCookie = starting.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly; SameSite=Lax; Path=\/auth\/callback/);
  assert.doesNotMatch(setCookie, /transaction-1/);
  const cookie = setCookie.split(';')[0];
  const callback = `/auth/callback?state=${state}&code=one-use-code&client_id=oaiapp_test`;
  const denied = await request(app, callback);
  assert.equal(denied.status, 303);
  assert.match(denied.headers.location, /invalid_transaction/);
  assert.equal(app.calls.callback.length, 0);
  const valid = await request(app, callback, { headers: { cookie } });
  assert.equal(valid.status, 303);
  assert.equal(valid.headers.location, '/?chatgpt=connected');
  assert.equal(app.calls.callback.length, 1);
  const replay = await request(app, callback, { headers: { cookie } });
  assert.match(replay.headers.location, /invalid_transaction/);
  assert.equal(app.calls.callback.length, 1);
});

test('authorization URLs containing ID tokens are never returned to the page', async (t) => {
  const app = await start(t);
  app.auth.start = async () => ({ authorizationURL: 'https://auth.openai.com/api/accounts/authorize?state=abc&id_token_hint=secret-id-token' });
  const response = await post(app, '/api/chatgpt/auth/start');
  assert.equal(response.status, 502);
  assert.doesNotMatch(response.text, /secret-id-token/);
});

test('callback failures redirect with a fixed code, never provider details or credentials', async (t) => {
  const app = await start(t);
  app.auth.callback = async () => { throw new Error(`Provider failure ${TOKEN}`); };
  const starting = await post(app, '/api/chatgpt/auth/start');
  const cookie = starting.headers['set-cookie'][0].split(';')[0];
  const response = await request(app, '/auth/callback?state=transaction-1&code=private', { headers: { cookie } });
  assert.equal(response.headers.location, '/?chatgpt=error&code=sign_in_failed');
  assert.doesNotMatch(JSON.stringify(response), /private|test-oauth/);
});

test('model and chat requests bind to the displayed account and current available catalog', async (t) => {
  const app = await start(t);
  for (const route of ['/api/chatgpt/model', '/api/chatgpt/chat']) {
    const body = route.endsWith('/model') ? { model: 'test-gpt' } : requestBody;
    assert.equal((await post(app, route, body, { 'x-dream-unity-account': 'different-account' })).status, 409);
    assert.equal((await post(app, route, { ...body, model: 'unavailable' })).status, 400);
  }
  assert.equal(app.calls.session, 0);
  const selected = await post(app, '/api/chatgpt/model', { model: 'test-gpt' });
  assert.equal(selected.status, 200);
  assert.deepEqual(app.calls.model, [{ model: 'test-gpt', options: { accountId: 'account-A' } }]);
});

test('strict request schemas reject extra settings, unknown roles and missing final user messages', async (t) => {
  const app = await start(t);
  for (const body of [{ ...requestBody, temperature: 1 }, { ...requestBody, access_token: TOKEN },
    { ...requestBody, messages: [{ role: 'assistant', content: 'No new user turn' }] },
    { ...requestBody, messages: [{ role: 'tool', content: 'Hidden instruction' }] }, { messages: requestBody.messages }]) {
    assert.equal((await post(app, '/api/chatgpt/chat', body)).status, 400);
  }
  assert.equal(app.calls.session, 0);
  assert.equal(app.received.length, 0);
});

test('completed ChatGPT output streams through the server without forwarding its bearer token', async (t) => {
  const app = await start(t);
  const response = await post(app, '/api/chatgpt/chat', requestBody);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/x-ndjson/);
  assert.deepEqual(response.text.trim().split('\n').map(JSON.parse), [{ message: { content: 'An answer.' }, done: false }, { done: true }]);
  assert.equal(app.received[0].accessToken, TOKEN);
  assert.doesNotMatch(JSON.stringify(response), /test-oauth/);
  assert.equal(app.calls.session, 2); // Before inference and before terminal success.
});

test('a partial usage failure retains its code and never emits a done marker', async (t) => {
  const app = await start(t, { chatgptResponse: async function* () {
    yield { message: { content: 'A partial answer.' }, done: false };
    throw new ChatGPTResponseError(`Limit reported with ${TOKEN}`, { code: 'subscription_sharing_usage_limit_exceeded', status: 429, requestId: 'request-123' });
  } });
  const response = await post(app, '/api/chatgpt/chat', requestBody);
  const events = response.text.trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).code, 'subscription_sharing_usage_limit_exceeded');
  assert.equal(events.at(-1).requestId, 'request-123');
  assert.equal(events.some((item) => item.done === true), false);
  assert.doesNotMatch(response.text, /test-oauth/);
});

test('switching account while the catalog loads cannot send another account token', async (t) => {
  const app = await start(t);
  app.auth.listModels = async () => { app.state.accountId = 'account-B'; return [{ slug: 'test-gpt', display_name: 'Test GPT' }]; };
  const response = await post(app, '/api/chatgpt/chat', requestBody);
  assert.equal(response.status, 409);
  assert.equal(app.received.length, 0);
});

test('cross-process session epoch changes prevent a partial reply becoming a completed answer', async (t) => {
  let app;
  app = await start(t, { chatgptResponse: async function* () {
    yield { message: { content: 'Partial.' }, done: false };
    app.state.epoch++;
    yield { done: true };
  } });
  const response = await post(app, '/api/chatgpt/chat', requestBody);
  const events = response.text.trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).code, 'CHATGPT_ACCOUNT_CHANGED');
  assert.equal(events.some((item) => item.done === true), false);
});

test('disconnect aborts an in-flight ChatGPT answer before revoking the account', async (t) => {
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let aborted = false;
  const app = await start(t, { chatgptResponse: async function* ({ signal }) {
    started();
    await new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Stopped', 'AbortError')); }, { once: true }));
  } });
  const answering = post(app, '/api/chatgpt/chat', requestBody);
  await entered;
  const disconnected = await post(app, '/api/chatgpt/disconnect');
  await answering;
  assert.equal(aborted, true);
  assert.equal(disconnected.status, 200);
  assert.equal(JSON.parse(disconnected.text).connected, false);
  assert.equal(JSON.parse(disconnected.text).revocationConfirmed, true);
  assert.equal(app.calls.disconnect, 1);
});

test('request timeout aborts the upstream answer and exposes an actionable timeout', async (t) => {
  let aborted = false;
  const app = await start(t, { timeoutMs: 25, chatgptResponse: async function* ({ signal }) {
    await new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Stopped', 'AbortError')); }, { once: true }));
  } });
  const response = await post(app, '/api/chatgpt/chat', requestBody);
  assert.equal(response.status, 504);
  assert.equal(JSON.parse(response.text).code, 'CHATGPT_TIMEOUT');
  assert.equal(aborted, true);
});
