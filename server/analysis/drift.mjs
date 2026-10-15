// OWNER: WP4
// drift.mjs — the three named drift measures (SPEC §4.9), never a "meaning score":
//   (a) context-share shift: JSD (base 2) between two slices' context-group share distributions, with a
//       document-block bootstrap 95% CI (1,000 resamples);
//   (b) neighbour overlap: 1 − Jaccard of the word's top-25 neighbours in the two slice spaces (no alignment);
//   (c) aligned displacement: 1 − cos(W_A[x], R·W_B[x]) after orthogonal Procrustes;
// (b) and (c) are placed among 500 frequency-matched control words (same frequency decile in both slices,
// the 100 most frequent words excluded) as a percentile. The verdict is "notable" only when (c)'s percentile
// reaches the multiplicity-adjusted threshold and the neighbour Jaccard is ≤ 0.2; otherwise "within typical
// variation". The UI says "estimated shift in usage contexts"; a gated measure has no value (§13 rule 7).
//
// Also here: era slices (§4.8 — which slices of a language could hold a space) and reading stored results.

import { createHash } from 'node:crypto';
import { canonicalJson, mulberry32 } from '../../src/shared/ids.mjs';
import { formatCount, formatTokens } from '../../src/shared/format.mjs';
import { inputFingerprint } from '../jobs/context.mjs';
import { percentileOf, twoSampleBootstrap } from './bootstrap.mjs';
import { gated, rangeLabel, THRESHOLDS, tokensHave } from './gates.mjs';
import { humanLabels } from './labels.mjs';
import { notableThreshold } from './multiplicity.mjs';
import { alignSpaces, ANCHORS, chooseAnchors, displacement } from './procrustes.mjs';

/** Pipeline version of drift runs. */
export const DRIFT_VERSION = 'drift@1.0.0';
/** Preferred era boundaries (§4.8): a slice ends the year before one. */
export const ERA_BOUNDARIES = Object.freeze([1800, 1850, 1875, 1900, 1929]);
/** What an era slice (or any slice space) needs, translations removed (§4.8). */
export const SLICE_GATE = Object.freeze({ tokens: 3_000_000, docs: 10, authors: 5 });
/** Neighbours compared by (b), neighbours excluded from anchors by (c), controls and stop-words (§4.9). */
export const DRIFT_PARAMS = Object.freeze({ neighbours: 25, controls: 500, stopTop: 100, overlapNotable: 0.2, folds: 5, seed: 42 });
/** The words §2.E and honesty rule 11 require. */
export const SHIFT_WORDS = 'estimated shift in usage contexts';

const r2 = (x) => (x === null || x === undefined ? null : Number(x.toFixed(2)));
const r4 = (x) => (x === null || x === undefined ? null : Number(x.toFixed(4)));

// ── Era slices ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Contiguous era slices, built greedily from the earliest year: the first preferred boundary (or, at the
 * end, the last dated year) at which the slice so far holds ≥ 3M tokens, ≥ 10 documents and ≥ 5 authors
 * becomes its end. Documents count only when their whole interval fits (fit-or-wash). A remainder that
 * never reaches the gate is listed as not eligible with what it has.
 * @param {Array<{y_lo: number, y_hi: number, tokens: number, author: string|null}>} docs dated, translations removed
 * @param {{gate?: {tokens: number, docs: number, authors: number}, boundaries?: number[]}} [opts]
 * @returns {{slices: Array<{years: [number, number], tokens: number, docs: number, authors: number, eligible: boolean}>,
 *   eligible: number, span: [number, number]|null}}
 */
export function eraSlices(docs, { gate = SLICE_GATE, boundaries = ERA_BOUNDARIES } = {}) {
  if (!docs.length) return { slices: [], eligible: 0, span: null };
  let minY = Infinity, maxY = -Infinity;
  for (const d of docs) { minY = Math.min(minY, d.y_lo); maxY = Math.max(maxY, d.y_hi); }
  const cuts = [...boundaries.filter((b) => b > minY && b <= maxY), maxY + 1];
  const stats = (lo, hi) => {
    let tokens = 0, n = 0;
    const authors = new Set();
    for (const d of docs) {
      if (d.y_lo < lo || d.y_hi > hi) continue;
      tokens += d.tokens;
      n++;
      if (d.author) authors.add(d.author);
    }
    return { tokens, docs: n, authors: authors.size };
  };
  const slices = [];
  let start = minY;
  for (const b of cuts) {
    if (b <= start) continue;
    const s = stats(start, b - 1);
    if (s.tokens >= gate.tokens && s.docs >= gate.docs && s.authors >= gate.authors) {
      slices.push({ years: [start, b - 1], ...s, eligible: true });
      start = b;
    }
  }
  if (start <= maxY) slices.push({ years: [start, maxY], ...stats(start, maxY), eligible: false });
  return { slices, eligible: slices.filter((s) => s.eligible).length, span: [minY, maxY] };
}

/**
 * The documents era slices are computed from: running text of one language (doc_tokens of the text and
 * abstract classes), dated, not translations, not duplicates, in the given collections.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{lang: string, collections?: number[]|null}} sel
 * @returns {Array<{id: number, y_lo: number, y_hi: number, tokens: number, author: string|null}>}
 */
export function eraDocuments(db, { lang, collections = null }) {
  return db.prepare(`SELECT d.id, d.y_lo, d.y_hi, d.author, SUM(t.tokens) AS tokens
    FROM doc_tokens t JOIN document d ON d.id = t.document_id
    WHERE t.plang = ? AND t.field_class IN ('text', 'abstract') AND d.deleted_at IS NULL AND d.is_translation = 0 AND d.dup_of IS NULL
      AND d.chrono_status = 'dated' AND (? IS NULL OR d.collection_id IN (SELECT value FROM json_each(?)))
    GROUP BY d.id ORDER BY d.id`).all(lang, collections ? 1 : null, JSON.stringify(collections ?? []));
}

const LANGUAGE_NAMES = { en: 'English', fr: 'French', es: 'Spanish', de: 'German', hi: 'Hindi', gu: 'Gujarati', la: 'Latin', it: 'Italian', pt: 'Portuguese' };
/** 'Spanish', or the code. */
export const languageName = (lang) => LANGUAGE_NAMES[String(lang).split('-')[0]] ?? lang;

/**
 * The §4.8 sentence for a language with fewer than two eligible era slices, e.g. "Aligned displacement
 * unavailable for Spanish: one eligible slice (1825–1874 has 2.95M tokens; needs 3M)".
 * @param {string} lang
 * @param {ReturnType<typeof eraSlices>} era
 * @returns {string|null} null when two or more slices are eligible
 */
export function eraNote(lang, era) {
  if (era.eligible >= 2) return null;
  const name = languageName(lang);
  const short = era.slices.find((s) => !s.eligible);
  const why = short ? ` (${rangeLabel(short.years)} has ${shortfall(short)})` : '';
  const count = era.eligible === 0 ? 'no eligible slice' : 'one eligible slice';
  return `Aligned displacement unavailable for ${name}: ${count}${why}`;
}

function shortfall(s) {
  if (s.tokens < SLICE_GATE.tokens) return `${tokensHave(s.tokens)} tokens; needs ${formatTokens(SLICE_GATE.tokens)}`;
  if (s.docs < SLICE_GATE.docs) return `${formatCount(s.docs)} documents; needs ${SLICE_GATE.docs}`;
  return `${formatCount(s.authors)} authors; needs ${SLICE_GATE.authors}`;
}

// ── Neighbours and controls ──────────────────────────────────────────────────────────────────────────

/**
 * Rows of space A and B for every word in both, by word.
 * @returns {{words: string[], rowsA: Int32Array, rowsB: Int32Array}}
 */
export function sharedVocab(sa, sb) {
  const words = [], ra = [], rb = [];
  for (let i = 0; i < sa.vocab.length; i++) {
    const j = sb.index.get(sa.vocab[i]);
    if (j === undefined) continue;
    words.push(sa.vocab[i]);
    ra.push(i);
    rb.push(j);
  }
  return { words, rowsA: Int32Array.from(ra), rowsB: Int32Array.from(rb) };
}

/**
 * The k nearest rows of `row` by cosine among `candidates` (rows of the same space), excluding itself.
 * @param {{W: Float32Array, dim: number}} space
 * @param {number} row
 * @param {Int32Array|number[]} candidates
 * @param {number} k
 * @returns {number[]} indexes into candidates, best first
 */
export function nearest(space, row, candidates, k) {
  const { W, dim } = space;
  const best = []; // [score, index] ascending by score, at most k
  const off = row * dim;
  for (let c = 0; c < candidates.length; c++) {
    const r = candidates[c];
    if (r === row) continue;
    let s = 0;
    const o = r * dim;
    for (let j = 0; j < dim; j++) s += W[off + j] * W[o + j];
    if (best.length < k) { best.push([s, c]); best.sort((x, y) => x[0] - y[0]); }
    else if (s > best[0][0]) { best[0] = [s, c]; best.sort((x, y) => x[0] - y[0]); }
  }
  return best.sort((x, y) => y[0] - x[0] || x[1] - y[1]).map((b) => b[1]);
}

/**
 * Neighbour overlap of one shared word: its top-k neighbours in each slice space, both searched among the
 * words the spaces share (a neighbour missing from the other space could never overlap).
 * @param {object} sa @param {object} sb
 * @param {{words: string[], rowsA: Int32Array, rowsB: Int32Array}} shared
 * @param {number} i index of the word in shared
 * @param {number} [k]
 * @returns {{jaccard: number, a: string[], b: string[]}}
 */
export function neighbourOverlap(sa, sb, shared, i, k = DRIFT_PARAMS.neighbours) {
  const a = nearest(sa, shared.rowsA[i], shared.rowsA, k);
  const b = nearest(sb, shared.rowsB[i], shared.rowsB, k);
  const setA = new Set(a);
  let inter = 0;
  for (const x of b) if (setA.has(x)) inter++;
  const union = a.length + b.length - inter;
  return { jaccard: union > 0 ? inter / union : 0, a: a.map((x) => shared.words[x]), b: b.map((x) => shared.words[x]) };
}

/**
 * Frequency-matched controls (§4.9): shared words in the same frequency decile as the target in both slices
 * (deciles by frequency rank among the shared words of each slice), not among either slice's 100 most
 * frequent words, with at least `minFreq` in both; a seeded sample of at most `n`.
 * @param {object} sa @param {object} sb
 * @param {{words: string[], rowsA: Int32Array, rowsB: Int32Array}} shared
 * @param {number} target index in shared
 * @param {{n?: number, stopTop?: number, minFreq?: number, seed?: number, exclude?: Set<string>}} [opts]
 * @returns {number[]} indexes into shared
 */
export function frequencyControls(sa, sb, shared, target, { n = DRIFT_PARAMS.controls, stopTop = DRIFT_PARAMS.stopTop, minFreq = 0,
  seed = DRIFT_PARAMS.seed, exclude = new Set() } = {}) {
  const N = shared.words.length;
  const decile = (counts, rows) => {
    const order = Array.from({ length: N }, (_, i) => i).sort((x, y) => counts[rows[y]] - counts[rows[x]] || x - y);
    const d = new Int8Array(N), rank = new Int32Array(N);
    order.forEach((i, r) => { d[i] = Math.min(9, Math.floor((10 * r) / N)); rank[i] = r; });
    return { d, rank };
  };
  const A = decile(sa.counts, shared.rowsA), B = decile(sb.counts, shared.rowsB);
  const topA = new Set(), topB = new Set();
  for (let i = 0; i < sa.vocab.length && i < stopTop; i++) topA.add(sa.vocab[i]);
  for (let i = 0; i < sb.vocab.length && i < stopTop; i++) topB.add(sb.vocab[i]);
  const cands = [];
  for (let i = 0; i < N; i++) {
    if (i === target || A.d[i] !== A.d[target] || B.d[i] !== B.d[target]) continue;
    const w = shared.words[i];
    if (topA.has(w) || topB.has(w) || exclude.has(w)) continue;
    if (sa.counts[shared.rowsA[i]] < minFreq || sb.counts[shared.rowsB[i]] < minFreq) continue;
    cands.push(i);
  }
  const rng = mulberry32(seed);
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cands[i], cands[j]] = [cands[j], cands[i]];
  }
  return cands.slice(0, n).sort((x, y) => x - y);
}

// ── (b) and (c) on two slice spaces ──────────────────────────────────────────────────────────────────

/** Fewest controls a percentile is reported against. */
export const MIN_CONTROLS = 50;

/**
 * (b) and (c) for one word in two loaded slice spaces. Gates evaluated here (the evidence and slice-size
 * gates are evaluated before spaces are built): the word's frequency in each space, the number of controls,
 * the anchors and the alignment quality. Every gated measure carries no value.
 * @param {object} sa space of slice A (occvec.loadSpace)
 * @param {object} sb space of slice B
 * @param {string} word folded single token
 * @param {{controls?: number, seed?: number, step?: () => void}} [opts]
 * @returns {{neighbor_overlap: object, aligned_displacement: object}}
 */
export function driftMeasures(sa, sb, word, { controls: nControls = DRIFT_PARAMS.controls, seed = DRIFT_PARAMS.seed, step = () => {} } = {}) {
  const fA = sa.counts[sa.index.get(word)] ?? 0, fB = sb.counts[sb.index.get(word)] ?? 0;
  const shared = sharedVocab(sa, sb);
  const ti = shared.words.indexOf(word);
  const out = {};

  // (b) neighbour overlap
  const tb = THRESHOLDS.neighbor_overlap;
  if (ti < 0 || fA < tb.occurrences || fB < tb.occurrences) {
    out.neighbor_overlap = gated('insufficient_occurrences', { needed: { frequency_per_slice_space: tb.occurrences }, have: { a: fA, b: fB },
      note: `'${word}' occurs ${formatCount(fA)} and ${formatCount(fB)} times in the two slice spaces' running text (needs ${tb.occurrences} in each).` });
  } else {
    const ctl = frequencyControls(sa, sb, shared, ti, { n: nControls, seed, minFreq: tb.occurrences });
    if (ctl.length < MIN_CONTROLS) {
      out.neighbor_overlap = gated('slice_too_small', { needed: { controls: MIN_CONTROLS }, have: { controls: ctl.length },
        note: `Only ${ctl.length} frequency-matched control words in these slices (needs ${MIN_CONTROLS}).` });
    } else {
      const target = neighbourOverlap(sa, sb, shared, ti);
      step();
      const dist = ctl.map((c, i) => { if ((i & 15) === 0) step(); return 1 - neighbourOverlap(sa, sb, shared, c).jaccard; });
      const value = 1 - target.jaccard;
      out.neighbor_overlap = { gate: 'ok', value: r4(value), ci: null, jaccard: r4(target.jaccard), percentile: r2(percentileOf(value, dist)),
        controls: ctl.length, neighbours: { a: target.a, b: target.b }, k: DRIFT_PARAMS.neighbours };
    }
  }

  // (c) aligned displacement
  const tc = THRESHOLDS.aligned_displacement;
  if (ti < 0 || fA < tc.occurrences || fB < tc.occurrences) {
    out.aligned_displacement = gated('insufficient_occurrences', { needed: { frequency_per_slice_space: tc.occurrences }, have: { a: fA, b: fB },
      note: `'${word}' occurs ${formatCount(fA)} and ${formatCount(fB)} times in the two slice spaces' running text (needs ${tc.occurrences} in each).` });
    return out;
  }
  const nbA = nearest(sa, shared.rowsA[ti], shared.rowsA, ANCHORS.excludeNeighbours).map((x) => shared.words[x]);
  const nbB = nearest(sb, shared.rowsB[ti], shared.rowsB, ANCHORS.excludeNeighbours).map((x) => shared.words[x]);
  const exclude = new Set([word, ...nbA, ...nbB]);
  const anchors = chooseAnchors(sa, sb, { exclude });
  if (anchors.words.length < ANCHORS.needed) {
    out.aligned_displacement = gated('unaligned', { needed: { anchors: ANCHORS.needed }, have: { anchors: anchors.words.length },
      note: `Not estimated: ${formatCount(anchors.words.length)} anchor words (shared, f ≥ ${ANCHORS.minFreq} in both slices; needs ${formatCount(ANCHORS.needed)}).` });
    return out;
  }
  step();
  const al = alignSpaces(sa, sb, anchors);
  if (al.meanCos < ANCHORS.minMeanCos) {
    out.aligned_displacement = gated('unaligned', { needed: { mean_anchor_cosine: ANCHORS.minMeanCos }, have: { mean_anchor_cosine: r4(al.meanCos), anchors: al.anchors },
      note: `Not estimated: the slices do not align (mean anchor cosine ${al.meanCos.toFixed(2)} after rotation; needs ${ANCHORS.minMeanCos}).` });
    return out;
  }
  const value = displacement(sa, shared.rowsA[ti], sb, shared.rowsB[ti], al.r);
  // controls are measured out of sample: each fold is aligned on anchors that exclude it
  const ctl = frequencyControls(sa, sb, shared, ti, { n: nControls, seed: seed + 1, minFreq: tc.occurrences, exclude });
  if (ctl.length < MIN_CONTROLS) {
    out.aligned_displacement = gated('slice_too_small', { needed: { controls: MIN_CONTROLS }, have: { controls: ctl.length },
      note: `Only ${ctl.length} frequency-matched control words in these slices (needs ${MIN_CONTROLS}).` });
    return out;
  }
  const dist = [];
  const folds = DRIFT_PARAMS.folds;
  for (let f = 0; f < folds; f++) {
    const fold = ctl.filter((_, i) => i % folds === f);
    if (!fold.length) continue;
    const ex = new Set([...exclude, ...fold.map((c) => shared.words[c])]);
    const alF = alignSpaces(sa, sb, chooseAnchors(sa, sb, { exclude: ex }));
    for (const c of fold) dist.push(displacement(sa, shared.rowsA[c], sb, shared.rowsB[c], alF.r));
    step();
  }
  out.aligned_displacement = { gate: 'ok', value: r4(value), ci: null, percentile: r2(percentileOf(value, dist)), controls: dist.length,
    anchors: al.anchors, anchors_available: anchors.available, mean_anchor_cos: r4(al.meanCos), mean_anchor_cos_before: r4(al.meanCosBefore),
    excluded_neighbours: { a: nbA, b: nbB } };
  return out;
}

/**
 * The §4.9 verdict: notable only if (c)'s percentile reaches the adjusted threshold (100 − 5/k) and (b)'s
 * neighbour Jaccard is ≤ 0.2; null when either measure is gated.
 * @param {{percentile?: number, gate: string}} displacementMeasure
 * @param {{jaccard?: number, gate: string}} overlapMeasure
 * @param {number} k comparisons of this expression in the session
 * @returns {'notable'|'within typical variation'|null}
 */
export function verdict(displacementMeasure, overlapMeasure, k) {
  if (displacementMeasure?.gate !== 'ok' || overlapMeasure?.gate !== 'ok') return null;
  return displacementMeasure.percentile >= notableThreshold(k) && overlapMeasure.jaccard <= DRIFT_PARAMS.overlapNotable
    ? 'notable' : 'within typical variation';
}

// ── (a) context-share shift ──────────────────────────────────────────────────────────────────────────

/**
 * JSD (base 2) between two count vectors over the same categories; null when either is empty.
 * @param {ArrayLike<number>} p
 * @param {ArrayLike<number>} q
 * @returns {number|null}
 */
export function jsdCounts(p, q) {
  let sp = 0, sq = 0;
  for (let i = 0; i < p.length; i++) { sp += p[i]; sq += q[i]; }
  if (!(sp > 0 && sq > 0)) return null;
  let v = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i] / sp, b = q[i] / sq, m = (a + b) / 2;
    if (a > 0) v += 0.5 * a * Math.log2(a / m);
    if (b > 0) v += 0.5 * b * Math.log2(b / m);
  }
  return Math.min(1, Math.max(0, v));
}

/**
 * Context-share shift between two slices from per-document context-group counts.
 * @param {Array<Float64Array|number[]>} blocksA per document of slice A: occurrences per context group
 * @param {Array<Float64Array|number[]>} blocksB
 * @param {number} k number of context groups
 * @param {{resamples?: number, seed?: number}} [opts]
 * @returns {{value: number|null, ci: [number, number]|null, sharesA: number[], sharesB: number[], nA: number, nB: number}}
 */
export function contextShareShift(blocksA, blocksB, k, { resamples = 1000, seed = DRIFT_PARAMS.seed } = {}) {
  const sum = (blocks) => {
    const t = new Float64Array(k);
    for (const b of blocks) for (let i = 0; i < k; i++) t[i] += b[i];
    return t;
  };
  const ta = sum(blocksA), tb = sum(blocksB);
  const nA = ta.reduce((s, x) => s + x, 0), nB = tb.reduce((s, x) => s + x, 0);
  const value = jsdCounts(ta, tb);
  const ci = value === null ? null : twoSampleBootstrap(blocksA, blocksB, (a, b) => jsdCounts(sum(a), sum(b)), { resamples, seed });
  return { value, ci, sharesA: Array.from(ta, (x) => (nA ? x / nA : 0)), sharesB: Array.from(tb, (x) => (nB ? x / nB : 0)), nA, nB };
}

// ── Stored drift runs ────────────────────────────────────────────────────────────────────────────────

/**
 * The canonical parameters of a drift run for a comparison (what Compare and the drift job both hash).
 * @param {{expr: number[], a: {years: number[], f: string}, b: {years: number[], f: string}, toggles: object, corpus: string|null}} req
 * @returns {object}
 */
export function driftRunParams(req) {
  return { version: DRIFT_VERSION, expr: [...req.expr].sort((x, y) => x - y), a: { years: req.a.years, f: req.a.f ?? '' },
    b: { years: req.b.years, f: req.b.f ?? '' }, toggles: req.toggles, corpus: req.corpus ?? null,
    // as saved (RF-2): a run of the saved view's pins and cutoffs is its own comparison
    ...(req.runs ? { runs: req.runs } : {}), ...(req.cutoffs ? { cutoffs: req.cutoffs } : {}) };
}

/**
 * Scope and upstream runs of a drift run's input fingerprint (the slices' collections and the expressions'
 * materialize runs), so Compare can recompute it.
 * @returns {{scope: {collections: string[]}, upstream: number[]}}
 */
export function driftRunScope(collections, exprs) {
  return { scope: { collections: [...collections].sort() }, upstream: exprs.map((e) => e.run).sort((x, y) => x - y) };
}

/**
 * Stored (b) and (c) results of the newest succeeded drift run for exactly this comparison on the current
 * data (same params hash and input fingerprint), or null.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} params driftRunParams()
 * @param {{scope: object, upstream: number[]}} fp driftRunScope()
 * @returns {{run: number, measures: Record<string, object>}|null}
 */
export function storedDriftResults(db, params, fp) {
  const hash = createHash('sha256').update(canonicalJson(params)).digest('hex');
  const run = db.prepare(`SELECT id FROM analysis_run WHERE stage = 'drift' AND status = 'succeeded' AND params_hash = ?
    AND input_fingerprint = ? ORDER BY id DESC LIMIT 1`).get(hash, inputFingerprint(db, fp))?.id ?? null;
  if (run === null) return null;
  const measures = {};
  for (const r of db.prepare('SELECT * FROM drift_result WHERE run_id = ? ORDER BY id').all(run)) {
    let detail = {};
    try { detail = JSON.parse(r.gate_detail_json); } catch { /* written by the drift job as JSON */ }
    measures[r.metric] = r.gate === 'ok'
      ? { ...detail, gate: 'ok', value: r.value, ci: r.ci_lo === null ? null : [r.ci_lo, r.ci_hi], percentile: r.null_percentile }
      : gated(r.gate, { needed: detail.needed ?? {}, have: detail.have ?? {}, suggestion: null, note: detail.note ?? null });
  }
  return { run, measures };
}

/**
 * The §2.E sentence of a passing measure.
 * @param {string} metric
 * @param {object} m the measure (value, ci, percentile, controls …)
 * @param {{n: number[], docs: number[], overlap?: object|null, verdict?: string|null}} ctx
 * @returns {string}
 */
export function measureSentence(metric, m, { n, docs, overlap = null, verdict: v = null }) {
  const counts = `n = ${n.map(formatCount).join(' / ')} · ${docs.map(formatCount).join(' / ')} documents`;
  if (metric === 'sense_share_jsd') {
    const ci = m.ci ? ` [${m.ci[0].toFixed(2)}, ${m.ci[1].toFixed(2)}]` : '';
    return `Context-share shift JSD ${m.value.toFixed(2)}${ci} · ${counts} — an ${SHIFT_WORDS}.`;
  }
  if (metric === 'neighbor_overlap') {
    return `Neighbour overlap ${m.jaccard.toFixed(2)} (Jaccard of the top ${m.k ?? DRIFT_PARAMS.neighbours} neighbours; 1 − J = ${m.value.toFixed(2)}) · ` +
      `${ordinalPct(m.percentile)} percentile of ${formatCount(m.controls)} frequency-matched controls · ${counts}.`;
  }
  const tail = overlap?.gate === 'ok' ? ` · neighbour overlap ${overlap.jaccard.toFixed(2)}` : '';
  return `Aligned displacement ${m.value.toFixed(2)} · ${ordinalPct(m.percentile)} percentile of ${formatCount(m.controls)} frequency-matched controls${tail}` +
    `${v ? ` → ${v}` : ''} · ${counts} — an ${SHIFT_WORDS}.`;
}

function ordinalPct(p) {
  const x = Math.round(p);
  const s = x % 100 >= 11 && x % 100 <= 13 ? 'th' : x % 10 === 1 ? 'st' : x % 10 === 2 ? 'nd' : x % 10 === 3 ? 'rd' : 'th';
  return `${x}${s}`;
}

// ── Context groups of a clustering run (read for (a) and Compare's context-group shares) ─────────────

/**
 * The newest succeeded clustering run of one expression with its context groups (ordered), the machine
 * labels and, where a person renamed one, the human label (the machine label stays alongside). With
 * `modality`, only a run that clustered that medium (cluster@1.1.0 scope) — or an older run, which recorded
 * none — is used: groups found in paper abstracts never stand for book text.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} exprId
 * @param {{modality?: string|null}} [opts]
 * @returns {{run: number, representation: string|null, modality: string|null, clusters: Array<{id: number, ord: number, label: string,
 *   human_label: string|null, status: string, size: number}>}|null}
 */
export function clusterRunFor(db, exprId, { modality = null, run = null, before = null, revCutoff = null } = {}) {
  let row;
  const sameMedium = `(? IS NULL OR json_extract(r.scope_json, '$.modality') IS NULL OR json_extract(r.scope_json, '$.modality') = ?)
      AND EXISTS (SELECT 1 FROM sense_cluster c WHERE c.run_id = r.id AND c.expression_id = ?)`;
  try {
    // as saved (RF-2): the run the view pinned, or the newest one that had finished at its save — never a later one
    row = run !== null
      ? db.prepare(`SELECT r.id, r.representation, json_extract(r.scope_json, '$.modality') AS modality FROM analysis_run r
        WHERE r.id = ? AND r.stage = 'cluster' AND r.status = 'succeeded' AND ${sameMedium}`).get(run, modality, modality, exprId)
      : db.prepare(`SELECT r.id, r.representation, json_extract(r.scope_json, '$.modality') AS modality FROM analysis_run r
        WHERE r.stage = 'cluster' AND r.status = 'succeeded' AND (? IS NULL OR r.finished_at <= ?) AND ${sameMedium}
        ORDER BY r.id DESC LIMIT 1`).get(before, before, modality, modality, exprId);
  } catch { return null; }
  if (!row) return null;
  const clusters = db.prepare(`SELECT c.id, c.ord, c.label_auto AS label, c.status, c.size,
      (SELECT v.body_md FROM annotation a JOIN annotation_revision v ON v.annotation_id = a.id AND v.rev = a.current_rev
        WHERE a.target_type = 'cluster' AND a.target_ref = CAST(c.id AS TEXT) AND a.kind = 'label' AND a.status = 'active'
        ORDER BY a.id DESC LIMIT 1) AS human_label
    FROM sense_cluster c WHERE c.run_id = ? AND c.expression_id = ? ORDER BY c.ord, c.id`).all(row.id, exprId);
  if (revCutoff !== null) {
    // the readers' labels as they stood at the view's annotation revision cutoff
    const then = humanLabels(db, clusters.map((c) => c.id), { revCutoff });
    for (const c of clusters) c.human_label = then.get(c.id)?.label ?? null;
  }
  return { run: row.id, representation: row.representation ?? null, modality: row.modality ?? null, clusters };
}

/**
 * Per-document context-group counts of a clustering run: document id → counts by cluster position.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{run: number, clusters: Array<{id: number}>}} cr
 * @param {number} exprId
 * @returns {Map<number, Float64Array>}
 */
export function clusterDocCounts(db, cr, exprId) {
  const pos = new Map(cr.clusters.map((c, i) => [c.id, i]));
  const out = new Map();
  for (const r of db.prepare(`SELECT o.document_id AS doc, m.cluster_id AS cluster FROM cluster_member m
    JOIN sense_cluster c ON c.id = m.cluster_id JOIN occurrence o ON o.id = m.occurrence_id
    WHERE c.run_id = ? AND c.expression_id = ?`).iterate(cr.run, exprId)) {
    const j = pos.get(r.cluster);
    if (j === undefined) continue;
    let v = out.get(r.doc);
    if (!v) { v = new Float64Array(cr.clusters.length); out.set(r.doc, v); }
    v[j]++;
  }
  return out;
}
