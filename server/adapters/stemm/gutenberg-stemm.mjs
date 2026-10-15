// OWNER: WP2
// gutenberg-stemm.mjs — source adapter 'stemm.gutenberg-stemm': the staged Gutenberg STEMM shelf
// (sources/gutenberg-stemm: catalog.jsonl + texts/<id>.txt + cipher-overlap.jsonl, FORMAT.md + MANIFEST.json read
// first) → collections stemm-gutenberg and stemm-gutenberg-restricted (SPEC §10.2).
//
//  · The original is the whole decoded file; the catalogue's byte bounds become UTF-16 body bounds, so offsets
//    still index the original (D4). sha256 is verified against the catalogue: a mismatch skips the row
//    (W_SHA_MISMATCH). A row without a file becomes a metadata-only document ("text not downloaded").
//  · Residue the catalogue's bounds leave inside the body (FORMAT.md "Gutenberg residue": producer credits,
//    transcriber's notes and transcription-convention notes) is flagged by cipher/gutenberg-text.mjs bodyRegions:
//    credits → quality 'boilerplate', transcriber text → 'apparatus'. Nothing is deleted.
//  · The 20 texts Gutenberg distributes under copyright (text_export_allowed: false, from Gutenberg's own rights
//    statement pg_rights) go to their own collection, stemm-gutenberg-restricted, whose export_text_allowed is 0:
//    they can be read and searched here, never exported or shared.
//  · Dates by basis: the primary date_evidence — title-stated, gutenberg-marc906, wikidata-P577,
//    wikidata-work-P577 → basis stated at its precision; author-lifetime-estimate → an estimated range (striped);
//    unknown → undated. Catalogue years are historical (−300 = 300 BCE) and are converted to astronomical years.
//    `gutenberg_issued` is a release date, never chronology. date_disagreement_years > 5 adds a note.
//  · Ids present in cipher-overlap.jsonl are never duplicated: they are aliases of the Cipher document.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { daysInMonth, dayFromYMD, fromDayInterval, fromInterval, parseDate } from '../../../src/shared/dates.mjs';
import { paths } from '../../config.mjs';
import { bodyRegions } from '../cipher/gutenberg-text.mjs';
import { assertedBy, readSource, unknownDate } from '../cipher/source.mjs';
import { laneForField } from './field-map.mjs';
import { translationReason } from './translation.mjs';

export const id = 'stemm.gutenberg-stemm';
export const version = '1.1.0';
export const label = 'Gutenberg STEMM shelf';
export const access = 'local-dataset';
export const license = 'Public domain in the USA (Project Gutenberg); 20 texts copyrighted (no text export)';
export const attribution = 'Project Gutenberg (www.gutenberg.org); dates and sitelinks from Wikidata (CC0)';
export const stagedDir = 'gutenberg-stemm';
export const command = 'node tools/fetch/gutenberg-stemm.mjs';
export const COLLECTION = 'stemm-gutenberg';
export const RESTRICTED = 'stemm-gutenberg-restricted';
const common = {
  domain: 'stemm', modality: 'text', unit: 'tokens', sampling: 'curated', rate_eligible: true, coverage_gate: null,
  selection_note: 'LoCC Q/R/T shelf, balanced by field quotas and period bins; priority-scored by prominence',
};
export const collections = [
  { slug: COLLECTION, name: 'Gutenberg STEMM shelf', export_text_allowed: true, ...common,
    license: 'Public domain in the USA (Project Gutenberg)',
    caveats: ['Selection favours Wikidata-notable and downloaded works; not a random sample of Gutenberg\'s STEMM holdings.',
      'Many dates are estimates from the first author\'s life dates (striped), not evidence.'] },
  { slug: RESTRICTED, name: 'Gutenberg STEMM shelf (copyrighted, no text export)', export_text_allowed: false, ...common,
    license: 'Copyrighted (distributed by Project Gutenberg with the rights holder\'s permission; terms in the copyright notice inside the text)',
    caveats: ['Copyrighted texts: they can be read and searched here, but their text is never exported or shared.'] },
];
const STATED = new Set(['title-stated', 'gutenberg-marc906', 'wikidata-P577', 'wikidata-work-P577']);
const CATALOG_METHOD = 'Project Gutenberg catalogue (gutenberg-stemm)';
const FORMAT_FIELDS = ['`body_start_byte`', '`body_end_byte`', '`sha256`', '`date_evidence`', '`date_basis`',
  '`text_export_allowed`', '`gutenberg_issued`', '`body_residue`', '`pg_rights`'];
/** The public-domain cut-off of the full-text seam (§1.10): "after 1928" in the coverage line. */
const SEAM_YEAR = 1928;

const dir = () => path.join(paths().sources, stagedDir);
const astro = (y) => (Number.isInteger(y) && y < 0 ? y + 1 : y);

let cache = null;
/** catalog.jsonl rows (cached by file content). @returns {object[]} */
export function loadCatalog() {
  const src = readSource(path.join(dir(), 'catalog.jsonl'));
  if (cache?.sha === src.sha256) return cache.rows;
  const rows = src.bytes.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  cache = { sha: src.sha256, rows };
  return rows;
}

function overlapRows() {
  const f = path.join(dir(), 'cipher-overlap.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** The collection a catalogue row belongs to (copyrighted texts are kept apart). */
export const collectionOf = (r) => (r.text_export_allowed === true ? COLLECTION : RESTRICTED);

/**
 * What the coverage panel prints per load (§10.2): rows dated by evidence, by a lifetime estimate, undated, and
 * whose date lies wholly after the 1928 seam; plus the rows whose text may not be exported.
 * @param {object[]} rows catalogue rows
 * @returns {{dated_by_evidence: number, lifetime_estimate: number, undated: number, after_1928: number, restricted: number}}
 */
export function coverageCounts(rows) {
  const c = { dated_by_evidence: 0, lifetime_estimate: 0, undated: 0, after_1928: 0, restricted: 0 };
  for (const r of rows) {
    if (r.date_basis === 'unknown' || r.year_lo === null || r.year_lo === undefined) c.undated++;
    else if (r.date_basis === 'author-lifetime-estimate') c.lifetime_estimate++;
    else c.dated_by_evidence++;
    if (Number.isInteger(r.year_lo) && r.year_lo > SEAM_YEAR) c.after_1928++;
    if (r.text_export_allowed !== true) c.restricted++;
  }
  return c;
}

/** "dated by evidence X · lifetime estimate Y · undated Z · after 1928 W" (the coverage-panel line). */
export const coverageLine = (c) =>
  `dated by evidence ${c.dated_by_evidence} · lifetime estimate ${c.lifetime_estimate} · undated ${c.undated} · after 1928 ${c.after_1928}`;

/** Read MANIFEST.json and FORMAT.md first (§10.1), then count what the coverage panel reports. */
export async function probe() {
  const d = dir();
  if (!existsSync(path.join(d, 'MANIFEST.json'))) return unavailable(`MANIFEST.json not found under sources/${stagedDir} (the fetch may still be running).`);
  if (!existsSync(path.join(d, 'FORMAT.md'))) return unavailable(`FORMAT.md not found under sources/${stagedDir}.`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(path.join(d, 'MANIFEST.json'), 'utf8')); } catch (err) { return unavailable(`MANIFEST.json is not valid JSON: ${err.message}`); }
  const format = readFileSync(path.join(d, 'FORMAT.md'), 'utf8');
  const missing = FORMAT_FIELDS.filter((k) => !format.includes(k));
  if (missing.length) return unavailable(`FORMAT.md does not describe ${missing.join(', ')}`, { manifest_ok: true });
  if (!existsSync(path.join(d, 'catalog.jsonl'))) return unavailable('catalog.jsonl not found', { manifest_ok: true, format_ok: true });
  const rows = loadCatalog();
  const cov = coverageCounts(rows);
  const counts = { texts: rows.length, with_file: rows.filter((r) => existsSync(path.join(d, r.file))).length,
    periodical_issues: rows.filter((r) => r.kind === 'periodical-issue').length, ...cov };
  const caveats = [coverageLine(cov), ...(Array.isArray(manifest.caveats) ? manifest.caveats.map(String).slice(0, 8) : [])];
  return { available: true, manifest_ok: true, format_ok: true, counts, caveats };
}
function unavailable(reason, extra = {}) {
  return { available: false, reason, manifest_ok: false, format_ok: false, counts: {}, caveats: [], ...extra };
}

const wanted = (r, params, only) => (!params.collection || collectionOf(r) === params.collection) && (!only || only.has(r.id));

/** @returns {Promise<{units: number}>} rows of the requested collection (or all) */
export async function plan(params = {}) {
  const only = params.ids ? new Set(params.ids.map(Number)) : null;
  return { units: loadCatalog().filter((r) => wanted(r, params, only)).length };
}

/** Year interval → DateParse at the narrowest honest precision (a whole decade is 'decade'). */
function statedInterval(lo, hi, rule, raw) {
  const precision = lo === hi ? 'year' : (lo % 10 === 0 && hi === lo + 9 ? 'decade' : 'range');
  return fromInterval(lo, hi, { precision, basis: 'stated', rule, raw });
}

/**
 * Primary date of a catalogue row → CanonicalDocument date (§10.2).
 * @param {object} r catalogue row
 * @param {string} by asserted_by
 * @returns {object} a CanonicalDocument date
 */
export function primaryDate(r, by) {
  const notes = [];
  if ((r.date_disagreement_years ?? 0) > 5) notes.push(`first publication vs edition differ by ${r.date_disagreement_years} years`);
  if (r.date_basis === 'wikidata-P577' || r.date_basis === 'wikidata-work-P577') notes.push('Wikidata publication date of the work; the transcribed edition may differ');
  if (r.date_basis === 'gutenberg-marc906') notes.push('year of the printed source Gutenberg transcribed (MARC 906)');
  const note = (lead) => [lead, ...notes].filter(Boolean).join('; ') || null;
  const rule = `gutenberg-stemm:${r.date_basis}`;
  if (r.date_basis === 'unknown' || r.year_lo === null || r.year_lo === undefined) {
    return { role: 'publication', parsed: unknownDate(rule), asserted_by: by, is_chronology: true, note: note('no date stated by any source') };
  }
  const lo = astro(r.year_lo), hi = astro(r.year_hi ?? r.year_lo);
  if (r.date_basis === 'author-lifetime-estimate') {
    const who = r.date_evidence?.[0]?.raw ?? 'the first author';
    return { role: 'publication', parsed: fromInterval(lo, hi, { precision: 'range', basis: 'estimated', rule, raw: `${who}: ${r.year_lo}–${r.year_hi}` }),
      asserted_by: by, is_chronology: true, note: note('estimated from the first author\'s life dates (birth + 20 to death or Gutenberg release), not evidence') };
  }
  if (!STATED.has(r.date_basis)) {
    return { role: 'publication', parsed: unknownDate(rule), asserted_by: by, is_chronology: true, note: note(`unrecognised date basis '${r.date_basis}'`) };
  }
  let parsed;
  let lead = null;
  if (r.date_precision === 'day' || r.date_precision === 'month') {
    const p = parseDate(r.date, { now: new Date() });
    parsed = p.issue ? statedInterval(lo, hi, rule, r.date) : { ...p, basis: 'stated', rule };
  } else if (r.date_precision === 'month-range') {
    const [a, b] = String(r.date).split('/');
    const [ya, ma] = a.split('-').map(Number), [yb, mb] = b.split('-').map(Number);
    parsed = fromDayInterval(dayFromYMD(astro(ya), ma, 1), dayFromYMD(astro(yb), mb, daysInMonth(astro(yb), mb)),
      { precision: 'range', basis: 'stated', rule, raw: r.date });
    lead = 'a two-month issue, dated as its two months';
  } else {
    parsed = statedInterval(lo, hi, rule, r.date ?? `${r.year_lo}–${r.year_hi}`);
  }
  return { role: 'publication', parsed, asserted_by: by, is_chronology: true, note: note(lead ?? `${r.date_basis} (gutenberg-stemm catalogue)`) };
}

/** "Darwin, Charles" → "Charles Darwin". */
const displayName = (n) => {
  const parts = String(n).split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : String(n);
};

/** Byte offset → UTF-16 offset of the same position in the decoded text. */
function charOffset(bytes, byteOffset, decoder, bomBytes) {
  if (byteOffset === null || byteOffset === undefined) return null;
  const slice = bytes.subarray(bomBytes, Math.max(bomBytes, byteOffset));
  return new TextDecoder(decoder, { ignoreBOM: true }).decode(slice).length;
}

/**
 * One CanonicalDocument per catalogue row of the requested collection, in catalogue order.
 * @param {{collection?: string, ids?: number[], skip?: Iterable<string>}} params
 * @param {object} ctx AdapterCtx (+ keepOriginal(file, src) → sha256)
 */
export async function* documents(params = {}, ctx = {}) {
  const d = dir();
  const by = assertedBy({ id, version });
  const overlap = new Set(overlapRows().map((o) => o.id));
  const only = params.ids ? new Set(params.ids.map(Number)) : null;
  const skip = params.skip instanceof Set ? params.skip : new Set(params.skip ?? []);
  for (const r of loadCatalog()) {
    if (!wanted(r, params, only)) continue;
    const extId = `pgs:${r.id}`;
    if (skip.has(extId) || overlap.has(r.id)) continue; // a Cipher book: aliased, never duplicated (see aliases())
    ctx.signal?.throwIfAborted?.();
    const file = path.join(d, r.file);
    const credited = r.authors.filter((a) => !a.role || a.role === 'Author');
    const translated = translationReason(r);
    const base = {
      ext_id: extId,
      kind: r.kind === 'periodical-issue' ? 'periodical' : 'book',
      title: r.title,
      author: credited.map((a) => displayName(a.name)).join('; ') || null,
      lang_declared: r.language,
      field: laneForField({ source: 'stemm', value: r.field }),
      source_url: `https://www.gutenberg.org/ebooks/${r.id}`,
      license: r.license,
      prominence: Number.isFinite(r.sitelinks) ? r.sitelinks : null,
      dates: [primaryDate(r, by), ...(r.gutenberg_issued
        ? [{ role: 'release', raw: r.gutenberg_issued, asserted_by: by, is_chronology: false, note: 'Project Gutenberg release date (not a publication date)' }] : [])],
      aliases: r.qid ? [{ ext_id: `wd:${r.qid}`, note: 'Wikidata item (P2034)' }] : [],
      tags: [
        ...r.locc.map((v) => ({ scheme: 'locc', value: v, weight: null, provenance: 'catalog', method: CATALOG_METHOD })),
        ...r.subjects.map((v) => ({ scheme: 'subject', value: v, weight: null, provenance: 'catalog', method: CATALOG_METHOD })),
        ...r.bookshelves.map((v) => ({ scheme: 'subject', value: v, weight: null, provenance: 'catalog', method: 'Project Gutenberg bookshelf' })),
        { scheme: 'field', value: r.field, weight: null, provenance: 'catalog', method: `gutenberg-stemm field rule: ${r.field_rule}` },
        ...r.authors.map((a) => ({ scheme: 'maker', value: displayName(a.name), weight: null, provenance: 'catalog', method: a.role ? `${CATALOG_METHOD} (${a.role})` : CATALOG_METHOD })),
      ],
      original_meta: { source: 'gutenberg-stemm catalog.jsonl', ...r, text: { $text: 'document_text', file: r.file } },
      // The writer dates a translation by the original work and keeps it out of text-language chronology (D8).
      ...(translated ? { translation: { reason: translated } } : {}),
    };
    if (!existsSync(file)) {
      yield { ...base, fields: { title: r.title }, original_meta: { ...base.original_meta, note: 'text not downloaded' } };
      continue;
    }
    const src = readSource(file, { cache: false });
    if (r.sha256 && src.sha256 !== r.sha256) {
      ctx.warn?.('W_SHA_MISMATCH', `File ${r.file} does not match its catalogue sha256; row skipped.`,
        { ext_id: extId, suggestion: `Re-run ${command} to refresh the file, then load again.` });
      continue;
    }
    const bomBytes = src.bytes[0] === 0xEF && src.bytes[1] === 0xBB && src.bytes[2] === 0xBF ? 3 : 0;
    const decoder = r.encoding === '8-bit (not valid UTF-8)' ? 'windows-1252' : 'utf-8';
    // the file's one BOM is stripped here; a second U+FEFF is text (ignoreBOM), as in a standard decode (D4, fix pass)
    const text = new TextDecoder(decoder, { ignoreBOM: true }).decode(src.bytes.subarray(bomBytes));
    const bodyStart = charOffset(src.bytes, r.body_start_byte, decoder, bomBytes) ?? 0;
    const bodyEnd = Math.max(bodyStart, charOffset(src.bytes, r.body_end_byte, decoder, bomBytes) ?? text.length);
    const { regions } = bodyRegions(text, bodyStart, bodyEnd, { yHi: astro(r.year_hi), author: base.author });
    const sha = ctx.keepOriginal?.(file, src) ?? null;
    yield {
      ...base,
      text: { original: text, decoder, body_start: bodyStart, body_end: bodyEnd, regions, mode: 'auto' },
      ...(sha === src.sha256 ? { source_file: { sha256: sha, byte_start: 0, byte_end: src.size } } : {}),
      ...(r.body_start_byte === null ? { _issues: [{ code: 'W_NO_GUTENBERG_MARKERS', severity: 'warning', message: `${extId}: no Gutenberg markers; the whole file is the body.`, suggestion: 'Nothing to do; the boilerplate pass flags leftover licence text.' }] } : {}),
    };
  }
}

/** Cipher books that are on the STEMM shelf: aliases onto the Cipher documents (never duplicated). */
export function aliases() {
  return overlapRows().filter((o) => o.stemm)
    .map((o) => ({ target: { collection: 'cipher-gutenberg', ext_id: `pg:${o.id}` }, alias: { ext_id: `pgs:${o.id}`, title: o.pg_title ?? null,
      note: `on the Gutenberg STEMM shelf (${o.field ?? 'STEMM'}${o.field_class ? `, LoCC ${o.field_class}` : ''})` } }));
}
