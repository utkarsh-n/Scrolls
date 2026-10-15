// OWNER: WP0 — schema.sql executes verbatim; its CHECKs and triggers fire; migrate/seed/open behave (SPEC §3, §11)

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { dayFromYMD } from '../src/shared/dates.mjs';
import { FTS_TOKENIZE, normString } from '../src/shared/tokenize.mjs';
import { CORPORA, DIMENSIONS, LANGUAGE_PERIODS, REL_TYPES } from '../src/shared/vocab.mjs';
import { isUnderICloud } from '../server/config.mjs';
import { migrate, schemaSql, SCHEMA_VERSION } from '../server/db/migrate.mjs';
import { bumpDataVersion, dataVersion, getMeta, isConstraintError, nowIso, openDb, setMeta, tx } from '../server/db/open.mjs';
import { seedVocab } from '../server/db/seed-vocab.mjs';

const SPEC = new URL('../Docs/SPEC.md', import.meta.url);

/** A fresh in-memory DB with the schema executed verbatim. */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql());
  return db;
}

function throwsConstraint(fn, re) {
  assert.throws(fn, (err) => {
    assert.ok(isConstraintError(err), `expected a constraint error, got ${err.code} ${err.message}`);
    if (re) assert.match(err.message, re);
    return true;
  });
}

describe('schema.sql', () => {
  test('is the §3 DDL verbatim, except the documented tokenizer correction', () => {
    const lines = readFileSync(SPEC, 'utf8').split('\n');
    const start = lines.findIndex((l, i) => l === '```sql' && lines[i + 1]?.startsWith('-- server/db/schema.sql'));
    assert.ok(start > 0, 'DDL block found in SPEC.md');
    const end = lines.indexOf('```', start + 1);
    const specSql = `${lines.slice(start + 1, end).join('\n')}\n`;
    const fixed = specSql.replaceAll(`tokenize="unicode61 remove_diacritics 2 categories 'L* N* Co M*'"`, `tokenize="${FTS_TOKENIZE}"`);
    const file = schemaSql();
    const body = file.slice(file.indexOf('-- server/db/schema.sql'));
    assert.equal(body, fixed);
    assert.match(file.split('\n')[0], /^-- OWNER: WP0/);
  });

  test('executes on node:sqlite and creates every table, index, trigger and virtual table', () => {
    const db = freshDb();
    const names = (type) => db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type).map((r) => r.name);
    const tables = names('table');
    const ddl = schemaSql();
    for (const m of ddl.matchAll(/CREATE (?:VIRTUAL )?TABLE (\w+)/g)) assert.ok(tables.includes(m[1]), `table ${m[1]}`);
    for (const m of ddl.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)) assert.ok(names('index').includes(m[1]), `index ${m[1]}`);
    for (const m of ddl.matchAll(/CREATE TRIGGER (\w+)/g)) assert.ok(names('trigger').includes(m[1]), `trigger ${m[1]}`);
    db.close();
  });

  test('both FTS5 tables use FTS_TOKENIZE (So included, so ◉ and emoji are tokens)', () => {
    const db = freshDb();
    for (const t of ['passage_fts', 'annotation_fts']) {
      const sql = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(t).sql;
      assert.ok(sql.includes(FTS_TOKENIZE), `${t} tokenizer`);
    }
    db.exec(`INSERT INTO passage_fts (rowid, norm) VALUES (1, '${normString('The ◉ sticker 👍🏽 means sterilized')}')`);
    const terms = db.prepare('SELECT term FROM passage_vocab_inst ORDER BY offset').all().map((r) => r.term);
    assert.deepEqual(terms, ['the', '◉', 'sticker', '👍', 'means', 'sterilized']);
    db.close();
  });
});

describe('migrate, seed, open', () => {
  let dir;
  before(() => { dir = mkdtempSync(path.join(tmpdir(), 'scrolls-schema-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('migrate creates schema_version 1 with meta rows and is idempotent', () => {
    const db = openDb({ path: path.join(dir, 'm.db') });
    assert.deepEqual(migrate(db), { from: 0, to: SCHEMA_VERSION });
    assert.equal(getMeta(db, 'schema_version'), '1');
    assert.equal(getMeta(db, 'data_version'), '0');
    assert.equal(getMeta(db, 'tokenizer_version'), 'u61m-1');
    assert.equal(getMeta(db, 'segmenter_version'), 'seg-1');
    assert.equal(getMeta(db, 'icu_version'), process.versions.icu);
    assert.ok(getMeta(db, 'created_at'));
    assert.deepEqual(migrate(db), { from: 1, to: 1 });
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    setMeta(db, 'schema_version', 2);
    assert.throws(() => migrate(db), { code: 'E_SCHEMA_NEWER' });
    db.close();
    const foreign = openDb({ path: path.join(dir, 'f.db') });
    foreign.exec('CREATE TABLE other (x)');
    assert.throws(() => migrate(foreign), { code: 'E_DB_FOREIGN' });
    foreign.close();
  });

  test('seedVocab is idempotent and matches vocab.mjs', () => {
    const db = openDb({ path: path.join(dir, 's.db') });
    migrate(db);
    seedVocab(db);
    seedVocab(db);
    const n = (t) => db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
    assert.equal(n('rel_type'), REL_TYPES.length);
    assert.equal(REL_TYPES.length, 26);
    assert.equal(n('language_period'), LANGUAGE_PERIODS.length);
    assert.equal(n('dimension_def'), DIMENSIONS.length);
    assert.equal(n('corpus'), CORPORA.length);
    for (const r of REL_TYPES) {
      const row = db.prepare('SELECT * FROM rel_type WHERE code = ?').get(r.code);
      for (const k of ['family', 'directed', 'requires_precedence', 'implies_transmission', 'feedback_capable', 'glyph']) {
        assert.equal(row[k], r[k], `${r.code}.${k}`);
      }
    }
    for (const p of db.prepare('SELECT label FROM language_period').all()) assert.match(p.label, /— period of the language, not a date$/);
    assert.deepEqual(db.prepare("SELECT kind, is_synthetic FROM corpus WHERE slug = 'demo'").get(), { __proto__: null, kind: 'synthetic', is_synthetic: 1 });
    const pf = db.prepare("SELECT type, options_json FROM dimension_def WHERE key = 'pragmatic_function'").get();
    assert.equal(pf.type, 'enum');
    assert.deepEqual(JSON.parse(pf.options_json), ['sincere', 'ironic', 'parodic', 'reclaimed', 'pejorative', 'neutral', 'contested']);
    db.close();
  });

  test('tx commits, rolls back, nests with savepoints; data_version bumps', () => {
    const db = openDb({ path: path.join(dir, 't.db') });
    migrate(db);
    assert.equal(dataVersion(db), 0);
    tx(db, () => { setMeta(db, 'k', 'a'); bumpDataVersion(db); });
    assert.equal(getMeta(db, 'k'), 'a');
    assert.equal(dataVersion(db), 1);
    assert.throws(() => tx(db, () => { setMeta(db, 'k', 'b'); throw new Error('nope'); }), /nope/);
    assert.equal(getMeta(db, 'k'), 'a');
    tx(db, () => {
      setMeta(db, 'k', 'c');
      assert.throws(() => tx(db, () => { setMeta(db, 'k', 'inner'); throw new Error('inner'); }));
      assert.equal(getMeta(db, 'k'), 'c');
    });
    assert.equal(getMeta(db, 'k'), 'c');
    assert.equal(db.isTransaction, false);
    assert.equal(bumpDataVersion(db), 2);
    db.close();
  });

  test('read-only connections cannot write', () => {
    const p = path.join(dir, 'r.db');
    const w = openDb({ path: p });
    migrate(w);
    const r = openDb({ path: p, readOnly: true });
    assert.equal(r.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1');
    assert.throws(() => r.exec("INSERT INTO meta VALUES ('x', 'y')"), /readonly|read-only/i);
    r.close();
    w.close();
  });

  test('a database under iCloud is refused with E_DB_IN_ICLOUD and nothing is created', () => {
    const p = path.join(homedir(), 'Documents', `scrolls-must-not-exist-${process.pid}`, 'scrolls.db');
    assert.equal(isUnderICloud(p), true);
    assert.throws(() => openDb({ path: p }), { code: 'E_DB_IN_ICLOUD' });
    assert.equal(existsSync(path.dirname(p)), false);
    assert.equal(isUnderICloud(path.join(homedir(), 'Library', 'Mobile Documents', 'x.db')), true);
    assert.equal(isUnderICloud(path.join(tmpdir(), 'x.db')), false);
  });
});

describe('CHECKs and triggers', () => {
  let db;
  const now = nowIso();
  before(() => {
    db = freshDb();
    seedVocab(db);
    db.exec(`INSERT INTO source_adapter (id, version, label, access) VALUES ('file.csv', '1.0.0', 'CSV', 'local-file')`);
    db.prepare(`INSERT INTO analysis_run (id, stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
      input_fingerprint, data_version, tokenizer_version, segmenter_version, icu_version, status, started_at)
      VALUES (?, 'trace', 'trace@1.0.0', 'h', '{}', 'p', '{}', 'f', 0, 'u61m-1', 'seg-1', '78.3', ?, ?)`).run(1, 'succeeded', now);
    db.prepare(`INSERT INTO analysis_run (id, stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
      input_fingerprint, data_version, tokenizer_version, segmenter_version, icu_version, status, started_at)
      VALUES (?, 'trace', 'trace@1.0.0', 'h', '{}', 'p', '{}', 'f', 0, 'u61m-1', 'seg-1', '78.3', ?, ?)`).run(2, 'cancelled', now);
  });
  after(() => db.close());

  const rel = (o) => {
    const r = { rel_type: 'explicit_citation', src_type: 'document', src_ref: '2', dst_type: 'document', dst_ref: '1', directed: 1,
      evidence_status: 'documented', origin: 'source_dataset', source_dataset: 'wikipedia', source_locator: 'https://en.wikipedia.org/wiki/X',
      provenance_quality: 'complete', method: null, run_id: null, created_by: 'adapter:test@1', score: null, score_kind: null, ...o };
    return db.prepare(`INSERT INTO relationship (rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin,
      source_dataset, source_locator, provenance_quality, method, run_id, created_by, score, score_kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.rel_type, r.src_type, r.src_ref, r.dst_type, r.dst_ref, r.directed, r.evidence_status, r.origin, r.source_dataset,
        r.source_locator, r.provenance_quality, r.method, r.run_id, r.created_by, r.score, r.score_kind, now).lastInsertRowid;
  };

  test('inferred lineage can never be stored as documented', () => {
    throwsConstraint(() => rel({ origin: 'algorithm', run_id: 1, method: 'winnow' }));
    throwsConstraint(() => rel({ origin: 'human', created_by: 'human:utkarsh' }));
    throwsConstraint(() => rel({ origin: 'machine_tagger', method: 'tagging pass' }));
    throwsConstraint(() => rel({ source_locator: null }));                       // documented without locator
    throwsConstraint(() => rel({ source_dataset: null }));                       // documented without dataset
    assert.ok(rel({ source_locator: null, provenance_quality: 'source_unrecorded' })); // DOC*
    assert.ok(rel({}));
  });

  test('status is bound to origin', () => {
    throwsConstraint(() => rel({ evidence_status: 'proposed' }));                 // source_dataset must be documented
    throwsConstraint(() => rel({ evidence_status: 'computed', origin: 'algorithm', run_id: null, method: 'm', source_dataset: null, source_locator: null }));
    throwsConstraint(() => rel({ evidence_status: 'computed', origin: 'algorithm', run_id: 1, method: null, source_dataset: null, source_locator: null }));
    throwsConstraint(() => rel({ evidence_status: 'computed', origin: 'human', created_by: 'human:x', source_dataset: null, source_locator: null }));
    throwsConstraint(() => rel({ evidence_status: 'computed', origin: 'machine_tagger', method: 'm', source_dataset: null, source_locator: null }));
    throwsConstraint(() => rel({ evidence_status: 'proposed', origin: 'machine_tagger', method: null, source_dataset: null, source_locator: null }));
    throwsConstraint(() => rel({ evidence_status: 'proposed', origin: 'human', created_by: 'adapter:x@1', source_dataset: null, source_locator: null }));
    throwsConstraint(() => rel({ score: 0.5, score_kind: null }));
    assert.ok(rel({ evidence_status: 'computed', origin: 'algorithm', run_id: 1, method: 'winnow k=8', source_dataset: null, source_locator: null, score: 1, score_kind: 'match_ratio' }));
    assert.ok(rel({ evidence_status: 'proposed', origin: 'machine_tagger', method: 'tagging pass', source_dataset: null, source_locator: null }));
    assert.ok(rel({ evidence_status: 'proposed', origin: 'human', created_by: 'human:utkarsh', source_dataset: null, source_locator: null }));
  });

  test('evidence fields are immutable; review is a separate layer; relationships are never deleted', () => {
    const id = rel({});
    for (const [col, v] of [['evidence_status', "'proposed'"], ['src_ref', "'9'"], ['dst_ref', "'9'"], ['method', "'x'"],
      ['origin', "'human'"], ['rel_type', "'samples'"], ['run_id', '1'], ['source_dataset', "'x'"], ['directed', '0']]) {
      throwsConstraint(() => db.exec(`UPDATE relationship SET ${col} = ${v} WHERE id = ${id}`), /immutable/);
    }
    db.exec(`UPDATE relationship SET review_status = 'rejected', current_rev = 2 WHERE id = ${id}`);
    assert.equal(db.prepare('SELECT review_status, evidence_status FROM relationship WHERE id = ?').get(id).evidence_status, 'documented');
    throwsConstraint(() => db.exec(`DELETE FROM relationship WHERE id = ${id}`), /never deleted/);
    const fromCancelled = rel({ evidence_status: 'computed', origin: 'algorithm', run_id: 2, method: 'winnow', source_dataset: null, source_locator: null });
    db.exec(`DELETE FROM relationship WHERE id = ${fromCancelled}`); // gc-runs may remove rows of cancelled runs
    assert.equal(db.prepare('SELECT count(*) AS n FROM relationship WHERE id = ?').get(fromCancelled).n, 0);
  });

  test('revisions are append-only', () => {
    const id = rel({});
    db.prepare(`INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, after_json) VALUES (?, 1, 'adapter:t@1', ?, 'create', '{}')`).run(id, now);
    throwsConstraint(() => db.exec(`UPDATE relationship_revision SET reason = 'x' WHERE relationship_id = ${id}`), /append-only/);
    throwsConstraint(() => db.exec(`DELETE FROM relationship_revision WHERE relationship_id = ${id}`), /append-only/);
    throwsConstraint(() => db.prepare(`INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, after_json) VALUES (?, 1, 'h', ?, 'confirm', '{}')`).run(id, now));
    const ann = db.prepare(`INSERT INTO annotation (target_type, target_ref, kind, author, is_machine, created_at)
      VALUES ('document', '1', 'interpretation', 'human:u', 0, ?)`).run(now).lastInsertRowid;
    db.prepare(`INSERT INTO annotation_revision (annotation_id, rev, body_md, author, at) VALUES (?, 1, 'reading', 'human:u', ?)`).run(ann, now);
    throwsConstraint(() => db.exec(`UPDATE annotation_revision SET body_md = 'changed' WHERE annotation_id = ${ann}`), /append-only/);
    throwsConstraint(() => db.exec(`DELETE FROM annotation_revision WHERE annotation_id = ${ann}`), /append-only/);
  });

  test('annotation CHECKs: anchors for passages/occurrences, methods for machine output', () => {
    throwsConstraint(() => db.prepare(`INSERT INTO annotation (target_type, target_ref, kind, author, is_machine, created_at)
      VALUES ('passage', '7', 'interpretation', 'human:u', 0, ?)`).run(now));
    throwsConstraint(() => db.prepare(`INSERT INTO annotation (target_type, target_ref, kind, author, is_machine, created_at)
      VALUES ('document', '7', 'machine_gloss', 'cipher', 1, ?)`).run(now));
    assert.ok(db.prepare(`INSERT INTO annotation (target_type, target_ref, anchor_json, kind, author, is_machine, created_at)
      VALUES ('passage', '7', '{"doc_id":1}', 'interpretation', 'human:u', 0, ?)`).run(now).lastInsertRowid);
    throwsConstraint(() => db.prepare(`INSERT INTO annotation_revision (annotation_id, rev, body_md, dimensions_json, author, at)
      VALUES (1, 9, 'x', 'not json', 'human:u', ?)`).run(now));
  });

  test('a gated drift result carries no value', () => {
    const ins = (gate, value, ci) => db.prepare(`INSERT INTO drift_result (run_id, expression_id, slice_a_json, slice_b_json, metric,
      value, ci_lo, ci_hi, gate, gate_detail_json) VALUES (1, 1, '{}', '{}', 'sense_share_jsd', ?, ?, ?, ?, '{}')`).run(value, ci, ci, gate);
    throwsConstraint(() => ins('insufficient_occurrences', 0.4, null));
    throwsConstraint(() => ins('slice_too_small', null, 0.1));
    throwsConstraint(() => ins('not_a_gate', null, null));
    assert.ok(ins('insufficient_occurrences', null, null));
    assert.ok(ins('ok', 0.71, 0.62));
  });

  test('saved views are immutable (soft delete allowed)', () => {
    db.prepare(`INSERT INTO saved_view (slug, name, state_json, state_version, state_hash, data_version, max_import_batch,
      run_ids_json, annotation_rev_cutoff, relationship_rev_cutoff, created_by, created_at)
      VALUES ('carry-the-zero-3f9a', 'v', '{}', 1, 'h', 47, 42, '{}', 10, 5, 'human:u', ?)`).run(now);
    for (const col of ['state_json', 'slug', 'state_hash', 'data_version', 'max_import_batch', 'run_ids_json', 'annotation_rev_cutoff', 'relationship_rev_cutoff']) {
      throwsConstraint(() => db.exec(`UPDATE saved_view SET ${col} = ${col === 'slug' || col.endsWith('json') || col === 'state_hash' ? "'{\"x\":1}'" : '99'} WHERE slug = 'carry-the-zero-3f9a'`), /immutable/);
    }
    db.prepare("UPDATE saved_view SET deleted_at = ? WHERE slug = 'carry-the-zero-3f9a'").run(now);
    throwsConstraint(() => db.prepare(`INSERT INTO saved_view (slug, name, state_json, state_version, state_hash, data_version,
      max_import_batch, run_ids_json, annotation_rev_cutoff, relationship_rev_cutoff, created_by, created_at)
      VALUES ('carry-the-zero-3f9a', 'v', '{}', 1, 'h', 1, 1, '{}', 1, 1, 'human:u', ?)`).run(now));
  });

  test('expression keys: unique index with NULL language and corpus (the proposal bug is fixed)', () => {
    const ex = (lang, corpus) => db.prepare(`INSERT INTO expression (corpus_id, kind, surface, norm, lang, origin, created_by, created_at)
      VALUES (?, 'phrase', 'carry the zero', 'carry the zero', ?, 'user_query', 'human:u', ?)`).run(corpus, lang, now).lastInsertRowid;
    const e = ex(null, null);
    throwsConstraint(() => ex(null, null));
    assert.ok(ex('en', null));
    const v = (lang) => db.prepare(`INSERT INTO expression_variant (expression_id, form, norm, lang, variant_type, rule, evidence_status)
      VALUES (?, 'carries the zero', 'carries the zero', ?, 'inflection', 'en-inflect@1', 'computed')`).run(e, lang);
    v(null);
    throwsConstraint(() => v(null));
    v('en');
  });

  test('corpus, adapter, document, date and bin CHECKs', () => {
    throwsConstraint(() => db.prepare("INSERT INTO corpus (slug, name, kind, is_synthetic, created_at) VALUES ('fake', 'x', 'synthetic', 0, ?)").run(now));
    throwsConstraint(() => db.prepare("INSERT INTO corpus (slug, name, kind, is_synthetic, created_at) VALUES ('fake2', 'x', 'real', 1, ?)").run(now));
    throwsConstraint(() => db.exec("INSERT INTO source_adapter (id, version, label, access, enabled) VALUES ('net', '1.0.0', 'n', 'network', 1)"));
    db.exec("INSERT INTO source_adapter (id, version, label, access, enabled) VALUES ('net', '1.0.0', 'n', 'network', 0)");

    const corpusId = db.prepare("SELECT id FROM corpus WHERE slug = 'user'").get().id;
    const coll = db.prepare(`INSERT INTO collection (corpus_id, adapter_id, slug, name, domain, modality, unit, sampling, created_at)
      VALUES (?, 'file.csv', 'c', 'c', 'imported', 'text', 'tokens', 'user', ?)`).run(corpusId, now).lastInsertRowid;
    throwsConstraint(() => db.prepare(`INSERT INTO collection (corpus_id, adapter_id, slug, name, domain, modality, unit, sampling, created_at)
      VALUES (?, 'file.csv', 'c2', 'c', 'music', 'text', 'tokens', 'user', ?)`).run(corpusId, now));
    const batch = db.prepare(`INSERT INTO import_batch (collection_id, adapter_id, adapter_version, format, status, created_at)
      VALUES (?, 'file.csv', '1', 'csv', 'committing', ?)`).run(coll, now).lastInsertRowid;
    const doc = (o) => db.prepare(`INSERT INTO document (collection_id, import_batch_id, ext_id, kind, lo_day, hi_day, chrono_status,
      original_meta_json, created_at) VALUES (?, ?, ?, 'book', ?, ?, ?, '{}', ?)`).run(coll, batch, o.ext, o.lo, o.hi, o.status, now).lastInsertRowid;
    throwsConstraint(() => doc({ ext: 'a', lo: 10, hi: 20, status: 'undated' }));
    throwsConstraint(() => doc({ ext: 'b', lo: null, hi: null, status: 'dated' }));
    throwsConstraint(() => doc({ ext: 'c', lo: 20, hi: 10, status: 'dated' }));
    const d = doc({ ext: 'd', lo: 10, hi: 20, status: 'dated' });
    assert.ok(doc({ ext: 'e', lo: null, hi: null, status: 'undated' }));
    throwsConstraint(() => doc({ ext: 'd', lo: 10, hi: 20, status: 'dated' })); // UNIQUE (collection, ext_id)
    throwsConstraint(() => db.prepare(`INSERT INTO document (collection_id, import_batch_id, ext_id, kind, chrono_status, original_meta_json, created_at)
      VALUES (?, ?, 'f', 'book', 'undated', 'not json', ?)`).run(coll, batch, now));

    const da = (o) => db.prepare(`INSERT INTO date_assertion (subject_type, subject_id, role, lo_day, hi_day, precision, basis, asserted_by, is_chronology)
      VALUES ('document', ?, 'publication', ?, ?, ?, 'stated', 't', ?)`).run(d, o.lo, o.hi, o.precision, o.chrono ?? 0);
    throwsConstraint(() => da({ lo: 1, hi: 2, precision: 'unknown' }));
    throwsConstraint(() => da({ lo: null, hi: null, precision: 'year' }));
    throwsConstraint(() => da({ lo: 1, hi: 2, precision: 'fortnight' }));
    da({ lo: 1, hi: 2, precision: 'year', chrono: 1 });
    throwsConstraint(() => da({ lo: 3, hi: 4, precision: 'year', chrono: 1 })); // one chronology per subject
    da({ lo: 3, hi: 4, precision: 'year', chrono: 0 });

    throwsConstraint(() => db.prepare('INSERT INTO doc_bin (level, bin, document_id) VALUES (4, 1, ?)').run(d));
    throwsConstraint(() => db.prepare("INSERT INTO doc_tokens (document_id, plang, field_class, tokens, passages) VALUES (?, 'en', 'body', 1, 1)").run(d));
    throwsConstraint(() => db.prepare('INSERT INTO doc_bin (level, bin, document_id) VALUES (1, 19, 999999)').run()); // foreign key
  });

  test('rtree_i32 holds BCE day numbers', () => {
    const pie = dayFromYMD(-4499, 1, 1), pieEnd = dayFromYMD(-2499, 12, 31);
    const latin = dayFromYMD(-699, 1, 1), latinEnd = dayFromYMD(1500, 12, 31);
    db.prepare('INSERT INTO date_rtree (id, lo_day, hi_day) VALUES (?, ?, ?)').run(9001, pie, pieEnd);
    db.prepare('INSERT INTO date_rtree (id, lo_day, hi_day) VALUES (?, ?, ?)').run(9002, latin, latinEnd);
    const hits = (lo, hi) => db.prepare('SELECT id FROM date_rtree WHERE hi_day >= ? AND lo_day <= ? AND id > 9000 ORDER BY id').all(lo, hi).map((r) => r.id);
    assert.deepEqual(hits(dayFromYMD(-3000), dayFromYMD(-2900)), [9001]);
    assert.deepEqual(hits(dayFromYMD(-2000), dayFromYMD(-1500)), []);
    assert.deepEqual(hits(dayFromYMD(-2600), dayFromYMD(-600)), [9001, 9002]);
    assert.deepEqual(hits(dayFromYMD(-100), dayFromYMD(100)), [9002]);
    assert.ok(pie < -2_300_000);
  });

  test('FTS: Devanagari/Gujarati whole tokens, vocab instances, contentless delete, trigram typeahead', () => {
    db.exec('DELETE FROM passage_fts');
    const add = (id, text) => db.prepare('INSERT INTO passage_fts (rowid, norm) VALUES (?, ?)').run(id, normString(text));
    add(11, 'शून्य को साथ ले चल, अनुपम');
    add(12, 'ગુજરાતી નિશાળમાં શૂન્ય');
    add(13, 'carry the zero');
    const match = (q) => db.prepare('SELECT rowid FROM passage_fts WHERE passage_fts MATCH ? ORDER BY rowid').all(q).map((r) => r.rowid);
    assert.deepEqual(match('"अनुपम"'), [11]);
    assert.deepEqual(match('"ગુજરાતી"'), [12]);
    assert.deepEqual(match('"शून्य को साथ"'), [11]);
    assert.deepEqual(match('"carry the zero"'), [13]);
    const inst = db.prepare("SELECT doc, offset FROM passage_vocab_inst WHERE term = 'शून्य'").all();
    assert.deepEqual(inst.map((r) => [r.doc, r.offset]), [[11, 0]]);
    db.exec('DELETE FROM passage_fts WHERE rowid = 13');
    assert.deepEqual(match('"carry the zero"'), []);
    const lab = db.prepare('INSERT INTO label_tri (label, kind, ref) VALUES (?, ?, ?)');
    lab.run('Hackers', 'title', 'document:1');
    lab.run('Thackeray', 'maker', 'document:2');
    lab.run('Zero Hour', 'title', 'document:3');
    const tri = (q) => db.prepare('SELECT ref FROM label_tri WHERE label_tri MATCH ? ORDER BY ref').all(q).map((r) => r.ref);
    assert.deepEqual(tri('"hack"'), ['document:1', 'document:2']); // why trigram is typeahead only, never counts
    assert.deepEqual(tri('"zero h"'), ['document:3']);
  });
});
