// OWNER: WP4
// convergence.mjs — convergence of two expressions X and Y (SPEC §4.8, §1.8 ⑃).
//
// Per window: J(t) = Jaccard of the two expressions' top-50 significant collocates (the collocation rules of
// §4.6: window ±5, f(x,y) ≥ 5, f(y) ≥ 10, G² ≥ 10.83, BH q < .05, attraction only, stop-words hidden,
// ranked by logDice); both expressions must pass the collocation gate (n ≥ 20) in that window, else the
// window is gated and has no J. C(t) = cosine of the two expressions' mean occurrence vectors in one shared
// representation (descriptive). Convergence is reported (cluster_transition.kind = 'convergence') only when
// J rises by ≥ 0.15 between the first and the last gated windows **and** the document-block bootstrap 95% CI
// of that difference excludes 0. Fewer than two gated windows → gate `insufficient_occurrences`, no value.
// Context words, not meanings: a shared neighbourhood is not a shared meaning, and not influence.

import { mulberry32 } from '../../src/shared/ids.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { paths } from '../config.mjs';
import { leadingModality, stopSet, SYNC_TOKEN_LIMIT, WINDOW as COLLOC_WINDOW } from './collocations.mjs';
import { gated, THRESHOLDS } from './gates.mjs';
import { benjaminiHochberg, chi2Sf, g2 } from './intervals.mjs';
import { denseCos, meanDirection } from './kmeans.mjs';
import { loadScope, modalityEvidence, passageTextReader, sliceStats } from './slices.mjs';
import { contextWords, OCC_WINDOW, tfidfHashVectors } from './tfidf-hash.mjs';
import { quantile, windowLabel } from './transitions.mjs';
import { openTokenStream, streamStatus } from './tokstream.mjs';

/** §4.8 convergence rule. */
export const CONVERGENCE_RULE = Object.freeze({ top: 50, rise: 0.15, minOccurrences: THRESHOLDS.collocates.occurrences, resamples: 1000 });
/** The caveat every convergence carries. */
export const CONVERGENCE_CAVEAT = 'Computed: shared context words, not meanings; not evidence of influence.';

const C = THRESHOLDS.collocates;

// ── Pure part ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Top significant collocates over typed counts (mirrors collocations.collocates()).
 * @param {{fxy: Float64Array, fy: Float64Array, fx: number, W: number, N: number}} c counts over the window's term index
 * @param {{terms: string[], stop: Uint8Array, top?: number}} opts
 * @returns {number[]} term indexes, best first
 */
export function topCollocates(c, { terms, stop, top = CONVERGENCE_RULE.top }) {
  const { fxy, fy, fx, W, N } = c;
  const cand = [], ps = [];
  for (let t = 0; t < fxy.length; t++) {
    const f = fxy[t], y = fy[t];
    if (f < C.f_xy || y < C.f_y) continue;
    const g = g2(f, Math.max(0, W - f), Math.max(0, y - f), Math.max(0, N - W - y + f));
    cand.push({ t, g, attract: N > 0 && f > W * y / N, f, y });
    ps.push(chi2Sf(g, 1));
  }
  const qs = benjaminiHochberg(ps);
  const keep = [];
  cand.forEach((x, i) => {
    if (!(x.attract && x.g >= C.g2 && qs[i] < C.q) || stop[x.t]) return;
    // rounded as collocations.collocates() rounds them, so ties break the same way
    keep.push({ t: x.t, dice: Number((14 + Math.log2(2 * x.f / (fx + x.y))).toFixed(2)), g: Number(x.g.toFixed(2)) });
  });
  keep.sort((a, b) => b.dice - a.dice || b.g - a.g || (terms[a.t] < terms[b.t] ? -1 : terms[a.t] > terms[b.t] ? 1 : 0));
  return keep.slice(0, top).map((x) => x.t);
}

/**
 * Jaccard of two sets (0 when both are empty).
 * @param {Iterable<unknown>} a
 * @param {Iterable<unknown>} b
 * @returns {number}
 */
export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

/**
 * Sum the counts of some documents of a window (a document may repeat: bootstrap draws).
 * @param {object} win window data (see convergence())
 * @param {number[]|null} pick document indexes, null = all once
 * @returns {{fy: Float64Array, N: number, ex: Array<{fx: number, W: number, fxy: Float64Array}>}}
 */
export function aggregateWindow(win, pick = null) {
  const T = win.terms.length;
  const fy = new Float64Array(T);
  const ex = [0, 1].map(() => ({ fx: 0, W: 0, fxy: new Float64Array(T) }));
  let N = 0;
  const docs = pick ? pick.map((i) => win.docs[i]) : win.docs;
  for (const d of docs) {
    N += d.N;
    for (let i = 0; i < d.fy.idx.length; i++) fy[d.fy.idx[i]] += d.fy.cnt[i];
    for (let e = 0; e < 2; e++) {
      const s = d.ex[e];
      ex[e].fx += s.fx;
      ex[e].W += s.W;
      for (let i = 0; i < s.fxy.idx.length; i++) ex[e].fxy[s.fxy.idx[i]] += s.fxy.cnt[i];
    }
  }
  return { fy, N, ex };
}

/** J of a window from aggregated counts. */
function windowJ(win, agg, top) {
  const lists = [0, 1].map((e) => topCollocates({ fxy: agg.ex[e].fxy, fy: agg.fy, fx: agg.ex[e].fx, W: agg.ex[e].W, N: agg.N },
    { terms: win.terms, stop: win.stop, top }));
  return { J: jaccard(lists[0], lists[1]), top: lists.map((l) => l.map((t) => win.terms[t])) };
}

/**
 * Convergence of two expressions over windows.
 * @param {Array<{label: string, lo: number, hi: number, n: [number, number], cos?: number|null, terms?: string[],
 *   stop?: Uint8Array, docs?: Array<{N: number, fy: {idx: Int32Array, cnt: Float64Array},
 *   ex: Array<{fx: number, W: number, fxy: {idx: Int32Array, cnt: Float64Array}}>}>}>} windows in time order; a window
 *   without `docs` (or with n < 20 for either expression) is gated
 * @param {{resamples?: number, seed?: number, top?: number, rise?: number, checkpoint?: () => void}} [opts]
 * @returns {object} {gate, windows:[{label, lo, hi, n, J, C, gated, shared?}], first, last, value (ΔJ), ci, reported} or a gated object
 */
export function convergence(windows, { resamples = CONVERGENCE_RULE.resamples, seed = 42, top = CONVERGENCE_RULE.top,
  rise = CONVERGENCE_RULE.rise, checkpoint = null } = {}) {
  const need = CONVERGENCE_RULE.minOccurrences;
  const blocked = windows.filter((w) => w.unavailable && w.n[0] >= need && w.n[1] >= need);
  if (blocked.length) {
    const langs = [...new Set(blocked.flatMap((w) => w.unavailable.langs))].sort();
    return gated('not_run', { needed: { token_streams: langs }, have: { windows: blocked.map((w) => ({ window: w.label, tokens: w.unavailable.tokens })) },
      suggestion: { label: `Build token streams for ${langs.join(', ')}`, run: { stage: 'tokstream', params: { langs } } },
      note: `Convergence over windows of more than ${SYNC_TOKEN_LIMIT} tokens needs current token streams (${langs.join(', ')}).`,
      windows: windows.map((w) => ({ label: w.label, lo: w.lo, hi: w.hi, n: w.n, gated: true, J: null, C: null })) });
  }
  const rows = windows.map((w, i) => {
    const ok = w.n[0] >= need && w.n[1] >= need && Array.isArray(w.docs);
    const row = { index: i, label: w.label, lo: w.lo, hi: w.hi, n: w.n, gated: !ok, J: null, C: w.cos ?? null };
    if (ok) {
      const r = windowJ(w, aggregateWindow(w), top);
      row.J = Number(r.J.toFixed(4));
      row.shared = r.top[0].filter((t) => r.top[1].includes(t)).slice(0, 12);
    }
    return row;
  });
  const okRows = rows.filter((r) => !r.gated);
  if (okRows.length < 2) {
    return gated('insufficient_occurrences', { needed: { occurrences_per_window: need, windows: 2 },
      have: { windows: okRows.length, per_window: rows.map((r) => ({ window: r.label, occurrences: r.n })) },
      note: `Convergence needs both expressions to have ≥ ${need} occurrences in at least two windows; ${okRows.length} window${okRows.length === 1 ? '' : 's'} qualify.`,
      windows: rows.map(({ J, ...r }) => ({ ...r, J: null })) });
  }
  const first = okRows[0], last = okRows[okRows.length - 1];
  const value = last.J - first.J;
  const rng = mulberry32(seed);
  const wf = windows[first.index], wl = windows[last.index];
  const draws = new Float64Array(resamples);
  const draw = (win) => Array.from({ length: win.docs.length }, () => Math.floor(rng() * win.docs.length));
  for (let r = 0; r < resamples; r++) {
    if (checkpoint && r % 25 === 0) checkpoint();
    draws[r] = windowJ(wl, aggregateWindow(wl, draw(wl)), top).J - windowJ(wf, aggregateWindow(wf, draw(wf)), top).J;
  }
  draws.sort();
  const ci = [Number(quantile(draws, 0.025).toFixed(4)), Number(quantile(draws, 0.975).toFixed(4))];
  const reported = value >= rise && ci[0] > 0;
  return { gate: 'ok', windows: rows, first: first.index, last: last.index, value: Number(value.toFixed(4)), ci, resamples,
    reported, rule: `J rises ≥ ${rise} between the first and last gated windows and the 95% document-block bootstrap CI excludes 0` };
}

// ── Windows ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Joint windows for a pair: decades merged forward until both expressions have ≥ minN decade-fitting
 * occurrences, never across an uncovered decade; a remainder joins the previous window of its stretch.
 * @param {Array<{lo: number, hi: number, n: [number, number], covered: boolean}>} cells contiguous decades
 * @param {{minN?: number}} [opts]
 * @returns {Array<{lo: number, hi: number, label: string}>} covered windows only
 */
export function jointWindows(cells, { minN = CONVERGENCE_RULE.minOccurrences } = {}) {
  const out = [];
  let i = 0;
  while (i < cells.length) {
    if (!cells[i].covered) { i++; continue; }
    const made = [];
    let cur = null;
    while (i < cells.length && cells[i].covered) {
      const c = cells[i++];
      cur = cur ? { lo: cur.lo, hi: c.hi, n: [cur.n[0] + c.n[0], cur.n[1] + c.n[1]] } : { lo: c.lo, hi: c.hi, n: [...c.n] };
      if (cur.n[0] >= minN && cur.n[1] >= minN) { made.push(cur); cur = null; }
    }
    if (cur) { if (made.length) Object.assign(made[made.length - 1], { hi: cur.hi }); else made.push(cur); }
    out.push(...made);
  }
  return out.map((w) => ({ lo: w.lo, hi: w.hi, label: windowLabel(w.lo, w.hi) }));
}

// ── Reading the counts ───────────────────────────────────────────────────────────────────────────────

function sparse(map) {
  const keys = [...map.keys()].sort((a, b) => a - b);
  return { idx: Int32Array.from(keys), cnt: Float64Array.from(keys.map((k) => map.get(k))) };
}

/**
 * Occurrences of an expression in some documents, with the token span of each (counted matches only: the
 * name guard and the slice's passage rules apply).
 * @returns {Map<number, Array<{passage: number, tok: number, len: number, start_off: number, p_start: number}>>} doc → occurrences
 */
function occurrencesIn(db, expr, docIds, { classes, langOk, nm }) {
  const lenOf = new Map(expr.variants.map((v) => [v.id, v.tokens.length]));
  const out = new Map();
  const rows = db.prepare(`SELECT o.document_id AS doc, o.passage_id AS passage, o.tok_index AS tok, o.variant_id AS variant,
      o.name_flag, o.start_off, p.start_off AS p_start, p.field_class AS fc, p.lang, p.quality, d.lang_text
    FROM occurrence o JOIN passage p ON p.id = o.passage_id JOIN document d ON d.id = o.document_id
    WHERE o.expression_id = ? AND o.run_id = ? AND o.document_id IN (SELECT value FROM json_each(?)) ORDER BY o.passage_id, o.tok_index`)
    .all(expr.id, expr.run, JSON.stringify(docIds));
  for (const r of rows) {
    if (r.quality !== 'ok' || !classes.has(r.fc) || !langOk(r.lang, r.fc, r.lang_text) || (!nm && r.name_flag)) continue;
    if (!out.has(r.doc)) out.set(r.doc, []);
    out.get(r.doc).push({ passage: r.passage, tok: r.tok, len: lenOf.get(r.variant) ?? expr.norm.split(' ').length,
      start_off: r.start_off, p_start: r.p_start });
  }
  return out;
}

/**
 * A reader of folded passage tokens: the token stream of the passage's language when it is current, else the
 * passage text tokenized (the same tokens; §4.3 parity). `close()` releases the streams' files.
 * @returns {{tokens: (p: object) => string[], counter: (terms: string[]) => object, close: () => void}}
 */
function tokenReader(db, dir) {
  const readText = passageTextReader(db);
  const streams = new Map();
  const streamOf = (lang) => {
    if (!streams.has(lang)) {
      let s = null;
      try { if (streamStatus(db, dir, lang).fresh) s = openTokenStream(lang, { dir, ids: false }); } catch { s = null; }
      streams.set(lang, s);
    }
    return streams.get(lang);
  };
  const tokens = (p) => {
    const s = streamOf(p.lang);
    const r = s?.range(p.id);
    if (r) { const ids = s.readIds(r[0], r[1]); return Array.from(ids, (id) => s.vocab[id]); }
    const text = readText(p);
    return text === null ? [] : tokenize(text).tokens;
  };
  /**
   * Token counts of passages and occurrences of a fixed term list in them. Streamed passages are counted on their
   * ids (no strings), and each run of passages that are contiguous in the stream is read at once; the counts are
   * exactly those of tokens().
   * @param {string[]} terms
   * @returns {{count: (passages: object[], onPassage: (p: object, n: number, hits: Map<number, number>) => void) => void}}
   */
  const counter = (terms) => {
    const index = new Map(terms.map((t, i) => [t, i]));
    const maps = new Map(); // lang → stream id → term index (−1: not a term)
    const mapOf = (lang, s) => {
      if (!maps.has(lang)) {
        const m = new Int32Array(s.vocab.length).fill(-1);
        terms.forEach((t, i) => { const sid = s.idOf(t); if (sid !== undefined) m[sid] = i; });
        maps.set(lang, m);
      }
      return maps.get(lang);
    };
    const tally = (ids, a, b, m) => {
      const hits = new Map();
      for (let i = a; i < b; i++) { const t = m[ids[i]]; if (t >= 0) hits.set(t, (hits.get(t) ?? 0) + 1); }
      return hits;
    };
    return {
      count(passages, onPassage) {
        let run = null;
        const flush = () => {
          if (!run) return;
          const ids = run.s.readIds(run.start, run.end);
          const m = mapOf(run.lang, run.s);
          for (const [p, r] of run.items) onPassage(p, r[1] - r[0], tally(ids, r[0] - run.start, r[1] - run.start, m));
          run = null;
        };
        for (const p of passages) {
          const s = streamOf(p.lang);
          const r = s?.range(p.id);
          if (!r) {
            flush();
            const toks = tokens(p);
            const hits = new Map();
            for (const t of toks) { const i = index.get(t); if (i !== undefined) hits.set(i, (hits.get(i) ?? 0) + 1); }
            onPassage(p, toks.length, hits);
            continue;
          }
          if (run && run.s === s && run.end === r[0]) { run.end = r[1]; run.items.push([p, r]); continue; }
          flush();
          run = { s, lang: p.lang, start: r[0], end: r[1], items: [[p, r]] };
        }
        flush();
      },
    };
  };
  return { tokens, counter, close: () => { for (const s of streams.values()) s?.close(); } };
}

/**
 * Per-document counts of two expressions in windows, ready for convergence(): ±5 co-occurrence counts of
 * each expression, slice frequencies of the co-occurring terms, slice tokens, and the ±10 contexts behind
 * C(t). Windows where either expression has < 20 counted occurrences carry only their n.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{exprs: object[], windows: Array<{lo: number, hi: number, label?: string}>, toggles: object, corpus?: string|null,
 *   f?: string, dir?: string, checkpoint?: () => void, represent?: (contexts: string[][]) => object[]}} args exprs = two resolved
 *   expressions (slices.resolveExpressions); f = a slice filter applied to every window (e.g. the clustering run's collections)
 * @returns {Array<object>} window data for convergence()
 */
export function convergenceInputs(db, { exprs, windows, toggles, corpus = null, f = '', dir = paths().tokens, checkpoint = () => {},
  represent = (ctxs) => tfidfHashVectors(ctxs).vectors, tokenLimit = SYNC_TOKEN_LIMIT }) {
  if (exprs.length !== 2) throw new TypeError('convergenceInputs: two expressions');
  const scope = loadScope(db, { exprs, slices: windows.map((w) => ({ years: [w.lo, w.hi], f })), toggles, corpus });
  const reader = tokenReader(db, dir);
  try {
    return windowInputs(db, { exprs, windows, toggles, scope, reader, dir, checkpoint, represent, tokenLimit });
  } finally {
    reader.close();
  }
}

function windowInputs(db, { exprs, windows, toggles, scope, reader, dir, checkpoint, represent, tokenLimit }) {
  const exclude = new Set(exprs.flatMap((e) => e.variants.flatMap((v) => v.tokens)));
  const ctx10 = [[], []]; // per expression: [{window, words}]
  const out = windows.map((w, wi) => {
    checkpoint();
    const spec = scope.specs[wi];
    const stats = sliceStats(scope, spec, leadingModality(modalityEvidence(scope, spec)));
    const classes = new Set(stats.classes);
    const docIds = stats.perDoc.map((d) => d.id);
    const occ = exprs.map((e) => occurrencesIn(db, e, docIds, { classes, langOk: spec.langOk, nm: Boolean(toggles.nm) }));
    const n = occ.map((m) => [...m.values()].reduce((s, l) => s + l.length, 0));
    const base = { label: w.label ?? windowLabel(w.lo, w.hi), lo: w.lo, hi: w.hi, n, cos: null };
    if (n[0] < CONVERGENCE_RULE.minOccurrences || n[1] < CONVERGENCE_RULE.minOccurrences) return base;

    const passages = db.prepare(`SELECT p.id, p.document_id, p.field, p.field_class AS fc, p.lang, p.start_off, p.end_off, p.token_count
      FROM passage p WHERE p.document_id IN (SELECT value FROM json_each(?)) AND p.quality = 'ok' ORDER BY p.id`).all(JSON.stringify(docIds))
      .filter((p) => classes.has(p.fc) && spec.langOk(p.lang, p.fc, scope.docs.get(p.document_id)?.lang_text ?? null));
    // slices too large to tokenize here need current token streams (as collocations do)
    const sliceTokens = passages.reduce((sum, p) => sum + p.token_count, 0);
    const stale = [...new Set(passages.map((p) => p.lang))].filter((l) => !streamStatus(db, dir, l).fresh);
    if (stale.length && sliceTokens > tokenLimit) return { ...base, unavailable: { langs: stale.sort(), tokens: sliceTokens } };
    const stop = stopSet([...new Set(passages.map((p) => p.lang))]);
    const byPassage = new Map(passages.map((p) => [p.id, p]));
    const termId = new Map(), terms = [];
    const idOf = (t) => { let id = termId.get(t); if (id === undefined) { id = terms.length; termId.set(t, id); terms.push(t); } return id; };
    // pass 1: windows around the counted matches
    const perDoc = new Map(docIds.map((id) => [id, { N: 0, fy: new Map(), ex: [0, 1].map(() => ({ fx: 0, W: 0, fxy: new Map() })) }]));
    for (let e = 0; e < 2; e++) {
      for (const [doc, list] of occ[e]) {
        const d = perDoc.get(doc);
        const byP = new Map();
        for (const o of list) { if (!byP.has(o.passage)) byP.set(o.passage, []); byP.get(o.passage).push(o); }
        for (const [pid, os] of byP) {
          const p = byPassage.get(pid);
          if (!p) continue;
          const toks = reader.tokens(p);
          for (const o of os) {
            const a = o.tok, b = o.tok + o.len;
            if (toks.length < b) continue;
            d.ex[e].fx++;
            for (let j = Math.max(0, a - COLLOC_WINDOW); j < a; j++) { const t = idOf(toks[j]); d.ex[e].fxy.set(t, (d.ex[e].fxy.get(t) ?? 0) + 1); d.ex[e].W++; }
            for (let j = b; j < Math.min(toks.length, b + COLLOC_WINDOW); j++) { const t = idOf(toks[j]); d.ex[e].fxy.set(t, (d.ex[e].fxy.get(t) ?? 0) + 1); d.ex[e].W++; }
            ctx10[e].push({ window: wi, words: contextWords(toks, a, b, { window: OCC_WINDOW, stop, exclude }) });
          }
        }
      }
    }
    // pass 2: slice frequencies of the co-occurring terms, and slice tokens
    const T = terms.length;
    let seen = 0;
    reader.counter(terms).count(passages, (p, n, hits) => {
      if (++seen % 512 === 0) checkpoint();
      const d = perDoc.get(p.document_id);
      d.N += n;
      for (const [id, c] of hits) d.fy.set(id, (d.fy.get(id) ?? 0) + c);
    });
    const stopMask = new Uint8Array(T);
    terms.forEach((t, i) => { if (stop.has(t)) stopMask[i] = 1; });
    const docs = [...perDoc.values()].filter((d) => d.N > 0)
      .map((d) => ({ N: d.N, fy: sparse(d.fy), ex: d.ex.map((x) => ({ fx: x.fx, W: x.W, fxy: sparse(x.fxy) })) }));
    return { ...base, terms, stop: stopMask, docs };
  });
  // C(t): cosine of the mean occurrence vectors in one shared representation (one IDF over both expressions)
  const all = [...ctx10[0], ...ctx10[1]];
  if (all.length) {
    const vecs = represent(all.map((c) => c.words));
    const by = (e, wi) => vecs.filter((_, i) => (i < ctx10[0].length ? 0 : 1) === e && all[i].window === wi && all[i].words.length);
    out.forEach((w, wi) => {
      if (!w.docs) return;
      const a = meanDirection(by(0, wi)), b = meanDirection(by(1, wi));
      w.cos = a && b ? Number(denseCos(a, b).toFixed(4)) : null;
    });
  }
  return out;
}
