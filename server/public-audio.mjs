// Dedicated, documented AI Gateway transcription API. Audio is forwarded only
// for this request; this application does not persist recordings or transcripts.
export const PUBLIC_TRANSCRIPTION_URL = 'https://ai-gateway.vercel.sh/v4/ai/transcription-model';
export const PUBLIC_TRANSCRIPTION_MODEL = 'openai/whisper-1';
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 64 * 1024;
const AUDIO_TYPES = new Set(['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mpeg']);

export class PublicAudioError extends Error {
  constructor(message, { status = 503, code = 'PUBLIC_TRANSCRIPTION_UNAVAILABLE' } = {}) {
    super(message);
    this.name = 'PublicAudioError';
    Object.assign(this, { status, code });
  }
}

export function normalizeAudioType(value) {
  const type = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return AUDIO_TYPES.has(type) ? type : null;
}

function audioError(status) {
  if (status === 429) return new PublicAudioError('The guide is busy. Please wait a moment before speaking again.', { status: 429, code: 'PUBLIC_RATE_LIMITED' });
  if (status === 402) return new PublicAudioError('The site’s conversation allowance has been used up. You can still explore and keep your own notes.', { code: 'PUBLIC_ALLOWANCE_EXHAUSTED' });
  if (status === 401 || status === 403) return new PublicAudioError('The site’s voice connection needs attention. You can still type or explore.', { code: 'PUBLIC_CONFIGURATION_REQUIRED' });
  if (status === 400 || status === 415 || status === 422) return new PublicAudioError('That recording could not be read. Please try speaking again, or type your message.', { status: 422, code: 'PUBLIC_INVALID_AUDIO' });
  return new PublicAudioError('The recording could not be transcribed. Please try again, or type your message.');
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Recording stopped.', 'AbortError');
}

function withAbort(promise, signal) {
  checkAbort(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(new DOMException('Recording stopped.', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** The caller enforces request size and deadline; only an owner token is used. */
export async function transcribePublicAudio({ audio, mediaType, token, signal, fetchImpl = globalThis.fetch }) {
  checkAbort(signal);
  const normalizedType = normalizeAudioType(mediaType);
  if (!normalizedType || !(audio instanceof Uint8Array) || !audio.byteLength || audio.byteLength > MAX_AUDIO_BYTES) {
    throw new PublicAudioError('Please send a short microphone recording.', { status: 400, code: 'PUBLIC_INVALID_AUDIO' });
  }
  if (typeof token !== 'string' || !token || token.length > 32_768 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw audioError(401);
  let response;
  try {
    response = await withAbort(fetchImpl(PUBLIC_TRANSCRIPTION_URL, {
      method: 'POST', redirect: 'error', signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'ai-gateway-protocol-version': '0.0.1',
        'ai-transcription-model-specification-version': '4',
        'ai-model-id': PUBLIC_TRANSCRIPTION_MODEL,
        'Content-Type': 'application/json', Accept: 'application/json',
      },
      body: JSON.stringify({ audio: Buffer.from(audio).toString('base64'), mediaType: normalizedType }),
    }), signal);
    checkAbort(signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw audioError(response.status);
    }
    if (!response.body) throw audioError(502);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await withAbort(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > MAX_TRANSCRIPTION_RESPONSE_BYTES) throw audioError(502);
        chunks.push(value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    checkAbort(signal);
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw audioError(502); }
    if (typeof result?.text !== 'string' || result.text.length > 6000) throw audioError(502);
    // Empty text represents a silent recording, not a model response.
    return { text: result.text.trim() };
  } catch (cause) {
    checkAbort(signal);
    if (cause instanceof PublicAudioError) throw cause;
    throw audioError(503);
  }
}
