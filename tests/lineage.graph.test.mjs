// OWNER: WP5 — the lineage explorer, chain of custody and genealogy (SPEC §2.C, §2.C2): bounded graphs with stated
// truncation, evidence status kept on every edge, "documented only" excludes computed and proposed, rejected and
// kindred hidden by default, rows of unsuccessful runs invisible, least-evidence-cost path with its weakest link

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { nowIso } from '../server/db/open.mjs';
import { writeCommonplaces, commonplaceNode } from '../server/lineage/commonplace.mjs';
import { genealogyQuery } from '../server/lineage/genealogy.mjs';
import { lineageQuery } from '../server/lineage/graph.mjs';
import { pathQuery } from '../server/lineage/path.mjs';
import { relationshipCard } from '../server/provenance/relationships.mjs';
import { reviewRelationship } from '../server/provenance/reviews.mjs';
import { createBatch, createDocumentWriter, ensureCollection } from '../server/store/document-writer.mjs';
import { assertShape, checkResponse } from './helpers/shape.mjs';
import { startServerInProcess } from './helpers/server.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

function run(db, status = 'succeeded', stage = 'reuse-index') {
  return Number(db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
      input_fingerprint, data_version, tokenizer_version, segmenter_version, icu_version, status, started_at)
    VALUES (?, 'test@1', 'x', '{}', 'x', '{}', 'x', 0, 'u61m-1', 'seg-1', 'icu', ?, ?)`).run(stage, status, nowIso()).lastInsertRowid);
}

function rel(db, { type = 'passage', src, dst, dstType = type, rel_type, status, origin, runId = null, review = 'unreviewed',
  dataset = null, locator = null, group = null, createdBy = null, directed = 1 }) {
  const by = createdBy ?? (origin === 'human' ? 'human:Reader A (synthetic)' : origin === 'algorithm' ? `run:${runId}` : 'adapter:test@1');
  return Number(db.prepare(`INSERT INTO relationship (rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin,
      source_dataset, source_locator, method, run_id, created_by, review_status, hypothesis_group_id, is_synthetic, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(rel_type, type, String(src), dstType, String(dst), directed, status, origin, dataset, locator,
      origin === 'algorithm' || origin === 'machine_tagger' ? 'test method' : null, runId, by, review, group, nowIso()).lastInsertRowid);
}

describe('lineage graph and chain of custody', () => {
  let tmp, db, P, R = {};
  before(() => {
    tmp = makeTmpData();
    db = tmp.db;
    P = Object.fromEntries([...tmp.mini.ids].map(([ext, id]) => [ext,
      db.prepare("SELECT id FROM passage WHERE document_id = ? ORDER BY field = 'body' DESC, start_off LIMIT 1").get(id).id]));
    const ok = run(db), failed = run(db, 'failed');
    R.doc = rel(db, { src: P['mini:03'], dst: P['mini:02'], rel_type: 'explicit_citation', status: 'documented', origin: 'source_dataset',
      dataset: 'demo-records', locator: 'demo-records:bulletin' });
    R.calc = rel(db, { src: P['mini:03'], dst: P['mini:02'], rel_type: 'exact_quotation', status: 'computed', origin: 'algorithm', runId: ok });
    R.prop = rel(db, { src: P['mini:06'], dst: P['mini:03'], rel_type: 'proposed_allusion', status: 'proposed', origin: 'human' });
    R.rejected = rel(db, { src: P['mini:07'], dst: P['mini:02'], rel_type: 'proposed_allusion', status: 'proposed', origin: 'human', review: 'rejected' });
    R.kindred = rel(db, { src: P['mini:04'], dst: P['mini:02'], rel_type: 'kindred', status: 'computed', origin: 'algorithm', runId: ok, directed: 0 });
    R.failed = rel(db, { src: P['mini:05'], dst: P['mini:02'], rel_type: 'exact_quotation', status: 'computed', origin: 'algorithm', runId: failed });
    R.reframes = rel(db, { src: P['mini:09'], dst: P['mini:02'], rel_type: 'reframes', status: 'documented', origin: 'source_dataset',
      dataset: 'demo-records', locator: 'demo-records:essay' });
    const g = Number(db.prepare(`INSERT INTO hypothesis_group (target_type, target_ref, question, created_by, is_synthetic, created_at)
      VALUES ('passage', ?, 'Where does the poem come from?', 'human:Reader A (synthetic)', 1, ?)`).run(String(P['mini:06']), nowIso()).lastInsertRowid);
    R.group = g;
    R.h2 = rel(db, { src: P['mini:06'], dst: P['mini:01'], rel_type: 'proposed_allusion', status: 'proposed', origin: 'human', group: g });
    db.prepare('UPDATE relationship SET hypothesis_group_id = ? WHERE id = ?').run(g, R.prop);
    R.failedRun = failed;
  });
  after(() => tmp.cleanup());

  test('a bounded graph around a root: generations are hops, edges keep their evidence status', () => {
    const g = lineageQuery(db, { root: `passage:${P['mini:02']}` });
    assertShape('Lineage', g);
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    assert.equal(byId[`passage:${P['mini:02']}`].generation, 0);
    assert.equal(byId[`passage:${P['mini:03']}`].generation, 1);
    assert.equal(byId[`passage:${P['mini:03']}`].direction, 'later');
    assert.equal(byId[`passage:${P['mini:06']}`].generation, 2);
    assert.equal(byId[`passage:${P['mini:03']}`].title, 'Bench Bulletin No. 7');
    assert.ok(byId[`passage:${P['mini:03']}`].snippet.startsWith('Bench Bulletin No. 7'));
    const edges = Object.fromEntries(g.edges.map((e) => [e.rel_id, e]));
    assert.equal(edges[R.doc].evidence_status, 'documented');
    assert.equal(edges[R.calc].evidence_status, 'computed');
    assert.equal(edges[R.prop].evidence_status, 'proposed');
    assert.equal(edges[R.reframes].feedback, true, 'a documented reframing is drawn as feedback');
    assert.equal(edges[R.calc].feedback, false, 'computed similarity is never feedback');
    assert.ok(!edges[R.rejected], 'rejected links are hidden by default');
    assert.ok(!edges[R.kindred], 'kindred pairs are hidden by default');
    assert.ok(!edges[R.failed], 'rows of a failed run are invisible');
    assert.throws(() => relationshipCard(db, R.failed), (e) => e.status === 404, 'not even by id');
    assert.throws(() => reviewRelationship(db, R.failed, { action: 'confirm', note: 'Looks right to me, honestly.' }), (e) => e.status === 404);
    assert.deepEqual(g.groups, [{ id: R.group, question: 'Where does the poem come from?', edges: [R.prop, R.h2], text: '⚖ 2 competing' }]);
    assert.equal(g.truncated.nodes, 0);
  });

  test('"documented only" excludes computed and proposed; rejected, kindred and pinned runs on request', () => {
    const doc = lineageQuery(db, { root: `passage:${P['mini:02']}`, status: 'documented' });
    assert.ok(doc.edges.length >= 2);
    assert.ok(doc.edges.every((e) => e.evidence_status === 'documented'));
    const all = lineageQuery(db, { root: `passage:${P['mini:02']}`, rejected: '1', kindred: '1', runs: String(R.failedRun) });
    const ids = all.edges.map((e) => e.rel_id);
    for (const k of ['rejected', 'kindred', 'failed']) assert.ok(ids.includes(R[k]), `${k} shown on request`);
    const typed = lineageQuery(db, { root: `passage:${P['mini:02']}`, types: 'exact_quotation' });
    assert.deepEqual(typed.edges.map((e) => e.rel_type), ['exact_quotation']);
    assert.throws(() => lineageQuery(db, { root: `passage:${P['mini:02']}`, types: 'influenced' }), (e) => e.status === 400);
    assert.throws(() => lineageQuery(db, { root: 'passage:999999' }), (e) => e.status === 404);
    assert.throws(() => lineageQuery(db, { root: 'nonsense' }), (e) => e.status === 400);
  });

  test('truncation is stated, never silent; outer nodes say how many links remain', () => {
    const small = lineageQuery(db, { root: `passage:${P['mini:02']}`, max_nodes: '2' });
    assert.equal(small.nodes.length, 2);
    assert.ok(small.truncated.nodes >= 1);
    assert.match(small.truncated.reason, /^showing 2 nodes/);
    assert.ok(small.nodes.find((n) => n.generation === 0).expandable >= 1);
    const shallow = lineageQuery(db, { root: `passage:${P['mini:02']}`, depth: '1' });
    assert.ok(shallow.nodes.find((n) => n.id === `passage:${P['mini:03']}`).expandable >= 1, 'the poem behind the bulletin is one hop further');
  });

  test('text shared by > 25 documents collapses into one "widely shared text" node', () => {
    writeCommonplaces({ run: null, collections: ['mini'], at: nowIso(), passages: { [P['mini:03']]: { key: '0badf00d', docs: 31 } },
      groups: { '0badf00d': { docs: 31, passages: [P['mini:03']] } } });
    const g = lineageQuery(db, { root: `passage:${P['mini:02']}` });
    const node = g.nodes.find((n) => n.id === 'shared:0badf00d');
    assert.equal(node.label, 'widely shared text (31 documents)');
    assert.deepEqual(g.links, [{ from: `passage:${P['mini:03']}`, to: 'shared:0badf00d', kind: 'commonplace' }]);
    assert.equal(commonplaceNode(null, '0badf00d').documents, 31);
    assert.throws(() => commonplaceNode(null, 'ffffffff'), (e) => e.status === 404);
  });

  test('a "widely shared text" node expands to its recorded passages, each linked to the node and never pairwise', () => {
    const g = lineageQuery(db, { root: 'shared:0badf00d' });
    assertShape('Lineage', g);
    assert.equal(g.nodes[0].id, 'shared:0badf00d');
    assert.deepEqual(g.nodes.slice(1).map((n) => [n.id, n.generation]), [[`passage:${P['mini:03']}`, 1]]);
    assert.deepEqual(g.links, [{ from: `passage:${P['mini:03']}`, to: 'shared:0badf00d', kind: 'commonplace' }]);
    assert.deepEqual(g.edges, [], 'no quotation pairs');
    assert.equal(g.truncated.nodes, 0);
    assert.match(g.note, /^Text shared by 31 documents is drawn as one node, not as pairs\. .*30 more documents hold it\.$/);
    writeCommonplaces({ run: null, collections: ['mini-big'], at: nowIso(), passages: {},
      groups: { '00c0ffee': { docs: 40, passages: Object.values(P) } } });
    const small = lineageQuery(db, { root: 'shared:00c0ffee', max_nodes: '4' });
    assert.equal(small.nodes.length, 4);
    assert.equal(small.truncated.nodes, Object.values(P).length - 3);
    assert.match(small.truncated.reason, /^showing 3 of 12 recorded passages/);
    assert.throws(() => lineageQuery(db, { root: 'shared:xyz' }), (e) => e.status === 400);
    assert.throws(() => lineageQuery(db, { root: 'shared:ffffffff' }), (e) => e.status === 404);
  });

  test('as saved: a relationship revision cutoff hides later links and shows the review status of then', () => {
    const rev = (id, n, actor, action) => Number(db.prepare(`INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, after_json)
      VALUES (?, ?, ?, ?, ?, '{}')`).run(id, n, actor, nowIso(), action).lastInsertRowid);
    for (const k of ['doc', 'calc', 'prop', 'h2', 'reframes']) rev(R[k], 1, 'adapter:test@1', 'create');
    const cutoff = db.prepare('SELECT MAX(id) AS n FROM relationship_revision').get().n;
    rev(R.prop, 2, 'human:Reader B (synthetic)', 'reject');
    db.prepare("UPDATE relationship SET review_status = 'rejected' WHERE id = ?").run(R.prop);
    const later = rel(db, { src: P['mini:08'], dst: P['mini:02'], rel_type: 'proposed_allusion', status: 'proposed', origin: 'human' });
    rev(later, 1, 'human:Reader A (synthetic)', 'create');
    const root = `passage:${P['mini:02']}`;
    const nowIds = lineageQuery(db, { root }).edges.map((e) => e.rel_id);
    assert.ok(!nowIds.includes(R.prop) && nowIds.includes(later));
    const then = lineageQuery(db, { root, rel_rev_cutoff: String(cutoff) });
    const ids = then.edges.map((e) => e.rel_id);
    assert.ok(ids.includes(R.prop), 'rejected after the cutoff: still shown as saved');
    assert.equal(then.edges.find((e) => e.rel_id === R.prop).review_status, 'unreviewed');
    assert.ok(!ids.includes(later), 'created after the cutoff: not in the view as saved');
    assert.equal(pathQuery(db, { from: `passage:${P['mini:06']}`, to: root, rel_rev_cutoff: String(cutoff) }).cost, 6);
    // restore the current state for the next tests
    db.prepare("UPDATE relationship SET review_status = 'unreviewed' WHERE id = ?").run(R.prop);
  });

  test('chain of custody: least evidence cost, weakest link named; rejected links never carry a chain', () => {
    const p = pathQuery(db, { from: `passage:${P['mini:06']}`, to: `passage:${P['mini:02']}` });
    assertShape('LineagePath', p);
    assert.deepEqual(p.path.map((e) => [e.rel_id, e.cost]), [[R.prop, 5], [R.doc, 1]]);
    assert.equal(p.cost, 6);
    assert.equal(p.weakest, 'proposed');
    assert.equal(p.text, 'Chain strength: weakest link PROPOSED.');
    const rev = pathQuery(db, { from: `passage:${P['mini:02']}`, to: `passage:${P['mini:06']}` });
    assert.equal(rev.reversed, true);
    assert.equal(rev.cost, 6);
    const none = pathQuery(db, { from: `passage:${P['mini:07']}`, to: `passage:${P['mini:02']}` });
    assertShape('LineagePath', none);
    assert.deepEqual([none.path, none.weakest], [[], null]);
    assert.match(none.note, /rejected links are excluded/);
    const docOnly = pathQuery(db, { from: `passage:${P['mini:03']}`, to: `passage:${P['mini:02']}`, status: 'computed' });
    assert.deepEqual([docOnly.path.map((e) => e.rel_id), docOnly.weakest], [[R.calc], 'computed']);
  });
});

describe('genealogy (works mode)', () => {
  let tmp, db, W = {};
  before(() => {
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    db.prepare("INSERT INTO corpus (slug, name, kind, is_synthetic, created_at) VALUES ('test', 'Test (synthetic)', 'synthetic', 1, ?)").run(nowIso());
    const coll = ensureCollection(db, { slug: 'songs', name: 'Songs (synthetic)', corpus: 'test', adapter_id: 'file.jsonl', domain: 'imported',
      modality: 'titles', unit: 'works', sampling: 'user' });
    const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: coll.id }), collection: 'songs', corpus: 'test' });
    const works = [['lesson', 'Counting Lesson No. 4', 'Board (synthetic)', '1952'], ['zero', 'Zero Holds the Place', 'MC Ledger (synthetic)', '1994'],
      ['remix', 'Zero Holds (Remix)', 'DJ Col (synthetic)', '1996'], ['cover', 'Hold the Place', 'Band Two (synthetic)', '2008'],
      ['grand', 'Place Holders', 'Crew Three (synthetic)', '2011'], ['old', 'Old Break', 'Drummer (synthetic)', '1949'],
      ['maybe', 'Maybe Sampled', 'Rumour (synthetic)', '2001']];
    for (const [ext, title, author, year] of works) {
      W[ext] = w.addDocument({ ext_id: ext, kind: 'song', title, author, dates: [{ role: 'release', raw: year, asserted_by: 'test', is_chronology: true }],
        original_meta: {} }).documentId;
    }
    w.finish();
    const doc = (src, dst, type, extra = {}) => rel(db, { type: 'document', src: W[src], dst: W[dst], rel_type: type, status: 'documented',
      origin: 'source_dataset', dataset: 'musicbrainz', locator: `https://musicbrainz.org/recording/${src}`, ...extra });
    W.r1 = doc('zero', 'lesson', 'samples');
    W.r2 = doc('remix', 'zero', 'remix_of');
    W.r3 = doc('cover', 'zero', 'cover_of');
    W.r4 = doc('grand', 'cover', 'samples');
    W.r5 = doc('lesson', 'old', 'samples');
    W.r6 = rel(db, { type: 'document', src: W.maybe, dst: W.lesson, rel_type: 'samples', status: 'proposed', origin: 'machine_tagger' });
  });
  after(() => tmp.cleanup());

  test('generations forward and back, sorted by date, with decade density and locators; documented only by default', () => {
    const g = genealogyQuery(db, { work: `document:${W.lesson}` });
    assertShape('Genealogy', g);
    assert.deepEqual(g.seed, { doc: W.lesson, title: 'Counting Lesson No. 4', maker: 'Board (synthetic)', year: 1952, date: { label: '1952', precision: 'year' } });
    assert.deepEqual(g.generations.map((x) => [x.gen, x.total]), [[-1, 1], [1, 1], [2, 2], [3, 1]]);
    const g2 = g.generations.find((x) => x.gen === 2);
    assert.deepEqual(g2.rows.map((r) => r.title), ['Zero Holds (Remix)', 'Hold the Place'], 'sorted by date');
    assert.deepEqual(g2.by_decade, { 1990: 1, 2000: 1 });
    assert.deepEqual(g.generations.find((x) => x.gen === 1).rows[0].edges[0],
      { rel_id: W.r1, rel_type: 'samples', evidence_status: 'documented', review_status: 'unreviewed', source_dataset: 'musicbrainz',
        locator: 'https://musicbrainz.org/recording/zero', provenance_quality: 'complete', date_conflict: false, parent: W.lesson });
    assert.ok(!g.generations.flatMap((x) => x.rows).some((r) => r.doc === W.maybe), 'a proposed link is not in the documented genealogy');
    assert.deepEqual([...new Set(g.generations.flatMap((x) => x.rows).map((r) => `${r.collection}:${r.rate_eligible}`))], ['songs:true'],
      'rows name their collection, so relation-endpoint works can be labelled and kept out of rates');
    assert.match(g.note, /Absence of a link is not evidence of no sampling\.$/);
    assert.equal(g.synthetic, true);
    const withProposed = genealogyQuery(db, { work: `document:${W.lesson}`, status: 'documented,proposed', dir: 'forward', depth: '1' });
    assert.deepEqual(withProposed.generations.map((x) => x.total), [2]);
  });

  test('paging states what was left out; empty seeds say absence is not evidence; makers seed all their works', () => {
    const p1 = genealogyQuery(db, { work: `document:${W.lesson}`, max: '2' });
    assert.equal(p1.generations.reduce((s, x) => s + x.returned, 0), 2);
    assert.equal(p1.truncated.rows, 3);
    const p2 = genealogyQuery(db, { work: `document:${W.lesson}`, max: '2', cursor: p1.truncated.cursor });
    assert.equal(p2.generations.reduce((s, x) => s + x.returned, 0), 2);
    const empty = genealogyQuery(db, { work: `document:${W.maybe}`, dir: 'forward' });
    assert.deepEqual(empty.generations, []);
    assert.equal(empty.note, 'No documented sample, cover, remix or version links. Absence of a link is not evidence of no sampling.');
    const maker = genealogyQuery(db, { maker: 'MC Ledger (synthetic)', dir: 'forward', depth: '1' });
    assert.equal(maker.seed.works, 1);
    assert.equal(maker.generations[0].total, 2);
    const bySlug = genealogyQuery(db, { maker: 'mc-ledger-synthetic', dir: 'forward', depth: '1' });
    assert.deepEqual([bySlug.seed.maker, bySlug.seed.works, bySlug.generations[0].total], ['MC Ledger (synthetic)', 1, 2],
      'a search suggestion’s maker reference is a slug');
    assert.throws(() => genealogyQuery(db, { maker: 'nobody-at-all' }), (e) => e.status === 404);
    assert.throws(() => genealogyQuery(db, { work: 'passage:1' }), (e) => e.status === 400);
    assert.throws(() => genealogyQuery(db, { work: 'document:99999' }), (e) => e.status === 404);
  });
});

describe('HTTP: lineage, path and genealogy run in the read pool with their contract shapes', () => {
  let tmp, srv, p2, p3;
  before(async () => {
    tmp = makeTmpData();
    const db = tmp.db;
    const pid = (ext) => db.prepare("SELECT id FROM passage WHERE document_id = ? AND field = 'body'").get(tmp.mini.ids.get(ext)).id;
    p2 = pid('mini:02');
    p3 = pid('mini:03');
    rel(db, { src: p3, dst: p2, rel_type: 'explicit_citation', status: 'documented', origin: 'source_dataset', dataset: 'demo-records', locator: 'x' });
    process.env.SCROLLS_READ_WORKERS = '1';
    srv = await startServerInProcess({ dataDir: tmp.dir });
  });
  after(async () => {
    await srv?.cleanup();
    delete process.env.SCROLLS_READ_WORKERS;
    tmp.cleanup();
  });

  const get = async (path) => {
    const r = await srv.request('GET', path);
    return { status: r.status, json: await checkResponse(new Response(r.text, { status: r.status }), 'GET', path.split('?')[0]) };
  };

  test('shapes and errors', async () => {
    const g = await get(`/api/lineage?root=passage:${p2}`);
    assert.equal(g.status, 200);
    assert.equal(g.json.edges.length, 1);
    const p = await get(`/api/lineage/path?from=passage:${p3}&to=passage:${p2}`);
    assert.equal(p.json.weakest, 'documented');
    const gen = await get(`/api/genealogy?work=document:${tmp.mini.ids.get('mini:02')}`);
    assert.equal(gen.json.generations.length, 0);
    assert.equal((await get('/api/lineage?root=passage:999999')).status, 404);
    assert.equal((await get('/api/lineage?root=bad')).status, 400);
  });
});
