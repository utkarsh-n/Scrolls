// OWNER: WP4 — machine tone as a fallible annotation (SPEC §4.10, §2.E item 7, §4.11): the distribution and its
// document-block CI; the adapter protocol (a stand-in adapter for determinism, and the real Swift adapter built
// on this Mac when swiftc exists); the tone job end to end — machine_tone annotations with anchors, Compare's
// per-slice distributions, and every refusal in the §4.11 words (not installed, language, < 30 paragraphs).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { compareQuery } from '../server/analysis/compare.mjs';
import { TONE_ADAPTER_MISSING } from '../server/analysis/gates.mjs';
import { adapterStatus, probeAdapter, sentimentScores, startAdapter, TONE_LABEL, TONE_METHOD, toneDistribution } from '../server/analysis/tone.mjs';
import { paths } from '../server/config.mjs';
import { resolveAnchor } from '../server/provenance/anchors.mjs';
import { buildAnalysisCorpus, ERA_A, ERA_B, materializeForTest } from './analysis.fixture.mjs';
import { startServerInProcess } from './helpers/server.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'silent';

/**
 * A stand-in for bin/scrolls-nl that speaks the same JSONL protocol: score = (#"forms" − #"hold") / 4, clipped,
 * so tests know every score. `languages` is what its probe reports.
 */
function installFakeAdapter(bin, { languages = ['en'] } = {}) {
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'scrolls-nl');
  writeFileSync(file, `#!${process.execPath}
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let r; try { r = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ error: 'bad json' }) + '\\n'); return; }
  const out = { id: r.id };
  if (r.op === 'probe') Object.assign(out, { ok: true, adapter: 'fake', version: 'test', macos: 'test build', languages: { sentiment: ${JSON.stringify(languages)}, word_embedding: [] } });
  else if (r.op === 'sentiment') {
    if (!${JSON.stringify(languages)}.includes(r.lang)) out.error = 'not available';
    else { const t = String(r.text).toLowerCase(); const s = ((t.match(/forms/g) || []).length - (t.match(/hold/g) || []).length) / 4; out.score = Math.max(-1, Math.min(1, s)); }
  } else out.error = 'unknown op';
  process.stdout.write(JSON.stringify(out) + '\\n');
});
`);
  chmodSync(file, 0o755);
  return file;
}

describe('the tone distribution', () => {
  test('mean, SD, median, a 10-bin histogram over [−1, 1] and a bootstrap CI of the mean (by document when given)', () => {
    const scores = [-1, -0.5, 0, 0, 0.5, 1, 1, 0.25];
    const d = toneDistribution(scores);
    assert.equal(d.n, 8);
    assert.ok(Math.abs(d.mean - 0.15625) < 1e-12);
    assert.equal(d.histogram.reduce((s, b) => s + b.n, 0), 8);
    assert.equal(d.histogram[0].n, 1, '−1 falls in the first bin');
    assert.equal(d.histogram[9].n, 2, '1 falls in the last bin');
    assert.ok(d.ci[0] <= d.mean && d.mean <= d.ci[1]);
    // the same scores clustered in two documents give a wider interval than independent paragraphs
    const many = Array.from({ length: 200 }, (_, i) => (i < 100 ? 0.8 : -0.8));
    const iid = toneDistribution(many), byDoc = toneDistribution(many, { docs: many.map((_, i) => (i < 100 ? 1 : 2)) });
    assert.ok(byDoc.ci[1] - byDoc.ci[0] > iid.ci[1] - iid.ci[0]);
    assert.equal(byDoc.docs, 2);
    assert.equal(toneDistribution([]).mean, null);
  });
});

describe('the adapter protocol', () => {
  let tmp;
  before(() => { tmp = makeTmpData({ seed: false }); });
  after(() => tmp.cleanup());

  test('not installed → the §4.11 words; installed → probe (cached next to it) and sentiment scores by id', async () => {
    assert.equal(adapterStatus().installed, false);
    assert.throws(() => startAdapter(), (e) => e.code === 'E_NL_ADAPTER_MISSING' && e.message === TONE_ADAPTER_MISSING);
    installFakeAdapter(paths().bin);
    const a = startAdapter();
    try {
      const probe = await probeAdapter(a);
      assert.equal(probe.ok, true);
      assert.deepEqual(adapterStatus().sentimentLanguages, ['en']);
      const s = await sentimentScores(a, ['forms forms', 'hold', 'nothing'], { lang: 'en' });
      assert.deepEqual(s, [0.5, -0.25, 0]);
      assert.deepEqual(await sentimentScores(a, ['forms'], { lang: 'gu' }), [null], 'a declined language scores nothing');
    } finally { a.close(); }
  });
});

const swiftc = (() => { try { execFileSync('swiftc', ['--version'], { stdio: 'ignore' }); return process.platform === 'darwin'; } catch { return false; } })();

describe('the real on-device adapter (tools/nl-adapter, macOS)', { skip: swiftc ? false : 'swiftc is not available: the optional Swift adapter cannot be built here' }, () => {
  let tmp;
  before(() => { tmp = makeTmpData({ seed: false }); });
  after(() => tmp.cleanup());

  test('build.sh compiles it into $SCROLLS_DATA/bin; probe, sentiment and neighbours answer over JSONL', { timeout: 300000 }, async () => {
    const build = fileURLToPath(new URL('../tools/nl-adapter/build.sh', import.meta.url));
    execFileSync('sh', [build], { env: { ...process.env, SCROLLS_DATA: tmp.dir }, stdio: 'pipe' });
    assert.ok(existsSync(path.join(paths().bin, 'scrolls-nl')));
    const status = adapterStatus();
    assert.ok(status.installed && status.sentimentLanguages.includes('en'), JSON.stringify(status.probe));
    const a = startAdapter({ timeoutMs: 60000 });
    try {
      const probe = await probeAdapter(a);
      assert.equal(probe.adapter, 'scrolls-nl');
      assert.match(probe.macos, /Version/);
      const [pos, neg] = await sentimentScores(a, ['What a wonderful, joyful and happy day.', 'This is a terrible, awful and hateful disaster.'], { lang: 'en' });
      assert.ok(pos > neg, `positive ${pos} > negative ${neg}`);
      assert.ok(pos >= -1 && pos <= 1 && neg >= -1 && neg <= 1);
      const nb = await a.request({ op: 'neighbors', lang: 'en', word: 'virus', k: 5 });
      assert.equal(nb.neighbors.length, 5);
      assert.ok(nb.neighbors.every((x) => typeof x.word === 'string' && typeof x.distance === 'number'));
      const bad = await a.request({ op: 'nope' });
      assert.match(bad.error, /unknown op/);
    } finally { a.close(); }
  });
});

describe('the tone job and Compare (stand-in adapter)', () => {
  let tmp, srv, ledger, tally;
  const slices = { a: { years: ERA_A }, b: { years: ERA_B } };
  before(async () => {
    tmp = makeTmpData({ seed: false });
    buildAnalysisCorpus(tmp.db);
    ledger = materializeForTest(tmp.db, { surface: 'ledger' });
    tally = materializeForTest(tmp.db, { surface: 'tally' });
    tmp.db.close();
    srv = await startServerInProcess({ dataDir: tmp.dir });
  });
  after(async () => {
    await srv?.cleanup();
    tmp?.cleanup();
  });
  const waitJob = async (id) => {
    for (let i = 0; i < 1200; i++) {
      const r = await srv.request('GET', `/api/jobs/${id}`);
      if (['succeeded', 'failed', 'cancelled'].includes(r.json.status)) return r.json;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error('job did not finish');
  };
  const tone = async (expr) => (await srv.request('POST', '/api/compare', { body: { expr: [expr], ...slices }, headers: { 'X-Scrolls-Session': 'tone' } })).json.tone;

  test('without the adapter: not run, in the §4.11 words; a tone job fails with the same message and writes nothing', async () => {
    const t = await tone(ledger.exprId);
    assert.equal(t.gate, 'not_run');
    assert.equal(t.reason, TONE_ADAPTER_MISSING);
    assert.equal(t.value, null);
    const job = await waitJob((await srv.request('POST', '/api/analysis/runs', { body: { stage: 'tone', params: { expr: [ledger.exprId], ...slices } } })).json.job.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.message, TONE_ADAPTER_MISSING);
    assert.equal(srv.app.ctx.db.prepare("SELECT count(*) AS n FROM annotation WHERE kind = 'machine_tone'").get().n, 0);
  });

  test('a language the adapter does not support is refused by name', async () => {
    installFakeAdapter(paths().bin, { languages: ['it'] });
    const a = startAdapter();
    try { await probeAdapter(a); } finally { a.close(); }
    const t = await tone(ledger.exprId);
    assert.equal(t.gate, 'not_run');
    assert.equal(t.reason, 'Tone is not available for English');
    const job = await waitJob((await srv.request('POST', '/api/analysis/runs', { body: { stage: 'tone', params: { expr: [ledger.exprId], ...slices } } })).json.job.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.message, 'Tone is not available for English');
  });

  test('with the adapter: machine_tone annotations anchored to their passages; Compare shows distributions, never a numeral when gated', async () => {
    installFakeAdapter(paths().bin, { languages: ['en'] });
    const a = startAdapter();
    try { await probeAdapter(a); } finally { a.close(); } // what build.sh does after a build
    const pending = await tone(ledger.exprId);
    assert.equal(pending.gate, 'not_run');
    assert.equal(pending.suggestion.run.stage, 'tone');
    const job = await waitJob((await srv.request('POST', '/api/analysis/runs', { body: { stage: 'tone', params: pending.suggestion.run.params } })).json.job.id);
    assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
    assert.ok(job.result.paragraphs.scored >= 60);
    const db = srv.app.ctx.db;
    const rows = db.prepare(`SELECT a.*, r.dimensions_json, r.body_md FROM annotation a JOIN annotation_revision r ON r.annotation_id = a.id
      WHERE a.kind = 'machine_tone'`).all();
    assert.equal(rows.length, job.result.paragraphs.scored);
    for (const r of rows.slice(0, 20)) {
      assert.equal(r.is_machine, 1);
      assert.equal(r.method, TONE_METHOD);
      assert.equal(r.run_id, job.result.run_id);
      assert.equal(r.target_type, 'passage');
      const anchor = JSON.parse(r.anchor_json);
      const p = db.prepare('SELECT * FROM passage WHERE id = ?').get(Number(r.target_ref));
      const original = db.prepare('SELECT original FROM document_text WHERE document_id = ?').get(p.document_id).original;
      assert.equal(anchor.quote, original.slice(p.start_off, p.end_off));
      assert.equal(resolveAnchor(original, anchor).method, 'exact');
      assert.ok(r.body_md.includes(TONE_LABEL));
    }
    const run = db.prepare('SELECT model_version, model FROM analysis_run WHERE id = ?').get(job.result.run_id);
    assert.equal(run.model_version, 'test build');
    const t = await tone(ledger.exprId);
    assert.equal(t.gate, 'ok', JSON.stringify(t));
    assert.equal(t.label, TONE_LABEL);
    // era A passages say "forms" (score > 0), era B passages say "hold" (score < 0): the fake adapter's rule
    assert.ok(t.a.mean > 0 && t.b.mean < 0, `A ${t.a.mean}, B ${t.b.mean}`);
    assert.ok(t.a.ci[0] <= t.a.mean && t.a.mean <= t.a.ci[1]);
    assert.ok(t.a.n >= 30 && t.b.n >= 30);
    // 'tally' has 7 / 15 occurrences: fewer than 30 paragraphs per slice → gated, no numeral
    const tj = await waitJob((await srv.request('POST', '/api/analysis/runs', { body: { stage: 'tone', params: { expr: [tally.exprId], ...slices } } })).json.job.id);
    assert.equal(tj.status, 'succeeded');
    const tt = await tone(tally.exprId);
    assert.equal(tt.gate, 'insufficient_occurrences');
    assert.equal(tt.value, null);
    assert.equal(tt.a, undefined);
    assert.deepEqual(tt.needed, { paragraphs_per_slice: 30 });
    // an identical request reuses the run
    const again = await waitJob((await srv.request('POST', '/api/analysis/runs', { body: { stage: 'tone', params: pending.suggestion.run.params } })).json.job.id);
    assert.equal(again.result.reused, true);
  });

  test('compareQuery in a read connection reads the same stored run', () => {
    const p = compareQuery(srv.app.ctx.db, { expr: [ledger.exprId], ...slices });
    assert.equal(p.tone.gate, 'ok');
    assert.equal(p.tone.method, TONE_METHOD);
  });
});
