// OWNER: WP3
// shelf.mjs — the UNDATED and SCHEDULED shelves and the list of washes (SPEC §1.7, §7.1 GET /api/timeline/shelf).
// Undated items never enter bins, rates or denominators; scheduled items (dated after today, basis
// 'announced') sit past the "today" line. Each item opens its first matching passage.

import { binOf, yearLabel } from '../../src/shared/dates.mjs';
import { decodeCursor, encodeCursor } from '../http/router.mjs';
import { HttpError } from '../http/errors.mjs';
import { stmt } from '../db/open.mjs';
import { laneKey } from './lanes.mjs';
import { countValue, laneWhere, memberRuns, srcCols, strandDocRows } from './query.mjs';
import { washesFor } from './washes.mjs';

const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
const WHICH = ['undated', 'scheduled', 'washes'];

function page(items, cursor, limit) {
  const c = decodeCursor(cursor);
  const offset = Number.isInteger(c?.o) && c.o >= 0 ? c.o : 0;
  const slice = items.slice(offset, offset + limit);
  return { items: slice, cursor: offset + limit < items.length ? encodeCursor({ o: offset + limit }) : null };
}

/** First counted passage of each document for an expression strand (or the title passage of a work). */
function firstPassages(db, strand, docIds) {
  const out = new Map();
  if (!docIds.length) return out;
  const rows = strand.type === 'expression'
    ? memberRuns(strand).flatMap(([expr, run]) => stmt(db, `SELECT o.document_id AS doc, MIN(o.passage_id) AS passage FROM occurrence o
        JOIN passage p ON p.id = o.passage_id
        WHERE o.expression_id = ? AND o.run_id = ? AND p.quality = 'ok' AND o.document_id IN (SELECT value FROM json_each(?))
        GROUP BY o.document_id`).all(expr, run, JSON.stringify(docIds)))
    : stmt(db, `SELECT document_id AS doc, MIN(id) AS passage FROM passage WHERE field_class = 'title'
        AND document_id IN (SELECT value FROM json_each(?)) GROUP BY document_id`).all(JSON.stringify(docIds));
  for (const r of rows) out.set(r.doc, r.passage);
  return out;
}

/**
 * GET /api/timeline/shelf. Read-query convention (§12.2): runs in the read pool via ctx.pool.run(moduleUrl,
 * 'shelfQuery', args).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{def: object, which?: string, lane?: string|null, tier?: string, cursor?: string|null, limit?: number}} args
 * @returns {{which: string, total: number, n_total: number, items: object[], cursor: string|null}}
 */
export function shelfQuery(db, { def, which = 'undated', lane = null, tier = 'L2', cursor = null, limit = 50 }) {
  if (!WHICH.includes(which)) throw new HttpError(400, 'E_VALIDATION', `which must be one of ${WHICH.join(', ')}.`, null, { field: 'which' });
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  if (which === 'washes') {
    if (!TIERS.includes(tier)) throw new HttpError(400, 'E_VALIDATION', `tier must be one of ${TIERS.join(', ')}.`, null, { field: 'tier' });
    const ext = stmt(db, `SELECT MIN(d.y_lo) AS lo, MAX(d.y_hi) AS hi, MIN(d.lo_day) AS dlo, MAX(d.hi_day) AS dhi FROM document d
      JOIN collection c ON c.id = d.collection_id WHERE c.corpus_id IN (SELECT value FROM json_each(?)) AND d.chrono_status = 'dated'
      AND d.deleted_at IS NULL`).get(JSON.stringify(def.corpusIds ?? [def.corpusId]));
    let items = [];
    if (ext.lo !== null) {
      const level = TIERS.indexOf(tier);
      const range = level <= 3 ? { b0: binOf(ext.lo, level), b1: binOf(ext.hi, level) }
        : level === 5 ? { b0: ext.dlo, b1: ext.dhi } : { b0: ext.lo * 12, b1: ext.hi * 12 + 11 };
      items = washesFor(db, def, tier, range).filter((w) => !lane || w.lane === lane)
        .map(({ bin_lo, bin_hi, ...w }) => ({ ...w, tier }));
    }
    const p = page(items, cursor, lim);
    return { which, tier, total: items.length, n_total: items.reduce((s, w) => s + w.n, 0), items: p.items, cursor: p.cursor };
  }

  const items = [];
  for (const strand of def.strands) {
    const extra = lane ? laneWhere(def, lane, srcCols(def)) : { sql: '1', params: [] };
    const rows = strandDocRows(db, def, strand, { where: `d.chrono_status = ? AND ${extra.sql}`, params: [which, ...extra.params] })
      .filter((r) => r.v > 0);
    const first = firstPassages(db, strand, [...new Set(rows.map((r) => r.doc))]);
    const raws = new Map(stmt(db, `SELECT subject_id AS doc, raw FROM date_assertion WHERE subject_type = 'document' AND is_chronology = 1
      AND subject_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(rows.map((r) => r.doc))).map((r) => [r.doc, r.raw]));
    for (const r of rows) {
      items.push({
        document_id: r.doc, passage: first.get(r.doc) ?? null, title: r.title ?? null, author: r.author ?? null, kind: r.kind,
        lane: laneKey(def.lanes.facet, r.lv, r.uc), strand: strand.type === 'expression' ? strand.ref : strand.key,
        n: countValue(r.uc, [r]),
        date: { label: r.date_label, precision: r.precision, basis: r.basis, raw: raws.get(r.doc) ?? null,
          ...(which === 'scheduled' ? { lo: yearLabel(r.y_lo), lo_day: r.lo_day, hi_day: r.hi_day } : {}) },
        synthetic: r.syn === 1,
      });
    }
  }
  if (which === 'scheduled') items.sort((a, b) => a.date.lo_day - b.date.lo_day || a.document_id - b.document_id);
  else items.sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? ''), 'en') || a.document_id - b.document_id);
  const p = page(items, cursor, lim);
  return { which, total: items.length, n_total: items.reduce((s, x) => s + x.n, 0), items: p.items, cursor: p.cursor };
}
