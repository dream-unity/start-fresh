/**
 * One recognition turn → one spoken reply. Only the application can request the
 * next turn; browser end/error events never reopen the microphone themselves.
 *
 * Browser speech recognition may send audio to the browser vendor's service.
 * This adapter does not promise offline recognition and stores no recordings.
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
    speechTimeout = 120000,
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
    this._timeouts = { startTimeout, turnTimeout, endTimeout, speechTimeout };
    this._state = 'idle';
    this._generation = 0;
    this._paused = false;
    this._disposed = false;
    this._recognition = null;
    this._speech = null;
    this._visibilityListener = () => {
      if (this._document?.visibilityState === 'hidden' && this.active) this.pause('hidden');
    };
    this._document?.addEventListener('visibilitychange', this._visibilityListener);
  }

  get recognitionSupported() { return typeof this._Recognition === 'function' && this._env.isSecureContext !== false; }
  get synthesisSupported() { return Boolean(this._synthesis && typeof this._Utterance === 'function'); }
  get supported() { return this.recognitionSupported; }
  get state() { return this._state; }
  get active() { return ['requesting', 'listening', 'thinking', 'speaking'].includes(this._state); }
  get paused() { return this._paused; }

  /** Call directly from a user gesture. Recognition requests its own permission. */
  async activate() {
    if (this._disposed) return false;
    this._paused = false;
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
          : 'This browser does not support speech recognition. You can continue by writing.',
      });
      return false;
    }
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
    this._cancelSpeech();
    this._setState('paused', { reason });
  }

  /** Resume is an explicit user retry; an end/error callback must not call it. */
  resume() {
    if (this._disposed) return false;
    this._paused = false;
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
    this._setState(code === 'no-speech' || code === 'aborted' ? 'paused' : 'error', { reason: code });
    this._callbacks.onError({ code, message: RECOGNITION_ERRORS[code] || 'Speech recognition stopped. Choose Resume, or continue by writing.', recoverable: true });
  }
}
