// Shared by ChatGPT, browser inference and the local Ollama server. The server owns
// this schema; a client cannot weaken it through a request field.
export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', minLength: 1, maxLength: 900, description: 'Two or three concise, grounded sentences answering the person. No interface instructions.' },
    region: { type: 'string', enum: ['machine', 'maker', 'world', 'unity'] },
    focus: { type: 'string', minLength: 1, maxLength: 60 },
    memory: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['goal', 'insight', 'tension', 'project', 'action'] },
            text: { type: 'string', minLength: 1, maxLength: 300 },
          },
          required: ['kind', 'text'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['reply', 'region', 'focus', 'memory'],
  additionalProperties: false,
};

function invalid() {
  return Object.assign(new Error('The model returned an incomplete or invalid answer. Please try again.'), { code: 'MODEL_INVALID_RESPONSE' });
}

function exactKeys(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function text(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

/** Validate model data again even when the runtime uses constrained decoding. */
export function decodeResponse(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { throw invalid(); }
  if (!exactKeys(data, ['reply', 'region', 'focus', 'memory'])
      || !text(data.reply, 900) || !text(data.focus, 60)
      || !RESPONSE_SCHEMA.properties.region.enum.includes(data.region)
      || /<\/?(?:navigation|think)\b/i.test(data.reply)) throw invalid();
  if (data.memory !== null && (!exactKeys(data.memory, ['kind', 'text'])
      || !RESPONSE_SCHEMA.properties.memory.anyOf[1].properties.kind.enum.includes(data.memory.kind)
      || !text(data.memory.text, 300))) throw invalid();
  const navigation = {
    region: data.region,
    focus: data.focus.trim(),
    memory: data.memory ? { kind: data.memory.kind, text: data.memory.text.trim() } : null,
  };
  // Escaping '<' prevents quoted user text from terminating the marker early.
  const marker = JSON.stringify(navigation).replaceAll('<', '\\u003c');
  return { ...navigation, reply: data.reply.trim(), text: `${data.reply.trim()}\n<navigation>${marker}</navigation>` };
}

function stringAt(source, start) {
  let decoded = '';
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"') return { text: decoded, end: i + 1, complete: true };
    if (char === '\\') {
      const escape = source[++i];
      if (escape === undefined) break;
      if (escape === 'u') {
        const code = source.slice(i + 1, i + 5);
        if (!/^[0-9a-f]{4}$/i.test(code)) break;
        decoded += String.fromCharCode(parseInt(code, 16));
        i += 4;
      } else {
        const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!Object.hasOwn(escapes, escape)) break;
        decoded += escapes[escape];
      }
    } else if (char.charCodeAt(0) < 32) break;
    else decoded += char;
  }
  // A high surrogate arriving before its low surrogate is not a complete glyph.
  return { text: decoded.replace(/[\uD800-\uDBFF]$/, ''), end: source.length, complete: false };
}

/** Decode only the top-level reply string while its JSON arrives in chunks. */
export function partialReply(raw) {
  const source = String(raw ?? '');
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
    else if (char === '"') {
      const token = stringAt(source, i);
      if (!token.complete) return '';
      let next = token.end;
      while (/\s/.test(source[next] || '') && next < source.length) next += 1;
      if (depth === 1 && token.text === 'reply' && source[next] === ':') {
        next += 1;
        while (/\s/.test(source[next] || '') && next < source.length) next += 1;
        if (source[next] !== '"') return '';
        return stringAt(source, next).text.trim();
      }
      i = token.end - 1;
    }
  }
  return '';
}
