// OWNER: WP2
// books.mjs — source adapter 'cipher.books': gutenberg.json (693 entries) + texts/gutenberg/<id>.txt +
// pg_catalog.csv rows → 691 documents + 2 aliases (SPEC §6.3).
//
//  · #1661 is listed three times (three Wikidata items, one text): one document, the other two as aliases.
//  · lang_declared comes from the JSON; DocumentWriter detects lang_text and marks a mismatch as a
//    translation (expected ≈ 100 fr + ≈ 10 es books that are English text); a translation's year is then
//    the original's (role original_publication) and it leaves text-language chronology by default.
//  · The JSON year is Cipher's list year: when it equals the first author's birth + 40 (Cipher's
//    lifetime_year estimate) it is basis 'estimated'; otherwise 'stated' but unverified. `Issued` is the
//    Gutenberg release date: role 'release', never chronology.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fromInterval } from '../../../src/shared/dates.mjs';
import { CIPHER } from '../../config.mjs';
import { laneForLocc } from '../stemm/field-map.mjs';
import { gutenbergRegions } from './gutenberg-text.mjs';
import { assertedBy, decodeBytes, exists, readSource, unknownDate } from './source.mjs';

export const id = 'cipher.books';
export const version = '1.0.0';
export const label = 'Cipher Gutenberg books';
export const access = 'local-dataset';
export const license = 'Public domain (US)';
export const attribution = 'Project Gutenberg';
export const stagedDir = null;
export const COLLECTION = 'cipher-gutenberg';
export const collections = [
  {
    slug: COLLECTION,
    name: 'Project Gutenberg books (Cipher)',
    domain: 'literature',
    modality: 'text',
    unit: 'tokens',
    sampling: 'prominence_selected',
    rate_eligible: true,
    export_text_allowed: true,
    coverage_gate: null,
    selection_note: '693 public-domain books chosen by Wikipedia sitelinks (prominence), en/fr/es',
    caveats: ['Dates are Cipher list years (Wikidata-derived) or author-lifetime estimates, not verified first editions.'],
  },
];
const LIFETIME_OFFSET = 40;
const CATALOG_METHOD = 'Project Gutenberg catalogue (pg_catalog.csv)';

// ── catalogue (RFC 4180 CSV) ────────────────────────────────────────────────────────────────────────

/**
 * Parse CSV text (quoted fields, doubled quotes, newlines inside quotes).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Catalogue rows for the wanted Gutenberg ids, keyed by id.
 * @param {Set<number>} wanted
 * @returns {Map<number, Record<string, string>>}
 */
export function loadCatalog(wanted, file = CIPHER.pgCatalog) {
  const out = new Map();
  if (!exists(file)) return out;
  const rows = parseCsv(readSource(file).bytes.toString('utf8'));
  const header = rows[0];
  for (const r of rows.slice(1)) {
    const idNum = Number(r[0]);
    if (!wanted.has(idNum)) continue;
    out.set(idNum, Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  }
  return out;
}

/** First author's birth year from a catalogue Authors cell ("Darwin, Charles, 1809-1882; …"), or null. */
export function firstAuthorBirth(authors) {
  const first = String(authors ?? '').split(';')[0];
  const m = /(?:^|[\s,])(-?\d{3,4})\??\s*(?:BCE\s*)?-\s*(?:\d{3,4}|\?)?/.exec(first);
  if (!m) return null;
  const y = Number(m[1]);
  return /BCE/.test(first) ? 1 - y : y;
}

// ── entries ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * gutenberg.json grouped by Gutenberg id (the most-linked entry is the document, the others its aliases),
 * plus the catalogue rows.
 * @returns {{books: Array<{id: number, entry: object, others: object[], catalog: object|null}>, entries: number}}
 */
export function loadBooks() {
  const entries = JSON.parse(readSource(CIPHER.gutenbergJson).bytes.toString('utf8'));
  const byId = new Map();
  for (const e of entries) {
    const list = byId.get(e.id);
    if (list) list.push(e); else byId.set(e.id, [e]);
  }
  const catalog = loadCatalog(new Set(byId.keys()));
  const books = [...byId.entries()].map(([bookId, list]) => {
    const sorted = [...list].sort((a, b) => (b.links ?? 0) - (a.links ?? 0));
    return { id: bookId, entry: sorted[0], others: sorted.slice(1), catalog: catalog.get(bookId) ?? null };
  });
  return { books, entries: entries.length };
}

/** @param {number} bookId @returns {string} */
export const textPath = (bookId) => path.join(CIPHER.gutenbergDir, `${bookId}.txt`);

/** @returns {string[]} the files this adapter reads (texts are added per book by the loader) */
export function sourceFiles(params = {}) {
  const ids = params.ids ? params.ids.map(Number) : loadBooks().books.map((b) => b.id);
  return [CIPHER.gutenbergJson, CIPHER.pgCatalog, ...ids.map(textPath).filter(exists)];
}

/** @returns {Promise<object>} ProbeResult */
export async function probe() {
  for (const k of ['gutenbergJson', 'gutenbergDir', 'pgCatalog']) {
    if (!exists(CIPHER[k])) return { available: false, reason: `${k} not found at ${CIPHER[k]}`, manifest_ok: false, format_ok: false, counts: {}, caveats: [] };
  }
  const { books, entries } = loadBooks();
  const missing = books.filter((b) => !exists(textPath(b.id))).map((b) => b.id);
  return { available: true, manifest_ok: true, format_ok: true,
    counts: { entries, books: books.length, files_missing: missing.length, aliases: books.reduce((s, b) => s + b.others.length, 0) },
    caveats: missing.length ? [`text missing for ${missing.length} books: ${missing.slice(0, 5).join(', ')}`] : [] };
}

/** @param {{ids?: number[]}} params @returns {Promise<{units: number}>} */
export async function plan(params = {}) {
  const { books } = loadBooks();
  return { units: params.ids ? books.filter((b) => params.ids.map(Number).includes(b.id)).length : books.length };
}

/**
 * Dates of a book (§6.3).
 * @returns {object[]} CanonicalDocument.dates
 */
export function bookDates(entry, catalog, by) {
  const dates = [];
  const year = Number.isInteger(entry.year) ? entry.year : null;
  if (year === null) {
    dates.push({ role: 'publication', parsed: unknownDate('cipher_books_no_year'), asserted_by: by, is_chronology: true,
      note: 'gutenberg.json gives no year' });
  } else {
    const birth = firstAuthorBirth(catalog?.Authors);
    const estimated = birth !== null && year === birth + LIFETIME_OFFSET;
    dates.push(estimated
      ? { role: 'publication', parsed: fromInterval(year, year, { precision: 'year', basis: 'estimated', rule: 'cipher_lifetime_year', raw: String(year) }),
        asserted_by: by, is_chronology: true,
        note: `Cipher's author-lifetime estimate (first author's birth ${birth} + 40); it may coincide with the true date` }
      : { role: 'publication', parsed: fromInterval(year, year, { precision: 'year', basis: 'stated', rule: 'cipher_list_year', raw: String(year) }),
        asserted_by: by, is_chronology: true, note: 'Cipher list year (Wikidata-derived), unverified' });
  }
  if (catalog?.Issued) {
    dates.push({ role: 'release', raw: catalog.Issued, asserted_by: by, is_chronology: false,
      note: 'Project Gutenberg release date (not a publication date)' });
  }
  return dates;
}

/** Catalogue tags: LoCC classes and subjects (provenance 'catalog'; tags are never document text). */
function catalogTags(catalog) {
  const tags = [];
  if (!catalog) return tags;
  for (const c of String(catalog.LoCC ?? '').split(';').map((s) => s.trim()).filter(Boolean)) {
    tags.push({ scheme: 'locc', value: c, weight: null, provenance: 'catalog', method: CATALOG_METHOD });
  }
  for (const s of String(catalog.Subjects ?? '').split(';').map((x) => x.trim()).filter(Boolean)) {
    tags.push({ scheme: 'subject', value: s, weight: null, provenance: 'catalog', method: CATALOG_METHOD });
  }
  return tags;
}

/**
 * One CanonicalDocument per Gutenberg id.
 * @param {{ids?: number[], skip?: Set<string>|string[]}} params ids: only these books; skip: ext_ids already loaded
 * @param {object} ctx AdapterCtx (+ keepOriginal(file, src) → sha256)
 */
export async function* documents(params = {}, ctx = {}) {
  const { books } = loadBooks();
  const only = params.ids ? new Set(params.ids.map(Number)) : null;
  const skip = new Set(params.skip ?? []);
  const by = assertedBy({ id, version });
  for (const b of books) {
    if (only && !only.has(b.id)) continue;
    const extId = `pg:${b.id}`;
    if (skip.has(extId)) continue;
    ctx.signal?.throwIfAborted?.();
    const file = textPath(b.id);
    if (!exists(file)) {
      ctx.warn?.('W_TEXT_MISSING', `${extId}: ${file} not found; skipped`);
      continue;
    }
    const src = readSource(file, { cache: false });
    const dec = decodeBytes(src.bytes);
    const yHi = Number.isInteger(b.entry.year) ? b.entry.year : null;
    const g = gutenbergRegions(dec.text, { yHi, author: b.entry.author ?? b.catalog?.Authors ?? null });
    const issues = [...g.issues];
    if (dec.decoder !== 'utf-8') {
      issues.push({ code: 'W_ENCODING_FALLBACK', severity: 'warning', field: 'text',
        message: `${extId}: bytes are not valid UTF-8 (first bad byte at ${dec.badByte}); read as Windows-1252.`,
        suggestion: 'Nothing to do if the text reads correctly; otherwise re-download the file as UTF-8.' });
    }
    const subjects = String(b.catalog?.Subjects ?? '').split(';').map((s) => s.trim());
    const field = laneForLocc(b.catalog?.LoCC, subjects);
    const storedSha = ctx.keepOriginal?.(file, src) ?? null;
    yield {
      ext_id: extId,
      kind: 'book',
      title: b.entry.title ?? b.catalog?.Title ?? null,
      author: b.entry.author || firstAuthorName(b.catalog?.Authors) || null,
      lang_declared: b.entry.language ?? null,
      field,
      source_url: `https://www.gutenberg.org/ebooks/${b.id}`,
      license: 'Public domain in the USA (Project Gutenberg)',
      prominence: Number.isFinite(b.entry.links) ? b.entry.links : null,
      text: { original: dec.text, decoder: dec.decoder, body_start: g.body_start, body_end: g.body_end, regions: g.regions, mode: 'auto' },
      dates: bookDates(b.entry, b.catalog, by),
      aliases: b.others.map((o) => ({ ext_id: `wd:${o.q}`, title: o.title ?? null,
        note: `the same Gutenberg text (#${b.id}) is listed by Cipher for this Wikidata item too (${o.year ?? 'no year'})` })),
      tags: catalogTags(b.catalog),
      original_meta: { source: 'gutenberg.json + pg_catalog.csv', entries: [b.entry, ...b.others], catalog: b.catalog,
        text: { $text: 'document_text', file: `texts/gutenberg/${b.id}.txt`, marker: g.marker, had_bom: dec.hadBom } },
      ...(storedSha === src.sha256 ? { source_file: { sha256: src.sha256, byte_start: 0, byte_end: src.size } } : {}),
      _issues: issues,
    };
  }
}

/** "Austen, Jane, 1775-1817" → "Jane Austen". */
function firstAuthorName(authors) {
  const first = String(authors ?? '').split(';')[0].replace(/,?\s*-?\d{3,4}\??-?\d{0,4}\??.*$/, '').trim();
  const parts = first.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? `${parts[1]} ${parts[0]}` : parts[0] ?? null;
}
