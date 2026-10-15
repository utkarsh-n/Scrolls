// OWNER: WP1 — acceptance (SPEC §12.4 WP1): a 50 MB CSV dry run takes ≤ 10 s, and projects what the
// commit would do (the projector runs the writer's segmentation, tokenization and language identification).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { availableParallelism } from 'node:os';
import { mulberry32 } from '../src/shared/ids.mjs';
import { dryRun, stageFile } from './fixtures/ingest/harness.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

const TARGET_BYTES = 50 * 1024 * 1024;
const BUDGET_MS = 10000;

/** A deterministic ~50 MB CSV of invented English and Spanish prose (no real text). */
function bigCsv() {
  const en = 'the clerk kept a ledger of every sum and the zero held its place while the auditors counted columns of figures that nobody could read after the flood ruined the outer pages of the old account books'.split(' ');
  const es = 'el cero se lleva en la cuenta y los niños escriben la suma en la pizarra mientras el maestro cuenta las columnas del libro viejo'.split(' ');
  const rnd = mulberry32(1994);
  const parts = ['id,title,author,issued,lang,body\n'];
  let bytes = parts[0].length, i = 0;
  while (bytes < TARGET_BYTES) {
    i++;
    const words = rnd() < 0.85 ? en : es;
    const n = 60 + Math.floor(rnd() * 240);
    const body = Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ');
    const year = 1850 + Math.floor(rnd() * 170);
    const date = rnd() < 0.1 ? `c. ${year}` : rnd() < 0.2 ? `${year}-0${1 + Math.floor(rnd() * 9)}` : String(year);
    const line = `r${i},"Record ${i}, a ledger",Writer ${i % 997} (synthetic),${date},${words === en ? 'English' : 'Spanish'},"${body}."\n`;
    parts.push(line);
    bytes += line.length;
  }
  return { text: parts.join(''), rows: i };
}

describe('50 MB CSV dry run', () => {
  let t, db, big;
  before(() => { t = makeTmpData({ seed: false }); db = t.db; big = bigCsv(); });
  after(() => t.cleanup());

  test(`completes in ≤ ${BUDGET_MS / 1000} s over every row`, async () => {
    const s = stageFile(db, big.text, { fileName: 'big.csv', collection: { name: 'Big' } });
    assert.ok(Buffer.byteLength(big.text) >= TARGET_BYTES);
    const t0 = performance.now();
    const cpu0 = process.cpuUsage();
    const summary = await dryRun(db, s.batchId, s.mapping);
    const ms = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    // single-threaded and CPU-bound: on a machine with a free core the wall time is close to the CPU time; a wall time
    // well above it means the run waited for a CPU (other processes), which this machine's load average does not
    // report reliably
    const starved = ms > 1.5 * cpuMs;
    console.log(`# 50 MB dry run: ${big.rows} rows, ${summary.tokens} tokens, ${summary.passages} passages in ${Math.round(ms)} ms `
      + `(CPU ${Math.round(cpuMs)} ms on ${availableParallelism()} cores${starved ? '; CPU-starved: wall-clock budget not judged' : ''})`);
    assert.equal(summary.rows.seen, big.rows);
    assert.equal(summary.rows.accepted, big.rows);
    assert.ok(summary.tokens > 7_000_000);
    // The dry run is single-threaded: the CPU it consumes is its cost, whatever else the machine runs (M5 gate: at
    // load averages of 200–1000 from other processes the wall time measured the machine, not the code). When the run
    // had a CPU to itself the wall-clock budget is checked as before.
    assert.ok(cpuMs <= BUDGET_MS, `dry run used ${Math.round(cpuMs)} ms of CPU (wall ${Math.round(ms)} ms)`);
    if (!starved) assert.ok(ms <= BUDGET_MS, `dry run took ${Math.round(ms)} ms`);
  });
});
