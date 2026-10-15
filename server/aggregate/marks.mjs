// OWNER: WP3
// marks.mjs — individual matches (SPEC §1.6 occurrence override, §7.1 GET /api/timeline/marks), each resolving
// to its passage (I2). Marks read the same slice as the tiles: Σ tile n per lane (bins + washes) = marks total
// over the whole range (tests/aggregate.invariants.test.mjs). Title lanes count works, so a work whose title
// matches twice is one mark (its first match).

import { HttpError } from '../http/errors.mjs';
import { stmt } from '../db/open.mjs';
import { facetSql, laneKey, rowCols, unitClassSql } from './lanes.mjs';
import { countValue, laneWhere, occurrenceRunSql, sliceWhere, srcCols, strandDocRows, strandLangSpec } from './query.mjs';
import { groupCaseSql, memberJoinSql } from './clusterlanes.mjs';

/** Most marks one response carries (§1.6). */
export const MAX_MARKS = 4000;

/**
 * SQL of a strand's counted occurrences under a def: occurrence rows of the pinned, succeeded run in
 * quality='ok' passages of the slice (name-guard hits only when nm=1). Columns: occ, passage, doc, start_off,
 * end_off, name_flag, variant_id, field, p_start, p_end, plang, field_class, lv, uc, chrono_status, lo_day, hi_day,
 * y_lo, y_hi, precision, basis, date_label, date_role, title, author, kind, syn, collection, license,
 * export_text_allowed, rn (rank of the match within its lane × document, for title lanes).
 * @param {object} def
 * @param {object} strand an expression strand with a run
 * @param {{where?: string, params?: any[], lane?: string|null}} [opts]
 * @returns {{sql: string, params: any[]}}
 */
export function occurrenceSql(def, strand, { where = '1', params = [], lane = null } = {}) {
  // cluster lanes: each occurrence's context group from the run's membership (residual when it has none)
  const cluster = def.lanes.facet === 'cluster' && def.cluster?.state === 'ok';
  const cols = rowCols('p', true, cluster ? groupCaseSql(def.cluster, 'm.cluster_id') : def.lanes.facet === 'cluster' ? 'NULL' : null);
  const slice = sliceWhere(def, cols, strandLangSpec(strand));
  const lw = lane ? laneWhere(def, lane, cols) : { sql: '1', params: [] };
  const lv = facetSql(def.lanes.facet, cols), uc = unitClassSql(def.lanes.facet, cols);
  const runs = occurrenceRunSql(strand);
  return {
    sql: `SELECT o.id AS occ, o.passage_id AS passage, o.document_id AS doc, o.start_off, o.end_off, o.name_flag, o.variant_id,
        p.field, p.start_off AS p_start, p.end_off AS p_end, p.lang AS plang, p.field_class, ${lv} AS lv, ${uc} AS uc,
        d.chrono_status, d.lo_day, d.hi_day, d.y_lo, d.y_hi, d.precision, d.basis, d.date_label, d.date_role, d.title,
        d.author, d.kind, d.is_synthetic AS syn, c.slug AS collection, c.license, c.export_text_allowed,
        ROW_NUMBER() OVER (PARTITION BY ${lv}, ${uc}, o.document_id ORDER BY o.id) AS rn
      FROM occurrence o JOIN analysis_run r ON r.id = o.run_id AND r.status = 'succeeded'
      JOIN passage p ON p.id = o.passage_id JOIN document d ON d.id = o.document_id JOIN collection c ON c.id = d.collection_id
      ${cluster ? memberJoinSql(def.cluster) : ''}
      WHERE ${runs.sql} AND p.quality = 'ok' AND (o.name_flag = 0 OR ? = 1)
        AND ${slice.sql} AND ${lw.sql} AND ${where}`,
    params: [...runs.params, def.toggles.nm ? 1 : 0, ...slice.params, ...lw.params, ...params],
  };
}

/** The counted rows of occurrenceSql: every match in text lanes, the first match of each work in title and OpenAlex lanes. */
export const COUNTED = "(uc NOT IN ('titles', 'cells') OR rn = 1)";

/** Marks of work-like strands (theme, work, maker): one per work, at its title passage. */
function workMarks(db, def, strand, { where, params, lane }) {
  const cols = rowCols('p', true);
  const slice = sliceWhere(def, cols, null);
  const lw = lane ? laneWhere(def, lane, cols) : { sql: '1', params: [] };
  let pick, pickParams;
  if (strand.type === 'theme') { pick = "d.id IN (SELECT document_id FROM doc_tag WHERE scheme = 'theme' AND value = ? AND provenance = ?)"; pickParams = [strand.ref, strand.provenance]; }
  else if (strand.type === 'work') { pick = 'd.id = ?'; pickParams = [strand.ref]; }
  else {
    pick = `(d.author IN (SELECT value FROM json_each(?)) OR d.id IN (SELECT document_id FROM doc_tag WHERE scheme = 'maker'
      AND value IN (SELECT value FROM json_each(?))))`;
    pickParams = [JSON.stringify(strand.names ?? [strand.ref]), JSON.stringify(strand.names ?? [strand.ref])];
  }
  return stmt(db, `SELECT NULL AS occ, MIN(p.id) AS passage, d.id AS doc, ${facetSql(def.lanes.facet, cols)} AS lv, ${unitClassSql(def.lanes.facet, cols)} AS uc,
      d.lo_day, d.hi_day, d.precision, d.basis, d.is_synthetic AS syn, 0 AS name_flag
    FROM document d JOIN collection c ON c.id = d.collection_id JOIN passage p ON p.document_id = d.id AND p.field_class = 'title' AND p.quality = 'ok'
    WHERE ${pick} AND ${slice.sql} AND ${lw.sql} AND ${where} GROUP BY d.id ORDER BY d.lo_day, d.id`)
    .all(...pickParams, ...slice.params, ...lw.params, ...params);
}

const KIND = { text: 'text', titles: 'title', abstracts: 'abstract' };   // 'cells' (OpenAlex works): the passage's field class

/**
 * GET /api/timeline/marks. Read-query convention (§12.2): runs in the read pool via ctx.pool.run(moduleUrl,
 * 'marksQuery', args).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{def: object, from?: number|null, to?: number|null, lane?: string|null, strand?: string|null, limit?: number}} args
 *   from/to are astronomical years; a document counts when its interval overlaps [from, to]
 * @returns {{marks: object[], truncated: boolean, total: number}}
 */
export function marksQuery(db, { def, from = null, to = null, lane = null, strand = null, limit = MAX_MARKS }) {
  const lim = Math.max(1, Math.min(MAX_MARKS, Number(limit) || MAX_MARKS));
  if (def.lanes.facet === 'cluster' && def.cluster?.state !== 'ok') return { marks: [], truncated: false, total: 0 };
  const where = ["d.chrono_status = 'dated'"];
  const params = [];
  if (Number.isInteger(from)) { where.push('d.y_hi >= ?'); params.push(from); }
  if (Number.isInteger(to)) { where.push('d.y_lo <= ?'); params.push(to); }
  const strands = def.strands.filter((s) => strand === null || strand === undefined || String(s.type === 'expression' ? s.ref : s.key) === String(strand));
  if (strand !== null && strand !== undefined && !strands.length) throw new HttpError(400, 'E_VALIDATION', `No strand '${strand}' in this query.`, null, { field: 'strand' });
  let total = 0, sampled = false;
  const marks = [];
  for (const s of strands) {
    const key = s.type === 'expression' ? s.ref : s.key;
    let rows;
    if (s.type === 'expression') {
      if (!s.run) continue;
      const q = occurrenceSql(def, s, { where: where.join(' AND '), params, lane });
      if (s.sampled) {
        // the marks are a sample; the total is the complete count (expr_doc) over the same documents
        const lw = lane ? laneWhere(def, lane, srcCols(def)) : { sql: '1', params: [] };
        const rows = strandDocRows(db, def, s, { where: `${where.join(' AND ')} AND ${lw.sql}`, params: [...params, ...lw.params] });
        total += rows.reduce((acc, r) => acc + countValue(r.uc, [r]), 0);
        sampled = true;
      } else total += stmt(db, `WITH m AS (${q.sql}) SELECT count(*) AS n FROM m WHERE ${COUNTED}`).get(...q.params).n;
      rows = stmt(db, `WITH m AS (${q.sql}) SELECT * FROM m WHERE ${COUNTED} ORDER BY lo_day, occ LIMIT ?`).all(...q.params, lim);
    } else {
      rows = workMarks(db, def, s, { where: where.join(' AND '), params, lane });
      total += rows.length;
    }
    for (const r of rows) {
      marks.push({ occ: r.occ, passage: r.passage, doc: r.doc, lane: laneKey(def.lanes.facet, r.lv, r.uc), strand: key,
        lo_day: r.lo_day, hi_day: r.hi_day, precision: r.precision, basis: r.basis,
        kind: s.type === 'expression' ? KIND[r.uc] ?? (r.field_class === 'title' ? 'title' : r.field_class === 'abstract' ? 'abstract' : 'text') : 'work',
        name_flag: r.name_flag === 1, synthetic: r.syn === 1 });
    }
  }
  marks.sort((a, b) => a.lo_day - b.lo_day || (a.occ ?? 0) - (b.occ ?? 0));
  const out = marks.slice(0, lim);
  return { marks: out, truncated: total > out.length, total, ...(sampled ? { sampled: true } : {}) };
}
