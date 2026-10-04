import { createHash, randomBytes, randomUUID, timingSafeEqual, createPublicKey, verify } from 'node:crypto';
import { mkdir, lstat, chmod, open, rename, unlink, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const TERMINAL_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const FILE = 'auth.json';
const text = (value, limit = 512) => typeof value === 'string' ? value.slice(0, limit) : '';
const opaque = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,32768}$/.test(value);
const clientId = (value) => typeof value === 'string' && /^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(value);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class ChatGPTAuthError extends Error {
  constructor(code, message, status = 400, metadata = {}) {
    super(message); this.name = 'ChatGPTAuthError'; this.code = code; this.status = status;
    if (metadata.requestId) this.requestId = text(metadata.requestId, 200);
    if (metadata.upstreamStatus) this.upstreamStatus = metadata.upstreamStatus;
  }
}
const failure = (code, message, status = 400) => new ChatGPTAuthError(code, message, status);

function callbackUri(origin) {
  let url;
  try { url = new URL(origin); } catch { throw failure('invalid_callback_origin', 'Open the app at its local 127.0.0.1 address before signing in.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || !url.port) {
    throw failure('invalid_callback_origin', 'Sign-in requires http://127.0.0.1:PORT on this computer.');
  }
  return `${url.origin}/auth/callback`;
}

function trustedEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('invalid_discovery', 'OpenAI identity configuration could not be validated.', 502); }
  if (url.origin !== ISSUER || url.username || url.password || url.hash || url.search) {
    throw failure('invalid_discovery', 'OpenAI identity configuration could not be validated.', 502);
  }
  return url.href;
}

function unpackJWT(value) {
  if (!opaque(value)) throw failure('invalid_id_token', 'The returned identity could not be verified.', 401);
  const parts = value.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part)
      || Buffer.from(part, 'base64url').toString('base64url') !== part)) throw failure('invalid_id_token', 'The returned identity could not be verified.', 401);
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!header || Array.isArray(header) || !payload || Array.isArray(payload)) throw new Error();
    return { header, payload, signature: Buffer.from(parts[2], 'base64url'), signed: Buffer.from(`${parts[0]}.${parts[1]}`) };
  } catch { throw failure('invalid_id_token', 'The returned identity could not be verified.', 401); }
}

function expiration(value, receivedAt) {
  return Number.isFinite(value) && value > 0 && value <= 86400 ? receivedAt + value * 1000 : null;
}
function earliest(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
}

/** Protected, local-only SIWC sessions; never reuse browser/Codex credentials. */
export function createChatGPTAuth({
  storageDir = path.join(os.homedir(), '.config', 'dream-unity-start-fresh'),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  requestTimeoutMs = 15000,
  transactionTTL = 10 * 60 * 1000,
} = {}) {
  const directory = path.resolve(storageDir);
  const stateFile = path.join(directory, FILE);
  let pending = null;
  let generation = 0;
  let refreshFlight = null;
  let discoveryCache = null;
  let jwksCache = null;
  let lastMessage = null;
  const operations = new Set();
  const catalogs = new Map();

  async function prepareDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('unsafe_storage', 'The protected sign-in directory is not a regular directory.', 500);
    await chmod(directory, 0o700);
  }

  async function load() {
    let handle;
    try {
      handle = await open(stateFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      await handle.chmod(0o600);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid state file');
      const state = JSON.parse(await handle.readFile('utf8'));
      if (state.version !== 1 || !/^urn:uuid:[a-f0-9-]{36}$/i.test(state.hostId)
          || !Array.isArray(state.registrations) || state.registrations.length > 50
          || state.registrations.some(account => !account || typeof account.id !== 'string' || !clientId(account.clientId))) throw new Error('Invalid state');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw failure('invalid_storage', 'Saved sign-in data could not be read safely. Restore the protected auth.json file or move it aside to reconnect.', 500);
    } finally { await handle?.close(); }
  }

  async function save(state) {
    const temporary = path.join(directory, `.auth-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, stateFile); await chmod(stateFile, 0o600); }
    finally { await unlink(temporary).catch(() => {}); }
  }

  async function locked(work) {
    await prepareDirectory();
    const lockFile = path.join(directory, '.auth.lock');
    const started = Date.now();
    let lock;
    for (;;) {
      try { lock = await open(lockFile, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw failure('storage_unavailable', 'Protected sign-in storage is unavailable.', 500);
        try {
          const info = await lstat(lockFile);
          if (!info.isFile() || info.isSymbolicLink()) throw failure('unsafe_storage', 'Sign-in storage lock is unsafe.', 500);
          // Serialize stale-lock recovery and re-read under that lock. Otherwise
          // two recoverers can accidentally unlink a new, live process's lock.
          let recovery;
          try {
            recovery = await open(`${lockFile}.recovery`, 'wx', 0o600);
            const previous = JSON.parse(await readFile(lockFile, 'utf8'));
            if (Number.isInteger(previous.pid) && previous.pid > 0) {
              try { process.kill(previous.pid, 0); }
              catch (probe) { if (probe.code === 'ESRCH') await unlink(lockFile); }
            }
          } catch (probe) { if (!['EEXIST', 'ENOENT'].includes(probe.code)) throw probe; }
          finally { if (recovery) { await recovery.close(); await unlink(`${lockFile}.recovery`).catch(() => {}); } }
        } catch (probe) { if (probe instanceof ChatGPTAuthError) throw probe; }
        if (Date.now() - started > 60000) throw failure('session_busy', 'Another sign-in operation is still running. Try again shortly.', 409);
        await delay(40);
      }
    }
    try {
      let state = await load();
      if (!state) {
        state = { version: 1, hostId: `urn:uuid:${randomUUID()}`, authEpoch: 0, activeId: null, registrations: [] };
        await save(state);
      }
      return await work(state);
    } finally { await lock.close(); await unlink(lockFile).catch(() => {}); }
  }

  function interrupt() {
    generation += 1; pending = null; catalogs.clear();
    for (const controller of operations) controller.abort();
  }

  async function request(url, options = {}, { independent = false, empty = false } = {}) {
    const controller = new AbortController();
    if (!independent) operations.add(controller);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    timer.unref();
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
      let body = null;
      if (!empty || !response.ok) {
        const chunks = []; let length = 0;
        for await (const chunk of response.body || []) {
          length += chunk.byteLength;
          if (length > 512 * 1024) throw failure('invalid_provider_response', 'OpenAI returned an unexpectedly large identity response.', 502);
          chunks.push(Buffer.from(chunk));
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { if (response.ok) throw failure('invalid_provider_response', 'OpenAI returned an unreadable identity response.', 502); }
      } else await response.body?.cancel();
      if (!response.ok) {
        const candidate = typeof body?.error === 'string' ? body.error : body?.error?.code;
        const code = typeof candidate === 'string' && /^[a-zA-Z0-9_]{1,120}$/.test(candidate) ? candidate : 'openai_request_failed';
        throw new ChatGPTAuthError(code, 'OpenAI could not complete this sign-in request. Please try again or reconnect your account.', response.status, {
          upstreamStatus: response.status, requestId: response.headers.get('x-request-id') || response.headers.get('openai-request-id'),
        });
      }
      return body;
    } catch (error) {
      if (error instanceof ChatGPTAuthError) throw error;
      throw failure(controller.signal.aborted ? 'auth_interrupted' : 'openai_unavailable',
        controller.signal.aborted ? 'Sign-in was stopped or took too long. Please try again.' : 'OpenAI could not be reached. Your saved connection has been preserved.', 503);
    } finally { clearTimeout(timer); operations.delete(controller); }
  }

  async function discovery(independent = false) {
    if (discoveryCache && discoveryCache.expires > now()) return discoveryCache.value;
    const value = await request(DISCOVERY, { headers: { accept: 'application/json' } }, { independent });
    if (value?.issuer !== ISSUER || value.authorization_endpoint !== AUTHORIZE || value.token_endpoint !== TOKEN) {
      throw failure('invalid_discovery', 'OpenAI identity configuration could not be validated.', 502);
    }
    trustedEndpoint(value.jwks_uri);
    if (value.revocation_endpoint) trustedEndpoint(value.revocation_endpoint);
    discoveryCache = { value, expires: now() + 60 * 60 * 1000 };
    return value;
  }

  async function verifyIdentity(idToken, { client, nonce, subject, refresh = false, independent = refresh }) {
    const { header, payload, signature, signed } = unpackJWT(idToken);
    if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string' || header.kid.length > 200
        || header.jku || header.x5u || header.jwk || header.crit !== undefined) throw failure('invalid_id_token', 'The returned identity uses an unsupported signing method.', 401);
    // A refresh may already have rotated the provider's session. Complete its
    // bounded verification so logout can revoke the latest token under lock.
    const configuration = await discovery(independent);
    if (Array.isArray(configuration.id_token_signing_alg_values_supported)
        && !configuration.id_token_signing_alg_values_supported.includes(header.alg)) throw failure('invalid_id_token', 'The returned identity uses an unsupported signing method.', 401);
    const fetchKeys = async () => {
      const value = await request(configuration.jwks_uri, { headers: { accept: 'application/json' } }, { independent });
      if (!Array.isArray(value?.keys) || value.keys.length > 50) throw failure('invalid_jwks', 'OpenAI signing keys could not be validated.', 502);
      jwksCache = { keys: value.keys, expires: now() + 15 * 60 * 1000 };
    };
    const cached = jwksCache && jwksCache.expires > now();
    if (!cached) await fetchKeys();
    let keys = jwksCache.keys.filter(key => key.kid === header.kid);
    if (!keys.length && cached) { await fetchKeys(); keys = jwksCache.keys.filter(key => key.kid === header.kid); }
    const jwk = keys[0];
    if (keys.length !== 1 || (jwk.use && jwk.use !== 'sig') || (jwk.alg && jwk.alg !== header.alg)
        || (jwk.key_ops && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify')))
        || jwk.d || (header.alg === 'RS256' && jwk.kty !== 'RSA')
        || (header.alg === 'ES256' && (jwk.kty !== 'EC' || jwk.crv !== 'P-256'))) throw failure('invalid_id_token', 'The returned identity signing key was not accepted.', 401);
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      if (header.alg === 'RS256' && key.asymmetricKeyDetails.modulusLength < 2048) throw new Error();
      if (!verify('sha256', signed, header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, signature)) throw new Error();
    } catch { throw failure('invalid_id_token', 'The returned identity signature could not be verified.', 401); }
    const seconds = now() / 1000;
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== ISSUER || !audience.includes(client) || audience.some(value => typeof value !== 'string')
        || (audience.length > 1 && payload.azp !== client) || (payload.azp !== undefined && payload.azp !== client)
        || !Number.isInteger(payload.exp) || payload.exp <= seconds - 5
        || !Number.isInteger(payload.iat) || payload.iat > seconds + 5 || payload.exp <= payload.iat
        || (payload.nbf !== undefined && (!Number.isInteger(payload.nbf) || payload.nbf > seconds + 5))
        || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 512
        || (subject && payload.sub !== subject)
        || ((!refresh || payload.nonce !== undefined) && !same(payload.nonce, nonce))) {
      throw failure('invalid_id_token', 'The returned identity did not match this sign-in attempt.', 401);
    }
    return payload;
  }

  function tokenRecord(tokens, identity, previous = null) {
    if (!tokens || typeof tokens !== 'object') throw failure('invalid_token_response', 'OpenAI returned incomplete sign-in credentials.', 502);
    const scopes = typeof tokens.scope === 'string' ? [...new Set(tokens.scope.split(/\s+/).filter(Boolean))] : previous?.scopes || [];
    const sharing = scopes.includes('chatgpt.tokens.use.direct') && scopes.includes('resource.invoke');
    const expiresAt = expiration(tokens.expires_in, now());
    if ((tokens.access_token !== undefined && (!opaque(tokens.access_token) || tokens.token_type?.toLowerCase() !== 'bearer' || !expiresAt))
        || (sharing && !opaque(tokens.access_token))
        || (tokens.refresh_token !== undefined && !opaque(tokens.refresh_token))
        || (sharing && scopes.includes('offline_access') && !opaque(tokens.refresh_token))) {
      throw failure('invalid_token_response', 'OpenAI returned incomplete sign-in credentials.', 502);
    }
    return {
      idToken: tokens.id_token || previous?.idToken,
      accessToken: tokens.access_token || null,
      refreshToken: tokens.refresh_token || null,
      expiresAt, earliestRefreshAt: earliest(tokens.earliest_refresh_at), scopes,
      savedAt: now(), nonce: identity.nonce || previous?.nonce,
    };
  }

  function publicAccount(account) {
    if (!account) return null;
    return { id: account.id, label: account.label, name: account.name || null, email: account.email || null,
      selectedModel: account.selectedModel || null, connected: Boolean(account.tokens?.idToken),
      sharing: Boolean(account.tokens?.scopes?.includes('chatgpt.tokens.use.direct') && account.tokens?.scopes?.includes('resource.invoke')) };
  }

  function publicStatus(state) {
    const account = publicAccount(state.registrations.find(entry => entry.id === state.activeId));
    const authorizing = pending && pending.expiresAt > now();
    return { connected: Boolean(account?.connected), sharing: Boolean(account?.sharing),
      state: authorizing ? 'authorizing' : account?.connected ? (account.sharing ? 'connected' : 'sharing-disabled') : 'signed-out',
      message: lastMessage, account, accounts: state.registrations.map(publicAccount) };
  }

  async function status() { return locked(state => publicStatus(state)); }

  async function start({ callbackOrigin, accountId, newAccount = false, enableSharing = false, includeIdTokenHint = false } = {}) {
    const redirectUri = callbackUri(callbackOrigin);
    interrupt(); lastMessage = null;
    return locked(async state => {
      const account = newAccount ? null : accountId ? state.registrations.find(entry => entry.id === accountId)
        : state.registrations.find(entry => entry.id === state.activeId) || state.registrations.findLast(entry => !entry.subject);
      if (accountId && !account) throw failure('unknown_account', 'Choose a saved ChatGPT account or add another account.');
      state.authEpoch = (state.authEpoch || 0) + 1;
      await save(state);
      const verifier = randomBytes(64).toString('base64url');
      pending = { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier,
        redirectUri, expiresAt: now() + transactionTTL, accountId: account?.id || null,
        clientId: account?.clientId || null, subject: account?.subject || null, generation, epoch: state.authEpoch };
      const url = new URL(AUTHORIZE);
      const parameters = { client_id: account?.clientId || 'dynamic_agent_client', ext_agent_host_id: state.hostId,
        response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE,
        state: pending.state, nonce: pending.nonce, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url') };
      if (!account) parameters.agent_name_hint = 'Dream Unity';
      // Returning URLs through browser JSON must never expose retained tokens.
      // A direct server redirect may explicitly opt in to the documented hint.
      if (includeIdTokenHint && account?.tokens?.idToken) parameters.id_token_hint = account.tokens.idToken;
      if (account?.email) parameters.login_hint = account.email;
      if (enableSharing) parameters.prompt = 'consent';
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
      return { authorizationURL: url.href };
    });
  }

  async function callback(value) {
    const transaction = pending; pending = null;
    try {
      let url;
      try { url = new URL(value); } catch { throw failure('invalid_oauth_state', 'This sign-in attempt is no longer valid. Start again.'); }
      if (!transaction || transaction.expiresAt <= now() || transaction.generation !== generation
          || `${url.origin}${url.pathname}` !== transaction.redirectUri || url.hash
          || ['state', 'code', 'client_id', 'error'].some(key => url.searchParams.getAll(key).length > 1)
          || !same(url.searchParams.get('state'), transaction.state)) throw failure('invalid_oauth_state', 'This sign-in attempt is no longer valid. Start again.');
      if (url.searchParams.has('error')) throw failure('oauth_declined', 'ChatGPT sign-in was not completed. You can continue without connecting or try again.');
      const code = url.searchParams.get('code');
      const suppliedClient = url.searchParams.get('client_id');
      const issuedClient = transaction.clientId || suppliedClient;
      if (!opaque(code) || !clientId(issuedClient) || (transaction.clientId && suppliedClient && suppliedClient !== transaction.clientId)) {
        throw failure('invalid_oauth_callback', 'The sign-in callback was incomplete or did not match the selected account.');
      }
      return await locked(async state => {
        if (transaction.generation !== generation || transaction.epoch !== state.authEpoch) throw failure('auth_interrupted', 'Sign-in was stopped.');
        let account = transaction.accountId ? state.registrations.find(entry => entry.id === transaction.accountId) : null;
        if (!account) {
          if (state.registrations.length >= 50) throw failure('too_many_accounts', 'This installation already has the maximum number of saved registrations.');
          if (state.registrations.some(entry => entry.clientId === issuedClient)) throw failure('registration_conflict', 'This registration already belongs to a saved account. Select that account to reconnect.');
          account = { id: randomUUID(), clientId: issuedClient, issuer: ISSUER, subject: null, label: `ChatGPT account ${state.registrations.length + 1}`, tokens: null };
          state.registrations.push(account);
          await save(state); // Retain the issued client even if exchanging this code fails.
        }
        const tokens = await request(TOKEN, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: issuedClient, code,
            code_verifier: transaction.verifier, redirect_uri: transaction.redirectUri, resource: RESOURCE }) });
        // The exchange has already issued a renewable session. Finish bounded
        // verification even if logout interrupts so its new token can be revoked.
        const identity = await verifyIdentity(tokens?.id_token, { client: issuedClient, nonce: transaction.nonce,
          subject: account.subject || transaction.subject, independent: true });
        const credentials = tokenRecord(tokens, identity);
        if (transaction.generation !== generation) {
          if (credentials.refreshToken && !(await revoke(issuedClient, credentials.refreshToken))) {
            state.revocationUnconfirmed = true;
            await save(state);
          }
          throw failure('auth_interrupted', 'Sign-in was stopped.');
        }
        account.subject = identity.sub; account.email = text(identity.email); account.name = text(identity.name);
        account.tokens = credentials;
        account.label = `${account.name || account.email || 'ChatGPT account'} · ${state.registrations.indexOf(account) + 1}`;
        state.activeId = account.id; catalogs.clear();
        await save(state);
        lastMessage = credentials.scopes.includes('chatgpt.tokens.use.direct') ? 'ChatGPT connected.'
          : 'Signed in. ChatGPT plan usage was not enabled; enable it explicitly to start a conversation.';
        return publicStatus(state);
      });
    } catch (error) {
      lastMessage = error instanceof ChatGPTAuthError ? error.message : 'ChatGPT sign-in could not be completed.';
      throw error instanceof ChatGPTAuthError ? error : failure('auth_failed', lastMessage, 500);
    }
  }

  async function getSession() {
    if (refreshFlight) return refreshFlight;
    const currentGeneration = generation;
    const work = locked(async state => {
      const account = state.registrations.find(entry => entry.id === state.activeId);
      const credentials = account?.tokens;
      if (!credentials?.idToken) throw failure('signin_required', 'Continue with ChatGPT to connect your account.', 401);
      if (!credentials.scopes.includes('chatgpt.tokens.use.direct') || !credentials.scopes.includes('resource.invoke')) throw failure('sharing_disabled', 'Enable ChatGPT plan usage before starting a conversation.', 403);
      if (currentGeneration !== generation) throw failure('auth_interrupted', 'The active ChatGPT session changed.', 409);
      const snapshot = token => ({ accountId: account.id, accessToken: token, selectedModel: account.selectedModel || null, epoch: state.authEpoch || 0 });
      if (credentials.expiresAt > now() + 60000) return snapshot(credentials.accessToken);
      if (credentials.earliestRefreshAt > now()) {
        if (credentials.expiresAt > now()) return snapshot(credentials.accessToken);
        throw failure('refresh_not_ready', 'OpenAI has not yet permitted this session to refresh. Try again shortly.', 429);
      }
      if (!credentials.refreshToken) throw failure('signin_required', 'This ChatGPT session expired. Sign in again.', 401);
      try {
        const tokens = await request(TOKEN, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: credentials.refreshToken, resource: RESOURCE }) }, { independent: true });
        const identity = tokens.id_token ? await verifyIdentity(tokens.id_token, { client: account.clientId, subject: account.subject, nonce: credentials.nonce, refresh: true })
          : { sub: account.subject, nonce: credentials.nonce };
        const replacement = tokenRecord(tokens, identity, credentials);
        account.tokens = replacement;
        // Preserve rotation under the lock even if logout just canceled the
        // caller: disconnect must revoke the latest renewable session.
        await save(state);
        if (currentGeneration !== generation) throw failure('auth_interrupted', 'The active ChatGPT session changed.', 409);
        if (!replacement.scopes.includes('chatgpt.tokens.use.direct') || !replacement.scopes.includes('resource.invoke')) throw failure('sharing_disabled', 'ChatGPT plan usage is no longer enabled for this session.', 403);
        return snapshot(replacement.accessToken);
      } catch (error) {
        if (TERMINAL_REFRESH.has(error.code)) {
          account.tokens = null; await save(state); catalogs.clear();
          lastMessage = 'This ChatGPT session is no longer valid. Sign in again.';
        }
        throw error;
      }
    });
    refreshFlight = work;
    try { return await work; } finally { if (refreshFlight === work) refreshFlight = null; }
  }

  async function getAccessToken() { return (await getSession()).accessToken; }

  async function revoke(client, refreshToken) {
    try {
      const config = await discovery(true);
      if (!config.revocation_endpoint) return false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await request(config.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: client }) }, { independent: true, empty: true });
          return true;
        } catch (error) { if (attempt || (error.status < 500)) throw error; await delay(150); }
      }
    } catch { return false; }
    return false;
  }

  async function disconnect({ accountId } = {}) {
    interrupt();
    return locked(async state => {
      state.authEpoch = (state.authEpoch || 0) + 1;
      const account = state.registrations.find(entry => entry.id === (accountId || state.activeId));
      let revoked = !account?.tokens?.refreshToken && !state.revocationUnconfirmed;
      if (account?.tokens?.refreshToken) {
        revoked = (await revoke(account.clientId, account.tokens.refreshToken)) && !state.revocationUnconfirmed;
      }
      if (account) account.tokens = null;
      await save(state);
      lastMessage = revoked ? 'Signed out of ChatGPT on this computer.'
        : 'Signed out locally. Remote revocation could not be confirmed; disconnect Dream Unity in ChatGPT settings to finish revoking access.';
      return { ...publicStatus(state), revocationConfirmed: revoked };
    });
  }

  async function selectAccount(id) {
    interrupt();
    return locked(async state => {
      if (!state.registrations.some(account => account.id === id && account.subject)) throw failure('unknown_account', 'Choose a verified saved account.');
      state.authEpoch = (state.authEpoch || 0) + 1;
      state.activeId = id; await save(state); lastMessage = null; return publicStatus(state);
    });
  }

  async function modelCatalog() {
    const currentGeneration = generation;
    const session = await getSession();
    const body = await request(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' } });
    if (!Array.isArray(body?.models)) throw failure('invalid_model_catalog', 'OpenAI did not return a usable account model catalog.', 502);
    const seen = new Set();
    const models = body.models.filter(item => item?.visibility === 'list' && typeof item.slug === 'string'
      && /^[A-Za-z0-9._:-]{1,160}$/.test(item.slug) && typeof item.display_name === 'string' && item.display_name.length <= 200)
      .filter(item => { if (seen.has(item.slug)) return false; seen.add(item.slug); return true; })
      .map(item => ({ slug: item.slug, display_name: item.display_name }));
    return locked(state => {
      if (currentGeneration !== generation || state.activeId !== session.accountId || state.authEpoch !== session.epoch) throw failure('auth_interrupted', 'The active ChatGPT session changed.', 409);
      catalogs.set(state.activeId, { models, savedAt: now() });
      return { models, accountId: session.accountId, epoch: session.epoch };
    });
  }

  async function listModels() { return (await modelCatalog()).models; }

  async function selectModel(slug, { accountId: expectedAccountId } = {}) {
    const currentGeneration = generation;
    const { models, accountId, epoch } = await modelCatalog();
    if (expectedAccountId && accountId !== expectedAccountId) throw failure('account_changed', 'The active ChatGPT account changed. Choose the account again.', 409);
    if (!models.some(model => model.slug === slug)) throw failure('model_unavailable', 'Choose a model from this ChatGPT account’s available models.');
    return locked(async state => {
      if (currentGeneration !== generation || state.activeId !== accountId || state.authEpoch !== epoch
          || (expectedAccountId && state.activeId !== expectedAccountId)) throw failure('auth_interrupted', 'The active ChatGPT session changed.', 409);
      const account = state.registrations.find(entry => entry.id === state.activeId);
      if (!account) throw failure('signin_required', 'Sign in to ChatGPT first.', 401);
      account.selectedModel = slug; await save(state); return publicStatus(state);
    });
  }

  return { start, callback, status, getAccessToken, getSession, disconnect, listModels, selectModel, selectAccount };
}
