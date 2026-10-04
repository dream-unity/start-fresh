import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationModel } from '../src/model.js';
import { parseReply, conversationContext } from '../src/meaning.js';
import { generatePublicReply } from '../server/public-model.mjs';

const baseUrl = 'https://start-fresh.test';
const messages = [{ role: 'user', content: 'I have decided to write my novel.' }];
const answer = { reply: 'What is one small step you can take today?', region: 'maker', focus: 'Begin the novel', memory: { kind: 'goal', text: 'Write my novel.' } };
const ready = { ready: true, model: 'openai/gpt-4.1-mini' };

function fixture(handler = () => Response.json(answer)) {
  const requests = [];
  const model = new ConversationModel({ fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return new URL(url).searchParams.get('op') === 'status' ? Response.json(ready) : handler(url, options);
  } });
  return { model, requests };
}

test('public connection needs no account, provider selection, key or installation', async () => {
  const { model, requests } = fixture();
  const context = { region: 'machine', memory: [{ kind: 'insight', text: 'I enjoy writing.' }] };
  try {
    await model.initialize({ provider: 'public', baseUrl });
    assert.equal(model.state, 'ready');
    assert.equal(model.modelId, ready.model);
    assert.equal(model.account, null);
    const tokens = [];
    const result = await model.reply({ messages: [{ role: 'system', content: 'Do not send this privileged instruction.' }, ...messages], context, onToken: token => tokens.push(token) });
    const parsed = parseReply(result.text);
    assert.equal(parsed.text, answer.reply);
    assert.equal(parsed.intent.region, 'maker');
    assert.deepEqual(parsed.intent.memory, { ...answer.memory, region: answer.region });
    assert.equal(tokens.join(''), result.text);
    assert.deepEqual(requests.map(request => request.url), [`${baseUrl}/api/nexus?op=status`, `${baseUrl}/api/nexus?op=chat`]);
    assert.ok(requests.every(request => request.options.credentials === 'omit'));
    assert.ok(requests.every(request => request.options.cache === 'no-store'));
    assert.ok(requests.every(request => !Object.hasOwn(request.options.headers, 'Authorization')));
    assert.deepEqual(JSON.parse(requests[1].options.body), { messages, context });
  } finally { model.dispose(); }
});

test('public replies omit context unless the application explicitly includes it', async () => {
  const { model, requests } = fixture();
  try {
    await model.initialize({ provider: 'public', baseUrl });
    await model.reply({ messages });
    assert.deepEqual(JSON.parse(requests[1].options.body), { messages });
  } finally { model.dispose(); }
});

test('an empty or omitted public base uses the site root without duplicating api', async () => {
  for (const base of ['', undefined]) {
    const urls = [];
    const model = new ConversationModel({ localBaseURL: new URL('https://start-fresh.test/api/'), fetchImpl: async url => {
      urls.push(String(url));
      return Response.json(new URL(url).searchParams.get('op') === 'status' ? ready : answer);
    } });
    try {
      await model.initialize({ provider: 'public', baseUrl: base });
      await model.reply({ messages });
      assert.deepEqual(urls, ['https://start-fresh.test/api/nexus?op=status', 'https://start-fresh.test/api/nexus?op=chat']);
    } finally { model.dispose(); }
  }
});

test('public transcription requires an explicit current capability and resets on failed setup', async () => {
  let status = { ...ready, transcription: true };
  const model = new ConversationModel({ fetchImpl: async () => Response.json(status) });
  try {
    assert.equal(model.transcriptionReady, false);
    await model.initialize({ provider: 'public', baseUrl });
    assert.equal(model.transcriptionReady, true);
    status = { ...ready, transcription: 'true' };
    await model.initialize({ provider: 'public', baseUrl });
    assert.equal(model.transcriptionReady, false);
    status = { ...ready, transcription: true };
    await model.initialize({ provider: 'public', baseUrl });
    status = { ready: false };
    await assert.rejects(model.initialize({ provider: 'public', baseUrl }));
    assert.equal(model.transcriptionReady, false);
  } finally { model.dispose(); }
});

test('real conversationContext notes fit the public backend without losing newest meaning or mutating stored notes', async () => {
  const nodes = Array.from({ length: 24 }, (_, index) => ({ kind: 'goal', text: `Note ${index}: ${'🌌'.repeat(300)}`, region: 'maker' }));
  nodes[23].text = 'Write the opening paragraph of my novel.';
  const original = structuredClone(nodes);
  const context = conversationContext(messages, nodes);
  let sent;
  const { model } = fixture(async (_url, options) => {
    sent = JSON.parse(options.body);
    // Exercise the actual server validator rather than another permissive mock.
    const result = await generatePublicReply({ ...sent, token: 'fixture-not-a-credential', fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] }) });
    return Response.json(result);
  });
  try {
    await model.initialize({ provider: 'public', baseUrl });
    await model.reply({ messages: context.recent, context: { region: 'maker', memory: context.memory } });
    assert.deepEqual(nodes, original);
    assert.ok(sent.context.memory.length > 1 && sent.context.memory.length <= 12);
    assert.ok(new TextEncoder().encode(JSON.stringify(sent.context)).length <= 3500);
    assert.deepEqual(sent.context.memory.at(-1), { kind: 'goal', text: nodes[23].text });
    assert.ok(sent.context.memory.every(note => Object.keys(note).length === 2 && note.text.length <= 300));
    assert.ok(sent.context.memory.every(note => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(note.text)));
  } finally { model.dispose(); }
});

test('public readiness is rechecked when the configured backend changes', async () => {
  const { model, requests } = fixture();
  try {
    await model.initialize({ provider: 'public', baseUrl });
    await model.initialize({ provider: 'public', baseUrl: 'https://another-start-fresh.test' });
    await model.reply({ messages });
    assert.equal(requests[2].url, 'https://another-start-fresh.test/api/nexus?op=chat');
    assert.equal(requests.filter(request => request.url.endsWith('op=status')).length, 2);
  } finally { model.dispose(); }
});

test('public startup rejects insecure credentials, invalid status and unavailable backends', async () => {
  for (const url of ['http://public.example', 'https://credential@example.test', 'https://example.test/?token=secret', 'file:///tmp/site']) {
    const model = new ConversationModel({ fetchImpl: async () => assert.fail('Insecure addresses must not be requested.') });
    try { await assert.rejects(model.initialize({ provider: 'public', baseUrl: url }), { code: 'PUBLIC_CONFIGURATION_REQUIRED' }); }
    finally { model.dispose(); }
  }
  for (const [response, expected] of [
    [Response.json({ ready: false, code: 'PUBLIC_ALLOWANCE_EXHAUSTED', error: 'The site allowance has been used up.' }, { status: 503 }), { code: 'PUBLIC_ALLOWANCE_EXHAUSTED', status: 503 }],
    [new Response('<html>No route</html>', { status: 404 }), { code: 'PUBLIC_UNAVAILABLE', status: 404 }],
    [Response.json({ ready: true, model: 'arbitrary-model' }), { code: 'PUBLIC_INVALID_RESPONSE' }],
  ]) {
    const model = new ConversationModel({ fetchImpl: async () => response });
    try { await assert.rejects(model.initialize({ provider: 'public', baseUrl }), expected); assert.equal(model.state, 'error'); }
    finally { model.dispose(); }
  }
});

test('public answer failures preserve safe server codes and never emit synthetic navigation', async () => {
  for (const [response, code] of [
    [Response.json({ error: 'Please wait a moment.', code: 'PUBLIC_RATE_LIMITED' }, { status: 429 }), 'PUBLIC_RATE_LIMITED'],
    [Response.json({ ...answer, region: 'unknown' }), 'MODEL_INVALID_RESPONSE'],
    [Response.json({ reply: 'An answer without structured navigation.' }), 'MODEL_INVALID_RESPONSE'],
    [new Response('<html>Error</html>'), 'MODEL_INVALID_RESPONSE'],
  ]) {
    const { model, requests } = fixture(() => response);
    const tokens = [];
    try {
      await model.initialize({ provider: 'public', baseUrl });
      await assert.rejects(model.reply({ messages, onToken: token => tokens.push(token) }), { code });
      assert.equal(tokens.length, 0);
      assert.equal(requests.length, 2, 'No automatic billed retry or fallback.');
      assert.equal(model.provider, 'public');
    } finally { model.dispose(); }
  }
});

test('public cancellation settles a stalled request and permits a later answer', async () => {
  let calls = 0;
  let upstream;
  const { model } = fixture((_url, options) => {
    calls += 1;
    upstream = options.signal;
    return calls === 1 ? new Promise(() => {}) : Response.json(answer);
  });
  try {
    await model.initialize({ provider: 'public', baseUrl });
    const stopped = new AbortController();
    const first = model.reply({ messages, signal: stopped.signal });
    stopped.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(upstream.aborted, true);
    assert.equal(model.state, 'ready');
    assert.equal(parseReply((await model.reply({ messages })).text).text, answer.reply);
  } finally { model.dispose(); }
});

test('interrupting public setup prevents a late successful response from re-enabling it', async () => {
  let finish;
  const model = new ConversationModel({ fetchImpl: async () => new Promise(resolve => { finish = resolve; }) });
  try {
    const loading = model.initialize({ provider: 'public', baseUrl });
    model.interrupt();
    await assert.rejects(loading, { name: 'AbortError' });
    finish(Response.json(ready));
    await Promise.resolve();
    assert.equal(model.state, 'idle');
    assert.equal(model.modelId, null);
  } finally { model.dispose(); }
});
