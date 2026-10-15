// OWNER: WP4
// tasks/drift.mjs — job 'drift': neighbour overlap and aligned displacement for one comparison (SPEC §4.9).
// params: a Compare request {expr: number[], a: {years, f}, b: {years, f}, toggles?, corpus?} (+ threads?).
//
// Evaluates the same evidence gates as Compare (compare.mjs driftGate). Where they pass, it builds — or
// reuses — one slice space per slice from exactly the slice's documents (translations removed; each needs
// ≥ 3M tokens, ≥ 10 documents, ≥ 5 authors), then computes (b) and (c) with 500 frequency-matched controls
// and the anchor and alignment gates (drift.mjs driftMeasures). Every measure, gated or not, is stored as a
// drift_result row (a gated row has no value: DB CHECK); Compare reads them for this exact comparison and
// data, and adds the verdict with the session's multiplicity-adjusted threshold. Context-share shift (a) is
// computed by Compare itself from a clustering run.

import { formatCount, formatTokens } from '../../../src/shared/format.mjs';
import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { compareContext, driftGate, spaceDocIds } from '../../analysis/compare.mjs';
import { defaultThreads, spaceDocuments } from '../../analysis/cooc.mjs';
import { DRIFT_VERSION, driftMeasures, driftRunParams, SLICE_GATE } from '../../analysis/drift.mjs';
import { gated, tokensHave } from '../../analysis/gates.mjs';
import { loadSpace } from '../../analysis/occvec.mjs';
import { windowStats } from '../../analysis/slices.mjs';
import { tx } from '../../db/open.mjs';
import { buildSpace, ensureStream, sliceGate } from './vectors.mjs';
import { assertInputsUnchanged, retryBusy, runWrites } from '../../analysis/commit.mjs';

export const type = 'drift';
export const { writes, priority } = JOB_TYPES[type];

const COMPUTED = ['neighbor_overlap', 'aligned_displacement'];
/** The measures in the words the reader sees. */
const MEASURE_WORDS = Object.freeze({ neighbor_overlap: 'neighbour overlap', aligned_displacement: 'aligned displacement' });
const CODE_FILES = ['drift.mjs', 'procrustes.mjs', 'compare.mjs', 'bootstrap.mjs'].map((f) => new URL(`../../analysis/${f}`, import.meta.url));

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {object} params a Compare request
 * @returns {Promise<object>} result_json
 */
export async function run(ctx, params) {
  const db = ctx.db;
  ctx.progress(0.01, 'evidence', 'reading the slices');
  const cx = compareContext(db, params);
  const runParams = driftRunParams(cx.runParams);
  const reuse = runWrites(ctx).findReusableRun('drift', { params: runParams, scope: cx.fp.scope, upstream: cx.fp.upstream });
  if (reuse) {
    ctx.progress(1, 'done', `reused drift run ${reuse}`);
    return { run_id: reuse, reused: true };
  }
  const runId = runWrites(ctx).startRun('drift', { pipelineVersion: DRIFT_VERSION, params: runParams, scope: cx.fp.scope, upstream: cx.fp.upstream,
    seed: 42, codeFiles: CODE_FILES });
  const { statsA, statsB } = cx;
  const allTime = windowStats(cx.indexOf('a'), -Infinity, Infinity);
  const gateCtx = { statsA, statsB, jsd: cx.jsd, descriptive: cx.descriptive, sampled: cx.sampled, suggest: () => null,
    evidenceText: cx.evidenceText, allTime, label: cx.label };
  const results = {};
  for (const metric of COMPUTED) {
    const g = driftGate(metric, gateCtx);
    if (g.gate !== 'not_run') results[metric] = g;
  }
  const todo = COMPUTED.filter((m) => !results[m]);
  const spaces = [];
  if (todo.length) {
    const word = cx.exprs.length === 1 && !cx.exprs[0].norm.includes(' ') ? cx.exprs[0].norm : null;
    const selA = spaceDocuments(db, { lang: cx.lang, docIds: spaceDocIds(cx, statsA) });
    const selB = spaceDocuments(db, { lang: cx.lang, docIds: spaceDocIds(cx, statsB) });
    const failA = sliceGate(selA), failB = sliceGate(selB);
    if (!word) {
      for (const m of todo) {
        results[m] = gated('not_run', { needed: { single_word: true }, have: { expression: cx.label },
          note: `Slice spaces hold single words; '${cx.label}' is a phrase or a pooled set of expressions, so it has no row to compare.` });
      }
    } else if (failA || failB) {
      const have = { a: { tokens: selA.tokens, documents: selA.docs, authors: selA.authors }, b: { tokens: selB.tokens, documents: selB.docs, authors: selB.authors } };
      const why = [['A', failA, selA], ['B', failB, selB]].filter(([, f]) => f).map(([s, , sel]) =>
        `slice ${s} has ${tokensHave(sel.tokens)} ${cx.lang} tokens in ${formatCount(sel.docs)} documents by ${formatCount(sel.authors)} authors`).join(' and ');
      for (const m of todo) {
        results[m] = gated('slice_too_small', { needed: { tokens: SLICE_GATE.tokens, documents: SLICE_GATE.docs, authors: SLICE_GATE.authors }, have,
          note: `Not estimated: ${why} (a slice space needs ${formatTokens(SLICE_GATE.tokens)} tokens, ${SLICE_GATE.docs} documents and ${SLICE_GATE.authors} authors, translations removed).` });
      }
    } else {
      const source = await ensureStream(ctx, cx.lang);
      const threads = params?.threads === undefined ? defaultThreads() : Math.max(0, Math.min(8, Number(params.threads) || 0));
      const build = (sel, st, years, lo, span) => buildSpace(ctx, { lang: cx.lang, docIds: sel.docIds, years, pooled: false,
        synthetic: st.synthetic, stats: sel, threads, source,
        onProgress: (f, m) => ctx.progress(lo + span * f, `space ${years[0]}–${years[1]}`, m) });
      const spaceA = await build(selA, statsA, cx.req.a.years, 0.03, 0.4);
      const spaceB = await build(selB, statsB, cx.req.b.years, 0.43, 0.4);
      spaces.push(spaceA, spaceB);
      ctx.progress(0.85, 'measures', 'neighbours, anchors and 500 controls');
      const sa = loadSpace(db, spaceA.space_id, { dir: ctx.paths.spaces });
      const sb = loadSpace(db, spaceB.space_id, { dir: ctx.paths.spaces });
      const m = driftMeasures(sa, sb, word, { step: () => ctx.checkpoint() });
      for (const metric of todo) results[metric] = m[metric];
    }
  }
  ctx.checkpoint();
  const caveats = [];
  if (cx.jsd !== null && cx.jsd > 0.15) caveats.push('composition');
  retryBusy(() => tx(db, () => {
    assertInputsUnchanged(db, runId);
    const ins = db.prepare(`INSERT INTO drift_result (run_id, expression_id, slice_a_json, slice_b_json, metric, value, ci_lo, ci_hi,
      null_percentile, n_a, n_b, docs_a, docs_b, authors_a, authors_b, gate, gate_detail_json, caveats_json)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [metric, r] of Object.entries(results)) {
      const ok = r.gate === 'ok';
      const { gate, value, ci, percentile, metric: _m, n, docs, authors, ...detail } = r;
      ins.run(runId, cx.exprs[0].id, JSON.stringify(cx.req.a), JSON.stringify(cx.req.b), metric, ok ? value : null, ok ? percentile : null,
        statsA.n, statsB.n, statsA.evidenceDocs, statsB.evidenceDocs, statsA.evidenceAuthors.size, statsB.evidenceAuthors.size,
        gate, JSON.stringify(ok ? detail : { needed: r.needed, have: r.have, note: r.note ?? null }), JSON.stringify(caveats));
    }
  }), { checkpoint: () => ctx.checkpoint() });
  const summary = Object.fromEntries(Object.entries(results).map(([m, r]) => [m, r.gate === 'ok'
    ? { gate: 'ok', value: r.value, percentile: r.percentile, ...(m === 'neighbor_overlap' ? { jaccard: r.jaccard } : { anchors: r.anchors, mean_anchor_cos: r.mean_anchor_cos }) }
    : { gate: r.gate }]));
  runWrites(ctx).finishRun(runId, 'succeeded', { metrics: { measures: summary, spaces: spaces.map((s) => ({ space_id: s.space_id, run_id: s.run_id, reused: s.reused })) } });
  // human words in the Jobs tray (fix pass: it read 'neighbor_overlap: ok, aligned_displacement: ok')
  ctx.progress(1, 'done', Object.entries(summary).map(([m, r]) => `${MEASURE_WORDS[m] ?? m.replace(/_/g, ' ')}: ${r.gate === 'ok' ? 'computed'
    : `withheld (${r.gate.replace(/_/g, ' ')})`}`).join(' · '));
  return { run_id: runId, reused: false, measures: summary, spaces };
}
