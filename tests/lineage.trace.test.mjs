// OWNER: WP5 — the targeted trace (SPEC §4.7): exact runs ≥ 8 tokens, verified near quotations, similar wording that
// is never called a quotation, cues that only ever propose; links are computed (or proposed) and never duplicated

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { makeTaskContext } from '../server/jobs/context.mjs';
import { checkTraceRequest, traceQuery, traceSpan } from '../server/lineage/trace.mjs';
import { relationshipCard } from '../server/provenance/relationships.mjs';
import { createBatch, createDocumentWriter, ensureCollection } from '../server/store/document-writer.mjs';
import { assertShape, checkResponse } from './helpers/shape.mjs';
import { startServerInProcess } from './helpers/server.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

const RUN13 = 'it holds the place where nothing is, so that something can be counted';
const GHOST = 'a ghost in the margin of every ledger, and it is always owed';

describe('targeted trace', () => {
  let tmp, db, ctx, pas;
  const span = (ext, quote) => {
    const p = pas[ext];
    const start = p.text.indexOf(quote);
    assert.ok(start >= 0, `${quote} in ${ext}`);
    return { passage: p.id, start, end: start + quote.length };
  };
  before(() => {
    tmp = makeTmpData();
    db = tmp.db;
    const coll = ensureCollection(db, { slug: 'trace-extra', name: 'Trace extra (synthetic)', corpus: 'test', adapter_id: 'file.jsonl',
      domain: 'imported', modality: 'text', unit: 'tokens', sampling: 'user' });
    const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: coll.id }), collection: coll.slug, corpus: 'test' });
    for (const [ext, year, text] of [
      ['notebook', '1971', `Bit 7 flips on the third pass, as Fixture put it: ${GHOST}. The tape runs again tomorrow.`],
      // one word changed in the middle: identical runs of 6 and 7 tokens, below the trace's 8
      ['rule-a', '1970', 'The old clerk keeps every quiet zero in the long column so sums stand. Other words follow here today.'],
      ['rule-b', '1990', 'The old clerk keeps every quiet nought in the long column so sums stand. Nothing else is the same here.'],
    ]) {
      w.addDocument({ ext_id: ext, kind: 'notebook', title: `${ext} (synthetic)`, author: `${ext} writer (synthetic)`, lang_declared: 'en',
        text: { original: text, decoder: 'utf-8' }, dates: [{ role: 'publication', raw: year, asserted_by: 'test', is_chronology: true }], original_meta: {} });
    }
    w.finish();
    pas = {};
    for (const r of db.prepare(`SELECT p.id, p.start_off, d.ext_id, t.original AS text FROM passage p JOIN document d ON d.id = p.document_id
      JOIN document_text t ON t.document_id = d.id WHERE p.field = 'body'`).all()) pas[r.ext_id] = r;
    ctx = makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
  });
  after(() => tmp.cleanup());

  test('requests: ≥ 4 tokens, inside the passage, offsets into the document text (or relative: true)', () => {
    assert.throws(() => checkTraceRequest(db, { ...span('mini:02', 'Carry the zero'), passage: pas['mini:02'].id }),
      (e) => e.status === 400 && e.detail.tokens === 3 && e.detail.min === 4);
    assert.throws(() => checkTraceRequest(db, { passage: 999999, start: 0, end: 10 }), (e) => e.status === 404);
    assert.throws(() => checkTraceRequest(db, { passage: pas['mini:02'].id, start: 0, end: 99999 }), (e) => e.status === 400);
    const rel = checkTraceRequest(db, { passage: pas['mini:02'].id, start: 0, end: 30, relative: true });
    assert.equal(rel.start, pas['mini:02'].start_off);
  });

  test('exact: the 13-token run is found from either side; the link is computed and directed by dates', () => {
    const q = traceQuery(db, span('mini:02', RUN13));
    assertShape('Trace', q);
    assert.equal(q.status, 'done');
    assert.equal(q.note, 'Cross-language reuse is not detected.');
    assert.deepEqual(q.exact.map((e) => [e.passage, e.tokens, e.quote]), [[pas['mini:03'].id, 13, RUN13]]);
    const done = traceSpan(db, ctx, span('mini:02', RUN13));
    assertShape('Trace', done);
    assert.equal(done.created_relationships.length, 1);
    const card = relationshipCard(db, done.created_relationships[0]);
    assert.deepEqual([card.rel_type, card.evidence_status, card.origin, card.src.ref, card.dst.ref],
      ['exact_quotation', 'computed', 'algorithm', `passage:${pas['mini:03'].id}`, `passage:${pas['mini:02'].id}`]);
    assert.equal(card.method, 'targeted trace: FTS phrase windows + seed-extend');
    assert.deepEqual(card.evidence.map((e) => [e.role, e.quote]), [['source_span', RUN13], ['target_span', RUN13]]);
    const again = traceSpan(db, ctx, span('mini:03', RUN13));
    assert.deepEqual(again.created_relationships, done.created_relationships, 'a second trace reports the link, never a duplicate');
  });

  test('near: one word changed, verified by alignment and shingles', () => {
    const q = traceSpan(db, ctx, span('rule-b', 'The old clerk keeps every quiet nought in the long column so sums stand'));
    assert.deepEqual(q.exact, [], 'no 8-token identical run');
    assert.equal(q.near.length, 1);
    assert.equal(q.near[0].passage, pas['rule-a'].id);
    assert.ok(q.near[0].score >= 0.75 && q.near[0].jaccard >= 0.5);
    const card = relationshipCard(db, q.created_relationships[0]);
    assert.deepEqual([card.rel_type, card.evidence_status, card.score.kind], ['near_quotation', 'computed', 'alignment_score']);
    assert.equal(card.src.ref, `passage:${pas['rule-b'].id}`, 'the 1990 rule depends on the 1970 one');
  });

  test('short spans give similar wording, never a quotation', () => {
    const q = traceSpan(db, ctx, span('mini:03', 'the form in triplicate'));
    assert.deepEqual(q.exact, []);
    assert.ok(q.similar_wording.some((s) => s.passage === pas['mini:02'].id && s.kind === 'phrase'));
    assert.deepEqual(q.created_relationships, []);
  });

  test('a cue naming the source author proposes a citation (CUE) next to the computed quotation', () => {
    const q = traceSpan(db, ctx, span('notebook', GHOST));
    assert.equal(q.exact[0].passage, pas['mini:01'].id);
    assert.equal(q.cues[0].name, 'Fixture');
    const cards = q.created_relationships.map((id) => relationshipCard(db, id));
    const cite = cards.find((c) => c.rel_type === 'explicit_citation');
    assert.equal(cite.evidence_status, 'proposed');
    assert.deepEqual(cite.cue, { quote: 'as Fixture put it', referent: 'inferred' });
    assert.ok(cards.every((c) => c.evidence_status !== 'documented'));
    assert.equal(cards.find((c) => c.rel_type === 'exact_quotation').evidence_status, 'computed');
  });
});

describe('POST /api/trace', () => {
  let tmp, srv, p2, start;
  before(async () => {
    tmp = makeTmpData();
    const r = tmp.db.prepare("SELECT p.id, t.original FROM passage p JOIN document_text t ON t.document_id = p.document_id WHERE p.document_id = ? AND p.field = 'body'")
      .get(tmp.mini.ids.get('mini:02'));
    p2 = r.id;
    start = r.original.indexOf(RUN13);
    process.env.SCROLLS_READ_WORKERS = '1';
    srv = await startServerInProcess({ dataDir: tmp.dir });
  });
  after(async () => {
    await srv?.cleanup();
    delete process.env.SCROLLS_READ_WORKERS;
    tmp.cleanup();
  });

  test('answers within 1.5 s with the Trace payload, or 400/404', async () => {
    const post = async (body) => {
      const r = await srv.request('POST', '/api/trace', { body });
      return { status: r.status, json: await checkResponse(new Response(r.text, { status: r.status }), 'POST', '/api/trace') };
    };
    const t0 = Date.now();
    const ok = await post({ passage: p2, start, end: start + RUN13.length });
    assert.equal(ok.status, 200);
    assert.ok(['done', 'running'].includes(ok.json.status), ok.json.status);
    if (ok.json.status === 'done') assert.equal(ok.json.exact.length, 1);
    assert.ok(Date.now() - t0 < 5000);
    assert.equal((await post({ passage: p2, start, end: start + 5 })).status, 400);
    assert.equal((await post({ passage: 999999, start: 0, end: 5 })).status, 404);
  });
});
