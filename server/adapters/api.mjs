// OWNER: WP0 — the source-adapter interface, frozen in WP0 (SPEC §10.1)
//
// Every source — Cipher, STEMM, demo — is one adapter module; a new source is one file plus its entry in
// server/adapters/registry.mjs; nothing in the core changes. Adapters never write SQL: the `adapter-load`
// task drives their iterators into DocumentWriter.

/**
 * @typedef {Object} CollectionSpec
 * @property {string} slug
 * @property {string} name
 * @property {'literature'|'culture'|'stemm'|'etymology'|'imported'|'demo'} domain
 * @property {'text'|'titles'|'abstracts'|'lexical'|'baseline'} modality
 * @property {'tokens'|'works'|'entries'|'none'} unit
 * @property {'complete'|'prominence_selected'|'top_cited_per_cell'|'relation_endpoints'|'curated'|'user'} sampling
 * @property {boolean} [rate_eligible]
 * @property {boolean} [export_text_allowed]
 * @property {number|null} [coverage_gate]
 * @property {string|null} [selection_note]
 */

/**
 * @typedef {Object} ProbeResult
 * @property {boolean} available
 * @property {string} [reason]           why it is unavailable ("unavailable: <reason>" on the Adapters page)
 * @property {boolean} manifest_ok
 * @property {boolean} format_ok
 * @property {Record<string, number>} counts
 * @property {string[]} caveats          copied into collection.caveats_json
 */

/**
 * @typedef {Object} SourceAdapter
 * @property {string} id                 'stemm.openalex'
 * @property {string} version            semver
 * @property {string} label
 * @property {'local-file'|'local-dataset'|'network'} access   network adapters stay disabled until approved
 * @property {string} license
 * @property {string} attribution
 * @property {string|null} stagedDir     name under $SCROLLS_DATA/sources/ (STEMM) or null (Cipher reads CIPHER paths)
 * @property {CollectionSpec[]} collections
 * @property {(ctx: AdapterCtx) => Promise<ProbeResult>} probe       reads FORMAT.md + MANIFEST.json FIRST
 * @property {(params: object, ctx: AdapterCtx) => Promise<{units: number}>} plan
 * @property {(params: object, ctx: AdapterCtx) => AsyncIterable<object>} documents          CanonicalDocument
 * @property {(params: object, ctx: AdapterCtx) => AsyncIterable<object>} [relationships]   CanonicalRelationship
 * @property {(params: object, ctx: AdapterCtx) => AsyncIterable<object>} [annotations]     CanonicalAnnotation
 * @property {(ctx: AdapterCtx) => object} [claims]      wiktionary: lookup(word) → Claim[]
 * @property {(ctx: AdapterCtx) => object} [baseline]    ngram: series(word) → Series|null
 */

/**
 * @typedef {{dataDir: string, stagedDir: string|null, signal: AbortSignal,
 *   progress: (done: number, total: number, msg?: string) => void,
 *   warn: (code: string, msg: string, detail?: object) => void,
 *   log: (level: string, msg: string, data?: object) => void}} AdapterCtx
 */

const ACCESS = ['local-file', 'local-dataset', 'network'];
const DOMAINS = ['literature', 'culture', 'stemm', 'etymology', 'imported', 'demo'];
const MODALITIES = ['text', 'titles', 'abstracts', 'lexical', 'baseline'];
const UNITS = ['tokens', 'works', 'entries', 'none'];
const SAMPLINGS = ['complete', 'prominence_selected', 'top_cited_per_cell', 'relation_endpoints', 'curated', 'user'];
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function checkCollection(c, i) {
  const e = [];
  const where = `collections[${i}]`;
  if (!c || typeof c !== 'object') return [`${where} is not an object`];
  if (typeof c.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.slug)) e.push(`${where}.slug must be a lowercase slug`);
  if (typeof c.name !== 'string' || !c.name) e.push(`${where}.name is required`);
  if (!DOMAINS.includes(c.domain)) e.push(`${where}.domain must be one of ${DOMAINS.join(', ')}`);
  if (!MODALITIES.includes(c.modality)) e.push(`${where}.modality must be one of ${MODALITIES.join(', ')}`);
  if (!UNITS.includes(c.unit)) e.push(`${where}.unit must be one of ${UNITS.join(', ')}`);
  if (!SAMPLINGS.includes(c.sampling)) e.push(`${where}.sampling must be one of ${SAMPLINGS.join(', ')}`);
  if (c.coverage_gate !== undefined && c.coverage_gate !== null && !(Number.isInteger(c.coverage_gate) && c.coverage_gate > 0)) {
    e.push(`${where}.coverage_gate must be a positive integer or null`);
  }
  return e;
}

/**
 * Check a module (or its default export) against SourceAdapter.
 * @param {object} mod
 * @returns {string[]} [] when the module satisfies the interface
 */
export function validateAdapter(mod) {
  const a = mod && typeof mod === 'object' && mod.default && typeof mod.default === 'object' ? mod.default : mod;
  if (!a || typeof a !== 'object') return ['adapter module exports nothing'];
  const e = [];
  if (typeof a.id !== 'string' || !/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/.test(a.id)) e.push('id must be a dotted lowercase id');
  if (typeof a.version !== 'string' || !SEMVER.test(a.version)) e.push('version must be semver');
  for (const k of ['label', 'license', 'attribution']) if (typeof a[k] !== 'string') e.push(`${k} must be a string`);
  if (!ACCESS.includes(a.access)) e.push(`access must be one of ${ACCESS.join(', ')}`);
  if (!(a.stagedDir === null || typeof a.stagedDir === 'string')) e.push('stagedDir must be a string or null');
  if (!Array.isArray(a.collections)) e.push('collections must be an array');
  else a.collections.forEach((c, i) => e.push(...checkCollection(c, i)));
  for (const k of ['probe', 'plan', 'documents']) if (typeof a[k] !== 'function') e.push(`${k} must be a function`);
  for (const k of ['relationships', 'annotations', 'claims', 'baseline']) {
    if (a[k] !== undefined && typeof a[k] !== 'function') e.push(`${k} must be a function when present`);
  }
  return e;
}

/**
 * The adapter object of a module (default export or the namespace itself).
 * @param {object} mod
 * @returns {SourceAdapter}
 */
export function adapterOf(mod) {
  return mod && mod.default && typeof mod.default === 'object' ? mod.default : mod;
}

/**
 * Build an AdapterCtx with safe defaults.
 * @param {Partial<AdapterCtx>} parts
 * @returns {AdapterCtx}
 */
export function makeAdapterCtx({ dataDir, stagedDir = null, signal = new AbortController().signal,
  progress = () => {}, warn = () => {}, log = () => {} }) {
  return Object.freeze({ dataDir, stagedDir, signal, progress, warn, log });
}
