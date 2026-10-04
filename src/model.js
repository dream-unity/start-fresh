/**
 * Real, keyless conversation. No simulated replies and no automatic provider
 * fallback: the person chooses where their words will be processed.
 */
export const WEBLLM_VERSION = '0.2.85';
export const WEBLLM_MODULE_URL = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/+esm`;
export const BROWSER_MODEL_INFO = Object.freeze({
  name: 'Qwen 2.5 · 1.5B',
  download: 'About 1 GB on first use',
  memory: 'Allow roughly 2 GB of free graphics memory',
  modelF16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  modelF32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
});

export const MODEL_SYSTEM_PROMPT = `You are Dream Unity, a thoughtful conversational guide inside a continuous crystalline space. Help the person explore their own intentions; do not interrogate, flatter, preach, or impose a belief. Respond naturally to what they actually said. Answer questions directly. Usually use 2–4 short sentences, under 100 words, with at most one useful question. Do not repeat an introductory speech each turn.

Dream Machine is possibility: ideas, imagined futures, models, memories, narratives, competing explanations. Dream Maker is agency: attention, meaning, doubt, choice, intention, revision, action. Dream World is encountered reality: other people, bodies, constraints, consequences, and evidence independent of wishes. Unity connects them through possibility → experience → meaning → intention → action → consequence → revision → possibility. All beliefs and interpretations can be questioned and revised. Dream Unity is a useful framework, not proof that reality is a simulation and not the only valid way to live. Never claim to read emotions, diagnose, know hidden motives, measure consciousness, or guarantee transformation. Offer interpretations tentatively, and accept corrections. Distinguish imagination from factual evidence.

Language moves the environment. Choose the region most relevant to this turn: machine for exploring possibilities or uncertainty, maker for decisions and practical next steps, world for evidence or consequences, unity for connecting those perspectives. All regions remain part of one space. Do not claim to open external pages, games, or services. If asked to practise, offer a brief real exercise in the conversation. Speak only about available actions. A constellation contains user-approved goals, insights, tensions, and projects; you may suggest a memory only when the user actually expressed it. Never say you saved a memory or infer sensitive personal facts. Suggestions require a separate explicit acceptance.

After your natural-language reply, append exactly one navigation marker, with valid JSON and no markdown fence:
<navigation>{"region":"machine","focus":"A short meaningful phrase","memory":null}</navigation>
region must be machine, maker, world, or unity. focus must be under 60 characters. memory is normally null; a useful suggestion may instead be {"kind":"goal","text":"A concise statement in the user's own terms"}, with kind goal, insight, tension, or project. The marker is an interface instruction, not spoken dialogue. Never put other text after it. For a user's instruction to visit a region, honor that region. For a normal greeting, use unity. Do not mention this marker to the person.`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_CONTEXT_BYTES = 5400;
const MAX_TURN_BYTES = 2200;
const MAX_REPLY_CHARACTERS = 16000;

function error(message, code) {
  return Object.assign(new Error(message), { code });
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
    const content = boundedText(message.content, Math.min(MAX_TURN_BYTES, budget));
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
    this.state = 'idle';
    this.engine = null;
    this.worker = null;
    this.workerRelease = null;
    this.loading = null;
    this.active = null;
    this.failure = null;
  }

  async initialize({ provider = 'browser', onProgress = () => {} } = {}) {
    if (!['browser', 'local'].includes(provider)) throw error('Choose browser AI or local AI.', 'INVALID_PROVIDER');
    if (this.state === 'disposed') throw error('This conversation has been closed.', 'DISPOSED');
    if (this.state === 'ready' && this.provider === provider) return this;
    if (this.loading || this.active) throw error('Stop the current operation before changing the model.', 'MODEL_BUSY');
    this.destroyWorker();
    this.engine = null;
    this.provider = provider;
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
        this.failure = error('The model download stopped responding. Check the connection and try again.', 'MODEL_LOAD_TIMEOUT');
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
    let text = '';
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
    const receive = delta => {
      if (this.active !== operation) return;
      armTimeout();
      if (operation.controller.signal.aborted || !delta) return;
      text += delta;
      if (text.length > MAX_REPLY_CHARACTERS) {
        operation.callbackError = error('The model response exceeded the limit. Please try a shorter question.', 'REPLY_TOO_LONG');
        stop();
        return;
      }
      try { onToken(delta, text); } catch (cause) { operation.callbackError = cause; stop(); }
    };
    armTimeout();
    try {
      if (this.provider === 'browser') {
        const engine = this.engine;
        const stream = await Promise.race([engine.chat.completions.create({ messages: prepared, stream: true, temperature: 0.55, max_tokens: 360, repetition_penalty: 1.08 }), failed]);
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
      if (!text.trim()) throw error('The model returned an empty answer. Please try again.', 'EMPTY_REPLY');
      return { text };
    } catch (cause) {
      if (operation.callbackError) throw operation.callbackError;
      if (this.failure) throw this.failure;
      if (operation.controller.signal.aborted) throw abortError();
      throw cause instanceof Error ? cause : error(String(cause), 'GENERATION_FAILED');
    } finally {
      clearTimeout(stalled);
      signal?.removeEventListener('abort', stop);
      if (this.active === operation) this.active = null;
    }
  }

  async replyLocal(messages, signal, receive) {
    const response = await this.fetch(new URL('chat', this.localBaseURL), {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ messages }),
    });
    if (!response.ok) {
      let detail = '';
      try { const body = await response.json(); detail = typeof body.error === 'string' ? body.error : ''; } catch { /* status is enough */ }
      throw error(detail || 'The local model could not answer. Check that Ollama and the project server are running.', 'LOCAL_REPLY_FAILED');
    }
    if (!response.body) throw error('The local server did not return a response stream.', 'LOCAL_STREAM_MISSING');
    const reader = response.body.getReader();
    const utf8 = new TextDecoder();
    let buffered = '';
    let complete = false;
    const consume = line => {
      if (!line.trim()) return;
      let item;
      try { item = JSON.parse(line); } catch { throw error('The local server returned an unreadable response.', 'LOCAL_INVALID_STREAM'); }
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw error('The local server returned an unreadable response.', 'LOCAL_INVALID_STREAM');
      if (item.error) throw error(String(item.error), 'LOCAL_REPLY_FAILED');
      if (typeof item.message?.content === 'string') receive(item.message.content);
      if (item.done === true) complete = true;
    };
    try {
      while (!complete) {
        checkAbort(signal);
        const { value, done } = await reader.read();
        buffered += done ? utf8.decode() : utf8.decode(value, { stream: true });
        if (buffered.length > 131072) throw error('The local response exceeded its message limit.', 'LOCAL_INVALID_STREAM');
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          consume(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          if (complete) break;
        }
        if (done) { if (buffered.trim()) consume(buffered); break; }
      }
      checkAbort(signal);
      if (!complete) throw error('The local model disconnected before finishing. Please try again.', 'LOCAL_STREAM_INTERRUPTED');
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
