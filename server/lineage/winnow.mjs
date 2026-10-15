// OWNER: WP5
// winnow.mjs — winnowing over token ids (Schleimer, Wilkerson & Aiken 2003; SPEC §4.7): k = 8-token shingles,
// window w = 6. Every window of w consecutive shingle hashes contributes its minimum (the rightmost one on
// ties); consecutive windows that pick the same shingle record it once. Because the choice depends only on
// the window's own hashes, two sequences that share a run of ≥ k + w − 1 = 13 tokens always share at least one
// fingerprint (the guarantee tests/lineage.winnow.test.mjs checks). Expected density ≈ 2 / (w + 1).

import { fnv1a32 } from '../../src/shared/ids.mjs';

/** Default shingle length and window (SPEC §4.7). */
export const K = 8;
export const W = 6;

/**
 * FNV-1a-32 of a folded token string: a vocabulary-independent u32 token id, so fingerprints of the same
 * words agree across documents, runs and processes.
 * @param {string} token
 * @returns {number}
 */
export const tokenId = (token) => fnv1a32(token);

/**
 * Token ids of a folded token list.
 * @param {string[]} tokens
 * @returns {Uint32Array}
 */
export function tokenIds(tokens) {
  const out = new Uint32Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) out[i] = fnv1a32(tokens[i]);
  return out;
}

/**
 * FNV-1a-32 hash of every k-shingle of `ids` (over each id's four little-endian bytes).
 * @param {Uint32Array} ids
 * @param {number} k
 * @returns {Uint32Array} length max(0, ids.length − k + 1)
 */
export function shingleHashes(ids, k = K) {
  const n = ids.length - k + 1;
  if (n <= 0) return new Uint32Array(0);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let h = 0x811c9dc5;
    for (let j = i, e = i + k; j < e; j++) {
      const v = ids[j];
      h = Math.imul(h ^ (v & 255), 0x01000193);
      h = Math.imul(h ^ ((v >>> 8) & 255), 0x01000193);
      h = Math.imul(h ^ ((v >>> 16) & 255), 0x01000193);
      h = Math.imul(h ^ (v >>> 24), 0x01000193);
    }
    out[i] = h >>> 0;
  }
  return out;
}

/**
 * Fingerprints (hash u32, position of the shingle's first token) of a token-id array. A sequence with fewer
 * than w shingles yields its single minimum; one shorter than k yields nothing.
 * @param {Uint32Array} ids
 * @param {{k?: number, w?: number}} [opts]
 * @returns {{hashes: Uint32Array, positions: Uint32Array}}
 */
export function winnow(ids, { k = K, w = W } = {}) {
  const h = shingleHashes(ids, k);
  const n = h.length;
  if (n === 0) return { hashes: new Uint32Array(0), positions: new Uint32Array(0) };
  const win = Math.min(w, n);
  const hashes = new Uint32Array(n);
  const positions = new Uint32Array(n);
  let count = 0, last = -1, min = -1;
  for (let s = 0; s + win <= n; s++) {
    const e = s + win - 1;
    if (min < s) {
      // the previous minimum left the window: rescan it
      min = s;
      for (let j = s + 1; j <= e; j++) if (h[j] <= h[min]) min = j;
    } else if (h[e] <= h[min]) {
      min = e;
    }
    if (min !== last) {
      hashes[count] = h[min];
      positions[count] = min;
      count++;
      last = min;
    }
  }
  return { hashes: hashes.slice(0, count), positions: positions.slice(0, count) };
}

/**
 * Stable LSD radix sort of (key, value) pairs by key (two 16-bit passes). Sorts in place; equal keys keep
 * their input order (so records appended in document order stay grouped by document within a hash).
 * @param {Uint32Array} keys
 * @param {Uint32Array} vals
 * @param {number} [n=keys.length]
 */
export function radixSortPairs(keys, vals, n = keys.length) {
  if (n < 2) return;
  let k1 = keys, v1 = vals;
  let k2 = new Uint32Array(n), v2 = new Uint32Array(n);
  const count = new Uint32Array(65536);
  for (const shift of [0, 16]) {
    count.fill(0);
    for (let i = 0; i < n; i++) count[(k1[i] >>> shift) & 0xffff]++;
    let sum = 0;
    for (let b = 0; b < 65536; b++) { const c = count[b]; count[b] = sum; sum += c; }
    for (let i = 0; i < n; i++) {
      const p = count[(k1[i] >>> shift) & 0xffff]++;
      k2[p] = k1[i];
      v2[p] = v1[i];
    }
    [k1, k2] = [k2, k1];
    [v1, v2] = [v2, v1];
  }
  // two passes: the sorted data is back in the caller's arrays (k1 === keys)
}
