// OWNER: WP5
// near.mjs — near quotations at corpus scale (SPEC §4.7): units are sentences (verse lines in verse) of ≥ 6 tokens;
// MinHash with 128 permutations over word 3-shingles; LSH with 32 bands × 4 rows (collision threshold ≈ 0.42);
// candidates verified by token Smith–Waterman (+2/−1/−1, normalized ≥ 0.75 of the shorter unit) and 3-shingle
// Jaccard ≥ 0.5, both scores stored. A near quotation also needs an aligned stretch of ≥ 10 tokens with ≥ 3 content
// words: on real books, shorter matches are stock phrases ("I couldn't help it", "I beg your pardon, I'm sure")
// shared by unrelated novels, not quotations; they are counted and sampled ('short_match'), as are lists of names or
// titles. (Longer stock sentences still pass — "she went to the window and stood there, looking out" — and are labelled
// computed like every near quotation; a word-rarity gate was tried and dropped because it also removed famous lines
// made of common words, such as "life, liberty, and the pursuit of happiness".)
// Memory stays bounded: band keys are computed eight bands at a time (4 bytes per unit per band), each band is
// radix-sorted, and buckets of more than 50 units (formulae shared by many texts) are skipped. A sentence whose
// verified matches span more than 25 documents is a commonplace, never a pair.
//
// The index is kept for lookups (the targeted trace): derived/reuse/run-<id>/units.bin and lsh.bin.
//   units.bin  u32 LE: 'SCRU', version 1, n, then passage[n], t0[n], t1[n] (token range inside the passage)
//   lsh.bin    u32 LE: 'SCRL', version 1, bands, rows, perms, seed, maxBucket, count[bands], then per band
//              keys[count] (ascending) and units[count] — only keys shared by 2…maxBucket units (collisions).

import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { smithWaterman } from './align.mjs';
import { Growable } from './corpus.mjs';
import { contentTokens, inEdgeZone, informative, isNameList, PRODUCTION, stableFlagShare } from './filters.mjs';
import { BANDS, bandKeysRange, jaccard, lshBands, minhash, PERMS, ROWS, shingles3 } from './minhash.mjs';
import { radixSortPairs } from './winnow.mjs';

/** Near-pass parameters of §4.7 and the bounded-memory settings. */
export const NEAR = Object.freeze({
  bands: BANDS, rows: ROWS, perms: PERMS, seed: 42, bandsPerPass: 8, maxBucket: 50, minScore: 0.75, minJaccard: 0.5, maxDocs: 25,
  minTokens: 10, minContent: 3,
});
const MAGIC_UNITS = 0x55524353; // 'SCRU'
const MAGIC_LSH = 0x4c524353;   // 'SCRL'
const VERSION = 1;
const MAX_UNITS = 2 ** 23;      // pair keys are u · 2^23 + v (exact in a double)

/**
 * Sentence pairs that pass the near-quotation alignment (Smith–Waterman and Jaccard), found through LSH buckets.
 * @param {import('./corpus.mjs').ScopeCorpus} corpus with units collected
 * @param {{fp?: {positions: Uint32Array, flags: Uint8Array, docFp: Uint32Array, k: number, w: number, mask: number},
 *   checkpoint?: () => void, progress?: (f: number, msg: string) => void, keepIndex?: boolean}} [opts]
 *   `fp` lets a unit made mostly of production-line or widespread fingerprints be skipped
 * @returns {{verified: Array<{u: number, v: number, sw: object, ja: number}>, counts: object, index: object|null}}
 */
export function nearVerified(corpus, { fp = null, checkpoint = () => {}, progress = () => {}, keepIndex = true } = {}) {
  const [uDoc, uT0, uT1] = corpus.units.cols;
  const n = corpus.unitCount;
  const counts = { units: n, candidates: 0, jaccard_passed: 0, aligned: 0, big_buckets: 0, production_units: 0 };
  if (n < 2) return { verified: [], counts, index: null };
  if (n > MAX_UNITS) throw new RangeError(`near pass: ${n} units exceed ${MAX_UNITS}`);
  const ids = corpus.ids;
  const verified = new Map(); // u·2^23+v → {u, v, sw, ja} | null (checked, failed)
  const keys = Array.from({ length: NEAR.bandsPerPass }, () => new Uint32Array(n));
  const out = new Uint32Array(NEAR.bandsPerPass);
  const order = new Uint32Array(n), sorted = new Uint32Array(n);
  const index = keepIndex ? { keys: [], units: [] } : null;
  const skipUnit = new Uint8Array(n); // 1 production/widespread
  if (fp) {
    for (let u = 0; u < n; u++) {
      const d = uDoc[u], base = corpus.docStart[d];
      const s = stableFlagShare(corpus.docIds(d), uT0[u] - base, uT1[u] - base,
        { positions: fp.positions, flags: fp.flags, lo: fp.docFp[d], hi: fp.docFp[d + 1], k: fp.k, w: fp.w, mask: fp.mask });
      if (s.total > 0 && s.flagged * 2 >= s.total) { skipUnit[u] = 1; counts.production_units++; }
    }
  }
  const shingleCache = new Map();
  const shOf = (u) => {
    let s = shingleCache.get(u);
    if (!s) { s = shingles3(ids.subarray(uT0[u], uT1[u])); shingleCache.set(u, s); }
    return s;
  };

  for (let b0 = 0; b0 < NEAR.bands; b0 += NEAR.bandsPerPass) {
    const b1 = Math.min(NEAR.bands, b0 + NEAR.bandsPerPass);
    for (let u = 0; u < n; u++) {
      if ((u & 8191) === 0) { checkpoint(); progress((b0 + (b1 - b0) * u / n) / NEAR.bands, `near: minhash bands ${b0}–${b1 - 1}`); }
      bandKeysRange(shingles3(ids.subarray(uT0[u], uT1[u])), b0, b1, NEAR, out);
      for (let j = 0; j < b1 - b0; j++) keys[j][u] = out[j];
    }
    for (let band = b0; band < b1; band++) {
      checkpoint();
      sorted.set(keys[band - b0]);
      for (let i = 0; i < n; i++) order[i] = i;
      radixSortPairs(sorted, order, n);
      const keep = index ? new Growable(2, 1 << 12) : null;
      for (let i = 0; i < n;) {
        let j = i;
        while (j < n && sorted[j] === sorted[i]) j++;
        const size = j - i;
        if (size >= 2 && size <= NEAR.maxBucket) {
          if (keep) for (let x = i; x < j; x++) keep.push(sorted[x], order[x]);
          shingleCache.clear();
          for (let x = i; x < j; x++) {
            const u0 = order[x];
            if (skipUnit[u0]) continue;
            for (let y = x + 1; y < j; y++) {
              const v0 = order[y];
              if (skipUnit[v0] || uDoc[u0] === uDoc[v0]) continue;
              const [u, v] = u0 < v0 ? [u0, v0] : [v0, u0];
              const key = u * MAX_UNITS + v;
              if (verified.has(key)) continue;
              counts.candidates++;
              const ja = jaccard(shOf(u), shOf(v));
              if (ja < NEAR.minJaccard) continue;
              counts.jaccard_passed++;
              const sw = smithWaterman(ids.subarray(uT0[u], uT1[u]), ids.subarray(uT0[v], uT1[v]));
              // a pair is checked once; failures are remembered too, so other bands do not repeat the alignment
              verified.set(key, sw.normalized >= NEAR.minScore ? { u, v, sw, ja } : null);
            }
          }
        } else if (size > NEAR.maxBucket) {
          counts.big_buckets++;
        }
        i = j;
      }
      if (keep) { index.keys[band] = keep.cols[0].slice(0, keep.n); index.units[band] = keep.cols[1].slice(0, keep.n); }
    }
  }
  const list = [...verified.values()].filter(Boolean);
  counts.aligned = list.length;
  return { verified: list, counts, index };
}

/**
 * Which aligned sentence pairs are near quotations. Not: pairs `exclude` names (reprints, same work); structure and
 * lists of names or titles; stretches under 10 tokens or with fewer than 3 content words; sentences matched in more
 * than 25 documents (commonplaces); sentences matched in ≥ 3 documents, always in their first/last 15% (production-line
 * text).
 * @param {import('./corpus.mjs').ScopeCorpus} corpus
 * @param {Array<{u: number, v: number, sw: object, ja: number}>} verified
 * @param {{exclude?: (u: number, v: number) => boolean, log?: import('./filters.mjs').ExclusionLog}} [opts]
 * @returns {{pairs: Array<{u: number, v: number, sw: object, ja: number}>, counts: object}}
 */
export function acceptNear(corpus, verified, { exclude = () => false, log = null } = {}) {
  const [uDoc, uT0, uT1] = corpus.units.cols;
  const ids = corpus.ids;
  const counts = { excluded: 0, structural: 0, short_matches: 0, lists: 0, commonplace_units: 0, production_units: 0, accepted: 0 };
  const textOf = (a0, a1) => { const s = corpus.span(a0, a1); return s.text.slice(s.start, s.end); };
  const matches = new Map(); // unit → matched units
  const good = [];
  for (const x of verified) {
    if (exclude(x.u, x.v)) { counts.excluded++; continue; }
    const a0 = uT0[x.u] + x.sw.aStart, a1 = uT0[x.u] + x.sw.aEnd;
    if (!informative(ids, a0, a1, corpus.classes)) { counts.structural++; continue; }
    if (a1 - a0 < NEAR.minTokens || contentTokens(ids, a0, a1, corpus.classes) < NEAR.minContent) {
      counts.short_matches++;
      if (log && counts.short_matches % 97 === 1) log.add('short_match', textOf(a0, a1));
      continue;
    }
    const text = textOf(a0, a1);
    if (isNameList(text)) { counts.lists++; log?.add('name_list', text); continue; }
    good.push(x);
    for (const [a, b] of [[x.u, x.v], [x.v, x.u]]) {
      if (!matches.has(a)) matches.set(a, []);
      matches.get(a).push(b);
    }
  }
  const atEdge = (x) => inEdgeZone(uT0[x] - corpus.docStart[uDoc[x]], corpus.docLength(uDoc[x]), PRODUCTION.edge);
  const dropped = new Set();
  for (const [u, list] of matches) {
    const docs = new Set(list.map((v) => uDoc[v]));
    if (docs.size > NEAR.maxDocs) {
      dropped.add(u);
      counts.commonplace_units++;
      log?.add('commonplace_sentence', textOf(uT0[u], uT1[u]), { documents: docs.size + 1 });
    } else if (docs.size + 1 >= PRODUCTION.minDocs && atEdge(u) && list.every(atEdge)) {
      dropped.add(u);
      counts.production_units++;
      log?.add('production_line', textOf(uT0[u], uT1[u]), { documents: docs.size + 1, kind: 'near' });
    }
  }
  const pairs = good.filter((x) => !dropped.has(x.u) && !dropped.has(x.v));
  counts.accepted = pairs.length;
  return { pairs, counts };
}

const u32 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);

/**
 * Write units.bin and lsh.bin of a run.
 * @param {string} dir derived/reuse/run-<id>
 * @param {import('./corpus.mjs').ScopeCorpus} corpus
 * @param {{keys: Uint32Array[], units: Uint32Array[]}} index
 * @returns {{units_bytes: number, lsh_bytes: number, lsh_entries: number}}
 */
export function writeNearIndex(dir, corpus, index) {
  mkdirSync(dir, { recursive: true });
  const n = corpus.unitCount;
  const [, uT0, uT1] = corpus.units.cols;
  const passage = new Uint32Array(n), t0 = new Uint32Array(n), t1 = new Uint32Array(n);
  for (let u = 0; u < n; u++) {
    const p = corpus.passageAt(uT0[u]);
    passage[u] = p.id;
    t0[u] = uT0[u] - p.t0;
    t1[u] = uT1[u] - p.t0;
  }
  const unitsBuf = Buffer.concat([u32(Uint32Array.of(MAGIC_UNITS, VERSION, n)), u32(passage), u32(t0), u32(t1)]);
  const countsArr = Uint32Array.from({ length: NEAR.bands }, (_, b) => index.keys[b]?.length ?? 0);
  const parts = [u32(Uint32Array.of(MAGIC_LSH, VERSION, NEAR.bands, NEAR.rows, NEAR.perms, NEAR.seed, NEAR.maxBucket)), u32(countsArr)];
  for (let b = 0; b < NEAR.bands; b++) parts.push(u32(index.keys[b] ?? new Uint32Array(0)), u32(index.units[b] ?? new Uint32Array(0)));
  const lshBuf = Buffer.concat(parts);
  writeFileSync(path.join(dir, 'units.bin'), unitsBuf);
  writeFileSync(path.join(dir, 'lsh.bin'), lshBuf);
  return { units_bytes: unitsBuf.length, lsh_bytes: lshBuf.length, lsh_entries: countsArr.reduce((s, x) => s + x, 0) };
}

function readU32(fd, offset, count) {
  const buf = Buffer.alloc(count * 4);
  readSync(fd, buf, 0, buf.length, offset);
  return new Uint32Array(buf.buffer, buf.byteOffset, count);
}

/**
 * LSH lookup in a stored index (targeted trace): the indexed units that share at least one band key with a
 * sentence's token ids. Reads only the parts of the files it needs (binary search per band).
 * @param {string} dir derived/reuse/run-<id>
 * @param {Uint32Array} unitIds token ids of the query sentence
 * @param {{max?: number}} [opts]
 * @returns {Array<{passage: number, t0: number, t1: number, unit: number}>|null} null when the index is missing or unreadable
 */
export function lookupNear(dir, unitIds, { max = 200 } = {}) {
  let fl, fu;
  try {
    fl = openSync(path.join(dir, 'lsh.bin'), 'r');
    fu = openSync(path.join(dir, 'units.bin'), 'r');
  } catch {
    if (fl !== undefined) closeSync(fl);
    return null;
  }
  try {
    const head = readU32(fl, 0, 7);
    if (head[0] !== MAGIC_LSH || head[1] !== VERSION) return null;
    const bands = head[2];
    const counts = readU32(fl, 28, bands);
    const keys = lshBands(minhash(shingles3(unitIds), { perms: head[4], seed: head[5] }), { bands, rows: head[3] });
    const units = new Set();
    let offset = 28 + bands * 4;
    for (let b = 0; b < bands && units.size < max; b++) {
      const c = counts[b];
      let lo = 0, hi = c;
      while (lo < hi) { const m = (lo + hi) >>> 1; if (readU32(fl, offset + m * 4, 1)[0] < keys[b]) lo = m + 1; else hi = m; }
      for (let i = lo; i < c && units.size < max; i++) {
        if (readU32(fl, offset + i * 4, 1)[0] !== keys[b]) break;
        units.add(readU32(fl, offset + (c + i) * 4, 1)[0]);
      }
      offset += c * 8;
    }
    const uh = readU32(fu, 0, 3);
    if (uh[0] !== MAGIC_UNITS || uh[1] !== VERSION) return null;
    const n = uh[2];
    return [...units].map((u) => ({ unit: u, passage: readU32(fu, 12 + u * 4, 1)[0], t0: readU32(fu, 12 + (n + u) * 4, 1)[0],
      t1: readU32(fu, 12 + (2 * n + u) * 4, 1)[0] }));
  } finally {
    closeSync(fl);
    closeSync(fu);
  }
}
