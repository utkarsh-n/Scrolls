// OWNER: WP3 — fit-or-wash binning, cell states and the conservation law (SPEC §1.2, §1.6, §1.7, §11 row 2)
//
// Conservation: Σ bin n + Σ wash n + undated + scheduled = total n, per lane and strand, at every tier, for random
// filters and toggles — checked against an independent plain-JS oracle (tests/aggregate.corpus.mjs), bin by bin,
// together with every denominator.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { binOf, fits, fitsDays, monthBinOfDay } from '../src/shared/dates.mjs';
import { mulberry32 } from '../src/shared/ids.mjs';
import { CELL_STATE_CODES } from '../src/shared/vocab.mjs';
import { materializeInline, trackExpression } from '../server/aggregate/materialize.mjs';
import { buildDef, canonicalRequest, timelineQuery } from '../server/aggregate/query.mjs';
import { laneGate, rateCell, stepClass } from '../server/aggregate/rates.mjs';
import { garwoodCI, griesDP, wilsonCI } from '../server/aggregate/stats.mjs';
import { computeTiles, parseTiles, strandCells } from '../server/aggregate/tiles.mjs';
import { groupWashes, overlappingDocRows } from '../server/aggregate/washes.mjs';
import { laneGatesOf, pendingUnitClasses } from '../server/aggregate/query.mjs';
import { shelfQuery } from '../server/aggregate/shelf.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';
import { assertShape } from './helpers/shape.mjs';
import { buildGeneratedCorpus, oracleCellSampledLanes, oracleCounts, oracleDenominators, oracleGates, randomRequest } from './aggregate.corpus.mjs';

const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

/** Bin of a dated row at a tier, or null when its interval does not fit one bin (the oracle's own rule). */
function oracleBin(tier) {
  const level = TIERS.indexOf(tier);
  if (level <= 3) return (r) => (fits(r.y_lo, r.y_hi, level) ? binOf(r.y_lo, level) : null);
  if (level === 4) return (r) => (fitsDays(r.lo_day, r.hi_day, 4) ? monthBinOfDay(r.lo_day) : null);
  return (r) => (r.lo_day === r.hi_day ? r.lo_day : null);
}

describe('rates, intervals and states (§1.2, §4.6)', () => {
  test('Garwood and Wilson intervals match the contract fixture numbers', () => {
    const [lo, hi] = garwoodCI(14);
    assert.equal(Math.round((lo / 2100) * 1e6 * 10) / 10, 3644.7);
    assert.equal(Math.round((hi / 2100) * 1e6 * 10) / 10, 11185.5);
    assert.equal(Math.round(garwoodCI(0)[1] * 1e4) / 1e4, 3.6889);
    const [wl, wh] = wilsonCI(3, 30);
    assert.ok(wl > 0.034 && wl < 0.035 && wh > 0.256 && wh < 0.257);
    assert.equal(griesDP([5, 5], [100, 100]), 0);
    assert.equal(griesDP([10], [100], 100), 0.5);
    assert.equal(griesDP([], []), null);
  });

  test('a cell has exactly one state; only observed and absent carry a rate', () => {
    const unit = 'per_million_tokens';
    assert.deepEqual(rateCell({ n: 0, denom: 0, unit, gate: 2000 }).state, CELL_STATE_CODES.uncovered);
    assert.deepEqual(rateCell({ n: 0, denom: 0, unit, gate: 2000, pending: true }).state, CELL_STATE_CODES.pending);
    const low = rateCell({ n: 3, denom: 1800, unit, gate: 2000 });
    assert.equal(low.state, CELL_STATE_CODES.low);
    assert.equal(low.rate, null);
    const absent = rateCell({ n: 0, denom: 6200, unit, gate: 2000 });
    assert.equal(absent.state, CELL_STATE_CODES.absent);
    assert.equal(absent.rate, 0);
    assert.equal(Math.round(absent.ci_hi), 595);
    assert.equal(rateCell({ n: 0, denom: 6200, unit, gate: 2000, pending: true }).state, CELL_STATE_CODES.pending);
    const obs = rateCell({ n: 14, denom: 2100, unit, gate: 2000 });
    assert.equal(obs.state, CELL_STATE_CODES.observed);
    assert.equal(Math.round(obs.rate * 10) / 10, 6666.7);
    const works = rateCell({ n: 3, denom: 40, unit: 'per_thousand_works', gate: 30 });
    assert.equal(works.rate, 75);
    assert.ok(works.ci_lo < 75 && works.ci_hi > 75);
  });

  test('coverage gates and step classes', () => {
    assert.equal(laneGate('text', [{ unit: 'tokens', coverage_gate: 2000 }]), 2000);
    assert.equal(laneGate('text', [{ unit: 'tokens', coverage_gate: null }]), 50000);
    assert.equal(laneGate('titles', [{ unit: 'tokens', coverage_gate: 2000 }]), 30, 'a token gate never gates works');
    assert.equal(laneGate('text', [{ unit: 'tokens', coverage_gate: 2000 }, { unit: 'tokens', coverage_gate: null }]), 50000, 'strictest gate');
    assert.deepEqual([0, 600, 10000, 99999, 100000, 1e6].map((n) => stepClass(n, 'tokens')), [0, 1, 2, 2, 3, 4]);
    assert.deepEqual([0, 9, 10, 999, 1000].map((n) => stepClass(n, 'works')), [0, 1, 2, 3, 4]);
  });

  test('tile parameters', () => {
    assert.deepEqual(parseTiles('3'), [3]);
    assert.deepEqual(parseTiles('3,2,3'), [2, 3]);
    assert.deepEqual(parseTiles('-2..1'), [-2, -1, 0, 1]);
    assert.throws(() => parseTiles('a'), /Bad tile/);
    assert.throws(() => parseTiles(''), /tiles is required/);
  });
});

describe('fit-or-wash on the mini corpus (§1.7, D2)', () => {
  let tmp, db, zero, zeroFr;
  before(() => {
    tmp = makeTmpData();
    db = tmp.db;
    zero = trackExpression(db, { surface: 'zero', lang: 'en', corpus: 'test' }).id;
    zeroFr = trackExpression(db, { surface: 'zéro', lang: 'fr', corpus: 'test' }).id;
    materializeInline(db, zero);
    materializeInline(db, zeroFr);
  });
  after(() => tmp.cleanup());

  const defFor = (id, extra = {}) => buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: id }],
    lanes: { facet: 'collection', max: 48 }, ...extra })).def;
  const cellsAt = (def, tier, tiles) => {
    const out = [];
    for (const t of computeTiles(db, def, tier, tiles).tiles) {
      for (const [lane, { strands }] of Object.entries(t.lanes)) for (const cells of Object.values(strands)) {
        for (const c of cells) out.push({ lane, bin: t.bin0 + c[0], n: c[1], denom: c[4], state: c[8] });
      }
    }
    return out;
  };

  test('a decade-precision document is absent from year bins, in its decade bin, and a wash at the year tier', () => {
    const def = defFor(zeroFr);
    // mini:04 'années 1890' (decade, 3 × zéro) fits decade bin 189; mini:05 'vers 1894' (1889–1899, 2 × zéro) fits no decade
    const l2 = cellsAt(def, 'L2', [2]);
    const b189 = l2.find((c) => c.bin === 189);
    assert.equal(b189.n, 3, 'decade doc counted in its decade');
    assert.ok(!l2.some((c) => c.bin === 188 && c.n > 0), 'the circa doc is in no decade bin');
    const l3 = cellsAt(def, 'L3', [29]);
    assert.equal(l3.reduce((s, c) => s + c.n, 0), 0, 'no year bin holds either document');
    const washes = computeTiles(db, def, 'L3', [29]).tiles[0].washes;
    assert.deepEqual(washes.map((w) => [w.label, w.n]).sort(), [['1890s', 3], ['c. 1894', 2]]);
    const l2w = computeTiles(db, def, 'L2', [2]).tiles[0].washes;
    assert.deepEqual(l2w.map((w) => [w.label, w.n]), [['c. 1894', 2]]);
    assert.equal(l2w[0].lo, '1889');
    assert.equal(l2w[0].hi, '1899');
  });

  test('a year-precision item is never placed at 1 January at the day tier (L5)', () => {
    const def = defFor(zero);
    const doc1 = db.prepare("SELECT lo_day FROM document WHERE ext_id = 'mini:01'").get().lo_day;   // 1903, year precision
    const tile = Math.floor(doc1 / 64);
    assert.equal(cellsAt(def, 'L5', [tile]).filter((c) => c.bin === doc1 && c.n > 0).length, 0);
    const w = computeTiles(db, def, 'L5', [tile]).tiles[0].washes;
    assert.ok(w.some((x) => x.label === '1903' && x.owner), 'the 1903 book is a wash at L5');
  });

  test('undated and scheduled items appear only on their shelves', () => {
    const def = defFor(zero, { toggles: { ds: 1 } });
    const tl = timelineQuery(db, { def });
    assert.equal(tl.totals.undated, 1, 'mini:11 summary (describes, undated)');
    assert.equal(tl.totals.scheduled, 1, 'mini:12 title (2090, announced)');
    const und = shelfQuery(db, { def, which: 'undated' });
    assert.equal(und.items.length, 1);
    assert.equal(und.items[0].document_id, db.prepare("SELECT id FROM document WHERE ext_id = 'mini:11'").get().id);
    assertShape('Shelf', und);
    const sch = shelfQuery(db, { def, which: 'scheduled' });
    assert.equal(sch.items[0].date.basis, 'announced');
    assertShape('Shelf', sch);
    for (const tier of TIERS) {
      const level = TIERS.indexOf(tier);
      const range = level <= 3 ? [Math.floor(binOf(1800, level) / 64), Math.floor(binOf(2100, level) / 64)] : null;
      if (!range) continue;
      const tiles = [];
      for (let t = range[0]; t <= range[1]; t++) tiles.push(t);
      const res = computeTiles(db, def, tier, tiles);
      const binned = res.tiles.reduce((s, t) => s + Object.values(t.lanes).reduce((a, l) => a + Object.values(l.strands).flat().reduce((x, c) => x + c[1], 0), 0), 0);
      const washed = res.tiles.reduce((s, t) => s + t.washes.filter((w) => w.owner).reduce((a, w) => a + w.n, 0), 0);
      assert.equal(binned + washed + tl.totals.undated + tl.totals.scheduled, tl.totals.n, `conservation at ${tier}`);
      assert.equal(binned + washed, tl.totals.dated, `${tier}: undated and scheduled never enter bins or washes`);
    }
  });

  test('describes passages count only when the ds toggle is on', () => {
    const off = timelineQuery(db, { def: defFor(zero) }).totals;
    const on = timelineQuery(db, { def: defFor(zero, { toggles: { ds: 1 } }) }).totals;
    assert.equal(on.n - off.n, 1, 'the mini:11 catalogue summary (carrying zeros)');
    assert.equal(off.excluded[String(zero)].describes, 1, 'the exclusion is counted');
  });
});

describe('conservation and denominators against an independent oracle (random filters, every tier)', () => {
  let tmp, db, exprs;
  before(() => {
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    buildGeneratedCorpus(db, { und: true });
    exprs = ['zero', 'zéro', 'शून्य', 'શૂન્ય', '◉', 'carry the zero', 'gene', 'cero'].map((s) => {
      const { id } = trackExpression(db, { surface: s, corpus: 'test' });
      materializeInline(db, id);
      return id;
    });
  });
  after(() => tmp.cleanup());

  test('Σ bins + Σ washes + undated + scheduled = total, per lane and strand, bin by bin (60 random configs × 6 tiers)', () => {
    const rnd = mulberry32(2026);
    const ext = db.prepare("SELECT MIN(y_lo) AS lo, MAX(y_hi) AS hi, MIN(lo_day) AS dlo, MAX(hi_day) AS dhi FROM document WHERE chrono_status = 'dated'").get();
    let checkedBins = 0, checkedLanes = 0;
    const states = new Set();
    for (let k = 0; k < 60; k++) {
      const req = randomRequest(rnd, exprs);
      const { def } = buildDef(db, canonicalRequest(req));
      const tl = timelineQuery(db, { def });
      assertShape('TimelineQuery', { queryKey: 'k', status: 'ready', job: null, ...tl }, `config ${k}`);
      const env = { gates: laneGatesOf(db, def), pending: pendingUnitClasses(db, def) };
      const gates = oracleGates(db, def);
      for (const strand of def.strands) {
        const expected = oracleCounts(db, def, strand);
        // lane totals of the timeline (all lanes are visible: max 48)
        for (const [key, o] of expected) {
          const lane = tl.lanes.find((l) => l.key === key);
          assert.ok(lane, `config ${k}: lane ${key} missing`);
          const s = lane.strands[strand.key];
          assert.equal(s.n, o.total, `config ${k} ${key}: total`);
          assert.equal(s.undated, o.undated, `config ${k} ${key}: undated`);
          assert.equal(s.scheduled, o.scheduled, `config ${k} ${key}: scheduled`);
          checkedLanes++;
        }
        for (const tier of TIERS) {
          const level = TIERS.indexOf(tier);
          const binRow = oracleBin(tier);
          const range = level <= 3 ? { b0: binOf(ext.lo, level), b1: binOf(ext.hi, level) }
            : level === 4 ? { b0: monthBinOfDay(ext.dlo), b1: monthBinOfDay(ext.dhi) } : { b0: ext.dlo, b1: ext.dhi };
          const cells = strandCells(db, def, strand, tier, range, env);
          const washes = groupWashes(def, strand, tier, overlappingDocRows(db, def, strand, tier, range, { onlyUnbinned: level <= 3 }));
          // per bin: numerator equals the oracle
          const expBins = new Map();
          for (const [key, o] of expected) {
            for (const { row, amount } of o.docs.values()) {
              if (row.chrono_status !== 'dated' || amount === 0) continue;
              const b = binRow(row);
              if (b === null) continue;
              expBins.set(`${key}|${b}`, (expBins.get(`${key}|${b}`) ?? 0) + amount);
            }
          }
          for (const [lane, bins] of cells) for (const [bin, c] of bins) {
            assert.equal(c.n, expBins.get(`${lane}|${bin}`) ?? 0, `config ${k} ${tier} ${lane} bin ${bin}: n`);
            checkedBins++;
          }
          for (const [kb, n] of expBins) {
            const [lane, bin] = [kb.slice(0, kb.lastIndexOf('|')), Number(kb.slice(kb.lastIndexOf('|') + 1))];
            assert.equal(cells.get(lane)?.get(bin)?.n, n, `config ${k} ${tier} ${kb}: expected bin missing`);
          }
          // conservation per lane
          for (const [key, o] of expected) {
            const binned = [...(cells.get(key)?.values() ?? [])].reduce((s, c) => s + c.n, 0);
            const washed = washes.filter((w) => w.lane === key).reduce((s, w) => s + w.n, 0);
            assert.equal(binned + washed + o.undated + o.scheduled, o.total, `config ${k} ${tier} ${key}: conservation`);
          }
          // denominators equal doc_tokens sums of the same slice; the state follows n, denom and the lane's gate
          const den = oracleDenominators(db, def, strand.langs, binRow);
          const sampledLanes = oracleCellSampledLanes(db, def);
          for (const [lane, bins] of cells) for (const [bin, c] of bins) {
            assert.equal(c.denom, den.get(`${lane}|${bin}`) ?? 0, `config ${k} ${tier} ${lane} bin ${bin}: denominator`);
            const gate = gates.get(lane);
            const want = c.denom === 0 ? (c.n > 0 ? 3 : 4) : c.denom < gate ? 3 : c.n >= 1 ? 1 : 2;
            assert.equal(c.state, want, `config ${k} ${tier} ${lane} bin ${bin}: state (n ${c.n}, denom ${c.denom}, gate ${gate})`);
            // only observed and absent cells carry a rate — and never in a top-cited-per-cell lane (D14; M5 gate)
            assert.equal(c.rate === null, c.state >= 3 || sampledLanes.has(lane), 'only observed and absent cells carry a rate');
            if (sampledLanes.has(lane) && c.state <= 2) assert.ok(c.flags & 8, 'a cell-sampled count is flagged sampled');
            states.add(c.state);
          }
          for (const [kb, d] of den) {
            const [lane, bin] = [kb.slice(0, kb.lastIndexOf('|')), Number(kb.slice(kb.lastIndexOf('|') + 1))];
            assert.equal(cells.get(lane)?.get(bin)?.denom, d, `config ${k} ${tier} ${kb}: a covered bin has a cell`);
          }
        }
      }
    }
    assert.ok(checkedBins > 1000, `checked ${checkedBins} bins`);
    assert.ok(checkedLanes > 100, `checked ${checkedLanes} lanes`);
    assert.ok(checkedBins > 3000, `checked ${checkedBins} bins`);
    assert.deepEqual([...states].sort(), [1, 2, 3], 'observed, absent and low cells all occur');
  });

  test("while a collection is still indexing, 'looked and found none' becomes 'pending'", () => {
    // a word the corpus never uses: every well-covered bin is 'looked and found none'
    const never = trackExpression(db, { surface: 'qzxv', lang: 'en', corpus: 'test' }).id;
    materializeInline(db, never);
    const { def } = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: never }], lanes: { facet: 'collection', max: 48 } }));
    const range = { b0: binOf(1800, 3), b1: binOf(2030, 3) };
    const before = strandCells(db, def, def.strands[0], 'L3', range, { gates: laneGatesOf(db, def), pending: pendingUnitClasses(db, def) });
    const absent = [...before.get('collection:gen-text').values()].filter((c) => c.state === CELL_STATE_CODES.absent);
    assert.ok(absent.length > 0, 'the fixture has absent bins');
    const coll = db.prepare("SELECT id FROM collection WHERE slug = 'gen-text'").get().id;
    const b = db.prepare(`INSERT INTO import_batch (collection_id, adapter_id, adapter_version, format, status, created_at)
      VALUES (?, 'file.jsonl', '1', 'jsonl', 'committing', '2026-10-04T00:00:00Z')`).run(coll);
    try {
      assert.deepEqual([...pendingUnitClasses(db, def)], ['text']);
      const during = strandCells(db, def, def.strands[0], 'L3', range, { gates: laneGatesOf(db, def), pending: pendingUnitClasses(db, def) });
      for (const [bin, c] of before.get('collection:gen-text')) {
        const d = during.get('collection:gen-text').get(bin);
        if (c.state === CELL_STATE_CODES.absent) {
          assert.equal(d.state, CELL_STATE_CODES.pending);
          assert.equal(d.rate, null);
        } else assert.equal(d.state, c.state, 'observed and low bins keep their state');
      }
      const lane = timelineQuery(db, { def }).lanes.find((l) => l.key === 'collection:gen-text');
      assert.equal(lane.state, 'pending');
      assert.equal(lane.note, 'indexing — not yet looked');
    } finally {
      db.prepare('DELETE FROM import_batch WHERE id = ?').run(Number(b.lastInsertRowid));
    }
  });

  test('tiles: every wash is owned by exactly one tile, and owners conserve at L0–L4', () => {
    const rnd = mulberry32(7);
    const ext = db.prepare("SELECT MIN(y_lo) AS lo, MAX(y_hi) AS hi, MIN(lo_day) AS dlo, MAX(hi_day) AS dhi FROM document WHERE chrono_status = 'dated'").get();
    for (let k = 0; k < 8; k++) {
      const { def } = buildDef(db, canonicalRequest(randomRequest(rnd, exprs)));
      const tl = timelineQuery(db, { def });
      for (const tier of ['L0', 'L1', 'L2', 'L3', 'L4']) {
        const level = TIERS.indexOf(tier);
        const [b0, b1] = level <= 3 ? [binOf(ext.lo, level), binOf(ext.hi, level)] : [monthBinOfDay(ext.dlo), monthBinOfDay(ext.dhi)];
        const tiles = [];
        for (let t = Math.floor(b0 / 64); t <= Math.floor(b1 / 64); t++) tiles.push(t);
        const res = computeTiles(db, def, tier, tiles);
        assertShape('Tiles', { queryKey: 'k', dataVersion: 1, ...res }, `config ${k} ${tier}`);
        const owners = new Map();
        for (const t of res.tiles) for (const w of t.washes) if (w.owner) owners.set(w.key, (owners.get(w.key) ?? 0) + 1);
        assert.ok([...owners.values()].every((n) => n === 1), 'one owner per wash');
        const keys = new Set(res.tiles.flatMap((t) => t.washes.map((w) => w.key)));
        assert.equal(owners.size, keys.size, 'every listed wash has its owner tile among the tiles');
        let sum = 0;
        for (const t of res.tiles) {
          for (const l of Object.values(t.lanes)) for (const cells of Object.values(l.strands)) for (const c of cells) sum += c[1];
          for (const w of t.washes) if (w.owner) sum += w.n;
        }
        assert.equal(sum + tl.totals.undated + tl.totals.scheduled, tl.totals.n, `config ${k} ${tier}: tiles conserve`);
      }
    }
  });
});
