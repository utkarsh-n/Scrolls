// OWNER: WP3 — very frequent expressions (SPEC §4.6): counts stay complete, contexts become a stratified sample
// of ≤ N per (passage language, decade) flagged sampled, and every view says so. Thresholds are lowered here so
// the small generated corpus crosses them.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { binOf } from '../src/shared/dates.mjs';
import { normString } from '../src/shared/tokenize.mjs';
import { CELL_FLAGS } from '../src/shared/vocab.mjs';
import { binQuery } from '../server/aggregate/bin.mjs';
import { marksQuery } from '../server/aggregate/marks.mjs';
import { materializeInline, trackExpression } from '../server/aggregate/materialize.mjs';
import { buildDef, canonicalRequest, timelineQuery } from '../server/aggregate/query.mjs';
import { computeTiles } from '../server/aggregate/tiles.mjs';
import { kwicQuery, passageBase } from '../server/text/kwic.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';
import { assertShape } from './helpers/shape.mjs';
import { buildGeneratedCorpus } from './aggregate.corpus.mjs';

let tmp, db;
before(() => {
  tmp = makeTmpData({ seed: false });
  db = tmp.db;
  buildGeneratedCorpus(db, { seed: 13 });
});
after(() => tmp.cleanup());

const lanesN = (tl) => Object.fromEntries(tl.lanes.map((l) => [l.key, l.n]));
const groupsOf = (runId) => db.prepare(`SELECT p.lang || '|' || CASE d.chrono_status WHEN 'dated' THEN CAST(d.y_lo / 10 AS INTEGER) ELSE d.chrono_status END AS g,
    count(*) AS n, min(o.sampled) AS smin, max(o.sampled) AS smax
  FROM occurrence o JOIN passage p ON p.id = o.passage_id JOIN document d ON d.id = o.document_id WHERE o.run_id = ? GROUP BY g`).all(runId);

function defOf(id) {
  return buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: id }], lanes: { facet: 'collection', max: 48 } })).def;
}

function allTiles(def, tier) {
  const ext = db.prepare("SELECT MIN(y_lo) AS lo, MAX(y_hi) AS hi FROM document WHERE chrono_status = 'dated'").get();
  const level = ['L0', 'L1', 'L2', 'L3'].indexOf(tier);
  const list = [];
  for (let t = Math.floor(binOf(ext.lo, level) / 64); t <= Math.floor(binOf(ext.hi, level) / 64); t++) list.push(t);
  return computeTiles(db, def, tier, list);
}

describe('very frequent phrases: exact counts, sampled contexts', () => {
  test('a phrase past the cap keeps every count and a stratified sample of contexts', () => {
    const exact = trackExpression(db, { surface: 'carry the zero', lang: 'en', corpus: 'test' }).id;
    const r0 = materializeInline(db, exact);
    assert.equal(r0.sampled, false);
    const tlExact = timelineQuery(db, { def: defOf(exact) });
    // the same expression counted again with lowered thresholds (a fresh run of the same expression)
    const r1 = materializeInline(db, exact, { sampleAbove: 50, samplePerGroup: 5 });
    assert.equal(r1.sampled, true);
    assert.equal(r1.mode, 'exact');
    assert.equal(r1.counted, r0.counted, 'counts are complete');
    const def = defOf(exact);
    assert.equal(def.strands[0].run, r1.run);
    assert.equal(def.strands[0].sampled, true);
    const tl = timelineQuery(db, { def });
    assert.deepEqual(lanesN(tl), lanesN(tlExact), 'every lane total is unchanged');
    assert.equal(tl.totals.sampled, true);
    assert.match(tl.sampling_note, /stratified sample/);
    for (const g of groupsOf(r1.run)) assert.ok(g.n <= 5, `group ${g.g}: ${g.n} contexts`);
    assert.ok(groupsOf(r1.run).some((g) => g.smax === 1), 'cut groups are flagged sampled');
    // the stored contexts are real, exact matches
    for (const o of db.prepare(`SELECT o.*, v.norm, p.field FROM occurrence o JOIN expression_variant v ON v.id = o.variant_id
      JOIN passage p ON p.id = o.passage_id WHERE o.run_id = ?`).all(r1.run)) {
      assert.equal(normString(passageBase(db, { document_id: o.document_id, field: o.field }).slice(o.start_off, o.end_off)), o.norm);
    }
    const tiles = allTiles(def, 'L2');
    let sum = 0, flagged = 0;
    for (const t of tiles.tiles) for (const l of Object.values(t.lanes)) for (const cells of Object.values(l.strands)) {
      for (const c of cells) { sum += c[1]; if (c[1] > 0) { assert.ok(c[9] & CELL_FLAGS.sampled); flagged++; } }
    }
    for (const t of tiles.tiles) for (const w of t.washes) if (w.owner) sum += w.n;
    assert.ok(flagged > 0);
    const marks = marksQuery(db, { def });
    assertShape('Marks', marks);
    assert.equal(marks.total, sum, 'marks total is the complete dated count');
    assert.equal(marks.sampled, true);
    assert.ok(marks.marks.length < marks.total);
    const kw = kwicQuery(db, { def, limit: 5 });
    assert.equal(kw.sampled.of, tl.totals.n);
    assert.ok(kw.sampled.contexts < kw.sampled.of);
    const cell = tiles.tiles.flatMap((t) => Object.entries(t.lanes).flatMap(([lane, l]) => Object.values(l.strands).flat()
      .map((c) => ({ lane, bin: t.bin0 + c[0], n: c[1] })))).sort((a, b) => b.n - a.n)[0];
    const drawer = binQuery(db, { def, lane: cell.lane, tier: 'L2', bin: cell.bin });
    assert.equal(drawer.denominator.n, cell.n);
    assert.match(drawer.denominator.text, /contexts sampled: \d+ of \d+ in this bin/);
    assert.equal(drawer.denominator.sampled.of, cell.n);
  });
});

describe('very frequent single words: counted from the search index', () => {
  test('per-passage counts equal the FTS instances; the run says counts include accent variants', () => {
    const id = trackExpression(db, { surface: 'zero', lang: 'en', corpus: 'test' }).id;
    const r = materializeInline(db, id, { sampleAbove: 100, samplePerGroup: 5 });
    assert.equal(r.mode, 'fts-index');
    assert.equal(r.sampled, true);
    const metrics = JSON.parse(db.prepare('SELECT metrics_json FROM analysis_run WHERE id = ?').get(r.run).metrics_json);
    assert.equal(metrics.counts_include_accent_variants, true);
    assert.match(metrics.name_guard, /not applied/);
    // expr_doc per (document, language, class) = Σ passage_vocab_inst over the document's 'ok' passages of those
    const inst = new Map(db.prepare(`SELECT p.document_id AS doc, p.lang, p.field_class, count(*) AS n FROM passage_vocab_inst i
      JOIN passage p ON p.id = i.doc WHERE i.term IN ('zero', 'zeros', 'zeroes', 'zeroed', 'zeroing') AND p.quality = 'ok'
      GROUP BY p.document_id, p.lang, p.field_class`).all().map((x) => [`${x.doc}|${x.lang}|${x.field_class}`, x.n]));
    const rows = db.prepare('SELECT document_id, plang, field_class, n FROM expr_doc WHERE run_id = ?').all(r.run);
    assert.ok(rows.length > 50);
    // the possessive ('zero s') is counted by the instances of its first word, exactly once
    for (const x of rows) assert.equal(x.n, inst.get(`${x.document_id}|${x.plang}|${x.field_class}`), `document ${x.document_id}`);
    assert.equal(rows.length, inst.size, 'every passage the index holds is counted');
    const tl = timelineQuery(db, { def: defOf(id) });
    assert.match(tl.sampling_note, /accent variants/);
    for (const g of groupsOf(r.run)) assert.ok(g.n <= 5);
    assert.ok(db.prepare('SELECT count(*) AS n FROM occurrence WHERE run_id = ? AND sampled = 0').get(r.run).n === 0);
  });
});
