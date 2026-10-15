// OWNER: WP0 — view state and URL hash (§8.2): defaults, canonical form, round trip, never-throwing decode
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEWSTATE_VERSION, defaultState, canonicalize, encode, decode, decodeHash, stateHash, parseFilter, formatFilter,
  AXIS_LIMITS, MAX_STRANDS,
} from '../src/shared/viewstate.mjs';
import { check } from '../src/shared/contracts.mjs';
import { dayFromYMD } from '../src/shared/dates.mjs';
import { mulberry32 } from '../src/shared/ids.mjs';
import { REL_TYPES, LANE_FACETS, LANE_ORDERS, TIERS, RIGHT_PANELS, STRAND_TYPES } from '../src/shared/vocab.mjs';

const SPEC_EXAMPLE = '#v=1&c=demo&s=e12&l=community:fo&f=syn:1&tg=tr0.ds0.ap0.dup0.nm0.est1.bp0&x=lin:-1234:9.1&t=9861s&ev=dcp&sel=occ:55012&p=tnn&cmp=1955-1985~1994-2026&r=c14.q9';

test('defaults per corpus are valid view states', () => {
  const demo = defaultState();
  assert.equal(VIEWSTATE_VERSION, 1);
  assert.equal(demo.v, 1);
  assert.equal(demo.corpus, 'demo');
  assert.equal(demo.lanes.facet, 'community');
  assert.equal(demo.vantage.day, dayFromYMD(1925, 12, 31));
  assert.deepEqual(demo.toggles, { tr: 0, ds: 0, ap: 0, dup: 0, nm: 0, est: 1, bp: 0 });
  assert.deepEqual(demo.evidence, { documented: 1, computed: 1, proposed: 1, rejected: 0, kindred: 0 });
  const cipher = defaultState('cipher');
  assert.equal(cipher.lanes.facet, 'domain');
  assert.equal(cipher.vantage.day, AXIS_LIMITS.maxDay);
  for (const s of [demo, cipher]) {
    assert.deepEqual(check('ViewState', s), []);
    assert.deepEqual(canonicalize(s), s, 'defaults are canonical');
  }
  assert.equal(encode(demo), '#v=1&c=demo');
  assert.equal(encode(cipher), '#v=1&c=cipher');
  assert.deepEqual(decode('#v=1&c=demo'), demo);
  assert.deepEqual(decode(''), demo);
  assert.deepEqual(decode('#'), demo);
});

test('the §8.2 example URL decodes without warnings', () => {
  const { state, warnings, view } = decodeHash(SPEC_EXAMPLE);
  assert.deepEqual(warnings, []);
  assert.equal(view, null);
  assert.deepEqual(state.strands, [{ type: 'expression', id: 12, variants: 'default', glyph: 'circle' }]);
  assert.equal(state.lanes.facet, 'community');
  assert.equal(state.lanes.order, 'first_observed');
  assert.equal(state.f.syn, 1);
  assert.deepEqual(state.axis, { mode: 'linear', centerDay: -1234, daysPerPx: 9.1, keepLinear: false });
  assert.deepEqual(state.vantage, { day: 9861, strict: true });
  assert.deepEqual(state.evidence, { documented: 1, computed: 1, proposed: 1, rejected: 0, kindred: 0 });
  assert.deepEqual(state.selection, { type: 'occurrence', id: 55012 });
  assert.deepEqual(state.panels, { inspector: 'tnn', right: null });
  assert.deepEqual(state.compare, { a: { years: [1955, 1985], f: '' }, b: { years: [1994, 2026], f: '' } });
  assert.deepEqual(state.runs, { materialize: {}, cluster: 14, quotes: 9, vectors: null });
  // re-encoded canonically: defaults omitted, same meaning
  const again = encode(state);
  assert.equal(again, '#v=1&c=demo&s=e12&x=lin:-1234:9.1&t=9861s&sel=occ:55012&cmp=1955-1985~1994-2026&r=c14.q9');
  assert.deepEqual(decode(again), state);
});

test('a saved-view hash is recognised', () => {
  const r = decodeHash('#view=carry-the-zero-four-uses-3f9a&as=1');
  assert.deepEqual(r.view, { slug: 'carry-the-zero-four-uses-3f9a', asSaved: true });
  assert.deepEqual(r.state, defaultState('demo'));
  assert.deepEqual(decodeHash('#view=x~2').view, { slug: 'x~2', asSaved: false });
});

function randomState(rnd) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const maybe = (p = 0.5) => rnd() < p;
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const sub = (a, k = 3) => Array.from({ length: int(0, k) }, () => pick(a));
  const texts = ['en', 'fr', 'hi', 'book', 'song', 'east-side zine scene', 'ગુજરાતી કવિતા', 'Hip-hop', '-estimated', 'a~b',
    'x/y', '50%', 'q&a', '#tag', 'α=β', 'bad,comma', 'bad;semi', 'bad:colon', ' padded ', '+plus', "it's"];
  const facets = LANE_FACETS;
  const corpus = pick(['demo', 'cipher', 'stemm', 'user']);
  const strands = Array.from({ length: int(0, 6) }, () => {
    const type = pick(STRAND_TYPES);
    const numeric = ['expression', 'work', 'cluster', 'baseline'].includes(type);
    return {
      type,
      id: numeric ? int(1, 99999) : pick(['hip hop', 'protest, rage', 'a~b', 'Gene Kelly', 'शून्य', 'x.y-z']),
      variants: pick(['default', 'identity', 'all', [int(1, 50), int(1, 50)], []]),
      glyph: 'square',
    };
  });
  const order = pick(LANE_ORDERS);
  const filt = () => ({ lang: sub(texts), kind: sub(texts), coll: sub(texts), culture: sub(texts), field: sub(texts),
    community: sub(texts), basis: sub(texts), syn: pick([0, 1]) });
  const fStr = () => formatFilter(filt());
  const years = () => { const a = int(-4000, 2100), b = int(-4000, 2100); return [a, b]; };
  return {
    v: 1, corpus, strands,
    lanes: { facet: pick(facets), sub: maybe(0.3) ? pick(facets) : null, run: maybe(0.3) ? int(1, 500) : null, order,
      manual: order === 'manual' ? sub(['community:hiphop', 'language:en', 'kind:song', 'a~b:c', 'x y'], 4) : [], max: int(1, 48) },
    f: filt(),
    toggles: { tr: pick([0, 1]), ds: pick([0, 1]), ap: pick([0, 1]), dup: pick([0, 1]), nm: pick([0, 1]), est: pick([0, 1]), bp: pick([0, 1]) },
    timeBasis: pick(['publication', 'referenced']),
    axis: maybe(0.15) ? { mode: 'folded' }
      : { mode: 'linear', centerDay: int(AXIS_LIMITS.minDay, AXIS_LIMITS.maxDay) + rnd(), daysPerPx: 0.025 + rnd() * 7300, keepLinear: maybe() },
    tier: pick(['auto', ...TIERS]),
    vantage: { day: int(AXIS_LIMITS.minDay, AXIS_LIMITS.maxDay), strict: maybe() },
    range: maybe() ? [int(-100000, 40000), int(-100000, 40000)] : null,
    evidence: { documented: pick([0, 1]), computed: pick([0, 1]), proposed: pick([0, 1]), rejected: pick([0, 1]), kindred: pick([0, 1]) },
    layers: Object.fromEntries(['arcs', 'feedback', 'washes', 'coverage', 'etymology', 'claims', 'baseline', 'variety', 'tone', 'superseded']
      .map((k) => [k, pick([0, 1])])),
    selection: maybe() ? pick([{ type: 'occurrence', id: int(1, 1e6) }, { type: 'passage', id: int(1, 1e6) },
      { type: 'bin', id: 'community:hiphop|12|L2|199' }, { type: 'relationship', id: int(1, 9999) }, { type: 'document', id: int(1, 99) }]) : null,
    panels: { inspector: pick(['tnn', 'reader', null]), right: pick([null, ...RIGHT_PANELS]) },
    compare: maybe() ? { a: { years: years(), f: fStr() }, b: { years: years(), f: maybe() ? '' : fStr() } } : null,
    constellation: { layoutKey: maybe() ? pick(['fnv:3b91c2d0', 'k~1', '-']) : null, size: pick(['occurrences', 'documents', 'authors']),
      a: maybe() ? years() : null, b: maybe() ? years() : null },
    lineage: { root: maybe() ? pick(['passage:77', 'document:12', 'etymon:sa:शून्य', '-']) : null, depth: int(0, 9),
      types: sub(REL_TYPES.map((r) => r.code), 4), status: sub(['documented', 'computed', 'proposed', 'bogus'], 3) },
    runs: { materialize: maybe() ? { [int(1, 99)]: int(1, 999), [int(100, 199)]: int(1, 999) } : {}, cluster: maybe() ? int(1, 99) : null,
      quotes: maybe() ? int(1, 99) : null, vectors: maybe() ? int(1, 99) : null },
    asSaved: maybe(0.2),
    reducedMotion: pick(['system', 'on', 'off']),
  };
}

test('round trip: decode(encode(s)) deep-equals canonicalize(s) for 1,000 random states', () => {
  const rnd = mulberry32(8);
  for (let i = 0; i < 1000; i++) {
    const s = randomState(rnd);
    const c = canonicalize(s);
    const h = encode(s);
    const { state, warnings } = decodeHash(h);
    // reduced motion is the viewer's setting: it never travels in the URL (fix pass), so a decoded link says 'system'
    assert.deepEqual(state, { ...c, reducedMotion: 'system' }, `#${i}: ${h}`);
    assert.doesNotMatch(h, /[#&]rm=/, 'no rm= in a link');
    assert.deepEqual(warnings, [], `#${i}: a canonical hash decodes without warnings: ${h}`);
    assert.deepEqual(canonicalize(c), c, 'canonicalize is idempotent');
    assert.equal(encode(c), h, 'encode depends only on the canonical form');
    assert.equal(encode(state), h, 'the decoded link encodes to the same link');
    assert.equal(stateHash(s), stateHash(state), 'the state hash survives the URL');
    assert.deepEqual(check('ViewState', state), []);
    assert.ok(state.strands.length <= MAX_STRANDS);
    assert.match(h, /^#v=1&c=[a-z]+(&[a-z]+=[^&#=]*)*$/, 'one well-formed parameter list');
  }
});

test('canonicalize repairs bad input and reports it', () => {
  const w = [];
  const s = canonicalize({
    corpus: 'Not A Corpus!', strands: Array.from({ length: 6 }, (_, i) => ({ type: 'expression', id: i + 1 })),
    lanes: { facet: 'vibes', order: 'random' }, f: { lang: ['fr', 'en', 'en', 'bad,value'], syn: 7 },
    axis: { mode: 'linear', centerDay: 9e15, daysPerPx: -3 }, tier: 'L9', vantage: { day: 'soon' },
    selection: { type: 'occurrence', id: -4 }, compare: { a: { years: [1990, 1950] } }, lineage: { types: ['nope'] },
  }, w);
  assert.equal(s.corpus, 'demo');
  assert.equal(s.strands.length, MAX_STRANDS);
  assert.deepEqual(s.strands.map((x) => x.glyph), ['circle', 'square', 'triangle', 'diamond']);
  assert.equal(s.lanes.facet, 'community');
  assert.equal(s.lanes.order, 'first_observed');
  assert.deepEqual(s.f.lang, ['en', 'fr']);
  assert.equal(s.f.syn, 1);
  assert.equal(s.axis.centerDay, AXIS_LIMITS.maxDay);
  assert.equal(s.axis.daysPerPx, defaultState().axis.daysPerPx);
  assert.equal(s.tier, 'auto');
  assert.equal(s.vantage.day, defaultState().vantage.day);
  assert.equal(s.selection, null);
  assert.equal(s.compare, null);
  assert.deepEqual(s.lineage.types, []);
  assert.ok(w.length >= 4, w.join(' | '));
  assert.deepEqual(check('ViewState', s), []);
});

test('decode never throws: garbage becomes a valid state plus warnings', () => {
  const rnd = mulberry32(42);
  const pieces = ['v=', '1', '2', 'c=', 'demo', 'cipher', '&', '=', '%', '%E0%A4', '%zz', 's=', 'e', '12', ',', '-', 'x=', 'lin:',
    ':', 'fold', 't=', 's', 'cmp=', '~', '@', 'f=', 'syn:', 'lang:', 'ev=', 'ly=', 'p=', 'sel=', 'occ:', 'r=', 'm1_', '.', 'k=',
    'lg=', 'tg=', 'tr2', 'zz=', '#', '9'.repeat(30), 'NaN', 'Infinity', 'view='];
  for (let i = 0; i < 2000; i++) {
    let h = '#';
    for (let k = Math.floor(rnd() * 14); k > 0; k--) h += pieces[Math.floor(rnd() * pieces.length)];
    const r = decodeHash(h);
    assert.deepEqual(check('ViewState', r.state), [], h);
    assert.ok(Array.isArray(r.warnings));
  }
  for (const bad of [null, undefined, 42, {}, '#v=99&c=demo', '#c=demo&zz=1', '#s=q9', '#x=lin:a:b', '#t=yesterday', '#cmp=1950']) {
    const r = decodeHash(bad);
    assert.deepEqual(check('ViewState', r.state), []);
  }
  assert.ok(decodeHash('#v=99&c=demo').warnings.some((x) => x.includes('version')));
  assert.ok(decodeHash('#c=demo&zz=1').warnings.some((x) => x.includes("'zz'")));
  assert.ok(decodeHash('#v=1&x=lin:a:b').warnings.length > 0);
});

test('stateHash is stable across equivalent states and changes with meaning', () => {
  const a = { ...defaultState(), f: { ...defaultState().f, lang: ['fr', 'en'] } };
  const b = { ...defaultState(), f: { ...defaultState().f, lang: ['en', 'fr', 'en'] } };
  assert.equal(stateHash(a), stateHash(b));
  assert.match(stateHash(a), /^[0-9a-f]{16}$/);
  assert.notEqual(stateHash(a), stateHash(defaultState()));
  assert.notEqual(stateHash(defaultState('demo')), stateHash(defaultState('cipher')));
});

test('filter grammar of §7 parses and formats canonically', () => {
  const w = [];
  const f = parseFilter('lang:en,fr;kind:book,song;coll:cipher-gutenberg;culture:in;field:medicine;basis:-estimated;syn:1', w);
  assert.deepEqual(w, []);
  assert.deepEqual(f, { lang: ['en', 'fr'], kind: ['book', 'song'], coll: ['cipher-gutenberg'], culture: ['in'], field: ['medicine'],
    community: [], basis: ['-estimated'], syn: 1 });
  assert.equal(formatFilter(f), 'lang:en,fr;kind:book,song;coll:cipher-gutenberg;culture:in;field:medicine;basis:-estimated');
  assert.equal(formatFilter(f, { withDefaults: true }), 'lang:en,fr;kind:book,song;coll:cipher-gutenberg;culture:in;field:medicine;basis:-estimated;syn:1');
  assert.deepEqual(parseFilter(formatFilter(f)), f);
  assert.equal(formatFilter(parseFilter('syn:0')), 'syn:0');
  assert.equal(formatFilter(parseFilter('')), '');
  const w2 = [];
  parseFilter('mood:sad;lang:en', w2);
  assert.ok(w2.some((x) => x.includes('mood')));
});

test('the hash is readable: grammar punctuation stays literal, free text is escaped', () => {
  const s = { ...defaultState(), f: { ...defaultState().f, community: ['east-side zine scene'], lang: ['en'] },
    strands: [{ type: 'theme', id: 'hip hop' }], lanes: { ...defaultState().lanes, facet: 'language' } };
  const h = encode(s);
  assert.ok(h.includes('f=lang:en;community:east-side%20zine%20scene'), h);
  assert.ok(h.includes('s=thip%20hop'), h);
  assert.ok(h.includes('l=language:fo'), h);
  assert.deepEqual(decode(h), canonicalize(s));
});

test('a link never sets the viewer’s reduced motion: rm= is not written, and an old link’s rm= is ignored (fix pass, §8.2)', () => {
  const { state, warnings } = decodeHash('#v=1&c=demo&s=e1&t=-16072c&rm=off');
  assert.equal(state.reducedMotion, 'system');
  assert.deepEqual(warnings, []);
  assert.doesNotMatch(encode({ ...state, reducedMotion: 'on' }), /rm=/);
  assert.equal(stateHash({ ...state, reducedMotion: 'on' }), stateHash(state), 'the setting is not part of what a view shows');
});

test('loading a link or a saved view keeps the viewer’s reduced-motion setting (fix pass)', async () => {
  const { createStore } = await import('../src/ui/core/store.mjs');
  const store = createStore(defaultState('demo'));
  store.dispatch({ type: 'SET_REDUCED_MOTION', value: 'on' });
  store.dispatch({ type: 'LOAD_STATE', state: { ...decodeHash('#v=1&c=cipher&s=e5').state, reducedMotion: 'off' } });
  assert.equal(store.get().view.corpus, 'cipher');
  assert.equal(store.get().view.reducedMotion, 'on');
});

test('a link without t= opens paused, in context (fix pass, §1.9): later evidence is ghosted, never hidden', () => {
  const s = decode('#v=1&c=demo&s=e1&sel=occ:4');
  assert.equal(s.vantage.strict, false);
  assert.equal(s.vantage.day, dayFromYMD(1925, 12, 31));
  assert.equal(decode('#v=1&c=demo&s=e1&t=-16072s').vantage.strict, true, 'an explicit strict vantage stays strict');
  assert.doesNotMatch(encode({ ...defaultState('demo'), strands: [{ type: 'expression', id: 1, variants: 'default', glyph: 'circle' }] }), /t=/);
});
