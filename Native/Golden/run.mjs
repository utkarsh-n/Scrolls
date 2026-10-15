#!/usr/bin/env node
// OWNER: N0
// The golden-fixture generator (IOS-SPEC §2, §8.4.8). Imports every Golden/gen-*.mjs, runs the selected families against
// the Node reference (read-only imports of ../../server and ../../src) and writes <family>/cases-NNNN.jsonl plus
// MANIFEST.json. Regeneration is serialised: only N0 or the integrator runs it (Tools/golden.sh, Tools/check.sh golden).
//
//   node Golden/run.mjs --families g1.core[,g1.dates,…|all] --out ~/Developer/scrolls-golden/<commit>
//        [--ref <commit>] [--commit-subset Native/ScrollsKit/Tests/DifferentialTests/Golden]
//        [--snapshots ~/Developer/scrolls-snapshots] [--native <Native dir for generated Swift>] [--reports <dir>]
//        [--no-generate] [--list]
//
// A generator module exports `families = { name: async (ctx) => cases }` (or `{ run, private, owner, attribution }`),
// optionally `group` (selects all its families at once, e.g. 'g1.core') and `generate(ctx)` (generated sources).
// Families marked private (unredacted text) are written only under <out>/private/ and listed in the manifest.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cloneSnapshot, findSnapshot, refuseForbidden, snapshotInfo, snapshotsRoot, withClone } from './lib/clone.mjs';
import {
  diffManifests, familySha256, fileSha256, generatorSha256, readManifest, referenceInfo, runtimeInfo, writeManifest,
} from './lib/manifest.mjs';
import { wellFormed } from './lib/normalize.mjs';

const GOLDEN = dirname(fileURLToPath(import.meta.url));
const MAX_CASES_PER_FILE = 2000;
const MAX_BYTES_PER_FILE = 8 << 20;

function parseArgs(argv) {
  const a = { families: [], generate: true, list: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
    switch (k) {
      case '--families': a.families.push(...val().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--ref': a.ref = val(); break;
      case '--out': a.out = val(); break;
      case '--commit-subset': a.commitSubset = val(); break;
      case '--snapshots': a.snapshots = val(); break;
      case '--native': a.native = val(); break;
      case '--reports': a.reports = val(); break;
      case '--no-generate': a.generate = false; break;
      case '--list': a.list = true; break;
      default: throw new Error(`unknown argument '${k}'`);
    }
  }
  return a;
}

async function loadModules() {
  const mods = [];
  for (const f of readdirSync(GOLDEN).filter((n) => /^gen-.*\.mjs$/.test(n)).sort()) {
    const m = await import(pathToFileURL(join(GOLDEN, f)).href);
    const group = m.group ?? f.replace(/^gen-|\.mjs$/g, '');
    const fams = Object.entries(m.families ?? {}).map(([name, spec]) => {
      const s = typeof spec === 'function' ? { run: spec } : spec;
      return { name, module: f, group, run: s.run, private: Boolean(s.private), owner: s.owner ?? m.owner ?? null,
        tier: s.tier ?? name.split('.')[0], attribution: s.attribution ?? [], note: s.note ?? null };
    });
    mods.push({ file: f, group, families: fams, generate: m.generate ?? null });
  }
  return mods;
}

function writeFamily(dir, cases) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = {};
  let part = 0, lines = [], bytes = 0;
  const flush = () => {
    if (!lines.length) return;
    const name = `cases-${String(part).padStart(4, '0')}.jsonl`;
    writeFileSync(join(dir, name), `${lines.join('\n')}\n`);
    files[name] = fileSha256(join(dir, name));
    part++; lines = []; bytes = 0;
  };
  for (const c of cases) {
    const line = JSON.stringify(wellFormed(c));
    if (lines.length >= MAX_CASES_PER_FILE || (lines.length && bytes + line.length > MAX_BYTES_PER_FILE)) flush();
    lines.push(line);
    bytes += line.length + 1;
  }
  flush();
  return files;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modules = await loadModules();
  const all = modules.flatMap((m) => m.families);
  if (args.list) {
    for (const f of all) console.log(`${f.name.padEnd(28)} group=${f.group.padEnd(10)} ${f.private ? 'private ' : ''}(${f.module})`);
    return;
  }
  if (!args.out) throw new Error('--out is required');
  if (!args.families.length) throw new Error('--families is required (a family, a group such as g1.core, or all)');
  const wanted = new Set(args.families);
  const selected = all.filter((f) => wanted.has('all') || wanted.has(f.name) || wanted.has(f.group));
  const unknown = [...wanted].filter((w) => w !== 'all' && !all.some((f) => f.name === w || f.group === w));
  if (unknown.length) throw new Error(`unknown families/groups: ${unknown.join(', ')}`);

  const out = resolve(args.out);
  refuseForbidden(out, '--out');  // goldens live in ~/Developer/scrolls-golden, never in iCloud
  const native = resolve(args.native ?? join(GOLDEN, '..'));
  const refRoot = resolve(GOLDEN, '..', '..');
  const ref = referenceInfo(args.ref);
  const snaps = snapshotsRoot(args.snapshots);
  mkdirSync(out, { recursive: true });

  const ctx = {
    ref, refRoot, native, out, privateDir: join(out, 'private'), snapshots: snaps,
    log: (...m) => console.error('[golden]', ...m),
    reference: (rel) => import(pathToFileURL(join(refRoot, rel)).href),
    findSnapshot: (names) => findSnapshot(snaps, names),
    snapshotInfo: (name) => snapshotInfo(snaps, name),
    cloneSnapshot: (name) => cloneSnapshot(name, { root: snaps }),
    withClone: (name, fn) => withClone(name, { root: snaps }, fn),
    generatedFiles: {},
    writeGenerated(relUnderNative, content) {
      const p = join(native, relUnderNative);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      ctx.generatedFiles[relUnderNative] = fileSha256(p);
      ctx.log(`generated ${relUnderNative}`);
    },
  };

  const manifestPath = args.commitSubset ? join(resolve(args.commitSubset), 'MANIFEST.json') : join(out, 'MANIFEST.json');
  const before = readManifest(manifestPath);
  const manifest = structuredClone(before);
  Object.assign(manifest, ref, runtimeInfo(), { generator_sha256: generatorSha256(GOLDEN) });

  if (args.generate) {
    for (const m of modules) {
      if (m.generate && selected.some((f) => f.module === m.file)) await m.generate(ctx);
    }
    Object.assign(manifest.generated, ctx.generatedFiles);
  }

  for (const fam of selected) {
    const t0 = Date.now();
    ctx.log(`${fam.name}: running`);
    const famCtx = { ...ctx, family: fam.name, inputs: null };  // a generator records what it read in famCtx.inputs
    const cases = await fam.run(famCtx);
    if (!Array.isArray(cases)) throw new Error(`${fam.name}: a family must return an array of cases`);
    const dir = fam.private ? join(out, 'private', fam.name) : join(out, fam.name);
    const files = writeFamily(dir, cases);
    manifest.families[fam.name] = {
      tier: fam.tier, owner: fam.owner, module: fam.module, private: fam.private, cases: cases.length,
      reference_commit: ref.reference_commit, files, sha256: familySha256(files),
      ...(famCtx.inputs ? { inputs: famCtx.inputs } : {}),
      ...(fam.attribution.length ? { attribution: fam.attribution } : {}), ...(fam.note ? { note: fam.note } : {}),
    };
    ctx.log(`${fam.name}: ${cases.length} cases in ${Object.keys(files).length} file(s), ${Date.now() - t0} ms`);
    if (args.commitSubset && !fam.private) {
      const dst = join(resolve(args.commitSubset), fam.name);
      rmSync(dst, { recursive: true, force: true });
      cpSync(dir, dst, { recursive: true });
    }
  }

  const written = writeManifest(join(out, 'MANIFEST.json'), manifest);
  if (args.commitSubset) writeManifest(manifestPath, manifest);
  const diff = diffManifests(before, written, selected.map((f) => f.name));
  const reports = args.reports ?? join(native, 'Reports');
  if (existsSync(reports)) {
    const short = (c) => (c ?? 'none').slice(0, 12);
    const p = join(reports, `golden-diff-${short(diff.from)}-${short(diff.to)}.json`);
    writeFileSync(p, `${JSON.stringify(diff, null, 2)}\n`);
    ctx.log(`diff report ${p}`);
  }
  console.log(JSON.stringify({ reference_commit: ref.reference_commit, families: selected.map((f) => f.name),
    changed: Object.keys(diff.changed), added: diff.added, unchanged: diff.unchanged }));
}

main().catch((e) => { console.error(`[golden] FAILED: ${e?.stack ?? e}`); process.exit(1); });
