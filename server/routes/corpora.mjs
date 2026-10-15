// OWNER: WP2
// routes/corpora.mjs — GET /api/corpora (corpora and their collections with coverage, selection notes,
// caveats, licences and status) and GET /api/facets?f=&corpus= (facet values with document counts) (SPEC §7.1,
// §7.2). Both run in the read pool; the query functions below follow the `xxxQuery(db, args)` convention.
//
// Collection status: the bootstrap writes meta `collection_status:<slug>` ('pending' before phase B reaches
// the collection, 'indexing' while it loads, 'ready' after); a collection without that key is 'ready' when it
// has documents and 'empty' otherwise.

import { STEMM_LANES, CORPORA, SAMPLING_LABELS, VIRTUAL_CORPORA } from '../../src/shared/vocab.mjs';
import { parseFilter } from '../../src/shared/viewstate.mjs';
import { TOKENIZER_VERSION } from '../../src/shared/tokenize.mjs';
import { COMMUNITIES } from '../../data/demo/generator.mjs';
import { badRequest } from '../http/errors.mjs';
import { SEGMENTER_VERSION } from '../text/segment.mjs';
import { collectionStats } from '../aggregate/collstats.mjs';
import { warmAll } from '../aggregate/warm.mjs';

const MODULE_URL = import.meta.url;
const TEXT_CLASSES = "('text','abstract')";

/** Language labels for facets (code → English name). */
export const LANG_LABELS = Object.freeze({
  en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese', la: 'Latin', hi: 'Hindi',
  gu: 'Gujarati', sa: 'Sanskrit', mr: 'Marathi', und: 'undetermined', 'und-Latn': 'undetermined (Latin script)',
});
export const BASIS_LABELS = Object.freeze({
  stated: 'stated', estimated: 'estimated', derived: 'derived (calendar conversion)', announced: 'announced', period: 'period',
  unknown: 'undated',
});
/** Country-of-origin codes as Cipher records them (Wikidata); `culture` is never called community. */
export const CULTURE_LABELS = Object.freeze({
  us: 'United States', in: 'India', fr: 'France', es: 'Spain', gb: 'United Kingdom', mx: 'Mexico', ar: 'Argentina',
  xx: 'not recorded',
});

const metaValue = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
const dataVersionOf = (db) => Number(metaValue(db, 'data_version') ?? 0);

let corporaCache = { version: -1, body: null };

/**
 * Corpora with their collections (the Corpora shape of §7.2), then the virtual corpus `real` (contract 1.3.0:
 * `virtual: true`, its member corpora, no collections of its own — they are its members').
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function corporaQuery(db) {
  const version = dataVersionOf(db);
  const statusRows = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'collection_status:%'").all();
  const statusKey = statusRows.map((r) => `${r.key}=${r.value}`).join('|');
  if (corporaCache.version === version && corporaCache.statusKey === statusKey) return corporaCache.body;
  const status = new Map(statusRows.map((r) => [r.key.slice('collection_status:'.length), r.value]));
  const corpora = db.prepare('SELECT * FROM corpus ORDER BY id').all();
  const order = CORPORA.map((c) => c.slug);
  corpora.sort((a, b) => (order.indexOf(a.slug) + 1 || 99) - (order.indexOf(b.slug) + 1 || 99));
  const body = corpora.map((k) => ({
    slug: k.slug,
    name: k.name,
    kind: k.kind,
    synthetic: k.is_synthetic === 1,
    collections: db.prepare('SELECT * FROM collection WHERE corpus_id = ? ORDER BY id').all(k.id).map((row) => {
      const c = { ...row };
      // a warming worker may be building them: wait for its file rather than scanning the same rows twice
      const s = collectionStats(db, c, { waitMs: 12000 });
      const lo = s.lo_day !== null && s.lo_day !== undefined ? s.lo_label : null;
      const hi = s.hi_day !== null && s.hi_day !== undefined ? s.hi_label : null;
      let caveats = [];
      try { caveats = JSON.parse(c.caveats_json); } catch { caveats = []; }
      return {
        slug: c.slug,
        name: c.name,
        domain: c.domain,
        modality: c.modality,
        unit: c.unit,
        sampling: c.sampling,
        sampling_label: SAMPLING_LABELS[c.sampling] ?? c.sampling,
        rate_eligible: c.rate_eligible === 1,
        docs: s.docs,
        tokens: s.tokens ?? 0,
        works: c.unit === 'works' ? s.docs : 0,
        undated: s.undated ?? 0,
        scheduled: s.scheduled ?? 0,
        span: lo && hi ? [lo, hi] : null,
        selection_note: c.selection_note ?? null,
        caveats,
        license: c.license ?? null,
        coverage_gate: c.coverage_gate ?? null,
        status: status.get(c.slug) ?? (s.docs ? 'ready' : 'empty'),
        // how the documents are dated (§10.2 coverage line): stated · estimated · derived · period · announced · undated
        dating: { stated: s.b_stated ?? 0, estimated: s.b_estimated ?? 0, derived: s.b_derived ?? 0, period: s.b_period ?? 0,
          announced: s.scheduled ?? 0, undated: s.undated ?? 0, after_1928: s.after_1928 ?? 0 },
        synthetic: c.is_synthetic === 1,
      };
    }),
  }));
  // the virtual corpus: every non-synthetic corpus that holds documents (never the demo)
  const members = body.filter((k) => !k.synthetic && k.slug !== 'demo' && k.collections.some((c) => c.docs > 0)).map((k) => k.slug);
  const v = VIRTUAL_CORPORA.real;
  body.push({ slug: v.slug, name: v.name, kind: v.kind, synthetic: false, virtual: true, members, description: v.description,
    collections: [], available: members.length > 0 });
  corporaCache = { version, statusKey, body };
  return body;
}

// ── facets ──────────────────────────────────────────────────────────────────────────────────────────

const FACET_COLUMNS = Object.freeze({
  community: 'd.community', kind: 'd.kind', lang: 'd.lang_text', basis: 'd.basis', coll: 'c.slug', culture: 'd.culture', field: 'd.field',
});

function labelFor(facet, value, collNames) {
  switch (facet) {
    case 'community': return COMMUNITIES[value] ?? value;
    case 'kind': return value.charAt(0).toUpperCase() + value.slice(1);
    case 'lang': return LANG_LABELS[value] ?? value;
    case 'basis': return BASIS_LABELS[value] ?? value;
    case 'coll': return collNames.get(value) ?? value;
    case 'culture': return CULTURE_LABELS[value] ? `${CULTURE_LABELS[value]} (${value})` : value;
    case 'field': return STEMM_LANES.find((l) => l.key === value)?.label ?? value;
    default: return value;
  }
}

/** WHERE clause and params for the `f` grammar (+ corpus). */
export function filterSql(f, corpus) {
  const where = ['d.deleted_at IS NULL'];
  const params = [];
  if (corpus) { where.push('k.slug = ?'); params.push(corpus); }
  for (const [key, col] of Object.entries(FACET_COLUMNS)) {
    const values = f[key] ?? [];
    const inc = values.filter((v) => !v.startsWith('-'));
    const exc = values.filter((v) => v.startsWith('-')).map((v) => v.slice(1));
    if (inc.length) { where.push(`${col} IN (SELECT value FROM json_each(?))`); params.push(JSON.stringify(inc)); }
    if (exc.length) { where.push(`(${col} IS NULL OR ${col} NOT IN (SELECT value FROM json_each(?)))`); params.push(JSON.stringify(exc)); }
  }
  if (f.syn === 0) where.push('d.is_synthetic = 0');
  return { where: where.join(' AND '), params };
}

/**
 * Facet values with document counts for a filter (the Facets shape of §7.2). Facets with no value are left out.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{f?: string, corpus?: string|null}} args
 * @returns {{facets: object, provenance: object, warnings?: string[]}}
 */
export function facetsQuery(db, { f = '', corpus = null } = {}) {
  const warnings = [];
  const filter = parseFilter(f, warnings);
  const { where, params } = filterSql(filter, corpus);
  const from = 'FROM document d JOIN collection c ON c.id = d.collection_id JOIN corpus k ON k.id = c.corpus_id';
  const collNames = new Map(db.prepare('SELECT slug, name FROM collection').all().map((r) => [r.slug, r.name]));
  const facets = {};
  for (const [facet, col] of Object.entries(FACET_COLUMNS)) {
    const rows = db.prepare(`SELECT ${col} AS value, count(*) AS n ${from} WHERE ${where} AND ${col} IS NOT NULL AND ${col} <> ''
      GROUP BY ${col} ORDER BY n DESC, value`).all(...params);
    if (rows.length) facets[facet] = rows.map((r) => ({ value: String(r.value), label: labelFor(facet, String(r.value), collNames), count: r.n }));
  }
  const scope = db.prepare(`SELECT c.slug, c.license, MAX(d.is_synthetic) AS syn ${from} WHERE ${where} GROUP BY c.slug ORDER BY c.slug`).all(...params);
  const provenance = {
    data_version: dataVersionOf(db), run_ids: {}, tokenizer: TOKENIZER_VERSION, segmenter: SEGMENTER_VERSION,
    synthetic: scope.some((s) => s.syn === 1), collections: scope.map((s) => s.slug),
    licenses: [...new Set(scope.map((s) => s.license).filter(Boolean))],
  };
  return { facets, provenance, ...(warnings.length ? { warnings } : {}) };
}

export const routes = [
  {
    method: 'GET',
    path: '/api/corpora',
    heavy: true,
    async handler(req, ctx) {
      // per-collection statistics are shared artifacts (memory → cache file → one collection scan); the UI's first call
      // also starts warming every corpus's shared artifacts, so its first search and timeline query find them ready
      warmAll(ctx);
      return { json: await ctx.pool.run(MODULE_URL, 'corporaQuery', {}, { timeoutMs: 20000 }) };
    },
  },
  {
    method: 'GET',
    path: '/api/facets',
    heavy: true,
    async handler(req, ctx) {
      const corpus = req.query.corpus || null;
      if (corpus && !/^[a-z][a-z0-9-]{0,31}$/.test(corpus)) throw badRequest('E_VALIDATION', `'${corpus}' is not a corpus slug.`, 'Use demo, cipher, stemm or user.');
      // a cold facet read scans the corpus's documents: 15 s on a loaded machine rather than a 503 (fix pass)
      return { json: await ctx.pool.run(MODULE_URL, 'facetsQuery', { f: String(req.query.f ?? ''), corpus }, { timeoutMs: 15000 }) };
    },
  },
];
