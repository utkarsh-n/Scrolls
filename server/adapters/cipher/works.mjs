// OWNER: WP2
// works.mjs — source adapter 'cipher.works': culture-works.tsv (94,385 rows, no header, 16 columns,
// 0-based row = id) → one metadata document per row, siblings → relationships, meanings → machine glosses
// (SPEC §6.5, §6.6). Titles are the only text dated with the work; summaries are later descriptions.

import { fromInterval } from '../../../src/shared/dates.mjs';
import { CIPHER } from '../../config.mjs';
import { buildSiblingRelationships } from './siblings.mjs';
import { assertedBy, exists, lineRecords, readSource, TAGGING_METHOD, unknownDate } from './source.mjs';
import { loadTagIndex, workTags } from './tags-provenance.mjs';

export const id = 'cipher.works';
export const version = '1.0.0';
export const label = 'Cipher culture works';
export const access = 'local-dataset';
export const license = 'Wikidata CC0';
export const attribution = 'Wikidata; Wikipedia';
export const stagedDir = null;
export const COLLECTION = 'cipher-culture-works';
export const collections = [
  {
    slug: COLLECTION,
    name: 'Culture works: titles (Cipher)',
    domain: 'culture',
    modality: 'titles',
    unit: 'works',
    sampling: 'prominence_selected',
    rate_eligible: true,
    export_text_allowed: true,
    coverage_gate: null,
    selection_note: 'Wikidata works ranked by sitelinks and canon lists',
    caveats: [
      'Titles only: Cipher holds no lyrics.',
      'Summaries are later descriptions (Wikidata) and are excluded from counts by default.',
      'Themes, motifs, moods and one-line meanings partly come from a machine tagging pass; they are fallible annotations, never text.',
    ],
  },
];

/** The 16 columns of culture-works.tsv, in order (data-inventory.md §2). */
export const COLUMNS = Object.freeze(['qid', 'kind', 'culture', 'year', 'weight', 'title', 'native_title', 'maker', 'summary',
  'canon', 'themes', 'motifs', 'meaning', 'mood', 'siblings', 'sampled_count']);
const SUMMARY_ERA = Object.freeze([2012, 2026]);

/**
 * Parse culture-works.tsv once per (path, size, mtime).
 * @param {string} [file]
 * @returns {{sha256: string, rows: object[], bad: Array<{line: number, fields: number}>}}
 */
export function loadWorks(file = CIPHER.cultureWorks) {
  const src = readSource(file);
  if (worksCache?.sha256 === src.sha256) return worksCache;
  const rows = [];
  const bad = [];
  for (const rec of lineRecords(src.bytes)) {
    const c = rec.text.split('\t');
    if (c.length !== COLUMNS.length) bad.push({ line: rec.index + 1, fields: c.length });
    const cols = Object.fromEntries(COLUMNS.map((k, i) => [k, c[i] ?? '']));
    // '' is Cipher's unknown year (8,227 rows); 0 never occurs but would mean the same (§0.1)
    const year = /^-?\d+$/.test(cols.year) && cols.year !== '0' ? Number(cols.year) : null;
    rows.push({ row: rec.index, cols, qid: cols.qid, title: cols.title, native: cols.native_title, maker: cols.maker,
      siblings: cols.siblings, year, byteStart: rec.byteStart, byteEnd: rec.byteEnd });
  }
  worksCache = { sha256: src.sha256, rows, bad };
  return worksCache;
}
let worksCache = null;
let mappingCache = null;

let tagCache = null;
function tagIndex() {
  tagCache ??= loadTagIndex(CIPHER.tagsDir);
  return tagCache;
}

/** Forget parsed rows and tag batches. */
export function clearCache() {
  worksCache = null;
  tagCache = null;
  mappingCache = null;
}

/**
 * The source files this adapter reads (each is copied into originals/ through ctx.keepOriginal before use).
 * @returns {string[]}
 */
export function sourceFiles() {
  return [CIPHER.cultureWorks];
}

/** @param {object} ctx AdapterCtx @returns {Promise<object>} ProbeResult */
export async function probe(ctx) {
  const missing = ['cultureWorks', 'tagsDir', 'relationsDir'].filter((k) => !exists(CIPHER[k]));
  if (missing.includes('cultureWorks')) {
    return { available: false, reason: `culture-works.tsv not found at ${CIPHER.cultureWorks}`, manifest_ok: false,
      format_ok: false, counts: {}, caveats: [] };
  }
  const { rows, bad } = loadWorks();
  return {
    available: bad.length === 0,
    ...(bad.length ? { reason: `${bad.length} rows do not have ${COLUMNS.length} tab-separated columns (first: line ${bad[0].line})` } : {}),
    manifest_ok: true, // Cipher files carry no MANIFEST.json; the column count is the format check
    format_ok: bad.length === 0,
    counts: { works: rows.length, undated: rows.filter((r) => r.year === null).length },
    caveats: missing.length ? [`not found: ${missing.join(', ')} (tag provenance or locators fall back)`] : [],
  };
}

/** @returns {Promise<{units: number}>} */
export async function plan() {
  return { units: loadWorks().rows.length };
}

/**
 * The chronology of a row: '' (or 0) → undated; > now → announced (Scheduled shelf) via the date grammar;
 * negative → BCE (historical convention).
 */
function chronology(r, by) {
  if (r.year === null) {
    return { role: 'publication', parsed: unknownDate('cipher_works_year', r.cols.year), asserted_by: by, is_chronology: true,
      note: 'no year in culture-works.tsv' };
  }
  return { role: 'publication', raw: r.cols.year, asserted_by: by, is_chronology: true,
    note: 'Cipher year (Wikidata)' };
}

/**
 * One CanonicalDocument per row.
 * @param {object} params
 * @param {object} ctx AdapterCtx (+ keepOriginal(file, src) → sha256)
 */
export async function* documents(params, ctx) {
  const { rows, sha256 } = loadWorks();
  const tags = tagIndex();
  const by = assertedBy({ id, version });
  const limit = Number.isInteger(params?.limit) ? params.limit : rows.length;
  const storedSha = ctx?.keepOriginal?.(CIPHER.cultureWorks, readSource(CIPHER.cultureWorks)) ?? null;
  for (let i = 0; i < Math.min(limit, rows.length); i++) {
    const r = rows[i];
    const c = r.cols;
    const fields = { title: c.title };
    if (c.native_title && c.native_title !== c.title) fields.native_title = c.native_title;
    if (c.summary) fields.summary = c.summary;
    const dates = [chronology(r, by)];
    if (c.summary) {
      dates.push({ role: 'authored_description', parsed: fromInterval(SUMMARY_ERA[0], SUMMARY_ERA[1],
        { precision: 'range', basis: 'estimated', rule: 'wikidata_description_era' }), asserted_by: by,
      note: 'Wikidata description, written 2012–2026 (estimated)' });
    }
    yield {
      ext_id: `cw:${r.row}`,
      kind: c.kind || 'work',
      title: c.title || null,
      native_title: fields.native_title ?? null,
      author: c.maker || null,
      culture: c.culture || null,
      prominence: c.weight === '' || !Number.isFinite(Number(c.weight)) ? null : Number(c.weight),
      fields,
      field_roles: { summary: 'describes' },
      dates,
      aliases: c.qid ? [{ ext_id: c.qid, note: c.qid.startsWith('Q') ? 'Wikidata item' : 'Cipher stub id' }] : [],
      tags: workTags(c, tags.get(c.qid) ?? null),
      original_meta: { source: 'culture-works.tsv', row: r.row, ...c },
      ...(storedSha === sha256 ? { source_file: { sha256, byte_start: r.byteStart, byte_end: r.byteEnd } } : {}),
    };
  }
}

/**
 * Siblings → relationships (§6.6). params.runIds.cipher_load is the run behind the computed kindred pairs.
 * @param {object} params
 * @param {object} ctx AdapterCtx
 */
export async function* relationships(params, ctx) {
  const { relationships: rels, stats } = siblingMapping(params);
  ctx?.log?.('info', `siblings: ${stats.items} items → ${rels.length} relationships`, { expected: stats.expected });
  yield* rels;
}

/**
 * The relationships and the parse-side statistics (reconciliation, §6.8).
 * @param {{runIds?: {cipher_load?: number}}} params
 * @returns {{relationships: object[], stats: object}}
 */
export function siblingMapping(params = {}) {
  const { rows, sha256 } = loadWorks();
  if (mappingCache?.sha256 !== sha256) {
    mappingCache = { sha256, ...buildSiblingRelationships({ rows, tagIndex: tagIndex(),
      relationsDir: exists(CIPHER.relationsDir) ? CIPHER.relationsDir : null, kindredRunId: null,
      createdBy: assertedBy({ id, version }), collection: COLLECTION }) };
  }
  const runId = params.runIds?.cipher_load ?? null;
  return { stats: mappingCache.stats,
    relationships: mappingCache.relationships.map((r) => (r.rel_type === 'kindred' ? { ...r, run_id: runId } : r)) };
}

/**
 * One-line meanings → machine glosses on the work (not document text, §6.5).
 * @param {object} params
 */
export async function* annotations(params) {
  const { rows } = loadWorks();
  for (const r of rows) {
    if (!r.cols.meaning) continue;
    yield {
      target: { type: 'document', ext_id: `cw:${r.row}` },
      kind: 'machine_gloss',
      author: 'Cipher tagging pass',
      is_machine: true,
      method: TAGGING_METHOD,
      layer: 'Cipher tagging pass',
      body_md: r.cols.meaning,
      tags: [],
    };
  }
}
