import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createAppServer } from '../server.mjs';
import { ConversationModel } from '../src/model.js';
import { parseReply } from '../src/meaning.js';

// This is deliberately not part of the offline fixture suite. It requires a real
// installed Ollama model and fails if generation or semantic navigation fails.
const configuredModel = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';
const server = createAppServer({ model: configuredModel });
const results = [];
const evidence = {
  kind: 'real-local-model-inference',
  startedAt: new Date().toISOString(),
  model: configuredModel,
  syntheticInputsOnly: true,
  cases: results,
  passed: false,
};
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 300_000);
let model;
const started = Date.now();

const cases = [
  {
    name: 'possibilities move toward Dream Machine',
    input: 'I do not know what I want to do with my life. I am torn between writing a novel and studying architecture, and want to explore those possibilities before choosing.',
    region: 'machine',
    relevant: /possibil|explor|writ|novel|architect|choos|option|creativ/i,
  },
  {
    name: 'a chosen goal moves toward Dream Maker',
    input: 'Actually I do know now: writing the novel is my goal. I keep postponing its first page. Help me choose one small action I can take tonight.',
    region: 'maker',
    relevant: /writ|novel|page|tonight|step|minute|action|start/i,
  },
  {
    name: 'an encountered constraint moves toward Dream World',
    input: 'I tried writing tonight, but my shift ended late and the library was closed. My plan collided with working hours and access to a quiet place. Let us examine the real constraints and what actually happened.',
    region: 'world',
    relevant: /librar|shift|hour|quiet|constraint|work|schedule|realit/i,
  },
  {
    name: 'conversation retains the chosen project and accepts correction',
    input: 'Correction: the library was open; I misread the hours. What project did I choose earlier, and what did I get wrong about the library? Please use that correction in your answer.',
    validate(text) {
      assert.match(text, /novel/i, 'The model must recover the chosen project from prior turns.');
      assert.match(text, /librar/i, 'The model must address the corrected circumstance.');
      assert.match(text, /open|misread|mistak|incorrect|wrong/i, 'The model must accept the correction, not repeat the closed-library assumption.');
    },
  },
];

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  model = new ConversationModel({
    localBaseURL: new URL('/api/', origin),
    fetchImpl: (url, options = {}) => {
      const headers = new Headers(options.headers);
      headers.set('Origin', origin);
      return fetch(url, { ...options, headers });
    },
  });
  await model.initialize({ provider: 'local' });
  assert.equal(model.modelId, configuredModel);
  const history = [];
  for (const sample of cases) {
    if (controller.signal.aborted) throw new Error('Real inference smoke exceeded five minutes.');
    history.push({ role: 'user', content: sample.input });
    let chunks = 0;
    const turnStarted = Date.now();
    const { text: raw } = await model.reply({
      messages: history,
      signal: controller.signal,
      onToken: () => { chunks += 1; },
    });
    const { text, intent } = parseReply(raw);
    const record = {
      name: sample.name,
      input: sample.input,
      output: raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''),
      text,
      intent,
      streamedChunks: chunks,
      durationMs: Date.now() - turnStarted,
      passed: false,
    };
    results.push(record);
    assert.ok(chunks > 0, 'The actual runtime must stream generated content.');
    assert.ok(text.trim().length >= 20, 'An answer must contain substantive generated dialogue.');
    assert.ok(intent, 'The actual model must produce a parseable navigation marker.');
    assert.ok(intent.focus.trim().length > 0, 'The navigation marker must contain a focus.');
    if (sample.region) assert.equal(intent.region, sample.region, sample.name);
    if (sample.relevant) assert.match(text, sample.relevant, 'The answer must address this specific turn.');
    sample.validate?.(text);
    record.passed = true;
    history.push({ role: 'assistant', content: raw });
    console.log(JSON.stringify({ case: sample.name, region: intent.region, text, durationMs: record.durationMs }));
  }
  assert.equal(new Set(results.slice(0, 3).map(result => result.intent.region)).size, 3);
  assert.equal(new Set(results.map(result => result.text)).size, cases.length, 'The runtime must not repeat a canned response.');
  evidence.passed = true;
  console.log(`PASS: ${results.length} actual conversational model turns with semantic scene routing and correction.`);
} catch (cause) {
  evidence.error = String(cause?.message || cause);
  console.error(`FAIL: ${evidence.error}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  controller.abort();
  model?.dispose();
  server.abortActiveRequests();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  evidence.durationMs = Date.now() - started;
  await mkdir(new URL('../output/', import.meta.url), { recursive: true });
  await writeFile(new URL('../output/inference.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
}
