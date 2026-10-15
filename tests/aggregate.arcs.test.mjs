// OWNER: WP3 — arcs on the Scroll (SPEC §1.8, §1.6): scope (strand documents), vantage, evidence filter, hidden kinds,
// feedback only from feedback-capable non-computed types and reframing annotations, halos, date conflicts, the tier
// budgets (L0 bundles, L1 150, L2+ 300) and bundling, and reading a saved view "as saved" (revision cutoffs, runs).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { nowIso } from '../server/db/open.mjs';
import { ARC_BUDGET, arcsQuery, parseEvidence, strandDocIds, TIER_BUDGET } from '../server/aggregate/arcs.mjs';
import { materializeInline, trackExpression } from '../server/aggregate/materialize.mjs';
import { buildDef, canonicalRequest } from '../server/aggregate/query.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';
import { assertShape } from './helpers/shape.mjs';
import { buildGeneratedCorpus } from './aggregate.corpus.mjs';

let tmp, db, def, docs, outsiders, runId, zero;

function rel({ type, src, dst, status, origin, review = 'unreviewed', srcType = 'document', dstType = 'document', conflict = 0, run = null }) {
  const r = db.prepare(`INSERT INTO relationship (rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin,
      source_dataset, source_locator, method, run_id, created_by, review_status, date_conflict, is_synthetic, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(type, srcType, String(src), dstType, String(dst), status, origin,
    origin === 'source_dataset' ? 'demo-records' : null, origin === 'source_dataset' ? 'record:x' : null,
    origin === 'algorithm' ? 'winnow' : null, origin === 'algorithm' ? (run ?? runId) : null,
    origin === 'human' ? 'human:tester' : origin === 'algorithm' ? `run:${run ?? runId}` : 'adapter:test', review, conflict, nowIso());
  const id = Number(r.lastInsertRowid);
  db.prepare(`INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, after_json) VALUES (?, 1, 'test', ?, 'create', '{}')`)
    .run(id, nowIso());
  return id;
}

function review(relId, action) {
  const rev = db.prepare('SELECT max(rev) AS r FROM relationship_revision WHERE relationship_id = ?').get(relId).r + 1;
  db.prepare(`INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, after_json) VALUES (?, ?, 'human:reader', ?, ?, '{}')`)
    .run(relId, rev, nowIso(), action);
  db.prepare('UPDATE relationship SET review_status = ? WHERE id = ?').run(action === 'reject' ? 'rejected' : 'confirmed', relId);
}

function annotate(docId, { dims = { reframes_target: true }, refs = [], at = '2026-10-04T12:00:00Z', status = 'active' } = {}) {
  const a = db.prepare(`INSERT INTO annotation (target_type, target_ref, kind, author, is_machine, status, is_synthetic, created_at)
    VALUES ('document', ?, 'interpretation', 'Reader B (synthetic)', 0, ?, 1, ?)`).run(String(docId), status, at);
  const id = Number(a.lastInsertRowid);
  const v = db.prepare(`INSERT INTO annotation_revision (annotation_id, rev, body_md, dimensions_json, evidence_refs_json, author, at)
    VALUES (?, 1, 'After the later work, this reads differently.', ?, ?, 'Reader B (synthetic)', ?)`)
    .run(id, JSON.stringify(dims), JSON.stringify(refs), at);
  return { id, rev: Number(v.lastInsertRowid) };
}

const byId = (r) => new Map(r.items.map((a) => [a.rel_id, a]));
// contract 1.3.0 (C4): `total` counts the arcs in the requested range after the filters (the summary's buckets add up to
// it); `candidates` counts every relationship touching a strand document, shown or hidden
const accounted = (r) => r.returned + Object.values(r.hidden).reduce((s, n) => s + n, 0);

before(() => {
  tmp = makeTmpData({ seed: false });
  db = tmp.db;
  buildGeneratedCorpus(db, { seed: 3 });
  zero = trackExpression(db, { surface: 'zero', lang: 'en', corpus: 'test' }).id;
  runId = materializeInline(db, zero).run;
  def = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: zero }], lanes: { facet: 'collection', max: 48 } })).def;
  const strand = strandDocIds(db, def);
  // dated text documents ordered by year: early → late; strand documents (where 'zero' is counted) and outsiders
  const dated = db.prepare(`SELECT d.id, d.y_lo, d.y_hi FROM document d JOIN collection c ON c.id = d.collection_id
    WHERE c.slug = 'gen-text' AND d.chrono_status = 'dated' AND d.dup_of IS NULL AND d.is_translation = 0 AND d.basis <> 'estimated'
      AND d.y_lo >= 1850 AND d.y_lo = d.y_hi ORDER BY d.y_lo, d.id`).all();
  docs = dated.filter((d) => strand.has(d.id));
  outsiders = dated.filter((d) => !strand.has(d.id));
  assert.ok(docs.length > 20 && outsiders.length > 1, `fixture: ${docs.length} strand documents, ${outsiders.length} others`);
});
after(() => tmp.cleanup());

// Relationships and annotation revisions can never be deleted (§3 triggers): each test below works on its own documents
// and asserts on its own rows; the first one runs on an empty relationship table.
describe('arcs: scope, evidence, feedback, date conflicts', () => {

  test('statuses, hidden kinds, feedback and date conflicts', () => {
    const early = docs[0], mid = docs[Math.floor(docs.length / 2)], late = docs[docs.length - 1];
    assert.ok(early.y_lo < mid.y_lo && mid.y_lo < late.y_lo);
    const ids = {
      doc: rel({ type: 'explicit_citation', src: late.id, dst: early.id, status: 'documented', origin: 'source_dataset' }),
      calc: rel({ type: 'exact_quotation', src: mid.id, dst: early.id, status: 'computed', origin: 'algorithm' }),
      prop: rel({ type: 'proposed_allusion', src: late.id, dst: mid.id, status: 'proposed', origin: 'human' }),
      reframe: rel({ type: 'reframes', src: late.id, dst: early.id, status: 'documented', origin: 'source_dataset' }),
      reframeCalc: rel({ type: 'recontextualizes', src: late.id, dst: mid.id, status: 'computed', origin: 'algorithm' }),
      kindred: rel({ type: 'kindred', src: mid.id, dst: early.id, status: 'computed', origin: 'algorithm' }),
      rejected: rel({ type: 'proposed_allusion', src: mid.id, dst: early.id, status: 'proposed', origin: 'human', review: 'rejected' }),
      conflict: rel({ type: 'explicit_citation', src: early.id, dst: late.id, status: 'documented', origin: 'source_dataset' }),
      conflictFeedback: rel({ type: 'reframes', src: early.id, dst: late.id, status: 'documented', origin: 'source_dataset' }),
    };
    const r = arcsQuery(db, { def });
    assertShape('Arcs', r);
    const by = byId(r);
    assert.equal(r.hidden.kindred, 1);
    assert.equal(r.hidden.rejected, 1);
    assert.ok(!by.has(ids.kindred) && !by.has(ids.rejected));
    assert.equal(by.get(ids.reframe).feedback, true, 'documented reframes: feedback arc');
    assert.equal(by.get(ids.reframeCalc).feedback, false, 'a computed relationship never draws feedback');
    assert.equal(by.get(ids.calc).feedback, false);
    assert.equal(by.get(ids.conflict).date_conflict, true, 'a citation from an earlier to a later work is a date conflict');
    assert.equal(by.get(ids.conflict).feedback, false);
    assert.deepEqual([by.get(ids.conflictFeedback).date_conflict, by.get(ids.conflictFeedback).feedback], [true, false],
      'a date conflict is never feedback, even for a feedback-capable type');
    assert.equal(by.get(ids.doc).src.y, late.y_lo);
    assert.equal(by.get(ids.doc).src.lo_day, db.prepare('SELECT lo_day FROM document WHERE id = ?').get(late.id).lo_day);
    assert.equal(by.get(ids.doc).dst.lane, 'collection:gen-text');
    assert.equal(r.items[0].evidence_status, 'documented', 'documented first');
    assert.equal(accounted(r), r.candidates, 'every arc is shown or counted as hidden');
    assert.equal(r.returned + r.hidden.budget, r.total, 'arcs in range: drawn or beyond the budget');
    const withHidden = arcsQuery(db, { def, ev: 'documented,computed,proposed,kindred,rejected' });
    assert.equal(withHidden.hidden.kindred + withHidden.hidden.rejected, 0);
    const docOnly = arcsQuery(db, { def, ev: 'documented' });
    assert.ok(docOnly.items.every((a) => a.evidence_status === 'documented'));
    assert.equal(docOnly.hidden.filtered, 3, 'computed and proposed are filtered, not lost');
    assert.equal(docOnly.candidates, r.candidates);
    // vantage: an arc appears once both ends are ≤ the vantage
    const v = arcsQuery(db, { def, vantage: mid.y_lo });
    assert.ok(v.items.every((a) => Math.max(a.src.y, a.dst.y) <= mid.y_lo));
    assert.ok(v.items.some((a) => a.rel_id === ids.calc));
    assert.ok(v.hidden.vantage >= 4);
    assert.throws(() => parseEvidence('everything'), /Unknown evidence filter/);
  });

  test('scope: only relationships with an end where a pinned strand is observed', () => {
    const [a, b] = outsiders;
    const late = docs[docs.length - 1];
    const before1 = arcsQuery(db, { def }).candidates;
    const none = rel({ type: 'explicit_citation', src: b.id, dst: a.id, status: 'documented', origin: 'source_dataset' });
    const one = rel({ type: 'explicit_citation', src: late.id, dst: a.id, status: 'documented', origin: 'source_dataset' });
    const r = arcsQuery(db, { def });
    assert.ok(byId(r).has(one), 'one end is a strand document: drawn');
    assert.ok(!byId(r).has(none), 'neither end is: not this query\'s business');
    assert.equal(r.candidates, before1 + 1);
    assert.equal(r.scope, 'strands');
  });

  test('passage and occurrence ends resolve to their documents', () => {
    const occ = db.prepare(`SELECT o.id, o.passage_id, o.document_id FROM occurrence o WHERE o.run_id = ? AND o.document_id = ?`).get(runId, docs[docs.length - 1].id);
    const p = db.prepare("SELECT id FROM passage WHERE document_id = ? AND quality = 'ok' LIMIT 1").get(docs[0].id);
    const id = rel({ type: 'exact_quotation', src: occ.id, srcType: 'occurrence', dst: p.id, dstType: 'passage', status: 'computed', origin: 'algorithm' });
    const a = byId(arcsQuery(db, { def })).get(id);
    assert.deepEqual([a.src.doc, a.src.passage, a.dst.doc, a.dst.passage], [occ.document_id, occ.passage_id, docs[0].id, p.id]);
  });

  test('halos: documented and proposed feedback and reframing annotations re-read the earlier mark', () => {
    const early = docs[1], mid = docs[Math.floor(docs.length / 2) + 1], late = docs[docs.length - 2];
    rel({ type: 'reframes', src: mid.id, dst: early.id, status: 'documented', origin: 'source_dataset' });
    rel({ type: 'parody_of', src: late.id, dst: early.id, status: 'proposed', origin: 'human' });
    rel({ type: 'recontextualizes', src: late.id, dst: early.id, status: 'computed', origin: 'algorithm' });
    const noted = annotate(early.id);                                          // a reading recorded in 2026, no evidence
    annotate(early.id, { refs: [{ type: 'document', id: late.id, role: 'supporting' }] });   // and one that cites the later work
    annotate(early.id, { status: 'withdrawn' });
    annotate(early.id, { dims: { pragmatic_function: 'ironic' } });
    const r = arcsQuery(db, { def });
    assertShape('Arcs', r);
    const h = r.halos.find((x) => x.doc === early.id);
    assert.deepEqual([h.documented, h.proposed, h.annotated], [1, 1, 2], 'computed, withdrawn and non-reframing items do not count');
    assert.equal(h.after, mid.y_lo);
    assert.equal(h.label, `re-read after ${mid.y_lo} (1 documented, 1 proposed, 2 annotated)`);
    assert.equal(h.sources.length, 4);
    const mine = r.annotated.filter((x) => x.dst.doc === early.id);
    assert.equal(mine.length, 1, 'one annotated feedback arc: from the cited later work');
    assert.deepEqual([mine[0].src.doc, mine[0].feedback, mine[0].label], [late.id, true, 'annotated']);
    // at a vantage between the two works only the documented feedback counts; the 2026 readings are not written yet
    const v = arcsQuery(db, { def, vantage: mid.y_lo });
    const hv = v.halos.find((x) => x.doc === early.id);
    assert.equal(hv.label, `re-read after ${mid.y_lo} (1 documented)`);
    assert.equal(v.annotated.filter((x) => x.dst.doc === early.id).length, 0);
    // as saved before the first reading was written: no annotation counts
    const saved = arcsQuery(db, { def, rev_cutoff: noted.rev - 1 });
    assert.equal(saved.halos.find((x) => x.doc === early.id).annotated, 0);
  });

  test('a dimension added in a later revision counts only from that revision', () => {
    const early = docs[2];
    const { id, rev } = annotate(early.id, { dims: {} });
    const v2 = db.prepare(`INSERT INTO annotation_revision (annotation_id, rev, body_md, dimensions_json, author, at)
      VALUES (?, 2, 'Now read as reframed.', '{"reframes_target": true}', 'Reader B (synthetic)', '2026-10-05T00:00:00Z')`).run(id);
    db.prepare('UPDATE annotation SET current_rev = 2 WHERE id = ?').run(id);
    assert.equal(arcsQuery(db, { def }).halos.find((x) => x.doc === early.id)?.annotated, 1);
    assert.equal(arcsQuery(db, { def, rev_cutoff: rev }).halos.find((x) => x.doc === early.id), undefined);
    assert.ok(Number(v2.lastInsertRowid) > rev);
  });

  test('as saved: links created after the cutoff are absent; a later review does not change the saved reading', () => {
    const early = docs[3], late = docs[docs.length - 3];
    const before1 = rel({ type: 'proposed_allusion', src: late.id, dst: early.id, status: 'proposed', origin: 'human' });
    const cutoff = db.prepare('SELECT max(id) AS m FROM relationship_revision').get().m;
    review(before1, 'reject');
    const later = rel({ type: 'explicit_citation', src: late.id, dst: early.id, status: 'documented', origin: 'source_dataset' });
    const now = arcsQuery(db, { def });
    assert.ok(!byId(now).has(before1), 'rejected now: hidden');
    assert.ok(byId(now).has(later));
    const saved = arcsQuery(db, { def, rel_rev_cutoff: cutoff });
    assert.equal(byId(saved).get(before1)?.review_status, 'unreviewed', 'as saved: not yet rejected');
    assert.ok(!byId(saved).has(later), 'created after the save');
    assert.equal(saved.candidates, now.candidates - 1, 'the link created after the save is not counted');
    assert.throws(() => arcsQuery(db, { def, rel_rev_cutoff: -1 }), (e) => e.status === 400);
  });

  test('as saved: a review made before the save is read as of the save (fix pass: the review overlay as of the view, D7)', () => {
    const early = docs[5], late = docs[docs.length - 5];
    const rejected = rel({ type: 'proposed_allusion', src: late.id, dst: early.id, status: 'proposed', origin: 'human' });
    const confirmed = rel({ type: 'explicit_citation', src: late.id, dst: early.id, status: 'documented', origin: 'source_dataset' });
    review(rejected, 'reject');
    review(confirmed, 'confirm');
    const cutoff = db.prepare('SELECT max(id) AS m FROM relationship_revision').get().m;
    const saved = arcsQuery(db, { def, rel_rev_cutoff: cutoff });
    assert.ok(!byId(saved).has(rejected), 'rejected before the save: hidden as saved too');
    assert.ok(saved.hidden.rejected >= 1);
    assert.equal(byId(saved).get(confirmed)?.review_status, 'confirmed', 'confirmed before the save reads confirmed');
    assert.deepEqual(byId(arcsQuery(db, { def, rel_rev_cutoff: cutoff, ev: 'documented,computed,proposed,rejected' })).get(rejected)?.review_status,
      'rejected', 'shown on request, with its review as of the save');
  });

  test('relationships of a run that did not succeed stay hidden unless the view pins that run', () => {
    const early = docs[0], late = docs[docs.length - 1];
    const r2 = Number(db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
        input_fingerprint, data_version, tokenizer_version, segmenter_version, icu_version, status, started_at)
      SELECT stage, pipeline_version, code_hash, params_json, params_hash || 'x', scope_json, input_fingerprint, data_version,
        tokenizer_version, segmenter_version, icu_version, 'superseded', started_at FROM analysis_run WHERE id = ?`).run(runId).lastInsertRowid);
    const id = rel({ type: 'near_quotation', src: late.id, dst: early.id, status: 'computed', origin: 'algorithm', run: r2 });
    assert.ok(!byId(arcsQuery(db, { def })).has(id));
    assert.ok(byId(arcsQuery(db, { def, runs: String(r2) })).has(id));
  });
});

describe('arcs: tier budgets and bundling', () => {
  before(() => {
    rel({ type: 'explicit_citation', src: docs[docs.length - 1].id, dst: docs[0].id, status: 'documented', origin: 'source_dataset' });
    for (let i = 0; i < 420; i++) {
      const a = docs[i % docs.length], b = docs[(i * 7 + 3) % docs.length];
      if (a.y_lo === b.y_lo) continue;
      const [later, earlier] = a.y_lo > b.y_lo ? [a, b] : [b, a];
      rel({ type: 'near_quotation', src: later.id, dst: earlier.id, status: 'computed', origin: 'algorithm' });
    }
  });

  test('L0 bundles only, L1 ≤ 150, L2+ ≤ 300; the rest are bundled per lane pair and bin pair', () => {
    assert.deepEqual(TIER_BUDGET, { L0: 0, L1: 150, L2: 300, L3: 300, L4: 300, L5: 300 });
    for (const tier of ['L0', 'L1', 'L2', 'L3', 'L5']) {
      const r = arcsQuery(db, { def, tier });
      assertShape('Arcs', r);
      assert.equal(r.returned, Math.min(r.candidates - r.hidden.kindred - r.hidden.rejected - r.hidden.filtered - r.hidden.outside - r.hidden.vantage,
        TIER_BUDGET[tier]), tier);
      assert.equal(r.mode, 'individual');
      assert.equal(r.budget, TIER_BUDGET[tier]);
      assert.equal(r.bundles.reduce((s, b) => s + b.count, 0), r.hidden.budget, `${tier}: bundles hold every arc beyond the budget`);
      assert.equal(accounted(r), r.candidates);
      for (const b of r.bundles) {
        assert.equal(b.width, Math.round(Math.log2(b.count + 1) * 10) / 10);
        assert.equal(b.tier, tier);
        assert.equal(Object.values(b.status).reduce((s, n) => s + n, 0), b.count);
      }
      if (r.hidden.budget) assert.deepEqual(r.chip, { count: r.hidden.budget, label: `+${r.hidden.budget} more arcs (filtered)` });
      else assert.equal(r.chip, null);
    }
    const l1 = arcsQuery(db, { def, tier: 'L1' });
    const rank = { documented: 0, computed: 1, proposed: 2 };
    assert.ok(l1.items.every((a, i) => i === 0 || rank[l1.items[i - 1].evidence_status] <= rank[a.evidence_status]), 'documented > computed > proposed');
    assert.equal(l1.items[0].evidence_status, 'documented');
    assert.ok(l1.bundles.every((b) => !b.status.documented), 'the budget never bundles a documented arc while computed ones are shown');
    assert.equal(arcsQuery(db, { def, tier: 'L0' }).returned, 0, 'L0: arc bundles only');
    const limited = arcsQuery(db, { def, limit: 10 });
    assert.equal(limited.returned, 10);
    assert.equal(accounted(limited), limited.candidates);
    assert.equal(ARC_BUDGET, 300);
  });
});
