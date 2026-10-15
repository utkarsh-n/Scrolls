// OWNER: WP0 — adapter id → module, and source_adapter rows (SPEC §6.2, §10.1, §10.2)

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log } from '../config.mjs';
import { stmt, tx } from '../db/open.mjs';
import { adapterOf, validateAdapter } from './api.mjs';

/** Every source adapter id (§6.2 Cipher, §10.2 STEMM, the demo) → module path relative to this file. */
export const ADAPTER_MODULES = Object.freeze({
  'cipher.books': './cipher/books.mjs',
  'cipher.wikisource': './cipher/wikisource.mjs',
  'cipher.works': './cipher/works.mjs',
  'cipher.relations': './cipher/relations.mjs',
  'cipher.roots': './cipher/roots.mjs',
  'cipher.themes': './cipher/themes.mjs',
  'stemm.gutenberg-stemm': './stemm/gutenberg-stemm.mjs',
  'stemm.openalex': './stemm/openalex.mjs',
  'stemm.wiktionary': './stemm/wiktionary.mjs',
  'stemm.ngram': './stemm/ngram.mjs',
  demo: './demo/demo.mjs',
});

/**
 * File importers (WP1) have no adapter module but need source_adapter rows: every import_batch and
 * collection references one.
 */
export const FILE_ADAPTERS = Object.freeze(['txt', 'md', 'csv', 'tsv', 'json', 'jsonl'].map((f) => Object.freeze({
  id: `file.${f}`, version: '1.0.0', label: `${f.toUpperCase()} file import`, access: 'local-file',
  license: 'as declared by the importer', attribution: '',
})));

/**
 * Load and validate an adapter.
 * @param {string} id
 * @returns {Promise<import('./api.mjs').SourceAdapter>}
 * @throws {Error} E_ADAPTER_UNKNOWN / E_ADAPTER_MISSING / E_ADAPTER_INVALID
 */
export async function loadAdapter(id) {
  const rel = ADAPTER_MODULES[id];
  if (!rel) throw Object.assign(new Error(`Unknown adapter '${id}'.`), { code: 'E_ADAPTER_UNKNOWN' });
  const url = new URL(rel, import.meta.url);
  if (!existsSync(fileURLToPath(url))) throw Object.assign(new Error(`Adapter '${id}' is not installed (${rel}).`), { code: 'E_ADAPTER_MISSING' });
  const mod = await import(url.href);
  const errs = validateAdapter(mod);
  if (errs.length) throw Object.assign(new Error(`Adapter '${id}' is invalid: ${errs.join('; ')}`), { code: 'E_ADAPTER_INVALID', detail: errs });
  const adapter = adapterOf(mod);
  if (adapter.id !== id) throw Object.assign(new Error(`Adapter module ${rel} declares id '${adapter.id}', expected '${id}'.`), { code: 'E_ADAPTER_INVALID' });
  return adapter;
}

function upsert(db, a) {
  // enabled/approved_at/config_json are the user's choices and survive re-registration; a network adapter
  // starts disabled until the user approves it (CHECK on source_adapter).
  stmt(db, `INSERT INTO source_adapter (id, version, label, access, enabled, license, attribution)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, label = excluded.label, access = excluded.access,
      license = excluded.license, attribution = excluded.attribution`)
    .run(a.id, a.version, a.label, a.access, a.access === 'network' ? 0 : 1, a.license ?? null, a.attribution ?? null);
}

/**
 * Upsert source_adapter rows: the file importers, then every adapter module that loads and validates. A
 * missing or invalid module is logged and skipped (its package may not have landed yet).
 * Async because adapter modules are ES modules (dynamic import); callers await it at boot.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Promise<{registered: string[], skipped: Array<{id: string, reason: string}>}>}
 */
export async function registerAdapters(db) {
  const loaded = [];
  const skipped = [];
  for (const id of Object.keys(ADAPTER_MODULES)) {
    try {
      loaded.push(await loadAdapter(id));
    } catch (err) {
      skipped.push({ id, reason: err.message });
      log(err.code === 'E_ADAPTER_MISSING' ? 'debug' : 'warn', `adapter ${id} not registered: ${err.message}`);
    }
  }
  tx(db, () => {
    for (const a of FILE_ADAPTERS) upsert(db, a);
    for (const a of loaded) upsert(db, a);
  });
  return { registered: [...FILE_ADAPTERS.map((a) => a.id), ...loaded.map((a) => a.id)], skipped };
}
