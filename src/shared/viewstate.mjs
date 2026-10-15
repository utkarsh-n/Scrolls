// OWNER: WP0 — the reproducible view state and its URL hash (SPEC §8.2, D17)
//
// encode() writes a readable, versioned, canonical hash with defaults omitted; decode() validates, fills
// defaults and never throws. Invariant (tested): decode(encode(s)) deep-equals canonicalize(s).

import { dayFromYMD } from './dates.mjs';
import { canonicalJson, shortHash } from './ids.mjs';
import {
  CONSTELLATION_SIZES, EVIDENCE_STATUS, FILTER_KEYS, LANE_FACETS, LANE_ORDERS, REL_TYPE_BY_CODE, RIGHT_PANELS,
  SELECTION_TYPES, STRAND_GLYPHS, STRAND_TYPES, TIERS, TIME_BASES, TOGGLE_DEFAULTS,
} from './vocab.mjs';

export const VIEWSTATE_VERSION = 1;

const DAYS_PER_YEAR = 365.2425;
/** Pan and zoom domain (§1.5): 10000 BCE – 2100 CE; 0.05 px/year … 40 px/day. */
export const AXIS_LIMITS = Object.freeze({
  minDay: dayFromYMD(-9999, 1, 1), maxDay: dayFromYMD(2100, 12, 31),
  minDaysPerPx: 1 / 40, maxDaysPerPx: DAYS_PER_YEAR / 0.05,
});
/** Vantage day meaning "everything is visible" (real corpora open with no reading-clock limit). */
export const VANTAGE_OPEN_DAY = AXIS_LIMITS.maxDay;
export const MAX_STRANDS = 4;
export const INSPECTOR_MODES = Object.freeze(['tnn', 'reader']);
export const REDUCED_MOTION = Object.freeze(['system', 'on', 'off']);
const VARIANT_MODES = ['default', 'identity', 'all'];
const NUMERIC_STRANDS = new Set(['expression', 'work', 'cluster', 'baseline']);

/**
 * @typedef {Object} ViewState
 * @property {1} v
 * @property {string} corpus
 * @property {Array<{type:string, id:number|string, variants:'default'|'identity'|'all'|number[], glyph:string}>} strands
 * @property {{facet:string, sub:string|null, run:number|null, order:string, manual:string[], max:number}} lanes
 * @property {{lang:string[], kind:string[], coll:string[], culture:string[], field:string[], community:string[], basis:string[], syn:0|1}} f
 * @property {{tr:0|1, ds:0|1, ap:0|1, dup:0|1, nm:0|1, est:0|1, bp:0|1}} toggles
 * @property {'publication'|'referenced'} timeBasis
 * @property {{mode:'linear', centerDay:number, daysPerPx:number, keepLinear:boolean}|{mode:'folded'}} axis
 * @property {'auto'|'L0'|'L1'|'L2'|'L3'|'L4'|'L5'} tier
 * @property {{day:number, strict:boolean}} vantage
 * @property {[number, number]|null} range   [loDay, hiDay]
 * @property {{documented:0|1, computed:0|1, proposed:0|1, rejected:0|1, kindred:0|1}} evidence
 * @property {{arcs:0|1, feedback:0|1, washes:0|1, coverage:0|1, etymology:0|1, claims:0|1, baseline:0|1, variety:0|1, tone:0|1, superseded:0|1}} layers
 * @property {{type:string, id:number|string}|null} selection
 * @property {{inspector:'tnn'|'reader'|null, right:string|null}} panels
 * @property {{a:{years:[number,number], f:string}, b:{years:[number,number], f:string}}|null} compare
 * @property {{layoutKey:string|null, size:string, a:[number,number]|null, b:[number,number]|null}} constellation
 * @property {{root:string|null, depth:number, types:string[], status:string[]}} lineage
 * @property {{materialize:Record<string, number>, cluster:number|null, quotes:number|null, vectors:number|null}} runs
 * @property {boolean} asSaved
 * @property {'system'|'on'|'off'} reducedMotion
 */

const EVIDENCE_KEYS = ['documented', 'computed', 'proposed', 'rejected', 'kindred'];
const EVIDENCE_LETTERS = ['d', 'c', 'p', 'r', 'k'];
const LAYER_KEYS = ['arcs', 'feedback', 'washes', 'coverage', 'etymology', 'claims', 'baseline', 'variety', 'tone', 'superseded'];
const LAYER_LETTERS = ['a', 'f', 'w', 'c', 'e', 'k', 'b', 'v', 't', 's'];
const ORDER_CODES = { first_observed: 'fo', total_n: 'tn', alphabetical: 'al', manual: 'mn' };
const STRAND_CODES = { expression: 'e', theme: 't', work: 'w', maker: 'm', cluster: 'k', baseline: 'b' };
const SELECTION_CODES = { occurrence: 'occ', passage: 'psg', cluster: 'cl', relationship: 'rel', document: 'doc', bin: 'bin' };
const SIZE_CODES = { occurrences: 'o', documents: 'd', authors: 'a' };
const invert = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
const ORDER_BY_CODE = invert(ORDER_CODES), STRAND_BY_CODE = invert(STRAND_CODES);
const SELECTION_BY_CODE = invert(SELECTION_CODES), SIZE_BY_CODE = invert(SIZE_CODES);

/**
 * The default state of a corpus. The demo opens on "carry the zero" territory (1890–2030, decade bins,
 * lanes = community, vantage 1925, §1.11); real corpora open 1800–2030 with lanes = domain and no
 * vantage limit; the virtual corpus `real` (contract 1.3.0) opens on the Term trail lanes.
 * @param {string} [corpus='demo']
 * @returns {ViewState}
 */
export function defaultState(corpus = 'demo') {
  const demo = corpus === 'demo';
  return {
    v: VIEWSTATE_VERSION,
    corpus,
    strands: [],
    // contract 1.3.0: the virtual corpus `real` (every non-synthetic corpus) opens on the Term trail
    lanes: { facet: demo ? 'community' : corpus === 'real' ? 'trail' : 'domain', sub: null, run: null, order: 'first_observed', manual: [], max: 10 },
    f: { lang: [], kind: [], coll: [], culture: [], field: [], community: [], basis: [], syn: 1 },
    toggles: { ...TOGGLE_DEFAULTS },
    timeBasis: 'publication',
    axis: demo
      ? { mode: 'linear', centerDay: dayFromYMD(1960, 1, 1), daysPerPx: 50, keepLinear: false }
      : { mode: 'linear', centerDay: dayFromYMD(1915, 1, 1), daysPerPx: 75, keepLinear: false },
    tier: 'auto',
    // paused is context (§1.9: play runs strict, pausing switches to context): a link without t= opens in context, so
    // a selected later mark is ghosted, never hidden (fix pass)
    vantage: { day: demo ? dayFromYMD(1925, 12, 31) : VANTAGE_OPEN_DAY, strict: false },
    range: null,
    evidence: { documented: 1, computed: 1, proposed: 1, rejected: 0, kindred: 0 },
    layers: { arcs: 1, feedback: 1, washes: 1, coverage: 1, etymology: 1, claims: 1, baseline: 0, variety: 0, tone: 0, superseded: 0 },
    selection: null,
    panels: { inspector: 'tnn', right: null },
    compare: null,
    constellation: { layoutKey: null, size: 'occurrences', a: null, b: null },
    lineage: { root: null, depth: 2, types: [], status: [] },
    runs: { materialize: {}, cluster: null, quotes: null, vectors: null },
    asSaved: false,
    reducedMotion: 'system',
  };
}

// ── Filter grammar (§7): 'lang:en,fr;kind:book,song;coll:cipher-gutenberg;basis:-estimated;syn:1' ────────

const VALUE_RE = /^-?[^,;:\s][^,;:]{0,119}$/u;

/**
 * Parse the `f` filter grammar into ViewState.f form. Unknown keys and malformed values are skipped and
 * reported in `warnings`.
 * @param {string} str
 * @param {string[]} [warnings]
 * @returns {ViewState['f']}
 */
export function parseFilter(str, warnings = []) {
  const f = defaultState().f;
  for (const seg of String(str ?? '').split(';')) {
    if (!seg.trim()) continue;
    const i = seg.indexOf(':');
    const key = (i < 0 ? seg : seg.slice(0, i)).trim();
    const vals = i < 0 ? [] : seg.slice(i + 1).split(',').map((v) => v.trim()).filter(Boolean);
    if (!FILTER_KEYS.includes(key)) { warnings.push(`unknown filter '${key}' ignored`); continue; }
    if (key === 'syn') {
      if (vals.length === 1 && (vals[0] === '0' || vals[0] === '1')) f.syn = Number(vals[0]);
      else warnings.push(`filter syn must be 0 or 1; '${vals.join(',')}' ignored`);
      continue;
    }
    for (const v of vals) {
      if (VALUE_RE.test(v)) f[key].push(v);
      else warnings.push(`filter value '${v}' for ${key} ignored`);
    }
  }
  return canonicalFilter(f, warnings);
}

/**
 * Format ViewState.f as the `f` grammar, in FILTER_KEYS order; empty lists are left out and `syn` only
 * when it differs from the default (1) unless `withDefaults`.
 * @param {ViewState['f']} f
 * @param {{withDefaults?: boolean}} [opts]
 * @returns {string}
 */
export function formatFilter(f, { withDefaults = false } = {}) {
  const c = canonicalFilter(f, []);
  const parts = [];
  for (const k of FILTER_KEYS) {
    if (k === 'syn') { if (withDefaults || c.syn !== 1) parts.push(`syn:${c.syn}`); continue; }
    if (c[k].length) parts.push(`${k}:${c[k].join(',')}`);
  }
  return parts.join(';');
}

function canonicalFilter(f, warnings) {
  const out = defaultState().f;
  const src = isObj(f) ? f : {};
  for (const k of FILTER_KEYS) {
    if (k === 'syn') { out.syn = src.syn === 0 || src.syn === '0' ? 0 : 1; continue; }
    const vals = Array.isArray(src[k]) ? src[k] : [];
    const keep = vals.map((v) => String(v).trim()).filter((v) => {
      if (VALUE_RE.test(v)) return true;
      warnings.push(`filter value '${v}' for ${k} ignored`);
      return false;
    });
    out[k] = [...new Set(keep)].sort();
  }
  return out;
}

// ── Canonical form ──────────────────────────────────────────────────────────────────────────────────

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const bit = (x, dflt) => (x === 0 || x === 1 ? x : x === true ? 1 : x === false ? 0 : x === '1' ? 1 : x === '0' ? 0 : dflt);
const posInt = (x) => (Number.isSafeInteger(x) && x > 0 ? x : typeof x === 'string' && /^\d{1,15}$/.test(x) && Number(x) > 0 ? Number(x) : null);
const int = (x) => (Number.isSafeInteger(x) ? x : typeof x === 'string' && /^-?\d{1,15}$/.test(x) ? Number(x) : null);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sig6 = (x) => Number(Number(x).toPrecision(6));
const oneOf = (x, list, dflt) => (list.includes(x) ? x : dflt);
const shortStr = (x, max = 200) => (typeof x === 'string' && x.length > 0 && x.length <= max && !/[\u0000-\u001F]/.test(x) ? x : null);

function canonStrands(input, warnings) {
  const out = [], seen = new Set();
  for (const s of Array.isArray(input) ? input : []) {
    if (!isObj(s) || !STRAND_TYPES.includes(s.type)) { warnings.push('strand with an unknown type ignored'); continue; }
    const id = NUMERIC_STRANDS.has(s.type) ? posInt(s.id) : shortStr(s.id);
    if (id === null) { warnings.push(`strand ${s.type} without a valid id ignored`); continue; }
    const key = `${s.type}:${id}`;
    if (seen.has(key)) continue;
    if (out.length === MAX_STRANDS) { warnings.push(`more than ${MAX_STRANDS} strands; extra strands ignored`); break; }
    seen.add(key);
    let variants = 'default';
    if (s.type === 'expression') {
      if (Array.isArray(s.variants)) {
        const ids = [...new Set(s.variants.map(posInt).filter((x) => x !== null))].sort((a, b) => a - b);
        variants = ids.length ? ids : 'default';
      } else variants = oneOf(s.variants, VARIANT_MODES, 'default');
    }
    out.push({ type: s.type, id, variants, glyph: STRAND_GLYPHS[out.length] });
  }
  return out;
}

function canonYears(x) {
  if (!Array.isArray(x) || x.length !== 2) return null;
  let a = int(x[0]), b = int(x[1]);
  if (a === null || b === null) return null;
  [a, b] = [a, b].map((y) => clamp(y, -9999, 2100));   // the pan domain, 10000 BCE – 2100 CE
  return a <= b ? [a, b] : [b, a];
}

function canonSlice(x, warnings) {
  if (!isObj(x)) return null;
  const years = canonYears(x.years);
  if (!years) return null;
  return { years, f: formatFilter(parseFilter(typeof x.f === 'string' ? x.f : '', warnings)) };
}

/**
 * Validated, defaults-filled, canonical copy of a view state (unknown keys dropped, lists sorted where
 * order carries no meaning, numbers clamped and rounded). Never throws.
 * @param {Partial<ViewState>} state
 * @param {string[]} [warnings] receives what was dropped or repaired
 * @returns {ViewState}
 */
export function canonicalize(state, warnings = []) {
  const s = isObj(state) ? state : {};
  if (!isObj(state)) warnings.push('state is not an object; defaults used');
  let corpus = typeof s.corpus === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(s.corpus) ? s.corpus : null;
  if (corpus === null) {
    if (s.corpus !== undefined) warnings.push(`corpus '${String(s.corpus)}' is not valid; 'demo' used`);
    corpus = 'demo';
  }
  const d = defaultState(corpus);
  const out = d;

  out.strands = canonStrands(s.strands, warnings);

  const L = isObj(s.lanes) ? s.lanes : {};
  out.lanes.facet = oneOf(L.facet, LANE_FACETS, d.lanes.facet);
  out.lanes.sub = LANE_FACETS.includes(L.sub) && L.sub !== out.lanes.facet ? L.sub : null;
  out.lanes.run = posInt(L.run);
  out.lanes.order = oneOf(L.order, LANE_ORDERS, d.lanes.order);
  out.lanes.manual = out.lanes.order === 'manual' && Array.isArray(L.manual)
    ? [...new Set(L.manual.map((x) => shortStr(x)).filter(Boolean))] : [];
  out.lanes.max = Number.isSafeInteger(L.max) ? clamp(L.max, 1, 48) : d.lanes.max;

  out.f = canonicalFilter(s.f, warnings);

  const T = isObj(s.toggles) ? s.toggles : {};
  for (const k of Object.keys(TOGGLE_DEFAULTS)) out.toggles[k] = bit(T[k], TOGGLE_DEFAULTS[k]);

  out.timeBasis = oneOf(s.timeBasis, TIME_BASES, 'publication');

  const A = isObj(s.axis) ? s.axis : {};
  if (A.mode === 'folded') out.axis = { mode: 'folded' };
  else if (A.mode === 'linear' || A.mode === undefined) {
    const c = Number.isFinite(A.centerDay) ? Math.round(A.centerDay) : d.axis.centerDay;
    const dpp = Number.isFinite(A.daysPerPx) && A.daysPerPx > 0 ? A.daysPerPx : d.axis.daysPerPx;
    out.axis = {
      mode: 'linear',
      centerDay: clamp(c, AXIS_LIMITS.minDay, AXIS_LIMITS.maxDay),
      daysPerPx: sig6(clamp(dpp, AXIS_LIMITS.minDaysPerPx, AXIS_LIMITS.maxDaysPerPx)),
      keepLinear: A.keepLinear === true,
    };
  } else warnings.push(`axis mode '${String(A.mode)}' unknown; default axis used`);

  out.tier = s.tier === 'auto' || TIERS.includes(s.tier) ? s.tier : 'auto';

  const V = isObj(s.vantage) ? s.vantage : {};
  out.vantage = {
    day: Number.isFinite(V.day) ? clamp(Math.round(V.day), AXIS_LIMITS.minDay, AXIS_LIMITS.maxDay) : d.vantage.day,
    strict: typeof V.strict === 'boolean' ? V.strict : d.vantage.strict,
  };

  if (Array.isArray(s.range) && s.range.length === 2 && s.range.every(Number.isFinite)) {
    const [a, b] = s.range.map((x) => clamp(Math.round(x), AXIS_LIMITS.minDay, AXIS_LIMITS.maxDay));
    out.range = a <= b ? [a, b] : [b, a];
  }

  const E = isObj(s.evidence) ? s.evidence : {};
  for (const k of EVIDENCE_KEYS) out.evidence[k] = bit(E[k], d.evidence[k]);
  const Ly = isObj(s.layers) ? s.layers : {};
  for (const k of LAYER_KEYS) out.layers[k] = bit(Ly[k], d.layers[k]);

  if (isObj(s.selection) && SELECTION_TYPES.includes(s.selection.type)) {
    const id = s.selection.type === 'bin' ? shortStr(s.selection.id) : posInt(s.selection.id);
    if (id !== null) out.selection = { type: s.selection.type, id };
    else warnings.push('selection without a valid id ignored');
  }

  const P = isObj(s.panels) ? s.panels : {};
  out.panels = {
    inspector: P.inspector === null ? null : oneOf(P.inspector, INSPECTOR_MODES, 'tnn'),
    right: oneOf(P.right, RIGHT_PANELS, null),
  };

  if (isObj(s.compare)) {
    const a = canonSlice(s.compare.a, warnings), b = canonSlice(s.compare.b, warnings);
    if (a && b) out.compare = { a, b };
    else warnings.push('compare needs two slices with years; ignored');
  }

  const K = isObj(s.constellation) ? s.constellation : {};
  out.constellation = {
    layoutKey: K.layoutKey === '-' ? null : shortStr(K.layoutKey, 120),
    size: oneOf(K.size, CONSTELLATION_SIZES, 'occurrences'),
    a: canonYears(K.a),
    b: canonYears(K.b),
  };

  const G = isObj(s.lineage) ? s.lineage : {};
  out.lineage = {
    root: typeof G.root === 'string' && /^[a-z_]+:./.test(G.root) ? shortStr(G.root, 200) : null,
    depth: Number.isSafeInteger(G.depth) ? clamp(G.depth, 1, 6) : 2,
    types: [...new Set((Array.isArray(G.types) ? G.types : []).filter((t) => REL_TYPE_BY_CODE[t]))].sort(),
    status: [...new Set((Array.isArray(G.status) ? G.status : []).filter((t) => EVIDENCE_STATUS.includes(t)))].sort(),
  };

  const R = isObj(s.runs) ? s.runs : {};
  const mat = {};
  if (isObj(R.materialize)) {
    for (const [k, v] of Object.entries(R.materialize)) {
      const e = posInt(k), r = posInt(v);
      if (e !== null && r !== null) mat[e] = r;
    }
  }
  out.runs = { materialize: mat, cluster: posInt(R.cluster), quotes: posInt(R.quotes), vectors: posInt(R.vectors) };

  out.asSaved = s.asSaved === true;
  out.reducedMotion = oneOf(s.reducedMotion, REDUCED_MOTION, 'system');
  return out;
}

// ── URL hash ────────────────────────────────────────────────────────────────────────────────────────

/** Strict atom encoding: everything but unreserved characters, and '~', is escaped. */
const encAtom = (s) => encodeURIComponent(String(s)).replace(/[~!'()*.]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** Readable encoding for grammar strings: ':' ',' ';' '/' '@' stay literal; '~' is escaped. */
const encText = (s) => encodeURIComponent(String(s)).replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%3B/g, ';')
  .replace(/%2F/g, '/').replace(/%40/g, '@').replace(/~/g, '%7E');
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const letters = (obj, keys, codes) => keys.map((k, i) => (obj[k] ? codes[i] : '')).join('') || '0';

/**
 * Encode a view state as the URL hash of §8.2 (leading '#', canonical parameter order, defaults omitted;
 * `v` and `c` are always present because the corpus decides the defaults).
 * @param {ViewState} state
 * @returns {string}
 */
export function encode(state) {
  const s = canonicalize(state);
  const d = defaultState(s.corpus);
  const p = [`v=${VIEWSTATE_VERSION}`, `c=${s.corpus}`];

  if (s.strands.length) {
    p.push(`s=${s.strands.map((x) => {
      let t = STRAND_CODES[x.type] + (NUMERIC_STRANDS.has(x.type) ? x.id : encAtom(x.id));
      if (Array.isArray(x.variants)) t += `-v${x.variants.join('_')}`;
      else if (x.variants !== 'default') t += `-${x.variants[0]}`;
      return t;
    }).join(',')}`);
  }
  const L = s.lanes;
  if (L.facet !== d.lanes.facet || L.sub || L.run || L.order !== d.lanes.order || L.max !== d.lanes.max) {
    let l = `${L.facet}${L.sub ? `/${L.sub}` : ''}:${ORDER_CODES[L.order]}`;
    if (L.run) l += `:r${L.run}`;
    if (L.max !== d.lanes.max) l += `:m${L.max}`;
    p.push(`l=${l}`);
  }
  if (L.manual.length) p.push(`lm=${L.manual.map(encText).join('~')}`);
  if (!same(s.f, d.f)) p.push(`f=${encText(formatFilter(s.f, { withDefaults: s.f.syn !== 1 }))}`);
  const tg = Object.keys(TOGGLE_DEFAULTS).filter((k) => s.toggles[k] !== TOGGLE_DEFAULTS[k]).map((k) => `${k}${s.toggles[k]}`);
  if (tg.length) p.push(`tg=${tg.join('.')}`);
  if (s.timeBasis !== 'publication') p.push('tb=ref');
  if (!same(s.axis, d.axis)) {
    p.push(s.axis.mode === 'folded' ? 'x=fold' : `x=lin:${s.axis.centerDay}:${s.axis.daysPerPx}${s.axis.keepLinear ? ':k' : ''}`);
  }
  if (s.tier !== 'auto') p.push(`ti=${s.tier}`);
  if (!same(s.vantage, d.vantage)) p.push(`t=${s.vantage.day}${s.vantage.strict ? 's' : 'c'}`);
  if (s.range) p.push(`rg=${s.range[0]}:${s.range[1]}`);
  if (!same(s.evidence, d.evidence)) p.push(`ev=${letters(s.evidence, EVIDENCE_KEYS, EVIDENCE_LETTERS)}`);
  if (!same(s.layers, d.layers)) p.push(`ly=${letters(s.layers, LAYER_KEYS, LAYER_LETTERS)}`);
  if (s.selection) p.push(`sel=${SELECTION_CODES[s.selection.type]}:${encAtom(s.selection.id)}`);
  if (!same(s.panels, d.panels)) p.push(`p=${s.panels.inspector ?? '-'}${s.panels.right ? `,${s.panels.right}` : ''}`);
  if (s.compare) {
    const sl = (x) => `${x.years[0]}-${x.years[1]}${x.f ? `@${encText(x.f)}` : ''}`;
    p.push(`cmp=${sl(s.compare.a)}~${sl(s.compare.b)}`);
  }
  const K = s.constellation;
  if (!same(K, d.constellation)) {
    const yr = (y) => (y ? `${y[0]}-${y[1]}` : '-');
    p.push(`k=${K.layoutKey ? encText(K.layoutKey) : '-'}~${SIZE_CODES[K.size]}~${yr(K.a)}~${yr(K.b)}`);
  }
  const G = s.lineage;
  if (!same(G, d.lineage)) p.push(`lg=${G.root ? encText(G.root) : '-'}~${G.depth}~${G.types.join(',')}~${G.status.join(',')}`);
  if (!same(s.runs, d.runs)) {
    const r = Object.entries(s.runs.materialize).map(([e, run]) => `m${e}_${run}`);
    if (s.runs.cluster) r.push(`c${s.runs.cluster}`);
    if (s.runs.quotes) r.push(`q${s.runs.quotes}`);
    if (s.runs.vectors) r.push(`v${s.runs.vectors}`);
    p.push(`r=${r.join('.')}`);
  }
  if (s.asSaved) p.push('as=1');
  // reduced motion is the viewer's own setting (localStorage, §8.2): it never travels in a link (fix pass)
  return `#${p.join('&')}`;
}

function splitParams(hash) {
  const params = new Map();
  for (const part of String(hash ?? '').replace(/^#/, '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    params.set(i < 0 ? part : part.slice(0, i), i < 0 ? '' : part.slice(i + 1));
  }
  return params;
}

function dec(x, warnings) {
  try { return decodeURIComponent(x); } catch { warnings.push(`undecodable value '${x}' ignored`); return null; }
}

const RANGE_PAIR = /^(-?\d{1,15}):(-?\d{1,15})$/;
const YEAR_PAIR = /^(-?\d{1,6})-(-?\d{1,6})$/;

/** Apply one URL parameter onto a raw state object. Returns false when the value was not understood. */
function applyParam(st, key, raw, w) {
  let m;
  switch (key) {
    case 's':
      st.strands = raw.split(',').filter(Boolean).map((tok) => {
        const type = STRAND_BY_CODE[tok[0]];
        if (!type) { w.push(`strand '${tok}' ignored`); return null; }
        if (NUMERIC_STRANDS.has(type)) {
          m = /^.(\d{1,15})(?:-(i|a|v[\d_]+))?$/.exec(tok);
          if (!m) { w.push(`strand '${tok}' ignored`); return null; }
          const variants = !m[2] ? 'default' : m[2] === 'i' ? 'identity' : m[2] === 'a' ? 'all'
            : m[2].slice(1).split('_').filter(Boolean).map(Number);
          return { type, id: Number(m[1]), variants };
        }
        return { type, id: dec(tok.slice(1), w) };
      }).filter(Boolean);
      return true;
    case 'l':
      m = /^([a-z_]+)(?:\/([a-z_]+))?:([a-z]{2})((?::[rm]\d{1,15})*)$/.exec(raw);
      if (!m) return false;
      st.lanes = { ...st.lanes, facet: m[1], sub: m[2] ?? null, order: ORDER_BY_CODE[m[3]] ?? 'first_observed' };
      for (const opt of m[4].split(':').filter(Boolean)) {
        if (opt[0] === 'r') st.lanes.run = Number(opt.slice(1));
        else st.lanes.max = Number(opt.slice(1));
      }
      return true;
    case 'lm':
      st.lanes = { ...st.lanes, manual: raw.split('~').map((x) => dec(x, w)).filter(Boolean) };
      return true;
    case 'f': {
      const txt = dec(raw, w);
      if (txt === null) return false;
      st.f = parseFilter(txt, w);
      return true;
    }
    case 'tg':
      for (const t of raw.split('.')) {
        m = /^([a-z]+)([01])$/.exec(t);
        if (m && m[1] in TOGGLE_DEFAULTS) st.toggles[m[1]] = Number(m[2]);
        else w.push(`toggle '${t}' ignored`);
      }
      return true;
    case 'tb':
      st.timeBasis = raw === 'ref' ? 'referenced' : 'publication';
      return raw === 'ref' || raw === 'pub';
    case 'x':
      if (raw === 'fold') { st.axis = { mode: 'folded' }; return true; }
      m = /^lin:(-?\d{1,15}):(\d+(?:\.\d+)?(?:e-?\d+)?)(:k)?$/.exec(raw);
      if (!m) return false;
      st.axis = { mode: 'linear', centerDay: Number(m[1]), daysPerPx: Number(m[2]), keepLinear: Boolean(m[3]) };
      return true;
    case 'ti':
      st.tier = raw;
      return TIERS.includes(raw) || raw === 'auto';
    case 't':
      m = /^(-?\d{1,15})([sc])$/.exec(raw);
      if (!m) return false;
      st.vantage = { day: Number(m[1]), strict: m[2] === 's' };
      return true;
    case 'rg':
      m = RANGE_PAIR.exec(raw);
      if (!m) return false;
      st.range = [Number(m[1]), Number(m[2])];
      return true;
    case 'ev':
    case 'ly': {
      const [keys, codes] = key === 'ev' ? [EVIDENCE_KEYS, EVIDENCE_LETTERS] : [LAYER_KEYS, LAYER_LETTERS];
      if (!/^(0|[a-z]+)$/.test(raw)) return false;
      const obj = {};
      keys.forEach((k, i) => { obj[k] = raw.includes(codes[i]) ? 1 : 0; });
      st[key === 'ev' ? 'evidence' : 'layers'] = obj;
      return true;
    }
    case 'sel': {
      const i = raw.indexOf(':');
      const type = SELECTION_BY_CODE[raw.slice(0, i)];
      if (i < 0 || !type) return false;
      const id = dec(raw.slice(i + 1), w);
      st.selection = { type, id: type === 'bin' ? id : Number(id) };
      return true;
    }
    case 'p': {
      const [insp, right] = raw.split(',');
      st.panels = { inspector: insp === '-' ? null : insp, right: right ?? null };
      return true;
    }
    case 'cmp': {
      const sl = raw.split('~').map((part) => {
        const mm = /^(-?\d{1,6})-(-?\d{1,6})(?:@(.*))?$/.exec(part);
        return mm ? { years: [Number(mm[1]), Number(mm[2])], f: mm[3] ? dec(mm[3], w) ?? '' : '' } : null;
      });
      if (sl.length !== 2 || !sl[0] || !sl[1]) return false;
      st.compare = { a: sl[0], b: sl[1] };
      return true;
    }
    case 'k': {
      const [lk, size, a, b] = raw.split('~');
      const yr = (y) => { const mm = YEAR_PAIR.exec(y ?? ''); return mm ? [Number(mm[1]), Number(mm[2])] : null; };
      st.constellation = { layoutKey: lk && lk !== '-' ? dec(lk, w) : null, size: SIZE_BY_CODE[size] ?? 'occurrences', a: yr(a), b: yr(b) };
      return true;
    }
    case 'lg': {
      const [root, depth, types, status] = raw.split('~');
      st.lineage = {
        root: root && root !== '-' ? dec(root, w) : null,
        depth: Number(depth) || 2,
        types: types ? types.split(',') : [],
        status: status ? status.split(',') : [],
      };
      return true;
    }
    case 'r': {
      const runs = { materialize: {}, cluster: null, quotes: null, vectors: null };
      for (const t of raw.split('.')) {
        if ((m = /^m(\d{1,15})_(\d{1,15})$/.exec(t))) runs.materialize[m[1]] = Number(m[2]);
        else if ((m = /^([cqv])(\d{1,15})$/.exec(t))) runs[{ c: 'cluster', q: 'quotes', v: 'vectors' }[m[1]]] = Number(m[2]);
        else w.push(`run '${t}' ignored`);
      }
      st.runs = runs;
      return true;
    }
    case 'as':
      st.asSaved = raw === '1';
      return raw === '1' || raw === '0';
    case 'rm':
      // links made before the fix pass carried rm=; the viewer's own setting wins, so it is read and ignored
      return true;
    default:
      w.push(`unknown parameter '${key}' ignored`);
      return true;
  }
}

/**
 * Decode a hash and report what was repaired. A saved-view hash (`#view=<slug>&as=1`) returns the
 * corpus default state plus `view`, which the caller resolves through GET /api/views/:slug.
 * @param {string} hash
 * @returns {{state: ViewState, warnings: string[], view: {slug: string, asSaved: boolean}|null}}
 */
export function decodeHash(hash) {
  const warnings = [];
  try {
    const params = splitParams(hash);
    if (params.has('view')) {
      const slug = dec(params.get('view'), warnings) ?? '';
      return {
        state: canonicalize({ corpus: params.get('c') ?? 'demo' }, warnings),
        warnings,
        view: slug ? { slug, asSaved: params.get('as') === '1' } : null,
      };
    }
    if (params.size === 0) return { state: defaultState('demo'), warnings, view: null };
    const v = params.get('v');
    if (v === undefined) warnings.push('hash has no version; read as v1');
    else if (v !== String(VIEWSTATE_VERSION)) warnings.push(`hash version ${v} is not ${VIEWSTATE_VERSION}; read as v1`);
    const st = defaultState(params.get('c') ?? 'demo');
    for (const [key, raw] of params) {
      if (key === 'v' || key === 'c') continue;
      if (!applyParam(st, key, raw, warnings)) warnings.push(`parameter ${key}='${raw}' not understood; default kept`);
    }
    return { state: canonicalize(st, warnings), warnings, view: null };
  } catch (err) {
    warnings.push(`hash could not be read (${err?.message ?? err}); default view used`);
    return { state: defaultState('demo'), warnings, view: null };
  }
}

/**
 * Decode a URL hash into a canonical ViewState: validates, migrates, fills defaults; never throws
 * (anything bad → default + a warning, see decodeHash).
 * @param {string} hash
 * @returns {ViewState}
 */
export function decode(hash) {
  return decodeHash(hash).state;
}

/**
 * Stable 16-hex-digit hash of the canonical state (saved_view.state_hash; reload must reproduce it).
 * @param {ViewState} state
 * @returns {string}
 */
export function stateHash(state) {
  // the viewer's reduced-motion setting is not part of what a view shows (it never travels in a link)
  return shortHash(canonicalJson({ ...canonicalize(state), reducedMotion: 'system' }), 16);
}
