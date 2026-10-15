// OWNER: WP3 — exports (SPEC §7.3, §13 rules 1 and 15): manifest first in every format; rows carry evidence,
// review, origin, synthetic and date fields with offsets; collections with export_text_allowed = 0 never export
// text in any format; aggregates conserve; the evidence filter reaches exports.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { check } from '../src/shared/contracts.mjs';
import { encode } from '../src/shared/viewstate.mjs';
import { nowIso } from '../server/db/open.mjs';
import { strandDocIds } from '../server/aggregate/arcs.mjs';
import { materializeInline, trackExpression } from '../server/aggregate/materialize.mjs';
import { buildDef, canonicalRequest, timelineQuery } from '../server/aggregate/query.mjs';
import { csvField, toCsv } from '../server/export/csv.mjs';
import { exportQuery } from '../server/export/manifest.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';
import { startServerInProcess } from './helpers/server.mjs';
import { buildGeneratedCorpus, CLOSED_SENTENCE } from './aggregate.corpus.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'error';

const REQUIRED = ['evidence_status', 'review_status', 'origin', 'is_synthetic', 'date_label', 'date_precision', 'date_basis', 'date_role'];

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, embedded newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

let tmp, db, zero, stateB64, state;

before(() => {
  tmp = makeTmpData({ seed: false });
  db = tmp.db;
  buildGeneratedCorpus(db, { seed: 21 });
  zero = trackExpression(db, { surface: 'zero', lang: 'en', corpus: 'test' }).id;
  materializeInline(db, zero);
  state = { v: 1, corpus: 'test', strands: [{ type: 'expression', id: zero }], lanes: { facet: 'collection', max: 48 } };
  stateB64 = Buffer.from(JSON.stringify(state)).toString('base64url');
});
after(() => tmp.cleanup());

const run = (args) => exportQuery(db, { state: stateB64, ...args });

describe('formats: the manifest comes first', () => {
  test('JSON: {manifest, rows} with runs, filters, toggles, licences and the SYNTHETIC warning', () => {
    const r = run({ what: 'occurrences', format: 'json' });
    assert.equal(r.contentType, 'application/json; charset=utf-8');
    assert.match(r.filename, /^scrolls-test-v\d+-occurrences\.json$/);
    const body = JSON.parse(r.body);
    assert.deepEqual(Object.keys(body), ['manifest', 'rows']);
    const m = body.manifest;
    for (const k of ['export_version', 'generated_at', 'view', 'state', 'data_version', 'run_ids', 'filters', 'toggles',
      'synthetic_included', 'licenses', 'attributions']) assert.ok(k in m, `manifest.${k}`);
    assert.deepEqual(check('ExportManifest', m), [], 'the manifest matches contracts ExportManifest (1.1.0, M1 gate)');
    assert.equal(m.run_ids.materialize[zero].params.norm, 'zero');
    assert.equal(m.synthetic_included, true);
    assert.match(m.warning, /SYNTHETIC/);
    assert.ok(m.state.startsWith('#v=1&c=test'));
    assert.ok(body.rows.length > 100);
    for (const row of body.rows) {
      for (const k of [...REQUIRED, 'start', 'end', 'passage', 'document', 'occ', 'source_locator']) assert.ok(k in row, `row.${k}`);
      assert.equal(row.is_synthetic, 1);
    }
  });

  test('JSONL: the manifest line, then one row per line', () => {
    const r = run({ what: 'occurrences', format: 'jsonl' });
    const lines = r.body.trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines[0].manifest);
    assert.equal(lines.length - 1, r.rows);
    assert.equal(lines[0].manifest.rows, r.rows);
  });

  test('CSV: # manifest lines, a header with the required columns, RFC 4180 rows equal to the JSON rows', () => {
    const r = run({ what: 'occurrences', format: 'csv' });
    const lines = r.body.split('\n');
    const head = lines.findIndex((l) => !l.startsWith('#'));
    const manifest = JSON.parse(lines.slice(0, head).map((l) => l.slice(2)).join('\n'));
    assert.equal(manifest.export_version, '1');
    const rows = parseCsv(lines.slice(head).join('\n'));
    const header = rows[0];
    for (const k of [...REQUIRED, 'start', 'end', 'match']) assert.ok(header.includes(k), `header ${k}`);
    const json = JSON.parse(run({ what: 'occurrences', format: 'json' }).body).rows;
    assert.equal(rows.length - 1, json.length);
    for (let i = 0; i < json.length; i++) {
      const rec = Object.fromEntries(header.map((h, j) => [h, rows[i + 1][j]]));
      assert.equal(rec.match, json[i].match ?? '');
      assert.equal(rec.context_left, json[i].context_left ?? '');
      assert.equal(Number(rec.start), json[i].start);
    }
    assert.equal(csvField('a,"b"\nc'), '"a,""b""\nc"');
    assert.equal(toCsv([{ a: null, b: true, c: { x: 1 } }], ['a', 'b', 'c']), 'a,b,c\n,true,"{""x"":1}"\n');
  });

  test('unsupported formats and requests', () => {
    assert.throws(() => run({ what: 'occurrences', format: 'pdf' }), (e) => e.status === 400 && e.code === 'E_EXPORT_FORMAT');
    assert.throws(() => run({ what: 'occurrences', format: 'html' }), (e) => e.code === 'E_EXPORT_FORMAT');
    assert.throws(() => run({ what: 'bundle', format: 'json' }), (e) => e.code === 'E_EXPORT_FORMAT');
    assert.throws(() => exportQuery(db, { what: 'occurrences' }), (e) => e.status === 400);
    assert.throws(() => run({ what: 'everything' }), (e) => e.status === 400);
  });
});

describe('licences travel with data: export_text_allowed = 0 (§13 rule 15)', () => {
  test('rows of the closed collection carry ids, offsets and locators, never text — in every format and kind', () => {
    for (const what of ['occurrences', 'passages']) {
      for (const format of ['json', 'jsonl', 'csv']) {
        const r = run({ what, format });
        assert.ok(!r.body.includes(CLOSED_SENTENCE), `${what}/${format}: closed text absent`);
        assert.ok(!r.body.includes('licence wall'), `${what}/${format}: no fragment either`);
      }
      const rows = JSON.parse(run({ what, format: 'json' }).body).rows;
      const closed = rows.filter((x) => x.collection === 'gen-closed');
      assert.ok(closed.length > 0, `${what}: the closed collection is exported (ids and offsets)`);
      for (const x of closed) {
        assert.equal(x.text_withheld, 1);
        assert.ok(Number.isInteger(x.start) && Number.isInteger(x.end));
        for (const k of ['match', 'context_left', 'context_right', 'text']) if (k in x) assert.equal(x[k], null, `${what}.${k}`);
      }
      assert.ok(rows.some((x) => x.collection === 'gen-text' && x.text_withheld === 0 && (x.match ?? x.text)));
    }
  });

  test('annotations on closed passages export without their quoted text', () => {
    const p = db.prepare("SELECT p.id, p.document_id FROM passage p JOIN document d ON d.id = p.document_id JOIN collection c ON c.id = d.collection_id WHERE c.slug = 'gen-closed' AND p.field = 'abstract' LIMIT 1").get();
    const anchor = JSON.stringify({ doc_id: p.document_id, sha256: 'x', field: 'abstract', start: 0, end: 10, quote: 'the closed' });
    const a = db.prepare(`INSERT INTO annotation (target_type, target_ref, anchor_json, kind, author, is_machine, is_synthetic, created_at)
      VALUES ('passage', ?, ?, 'interpretation', 'human:tester', 0, 1, ?)`).run(String(p.id), anchor, nowIso());
    db.prepare(`INSERT INTO annotation_revision (annotation_id, rev, body_md, author, at) VALUES (?, 1, 'a reading', 'human:tester', ?)`).run(Number(a.lastInsertRowid), nowIso());
    const rows = JSON.parse(run({ what: 'annotations', format: 'json' }).body).rows;
    const row = rows.find((x) => x.annotation === Number(a.lastInsertRowid));
    assert.equal(row.anchor_quote, null);
    assert.equal(row.text_withheld, 1);
    assert.equal(row.body_md, 'a reading', 'the reader’s own words are not the licensed text');
  });
});

describe('aggregates and relationships', () => {
  test('the aggregates export conserves per lane: Σ bins + Σ washes + undated + scheduled = total', () => {
    const { def } = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: zero }], lanes: { facet: 'collection', max: 48 } }));
    const tl = timelineQuery(db, { def });
    for (const tier of ['L1', 'L2', 'L3']) {
      const rows = JSON.parse(run({ what: 'aggregates', format: 'json', tier }).body).rows;
      for (const lane of tl.lanes) {
        const sum = rows.filter((r) => r.lane === lane.key).reduce((s, r) => s + r.n, 0);
        assert.equal(sum, lane.n, `${tier} ${lane.key}`);
      }
      assert.ok(rows.some((r) => r.kind === 'wash') && rows.some((r) => r.kind === 'undated') && rows.some((r) => r.kind === 'scheduled'));
    }
    assert.throws(() => run({ what: 'aggregates', tier: 'L5' }), (e) => e.status === 400);
  });

  test('relationship rows keep their evidence status and honour the evidence filter', () => {
    // documents where the view's strand ('zero') is counted: the relationships the view's arcs draw
    const { def } = buildDef(db, canonicalRequest({ corpus: 'test', strands: [{ type: 'expression', ref: zero }], lanes: { facet: 'collection', max: 48 } }));
    const strandDocs = strandDocIds(db, def);
    const titles = db.prepare("SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug = 'gen-titles' ORDER BY d.id").all().map((r) => r.id);
    const [d1, d2, d3] = titles.filter((id) => strandDocs.has(id));
    const outside = titles.filter((id) => !strandDocs.has(id)).slice(0, 2);
    const ins = db.prepare(`INSERT INTO relationship (rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin,
      source_dataset, source_locator, method, run_id, created_by, is_synthetic, created_at) VALUES (?, 'document', ?, 'document', ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
    ins.run('samples', String(d1), String(d2), 'documented', 'source_dataset', 'demo-records', 'record:1', null, null, 'adapter:test', nowIso());
    ins.run('near_quotation', String(d2), String(d3), 'computed', 'algorithm', null, null, 'winnow', 1, 'run:1', nowIso());
    ins.run('proposed_allusion', String(d3), String(d1), 'proposed', 'human', null, null, null, null, 'human:tester', nowIso());
    ins.run('samples', String(outside[0]), String(outside[1]), 'documented', 'source_dataset', 'demo-records', 'record:2', null, null, 'adapter:test', nowIso());
    const out = JSON.parse(run({ what: 'relationships', format: 'json' }).body);
    assert.match(out.manifest.relationship_scope, /pinned strand/);
    const all = out.rows;
    assert.deepEqual(all.map((r) => r.evidence_status).sort(), ['computed', 'documented', 'proposed']);
    for (const r of all) for (const k of [...REQUIRED, 'source_locator']) assert.ok(k in r);
    const docOnly = { ...state, evidence: { documented: 1, computed: 0, proposed: 0, rejected: 0, kindred: 0 } };
    const rows = JSON.parse(exportQuery(db, { state: encode(docOnly), what: 'relationships', format: 'json' }).body).rows;
    assert.deepEqual(rows.map((r) => [r.rel_type, r.evidence_status, r.origin, r.source_locator]), [['samples', 'documented', 'source_dataset', 'record:1']]);
    assert.ok(!all.some((r) => r.source_locator === 'record:2'), 'a link between documents the view does not show is not exported');
  });

  test('a saved view exports by slug', () => {
    db.prepare(`INSERT INTO saved_view (slug, name, state_json, state_version, state_hash, data_version, max_import_batch, run_ids_json,
      annotation_rev_cutoff, relationship_rev_cutoff, created_by, created_at) VALUES ('zero-view', 'zero', ?, 1, 'h', 1, 1, '{}', 0, 0, 'human:tester', ?)`)
      .run(JSON.stringify(state), nowIso());
    const r = exportQuery(db, { view: 'zero-view', what: 'occurrences', format: 'json' });
    const body = JSON.parse(r.body);
    assert.equal(body.manifest.view, 'zero-view');
    assert.equal(body.rows.length, JSON.parse(run({ what: 'occurrences', format: 'json' }).body).rows.length);
    assert.throws(() => exportQuery(db, { view: 'missing', what: 'occurrences' }), (e) => e.status === 404);
  });
});

describe('the portable HTML bundle (§7.3)', () => {
  test('one self-contained file: manifest, legend, licences, data tables, no closed text, a small inline script', async () => {
    const { BUNDLE_SCRIPT } = await import('../server/export/bundle-html.mjs');
    assert.ok(Buffer.byteLength(BUNDLE_SCRIPT) < 8192);
    const r = run({ what: 'bundle', format: 'html' });
    assert.equal(r.contentType, 'text/html; charset=utf-8');
    assert.match(r.filename, /bundle\.html$/);
    assert.ok(r.body.startsWith('<!doctype html>'));
    assert.match(r.body, /SYNTHETIC DEMONSTRATION CORPUS/);
    assert.ok(!/<(script|link)[^>]+src=|https?:\/\//i.test(r.body.replace(/books\.google\.com\/ngrams/g, '')), 'nothing external');
    assert.ok(!r.body.includes(CLOSED_SENTENCE), 'closed text absent from the bundle too');
    const data = JSON.parse(r.body.match(/<script type="application\/json" id="scrolls-data">([\s\S]*?)<\/script>/)[1]);
    assert.deepEqual(Object.keys(data), ['aggregates', 'occurrences', 'relationships', 'annotations']);
    assert.ok(data.occurrences.rows.length > 0 && data.occurrences.rows.length <= 5000);
    assert.match(r.body, /No snapshot was attached/);
  });
});

describe('GET /api/export over HTTP', () => {
  let s;
  before(async () => { s = await startServerInProcess({ dataDir: tmp.dir }); });
  after(async () => { await s?.cleanup(); });

  test('a download with its content type, file name and row count', async () => {
    const r = await s.request('GET', `/api/export?state=${stateB64}&what=occurrences&format=csv`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/csv; charset=utf-8');
    assert.match(r.headers['content-disposition'], /attachment; filename="scrolls-test-v\d+-occurrences\.csv"/);
    assert.ok(Number(r.headers['x-scrolls-rows']) > 100);
    assert.ok(r.text.startsWith('# {'));
    const bad = await s.request('GET', `/api/export?state=${stateB64}&format=pdf`);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'E_EXPORT_FORMAT');
  });

  test('snapshots: stored, served back, attached to a saved view and to its bundle; synthetic SVGs need the stamp', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgExAGAABhADJ5YPWCAAAAAElFTkSuQmCC';
    const stamped = '<svg xmlns="http://www.w3.org/2000/svg"><text>SYNTHETIC</text><rect width="4" height="4"/></svg>';
    const r = await s.request('POST', '/api/snapshots', { body: { view: 'zero-view', png, svg: stamped } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.files.length, 2);
    assert.match(r.json.file, /^scrolls-test-v\d+-[0-9a-f]{8}\.png$/);
    const got = await fetch(`${s.url}${r.json.url}`);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), Buffer.from(png.split(',')[1], 'base64'));
    const svgFile = r.json.files[1];
    const bundle = await s.request('GET', `/api/export?view=zero-view&what=bundle&format=html`);
    assert.equal(bundle.status, 200);
    assert.ok(bundle.text.includes('<text>SYNTHETIC</text>'), "the saved view's snapshot is inlined");
    const bySnap = await s.request('GET', `/api/export?state=${stateB64}&what=bundle&format=html&snapshot=${svgFile}`);
    assert.ok(bySnap.text.includes('<rect width="4" height="4"/>'));
    const unstamped = await s.request('POST', '/api/snapshots', { body: { view: 'zero-view', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' } });
    assert.equal(unstamped.status, 400);
    assert.match(unstamped.json.error.message, /SYNTHETIC stamp/);
    assert.equal((await s.request('POST', '/api/snapshots', { body: {} })).status, 400);
    assert.equal((await s.request('POST', '/api/snapshots', { body: { png: 'data:image/png;base64,AAAA' } })).status, 400);
    assert.equal((await s.request('GET', '/api/snapshots/..%2Fscrolls.db')).status, 404);
    assert.equal((await s.request('GET', '/api/snapshots/missing.png')).status, 404);
  });
});

describe('annotations: every revision of every layer (fix pass)', () => {
  test('superseded and withdrawn layers, every revision, and relationship, context-group and expression targets are exported', () => {
    const ins = (target, ref, status, { anchor = null, supersedes = null } = {}) => Number(db.prepare(`INSERT INTO annotation (target_type,
        target_ref, anchor_json, kind, author, is_machine, supersedes, status, is_synthetic, current_rev, created_at)
      VALUES (?, ?, ?, 'interpretation', 'human:tester', 0, ?, ?, 1, 1, ?)`).run(target, String(ref), anchor, supersedes, status, nowIso()).lastInsertRowid);
    const rev = (id, n, body) => {
      db.prepare('INSERT INTO annotation_revision (annotation_id, rev, body_md, author, at) VALUES (?, ?, ?, ?, ?)').run(id, n, body, 'human:tester', nowIso());
      db.prepare('UPDATE annotation SET current_rev = ? WHERE id = ?').run(n, id);
    };
    const p = db.prepare("SELECT p.id, p.document_id FROM passage p JOIN document d ON d.id = p.document_id JOIN collection c ON c.id = d.collection_id WHERE c.slug = 'gen-text' LIMIT 1").get();
    const anchor = JSON.stringify({ doc_id: p.document_id, sha256: 'x', field: 'body', start: 0, end: 3, quote: 'the' });
    const old = ins('passage', p.id, 'superseded', { anchor });
    rev(old, 1, 'first reading');
    rev(old, 2, 'first reading, revised');
    const now = ins('passage', p.id, 'active', { anchor, supersedes: old });
    rev(now, 1, 'second reading');
    const docs = db.prepare("SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug = 'gen-text' LIMIT 2").all();
    const relId = Number(db.prepare(`INSERT INTO relationship (rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin,
        created_by, is_synthetic, created_at) VALUES ('proposed_allusion', 'document', ?, 'document', ?, 1, 'proposed', 'human', 'human:tester', 1, ?)`)
      .run(String(docs[0].id), String(docs[1].id), nowIso()).lastInsertRowid);
    const onRel = ins('relationship', relId, 'withdrawn');
    rev(onRel, 1, 'a link worth checking');
    const onExpr = ins('expression', zero, 'active');
    rev(onExpr, 1, 'the word as a whole');
    const rows = JSON.parse(run({ what: 'annotations', format: 'json' }).body).rows;
    const of = (id) => rows.filter((r) => r.annotation === id).map((r) => [r.rev, r.status, r.body_md]);
    assert.deepEqual(of(old), [[1, 'superseded', 'first reading'], [2, 'superseded', 'first reading, revised']], 'every revision of a superseded layer');
    assert.deepEqual(of(now), [[1, 'active', 'second reading']]);
    assert.equal(rows.find((r) => r.annotation === now).supersedes, old);
    assert.deepEqual(of(onRel), [[1, 'withdrawn', 'a link worth checking']], 'a withdrawn annotation on a relationship');
    assert.deepEqual(of(onExpr), [[1, 'active', 'the word as a whole']], 'an annotation on the expression');
    const jsonl = run({ what: 'annotations', format: 'jsonl' }).body.split('\n').filter(Boolean);
    assert.equal(jsonl.length - 1, rows.length, 'JSONL: the manifest line, then one line per revision');
  });
});
