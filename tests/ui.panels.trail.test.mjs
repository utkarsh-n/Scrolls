// OWNER: WP7 — contract 1.3.0 panels: the Crossings card of the Term trail (per lane: first/last observed in this
// corpus with its basis, opening the first passage; etymology periods with each root once; the external claim; the
// fixed line), context-group blocks with rename (inspector NEXT and Compare), starting a suggested run from a gate
// card, the constellation's collision-aware labels, and Compare's Spearman ρ against the Ngram baseline and OpenAlex
// within-cell shares (SPEC §2.B, §2.D, §2.E, §10.2, §10.4, §10.5, §13).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/ui/core/store.mjs';
import { decode, defaultState } from '../src/shared/viewstate.mjs';
import { ApiError } from '../src/ui/core/api.mjs';
import {
  CLAIM_NOTE, claimRows, COPRESENCE_NOTE, createCrossings, CROSSINGS_CAPTION, crossingsQuery, crossingsRows, etymologyModel, etymologyRows,
  laneClass, laneRow, SHARE_LANE_NOTE, splitHref, TRAIL_CORPUS,
} from '../src/ui/panels/crossings.mjs';
import { createGroupBlock, groupLabels, MACHINE_PREFIX, renameRequest, renderShareChart, shareSeries, windowWords } from '../src/ui/panels/context-group.mjs';
import { followJob, runRequestOf, startSuggestedRun } from '../src/ui/panels/runs.mjs';
import { describeSuggestion, renderGateCard } from '../src/ui/panels/gate-card.mjs';
import { dockFor, mount as mountInspector, selectPassage, trailExpression } from '../src/ui/panels/inspector.mjs';
import { baselineRhoText, BASELINE_RHO_LABEL, cellWords, mount as mountCompare } from '../src/ui/panels/compare.mjs';
import { LABEL, mount as mountConstellation, nodeTitle, placeLabels, truncateLabel } from '../src/ui/panels/constellation.mjs';
import { mount as mountLineage } from '../src/ui/panels/lineage.mjs';
import { mount as mountNotebook } from '../src/ui/panels/notebook.mjs';
import { byText, createFakeApi, fixtureBody, installFakeDom, makeEvent, settle, visibleText } from './ui.panels.fakedom.mjs';

// ── A Term trail response in the 1.3.0 names (C2, C3); counts are invented for the test only ─────────────────
function trailResponse() {
  const lane = (key, label, unit, modality, extra = {}) => ({ key, label, unit, modality, order_rule: 'first_observed', header: label,
    coverage: {}, n: 0, docs: 0, first: null, last: null, undated: 0, scheduled: 0, undated_share: 0, censor: { left: false, right: false },
    strands: {}, synthetic: false, ...extra });
  return {
    queryKey: 'trail-key-1', dataVersion: 9, status: 'ready', job: null,
    units: [{ unit: 'per_million_tokens', lanes: ['trail:literature-text'] }],
    lanes: [
      lane('trail:etymology', 'Etymology — periods, not dates', 'period_bands', 'lexical'),
      lane('trail:literature-text', 'Literature · text (Cipher Gutenberg + Wikisource)', 'per_million_tokens', 'text',
        { n: 36, docs: 32, gate: 50000, coverage: { tokens: 40000000, docs: 691 }, first: { label: '1885', precision: 'year', lo_day: -31046 }, last: { label: '1928', precision: 'year' } }),
      lane('trail:stemm-text:medicine', 'Medicine & health · text (Gutenberg STEMM)', 'per_million_tokens', 'text',
        { n: 410, docs: 61, gate: 50000, coverage: { tokens: 9000000, docs: 90 }, first: { label: '1832', precision: 'year', basis: 'stated', passage: 5150 }, last: { label: '1927', precision: 'year' } }),
      lane('trail:stemm-abstracts:medicine', 'Medicine & health · OpenAlex top-cited sample', 'share_of_sampled_works', 'abstracts',
        { n: 120, docs: 120, coverage: { works: 6000, docs: 6000 }, first: { label: '1900–1904', precision: 'range' }, last: { label: '2020–2024', precision: 'range' } }),
      lane('trail:culture-titles', 'Culture · titles (songs, films, TV, books)', 'per_thousand_works', 'titles',
        { n: 2, docs: 2, coverage: { works: 94385, docs: 94385 }, first: { label: '1999', precision: 'year' }, last: { label: '2013', precision: 'year' } }),
      lane('trail:music-relations', 'Music relations · works in documented links', 'count_of_works', 'titles', { n: 0, coverage: { works: 120000 },
        mode: 'works', rate_note: 'Works that appear in documented sample/cover/version links: counted as works, never as a rate.' }),
    ],
    trail: { lanes: [], absent: [{ key: 'trail:stemm-text:computing', label: 'Computing · text (Gutenberg STEMM)', reason: 'No computing · text (gutenberg stemm) is loaded in real.' }],
      outside: { 8: 3 }, member_corpora: 2, note: 'Lanes share a word, not a link.' },
    other: { lanes: 0, n: 0 }, extent: { from: '1832', to: '2024' },
    totals: { n: 568, dated: 568, undated: 0, scheduled: 0, names_excluded: 0, sampled: false, washes_by_tier: {} },
    seams: [], gates: {}, provenance: { data_version: 9, run_ids: {}, tokenizer: 'u61m-1', segmenter: 'seg-1', synthetic: false,
      collections: [], licenses: [], corpora: ['cipher', 'stemm'] },
    baseline: { available: true, href: '/api/baseline?word=virus' },
    claims: [{ label: 'Wiktionary: first used 1972 (external claim)', date: { lo_year: 1972, hi_year: 1972, label: '1972' }, display: 'dimmed',
      reasons: ['sense-specific: dates the computing sense only'], source: 'wiktionary', license: 'CC BY-SA 4.0 / GFDL', relation: 'first_used',
      highlight: { passage: 777001, start: 3, end: 30 } }],
  };
}

/** A fake API whose POST /timeline/query answers the trail for corpus 'real' (or refuses it), the rest from fixtures. */
function trailApi({ trail = true, expr = 'with_claims' } = {}) {
  const api = createFakeApi({ variants: { 'GET /api/expressions/:id': expr, 'GET /api/etymology': 'virus' } });
  const { get, post } = api;
  api.post = async (path, body, opts) => {
    if (path === '/timeline/query' && body?.corpus === TRAIL_CORPUS) {
      api.calls.push({ method: 'POST', path: '/api/timeline/query', query: {}, body });
      if (trail === 'timeout') throw new ApiError({ status: 503, code: 'QUERY_TIMEOUT', message: 'The query took longer than 5000 ms and was stopped.' });
      if (!trail) throw new ApiError({ status: 400, code: 'E_VALIDATION', message: "Unknown corpus 'real'." });
      return trailResponse();
    }
    return post(path, body, opts);
  };
  api.get = async (path, query = null, opts) => {
    if (path === '/kwic' && query?.q === 'trail-key-1') {
      api.calls.push({ method: 'GET', path: '/api/kwic', query: { ...query }, body: null });
      const n = { 'trail:literature-text': 9001, 'trail:stemm-abstracts:medicine': 9002, 'trail:culture-titles': 9003 }[query.lane];
      return { rows: n ? [{ passage: n, doc: n, start: 0, end: 5, left: '', match: 'virus', right: '', title: 't', date: { label: 'x' } }] : [], total: n ? 1 : 0, cursor: null };
    }
    if (/^\/passages\/900\d$/.test(path) || path === '/passages/5150') {
      api.calls.push({ method: 'GET', path: `/api${path}`, query: {}, body: null });
      return { ...fixtureBody('GET', '/api/passages/:id', 'p901'), id: Number(path.split('/')[2]),
        document: { ...fixtureBody('GET', '/api/passages/:id', 'p901').document, date_card: { label: '1885', precision: 'year', basis: path.endsWith('9001') ? 'estimated' : 'stated', role: 'publication', notes: [] } } };
    }
    return get(path, query, opts);
  };
  return api;
}

// ── Crossings: pure helpers ─────────────────────────────────────────────────────────────────────────────

describe('Crossings rows for the Term trail (§10.5, contract 1.3.0 C2/C3/C5)', () => {
  test('the card asks for the trail in the virtual corpus; a synthetic expression keeps its own corpus by domain', () => {
    const t = crossingsQuery(5, { trail: true, corpus: 'cipher' });
    assert.equal(t.corpus, 'real');
    assert.equal(t.lanes.facet, 'trail');
    const d = crossingsQuery(1, { trail: false, corpus: 'demo' });
    assert.equal(d.corpus, 'demo');
    assert.equal(d.lanes.facet, 'domain');
    assert.deepEqual(splitHref('/api/baseline?word=virus&lang=en'), ['/baseline', { word: 'virus', lang: 'en' }]);
  });

  test('each lane keeps its own unit: text rates over dated text, OpenAlex never a rate or share, works counted', () => {
    const lanes = trailResponse().lanes;
    const by = Object.fromEntries(lanes.map((l) => [l.key, laneRow(l)]));
    assert.match(by['trail:literature-text'].text, /^n = 36 in 32 docs · 40M tokens · 0\.9\/M tokens over the lane's dated text$/);
    assert.equal(by['trail:literature-text'].first, 'first observed in this corpus 1885', 'no basis until the first passage is known');
    assert.equal(by['trail:literature-text'].last, 'last observed 1928');
    assert.equal(by['trail:stemm-text:medicine'].first, 'first observed in this corpus 1832 (stated)', 'the server named the basis');
    assert.equal(by['trail:stemm-text:medicine'].passage, 5150);
    const share = by['trail:stemm-abstracts:medicine'];
    assert.equal(laneClass(lanes[3]), 'share');
    assert.ok(!/%|\/M|\/1k|per /.test(share.text), `no rate or share across cells: ${share.text}`);
    assert.equal(share.text, "120 sampled works mention it (title or abstract) · the lane's cells hold 6,000 sampled works · no share across cells");
    assert.match(share.note, new RegExp(SHARE_LANE_NOTE));
    assert.match(by['trail:culture-titles'].text, /^titles: 2 of 94,385 works$/);
    assert.match(by['trail:music-relations'].text, /0 is an observation about this index/);
    assert.equal(laneClass(lanes[5]), 'count', 'a works lane with a rate note is still counted, not a share');
    assert.match(laneRow({ ...lanes[5], n: 3 }).text, /^3 works in documented links \(counted, never a rate\)$/);
    assert.equal(laneRow({ ...lanes[1], state: 'pending', note: 'indexing — not yet looked' }).openable, false);
    assert.equal(laneRow(lanes[1], { basis: 'estimated', passage: 9001 }).first, 'first observed in this corpus 1885 (estimated)');
  });

  test('etymology: each listed root once with the etyma that list it; periods, never dates', () => {
    const m = etymologyModel(fixtureBody('GET', '/api/etymology', 'virus'));
    assert.equal(m.etyma.length, 2);
    assert.equal(m.roots.length, 3, 'the same three PIE roots listed by two etyma appear once each');
    assert.deepEqual(m.roots[0].families, ['ine-pro:*wisos', 'la:virus']);
    const rows = etymologyRows(m);
    assert.match(rows[1].text, /^Latin virus 'venom.*' · Latin 700 BCE–1500, period of the language, not a date$/);
    assert.match(rows.at(-1).text, /^listed roots \(each once\): \*weys- 'to raise, increase' \(PIE\) · \*dʰewb- 'deep, hollow' \(PIE\) · \*dʰewbʰ- 'to sink in' \(PIE\)$/);
    assert.match(rows.at(-1).note, /listed by PIE \*wisós and Latin virus/);
    assert.ok(rows.every((r) => !/\b1[0-9]{3}\b(?!–)/.test(r.text.replace(/700 BCE–1500/, ''))), 'no year is given to a word');
    // the server's deduplicated list (C5) is read as is, never doubled
    const server = etymologyModel({ available: true, families: [{ key: 'la:virus', lang: 'la', form: 'virus', parents: [{ key: 'r1', lang: 'ine-pro', form: '*weys-' }] }],
      roots: [{ key: 'r1', lang: 'ine-pro', form: '*weys-', families: ['la:virus', 'ine-pro:*wisos'] }] });
    assert.equal(server.roots.length, 1);
    assert.deepEqual(server.roots[0].families, ['la:virus', 'ine-pro:*wisos']);
    assert.match(etymologyRows(etymologyModel(fixtureBody('GET', '/api/etymology', 'phrase')))[0].text, /single words only/);
    const chain = etymologyModel({ available: true, families: [{ key: 'sa:x', lang: 'sa', form: 'x', parents: [{ key: 'ine-pro:*y', lang: 'ine-pro', form: '*y' }] },
      { key: 'ine-pro:*y', lang: 'ine-pro', form: '*y', parents: [] }], roots: [{ key: 'ine-pro:*y', lang: 'ine-pro', form: '*y', families: ['sa:x'], is_family: true }] });
    assert.equal(chain.roots.length, 0, 'a root that has its own etymon row is not listed again');
  });

  test('claims are external, dimmed with their reasons, and open the entry; never an occurrence', () => {
    const [c] = claimRows(trailResponse().claims);
    assert.equal(c.text, '◇ Wiktionary: first used 1972 (external claim)');
    assert.equal(c.dimmed, true);
    assert.match(c.note, /shown dimmed: sense-specific: dates the computing sense only/);
    assert.match(c.note, new RegExp(CLAIM_NOTE));
    assert.equal(c.passage, 777001);
    assert.match(claimRows([{ label: 'Wiktionary: coined 1909', display: 'default' }])[0].text, /\(external claim\)$/);
  });

  test('a failed title search is not an observation: no "no titles" claim', () => {
    const rows = crossingsRows({ timeline: { lanes: [] }, search: null });
    assert.match(rows.find((r) => r.key === 'culture').text, /could not be loaded/);
    const withLane = crossingsRows({ timeline: { lanes: [{ key: 'domain:culture~titles', label: 'Culture · titles', unit: 'per_thousand_works', modality: 'titles', n: 1, coverage: { works: 94030 } }] }, search: null });
    assert.equal(withLane.find((r) => r.key === 'culture'), undefined, 'the titles lane speaks for titles');
  });

  test('trail rows: lanes in the server order, no pooled "matches" row, the etymology lane is the etymology rows', () => {
    const rows = crossingsRows({ timeline: trailResponse(), etymology: fixtureBody('GET', '/api/etymology', 'virus'), claims: trailResponse().claims,
      baseline: fixtureBody('GET', '/api/baseline', 'ok'), trail: true });
    const keys = rows.map((r) => r.key);
    assert.ok(!keys.includes('text') && !keys.includes('culture'), 'nothing is pooled across lanes');
    assert.ok(!keys.includes('lane:trail:etymology'));
    assert.deepEqual(keys.filter((k) => k.startsWith('lane:')), ['lane:trail:literature-text', 'lane:trail:stemm-text:medicine',
      'lane:trail:stemm-abstracts:medicine', 'lane:trail:culture-titles', 'lane:trail:music-relations']);
    assert.equal(keys.indexOf('etymology:ine-pro:*wisos'), 0);
    assert.ok(keys.indexOf('claim:0') > keys.indexOf('lane:trail:music-relations'));
    assert.equal(keys.at(-1), 'baseline');
    const absent = rows.find((r) => r.key === 'absent:trail:stemm-text:computing');
    assert.match(absent.text, /^not looked at: No computing/);
    assert.match(rows.at(-1).note, /Google Books Ngram is a different corpus/);
  });
});

// ── Context groups: pure helpers ────────────────────────────────────────────────────────────────────────

describe('context groups: labels, shares over time, rename (§2.D, §2.E, §13 rule 10)', () => {
  const real = () => fixtureBody('GET', '/api/clusters', 'real_demo');
  test('the machine label is always shown; a reader\'s label sits beside it', () => {
    const l = groupLabels({ id: 42, label: 'machine label: counted · hold · ones', human_label: 'honoring the uncounted', human_label_by: 'Reader A', human_label_at: '2026-10-04T10:00:00Z' });
    assert.equal(l.machine, `${MACHINE_PREFIX}counted · hold · ones`);
    assert.equal(l.human, 'honoring the uncounted');
    assert.equal(l.at, '2026-10-04');
    assert.equal(groupLabels({ id: 3, label: null }).machine, 'context group 3 (no machine label)');
  });
  test('shares per window: numbers only for measured windows; gaps keep their state', () => {
    const d = real();
    const s = shareSeries(d, d.clusters[0].id);
    assert.ok(s.length >= 2);
    for (let i = 1; i < s.length; i++) assert.ok((s[i].lo ?? Infinity) >= (s[i - 1].lo ?? -Infinity), 'sorted by time');
    const unc = s.find((w) => w.state === 'uncovered');
    assert.ok(unc, 'the uncovered 1940s window is kept');
    assert.equal(unc.share, null);
    assert.equal(windowWords(unc), `${unc.label}: no sources`);
    assert.match(windowWords(s[0]), /^1900–1939: 100% \[100%, 100%\] of 69 grouped uses$/);
    assert.equal(renderShareChart([{ label: 'undated', lo: null, hi: null, state: 'measured', share: 1, ci: null, n: 3 }]), null, 'no dated window, no chart');
  });
  test('per-slice shares name their denominator: the slice\'s grouped uses, never the group\'s own count', () => {
    const dom = installFakeDom();
    try {
      const b = createGroupBlock({ api: createFakeApi(), cluster: { cluster: 7, label: 'machine label: a · b' },
        slices: { a: { share: 0.146, ci: [0, 0.296], n: 12 }, b: { share: null, ci: null, n: 0 }, names: { a: 'A 1955–1985', b: 'B 1994–2026' }, totals: { a: 82, b: 0 } } });
      assert.match(visibleText(b.el), /A 1955–1985: 14\.6% \[0%, 29\.6%\] \(12 of 82 grouped uses\) · B 1994–2026: no grouped uses/);
    } finally { dom.restore(); }
  });

  test('rename: a new label annotation, or a revision of the reader\'s own label; never empty or too long', () => {
    const c = { id: 42, human_label: 'honoring the uncounted', human_label_by: 'Reader A (synthetic)', label_annotation: 3001 };
    const post = renameRequest(c, '  the   uncounted ');
    assert.deepEqual(post, { ok: true, method: 'post', path: '/annotations', body: { target: { type: 'cluster', ref: '42' }, kind: 'label', body_md: 'the uncounted' } });
    const patch = renameRequest({ ...c, human_label_by: 'you' }, 'held places');
    assert.equal(patch.method, 'patch');
    assert.equal(patch.path, '/annotations/3001');
    assert.equal(renameRequest(c, '   ').ok, false);
    assert.equal(renameRequest(c, 'x'.repeat(81)).ok, false);
    assert.equal(renameRequest(c, 'honoring the uncounted').ok, false);
  });
});

describe('runs a gate card suggests', () => {
  test('suggestion.run and the clusters not_run request both name the body to POST', () => {
    assert.deepEqual(runRequestOf({ run: { stage: 'cluster', params: { expressionId: 5 } } }), { path: '/analysis/runs', body: { stage: 'cluster', params: { expressionId: 5 } } });
    assert.deepEqual(runRequestOf(fixtureBody('GET', '/api/clusters', 'not_run').suggestion), { path: '/analysis/runs', body: { stage: 'cluster', expr: 12 } });
    assert.equal(runRequestOf({ a: { years: [1, 2] } }), null);
    assert.equal(runRequestOf(null), null);
    assert.equal(describeSuggestion({ run: { stage: 'drift', params: {} } }).text, 'Run a drift run first');
  });
  test('the card offers Start only with onRun; the click starts it once', async () => {
    const dom = installFakeDom();
    try {
      const g = fixtureBody('GET', '/api/clusters', 'not_run');
      assert.equal(renderGateCard(g, { title: 'x' }).querySelector('.gate-run'), null, 'no button without a handler');
      const seen = [];
      const card = renderGateCard(g, { title: 'x', onRun: (s) => seen.push(s) });
      const btn = card.querySelector('.gate-run');
      assert.equal(btn.textContent, 'Start: a clustering run');
      btn.click();
      assert.equal(seen.length, 1);
      assert.equal(btn.disabled, true);
      const api = createFakeApi();
      const started = await startSuggestedRun(api, g.suggestion);
      assert.equal(started.job, 303);
      assert.deepEqual(api.calls.at(-1).body, { stage: 'cluster', expr: 12 });
      assert.equal(typeof followJob({}, 303, {}), 'function', 'no SSE client: nothing followed, no throw');
    } finally { dom.restore(); }
  });
});

// ── Constellation labels ────────────────────────────────────────────────────────────────────────────────

describe('constellation labels never clip (§2.B; M5 gate)', () => {
  const inBounds = (b, w, h) => b[0] >= 0 && b[1] >= 0 && b[2] <= w && b[3] <= h;
  const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  test('labels near every edge are shifted inside, never overlap each other or another node', () => {
    const W = 340, H = 300;
    const items = [
      { id: 'a', x: 6, y: 150, r: 5, text: 'machine label: auditors · clerk · department · quota', priority: 9 },
      { id: 'b', x: 334, y: 150, r: 5, text: 'machine label: migrate · schema · null · pipeline', priority: 8 },
      { id: 'c', x: 170, y: 296, r: 20, text: 'carry the zero', priority: 100 },
      { id: 'd', x: 170, y: 4, r: 4, text: 'Brennock\'s Ready Arithmetic (synthetic)', priority: 3 },
      { id: 'e', x: 175, y: 150, r: 10, text: 'sum', priority: 2 },
      { id: 'f', x: 182, y: 152, r: 4, text: 'lesson', priority: 1 },
    ];
    const out = placeLabels(items, { width: W, height: H });
    const boxes = [...out.values()].filter((l) => !l.hidden).map((l) => l.box);
    for (const [id, l] of out) if (!l.hidden) assert.ok(inBounds(l.box, W, H), `${id} inside: ${l.box}`);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i], boxes[j]), 'no two labels overlap');
    for (const [id, l] of out) {
      if (l.hidden) continue;
      for (const it of items) if (it.id !== id) assert.ok(!overlap(l.box, [it.x - it.r, it.y - it.r, it.x + it.r, it.y + it.r]), `${id} clear of node ${it.id}`);
    }
    assert.equal(out.get('c').text, 'carry the zero', 'the expression keeps its whole label');
    assert.ok([...out.values()].every((l) => l.full.length > 0));
  });
  test('a long label is cut with an ellipsis (full text kept); with no room it is left out', () => {
    assert.equal(truncateLabel('machine label: auditors · clerk', 14), 'machine label…');
    assert.equal(truncateLabel('ab😀cd', 3), 'ab…');
    const tight = placeLabels([{ id: 'x', x: 20, y: 15, r: 12, text: 'a very long label that cannot fit anywhere at all here' }], { width: 40, height: 30 });
    assert.equal(tight.get('x').hidden, true);
    const cut = placeLabels([{ id: 'y', x: 60, y: 40, r: 3, text: 'x'.repeat(60) }], { width: 200, height: 100 });
    assert.equal(cut.get('y').truncated, true);
    assert.ok(cut.get('y').text.endsWith('…'));
    assert.ok([...cut.get('y').text].length <= LABEL.maxChars);
  });
  test('a renamed group\'s tooltip still names its machine label', () => {
    assert.equal(nodeTitle({ label: 'the uncounted', type: 'cluster', human_label: 'the uncounted', machine_label: 'machine label: hold · mic' }),
      'the uncounted (cluster) — machine label: hold · mic');
    assert.equal(nodeTitle({ label: 'carry the zero', type: 'expression' }), 'carry the zero (expression)');
  });
});

// ── Compare: ρ against the baseline, within-cell shares ─────────────────────────────────────────────────

describe('Compare: external baseline ρ and OpenAlex cells (§10.2, §10.4)', () => {
  test('ρ in words with its bins; a gated ρ has no words', () => {
    assert.equal(baselineRhoText({ value: 0.62, ci: [0.11, 0.88], n_bins: 9, gate: 'ok' }), 'Does our sample track a larger corpus? Spearman ρ = 0.62 [0.11, 0.88] (9 decades)');
    assert.equal(baselineRhoText({ value: null, gate: 'insufficient_coverage', needed: { decades: 5 }, have: { decades: 3 } }), null);
    assert.equal(baselineRhoText({ value: 0.5, gate: 'not_run' }), null, 'a malformed gated object never shows its value');
  });
  test('a cell under 20 sampled works shows k and n, no share', () => {
    assert.match(cellWords({ field: 'Medicine', years: [1900, 1904], k: 3, n: 12, share: 0.25, ci: [0.09, 0.53], abstracts: 4 }).text,
      /^3 of 12 sampled works · abstracts for 4 · too few sampled works for a share \(needs 20\)$/);
    assert.equal(cellWords({ field: 'Medicine', years: [1950, 1954], k: 30, n: 200, share: 0.15, ci: [0.107, 0.207], abstracts: 143 }).text,
      '30 of 200 sampled works · 15% [10.7%, 20.7%] · abstracts for 143');
  });
});

// ── Rendering ───────────────────────────────────────────────────────────────────────────────────────────

describe('rendering (fake DOM)', () => {
  let dom;
  beforeEach(() => { dom = installFakeDom(); });
  afterEach(() => dom.restore());

  test('Crossings on the Term trail: first/last per lane with its basis, rows open their first passage, the fixed line', async () => {
    const api = trailApi();
    const opened = [];
    const card = createCrossings({ api, exprId: 8, corpus: 'stemm', onOpenPassage: (id) => opened.push(id) });
    dom.document.body.appendChild(card.el);
    await card.ready;
    await settle(20);
    const text = visibleText(card.el);
    assert.match(text, /Term trail across cipher, stemm \(the synthetic demo is never included\)/);
    assert.match(text, /first observed in this corpus 1885 \(estimated\)/, 'basis read from the first passage');
    assert.match(text, /first observed in this corpus 1832 \(stated\)/);
    assert.match(text, /last observed 2020–2024/);
    assert.match(text, new RegExp(SHARE_LANE_NOTE));
    assert.match(text, /◇ Wiktionary: first used 1972 \(external claim\)/);
    assert.match(text, /periods, not dates/);
    assert.ok(text.includes(COPRESENCE_NOTE));
    assert.match(text, /3 counted matches fall outside every trail lane/);
    assert.ok(text.includes(CROSSINGS_CAPTION));
    assert.equal(card.el.querySelector('.cx-row[data-kind="claim"]').classList.contains('is-dimmed'), true);
    const body = api.calls.find((c) => c.path === '/api/timeline/query').body;
    assert.equal(body.corpus, 'real');
    assert.equal(body.lanes.facet, 'trail');
    assert.ok(api.calls.some((c) => c.path === '/api/baseline' && c.query.word === 'virus'), 'the baseline href of the trail is followed');
    assert.ok(!api.calls.some((c) => c.path === '/api/kwic' && c.query.lane === 'trail:stemm-text:medicine'), 'a lane whose first passage the server named is not looked up');
    // every observed lane's first date opens its first passage; the claim opens its entry
    const buttons = card.el.querySelectorAll('.cx-open');
    const lit = buttons.find((b) => b.getAttribute('data-lane') === 'trail:literature-text');
    lit.click();
    await settle();
    assert.deepEqual(opened, [9001]);
    buttons.find((b) => b.getAttribute('data-lane') === 'trail:stemm-text:medicine').click();
    await settle();
    assert.equal(opened.at(-1), 5150);
    byText(card.el, /open the entry/).click();
    assert.equal(opened.at(-1), 777001);
    assert.equal(buttons.filter((b) => b.getAttribute('data-lane') === 'trail:music-relations').length, 0, 'an empty lane has no passage to open');
    card.destroy();
  });

  test('a lane not looked at offers the Adapters page, where its staged source is loaded (fix pass, §8.8)', async () => {
    const api = trailApi();
    let sources = 0;
    const card = createCrossings({ api, exprId: 8, corpus: 'stemm', onOpenPassage: () => {}, onOpenSources: () => { sources++; } });
    dom.document.body.appendChild(card.el);
    await card.ready;
    await settle(20);
    const row = card.el.querySelector('.cx-row[data-kind="absent"]');
    assert.match(visibleText(row), /not looked at: No computing/);
    row.querySelector('.cx-sources').click();
    assert.equal(sources, 1);
    card.destroy();
  });

  test('a server without the trail: the card says so and shows the domains of the expression\'s corpus', async () => {
    const api = trailApi({ trail: false });
    const card = createCrossings({ api, exprId: 8, corpus: 'stemm', onOpenPassage: () => {} });
    await card.ready;
    const text = visibleText(card.el);
    assert.match(text, /Domains of the stemm corpus\. The Term trail is not available here \(Unknown corpus 'real'\.\)/);
    assert.equal(api.calls.filter((c) => c.path === '/api/timeline/query').at(-1).body.lanes.facet, 'domain');
    card.destroy();
  });

  test('a trail that timed out is said as such (not "not available") and can be asked again', async () => {
    const api = trailApi({ trail: 'timeout' });
    const card = createCrossings({ api, exprId: 8, corpus: 'stemm', onOpenPassage: () => {} });
    await card.ready;
    assert.match(visibleText(card.el), /The Term trail could not be loaded \(The query took longer than 5000 ms and was stopped\.\)/);
    const before = api.calls.filter((c) => c.body?.corpus === 'real').length;
    byText(card.el, 'Try the Term trail again').click();
    await settle(10);
    assert.equal(api.calls.filter((c) => c.body?.corpus === 'real').length, before + 1);
    card.destroy();
  });

  test('a synthetic expression is never sent to the virtual corpus (the demo is never part of it)', async () => {
    const api = trailApi({ expr: 'ready' });
    const card = createCrossings({ api, exprId: 12, corpus: 'demo', onOpenPassage: () => {} });
    await card.ready;
    assert.ok(api.calls.filter((c) => c.path === '/api/timeline/query').every((c) => c.body.corpus !== 'real'));
    assert.match(visibleText(card.el), /Domains of the demo corpus \(synthetic demonstration data\)/);
    card.destroy();
  });

  test('a group block: chart without bridged gaps; rename posts a label and keeps the machine label visible', async () => {
    const api = createFakeApi();
    const d = fixtureBody('GET', '/api/clusters', 'real_demo');
    const c = d.clusters[0];
    const renamed = [];
    const block = createGroupBlock({ api, cluster: c, data: d, onRenamed: (l) => renamed.push(l) });
    dom.document.body.appendChild(block.el);
    const svg = block.el.querySelector('svg.cg-chart');
    assert.ok(svg);
    assert.equal(svg.querySelectorAll('path').length, 0, 'no line is drawn across windows');
    assert.ok(svg.querySelectorAll('rect.cg-gap.is-uncovered').length >= 1, 'the uncovered window is drawn as a gap');
    assert.match(svg.getAttribute('aria-label'), /1940–1949: no sources/);
    byText(block.el, 'Rename').click();
    const input = block.el.querySelector('.cg-input');
    input.value = 'school sums';
    input.dispatchEvent(makeEvent('input'));
    byText(block.el, 'Save label').click();
    await settle();
    const call = api.calls.find((x) => x.path === '/api/annotations');
    assert.deepEqual(call.body, { target: { type: 'cluster', ref: String(c.id) }, kind: 'label', body_md: 'school sums' });
    const text = visibleText(block.el);
    assert.match(text, /“school sums”\s+— a reader's label by you/);
    assert.ok(text.includes(groupLabels(c).machine), 'the machine label stays visible after the rename');
    assert.deepEqual(renamed, ['school sums']);
  });

  function inspectorSetup({ variants = {}, state = defaultState('demo') } = {}) {
    const host = dom.document.createElement('div');
    host.id = 'inspector';
    dom.document.body.appendChild(host);
    const store = createStore(state);
    const api = createFakeApi({ variants });
    const handle = mountInspector(host, { store, api, keys: null, announce: () => {} });
    return { host, store, api, handle };
  }

  test('inspector on a Term trail: opening a lane\'s first passage folds the Crossings card so the passage shows (final gate)', async () => {
    const host = dom.document.createElement('div');
    host.id = 'inspector';
    dom.document.body.appendChild(host);
    const store = createStore(decode('v=1&c=real&s=e8'));
    const api = trailApi();
    const handle = mountInspector(host, { store, api, keys: null, announce: () => {} });
    await settle(30);
    assert.ok(trailExpression(store.get().view) !== null, 'a Term trail view');
    const lit = host.querySelectorAll('.cx-open').find((b) => b.getAttribute('data-lane') === 'trail:literature-text');
    assert.ok(lit, 'the card is open with nothing selected');
    lit.click();
    await settle(30);
    assert.equal(store.get().view.selection?.id, 9001, 'the first passage is selected');
    const toggle = host.querySelector('.insp-crossings-toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'the card is folded');
    assert.ok(host.querySelector('.passage-card'), 'the passage is shown');
    toggle.click();
    assert.equal(host.querySelector('.insp-crossings-toggle').getAttribute('aria-expanded'), 'true', 'the toggle reopens it');
    handle.unmount();
  });

  test('inspector NEXT: the use\'s group with its share over time and a rename control', async () => {
    const { host, store, handle } = inspectorSetup();
    selectPassage(store, { passage: 901 });
    await settle(12);
    const g = host.querySelector('.insp-groups');
    const text = visibleText(g);
    assert.match(text, /run #14/);
    assert.ok(g.querySelector('.cg-block'), 'the group block');
    assert.ok(byText(g, /^Rename/), 'a rename control');
    handle.unmount();
  });

  test('inspector NEXT without a run: the not_run card starts a clustering run on request', async () => {
    const { host, store, api, handle } = inspectorSetup({ variants: { 'GET /api/clusters': 'not_run' } });
    selectPassage(store, { passage: 901 });
    await settle(12);
    const g = host.querySelector('.insp-groups');
    assert.match(visibleText(g), /No context groups yet/);
    assert.ok(!api.calls.some((c) => c.path === '/api/analysis/runs'), 'nothing starts on its own');
    byText(g, 'Start: a clustering run').click();
    await settle(6);
    assert.deepEqual(api.calls.find((c) => c.path === '/api/analysis/runs').body, { stage: 'cluster', expr: 12 });
    assert.equal(store.get().ui.jobs?.[303]?.status, 'queued', 'the job appears in the tray');
    handle.unmount();
  });

  test('inspector NEXT with a gated run shows the gate, no shares', async () => {
    const { host, store, handle } = inspectorSetup({ variants: { 'GET /api/clusters': 'gated' } });
    selectPassage(store, { passage: 901 });
    await settle(12);
    const g = host.querySelector('.insp-groups');
    assert.ok(g.querySelector('.gate-card'));
    assert.equal(g.querySelector('.cg-block'), null);
    handle.unmount();
  });

  test('a Term trail opens the Crossings card of its expression before any selection (§10.5)', async () => {
    assert.equal(dockFor({ open: true, selected: false, narrow: false, wide: true, rightPanel: null, trail: true }), 'right');
    assert.equal(dockFor({ open: true, selected: false, narrow: true, wide: false, rightPanel: null, trail: true }), 'closed');
    assert.equal(dockFor({ open: true, selected: false, narrow: false, wide: true, rightPanel: null }), 'slim');
    const s = defaultState('demo');
    s.strands = [{ type: 'expression', id: 12 }];
    s.lanes = { ...s.lanes, facet: 'trail' };
    assert.equal(trailExpression(s), 12);
    assert.equal(trailExpression({ ...s, strands: [...s.strands, { type: 'expression', id: 13 }] }), null);
    const { host, handle } = inspectorSetup({ state: s });
    await settle(12);
    assert.match(visibleText(host), /Crossings: 'carry the zero'/);
    assert.match(visibleText(host), /select a mark on the Scroll/);
    handle.unmount();
  });

  test('Compare: ρ against the baseline, a gated ρ as a gate card with no numeral, OpenAlex cells side by side', async () => {
    const s = defaultState('demo');
    s.strands = [{ type: 'expression', id: 12 }];
    s.compare = { a: { years: [1955, 1985], f: '' }, b: { years: [1994, 2026], f: '' } };
    s.panels = { inspector: 'tnn', right: 'compare' };
    const render = async (extra) => {
      const host = dom.document.createElement('div');
      dom.document.body.appendChild(host);
      const api = createFakeApi();
      const post = api.post;
      api.post = async (path, body, opts) => (path === '/compare' ? { ...fixtureBody('POST', '/api/compare', 'ok'), ...extra } : post(path, body, opts));
      const handle = mountCompare(host, { store: createStore(structuredClone(s)), api, keys: null, announce: () => {} });
      await settle(10);
      return { host, handle };
    };
    let r = await render({ baseline_rho: { value: 0.62, ci: [0.11, 0.88], n_bins: 9, gate: 'ok', note: null } });
    let sec = r.host.querySelector('.cmp-section[data-section="baseline"]');
    assert.match(visibleText(sec), /Spearman ρ = 0\.62 \[0\.11, 0\.88\] \(9 decades\)/);
    assert.ok(visibleText(sec).includes(BASELINE_RHO_LABEL));
    r.handle.unmount();
    r = await render({ baseline_rho: { value: null, ci: null, n_bins: 3, gate: 'insufficient_coverage', needed: { decades: 5 }, have: { decades: 3 }, suggestion: null, note: 'Our rate gate passes in 3 decades.' } });
    sec = r.host.querySelector('.cmp-section[data-section="baseline"]');
    assert.ok(sec.querySelector('.gate-card'));
    assert.ok(!/ρ =/.test(visibleText(sec)));
    assert.ok(visibleText(sec).includes(BASELINE_RHO_LABEL));
    r.handle.unmount();
    r = await render({ within_cell: { a: [{ cell: 'Medicine|1955-1959', field: 'Medicine', years: [1955, 1959], k: 30, n: 200, share: 0.15, ci: [0.107, 0.207], abstracts: 143 }],
      b: [{ cell: 'Medicine|2020-2024', field: 'Medicine', years: [2020, 2024], k: 2, n: 9, share: 0.22, ci: [0.06, 0.55], abstracts: 9 }],
      method: 'k of n sampled works mention the expression; Wilson 95% CI', note: 'Each cell is its own sample; never a trend across cells.' } });
    sec = r.host.querySelector('.cmp-section[data-section="within_cell"]');
    const t = visibleText(sec);
    assert.match(t, /Medicine 1955–1959\s+30 of 200 sampled works · 15% \[10\.7%, 20\.7%\]/);
    assert.match(t, /Medicine 2020–2024\s+2 of 9 sampled works · abstracts for 9 · too few sampled works for a share/);
    assert.ok(!t.includes('22%'), 'no share for a cell under 20 works');
    r.handle.unmount();
  });

  test('Compare: a not_run gate with suggestion.run starts that run on request and compares again when it ends', async () => {
    const s = defaultState('cipher');
    s.strands = [{ type: 'expression', id: 14 }];
    s.compare = { a: { years: [1875, 1899], f: '' }, b: { years: [1900, 1928], f: '' } };
    s.panels = { inspector: 'tnn', right: 'compare' };
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const store = createStore(s);
    const api = createFakeApi({ variants: { 'POST /api/compare': 'drift_not_run' } });
    const handle = mountCompare(host, { store, api, keys: null, announce: () => {} });
    await settle(10);
    const sec = host.querySelector('.cmp-section[data-section="clusters"]');
    byText(sec, 'Start: a clustering run').click();
    await settle(6);
    assert.deepEqual(api.calls.find((c) => c.path === '/api/analysis/runs').body, { stage: 'cluster', params: { expr: 14 } });
    assert.ok(store.get().ui.jobs?.[303], 'the job appears in the tray');
    // the fixture's job stream ends the job: Compare asks again with the same slices
    assert.equal(api.calls.filter((c) => c.path === '/api/compare').length, 2);
    handle.unmount();
  });

  test('the notebook on a context group (a cluster lane\'s Rename) shows the group block with its rename control', async () => {
    const s = defaultState('demo');
    s.strands = [{ type: 'expression', id: 12 }];
    s.selection = { type: 'cluster', id: 42 };
    s.panels = { inspector: 'tnn', right: 'notebook' };
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const api = createFakeApi();
    const handle = mountNotebook(host, { store: createStore(s), api, keys: null, announce: () => {} });
    await settle(10);
    const block = host.querySelector('.nb-cgroup .cg-block');
    assert.ok(block, 'the group block');
    assert.match(visibleText(block), /machine label: counted · hold · ones/);
    assert.ok(byText(block, /^Rename/));
    assert.ok(api.calls.some((c) => c.path === '/api/clusters' && c.query.expr === '12'));
    handle.unmount();
  });

  test('Lineage opened without a root (a hand-written link) follows the resolved selection', async () => {
    const s = defaultState('demo');
    s.selection = { type: 'occurrence', id: 55012 };
    s.panels = { inspector: 'tnn', right: 'lineage' };
    const store = createStore(s);
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const handle = mountLineage(host, { store, api: createFakeApi(), keys: null, announce: () => {} });
    await settle();
    assert.equal(store.get().view.lineage.root, null, 'an unresolved occurrence is not guessed');
    store.dispatch({ type: 'UI_SET', key: 'selectionContext', value: { occ: 55012, passage: 901 } });
    await settle();
    assert.equal(store.get().view.lineage.root, 'passage:901');
    handle.unmount();
  });

  test('constellation: every label sits inside its drawing; a renamed group keeps its machine label in the tooltip', async () => {
    const s = defaultState('demo');
    s.strands = [{ type: 'expression', id: 12 }];
    s.constellation = { ...s.constellation, a: [1990, 2005], b: [2010, 2026] };
    s.panels = { inspector: 'tnn', right: 'constellation' };
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const handle = mountConstellation(host, { store: createStore(s), api: createFakeApi(), keys: null, announce: () => {} });
    await settle();
    const svg = host.querySelector('.con-svg');
    const [, , vw, vh] = svg.getAttribute('viewBox').split(' ').map(Number);
    for (const t of svg.querySelectorAll('.con-label')) {
      const x = Number(t.getAttribute('x')), y = Number(t.getAttribute('y'));
      assert.ok(x >= 0 && x + [...t.textContent].length * 6.4 <= vw + 1 && y - LABEL.font >= 0 && y <= vh, `'${t.textContent}' at ${x},${y} inside ${vw}×${vh}`);
    }
    for (const g of svg.querySelectorAll('.con-node')) assert.ok(g.querySelector('title')?.textContent, 'every node has a tooltip');
    handle.unmount();
  });
});
