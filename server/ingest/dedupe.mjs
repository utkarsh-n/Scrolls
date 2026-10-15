// OWNER: WP1
// dedupe.mjs — duplicate detection for the import preview, the dry run and the commit (SPEC §5.4).
//
// 1. same file already committed to the collection → E_DUP_FILE (whole import refused);
// 2. same ext_id twice in one import → the second row is rejected, E_DUP_ID citing both lines; an ext_id
//    that already exists in the collection (an earlier import, reverted ones included: their rows are only
//    soft-deleted) → E_DUP_ID;
// 3.–5. same body, near-same body and same metadata are flagged by DocumentWriter at commit and projected
//    by validate.mjs in the dry run (this file supplies the in-memory near-duplicate index for that).

import { minhashJaccard } from '../store/document-writer.mjs';

const BANDS = 16;
const ROWS = 8;
/** Whole-document MinHash Jaccard at or above which two texts are near-duplicates (§5.4). */
export const NEAR_DUP_JACCARD = 0.9;

/**
 * The committed batch that already imported this file into the collection, or null.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{collectionSlug: string, sha256: string, exceptBatch?: number|null}} q
 * @returns {{batch: number, committed_at: string|null, file_name: string|null}|null}
 */
export function committedBatchForFile(db, { collectionSlug, sha256, exceptBatch = null }) {
  const r = db.prepare(`SELECT b.id, b.committed_at, b.file_name FROM import_batch b JOIN collection c ON c.id = b.collection_id
    WHERE c.slug = ? AND b.file_sha256 = ? AND b.status = 'committed' AND b.id IS NOT ? ORDER BY b.id LIMIT 1`).get(collectionSlug, sha256, exceptBatch);
  return r ? { batch: r.id, committed_at: r.committed_at, file_name: r.file_name } : null;
}

/** E_DUP_FILE issue (fatal) for a file already committed to the collection. */
export function dupFileIssue(found, collectionSlug) {
  const date = String(found.committed_at ?? '').slice(0, 10) || 'an earlier date';
  return { code: 'E_DUP_FILE', severity: 'fatal', line: null, col: null, field: null, value_excerpt: found.file_name ?? null,
    message: `Already imported on ${date} as batch ${found.batch}.`,
    suggestion: `Open batch ${found.batch} instead, import a changed file, or import into a collection other than '${collectionSlug}'.` };
}

/**
 * Tracks ext_ids within one import and checks them against the collection.
 * @param {import('node:sqlite').DatabaseSync|null} db
 * @param {{collectionSlug: string|null}} opts
 * @returns {{check(extId: string, line: number|null): object|null, accept(extId: string, line: number|null): void, has(extId: string): boolean}}
 */
export function createIdTracker(db, { collectionSlug }) {
  const seen = new Map();
  const coll = db && collectionSlug ? db.prepare('SELECT id FROM collection WHERE slug = ?').get(collectionSlug) : null;
  const existing = coll ? db.prepare('SELECT d.id, d.deleted_at, d.import_batch_id FROM document d WHERE d.collection_id = ? AND d.ext_id = ?') : null;
  return {
    check(extId, line) {
      if (seen.has(extId)) {
        const first = seen.get(extId);
        return { code: 'E_DUP_ID', severity: 'rejected', line, col: null, field: 'ext_id', value_excerpt: extId,
          message: `Row ${line ?? '?'} repeats id '${extId}' first seen on line ${first ?? '?'}.`,
          suggestion: 'Give every record a unique id; the repeated row was skipped (the first one is kept).' };
      }
      const e = existing?.get(coll.id, extId);
      if (e) {
        const reverted = e.deleted_at ? ', since reverted' : '';
        return { code: 'E_DUP_ID', severity: 'rejected', line, col: null, field: 'ext_id', value_excerpt: extId,
          message: `Row ${line ?? '?'} id '${extId}' already exists in collection '${collectionSlug}' (import batch ${e.import_batch_id}${reverted}).`,
          suggestion: e.deleted_at ? 'Import into a new collection: reverted documents keep their ids.'
            : 'Import changed records into a new collection, or revert the earlier import first and use a new collection.' };
      }
      return null;
    },
    accept(extId, line) { seen.set(extId, line ?? null); },
    has(extId) { return seen.has(extId); },
  };
}

function bandKeys(sig) {
  const keys = new Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    let h = 0x811c9dc5;
    for (let r = 0; r < ROWS; r++) h = Math.imul(h ^ sig[b * ROWS + r], 0x01000193);
    keys[b] = `${b}:${(h >>> 0).toString(36)}`;
  }
  return keys;
}

/**
 * In-memory LSH index of MinHash signatures (16 bands × 8 rows over 128 permutations).
 * @returns {{add(id: unknown, sig: Uint32Array): void, query(sig: Uint32Array): {id: unknown, j: number}|null, size(): number}}
 */
export function createNearDupIndex() {
  const buckets = new Map();
  const sigs = new Map();
  return {
    add(id, sig) {
      sigs.set(id, sig);
      for (const k of bandKeys(sig)) {
        const list = buckets.get(k);
        if (list) list.push(id); else buckets.set(k, [id]);
      }
    },
    query(sig) {
      const seen = new Set();
      let best = null;
      for (const k of bandKeys(sig)) {
        for (const id of buckets.get(k) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const j = minhashJaccard(sig, sigs.get(id));
          if (j >= NEAR_DUP_JACCARD && (!best || j > best.j)) best = { id, j };
        }
      }
      return best;
    },
    size() { return sigs.size; },
  };
}

/**
 * Exact duplicates among records held in memory (the preview's sample): repeated ids and repeated texts.
 * @param {Array<{line: number|null, extId?: string|null, text?: string|null}>} records
 * @param {{mode?: 'flag'|'skip'|'off'}} [opts]
 * @returns {Array<{kind: 'id'|'text', line: number|null, first_line: number|null, value: string}>}
 */
export function findDuplicates(records, { mode = 'flag' } = {}) {
  if (mode === 'off') return [];
  const ids = new Map(), texts = new Map();
  const out = [];
  for (const r of records) {
    if (r.extId) {
      if (ids.has(r.extId)) out.push({ kind: 'id', line: r.line ?? null, first_line: ids.get(r.extId), value: r.extId });
      else ids.set(r.extId, r.line ?? null);
    }
    const t = typeof r.text === 'string' ? r.text.trim().replace(/\s+/g, ' ') : '';
    if (t.length >= 20) {
      if (texts.has(t)) out.push({ kind: 'text', line: r.line ?? null, first_line: texts.get(t), value: t.slice(0, 80) });
      else texts.set(t, r.line ?? null);
    }
  }
  return out;
}
