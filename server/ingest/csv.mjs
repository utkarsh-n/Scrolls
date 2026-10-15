// OWNER: WP1
// csv.mjs — RFC 4180 CSV/TSV state machine with delimiter sniffing (SPEC §5.1, §5.5).
//
// Quoted fields, embedded newlines, "" escapes; CRLF, LF and lone CR line ends. Offsets are UTF-16 code
// units into the decoded text (the BOM was already stripped by decode.mjs). A record's `line` is the
// physical line it starts on, so "Row 57" in a message is the record that starts on line 57 of the file.
// Lenient where RFC 4180 is strict and nothing is lost: a quote inside an unquoted field and characters
// after a closing quote are kept as written.

/** Delimiters the sniffer tries, in tie-break order. */
export const DELIMITERS = Object.freeze([',', '\t', ';', '|']);
/** Human names for messages. */
export const DELIMITER_NAMES = Object.freeze({ ',': 'comma', '\t': 'tab', ';': 'semicolon', '|': 'pipe' });

const QUOTE = 34, LF = 10, CR = 13;
const SNIFF_RECORDS = 50;
const SNIFF_CHARS = 65536;

/**
 * Iterate the records of a CSV text. Yields `{fields, line, start, end}` (end excludes the line break);
 * blank lines are skipped. An unclosed quote ends the iteration with `{error: {code: 'E_CSV_QUOTE', line,
 * col, fieldIndex, start}}`.
 * @param {string} text
 * @param {{delimiter?: string}} [opts]
 * @returns {Generator<{fields: string[], line: number, start: number, end: number} | {error: object}>}
 */
export function* csvRecords(text, { delimiter = ',' } = {}) {
  if (typeof delimiter !== 'string' || delimiter.length !== 1) throw new TypeError(`csvRecords: delimiter must be one character (got ${JSON.stringify(delimiter)})`);
  const D = delimiter.charCodeAt(0);
  const n = text.length;
  let i = 0, line = 1, lineStart = 0;

  while (i < n) {
    const recStart = i, recLine = line;
    const fields = [];
    let quotedAny = false, end = i;
    for (;;) {
      let value;
      if (i < n && text.charCodeAt(i) === QUOTE) {
        quotedAny = true;
        const qStart = i, qLine = line, qCol = i - lineStart + 1;
        let j = i + 1;
        const parts = [];
        for (;;) {
          const k = text.indexOf('"', j);
          if (k < 0) {
            yield { error: { code: 'E_CSV_QUOTE', line: qLine, col: qCol, fieldIndex: fields.length, start: qStart, recStart, recLine } };
            return;
          }
          // line bookkeeping for newlines inside the quoted run
          for (let nl = text.indexOf('\n', j); nl !== -1 && nl < k; nl = text.indexOf('\n', nl + 1)) { line++; lineStart = nl + 1; }
          parts.push(text.slice(j, k));
          if (k + 1 < n && text.charCodeAt(k + 1) === QUOTE) { parts.push('"'); j = k + 2; continue; }
          i = k + 1;
          break;
        }
        value = parts.length === 1 ? parts[0] : parts.join('');
        // characters between the closing quote and the delimiter are kept (lenient)
        let j2 = i;
        while (j2 < n) {
          const c = text.charCodeAt(j2);
          if (c === D || c === LF || c === CR) break;
          j2++;
        }
        if (j2 > i) { value += text.slice(i, j2); i = j2; }
      } else {
        let j = i;
        while (j < n) {
          const c = text.charCodeAt(j);
          if (c === D || c === LF || c === CR) break;
          j++;
        }
        value = text.slice(i, j);
        i = j;
      }
      fields.push(value);
      end = i;
      if (i < n && text.charCodeAt(i) === D) { i++; continue; }
      if (i < n) { // line break
        if (text.charCodeAt(i) === CR) i++;
        if (i < n && text.charCodeAt(i) === LF) i++;
        line++;
        lineStart = i;
      }
      break;
    }
    if (fields.length === 1 && fields[0] === '' && !quotedAny) continue; // blank line
    yield { fields, line: recLine, start: recStart, end };
  }
}

/**
 * Score each candidate delimiter by how consistently it splits the first records (field-count mode share),
 * over the first 50 records or 64 KB.
 * @param {string} text
 * @returns {{delimiter: string, consistency: number, fields: number, records: number}}
 */
export function sniffDelimiterDetail(text) {
  const sample = text.length > SNIFF_CHARS ? text.slice(0, SNIFF_CHARS) : text;
  const truncated = sample.length < text.length;
  let best = { delimiter: ',', consistency: 0, fields: 1, records: 0 };
  for (const d of DELIMITERS) {
    const counts = [];
    for (const r of csvRecords(sample, { delimiter: d })) {
      if (r.error) break;
      counts.push(r.fields.length);
      if (counts.length > SNIFF_RECORDS) break;
    }
    if (truncated && counts.length > 1) counts.pop(); // the last record may be cut at 64 KB
    if (!counts.length) continue;
    const freq = new Map();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = 1, modeN = 0;
    for (const [c, k] of freq) if (k > modeN || (k === modeN && c > mode)) { mode = c; modeN = k; }
    const consistency = modeN / counts.length;
    if (mode < 2) continue;
    if (consistency > best.consistency + 1e-9 || (Math.abs(consistency - best.consistency) < 1e-9 && mode > best.fields)) {
      best = { delimiter: d, consistency, fields: mode, records: counts.length };
    }
  }
  return best;
}

/**
 * Pick the delimiter from , \t ; | by field-count consistency over the first 50 records.
 * @param {string} text
 * @returns {string}
 */
export function sniffDelimiter(text) {
  return sniffDelimiterDetail(text).delimiter;
}

const isNumeric = (s) => /^[-+]?(\d+([.,]\d+)?|\d{1,3}([,.]\d{3})+([.,]\d+)?)%?$/.test(s.trim());
const isIsoish = (s) => /^\d{4}([-/.]\d{1,2}){0,2}$/.test(s.trim());

/**
 * Whether the first record looks like a header: all names present and distinct, none numeric or a date,
 * unless the rest of the column is just as numeric (then it is data).
 * @param {string[][]} firstRecords
 * @returns {boolean}
 */
export function sniffHeader(firstRecords) {
  if (!firstRecords.length) return true;
  const [head, ...rest] = firstRecords;
  if (head.some((v) => v.trim() === '')) return rest.length === 0;
  if (new Set(head.map((v) => v.trim().toLowerCase())).size !== head.length) return false;
  const typed = head.map((v) => isNumeric(v) || isIsoish(v));
  if (!typed.some(Boolean)) return true;
  // a numeric "header" cell under a numeric column means the first row is data
  return !head.some((v, i) => typed[i] && rest.length && rest.every((r) => r[i] === undefined || isNumeric(r[i]) || isIsoish(r[i])));
}

/** Column names from a header record: trimmed, blanks named by position, duplicates suffixed " (2)". */
export function columnNames(headerFields) {
  const used = new Set();
  return headerFields.map((raw, i) => {
    const base = String(raw).trim() || `column ${i + 1}`;
    let name = base, k = 1;
    while (used.has(name)) name = `${base} (${++k})`;
    used.add(name);
    return name;
  });
}

/** Positional column names for header-less files: col1, col2, … */
export const positionalName = (i) => `col${i + 1}`;

/**
 * Open a CSV text as a table: the header (or positional names) and a generator of RawRecords
 * `{line, start, end, data, issue?, warnings?}`; a rejected row carries `issue` (E_ROW_RAGGED) and no
 * data; an unclosed quote ends the rows with `{fatal: Issue}`.
 * @param {string} text
 * @param {{delimiter?: string, header?: boolean}} [opts]
 * @returns {{columns: string[], issues: object[], rows: Generator<object>, fatal: object|null}}
 */
export function openCsv(text, { delimiter = ',', header = true } = {}) {
  return openCsvRecords(csvRecords(text, { delimiter }), { delimiter, header });
}

/**
 * openCsv over any iterator of raw records (csvRecords, or csvRecordsChunked for files read in chunks);
 * byte offsets on the raw records are passed through.
 * @param {Iterator<object>} it
 * @param {{delimiter?: string, header?: boolean}} [opts]
 * @returns {{columns: string[], issues: object[], rows: Generator<object>, fatal: object|null}}
 */
export function openCsvRecords(it, { delimiter = ',', header = true } = {}) {
  const first = it.next();
  const issues = [];
  if (first.done) return { columns: [], issues, rows: (function* empty() {})(), fatal: null };
  if (first.value.error) {
    const fatal = quoteIssue(first.value.error, []);
    return { columns: [], issues: [fatal], rows: (function* none() {})(), fatal };
  }
  const columns = header ? columnNames(first.value.fields) : first.value.fields.map((_, i) => positionalName(i));
  if (header) {
    columns.forEach((c, i) => {
      const raw = String(first.value.fields[i]).trim();
      if (c === raw) return;
      issues.push({ code: 'E_FIELD_TYPE', severity: 'warning', line: first.value.line, col: null, field: c, value_excerpt: raw || null,
        message: raw ? `Two columns are named '${raw}'; the later one is shown as '${c}'.` : `Column ${i + 1} has no name in the header; it is shown as '${c}'.`,
        suggestion: raw ? 'Rename one of the columns in the file if they hold different things.' : 'Give the column a name in the header row, or leave it unmapped.' });
    });
  }
  const protoKey = columns.includes('__proto__');
  const lengths = new Float64Array(columns.length);
  let statRows = 0;

  function suspectColumn(fields) {
    // the column whose values are longest so far is where a stray delimiter most likely hides
    if (statRows) {
      let best = 0;
      for (let k = 1; k < columns.length; k++) if (lengths[k] > lengths[best]) best = k;
      return columns[best];
    }
    let best = 0;
    for (let k = 1; k < Math.min(fields.length, columns.length); k++) if (fields[k].length > fields[best].length) best = k;
    return columns[best];
  }

  function* rows() {
    const toRow = (r) => {
      const { fields, line, start, end, byteStart, byteEnd } = r;
      if (fields.length > columns.length) {
        const where = suspectColumn(fields);
        return { line, start, end, byteStart, byteEnd, data: null, issue: {
          code: 'E_ROW_RAGGED', severity: 'rejected', line, col: null, field: where, value_excerpt: fields.join(delimiter).slice(0, 200),
          message: `Row ${line} has ${fields.length} fields, the header has ${columns.length}.`,
          suggestion: `Check for an unquoted ${DELIMITER_NAMES[delimiter] ?? `'${delimiter}'`} in '${where}' (quote that value in the file); the row was skipped.` } };
      }
      const warnings = [];
      if (fields.length < columns.length) {
        warnings.push({ code: 'W_TRUNCATED_ROW', severity: 'warning', line, col: null, field: columns[fields.length], value_excerpt: null,
          message: `Row ${line} has ${fields.length} fields, the header has ${columns.length}; missing fields are empty.`,
          suggestion: `Check row ${line} for a missing ${DELIMITER_NAMES[delimiter] ?? 'delimiter'} or a line break inside an unquoted value.` });
      }
      const data = {};
      for (let k = 0; k < columns.length; k++) {
        const v = k < fields.length ? fields[k] : '';
        if (protoKey && columns[k] === '__proto__') Object.defineProperty(data, '__proto__', { value: v, enumerable: true, writable: true, configurable: true });
        else data[columns[k]] = v;
        if (statRows < 200) lengths[k] += v.length;
      }
      statRows++;
      return { line, start, end, byteStart, byteEnd, data, warnings };
    };
    if (!header) yield toRow(first.value);
    for (const r of it) {
      if (r.error) { yield { fatal: quoteIssue(r.error, columns) }; return; }
      yield toRow(r);
    }
  }
  return { columns, issues, rows: rows(), fatal: null };
}

/** UTF-8 byte count of s[a, b). */
function utf8Bytes(s, a, b) {
  let n = 0;
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < b && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * csvRecords over a file read in chunks (files too large for one string): the same records, with line,
 * start and end relative to the whole decoded text and byteStart/byteEnd into the file. The last record of a
 * chunk is carried into the next one, so a record (or a quoted field) may span any number of chunks.
 * @param {Iterable<{text: string}>} chunks decoded text pieces, in order
 * @param {{delimiter?: string, decoder?: 'utf-8'|'windows-1252', bomBytes?: number}} [opts]
 * @returns {Generator<object>}
 */
export function* csvRecordsChunked(chunks, { delimiter = ',', decoder = 'utf-8', bomBytes = 0 } = {}) {
  const bytesOf = decoder === 'windows-1252' ? (s, a, b) => b - a : utf8Bytes;
  let buf = '', bufChar = 0, bufLine = 1, bufByte = bomBytes;
  const it = chunks[Symbol.iterator]();
  let next = it.next();
  while (!next.done) {
    buf += next.value.text;
    next = it.next();
    const final = next.done;
    const recs = [];
    let carry = null; // [start, line] relative to buf
    let cursorChar = 0, cursorByte = bufByte;
    const at = (c) => { cursorByte += bytesOf(buf, cursorChar, c); cursorChar = c; return cursorByte; };
    const shift = (x) => {
      const byteStart = at(x.start), byteEnd = at(x.end);
      return { fields: x.fields, line: x.line + bufLine - 1, start: x.start + bufChar, end: x.end + bufChar, byteStart, byteEnd };
    };
    for (const r of csvRecords(buf, { delimiter })) {
      if (r.error) {
        if (final) {
          for (const x of recs) yield shift(x);
          yield { error: { ...r.error, line: r.error.line + bufLine - 1, start: r.error.start + bufChar, recStart: r.error.recStart + bufChar, recLine: r.error.recLine + bufLine - 1 } };
          return;
        }
        carry = [r.error.recStart, r.error.recLine];
        break;
      }
      recs.push(r);
    }
    if (!final && !carry) {
      const last = recs.pop();
      carry = last ? [last.start, last.line] : [buf.length, null];
    }
    for (const x of recs) yield shift(x);
    if (final) return;
    const [cStart, cLine] = carry;
    const lineAt = cLine ?? (() => { let l = 1; for (let i = buf.indexOf('\n'); i !== -1 && i < cStart; i = buf.indexOf('\n', i + 1)) l++; return l; })();
    bufByte = at(cStart);
    bufLine += lineAt - 1;
    bufChar += cStart;
    buf = buf.slice(cStart);
  }
}

function quoteIssue(e, columns) {
  const col = columns[e.fieldIndex];
  return { code: 'E_CSV_QUOTE', severity: 'fatal', line: e.line, col: e.col, field: col ?? null, value_excerpt: null,
    message: `An unclosed quote starts on line ${e.line}, column ${e.col} and runs to the end of the file.`,
    suggestion: col ? `Check for a stray " in '${col}' (a quote inside a value must be doubled: "").`
      : 'Check for a stray " (a quote inside a value must be doubled: "").' };
}

/**
 * Parse a whole CSV/TSV text (tests and small files): columns, RawRecords and every issue.
 * @param {string} text
 * @param {{delimiter?: string, header?: boolean}} [opts]
 * @returns {{columns: string[], records: object[], issues: object[], fatal: object|null}}
 */
export function parseCsv(text, { delimiter = ',', header = true } = {}) {
  const t = openCsv(text, { delimiter, header });
  const records = [];
  const issues = [...t.issues];
  let fatal = t.fatal;
  for (const r of t.rows) {
    if (r.fatal) { fatal = r.fatal; issues.push(r.fatal); break; }
    if (r.issue) issues.push(r.issue);
    for (const w of r.warnings ?? []) issues.push(w);
    records.push(r);
  }
  return { columns: t.columns, records, issues, fatal };
}
