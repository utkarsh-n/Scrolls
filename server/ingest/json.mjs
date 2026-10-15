// OWNER: WP1
// json.mjs — JSON import: an array of objects, or the array chosen by JSON Pointer (RFC 6901) (SPEC §5.1).
//
// JSON.parse does the parsing; a small skipping scanner finds where each element of the chosen array starts
// and ends, so every record still has a line number and character offsets into the original text. Files
// over 100 MB would need the streaming reader of the "2 GB streaming" milestone (P2); this one holds the
// whole text in memory.

const MAX_CANDIDATES = 8;

/**
 * Split a JSON Pointer into reference tokens: '' → [], '/items' → ['items'], '/a~1b/0' → ['a/b', '0'].
 * @param {string} pointer
 * @returns {string[]}
 * @throws {TypeError} when the pointer is not '' and does not start with '/'
 */
export function pointerTokens(pointer) {
  if (pointer === '' || pointer === null || pointer === undefined) return [];
  const p = String(pointer);
  if (!p.startsWith('/')) throw new TypeError(`A JSON Pointer starts with '/' (got '${p}').`);
  return p.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Build a pointer from tokens. */
export function pointerOf(tokens) {
  return tokens.map((t) => `/${String(t).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

/**
 * Value at a JSON Pointer, or undefined.
 * @param {unknown} root
 * @param {string|string[]} pointer
 * @returns {unknown}
 */
export function getPointer(root, pointer) {
  const tokens = Array.isArray(pointer) ? pointer : pointerTokens(pointer);
  let v = root;
  for (const t of tokens) {
    if (Array.isArray(v)) {
      if (!/^(0|[1-9]\d*)$/.test(t)) return undefined;
      v = v[Number(t)];
    } else if (v && typeof v === 'object') {
      if (!Object.prototype.hasOwnProperty.call(v, t)) return undefined;
      v = v[t];
    } else return undefined;
  }
  return v;
}

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object'
  : typeof v === 'string' ? 'a string' : typeof v === 'number' ? 'a number' : typeof v === 'boolean' ? 'a boolean' : typeof v);

/** Arrays of objects anywhere in the first three levels, largest first: where the records probably are. */
export function arrayCandidates(root) {
  const out = [];
  const walk = (v, tokens, depth) => {
    if (Array.isArray(v)) {
      const objects = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).length;
      if (objects > 0 && objects >= v.length / 2) out.push({ pointer: pointerOf(tokens), count: v.length });
      return;
    }
    if (!v || typeof v !== 'object' || depth >= 3) return;
    for (const [k, x] of Object.entries(v)) walk(x, [...tokens, k], depth + 1);
  };
  walk(root, [], 0);
  return out.sort((a, b) => b.count - a.count).slice(0, MAX_CANDIDATES);
}

// ── offsets of the elements of one array (the text is valid JSON: JSON.parse succeeded) ────────────────

function skipWs(text, i) {
  for (;;) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 10 || c === 13 || c === 9) i++;
    else return i;
  }
}

function skipString(text, i) { // text[i] === '"'
  for (let j = i + 1; ;) {
    const k = text.indexOf('"', j);
    if (k < 0) return text.length;
    let bs = 0;
    for (let b = k - 1; text.charCodeAt(b) === 92; b--) bs++;
    if (bs % 2 === 0) return k + 1;
    j = k + 1;
  }
}

function skipValue(text, i) {
  const c = text.charCodeAt(i);
  if (c === 34) return skipString(text, i);
  if (c === 123 || c === 91) {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const d = text.charCodeAt(j);
      if (d === 34) { j = skipString(text, j) - 1; continue; }
      if (d === 123 || d === 91) depth++;
      else if (d === 125 || d === 93) { if (--depth === 0) return j + 1; }
    }
    return text.length;
  }
  let j = i;
  while (j < text.length) {
    const d = text.charCodeAt(j);
    if (d === 44 || d === 93 || d === 125 || d === 32 || d === 10 || d === 13 || d === 9) break;
    j++;
  }
  return j;
}

/**
 * [start, end) offsets of every element of the array at `tokens` (empty when the path is not an array).
 * @param {string} text valid JSON
 * @param {string[]} tokens
 * @returns {Array<[number, number]>}
 */
export function elementSpans(text, tokens) {
  let i = skipWs(text, 0);
  for (const t of tokens) {
    const c = text.charCodeAt(i);
    if (c === 123) { // object: find member t
      i = skipWs(text, i + 1);
      let found = false;
      while (text.charCodeAt(i) === 34) {
        const kEnd = skipString(text, i);
        const key = JSON.parse(text.slice(i, kEnd));
        i = skipWs(text, kEnd);
        i = skipWs(text, i + 1); // ':'
        if (key === t) { found = true; break; }
        i = skipWs(text, skipValue(text, i));
        if (text.charCodeAt(i) === 44) i = skipWs(text, i + 1);
      }
      if (!found) return [];
    } else if (c === 91) { // array: element number t
      const want = Number(t);
      i = skipWs(text, i + 1);
      for (let k = 0; k < want; k++) {
        if (text.charCodeAt(i) === 93) return [];
        i = skipWs(text, skipValue(text, i));
        if (text.charCodeAt(i) === 44) i = skipWs(text, i + 1);
      }
      if (text.charCodeAt(i) === 93) return [];
    } else return [];
  }
  if (text.charCodeAt(i) !== 91) return [];
  const spans = [];
  i = skipWs(text, i + 1);
  while (i < text.length && text.charCodeAt(i) !== 93) {
    const end = skipValue(text, i);
    spans.push([i, end]);
    i = skipWs(text, end);
    if (text.charCodeAt(i) === 44) i = skipWs(text, i + 1);
  }
  return spans;
}

const WS = new Set([32, 9, 10, 13]);
const ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Index of the first character where `text` stops being valid JSON (text.length when it ends too early), or null when it
 * is valid. V8 names no position for "Unexpected token" errors, so the position is found by a strict RFC 8259 scan.
 * @param {string} text
 * @returns {number|null}
 */
export function jsonErrorPosition(text) {
  const n = text.length;
  let i = 0;
  const fail = () => { throw new RangeError(`json@${i}`); };
  const ws = () => { while (i < n && WS.has(text.charCodeAt(i))) i++; };
  const string = () => {
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) { i++; return; }
      if (c < 0x20) fail();
      if (c === 92) {
        const e = text[i + 1];
        if (e === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { i += 2; fail(); } i += 6; } else if (ESCAPES.has(e)) i += 2;
        else { i++; fail(); }
      } else i++;
    }
    fail();
  };
  const value = (depth) => {
    if (depth > 512) fail();
    ws();
    if (i >= n) fail();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      ws();
      if (text[i] === close) { i++; return; }
      for (;;) {
        if (c === '{') {
          ws();
          if (text[i] !== '"') fail();
          string();
          ws();
          if (text[i] !== ':') fail();
          i++;
        }
        value(depth + 1);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === close) { i++; return; }
        fail();
      }
    }
    if (c === '"') return string();
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m && m[0] && m[0] !== '-') { i += m[0].length; return; }
    for (const lit of ['true', 'false', 'null']) {
      if (text.startsWith(lit, i)) { i += lit.length; return; }
      if (lit[0] === c) { let k = 0; while (k < lit.length && text[i + k] === lit[k]) k++; i += k; fail(); }   // 'tru}' fails at '}'
    }
    fail();
  };
  try {
    value(0);
    ws();
    if (i < n) fail();
    return null;
  } catch (err) {
    const at = /^json@(\d+)$/.exec(err?.message ?? '');
    if (at) return Number(at[1]);
    return null;   // a stack too deep to scan: no position rather than a wrong one
  }
}

/**
 * Turn a JSON.parse SyntaxError into an E_JSON_PARSE issue with line and column.
 * @param {SyntaxError} err
 * @param {string} text the text that was parsed
 * @param {{lineOffset?: number, severity?: string, wholeFile?: boolean}} [opts]
 */
export function jsonParseIssue(err, text, { lineOffset = 0, severity = 'fatal', wholeFile = true } = {}) {
  const msg = String(err?.message ?? err);
  let pos = null, line = null, col = null;
  const m = /at position (\d+)(?: \(line (\d+) column (\d+)\))?/.exec(msg);
  if (m) {
    pos = Number(m[1]);
    if (m[2]) { line = Number(m[2]); col = Number(m[3]); }
  }
  // V8 names no position for "Unexpected token …" (fix pass): find it, so every message reads "Line N, column C"
  if (pos === null && !/unexpected end/i.test(msg)) {
    const at = jsonErrorPosition(text);
    if (at !== null && at < text.length) pos = at;
  }
  if (pos !== null && line === null) {
    const before = text.slice(0, pos);
    line = (before.match(/\n/g)?.length ?? 0) + 1;
    col = pos - before.lastIndexOf('\n');
  }
  const end = /unexpected end/i.test(msg);
  if (end) {
    const lines = text.split('\n');
    line = lines.length;
    col = lines[lines.length - 1].length + 1;
  }
  const detail = msg.replace(/ in JSON at position \d+.*$/s, '').replace(/,\s.*\sis not valid JSON$/s, '').trim();
  const found = pos !== null && pos < text.length && !/unexpected token/i.test(detail) ? ` (found '${text[pos]}')` : '';
  const absLine = line === null ? null : line + lineOffset;
  const phrase = detail ? detail.charAt(0).toLowerCase() + detail.slice(1) : 'not valid JSON';
  return {
    code: 'E_JSON_PARSE', severity, line: absLine, col,
    field: null, value_excerpt: pos !== null ? text.slice(Math.max(0, pos - 40), pos + 40) : text.slice(0, 80),
    message: absLine !== null ? `Line ${absLine}, column ${col}: ${phrase}${found}.` : `The JSON could not be read: ${phrase}.`,
    suggestion: wholeFile
      ? 'Fix the JSON at that position (one stray character makes the whole file unreadable), or export the records as JSON Lines, where a bad line only skips that line.'
      : 'Fix the JSON on this line (one complete object per line); the line was skipped, the other lines are imported.',
  };
}

/**
 * Parse a JSON document and return the records at `pointer` (null = choose: the root array, else the
 * largest array of objects). Records are RawRecords `{line, start, end, data, index}`; a non-object element
 * becomes a rejected record with an E_FIELD_TYPE issue.
 * @param {string} text
 * @param {{pointer?: string|null}} [opts]
 * @returns {{records: object[], issues: object[], fatal: object|null, pointer: string|null, candidates: Array<{pointer: string, count: number}>}}
 */
export function parseJson(text, { pointer = null } = {}) {
  let root;
  try {
    root = JSON.parse(text);
  } catch (err) {
    const fatal = jsonParseIssue(err, text);
    return { records: [], issues: [fatal], fatal, pointer, candidates: [] };
  }
  const issues = [];
  const candidates = arrayCandidates(root);
  let chosen = pointer;
  if (chosen === null || chosen === undefined) {
    if (Array.isArray(root)) chosen = '';
    else if (candidates.length) {
      chosen = candidates[0].pointer;
      issues.push({ code: 'E_FIELD_TYPE', severity: 'info', line: 1, col: null, field: null, value_excerpt: chosen,
        message: `The file is one object; its records were taken from the array at ${chosen} (${candidates[0].count} items).`,
        suggestion: candidates.length > 1 ? `Other arrays: ${candidates.slice(1).map((c) => `${c.pointer} (${c.count})`).join(', ')}. Choose one in the upload step if ${chosen} is not the right one.`
          : 'Nothing to do if these are the records.' });
    } else {
      // a single object: one record
      return { records: [{ line: 1, start: 0, end: text.length, data: root, index: 0 }], issues, fatal: null, pointer: null, candidates };
    }
  }
  let tokens;
  try { tokens = pointerTokens(chosen); } catch (err) {
    const fatal = { code: 'E_FIELD_TYPE', severity: 'fatal', line: null, col: null, field: null, value_excerpt: String(chosen),
      message: err.message, suggestion: "Write the pointer as /key or /key/subkey (use '' for a top-level array)." };
    return { records: [], issues: [fatal], fatal, pointer: chosen, candidates };
  }
  const arr = getPointer(root, tokens);
  if (!Array.isArray(arr)) {
    const fatal = { code: 'E_FIELD_TYPE', severity: 'fatal', line: null, col: null, field: null, value_excerpt: chosen,
      message: `The JSON Pointer '${chosen || '(top level)'}' leads to ${arr === undefined ? 'nothing' : typeName(arr)}, not an array of records.`,
      suggestion: candidates.length ? `Arrays in this file: ${candidates.map((c) => `${c.pointer || '(top level)'} (${c.count})`).join(', ')}.` : 'The file has no array of objects to import.' };
    return { records: [], issues: [fatal], fatal, pointer: chosen, candidates };
  }
  const spans = elementSpans(text, tokens);
  const records = [];
  let line = 1, at = 0;
  for (let k = 0; k < arr.length; k++) {
    const [start, end] = spans[k] ?? [0, text.length];
    for (let nl = text.indexOf('\n', at); nl !== -1 && nl < start; nl = text.indexOf('\n', nl + 1)) line++;
    at = Math.max(at, start);
    const v = arr[k];
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      records.push({ line, start, end, data: null, index: k, issue: {
        code: 'E_FIELD_TYPE', severity: 'rejected', line, col: null, field: null, value_excerpt: JSON.stringify(v)?.slice(0, 200) ?? null,
        message: `Record ${k + 1} (line ${line}) is ${typeName(v)}; expected an object.`,
        suggestion: 'Each record must be a JSON object such as {"title": "…", "text": "…"}; the record was skipped.' } });
      continue;
    }
    records.push({ line, start, end, data: v, index: k });
  }
  return { records, issues, fatal: null, pointer: chosen, candidates };
}
