// OWNER: WP5 — §11 row 6 end to end on the synthetic demo: "inferred lineage cannot be mistaken for documented
// citation". The real reuse index runs on the demo world; its edges go through the lineage API and then through the
// UI's own mapping (WP7's edgeWords/linkWords → shared evidence-style) — the rendering contract. Computed and proposed
// links never get the documented line, endpoint or badge; a cue is PROP · CUE; reviews change only the overlay; the
// database refuses to promote a link; "documented only" leaves no inferred edge.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { isConstraintError, nowIso } from '../server/db/open.mjs';
import { makeTaskContext } from '../server/jobs/context.mjs';
import { run as reuseIndex } from '../server/jobs/tasks/reuse-index.mjs';
import { lineageQuery } from '../server/lineage/graph.mjs';
import { pathQuery } from '../server/lineage/path.mjs';
import { relationshipCard } from '../server/provenance/relationships.mjs';
import { reviewRelationship } from '../server/provenance/reviews.mjs';
import { edgeStyle } from '../src/shared/evidence-style.mjs';
import { linkWords } from '../src/ui/panels/edge-card.mjs';
import { chainText, edgeWords, visibleEdges } from '../src/ui/panels/lineage.mjs';
import { assertShape } from './helpers/shape.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

const DEMO = new URL('../data/demo/documents.jsonl', import.meta.url);
const STATUS_LOOK = {
  documented: { dash: [], endpoint: 'dot', badge: 'DOC' },
  computed: { dash: [6, 4], endpoint: 'square', badge: 'CALC' },
  proposed: { dash: [1, 3], endpoint: 'question', badge: 'PROP' },
};
const look = (st) => ({ dash: st.dash, endpoint: st.endpoint, badge: st.badge.replace(/ · CUE$/, '').replace(/ ⚠$/, '').replace(/\*$/, '') });

describe('rendering contract on the demo world (§11 row 6)', () => {
  let tmp, db, run, skip = null;
  const passage = (ext, needle) => {
    const r = db.prepare(`SELECT p.id FROM passage p JOIN document d ON d.id = p.document_id JOIN document_text t ON t.document_id = d.id
      WHERE d.ext_id = ? AND p.field = 'body' AND instr(t.original, ?) BETWEEN p.start_off + 1 AND p.end_off`).get(ext, needle);
    assert.ok(r, `${ext}: ${needle}`);
    return r.id;
  };
  const edgeBetween = (g, src, dst) => g.edges.find((e) => e.src === `passage:${src}` && e.dst === `passage:${dst}`);

  before(async () => {
    if (!existsSync(DEMO)) { skip = 'data/demo is not built yet (WP2)'; return; }
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    const ctx = makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
    const { registerAdapters } = await import('../server/adapters/registry.mjs');
    await registerAdapters(db);
    const demo = await import('../server/jobs/tasks/demo-load.mjs');
    await demo.run(ctx, { pipeline: false });
    run = await reuseIndex(ctx, { collections: ['demo-world'] });
  });
  after(() => tmp?.cleanup());

  test('computed and documented links into the 1911 primer look different in the UI’s own mapping', (t) => {
    if (skip) { t.skip(skip); return; }
    const a4 = passage('demo:A4', 'Carry the zero, children'), a11 = passage('demo:A11', 'Carry the zero: it holds');
    const g = lineageQuery(db, { root: `passage:${a4}` });
    assertShape('Lineage', g);
    const calc = edgeBetween(g, a11, a4);
    assert.ok(calc, JSON.stringify(g.edges.map((e) => [e.src, e.dst, e.rel_type])));
    assert.deepEqual([calc.rel_type, calc.evidence_status, calc.origin, calc.run_id], ['exact_quotation', 'computed', 'algorithm', run.run_id]);
    const doc = g.edges.find((e) => e.rel_type === 'explicit_citation' && e.evidence_status === 'documented');
    assert.ok(doc, 'the liner-note citation (a synthetic record) is documented');
    for (const e of g.edges) {
      const w = edgeWords(e), l = linkWords(e);
      assert.deepEqual(look(w.style), STATUS_LOOK[e.evidence_status], `${e.rel_type} ${e.evidence_status}`);
      assert.deepEqual(look(l.style), look(w.style), 'graph and card agree');
      if (e.origin !== 'source_dataset') {
        assert.notEqual(w.badge.slice(0, 3), 'DOC', 'nothing inferred carries the DOC badge');
        assert.ok(w.style.dash.length > 0, 'nothing inferred is drawn solid');
        assert.notEqual(w.style.endpoint, 'dot');
      }
    }
    assert.equal(edgeWords(calc).badge, 'CALC');
    assert.equal(edgeWords(doc).badge, 'DOC');
  });

  test('the cue citation A13 → A3 is PROP · CUE; reviews move only the overlay; the database refuses promotion', (t) => {
    if (skip) { t.skip(skip); return; }
    const a3 = passage('demo:A3', 'ghost in the margin of every ledger'), a13 = passage('demo:A13', 'as Wrexley put it');
    const root = `passage:${a3}`;
    const before = edgeBetween(lineageQuery(db, { root }), a13, a3);
    assert.deepEqual([before.rel_type, before.evidence_status, before.cue], ['explicit_citation', 'proposed', true]);
    const w0 = edgeWords(before);
    assert.equal(w0.badge, 'PROP · CUE');
    assert.equal(w0.overlay, '');
    reviewRelationship(db, before.rel_id, { action: 'confirm', note: 'The notebook names Wrexley right before the phrase.', author: 'Reader A (synthetic)' });
    reviewRelationship(db, before.rel_id, { action: 'reject', note: 'Common office slang by 1971; the name may be a joke.', author: 'Reader B (synthetic)' });
    const afterReview = edgeBetween(lineageQuery(db, { root }), a13, a3);
    assert.deepEqual([afterReview.evidence_status, afterReview.review_status], ['proposed', 'disputed']);
    const w1 = edgeWords(afterReview);
    assert.deepEqual(look(w1.style), look(w0.style), 'review never changes the line, endpoint or badge');
    assert.equal(w1.badge, 'PROP · CUE');
    assert.equal(w1.style.overlay, 'scales');
    assert.equal(linkWords(afterReview).review, '⚖ disputed');
    const card = relationshipCard(db, before.rel_id);
    assert.deepEqual(card.cue, { quote: 'as Wrexley put it', referent: 'inferred' });
    assert.match(card.status_words, /^proposed — a hypothesis, not evidence/);
    // the line is fixed at creation: no UPDATE can promote it, no algorithm row can be documented
    assert.throws(() => db.prepare("UPDATE relationship SET evidence_status = 'documented' WHERE id = ?").run(before.rel_id),
      /immutable/);
    assert.throws(() => db.prepare(`INSERT INTO relationship (rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin,
        source_dataset, source_locator, method, run_id, created_by, is_synthetic, created_at)
      VALUES ('explicit_citation', 'passage', ?, 'passage', ?, 1, 'documented', 'algorithm', 'demo-records', 'x', 'm', ?, 'run:1', 1, ?)`)
      .run(String(a13), String(a3), run.run_id, nowIso()), (e) => isConstraintError(e));
    assert.equal(db.prepare('SELECT evidence_status FROM relationship WHERE id = ?').get(before.rel_id).evidence_status, 'proposed');
  });

  test('“documented only” leaves no inferred edge (server filter and the UI filter); a chain is as strong as its weakest link', (t) => {
    if (skip) { t.skip(skip); return; }
    const a3 = passage('demo:A3', 'ghost in the margin of every ledger'), a4 = passage('demo:A4', 'Carry the zero, children');
    const a13 = passage('demo:A13', 'as Wrexley put it'), a20 = passage('demo:A20', 'fantasma en el margen');
    for (const root of [`passage:${a3}`, `passage:${a4}`]) {
      const all = lineageQuery(db, { root, rejected: '1' });
      assert.ok(all.edges.some((e) => e.evidence_status !== 'documented'), 'inferred edges exist under "all"');
      const docOnly = lineageQuery(db, { root, status: 'documented', rejected: '1' });
      assert.ok(docOnly.edges.every((e) => e.evidence_status === 'documented'));
      assert.deepEqual(visibleEdges(all.edges, { status: ['documented'], showRejected: true }).map((e) => e.rel_id).sort(),
        docOnly.edges.map((e) => e.rel_id).sort(), 'the client filter agrees with the server');
    }
    const quote = pathQuery(db, { from: `passage:${a20}`, to: `passage:${a3}` });
    assert.deepEqual([quote.weakest, quote.path.map((e) => e.rel_type)], ['computed', ['exact_quotation']]);
    const cue = pathQuery(db, { from: `passage:${a13}`, to: `passage:${a3}` });
    assert.equal(cue.weakest, 'proposed');
    assert.equal(chainText(cue), 'Chain strength: weakest link PROPOSED.');
    // every algorithm row of the run: computed or proposed, never documented; a cue row always proposed
    const rows = db.prepare(`SELECT r.evidence_status, r.rel_type, EXISTS (SELECT 1 FROM relationship_evidence e WHERE e.relationship_id = r.id
      AND e.role = 'citation_cue') AS cue FROM relationship r WHERE r.run_id = ?`).all(run.run_id);
    assert.ok(rows.length >= 3);
    for (const r of rows) {
      assert.notEqual(r.evidence_status, 'documented');
      if (r.cue) assert.deepEqual([r.rel_type, r.evidence_status], ['explicit_citation', 'proposed']);
      assert.deepEqual(look(edgeStyle({ evidence_status: r.evidence_status, cue: Boolean(r.cue), family: 'quotation' })), STATUS_LOOK[r.evidence_status]);
    }
  });
});
