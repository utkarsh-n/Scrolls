// OWNER: N0
// Normalisation shared by every golden generator (IOS-SPEC §2.2–§2.4): values that legitimately differ between the
// Node reference and the Swift engine — timestamps, data_version, row ids, lone surrogates — are rewritten the same way
// on both sides before comparison. The Swift twin is DifferentialTests/Support (same placeholders, same rules).

/** ISO-8601 / SQLite timestamps as the reference writes them. */
export const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
export const TS = '<ts>';
export const DV = '<dv>';
export const MASKED = '<masked>';

/**
 * A JSON-safe deep copy whose strings are well-formed UTF-16 (a lone surrogate becomes U+FFFD, which is what a Swift
 * String holds). Typed arrays become plain arrays; -0 becomes 0 (JSON cannot carry it).
 */
export function wellFormed(v) {
  if (typeof v === 'string') return v.toWellFormed();
  if (typeof v === 'number') return Object.is(v, -0) ? 0 : v;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v, wellFormed);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k.toWellFormed()] = wellFormed(x);
    return out;
  }
  return v;
}

/**
 * Rewrites what legitimately differs between two runs of the same request:
 *  · strings that are timestamps → '<ts>' (unless `timestamps: false`);
 *  · members named in `dataVersionKeys` → '<dv>';
 *  · members named in `maskKeys` → '<masked>';
 *  · `mapId(key, value, path)` (optional) may return a replacement for id members (natural keys).
 * @param {unknown} value
 * @param {{timestamps?: boolean, dataVersionKeys?: string[], maskKeys?: string[],
 *          mapId?: (key: string, value: unknown, path: string) => unknown}} [opts]
 */
export function normalize(value, { timestamps = true, dataVersionKeys = ['dataVersion', 'data_version'], maskKeys = [],
  mapId = null } = {}) {
  const dv = new Set(dataVersionKeys), mask = new Set(maskKeys);
  const walk = (v, path) => {
    if (typeof v === 'string') return timestamps && TIMESTAMP_RE.test(v) ? TS : v.toWellFormed();
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v, (x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined) continue;
        const p = `${path}.${k}`;
        if (dv.has(k)) out[k] = DV;
        else if (mask.has(k)) out[k] = MASKED;
        else if (mapId) {
          const m = mapId(k, x, p);
          out[k] = m === undefined ? walk(x, p) : m;
        } else out[k] = walk(x, p);
      }
      return out;
    }
    return typeof v === 'number' && Object.is(v, -0) ? 0 : v;
  };
  return walk(value, '$');
}

/** Sorts rows by a key function whose results are compared as canonical strings (stable, locale-free). */
export function sortByKey(rows, keyOf) {
  return rows.map((r, i) => ({ r, i, k: keyOf(r) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i))
    .map((x) => x.r);
}

/**
 * A float rendered as the LogicalDump writes it (IOS-SPEC §2.3): 12 significant digits through Number::toString, so
 * last-ulp noise from summation order never reaches a sha256.
 */
export function float12(x) {
  if (x === null || x === undefined) return null;
  if (!Number.isFinite(x)) return null;
  if (Number.isInteger(x)) return x;
  return Number(x.toPrecision(12));
}

/** Compact delta encoding of a non-decreasing integer list ([3, 5, 9] → [3, 2, 4]); used by large offset goldens. */
export function deltas(list) {
  const out = new Array(list.length);
  let prev = 0;
  for (let i = 0; i < list.length; i++) { out[i] = list[i] - prev; prev = list[i]; }
  return out;
}
