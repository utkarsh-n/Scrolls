// OWNER: WP5
// align.mjs — verification of reuse candidates (SPEC §4.7): seed-and-extend to maximal common runs of token ids
// (exact quotations), and token Smith–Waterman (+2 match, −1 mismatch, −1 gap) for near quotations.

/**
 * Maximal common runs grown from shared fingerprints. A seed {a, b} says a[a…] and b[b…] probably start the same
 * shingle; it is verified token by token and extended both ways. Seeds already inside a found run (same
 * diagonal) are skipped, so each run is reported once.
 * @param {Uint32Array|number[]} a token ids
 * @param {Uint32Array|number[]} b token ids
 * @param {Array<{a: number, b: number}>} seeds
 * @param {{minRun?: number, aLo?: number, aHi?: number, bLo?: number, bHi?: number}} [opts] runs never cross the
 *   [lo, hi) limits (e.g. a document's body, or a traced span)
 * @returns {Array<{a0: number, a1: number, b0: number, b1: number, len: number}>} sorted by a0
 */
export function seedExtend(a, b, seeds, { minRun = 8, aLo = 0, aHi = a.length, bLo = 0, bHi = b.length } = {}) {
  const runs = [];
  const byDiagonal = new Map();
  const sorted = [...seeds].sort((x, y) => (x.a - x.b) - (y.a - y.b) || x.a - y.a);
  for (const s of sorted) {
    if (s.a < aLo || s.a >= aHi || s.b < bLo || s.b >= bHi) continue;
    const d = s.a - s.b;
    const covered = byDiagonal.get(d);
    if (covered && covered.some((r) => s.a >= r.a0 && s.a < r.a1)) continue;
    if (a[s.a] !== b[s.b]) continue;
    let a0 = s.a, b0 = s.b;
    while (a0 > aLo && b0 > bLo && a[a0 - 1] === b[b0 - 1]) { a0--; b0--; }
    let a1 = s.a + 1, b1 = s.b + 1;
    while (a1 < aHi && b1 < bHi && a[a1] === b[b1]) { a1++; b1++; }
    const run = { a0, a1, b0, b1, len: a1 - a0 };
    if (covered) covered.push(run); else byDiagonal.set(d, [run]);
    if (run.len >= minRun) runs.push(run);
  }
  return runs.sort((x, y) => x.a0 - y.a0 || x.b0 - y.b0);
}

/**
 * Seeds from scratch: every position where a k-gram of `a` (inside [aLo, aHi)) also starts in `b`. Used by the
 * targeted trace, where one side is a short span.
 * @param {Uint32Array|number[]} a
 * @param {Uint32Array|number[]} b
 * @param {{k?: number, aLo?: number, aHi?: number}} [opts]
 * @returns {Array<{a: number, b: number}>}
 */
export function kgramSeeds(a, b, { k = 8, aLo = 0, aHi = a.length } = {}) {
  const key = (arr, i) => {
    let h = 0x811c9dc5;
    for (let j = i; j < i + k; j++) h = Math.imul(h ^ arr[j], 0x01000193);
    return h >>> 0;
  };
  const index = new Map();
  for (let i = aLo; i + k <= aHi; i++) {
    const h = key(a, i);
    const list = index.get(h);
    if (list) list.push(i); else index.set(h, [i]);
  }
  const seeds = [];
  for (let j = 0; j + k <= b.length; j++) {
    const list = index.get(key(b, j));
    if (list) for (const i of list) seeds.push({ a: i, b: j });
  }
  return seeds;
}

/**
 * Local alignment score and spans of two token arrays (Smith–Waterman, linear gaps).
 * `normalized` = score / (match × length of the shorter array): 1 for an exact containment.
 * @param {Uint32Array|number[]|string[]} a
 * @param {Uint32Array|number[]|string[]} b
 * @param {{match?: number, mismatch?: number, gap?: number}} [opts]
 * @returns {{score: number, normalized: number, aStart: number, aEnd: number, bStart: number, bEnd: number}}
 */
export function smithWaterman(a, b, { match = 2, mismatch = -1, gap = -1 } = {}) {
  const n = a.length, m = b.length;
  if (!n || !m) return { score: 0, normalized: 0, aStart: 0, aEnd: 0, bStart: 0, bEnd: 0 };
  let prev = new Float64Array(m + 1), cur = new Float64Array(m + 1);
  let prevSi = new Int32Array(m + 1), curSi = new Int32Array(m + 1);
  let prevSj = new Int32Array(m + 1), curSj = new Int32Array(m + 1);
  let best = { score: 0, i: 0, j: 0, si: 0, sj: 0 };
  for (let i = 1; i <= n; i++) {
    cur[0] = 0;
    for (let j = 1; j <= m; j++) {
      const diag = prev[j - 1] + (a[i - 1] === b[j - 1] ? match : mismatch);
      const up = prev[j] + gap;
      const left = cur[j - 1] + gap;
      let v = 0, si = i, sj = j;
      if (diag > v) { v = diag; si = prev[j - 1] > 0 ? prevSi[j - 1] : i; sj = prev[j - 1] > 0 ? prevSj[j - 1] : j; }
      if (up > v) { v = up; si = prevSi[j]; sj = prevSj[j]; }
      if (left > v) { v = left; si = curSi[j - 1]; sj = curSj[j - 1]; }
      cur[j] = v;
      curSi[j] = si;
      curSj[j] = sj;
      if (v > best.score) best = { score: v, i, j, si, sj };
    }
    [prev, cur] = [cur, prev];
    [prevSi, curSi] = [curSi, prevSi];
    [prevSj, curSj] = [curSj, prevSj];
  }
  return {
    score: best.score,
    normalized: best.score / (match * Math.min(n, m)),
    aStart: best.score ? best.si - 1 : 0,
    aEnd: best.i,
    bStart: best.score ? best.sj - 1 : 0,
    bEnd: best.j,
  };
}
