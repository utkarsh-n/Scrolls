// OWNER: WP5
// tasks/reuse-index.mjs — job 'reuse-index' (SPEC §4.7): the global reuse index over a collection set.
//
//  1. exact quotations — winnowing (k = 8, w = 6) of every document's quality='ok' text/abstract stream; fingerprint
//     groups of 2–25 documents give seeds; seed-and-extend keeps maximal common runs; a run of ≥ 13 tokens is an exact
//     quotation (both dated, one earlier: B → A computed; overlapping or undated: shared_wording) (lineage/exact.mjs);
//  2. near quotations — sentence units (≥ 6 tokens), MinHash 128 over word 3-shingles, LSH 32 × 4, verified by
//     Smith–Waterman ≥ 0.75 of the shorter unit and 3-shingle Jaccard ≥ 0.5 (lineage/near.mjs; its index is stored in
//     derived/reuse/run-<id>/ for the targeted trace);
//  3. attribution cues — explicit_citation 'proposed' + a citation_cue row, never documented (lineage/cue-links.mjs);
//  4. competing sources become hypothesis groups.
// Not quotations, and counted with samples in the run's metrics (lineage/filters.mjs): duplicates (dup_of),
// same-document pairs, same-work editions, reprints (an edition or collection holding most of another text, judged on
// exact runs and near sentences together), structure (numbering, tables of contents), production-line text
// (transcriber's notes, publisher's advertisements, series addenda), lists of names or titles, short near matches
// (stock phrases), and text shared by more than 25
// documents (boilerplate and commonplaces: the "widely shared text" node). A pair a targeted trace already linked is
// reported, not duplicated.
// Rows stay invisible until the run succeeds; then they get their 'create' revisions, people's reviews of the rows of
// the earlier run of the same scope are carried over (lineage/carry.mjs), and that run becomes 'superseded' (saved
// views that pinned it still resolve its rows).

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { stmt, tx } from '../../db/open.mjs';
import { carryReviews } from '../../lineage/carry.mjs';
import { classifyCandidate, groupCompetingSources, insertAlgorithmRelationship, METHODS, writeCreateRevisions } from '../../lineage/classify.mjs';
import { ScopeCorpus, scopeCollectionIds, scopeDocuments } from '../../lineage/corpus.mjs';
import { cueLinks } from '../../lineage/cue-links.mjs';
import { FLAG, fingerprintCorpus, groupFingerprints, verifySeeds } from '../../lineage/exact.mjs';
import { ExclusionLog, isReprint, PRODUCTION, REPRINT, sameWorkChecker } from '../../lineage/filters.mjs';
import { acceptNear, NEAR, nearVerified, writeNearIndex } from '../../lineage/near.mjs';

export const type = 'reuse-index';
export const { writes, priority } = JOB_TYPES[type];

/** Pipeline version recorded on the run. */
export const PIPELINE_VERSION = 'reuse-index@1.1.0';

const DEFAULTS = Object.freeze({
  k: 8, w: 6, exactMin: 13, maxGroupDocs: 25, near: true, maxUnits: 8_000_000, cues: true, cueMinRun: 4, cueWindow: 30,
  production: true, reprints: true,
});
const BATCH_ROWS = 500;

/** A visible link of a targeted trace between the same passages (reported, not duplicated). */
function traceLinkChecker(db) {
  const q = stmt(db, `SELECT 1 AS x FROM relationship r JOIN analysis_run a ON a.id = r.run_id WHERE a.stage = 'trace' AND a.status = 'succeeded'
    AND r.rel_type = ? AND r.src_type = 'passage' AND r.src_ref = ? AND r.dst_type = 'passage' AND r.dst_ref = ? LIMIT 1`);
  const any = stmt(db, "SELECT 1 AS x FROM analysis_run WHERE stage = 'trace' AND status = 'succeeded' LIMIT 1").get();
  return any ? (relType, src, dst) => Boolean(q.get(relType, String(src), String(dst))) : () => false;
}

/** Insert rows in transactions of BATCH_ROWS (spans hold document texts: never keep a whole scope's rows alive). */
function batcher(ctx) {
  let batch = [];
  const flush = () => {
    if (!batch.length) return;
    const b = batch;
    batch = [];
    tx(ctx.db, () => { for (const r of b) insertAlgorithmRelationship(ctx.db, r); });
    ctx.checkpoint();
  };
  return { push(row) { batch.push(row); if (batch.length >= BATCH_ROWS) flush(); }, flush };
}

/**
 * Run the reuse index.
 * @param {object} ctx TaskCtx (db, progress, checkpoint, startRun, finishRun, findReusableRun, paths)
 * @param {{collections?: string[]|null, near?: boolean, cues?: boolean, exactMin?: number, maxUnits?: number, production?: boolean,
 *   reprints?: boolean, force?: boolean}} params
 * @returns {Promise<object>} result_json: run id and counts
 */
export async function run(ctx, params = {}) {
  const db = ctx.db;
  const p = { ...DEFAULTS, ...Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v !== undefined)) };
  const collections = Array.isArray(p.collections) && p.collections.length ? p.collections.map(String) : null;
  const runParams = { k: p.k, w: p.w, exact_min: p.exactMin, max_group_docs: p.maxGroupDocs, near: p.near, near_score: NEAR.minScore,
    near_jaccard: NEAR.minJaccard, near_min_tokens: NEAR.minTokens, near_min_content: NEAR.minContent, near_max_bucket: NEAR.maxBucket,
    near_max_docs: NEAR.maxDocs, max_units: p.maxUnits, cues: p.cues, cue_min_run: p.cueMinRun,
    production: p.production ? { min_docs: PRODUCTION.minDocs, edge_share: PRODUCTION.edgeShare, run_share: PRODUCTION.runShare,
      edge: PRODUCTION.edge, min_doc_tokens: PRODUCTION.minDocTokens } : false,
    reprints: p.reprints ? { min_tokens: REPRINT.minTokens, share: REPRINT.share } : false };
  const scope = { collections };
  const reusable = ctx.findReusableRun?.('reuse-index', { params: runParams, scope });
  if (reusable && params.force !== true) return { run_id: reusable, reused: true };
  const runId = ctx.startRun('reuse-index', { pipelineVersion: PIPELINE_VERSION, params: runParams, scope });
  const started = Date.now();

  const { docs, tokens: total } = scopeDocuments(db, scopeCollectionIds(db, collections));
  const corpus = new ScopeCorpus(db, docs, total, { units: p.near, maxUnits: p.maxUnits });
  const sameWork = sameWorkChecker(db);
  const log = new ExclusionLog();
  const traceLinked = traceLinkChecker(db);
  const counts = { documents: docs.length, tokens: 0, fingerprints: 0, production_groups: 0, widespread_groups: 0, seeds: 0,
    pairs_checked: 0, same_work_pairs: 0, reprint_pairs: 0, exact_runs: 0, structural_runs: 0, list_runs: 0, production_runs: 0,
    widely_shared_runs: 0, exact: 0, shared_wording: 0, existing_links: 0, near_units: 0, near_candidates: 0, near_aligned: 0, near: 0,
    near_short: 0, near_lists: 0, near_production_units: 0, near_commonplace_units: 0, near_structural: 0, cue_matches: 0,
    cue_citations: 0, cue_groups: 0, groups: 0,
    near_skipped: null };

  // ── 1. exact: fingerprints, groups, verified runs per document pair ──
  const fp = fingerprintCorpus(ctx, corpus, { k: p.k, w: p.w, capacity: Math.max(1024, Math.ceil(total * 0.32)) });
  counts.tokens = fp.tokens;
  counts.fingerprints = fp.n;
  const grouped = groupFingerprints(ctx, fp, { maxGroupDocs: p.maxGroupDocs, production: p.production, sameWork, docs, counts });
  ctx.progress(0.35, 'verify', `${counts.seeds.toLocaleString('en-US')} seeds`);
  const docPairs = verifySeeds(ctx, corpus, fp, grouped, { exactMin: p.exactMin, k: p.k, w: p.w, log, counts });
  ctx.progress(0.5, 'exact', `${docPairs.size} document pairs share ≥ ${p.exactMin} tokens`);

  // ── 2. near: aligned sentence pairs (nothing written yet) ──
  let near = null;
  if (p.near) {
    if (corpus.unitsOverflow) {
      counts.near_skipped = `near-quotation pass skipped: more than ${p.maxUnits.toLocaleString('en-US')} sentence units; use the targeted trace`;
    } else {
      ctx.progress(0.55, 'near', `${corpus.unitCount.toLocaleString('en-US')} sentence units`);
      near = nearVerified(corpus, { fp: { positions: fp.posCol, flags: grouped.flags, docFp: fp.docFp, k: p.k, w: p.w, mask: FLAG.PROD | FLAG.WIDE },
        checkpoint: () => ctx.checkpoint(), progress: (f, msg) => ctx.progress(0.55 + 0.3 * f, 'near', msg) });
      Object.assign(counts, { near_units: near.counts.units, near_candidates: near.counts.candidates, near_aligned: near.counts.aligned,
        near_big_buckets: near.counts.big_buckets, near_production_units: near.counts.production_units });
    }
  }

  // ── 3. reprints: an edition or a collection, judged on exact runs and aligned sentences together ──
  const reprintDocs = p.reprints ? findReprints(corpus, docPairs, near?.verified ?? [], { log, counts }) : new Set();
  let nearAccepted = [];
  if (near) {
    const [uDoc] = corpus.units.cols;
    const a = acceptNear(corpus, near.verified, { log, exclude: (u, v) => {
      const [da, db] = uDoc[u] < uDoc[v] ? [uDoc[u], uDoc[v]] : [uDoc[v], uDoc[u]];
      return reprintDocs.has(`${da}:${db}`) || sameWork(corpus.docs[da], corpus.docs[db]);
    } });
    nearAccepted = a.pairs;
    Object.assign(counts, { near_structural: a.counts.structural, near_short: a.counts.short_matches, near_lists: a.counts.lists, near_commonplace_units: a.counts.commonplace_units, near_production_units: counts.near_production_units + a.counts.production_units });
  }

  // ── 4. write exact quotations / shared wording ──
  const exactPairs = writeExact(ctx, { corpus, docPairs, reprintDocs, runId, counts, traceLinked });
  ctx.progress(0.88, 'write', `${(counts.exact + counts.shared_wording).toLocaleString('en-US')} exact links written`);

  // ── 5. write near quotations; store the near index ──
  const runDir = path.join(ctx.paths.reuse, `run-${runId}`);
  let indexFiles = null;
  if (near) {
    writeNear(ctx, { corpus, pairs: nearAccepted, exactPairs, runId, counts, traceLinked });
    if (near.index) {
      try { indexFiles = writeNearIndex(runDir, corpus, near.index); } catch (err) { ctx.log?.('warn', `near index not stored: ${err.message}`); }
    }
  }

  // ── 6. attribution cues ──
  if (p.cues) cueLinks(ctx, { corpus, runId, counts, minTokens: p.cueMinRun, window: p.cueWindow,
    skip: (s, d) => { const hit = traceLinked('explicit_citation', s, d); if (hit) counts.existing_links++; return hit; } });

  // ── 7. competing sources, revisions, carried reviews, supersede, finish ──
  ctx.checkpoint();
  counts.same_work_pairs = sameWork.count();
  const metrics = tx(db, () => {
    counts.groups = groupCompetingSources(db, runId).length;
    const revisions = writeCreateRevisions(db, runId);
    const previous = stmt(db, `SELECT id FROM analysis_run WHERE stage = 'reuse-index' AND status = 'succeeded'
      AND scope_json = (SELECT scope_json FROM analysis_run WHERE id = ?) AND id <> ?`).all(runId, runId).map((r) => r.id);
    const carried = carryReviews(db, { fromRuns: previous, toRun: runId });
    if (previous.length) {
      stmt(db, "UPDATE analysis_run SET status = 'superseded' WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(previous));
    }
    const m = { ...counts, relationships: revisions, superseded_runs: previous.length, carried_reviews: carried,
      exclusions: { ...log.items, same_work: sameWork.samples() }, index: indexFiles, duration_ms: Date.now() - started };
    ctx.finishRun(runId, 'succeeded', { metrics: m });
    return m;
  });
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'metrics.json'), JSON.stringify({ run: runId, params: runParams, scope, metrics }, null, 1));
  } catch { /* the derived summary is a convenience; the run row holds the metrics */ }
  ctx.progress(1, 'done', `${metrics.relationships} links (exact ${counts.exact}, shared wording ${counts.shared_wording}, near ${counts.near}, cues ${counts.cue_citations})`);
  return { run_id: runId, ...metrics };
}

/**
 * Document pairs where one text reprints most of the other: tokens covered on the shorter side by exact runs plus
 * near-matched sentences reach the REPRINT thresholds.
 * @returns {Set<string>} 'da:db' with da < db (document indexes)
 */
function findReprints(corpus, docPairs, nearList, { log, counts }) {
  const [uDoc, uT0, uT1] = corpus.units?.cols ?? [];
  const nearCover = new Map(); // 'da:db' → Map(unit on the shorter side → tokens)
  for (const x of nearList) {
    const [du, dv] = [uDoc[x.u], uDoc[x.v]];
    const key = du < dv ? `${du}:${dv}` : `${dv}:${du}`;
    const unit = corpus.docLength(du) <= corpus.docLength(dv) ? x.u : x.v;
    if (!nearCover.has(key)) nearCover.set(key, new Map());
    nearCover.get(key).set(unit, uT1[unit] - uT0[unit]);
  }
  const out = new Set();
  for (const key of new Set([...docPairs.keys(), ...nearCover.keys()])) {
    const [da, db] = key.split(':').map(Number);
    const shorter = Math.min(corpus.docLength(da), corpus.docLength(db));
    const exact = docPairs.get(key)?.covered ?? 0;
    const nearTokens = [...(nearCover.get(key)?.values() ?? [])].reduce((s, n) => s + n, 0);
    const shared = Math.min(shorter, exact + nearTokens);
    if (!isReprint(shared, shorter)) continue;
    out.add(key);
    counts.reprint_pairs++;
    log.add('reprint', `${corpus.docs[da].title} · ${corpus.docs[db].title}`, { shared_tokens: shared, shorter_tokens: shorter });
  }
  return out;
}

/** Exact quotations / shared wording: one link per passage pair, its five longest runs as evidence. */
function writeExact(ctx, { corpus, docPairs, reprintDocs, runId, counts, traceLinked }) {
  const pairRuns = new Map(); // 'passageA:passageB' → runs
  for (const [key, dp] of docPairs) {
    if (reprintDocs.has(key)) continue;
    counts.exact_runs += dp.runs.length;
    for (const g of dp.runs) {
      const k = `${corpus.passageAt(g.a0).id}:${corpus.passageAt(g.b0).id}`;
      if (!pairRuns.has(k)) pairRuns.set(k, []);
      pairRuns.get(k).push(g);
    }
  }
  const rows = batcher(ctx);
  for (const runs of pairRuns.values()) {
    runs.sort((x, y) => y.len - x.len);
    const best = runs[0];
    const sa = corpus.span(best.a0, best.a1), sb = corpus.span(best.b0, best.b1);
    const c = classifyCandidate({ a: { passage: sa.passage, doc: sa.doc }, b: { passage: sb.passage, doc: sb.doc }, kind: 'exact' });
    if (traceLinked(c.rel_type, c.src.passage, c.dst.passage)) { counts.existing_links++; continue; }
    const srcIsA = c.src.passage === sa.passage;
    const evidence = runs.slice(0, 5).flatMap((r) => {
      const ra = corpus.span(r.a0, r.a1), rb = corpus.span(r.b0, r.b1);
      const [s, d] = srcIsA ? [ra, rb] : [rb, ra];
      return [{ role: 'source_span', ...s, detail: { tokens: r.len } }, { role: 'target_span', ...d, detail: { tokens: r.len } }];
    });
    counts[c.rel_type === 'shared_wording' ? 'shared_wording' : 'exact']++;
    rows.push({ rel_type: c.rel_type, evidence_status: 'computed', src: { passage: c.src.passage, doc: c.src.doc },
      dst: { passage: c.dst.passage, doc: c.dst.doc }, directed: c.directed, score: c.score, method: METHODS.exact, runId, evidence });
  }
  rows.flush();
  return new Set(pairRuns.keys());
}

/** Near quotations: the best verified sentence pair per passage pair, unless the passages already share an exact run. */
function writeNear(ctx, { corpus, pairs, exactPairs, runId, counts, traceLinked }) {
  const [uDoc, uT0] = corpus.units.cols;
  const best = new Map(); // passage pair → best verified unit pair
  for (const x of pairs) {
    const pa = corpus.passageAt(uT0[x.u]), pb = corpus.passageAt(uT0[x.v]);
    if (exactPairs.has(`${pa.id}:${pb.id}`) || exactPairs.has(`${pb.id}:${pa.id}`)) continue;
    const pk = `${Math.min(pa.id, pb.id)}:${Math.max(pa.id, pb.id)}`;
    const prev = best.get(pk);
    if (!prev || x.sw.normalized > prev.sw.normalized) best.set(pk, x);
  }
  // in document order, so the text cache serves consecutive pairs
  const ordered = [...best.values()].sort((x, y) => uDoc[x.u] - uDoc[y.u] || uDoc[x.v] - uDoc[y.v]);
  const rows = batcher(ctx);
  for (const { u, v, sw, ja } of ordered) {
    const sa = corpus.span(uT0[u] + sw.aStart, uT0[u] + sw.aEnd), sb = corpus.span(uT0[v] + sw.bStart, uT0[v] + sw.bEnd);
    const c = classifyCandidate({ a: { passage: sa.passage, doc: sa.doc }, b: { passage: sb.passage, doc: sb.doc }, kind: 'near', score: sw.normalized });
    if (traceLinked(c.rel_type, c.src.passage, c.dst.passage)) { counts.existing_links++; continue; }
    const [s, d] = c.src.passage === sa.passage ? [sa, sb] : [sb, sa];
    const detail = { alignment_score: Math.round(sw.normalized * 1000) / 1000, jaccard: Math.round(ja * 1000) / 1000 };
    rows.push({ rel_type: c.rel_type, evidence_status: 'computed', src: { passage: c.src.passage, doc: c.src.doc },
      dst: { passage: c.dst.passage, doc: c.dst.doc }, directed: c.directed, score: c.score, method: METHODS.near, runId,
      evidence: [{ role: 'source_span', ...s, detail }, { role: 'target_span', ...d, detail }] });
    counts[c.rel_type === 'shared_wording' ? 'shared_wording' : 'near']++;
  }
  rows.flush();
}
