// OWNER: WP3 — contract 1.3.0 (C2, item 6): Wiktionary claims attach to an expression tracked AFTER the Wiktionary load.
// POST /api/expressions looks the word up in the word index at track time (the same adapter-load job and display rule as a
// load), once per expression; the entry document it writes never makes another expression's count stale (lexical entries
// are outside every materialization's scope and input fingerprint).
//
// The staged Wiktionary source is read in place: a temp data dir gets FORMAT.md, MANIFEST.json and stats.json copied and a
// terms.jsonl holding only the staged lines of the two words used here. Skips with a message when the source is absent.

import assert from 'node:assert/strict';
import { createReadStream, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, test } from 'node:test';
import { checkResponse } from './helpers/shape.mjs';
import { startServerProcess } from './helpers/server.mjs';

const STAGED = path.join(homedir(), 'Developer', 'scrolls-data', 'sources', 'wiktionary-coinage');
const SKIP = !existsSync(path.join(STAGED, 'terms.jsonl')) && `staged Wiktionary source not found at ${STAGED}`;
const WORDS = ['laser', 'robot'];
const SLOW = { timeoutMs: 60000 };

/** The staged terms.jsonl lines of the given English headwords (read-only scan of the staged file). */
async function stagedLines(words) {
  const want = new Set(words);
  const out = [];
  const rl = createInterface({ input: createReadStream(path.join(STAGED, 'terms.jsonl'), 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const m = /"word":"([^"]*)","lang":"en"/.exec(line.slice(0, 200));
    if (m && want.has(m[1])) out.push(line);
  }
  return out;
}

describe('Wiktionary claims for an expression tracked after the load (C2 item 6)', { skip: SKIP }, () => {
  let srv, dir;
  const call = (method, p, body) => srv.request(method, p, { ...(body === undefined ? {} : { body }), ...SLOW });
  async function waitJob(id) {
    for (let i = 0; i < 600; i++) {
      const j = (await call('GET', `/api/jobs/${id}`)).json;
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.status)) return j;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`job ${id} did not finish`);
  }
  /** adapter-load jobs that look a given expression up. */
  async function lookupJobs(exprId) {
    const items = (await call('GET', '/api/jobs?limit=200')).json.items;
    return items.filter((j) => j.type === 'adapter-load' && j.params?.adapter === 'stemm.wiktionary' && j.params?.expressionId === exprId);
  }
  async function track(surface) {
    const r = await call('POST', '/api/expressions', { surface, corpus: 'stemm' });
    assert.equal(r.status, 200, r.text);
    await checkResponse(new Response(r.text, { status: r.status }), 'POST', '/api/expressions');
    return r.json;
  }
  async function settled(id) {
    let e;
    for (let i = 0; i < 600; i++) {
      e = (await call('GET', `/api/expressions/${id}`)).json;
      if (e.state.status !== 'materializing') return e;
      await new Promise((r) => setTimeout(r, 250));
    }
    return e;
  }

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'scrolls-claims-'));
    const staged = path.join(dir, 'sources', 'wiktionary-coinage');
    mkdirSync(staged, { recursive: true });
    for (const f of ['FORMAT.md', 'MANIFEST.json', 'stats.json']) if (existsSync(path.join(STAGED, f))) copyFileSync(path.join(STAGED, f), path.join(staged, f));
    writeFileSync(path.join(staged, 'terms.jsonl'), `${(await stagedLines(WORDS)).join('\n')}\n`);
    srv = await startServerProcess({ dataDir: dir, timeoutMs: 60000 });
  });
  after(async () => {
    await srv?.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  test('tracking a real word after the load queues its lookup once; the claim is written on the expression; others stay fresh', async () => {
    // the load builds the word index; no expression is tracked yet, so it writes no claim
    const load = await call('POST', '/api/adapters/stemm.wiktionary/load', {});
    assert.equal(load.status, 200, load.text);
    const loaded = await waitJob(load.json.job.id);
    assert.equal(loaded.status, 'succeeded', JSON.stringify(loaded.error));
    assert.equal(loaded.result.claims.written, 0);

    // tracked after the load: the lookup is queued at track time
    const laser = await track('laser');
    const id = laser.expression.id;
    let jobs = await lookupJobs(id);
    assert.equal(jobs.length, 1, 'one claim lookup queued for the new expression');
    assert.equal((await waitJob(jobs[0].id)).status, 'succeeded');
    const e = await settled(id);
    await checkResponse(new Response(JSON.stringify(e), { status: 200 }), 'GET', '/api/expressions/:id');
    const shown = e.claims.map((c) => [c.label, c.display]);
    assert.ok(shown.some(([label, display]) => label === 'Wiktionary: coined 1957 (external claim)' && display === 'default'),
      `the dated claim is attached: ${JSON.stringify(shown)}`);
    // a claim is never an occurrence: the (empty) corpus still counts nothing
    assert.equal(e.state.status, 'ready');
    assert.equal(e.state.n, 0);
    const run = e.state.run;

    // a second word: its entry document is written into stemm-wiktionary, which no count reads
    const robot = await track('robot');
    const rjobs = await lookupJobs(robot.expression.id);
    assert.equal(rjobs.length, 1);
    assert.equal((await waitJob(rjobs[0].id)).status, 'succeeded');
    const after2 = await settled(id);
    assert.equal(after2.state.status, 'ready');
    assert.equal(after2.state.run, run, 'the first expression keeps its count (no rematerialization)');
    const materializeJobs = (await call('GET', '/api/jobs?limit=200')).json.items
      .filter((j) => j.type === 'materialize' && j.params?.expressionId === id);
    assert.equal(materializeJobs.length, 1, 'counted once');

    // tracked again: no second lookup
    await track('laser');
    jobs = await lookupJobs(id);
    assert.equal(jobs.length, 1, 'the lookup is queued once per expression');
  });
});
