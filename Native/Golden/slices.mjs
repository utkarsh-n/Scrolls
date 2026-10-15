// OWNER: N2
// The Cipher slice for G2 (IOS-SPEC §2.2, §8.5 N2), written in Cipher's own formats and folder layout, so the reference
// (SCROLLS_CIPHER_ROOT=<slice>) and the Swift engine (packs built from the slice exactly as Tools/packs.sh builds them)
// read the same bytes:
//   Cipher/Resources/culture-works.tsv    2,000 rows covering every relation label × source code, the year edge cases
//                                         (empty, 0, scheduled, BCE), works in the tagging batches and works that relation
//                                         endpoints alias onto; rows renumbered 0…1999 and sibling references rewritten
//                                         (a sibling outside the slice is dropped, as Cipher keeps only top-8 relatives)
//   Cipher/Resources/culture-themes.tsv   300 themes
//   Cipher/Resources/roots.tsv            500 families: 0, 1 and several parents (the multi-parent classes)
//   Tools/data/culture/tags/*.jsonl       the tagging lines of the sliced works, file by file
//   Tools/data/culture/songs/relations_{mb,wiki,itwofs}.json   ≈ 5,000 raw relation records (all 428 ItwoFS)
//   Tools/data/culture/texts/gutenberg.json + texts/gutenberg/<id>.txt   25 books: 6 with ***START OF, 3 SMALL PRINT,
//                                         #1661 with its 3 QIDs, 2 double-BOM books, #135, #19942, and 11 drawn
//   Tools/data/culture/pg_catalog.csv     the header and the catalogue records of those books (raw bytes)
//   Tools/data/culture/texts/wikisource-{hi,gu}.jsonl   20 + 20 books (the undated ones first)
// Deterministic (mulberry32 2026); reads the Cipher folder read-only and writes only under the directory it is given.
// The STEMM slice is M2 work.
//
// Also a command (run in a child process by gen-sources.mjs, so SCROLLS_CIPHER_ROOT is set before the reference's
// config.mjs is first imported):  node slices.mjs reference-build <slice root> <dump dir>
// builds the slice with the frozen reference — an empty database (migrate, seedVocab, the file and source adapters),
// then bootstrap-cipher {mode:'all'} at the fixed test clock — and dumps it with dump.mjs.

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { mulberry32 } from '../../src/shared/ids.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';

export const SLICE_VERSION = 'cipher-slice-1';
export const NOW = '2026-10-04T12:00:00Z';
const CIPHER = process.env.SCROLLS_SLICE_SOURCE || join(homedir(), 'Documents', 'AI Stuff', 'Cipher');
const R = 'Cipher/Resources';
const T = 'Tools/data/culture';

const fold = (s) => (s ? tokenize(String(s)).tokens.join(' ') : '');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Deterministic shuffle (Fisher–Yates with mulberry32). */
function shuffled(items, seed) {
  const rnd = mulberry32(seed), a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Lines of a UTF-8 file without its trailing newline handling surprises: [text…] as split on \n (a final '' dropped). */
function lines(file) {
  const t = readFileSync(file, 'utf8');
  const out = t.split('\n');
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

// ── culture works ───────────────────────────────────────────────────────────────────────────────────────────────────

function parseSiblings(field) {
  if (!field) return [];
  return field.split('|').filter(Boolean).map((raw) => {
    const p = raw.split(':');
    return { raw, row: Number(p[0]), relation: p[1] ?? '', source: p.length >= 4 ? p[3] : '-' };
  });
}

function sliceWorks(relationRecords) {
  const rows = lines(join(CIPHER, R, 'culture-works.tsv')).map((text, i) => ({ i, c: text.split('\t') }));
  const pick = new Set();
  const add = (i) => { if (i >= 0 && i < rows.length) pick.add(i); };
  const rnd = (seed) => shuffled(rows, seed);
  // every relation label × source code, with both ends of the pair
  const byKey = new Map();
  for (const r of rnd(11)) {
    for (const s of parseSiblings(r.c[14])) {
      const k = `${s.relation}|${s.source}`;
      const list = byKey.get(k) ?? [];
      if (list.length < 8) { list.push([r.i, s.row]); byKey.set(k, list); }
    }
  }
  for (const list of byKey.values()) for (const [a, b] of list) { add(a); add(b); }
  // year edge cases: empty, 0, scheduled (> 2026), BCE
  const edge = { empty: 0, zero: 0, scheduled: 0, bce: 0 };
  for (const r of rnd(12)) {
    const y = r.c[3];
    const k = y === '' ? 'empty' : y === '0' ? 'zero' : Number(y) > 2026 ? 'scheduled' : Number(y) < 0 ? 'bce' : null;
    if (k && edge[k] < (k === 'empty' ? 20 : 8)) { edge[k]++; add(r.i); }
  }
  // works of the tagging batches
  const tagged = new Set();
  for (const f of readdirSync(join(CIPHER, T, 'tags')).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const l of lines(join(CIPHER, T, 'tags', f))) { try { tagged.add(JSON.parse(l).q); } catch { /* malformed lines stay out */ } }
  }
  let nTagged = 0;
  for (const r of rnd(13)) if (tagged.has(r.c[0]) && nTagged < 150) { nTagged++; add(r.i); }
  // works that relation endpoints alias onto (folded title + folded maker; the year window is the adapter's to judge)
  const byTitleMaker = new Map();
  for (const r of rows) {
    const k = `${fold(r.c[5])}|${fold(r.c[7])}`;
    if (!byTitleMaker.has(k)) byTitleMaker.set(k, []);
    byTitleMaker.get(k).push(r.i);
  }
  let nAlias = 0;
  for (const rec of relationRecords) {
    for (const e of [rec.a, rec.b]) {
      const hit = byTitleMaker.get(`${fold(e?.title)}|${fold(e?.artist)}`);
      if (hit && nAlias < 300) { nAlias++; hit.slice(0, 2).forEach(add); }
    }
  }
  // the rest drawn
  for (const r of rnd(14)) { if (pick.size >= 2000) break; add(r.i); }
  const chosen = [...pick].sort((a, b) => a - b).slice(0, 2000);
  const renumber = new Map(chosen.map((old, n) => [old, n]));
  const out = chosen.map((old) => {
    const c = rows[old].c.slice();
    c[14] = parseSiblings(c[14]).filter((s) => renumber.has(s.row))
      .map((s) => [String(renumber.get(s.row)), ...s.raw.split(':').slice(1)].join(':')).join('|');
    return c.join('\t');
  });
  return { text: out.join('\n') + '\n', qids: new Set(chosen.map((i) => rows[i].c[0])), counts: { works: out.length, keys: byKey.size, edge, tagged: nTagged, alias_hits: nAlias } };
}

// ── raw relation files ──────────────────────────────────────────────────────────────────────────────────────────────

/** Python's json.dumps style (", " and ": ", UTF-8 kept), as Cipher's relations_mb/wiki files are written. */
function pyJSON(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyJSON).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJSON(x)}`).join(', ')}}`;
}

/** json.dump(indent=0) style, as relations_itwofs.json is written. */
function pyJSON0(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return v.length ? `[\n${v.map(pyJSON0).join(',\n')}\n]` : '[]';
  const e = Object.entries(v);
  return e.length ? `{\n${e.map(([k, x]) => `${JSON.stringify(k)}: ${pyJSON0(x)}`).join(',\n')}\n}` : '{}';
}

function sliceRelations() {
  const pickN = { 'relations_mb.json': 3000, 'relations_wiki.json': 1572, 'relations_itwofs.json': Infinity };
  const files = {};
  const all = [];
  for (const [name, n] of Object.entries(pickN)) {
    const src = JSON.parse(readFileSync(join(CIPHER, T, 'songs', name), 'utf8'));
    const keep = n >= src.length ? src.map((_, i) => i) : shuffled(src.map((_, i) => i), 21).slice(0, n).sort((a, b) => a - b);
    const recs = keep.map((i) => src[i]);
    files[name] = name === 'relations_itwofs.json' ? pyJSON0(recs) : pyJSON(recs);
    all.push(...recs);
  }
  return { files, records: all, counts: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, JSON.parse(v).length])) };
}

// ── themes, roots, tags ─────────────────────────────────────────────────────────────────────────────────────────────

function sliceThemes() {
  const all = lines(join(CIPHER, R, 'culture-themes.tsv'));
  const keep = shuffled(all.map((_, i) => i), 31).slice(0, 300).sort((a, b) => a - b);
  return keep.map((i) => all[i]).join('\n') + '\n';
}

function sliceRoots() {
  const all = lines(join(CIPHER, R, 'roots.tsv'));
  const parents = (l) => (l.split('\t')[6] ?? '').split('|').filter(Boolean);
  const by = { 0: [], 1: [], many: [], chain: [] };
  for (const [i, l] of all.entries()) {
    const p = parents(l);
    const k = p.length === 0 ? 0 : p.length === 1 ? 1 : (p.some((x) => x.startsWith('sa:')) && p.some((x) => x.startsWith('ine-pro:')) ? 'chain' : 'many');
    by[k].push(i);
  }
  const take = (list, n, seed) => shuffled(list, seed).slice(0, n);
  const keep = [...take(by[0], 100, 41), ...take(by[1], 150, 42), ...take(by.chain, 100, 43), ...take(by.many, 150, 44)].sort((a, b) => a - b);
  return { text: keep.map((i) => all[i]).join('\n') + '\n', counts: { none: Math.min(100, by[0].length), single: 150, chain: 100, many: 150 } };
}

function sliceTags(qids) {
  const out = {};
  for (const f of readdirSync(join(CIPHER, T, 'tags')).filter((f) => f.endsWith('.jsonl')).sort()) {
    const keep = lines(join(CIPHER, T, 'tags', f)).filter((l) => { try { return qids.has(JSON.parse(l).q); } catch { return false; } });
    out[f] = keep.length ? keep.join('\n') + '\n' : '';
  }
  return out;
}

// ── books ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** RFC 4180 records of a CSV buffer as raw byte ranges (quotes may hold newlines). */
function csvRecords(buf) {
  const out = [];
  let start = 0, q = false;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x22) q = !q;
    else if (b === 0x0A && !q) { out.push([start, i + 1]); start = i + 1; }
  }
  if (start < buf.length) out.push([start, buf.length]);
  return out;
}

function sliceBooks() {
  const dir = join(CIPHER, T, 'texts', 'gutenberg');
  const list = JSON.parse(readFileSync(join(CIPHER, T, 'texts', 'gutenberg.json'), 'utf8'));
  const has = (id, needle) => readFileSync(join(dir, `${id}.txt`)).includes(needle);
  const doubleBOM = (id) => { const b = readFileSync(join(dir, `${id}.txt`)); return b[0] === 0xEF && b[3] === 0xEF && b[4] === 0xBB && b[5] === 0xBF; };
  const ids = [...new Set(list.map((e) => e.id))];
  const want = new Set([1661, 135, 19942]);
  const order = shuffled(ids, 51);
  const pickWhere = (pred, n) => { let k = 0; for (const id of order) { if (k >= n) break; if (!want.has(id) && pred(id)) { want.add(id); k++; } } };
  pickWhere((id) => has(id, '***START OF'), 6);
  pickWhere((id) => has(id, 'SMALL PRINT'), 3);
  pickWhere(doubleBOM, 2);
  for (const id of order) { if (want.size >= 25) break; want.add(id); }
  const entries = list.filter((e) => want.has(e.id));
  // the catalogue: header + the records of these books, raw
  const cat = readFileSync(join(CIPHER, T, 'pg_catalog.csv'));
  const recs = csvRecords(cat);
  const keep = [recs[0]];
  for (const [a, b] of recs.slice(1)) {
    const id = Number(cat.toString('utf8', a, Math.min(b, a + 12)).split(',')[0]);
    if (want.has(id)) keep.push([a, b]);
  }
  return {
    json: pyJSON(entries), ids: [...want].sort((a, b) => a - b),
    catalog: Buffer.concat(keep.map(([a, b]) => cat.subarray(a, b))), entries: entries.length,
  };
}

function sliceWikisource(lang) {
  const all = lines(join(CIPHER, T, 'texts', `wikisource-${lang}.jsonl`));
  const undated = [], dated = [];
  for (const [i, l] of all.entries()) (JSON.parse(l).year == null ? undated : dated).push(i);
  const keep = [...shuffled(undated, 61).slice(0, 6), ...shuffled(dated, 62).slice(0, 14)].sort((a, b) => a - b);
  return keep.map((i) => all[i]).join('\n') + '\n';
}

// ── writing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Writes the Cipher slice under `root` (Cipher's layout); returns {files: [{path, size, sha256}], counts}. */
export async function writeSlices(root) {
  const put = (rel, data) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), data); };
  const rel = sliceRelations();
  const works = sliceWorks(rel.records);
  put(`${R}/culture-works.tsv`, works.text);
  put(`${R}/culture-themes.tsv`, sliceThemes());
  const roots = sliceRoots();
  put(`${R}/roots.tsv`, roots.text);
  for (const [f, text] of Object.entries(sliceTags(works.qids))) put(`${T}/tags/${f}`, text);
  for (const [f, text] of Object.entries(rel.files)) put(`${T}/songs/${f}`, text);
  const books = sliceBooks();
  put(`${T}/texts/gutenberg.json`, books.json);
  put(`${T}/pg_catalog.csv`, books.catalog);
  mkdirSync(join(root, T, 'texts', 'gutenberg'), { recursive: true });
  for (const id of books.ids) copyFileSync(join(CIPHER, T, 'texts', 'gutenberg', `${id}.txt`), join(root, T, 'texts', 'gutenberg', `${id}.txt`));
  for (const lang of ['hi', 'gu']) put(`${T}/texts/wikisource-${lang}.jsonl`, sliceWikisource(lang));
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else { const b = readFileSync(p); files.push({ path: relative(root, p), size: b.length, sha256: sha256(b) }); }
    }
  };
  walk(root);
  return { files, counts: { works: works.counts, relations: rel.counts, roots: roots.counts, books: books.ids, book_entries: books.entries } };
}

// ── the reference build of a slice (child process) ──────────────────────────────────────────────────────────────────

/**
 * Raw ids → id-scheme-free keys, for the columns that hold an id inside text ('document:12' in label_tri.ref,
 * 'run:7' in created_by, …): the Swift comparator maps both sides' raw ids through these keys, because a slot-range
 * atlas and a reference database number rows differently (IOS-SPEC §3.3). The same SQL is in CipherSliceTests.swift.
 */
export const ID_MAP_SQL = {
  document: `SELECT d.id AS id, c.slug || '|' || d.ext_id AS key FROM document d JOIN collection c ON c.id = d.collection_id`,
  passage: `SELECT p.id AS id, c.slug || '|' || d.ext_id || '|' || p.field || '|' || p.ord AS key
    FROM passage p JOIN document d ON d.id = p.document_id JOIN collection c ON c.id = d.collection_id`,
  analysis_run: `SELECT id, stage || '|' || ROW_NUMBER() OVER (PARTITION BY stage ORDER BY id) AS key FROM analysis_run`,
  import_batch: `SELECT b.id AS id, c.slug || '|' || b.adapter_id || '|' || ROW_NUMBER() OVER (PARTITION BY b.collection_id, b.adapter_id ORDER BY b.id) AS key
    FROM import_batch b JOIN collection c ON c.id = b.collection_id`,
};

function idMap(db) {
  const out = [];
  for (const [table, sql] of Object.entries(ID_MAP_SQL)) {
    for (const r of db.prepare(sql).all()) out.push({ kind: 'idmap', table, id: Number(r.id), key: String(r.key) });
  }
  return out;
}

async function referenceBuild(sliceRoot, dumpDir) {
  process.env.SCROLLS_CIPHER_ROOT = sliceRoot;
  process.env.SCROLLS_LOG_LEVEL = 'error';
  const { makeTmpData } = await import('../../tests/helpers/tmpdata.mjs');
  const { registerAdapters } = await import('../../server/adapters/registry.mjs');
  const { makeTaskContext } = await import('../../server/jobs/context.mjs');
  const { run } = await import('../../server/jobs/tasks/bootstrap-cipher.mjs');
  const { dump } = await import('./dump.mjs');
  const t = makeTmpData({ seed: false });
  try {
    await registerAdapters(t.db);
    const ctx = makeTaskContext({ db: t.db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
    const result = await run(ctx, { mode: 'all', now: NOW });
    const spec = JSON.parse(readFileSync(new URL('../ScrollsKit/Sources/ScrollsStore/Resources/dump-spec.json', import.meta.url), 'utf8'));
    const digest = dump(t.db, spec, dumpDir, {});
    writeFileSync(join(dumpDir, 'result.json'), JSON.stringify({ status: result.status, digest }) + '\n');
    writeFileSync(join(dumpDir, 'idmap.jsonl'), idMap(t.db).map((r) => JSON.stringify(r)).join('\n') + '\n');
  } finally {
    t.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'reference-build') await referenceBuild(a, b);
  else if (cmd === 'write') console.log(JSON.stringify((await writeSlices(a)).counts));
  else { console.error('usage: node slices.mjs reference-build <slice root> <dump dir> | write <dir>'); process.exit(2); }
}

export { fold, sha256 };
export const _internal = { csvRecords, pyJSON, pyJSON0, tmpdir, mkdtempSync, rmSync, fileURLToPath };
