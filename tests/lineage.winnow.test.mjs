// OWNER: WP5 — winnowing (SPEC §4.7): k = 8, w = 6 guarantees that any shared run of ≥ 13 tokens yields a shared
// fingerprint; density ≈ 2 / (w + 1); stable radix sort of fingerprint records

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fnv1a32, fnv1a32U32, mulberry32 } from '../src/shared/ids.mjs';
import { K, W, radixSortPairs, shingleHashes, tokenIds, winnow } from '../server/lineage/winnow.mjs';

function randomIds(rnd, n, vocab = 50000) {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = fnv1a32(`w${Math.floor(rnd() * vocab)}`);
  return a;
}

describe('winnow', () => {
  test('k = 8, w = 6 (§4.7) and shingles hash with FNV-1a-32 over the ids', () => {
    assert.equal(K, 8);
    assert.equal(W, 6);
    const ids = randomIds(mulberry32(1), 40);
    const h = shingleHashes(ids);
    assert.equal(h.length, 33);
    for (let i = 0; i < h.length; i++) assert.equal(h[i], fnv1a32U32(ids, i, i + 8));
    assert.deepEqual([...tokenIds(['carry', 'the', 'zero'])], ['carry', 'the', 'zero'].map((t) => fnv1a32(t)));
  });

  test('every inserted run of 13 tokens is found (the winnowing guarantee), at any position', () => {
    const rnd = mulberry32(1994);
    for (let trial = 0; trial < 300; trial++) {
      const run = randomIds(rnd, 13);
      const a = randomIds(rnd, 50 + Math.floor(rnd() * 400));
      const b = randomIds(rnd, 50 + Math.floor(rnd() * 400));
      const ia = Math.floor(rnd() * (a.length - 13)), ib = Math.floor(rnd() * (b.length - 13));
      a.set(run, ia);
      b.set(run, ib);
      const fa = winnow(a), fb = winnow(b);
      const inRun = (f, at) => [...f.hashes].filter((_, i) => f.positions[i] >= at && f.positions[i] + K <= at + 13);
      const shared = inRun(fa, ia).filter((h) => inRun(fb, ib).includes(h));
      assert.ok(shared.length >= 1, `trial ${trial}: the shared 13-token run has a common fingerprint`);
    }
  });

  test('density is about 2 / (w + 1) fingerprints per token', () => {
    const ids = randomIds(mulberry32(7), 200000, 1e6);
    const { hashes, positions } = winnow(ids);
    const density = hashes.length / ids.length;
    assert.ok(Math.abs(density - 2 / 7) < 0.02, `density ${density.toFixed(3)}`);
    for (let i = 1; i < positions.length; i++) assert.ok(positions[i] > positions[i - 1], 'positions increase');
    for (let i = 0; i < positions.length; i++) assert.equal(hashes[i], fnv1a32U32(ids, positions[i], positions[i] + 8));
  });

  test('short sequences: < k tokens give nothing; k … k + w − 2 tokens give their minimum', () => {
    const rnd = mulberry32(3);
    assert.equal(winnow(randomIds(rnd, 7)).hashes.length, 0);
    const ids = randomIds(rnd, 10);
    const f = winnow(ids);
    assert.equal(f.hashes.length, 1);
    assert.equal(f.hashes[0], Math.min(...shingleHashes(ids)));
    assert.deepEqual(winnow(ids), winnow(ids.slice()), 'deterministic');
  });
});

describe('radixSortPairs', () => {
  test('sorts by key, stable for equal keys, in place', () => {
    const rnd = mulberry32(11);
    const n = 50000;
    const keys = new Uint32Array(n), vals = new Uint32Array(n);
    for (let i = 0; i < n; i++) { keys[i] = Math.floor(rnd() * 3000) * 1000003 >>> 0; vals[i] = i; }
    const expected = [...keys].map((k, i) => [k, i]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    radixSortPairs(keys, vals);
    assert.deepEqual([...keys], expected.map((x) => x[0]));
    assert.deepEqual([...vals], expected.map((x) => x[1]), 'equal keys keep their input order');
    const one = new Uint32Array([5]);
    radixSortPairs(one, new Uint32Array([1]));
    assert.deepEqual([...one], [5]);
  });
});
