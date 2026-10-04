/* Deterministic application acceptance. Speech and model replies are MOCKED.
 * This verifies integration and UI lifecycle, not hardware, live OAuth consent,
 * subscription eligibility, or real inference.
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

async function speechFixture(context, denied = false) {
  await context.addInitScript(({ denied }) => {
    const fixture = { active: null, starts: 0, aborts: 0, utterances: [], denied };
    class Recognition {
      start() {
        this.running = true;
        fixture.active = this;
        fixture.starts++;
        queueMicrotask(() => {
          if (!this.running) return;
          if (fixture.denied) { this.running = false; this.onerror?.({ error: 'not-allowed' }); }
          else this.onstart?.();
        });
      }
      stop() { this.running = false; queueMicrotask(() => this.onend?.()); }
      abort() { fixture.aborts++; this.running = false; queueMicrotask(() => this.onend?.()); }
    }
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
    fixture.emit = text => {
      if (!fixture.active?.running) throw new Error('No mocked recognition turn is active.');
      const result = [{ transcript: text, confidence: 0.98 }];
      result.isFinal = true;
      fixture.active.onresult?.({ resultIndex: 0, results: [result] });
    };
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: Recognition });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis });
    window.__speechFixture = fixture;
  }, { denied });
}

function ndjson(text, region = 'unity', memory = null) {
  const reply = JSON.stringify({ reply: text, region, focus: `A ${region} perspective`, memory });
  // This is the same constrained JSON envelope requested from the actual model.
  // Seven-character pieces also exercise partial property names and escaped
  // strings; only decoded reply text may reach the visible conversation.
  const pieces = reply.match(/[\s\S]{1,7}/g);
  return pieces.map(content => JSON.stringify({ message: { role: 'assistant', content }, done: false })).join('\n') + '\n' + JSON.stringify({ done: true }) + '\n';
}

async function mockModel(page, { connected = true } = {}) {
  const requests = [];
  let pendingRelease = null;
  let heldResolve;
  const held = new Promise(resolve => { heldResolve = resolve; });
  await page.route('**/api/chatgpt/status', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      connected, sharing: connected,
      account: connected ? { id: 'fixture', label: 'Fixture account', selectedModel: 'fixture-gpt' } : null,
      accounts: [],
    }),
  }));
  await page.route('**/api/chatgpt/models', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ models: connected ? [{ slug: 'fixture-gpt', display_name: 'Fixture GPT' }] : [] }),
  }));
  await page.route('**/api/chatgpt/model', async route => {
    assert.equal(route.request().method(), 'POST');
    assert.equal(connected, true);
    assert.equal(route.request().headers()['x-dream-unity-account'], 'fixture', 'Model selection must be bound to the displayed account.');
    assert.match(route.request().headers()['content-type'] || '', /^application\/json(?:;|$)/);
    assert.deepEqual(route.request().postDataJSON(), { model: 'fixture-gpt' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, model: 'fixture-gpt' }) });
  });
  await page.route('**/api/chatgpt/chat', async route => {
    assert.equal(route.request().method(), 'POST');
    assert.equal(route.request().headers()['x-dream-unity-account'], 'fixture', 'A conversation must stay bound to the selected account.');
    assert.match(route.request().headers()['content-type'] || '', /^application\/json(?:;|$)/);
    const body = route.request().postDataJSON();
    requests.push(body);
    // Keep this strict: the real server rejects extra request keys.
    assert.deepEqual(Object.keys(body).sort(), ['messages', 'model'], 'Client/server request schema must agree.');
    assert.equal(body.model, 'fixture-gpt', 'Inference must use the selected account model.');
    assert.equal(connected, true, 'Inference must require an authorized subscription connection.');
    const input = body.messages.filter(message => message.role === 'user').at(-1)?.content || '';
    let response;
    if (input.includes('WAIT_FOR_CANCEL')) {
      heldResolve();
      await new Promise(resolve => { pendingRelease = resolve; });
      response = ndjson('LATE_REPLY_MUST_NOT_APPEAR', 'machine');
    } else if (/possibilit|ideas|imagine/i.test(input)) {
      response = ndjson('We can give your possibilities some space. What is one direction you would like to explore?', 'machine', { kind: 'goal', text: 'Explore possibilities for a creative project.' });
    } else if (/action|choose|step/i.test(input)) {
      response = ndjson('You have a direction. Choose one small action you can call "a beginning" today.', 'maker');
    } else if (/evidence|consequence|actually happened/i.test(input)) {
      response = ndjson('Let us compare your expectation with the evidence of what actually happened.', 'world');
    } else {
      response = ndjson('Tell me why you are here.', 'unity');
    }
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: response }).catch(error => {
      if (!input.includes('WAIT_FOR_CANCEL')) throw error;
    });
  });
  return { requests, held, authorize: () => { connected = true; }, release: () => pendingRelease?.() };
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

async function ready(page) {
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('#enter').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#nexus')?.dataset.renderer === 'webgl');
  assert.equal(await page.locator('#nexus').getAttribute('data-region'), 'unity');
}

async function connect(page) {
  await page.locator('#enter').click();
  await page.locator('#setup').waitFor({ state: 'visible' });
  await page.locator('#use-chatgpt').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#chatgpt-model')?.value === 'fixture-gpt'
    && !document.querySelector('#use-chatgpt')?.disabled);
  assert.equal(await page.locator('#chatgpt-model').inputValue(), 'fixture-gpt');
  await page.locator('#use-chatgpt').click();
  await page.locator('#setup').waitFor({ state: 'hidden' });
  // Model initialization can be a long download. A fresh explicit activation
  // after it completes preserves the browser's microphone permission gesture.
  await page.locator('#enter').click();
  await page.locator('#spoken').waitFor({ state: 'visible' });
  assert.match(await page.locator('#runtime-status').textContent(), /ChatGPT/i);
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

  await connect(page);
  await page.waitForFunction(() => window.__speechFixture.active?.running);
  await page.evaluate(() => window.__speechFixture.emit('I want to explore possibilities for a creative project.'));
  await page.waitForFunction(() => document.querySelector('#region-title')?.textContent.includes('Dream Machine'));
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
  pass('Mock recognition → model reply → scene navigation; memory requires review and explicit acceptance');

  await typeTurn(page, 'Help me choose one small action.', 'Dream Maker');
  await typeTurn(page, 'What evidence shows what actually happened?', 'Dream World');
  await page.waitForFunction(() => !document.querySelector('#spoken-text')?.textContent.includes('<navigation'));
  assert.ok((await page.locator('#spoken-text').textContent()).includes('evidence'));
  assert.ok(await page.evaluate(() => window.__speechFixture.utterances.every(text => !text.includes('<navigation'))), 'Model control metadata must never be spoken.');
  await page.screenshot({ path: path.join(output, 'desktop-conversation.png') });
  pass('Machine → Maker → World in one scene; control metadata excluded from speech and text');

  await typeTurn(page, 'WAIT_FOR_CANCEL');
  await model.held;
  const cancelledRequest = page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/api/chatgpt/chat') });
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

  const unsignedContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await speechFixture(unsignedContext);
  const unsignedPage = await unsignedContext.newPage();
  const unsignedErrors = watchErrors(unsignedPage);
  const unsignedModel = await mockModel(unsignedPage, { connected: false });
  const fixtureAuthorization = 'https://auth.openai.com/api/accounts/authorize?client_id=fixture-client&state=fixture-state';
  let authorizationRequests = 0;
  await unsignedContext.route('https://auth.openai.com/**', async route => {
    assert.equal(route.request().url(), fixtureAuthorization, 'Only the expected mocked authorization destination may be opened.');
    authorizationRequests++;
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Mock authorization</title><p>MOCK AUTHORIZATION. No OpenAI account is contacted.</p>' });
  });
  await unsignedPage.route('**/api/chatgpt/auth/start', async route => {
    assert.equal(route.request().method(), 'POST');
    assert.match(route.request().headers()['content-type'] || '', /^application\/json(?:;|$)/);
    assert.deepEqual(route.request().postDataJSON(), {}, 'Sign-in start must satisfy the local server JSON request contract.');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: fixtureAuthorization }) });
  });
  await ready(unsignedPage);
  await unsignedPage.locator('#enter').click();
  await unsignedPage.locator('#connect-chatgpt').waitFor({ state: 'visible' });
  assert.equal(await unsignedPage.locator('#use-chatgpt').isVisible(), false, 'Unsigned visitors cannot start subscription inference.');
  const popupOpened = unsignedPage.waitForEvent('popup');
  await unsignedPage.locator('#connect-chatgpt').click();
  const popup = await popupOpened;
  await popup.waitForURL(fixtureAuthorization);
  await popup.getByText('MOCK AUTHORIZATION. No OpenAI account is contacted.', { exact: true }).waitFor();
  assert.equal(authorizationRequests, 1);
  assert.equal(unsignedModel.requests.length, 0, 'Opening authorization must not start inference.');
  unsignedModel.authorize();
  await popup.close();
  await unsignedPage.locator('#check-chatgpt').click();
  await unsignedPage.locator('#use-chatgpt').waitFor({ state: 'visible' });
  await unsignedPage.locator('#use-chatgpt').click();
  await unsignedPage.locator('#setup').waitFor({ state: 'hidden' });
  await typeTurn(unsignedPage, 'Help me choose one action.', 'Dream Maker');
  assert.equal(unsignedModel.requests.length, 1);
  assert.deepEqual(unsignedErrors, [], 'Mocked sign-in and manual connection recheck must complete without errors.');
  pass('Unsigned setup → mocked OpenAI authorization popup → explicit connection recheck → selected GPT conversation');

  const deniedContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await speechFixture(deniedContext, true);
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

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await speechFixture(mobile);
  const mobilePage = await mobile.newPage();
  const mobileErrors = watchErrors(mobilePage);
  await mockModel(mobilePage);
  await ready(mobilePage);
  assert.ok(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile viewport must not overflow horizontally.');
  await mobilePage.screenshot({ path: path.join(output, 'mobile-initial.png') });
  await connect(mobilePage);
  await typeTurn(mobilePage, 'Help me choose one action.', 'Dream Maker');
  await mobilePage.screenshot({ path: path.join(output, 'mobile-conversation.png') });
  assert.deepEqual(mobileErrors, [], 'Mobile must have no local JavaScript or console errors.');
  pass('Mobile entry, setup, typed conversation, and actual WebGL rendering');

  await fs.writeFile(path.join(output, 'browser-acceptance.json'), JSON.stringify({
    suite: 'Deterministic full-app acceptance',
    model: 'MOCKED ChatGPT subscription status, catalog and NDJSON responses', speech: 'MOCKED recognition and synthesis',
    authorization: 'MOCKED OpenAI popup page; no external account contacted',
    renderer: 'Real Chromium WebGL via SwiftShader',
    limitations: ['Does not validate physical microphone capture.', 'Does not validate live OAuth consent, subscription eligibility, or an actual GPT response.', 'The separate Ollama inference test exercises an optional fallback, not subscription inference.'],
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
