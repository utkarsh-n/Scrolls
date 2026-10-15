// OWNER: WP4 — Compare (SPEC §2.E, §7.2) on the synthetic analysis corpus: counts and denominators equal
// independent SQL over expr_doc/doc_tokens, exact CIs, every default exclusion counted, passages resolve to
// text, collocates and keyness, composition and modality, the descriptive override; then over HTTP: the
// Compare/Collocations shapes, the multiplicity log per session, and the error statuses.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { check } from '../src/shared/contracts.mjs';
import { tokenize } from '../src/shared/tokenize.mjs';
import { compareQuery, normalizeCompareRequest, prominenceCheck } from '../server/analysis/compare.mjs';
import { garwoodCI as garwood, poissonRate, proportionRate, wilsonCI as wilson } from '../server/analysis/intervals.mjs';
import { nowIso } from '../server/db/open.mjs';
import { buildAnalysisCorpus, ERA_A, ERA_B, materializeForTest } from './analysis.fixture.mjs';
import { startServerInProcess } from './helpers/server.mjs';
import { assertShape, checkResponse } from './helpers/shape.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'silent';

/** Independent count of a slice: SUM(expr_doc.n) and SUM(doc_tokens.tokens) with the default exclusions. */
function sqlSlice(db, { expr, run, years: [lo, hi] }) {
  const where = `d.deleted_at IS NULL AND d.chrono_status = 'dated' AND d.y_lo >= ? AND d.y_hi <= ? AND d.is_translation = 0
    AND d.dup_of IS NULL AND c.modality = 'text'`;
  const n = db.prepare(`SELECT COALESCE(SUM(e.n), 0) AS n, COUNT(DISTINCT e.document_id) AS docs FROM expr_doc e
    JOIN document d ON d.id = e.document_id JOIN collection c ON c.id = d.collection_id
    WHERE e.expression_id = ? AND e.run_id = ? AND e.field_class = 'text' AND e.plang = 'en' AND e.n > 0 AND ${where}`).get(expr, run, lo, hi);
  const t = db.prepare(`SELECT COALESCE(SUM(t.tokens), 0) AS tokens FROM doc_tokens t JOIN document d ON d.id = t.document_id
    JOIN collection c ON c.id = d.collection_id WHERE t.field_class = 'text' AND t.plang = 'en' AND ${where}`).get(lo, hi);
  return { n: n.n, docs: n.docs, tokens: t.tokens };
}

describe('compareQuery on the synthetic corpus', () => {
  let tmp, ledger, payload;
  const A = { years: ERA_A }, B = { years: ERA_B };
  before(() => {
    tmp = makeTmpData({ seed: false });
    buildAnalysisCorpus(tmp.db);
    ledger = materializeForTest(tmp.db, { surface: 'ledger' });
    payload = compareQuery(tmp.db, { expr: [ledger.exprId], a: A, b: B, seed: 771 });
  });
  after(() => tmp.cleanup());

  test('the payload matches the Compare contract and is labelled synthetic', () => {
    assertShape('Compare', payload);
    assert.equal(payload.provenance.synthetic, true);
    assert.deepEqual(payload.provenance.collections, ['ana-text']);
    assert.deepEqual(payload.provenance.run_ids.materialize, { [ledger.exprId]: ledger.runId });
    assert.equal(payload.coverage.a.synthetic, true);
  });

  test('frequency: n, denominators and documents equal independent SQL; rates carry the exact Garwood CI', () => {
    for (const [side, slice] of [['a', A], ['b', B]]) {
      const want = sqlSlice(tmp.db, { expr: ledger.exprId, run: ledger.runId, years: slice.years });
      const f = payload.freq[side];
      assert.equal(f.gate, 'ok');
      assert.equal(f.n, want.n, `${side}: n`);
      assert.equal(f.units, want.tokens, `${side}: tokens`);
      assert.equal(payload.coverage[side].tokens, want.tokens);
      assert.equal(f.docs, want.docs, `${side}: documents with a match`);
      assert.equal(f.unit, 'per_million_tokens');
      const r = poissonRate(want.n, want.tokens);
      assert.equal(f.rate, Number(r.rate.toFixed(2)));
      assert.deepEqual(f.ci, r.ci.map((x) => Number(x.toFixed(2))));
      assert.ok(f.dp >= 0 && f.dp <= 1);
    }
    assert.equal(payload.freq.ci_method, 'Garwood exact Poisson 95%');
    assert.equal(payload.freq.rate_ratio.direction, 'B relative to A');
    assert.ok(payload.freq.rate_ratio.ci[0] < payload.freq.rate_ratio.value && payload.freq.rate_ratio.value < payload.freq.rate_ratio.ci[1]);
  });

  test('default exclusions are visible and counted (§13 rule 9)', () => {
    const ea = payload.coverage.a.excluded, eb = payload.coverage.b.excluded;
    assert.deepEqual(ea.translations, { docs: 1, n: 3 }, 'the declared-French English text');
    assert.deepEqual(ea.duplicates, { docs: 1, n: 3 }, 'the exact copy');
    assert.deepEqual(payload.coverage.a.washes, { docs: 2, n: 6 }, '1945–1955 does not fit 1900–1949');
    assert.equal(eb.names, 1, 'Mr Ledger Holt');
    assert.equal(payload.coverage.a.undated.docs, 2);
    assert.ok(ea.other_modality.docs > 0 && ea.other_modality.modalities.titles > 0, 'titles in A are not mixed into a text rate');
    for (const c of ['washes', 'translations_excluded', 'names_excluded', 'mixed_modality']) assert.ok(payload.coverage.caveats.includes(c), c);
    assert.match(payload.coverage_note, /2 documents \(6 matches\) have dates too coarse to fit slice A/);
    assert.match(payload.coverage_note, /1 translated document is excluded from slice A/);
    assert.match(payload.coverage_note, /1 match in slice B is excluded as names/);
    assert.match(payload.coverage_note, /Both slices are synthetic\./);
  });

  test('composition: JSD over kind × language × collection, caveat and standardized rates above 0.15', () => {
    assert.ok(payload.coverage.composition_jsd > 0.15);
    assert.ok(payload.coverage.caveats.includes('composition'));
    assert.match(payload.coverage_note, /^The slices differ in composition \(JSD \d\.\d\d\): A is \d+% memo text, B is \d+% song text\. Differences below may reflect source mix/);
    const std = payload.freq.standardized;
    assert.ok(std && std.weight_covered > 0 && std.weight_covered <= 1);
    // fix pass: standardized rates speak only for the strata both slices share; with too little shared mix they are
    // withheld with the reason (never a 0 for a slice with matches)
    if (std.weight_covered < 0.5) {
      assert.equal(std.a, null);
      assert.equal(std.b, null);
      assert.match(std.note, /share too little of their mix for standardized rates/);
    } else assert.ok(Number.isFinite(std.a) && Number.isFinite(std.b));
    const mix = payload.coverage.a.mix;
    assert.ok(Math.abs(Object.values(mix).reduce((s, x) => s + x, 0) - 1) < 1e-3);
  });

  test('passages: ≤ 5 per slice, ≤ 1 per document, each resolves to its text; the seed reproduces the draw', () => {
    const passage = tmp.db.prepare('SELECT p.*, d.y_lo, d.y_hi FROM passage p JOIN document d ON d.id = p.document_id WHERE p.id = ?');
    for (const side of ['a', 'b']) {
      const rows = payload.passages[side];
      assert.equal(rows.length, 5);
      assert.equal(new Set(rows.map((r) => r.doc)).size, rows.length);
      for (const r of rows) {
        const p = passage.get(r.passage);
        assert.equal(p.document_id, r.doc);
        const [lo, hi] = side === 'a' ? ERA_A : ERA_B;
        assert.ok(p.y_lo >= lo && p.y_hi <= hi, 'the document lies in its slice');
        const src = tmp.db.prepare('SELECT original FROM document_text WHERE document_id = ?').get(r.doc).original.slice(p.start_off, p.end_off);
        assert.equal(src.slice(r.start, r.end), r.match);
        assert.equal(r.left.length <= r.start, true);
        assert.equal(src.slice(r.start - r.left.length, r.start), r.left);
        assert.deepEqual(tokenize(r.match).tokens, ['ledger']);
        assert.equal(r.synthetic, true);
      }
    }
    assert.equal(payload.passages.seed, 771);
    const again = compareQuery(tmp.db, { expr: [ledger.exprId], a: A, b: B, seed: 771 });
    assert.deepEqual(again.passages, payload.passages);
    const other = compareQuery(tmp.db, { expr: [ledger.exprId], a: A, b: B, seed: 9 });
    assert.notDeepEqual(other.passages.a.map((r) => r.occ), payload.passages.a.map((r) => r.occ), 'reshuffle draws again');
  });

  test('neighbouring terms: A-only, B-only and shared columns, keyness, new and declining uses — context words, not meanings', () => {
    const c = payload.collocates;
    assert.equal(c.gate, 'ok');
    assert.equal(c.label, 'context words, not meanings');
    assert.equal(c.window, '±5 tokens');
    assert.ok(c.a.some((r) => r.term === 'auditors'));
    assert.ok(c.b.some((r) => r.term === 'uncredited'));
    assert.ok(!c.a.some((r) => r.term === 'the') && c.hidden_stopwords.a >= 1, 'stop-words hidden and counted');
    for (const r of [...c.a, ...c.b]) assert.ok(r.g2 >= 10.83 && r.q < 0.05 && r.f_xy >= 5);
    const aud = c.keyness.find((r) => r.term === 'auditors');
    assert.equal(aud.side, 'a');
    assert.ok(aud.log_ratio < 0 && aud.q < 0.05);
    assert.ok(c.new_uses.includes('uncredited'));
    assert.ok(c.declining.includes('auditors'));
    assert.equal(c.f_x.a, payload.freq.a.n, 'every counted match contributes a window');
  });

  test('prominence: directions per tercile come from exact ratio intervals; opposite significant directions fire the caveat', () => {
    const mk = (t) => ({ unit: 'tokens', terciles: t });
    const split = prominenceCheck(mk({ 1: { n: 100, units: 10000 }, 2: { n: 10, units: 10000 } }), mk({ 1: { n: 10, units: 10000 }, 2: { n: 100, units: 10000 } }));
    assert.equal(split.consistent, false);
    assert.deepEqual(split.terciles.map((r) => r.direction), ['down', 'up']);
    const flat = prominenceCheck(mk({ 1: { n: 10, units: 10000 }, 2: { n: 11, units: 10000 } }), mk({ 1: { n: 12, units: 10000 }, 2: { n: 9, units: 10000 } }));
    assert.equal(flat.consistent, true);
    assert.equal(prominenceCheck(mk({ 1: { n: 1, units: 10 } }), mk({})).consistent, null);
    assert.ok('prominence' in payload.coverage);
  });

  test('a mixed slice compares its dominant medium; titles alone are counted per 1,000 works with a Wilson CI', () => {
    const p = compareQuery(tmp.db, { expr: [ledger.exprId], a: { years: ERA_A, f: 'coll:ana-titles' }, b: { years: ERA_B, f: 'coll:ana-titles' } });
    assertShape('Compare', p);
    assert.equal(p.coverage.modality_compared, 'titles');
    assert.equal(p.freq.a.unit, 'per_thousand_works');
    assert.equal(p.freq.ci_method, 'Wilson score 95%');
    const r = proportionRate(p.freq.b.n, p.freq.b.units, 1000);
    assert.equal(p.freq.b.rate, Number(r.rate.toFixed(2)));
    assert.ok(p.coverage.caveats.includes('selection'), 'prominence-selected titles say so');
    assert.match(p.coverage_note, /ana-titles in slice A: selected by prominence \(chosen by prominence \(synthetic\)\)/);
  });

  test('cross-modality: refused by default with the medium named; "compare anyway" is descriptive only', () => {
    const req = { expr: [ledger.exprId], a: { years: ERA_A, f: 'coll:ana-text' }, b: { years: ERA_B, f: 'coll:ana-titles' } };
    const refused = compareQuery(tmp.db, req);
    assert.equal(refused.freq.gate, 'modality_mismatch');
    assert.match(refused.freq.note, /^A is \d+% memo text, B is \d+% \w+ titles: different media\./);
    const d = compareQuery(tmp.db, { ...req, override: 'descriptive' });
    assertShape('Compare', d);
    assert.equal(d.freq.a.unit, 'per_million_tokens');
    assert.equal(d.freq.b.unit, 'per_thousand_works');
    assert.equal(d.freq.rate_ratio.gate, 'modality_mismatch');
    assert.equal(d.freq.rate_ratio.value, null);
    assert.equal(d.coverage.descriptive_override, true);
    assert.equal(d.collocates.gate, 'modality_mismatch');
    assert.ok(d.measures.every((m) => m.gate === 'modality_mismatch'));
  });

  test('requests are validated with actionable messages', () => {
    assert.throws(() => normalizeCompareRequest({ expr: [1], a: { years: [1990, 1950] }, b: { years: [1, 2] } }),
      (e) => e.status === 400 && e.message === 'Slice A must have years [lo, hi] with lo ≤ hi.' && e.hint === 'Set both slices with A and B on a range, then C.');
    assert.throws(() => normalizeCompareRequest({ expr: [], a: A, b: B }), (e) => e.status === 400 && e.detail.field === 'expr');
    assert.throws(() => normalizeCompareRequest({ expr: [1], a: A, b: B, measures: ['meaning'] }), (e) => e.status === 400);
    assert.throws(() => normalizeCompareRequest({ expr: [1], a: A, b: B, override: 'anyway' }), (e) => e.status === 400);
    const n = normalizeCompareRequest({ expr: [3, 3], a: A, b: B });
    assert.deepEqual(n, normalizeCompareRequest(n), 'idempotent');
    assert.deepEqual(n.expr, [3]);
  });
});

describe('POST /api/compare and GET /api/collocations over HTTP', () => {
  let tmp, srv, ledger, tally, pendingExpr;
  const A = { years: ERA_A }, B = { years: ERA_B };
  before(async () => {
    tmp = makeTmpData({ seed: false });
    buildAnalysisCorpus(tmp.db);
    ledger = materializeForTest(tmp.db, { surface: 'ledger' });
    tally = materializeForTest(tmp.db, { surface: 'tally' });
    pendingExpr = Number(tmp.db.prepare(`INSERT INTO expression (corpus_id, kind, surface, norm, lang, origin, is_synthetic, created_by, created_at)
      VALUES ((SELECT id FROM corpus WHERE slug = 'test'), 'word', 'harbour', 'harbour', 'en', 'user_query', 1, 'test', ?)`).run(nowIso()).lastInsertRowid);
    tmp.db.close();
    srv = await startServerInProcess({ dataDir: tmp.dir });
  });
  after(async () => {
    await srv?.cleanup();
    tmp.cleanup();
  });

  const post = (body, session = 'sess-a') => srv.request('POST', '/api/compare', { body, headers: { 'X-Scrolls-Session': session } });

  test('Compare answers with the contract shape; k counts distinct comparisons per session and expression', async () => {
    const r1 = await post({ expr: [ledger.exprId], a: A, b: B });
    assert.equal(r1.status, 200, r1.text);
    assertShape('Compare', r1.json);
    assert.equal(r1.json.multiplicity.k, 1);
    assert.equal(r1.json.multiplicity.threshold_percentile, 95);

    const again = await post({ expr: [ledger.exprId], a: A, b: B, seed: 5 });
    assert.equal(again.json.multiplicity.k, 1, 'reshuffling passages is not a new comparison');

    const r2 = await post({ expr: [ledger.exprId], a: { years: [1900, 1939] }, b: B });
    assert.equal(r2.json.multiplicity.k, 2);
    assert.equal(r2.json.multiplicity.threshold_percentile, 97.5);
    assert.match(r2.json.multiplicity.text, /^Comparison #2 for 'ledger' in this session; 0 of 2 crossed the notable threshold; .*adjusted to the 97\.5th percentile\.$/);

    const other = await post({ expr: [ledger.exprId], a: A, b: B }, 'sess-b');
    assert.equal(other.json.multiplicity.k, 1, 'another session starts again');
    const otherExpr = await post({ expr: [tally.exprId], a: A, b: B });
    assert.equal(otherExpr.json.multiplicity.k, 1, 'another expression starts again');

    const db = new DatabaseSync(path.join(tmp.dir, 'scrolls.db'), { readOnly: true });
    try {
      const rows = db.prepare("SELECT session_id, expression_key FROM compare_log ORDER BY id").all();
      assert.deepEqual(rows.map((r) => `${r.session_id}|${r.expression_key}`),
        ['sess-a|expr:' + ledger.exprId, 'sess-a|expr:' + ledger.exprId, 'sess-b|expr:' + ledger.exprId, 'sess-a|expr:' + tally.exprId]);
    } finally {
      db.close();
    }
  });

  test('errors: 400 with the contract message, 404 for an unknown expression, 409 while counting has not finished', async () => {
    const bad = await post({ expr: [ledger.exprId], a: { years: [1950, 1900] }, b: B });
    assert.equal(bad.status, 400);
    const body = await checkResponse(new Response(bad.text, { status: 400 }), 'POST', '/api/compare');
    assert.equal(body.error.code, 'E_VALIDATION');
    assert.equal(body.error.message, 'Slice A must have years [lo, hi] with lo ≤ hi.');
    const missing = await post({ expr: [999999], a: A, b: B });
    assert.equal(missing.status, 404);
    const pending = await post({ expr: [pendingExpr], a: A, b: B });
    assert.equal(pending.status, 409);
    assert.equal(pending.json.error.code, 'E_NOT_MATERIALIZED');
  });

  test('collocations: ok and gated payloads match the Collocations contract; bad slices are 400', async () => {
    const ok = await srv.request('GET', `/api/collocations?expr=${ledger.exprId}&slice=1990-2020`);
    assert.equal(ok.status, 200, ok.text);
    assertShape('Collocations', ok.json);
    assert.equal(ok.json.gate, 'ok');
    assert.equal(ok.json.label, 'context words, not meanings');
    assert.ok(ok.json.collocates.some((c) => c.term === 'hold'));
    assert.ok(ok.json.collocates.length <= 100);
    const gatedRes = await srv.request('GET', `/api/collocations?expr=${tally.exprId}&slice=1990-2020`);
    assertShape('Collocations', gatedRes.json);
    assert.equal(gatedRes.json.gate, 'insufficient_occurrences');
    assert.deepEqual(gatedRes.json.have, { occurrences: 15 });
    assert.equal(gatedRes.json.value, null);
    assert.ok(gatedRes.json.kwic.length > 0, 'showing KWIC');
    assert.match(gatedRes.json.note, /^Too few occurrences \(15; needs 20\)\. Showing KWIC\./);
    const bad = await srv.request('GET', `/api/collocations?expr=${ledger.exprId}&slice=ninety`);
    assert.equal(bad.status, 400);
  });

  test('GET /api/analysis/runs lists runs with their parameters', async () => {
    const r = await srv.request('GET', '/api/analysis/runs?stage=materialize');
    assert.equal(r.status, 200);
    assertShape('AnalysisRuns', r.json);
    assert.ok(r.json.items.some((x) => x.id === ledger.runId));
    const unknown = await srv.request('POST', '/api/analysis/runs', { body: { stage: 'meaning' } });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error.message, "Unknown stage 'meaning'.");
    const badLang = await srv.request('POST', '/api/analysis/runs', { body: { stage: 'vectors', params: { lang: 'English' } } });
    assert.equal(badLang.status, 400);
    assert.match(badLang.json.error.message, /params\.lang/);
    const badSlice = await srv.request('POST', '/api/analysis/runs', { body: { stage: 'drift', params: { expr: [ledger.exprId], a: { years: [1950, 1900] }, b: { years: ERA_B } } } });
    assert.equal(badSlice.status, 400);
  });
});

describe('Compare on rows written by the materialize job (WP3), and CIs that agree with the tiles', () => {
  let tmp, wp3 = null, stats3 = null;
  before(async () => {
    tmp = makeTmpData({ seed: false });
    buildAnalysisCorpus(tmp.db);
    try {
      const m = await import('../server/aggregate/materialize.mjs');
      const { tx } = await import('../server/db/open.mjs');
      const { id } = tx(tmp.db, () => m.trackExpression(tmp.db, { surface: 'ledger', lang: 'en', corpus: 'test' }));
      wp3 = { id, result: m.materializeInline(tmp.db, id) };
    } catch (err) {
      if (err?.code !== 'NOT_IMPLEMENTED') throw err;
    }
    try {
      const s = await import('../server/aggregate/stats.mjs');
      s.garwoodCI(1);
      stats3 = s;
    } catch (err) {
      if (err?.code !== 'NOT_IMPLEMENTED') throw err;
    }
  });
  after(() => tmp.cleanup());

  test('n, denominators, name exclusions and collocate windows agree with the materialized expr_doc rows', (t) => {
    if (!wp3) { t.skip('the materialize job is not implemented yet (WP3)'); return; }
    const p = compareQuery(tmp.db, { expr: [wp3.id], a: { years: ERA_A }, b: { years: ERA_B } });
    assertShape('Compare', p);
    const run = tmp.db.prepare('SELECT run_id FROM expression_state WHERE expression_id = ?').get(wp3.id).run_id;
    for (const [side, years] of [['a', ERA_A], ['b', ERA_B]]) {
      const want = sqlSlice(tmp.db, { expr: wp3.id, run, years });
      assert.equal(p.freq[side].n, want.n, side);
      assert.equal(p.freq[side].units, want.tokens, side);
    }
    assert.equal(p.coverage.b.excluded.names, 1);
    assert.deepEqual(p.collocates.f_x, { a: p.freq.a.n, b: p.freq.b.n }, 'every counted match has a window, no more');
  });

  test("Compare's exact intervals equal the timeline's (aggregate/stats.mjs)", (t) => {
    if (!stats3) { t.skip('aggregate/stats.mjs is not implemented yet (WP3)'); return; }
    for (const n of [0, 1, 3, 10, 61, 500, 5000]) {
      const [a0, a1] = garwood(n), [b0, b1] = stats3.garwoodCI(n);
      assert.ok(Math.abs(a0 - b0) <= 1e-6 * Math.max(1, b0) && Math.abs(a1 - b1) <= 1e-6 * Math.max(1, b1), `Garwood ${n}: ${[a0, a1]} vs ${[b0, b1]}`);
    }
    for (const [k, n] of [[0, 20], [5, 20], [20, 20], [3, 40000]]) {
      const [a0, a1] = wilson(k, n), [b0, b1] = stats3.wilsonCI(k, n);
      assert.ok(Math.abs(a0 - b0) < 1e-9 && Math.abs(a1 - b1) < 1e-9, `Wilson ${k}/${n}`);
    }
  });
});


describe('Compare P2: context groups and measure (a), slice-space eligibility, OpenAlex within-cell shares', () => {
  let tmp, ledger;
  const A = { years: ERA_A }, B = { years: ERA_B };
  before(() => {
    tmp = makeTmpData({ seed: false });
    buildAnalysisCorpus(tmp.db);
    ledger = materializeForTest(tmp.db, { surface: 'ledger' });
  });
  after(() => tmp.cleanup());

  /** A clustering run as the cluster job stores it: groups (sense_cluster) and their members (cluster_member). */
  function clusterRun(db, exprId, assign, { labels = ['machine label: auditors · forms', 'machine label: counted · hold', 'other contexts'],
    statuses = ['hypothesis', 'hypothesis', 'residual'] } = {}) {
    const run = Number(db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
      input_fingerprint, data_version, representation, tokenizer_version, segmenter_version, icu_version, status, started_at)
      VALUES ('cluster', 'cluster@test', 'x', '{}', ?, '{}', 'x', 0, 'tfidf-hash-4096', 'u61m-1', 'seg-1', 'x', 'succeeded', ?)`)
      .run(`h${Math.random()}`, nowIso()).lastInsertRowid);
    const ids = labels.map((label, ord) => Number(db.prepare(`INSERT INTO sense_cluster (run_id, expression_id, ord, label_auto, distinctive_json,
      size, n_docs, top_doc_share, status) VALUES (?, ?, ?, ?, '[]', 0, 0, 0, ?)`).run(run, exprId, ord, label, statuses[ord]).lastInsertRowid));
    const occ = db.prepare(`SELECT o.id, d.y_lo FROM occurrence o JOIN document d ON d.id = o.document_id WHERE o.expression_id = ? AND o.name_flag = 0`).all(exprId);
    const ins = db.prepare('INSERT INTO cluster_member (cluster_id, occurrence_id, cos, margin) VALUES (?, ?, 0.9, 0.1)');
    occ.forEach((o, i) => { const k = assign(o, i); if (k !== null) ins.run(ids[k], o.id); });
    return { run, ids };
  }

  test('slice-space eligibility is listed with the coverage (era slices computed now; no pooled space yet)', () => {
    const p = compareQuery(tmp.db, { expr: [ledger.exprId], a: A, b: B });
    const sp = p.coverage.spaces;
    assert.equal(sp.lang, 'en');
    assert.equal(sp.pooled, null);
    assert.equal(sp.era.eligible, 0);
    assert.match(sp.era.note, /^Aligned displacement unavailable for English: no eligible slice/);
    assert.deepEqual(sp.era.needs, { tokens: 3000000, docs: 10, authors: 5 });
  });

  test('a clustering run gives context-group shares with bootstrap CIs and the context-share shift (a)', () => {
    // era A occurrences in group 0, era B in group 1, every tenth in the residual group
    const cr = clusterRun(tmp.db, ledger.exprId, (o, i) => (i % 10 === 0 ? 2 : o.y_lo < 1960 ? 0 : 1));
    const p = compareQuery(tmp.db, { expr: [ledger.exprId], a: A, b: B });
    assert.deepEqual(check('Compare', p), []);
    assert.equal(p.clusters.gate, 'ok');
    assert.equal(p.clusters.run, cr.run);
    assert.equal(p.clusters.representation, 'tfidf-hash-4096');
    const [g0, g1] = p.clusters.shares;
    assert.ok(g0.a.share > 0.8 && g0.b.share === 0 && g1.b.share > 0.8);
    assert.ok(g0.a.ci[0] <= g0.a.share && g0.a.share <= g0.a.ci[1]);
    assert.deepEqual(p.clusters.new_uses, ['machine label: counted · hold']);
    assert.deepEqual(p.clusters.declining, ['machine label: auditors · forms']);
    const a = p.measures.find((m) => m.metric === 'sense_share_jsd');
    assert.equal(a.gate, 'ok', JSON.stringify(a));
    assert.ok(a.value > 0.6 && a.ci[0] <= a.value && a.value <= a.ci[1]);
    assert.match(a.text, /^Context-share shift JSD 0\.\d\d \[0\.\d\d, [01]\.\d\d\] · n = .* — an estimated shift in usage contexts\.$/);
    assert.equal(a.run, cr.run);
  });

  test('a clustering run with one context group gives no_cluster_structure, without a value', () => {
    clusterRun(tmp.db, ledger.exprId, () => 0, { labels: ['machine label: ledger'], statuses: ['hypothesis'] });
    const p = compareQuery(tmp.db, { expr: [ledger.exprId], a: A, b: B });
    const a = p.measures.find((m) => m.metric === 'sense_share_jsd');
    assert.equal(a.gate, 'no_cluster_structure');
    assert.equal(a.value, null);
    assert.equal(a.ci, null);
  });

  test('OpenAlex-style samples: within-cell presence shares side by side (k of n, Wilson CI), never a rate across cells', () => {
    tmp.db.prepare(`UPDATE document SET original_meta_json = json_set(original_meta_json, '$.sample_cell', 'Medicine|1920-1924')
      WHERE collection_id = (SELECT id FROM collection WHERE slug = 'ana-oa') AND y_lo = 1920 AND ext_id IN ('anao:0', 'anao:1', 'anao:2')`).run();
    const p = compareQuery(tmp.db, { expr: [ledger.exprId], a: { years: [1900, 1949], f: 'coll:ana-oa' }, b: { years: [1990, 2020], f: 'coll:ana-oa' } });
    assert.equal(p.freq.gate, 'sampling_design');
    assert.equal(p.freq.value, null);
    const w = p.within_cell;
    assert.ok(w, 'within-cell shares are reported');
    const med = w.a.find((c) => c.cell === 'Medicine|1920-1924');
    assert.deepEqual([med.k, med.n, med.share], [3, 3, 1]);
    assert.deepEqual(med.ci, wilson(3, 3).map((x) => Number(x.toFixed(4))));
    const rest = w.a.find((c) => c.cell === 'unknown field|1920-1924');
    assert.equal(rest.n, 9);
    assert.ok(w.b.every((c) => c.years[0] >= 1990 && c.years[1] <= 2020));
    assert.equal(w.b.reduce((s, c) => s + c.n, 0), 12);
    assert.match(w.note, /never as a rate, ratio or trend across cells/);
    assert.ok(!('rate' in med) && !('ratio' in w));
    assert.match(p.coverage_note, /Within-cell presence shares are shown side by side, descriptively\./);
  });
});
