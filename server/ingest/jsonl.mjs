// OWNER: WP1
// jsonl.mjs — JSON Lines import: one object per line, blank lines skipped, every error carries its line and
// column (SPEC §5.1, §5.5). A bad line rejects only that line.

import { jsonParseIssue } from './json.mjs';

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'string' ? 'a string'
  : typeof v === 'number' ? 'a number' : typeof v);

/**
 * Iterate the lines of a JSON Lines text as RawRecords `{line, start, end, data}`; a line that is not a JSON
 * object yields `{line, start, end, data: null, issue}` (E_JSON_PARSE or E_FIELD_TYPE, severity rejected).
 * @param {string} text
 * @returns {Generator<object>}
 */
export function* jsonlRecords(text) {
  const n = text.length;
  let start = 0, line = 1;
  while (start < n) {
    let nl = text.indexOf('\n', start);
    if (nl < 0) nl = n;
    let end = nl;
    if (end > start && text.charCodeAt(end - 1) === 13) end--;
    const raw = text.slice(start, end);
    if (raw.trim() !== '') {
      let data;
      let issue = null;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        issue = jsonParseIssue(err, raw, { lineOffset: line - 1, severity: 'rejected', wholeFile: false });
      }
      if (!issue && (!data || typeof data !== 'object' || Array.isArray(data))) {
        issue = { code: 'E_FIELD_TYPE', severity: 'rejected', line, col: 1, field: null, value_excerpt: raw.slice(0, 200),
          message: `Line ${line} is ${typeName(data)}; expected one JSON object per line.`,
          suggestion: 'Write each record as one object such as {"title": "…", "text": "…"} on its own line; the line was skipped.' };
      }
      yield issue ? { line, start, end, data: null, issue } : { line, start, end, data };
    }
    start = nl + 1;
    line++;
  }
}

/**
 * jsonlRecords over a file read in chunks: lines are carried across chunk boundaries; records get offsets
 * into the whole decoded text and byteStart/byteEnd into the file.
 * @param {Iterable<{text: string}>} chunks
 * @param {{decoder?: 'utf-8'|'windows-1252', bomBytes?: number}} [opts]
 * @returns {Generator<object>}
 */
export function* jsonlRecordsChunked(chunks, { decoder = 'utf-8', bomBytes = 0 } = {}) {
  const enc = new TextEncoder();
  const bytesOf = decoder === 'windows-1252' ? (t) => t.length : (t) => enc.encode(t).length;
  let buf = '', bufChar = 0, bufLine = 1, bufByte = bomBytes;
  const it = chunks[Symbol.iterator]();
  let next = it.next();
  while (!next.done) {
    buf += next.value.text;
    next = it.next();
    const final = next.done;
    const cut = final ? buf.length : buf.lastIndexOf('\n') + 1;
    if (cut <= 0) continue;
    const part = buf.slice(0, cut);
    let lastEnd = 0, byte = bufByte;
    for (const r of jsonlRecords(part)) {
      byte += bytesOf(part.slice(lastEnd, r.start));
      const byteStart = byte;
      byte += bytesOf(part.slice(r.start, r.end));
      lastEnd = r.end;
      yield { ...r, line: r.line + bufLine - 1, start: r.start + bufChar, end: r.end + bufChar, byteStart, byteEnd: byte,
        ...(r.issue ? { issue: { ...r.issue, line: r.issue.line === null ? null : r.issue.line + bufLine - 1,
          message: r.issue.message.replace(/^Line (\d+)/, (m, l) => `Line ${Number(l) + bufLine - 1}`) } } : {}) };
    }
    bufByte = byte + bytesOf(part.slice(lastEnd));
    bufLine += (part.match(/\n/g)?.length ?? 0);
    bufChar += cut;
    buf = buf.slice(cut);
  }
}

/**
 * Parse JSON Lines.
 * @param {string} text
 * @returns {{records: object[], issues: object[]}}
 */
export function parseJsonl(text) {
  const records = [];
  const issues = [];
  for (const r of jsonlRecords(text)) {
    if (r.issue) issues.push(r.issue);
    records.push(r);
  }
  return { records, issues };
}
