// OWNER: WP1
// md.mjs — Markdown import: front matter as metadata, every heading starts a passage, the original keeps its
// markup (SPEC §5.1). Markup characters (#, *, _, >, `) are punctuation to the tokenizer, so they never
// become tokens; headings are made passage boundaries with segmentation regions, which segment.mjs treats
// as hard boundaries.

import { parseFrontMatter } from './frontmatter.mjs';
import { fileStem, metaKey } from './txt.mjs';

const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Offsets of ATX heading lines in [from, to), ignoring fenced code blocks.
 * @param {string} text
 * @param {number} from
 * @param {number} to
 * @returns {Array<{start: number, level: number, text: string}>}
 */
export function headingStarts(text, from, to) {
  const out = [];
  let pos = from, fence = null;
  while (pos < to) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0 || nl > to) nl = to;
    const line = text.slice(pos, nl).replace(/\r$/, '');
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    } else if (!fence) {
      const m = ATX.exec(line);
      if (m) out.push({ start: pos, level: m[1].length, text: m[2] });
    }
    pos = nl + 1;
  }
  return out;
}

/**
 * Turn a Markdown file into one file record (see parseTxt for the shape), with one region per heading
 * section.
 * @param {string} text
 * @param {{fileName: string, lineMode?: boolean}} opts
 * @returns {{data: Record<string, unknown>, document: {original: string, body_start: number, body_end: number,
 *   regions: Array<{start: number, end: number}>, mode: string}, header: object, issues: object[]}}
 */
export function parseMd(text, { fileName, lineMode = false } = {}) {
  const fm = parseFrontMatter(text);
  const issues = [...fm.issues];
  const meta = fm.present ? Object.fromEntries(Object.entries(fm.data).map(([k, v]) => [metaKey(k), v])) : {};
  const bodyStart = fm.present ? fm.bodyStart : 0;
  const bodyEnd = text.length;
  const heads = headingStarts(text, bodyStart, bodyEnd);
  const regions = [];
  if (heads.length) {
    if (heads[0].start > bodyStart && /\S/.test(text.slice(bodyStart, heads[0].start))) regions.push({ start: bodyStart, end: heads[0].start });
    heads.forEach((h, k) => regions.push({ start: h.start, end: k + 1 < heads.length ? heads[k + 1].start : bodyEnd }));
  }
  const data = { ...meta };
  if (data.title === undefined || data.title === null || data.title === '') {
    const h1 = heads.find((h) => h.level === 1);
    data.title = h1 ? h1.text.replace(/[*_`]/g, '').trim() || fileStem(fileName) : fileStem(fileName);
  }
  data.file_name = String(fileName ?? '');
  data.text = text.slice(bodyStart, bodyEnd);
  if (!/[\p{L}\p{N}]/u.test(data.text)) {
    issues.push({ code: 'E_MISSING_TEXT', severity: 'warning', line: null, col: null, field: 'text', value_excerpt: null,
      message: `${fileName ?? 'The file'} has no words after its front matter; it will be imported as a title only.`,
      suggestion: 'Check that this is the right file; a Markdown file needs body text to be searchable.' });
  }
  return {
    data,
    document: { original: text, body_start: bodyStart, body_end: bodyEnd, regions, mode: lineMode ? 'verse' : 'auto' },
    header: { kind: fm.present ? 'front_matter' : null, meta },
    issues,
  };
}
