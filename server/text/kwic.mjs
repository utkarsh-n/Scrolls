// OWNER: WP3
// kwic.mjs — passage text and KWIC lines computed at request time from the ORIGINAL (SPEC §4.4, D4): ±12
// tokens, clipped at passage bounds; plus the concordance query (GET /api/kwic).
//
// Offsets are UTF-16 code units into document_text.original (field 'body') or document_field.value (other
// fields). SQLite's substr() counts code points, so texts are sliced in JS; originals are immutable per
// document id, so a per-connection cache (bounded by text size) is safe.

import { formatDateLabel } from '../../src/shared/dates.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { decodeCursor, encodeCursor } from '../http/router.mjs';
import { laneKey } from '../aggregate/lanes.mjs';
import { countValue, denomKeyOf, laneWhere, srcCols, strandDocRows, strandLangSpec } from '../aggregate/query.mjs';
import { COUNTED, occurrenceSql } from '../aggregate/marks.mjs';
import { cubesRangeTotals, readyCubes } from '../aggregate/cube.mjs';

// Two caches per connection, both bounded by text size: whole originals (bulk work reads many passages of one book) and
// passage texts (a search or a drawer shows the same few passages again; keeping a 1 MB book to re-cut one line was the
// bulk of a warm Cipher search, M1 gate). Passage strings are flattened copies so they never pin a whole book.
const ORIGINAL_CHARS = 24 * 1024 * 1024;
const PASSAGE_CHARS = 16 * 1024 * 1024;
const caches = new WeakMap();   // db → { originals: {map, chars}, passages: {map, chars} }

function cacheOf(db, which) {
  let c = caches.get(db);
  if (!c) caches.set(db, (c = { originals: { map: new Map(), chars: 0 }, passages: { map: new Map(), chars: 0 } }));
  return c[which];
}

/**
 * The decoded original of a document's full text (null when it has none). LRU-cached per connection.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} docId
 * @returns {string|null}
 */
export function documentOriginal(db, docId) {
  return cached(cacheOf(db, 'originals'), ORIGINAL_CHARS, `b:${docId}`,
    () => stmt(db, 'SELECT original FROM document_text WHERE document_id = ?').get(docId)?.original ?? null);
}

/**
 * The verbatim value of a metadata field (title, summary, …) of a document, or null.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} docId
 * @param {string} field
 * @returns {string|null}
 */
export function fieldValue(db, docId, field) {
  return cached(cacheOf(db, 'originals'), ORIGINAL_CHARS, `f:${docId}:${field}`, () =>
    stmt(db, 'SELECT value FROM document_field WHERE document_id = ? AND field = ?').get(docId, field)?.value ?? null);
}

function cached(c, budget, key, load) {
  if (c.map.has(key)) {
    const v = c.map.get(key);
    c.map.delete(key);
    c.map.set(key, v);
    return v;
  }
  const v = load();
  c.map.set(key, v);
  c.chars += v?.length ?? 0;
  while (c.chars > budget && c.map.size > 1) {
    const [k, old] = c.map.entries().next().value;
    c.map.delete(k);
    c.chars -= old?.length ?? 0;
  }
  return v;
}

/**
 * The string a passage's offsets index: the document original (body) or the field value (other fields).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{document_id: number, field: string}} p
 * @returns {string|null}
 */
export function passageBase(db, p) {
  return p.field === 'body' ? documentOriginal(db, p.document_id) : fieldValue(db, p.document_id, p.field);
}

/**
 * The text of a passage: base.slice(start_off, end_off), cached per passage.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{document_id: number, field: string, start_off: number, end_off: number}} p
 * @returns {string}
 */
export function passageText(db, p) {
  return cached(cacheOf(db, 'passages'), PASSAGE_CHARS, `${p.document_id}:${p.field}:${p.start_off}:${p.end_off}`,
    () => JSON.parse(JSON.stringify((passageBase(db, p) ?? '').slice(p.start_off, p.end_off))));
}

/**
 * Left context, match and right context around [start, end) in UTF-16 offsets: `window` tokens on each side,
 * never crossing [clipStart, clipEnd) (the passage bounds).
 * Cross-package: other packages showing passages (compare, trace) use it.
 * @param {string} original
 * @param {number} start
 * @param {number} end
 * @param {{window?: number, clipStart?: number, clipEnd?: number}} [opts]
 * @returns {{left: string, match: string, right: string, start: number, end: number}}
 */
export function kwic(original, start, end, { window = 12, clipStart = 0, clipEnd = original.length } = {}) {
  const lo = Math.max(0, Math.min(clipStart, start));
  const hi = Math.min(original.length, Math.max(clipEnd, end));
  const region = original.slice(lo, hi);
  const t = tokenize(region);
  const s = start - lo, e = end - lo;
  let first = 0;
  while (first < t.starts.length && t.ends[first] <= s) first++;   // first token not entirely before the match
  let last = t.starts.length - 1;
  while (last >= 0 && t.starts[last] >= e) last--;                  // last token not entirely after the match
  const leftIdx = Math.max(0, first - window);
  const rightIdx = Math.min(t.starts.length - 1, last + window);
  const leftStart = first - window >= 0 && first > 0 ? t.starts[leftIdx] : 0;
  const rightEnd = last + window <= t.starts.length - 1 && last >= 0 ? t.ends[rightIdx] : region.length;
  return {
    left: region.slice(Math.min(leftStart, s), s),
    match: region.slice(s, e),
    right: region.slice(e, Math.max(e, rightEnd)),
    start,
    end,
  };
}

/**
 * KWIC rows for occurrence-like records, in the given order. Offsets in the row are relative to the passage
 * text (like Passage.highlights); `abs_start`/`abs_end` index the document coordinate base. Text is withheld
 * (null) for collections with export_text_allowed = 0 when `respectExport` is set.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{occ?: number|null, passage: number, document_id: number, field: string, p_start: number, p_end: number,
 *   start_off: number, end_off: number, title?: string|null, lo_day?: number|null, hi_day?: number|null, precision?: string,
 *   date_label?: string, lane?: string|null, is_synthetic?: number, export_text_allowed?: number}>} rows
 * @param {{window?: number, respectExport?: boolean}} [opts]
 * @returns {object[]}
 */
export function kwicRows(db, rows, { window = 12, respectExport = false } = {}) {
  return rows.map((r) => {
    const withheld = respectExport && r.export_text_allowed === 0;
    let k = { left: null, match: null, right: null };
    if (!withheld) {
      // the window never leaves the passage: cut it from the passage text, offsets shifted to the passage
      const text = passageText(db, { document_id: r.document_id, field: r.field, start_off: r.p_start, end_off: r.p_end });
      k = kwic(text, r.start_off - r.p_start, r.end_off - r.p_start);
    }
    const row = {
      passage: r.passage, doc: r.document_id, start: r.start_off - r.p_start, end: r.end_off - r.p_start,
      abs_start: r.start_off, abs_end: r.end_off, left: k.left ?? '', match: k.match ?? '', right: k.right ?? '',
      title: r.title ?? null,
      date: { label: r.date_label ?? (r.lo_day === null || r.lo_day === undefined ? 'undated'
        : formatDateLabel({ lo_day: r.lo_day, hi_day: r.hi_day, precision: r.precision })), precision: r.precision ?? 'unknown' },
      lane: r.lane ?? null, synthetic: r.is_synthetic === 1,
    };
    if (r.occ !== undefined) row.occ = r.occ;
    if (withheld) row.text_withheld = true;
    return row;
  });
}

/**
 * GET /api/kwic concordance: the counted occurrences of one expression strand of a def, optionally in a year
 * range (documents overlapping [from, to]; undated items only when no range is given) and a lane, sorted by
 * date (undated last) or spread (one per document in turn). Read-query convention (§12.2): runs in the read pool
 * via ctx.pool.run(moduleUrl, 'kwicQuery', args).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{def: object, expr?: number|null, from?: number|null, to?: number|null, lane?: string|null,
 *   sort?: 'date'|'spread', cursor?: string|null, limit?: number}} args
 * @returns {{rows: object[], total: number, cursor: string|null, denominator: {tokens: number, works: number, docs: number}|null}}
 */
export function kwicQuery(db, { def, expr = null, from = null, to = null, lane = null, sort = 'date', cursor = null, limit = 50 }) {
  const strand = def.strands.find((s) => s.type === 'expression' && (expr === null || expr === undefined || s.ref === Number(expr)));
  if (!strand) throw new HttpError(400, 'E_VALIDATION', 'No expression strand matches this request.', 'Pass expr=<expression id>.', { field: 'expr' });
  if (!['date', 'spread'].includes(sort)) throw new HttpError(400, 'E_VALIDATION', "sort must be 'date' or 'spread'.", null, { field: 'sort' });
  if (!strand.run) return { rows: [], total: 0, cursor: null, status: 'materializing' };
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const where = [], params = [];
  if (Number.isInteger(from) || Number.isInteger(to)) where.push("d.chrono_status = 'dated'");
  if (Number.isInteger(from)) { where.push('d.y_hi >= ?'); params.push(from); }
  if (Number.isInteger(to)) { where.push('d.y_lo <= ?'); params.push(to); }
  const q = occurrenceSql(def, strand, { where: where.length ? where.join(' AND ') : '1', params, lane });
  const total = stmt(db, `WITH m AS (${q.sql}) SELECT count(*) AS n FROM m WHERE ${COUNTED}`).get(...q.params).n;
  const c = decodeCursor(cursor);
  const offset = Number.isInteger(c?.o) && c.o >= 0 ? c.o : 0;
  const order = sort === 'spread'
    ? 'ROW_NUMBER() OVER (PARTITION BY doc ORDER BY occ), lo_day IS NULL, lo_day, occ'
    : 'lo_day IS NULL, lo_day, occ';
  const rows = stmt(db, `WITH m AS (${q.sql}) SELECT * FROM m WHERE ${COUNTED} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...q.params, lim, offset)
    .map((r) => ({ ...r, document_id: r.doc, is_synthetic: r.syn, lane: laneKey(def.lanes.facet, r.lv, r.uc) }));
  // the denominator of the contemporary-uses line: what the concordance looked at (M1 gate, WP7 need); null while a
  // large corpus's slice cube is still being built (warm.mjs) rather than making the concordance wait
  const cubes = readyCubes(db, def.corpusIds ?? [def.corpusId], { endpoints: def.lanes?.facet === 'trail' });
  // cluster lanes count within their unit class's slice (every group lane shares it)
  const denLane = lane && def.lanes.facet === 'cluster' ? denomKeyOf(def, lane, lane.includes('~') ? lane.slice(lane.lastIndexOf('~') + 1) : 'text') : lane;
  const den = cubes ? cubesRangeTotals(cubes, def, strandLangSpec(strand), { from, to, lane: denLane }) : null;
  const out = { rows: kwicRows(db, rows), total, cursor: offset + lim < total ? encodeCursor({ o: offset + lim }) : null,
    denominator: den && { ...den, from: Number.isInteger(from) ? from : null, to: Number.isInteger(to) ? to : null, lane: lane ?? null,
      note: Number.isInteger(from) || Number.isInteger(to)
        ? 'documents dated within or overlapping the range, same slice and languages as the rows'
        : 'every document of the slice in the strand\'s languages, dated or not' } };
  if (strand.sampled) {
    const lw = lane ? laneWhere(def, lane, srcCols(def)) : { sql: '1', params: [] };
    const all = strandDocRows(db, def, strand, { where: `${where.length ? where.join(' AND ') : '1'} AND ${lw.sql}`, params: [...params, ...lw.params] });
    out.sampled = { contexts: total, of: all.reduce((acc, r) => acc + countValue(r.uc, [r]), 0),
      note: 'contexts sampled: ≤ 200 per language and decade' };
  }
  return out;
}
