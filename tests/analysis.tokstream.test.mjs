// OWNER: WP4 — token streams (SPEC §4.7) and the jobs behind collocations: stream content equals the tokenizer
// over every quality='ok' passage, ids are frequency ranks, freshness follows the data version, a cancelled
// build leaves nothing behind; collocates from streams equal collocates from on-the-fly tokenization; the
// tokstream and collocations jobs run through /api/analysis/runs, store their runs and are reused.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { tokenize } from '../src/shared/tokenize.mjs';
import { sliceContexts } from '../server/analysis/collocations.mjs';
import { loadScope, modalityEvidence, passageTextReader, resolveExpressions, sliceStats } from '../server/analysis/slices.mjs';
import { buildTokenStreams, openTokenStream, readManifest, streamFiles, streamStatus } from '../server/analysis/tokstream.mjs';
import { paths } from '../server/config.mjs';
import { CancelledError } from '../server/jobs/context.mjs';
import { createBatch, createDocumentWriter } from '../server/store/document-writer.mjs';
import { buildAnalysisCorpus, ERA_B, materializeForTest } from './analysis.fixture.mjs';
import { startServerInProcess } from './helpers/server.mjs';
import { assertShape } from './helpers/shape.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'silent';

describe('buildTokenStreams / openTokenStream', () => {
  let tmp, dir, result;
  before(() => {
    tmp = makeTmpData({ seed: false });
    buildAnalysisCorpus(tmp.db);
    dir = paths().tokens;
    result = buildTokenStreams(tmp.db, { langs: ['en'], dir });
  });
  after(() => tmp.cleanup());

  test('the en stream holds exactly the tokens of every quality=ok en passage, in passage order', () => {
    const s = openTokenStream('en', { dir });
    const read = passageTextReader(tmp.db);
    const passages = tmp.db.prepare(`SELECT p.id, p.document_id, p.field, p.start_off, p.end_off FROM passage p
      WHERE p.quality = 'ok' AND p.lang = 'en' ORDER BY p.id`).all();
    assert.equal(s.pidx.passages.length, passages.length);
    let total = 0;
    for (const p of passages) {
      const [a, b] = s.range(p.id);
      const want = tokenize(read(p)).tokens;
      assert.deepEqual(Array.from(s.ids.subarray(a, b), (id) => s.vocab[id]), want, `passage ${p.id}`);
      total += want.length;
    }
    assert.equal(s.tokens, total);
    const docTokens = tmp.db.prepare("SELECT SUM(tokens) AS n FROM doc_tokens WHERE plang = 'en'").get().n;
    assert.equal(s.tokens, docTokens, 'equals the denominators of doc_tokens');
    assert.equal(result.langs[0].tokens, total);
    assert.equal(s.range(999999), null);
  });

  test('ids are frequency ranks and the vocabulary counts add up', () => {
    const s = openTokenStream('en', { dir });
    for (let i = 1; i < s.counts.length; i++) assert.ok(s.counts[i - 1] >= s.counts[i], `rank ${i}`);
    assert.equal(s.counts.reduce((x, y) => x + y, 0), s.tokens);
    const freq = new Uint32Array(s.vocab.length);
    for (const id of s.ids) freq[id]++;
    assert.deepEqual(Array.from(freq), Array.from(s.counts));
    assert.equal(s.vocab[s.idOf('ledger')], 'ledger');
  });

  test('ids stay on disk when asked (read workers): readIds equals the loaded array', () => {
    const full = openTokenStream('en', { dir });
    const lazy = openTokenStream('en', { dir, ids: false });
    assert.equal(lazy.ids, null);
    assert.deepEqual(Array.from(lazy.readIds(100, 400)), Array.from(full.ids.subarray(100, 400)));
    // the file stays open across reads until close(); a read after close() opens it again
    assert.deepEqual(Array.from(lazy.readIds(0, 50)), Array.from(full.ids.subarray(0, 50)));
    lazy.close();
    lazy.close();
    assert.deepEqual(Array.from(lazy.readIds(400, 420)), Array.from(full.ids.subarray(400, 420)));
    lazy.close();
    assert.equal(lazy.readIds(5, 5).length, 0);
  });

  test('a stream is fresh until the data version moves', () => {
    assert.equal(streamStatus(tmp.db, dir, 'en').fresh, true);
    assert.equal(streamStatus(tmp.db, dir, 'fr').exists, false);
    const coll = tmp.db.prepare("SELECT id, slug FROM collection WHERE slug = 'ana-text'").get();
    const w = createDocumentWriter(tmp.db, { batchId: createBatch(tmp.db, { collection: coll.id }), collection: coll.slug, corpus: 'test' });
    w.addDocument({ ext_id: 'ana:late', kind: 'memo', author: 'Late (synthetic)', text: { original: 'A late ledger entry was added today.', decoder: 'utf-8' },
      dates: [{ role: 'publication', raw: '2010', asserted_by: 'test', is_chronology: true }], original_meta: { fixture: 'analysis' } });
    w.finish();
    const st = streamStatus(tmp.db, dir, 'en');
    assert.equal(st.fresh, false);
    assert.ok(st.data_version > st.manifest.data_version);
  });

  test('a cancelled rebuild leaves the existing stream untouched and no temporary files', () => {
    const before = readdirSync(dir).sort();
    const manifest = readFileSync(streamFiles(dir, 'en').manifest, 'utf8');
    const ids = readFileSync(streamFiles(dir, 'en').ids);
    for (const at of [1, 2]) { // before reading, and while renumbering the ids (after the provisional file exists)
      let calls = 0;
      const ctx = { checkpoint() { if (++calls >= at) throw new CancelledError(); }, progress() {} };
      assert.throws(() => buildTokenStreams(tmp.db, { langs: ['en'], dir }, ctx), CancelledError);
      assert.equal(calls, at);
    }
    assert.deepEqual(readdirSync(dir).sort(), before);
    assert.equal(readFileSync(streamFiles(dir, 'en').manifest, 'utf8'), manifest);
    assert.deepEqual(readFileSync(streamFiles(dir, 'en').ids), ids);
    assert.equal(tmp.db.isTransaction, false, 'the read snapshot is released');
  });
});

describe('collocates: token streams and on-the-fly tokenization agree', () => {
  let tmp;
  before(() => {
    tmp = makeTmpData({ seed: false });
    buildAnalysisCorpus(tmp.db);
  });
  after(() => tmp.cleanup());

  test('same counts, windows and slice frequencies from either source', () => {
    const ledger = materializeForTest(tmp.db, { surface: 'ledger' });
    const exprs = resolveExpressions(tmp.db, [ledger.exprId]);
    const scope = loadScope(tmp.db, { exprs, slices: [{ years: ERA_B, f: '' }], toggles: { tr: 0, ds: 0, ap: 0, dup: 0, nm: 0, est: 1, bp: 0 } });
    const spec = scope.specs[0];
    const stats = sliceStats(scope, spec, 'text');
    assert.ok(modalityEvidence(scope, spec).text.n > 0);
    const tokenized = sliceContexts(tmp.db, scope, spec, stats);
    assert.equal(tokenized.source, 'tokenized');
    buildTokenStreams(tmp.db, { dir: paths().tokens });
    const streamed = sliceContexts(tmp.db, scope, spec, stats);
    assert.equal(streamed.source, 'stream');
    for (const k of ['fx', 'W', 'N']) assert.equal(streamed[k], tokenized[k], k);
    assert.equal(streamed.fx, stats.n, 'the name-guard hit is excluded from the windows as from the count');
    assert.deepEqual(new Map([...streamed.fxy].sort()), new Map([...tokenized.fxy].sort()));
    assert.deepEqual(new Map([...streamed.fy].sort()), new Map([...tokenized.fy].sort()));
    assert.ok(Math.abs(streamed.sumFyAlpha - tokenized.sumFyAlpha) < 1e-6);
    assert.equal(streamed.N, stats.units, 'slice tokens equal the slice denominator');
  });

  test('a slice too large to tokenize without streams says what it needs instead of guessing', () => {
    const ledger = resolveExpressions(tmp.db, [1]);
    const scope = loadScope(tmp.db, { exprs: ledger, slices: [{ years: ERA_B, f: '' }], toggles: { tr: 0, ds: 0, ap: 0, dup: 0, nm: 0, est: 1, bp: 0 } });
    const stats = sliceStats(scope, scope.specs[0], 'text');
    const out = sliceContexts(tmp.db, scope, scope.specs[0], stats, { dir: path.join(tmp.dir, 'nowhere'), tokenLimit: 10 });
    assert.deepEqual(out.unavailable.langs, ['en']);
    assert.equal(out.unavailable.status.en, 'not built');
  });
});

describe('tokstream and collocations jobs through /api/analysis/runs', () => {
  let tmp, srv, ledger;
  before(async () => {
    tmp = makeTmpData({ seed: false });
    buildAnalysisCorpus(tmp.db);
    ledger = materializeForTest(tmp.db, { surface: 'ledger' });
    tmp.db.close();
    srv = await startServerInProcess({ dataDir: tmp.dir });
  });
  after(async () => {
    await srv?.cleanup();
    tmp.cleanup();
  });

  async function waitJob(id, timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = await srv.request('GET', `/api/jobs/${id}`);
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(r.json.status)) return r.json;
      if (Date.now() > end) throw new Error(`job ${id} still ${r.json.status}`);
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  test('tokstream: a job writes the streams under a succeeded run; an identical request reuses it', async () => {
    const r = await srv.request('POST', '/api/analysis/runs', { body: { stage: 'tokstream', params: { langs: ['en'] } } });
    assert.equal(r.status, 200, r.text);
    assertShape('AnalysisRunStarted', r.json);
    const job = await waitJob(r.json.job.id);
    assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
    const manifest = readManifest(path.join(tmp.dir, 'derived', 'tokens'), 'en');
    assert.equal(manifest.run_id, job.result.run_id);
    const runs = await srv.request('GET', '/api/analysis/runs?stage=tokstream');
    assert.equal(runs.json.items[0].status, 'succeeded');
    const again = await srv.request('POST', '/api/analysis/runs', { body: { stage: 'tokstream', params: { langs: ['en'] } } });
    assert.deepEqual(again.json, { job: { id: r.json.job.id }, run: job.result.run_id, reused: true });
    const coll = await srv.request('GET', `/api/collocations?expr=${ledger.exprId}&slice=1990-2020`);
    assert.equal(coll.json.source, 'stream');
  });

  test('collocations: the job stores the table; the endpoint then serves the stored run; a second request reuses it', async () => {
    const live = await srv.request('GET', `/api/collocations?expr=${ledger.exprId}&slice=1990-2020`);
    const r = await srv.request('POST', '/api/analysis/runs', { body: { stage: 'collocations', expr: ledger.exprId, params: { years: [1990, 2020] } } });
    assert.equal(r.status, 200, r.text);
    const job = await waitJob(r.json.job.id);
    assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
    const stored = await srv.request('GET', `/api/collocations?expr=${ledger.exprId}&slice=1990-2020`);
    assertShape('Collocations', stored.json);
    assert.equal(stored.json.source, 'stored');
    assert.equal(stored.json.run, job.result.run_id);
    assert.deepEqual(stored.json.collocates.map((c) => [c.term, c.f_xy, c.logDice]), live.json.collocates.map((c) => [c.term, c.f_xy, c.logDice]));
    const again = await srv.request('POST', '/api/analysis/runs', { body: { stage: 'collocations', expr: ledger.exprId, params: { years: [1990, 2020] } } });
    assert.equal(again.json.reused, true);
    assert.equal(again.json.run, job.result.run_id);
  });
});
