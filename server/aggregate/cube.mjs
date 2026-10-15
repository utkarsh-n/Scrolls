// OWNER: WP3
// cube.mjs — the slice cube (M1 gate performance fix): one row per doc_tokens row of a corpus's live documents in
// rate-eligible collections, with every column the slice filters (query.docWhere / rowWhere) and the lane facets
// (lanes.facetSql) read. Every expression-independent aggregate — denominators per tier, lane coverage, lane gates,
// the modality seam — is computed from it in JS under exactly the slice rules of query.mjs, instead of a full SQL
// scan per (tier, facet, filter) in each read worker.
//
// The cube is a shared artifact (cache.sharedArtifact): built once per state of its inputs (corpusInputsKey) from one
// read snapshot, written to $SCROLLS_DATA/cache/ and loaded by the other read workers and after a restart in a few
// milliseconds. A materialization bumps the data version without touching it, so the cube survives it.
// Rows of one document are contiguous (distinct-document counts rely on it).
//
// Version 3 (contract 1.3.0): collections carry their rate eligibility and modality. A second, separate cube holds a
// corpus's relation-endpoint collections (not rate-eligible): only the Term trail reads them (works mode, never a
// rate), so no other query pays for their 179k rows. The OpenAlex sample cell of each sampled work (`field|lo-hi`, C3)
// is a third artifact, read only by trail share lanes. A query over several corpora (the virtual corpus `real`) reads
// one cube per corpus and adds them up (slice* helpers).
//
// Version 4: soft-deleted documents (a reverted import, D17) stay in the cube with their deletion time (`del`, seconds;
// 0 = live). Every live read skips them; a saved view opened "as saved" (def.cutoffs.at) counts a document deleted after
// its save, so the shared link reproduces what it showed.
//
// Version 5 (RF-1, ref-freeze-1): each row carries its document's text language (`dlang`). An unidentified row of a
// document's running text counts in a strand's languages only in its document's language (langgate.mjs), exactly as the
// SQL slice (query.rowWhere) and Compare read it.

import { fitsDays, LEVELS } from '../../src/shared/dates.mjs';
import { shortHash } from '../../src/shared/ids.mjs';
import { createMemo, peekArtifact, sharedArtifact } from './cache.mjs';
import { DOC_TEXT_CLASSES, isUnidentified } from './langgate.mjs';
import { laneKey, trailUnitClass, trailValueOfRow } from './lanes.mjs';
import { binOfDay } from './washes.mjs';

/** Version of the cube layout (part of its cache file's validity). */
export const CUBE_VERSION = 5;
const MAGIC = 0x53434231;   // 'SCB1'
const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
const FIELD_CLASSES = ['text', 'title', 'abstract', 'describes', 'apparatus'];
const UNIT_OF_FC = [0, 1, 2, 0, 0];               // text · titles · abstracts
const UNIT_CLASSES = ['text', 'titles', 'abstracts'];
const CHRONO = ['dated', 'undated', 'scheduled'];
const DICTS = ['plang', 'kind', 'culture', 'field', 'community', 'basis', 'dlang'];
const F_TR = 1, F_DUP = 2, F_SYN = 4;
const NO_YEAR = -2147483648;

/** Typed-array columns of the cube: name → constructor. */
const COLUMNS = {
  doc: Int32Array, tokens: Float64Array, batch: Int32Array, ylo: Int32Array, yhi: Int32Array, lod: Int32Array, hid: Int32Array,
  coll: Uint32Array, plang: Uint32Array, kind: Uint32Array, culture: Uint32Array, field: Uint32Array, community: Uint32Array,
  basis: Uint32Array, fc: Uint8Array, cs: Uint8Array, flags: Uint8Array, del: Float64Array, dlang: Uint32Array,
};

const BUILD_SQL = `SELECT t.document_id, t.plang, t.field_class, t.tokens, d.collection_id, d.kind, d.culture, d.field, d.community,
    d.basis, d.is_translation, d.dup_of IS NOT NULL, d.is_synthetic, d.import_batch_id, d.chrono_status, d.y_lo, d.y_hi, d.lo_day, d.hi_day,
    d.deleted_at, d.lang_text
  FROM collection c JOIN document d ON d.collection_id = c.id JOIN doc_tokens t ON t.document_id = d.id
  WHERE c.corpus_id = ? AND c.rate_eligible = ? AND (c.rate_eligible = 1 OR c.sampling = 'relation_endpoints')`;

/** Seconds since 1970 of an ISO timestamp (a deletion or a view's save time); 0 for none. */
export const epochSeconds = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t / 1000 : 0;
};

function dictionary() {
  const values = [null];
  const index = new Map([[null, 0]]);
  return {
    values,
    code(v) {
      const key = v === undefined ? null : v;
      let c = index.get(key);
      if (c === undefined) { c = values.length; values.push(key); index.set(key, c); }
      return c;
    },
  };
}

/**
 * Scan the corpus once (inside the caller's read snapshot) into columns.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} corpusId
 * @returns {object} cube
 */
export function buildCube(db, corpusId, { endpoints = false } = {}) {
  const colls = db.prepare(`SELECT id, slug, domain, modality, unit, coverage_gate, sampling, rate_eligible FROM collection
    WHERE corpus_id = ? AND rate_eligible = ? ORDER BY id`).all(corpusId, endpoints ? 0 : 1).map((c) => ({ ...c }));
  const collIndex = new Map(colls.map((c, i) => [c.id, i]));
  const dicts = Object.fromEntries(DICTS.map((k) => [k, dictionary()]));
  const st = db.prepare(BUILD_SQL);
  st.setReturnArrays(true);
  const rows = st.all(corpusId, endpoints ? 0 : 1);
  const n = rows.length;
  const cols = Object.fromEntries(Object.entries(COLUMNS).map(([k, C]) => [k, new C(n)]));
  for (let r = 0; r < n; r++) {
    const [doc, plang, fc, tokens, coll, kind, culture, field, community, basis, tr, dup, syn, batch, cs, ylo, yhi, lod, hid, deleted, dlang] = rows[r];
    cols.doc[r] = doc;
    cols.tokens[r] = tokens;
    cols.batch[r] = batch ?? 0;
    cols.ylo[r] = ylo ?? NO_YEAR;
    cols.yhi[r] = yhi ?? NO_YEAR;
    cols.lod[r] = lod ?? NO_YEAR;
    cols.hid[r] = hid ?? NO_YEAR;
    cols.coll[r] = collIndex.get(coll);
    cols.plang[r] = dicts.plang.code(plang);
    cols.kind[r] = dicts.kind.code(kind);
    cols.culture[r] = dicts.culture.code(culture);
    cols.field[r] = dicts.field.code(field);
    cols.community[r] = dicts.community.code(community);
    cols.basis[r] = dicts.basis.code(basis);
    cols.fc[r] = FIELD_CLASSES.indexOf(fc);
    cols.cs[r] = CHRONO.indexOf(cs);
    cols.flags[r] = (tr ? F_TR : 0) | (dup ? F_DUP : 0) | (syn ? F_SYN : 0);
    cols.del[r] = epochSeconds(deleted);
    cols.dlang[r] = dicts.dlang.code(dlang);
  }
  const cube = { version: CUBE_VERSION, corpusId, endpoints, n, colls, dicts: Object.fromEntries(DICTS.map((k) => [k, dicts[k].values])), cols };
  return contiguous(cube);
}

/** Make the rows of each document contiguous (stable sort by document) unless they already are. */
function contiguous(cube) {
  const { doc } = cube.cols;
  const seen = new Set();
  let ok = true;
  for (let r = 0; r < cube.n && ok; r++) {
    if (r > 0 && doc[r] === doc[r - 1]) continue;
    if (seen.has(doc[r])) ok = false; else seen.add(doc[r]);
  }
  if (ok) return cube;
  const order = Array.from({ length: cube.n }, (_, i) => i).sort((a, b) => doc[a] - doc[b] || a - b);
  for (const [k, arr] of Object.entries(cube.cols)) {
    const out = new arr.constructor(cube.n);
    for (let i = 0; i < cube.n; i++) out[i] = arr[order[i]];
    cube.cols[k] = out;
  }
  return cube;
}

/**
 * Binary form of a cube: magic, header length, JSON header (dictionaries, collections, column layout), columns.
 * @param {object} cube
 * @returns {Uint8Array}
 */
export function encodeCube(cube) {
  const layout = [];
  let offset = 0;
  for (const [name, arr] of Object.entries(cube.cols)) {
    offset = Math.ceil(offset / 8) * 8;
    layout.push({ name, offset, length: arr.length });
    offset += arr.byteLength;
  }
  const header = Buffer.from(JSON.stringify({ version: cube.version, corpusId: cube.corpusId, endpoints: Boolean(cube.endpoints), n: cube.n,
    colls: cube.colls, dicts: cube.dicts, layout }));
  const start = Math.ceil((8 + header.length) / 8) * 8;
  const out = new Uint8Array(start + offset);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, header.length, true);
  out.set(header, 8);
  for (const { name, offset: o } of layout) {
    const arr = cube.cols[name];
    out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), start + o);
  }
  return out;
}

/**
 * @param {Uint8Array} bytes encodeCube output
 * @returns {object} cube
 * @throws {Error} on a foreign or truncated file
 */
export function decodeCube(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8 || view.getUint32(0, true) !== MAGIC) throw new Error('not a slice cube');
  const len = view.getUint32(4, true);
  const header = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset + 8, len).toString('utf8'));
  if (header.version !== CUBE_VERSION) throw new Error('slice cube of another version');
  const start = Math.ceil((8 + len) / 8) * 8;
  // copy into one aligned buffer: typed arrays need offsets aligned to their element size
  const body = new Uint8Array(bytes.byteLength - start);
  body.set(bytes.subarray(start));
  const cols = {};
  for (const { name, offset, length } of header.layout) {
    const C = COLUMNS[name];
    if (!C || offset + length * C.BYTES_PER_ELEMENT > body.byteLength) throw new Error('truncated slice cube');
    cols[name] = new C(body.buffer, offset, length);
  }
  return { version: header.version, corpusId: header.corpusId, endpoints: Boolean(header.endpoints), n: header.n, colls: header.colls,
    dicts: header.dicts, cols };
}

/** The collections each kind of corpus artifact reads (corpusInputsKey scopes). */
const SCOPE_COLLECTIONS = Object.freeze({
  all: '1', rate: 'rate_eligible = 1', endpoints: "rate_eligible = 0 AND sampling = 'relation_endpoints'",
  cells: "sampling = 'top_cited_per_cell'",
  // label indexes: every collection but lexical entries (Wiktionary entry documents carry no author, theme or maker tag,
  // and one is written each time a real word is tracked after a Wiktionary load)
  labels: "modality <> 'lexical'",
});

/**
 * Fingerprint of what a corpus artifact reads: the scope's collections and their attributes, their import batches by
 * status and the passage quality version (bumped by the boilerplate pass when it rewrites doc_tokens). Documents are only
 * ever written, reverted (soft-deleted) or rolled back through an import batch, so the batches' statuses, counts and
 * highest ids say when the documents change; no document table is read (the key is computed per artifact, per data
 * version, in every read worker). A change elsewhere — a materialization, an annotation, a review, a Wiktionary entry
 * document, another corpus's import — keeps the artifact (contract 1.3.0: the key was database-wide, so any new document
 * anywhere rebuilt every cube).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} corpusId
 * @param {{scope?: 'all'|'rate'|'endpoints'|'cells'|'labels'}} [opts] `rate`: the cube and the maker-name index; `endpoints`:
 *   the relation-endpoint cube; `cells`: the OpenAlex cell index; `labels`: the theme and maker label indexes (every
 *   collection but lexical entries); `all` (default): every collection
 * @returns {string} 16 hex characters
 */
export function corpusInputsKey(db, corpusId, { scope = 'all' } = {}) {
  const cond = SCOPE_COLLECTIONS[scope] ?? SCOPE_COLLECTIONS.all;
  const colls = db.prepare(`SELECT id, slug, domain, modality, unit, coverage_gate, sampling, rate_eligible FROM collection
    WHERE corpus_id = ? AND ${cond} ORDER BY id`).all(corpusId);
  const ids = JSON.stringify(colls.map((c) => c.id));
  const batches = db.prepare(`SELECT status, count(*) AS n, max(id) AS m FROM import_batch WHERE collection_id IN (SELECT value FROM json_each(?))
    GROUP BY status ORDER BY status`).all(ids);
  const quality = db.prepare("SELECT value FROM meta WHERE key = 'quality_version'").get()?.value ?? '0';
  return shortHash(JSON.stringify([scope, colls, batches, quality]), 16);
}

/** The sharedArtifact spec of a corpus's cube (or its relation-endpoint cube). */
export const cubeSpec = (corpusId, endpoints = false) => ({ name: `${endpoints ? 'ecube' : 'cube'}${CUBE_VERSION}-c${corpusId}`,
  key: (d) => corpusInputsKey(d, corpusId, { scope: endpoints ? 'endpoints' : 'rate' }), build: (d) => buildCube(d, corpusId, { endpoints }),
  encode: encodeCube, decode: decodeCube });

/** Below this many doc_tokens rows a cube builds in milliseconds, so a request may build it rather than do without. */
export const SMALL_CUBE_ROWS = 50000;

/**
 * The slice cube when it is ready (memory or cache file), or when the database is small enough to build it at once;
 * else null — for request paths that can answer without it (an empty-state size, a concordance denominator) instead
 * of waiting for a long build (warm.mjs builds it off the request path).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} corpusId
 * @returns {object|null}
 */
export function readyCube(db, corpusId) {
  const ready = peekArtifact(db, cubeSpec(corpusId));
  if (ready) return ready;
  return db.prepare('SELECT count(*) AS n FROM doc_tokens').get().n <= SMALL_CUBE_ROWS ? sliceCube(db, corpusId) : null;
}

/**
 * The slice cube of a corpus (memory → cache file → one scan), rebuilt only when its inputs change.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} corpusId
 * @returns {object}
 */
export function sliceCube(db, corpusId) {
  return sharedArtifact(db, cubeSpec(corpusId));
}

/**
 * The relation-endpoint cube of a corpus (its collections that are not rate-eligible and hold relation endpoints): read
 * only by the Term trail's music-relations lane.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} corpusId
 * @returns {object}
 */
export function endpointCube(db, corpusId) {
  return sharedArtifact(db, cubeSpec(corpusId, true));
}

// ── the slice, in JS (query.docWhere + rowWhere) ──────────────────────────────────────────────────────

/** Allowed codes of a dictionary under an include/exclude list (`col IN (…)` never matches NULL; `NOT IN` keeps it). */
function allowList(values, list) {
  const inc = list.filter((v) => !v.startsWith('-')), exc = list.filter((v) => v.startsWith('-')).map((v) => v.slice(1));
  const ok = new Uint8Array(values.length);
  for (let c = 0; c < values.length; c++) {
    const v = values[c];
    ok[c] = v === null ? (inc.length ? 0 : 1) : (!inc.length || inc.includes(v)) && !exc.includes(v) ? 1 : 0;
  }
  return ok;
}

/**
 * The languages of a language spec (query.strandLangSpec) for one corpus: an array, null (any) or `{byCorpus}`.
 * @param {string[]|null|{byCorpus: Record<number, string[]|null>}} spec
 * @param {number} corpusId
 * @returns {string[]|null}
 */
export function langsForCorpus(spec, corpusId) {
  if (spec && !Array.isArray(spec) && spec.byCorpus) return spec.byCorpus[corpusId] ?? null;
  return spec ?? null;
}

/**
 * RF-1 (langgate.langAdmits over the cube's dictionaries): per plang code whether it is unidentified, per field class
 * whether it is a document's running text, per dlang code whether that document language is admitted.
 * @param {object} cube
 * @param {string[]} langs
 * @returns {{und: Uint8Array, textFc: Uint8Array, docOk: Uint8Array}}
 */
function languageGate(cube, langs) {
  return {
    und: Uint8Array.from(cube.dicts.plang, (v) => (v !== null && isUnidentified(v) ? 1 : 0)),
    textFc: Uint8Array.from(FIELD_CLASSES, (c) => (DOC_TEXT_CLASSES.includes(c) ? 1 : 0)),
    docOk: Uint8Array.from(cube.dicts.dlang, (v) => (isUnidentified(v) || langs.includes(v) ? 1 : 0)),
  };
}

const trailCodes = new WeakMap();
/**
 * The Term trail lane value of each row (lanes.trailValueOfRow over the row's collection, field and field class), or
 * null outside every trail lane; computed once per (collection, field, field class) of a cube.
 * @param {object} cube
 * @returns {(r: number) => string|null}
 */
function trailValueOf(cube) {
  let f = trailCodes.get(cube);
  if (f) return f;
  const { cols, colls, dicts } = cube;
  const nf = dicts.field.length + 1;
  const memo = new Map();
  f = (r) => {
    const code = (cols.coll[r] * nf + cols.field[r]) * 5 + cols.fc[r];
    let v = memo.get(code);
    if (v === undefined) {
      const c = colls[cols.coll[r]];
      v = trailValueOfRow({ sampling: c.sampling, domain: c.domain, field: dicts.field[cols.field[r]], field_class: FIELD_CLASSES[cols.fc[r]] });
      memo.set(code, v);
    }
    return v;
  };
  trailCodes.set(cube, f);
  return f;
}

/**
 * A row predicate equal to query.sliceWhere(def, cols, langs) over the cube's rows.
 * @param {object} cube
 * @param {object} def resolved query def
 * @param {string[]|null|{byCorpus: object}} langs the strand's languages (null = any)
 * @returns {(r: number) => boolean}
 */
export function slicePredicate(cube, def, langs) {
  const { cols, dicts, colls } = cube;
  const f = def.f ?? {};
  const trail = def.lanes?.facet === 'trail';
  const kindOk = allowList(dicts.kind, f.kind ?? []);
  const cultureOk = allowList(dicts.culture, f.culture ?? []);
  const fieldOk = allowList(dicts.field, f.field ?? []);
  const communityOk = allowList(dicts.community, f.community ?? []);
  const basisOk = allowList(dicts.basis, f.basis ?? []);
  if (!def.toggles.est) dicts.basis.forEach((v, c) => { if (v === 'estimated') basisOk[c] = 0; });
  const collOk = allowList(colls.map((c) => c.slug), f.coll ?? []);
  // rate-eligible collections only — the Term trail also reads relation endpoints (works mode, never a rate)
  colls.forEach((c, i) => { if (!c.rate_eligible && !(trail && c.sampling === 'relation_endpoints')) collOk[i] = 0; });
  const langList = f.lang ?? [];
  const plangOk = allowList(dicts.plang, langList);
  const here = langsForCorpus(langs, cube.corpusId);
  if (Array.isArray(here)) dicts.plang.forEach((v, c) => { if (!here.includes(v)) plangOk[c] = 0; });
  // plang is NOT NULL in doc_tokens: code 0 never occurs
  plangOk[0] = 0;
  // RF-1: an unidentified row of a document's running text counts only in its document's text language
  const lg = Array.isArray(here) ? languageGate(cube, here) : null;
  const classes = ['text', 'title', 'abstract', ...(def.toggles.ds ? ['describes'] : []), ...(def.toggles.ap ? ['apparatus'] : [])];
  const fcOk = Uint8Array.from(FIELD_CLASSES, (c) => (classes.includes(c) ? 1 : 0));
  const deny = (def.toggles.tr ? 0 : F_TR) | (def.toggles.dup ? 0 : F_DUP) | (f.syn === 0 ? F_SYN : 0);
  const cut = def.cutoffs?.import_batch ?? 0;
  // as saved (D17): a document soft-deleted after the view's save time still counts
  const savedAt = epochSeconds(def.cutoffs?.at);
  const tv = trail ? trailValueOf(cube) : null;
  const { kind, culture, field, community, basis, coll, plang, fc, flags, batch, del, dlang } = cols;
  return (r) => fcOk[fc[r]] === 1 && plangOk[plang[r]] === 1 && (flags[r] & deny) === 0 && collOk[coll[r]] === 1 &&
    kindOk[kind[r]] === 1 && basisOk[basis[r]] === 1 && cultureOk[culture[r]] === 1 && fieldOk[field[r]] === 1 &&
    communityOk[community[r]] === 1 && (cut === 0 || batch[r] <= cut) && (del[r] === 0 || (savedAt > 0 && del[r] > savedAt)) &&
    (lg === null || lg.docOk[dlang[r]] === 1 || lg.und[plang[r]] === 0 || lg.textFc[fc[r]] === 0) &&
    (tv === null || tv(r) !== null);
}

/**
 * Lane values of rows under a facet (lanes.facetSql): `group(r)` is a small integer per (value, unit class) and
 * `lane(g)` its { lv, uc, key } — or null for a row outside every lane (Term trail). Cluster lanes are per
 * occurrence, so their rows group by unit class only (`~text`, `~titles`, `~abstracts`): every group lane divides by
 * its unit class's slice denominator.
 * @param {object} cube
 * @param {string} facet
 * @returns {{group: (r: number) => number, lane: (g: number) => {lv: string|null, uc: string, key: string}|null}}
 */
export function laneGroups(cube, facet) {
  const { cols, dicts, colls } = cube;
  if (facet === 'trail') {
    const tv = trailValueOf(cube);
    const ids = new Map(), back = [];
    return {
      group(r) {
        const v = tv(r);
        let g = ids.get(v);
        if (g === undefined) { g = back.length; ids.set(v, g); back.push(v === null ? null : { lv: v, uc: trailUnitClass(v), key: `trail:${v}` }); }
        return g;
      },
      lane: (g) => back[g],
    };
  }
  if (facet === 'cluster') {
    const lanesByUc = UNIT_CLASSES.map((uc) => ({ lv: null, uc, key: `~${uc}` }));
    return { group: (r) => UNIT_OF_FC[cols.fc[r]], lane: (g) => lanesByUc[g] };
  }
  let values, codeOf;
  const byColl = (attr) => {
    const vals = [...new Set(colls.map((c) => c[attr] ?? null))];
    const map = colls.map((c) => vals.indexOf(c[attr] ?? null));
    return [vals, (r) => map[cols.coll[r]]];
  };
  switch (facet) {
    case 'domain': [values, codeOf] = byColl('domain'); break;
    case 'collection': [values, codeOf] = byColl('slug'); break;
    case 'community': case 'kind': case 'culture': case 'field': values = dicts[facet]; codeOf = (r) => cols[facet][r]; break;
    case 'date_basis': values = dicts.basis; codeOf = (r) => cols.basis[r]; break;
    case 'modality': values = UNIT_CLASSES; codeOf = (r) => UNIT_OF_FC[cols.fc[r]]; break;
    case 'language': values = dicts.plang; codeOf = (r) => cols.plang[r]; break;
    default: throw new RangeError(`unknown lane facet '${facet}'`);
  }
  const lanes = new Map();
  return {
    group: (r) => codeOf(r) * 3 + UNIT_OF_FC[cols.fc[r]],
    lane(g) {
      let l = lanes.get(g);
      if (!l) {
        const lv = values[Math.floor(g / 3)] ?? null, uc = UNIT_CLASSES[g % 3];
        l = { lv, uc, key: laneKey(facet, lv, uc) };
        lanes.set(g, l);
      }
      return l;
    },
  };
}

const sliceKey = (def, langs) => JSON.stringify([def.corpusId, def.f, def.toggles, def.cutoffs ?? null, langs ?? null]);
const memo = createMemo({ max: 96 });
const cubeIds = new WeakMap();
let nextCubeId = 1;
/** A per-process id of a cube object, so memo entries of an older cube (older inputs) are never reused. */
function idOf(cube) {
  if (!cubeIds.has(cube)) cubeIds.set(cube, nextCubeId++);
  return cubeIds.get(cube);
}

/**
 * Denominators of every bin of a tier: Map `${lane}|${bin}` → {lane, uc, bin, tokens, docs, syn, tr} over documents
 * that fit the bin (L0–L3 by year as doc_bin, L4 month, L5 day), dated only.
 * @param {object} cube
 * @param {object} def
 * @param {string[]|null} langs
 * @param {string} tier
 * @returns {Map<string, object>}
 */
export function cubeDenominators(cube, def, langs, tier) {
  return memo(`den|${idOf(cube)}|${sliceKey(def, langs)}|${def.lanes.facet}|${tier}`, () => {
    const level = TIERS.indexOf(tier);
    const pass = slicePredicate(cube, def, langs);
    const lanes = laneGroups(cube, def.lanes.facet);
    const { doc, tokens, cs, ylo, yhi, lod, hid, flags } = cube.cols;
    const w = level <= 3 ? LEVELS[level].width : 0;
    const out = new Map();
    for (let r = 0; r < cube.n; r++) {
      if (cs[r] !== 0 || !pass(r)) continue;
      let bin;
      if (level <= 3) {
        bin = Math.floor(ylo[r] / w);
        if (bin !== Math.floor(yhi[r] / w)) continue;
      } else {
        if (hid[r] - lod[r] > 30 || !fitsDays(lod[r], hid[r], level)) continue;
        bin = binOfDay(lod[r], ylo[r], tier);
      }
      const l = lanes.lane(lanes.group(r));
      if (!l) continue;
      const k = `${l.key}|${bin}`;
      let a = out.get(k);
      if (!a) { a = { lane: l.key, uc: l.uc, bin, tokens: 0, docs: 0, syn: 0, tr: 0, last: -1 }; out.set(k, a); }
      a.tokens += tokens[r];
      if (a.last !== doc[r]) { a.docs++; a.last = doc[r]; }
      if (flags[r] & F_SYN) a.syn = 1;
      if (flags[r] & F_TR) a.tr = 1;
    }
    for (const a of out.values()) delete a.last;
    return out;
  });
}

/**
 * Lane coverage of a slice (the rows of timelineQuery's coverage scan): per (lv, uc) tokens, distinct documents,
 * span of dated documents, decade-bin span of documents that fit a decade, synthetic, samplings, tokens outside
 * chronology.
 * @param {object} cube
 * @param {object} def
 * @param {string[]|null} langs
 * @returns {Array<{lv: string|null, uc: string, tokens: number, docs: number, span_lo: number|null, span_hi: number|null,
 *   bin_lo: number|null, bin_hi: number|null, syn: number, samplings: string, outside_tokens: number}>}
 */
export function cubeCoverage(cube, def, langs) {
  return memo(`cov|${idOf(cube)}|${sliceKey(def, langs)}|${def.lanes.facet}`, () => {
    const pass = slicePredicate(cube, def, langs);
    const lanes = laneGroups(cube, def.lanes.facet);
    const { doc, tokens, cs, ylo, yhi, flags, coll } = cube.cols;
    const out = new Map();
    for (let r = 0; r < cube.n; r++) {
      if (!pass(r)) continue;
      const g = lanes.group(r);
      let a = out.get(g);
      if (!a) {
        const l = lanes.lane(g);
        if (!l) continue;
        a = { lv: l.lv, uc: l.uc, tokens: 0, docs: 0, span_lo: null, span_hi: null, bin_lo: null, bin_hi: null, syn: 0,
          samplings: new Set(), outside_tokens: 0, last: -1 };
        out.set(g, a);
      }
      a.tokens += tokens[r];
      if (a.last !== doc[r]) { a.docs++; a.last = doc[r]; }
      if (cs[r] === 0) {
        if (a.span_lo === null || ylo[r] < a.span_lo) a.span_lo = ylo[r];
        if (a.span_hi === null || yhi[r] > a.span_hi) a.span_hi = yhi[r];
        const b = Math.floor(ylo[r] / 10);
        if (b === Math.floor(yhi[r] / 10)) {
          if (a.bin_lo === null || b < a.bin_lo) a.bin_lo = b;
          if (a.bin_hi === null || b > a.bin_hi) a.bin_hi = b;
        }
      } else a.outside_tokens += tokens[r];
      if (flags[r] & F_SYN) a.syn = 1;
      const s = cube.colls[coll[r]].sampling;
      if (s !== null && s !== undefined) a.samplings.add(s);
    }
    return [...out.values()].map(({ last, samplings, ...a }) => ({ ...a, samplings: [...samplings].sort().join(',') }));
  });
}

/**
 * (lane value, unit class, collection) triples of a slice in every language — the input of the lane gates
 * (rates.laneGate): [{lv, uc, unit, coverage_gate}].
 * @param {object} cube
 * @param {object} def
 * @returns {Array<{lv: string|null, uc: string, unit: string, coverage_gate: number|null}>}
 */
export function cubeGateRows(cube, def) {
  return memo(`gate|${idOf(cube)}|${sliceKey(def, null)}|${def.lanes.facet}`, () => {
    const pass = slicePredicate(cube, def, null);
    const lanes = laneGroups(cube, def.lanes.facet);
    const seen = new Set();
    const out = [];
    for (let r = 0; r < cube.n; r++) {
      if (!pass(r)) continue;
      const g = lanes.group(r), c = cube.cols.coll[r];
      const k = g * (cube.colls.length + 1) + c;
      if (seen.has(k)) continue;
      seen.add(k);
      const l = lanes.lane(g), col = cube.colls[c];
      if (!l) continue;
      out.push({ lv: l.lv, uc: l.uc, unit: col.unit, coverage_gate: col.coverage_gate, sampling: col.sampling ?? null });
    }
    return out;
  });
}

/**
 * The last year with full text (seams.mjs): the latest y_hi of a dated document with text tokens; with `langs`,
 * only documents whose full text is mostly (> 50% of text tokens) in those languages — an unidentified text row in its
 * document's language only (RF-1).
 * @param {object} cube
 * @param {string[]|null} langs
 * @returns {number|null}
 */
export function cubeLastTextYear(cube, langs) {
  return memo(`seam|${idOf(cube)}|${JSON.stringify(langs ?? null)}`, () => {
    const { doc, tokens, cs, yhi, fc, plang, del, dlang } = cube.cols;
    const inLang = Array.isArray(langs) ? Uint8Array.from(cube.dicts.plang, (v) => (langs.includes(v) ? 1 : 0)) : null;
    const lg = Array.isArray(langs) ? languageGate(cube, langs) : null;
    let last = null;
    let r = 0;
    while (r < cube.n) {
      const d = doc[r];
      let total = 0, mine = 0, any = false;
      const dated = cs[r] === 0 && del[r] === 0, y = yhi[r];
      for (; r < cube.n && doc[r] === d; r++) {
        if (fc[r] !== 0) continue;
        total += tokens[r];
        if (tokens[r] > 0) any = true;
        if (inLang && inLang[plang[r]] && (lg.und[plang[r]] === 0 || lg.docOk[dlang[r]] === 1)) mine += tokens[r];
      }
      if (!dated || !any || (inLang && !(2 * mine > total))) continue;
      if (last === null || y > last) last = y;
    }
    return last;
  });
}

/**
 * How much of the slice a concordance looked at: tokens (text and abstract rows), works (documents with title rows)
 * and documents, in the strand's languages, for documents overlapping [from, to] (dated only when a range is given;
 * every chronology status otherwise) and, optionally, one lane — the same documents the KWIC rows come from.
 * @param {object} cube
 * @param {object} def
 * @param {string[]|null} langs
 * @param {{from?: number|null, to?: number|null, lane?: string|null}} [opts]
 * @returns {{tokens: number, works: number, docs: number}}
 */
export function cubeRangeTotals(cube, def, langs, { from = null, to = null, lane = null } = {}) {
  const pass = slicePredicate(cube, def, langs);
  const lanes = laneGroups(cube, def.lanes.facet);
  const { doc, tokens, cs, ylo, yhi, fc } = cube.cols;
  const ranged = Number.isInteger(from) || Number.isInteger(to);
  let t = 0, works = 0, docs = 0, lastDoc = -1, lastWork = -1;
  for (let r = 0; r < cube.n; r++) {
    if (!pass(r)) continue;
    if (ranged && (cs[r] !== 0 || (Number.isInteger(from) && yhi[r] < from) || (Number.isInteger(to) && ylo[r] > to))) continue;
    if (lane !== null && lanes.lane(lanes.group(r))?.key !== lane) continue;
    if (UNIT_OF_FC[fc[r]] === 1) { if (lastWork !== doc[r]) { works++; lastWork = doc[r]; } } else t += tokens[r];
    if (lastDoc !== doc[r]) { docs++; lastDoc = doc[r]; }
  }
  return { tokens: t, works, docs };
}

/**
 * Size of a corpus's counted collections for the computed empty state (§8.8): full-text tokens, works with a title,
 * and the last year with full text in the given languages (as the modality seam reads it).
 * @param {object} cube
 * @param {string[]|null} langs
 * @returns {{tokens: number, works: number, last_text: number|null}}
 */
export function cubeCorpusSize(cube, langs) {
  return memo(`size|${idOf(cube)}|${JSON.stringify(langs ?? null)}`, () => {
    const { doc, tokens, fc, del } = cube.cols;
    let t = 0, works = 0, lastWork = -1;
    for (let r = 0; r < cube.n; r++) {
      if (del[r] !== 0) continue;
      if (fc[r] === 0) t += tokens[r];
      else if (fc[r] === 1 && lastWork !== doc[r]) { works++; lastWork = doc[r]; }
    }
    return { tokens: t, works, last_text: cubeLastTextYear(cube, langs) };
  });
}

// ── several corpora (a virtual corpus): one cube each, added up ──────────────────────────────────────

/**
 * The slice cubes of a def's corpora (one per member of a virtual corpus).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{corpusIds?: number[], corpusId: number}} def
 * @returns {object[]}
 */
export function cubesOf(db, def) {
  const ids = def.corpusIds ?? [def.corpusId];
  const out = ids.map((id) => sliceCube(db, id));
  if (def.lanes?.facet === 'trail') for (const id of ids) { const e = endpointCube(db, id); if (e.n) out.push(e); }
  return out;
}

/**
 * The cubes of corpora when every one is ready (or small enough to build at once), else null (cube.readyCube).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} ids
 * @param {{endpoints?: boolean}} [opts] also the relation-endpoint cubes (a Term trail def)
 * @returns {object[]|null}
 */
export function readyCubes(db, ids, { endpoints = false } = {}) {
  const out = [];
  for (const id of ids) {
    const c = readyCube(db, id);
    if (!c) return null;
    out.push(c);
    if (endpoints) {
      // the Term trail's relation endpoints: only when that cube is ready (it is never built on this path)
      const e = peekArtifact(db, cubeSpec(id, true));
      if (!e) return null;
      if (e.n) out.push(e);
    }
  }
  return out;
}

/**
 * cubeDenominators over every corpus of a def, added up per lane × bin (documents of different corpora are disjoint).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @param {string[]|null|{byCorpus: object}} langs
 * @param {string} tier
 * @returns {Map<string, object>}
 */
export function sliceDenominators(db, def, langs, tier) {
  const cubes = cubesOf(db, def);
  if (cubes.length === 1) return cubeDenominators(cubes[0], def, langs, tier);
  const out = new Map();
  for (const cube of cubes) {
    for (const [k, d] of cubeDenominators(cube, def, langs, tier)) {
      const a = out.get(k);
      if (!a) out.set(k, { ...d });
      else { a.tokens += d.tokens; a.docs += d.docs; a.syn |= d.syn; a.tr |= d.tr; }
    }
  }
  return out;
}

/**
 * cubeCoverage over every corpus of a def, merged per lane.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @param {string[]|null|{byCorpus: object}} langs
 * @returns {object[]}
 */
export function sliceCoverage(db, def, langs) {
  const cubes = cubesOf(db, def);
  if (cubes.length === 1) return cubeCoverage(cubes[0], def, langs);
  const out = new Map();
  const lo = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));
  const hi = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));
  for (const cube of cubes) {
    for (const c of cubeCoverage(cube, def, langs)) {
      const k = `${c.lv}|${c.uc}`;
      const a = out.get(k);
      if (!a) { out.set(k, { ...c }); continue; }
      a.tokens += c.tokens; a.docs += c.docs; a.outside_tokens += c.outside_tokens; a.syn |= c.syn;
      a.span_lo = lo(a.span_lo, c.span_lo); a.span_hi = hi(a.span_hi, c.span_hi);
      a.bin_lo = lo(a.bin_lo, c.bin_lo); a.bin_hi = hi(a.bin_hi, c.bin_hi);
      a.samplings = [...new Set([...a.samplings.split(','), ...c.samplings.split(',')].filter(Boolean))].sort().join(',');
    }
  }
  return [...out.values()];
}

/**
 * cubeGateRows over every corpus of a def.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @returns {object[]}
 */
export function sliceGateRows(db, def) {
  return cubesOf(db, def).flatMap((cube) => cubeGateRows(cube, def));
}

/**
 * cubeLastTextYear over every corpus of a def (the latest).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @param {string[]|null} langs
 * @returns {number|null}
 */
export function sliceLastTextYear(db, def, langs) {
  let last = null;
  for (const cube of cubesOf(db, def)) {
    const y = cubeLastTextYear(cube, langs);
    if (y !== null && (last === null || y > last)) last = y;
  }
  return last;
}

/**
 * cubeRangeTotals over several cubes, added up.
 * @param {object[]} cubes
 * @param {object} def
 * @param {string[]|null|{byCorpus: object}} langs
 * @param {object} [opts]
 * @returns {{tokens: number, works: number, docs: number}}
 */
export function cubesRangeTotals(cubes, def, langs, opts = {}) {
  const out = { tokens: 0, works: 0, docs: 0 };
  for (const cube of cubes) {
    const t = cubeRangeTotals(cube, def, langs, opts);
    out.tokens += t.tokens; out.works += t.works; out.docs += t.docs;
  }
  return out;
}

/**
 * cubeCorpusSize over several cubes: tokens and works added up, the latest last-text year.
 * @param {object[]} cubes
 * @param {string[]|null} langs
 * @returns {{tokens: number, works: number, last_text: number|null}}
 */
export function cubesCorpusSize(cubes, langs) {
  const out = { tokens: 0, works: 0, last_text: null };
  for (const cube of cubes) {
    const s = cubeCorpusSize(cube, langs);
    out.tokens += s.tokens; out.works += s.works;
    if (s.last_text !== null && (out.last_text === null || s.last_text > out.last_text)) out.last_text = s.last_text;
  }
  return out;
}

// ── OpenAlex cells (C3) ──────────────────────────────────────────────────────────────────────────────

/**
 * Each sampled work's OpenAlex cell (`field|lo-hi`, the adapter's sample_cell) in a corpus's top-cited-per-cell
 * collections: Map document id → cell. A shared artifact keyed like the cube, built only when a Term trail needs it.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} corpusId
 * @returns {Map<number, string>}
 */
export function docCells(db, corpusId) {
  return sharedArtifact(db, cellsSpec(corpusId));
}

/** The sharedArtifact spec of a corpus's OpenAlex cell index. */
export const cellsSpec = (corpusId) => ({
  name: `cells1-c${corpusId}`, key: (d) => corpusInputsKey(d, corpusId, { scope: 'cells' }),
  build: (d) => new Map(d.prepare(`SELECT d.id, json_extract(d.original_meta_json, '$.sample_cell') AS cell FROM collection c
    JOIN document d ON d.collection_id = c.id WHERE c.corpus_id = ? AND c.sampling = 'top_cited_per_cell' AND d.deleted_at IS NULL`)
    .all(corpusId).filter((r) => typeof r.cell === 'string').map((r) => [r.id, r.cell])),
  encode: (m) => Buffer.from(JSON.stringify([...m])),
  decode: (bytes) => new Map(JSON.parse(bytes.toString('utf8'))),
});

/**
 * Sampled works per (trail share lane, OpenAlex cell) in a slice: distinct documents with at least one row passing the
 * slice predicate (the strand's languages when given). The n of a within-cell share.
 * @param {object} cube
 * @param {object} def a Term trail def
 * @param {string[]|null|{byCorpus: object}} langs
 * @param {Map<number, string>} cells docCells of the cube's corpus
 * @returns {Map<string, {lane: string, cell: string, n: number}>} keyed `${lane}|${cell}`
 */
export function cubeCellWorks(cube, def, langs, cells) {
  return memo(`cellworks|${idOf(cube)}|${cells.size}|${sliceKey(def, langs)}|${def.lanes.facet}`, () => {
    const out = new Map();
    if (!cells.size) return out;
    const pass = slicePredicate(cube, def, langs);
    const lanes = laneGroups(cube, 'trail');
    const { doc } = cube.cols;
    for (let r = 0; r < cube.n; r++) {
      const cell = cells.get(doc[r]);
      if (cell === undefined || !pass(r)) continue;
      const l = lanes.lane(lanes.group(r));
      if (!l || l.uc !== 'cells') continue;
      const k = `${l.key}|${cell}`;
      let a = out.get(k);
      if (!a) { a = { lane: l.key, cell, n: 0, last: -1 }; out.set(k, a); }
      if (a.last !== doc[r]) { a.n++; a.last = doc[r]; }
    }
    for (const a of out.values()) delete a.last;
    return out;
  });
}
