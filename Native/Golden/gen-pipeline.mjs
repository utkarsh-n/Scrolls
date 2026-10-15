// OWNER: N1
// G1 text families of the ingest port (the seg-1 segmenter, langid) and the G2 pipeline dumps (IOS-SPEC §2.2, §8.5 N1):
// records written into an empty database through the reference's DocumentWriter, then a LogicalDump (Golden/dump.mjs)
// that ScrollsIngestTests compare with the Swift writer's dump of the same inputs, table by table.
//
//   g1.segment          segment() over edge texts, fuzz texts, the mini fixture and every demo document (committed)
//   g1.segment-books    segment() over the 50 snapshot books of g1.sentences-books (private: size)
//   g1.langid           scriptOf / detectLang / documentLang over snapshot passages, samples and edge strings (committed)
//   g2.mini             the mini fixture (tests/fixtures/mini) through createDocumentWriter, as tests/helpers/tmpdata.mjs
//   g2.demo             the demo world's documents, relationships and annotations through one writer (no adapter)
//   g2.demo-fts         the passage_fts instance rows of g2.demo (private: size; g2.demo commits their digest)
//
// G2 cases: {kind:'setup'}, {kind:'input', …} in write order, then {kind:'row', table, line} for every dump line and
// {kind:'digest', table, rows, sha256} per table (digest.json of dump.mjs). Every family uses the reference's fixed
// test clock (2026-10-04T12:00:00Z). Inputs are invented (mini, demo) or public-domain / CC BY-SA snapshot text
// (export_text_allowed = 1 only, §2.6).

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { mulberry32 } from '../../src/shared/ids.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { dump } from './dump.mjs';
import { sha256Utf8 } from './lib/redact.mjs';

export const owner = 'N1';
export const group = 'pipeline';

const NOW = new Date('2026-10-04T12:00:00Z');
const INPUT_SNAPSHOTS = ['m5r', 'm1r'];
const SPEC_PATH = new URL('../ScrollsKit/Sources/ScrollsStore/Resources/dump-spec.json', import.meta.url);

// ── a temporary data directory (the reference's paths() must never reach ~/Developer/scrolls-data) ────────────────

async function withTmpData(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'scrolls-n1-golden-'));
  const saved = { data: process.env.SCROLLS_DATA, noAuto: process.env.SCROLLS_NO_AUTO_IMPORT, log: process.env.SCROLLS_LOG_LEVEL };
  process.env.SCROLLS_DATA = dir;
  process.env.SCROLLS_NO_AUTO_IMPORT = '1';
  process.env.SCROLLS_LOG_LEVEL = 'error';
  try {
    return await fn(dir);
  } finally {
    for (const [k, v] of [['SCROLLS_DATA', saved.data], ['SCROLLS_NO_AUTO_IMPORT', saved.noAuto], ['SCROLLS_LOG_LEVEL', saved.log]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A fresh reference database (migrate + seedVocab + the file adapters), as tests/helpers/tmpdata.mjs makes it. */
async function freshDb(dir) {
  const { ensureDirs, paths } = await import('../../server/config.mjs');
  const { openDb } = await import('../../server/db/open.mjs');
  const { migrate } = await import('../../server/db/migrate.mjs');
  const { seedVocab } = await import('../../server/db/seed-vocab.mjs');
  const { registerFileAdapters } = await import('../../tests/helpers/tmpdata.mjs');
  ensureDirs();
  const db = openDb({ path: paths().db });
  migrate(db);
  seedVocab(db);
  registerFileAdapters(db);
  return db;
}

/** The dump of `db` as G2 cases: every line and every table digest (tables in `privateTables` go to `privateRows`). */
function dumpCases(db, dir, { privateTables = [] } = {}) {
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
  const out = join(dir, 'dump');
  const digest = dump(db, spec, out, {});
  const cases = [], privateRows = [];
  for (const table of Object.keys(digest).sort()) {
    const d = digest[table];
    cases.push({ kind: 'digest', table, ...d });
    if (d.skipped) continue;
    const text = readFileSync(join(out, `${table}.jsonl`), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    for (const line of lines) (privateTables.includes(table) ? privateRows : cases).push({ kind: 'row', table, line });
  }
  return { cases, privateRows };
}

// ── g2.mini ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function g2Mini() {
  return withTmpData(async (dir) => {
    const { loadMini, miniDocuments } = await import('../../tests/helpers/tmpdata.mjs');
    const db = await freshDb(dir);
    const docs = miniDocuments();
    loadMini(db, { docs });
    const { cases } = dumpCases(db, dir);
    db.close();
    return [
      { kind: 'setup', now: NOW.toISOString(), corpus: { slug: 'test', name: 'Test fixtures (synthetic)', kind: 'synthetic',
        is_synthetic: 1, description: 'Invented test documents', license: 'CC0 (synthetic)' },
      collection: { slug: 'mini', name: 'Mini test corpus (synthetic)', corpus: 'test', adapter_id: 'file.jsonl', domain: 'imported',
        modality: 'text', unit: 'tokens', sampling: 'user', coverage_gate: 2000, selection_note: 'invented test documents' },
      batch: { format: 'jsonl', file_name: 'documents.jsonl' }, writer: { corpus: 'test' } },
      ...docs.map((doc, i) => ({ kind: 'input', type: 'document', line: i + 1, doc })),
      ...cases,
    ];
  });
}

// ── g2.demo ───────────────────────────────────────────────────────────────────────────────────────────────────────

let demoCache = null;
async function g2DemoAll() {
  if (demoCache) return demoCache;
  demoCache = await withTmpData(async (dir) => {
    const demo = await import('../../server/adapters/demo/demo.mjs');
    const { createBatch, createDocumentWriter, ensureCollection } = await import('../../server/store/document-writer.mjs');
    const { stmt } = await import('../../server/db/open.mjs');
    const db = await freshDb(dir);
    stmt(db, `INSERT INTO source_adapter (id, version, label, access, enabled, license, attribution) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).run(demo.id, demo.version, demo.label, demo.access, 1, demo.license, demo.attribution);
    const spec = { ...demo.collections[0], corpus: 'demo', adapter_id: demo.id };
    const coll = ensureCollection(db, spec);
    const batchId = createBatch(db, { collection: coll.id, adapterId: demo.id, adapterVersion: demo.version, format: 'adapter' });
    const writer = createDocumentWriter(db, { batchId, collection: coll.slug, corpus: 'demo', options: { now: NOW } });
    const inputs = [];
    let line = 0;
    for await (const doc of demo.documents({}, {})) {
      line++;
      inputs.push({ kind: 'input', type: 'document', line, doc });
      writer.addDocument(doc, { line });
    }
    for await (const rel of demo.relationships({}, {})) {
      inputs.push({ kind: 'input', type: 'relationship', rel });
      writer.addRelationship(rel);
    }
    for await (const ann of demo.annotations({}, {})) {
      inputs.push({ kind: 'input', type: 'annotation', ann });
      writer.addAnnotation(ann);
    }
    const counts = writer.finish();
    const { cases, privateRows } = dumpCases(db, dir, { privateTables: ['passage_fts'] });
    db.close();
    const setup = { kind: 'setup', now: NOW.toISOString(), adapter: { id: demo.id, version: demo.version, label: demo.label,
      access: demo.access, enabled: 1, license: demo.license, attribution: demo.attribution }, collection: spec,
    batch: { adapter_id: demo.id, adapter_version: demo.version, format: 'adapter' }, writer: { corpus: 'demo' }, counts };
    return { cases: [setup, ...inputs, ...cases], privateRows };
  });
  return demoCache;
}

// ── g1.segment ────────────────────────────────────────────────────────────────────────────────────────────────────

const compact = (ps) => ps.map((p) => [p.start, p.end, p.unit, p.page_no, p.quality, p.time_role, p.field_class, p.token_count]);

function words(n, seed) {
  const r = mulberry32(seed);
  const vocab = ['the', 'zero', 'holds', 'place', 'carry', 'ledger', 'clerk', 'sum', 'margin', 'ghost', 'count', 'line', 'kiln',
    'eye', 'Quellhaven', 'fire', 'promise', 'shop', 'mark', 'ring', 'शून्य', 'શૂન્ય', 'cero', 'zéro', '◉', '42', '1894'];
  return Array.from({ length: n }, () => vocab[Math.floor(r() * vocab.length)]);
}

function sentences(n, per, seed, end = '.') {
  const w = words(n, seed);
  const out = [];
  for (let i = 0; i < w.length; i += per) {
    const s = w.slice(i, i + per).join(' ');
    out.push(`${s[0].toUpperCase()}${s.slice(1)}${end}`);
  }
  return out.join(' ');
}

/** Hand-written edge texts: every rule of seg-1 (blocks, furniture, headings, verse, long splits, merges, pages). */
function edgeTexts() {
  const verse = Array.from({ length: 20 }, (_, i) => `the ${i} line of a short song`).join('\n');
  const long = sentences(450, 9, 7);
  const longDanda = Array.from({ length: 40 }, (_, i) => `शून्य ${i} का अंक है और गिनती चलती है।`).join(' ');
  const paged = Array.from({ length: 7 }, (_, p) => `THE RUNNING HEAD\n\n${sentences(60, 12, 100 + p)}\n\n${p + 1}`).join('\f');
  const cases = [
    { name: 'empty', text: '' },
    { name: 'spaces', text: '   \n\n  ' },
    { name: 'one word', text: 'Zero' },
    { name: 'short blocks merge', text: 'One two three.\n\nFour five.\n\nSix seven eight nine ten eleven twelve thirteen.\n\nEnd.' },
    { name: 'heading then prose', text: `Chapter IV\n\n${sentences(80, 10, 3)}\n\nTHE END` },
    { name: 'roman headings', text: `I.\n\n${sentences(30, 10, 4)}\n\nII\n\n${sentences(30, 10, 5)}\n\nChapitre XII\n\nCapítulo iv\n\nscène iii` },
    { name: 'illustration', text: `[Illustration: the kiln at night]\n\n${sentences(40, 10, 6)}\n\n[Fig. 3]\n\n[Ilustración]\n\n[figures]` },
    { name: 'digits and short', text: `12\n\n${sentences(20, 10, 8)}\n\n— 7 —\n\nab\n\n...\n\n${sentences(20, 10, 9)}` },
    { name: 'all caps', text: `THE KILN STREET RULES\n\n${sentences(25, 10, 10)}\n\nÉTÉ À QUELLHAVEN\n\nΟΔΟΣ ΣΑΣ\n\nA B` },
    { name: 'verse', text: verse },
    { name: 'verse 5 lines', text: 'a\nbb\nccc\ndddd\neeeee and more words here' },
    { name: 'prose long', text: long },
    { name: 'prose long no sentences', text: words(520, 11).join(' ') },
    { name: 'long danda', text: longDanda },
    { name: 'long with quotes', text: sentences(300, 15, 12, '.”') + ' ' + sentences(100, 8, 13, '!') },
    { name: 'crlf', text: `Line one of a block.\r\nLine two of the block.\r\n\r\n${sentences(30, 10, 14)}\r\n` },
    { name: 'paged', text: paged },
    { name: 'paged short pages', text: '1\fTitle page\f\fiii\fThe first real page of text with words.\f2\fTHE END' },
    { name: 'trailing whitespace', text: `  ${sentences(15, 5, 15)}  \n\n\t${sentences(10, 5, 16)}\t\n` },
    { name: 'symbols', text: '◉ ◉ ◉\n\n◉ kiln eye ◉ pressed in the foot ◉\n\n☺' },
    { name: 'gujarati', text: 'શૂન્ય એ ગણિતનો આધાર છે। આ વાક્ય ગુજરાતીમાં છે॥\n\nબીજો ફકરો અહીં છે.' },
    { name: 'mixed headings', text: `Part 2\n\n${sentences(15, 5, 17)}\n\nA heading without stop\n\n${sentences(9, 9, 18)}\n\nShort.` },
    { name: 'merge stops at 200', text: Array.from({ length: 30 }, (_, i) => sentences(11, 11, 200 + i)).join('\n\n') },
    { name: 'zero width', text: 'kiln‍eye and soft­hyphen words\n\nmore' },
    { name: 'surrogates', text: `𝟘 𝔷𝔢𝔯𝔬 ${sentences(20, 10, 19)}\n\n😀 ${sentences(12, 6, 20)}` },
  ];
  return cases;
}

function regionCases() {
  const text = `PREFACE BY THE EDITOR\n\n${sentences(40, 10, 30)}\n\n${sentences(120, 12, 31)}\n\nNotes: ${sentences(30, 10, 32)}`;
  const n = text.length;
  const at = (s) => text.indexOf(s);
  const notes = at('Notes:');
  return [
    { name: 'regions apparatus', text, opts: { regions: [{ start: 0, end: at('\n\n', 30) + 0, quality: 'front_matter', time_role: 'apparatus' },
      { start: notes, end: n, field_class: 'describes' }] } },
    { name: 'regions overlap', text, opts: { regions: [{ start: 5, end: 300, quality: 'boilerplate' }, { start: 100, end: 600 },
      { start: 7, end: 9, field_class: 'apparatus' }] } },
    { name: 'regions inside tokens', text, opts: { regions: [{ start: 3, end: 17 }, { start: 255, end: 256, quality: 'low' }] } },
    { name: 'body bounds', text, opts: { start: 20, end: n - 40 } },
    { name: 'body bounds clamp', text, opts: { start: -5, end: n + 50 } },
    { name: 'mode prose', text: Array.from({ length: 8 }, (_, i) => `short ${i} line`).join('\n'), opts: { mode: 'prose' } },
    { name: 'mode verse', text: `${sentences(40, 10, 33)}\n${sentences(20, 10, 34)}`, opts: { mode: 'verse' } },
    { name: 'mode field', text: 'A title of a work', opts: { mode: 'field' } },
    { name: 'mode field region', text: 'A title of a work', opts: { mode: 'field', regions: [{ start: 0, end: 5, time_role: 'describes' }] } },
    { name: 'lang hi', text: sentences(300, 10, 35), opts: { lang: 'hi' } },
  ];
}

function fuzzTexts(n, seed) {
  const r = mulberry32(seed);
  const pieces = ['\n', '\n\n', '\f', ' ', '. ', '! ', '? ', '।', '॥', '"', '”', '[Illustration]', 'CHAPTER X', 'IV', '12', '—',
    '\r\n', '\t', 'é', 'Σ', '◉', '😀', 'word', 'zero', 'Kiln', 'the', 'ledger', 'શૂન્ય', 'शून्य', ',', ';', ':', '…'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = 1 + Math.floor(r() * 400);
    let s = '';
    for (let k = 0; k < len; k++) s += pieces[Math.floor(r() * pieces.length)] + (r() < 0.6 ? ' ' : '');
    out.push(s);
  }
  return out;
}

async function segmentCases(ctx) {
  const { segment } = await import('../../server/text/segment.mjs');
  const { miniDocuments } = await import('../../tests/helpers/tmpdata.mjs');
  const cases = [];
  const run = (source, text, opts = {}) => {
    const ps = segment(text, opts);
    cases.push({ source, text, opts, out: compact(ps) });
  };
  for (const c of edgeTexts()) run(`edge:${c.name}`, c.text);
  for (const c of regionCases()) run(`edge:${c.name}`, c.text, c.opts);
  fuzzTexts(400, 20261010).forEach((t, i) => run(`fuzz:${i}`, t, i % 7 === 0 ? { mode: 'verse' } : i % 11 === 0 ? { mode: 'prose' } : {}));
  for (const d of miniDocuments().filter((x) => x.text)) {
    const t = d.text;
    run(`mini:${d.ext_id}`, t.original, { mode: t.mode ?? 'auto', lang: d.lang_declared ?? null, regions: t.regions ?? [],
      start: t.body_start ?? 0, end: t.body_end ?? t.original.length });
  }
  const demo = await import('../../server/adapters/demo/demo.mjs');
  for await (const d of demo.documents({}, {})) {
    if (!d.text) continue;
    const t = d.text;
    run(`demo:${d.ext_id}`, t.original, { mode: t.mode ?? 'auto', lang: d.lang_declared ?? null, regions: t.regions ?? [],
      start: t.body_start ?? 0, end: t.body_end ?? t.original.length });
  }
  ctx.inputs = { edge: edgeTexts().length + regionCases().length, fuzz: 400, mini: 'tests/fixtures/mini', demo: 'data/demo' };
  return cases;
}

// ── snapshot inputs (books, passages) ─────────────────────────────────────────────────────────────────────────────

let snapshot = null;
function inputsDb(ctx) {
  if (snapshot) { ctx.inputs = snapshot.inputs; return snapshot; }
  const name = ctx.findSnapshot(INPUT_SNAPSHOTS);
  if (!name) return null;
  const clone = ctx.cloneSnapshot(name);
  process.once('exit', () => clone.cleanup());
  const db = new DatabaseSync(clone.db, { readOnly: true });
  const info = ctx.snapshotInfo(name);
  snapshot = { name, db, inputs: { snapshot: name, built_from: info?.built_from?.commit ?? null } };
  ctx.inputs = snapshot.inputs;
  return snapshot;
}

async function segmentBooks(ctx) {
  const { segment } = await import('../../server/text/segment.mjs');
  const snap = inputsDb(ctx);
  if (!snap) { ctx.log('g1.segment-books: no snapshot; empty'); return []; }
  const pick = (slug, n) => snap.db.prepare(`SELECT d.id, d.ext_id, d.lang_declared AS lang, c.slug FROM document d
      JOIN collection c ON c.id = d.collection_id JOIN document_text t ON t.document_id = d.id
      WHERE c.slug = ? AND c.export_text_allowed = 1 ORDER BY d.id`).all(slug)
    .filter((_, i, all) => i % Math.max(1, Math.floor(all.length / n)) === 0).slice(0, n);
  const books = [...pick('cipher-gutenberg', 30), ...pick('cipher-wikisource-hi', 5), ...pick('cipher-wikisource-gu', 5),
    ...pick('stemm-gutenberg', 10)];
  const textOf = snap.db.prepare('SELECT original, body_start, body_end FROM document_text WHERE document_id = ?');
  return books.map((b) => {
    const t = textOf.get(b.id);
    const opts = { lang: b.lang ?? null, start: t.body_start, end: t.body_end };
    return { source: `${snap.name}:${b.slug}:${b.ext_id}`, text_sha256: sha256Utf8(t.original), text: t.original, opts,
      out: compact(segment(t.original, opts)) };
  });
}

// ── g1.langid ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function langidCases(ctx) {
  const L = await import('../../server/text/langid.mjs');
  const cases = [];
  const detect = (source, text, declared) => {
    const tokens = tokenize(text).tokens;
    const script = L.scriptOf(text);
    const out = L.detectLangFromTokens(tokens, { declared, script });
    cases.push({ fn: 'detect', source, text, declared, script, out, scores_order: Object.keys(out.scores) });
  };
  const edges = ['', 'x', '12 34', 'The', 'the the the the the the the the', 'el la de que y en los del se las por un',
    'le la les des et en un une du que est pour', 'der die und in den von zu das mit sich des auf', 'शून्य', 'શૂન્ય',
    'शून्य शून्य abc', 'ΟΔΟΣ ΣΑΣ', '日本語のテキスト', 'Ünïcödé façade naïve café', 'et in et in et in et in',
    'que de que de que de que de', 'à la à la à la à la', 'the and the and of to in is it', '1894 1895 1896'];
  for (const t of edges) for (const declared of [null, 'en', 'hi', 'gu', 'sa', 'mr', 'EN', 'fr']) detect('edge', t, declared);
  const r = mulberry32(5150);
  const vocab = [...L.stopwords('en').slice(0, 80), ...L.stopwords('fr').slice(0, 80), ...L.stopwords('es').slice(0, 80),
    ...L.stopwords('la').slice(0, 40), 'zero', 'kiln', 'ledger', 'Quellhaven', 'शून्य', 'શૂન્ય'];
  for (let i = 0; i < 300; i++) {
    const n = 1 + Math.floor(r() * 60);
    const t = Array.from({ length: n }, () => vocab[Math.floor(r() * vocab.length)]).join(' ');
    detect('fuzz', t, [null, 'en', 'fr', 'es', 'hi'][Math.floor(r() * 5)]);
  }
  const snap = inputsDb(ctx);
  if (snap) {
    const rows = snap.db.prepare(`SELECT p.id, p.start_off, p.end_off, d.lang_declared AS lang, t.original FROM passage p
        JOIN document d ON d.id = p.document_id JOIN collection c ON c.id = d.collection_id
        JOIN document_text t ON t.document_id = d.id
        WHERE p.field = 'body' AND c.export_text_allowed = 1 AND p.id % 997 = 0 ORDER BY p.id LIMIT 1600`).all();
    for (const row of rows) detect(`${snap.name}:passage:${row.id}`, row.original.slice(row.start_off, row.end_off), row.lang);
  }
  // documentLang over synthetic passage lists (ties, und, translations, the 20-token floor)
  const langs = ['en', 'fr', 'es', 'hi', 'gu', 'und', 'und-Latn', 'la', 'de'];
  for (let i = 0; i < 400; i++) {
    const k = 1 + Math.floor(r() * 6);
    const passages = Array.from({ length: k }, () => ({ lang: langs[Math.floor(r() * langs.length)],
      tokens: [0, 1, 5, 10, 19, 20, 40, 100, -3][Math.floor(r() * 9)], confidence: [0, 0.3, 0.6, 0.9, 0.95, 1][Math.floor(r() * 6)] }));
    const declared = [null, 'en', 'fr', 'en-GB', 'hi', 'gu', 'und'][Math.floor(r() * 7)];
    const out = L.documentLang(passages, declared);
    cases.push({ fn: 'documentLang', passages, declared, out, by_lang_order: Object.keys(out.by_lang) });
  }
  return cases;
}

const fam = (run, opts = {}) => ({ run, owner: 'N1', ...opts });

export const families = {
  'g1.segment': fam(segmentCases, { note: 'edge, region and fuzz texts, the mini fixture and every demo document (synthetic)' }),
  'g1.segment-books': fam(segmentBooks, { private: true,
    note: 'the 50 books of g1.sentences-books (30 Cipher Gutenberg, 10 Wikisource hi/gu, 10 STEMM Gutenberg); text kept private (size)' }),
  'g1.langid': fam(langidCases, { note: 'edge and fuzz strings, 1,600 snapshot passages (export_text_allowed = 1), 400 documentLang lists' }),
  'g2.mini': fam(g2Mini, { note: 'tests/fixtures/mini through createDocumentWriter (tmpdata.mjs loadMini), then dump.mjs' }),
  'g2.demo': fam(async () => (await g2DemoAll()).cases, { note: 'data/demo documents, relationships and annotations through one writer; passage_fts rows in g2.demo-fts' }),
  'g2.demo-fts': fam(async () => (await g2DemoAll()).privateRows, { private: true, note: 'the passage_fts instance rows of g2.demo' }),
};
