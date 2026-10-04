import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstellation, MEMORY_KEY, MEMORY_LIMITS } from '../src/memory.js';

function makeStorage() {
  const data = new Map();
  return {
    data,
    reads: 0,
    writes: 0,
    failWrite: false,
    failRemove: false,
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) { this.reads += 1; return data.get(key) ?? null; },
    setItem(key, value) { if (this.failWrite) throw new Error('Quota exceeded'); this.writes += 1; data.set(key, String(value)); },
    removeItem(key) { if (this.failRemove) throw new Error('Permission denied'); data.delete(key); },
  };
}
const add = (memory, text, extra = {}) => memory.add({ text, kind: 'goal', region: 'maker', ...extra });

test('first visit remains session-only and does not write notes', () => {
  const storage = makeStorage();
  const memory = createConstellation({ storage });
  assert.equal(add(memory, 'Make time to create').ok, true);
  assert.equal(memory.getSnapshot().mode, 'session');
  assert.equal(storage.writes, 0);
  assert.equal(storage.reads, 0);
  assert.equal(createConstellation({ storage }).getSnapshot().nodes.length, 0);
});

test('saved notes are neither read nor exposed before explicit consent', () => {
  const storage = makeStorage();
  const previous = createConstellation({ storage });
  add(previous, 'A private project');
  previous.setMode('device');
  storage.reads = 0;
  const next = createConstellation({ storage });
  assert.equal(next.getSnapshot().hasSaved, true);
  assert.deepEqual(next.getSnapshot().nodes, []);
  assert.equal(storage.reads, 0);
  next.setMode('session');
  next.clear();
  assert.ok(storage.data.has(MEMORY_KEY), 'new session controls must not erase a saved copy before loading it');
  assert.equal(next.loadSaved().ok, true);
  assert.equal(next.getSnapshot().nodes[0].text, 'A private project');
  assert.equal(next.getSnapshot().mode, 'device');
});

test('remembering merges existing saved notes with current session', () => {
  const storage = makeStorage();
  const previous = createConstellation({ storage });
  add(previous, 'Yesterday');
  previous.setMode('device');
  const next = createConstellation({ storage });
  add(next, 'Today');
  assert.equal(next.setMode('device').ok, true);
  assert.deepEqual(next.getSnapshot().nodes.map((node) => node.text), ['Yesterday', 'Today']);
  assert.equal(createConstellation({ storage }).loadSaved().snapshot.nodes.length, 2);
});

test('switching from device to session removes saved copy but retains current notes', () => {
  const storage = makeStorage();
  const memory = createConstellation({ storage });
  add(memory, 'Keep only while here');
  memory.setMode('device');
  const result = memory.setMode('session');
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.mode, 'session');
  assert.equal(result.snapshot.hasSaved, false);
  assert.equal(result.snapshot.nodes.length, 1);
  assert.equal(storage.data.has(MEMORY_KEY), false);
  add(memory, 'Another temporary note');
  assert.equal(storage.data.has(MEMORY_KEY), false);
});

test('corrupt saved data is never overwritten when opting into device storage', () => {
  const storage = makeStorage();
  storage.data.set(MEMORY_KEY, '{corrupt');
  const memory = createConstellation({ storage });
  add(memory, 'Current work');
  const result = memory.setMode('device');
  assert.equal(result.ok, false);
  assert.match(result.error, /not been overwritten/);
  assert.equal(storage.data.get(MEMORY_KEY), '{corrupt');
  assert.equal(result.snapshot.mode, 'session');
  assert.equal(result.snapshot.nodes[0].text, 'Current work');
});

test('failed write preserves notes in session and reports that saved copy may remain', () => {
  const storage = makeStorage();
  const memory = createConstellation({ storage });
  add(memory, 'First');
  memory.setMode('device');
  storage.failWrite = true;
  const result = add(memory, 'Second');
  assert.equal(result.ok, false);
  assert.equal(result.snapshot.mode, 'session');
  assert.equal(result.snapshot.nodes.length, 2);
  assert.equal(result.snapshot.availableDevice, false);
  assert.equal(result.snapshot.hasSaved, true);
  assert.match(result.error, /older saved copy may remain/i);
  assert.equal(JSON.parse(memory.exportJSON()).nodes.length, 2);
  const continuing = add(memory, 'Continue in this session');
  assert.equal(continuing.ok, true);
  assert.match(continuing.snapshot.error, /older saved copy may remain/i, 'privacy warning survives later successful session edits');
});

test('failed removal never falsely claims the device copy was erased', () => {
  const storage = makeStorage();
  const memory = createConstellation({ storage });
  add(memory, 'A note');
  memory.setMode('device');
  storage.failRemove = true;
  const result = memory.setMode('session');
  assert.equal(result.ok, false);
  assert.equal(result.snapshot.mode, 'session');
  assert.equal(result.snapshot.hasSaved, true);
  assert.match(result.error, /could not be removed/);
});

test('absent or blocked device storage leaves a fully usable session constellation', () => {
  for (const storage of [null, { getItem() { throw new Error('Blocked'); }, setItem() {}, removeItem() {} }]) {
    const memory = createConstellation({ storage });
    assert.equal(add(memory, 'Session notes still work').ok, true);
    assert.equal(memory.setMode('device').ok, false);
    assert.equal(memory.getSnapshot().mode, 'session');
    assert.equal(memory.getSnapshot().nodes.length, 1);
  }
});

test('update and removal preserve valid relationships and immutable identifiers', () => {
  const memory = createConstellation({ storage: null });
  const first = add(memory, 'Find a direction').node;
  const second = add(memory, 'Try a first step', { kind: 'action', links: [first.id] }).node;
  const updated = memory.update(first.id, { id: 'untrusted-replacement', text: 'Explore a direction', kind: 'project' });
  assert.equal(updated.ok, true);
  assert.equal(updated.node.id, first.id);
  assert.equal(memory.getSnapshot().nodes[1].links[0], first.id);
  memory.remove(first.id);
  assert.deepEqual(memory.getSnapshot().nodes, [{ ...second, links: [], updatedAt: memory.getSnapshot().nodes[0].updatedAt }]);
  assert.equal(memory.update(second.id, { links: ['missing'] }).ok, false);
  assert.deepEqual(memory.getSnapshot().nodes[0].links, []);
});

test('snapshots and callbacks cannot mutate stored constellation nodes', () => {
  const memory = createConstellation({ storage: null, onChange(snapshot) { snapshot.nodes.length = 0; } });
  const first = add(memory, 'A direction').node;
  const added = add(memory, 'A step', { links: [first.id] });
  assert.equal(added.snapshot.nodes.length, 2, 'callback receives its own defensive snapshot');
  const snapshot = memory.getSnapshot();
  snapshot.nodes[0].text = 'Mutated';
  snapshot.nodes[1].links.push('missing');
  assert.equal(memory.getSnapshot().nodes[0].text, 'A direction');
  assert.deepEqual(memory.getSnapshot().nodes[1].links, [first.id]);
});

test('versioned export imports with links and explicit replacement', () => {
  const source = createConstellation({ storage: null });
  const first = add(source, 'Recognise a pattern', { kind: 'insight', region: 'machine' }).node;
  add(source, 'A tension to explore', { kind: 'tension', region: 'world', links: [first.id] });
  const target = createConstellation({ storage: null });
  add(target, 'An existing note');
  assert.equal(target.importJSON(source.exportJSON()).ok, true);
  assert.equal(target.getSnapshot().nodes.length, 3);
  assert.equal(target.importJSON(source.exportJSON()).snapshot.nodes.length, 3, 'reimport merges by ID');
  assert.equal(target.importJSON(source.exportJSON(), { replace: true }).ok, true);
  assert.deepEqual(target.getSnapshot().nodes, source.getSnapshot().nodes);
});

test('invalid and oversized imports are rejected atomically', () => {
  const memory = createConstellation({ storage: null });
  add(memory, 'Keep me');
  const before = memory.exportJSON();
  const document = JSON.parse(before);
  const bad = [
    '{broken',
    JSON.stringify({ ...document, version: 42 }),
    JSON.stringify({ ...document, nodes: [...document.nodes, ...document.nodes] }),
    JSON.stringify({ ...document, nodes: [{ ...document.nodes[0], text: 'x'.repeat(MEMORY_LIMITS.text + 1) }] }),
    JSON.stringify({ ...document, nodes: [{ ...document.nodes[0], links: ['absent'] }] }),
    JSON.stringify({ ...document, nodes: [{ ...document.nodes[0], region: 'arbitrary' }] }),
    JSON.stringify({ ...document, nodes: [{ ...document.nodes[0], createdAt: 'not a date' }] }),
    'x'.repeat(MEMORY_LIMITS.bytes + 1),
  ];
  for (const input of bad) {
    assert.equal(memory.importJSON(input, { replace: true }).ok, false);
    assert.equal(memory.exportJSON(), before);
  }
});

test('clear removes the opted-in device copy', () => {
  const storage = makeStorage();
  const memory = createConstellation({ storage });
  add(memory, 'Clear me');
  memory.setMode('device');
  assert.equal(memory.clear().ok, true);
  assert.equal(memory.getSnapshot().mode, 'device');
  assert.equal(memory.getSnapshot().hasSaved, false);
  assert.equal(storage.data.has(MEMORY_KEY), false);
  assert.deepEqual(memory.getSnapshot().nodes, []);
});

test('archive and recover preserve abandoned possibilities and their relationships', () => {
  const memory = createConstellation({ storage: null });
  const possibility = add(memory, 'Explore a different direction', { region: 'machine' }).node;
  const project = add(memory, 'A related experiment', { kind: 'project', links: [possibility.id] }).node;
  assert.equal(possibility.archived, false);
  const archived = memory.update(possibility.id, { archived: true });
  assert.equal(archived.ok, true);
  assert.equal(archived.node.archived, true);
  assert.equal(memory.getSnapshot().nodes.length, 2, 'archiving keeps the note recoverable');
  assert.deepEqual(memory.getSnapshot().nodes.find((node) => node.id === project.id).links, [possibility.id]);

  const imported = createConstellation({ storage: null });
  assert.equal(imported.importJSON(memory.exportJSON()).ok, true);
  assert.equal(imported.getSnapshot().nodes.find((node) => node.id === possibility.id).archived, true);
  const recovered = imported.update(possibility.id, { archived: false });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.node.archived, false);
  assert.equal(recovered.node.text, possibility.text);
  assert.equal(recovered.node.createdAt, possibility.createdAt);
  assert.deepEqual(imported.getSnapshot().nodes.find((node) => node.id === project.id).links, [possibility.id]);
});

test('version 1 notes without an archived field import as active notes', () => {
  const source = createConstellation({ storage: null });
  add(source, 'A note from the original schema');
  const legacy = JSON.parse(source.exportJSON());
  delete legacy.nodes[0].archived;
  const restored = createConstellation({ storage: null });
  assert.equal(restored.importJSON(JSON.stringify(legacy)).ok, true);
  assert.equal(restored.getSnapshot().nodes[0].archived, false);
  assert.equal(JSON.parse(restored.exportJSON()).nodes[0].archived, false);
});

test('invalid archive values cannot silently hide notes', () => {
  const memory = createConstellation({ storage: null });
  const note = add(memory, 'Keep visible').node;
  for (const archived of ['true', 1, null, {}]) {
    assert.equal(memory.update(note.id, { archived }).ok, false);
    assert.equal(memory.getSnapshot().nodes[0].archived, false);
    const document = JSON.parse(memory.exportJSON());
    document.nodes[0].archived = archived;
    assert.equal(memory.importJSON(JSON.stringify(document), { replace: true }).ok, false);
    assert.equal(memory.getSnapshot().nodes[0].archived, false);
  }
});

test('deleted saved notes stay deleted after restoring a later session', () => {
  const storage = makeStorage();
  const memory = createConstellation({ storage });
  const removed = add(memory, 'Remove this personal detail').node;
  const retained = add(memory, 'Keep the next step', { links: [removed.id] }).node;
  assert.equal(memory.setMode('device').ok, true);
  assert.equal(memory.remove(removed.id).ok, true);
  const reopened = createConstellation({ storage });
  assert.equal(reopened.loadSaved().ok, true);
  assert.deepEqual(reopened.getSnapshot().nodes.map((node) => node.id), [retained.id]);
  assert.deepEqual(reopened.getSnapshot().nodes[0].links, []);
  assert.equal(storage.data.get(MEMORY_KEY).includes('Remove this personal detail'), false);
});

test('archived device notes can be restored and recovered without duplication', () => {
  const storage = makeStorage();
  const original = createConstellation({ storage });
  const note = add(original, 'An abandoned possibility', { region: 'machine' }).node;
  original.setMode('device');
  assert.equal(original.update(note.id, { archived: true }).ok, true);
  const restored = createConstellation({ storage });
  assert.equal(restored.loadSaved().ok, true);
  assert.equal(restored.getSnapshot().nodes[0].archived, true);
  assert.equal(restored.update(note.id, { archived: false }).ok, true);
  const next = createConstellation({ storage });
  const snapshot = next.loadSaved().snapshot;
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.nodes[0].id, note.id);
  assert.equal(snapshot.nodes[0].archived, false);
});
