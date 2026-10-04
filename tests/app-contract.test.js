import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { VoiceSession } from '../src/voice.js';
import { REGIONS, parseReply, visibleReply, localCommand, conversationContext } from '../src/meaning.js';

// Run the actual controller against narrow DOM/model/audio boundaries. These
// tests verify orchestration races; they do not represent hardware voice tests.
async function appFixture(t, { synthesis = true, location, fetchImpl, account = { id: 'account-one', label: 'First account' } } = {}) {
  const elements = new Map();
  class Element {
    constructor(id = '') {
      this.id = id; this.value = ''; this.textContent = ''; this.hidden = false;
      this.open = false; this.checked = id === 'spoken-replies'; this.disabled = false;
      this.dataset = {}; this.children = []; this.events = new Map(); this.selectedOptions = [];
      this.classList = { add() {} };
    }
    addEventListener(type, callback) { this.events.set(type, callback); }
    append(...children) {
      this.children.push(...children);
      if (this.id === 'chatgpt-model' && !this.value) this.value = this.children[0]?.value || '';
    }
    replaceChildren(...children) {
      this.children = children;
      if (this.id === 'chatgpt-model') this.value = children[0]?.value || '';
    }
    setAttribute() {}
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; queueMicrotask(() => this.events.get('close')?.({})); }
    querySelector() { return null; }
    click() { return this.events.get('click')?.({}); }
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const dialogIds = ['setup', 'settings', 'transcript', 'constellation', 'note-editor'];
  const documentEvents = new Map();
  const document = {
    visibilityState: 'visible', hidden: false, activeElement: null,
    getElementById: get,
    querySelector: (selector) => selector === 'dialog[open]' ? dialogIds.map(get).find((item) => item.open) : get(selector),
    querySelectorAll: () => dialogIds.map(get),
    createElement: () => new Element(),
    documentElement: { style: { setProperty() {} } },
    body: { classList: { add() {} } },
    addEventListener(type, callback) {
      if (!documentEvents.has(type)) documentEvents.set(type, new Set());
      documentEvents.get(type).add(callback);
    },
    removeEventListener(type, callback) { documentEvents.get(type)?.delete(callback); },
  };
  const windowEvents = new Map();
  const requests = [];
  const popup = { closed: false, location: { href: 'about:blank' }, close() { this.closed = true; } };
  const captures = [], utterances = [];
  class Recognition {
    constructor() { captures.push(this); }
    start() {}
    stop() {}
    abort() {}
  }
  const environment = {
    document, SpeechRecognition: Recognition,
    navigator: { language: 'en-US' }, isSecureContext: true,
    speechSynthesis: synthesis ? { speak: (item) => utterances.push(item), cancel() {}, getVoices: () => [] } : undefined,
    SpeechSynthesisUtterance: synthesis ? class { constructor(text) { this.text = text; } } : undefined,
  };
  let voice, model;
  class ControllerVoice extends VoiceSession {
    constructor(options) { super({ ...options, environment }); voice = this; }
  }
  class Model {
    constructor() { model = this; this.state = 'idle'; this.modelId = 'test-model'; this.active = null; this.pending = []; }
    async initialize({ provider, model: selectedModel } = {}) {
      this.provider = provider; this.account = provider === 'chatgpt' ? { ...account } : null;
      if (selectedModel) this.modelId = selectedModel;
      this.state = 'ready';
    }
    async reply(options) {
      this.active = options;
      try { return await new Promise((resolve, reject) => this.pending.push({ resolve, reject, ...options })); }
      finally { this.active = null; }
    }
    interrupt() {}
    dispose() { this.state = 'disposed'; }
  }
  const source = (await readFile(new URL('../src/app.js', import.meta.url), 'utf8')).replace(/^import .+;\s*$/gm, '');
  const sandbox = {
    document, window: {
      addEventListener: (name, callback) => windowEvents.set(name, callback),
      open: () => popup,
    },
    location: location ? new URL(location) : undefined,
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      if (!fetchImpl) throw new Error(`Unexpected request: ${url}`);
      return fetchImpl(url, options);
    },
    matchMedia: () => ({ matches: false }),
    createScene: () => ({ setMotion() {}, setRegion() {}, setListening() {}, setSpeaking() {}, setMemory() {}, dispose() {} }),
    VoiceSession: ControllerVoice, ConversationModel: Model,
    createConstellation: () => ({ getSnapshot: () => ({ nodes: [], mode: 'session' }) }),
    REGIONS, parseReply, visibleReply, localCommand, conversationContext,
    AbortController, AbortSignal, URL, Blob, setTimeout, clearTimeout, confirm: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nglobalThis.controller = {enterVoice,submit,pauseSession,loadModel,openDialog,checkChatGPT,connectChatGPT,disconnectChatGPT};', sandbox);
  t.after(() => voice.dispose());
  await sandbox.controller.loadModel('local');
  return {
    ...sandbox.controller, voice, model, captures, utterances, get, requests, popup,
    message(event) { windowEvents.get('message')?.(event); },
    hide() {
      document.hidden = true; document.visibilityState = 'hidden';
      for (const callback of documentEvents.get('visibilitychange') || []) callback({});
    },
    pagehide(persisted) { windowEvents.get('pagehide')?.({ persisted }); },
    async settle() { await new Promise((resolve) => setImmediate(resolve)); },
  };
}

test('first spoken entry finishes the invitation before opening the microphone', async (t) => {
  const f = await appFixture(t);
  const entering = f.enterVoice();
  assert.equal(f.captures.length, 0);
  assert.equal(f.utterances[0].text, 'Tell me why you are here.');
  f.utterances[0].onend();
  await entering;
  assert.equal(f.captures.length, 1);
  assert.equal(f.voice.state, 'requesting');
});

test('a typed turn after Pause can receive a spoken reply without enabling the microphone', async (t) => {
  const f = await appFixture(t);
  f.pauseSession();
  const answering = f.submit('I want to make a plan.');
  assert.equal(f.voice.paused, false);
  f.model.pending[0].resolve({ text: 'What is one step you can take today?' });
  await f.settle();
  assert.equal(f.utterances.length, 1);
  f.utterances[0].onend();
  await answering;
  assert.equal(f.captures.length, 0);
  assert.match(f.get('status').textContent, /Your turn/);
});

test('opening a dialog aborts the model turn and a late result cannot speak or overwrite status', async (t) => {
  const f = await appFixture(t);
  const answering = f.submit('Help me explore my possibilities.');
  const pending = f.model.pending[0];
  f.openDialog('constellation');
  assert.equal(pending.signal.aborted, true);
  assert.equal(f.voice.paused, true);
  const pausedStatus = f.get('status').textContent;
  pending.onToken('Late words', 'Late words');
  pending.resolve({ text: 'Late answer.' });
  await answering;
  assert.equal(f.get('status').textContent, pausedStatus);
  assert.equal(f.utterances.length, 0);
  assert.equal(f.captures.length, 0);
});

test('backgrounding cancels an active answer and late completion cannot reopen audio', async (t) => {
  const f = await appFixture(t);
  const answering = f.submit('What should I examine?');
  f.hide();
  f.model.pending[0].resolve({ text: 'This reply arrived after leaving.' });
  await answering;
  assert.equal(f.voice.paused, true);
  assert.equal(f.utterances.length, 0);
  assert.equal(f.captures.length, 0);
  assert.match(f.get('status').textContent, /page is away/);
});

test('entry can resume listening after an unavailable opening voice without repeating TTS forever', async (t) => {
  const f = await appFixture(t, { synthesis: false });
  await f.enterVoice();
  assert.equal(f.captures.length, 0);
  assert.match(f.get('status').textContent, /unavailable/);
  await f.enterVoice();
  assert.equal(f.captures.length, 1);
  assert.equal(f.voice.state, 'requesting');
});

test('interrupted model generation must finish draining before microphone resumes', async (t) => {
  const f = await appFixture(t);
  const answering = f.submit('An earlier thought.');
  f.pauseSession();
  await f.enterVoice();
  assert.equal(f.captures.length, 0);
  assert.match(f.get('status').textContent, /stopping/);
  await f.submit('Keep this new thought.', { fromVoice: true });
  assert.equal(f.get('intention').value, 'Keep this new thought.');
  f.model.pending[0].resolve({ text: 'Ignored earlier answer.' });
  await answering;
  await f.enterVoice();
  assert.equal(f.captures.length, 1);
});

test('back-forward cache pagehide preserves a resumable model and voice', async (t) => {
  const f = await appFixture(t);
  f.pagehide(true);
  assert.equal(f.model.state, 'ready');
  assert.equal(f.voice.paused, true);
  assert.equal(f.voice.resume(), true);
  f.pagehide(false);
  assert.equal(f.model.state, 'disposed');
  assert.equal(f.voice.resume(), false);
});

const planStatus = (extra = {}) => ({
  connected: true, sharing: true,
  account: { id: 'account-one', label: 'First account', selectedModel: 'available-model' },
  ...extra,
});
const planModels = { models: [{ slug: 'available-model', display_name: 'Available model' }] };

test('a disconnected, unshared, or changed ChatGPT account invalidates the active guide', async (t) => {
  for (const [label, changed] of [
    ['disconnected', planStatus({ connected: false, sharing: false, account: null })],
    ['sharing withdrawn', planStatus({ sharing: false })],
    ['account changed', planStatus({ account: { id: 'account-two', label: 'Other account' } })],
  ]) {
    await t.test(label, async (t) => {
      let current = planStatus();
      const f = await appFixture(t, {
        location: 'http://127.0.0.1:4173/',
        fetchImpl: async (url) => Response.json(String(url).endsWith('/status') ? current : planModels),
      });
      await f.checkChatGPT();
      await f.loadModel('chatgpt');
      assert.equal(f.get('voice-toggle').disabled, false);
      assert.equal(f.get('plan-indicator').hidden, false);
      const answering = f.submit('Keep following this thought.');
      const pending = f.model.pending[0];
      current = changed;
      await f.checkChatGPT();
      assert.equal(pending.signal.aborted, true, 'the previous account must lose ownership of its active answer');
      assert.equal(f.get('voice-toggle').disabled, true);
      assert.equal(f.get('plan-indicator').hidden, true);
      assert.match(f.get('runtime-status').textContent, /current ChatGPT account/);
      pending.resolve({ text: 'A late reply from the previous account.' });
      await answering;
      assert.equal(f.utterances.length, 0);
      assert.equal(f.captures.length, 0);
    });
  }
});

test('failed ChatGPT connection checks cannot reenable an old model catalog', async (t) => {
  let fail = false;
  const f = await appFixture(t, {
    location: 'http://127.0.0.1:4173/',
    fetchImpl: async (url) => {
      if (fail) throw new Error('Connection unavailable');
      return Response.json(String(url).endsWith('/status') ? planStatus() : planModels);
    },
  });
  await f.checkChatGPT();
  assert.equal(f.get('use-chatgpt').disabled, false);
  assert.equal(f.get('chatgpt-model').value, 'available-model');
  fail = true;
  await f.checkChatGPT();
  assert.equal(f.get('chatgpt-model').children.length, 0);
  assert.equal(f.get('chatgpt-model').value, '');
  assert.equal(f.get('use-chatgpt').disabled, true, 'finally must not reenable a stale model selection');
  assert.match(f.get('chatgpt-status').textContent, /Connection unavailable/);
});

test('a late catalog response cannot override a newer disconnected account state', async (t) => {
  let statusCount = 0, resolveCatalog;
  const f = await appFixture(t, {
    location: 'http://127.0.0.1:4173/',
    fetchImpl: (url) => {
      if (String(url).endsWith('/status')) {
        statusCount += 1;
        return Promise.resolve(Response.json(statusCount === 1 ? planStatus() : planStatus({ connected: false, sharing: false, account: null })));
      }
      return new Promise((resolve) => { resolveCatalog = resolve; });
    },
  });
  const earlier = f.checkChatGPT();
  await f.settle();
  assert.equal(typeof resolveCatalog, 'function');
  await f.checkChatGPT();
  const latestStatus = f.get('chatgpt-status').textContent;
  resolveCatalog(Response.json(planModels));
  await earlier;
  assert.equal(f.get('chatgpt-status').textContent, latestStatus);
  assert.equal(f.get('chatgpt-model').children.length, 0);
  assert.equal(f.get('use-chatgpt').disabled, true);
  assert.equal(f.get('use-chatgpt').hidden, true);
});

test('OAuth return messages require the expected popup, app origin, and message type', async (t) => {
  const origin = 'http://127.0.0.1:4173';
  const f = await appFixture(t, {
    location: `${origin}/`,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/auth/start')) return Response.json({ url: 'https://auth.openai.com/api/accounts/authorize?state=fixture' });
      return Response.json(String(url).endsWith('/status') ? planStatus() : planModels);
    },
  });
  await f.connectChatGPT();
  assert.match(f.popup.location.href, /^https:\/\/auth\.openai\.com\/api\/accounts\/authorize/);
  const before = f.requests.length;
  const good = { origin, source: f.popup, data: { type: 'dream-unity-chatgpt-return', result: 'connected' } };
  f.message({ ...good, origin: 'https://unrelated.example' });
  f.message({ ...good, source: {} });
  f.message({ ...good, data: { type: 'unrelated-message', result: 'connected' } });
  await f.settle();
  assert.equal(f.requests.length, before, 'untrusted messages cannot refresh or confirm account access');
  f.message(good);
  await f.settle();
  assert.equal(f.requests.length, before + 2, 'the genuine popup refreshes status and the account catalog');
  assert.equal(f.get('chatgpt-model').value, 'available-model');
  assert.equal(f.get('chatgpt-confirmation').hidden, false);
});
