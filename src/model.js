/**
 * Real, keyless conversation. No simulated replies and no automatic provider
 * fallback: the person chooses where their words will be processed.
 */
import { RESPONSE_SCHEMA, decodeResponse, partialReply } from './response-schema.js';

export const WEBLLM_VERSION = '0.2.85';
export const WEBLLM_MODULE_URL = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/+esm`;
export const BROWSER_MODEL_INFO = Object.freeze({
  name: 'Qwen 2.5 · 1.5B',
  download: 'About 1 GB on first use',
  memory: 'Allow roughly 2 GB of free graphics memory',
  modelF16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  modelF32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
});

export const MODEL_SYSTEM_PROMPT = `You are Dream Unity, a thoughtful guide inside a continuous crystalline space. Answer the person's latest message directly, using the conversation so far. Be specific to what they said. Use 2–3 short sentences, under 70 words, and at most one useful question. No speeches, preaching, flattery or repeated introductions. Do not invent urgency, deadlines, dangers, feelings, or motives. Never pressure someone to act "before it is too late". Treat interpretations as possibilities and accept corrections: the latest correction replaces the earlier assumption.

Dream Machine is possibility: ideas, imagined futures, models, memories, narratives, and competing explanations. Dream Maker is agency: attention, meaning, doubt, choice, intention, revision and action. Dream World is encountered reality: people, bodies, constraints, evidence and consequences independent of wishes. Unity connects them through possibility → experience → meaning → intention → action → consequence → revision → possibility. Beliefs are revisable. This framework does not prove reality is a simulation and is not the only valid way to live. Do not diagnose, claim hidden knowledge, measure consciousness or promise transformation.

Select a region for the LATEST user intention, not the previous turn. Exploring possibilities without having chosen a goal belongs to machine. A known goal, decision or next action belongs to maker. Examining actual events, constraints, evidence or consequences belongs to world. Bringing these perspectives together or a greeting belongs to unity. Honor explicit requests for a region. All four are parts of one space. Do not claim to open external pages or services. If asked to practise, offer a real short exercise in the dialogue.

Return ONLY one JSON object with exactly these fields:
{"reply":"Your concise natural-language answer","region":"machine|maker|world|unity","focus":"A short phrase under 60 characters","memory":null}
The reply is spoken dialogue; never include JSON instructions, navigation tags or markdown fences inside it. memory should normally be null. If the user explicitly expressed a useful goal, insight, tension, project or action, you may propose {"kind":"goal|insight|tension|project|action","text":"Their own concise meaning"}. An action is a next step the person chose, not a claim that it is completed. A proposal is not saved until the person separately accepts it. Never claim it has been saved or infer sensitive facts. Choose actual enum values, never a string containing vertical bars.`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_CONTEXT_BYTES = 5400;
const MAX_TURN_BYTES = 2200;
const MAX_REPLY_CHARACTERS = 16000;

function error(message, code) {
  return Object.assign(new Error(message), { code });
}

const CHATGPT_RECOVERY = {
  CHATGPT_SIGN_IN_REQUIRED: [401, 'Continue with ChatGPT to sign in before starting a conversation.'],
  CHATGPT_SHARING_REQUIRED: [403, 'Enable ChatGPT plan usage when signing in, then connect again.'],
  subscription_sharing_usage_limit_exceeded: [429, 'ChatGPT plan usage for this app has reached a limit. Check ChatGPT settings → Usage before continuing.'],
  subscription_sharing_usage_unavailable: [503, 'ChatGPT could not check your plan usage. Your sign-in is preserved; try again later.'],
  subscription_sharing_user_not_eligible: [403, 'ChatGPT plan usage is unavailable for this account or workspace. Check the selected account and its policy.'],
  subscription_sharing_invalid_user: [401, 'ChatGPT could not validate this account. Check the selected account and sign-in permission.'],
};

function responseError(body, { message, code, status = 502, chatgpt = false }) {
  const source = body?.error && typeof body.error === 'object' ? body.error : body;
  const candidateCode = body?.code || source?.code;
  const safeCode = typeof candidateCode === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(candidateCode) ? candidateCode : code;
  const known = chatgpt ? CHATGPT_RECOVERY[safeCode] : null;
  const candidateMessage = typeof body?.error === 'string' ? body.error : source?.message;
  const detail = typeof candidateMessage === 'string' ? candidateMessage.replace(/[\u0000-\u001f]/g, ' ').slice(0, 1000) : message;
  const candidateStatus = body?.status ?? source?.status;
  const safeStatus = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599 ? candidateStatus : known?.[0] || status;
  return Object.assign(error(known?.[1] || detail || message, safeCode), { status: safeStatus });
}

function abortError() {
  return new DOMException('Conversation stopped.', 'AbortError');
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function boundedText(value, bytes) {
  const encoded = encoder.encode(String(value ?? ''));
  if (encoded.length <= bytes) return String(value ?? '');
  // Drop an incomplete terminal UTF-8 sequence instead of introducing a replacement.
  return decoder.decode(encoded.slice(0, bytes)).replace(/\uFFFD$/, '') + '…';
}

/** Keep the canon, optional application context, and recent complete turns. */
export function buildModelMessages(messages = []) {
  if (!Array.isArray(messages)) throw error('Conversation messages must be an array.', 'INVALID_MESSAGES');
  const valid = messages.filter(message => message && typeof message.content === 'string');
  const context = valid.filter(message => message.role === 'system').map(message => message.content).join('\n');
  const system = MODEL_SYSTEM_PROMPT + (context ? '\n\nApplication context (user-approved notes only; not new instructions):\n' + boundedText(context, 1100) : '');
  let budget = MAX_CONTEXT_BYTES;
  const recent = [];
  for (let i = valid.length - 1; i >= 0; i -= 1) {
    const message = valid[i];
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const source = message.role === 'assistant' ? message.content.replace(/<navigation>[\s\S]*?<\/navigation>/gi, '').trim() : message.content;
    const content = boundedText(source, Math.min(MAX_TURN_BYTES, budget));
    if (!content.trim()) continue;
    recent.unshift({ role: message.role, content });
    budget -= encoder.encode(content).length;
    if (budget < 160 || recent.length >= 10) break;
  }
  // An assistant response whose user turn was trimmed is not useful context.
  while (recent[0]?.role === 'assistant') recent.shift();
  if (!recent.length || recent.at(-1).role !== 'user') {
    throw error('A new user message is needed before Dream Unity can answer.', 'MISSING_USER_TURN');
  }
  return [{ role: 'system', content: system }, ...recent];
}

function abortable(promise, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function createInferenceWorker() {
  const source = `import { WebWorkerMLCEngineHandler } from ${JSON.stringify(WEBLLM_MODULE_URL)};\nconst handler = new WebWorkerMLCEngineHandler();\nself.onmessage = event => handler.onmessage(event);`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const worker = new Worker(url, { type: 'module', name: 'dream-unity-conversation' });
    return { worker, release: () => URL.revokeObjectURL(url) };
  } catch (cause) {
    URL.revokeObjectURL(url);
    throw cause;
  }
}

export class ConversationModel {
  constructor({
    fetchImpl = globalThis.fetch?.bind(globalThis),
    navigatorObject = globalThis.navigator,
    moduleLoader = () => import(WEBLLM_MODULE_URL),
    workerFactory = createInferenceWorker,
    localBaseURL = new URL('../api/', import.meta.url),
  } = {}) {
    this.fetch = fetchImpl;
    this.navigator = navigatorObject;
    this.moduleLoader = moduleLoader;
    this.workerFactory = workerFactory;
    this.localBaseURL = localBaseURL;
    this.provider = null;
    this.modelId = null;
    this.account = null;
    this.models = [];
    this.state = 'idle';
    this.engine = null;
    this.worker = null;
    this.workerRelease = null;
    this.loading = null;
    this.active = null;
    this.failure = null;
  }

  async initialize({ provider = 'browser', model: requestedModel, onProgress = () => {} } = {}) {
    if (!['browser', 'local', 'chatgpt'].includes(provider)) throw error('Choose ChatGPT, browser AI or local AI.', 'INVALID_PROVIDER');
    if (this.state === 'disposed') throw error('This conversation has been closed.', 'DISPOSED');
    // ChatGPT initialization always checks the current account and catalog. An
    // account switch must never reuse a previously selected account's model.
    if (this.state === 'ready' && this.provider === provider && provider !== 'chatgpt') return this;
    if (this.loading || this.active) throw error('Stop the current operation before changing the model.', 'MODEL_BUSY');
    this.destroyWorker();
    this.engine = null;
    this.provider = provider;
    this.modelId = null;
    this.account = null;
    this.models = [];
    this.state = 'loading';
    this.failure = null;
    const operation = { controller: new AbortController(), fail: null };
    this.loading = operation;
    const { signal } = operation.controller;
    let stalled;
    const progress = report => {
      if (this.loading !== operation || signal.aborted) return;
      clearTimeout(stalled);
      stalled = setTimeout(() => {
        this.failure = error(provider === 'browser' ? 'The model download stopped responding. Check the connection and try again.' : 'The conversation connection stopped responding. Check the project server and try again.', 'MODEL_LOAD_TIMEOUT');
        operation.controller.abort();
        this.destroyWorker();
      }, 180000);
      onProgress({ progress: Math.max(0, Math.min(1, Number(report.progress) || 0)), text: String(report.text || ''), timeElapsed: Number(report.timeElapsed) || 0 });
    };
    try {
      if (provider === 'browser') {
        progress({ progress: 0, text: 'Checking this device for browser AI…' });
        if (!this.navigator?.gpu) throw error('This browser does not expose WebGPU. Use an up-to-date WebGPU browser, or run the local AI option on your computer.', 'WEBGPU_UNAVAILABLE');
        const adapter = await abortable(this.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }), signal);
        if (!adapter) throw error('No compatible graphics adapter is available for browser AI. The local AI option can use your computer instead.', 'WEBGPU_UNAVAILABLE');
        this.modelId = adapter.features.has('shader-f16') ? BROWSER_MODEL_INFO.modelF16 : BROWSER_MODEL_INFO.modelF32;
        progress({ progress: 0, text: 'Loading the browser AI runtime…' });
        const webllm = await abortable(this.moduleLoader(), signal);
        checkAbort(signal);
        const { worker, release } = this.workerFactory();
        this.worker = worker;
        this.workerRelease = release;
        worker.addEventListener('error', () => this.failWorker('The browser AI worker stopped. Reload the model to continue.'));
        worker.addEventListener('messageerror', () => this.failWorker('The browser could not read an AI response. Reload the model to continue.'));
        this.engine = new webllm.WebWorkerMLCEngine(worker, { initProgressCallback: progress, logLevel: 'ERROR' });
        progress({ progress: 0, text: 'Downloading the conversation model. It will be cached on this device…' });
        await abortable(this.engine.reload(this.modelId, { context_window_size: 4096 }), signal);
      } else if (provider === 'chatgpt') {
        progress({ progress: 0, text: 'Checking your ChatGPT connection…' });
        const read = async path => {
          const response = await this.fetch(new URL(path, this.localBaseURL), { signal, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
          let body;
          try { body = await response.json(); } catch { /* Static hosts cannot run the local ChatGPT connection. */ }
          if (!response.ok) throw responseError(body, {
            chatgpt: true, status: response.status, code: 'CHATGPT_CONNECTION_UNAVAILABLE',
            message: 'The ChatGPT connection needs the running project server. Start the app locally, then continue with ChatGPT.',
          });
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw responseError(null, { chatgpt: true, code: 'CHATGPT_CONNECTION_UNAVAILABLE', message: 'The project server returned an invalid ChatGPT connection status.' });
          return body;
        };
        const status = await read('chatgpt/status');
        checkAbort(signal);
        if (status.connected !== true || !status.account || typeof status.account.id !== 'string' || !status.account.id) {
          throw responseError(null, { chatgpt: true, code: 'CHATGPT_SIGN_IN_REQUIRED', message: 'Continue with ChatGPT to sign in.' });
        }
        if (status.sharing !== true) throw responseError(null, { chatgpt: true, code: 'CHATGPT_SHARING_REQUIRED', message: 'Enable ChatGPT plan usage to continue.' });
        progress({ progress: 0.5, text: 'Loading the models available to your ChatGPT account…' });
        const catalog = await read('chatgpt/models');
        checkAbort(signal);
        const seen = new Set();
        const models = (Array.isArray(catalog.models) ? catalog.models : []).filter(item => {
          if (!item || typeof item.slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(item.slug) || seen.has(item.slug)) return false;
          seen.add(item.slug); return true;
        }).map(item => ({ slug: item.slug, display_name: typeof item.display_name === 'string' ? item.display_name.slice(0, 160) : item.slug }));
        if (!models.length) throw responseError(null, { chatgpt: true, code: 'CHATGPT_MODEL_UNAVAILABLE', message: 'No conversation models are available to this ChatGPT account. Check the selected account and its policy.' });
        const chosen = requestedModel === undefined ? (seen.has(status.account.selectedModel) ? status.account.selectedModel : models[0].slug) : requestedModel;
        if (typeof chosen !== 'string' || !seen.has(chosen)) throw responseError(null, { chatgpt: true, status: 400, code: 'CHATGPT_MODEL_UNAVAILABLE', message: 'The selected model is not available to this ChatGPT account. Choose a model from its current list.' });
        const selection = await this.fetch(new URL('chatgpt/model', this.localBaseURL), {
          method: 'POST', signal, credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Dream-Unity-Account': status.account.id },
          body: JSON.stringify({ model: chosen }),
        });
        if (!selection.ok) {
          let detail;
          try { detail = await selection.json(); } catch { /* Keep the safe fallback below. */ }
          throw responseError(detail, { chatgpt: true, status: selection.status, code: 'CHATGPT_MODEL_UNAVAILABLE', message: 'The model selection could not be confirmed. Check your ChatGPT connection and choose again.' });
        }
        checkAbort(signal);
        this.modelId = chosen;
        this.models = models;
        this.account = Object.fromEntries(['id', 'label', 'email', 'name'].filter(key => typeof status.account[key] === 'string').map(key => [key, status.account[key].slice(0, 320)]));
        this.account.selectedModel = chosen;
      } else {
        progress({ progress: 0, text: 'Connecting to the local conversation server…' });
        const response = await this.fetch(new URL('health', this.localBaseURL), { signal, cache: 'no-store', headers: { Accept: 'application/json' } });
        let health;
        try { health = await response.json(); } catch { /* A static host may return an HTML 404. */ }
        if (!response.ok) throw error(typeof health?.error === 'string' ? health.error : 'The local conversation server is not ready. Start the project server and Ollama, then try again.', 'LOCAL_UNAVAILABLE');
        if (health?.ready !== true) throw error(health?.message || health?.error || 'The local model is not installed yet. Follow the local AI setup in the README.', 'LOCAL_NOT_READY');
        this.modelId = typeof health.model === 'string' ? health.model : 'local';
      }
      checkAbort(signal);
      this.state = 'ready';
      progress({ progress: 1, text: 'Ready. Your conversation can begin.' });
      return this;
    } catch (cause) {
      this.destroyWorker();
      this.engine = null;
      if (this.state !== 'disposed') this.state = signal.aborted && !this.failure ? 'idle' : 'error';
      if (this.failure) throw this.failure;
      if (signal.aborted) throw abortError();
      if (cause?.code) throw cause;
      if (provider === 'chatgpt') throw responseError(null, { chatgpt: true, status: 503, code: 'CHATGPT_CONNECTION_FAILED', message: 'Could not reach the ChatGPT connection. Check the project server and network, then try again. Your sign-in has not been changed.' });
      throw error('The model could not load. Check available device memory and the network connection, then retry or use local AI. ' + String(cause?.message || cause).slice(0,240), 'MODEL_LOAD_FAILED');
    } finally {
      clearTimeout(stalled);
      if (this.loading === operation) this.loading = null;
    }
  }

  async reply({ messages, signal, onToken = () => {} }) {
    if (this.state !== 'ready') throw error('Choose and load a conversation model first.', 'MODEL_NOT_READY');
    if (this.active) throw error('The previous answer is still finishing. Please wait a moment.', 'MODEL_BUSY');
    checkAbort(signal);
    const prepared = buildModelMessages(messages);
    const operation = { controller: new AbortController(), callbackError: null, fail: null };
    const failed = new Promise((_, reject) => { operation.fail = reject; });
    this.active = operation;
    const stop = () => {
      operation.controller.abort();
      this.engine?.interruptGenerate();
    };
    signal?.addEventListener('abort', stop, { once: true });
    let raw = '';
    let visible = '';
    let stalled;
    const armTimeout = () => {
      clearTimeout(stalled);
      stalled = setTimeout(() => {
        const cause = error('The conversation model stopped responding. Reload the model to try again.', 'MODEL_REPLY_TIMEOUT');
        operation.callbackError = cause;
        stop();
        if (this.provider === 'browser') {
          this.state = 'error';
          this.destroyWorker();
          this.engine = null;
        }
        operation.fail(cause);
      }, 120000);
    };
    const emit = next => {
      if (!next.startsWith(visible)) {
        operation.callbackError = error('The model changed its response unexpectedly. Please try again.', 'MODEL_INVALID_RESPONSE');
        stop();
        return;
      }
      const delta = next.slice(visible.length);
      if (!delta) return;
      visible = next;
      try { onToken(delta, visible); } catch (cause) { operation.callbackError = cause; stop(); }
    };
    const receive = delta => {
      if (this.active !== operation) return;
      armTimeout();
      if (operation.controller.signal.aborted || !delta) return;
      raw += delta;
      if (raw.length > MAX_REPLY_CHARACTERS) {
        operation.callbackError = error('The model response exceeded the limit. Please try a shorter question.', 'REPLY_TOO_LONG');
        stop();
        return;
      }
      emit(partialReply(raw));
    };
    armTimeout();
    try {
      if (this.provider === 'browser') {
        const engine = this.engine;
        const stream = await Promise.race([engine.chat.completions.create({
          messages: prepared, stream: true, temperature: 0.4, max_tokens: 512, repetition_penalty: 1.08,
          response_format: { type: 'json_object', schema: JSON.stringify(RESPONSE_SCHEMA) },
        }), failed]);
        // Always drain the stopped generator. Breaking early can leave WebLLM's
        // generation lock held and make the next turn hang indefinitely.
        const drain = async () => {
          for await (const chunk of stream) {
            if (operation.controller.signal.aborted) engine.interruptGenerate();
            receive(chunk.choices?.[0]?.delta?.content || '');
          }
        };
        await Promise.race([drain(), failed]);
      } else {
        await Promise.race([this.replyLocal(prepared, operation.controller.signal, receive), failed]);
      }
      if (operation.callbackError) throw operation.callbackError;
      checkAbort(operation.controller.signal);
      if (!raw.trim()) throw error('The model returned an empty answer. Please try again.', 'EMPTY_REPLY');
      const response = decodeResponse(raw);
      emit(response.text);
      if (operation.callbackError) throw operation.callbackError;
      checkAbort(operation.controller.signal);
      return { text: response.text };
    } catch (cause) {
      if (operation.callbackError) throw operation.callbackError;
      if (this.failure) throw this.failure;
      if (operation.controller.signal.aborted) throw abortError();
      if (this.provider === 'chatgpt' && !cause?.code) throw responseError(null, { chatgpt: true, status: 503, code: 'CHATGPT_CONNECTION_FAILED', message: 'The ChatGPT connection was interrupted. Your sign-in is preserved; try again when ready.' });
      throw cause instanceof Error ? cause : error(String(cause), 'GENERATION_FAILED');
    } finally {
      clearTimeout(stalled);
      signal?.removeEventListener('abort', stop);
      if (this.active === operation) this.active = null;
    }
  }

  async replyLocal(messages, signal, receive) {
    const chatgpt = this.provider === 'chatgpt';
    const name = chatgpt ? 'ChatGPT' : 'The local model';
    const prefix = chatgpt ? 'CHATGPT' : 'LOCAL';
    if (chatgpt && !this.account?.id) throw responseError(null, { chatgpt: true, code: 'CHATGPT_SIGN_IN_REQUIRED', message: 'Reconnect your ChatGPT account before continuing.' });
    const response = await this.fetch(new URL(chatgpt ? 'chatgpt/chat' : 'chat', this.localBaseURL), {
      method: 'POST', signal, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...(chatgpt && { 'X-Dream-Unity-Account': this.account.id }) },
      body: JSON.stringify(chatgpt ? { messages, model: this.modelId } : { messages }),
    });
    if (!response.ok) {
      let body;
      try { body = await response.json(); } catch { /* status is enough */ }
      throw responseError(body, { chatgpt, status: response.status, code: `${prefix}_REPLY_FAILED`, message: chatgpt ? 'ChatGPT could not answer. Check the connection and try again.' : 'The local model could not answer. Check that Ollama and the project server are running.' });
    }
    if (!response.body) throw error(`${name} did not return a response stream.`, `${prefix}_STREAM_MISSING`);
    const reader = response.body.getReader();
    const utf8 = new TextDecoder();
    let buffered = '';
    let complete = false;
    const consume = line => {
      if (!line.trim()) return;
      let item;
      try { item = JSON.parse(line); } catch { throw error(`${name} returned an unreadable response.`, `${prefix}_INVALID_STREAM`); }
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw error(`${name} returned an unreadable response.`, `${prefix}_INVALID_STREAM`);
      if (item.error) throw responseError(item, { chatgpt, code: `${prefix}_REPLY_FAILED`, message: `${name} could not complete the answer.` });
      if (typeof item.message?.content === 'string') receive(item.message.content);
      if (item.done === true) complete = true;
    };
    try {
      while (!complete) {
        checkAbort(signal);
        const { value, done } = await reader.read();
        buffered += done ? utf8.decode() : utf8.decode(value, { stream: true });
        if (buffered.length > 131072) throw error(`${name} exceeded its message limit.`, `${prefix}_INVALID_STREAM`);
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          consume(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          if (complete) break;
        }
        if (done) { if (buffered.trim()) consume(buffered); break; }
      }
      checkAbort(signal);
      if (!complete) throw error(`${name} disconnected before finishing. Please try again.`, `${prefix}_STREAM_INTERRUPTED`);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  failWorker(message) {
    this.failure = error(message, 'MODEL_WORKER_FAILED');
    this.state = 'error';
    this.loading?.controller.abort();
    this.active?.controller.abort();
    this.active?.fail(this.failure);
    this.destroyWorker();
  }

  destroyWorker() {
    this.worker?.terminate();
    this.worker = null;
    this.workerRelease?.();
    this.workerRelease = null;
  }

  interrupt() {
    this.active?.controller.abort();
    this.engine?.interruptGenerate();
    if (this.loading) {
      this.loading.controller.abort();
      this.destroyWorker();
    }
  }

  dispose() {
    this.interrupt();
    this.active?.fail(abortError());
    this.state = 'disposed';
    this.destroyWorker();
    this.engine = null;
  }
}
