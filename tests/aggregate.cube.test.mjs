// OWNER: WP3 — the slice cube and the shared, persisted artifacts (M1 gate performance fix): every expression-
// independent aggregate computed from the cube equals the reference SQL of SPEC §3.2 under random filters, toggles,
// facets and tiers; the cube is built once, persisted under <data>/cache, survives a materialization and follows an
// import; the tag index answers like a plain substring scan.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fitsDays, LEVELS } from '../src/shared/dates.mjs';
import { mulberry32 } from '../src/shared/ids.mjs';
import { clearSharedArtifacts, sharedArtifact } from '../server/aggregate/cache.mjs';
import {
  corpusInputsKey, cubeCoverage, cubeDenominators, cubeGateRows, cubeLastTextYear, cubeRangeTotals, decodeCube, encodeCube, readyCube,
  SMALL_CUBE_ROWS, sliceCube,
} from '../server/aggregate/cube.mjs';
import { facetSql, laneKey, rowCols, unitSql } from '../server/aggregate/lanes.mjs';
import { materializeInline, trackExpression } from '../server/aggregate/materialize.mjs';
import { buildDef, canonicalRequest, laneWhere, sliceWhere, unionLanguages } from '../server/aggregate/query.mjs';
import { binOfDay } from '../server/aggregate/washes.mjs';
import { buildLabelIndex, findLabels, foldLabel, labelIndex, labelsForRef, peekLabelIndex } from '../server/aggregate/tagindex.mjs';
import { loadMini, makeTmpData } from './helpers/tmpdata.mjs';
import { buildGeneratedCorpus, randomRequest } from './aggregate.corpus.mjs';

const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

// ── the reference SQL the cube replaced (§3.2) ──────────────────────────────────────────────────────

function sqlDenominators(db, def, langs, tier) {
  const level = TIERS.indexOf(tier);
  const cols = rowCols('t');
  const slice = sliceWhere(def, cols, langs);
  const out = new Map();
  if (level <= 3) {
    for (const r of db.prepare(`SELECT ${facetSql(def.lanes.facet, cols)} AS lv, ${unitSql(cols)} AS uc, b.bin AS bin,
        SUM(t.tokens) AS tokens, COUNT(DISTINCT t.document_id) AS docs, MAX(d.is_synthetic) AS syn, MAX(d.is_translation) AS tr
      FROM doc_tokens t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
      JOIN doc_bin b ON b.document_id = d.id AND b.level = ?
      WHERE ${slice.sql} GROUP BY lv, uc, b.bin`).all(level, ...slice.params)) {
      out.set(`${laneKey(def.lanes.facet, r.lv, r.uc)}|${r.bin}`, { tokens: r.tokens, docs: r.docs, syn: r.syn, tr: r.tr });
    }
    return out;
  }
  for (const r of db.prepare(`SELECT ${facetSql(def.lanes.facet, cols)} AS lv, ${unitSql(cols)} AS uc, t.document_id AS doc,
      SUM(t.tokens) AS tokens, d.lo_day, d.hi_day, d.y_lo, d.is_synthetic AS syn, d.is_translation AS tr
    FROM doc_tokens t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
    WHERE ${slice.sql} AND d.chrono_status = 'dated' AND d.hi_day - d.lo_day <= 30 GROUP BY lv, uc, t.document_id`).all(...slice.params)) {
    if (!fitsDays(r.lo_day, r.hi_day, level)) continue;
    const k = `${laneKey(def.lanes.facet, r.lv, r.uc)}|${binOfDay(r.lo_day, r.y_lo, tier)}`;
    const cur = out.get(k) ?? { tokens: 0, docs: 0, syn: 0, tr: 0 };
    out.set(k, { tokens: cur.tokens + r.tokens, docs: cur.docs + 1, syn: Math.max(cur.syn, r.syn), tr: Math.max(cur.tr, r.tr) });
  }
  return out;
}

function sqlCoverage(db, def, langs) {
  const cols = rowCols('t');
  const slice = sliceWhere(def, cols, langs);
  return db.prepare(`SELECT ${facetSql(def.lanes.facet, cols)} AS lv, ${unitSql(cols)} AS uc, SUM(t.tokens) AS tokens,
      COUNT(DISTINCT t.document_id) AS docs, MIN(CASE WHEN d.chrono_status = 'dated' THEN d.y_lo END) AS span_lo,
      MAX(CASE WHEN d.chrono_status = 'dated' THEN d.y_hi END) AS span_hi,
      MIN(b.bin) AS bin_lo, MAX(b.bin) AS bin_hi, MAX(d.is_synthetic) AS syn, GROUP_CONCAT(DISTINCT c.sampling) AS samplings,
      SUM(CASE WHEN d.chrono_status <> 'dated' THEN t.tokens ELSE 0 END) AS outside_tokens
    FROM doc_tokens t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
    LEFT JOIN doc_bin b ON b.document_id = d.id AND b.level = 2
    WHERE ${slice.sql} GROUP BY lv, uc`).all(...slice.params)
    .map((r) => ({ ...r, samplings: String(r.samplings ?? '').split(',').filter(Boolean).sort().join(',') }));
}

function sqlGateRows(db, def) {
  const cols = rowCols('t');
  const slice = sliceWhere(def, cols, null);
  // c.sampling (M5 gate): a top-cited-per-cell lane shows counts without rates (query.laneGatesOf cellSampled)
  return db.prepare(`SELECT ${facetSql(def.lanes.facet, cols)} AS lv, ${unitSql(cols)} AS uc, c.unit, c.coverage_gate, c.sampling
    FROM doc_tokens t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
    WHERE ${slice.sql} GROUP BY lv, uc, c.id`).all(...slice.params).map((r) => ({ ...r }));
}

function sqlLastText(db, corpusId, langs) {
  // RF-1: an unidentified text row is in the languages only when its document's language is one of them or unidentified
  const inLangs = langs ? `AND 2 * (SELECT COALESCE(SUM(u.tokens), 0) FROM doc_tokens u WHERE u.document_id = d.id AND u.field_class = 'text'
      AND u.plang IN (SELECT value FROM json_each(?1)) AND (u.plang NOT IN ('und', 'und-Latn') OR d.lang_text IS NULL
        OR d.lang_text IN ('und', 'und-Latn') OR d.lang_text IN (SELECT value FROM json_each(?1))))
      > (SELECT SUM(v.tokens) FROM doc_tokens v WHERE v.document_id = d.id AND v.field_class = 'text')` : '';
  return db.prepare(`SELECT MAX(d.y_hi) AS last FROM doc_tokens t JOIN document d ON d.id = t.document_id
    JOIN collection c ON c.id = d.collection_id
    WHERE c.corpus_id = ?2 AND c.rate_eligible = 1 AND d.deleted_at IS NULL AND d.chrono_status = 'dated'
      AND t.field_class = 'text' AND t.tokens > 0 ${inLangs}`).get(langs ? JSON.stringify(langs) : null, corpusId).last;
}

function sqlRangeTotals(db, def, langs, { from = null, to = null, lane = null }) {
  const cols = rowCols('t');
  const slice = sliceWhere(def, cols, langs);
  const where = [slice.sql], params = [...slice.params];
  if (from !== null || to !== null) where.push("d.chrono_status = 'dated'");
  if (from !== null) { where.push('d.y_hi >= ?'); params.push(from); }
  if (to !== null) { where.push('d.y_lo <= ?'); params.push(to); }
  if (lane) { const lw = laneWhere(def, lane, cols); where.push(lw.sql); params.push(...lw.params); }
  const r = db.prepare(`SELECT COALESCE(SUM(CASE WHEN t.field_class <> 'title' THEN t.tokens ELSE 0 END), 0) AS tokens,
      COUNT(DISTINCT CASE WHEN t.field_class = 'title' THEN t.document_id END) AS works, COUNT(DISTINCT t.document_id) AS docs
    FROM doc_tokens t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
    WHERE ${where.join(' AND ')}`).get(...params);
  return { tokens: r.tokens, works: r.works, docs: r.docs };
}

const sortRows = (rows) => rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();

describe('the slice cube equals the reference SQL (random filters, toggles, facets, every tier)', () => {
  let tmp, db, exprs;
  before(() => {
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    buildGeneratedCorpus(db, { seed: 11, und: true });
    exprs = ['zero', 'zéro', 'शून्य', 'carry the zero', 'cero'].map((s) => {
      const { id } = trackExpression(db, { surface: s, corpus: 'test' });
      materializeInline(db, id);
      return id;
    });
  });
  after(() => tmp.cleanup());

  test('denominators, coverage, lane-gate rows, concordance totals and the last text year (40 configs)', () => {
    const rnd = mulberry32(99);
    let bins = 0;
    for (let k = 0; k < 40; k++) {
      const { def } = buildDef(db, canonicalRequest(randomRequest(rnd, exprs)));
      const cube = sliceCube(db, def.corpusId);
      const langs = unionLanguages(def.strands);
      assert.deepEqual(sortRows(cubeCoverage(cube, def, langs)), sortRows(sqlCoverage(db, def, langs)), `config ${k}: coverage`);
      assert.deepEqual(sortRows(cubeGateRows(cube, def)), sortRows(sqlGateRows(db, def)), `config ${k}: gate rows`);
      for (const strand of def.strands) {
        for (const tier of TIERS) {
          const want = sqlDenominators(db, def, strand.langs, tier);
          const got = cubeDenominators(cube, def, strand.langs, tier);
          assert.equal(got.size, want.size, `config ${k} ${tier}: number of covered bins`);
          for (const [key, w] of want) {
            const g = got.get(key);
            assert.ok(g, `config ${k} ${tier} ${key}: bin missing`);
            assert.deepEqual({ tokens: g.tokens, docs: g.docs, syn: g.syn, tr: g.tr }, w, `config ${k} ${tier} ${key}`);
            bins++;
          }
        }
      }
      for (const strand of def.strands) {
        const lanes = sqlCoverage(db, def, strand.langs).map((r) => laneKey(def.lanes.facet, r.lv, r.uc));
        for (const range of [{}, { from: 1900, to: 1999 }, { from: 1990 }, { to: 1850 }, { from: 1903, to: 1903, lane: lanes[0] ?? null },
          { lane: lanes[lanes.length - 1] ?? null }]) {
          assert.deepEqual(cubeRangeTotals(cube, def, strand.langs, range), sqlRangeTotals(db, def, strand.langs, range),
            `config ${k}: range totals ${JSON.stringify(range)}`);
        }
      }
      for (const langs2 of [null, ['en', 'und', 'und-Latn'], ['es', 'und', 'und-Latn'], ['hi', 'und'], ['fr'], ['und']]) {
        assert.equal(cubeLastTextYear(cube, langs2), sqlLastText(db, def.corpusId, langs2), `config ${k}: last text year ${langs2}`);
      }
    }
    assert.ok(bins > 2000, `checked ${bins} bins`);
  });

  test('levels L0–L3 use the doc_bin rule (fit-or-wash) exactly', () => {
    const cube = sliceCube(db, buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: exprs[0] }] })).def.corpusId);
    const { ylo, yhi, cs, doc } = cube.cols;
    const binned = new Set(db.prepare('SELECT document_id || \':\' || level || \':\' || bin AS k FROM doc_bin').all().map((r) => r.k));
    for (let r = 0; r < cube.n; r++) {
      for (let level = 0; level <= 3; level++) {
        const w = LEVELS[level].width;
        const fits = cs[r] === 0 && Math.floor(ylo[r] / w) === Math.floor(yhi[r] / w);
        assert.equal(binned.has(`${doc[r]}:${level}:${Math.floor(ylo[r] / w)}`), fits, `doc ${doc[r]} level ${level}`);
      }
    }
  });
});

describe('shared artifacts: built once, persisted, keyed by what they read', () => {
  let tmp, db, corpusId, expr;
  before(() => {
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    buildGeneratedCorpus(db, { seed: 5, texts: 60, titles: 40, abstracts: 10 });
    corpusId = db.prepare("SELECT id FROM corpus WHERE slug = 'test'").get().id;
    expr = trackExpression(db, { surface: 'zero', lang: 'en', corpus: 'test' }).id;
  });
  after(() => tmp.cleanup());

  const cubeFiles = () => readdirSync(path.join(tmp.dir, 'cache')).filter((f) => f.startsWith('cube'));

  test('the cube is written to <data>/cache, reloaded from it, and round-trips its columns', () => {
    clearSharedArtifacts();
    const built = sliceCube(db, corpusId);
    assert.equal(cubeFiles().length, 1);
    clearSharedArtifacts();
    const loaded = sliceCube(db, corpusId);
    assert.notEqual(loaded, built, 'read back from the file, not from memory');
    assert.equal(loaded.n, built.n);
    for (const [k, arr] of Object.entries(built.cols)) assert.deepEqual([...loaded.cols[k]], [...arr], k);
    assert.deepEqual(loaded.dicts, built.dicts);
    const again = decodeCube(Buffer.from(encodeCube(built)));
    assert.deepEqual([...again.cols.tokens], [...built.cols.tokens]);
    assert.throws(() => decodeCube(Buffer.from('not a cube')), /slice cube/);
  });

  test('a materialization bumps the data version but keeps the cube; an import replaces it (and prunes the old file)', () => {
    clearSharedArtifacts();
    const before1 = sliceCube(db, corpusId);
    const key1 = corpusInputsKey(db, corpusId);
    const dv = db.prepare("SELECT value FROM meta WHERE key = 'data_version'").get().value;
    materializeInline(db, expr);
    assert.notEqual(db.prepare("SELECT value FROM meta WHERE key = 'data_version'").get().value, dv);
    assert.equal(corpusInputsKey(db, corpusId), key1);
    assert.equal(sliceCube(db, corpusId), before1, 'same inputs: the same cube');
    loadMini(db, { slug: 'cube-later', docs: [{ ext_id: 'cube:1', kind: 'book', title: 'Later (synthetic)', lang_declared: 'en',
      text: { original: 'A zero in a later ledger, then another zero.', decoder: 'utf-8' },
      dates: [{ role: 'publication', raw: '1931', asserted_by: 'test', is_chronology: true }], original_meta: { test: true } }] });
    assert.notEqual(corpusInputsKey(db, corpusId), key1);
    const after1 = sliceCube(db, corpusId);
    assert.notEqual(after1, before1);
    assert.ok(after1.n > before1.n, 'the imported document adds rows');
    assert.equal(cubeFiles().length, 1, 'the file of the older inputs is pruned');
  });

  test('readyCube: a small database builds its cube on demand; a ready cube is read without building', () => {
    clearSharedArtifacts();
    assert.ok(db.prepare('SELECT count(*) AS n FROM doc_tokens').get().n <= SMALL_CUBE_ROWS);
    const a = readyCube(db, corpusId);
    assert.ok(a && a.n > 0);
    assert.equal(readyCube(db, corpusId), a, 'from memory');
  });

  test('a corrupt cache file is discarded and rebuilt', () => {
    clearSharedArtifacts();
    const built = sliceCube(db, corpusId);
    const file = path.join(tmp.dir, 'cache', cubeFiles()[0]);
    writeFileSync(file, 'garbage');
    clearSharedArtifacts();
    const rebuilt = sliceCube(db, corpusId);
    assert.equal(rebuilt.n, built.n);
    assert.deepEqual(decodeCube(readFileSync(file)).n, built.n, 'the file is written again');
  });

  test('locks: a stale lock (terminated worker) is taken over; a fresh one is waited for (bounded), then the value is built', () => {
    const dir = path.join(tmp.dir, 'cache');
    let builds = 0;
    const spec = (waitMs) => ({ name: 'probe', build: () => ({ at: ++builds }), encode: (v) => Buffer.from(JSON.stringify(v)),
      decode: (b) => JSON.parse(b.toString('utf8')), waitMs });
    clearSharedArtifacts();
    assert.equal(sharedArtifact(db, spec(50)).at, 1);
    const files = () => readdirSync(dir).filter((f) => f.startsWith('probe-') && f.endsWith('.bin'));
    assert.equal(files().length, 1);
    const lockFile = path.join(dir, `${files()[0].replace(/-[^-]+\.bin$/, '')}.lock`);
    for (const f of files()) unlinkSync(path.join(dir, f));

    writeFileSync(lockFile, '');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockFile, old, old);
    clearSharedArtifacts();
    assert.equal(sharedArtifact(db, spec(50)).at, 2, 'built at once despite the stale lock');
    assert.equal(files().length, 1, 'and shared');
    assert.ok(!existsSync(lockFile), 'the lock is released');
    for (const f of files()) unlinkSync(path.join(dir, f));

    writeFileSync(lockFile, '');   // another worker is building right now
    clearSharedArtifacts();
    const t0 = Date.now();
    assert.equal(sharedArtifact(db, spec(100)).at, 3);
    assert.ok(Date.now() - t0 >= 90, 'waited for the other builder first');
    assert.ok(existsSync(lockFile), "another worker's lock is left alone");
    assert.equal(files().length, 1, 'a finished build is written even without the lock (atomic rename)');
    unlinkSync(lockFile);
  });
});

describe('warming', () => {
  test('warmQuery builds and persists the cube, the label indexes and the maker-name index of each corpus', async () => {
    const { warmQuery } = await import('../server/aggregate/warm.mjs');
    const t = makeTmpData({ seed: false });
    try {
      buildGeneratedCorpus(t.db, { seed: 4, texts: 30, titles: 30, abstracts: 5 });
      const corpusId = t.db.prepare("SELECT id FROM corpus WHERE slug = 'test'").get().id;
      clearSharedArtifacts();
      const r = warmQuery(t.db, { corpusIds: [corpusId] });
      const cubes = r.warmed.filter((w) => w.corpus !== undefined);
      assert.equal(cubes.length, 1);
      // the slice cube holds the rate-eligible collections; relation endpoints are a separate cube (contract 1.3.0)
      assert.equal(cubes[0].rows, t.db.prepare(`SELECT count(*) AS n FROM doc_tokens x JOIN document d ON d.id = x.document_id
        JOIN collection c ON c.id = d.collection_id WHERE c.corpus_id = ? AND c.rate_eligible = 1 AND d.deleted_at IS NULL`).get(corpusId).n);
      assert.ok(r.warmed.some((w) => w.collections > 0), 'the corpus list\'s per-collection statistics are warmed too');
      const files = readdirSync(path.join(t.dir, 'cache'));
      for (const p of ['cube', 'ecube', 'cells', 'themes', 'makers', 'names', 'cstats']) assert.ok(files.some((f) => f.startsWith(p) && f.endsWith('.bin')), `${p} in ${files}`);
    } finally {
      t.cleanup();
    }
  });
});

describe('label indexes: theme and maker typeahead', () => {
  test('matches like a substring scan of the folded labels, most-tagged first (with and without trigram postings)', () => {
    const rows = [
      { value: 'hip hop', n: 40, provs: 'documented_category,machine_tag' }, { value: 'Hip-Hop Soul', n: 7, provs: 'machine_tag' },
      { value: 'protest', n: 12, provs: 'machine_tag' }, { value: 'love song', n: 30, provs: 'genre_heuristic' },
      { value: 'chiptune', n: 3, provs: 'catalog' }, { value: 'zéro absolu', n: 2, provs: 'catalog' }, { value: 'shop', n: 1, provs: 'catalog' },
    ];
    const brute = (q, limit = 5) => rows.filter((r) => foldLabel(r.value).includes(foldLabel(q))).sort((a, b) => b.n - a.n || (a.value < b.value ? -1 : 1))
      .slice(0, limit).map((r) => r.value);
    for (const trigrams of [true, false]) {
      const index = buildLabelIndex(rows, { trigrams, slugs: true });
      for (const q of ['hop', 'hip hop', 'HIP-HOP', 'o', 'ho', 'song', 'zéro', 'zero', 'xyz', 'p', 'chip', 'tune']) {
        assert.deepEqual(findLabels(index, q).map((r) => r.value), brute(q), `${q} (trigrams ${trigrams})`);
      }
      assert.deepEqual(findLabels(index, 'hip hop')[0], { value: 'hip hop', n: 40, provenance: ['documented_category', 'machine_tag'] });
      assert.deepEqual(findLabels(index, 'o', { limit: 2 }).map((r) => r.value), ['hip hop', 'love song']);
      assert.deepEqual(labelsForRef(index, 'hip-hop-soul'), ['Hip-Hop Soul'], 'by slug');
      assert.deepEqual(labelsForRef(index, 'protest'), ['protest'], 'by label');
    }
    assert.deepEqual(findLabels(null, 'hop'), []);
  });

  test('built from the corpus (themes from doc_tag; makers from authors and maker tags), persisted; peek never builds', () => {
    const tmp = makeTmpData({ seed: false });
    try {
      buildGeneratedCorpus(tmp.db, { seed: 3, texts: 30, titles: 60, abstracts: 5 });
      const corpusId = tmp.db.prepare("SELECT id FROM corpus WHERE slug = 'test'").get().id;
      clearSharedArtifacts();
      assert.equal(peekLabelIndex(tmp.db, corpusId, 'theme'), null, 'nothing built yet');
      const themes = labelIndex(tmp.db, corpusId, 'theme');
      const hip = findLabels(themes, 'hip')[0];
      const n = tmp.db.prepare(`SELECT count(DISTINCT t.document_id) AS n FROM doc_tag t WHERE t.scheme = 'theme' AND t.value = 'hip hop'`).get().n;
      assert.equal(hip.value, 'hip hop');
      assert.equal(hip.n, n);
      const makers = labelIndex(tmp.db, corpusId, 'maker');
      const kelly = findLabels(makers, 'kelly').map((r) => r.value);
      assert.ok(kelly.includes('Gene Kelly (synthetic)') && kelly.includes('Kelly Marsh (synthetic)'));
      const gk = tmp.db.prepare("SELECT count(*) AS n FROM document WHERE author = 'Gene Kelly (synthetic)' AND deleted_at IS NULL").get().n;
      assert.equal(findLabels(makers, 'gene kelly')[0].n, gk);
      assert.deepEqual(labelsForRef(makers, 'gene-kelly-synthetic'), ['Gene Kelly (synthetic)']);
      const files = readdirSync(path.join(tmp.dir, 'cache'));
      assert.ok(files.some((f) => f.startsWith('themes')) && files.some((f) => f.startsWith('makers')));
      clearSharedArtifacts();
      assert.deepEqual(findLabels(peekLabelIndex(tmp.db, corpusId, 'theme'), 'hip'), findLabels(themes, 'hip'), 'read back from the file');
    } finally {
      tmp.cleanup();
    }
  });
});
