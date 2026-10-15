// OWNER: WP2
// scripts/bootstrap-cipher.mjs — `npm run bootstrap`: run the whole Cipher bootstrap (SPEC §6.8) outside the
// server, in this process, and print timings and reconciliation counts as JSON.
//
//   node scripts/bootstrap-cipher.mjs [--data <dir>] [--through A] [--now <iso>]
//
// --data sets SCROLLS_DATA (default: $SCROLLS_DATA or ~/Developer/scrolls-data). Use a temp directory to
// measure without touching the real data. The server must not be running on the same data directory.

import { ensureDirs, paths } from '../server/config.mjs';
import { registerAdapters } from '../server/adapters/registry.mjs';
import { migrate } from '../server/db/migrate.mjs';
import { openDb } from '../server/db/open.mjs';
import { seedVocab } from '../server/db/seed-vocab.mjs';
import { makeTaskContext } from '../server/jobs/context.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
}

const data = arg('data');
if (data) process.env.SCROLLS_DATA = data;
const through = arg('through');
const now = arg('now');

ensureDirs();
const db = openDb();
migrate(db);
seedVocab(db);
await registerAdapters(db);

let lastLine = 0;
const post = (msg) => {
  if (msg.kind === 'progress' && Date.now() - lastLine > 2000) {
    lastLine = Date.now();
    process.stderr.write(`${new Date().toISOString().slice(11, 19)}  ${(msg.fraction * 100).toFixed(1).padStart(5)}%  ${msg.phase ?? ''}  ${msg.message ?? ''}\n`);
  } else if (msg.kind === 'log') {
    process.stderr.write(`${msg.level}: ${msg.message}\n`);
  }
};
const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
process.on('SIGINT', () => { Atomics.store(cancelFlag, 0, 1); process.stderr.write('cancelling…\n'); });
const ctx = makeTaskContext({ db, jobId: null, cancelFlag, post, type: 'bootstrap-cipher' });

const { run } = await import('../server/jobs/tasks/bootstrap-cipher.mjs');
const t0 = Date.now();
try {
  const result = await run(ctx, { mode: 'all', ...(through ? { through } : {}), ...(now ? { now } : {}) });
  const runRow = db.prepare("SELECT id, metrics_json FROM analysis_run WHERE stage = 'bootstrap-cipher' AND status = 'succeeded' ORDER BY id DESC LIMIT 1").get();
  const out = { data: paths().data, elapsed_ms: Date.now() - t0, phase_a_ms: result.A?.ms ?? null, result, metrics: runRow ? JSON.parse(runRow.metrics_json) : null };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} catch (err) {
  process.stderr.write(`bootstrap failed: ${err?.code ?? ''} ${err?.message ?? err}\n`);
  process.exitCode = 1;
} finally {
  db.close();
}
