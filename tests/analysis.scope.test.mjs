// OWNER: WP4 — what a clustering run is built from and how it writes (SPEC §4.8, §4.12, §10.4, §13 rule 8): one
// medium per run (the others counted as excluded), named collections, a top-cited-per-cell scope with groups but no
// windows or transitions across cells, contraction fragments kept out of contexts, occurrence vectors weighted by
// association with the target, writes retried while another connection holds the lock, and token streams that stay
// current when only counts change. Every corpus here is invented for the test.

import assert from 'node:assert/strict';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { after, before, describe, test } from 'node:test';
import { mulberry32 } from '../src/shared/ids.mjs';
import { nowIso, openDb, setMeta, tx } from '../server/db/open.mjs';
import { assertInputsUnchanged, retryBusy } from '../server/analysis/commit.mjs';
import { compareQuery } from '../server/analysis/compare.mjs';
import { occurrenceVectors, targetAssociation, WEIGHTINGS } from '../server/analysis/occvec.mjs';
import { contextStopSet, contextWords } from '../server/analysis/tfidf-hash.mjs';
import { buildTokenStreams, streamStatus } from '../server/analysis/tokstream.mjs';
import { makeTaskContext } from '../server/jobs/context.mjs';
import { clusterParams, clusterScope, run as runCluster } from '../server/jobs/tasks/cluster.mjs';
import { createBatch, createDocumentWriter, ensureCollection } from '../server/store/document-writer.mjs';
import { buildAnalysisCorpus, materializeForTest } from './analysis.fixture.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'silent';

const taskCtx = (db) => makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
const PARAMS = { representation: 'tfidf-hash-4096', seed: 7, threads: 0 };

/** An invented top-cited-per-cell abstracts collection: 'ledger' in two clearly different contexts, two periods. */
function writeSampledAbstracts(db) {
  const coll = ensureCollection(db, { corpus: 'test', domain: 'stemm', slug: 'ana-cells', name: 'Invented top-cited sample (synthetic)',
    modality: 'abstracts', unit: 'works', sampling: 'top_cited_per_cell', coverage_gate: 20, adapter_id: 'file.jsonl', export_text_allowed: 0 });
  const writer = createDocumentWriter(db, { batchId: createBatch(db, { collection: coll.id, format: 'jsonl' }), collection: coll.slug, corpus: 'test',
    options: { now: new Date('2026-10-04T12:00:00Z') } });
  const rng = mulberry32(5);
  const pick = (l) => l[Math.floor(rng() * l.length)];
  const A = 'auditors triplicate budget quota clerk department memo invoice'.split(' ');
  const B = 'blockchain consensus distributed nodes cryptographic hash peers protocol'.split(' ');
  for (let i = 0; i < 140; i++) {
    const pool = i % 2 ? A : B;
    const words = Array.from({ length: 6 }, () => pick(pool));
    writer.addDocument({ ext_id: `cell:${i}`, kind: 'paper', title: `Invented paper ${i}`, author: `Author ${i % 30} (synthetic)`,
      fields: { title: `Invented paper ${i}`, abstract: `We ${words.slice(0, 3).join(' ')} the ledger ${words.slice(3).join(' ')} in practice.` },
      dates: [{ role: 'publication', raw: String(i < 70 ? 1925 : 2015), asserted_by: 'fixture:analysis', is_chronology: true }],
      original_meta: { fixture: 'analysis', note: 'invented test abstract (synthetic)' } });
  }
  writer.finish();
}

describe('the medium and collections a clustering run is built from', () => {
  let tmp, db, ledger;
  before(() => {
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    buildAnalysisCorpus(db);
    writeSampledAbstracts(db);
    ledger = materializeForTest(db, { surface: 'ledger' });
  });
  after(() => tmp.cleanup());

  test('without collections the medium holding most occurrences is clustered; the others are counted, not mixed in', async () => {
    const res = await runCluster(taskCtx(db), { expressionId: ledger.exprId, params: PARAMS });
    const run = db.prepare('SELECT scope_json, metrics_json, params_json FROM analysis_run WHERE id = ?').get(res.run_id);
    const scope = JSON.parse(run.scope_json), m = JSON.parse(run.metrics_json);
    assert.equal(scope.modality, 'text');
    assert.deepEqual(scope.collections, ['ana-text']);
    assert.equal(scope.sampled, false);
    const other = db.prepare(`SELECT COUNT(*) AS n FROM occurrence o JOIN document d ON d.id = o.document_id JOIN collection c ON c.id = d.collection_id
      WHERE o.expression_id = ? AND c.modality != 'text' AND o.name_flag = 0`).get(ledger.exprId).n;
    assert.ok(other > 0);
    assert.equal(m.excluded.other_modality, other);
    assert.match(m.scope.note, /not clustered with them: context groups are found within one medium/);
    assert.equal(JSON.parse(run.params_json).version, 'cluster@1.1.0');
  });

  test('a top-cited-per-cell scope gets groups but no windows, shares, transitions or convergence across cells', async () => {
    const res = await runCluster(taskCtx(db), { expressionId: ledger.exprId, params: { ...PARAMS, collections: ['ana-cells'] } });
    assert.equal(res.gate, 'ok', JSON.stringify(res));
    assert.equal(res.k, 2);
    assert.equal(res.windows, 0);
    assert.equal(res.transitions, 0);
    const m = JSON.parse(db.prepare('SELECT metrics_json FROM analysis_run WHERE id = ?').get(res.run_id).metrics_json);
    assert.equal(m.windows_gate.gate, 'sampling_design');
    assert.equal(m.windows_gate.value, null);
    assert.equal(m.convergence_pairs, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM time_window WHERE run_id = ?').get(res.run_id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cluster_transition WHERE run_id = ?').get(res.run_id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sense_cluster WHERE run_id = ?').get(res.run_id).n, 2);
  });

  test("a comparison stays inside one corpus: the virtual corpus 'real' is refused with what to do instead", () => {
    assert.throws(() => compareQuery(db, { expr: [ledger.exprId], a: { years: [1900, 1949] }, b: { years: [1990, 2020] }, corpus: 'real' }),
      (e) => e.status === 400 && /one corpus at a time/.test(e.message) && /member corpus/.test(e.hint));
  });

  test('named collections must exist and share one medium', () => {
    assert.throws(() => clusterScope(db, [], ['ana-text', 'ana-titles']), /mix media/);
    assert.throws(() => clusterScope(db, [], ['no-such-collection']), /Unknown collection/);
    assert.throws(() => clusterParams({ expressionId: 1, params: { collections: 'ana-text' } }), /collection slugs/);
    assert.deepEqual(clusterParams({ expressionId: 1, params: { collections: ['b-x', 'a-x', 'b-x'] } }).collections, ['a-x', 'b-x']);
  });
});

describe('contexts and occurrence vectors', () => {
  test('contraction fragments never enter an English context', () => {
    const stop = contextStopSet('en');
    for (const w of ['t', 'don', 'll', 're', 's', 'the']) assert.ok(stop.has(w), w);
    const toks = 'well i don t know if the ledger s page was ll torn'.split(' ');
    assert.deepEqual(contextWords(toks, 7, 8, { window: 10, stop }), ['well', 'know', 'page', 'torn']);
    assert.ok(!contextStopSet('fr').has('don'));
  });

  test("'idf-assoc' weights each context word by idf × (1 + its PPMI with the target)", () => {
    const vocab = ['river', 'money', 'loan', 'water'];
    const W = Float32Array.from([1, 0, 0, 1, 0.6, 0.8, 0.8, 0.6]); // river, money, loan, water (dim 2)
    const space = { id: 9, lang: 'en', dim: 2, pooled: true, vocab, index: new Map(vocab.map((w, i) => [w, i])), W,
      counts: Uint32Array.from([100, 1000, 50, 400]), idf: Float32Array.from([2, 1, 3, 1.5]), manifest: { tokens: 100000 } };
    const contexts = [['river', 'water', 'water'], ['money', 'loan', 'river'], ['river', 'loan', 'water'], ['river', 'money', 'water']];
    const assoc = targetAssociation(contexts, space, { stop: new Set() });
    // river: 4 of 12 context positions near the target vs 100 of 100,000 in the corpus
    assert.ok(Math.abs(assoc.get('river') - Math.log((4 / 12) / (100 / 100000))) < 1e-12);
    assert.equal(assoc.has('money'), false); // seen twice: below the minimum count of 3
    const r = occurrenceVectors(contexts.map((c) => ({ context: c })), space, { stop: new Set(), weighting: WEIGHTINGS.assoc, minContext: 1 });
    assert.equal(r.weighting, 'idf-assoc');
    const w = (x) => space.idf[space.index.get(x)] * (1 + (assoc.get(x) ?? 0));
    const want = [0, 0];
    for (const x of contexts[0]) { const i = space.index.get(x); want[0] += w(x) * W[i * 2]; want[1] += w(x) * W[i * 2 + 1]; }
    const norm = Math.hypot(...want);
    assert.ok(Math.abs(r.vectors[0][0] - want[0] / norm) < 1e-6 && Math.abs(r.vectors[0][1] - want[1] / norm) < 1e-6);
    const plain = occurrenceVectors(contexts.map((c) => ({ context: c })), space, { stop: new Set(), minContext: 1 });
    assert.equal(plain.weighting, 'idf');
    assert.throws(() => occurrenceVectors([], space, { weighting: 'nope' }), TypeError);
  });
});

describe('writes wait for a busy database instead of failing', () => {
  let tmp;
  before(() => { tmp = makeTmpData({ seed: true }); });
  after(() => tmp.cleanup());

  /** Hold the write lock from another thread for `ms`. */
  function holdLock(dbPath, ms) {
    const code = `const { DatabaseSync } = require('node:sqlite'); const { parentPort, workerData } = require('node:worker_threads');
      const db = new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout = 2000; BEGIN IMMEDIATE');
      parentPort.postMessage('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.ms);
      db.exec('COMMIT'); db.close(); parentPort.postMessage('released');`;
    const w = new Worker(code, { eval: true, workerData: { path: dbPath, ms } });
    return { locked: new Promise((r) => w.once('message', r)), done: new Promise((r) => w.once('exit', r)) };
  }

  test('a commit retries until the lock is free; a cancel between attempts stops it', async () => {
    const db = openDb({ path: tmp.dbPath });
    db.exec('PRAGMA busy_timeout = 20');
    db.exec('CREATE TABLE IF NOT EXISTS _a4_probe (x INTEGER)');
    const h = holdLock(tmp.dbPath, 400);
    await h.locked;
    let checks = 0;
    retryBusy(() => tx(db, () => db.prepare('INSERT INTO _a4_probe VALUES (1)').run()), { checkpoint: () => { checks++; } });
    assert.ok(checks > 0, 'the first attempt met the held lock and was retried');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _a4_probe').get().n, 1);
    await h.done;
    const h2 = holdLock(tmp.dbPath, 400);
    await h2.locked;
    const cancel = new Error('cancelled');
    assert.throws(() => retryBusy(() => tx(db, () => db.prepare('INSERT INTO _a4_probe VALUES (2)').run()), { checkpoint: () => { throw cancel; } }),
      (e) => e === cancel);
    await h2.done;
    assert.throws(() => retryBusy(() => { throw new Error('not busy'); }), /not busy/);
    db.close();
  });

  test("a run's rows are stored only while its inputs are the ones it started on", () => {
    const db = tmp.db;
    const ctx = taskCtx(db);
    const mk = (slug) => ensureCollection(db, { corpus: 'user', domain: 'imported', slug, name: `${slug} (synthetic)`, modality: 'text', unit: 'tokens',
      sampling: 'user', adapter_id: 'file.txt' });
    const mine = mk('a4-inputs'), other = mk('a4-other');
    const add = (coll, id) => {
      const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: coll.id }), collection: coll.slug, corpus: 'user' });
      w.addDocument({ ext_id: `a4:${id}`, kind: 'memo', author: 'Writer (synthetic)', text: { original: `Ledger entry ${id} (synthetic).`, decoder: 'utf-8' },
        dates: [{ role: 'publication', raw: '1990', asserted_by: 'test', is_chronology: true }], original_meta: { fixture: 'analysis' } });
      w.finish();
    };
    add(mine, 'first');
    const runId = ctx.startRun('collocations', { pipelineVersion: 'test@1', params: { probe: 1 }, scope: { collections: [mine.slug] }, upstream: [] });
    add(other, 'elsewhere'); // an import into another collection leaves this run's inputs as they were
    assert.doesNotThrow(() => tx(db, () => assertInputsUnchanged(db, runId)));
    add(mine, 'meanwhile'); // one into its own collection commits while it computes
    assert.throws(() => tx(db, () => assertInputsUnchanged(db, runId)), (e) => e.code === 'E_INPUTS_CHANGED' && e.status === 409 && /nothing of it was stored/.test(e.message));
    ctx.finishRun(runId, 'failed');
  });
});

describe('token streams stay current while only counts change', () => {
  let tmp;
  before(() => { tmp = makeTmpData({ seed: true }); });
  after(() => tmp.cleanup());

  test('a data-version bump (counting an expression) keeps the stream fresh; a new passage does not', () => {
    const db = tmp.db;
    const dir = path.join(tmp.dir, 'derived', 'tokens');
    buildTokenStreams(db, { langs: ['en'], dir });
    assert.equal(streamStatus(db, dir, 'en').fresh, true);
    setMeta(db, 'data_version', Number(db.prepare("SELECT value FROM meta WHERE key = 'data_version'").get().value) + 5);
    assert.equal(streamStatus(db, dir, 'en').fresh, true);
    const coll = ensureCollection(db, { corpus: 'user', domain: 'imported', slug: 'a4-late', name: 'Late (synthetic)', modality: 'text', unit: 'tokens',
      sampling: 'user', adapter_id: 'file.txt' });
    const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: coll.id }), collection: coll.slug, corpus: 'user' });
    w.addDocument({ ext_id: 'a4:late', kind: 'memo', author: 'Late (synthetic)', text: { original: 'A late ledger entry was added today.', decoder: 'utf-8' },
      dates: [{ role: 'publication', raw: '2010', asserted_by: 'test', is_chronology: true }], original_meta: { fixture: 'analysis', at: nowIso() } });
    w.finish();
    assert.equal(streamStatus(db, dir, 'en').fresh, false);
  });
});
