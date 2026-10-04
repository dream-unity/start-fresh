/* Deterministic application acceptance. Speech and model replies are MOCKED.
 * This verifies anonymous public-app integration and audio lifecycle, not a
 * physical microphone, production availability, or real GPT inference.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output');
const origin = 'http://127.0.0.1:4173';
const MEMORY_KEY = 'dream-unity.start-fresh.constellation.v1';
const checks = [];
let server;
let browser;
let serverLog = '';

function pass(name) { checks.push(name); process.stdout.write(`PASS ${name}\n`); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startServer() {
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: root, env: { ...process.env, PORT: '4173' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Test server exited: ${serverLog}`);
    if (serverLog.includes('Dream Unity is ready')) {
      const response = await fetch(origin);
      assert.equal(response.status, 200, 'The actual project server must serve its entry page.');
      return;
    }
    await pause(50);
  }
  throw new Error(`Test server did not become ready: ${serverLog}`);
}

async function speechFixture(context, { denied = false, recording = true, nativeRecognition = false } = {}) {
  await context.addInitScript(({ denied, recording, nativeRecognition }) => {
    const fixture = { active: null, starts: 0, nativeStarts: 0, stoppedTracks: 0, utterances: [], audioText: '', denied };
    class Recognition { start() { fixture.nativeStarts++; throw new Error('Public capture must use the recorder, not native recognition.'); } }
    class Recorder {
      static isTypeSupported(type) { return type === 'audio/webm'; }
      constructor(_stream, { mimeType = 'audio/webm' } = {}) { this.mimeType = mimeType; this.state = 'inactive'; fixture.active = this; }
      start() { this.state = 'recording'; queueMicrotask(() => { if (this.state === 'recording') this.onstart?.(); }); }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob(['MOCK_AUDIO:' + fixture.audioText], { type: this.mimeType }) });
          this.onstop?.();
        });
      }
    }
    const mediaDevices = { getUserMedia: async () => {
      fixture.starts++;
      if (fixture.denied) throw new DOMException('Fixture denied permission.', 'NotAllowedError');
      const track = {
        readyState: 'live', addEventListener() {}, removeEventListener() {},
        stop() { if (this.readyState !== 'ended') fixture.stoppedTracks++; this.readyState = 'ended'; },
      };
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } };
    class Utterance { constructor(text) { this.text = text; } }
    let synthesisGeneration = 0;
    const synthesis = {
      getVoices: () => [{ name: 'Deterministic test voice', lang: 'en-US', localService: true, default: true }],
      speak(utterance) {
        const generation = synthesisGeneration;
        fixture.utterances.push(utterance.text);
        queueMicrotask(() => {
          if (generation !== synthesisGeneration) return;
          utterance.onstart?.();
          queueMicrotask(() => { if (generation === synthesisGeneration) utterance.onend?.(); });
        });
      },
      cancel() { synthesisGeneration++; },
    };
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: nativeRecognition ? Recognition : undefined });
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: recording ? Recorder : undefined });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: recording ? mediaDevices : undefined });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis });
    window.__speechFixture = fixture;
  }, { denied, recording, nativeRecognition });
}

function reply(text, region = 'unity', memory = null) {
  return { reply: text, region, focus: `A ${region} perspective`, memory };
}

async function mockModel(page, { available = true } = {}) {
  const requests = [], audioRequests = [];
  const counts = { status: 0 };
  let pendingRelease = null;
  let heldResolve;
  const held = new Promise(resolve => { heldResolve = resolve; });
  const headers = { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Content-Type, Accept' };
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(body) });
  await page.route(/\/api\/nexus(?:\?|$)/, async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const op = new URL(request.url()).searchParams.get('op');
    const requestHeaders = request.headers();
    assert.equal(requestHeaders.authorization, undefined, 'Public visitors must not supply an access token.');
    assert.equal(requestHeaders['x-dream-unity-account'], undefined, 'Public visitors must not select an account.');
    assert.equal(requestHeaders.cookie, undefined, 'Public API requests must omit cookies.');
    if (op === 'status') {
      assert.equal(request.method(), 'GET');
      counts.status++;
      return json(route, { ready: available, transcription: available, model: 'openai/gpt-fixture', ...(!available && { error: 'The guide is temporarily unavailable.' }) });
    }
    assert.equal(request.method(), 'POST');
    if (op === 'transcribe') {
      assert.match(requestHeaders['content-type'] || '', /^audio\/webm(?:;|$)/);
      const audio = request.postDataBuffer();
      assert.ok(audio?.length, 'One audio turn must be uploaded.');
      const fixtureAudio = audio.toString();
      assert.ok(fixtureAudio.startsWith('MOCK_AUDIO:'), 'This suite only submits explicitly simulated audio.');
      audioRequests.push(fixtureAudio);
      return json(route, { text: fixtureAudio.slice('MOCK_AUDIO:'.length) });
    }
    assert.equal(op, 'chat', 'Only documented public operations may be called.');
    assert.match(requestHeaders['content-type'] || '', /^application\/json(?:;|$)/);
    const body = request.postDataJSON();
    requests.push(body);
    assert.deepEqual(Object.keys(body).sort(), ['context', 'messages']);
    assert.ok(body.messages.every(message => ['user', 'assistant'].includes(message.role)), 'The server owns its privileged instructions.');
    assert.ok(Array.isArray(body.context.memory));
    const input = body.messages.filter(message => message.role === 'user').at(-1)?.content || '';
    let response;
    if (input.includes('WAIT_FOR_CANCEL')) {
      heldResolve();
      await new Promise(resolve => { pendingRelease = resolve; });
      response = reply('LATE_REPLY_MUST_NOT_APPEAR', 'machine');
    } else if (/possibilit|ideas|imagine/i.test(input)) {
      response = reply('We can give your possibilities some space. What is one direction you would like to explore?', 'machine', { kind: 'goal', text: 'Explore possibilities for a creative project.' });
    } else if (/action|choose|step/i.test(input)) {
      response = reply('You have a direction. Choose one small action you can call "a beginning" today.', 'maker');
    } else if (/evidence|consequence|actually happened/i.test(input)) {
      response = reply('Let us compare your expectation with the evidence of what actually happened.', 'world');
    } else response = reply('Tell me why you are here.', 'unity');
    await json(route, response).catch(error => { if (!input.includes('WAIT_FOR_CANCEL')) throw error; });
  });
  return { requests, audioRequests, counts, held, makeAvailable: () => { available = true; }, release: () => pendingRelease?.() };
}

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Optional remote typography is not required to use the app. Every local
    // script error and other console error remains an acceptance failure.
    if (/fonts\.(?:googleapis|gstatic)\.com/.test(text + message.location().url)) return;
    errors.push(text);
  });
  page.on('dialog', dialog => dialog.accept());
  return errors;
}

async function ready(page, { guideReady = true } = {}) {
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('#enter').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#nexus')?.dataset.renderer === 'webgl');
  assert.equal(await page.locator('#nexus').getAttribute('data-region'), 'unity');
  await page.waitForFunction(available => {
    const text = document.querySelector('#runtime-status')?.textContent || '';
    // Preflight reports configuration, not a proven successful GPT response.
    const settled = document.querySelector('#retry-connection')?.disabled === false
      && document.querySelector('#send')?.disabled === false;
    return settled && (available ? text.includes('connection is configured') : text.includes('unavailable'));
  }, guideReady);
  assert.equal(await page.locator('#connect-chatgpt,#chatgpt-model,#use-chatgpt,#use-local,#use-browser,#alternative-models,#plan-indicator').count(), 0,
    'Visitors must not be asked for an account, subscription, installation, or model selection.');
  assert.ok(!/ollama|npm start|model download|your ChatGPT|subscribe|API key/i.test(await page.locator('body').textContent()),
    'Public UI must not expose owner setup as a visitor step.');
}

async function connect(page) {
  await page.locator('#enter').click();
  await page.locator('#spoken').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#setup').isVisible(), false, 'A ready guide should enter directly.');
}

async function typeTurn(page, text, expectedRegion) {
  await page.locator('#intention').fill(text);
  await page.locator('#send').click();
  if (expectedRegion) await page.waitForFunction(region =>
    document.querySelector('#region-title')?.textContent.includes(region)
    && document.querySelector('#nexus')?.dataset.region === region.replace('Dream ', '').toLowerCase()
    && document.querySelector('#status')?.textContent.includes('Your turn.'), expectedRegion);
}

async function closeDialog(page, selector) {
  await page.locator(`${selector} [data-close]`).click();
  await page.locator(selector).waitFor({ state: 'hidden' });
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  await startServer();
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await desktop.addCookies([{ name: 'must-not-reach-guide', value: 'fixture', url: origin }]);
  await speechFixture(desktop);
  const page = await desktop.newPage();
  const errors = watchErrors(page);
  const model = await mockModel(page);
  await ready(page);
  assert.equal(await page.evaluate(() => window.__speechFixture.starts), 0, 'A visit must never open the microphone.');
  assert.equal(model.requests.length, 0, 'A visit must never start inference.');
  assert.equal(await page.evaluate(() => localStorage.length), 0, 'A visit must not opt into storage.');
  await page.screenshot({ path: path.join(output, 'desktop-initial.png') });
  pass('Real WebGL scene; no microphone, inference, or persistence before consent');

  assert.equal(model.counts.status, 1, 'Initial preflight performs one status request.');
  await typeTurn(page, 'I want to explore possibilities for a creative project.', 'Dream Machine');
  assert.equal(await page.evaluate(() => window.__speechFixture.starts), 0, 'Typed entry must not open the microphone.');
  assert.deepEqual(model.requests[0].context.memory, [], 'Unconfirmed memories must not be sent as personal context.');
  assert.equal(await page.locator('#nexus').getAttribute('data-region'), 'machine');
  await page.locator('#proposal').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#memory-count').textContent(), '0', 'A proposed memory must not already be saved.');
  await page.locator('#proposal-keep').click();
  await page.locator('#note-editor').waitFor({ state: 'visible' });
  await page.locator('#note-text').fill('Explore possibilities for my own creative project.');
  await page.locator('#note-form button[type="submit"]').click();
  await page.locator('#note-editor').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#memory-count')?.textContent.trim() === '1');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), MEMORY_KEY), null, 'Session notes must remain in memory.');
  pass('Anonymous typed entry → structured guide reply → scene navigation; memory requires review and explicit acceptance');

  await typeTurn(page, 'Help me choose one small action.', 'Dream Maker');
  assert.ok(model.requests.at(-1).context.memory.some(note => note.text === 'Explore possibilities for my own creative project.'), 'Only accepted notes become model context.');
  await typeTurn(page, 'What evidence shows what actually happened?', 'Dream World');
  await page.waitForFunction(() => !document.querySelector('#spoken-text')?.textContent.includes('<navigation'));
  assert.ok((await page.locator('#spoken-text').textContent()).includes('evidence'));
  assert.ok(await page.evaluate(() => window.__speechFixture.utterances.every(text => !text.includes('<navigation'))), 'Model control metadata must never be spoken.');
  await page.screenshot({ path: path.join(output, 'desktop-conversation.png') });
  pass('Machine → Maker → World in one scene; control metadata excluded from speech and text');

  await typeTurn(page, 'WAIT_FOR_CANCEL');
  await model.held;
  const cancelledRequest = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).searchParams.get('op') === 'chat' });
  await page.locator('#interrupt').click();
  await cancelledRequest;
  model.release();
  await typeTurn(page, 'Please review the evidence again.', 'Dream World');
  await page.waitForFunction(() => document.querySelector('#spoken-text')?.textContent.includes('compare your expectation'));
  assert.ok(!(await page.locator('#spoken-text').textContent()).includes('LATE_REPLY'));
  await page.locator('#transcript-open').click();
  assert.ok(!(await page.locator('#transcript-content').textContent()).includes('LATE_REPLY'));
  await closeDialog(page, '#transcript');
  pass('Interrupted response cannot speak, navigate, or enter the transcript after cancellation');

  await page.locator('#memory-open').click();
  await page.locator('#memory-list').getByText('Explore possibilities for my own creative project.', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'desktop-constellation.png') });
  await closeDialog(page, '#constellation');
  await page.locator('#settings-open').click();
  await page.locator('#remember-device').check();
  await page.waitForFunction(key => localStorage.getItem(key)?.includes('my own creative project'), MEMORY_KEY);
  await closeDialog(page, '#settings');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#settings-open').click();
  await page.locator('#load-saved').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#memory-count').textContent(), '0', 'Restoring personal context requires consent in this session.');
  await page.locator('#load-saved').click();
  await closeDialog(page, '#settings');
  await page.locator('#memory-open').click();
  await page.locator('#memory-list').getByText('Explore possibilities for my own creative project.', { exact: true }).waitFor();
  await page.locator('#memory-list').getByRole('button', { name: /delete|remove/i }).first().click();
  await page.waitForFunction(() => document.querySelector('#memory-count')?.textContent.trim() === '0');
  assert.ok(!(await page.evaluate(key => localStorage.getItem(key), MEMORY_KEY) || '').includes('my own creative project'));
  pass('Device persistence is opt-in; explicit reload restore and deletion work through the real UI');
  assert.deepEqual(errors, [], 'Desktop must have no local JavaScript or console errors.');

  const recoveryContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await speechFixture(recoveryContext);
  const recoveryPage = await recoveryContext.newPage();
  const recoveryErrors = watchErrors(recoveryPage);
  const recoveringGuide = await mockModel(recoveryPage, { available: false });
  await ready(recoveryPage, { guideReady: false });
  assert.equal(recoveringGuide.counts.status, 1);
  assert.equal(await recoveryPage.evaluate(() => window.__speechFixture.starts), 0);
  await recoveryPage.locator('#memory-open').click();
  await closeDialog(recoveryPage, '#constellation');
  assert.equal(recoveringGuide.counts.status, 1, 'Exploring notes must not trigger a retry loop.');
  await recoveryPage.locator('#enter').click();
  await recoveryPage.locator('#setup').waitFor({ state: 'visible' });
  await recoveryPage.waitForFunction(() => !document.querySelector('#retry-connection')?.disabled);
  assert.equal(recoveringGuide.counts.status, 2, 'An explicit entry may recheck once.');
  recoveringGuide.makeAvailable();
  await recoveryPage.locator('#retry-connection').click();
  await recoveryPage.locator('#setup').waitFor({ state: 'hidden' });
  assert.equal(recoveringGuide.counts.status, 3, 'Retry is an explicit bounded request.');
  assert.equal(await recoveryPage.evaluate(() => window.__speechFixture.starts), 0, 'Restored service must not activate a microphone by itself.');
  await typeTurn(recoveryPage, 'Help me choose one action.', 'Dream Maker');
  assert.deepEqual(recoveryErrors, []);
  pass('One initial preflight; unavailable guide recovers only after explicit retry without opening audio');

  const deniedContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await speechFixture(deniedContext, { denied: true });
  const deniedPage = await deniedContext.newPage();
  const deniedErrors = watchErrors(deniedPage);
  await mockModel(deniedPage);
  await ready(deniedPage);
  await connect(deniedPage);
  await deniedPage.waitForFunction(() => /permission|not granted|allow/i.test(document.querySelector('#status')?.textContent || ''));
  assert.equal(await deniedPage.evaluate(() => window.__speechFixture.starts), 1, 'Permission failure must not enter a restart loop.');
  await typeTurn(deniedPage, 'Help me explore possibilities.', 'Dream Machine');
  assert.equal(await deniedPage.evaluate(() => window.__speechFixture.starts), 1, 'Typing after denial must not retry microphone access.');
  assert.deepEqual(deniedErrors, [], 'Permission rejection must be handled without uncaught errors.');
  pass('Mock microphone permission denial remains stable; typed conversation still works');

  const unsupportedContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await speechFixture(unsupportedContext, { recording: false });
  const unsupportedPage = await unsupportedContext.newPage();
  const unsupportedErrors = watchErrors(unsupportedPage);
  await mockModel(unsupportedPage);
  await ready(unsupportedPage);
  await connect(unsupportedPage);
  await unsupportedPage.waitForFunction(() => /cannot open a microphone/i.test(document.querySelector('#status')?.textContent || ''));
  await typeTurn(unsupportedPage, 'Help me explore possibilities.', 'Dream Machine');
  assert.equal(await unsupportedPage.evaluate(() => window.__speechFixture.starts), 0);
  assert.deepEqual(unsupportedErrors, []);
  pass('A browser without recording support retains a working typed conversation');

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await speechFixture(mobile);
  const mobilePage = await mobile.newPage();
  const mobileErrors = watchErrors(mobilePage);
  const mobileModel = await mockModel(mobilePage);
  await ready(mobilePage);
  assert.ok(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile viewport must not overflow horizontally.');
  await mobilePage.screenshot({ path: path.join(output, 'mobile-initial.png') });
  await connect(mobilePage);
  await mobilePage.waitForFunction(() => window.__speechFixture.active?.state === 'recording');
  assert.equal(await mobilePage.evaluate(() => window.SpeechRecognition), undefined, 'This case must not depend on native speech recognition.');
  await mobilePage.evaluate(() => { window.__speechFixture.audioText = 'Help me choose one action.'; });
  await mobilePage.locator('#finish-capture').click();
  await mobilePage.waitForFunction(() => document.querySelector('#nexus')?.dataset.region === 'maker'
    && window.__speechFixture.starts === 2 && window.__speechFixture.active?.state === 'recording');
  assert.equal(mobileModel.audioRequests.length, 1, 'One finished recording must produce one transcription request.');
  assert.equal(mobileModel.requests.length, 1, 'A transcription must submit one conversation turn.');
  await mobilePage.locator('#interrupt').click();
  const startsAfterPause = await mobilePage.evaluate(() => window.__speechFixture.starts);
  assert.equal(await mobilePage.evaluate(() => window.__speechFixture.stoppedTracks), startsAfterPause, 'Pause must release every opened microphone track.');
  await typeTurn(mobilePage, 'Help me choose the next action.', 'Dream Maker');
  assert.equal(await mobilePage.evaluate(() => window.__speechFixture.starts), startsAfterPause, 'Typing after Pause must never reopen capture.');
  assert.equal(await mobilePage.evaluate(() => window.__speechFixture.nativeStarts), 0);
  await mobilePage.screenshot({ path: path.join(output, 'mobile-conversation.png') });
  assert.deepEqual(mobileErrors, [], 'Mobile must have no local JavaScript or console errors.');
  pass('Mobile MediaRecorder without native recognition → one transcription → reply → next turn; Pause releases tracks and stays paused');

  await fs.writeFile(path.join(output, 'browser-acceptance.json'), JSON.stringify({
    suite: 'Deterministic full-app acceptance',
    model: 'MOCKED anonymous public status and structured GPT replies', speech: 'MOCKED MediaRecorder, microphone streams, transcription and synthesis',
    authorization: 'No visitor authentication or account selection',
    renderer: 'Real Chromium WebGL via SwiftShader',
    limitations: ['Does not validate physical microphone capture or real audio encoding.', 'Does not validate production availability, real transcription, or an actual GPT response.'],
    checks, modelRequests: model.requests.length, passed: true,
  }, null, 2));
}

main().catch(async error => {
  process.exitCode = 1;
  process.stderr.write(`${error.stack || error}\n`);
  await fs.writeFile(path.join(output, 'browser-failure.txt'), `${error.stack || error}\n\n${serverLog}`).catch(() => {});
  if (browser) {
    const pages = browser.contexts().flatMap(context => context.pages());
    for (let i = 0; i < pages.length; i++) await pages[i].screenshot({ path: path.join(output, `failure-${i}.png`) }).catch(() => {});
  }
}).finally(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
});
