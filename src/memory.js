/**
 * An explicitly consented, local constellation. Construction is session-only:
 * saved notes are never parsed or added until loadSaved()/setMode('device').
 * This module never sends notes to a network or saves conversation transcripts.
 */
export const MEMORY_KEY = 'dream-unity.start-fresh.constellation.v1';
export const MEMORY_VERSION = 1;
export const MEMORY_LIMITS = Object.freeze({ nodes: 250, text: 2000, links: 50, bytes: 1_048_576 });
const FORMAT = 'dream-unity-constellation';
const KINDS = new Set(['goal', 'insight', 'tension', 'project', 'action']);
const REGIONS = new Set(['unity', 'machine', 'maker', 'world']);
const copyNode = (node) => ({ ...node, links: [...node.links] });
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validID = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const validDate = (value) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const now = () => new Date().toISOString();
let sequence = 0;

function newID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  sequence += 1;
  return `node-${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getDefaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function validateNode(input) {
  if (!isRecord(input) || !validID(input.id)) throw new Error('Every note needs a valid identifier.');
  if (!KINDS.has(input.kind)) throw new Error('Choose goal, insight, tension, project, or action.');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MEMORY_LIMITS.text) {
    throw new Error(`Each note must contain 1–${MEMORY_LIMITS.text} characters.`);
  }
  if (!REGIONS.has(input.region)) throw new Error('Choose Unity, Dream Machine, Dream Maker, or Dream World.');
  if (input.archived !== undefined && typeof input.archived !== 'boolean') throw new Error('Archived must be true or false.');
  if (!validDate(input.createdAt) || !validDate(input.updatedAt)) throw new Error('A note has an invalid date.');
  if (!Array.isArray(input.links) || input.links.length > MEMORY_LIMITS.links || input.links.some((id) => !validID(id))) {
    throw new Error(`Each note can link to up to ${MEMORY_LIMITS.links} valid notes.`);
  }
  return {
    id: input.id,
    kind: input.kind,
    text: input.text.trim(),
    region: input.region,
    archived: input.archived ?? false,
    createdAt: new Date(input.createdAt).toISOString(),
    updatedAt: new Date(input.updatedAt).toISOString(),
    links: [...new Set(input.links)].filter((id) => id !== input.id),
  };
}

function validateLinks(nodes) {
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    if (node.links.some((id) => !ids.has(id))) throw new Error('A note links to an identifier that is not in this constellation.');
  }
  if (new TextEncoder().encode(serialize(nodes)).length > MEMORY_LIMITS.bytes) {
    throw new Error('This constellation is larger than 1 MB. Export or shorten existing notes before adding more.');
  }
}

function parseDocument(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MEMORY_LIMITS.bytes) {
    throw new Error('Choose a constellation JSON file smaller than 1 MB.');
  }
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('This file is not valid JSON.'); }
  if (!isRecord(value) || value.format !== FORMAT || value.version !== MEMORY_VERSION || !Array.isArray(value.nodes)) {
    throw new Error('This is not a supported Dream Unity constellation file (version 1).');
  }
  if (value.nodes.length > MEMORY_LIMITS.nodes) throw new Error(`A constellation can contain up to ${MEMORY_LIMITS.nodes} notes.`);
  const nodes = value.nodes.map(validateNode);
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error('This file contains duplicate note identifiers.');
  validateLinks(nodes);
  return nodes;
}

function serialize(nodes) {
  return JSON.stringify({ format: FORMAT, version: MEMORY_VERSION, nodes }, null, 2);
}

/** Incoming entries replace matching IDs only following an explicit load/import. */
function mergeNodes(existing, incoming) {
  const merged = new Map(existing.map((node) => [node.id, node]));
  for (const node of incoming) merged.set(node.id, node);
  const result = [...merged.values()];
  if (result.length > MEMORY_LIMITS.nodes) throw new Error(`A constellation can contain up to ${MEMORY_LIMITS.nodes} notes. Export or remove notes before adding more.`);
  validateLinks(result);
  return result;
}

export function createConstellation(options = {}) {
  const storage = Object.prototype.hasOwnProperty.call(options, 'storage') ? options.storage : getDefaultStorage();
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  let availableDevice = Boolean(storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' && typeof storage.removeItem === 'function');
  let mode = 'session';
  let nodes = [];
  let hasSaved = false;
  let error = null;
  let storageWarning = null;

  // Detect the presence of a saved copy without deserializing or using its notes.
  if (availableDevice) {
    try {
      if (typeof storage.key === 'function' && Number.isFinite(storage.length)) {
        for (let index = 0; index < storage.length; index += 1) {
          if (storage.key(index) === MEMORY_KEY) { hasSaved = true; break; }
        }
      } else {
        hasSaved = storage.getItem(MEMORY_KEY) !== null;
      }
    } catch { availableDevice = false; }
  }

  function getSnapshot() {
    return { mode, nodes: nodes.map(copyNode), availableDevice, hasSaved, error: error ?? storageWarning };
  }

  function result(ok = true, extra = {}) {
    const snapshot = getSnapshot();
    onChange(getSnapshot());
    return { ok, snapshot, ...(snapshot.error ? { error: snapshot.error } : {}), ...extra };
  }

  function fail(message) {
    error = message;
    return result(false);
  }

  function save() {
    if (mode !== 'device') return true;
    try {
      if (nodes.length) {
        storage.setItem(MEMORY_KEY, serialize(nodes));
        hasSaved = true;
      } else {
        storage.removeItem(MEMORY_KEY);
        hasSaved = false;
      }
      return true;
    } catch {
      mode = 'session';
      availableDevice = false;
      storageWarning = 'Device storage could not be updated. Your current notes are kept for this session only. An older saved copy may remain on this device; export your current notes before closing.';
      return false;
    }
  }

  function activateDevice() {
    if (!availableDevice) return fail('Device storage is unavailable. Your notes stay in this session; you can export a copy.');
    let merged;
    try {
      const saved = storage.getItem(MEMORY_KEY);
      hasSaved = saved !== null;
      merged = saved === null ? nodes : mergeNodes(parseDocument(saved), nodes);
    } catch (cause) {
      return fail(`Saved notes could not be loaded, so they have not been overwritten. ${cause instanceof Error ? cause.message : 'Storage could not be read.'}`);
    }
    nodes = merged;
    mode = 'device';
    error = null;
    storageWarning = null;
    return result(save());
  }

  return {
    getSnapshot,
    setMode(nextMode) {
      if (nextMode !== 'device' && nextMode !== 'session') return fail('Choose session-only or remember on this device.');
      if (nextMode === 'device') return activateDevice();
      error = null;
      // A fresh session must not erase an unrelated saved constellation before consent.
      if (mode === 'session') return result();
      mode = 'session';
      try {
        storage.removeItem(MEMORY_KEY);
        hasSaved = false;
      } catch {
        availableDevice = false;
        storageWarning = 'Your current notes are now session-only, but the saved copy could not be removed. Clear this site’s browser storage to remove that copy.';
        return result(false);
      }
      return result();
    },
    loadSaved: activateDevice,
    add(input) {
      try {
        if (!isRecord(input)) throw new Error('Provide a note to save.');
        if (nodes.length >= MEMORY_LIMITS.nodes) throw new Error(`A constellation can contain up to ${MEMORY_LIMITS.nodes} notes.`);
        const timestamp = now();
        const node = validateNode({ id: newID(), kind: input.kind ?? 'insight', text: input.text, region: input.region ?? 'unity', archived: input.archived, createdAt: timestamp, updatedAt: timestamp, links: input.links ?? [] });
        validateLinks([...nodes, node]);
        nodes = [...nodes, node];
        error = null;
        return result(save(), { node: copyNode(node) });
      } catch (cause) { return fail(cause.message); }
    },
    update(id, patch) {
      const index = nodes.findIndex((node) => node.id === id);
      if (index < 0) return fail('That note could not be found.');
      try {
        if (!isRecord(patch)) throw new Error('Provide the fields you want to change.');
        const previous = nodes[index];
        const node = validateNode({
          ...previous,
          kind: patch.kind ?? previous.kind,
          text: patch.text ?? previous.text,
          region: patch.region ?? previous.region,
          archived: Object.prototype.hasOwnProperty.call(patch, 'archived') ? patch.archived : previous.archived,
          links: patch.links ?? previous.links,
          updatedAt: now(),
        });
        const next = nodes.map((entry, position) => position === index ? node : entry);
        validateLinks(next);
        nodes = next;
        error = null;
        return result(save(), { node: copyNode(node) });
      } catch (cause) { return fail(cause.message); }
    },
    remove(id) {
      if (!nodes.some((node) => node.id === id)) return fail('That note could not be found.');
      nodes = nodes.filter((node) => node.id !== id).map((node) => node.links.includes(id) ? { ...node, links: node.links.filter((link) => link !== id), updatedAt: now() } : node);
      error = null;
      return result(save());
    },
    clear() {
      nodes = [];
      error = null;
      return result(save());
    },
    exportJSON() { return serialize(nodes); },
    importJSON(text, { replace = false } = {}) {
      try {
        const imported = parseDocument(text);
        const next = replace ? imported : mergeNodes(nodes, imported);
        nodes = next;
        error = null;
        return result(save());
      } catch (cause) { return fail(cause.message); }
    },
  };
}
