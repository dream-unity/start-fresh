import { RESPONSE_SCHEMA, decodeResponse } from '../src/response-schema.js';

// ChatGPT plan usage has an explicit public route. Do not replace this with a
// private ChatGPT endpoint, an API-key fallback, or an automatically retried call.
export const CHATGPT_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_OUTPUT_CHARACTERS = 16_000;

export class ChatGPTResponseError extends Error {
  constructor(message, { code = 'CHATGPT_RESPONSE_FAILED', status = 502, upstreamStatus = null, requestId = null, param = null, details = null } = {}) {
    super(message);
    this.name = 'ChatGPTResponseError';
    Object.assign(this, { code, status, upstreamStatus, requestId, param, details });
  }
}

function aborted(signal) {
  if (signal?.aborted) throw new DOMException('Conversation stopped.', 'AbortError');
}

function withAbort(promise, signal) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const stop = () => reject(new DOMException('Conversation stopped.', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

function redacted(value, accessToken) {
  const serialized = JSON.stringify(value ?? null);
  const safe = serialized.split(accessToken).join('[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]');
  return JSON.parse(safe);
}

const recovery = {
  subscription_sharing_usage_limit_exceeded: [429, 'ChatGPT plan usage for this app has reached a limit. Check ChatGPT settings → Usage before continuing.'],
  subscription_sharing_usage_unavailable: [503, 'ChatGPT could not check your plan usage. Your sign-in is preserved; try again later.'],
  subscription_sharing_user_not_eligible: [403, 'ChatGPT plan usage is unavailable for this account or workspace. Check the selected account and its policy.'],
  subscription_sharing_unsupported_capability: [400, 'The selected ChatGPT model does not support this request. Review the model or capability setting.'],
  subscription_sharing_route_not_supported: [403, 'ChatGPT plan usage is not enabled for this request route. Review the integration configuration.'],
  subscription_sharing_invalid_user: [401, 'ChatGPT could not validate this account. Check the selected account and sign-in permission.'],
  subscription_sharing_user_unavailable: [503, 'ChatGPT account information is temporarily unavailable. Your sign-in is preserved; try again later.'],
  chatpass_v2_scope_not_authorized: [403, 'This sign-in does not authorize ChatGPT plan usage. Check the granted permission.'],
  chatpass_v2_invalid_authorization_context: [403, 'This sign-in does not authorize ChatGPT plan usage. Check the granted permission.'],
};

function upstreamError(body, context, fallback = 'ChatGPT could not complete this answer.') {
  const safe = redacted(body, context.accessToken);
  const source = safe?.error && typeof safe.error === 'object' ? safe.error : safe;
  const code = typeof source?.code === 'string' ? source.code.slice(0, 200) : 'CHATGPT_RESPONSE_FAILED';
  const known = recovery[code];
  const detail = typeof source?.message === 'string' ? source.message : typeof safe?.detail === 'string' ? safe.detail : '';
  const status = context.upstreamStatus >= 400 ? context.upstreamStatus : known?.[0] || 502;
  const message = known?.[1] || (detail ? detail.slice(0, 1000) : fallback);
  return new ChatGPTResponseError(message, {
    ...context, status, code,
    param: typeof source?.param === 'string' ? source.param.slice(0, 200) : null,
    details: safe,
  });
}

function createBody(messages, model) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)) {
    throw new ChatGPTResponseError('Choose a model available to your signed-in ChatGPT account.', { status: 400, code: 'CHATGPT_MODEL_REQUIRED' });
  }
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 32) {
    throw new ChatGPTResponseError('Provide the conversation messages for this turn.', { status: 400, code: 'CHATGPT_INVALID_MESSAGES' });
  }
  const instructions = [];
  const input = [];
  for (const message of messages) {
    if (!message || !['system', 'user', 'assistant'].includes(message.role)
        || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 6000) {
      throw new ChatGPTResponseError('The conversation contains an invalid message.', { status: 400, code: 'CHATGPT_INVALID_MESSAGES' });
    }
    if (message.role === 'system') instructions.push(message.content);
    else input.push({ role: message.role, content: message.content });
  }
  if (!input.length || input.at(-1).role !== 'user') {
    throw new ChatGPTResponseError('A new user message is needed before ChatGPT can answer.', { status: 400, code: 'CHATGPT_INVALID_MESSAGES' });
  }
  // SIWC rejects explicit system input items and fields such as temperature,
  // max_output_tokens and previous_response_id. History is sent on every turn.
  return {
    model,
    ...(instructions.length && { instructions: instructions.join('\n\n') }),
    input,
    store: false,
    stream: true,
    text: { format: { type: 'json_schema', name: 'dream_unity_response', strict: true, schema: RESPONSE_SCHEMA } },
  };
}

async function readDiagnostic(body, signal) {
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const result = await withAbort(reader.read(), signal);
      if (result.done) { text += decoder.decode(); break; }
      bytes += result.value.byteLength;
      if (bytes > MAX_ERROR_BYTES) {
        text += decoder.decode(result.value.subarray(0, Math.max(0, MAX_ERROR_BYTES - bytes + result.value.byteLength)), { stream: true });
        return { truncated: true, detail: text.slice(0, MAX_ERROR_BYTES) };
      }
      text += decoder.decode(result.value, { stream: true });
    }
    try { return JSON.parse(text); } catch { return { detail: text.slice(0, 2000) }; }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** SSE framing handles CR, LF, CRLF, split UTF-8, comments and multiline data. */
async function* events(body, signal, context) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let size = 0;
  let event = '';
  let data = [];
  try {
    while (true) {
      const result = await withAbort(reader.read(), signal);
      if (result.done) buffer += decoder.decode();
      else {
        size += result.value.byteLength;
        if (size > MAX_STREAM_BYTES) throw new ChatGPTResponseError('The ChatGPT stream exceeded its size limit.', { ...context, code: 'CHATGPT_STREAM_TOO_LARGE' });
        buffer += decoder.decode(result.value, { stream: true });
      }
      while (true) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0 || (buffer[end] === '\r' && end === buffer.length - 1 && !result.done)) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + (buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1));
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = ''; data = [];
        } else if (line[0] !== ':') {
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
      }
      // SSE requires a blank line to commit a frame. An unterminated frame at
      // EOF is not evidence that inference reached response.completed.
      if (result.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function completedText(response, context) {
  const items = Array.isArray(response?.output) ? response.output : [];
  const content = items.flatMap(item => Array.isArray(item?.content) ? item.content : []);
  if (content.some(item => item?.type === 'refusal')) throw new ChatGPTResponseError('ChatGPT declined this request. Please rephrase it or choose another topic.', { ...context, code: 'CHATGPT_REFUSAL', status: 422 });
  return content.filter(item => item?.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('');
}

/**
 * Yield Ollama-compatible NDJSON objects for the shared browser adapter.
 * The caller authenticates the account, verifies its direct-use permission, and
 * selects model from that account's live catalog before invoking this function.
 * Only response.completed, with valid structured output, yields done:true.
 */
export async function* streamChatGPTResponse({ messages, model, accessToken, signal, fetchImpl = globalThis.fetch }) {
  aborted(signal);
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 32_768 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(accessToken)) {
    throw new ChatGPTResponseError('Sign in with ChatGPT before starting the conversation.', { code: 'CHATGPT_SIGN_IN_REQUIRED', status: 401 });
  }
  const body = createBody(messages, model);
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const context = { accessToken, upstreamStatus: null, requestId: null };
  let raw = '';
  try {
    const response = await withAbort(fetchImpl(CHATGPT_RESPONSES_URL, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    }), controller.signal);
    context.upstreamStatus = response.status;
    context.requestId = redacted(response.headers.get('x-request-id') || response.headers.get('openai-request-id') || null, accessToken)?.slice(0, 200) || null;
    if (!response.ok) throw upstreamError(await readDiagnostic(response.body, controller.signal), context, `ChatGPT could not start this request (HTTP ${response.status}).`);
    if (!response.body || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel();
      throw new ChatGPTResponseError('ChatGPT did not return the expected response stream.', { ...context, code: 'CHATGPT_INVALID_STREAM' });
    }
    for await (const frame of events(response.body, controller.signal, context)) {
      aborted(controller.signal);
      if (frame.data.trim() === '[DONE]') continue;
      let event;
      try { event = JSON.parse(frame.data); } catch {
        throw new ChatGPTResponseError('ChatGPT returned an unreadable stream event.', { ...context, code: 'CHATGPT_INVALID_STREAM' });
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new ChatGPTResponseError('ChatGPT returned an invalid stream event.', { ...context, code: 'CHATGPT_INVALID_STREAM' });
      }
      const type = typeof event.type === 'string' ? event.type : frame.event;
      if (type === 'response.failed') throw upstreamError(event.response || event, context);
      if (type === 'error') throw upstreamError(event, context);
      if (type === 'response.incomplete') throw new ChatGPTResponseError('ChatGPT stopped before completing this answer. Please try again.', {
        ...context, code: 'CHATGPT_RESPONSE_INCOMPLETE', details: redacted(event.response || event, accessToken),
      });
      if (type === 'response.refusal.delta' || type === 'response.refusal.done') {
        throw new ChatGPTResponseError('ChatGPT declined this request. Please rephrase it or choose another topic.', { ...context, code: 'CHATGPT_REFUSAL', status: 422 });
      }
      if (type === 'response.output_text.delta') {
        if (typeof event.delta !== 'string') throw new ChatGPTResponseError('ChatGPT returned an invalid text fragment.', { ...context, code: 'CHATGPT_INVALID_STREAM' });
        raw += event.delta;
        if (raw.length > MAX_OUTPUT_CHARACTERS) throw new ChatGPTResponseError('The ChatGPT answer exceeded its length limit.', { ...context, code: 'CHATGPT_OUTPUT_TOO_LARGE' });
        if (event.delta) yield { message: { content: event.delta }, done: false };
      }
      if (type === 'response.completed') {
        if (!event.response || event.response.status !== 'completed' || event.response.error) {
          throw upstreamError(event.response || event, context, 'ChatGPT did not confirm a completed response.');
        }
        const final = completedText(event.response, context);
        if (final && raw && final !== raw) throw new ChatGPTResponseError('The completed ChatGPT answer did not match its stream.', { ...context, code: 'CHATGPT_STREAM_MISMATCH' });
        const output = raw || final;
        if (output.length > MAX_OUTPUT_CHARACTERS) throw new ChatGPTResponseError('The ChatGPT answer exceeded its length limit.', { ...context, code: 'CHATGPT_OUTPUT_TOO_LARGE' });
        try { decodeResponse(output); } catch {
          throw new ChatGPTResponseError('ChatGPT did not return a valid Dream Unity response. Please try again.', { ...context, code: 'MODEL_INVALID_RESPONSE' });
        }
        aborted(controller.signal);
        if (!raw && final) yield { message: { content: final }, done: false };
        yield { done: true };
        return;
      }
    }
    throw new ChatGPTResponseError('The ChatGPT connection ended before the answer completed. Please try again.', { ...context, code: 'CHATGPT_STREAM_INTERRUPTED' });
  } catch (cause) {
    if (signal?.aborted || cause?.name === 'AbortError') throw new DOMException('Conversation stopped.', 'AbortError');
    if (cause instanceof ChatGPTResponseError) throw cause;
    throw new ChatGPTResponseError('The connection to ChatGPT was interrupted. Try again when ready.', {
      ...context, code: 'CHATGPT_NETWORK_ERROR', details: redacted({ message: String(cause?.message || cause) }, accessToken),
    });
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', stop);
  }
}
