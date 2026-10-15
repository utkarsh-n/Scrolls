// OWNER: WP3 — contract 1.3.0 property tests: the Term trail (C2), OpenAlex share cells (C3), context-group lanes (C1),
// the arcs summary (C4), deduplicated etymology roots (C5) and the virtual corpus `real`.
//
// Every document here is SYNTHETIC (two synthetic test corpora, authors "(synthetic)"): invented text never lives in a
// real corpus, so the multi-corpus properties compose the two synthetic corpora through buildDef's `scope` option — the
// same code path `real` takes for its members.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { binOf, fits } from '../src/shared/dates.mjs';
import { mulberry32 } from '../src/shared/ids.mjs';
import { decode, encode } from '../src/shared/viewstate.mjs';
import { STEMM_LANES, TRAIL_LANES } from '../src/shared/vocab.mjs';
import { nowIso } from '../server/db/open.mjs';
import { createBatch, createDocumentWriter, ensureCollection } from '../server/store/document-writer.mjs';
import { arcsQuery } from '../server/aggregate/arcs.mjs';
import { materializeInline, trackExpression } from '../server/aggregate/materialize.mjs';
import { buildDef, canonicalRequest, strandDocRows, strandLangSpec, timelineQuery } from '../server/aggregate/query.mjs';
import { computeTiles } from '../server/aggregate/tiles.mjs';
import { shareCells } from '../server/aggregate/trail.mjs';
import { binQuery } from '../server/aggregate/bin.mjs';
import { realMembers, resolveCorpusScope } from '../server/aggregate/scope.mjs';
import { exportQuery } from '../server/export/manifest.mjs';
import { totalsText } from '../src/shared/format.mjs';
import { dedupeRoots } from '../server/routes/etymology.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';
import { assertShape } from './helpers/shape.mjs';

const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4'];
const OA_FIELDS = [['Mathematics', 'mathematics'], ['Medicine', 'medicine-health'], ['Nursing', 'medicine-health'],
  ['Agricultural and Biological Sciences', 'life-sciences']];
const OA_BINS = [[1850, 1874], [1900, 1904], [1950, 1954], [2000, 2004], [2020, 2024]];
const WORDS = ['the', 'of', 'ledger', 'column', 'clerk', 'number', 'place', 'count', 'house', 'tray', 'margin', 'page', 'office'];
const DATES = ['1851', '1866', '1903', '1958-03-14', 'June 1963', '1890s', 'c. 1920', 'early 20th century', '1910–1915', '1994-05-17',
  '2003', '', 'n.d.', '2031', '1999-12-31', '1777', '1920'];

let tmp, db, ids;

function corpusRow(slug) {
  db.prepare(`INSERT INTO corpus (slug, name, kind, is_synthetic, description, license, created_at)
    VALUES (?, ?, 'synthetic', 1, 'Invented test documents', 'CC0 (synthetic)', ?) ON CONFLICT(slug) DO NOTHING`).run(slug, `Test ${slug} (synthetic)`, nowIso());
  return db.prepare('SELECT id FROM corpus WHERE slug = ?').get(slug).id;
}

function write(corpus, spec, docs) {
  const coll = ensureCollection(db, { ...spec, corpus, adapter_id: 'file.jsonl', selection_note: 'invented test documents' });
  const batchId = createBatch(db, { collection: coll.id, format: 'jsonl', fileName: `${spec.slug}.jsonl` });
  const w = createDocumentWriter(db, { batchId, collection: coll.slug, corpus, options: { now: new Date('2026-10-04T12:00:00Z') } });
  for (let i = 0; i < docs.length; i++) w.addDocument(docs[i], { line: i + 1 });
  return w.finish();
}

function text(rnd, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(rnd() < 0.1 ? (rnd() < 0.7 ? 'zero' : 'zeros') : WORDS[Math.floor(rnd() * WORDS.length)]);
  return `${out.join(' ')}.`;
}

function textDocs(rnd, prefix, count, { field = null } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    ext_id: `${prefix}${i}`, kind: 'book', title: `Invented text ${prefix}${i}`, author: `Author ${i % 7} (synthetic)`, lang_declared: 'en',
    ...(field ? { field: typeof field === 'function' ? field(i) : field } : {}),
    text: { original: `${text(rnd, 40)}\n\n${text(rnd, 35)}\n`, decoder: 'utf-8' },
    dates: [{ role: 'publication', raw: DATES[Math.floor(rnd() * DATES.length)], asserted_by: 'fixture:trail', is_chronology: true }],
    original_meta: { generated: true, i },
  }));
}

function titleDocs(rnd, prefix, count) {
  return Array.from({ length: count }, (_, i) => ({
    ext_id: `${prefix}${i}`, kind: rnd() < 0.5 ? 'film' : 'song', title: rnd() < 0.3 ? `Zero ${i}` : `Night Ledger ${i}`,
    author: `Maker ${i % 5} (synthetic)`, fields: { title: rnd() < 0.3 ? `Zero ${i}` : `Night Ledger ${i}` },
    dates: [{ role: 'publication', raw: rnd() < 0.08 ? '' : rnd() < 0.05 ? '2031' : String(1940 + Math.floor(rnd() * 85)), asserted_by: 'fixture:trail', is_chronology: true }],
    original_meta: { generated: true, i },
  }));
}

/** OpenAlex-like sampled works: cells (OpenAlex field × one of its bins), some with ≥ 20 works and some with fewer. */
function sampledWorks(rnd) {
  const out = [];
  let i = 0;
  for (const [oaField, field] of OA_FIELDS) {
    for (const [lo, hi] of OA_BINS) {
      const n = (oaField.length + lo) % 3 === 0 ? 12 : 26;
      for (let k = 0; k < n; k++, i++) {
        const year = lo + Math.floor(rnd() * (hi - lo + 1));
        const mention = rnd() < 0.3;
        out.push({
          ext_id: `oa:${i}`, kind: 'paper', title: mention ? `Zero order effects ${i}` : `Ledger methods ${i}`, author: `Paper Author ${i} (synthetic)`,
          field, lang_declared: 'en',
          fields: { title: mention ? `Zero order effects ${i}` : `Ledger methods ${i}`, abstract: text(rnd, 30) }, field_roles: { abstract: 'document' },
          dates: [{ role: 'publication', raw: String(year), asserted_by: 'fixture:trail', is_chronology: true }],
          original_meta: { generated: true, i, sample_cell: `${oaField}|${lo}-${hi}` },
        });
      }
    }
  }
  return out;
}

before(() => {
  tmp = makeTmpData({ seed: false });
  db = tmp.db;
  const rnd = mulberry32(1303);
  const a = corpusRow('trail-a'), b = corpusRow('trail-b');
  const spec = (slug, extra) => ({ slug, name: `${slug} (synthetic)`, unit: 'tokens', sampling: 'curated', coverage_gate: 200, ...extra });
  write('trail-a', spec('ta-lit', { domain: 'literature', modality: 'text' }), textDocs(rnd, 'ta:l', 60));
  write('trail-a', spec('ta-stemm', { domain: 'stemm', modality: 'text' }), textDocs(rnd, 'ta:s', 50,
    { field: (i) => STEMM_LANES[i % STEMM_LANES.length].key }));
  write('trail-a', spec('ta-oa', { domain: 'stemm', modality: 'abstracts', unit: 'works', sampling: 'top_cited_per_cell', coverage_gate: 20,
    export_text_allowed: 0 }), sampledWorks(rnd));
  write('trail-a', spec('ta-titles', { domain: 'culture', modality: 'titles', unit: 'works', sampling: 'prominence_selected', coverage_gate: 5 }),
    titleDocs(rnd, 'ta:w', 80));
  write('trail-a', spec('ta-ends', { domain: 'culture', modality: 'titles', unit: 'works', sampling: 'relation_endpoints', rate_eligible: 0 }),
    titleDocs(rnd, 'ta:e', 30));
  write('trail-a', spec('ta-imported', { domain: 'imported', modality: 'text', sampling: 'user' }), textDocs(rnd, 'ta:i', 15));
  write('trail-b', spec('tb-lit', { domain: 'literature', modality: 'text' }), textDocs(rnd, 'tb:l', 40));
  write('trail-b', spec('tb-stemm', { domain: 'stemm', modality: 'text' }), textDocs(rnd, 'tb:s', 30, { field: 'mathematics' }));
  write('trail-b', spec('tb-titles', { domain: 'culture', modality: 'titles', unit: 'works', sampling: 'prominence_selected', coverage_gate: 5 }),
    titleDocs(rnd, 'tb:w', 50));
  const ea = trackExpression(db, { surface: 'zero', lang: 'en', corpus: 'trail-a' }).id;
  const eb = trackExpression(db, { surface: 'zero', lang: 'en', corpus: 'trail-b' }).id;
  ids = { a, b, ea, eb, runA: materializeInline(db, ea).run, runB: materializeInline(db, eb).run };
});
after(() => tmp.cleanup());

const request = (corpus, ref, facet = 'trail', extra = {}) =>
  canonicalRequest({ corpus, strands: [{ type: 'expression', ref }], lanes: { facet, max: 48 }, ...extra });
/** A virtual scope over both synthetic corpora — the members `real` would have. */
const virtualScope = () => ({ slug: 'real', name: 'both test corpora', virtual: true, synthetic: true, ids: [ids.a, ids.b],
  members: [{ id: ids.a, slug: 'trail-a', name: 'a' }, { id: ids.b, slug: 'trail-b', name: 'b' }] });
const queryOf = (def) => ({ queryKey: 'k', status: 'ready', job: null, ...timelineQuery(db, { def }) });

/** Every tile of a tier that holds a dated document of the fixture. */
function allTiles(tier) {
  const ext = db.prepare("SELECT MIN(y_lo) AS lo, MAX(y_hi) AS hi, MIN(lo_day) AS dlo, MAX(hi_day) AS dhi FROM document WHERE chrono_status = 'dated'").get();
  const level = TIERS.indexOf(tier);
  const [b0, b1] = level <= 3 ? [binOf(ext.lo, level), binOf(ext.hi, level)] : [ext.lo * 12, ext.hi * 12 + 11];
  const out = [];
  for (let t = Math.floor(b0 / 64); t <= Math.floor(b1 / 64); t++) out.push(t);
  return out;
}

/** Σ bins + Σ owned washes per lane × strand at a tier, and Σ owned share-cell k per lane × strand. */
function tileSums(def, tier) {
  const r = computeTiles(db, def, tier, allTiles(tier));
  assertShape('Tiles', { queryKey: 'k', tier, binWidth: r.binWidth, dataVersion: 1, tiles: r.tiles });
  const bins = new Map(), cells = new Map();
  const add = (m, k, n) => m.set(k, (m.get(k) ?? 0) + n);
  for (const tile of r.tiles) {
    for (const [lane, v] of Object.entries(tile.lanes)) for (const [s, list] of Object.entries(v.strands)) for (const c of list) add(bins, `${lane}|${s}`, c[1]);
    for (const w of tile.washes) if (w.owner) add(bins, `${w.lane}|${w.strand}`, w.n);
    for (const [lane, m] of Object.entries(tile.cells ?? {})) for (const [s, list] of Object.entries(m)) for (const c of list) if (c.owner) add(cells, `${lane}|${s}`, c.k);
  }
  return { bins, cells };
}

describe('the virtual corpus real', () => {
  test('never includes the demo or a synthetic corpus, and is empty (400) without a real corpus holding documents', () => {
    assert.deepEqual(realMembers(db), [], 'only synthetic corpora and empty real ones here');
    assert.throws(() => resolveCorpusScope(db, 'real'), (e) => e.status === 400 && /No real corpus/.test(e.message));
    assert.equal(resolveCorpusScope(db, 'trail-a').virtual, false);
  });

  test('viewstate accepts c=real and opens it on the Term trail', () => {
    const s = decode('#v=1&c=real&s=e7');
    assert.equal(s.corpus, 'real');
    assert.equal(s.lanes.facet, 'trail');
    assert.match(encode(s), /c=real/);
  });
});

describe('Term trail lanes (C2)', () => {
  test('the fixed lane set in its order, one unit each, and what falls outside every lane', () => {
    const { def } = buildDef(db, request('trail-a', ids.ea));
    const q = queryOf(def);
    assertShape('TimelineQuery', q);
    const order = TRAIL_LANES.map((l) => l.key);
    const keys = q.lanes.map((l) => l.key);
    assert.deepEqual(keys, [...keys].sort((x, y) => order.indexOf(x) - order.indexOf(y)), 'fixed order');
    assert.equal(q.other.lanes, 0, 'no lane folds away');
    for (const l of q.lanes) assert.equal(l.unit, TRAIL_LANES.find((t) => t.key === l.key).unit, l.key);
    assert.ok(keys.includes('trail:etymology') && keys.includes('trail:literature-text') && keys.includes('trail:culture-titles'));
    assert.ok(keys.includes('trail:music-relations'), 'relation endpoints are a lane (works mode)');
    assert.equal(q.lanes.find((l) => l.key === 'trail:music-relations').mode, 'works');
    assert.ok(q.trail.absent.every((x) => !keys.includes(x.key)));
    assert.ok(q.trail.outside[String(ids.ea)] > 0, 'the imported collection is outside every trail lane and counted');
    // lanes partition the strand's counted matches inside the trail
    const s = String(ids.ea);
    assert.equal(q.lanes.reduce((acc, l) => acc + (l.strands[s]?.n ?? 0), 0), q.totals.n);
  });

  test('conservation per trail lane at every tier: Σ bins + Σ washes (+ Σ share-cell k) + undated + scheduled = lane total', () => {
    for (const [corpus, ref] of [['trail-a', ids.ea], ['trail-b', ids.eb]]) {
      const { def } = buildDef(db, request(corpus, ref));
      const q = queryOf(def);
      const s = String(ref);
      for (const tier of TIERS) {
        const { bins, cells } = tileSums(def, tier);
        for (const l of q.lanes) {
          const st = l.strands[s];
          if (!st) continue;
          const placed = l.unit === 'share_of_sampled_works' ? (cells.get(`${l.key}|${s}`) ?? 0) : (bins.get(`${l.key}|${s}`) ?? 0);
          assert.equal(placed + st.undated + st.scheduled, st.n, `${corpus} ${tier} ${l.key}`);
        }
      }
    }
  });

  test('a lane of the virtual scope counts exactly the sum of its member corpora counted alone (lanes, bins, washes, cells)', () => {
    const { def: v } = buildDef(db, request('real', ids.ea), { scope: virtualScope() });
    assert.equal(v.strands[0].members.length, 2, 'one member per corpus');
    const qv = queryOf(v);
    const qa = queryOf(buildDef(db, request('trail-a', ids.ea)).def), qb = queryOf(buildDef(db, request('trail-b', ids.eb)).def);
    const n = (q, key, s) => q.lanes.find((l) => l.key === key)?.strands[s]?.n ?? 0;
    for (const l of qv.lanes) {
      assert.equal(l.strands[String(ids.ea)]?.n ?? 0, n(qa, l.key, String(ids.ea)) + n(qb, l.key, String(ids.eb)), l.key);
    }
    assert.ok(qv.lanes.find((l) => l.key === 'trail:literature-text').strands[String(ids.ea)].n > n(qa, 'trail:literature-text', String(ids.ea)));
    for (const tier of ['L2', 'L3']) {
      const tv = tileSums(v, tier), ta = tileSums(buildDef(db, request('trail-a', ids.ea)).def, tier), tb = tileSums(buildDef(db, request('trail-b', ids.eb)).def, tier);
      for (const [k, val] of tv.bins) {
        const lane = k.slice(0, k.lastIndexOf('|'));
        assert.equal(val, (ta.bins.get(`${lane}|${ids.ea}`) ?? 0) + (tb.bins.get(`${lane}|${ids.eb}`) ?? 0), `${tier} ${lane}`);
      }
    }
    assert.deepEqual(qv.provenance.corpora, ['trail-a', 'trail-b'], 'the provenance lists the member corpora');
    assert.equal(qv.provenance.run_ids.materialize[ids.ea], ids.runA);
    assert.equal(qv.provenance.run_ids.materialize[ids.eb], ids.runB);
  });
});

describe('OpenAlex share cells (C3)', () => {
  test('k ≤ n, Wilson CI brackets the share, low cells (n < 20) carry no share, and Σ k = the lane\'s works', () => {
    const { def } = buildDef(db, request('trail-a', ids.ea));
    const strand = def.strands[0];
    const rows = strandDocRows(db, def, strand);
    const { cells, outside } = shareCells(db, def, strand, rows, strandLangSpec(strand));
    const q = queryOf(def);
    let low = 0, shown = 0;
    for (const [lane, list] of cells) {
      assert.ok(lane.startsWith('trail:stemm-abstracts:'));
      for (const c of list) {
        assertShape('ShareCell', c);
        assert.ok(c.k <= c.n && c.n <= c.n_cell);
        if (c.n < 20) { low++; assert.equal(c.share, null); assert.equal(c.ci, null); assert.equal(c.state, c.n ? 'low' : 'uncovered'); } else {
          shown++;
          assert.ok(c.ci[0] <= c.share && c.share <= c.ci[1] && c.ci[0] >= 0 && c.ci[1] <= 1);
          assert.equal(c.state, c.k ? 'observed' : 'absent');
        }
      }
      const lanes = q.lanes.find((l) => l.key === lane);
      assert.equal(list.reduce((acc, c) => acc + c.k, 0) + (outside.get(lane) ?? 0), lanes.strands[String(ids.ea)]?.n ?? 0, lane);
      assert.ok(lanes.cell_fields.length >= 1);
      assert.match(lanes.header, /not a trend/);
    }
    assert.ok(low > 0 && shown > 0, `fixture has both low (${low}) and shown (${shown}) cells`);
    // Medicine and Nursing share one STEMM lane but stay separate cells: never pooled
    const med = cells.get('trail:stemm-abstracts:medicine-health');
    assert.ok(med.some((c) => c.field === 'Medicine') && med.some((c) => c.field === 'Nursing'));
  });

  test('a share cell opens its drawer: the cell\'s numbers, then the works that mention the strand', () => {
    const { def } = buildDef(db, request('trail-a', ids.ea));
    const cell = 'Mathematics|1900-1904';
    const r = binQuery(db, { def, lane: 'trail:stemm-abstracts:mathematics', cell });
    assertShape('BinDrawer', r);
    assert.equal(r.denominator.cell, cell);
    assert.equal(new Set(r.rows.map((x) => x.doc ?? x.document_id)).size, r.denominator.k);
  });
});

describe('Term trail totals per unit (fix pass, C2)', () => {
  test('matches and works are reported apart and never shown as one sum', () => {
    const { def } = buildDef(db, request('trail-a', ids.ea));
    const q = queryOf(def);
    const s = String(ids.ea);
    const by = { matches: 0, works: 0 };
    for (const l of q.lanes) by[['titles', 'cells'].includes(l.unit === 'share_of_sampled_works' ? 'cells' : l.modality) ? 'works' : 'matches'] += l.strands[s]?.n ?? 0;
    assert.deepEqual(q.totals.by_unit, by, 'per unit, from the lanes');
    assert.equal(q.totals.units_mixed, true);
    assert.equal(q.totals.by_unit.matches + q.totals.by_unit.works, q.totals.n);
    assert.equal(totalsText(q.totals), `${by.matches.toLocaleString('en-US')} matches · ${by.works.toLocaleString('en-US')} works`);
    const plain = queryOf(buildDef(db, request('trail-a', ids.ea, 'language')).def);
    assert.equal(totalsText({ ...plain.totals, units_mixed: false, by_unit: { matches: plain.totals.n, works: 0 } }), `${plain.totals.n.toLocaleString('en-US')} matches`);
  });
});

describe('one n per OpenAlex cell (fix pass, C3)', () => {
  test('Compare’s within-cell shares and the Scroll’s share cells count the same k of the same n', async () => {
    const { compareQuery } = await import('../server/analysis/compare.mjs');
    const { def } = buildDef(db, request('trail-a', ids.ea));
    const strand = def.strands[0];
    const { cells } = shareCells(db, def, strand, strandDocRows(db, def, strand), strandLangSpec(strand));
    const byCell = new Map();
    for (const list of cells.values()) for (const c of list) byCell.set(c.cell, c);
    let compared = 0;
    for (const [lo, hi] of OA_BINS) {
      const p = compareQuery(db, { expr: [ids.ea], a: { years: [lo, hi], f: 'coll:ta-oa' }, b: { years: [2020, 2024], f: 'coll:ta-oa' } });
      for (const c of p.within_cell?.a ?? []) {
        const s = byCell.get(c.cell);
        if (!s) continue;
        assert.deepEqual([c.k, c.n], [s.k, s.n], `${c.cell}: Compare and the Scroll agree`);
        compared++;
      }
    }
    assert.ok(compared > 0, 'cells were compared');
  });
});

describe('exports of a Term trail (fix pass)', () => {
  test('the aggregates export carries every lane, OpenAlex share cells included, and conserves per lane at L0–L3', () => {
    const state = { v: 1, corpus: 'trail-a', strands: [{ type: 'expression', id: ids.ea }], lanes: { facet: 'trail', order: 'first_observed', max: 18 } };
    const b64 = Buffer.from(JSON.stringify(state)).toString('base64url');
    const { def } = buildDef(db, request('trail-a', ids.ea));
    const q = queryOf(def);
    const s = String(ids.ea);
    const shareLanes = q.lanes.filter((l) => l.unit === 'share_of_sampled_works' && (l.strands[s]?.n ?? 0) > 0);
    assert.ok(shareLanes.length, 'the fixture has OpenAlex lanes with matches');
    for (const tier of ['L0', 'L1', 'L2', 'L3']) {
      const res = exportQuery(db, { state: b64, what: 'aggregates', format: 'json', tier });
      const { manifest, rows } = JSON.parse(res.body);
      const sum = new Map();
      for (const r of rows) if (r.strand === s) sum.set(r.lane, (sum.get(r.lane) ?? 0) + r.n);
      for (const l of q.lanes) {
        const n = l.strands[s]?.n ?? 0;
        if (n > 0) assert.equal(sum.get(l.key) ?? 0, n, `${tier} ${l.key}: the export conserves the lane total`);
      }
      const cells = rows.filter((r) => r.kind === 'share_cell');
      assert.ok(cells.length > 0, `${tier}: share cells are exported`);
      for (const c of cells) {
        assert.equal(c.unit, 'share_of_sampled_works');
        assert.ok(c.field, 'each share cell names its field');
        if (c.denom < 20) assert.ok(c.rate === null && c.ci_lo === null && c.ci_hi === null, 'no share below n = 20');
        else assert.ok(c.rate !== null || c.state === 'uncovered');
      }
      assert.match(manifest.share_cells_note, /never compare shares across cells/);
    }
  });
});

describe('context-group lanes (C1)', () => {
  let def, groupIds;
  before(() => {
    // a synthetic clustering run over the expression's occurrences: two groups, one residual group, some ungrouped
    const now = nowIso();
    const run = Number(db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json, input_fingerprint,
        data_version, representation, seed, tokenizer_version, segmenter_version, icu_version, status, gate_json, metrics_json, job_id, started_at, finished_at)
      VALUES ('cluster', 'cluster@test', 'x', ?, 'h', ?, 'f', 1, 'tfidf-hash-4096', 1, 'u61m-1', 'seg-1', '0', 'succeeded', ?, '{}', 0, ?, ?)`)
      .run(JSON.stringify({ expr: ids.ea, materialize: ids.runA }), JSON.stringify({ expression: ids.ea }), JSON.stringify({ cluster: { gate: 'ok' } }), now, now).lastInsertRowid);
    const mk = (ord, status) => Number(db.prepare(`INSERT INTO sense_cluster (run_id, expression_id, ord, label_auto, distinctive_json, size, n_docs,
      top_doc_share, stability, status) VALUES (?, ?, ?, ?, '[]', 0, 0, 0, 0.9, ?)`).run(run, ids.ea, ord, `machine label: test group ${ord}`, status).lastInsertRowid);
    groupIds = [mk(1, 'hypothesis'), mk(2, 'unstable'), mk(3, 'residual')];
    const occ = db.prepare('SELECT id FROM occurrence WHERE expression_id = ? AND run_id = ? ORDER BY id').all(ids.ea, ids.runA);
    const ins = db.prepare('INSERT INTO cluster_member (cluster_id, occurrence_id, cos, margin) VALUES (?, ?, 0.5, 0.1)');
    occ.forEach((o, i) => { if (i % 5 !== 4) ins.run(groupIds[i % 3], o.id); });
    def = buildDef(db, request('trail-a', ids.ea, 'cluster')).def;
  });

  test('one lane per group plus residual; they partition the counted matches; group rates share the slice denominators', () => {
    const q = queryOf(def);
    assertShape('TimelineQuery', q);
    assert.equal(q.lane_state, 'ok');
    const keys = q.lanes.map((l) => l.key);
    const run = def.cluster.run;
    assert.ok(keys.includes(`cluster:${run}:1`) && keys.includes(`cluster:${run}:2`) && keys.includes(`cluster:${run}:residual`));
    assert.ok(!keys.includes(`cluster:${run}:3`), 'a residual group folds into the residual lane');
    const l1 = q.lanes.find((l) => l.key === `cluster:${run}:1`);
    assert.deepEqual(l1.label, { machine: 'machine label: test group 1', human: null });
    assert.equal(q.lanes.find((l) => l.key === `cluster:${run}:2`).tentative, true);
    const plain = queryOf(buildDef(db, request('trail-a', ids.ea, 'modality')).def);
    const s = String(ids.ea);
    assert.equal(q.lanes.reduce((acc, l) => acc + (l.strands[s]?.n ?? 0), 0), plain.totals.n, 'lanes partition the strand');
    for (const tier of TIERS) {
      const { bins } = tileSums(def, tier);
      for (const l of q.lanes) {
        const st = l.strands[s];
        if (st) assert.equal((bins.get(`${l.key}|${s}`) ?? 0) + st.undated + st.scheduled, st.n, `${tier} ${l.key}`);
      }
    }
    // the same slice denominators as the expression's modality slice
    const tg = computeTiles(db, def, 'L2', allTiles('L2')), tm = computeTiles(db, buildDef(db, request('trail-a', ids.ea, 'modality')).def, 'L2', allTiles('L2'));
    for (let i = 0; i < tg.tiles.length; i++) {
      const den = new Map((tm.tiles[i].lanes['modality:text']?.strands[s] ?? []).map((c) => [c[0], c[4]]));
      for (const c of tg.tiles[i].lanes[`cluster:${run}:1`]?.strands[s] ?? []) if (den.has(c[0])) assert.equal(c[4], den.get(c[0]));
    }
  });

  test('not_run without a run (with the run to start), gated with the gate and no lanes', () => {
    const other = trackExpression(db, { surface: 'ledger', lang: 'en', corpus: 'trail-a' }).id;
    materializeInline(db, other);
    const q = queryOf(buildDef(db, request('trail-a', other, 'cluster')).def);
    assertShape('TimelineQuery', q);
    assert.equal(q.lane_state, 'not_run');
    assert.deepEqual(q.suggestion, { run: { stage: 'cluster', params: { expressionId: other } } });
    assert.equal(q.lanes.length, 0);
    const now = nowIso();
    db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json, input_fingerprint, data_version,
        tokenizer_version, segmenter_version, icu_version, status, gate_json, started_at, finished_at)
      VALUES ('cluster', 'cluster@test', 'x', '{}', 'h2', ?, 'f', 1, 'u61m-1', 'seg-1', '0', 'succeeded', ?, ?, ?)`)
      .run(JSON.stringify({ expression: other }), JSON.stringify({ cluster: { gate: 'insufficient_occurrences', needed: { occurrences: 60 }, have: { occurrences: 3 } } }), now, now);
    const g = queryOf(buildDef(db, request('trail-a', other, 'cluster')).def);
    assertShape('TimelineQuery', g);
    assert.equal(g.lane_state, 'gated');
    assert.equal(g.gate.gate, 'insufficient_occurrences');
    assert.equal(g.gate.value, null);
    assert.equal(g.lanes.length, 0);
  });
});

describe('arcs summary (C4)', () => {
  test('above the threshold: buckets add up to the total by evidence status; ≤ 300 individual arcs, the selection first', () => {
    const { def } = buildDef(db, request('trail-a', ids.ea, 'collection'));
    const docs = db.prepare(`SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id JOIN expr_doc x ON x.document_id = d.id
      AND x.expression_id = ? AND x.run_id = ? WHERE c.slug = 'ta-lit' AND d.chrono_status = 'dated' GROUP BY d.id ORDER BY d.id`).all(ids.ea, ids.runA).map((r) => r.id);
    const statuses = [['documented', 'source_dataset'], ['proposed', 'human']];
    for (let i = 0; i + 1 < docs.length; i++) {
      const [status, origin] = statuses[i % 2];
      const r = db.prepare(`INSERT INTO relationship (rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin, source_dataset,
          source_locator, created_by, is_synthetic, created_at) VALUES ('explicit_citation', 'document', ?, 'document', ?, 1, ?, ?, ?, ?, ?, 1, ?)`)
        .run(String(docs[i + 1]), String(docs[i]), status, origin, origin === 'source_dataset' ? 'demo-records' : null,
          origin === 'source_dataset' ? 'record:x' : null, origin === 'human' ? 'human:tester' : 'adapter:test', nowIso());
      db.prepare(`INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, after_json) VALUES (?, 1, 'test', ?, 'create', '{}')`)
        .run(Number(r.lastInsertRowid), nowIso());
    }
    const plain = arcsQuery(db, { def, tier: 'L2' });
    assert.equal(plain.mode, 'individual');
    assert.ok(plain.total >= 10, `fixture arcs: ${plain.total}`);
    const sel = `document:${docs[3]}`;
    const r = arcsQuery(db, { def, tier: 'L2', summary_above: 5, sel });
    assertShape('Arcs', r);
    assert.equal(r.mode, 'summary');
    assert.equal(r.total, plain.total);
    assert.equal(r.buckets.reduce((acc, b) => acc + b.n, 0), r.total, 'Σ bucket n = total');
    for (const b of r.buckets) assert.equal(b.by_status.documented + b.by_status.computed + b.by_status.proposed, b.n);
    assert.ok(r.individual.length <= 300 && r.individual.length === Math.min(300, r.total));
    const touching = r.individual.filter((a) => a.selected).length;
    assert.ok(touching >= 1, 'arcs touching the selection are kept');
    assert.ok(r.individual.slice(0, touching).every((a) => a.selected), 'the selection first');
    const rest = r.individual.slice(touching);
    assert.ok(rest.every((a, i) => i === 0 || !(rest[i - 1].evidence_status === 'proposed' && a.evidence_status === 'documented')), 'documented first');
    const detail = arcsQuery(db, { def, tier: 'L2', summary_above: 5, from: 1850, to: 1890, detail: true });
    assert.equal(detail.mode, 'individual', 'detail over < 50 years');
  });

  test('with the lanes the Scroll shows, arcs between shown lanes come first; nothing else changes (final gate)', () => {
    const { def } = buildDef(db, request('trail-a', ids.ea, 'collection'));
    const strandDocsOf = (slug) => db.prepare(`SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id JOIN expr_doc x
      ON x.document_id = d.id AND x.expression_id = ? AND x.run_id = ? WHERE c.slug = ? AND d.chrono_status = 'dated' GROUP BY d.id ORDER BY d.id`)
      .all(ids.ea, ids.runA, slug).map((r) => r.id);
    const lit = strandDocsOf('ta-lit'), stemm = strandDocsOf('ta-stemm');
    assert.ok(stemm.length >= 3, 'fixture: dated strand documents in a second lane');
    // documented links from the STEMM lane into the literature lane (the proposed in-lane links of the test above stay)
    for (let i = 0; i < 3; i++) {
      const r = db.prepare(`INSERT INTO relationship (rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin, source_dataset,
          source_locator, created_by, is_synthetic, created_at) VALUES ('explicit_citation', 'document', ?, 'document', ?, 1, 'documented', 'source_dataset',
          'demo-records', 'record:y', 'adapter:test', 1, ?)`).run(String(stemm[i]), String(lit[i]), nowIso());
      db.prepare(`INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, after_json) VALUES (?, 1, 'test', ?, 'create', '{}')`)
        .run(Number(r.lastInsertRowid), nowIso());
    }
    const plain = arcsQuery(db, { def, tier: 'L2', summary_above: 5 });
    const litLane = plain.individual.find((a) => a.src.doc !== undefined && lit.includes(a.dst.doc) && lit.includes(a.src.doc))?.src.lane;
    assert.ok(litLane, 'an arc inside the literature lane');
    const inLane = (a) => a.src.lane === litLane && a.dst.lane === litLane;
    assert.ok(plain.individual.some((a) => !inLane(a) && a.evidence_status === 'documented'), 'documented cross-lane arcs exist');
    const shown = arcsQuery(db, { def, tier: 'L2', summary_above: 5, lanes: litLane });
    assertShape('Arcs', shown);
    assert.equal(shown.total, plain.total, 'the same arcs are counted');
    assert.deepEqual(shown.buckets, plain.buckets, 'buckets do not depend on the lanes shown');
    const firstOff = shown.individual.findIndex((a) => !inLane(a));
    assert.ok(firstOff > 0 && shown.individual.slice(firstOff).every((a) => !inLane(a)), 'arcs between shown lanes first');
    assert.deepEqual(arcsQuery(db, { def, tier: 'L2', summary_above: 5, lanes: null }).individual.map((a) => a.rel_id), plain.individual.map((a) => a.rel_id),
      'without lanes the order is unchanged');
  });
});

describe('etymology roots (C5)', () => {
  test('a root listed by two etyma is listed once, with both families', () => {
    const root = (key) => ({ key, lang: 'ine-pro', form: key, roman: null, gloss: null, kind: 'root' });
    const families = [
      { key: 'la:virus', lang: 'la', form: 'virus', parents: [root('*weys-'), root('*dʰewb-')] },
      { key: 'ine-pro:*wisós', lang: 'ine-pro', form: '*wisós', parents: [root('*weys-'), root('*dʰewbʰ-')] },
    ];
    const roots = dedupeRoots(families);
    assert.deepEqual(roots.map((r) => r.key), ['*weys-', '*dʰewb-', '*dʰewbʰ-']);
    assert.deepEqual(roots[0].families, ['la:virus', 'ine-pro:*wisós']);
    assert.equal(families[0].parents[0].shared, true);
    assert.equal(families[0].parents[1].shared, undefined);
    assert.ok(roots.every((r) => r.is_family === false));
  });
});

test('fits() sanity for the fixture dates (washes exist at fine tiers)', () => {
  const rows = db.prepare("SELECT y_lo, y_hi FROM document WHERE chrono_status = 'dated'").all();
  assert.ok(rows.some((r) => !fits(r.y_lo, r.y_hi, 3)), 'some documents do not fit a year');
});
