// OWNER: WP2
// tasks/demo-load.mjs — job 'demo-load': load the SYNTHETIC demo through the ordinary import path (SPEC §9.1).
//
//   step 'load' (default; the boot waits ≤ 10 s for it)
//     data/demo/* → adapter-load → DocumentWriter (corpus demo, every row is_synthetic=1); then the human layer
//     the files describe (Reader B's rejection of Reader A's ◉ allusion, Reader A's second revision); then the
//     tour's expressions are tracked; then the real pipeline is queued — materialize per expression, the
//     reuse index and clustering — so every computed element of the tour comes from the pipeline, not from us.
//   deferred (queued last, priority 9, as job adapter-load {adapter: 'demo', apply: 'deferred'}, so the boot sees
//     exactly one demo-load job): reviews and label renames that target rows the pipeline creates (the A13→A3
//     cue citation; the "counted · hold · ones" context group). Whatever is not there yet is reported as
//     pending, never invented.

import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { loadAdapter } from '../../adapters/registry.mjs';
import { readDemo } from '../../adapters/demo/demo.mjs';
import { setMeta, stmt } from '../../db/open.mjs';
import { loadAdapterData } from './adapter-load.mjs';

export const type = 'demo-load';
export const { writes, priority } = JOB_TYPES[type];

/** The expressions the tour follows (tracked with origin 'demo'). */
export const TOUR_EXPRESSIONS = Object.freeze([
  { surface: 'carry the zero', lang: 'en', kind: 'phrase', cluster: true },
  { surface: 'flux up', lang: 'en', kind: 'phrase', cluster: true },
  { surface: 'ghost in the margin', lang: 'en', kind: 'phrase', cluster: false },
  { surface: '◉', lang: null, kind: 'symbol', cluster: false },
]);
const DEFERRED_KEY = 'demo_deferred';
const BY = 'adapter:demo@1.0.0';

const demoDocId = (db, ext) => stmt(db, `SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id
  WHERE c.slug = 'demo-world' AND d.ext_id = ?`).get(ext)?.id ?? null;

/** Passage ids of a document (relationships may join passages, not documents). */
const passageIds = (db, docId) => stmt(db, 'SELECT id FROM passage WHERE document_id = ?').all(docId).map((r) => String(r.id));

/**
 * A relationship between two demo documents (document or passage endpoints).
 * @returns {object|null} relationship row
 */
export function findDemoRelationship(db, { rel_type, src, dst, evidence_status = null }) {
  const s = demoDocId(db, src), d = demoDocId(db, dst);
  if (!s || !d) return null;
  const sp = JSON.stringify([String(s)]), spp = JSON.stringify(passageIds(db, s));
  const dp = JSON.stringify([String(d)]), dpp = JSON.stringify(passageIds(db, d));
  return stmt(db, `SELECT * FROM relationship WHERE rel_type = ? AND (? IS NULL OR evidence_status = ?)
    AND ((src_type = 'document' AND src_ref IN (SELECT value FROM json_each(?))) OR (src_type = 'passage' AND src_ref IN (SELECT value FROM json_each(?))))
    AND ((dst_type = 'document' AND dst_ref IN (SELECT value FROM json_each(?))) OR (dst_type = 'passage' AND dst_ref IN (SELECT value FROM json_each(?))))
    ORDER BY id LIMIT 1`).get(rel_type, evidence_status, evidence_status, sp, spp, dp, dpp) ?? null;
}

async function provenance() {
  try {
    const [rev, ann] = await Promise.all([import('../../provenance/reviews.mjs'), import('../../provenance/annotations.mjs')]);
    return { reviewRelationship: rev.reviewRelationship, reviseAnnotation: ann.reviseAnnotation, createAnnotation: ann.createAnnotation };
  } catch {
    return null;
  }
}
const notBuilt = (err) => err?.code === 'NOT_IMPLEMENTED';
const actorName = (actor) => String(actor).replace(/^human:/, '');

/** Reviews written in relationships.jsonl (on authored relationships). */
async function applyAuthoredReviews(ctx, prov, out) {
  for (const r of readDemo('relationships.jsonl')) {
    for (const review of r.review ?? []) {
      const rel = findDemoRelationship(ctx.db, { rel_type: r.rel_type, src: r.src.ext_id, dst: r.dst.ext_id });
      if (!rel) { out.pending.push(`review of ${r.key}: relationship not found`); continue; }
      const done = stmt(ctx.db, 'SELECT 1 FROM relationship_revision WHERE relationship_id = ? AND actor = ? AND action = ?')
        .get(rel.id, review.actor, review.action);
      if (done) continue;
      try {
        prov.reviewRelationship(ctx.db, rel.id, { action: review.action, note: review.reason, author: actorName(review.actor) });
        out.reviews++;
      } catch (err) {
        if (!notBuilt(err)) throw err;
        out.pending.push(`review of ${r.key}: the review layer (WP5) is not built yet`);
      }
    }
  }
}

/** Revisions written in annotations.jsonl (Reader A's second reading of A15). */
async function applyRevisions(ctx, prov, out) {
  for (const a of readDemo('annotations.jsonl')) {
    if (!a.revisions?.length) continue;
    const row = stmt(ctx.db, `SELECT a.id, a.current_rev FROM annotation a JOIN annotation_revision r ON r.annotation_id = a.id AND r.rev = 1
      WHERE a.author = ? AND a.kind = ? AND r.body_md = ? LIMIT 1`).get(a.author, a.kind, a.body_md);
    if (!row) { out.pending.push(`revision of ${a.key}: annotation not found`); continue; }
    for (const [i, rev] of a.revisions.entries()) {
      if (row.current_rev >= i + 2) continue;
      try {
        prov.reviseAnnotation(ctx.db, row.id, { body_md: rev.body_md, dimensions: rev.dimensions, tags: rev.tags, reason: rev.reason });
        out.revisions++;
      } catch (err) {
        if (!notBuilt(err)) throw err;
        out.pending.push(`revision of ${a.key}: the notebook layer (WP5) is not built yet`);
      }
    }
  }
}

/** Track the tour's expressions (WP3's trackExpression: identity + generated variants). */
async function trackTourExpressions(ctx, out) {
  let track = null;
  try { ({ trackExpression: track } = await import('../../aggregate/materialize.mjs')); } catch { track = null; }
  for (const e of TOUR_EXPRESSIONS) {
    try {
      const r = track(ctx.db, { surface: e.surface, lang: e.lang, kind: e.kind, corpus: 'demo', origin: 'demo', createdBy: BY });
      out.expressions[e.surface] = r.id;
    } catch (err) {
      if (track && !notBuilt(err)) throw err;
      out.pending.push(`expression '${e.surface}': tracking (WP3) is not built yet`);
    }
  }
}

/** Queue the pipeline runs the tour shows, then the deferred step. */
function queuePipeline(ctx, out) {
  for (const e of TOUR_EXPRESSIONS) {
    const id = out.expressions[e.surface];
    if (id) out.queued.push(ctx.enqueue('materialize', { expressionId: id }));
  }
  out.queued.push(ctx.enqueue('reuse-index', { collections: ['demo-world'] }));
  for (const e of TOUR_EXPRESSIONS) {
    const id = out.expressions[e.surface];
    if (id && e.cluster) {
      out.queued.push(ctx.enqueue('cluster', { expressionId: id, expr: id,
        params: { representation: 'tfidf-hash-4096', k: 'auto', seed: 1994 } }));
    }
  }
  out.queued.push(ctx.enqueue('adapter-load', { adapter: 'demo', apply: 'deferred' }, { priority: 9 }));
}

/**
 * Deferred items: reviews of pipeline-made relationships and the cluster label rename.
 * @param {object} ctx TaskCtx
 * @returns {Promise<{reviews: number, labels: number, pending: string[]}>}
 */
export async function applyDeferred(ctx) {
  const db = ctx.db;
  const out = { reviews: 0, labels: 0, pending: [] };
  const prov = await provenance();
  for (const item of readDemo('annotations.jsonl').filter((a) => a.deferred)) {
    if (item.deferred === 'review') {
      const m = item.match;
      const rel = findDemoRelationship(db, { rel_type: m.rel_type, src: m.src, dst: m.dst, evidence_status: m.evidence_status });
      if (!rel) { out.pending.push(`review of ${m.rel_type} ${m.src}→${m.dst}: not created by the pipeline yet`); continue; }
      for (const review of item.reviews) {
        if (stmt(db, 'SELECT 1 FROM relationship_revision WHERE relationship_id = ? AND actor = ? AND action = ?').get(rel.id, review.actor, review.action)) continue;
        try {
          prov?.reviewRelationship(db, rel.id, { action: review.action, note: review.reason, author: actorName(review.actor) });
          out.reviews++;
        } catch (err) {
          if (!notBuilt(err) && prov) throw err;
          out.pending.push('reviews: the review layer (WP5) is not built yet');
        }
      }
    } else if (item.deferred === 'cluster_label') {
      const expr = stmt(db, `SELECT e.id FROM expression e JOIN corpus k ON k.id = e.corpus_id WHERE k.slug = 'demo' AND e.norm = ?`).get(item.expression);
      const clusters = expr ? stmt(db, `SELECT c.id, c.label_auto FROM sense_cluster c JOIN analysis_run r ON r.id = c.run_id
        WHERE c.expression_id = ? AND r.status = 'succeeded' ORDER BY r.id DESC`).all(expr.id) : [];
      const hit = clusters.find((c) => item.match_terms.filter((t) => c.label_auto.includes(t)).length >= 2);
      if (!hit) { out.pending.push(`label '${item.body_md}': no context group with ${item.match_terms.join(' · ')} yet`); continue; }
      if (stmt(db, "SELECT 1 FROM annotation WHERE target_type = 'cluster' AND target_ref = ? AND kind = 'label'").get(String(hit.id))) continue;
      try {
        prov?.createAnnotation(db, { target: { type: 'cluster', ref: String(hit.id) }, kind: 'label', body_md: item.body_md,
          author: item.author, layer: item.layer, tags: ['label'] });
        out.labels++;
      } catch (err) {
        if (!notBuilt(err) && prov) throw err;
        out.pending.push('label: the notebook layer (WP5) is not built yet');
      }
    }
  }
  setMeta(db, DEFERRED_KEY, JSON.stringify({ at: new Date().toISOString(), ...out }));
  return out;
}

/**
 * @param {object} ctx TaskCtx
 * @param {{step?: 'load'|'deferred', force?: boolean}} params
 * @returns {Promise<object>} result_json
 */
export async function run(ctx, params = {}) {
  if (params.step === 'deferred') return applyDeferred(ctx);
  const db = ctx.db;
  const loaded = stmt(db, `SELECT count(*) AS n FROM document d JOIN collection c ON c.id = d.collection_id
    WHERE c.slug = 'demo-world' AND d.deleted_at IS NULL`).get().n;
  if (loaded && !params.force) return { skipped: 'the demo corpus is already loaded', documents: loaded };
  const adapter = await loadAdapter('demo');
  const t0 = Date.now();
  const result = await loadAdapterData(ctx, adapter, {}, { onProgress: (f, m) => ctx.progress(f * 0.9, 'demo', m) });
  const out = { reviews: 0, revisions: 0, expressions: {}, queued: [], pending: [] };
  const prov = await provenance();
  if (prov) {
    await applyAuthoredReviews(ctx, prov, out);
    await applyRevisions(ctx, prov, out);
  } else {
    out.pending.push('reviews and revisions: provenance modules not available');
  }
  await trackTourExpressions(ctx, out);
  if (params.pipeline !== false) queuePipeline(ctx, out);
  ctx.progress(1, 'demo', 'demo loaded');
  return { ...result, human_layer: out, ms: Date.now() - t0 };
}
