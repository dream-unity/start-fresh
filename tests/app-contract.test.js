import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { VoiceSession } from '../src/voice.js';
import { REGIONS, parseReply, visibleReply, localCommand, conversationContext } from '../src/meaning.js';

// The real application and VoiceSession run together here. Only browser hardware,
// scene rendering and service boundaries are fixtures; these are not live audio tests.
const PUBLIC_API_BASE = 'https://guide.example.test';
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function appFixture(t, {
  synthesis = true, recognition = false, recorder = true, initialize,
  getUserMedia, fetchImpl, settleStartup = true,
} = {}) {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const elements = new Map();
  const documentEvents = new Map(), windowEvents = new Map();
  class Element {
    constructor(id = '') {
      this.id = id; this.value = ''; this.textContent = ''; this.hidden = false;
      this.open = false; this.checked = id === 'spoken-replies'; this.disabled = false;
      this.dataset = {}; this.children = []; this.events = new Map(); this.selectedOptions = [];
      this.classList = { add() {} };
    }
    addEventListener(type, callback) { this.events.set(type, callback); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; queueMicrotask(() => this.events.get('close')?.({})); }
    querySelector(selector) {
      assert.equal(selector, '[data-close]');
      return this.closeButton ||= new Element();
    }
    click() { return this.events.get('click')?.({}); }
  }
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    assert.ok(!elements.has(id), `Duplicate real DOM id: ${id}`);
    elements.set(id, new Element(id));
  }
  const get = (id) => {
    assert.ok(elements.has(id), `Application requested missing index.html id: ${id}`);
    return elements.get(id);
  };
  const dialogs = [...html.matchAll(/<dialog\b[^>]*\bid="([^"]+)"/g)].map(([, id]) => get(id));
  const sessionStatus = new Element();
  const document = {
    visibilityState: 'visible', hidden: false, activeElement: null,
    getElementById: get,
    querySelector(selector) {
      if (selector === 'dialog[open]') return dialogs.find((item) => item.open) || null;
      assert.equal(selector, '.session-status', `Unexpected DOM selector: ${selector}`);
      return sessionStatus;
    },
    querySelectorAll(selector) { assert.equal(selector, 'dialog'); return dialogs; },
    createElement: () => new Element(),
    documentElement: { style: { setProperty() {} } },
    body: { classList: { add() {} } },
    addEventListener(type, callback) {
      if (!documentEvents.has(type)) documentEvents.set(type, new Set());
      documentEvents.get(type).add(callback);
    },
    removeEventListener(type, callback) { documentEvents.get(type)?.delete(callback); },
  };
  let now = 0, timerId = 0;
  const timers = new Map();
  const setTimer = (callback, delay = 0) => {
    const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id;
  };
  const clearTimer = (id) => timers.delete(id);
  async function advance(milliseconds) {
    const end = now + milliseconds;
    let executions = 0;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(++executions < 1000, 'Timers must not create an unbounded retry loop');
      const [id, timer] = next; now = timer.at; timers.delete(id); timer.callback();
      await settle();
    }
    now = end;
    await settle();
  }
  const requests = [], microphoneRequests = [], captures = [], nativeCaptures = [], utterances = [], streams = [];
  function createStream() {
    const track = {
      readyState: 'live', stops: 0,
      stop() { this.stops++; this.readyState = 'ended'; },
      addEventListener() {}, removeEventListener() {},
    };
    const stream = { track, getTracks: () => [track], getAudioTracks: () => [track] };
    streams.push(stream); return stream;
  }
  class Recognition {
    constructor() { nativeCaptures.push(this); }
    start() {}
    stop() {}
    abort() {}
  }
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(stream, options) {
      this.stream = stream; this.mimeType = options.mimeType; this.state = 'inactive';
      captures.push(this);
    }
    start() { this.state = 'recording'; this.onstart?.(); }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['synthetic-audio-fixture'], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  const environment = {
    document, SpeechRecognition: recognition ? Recognition : undefined,
    MediaRecorder: recorder ? Recorder : undefined,
    navigator: { language: 'en-US', mediaDevices: { getUserMedia(constraints) {
      microphoneRequests.push(constraints);
      return getUserMedia ? getUserMedia({ createStream, request: microphoneRequests.length }) : Promise.resolve(createStream());
    } } },
    Blob, isSecureContext: true, setTimeout: setTimer, clearTimeout: clearTimer,
    performance: { now: () => now },
    speechSynthesis: synthesis ? { speak: (item) => utterances.push(item), cancel() {}, getVoices: () => [] } : undefined,
    SpeechSynthesisUtterance: synthesis ? class { constructor(text) { this.text = text; } } : undefined,
  };
  let voice, model;
  class ControllerVoice extends VoiceSession {
    constructor(options) { super({ ...options, environment }); voice = this; }
  }
  class Model {
    constructor() {
      model = this; this.state = 'idle'; this.active = null; this.pending = [];
      this.initializeCalls = []; this.interrupts = 0;
    }
    async initialize(options) {
      this.initializeCalls.push(options); this.state = 'loading';
      try { await initialize?.(options, this.initializeCalls.length); this.state = 'ready'; }
      catch (error) { this.state = 'error'; throw error; }
    }
    async reply(options) {
      this.active = options;
      try { return await new Promise((resolve, reject) => this.pending.push({ resolve, reject, ...options })); }
      finally { this.active = null; }
    }
    interrupt() { this.interrupts++; }
    dispose() { this.state = 'disposed'; }
  }
  const source = (await readFile(new URL('../src/app.js', import.meta.url), 'utf8')).replace(/^import .+;\s*$/gm, '');
  const sandbox = {
    document, window: { addEventListener: (name, callback) => windowEvents.set(name, callback) },
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      if (!fetchImpl) throw new Error(`Unexpected request: ${url}`);
      return fetchImpl(url, options);
    },
    matchMedia: () => ({ matches: false }),
    createScene: () => ({ setMotion() {}, setRegion() {}, setListening() {}, setSpeaking() {}, setMemory() {}, dispose() {} }),
    VoiceSession: ControllerVoice, ConversationModel: Model, PUBLIC_API_BASE,
    createConstellation: () => ({ getSnapshot: () => ({ nodes: [], mode: 'session' }) }),
    REGIONS, parseReply, visibleReply, localCommand, conversationContext,
    AbortController, AbortSignal, URL, Blob, setTimeout: setTimer, clearTimeout: clearTimer, confirm: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nglobalThis.controller = {enterVoice,submit,pauseSession,loadModel,openDialog};', sandbox);
  t.after(() => voice.dispose());
  if (settleStartup) await settle();
  return {
    ...sandbox.controller, voice, model, captures, nativeCaptures, utterances, get, requests,
    microphoneRequests, streams, createStream, advance, settle,
    hide() {
      document.hidden = true; document.visibilityState = 'hidden';
      for (const callback of documentEvents.get('visibilitychange') || []) callback({});
    },
    show() {
      document.hidden = false; document.visibilityState = 'visible';
      for (const callback of documentEvents.get('visibilitychange') || []) callback({});
    },
    pagehide(persisted) { windowEvents.get('pagehide')?.({ persisted }); },
  };
}

test('entry performs exactly one silent public preflight without capture, speech or inference', async (t) => {
  const preflight = deferred();
  const f = await appFixture(t, { initialize: () => preflight.promise, settleStartup: false });
  assert.equal(f.model.initializeCalls.length, 1);
  assert.equal(f.model.initializeCalls[0].provider, 'public');
  assert.equal(f.model.initializeCalls[0].baseUrl, PUBLIC_API_BASE);
  assert.equal(f.get('setup').open, false);
  assert.equal(f.microphoneRequests.length, 0);
  assert.equal(f.model.pending.length, 0);
  assert.equal(f.utterances.length, 0);
  assert.equal(f.get('send').disabled, true);
  preflight.resolve();
  await f.settle();
  assert.equal(f.voice.captureMode, 'recorder');
  assert.equal(f.get('send').disabled, false);
  await f.advance(300000);
  assert.equal(f.model.initializeCalls.length, 1);
  assert.equal(f.microphoneRequests.length, 0);
  assert.equal(f.model.pending.length, 0);
});

test('a failed preflight stays quiet and stable until an explicit retry', async (t) => {
  let fail = true;
  const f = await appFixture(t, { initialize: () => { if (fail) throw new Error('Service unavailable'); } });
  const initialStatus = f.get('status').textContent;
  assert.equal(f.model.initializeCalls.length, 1);
  assert.equal(f.get('setup').open, false);
  assert.equal(f.get('voice-toggle').disabled, true);
  assert.equal(f.get('retry-connection').disabled, false);
  await f.advance(300000);
  assert.equal(f.model.initializeCalls.length, 1);
  assert.equal(f.get('status').textContent, initialStatus);
  assert.equal(f.microphoneRequests.length, 0);
  assert.equal(f.model.pending.length, 0);
  fail = false;
  await f.get('retry-connection').click();
  assert.equal(f.model.initializeCalls.length, 2);
  assert.equal(f.get('voice-toggle').disabled, false);
  assert.equal(f.microphoneRequests.length, 0, 'retry connects the guide without opening audio');
  assert.equal(f.utterances.length, 0);
});

test('first Speak requests recorder permission in the click stack without waiting for opening TTS', async (t) => {
  const permission = deferred();
  const f = await appFixture(t, { recognition: true, getUserMedia: () => permission.promise });
  f.get('enter').click();
  assert.equal(f.microphoneRequests.length, 1, 'getUserMedia is called synchronously in the user gesture');
  assert.equal(f.voice.state, 'requesting');
  assert.equal(f.utterances.length, 0);
  assert.equal(f.nativeCaptures.length, 0, 'the configured recorder does not invoke browser recognition');
  assert.equal(f.get('spoken-text').textContent, 'Tell me why you are here.');
  f.get('enter').click();
  assert.equal(f.microphoneRequests.length, 1, 'a second tap cannot duplicate a permission request');
  permission.resolve(f.createStream());
  await f.settle();
  assert.equal(f.captures.length, 1);
  assert.equal(f.voice.state, 'listening');
  assert.equal(f.get('finish-capture').hidden, false);
});

test('recorder speech works without native SpeechRecognition and continues once after a completed reply', async (t) => {
  const f = await appFixture(t, { fetchImpl: async () => Response.json({ text: 'I want to make a plan.' }) });
  assert.equal(f.voice.recognitionSupported, true);
  f.enterVoice();
  await f.settle();
  assert.equal(f.nativeCaptures.length, 0);
  assert.equal(f.captures.length, 1);
  f.get('finish-capture').click();
  await f.settle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, `${PUBLIC_API_BASE}/api/nexus?op=transcribe`);
  assert.equal(f.requests[0].options.method, 'POST');
  assert.equal(f.requests[0].options.credentials, 'omit');
  assert.equal(f.requests[0].options.cache, 'no-store');
  assert.ok(f.requests[0].options.body instanceof Blob);
  assert.match(f.requests[0].options.headers['Content-Type'], /^audio\/webm/);
  assert.equal(f.streams[0].track.readyState, 'ended', 'recording tracks stop before inference');
  assert.equal(f.model.pending.length, 1);
  f.model.pending[0].resolve({ text: 'What is one step you can take today?' });
  await f.settle();
  assert.equal(f.utterances.length, 1);
  assert.equal(f.microphoneRequests.length, 1, 'the guide cannot record while its reply is speaking');
  f.utterances[0].onend();
  await f.settle();
  assert.equal(f.microphoneRequests.length, 2);
  assert.equal(f.captures.length, 2);
  assert.equal(f.voice.state, 'listening');
  f.pauseSession();
  await f.advance(300000);
  assert.equal(f.microphoneRequests.length, 2, 'Pause prevents all timer-driven reopening');
});

test('unsupported speech synthesis does not prevent the first recorder capture', async (t) => {
  const f = await appFixture(t, { synthesis: false });
  f.enterVoice();
  assert.equal(f.microphoneRequests.length, 1);
  await f.settle();
  assert.equal(f.voice.state, 'listening');
  assert.equal(f.utterances.length, 0);
});

test('unsupported recording offers writing without silently switching to native speech recognition', async (t) => {
  const f = await appFixture(t, { recorder: false, recognition: true });
  f.enterVoice();
  assert.equal(f.voice.recognitionSupported, false);
  assert.equal(f.microphoneRequests.length, 0);
  assert.equal(f.nativeCaptures.length, 0);
  assert.match(f.get('status').textContent, /write below/);
  assert.equal(f.get('voice-toggle').disabled, true);
});

test('microphone denial remains stable until the user explicitly chooses to resume', async (t) => {
  const f = await appFixture(t, {
    getUserMedia: ({ createStream, request }) => request === 1
      ? Promise.reject(Object.assign(new Error('Denied'), { name: 'NotAllowedError' }))
      : Promise.resolve(createStream()),
  });
  f.enterVoice();
  await f.settle();
  const deniedStatus = f.get('status').textContent;
  assert.match(deniedStatus, /permission was not granted/);
  assert.equal(f.voice.paused, true);
  assert.equal(f.get('finish-capture').hidden, true);
  await f.advance(300000);
  assert.equal(f.microphoneRequests.length, 1);
  assert.equal(f.get('status').textContent, deniedStatus);
  assert.equal(f.model.pending.length, 0);
  assert.equal(f.utterances.length, 0);
  f.get('voice-toggle').click();
  await f.settle();
  assert.equal(f.microphoneRequests.length, 2);
  assert.equal(f.voice.state, 'listening');
});

test('Pause while microphone permission is pending closes a late stream and never records it', async (t) => {
  const permission = deferred();
  const f = await appFixture(t, { getUserMedia: () => permission.promise });
  f.enterVoice();
  f.pauseSession();
  const pausedStatus = f.get('status').textContent;
  const stream = f.createStream();
  permission.resolve(stream);
  await f.settle();
  assert.equal(stream.track.readyState, 'ended');
  assert.equal(f.captures.length, 0);
  assert.equal(f.voice.paused, true);
  assert.equal(f.get('status').textContent, pausedStatus);
  await f.advance(300000);
  assert.equal(f.microphoneRequests.length, 1);
});

test('Pause aborts transcription and ignores a late transcript without inference or speech', async (t) => {
  const transcription = deferred();
  const f = await appFixture(t, { fetchImpl: () => transcription.promise });
  f.enterVoice(); await f.settle();
  f.get('finish-capture').click(); await f.settle();
  assert.equal(f.requests.length, 1);
  f.pauseSession();
  const pausedStatus = f.get('status').textContent;
  assert.equal(f.requests[0].options.signal.aborted, true);
  transcription.resolve(Response.json({ text: 'These late words must not start a new turn.' }));
  await f.settle();
  assert.equal(f.model.pending.length, 0);
  assert.equal(f.utterances.length, 0);
  assert.equal(f.microphoneRequests.length, 1);
  assert.equal(f.get('status').textContent, pausedStatus);
});

test('a typed turn after Pause receives a spoken reply without enabling the microphone', async (t) => {
  const f = await appFixture(t);
  f.pauseSession();
  const answering = f.submit('I want to make a plan.');
  assert.equal(f.voice.paused, false);
  f.model.pending[0].resolve({ text: 'What is one step you can take today?' });
  await f.settle();
  assert.equal(f.utterances.length, 1);
  f.utterances[0].onend();
  await answering;
  assert.equal(f.microphoneRequests.length, 0);
  assert.match(f.get('status').textContent, /Your turn/);
});

test('opening a dialog aborts the model turn and late tokens or completion cannot overwrite it', async (t) => {
  const f = await appFixture(t);
  const answering = f.submit('Help me explore my possibilities.');
  const pending = f.model.pending[0];
  f.openDialog('constellation');
  assert.equal(pending.signal.aborted, true);
  assert.equal(f.voice.paused, true);
  const pausedStatus = f.get('status').textContent;
  const pausedWords = f.get('spoken-text').textContent;
  pending.onToken('Late words', 'Late words');
  pending.resolve({ text: 'Late answer.' });
  await answering;
  assert.equal(f.get('status').textContent, pausedStatus);
  assert.equal(f.get('spoken-text').textContent, pausedWords);
  assert.equal(f.utterances.length, 0);
  assert.equal(f.microphoneRequests.length, 0);
});

test('backgrounding cancels an active answer and foregrounding never reopens audio', async (t) => {
  const f = await appFixture(t);
  const answering = f.submit('What should I examine?');
  f.hide();
  assert.equal(f.model.pending[0].signal.aborted, true);
  f.model.pending[0].resolve({ text: 'This reply arrived after leaving.' });
  await answering;
  assert.equal(f.voice.paused, true);
  assert.equal(f.utterances.length, 0);
  assert.equal(f.microphoneRequests.length, 0);
  assert.match(f.get('status').textContent, /page is away/);
  f.show(); await f.advance(300000);
  assert.equal(f.microphoneRequests.length, 0);
  assert.equal(f.model.initializeCalls.length, 1);
});

test('backgrounding an active recorder ends its tracks without submitting or reopening', async (t) => {
  const f = await appFixture(t);
  f.enterVoice(); await f.settle();
  f.hide(); await f.settle();
  assert.equal(f.streams[0].track.readyState, 'ended');
  assert.equal(f.voice.paused, true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.model.pending.length, 0);
  f.show(); await f.advance(300000);
  assert.equal(f.microphoneRequests.length, 1);
});

test('interrupted generation must drain before the microphone resumes and new words are preserved', async (t) => {
  const f = await appFixture(t);
  const answering = f.submit('An earlier thought.');
  f.pauseSession();
  f.enterVoice();
  assert.equal(f.microphoneRequests.length, 0);
  assert.match(f.get('status').textContent, /stopping/);
  await f.submit('Keep this new thought.', { fromVoice: true });
  assert.equal(f.get('intention').value, 'Keep this new thought.');
  f.model.pending[0].resolve({ text: 'Ignored earlier answer.' });
  await answering;
  f.enterVoice();
  assert.equal(f.microphoneRequests.length, 1);
  assert.equal(f.utterances.length, 0);
});

test('back-forward cache pagehide preserves a paused resumable model and permanent unload disposes it', async (t) => {
  const f = await appFixture(t);
  f.enterVoice(); await f.settle();
  f.pagehide(true);
  assert.equal(f.model.state, 'ready');
  assert.equal(f.voice.paused, true);
  assert.equal(f.streams[0].track.readyState, 'ended');
  await f.advance(300000);
  assert.equal(f.microphoneRequests.length, 1);
  f.enterVoice(); await f.settle();
  assert.equal(f.microphoneRequests.length, 2);
  assert.equal(f.voice.state, 'listening');
  f.pagehide(false);
  assert.equal(f.model.state, 'disposed');
  assert.equal(f.voice.resume(), false);
  assert.equal(f.streams[1].track.readyState, 'ended');
});
