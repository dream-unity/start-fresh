/**
 * One recognition turn → one spoken reply. Only the application can request the
 * next turn; browser end/error events never reopen the microphone themselves.
 *
 * Browser recognition may send audio to the browser vendor. When configured,
 * the recorder sends one audio turn to the application's transcription service.
 * Neither path promises offline recognition or persists recordings here.
 */
const noop = () => {};
const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

const RECOGNITION_ERRORS = {
  'not-allowed': 'Microphone permission was not granted. Allow it in your browser, then choose Resume.',
  'service-not-allowed': 'Your browser has blocked its speech service. You can continue by writing.',
  'audio-capture': 'The microphone could not be opened. Check the selected input and choose Resume.',
  network: 'Your browser could not reach its speech service. Check your connection, or continue by writing.',
  'no-speech': 'No speech was heard. Choose Resume when you are ready.',
  aborted: 'Listening stopped. Choose Resume when you are ready.',
  'language-not-supported': 'Your browser cannot recognise the selected language. You can continue by writing.',
  'start-timeout': 'The microphone did not start. Check browser permissions and choose Resume.',
  'end-timeout': 'The speech service did not finish this turn. Choose Resume, or continue by writing.',
  'turn-timeout': 'Listening paused after a long turn. Choose Resume when you are ready.',
  'recording-failed': 'Audio recording stopped unexpectedly. Choose Resume, or continue by writing.',
  'recording-too-large': 'This recording reached the size limit. Choose Resume and try a shorter turn.',
  'transcription-failed': 'Your recording could not be transcribed. Choose Resume to try again, or continue by writing.',
  'transcription-timeout': 'Transcription took too long. Choose Resume to try again, or continue by writing.',
};

function speechChunks(text) {
  // Short utterances avoid browser engines stalling on a single long response.
  const sentences = text.match(/[^.!?]+[.!?]*(?:\s+|$)/g) || [text];
  const chunks = [];
  for (const sentence of sentences) {
    let remainder = sentence.trim();
    while (remainder.length > 220) {
      const boundary = remainder.lastIndexOf(' ', 220);
      const cut = boundary > 80 ? boundary : 220;
      chunks.push(remainder.slice(0, cut));
      remainder = remainder.slice(cut).trim();
    }
    if (remainder) chunks.push(remainder);
  }
  return chunks;
}

export class VoiceSession {
  constructor({
    onState = noop, onTranscript = noop, onInterim = noop,
    onError = noop, onUnsupported = noop,
    environment = globalThis, language,
    startTimeout = 12000, turnTimeout = 90000, endTimeout = 3000,
    speechTimeout = 120000, captureTimeout = 45000, transcriptionTimeout = 45000,
  } = {}) {
    this._env = environment;
    this._Recognition = environment.SpeechRecognition || environment.webkitSpeechRecognition;
    this._synthesis = environment.speechSynthesis;
    this._Utterance = environment.SpeechSynthesisUtterance;
    this._document = environment.document;
    this._setTimeout = environment.setTimeout?.bind(environment) || globalThis.setTimeout;
    this._clearTimeout = environment.clearTimeout?.bind(environment) || globalThis.clearTimeout;
    this._callbacks = { onState, onTranscript, onInterim, onError, onUnsupported };
    this._language = language || environment.navigator?.language || 'en-US';
    this._timeouts = { startTimeout, turnTimeout, endTimeout, speechTimeout, captureTimeout: Math.min(45000, captureTimeout), transcriptionTimeout };
    this._now = environment.performance?.now?.bind(environment.performance) || Date.now;
    this._state = 'idle';
    this._generation = 0;
    this._paused = false;
    this._disposed = false;
    this._recognition = null;
    this._capture = null;
    this._transcribe = null;
    this._captureAuthorized = false;
    this._speech = null;
    this._visibilityListener = () => {
      if (this._document?.visibilityState === 'hidden' && this.active) this.pause('hidden');
    };
    this._document?.addEventListener('visibilitychange', this._visibilityListener);
  }

  get recorderSupported() { return this._env.isSecureContext !== false && typeof this._env.MediaRecorder === 'function' && typeof this._env.navigator?.mediaDevices?.getUserMedia === 'function'; }
  get recognitionSupported() { return this._transcribe ? this.recorderSupported : typeof this._Recognition === 'function' && this._env.isSecureContext !== false; }
  get captureMode() { return this._transcribe ? 'recorder' : 'recognition'; }
  get capturing() { return this._capture?.phase === 'recording'; }
  get synthesisSupported() { return Boolean(this._synthesis && typeof this._Utterance === 'function'); }
  get supported() { return this.recognitionSupported; }
  get state() { return this._state; }
  get active() { return ['requesting', 'listening', 'thinking', 'speaking'].includes(this._state); }
  get paused() { return this._paused; }

  /** Configure only after the application confirms its transcription endpoint. */
  configureTranscription({ transcribe } = {}) {
    if (this._disposed) return false;
    if (transcribe != null && typeof transcribe !== 'function') throw new TypeError('transcribe must be a function');
    const next = transcribe || null;
    if (next === this._transcribe) return this.recognitionSupported;
    if (this.active) this.pause('transcription-changed');
    this._transcribe = next;
    this._captureAuthorized = false;
    return this.recognitionSupported;
  }

  /** Call directly from a user gesture. Capture requests its own permission. */
  async activate() {
    if (this._disposed) return false;
    this._paused = false;
    this._captureAuthorized = true;
    return this.startListening();
  }

  /** Start one turn. Does not override a user's Pause or a browser failure. */
  startListening() {
    if (this._disposed || this._paused) return false;
    if (this._document?.visibilityState === 'hidden') {
      this.pause('hidden');
      return false;
    }
    if (!this.recognitionSupported) {
      this._paused = true;
      this._setState('unsupported', { reason: 'recognition-unsupported' });
      this._callbacks.onUnsupported({
        code: 'recognition-unsupported',
        message: this._env.isSecureContext === false
          ? 'Microphone access needs HTTPS or localhost. You can continue by writing.'
          : this._transcribe
            ? 'This browser cannot record microphone audio. Try a browser with microphone recording support, or continue by writing.'
            : 'This browser does not support speech recognition. You can continue by writing.',
      });
      return false;
    }
    if (this._transcribe) return this._startCapture();
    if (this._recognition) return true; // Double taps cannot create two captures.
    const generation = ++this._generation;
    this._cancelSpeech();
    let recognition;
    try { recognition = new this._Recognition(); }
    catch { this._recognitionFailure('audio-capture'); return false; }
    const turn = { recognition, generation, timer: null, segments: [], stopping: false };
    this._recognition = turn;
    recognition.lang = this._language;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    const current = () => !this._disposed && this._recognition === turn && generation === this._generation;
    const arm = (delay, reason) => {
      this._clearTimeout(turn.timer);
      turn.timer = this._setTimeout(() => {
        if (current()) this._recognitionFailure(reason);
      }, delay);
    };
    const requestEnd = () => {
      if (!current() || turn.stopping) return;
      turn.stopping = true;
      arm(this._timeouts.endTimeout, 'end-timeout');
      try { recognition.stop(); }
      catch { if (current()) this._recognitionFailure('end-timeout'); }
    };
    recognition.onstart = () => {
      if (!current() || turn.stopping) return;
      this._setState('listening', { reason: 'microphone-started' });
      if (current()) arm(this._timeouts.turnTimeout, 'turn-timeout');
    };
    recognition.onresult = (event) => {
      if (!current()) return;
      const results = event.results || [];
      // Results are an indexed snapshot: replace, don't append, repeated events.
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const text = clean(result?.[0]?.transcript);
        if (!turn.segments[index]?.final) turn.segments[index] = { text, final: Boolean(result?.isFinal) };
      }
      // Interim results may shrink or disappear in a later snapshot.
      turn.segments.length = Math.max(results.length, turn.segments.findLastIndex((segment) => segment?.final) + 1);
      this._callbacks.onInterim(clean(turn.segments.map((segment) => segment?.text || '').join(' ')));
      if (turn.segments.some((segment) => segment?.final && segment.text)) requestEnd();
    };
    recognition.onspeechend = requestEnd;
    recognition.onerror = (event) => {
      if (current()) this._recognitionFailure(event.error || 'recognition-error');
    };
    recognition.onend = () => {
      if (!current()) return;
      const transcript = clean(turn.segments.filter((segment) => segment?.final).map((segment) => segment.text).join(' '));
      const hasInterim = turn.segments.some((segment) => segment?.text && !segment.final);
      this._releaseRecognition(false);
      if (transcript) {
        this._callbacks.onInterim('');
        if (generation !== this._generation || this._paused) return;
        this._setState('thinking', { reason: 'turn-complete' });
        // Only this path submits a turn. Aborts and partial results never submit.
        if (generation === this._generation && !this._paused) this._callbacks.onTranscript(transcript);
      } else {
        this._paused = true;
        this._setState('paused', { reason: hasInterim ? 'incomplete-transcript' : 'no-speech' });
      }
    };
    this._setState('requesting', { reason: 'microphone-requested' });
    if (!current() || this._paused) return false;
    arm(this._timeouts.startTimeout, 'start-timeout');
    try { recognition.start(); return true; }
    catch (error) {
      this._recognitionFailure(error.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture');
      return false;
    }
  }

  setThinking() {
    if (this._disposed || this._paused) return false;
    ++this._generation;
    this._releaseRecognition(true);
    this._releaseCapture();
    this._cancelSpeech();
    this._setState('thinking', { reason: 'reply-requested' });
    return true;
  }

  /** Explicit UI action: begin an opening or typed turn after Pause/Stop.
   * Call synchronously from the user's click/submit, never from a late reply.
   */
  beginReply() {
    if (this._disposed) return false;
    if (this._document?.visibilityState === 'hidden') {
      this.pause('hidden');
      return false;
    }
    this._paused = false;
    return this.setThinking();
  }

  /** Resolves a status; never silently reopens recognition after an utterance. */
  async speak(text, { signal } = {}) {
    if (this._disposed || this._paused || signal?.aborted) return { status: 'cancelled' };
    if (this._document?.visibilityState === 'hidden') {
      this.pause('hidden');
      return { status: 'cancelled' };
    }
    const spoken = clean(text);
    if (!spoken) return { status: 'spoken' };
    const generation = ++this._generation;
    this._releaseRecognition(true);
    this._releaseCapture();
    this._cancelSpeech();
    if (!this.synthesisSupported) {
      this._setState('idle', { reason: 'synthesis-unsupported' });
      this._callbacks.onUnsupported({ code: 'synthesis-unsupported', message: 'Spoken replies are unavailable in this browser. The reply is available as text.' });
      return { status: 'unsupported' };
    }
    const chunks = speechChunks(spoken);
    return new Promise((resolve) => {
      const job = { generation, utterance: null, timer: null, totalTimer: null, finish: null };
      this._speech = job;
      let settled = false;
      const current = () => !this._disposed && this._speech === job && this._generation === generation;
      const abort = () => {
        if (!current()) return;
        ++this._generation;
        this._cancelSpeech();
        this._setState('idle', { reason: 'speech-cancelled' });
      };
      const finish = (status, error) => {
        if (settled) return;
        settled = true;
        this._clearTimeout(job.timer);
        this._clearTimeout(job.totalTimer);
        if (job.utterance) {
          job.utterance.onend = null;
          job.utterance.onerror = null;
          job.utterance.onstart = null;
        }
        signal?.removeEventListener('abort', abort);
        if (this._speech === job) this._speech = null;
        resolve(error ? { status, error } : { status });
      };
      job.finish = finish;
      const fail = (code) => {
        if (!current()) return;
        this._paused = true;
        ++this._generation;
        finish('error', code);
        try { this._synthesis.cancel(); } catch { /* Already stopped by the browser. */ }
        this._setState('error', { reason: code });
        this._callbacks.onError({ code, message: 'The spoken reply could not finish. It remains available as text. Choose Resume when ready.', recoverable: true });
      };
      const next = () => {
        if (!current()) return;
        this._clearTimeout(job.timer);
        const chunk = chunks.shift();
        if (!chunk) {
          finish('spoken');
          this._setState('idle', { reason: 'reply-complete' });
          return;
        }
        let utterance;
        try { utterance = new this._Utterance(chunk); }
        catch { fail('speech-unavailable'); return; }
        job.utterance = utterance; // Retain a reference while the engine speaks.
        utterance.lang = this._language;
        utterance.rate = 1;
        utterance.pitch = 1;
        const voices = this._synthesis.getVoices?.() || [];
        const language = this._language.split('-')[0].toLowerCase();
        const matching = voices.filter((voice) => voice.lang?.toLowerCase().startsWith(language));
        const preferred = matching.find((voice) => voice.localService) || matching.find((voice) => voice.default) || matching[0];
        if (preferred) utterance.voice = preferred;
        utterance.onstart = () => { if (current()) this._setState('speaking', { reason: 'speech-started' }); };
        utterance.onend = () => {
          if (current() && job.utterance === utterance) {
            utterance.onend = null;
            utterance.onerror = null;
            utterance.onstart = null;
            next();
          }
        };
        utterance.onerror = (event) => { if (current() && job.utterance === utterance) fail(event.error || 'speech-error'); };
        job.timer = this._setTimeout(() => fail('speech-timeout'), Math.max(12000, chunk.split(/\s+/).length * 750 + 4000));
        try { this._synthesis.speak(utterance); }
        catch { fail('speech-error'); }
      };
      signal?.addEventListener('abort', abort, { once: true });
      job.totalTimer = this._setTimeout(() => fail('speech-timeout'), this._timeouts.speechTimeout);
      this._setState('speaking', { reason: 'speech-requested' });
      next();
    });
  }

  pause(reason = 'user') {
    if (this._disposed) return;
    this._paused = true;
    ++this._generation;
    this._releaseRecognition(true);
    this._releaseCapture();
    this._cancelSpeech();
    this._setState('paused', { reason });
  }

  /** Resume is an explicit user retry; an end/error callback must not call it. */
  resume() {
    if (this._disposed) return false;
    this._paused = false;
    this._captureAuthorized = true;
    return this.startListening();
  }

  stop() {
    if (this._disposed) return;
    this.pause('stopped');
    this._callbacks.onInterim('');
    this._setState('idle', { reason: 'stopped' });
  }

  dispose() {
    if (this._disposed) return;
    this.stop();
    this._disposed = true;
    this._document?.removeEventListener('visibilitychange', this._visibilityListener);
    this._callbacks = { onState: noop, onTranscript: noop, onInterim: noop, onError: noop, onUnsupported: noop };
  }

  /** Explicit Finish/send, also used by the bounded silence/duration detector. */
  finishCapture() {
    const turn = this._capture;
    if (!this._captureCurrent(turn) || turn.phase !== 'recording') return false;
    turn.phase = 'stopping';
    this._clearTimeout(turn.timer);
    turn.timer = this._setTimeout(() => {
      if (this._captureCurrent(turn)) this._recognitionFailure('end-timeout');
    }, this._timeouts.endTimeout);
    this._setState('thinking', { reason: 'transcribing' });
    if (!this._captureCurrent(turn)) return false;
    try { turn.recorder.stop(); this._stopCaptureInput(turn); }
    catch { this._recognitionFailure('recording-failed'); return false; }
    return true;
  }

  _captureCurrent(turn) {
    return Boolean(turn && !this._disposed && !this._paused && this._capture === turn && this._generation === turn.generation);
  }

  _startCapture() {
    if (this._capture) return true;
    // The application's first asynchronous reply cannot open a microphone. An
    // explicit activate/resume authorizes subsequent turns in that session.
    if (!this._captureAuthorized) {
      this._paused = true;
      this._setState('paused', { reason: 'microphone-needs-gesture' });
      this._callbacks.onError({ code: 'microphone-needs-gesture', message: 'Choose Resume to allow the microphone and start speaking.', recoverable: true });
      return false;
    }
    const generation = ++this._generation;
    this._releaseRecognition(true);
    this._cancelSpeech();
    const turn = {
      generation, phase: 'requesting', controller: new AbortController(),
      transcribe: this._transcribe, stream: null, recorder: null, chunks: [],
      bytes: 0, timer: null, sampleTimer: null, audioContext: null,
      source: null, analyser: null, trackListeners: [],
    };
    this._capture = turn;
    this._setState('requesting', { reason: 'microphone-requested', captureMode: 'recorder' });
    if (!this._captureCurrent(turn)) return false;
    turn.timer = this._setTimeout(() => {
      if (this._captureCurrent(turn)) this._recognitionFailure('start-timeout');
    }, this._timeouts.startTimeout);
    // Create/resume the optional meter while still within the user's gesture.
    const AudioContext = this._env.AudioContext || this._env.webkitAudioContext;
    if (AudioContext) {
      try {
        turn.audioContext = new AudioContext();
        Promise.resolve(turn.audioContext.resume?.()).catch(noop);
      } catch { /* Explicit Finish and the 45-second limit remain available. */ }
    }
    let pending;
    try {
      pending = this._env.navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      this._recognitionFailure(error?.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture');
      return false;
    }
    Promise.resolve(pending).then((stream) => {
      if (!this._captureCurrent(turn)) {
        for (const track of stream.getTracks()) { try { track.stop(); } catch { /* Already ended. */ } }
        return;
      }
      turn.stream = stream;
      try {
        const Recorder = this._env.MediaRecorder;
        const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']
          .find((type) => Recorder.isTypeSupported?.(type));
        turn.recorder = new Recorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64000 });
        const recorder = turn.recorder;
        recorder.ondataavailable = (event) => {
          if (!this._captureCurrent(turn) || !['recording', 'stopping'].includes(turn.phase) || !event.data?.size) return;
          turn.bytes += event.data.size;
          if (turn.bytes > 2 * 1024 * 1024) { this._recognitionFailure('recording-too-large'); return; }
          turn.chunks.push(event.data);
        };
        recorder.onerror = () => { if (this._captureCurrent(turn)) this._recognitionFailure('recording-failed'); };
        recorder.onstop = () => {
          if (!this._captureCurrent(turn)) return;
          if (turn.phase === 'transcribing') return;
          if (turn.phase !== 'stopping') { this._recognitionFailure('recording-failed'); return; }
          void this._transcribeCapture(turn);
        };
        recorder.onstart = () => {
          if (!this._captureCurrent(turn) || turn.phase !== 'requesting') return;
          this._clearTimeout(turn.timer);
          turn.phase = 'recording';
          this._setState('listening', { reason: 'recording-started', captureMode: 'recorder', canFinish: true });
          if (!this._captureCurrent(turn)) return;
          turn.timer = this._setTimeout(() => { if (this._captureCurrent(turn)) this.finishCapture(); }, this._timeouts.captureTimeout);
          this._monitorSilence(turn);
        };
        for (const track of stream.getAudioTracks()) {
          const ended = () => {
            if (this._captureCurrent(turn) && ['requesting', 'recording'].includes(turn.phase)) this._recognitionFailure('audio-capture');
          };
          track.addEventListener?.('ended', ended);
          turn.trackListeners.push([track, ended]);
        }
        if (!stream.getAudioTracks().some((track) => track.readyState !== 'ended')) throw new Error('No active microphone');
        recorder.start(250);
      } catch {
        if (this._captureCurrent(turn)) this._recognitionFailure('audio-capture');
      }
    }, (error) => {
      if (this._captureCurrent(turn)) this._recognitionFailure(error?.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture');
    });
    return true;
  }

  _monitorSilence(turn) {
    const context = turn.audioContext;
    if (!context || !this._captureCurrent(turn)) return;
    try {
      turn.source = context.createMediaStreamSource(turn.stream);
      turn.analyser = context.createAnalyser();
      turn.analyser.fftSize = 1024;
      turn.source.connect(turn.analyser); // Never connect the microphone to speakers.
      const samples = new Float32Array(turn.analyser.fftSize);
      let observed = 0;
      let lastObserved = this._now();
      let lastSpeech = 0;
      let voicedFrames = 0;
      let heardSpeech = false;
      const sample = () => {
        if (!this._captureCurrent(turn) || turn.phase !== 'recording') return;
        const now = this._now();
        const elapsed = Math.min(250, Math.max(0, now - lastObserved));
        lastObserved = now;
        // A suspended/blocked audio meter must not mistake absent data for silence.
        if (context.state === 'running') {
          observed += elapsed;
          turn.analyser.getFloatTimeDomainData(samples);
          const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
          if (rms >= 0.015) {
            voicedFrames += 1;
            if (voicedFrames >= 3) heardSpeech = true;
            lastSpeech = observed;
          } else {
            voicedFrames = 0;
          }
          if (heardSpeech && observed - lastSpeech >= 2000) { this.finishCapture(); return; }
          if (!heardSpeech && observed >= 10000) { this._recognitionFailure('no-speech'); return; }
        }
        turn.sampleTimer = this._setTimeout(sample, 100);
      };
      turn.sampleTimer = this._setTimeout(sample, 100);
    } catch { /* Recording still has an explicit Finish button and hard limit. */ }
  }

  async _transcribeCapture(turn) {
    if (!this._captureCurrent(turn)) return;
    this._clearTimeout(turn.timer);
    this._stopCaptureInput(turn);
    turn.phase = 'transcribing';
    const BlobClass = this._env.Blob || globalThis.Blob;
    let blob;
    try { blob = new BlobClass(turn.chunks, { type: turn.recorder.mimeType || turn.chunks[0]?.type || 'application/octet-stream' }); }
    catch { this._recognitionFailure('recording-failed'); return; }
    turn.chunks = [];
    this._detachRecorder(turn);
    if (!blob.size) { this._recognitionFailure('no-speech'); return; }
    turn.timer = this._setTimeout(() => {
      if (this._captureCurrent(turn)) this._recognitionFailure('transcription-timeout');
    }, this._timeouts.transcriptionTimeout);
    try {
      const result = await turn.transcribe(blob, { signal: turn.controller.signal });
      if (!this._captureCurrent(turn)) return;
      if (typeof result !== 'string') throw new TypeError('Transcription must return text');
      const transcript = clean(result);
      if (!transcript) { this._recognitionFailure('no-speech'); return; }
      this._releaseCapture();
      this._callbacks.onInterim('');
      if (this._disposed || this._paused || this._generation !== turn.generation) return;
      this._setState('thinking', { reason: 'turn-complete' });
      if (!this._disposed && !this._paused && this._generation === turn.generation) this._callbacks.onTranscript(transcript);
    } catch {
      if (this._captureCurrent(turn)) this._recognitionFailure('transcription-failed');
    }
  }

  _stopCaptureInput(turn) {
    this._clearTimeout(turn.sampleTimer);
    turn.sampleTimer = null;
    for (const [track, listener] of turn.trackListeners) track.removeEventListener?.('ended', listener);
    turn.trackListeners = [];
    for (const track of turn.stream?.getTracks() || []) { try { track.stop(); } catch { /* Already ended. */ } }
    turn.stream = null;
    try { turn.source?.disconnect(); } catch { /* Already disconnected. */ }
    try { turn.analyser?.disconnect(); } catch { /* Already disconnected. */ }
    turn.source = null;
    turn.analyser = null;
    const context = turn.audioContext;
    turn.audioContext = null;
    try { Promise.resolve(context?.close()).catch(noop); } catch { /* Already closed. */ }
  }

  _detachRecorder(turn) {
    const recorder = turn.recorder;
    if (!recorder) return;
    recorder.onstart = null;
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    if (recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* Already stopped. */ } }
    turn.recorder = null;
  }

  _releaseCapture() {
    const turn = this._capture;
    this._capture = null;
    if (!turn) return;
    this._clearTimeout(turn.timer);
    turn.controller.abort();
    this._detachRecorder(turn);
    this._stopCaptureInput(turn);
    turn.chunks = [];
  }

  _setState(state, details = {}) {
    if (this._disposed) return;
    const changed = this._state !== state;
    this._state = state;
    if (changed) this._callbacks.onState(state, details);
  }

  _releaseRecognition(abort) {
    const turn = this._recognition;
    this._recognition = null;
    if (!turn) return;
    this._clearTimeout(turn.timer);
    const recognition = turn.recognition;
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onspeechend = null;
    recognition.onerror = null;
    recognition.onend = null;
    if (abort) {
      try { recognition.abort(); } catch { /* An ended recognizer may throw. */ }
    }
  }

  _cancelSpeech() {
    const job = this._speech;
    if (!job) return;
    job.finish('cancelled');
    try { this._synthesis.cancel(); } catch { /* An ended synthesizer may throw. */ }
  }

  _recognitionFailure(code) {
    this._paused = true;
    ++this._generation;
    this._releaseRecognition(true);
    this._releaseCapture();
    this._setState(code === 'no-speech' || code === 'aborted' ? 'paused' : 'error', { reason: code });
    this._callbacks.onError({ code, message: RECOGNITION_ERRORS[code] || 'Speech recognition stopped. Choose Resume, or continue by writing.', recoverable: true });
  }
}
