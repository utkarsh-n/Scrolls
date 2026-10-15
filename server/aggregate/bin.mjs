// OWNER: WP3
// bin.mjs — the bin drawer (SPEC §1.6 "aggregate click", §7.1 GET /api/timeline/bin): the denominator line on
// top, then KWIC rows sorted by date, 50 per page; every row opens its passage. The cell is computed by the same
// code as the tile (tiles.strandCells), so the drawer can never disagree with the bar it was opened from.

import { formatCount, formatRate, formatTokens } from '../../src/shared/format.mjs';
import { MONTH_ABBR, ymdFromDay, yearLabel } from '../../src/shared/dates.mjs';
import { CELL_STATES } from '../../src/shared/vocab.mjs';
import { stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { decodeCursor, encodeCursor } from '../http/router.mjs';
import { kwicRows } from '../text/kwic.mjs';
import { laneKey, parseLaneKey } from './lanes.mjs';
import { COUNTED, occurrenceSql } from './marks.mjs';
import { fitsTier, laneGatesOf, pendingUnitClasses, strandDocRows, strandLangSpec, strandSource, unitOf } from './query.mjs';
import { strandCells } from './tiles.mjs';
import { docCells } from './cube.mjs';
import { shareCells } from './trail.mjs';
import { binOfDay, dayRange } from './washes.mjs';

const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
const WIDTH = [1000, 100, 10, 1];

/**
 * Label of a bin: '1910–1919', '1911', 'Apr 1931', '7 Apr 1931', '500 BCE–401 BCE'.
 * @param {string} tier
 * @param {number} bin
 * @returns {string}
 */
export function binLabel(tier, bin) {
  const level = TIERS.indexOf(tier);
  if (level <= 3) {
    const w = WIDTH[level];
    return w === 1 ? yearLabel(bin) : `${yearLabel(bin * w)}–${yearLabel(bin * w + w - 1)}`;
  }
  if (level === 4) {
    const y = Math.floor(bin / 12), m = bin - y * 12;
    return `${MONTH_ABBR[m]} ${yearLabel(y)}`;
  }
  const { y, m, d } = ymdFromDay(bin);
  return `${d} ${MONTH_ABBR[m - 1]} ${yearLabel(y)}`;
}

function denominatorText({ state, n, denom, unit, uc, gate, label, docs, rate, synthetic }) {
  const amount = uc === 'titles' ? `${formatCount(denom)} works` : `${formatTokens(denom)} tokens`;
  const gateText = uc === 'titles' ? `${formatCount(gate)} works` : formatCount(gate);
  const syn = synthetic ? ' · SYNTHETIC' : '';
  switch (state) {
    case 'observed': return `n = ${formatCount(n)} in ${label} · ${amount} · ${formatCount(docs)} documents · ${formatRate(rate, unit)}${syn}`;
    case 'absent': return `0 occurrences in ${amount} — looked, found none${syn}`;
    case 'low': return `low coverage: n = ${formatCount(n)} in ${amount} (gate ${gateText}) — rate not shown${syn}`;
    case 'pending': return `indexing — not yet looked${syn}`;
    default: return `no sources in ${label}${syn}`;
  }
}

/**
 * GET /api/timeline/bin. Read-query convention (§12.2): runs in the read pool via ctx.pool.run(moduleUrl,
 * 'binQuery', args).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{def: object, lane: string, strand?: string|number|null, tier: string, bin: number, cell?: string|null, cursor?: string|null,
 *   limit?: number}} args `cell` (an OpenAlex cell `field|lo-hi`) opens a share cell of a Term trail OpenAlex lane instead of a bin
 * @returns {{denominator: object, rows: object[], cursor: string|null, total: number}}
 */
export function binQuery(db, { def, lane, strand = null, tier, bin, cell: shareCell = null, cursor = null, limit = 50 }) {
  if (!lane) throw new HttpError(400, 'E_VALIDATION', 'lane is required.', null, { field: 'lane' });
  let uc;
  try { ({ unitClass: uc } = parseLaneKey(lane)); } catch (err) { throw new HttpError(400, 'E_VALIDATION', err.message, null, { field: 'lane' }); }
  const s = def.strands.find((x) => (strand === null || strand === undefined ? strandSource(x, def) : String(x.type === 'expression' ? x.ref : x.key) === String(strand)));
  if (!s || !strandSource(s, def)) throw new HttpError(400, 'E_VALIDATION', 'No counted strand matches this request.', 'Pass strand=<expression id>.', { field: 'strand' });
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  if (uc === 'cells') return cellDrawer(db, { def, lane, s, cell: shareCell, cursor, lim });
  if (!TIERS.includes(tier)) throw new HttpError(400, 'E_VALIDATION', `tier must be one of ${TIERS.join(', ')}.`, null, { field: 'tier' });
  if (!Number.isInteger(bin)) throw new HttpError(400, 'E_VALIDATION', 'bin must be an integer.', null, { field: 'bin' });
  const gates = laneGatesOf(db, def);
  const cell = strandCells(db, def, s, tier, { b0: bin, b1: bin }, { gates, pending: pendingUnitClasses(db, def) }).get(lane)?.get(bin) ?? null;
  const label = binLabel(tier, bin);
  const unit = unitOf(uc);
  const state = cell ? CELL_STATES[cell.state] : 'uncovered';
  const denominator = {
    lane, strand: s.type === 'expression' ? s.ref : s.key, tier, bin, label, state, n: cell?.n ?? 0, docs: cell?.docs ?? 0,
    [uc === 'titles' ? 'works' : 'tokens']: cell?.denom ?? 0, unit, rate: cell?.rate ?? null,
    ci: cell && cell.rate !== null ? [cell.ci_lo, cell.ci_hi] : null, gate: gates.of(lane, uc),
  };
  denominator.text = denominatorText({ state, n: denominator.n, denom: cell?.denom ?? 0, unit, uc, gate: denominator.gate, label,
    docs: denominator.docs, rate: denominator.rate, synthetic: Boolean(cell && cell.flags & 16) || s.synthetic });

  if (s.type !== 'expression') return { denominator, rows: [], cursor: null, total: denominator.n };
  const level = TIERS.indexOf(tier);
  let where, params;
  if (level <= 3) {
    where = "d.chrono_status = 'dated' AND EXISTS (SELECT 1 FROM doc_bin b WHERE b.document_id = d.id AND b.level = ? AND b.bin = ?)";
    params = [level, bin];
  } else {
    const [d0, d1] = dayRange(tier, bin, bin);
    where = "d.chrono_status = 'dated' AND d.lo_day >= ? AND d.hi_day <= ?";
    params = [d0, d1];
  }
  const q = occurrenceSql(def, s, { where, params, lane });
  let rows = stmt(db, `WITH m AS (${q.sql}) SELECT * FROM m WHERE ${COUNTED} ORDER BY lo_day, occ`).all(...q.params);
  if (level >= 4) rows = rows.filter((r) => fitsTier(r, tier) && binOfDay(r.lo_day, r.y_lo, tier) === bin);
  const c = decodeCursor(cursor);
  const offset = Number.isInteger(c?.o) && c.o >= 0 ? c.o : 0;
  const pageRows = rows.slice(offset, offset + lim).map((r) => ({ ...r, document_id: r.doc, is_synthetic: r.syn,
    lane: laneKey(def.lanes.facet, r.lv, r.uc) }));
  if (s.sampled) {
    denominator.sampled = { contexts: rows.length, of: denominator.n };
    denominator.text += ` · contexts sampled: ${rows.length} of ${denominator.n} in this bin`;
  }
  return {
    denominator,
    rows: kwicRows(db, pageRows),
    cursor: offset + lim < rows.length ? encodeCursor({ o: offset + lim }) : null,
    total: rows.length,
  };
}

/**
 * The drawer of one OpenAlex share cell (C3; `cell=<field>|<lo>-<hi>` on a share lane): the cell's k of n with its
 * Wilson CI (or why there is no share), then KWIC rows of the sampled works that mention the strand, by date.
 */
function cellDrawer(db, { def, lane, s, cell, cursor, lim }) {
  if (!cell) throw new HttpError(400, 'E_VALIDATION', 'cell is required on an OpenAlex share lane.', 'Pass cell=<field>|<lo>-<hi> from the tile.', { field: 'cell' });
  const rows0 = strandDocRows(db, def, s).filter((r) => r.uc === 'cells' && `trail:${r.lv}` === lane);
  const c = (shareCells(db, def, s, rows0, strandLangSpec(s)).cells.get(lane) ?? []).find((x) => x.cell === cell) ?? null;
  const docCell = new Map();
  for (const id of def.corpusIds ?? [def.corpusId]) for (const [d, x] of docCells(db, id)) docCell.set(d, x);
  const docs = [...new Set(rows0.filter((r) => r.v > 0 && docCell.get(r.doc) === cell).map((r) => r.doc))];
  const denominator = { lane, strand: s.type === 'expression' ? s.ref : s.key, cell, state: c?.state ?? 'uncovered', k: c?.k ?? 0, n: c?.n ?? 0,
    n_cell: c?.n_cell ?? 0, share: c?.share ?? null, ci: c?.ci ?? null, unit: 'share_of_sampled_works', field: c?.field ?? null,
    label: c?.label ?? null, text: c ? `${c.field} · ${c.label}: ${c.text}` : `no sampled work of ${cell} in this slice` };
  if (s.type !== 'expression' || !docs.length) return { denominator, rows: [], cursor: null, total: docs.length };
  const q = occurrenceSql(def, s, { where: 'd.id IN (SELECT value FROM json_each(?))', params: [JSON.stringify(docs)], lane });
  const rows = stmt(db, `WITH m AS (${q.sql}) SELECT * FROM m WHERE ${COUNTED} ORDER BY lo_day, occ`).all(...q.params);
  const c0 = decodeCursor(cursor);
  const offset = Number.isInteger(c0?.o) && c0.o >= 0 ? c0.o : 0;
  const pageRows = rows.slice(offset, offset + lim).map((r) => ({ ...r, document_id: r.doc, is_synthetic: r.syn, lane }));
  return { denominator, rows: kwicRows(db, pageRows), cursor: offset + lim < rows.length ? encodeCursor({ o: offset + lim }) : null, total: rows.length };
}
