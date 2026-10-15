// OWNER: WP4
// tasks/cluster.mjs — job 'cluster': context groups (sense hypotheses) of one expression with stability,
// machine labels, windows, shares, transitions and convergence with the corpus's other tracked expressions
// (SPEC §4.8, §1.8). writes and priority come from vocab.JOB_TYPES.
//
// params: {expressionId | expr, params?: {representation?: 'auto'|'tfidf-hash-4096'|'ppmi-svd-pooled', k?: 'auto'|1…8,
//          seed?: number, toggles?: object, with?: number[], collections?: string[], threads?: 0…8}} (inner keys also
//          accepted at top level; threads only changes speed).
// Scope: the expression's counted occurrences (its succeeded materialize run, default exclusions) in ONE medium and
// one representation, so shares are comparable across time without alignment. `collections` (slugs of one medium)
// narrows it; without it the medium holding most of the occurrences is clustered and the others are counted as
// excluded ('other_modality'): contexts in book text, paper abstracts and work titles are not mixed in one model.
// A scope that holds a top-cited-per-cell sample (OpenAlex) gets groups but no windows, shares, transitions or
// convergence across its cells (sampling_design, §10.4). A run with the same params and input fingerprint is reused.
// A run that fails its gate succeeds with no groups and the gate in gate_json: a gated measure has no value (§13 rule 7).
// Everything is computed from one read of the inputs and written at the end; the writes are short and retried
// while another writer holds the lock (analysis/commit.mjs).

import { mulberry32 } from '../../../src/shared/ids.mjs';
import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { convergence, convergenceInputs, CONVERGENCE_CAVEAT, jointWindows } from '../../analysis/convergence.mjs';
import { assertInputsUnchanged, retryBusy, runWrites } from '../../analysis/commit.mjs';
import { gated, SAMPLING_DESIGN_NOTE, THRESHOLDS } from '../../analysis/gates.mjs';
import { assignNearest, meanDirection, packPoints, subsetPacked } from '../../analysis/kmeans.mjs';
import { defaultFitThreads } from '../../analysis/kmeans-pool.mjs';
import { countWords, distinctiveTerms, LABEL_RULE, machineLabelText, RESIDUAL_LABEL } from '../../analysis/labels.mjs';
import { normalizeToggles, resolveExpressions } from '../../analysis/slices.mjs';
import { referenceSilhouette, selectK, STABILITY } from '../../analysis/stability.mjs';
import { coverageIndex, loadOccurrenceContexts, MIN_CONTEXT_WORDS, OCC_WINDOW, TFIDF_REPRESENTATION, tfidfHashVectors } from '../../analysis/tfidf-hash.mjs';
import { assignWindows, buildWindows, decadeCells, detectTransitions, WINDOW_RULE, windowShares } from '../../analysis/transitions.mjs';
import { tx } from '../../db/open.mjs';
import { HttpError } from '../../http/errors.mjs';

export const type = 'cluster';
export const { writes, priority } = JOB_TYPES[type];

/**
 * Pipeline version recorded on clustering runs. 1.1.0: one medium per run, contraction fragments dropped from
 * contexts, PPMI-SVD occurrence vectors weighted by association with the target, a no-groups reference
 * silhouette in the gate, and stability measured only for the k the rule needs.
 */
export const CLUSTER_VERSION = 'cluster@1.1.0';
/** Representation name of pooled PPMI-SVD occurrence vectors (§4.8). */
export const PPMI_REPRESENTATION = 'ppmi-svd-pooled';
/** Above this many usable occurrences the model is fitted on a seeded sample and every occurrence assigned. */
export const FIT_MAX = 5000;
/** Partners evaluated for convergence when `with` is not given (same corpus and language, tracked and counted). */
export const MAX_PARTNERS = 6;

const CODE_FILES = ['tfidf-hash', 'kmeans', 'stability', 'labels', 'transitions', 'convergence', 'slices', 'collocations', 'occvec']
  .map((m) => new URL(`../../analysis/${m}.mjs`, import.meta.url));

function bad(message, field) {
  return new HttpError(400, 'E_VALIDATION', message, 'Send {expressionId, params: {representation, k, seed}}.', { field });
}

/**
 * Normalize job params.
 * @param {object} params
 * @returns {{exprId: number, representation: string, k: number|'auto', seed: number, toggles: object, with: number[]|null}}
 */
export function clusterParams(params = {}) {
  const inner = params.params && typeof params.params === 'object' ? params.params : {};
  const pick = (k) => inner[k] ?? params[k];
  const exprId = Number(params.expressionId ?? params.expr ?? inner.expr);
  if (!(Number.isSafeInteger(exprId) && exprId > 0)) throw bad('A clustering run needs expressionId (a positive integer).', 'expressionId');
  const representation = pick('representation') ?? 'auto';
  if (!['auto', TFIDF_REPRESENTATION, PPMI_REPRESENTATION].includes(representation)) {
    throw bad(`Unknown representation '${representation}'.`, 'params.representation');
  }
  const kRaw = pick('k') ?? 'auto';
  const k = kRaw === 'auto' ? 'auto' : Number(kRaw);
  if (k !== 'auto' && !(Number.isInteger(k) && k >= 1 && k <= STABILITY.kMax)) throw bad(`k must be 'auto' or 1–${STABILITY.kMax}.`, 'params.k');
  const s = Number(pick('seed') ?? 42);
  const seed = Number.isSafeInteger(s) ? s : 42;
  const w = pick('with');
  const withIds = Array.isArray(w) ? [...new Set(w.map(Number).filter((x) => Number.isSafeInteger(x) && x > 0 && x !== exprId))].sort((a, b) => a - b) : null;
  const c = pick('collections');
  if (c !== undefined && c !== null && (!Array.isArray(c) || !c.length || !c.every((x) => typeof x === 'string' && /^[a-z0-9-]{1,64}$/.test(x)))) {
    throw bad('collections must list collection slugs of one medium.', 'params.collections');
  }
  const collections = Array.isArray(c) ? [...new Set(c)].sort() : null;
  // Worker threads for the k-means fits; they change speed, never the result (kmeans-pool.mjs), so not a run parameter.
  const t = params.threads ?? inner.threads;
  const threads = t === undefined ? defaultFitThreads() : Math.max(0, Math.min(8, Number(t) || 0));
  return { exprId, representation, k, seed, toggles: normalizeToggles(pick('toggles')), with: withIds, collections, threads };
}

/**
 * The medium and collections a run clusters: the requested collections (which must share one medium), else the
 * medium holding most of the expression's counted occurrences (ties: running text first).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{collection: number, modality: string}>} items
 * @param {string[]|null} requested collection slugs
 * @returns {{ids: Set<number>, slugs: string[], modality: string|null, sampled: boolean, excluded: number, note: string|null}}
 */
export function clusterScope(db, items, requested) {
  const meta = new Map(db.prepare('SELECT id, slug, modality, sampling FROM collection').all().map((r) => [r.id, r]));
  if (requested) {
    const rows = requested.map((slug) => [...meta.values()].find((m) => m.slug === slug));
    const unknown = requested.filter((_, i) => !rows[i]);
    if (unknown.length) throw bad(`Unknown collection ${unknown.map((u) => `'${u}'`).join(', ')}.`, 'params.collections');
    const media = [...new Set(rows.map((r) => r.modality))];
    if (media.length > 1) throw bad(`The collections mix media (${media.join(', ')}); context groups are found within one medium.`, 'params.collections');
  }
  const byMedium = new Map();
  for (const it of items) {
    const m = meta.get(it.collection)?.modality ?? 'unknown';
    byMedium.set(m, (byMedium.get(m) ?? 0) + 1);
  }
  const rank = (m) => (m === 'text' ? 0 : m === 'abstracts' ? 1 : 2);
  const modality = requested ? meta.get([...meta.values()].find((r) => r.slug === requested[0]).id).modality
    : [...byMedium.entries()].sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]))[0]?.[0] ?? null;
  const ids = new Set(requested ? [...meta.values()].filter((r) => requested.includes(r.slug)).map((r) => r.id)
    : items.filter((it) => meta.get(it.collection)?.modality === modality).map((it) => it.collection));
  const slugs = [...ids].map((id) => meta.get(id).slug).sort();
  const sampled = [...ids].some((id) => meta.get(id).sampling === 'top_cited_per_cell');
  const excluded = items.filter((it) => !ids.has(it.collection)).length;
  const others = [...byMedium.entries()].filter(([m]) => m !== modality);
  const note = !requested && others.length
    ? `Clustered the ${modality ?? 'unknown'} occurrences (${slugs.join(', ')}); ${others.map(([m, n]) => `${n} in ${m}`).join(' and ')} `
      + 'were not clustered with them: context groups are found within one medium. Start a run with params.collections to group another medium.'
    : null;
  return { ids, slugs, modality, sampled, excluded, note };
}

/**
 * Vectors of the usable contexts: PPMI-SVD occurrence vectors (WP4 vectors: occvec.pooledSpaceFor / loadSpace /
 * occurrenceVectors) when a pooled space of the expression's language covers its collections and the request
 * allows it ('auto' or 'ppmi-svd-pooled'), else TF-IDF hash vectors. Returns the representation actually used,
 * with a note whenever it differs from the request.
 */
async function represent(db, expr, items, requested, ctx, collections) {
  const tfidf = (note = null) => ({ name: TFIDF_REPRESENTATION, vectors: tfidfHashVectors(items.map((x) => x.context)).vectors, thin: null, note,
    upstream: [], weighting: 'tf-idf', makeVectors: (ctxs) => tfidfHashVectors(ctxs).vectors });
  if (requested === TFIDF_REPRESENTATION) return tfidf();
  let occvec = null, row = null;
  try {
    occvec = await import('../../analysis/occvec.mjs');
    row = expr.lang ? occvec.pooledSpaceFor(db, expr.lang, { collections }) : null;
  } catch (err) {
    if (err?.name === 'CancelledError') throw err;
    occvec = null;
  }
  if (!row) {
    return tfidf(requested === PPMI_REPRESENTATION ? `No pooled PPMI-SVD space covers '${expr.lang ?? 'any language'}' here; used ${TFIDF_REPRESENTATION}.` : null);
  }
  try {
    const space = occvec.loadSpace(db, row.id, { dir: ctx.paths.spaces });
    const res = occvec.occurrenceVectors(items.map((x) => ({ context: x.context })), space, { weighting: occvec.WEIGHTINGS.assoc });
    if (!Array.isArray(res?.vectors) || res.vectors.length !== items.length) throw new TypeError('occurrenceVectors returned an unexpected shape');
    const covers = collections.every((c) => row.collections.includes(c));
    return { name: res.representation ?? PPMI_REPRESENTATION, vectors: res.vectors, thin: Array.from(res.thin ?? [], Boolean),
      note: covers ? null : `The pooled space #${row.id} was built from ${row.collections.join(', ')}, not from every clustered collection.`,
      upstream: [row.run_id], space: row.id, space_collections: row.collections, weighting: res.weighting, associated: res.associated,
      // Convergence compares two expressions in one representation: no target-specific weighting there.
      makeVectors: (ctxs) => occvec.occurrenceVectors(ctxs.map((c) => ({ context: c })), space).vectors };
  } catch (err) {
    if (err?.name === 'CancelledError') throw err;
    return tfidf(`A pooled PPMI-SVD space exists for '${expr.lang}' but its occurrence vectors are not available (${err?.code ?? err?.message}); used ${TFIDF_REPRESENTATION}.`);
  }
}

/** Expressions to evaluate convergence with: `with`, or the corpus's other counted expressions of the same language. */
function partners(db, expr, withIds) {
  const ids = withIds ?? (expr.lang ? db.prepare(`SELECT e.id FROM expression e JOIN expression_state s ON s.expression_id = e.id
      JOIN analysis_run r ON r.id = s.run_id
    WHERE e.id != ? AND e.lang = ? AND IFNULL(e.corpus_id, 0) = IFNULL(?, 0) AND r.status = 'succeeded' AND s.status = 'ready'
    ORDER BY e.id LIMIT ?`).all(expr.id, expr.lang, expr.corpus_id, MAX_PARTNERS).map((r) => r.id) : []);
  const out = [];
  for (const id of ids) {
    try { out.push(resolveExpressions(db, [id])[0]); } catch { /* not counted yet: skipped */ }
  }
  return out;
}

const round = (x, d = 4) => (x === null || x === undefined || Number.isNaN(x) ? null : Number(x.toFixed(d)));

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {object} params see clusterParams()
 * @returns {Promise<object>} result_json
 */
export async function run(ctx, params) {
  const db = ctx.db;
  const w = runWrites(ctx);
  const p = clusterParams(params);
  const checkpoint = () => ctx.checkpoint();
  ctx.progress(0.01, 'contexts', 'reading occurrences');
  const [expr] = resolveExpressions(db, [p.exprId]);
  const all = loadOccurrenceContexts(db, expr, { toggles: p.toggles, checkpoint });
  const scope = clusterScope(db, all.items, p.collections);
  const loaded = { ...all, items: all.items.filter((x) => scope.ids.has(x.collection)),
    excluded: { ...all.excluded, ...(scope.excluded ? { [p.collections ? 'other_collection' : 'other_modality']: scope.excluded } : {}) } };
  const collSlugs = scope.slugs;
  const usable = loaded.items.filter((x) => x.context.length >= MIN_CONTEXT_WORDS);
  ctx.progress(0.05, 'vectors', `${usable.length} usable contexts of ${loaded.items.length}`);
  const rep = await represent(db, expr, usable, p.representation, ctx, collSlugs);
  const points = [], kept = [];
  usable.forEach((x, i) => { if (!rep.thin?.[i] && rep.vectors[i]) { points.push(rep.vectors[i]); kept.push(x); } });
  const thin = loaded.items.length - kept.length;

  const runParams = { expr: p.exprId, materialize: expr.run, representation: rep.name, space: rep.space ?? null, k: p.k, seed: p.seed,
    toggles: p.toggles, with: p.with, window: OCC_WINDOW, version: CLUSTER_VERSION, collections: p.collections, weighting: rep.weighting,
    reference: rep.name === TFIDF_REPRESENTATION ? 'coordinate-shuffle' : 'gaussian-covariance' };
  const runScope = { expression: p.exprId, collections: collSlugs, langs: loaded.langs, modality: scope.modality, sampled: scope.sampled };
  const upstream = [expr.run, ...rep.upstream];
  const reuse = w.findReusableRun('cluster', { params: runParams, scope: runScope, upstream });
  if (reuse) return { run_id: reuse, reused: true };
  const runId = w.startRun('cluster', { pipelineVersion: CLUSTER_VERSION, params: runParams, scope: runScope, upstream, representation: rep.name,
    seed: p.seed, codeFiles: CODE_FILES });
  try {
    const out = await compute(ctx, { p, expr, loaded, kept, points, thin, rep, runId, scope });
    w.finishRun(runId, 'succeeded', { metrics: out.metrics, gate: out.gate });
    ctx.progress(1, 'done', out.summary);
    return { run_id: runId, reused: false, ...out.result };
  } catch (err) {
    if (err?.name !== 'CancelledError') {
      try { w.finishRun(runId, 'failed'); } catch { /* the worker closes open runs */ }
    }
    throw err;
  }
}

/** Gate of §4.8/§4.11, or null when clustering may proceed. */
function clusterGate(kept, thin) {
  const T = THRESHOLDS.clustering;
  const docs = new Set(kept.map((x) => x.doc)).size;
  if (kept.length >= T.occurrences && docs >= T.documents) return null;
  const thinNote = thin ? ` (${thin} more had fewer than ${MIN_CONTEXT_WORDS} usable context words)` : '';
  return gated(docs < T.documents ? 'insufficient_documents' : 'insufficient_occurrences', {
    needed: { occurrences: T.occurrences, documents: T.documents }, have: { occurrences: kept.length, documents: docs },
    note: `Clustering unavailable: ${kept.length} occurrences in ${docs} documents.${thinNote}` });
}

/** Fit (on a seeded sample above FIT_MAX), choose k, and say why when there is no structure. */
async function fitGroups(ctx, p, kept, packed) {
  let fitIdx = null;
  if (packed.n > FIT_MAX) {
    const rng = mulberry32(p.seed);
    const idx = Array.from({ length: packed.n }, (_, i) => i);
    for (let i = 0; i < FIT_MAX; i++) { const j = i + Math.floor(rng() * (idx.length - i)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    fitIdx = idx.slice(0, FIT_MAX).sort((a, b) => a - b);
  }
  const fitPoints = fitIdx ? subsetPacked(packed, fitIdx) : packed;
  const fitDocs = (fitIdx ? fitIdx.map((i) => kept[i]) : kept).map((x) => x.doc);
  ctx.progress(0.1, 'k', 'choosing k');
  const sel = await selectK(fitPoints, fitDocs, { k: p.k, seed: p.seed, threads: p.threads, signal: ctx.signal, checkpoint: () => ctx.checkpoint(),
    onProgress: (f, m) => ctx.progress(0.1 + 0.6 * f, 'stability', m, { k: p.k }) });
  const candidates = sel.candidates.map((c) => ({ k: c.k, silhouette: round(c.silhouette), mean_ari: round(c.meanAri), stable: c.stable,
    stability: c.perClusterStability ? c.perClusterStability.map((x) => round(x, 3)) : null, subsamples: c.subsamples,
    ...(c.skipped ? { stability_skipped: c.skipped } : {}) }));
  const selection = { rule: `k ∈ {1…${Math.max(1, Math.min(STABILITY.kMax, Math.floor(fitPoints.n / STABILITY.perK)))}}: largest mean cosine silhouette among stable k (mean ARI ≥ ${STABILITY.minAri}); below ${STABILITY.minSilhouette} → k = 1`,
    reason: sel.reason, candidates, fit_sample: fitIdx ? FIT_MAX : null, init: 'greedy k-means++', restarts: 10,
    subsamples: STABILITY.subsamples, subsample_share: STABILITY.share, subsample_restarts: STABILITY.subsampleRestarts, threads: sel.threads };
  const chosen = sel.best;
  const best = candidates.reduce((x, y) => (y.silhouette > (x?.silhouette ?? -Infinity) ? y : x), null);
  // The no-groups reference at the chosen k (or, when none is chosen, at the k with the best silhouette).
  const refK = chosen?.k ?? best?.k ?? null;
  if (refK !== null && refK > 1) {
    ctx.progress(0.7, 'reference', `k = ${refK}: reference clustering without groups`);
    const ref = referenceSilhouette(fitPoints, refK, { seed: p.seed, checkpoint: () => ctx.checkpoint() });
    selection.reference = { k: ref.k, silhouette: round(ref.silhouette), points: ref.points, method: ref.method };
  }
  if (sel.k > 1 && chosen && chosen.stable && chosen.silhouette >= STABILITY.minSilhouette) {
    const ref = selection.reference?.silhouette ?? null;
    if (ref === null || chosen.silhouette > ref) return { selection, chosen, k: sel.k, gate: null };
    const gate = gated('no_cluster_structure', { needed: { silhouette: STABILITY.minSilhouette, above_reference: ref },
      have: { silhouette: round(chosen.silhouette), mean_ari: round(chosen.meanAri), k_tried: candidates.map((c) => c.k) },
      note: `No separable context groups: k = ${chosen.k} reaches silhouette ${round(chosen.silhouette)}, but a cloud of the same shape without groups reaches ${ref}.` });
    return { selection, chosen: null, k: 1, gate };
  }
  const unstable = candidates.filter((c) => c.stable === false && c.silhouette >= STABILITY.minSilhouette);
  const why = !candidates.length ? `too few occurrences for k ≥ 2 (n = ${fitPoints.n}; k ≤ ⌊n/20⌋)`
    : chosen && !chosen.stable ? `k = ${chosen.k} is not stable (mean ARI ${round(chosen.meanAri)}; needs ${STABILITY.minAri})`
      : unstable.length ? `${unstable.map((c) => `k = ${c.k} reached silhouette ${c.silhouette} but was not stable (mean ARI ${c.mean_ari}; needs ${STABILITY.minAri})`).join('; ')}; no other k reached ${STABILITY.minSilhouette}`
        : `best silhouette ${best?.silhouette}; needs ${STABILITY.minSilhouette}`;
  const gate = gated('no_cluster_structure', { needed: { silhouette: STABILITY.minSilhouette, mean_ari: STABILITY.minAri },
    have: { silhouette: best?.silhouette ?? null, mean_ari: best?.mean_ari ?? null, k_tried: candidates.map((c) => c.k) },
    note: `No separable context groups: ${why}.` });
  return { selection, chosen: null, k: 1, gate };
}

/** Final assignment, residual / unstable status, machine labels and the display order of the groups. */
function describeGroups(kept, packed, chosen, k) {
  const near = assignNearest(packed, chosen.fit.centroids);
  const n = packed.n;
  const residualMin = Math.max(10, 0.05 * n);
  const members = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) members[near.assign[i]].push(i);
  const pooled = countWords(kept.map((x) => x.context));
  const groups = members.map((idx, c) => {
    const inCounts = countWords(idx.map((i) => kept[i].context));
    const rest = new Map(pooled);
    for (const [t, f] of inCounts) { const r = rest.get(t) - f; if (r > 0) rest.set(t, r); else rest.delete(t); }
    const distinctive = distinctiveTerms(inCounts, rest, { prior: pooled });
    const dated = idx.filter((i) => kept[i].y_lo !== null);
    const docCounts = new Map();
    for (const i of idx) docCounts.set(kept[i].doc, (docCounts.get(kept[i].doc) ?? 0) + 1);
    const stability = chosen.perClusterStability[c];
    const residual = idx.length < residualMin;
    return { c, size: idx.length, docs: docCounts.size, top_doc_share: idx.length ? Math.max(...docCounts.values()) / idx.length : 0,
      stability, silhouette: chosen.perClusterSilhouette[c],
      first: dated.length ? Math.min(...dated.map((i) => kept[i].y_lo)) : null, last: dated.length ? Math.max(...dated.map((i) => kept[i].y_hi)) : null,
      status: residual ? 'residual' : stability < STABILITY.unstableBelow ? 'unstable' : 'hypothesis', residual, distinctive,
      label: residual ? RESIDUAL_LABEL : machineLabelText(distinctive.slice(0, LABEL_RULE.top).map((d) => d.term)) };
  });
  // display order: residual last, then first observed, then size
  const order = [...groups].sort((a, b) => (a.residual - b.residual) || ((a.first ?? Infinity) - (b.first ?? Infinity)) || b.size - a.size || a.c - b.c);
  return { near, groups, order };
}

/** Windows, shares and transitions of the dated members (never across the cells of a top-cited sample). */
function timeline(db, p, expr, kept, points, chosen, near, groups, k, scope, coverage) {
  if (scope.sampled) {
    return { windows: [], shares: [], transitions: [], tooCoarse: 0, undated: kept.filter((x) => x.y_lo === null).length,
      refused: gated('sampling_design', { needed: { comparison: 'within one OpenAlex cell' }, have: { collections: scope.slugs },
        note: `${SAMPLING_DESIGN_NOTE} Context-group shares, transitions and convergence across its periods are not computed; the groups describe the sample as a whole.` }) };
  }
  const datedIdx = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].y_lo !== null) datedIdx.push(i);
  const datedItems = datedIdx.map((i) => kept[i]);
  const windows = buildWindows(decadeCells(datedItems, coverage));
  const place = assignWindows(datedItems, windows);
  const placed = [];
  const wN = new Int32Array(windows.length);
  datedIdx.forEach((i, j) => { if (place[j] >= 0) { placed.push({ window: place[j], cluster: near.assign[i], doc: kept[i].doc, i }); wN[place[j]]++; } });
  windows.forEach((w, wi) => { w.n = wN[wi]; if (w.state !== 'uncovered') w.state = wN[wi] >= WINDOW_RULE.minN ? 'measured' : 'thin'; });
  const shares = windowShares(placed, windows, k, { seed: p.seed });
  const byWindowCluster = new Map();
  for (const x of placed) {
    const key = `${x.window}|${x.cluster}`;
    if (!byWindowCluster.has(key)) byWindowCluster.set(key, []);
    byWindowCluster.get(key).push(x);
  }
  const windowCentroids = windows.map((w, wi) => (w.state !== 'measured' ? null : Array.from({ length: k }, (_, c) => {
    const pts = (byWindowCluster.get(`${wi}|${c}`) ?? []).map((x) => points[x.i]);
    return { vec: meanDirection(pts), n: pts.length };
  })));
  const firstYear = (c, wi) => {
    const ys = (byWindowCluster.get(`${wi}|${c}`) ?? []).map((x) => kept[x.i].y_lo);
    return ys.length ? Math.min(...ys) : null;
  };
  const transitions = detectTransitions({ windows, shares, centroids: chosen.fit.centroids, windowCentroids,
    residual: groups.map((g) => g.residual), firstYear });
  return { windows, shares, transitions, tooCoarse: datedIdx.length - placed.length, undated: kept.length - datedIdx.length, coverage };
}

/**
 * Convergence with each partner expression (independent of this expression's clustering gate).
 * @param {() => (lo: number, hi: number) => number} coverage the clustered collections' coverage index (coverageIndex), read on first use
 */
function convergencePairs(ctx, p, expr, loaded, rep, scope, coverage) {
  const db = ctx.db;
  const checkpoint = () => ctx.checkpoint();
  if (scope.sampled) return [];
  const ids = [...scope.ids];
  const f = scope.slugs.length ? `coll:${scope.slugs.join(',')}` : '';
  const xItems = loaded.items.filter((x) => x.y_lo !== null);
  const out = [];
  const mates = partners(db, expr, p.with);
  for (const [mi, y] of mates.entries()) {
    checkpoint();
    ctx.progress(0.82 + 0.12 * (mi / Math.max(1, mates.length)), 'convergence', `convergence with '${y.surface}'`);
    const yItems = loadOccurrenceContexts(db, y, { toggles: p.toggles, contexts: false, collections: ids, checkpoint }).items.filter((x) => x.y_lo !== null);
    const fit = (it, c) => it.y_lo >= c.lo && it.y_hi <= c.hi;
    const cells = decadeCells([...xItems, ...yItems], coverage()).map((c) => ({ lo: c.lo, hi: c.hi, covered: c.covered,
      n: [xItems.filter((it) => fit(it, c)).length, yItems.filter((it) => fit(it, c)).length] }));
    const pairWindows = jointWindows(cells);
    const result = pairWindows.length < 2
      ? gated('insufficient_occurrences', { needed: { occurrences_per_window: THRESHOLDS.collocates.occurrences, windows: 2 },
        have: { windows: pairWindows.length },
        note: `Convergence needs both expressions to have ≥ ${THRESHOLDS.collocates.occurrences} occurrences in at least two windows.`, windows: pairWindows })
      : convergence(convergenceInputs(db, { exprs: [expr, y], windows: pairWindows, toggles: p.toggles, f, dir: ctx.paths.tokens, checkpoint,
        represent: rep.makeVectors }), { seed: p.seed, checkpoint });
    out.push({ with: y, result });
  }
  return out;
}

/** Write every row of the run in one transaction; returns the stored group ids in display order. */
function store(db, runId, expr, { kept, fitted, timelineOut, conv }) {
  return tx(db, () => {
    assertInputsUnchanged(db, runId);
    const insWindow = db.prepare(`INSERT INTO time_window (run_id, label, lo_year, hi_year, scheme, n_occ, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insTrans = db.prepare(`INSERT INTO cluster_transition (run_id, kind, from_cluster, to_cluster, window_id, score, ci_lo, ci_hi, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const clusterId = new Map();
    if (fitted) {
      const { near, order } = fitted;
      const insCluster = db.prepare(`INSERT INTO sense_cluster (run_id, expression_id, ord, label_auto, distinctive_json, size, n_docs,
        top_doc_share, stability, silhouette, first_year, last_year, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      order.forEach((g, i) => {
        const r = insCluster.run(runId, expr.id, i + 1, g.label, JSON.stringify(g.distinctive), g.size, g.docs, round(g.top_doc_share),
          round(g.stability), round(g.silhouette), g.first, g.last, g.status);
        clusterId.set(g.c, Number(r.lastInsertRowid));
      });
      const insMember = db.prepare('INSERT INTO cluster_member (cluster_id, occurrence_id, cos, margin) VALUES (?, ?, ?, ?)');
      for (let i = 0; i < kept.length; i++) insMember.run(clusterId.get(near.assign[i]), kept[i].occ, round(near.cos[i]), round(near.margin[i]));
      const { windows, shares, transitions } = timelineOut;
      const windowId = windows.map((w) => Number(insWindow.run(runId, w.label, w.lo, w.hi, w.scheme, w.n, w.tokens).lastInsertRowid));
      const insShare = db.prepare('INSERT INTO cluster_share (cluster_id, window_id, n, share, ci_lo, ci_hi) VALUES (?, ?, ?, ?, ?, ?)');
      for (const s of shares) for (const x of s.clusters) insShare.run(clusterId.get(x.cluster), windowId[s.window], x.n, round(x.share), round(x.ci[0]), round(x.ci[1]));
      for (const t of transitions) {
        const nearest = t.nearest ? { cluster: clusterId.get(t.nearest.cluster), cosine: t.nearest.cosine } : null;
        const apart = t.detail?.apart ? { window: windowId[t.detail.apart.window], cosine: t.detail.apart.cosine } : null;
        insTrans.run(runId, t.kind, t.from === null ? null : clusterId.get(t.from), t.to === null ? null : clusterId.get(t.to), windowId[t.window],
          t.score, null, null, JSON.stringify({ year: t.year, nearest, apart }));
      }
    }
    const insDrift = db.prepare(`INSERT INTO drift_result (run_id, expression_id, slice_a_json, slice_b_json, metric, value, ci_lo, ci_hi,
      null_percentile, n_a, n_b, docs_a, docs_b, authors_a, authors_b, gate, gate_detail_json, caveats_json)
      VALUES (?, ?, ?, ?, 'convergence', ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`);
    for (const { with: y, result: r } of conv) {
      const ok = r.gate === 'ok';
      const wf = ok ? r.windows[r.first] : null, wl = ok ? r.windows[r.last] : null;
      const detail = { with: y.id, surface: y.surface, windows: r.windows, rule: r.rule ?? null, resamples: r.resamples ?? null,
        reported: ok ? r.reported : false, needed: ok ? null : r.needed, have: ok ? null : r.have, note: r.note ?? null,
        suggestion: ok ? null : r.suggestion ?? null };
      insDrift.run(runId, expr.id, JSON.stringify(ok ? { years: [wf.lo, wf.hi], label: wf.label, with: y.id } : { with: y.id }),
        JSON.stringify(ok ? { years: [wl.lo, wl.hi], label: wl.label, with: y.id } : { with: y.id }),
        ok ? r.value : null, ok ? r.ci[0] : null, ok ? r.ci[1] : null, ok ? wf.n[0] : null, ok ? wl.n[0] : null,
        r.gate, JSON.stringify(detail), JSON.stringify([CONVERGENCE_CAVEAT]));
      if (ok && r.reported) {
        const wid = Number(insWindow.run(runId, wl.label, wl.lo, wl.hi, 'slice', wl.n[0] + wl.n[1], null).lastInsertRowid);
        insTrans.run(runId, 'convergence', null, null, wid, r.value, r.ci[0], r.ci[1],
          JSON.stringify({ with: y.id, surface: y.surface, first: wf.label, last: wl.label, J: [wf.J, wl.J], C: [wf.C, wl.C] }));
      }
    }
    return fitted ? fitted.order.map((g) => clusterId.get(g.c)) : [];
  });
}

async function compute(ctx, { p, expr, loaded, kept, points, thin, rep, runId, scope }) {
  const db = ctx.db;
  const metrics = { occurrences: loaded.items.length, clustered: kept.length, context_thin: thin, excluded: loaded.excluded,
    documents: new Set(kept.map((x) => x.doc)).size, sampled_rows: loaded.sampled, representation: rep.name,
    representation_note: rep.note, weighting: rep.weighting, associated_words: rep.associated ?? null, space: rep.space ?? null,
    window: `±${OCC_WINDOW} tokens`, min_context_words: MIN_CONTEXT_WORDS,
    scope: { modality: scope.modality, collections: scope.slugs, sampled: scope.sampled, note: scope.note } };
  let gate = clusterGate(kept, thin);
  let fitted = null, timelineOut = null, k = null;
  const packed = packPoints(points);
  // tokens per dated interval of the clustered collections: read once, for the windows and for convergence
  let covIndex = null;
  const coverage = () => (covIndex ??= coverageIndex(db, expr, { toggles: p.toggles, collections: [...scope.ids] }));
  if (!gate) {
    const fit = await fitGroups(ctx, p, kept, packed);
    Object.assign(metrics, { k: fit.k, selection: fit.selection });
    gate = fit.gate;
    k = fit.k;
    if (!gate) {
      ctx.progress(0.72, 'labels', 'assigning and labelling');
      fitted = describeGroups(kept, packed, fit.chosen, k);
      ctx.progress(0.78, 'windows', 'windows and shares');
      ctx.checkpoint();
      timelineOut = timeline(db, p, expr, kept, points, fit.chosen, fitted.near, fitted.groups, k, scope, coverage());
      const w = timelineOut.windows;
      Object.assign(metrics, { silhouette: round(fit.chosen.silhouette), mean_ari: round(fit.chosen.meanAri),
        windows: { total: w.length, measured: w.filter((x) => x.state === 'measured').length, thin: w.filter((x) => x.state === 'thin').length,
          uncovered: w.filter((x) => x.state === 'uncovered').length },
        date_too_coarse: timelineOut.tooCoarse, undated: timelineOut.undated, transitions: timelineOut.transitions.length,
        ...(timelineOut.refused ? { windows_gate: timelineOut.refused } : {}) });
    }
  }
  const conv = convergencePairs(ctx, p, expr, loaded, rep, scope, coverage);
  Object.assign(metrics, { convergence: conv.map((c) => ({ with: c.with.id, gate: c.result.gate, reported: c.result.reported ?? false })),
    convergence_pairs: conv.length, ...(scope.sampled ? { convergence_note: 'Not evaluated: the scope is a top-cited sample per cell (sampling_design).' } : {}) });
  ctx.progress(0.96, 'store', fitted ? `${k} context groups` : 'gated');
  const clusters = retryBusy(() => store(db, runId, expr, { kept, fitted, timelineOut, conv }), { checkpoint: () => ctx.checkpoint() });
  const summary = gate ? gate.note : `${k} context groups`;
  return { gate: { cluster: gate ?? { gate: 'ok' } }, metrics, summary,
    result: { gate: gate ? gate.gate : 'ok', k: gate ? (k === 1 ? 1 : null) : k, clusters, windows: timelineOut?.windows.length ?? 0,
      transitions: timelineOut?.transitions.length ?? 0, convergence: metrics.convergence } };
}
