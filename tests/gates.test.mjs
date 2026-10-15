// OWNER: WP4 — insufficient evidence never yields a value (SPEC I4, §4.11, §11 row 7, §13 rule 7).
//
// Boundary fixtures at 49/50 occurrences, 4/5 documents, 2/3 authors, top-document share 0.51/0.50,
// 2.99M/3M tokens and 2,999/3,000 anchors: gate ≠ ok ⇒ value = null (and the DB CHECK rejects a gated
// drift_result row with a value); composition JSD > 0.4 suppresses aligned displacement; modality mismatch
// and OpenAlex cross-cell comparisons are refused; widening suggestions are computed and never cross the
// other slice; a whole Compare payload on thin evidence carries no numeral in any gated object.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { check } from '../src/shared/contracts.mjs';
import { GATE_CODES } from '../src/shared/vocab.mjs';
import { clusterGate, compareQuery, driftGate, spaceSizeGate } from '../server/analysis/compare.mjs';
import { evaluateGate, gated, meets, NO_WIDENING_NOTE, THRESHOLDS, widenSuggestion } from '../server/analysis/gates.mjs';
import { windowStats } from '../server/analysis/slices.mjs';
import { nowIso } from '../server/db/open.mjs';
import { buildAnalysisCorpus, materializeForTest } from './analysis.fixture.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

/** Every object in a payload whose gate is not 'ok' carries no value, interval or percentile. */
function assertNoGatedNumerals(obj, path = '$') {
  if (obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach((x, i) => assertNoGatedNumerals(x, `${path}[${i}]`)); return; }
  if (typeof obj.gate === 'string' && obj.gate !== 'ok') {
    assert.ok(GATE_CODES.includes(obj.gate), `${path}: unknown gate ${obj.gate}`);
    for (const k of ['value', 'ci', 'ci_lo', 'ci_hi', 'null_percentile', 'rate']) {
      if (k in obj) assert.equal(obj[k], null, `${path}.${k} must be null when gated (${obj.gate})`);
    }
    for (const k of ['needed', 'have', 'suggestion']) assert.ok(k in obj, `${path}: a gate card needs ${k}`);
  }
  for (const [k, v] of Object.entries(obj)) assertNoGatedNumerals(v, `${path}.${k}`);
}

/** Slice stats as compare.mjs builds them, for the gate functions. */
function stats({ n = 200, docs = 30, authors = 10, top = 0.1, tokens = 4_000_000, unit = 'tokens', years = [1900, 1949], which = 'a' } = {}) {
  return { which, years, unit, modality: 'text', n, k: docs, evidenceDocs: docs, evidenceAuthors: new Set(Array.from({ length: authors }, (_, i) => `x${i}`)),
    topDocShare: top, units: tokens, unitsNoTr: tokens };
}
const noSuggest = () => null;
const ctxFor = (a, b, extra = {}) => ({ statsA: a, statsB: b, jsd: 0.1, descriptive: false, sampled: false, suggest: noSuggest,
  evidenceText: { text: () => '', data: () => ({}) }, allTime: { n: a.n + b.n, docs: a.evidenceDocs + b.evidenceDocs }, label: 'x', ...extra });

describe('evaluateGate and gated()', () => {
  test('a passing criterion set yields null; a failing one names only what fails, with no value', () => {
    assert.equal(evaluateGate('insufficient_occurrences', { occurrences: 50 }, { occurrences: 50 }), null);
    const g = evaluateGate('insufficient_occurrences', { occurrences: 50, documents: 5 }, { occurrences: 49, documents: 5 });
    assert.deepEqual({ gate: g.gate, value: g.value, ci: g.ci, needed: g.needed, have: g.have, suggestion: g.suggestion },
      { gate: 'insufficient_occurrences', value: null, ci: null, needed: { occurrences: 50 }, have: { occurrences: 49 }, suggestion: null });
    assert.deepEqual(check('GatedValue', g), []);
  });

  test('boundaries: 49/50, 4/5, 2/3, 0.51/0.50 (an upper bound), 2.99M/3M, 2,999/3,000 anchors', () => {
    const cases = [
      ['insufficient_occurrences', { occurrences: 50 }, { occurrences: 49 }, { occurrences: 50 }],
      ['insufficient_documents', { documents: 5 }, { documents: 4 }, { documents: 5 }],
      ['insufficient_authors', { authors: 3 }, { authors: 2 }, { authors: 3 }],
      ['single_source', { max_top_doc_share: 0.5 }, { max_top_doc_share: 0.51 }, { max_top_doc_share: 0.5 }],
      ['slice_too_small', { tokens: 3_000_000 }, { tokens: 2_990_000 }, { tokens: 3_000_000 }],
      ['unaligned', { anchors: 3000 }, { anchors: 2999 }, { anchors: 3000 }],
    ];
    for (const [code, needed, fail, pass] of cases) {
      const g = evaluateGate(code, needed, fail);
      assert.equal(g.gate, code);
      assert.equal(g.value, null);
      assert.equal(g.ci, null);
      assert.equal(evaluateGate(code, needed, pass), null, `${code} passes at the boundary`);
    }
    assert.ok(evaluateGate('single_source', { max_top_doc_share: 0.5 }, { max_top_doc_share: null }), 'unknown share fails');
  });

  test('gated() refuses to make a card for a passing gate; the contract check rejects a gated object with a value', () => {
    assert.throws(() => gated('ok', { needed: {}, have: {} }), TypeError);
    const bad = { ...gated('slice_too_small', { needed: { tokens_per_slice: 3e6 }, have: { a: 1 } }), value: 0.37 };
    assert.ok(check('GatedValue', bad).some((e) => /gated \(slice_too_small\) but carries a value/.test(e)));
  });
});

describe('drift measures at their gate boundaries (§4.9)', () => {
  const T = THRESHOLDS;
  test('(a) context-share shift: 49 occ, 4 docs, 2 authors, share 0.51 each gate; passing all gives not_run until a clustering run exists', () => {
    const ok = stats();
    const expectGate = (b, code) => {
      const g = driftGate('sense_share_jsd', ctxFor(ok, b));
      assert.equal(g.gate, code);
      assert.equal(g.value, null);
      assert.equal(g.ci, null);
    };
    expectGate(stats({ n: T.sense_share_jsd.occurrences - 1, which: 'b' }), 'insufficient_occurrences');
    expectGate(stats({ docs: T.sense_share_jsd.documents - 1, which: 'b' }), 'insufficient_documents');
    expectGate(stats({ authors: T.sense_share_jsd.authors - 1, which: 'b' }), 'insufficient_authors');
    expectGate(stats({ top: 0.51, which: 'b' }), 'single_source');
    expectGate(stats({ n: 50, docs: 5, authors: 3, top: 0.5, which: 'b' }), 'not_run');
  });

  test('(b) neighbour overlap: occurrences first (49/50), then slice size (2.99M/3M), then not_run', () => {
    assert.equal(driftGate('neighbor_overlap', ctxFor(stats(), stats({ n: 49 }))).gate, 'insufficient_occurrences');
    const small = driftGate('neighbor_overlap', ctxFor(stats(), stats({ tokens: 2_990_000 })));
    assert.equal(small.gate, 'slice_too_small');
    assert.deepEqual(small.needed, { tokens_per_slice: 3_000_000 });
    assert.equal(small.have.b, 2_990_000);
    assert.ok(small.note.endsWith(NO_WIDENING_NOTE));
    assert.equal(driftGate('neighbor_overlap', ctxFor(stats(), stats({ tokens: 3_000_000 }))).gate, 'not_run');
  });

  test('(c) aligned displacement: slice size first, then 100/20/5 evidence, then composition JSD > 0.4, then not_run', () => {
    const big = stats();
    assert.equal(driftGate('aligned_displacement', ctxFor(big, stats({ tokens: 2_999_999 }))).gate, 'slice_too_small');
    assert.equal(driftGate('aligned_displacement', ctxFor(big, stats({ n: 99 }))).gate, 'insufficient_occurrences');
    assert.equal(driftGate('aligned_displacement', ctxFor(big, stats({ docs: 19 }))).gate, 'insufficient_documents');
    assert.equal(driftGate('aligned_displacement', ctxFor(big, stats({ authors: 4 }))).gate, 'insufficient_authors');
    const comp = driftGate('aligned_displacement', ctxFor(big, stats(), { jsd: 0.41 }));
    assert.equal(comp.gate, 'composition_mismatch', 'composition JSD > 0.4 suppresses aligned displacement');
    assert.equal(comp.value, null);
    assert.equal(driftGate('aligned_displacement', ctxFor(big, stats(), { jsd: 0.4 })).gate, 'not_run');
  });

  test('cross-modality (descriptive override) and OpenAlex cross-cell slices are refused for every measure', () => {
    for (const metric of ['sense_share_jsd', 'neighbor_overlap', 'aligned_displacement']) {
      assert.equal(driftGate(metric, ctxFor(stats(), stats(), { descriptive: true })).gate, 'modality_mismatch');
      assert.equal(driftGate(metric, ctxFor(stats(), stats(), { sampled: true })).gate, 'sampling_design');
    }
  });

  test('works-unit slices (titles) cannot build slice spaces', () => {
    const g = spaceSizeGate(stats({ unit: 'works' }), stats({ unit: 'works' }), THRESHOLDS.neighbor_overlap, noSuggest);
    assert.equal(g.gate, 'slice_too_small');
    assert.equal(g.value, null);
  });

  test('clustering gate: 59/60 occurrences, 4/5 documents; passing gives not_run until a clustering run exists', () => {
    assert.equal(clusterGate({ n: 59, docs: 9 }, 'x').gate, 'insufficient_occurrences');
    assert.equal(clusterGate({ n: 60, docs: 4 }, 'x').gate, 'insufficient_documents');
    const g = clusterGate({ n: 60, docs: 5 }, 'x');
    assert.equal(g.gate, 'not_run');
    assert.equal(g.value, null);
  });

  test('the evidence gate alone never carries a value or a verdict (values come only from runs)', () => {
    for (const metric of ['sense_share_jsd', 'neighbor_overlap', 'aligned_displacement']) {
      const g = driftGate(metric, ctxFor(stats(), stats()));
      assert.notEqual(g.gate, 'ok');
      assert.equal(g.value, null);
      assert.equal(g.verdict, undefined);
    }
  });
});

describe('widening suggestions (§4.11)', () => {
  const index = {
    evidence: [{ y_lo: 1890, y_hi: 1890, n: 10, author: 'p' }, { y_lo: 1905, y_hi: 1905, n: 15, author: 'q' },
      { y_lo: 1915, y_hi: 1920, n: 30, author: 'r' }, { y_lo: 1870, y_hi: 1870, n: 12, author: 's' }],
    cover: [{ y_lo: 1870, y_hi: 1870, units: 500, unitsNoTr: 500, docs: 1, authors: ['s'] },
      { y_lo: 1890, y_hi: 1890, units: 1000, unitsNoTr: 1000, docs: 1, authors: ['p'] },
      { y_lo: 1905, y_hi: 1905, units: 1500, unitsNoTr: 1500, docs: 1, authors: ['q'] },
      { y_lo: 1915, y_hi: 1920, units: 2000, unitsNoTr: 2000, docs: 1, authors: ['r'] }],
    bounds: [1870, 1920],
  };

  test('windowStats is fit-or-wash: a 1915–1920 record counts only when the window holds both years', () => {
    assert.equal(windowStats(index, 1910, 1919).n, 0);
    assert.equal(windowStats(index, 1910, 1920).n, 30);
    assert.equal(windowStats(index, 1880, 1909).units, 2500);
  });

  test('widens in 10-year steps, the smallest widening first, and reports what the slice would have', () => {
    const w = widenSuggestion(index, [1890, 1899], { occurrences: 20 }, { other: [1950, 1960] });
    assert.deepEqual(w.years, [1890, 1909], '1880–1899 holds 10; 1890–1909 holds 25');
    assert.equal(w.stats.n, 25);
    assert.equal(w.stats.docs, 2);
  });

  test('at equal widening the end away from the other slice is tried first', () => {
    // both 1880–1899 (10) and 1890–1909 (25) pass occurrences ≥ 10
    assert.deepEqual(widenSuggestion(index, [1890, 1899], { occurrences: 10 }, { other: [1950, 1960] }).years, [1880, 1899], 'B after: down');
    assert.deepEqual(widenSuggestion(index, [1890, 1899], { occurrences: 10 }, { other: [1800, 1850] }).years, [1890, 1909], 'B before: up');
  });

  test('never grows into the other slice; null when no widening inside the coverage reaches the gate', () => {
    const w = widenSuggestion(index, [1890, 1899], { occurrences: 20 }, { other: [1900, 1960] });
    assert.deepEqual(w.years, [1870, 1899], 'only downward: 12 + 10 = 22');
    assert.equal(widenSuggestion(index, [1890, 1899], { occurrences: 30 }, { other: [1900, 1960] }), null);
    assert.equal(widenSuggestion(index, [1890, 1899], { occurrences: 1000 }), null, 'beyond the whole coverage');
  });

  test('token gates widen on coverage; impossible gates give null', () => {
    const w = widenSuggestion(index, [1890, 1899], { units: 2500 }, { other: null });
    assert.ok(w.stats.units >= 2500);
    assert.equal(widenSuggestion(index, [1890, 1899], { units: 1e9 }), null);
    assert.ok(meets({ n: 5, docs: 2, authors: 2, top_doc_share: 0.5, units: 10 }, { max_top_doc_share: 0.5 }));
  });
});

describe('the database refuses a gated drift_result with a value (§3 CHECK)', () => {
  let tmp;
  before(() => { tmp = makeTmpData({ seed: false }); });
  after(() => tmp.cleanup());

  test('gate ≠ ok with a value, an interval or a percentile is rejected; ok or null values are accepted', () => {
    const run = Number(tmp.db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
      input_fingerprint, data_version, tokenizer_version, segmenter_version, icu_version, status, started_at)
      VALUES ('drift', 'drift@test', 'x', '{}', 'x', '{}', 'x', 0, 'u61m-1', 'seg-1', 'x', 'succeeded', ?)`).run(nowIso()).lastInsertRowid);
    const ins = (gate, value, ci = null, pct = null) => tmp.db.prepare(`INSERT INTO drift_result (run_id, expression_id, slice_a_json, slice_b_json,
      metric, value, ci_lo, ci_hi, null_percentile, gate, gate_detail_json) VALUES (?, 1, '{}', '{}', 'aligned_displacement', ?, ?, ?, ?, ?, '{}')`)
      .run(run, value, ci, ci, pct, gate);
    assert.throws(() => ins('slice_too_small', 0.37), /CHECK constraint failed/);
    assert.throws(() => ins('insufficient_occurrences', null, 0.1), /CHECK constraint failed/);
    assert.throws(() => ins('unaligned', null, null, 97), /CHECK constraint failed/);
    ins('slice_too_small', null);
    ins('ok', 0.37, 0.2, 97);
  });
});

describe('a Compare on thin evidence carries no numeral in any gated object', () => {
  let tmp, tally, ledger;
  before(() => {
    tmp = makeTmpData({ seed: false });
    buildAnalysisCorpus(tmp.db);
    ledger = materializeForTest(tmp.db, { surface: 'ledger' });
    tally = materializeForTest(tmp.db, { surface: 'tally' });
  });
  after(() => tmp.cleanup());

  test("rare 'tally' (7 vs 15): collocates, context groups and every drift measure are gated, with no widening", () => {
    const p = compareQuery(tmp.db, { expr: [tally.exprId], a: { years: [1900, 1949] }, b: { years: [1990, 2020] } });
    assert.deepEqual(check('Compare', p), []);
    assertNoGatedNumerals(p);
    assert.equal(p.collocates.gate, 'insufficient_occurrences');
    assert.deepEqual(p.collocates.have, { a: 7, b: 15 });
    assert.equal(p.collocates.suggestion, null);
    assert.match(p.collocates.note, /^Too few occurrences \(7 and 15; needs 20\)\. Showing KWIC\./);
    assert.equal(p.clusters.gate, 'insufficient_occurrences');
    const byMetric = Object.fromEntries(p.measures.map((m) => [m.metric, m]));
    assert.equal(byMetric.sense_share_jsd.gate, 'insufficient_occurrences');
    assert.equal(byMetric.sense_share_jsd.suggestion, null);
    assert.match(byMetric.sense_share_jsd.note, /No widening inside this corpus reaches the gate/);
    assert.equal(byMetric.neighbor_overlap.gate, 'insufficient_occurrences');
    assert.equal(byMetric.aligned_displacement.gate, 'slice_too_small');
    assert.equal(p.freq.a.gate, 'ok', 'counting is not gated: the slices are covered');
    assert.ok(p.passages.a.length > 0 && p.passages.b.length > 0, 'KWIC still shows');
  });

  test('a slice below its coverage gate has no rate and no ratio; the widening suggestion would pass the gate', () => {
    const p = compareQuery(tmp.db, { expr: [ledger.exprId], a: { years: [1890, 1899] }, b: { years: [1990, 2020] } });
    assertNoGatedNumerals(p);
    assert.equal(p.freq.a.gate, 'insufficient_coverage');
    assert.equal(p.freq.a.rate, undefined);
    assert.match(p.freq.a.note, /^low coverage: n = 2 in 97 tokens/);
    assert.equal(p.freq.rate_ratio.gate, 'insufficient_coverage');
    const s = p.freq.a.suggestion;
    assert.ok(s && s.a.years[0] <= 1890 && s.a.years[1] >= 1899 && s.a.years[1] < 1990, 'widened, apart from B');
    assert.ok(s.would_have.a.tokens >= 2000);
    const widened = compareQuery(tmp.db, { expr: [ledger.exprId], a: s.a, b: { years: [1990, 2020] } });
    assert.equal(widened.freq.a.gate, 'ok', 'applying the suggestion passes the gate');
  });

  test('cross-modality slices are refused by default: no rate, no ratio, no passages, every measure gated', () => {
    const p = compareQuery(tmp.db, { expr: [ledger.exprId], a: { years: [1900, 1949], f: 'coll:ana-text' }, b: { years: [1990, 2020], f: 'coll:ana-titles' } });
    assert.deepEqual(check('Compare', p), []);
    assertNoGatedNumerals(p);
    assert.equal(p.coverage.modality_gate, 'modality_mismatch');
    assert.equal(p.freq.gate, 'modality_mismatch');
    assert.deepEqual(p.passages.a, []);
    assert.ok(p.measures.every((m) => m.gate === 'modality_mismatch'));
    assert.match(p.coverage_note, /a change of medium, not of meaning/);
  });

  test('OpenAlex-style top-cited samples are refused across cells (sampling_design)', () => {
    const p = compareQuery(tmp.db, { expr: [ledger.exprId], a: { years: [1900, 1949], f: 'coll:ana-oa' }, b: { years: [1990, 2020], f: 'coll:ana-oa' } });
    assertNoGatedNumerals(p);
    assert.equal(p.freq.gate, 'sampling_design');
    assert.equal(p.freq.note, 'OpenAlex is a top-cited sample per field × period; cells are not comparable as rates.');
    assert.ok(p.measures.every((m) => m.gate === 'sampling_design'));
  });

  test('tone is never estimated without the adapter, and says so in the §4.11 words', () => {
    const p = compareQuery(tmp.db, { expr: [ledger.exprId], a: { years: [1900, 1949] }, b: { years: [1990, 2020] } });
    assert.equal(p.tone.gate, 'not_run');
    assert.equal(p.tone.value, null);
    assert.equal(p.tone.reason, 'Tone needs the optional on-device adapter (not installed)');
    assertNoGatedNumerals(p);
  });
});

describe('token counts a slice has are never rounded up to its gate', () => {
  test("tokensHave: 2,950,000 → '2.95M', 2,999,999 → '2.99M', 21,400 → '21.4k', 49,999 → '49.9k'", async () => {
    const { tokensHave, unitsLabel } = await import('../server/analysis/gates.mjs');
    assert.equal(tokensHave(2_950_000), '2.95M');
    assert.equal(tokensHave(2_999_999), '2.99M');
    assert.equal(tokensHave(3_000_000), '3M');
    assert.equal(tokensHave(21_400), '21.4k');
    assert.equal(tokensHave(49_999), '49.9k');
    assert.equal(tokensHave(879), '879');
    assert.equal(unitsLabel(49_999, 'tokens'), '49.9k tokens');
  });
});
