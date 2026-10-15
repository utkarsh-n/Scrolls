// OWNER: WP7 — Compare and gate cards (SPEC §2.E, §4.11, §11 "a gated payload renders no numeral", §13 rules 7–8).
// Renders every POST /api/compare fixture variant (ok, gated, modality_mismatch, invalid, error) into the fake
// DOM, checks section order (coverage first), the multiplicity line, caveats, and that a gated object's card
// shows gate / needs / has / suggestion and no numeral of its own. Also sends real request bodies to the mock
// server so they are checked against the CompareRequest shape.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/ui/core/store.mjs';
import { createApi } from '../src/ui/core/api.mjs';
import { defaultState } from '../src/shared/viewstate.mjs';
import { dayFromYMD } from '../src/shared/dates.mjs';
import { check } from '../src/shared/contracts.mjs';
import {
  compareRequest, firedCaveats, gatedParts, measureText, mount as mountCompare, multiplicityLine, shareList, yearsFromRange,
} from '../src/ui/panels/compare.mjs';
import { describeHave, describeNeeded, describeSuggestion, gateCardModel, isGated, NO_WIDENING, renderGateCard } from '../src/ui/panels/gate-card.mjs';
import { byText, createFakeApi, fixtureBody, fixtureVariantsOf, installFakeDom, settle, visibleText } from './ui.panels.fakedom.mjs';
import { startServerInProcess } from './helpers/server.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'error';

const OK = () => fixtureBody('POST', '/api/compare', 'ok');
const GATED = () => fixtureBody('POST', '/api/compare', 'gated');
const MODALITY = () => fixtureBody('POST', '/api/compare', 'modality_mismatch');

function compareState({ expr = [12], a = [1955, 1985], b = [1994, 2026] } = {}) {
  const s = defaultState('demo');
  s.strands = expr.map((id) => ({ type: 'expression', id }));
  s.compare = a && b ? { a: { years: a, f: '' }, b: { years: b, f: '' } } : null;
  s.panels = { inspector: 'tnn', right: 'compare' };
  return s;
}

/** Every numeral in a string ('2,850.5' → '2850.5'; '97.5th' → '97.5'). */
function numerals(text) {
  return (String(text).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));
}

/** Numerals a gate card may legitimately print: those in needed, have, suggestion and note/reason. */
function allowedNumerals(gated) {
  const src = JSON.stringify({ n: gated.needed ?? null, h: gated.have ?? null, s: gated.suggestion ?? null, note: gated.note ?? null, r: gated.reason ?? null });
  const set = new Set(src.match(/\d+(?:\.\d+)?/g) ?? []);   // JSON numbers carry no thousands separators
  // shares in `have` (0.6) render as percentages (60%)
  for (const n of [...set]) if (Number(n) > 0 && Number(n) <= 1) set.add(String(Number((Number(n) * 100).toFixed(1))));
  // the same numbers rounded for display (0.2273 → 0.227 / 0.23; M1 gate: real payloads carry 4-decimal shares)
  for (const n of [...set]) if (n.includes('.')) for (const d of [0, 1, 2, 3]) set.add(String(Number(Number(n).toFixed(d))));
  return set;
}

/** All gated objects of a Compare payload, with a label. */
function gatedObjects(p) {
  const out = [];
  if (isGated(p.freq)) out.push(['freq', p.freq]);
  // per-slice gated frequency and rate ratio (WP4 sends them; fixture variant freq_gated, added at the M1 gate)
  for (const k of ['a', 'b', 'rate_ratio']) if (isGated(p.freq?.[k])) out.push([`freq.${k}`, p.freq[k]]);
  if (isGated(p.collocates)) out.push(['collocates', p.collocates]);
  if (isGated(p.clusters)) out.push(['clusters', p.clusters]);
  for (const m of p.measures ?? []) if (isGated(m)) out.push([m.metric, m]);
  if (isGated(p.tone)) out.push(['tone', p.tone]);
  return out;
}

// ── Pure logic ───────────────────────────────────────────────────────────────────────────────────────

describe('gate card model (§4.11)', () => {
  test('needs / has / suggestion in words; suggestion null → "no widening …"', () => {
    const m = gateCardModel(OK().measures[2]);
    assert.equal(m.gate, 'slice_too_small');
    assert.equal(m.needed, '≥ 3,000,000 tokens per slice');
    assert.equal(m.have, 'A 21,400 tokens · B 30,100 tokens');
    assert.equal(m.suggestion.text, NO_WIDENING);
    assert.equal(m.suggestion.applicable, false);
  });
  test('per-slice counts, share maps and strings are described', () => {
    assert.equal(describeHave({ a: { occurrences: 7, documents: 2 }, b: { occurrences: 15, documents: 5 } }),
      'A 7 occurrences, 2 documents · B 15 occurrences, 5 documents');
    assert.equal(describeHave({ a: { text: 1 }, b: { titles: 1 } }), 'A text 100% · B titles 100%');
    assert.equal(describeHave({ adapter: null }), 'adapter: none');
    assert.equal(describeNeeded({ occurrences_per_slice: 50, documents_per_slice: 5 }), '≥ 50 occurrences per slice, ≥ 5 documents per slice');
    assert.equal(describeNeeded({ modality: 'the same dominant modality in both slices' }), 'the same dominant modality in both slices');
  });
  test('a suggestion with slices can be applied and names them', () => {
    const s = describeSuggestion(MODALITY().freq.suggestion);
    assert.equal(s.applicable, true);
    assert.equal(s.text, 'Compare titles with titles (A 1840–1899 · B 1990–2026)');
    const w = describeSuggestion({ a: { years: [1840, 1899] }, would_have: { a: { occurrences: 61, documents: 9 } } });
    assert.equal(w.text, 'Widen to A 1840–1899 would give A 61 occurrences, 9 documents');
  });
});

describe('compare request and summaries', () => {
  test('the request carries the pinned expressions, both slices, every measure and the toggles', () => {
    const r = compareRequest(compareState());
    assert.equal(r.ok, true);
    assert.deepEqual(r.body.expr, [12]);
    assert.deepEqual(r.body.a, { years: [1955, 1985], f: '' });
    assert.deepEqual(r.body.b, { years: [1994, 2026], f: '' });
    assert.deepEqual(r.body.measures, ['freq', 'collocates', 'clusters', 'sense_share_jsd', 'neighbor_overlap', 'aligned_displacement', 'tone']);
    assert.deepEqual(check('CompareRequest', r.body), []);
    const s = compareState();
    s.f.syn = 0;
    assert.equal(compareRequest(s).body.a.f, 'syn:0', 'the view filter applies when a slice has none');
    assert.deepEqual(compareRequest(compareState({ a: null })), { ok: false, missing: 'slices' });
    assert.deepEqual(compareRequest(compareState({ expr: [] })), { ok: false, missing: 'expression' });
    assert.equal(compareRequest(compareState(), { seed: 7 }).body.seed, 7);
  });
  test('years from a Scroll range', () => {
    assert.deepEqual(yearsFromRange([dayFromYMD(1955, 3, 1), dayFromYMD(1985, 6, 1)]), [1955, 1985]);
    assert.equal(yearsFromRange(null), null);
  });
  test('the multiplicity line: server text, else computed with 100 − 5/k', () => {
    assert.match(multiplicityLine(OK().multiplicity), /^Comparison #1 for 'carry the zero'/);
    const line = multiplicityLine({ k: 7, notable_so_far: 1, threshold_percentile: 99.3 }, 'virus');
    assert.equal(line, "Comparison #7 for 'virus' in this session; 1 of 7 crossed the notable threshold; with 7 comparisons, ~0.35 are expected by chance at the 95th percentile. Notable threshold is the 99.3th percentile.");
  });
  test('fired caveats list composition, gates, modality and synthetic data', () => {
    const ok = firedCaveats(OK());
    assert.ok(ok.some((c) => /differ in composition \(JSD 0\.48\)/.test(c)));
    assert.ok(ok.some((c) => /neighbour overlap, aligned displacement/.test(c)));
    assert.ok(ok.some((c) => /SYNTHETIC/.test(c)));
    assert.deepEqual(gatedParts(GATED()), ['neighbouring terms', 'context groups', 'context-share shift', 'neighbour overlap', 'aligned displacement', 'machine tone']);
    assert.ok(firedCaveats(MODALITY()).some((c) => /different media/.test(c)));
    assert.ok(firedCaveats(GATED()).some((c) => /adjusted to the 97\.5th percentile/.test(c)));
  });
  test('a measure that passed its gate keeps the server sentence; otherwise value, CI, n, documents', () => {
    assert.match(measureText(OK().measures[0]), /^Context-share shift JSD 0\.71 \[0\.62, 0\.79\]/);
    assert.equal(measureText({ metric: 'sense_share_jsd', value: 0.21, ci: [0.14, 0.29], n: [212, 388], docs: [31, 54] }),
      'Context-share shift 0.21 [0.14, 0.29] · n = 212 / 388 · 31 / 54 documents');
    assert.equal(shareList({ memo: 0.6, bulletin: 0.4 }), 'memo 60%, bulletin 40%');
  });
});

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────────

describe('Compare rendering (fake DOM, every fixture variant)', () => {
  let dom;
  beforeEach(() => { dom = installFakeDom(); });
  afterEach(() => dom.restore());

  function setup({ variant = 'ok', state = compareState(), narrow = false, keys = null } = {}) {
    dom.setNarrow(narrow);
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const store = createStore(state);
    const api = createFakeApi({ variants: { 'POST /api/compare': variant } });
    const announced = [];
    const handle = mountCompare(host, { store, api, keys, announce: (t) => announced.push(t) });
    return { host, store, api, handle, announced };
  }

  test('ok: coverage comes first, then frequency, passages, terms, groups, displacement, tone, caveats', async () => {
    const { host, store, api } = setup();
    await settle();
    const order = host.querySelectorAll('.cmp-section').map((s) => s.getAttribute('data-section'));
    assert.deepEqual(order, ['coverage', 'freq', 'passages', 'collocates', 'clusters', 'measures', 'tone', 'caveats']);
    const body = host.querySelector('.cmp-body');
    assert.ok(body.children[0].classList.contains('cmp-multiplicity'), 'the multiplicity line is item 0');
    const text = visibleText(host);
    assert.match(text, /Comparison #1 for 'carry the zero'/);
    assert.match(text, /The slices differ in composition \(JSD 0\.48\)/);
    assert.match(text, /61 matches · 2,851\/M tokens \[2,180, 3,662\]/);
    assert.match(text, /Rate ratio B \/ A 1\.42 \[1\.04, 1\.96\]/);
    assert.match(text, /Standardized to the pooled composition/);
    assert.match(text, /context words, not meanings/);
    assert.match(text, /“honoring the uncounted”\s+— a reader's label by Reader A \(synthetic\)\s*machine label: counted · hold · ones\s+\(kept\)/, 'the machine label stays visible');
    assert.match(text, /new use in B/);
    assert.match(text, /estimated shift in usage contexts/);
    assert.match(text, /sampling seed 771/);
    assert.match(text, /Tone needs the optional on-device adapter \(not installed\)/);
    assert.equal(store.get().ui.comparisonsTried, 1);
    const req = api.calls.find((c) => c.path === '/api/compare');
    assert.deepEqual(check('CompareRequest', req.body), []);
    assert.ok(host.querySelector('.compare').classList.contains('syn-frame'));
  });

  test('a gated payload renders no numeral for any gated measure (§11, §13 rule 7)', async () => {
    for (const variant of ['ok', 'gated', 'modality_mismatch', 'freq_gated', 'collocates_not_run']) { // the last two added at the M1 gate
      const { host } = setup({ variant });
      await settle();
      const payload = fixtureBody('POST', '/api/compare', variant);
      const gated = gatedObjects(payload);
      assert.ok(gated.length >= 3, `${variant} has gated parts`);
      const cards = host.querySelectorAll('.gate-card');
      assert.ok(cards.length >= gated.length, `${variant}: a card per gated part (${cards.length} cards, ${gated.length} gated)`);
      for (const card of cards) {
        const label = card.getAttribute('aria-label');
        const owner = gated.find(([, g]) => card.getAttribute('data-gate') === g.gate
          && numerals(visibleText(card)).every((n) => allowedNumerals(g).has(n)));
        assert.ok(owner, `${variant}: card '${label}' prints only numerals from needed/have/suggestion/note: ${visibleText(card)}`);
      }
      // No measure line exists for a gated metric.
      for (const [metric] of gated) assert.equal(host.querySelector(`.cmp-measure[data-metric="${metric}"]`), null, `${variant}/${metric}`);
      host.remove();
    }
  });

  test('even a malformed gated object carrying a value never shows it', () => {
    const bogus = { metric: 'aligned_displacement', gate: 'slice_too_small', value: 0.987654, ci: [0.912345, 0.998765],
      needed: { tokens_per_slice: 3000000 }, have: { a: 21400, b: 30100 }, suggestion: null };
    const card = renderGateCard(bogus, { title: 'Aligned displacement: not estimated' });
    const text = visibleText(card);
    for (const n of ['0.987654', '0.988', '0.99', '0.912345', '0.912', '0.998765']) assert.ok(!text.includes(n), `${n} not shown`);
    assert.match(text, /≥ 3,000,000 tokens per slice/);
    assert.match(text, /No widening inside this corpus reaches the gate\./);
  });

  test('a gate card says its gate in words; the code sits only in its details line (fix pass)', () => {
    const card = renderGateCard({ metric: 'neighbor_overlap', gate: 'insufficient_occurrences', needed: { occurrences_per_slice: 20 },
      have: { a: 7, b: 15 }, suggestion: null }, { title: 'Neighbour overlap: not estimated' });
    assert.equal(card.querySelector('.gate-code').textContent, 'too few occurrences');
    assert.ok(!card.querySelector('.gate-head').textContent.includes('insufficient_occurrences'), 'no code in the header');
    assert.equal(card.querySelector('.gate-detail code').textContent, 'insufficient_occurrences');
  });

  test('gated (◉ kiln eye): KWIC passages still show; every gate card has needs, has and a suggestion line', async () => {
    const { host } = setup({ variant: 'gated' });
    await settle();
    const text = visibleText(host);
    assert.match(text, /Too few occurrences \(7 and 15; needs 20\)\. Showing KWIC\./);
    assert.ok(host.querySelectorAll('.cmp-section[data-section="passages"] .kwic-row').length === 4);
    for (const card of host.querySelectorAll('.gate-card')) {
      const t = visibleText(card);
      assert.match(t, /Has/);
      assert.match(t, /Suggestion/);
    }
    assert.match(text, /adjusted to the 97\.5th percentile/);
  });

  test('modality mismatch: refused by default, [Compare titles with titles] applies the suggestion, "compare anyway" is descriptive', async () => {
    const { host, store, api } = setup({ variant: 'modality_mismatch' });
    await settle();
    const text = visibleText(host);
    assert.match(text, /Cross-media comparison refused/);
    assert.match(text, /A is book text, B is film titles/);
    assert.ok(!/Rate ratio/.test(text), 'no ratio across media');
    const apply = host.querySelectorAll('.gate-apply').find((b) => b.textContent === 'Compare titles with titles');
    assert.ok(apply);
    apply.click();
    await settle();
    assert.deepEqual(store.get().view.compare, {
      a: { years: [1840, 1899], f: 'coll:cipher-culture-works' }, b: { years: [1990, 2026], f: 'coll:cipher-culture-works' },
    });
    const n = api.calls.filter((c) => c.path === '/api/compare').length;
    assert.ok(n >= 2, 'applying re-runs the comparison');
    const anyway = byText(host, 'Compare anyway (descriptive only)');
    anyway.click();
    await settle();
    const last = api.calls.filter((c) => c.path === '/api/compare').at(-1);
    assert.equal(last.body.override, 'descriptive');
  });

  test('errors show the server message, hint and Retry (QUERY_TIMEOUT suggests narrowing)', async () => {
    for (const variant of ['error', 'invalid']) {
      const { host, api } = setup({ variant });
      await settle();
      const body = fixtureBody('POST', '/api/compare', variant);
      const text = visibleText(host);
      assert.ok(text.includes(body.error.message), variant);
      if (body.error.hint) assert.ok(text.includes(body.error.hint), `${variant} hint`);
      const before = api.calls.length;
      byText(host, 'Retry').click();
      await settle();
      assert.ok(api.calls.length > before, `${variant}: Retry asks again`);
      host.remove();
    }
  });

  test('empty states: no slices → the slice editor; no expression → pin one', async () => {
    const a = setup({ state: compareState({ a: null }) });
    await settle();
    assert.match(visibleText(a.host), /Set two slices/);
    assert.ok(a.host.querySelector('.cmp-editor'));
    assert.equal(a.api.calls.filter((c) => c.path === '/api/compare').length, 0);
    a.host.remove();
    const b = setup({ state: compareState({ expr: [] }) });
    await settle();
    assert.match(visibleText(b.host), /Pin an expression \(P\)/);
  });

  test('typing years in the editor sets both slices and compares', async () => {
    const { host, store, api } = setup({ state: compareState({ a: null }) });
    await settle();
    const years = host.querySelectorAll('input.cmp-year');
    [1955, 1985, 1994, 2026].forEach((y, i) => { years[i].value = String(y); });
    byText(host, 'Compare').click();
    await settle();
    assert.deepEqual(store.get().view.compare, { a: { years: [1955, 1985], f: '' }, b: { years: [1994, 2026], f: '' } });
    assert.ok(api.calls.some((c) => c.path === '/api/compare'));
  });

  test('the timeline\'s A / B / C (SET_COMPARE slices, OPEN_PANEL) drive Compare (§8.5)', async () => {
    const state = compareState({ a: null });
    state.panels.right = null;
    const { host, store, api } = setup({ state });
    store.dispatch({ type: 'SET_COMPARE', slice: 'a', years: [1955, 1985], f: '' });
    store.dispatch({ type: 'SET_COMPARE', slice: 'b', years: [1994, 2026], f: '' });
    assert.equal(api.calls.filter((c) => c.path === '/api/compare').length, 0, 'nothing is computed while Compare is closed');
    store.dispatch({ type: 'OPEN_PANEL', panel: 'compare' });
    await settle();
    const req = api.calls.find((c) => c.path === '/api/compare');
    assert.deepEqual([req.body.a.years, req.body.b.years], [[1955, 1985], [1994, 2026]]);
    assert.ok(host.querySelector('.cmp-body'));
  });

  test('a passage row opens the inspector on that passage; reshuffle draws again with a new seed', async () => {
    const { host, store, api } = setup();
    await settle();
    host.querySelector('.cmp-section[data-section="passages"] .kwic-row[data-passage="901"]').click();
    assert.deepEqual(store.get().view.selection, { type: 'passage', id: 901 });
    byText(host, 'Reshuffle').click();
    await settle();
    const last = api.calls.filter((c) => c.path === '/api/compare').at(-1);
    assert.ok(Number.isInteger(last.body.seed));
  });

  test('narrow: a full-screen sheet with a back button; nothing needs hover', async () => {
    const { host, store } = setup({ narrow: true });
    await settle();
    byText(host, '← Back').click();
    assert.equal(store.get().view.panels.right, null);
    assert.equal(host.querySelector('.compare').hidden, true);
    assert.deepEqual(dom.hoverListenerTypes(), []);
  });

  test('every Compare fixture body is a valid Compare shape', () => {
    for (const { name, status, body } of fixtureVariantsOf('POST', '/api/compare')) {
      assert.deepEqual(check(status >= 400 ? 'ErrorBody' : 'Compare', body), [], name);
    }
  });
});

// ── Real request bodies against the mock server (request-shape validation) ─────────────────────────

describe('Compare against SCROLLS_MOCK (over HTTP)', () => {
  let srv;
  let dom;
  beforeEach(async () => { srv = await startServerInProcess({ mock: true }); dom = installFakeDom(); });
  afterEach(async () => { dom.restore(); await srv.cleanup(); });

  test('the body the panel sends passes the server\'s CompareRequest check and renders', async () => {
    const origin = new URL(srv.url).origin;
    const fetchImpl = (u, init = {}) => fetch(new URL(u, srv.url), { ...init, headers: { ...(init.headers ?? {}), Origin: origin } });
    const api = createApi({ base: '/api', sessionId: 'test', fetchImpl });
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const store = createStore(compareState());
    const handle = mountCompare(host, { store, api, keys: null, announce: () => {} });
    for (let i = 0; i < 50 && !host.querySelector('.cmp-body') && !host.querySelector('.state-card.is-error'); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(host.querySelector('.cmp-body'), visibleText(host));
    assert.match(visibleText(host), /Comparison #1/);
    handle.unmount(); // the context groups' GET /api/clusters may still be in flight: nothing renders after unmount
  });
});
