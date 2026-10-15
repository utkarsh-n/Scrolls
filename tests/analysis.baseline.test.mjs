// OWNER: WP4 — Compare's external-baseline correlation (SPEC §10.2, §2.E): Spearman ρ with average ranks, the
// moving-block bootstrap, the decade gate (≥ 8 decades up to 2019 with our rate gate met and ≥ 500 books in
// Google's decade), variant forms summed on the baseline side, the cases that have no baseline, and the field in a
// real Compare payload. Every corpus and series here is invented for the test (a stub replaces the Ngram store).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { check } from '../src/shared/contracts.mjs';
import { BASELINE_RHO, baselineRho, blockBootstrapRho, ranks, spearman } from '../server/analysis/baseline-rho.mjs';
import { compareContext, compareQuery } from '../server/analysis/compare.mjs';
import { buildAnalysisCorpus, ERA_A, ERA_B, materializeForTest } from './analysis.fixture.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'silent';

describe('Spearman ρ and its block bootstrap', () => {
  test('average ranks share tied positions', () => {
    assert.deepEqual(Array.from(ranks([10, 20, 20, 30])), [1, 2.5, 2.5, 4]);
    assert.deepEqual(Array.from(ranks([3, 1, 2])), [3, 1, 2]);
  });

  test('ρ = 1 for a monotone pair, −1 reversed, the textbook value otherwise; null for a constant series', () => {
    assert.equal(spearman([1, 2, 3, 4], [10, 20, 35, 90]), 1);
    assert.equal(spearman([1, 2, 3, 4], [9, 7, 2, 1]), -1);
    // IQ vs hours of TV (the standard worked example): ρ = −29/165
    const iq = [106, 86, 100, 101, 99, 103, 97, 113, 112, 110], tv = [7, 0, 27, 50, 28, 29, 20, 12, 6, 17];
    assert.ok(Math.abs(spearman(iq, tv) - (-29 / 165)) < 1e-12);
    assert.equal(spearman([1, 2, 3], [5, 5, 5]), null);
    assert.throws(() => spearman([1, 2], [1]), RangeError);
  });

  test('the moving-block bootstrap is seeded, bounded and brackets a strong correlation', () => {
    const x = Array.from({ length: 12 }, (_, i) => i + (i % 3) * 0.5), y = x.map((v, i) => v * 2 + (i % 2));
    const a = blockBootstrapRho(x, y), b = blockBootstrapRho(x, y);
    assert.deepEqual(a, b);
    assert.ok(a.ci[0] <= a.ci[1] && a.ci[0] >= -1 && a.ci[1] <= 1);
    assert.ok(a.ci[1] > 0.8, JSON.stringify(a));
    assert.equal(a.used + a.skipped, BASELINE_RHO.resamples);
  });
});

/** An invented comparison context: one document per decade, `tokens` tokens and n occurrences each. */
function fakeContext({ decades, n, tokens = 100000, a = [1800, 1849], b = [1850, 1899], fa = '', fb = '', lang = 'en', norm = 'ledger',
  modality = 'text', variants = ['ledger', 'ledgers'] }) {
  const evidence = [], cover = [];
  decades.forEach((d, i) => {
    const t = Array.isArray(tokens) ? tokens[i] : tokens;
    cover.push({ y_lo: d + 4, y_hi: d + 5, units: t, unitsNoTr: t, docs: 1, authors: [] });
    if (n[i] > 0) evidence.push({ y_lo: d + 4, y_hi: d + 5, n: n[i], author: null });
  });
  const index = { evidence, cover, bounds: [decades[0], decades[decades.length - 1] + 9], unit: 'tokens' };
  const stats = { modality, gateUnits: 50000 };
  return {
    exprs: [{ id: 1, surface: norm, norm, lang, variants: variants.map((v) => ({ id: null, norm: v, tokens: v.split(' '), lang })) }],
    req: { a: { years: a, f: fa }, b: { years: b, f: fb } }, statsA: stats, statsB: stats, sampled: false, indexOf: () => index,
  };
}

/** A stub of the Ngram lookup: per-decade matches of each form over shared yearly totals. */
function stubLookup(table, { volumes = 900 } = {}) {
  const calls = [];
  const lookup = (word, range) => {
    calls.push(word);
    const m = table[word];
    if (!m) return { available: false, reason: `'${word}' is not in the store` };
    const decades = Object.entries(m).map(([d, matches]) => ({ decade: Number(d), matches, tokens: 1e9, volumes: typeof volumes === 'function' ? volumes(Number(d)) : volumes }))
      .filter((x) => (range.from === null || x.decade + 9 >= range.from) && (range.to === null || x.decade <= range.to));
    return { available: true, word, label: 'Google Books Ngram, English, 2020 edition — a different corpus (stub)', attribution: 'stub', license: 'CC BY 3.0',
      decades, caveats: [] };
  };
  return { lookup, calls };
}

const DECADES = [1800, 1810, 1820, 1830, 1840, 1850, 1860, 1870, 1880, 1890];

describe('baselineRho on an invented comparison', () => {
  test('ρ over the shared decades, with the variant forms summed on the baseline side', () => {
    const n = [1, 3, 2, 5, 4, 8, 7, 9, 12, 11];
    const cx = fakeContext({ decades: DECADES, n });
    const ledger = Object.fromEntries(DECADES.map((d, i) => [d, 100 + 40 * i]));
    const ledgers = Object.fromEntries(DECADES.map((d, i) => [d, i === 2 ? 900 : 10]));
    const { lookup, calls } = stubLookup({ ledger, ledgers });
    const r = baselineRho(cx, { lookup });
    assert.equal(r.gate, 'ok');
    assert.equal(r.n_bins, 10);
    assert.equal(r.available, true);
    assert.deepEqual(calls.sort(), ['ledger', 'ledgers']);
    const theirs = DECADES.map((d) => (ledger[d] + ledgers[d]) / 1e9 * 1e6);
    const ours = n.map((v) => v / 100000 * 1e6);
    assert.equal(r.value, Number(spearman(ours, theirs).toFixed(2)));
    assert.ok(r.ci[0] <= r.value && r.value <= r.ci[1], JSON.stringify(r.ci));
    assert.deepEqual(r.forms, ['ledger', 'ledgers']);
    assert.match(r.note, /different corpus, different composition/i);
    assert.match(r.text, /Does our sample track a larger corpus\? ρ = /);
    assert.equal(r.unit, 'per million tokens');
    assert.equal(r.license, 'CC BY 3.0');
  });

  test('7 adequate decades are a gate card with no ρ; 8 pass (boundary)', () => {
    const n = DECADES.map((_, i) => i + 1);
    const table = { ledger: Object.fromEntries(DECADES.map((d, i) => [d, 50 * (i + 1)])), ledgers: {} };
    // decades 1870–1890 below our rate gate (49,999 tokens) → 7 shared
    const thin = baselineRho(fakeContext({ decades: DECADES, n, tokens: DECADES.map((_, i) => (i >= 7 ? 49999 : 100000)) }), stubLookup(table));
    assert.equal(thin.gate, 'insufficient_coverage');
    assert.equal(thin.value, null);
    assert.equal(thin.ci, null);
    assert.deepEqual(thin.needed, { decades: 8 });
    assert.deepEqual(thin.have, { decades: 7 });
    assert.deepEqual(check('GatedValue', thin), []);
    // a decade under our rate gate shows its count and tokens, never a rate
    const low = thin.series.find((s) => s.decade === 1880);
    assert.equal(low.rate, null);
    assert.equal(low.low_coverage, true);
    assert.equal(low.n, 9);
    const ok = baselineRho(fakeContext({ decades: DECADES, n, tokens: DECADES.map((_, i) => (i >= 8 ? 49999 : 100000)) }), stubLookup(table));
    assert.equal(ok.gate, 'ok');
    assert.equal(ok.n_bins, 8);
  });

  test("a Google decade under 500 books does not count; years after 2019 never enter", () => {
    const decades = [1940, 1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];
    const n = decades.map((_, i) => i + 2);
    const table = { ledger: Object.fromEntries(decades.map((d, i) => [d, 10 * (i + 1)])) };
    const cx = fakeContext({ decades, n, a: [1940, 1979], b: [1980, 2026] });
    const r = baselineRho(cx, stubLookup(table, { volumes: (d) => (d === 1940 ? 499 : 900) }));
    assert.equal(r.gate, 'insufficient_coverage');
    assert.equal(r.have.decades, 7); // 1950–2010: 1940 is thin, 2020–2026 is past 2019
    assert.ok(r.series.every((s) => s.decade + 9 <= 2019));
    assert.equal(r.series.find((s) => s.decade === 1940).thin, true);
  });

  test('a constant rate has no ρ (gate), and the missing variant forms are listed', () => {
    const r = baselineRho(fakeContext({ decades: DECADES, n: DECADES.map(() => 0) }), stubLookup({ ledger: Object.fromEntries(DECADES.map((d, i) => [d, i])) }));
    assert.equal(r.gate, 'insufficient_occurrences');
    assert.equal(r.value, null);
    assert.match(r.note, /no occurrence in any/);
    assert.deepEqual(r.forms_missing, ['ledgers']);
  });

  test('different slice filters: each decade is measured under the filter of the slice it lies in, gaps skipped', () => {
    const cx = fakeContext({ decades: DECADES, n: DECADES.map((_, i) => i), a: [1800, 1839], b: [1860, 1899], fa: 'kind:memo', fb: 'kind:song' });
    const seen = [];
    cx.indexOf = (which) => { seen.push(which); return fakeContext({ decades: DECADES, n: DECADES.map((_, i) => i) }).indexOf(); };
    const r = baselineRho(cx, stubLookup({ ledger: Object.fromEntries(DECADES.map((d, i) => [d, i * 3])) }));
    assert.deepEqual(r.series.map((s) => [s.decade, s.slice]), [[1800, 'a'], [1810, 'a'], [1820, 'a'], [1830, 'a'], [1860, 'b'], [1870, 'b'], [1880, 'b'], [1890, 'b']]);
    assert.equal(r.gate, 'ok');
    assert.ok(seen.includes('a') && seen.includes('b'));
  });

  test('no baseline for phrases, other languages, two expressions, titles, OpenAlex cells or a word the store lacks', () => {
    const base = { decades: DECADES, n: DECADES.map((_, i) => i) };
    const { lookup } = stubLookup({ ledger: { 1800: 1 } });
    assert.match(baselineRho(fakeContext({ ...base, norm: 'carry the zero', variants: ['carry the zero'] }), { lookup }).reason, /single words only/);
    assert.match(baselineRho(fakeContext({ ...base, lang: 'fr' }), { lookup }).reason, /English words only/);
    assert.match(baselineRho(fakeContext({ ...base, modality: 'titles' }), { lookup }).reason, /book text/);
    const two = fakeContext(base);
    two.exprs = [two.exprs[0], { ...two.exprs[0], id: 2 }];
    assert.match(baselineRho(two, { lookup }).reason, /one expression/);
    const oa = fakeContext(base);
    oa.sampled = true;
    assert.match(baselineRho(oa, { lookup }).reason, /top-cited samples/);
    const none = baselineRho(fakeContext({ ...base, norm: 'zyx', variants: ['zyx'] }), { lookup });
    assert.equal(none.available, false);
    assert.match(none.reason, /not in the store/);
    assert.equal(none.note, none.reason, 'the sentence the panel prints');
  });
});

describe('baseline_rho in a Compare payload (synthetic corpus, no Ngram store staged)', () => {
  let tmp, ledger;
  before(() => {
    tmp = makeTmpData({ seed: false });
    buildAnalysisCorpus(tmp.db);
    ledger = materializeForTest(tmp.db, { surface: 'ledger' });
  });
  after(() => tmp.cleanup());

  test('the field is present, says why there is no baseline, and the payload keeps the Compare contract', () => {
    const p = compareQuery(tmp.db, { expr: [ledger.exprId], a: { years: ERA_A }, b: { years: ERA_B }, seed: 3 });
    assert.equal(p.baseline_rho.available, false);
    assert.match(p.baseline_rho.reason, /not staged/);
    assert.deepEqual(check('Compare', p), []);
  });

  test('with a stub store the fixture is gated: its text covers too few decades', () => {
    const cx = compareContext(tmp.db, { expr: [ledger.exprId], a: { years: ERA_A }, b: { years: ERA_B } });
    const table = { ledger: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [1900 + 10 * i, 100 + i])) };
    const r = baselineRho(cx, stubLookup(table));
    assert.equal(r.gate, 'insufficient_coverage');
    assert.equal(r.value, null);
    assert.ok(r.have.decades < 8);
    assert.ok(r.series.every((s) => s.decade >= 1900 && s.decade + 9 <= 2019));
  });
});
