// OWNER: WP3
// scripts/bench.mjs — `npm run bench`: measures the §4.12 budgets over HTTP against a running-in-process server.
//
//   node scripts/bench.mjs [--corpus cipher] [--expr zero,virus] [--rounds 20] [--cold-cache]   on $SCROLLS_DATA (default ~/Developer/scrolls-data)
//   node scripts/bench.mjs --synthetic                                                           on a throwaway generated corpus
//
// Budgets (M-class Mac): tile p95 warm ≤ 80 ms and cold ≤ 300 ms (L0–L3); marks ≤ 150 ms; search ≤ 120 ms;
// /api/health p95 < 50 ms while a CPU-bound job runs. Also reported (no budget in §4.12): the first timeline query of
// the run (it builds or loads the shared slice cube), later timeline queries, and arcs. `--cold-cache` deletes the
// shared artifacts in $SCROLLS_DATA/cache/ first, so the first query pays the one scan they replace. Prints a Markdown
// table and writes $SCROLLS_DATA/cache/bench-<timestamp>.json (Docs/VERIFICATION.md belongs to the integration package,
// which copies the table in). Not part of pass/fail. The automatic Cipher import is switched off while benchmarking.

import { mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: {
  corpus: { type: 'string' }, expr: { type: 'string' }, rounds: { type: 'string', default: '20' }, synthetic: { type: 'boolean', default: false },
  'cold-cache': { type: 'boolean', default: false },
  // contract 1.3.0 round: words to search cold before anything else, and words to track one by one (per-word materialize)
  search: { type: 'string' }, materialize: { type: 'string' }, trail: { type: 'boolean', default: false },
} });
const ROUNDS = Math.max(3, Number(opts.rounds) || 20);
process.env.SCROLLS_NO_AUTO_IMPORT = '1';
process.env.SCROLLS_NO_DEMO ??= '1';
process.env.SCROLLS_LOG_LEVEL ??= 'error';

let tmpDir = null;
if (opts.synthetic) {
  const { makeTmpData } = await import('../tests/helpers/tmpdata.mjs');
  const { buildGeneratedCorpus } = await import('../tests/aggregate.corpus.mjs');
  const t = makeTmpData({ seed: false });
  buildGeneratedCorpus(t.db, { texts: 2000, titles: 3000, abstracts: 300 });
  t.db.close();
  process.env.SCROLLS_DATA = t.dir;
  tmpDir = t.dir;
}

const { paths } = await import('../server/config.mjs');
const SHARED = /^(cube|ecube|cells|cstats|themes|makers|names|tags|translit)\d+-.*\.(bin|lock)$/;
let removed = 0;
if (opts['cold-cache']) {
  try {
    for (const f of readdirSync(paths().cache)) if (SHARED.test(f)) { unlinkSync(path.join(paths().cache, f)); removed++; }
  } catch { /* no cache directory yet */ }
}
const { startServer } = await import('../server/http/app.mjs');
const app = await startServer({ port: 0 });
const base = app.url;
const corpus = opts.corpus ?? (opts.synthetic ? 'test' : 'cipher');
const exprs = (opts.expr ?? 'zero,virus,carry the zero').split(',').map((x) => x.trim()).filter(Boolean);
const load0 = loadavg()[0];

async function call(method, p, body) {
  const t0 = performance.now();
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { ms: performance.now() - t0, status: res.status, json };
}
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * q) - 1))] : null; };
const fmt = (x) => (x === null ? '—' : `${x.toFixed(1)} ms`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, samples, budget = null) => results.push({ name, n: samples.length, p50: pct(samples, 0.5), p95: pct(samples, 0.95), budget,
  ok: budget === null ? null : pct(samples, 0.95) !== null && pct(samples, 0.95) <= budget });

const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const notes = [];

try {
  // the corpus list is the first thing the UI asks for: cold (first call after boot), then warm
  record('corpora, first call after boot', [(await call('GET', '/api/corpora')).ms]);
  const corporaWarm = [];
  for (let i = 0; i < 5; i++) corporaWarm.push((await call('GET', '/api/corpora')).ms);
  record('corpora, warm', corporaWarm);
  // search cold: the first search of each word after boot (tracked words read their run; untracked ones count on the fly)
  const searchCold = [];
  for (const surface of list(opts.search)) {
    const r = await call('GET', `/api/search?q=${encodeURIComponent(surface)}&corpus=${corpus}`);
    searchCold.push(r.ms);
    notes.push(`search '${surface}' (first call): ${r.ms.toFixed(0)} ms, ${r.status}, expression ${r.json?.expression ? 'tracked' : 'untracked'}`);
  }
  if (searchCold.length) record('search, first call per word', searchCold);
  // per-word materialization, one word at a time (POST → ready)
  const perWord = [];
  for (const surface of list(opts.materialize)) {
    const t1 = performance.now();
    const r = await call('POST', '/api/expressions', { surface, corpus });
    if (r.status !== 200) { notes.push(`materialize '${surface}': ${JSON.stringify(r.json?.error)}`); continue; }
    const id = r.json.expression.id;
    let st = r.json;
    while (st.state.status === 'materializing') { await sleep(100); st = (await call('GET', `/api/expressions/${id}`)).json; }
    const ms = performance.now() - t1;
    perWord.push(ms);
    notes.push(`materialize '${surface}': ${ms.toFixed(0)} ms → ${st.state.n} occurrences in ${st.state.docs} documents`);
  }
  if (perWord.length) {
    record('materialize, per word (POST → ready)', perWord);
    // a materialization bumps the data version: the next corpus list used to rescan every document
    record('corpora, first call after a data change', [(await call('GET', '/api/corpora')).ms]);
  }

  const ids = [];
  for (const surface of exprs) {
    const r = await call('POST', '/api/expressions', { surface, corpus });
    if (r.status !== 200) { process.stderr.write(`skip '${surface}': ${JSON.stringify(r.json?.error)}\n`); continue; }
    ids.push(r.json.expression.id);
  }
  const t0 = Date.now();
  for (const id of ids) {
    for (;;) {
      const r = await call('GET', `/api/expressions/${id}`);
      if (r.json.state.status !== 'materializing') break;
      if (Date.now() - t0 > 600000) throw new Error('materialization did not finish within 10 minutes');
      await sleep(250);
    }
  }
  const materializeMs = Date.now() - t0;
  const search = [], firstQuery = [], queries = [], tilesCold = [], tilesWarm = [], marks = [], arcs = [];
  for (let i = 0; i < ROUNDS; i++) for (const surface of exprs) search.push((await call('GET', `/api/search?q=${encodeURIComponent(surface)}&corpus=${corpus}`)).ms);
  record('search', search, 120);
  for (const id of ids) {
    for (const facet of ['domain', 'language', 'collection']) {
      const q = await call('POST', '/api/timeline/query', { corpus, strands: [{ type: 'expression', ref: id }], lanes: { facet } });
      (firstQuery.length ? queries : firstQuery).push(q.ms);
      if (q.status !== 200 || q.json.status !== 'ready') continue;
      const key = q.json.queryKey;
      for (const [tier, level] of [['L0', 0], ['L1', 1], ['L2', 2], ['L3', 3]]) {
        const w = [1000, 100, 10, 1][level];
        const t0b = Math.floor(Math.floor(1800 / w) / 64), t1b = Math.floor(Math.floor(2030 / w) / 64);
        const tiles = t1b - t0b >= 2 ? `${t0b}..${Math.min(t1b, t0b + 7)}` : `${t0b}..${t1b}`;
        tilesCold.push((await call('GET', `/api/timeline/tiles?q=${key}&tier=${tier}&tiles=${tiles}`)).ms);
        for (let r = 0; r < 3; r++) tilesWarm.push((await call('GET', `/api/timeline/tiles?q=${key}&tier=${tier}&tiles=${tiles}`)).ms);
      }
      for (let r = 0; r < 3; r++) marks.push((await call('GET', `/api/timeline/marks?q=${key}&from=1900&to=1999&limit=4000`)).ms);
      for (const tier of ['L0', 'L2']) arcs.push((await call('GET', `/api/timeline/arcs?q=${key}&from=1800&to=2030&tier=${tier}&limit=300`)).ms);
    }
  }
  record('timeline query, first of the run', firstQuery);
  record('timeline query, later', queries);
  record('tiles, cold (L0–L3)', tilesCold, 300);
  record('tiles, warm (L0–L3)', tilesWarm, 80);
  record('marks', marks, 150);
  record('arcs (L0, L2)', arcs);
  if (opts.trail) {
    // contract 1.3.0: the Term trail over the virtual corpus real (every member corpus), its tiles with OpenAlex cells
    const trail = [], trailTiles = [];
    for (const surface of exprs) {
      const t = await call('POST', '/api/expressions', { surface, corpus: 'real' });
      if (t.status !== 200) continue;
      const q = await call('POST', '/api/timeline/query', { corpus: 'real', strands: [{ type: 'expression', ref: t.json.expression.id }], lanes: { facet: 'trail' } });
      trail.push(q.ms);
      notes.push(`trail '${surface}' in real: ${q.ms.toFixed(0)} ms, ${q.status}, ${q.json?.lanes?.length ?? 0} lanes`);
      if (q.status === 200 && q.json.status === 'ready') {
        for (const tiles of ['2..3', '0']) trailTiles.push((await call('GET', `/api/timeline/tiles?q=${q.json.queryKey}&tier=${tiles === '0' ? 'L0' : 'L2'}&tiles=${tiles}`)).ms);
      }
    }
    record('trail query (real)', trail);
    record('trail tiles (L0, L2)', trailTiles);
  }
  const jobs = app.ctx.jobs;
  const job = jobs.enqueue('_noop', { ms: 20000, busy: true, step: 20 });
  for (let i = 0; i < 100 && jobs.get(job).status !== 'running'; i++) await sleep(20);
  const health = await Promise.all(Array.from({ length: 50 }, () => call('GET', '/api/health').then((r) => r.ms)));
  jobs.cancel(job);
  record('health during a CPU-bound job', health, 50);

  const lines = ['| measure | n | p50 | p95 | budget | within |', '|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.name} | ${r.n} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${r.budget === null ? '—' : `≤ ${r.budget} ms`} | ${r.ok === null ? '—' : r.ok ? 'yes' : 'NO'} |`),
    '', `Materialization of ${ids.length} expression(s): ${materializeMs} ms (job queue, until ready). Corpus '${corpus}'${opts.synthetic ? ' (generated, synthetic)' : ''}.`,
    ...notes.map((n) => `- ${n}`),
    `Shared artifacts: ${opts['cold-cache'] ? `cold (${removed} cache file(s) removed before boot)` : 'as found in the cache directory'}. Load average at start ${load0.toFixed(1)}, at end ${loadavg()[0].toFixed(1)}.`];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (!tmpDir) {
    const outDir = paths().cache;
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), corpus, materializeMs, coldCache: opts['cold-cache'], removed,
      loadavg: [load0, loadavg()[0]], results, notes }, null, 2));
    process.stdout.write(`written ${file}\n`);
  }
} finally {
  await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}
