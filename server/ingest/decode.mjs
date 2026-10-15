// OWNER: WP1
// decode.mjs — file bytes → one JavaScript string, the offset space of every passage (SPEC §4.2, §5.5, D4).
//
// Order: refuse what is not text (ZIP/PDF containers, NUL bytes, UTF-16) → strip a UTF-8 byte-order mark →
// strict UTF-8 → Windows-1252 fallback with W_ENCODING_FALLBACK naming the first bad byte and its line. No
// newline or Unicode normalization ever happens here: offsets index exactly what was decoded.

import { closeSync, openSync, readSync, fstatSync } from 'node:fs';

const UTF8_BOM = [0xef, 0xbb, 0xbf];
/** Bytes per read when a file is decoded in chunks. */
export const CHUNK_BYTES = 16 * 1024 * 1024;
const NUL_SCAN_BYTES = 8192;

/** Encodings a mapping may ask for ('auto' = UTF-8, falling back to Windows-1252). */
export const ENCODINGS = Object.freeze(['auto', 'utf-8', 'windows-1252']);

const hexByte = (b) => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`;
const groupInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 1-based line of byte `offset` (counts LF bytes before it). */
export function lineOfByte(bytes, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < bytes.length; i++) if (bytes[i] === 0x0a) line++;
  return line;
}

/**
 * Offset of the first byte that does not start or continue a valid UTF-8 sequence (overlongs, surrogates
 * and code points above U+10FFFF are invalid), or -1.
 * @param {Uint8Array} b
 * @param {number} [from=0]
 * @returns {number}
 */
export function firstInvalidUtf8(b, from = 0) {
  const n = b.length;
  let i = from;
  while (i < n) {
    const c = b[i];
    if (c < 0x80) { i++; continue; }
    let need, min;
    if (c >= 0xc2 && c <= 0xdf) { need = 1; min = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { need = 2; min = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { need = 3; min = 0x10000; }
    else return i;
    let cp = c & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
    for (let k = 1; k <= need; k++) {
      const d = b[i + k];
      if (d === undefined || (d & 0xc0) !== 0x80) return i;
      cp = (cp << 6) | (d & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += need + 1;
  }
  return -1;
}

/** What kind of non-text file the first bytes reveal, or null. */
function binaryKind(b) {
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06)) {
    return { what: 'a ZIP container (for example .xlsx, .docx or .epub)', advice: 'Export it as CSV, TXT, Markdown or JSON first.' };
  }
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) {
    return { what: 'a PDF', advice: 'PDF import is not part of this version; save the text as TXT first.' };
  }
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) {
    return { what: `UTF-16 text (byte-order mark ${hexByte(b[0])} ${hexByte(b[1])})`, advice: 'Re-save it as UTF-8 (most editors offer "UTF-8" under Save As or Encoding).' };
  }
  const scan = Math.min(b.length, NUL_SCAN_BYTES);
  for (let i = 0; i < scan; i++) {
    if (b[i] === 0) {
      return { what: `binary data (a NUL byte at byte ${groupInt(i)})`, advice: 'Import text files only: export the data as CSV, TXT, Markdown or JSON.' };
    }
  }
  return null;
}

/**
 * Decode file bytes. Never normalizes newlines or Unicode; strips (and reports) a UTF-8 BOM.
 * `issues` holds W_ENCODING_FALLBACK, or one fatal E_ENCODING (then `text` is '').
 * @param {Uint8Array} bytes
 * @param {{encoding?: 'auto'|'utf-8'|'windows-1252'}} [opts]
 * @returns {{text: string, decoder: 'utf-8'|'windows-1252', encoding: string, bom: boolean, bomBytes: number,
 *   issues: object[], fatal: object|null}}
 */
export function decodeBytes(bytes, { encoding = 'auto' } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const bom = b.length >= 3 && b[0] === UTF8_BOM[0] && b[1] === UTF8_BOM[1] && b[2] === UTF8_BOM[2];
  const bomBytes = bom ? 3 : 0;
  const issues = [];
  const fail = (issue) => ({ text: '', decoder: 'utf-8', encoding: 'unknown', bom, bomBytes, issues: [issue], fatal: issue });

  const bin = bom ? null : binaryKind(b);
  if (bin) {
    return fail({ code: 'E_ENCODING', severity: 'fatal', line: 1, col: null, field: null, value_excerpt: null,
      message: `This file is ${bin.what}, not plain text.`, suggestion: bin.advice });
  }
  const body = b.subarray(bomBytes);
  if (encoding === 'windows-1252') {
    return { text: new TextDecoder('windows-1252').decode(body), decoder: 'windows-1252', encoding: 'windows-1252', bom, bomBytes, issues, fatal: null };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    return { text, decoder: 'utf-8', encoding: 'utf-8', bom, bomBytes, issues, fatal: null };
  } catch {
    // fall through: find the first bad byte for the message
  }
  const bad = firstInvalidUtf8(body);
  const offset = (bad < 0 ? 0 : bad) + bomBytes;
  const line = lineOfByte(b, offset);
  const where = `${hexByte(b[offset] ?? 0)} at byte ${groupInt(offset)}`;
  if (encoding === 'utf-8') {
    return fail({ code: 'E_ENCODING', severity: 'fatal', line, col: null, field: null, value_excerpt: null,
      message: `Line ${line}: bytes are not valid UTF-8 (${where}).`,
      suggestion: 'Re-save the file as UTF-8, or choose the Windows-1252 reading in the upload step.' });
  }
  const text = new TextDecoder('windows-1252').decode(body);
  issues.push({ code: 'W_ENCODING_FALLBACK', severity: 'warning', line, col: null, field: null,
    value_excerpt: excerptLine(text, line),
    message: `Line ${line}: bytes are not valid UTF-8 (${where}); read as Windows-1252.`,
    suggestion: 'Re-save as UTF-8, or accept the Windows-1252 reading shown.' });
  return { text, decoder: 'windows-1252', encoding: 'windows-1252', bom, bomBytes, issues, fatal: null };
}

/** The text of 1-based line `line` (≤ 120 characters), for showing the fallback reading. */
function excerptLine(text, line) {
  let start = 0;
  for (let l = 1; l < line; l++) {
    const i = text.indexOf('\n', start);
    if (i < 0) return null;
    start = i + 1;
  }
  const end = text.indexOf('\n', start);
  return text.slice(start, end < 0 ? text.length : end).replace(/\r$/, '').slice(0, 120);
}

/**
 * UTF-8 byte length of a string slice without allocating a Buffer per call (used to map character
 * offsets of records to byte offsets of the original file).
 * @param {string} s
 * @param {number} [start=0]
 * @param {number} [end=s.length]
 * @returns {number}
 */
export function utf8Length(s, start = 0, end = s.length) {
  let n = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < end) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
    } else n += 3;
  }
  return n;
}

// ── files too large for one string: decode in chunks ────────────────────────────────────────────────

function readHead(fd, n) {
  const b = Buffer.alloc(n);
  const got = readSync(fd, b, 0, n, 0);
  return b.subarray(0, got);
}

/**
 * Check a whole file's encoding in chunks (nothing is kept in memory): the same rules and issues as
 * decodeBytes, without the text.
 * @param {string} file
 * @param {{encoding?: 'auto'|'utf-8'|'windows-1252', chunkSize?: number}} [opts]
 * @returns {{decoder: 'utf-8'|'windows-1252', encoding: string, bom: boolean, bomBytes: number, bytes: number, issues: object[], fatal: object|null}}
 */
export function scanFileEncoding(file, { encoding = 'auto', chunkSize = CHUNK_BYTES } = {}) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const head = readHead(fd, Math.min(size, 8192));
    const bom = head.length >= 3 && head[0] === UTF8_BOM[0] && head[1] === UTF8_BOM[1] && head[2] === UTF8_BOM[2];
    const bomBytes = bom ? 3 : 0;
    const issue = (i) => ({ decoder: 'utf-8', encoding: 'unknown', bom, bomBytes, bytes: size, issues: [i], fatal: i });
    const bin = bom ? null : binaryKind(head);
    if (bin) {
      return issue({ code: 'E_ENCODING', severity: 'fatal', line: 1, col: null, field: null, value_excerpt: null,
        message: `This file is ${bin.what}, not plain text.`, suggestion: bin.advice });
    }
    if (encoding === 'windows-1252') return { decoder: 'windows-1252', encoding: 'windows-1252', bom, bomBytes, bytes: size, issues: [], fatal: null };
    const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const buf = Buffer.alloc(chunkSize);
    let pos = bomBytes, lines = 1;
    for (;;) {
      const got = readSync(fd, buf, 0, chunkSize, pos);
      const piece = buf.subarray(0, got);
      try {
        dec.decode(piece, { stream: got > 0 });
      } catch {
        // locate the bad byte: it is in this chunk or within 3 bytes before it (a sequence cut at the boundary)
        const back = Math.min(3, pos - bomBytes);
        const win = Buffer.alloc(got + back);
        readSync(fd, win, 0, got + back, pos - back);
        let bad = firstInvalidUtf8(win);
        bad = bad < 0 ? back : bad;
        const offset = pos - back + bad;
        for (let i = 0; i < Math.min(bad, win.length); i++) if (win[i] === 0x0a && i >= back) lines++;
        const where = `${hexByte(win[bad] ?? 0)} at byte ${groupInt(offset)}`;
        if (encoding === 'utf-8') {
          return issue({ code: 'E_ENCODING', severity: 'fatal', line: lines, col: null, field: null, value_excerpt: null,
            message: `Line ${lines}: bytes are not valid UTF-8 (${where}).`,
            suggestion: 'Re-save the file as UTF-8, or choose the Windows-1252 reading in the upload step.' });
        }
        return { decoder: 'windows-1252', encoding: 'windows-1252', bom, bomBytes, bytes: size, fatal: null, issues: [{
          code: 'W_ENCODING_FALLBACK', severity: 'warning', line: lines, col: null, field: null, value_excerpt: null,
          message: `Line ${lines}: bytes are not valid UTF-8 (${where}); read as Windows-1252.`,
          suggestion: 'Re-save as UTF-8, or accept the Windows-1252 reading shown.' }] };
      }
      if (got === 0) break;
      for (let i = 0; i < got; i++) if (piece[i] === 0x0a) lines++;
      pos += got;
    }
    return { decoder: 'utf-8', encoding: 'utf-8', bom, bomBytes, bytes: size, issues: [], fatal: null };
  } finally {
    closeSync(fd);
  }
}

/**
 * Decoded text of a file, chunk by chunk (a multi-byte character cut at a boundary is completed by the next
 * chunk). Yields {text, byteStart, byteEnd} with byte offsets into the file.
 * @param {string} file
 * @param {{decoder: 'utf-8'|'windows-1252', bomBytes?: number, chunkSize?: number}} opts
 * @returns {Generator<{text: string, byteStart: number, byteEnd: number}>}
 */
export function* fileTextChunks(file, { decoder, bomBytes = 0, chunkSize = CHUNK_BYTES }) {
  const fd = openSync(file, 'r');
  try {
    const dec = new TextDecoder(decoder, { ignoreBOM: true });
    const buf = Buffer.alloc(chunkSize);
    let pos = bomBytes;
    for (;;) {
      const got = readSync(fd, buf, 0, chunkSize, pos);
      const text = dec.decode(buf.subarray(0, got), { stream: got > 0 });
      if (text) yield { text, byteStart: pos, byteEnd: pos + got };
      if (got === 0) break;
      pos += got;
    }
  } finally {
    closeSync(fd);
  }
}
