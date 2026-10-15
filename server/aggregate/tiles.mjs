// OWNER: WP3
// tiles.mjs — binned cells, washes and coverage per lane and strand (SPEC §1.2, §1.6, §3.2, §7.2 tiles).
//
// Cell = [binIndexInTile, n, docs, authors, denom, rate, ci_lo, ci_hi, state, flags, dp]; a tile is 64 bins
// (tile = floor(bin / 64)). `days[lane][strand]` lists [binIndexInTile, first lo_day, last hi_day] of the counted
// documents of each cell with matches, so caps can sit at the exact first and last observation. L0–L3 bin by year through doc_bin (reference SQL of §3.2); L4 (months) and L5 (days)
// bin documents whose interval fits one month / day. Cells are sent only for bins with n > 0 or denom > 0; the
// client takes absent / low / uncovered / pending from the cell state and never infers them.

import { LEVELS } from '../../src/shared/dates.mjs';
import { CELL_FLAGS, CELL_STATE_CODES } from '../../src/shared/vocab.mjs';
import { stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { coverageTuple, denominators, docSizes } from './coverage.mjs';
import { facetSql, laneKey, unitClassSql } from './lanes.mjs';
import { countValue, denomKeyOf, fitsTier, laneGatesOf, pendingUnitClasses, sliceWhere, srcCols, strandDocRows, strandLangSpec,
  strandSource, unionLanguages, unitOf } from './query.mjs';
import { rateCell } from './rates.mjs';
import { griesDP } from './stats.mjs';
import { ownerTile, shareCells, tileYears } from './trail.mjs';
import { groupLanes } from './clusterlanes.mjs';
import { binOfDay, groupWashes, overlappingDocRows, TILE_BINS } from './washes.mjs';

const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
/** Most tiles one request may ask for (each tile is 64 bins). */
export const MAX_TILES = 64;

/**
 * Parse a `tiles` parameter: "3", "2,3", "-3..5" (inclusive range) or a mix.
 * @param {string|number[]} spec
 * @returns {number[]} sorted, distinct
 * @throws {HttpError} 400 E_VALIDATION
 */
export function parseTiles(spec) {
  const out = new Set();
  const parts = Array.isArray(spec) ? spec.map(String) : String(spec ?? '').split(',');
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const m = /^(-?\d+)\.\.(-?\d+)$/.exec(p);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (b < a || b - a >= 100000) throw new HttpError(400, 'E_VALIDATION', `Bad tile range '${p}'.`, 'Use from..to with from ≤ to.');
      for (let t = a; t <= b; t++) out.add(t);
    } else if (/^-?\d+$/.test(p)) out.add(Number(p));
    else throw new HttpError(400, 'E_VALIDATION', `Bad tile '${p}'.`, 'Tiles are integers: tiles=2,3 or tiles=2..5.');
  }
  if (!out.size) throw new HttpError(400, 'E_VALIDATION', 'tiles is required.', 'Ask for tiles=2,3 or tiles=2..5.');
  return [...out].sort((a, b) => a - b);
}

/** Numerator rows of a strand per lane × bin × document at L0–L3 (doc_bin) or L4/L5 (JS binning). */
function numeratorRows(db, def, strand, tier, range) {
  const level = TIERS.indexOf(tier);
  if (level >= 4) {
    const out = [];
    for (const r of overlappingDocRows(db, def, strand, tier, range)) {
      if (!fitsTier(r, tier)) continue;
      const bin = binOfDay(r.lo_day, r.y_lo, tier);
      if (bin >= range.b0 && bin <= range.b1) out.push({ ...r, bin });
    }
    return out;
  }
  const src = strandSource(strand, def);
  const cols = srcCols(def);
  const slice = sliceWhere(def, cols, strandLangSpec(strand));
  const nm = def.toggles.nm ? 1 : 0;
  return stmt(db, `WITH src AS (${src.sql})
    SELECT ${facetSql(def.lanes.facet, cols)} AS lv, ${unitClassSql(def.lanes.facet, cols)} AS uc, b.bin AS bin, e.document_id AS doc,
      SUM(e.n + ${nm} * e.n_names) AS v, SUM(e.n_names) AS names, d.author, d.basis, d.is_synthetic AS syn,
      d.is_translation AS tr, d.lo_day, d.hi_day
    FROM src e CROSS JOIN document d ON d.id = e.document_id JOIN collection c ON c.id = d.collection_id
    JOIN doc_bin b ON b.document_id = d.id AND b.level = ?
    WHERE ${slice.sql} AND b.bin BETWEEN ? AND ?
    GROUP BY lv, uc, b.bin, e.document_id`).all(...src.params, level, ...slice.params, range.b0, range.b1);
}

/** The cluster lane keys of a unit class: every group lane and the residual lane of the def's run. */
function clusterLaneKeys(db, def, uc) {
  const cl = def.cluster;
  if (!cl || cl.state !== 'ok') return [];
  return [...cl.groups.map((g) => `${cl.run}:${g.ord}`), `${cl.run}:residual`].map((v) => laneKey('cluster', v, uc));
}
const clusterUc = (key) => { const t = key.lastIndexOf('~'); return t > 0 ? key.slice(t + 1) : 'text'; };

/**
 * Cells of one strand over a bin range: Map(lane → Map(bin → {cell fields})).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @param {object} strand
 * @param {string} tier
 * @param {{b0: number, b1: number}} range
 * @param {{gates: {of(key: string, uc: string): number}, pending: Set<string>}} env lane gates (query.laneGatesOf) and indexing unit classes
 * @returns {Map<string, Map<number, object>>}
 */
export function strandCells(db, def, strand, tier, range, { gates, pending }) {
  const facet = def.lanes.facet;
  const num = new Map();   // lane|bin → rows
  for (const r of numeratorRows(db, def, strand, tier, range)) {
    // OpenAlex share lanes have no calendar cells: their quantity lives in OpenAlex's own cells (C3)
    if (r.uc === 'cells') continue;
    const lane = laneKey(facet, r.lv, r.uc);
    const k = `${lane}|${r.bin}`;
    if (!num.has(k)) num.set(k, { lane, uc: r.uc, bin: r.bin, rows: [] });
    num.get(k).rows.push(r);
  }
  const langs = strandLangSpec(strand);
  const den = denominators(db, def, langs, tier, range);
  const matched = [...new Set([...num.values()].flatMap((g) => g.rows.filter((r) => r.v > 0).map((r) => r.doc)))];
  const sizes = docSizes(db, def, langs, tier, range, matched);

  const out = new Map();
  // cluster lanes: every group lane of a unit class divides by that class's slice; bins with coverage but no match
  // become cells of every group lane (absent / low, never inferred by the client)
  const keys = new Set(num.keys());
  if (facet === 'cluster') {
    for (const d of den.values()) for (const lane of clusterLaneKeys(db, def, d.uc)) keys.add(`${lane}|${d.bin}`);
  } else for (const k of den.keys()) if (!k.startsWith('trail:stemm-abstracts:')) keys.add(k);
  for (const k of keys) {
    const g = num.get(k);
    const sep = k.lastIndexOf('|');
    const laneK = g?.lane ?? k.slice(0, sep), binK = g?.bin ?? Number(k.slice(sep + 1));
    const ucK = g?.uc ?? (facet === 'cluster' ? clusterUc(laneK) : den.get(k)?.uc);
    const d = den.get(`${denomKeyOf(def, laneK, ucK)}|${binK}`);
    const lane = laneK, uc = ucK, bin = binK;
    const rows = g?.rows ?? [];
    const counted = rows.filter((r) => r.v > 0);
    const n = countValue(uc, rows);
    const denom = d ? (uc === 'titles' ? d.docs : d.tokens) : 0;
    if (n === 0 && denom === 0) continue;
    const unit = unitOf(uc);
    let { state, rate, ci_lo, ci_hi } = rateCell({ n, denom, unit, gate: gates.of(lane, uc), pending: pending.has(uc) });
    // a top-cited-per-cell lane (OpenAlex) or relation endpoints (Term trail, works mode): the count and its state, no
    // rate (D14, §10.4; query.laneGatesOf rateless)
    const cellSample = Boolean(gates.rateless?.(denomKeyOf(def, lane, uc))) && rate !== null;
    if (cellSample) rate = ci_lo = ci_hi = null;
    let flags = 0;
    const vSum = counted.reduce((s, r) => s + (uc === 'titles' ? 1 : r.v), 0);
    if (n >= 1 && n <= 4) flags |= CELL_FLAGS.sparse;
    if (vSum > 0) {
      const top = Math.max(...counted.map((r) => (uc === 'titles' ? 1 : r.v)));
      if (top / vSum >= 0.6) flags |= CELL_FLAGS.single_source;
      const est = counted.filter((r) => r.basis === 'estimated').reduce((s, r) => s + (uc === 'titles' ? 1 : r.v), 0);
      if (est / vSum > 0.5) flags |= CELL_FLAGS.estimated_majority;
    }
    if (d?.syn || rows.some((r) => r.syn) || strand.synthetic) flags |= CELL_FLAGS.synthetic;
    if ((strand.sampled && n > 0) || cellSample) flags |= CELL_FLAGS.sampled;
    if (!def.toggles.nm && rows.some((r) => r.names > 0)) flags |= CELL_FLAGS.names_excluded;
    if (def.toggles.tr && (d?.tr || rows.some((r) => r.tr))) flags |= CELL_FLAGS.translations_included;
    let dp = null;
    if (state === CELL_STATE_CODES.observed) {
      const counts = counted.map((r) => (uc === 'titles' ? 1 : r.v));
      const sz = counted.map((r) => (uc === 'titles' ? 1 : sizes.get(`${denomKeyOf(def, lane, uc)}|${bin}|${r.doc}`) ?? 0));
      const listed = sz.reduce((s, x) => s + x, 0);
      dp = griesDP(counts, sz, Math.max(0, denom - listed));
    }
    const authors = new Set(counted.map((r) => r.author).filter((a) => a !== null && a !== undefined)).size;
    // exact first / last observed day inside the bin (start and end caps at the observation, §1.2 item 5)
    let first = null, last = null;
    for (const r of counted) {
      if (first === null || r.lo_day < first) first = r.lo_day;
      if (last === null || r.hi_day > last) last = r.hi_day;
    }
    if (!out.has(lane)) out.set(lane, new Map());
    out.get(lane).set(bin, { n, docs: counted.length, authors, denom, rate, ci_lo, ci_hi, state, flags, dp, first, last });
  }
  return out;
}

/**
 * GET /api/timeline/tiles. Read-query convention (§12.2): runs in the read pool via ctx.pool.run(moduleUrl,
 * 'tilesQuery', args).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{def: object, tier: string, tiles: number[]|string}} args
 * @returns {{tier: string, binWidth: number|null, tiles: object[]}}
 */
export function tilesQuery(db, { def, tier, tiles }) {
  if (!TIERS.includes(tier)) throw new HttpError(400, 'E_VALIDATION', `tier must be one of ${TIERS.join(', ')}.`, null, { field: 'tier' });
  const list = Array.isArray(tiles) ? tiles : parseTiles(tiles);
  if (list.length > MAX_TILES) {
    throw new HttpError(400, 'E_VALIDATION', `At most ${MAX_TILES} tiles per request (asked for ${list.length}).`, 'Ask for the visible tiles only.');
  }
  return computeTiles(db, def, tier, list);
}

/**
 * Tiles without the per-request limit (exports, tests, the conservation check).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} def
 * @param {string} tier
 * @param {number[]} list tile indices
 * @returns {{tier: string, binWidth: number|null, tiles: object[]}}
 */
export function computeTiles(db, def, tier, list) {
  const level = TIERS.indexOf(tier);
  const range = { b0: Math.min(...list) * TILE_BINS, b1: Math.max(...list) * TILE_BINS + TILE_BINS - 1 };
  const wanted = new Set(list);
  const env = { gates: laneGatesOf(db, def), pending: pendingUnitClasses(db, def) };
  const tileOf = (bin) => Math.floor(bin / TILE_BINS);
  const tilesOut = new Map(list.map((t) => [t, { tile: t, bin0: t * TILE_BINS, lanes: {}, coverage: {}, washes: [], days: {},
    ...(def.lanes.facet === 'trail' ? { cells: {} } : {}) }]));

  const trail = def.lanes.facet === 'trail';
  for (const strand of def.strands) {
    if (!strandSource(strand, def)) continue;
    const skey = strand.type === 'expression' ? String(strand.ref) : strand.key;
    if (trail) attachShareCells(db, def, strand, skey, tier, tilesOut);
    for (const [lane, bins] of strandCells(db, def, strand, tier, range, env)) {
      for (const [bin, c] of [...bins].sort((a, b) => a[0] - b[0])) {
        const t = tileOf(bin);
        if (!wanted.has(t)) continue;
        const tile = tilesOut.get(t);
        const cells = ((tile.lanes[lane] ??= { strands: {} }).strands[skey] ??= []);
        cells.push([bin - t * TILE_BINS, c.n, c.docs, c.authors, c.denom, c.rate, c.ci_lo, c.ci_hi, c.state, c.flags, c.dp]);
        if (c.first !== null) (((tile.days[lane] ??= {})[skey]) ??= []).push([bin - t * TILE_BINS, c.first, c.last]);
      }
    }
    for (const w of groupWashes(def, strand, tier, overlappingDocRows(db, def, strand, tier, range, { onlyUnbinned: level <= 3 })
      .filter((r) => r.uc !== 'cells'))) {
      const owner = tileOf(w.bin_lo);
      for (let t = Math.max(tileOf(w.bin_lo), list[0]); t <= Math.min(tileOf(w.bin_hi), list[list.length - 1]); t++) {
        if (!wanted.has(t)) continue;
        const { bin_lo, bin_hi, ...wash } = w;
        tilesOut.get(t).washes.push({ ...wash, owner: t === owner, owner_tile: owner });
      }
    }
  }

  // coverage track in the union of the strands' languages (a single strand: its own spec, per corpus when it differs)
  const langs = def.strands.length === 1 ? strandLangSpec(def.strands[0]) : unionLanguages(def.strands);
  for (const d of denominators(db, def, langs, tier, range).values()) {
    const t = tileOf(d.bin);
    if (!wanted.has(t) || d.uc === 'cells') continue;
    const lanesOfD = def.lanes.facet === 'cluster' ? clusterLaneKeys(db, def, d.uc) : [d.lane];
    for (const lane of lanesOfD) (tilesOut.get(t).coverage[lane] ??= []).push(coverageTuple(d, d.bin - t * TILE_BINS));
  }
  for (const tile of tilesOut.values()) for (const list2 of Object.values(tile.coverage)) list2.sort((a, b) => a[0] - b[0]);
  return { tier, binWidth: level <= 3 ? LEVELS[level].width : null, tiles: [...tilesOut.values()] };
}

/**
 * Share cells (C3) of a strand on the OpenAlex lanes of a Term trail, placed in every requested tile whose years they
 * overlap (OpenAlex's own bins do not follow the tier); `owner` marks the tile holding the cell's first year.
 */
function attachShareCells(db, def, strand, skey, tier, tilesOut) {
  const rows = strandDocRows(db, def, strand).filter((r) => r.uc === 'cells');
  const { cells } = shareCells(db, def, strand, rows, strandLangSpec(strand));
  for (const [lane, list] of cells) {
    for (const tile of tilesOut.values()) {
      const [y0, y1] = tileYears(tier, tile.tile);
      const here = list.filter((c) => c.hi_year >= y0 && c.lo_year <= y1)
        .map(({ strand: _s, ...c }) => ({ ...c, owner: ownerTile(tier, c.lo_year) === tile.tile }));
      if (here.length) ((tile.cells[lane] ??= {})[skey] = here);
    }
  }
}
