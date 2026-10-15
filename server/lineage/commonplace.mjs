// OWNER: WP5
// commonplace.mjs — the "widely shared text (n documents)" node (SPEC §2.C, §4.7). The boilerplate pass finds
// widespread fingerprint groups (> 25 documents) that are not boilerplate — Bible verses, proverbs, set phrases —
// and records, per passage made mostly of them, the most widely shared group. Lineage collapses such text into
// one node instead of drawing n² quotation edges; the reuse index never pairs groups of more than 25 documents.
// The record is a derived file per pass scope (derived/reuse/commonplace-<scope>.json), rewritten by every
// boilerplate pass over that scope; readers merge the files.

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { slugify } from '../../src/shared/ids.mjs';
import { paths } from '../config.mjs';
import { HttpError } from '../http/errors.mjs';

const PREFIX = 'commonplace-';
const scopeKey = (collections) => (collections && collections.length ? slugify([...collections].map(String).sort().join('+'), 80) : 'all');
const cache = new Map(); // file → { mtimeMs, data }

/**
 * Store the commonplace record of a boilerplate pass (atomic replace).
 * @param {{run: number|null, collections: string[]|null, at: string, passages: Record<string, {key: string, docs: number}>,
 *   groups: Record<string, {docs: number, passages: number[]}>}} record
 */
export function writeCommonplaces(record) {
  const dir = paths().reuse;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${PREFIX}${scopeKey(record.collections)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, file);
}

/** Every pass record, merged (later passes over the same passages win). */
function load() {
  const dir = paths().reuse;
  let files;
  try { files = readdirSync(dir).filter((f) => f.startsWith(PREFIX) && f.endsWith('.json')).sort(); } catch { return null; }
  if (!files.length) return null;
  const merged = { passages: {}, groups: {}, runs: [] };
  for (const f of files) {
    const file = path.join(dir, f);
    let st;
    try { st = statSync(file); } catch { continue; }
    let entry = cache.get(file);
    if (!entry || entry.mtimeMs !== st.mtimeMs) {
      try { entry = { mtimeMs: st.mtimeMs, data: JSON.parse(readFileSync(file, 'utf8')) }; } catch { continue; }
      cache.set(file, entry);
    }
    Object.assign(merged.passages, entry.data.passages);
    Object.assign(merged.groups, entry.data.groups);
    merged.runs.push(entry.data.run ?? null);
  }
  return merged;
}

/**
 * Commonplace groups of passages (those made mostly of text shared by > 25 documents).
 * @param {number[]} passageIds
 * @returns {Map<number, {key: string, docs: number}>}
 */
export function commonplaceFor(passageIds) {
  const data = load();
  const out = new Map();
  if (!data) return out;
  for (const id of passageIds) {
    const cp = data.passages?.[id];
    if (cp) out.set(id, cp);
  }
  return out;
}

/**
 * The collapsed node for a widespread non-boilerplate group.
 * @param {import('node:sqlite').DatabaseSync|null} db unused (the record is a derived file)
 * @param {string} groupKey 8 hex digits
 * @returns {{id: string, type: 'commonplace', label: string, documents: number, passages: number[], runs: Array<number|null>}}
 */
export function commonplaceNode(db, groupKey) {
  const data = load();
  const g = data?.groups?.[groupKey];
  if (!g) throw new HttpError(404, 'E_NOT_FOUND', `No widely shared text ${groupKey}.`, 'Run the boilerplate pass first.');
  return { id: `shared:${groupKey}`, type: 'commonplace', label: `widely shared text (${g.docs} documents)`, documents: g.docs,
    passages: g.passages, runs: data.runs };
}
