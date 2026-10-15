// OWNER: WP0 — temporary data directories for tests: fresh SCROLLS_DATA, migrated, seeded with the mini corpus (SPEC §11)
//
// Never touches the real data directory: every call makes a new folder under the OS temp dir (outside
// iCloud) and points SCROLLS_DATA at it until cleanup().

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureDirs, paths } from '../../server/config.mjs';
import { migrate } from '../../server/db/migrate.mjs';
import { nowIso, openDb } from '../../server/db/open.mjs';
import { seedVocab } from '../../server/db/seed-vocab.mjs';
import { FILE_ADAPTERS } from '../../server/adapters/registry.mjs';
import { createBatch, createDocumentWriter, ensureCollection } from '../../server/store/document-writer.mjs';

const MINI_DIR = new URL('../fixtures/mini/', import.meta.url);

/** The 12 CanonicalDocument records of tests/fixtures/mini/documents.jsonl. @returns {object[]} */
export function miniDocuments() {
  return readFileSync(new URL('documents.jsonl', MINI_DIR), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** tests/fixtures/mini/expected.json. @returns {object} */
export function miniExpected() {
  return JSON.parse(readFileSync(new URL('expected.json', MINI_DIR), 'utf8'));
}

/** Insert the file-importer source_adapter rows (what registerAdapters does, without loading modules). */
export function registerFileAdapters(db) {
  const ins = db.prepare(`INSERT INTO source_adapter (id, version, label, access, license, attribution)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
  for (const a of FILE_ADAPTERS) ins.run(a.id, a.version, a.label, a.access, a.license, a.attribution);
}

/**
 * A synthetic 'test' corpus and its 'mini' collection: the fixture texts are invented, so they are labelled
 * synthetic like every invented row (honesty rule 1), and kept apart from the demo corpus.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object} the collection row
 */
export function ensureMiniCollection(db, slug = 'mini') {
  db.prepare(`INSERT INTO corpus (slug, name, kind, is_synthetic, description, license, created_at)
    VALUES ('test', 'Test fixtures (synthetic)', 'synthetic', 1, 'Invented test documents', 'CC0 (synthetic)', ?)
    ON CONFLICT(slug) DO NOTHING`).run(nowIso());
  return ensureCollection(db, { slug, name: 'Mini test corpus (synthetic)', corpus: 'test', adapter_id: 'file.jsonl',
    domain: 'imported', modality: 'text', unit: 'tokens', sampling: 'user', coverage_gate: 2000,
    selection_note: 'invented test documents' });
}

/**
 * Write the mini corpus through DocumentWriter.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{docs?: object[], options?: object, slug?: string}} [opts]
 * @returns {{counts: object, ids: Map<string, number>, results: Array<{documentId: number|null, issues: object[]}>, batchId: number}}
 */
export function loadMini(db, { docs = miniDocuments(), options = {}, slug = 'mini' } = {}) {
  const coll = ensureMiniCollection(db, slug);
  const batchId = createBatch(db, { collection: coll.id, format: 'jsonl', fileName: 'documents.jsonl' });
  const writer = createDocumentWriter(db, { batchId, collection: coll.slug, corpus: 'test',
    options: { now: new Date('2026-10-04T12:00:00Z'), ...options } });
  const results = docs.map((d, i) => writer.addDocument(d, { line: i + 1 }));
  const counts = writer.finish();
  const ids = new Map(docs.map((d, i) => [d.ext_id, results[i].documentId]));
  return { counts, ids, results, batchId };
}

/**
 * Make a fresh data directory, set SCROLLS_DATA (and SCROLLS_NO_AUTO_IMPORT=1) to it, migrate, seed the
 * vocabularies and (by default) the mini corpus.
 * @param {{seed?: boolean, open?: boolean}} [opts]
 * @returns {{dir: string, dbPath: string, db: import('node:sqlite').DatabaseSync|null, mini: ReturnType<typeof loadMini>|null,
 *   cleanup(): void}}
 */
export function makeTmpData({ seed = true, open = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'scrolls-test-'));
  const saved = { data: process.env.SCROLLS_DATA, noAuto: process.env.SCROLLS_NO_AUTO_IMPORT };
  process.env.SCROLLS_DATA = dir;
  process.env.SCROLLS_NO_AUTO_IMPORT = '1';
  ensureDirs();
  const dbPath = paths().db;
  let db = openDb({ path: dbPath });
  migrate(db);
  seedVocab(db);
  registerFileAdapters(db);
  const mini = seed ? loadMini(db) : null;
  if (!open) { db.close(); db = null; }
  return {
    dir, dbPath, db, mini,
    cleanup() {
      try { if (db?.isOpen) db.close(); } catch { /* already closed */ }
      if (saved.data === undefined) delete process.env.SCROLLS_DATA; else process.env.SCROLLS_DATA = saved.data;
      if (saved.noAuto === undefined) delete process.env.SCROLLS_NO_AUTO_IMPORT; else process.env.SCROLLS_NO_AUTO_IMPORT = saved.noAuto;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── query functions for read-pool tests (signature: fn(db, args) → plain JSON) ───────────────────────

/** Count rows of a whitelisted table. */
export function countQuery(db, { table = 'document' } = {}) {
  if (!['document', 'passage', 'meta', 'job'].includes(table)) throw new Error('table not allowed');
  return { table, n: db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n };
}

/** Busy-loop for `ms` milliseconds inside SQLite-free JS (simulates a runaway query). */
export function spinQuery(db, { ms = 10000 } = {}) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x++;
  return { spun: x };
}

/** Throw an HttpError-like error. */
export function failQuery() {
  throw Object.assign(new Error('the slice is empty'), { status: 422, code: 'E_TEST', hint: 'widen it', detail: { a: 1 } });
}
