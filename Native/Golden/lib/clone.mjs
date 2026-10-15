// OWNER: N0
// Copy-on-write clones of the reference snapshots (m1r, m5r, …) for golden generation (IOS-SPEC §8.4.8).
// A generator never opens a snapshot in place and never touches the live atlas or anything under ~/Documents.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const FORBIDDEN = [join(homedir(), 'Developer', 'scrolls-data'), join(homedir(), 'Documents')];

/** Throws when `p` (or what it resolves to) lies under the live data directory or ~/Documents (iCloud). */
export function refuseForbidden(p, what = 'path') {
  const candidates = [resolve(p)];
  try { candidates.push(realpathSync(p)); } catch { /* not created yet */ }
  for (const c of candidates) {
    for (const f of FORBIDDEN) {
      if (c === f || c.startsWith(f + sep)) {
        throw new Error(`clone: refusing ${what} '${c}' (under ${f}); golden generation only reads snapshot clones`);
      }
    }
  }
}

/** The snapshots root (default ~/Developer/scrolls-snapshots). */
export function snapshotsRoot(opt) {
  return resolve(opt ?? process.env.SCROLLS_SNAPSHOTS ?? join(homedir(), 'Developer', 'scrolls-snapshots'));
}

/**
 * Whether a snapshot is complete: its scrolls.db exists, and a snapshot built by the reference steward's builder (it
 * writes build.log first and SNAPSHOT.json last) has finished. Legacy snapshots (m1, m5-stemm) have neither file.
 */
export function isCompleteSnapshot(root, name) {
  const dir = join(root, name);
  if (!existsSync(join(dir, 'scrolls.db'))) return false;
  if (existsSync(join(dir, 'SNAPSHOT.json'))) return true;
  return !existsSync(join(dir, 'build.log'));
}

/** The first complete snapshot of `names` under `root`, or null (a snapshot still being built is never read). */
export function findSnapshot(root, names) {
  for (const n of names) if (isCompleteSnapshot(root, n)) return n;
  return null;
}

/** SNAPSHOT.json of a snapshot (null for legacy snapshots). */
export function snapshotInfo(root, name) {
  const p = join(root, name, 'SNAPSHOT.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Clone `<root>/<name>/scrolls.db` with `cp -c` (APFS copy-on-write: instant, no extra space until written) into a
 * fresh directory under $TMPDIR. A snapshot's `originals/` is linked, never copied. Returns {dir, db, cleanup}.
 */
export function cloneSnapshot(name, { root, tmp } = {}) {
  const r = snapshotsRoot(root);
  const src = join(r, name, 'scrolls.db');
  if (!existsSync(src)) throw new Error(`clone: snapshot '${name}' not found at ${src}`);
  refuseForbidden(src, 'snapshot');
  const base = resolve(tmp ?? process.env.TMPDIR ?? tmpdir());
  refuseForbidden(base, 'clone directory');
  const dir = mkdtempSync(join(base, `scrolls-golden-${name}-`));
  const db = join(dir, 'scrolls.db');
  execFileSync('/bin/cp', ['-c', src, db]);
  for (const side of ['-wal', '-shm']) if (existsSync(src + side)) execFileSync('/bin/cp', ['-c', src + side, db + side]);
  const originals = join(r, name, 'originals');
  if (existsSync(originals)) symlinkSync(originals, join(dir, 'originals'));
  return { dir, db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Runs `fn({dir, db})` on a fresh clone and always removes it afterwards. */
export async function withClone(name, opts, fn) {
  const c = cloneSnapshot(name, opts);
  try { return await fn(c); } finally { c.cleanup(); }
}
