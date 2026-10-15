// OWNER: WP5
// routes/lineage.mjs — the lineage explorer (SPEC §2.C, §7.1). Both queries run in the read pool.
//
//   GET /api/lineage?root=&depth=&dir=&max_nodes=&types=&status=&rejected=&kindred=&runs=   → Lineage (heavy)
//       root=shared:<key> expands a "widely shared text" node into its recorded passages (bounded by max_nodes)
//   GET /api/lineage/path?from=&to=&types=&status=&kindred=&runs=                           → LineagePath (heavy)

const GRAPH = new URL('../lineage/graph.mjs', import.meta.url).href;
const PATH = new URL('../lineage/path.mjs', import.meta.url).href;

/** @type {Array<{method: string, path: string, heavy?: boolean, sse?: boolean, handler: Function}>} */
export const routes = [
  { method: 'GET', path: '/api/lineage', heavy: true, handler: async (req, ctx) => ({ json: await ctx.pool.run(GRAPH, 'lineageQuery', req.query) }) },
  { method: 'GET', path: '/api/lineage/path', heavy: true, handler: async (req, ctx) => ({ json: await ctx.pool.run(PATH, 'pathQuery', req.query) }) },
];
