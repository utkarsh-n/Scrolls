// OWNER: WP4 — exact intervals, tests, corrections, composition, keyness, collocation scoring and the
// multiplicity rule (SPEC §2.E, §4.6, §4.9), against reference values computed independently.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { collocates } from '../server/analysis/collocations.mjs';
import { compositionJsd, normalize, standardizedRates, topShare } from '../server/analysis/composition.mjs';
import {
  benjaminiHochberg, betaI, betaIInv, chi2Quantile, chi2Sf, clopperPearsonCI, gammaP, gammaPInv, garwoodCI, g2, griesDP, lnGamma,
  normalQuantile, poissonRate, poissonRateRatio, proportionRate, wilsonCI, Z95,
} from '../server/analysis/intervals.mjs';
import { keyness } from '../server/analysis/keyness.mjs';
import { comparisonHash, expressionKey, multiplicityBlock, notableThreshold, ordinal } from '../server/analysis/multiplicity.mjs';

const close = (actual, expected, tol, label) => assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected} (±${tol})`);

describe('distribution functions', () => {
  test('lnGamma matches factorials and Γ(1/2)', () => {
    close(lnGamma(1), 0, 1e-12, 'lnΓ(1)');
    close(lnGamma(10), Math.log(362880), 1e-10, 'lnΓ(10)');
    close(lnGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-12, 'lnΓ(½)');
  });

  test('chi-square quantiles (reference table values)', () => {
    close(chi2Quantile(0.975, 2), 7.377759, 1e-5, 'χ²(.975, 2)');
    close(chi2Quantile(0.025, 2), 0.0506356, 1e-6, 'χ²(.025, 2)');
    close(chi2Quantile(0.975, 4), 11.143287, 1e-5, 'χ²(.975, 4)');
    close(chi2Quantile(0.95, 1), 3.841459, 1e-5, 'χ²(.95, 1)');
    close(chi2Quantile(0.999, 1), 10.827566, 1e-5, 'χ²(.999, 1)');
    close(chi2Quantile(0.5, 100), 99.334128, 1e-4, 'χ²(.5, 100)');
  });

  test('chi-square survival: 10.83 is p ≈ .001 and 3.84 is p ≈ .05 at one degree of freedom', () => {
    close(chi2Sf(10.83, 1), 0.000999, 2e-6, 'sf(10.83)');
    close(chi2Sf(3.841459, 1), 0.05, 1e-7, 'sf(3.84)');
    assert.equal(chi2Sf(0, 1), 1);
    assert.ok(chi2Sf(300, 1) > 0 && chi2Sf(300, 1) < 1e-60, 'tail without cancellation');
  });

  test('incomplete gamma and beta invert each other', () => {
    for (const [a, p] of [[0.5, 0.3], [3, 0.025], [60, 0.975], [1000, 0.5]]) close(gammaP(a, gammaPInv(a, p)), p, 1e-10, `P(${a})`);
    for (const [a, b, p] of [[1, 1e5, 0.025], [2, 3, 0.5], [50, 7, 0.975], [0.5, 0.5, 0.1]]) close(betaI(a, b, betaIInv(a, b, p)), p, 1e-10, `I(${a},${b})`);
  });

  test('normal quantile', () => {
    close(Z95, 1.959964, 1e-6, 'z.975');
    close(normalQuantile(0.025), -1.959964, 1e-6, 'z.025');
    close(normalQuantile(0.5), 0, 1e-12, 'z.5');
    close(normalQuantile(1e-6), -4.753424, 1e-5, 'z(1e-6)');
  });
});

describe('exact intervals (§4.6)', () => {
  test('Garwood (exact Poisson) intervals match published values', () => {
    const [l0, h0] = garwoodCI(0);
    assert.equal(l0, 0);
    close(h0, 3.688879, 1e-5, 'n=0 upper');
    const [l1, h1] = garwoodCI(1);
    close(l1, 0.025318, 1e-6, 'n=1 lower');
    close(h1, 5.571643, 1e-5, 'n=1 upper');
    const [l10, h10] = garwoodCI(10);
    close(l10, 4.795389, 1e-5, 'n=10 lower');
    close(h10, 18.390356, 1e-5, 'n=10 upper');
  });

  test('a rate per million tokens with its Garwood interval (the §7.2 example: 61 in 21,400 tokens)', () => {
    const r = poissonRate(61, 21400);
    close(r.rate, 2850.47, 0.01, 'rate');
    close(r.ci[0], 2180.38, 0.01, 'lower');
    close(r.ci[1], 3661.54, 0.01, 'upper');
  });

  test('Wilson and Clopper–Pearson intervals for 5 of 20', () => {
    const [wl, wh] = wilsonCI(5, 20);
    close(wl, 0.111862, 1e-6, 'Wilson lower');
    close(wh, 0.468701, 1e-6, 'Wilson upper');
    const [cl, ch] = clopperPearsonCI(5, 20);
    close(cl, 0.086571, 1e-6, 'CP lower');
    close(ch, 0.491046, 1e-6, 'CP upper');
    assert.deepEqual(clopperPearsonCI(0, 20).map((x) => Number(x.toFixed(4))), [0, 0.1684]);
    const pr = proportionRate(5, 20, 1000);
    close(pr.rate, 250, 1e-9, 'per 1,000 works');
    close(pr.ci[0], 111.862, 1e-3, 'per 1,000 works lower');
  });

  test('rate ratio: exact conditional interval (61/21,400 vs 122/30,100 → 1.42 [1.04, 1.97])', () => {
    const rr = poissonRateRatio(61, 21400, 122, 30100);
    close(rr.value, 1.4219, 1e-4, 'ratio');
    close(rr.ci[0], 1.0374, 1e-3, 'lower');
    close(rr.ci[1], 1.9667, 1e-3, 'upper');
    assert.equal(rr.unbounded, false);
  });

  test('rate ratio with zeros: no value and no upper bound when A is empty; undefined when both are', () => {
    const inf = poissonRateRatio(0, 1000, 5, 1000);
    assert.equal(inf.value, null);
    assert.equal(inf.ci[1], null);
    assert.ok(inf.ci[0] > 0);
    assert.equal(inf.unbounded, true);
    const zero = poissonRateRatio(5, 1000, 0, 1000);
    assert.equal(zero.value, 0);
    assert.equal(zero.ci[0], 0);
    assert.deepEqual(poissonRateRatio(0, 1000, 0, 1000), { value: null, ci: null, unbounded: false });
  });
});

describe('tests and corrections', () => {
  test("Dunning's G² on hand-computed tables", () => {
    close(g2(1, 0, 0, 1), 4 * Math.log(2), 1e-12, 'diagonal 2×2');
    assert.equal(g2(5, 5, 5, 5), 0, 'independence');
    // [[10, 90], [20, 880]]: 2 Σ O ln(O/E)
    const o = [10, 90, 20, 880], n = 1000, e = [100 * 30 / n, 100 * 970 / n, 900 * 30 / n, 900 * 970 / n];
    close(g2(...o), 2 * o.reduce((s, x, i) => s + x * Math.log(x / e[i]), 0), 1e-9, 'textbook table');
  });

  test('Benjamini–Hochberg step-up, in input order', () => {
    assert.deepEqual(benjaminiHochberg([0.01, 0.04, 0.03, 0.005]).map((q) => Number(q.toFixed(6))), [0.02, 0.04, 0.04, 0.02]);
    assert.deepEqual(benjaminiHochberg([]), []);
    assert.ok(benjaminiHochberg([0.9, 0.95]).every((q) => q <= 1));
  });

  test("Gries' DP: even spread is 0, all in one of two equal parts is 0.5", () => {
    assert.equal(griesDP([{ n: 5, size: 100 }, { n: 5, size: 100 }]), 0);
    assert.equal(griesDP([{ n: 10, size: 100 }, { n: 0, size: 100 }]), 0.5);
    close(griesDP([{ n: 9, size: 10 }, { n: 1, size: 90 }]), 0.8, 1e-12, 'concentrated in the small part');
    assert.equal(griesDP([{ n: 0, size: 10 }]), null);
  });
});

describe('composition (§2.E item 1, §4.9)', () => {
  test('JSD base 2: identical 0, disjoint 1, symmetric, a known value', () => {
    assert.equal(compositionJsd({ book: 3, song: 1 }, { book: 30, song: 10 }), 0);
    assert.equal(compositionJsd({ book: 1 }, { song: 1 }), 1);
    const a = { memo: 0.6, bulletin: 0.4 }, b = { memo: 0.2, song: 0.8 };
    close(compositionJsd(a, b), compositionJsd(b, a), 1e-15, 'symmetry');
    // JSD([.5,.5],[1,0]) = H(.75,.25) − (1 + 0)/2
    const h = -(0.75 * Math.log2(0.75) + 0.25 * Math.log2(0.25));
    close(compositionJsd({ x: 1, y: 1 }, { x: 1 }), h - 0.5, 1e-12, 'known value');
    assert.equal(compositionJsd({}, { x: 1 }), null);
  });

  test('normalize and topShare', () => {
    assert.deepEqual(normalize({ a: 1, b: 3, c: 0 }), { a: 0.25, b: 0.75 });
    assert.deepEqual(topShare({ a: 0.25, b: 0.75 }), { key: 'b', share: 0.75 });
  });

  test('direct standardization uses pooled weights over strata both slices cover', () => {
    const strata = new Map([
      ['book|en|x', { a: { n: 10, denom: 1000 }, b: { n: 40, denom: 2000 } }],   // 0.01 vs 0.02
      ['song|en|y', { a: { n: 6, denom: 3000 }, b: { n: 2, denom: 1000 } }],     // 0.002 vs 0.002
      ['film|en|z', { a: { n: 0, denom: 0 }, b: { n: 9, denom: 500 } }],         // B only: not used
    ]);
    const s = standardizedRates(strata, { scale: 1 });
    const total = 1000 + 2000 + 3000 + 1000 + 500;
    const w1 = 3000 / total, w2 = 4000 / total, cov = w1 + w2;
    close(s.a, (w1 * 0.01 + w2 * 0.002) / cov, 1e-12, 'A');
    close(s.b, (w1 * 0.02 + w2 * 0.002) / cov, 1e-12, 'B');
    assert.equal(s.strata, 2);
    close(s.weight_covered, cov, 1e-12, 'weight covered');
    assert.equal(standardizedRates(new Map([['k', { a: { n: 1, denom: 10 }, b: { n: 0, denom: 0 } }]])), null);
    // fix pass: the share of each slice's matches inside the shared strata travels with the rates
    const part = standardizedRates(new Map([['shared', { a: { n: 0, denom: 100 }, b: { n: 5, denom: 100 } }],
      ['only-a', { a: { n: 9, denom: 1000 }, b: { n: 0, denom: 0 } }]]), { scale: 1 });
    assert.equal(part.a, 0, 'the shared stratum holds none of A’s matches');
    assert.equal(part.matches_covered.a, 0);
    assert.equal(part.matches_covered.b, 1);
  });
});

describe('keyness and collocation scoring', () => {
  test('keyness: log ratio sign and side, BH filter, zero replaced by 0.5', () => {
    const a = new Map([['auditors', 40], ['place', 10], ['the', 500]]);
    const b = new Map([['counted', 45], ['place', 12], ['the', 520]]);
    const rows = keyness(a, b, { totalA: 1000, totalB: 1000 });
    const byTerm = Object.fromEntries(rows.map((r) => [r.term, r]));
    assert.equal(byTerm.auditors.side, 'a');
    close(byTerm.auditors.log_ratio, Math.log2((0.5 / 1000) / (40 / 1000)), 1e-12, 'log ratio with 0.5 for zero');
    assert.equal(byTerm.counted.side, 'b');
    assert.equal(byTerm.place, undefined, 'not significant');
    assert.ok(rows.every((r) => r.q < 0.05));
  });

  test('collocates: logDice and PPMI formulas, thresholds, stop-words hidden and counted', () => {
    const ctx = {
      fxy: new Map([['auditors', 30], ['the', 40], ['rare', 4], ['common', 6]]),
      fy: new Map([['auditors', 32], ['the', 300], ['rare', 4], ['common', 2000]]),
      fx: 50, W: 500, N: 10000, sumFyAlpha: 1000, stop: new Set(['the']),
    };
    const out = collocates(ctx);
    assert.deepEqual(out.rows.map((r) => r.term), ['auditors']);
    const r = out.rows[0];
    close(r.logDice, 14 + Math.log2(2 * 30 / (50 + 32)), 0.006, 'logDice');
    close(r.ppmi, Math.log2((30 / 500) / (32 ** 0.75 / 1000)), 0.006, 'PPMI α=0.75');
    assert.ok(r.g2 >= 10.83 && r.q < 0.05);
    assert.equal(out.hidden_stopwords, 1, '"the" is significant here but hidden');
    assert.equal(out.candidates, 3, 'rare (f_xy 4 < 5) is not a candidate');
    const shown = collocates(ctx, { showStop: true });
    assert.ok(shown.rows.some((x) => x.term === 'the'));
    assert.ok(!shown.rows.some((x) => x.term === 'common'), 'repulsion is never a collocate');
  });
});

describe('multiplicity (§2.E item 0, §4.9)', () => {
  test('notable threshold = 100 − 5/k', () => {
    assert.equal(notableThreshold(1), 95);
    assert.equal(notableThreshold(2), 97.5);
    close(notableThreshold(7), 100 - 5 / 7, 1e-12, 'k=7');
    for (let k = 1; k <= 50; k++) assert.equal(notableThreshold(k), 100 - 5 / k);
  });

  test('ordinals and the disclosure sentence of §2.E', () => {
    assert.equal(ordinal(95), '95th');
    assert.equal(ordinal(97.5), '97.5th');
    assert.equal(ordinal(100 - 5 / 7), '99.3rd');
    assert.equal(ordinal(100 - 5 / 6), '99.2nd');
    assert.equal(ordinal(11), '11th');
    assert.equal(ordinal(21), '21st');
    const m7 = multiplicityBlock({ k: 7, notableSoFar: 1, label: 'virus' });
    assert.equal(m7.text, "Comparison #7 for 'virus' in this session; 1 of 7 crossed the notable threshold; with 7 comparisons, " +
      '~0.35 are expected by chance at the 95th percentile. Notable threshold is adjusted to the 99.3rd percentile.');
    assert.equal(m7.threshold_percentile, 99.2857);
    assert.equal(multiplicityBlock({ k: 1, label: 'carry the zero' }).text,
      "Comparison #1 for 'carry the zero' in this session; the notable threshold is the 95th percentile.");
  });

  test('the same comparison hashes the same; the passage seed and lane facet do not count', () => {
    const req = { expr: [12], a: { years: [1955, 1985], f: '' }, b: { years: [1994, 2026], f: '' }, measures: ['freq'], toggles: { tr: 0 } };
    assert.equal(comparisonHash(req), comparisonHash({ ...req, seed: 5, lane_facet: 'community' }));
    assert.notEqual(comparisonHash(req), comparisonHash({ ...req, b: { years: [1990, 2026], f: '' } }));
    assert.equal(expressionKey([13, 12, 12]), 'expr:12+13');
  });
});
