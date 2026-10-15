// OWNER: WP8 — M1 integration-gate regressions (SPEC §12.5/§12.6): cross-package fixes made at the gate, each
// pinned by a test here. Uses the generated test corpus and the mini corpus only (no Cipher files).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { check } from '../src/shared/contracts.mjs';
import { formatFilter } from '../src/shared/viewstate.mjs';
import { queryBody } from '../src/ui/timeline/tiles-client.mjs';
import { materializeInline, trackExpression } from '../server/aggregate/materialize.mjs';
import { buildDef, canonicalRequest, timelineQuery } from '../server/aggregate/query.mjs';
import { tilesQuery } from '../server/aggregate/tiles.mjs';
import { routes as passageRoutes } from '../server/routes/passages.mjs';
import { buildGeneratedCorpus } from './aggregate.corpus.mjs';
import { loadMini, makeTmpData } from './helpers/tmpdata.mjs';

const laterDoc = {
  ext_id: 'gate:later-1', kind: 'book', title: 'A later import (synthetic)', author: 'Gate Tester (synthetic)', lang_declared: 'en',
  text: { original: 'The ledger showed zero. Then zero again, and a third zero at the foot of the column.', decoder: 'utf-8' },
  dates: [{ role: 'publication', raw: '1950', asserted_by: 'test', is_chronology: true }], original_meta: { test: true },
};

describe('as saved: a pinned run and an import cutoff reproduce the counts saved before a later import (D17)', () => {
  let tmp, db, zero, run1, cutoff, saved;
  const request = (extra = {}) => canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: zero }],
    lanes: { facet: 'collection', max: 48 }, ...extra });
  const query = (extra) => timelineQuery(db, { def: buildDef(db, request(extra)).def });
  const laneTokens = (q) => Object.fromEntries(q.lanes.map((l) => [l.key, l.coverage?.tokens ?? null]));

  before(() => {
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    buildGeneratedCorpus(db, { seed: 21 });
    zero = trackExpression(db, { surface: 'zero', lang: 'en', corpus: 'test' }).id;
    materializeInline(db, zero);
    run1 = db.prepare('SELECT run_id FROM expression_state WHERE expression_id = ?').get(zero).run_id;
    cutoff = db.prepare('SELECT max(id) AS m FROM import_batch').get().m;
    saved = query();
    loadMini(db, { docs: [laterDoc], slug: 'gate-later' });
    materializeInline(db, zero);
  });
  after(() => tmp.cleanup());

  test('current data sees the later import; the cached denominators follow the data version', () => {
    const now = query();
    assert.ok(now.totals.n >= saved.totals.n + 3, `three more matches (${saved.totals.n} → ${now.totals.n})`);
    assert.ok(now.lanes.some((l) => l.key.includes('gate-later')), 'a lane for the later collection');
  });

  test('as saved (pinned run + cutoff) equals the counts and lane tokens before the import', () => {
    const asSaved = query({ runs: { materialize: { [zero]: run1 } }, cutoffs: { import_batch: cutoff } });
    assert.equal(asSaved.totals.n, saved.totals.n);
    assert.deepEqual(laneTokens(asSaved), laneTokens(saved));
    const def = buildDef(db, request({ runs: { materialize: { [zero]: run1 } }, cutoffs: { import_batch: cutoff } })).def;
    const tiles = tilesQuery(db, { def, tier: 'L2', tiles: [0, 1, 2, 3] });
    assert.deepEqual(check('Tiles', { queryKey: 'k', tier: 'L2', binWidth: tiles.binWidth, dataVersion: 1, tiles: tiles.tiles }), []);
  });

  test('a bad cutoff is a 400, never a silent current-data answer', () => {
    assert.throws(() => request({ cutoffs: { import_batch: -3 } }), (e) => e.status === 400 && e.code === 'E_VALIDATION');
  });

  test('the client sends pinned runs and the cutoff only when a saved view is opened as saved', () => {
    const view = { strands: [{ type: 'expression', id: zero }], corpus: 'test', lanes: { facet: 'collection', order: 'first_observed', max: 10, run: null },
      f: {}, toggles: {}, timeBasis: 'publication', runs: { materialize: {} } };
    const plain = queryBody(view, { formatFilter });
    assert.equal('runs' in plain, false);
    assert.equal('cutoffs' in plain, false);
    const pinned = queryBody({ ...view, runs: { materialize: { [zero]: run1 } } }, { formatFilter, cutoffs: { import_batch: cutoff } });
    assert.deepEqual(pinned.runs, { materialize: { [zero]: run1 } });
    assert.deepEqual(pinned.cutoffs, { import_batch: cutoff });
  });
});

describe('GET /api/occurrences/:id resolves an occurrence to its passage (contract 1.1.0)', () => {
  let tmp, db;
  before(() => { tmp = makeTmpData({ seed: false }); db = tmp.db; buildGeneratedCorpus(db, { seed: 5 }); });
  after(() => tmp.cleanup());

  test('Occurrence shape, offsets inside the passage, 404 for an unknown id', async () => {
    const zero = trackExpression(db, { surface: 'zero', lang: 'en', corpus: 'test' }).id;
    materializeInline(db, zero);
    const occ = db.prepare('SELECT id, passage_id FROM occurrence WHERE expression_id = ? LIMIT 1').get(zero);
    const route = passageRoutes.find((r) => r.path === '/api/occurrences/:id');
    const res = await route.handler({ params: { id: String(occ.id) }, query: {} }, { db });
    assert.deepEqual(check('Occurrence', res.json), []);
    assert.equal(res.json.passage, occ.passage_id);
    const p = db.prepare('SELECT start_off, end_off FROM passage WHERE id = ?').get(occ.passage_id);
    assert.ok(res.json.start >= p.start_off && res.json.end <= p.end_off, 'offsets lie in the passage');
    await assert.rejects(() => route.handler({ params: { id: '999999999' }, query: {} }, { db }), (e) => e.status === 404);
  });
});

describe('interactive writes are not starved by a bulk writer in a job worker (open.mjs handoff)', () => {
  test('a main-thread tx() gets the lock within a second while a worker commits back-to-back', async () => {
    const { Worker } = await import('node:worker_threads');
    const { openDb, tx, WRITE_YIELD_BUFFER } = await import('../server/db/open.mjs');
    const tmp = makeTmpData({ seed: false });
    try {
      tmp.db.exec('CREATE TABLE gate_bulk (x INTEGER)');
      const openUrl = new URL('../server/db/open.mjs', import.meta.url).href;
      const code = `
        const { workerData, parentPort } = require('node:worker_threads');
        import(workerData.openUrl).then(({ openDb, shareWriteYield, yieldToInteractiveWriters }) => {
          shareWriteYield(workerData.yieldBuf);
          const db = openDb({ path: workerData.dbPath });
          const ins = db.prepare('INSERT INTO gate_bulk (x) VALUES (?)');
          const until = Date.now() + 2500;
          parentPort.postMessage('started');
          let n = 0;
          while (Date.now() < until) {
            yieldToInteractiveWriters();
            db.exec('BEGIN IMMEDIATE');
            for (let i = 0; i < 200; i++) ins.run(n++);
            const t = Date.now(); while (Date.now() - t < 20) { /* hold the lock like a real batch */ }
            db.exec('COMMIT');
          }
          db.close();
          parentPort.postMessage('done');
        });`;
      const w = new Worker(code, { eval: true, workerData: { openUrl, dbPath: tmp.dbPath, yieldBuf: WRITE_YIELD_BUFFER } });
      await new Promise((r) => w.once('message', r));
      await new Promise((r) => setTimeout(r, 200));
      const main = openDb({ path: tmp.dbPath });
      const t0 = Date.now();
      tx(main, (db) => db.exec('INSERT INTO gate_bulk (x) VALUES (-1)'));
      const waited = Date.now() - t0;
      main.close();
      await new Promise((r) => w.once('exit', r));
      assert.ok(waited < 1000, `the interactive write waited ${waited} ms`);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('the modality seam is placed by full text in the strands\' languages (D15)', () => {
  test('a later document mostly in another language (with a stray English paragraph) does not move the English seam', async () => {
    const { seamsFor } = await import('../server/aggregate/seams.mjs');
    const tmp = makeTmpData({ seed: false });
    try {
      const en = { ext_id: 'seam:en', kind: 'book', title: 'English text (synthetic)', lang_declared: 'en',
        text: { original: 'The clerk kept the ledger open and counted every column twice before the auditors came in the morning.', decoder: 'utf-8' },
        dates: [{ role: 'publication', raw: '1920', asserted_by: 'test', is_chronology: true }], original_meta: {} };
      const hiBody = Array.from({ length: 12 }, () => 'यह एक छोटा परीक्षण वाक्य है और इसमें कई शब्द हैं जो हिंदी में लिखे गए हैं।').join(' ');
      const hi = { ext_id: 'seam:hi', kind: 'book', title: 'हिंदी पाठ (synthetic)', lang_declared: 'hi',
        text: { original: `${hiBody}\n\nThe clerk kept the ledger open and counted every column twice before the auditors came.`, decoder: 'utf-8' },
        dates: [{ role: 'publication', raw: '2020', asserted_by: 'test', is_chronology: true }], original_meta: {} };
      loadMini(tmp.db, { docs: [en, hi], slug: 'seam-test' });
      const corpusId = tmp.db.prepare("SELECT id FROM corpus WHERE slug = 'test'").get().id;
      const langsOf = tmp.db.prepare(`SELECT DISTINCT t.plang FROM doc_tokens t JOIN document d ON d.id = t.document_id WHERE d.ext_id = 'seam:hi'`).all().map((r) => r.plang);
      assert.ok(langsOf.includes('en') && langsOf.includes('hi'), `the Hindi document has a stray English passage (${langsOf})`);
      const lanes = [{ modality: 'text' }, { modality: 'titles' }];
      const seam = (strands) => seamsFor(tmp.db, { corpusId, strands }, lanes)[0]?.last_covered_year;
      assert.equal(seam([{ type: 'expression', langs: ['en', 'und', 'und-Latn'] }]), 1920);
      assert.equal(seam([{ type: 'expression', langs: ['hi', 'und'] }]), 2020);
      assert.equal(seam([{ type: 'theme', langs: null }]), 2020, 'no expression strand: the corpus-wide seam');
    } finally {
      tmp.cleanup();
    }
  });
});
