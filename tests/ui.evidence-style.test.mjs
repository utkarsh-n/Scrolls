// OWNER: WP0 — the evidence encoding (§8.7, D7): status by pattern + endpoint + word, review as overlay, hue never alone
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeStyle, binStyle, LEGEND_ROWS, BADGES } from '../src/shared/evidence-style.mjs';
import {
  EVIDENCE_STATUS, REVIEW_STATUS, PROVENANCE_QUALITY, REL_FAMILIES, REL_TYPES, FAMILY_HUE, CELL_FLAGS, CELL_STATES, LANE_ORDER_NOTE,
} from '../src/shared/vocab.mjs';

const triple = (s) => JSON.stringify([s.dash, s.endpoint, s.badge]);
const withoutHue = ({ hue, ...rest }) => JSON.stringify(rest);

function* combos(family) {
  for (const evidence_status of EVIDENCE_STATUS)
    for (const review_status of REVIEW_STATUS)
      for (const provenance_quality of PROVENANCE_QUALITY)
        for (const cue of [false, true])
          for (const is_synthetic of [false, true])
            for (const date_conflict of [false, true])
              for (const origin of ['source_dataset', 'algorithm', 'machine_tagger', 'human'])
                yield { evidence_status, review_status, provenance_quality, cue, is_synthetic, date_conflict, origin, family };
}

test('the three evidence statuses have three distinct (dash, endpoint, badge) triples', () => {
  const doc = edgeStyle({ evidence_status: 'documented', family: 'citation' });
  const calc = edgeStyle({ evidence_status: 'computed', family: 'citation' });
  const prop = edgeStyle({ evidence_status: 'proposed', family: 'citation' });
  assert.deepEqual([doc.dash, doc.endpoint, doc.badge], [[], 'dot', 'DOC']);
  assert.deepEqual([calc.dash, calc.endpoint, calc.badge], [[6, 4], 'square', 'CALC']);
  assert.deepEqual([prop.dash, prop.endpoint, prop.badge], [[1, 3], 'question', 'PROP']);
  assert.equal(new Set([triple(doc), triple(calc), triple(prop)]).size, 3);
  assert.equal(new Set([JSON.stringify(doc.dash), JSON.stringify(calc.dash), JSON.stringify(prop.dash)]).size, 3, 'patterns alone differ');
  for (const s of [doc, calc, prop]) assert.equal(s.width, 1.5);
});

test('every status keeps its line under every overlay (review never changes the pattern)', () => {
  for (const family of REL_FAMILIES) {
    for (const c of combos(family)) {
      const s = edgeStyle(c);
      const base = edgeStyle({ evidence_status: c.evidence_status, family });
      assert.deepEqual(s.dash, base.dash);
      assert.equal(s.endpoint, base.endpoint);
      assert.equal(s.width, base.width);
      assert.ok(s.badge.startsWith({ documented: 'DOC', computed: 'CALC', proposed: 'PROP' }[c.evidence_status]), s.badge);
    }
  }
  const rej = edgeStyle({ evidence_status: 'computed', review_status: 'rejected', family: 'quotation' });
  assert.deepEqual([rej.overlay, rej.strike, rej.opacity], ['cross', true, 0.3]);
  assert.equal(edgeStyle({ evidence_status: 'proposed', review_status: 'confirmed' }).overlay, 'check');
  assert.equal(edgeStyle({ evidence_status: 'proposed', review_status: 'disputed' }).overlay, 'scales');
  assert.equal(edgeStyle({ evidence_status: 'proposed' }).overlay, null);
});

test('DOC*, PROP · CUE, ✎, ⚠ and SYN are words or glyphs, not colours', () => {
  assert.equal(edgeStyle({ evidence_status: 'documented', provenance_quality: 'source_unrecorded' }).badge, 'DOC*');
  assert.equal(edgeStyle({ evidence_status: 'computed', provenance_quality: 'source_unrecorded' }).badge, 'CALC');
  assert.equal(edgeStyle({ evidence_status: 'proposed', cue: true }).badge, 'PROP · CUE');
  assert.equal(edgeStyle({ evidence_status: 'documented', cue: true }).badge, 'DOC');
  const conflict = edgeStyle({ evidence_status: 'documented', date_conflict: true, family: 'citation' });
  assert.equal(conflict.badge, 'DOC ⚠');
  assert.equal(conflict.hue, 'danger');
  assert.equal(conflict.conflict, true);
  assert.equal(edgeStyle({ evidence_status: 'proposed', origin: 'human' }).human, true);
  assert.equal(edgeStyle({ evidence_status: 'documented', is_synthetic: 1 }).synthetic, true);
  for (const c of combos('quotation')) {
    const b = edgeStyle(c).badge.replace(/ ⚠$/, '');
    assert.ok(BADGES[b], `badge ${b} is in BADGES`);
  }
});

test('no two styles differ only in hue', () => {
  for (const family of REL_FAMILIES) {
    const byShape = new Map();
    for (const c of combos(family)) {
      const s = edgeStyle(c);
      const key = withoutHue(s);
      if (byShape.has(key)) assert.equal(byShape.get(key), s.hue, `${family}: ${key} drawn in two hues`);
      else byShape.set(key, s.hue);
    }
  }
  // across families the hue differs by role; the rel_type glyph and label always back it with text
  for (const a of REL_TYPES) {
    for (const b of REL_TYPES) {
      if (a === b || FAMILY_HUE[a.family] === FAMILY_HUE[b.family]) continue;
      assert.ok(a.glyph !== b.glyph || a.label !== b.label, `${a.code} vs ${b.code}`);
      assert.notEqual(a.label, b.label, `${a.code} vs ${b.code} labels`);
    }
  }
  for (const f of REL_FAMILIES) assert.ok(['amber', 'violet', 'ivory2'].includes(FAMILY_HUE[f]), f);
});

test('unknown statuses are refused, never guessed', () => {
  assert.throws(() => edgeStyle({ evidence_status: 'observed' }), TypeError);
  assert.throws(() => edgeStyle({}), TypeError);
  assert.throws(() => edgeStyle({ evidence_status: 'documented', review_status: 'approved' }), TypeError);
  assert.throws(() => binStyle({ state: 9 }), TypeError);
  assert.throws(() => binStyle({ state: 'missing' }), TypeError);
});

test('bin states: absent ≠ low ≠ uncovered ≠ pending, and flags add marks, not colours', () => {
  const look = (s) => JSON.stringify([s.mark, s.pattern, s.outline, s.opacity]);
  const states = Object.values(CELL_STATES).map((name) => binStyle({ state: name }));
  assert.equal(new Set(states.map(look)).size, 5, 'five distinguishable states');
  for (const [code, name] of Object.entries(CELL_STATES)) assert.deepEqual(binStyle({ state: Number(code) }), binStyle({ state: name }));
  assert.equal(binStyle({ state: 'observed' }).mark, 'rect');
  assert.equal(binStyle({ state: 'absent' }).mark, 'baseline');
  assert.equal(binStyle({ state: 'low' }).mark, 'tick');
  assert.equal(binStyle({ state: 'uncovered' }).pattern, 'hatch');
  assert.equal(binStyle({ state: 'pending' }).pattern, 'dots');
  const solid = binStyle({ state: 1, flags: 0 });
  const sparse = binStyle({ state: 1, flags: CELL_FLAGS.sparse });
  assert.deepEqual([solid.opacity, solid.outline], [0.88, null]);
  assert.deepEqual([sparse.opacity, sparse.outline], [0.25, 'ink']);
  assert.equal(binStyle({ state: 1, flags: CELL_FLAGS.single_source }).superscript, '¹');
  const est = binStyle({ state: 1, flags: CELL_FLAGS.estimated_majority | CELL_FLAGS.synthetic });
  assert.deepEqual([est.pattern, est.glyph, est.synthetic], ['stripes', '≈', true]);
  const syn = binStyle({ state: 1, flags: CELL_FLAGS.synthetic });
  assert.deepEqual([syn.pattern, syn.synthetic], ['syn', true]);
  for (const s of states) assert.ok(s.fill === null || s.fill === 'ink', 'bars and marks are ivory; hue is reserved for roles');
});

test('the legend names every status, overlay, bin state and role, drawn by the same functions', () => {
  const keys = new Set(LEGEND_ROWS.map((r) => r.key));
  for (const k of [...EVIDENCE_STATUS, 'documented_unrecorded', 'proposed_cue', 'confirmed', 'rejected', 'disputed', 'human',
    'date_conflict', 'synthetic', ...Object.values(CELL_STATES), 'sparse', 'single_source', 'estimated', 'amber', 'violet', 'ivory2',
    'cyan', 'lane_order']) {
    assert.ok(keys.has(k), `legend row ${k}`);
  }
  for (const r of LEGEND_ROWS) {
    assert.ok(r.label.length > 3, r.key);
    if (r.group === 'evidence' || r.group === 'overlay') assert.ok(r.style.badge && r.style.dash, r.key);
  }
  assert.equal(LEGEND_ROWS.find((r) => r.key === 'lane_order').label, LANE_ORDER_NOTE);
  assert.deepEqual(LEGEND_ROWS.find((r) => r.key === 'computed').style, edgeStyle({ evidence_status: 'computed', family: 'quotation' }));
});
