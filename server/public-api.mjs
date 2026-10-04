import { generatePublicReply, DEFAULT_PUBLIC_MODEL, PublicModelError } from './public-model.mjs';
import { transcribePublicAudio, normalizeAudioType, MAX_AUDIO_BYTES, PublicAudioError } from './public-audio.mjs';

const MAX_CHAT_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 45_000;
const PAGES_ORIGIN = 'https://dream-unity.github.io';
const LIMIT_WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 4096;

class PublicApiError extends Error {
  constructor(message, { status = 400, code = 'PUBLIC_INVALID_REQUEST' } = {}) {
    super(message);
    Object.assign(this, { status, code });
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Conversation stopped.', 'AbortError');
}

function withAbort(promise, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const stop = () => reject(new DOMException('Conversation stopped.', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

function validOrigin(value) {
  if (!value || value === 'null') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && value === url.origin ? value : null;
  } catch { return null; }
}

function json(body, status, corsOrigin, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', Vary: 'Origin',
    ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}), ...extra,
  } });
}

async function readBoundedBody(request, limit, signal) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    throw new PublicApiError('That message is too large. Please send a shorter one.', { status: 413, code: 'PUBLIC_BODY_TOO_LARGE' });
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new PublicApiError('That message is too large. Please send a shorter one.', { status: 413, code: 'PUBLIC_BODY_TOO_LARGE' });
      chunks.push(value);
    }
    checkAbort(signal);
    return Buffer.concat(chunks, size);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Read a fresh deployment identity for each request, never visitor credentials. */
export async function getOwnerGatewayToken() {
  const { getVercelOidcToken } = await import('@vercel/oidc');
  const token = await getVercelOidcToken();
  if (typeof token !== 'string' || !token) throw new Error('Deployment identity is unavailable.');
  return token;
}

/**
 * Anonymous public API. Origin validation is browser isolation, not identity.
 * These bounded, expiring counters are per server instance only, not a durable
 * global quota. Configure a Gateway project budget as a separate spending guard;
 * its request-start checks can be exceeded by requests already in flight.
 */
export function createPublicApiHandler({
  getToken = getOwnerGatewayToken,
  generateReply = generatePublicReply,
  transcribe = transcribePublicAudio,
  fetchImpl = globalThis.fetch,
  model = process.env.NEXUS_PUBLIC_MODEL || DEFAULT_PUBLIC_MODEL,
  allowedOrigins = String(process.env.NEXUS_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxConcurrent = 4,
  maxRequestsPerMinute = 24,
  maxInstanceRequestsPerMinute = 120,
} = {}) {
  const origins = new Set([PAGES_ORIGIN, ...allowedOrigins.map(validOrigin).filter(Boolean)]);
  const clients = new Map();
  let active = 0;
  let windowStart = 0;
  let requestsInWindow = 0;

  function reserve(clientKey) {
    const timestamp = now();
    if (timestamp - windowStart >= LIMIT_WINDOW_MS) { windowStart = timestamp; requestsInWindow = 0; }
    for (const [key, value] of clients) if (timestamp - value.started >= LIMIT_WINDOW_MS) clients.delete(key);
    const key = typeof clientKey === 'string' && clientKey.length <= 256 ? clientKey : 'anonymous';
    let client = clients.get(key);
    if (!client) {
      if (clients.size >= MAX_TRACKED_CLIENTS) return false;
      client = { started: timestamp, count: 0 };
      clients.set(key, client);
    }
    if (active >= maxConcurrent || client.count >= maxRequestsPerMinute || requestsInWindow >= maxInstanceRequestsPerMinute) return false;
    client.count++;
    requestsInWindow++;
    active++;
    return true;
  }

  return async function handlePublicApi(request, { clientKey } = {}) {
    const url = new URL(request.url);
    const originHeader = request.headers.get('origin');
    const origin = validOrigin(originHeader);
    const permittedOrigin = origin && (origin === url.origin || origins.has(origin)) ? origin : null;
    // Cross-site browser callers cannot spend the owner's allowance. Non-browser
    // callers can spoof Origin; project budgets remain a separate spending guard.
    if (originHeader !== null && !permittedOrigin || request.method !== 'GET' && !permittedOrigin) {
      return json({ error: 'This request is not permitted from that page.', code: 'PUBLIC_ORIGIN_DENIED' }, 403, null);
    }
    const op = url.searchParams.get('op') || 'status';
    if (!['status', 'chat', 'transcribe'].includes(op)) return json({ error: 'That action was not found.', code: 'PUBLIC_NOT_FOUND' }, 404, permittedOrigin);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': permittedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600', Vary: 'Origin', 'Cache-Control': 'no-store',
      } });
    }
    if (request.method !== (op === 'status' ? 'GET' : 'POST')) {
      return json({ error: 'That request method is not supported.', code: 'PUBLIC_METHOD_NOT_ALLOWED' }, 405, permittedOrigin, { Allow: op === 'status' ? 'GET, OPTIONS' : 'POST, OPTIONS' });
    }
    if (!reserve(clientKey)) return json({ error: 'Please wait a moment before trying again.', code: 'PUBLIC_RATE_LIMITED' }, 429, permittedOrigin, { 'Retry-After': '60' });
    const controller = new AbortController();
    const stop = () => controller.abort();
    request.signal.addEventListener('abort', stop, { once: true });
    if (request.signal.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      let payload;
      let mediaType;
      if (op === 'chat') {
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          throw new PublicApiError('Send a text message to continue.', { status: 415, code: 'PUBLIC_CONTENT_TYPE' });
        }
        const body = await readBoundedBody(request, MAX_CHAT_BYTES, controller.signal);
        try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
        catch { throw new PublicApiError('The message could not be read. Please try again.'); }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.messages)
            || Object.keys(payload).some((key) => !['messages', 'context'].includes(key))) {
          throw new PublicApiError('Send a conversation message to continue.');
        }
      } else if (op === 'transcribe') {
        mediaType = normalizeAudioType(request.headers.get('content-type'));
        if (!mediaType) throw new PublicApiError('That recording format is not supported. Please type your message.', { status: 415, code: 'PUBLIC_CONTENT_TYPE' });
        payload = await readBoundedBody(request, MAX_AUDIO_BYTES, controller.signal);
        if (!payload.byteLength) throw new PublicApiError('The microphone recording was empty. Please try again.', { code: 'PUBLIC_INVALID_AUDIO' });
      }
      let token;
      try { token = await withAbort(getToken(), controller.signal); }
      catch (error) {
        checkAbort(controller.signal);
        throw new PublicApiError('The site’s conversation connection needs attention. You can still explore and keep your own notes.', { status: 503, code: 'PUBLIC_CONFIGURATION_REQUIRED' });
      }
      if (typeof token !== 'string' || !token) throw new PublicApiError('The site’s conversation connection needs attention.', { status: 503, code: 'PUBLIC_CONFIGURATION_REQUIRED' });
      if (op === 'status') {
        // No inference is billed here. "configured" does not assert provider or
        // credit availability; only an actual chat/transcription verifies those.
        return json({ ready: true, configured: true, availability: 'configured', model, transcription: true }, 200, permittedOrigin);
      }
      const result = op === 'chat'
        ? await withAbort(generateReply({ messages: payload.messages, context: payload.context, token, signal: controller.signal, fetchImpl, model }), controller.signal)
        : await withAbort(transcribe({ audio: payload, mediaType, token, signal: controller.signal, fetchImpl }), controller.signal);
      checkAbort(controller.signal);
      return json(result, 200, permittedOrigin);
    } catch (error) {
      if (timedOut) return json({ error: 'The guide took too long to respond. Please try again.', code: 'PUBLIC_TIMEOUT' }, 504, permittedOrigin);
      if (request.signal.aborted) return json({ error: 'Conversation stopped.', code: 'PUBLIC_CANCELLED' }, 499, permittedOrigin);
      if (error instanceof PublicApiError || error instanceof PublicModelError || error instanceof PublicAudioError) {
        return json({ error: error.message, code: error.code, ...(op === 'status' ? { ready: false, configured: false, transcription: false } : {}) }, error.status, permittedOrigin,
          error.status === 429 ? { 'Retry-After': '60' } : {});
      }
      // Never surface SDK diagnostics, upstream bodies, owner tokens or stack traces.
      return json({ error: 'The guide could not connect. Please try again in a moment.', code: 'PUBLIC_UNAVAILABLE' }, 503, permittedOrigin);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', stop);
      controller.abort();
      active--;
    }
  };
}
