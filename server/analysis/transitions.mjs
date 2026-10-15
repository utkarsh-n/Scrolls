// OWNER: WP4
// transitions.mjs — time windows, context-group shares and the computed transitions between windows
// (SPEC §4.8, §1.8), plus readers of stored clustering runs.
//
// Windows: decades from the first to the last decade holding a dated occurrence. A decade with no coverage
// (no tokens of the expression's collections and languages) is an `uncovered` window and is never merged
// across; inside a covered stretch decades are merged forward until each window holds ≥ 30 occurrences
// (a remainder joins the previous window of its stretch; a stretch that never reaches 30 stays one `thin`
// window whose shares are not estimated). An occurrence counts in a window only when its document's whole
// date interval fits it; otherwise it is excluded as "date too coarse" and counted (§13 rule 4).
// Shares carry a document-block bootstrap 95% CI (1,000 resamples).
// Transitions (all computed, drawn dashed): emerge = first window with share ≥ 10% and n ≥ 5 (a group already
// there in the first measured window is present from the start of the record, not an emergence); split = the
// group emerges while its nearest older group (global centroid cosine ≥ 0.5) is present (share ≥ 2%);
// vanish = share < 2% in 2 measured windows after being present; an uncovered window after a present group
// → unknown_gap; merge = the per-window centroids of two groups move from cosine < 0.5 to ≥ 0.7.

import { mulberry32 } from '../../src/shared/ids.mjs';
import { yearLabel } from '../../src/shared/dates.mjs';
import { denseCos } from './kmeans.mjs';

/** §4.8 window and transition rules. */
export const WINDOW_RULE = Object.freeze({ width: 10, minN: 30, emergeShare: 0.10, emergeN: 5, presentShare: 0.02, vanishShare: 0.02,
  vanishWindows: 2, splitCos: 0.5, mergeFrom: 0.5, mergeTo: 0.7, mergeMinMembers: 5, resamples: 1000 });

/** The sentence every split carries (§1.8). */
export const SPLIT_CAVEAT = 'Computed: a split in usage contexts, not a claim about speakers.';
/** The sentence every merge carries. */
export const MERGE_CAVEAT = 'Computed: a merge of usage contexts, not a claim about speakers.';

const decadeOf = (y) => Math.floor(y / 10) * 10;
const fmt = (x, d = 2) => Number(x.toFixed(d));

/**
 * A window's label: "1990–1999" (historical BCE labels, astronomical years inside).
 * @param {number} lo
 * @param {number} hi
 * @returns {string}
 */
export function windowLabel(lo, hi) {
  return lo === hi ? yearLabel(lo) : `${yearLabel(lo)}–${yearLabel(hi)}`;
}

/**
 * Decade cells from the first to the last decade holding a dated item.
 * @param {Array<{y_lo: number, y_hi: number}>} items dated items
 * @param {(lo: number, hi: number) => number} coverage tokens covered in [lo, hi] (0 = uncovered)
 * @returns {Array<{lo: number, hi: number, n: number, tokens: number, covered: boolean}>}
 */
export function decadeCells(items, coverage) {
  if (!items.length) return [];
  let first = Infinity, last = -Infinity;
  for (const it of items) { first = Math.min(first, decadeOf(it.y_lo)); last = Math.max(last, decadeOf(it.y_hi)); }
  const cells = [];
  const at = new Map();
  for (let d = first; d <= last; d += 10) {
    const tokens = coverage(d, d + 9);
    at.set(d, cells.length);
    cells.push({ lo: d, hi: d + 9, n: 0, tokens, covered: tokens > 0 });
  }
  for (const it of items) {
    if (decadeOf(it.y_lo) !== decadeOf(it.y_hi)) continue;
    const c = cells[at.get(decadeOf(it.y_lo))];
    c.n++;
    if (!c.covered) { c.covered = true; } // an occurrence is coverage, whatever the token table says
  }
  return cells;
}

/**
 * Windows from decade cells (see the header).
 * @param {Array<{lo: number, hi: number, n: number, tokens?: number, covered: boolean}>} cells contiguous, ascending
 * @param {{minN?: number}} [opts]
 * @returns {Array<{lo: number, hi: number, n: number, tokens: number, state: 'measured'|'thin'|'uncovered',
 *   scheme: 'fixed'|'merged_for_min_n', label: string}>} n here counts decade-fitting items (see assignWindows)
 */
export function buildWindows(cells, { minN = WINDOW_RULE.minN } = {}) {
  const out = [];
  const close = (w, state) => out.push({ lo: w.lo, hi: w.hi, n: w.n, tokens: w.tokens, state,
    scheme: w.parts > 1 ? 'merged_for_min_n' : 'fixed', label: windowLabel(w.lo, w.hi) });
  let i = 0;
  while (i < cells.length) {
    if (!cells[i].covered) {
      const w = { lo: cells[i].lo, hi: cells[i].hi, n: 0, tokens: 0, parts: 0 };
      while (i < cells.length && !cells[i].covered) { w.hi = cells[i].hi; w.parts++; i++; }
      out.push({ lo: w.lo, hi: w.hi, n: 0, tokens: 0, state: 'uncovered', scheme: w.parts > 1 ? 'merged_for_min_n' : 'fixed',
        label: windowLabel(w.lo, w.hi) });
      continue;
    }
    const stretch = [];
    while (i < cells.length && cells[i].covered) stretch.push(cells[i++]);
    const made = [];
    let cur = null;
    for (const c of stretch) {
      cur = cur ? { lo: cur.lo, hi: c.hi, n: cur.n + c.n, tokens: cur.tokens + (c.tokens ?? 0), parts: cur.parts + 1 }
        : { lo: c.lo, hi: c.hi, n: c.n, tokens: c.tokens ?? 0, parts: 1 };
      if (cur.n >= minN) { made.push(cur); cur = null; }
    }
    if (cur) {
      if (made.length) {
        const last = made[made.length - 1];
        Object.assign(last, { hi: cur.hi, n: last.n + cur.n, tokens: last.tokens + cur.tokens, parts: last.parts + cur.parts });
      } else made.push(cur);
    }
    for (const w of made) close(w, w.n >= minN ? 'measured' : 'thin');
  }
  return out;
}

/**
 * The window each item falls in: the one its whole interval fits; -1 = date too coarse (or undated).
 * @param {Array<{y_lo: number|null, y_hi: number|null}>} items
 * @param {Array<{lo: number, hi: number}>} windows
 * @returns {Int32Array}
 */
export function assignWindows(items, windows) {
  const out = new Int32Array(items.length).fill(-1);
  items.forEach((it, i) => {
    if (it.y_lo === null || it.y_lo === undefined || it.y_hi === null || it.y_hi === undefined) return;
    const w = windows.findIndex((x) => it.y_lo >= x.lo && it.y_hi <= x.hi);
    out[i] = w;
  });
  return out;
}

/**
 * Percentile of sorted values with linear interpolation.
 * @param {Float64Array|number[]} sorted ascending
 * @param {number} p 0–1
 * @returns {number}
 */
export function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

/**
 * Shares of each group per measured window with a document-block bootstrap 95% CI.
 * @param {Array<{window: number, cluster: number, doc: number}>} items placed items (window ≥ 0)
 * @param {Array<{state: string}>} windows
 * @param {number} k
 * @param {{resamples?: number, seed?: number}} [opts]
 * @returns {Array<{window: number, n: number, clusters: Array<{cluster: number, n: number, share: number, ci: [number, number]}>}>}
 *   one entry per measured window
 */
export function windowShares(items, windows, k, { resamples = WINDOW_RULE.resamples, seed = 42 } = {}) {
  const rng = mulberry32(seed);
  const out = [];
  windows.forEach((w, wi) => {
    if (w.state !== 'measured') return;
    const byDoc = new Map();
    for (const it of items) {
      if (it.window !== wi) continue;
      let v = byDoc.get(it.doc);
      if (!v) { v = new Int32Array(k); byDoc.set(it.doc, v); }
      v[it.cluster]++;
    }
    const docs = [...byDoc.values()];
    const counts = new Int32Array(k);
    for (const v of docs) for (let c = 0; c < k; c++) counts[c] += v[c];
    const n = counts.reduce((x, y) => x + y, 0);
    if (!n) return;
    const draws = Array.from({ length: k }, () => new Float64Array(resamples));
    const tot = new Float64Array(k);
    for (let r = 0; r < resamples; r++) {
      tot.fill(0);
      let all = 0;
      for (let d = 0; d < docs.length; d++) {
        const v = docs[Math.floor(rng() * docs.length)];
        for (let c = 0; c < k; c++) { tot[c] += v[c]; all += v[c]; }
      }
      for (let c = 0; c < k; c++) draws[c][r] = all ? tot[c] / all : 0;
    }
    const clusters = [];
    for (let c = 0; c < k; c++) {
      const s = draws[c].sort();
      clusters.push({ cluster: c, n: counts[c], share: counts[c] / n, ci: [quantile(s, 0.025), quantile(s, 0.975)] });
    }
    out.push({ window: wi, n, clusters });
  });
  return out;
}

/**
 * Computed transitions (see the header). Clusters are indexes 0…k−1; residual groups take no part.
 * @param {{windows: Array<{state: string, label: string, lo: number, hi: number}>,
 *   shares: ReturnType<typeof windowShares>, centroids: Float64Array[], windowCentroids: Array<Array<{vec: Float64Array|null, n: number}>>,
 *   residual?: boolean[], firstYear?: (cluster: number, window: number) => number|null}} input
 * @returns {Array<{kind: string, from: number|null, to: number|null, window: number, score: number|null, nearest?: object,
 *   year: number|null, detail?: object}>}
 */
export function detectTransitions({ windows, shares, centroids, windowCentroids, residual = [], firstYear = () => null }) {
  const R = WINDOW_RULE;
  const k = centroids.length;
  const live = [...Array(k).keys()].filter((c) => !residual[c]);
  const shareAt = new Map(shares.map((s) => [s.window, s]));
  const measured = shares.map((s) => s.window).sort((a, b) => a - b);
  const firstMeasured = measured.length ? measured[0] : null;
  const share = (c, w) => shareAt.get(w)?.clusters[c] ?? null;
  const out = [];

  // emergence (or split)
  const emergedAt = new Map();
  for (const c of live) {
    const w = measured.find((wi) => { const s = share(c, wi); return s && s.share >= R.emergeShare && s.n >= R.emergeN; });
    if (w !== undefined) emergedAt.set(c, w);
  }
  for (const c of live) {
    const w = emergedAt.get(c);
    if (w === undefined || w === firstMeasured) continue;
    const older = live.filter((o) => o !== c && emergedAt.has(o) && emergedAt.get(o) < w);
    let nearest = null;
    for (const o of older) {
      const cos = denseCos(centroids[c], centroids[o]);
      if (!nearest || cos > nearest.cosine) nearest = { cluster: o, cosine: fmt(cos) };
    }
    const nearPresent = nearest && (share(nearest.cluster, w)?.share ?? 0) >= R.presentShare;
    const isSplit = nearest && nearest.cosine >= R.splitCos && nearPresent;
    out.push({ kind: isSplit ? 'split' : 'emerge', from: isSplit ? nearest.cluster : null, to: c, window: w,
      score: isSplit ? nearest.cosine : fmt(share(c, w).share, 3), nearest, year: firstYear(c, w) });
  }

  // vanish and unknown gaps
  for (const c of live) {
    let present = false, absent = 0, firstAbsent = null;
    for (let wi = 0; wi < windows.length; wi++) {
      const st = windows[wi].state;
      if (st === 'uncovered') {
        if (present && absent === 0) out.push({ kind: 'unknown_gap', from: c, to: null, window: wi, score: null, year: null });
        continue;
      }
      if (st !== 'measured') continue;
      const s = share(c, wi)?.share ?? 0;
      if (s >= R.presentShare) { present = true; absent = 0; firstAbsent = null; continue; }
      if (!present) continue;
      absent++;
      if (firstAbsent === null) firstAbsent = wi;
      if (absent >= R.vanishWindows) {
        out.push({ kind: 'vanish', from: c, to: null, window: firstAbsent, score: fmt(share(c, firstAbsent)?.share ?? 0, 3), year: null });
        break;
      }
    }
  }

  // merges of per-window centroids
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const ca = live[a], cb = live[b];
      let apart = null;
      for (const wi of measured) {
        const pa = windowCentroids[wi]?.[ca], pb = windowCentroids[wi]?.[cb];
        if (!pa?.vec || !pb?.vec || pa.n < R.mergeMinMembers || pb.n < R.mergeMinMembers) continue;
        const cos = denseCos(pa.vec, pb.vec);
        if (apart === null && cos < R.mergeFrom) { apart = { window: wi, cosine: fmt(cos) }; continue; }
        if (apart !== null && cos >= R.mergeTo) {
          out.push({ kind: 'merge', from: ca, to: cb, window: wi, score: fmt(cos), year: null, detail: { apart } });
          break;
        }
      }
    }
  }
  const order = { emerge: 0, split: 0, merge: 1, unknown_gap: 2, vanish: 3 };
  return out.sort((x, y) => x.window - y.window || order[x.kind] - order[y.kind] || (x.to ?? x.from) - (y.to ?? y.from));
}

/**
 * The sentence a transition is shown with (no mental-state verbs; computed, not claimed).
 * @param {{kind: string, from: number|null, to: number|null, score: number|null, nearest?: object, year?: number|null,
 *   detail?: object}} t with from/to as display numbers
 * @param {{window: string, labelOf: (c: number) => string, run?: number, k?: number, stabilityOf?: (c: number) => number|null,
 *   representation?: string, windowOf?: (i: number) => string}} ctx
 * @returns {string}
 */
export function transitionText(t, ctx) {
  const terms = (c) => `'${ctx.labelOf(c)}'`;
  const first = t.year !== null && t.year !== undefined ? ` (first observed ${yearLabel(t.year)})` : '';
  const runBits = () => {
    const bits = [];
    if (ctx.run) bits.push(`Run #${ctx.run}`);
    if (ctx.k) bits.push(`k=${ctx.k}`);
    const st = t.to !== null ? ctx.stabilityOf?.(t.to) : null;
    if (st !== null && st !== undefined) bits.push(`stability ${st.toFixed(2)}`);
    if (ctx.representation) bits.push(`representation ${ctx.representation}`);
    return bits.length ? ` ${bits.join(', ')}.` : '';
  };
  switch (t.kind) {
    case 'split':
      return `Context group ${t.to} ${terms(t.to)} emerges in ${ctx.window}${first}. Nearest earlier group: ${t.from} (centroid cosine ${t.score}).${runBits()} ${SPLIT_CAVEAT}`;
    case 'emerge': {
      const near = t.nearest ? ` Nearest earlier group: ${t.nearest.display ?? t.nearest.cluster} (centroid cosine ${t.nearest.cosine}; a split needs ≥ ${WINDOW_RULE.splitCos}).` : '';
      return `Context group ${t.to} ${terms(t.to)} emerges in ${ctx.window}${first}.${near}${runBits()} Computed from usage contexts.`;
    }
    case 'vanish':
      return `Context group ${t.from} ${terms(t.from)} falls below 2% of uses in ${ctx.window} and the next measured window. Computed: absence from this corpus, not from the language.`;
    case 'unknown_gap':
      return `No sources in ${ctx.window}: whether context group ${t.from} ${terms(t.from)} continued through it is unknown.`;
    case 'merge':
      return `Context groups ${t.from} and ${t.to}: their contexts move from centroid cosine ${t.detail?.apart?.cosine} (${ctx.windowOf?.(t.detail?.apart?.window) ?? 'earlier'}) to ${t.score} in ${ctx.window}. ${MERGE_CAVEAT}`;
    default:
      return '';
  }
}

// ── Stored runs ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The newest succeeded clustering run of an expression (visibility rule: succeeded only).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} exprId
 * @returns {object|null} analysis_run row
 */
export function latestClusterRun(db, exprId) {
  return db.prepare(`SELECT * FROM analysis_run WHERE stage = 'cluster' AND status = 'succeeded'
    AND json_extract(scope_json, '$.expression') = ? ORDER BY id DESC LIMIT 1`).get(exprId) ?? null;
}

/**
 * Everything a succeeded clustering run stored: its groups, windows, shares, transitions and convergence
 * evaluations (drift_result rows with metric 'convergence').
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} runId
 * @returns {{run: object, clusters: object[], windows: object[], shares: object[], transitions: object[], convergence: object[]}|null}
 */
export function readClusterRun(db, runId) {
  const run = db.prepare(`SELECT * FROM analysis_run WHERE id = ? AND stage = 'cluster'`).get(runId);
  if (!run) return null;
  const clusters = db.prepare('SELECT * FROM sense_cluster WHERE run_id = ? ORDER BY ord').all(runId);
  const windows = db.prepare('SELECT * FROM time_window WHERE run_id = ? ORDER BY lo_year').all(runId);
  const shares = db.prepare(`SELECT s.* FROM cluster_share s JOIN sense_cluster c ON c.id = s.cluster_id WHERE c.run_id = ?
    ORDER BY s.window_id, c.ord`).all(runId);
  const transitions = db.prepare('SELECT * FROM cluster_transition WHERE run_id = ? ORDER BY window_id, id').all(runId);
  const convergence = db.prepare(`SELECT * FROM drift_result WHERE run_id = ? AND metric = 'convergence' ORDER BY id`).all(runId);
  return { run, clusters, windows, shares, transitions, convergence };
}

/**
 * Occurrence → context group of a succeeded run (for lanes, Compare and the constellation).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} runId
 * @returns {Map<number, {cluster: number, cos: number, margin: number}>}
 */
export function occurrenceClusters(db, runId) {
  const out = new Map();
  for (const r of db.prepare(`SELECT m.occurrence_id AS occ, m.cluster_id AS cluster, m.cos, m.margin FROM cluster_member m
    JOIN sense_cluster c ON c.id = m.cluster_id JOIN analysis_run r ON r.id = c.run_id
    WHERE c.run_id = ? AND r.status = 'succeeded'`).iterate(runId)) out.set(r.occ, { cluster: r.cluster, cos: r.cos, margin: r.margin });
  return out;
}
