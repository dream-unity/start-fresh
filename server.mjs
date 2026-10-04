import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { RESPONSE_SCHEMA } from './src/response-schema.js';
import { streamChatGPTResponse, ChatGPTResponseError } from './server/chatgpt-responses.mjs';
import { createChatGPTAuth, ChatGPTAuthError } from './server/chatgpt-auth.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('.', import.meta.url));
const MAX_BODY_BYTES = 40 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
};

class RequestError extends Error {
  constructor(status, message, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}

function localOllamaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('OLLAMA_URL must be a loopback HTTP URL.'); }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OLLAMA_URL must be http://127.0.0.1:PORT, http://localhost:PORT, or http://[::1]:PORT, without a path or credentials.');
  }
  // Never resolve a configurable hostname through DNS, including localhost.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}

function requestOrigin(req, server) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) return null;
  let origin;
  try { origin = new URL(`http://${host}`); } catch { return null; }
  const address = server.address();
  if (!LOOPBACK_HOSTS.has(origin.hostname) || !address || typeof address === 'string'
      || Number(origin.port || 80) !== address.port) return null;
  return origin.origin;
}

function matchingOrigin(req, expected, required) {
  if (req.headers.origin === undefined) return !required;
  return typeof req.headers.origin === 'string' && req.headers.origin === expected;
}

function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  // Rejected requests may still have unread bodies; do not reuse that socket.
  if (status >= 400) res.setHeader('connection', 'close');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readObject(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) {
    throw new RequestError(415, 'Send an application/json request.');
  }
  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) {
    throw new RequestError(413, 'Conversation request exceeds 40 KiB.');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData); req.off('end', onEnd);
      req.off('aborted', onAborted); req.off('error', onError);
    };
    const fail = (error) => { cleanup(); req.resume(); reject(error); };
    const onAborted = () => fail(new RequestError(400, 'Request was interrupted.'));
    const onError = () => fail(new RequestError(400, 'Could not read request.'));
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return fail(new RequestError(413, 'Conversation request exceeds 40 KiB.'));
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch {
        reject(new RequestError(400, 'Expected a JSON object.'));
      }
    };
    req.on('data', onData); req.on('end', onEnd);
    req.on('aborted', onAborted); req.on('error', onError);
  });
}

function validModel(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value);
}

async function readMessages(req, { withModel = false } = {}) {
  const body = await readObject(req);
  if (Object.keys(body).length !== (withModel ? 2 : 1)
      || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 32
      || (withModel && !validModel(body.model))) {
    throw new RequestError(400, withModel ? 'Provide only messages and an available model.' : 'Provide only a messages array.');
  }
  const messages = body.messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).length !== 2
        || !['user', 'assistant', 'system'].includes(message.role)
        || typeof message.content !== 'string' || !message.content.trim()
        || message.content.length > 6000) {
      throw new RequestError(400, 'Messages must have a valid role and 1–6000 characters of content.');
    }
    return { role: message.role, content: message.content };
  });
  if (withModel && messages.at(-1).role !== 'user') throw new RequestError(400, 'A new user message is required for this turn.');
  return withModel ? { messages, model: body.model } : messages;
}

function publicAccount(account) {
  if (!account || typeof account !== 'object') return null;
  const result = {};
  for (const key of ['id', 'label', 'email', 'name', 'selectedModel']) {
    if (typeof account[key] === 'string') result[key] = account[key].slice(0, 300);
  }
  return result;
}

function publicStatus(status) {
  return {
    connected: status?.connected === true, sharing: status?.sharing === true,
    ...(typeof status?.state === 'string' && { state: status.state.slice(0, 100) }),
    ...(typeof status?.message === 'string' && { message: status.message.slice(0, 1000) }),
    account: publicAccount(status?.account),
    accounts: Array.isArray(status?.accounts) ? status.accounts.slice(0, 50).map(publicAccount).filter(Boolean) : [],
  };
}

function publicModels(models) {
  if (!Array.isArray(models)) throw new RequestError(502, 'ChatGPT did not return a model catalog.', 'CHATGPT_INVALID_CATALOG');
  return models.filter((item) => item && validModel(item.slug) && typeof item.display_name === 'string')
    .slice(0, 200).map((item) => ({ slug: item.slug, display_name: item.display_name.slice(0, 200) }));
}

function scrub(value, accessToken = '') {
  const encoded = JSON.stringify(value, (key, item) => /^(?:access_token|refresh_token|id_token|authorization|client_secret|code_verifier)$/i.test(key) ? '[redacted]' : item);
  if (encoded === undefined) return null;
  const safe = (accessToken ? encoded.split(accessToken).join('[redacted]') : encoded)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]');
  return JSON.parse(safe);
}

function chatGPTError(cause, { token = '', timedOut = false } = {}) {
  if (timedOut) return { status: 504, body: { error: 'The ChatGPT request timed out. Try again when ready.', code: 'CHATGPT_TIMEOUT' } };
  const trusted = cause instanceof RequestError || cause instanceof ChatGPTResponseError || cause instanceof ChatGPTAuthError
    || (typeof cause?.code === 'string' && /^(?:CHATGPT_|OAUTH_|SIWC_|subscription_sharing_|chatpass_)/.test(cause.code));
  const status = Number.isInteger(cause?.status) && cause.status >= 400 && cause.status <= 599 ? cause.status : 502;
  return { status, body: scrub({
    error: trusted && typeof cause.message === 'string' ? cause.message.slice(0, 2000) : 'The ChatGPT connection could not complete this request. Try again when ready.',
    code: trusted && typeof cause.code === 'string' ? cause.code.slice(0, 200) : 'CHATGPT_REQUEST_FAILED',
    ...(Number.isInteger(cause?.upstreamStatus) && { upstreamStatus: cause.upstreamStatus }),
    ...(typeof cause?.requestId === 'string' && { requestId: cause.requestId.slice(0, 200) }),
    ...(trusted && cause?.param && { param: String(cause.param).slice(0, 200) }),
    ...(trusted && cause?.details && { details: cause.details }),
  }, token) };
}

function checkOperation(op) {
  if (op.signal.aborted) throw new DOMException('Request stopped.', 'AbortError');
}

function waitFor(promise, signal) {
  if (signal.aborted) return Promise.reject(new DOMException('Request stopped.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Request stopped.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function cookieValue(req, name) {
  const matches = String(req.headers.cookie || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : '';
}

function equalSecret(left, right) {
  const a = Buffer.from(left || ''); const b = Buffer.from(right || '');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function operation(req, res, duration, operations) {
  const controller = new AbortController();
  let timedOut = false;
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, duration);
  timer.unref();
  req.on('aborted', disconnected);
  res.on('close', disconnected);
  operations.add(controller);
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    get timedOut() { return timedOut; },
    close() {
      clearTimeout(timer); operations.delete(controller);
      req.off('aborted', disconnected); res.off('close', disconnected);
    },
  };
}

function allowedAsset(relative) {
  return relative === 'index.html' || relative === 'style.css' || relative === 'styles.css'
    || ((relative.startsWith('src/') || relative.startsWith('vendor/'))
      && Object.hasOwn(MIME, path.extname(relative)));
}

function assetPath(rawUrl) {
  const raw = rawUrl.split('?')[0];
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (decoded.length > 2048 || !decoded.startsWith('/') || /[\\\0%?#]/.test(decoded)
      || decoded.split('/').some((part) => part.startsWith('.'))) return null;
  const relative = decoded === '/' ? 'index.html' : decoded.slice(1);
  return allowedAsset(relative) ? relative : null;
}

/** A local development/runtime server. This is deliberately not a public AI proxy. */
export function createAppServer({
  rootDir = PROJECT_ROOT,
  ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  model = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b',
  fetchImpl = globalThis.fetch,
  timeoutMs = 180_000,
  chatgptAuth = null,
  chatgptAuthFactory = () => createChatGPTAuth({ fetchImpl }),
  chatgptResponse = streamChatGPTResponse,
  oauthTransactionTTL = 10 * 60 * 1000,
} = {}) {
  const upstreamBase = localOllamaUrl(ollamaUrl);
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)) throw new Error('OLLAMA_MODEL contains unsupported characters.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be positive.');
  const root = path.resolve(rootDir);
  const operations = new Set();
  const chatgptOperations = new Set();
  const transactions = new Map();
  const transactionCookie = 'du_chatgpt_oauth';
  let authPromise;
  let authMutation = Promise.resolve();
  let chatgptEpoch = 0;
  const getAuth = () => {
    if (!authPromise) authPromise = Promise.resolve().then(() => chatgptAuth || chatgptAuthFactory());
    return authPromise;
  };
  const mutateAuth = (work) => {
    const next = authMutation.then(work);
    authMutation = next.catch(() => {});
    return next;
  };
  const abortChatGPT = () => { ++chatgptEpoch; for (const op of chatgptOperations) op.abort(); };
  const requireSharing = async (auth) => {
    const status = publicStatus(await auth.status());
    if (!status.connected) throw new RequestError(401, 'Continue with ChatGPT to connect your account first.', 'CHATGPT_SIGN_IN_REQUIRED');
    if (!status.sharing) throw new RequestError(403, 'This sign-in has not enabled ChatGPT plan usage. Review the permission with OpenAI.', 'CHATGPT_PLAN_PERMISSION_REQUIRED');
    return status;
  };

  const server = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=(self)');
    // Browser inference downloads the pinned WebLLM runtime and public weights;
    // conversation requests to the local proxy remain same-origin only.
    res.setHeader('content-security-policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; connect-src 'self' https://cdn.jsdelivr.net https://huggingface.co https://*.huggingface.co https://*.hf.co https://raw.githubusercontent.com; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com");
    const origin = requestOrigin(req, server);
    if (!origin) return json(res, 403, { error: 'Only requests addressed to this loopback server are accepted.' });
    const route = req.url?.split('?')[0];

    if (route === '/auth/callback') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Use GET for the sign-in callback.' });
      const callback = new URL(req.url, origin);
      const state = callback.searchParams.get('state');
      const transaction = state && transactions.get(state);
      const cookie = cookieValue(req, transactionCookie);
      const valid = callback.hostname === '127.0.0.1'
        && callback.searchParams.getAll('state').length === 1
        && transaction && transaction.origin === origin && transaction.expires > Date.now()
        && equalSecret(cookie, transaction.cookie);
      if (!valid) {
        res.writeHead(303, { location: '/?chatgpt=error&code=invalid_transaction' });
        return res.end();
      }
      // Consume the browser transaction before exchanging the authorization code.
      transactions.delete(state);
      res.setHeader('set-cookie', `${transactionCookie}=; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=0`);
      abortChatGPT();
      const op = operation(req, res, Math.min(timeoutMs, 45000), operations);
      let location = '/?chatgpt=connected';
      try {
        await waitFor(mutateAuth(async () => {
          checkOperation(op);
          const auth = await getAuth();
          checkOperation(op);
          return auth.callback(callback);
        }), op.signal);
      } catch (cause) {
        // Authorization codes, tokens and upstream diagnostic text never enter
        // redirect URLs. The original page can inspect the safe status endpoint.
        const code = op.timedOut ? 'sign_in_timeout' : cause?.code === 'access_denied' ? 'access_denied' : 'sign_in_failed';
        location = `/?chatgpt=error&code=${code}`;
      } finally { op.close(); }
      if (!res.destroyed && !res.writableEnded) { res.writeHead(303, { location }); res.end(); }
      return;
    }

    if (route?.startsWith('/api/chatgpt/')) {
      const readRoutes = new Set(['/api/chatgpt/status', '/api/chatgpt/models']);
      const writeRoutes = new Set(['/api/chatgpt/auth/start', '/api/chatgpt/model', '/api/chatgpt/disconnect', '/api/chatgpt/chat']);
      if (!readRoutes.has(route) && !writeRoutes.has(route)) return json(res, 404, { error: 'ChatGPT route not found.' });
      const writing = writeRoutes.has(route);
      if (req.method !== (writing ? 'POST' : 'GET')) return json(res, 405, { error: `Use ${writing ? 'POST' : 'GET'} for this ChatGPT request.` });
      if (!matchingOrigin(req, origin, writing) || req.headers['sec-fetch-site'] === 'cross-site') {
        return json(res, 403, { error: 'ChatGPT requests must come from this local application.', code: 'CHATGPT_ORIGIN_REQUIRED' });
      }
      if (route === '/api/chatgpt/auth/start' && new URL(origin).hostname !== '127.0.0.1') {
        return json(res, 400, { error: `Open http://127.0.0.1:${server.address().port} to connect ChatGPT on this computer.`, code: 'CHATGPT_LOOPBACK_REQUIRED' });
      }
      let body;
      if (writing) {
        try {
          body = route === '/api/chatgpt/chat' ? await readMessages(req, { withModel: true }) : await readObject(req);
          if (route === '/api/chatgpt/model') {
            if (Object.keys(body).length !== 1 || !validModel(body.model)) throw new RequestError(400, 'Provide only an available model.', 'CHATGPT_MODEL_REQUIRED');
          } else if (route !== '/api/chatgpt/chat' && Object.keys(body).length !== 0) {
            throw new RequestError(400, 'This request expects an empty JSON object.');
          }
        } catch (cause) { req.resume(); const failure = chatGPTError(cause); return json(res, failure.status, failure.body); }
      }
      if (res.destroyed) return;
      if (route === '/api/chatgpt/disconnect' || route === '/api/chatgpt/auth/start' || route === '/api/chatgpt/model') abortChatGPT();
      const op = operation(req, res, route === '/api/chatgpt/chat' ? timeoutMs : Math.min(timeoutMs, 45000), operations);
      const requestEpoch = chatgptEpoch;
      const checkChatOperation = () => {
        checkOperation(op);
        if (requestEpoch !== chatgptEpoch) throw new RequestError(409, 'The ChatGPT connection changed. Select the account again before continuing.', 'CHATGPT_ACCOUNT_CHANGED');
      };
      if (route === '/api/chatgpt/chat') chatgptOperations.add(op);
      let accessToken = '';
      try {
        const auth = await waitFor(getAuth(), op.signal);
        checkOperation(op);
        if (route === '/api/chatgpt/status') {
          const result = await waitFor(auth.status(), op.signal);
          return json(res, 200, publicStatus(result));
        }
        if (route === '/api/chatgpt/auth/start') {
          const result = await waitFor(mutateAuth(() => { checkChatOperation(); return auth.start({ callbackOrigin: origin, includeIdTokenHint: false }); }), op.signal);
          checkChatOperation();
          const authorization = new URL(result.authorizationURL);
          const state = authorization.searchParams.get('state');
          if (authorization.origin !== 'https://auth.openai.com' || authorization.pathname !== '/api/accounts/authorize'
              || authorization.username || authorization.password || authorization.hash
              || authorization.searchParams.has('id_token_hint')
              || !state || state.length > 512) throw new RequestError(502, 'OpenAI sign-in could not be started safely.', 'CHATGPT_INVALID_AUTHORIZATION');
          transactions.clear(); // One browser transaction per local installation.
          const cookie = randomBytes(32).toString('base64url');
          transactions.set(state, { origin, cookie, expires: Date.now() + oauthTransactionTTL });
          res.setHeader('set-cookie', `${transactionCookie}=${cookie}; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=${Math.max(1, Math.floor(oauthTransactionTTL / 1000))}`);
          return json(res, 200, { url: authorization.href });
        }
        if (route === '/api/chatgpt/disconnect') {
          transactions.clear();
          const result = await waitFor(mutateAuth(() => auth.disconnect()), op.signal);
          checkOperation(op);
          res.setHeader('set-cookie', `${transactionCookie}=; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=0`);
          return json(res, 200, { ok: true, ...publicStatus(await auth.status()), ...(typeof result?.message === 'string' && { message: result.message.slice(0, 1000) }), ...(typeof result?.revocationConfirmed === 'boolean' && { revocationConfirmed: result.revocationConfirmed }) });
        }
        const account = await waitFor(requireSharing(auth), op.signal);
        const accountId = req.headers['x-dream-unity-account'];
        if ((route === '/api/chatgpt/chat' || route === '/api/chatgpt/model')
            && (typeof accountId !== 'string' || !account.account?.id || accountId !== account.account.id)) {
          throw new RequestError(409, 'The selected ChatGPT account changed. Select your account and model again before continuing.', 'CHATGPT_ACCOUNT_CHANGED');
        }
        const models = publicModels(await waitFor(auth.listModels(), op.signal));
        checkChatOperation();
        if (route === '/api/chatgpt/models') return json(res, 200, { models });
        if (!models.some((item) => item.slug === body.model)) {
          throw new RequestError(400, 'Choose a model available to this ChatGPT account.', 'CHATGPT_MODEL_UNAVAILABLE');
        }
        if (route === '/api/chatgpt/model') {
          await waitFor(mutateAuth(() => { checkChatOperation(); return auth.selectModel(body.model, { accountId }); }), op.signal);
          checkChatOperation();
          return json(res, 200, { ok: true, model: body.model });
        }
        const session = await waitFor(auth.getSession(), op.signal);
        checkChatOperation();
        if (!session || session.accountId !== accountId) {
          throw new RequestError(409, 'The selected ChatGPT account changed. Send your message again when ready.', 'CHATGPT_ACCOUNT_CHANGED');
        }
        accessToken = session.accessToken;
        let complete = false;
        const stream = chatgptResponse({ messages: body.messages, model: body.model, accessToken, signal: op.signal, fetchImpl });
        for await (const item of stream) {
          checkChatOperation();
          if (res.destroyed) break;
          if (!item || typeof item !== 'object' || item.error) throw new RequestError(502, 'ChatGPT returned an invalid conversation event.', 'CHATGPT_INVALID_STREAM');
          if (item.done === true) {
            const endingSession = await waitFor(auth.getSession(), op.signal);
            checkChatOperation();
            if (endingSession.accountId !== session.accountId || endingSession.epoch !== session.epoch) {
              throw new RequestError(409, 'The ChatGPT account changed during this answer. Select your account again before continuing.', 'CHATGPT_ACCOUNT_CHANGED');
            }
            complete = true;
          } else if (item.done !== false || typeof item.message?.content !== 'string') {
            throw new RequestError(502, 'ChatGPT returned an invalid conversation event.', 'CHATGPT_INVALID_STREAM');
          }
          if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'x-accel-buffering': 'no' });
          const output = item.done === true ? { done: true } : { message: { content: item.message.content }, done: false };
          if (!res.write(`${JSON.stringify(output)}\n`)) await once(res, 'drain', { signal: op.signal });
          if (complete) break;
        }
        checkChatOperation();
        if (!complete) throw new RequestError(502, 'The ChatGPT connection ended before its answer completed.', 'CHATGPT_STREAM_INTERRUPTED');
        res.end();
      } catch (cause) {
        const failure = chatGPTError(cause, { token: accessToken, timedOut: op.timedOut });
        if (res.headersSent) {
          if (!res.destroyed && !res.writableEnded) res.end(`${JSON.stringify(failure.body)}\n`);
        } else json(res, failure.status, failure.body);
      } finally { accessToken = ''; chatgptOperations.delete(op); op.abort(); op.close(); }
      return;
    }

    if (route === '/api/health') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Use GET for health.' });
      if (!matchingOrigin(req, origin, false)) return json(res, 403, { error: 'Cross-origin requests are not accepted.' });
      const op = operation(req, res, Math.min(timeoutMs, 10_000), operations);
      try {
        const upstream = await fetchImpl(new URL('/api/tags', upstreamBase), { signal: op.signal, redirect: 'error' });
        if (!upstream.ok) {
          await upstream.body?.cancel();
          throw new Error('Ollama health failed.');
        }
        const body = await upstream.json();
        const candidates = Array.isArray(body?.models) ? body.models : [];
        const expected = model.includes(':') ? model : `${model}:latest`;
        const installed = candidates.find((entry) => entry?.name === model || entry?.model === model
          || entry?.name === expected || entry?.model === expected);
        const remote = Boolean(installed?.remote_model || installed?.remote_host);
        const ready = Boolean(installed) && !remote;
        json(res, ready ? 200 : 503, {
          ok: ready, provider: 'local', model, ready,
          ...(!ready && { error: remote
            ? 'The configured model uses a remote service. Choose a locally installed model in OLLAMA_MODEL, then check again.'
            : `The local model is not installed. In a terminal, run: ollama pull ${model}. Then check again.` }),
        });
      } catch {
        json(res, 503, {
          ok: false, provider: 'local', model, ready: false,
          error: op.timedOut ? 'Local model service did not respond. Check that Ollama is running, then try again.'
            : 'Cannot reach the local model. Start Ollama on this computer, then check again.',
        });
      } finally { op.close(); }
      return;
    }

    if (route === '/api/chat') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST for a conversation.' });
      if (!matchingOrigin(req, origin, true)) return json(res, 403, { error: 'A matching same-origin Origin header is required.' });
      let messages;
      try { messages = await readMessages(req); }
      catch (error) { req.resume(); return json(res, error.status || 400, { error: error.message }); }
      if (res.destroyed) return;
      const op = operation(req, res, timeoutMs, operations);
      try {
        const upstream = await fetchImpl(new URL('/api/chat', upstreamBase), {
          method: 'POST', redirect: 'error', signal: op.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model, messages, stream: true,
            format: RESPONSE_SCHEMA,
            options: { num_predict: 512, temperature: 0.4, num_ctx: 4096 },
          }),
        });
        if (!upstream.ok || !upstream.body) {
          await upstream.body?.cancel();
          return json(res, 502, { error: `The local model could not answer. Check Ollama and that ${model} is installed.` });
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'x-accel-buffering': 'no' });
        let size = 0;
        for await (const chunk of upstream.body) {
          if (op.signal.aborted || res.destroyed) break;
          size += chunk.byteLength;
          if (size > 8 * 1024 * 1024) throw new Error('Response exceeded local limit.');
          if (!res.write(chunk)) await once(res, 'drain', { signal: op.signal });
        }
        if (op.timedOut) throw new Error('Response timed out.');
        res.end();
      } catch {
        const error = op.timedOut ? 'The local model took too long. Try a shorter request or a smaller model.'
          : 'The local conversation was interrupted. Check Ollama, then try again.';
        if (res.headersSent) {
          if (!res.destroyed && !res.writableEnded) res.end(`${JSON.stringify({ error })}\n`);
        } else json(res, op.timedOut ? 504 : 502, { error });
      } finally { op.abort(); op.close(); }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
    const relative = assetPath(req.url || '');
    if (!relative) return json(res, 404, { error: 'Not found.' });
    try {
      const [realRoot, file] = await Promise.all([realpath(root), realpath(path.join(root, relative))]);
      const actualRelative = path.relative(realRoot, file).split(path.sep).join('/');
      if (actualRelative.startsWith('../') || path.isAbsolute(actualRelative) || !allowedAsset(actualRelative)
          || actualRelative.split('/').some((part) => part.startsWith('.')) || !(await stat(file)).isFile()) {
        return json(res, 404, { error: 'Not found.' });
      }
      const contents = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)], 'content-length': contents.length });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch { json(res, 404, { error: 'Not found.' }); }
  });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.abortActiveRequests = () => { for (const controller of operations) controller.abort(); };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const port = Number(process.env.PORT || 4173);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
    const server = createAppServer();
    server.listen(port, '127.0.0.1', () => console.log(`Dream Unity is ready at http://127.0.0.1:${port}`));
    server.on('error', (error) => { console.error(`Could not start Dream Unity: ${error.message}`); process.exitCode = 1; });
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true; server.abortActiveRequests();
      server.close(() => { process.exitCode = 0; });
      const timer = setTimeout(() => server.closeAllConnections(), 2000);
      timer.unref();
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
