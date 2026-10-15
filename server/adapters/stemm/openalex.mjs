// OWNER: WP2
// openalex.mjs — source adapter 'stemm.openalex': the staged OpenAlex sample (sources/openalex: works.jsonl,
// citations.tsv, coverage.tsv, population.tsv, fields.json; FORMAT.md + MANIFEST.json read first) → collection
// stemm-openalex (SPEC §10.2, §10.4).
//
//  · The sample is the 200 most-cited works per (field × period cell): top_cited_per_cell, never a random sample,
//    so lanes show within-cell presence shares only (cross-cell rates are refused downstream, `sampling_design`).
//    A work's cell is its OpenAlex field (the `field` doc_tag, provenance adapter_machine) × the one of OpenAlex's
//    30 bins that holds its year (BINS, cellOf — equal to the fetcher's `sample_cell` for every work); each cell's
//    population (the denominator OpenAlex reports) comes from coverage.tsv (loadCells).
//  · Each work → a document: its title (field passage) and its abstract (body, field_class 'abstract'; quality
//    'gappy' when the inverted index left gaps over 10% of its tokens or the "abstract" runs over 1,000 tokens —
//    a body excerpt, never shown as an abstract; 'low' under 10 tokens). Gappy and low passages are excluded from
//    counts and from quotation detection by default. Abstracts are publishers' text: export_text_allowed = 0.
//  · field / subfield / topic / keywords → doc_tag(adapter_machine, "OpenAlex classifier") — machine labels; the
//    STEMM lane comes from the field id through data/field-taxonomy.json.
//  · Citations → explicit_citation, documented, source_dataset 'openalex', locator https://openalex.org/<citing>;
//    a citation of a later-dated work gets date_conflict = 1 (DocumentWriter), never a feedback arc.
//  · Dates: publication_date at OpenAlex's stated precision; every date says "OpenAlex year may be a reprint or
//    digitisation year"; a 31 December date also says "possible placeholder date".

import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { fromInterval, parseDate } from '../../../src/shared/dates.mjs';
import { tokenize } from '../../../src/shared/tokenize.mjs';
import { paths } from '../../config.mjs';
import { laneForField } from './field-map.mjs';

export const id = 'stemm.openalex';
export const version = '1.1.0';
export const label = 'OpenAlex (top-cited sample per field × period)';
export const access = 'local-dataset';
export const license = 'CC0 metadata; abstracts publishers\' (local research only)';
export const attribution = 'OpenAlex (CC0)';
export const stagedDir = 'openalex';
export const command = 'node tools/fetch/openalex.mjs';
export const COLLECTION = 'stemm-openalex';
export const SELECTION_LABEL = 'top-cited sample: 200 per field × period';
export const collections = [
  {
    slug: COLLECTION,
    name: 'OpenAlex top-cited sample',
    domain: 'stemm',
    modality: 'abstracts',
    unit: 'works',
    sampling: 'top_cited_per_cell',
    rate_eligible: true,
    export_text_allowed: false,
    coverage_gate: 20,
    selection_note: SELECTION_LABEL,
    caveats: [
      'The 200 most-cited works per field and period: compare shares within a cell, never counts between cells.',
      'Field labels are a modern classifier\'s; before 1900 they are its guess.',
      'OpenAlex year may be a reprint or digitisation year.',
      'Abstract text belongs to its publishers: it is never exported.',
    ],
  },
];
/**
 * DocumentWriter options for this source: no duplicate flagging. Every work is a distinct sampled work of its cell
 * (OpenAlex ids are unique across cells); flagging an identical abstract as a duplicate would drop a sampled work from
 * its cell's presence share. (It also spares each chunk the writer's whole-collection near-duplicate index.)
 */
export const writerOptions = Object.freeze({ dedupe: 'off' });
const CLASSIFIER = 'OpenAlex classifier';
const CLASSIFIER_EARLY = 'OpenAlex classifier (a modern classifier\'s guess for a pre-1900 work)';
const YEAR_NOTE = 'OpenAlex year may be a reprint or digitisation year';
const GAPPY_SHARE = 0.1;
const GAPPY_TOKENS = 1000;
const LOW_TOKENS = 10;
const FORMAT_FIELDS = ['`abstract_gaps`', '`date_precision`', '`sample_cell`', '`field_id`', '`citing`', '`population`', '`date_note`'];

/** OpenAlex's own 30 period bins (inclusive), in order (§10.4). */
export const BINS = Object.freeze([[1665, 1799], [1800, 1849], [1850, 1874], [1875, 1899],
  ...Array.from({ length: 25 }, (_, i) => [1900 + 5 * i, 1904 + 5 * i]), [2025, 2026]]
  .map(([lo, hi]) => Object.freeze({ bin: `${lo}-${hi}`, lo, hi })));

/** The OpenAlex bin label holding a year, or null outside 1665–2026. @param {number} year @returns {string|null} */
export function binOfYear(year) {
  const b = BINS.find((x) => year >= x.lo && year <= x.hi);
  return b ? b.bin : null;
}

/** A work's sample cell "<field>|<bin>" (equals the fetcher's sample_cell). @param {{field: string, year: number}} w */
export const cellOf = (w) => `${w.field}|${binOfYear(w.year)}`;

const dir = () => path.join(paths().sources, stagedDir);

/** Read MANIFEST.json and FORMAT.md first (§10.1). */
export async function probe() {
  const d = dir();
  if (!existsSync(path.join(d, 'MANIFEST.json'))) return unavailable(`MANIFEST.json not found under sources/${stagedDir}`);
  if (!existsSync(path.join(d, 'FORMAT.md'))) return unavailable(`FORMAT.md not found under sources/${stagedDir}`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(path.join(d, 'MANIFEST.json'), 'utf8')); } catch (err) { return unavailable(`MANIFEST.json is not valid JSON: ${err.message}`); }
  const format = readFileSync(path.join(d, 'FORMAT.md'), 'utf8');
  const missing = FORMAT_FIELDS.filter((k) => !format.includes(k));
  if (missing.length) return unavailable(`FORMAT.md does not describe ${missing.join(', ')}`, { manifest_ok: true });
  for (const f of ['works.jsonl', 'citations.tsv', 'coverage.tsv']) if (!existsSync(path.join(d, f))) return unavailable(`${f} not found`, { manifest_ok: true, format_ok: true });
  const c = manifest.counts ?? {};
  const n = (...keys) => Number(keys.map((k) => c[k]).find((v) => v !== undefined) ?? 0);
  return { available: true, manifest_ok: true, format_ok: true,
    counts: { works: n('works'), abstracts: n('works_with_abstract', 'with_abstract'), citations: n('citation_pairs_within_sample', 'citations'),
      citations_cited_later: n('citation_pairs_cited_later_than_citing'), cells: n('cells_total') },
    caveats: [...collections[0].caveats, ...(Array.isArray(manifest.caveats) ? manifest.caveats.map(String).slice(0, 6) : [])] };
}
function unavailable(reason, extra = {}) {
  return { available: false, reason, manifest_ok: false, format_ok: false, counts: {}, caveats: [], ...extra };
}

/**
 * The 600 cells (field × bin) of coverage.tsv: population (every OpenAlex work matching field + years + types — the
 * denominator), fetched (= min(200, population)), with_abstract, with_references.
 * @returns {Array<{field: string, field_id: string, tier: string, bin: string, bin_start: number, bin_end: number,
 *   status: string, population: number, fetched: number, with_abstract: number, with_references: number}>}
 */
export function loadCells() {
  const lines = readFileSync(path.join(dir(), 'coverage.tsv'), 'utf8').split('\n').filter(Boolean);
  const head = lines[0].split('\t');
  return lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i], /^\d+$/.test(v) ? Number(v) : v])))
    .map(({ field, field_id, tier, bin, bin_start, bin_end, status, population, fetched, with_abstract, with_references }) =>
      ({ field, field_id, tier, bin, bin_start, bin_end, status, population, fetched, with_abstract, with_references }));
}

/**
 * Lines of a staged file from a byte offset, with the byte offset after each line (the resume cursor of a chained
 * load). Lines are not parsed here, so callers can skip loaded records cheaply.
 * @param {string} file
 * @param {number} [from] byte offset of a line start
 * `start` and `end` are the line's byte range (without its newline), for the record's source_file pointer.
 * @returns {AsyncGenerator<{line: string, next: number, start: number, end: number}>}
 */
export async function* fileLines(file, from = 0) {
  let offset = from, rest = null;
  for await (const chunk of createReadStream(file, { start: from, highWaterMark: 1 << 22 })) {
    const buf = rest ? Buffer.concat([rest, chunk]) : chunk;
    let start = 0;
    for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, start)) {
      if (nl > start) yield { line: buf.toString('utf8', start, nl), next: offset + nl + 1, start: offset + start, end: offset + nl };
      start = nl + 1;
    }
    offset += start;
    rest = start < buf.length ? buf.subarray(start) : null;
  }
  if (rest?.length) yield { line: rest.toString('utf8'), next: offset + rest.length, start: offset, end: offset + rest.length };
}

const ID_RE = /^\{"id":"(W\d+)"/;
const YEAR_RE = /"year":(-?\d+)/;
const FIELD_RE = /"field":"((?:[^"\\]|\\.)*)"/;
const wanted = (w, params) => (!params.fields?.length || params.fields.includes(w.field)) &&
  (!params.years || (w.year >= params.years[0] && w.year <= params.years[1]));

/**
 * Whether a raw works.jsonl line can be one the params select, decided without parsing it when the line says so
 * (a parsed record is checked again with `wanted`).
 */
function lineMayMatch(line, params) {
  if (params.years) {
    const y = YEAR_RE.exec(line);
    if (y && (Number(y[1]) < params.years[0] || Number(y[1]) > params.years[1])) return false;
  }
  if (params.fields?.length) {
    const f = FIELD_RE.exec(line);
    if (f && !params.fields.includes(JSON.parse(`"${f[1]}"`))) return false;
  }
  return true;
}

/** @returns {Promise<{units: number}>} works the params select */
export async function plan(params = {}) {
  if (!params.fields?.length && !params.years) return { units: Number((await probe()).counts.works ?? 0) };
  let n = 0;
  for await (const { line } of fileLines(path.join(dir(), 'works.jsonl'))) if (lineMayMatch(line, params) && wanted(JSON.parse(line), params)) n++;
  return { units: n };
}

/** The date of a work at OpenAlex's stated precision. */
export function workDate(w, by) {
  const notes = [YEAR_NOTE];
  if (w.date_note) notes.push(w.date_note);
  if (/-12-31$/.test(w.publication_date ?? '') && !notes.some((n) => /placeholder/.test(n))) notes.push('possible placeholder date');
  let parsed;
  if (w.date_precision === 'day') parsed = parseDate(w.publication_date, { now: new Date() });
  else if (w.date_precision === 'month') parsed = parseDate(String(w.publication_date).slice(0, 7), { now: new Date() });
  if (!parsed || parsed.issue) parsed = fromInterval(w.year, w.year, { precision: 'year', basis: 'stated', rule: 'openalex:publication_year', raw: String(w.year) });
  return { role: 'publication', parsed: { ...parsed, basis: 'stated', rule: `openalex:${w.date_precision}` }, asserted_by: by, is_chronology: true,
    note: notes.join('; ') };
}

/** Quality of an abstract (§10.2, §4.7): 'gappy' (index gaps > 10% or > 1,000 tokens: a body excerpt), 'low' (< 10 tokens), 'ok'. */
export function abstractQuality(w) {
  if (w.abstract_gaps > GAPPY_SHARE * Math.max(1, w.abstract_tokens) || w.abstract_tokens > GAPPY_TOKENS) return 'gappy';
  if (tokenize(w.abstract ?? '').tokens.length < LOW_TOKENS) return 'low';
  return 'ok';
}

const KINDS = { article: 'paper', review: 'paper', preprint: 'paper', book: 'book', 'book-chapter': 'book' };

/**
 * One CanonicalDocument per work, in file order; each carries `_cursor` (the byte offset after its line) so a
 * chained load resumes there.
 * @param {{fields?: string[], years?: [number, number], abstracts?: boolean, skip?: Iterable<string>, from?: number}} params
 * @param {object} ctx AdapterCtx (+ keepOriginal)
 */
export async function* documents(params = {}, ctx = {}) {
  const by = `adapter:${id}@${version}`;
  const skip = params.skip instanceof Set ? params.skip : new Set(params.skip ?? []);
  const file = path.join(dir(), 'works.jsonl');
  // the works file is 276 MB: its bytes are kept in originals/ once (the bulk text of each record points there)
  const sha = ctx.keepOriginal?.(file) ?? null;
  for await (const { line, next, start, end } of fileLines(file, params.from ?? 0)) {
    const idm = ID_RE.exec(line);
    if ((idm && skip.has(`oa:${idm[1]}`)) || !lineMayMatch(line, params)) continue;
    const w = JSON.parse(line);
    if (!wanted(w, params) || skip.has(`oa:${w.id}`)) continue;
    const withAbstract = params.abstracts !== false && typeof w.abstract === 'string' && w.abstract.trim().length > 0;
    const { abstract, referenced_works: refs, ...meta } = w;
    const title = w.title || `(untitled OpenAlex work ${w.id})`;
    const classifier = w.year < 1900 ? CLASSIFIER_EARLY : CLASSIFIER;
    yield {
      ext_id: `oa:${w.id}`,
      kind: KINDS[w.type] ?? 'paper',
      title,
      author: (w.authors ?? []).slice(0, 3).join('; ') + ((w.author_count ?? 0) > 3 ? ' et al.' : '') || null,
      field: laneForField({ source: 'openalex', value: String(w.field_id ?? '').replace('fields/', '') }),
      source_url: `https://openalex.org/${w.id}`,
      license: 'OpenAlex metadata CC0; abstract text belongs to its publisher (local research only)',
      prominence: w.cited_by_count ?? null,
      ...(withAbstract ? {
        text: { original: w.abstract, decoder: 'utf-8', mode: 'prose',
          regions: [{ start: 0, end: w.abstract.length, quality: abstractQuality(w), time_role: 'document', field_class: 'abstract' }] },
      } : {}),
      fields: { title },
      dates: [workDate(w, by)],
      aliases: w.doi ? [{ ext_id: `doi:${String(w.doi).toLowerCase()}`, note: 'DOI' }] : [],
      tags: [
        { scheme: 'field', value: w.field, weight: null, provenance: 'adapter_machine', method: classifier },
        { scheme: 'subfield', value: w.subfield, weight: null, provenance: 'adapter_machine', method: classifier },
        { scheme: 'topic', value: w.topic, weight: w.topic_score ?? null, provenance: 'adapter_machine', method: classifier },
        ...(w.keywords ?? []).map((k) => ({ scheme: 'keyword', value: k.term, weight: k.score, provenance: 'adapter_machine', method: 'OpenAlex keywords (machine-derived)' })),
      ].filter((t) => t.value),
      original_meta: { source: 'openalex works.jsonl', ...meta, sample_cell: w.sample_cell ?? cellOf(w),
        abstract: withAbstract ? { $text: 'document_text' } : null,
        referenced_works: refs.length > 200 ? { count: refs.length, first: refs.slice(0, 200) } : refs },
      // the record's line in the kept works.jsonl (D18 provenance chain; fix pass: the pointer was missing)
      ...(sha ? { source_file: { sha256: sha, byte_start: start, byte_end: end } } : {}),
      _cursor: next,
    };
  }
}

/** Work ids the params select, read from works.jsonl (when the caller did not say which works are loaded). */
async function selectedIds(params) {
  const keep = new Set();
  for await (const { line } of fileLines(path.join(dir(), 'works.jsonl'))) {
    if (!lineMayMatch(line, params)) continue;
    const w = JSON.parse(line);
    if (wanted(w, params)) keep.add(w.id);
  }
  return keep;
}

/** Size of citations.tsv in bytes (the denominator of the relationship cursor). */
export const citationsBytes = () => statSync(path.join(dir(), 'citations.tsv')).size;

/** The header line's length, so a cursor of 0 skips it. */
function headerEnd(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, 256, 0);
    const nl = buf.subarray(0, n).indexOf(10);
    return nl < 0 ? n : nl + 1;
  } finally { closeSync(fd); }
}

/**
 * Citations between loaded works: explicit_citation, documented by OpenAlex's reference lists. Each carries
 * `_cursor` (byte offset after its line in citations.tsv).
 * @param {{loaded?: Set<string>, existing?: Set<string>, from?: number, fields?: string[], years?: [number, number]}} params
 *   loaded: work ids ('W…') present in the database (default: the works the params select); existing:
 *   'citing|cited' pairs already written (skipped); from: byte offset to resume at
 */
export async function* relationships(params = {}) {
  const by = `adapter:${id}@${version}`;
  const keep = params.loaded ?? await selectedIds(params);
  const existing = params.existing ?? new Set();
  const file = path.join(dir(), 'citations.tsv');
  const from = Math.max(params.from ?? 0, headerEnd(file));
  for await (const { line, next } of fileLines(file, from)) {
    const [citing, cited, citingYear, citedYear] = line.split('\t');
    if (!citing || !keep.has(citing) || !keep.has(cited) || existing.has(`${citing}|${cited}`)) continue;
    yield {
      src: { collection: COLLECTION, ext_id: `oa:${citing}` }, dst: { collection: COLLECTION, ext_id: `oa:${cited}` },
      rel_type: 'explicit_citation', evidence_status: 'documented', origin: 'source_dataset', source_dataset: 'openalex',
      source_locator: `https://openalex.org/${citing}`, method: 'OpenAlex referenced_works (citations.tsv)', created_by: by,
      license: 'CC0', attribution: 'OpenAlex',
      ...(Number(citedYear) > Number(citingYear) ? { provenance_note: `cites a later-dated work (${citedYear} > ${citingYear}): a date conflict, not feedback` } : {}),
      _cursor: next,
    };
  }
}
