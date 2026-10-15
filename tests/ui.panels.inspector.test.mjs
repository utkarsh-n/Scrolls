// OWNER: WP7 — the Then / Now / Next inspector, passage card, date chip and reader (SPEC §2.D, §1.11, §8.6, D4).
// Pure logic is tested directly; the DOM is rendered into the in-memory DOM of ui.panels.fakedom.mjs against
// the contract fixtures (every variant, including errors), at desktop and narrow widths.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/ui/core/store.mjs';
import { defaultState } from '../src/shared/viewstate.mjs';
import { check } from '../src/shared/contracts.mjs';
import { dateChipModel, TRANSLATION_FLAG, UNVERIFIED_FLAG } from '../src/ui/panels/date-chip.mjs';
import { highlightSegments, passageCardModel, passageNotes } from '../src/ui/panels/passage-card.mjs';
import {
  cardYears, clampSize, contemporaryWindow, contextShift, contextWords, DEFAULT_SIZE, dockFor, FOOTER_TEXT, mount as mountInspector,
  nextLinks, NO_RELATIONSHIP, readSize, relationSummary, resolveTarget, selectPassage, SIZE_KEY, splitLinks, stratifyUses,
  usesDenominator, writeSize,
} from '../src/ui/panels/inspector.mjs';
import { chunkDisplay, chunkIndexOf, chunkRequest, chunkToDrop, createReader, MAX_CHUNKS, passageSpans, READER_CHUNK, readerSegments } from '../src/ui/panels/reader.mjs';
import { byText, createFakeApi, fixtureBody, fixtureVariantsOf, installFakeDom, settle, visibleText } from './ui.panels.fakedom.mjs';

const P901 = () => fixtureBody('GET', '/api/passages/:id', 'p901');

// ── Pure logic ───────────────────────────────────────────────────────────────────────────────────────

describe('date chip (§1.11, §2.D)', () => {
  test('the first-60-seconds chip reads "17 May 1994 · stated · day" with its role', () => {
    const m = dateChipModel(P901().document.date_card);
    assert.equal(m.text, '17 May 1994 · stated · day');
    assert.equal(m.roleLabel, 'publication');
    assert.deepEqual(m.flags, []);
  });
  test('a Cipher list year is flagged "unverified"; a translation says it is dated by the original', () => {
    const cipher = fixtureBody('GET', '/api/passages/:id', 'title_cipher');
    assert.ok(dateChipModel(cipher.document.date_card).flags.includes(UNVERIFIED_FLAG));
    assert.ok(dateChipModel(cipher.document.date_card, { isTranslation: true }).flags.includes(TRANSLATION_FLAG));
  });
  test('derived dates keep their conversion note and glyph; no card → undated', () => {
    const gu = fixtureBody('GET', '/api/passages/:id', 'p140_gu');
    const m = dateChipModel(gu.document.date_card);
    assert.equal(m.text, '1930–1931 (VS 1987) · derived · range');
    assert.equal(m.glyph, '⇄');
    assert.match(m.notes[0], /Vikram Samvat/);
    assert.equal(dateChipModel(null).text, 'undated');
  });
});

describe('highlights at their offsets (D4, I2)', () => {
  test('p901: the match is exactly text[58, 72) and the segments rebuild the text', () => {
    const p = P901();
    const segs = highlightSegments(p.text, p.highlights);
    assert.equal(segs.map((s) => s.text).join(''), p.text);
    const marks = segs.filter((s) => s.mark);
    assert.equal(marks.length, 1);
    assert.equal(marks[0].text, 'carry the zero');
    assert.equal(marks[0].text, p.text.slice(p.highlights[0].start, p.highlights[0].end));
    assert.deepEqual(marks[0].occs, [55012]);
  });
  test('every passage fixture: marks slice the text exactly where the highlight says', () => {
    for (const { body, status } of fixtureVariantsOf('GET', '/api/passages/:id')) {
      if (status !== 200) continue;
      const segs = highlightSegments(body.text, body.highlights);
      assert.equal(segs.map((s) => s.text).join(''), body.text);
      for (const hl of body.highlights) {
        assert.ok(segs.some((s) => s.mark && s.start === hl.start && s.end === hl.end && s.text === body.text.slice(hl.start, hl.end)));
      }
    }
  });
  test('the selected occurrence is marked; overlaps merge; out-of-range and empty spans are dropped', () => {
    const text = 'carry the zero, carry the zero';
    const segs = highlightSegments(text, [
      { start: 0, end: 14, occ: 1 }, { start: 6, end: 14, occ: 2 }, { start: 16, end: 30, occ: 3 },
      { start: 40, end: 50, occ: 4 }, { start: 5, end: 5, occ: 5 },
    ], { selectedOcc: 3 });
    assert.equal(segs.map((s) => s.text).join(''), text);
    const marks = segs.filter((s) => s.mark);
    assert.equal(marks.length, 2);
    assert.deepEqual(marks[0].occs, [1, 2]);
    assert.equal(marks[1].selected, true);
    assert.equal(marks[0].selected, false);
  });
  test('an occurrence of an older materialization run is ringed by its offsets, never by a near miss (final gate)', () => {
    const text = 'carry the zero, carry the zero';
    const hls = [{ start: 0, end: 14, occ: 101 }, { start: 16, end: 30, occ: 102 }];
    const ring = (span) => highlightSegments(text, hls, { selectedOcc: 7, selectedSpan: span }).filter((s) => s.selected).map((s) => s.start);
    assert.deepEqual(ring({ start: 16, end: 30 }), [16], 'same characters, newer id: the highlight is ringed');
    assert.deepEqual(ring({ start: 15, end: 30 }), [], 'a span reaching outside every highlight rings nothing');
    assert.deepEqual(ring(null), [], 'without offsets an unknown id rings nothing');
  });
  test('a highlight never splits a surrogate pair (emoji, astral script)', () => {
    const text = 'a 😀b 𝒵ero';
    // offsets 2..3 would cut the emoji in half
    const segs = highlightSegments(text, [{ start: 3, end: 4, occ: 1 }, { start: 6, end: 7, occ: 2 }]);
    assert.equal(segs.map((s) => s.text).join(''), text);
    for (const s of segs) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(s.text), `segment '${s.text}' splits a pair`);
  });
  test('passage notes make default exclusions visible (§13 rule 9)', () => {
    const notes = passageNotes({ field: 'summary', time_role: 'describes', quality: 'boilerplate', document: { is_translation: true } });
    assert.equal(notes.length, 4);
    assert.match(notes.join(' '), /excluded from counts by default/);
    assert.deepEqual(passageNotes(P901()), []);
  });
  test('the card model carries SYN, refers-to, re-read and machine annotations', () => {
    const m = passageCardModel(P901());
    assert.equal(m.synthetic, true);
    assert.equal(m.referenced, '1911');
    assert.equal(m.machine[0].label, 'machine label: counted · hold · ones');
    assert.equal(m.machine[0].humanLabel, 'honoring the uncounted');
    const p77 = passageCardModel(fixtureBody('GET', '/api/passages/:id', 'p77'));
    assert.match(p77.reread, /re-read after 2016/);
  });
});

describe('selection, windows and relationship summaries', () => {
  test('resolveTarget: passages load directly; an occurrence needs its passage from selectionContext', () => {
    assert.deepEqual(resolveTarget({ type: 'passage', id: 901 }, {}), { kind: 'passage', passage: 901, occ: null });
    assert.deepEqual(resolveTarget({ type: 'occurrence', id: 55012 }, {}), { kind: 'occurrence', occ: 55012 });
    assert.deepEqual(resolveTarget({ type: 'occurrence', id: 55012 }, { selectionContext: { occ: 55012, passage: 901 } }),
      { kind: 'passage', passage: 901, occ: 55012 });
    assert.deepEqual(resolveTarget({ type: 'document', id: 44 }, {}), { kind: 'document', document: 44 });
    assert.equal(resolveTarget(null, {}), null);
  });
  test('selectPassage records the occurrence → passage link, selects and opens the inspector', () => {
    const store = createStore(defaultState('demo'));
    store.dispatch({ type: 'CLOSE_PANEL', panel: 'inspector' });
    selectPassage(store, { passage: 901, occ: 55012 });
    const s = store.get();
    assert.deepEqual(s.view.selection, { type: 'occurrence', id: 55012 });
    assert.deepEqual(s.ui.selectionContext, { passage: 901, occ: 55012 });
    assert.equal(s.view.panels.inspector, 'tnn');
  });
  test('contemporary window W = max(10 y, 2 × width), centred on the date', () => {
    assert.deepEqual(cardYears({ label: '17 May 1994' }), { lo: 1994, hi: 1994 });
    assert.deepEqual(contemporaryWindow(cardYears({ label: '17 May 1994' })), { from: 1989, to: 1999 });
    assert.deepEqual(cardYears({ label: '1930–1931 (VS 1987)' }), { lo: 1930, hi: 1931 });
    assert.deepEqual(contemporaryWindow({ lo: 1900, hi: 1933 }), { from: 1882, to: 1951 });
    assert.deepEqual(cardYears({ label: 'x', lo_year: 1850, hi_year: 1859 }), { lo: 1850, hi: 1859 });
    assert.equal(cardYears({ label: 'undated' }), null);
    assert.equal(contemporaryWindow(null), null);
  });
  test('uses are stratified: ≤ 3 per lane, ≤ 9 in all, never the passage itself', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push({ passage: i, lane: `l${i % 4}` });
    const out = stratifyUses(rows, { exclude: 0 });
    assert.equal(out.length, 9);
    assert.ok(!out.some((r) => r.passage === 0));
    const per = {};
    for (const r of out) per[r.lane] = (per[r.lane] ?? 0) + 1;
    assert.ok(Object.values(per).every((n) => n <= 3));
    assert.equal(usesDenominator({ total: 37, denominator: { tokens: 6100000 } }, { from: 1925, to: 1945 }), 'n = 37 in 1925–1945 · 6.1M tokens');
    assert.equal(usesDenominator({ total: 340 }, { from: 1989, to: 1999 }), 'n = 340 in 1989–1999');
  });
  test('relationship summary: later uses are "in"; none → the fixed sentence', () => {
    assert.match(relationSummary(P901()).now, /^1 later item is linked/);
    assert.match(relationSummary(P901()).next, /^3 recorded links lead/);
    assert.equal(relationSummary({ relationships: { in: 0, out: 0 } }).now, 'No recorded relationship; these are separate uses of the same expression.');
    assert.equal(relationSummary({}).hasAny, false);
  });
  test('placement: slim line without a selection, right of the Scroll when wide, a split otherwise, the sheet when narrow', () => {
    const base = { open: true, selected: true, narrow: false, wide: true, rightPanel: null };
    assert.equal(dockFor(base), 'right');
    assert.equal(dockFor({ ...base, rightPanel: 'lineage' }), 'bottom', 'a right-hand view takes the right side');
    assert.equal(dockFor({ ...base, wide: false }), 'bottom');
    assert.equal(dockFor({ ...base, selected: false }), 'slim');
    assert.equal(dockFor({ ...base, open: false }), 'closed');
    assert.equal(dockFor({ ...base, narrow: true }), 'sheet');
    assert.equal(dockFor({ ...base, narrow: true, selected: false }), 'closed');
  });
  test('split sizes are clamped and remembered; a blocked storage falls back to the defaults', () => {
    assert.deepEqual(clampSize({ h: 20, w: 5000 }, { vw: 1440, vh: 900 }), { h: 140, w: 800 });
    assert.deepEqual(clampSize({ h: 2000, w: 100 }, { vw: 1440, vh: 900 }), { h: 580, w: 380 });
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    writeSize(storage, { h: 401.4, w: 612.6 });
    assert.equal(mem.get(SIZE_KEY), '{"h":401,"w":613}');
    assert.deepEqual(readSize(storage), { h: 401, w: 613 });
    const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
    assert.deepEqual(readSize(blocked), { ...DEFAULT_SIZE });
    assert.doesNotThrow(() => writeSize(blocked, { h: 300, w: 500 }));
    mem.set(SIZE_KEY, 'not json');
    assert.deepEqual(readSize(storage), { ...DEFAULT_SIZE });
  });
  test('links around a passage: later uses (NOW) strongest first, earlier sources (draws on); the root document counts as the passage', () => {
    const lin = {
      root: 'passage:55',
      nodes: [
        { id: 'passage:55', y: 1994, direction: 'root', generation: 0 },
        { id: 'document:15', y: 1994, direction: 'root', root_document: true, generation: 0 },
        { id: 'document:4', y: 1911, direction: 'earlier', generation: 1 },
        { id: 'document:24', y: 2016, direction: 'later', generation: 1 },
        { id: 'document:25', y: 2017, direction: 'later', generation: 1 },
        { id: 'passage:70', y: 2001, direction: 'later', generation: 1 },
      ],
      edges: [
        { rel_id: 1, src: 'document:15', dst: 'document:4', evidence_status: 'documented' },
        { rel_id: 6, src: 'document:24', dst: 'document:15', evidence_status: 'documented' },
        { rel_id: 10, src: 'document:25', dst: 'document:15', evidence_status: 'proposed' },
        { rel_id: 12, src: 'passage:70', dst: 'passage:55', evidence_status: 'computed' },
      ],
    };
    const { later, earlier } = splitLinks(lin);
    assert.deepEqual(later.map((x) => x.edge.rel_id), [6, 12, 10], 'documented, then computed, then proposed');
    assert.deepEqual(earlier.map((x) => x.node.id), ['document:4']);
    assert.deepEqual(nextLinks({ ...lin, root: 'document:15' }).map((x) => x.node.y), [2001, 2016, 2017], 'NEXT is time-sorted');
    assert.deepEqual(splitLinks(null), { later: [], earlier: [] });
  });
  test('context shift: words within ±10 tokens of each match, only around Then / only around Now', () => {
    const then = 'In the column lesson they learned to carry the zero and keep the place.';
    const now = 'We carry the zero for the ones nobody counted on the block.';
    const span = (t) => [{ start: t.indexOf('carry the zero'), end: t.indexOf('carry the zero') + 14 }];
    const a = contextWords(then, span(then));
    assert.ok(a.has('lesson') && !a.has('carry'), 'the match itself is not a context word');
    const s = contextShift(a, contextWords(now, span(now)));
    assert.ok(s.onlyThen.includes('lesson') && s.onlyNow.includes('counted') && s.shared.includes('the'));
    assert.equal(contextWords(then, []).size, 0);
  });
});

describe('reader slices (virtualized, UTF-16 offsets)', () => {
  function randomText(n, seed) {
    let x = seed;
    const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
    let s = '';
    while (s.length < n) s += rnd() < 0.15 ? '😀' : rnd() < 0.1 ? 'શ' : String.fromCharCode(97 + Math.floor(rnd() * 26));
    return s;
  }
  test('slices tile the document exactly and never split a surrogate pair', () => {
    for (const [size, seed] of [[7, 1], [8, 2], [16, 3], [5, 4]]) {
      const doc = randomText(200, seed);
      let rebuilt = '';
      let prevEnd = 0;
      for (let i = 0; i * size < doc.length; i++) {
        const req = chunkRequest(i, doc.length, size);
        const slice = chunkDisplay(i, doc.slice(req.from, req.to), req.from, doc.length, size);
        assert.equal(slice.start, prevEnd, `slice ${i} starts where ${i - 1} ended (size ${size})`);
        assert.ok(!/^[\uDC00-\uDFFF]/.test(slice.text) && !/[\uD800-\uDBFF]$/.test(slice.text), `slice ${i} keeps pairs whole`);
        rebuilt += slice.text;
        prevEnd = slice.end;
      }
      assert.equal(rebuilt, doc);
    }
  });
  test('requests stay within the 20k-character slice limit and the document', () => {
    const r = chunkRequest(3, 100000);
    assert.equal(r.from, 3 * READER_CHUNK - 1);
    assert.ok(r.to - r.from <= 20000);
    assert.equal(chunkRequest(0, 153).to, 153);
    assert.equal(chunkIndexOf(READER_CHUNK + 5), 1);
  });
  test('reader segments mark the passage and its matches at document offsets', () => {
    const p = P901();
    const spans = passageSpans(p);
    assert.deepEqual(spans, [{ start: 48, end: 152, kind: 'passage' }, { start: 106, end: 120, kind: 'match' }]);
    const doc = fixtureBody('GET', '/api/documents/:id/text', 'ok').text;
    const segs = readerSegments(doc, 0, spans);
    assert.equal(segs.map((s) => s.text).join(''), doc);
    const match = segs.find((s) => s.kinds.includes('match'));
    assert.equal(match.text, 'carry the zero');
    assert.deepEqual(match.kinds.sort(), ['match', 'passage']);
    assert.equal(passageSpans({ ...p, field: 'title' }).length, 0);
  });
  test('the farthest slice is dropped beyond the limit', () => {
    assert.equal(chunkToDrop([1, 2, 3], 3, 5), null);
    assert.equal(chunkToDrop([2, 3, 4, 5, 6, 7], 7, 5), 2);
    assert.equal(chunkToDrop([2, 3, 4, 5, 6, 1], 1, 5), 6);
  });
});

// ── Rendering against the fixtures ───────────────────────────────────────────────────────────────────

describe('inspector rendering (fake DOM, contract fixtures)', () => {
  let dom;
  beforeEach(() => { dom = installFakeDom(); });
  afterEach(() => dom.restore());

  function setup({ narrow = false, variants = {}, state = defaultState('demo') } = {}) {
    dom.setNarrow(narrow);
    const host = dom.document.createElement('div');
    host.id = 'inspector';
    dom.document.body.appendChild(host);
    const store = createStore(state);
    const api = withLineage(createFakeApi({ variants }));
    const announced = [];
    const handle = mountInspector(host, { store, api, keys: null, announce: (t) => announced.push(t) });
    return { host, store, api, handle, announced };
  }

  // The depth-1 links around passage 901, built from the lineage fixture (the fixture itself is rooted at 77).
  const LINKS_901 = () => {
    const f = fixtureBody('GET', '/api/lineage', 'ok');
    const node = (id, direction) => ({ ...f.nodes.find((n) => n.id === id), direction, generation: direction === 'root' ? 0 : 1 });
    return { ...f, root: 'passage:901', nodes: [node('passage:901', 'root'), node('passage:77', 'earlier'), node('passage:2210', 'later')],
      edges: f.edges.filter((e) => [7781, 7811].includes(e.rel_id)), groups: f.groups };
  };
  function withLineage(api) {
    const get = api.get;
    api.get = async (path, query = null, opts) => {
      if (path !== '/lineage') return get(path, query, opts);
      api.calls.push({ method: 'GET', path: '/api/lineage', query: { ...query } });
      if (query?.root === 'passage:901') return LINKS_901();
      return { root: query?.root ?? null, nodes: [], edges: [], groups: [], links: [], truncated: { nodes: 0, reason: null } };
    };
    return api;
  }

  test('the 1994 Hip-hop passage opens with its span, SYN badge and date chip (§1.11 step 3)', async () => {
    const { host, store, api, announced } = setup();
    selectPassage(store, { passage: 901, occ: 55012 });
    await settle();
    const text = visibleText(host);
    assert.match(text, /Zero Holds the Place/);
    const chip = host.querySelector('.date-chip-main');
    assert.equal(chip.textContent, '17 May 1994 · stated · day');
    const mark = host.querySelector('.passage-text mark.hl');
    assert.equal(mark.textContent, 'carry the zero');
    assert.equal(mark.getAttribute('data-start'), '58');
    assert.ok(mark.classList.contains('is-selected'), 'the clicked occurrence is ringed');
    assert.ok(host.querySelector('.badge-syn'), 'SYN badge');
    assert.ok(host.querySelector('.inspector').classList.contains('syn-frame'), 'dashed frame on synthetic material');
    assert.ok(text.includes(FOOTER_TEXT));
    assert.match(text, /Machine annotations \(fallible\)/);
    assert.match(text, /refers to 1911/);
    assert.deepEqual(host.querySelectorAll('.insp-col').map((c) => c.getAttribute('data-col')), ['then', 'now', 'next'], 'three columns');
    assert.equal(host.getAttribute('data-dock'), 'right', 'wide screen: right of the Scroll');
    // contemporary uses: KWIC in 1989–1999 for expression 12, stratified, with the denominator line
    const kwicCall = api.calls.find((c) => c.path === '/api/kwic');
    assert.deepEqual([kwicCall.query.expr, kwicCall.query.from, kwicCall.query.to], ['12', '1989', '1999']);
    assert.match(text, /n = 340 in 1989–1999/);
    const rows = host.querySelectorAll('.insp-uses .kwic-row');
    assert.ok(rows.length > 0 && rows.length <= 9);
    assert.ok(!rows.some((r) => r.getAttribute('data-passage') === '901'), 'the passage itself is not a contemporary use');
    assert.ok(announced.some((a) => /Passage open: Zero Holds the Place/.test(a)));
    // THEN draws on the 1911 primer; NOW: the later item with the strongest evidence, its link card; NEXT: what followed it
    const lineageCall = api.calls.find((c) => c.path === '/api/lineage' && c.query.root === 'passage:901');
    assert.deepEqual([lineageCall.query.depth, lineageCall.query.dir], [1, 'both']);
    const drawsOn = visibleText(host.querySelector('.insp-drawson'));
    assert.match(drawsOn, /cites Brennock's Ready Arithmetic \(1911\)/);
    assert.match(drawsOn, /DOC documented/);
    const now = host.querySelector('.insp-now');
    const pick = now.querySelector('.link-line[data-rel="7811"]');
    assert.equal(pick.getAttribute('aria-pressed'), 'true', 'the only later item is chosen');
    assert.match(visibleText(pick), /Verse, 2017 \(2017\) may allude to this/);
    assert.match(visibleText(pick), /PROP proposed/);
    assert.match(visibleText(pick), /⚖ disputed/, 'review is an overlay in words; the status word stays proposed');
    assert.ok(now.querySelector('.edge-card'), 'the relationship card of the chosen link');
    assert.ok(api.calls.some((c) => c.path === '/api/relationships/7811'));
    assert.ok(byText(now, 'Any later occurrence (no recorded link)'));
    const next = visibleText(host.querySelector('.insp-next'));
    assert.match(next, /No recorded later links from Verse, 2017\./);
    // M5 gate: the use's context group comes from Passage.machine (a succeeded clustering run) and GET /api/clusters
    assert.match(next, /Later uses in the same context group/);
    assert.match(next, /machine label: counted · hold · ones/);
    assert.match(next, /run #14/);
    assert.ok(api.calls.some((c) => c.path === '/api/clusters'), 'the run of the group is read, never assumed');
    assert.match(next, /Hypothesis — by .+ — not evidence/);
    assert.ok(byText(host, 'Lineage (G)'));
  });

  test('NOW: no recorded relationship says so; "any later occurrence" shows the next use and the context shift', async () => {
    const { host, store, api } = setup();
    store.dispatch({ type: 'UI_SET', key: 'selectionContext', value: null });
    selectPassage(store, { passage: 77 });
    await settle();
    const now = host.querySelector('.insp-now');
    assert.match(visibleText(now), new RegExp(NO_RELATIONSHIP.replace(/[.;]/g, '.')));
    byText(now, 'Any later occurrence (no recorded link)').click();
    await settle(12);
    const kw = api.calls.filter((c) => c.path === '/api/kwic').at(-1);
    assert.equal(kw.query.sort, 'date');
    assert.equal(kw.query.limit, '1');
    assert.match(visibleText(host.querySelector('.insp-now')), /The next later occurrence/);
  });

  test('every 200 passage fixture renders; Gujarati keeps its script and lang', async () => {
    for (const { name, status, body } of fixtureVariantsOf('GET', '/api/passages/:id')) {
      if (status !== 200) continue;
      const { host, store } = setup({ variants: { 'GET /api/passages/:id': name } });
      store.dispatch({ type: 'SELECT', selection: { type: 'passage', id: body.id } });
      await settle();
      const p = host.querySelector('.passage-text');
      assert.ok(p, name);
      assert.equal(p.textContent, body.text, `${name}: the passage text is shown verbatim`);
      if (body.lang === 'gu') assert.equal(p.getAttribute('lang'), 'gu');
      host.remove();
    }
  });

  test('a missing passage shows the server message and a Retry button (§8.8)', async () => {
    const { host, store, api } = setup({ variants: { 'GET /api/passages/:id': 'not_found' } });
    store.dispatch({ type: 'SELECT', selection: { type: 'passage', id: 999999 } });
    await settle();
    assert.match(visibleText(host), /No passage 999999\./);
    const retry = byText(host, 'Retry');
    assert.ok(retry);
    const before = api.calls.length;
    retry.click();
    await settle();
    assert.ok(api.calls.length > before, 'Retry asks again');
  });

  test('an empty contemporary window says 0 is an observation about this index', async () => {
    const { host, store } = setup({ variants: { 'GET /api/kwic': 'empty' } });
    selectPassage(store, { passage: 901 });
    await settle();
    assert.match(visibleText(host), /0 is an observation about this index/);
  });

  test('a contemporary-uses error keeps the passage and offers Retry', async () => {
    const { host, store } = setup({ variants: { 'GET /api/kwic': 'error' } });
    selectPassage(store, { passage: 901 });
    await settle();
    assert.ok(host.querySelector('.passage-text'));
    assert.match(visibleText(host), /concordance query took longer than 5 s/);
  });

  test('neighbouring passages are fetched on request (context=1)', async () => {
    const { host, store, api } = setup();
    selectPassage(store, { passage: 901 });
    await settle();
    byText(host, 'Show neighbouring passages').click();
    await settle();
    assert.ok(api.calls.some((c) => c.path === '/api/passages/901' && c.query.context === '1'));
    assert.ok(byText(host, 'Hide neighbouring passages'));
  });

  test('an occurrence without selection context is resolved by the server (GET /api/occurrences/:id), never guessed', async () => {
    const { host, store, api } = setup();
    store.dispatch({ type: 'SELECT', selection: { type: 'occurrence', id: 55012 } });
    await settle();
    const paths = api.calls.map((c) => c.path);
    const occ = paths.findIndex((p) => p.startsWith('/api/occurrences/55012'));
    const psg = paths.findIndex((p) => p.startsWith('/api/passages/901'));
    assert.ok(occ >= 0 && psg > occ, `occurrence resolved before the passage is read (${paths.join(', ')})`);
    assert.match(visibleText(host), /Zero Holds the Place/);
    // M5 gate: the answer is published, so Lineage (G) and the Notebook (N) root at the same passage after a reload
    assert.deepEqual(store.get().ui.selectionContext, { passage: 901, occ: 55012 });
    assert.doesNotMatch(visibleText(host), /Opening the passage/, 'the passage finished loading (no request raced away)');
  });

  test('a document selection shows its card and tags with provenance', async () => {
    const { host, store } = setup();
    store.dispatch({ type: 'SELECT', selection: { type: 'document', id: 44 } });
    await settle();
    const text = visibleText(host);
    assert.match(text, /Zero Holds the Place/);
    assert.match(text, /theme: hip hop/);
    assert.ok(byText(host, 'Open in reader'));
  });

  test('bins, clusters and relationships do not open the inspector (other views own them)', async () => {
    const { host, store } = setup();
    store.dispatch({ type: 'SELECT', selection: { type: 'bin', id: 'L2:community:hiphop:199' } });
    await settle();
    assert.equal(host.querySelector('.inspector').hidden, true);
  });

  test('closing clears the selection; a new selection reopens the inspector', async () => {
    const { host, store } = setup();
    selectPassage(store, { passage: 901 });
    await settle();
    host.querySelector('.insp-close').click();
    assert.equal(store.get().view.selection, null);
    assert.equal(store.get().view.panels.inspector, null);
    assert.equal(host.querySelector('.inspector').hidden, true);
    store.dispatch({ type: 'SELECT', selection: { type: 'passage', id: 77 } });
    await settle();
    assert.equal(store.get().view.panels.inspector, 'tnn');
    assert.match(visibleText(host), /Brennock's Ready Arithmetic/);
  });

  test('Open in reader: the full original with the passage outlined and the match marked at its offsets', async () => {
    const { host, store, api } = setup();
    selectPassage(store, { passage: 901, occ: 55012 });
    await settle();
    byText(host, 'Open in reader').click();
    await settle(12);
    assert.equal(store.get().view.panels.inspector, 'reader');
    const textCall = api.calls.find((c) => c.path === '/api/documents/44/text');
    assert.deepEqual([textCall.query.from, textCall.query.to], ['0', '153'], 'the first slice, clipped to the known length');
    const body = host.querySelector('.reader-body');
    const doc = fixtureBody('GET', '/api/documents/:id/text', 'ok').text;
    assert.equal(host.querySelector('.reader-pages').textContent, doc, 'the whole (short) document, verbatim');
    assert.equal(host.querySelector('.reader-body mark.hl').textContent, 'carry the zero');
    assert.ok(host.querySelector('.reader-passage'));
    assert.match(visibleText(host), /Showing characters 0–153 of 153/);
    assert.ok(body);
    assert.equal(dom.document._scrolledIntoView?.className.includes('reader-passage'), true, 'scrolled to the passage');
    byText(host, '← Then · Now · Next').click();
    await settle();
    assert.equal(store.get().view.panels.inspector, 'tnn');
    assert.ok(host.querySelector('.insp-cols'));
  });

  test('a metadata-only document says it has no full text (no lyrics invented)', async () => {
    const { host, store } = setup({ variants: { 'GET /api/passages/:id': 'title_cipher', 'GET /api/documents/:id': 'metadata_only' } });
    selectPassage(store, { passage: 61234 });
    await settle();
    byText(host, 'Open in reader').click();
    await settle(12);
    const text = visibleText(host);
    assert.match(text, /Metadata only: Cipher holds titles, not lyrics or scripts\./);
    assert.ok(!host.querySelector('.reader-chunk'));
  });

  test('narrow: Then/Now/Next tabs inside the shell bottom sheet, all by tap — no hover', async () => {
    const { host, store } = setup({ narrow: true });
    const root = host.querySelector('.inspector');
    assert.equal(root.hidden, true, 'no sheet without a selection');
    assert.equal(host.getAttribute('data-dock'), 'closed');
    selectPassage(store, { passage: 901 });
    await settle();
    assert.equal(root.getAttribute('data-layout'), 'narrow');
    assert.equal(host.getAttribute('data-dock'), 'sheet');
    assert.equal(host.querySelector('.insp-resize'), null, 'the shell owns the sheet handle');
    const panels = () => host.querySelectorAll('[role="tabpanel"]').filter((p) => !p.hidden).map((p) => p.getAttribute('data-col'));
    assert.deepEqual(panels(), ['then']);
    byText(host, 'Now').click();
    assert.deepEqual(panels(), ['now']);
    assert.equal(host.querySelector('[data-tab="now"]').getAttribute('aria-selected'), 'true');
    const nowTab = host.querySelector('[data-tab="now"]');
    nowTab.dispatchEvent({ type: 'keydown', key: 'ArrowRight', bubbles: true, preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(panels(), ['next']);
    assert.deepEqual(dom.hoverListenerTypes(), [], 'no control depends on hover');
  });

  test('switching from desktop to narrow re-lays out the open inspector', async () => {
    const { host, store } = setup();
    selectPassage(store, { passage: 901 });
    await settle();
    const root = host.querySelector('.inspector');
    assert.equal(root.getAttribute('data-layout'), 'desktop');
    assert.equal(host.querySelectorAll('.insp-col').filter((p) => !p.hidden).length, 3, 'three columns on desktop');
    dom.setNarrow(true);
    assert.equal(root.getAttribute('data-layout'), 'narrow');
    assert.equal(host.querySelectorAll('[role="tabpanel"]').filter((p) => !p.hidden).length, 1);
  });

  test('desktop split: a slim line without a selection; a resize handle that remembers its size (keyboard too)', async () => {
    const mem = new Map();
    dom.window.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    const { host, store, announced } = setup();
    assert.equal(host.getAttribute('data-dock'), 'slim');
    assert.match(visibleText(host), /Select a mark on the Scroll to read its passage/);
    assert.equal(dom.document.documentElement.getAttribute('data-insp-dock'), 'slim');
    selectPassage(store, { passage: 901 });
    await settle();
    assert.equal(host.getAttribute('data-dock'), 'right');
    store.dispatch({ type: 'OPEN_PANEL', panel: 'lineage' });
    assert.equal(host.getAttribute('data-dock'), 'bottom', 'a right-hand view moves the inspector under the Scroll');
    const handle = host.querySelector('.insp-resize');
    assert.equal(handle.getAttribute('role'), 'separator');
    handle.dispatchEvent({ type: 'keydown', key: 'ArrowUp', bubbles: true, preventDefault() {}, stopPropagation() {} });
    assert.equal(host.style.getPropertyValue('--insp-h'), `${DEFAULT_SIZE.h + 24}px`);
    assert.deepEqual(JSON.parse(mem.get(SIZE_KEY)), { h: DEFAULT_SIZE.h + 24, w: DEFAULT_SIZE.w });
    assert.ok(announced.some((a) => /Inspector height/.test(a)));
    delete dom.window.localStorage;
  });

  test('the reader is virtualized: slices load on demand, at most MAX_CHUNKS stay, the text is exact', async () => {
    // A long synthetic document (generated here; no corpus text is invented in the app).
    let doc = '';
    for (let i = 0; doc.length < READER_CHUNK * 9; i++) doc += `line ${i} carries 😀 and શૂન્ય through the place\n`;
    const calls = [];
    const api = {
      async get(path, query) {
        calls.push({ path, query });
        if (path === '/documents/7') return { id: 7, title: 'Long test document', has_full_text: true, length: doc.length, date_card: null, synthetic: false };
        const from = Number(query.from), to = Math.min(Number(query.to), doc.length);
        assert.ok(to - from <= 20000, 'never more than 20k characters per request');
        return { document_id: 7, from, to, text: doc.slice(from, to), length: doc.length };
      },
    };
    const start = READER_CHUNK * 4 + 100;
    const passage = { id: 1, field: 'body', start, end: start + 40, highlights: [{ start: 5, end: 9 }], document: { id: 7, title: 'Long test document' } };
    const r = createReader({ api, documentId: 7, passage });
    await r.ready;
    assert.deepEqual(r.loaded(), [4], 'only the slice holding the passage');
    const lastChunk = Math.floor((doc.length - 1) / READER_CHUNK);
    for (let i = 0; i < 6; i++) await r.loadNext();
    assert.deepEqual(r.loaded(), [lastChunk - 4, lastChunk - 3, lastChunk - 2, lastChunk - 1, lastChunk], 'the farthest slice was dropped');
    const pages = r.el.querySelector('.reader-pages');
    const first = Number(pages.children[0].getAttribute('data-start'));
    const last = Number(pages.children.at(-1).getAttribute('data-end'));
    assert.equal(last, doc.length);
    assert.equal(pages.textContent, doc.slice(first, last), 'the shown text is the original, verbatim and contiguous');
    assert.equal(r.el.querySelectorAll('.reader-more')[1].hidden, true, 'no "Later text" at the end');
    await r.loadPrev();
    assert.deepEqual(r.loaded(), [lastChunk - 5, lastChunk - 4, lastChunk - 3, lastChunk - 2, lastChunk - 1]);
    assert.equal(pages.textContent, doc.slice(Number(pages.children[0].getAttribute('data-start')), Number(pages.children.at(-1).getAttribute('data-end'))));
    assert.match(visibleText(r.el), /Showing characters/);
  });

  test('the fixtures it renders are valid Passage / Document / Kwic shapes', () => {
    for (const { status, body, name } of fixtureVariantsOf('GET', '/api/passages/:id')) if (status === 200) assert.deepEqual(check('Passage', body), [], name);
    for (const { status, body, name } of fixtureVariantsOf('GET', '/api/kwic')) if (status === 200) assert.deepEqual(check('Kwic', body), [], name);
  });
});
