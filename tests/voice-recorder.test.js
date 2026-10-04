import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession } from '../src/voice.js';

// Capture/service doubles verify cancellation and ordering, not physical audio.
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture({ meter = false, permission, transcribe, ...options } = {}) {
  const states = []; const errors = []; const transcripts = []; const uploads = [];
  const recorders = []; const streams = []; const contexts = []; const spoken = [];
  const timers = new Map(); const listeners = new Map();
  let now = 0; let timerId = 0; let requests = 0; let nativeStarts = 0; let amplitude = 0;
  const makeStream = () => {
    const trackListeners = new Map();
    const track = {
      readyState: 'live', stops: 0,
      stop() { this.readyState = 'ended'; this.stops += 1; },
      addEventListener(type, fn) { trackListeners.set(type, fn); },
      removeEventListener(type) { trackListeners.delete(type); },
      end() { this.readyState = 'ended'; trackListeners.get('ended')?.(); },
    };
    const stream = { track, getTracks: () => [track], getAudioTracks: () => [track] };
    streams.push(stream); return stream;
  };
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(stream, options) { this.stream = stream; this.mimeType = options.mimeType; this.state = 'inactive'; this.stops = 0; recorders.push(this); }
    start() { this.state = 'recording'; this.onstart?.(); }
    stop() { this.state = 'inactive'; this.stops += 1; }
    data(text = 'audio') { this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) }); }
    finish() { this.data(); this.onstop?.(); }
  }
  class Context {
    constructor() { this.state = 'running'; this.closed = 0; contexts.push(this); }
    resume() { return Promise.resolve(); }
    close() { this.closed += 1; this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData(array) { array.fill(amplitude); }, disconnect() {} }; }
  }
  const environment = {
    MediaRecorder: Recorder, Blob,
    AudioContext: meter ? Context : undefined,
    SpeechRecognition: class { start() { nativeStarts += 1; } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: { speak(value) { spoken.push(value); }, cancel() {}, getVoices: () => [] },
    navigator: { language: 'en-US', mediaDevices: { getUserMedia() { requests += 1; return permission ? permission.promise : Promise.resolve(makeStream()); } } },
    isSecureContext: true,
    performance: { now: () => now },
    document: { visibilityState: 'visible', addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const voice = new VoiceSession({
    environment, onState: (state, detail) => states.push({ state, ...detail }),
    onError: (error) => errors.push(error), onUnsupported: (error) => errors.push(error),
    onTranscript: (text) => transcripts.push(text), ...options,
  });
  voice.configureTranscription({ transcribe: async (blob, { signal }) => { uploads.push({ blob, signal }); return transcribe ? transcribe(blob, { signal }) : '  My   intention. '; } });
  return {
    voice, environment, recorders, streams, contexts, spoken, states, errors, transcripts, uploads, timers, makeStream,
    get requests() { return requests; }, get nativeStarts() { return nativeStarts; },
    set amplitude(value) { amplitude = value; },
    hide() { environment.document.visibilityState = 'hidden'; listeners.get('visibilitychange')?.(); },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > target) break;
        now = next[1].due; timers.delete(next[0]); next[1].fn();
      }
      now = target;
    },
  };
}

test('configured recorder is preferred; initial permission requires explicit activation', async () => {
  const f = fixture();
  assert.equal(f.voice.captureMode, 'recorder');
  assert.equal(f.voice.recognitionSupported, true);
  assert.equal(f.requests, 0);
  f.voice.beginReply();
  assert.equal(f.voice.startListening(), false);
  assert.equal(f.requests, 0);
  assert.equal(f.errors[0].code, 'microphone-needs-gesture');
  assert.equal(await f.voice.activate(), true);
  await flush();
  assert.equal(f.voice.capturing, true);
  assert.equal(f.nativeStarts, 0);
  await f.voice.activate();
  assert.equal(f.requests, 1);
  f.voice.dispose();
});

test('Finish sends one bounded blob after tracks stop and returns one cleaned transcript', async () => {
  const f = fixture();
  await f.voice.activate(); await flush();
  const recorder = f.recorders[0]; recorder.data('first chunk');
  assert.equal(f.voice.finishCapture(), true);
  assert.equal(f.voice.finishCapture(), false);
  assert.equal(f.streams[0].track.readyState, 'ended');
  assert.equal(f.voice.state, 'thinking');
  const end = recorder.onstop;
  recorder.finish(); end();
  await flush();
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].blob.type, 'audio/webm;codecs=opus');
  assert.equal(await f.uploads[0].blob.text(), 'first chunkaudio');
  assert.deepEqual(f.transcripts, ['My intention.']);
  assert.equal(f.timers.size, 0);
  assert.equal(f.requests, 1);
});

test('pause while permission is pending closes a late stream without recording', async () => {
  const permission = deferred(); const f = fixture({ permission, meter: true });
  await f.voice.activate();
  f.voice.pause();
  const stream = f.makeStream(); permission.resolve(stream); await flush();
  assert.equal(stream.track.readyState, 'ended');
  assert.equal(f.recorders.length, 0);
  assert.equal(f.contexts[0].closed, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.voice.state, 'paused');
});

test('permission denial never triggers native recognition or automatic retries', async () => {
  const permission = deferred(); const f = fixture({ permission });
  await f.voice.activate(); permission.reject(Object.assign(new Error(), { name: 'NotAllowedError' })); await flush();
  assert.equal(f.errors[0].code, 'not-allowed');
  assert.equal(f.voice.startListening(), false);
  f.advance(120000);
  assert.equal(f.requests, 1);
  assert.equal(f.nativeStarts, 0);
  assert.equal(f.timers.size, 0);
});

test('pause aborts upload; a late service answer cannot submit or restart capture', async () => {
  const answer = deferred(); const f = fixture({ transcribe: () => answer.promise });
  await f.voice.activate(); await flush();
  f.voice.finishCapture(); f.recorders[0].finish(); await flush();
  f.voice.pause();
  assert.equal(f.uploads[0].signal.aborted, true);
  answer.resolve('A stale intention'); await flush();
  assert.deepEqual(f.transcripts, []);
  assert.equal(f.voice.state, 'paused');
  assert.equal(f.requests, 1);
  assert.equal(f.timers.size, 0);
});

test('typed reply, speech, hidden page, and disposal all cancel recording without upload', async (t) => {
  for (const action of ['beginReply', 'speak', 'hide', 'dispose']) await t.test(action, async () => {
    const f = fixture({ meter: true });
    await f.voice.activate(); await flush();
    const recorder = f.recorders[0]; const oldEnd = recorder.onstop; const oldData = recorder.ondataavailable;
    let reply;
    if (action === 'hide') f.hide();
    else if (action === 'speak') reply = f.voice.speak('A reply');
    else f.voice[action]();
    oldData({ data: new Blob(['late']) }); oldEnd(); await flush();
    assert.equal(f.streams[0].track.readyState, 'ended');
    assert.equal(f.contexts[0].closed, 1);
    assert.equal(recorder.stops, 1);
    assert.deepEqual(f.uploads, []);
    if (reply) { f.spoken[0].onend(); await reply; }
    assert.equal(f.timers.size, 0);
  });
});

test('45-second capture limit finishes once even without AudioContext', async () => {
  const f = fixture(); await f.voice.activate(); await flush();
  f.advance(45000);
  assert.equal(f.recorders[0].stops, 1);
  assert.equal(f.streams[0].track.readyState, 'ended');
  f.recorders[0].finish(); await flush();
  assert.deepEqual(f.transcripts, ['My intention.']);
  assert.equal(f.requests, 1);
});

test('meter ends a spoken turn after two seconds of silence without reopening capture', async () => {
  const f = fixture({ meter: true }); await f.voice.activate(); await flush();
  f.amplitude = 0.04; f.advance(500);
  f.amplitude = 0; f.advance(1900);
  assert.equal(f.voice.capturing, true);
  f.advance(100);
  assert.equal(f.voice.capturing, false);
  assert.equal(f.recorders[0].stops, 1);
  assert.equal(f.contexts[0].closed, 1);
  f.recorders[0].finish(); await flush();
  assert.equal(f.transcripts.length, 1);
  assert.equal(f.requests, 1);
});

test('ten seconds without detected speech stops capture without uploading silent audio', async () => {
  const f = fixture({ meter: true }); await f.voice.activate(); await flush();
  f.advance(10000);
  assert.equal(f.voice.state, 'paused');
  assert.equal(f.errors[0].code, 'no-speech');
  assert.equal(f.streams[0].track.readyState, 'ended');
  assert.equal(f.uploads.length, 0);
  assert.equal(f.timers.size, 0);
});

test('suspended audio meter preserves explicit Finish instead of falsely detecting silence', async () => {
  const f = fixture({ meter: true }); await f.voice.activate(); await flush();
  f.contexts[0].state = 'suspended'; f.advance(11000);
  assert.equal(f.voice.capturing, true);
  assert.equal(f.voice.finishCapture(), true);
  f.recorders[0].finish(); await flush();
  assert.equal(f.transcripts.length, 1);
  assert.equal(f.timers.size, 0);
});

test('startup, recorder stop, and transcription stalls each have bounded cleanup', async (t) => {
  for (const phase of ['permission', 'stop', 'transcription']) await t.test(phase, async () => {
    const permission = phase === 'permission' ? deferred() : undefined;
    const f = fixture({ permission, transcribe: () => new Promise(() => {}) });
    await f.voice.activate(); await flush();
    if (phase !== 'permission') f.voice.finishCapture();
    if (phase === 'transcription') f.recorders[0].finish();
    await flush(); f.advance(phase === 'permission' ? 12000 : phase === 'stop' ? 3000 : 45000);
    assert.equal(f.voice.state, 'error');
    assert.equal(f.voice.startListening(), false);
    assert.equal(f.timers.size, 0);
    if (phase === 'transcription') assert.equal(f.uploads[0].signal.aborted, true);
    assert.equal(f.requests, 1);
  });
});

test('transcription rejection or malformed response pauses without leaking service error text', async (t) => {
  for (const result of ['reject', 'malformed', 'empty']) await t.test(result, async () => {
    const f = fixture({ transcribe: async () => { if (result === 'reject') throw new Error('secret server details'); return result === 'empty' ? '' : {}; } });
    await f.voice.activate(); await flush(); f.voice.finishCapture(); f.recorders[0].finish(); await flush();
    assert.deepEqual(f.transcripts, []);
    assert.equal(f.voice.paused, true);
    assert.equal(f.voice.startListening(), false);
    assert.equal(JSON.stringify(f.errors).includes('secret'), false);
    assert.equal(f.timers.size, 0);
  });
});

test('unexpected device loss and oversized recording close all resources', async (t) => {
  for (const kind of ['device', 'size']) await t.test(kind, async () => {
    const f = fixture({ meter: true }); await f.voice.activate(); await flush();
    if (kind === 'device') f.streams[0].track.end();
    else f.recorders[0].ondataavailable({ data: new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]) });
    assert.equal(f.voice.state, 'error');
    assert.equal(f.streams[0].track.readyState, 'ended');
    assert.equal(f.contexts[0].closed, 1);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.timers.size, 0);
  });
});

test('a synchronous UI Pause during requesting or listening prevents later capture work', async (t) => {
  for (const phase of ['requesting', 'listening']) await t.test(phase, async () => {
    const f = fixture({ onState: (state) => { if (state === phase) f.voice.pause(); } });
    await f.voice.activate(); await flush();
    assert.equal(f.voice.state, 'paused');
    assert.equal(f.timers.size, 0);
    assert.equal(f.uploads.length, 0);
    if (phase === 'requesting') assert.equal(f.requests, 0);
    else assert.equal(f.streams[0].track.readyState, 'ended');
  });
});

test('missing recorder reports recording support honestly and does not silently switch providers', async () => {
  const f = fixture(); f.environment.MediaRecorder = undefined;
  assert.equal(f.voice.recognitionSupported, false);
  assert.equal(await f.voice.activate(), false);
  assert.match(f.errors[0].message, /cannot record microphone audio/);
  assert.equal(f.nativeStarts, 0);
  f.voice.configureTranscription();
  assert.equal(f.voice.captureMode, 'recognition');
  assert.equal(f.voice.recognitionSupported, true);
});
