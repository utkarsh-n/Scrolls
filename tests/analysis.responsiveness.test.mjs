// OWNER: WP4 — expensive analysis does not freeze the server (SPEC §4.12, §11 row 10, D11): Compare runs in
// the read-pool workers, so while several heavy comparisons run, /api/health stays fast and the main
// event loop never stalls; a vectors job on a generated 3M-token fixture runs in a job worker (its counting
// and sparse products in further workers), leaves health and the event loop alone, and cancels within
// 500 ms with nothing of its run left visible. (The clustering job's half of §11 row 10 belongs to the
// clustering tests.)

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readdirSync } from 'node:fs';
import { buildAnalysisCorpus, ERA_A, ERA_B, materializeForTest } from './analysis.fixture.mjs';
import { buildSpaceCorpus } from './analysis.vectors.fixture.test.mjs';
import { paths } from '../server/config.mjs';
import { startServerInProcess } from './helpers/server.mjs';
import { budgetOver, idleAround, probeLatency } from './helpers/latency.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'silent';

const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(0.95 * xs.length))];

describe('Compare runs off the main thread', () => {
  let tmp, srv, ledger, tokens;
  before(async () => {
    tmp = makeTmpData({ seed: false });
    const built = buildAnalysisCorpus(tmp.db, { perEra: 400, paragraphs: 8 });
    tokens = built.counts.text.tokens;
    ledger = materializeForTest(tmp.db, { surface: 'ledger' });
    tmp.db.close();
    srv = await startServerInProcess({ dataDir: tmp.dir });
  });
  after(async () => {
    await srv?.cleanup();
    tmp.cleanup();
  });

  test('during 6 concurrent comparisons: health p95 < 50 ms, event-loop delay p99 < 50 ms, the work is in the read pool', async () => {
    assert.ok(tokens > 300000, `a corpus large enough to make Compare work (${tokens} tokens)`);
    const idleBefore = await probeLatency(srv); // the same probe with nothing running (helpers/latency.mjs, M5 gate)
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();
    let maxBusy = 0, inFlight = true;
    const sampler = (async () => {
      while (inFlight) {
        maxBusy = Math.max(maxBusy, srv.app.ctx.pool.stats().busy);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const t0 = performance.now();
    const compares = Array.from({ length: 6 }, (_, i) => srv.request('POST', '/api/compare', {
      body: { expr: [ledger.exprId], a: { years: [ERA_A[0], ERA_A[1] - i] }, b: { years: ERA_B }, seed: i },
      headers: { 'X-Scrolls-Session': 'resp' }, timeoutMs: 30000,
    }).then((r) => ({ r, ms: performance.now() - t0 })));
    const health = [];
    for (let i = 0; i < 50; i++) {
      const s = performance.now();
      const r = await srv.request('GET', '/api/health');
      health.push(performance.now() - s);
      assert.equal(r.status, 200);
      await new Promise((res) => setTimeout(res, 5));
    }
    const done = await Promise.all(compares);
    inFlight = false;
    await sampler;
    loop.disable();
    for (const { r } of done) assert.equal(r.status, 200, r.text.slice(0, 300));
    const idle = idleAround(idleBefore, await probeLatency(srv)); // every comparison has finished: the machine alone again
    const slowest = Math.max(...done.map((d) => d.ms));
    const delayP99 = loop.percentile(99) / 1e6;
    assert.ok(maxBusy >= 1, 'the comparisons ran in read-pool workers');
    assert.ok(p95(health) < budgetOver(50, idle.healthP95), `health p95 ${p95(health).toFixed(1)} ms (idle ${idle.healthP95.toFixed(1)} ms; slowest compare finished after ${slowest.toFixed(0)} ms)`);
    assert.ok(delayP99 < budgetOver(50, idle.loopP99), `event-loop delay p99 ${delayP99.toFixed(1)} ms (idle ${idle.loopP99.toFixed(1)} ms)`);
  });
});

describe('a vectors job does not freeze the server and cancels cleanly', () => {
  let tmp, srv;
  before(async () => {
    tmp = makeTmpData({ seed: false });
    buildSpaceCorpus(tmp.db, { tokensDir: paths().tokens, eras: [[1880, 1899]], docsPerEra: 30, tokensPerDoc: 100_000 });
    tmp.db.close();
    srv = await startServerInProcess({ dataDir: tmp.dir });
  });
  after(async () => {
    await srv?.cleanup();
    tmp?.cleanup();
  });

  test('during the job: health p95 < 50 ms and event-loop delay p99 < 50 ms; cancel acknowledged ≤ 500 ms; no rows of the run visible', { timeout: 600000 }, async () => {
    const idleBefore = await probeLatency(srv); // the same probe with no job running (helpers/latency.mjs, M5 gate)
    const started = await srv.request('POST', '/api/analysis/runs', { body: { stage: 'vectors', params: { lang: 'en', corpora: ['test'], scope: 'pooled', threads: 2 } } });
    assert.equal(started.status, 200, started.text);
    const id = started.json.job.id;
    // wait until the job is counting (worker threads busy), then measure
    for (let i = 0; i < 3000; i++) {
      const j = (await srv.request('GET', `/api/jobs/${id}`)).json;
      if (j.status !== 'queued' && /counted|SVD|target words/.test(j.message ?? '')) break;
      assert.ok(!['failed', 'succeeded', 'cancelled'].includes(j.status), `job ended early: ${j.status} ${JSON.stringify(j.error)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();
    const health = [];
    for (let i = 0; i < 50; i++) {
      const s = performance.now();
      const r = await srv.request('GET', '/api/health');
      health.push(performance.now() - s);
      assert.equal(r.status, 200);
      await new Promise((res) => setTimeout(res, 5));
    }
    loop.disable();
    const mid = (await srv.request('GET', `/api/jobs/${id}`)).json;
    assert.equal(mid.status, 'running', 'still working while health was measured');
    const delay = loop.percentile(99) / 1e6;

    const t0 = performance.now();
    const c = await srv.request('POST', `/api/jobs/${id}/cancel`);
    assert.ok(['cancelling', 'cancelled'].includes(c.json.status));
    let final;
    for (;;) {
      final = (await srv.request('GET', `/api/jobs/${id}`)).json;
      if (['cancelled', 'failed', 'succeeded'].includes(final.status)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const ack = performance.now() - t0;
    assert.equal(final.status, 'cancelled');
    assert.ok(ack <= 500, `cancel acknowledged in ${ack.toFixed(0)} ms`);
    const db = srv.app.ctx.db;
    assert.equal(db.prepare("SELECT count(*) AS n FROM analysis_run WHERE stage = 'vectors' AND status = 'running'").get().n, 0);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM vector_space s JOIN analysis_run r ON r.id = s.run_id WHERE r.status <> 'succeeded'`).get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM vector_space').get().n, 0, 'no space row was written');
    assert.ok(!readdirSync(paths().spaces).some((f) => f.startsWith('tmp-')), 'no temporary space files');
    // the latencies measured while the job ran, against the machine's own before and after it (the job is cancelled now)
    const idle = idleAround(idleBefore, await probeLatency(srv));
    assert.ok(p95(health) < budgetOver(50, idle.healthP95), `health p95 ${p95(health).toFixed(1)} ms (idle ${idle.healthP95.toFixed(1)} ms)`);
    assert.ok(delay < budgetOver(50, idle.loopP99), `event-loop delay p99 ${delay.toFixed(1)} ms (idle ${idle.loopP99.toFixed(1)} ms)`);
  });
});
