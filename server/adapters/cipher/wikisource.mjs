// OWNER: WP2
// wikisource.mjs — source adapter 'cipher.wikisource': wikisource-{hi,gu}.jsonl → 450 hi + 375 gu documents,
// pages joined with \f (decoder 'pages-joined-ff'; the page boundary is an offset and each passage keeps its
// page_no) (SPEC §6.4). The year is the Wikisource index year, which may be an edition year (e.g. आज भी
// खरे हैं तालाब = 2004, its 5th edition); null → undated. Page text is OCR/transcription: running heads,
// digit-only lines and ≤ 3-character lines are flagged furniture by the segmenter; the first two pages are
// front matter when they average < 30 tokens per non-blank line (§4.3) — flagged, never deleted.

import { fromInterval } from '../../../src/shared/dates.mjs';
import { tokenize } from '../../../src/shared/tokenize.mjs';
import { CIPHER } from '../../config.mjs';
import { assertedBy, exists, lineRecords, readSource, unknownDate } from './source.mjs';

export const id = 'cipher.wikisource';
export const version = '1.0.0';
export const label = 'Cipher Wikisource books (hi, gu)';
export const access = 'local-dataset';
export const license = 'CC BY-SA (Wikisource)';
export const attribution = 'Wikisource';
export const stagedDir = null;
const spec = (lang, name) => ({
  slug: `cipher-wikisource-${lang}`,
  name,
  domain: 'literature',
  modality: 'text',
  unit: 'tokens',
  sampling: 'curated',
  rate_eligible: true,
  export_text_allowed: true,
  coverage_gate: null,
  selection_note: 'Wikisource index books with transcribed pages',
  caveats: ['The year is the Wikisource index year and may be an edition year.', 'Page text is OCR/transcription and can be noisy.'],
});
export const collections = [spec('hi', 'Wikisource (Hindi)'), spec('gu', 'Wikisource (Gujarati)')];
export const LANGS = Object.freeze(['hi', 'gu']);
export const PAGE_SEP = '\f';
const FRONT_PAGES = 2;
const FRONT_TOKENS_PER_LINE = 30;

/** @param {'hi'|'gu'} lang @returns {string} */
export const fileFor = (lang) => (lang === 'hi' ? CIPHER.wikisourceHi : CIPHER.wikisourceGu);

/** @returns {string[]} */
export function sourceFiles(params = {}) {
  const langs = params.collection ? [params.collection.replace('cipher-wikisource-', '')] : LANGS;
  return langs.map(fileFor);
}

/**
 * Parsed JSONL lines of one language (records keep their byte ranges).
 * @param {'hi'|'gu'} lang
 * @returns {{records: Array<{line: number, rec: object|null, byteStart: number, byteEnd: number, error?: string}>, sha256: string}}
 */
export function loadWikisource(lang) {
  const src = readSource(fileFor(lang));
  const records = lineRecords(src.bytes).map((l) => {
    try { return { line: l.index + 1, rec: JSON.parse(l.text), byteStart: l.byteStart, byteEnd: l.byteEnd }; } catch (err) {
      return { line: l.index + 1, rec: null, byteStart: l.byteStart, byteEnd: l.byteEnd, error: err.message };
    }
  });
  return { records, sha256: src.sha256 };
}

/** @returns {Promise<object>} ProbeResult */
export async function probe() {
  const counts = {};
  for (const lang of LANGS) {
    if (!exists(fileFor(lang))) return { available: false, reason: `wikisource-${lang}.jsonl not found`, manifest_ok: false, format_ok: false, counts: {}, caveats: [] };
    const { records } = loadWikisource(lang);
    counts[lang] = records.filter((r) => r.rec).length;
    counts[`${lang}_undated`] = records.filter((r) => r.rec && r.rec.year === null).length;
  }
  return { available: true, manifest_ok: true, format_ok: true, counts, caveats: [] };
}

/** @param {{collection?: string}} params @returns {Promise<{units: number}>} */
export async function plan(params = {}) {
  let units = 0;
  for (const f of sourceFiles(params)) units += lineRecords(readSource(f).bytes).length;
  return { units };
}

/**
 * Front-matter regions: the first two pages when, together, they average < 30 tokens per non-blank line.
 * @param {string} text pages joined with \f
 * @returns {Array<{start: number, end: number, quality: 'front_matter'}>}
 */
export function frontMatterRegions(text) {
  const bounds = [];
  let start = 0;
  for (let p = 0; p < FRONT_PAGES; p++) {
    const ff = text.indexOf(PAGE_SEP, start);
    const end = ff === -1 ? text.length : ff;
    bounds.push([start, end]);
    if (ff === -1) break;
    start = ff + 1;
  }
  let tokens = 0, lines = 0;
  for (const [a, b] of bounds) {
    const s = text.slice(a, b);
    tokens += tokenize(s).tokens.length;
    lines += s.split('\n').filter((l) => l.trim()).length;
  }
  if (!lines || tokens / lines >= FRONT_TOKENS_PER_LINE) return [];
  return bounds.filter(([a, b]) => b > a).map(([a, b]) => ({ start: a, end: b, quality: 'front_matter' }));
}

/**
 * One CanonicalDocument per book of the requested collection (params.collection).
 * @param {{collection?: string, limit?: number, pages?: number, skip?: Iterable<string>}} params pages: keep only the
 *   first N pages (tests); skip: ext_ids already loaded (a resumed bootstrap)
 * @param {object} ctx AdapterCtx (+ keepOriginal(file, src) → sha256)
 */
export async function* documents(params = {}, ctx = {}) {
  const langs = params.collection ? [params.collection.replace('cipher-wikisource-', '')] : LANGS;
  const by = assertedBy({ id, version });
  const skip = new Set(params.skip ?? []);
  for (const lang of langs) {
    if (!LANGS.includes(lang)) continue;
    const { records, sha256 } = loadWikisource(lang);
    const storedSha = ctx.keepOriginal?.(fileFor(lang), readSource(fileFor(lang))) ?? null;
    let n = 0;
    for (const r of records) {
      if (Number.isInteger(params.limit) && n >= params.limit) break;
      ctx.signal?.throwIfAborted?.();
      if (!r.rec) {
        ctx.warn?.('E_JSON_PARSE', `wikisource-${lang}.jsonl line ${r.line}: ${r.error}`);
        continue;
      }
      const rec = r.rec;
      if (skip.has(`ws-${lang}:${rec.index}`)) continue;
      n++;
      const pages = Array.isArray(rec.pages) ? rec.pages.map((p) => String(p ?? '')) : [];
      const kept = Number.isInteger(params.pages) ? pages.slice(0, params.pages) : pages;
      const text = kept.join(PAGE_SEP);
      const year = Number.isInteger(rec.year) ? rec.year : null;
      const { pages: _omit, ...meta } = rec;
      const issues = [];
      let title = rec.title || null;
      if (!title && !text.trim()) {
        // neither a title nor transcribed pages: the Wikisource index file name is the only name recorded
        title = String(rec.index).replace(/\.(?:pdf|djvu)$/i, '');
        issues.push({ code: 'E_MISSING_TEXT', severity: 'warning', field: 'title',
          message: `ws-${lang}:${rec.index} has no title and no transcribed pages; the index file name is used as its title.`,
          suggestion: 'Nothing to do: the document is metadata only.' });
      }
      yield {
        ext_id: `ws-${lang}:${rec.index}`,
        kind: 'book',
        title,
        author: rec.author || null,
        lang_declared: lang,
        source_url: `https://${lang}.wikisource.org/wiki/Index:${encodeURIComponent(String(rec.index).replace(/ /g, '_'))}`,
        license: 'CC BY-SA (Wikisource)',
        ...(text.trim() ? { text: { original: text, decoder: 'pages-joined-ff', regions: frontMatterRegions(text), mode: 'auto' } } : {}),
        dates: [year === null
          ? { role: 'publication_unspecified', parsed: unknownDate('wikisource_index_year'), asserted_by: by, is_chronology: true,
            note: 'no year in the Wikisource index' }
          : { role: 'publication_unspecified', parsed: fromInterval(year, year, { precision: 'year', basis: 'stated', rule: 'wikisource_index_year', raw: String(year) }),
            asserted_by: by, is_chronology: true, note: 'Wikisource index year; may be an edition year' }],
        original_meta: { source: `wikisource-${lang}.jsonl`, line: r.line, ...meta,
          pages: { $text: 'document_text', count: pages.length, joined_with: '\\f', ...(kept.length < pages.length ? { kept: kept.length } : {}) } },
        ...(storedSha === sha256 ? { source_file: { sha256, byte_start: r.byteStart, byte_end: r.byteEnd } } : {}),
        _line: r.line,
        _issues: issues,
      };
    }
  }
}
