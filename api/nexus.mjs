import { Readable } from 'node:stream';
import { createPublicApiHandler } from '../server/public-api.mjs';

export const maxDuration = 60;
// The browser sends raw audio, so do not run a framework JSON body parser first.
export const config = { api: { bodyParser: false } };
const handle = createPublicApiHandler();

/** Vercel's standard Node.js request/response handler, also usable locally. */
export function createNodeApiHandler(handleRequest = handle) {
  return async function nexus(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const disconnect = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort);
  res.once('close', disconnect);
  try {
    const host = req.headers.host;
    if (typeof host !== 'string' || !/^[a-zA-Z0-9.:[\]-]+$/.test(host)
        || typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end('{"error":"Invalid request.","code":"PUBLIC_INVALID_REQUEST"}');
      return;
    }
    const protocol = req.headers['x-forwarded-proto'] === 'http' || /^(localhost|127\.0\.0\.1|\[::1\])(?::|$)/.test(host) ? 'http' : 'https';
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    const init = { method: req.method, headers, signal: controller.signal };
    if (!['GET', 'HEAD'].includes(req.method)) {
      // Some Node adapters expose an already-parsed body; retain the same size
      // checks in createPublicApiHandler for both adapter forms.
      if (req.body !== undefined) init.body = Buffer.isBuffer(req.body) || typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      else { init.body = Readable.toWeb(req); init.duplex = 'half'; }
    }
    const request = new Request(new URL(req.url, `${protocol}://${host}`), init);
    // Vercel overwrites its own forwarding header at the edge. This is only an
    // expiring per-instance abuse guard. Project budgets check spend separately
    // when requests start, so in-flight usage can exceed a configured budget.
    const forwarded = req.headers['x-vercel-forwarded-for'];
    const clientKey = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress;
    const response = await handleRequest(request, { clientKey });
    if (res.destroyed || controller.signal.aborted) return;
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!res.destroyed && !res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end('{"error":"The guide could not connect. Please try again.","code":"PUBLIC_UNAVAILABLE"}');
    }
  } finally {
    req.off('aborted', abort);
    res.off('close', disconnect);
  }
  };
}

export default createNodeApiHandler();
