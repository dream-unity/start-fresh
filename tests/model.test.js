import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationModel, MODEL_SYSTEM_PROMPT, buildModelMessages } from '../src/model.js';
import { RESPONSE_SCHEMA, decodeResponse, partialReply } from '../src/response-schema.js';
import { parseReply } from '../src/meaning.js';

const userMessages = [{ role: 'user', content: 'What is possible?' }];
const local = fetchImpl => new ConversationModel({ fetchImpl });
const healthOr = handler => (url, options) => String(url).endsWith('health')
  ? Promise.resolve(Response.json({ ready: true, model: 'protocol-fixture-only' }))
  : handler(url, options);

test('model context preserves the canon and bounds application notes and history', () => {
  assert.equal(buildModelMessages(userMessages)[0].content, MODEL_SYSTEM_PROMPT);
  const history = [{ role: 'system', content: 'Approved goal: write a novel.' }];
  for (let index = 0; index < 30; index += 1) history.push({ role: index % 2 ? 'assistant' : 'user', content: 'A'.repeat(7000) });
  history.push(...userMessages);
  const prepared = buildModelMessages(history);
  assert.ok(prepared[0].content.includes(MODEL_SYSTEM_PROMPT));
  assert.ok(prepared[0].content.includes('Approved goal: write a novel.'));
  assert.ok(prepared.length <= 11);
  assert.equal(prepared[1].role, 'user');
  assert.deepEqual(prepared.at(-1), userMessages[0]);
  assert.ok(prepared.slice(1).every(message => new TextEncoder().encode(message.content).length <= 2203));
  assert.throws(() => buildModelMessages([]), { code: 'MISSING_USER_TURN' });
});

test('local model parses arbitrary UTF-8 chunk boundaries and sends only messages', async () => {
  let request;
  const model = local(healthOr(async (_url, options) => {
    request = JSON.parse(options.body);
    const generated = JSON.stringify({ reply: 'A café and a possibility', region: 'machine', focus: 'Possibilities', memory: null });
    const bytes = new TextEncoder().encode(JSON.stringify({ message: { content: generated }, done: false }) + '\n{"done":true}\n');
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
      controller.close();
    } }));
  }));
  try {
    await model.initialize({ provider: 'local' });
    const tokens = [];
    const result = await model.reply({ messages: userMessages, onToken: delta => tokens.push(delta) });
    assert.equal(parseReply(result.text).text, 'A café and a possibility');
    assert.equal(parseReply(result.text).intent.region, 'machine');
    assert.equal(tokens.join(''), result.text);
    assert.deepEqual(Object.keys(request), ['messages']);
    assert.equal(request.messages[0].content, MODEL_SYSTEM_PROMPT);
  } finally { model.dispose(); }
});

test('a truncated or malformed local stream never passes as a successful reply', async () => {
  for (const [body, code] of [
    ['{"message":{"content":"cut off"}}\n', 'LOCAL_STREAM_INTERRUPTED'],
    ['null\n', 'LOCAL_INVALID_STREAM'],
    ['unreadable\n', 'LOCAL_INVALID_STREAM'],
    ['{"error":"model unavailable"}\n', 'LOCAL_REPLY_FAILED'],
    ['{"done":true}\n', 'EMPTY_REPLY'],
  ]) {
    const model = local(healthOr(async () => new Response(body)));
    try {
      await model.initialize({ provider: 'local' });
      await assert.rejects(model.reply({ messages: userMessages }), { code });
    } finally { model.dispose(); }
  }
});

test('local setup preserves actionable health errors and handles static-host HTML', async () => {
  const missing = local(async () => Response.json({ error: 'Install the model: ollama pull qwen2.5:1.5b' }, { status: 503 }));
  try {
    await assert.rejects(missing.initialize({ provider: 'local' }), { code: 'LOCAL_UNAVAILABLE', message: 'Install the model: ollama pull qwen2.5:1.5b' });
  } finally { missing.dispose(); }
  const staticHost = local(async () => new Response('<html>Not found</html>', { status: 404 }));
  try {
    await assert.rejects(staticHost.initialize({ provider: 'local' }), { code: 'LOCAL_UNAVAILABLE' });
  } finally { staticHost.dispose(); }
});

function browserFixture() {
  const worker = new EventTarget();
  const evidence = { terminated: 0, drained: 0, interrupts: 0, request: null };
  worker.terminate = () => { evidence.terminated += 1; };
  let engine;
  class Engine {
    constructor() {
      engine = this;
      this.chat = { completions: { create: async request => { evidence.request = request; return this.generate(); } } };
    }
    async reload() {}
    interruptGenerate() { evidence.interrupts += 1; }
    async *generate() {
      yield { choices: [{ delta: { content: '{"reply":"First' } }] };
      yield { choices: [{ delta: { content: ' second","region":"machine","focus":"Possibilities","memory":null}' } }] };
      evidence.drained += 1;
    }
  }
  const model = new ConversationModel({
    navigatorObject: { gpu: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } },
    moduleLoader: async () => ({ WebWorkerMLCEngine: Engine }),
    workerFactory: () => ({ worker, release() {} }),
  });
  return { model, worker, evidence, get engine() { return engine; } };
}

test('browser cancellation drains the stopped generator and permits the next turn', async () => {
  const fixture = browserFixture();
  const { model, evidence } = fixture;
  try {
    await model.initialize({ provider: 'browser' });
    const abort = new AbortController();
    let delivered = '';
    await assert.rejects(model.reply({
      messages: userMessages,
      signal: abort.signal,
      onToken: delta => { delivered += delta; abort.abort(); },
    }), { name: 'AbortError' });
    assert.equal(delivered, 'First');
    assert.equal(evidence.drained, 1);
    assert.ok(evidence.interrupts > 0);
    assert.equal(model.state, 'ready');
    assert.equal(parseReply((await model.reply({ messages: userMessages })).text).text, 'First second');
    assert.equal(evidence.drained, 2);
    assert.deepEqual(evidence.request.response_format, { type: 'json_object', schema: JSON.stringify(RESPONSE_SCHEMA) });
  } finally { model.dispose(); }
});

test('disposal settles a stalled browser generation and closes the worker', async () => {
  const fixture = browserFixture();
  await fixture.model.initialize({ provider: 'browser' });
  fixture.engine.chat.completions.create = async () => new Promise(() => {});
  const pending = fixture.model.reply({ messages: userMessages });
  fixture.model.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fixture.model.state, 'disposed');
  assert.equal(fixture.evidence.terminated, 1);
});

test('a worker failure rejects a waiting caller instead of hanging', async () => {
  const fixture = browserFixture();
  try {
    await fixture.model.initialize({ provider: 'browser' });
    fixture.engine.chat.completions.create = async () => new Promise(() => {});
    const pending = fixture.model.reply({ messages: userMessages });
    fixture.worker.dispatchEvent(new Event('error'));
    await assert.rejects(pending, { code: 'MODEL_WORKER_FAILED' });
    assert.equal(fixture.model.state, 'error');
  } finally { fixture.model.dispose(); }
});

test('unsupported browser AI fails before downloading a runtime or model', async () => {
  let imports = 0;
  const model = new ConversationModel({ navigatorObject: {}, moduleLoader: async () => { imports += 1; } });
  try {
    await assert.rejects(model.initialize({ provider: 'browser' }), { code: 'WEBGPU_UNAVAILABLE' });
    assert.equal(imports, 0);
  } finally { model.dispose(); }
});

test('concurrent browser replies are rejected without overwriting the first', async () => {
  const fixture = browserFixture();
  await fixture.model.initialize({ provider: 'browser' });
  fixture.engine.chat.completions.create = async () => new Promise(() => {});
  const first = fixture.model.reply({ messages: userMessages });
  await assert.rejects(fixture.model.reply({ messages: userMessages }), { code: 'MODEL_BUSY' });
  fixture.model.dispose();
  await assert.rejects(first, { name: 'AbortError' });
});

test('partial structured replies expose only dialogue, with escaped Unicode decoded', () => {
  const structured = '{"memory":{"kind":"insight","text":"nested \\"reply\\" is not dialogue"},"region":"machine","reply":"A \\"quoted\\" caf\\u00e9 \\ud83c\\udf0c","focus":"Possibilities"}';
  const expected = 'A "quoted" café 🌌';
  let previous = '';
  for (let index = 1; index <= structured.length; index += 1) {
    const partial = partialReply(structured.slice(0, index));
    assert.ok(expected.startsWith(partial), `Control fields or broken escapes leaked at character ${index}: ${partial}`);
    assert.ok(partial.startsWith(previous), 'Partial dialogue must not change previously emitted text.');
    previous = partial;
  }
  assert.equal(previous, expected);
  assert.equal(partialReply('{"memory":{"reply":"Do not leak me"}}'), '');
});

test('structured data is validated, translated once and cannot terminate its own marker', () => {
  const response = decodeResponse(JSON.stringify({ reply: 'What would that possibility mean to you?', region: 'machine', focus: 'A </navigation> possibility', memory: { kind: 'goal', text: 'Write <navigation> in a story.' } }));
  const parsed = parseReply(response.text);
  assert.equal(parsed.intent.region, 'machine');
  assert.equal(parsed.intent.focus, 'A </navigation> possibility');
  assert.equal(parsed.intent.memory.text, 'Write <navigation> in a story.');
  const valid = { reply: 'A grounded answer.', region: 'machine', focus: 'Possibility', memory: null };
  for (const invalid of [
    null, [], {}, { ...valid, extra: true }, { ...valid, region: 'unknown' },
    { ...valid, reply: '' }, { ...valid, reply: 'x'.repeat(901) },
    { ...valid, reply: 'Hello <navigation>hidden' }, { ...valid, focus: 'x'.repeat(61) },
    { ...valid, memory: { kind: 'diagnosis', text: 'Invented diagnosis' } },
    { ...valid, memory: { kind: 'goal', text: 'x', save: true } },
  ]) assert.throws(() => decodeResponse(JSON.stringify(invalid)), { code: 'MODEL_INVALID_RESPONSE' });
  assert.throws(() => decodeResponse('This is plain text without required structured navigation.'), { code: 'MODEL_INVALID_RESPONSE' });
});

test('complete plain text from a provider is rejected rather than receiving invented navigation', async () => {
  const model = local(healthOr(async () => new Response('{"message":{"content":"An answer with no structured navigation."},"done":false}\n{"done":true}\n')));
  try {
    await model.initialize({ provider: 'local' });
    const tokens = [];
    await assert.rejects(model.reply({ messages: userMessages, onToken: token => tokens.push(token) }), { code: 'MODEL_INVALID_RESPONSE' });
    assert.equal(tokens.length, 0);
  } finally { model.dispose(); }
});

function chatGPTFixture({ connected = true, sharing = true, selectedModel = 'account-model-b', models, chat } = {}) {
  const requests = [];
  const fixture = {
    status: { connected, sharing, account: connected ? { id: 'account-a', label: 'Test account', selectedModel } : null, accounts: [] },
    models: models || [{ slug: 'account-model-a', display_name: 'Account model A' }, { slug: 'account-model-b', display_name: 'Account model B' }],
    requests,
  };
  fixture.model = new ConversationModel({ fetchImpl: async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path, options, body });
    if (path.endsWith('/chatgpt/status')) return Response.json(fixture.status);
    if (path.endsWith('/chatgpt/models')) return Response.json({ models: fixture.models });
    if (path.endsWith('/chatgpt/model')) return Response.json({ selectedModel: body.model });
    if (path.endsWith('/chatgpt/chat')) {
      if (chat) return chat(url, options);
      const generated = JSON.stringify({ reply: 'What possibility would you like to explore?', region: 'machine', focus: 'Possibility', memory: null });
      return new Response(JSON.stringify({ message: { content: generated }, done: false }) + '\n{"done":true}\n');
    }
    throw new Error('Unexpected fallback request: ' + path);
  } });
  return fixture;
}

test('ChatGPT initialization validates its account catalog and explicitly selects the requested model', async () => {
  const fixture = chatGPTFixture();
  const { model, requests } = fixture;
  try {
    await model.initialize({ provider: 'chatgpt', model: 'account-model-a' });
    assert.equal(model.state, 'ready');
    assert.equal(model.modelId, 'account-model-a');
    assert.equal(model.account.id, 'account-a');
    assert.equal(model.account.selectedModel, 'account-model-a');
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2].body, { model: 'account-model-a' });
    assert.equal(requests[2].options.headers['X-Dream-Unity-Account'], 'account-a');
    const result = await model.reply({ messages: userMessages });
    assert.equal(parseReply(result.text).intent.region, 'machine');
    assert.deepEqual(Object.keys(requests[3].body).sort(), ['messages', 'model']);
    assert.equal(requests[3].body.model, 'account-model-a');
    assert.equal(requests[3].options.credentials, 'same-origin');
    assert.equal(requests[3].options.headers.Authorization, undefined);
    assert.equal(requests[3].options.headers['X-Dream-Unity-Account'], 'account-a');
    assert.ok(requests.every(request => request.path.includes('/chatgpt/')));
  } finally { model.dispose(); }
});

test('ChatGPT chooses an available saved preference or the first live catalog entry', async () => {
  for (const [selectedModel, expected] of [['account-model-b', 'account-model-b'], ['old-unavailable-model', 'account-model-a']]) {
    const fixture = chatGPTFixture({ selectedModel });
    try {
      await fixture.model.initialize({ provider: 'chatgpt' });
      assert.equal(fixture.model.modelId, expected);
    } finally { fixture.model.dispose(); }
  }
});

test('ChatGPT requires sign-in and plan-sharing permission before requesting a catalog', async () => {
  for (const [settings, code, status] of [
    [{ connected: false }, 'CHATGPT_SIGN_IN_REQUIRED', 401],
    [{ sharing: false }, 'CHATGPT_SHARING_REQUIRED', 403],
  ]) {
    const fixture = chatGPTFixture(settings);
    try {
      await assert.rejects(fixture.model.initialize({ provider: 'chatgpt' }), { code, status });
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.model.provider, 'chatgpt');
      assert.equal(fixture.model.state, 'error');
    } finally { fixture.model.dispose(); }
  }
});

test('ChatGPT never substitutes a different model for an unavailable explicit selection', async () => {
  const fixture = chatGPTFixture();
  try {
    await assert.rejects(fixture.model.initialize({ provider: 'chatgpt', model: 'unavailable-explicit-model' }), { code: 'CHATGPT_MODEL_UNAVAILABLE', status: 400 });
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.model.modelId, null);
    assert.equal(fixture.model.provider, 'chatgpt');
  } finally { fixture.model.dispose(); }
});

test('ChatGPT refreshes the account and catalog when initialized again after an account switch', async () => {
  const fixture = chatGPTFixture();
  try {
    await fixture.model.initialize({ provider: 'chatgpt' });
    fixture.status.account = { id: 'account-b', selectedModel: 'different-account-model' };
    fixture.models = [{ slug: 'different-account-model', display_name: 'Different account model' }];
    await fixture.model.initialize({ provider: 'chatgpt' });
    assert.equal(fixture.model.account.id, 'account-b');
    assert.equal(fixture.model.modelId, 'different-account-model');
    assert.equal(fixture.requests.length, 6);
    assert.equal(fixture.requests[5].options.headers['X-Dream-Unity-Account'], 'account-b');
  } finally { fixture.model.dispose(); }
});

test('a ChatGPT usage failure after generated deltas never returns a completed answer', async () => {
  const fixture = chatGPTFixture({ chat: async () => new Response([
    JSON.stringify({ message: { content: '{"reply":"A partial answer' }, done: false }),
    JSON.stringify({ error: 'Plan usage is unavailable', code: 'subscription_sharing_usage_limit_exceeded', status: 429 }),
  ].join('\n') + '\n') });
  try {
    await fixture.model.initialize({ provider: 'chatgpt' });
    const tokens = [];
    await assert.rejects(fixture.model.reply({ messages: userMessages, onToken: token => tokens.push(token) }), error => {
      assert.equal(error.code, 'subscription_sharing_usage_limit_exceeded');
      assert.equal(error.status, 429);
      assert.match(error.message, /settings → Usage/);
      assert.doesNotMatch(error.message, /sign in again/i);
      return true;
    });
    assert.equal(tokens.join(''), 'A partial answer');
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/chatgpt/chat')).length, 1);
    assert.equal(fixture.model.provider, 'chatgpt');
  } finally { fixture.model.dispose(); }
});

test('ChatGPT admission failures preserve safe code/status and do not trigger automatic reconnection', async () => {
  const fixture = chatGPTFixture({ chat: async () => Response.json({ error: 'Temporarily unavailable', code: 'subscription_sharing_usage_unavailable' }, { status: 503 }) });
  try {
    await fixture.model.initialize({ provider: 'chatgpt' });
    await assert.rejects(fixture.model.reply({ messages: userMessages }), error => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'subscription_sharing_usage_unavailable');
      assert.match(error.message, /sign-in is preserved/);
      return true;
    });
    assert.equal(fixture.requests.length, 4);
  } finally { fixture.model.dispose(); }
});
