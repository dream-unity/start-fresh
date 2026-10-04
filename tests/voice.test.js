import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession } from '../src/voice.js';

// These deterministic service doubles test lifecycle logic, not real microphone
// access, browser vendor transcription, OS voices, or audio quality.
function fixture({ recognition = true, synthesis = true, ...options } = {}) {
  const captures = [];
  const utterances = [];
  const timers = new Map();
  const listeners = new Map();
  const states = [];
  const transcripts = [];
  const interims = [];
  const errors = [];
  const unsupported = [];
  let timerId = 0;
  let cancels = 0;
  class Recognition {
    constructor() { captures.push(this); this.starts = 0; this.stops = 0; this.aborts = 0; }
    start() { this.starts += 1; }
    stop() { this.stops += 1; }
    abort() { this.aborts += 1; }
    startEvent() { this.onstart?.({}); }
    endEvent() { this.onend?.({}); }
    result(parts) {
      const results = parts.map(([text, final]) => Object.assign([{ transcript: text }], { isFinal: final }));
      this.onresult?.({ resultIndex: 0, results });
    }
  }
  class Utterance { constructor(text) { this.text = text; } }
  const document = {
    visibilityState: 'visible',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  const environment = {
    SpeechRecognition: recognition ? Recognition : undefined,
    speechSynthesis: synthesis ? {
      speak(utterance) { utterances.push(utterance); },
      cancel() { cancels += 1; },
      getVoices() { return [{ name: 'Test voice', lang: 'en-US', localService: true }]; },
    } : undefined,
    SpeechSynthesisUtterance: synthesis ? Utterance : undefined,
    document,
    navigator: { language: 'en-US' },
    isSecureContext: true,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const voice = new VoiceSession({
    environment,
    onState: (state, detail) => states.push({ state, ...detail }),
    onTranscript: (text) => transcripts.push(text),
    onInterim: (text) => interims.push(text),
    onError: (error) => errors.push(error),
    onUnsupported: (detail) => unsupported.push(detail),
    ...options,
  });
  return {
    voice, environment, captures, utterances, timers, states, transcripts, interims, errors, unsupported,
    get cancels() { return cancels; },
    hide() { document.visibilityState = 'hidden'; listeners.get('visibilitychange')?.(); },
    show() { document.visibilityState = 'visible'; listeners.get('visibilitychange')?.(); },
    runTimer(delay) {
      const [id, timer] = [...timers.entries()].find(([, value]) => value.delay === delay) || [];
      assert.ok(timer, `expected ${delay} ms timer`);
      timers.delete(id);
      timer.fn();
    },
    listeners,
  };
}

test('initialization does not request capture, speak, or schedule a retry', () => {
  const f = fixture();
  assert.equal(f.voice.state, 'idle');
  assert.equal(f.voice.supported, true);
  assert.equal(f.captures.length, 0);
  assert.equal(f.utterances.length, 0);
  assert.equal(f.timers.size, 0);
});

test('activation starts one capture and double taps do not create a second', async () => {
  const f = fixture();
  assert.equal(await f.voice.activate(), true);
  assert.equal(await f.voice.activate(), true);
  assert.equal(f.captures.length, 1);
  assert.equal(f.voice.state, 'requesting');
  f.captures[0].startEvent();
  assert.equal(f.voice.state, 'listening');
  assert.equal(f.captures[0].continuous, false);
});

test('duplicate result snapshots submit one finalized transcript only after service end', async () => {
  const f = fixture();
  await f.voice.activate();
  const mic = f.captures[0];
  mic.startEvent();
  mic.result([['I want', false]]);
  mic.result([['I want to create', false]]);
  mic.result([['I want to create.', true]]);
  mic.result([['I want to create.', true]]);
  assert.deepEqual(f.transcripts, []);
  assert.equal(mic.stops, 1);
  mic.endEvent();
  mic.endEvent();
  assert.deepEqual(f.transcripts, ['I want to create.']);
  assert.equal(f.voice.state, 'thinking');
  assert.equal(f.captures.length, 1);
  assert.equal(f.timers.size, 0);
});

test('repeated real words at different result indices are preserved', async () => {
  const f = fixture();
  await f.voice.activate();
  f.captures[0].result([['yes', true], ['yes', true]]);
  f.captures[0].endEvent();
  assert.deepEqual(f.transcripts, ['yes yes']);
});

test('an empty natural end pauses until explicit Resume instead of looping', async () => {
  const f = fixture();
  await f.voice.activate();
  f.captures[0].startEvent();
  f.captures[0].endEvent();
  assert.equal(f.voice.state, 'paused');
  assert.equal(f.voice.startListening(), false);
  assert.equal(f.captures.length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.voice.resume(), true);
  assert.equal(f.captures.length, 2);
});

test('unfinished interim results are retained for editing and never auto-submitted', async () => {
  const f = fixture();
  await f.voice.activate();
  f.captures[0].result([['unfinished intention', false]]);
  f.captures[0].endEvent();
  assert.equal(f.voice.state, 'paused');
  assert.equal(f.states.at(-1).reason, 'incomplete-transcript');
  assert.deepEqual(f.transcripts, []);
  assert.equal(f.interims.at(-1), 'unfinished intention');
});

test('permission rejection survives late end/start/results and has no automatic retry', async () => {
  const f = fixture();
  await f.voice.activate();
  const mic = f.captures[0];
  const staleStart = mic.onstart;
  const staleEnd = mic.onend;
  const staleResult = mic.onresult;
  mic.onerror({ error: 'not-allowed' });
  staleStart(); staleEnd(); staleResult({ results: [] });
  assert.equal(f.voice.state, 'error');
  assert.equal(f.errors[0].code, 'not-allowed');
  assert.equal(f.voice.startListening(), false);
  assert.equal(f.captures.length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(mic.aborts, 1);
});

test('Pause invalidates recognizer callbacks and prevents a late AI reply speaking', async () => {
  const f = fixture();
  await f.voice.activate();
  const end = f.captures[0].onend;
  f.captures[0].result([['hello', true]]);
  f.voice.pause(); end();
  assert.deepEqual(f.transcripts, []);
  assert.equal(f.voice.setThinking(), false);
  assert.deepEqual(await f.voice.speak('Late answer'), { status: 'cancelled' });
  assert.equal(f.utterances.length, 0);
  assert.equal(f.voice.state, 'paused');
});

test('speaking aborts capture first and does not auto-restart it after finishing', async () => {
  const f = fixture();
  await f.voice.activate();
  const answer = f.voice.speak('What matters to you?');
  assert.equal(f.captures[0].aborts, 1);
  assert.equal(f.voice.state, 'speaking');
  f.utterances[0].onstart();
  f.utterances[0].onend();
  assert.deepEqual(await answer, { status: 'spoken' });
  assert.equal(f.voice.state, 'idle');
  assert.equal(f.captures.length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.voice.startListening(), true);
  assert.equal(f.captures.length, 2);
});

test('starting an explicit new listening turn cancels spoken output', async () => {
  const f = fixture();
  const answer = f.voice.speak('An answer still speaking.');
  assert.equal(f.voice.startListening(), true);
  assert.deepEqual(await answer, { status: 'cancelled' });
  assert.equal(f.cancels, 1);
  assert.equal(f.voice.state, 'requesting');
});

test('Pause during synthesis cancels the promise and ignores late end callbacks', async () => {
  const f = fixture();
  const answer = f.voice.speak('First sentence. Second sentence.');
  const staleEnd = f.utterances[0].onend;
  f.voice.pause(); staleEnd();
  assert.deepEqual(await answer, { status: 'cancelled' });
  assert.equal(f.voice.state, 'paused');
  assert.equal(f.utterances.length, 1);
  assert.equal(f.cancels, 1);
  assert.equal(f.timers.size, 0);
});

test('an AbortSignal cancels synthesis promptly without starting capture', async () => {
  const f = fixture();
  const controller = new AbortController();
  const answer = f.voice.speak('An answer.', { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await answer, { status: 'cancelled' });
  assert.equal(f.voice.state, 'idle');
  assert.equal(f.captures.length, 0);
  assert.equal(f.timers.size, 0);
});

test('a hidden document pauses capture and showing it does not restart', async () => {
  const f = fixture();
  await f.voice.activate();
  f.captures[0].startEvent();
  f.hide();
  assert.equal(f.voice.state, 'paused');
  assert.equal(f.states.at(-1).reason, 'hidden');
  f.show();
  assert.equal(f.captures.length, 1);
  assert.equal(f.voice.startListening(), false);
});

test('a hidden document cancels spoken output and blocks new spoken output', async () => {
  const f = fixture();
  const answer = f.voice.speak('A response.');
  f.hide();
  assert.deepEqual(await answer, { status: 'cancelled' });
  assert.deepEqual(await f.voice.speak('A late response.'), { status: 'cancelled' });
  assert.equal(f.utterances.length, 1);
});

test('recognition startup, turn and end stalls all stop with bounded errors', async (t) => {
  for (const [phase, delay, code] of [['start', 12000, 'start-timeout'], ['turn', 90000, 'turn-timeout'], ['end', 3000, 'end-timeout']]) {
    await t.test(phase, async () => {
      const f = fixture();
      await f.voice.activate();
      if (phase !== 'start') f.captures[0].startEvent();
      if (phase === 'end') f.captures[0].result([['hello', true]]);
      f.runTimer(delay);
      assert.equal(f.errors[0].code, code);
      assert.equal(f.voice.state, 'error');
      assert.equal(f.voice.startListening(), false);
      assert.equal(f.timers.size, 0);
      assert.deepEqual(f.transcripts, []);
    });
  }
});

test('stalled synthesis cancels and requires explicit Resume', async () => {
  const f = fixture();
  const answer = f.voice.speak('No end event arrives.');
  f.runTimer(12000);
  assert.deepEqual(await answer, { status: 'error', error: 'speech-timeout' });
  assert.equal(f.voice.state, 'error');
  assert.equal(f.cancels, 1);
  assert.equal(f.voice.startListening(), false);
  assert.equal(f.timers.size, 0);
});

test('synthesis chunks long output and settles only after the last chunk', async () => {
  const f = fixture();
  const text = 'A possibility is worth exploring. '.repeat(20).trim();
  const answer = f.voice.speak(text);
  let index = 0;
  while (f.voice.state === 'speaking') {
    const utterance = f.utterances[index++];
    assert.ok(utterance.text.length <= 220);
    utterance.onend();
  }
  assert.equal(index, 20);
  assert.equal(f.utterances.map((utterance) => utterance.text).join(' '), text);
  assert.deepEqual(await answer, { status: 'spoken' });
});

test('missing recognition or insecure context remains usable as text without retries', async (t) => {
  for (const kind of ['missing', 'insecure']) {
    await t.test(kind, async () => {
      const f = fixture({ recognition: kind !== 'missing' });
      if (kind === 'insecure') f.environment.isSecureContext = false;
      assert.equal(await f.voice.activate(), false);
      assert.equal(f.voice.state, 'unsupported');
      assert.equal(f.unsupported[0].code, 'recognition-unsupported');
      assert.equal(f.captures.length, 0);
    });
  }
});

test('missing synthesis returns an honest status and leaves transcript to the application', async () => {
  const f = fixture({ synthesis: false });
  assert.deepEqual(await f.voice.speak('Text reply'), { status: 'unsupported' });
  assert.equal(f.unsupported[0].code, 'synthesis-unsupported');
  assert.equal(f.voice.state, 'idle');
});

test('dispose closes resources and cannot be reactivated', async () => {
  const f = fixture();
  await f.voice.activate();
  f.voice.dispose();
  assert.equal(f.captures[0].aborts, 1);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(await f.voice.activate(), false);
  assert.equal(f.voice.resume(), false);
  assert.deepEqual(await f.voice.speak('Hello'), { status: 'cancelled' });
});

test('a synchronous Pause during a requesting callback prevents opening capture', async () => {
  const f = fixture({ onState: (state) => { if (state === 'requesting') f.voice.pause(); } });
  assert.equal(await f.voice.activate(), false);
  assert.equal(f.captures[0].starts, 0);
  assert.equal(f.voice.state, 'paused');
  assert.equal(f.timers.size, 0);
});

test('a synchronous Pause during listening cannot leave a hidden timeout', async () => {
  const f = fixture({ onState: (state) => { if (state === 'listening') f.voice.pause(); } });
  await f.voice.activate();
  f.captures[0].startEvent();
  assert.equal(f.voice.state, 'paused');
  assert.equal(f.timers.size, 0);
});

test('a synchronous Pause while finalizing cannot be overwritten by thinking', async () => {
  const f = fixture({ onInterim: (text) => { if (!text) f.voice.pause(); } });
  await f.voice.activate();
  f.captures[0].result([['Wait', true]]);
  f.captures[0].endEvent();
  assert.equal(f.voice.state, 'paused');
  assert.deepEqual(f.transcripts, []);
});

test('explicit beginReply allows a typed response after Pause without opening capture', async () => {
  const f = fixture();
  f.voice.pause();
  assert.equal(f.voice.setThinking(), false);
  assert.equal(f.voice.beginReply(), true);
  assert.equal(f.voice.paused, false);
  assert.equal(f.voice.state, 'thinking');
  assert.equal(f.captures.length, 0);
  const response = f.voice.speak('A reply to your written intention.');
  f.utterances[0].onend();
  assert.deepEqual(await response, { status: 'spoken' });
  assert.equal(f.captures.length, 0);
});

test('explicit beginReply stops previous audio and stale capture events', async () => {
  const f = fixture();
  await f.voice.activate();
  const staleEnd = f.captures[0].onend;
  f.captures[0].result([['Old intention', true]]);
  assert.equal(f.voice.beginReply(), true);
  staleEnd();
  assert.deepEqual(f.transcripts, []);
  const response = f.voice.speak('Old reply.');
  assert.equal(f.voice.beginReply(), true);
  assert.deepEqual(await response, { status: 'cancelled' });
  assert.equal(f.voice.state, 'thinking');
});

test('beginReply cannot override backgrounding or disposal', () => {
  const f = fixture();
  f.hide();
  assert.equal(f.voice.beginReply(), false);
  assert.equal(f.voice.state, 'paused');
  f.show();
  f.voice.dispose();
  assert.equal(f.voice.beginReply(), false);
});
