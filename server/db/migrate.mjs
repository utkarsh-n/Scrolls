// OWNER: WP0 — creates schema_version 1 by executing server/db/schema.sql verbatim (SPEC §3)

import { readFileSync } from 'node:fs';
import { TOKENIZER_VERSION } from '../../src/shared/tokenize.mjs';
import { SEGMENTER_VERSION } from '../text/segment.mjs';
import { translationReason } from '../adapters/stemm/translation.mjs';
import { generateVariants } from '../text/variants.mjs';
import { bumpDataVersion, getMeta, nowIso, setMeta, tx } from './open.mjs';

/** The schema version this code creates and understands. */
export const SCHEMA_VERSION = 1;
/** URL of the DDL file. */
export const SCHEMA_URL = new URL('./schema.sql', import.meta.url);

/** @returns {string} the DDL, exactly as on disk */
export function schemaSql() {
  return readFileSync(SCHEMA_URL, 'utf8');
}

function currentVersion(db) {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) {
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
    if (tables > 0) {
      const err = new Error('The database has tables but no meta table: it is not a Scrolls database.');
      err.code = 'E_DB_FOREIGN';
      throw err;
    }
    return 0;
  }
  return Number(getMeta(db, 'schema_version') ?? 0);
}

/**
 * Bring a database to SCHEMA_VERSION. A fresh database gets schema.sql executed verbatim plus the meta
 * rows (schema_version, data_version, tokenizer/segmenter/ICU versions, created_at); a current one is left
 * unchanged.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{from:number, to:number, repaired?: {hypothesis_targets: number}}} `repaired` when a data repair ran
 * @throws {Error} E_SCHEMA_NEWER when the file was written by a newer Scrolls; E_DB_FOREIGN for a non-Scrolls DB
 */
export function migrate(db) {
  const from = currentVersion(db);
  if (from > SCHEMA_VERSION) {
    const err = new Error(`Database schema_version ${from} is newer than this Scrolls (${SCHEMA_VERSION}).`);
    err.code = 'E_SCHEMA_NEWER';
    throw err;
  }
  if (from === SCHEMA_VERSION) {
    const repaired = repairData(db);
    return Object.values(repaired).some(Boolean) ? { from, to: SCHEMA_VERSION, repaired } : { from, to: SCHEMA_VERSION };
  }
  // PRAGMA journal_mode cannot change inside a transaction, so the DDL runs as written, outside one; a
  // failure here leaves a fresh (empty) database that the next start recreates.
  db.exec(schemaSql());
  tx(db, () => {
    setMeta(db, 'schema_version', SCHEMA_VERSION);
    setMeta(db, 'data_version', 0);
    setMeta(db, 'tokenizer_version', TOKENIZER_VERSION);
    setMeta(db, 'segmenter_version', SEGMENTER_VERSION);
    setMeta(db, 'icu_version', process.versions.icu ?? 'none');
    setMeta(db, 'created_at', nowIso());
  });
  return { from, to: SCHEMA_VERSION };
}

/**
 * Idempotent data repairs applied at every boot (no schema change; each is a no-op once applied).
 *
 * M5 gate: DocumentWriter ≤ contract 1.1.0 set a hypothesis group's target to the first hypothesis's dst. The target
 * is the item whose source is asked about — the src every hypothesis starts from (§2.C), which POST
 * /api/relationships requires. A group whose hypotheses all start at one item, and whose target is the dst of one of
 * them, is re-targeted at that item.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{hypothesis_targets: number, variant_defaults: number, stemm_translations: number}} rows repaired
 */
export function repairData(db) {
  const bad = db.prepare(`SELECT g.id, min(r.src_type) AS st, min(r.src_ref) AS sr FROM hypothesis_group g
    JOIN relationship r ON r.hypothesis_group_id = g.id GROUP BY g.id
    HAVING count(DISTINCT r.src_type || ':' || r.src_ref) = 1
      AND sum(r.dst_type = g.target_type AND r.dst_ref = g.target_ref) > 0
      AND NOT (min(r.src_type) = g.target_type AND min(r.src_ref) = g.target_ref)`).all();
  if (bad.length) {
    tx(db, () => {
      const up = db.prepare('UPDATE hypothesis_group SET target_type = ?, target_ref = ? WHERE id = ?');
      for (const g of bad) up.run(g.st, g.sr, g.id);
    });
  }
  return { hypothesis_targets: bad.length, variant_defaults: variantDefaults(db), stemm_translations: stemmTranslations(db) };
}

/**
 * Lead fix after the final round: gutenberg-stemm loads before it marked no translations, because the text of Bostock's
 * Pliny or Hoover's Agricola really is English, so language identification passes it. Their chronology was the original
 * author's life (44–79 CE for English "virus"). Rows the catalogue shows to be translations or later adaptations
 * (translationReason) are now flagged as the writer flags them (D8): is_translation = 1 and the chronology date
 * re-roled original_publication. quality_version and data_version move so every cached slice is rebuilt. Idempotent.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number} documents flagged
 */
function stemmTranslations(db) {
  const rows = db.prepare(`SELECT d.id, d.original_meta_json AS meta FROM document d JOIN collection c ON c.id = d.collection_id
    WHERE c.slug IN ('stemm-gutenberg', 'stemm-gutenberg-restricted') AND d.is_translation = 0 AND d.deleted_at IS NULL`).all();
  const hits = [];
  for (const r of rows) {
    let meta;
    try { meta = JSON.parse(r.meta); } catch { continue; }
    const reason = translationReason(meta);
    if (reason) hits.push([r.id, reason]);
  }
  if (hits.length) {
    tx(db, () => {
      const doc = db.prepare(`UPDATE document SET is_translation = 1,
        date_role = CASE WHEN date_role = 'publication' THEN 'original_publication' ELSE date_role END WHERE id = ?`);
      const date = db.prepare(`UPDATE date_assertion SET role = 'original_publication',
        note = CASE WHEN note IS NULL THEN ? ELSE note || '; ' || ? END
        WHERE subject_type = 'document' AND subject_id = ? AND is_chronology = 1 AND role = 'publication'`);
      for (const [id, reason] of hits) {
        const note = `role set to original_publication: ${reason}`;
        doc.run(id);
        date.run(note, note, id);
      }
      setMeta(db, 'quality_version', String(Number(getMeta(db, 'quality_version') ?? 0) + 1));
      bumpDataVersion(db);
    });
  }
  return hits.length;
}

/**
 * Fix pass: English -er/-ers forms are now generated off by default ('gene' → 'gener' is no word; 'hack' → 'hacker' is
 * another word). Expressions tracked before had them on — by default, since no generated form was ever off before, so
 * none of these was switched on by a reader. They are switched off once; the expression is counted again on its next use
 * (its enabled variant set changed). Idempotent.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number} variants switched off
 */
function variantDefaults(db) {
  const off = [];
  const q = db.prepare(`SELECT id, norm FROM expression_variant WHERE expression_id = ? AND rule = 'en-inflect@1' AND enabled = 1
    AND IFNULL(lang, 'en') = 'en'`);
  for (const e of db.prepare("SELECT id, surface FROM expression WHERE lang = 'en'").all()) {
    const now = new Set(generateVariants(e.surface, { lang: 'en' }).filter((v) => v.enabled === false && v.rule === 'en-inflect@1').map((v) => v.norm));
    if (!now.size) continue;
    for (const v of q.all(e.id)) if (now.has(v.norm)) off.push(v.id);
  }
  if (off.length) {
    tx(db, () => {
      const up = db.prepare('UPDATE expression_variant SET enabled = 0 WHERE id = ?');
      for (const id of off) up.run(id);
    });
  }
  return off.length;
}
