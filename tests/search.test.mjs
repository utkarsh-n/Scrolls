// OWNER: WP3 — search, expressions and the timeline endpoints over HTTP (SPEC §7, §11 rows 1 and 3, D16)
//
// The real server runs in-process on a temp data dir holding the mini corpus and the generated corpus; heavy
// endpoints go through the read-worker pool and materialization through the job queue. Every response is
// validated against its contract shape.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { normString } from '../src/shared/tokenize.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';
import { startServerInProcess } from './helpers/server.mjs';
import { assertShape, checkResponse } from './helpers/shape.mjs';
import { buildGeneratedCorpus } from './aggregate.corpus.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'error';

let tmp, s, rdb;

async function get(path) {
  const r = await s.request('GET', path);
  const body = r.text ? JSON.parse(r.text) : null;
  return { status: r.status, body, headers: r.headers, raw: r };
}

async function call(method, path, body) {
  const r = await s.request(method, path, { body });
  const res = new Response(r.text, { status: r.status });
  return { status: r.status, body: await checkResponse(res, method, path.split('?')[0]) };
}

async function track(surface, extra = {}) {
  const { body } = await call('POST', '/api/expressions', { surface, corpus: 'test', ...extra });
  return waitReady(body.expression.id);
}

async function waitReady(id) {
  for (let i = 0; i < 200; i++) {
    const { body } = await call('GET', `/api/expressions/${id}`);
    if (body.state.status === 'ready') return body;
    if (body.state.status === 'failed') throw new Error(`materialization of ${id} failed`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`expression ${id} not ready`);
}

async function search(q, extra = '') {
  const r = await get(`/api/search?q=${encodeURIComponent(q)}&corpus=test${extra}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assertShape('Search', r.body);
  return r.body;
}

before(async () => {
  tmp = makeTmpData();
  buildGeneratedCorpus(tmp.db);
  tmp.db.close();
  s = await startServerInProcess({ dataDir: tmp.dir });
  rdb = new DatabaseSync(tmp.dbPath, { readOnly: true });   // a read-only view of the server's database
});
after(async () => {
  rdb?.close();
  await s?.cleanup();
  tmp?.cleanup();
});

describe('GET /api/search: typed suggestions (expression · work · maker · theme)', () => {
  test('an expression with exact counts, works whose titles contain it, KWIC from the original', async () => {
    const r = await search('zero');
    const expr = r.suggestions.find((x) => x.type === 'expression');
    assert.ok(expr.count > 100);
    assert.equal(r.hits.preliminary, false);
    assert.ok(r.suggestions.some((x) => x.type === 'work' && /^Zero Hour/.test(x.label) && x.ref.startsWith('document:')));
    assert.ok(r.titles.length > 0 && r.titles.every((t) => normString(t.title).split(' ').some((w) => ['zero', 'zeros'].includes(w))));
    assert.ok(r.kwic.length > 0);
    for (const k of r.kwic) assert.ok(['zero', 'zeros', "zero s", 'zeroes', 'zeroing', 'zeroed'].includes(normString(k.match)));
    assert.equal(r.query.lang, 'en');
    assert.ok(r.query.variants.some((v) => v.form === 'zeros' && v.n > 0));
    assert.equal(r.empty_note, null);
  });

  test('makers and themes are suggested with their document counts', async () => {
    const m = await search('kelly', '&scope=makers');
    const names = m.suggestions.filter((x) => x.type === 'maker').map((x) => x.name);
    assert.deepEqual(names.sort(), ['Gene Kelly (synthetic)', 'Kelly Marsh (synthetic)']);
    assert.ok(m.suggestions.every((x) => x.type === 'maker' && x.count > 0 && x.ref.startsWith('maker:')));
    const t = await search('hip hop', '&scope=themes');
    const theme = t.suggestions.find((x) => x.type === 'theme');
    assert.equal(theme.ref, 'theme:hip hop');
    assert.ok(theme.count > 0);
    assert.deepEqual(theme.provenance.sort(), ['documented_category', 'machine_tag']);
  });

  test('Devanagari and Gujarati are whole tokens; oblique, postposition and orthographic variants count', async () => {
    const hi = await search('शून्य');
    assert.equal(hi.query.lang, 'hi');
    assert.ok(hi.suggestions[0].count > 0);
    assert.ok(hi.query.variants.find((v) => v.form === 'शून्यों').n > 0, 'oblique plural');
    const gu = await search('શૂન્ય');
    assert.equal(gu.query.lang, 'gu');
    assert.ok(gu.query.variants.find((v) => v.form === 'શૂન્યમાં').n > 0, 'attached postposition');
    const nukta = await search('कलम');
    assert.ok(nukta.query.variants.find((v) => v.form === 'क़लम' && v.rule === 'nukta-fold@1').n > 0, 'nukta fold');
    const candra = await search('चाँद');
    assert.ok(candra.query.variants.find((v) => v.form === 'चांद' && v.rule === 'candrabindu-anusvara@1').n > 0);
    for (const k of hi.kwic) assert.ok(normString(k.match).startsWith('शून्य'));
  });

  test('an empty result is computed, with the variants tried', async () => {
    const r = await search('hacker');
    assert.match(r.empty_note, /^No occurrences of 'hacker' in the loaded corpus \(.*tokens of full text.*titles\)\./);
    assert.match(r.empty_note, /With the plural variant 'hackers': \d+ match/);
    assert.match(r.empty_note, /0 is an observation about this index, not about culture\.$/);
    const none = await search('qzxv');
    assert.equal(none.suggestions.find((x) => x.type === 'expression').count, 0);
    assert.ok(!/With the/.test(none.empty_note));
  });

  test('bad requests are 400s', async () => {
    assert.equal((await get('/api/search?corpus=test')).status, 400);
    assert.equal((await get('/api/search?q=zero&corpus=nope')).status, 400);
    assert.equal((await get('/api/search?q=zero&corpus=test&scope=bogus')).status, 400);
  });
});

describe('proper-noun guard (§4.5)', () => {
  test('capitalized names in text and name-shaped neighbours in titles are excluded and listed; overrides count them', async () => {
    const e = await track('gene', { lang: 'en' });
    assert.ok(e.state.names_excluded > 0, 'excluded as names');
    const occ = (title) => rdb.prepare(`SELECT o.name_flag FROM occurrence o JOIN document d ON d.id = o.document_id
      WHERE o.expression_id = ? AND d.title = ? AND o.run_id = ?`).all(e.expression.id, title, e.state.run).map((r) => r.name_flag);
    assert.ok(occ('Gene Kelly Live').every((f) => f === 1), "'Gene Kelly' → excluded");
    assert.ok(occ('The Selfish Gene').length > 0 && occ('The Selfish Gene').every((f) => f === 0), "'The Selfish Gene' → counted");
    const mini01 = rdb.prepare(`SELECT o.start_off, o.name_flag FROM occurrence o JOIN document d ON d.id = o.document_id
      WHERE d.ext_id = 'mini:01' AND o.expression_id = ? AND o.run_id = ? ORDER BY o.start_off`).all(e.expression.id, e.state.run).map((r) => ({ ...r }));
    assert.deepEqual(mini01, [{ start_off: 226, name_flag: 1 }, { start_off: 283, name_flag: 0 }], 'Gene Halloran excluded, selfish gene counted');
    // an override counts the excluded match at the next materialization
    const docId = rdb.prepare("SELECT id FROM document WHERE ext_id = 'mini:01'").get().id;
    const before = e.state.n;
    const { body } = await call('PATCH', `/api/expressions/${e.expression.id}/variants`, { names: [{ document_id: docId, field: 'body', start: 226, counted: true }] });
    assert.equal(body.state.status, 'materializing');
    const after = await waitReady(e.expression.id);
    assert.equal(after.state.n, before + 1);
    assert.equal(after.state.names_excluded, e.state.names_excluded - 1);
  });
});

describe('expressions and the timeline over HTTP (read pool, job queue)', () => {
  test('POST → job → ready; PATCH variants re-counts; errors', async () => {
    const r = await call('POST', '/api/expressions', { surface: 'cero', lang: 'es', corpus: 'test' });
    assert.ok(['materializing', 'ready'].includes(r.body.state.status));
    const ready = await waitReady(r.body.expression.id);
    const plural = ready.variants.find((v) => v.form === 'ceros');
    assert.ok(plural.n > 0);
    assert.equal(ready.variants.find((v) => v.form === 'cera').enabled, false, 'feminine forms are off by default');
    const total = ready.state.n;
    await call('PATCH', `/api/expressions/${ready.expression.id}/variants`, { variants: [{ id: plural.id, enabled: false }] });
    const after = await waitReady(ready.expression.id);
    assert.equal(after.state.n, total - plural.n);
    assert.equal(after.variants.find((v) => v.id === plural.id).n, null);
    const again = await call('POST', '/api/expressions', { surface: 'cero', lang: 'es', corpus: 'test' });
    assert.equal(again.body.expression.id, ready.expression.id, 'tracking is idempotent');
    assert.equal((await call('POST', '/api/expressions', { surface: '  ', corpus: 'test' })).status, 400);
    assert.equal((await call('GET', '/api/expressions/99999')).status, 404);
    const allOff = after.variants.filter((v) => v.enabled).map((v) => ({ id: v.id, enabled: false }));
    assert.equal((await call('PATCH', `/api/expressions/${ready.expression.id}/variants`, { variants: allOff })).status, 400);
  });

  test('query → tiles, marks, shelves, bin drawer, passages, documents and KWIC all answer in contract shape', async () => {
    const e = await track('zero');
    const q = await call('POST', '/api/timeline/query', { corpus: 'test', strands: [{ type: 'expression', ref: e.expression.id }],
      lanes: { facet: 'modality', order: 'first_observed', max: 10 }, f: '', toggles: { ds: 0 } });
    assert.equal(q.body.status, 'ready');
    assert.deepEqual(q.body.lanes.map((l) => l.key).sort(), ['modality:abstracts', 'modality:text', 'modality:titles']);
    assert.equal(q.body.seams.length, 1, 'text + titles → the modality seam');
    assert.match(q.body.seams[0].label, /^Full text ends \d+ → after this line the evidence is titles and abstracts: a change of medium, not of meaning\.$/);
    const titles = q.body.lanes.find((l) => l.key === 'modality:titles');
    assert.equal(titles.unit, 'per_thousand_works');
    assert.match(titles.selection, /selected by prominence/, 'selection is declared in the lane header');
    assert.match(titles.header, /selected by prominence/);
    const key = q.body.queryKey;
    const tiles = await call('GET', `/api/timeline/tiles?q=${key}&tier=L2&tiles=2..3`);
    assert.equal(tiles.body.tiles.length, 2);
    const cached = await call('GET', `/api/timeline/tiles?q=${key}&tier=L2&tiles=3`);
    assert.deepEqual(cached.body.tiles[0], tiles.body.tiles[1]);
    const marks = await call('GET', `/api/timeline/marks?q=${key}&from=1900&to=1999`);
    assert.ok(marks.body.total > 0 && marks.body.marks.every((m) => Number.isInteger(m.passage)));
    for (const which of ['undated', 'scheduled', 'washes']) {
      const shelf = await call('GET', `/api/timeline/shelf?q=${key}&which=${which}&tier=L3`);
      assert.equal(shelf.body.which, which);
    }
    const cell = tiles.body.tiles.flatMap((t) => Object.entries(t.lanes).flatMap(([lane, l]) =>
      Object.values(l.strands).flat().map((c) => ({ lane, bin: t.bin0 + c[0], n: c[1] })))).find((c) => c.n > 0);
    const bin = await call('GET', `/api/timeline/bin?q=${key}&lane=${encodeURIComponent(cell.lane)}&tier=L2&bin=${cell.bin}`);
    assert.equal(bin.body.denominator.n, cell.n);
    const row = bin.body.rows[0];
    const p = await call('GET', `/api/passages/${row.passage}?context=1`);
    assert.equal(p.body.text.slice(row.start, row.end), row.match, 'the bin row opens its passage at the same offsets');
    assert.ok(p.body.highlights.some((h) => h.start === row.start && h.end === row.end));
    await call('GET', `/api/documents/${row.doc}`);
    await call('GET', `/api/documents/${row.doc}/text?from=0&to=10`);
    const kw = await call('GET', `/api/kwic?expr=${e.expression.id}&sort=spread&limit=10`);
    assert.equal(kw.body.rows.length, 10);
    assert.ok(kw.body.cursor);
    const kw2 = await call('GET', `/api/kwic?q=${key}&limit=10&cursor=${kw.body.cursor}`);
    assert.equal(kw2.body.total, kw.body.total, 'the same slice through a queryKey or an expression id');
    assert.equal(kw2.body.rows.length, 10);
  });

  test('unknown queries and bad parameters', async () => {
    assert.equal((await call('GET', '/api/timeline/tiles?q=0000000000000000&tier=L2&tiles=1')).status, 404);
    assert.equal((await call('GET', '/api/timeline/tiles?tier=L2&tiles=1')).status, 400);
    assert.equal((await call('POST', '/api/timeline/query', { corpus: 'test', strands: [] })).status, 400);
    assert.equal((await call('POST', '/api/timeline/query', { corpus: 'test', strands: [{ type: 'expression', ref: 99999 }] })).status, 400);
    assert.equal((await call('GET', '/api/passages/999999')).status, 404);
    assert.equal((await call('GET', '/api/documents/abc')).status, 400);
  });

  test('a theme strand counts tagged works per lane (works unit)', async () => {
    const q = await call('POST', '/api/timeline/query', { corpus: 'test', strands: [{ type: 'theme', ref: 'hip hop' }],
      lanes: { facet: 'collection', max: 10 } });
    const lane = q.body.lanes.find((l) => l.key === 'collection:gen-titles~titles');
    const tagged = rdb.prepare(`SELECT count(DISTINCT t.document_id) AS n FROM doc_tag t JOIN document d ON d.id = t.document_id
      JOIN collection c ON c.id = d.collection_id WHERE t.scheme = 'theme' AND t.value = 'hip hop' AND c.slug = 'gen-titles'`).get().n;
    assert.ok(lane.n > 0 && lane.n <= tagged * 2, 'documented and machine-tag sub-strands');
    assert.deepEqual(Object.keys(lane.strands).sort(), ['theme:hip hop@documented_category', 'theme:hip hop@machine_tag']);
  });
});


describe('works mode: work and maker strands are drawn as work marks, never as rates', () => {
  test('a maker suggested by search pins by its slug; its works are marks; tiles carry no cells for it', async () => {
    const m = await search('gene kelly', '&scope=makers');
    const sug = m.suggestions.find((x) => x.name === 'Gene Kelly (synthetic)');
    const slug = sug.ref.slice('maker:'.length);
    const q = await call('POST', '/api/timeline/query', { corpus: 'test', strands: [{ type: 'maker', ref: slug }], lanes: { facet: 'collection' } });
    const key = q.body.queryKey;
    const marks = await call('GET', `/api/timeline/marks?q=${key}`);
    const dated = rdb.prepare(`SELECT count(*) AS n FROM document d JOIN collection c ON c.id = d.collection_id
      WHERE d.author = 'Gene Kelly (synthetic)' AND d.chrono_status = 'dated' AND c.rate_eligible = 1`).get().n;
    assert.equal(marks.body.total, dated);
    assert.ok(marks.body.marks.every((x) => x.kind === 'work' && x.occ === null && Number.isInteger(x.passage)));
    const tiles = await call('GET', `/api/timeline/tiles?q=${key}&tier=L2&tiles=3`);
    assert.deepEqual(tiles.body.tiles[0].lanes, {});
    assert.equal((await call('POST', '/api/timeline/query', { corpus: 'test', strands: [{ type: 'maker', ref: 'nobody-at-all' }] })).status, 400);
  });
});

describe('shared artifacts (M1 gate performance fix)', () => {
  test('a queried corpus gets its slice cube, label indexes and name index persisted under <data>/cache, with no lock left', async () => {
    const { readdirSync } = await import('node:fs');
    const pathMod = await import('node:path');
    await call('POST', '/api/timeline/query', { corpus: 'test', strands: [{ type: 'theme', ref: 'protest' }], lanes: { facet: 'kind' } });
    let files = [];
    for (let i = 0; i < 200; i++) {
      try { files = readdirSync(pathMod.join(tmp.dir, 'cache')); } catch { files = []; }
      if (['cube', 'themes', 'makers', 'names'].every((p) => files.some((f) => f.startsWith(p) && f.endsWith('.bin')))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const p of ['cube', 'themes', 'makers', 'names']) assert.ok(files.some((f) => f.startsWith(p) && f.endsWith('.bin')), `${p} file in ${files}`);
    assert.ok(!files.some((f) => f.endsWith('.lock')), 'no lock left behind');
  });
});

describe('computed empty state after a revert (M1 gate)', () => {
  test('a tracked expression whose only documents were removed is empty, whatever its last run counted', async () => {
    const { searchQuery } = await import('../server/routes/search.mjs');
    const { materializeInline, trackExpression } = await import('../server/aggregate/materialize.mjs');
    const { bumpDataVersion, nowIso, tx } = await import('../server/db/open.mjs');
    const { loadMini } = await import('./helpers/tmpdata.mjs');
    const t = makeTmpData({ seed: false });
    try {
      loadMini(t.db, { slug: 'revert-me', docs: [{ ext_id: 'rv:1', kind: 'book', title: 'Quuxwort (synthetic)', lang_declared: 'en',
        text: { original: 'The ledger said quuxwort twice: quuxwort, and nothing else of note in this short invented line.', decoder: 'utf-8' },
        dates: [{ role: 'publication', raw: '1920', asserted_by: 'test', is_chronology: true }], original_meta: { test: true } }] });
      const id = trackExpression(t.db, { surface: 'quuxwort', lang: 'en', corpus: 'test' }).id;
      materializeInline(t.db, id);
      const before1 = searchQuery(t.db, { q: 'quuxwort', corpus: 'test' });
      assert.equal(before1.suggestions.find((x) => x.type === 'expression').count, 2);
      assert.equal(before1.empty_note, null);
      tx(t.db, () => { t.db.prepare("UPDATE document SET deleted_at = ? WHERE ext_id = 'rv:1'").run(nowIso()); bumpDataVersion(t.db); });
      const after1 = searchQuery(t.db, { q: 'quuxwort', corpus: 'test' });
      assert.equal(after1.suggestions.find((x) => x.type === 'expression').count, 0);
      assert.match(after1.empty_note, /^No occurrences of 'quuxwort'/);
    } finally {
      t.cleanup();
    }
  });
});
