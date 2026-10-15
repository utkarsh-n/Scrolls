// OWNER: WP6
// timeline/model.mjs — tiles → per-lane, per-strand typed-array columns, bars, caps, censoring, washes,
// coverage, unit scales and the occurrence override (SPEC §1.2, §1.6, §1.7, §8.3).
//
// Honesty rules this module enforces (§13 rules 3, 4, 18):
//  · a bin's state comes from its cell; a bin without a cell is uncovered (pending while the lane indexes);
//    nothing is ever inferred or interpolated;
//  · a bar is a maximal run of consecutive OBSERVED bins; it never bridges absent, low, uncovered or pending;
//  · washes come only from the server's wash list and are never added to bars or rates;
//  · a cap sits at the exact first/last observed date only when that date is known (marks, the server's
//    per-strand first/last, or the lane's when it draws one row); otherwise it sits on the bar edge and says
//    "in 1910–1919".
// The model is independent of the vantage (playhead): display.mjs applies it, so play never rebuilds this.

import { dayFromYMD, parseDate } from '../../shared/dates.mjs';
import { formatTokens } from '../../shared/format.mjs';
import { CELL_FIELDS } from '../../shared/vocab.mjs';
import { laneLabelOf, parseClusterLaneKey } from './clusters.mjs';
import { coverageTrack, coverageUnitOf, stepClass } from './coverage.mjs';
import { isShareLane, shareCellsOfTile, shareColumns, shareCoveredDays, shareScaleMax, SHARE_UNIT } from './share-cells.mjs';
import { dayLabel } from './scale.mjs';
import { binEndDay, binLabel, binOfDay, binStartDay, TILE_BINS } from './tiers.mjs';

/** The Term trail's etymology lane (C2): periods only, drawn as the etymology row, never as counted bins. */
export const TRAIL_ETYMOLOGY = 'trail:etymology';
/** Term trail lanes that always stay on screen within the lane limit: the literature and the culture end (§10.5). */
export const TRAIL_ANCHOR_LANES = Object.freeze(['trail:literature-text', 'trail:culture-titles', 'trail:music-relations']);

/**
 * The Term trail lanes to show within the lane limit (§1.3: 10 desktop, 5 narrow; fix pass): the literature and culture
 * lanes always, then the STEMM lanes with the most matches; shown in the trail's fixed order, the rest folded.
 * @param {Array<{key: string, n?: number}>} lanes in the trail's fixed order
 * @param {number} limit
 * @returns {Array<object>} the shown lanes, in order
 */
export function trailShownLanes(lanes, limit) {
  if (lanes.length <= limit) return lanes;
  const keep = new Set(lanes.filter((l) => TRAIL_ANCHOR_LANES.includes(l.key)).map((l) => l.key).slice(0, limit));
  const rest = lanes.filter((l) => !keep.has(l.key)).map((l, i) => [l, i]).sort((a, b) => (b[0].n ?? 0) - (a[0].n ?? 0) || a[1] - b[1]);
  for (const [l] of rest) { if (keep.size >= limit) break; keep.add(l.key); }
  return lanes.filter((l) => keep.has(l.key));
}

/** Override threshold: at most this many dated matches in view → individual marks (§1.6). */
export const MAX_MARKS = 4000;
/** Cell tuple positions (§7.2). */
const C = Object.freeze(Object.fromEntries(CELL_FIELDS.map((k, i) => [k, i])));
export { stepClass, coverageUnitOf, coverageTrack };
export const STATE = Object.freeze({ observed: 1, absent: 2, low: 3, uncovered: 4, pending: 5 });

const parsed = new Map();
/**
 * Cached dates.parseDate of a server label ('1905', '17 May 1994', 'c. 1960'); null when undatable.
 * @param {string|null|undefined} label
 * @returns {import('../../shared/dates.mjs').DateParse|null}
 */
export function parseLabel(label) {
  if (typeof label !== 'string' || !label) return null;
  if (!parsed.has(label)) {
    const p = parseDate(label);
    parsed.set(label, p && !p.issue && Number.isFinite(p.lo_day) ? p : null);
    if (parsed.size > 2000) parsed.delete(parsed.keys().next().value);
  }
  return parsed.get(label);
}

/**
 * Date label of a mark at its own precision: '17 May 1994', 'Feb 1995', '1994', '1990–1999'.
 * @param {{lo_day: number, hi_day: number, precision: string}} m
 * @returns {string}
 */
export function markLabel(m) {
  if (m.precision === 'day' || m.precision === 'month' || m.precision === 'year') return dayLabel(m.lo_day, m.precision);
  const a = dayLabel(m.lo_day), b = dayLabel(m.hi_day);
  return a === b ? a : `${a}–${b}`;
}

/**
 * Typed-array columns of one strand's cells, sorted by bin. The painter, the hit grid and the a11y table
 * all read these same arrays (identity-tested).
 * @param {Array<number[]>} cells cell tuples with an absolute bin in position 0
 * @param {string} tier
 */
export function buildColumns(cells, tier) {
  const len = cells.length;
  const cols = {
    length: len,
    bin: new Int32Array(len), lo: new Float64Array(len), hi: new Float64Array(len),
    n: new Int32Array(len), docs: new Int32Array(len), authors: new Int32Array(len), denom: new Float64Array(len),
    rate: new Float64Array(len), ciLo: new Float64Array(len), ciHi: new Float64Array(len),
    state: new Uint8Array(len), flags: new Uint16Array(len), dp: new Float64Array(len),
  };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  cells.forEach((c, i) => {
    cols.bin[i] = c[C.bin];
    cols.lo[i] = binStartDay(tier, c[C.bin]);
    cols.hi[i] = binEndDay(tier, c[C.bin]);
    cols.n[i] = c[C.n] | 0;
    cols.docs[i] = c[C.docs] | 0;
    cols.authors[i] = c[C.authors] | 0;
    cols.denom[i] = num(c[C.denom]);
    cols.rate[i] = num(c[C.rate]);
    cols.ciLo[i] = num(c[C.ci_lo]);
    cols.ciHi[i] = num(c[C.ci_hi]);
    cols.state[i] = c[C.state] | 0;
    cols.flags[i] = c[C.flags] | 0;
    cols.dp[i] = num(c[C.dp]);
  });
  return cols;
}

/** Theme sub-strands by tag provenance (§1.2 "Theme strands"), in drawing order, with their words. */
export const SUBSTRANDS = Object.freeze({
  documented_category: Object.freeze({ order: 0, label: 'documented category', style: 'solid' }),
  machine_tag: Object.freeze({ order: 1, label: 'machine tag — fallible', style: 'hatched' }),
  genre_heuristic: Object.freeze({ order: 2, label: 'genre heuristic', style: 'dotted' }),
});

/**
 * The drawn rows of the pinned strands. An expression is one row keyed by its id; a theme splits into up to
 * three sub-strands by tag provenance, keyed by the server as `theme:<value>@<provenance>` (the query's
 * `lanes[].strands` lists the keys that exist). Rows keep their pinned strand's glyph.
 * @param {object|null} query TimelineQuery
 * @param {Array<{type: string, id: number|string, glyph?: string}>} strands view.strands
 * @param {Map<string, string>} [labels] strand id → label
 * @returns {Array<{ref: string, type: string, id: number|string, glyph: string|undefined, pin: number, sub: string|null, label: string}>}
 */
export function strandRows(query, strands, labels = new Map()) {
  const keysInQuery = new Set();
  for (const lane of query?.lanes ?? []) for (const k of Object.keys(lane?.strands ?? {})) keysInQuery.add(k);
  const rows = [];
  strands.forEach((s, pin) => {
    const id = String(s.id);
    const base = labels.get(id) ?? (s.type === 'expression' ? `expression ${s.id}` : String(s.id));
    const keys = [...keysInQuery].filter((k) => k === id || k === `${s.type}:${id}` || k.startsWith(`${s.type}:${id}@`));
    if (!keys.length) keys.push(id);
    const subOf = (k) => (k.includes('@') ? k.slice(k.lastIndexOf('@') + 1) : null);
    keys.sort((a, b) => (SUBSTRANDS[subOf(a)]?.order ?? 9) - (SUBSTRANDS[subOf(b)]?.order ?? 9) || a.localeCompare(b));
    for (const ref of keys) {
      const sub = subOf(ref);
      rows.push({ ref, type: s.type, id: s.id, glyph: s.glyph, pin, sub, label: sub ? `${base} · ${SUBSTRANDS[sub]?.label ?? sub}` : base });
    }
  });
  return rows;
}

/**
 * Maximal runs of consecutive observed bins (§1.2 item 4).
 * @param {ReturnType<typeof buildColumns>} cols
 * @returns {Array<{start: number, end: number}>} inclusive indices into cols
 */
export function findBars(cols) {
  const bars = [];
  let start = -1;
  for (let i = 0; i < cols.length; i++) {
    const obs = cols.state[i] === STATE.observed;
    const contiguous = i > 0 && cols.bin[i] === cols.bin[i - 1] + 1;
    if (obs && start >= 0 && contiguous && cols.state[i - 1] === STATE.observed) continue;
    if (start >= 0) bars.push({ start, end: i - 1 });
    start = obs ? i : -1;
  }
  if (start >= 0) bars.push({ start, end: cols.length - 1 });
  return bars;
}

/** Merge sorted bin numbers into day runs [[loDay, hiDay, binLo, binHi]]. */
function runsOf(bins, tier) {
  const out = [];
  for (const b of bins) {
    const last = out[out.length - 1];
    if (last && last[3] === b - 1) { last[3] = b; last[1] = binEndDay(tier, b); } else out.push([binStartDay(tier, b), binEndDay(tier, b), b, b]);
  }
  return out;
}

/**
 * @typedef {Object} BuildInput
 * @property {object} query           TimelineQuery response (§7.2)
 * @property {string} tier            the tier drawn
 * @property {Map<number, object|null>} tiles  loaded tiles of this query+tier: tile → tile object, or null = loaded, no data
 * @property {[number, number]} range  [loDay, hiDay] built (≈ 3 viewport widths)
 * @property {[number, number]} [visible] [loDay, hiDay] on screen (override counting)
 * @property {Array<{type: string, id: number|string, glyph: string}>} strands  the pinned strands (view.strands)
 * @property {{items: object[], from: number, to: number, truncated: boolean}|null} [marks]
 * @property {Map<string, string>} [strandLabels] strand ref → label ('carry the zero')
 * @property {number} [laneLimit=10]
 * @property {{order: string, manual: string[]}} [lanesView]
 */

/**
 * Build the timeline model.
 * @param {BuildInput} input
 */
export function buildModel({ query, tier, tiles, range, visible = range, strands, marks = null, strandLabels = new Map(),
  laneLimit = 10, lanesView = null }) {
  const [rLo, rHi] = range;
  const [binLo, binHi] = [binOfDay(tier, rLo), binOfDay(tier, rHi)];
  const [vLo, vHi] = visible;
  const rows = strandRows(query, strands, strandLabels);
  const refs = rows.map((r) => r.ref);
  let lanes = Array.isArray(query?.lanes) ? query.lanes.filter((l) => l.key !== TRAIL_ETYMOLOGY) : [];
  if (lanesView?.order === 'manual' && lanesView.manual?.length) {
    const rank = new Map(lanesView.manual.map((k, i) => [k, i]));
    lanes = lanes.map((l, i) => [l, rank.has(l.key) ? rank.get(l.key) : 1e6 + i]).sort((a, b) => a[1] - b[1]).map(([l]) => l);
  }
  const limit = Math.max(1, laneLimit);
  const trail = lanesView?.facet === 'trail' && lanesView?.order !== 'manual';
  const shown = trail ? trailShownLanes(lanes, limit) : lanes.slice(0, limit);
  const shownKeys = new Set(shown.map((l) => l.key));
  const folded = lanes.filter((l) => !shownKeys.has(l.key));
  const shareKeys = new Set(shown.filter(isShareLane).map((l) => l.key));
  const hiddenLanes = folded.length + (query?.other?.lanes ?? 0);
  const hiddenN = folded.reduce((s, l) => s + (l.n ?? 0), 0) + (query?.other?.n ?? 0);

  const loadedTiles = [];
  const missingTiles = [];
  for (let t = Math.floor(binLo / TILE_BINS); t <= Math.floor(binHi / TILE_BINS); t++) (tiles.has(t) ? loadedTiles : missingTiles).push(t);
  const isLoaded = (bin) => tiles.has(Math.floor(bin / TILE_BINS));
  const inRange = (bin) => bin >= binLo && bin <= binHi;

  // Gather cells per lane and strand, coverage per lane, and washes (deduplicated across tiles).
  const cellsBy = new Map();
  const covBy = new Map();
  const washKeys = new Set();
  const washesBy = new Map();
  const sharesBy = new Map();   // OpenAlex cells (C3): lane\0strand → cell objects (every tile repeats the cells it overlaps)
  for (const t of loadedTiles) {
    const tile = tiles.get(t);
    if (!tile) continue;
    const bin0 = Number.isInteger(tile.bin0) ? tile.bin0 : tile.tile * TILE_BINS;
    for (const [laneKey, byRef] of shareCellsOfTile(tile)) for (const [ref, cells] of byRef) {
      const key = `${laneKey}\u0000${ref}`;
      sharesBy.set(key, [...(sharesBy.get(key) ?? []), ...cells]);
    }
    for (const [laneKey, lane] of Object.entries(tile.lanes ?? {})) {
      for (const [ref, cells] of Object.entries(lane?.strands ?? {})) {
        const key = `${laneKey}\u0000${ref}`;
        if (!cellsBy.has(key)) cellsBy.set(key, []);
        const list = cellsBy.get(key);
        for (const c of cells) {
          if (!Array.isArray(c)) continue;   // a share cell (object), gathered above
          const bin = bin0 + c[0];
          if (inRange(bin)) list.push([bin, ...c.slice(1)]);
        }
      }
    }
    for (const [laneKey, rows] of Object.entries(tile.coverage ?? {})) {
      if (!covBy.has(laneKey)) covBy.set(laneKey, new Map());
      const m = covBy.get(laneKey);
      for (const [idx, works, docs, tokens, cls] of rows) {
        const bin = bin0 + idx;
        if (inRange(bin)) m.set(bin, { works, docs, tokens, cls });
      }
    }
    for (const w of tile.washes ?? []) {
      // WP3 gives each wash a stable `key` (the same wash is listed in every tile it overlaps): prefer it (M1 gate)
      const k = typeof w.key === 'string' && w.key ? `k\u0000${w.key}` : `${w.lane}\u0000${w.strand}\u0000${w.lo}\u0000${w.hi}\u0000${w.label}`;
      if (washKeys.has(k)) continue;
      washKeys.add(k);
      const key = `${w.lane}\u0000${w.strand}`;
      if (!washesBy.has(key)) washesBy.set(key, []);
      washesBy.get(key).push(w);
    }
  }

  // Marks are used (override, exact caps) only when they reconcile with the bins they would replace.
  // Share lanes (C3) are cells, not bins: their matches are never drawn as individual marks.
  const marksCheck = reconcileMarks({ marks: marks ? { ...marks, items: marks.items?.filter((m) => !shareKeys.has(m.lane)) } : marks,
    lanes: shown.filter((l) => !isShareLane(l)), refs, cellsBy, washesBy, tier });
  const usable = marksCheck.ok ? marks : null;

  // Unit scales: the largest observed rate per unit across the shown lanes (one thickness scale per unit).
  const units = {};
  const laneModels = shown.map((lane) => {
    const unit = lane.unit;
    const share = isShareLane(lane);
    const name = laneLabelOf(lane.label, lane.key);
    const cluster = parseClusterLaneKey(lane.key);
    const cov = covBy.get(lane.key) ?? new Map();
    const pendingLane = lane.state === 'pending' || lane.status === 'pending';
    const covUnit = coverageUnitOf(unit);
    const span = Array.isArray(lane.coverage?.span) ? lane.coverage.span : null;
    const spanFirstBin = Number.isInteger(span?.[0]) ? binOfDay(tier, dayFromYMD(span[0], 1, 1)) : null;
    const spanLastBin = Number.isInteger(span?.[1]) ? binOfDay(tier, dayFromYMD(span[1], 12, 31)) : null;
    const laneFirst = parseLabel(lane.first?.label);
    const laneLast = parseLabel(lane.last?.label);

    const strandModels = rows.map((row, index) => {
      const ref = row.ref;
      const raw = (cellsBy.get(`${lane.key}\u0000${ref}`) ?? []).sort((a, b) => a[0] - b[0]);
      const cols = buildColumns(raw, tier);
      const strandMarks = usable?.items ? usable.items.filter((m) => m.lane === lane.key && String(m.strand) === ref) : null;
      // The server's per-strand first/last (lanes[].strands[key]) is exact for this row; the lane's own
      // first/last is attributable only when the lane draws a single row.
      const own = lane.strands?.[ref] ?? null;
      const first = parseLabel(own?.first?.label) ?? (rows.length === 1 ? laneFirst : null);
      const last = parseLabel(own?.last?.label) ?? (rows.length === 1 ? laneLast : null);
      const bars = findBars(cols).map(({ start, end }) => {
        const loDay = cols.lo[start], hiDay = cols.hi[end];
        let n = 0;
        for (let i = start; i <= end; i++) n += cols.n[i];
        const inBar = strandMarks?.filter((m) => m.lo_day >= loDay && m.hi_day <= hiDay) ?? [];
        const startCap = { day: loDay, exact: false, censored: false, label: `in ${binLabel(tier, cols.bin[start])}` };
        const endCap = { day: hiDay, exact: false, censored: false, label: `in ${binLabel(tier, cols.bin[end])}` };
        if (inBar.length) {
          const a = inBar.reduce((x, m) => (m.lo_day < x.lo_day ? m : x));
          const b = inBar.reduce((x, m) => (m.hi_day > x.hi_day ? m : x));
          Object.assign(startCap, { day: a.lo_day, exact: true, label: markLabel(a) });
          Object.assign(endCap, { day: b.hi_day, exact: true, label: markLabel(b) });
        } else {
          if (first && first.lo_day >= loDay && first.lo_day <= hiDay) Object.assign(startCap, { day: first.lo_day, exact: true, label: first.label });
          if (last && last.hi_day >= loDay && last.hi_day <= hiDay) Object.assign(endCap, { day: last.hi_day, exact: true, label: last.label });
        }
        // Censoring (§1.2 item 5): the run touches the lane's first/last covered bin.
        const firstInBar = first && first.lo_day >= loDay && first.lo_day <= hiDay;
        const lastInBar = last && last.hi_day >= loDay && last.hi_day <= hiDay;
        startCap.censored = (spanFirstBin !== null && cols.bin[start] === spanFirstBin) || Boolean(rows.length === 1 && firstInBar && lane.censor?.left);
        endCap.censored = (spanLastBin !== null && cols.bin[end] === spanLastBin) || Boolean(rows.length === 1 && lastInBar && lane.censor?.right);
        return { start, end, loDay, hiDay, n, bins: end - start + 1, startCap, endCap };
      });
      for (let i = 0; i < cols.length; i++) {
        if (cols.state[i] !== STATE.observed || !Number.isFinite(cols.rate[i])) continue;
        units[unit] ??= { unit, max: 0, lanes: new Set() };
        units[unit].max = Math.max(units[unit].max, cols.rate[i]);
        units[unit].lanes.add(lane.key);
      }
      const washes = (washesBy.get(`${lane.key}\u0000${ref}`) ?? []).map((w) => {
        const a = parseLabel(w.lo), b = parseLabel(w.hi);
        const lp = parseLabel(w.label);
        return a && b ? {
          loDay: a.lo_day, hiDay: b.hi_day, n: w.n, label: w.label, precision: w.precision,
          circa: (lp?.rule === 'circa') || /^c\.\s/.test(w.label ?? ''), synthetic: Boolean(w.synthetic ?? lane.synthetic),
        } : null;
      }).filter((w) => w && w.hiDay >= rLo && w.loDay <= rHi);
      let binN = 0, observedBins = 0;
      for (let i = 0; i < cols.length; i++) { binN += cols.n[i]; if (cols.state[i] === STATE.observed) observedBins++; }
      const shareCols = share ? shareColumns(sharesBy.get(`${lane.key}\u0000${ref}`) ?? []) : null;
      return {
        ref, type: row.type, id: row.id, glyph: row.glyph, index, pin: row.pin, sub: row.sub, label: row.label,
        cols, bars: share && shareCols.length ? [] : bars, washes, marks: share ? null : strandMarks, share: shareCols,
        totals: { binN, washN: washes.reduce((x, w) => x + w.n, 0), observedBins },
      };
    });

    // Lane underlay: covered bins (with their step class), uncovered runs, pending runs, unloaded runs.
    // A lane with any pending cell is still indexing: its bins without cells are pending, not "no sources".
    const coveredBins = new Set();
    for (const [bin, c] of cov) if ((covUnit === 'works' ? c.works : c.tokens) > 0) coveredBins.add(bin);
    // A share lane is covered wherever one of OpenAlex's cells holds sampled works (its cells do not follow our bins).
    if (share) {
      for (const [lo, hi] of shareCoveredDays(strandModels.map((sm) => sm.share).filter(Boolean))) {
        for (let b = Math.max(binLo, binOfDay(tier, lo)); b <= Math.min(binHi, binOfDay(tier, hi)); b++) coveredBins.add(b);
      }
    }
    const pendingBins = new Set();
    for (const sm of strandModels) for (let i = 0; i < sm.cols.length; i++) {
      if (sm.cols.state[i] === STATE.pending) pendingBins.add(sm.cols.bin[i]);
      else if (sm.cols.denom[i] > 0 || sm.cols.n[i] > 0) coveredBins.add(sm.cols.bin[i]);
    }
    const indexing = pendingLane || pendingBins.size > 0;
    const uncovered = [], pending = [], unloaded = [];
    for (let b = binLo; b <= binHi; b++) {
      if (!isLoaded(b)) unloaded.push(b);
      else if (pendingBins.has(b)) pending.push(b);
      else if (coveredBins.has(b)) continue;
      else if (indexing) pending.push(b);
      else uncovered.push(b);
    }
    const coverage = [...cov.entries()].filter(([bin]) => coveredBins.has(bin)).sort((a, b) => a[0] - b[0]).map(([bin, c]) => ({
      bin, loDay: binStartDay(tier, bin), hiDay: binEndDay(tier, bin), tokens: c.tokens, works: c.works, docs: c.docs,
      cls: Number.isInteger(c.cls) ? c.cls : stepClass(covUnit === 'works' ? c.works : c.tokens, covUnit),
    }));
    return {
      key: lane.key, label: name.text, machineLabel: name.machine, humanLabel: name.human, cluster, residual: Boolean(cluster?.residual),
      ord: Number.isInteger(lane.ord) ? lane.ord : cluster?.group ?? null, clusterId: Number.isInteger(lane.cluster_id) ? lane.cluster_id : null,
      stability: Number.isFinite(lane.stability) ? lane.stability : null, tentative: Boolean(lane.tentative), share, trail: lane.key.startsWith('trail:'),
      unit, modality: lane.modality, header: lane.header ?? null, note: lane.note ?? lane.rate_note ?? null,
      selection: lane.selection ?? null, pending: indexing, censor: lane.censor ?? { left: false, right: false },
      first: lane.first ?? null, last: lane.last ?? null, n: lane.n ?? 0, docs: lane.docs ?? 0,
      undated: lane.undated ?? 0, scheduled: lane.scheduled ?? 0, undatedShare: lane.undated_share ?? 0,
      laneCoverage: lane.coverage ?? null, synthetic: Boolean(lane.synthetic), covUnit,
      coverage, uncovered: runsOf(uncovered, tier), pendingRuns: runsOf(pending, tier), unloaded: runsOf(unloaded, tier),
      strands: strandModels,
    };
  });
  // One height scale per unit (§1.2 item 6): the share lanes' scale is the largest upper bound of any shown cell.
  const shareLanes = laneModels.filter((l) => l.share);
  if (shareLanes.length) {
    const max = shareScaleMax(shareLanes.flatMap((l) => l.strands.map((sm) => sm.share).filter(Boolean)));
    if (max > 0) units[SHARE_UNIT] = { unit: SHARE_UNIT, max, lanes: new Set(shareLanes.map((l) => l.key)) };
  }
  for (const u of Object.values(units)) u.lanes = [...u.lanes];

  // Dated matches in view (bins + washes) decide the occurrence override (§1.6).
  let visibleN = 0, rangeN = 0;
  for (const lm of laneModels) for (const sm of lm.strands) {
    if (lm.share && sm.share?.length) continue;
    for (let i = 0; i < sm.cols.length; i++) {
      rangeN += sm.cols.n[i];
      if (sm.cols.hi[i] >= vLo && sm.cols.lo[i] <= vHi) visibleN += sm.cols.n[i];
    }
    for (const w of sm.washes) { rangeN += w.n; if (w.hiDay >= vLo && w.loDay <= vHi) visibleN += w.n; }
  }
  const wantMarks = strands.length > 0 && visibleN > 0 && visibleN <= MAX_MARKS && missingTiles.length === 0;
  const marksCover = Boolean(usable && usable.fromDay <= vLo && usable.toDay >= vHi);
  const override = wantMarks && marksCover;

  return {
    tier, range, visible, lanes: laneModels, hiddenLanes, hiddenN, units, visibleN, rangeN, wantMarks, override, marksCheck,
    loadedTiles, missingTiles, complete: missingTiles.length === 0,
    coverageTrack: coverageTrack(laneModels),
    strands: rows.map((r) => ({ ref: r.ref, type: r.type, id: r.id, glyph: r.glyph, pin: r.pin, sub: r.sub, label: r.label })),
    rowCount: rows.length,
    etymLane: (query?.lanes ?? []).find((l) => l.key === TRAIL_ETYMOLOGY) ?? null,
  };
}

/**
 * Do the loaded marks account for exactly the matches the bins of their range hold (conservation, §1.7)?
 * Marks inside [fromDay, toDay] must number at least the bins' n inside that range and at most that plus
 * the washes touching it. A truncated or non-reconciling marks list is never drawn in place of bars.
 * @returns {{ok: boolean, marks: number, bins: number, washes: number, reason: string|null}}
 */
export function reconcileMarks({ marks, lanes, refs, cellsBy, washesBy, tier }) {
  if (!marks?.items) return { ok: false, marks: 0, bins: 0, washes: 0, reason: 'no marks loaded' };
  const { fromDay, toDay } = marks;
  const laneKeys = new Set(lanes.map((l) => l.key));
  const refSet = new Set(refs);
  let bins = 0, washes = 0;
  for (const l of lanes) for (const ref of refs) {
    for (const c of cellsBy.get(`${l.key}\u0000${ref}`) ?? []) {
      if (binStartDay(tier, c[0]) >= fromDay && binEndDay(tier, c[0]) <= toDay) bins += c[C.n] | 0;
    }
    for (const w of washesBy.get(`${l.key}\u0000${ref}`) ?? []) {
      const a = parseLabel(w.lo), b = parseLabel(w.hi);
      if (a && b && b.hi_day >= fromDay && a.lo_day <= toDay) washes += w.n | 0;
    }
  }
  const count = marks.items.filter((m) => laneKeys.has(m.lane) && refSet.has(String(m.strand))
    && m.hi_day >= fromDay && m.lo_day <= toDay).length;
  if (marks.truncated) return { ok: false, marks: count, bins, washes, reason: 'marks truncated' };
  const ok = count >= bins && count <= bins + washes;
  return { ok, marks: count, bins, washes, reason: ok ? null : `marks (${count}) do not reconcile with bins (${bins}) and washes (${washes})` };
}

/**
 * Bar summary of §1.2 item 9, generated from the same numbers as the drawing: "carry the zero · Hip-hop ·
 * first observed 1994 · last observed 2024 · observed in 4 of 5 covered decades · 1 gap · 110 matches
 * (2 in washes, 1 undated) · per million tokens over 18.4k tokens · SYNTHETIC".
 * @param {object} laneModel
 * @param {object} strandModel
 * @param {{tier: string, formatTokens: (n: number) => string, unitLabel: (u: string) => string}} fmt
 * @returns {string}
 */
export function strandSummary(laneModel, strandModel, { tier, formatTokens, unitLabel }) {
  const { cols, bars, washes } = strandModel;
  let covered = 0;
  for (let i = 0; i < cols.length; i++) if (cols.state[i] !== STATE.pending && (cols.denom[i] > 0 || cols.n[i] > 0)) covered++;
  const binWord = { L0: 'millennia', L1: 'centuries', L2: 'decades', L3: 'years', L4: 'months', L5: 'days' }[tier];
  const parts = [strandModel.label, laneModel.label];
  if (strandModel.ref && bars.length) {
    const a = bars[0].startCap, b = bars[bars.length - 1].endCap;
    parts.push(`first observed ${a.label ?? '—'}`);
    parts.push(`last observed ${b.label ?? '—'}`);
  } else parts.push('no observed bins in this range');
  parts.push(`observed in ${strandModel.totals.observedBins} of ${covered} covered ${binWord}`);
  const gaps = Math.max(0, bars.length - 1);
  parts.push(`${gaps} ${gaps === 1 ? 'gap' : 'gaps'}`);
  const washN = washes.reduce((s, w) => s + w.n, 0);
  const extra = [`${washN} in washes`];
  if (laneModel.undated) extra.push(`${laneModel.undated} undated`);
  parts.push(`${strandModel.totals.binN + washN} matches in range (${extra.join(', ')})`);
  const cov = laneModel.laneCoverage;
  const amount = laneModel.covUnit === 'works' ? cov?.works : cov?.tokens;
  parts.push(`${unitLabel(laneModel.unit)} over ${formatTokens(amount)} ${laneModel.covUnit}`);
  if (laneModel.synthetic) parts.push('SYNTHETIC');
  return parts.join(' · ');
}

/**
 * The Scroll before any strand is pinned: one lane per collection of the corpus, showing only what the
 * corpus listing states — the span of its dated documents, its size and its selection note. Nothing is
 * counted, so nothing is drawn as observed, absent or uncovered inside the span (§1.7 coverage, §8.8).
 * @param {Array<{slug: string, name: string, modality: string, unit: string, docs: number, tokens: number, works: number,
 *   undated: number, scheduled: number, span: [string, string]|null, selection_note?: string, sampling?: string,
 *   status?: string}>} collections GET /api/corpora collections of one corpus
 * @param {{synthetic?: boolean, tier?: string}} [opts]
 */
export function buildCoverageModel(collections, { synthetic = false, tier = 'L2' } = {}) {
  const lanes = (collections ?? []).map((c) => {
    const lo = parseLabel(c.span?.[0]), hi = parseLabel(c.span?.[1]);
    const works = c.unit === 'works';
    const amount = works ? `${formatTokens(c.works)} works` : `${formatTokens(c.tokens)} tokens`;
    const spanText = c.span ? `${c.span[0]}–${c.span[1]}` : 'no dated documents';
    return {
      key: `coll:${c.slug}`, label: c.name, unit: works ? 'per_thousand_works' : 'per_million_tokens', modality: c.modality,
      header: `${c.name} · ${c.modality} · ${amount}, ${spanText}`, note: null, selection: c.selection_note ?? null,
      pending: c.status === 'pending' || c.status === 'indexing', censor: { left: false, right: false }, first: null, last: null,
      n: 0, docs: c.docs ?? 0, undated: c.undated ?? 0, scheduled: c.scheduled ?? 0, undatedShare: 0,
      laneCoverage: { tokens: c.tokens, works: c.works, docs: c.docs, span: [lo ? lo.lo_year : null, hi ? hi.hi_year : null] },
      synthetic, covUnit: works ? 'works' : 'tokens', coverage: [], uncovered: [], pendingRuns: [], unloaded: [], strands: [],
      coverageOnly: true, span: lo && hi ? { loDay: lo.lo_day, hiDay: hi.hi_day, label: spanText } : null, amount,
    };
  });
  return {
    tier, range: null, visible: null, lanes, hiddenLanes: 0, hiddenN: 0, units: {}, visibleN: 0, rangeN: 0, wantMarks: false,
    override: false, marksCheck: null, loadedTiles: [], missingTiles: [], complete: true, coverageTrack: [], strands: [], rowCount: 0,
    coverageOnly: true,
  };
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
