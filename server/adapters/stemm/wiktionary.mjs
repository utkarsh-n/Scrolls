// OWNER: WP2
// wiktionary.mjs — source adapter 'stemm.wiktionary': the staged Wiktionary STEMM/coinage extract
// (sources/wiktionary-coinage/terms.jsonl + stats.json, CC BY-SA) → attestation CLAIMS (SPEC §10.2, §1.7).
//
//  · A word index (derived/wiktionary/word-index.json: "<lang>:<folded word>" → byte ranges in terms.jsonl) is
//    built once by one scan of the file; lookups then read only the matching lines.
//  · claims(ctx).lookup(word, {lang, surface}) → the date statements of the word's entries, one per statement (a
//    noun and a verb sharing an etymology state it once), each labelled "Wiktionary: <relation> <date> (external
//    claim)" with a display rule: 'default' only for a statement about the headword (subject_hint 'headword') that
//    does not date one sense, on an entry spelled like the query that is not a proper noun and whose sentence names
//    no other language first; 'dimmed' otherwise, with its reasons; never for 'other-language-context'. A year
//    given only by a coinage template is dimmed, and dropped when the prose shows it dates another language's word.
//    A claim is never an occurrence and never moves a bar.
//  · Loading for a tracked expression (tasks/adapter-load.mjs) writes one stemm-wiktionary document per distinct
//    etymology text (etymology · lexical · entries, rate_eligible 0; its only passage is the `entry` field, a later
//    description, excluded from frequency) and each shown claim as a date_assertion on the expression (role
//    first_attestation_claim, basis stated, asserted_by 'wiktionary', never chronology) whose note is the claim's
//    JSON (claimNote / claimFromAssertion).

import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fromInterval } from '../../../src/shared/dates.mjs';
import { paths } from '../../config.mjs';
import { tokenize } from '../../../src/shared/tokenize.mjs';

export const id = 'stemm.wiktionary';
export const version = '1.1.0';
export const label = 'Wiktionary attestation claims';
export const access = 'local-dataset';
export const license = 'CC BY-SA 4.0 / GFDL';
export const attribution = 'Wiktionary contributors; extracted with Wiktextract (Ylonen 2022) via kaikki.org';
export const stagedDir = 'wiktionary-coinage';
export const command = 'node tools/fetch/wiktionary-coinage.mjs';
export const COLLECTION = 'stemm-wiktionary';
export const collections = [
  {
    slug: COLLECTION,
    name: 'Wiktionary entries (attestation claims)',
    domain: 'etymology',
    modality: 'lexical',
    unit: 'entries',
    sampling: 'curated',
    rate_eligible: false,
    export_text_allowed: true,
    coverage_gate: null,
    selection_note: 'entries of tracked expressions only; Wiktionary STEMM categories, coinage templates and dated etymologies',
    license: 'CC BY-SA 4.0 / GFDL',
    caveats: ['Dates in Wiktionary etymologies are external claims, never occurrences; they do not move a bar.',
      'Entry text is a later description of the word (written 2002 or later), excluded from frequency.'],
  },
];
const FILE = 'terms.jsonl';
const INDEX_VERSION = 1;
const EXCERPT_CHARS = 800;
/** Wiktionary went online in December 2002: no entry text is older. */
const WIKTIONARY_START = 2002;
const ENGLISH_FAMILY = /english|scots/i;
const SENSE_RE = /\bin (?:the|this|its|a) [\w\s-]{0,30}?(?:context|sense)\b|\b(?:sense|meaning)\b/i;
const RELATION_WORDS = Object.freeze({ coined: 'coined', 'first-attested': 'first attested', 'first-recorded': 'first recorded',
  'first-used': 'first used', since: 'attested since' });
const RULE_WORDS = Object.freeze({ 'dates-from': 'dates from', 'first-appeared': 'first appeared', 'first-documented': 'first documented',
  introduced: 'introduced', 'attested-in': 'attested in', 'recorded-in': 'recorded in', 'leading-date': 'dated' });
export const CLAIM_NOTE_VERSION = 1;

const dir = () => path.join(paths().sources, stagedDir);
const indexPath = () => path.join(paths().wiktionary, 'word-index.json');
/** A small sidecar naming the terms.jsonl the index was built from, so readiness is checked without parsing the index. */
const indexSourcePath = () => path.join(paths().wiktionary, 'word-index.source.json');
/** The index key of a word: its folded tokens (a multi-word headword keeps its spaces). */
export const wordKey = (lang, word) => `${lang}:${tokenize(String(word)).tokens.join(' ')}`;

/** Read MANIFEST.json and FORMAT.md first (§10.1). */
export async function probe() {
  const d = dir();
  if (!existsSync(path.join(d, 'MANIFEST.json'))) return unavailable(`MANIFEST.json not found under sources/${stagedDir}`);
  if (!existsSync(path.join(d, 'FORMAT.md'))) return unavailable(`FORMAT.md not found under sources/${stagedDir}`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(path.join(d, 'MANIFEST.json'), 'utf8')); } catch (err) { return unavailable(`MANIFEST.json is not valid JSON: ${err.message}`); }
  const format = readFileSync(path.join(d, 'FORMAT.md'), 'utf8');
  const missing = ['`etymology_text`', '`attestation`', '`subject_hint`', '`sense_specific`', '`span_start`', '`alternatives`', '`context_language`', '`coinage`']
    .filter((k) => !format.includes(k));
  if (missing.length) return unavailable(`FORMAT.md does not describe ${missing.join(', ')}`, { manifest_ok: true });
  if (!existsSync(path.join(d, FILE))) return unavailable(`${FILE} not found`, { manifest_ok: true, format_ok: true });
  let stats = {};
  try { stats = JSON.parse(readFileSync(path.join(d, 'stats.json'), 'utf8')); } catch { /* optional */ }
  const kept = stats?.selection?.kept ?? manifest?.counts?.terms_kept ?? null;
  return { available: true, manifest_ok: true, format_ok: true,
    counts: { entries: Number(kept ?? 0), with_attestation: Number(manifest?.counts?.entries_with_stated_attestation ?? 0),
      index_built: existsSync(indexPath()) ? 1 : 0 },
    caveats: ['Claims are statements in Wiktionary etymologies (external claims), never occurrences.',
      ...(Array.isArray(manifest.caveats) ? manifest.caveats.map(String).slice(0, 6) : [])] };
}
function unavailable(reason, extra = {}) {
  return { available: false, reason, manifest_ok: false, format_ok: false, counts: {}, caveats: [], ...extra };
}

/** The dump date (Last-Modified of the kaikki file) from MANIFEST.json, or null. @returns {Date|null} */
export function dumpDate() {
  try {
    const m = JSON.parse(readFileSync(path.join(dir(), 'MANIFEST.json'), 'utf8'));
    const d = new Date(m.dump?.http_last_modified ?? m.fetched_at ?? '');
    return Number.isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

// ── the word index ──────────────────────────────────────────────────────────────────────────────────

let index = null;

/** Whether the word index is built for the staged file (without building it). @returns {boolean} */
export function indexReady() {
  const file = path.join(dir(), FILE);
  if (!existsSync(file) || !existsSync(indexPath())) return false;
  const st = statSync(file);
  if (index && index.source.size === st.size && index.source.mtime === st.mtimeMs) return true;
  try {
    const saved = JSON.parse(readFileSync(existsSync(indexSourcePath()) ? indexSourcePath() : indexPath(), 'utf8'));
    const source = saved.source ?? saved;
    return source.size === st.size && source.mtime === st.mtimeMs && source.version === INDEX_VERSION;
  } catch { return false; }
}

/**
 * The word index, built by one scan of terms.jsonl when absent or stale (keyed by the file's size and mtime).
 * @returns {Promise<{source: object, words: Record<string, Array<[number, number]>>}>}
 */
export async function wordIndex() {
  const file = path.join(dir(), FILE);
  const st = statSync(file);
  const source = { size: st.size, mtime: st.mtimeMs, version: INDEX_VERSION };
  if (index && index.source.size === source.size && index.source.mtime === source.mtime) return index;
  if (existsSync(indexPath())) {
    try {
      const saved = JSON.parse(readFileSync(indexPath(), 'utf8'));
      if (saved.source?.size === source.size && saved.source?.mtime === source.mtime && saved.source?.version === INDEX_VERSION) {
        index = saved;
        return index;
      }
    } catch { /* rebuild */ }
  }
  const words = {};
  await new Promise((resolve, reject) => {
    let offset = 0, rest = Buffer.alloc(0);
    const s = createReadStream(file, { highWaterMark: 1 << 22 });
    s.on('data', (chunk) => {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      let start = 0;
      for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, start)) {
        if (nl > start) {
          try {
            const r = JSON.parse(buf.toString('utf8', start, nl));
            (words[wordKey(r.lang, r.word)] ??= []).push([offset + start, nl - start]);
          } catch { /* a malformed line is skipped */ }
        }
        start = nl + 1;
      }
      offset += start;
      rest = buf.subarray(start);
    });
    s.on('end', resolve);
    s.on('error', reject);
  });
  index = { source, words };
  mkdirSync(path.dirname(indexPath()), { recursive: true });
  // unique temp names: two read workers may build the index at once; each rename is atomic
  const tmp = `${indexPath()}.${process.pid}.${Math.random().toString(36).slice(2)}.part`;
  writeFileSync(tmp, JSON.stringify(index));
  renameSync(tmp, indexPath());
  const tmpSource = `${indexSourcePath()}.${process.pid}.${Math.random().toString(36).slice(2)}.part`;
  writeFileSync(tmpSource, JSON.stringify({ source }));
  renameSync(tmpSource, indexSourcePath());
  return index;
}

/** The entries of a word (all parts of speech and etymologies), in file order. */
export async function entriesOf(word, { lang = 'en' } = {}) {
  const idx = await wordIndex();
  const ranges = idx.words[wordKey(lang, word)] ?? [];
  if (!ranges.length) return [];
  const fd = openSync(path.join(dir(), FILE), 'r');
  try {
    return ranges.map(([at, len]) => {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, at);
      return JSON.parse(buf.toString('utf8'));
    });
  } finally {
    closeSync(fd);
  }
}

// ── claims ──────────────────────────────────────────────────────────────────────────────────────────

const astro = (y) => (Number.isInteger(y) && y < 0 ? y + 1 : y);
const sameForm = (a, b) => String(a).normalize('NFC') === String(b).normalize('NFC');

/** Display rule of a date statement (§10.2): 'default' | 'dimmed' | 'never', with the reasons for dimming. */
export function displayOf(a, { entry = null, surface = null } = {}) {
  if (a.subject_hint === 'other-language-context') return { display: 'never', reasons: ['dates a word in another language'] };
  const reasons = [];
  if (a.subject_hint !== 'headword') reasons.push('subject unclear');
  if (a.sense_specific || SENSE_RE.test(a.span ?? '')) reasons.push('dates one sense or use, not the word');
  if (a.rule === 'leading-date') reasons.push('a bare date: the relation is not stated');
  if (a.subject_hint === 'headword' && a.context_language && a.context_language.length > 3 && !ENGLISH_FAMILY.test(a.context_language)) {
    reasons.push(`the sentence names ${a.context_language} first: it may date an earlier form`);
  }
  if (entry?.pos === 'name') reasons.push('a proper-noun entry');
  if (entry && surface && !sameForm(entry.word, surface) && sameForm(entry.word.toLowerCase(), String(surface).toLowerCase())) {
    reasons.push(`headword spelled '${entry.word}'`);
  }
  return { display: reasons.length ? 'dimmed' : 'default', reasons };
}

/** "the 1920" → "1920" (a work's year read as a date); everything else verbatim. */
const dateWords = (t) => String(t ?? '').replace(/^the (\d{3,4})$/i, '$1');

/** The relation in words, for the label. */
const relationWords = (relation, rule) => RELATION_WORDS[relation] ?? RULE_WORDS[rule] ?? 'dated';

/**
 * The claims of one entry: each accepted date statement (other-language ones dropped) and a coinage template's
 * year when the prose does not already state it.
 * @param {object} entry a terms.jsonl record
 * @param {{surface?: string|null}} [opts] the query as typed, to compare the headword's form
 * @returns {object[]}
 */
export function claimsOfEntry(entry, { surface = null } = {}) {
  const ety = entry.etymology_text ?? '';
  const out = [];
  const list = entry.attestations?.length ? entry.attestations : entry.attestation ? [entry.attestation] : [];
  for (const a of list) {
    const { display, reasons } = displayOf(a, { entry, surface });
    if (display === 'never') continue;
    const alternatives = a.alternatives?.map((x) => ({ year_lo: astro(x.year_lo ?? x.year), year_hi: astro(x.year_hi ?? x.year), precision: x.precision })) ?? null;
    out.push({
      key: `${a.span_start}-${a.span_end}:${a.span}`, kind: 'statement', entry_id: entry.id, word: entry.word, lang: entry.lang, pos: entry.pos,
      relation: a.relation, rule: a.rule, precision: a.precision, qualifier: a.qualifier ?? null, period_part: a.period_part ?? null,
      era: a.era ?? null, ambiguous: a.ambiguous === true,
      year: astro(a.year), year_lo: astro(a.year_lo), year_hi: astro(a.year_hi), alternatives,
      date_text: a.date_text, span: a.span, span_start: a.span_start, span_end: a.span_end,
      span_in_excerpt: Number.isInteger(a.span_end) && a.span_end <= ety.length && ety.slice(a.span_start, a.span_end) === a.span,
      subject_hint: a.subject_hint, sense_specific: a.sense_specific === true, context_language: a.context_language ?? null,
      via_template: a.via_template ?? null, display, reasons,
      label: `Wiktionary: ${relationWords(a.relation, a.rule)} ${dateWords(a.date_text)}${alternatives ? ' (one of these)' : ''} (external claim)`,
      url: entry.url, license, attribution,
    });
  }
  const otherLanguageYears = new Set(list.filter((a) => a.subject_hint === 'other-language-context').map((a) => `${a.year_lo}|${a.year_hi}`));
  for (const c of [entry.coinage, ...(entry.coinage_other ?? [])]) {
    if (!c || c.year_basis !== 'stated') continue;
    const span = `${c.year_lo}|${c.year_hi}`;
    // the template's year dates the source-language word ("German Genom, coined … in 1920"): never the headword's
    if (otherLanguageYears.has(span)) continue;
    if (out.some((x) => x.year_lo === astro(c.year_lo) && x.year_hi === astro(c.year_hi))) continue; // the prose already states it
    const at = c.expansion ? ety.indexOf(c.expansion) : -1;
    out.push({
      key: `coinage:${c.template ?? c.category ?? c.kind}:${c.year_raw}`, kind: 'coinage-template', entry_id: entry.id, word: entry.word, lang: entry.lang,
      pos: entry.pos, relation: 'coined', rule: `coinage-template:${c.template ?? 'category'}`, precision: c.year_precision ?? 'year',
      qualifier: c.year_qualifier ?? null, period_part: null, era: null, ambiguous: false,
      year: astro(c.year), year_lo: astro(c.year_lo), year_hi: astro(c.year_hi),
      alternatives: c.year_alternatives?.map((x) => ({ year_lo: astro(x.year_lo ?? x.year), year_hi: astro(x.year_hi ?? x.year), precision: x.precision })) ?? null,
      date_text: c.year_raw, span: c.expansion ?? null, span_start: at >= 0 ? at : null, span_end: at >= 0 ? at + c.expansion.length : null,
      span_in_excerpt: at >= 0, subject_hint: 'unclear', sense_specific: false, context_language: null, via_template: c.template ?? null,
      display: 'dimmed', reasons: ['a coinage template\'s year argument: the prose does not state it for the headword'],
      label: `Wiktionary: ${c.kind === 'coined' || c.kind === 'neologism' ? 'coined' : c.kind.replace(/-/g, ' ')} ${dateWords(c.year_raw)}${c.year_alternatives?.length ? ' (one of these)' : ''} (external claim)`,
      url: entry.url, license, attribution,
    });
  }
  return out;
}

/**
 * The claims of a word across its entries, one per statement (entries that share an etymology state it once;
 * `entry_ids` lists them all). Default claims first, then by year.
 * @param {object[]} entries terms.jsonl records of one word
 * @param {{surface?: string|null}} [opts]
 * @returns {object[]}
 */
export function claimsOfEntries(entries, opts = {}) {
  const byKey = new Map();
  for (const e of entries) {
    for (const c of claimsOfEntry(e, opts)) {
      const k = `${c.key}|${c.year_lo}|${c.year_hi}`;
      const seen = byKey.get(k);
      if (seen) {
        seen.entry_ids.push(e.id);
        if (seen.display === 'dimmed' && c.display === 'default') Object.assign(seen, { display: 'default', reasons: [], pos: c.pos, entry_id: c.entry_id });
      } else byKey.set(k, { ...c, entry_ids: [e.id] });
    }
  }
  const rank = (c) => (c.display === 'default' ? 0 : 1);
  return [...byKey.values()].sort((a, b) => rank(a) - rank(b) || (a.year_lo ?? a.year_hi ?? 0) - (b.year_lo ?? b.year_hi ?? 0));
}

/**
 * The ClaimsLookup of §10.1.
 * @returns {{lookup: (word: string, opts?: {lang?: string, surface?: string}) => Promise<object[]>}}
 */
export function claims() {
  return { lookup: async (word, opts = {}) => claimsOfEntries(await entriesOf(word, opts), { surface: opts.surface ?? word }) };
}

/**
 * The date_assertion note of a written claim: the claim as JSON (its label first), so readers get every field
 * back with claimFromAssertion.
 * @param {object} c claim
 * @param {{document?: number|null, passage?: number|null}} [where] the loaded entry document and its `entry` passage
 * @returns {string}
 */
export function claimNote(c, { document = null, passage = null } = {}) {
  return JSON.stringify({ v: CLAIM_NOTE_VERSION, label: c.label, display: c.display, reasons: c.reasons, key: c.key, kind: c.kind,
    relation: c.relation, rule: c.rule, precision: c.precision, qualifier: c.qualifier, date_text: c.date_text, alternatives: c.alternatives,
    word: c.word, lang: c.lang, pos: c.pos, entry_ids: c.entry_ids ?? [c.entry_id], span: c.span, span_start: c.span_start, span_end: c.span_end,
    span_in_excerpt: c.span_in_excerpt, subject_hint: c.subject_hint, sense_specific: c.sense_specific, context_language: c.context_language,
    document, passage, url: c.url, license: c.license, attribution: c.attribution });
}

/**
 * A claim from its date_assertion row (subject expression, role first_attestation_claim, asserted_by wiktionary).
 * @param {{id: number, subject_id: number, lo_year: number, hi_year: number, precision: string, approx: number, raw: string, rule: string, note: string}} row
 * @returns {object} the claim with `assertion`, `expression`, lo/hi years, the entry document/passage ids and the
 *   highlight span (in the passage's `entry` field) when the span lies in the stored excerpt
 */
export function claimFromAssertion(row) {
  let n = null;
  try { n = JSON.parse(row.note); } catch { /* an older free-text note */ }
  const base = { assertion: row.id, expression: row.subject_id, year_lo: row.lo_year, year_hi: row.hi_year, precision: row.precision,
    approx: row.approx === 1, date_text: row.raw, rule: row.rule, source: 'wiktionary', license, attribution };
  if (!n || typeof n !== 'object') return { ...base, label: String(row.note ?? '').split(';')[0], display: 'dimmed', reasons: ['note not structured'] };
  return { ...base, ...n, year_lo: row.lo_year, year_hi: row.hi_year, precision: n.precision ?? row.precision,
    highlight: n.passage && n.span_in_excerpt ? { passage: n.passage, start: n.span_start, end: n.span_end } : null };
}

// ── loading for tracked expressions ─────────────────────────────────────────────────────────────────

/**
 * A load builds the word index (the first time) and then loads the entries of the requested words, if any.
 * @returns {Promise<{units: number}>}
 */
export async function plan(params = {}) {
  await wordIndex();
  return { units: (params.words ?? []).length };
}

/**
 * Entry documents for the requested words (params.words: [{word, lang}] or strings with params.lang): one per
 * distinct etymology text, its other entries as aliases. Entries without an etymology text make no document.
 * @param {{words?: Array<string|{word: string, lang?: string}>, lang?: string, skip?: Iterable<string>}} params
 */
export async function* documents(params = {}) {
  const by = `adapter:${id}@${version}`;
  const skip = params.skip instanceof Set ? params.skip : new Set(params.skip ?? []);
  const dumped = dumpDate();
  const dumpYear = dumped ? dumped.getUTCFullYear() : new Date().getUTCFullYear();
  for (const w of params.words ?? []) {
    const word = typeof w === 'string' ? w : w.word;
    const lang = (typeof w === 'object' && w.lang) || params.lang || 'en';
    const groups = new Map();
    for (const e of await entriesOf(word, { lang })) {
      if (!e.etymology_text) continue;
      const g = groups.get(e.etymology_text);
      if (g) g.push(e); else groups.set(e.etymology_text, [e]);
    }
    for (const [ety, entries] of groups) {
      const first = entries[0];
      const extId = `wikt:${first.id}`;
      if (skip.has(extId)) continue;
      const levels = new Set(entries.map((e) => e.field_evidence_level).filter(Boolean));
      const fields = [...new Set(entries.flatMap((e) => e.fields ?? []))];
      yield {
        ext_id: extId,
        kind: 'entry',
        title: first.word,
        lang_declared: first.lang,
        source_url: first.url,
        license: 'CC BY-SA 4.0 / GFDL',
        fields: { entry: ety },
        dates: [
          { role: 'publication_unspecified', parsed: { lo_day: null, hi_day: null, lo_year: null, hi_year: null, precision: 'unknown',
            basis: 'unknown', approx: 0, rule: 'wiktionary_entry', raw: null, label: 'undated', warnings: [] }, asserted_by: by, is_chronology: true,
          note: 'a Wiktionary entry: text about the word, not dated; its date statements are claims on the expression' },
          { role: 'authored_description', parsed: fromInterval(WIKTIONARY_START, dumpYear, { precision: 'range', basis: 'estimated',
            rule: 'wiktionary_written', raw: `${WIKTIONARY_START}–${dumpYear}` }), asserted_by: by, is_chronology: false,
            note: `written on Wiktionary between its start (${WIKTIONARY_START}) and the dump of ${dumped ? dumped.toISOString().slice(0, 10) : 'this extract'}` },
        ],
        aliases: entries.slice(1).map((e) => ({ ext_id: `wikt:${e.id}`, note: `same etymology (${e.pos ?? 'entry'})` })),
        tags: fields.map((f) => ({ scheme: 'field', value: f, weight: null, provenance: 'adapter_machine',
          method: `Wiktionary topical categories (Wiktextract), ${levels.has('sense') ? 'sense-level' : 'entry-level (weaker: page-wide)'}` })),
        original_meta: { source: 'wiktionary-coinage terms.jsonl', entries: entries.map(({ etymology_text: _t, ...e }) => e),
          etymology_text: { $text: 'document_field.entry', chars: ety.length, truncated: entries.some((e) => e.etymology_text_truncated) } },
      };
    }
  }
}

/** Upper bound of stored excerpt lengths (FORMAT.md: etymology_text is cut to 800 UTF-16 code units). */
export const ENTRY_EXCERPT_CHARS = EXCERPT_CHARS;
