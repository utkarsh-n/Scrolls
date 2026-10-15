// OWNER: WP2 — the SYNTHETIC "carry the zero" demo (SPEC §9, §9.6 calibration, §11 "demo material clearly
// labelled"): the committed files are what the build produces, the calibration numbers hold, every row is
// synthetic, the human layer and the tour resolve, and — when WP5's reuse index is built — the pipeline finds
// the planted quotations and creates no documented edge.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { decode } from '../src/shared/viewstate.mjs';
import { tokenize } from '../src/shared/tokenize.mjs';
import { registerAdapters } from '../server/adapters/registry.mjs';
import { makeTaskContext } from '../server/jobs/context.mjs';
import { findOccurrences } from '../data/demo/generator.mjs';
import { buildDemo, calibrate, sharedRuns } from '../scripts/build-demo.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';
import { assertShape } from './helpers/shape.mjs';

const DEMO = new URL('../data/demo/', import.meta.url);
const readJsonl = (name) => readFileSync(new URL(name, DEMO), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const isStub = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').includes('stub written by WP0');

function taskCtx(db) {
  const posted = [];
  const ctx = makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: (m) => posted.push(m) });
  return { ctx, posted };
}

describe('demo build (scripts/build-demo.mjs)', () => {
  let built;
  before(() => { built = buildDemo(); });

  test('the build reports no calibration or lineage problem', () => {
    assert.deepEqual(built.errors, []);
  });

  test('the committed data/demo files are exactly what the seeded build produces (deterministic)', () => {
    assert.deepEqual(readJsonl('documents.jsonl'), JSON.parse(JSON.stringify(built.documents)));
    assert.deepEqual(readJsonl('relationships.jsonl'), JSON.parse(JSON.stringify(built.relationships)));
    assert.deepEqual(readJsonl('annotations.jsonl'), JSON.parse(JSON.stringify(built.annotations)));
  });

  test('§9.5/§9.6 calibration: carry the zero n = 340 in ≥ 90 documents, the four planted senses exact', () => {
    const s = built.calibration['carry the zero'];
    assert.equal(s.n, 340);
    assert.ok(s.docs >= 90, `${s.docs} documents`);
    assert.deepEqual(Object.fromEntries(Object.entries(s.senses).map(([k, v]) => [k, [v.n, v.docs, v.authors]])),
      { place: [90, 24, 12], irony: [70, 18, 9], honor: [110, 30, 16], null: [70, 20, 11] });
  });

  test('§9.5: flux up 120 + anchors, ghost in the margin 90 + anchors, ◉ 26 in 9 documents, gu 14/6/4, hi 8/4/3', () => {
    const c = built.calibration;
    assert.equal(c['flux up'].generated, 120);
    assert.equal(c['ghost in the margin'].generated, 90);
    assert.deepEqual([c['◉'].n, c['◉'].docs, c['◉'].authors], [26, 9, 7]);
    assert.deepEqual([c['શૂન્ય ઉપાડ'].n, c['શૂન્ય ઉપાડ'].docs, c['શૂન્ય ઉપાડ'].authors], [14, 6, 4]);
    assert.deepEqual([c['शून्य को साथ'].n, c['शून्य को साथ'].docs, c['शून्य को साथ'].authors], [8, 4, 3]);
  });

  test('only the planted ≥ 13-token runs exist: A11 ↔ A4 (13 tokens) and A20 ↔ A3 (15 tokens)', () => {
    assert.deepEqual([...sharedRuns(built.documents).keys()].sort(), ['demo:A11 ↔ demo:A4', 'demo:A20 ↔ demo:A3']);
    const toks = (ext) => tokenize(built.documents.find((d) => d.ext_id === ext).text.original).tokens;
    const longest = (a, b) => {
      let best = 0;
      for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
        let k = 0;
        while (a[i + k] !== undefined && a[i + k] === b[j + k]) k++;
        if (k > best) best = k;
      }
      return best;
    };
    assert.equal(longest(toks('demo:A11'), toks('demo:A4')), 13);
    assert.equal(longest(toks('demo:A20'), toks('demo:A3')), 15);
  });

  test('built-in test conditions: no document in the 1940s; 12 Hip-hop documents 1984–1993 without carry the zero', () => {
    const years = (d) => [d.dates[0].parsed.lo_year, d.dates[0].parsed.hi_year];
    assert.ok(built.documents.every((d) => years(d)[0] === null || (years(d)[1] < 1940 || years(d)[0] > 1949)));
    const hh = built.documents.filter((d) => d.community === 'hiphop' && years(d)[0] >= 1984 && years(d)[1] <= 1993);
    assert.equal(hh.length, 12);
    assert.ok(hh.every((d) => findOccurrences(d.text.original, 'carry the zero').length === 0));
  });

  test('every date precision of §9.1 appears: day, month, year, decade, circa, early-20th-century range, Vikram Samvat, undated, scheduled', () => {
    const ps = built.documents.map((d) => d.dates[0].parsed);
    for (const want of ['day', 'month', 'year', 'decade']) assert.ok(ps.some((p) => p.precision === want), want);
    assert.ok(ps.some((p) => p.approx === 1), 'circa');
    assert.ok(ps.some((p) => p.rule === 'century_part'), 'early 20th century');
    assert.ok(ps.some((p) => p.rule === 'vikram_samvat' && p.basis === 'derived'), 'Vikram Samvat');
    assert.ok(ps.some((p) => p.precision === 'unknown'), 'undated');
    assert.ok(ps.some((p) => p.basis === 'announced'), 'scheduled (2027)');
    assert.ok(built.documents.some((d) => d.dates.some((x) => x.role === 'referenced')), 'a referenced date');
  });

  test('every author carries "(synthetic)"; every generated title says "(generated background)"', () => {
    for (const d of built.documents) {
      assert.ok(d.author.endsWith('(synthetic)'), d.ext_id);
      if (d.original_meta.generator) {
        assert.ok(d.title.startsWith('(generated background)'), d.ext_id);
        assert.equal(d.original_meta.generator, 'demo-gen@1 seed 1994');
      }
    }
  });
});

describe('demo load (tasks/demo-load.mjs → adapter-load → DocumentWriter)', () => {
  let t, db, result;
  before(async () => {
    t = makeTmpData({ seed: false });
    db = t.db;
    await registerAdapters(db);
    const { run } = await import('../server/jobs/tasks/demo-load.mjs');
    const { ctx } = taskCtx(db);
    const t0 = Date.now();
    result = await run(ctx, { pipeline: false });
    result.elapsed = Date.now() - t0;
  });
  after(() => t.cleanup());

  test('loads well inside the boot wait (≤ 10 s): every document, no rejection', () => {
    const c = result.collections['demo-world'];
    assert.ok(result.elapsed < 10000, `${result.elapsed} ms`);
    assert.equal(c.documents.created, readJsonl('documents.jsonl').length);
    assert.equal(c.documents.rejected, 0);
    assert.equal(c.relationships.rejected, 0);
    assert.equal(c.relationships.unresolved_targets, 0);
    assert.equal(c.annotations.rejected, 0);
  });

  test('every demo document points at its own line of the kept documents.jsonl (fix pass, D18)', () => {
    const docs = db.prepare(`SELECT d.ext_id, d.source_byte_start AS s, d.source_byte_end AS e, f.rel_path FROM document d
      LEFT JOIN original_file f ON f.sha256 = d.source_file_sha256`).all();
    assert.ok(docs.length > 0 && docs.every((d) => d.rel_path && Number.isInteger(d.s) && d.e > d.s));
    const bytes = readFileSync(new URL(docs[0].rel_path, `file://${t.dir}/`));
    for (const d of docs) assert.equal(JSON.parse(bytes.toString('utf8', d.s, d.e)).ext_id, d.ext_id);
  });

  test('every demo row is synthetic (documents, passages, relationships, annotations, groups, the collection)', () => {
    for (const table of ['document', 'passage', 'relationship', 'annotation', 'hypothesis_group']) {
      const r = db.prepare(`SELECT count(*) AS n, SUM(is_synthetic) AS s FROM ${table}`).get();
      assert.ok(r.n > 0, `${table} has rows`);
      assert.equal(r.s, r.n, `${table}: every row is_synthetic=1`);
    }
    assert.equal(db.prepare("SELECT is_synthetic FROM collection WHERE slug = 'demo-world'").get().is_synthetic, 1);
  });

  test('the corpus CHECK refuses a non-synthetic demo corpus', () => {
    assert.throws(() => db.prepare("UPDATE corpus SET is_synthetic = 0 WHERE slug = 'demo'").run(), /CHECK constraint failed/);
  });

  test('counts in the database: carry the zero 340 in ≥ 90 documents; ◉ 26 (tokenized from stored passages)', () => {
    const count = (expr) => {
      let n = 0;
      const docs = new Set();
      for (const p of db.prepare(`SELECT p.document_id, substr(t.original, p.start_off + 1, p.end_off - p.start_off) AS text
        FROM passage p JOIN document_text t ON t.document_id = p.document_id WHERE p.field = 'body'`).all()) {
        const k = findOccurrences(p.text, expr).length;
        n += k;
        if (k) docs.add(p.document_id);
      }
      return { n, docs: docs.size };
    };
    const ctz = count('carry the zero');
    assert.equal(ctz.n, 340);
    assert.ok(ctz.docs >= 90);
    assert.equal(count('◉').n, 26);
  });

  test('no demo document falls in a 1940s bin (the no-sources gap)', () => {
    const r = db.prepare("SELECT count(*) AS n FROM doc_bin WHERE level = 2 AND bin = 194").get();
    assert.equal(r.n, 0);
  });

  test('authored relationships: 8 documented demo records with locators, 3 human proposals, no computed edge', () => {
    const rows = db.prepare('SELECT * FROM relationship').all();
    const documented = rows.filter((r) => r.evidence_status === 'documented');
    assert.equal(documented.length, 8);
    assert.ok(documented.every((r) => r.origin === 'source_dataset' && r.source_dataset === 'demo-records' && r.source_locator?.startsWith('demo-records:')));
    const proposed = rows.filter((r) => r.evidence_status === 'proposed');
    assert.equal(proposed.length, 3);
    assert.ok(proposed.every((r) => r.origin === 'human' && r.created_by === 'human:Reader A (synthetic)'));
    assert.equal(rows.filter((r) => r.evidence_status === 'computed').length, 0);
    const group = db.prepare('SELECT * FROM hypothesis_group').all();
    assert.equal(group.length, 1);
    assert.match(group[0].question, /Vyas 2017/);
    assert.equal(rows.filter((r) => r.hypothesis_group_id === group[0].id).length, 2);
  });

  test("P3: Reader B rejects Reader A's ◉ allusion; the line keeps its evidence status", () => {
    const rel = db.prepare("SELECT * FROM relationship WHERE rel_type = 'proposed_allusion' AND hypothesis_group_id IS NULL").get();
    assert.equal(rel.review_status, 'rejected');
    assert.equal(rel.evidence_status, 'proposed');
    const rev = db.prepare('SELECT * FROM relationship_revision WHERE relationship_id = ? ORDER BY rev').all(rel.id);
    assert.deepEqual(rev.map((r) => r.action), ['create', 'reject']);
    assert.equal(rev[1].actor, 'human:Reader B (synthetic)');
    assert.match(rev[1].reason, /autoclave tape/);
  });

  test("annotations: 18 pragmatic-function labels, two readings of A15 (Reader A's revised), Reader B on A4, a hypothesis", () => {
    const labels = db.prepare("SELECT a.*, r.dimensions_json, r.tags_json FROM annotation a JOIN annotation_revision r ON r.annotation_id = a.id AND r.rev = 1 WHERE a.kind = 'label'").all();
    assert.equal(labels.length, 18);
    const values = labels.map((l) => JSON.parse(l.dimensions_json).pragmatic_function ?? (JSON.parse(l.tags_json).includes('contested') ? 'contested' : null));
    const tally = values.reduce((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {});
    assert.deepEqual(tally, { sincere: 2, ironic: 8, reclaimed: 7, contested: 1 });
    const a = db.prepare("SELECT * FROM annotation WHERE kind = 'interpretation' AND author = 'Reader A (synthetic)'").get();
    assert.equal(a.current_rev, 2);
    assert.match(db.prepare('SELECT body_md FROM annotation_revision WHERE annotation_id = ? AND rev = 2').get(a.id).body_md, /Ironic distance/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM annotation WHERE kind = 'hypothesis'").get().n, 1);
    const b4 = db.prepare(`SELECT r.dimensions_json FROM annotation a JOIN annotation_revision r ON r.annotation_id = a.id
      WHERE a.kind = 'interpretation' AND a.author = 'Reader B (synthetic)' AND r.body_md LIKE 'After Ledgerline%'`).get();
    assert.deepEqual(JSON.parse(b4.dimensions_json), { reframes_target: true });
  });

  test('the tour expressions are tracked (origin demo, synthetic) and the tour resolves into valid view states', async () => {
    const ex = db.prepare("SELECT surface, origin, is_synthetic FROM expression ORDER BY id").all();
    assert.deepEqual(ex.map((e) => e.surface), ['carry the zero', 'flux up', 'ghost in the margin', '◉']);
    assert.ok(ex.every((e) => e.origin === 'demo' && e.is_synthetic === 1));
    const { tourQuery } = await import('../server/routes/tour.mjs');
    const tour = tourQuery(db);
    assertShape('Tour', tour);
    assert.equal(tour.steps.length, 10);
    for (const s of tour.steps) {
      assert.doesNotMatch(`${s.see} ${s.action} ${s.learn}`, /\{[a-z0-9_]+\}/, `step ${s.n} has an unfilled placeholder`);
      const v = decode(s.state);
      assert.ok(v && v.corpus, `step ${s.n} state decodes`);
    }
    assert.equal(decode(tour.steps[0].state).strands[0].id, db.prepare("SELECT id FROM expression WHERE norm = 'carry the zero'").get().id);
    assert.equal(tour.steps[9].synthetic, false);
    assert.match(tour.steps[0].see, /0 in [\d.,]+k? tokens/);
    assert.match(tour.steps[7].see, /◉ has 26 matches in all/);
  });

  test('WP5 reuse index on the demo: A11→A4 and A20→A3 computed, A13→A3 proposed + CUE, nothing documented', { skip: isStub('../server/jobs/tasks/reuse-index.mjs') && 'reuse-index (WP5) not built yet' }, async () => {
    const before = db.prepare("SELECT count(*) AS n FROM relationship WHERE evidence_status = 'documented'").get().n;
    const { run } = await import('../server/jobs/tasks/reuse-index.mjs');
    const { ctx } = taskCtx(db);
    await run(ctx, { collections: ['demo-world'] });
    const docId = (a) => db.prepare("SELECT id FROM document WHERE ext_id = ?").get(`demo:${a}`).id;
    const between = (type, a, b) => db.prepare(`SELECT r.* FROM relationship r WHERE r.rel_type = ?
      AND ((r.src_type = 'document' AND r.src_ref = ?) OR (r.src_type = 'passage' AND r.src_ref IN (SELECT CAST(id AS TEXT) FROM passage WHERE document_id = ?)))
      AND ((r.dst_type = 'document' AND r.dst_ref = ?) OR (r.dst_type = 'passage' AND r.dst_ref IN (SELECT CAST(id AS TEXT) FROM passage WHERE document_id = ?)))`)
      .all(type, String(docId(a)), docId(a), String(docId(b)), docId(b));
    const e1 = between('exact_quotation', 'A11', 'A4');
    const e2 = between('exact_quotation', 'A20', 'A3');
    assert.ok(e1.length && e1.every((r) => r.evidence_status === 'computed'), 'A11→A4 exact quotation, computed');
    assert.ok(e2.length && e2.every((r) => r.evidence_status === 'computed'), 'A20→A3 exact quotation, computed');
    const cue = between('explicit_citation', 'A13', 'A3');
    assert.ok(cue.length && cue.every((r) => r.evidence_status === 'proposed'), 'A13→A3 cue citation, proposed');
    assert.ok(db.prepare("SELECT 1 FROM relationship_evidence WHERE relationship_id = ? AND role = 'citation_cue'").get(cue[0].id), 'CUE evidence row');
    assert.equal(db.prepare("SELECT count(*) AS n FROM relationship WHERE evidence_status = 'documented'").get().n, before, 'no documented edge from the detector');
    // the deferred human layer then reviews the cue citation: Reader A confirms, Reader B rejects → disputed
    const { applyDeferred } = await import('../server/jobs/tasks/demo-load.mjs');
    const out = await applyDeferred(taskCtx(db).ctx);
    assert.equal(out.reviews, 2);
    assert.equal(db.prepare('SELECT review_status FROM relationship WHERE id = ?').get(cue[0].id).review_status, 'disputed');
  });

  test('clustering and Compare calibration (§9.6: k = 4, ARI ≥ 0.8; gates) belong to WP4', { skip: 'WP4 cluster/compare are checked by tests/analysis.*' }, () => {});
});

describe('demo routes (GET /api/corpora, /api/facets) on the loaded demo', () => {
  let t, db;
  before(async () => {
    t = makeTmpData({ seed: false });
    db = t.db;
    await registerAdapters(db);
    const { run } = await import('../server/jobs/tasks/demo-load.mjs');
    await run(taskCtx(db).ctx, { pipeline: false });
  });
  after(() => t.cleanup());

  test('corporaQuery: the demo collection with its coverage, span, caveats, status and synthetic flags', async () => {
    const { corporaQuery } = await import('../server/routes/corpora.mjs');
    const body = corporaQuery(db);
    assertShape('Corpora', body);
    // contract 1.3.0: the virtual corpus `real` is listed last; with only the synthetic demo loaded it has no member
    assert.deepEqual(body.filter((c) => !c.virtual).map((c) => c.slug), ['demo', 'cipher', 'stemm', 'user']);
    assert.deepEqual(body.filter((c) => c.virtual).map((c) => [c.slug, c.members, c.available]), [['real', [], false]]);
    const demo = body[0];
    assert.equal(demo.synthetic, true);
    const c = demo.collections[0];
    assert.equal(c.slug, 'demo-world');
    assert.equal(c.docs, readJsonl('documents.jsonl').length);
    assert.ok(c.tokens > 50000);
    assert.equal(c.undated, 1);
    assert.equal(c.scheduled, 1);
    assert.equal(c.span[0], 'c. 1894');
    assert.equal(c.status, 'ready');
    assert.equal(c.synthetic, true);
    assert.ok(c.caveats.some((x) => /invented/.test(x)));
  });

  test('facetsQuery: community lanes with labels and counts; filters narrow; an empty filter result is {}', async () => {
    const { facetsQuery } = await import('../server/routes/corpora.mjs');
    const all = facetsQuery(db, { corpus: 'demo' });
    assertShape('Facets', all);
    assert.equal(all.facets.community.length, 10);
    assert.ok(all.facets.community.some((v) => v.value === 'hiphop' && v.label === 'Hip-hop'));
    assert.equal(all.provenance.synthetic, true);
    assert.deepEqual(all.provenance.collections, ['demo-world']);
    const gu = facetsQuery(db, { corpus: 'demo', f: 'lang:gu' });
    assert.ok(gu.facets.community.every((v) => v.value === 'gujarati'));
    const none = facetsQuery(db, { corpus: 'demo', f: 'lang:la' });
    assert.deepEqual(none.facets, {});
    const noSyn = facetsQuery(db, { f: 'syn:0' });
    assert.deepEqual(noSyn.facets, {});
  });
});
