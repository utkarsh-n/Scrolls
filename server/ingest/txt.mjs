// OWNER: WP1
// txt.mjs — TXT import: one document per file (SPEC §5.1). Leading `Title:` / `Author:` / `Date:` /
// `Language:` lines (Gutenberg style) or a `---` front-matter block become metadata and stay in the original;
// the body starts after them (and, in a Project Gutenberg file, between the START and END markers, so the
// licence is never counted as text). Line mode (verse, transcripts) makes every block a run of stanzas.

import { parseFrontMatter } from './frontmatter.mjs';

const HEADER_KEYS = ['title', 'author', 'authors', 'date', 'year', 'language', 'lang', 'translator', 'editor',
  'release date', 'source', 'url', 'license', 'licence', 'genre', 'kind', 'community', 'published',
  'publication date', 'original publication', 'credits'];
const HEADER_LINE = new RegExp(`^(${HEADER_KEYS.map((k) => k.replace(/ /g, '\\s+')).join('|')})\\s*:\\s*(.*?)\\s*$`, 'i');
const PG_START = /^[ \t]*\*\*\*\s*START OF (?:THE |THIS )?PROJECT GUTENBERG E-?BOOK[^\n]*$/im;
const PG_END = /^[ \t]*\*\*\*\s*END OF (?:THE |THIS )?PROJECT GUTENBERG E-?BOOK/im;
const MAX_HEADER_SCAN = 120;

/** Normalized metadata key: 'Release Date' → 'release_date'. */
export const metaKey = (k) => k.trim().toLowerCase().replace(/\s+/g, '_');

/** File name without directory and extension. */
export function fileStem(fileName) {
  const base = String(fileName ?? '').split(/[\\/]/).pop() || 'untitled';
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base) || 'untitled';
}

/** `Key: value` lines of `text` between [from, to) (first occurrence of a key wins). */
function headerLines(text, from, to, { contiguous }) {
  const meta = {};
  let pos = from, end = from, seen = 0, lines = 0;
  while (pos < to && lines < MAX_HEADER_SCAN) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0 || nl > to) nl = to;
    const line = text.slice(pos, nl).replace(/\r$/, '');
    lines++;
    const m = HEADER_LINE.exec(line);
    if (m) {
      const k = metaKey(m[1]);
      if (!(k in meta) && m[2] !== '') meta[k] = m[2];
      seen++;
      end = Math.min(nl + 1, to);
    } else if (contiguous) {
      if (line.trim() === '' && seen === 0) { pos = nl + 1; end = pos; continue; }
      break;
    }
    pos = nl + 1;
  }
  return { meta, end, seen };
}

/**
 * Turn a text file into one file record: metadata, the body bounds within the original, and its mode.
 * @param {string} text the decoded original
 * @param {{fileName: string, lineMode?: boolean}} opts
 * @returns {{data: Record<string, unknown>, document: {original: string, body_start: number, body_end: number, mode: string},
 *   header: {kind: 'front_matter'|'header_lines'|'gutenberg'|null, meta: object}, issues: object[]}}
 */
export function parseTxt(text, { fileName, lineMode = false } = {}) {
  const issues = [];
  let meta = {}, bodyStart = 0, bodyEnd = text.length, kind = null;
  const fm = parseFrontMatter(text);
  issues.push(...fm.issues);
  if (fm.present) {
    meta = Object.fromEntries(Object.entries(fm.data).map(([k, v]) => [metaKey(k), v]));
    bodyStart = fm.bodyStart;
    kind = 'front_matter';
  } else {
    const start = PG_START.exec(text);
    if (start) {
      const afterStart = start.index + start[0].length;
      const endM = PG_END.exec(text.slice(afterStart));
      meta = headerLines(text, 0, start.index, { contiguous: false }).meta;
      bodyStart = Math.min(text.length, text.indexOf('\n', afterStart) < 0 ? text.length : text.indexOf('\n', afterStart) + 1);
      bodyEnd = endM ? afterStart + endM.index : text.length;
      kind = 'gutenberg';
    } else {
      const h = headerLines(text, 0, text.length, { contiguous: true });
      const next = text.slice(h.end, text.indexOf('\n', h.end) < 0 ? text.length : text.indexOf('\n', h.end));
      if (h.seen > 0 && next.trim() === '') {
        meta = h.meta;
        bodyStart = h.end;
        kind = 'header_lines';
      }
    }
  }
  // the body starts at its first non-blank line (blank lines after a header are not body)
  for (let nl = text.indexOf('\n', bodyStart); kind && nl !== -1 && nl < bodyEnd && text.slice(bodyStart, nl).trim() === ''; nl = text.indexOf('\n', bodyStart)) {
    bodyStart = nl + 1;
  }
  if (bodyEnd < bodyStart) bodyEnd = bodyStart;
  const body = text.slice(bodyStart, bodyEnd);
  if (!/[\p{L}\p{N}]/u.test(body)) {
    issues.push({ code: 'E_MISSING_TEXT', severity: 'warning', line: null, col: null, field: 'text', value_excerpt: null,
      message: `${fileName ?? 'The file'} has no words after its metadata; it will be imported as a title only.`,
      suggestion: 'Check that this is the right file; a text file needs body text to be searchable.' });
  }
  const data = { ...meta };
  if (data.title === undefined || data.title === null || data.title === '') data.title = fileStem(fileName);
  data.file_name = String(fileName ?? '');
  data.text = body;
  return {
    data,
    document: { original: text, body_start: bodyStart, body_end: bodyEnd, mode: lineMode ? 'verse' : 'auto' },
    header: { kind, meta },
    issues,
  };
}
