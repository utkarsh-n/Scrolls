// OWNER: WP8 — M2–M5 integration-gate regressions (SPEC §12.5/§12.6): cross-package fixes made at the gate, each
// pinned by a test here. Uses temp data dirs only (no Cipher or STEMM files).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { check, CONTRACT_VERSION } from '../src/shared/contracts.mjs';
import { createJobQueue } from '../server/jobs/queue.mjs';
import { nowIso, tx } from '../server/db/open.mjs';
import { claimNote } from '../server/adapters/stemm/wiktionary.mjs';
import { trackExpression } from '../server/aggregate/materialize.mjs';
import { claimPrims } from '../src/ui/timeline/deeptime.mjs';
import { createBatch, createDocumentWriter } from '../server/store/document-writer.mjs';
import { migrate, repairData } from '../server/db/migrate.mjs';
import { loadStateText, progressText } from '../src/ui/panels/adapters.mjs';
import { requeueStubbedJobs } from '../server/http/app.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';
import { startServerInProcess } from './helpers/server.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'silent';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('a writer that ignores cancellation is terminated without leaving the write lock held (WP2 need, queue.mjs)', () => {
  let tmp, queue, bus;
  const events = { job: [], adapter: [], bootstrap: [] };
  before(() => {
    tmp = makeTmpData({ seed: false });
    bus = new EventEmitter();
    for (const ch of Object.keys(events)) bus.on(ch, (e) => events[ch].push(e));
    queue = createJobQueue(tmp.db, { bus, dbPath: tmp.dbPath ?? `${tmp.dir}/scrolls.db`, cancelGraceMs: 400 });
  });
  after(async () => {
    await queue.close?.();
    tmp.cleanup();
  });

  test('the job stays cancelling until its thread exits, its open batch is rolled back, the next writer and interactive writes work', async () => {
    // a write job holding BEGIN IMMEDIATE and burning CPU for 60 s without one checkpoint
    const stuck = queue.enqueue('_noop', { ms: 60000, step: 60000, busy: true, lock: true }, { writes: true });
    // a batch the job had flushed before it stopped answering (what DocumentWriter leaves 'committing'); written
    // synchronously, before the job's thread starts and takes the lock
    const batch = Number(tmp.db.prepare(`INSERT INTO import_batch (collection_id, adapter_id, adapter_version, format, status, job_id, created_at)
      VALUES (NULL, 'file.csv', '1.0.0', 'adapter', 'committing', ?, ?)`).run(stuck, nowIso()).lastInsertRowid);
    // the next writer is queued before the stuck one starts, so it waits for the writer slot, not for a job row
    const next = queue.enqueue('_noop', { ms: 50, step: 10 }, { writes: true });
    for (let i = 0; i < 250 && queue.get(stuck).status !== 'running'; i++) await sleep(20);
    assert.equal(queue.get(stuck).status, 'running');
    await sleep(300); // inside its transaction now
    const cancelledAt = performance.now();
    assert.equal(queue.cancel(stuck), 'cancelling');
    // during the grace period (400 ms) the next writer must not start: the stuck one still holds the lock. Judged
    // only when this event loop really woke inside the grace period (a starved machine can sleep for seconds); the
    // order of the two jobs' timestamps below checks the same rule without timing.
    await sleep(200);
    if (performance.now() - cancelledAt < 350) {
      assert.equal(queue.get(next).status, 'queued', 'one writer at a time while the stuck job holds the lock');
    }
    let final;
    for (let i = 0; i < 300; i++) {
      final = queue.get(stuck);
      if (final.status !== 'cancelling' && final.status !== 'running') break;
      await sleep(20);
    }
    assert.equal(final.status, 'cancelled');
    assert.equal(tmp.db.prepare('SELECT status FROM import_batch WHERE id = ?').get(batch).status, 'cancelled', 'its open batch was rolled back');
    // an interactive write on the main connection succeeds at once (the terminated thread released the lock)
    const t0 = performance.now();
    tx(tmp.db, () => tmp.db.prepare("INSERT INTO meta (key, value) VALUES ('m5-gate', '1') ON CONFLICT(key) DO UPDATE SET value = '2'").run());
    assert.ok(performance.now() - t0 < 1000, 'no busy wait on a lock left behind');
    for (let i = 0; i < 300 && queue.get(next).status !== 'succeeded'; i++) await sleep(20);
    assert.equal(queue.get(next).status, 'succeeded', 'the next writer ran after the stuck one exited');
    assert.ok(queue.get(next).started_at >= queue.get(stuck).finished_at,
      `one writer at a time: the next writer started ${queue.get(next).started_at}, the stuck one ended ${queue.get(stuck).finished_at}`);
  });

  test("the 'adapter' and 'bootstrap' channels carry only what tasks emit; job events stay on 'job'", () => {
    assert.ok(events.job.length > 0);
    assert.deepEqual(events.adapter, []);
    assert.deepEqual(events.bootstrap, []);
  });
});

describe('contract 1.2.0 on the real server: etymology, expression claims, adapters, claims endpoint', () => {
  let tmp, srv, exprId;
  before(async () => {
    tmp = makeTmpData({ seed: true });
    const db = tmp.db;
    // a roots.tsv family as bootstrap phase A writes it: la:virus with three listed PIE parents
    tx(db, () => {
      const e = db.prepare('INSERT INTO etymon (key, kind, lang, form, roman, gloss, parent_semantics) VALUES (?, ?, ?, ?, ?, ?, ?)');
      e.run('la:virus', 'etymon', 'la', 'virus', null, 'venom', 'listed_unresolved');
      for (const [k, g] of [['ine-pro:*weys-', 'to raise'], ['ine-pro:*dʰewb-', 'deep'], ['ine-pro:*dʰewbʰ-', 'to sink in']]) e.run(k, 'root', 'ine-pro', k.slice(8), null, g, 'none');
      const p = db.prepare('INSERT INTO etymon_parent (key, parent_key, ord) VALUES (?, ?, ?)');
      ['ine-pro:*weys-', 'ine-pro:*dʰewb-', 'ine-pro:*dʰewbʰ-'].forEach((k, i) => p.run('la:virus', k, i));
      db.prepare('INSERT INTO etymon_member (key, lang, word, norm, rank) VALUES (?, ?, ?, ?, ?)').run('la:virus', 'en', 'virus', 'virus', 1);
    });
    exprId = trackExpression(db, { surface: 'virus', lang: 'en', corpus: 'cipher' }).id;
    // a written Wiktionary claim (what POST /api/adapters/stemm.wiktionary/load writes), dimmed: it dates one sense
    const claim = { label: 'Wiktionary: first used 1972 (external claim)', display: 'dimmed', reasons: ['dates one sense or use, not the word'],
      key: 'k', kind: 'statement', relation: 'first_use', rule: 'r', precision: 'year', date_text: '1972', word: 'virus', lang: 'en',
      entry_id: 1, span: 'First use in the computer context 1972', span_start: 0, span_end: 38, span_in_excerpt: true, url: 'https://en.wiktionary.org/wiki/virus',
      license: 'CC BY-SA 4.0 / GFDL', attribution: 'Wiktionary contributors' };
    db.prepare(`INSERT INTO date_assertion (subject_type, subject_id, role, raw, lo_day, hi_day, lo_year, hi_year, precision, basis, approx, rule,
      asserted_by, is_chronology, note) VALUES ('expression', ?, 'first_attestation_claim', '1972', 731, 1095, 1972, 1972, 'year', 'stated', 0, 'r',
      'wiktionary', 0, ?)`).run(exprId, claimNote(claim, { document: null, passage: null }));
    tmp.db.close();
    srv = await startServerInProcess({ dataDir: tmp.dir });
  });
  after(async () => {
    await srv?.cleanup();
    tmp?.cleanup();
  });

  test('health reports contract 1.2.0 or a later additive minor', async () => {
    assert.equal((await srv.request('GET', '/api/health')).json.contract, CONTRACT_VERSION);
    // contract changes are additive minors (§12.3): 1.3.0 (Term trail, cluster lanes) keeps every 1.2.0 shape
    const [major, minor] = CONTRACT_VERSION.split('.').map(Number);
    assert.ok(major === 1 && minor >= 2, CONTRACT_VERSION);
  });

  test('GET /api/etymology lists the family with its listed parents (periods, not dates; never competing hypotheses)', async () => {
    const r = await srv.request('GET', `/api/etymology?expr=${exprId}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(check('Etymology', r.json), []);
    assert.equal(r.json.available, true);
    const f = r.json.families.find((x) => x.key === 'la:virus');
    assert.ok(f);
    assert.equal(f.parent_semantics, 'listed_unresolved');
    assert.deepEqual(f.parents.map((p) => p.key), ['ine-pro:*weys-', 'ine-pro:*dʰewb-', 'ine-pro:*dʰewbʰ-']);
    assert.equal((await srv.request('GET', '/api/etymology?expr=abc')).status, 400);
    assert.equal((await srv.request('GET', '/api/etymology?expr=987654')).status, 404);
  });

  test('GET /api/expressions/:id carries the written claim as a dimmed marker; the Scroll draws it dimmed', async () => {
    const r = await srv.request('GET', `/api/expressions/${exprId}`);
    assert.equal(r.status, 200);
    assert.deepEqual(check('Expression', r.json), []);
    assert.equal(r.json.claims.length, 1);
    const c = r.json.claims[0];
    assert.equal(c.display, 'dimmed');
    assert.deepEqual(c.date, { lo_year: 1972, hi_year: 1972, label: '1972' });
    assert.match(c.label, /\(external claim\)$/);
    const prims = claimPrims(r.json.claims, { X: (d) => d / 365, slot: { y: 0, h: 24, mid: 12 } });
    assert.equal(prims.length, 1);
    assert.equal(prims[0].dim, true);
    assert.ok(prims[0].tip.some((t) => /^Dimmed: dates one sense/.test(t)));
    // fix pass (§13 rule 15): the attribution and licence travel with the claim and show on the marker
    assert.match(c.attribution, /Wiktionary contributors/);
    assert.match(c.license, /CC BY-SA/);
    assert.ok(prims[0].tip.some((t) => /Wiktionary contributors.*CC BY-SA/.test(t)));
  });

  test('GET /api/adapters and GET /api/adapters/:id/claims match their 1.2.0 shapes without staged sources', async () => {
    const a = await srv.request('GET', '/api/adapters');
    assert.equal(a.status, 200);
    assert.deepEqual(check('Adapters', a.json), []);
    const c = await srv.request('GET', `/api/adapters/stemm.wiktionary/claims?expr=${exprId}`);
    assert.equal(c.status, 200, c.text);
    assert.deepEqual(check('AdapterClaims', c.json), []);
    assert.equal(c.json.claims.length, 1, 'the written claim is read back without the word index');
    const none = await srv.request('GET', '/api/adapters/stemm.ngram/claims?word=virus');
    assert.equal(none.status, 404);
    assert.equal(none.json.error.code, 'E_NO_CLAIMS');
  });
});

describe('loading a source again writes no second copy of its links and annotations (demo "Load again", WP0 writer)', () => {
  let tmp;
  before(() => { tmp = makeTmpData({ seed: true }); });
  after(() => tmp.cleanup());

  const load = (db) => {
    const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: 'mini' }), collection: 'mini' });
    w.addRelationship({ src: { ext_id: 'mini:03' }, dst: { ext_id: 'mini:02' }, rel_type: 'explicit_citation', evidence_status: 'documented',
      origin: 'source_dataset', source_dataset: 'demo-records', source_locator: 'fixture:mini#3', created_by: 'adapter:test@1',
      hypothesis_group: { key: 'g1', question: 'Where does the bulletin line come from?' } });
    w.addRelationship({ src: { ext_id: 'mini:04' }, dst: { ext_id: 'mini:02' }, rel_type: 'proposed_allusion', evidence_status: 'proposed',
      origin: 'human', created_by: 'human:tester (synthetic)', hypothesis_group: { key: 'g2', question: 'Is the memo the source?' } });
    w.addAnnotation({ target: { type: 'document', ext_id: 'mini:02' }, kind: 'interpretation', author: 'human:Reader A (synthetic)',
      is_machine: false, body_md: 'A classroom rule quoted in an office.', layer: 'Reading A' });
    return w.finish();
  };

  test('the second load counts duplicates and writes no rows; a hypothesis group targets the item whose source is asked about', () => {
    const db = tmp.db;
    const first = load(db);
    assert.equal(first.relationships.documented, 1);
    assert.equal(first.annotations.created, 1);
    const n = () => [db.prepare('SELECT count(*) AS n FROM relationship').get().n, db.prepare('SELECT count(*) AS n FROM annotation').get().n];
    const before = n();
    const again = load(db);
    assert.deepEqual(n(), before, 'no second copy');
    assert.equal(again.relationships.duplicates, 2);
    assert.equal(again.annotations.duplicates, 1);
    const g = db.prepare("SELECT target_type, target_ref FROM hypothesis_group WHERE question = 'Is the memo the source?'").get();
    const mini04 = db.prepare("SELECT id FROM document WHERE ext_id = 'mini:04'").get().id;
    assert.deepEqual([g.target_type, g.target_ref], ['document', String(mini04)], 'the target is the src of the hypotheses');
  });

  test('boot repair re-targets a group written by the old writer (target = a hypothesis dst), once', () => {
    const db = tmp.db;
    const g = db.prepare("SELECT id FROM hypothesis_group WHERE question = 'Is the memo the source?'").get().id;
    const mini02 = db.prepare("SELECT id FROM document WHERE ext_id = 'mini:02'").get().id;
    db.prepare('UPDATE hypothesis_group SET target_ref = ? WHERE id = ?').run(String(mini02), g);
    assert.deepEqual(repairData(db), { hypothesis_targets: 1, variant_defaults: 0, stemm_translations: 0 });
    assert.equal(db.prepare('SELECT target_ref FROM hypothesis_group WHERE id = ?').get(g).target_ref,
      String(db.prepare("SELECT id FROM document WHERE ext_id = 'mini:04'").get().id));
    assert.deepEqual(repairData(db), { hypothesis_targets: 0, variant_defaults: 0, stemm_translations: 0 }, 'idempotent');
    assert.deepEqual(migrate(db), { from: 1, to: 1 }, 'an up-to-date database migrates to itself');
  });

  test('fix pass: boot repair switches off the -er forms an older tracking switched on by default, once', async () => {
    const db = tmp.db;
    const { trackExpression } = await import('../server/aggregate/materialize.mjs');
    const id = trackExpression(db, { surface: 'gene', lang: 'en', corpus: 'test' }).id;
    // an expression tracked before the fix: its generated 'gener' / 'geners' were on
    db.prepare("UPDATE expression_variant SET enabled = 1 WHERE expression_id = ? AND norm IN ('gener', 'geners')").run(id);
    assert.deepEqual(repairData(db), { hypothesis_targets: 0, variant_defaults: 2, stemm_translations: 0 });
    const on = db.prepare('SELECT norm FROM expression_variant WHERE expression_id = ? AND enabled = 1 ORDER BY norm').all(id).map((r) => r.norm);
    assert.ok(on.includes('genes') && !on.includes('gener') && !on.includes('geners'));
    assert.deepEqual(repairData(db), { hypothesis_targets: 0, variant_defaults: 0, stemm_translations: 0 }, 'idempotent');
  });
});

// OpenAlex lanes without cross-cell rates (D14) are pinned in aggregate.binning (oracleCellSampledLanes, the gen-closed lane).

describe('Adapters page words for chained loads (WP2 need)', () => {
  test('a cancelled chained load says what was kept; the last load shows its coverage line', () => {
    assert.match(progressText({ status: 'cancelled' }, { chained: true }), /chunk in progress was rolled back; documents already loaded are kept/);
    assert.equal(progressText({ status: 'cancelled' }), 'cancelled — nothing half-loaded is kept');
    assert.equal(loadStateText({ status: 'done', message: 'Gutenberg STEMM shelf: loaded', coverage: { 'stemm-gutenberg':
      { dated_by_evidence: 416, lifetime_estimate: 221, undated: 47, after_1928: 35 } } }),
    'Last load: loaded · Gutenberg STEMM shelf: loaded · stemm-gutenberg: dated by evidence 416 · lifetime estimate 221 · undated 47 · after 1928 35');
  });
});

describe('an M1 database: the demo jobs that failed as WP0 stubs run once after the upgrade', () => {
  test('failed NOT_IMPLEMENTED cluster jobs are queued again once, followed by the demo deferred step', () => {
    const tmp = makeTmpData({ seed: false });
    try {
      const ins = tmp.db.prepare(`INSERT INTO job (type, params_json, writes, priority, status, created_at, error_json)
        VALUES (?, ?, 1, 3, 'failed', ?, ?)`);
      const err = JSON.stringify({ code: 'NOT_IMPLEMENTED', message: 'stub', hint: null });
      ins.run('cluster', JSON.stringify({ expressionId: 1, expr: 1 }), nowIso(), err);
      ins.run('cluster', JSON.stringify({ expressionId: 2, expr: 2 }), nowIso(), err);
      ins.run('materialize', JSON.stringify({ expressionId: 1 }), nowIso(), JSON.stringify({ code: 'E_OTHER', message: 'x', hint: null }));
      const queued = [];
      const jobs = { hasTask: () => true, enqueue: (type, params, opts) => { queued.push([type, params, opts?.priority ?? null]);
        return Number(tmp.db.prepare(`INSERT INTO job (type, params_json, writes, priority, status, created_at) VALUES (?, ?, 1, 3, 'queued', ?)`)
          .run(type, JSON.stringify(params), nowIso()).lastInsertRowid); } };
      assert.equal(requeueStubbedJobs(tmp.db, jobs), 2);
      assert.deepEqual(queued.map((q) => q[0]), ['cluster', 'cluster', 'adapter-load']);
      assert.deepEqual(queued[2][1], { adapter: 'demo', apply: 'deferred' });
      assert.equal(requeueStubbedJobs(tmp.db, jobs), 0, 'once: a later job with the same params exists');
    } finally { tmp.cleanup(); }
  });
});
