// OWNER: WP2
// ngram.mjs — source adapter 'stemm.ngram': the staged Google Books Ngram store (sources/ngram-baseline/
// ngram-eng-1.sqlite, English 1-grams, 2020 edition, CC BY 3.0) → per-decade per-million baseline series for one
// word (SPEC §10.2). No documents: the baseline is a different corpus on its own track and axis, never mixed into
// Scrolls counts. Rates are Σ counts / Σ corpus tokens per decade (never averaged yearly ratios); each decade
// carries its evidence base (books scanned), and decades under 500 books are flagged thin.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
import { paths } from '../../config.mjs';

export const id = 'stemm.ngram';
export const version = '1.0.0';
export const label = 'Google Books Ngram baseline (English 1-grams)';
export const access = 'local-dataset';
export const license = 'CC BY 3.0';
export const attribution = 'Google Books Ngram, English, 2020 edition';
export const stagedDir = 'ngram-baseline';
// The baseline has its own track and no documents (§10.2), so no collection.
export const collections = [];
export const command = 'node tools/fetch/ngram-baseline.mjs';

export const LABEL = 'Google Books Ngram, English, 2020 edition — a different corpus';
const YEAR0 = 1500;
const YEARS = 520;
const THIN_VOLUMES = 500;
const FILE = 'ngram-eng-1.sqlite';

const dir = () => path.join(paths().sources, stagedDir);

/** Read MANIFEST.json and FORMAT.md first (§10.1); then the store's own meta. */
export async function probe() {
  const d = dir();
  const manifestPath = path.join(d, 'MANIFEST.json'), formatPath = path.join(d, 'FORMAT.md'), store = path.join(d, FILE);
  if (!existsSync(manifestPath)) return unavailable(`MANIFEST.json not found under sources/${stagedDir}`);
  if (!existsSync(formatPath)) return unavailable(`FORMAT.md not found under sources/${stagedDir}`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (err) { return unavailable(`MANIFEST.json is not valid JSON: ${err.message}`); }
  const format = readFileSync(formatPath, 'utf8');
  const formatOk = ['`ngram`', '`totals`', '`counts`', '`volumes`', '`top_form`'].every((k) => format.includes(k));
  if (!formatOk) return unavailable('FORMAT.md does not describe the ngram/totals tables this adapter reads', { manifest_ok: true });
  if (!existsSync(store)) return unavailable(`The Ngram store is not staged (sources/${stagedDir}/${FILE}).`, { manifest_ok: true, format_ok: true });
  const db = openStore();
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  if (meta.complete !== '1') return unavailable('the Ngram store is incomplete (meta.complete is not "1")', { manifest_ok: true, format_ok: true });
  return {
    available: true, manifest_ok: true, format_ok: true,
    counts: { types: Number(meta.types_kept ?? 0), years: Number(meta.n_years ?? YEARS) },
    caveats: Array.isArray(manifest.caveats) ? manifest.caveats.map(String) : [],
  };
}
function unavailable(reason, extra = {}) {
  return { available: false, reason, manifest_ok: false, format_ok: false, counts: {}, caveats: [], ...extra };
}

/** @returns {Promise<{units: number}>} */
export async function plan() {
  return { units: 0 };
}

/** No documents (§10.2). */
// eslint-disable-next-line require-yield
export async function* documents() {}

let store = null;
function openStore() {
  const file = path.join(dir(), FILE);
  if (store?.file !== file) {
    try { store?.db.close(); } catch { /* already closed */ }
    store = { file, db: new DatabaseSync(file, { readOnly: true }) };
  }
  return store.db;
}

/** A counts/volumes blob: raw DEFLATE of 520 little-endian u32 (slot i = year 1500 + i), per FORMAT.md. */
export function decodeSeries(blob) {
  const buf = inflateRawSync(blob);
  if (buf.length !== YEARS * 4) throw new Error(`bad Ngram blob length ${buf.length} (expected ${YEARS * 4})`);
  const out = new Uint32Array(YEARS);
  for (let i = 0; i < YEARS; i++) out[i] = buf.readUInt32LE(i * 4);
  return out;
}

/** Google's fold for this store: NFC → toLowerCase() → NFC. */
export const foldNgram = (w) => String(w).normalize('NFC').toLowerCase().normalize('NFC');

/**
 * The baseline for one word.
 * @param {string} word
 * @param {{from?: number|null, to?: number|null}} [range] decades kept (inclusive years)
 * @returns {object} the Baseline shape of §7.2: {available:true, word, top_form, forms, label, attribution, decades, caveats}
 *   or {available:false, reason}
 */
export function series(word, { from = null, to = null, lang = null } = {}) {
  const raw = String(word ?? '').trim();
  if (!raw) return { available: false, reason: 'no word given' };
  if (/\s/.test(raw)) return { available: false, reason: 'single words only' };
  if (lang && !/^en\b/i.test(lang)) return { available: false, reason: 'The Ngram store holds English words only.' };
  if (!existsSync(path.join(dir(), FILE))) return { available: false, reason: `The Ngram store is not staged (sources/${stagedDir}/${FILE}).` };
  const db = openStore();
  const w = foldNgram(raw);
  const row = db.prepare('SELECT word, total, first_year, last_year, counts, volumes, forms, top_form FROM ngram WHERE word = ?').get(w);
  if (!row) {
    return { available: false, reason: w.includes('-') ? "hyphenated words are split by Google's tokenizer; this form is not in the store"
      : `'${w}' is not in the store (it keeps words with ≥ 100,000 matches 1500–2019, plus seed words)` };
  }
  const counts = decodeSeries(row.counts), volumes = decodeSeries(row.volumes);
  const totals = new Map(db.prepare('SELECT year, match_count, volume_count FROM totals').all().map((t) => [t.year, t]));
  const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta WHERE key IN ('attribution', 'license')").all().map((r) => [r.key, r.value]));
  const decades = [];
  for (let d = YEAR0; d < YEAR0 + YEARS; d += 10) {
    if ((from !== null && d + 9 < from) || (to !== null && d > to)) continue;
    let n = 0, denom = 0, books = 0, wordBooks = 0;
    for (let y = d; y < d + 10 && y < YEAR0 + YEARS; y++) {
      const t = totals.get(y);
      if (!t) continue;
      n += counts[y - YEAR0];
      denom += t.match_count;
      books += t.volume_count;
      wordBooks += volumes[y - YEAR0];
    }
    if (!denom) continue;
    decades.push({ decade: d, per_million: Number(((n / denom) * 1e6).toPrecision(4)), matches: n, tokens: denom, volumes: books,
      word_volumes_at_least: wordBooks, ...(books < THIN_VOLUMES ? { thin: true } : {}) });
  }
  const caveats = ['case folding merges senses'];
  if (row.top_form !== row.word && row.top_form.charAt(0) !== row.top_form.charAt(0).toLowerCase()) {
    caveats.push('proper-noun or sentence-initial uses may dominate this curve');
  }
  if (row.word.includes('-')) caveats.push("split by Google's tokenizer: this row holds only the few unsplit occurrences of a hyphenated word");
  if (decades.some((x) => x.thin)) caveats.push(`decades with fewer than ${THIN_VOLUMES} books are thin`);
  if (decades.some((x) => x.decade < 1800)) {
    caveats.push('before about 1800 OCR noise is worst' + (row.word.includes('s') ? ", and the long s (ſ) was often read as f: words with 's' are undercounted" : ''));
  }
  caveats.push(`first_year ${row.first_year} is the first year with a match in this store, not a coinage or attestation date`);
  return {
    available: true, word: row.word, top_form: row.top_form, forms: row.forms, label: LABEL,
    attribution: meta.attribution ?? 'Google Books Ngram Viewer (http://books.google.com/ngrams), dataset version 20200217',
    license: meta.license ?? license, decades, caveats,
  };
}

/** @returns {{series: typeof series}} the BaselineLookup of §10.1 */
export function baseline() {
  return { series };
}
