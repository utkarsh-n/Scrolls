// OWNER: WP2
// source.mjs — reading Cipher source files in place: bytes + sha256, decoding with BOM/windows-1252 fallback,
// line byte ranges (so every record can point at its own bytes, §4.2), title folding and the shared
// unknown-date value. Read-only: nothing here writes to the Cipher folders.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tokenize } from '../../../src/shared/tokenize.mjs';

/** Wording used for every machine-made Cipher tag and gloss (data-inventory.md §2). */
export const TAGGING_METHOD = 'Cipher tagging pass (Claude sub-agent, Oct 2026)';

/**
 * Bytes and sha256 of a file, cached by (path, size, mtime) so the several readers of one bootstrap read
 * each Cipher file once. Large per-book texts pass `cache: false`.
 * @param {string} file
 * @param {{cache?: boolean}} [opts]
 * @returns {{bytes: Buffer, sha256: string, size: number}}
 */
export function readSource(file, { cache: useCache = true } = {}) {
  const st = statSync(file);
  const key = `${file}\u0000${st.size}\u0000${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.value;
  const bytes = readFileSync(file);
  const value = { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  if (useCache) cache.set(file, { key, value });
  return value;
}
const cache = new Map();

/** Forget cached file bytes (tests, and the end of a bootstrap so 500 MB are not held). */
export function clearSourceCache() {
  cache.clear();
}

/** @param {string} file @returns {boolean} */
export const exists = (file) => existsSync(file);

// ignoreBOM: decodeBytes strips the file's one BOM itself; a second U+FEFF (5 Cipher books start EF BB BF EF BB BF) is
// text and stays, so offsets equal a standard UTF-8 decode of the file (D4; fix pass: the default decoder dropped it too)
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const CP1252 = new TextDecoder('windows-1252');

/**
 * Decode bytes as §4.3 says: BOM → UTF-8 (fatal) → on failure windows-1252, naming the first bad byte.
 * The BOM is stripped (and reported) so the decoded string is the offset space.
 * @param {Uint8Array} bytes
 * @returns {{text: string, decoder: 'utf-8'|'windows-1252', hadBom: boolean, badByte: number|null}}
 */
export function decodeBytes(bytes) {
  const hadBom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  const body = hadBom ? bytes.subarray(3) : bytes;
  try {
    return { text: UTF8.decode(body), decoder: 'utf-8', hadBom, badByte: null };
  } catch {
    return { text: CP1252.decode(body), decoder: 'windows-1252', hadBom, badByte: firstBadUtf8(body) };
  }
}

/** Offset of the first byte that breaks UTF-8 (for W_ENCODING_FALLBACK messages). */
function firstBadUtf8(b) {
  for (let i = 0; i < b.length;) {
    const c = b[i];
    const n = c < 0x80 ? 1 : (c >> 5) === 6 ? 2 : (c >> 4) === 14 ? 3 : (c >> 3) === 30 ? 4 : 0;
    if (!n) return i;
    for (let k = 1; k < n; k++) if (i + k >= b.length || (b[i + k] & 0xC0) !== 0x80) return i;
    i += n;
  }
  return null;
}

/**
 * Lines of a UTF-8 file with their byte ranges ([byteStart, byteEnd) excludes the newline).
 * @param {Buffer} bytes
 * @returns {Array<{index: number, text: string, byteStart: number, byteEnd: number}>}
 */
export function lineRecords(bytes) {
  const out = [];
  let start = 0, index = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x0A) {
      let end = i;
      if (end > start && bytes[end - 1] === 0x0D) end--;
      if (end > start || i < bytes.length) out.push({ index: index++, text: bytes.toString('utf8', start, end), byteStart: start, byteEnd: end });
      start = i + 1;
    }
  }
  while (out.length && out[out.length - 1].text === '') out.pop();
  return out;
}

/**
 * Folded tokens joined by spaces: how titles and names are compared across files (accent- and
 * punctuation-insensitive in the tokenizer's sense, so "Don’t" and "Don't" fold alike).
 * @param {string|null|undefined} s
 * @returns {string}
 */
export function fold(s) {
  return s ? tokenize(String(s)).tokens.join(' ') : '';
}

/**
 * An explicit "no date" chronology value: DocumentWriter would otherwise fall back to the first
 * chronology-capable assertion (e.g. Gutenberg's `Issued`, which must never date a book).
 * @param {string} rule
 * @param {string|null} [raw]
 * @returns {object} DateParse with precision 'unknown'
 */
export function unknownDate(rule, raw = null) {
  return { lo_day: null, hi_day: null, lo_year: null, hi_year: null, precision: 'unknown', basis: 'unknown',
    approx: 0, rule, raw, label: 'undated', warnings: [] };
}

/**
 * `adapter:<id>@<version>` — the created_by / asserted_by of everything an adapter states (§6.1).
 * @param {{id: string, version: string}} a
 * @returns {string}
 */
export const assertedBy = (a) => `adapter:${a.id}@${a.version}`;
