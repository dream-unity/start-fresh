import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
import { RESPONSE_SCHEMA } from './src/response-schema.js';

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
  constructor(status, message) { super(message); this.status = status; }
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

function readMessages(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) {
    throw new RequestError(415, 'Send application/json with a messages array.');
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
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).length !== 1 || !Array.isArray(body.messages)
            || body.messages.length < 1 || body.messages.length > 32) throw new Error();
        const messages = body.messages.map((message) => {
          if (!message || typeof message !== 'object' || Array.isArray(message)
              || Object.keys(message).length !== 2
              || !['user', 'assistant', 'system'].includes(message.role)
              || typeof message.content !== 'string' || !message.content.trim()
              || message.content.length > 6000) throw new Error();
          return { role: message.role, content: message.content };
        });
        resolve(messages);
      } catch {
        reject(new RequestError(400, 'Expected only messages: 1–32 entries, each with role user, assistant, or system and 1–6000 characters of content.'));
      }
    };
    req.on('data', onData); req.on('end', onEnd);
    req.on('aborted', onAborted); req.on('error', onError);
  });
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
} = {}) {
  const upstreamBase = localOllamaUrl(ollamaUrl);
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)) throw new Error('OLLAMA_MODEL contains unsupported characters.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be positive.');
  const root = path.resolve(rootDir);
  const operations = new Set();

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
