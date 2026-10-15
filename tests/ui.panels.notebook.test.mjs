// OWNER: WP7 — notebook, annotation editor, revisions (SPEC §2.F, D18), plus the other M4/M5 panels: the
// constellation and its layout worker (§2.B), the Crossings card (§2.D) and the Adapters page (§10, D13).
// Pure helpers directly; rendering through the fake DOM against every fixture variant of their endpoints.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/ui/core/store.mjs';
import { createKeys } from '../src/ui/core/keys.mjs';
import { defaultState } from '../src/shared/viewstate.mjs';
import { check } from '../src/shared/contracts.mjs';
import { anchorFor, annotationRequest, HUMAN_KINDS, parseTags, readDimensions } from '../src/ui/panels/annotation-editor.mjs';
import { metaChanges, revisionDiff, revLabel } from '../src/ui/panels/revisions.mjs';
import { annotationsQuery, groupAnnotations, hypothesisLabel, mount as mountNotebook, splitMachine, targetForSelection } from '../src/ui/panels/notebook.mjs';
import {
  constellationQuery, diffList, maxSize, mount as mountConstellation, periodA, placeUnpositioned, presence, radius, referenceValues, RELAYOUT_TOAST,
} from '../src/ui/panels/constellation.mjs';
import { stableLayout } from '../src/ui/panels/layout.worker.mjs';
import { CROSSINGS_CAPTION, crossingsRows } from '../src/ui/panels/crossings.mjs';
import { adapterModel, mount as mountAdapters } from '../src/ui/panels/adapters.mjs';
import { mount as mountInspector, selectPassage } from '../src/ui/panels/inspector.mjs';
import { dayFromYMD } from '../src/shared/dates.mjs';
import { byText, createFakeApi, fixtureBody, fixtureVariantsOf, installFakeDom, makeEvent, settle, visibleText } from './ui.panels.fakedom.mjs';

const ANNS = () => fixtureBody('GET', '/api/annotations', 'ok').items;
const P901 = () => fixtureBody('GET', '/api/passages/:id', 'p901');

describe('annotation helpers (§2.F, D18)', () => {
  test('a passage annotation is anchored by doc, hash, field, offsets and quote; the body passes AnnotationRequest', () => {
    const anchor = anchorFor(P901());
    assert.deepEqual(anchor, { doc_id: 44, sha256: P901().anchor.sha256, field: 'body', start: 48, end: 152, quote: P901().text, prefix: '', suffix: '' });
    const req = annotationRequest({ target: 'passage:901', passage: P901(), kind: 'interpretation', body: ' Reads as a tribute. ', layer: 'Reading B',
      dimensions: { pragmatic_function: 'reclaimed' }, tags: parseTags('irony, tribute,,') });
    assert.deepEqual(check('AnnotationRequest', req), []);
    assert.equal(req.body_md, 'Reads as a tribute.');
    assert.deepEqual(req.tags, ['irony', 'tribute']);
    const doc = annotationRequest({ target: 'document:44', kind: 'question', body: 'Who printed it?' });
    assert.equal(doc.anchor, undefined);
    assert.deepEqual(check('AnnotationRequest', doc), []);
    assert.ok(!HUMAN_KINDS.includes('machine_tag'));
  });
  test('dimensions: empty fields are dropped, scales are numbers, booleans only when ticked', () => {
    const dims = readDimensions({ pragmatic_function: { value: 'ironic' }, tone: { value: '-1' }, reframes_target: { checked: true }, topic: { value: '  ' } });
    assert.deepEqual(dims, { pragmatic_function: 'ironic', tone: -1, reframes_target: true });
  });
  test('revisions: word diff, "rev n of m", dimension and tag changes', () => {
    const [r1, r2] = fixtureBody('GET', '/api/annotations/:id/revisions', 'ok');
    const ops = revisionDiff(r1.body_md, r2.body_md);
    assert.ok(ops.some((o) => o.op === 'same') && ops.some((o) => o.op !== 'same'));
    assert.equal(revLabel(2, 2), 'rev 2 of 2');
    assert.deepEqual(metaChanges(r1, r2), ['pragmatic function: parodic → ironic', 'perspective: — → 2026 reader', 'tags: mockery → irony']);
  });
  test('notebook helpers: targets, query, machine apart, grouping, hypothesis label', () => {
    assert.equal(targetForSelection({ type: 'passage', id: 901 }), 'passage:901');
    assert.equal(targetForSelection({ type: 'occurrence', id: 5 }, { selectionContext: { occ: 5, passage: 901 } }), 'passage:901');
    assert.equal(targetForSelection({ type: 'bin', id: 'x' }), null);
    assert.deepEqual(annotationsQuery('passage:901', { superseded: true, asOf: '2026-11-01' }),
      { target: 'passage:901', include: 'superseded', as_of: '2026-11-01', q: null, limit: 200 });
    const { human, machine } = splitMachine([...ANNS(), { id: 9, kind: 'machine_tag', is_machine: true }]);
    assert.equal(human.length, 3);
    assert.equal(machine.length, 1);
    assert.deepEqual(groupAnnotations(human, 'author').map((g) => g.key), ['Reader A (synthetic)', 'Reader B (synthetic)']);
    assert.equal(hypothesisLabel(ANNS()[2]), 'Hypothesis — by Reader A (synthetic), 2026-10-03 — not evidence');
    assert.equal(hypothesisLabel({ author: 'you', created_at: '2026-10-04T00:00:00Z' }), 'Hypothesis — by you, 2026-10-04 — not evidence');
  });
});

describe('constellation helpers and the layout worker (§2.B)', () => {
  test('area ∝ value (sqrt radius); presence; diff list; reference circles', () => {
    const data = fixtureBody('GET', '/api/constellation', 'ok');
    const max = maxSize(data.nodes);
    assert.equal(max, 122);
    assert.equal(radius(122, max), 28);
    assert.ok(Math.abs(radius(30.5, max) - 14) < 1e-9, 'a quarter of the value → half the radius');
    assert.equal(radius(0, max), 0);
    const by = Object.fromEntries(data.nodes.map((n) => [n.id, presence(n)]));
    assert.equal(by['k:42'], 'b_only');
    assert.equal(by['w:auditors'], 'a_only');
    assert.equal(by['x:12'], 'both');
    const d = diffList(data.nodes);
    assert.deepEqual(d.onlyA.map((n) => n.id), ['w:auditors']);
    assert.deepEqual(d.onlyB.map((n) => n.id).sort(), ['d:44', 'k:42', 'w:uncredited']);
    assert.deepEqual(d.grew.map((n) => n.id), ['x:13'], 'x:12 doubled exactly (61 → 122): not more than 2×');
    assert.deepEqual(referenceValues(data.legend, max), [10, 50, 120]);
    assert.deepEqual(referenceValues({}, 122), [10, 50, 100]);
  });
  test('period A: explicit, else the range, else the decade of the playhead', () => {
    const v = defaultState('demo');
    assert.deepEqual(periodA(v), [1920, 1929]);
    v.range = [dayFromYMD(1994, 1, 1), dayFromYMD(2003, 1, 1)];
    assert.deepEqual(periodA(v), [1994, 2003]);
    v.constellation = { ...v.constellation, a: [1990, 2005], b: [2010, 2026], layoutKey: 'fnv:3b91c2d0' };
    v.strands = [{ type: 'expression', id: 12 }];
    assert.deepEqual(constellationQuery(v), { strands: '12', a: '1990-2005', b: '2010-2026', size: 'occurrences', edges: 'cooc,rel,member,occurs,etym', max_nodes: 150, layout: 'fnv:3b91c2d0' });
    assert.equal(constellationQuery(v, { relayout: true }).relayout, 1);
  });
  test('the layout is deterministic per key, pins positioned nodes and stays in the unit square', () => {
    const nodes = [{ id: 'a', pos: [0.2, 0.2] }, { id: 'b', pos: [0.8, 0.8] }, ...Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }))];
    const edges = nodes.slice(2).map((n, i) => ({ s: n.id, t: i % 2 ? 'a' : 'b' }));
    const p1 = stableLayout({ key: 'k1', nodes, edges, iterations: 120 });
    const p2 = stableLayout({ key: 'k1', nodes, edges, iterations: 120 });
    assert.deepEqual(p1, p2, 'same key → same positions');
    assert.deepEqual(p1.a, [0.2, 0.2]);
    assert.deepEqual(p1.b, [0.8, 0.8]);
    for (const [x, y] of Object.values(p1)) assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1);
    const p3 = stableLayout({ key: 'k2', nodes, edges, iterations: 120 });
    assert.notDeepEqual(p3, p1, 'another key, another layout');
    const placed = placeUnpositioned({ layout: { key: 'k1' }, nodes: [{ id: 'x', pos: [0.5, 0.5] }, { id: 'y' }], edges: [] });
    assert.deepEqual(placed.nodes[0].pos, [0.5, 0.5]);
    assert.equal(placed.nodes[1].placed, 'client');
  });
});

describe('crossings and adapters helpers', () => {
  test('crossings rows come from the queries; empty rows say so; the caption is fixed', () => {
    const rows = crossingsRows({
      expression: fixtureBody('GET', '/api/expressions/:id', 'ready'),
      search: fixtureBody('GET', '/api/search', 'empty'),
      baseline: fixtureBody('GET', '/api/baseline', 'multiword'),
    });
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.equal(by.etymology.text, "No etymology family in Cipher's roots data (Latin, Greek, Sanskrit, PIE only)");
    assert.match(by.culture.text, /0 is an observation about this index, not about culture\./);
    assert.equal(by.baseline.text, 'No external baseline: single words only');
    assert.match(by.text.note, /^variants: carry the zero 331/);
    assert.equal(CROSSINGS_CAPTION, 'First observation in this corpus is not coinage or borrowing.');
  });
  test('adapters: staged checks, counts, the command a person runs, network approval', () => {
    const [openalex, , , gstemm, works] = fixtureBody('GET', '/api/adapters', 'ok').map(adapterModel);
    assert.equal(openalex.counts, '118,466 works · 60,574 abstracts · 381,800 citations');
    assert.equal(openalex.canLoad, true);
    assert.equal(gstemm.canLoad, false);
    assert.equal(gstemm.command, 'node tools/fetch/gutenberg-stemm.mjs');
    assert.match(works.lastLoad, /94,385 documents/);
    const net = adapterModel({ id: 'x', version: '1', access: 'network', staged: null, license: 'CC0', loaded: false });
    assert.equal(net.network, true);
    assert.equal(net.canLoad, false, 'a network adapter loads only once a person enabled it');
  });
});

describe('rendering', () => {
  let dom;
  beforeEach(() => { dom = installFakeDom(); });
  afterEach(() => dom.restore());

  function setup(mountFn, { variants = {}, panel, selection = { type: 'passage', id: 901 }, keys = null, state = null } = {}) {
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const s = state ?? defaultState('demo');
    s.panels = { inspector: 'tnn', right: panel ?? null };
    s.selection = selection;
    const store = createStore(s);
    const api = createFakeApi({ variants });
    const announced = [];
    mountFn(host, { store, api, keys, announce: (t) => announced.push(t) });
    return { host, store, api, announced };
  }

  test('notebook: cards with layers, rev, hypothesis "not evidence"; superseded layers by default; no hover', async () => {
    const { host, api } = setup(mountNotebook, { panel: 'notebook' });
    await settle();
    const first = api.calls.find((c) => c.path === '/api/annotations');
    assert.deepEqual(first.query.target, 'passage:901');
    assert.equal(first.query.include, 'superseded', 'superseded layers show by default (§2.F)');
    const cards = host.querySelectorAll('.ann-card');
    assert.equal(cards.length, 4);
    const layer = host.querySelector('.ann-card[data-annotation="219"]');
    assert.match(visibleText(layer), /Layer 'Reader A, 2026-10-02' — superseded/);
    assert.match(visibleText(layer), /superseded by 220/);
    assert.equal(byText(layer, 'Edit'), null, 'a superseded layer is a historical record: no edit');
    assert.match(visibleText(host.querySelector('.ann-card[data-annotation="220"]')), /layer “Reader A, 2026-10-03” · rev 2 of 2/);
    const hyp = host.querySelector('.ann-card.is-hypothesis');
    assert.match(visibleText(hyp), /Hypothesis — by Reader A \(synthetic\), 2026-10-03 — not evidence/);
    const box = host.querySelectorAll('input[type="checkbox"]')[0];
    box.checked = false;
    box.dispatchEvent(makeEvent('change', { bubbles: true, target: box }));
    await settle();
    assert.equal(api.calls.filter((c) => c.path === '/api/annotations').at(-1).query.include, undefined);
    assert.equal(host.querySelectorAll('.ann-card').length, 3);
    assert.deepEqual(dom.hoverListenerTypes(), []);
  });

  test('notebook: create posts an anchored annotation; edit appends a revision with a reason; withdraw needs a second tap', async () => {
    const { host, api, announced } = setup(mountNotebook, { panel: 'notebook' });
    await settle();
    byText(host, 'New annotation').click();
    host.querySelector('.ann-editor textarea.ann-body').value = 'Reads as a tribute to the uncounted.';
    byText(host, 'Save annotation').click();
    await settle();
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/annotations');
    assert.deepEqual(check('AnnotationRequest', post.body), []);
    assert.equal(post.body.anchor.doc_id, 44);
    assert.ok(announced.includes('Annotation 224 saved'));
    byText(host.querySelector('.ann-card[data-annotation="220"]'), 'Edit').click();
    const editor = host.querySelector('.ann-editor');
    editor.querySelector('textarea.ann-body').value = 'Ironic distance from schooling, not mockery.';
    editor.querySelector('.ann-reason').value = 'found the 1995 interview';
    byText(host, 'Save revision').click();
    await settle();
    const patch = api.calls.find((c) => c.method === 'PATCH');
    assert.equal(patch.path, '/api/annotations/220');
    assert.deepEqual(check('AnnotationPatch', patch.body), []);
    assert.equal(patch.body.reason, 'found the 1995 interview');
    byText(host.querySelector('.ann-card[data-annotation="223"]'), 'Withdraw').click();
    assert.ok(!api.calls.some((c) => c.path.endsWith('/withdraw')), 'the first tap only arms it');
    byText(host, 'Confirm withdraw (kept in the record)').click();
    await settle();
    assert.ok(api.calls.some((c) => c.path === '/api/annotations/223/withdraw'));
  });

  test('notebook: reinterpret supersedes; revisions scrubber; errors and empty', async () => {
    const { host, api } = setup(mountNotebook, { panel: 'notebook' });
    await settle();
    byText(host.querySelector('.ann-card[data-annotation="220"]'), 'Reinterpret').click();
    host.querySelector('.ann-editor textarea.ann-body').value = 'After the 2024 interview: both readings are part of the song.';
    byText(host, 'Save reinterpretation').click();
    await settle();
    const re = api.calls.find((c) => c.path === '/api/annotations/220/reinterpret');
    assert.deepEqual(check('AnnotationRequest', re.body), []);
    byText(host.querySelector('.ann-card[data-annotation="220"]'), 'Revisions').click();
    await settle();
    const scrub = host.querySelector('.rev-scrubber');
    assert.ok(scrub);
    assert.match(visibleText(host.querySelector('.revisions')), /rev 2 of 2 · Reader A \(synthetic\) · 2026-10-03 · reason: found the 1995 interview/);
    scrub.value = '0';
    scrub.dispatchEvent(makeEvent('input', { bubbles: true, target: scrub }));
    assert.match(visibleText(host.querySelector('.revisions')), /rev 1 of 2/);
    host.remove();
    const e = setup(mountNotebook, { panel: 'notebook', variants: { 'GET /api/annotations': 'error' } });
    await settle();
    assert.match(visibleText(e.host), /did not come from the Scrolls page/);
    e.host.remove();
    const m = setup(mountNotebook, { panel: 'notebook', variants: { 'GET /api/annotations': 'empty' } });
    await settle();
    assert.match(visibleText(m.host), /No annotations on this target yet\./);
  });

  test('N opens the notebook with a composer; the inspector\'s Next column asks for a hypothesis', async () => {
    const keys = createKeys();
    const { host, store } = setup(mountNotebook, { keys });
    keys.handle(makeEvent('keydown', { key: 'n', target: dom.document.body }));
    await settle();
    assert.equal(store.get().view.panels.right, 'notebook');
    assert.ok(host.querySelector('.ann-editor'));
    const insp = dom.document.createElement('div');
    dom.document.body.appendChild(insp);
    mountInspector(insp, { store, api: createFakeApi(), keys: null, announce: () => {} });
    selectPassage(store, { passage: 901 });
    await settle();
    byText(insp, 'Add a hypothesis about later reinterpretation').click();
    await settle();
    assert.equal(host.querySelector('.ann-editor .ann-kind').value, 'hypothesis');
  });

  test('inspector crossings: opened on request, rows from the queries, fixed caption', async () => {
    const insp = dom.document.createElement('div');
    dom.document.body.appendChild(insp);
    const store = createStore(defaultState('demo'));
    const api = createFakeApi();
    mountInspector(insp, { store, api, keys: null, announce: () => {} });
    selectPassage(store, { passage: 901 });
    await settle();
    assert.ok(!api.calls.some((c) => c.path === '/api/search'), 'nothing is queried until opened');
    byText(insp, 'Crossings: where this expression appears across the record').click();
    await settle();
    const text = visibleText(insp.querySelector('.crossings'));
    assert.match(text, /Crossings: 'carry the zero'/);
    assert.match(text, /331 passages in 96 documents \(1 undated\)/);
    assert.ok(text.includes(CROSSINGS_CAPTION));
  });

  test('constellation: stable positions, overlay encoding, legend with reference circles, re-layout toast, errors', async () => {
    const s = defaultState('demo');
    s.strands = [{ type: 'expression', id: 12 }];
    s.constellation = { ...s.constellation, a: [1990, 2005], b: [2010, 2026] };
    const { host, store, api } = setup(mountConstellation, { panel: 'constellation', state: s });
    await settle();
    assert.equal(host.querySelectorAll('.con-node').length, 7);
    const x12 = host.querySelector('.con-node[data-node="x:12"]');
    assert.ok(x12.classList.contains('pres-both'));
    assert.ok(host.querySelector('.con-node[data-node="k:42"]').classList.contains('pres-b_only'));
    assert.match(visibleText(host), /reference circles 10, 50, 120/);
    assert.match(visibleText(host), /only in A \(1\): auditors/);
    assert.equal(store.get().view.constellation.layoutKey, 'fnv:3b91c2d0', 'the layout key is pinned in the view');
    assert.equal(api.calls.filter((c) => c.path === '/api/constellation').length, 1, 'pinning the key does not refetch');
    const before = host.querySelector('.con-node[data-node="x:12"] .con-shape, .con-node[data-node="x:12"] .ring-outer');
    byText(host, 'split').click();
    assert.equal(host.querySelectorAll('.con-split svg').length, 2);
    byText(host, 'Re-layout').click();
    await settle();
    assert.equal(api.calls.filter((c) => c.path === '/api/constellation').at(-1).query.relayout, '1');
    assert.equal(store.get().ui.toasts.at(-1).text, RELAYOUT_TOAST);
    assert.ok(before);
    host.remove();
    const e = setup(mountConstellation, { panel: 'constellation', state: s, variants: { 'GET /api/constellation': 'error' } });
    await settle();
    assert.match(visibleText(e.host), /constellation query took longer than 15 s/);
  });

  test('adapters page: cards, Load starts a job in the tray, unavailable shows the command, errors', async () => {
    const { host, store, api } = setup(mountAdapters, { panel: 'adapters' });
    await settle();
    assert.equal(host.querySelectorAll('.adapter-card').length, 5);
    const gs = host.querySelector('.adapter-card[data-adapter="stemm.gutenberg-stemm"]');
    assert.match(visibleText(gs), /Run it yourself when you want it:\s+node tools\/fetch\/gutenberg-stemm\.mjs/);
    assert.equal(byText(gs, 'Load'), null);
    const oa = () => host.querySelector('.adapter-card[data-adapter="stemm.openalex"]');
    byText(oa(), 'Load').click();
    await settle(1);
    assert.ok(api.calls.some((c) => c.method === 'POST' && c.path === '/api/adapters/stemm.openalex/load'));
    assert.equal(store.get().ui.jobs[410].type, 'adapter-load');
    assert.match(visibleText(oa()), /job 410 · /, 'progress is shown on the card');
    assert.equal(byText(oa(), 'Load'), null, 'no second load while one runs');
    byText(oa(), 'Cancel').click();
    await settle(1);
    assert.ok(api.calls.some((c) => c.method === 'POST' && c.path === '/api/jobs/410/cancel'), 'Cancel posts the job cancel');
    await settle(12);
    assert.ok(api.streams.some((x) => x.path === '/api/jobs/410/events'), 'the job is followed over its own stream');
    assert.match(visibleText(host), /STEMM sources \(staged files\)/);
    assert.match(visibleText(host), /Licence/);
    host.remove();
    const u = setup(mountAdapters, { panel: 'adapters', variants: { 'POST /api/adapters/:id/load': 'unavailable' } });
    await settle();
    byText(u.host.querySelector('.adapter-card[data-adapter="stemm.openalex"]'), 'Load').click();
    await settle();
    assert.match(visibleText(u.host), /Run node tools\/fetch\/gutenberg-stemm\.mjs yourself, then retry\./);
    u.host.remove();
    const e = setup(mountAdapters, { panel: 'adapters', variants: { 'GET /api/adapters': 'empty' } });
    await settle();
    assert.match(visibleText(e.host), /No adapter modules are registered\./);
  });

  test('the fixtures rendered here are valid shapes', () => {
    for (const [path, shape] of [['/api/annotations', 'Annotations'], ['/api/annotations/:id/revisions', 'AnnotationRevisions'], ['/api/constellation', 'Constellation'], ['/api/adapters', 'Adapters']]) {
      for (const { name, status, body } of fixtureVariantsOf('GET', path)) assert.deepEqual(check(status >= 400 ? 'ErrorBody' : shape, body), [], `${path} ${name}`);
    }
  });
});
