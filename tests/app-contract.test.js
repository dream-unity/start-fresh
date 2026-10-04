import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { VoiceSession } from '../src/voice.js';
import { REGIONS, parseReply, visibleReply, localCommand, conversationContext } from '../src/meaning.js';

// Run the actual controller against narrow DOM/model/audio boundaries. These
// tests verify orchestration races; they do not represent hardware voice tests.
async function appFixture(t, { synthesis = true } = {}) {
  const elements = new Map();
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
    async initialize() { this.state = 'ready'; }
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
    document, window: { addEventListener: (name, callback) => windowEvents.set(name, callback) },
    matchMedia: () => ({ matches: false }),
    createScene: () => ({ setMotion() {}, setRegion() {}, setListening() {}, setSpeaking() {}, setMemory() {}, dispose() {} }),
    VoiceSession: ControllerVoice, ConversationModel: Model,
    createConstellation: () => ({ getSnapshot: () => ({ nodes: [], mode: 'session' }) }),
    REGIONS, parseReply, visibleReply, localCommand, conversationContext,
    AbortController, URL, Blob, setTimeout, clearTimeout, confirm: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nglobalThis.controller = {enterVoice,submit,pauseSession,loadModel,openDialog};', sandbox);
  t.after(() => voice.dispose());
  await sandbox.controller.loadModel('local');
  return {
    ...sandbox.controller, voice, model, captures, utterances, get,
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
