// OWNER: N0
// MANIFEST.json of the golden fixtures (IOS-SPEC §2.1, §8.4.8): which reference commit, Node, ICU and Unicode produced
// each family, how many cases it has and the sha256 of every file, so a Swift test can prove it reads exactly what
// Node wrote. Regeneration is serialised (only N0 or the integrator runs it); this module merges a partial run into
// the existing manifest and writes the golden-diff report.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

export const MANIFEST_NOTE = 'OWNER: N0 — golden manifest (IOS-SPEC §2.1, §8.4.8). Written by Native/Golden/run.mjs; never edit by hand.';

/** sha256 (lowercase hex) of a file's bytes. */
export function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** sha256 of a string's UTF-8 bytes. */
export function textSha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function git(args, gitDir) {
  try {
    return execFileSync('git', [`--git-dir=${gitDir}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

/**
 * The reference commit and tag. `refArg` (from --ref) wins; otherwise HEAD of the Scrolls repository
 * (~/Developer/git/Scrolls.git, the gitdir of the iCloud folder).
 */
export function referenceInfo(refArg, gitDir = process.env.SCROLLS_GIT_DIR ?? join(homedir(), 'Developer', 'git', 'Scrolls.git')) {
  const commit = refArg && refArg !== 'HEAD' ? (git(['rev-parse', refArg], gitDir) ?? refArg) : git(['rev-parse', 'HEAD'], gitDir);
  const tag = commit ? git(['describe', '--tags', '--exact-match', commit], gitDir) : null;
  return { reference_commit: commit ?? 'unknown', ref_tag: tag || null };
}

/** Node, ICU and Unicode versions of the generating runtime. */
export function runtimeInfo() {
  return { node: process.version, icu: process.versions.icu ?? null, unicode: process.versions.unicode ?? null };
}

/** sha256 over every generator source (Golden/**.mjs, sorted by path), so a changed generator is visible. */
export function generatorSha256(goldenDir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (e !== 'node_modules') walk(p); } else if (e.endsWith('.mjs')) files.push(p);
    }
  };
  walk(goldenDir);
  files.sort();
  const h = createHash('sha256');
  for (const f of files) { h.update(relative(goldenDir, f)); h.update('\0'); h.update(readFileSync(f)); h.update('\0'); }
  return h.digest('hex');
}

/** Reads a manifest, or returns an empty one. */
export function readManifest(path) {
  if (!existsSync(path)) return { '//': MANIFEST_NOTE, families: {}, generated: {} };
  const m = JSON.parse(readFileSync(path, 'utf8'));
  m.families ??= {};
  m.generated ??= {};
  return m;
}

/** Writes a manifest with sorted family and generated-file keys (deterministic bytes). */
export function writeManifest(path, m) {
  const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const out = {
    '//': MANIFEST_NOTE,
    reference_commit: m.reference_commit,
    ref_tag: m.ref_tag ?? null,
    node: m.node, icu: m.icu, unicode: m.unicode,
    generator_sha256: m.generator_sha256,
    families: sortObj(m.families),
    generated: sortObj(m.generated ?? {}),
  };
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

/** The family-level sha256: sha256 of "<file>\0<sha>\n" for its files in name order. */
export function familySha256(files) {
  const h = createHash('sha256');
  for (const name of Object.keys(files).sort()) h.update(`${name}\0${files[name]}\n`);
  return h.digest('hex');
}

/**
 * The golden-diff report between two manifests (IOS-SPEC §2.1): which families changed and by how many cases.
 * @returns {{from: string|null, to: string, changed: object, added: string[], removed: string[], unchanged: string[]}}
 */
export function diffManifests(before, after, regenerated) {
  const changed = {}, added = [], unchanged = [];
  for (const name of regenerated) {
    const a = before.families?.[name], b = after.families[name];
    if (!a) { added.push(name); continue; }
    if (a.sha256 === b.sha256) { unchanged.push(name); continue; }
    changed[name] = { cases_before: a.cases, cases_after: b.cases, sha256_before: a.sha256, sha256_after: b.sha256 };
  }
  return { from: before.reference_commit ?? null, to: after.reference_commit, changed, added, unchanged };
}
