// OWNER: WP7
// panels/layout.worker.mjs — client relayout for constellation expansions (SPEC §2.B "stable layout", §8.1).
// Deterministic Fruchterman–Reingold: 300 iterations, seed = FNV-1a-32 of the layout key, then a collision
// pass; nodes that already have positions are pinned, so expanding never moves what was on screen. The same
// key and input always give the same positions. Runs as a module worker:
//   new Worker(WORKERS['panels/layout.worker.mjs'], { type: 'module' })
//   postMessage({ id, key, nodes: [{id, pos?: [x, y], r?}], edges: [{s, t}] })  →  { id, positions: {nodeId: [x, y]} }
// and exports stableLayout() for the main thread and tests.

import { fnv1a32, mulberry32 } from '../../shared/ids.mjs';

export const ITERATIONS = 300;

/**
 * Lay out nodes in the unit square. Pinned nodes (with `pos`) never move.
 * @param {{key: string, nodes: Array<{id: string, pos?: [number, number]|null, r?: number}>, edges?: Array<{s: string, t: string}>,
 *          iterations?: number}} input
 * @returns {Record<string, [number, number]>} positions in [0, 1]²
 */
export function stableLayout({ key, nodes, edges = [], iterations = ITERATIONS }) {
  const rnd = mulberry32(fnv1a32(String(key)));
  const n = nodes.length;
  if (!n) return {};
  const idx = new Map(nodes.map((x, i) => [x.id, i]));
  const px = new Float64Array(n), py = new Float64Array(n);
  const pinned = new Uint8Array(n);
  nodes.forEach((x, i) => {
    if (Array.isArray(x.pos) && x.pos.length === 2 && x.pos.every(Number.isFinite)) { px[i] = x.pos[0]; py[i] = x.pos[1]; pinned[i] = 1; }
    else { px[i] = 0.1 + 0.8 * rnd(); py[i] = 0.1 + 0.8 * rnd(); }
  });
  const links = edges.map((e) => [idx.get(e.s), idx.get(e.t)]).filter(([a, b]) => a !== undefined && b !== undefined && a !== b);
  const k = Math.sqrt(1 / n);
  let temp = 0.1;
  const dx = new Float64Array(n), dy = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    dx.fill(0); dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let vx = px[i] - px[j], vy = py[i] - py[j];
        let d2 = vx * vx + vy * vy;
        if (d2 < 1e-12) { vx = (rnd() - 0.5) * 1e-3; vy = (rnd() - 0.5) * 1e-3; d2 = vx * vx + vy * vy; }
        const f = (k * k) / d2;
        dx[i] += vx * f; dy[i] += vy * f; dx[j] -= vx * f; dy[j] -= vy * f;
      }
    }
    for (const [a, b] of links) {
      const vx = px[a] - px[b], vy = py[a] - py[b];
      const d = Math.sqrt(vx * vx + vy * vy) || 1e-6;
      const f = d / k;
      dx[a] -= vx * f; dy[a] -= vy * f; dx[b] += vx * f; dy[b] += vy * f;
    }
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
      const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      px[i] = Math.min(0.97, Math.max(0.03, px[i] + (dx[i] / len) * Math.min(len, temp)));
      py[i] = Math.min(0.97, Math.max(0.03, py[i] + (dy[i] / len) * Math.min(len, temp)));
    }
    temp *= 0.985;
  }
  // Collision pass: push free nodes apart until radii (in unit units) no longer overlap.
  for (let pass = 0; pass < 30; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ri = nodes[i].r ?? 0.02, rj = nodes[j].r ?? 0.02;
        const vx = px[j] - px[i], vy = py[j] - py[i];
        const d = Math.sqrt(vx * vx + vy * vy) || 1e-6;
        const overlap = ri + rj - d;
        if (overlap <= 0 || (pinned[i] && pinned[j])) continue;
        moved = true;
        const ux = vx / d, uy = vy / d;
        const share = pinned[i] ? 1 : pinned[j] ? 0 : 0.5;
        if (!pinned[i]) { px[i] -= ux * overlap * (1 - share); py[i] -= uy * overlap * (1 - share); }
        if (!pinned[j]) { px[j] += ux * overlap * share; py[j] += uy * overlap * share; }
      }
    }
    if (!moved) break;
  }
  const out = {};
  nodes.forEach((x, i) => { out[x.id] = [Number(px[i].toFixed(4)), Number(py[i].toFixed(4))]; });
  return out;
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (event) => {
    const msg = event.data ?? {};
    try {
      self.postMessage({ id: msg.id ?? null, positions: stableLayout(msg) });
    } catch (err) {
      self.postMessage({ id: msg.id ?? null, error: { code: 'E_LAYOUT', message: String(err?.message ?? err) } });
    }
  };
}
