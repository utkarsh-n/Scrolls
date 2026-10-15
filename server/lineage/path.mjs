// OWNER: WP5
// path.mjs — chain of custody (SPEC §2.C): the least-evidence-cost path between two items, costing documented
// 1, computed 3, proposed 5 (rejected links excluded); the chain is as strong as its weakest link. Directed links
// are followed from the later/dependent item to its source (src → dst); undirected ones either way. When no
// chain runs from `from` to `to`, the reverse direction is tried.

import { HttpError } from '../http/errors.mjs';
import { stmt } from '../db/open.mjs';
import { asOfRows, edgeFilters, edgeJson, edgeWhere } from './graph.mjs';

export const COST = Object.freeze({ documented: 1, computed: 3, proposed: 5 });
const STRENGTH = ['proposed', 'computed', 'documented'];
/** Nodes a search may settle before it gives up (keeps the query bounded on large graphs). */
export const NODE_BUDGET = 20000;

const invalid = (message, field) => new HttpError(400, 'E_VALIDATION', message, null, { field });

class MinHeap {
  constructor() { this.a = []; }
  push(x) {
    const a = this.a;
    a.push(x);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

function search(db, f, from, to, where, params) {
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const heap = new MinHeap();
  heap.push({ ref: from, cost: 0 });
  let settled = 0;
  while (heap.size) {
    const { ref, cost } = heap.pop();
    if (cost > dist.get(ref)) continue;
    if (ref === to) break;
    if (++settled > NODE_BUDGET) return { budget: true };
    const i = ref.indexOf(':');
    const type = ref.slice(0, i), id = ref.slice(i + 1);
    const out = asOfRows(db, f, stmt(db, `SELECT r.* FROM relationship r WHERE r.src_type = ? AND r.src_ref = ? AND ${where}`)
      .all(type, id, ...params)).map((r) => [r, `${r.dst_type}:${r.dst_ref}`]);
    const back = asOfRows(db, f, stmt(db, `SELECT r.* FROM relationship r WHERE r.dst_type = ? AND r.dst_ref = ? AND r.directed = 0 AND ${where}`)
      .all(type, id, ...params)).map((r) => [r, `${r.src_type}:${r.src_ref}`]);
    for (const [r, next] of [...out, ...back]) {
      const c = cost + COST[r.evidence_status];
      if (c < (dist.get(next) ?? Infinity)) {
        dist.set(next, c);
        prev.set(next, { ref, r });
        heap.push({ ref: next, cost: c });
      }
    }
  }
  if (!dist.has(to)) return null;
  const chain = [];
  for (let cur = to; cur !== from;) {
    const step = prev.get(cur);
    chain.unshift(step.r);
    cur = step.ref;
  }
  return { chain, cost: dist.get(to) };
}

/**
 * GET /api/lineage/path?from=&to=&types=&status=&kindred=&runs=&rel_rev_cutoff= — read pool.
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {object} args
 * @returns {{path: object[], cost: number, weakest: string|null, text?: string, note?: string, from: string, to: string, reversed: boolean}}
 */
export function pathQuery(db, args = {}) {
  const from = String(args.from ?? ''), to = String(args.to ?? '');
  for (const [k, v] of [['from', from], ['to', to]]) if (!/^[a-z_]+:.+/.test(v)) throw invalid(`${k} must be a reference like 'passage:77'.`, k);
  if (from === to) throw invalid('from and to are the same item.', 'to');
  const f = edgeFilters({ ...args, rejected: '0' });
  const [where, params] = edgeWhere(f);
  let found = search(db, f, from, to, where, params);
  let reversed = false;
  if (!found || found.budget) {
    const back = search(db, f, to, from, where, params);
    if (back && !back.budget) { found = back; reversed = true; }
  }
  if (!found || found.budget) {
    return { from, to, reversed: false, path: [], cost: 0, weakest: null,
      note: found?.budget ? `No chain found within ${NODE_BUDGET.toLocaleString('en-US')} linked items; narrow the types or statuses.`
        : 'No chain of recorded links joins these two items (rejected links are excluded).' };
  }
  const path = found.chain.map((r) => ({ ...edgeJson(r), cost: COST[r.evidence_status] }));
  const weakest = STRENGTH.find((s) => path.some((e) => e.evidence_status === s));
  return {
    from: reversed ? to : from,
    to: reversed ? from : to,
    reversed,
    path,
    cost: found.cost,
    weakest,
    text: `Chain strength: weakest link ${weakest.toUpperCase()}.`,
  };
}
