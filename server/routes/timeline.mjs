// OWNER: WP3
// routes/timeline.mjs — the Scroll's data (SPEC §7.1, §7.2). Heavy queries run in the read pool (D11).
//
//   POST /api/timeline/query                                   register a canonical query → queryKey, lanes, totals, seams
//   GET  /api/timeline/tiles?q=&tier=&tiles=                   binned cells + washes + coverage (tiles=2,3 or 2..5)
//   GET  /api/timeline/marks?q=&from=&to=&lane=&strand=&limit= individual matches (≤ 4,000)
//   GET  /api/timeline/shelf?q=&which=&lane=&tier=&cursor=     undated · scheduled · washes
//   GET  /api/timeline/bin?q=&lane=&strand=&tier=&bin=&cell=&cursor= the bin drawer (cell: an OpenAlex share cell, C3)
//   GET  /api/timeline/arcs?q=&from=&to=&vantage=&ev=&limit=&tier=&rel_rev_cutoff=&rev_cutoff=&runs=&sel=&detail=
//                                                              arcs + bundles + halos + hidden counts (as saved with the cutoffs);
//                                                              above 1,500 arcs a summary (C4)
//
// A queryKey names a canonical def (strands with pinned runs, filters, toggles, lanes). Defs live in an in-memory
// registry and, best effort, in query_def; a key unknown after a restart answers 404 E_QUERY_UNKNOWN and the client
// registers the query again.

import { nowIso, stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { createTileCache, tileKey } from '../aggregate/cache.mjs';
import { ensureMaterialized, getExpression } from '../aggregate/materialize.mjs';
import { canonicalRequest, orderNoteOf, provenanceOf, queryKeyOf } from '../aggregate/query.mjs';
import { isVirtualCorpus, resolveCorpusScope, siblingExpressions, trackAcross } from '../aggregate/scope.mjs';
import { parseTiles, MAX_TILES } from '../aggregate/tiles.mjs';
import { noteCorpusUse } from '../aggregate/warm.mjs';
import { queueClaims } from './expressions.mjs';

const QUERY_URL = new URL('../aggregate/query.mjs', import.meta.url).href;
const TILES_URL = new URL('../aggregate/tiles.mjs', import.meta.url).href;
const MARKS_URL = new URL('../aggregate/marks.mjs', import.meta.url).href;
const SHELF_URL = new URL('../aggregate/shelf.mjs', import.meta.url).href;
const BIN_URL = new URL('../aggregate/bin.mjs', import.meta.url).href;
const ARCS_URL = new URL('../aggregate/arcs.mjs', import.meta.url).href;
const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

const defs = createTileCache({ max: 2000 });
const tiles = createTileCache({ max: 4096 });

function persistDef(db, key, def) {
  try {
    db.exec('PRAGMA busy_timeout = 25');
    const now = nowIso();
    stmt(db, `INSERT INTO query_def (key, def_json, created_at, last_used) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET last_used = excluded.last_used`).run(key, JSON.stringify(def), now, now);
  } catch {
    // the writer is busy: the in-memory registry still holds the def
  } finally {
    db.exec('PRAGMA busy_timeout = 5000');
  }
}

/**
 * The def registered under a queryKey (memory, then query_def).
 * @param {object} ctx RouteCtx
 * @param {string|undefined} q
 * @returns {object}
 * @throws {HttpError} 400 without q; 404 E_QUERY_UNKNOWN
 */
export function resolveDef(ctx, q) {
  if (!q) throw new HttpError(400, 'E_VALIDATION', 'q (the queryKey) is required.', 'Register the query with POST /api/timeline/query first.', { field: 'q' });
  let def = defs.get(q);
  if (!def) {
    const row = stmt(ctx.db, 'SELECT def_json FROM query_def WHERE key = ?').get(String(q));
    if (row) { def = JSON.parse(row.def_json); defs.set(q, def); }
  }
  if (!def) {
    throw new HttpError(404, 'E_QUERY_UNKNOWN', `No query ${q} is registered.`, 'POST /api/timeline/query again; queries are re-registered after a restart.');
  }
  return def;
}

const intParam = (v, field) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, 'E_VALIDATION', `${field} must be an integer (got '${v}').`, null, { field });
  return n;
};

/**
 * A virtual corpus counts each expression in every member corpus: track the missing siblings first (main thread, short
 * writes; idempotent), so the def resolves every member.
 * @returns {number[]} the expressions tracked now (their Wiktionary claim lookups are queued after their counts)
 */
function ensureSiblings(ctx, creq) {
  const created = [];
  if (!isVirtualCorpus(creq.corpus)) return created;
  for (const s of creq.strands) {
    if (s.type !== 'expression') continue;
    const e = getExpression(ctx.db, s.ref);
    if (!e) continue;
    // reads first: the write lock is taken only when a member corpus still lacks the expression
    const scope = resolveCorpusScope(ctx.db, creq.corpus);
    if (!scope.ids.includes(e.corpus_id) || siblingExpressions(ctx.db, e, scope.members).every((x) => x.expr)) continue;
    const t = ctx.withWrite((db) => trackAcross(db, { surface: e.surface, lang: e.lang, kind: e.kind, corpus: creq.corpus }));
    for (const m of t.members) if (m.created) created.push(m.id);
  }
  return created;
}

const tierParam = (v) => {
  const t = v ?? 'L2';
  if (!TIERS.includes(t)) throw new HttpError(400, 'E_VALIDATION', `tier must be one of ${TIERS.join(', ')}.`, null, { field: 'tier' });
  return t;
};

/** @type {Array<{method: string, path: string, heavy?: boolean, handler: Function}>} */
export const routes = [
  {
    method: 'POST',
    path: '/api/timeline/query',
    heavy: true,
    async handler(req, ctx) {
      const creq = canonicalRequest(req.body);
      const created = ensureSiblings(ctx, creq);
      const { def, materialize } = await ctx.pool.run(QUERY_URL, 'resolveQuery', { req: creq });
      for (const id of def.corpusIds ?? [def.corpusId]) noteCorpusUse(ctx, id);
      const jobs = materialize.map((m) => ensureMaterialized(ctx.db, ctx.jobs, m.expressionId).job).filter(Boolean);
      // a sibling tracked now gets its Wiktionary claim lookup like any newly tracked expression (C2), after its count
      for (const id of created) queueClaims(ctx, id);
      const queryKey = queryKeyOf(def);
      defs.set(queryKey, def);
      persistDef(ctx.db, queryKey, def);
      const job = jobs[0]?.id ?? null;
      if (def.strands.some((s) => s.type === 'expression' && !s.run)) {
        // counting has not produced a first run yet: the lane skeleton waits for "counting… n%" over SSE
        return { json: {
          queryKey, dataVersion: ctx.dataVersion(), status: 'materializing', job,
          units: [], lanes: [], other: { lanes: 0, n: 0 }, extent: { from: null, to: null },
          totals: { n: 0, dated: 0, undated: 0, scheduled: 0, names_excluded: 0, sampled: false, washes_by_tier: {} },
          seams: [], gates: {}, lane_order_note: orderNoteOf(def), provenance: provenanceOf(ctx.db, def),
          ...(def.lanes.facet === 'cluster' ? { lane_state: 'pending', lane_note: 'counting the expression first' } : {}),
        } };
      }
      const revCutoff = Number.isSafeInteger(Number(req.body?.rev_cutoff)) && Number(req.body.rev_cutoff) > 0 ? Number(req.body.rev_cutoff) : null;
      // registering a query reads every lane's coverage, gates and (Term trail) OpenAlex cells; the first one per read
      // worker after a data change builds those from the slice cubes, which can outlast the 5 s default on a loaded machine
      const r = await ctx.pool.run(QUERY_URL, 'timelineQuery', { def, rev_cutoff: revCutoff }, { timeoutMs: 15000 });
      return { json: { queryKey, dataVersion: r.dataVersion, status: 'ready', job, ...(job ? { refreshing: true } : {}), ...r } };
    },
  },
  {
    method: 'GET',
    path: '/api/timeline/tiles',
    heavy: true,
    async handler(req, ctx) {
      const q = req.query.q;
      const def = resolveDef(ctx, q);
      const tier = tierParam(req.query.tier);
      const list = parseTiles(req.query.tiles);
      if (list.length > MAX_TILES) throw new HttpError(400, 'E_VALIDATION', `At most ${MAX_TILES} tiles per request.`, 'Ask for the visible tiles only.');
      const dv = ctx.dataVersion();
      const missing = list.filter((t) => !tiles.has(tileKey(q, tier, t, dv)));
      let binWidth = tier === 'L4' || tier === 'L5' ? null : [1000, 100, 10, 1][TIERS.indexOf(tier)];
      if (missing.length) {
        const r = await ctx.pool.run(TILES_URL, 'tilesQuery', { def, tier, tiles: missing });
        binWidth = r.binWidth;
        for (const t of r.tiles) tiles.set(tileKey(q, tier, t.tile, dv), t);
      }
      return { json: { queryKey: q, tier, binWidth, dataVersion: dv, tiles: list.map((t) => tiles.get(tileKey(q, tier, t, dv))) } };
    },
  },
  {
    method: 'GET',
    path: '/api/timeline/marks',
    heavy: true,
    async handler(req, ctx) {
      const def = resolveDef(ctx, req.query.q);
      const r = await ctx.pool.run(MARKS_URL, 'marksQuery', {
        def, from: intParam(req.query.from, 'from'), to: intParam(req.query.to, 'to'), lane: req.query.lane || null,
        strand: req.query.strand || null, limit: intParam(req.query.limit, 'limit') ?? 4000,
      });
      return { json: r };
    },
  },
  {
    method: 'GET',
    path: '/api/timeline/arcs',
    heavy: true,
    async handler(req, ctx) {
      const def = resolveDef(ctx, req.query.q);
      // at STEMM scale ('gene': 21,490 citation arcs) the arcs of a whole range take seconds on a loaded machine
      const r = await ctx.pool.run(ARCS_URL, 'arcsQuery', {
        def, from: intParam(req.query.from, 'from'), to: intParam(req.query.to, 'to'), vantage: intParam(req.query.vantage, 'vantage'),
        ev: req.query.ev ?? null, limit: intParam(req.query.limit, 'limit') ?? 300, tier: tierParam(req.query.tier),
        rel_rev_cutoff: req.query.rel_rev_cutoff ?? null, rev_cutoff: req.query.rev_cutoff ?? null, runs: req.query.runs ?? null,
        sel: req.query.sel || null, detail: req.query.detail === '1' || req.query.detail === 'true', lanes: req.query.lanes || null,
      }, { timeoutMs: 12000 });
      return { json: r };
    },
  },
  {
    method: 'GET',
    path: '/api/timeline/shelf',
    heavy: true,
    async handler(req, ctx) {
      const def = resolveDef(ctx, req.query.q);
      const r = await ctx.pool.run(SHELF_URL, 'shelfQuery', {
        def, which: req.query.which ?? 'undated', lane: req.query.lane || null, tier: tierParam(req.query.tier),
        cursor: req.query.cursor || null, limit: intParam(req.query.limit, 'limit') ?? 50,
      });
      return { json: r };
    },
  },
  {
    method: 'GET',
    path: '/api/timeline/bin',
    heavy: true,
    async handler(req, ctx) {
      const def = resolveDef(ctx, req.query.q);
      const bin = intParam(req.query.bin, 'bin');
      if (bin === null && !req.query.cell) throw new HttpError(400, 'E_VALIDATION', 'bin is required (or cell, on an OpenAlex share lane).', null, { field: 'bin' });
      const r = await ctx.pool.run(BIN_URL, 'binQuery', {
        def, lane: req.query.lane, strand: req.query.strand || null, tier: tierParam(req.query.tier), bin, cell: req.query.cell || null,
        cursor: req.query.cursor || null, limit: intParam(req.query.limit, 'limit') ?? 50,
      });
      return { json: r };
    },
  },
];
