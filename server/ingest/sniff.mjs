// OWNER: WP1
// sniff.mjs — format, encoding and delimiter sniffing for uploads (SPEC §5.1, §5.2 step 1).
//
// A known file extension decides the format (the user named the file); the content decides otherwise. The
// encoding guess here looks at the first 64 KB only; decode.mjs validates the whole file.

import { csvRecords, sniffDelimiterDetail, sniffHeader } from './csv.mjs';
import { decodeBytes } from './decode.mjs';

const HEAD_BYTES = 65536;

/** File extension → format. */
export const EXTENSIONS = Object.freeze({
  txt: 'txt', text: 'txt', md: 'md', markdown: 'md', mdown: 'md', mkd: 'md', csv: 'csv', tsv: 'tsv', tab: 'tsv',
  json: 'json', jsonl: 'jsonl', ndjson: 'jsonl', jsonlines: 'jsonl',
});

/** Formats the importer reads (import_batch.format minus 'adapter'). */
export const FILE_FORMATS = Object.freeze(['txt', 'md', 'csv', 'tsv', 'json', 'jsonl']);

/** Format named by a file's extension, or null. */
export function formatFromName(fileName) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(fileName ?? ''));
  return m ? EXTENSIONS[m[1].toLowerCase()] ?? null : null;
}

function looksLikeJsonl(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5);
  if (lines.length < 2) return false;
  let ok = 0;
  for (const l of lines) {
    try { const v = JSON.parse(l); if (v && typeof v === 'object' && !Array.isArray(v)) ok++; } catch { /* a cut line */ }
  }
  return ok >= Math.min(2, lines.length);
}

function looksLikeMarkdown(text) {
  return /^ {0,3}#{1,6}[ \t]+\S/m.test(text) || /^\s*[-*+][ \t]+\S/m.test(text) && /\[[^\]]+\]\([^)]+\)/.test(text)
    || /^```/m.test(text);
}

/**
 * Format, delimiter and header of a decoded text.
 * @param {string} head the first ~64 KB of the decoded text
 * @param {{fileName?: string|null}} [opts]
 * @returns {{format: string, delimiter: string|null, header: boolean|null, by: 'extension'|'content'}}
 */
export function sniffText(head, { fileName = null } = {}) {
  const byName = formatFromName(fileName);
  const tableInfo = (fmt, preferTab) => {
    const d = preferTab ? { delimiter: '\t' } : sniffDelimiterDetail(head);
    const firsts = [];
    for (const r of csvRecords(head, { delimiter: d.delimiter })) {
      if (r.error || firsts.length >= 20) break;
      firsts.push(r.fields);
    }
    return { format: fmt, delimiter: d.delimiter, header: sniffHeader(firsts) };
  };
  if (byName === 'csv') return { ...tableInfo('csv', false), by: 'extension' };
  if (byName === 'tsv') return { ...tableInfo('tsv', true), by: 'extension' };
  if (byName) return { format: byName, delimiter: null, header: null, by: 'extension' };

  const t = head.trimStart();
  if (t.startsWith('[')) return { format: 'json', delimiter: null, header: null, by: 'content' };
  if (t.startsWith('{')) return { format: looksLikeJsonl(t) ? 'jsonl' : 'json', delimiter: null, header: null, by: 'content' };
  const d = sniffDelimiterDetail(head);
  if (d.fields >= 2 && d.records >= 2 && d.consistency >= 0.8) {
    return { ...tableInfo(d.delimiter === '\t' ? 'tsv' : 'csv', d.delimiter === '\t'), by: 'content' };
  }
  return { format: looksLikeMarkdown(head) ? 'md' : 'txt', delimiter: null, header: null, by: 'content' };
}

/**
 * Guess format (txt, md, csv, tsv, json, jsonl), encoding and CSV delimiter from the first 64 KB.
 * @param {Uint8Array} bytes
 * @param {{fileName?: string|null}} [opts]
 * @returns {{format: string, encoding: string, delimiter: string|null, header: boolean|null, issues: object[]}}
 */
export function sniffFormat(bytes, { fileName = null } = {}) {
  const head = bytes.subarray(0, HEAD_BYTES);
  // a multi-byte character cut at 64 KB is not an encoding error
  let cut = head.length;
  if (bytes.length > HEAD_BYTES) while (cut > head.length - 4 && cut > 0 && (head[cut - 1] & 0xc0) === 0x80) cut--;
  if (bytes.length > HEAD_BYTES && cut > 0 && head[cut - 1] >= 0xc0) cut--;
  const dec = decodeBytes(head.subarray(0, cut));
  if (dec.fatal) return { format: formatFromName(fileName) ?? 'txt', encoding: dec.encoding, delimiter: null, header: null, issues: dec.issues };
  const s = sniffText(dec.text, { fileName });
  return { format: s.format, encoding: dec.encoding, delimiter: s.delimiter, header: s.header, issues: dec.issues };
}
