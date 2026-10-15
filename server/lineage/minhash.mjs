// OWNER: WP5
// minhash.mjs — near quotations (SPEC §4.7): units are sentences (verse lines in verse passages) of ≥ 6 tokens;
// MinHash with 128 permutations over word 3-shingles; LSH with 32 bands × 4 rows (collision threshold ≈ 0.42);
// candidates are verified by token Smith–Waterman (align.mjs) and 3-shingle Jaccard.

import { mulberry32 } from '../../src/shared/ids.mjs';

export const PERMS = 128;
export const BANDS = 32;
export const ROWS = 4;
/** Shortest unit (tokens) considered for near quotations. */
export const MIN_UNIT_TOKENS = 6;

const permCache = new Map();
function permutations(perms, seed) {
  const key = `${perms}:${seed}`;
  if (!permCache.has(key)) {
    const rnd = mulberry32(seed);
    const a = new Uint32Array(perms), b = new Uint32Array(perms);
    for (let i = 0; i < perms; i++) {
      a[i] = (Math.floor(rnd() * 0xffffffff) | 1) >>> 0;
      b[i] = Math.floor(rnd() * 0xffffffff) >>> 0;
    }
    permCache.set(key, { a, b });
  }
  return permCache.get(key);
}

/**
 * Hashes of the word 3-shingles of a token-id sequence (a sequence shorter than 3 gives its single shingle).
 * @param {Uint32Array|number[]} ids
 * @returns {Uint32Array} distinct shingle hashes
 */
export function shingles3(ids) {
  const n = ids.length;
  if (n === 0) return new Uint32Array(0);
  const set = new Set();
  const last = Math.max(1, n - 2);
  for (let i = 0; i < last; i++) {
    let h = 0x811c9dc5;
    for (let j = i; j < Math.min(n, i + 3); j++) h = Math.imul(h ^ ids[j], 0x01000193);
    set.add(h >>> 0);
  }
  return Uint32Array.from(set);
}

/**
 * Jaccard similarity of two shingle sets.
 * @param {Uint32Array|number[]} a distinct hashes
 * @param {Uint32Array|number[]} b distinct hashes
 * @returns {number}
 */
export function jaccard(a, b) {
  if (!a.length && !b.length) return 0;
  const sa = new Set(a);
  let inter = 0;
  for (const x of b) if (sa.has(x)) inter++;
  return inter / (sa.size + b.length - inter);
}

/**
 * MinHash signature.
 * @param {Uint32Array|number[]|string[]} shingles shingle hashes (or strings, hashed with FNV-1a)
 * @param {{perms?: number, seed?: number}} [opts]
 * @returns {Uint32Array}
 */
export function minhash(shingles, { perms = PERMS, seed = 42 } = {}) {
  const { a, b } = permutations(perms, seed);
  const sig = new Uint32Array(perms).fill(0xffffffff);
  for (const s of shingles) {
    let h = s;
    if (typeof s === 'string') {
      h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
      h >>>= 0;
    }
    for (let p = 0; p < perms; p++) {
      const v = (Math.imul(a[p], h) + b[p]) >>> 0;
      if (v < sig[p]) sig[p] = v;
    }
  }
  return sig;
}

/**
 * Band keys of a signature: one u32 per band (FNV-1a over the band index and its rows).
 * @param {Uint32Array} signature
 * @param {{bands?: number, rows?: number}} [opts]
 * @returns {number[]}
 */
export function lshBands(signature, { bands = BANDS, rows = ROWS } = {}) {
  const out = new Array(bands);
  for (let band = 0; band < bands; band++) {
    let h = Math.imul(0x811c9dc5 ^ band, 0x01000193);
    for (let r = 0; r < rows; r++) h = Math.imul(h ^ signature[band * rows + r], 0x01000193);
    out[band] = h >>> 0;
  }
  return out;
}

/**
 * Band keys of bands [band0, band1) straight from shingle hashes, without the full signature: equal to
 * lshBands(minhash(shingles)).slice(band0, band1). Lets a large index compute a few bands at a time.
 * @param {Uint32Array|number[]} shingles shingle hashes
 * @param {number} band0
 * @param {number} band1
 * @param {{rows?: number, perms?: number, seed?: number}} [opts]
 * @param {Uint32Array} [out] reused output buffer (length ≥ band1 − band0)
 * @returns {Uint32Array}
 */
export function bandKeysRange(shingles, band0, band1, { rows = ROWS, perms = PERMS, seed = 42 } = {}, out = new Uint32Array(band1 - band0)) {
  const { a, b } = permutations(perms, seed);
  const p0 = band0 * rows, p1 = band1 * rows;
  const sig = new Uint32Array(p1 - p0).fill(0xffffffff);
  for (const h of shingles) {
    for (let p = p0; p < p1; p++) {
      const v = (Math.imul(a[p], h) + b[p]) >>> 0;
      if (v < sig[p - p0]) sig[p - p0] = v;
    }
  }
  for (let band = band0; band < band1; band++) {
    let h = Math.imul(0x811c9dc5 ^ band, 0x01000193);
    for (let r = 0; r < rows; r++) h = Math.imul(h ^ sig[(band - band0) * rows + r], 0x01000193);
    out[band - band0] = h >>> 0;
  }
  return out;
}

const UNIT_BREAK = /[.!?;…।॥]|\n\s*\n/u;
const LINE_BREAK = /\n/;

/**
 * Units of a passage for near-quotation matching: sentences (or lines, in verse) of ≥ 6 tokens. A unit is a
 * token range [t0, t1) of the passage's token list.
 * @param {string} text the passage text
 * @param {{starts: Int32Array|number[], ends: Int32Array|number[]}} tok its tokens (offsets relative to `text`)
 * @param {{verse?: boolean, minTokens?: number}} [opts]
 * @returns {Array<{t0: number, t1: number}>}
 */
export function unitsOf(text, tok, { verse = false, minTokens = MIN_UNIT_TOKENS } = {}) {
  const out = [];
  const n = tok.starts.length;
  let t0 = 0;
  const breakRe = verse ? LINE_BREAK : UNIT_BREAK;
  for (let i = 0; i < n; i++) {
    const gap = text.slice(tok.ends[i], i + 1 < n ? tok.starts[i + 1] : text.length);
    if (i === n - 1 || breakRe.test(gap)) {
      if (i + 1 - t0 >= minTokens) out.push({ t0, t1: i + 1 });
      t0 = i + 1;
    }
  }
  return out;
}
