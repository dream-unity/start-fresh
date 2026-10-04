import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChatGPTAuth } from '../server/chatgpt-auth.mjs';

const ISSUER = 'https://auth.openai.com';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };

function jwt(payload, header = {}, key = pair.privateKey) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const base = `${encode({ alg: 'RS256', kid: 'fixture-key', ...header })}.${encode(payload)}`;
  return `${base}.${sign('sha256', Buffer.from(base), key).toString('base64url')}`;
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dream-siwc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = {
    time: 1800000000000, nonce: null, client: 'oaiapp_alpha', subject: 'person-one',
    scope: SCOPES, claims: {}, header: {}, key: pair.privateKey, calls: [], refreshes: 0,
    models: [{ slug: 'gpt-6.1-sol', display_name: 'Sol', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' }],
    tokenHook: null, modelHook: null, revokeHook: null, discoveryOverride: {},
  };
  context.tokens = (extra = {}) => ({
    id_token: jwt({ iss: ISSUER, sub: context.subject, aud: context.client, iat: context.time / 1000,
      exp: context.time / 1000 + 3600, nonce: context.nonce, email: 'same@example.test', name: 'Fixture User', ...context.claims }, context.header, context.key),
    access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', token_type: 'Bearer', expires_in: 3600, scope: context.scope, ...extra,
  });
  context.fetch = async (url, options = {}) => {
    const address = String(url);
    assert.equal(options.redirect, 'error', 'credential requests must never follow redirects');
    context.calls.push({ url: address, options });
    if (address.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/api/accounts/authorize`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
      id_token_signing_alg_values_supported: ['RS256', 'ES256'], ...context.discoveryOverride });
    if (address.endsWith('/.well-known/jwks.json')) return context.keysHook ? context.keysHook(options) : Response.json({ keys: [jwk] });
    if (address.endsWith('/oauth/token')) {
      const form = new URLSearchParams(options.body);
      if (form.get('grant_type') === 'refresh_token') context.refreshes += 1;
      if (context.tokenHook) return context.tokenHook(form, options);
      return Response.json(context.tokens());
    }
    if (address.endsWith('/oauth/revoke')) return context.revokeHook ? context.revokeHook(options) : new Response(null, { status: 200 });
    if (address === 'https://api.openai.com/v1/models') return context.modelHook ? context.modelHook(options) : Response.json({ models: context.models });
    throw new Error('Unexpected endpoint');
  };
  context.make = extra => createChatGPTAuth({ storageDir: directory, fetchImpl: context.fetch, now: () => context.time, requestTimeoutMs: 1000, ...extra });
  context.auth = context.make();
  context.begin = async (options = {}) => {
    const { authorizationURL } = await context.auth.start({ callbackOrigin: 'http://127.0.0.1:4173', ...options });
    const authorization = new URL(authorizationURL);
    context.nonce = authorization.searchParams.get('nonce');
    if (authorization.searchParams.get('client_id') !== 'dynamic_agent_client') context.client = authorization.searchParams.get('client_id');
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    callback.searchParams.set('code', 'fixture-authorization-code');
    callback.searchParams.set('client_id', context.client);
    return { authorization, callback };
  };
  context.connect = async (options = {}) => { const attempt = await context.begin(options); return context.auth.callback(attempt.callback); };
  context.saved = async () => JSON.parse(await readFile(path.join(directory, 'auth.json'), 'utf8'));
  context.directory = directory;
  return context;
}

test('first sign-in uses stable private host storage and fresh PKCE/state/nonce', async t => {
  const f = await fixture(t);
  const first = await f.begin();
  const saved = await f.saved();
  assert.match(saved.hostId, /^urn:uuid:/);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(f.directory, 'auth.json'))).mode & 0o777, 0o600);
  assert.equal(first.authorization.origin, ISSUER);
  assert.equal(first.authorization.searchParams.get('scope'), SCOPES);
  assert.equal(first.authorization.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.equal(first.authorization.searchParams.get('agent_name_hint'), 'Dream Unity');
  const next = await f.begin();
  assert.equal(next.authorization.searchParams.get('ext_agent_host_id'), saved.hostId);
  for (const key of ['state', 'nonce', 'code_challenge']) assert.notEqual(first.authorization.searchParams.get(key), next.authorization.searchParams.get(key));
  await assert.rejects(f.auth.start({ callbackOrigin: 'http://localhost:4173' }), { code: 'invalid_callback_origin' });
  await assert.rejects(f.auth.start({ callbackOrigin: 'https://attacker.test' }), { code: 'invalid_callback_origin' });
});

test('sign-in verifies signature, exchanges exact PKCE and exposes no credentials', async t => {
  const f = await fixture(t);
  const attempt = await f.begin();
  const result = await f.auth.callback(attempt.callback);
  assert.equal(result.connected, true); assert.equal(result.sharing, true);
  assert.equal(result.account.email, 'same@example.test');
  const exchange = f.calls.find(call => call.url.endsWith('/oauth/token'));
  const form = new URLSearchParams(exchange.options.body);
  assert.equal(form.get('client_id'), 'oaiapp_alpha');
  assert.equal(form.get('redirect_uri'), 'http://127.0.0.1:4173/auth/callback');
  assert.equal(form.get('resource'), 'https://api.openai.com/v1');
  assert.equal(form.has('client_secret'), false);
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), attempt.authorization.searchParams.get('code_challenge'));
  assert.doesNotMatch(JSON.stringify(result), /fixture-access|fixture-refresh|idToken|oaiapp_alpha/);
  assert.equal(await f.auth.getAccessToken(), 'fixture-access-token');
  const session = await f.auth.getSession();
  assert.equal(session.accountId, result.account.id); assert.equal(typeof session.epoch, 'number');
  const returning = await f.begin();
  assert.equal(returning.authorization.searchParams.get('client_id'), 'oaiapp_alpha');
  assert.equal(returning.authorization.searchParams.has('agent_name_hint'), false);
  assert.equal(returning.authorization.searchParams.has('id_token_hint'), false);
  assert.equal(returning.authorization.searchParams.get('login_hint'), 'same@example.test');
});

test('callback state is one-use, time-limited, exact-path, and checked before errors or code exchange', async t => {
  const f = await fixture(t);
  const attempt = await f.begin(); attempt.callback.searchParams.set('state', 'attacker');
  attempt.callback.searchParams.set('error', 'access_denied');
  await assert.rejects(f.auth.callback(attempt.callback), { code: 'invalid_oauth_state' });
  assert.equal(f.calls.length, 0);
  const denied = await f.begin(); denied.callback.searchParams.set('error', 'access_denied');
  await assert.rejects(f.auth.callback(denied.callback), { code: 'oauth_declined' });
  assert.equal(f.calls.length, 0);
  const expired = await f.begin(); f.time += 10 * 60 * 1000;
  await assert.rejects(f.auth.callback(expired.callback), { code: 'invalid_oauth_state' });
  const wrongPath = await f.begin(); wrongPath.callback.pathname = '/callback';
  await assert.rejects(f.auth.callback(wrongPath.callback), { code: 'invalid_oauth_state' });
  const replay = await f.begin(); await f.auth.callback(replay.callback);
  await assert.rejects(f.auth.callback(replay.callback), { code: 'invalid_oauth_state' });
});

test('an issued registration survives invalid_grant and is reused on retry', async t => {
  const f = await fixture(t);
  f.tokenHook = () => Response.json({ error: 'invalid_grant', error_description: 'do not expose fixture-code' }, { status: 400 });
  const attempt = await f.begin();
  await assert.rejects(f.auth.callback(attempt.callback), error => error.code === 'invalid_grant' && !error.message.includes('fixture-code'));
  assert.equal((await f.saved()).registrations[0].clientId, 'oaiapp_alpha');
  assert.equal((await f.auth.status()).connected, false);
  const next = await f.begin(); assert.equal(next.authorization.searchParams.get('client_id'), 'oaiapp_alpha');
});

test('invalid identity claims, signatures, algorithms, and key URLs are rejected', async t => {
  const cases = [
    { claims: { iss: 'https://attacker.test' } }, { claims: { aud: 'oaiapp_other' } },
    { claims: { aud: ['oaiapp_alpha', 'oaiapp_other'] } }, { claims: { nonce: 'incorrect' } },
    { claims: { exp: 1 } }, { claims: { iat: 1900000000 } }, { claims: { sub: '' } },
    { key: otherPair.privateKey }, { header: { alg: 'HS256' } },
    { header: { jku: 'https://attacker.test/keys' } }, { header: { crit: ['extra'] } },
  ];
  for (const changes of cases) await t.test(JSON.stringify(changes.claims || changes.header || { signature: 'wrong' }), async sub => {
    const f = await fixture(sub); Object.assign(f, changes);
    await assert.rejects(f.connect(), { code: 'invalid_id_token' });
    assert.equal((await f.auth.status()).connected, false);
    assert.equal((await f.saved()).registrations[0].tokens, null);
  });
});

test('returning client and subject cannot overwrite another identity', async t => {
  const f = await fixture(t); const original = await f.connect();
  const wrongClient = await f.begin(); wrongClient.callback.searchParams.set('client_id', 'oaiapp_other');
  await assert.rejects(f.auth.callback(wrongClient.callback), { code: 'invalid_oauth_callback' });
  f.subject = 'different-person';
  await assert.rejects(f.connect(), { code: 'invalid_id_token' });
  const saved = await f.saved();
  assert.equal(saved.registrations[0].subject, 'person-one');
  assert.equal((await f.auth.status()).account.id, original.account.id);
  assert.equal(await f.auth.getAccessToken(), 'fixture-access-token');
});

test('identity-only consent remains connected but cannot invoke the plan', async t => {
  const f = await fixture(t); f.scope = 'openid profile email';
  const result = await f.connect();
  assert.equal(result.connected, true); assert.equal(result.sharing, false);
  await assert.rejects(f.auth.getAccessToken(), { code: 'sharing_disabled' });
  const next = await f.begin({ enableSharing: true });
  assert.equal(next.authorization.searchParams.get('prompt'), 'consent');
  assert.equal(next.authorization.searchParams.get('scope'), SCOPES);
});

test('same-email registrations remain isolated and can be selected independently', async t => {
  const f = await fixture(t); const one = await f.connect();
  f.client = 'oaiapp_beta'; f.subject = 'person-two';
  const two = await f.connect({ newAccount: true });
  assert.equal(two.accounts.length, 2); assert.notEqual(one.account.id, two.account.id);
  assert.notEqual(two.accounts[0].label, two.accounts[1].label);
  await f.auth.selectAccount(one.account.id);
  const first = await f.auth.status(); assert.equal(first.account.id, one.account.id);
  const saved = await f.saved();
  assert.equal(saved.registrations[0].clientId, 'oaiapp_alpha');
  assert.equal(saved.registrations[1].clientId, 'oaiapp_beta');
});

test('live model catalog preserves visibility and ordering, and validates selection', async t => {
  const f = await fixture(t); await f.connect();
  f.models.push({ slug: 'gpt-6-astra', display_name: 'Astra', visibility: 'list' });
  assert.deepEqual(await f.auth.listModels(), [{ slug: 'gpt-6.1-sol', display_name: 'Sol' }, { slug: 'gpt-6-astra', display_name: 'Astra' }]);
  await assert.rejects(f.auth.selectModel('hidden'), { code: 'model_unavailable' });
  await assert.rejects(f.auth.selectModel('gpt-6.1-sol', { accountId: 'another-registration' }), { code: 'account_changed' });
  assert.equal((await f.auth.selectModel('gpt-6-astra')).account.selectedModel, 'gpt-6-astra');
});

test('rotating refresh is single-flight across calls and separate module instances', async t => {
  const f = await fixture(t); await f.connect(); f.time += 3590 * 1000;
  f.tokenHook = async form => {
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'fixture-refresh-token');
    assert.equal(form.has('scope'), false);
    await new Promise(resolve => setTimeout(resolve, 30));
    return Response.json(f.tokens({ access_token: 'rotated-access-token', refresh_token: 'rotated-refresh-token', id_token: undefined }));
  };
  const second = f.make();
  const results = await Promise.all([f.auth.getAccessToken(), f.auth.getAccessToken(), second.getAccessToken()]);
  assert.deepEqual(results, ['rotated-access-token', 'rotated-access-token', 'rotated-access-token']);
  assert.equal(f.refreshes, 1);
  assert.equal((await f.saved()).registrations[0].tokens.refreshToken, 'rotated-refresh-token');
});

test('terminal refresh errors clear tokens; transient failures preserve them', async t => {
  const f = await fixture(t); await f.connect(); f.time += 3590 * 1000;
  f.tokenHook = () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
  await assert.rejects(f.auth.getAccessToken(), { code: 'temporarily_unavailable' });
  assert.equal((await f.auth.status()).connected, true);
  f.tokenHook = () => Response.json({ error: 'refresh_token_reused' }, { status: 400 });
  await assert.rejects(f.auth.getAccessToken(), { code: 'refresh_token_reused' });
  assert.equal((await f.auth.status()).connected, false);
  assert.equal((await f.saved()).registrations[0].clientId, 'oaiapp_alpha');
});

test('earliest_refresh_at is honored instead of refreshing too soon', async t => {
  const f = await fixture(t);
  f.tokenHook = () => Response.json(f.tokens({ expires_in: 30, earliest_refresh_at: f.time / 1000 + 60 }));
  await f.connect();
  assert.equal(await f.auth.getAccessToken(), 'fixture-access-token'); assert.equal(f.refreshes, 0);
  f.time += 31000;
  await assert.rejects(f.auth.getAccessToken(), { code: 'refresh_not_ready' });
});

test('logout revokes renewable session, clears credentials, and retains registration and host', async t => {
  const f = await fixture(t); await f.connect(); const before = await f.saved();
  const result = await f.auth.disconnect();
  assert.equal(result.connected, false); assert.equal(result.revocationConfirmed, true);
  const revocation = f.calls.find(call => call.url.endsWith('/oauth/revoke'));
  const form = new URLSearchParams(revocation.options.body);
  assert.equal(form.get('token'), 'fixture-refresh-token');
  assert.equal(form.get('token_type_hint'), 'refresh_token'); assert.equal(form.get('client_id'), 'oaiapp_alpha');
  const after = await f.saved();
  assert.equal(after.hostId, before.hostId); assert.equal(after.registrations[0].tokens, null);
  assert.equal(after.registrations[0].subject, 'person-one');
  const next = await f.begin(); assert.equal(next.authorization.searchParams.has('id_token_hint'), false);
});

test('failed revocation clears locally and reports the remaining remote step', async t => {
  const f = await fixture(t); await f.connect(); let attempts = 0;
  f.revokeHook = () => { attempts += 1; return new Response(null, { status: 503 }); };
  const result = await f.auth.disconnect();
  assert.equal(result.connected, false); assert.equal(result.revocationConfirmed, false);
  assert.equal(attempts, 2); assert.match(result.message, /ChatGPT settings/);
});

test('logout lets an in-flight rotation settle, revokes the newest token, and cannot reconnect', async t => {
  const f = await fixture(t); await f.connect(); f.time += 3590 * 1000;
  const started = Promise.withResolvers();
  const complete = Promise.withResolvers();
  f.tokenHook = async () => { started.resolve(); await complete.promise; return Response.json(f.tokens({ access_token: 'new-access', refresh_token: 'new-refresh', id_token: undefined })); };
  const refresh = f.auth.getAccessToken(); const rejection = assert.rejects(refresh, { code: 'auth_interrupted' });
  await started.promise; const logout = f.auth.disconnect();
  complete.resolve();
  await rejection; await logout;
  assert.equal((await f.auth.status()).connected, false);
  const revocation = f.calls.find(call => call.url.endsWith('/oauth/revoke'));
  assert.equal(new URLSearchParams(revocation.options.body).get('token'), 'new-refresh');
});

test('disconnect in another instance invalidates a pending OAuth callback', async t => {
  const f = await fixture(t); await f.connect(); const pending = await f.begin();
  const second = f.make(); await second.disconnect();
  await assert.rejects(f.auth.callback(pending.callback), { code: 'auth_interrupted' });
  assert.equal((await second.status()).connected, false);
});

test('logout during first identity verification revokes the issued session and reports cleanup accurately', async t => {
  for (const revocationSucceeds of [true, false]) await t.test(`revocation ${revocationSucceeds ? 'confirmed' : 'unconfirmed'}`, async sub => {
    const f = await fixture(sub);
    const verificationStarted = Promise.withResolvers();
    const finishVerification = Promise.withResolvers();
    let verificationSignal;
    f.keysHook = async ({ signal }) => {
      verificationSignal = signal;
      verificationStarted.resolve();
      await finishVerification.promise;
      return Response.json({ keys: [jwk] });
    };
    if (!revocationSucceeds) f.revokeHook = () => new Response(null, { status: 503 });
    const attempt = await f.begin();
    const callback = f.auth.callback(attempt.callback);
    const rejected = assert.rejects(callback, { code: 'auth_interrupted' });
    await verificationStarted.promise;
    const logout = f.auth.disconnect();
    assert.equal(verificationSignal.aborted, false, 'issued-session verification must finish under its bounded timeout');
    finishVerification.resolve();
    await rejected;
    const result = await logout;
    assert.equal(result.connected, false);
    assert.equal(result.revocationConfirmed, revocationSucceeds);
    const revocations = f.calls.filter(call => call.url.endsWith('/oauth/revoke'));
    assert.equal(revocations.length, revocationSucceeds ? 1 : 2);
    assert.equal(new URLSearchParams(revocations[0].options.body).get('token'), 'fixture-refresh-token');
    assert.equal((await f.saved()).registrations[0].tokens, null);
    if (!revocationSucceeds) assert.match(result.message, /Remote revocation could not be confirmed/);
  });
});

test('catalog from an old account cannot be assigned after cross-instance switching', async t => {
  const f = await fixture(t); const one = await f.connect();
  f.client = 'oaiapp_beta'; f.subject = 'person-two'; const two = await f.connect({ newAccount: true });
  await f.auth.selectAccount(one.account.id);
  const started = Promise.withResolvers(); const complete = Promise.withResolvers();
  f.modelHook = async () => { started.resolve(); await complete.promise; return Response.json({ models: f.models }); };
  const result = f.auth.selectModel('gpt-6.1-sol'); const rejection = assert.rejects(result, { code: 'auth_interrupted' });
  await started.promise; await f.make().selectAccount(two.account.id); complete.resolve(); await rejection;
  assert.equal((await f.auth.status()).account.selectedModel, null);
});

test('discovery cannot redirect credential operations to an untrusted endpoint', async t => {
  const f = await fixture(t); f.discoveryOverride = { jwks_uri: 'https://attacker.test/keys' };
  await assert.rejects(f.connect(), { code: 'invalid_discovery' });
  assert.ok(f.calls.every(call => call.url.startsWith(ISSUER)));
});

test('oversized registration additions cannot corrupt existing storage', async t => {
  const f = await fixture(t); await f.auth.status(); const saved = await f.saved();
  saved.registrations = Array.from({ length: 50 }, (_, i) => ({ id: `registration-${i}`, clientId: `oaiapp_${i}`, subject: null, tokens: null }));
  await writeFile(path.join(f.directory, 'auth.json'), JSON.stringify(saved), { mode: 0o600 });
  await assert.rejects(f.connect({ newAccount: true }), { code: 'too_many_accounts' });
  assert.equal((await f.auth.status()).accounts.length, 50);
});
