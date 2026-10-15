// OWNER: WP3 — filters update every view consistently (SPEC §11 row 4): for random filter/toggle combinations,
// Σ tile n per lane = marks total = export row count = concordance total = search count; the "other" lane
// completes the sum; the bin drawer agrees with its tile cell; a filter change changes the queryKey.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { binOf } from '../src/shared/dates.mjs';
import { mulberry32 } from '../src/shared/ids.mjs';
import { parseFilter } from '../src/shared/viewstate.mjs';
import { CELL_STATES } from '../src/shared/vocab.mjs';
import { binQuery } from '../server/aggregate/bin.mjs';
import { marksQuery } from '../server/aggregate/marks.mjs';
import { materializeInline, trackExpression } from '../server/aggregate/materialize.mjs';
import { buildDef, canonicalRequest, defFromViewState, queryKeyOf, timelineQuery } from '../server/aggregate/query.mjs';
import { computeTiles } from '../server/aggregate/tiles.mjs';
import { exportQuery } from '../server/export/manifest.mjs';
import { compareQuery } from '../server/analysis/compare.mjs';
import { resolveExpressions } from '../server/analysis/slices.mjs';
import { searchQuery } from '../server/routes/search.mjs';
import { kwicQuery } from '../server/text/kwic.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';
import { assertShape } from './helpers/shape.mjs';
import { buildGeneratedCorpus, inSlice, randomRequest } from './aggregate.corpus.mjs';

/** The ViewState a timeline request corresponds to (what the UI would export). */
function stateOf(req) {
  const f = parseFilter(req.f);
  return { v: 1, corpus: req.corpus, strands: req.strands.map((s) => ({ type: s.type, id: s.ref })),
    lanes: { facet: req.lanes.facet, order: req.lanes.order, max: req.lanes.max, manual: [] }, f, toggles: req.toggles, timeBasis: 'publication' };
}

describe('cross-view invariants on the generated corpus', () => {
  let tmp, db, exprs, ext;
  before(() => {
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    buildGeneratedCorpus(db, { seed: 11, und: true });
    exprs = ['zero', 'zéro', 'શૂન્ય', 'carry the zero', 'gene', '◉'].map((s) => {
      const { id } = trackExpression(db, { surface: s, corpus: 'test' });
      materializeInline(db, id);
      return id;
    });
    ext = db.prepare("SELECT MIN(y_lo) AS lo, MAX(y_hi) AS hi FROM document WHERE chrono_status = 'dated'").get();
  });
  after(() => tmp.cleanup());

  test('Σ tile n per lane = marks total per lane; visible lanes + other = total; export rows = total (50 combinations)', () => {
    const rnd = mulberry32(99);
    let compared = 0, daysChecked = 0;
    for (let k = 0; k < 50; k++) {
      const req = randomRequest(rnd, exprs);
      req.lanes.max = 2 + Math.floor(rnd() * 6);
      const { def } = buildDef(db, canonicalRequest(req));
      const tl = timelineQuery(db, { def });
      const sumVisible = tl.lanes.reduce((s, l) => s + l.n, 0);
      assert.equal(sumVisible + tl.other.n, tl.totals.n, `config ${k}: the other lane completes the sum`);
      assert.equal(tl.lanes.length + tl.other.lanes, new Set([...tl.lanes.map((l) => l.key), ...tl.other.keys]).size);

      const tiles = [];
      for (let t = Math.floor(binOf(ext.lo, 2) / 64); t <= Math.floor(binOf(ext.hi, 2) / 64); t++) tiles.push(t);
      const res = computeTiles(db, def, 'L2', tiles);
      const perLane = new Map();
      for (const t of res.tiles) {
        for (const [lane, l] of Object.entries(t.lanes)) for (const cells of Object.values(l.strands)) {
          for (const c of cells) perLane.set(lane, (perLane.get(lane) ?? 0) + c[1]);
        }
        for (const w of t.washes) if (w.owner) perLane.set(w.lane, (perLane.get(w.lane) ?? 0) + w.n);
      }
      for (const [lane, n] of perLane) {
        const m = marksQuery(db, { def, lane, limit: 4000 });
        assert.equal(m.total, n, `config ${k} ${lane}: marks total = Σ tile n (bins + washes)`);
        compared++;
        // caps: the first / last day of each observed cell are those of the marks binned there
        const byBin = new Map();
        for (const mk of m.marks) {
          const y = Number(db.prepare('SELECT y_lo, y_hi FROM document WHERE id = ?').get(mk.doc).y_lo);
          const hi = db.prepare('SELECT y_hi FROM document WHERE id = ?').get(mk.doc).y_hi;
          if (Math.floor(y / 10) !== Math.floor(hi / 10)) continue;   // a wash at L2
          const b = `${mk.strand}|${Math.floor(y / 10)}`;
          const cur = byBin.get(b) ?? [Infinity, -Infinity];
          byBin.set(b, [Math.min(cur[0], mk.lo_day), Math.max(cur[1], mk.hi_day)]);
        }
        for (const t of res.tiles) {
          for (const [skey, list] of Object.entries(t.days?.[lane] ?? {})) {
            for (const [idx, first, last] of list) {
              assert.deepEqual([first, last], byBin.get(`${skey}|${t.bin0 + idx}`), `config ${k} ${lane} bin ${t.bin0 + idx}: exact caps`);
              daysChecked++;
            }
          }
        }
      }
      const all = marksQuery(db, { def, limit: 4000 });
      assert.equal(all.total, tl.totals.dated, `config ${k}: marks cover every dated match`);
      assertShape('Marks', all);
      if (tl.totals.n > 0) {
        const exp = exportQuery(db, { state: Buffer.from(JSON.stringify(stateOf(req))).toString('base64url'), what: 'occurrences', format: 'json' });
        assert.equal(JSON.parse(exp.body).rows.length, tl.totals.n, `config ${k}: export rows = total n`);
        assert.equal(queryKeyOf(defFromViewState(db, stateOf(req)).def), queryKeyOf(def), `config ${k}: the exported state is the same query`);
      }
    }
    assert.ok(compared > 100, `compared ${compared} lanes`);
    assert.ok(daysChecked > 100, `checked the caps of ${daysChecked} cells`);
  });

  test('every mark resolves to its passage and lies inside it', () => {
    const { def } = buildDef(db, canonicalRequest({ corpus: 'test', strands: exprs.slice(0, 4).map((ref) => ({ type: 'expression', ref })),
      lanes: { facet: 'language', max: 48 }, toggles: { ds: 1, ap: 1, nm: 1 } }));
    const { marks } = marksQuery(db, { def, limit: 4000 });
    assert.ok(marks.length > 300);
    for (const m of marks) {
      const o = db.prepare('SELECT o.start_off, o.end_off, p.start_off AS ps, p.end_off AS pe, p.document_id FROM occurrence o JOIN passage p ON p.id = o.passage_id WHERE o.id = ?').get(m.occ);
      assert.ok(o, `occurrence ${m.occ} exists`);
      assert.equal(o.document_id, m.doc);
      assert.ok(o.ps <= o.start_off && o.start_off < o.end_off && o.end_off <= o.pe, `occurrence ${m.occ} inside its passage`);
    }
  });

  test('the bin drawer agrees with the tile cell it opens from', () => {
    const { def } = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: exprs[0] }], lanes: { facet: 'collection', max: 48 } }));
    const tiles = [];
    for (let t = Math.floor(binOf(ext.lo, 3) / 64); t <= Math.floor(binOf(ext.hi, 3) / 64); t++) tiles.push(t);
    let checked = 0;
    for (const t of computeTiles(db, def, 'L3', tiles).tiles) {
      for (const [lane, l] of Object.entries(t.lanes)) for (const [, cells] of Object.entries(l.strands)) for (const c of cells) {
        const bin = t.bin0 + c[0];
        const d = binQuery(db, { def, lane, tier: 'L3', bin, limit: 200 });
        assertShape('BinDrawer', d);
        assert.equal(d.denominator.n, c[1]);
        assert.equal(d.denominator.state, CELL_STATES[c[8]]);
        assert.equal(d.denominator.tokens ?? d.denominator.works, c[4]);
        assert.equal(d.total, c[1], `${lane} ${bin}: one row per counted match`);
        assert.ok(d.denominator.text.length > 0);
        for (const r of d.rows) assert.ok(r.match.length > 0 && Number.isInteger(r.passage));
        checked++;
      }
    }
    assert.ok(checked > 20, `checked ${checked} drawers`);
  });

  test('search counts, concordance totals and timeline totals agree under the same filters', () => {
    for (const [i, surface] of ['zero', 'zéro', 'શૂન્ય', 'carry the zero', 'gene'].entries()) {
      for (const f of ['', 'coll:gen-text', 'lang:-und-Latn', 'community:classroom,office-lab', 'kind:-film']) {
        const s = searchQuery(db, { q: surface, corpus: 'test', f });
        assertShape('Search', s);
        const { def } = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: exprs[i] }], lanes: { facet: 'modality' }, f }));
        const tl = timelineQuery(db, { def });
        assert.equal(s.suggestions.find((x) => x.type === 'expression').count, tl.totals.n, `${surface} [${f}]: search = timeline`);
        assert.equal(s.hits.preliminary, false);
        const kw = kwicQuery(db, { def, limit: 5 });
        assert.equal(kw.total, tl.totals.n, `${surface} [${f}]: concordance = timeline`);
        assertShape('Kwic', kw);
      }
    }
  });

  test('an untracked search counts exactly what a tracked expression would', () => {
    const s1 = searchQuery(db, { q: 'cero', corpus: 'test' });
    assert.equal(s1.expression, null, 'cero is not tracked yet');
    const untracked = s1.suggestions.find((x) => x.type === 'expression').count;
    const { id } = trackExpression(db, { surface: 'cero', corpus: 'test' });
    materializeInline(db, id);
    const s2 = searchQuery(db, { q: 'cero', corpus: 'test' });
    assert.equal(s2.expression.id, id);
    assert.equal(s2.suggestions.find((x) => x.type === 'expression').count, untracked);
    assert.deepEqual([s2.hits.passages, s2.hits.documents, s2.hits.undated], [s1.hits.passages, s1.hits.documents, s1.hits.undated]);
  });

  test('default exclusions add up: every toggle on adds exactly Σ buckets + names, each match counted once (fix pass, §13 rule 9)', () => {
    const allOn = { tr: 1, ds: 1, ap: 1, dup: 1, nm: 1, est: 1, bp: 0 };
    let overlapSeen = 0;
    for (const ref of exprs) {
      const base = { corpus: 'test', strands: [{ type: 'expression', ref }], lanes: { facet: 'language', max: 48 } };
      const dflt = timelineQuery(db, { def: buildDef(db, canonicalRequest(base)).def });
      const on = timelineQuery(db, { def: buildDef(db, canonicalRequest({ ...base, toggles: allOn })).def });
      const e = dflt.totals.excluded[String(ref)];
      const toggled = e.describes + e.apparatus + e.translations + e.duplicates + e.estimated + e.names;
      assert.equal(on.totals.n - dflt.totals.n, toggled, `expression ${ref}: the listed exclusions account for every match the toggles add`);
      assert.equal(e.names, dflt.totals.names_excluded, `expression ${ref}: names agrees with totals.names_excluded`);
      const run = db.prepare("SELECT run_id FROM expression_state WHERE expression_id = ? AND status = 'ready'").get(ref).run_id;
      overlapSeen += db.prepare(`SELECT count(*) AS n FROM expr_doc x JOIN document d ON d.id = x.document_id WHERE x.expression_id = ? AND x.run_id = ?
        AND x.n_names > 0 AND (x.field_class IN ('describes', 'apparatus') OR d.is_translation = 1 OR d.dup_of IS NOT NULL)`).get(ref, run).n;
    }
    assert.ok(overlapSeen > 0, 'the fixture has name-guard hits in rows another rule excludes');
  });

  test('a Gujarati word is divided by Gujarati text only: no unidentified Latin bucket in its denominators (fix pass, §13 rules 2–3)', () => {
    const gu = exprs[2];
    const { def } = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: gu }], lanes: { facet: 'language', max: 48 } }));
    assert.deepEqual(def.strands[0].langs, ['gu']);
    const tl = timelineQuery(db, { def });
    assert.deepEqual(tl.lanes.map((l) => l.key).filter((k) => /und/.test(k)), [], 'no und lane in the slice');
    const guTokens = db.prepare(`SELECT COALESCE(SUM(t.tokens), 0) AS n FROM doc_tokens t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
      WHERE t.plang = 'gu' AND t.field_class = 'text' AND d.deleted_at IS NULL AND c.rate_eligible = 1 AND d.is_translation = 0 AND d.dup_of IS NULL`).get().n;
    const textCoverage = tl.lanes.filter((l) => l.modality === 'text').reduce((a, l) => a + (l.coverage.tokens ?? 0), 0);
    assert.equal(textCoverage, guTokens, 'the coverage is the Gujarati text');
  });

  test('Compare divides a Gujarati word by Gujarati text only, with the timeline\'s languages (fix pass, §13 rules 2–3)', () => {
    const gu = exprs[2];
    const { def } = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: gu }], lanes: { facet: 'language', max: 48 } }));
    const [e] = resolveExpressions(db, [gu]);
    assert.deepEqual([...e.langs].sort(), def.strands[0].langs, 'Compare reads the languages the tiles read');
    const ext = db.prepare("SELECT MIN(y_lo) AS lo, MAX(y_hi) AS hi FROM document WHERE chrono_status = 'dated'").get();
    const mid = Math.floor((ext.lo + ext.hi) / 2);
    const p = compareQuery(db, { expr: [gu], a: { years: [ext.lo, mid] }, b: { years: [mid + 1, ext.hi] }, seed: 1 });
    for (const k of ['a', 'b']) {
      const langs = Object.keys(p.coverage[k].languages);
      assert.ok(langs.length > 0 && langs.every((l) => l === 'gu'), `slice ${k} divides by ${langs.join(', ')}`);
    }
  });

  // ── RF-1 (IOS-SPEC §2.1, ref-freeze-1): unidentified text belongs to its document's language ──────────────────
  // The fixture (aggregate.corpus.mjs unidentifiedTextDocs) puts unidentified paragraphs ('und', ≥ 12 tokens without a stop
  // word) holding 'zero' into Spanish, French and Hindi books, and holding 'cero' into an English book. Each oracle below
  // reads the raw rows and states the rule on its own (inSlice of aggregate.corpus.mjs, or plain SQL here).

  const FOREIGN = ['gen:u1', 'gen:u2', 'gen:u3', 'gen:u4'];
  const docOf = (ext) => db.prepare('SELECT id FROM document WHERE ext_id = ?').get(ext).id;
  const runOf = (id) => db.prepare("SELECT run_id FROM expression_state WHERE expression_id = ? AND status = 'ready'").get(id).run_id;

  test('RF-1: an English word is not divided by the unidentified text of Spanish, French or Hindi books', () => {
    const { def } = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: exprs[0] }], lanes: { facet: 'language', max: 48 } }));
    assert.deepEqual(def.strands[0].langs, ['en', 'und', 'und-Latn']);
    const tl = timelineQuery(db, { def });
    const coverageOf = (key) => tl.lanes.find((l) => l.key === key)?.coverage.tokens ?? 0;
    // oracle: unidentified text tokens of live, counted documents whose own language is English or unidentified
    const und = (cond) => db.prepare(`SELECT COALESCE(SUM(t.tokens), 0) AS n FROM doc_tokens t JOIN document d ON d.id = t.document_id
      JOIN collection c ON c.id = d.collection_id WHERE c.corpus_id = ? AND c.rate_eligible = 1 AND d.deleted_at IS NULL
        AND d.is_translation = 0 AND d.dup_of IS NULL AND t.field_class = 'text' AND t.plang = ? AND ${cond}`);
    for (const plang of ['und', 'und-Latn']) {
      const own = und("(d.lang_text IS NULL OR d.lang_text IN ('en', 'und', 'und-Latn'))").get(def.corpusId, plang).n;
      const foreign = und("d.lang_text NOT IN ('en', 'und', 'und-Latn')").get(def.corpusId, plang).n;
      assert.equal(coverageOf(`language:${plang}`), own, `${plang}: the coverage is the unidentified text of English or unidentified documents`);
      if (plang === 'und') assert.ok(own > 0 && foreign >= 4 * 14, `the fixture holds both kinds (${own} own, ${foreign} foreign tokens)`);
    }
    // the matches inside those foreign unidentified paragraphs are listed as other-language exclusions, never counted
    const run = runOf(exprs[0]);
    const foreignMatches = db.prepare(`SELECT COUNT(*) AS n FROM occurrence o JOIN passage p ON p.id = o.passage_id JOIN document d ON d.id = o.document_id
      WHERE o.expression_id = ? AND o.run_id = ? AND p.quality = 'ok' AND p.lang IN ('und', 'und-Latn') AND p.field_class = 'text'
        AND d.ext_id IN (SELECT value FROM json_each(?))`).get(exprs[0], run, JSON.stringify(FOREIGN)).n;
    assert.ok(foreignMatches >= 8, `${foreignMatches} matches of 'zero' in unidentified paragraphs of es/fr/hi books`);
    const otherLanguage = db.prepare(`SELECT COALESCE(SUM(x.n + x.n_names), 0) AS n FROM expr_doc x JOIN document d ON d.id = x.document_id
      JOIN collection c ON c.id = d.collection_id WHERE x.expression_id = ? AND x.run_id = ? AND c.corpus_id = ? AND d.deleted_at IS NULL
        AND (x.plang NOT IN ('en', 'und', 'und-Latn') OR (x.plang IN ('und', 'und-Latn') AND x.field_class IN ('text', 'abstract', 'apparatus')
          AND d.lang_text IS NOT NULL AND d.lang_text NOT IN ('en', 'und', 'und-Latn')))`).get(exprs[0], run, def.corpusId).n;
    assert.equal(tl.totals.excluded[String(exprs[0])].other_language, otherLanguage, 'other_language = every match outside the strand\'s text');
    const { marks } = marksQuery(db, { def, limit: 4000 });
    const foreignIds = new Set(FOREIGN.map(docOf));
    assert.deepEqual(marks.filter((m) => foreignIds.has(m.doc)), [], 'no mark in a foreign book');
    // titles keep their own language: the English label 'Zero' of a Hindi film still counts as an English title
    assert.ok(marks.some((m) => m.doc === docOf('gen:uw1')), 'the Hindi film listed as "Zero" is an English title match');
    // search, the concordance and the export count exactly the timeline's matches
    const s = searchQuery(db, { q: 'zero', corpus: 'test', f: '' });
    const { def: dm } = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: exprs[0] }], lanes: { facet: 'modality' } }));
    assert.equal(s.suggestions.find((x) => x.type === 'expression').count, timelineQuery(db, { def: dm }).totals.n);
    assert.equal(kwicQuery(db, { def: dm, limit: 5 }).total, tl.totals.n);
  });

  test('RF-1: a Spanish word counts the unidentified text of Spanish or unidentified books, never of an English one', () => {
    const { id } = trackExpression(db, { surface: 'cero', lang: 'es', corpus: 'test' });
    materializeInline(db, id);
    const { def } = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: id }], lanes: { facet: 'language', max: 48 } }));
    const { marks } = marksQuery(db, { def, limit: 4000 });
    const docs = new Set(marks.map((m) => m.doc));
    assert.ok(docs.has(docOf('gen:u8')), 'the Spanish book\'s unidentified paragraph counts for cero');
    assert.ok(docs.has(docOf('gen:u7')), 'a document with no identified passage counts');
    assert.ok(!docs.has(docOf('gen:u5')), 'the English book\'s unidentified paragraph is not Spanish text');
  });

  test('RF-1: Compare divides by the same text the timeline does (independent oracle over doc_tokens)', () => {
    const years = { a: [1889, 1893], b: [1894, 1898] };
    const p = compareQuery(db, { expr: [exprs[0]], a: { years: years.a }, b: { years: years.b }, seed: 1 });
    const { def } = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: exprs[0] }], lanes: { facet: 'language' } }));
    const rows = db.prepare(`SELECT x.document_id AS doc, x.plang, x.field_class AS fc, x.tokens, d.deleted_at, d.is_translation, d.dup_of, d.basis,
        d.is_synthetic, d.kind, d.culture, d.field, d.community, d.lang_text AS dlang, d.chrono_status, d.y_lo, d.y_hi, c.slug AS coll, c.domain,
        c.corpus_id, c.rate_eligible, c.modality FROM doc_tokens x JOIN document d ON d.id = x.document_id JOIN collection c ON c.id = d.collection_id`).all();
    for (const k of ['a', 'b']) {
      const cov = p.coverage[k];
      assert.equal(cov.modality_compared, 'text', `slice ${k} compares text`);
      const [lo, hi] = years[k];
      const per = new Map();
      for (const r of rows) {
        if (r.modality !== 'text' || r.fc !== 'text' || r.chrono_status !== 'dated' || r.y_lo < lo || r.y_hi > hi) continue;
        if (!inSlice(def, def.strands[0].langs, r)) continue;
        per.set(r.doc, (per.get(r.doc) ?? 0) + r.tokens);
      }
      const tokens = [...per.values()].reduce((a, b) => a + b, 0);
      assert.equal(cov.tokens, tokens, `slice ${k}: Compare's tokens = the oracle's`);
      assert.equal(cov.docs, [...per.values()].filter((t) => t > 0).length, `slice ${k}: Compare's documents = the oracle's`);
    }
    const inA = new Set(FOREIGN.map(docOf));
    for (const k of ['a', 'b']) for (const row of p.passages[k]) assert.ok(!inA.has(row.doc), `slice ${k}: no passage drawn from a foreign book`);
  });

  test('a filter or toggle change changes the queryKey; the same request keeps it', () => {
    const base = { corpus: 'test', strands: [{ type: 'expression', ref: exprs[0] }], lanes: { facet: 'community' } };
    const key = (extra) => queryKeyOf(buildDef(db, canonicalRequest({ ...base, ...extra })).def);
    assert.equal(key({}), key({}));
    assert.equal(key({ f: '' }), key({ f: { syn: 1 } }), 'string and object filters canonicalize alike');
    const keys = [key({}), key({ f: 'lang:en' }), key({ toggles: { tr: 1 } }), key({ lanes: { facet: 'language' } }),
      key({ f: 'lang:-en' }), key({ toggles: { nm: 1 } })];
    assert.equal(new Set(keys).size, keys.length);
  });
});
