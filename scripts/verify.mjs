// OWNER: WP8 — `npm run verify`: the whole verification in one command (SPEC §11, §12.5)
//
//   1. npm test — the full suite (--no-test skips it);
//   2. clone the snapshot (default ~/Developer/scrolls-snapshots/m1r, else m1) into a temp data directory (APFS clone on
//      macOS); with no snapshot, the journey is skipped with a message and only the suite decides the result;
//   3. boot server.mjs there on a free port and run the acceptance journey over HTTP (scripts/verify-journey.mjs),
//      restarting the server once; every JSON response is checked against its contract shape, and every request and
//      response is recorded as JSONL (RF-3: <work>/journey.jsonl, or --record <file>);
//   4. print a PASS/FAIL table and exit 1 when anything failed (the work directory is kept for inspection then).
//
// Options: --no-test · --snapshot <dir | scrolls.db> (or SCROLLS_VERIFY_SNAPSHOT) · --originals <dir> · --record <file> · --keep
// The live data directory is never written: the snapshot is only read to clone it, a database with a non-empty WAL
// (a running server's) is refused, and originals/ is cloned rather than linked, because the journey's imports
// store their files there.

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildImportFiles, createClient, runJourney } from './verify-journey.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = path.join(ROOT, 'server.mjs');
const SNAPSHOTS = path.join(homedir(), 'Developer', 'scrolls-snapshots');
/** The fresh snapshot of ref-freeze-1 (RF-4) when it exists, else the M1 one. */
const DEFAULT_SNAPSHOT = existsSync(path.join(SNAPSHOTS, 'm1r', 'scrolls.db')) ? path.join(SNAPSHOTS, 'm1r') : path.join(SNAPSHOTS, 'm1');
const LIVE_DATA = path.join(homedir(), 'Developer', 'scrolls-data');
const BOOT_TIMEOUT_MS = 120000;

// ── arguments ──────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { test: true, keep: false, snapshot: process.env.SCROLLS_VERIFY_SNAPSHOT || DEFAULT_SNAPSHOT, originals: null, record: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-test') out.test = false;
    else if (a === '--keep') out.keep = true;
    else if (a === '--snapshot') out.snapshot = argv[++i];
    else if (a === '--originals') out.originals = argv[++i];
    else if (a === '--record') out.record = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

const HELP = `npm run verify [-- --no-test] [--snapshot <dir|scrolls.db>] [--originals <dir>] [--record <file.jsonl>] [--keep]
  Runs npm test, then the acceptance journey over HTTP on a clone of a snapshot (default ${DEFAULT_SNAPSHOT});
  records every journey request and response as JSONL (--record, else in the work directory); prints a PASS/FAIL
  table; exit code 1 on any failure.`;

/** The reference commit the journey runs (git HEAD of this checkout), or null outside a git checkout. */
function referenceCommit() {
  try { return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

// ── table ──────────────────────────────────────────────────────────────────────────────────────────

const fmtMs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

/**
 * The PASS/FAIL table.
 * @param {Array<{name: string, ok: boolean|null, ms: number, detail: string}>} rows ok null = SKIP
 * @returns {string}
 */
export function formatTable(rows) {
  const w = Math.max(4, ...rows.map((r) => r.name.length));
  const lines = [` #  ${'step'.padEnd(w)}  result  time     detail`, ` ${'-'.repeat(w + 30)}`];
  rows.forEach((r, i) => {
    const res = r.ok === null ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
    lines.push(`${String(i + 1).padStart(2)}  ${r.name.padEnd(w)}  ${res.padEnd(6)}  ${(r.ms ? fmtMs(r.ms) : '').padEnd(7)}  ${r.detail}`);
  });
  return lines.join('\n');
}

// ── npm test ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Counts from node --test output (TAP "# pass 3" or spec "ℹ pass 3") and the names of failing tests (TAP "not ok"
 * lines; spec: the "✖ failing tests:" section, each with the file it is in).
 * @param {string} out
 * @returns {{tests: number, pass: number, fail: number, skipped: number, todo: number, failing: string[]}}
 */
export function parseTestOutput(out) {
  const num = (k) => {
    const all = [...out.matchAll(new RegExp(`^(?:#|ℹ) ${k} (\\d+)\\s*$`, 'gm'))];
    return all.length ? Number(all.at(-1)[1]) : NaN;
  };
  const failing = new Set();
  for (const m of out.matchAll(/^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/gm)) failing.add(m[1]);
  const section = out.lastIndexOf('✖ failing tests:');
  if (section !== -1) {
    let file = null;
    for (const line of out.slice(section).split('\n').slice(1)) {
      const at = line.match(/^test at (.+?):\d+:\d+$/);
      if (at) { file = at[1].split('/').pop(); continue; }
      const m = line.match(/^✖ (.+?)(?: \([\d.]+m?s\))?$/);
      if (m) failing.add(file ? `${m[1]} (${file})` : m[1]);
    }
  }
  return { tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped'), todo: num('todo'), failing: [...failing] };
}

function runNpmTest(logFile) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn('npm', ['test'], { cwd: ROOT, env: { ...process.env, SCROLLS_LOG_LEVEL: process.env.SCROLLS_LOG_LEVEL ?? 'error' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (c) => { out += c; appendFileSync(logFile, c); };
    child.stdout.setEncoding('utf8').on('data', take);
    child.stderr.setEncoding('utf8').on('data', take);
    child.on('close', (code) => {
      const s = parseTestOutput(out);
      const counts = Number.isNaN(s.tests) ? 'no summary in the output' : `${s.tests} tests, ${s.pass} pass, ${s.fail} fail, ${s.skipped} skipped${s.todo ? `, ${s.todo} todo` : ''}`;
      const names = s.failing.length ? `; failing: ${s.failing.slice(0, 8).join(' | ')}${s.failing.length > 8 ? ' …' : ''}` : '';
      resolve({ name: 'npm test', ok: code === 0, ms: performance.now() - t0, detail: `${counts}${names} (log ${logFile})` });
    });
  });
}

// ── snapshot clone ─────────────────────────────────────────────────────────────────────────────────

function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Where the snapshot database is, or why it cannot be used.
 * @param {string} spec a directory holding scrolls.db, or the file itself
 * @returns {{db: string, dir: string}|{skip: string}}
 */
export function resolveSnapshot(spec) {
  const p = path.resolve(spec.replace(/^~(?=$|\/)/, homedir()));
  const db = p.endsWith('.db') ? p : path.join(p, 'scrolls.db');
  if (!existsSync(db)) return { skip: `no snapshot at ${db} (give one with --snapshot <dir> or SCROLLS_VERIFY_SNAPSHOT)` };
  const real = realpathSync(db);
  for (const live of [LIVE_DATA, process.env.SCROLLS_DATA].filter(Boolean)) {
    if (existsSync(live) && within(real, realpathSync(live))) return { skip: `${db} is inside the live data directory ${live}; verify only reads snapshots` };
  }
  try {
    if (statSync(`${db}-wal`).size > 0) return { skip: `${db} has a non-empty WAL: a server may be using it; use a snapshot copy` };
  } catch { /* no WAL: a snapshot */ }
  return { db, dir: path.dirname(db) };
}

function cloneFile(src, dst) {
  if (process.platform === 'darwin') {
    try { execFileSync('cp', ['-c', src, dst]); return 'clone'; } catch { /* not APFS: copy */ }
  }
  copyFileSync(src, dst, constants.COPYFILE_FICLONE);
  return 'copy';
}

function cloneOriginals(src, dst) {
  if (!src || !existsSync(src)) { mkdirSync(dst, { recursive: true }); return 'none (empty originals/)'; }
  const real = realpathSync(src);
  if (process.platform === 'darwin') {
    try { execFileSync('cp', ['-cR', `${real}/`, dst]); return `cloned from ${src}`; } catch { /* fall through */ }
  }
  mkdirSync(dst, { recursive: true });
  return `not cloned (no copy-on-write clone here; the integrity check will report missing originals)`;
}

// ── server process ─────────────────────────────────────────────────────────────────────────────────

function bootServer(dataDir, logFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SCROLLS_DATA: dataDir, SCROLLS_PORT: '0', SCROLLS_NO_AUTO_IMPORT: '1', SCROLLS_MOCK: '0',
        SCROLLS_LOG_LEVEL: process.env.SCROLLS_LOG_LEVEL ?? 'warn' } });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`no "listening" line in ${BOOT_TIMEOUT_MS / 1000} s; see ${logFile}`)); }, BOOT_TIMEOUT_MS);
    child.stderr.setEncoding('utf8').on('data', (c) => appendFileSync(logFile, c));
    child.stdout.setEncoding('utf8').on('data', (c) => {
      appendFileSync(logFile, c);
      out += c;
      const line = out.split('\n').find((l) => l.startsWith('{') && l.includes('"listening"'));
      if (line) { clearTimeout(timer); resolve({ child, url: JSON.parse(line).url }); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}) before listening; see ${logFile}`)); });
  });
}

function stopServer(child, timeoutMs = 20000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('exit', () => { clearTimeout(kill); resolve(); });
    child.kill('SIGTERM');
  });
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) { process.stderr.write(`${err.message}\n${HELP}\n`); process.exitCode = 2; return; }
  if (args.help) { process.stdout.write(`${HELP}\n`); return; }
  const work = mkdtempSync(path.join(tmpdir(), 'scrolls-verify-'));
  const rows = [];
  process.stdout.write(`Scrolls verify — work directory ${work}\n`);

  if (args.test) {
    process.stdout.write('running npm test (several minutes on a loaded machine) …\n');
    rows.push(await runNpmTest(path.join(work, 'npm-test.log')));
  } else {
    rows.push({ name: 'npm test', ok: null, ms: 0, detail: 'skipped (--no-test)' });
  }

  const snap = resolveSnapshot(args.snapshot);
  let server = null;
  if (snap.skip) {
    rows.push({ name: 'acceptance journey', ok: null, ms: 0, detail: `skipped: ${snap.skip}` });
  } else {
    const dataDir = path.join(work, 'data');
    const serverLog = path.join(work, 'server.log');
    try {
      const t0 = performance.now();
      mkdirSync(dataDir, { recursive: true });
      const how = cloneFile(snap.db, path.join(dataDir, 'scrolls.db'));
      const origins = cloneOriginals(args.originals ?? (existsSync(path.join(snap.dir, 'originals')) ? path.join(snap.dir, 'originals') : path.join(LIVE_DATA, 'originals')),
        path.join(dataDir, 'originals'));
      const files = buildImportFiles(path.join(dataDir, 'scrolls.db'), new URL('../tests/fixtures/ingest/', import.meta.url));
      rows.push({ name: 'snapshot clone', ok: true, ms: performance.now() - t0,
        detail: `${snap.db} → ${dataDir} (${how}); originals ${origins}; import files from ${files.kind === 'real' ? 'the snapshot\'s Gutenberg paragraphs' : 'tests/fixtures/ingest (synthetic)'}` });
      const t1 = performance.now();
      server = await bootServer(dataDir, serverLog);
      rows.push({ name: 'boot', ok: true, ms: performance.now() - t1, detail: `${server.url} (log ${serverLog})` });
      process.stdout.write(`journey against ${server.url} …\n`);
      // RF-3: every request and response, one JSON object per line (G7 replays them)
      const recordFile = args.record ?? path.join(work, 'journey.jsonl');
      mkdirSync(path.dirname(recordFile), { recursive: true });
      writeFileSync(recordFile, `${JSON.stringify({ journey: 'scrolls-verify', format: 1, started_at: new Date().toISOString(),
        reference_commit: referenceCommit(), node: process.version, snapshot: snap.db, import_files: files.kind })}\n`);
      const client = createClient(server.url, { record: (entry) => appendFileSync(recordFile, `${JSON.stringify(entry)}\n`) });
      rows.push({ name: 'journey record', ok: true, ms: 0,
        detail: args.record ? recordFile : `${recordFile} (removed with the work directory unless --keep; --record <file> keeps it)` });
      const restart = async () => {
        await stopServer(server.child);
        server = await bootServer(dataDir, serverLog);
        return server.url;
      };
      rows.push(...await runJourney({ client, files, restart }));
      if (args.record) process.stdout.write(`journey recorded in ${args.record}\n`);
    } catch (err) {
      rows.push({ name: 'acceptance journey', ok: false, ms: 0, detail: String(err?.message ?? err) });
    } finally {
      await stopServer(server?.child);
    }
  }

  const failed = rows.some((r) => r.ok === false);
  process.stdout.write(`\n${formatTable(rows)}\n\n${failed ? 'FAIL' : 'PASS'}${rows.some((r) => r.ok === null) ? ' (with skipped steps)' : ''}\n`);
  if (failed || args.keep) process.stdout.write(`kept ${work} (logs and the journey's data directory)\n`);
  else rmSync(work, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
