// OWNER: WP3
// routes/kwic.mjs — the concordance (SPEC §4.4, §7.1): KWIC rows (±12 tokens from the original, clipped at the
// passage) sorted by date or spread; each row opens its passage. Heavy: runs in the read pool.
//
//   GET /api/kwic?expr=&from=&to=&lane=&sort=date|spread&cursor=&limit=     (default slice of the expression's corpus)
//   GET /api/kwic?q=<queryKey>&expr=&…                                       (the slice of a registered timeline query)
//   …&runs=<run ids>&import_batch=&at=                                      (as saved, RF-2: a saved view's pinned runs,
//                                                                             import cutoff and save time, D17)

import { HttpError } from '../http/errors.mjs';
import { ensureMaterialized, getExpression } from '../aggregate/materialize.mjs';
import { buildDef, canonicalRequest } from '../aggregate/query.mjs';
import { stmt } from '../db/open.mjs';
import { resolveDef } from './timeline.mjs';

const KWIC_URL = new URL('../text/kwic.mjs', import.meta.url).href;

const intParam = (v, field) => {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, 'E_VALIDATION', `${field} must be an integer (got '${v}').`, null, { field });
  return n;
};

/**
 * RF-2 (D17): the expression's counting run among a saved view's pinned runs (`runs`, comma-separated run ids, as the
 * lineage and arcs reads take them), or null when none of them counts it.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|undefined} runs
 * @param {number} expr
 * @returns {number|null}
 */
export function pinnedMaterializeRun(db, runs, expr) {
  if (runs === undefined || runs === null || runs === '') return null;
  const ids = String(runs).split(',').map((x) => x.trim()).filter(Boolean).map((x) => intParam(x, 'runs'));
  return stmt(db, `SELECT id FROM analysis_run WHERE id IN (SELECT value FROM json_each(?)) AND stage = 'materialize' AND status = 'succeeded'
    AND json_extract(params_json, '$.expression') = ? ORDER BY id DESC LIMIT 1`).get(JSON.stringify(ids), expr)?.id ?? null;
}

/** @type {Array<{method: string, path: string, heavy?: boolean, handler: Function}>} */
export const routes = [
  {
    method: 'GET',
    path: '/api/kwic',
    heavy: true,
    async handler(req, ctx) {
      const q = req.query;
      const expr = intParam(q.expr, 'expr');
      let def;
      if (q.q) {
        def = resolveDef(ctx, q.q);
      } else {
        if (expr === null) throw new HttpError(400, 'E_VALIDATION', 'expr (an expression id) or q (a queryKey) is required.', null, { field: 'expr' });
        const e = getExpression(ctx.db, expr);
        if (!e) throw new HttpError(404, 'E_NOT_FOUND', `No expression ${expr}.`);
        const corpus = q.corpus ?? (e.corpus_id === null ? null : stmt(ctx.db, 'SELECT slug FROM corpus WHERE id = ?').get(e.corpus_id)?.slug);
        if (!corpus) throw new HttpError(400, 'E_VALIDATION', 'corpus is required for an expression tracked across corpora.', null, { field: 'corpus' });
        // as saved (RF-2): the view's counting run and its cutoffs, exactly as its timeline query sends them
        const pinned = pinnedMaterializeRun(ctx.db, q.runs, expr);
        const importBatch = intParam(q.import_batch, 'import_batch');
        const at = q.at ? String(q.at) : null;
        const cutoffs = importBatch !== null || at ? { ...(importBatch !== null ? { import_batch: importBatch } : {}), ...(at ? { at } : {}) } : null;
        if (pinned === null) ensureMaterialized(ctx.db, ctx.jobs, expr);
        def = buildDef(ctx.db, canonicalRequest({ corpus, strands: [{ type: 'expression', ref: expr }],
          lanes: { facet: q.facet ?? 'language' }, f: q.f ?? '', ...(pinned !== null ? { runs: { materialize: { [expr]: pinned } } } : {}),
          ...(cutoffs ? { cutoffs } : {}) })).def;
      }
      const r = await ctx.pool.run(KWIC_URL, 'kwicQuery', {
        def, expr, from: intParam(q.from, 'from'), to: intParam(q.to, 'to'), lane: q.lane || null, sort: q.sort ?? 'date',
        cursor: q.cursor || null, limit: intParam(q.limit, 'limit') ?? 50,
      });
      return { json: r };
    },
  },
];
