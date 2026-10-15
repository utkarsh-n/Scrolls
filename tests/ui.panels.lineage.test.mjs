// OWNER: WP7 — Lineage explorer, Genealogy and the edge card (SPEC §2.C, §2.C2, D7, §8.7, §13 rules 5–6).
// Pure helpers directly; rendering through the fake DOM against every fixture variant of /api/lineage,
// /api/lineage/path, /api/genealogy, /api/relationships/:id, /api/hypothesis-groups/:id and the review endpoints.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/ui/core/store.mjs';
import { createKeys } from '../src/ui/core/keys.mjs';
import { defaultState } from '../src/shared/viewstate.mjs';
import { check } from '../src/shared/contracts.mjs';
import { alignTokens, CAUTION, edgeCardModel, noteProblem, originText } from '../src/ui/panels/edge-card.mjs';
import {
  chainText, edgeWords, layoutLineage, lineageQuery, mergeLineage, mount as mountLineage, niceTicks, rootForSelection,
  shiftGenerations, statusFilter, visibleEdges, placeLabels, rootScrollLeft, rootWords } from '../src/ui/panels/lineage.mjs';
import { refWords } from '../src/shared/format.mjs';
import { genealogyQuery, HONESTY_NOTE, moreText, mount as mountGenealogy, orderedRows, rowLabel } from '../src/ui/panels/genealogy.mjs';
import { byText, createFakeApi, fixtureBody, fixtureVariantsOf, installFakeDom, makeEvent, settle, visibleText } from './ui.panels.fakedom.mjs';

const LIN = () => fixtureBody('GET', '/api/lineage', 'ok');
const REL = (name) => fixtureBody('GET', '/api/relationships/:id', name);

describe('edge card model (§2.C)', () => {
  test('documented: DOC with its locator and source dataset; computed: CALC with run, method and a score that is not a probability', () => {
    const doc = edgeCardModel(REL('r7781'));
    assert.equal(doc.badge, 'DOC');
    assert.equal(doc.heading, "Zero Holds the Place (1994) cites Brennock's Ready Arithmetic (1911)");
    assert.equal(doc.origin, 'stated by a source dataset: demo-records');
    assert.deepEqual(doc.locator, { text: 'demo-records:liner-notes/zero-holds-the-place', external: false });
    const calc = edgeCardModel(REL('r7790'));
    assert.equal(calc.badge, 'CALC');
    assert.equal(calc.run, 'run 9');
    assert.equal(calc.score, '1 — share of tokens matched — not a probability');
    assert.ok(calc.alignment.every((o) => o.op === 'same'), 'identical spans align fully');
  });
  test('a cue is PROP · CUE with the quoted cue; review overlays never change the status', () => {
    const cue = edgeCardModel(REL('r7795'));
    assert.equal(cue.badge, 'PROP · CUE');
    assert.equal(cue.cue, 'as Wrexley put it');
    assert.equal(cue.status, 'proposed');
    assert.equal(cue.reviewGlyph, '⚖');
    assert.equal(cue.style.dash.join(), '1,3', 'dotted, whatever the review says');
    const human = edgeCardModel(REL('r7811'));
    assert.equal(human.origin, 'proposed by a person: Reader A (synthetic)');
    assert.equal(human.group, 4);
    assert.match(human.revisions[1], /^rev 2 · dispute · Reader B \(synthetic\) · 2026-10-03 — The primer/);
    assert.equal(human.caution, CAUTION);
  });
  test('source not recorded → DOC*; external locators are labelled external', () => {
    const m = edgeCardModel({ ...REL('r7781'), provenance_quality: 'source_unrecorded', source_locator: 'https://musicbrainz.org/recording/x' });
    assert.equal(m.badge, 'DOC*');
    assert.equal(m.locator.external, true);
    assert.equal(originText({ origin: 'machine_tagger', method: 'tagger@2' }), 'proposed by a machine tagger (tagger@2)');
  });
  test('token alignment: same, substitution, insertion, deletion', () => {
    const ops = alignTokens('carry the zero, children', 'carry a zero children now').map((o) => o.op);
    assert.deepEqual(ops, ['same', 'sub', 'same', 'same', 'ins']);
    assert.deepEqual(alignTokens('a b c', 'a c').map((o) => o.op), ['same', 'del', 'same']);
  });
  test('a note needs at least 10 characters', () => {
    assert.match(noteProblem('too short'), /at least 10 characters \(9 so far\)/);
    assert.equal(noteProblem('checked the 1995 interview'), null);
  });
});

describe('lineage helpers', () => {
  test('the query follows the view: root, depth, statuses from E or the panel, rejected, types', () => {
    const v = defaultState('demo');
    v.lineage = { root: 'passage:77', depth: 2, types: [], status: [] };
    assert.deepEqual(lineageQuery(v), { root: 'passage:77', depth: 2, dir: 'both', max_nodes: 60, types: null, status: null, rejected: 0 });
    v.evidence = { ...v.evidence, proposed: 0, computed: 0, rejected: 1 };
    assert.deepEqual(statusFilter(v), ['documented']);
    assert.equal(lineageQuery(v).status, 'documented');
    assert.equal(lineageQuery(v).rejected, 1);
    v.lineage.status = ['documented', 'computed'];
    v.lineage.types = ['exact_quotation'];
    assert.equal(lineageQuery(v).status, 'documented,computed');
    assert.equal(lineageQuery(v).types, 'exact_quotation');
  });
  test('roots for G: passages and documents; an occurrence only through its known passage', () => {
    assert.equal(rootForSelection({ type: 'passage', id: 77 }), 'passage:77');
    assert.equal(rootForSelection({ type: 'document', id: 30 }), 'document:30');
    assert.equal(rootForSelection({ type: 'occurrence', id: 5 }, {}), null);
    assert.equal(rootForSelection({ type: 'occurrence', id: 5 }, { selectionContext: { occ: 5, passage: 9 } }), 'passage:9');
  });
  test('layout: x follows time linearly (or ordinal, labelled), rows are hops, undated nodes in the gutter', () => {
    const lay = layoutLineage(LIN(), { width: 760 });
    const at = (id) => lay.nodes.find((n) => n.id === id);
    assert.ok(at('passage:77').x < at('passage:1630').x && at('passage:1630').x < at('passage:901').x);
    const lin = (at('passage:1630').x - at('passage:77').x) / (1963 - 1911);
    const lin2 = (at('passage:901').x - at('passage:1630').x) / (1994 - 1963);
    assert.ok(Math.abs(lin - lin2) < 1e-9, 'linear in years');
    assert.equal(at('passage:77').row, 0);
    assert.equal(at('passage:2210').row, 2);
    assert.deepEqual(lay.rows.map((r) => r.label), ['root', '+1 hop', '+2 hops']);
    const ord = layoutLineage(LIN(), { width: 760, ordinal: true });
    const o = (id) => ord.nodes.find((n) => n.id === id).x;
    assert.ok(Math.abs((o('passage:1630') - o('passage:77')) - (o('passage:901') - o('passage:1630'))) < 1e-9, 'equal width per dated year');
    const withUndated = layoutLineage({ nodes: [...LIN().nodes, { id: 'passage:5', title: 'x', generation: 1, undated: true, y: null }, { id: 'shared:1', type: 'commonplace', label: 'widely shared text (31 documents)' }] });
    assert.ok(withUndated.nodes.filter((n) => n.gutter).length === 2);
    assert.deepEqual(niceTicks(1911, 2017), [1911, 1940, 1960, 1980, 2000, 2017]);
  });
  test('client filters: statuses, types, rejected hidden by default', () => {
    const edges = [...LIN().edges, { rel_id: 1, rel_type: 'proposed_allusion', evidence_status: 'proposed', review_status: 'rejected' }];
    assert.equal(visibleEdges(edges, { status: ['documented'] }).length, 2);
    assert.equal(visibleEdges(edges, { status: ['documented', 'computed', 'proposed'] }).length, 4);
    assert.equal(visibleEdges(edges, { status: ['documented', 'computed', 'proposed'], showRejected: true }).length, 5);
    assert.equal(visibleEdges(edges, { status: ['documented', 'computed', 'proposed'], types: ['reframes'] }).length, 1);
  });
  test('expansions merge by id with generations relative to the original root', () => {
    const more = shiftGenerations({ nodes: [{ id: 'passage:950', generation: 1, y: 2001 }, { id: 'passage:901', generation: 0 }], edges: [{ rel_id: 9 }], groups: [] }, 1);
    const m = mergeLineage(LIN(), more);
    assert.equal(m.nodes.length, LIN().nodes.length + 1);
    assert.equal(m.nodes.find((n) => n.id === 'passage:950').generation, 2);
    assert.equal(m.edges.length, LIN().edges.length + 1);
  });
  test('chain header = weakest link; no chain → the note', () => {
    assert.equal(chainText(fixtureBody('GET', '/api/lineage/path', 'ok')), 'Chain strength: weakest link PROPOSED.');
    assert.equal(chainText({ path: [{}], weakest: 'computed' }), 'Chain strength: weakest link COMPUTED.');
    assert.match(chainText(fixtureBody('GET', '/api/lineage/path', 'empty')), /No chain of recorded links/);
  });
  test('edge words: glyph, badge and review overlay from evidence-style', () => {
    const [quote, cite, reframes, allusion] = LIN().edges.map(edgeWords);
    assert.deepEqual([quote.glyph, quote.badge], ['“ ”', 'CALC']);
    assert.deepEqual([cite.glyph, cite.badge], ['§', 'DOC']);
    assert.equal(reframes.style.hue, 'violet');
    assert.equal(allusion.overlay, ' ⚖');
  });
});

describe('genealogy helpers', () => {
  test('defaults: the five sampling types, documented only, depth 3, ≤ 150 rows', () => {
    const q = genealogyQuery(defaultState('demo'), { work: 'document:30' });
    assert.deepEqual(q, { work: 'document:30', dir: 'both', depth: 3, types: 'samples,interpolates,cover_of,remix_of,version_of', max: 150, status: 'documented', cursor: null });
  });
  test('rows by generation and date; labels; "+n more" per generation', () => {
    const rows = orderedRows(fixtureBody('GET', '/api/genealogy', 'ok'));
    assert.equal(rows.length, 1);
    assert.equal(rowLabel(rows[0].row), 'Zero Holds the Place — MC Ledgerline (synthetic) (17 May 1994 · day)');
    assert.deepEqual(rows[0].years, { lo: 1994, hi: 1994 });
    assert.equal(moreText({ gen: 1, total: 312, returned: 150, by_decade: { 1980: 41, 1990: 88 } }), '+162 more later works — 1990s: 88');
    assert.equal(moreText({ gen: 1, total: 1, returned: 1 }), null);
  });
});

describe('Lineage and Genealogy rendering', () => {
  let dom;
  beforeEach(() => { dom = installFakeDom(); });
  afterEach(() => dom.restore());

  function setup(mountFn, { variants = {}, root = 'passage:77', panel = 'lineage', keys = null, selection = null } = {}) {
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const s = defaultState('demo');
    s.lineage = { root, depth: 2, types: [], status: [] };
    s.panels = { inspector: 'tnn', right: panel };
    s.selection = selection;
    const store = createStore(s);
    const api = createFakeApi({ variants });
    const announced = [];
    const handle = mountFn(host, { store, api, keys, announce: (t) => announced.push(t) });
    return { host, store, api, handle, announced };
  }

  test('lineage: nodes on the time scale, edges with evidence words, the root outlined, groups, no hover', async () => {
    const { host, api } = setup(mountLineage);
    await settle();
    const call = api.calls.find((c) => c.path === '/api/lineage');
    assert.deepEqual([call.query.root, call.query.depth, call.query.dir, call.query.max_nodes], ['passage:77', '2', 'both', '60']);
    assert.equal(host.querySelectorAll('.lin-node').length, 5);
    assert.ok(host.querySelector('.lin-node.is-root[data-node="passage:77"]'));
    const edges = host.querySelectorAll('.lin-edge');
    assert.equal(edges.length, 4);
    const statuses = edges.map((e) => e.getAttribute('data-status')).sort();
    assert.deepEqual(statuses, ['computed', 'documented', 'documented', 'proposed']);
    const labels = edges.map((e) => e.querySelector('.lin-edge-label').textContent);
    assert.ok(labels.includes('“ ” CALC') && labels.includes('§ DOC') && labels.includes('? PROP ⚖'));
    const dash = (st) => edges.find((e) => e.getAttribute('data-status') === st).querySelector('path.lin-line').getAttribute('stroke-dasharray');
    assert.equal(dash('documented'), null);
    assert.equal(dash('computed'), '6 4');
    assert.equal(dash('proposed'), '1 3');
    const text = visibleText(host);
    assert.match(text, /⚖ 2 competing — Where does Vyas's 2017 line come from\?/);
    assert.match(text, /rows = hops from the root, never meaning/);
    assert.deepEqual(dom.hoverListenerTypes(), []);
  });

  test('lineage truncated: "showing n of m nodes" and the reason; list view is a table', async () => {
    const { host } = setup(mountLineage, { variants: { 'GET /api/lineage': 'truncated' } });
    await settle();
    assert.match(visibleText(host), /showing 6 of 268 nodes — hard cap 150 nodes — Show as list/);
    assert.match(visibleText(host), /widely shared text \(31 documents\)/);
    byText(host, 'Show as list').click();
    const rows = host.querySelectorAll('.lin-table tbody tr');
    assert.equal(rows.length, 4);
  });

  test('lineage errors: not found and QUERY_TIMEOUT with Retry', async () => {
    for (const variant of ['not_found', 'error']) {
      const { host } = setup(mountLineage, { variants: { 'GET /api/lineage': variant } });
      await settle();
      const body = fixtureBody('GET', '/api/lineage', variant);
      assert.ok(visibleText(host).includes(body.error.message), variant);
      assert.ok(byText(host, 'Retry'));
      host.remove();
    }
  });

  test('filters: Documented only and type chips update the view and the query', async () => {
    const { host, store, api } = setup(mountLineage);
    await settle();
    byText(host, 'Documented only').click();
    await settle();
    assert.deepEqual(store.get().view.lineage.status, ['documented']);
    assert.equal(api.calls.filter((c) => c.path === '/api/lineage').at(-1).query.status, 'documented');
    assert.equal(host.querySelectorAll('.lin-edge').length, 2, 'only documented links stay drawn');
    host.querySelector('.lin-type[data-type="reframes"]').click();
    await settle();
    assert.deepEqual(store.get().view.lineage.types, ['exact_quotation', 'explicit_citation', 'proposed_allusion']);
  });

  test('a link opens its card; Confirm needs a note ≥ 10 characters; the review is posted and the status stays', async () => {
    const { host, api, announced } = setup(mountLineage);
    await settle();
    host.querySelector('.lin-edge[data-rel="7811"]').click();
    await settle();
    const card = host.querySelector('.edge-card');
    assert.ok(card);
    assert.match(visibleText(card), /may allude to/);
    assert.match(visibleText(card), /Shared wording or similar contexts can come from a common source/);
    byText(host, 'Confirm').click();
    const note = host.querySelector('textarea.edge-note');
    note.value = 'short';
    byText(host, 'Submit').click();
    await settle();
    assert.match(visibleText(host), /A note needs at least 10 characters/);
    assert.ok(!api.calls.some((c) => c.path.endsWith('/review')), 'nothing posted for a short note');
    assert.equal(host.querySelector('textarea.edge-note'), note, 'the typed note survives the error');
    note.value = 'The 1995 interview names the primer directly.';
    byText(host, 'Submit').click();
    await settle(12);
    const review = api.calls.find((c) => c.path === '/api/relationships/7811/review');
    assert.deepEqual(review.body, { action: 'confirm', note: 'The 1995 interview names the primer directly.' });
    assert.deepEqual(check('ReviewRequest', review.body), []);
    assert.ok(announced.some((a) => /review status confirmed; the evidence status is unchanged/.test(a)));
  });

  test('chain of custody: pick two nodes → the weakest link heads the chain', async () => {
    const { host, api } = setup(mountLineage);
    await settle();
    byText(host, 'Chain of custody: pick two nodes').click();
    host.querySelector('.lin-node[data-node="passage:2210"]').click();
    host.querySelector('.lin-node[data-node="passage:77"]').click();
    await settle();
    const call = api.calls.find((c) => c.path === '/api/lineage/path');
    assert.deepEqual([call.query.from, call.query.to], ['passage:2210', 'passage:77']);
    assert.match(visibleText(host), /Chain strength: weakest link PROPOSED\./);
    assert.equal(host.querySelectorAll('.lin-chain-list li').length, 2);
  });

  test('competing hypotheses open side by side; nothing is deleted', async () => {
    const { host } = setup(mountLineage);
    await settle();
    host.querySelector('.lin-group').click();
    await settle();
    const card = host.querySelector('.lin-group-card');
    assert.equal(card.querySelectorAll('.lin-hypothesis').length, 2);
    assert.match(visibleText(card), /confirming one hypothesis leaves the others as they were/);
  });

  test('a node offers its passage, one-hop expansion and re-rooting', async () => {
    const { host, store, api } = setup(mountLineage);
    await settle();
    host.querySelector('.lin-node[data-node="passage:901"]').click();
    assert.ok(byText(host, '＋ Expand one hop (2)'));
    byText(host, '＋ Expand one hop (2)').click();
    await settle();
    const exp = api.calls.filter((c) => c.path === '/api/lineage').at(-1);
    assert.deepEqual([exp.query.root, exp.query.depth, exp.query.max_nodes], ['passage:901', '1', '30']);
    host.querySelector('.lin-node[data-node="passage:901"]').click();
    byText(host, 'Lineage from here').click();
    assert.equal(store.get().view.lineage.root, 'passage:901');
    host.querySelector('.lin-node[data-node="passage:1630"]').click();
    byText(host, 'Open passage').click();
    assert.deepEqual(store.get().view.selection, { type: 'passage', id: 1630 });
  });

  test('G opens the lineage of a selected passage and the genealogy of a selected work', () => {
    const keys = createKeys();
    const { store } = setup(mountLineage, { keys, panel: null, root: null, selection: { type: 'passage', id: 77 } });
    keys.handle(makeEvent('keydown', { key: 'g', target: dom.document.body }));
    assert.equal(store.get().view.lineage.root, 'passage:77');
    assert.equal(store.get().view.panels.right, 'lineage');
    store.dispatch({ type: 'SELECT', selection: { type: 'document', id: 30 } });
    keys.handle(makeEvent('keydown', { key: 'g', target: dom.document.body }));
    assert.equal(store.get().view.panels.right, 'genealogy');
  });

  test('genealogy: rows, diamonds, the honesty note, links with locators; empty and error', async () => {
    const { host, api } = setup(mountGenealogy, { root: 'document:30', panel: 'genealogy' });
    await settle();
    const call = api.calls.find((c) => c.path === '/api/genealogy');
    assert.equal(call.query.work, 'document:30');
    const text = visibleText(host);
    assert.ok(text.includes(HONESTY_NOTE));
    assert.match(text, /Zero Holds the Place — MC Ledgerline \(synthetic\) \(17 May 1994 · day\)/);
    assert.match(text, /demo-records:liner-notes\/zero-holds-the-place/);
    assert.equal(host.querySelectorAll('.gen-row:not(.is-seed)').length, 1);
    host.querySelector('.gen-row[data-doc="44"]').click();
    await settle();
    assert.ok(host.querySelector('.edge-card'), 'a work row opens its link card');
    host.remove();
    const e = setup(mountGenealogy, { root: 'document:27', panel: 'genealogy' });
    await settle();
    assert.match(visibleText(e.host), /No documented sample, cover, remix or version links\. Absence of a link is not evidence of no sampling\./);
    e.host.remove();
    const x = setup(mountGenealogy, { root: 'document:30', panel: 'genealogy', variants: { 'GET /api/genealogy': 'error' } });
    await settle();
    assert.match(visibleText(x.host), /genealogy query took longer than 5 s/);
  });

  test('the fixtures rendered here are valid shapes', () => {
    for (const [path, shape] of [['/api/lineage', 'Lineage'], ['/api/lineage/path', 'LineagePath'], ['/api/genealogy', 'Genealogy'], ['/api/relationships/:id', 'Relationship']]) {
      for (const { name, status, body } of fixtureVariantsOf('GET', path)) assert.deepEqual(check(status >= 400 ? 'ErrorBody' : shape, body), [], `${path} ${name}`);
    }
  });
});

test('lineage labels never overlap: root first, node titles, fans, then edge labels (left out where no room) (fix pass, §2.C)', () => {
  // the reviewer's crowd around the root: its document just under it, a neighbour 60 px away, a fan and three edge labels
  const labels = [
    { key: 'n:root', lines: ['Zero Holds the Place', '17 May 1994 · liner notes · SYN'], x: 500, y: 100, size: 11.5, candidates: [[0, 20], [0, -30], [12, 4, 'start']] },
    { key: 'n:doc', lines: ['its document: Zero Holds the Place'], x: 500, y: 134, size: 11.5, candidates: [[10, 4, 'start'], [0, 22], [-10, 4, 'end']] },
    { key: 'n:b', lines: ['Ledgers of the Uncounted', '2016 · essay · SYN'], x: 560, y: 100, size: 11.5, candidates: [[0, 20], [0, -30], [12, 4, 'start'], [-12, 4, 'end'], [0, 34]] },
    { key: 'f:1', lines: ['⚖ 2 competing'], x: 560, y: 100, size: 11, candidates: [[0, -16], [0, -30], [14, -16, 'start']] },
    ...['§ DOC', '? PROP', '≈ CALC'].map((t, i) => ({ key: `e:${i}`, lines: [t], x: 530, y: 96 + i * 4, size: 11, optional: true, candidates: [[0, 0], [0, -12], [0, 12]] })),
  ];
  const dots = [[500, 100], [500, 134], [560, 100]].map(([x, y]) => ({ x0: x - 8, y0: y - 8, x1: x + 8, y1: y + 8 }));
  const placed = placeLabels(labels, { obstacles: dots });
  const boxes = [...placed.values()].filter(Boolean).map((p) => p.box);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(!(a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0), `labels ${i} and ${j} overlap`);
  }
  for (const k of ['n:root', 'n:doc', 'n:b', 'f:1']) assert.ok(placed.get(k), `${k} is drawn`);
  assert.ok([...placed.entries()].some(([k, v]) => k.startsWith('e:') && v === null), 'an edge label with no room is left out, not overprinted');
});

test('two neighbours at the right edge: each label finds a free place inside the drawing (fix pass, 2016 and 2017)', () => {
  // the demo's 2016 essay and 2017 verse sit 20 px apart at the graph's right edge, staggered by 24 px
  const bounds = { x0: 0, y0: 0, x1: 968, y1: 310 };
  const cand = (n) => [[0, 20], [0, -16 - (n - 1) * 13.8], [12, 4, 'start'], [-12, 4, 'end'], [0, 34], [0, -30 - (n - 1) * 13.8]];
  const labels = [
    { key: 'n:2016', lines: ['Ledgers of the Uncounted', '2016 · essay · SYN'], x: 912, y: 160, size: 11.5, candidates: cand(2) },
    { key: 'n:2017', lines: ['શૂન્ય', '2017 · verse · SYN'], x: 932, y: 136, size: 11.5, candidates: cand(2) },
    { key: 'f:1', lines: ['⚖ 2 competing'], x: 932, y: 136, size: 11, candidates: [[0, -16], [0, -30], [14, -16, 'start'], [-14, -16, 'end']] },
  ];
  const obstacles = [[912, 160], [932, 136]].map(([x, y]) => ({ x0: x - 8, y0: y - 8, x1: x + 8, y1: y + 8 }));
  obstacles.push({ x0: 935, y0: 120, x1: 945, y1: 134 });   // the '?' of a proposed link leaving the 2017 node
  const placed = placeLabels(labels, { obstacles, bounds });
  const boxes = [...placed.values()].map((p) => p.box);
  for (const b of boxes) assert.ok(b.x0 >= bounds.x0 && b.x1 <= bounds.x1 && b.y0 >= bounds.y0 && b.y1 <= bounds.y1, 'inside the drawing');
  for (let i = 0; i < boxes.length; i++) {
    for (const o of [...boxes.slice(i + 1), ...obstacles]) {
      const a = boxes[i];
      assert.ok(!(a.x0 < o.x1 && a.x1 > o.x0 && a.y0 < o.y1 && a.y1 > o.y0), `label ${i} overlaps`);
    }
  }
});

test('the lineage graph opens centred on its root (fix pass)', () => {
  assert.equal(rootScrollLeft(1531, 665, 2000), 1199);
  assert.equal(rootScrollLeft(200, 665, 2000), 0, 'never before the start');
  assert.equal(rootScrollLeft(1990, 665, 2000), 1335, 'never past the end');
});

test('panel headings name references in words, never as internal ids (fix pass: \'root passage:53\')', () => {
  assert.equal(refWords('passage:53'), 'passage 53');
  assert.equal(refWords('relationship:7'), 'link 7');
  assert.equal(refWords('cluster:3'), 'context group 3');
  assert.equal(refWords(null), '');
  assert.equal(rootWords('passage:53'), 'passage 53');
  assert.equal(rootWords('passage:53', { root: 'passage:53', nodes: [{ id: 'passage:53', title: 'Zero Holds the Place' }] }),
    'Zero Holds the Place · passage 53');
});
