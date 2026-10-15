// OWNER: WP7 — P2 panels: link words, genealogy elbows and density, lineage hypotheses and fans, notebook layers,
// as-of and shared evidence, the editor's custom dimensions and evidence, Crossings per domain, Adapters progress and
// the constellation's periods (SPEC §2.B, §2.C, §2.C2, §2.D, §2.F, §10, §13). Pure helpers directly; rendering
// through the fake DOM against the contract fixtures.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/ui/core/store.mjs';
import { createKeys } from '../src/ui/core/keys.mjs';
import { defaultState } from '../src/shared/viewstate.mjs';
import { check } from '../src/shared/contracts.mjs';
import { linkWords, renderLinkLine, runText } from '../src/ui/panels/edge-card.mjs';
import { densityStrip, genealogyQuery, mount as mountGenealogy } from '../src/ui/panels/genealogy.mjs';
import { groupFans, hypothesisRequest, layoutLineage, LIST_PAGE, mount as mountLineage, rootForSelection } from '../src/ui/panels/lineage.mjs';
import { asOfStops, evidenceKey, layerLine, mount as mountNotebook, sharedEvidence } from '../src/ui/panels/notebook.mjs';
import { anchorFor, annotationRequest, customValue, readEvidenceRefs } from '../src/ui/panels/annotation-editor.mjs';
import { crossingsRows, laneRow, sparkPath } from '../src/ui/panels/crossings.mjs';
import { progressText } from '../src/ui/panels/adapters.mjs';
import { mount as mountConstellation } from '../src/ui/panels/constellation.mjs';
import { byText, createFakeApi, fixtureBody, installFakeDom, makeEvent, settle, visibleText } from './ui.panels.fakedom.mjs';

describe('link words: pattern, glyph and words, never colour alone (§8.7)', () => {
  test('status word, badge and review overlay in words; the server label wins', () => {
    const w = linkWords({ rel_type: 'proposed_allusion', evidence_status: 'proposed', review_status: 'disputed' });
    assert.equal(w.badge, 'PROP');
    assert.equal(w.status, 'proposed');
    assert.equal(w.review, '⚖ disputed');
    assert.equal(w.style.dash.join(), '1,3', 'dotted whatever the review says');
    assert.equal(linkWords({ rel_type: 'explicit_citation', evidence_status: 'documented', label: 'cites', glyph: '§' }).label, 'cites');
    assert.equal(linkWords({ rel_type: 'cover_of', evidence_status: 'documented', provenance_quality: 'source_unrecorded', date_conflict: true }).badge, 'DOC* ⚠');
  });
  test('run text carries the parameters of a computed link', () => {
    assert.equal(runText({ run: { id: 5, pipeline_version: 'reuse-index@1.0.0', params: { k: 8, w: 6 }, status: 'succeeded' } }), 'run 5 · reuse-index@1.0.0 · k 8 · w 6');
    assert.equal(runText({ run_id: 9 }), 'run 9');
    assert.equal(runText({}), null);
  });
});

describe('genealogy helpers', () => {
  test('a maker seed queries maker=, a work seed work=', () => {
    const v = defaultState('cipher');
    assert.equal(genealogyQuery(v, { work: 'maker:The Winstons' }).maker, 'The Winstons');
    assert.equal(genealogyQuery(v, { work: 'maker:The Winstons' }).work, undefined);
    assert.equal(genealogyQuery(v, { work: 'document:90443' }).work, 'document:90443');
  });
  test('density strip: shared decades, per-generation counts, totals', () => {
    const d = densityStrip({ generations: [{ gen: 1, total: 32, by_decade: { 1980: 4, 1990: 6 } }, { gen: -1, total: 1, by_decade: { 1970: 1 } }] });
    assert.deepEqual(d.decades, [1970, 1980, 1990]);
    assert.deepEqual(d.rows.map((r) => [r.gen, r.counts]), [[-1, [1, 0, 0]], [1, [0, 4, 6]]]);
    assert.equal(d.max, 6);
  });
});

describe('lineage helpers (P2)', () => {
  test('G with nothing selected follows the pinned work (Genealogy) or maker', () => {
    assert.equal(rootForSelection(null, {}, [{ type: 'expression', id: 1 }, { type: 'work', id: 3659 }]), 'document:3659');
    assert.equal(rootForSelection(null, {}, [{ type: 'maker', id: 'The Winstons' }]), 'maker:The Winstons');
    assert.equal(rootForSelection(null, {}, []), null);
  });
  test('the root passage\'s document sits under the root; years stay linear; the graph grows with the years', () => {
    const lay = layoutLineage({ root: 'passage:55', nodes: [
      { id: 'passage:55', y: 1994, generation: 0, direction: 'root' },
      { id: 'document:15', y: 1994, generation: 0, root_document: true },
      { id: 'document:4', y: 1911, generation: 1 }, { id: 'document:24', y: 2016, generation: 1 }] }, { width: 640 });
    const at = (id) => lay.nodes.find((n) => n.id === id);
    assert.equal(at('document:15').x, at('passage:55').x);
    assert.ok(at('document:15').rootDoc && at('document:15').y > at('passage:55').y);
    assert.ok(lay.width >= 640);
  });
  test('competing hypotheses fan from the item whose source is asked about; a new one is proposed, never documented', () => {
    const f = fixtureBody('GET', '/api/lineage', 'ok');
    assert.deepEqual(groupFans(f), [{ group: 4, node: 'passage:2210', n: 2, question: "Where does Vyas's 2017 line come from?" }]);
    const body = hypothesisRequest({ target: 'passage:2210', source: 'passage:77', relType: 'proposed_allusion', note: ' the counting line echoes the primer ', group: 4,
      evidence: { passage: 2210, start: 0, end: 12, relative: true } });
    assert.deepEqual(check('RelationshipRequest', body), []);
    assert.equal(body.src, 'passage:2210');
    assert.equal(body.note, 'the counting line echoes the primer');
    assert.equal(body.evidence[0].role, 'supporting');
    assert.ok(!('evidence_status' in body), 'the server forces proposed');
  });
});

describe('notebook helpers (P2)', () => {
  test('as-of stops are the days interpretations changed', () => {
    assert.deepEqual(asOfStops([{ created_at: '2026-10-02T11:00:00Z', superseded_at: '2026-10-03T14:00:00Z' }, { created_at: '2026-10-03T15:00:00Z', rev_at: 'x' }]),
      ['2026-10-02', '2026-10-03']);
  });
  test('a superseded interpretation is a named historical layer', () => {
    assert.equal(layerLine({ status: 'superseded', layer: 'Reader A, 2026-10-03', superseded_at: '2026-11-12T10:00:00Z', superseded_by: 231 }),
      "Layer 'Reader A, 2026-10-03' — superseded 2026-11-12 by 231");
    assert.equal(layerLine({ status: 'withdrawn', author: 'you', created_at: '2026-10-04T00:00:00Z', withdrawn_at: '2026-10-05T00:00:00Z' }),
      "Layer 'you, 2026-10-04' — withdrawn 2026-10-05");
    assert.equal(layerLine({ status: 'active' }), null);
  });
  test('evidence two compared columns share is found', () => {
    const groups = [{ items: [{ evidence_refs: [{ type: 'passage', id: 77, start: 0, end: 60 }] }] },
      { items: [{ evidence_refs: [{ type: 'passage', id: 77, start: 0, end: 60, role: 'contradicting' }, { type: 'document', id: 4 }] }] }];
    assert.deepEqual([...sharedEvidence(groups)], ['passage:77:0-60']);
    assert.equal(evidenceKey({ type: 'document', id: 4 }), 'document:4');
    assert.equal(sharedEvidence([groups[0]]).size, 0);
  });
  test('editor: custom dimension values, evidence refs, a selected sub-span anchor', () => {
    assert.equal(customValue('true'), true);
    assert.equal(customValue('0.4'), 0.4);
    assert.equal(customValue(' young listeners '), 'young listeners');
    assert.deepEqual(readEvidenceRefs([{ role: 'contradicting', type: 'passage', id: '77', start: '0', end: '60' }, { id: '' }, { type: 'document', id: '4' }]),
      [{ type: 'passage', id: 77, role: 'contradicting', start: 0, end: 60, relative: true }, { type: 'document', id: 4, role: 'supporting' }]);
    const p = fixtureBody('GET', '/api/passages/:id', 'p901');
    const a = anchorFor(p, { start: 58, end: 72 });
    assert.equal(a.quote, 'carry the zero');
    assert.equal(a.start, p.anchor.start + 58);
    const req = annotationRequest({ target: 'passage:901', passage: p, kind: 'interpretation', body: 'x', span: { start: 58, end: 72 },
      dimensions: { audience: 'young listeners' }, evidence: [{ type: 'passage', id: 77, role: 'supporting' }] });
    assert.deepEqual(check('AnnotationRequest', req), []);
    assert.equal(req.anchor.quote, 'carry the zero');
    assert.equal(req.evidence_refs.length, 1);
  });
});

describe('crossings and adapters (P2)', () => {
  test('a domain lane row prints its denominator; a rate only when coverage passes the gate', () => {
    const lane = { key: 'domain:demo', label: 'Demo', modality: 'text', unit: 'per_million_tokens', n: 340, docs: 92, gate: 2000,
      coverage: { tokens: 94417 }, first: { label: '1906' }, synthetic: true, selection: 'curated selection' };
    const r = laneRow(lane);
    assert.match(r.text, /^n = 340 in 92 docs · 94\.4k tokens · 3,601\/M tokens over the lane's dated text$/);
    assert.equal(r.first, 'first observed in this corpus 1906');
    assert.equal(laneRow(lane, { basis: 'stated', passage: 77 }).first, 'first observed in this corpus 1906 (stated)');
    assert.equal(laneRow({ ...lane, undated: 40 }).text.match(/([\d,]+)\/M/)[1], '3,177', 'the rate counts dated matches only');
    assert.match(laneRow({ ...lane, coverage: { tokens: 900 } }).text, /rate not shown: coverage below the gate/);
    assert.match(laneRow({ ...lane, n: 0 }).text, /0 is an observation about this index/);
    assert.match(laneRow({ key: 'domain:culture~titles', label: 'Culture · titles', modality: 'titles', unit: 'per_thousand_works', n: 31, coverage: { works: 94385 }, first: { label: '1933' } }).text,
      /titles: 31 of 94,385 works/);
  });
  test('the baseline sparkline keeps gaps as gaps; Crossings rows include the domains', () => {
    assert.equal(sparkPath([1, null, 2], { w: 10, h: 10 }), 'M0.0 5.0 M10.0 1.0');
    const rows = crossingsRows({ timeline: { lanes: [{ key: 'domain:demo', label: 'Demo', n: 1, docs: 1, coverage: { tokens: 10 }, first: { label: '1906' } }] } });
    assert.ok(rows.some((r) => r.key === 'lane:domain:demo'));
  });
  test('adapter progress is a number, never a bare spinner', () => {
    assert.equal(progressText({ status: 'running', progress: 0.41, phase: 'works', message: '48,000 / 118,466' }), 'loading… · 41% · works · 48,000 / 118,466');
    assert.equal(progressText({ status: 'cancelled' }), 'cancelled — nothing half-loaded is kept');
    assert.match(progressText({ status: 'failed', error: { message: 'MANIFEST.json changed' } }), /^failed: MANIFEST\.json changed$/);
  });
});

describe('rendering (P2)', () => {
  let dom;
  beforeEach(() => { dom = installFakeDom(); });
  afterEach(() => dom.restore());

  function setup(mountFn, { panel, state = defaultState('demo'), variants = {}, keys = null, api = null } = {}) {
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    state.panels = { inspector: 'tnn', right: panel ?? null };
    const store = createStore(state);
    const client = api ?? createFakeApi({ variants });
    const announced = [];
    mountFn(host, { store, api: client, keys, announce: (t) => announced.push(t) });
    return { host, store, api: client, announced };
  }

  test('genealogy: elbows from the parent row at the child\'s date, a density strip, a ⚠ date conflict, named link ends', async () => {
    const api = createFakeApi();
    const get = api.get;
    api.get = async (path, q) => (path === '/genealogy' ? {
      seed: { doc: 3659, title: "Rapper's Delight", maker: 'The Sugarhill Gang', year: 1979 },
      generations: [
        { gen: 1, total: 1, returned: 1, by_decade: { 1970: 1 }, rows: [{ doc: 5048, title: 'Good Times', maker: 'Chic', date: { label: '1979', precision: 'year' },
          edges: [{ rel_id: 1, rel_type: 'cover_of', evidence_status: 'documented', source_dataset: 'musicbrainz', locator: 'https://musicbrainz.org/work/x' }] }] },
        { gen: 2, total: 1, returned: 1, by_decade: { 1960: 1 }, rows: [{ doc: 80786, title: 'Good Times', maker: 'The Easybeats', date: { label: '1968', precision: 'year' },
          edges: [{ rel_id: 2, rel_type: 'cover_of', evidence_status: 'documented', provenance_quality: 'source_unrecorded', date_conflict: true, parent: 5048 }] }] },
      ],
      truncated: { rows: 0, cursor: null }, note: 'Documented links from Wikipedia, MusicBrainz, Wikidata and ItwoFS as collected by Cipher. Absence of a link is not evidence of no sampling.', synthetic: false,
    } : get(path, q));
    const s = defaultState('cipher');
    s.lineage = { root: 'document:3659', depth: 2, types: [], status: [] };
    const { host } = setup(mountGenealogy, { panel: 'genealogy', state: s, api });
    await settle();
    assert.equal(host.querySelectorAll('.gen-elbow').length, 2, 'one elbow per link, the +2 one from its +1 parent');
    const conflict = host.querySelector('.gen-row.is-conflict');
    assert.ok(conflict, 'a date conflict is marked');
    assert.match(conflict.querySelector('.gen-edge-label').textContent, /DOC\* ⚠/);
    assert.ok(host.querySelector('.gen-density-svg'));
    const text = visibleText(host);
    assert.match(text, /covers Good Times \(1979\)/, 'the +2 link names its parent');
    assert.match(text, /covers Rapper's Delight \(1979\)/);
    assert.match(text, /\(external\)/);
  });

  test('lineage: the group card adds a hypothesis as a proposed link (note ≥ 10, evidence span required)', async () => {
    const s = defaultState('demo');
    s.lineage = { root: 'passage:77', depth: 2, types: [], status: [] };
    const { host, api } = setup(mountLineage, { panel: 'lineage', state: s });
    await settle();
    host.querySelector('.lin-group').click();
    await settle();
    byText(host, 'Add a hypothesis').click();
    const form = host.querySelector('.hyp-form');
    form.querySelector('.hyp-source').value = 'passage:77';
    form.querySelector('textarea.edge-note').value = 'short';
    byText(form, 'Add as a proposed hypothesis').click();
    await settle();
    assert.match(visibleText(form), /at least 10 characters/);
    form.querySelector('textarea.edge-note').value = 'The counting line echoes the primer word for word.';
    byText(form, 'Add as a proposed hypothesis').click();
    await settle();
    assert.match(visibleText(form), /evidence span/);
    const inputs = form.querySelectorAll('.edge-attach input');
    inputs[0].value = '2210'; inputs[1].value = '0'; inputs[2].value = '40';
    byText(form, 'Add as a proposed hypothesis').click();
    await settle();
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/relationships');
    assert.ok(post, 'posted');
    assert.equal(post.body.group, 4);
    assert.equal(post.body.dst, 'passage:77');
    assert.deepEqual(post.body.evidence, [{ passage: 2210, start: 0, end: 40, relative: true, role: 'supporting' }]);
    assert.deepEqual(check('RelationshipRequest', post.body), []);
  });

  test('lineage list view pages long link lists', async () => {
    const api = createFakeApi();
    const get = api.get;
    const nodes = [{ id: 'passage:1', y: 1900, generation: 0 }];
    const edges = [];
    for (let i = 2; i < 2 + LIST_PAGE + 10; i++) {
      nodes.push({ id: `passage:${i}`, y: 1900 + i, generation: 1 });
      edges.push({ rel_id: i, src: `passage:${i}`, dst: 'passage:1', rel_type: 'exact_quotation', evidence_status: 'computed', review_status: 'unreviewed' });
    }
    api.get = async (path, q) => (path === '/lineage' ? { root: 'passage:1', nodes, edges, groups: [], links: [], truncated: { nodes: 0, reason: null } } : get(path, q));
    const s = defaultState('demo');
    s.lineage = { root: 'passage:1', depth: 2, types: [], status: [] };
    const { host } = setup(mountLineage, { panel: 'lineage', state: s, api });
    await settle();
    byText(host, 'Show as list').click();
    assert.equal(host.querySelectorAll('.lin-table tbody tr').length, LIST_PAGE);
    byText(host, 'Next').click();
    assert.equal(host.querySelectorAll('.lin-table tbody tr').length, 10);
    assert.match(visibleText(host), new RegExp(`links ${LIST_PAGE + 1}–${LIST_PAGE + 10} of ${LIST_PAGE + 10}`));
  });

  test('notebook: evidence chips for and against open their passages; shared evidence is marked when comparing', async () => {
    const api = createFakeApi();
    const get = api.get;
    const ann = (id, author, layer, refs) => ({ id, target: { type: 'passage', ref: '901' }, kind: 'interpretation', author, layer, is_machine: false,
      status: 'active', rev: 1, revisions: 1, body_md: `reading ${id}`, dimensions: {}, tags: [], evidence_refs: refs, created_at: '2026-10-03T10:00:00Z', synthetic: true });
    api.get = async (path, q) => (path === '/annotations' ? { items: [
      ann(1, 'Reader A (synthetic)', 'A', [{ type: 'passage', id: 77, start: 0, end: 60, role: 'supporting', quote: 'carry the zero' }]),
      ann(2, 'Reader B (synthetic)', 'B', [{ type: 'passage', id: 77, start: 0, end: 60, role: 'contradicting' }]),
    ], cursor: null } : get(path, q));
    const s = defaultState('demo');
    s.selection = { type: 'passage', id: 901 };
    const { host, store } = setup(mountNotebook, { panel: 'notebook', state: s, api });
    await settle();
    const chips = host.querySelectorAll('.ev-chip');
    assert.equal(chips.length, 2);
    assert.ok(chips[0].classList.contains('is-for') && chips[1].classList.contains('is-against'));
    assert.match(visibleText(chips[1]), /against/);
    const sel = host.querySelectorAll('.nb-controls select').find((x) => x.getAttribute('aria-label') === 'Group annotations');
    sel.value = 'layer';
    sel.dispatchEvent(makeEvent('change', { bubbles: true, target: sel }));
    assert.equal(host.querySelectorAll('.ev-chip.is-shared').length, 2, 'the same passage span cited in both columns');
    assert.ok(host.querySelector('.nb-asof-slider'), 'the as-of slider');
    host.querySelectorAll('.ev-chip')[0].click();
    assert.deepEqual(store.get().view.selection, { type: 'passage', id: 77 });
  });

  test('notebook editor: a custom dimension and an evidence reference travel in the POST', async () => {
    const s = defaultState('demo');
    s.selection = { type: 'passage', id: 901 };
    const { host, api } = setup(mountNotebook, { panel: 'notebook', state: s });
    await settle();
    byText(host, 'New annotation').click();
    const ed = host.querySelector('.ann-editor');
    ed.querySelector('textarea.ann-body').value = 'Reads as a thank-you to the teachers.';
    byText(ed, '＋ Custom dimension').click();
    const custom = ed.querySelectorAll('.ann-dim.is-custom input');
    custom[0].value = 'audience'; custom[1].value = 'former pupils';
    byText(ed, '＋ Evidence').click();
    const row = ed.querySelector('.ann-ev-row');
    row.querySelectorAll('select')[0].value = 'contradicting';
    row.querySelectorAll('input')[0].value = '77';
    byText(ed, 'Save annotation').click();
    await settle();
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/annotations');
    assert.equal(post.body.dimensions.audience, 'former pupils');
    assert.deepEqual(post.body.evidence_refs, [{ type: 'passage', id: 77, role: 'contradicting' }]);
    assert.deepEqual(check('AnnotationRequest', post.body), []);
  });

  test('constellation: K opens it; periods are edited with A before B; a server without the endpoint draws nothing', async () => {
    const keys = createKeys();
    const s = defaultState('demo');
    s.strands = [{ type: 'expression', id: 12 }];
    const { host, store } = setup(mountConstellation, { state: s, keys });
    keys.handle(makeEvent('keydown', { key: 'k', target: dom.document.body }));
    await settle();
    assert.equal(store.get().view.panels.right, 'constellation');
    const inputs = host.querySelectorAll('.con-periods input');
    inputs[0].value = '1990'; inputs[1].value = '2005'; inputs[2].value = '2000'; inputs[3].value = '2026';
    byText(host, 'Apply').click();
    assert.match(visibleText(host), /A is always the earlier period/);
    inputs[2].value = '2010';
    byText(host, 'Apply').click();
    assert.deepEqual(store.get().view.constellation.b, [2010, 2026]);
    host.remove();
    const api = createFakeApi();
    const get = api.get;
    api.get = async (path, q) => {
      if (path === '/constellation') { const { ApiError } = await import('../src/ui/core/api.mjs'); throw new ApiError({ status: 404, code: 'E_NOT_FOUND', message: 'No such endpoint.' }); }
      return get(path, q);
    };
    const n = setup(mountConstellation, { panel: 'constellation', state: { ...s, panels: {} }, api });
    await settle();
    assert.match(visibleText(n.host), /does not provide the constellation endpoint yet/);
    assert.equal(n.host.querySelectorAll('.con-node').length, 0);
  });

  test('a link line is a button with words for every part', () => {
    const el = renderLinkLine({ rel_id: 7, rel_type: 'reframes', evidence_status: 'documented', review_status: 'confirmed' },
      { other: { title: 'Ledgers of the Uncounted', y: 2016 }, direction: 'later', onOpen: () => {} });
    assert.equal(el.tagName, 'BUTTON');
    assert.match(visibleText(el), /Ledgers of the Uncounted \(2016\) reframes this/);
    assert.match(visibleText(el), /DOC documented/);
    assert.match(visibleText(el), /✓ confirmed/);
  });
});
