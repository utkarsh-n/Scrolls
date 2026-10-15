// OWNER: N2
// G2 on the Cipher slice (IOS-SPEC §2.2, §8.5 N2): slices.mjs writes 2,000 culture works, 5,000 raw music relations,
// 300 themes, 500 roots families, 25 Gutenberg books and 20 + 20 Wikisource books in Cipher's own formats; the frozen
// reference builds them (a child process: SCROLLS_CIPHER_ROOT must be set before config.mjs is first imported) into an
// empty database — migrate, seedVocab, the file and source adapters, then bootstrap-cipher {mode:'all'} at the fixed test
// clock 2026-10-04T12:00:00Z (phases A, A2, B and the boilerplate pass) — and dump.mjs dumps it. The Swift side
// (DifferentialTests/Sources/CipherSliceTests) packs the same files exactly as Tools/packs.sh does, runs its own
// bootstrap and compares its LogicalDump table by table.
//
//   g2.cipher-slice          committed: {kind:'setup'} (slice version, clock, every input file's path, size, sha256),
//                            then {kind:'digest', table, rows, sha256} per table (dump.mjs digest.json order) and the
//                            {kind:'row', table, line} rows of the small tables (≤ 600 rows)
//   g2.cipher-slice-rows     private (size): every row of every table but passage_fts (compared by digest: its instance
//                            rows hold no raw ids) as {kind:'rows', table, lines[≤ 2,000]}, and {kind:'idmap', table,
//                            pairs:[[id, key]…]} mapping the reference's raw ids to id-free keys
//   g2.cipher-slice-inputs   private (size): the slice files themselves, {path, size, sha256, base64}
// Text is public domain (Gutenberg) or CC BY-SA (Wikisource; export_text_allowed = 1), metadata CC0 / CC BY-SA
// (Wikidata, Wikipedia, MusicBrainz, ItwoFS CC BY 2.5, Wiktionary): attribution in the manifest. The STEMM slice
// (g2.stemm-slice) is M2 work and still throws, so selecting it fails instead of committing an empty golden.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NOW, SLICE_VERSION, sha256, writeSlices } from './slices.mjs';

export const owner = 'N2';
export const group = 'sources';

const SMALL = 600;
/** Tables compared by digest only (no raw ids inside: FTS instance rows are (term, document key, column, offset)). */
const DIGEST_ONLY = new Set(['passage_fts']);
/** Rows per private case (a case holds a table's lines in order; the harness caps a file at 8 MB). */
const PER_CASE = 2000;
let memo = null;

/** The slice dump: rebuilt, or reused from SCROLLS_N2_SLICE_DIR when it holds a build of the same slice files. */
function referenceDump(root, files, scratch) {
  const keep = process.env.SCROLLS_N2_SLICE_DIR;
  const key = sha256(JSON.stringify(files));
  const out = keep ? join(keep, key.slice(0, 16)) : join(scratch, 'dump');
  if (!(keep && existsSync(join(out, 'result.json')))) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    execFileSync(process.execPath, [fileURLToPath(new URL('./slices.mjs', import.meta.url)), 'reference-build', root, out],
                 { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, SCROLLS_NO_AUTO_IMPORT: '1' } });
  }
  return out;
}

/** The slice, its reference build and its dump, once per run. */
async function build() {
  if (memo) return memo;
  const dir = mkdtempSync(join(tmpdir(), 'scrolls-n2-slice-'));
  try {
    const root = join(dir, 'cipher');
    const slice = await writeSlices(root);
    const out = referenceDump(root, slice.files, dir);
    const { status, digest } = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
    if (status !== 'ready') throw new Error(`the reference bootstrap of the slice ended '${status}'`);
    const committed = [{ kind: 'setup', slice_version: SLICE_VERSION, now: NOW, files: slice.files, counts: slice.counts,
                         bootstrap: { mode: 'all', status }, digest_only: [...DIGEST_ONLY] }];
    const rows = [];
    for (const table of Object.keys(digest).sort()) {
      const d = digest[table];
      committed.push({ kind: 'digest', table, ...d });
      if (d.skipped || DIGEST_ONLY.has(table)) continue;
      const lines = readFileSync(join(out, `${table}.jsonl`), 'utf8').split('\n').filter(Boolean);
      if (lines.length <= SMALL) for (const line of lines) committed.push({ kind: 'row', table, line });
      for (let i = 0; i < lines.length; i += PER_CASE) rows.push({ kind: 'rows', table, lines: lines.slice(i, i + PER_CASE) });
    }
    const ids = {};
    for (const line of readFileSync(join(out, 'idmap.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      (ids[r.table] ??= []).push([r.id, r.key]);
    }
    for (const [table, pairs] of Object.entries(ids)) {
      for (let i = 0; i < pairs.length; i += PER_CASE * 2) rows.push({ kind: 'idmap', table, pairs: pairs.slice(i, i + PER_CASE * 2) });
    }
    const inputs = slice.files.map((f) => ({ ...f, base64: readFileSync(join(root, f.path)).toString('base64') }));
    memo = { committed, rows, inputs, files: slice.files.length };
    return memo;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const attribution = 'Cipher (Utkarsh Nimavat): Wikidata (CC0), Wikipedia (CC BY-SA), MusicBrainz (CC0), ItwoFS (CC BY 2.5), '
  + 'Wiktionary via kaikki.org (CC BY-SA); Project Gutenberg texts (public domain in the US); Hindi and Gujarati Wikisource (CC BY-SA)';

export const families = {
  'g2.cipher-slice': {
    owner, attribution,
    note: 'the Cipher slice (slices.mjs) built by the frozen reference (bootstrap-cipher mode all, clock 2026-10-04T12:00:00Z) and dumped; digests of every table, rows of the small ones',
    run: async (ctx) => {
      const b = await build();
      ctx.inputs = { slice_version: SLICE_VERSION, files: b.files };
      return b.committed;
    },
  },
  'g2.cipher-slice-rows': {
    owner, private: true, attribution,
    note: 'every dumped row of g2.cipher-slice (size)',
    run: async () => (await build()).rows,
  },
  'g2.cipher-slice-inputs': {
    owner, private: true, attribution,
    note: 'the slice files themselves (base64), so the Swift side reads the bytes the reference read',
    run: async () => (await build()).inputs,
  },
  'g2.stemm-slice': {
    owner,
    run: async () => { throw new Error('g2.stemm-slice: M2 work (package N2), not written yet'); },
  },
};
