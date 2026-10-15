// OWNER: WP5
// routes/genealogy.mjs — the sampling family tree (SPEC §2.C2). Runs in the read pool.
//
//   GET /api/genealogy?work=document:61002|maker=<name or slug>&dir=forward|back|both&depth=&types=&status=&max=&cursor=   → Genealogy (heavy)
//       defaults: types samples,interpolates,cover_of,remix_of,version_of · status documented · depth 3 · max 150 rows

const GENEALOGY = new URL('../lineage/genealogy.mjs', import.meta.url).href;

/** @type {Array<{method: string, path: string, heavy?: boolean, sse?: boolean, handler: Function}>} */
export const routes = [
  { method: 'GET', path: '/api/genealogy', heavy: true, handler: async (req, ctx) => ({ json: await ctx.pool.run(GENEALOGY, 'genealogyQuery', req.query) }) },
];
