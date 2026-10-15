// OWNER: WP6
// timeline/hit.mjs — hit-testing (SPEC §8.4): a uniform 24 px spatial grid in CONTENT coordinates, built from
// the display list after layout or zoom (never on pan: the pan offset is subtracted at query time).
// Priority on overlap: mark > arc > cap/fork > bin > wash > band. Every openable primitive gets an entry.

/** Grid cell size in px. */
export const CELL = 24;
/** Hit tolerance in px (touch: 12). */
export const TOLERANCE = Object.freeze({ mouse: 5, touch: 12 });

const PRIORITY = Object.freeze({ mark: 6, arc: 5, cap: 4, bin: 3, wash: 2, band: 1, other: 0 });

/**
 * Hit class of a primitive.
 * @param {{kind: string, style?: string, ref?: object}} p
 * @returns {'mark'|'arc'|'cap'|'bin'|'wash'|'band'|'other'}
 */
export function hitClass(p) {
  const t = p.ref?.type;
  if (t === 'occurrence' || t === 'passage') return 'mark';
  if (t === 'relationship') return 'arc';
  if (p.style?.startsWith('cap-')) return 'cap';
  if (t === 'transition') return 'cap';
  if (t === 'bin' || t === 'cell') return 'bin';
  if (t === 'wash' || t === 'ribbon') return 'wash';
  if (p.kind === 'band' || t === 'uncovered' || t === 'pending' || t === 'seam' || t === 'coverage') return 'band';
  return 'other';
}

/** Bounding box of a primitive (glyphs get a small square around their anchor). */
function bboxOf(p) {
  if (p.kind === 'glyph') return [p.x0 - 6, p.y0 - 7, p.x0 + 6, p.y0 + 7];
  const x0 = Math.min(p.x0, p.x1), x1 = Math.max(p.x0, p.x1);
  const y0 = Math.min(p.y0, p.y1), y1 = Math.max(p.y0, p.y1);
  return [x0, y0, Math.max(x1, x0 + 1), Math.max(y1, y0 + 1)];
}

/**
 * Build a hit grid from display-list primitives. Only primitives with a `ref` or a tooltip are indexed.
 * @param {Array<object>} prims
 * @param {{cell?: number, yOffset?: number, group?: string}} [opts] yOffset shifts the primitives' y (lane area)
 * @returns {{entries: object[], query(x: number, y: number, tol?: number): object|null, queryAll(x: number, y: number, tol?: number): object[], size: number}}
 */
export function buildHitGrid(prims, { cell = CELL, yOffset = 0, group = 'lanes' } = {}) {
  const grid = new Map();
  const entries = [];
  for (const p of prims) {
    if (!p.ref && !p.tip) continue;
    if (p.kind === 'text') continue;
    const [x0, y0, x1, y1] = bboxOf(p);
    const cls = hitClass(p);
    // Arcs are hit along their curve (16 samples, §8.4), not anywhere inside their bounding box.
    const segs = cls === 'arc' && p.points?.length > 1 ? p.points.map(([x, y]) => [x, y + yOffset]) : null;
    const e = { id: p.id, kind: p.kind, cls, bbox: [x0, y0 + yOffset, x1, y1 + yOffset], ref: p.ref, tip: p.tip ?? null,
      openable: Boolean(p.openable), prim: p, group, segs };
    entries.push(e);
    if (segs) {
      const seen = new Set();
      for (let i = 1; i < segs.length; i++) {
        const [ax, ay] = segs[i - 1], [bx, by] = segs[i];
        for (let cx = Math.floor(Math.min(ax, bx) / cell); cx <= Math.floor(Math.max(ax, bx) / cell); cx++) {
          for (let cy = Math.floor(Math.min(ay, by) / cell); cy <= Math.floor(Math.max(ay, by) / cell); cy++) {
            const k = `${cx}:${cy}`;
            if (seen.has(k)) continue;
            seen.add(k);
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(e);
          }
        }
      }
      continue;
    }
    const cx0 = Math.floor(x0 / cell), cx1 = Math.floor(x1 / cell);
    const cy0 = Math.floor((y0 + yOffset) / cell), cy1 = Math.floor((y1 + yOffset) / cell);
    // Wide bands (lane underlays) would fill thousands of cells; they go in a per-row list instead.
    if (cx1 - cx0 > 400) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = `row:${cy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(e);
      }
      continue;
    }
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const k = `${cx}:${cy}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(e);
    }
  }

  function candidates(x, y, tol) {
    const out = new Set();
    for (let cx = Math.floor((x - tol) / cell); cx <= Math.floor((x + tol) / cell); cx++) {
      for (let cy = Math.floor((y - tol) / cell); cy <= Math.floor((y + tol) / cell); cy++) {
        for (const e of grid.get(`${cx}:${cy}`) ?? []) out.add(e);
      }
    }
    for (let cy = Math.floor((y - tol) / cell); cy <= Math.floor((y + tol) / cell); cy++) for (const e of grid.get(`row:${cy}`) ?? []) out.add(e);
    return out;
  }

  function distance(e, x, y) {
    if (e.segs) {
      let best = Infinity;
      for (let i = 1; i < e.segs.length; i++) best = Math.min(best, segDistance(x, y, e.segs[i - 1], e.segs[i]));
      return best;
    }
    const [x0, y0, x1, y1] = e.bbox;
    const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
    const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
    return Math.hypot(dx, dy);
  }

  function queryAll(x, y, tol = TOLERANCE.mouse) {
    const hits = [];
    for (const e of candidates(x, y, tol)) {
      const d = distance(e, x, y);
      // Bands and bins are areas: only a direct hit counts; marks, caps and arcs get the tolerance.
      const allowed = e.cls === 'band' || e.cls === 'bin' || e.cls === 'wash' ? 0.5 : tol;
      if (d <= allowed) hits.push({ ...e, d });
    }
    return hits.sort((a, b) => PRIORITY[b.cls] - PRIORITY[a.cls] || a.d - b.d);
  }

  return {
    entries,
    size: entries.length,
    queryAll,
    query(x, y, tol) { return queryAll(x, y, tol)[0] ?? null; },
  };
}

/** Distance from (x, y) to the segment a–b. */
function segDistance(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
