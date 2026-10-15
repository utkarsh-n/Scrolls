// OWNER: WP2 — gutenberg-stemm translations: the catalogue rule, the writer's handling of a credited translation, and the
// boot repair of rows loaded before the rule existed (§6.3, D8)

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fromInterval } from '../src/shared/dates.mjs';
import { translationReason } from '../server/adapters/stemm/translation.mjs';
import { paths } from '../server/config.mjs';
import { repairData } from '../server/db/migrate.mjs';
import { createBatch, createDocumentWriter, ensureCollection } from '../server/store/document-writer.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

const NOW = new Date('2026-10-09T12:00:00Z');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

const PLINY = { id: 60688, title: 'The Natural History of Pliny, Volume 5 (of 6)', date_basis: 'author-lifetime-estimate', year_lo: 44, year_hi: 79,
  authors: [{ name: 'Pliny, the Elder', role: null }, { name: 'Bostock, John', role: 'Translator' }] };
const BOYS_PLINY = { id: 58589, date_basis: 'author-lifetime-estimate', year_lo: 44, year_hi: 79,
  authors: [{ name: 'Pliny, the Elder', role: null }, { name: 'White, John S. (John Stuart)', role: null }] };
const DARWIN = { id: 1228, date_basis: 'author-lifetime-estimate', year_lo: 1829, year_hi: 1882, authors: [{ name: 'Darwin, Charles', role: null }] };

describe('translationReason', () => {
  test('a credited translator makes a translation', () => {
    assert.match(translationReason(PLINY), /credits a translator \(Bostock, John\)/);
  });
  test('an author whose estimated life ends before 1450 makes a later translation or adaptation', () => {
    assert.match(translationReason(BOYS_PLINY), /before 1450/);
  });
  test('a modern author with no translator is not a translation', () => {
    assert.equal(translationReason(DARWIN), null);
  });
  test('a stated early date is evidence, not a lifetime estimate: not flagged by the date rule', () => {
    assert.equal(translationReason({ date_basis: 'title-stated', year_hi: 1300, authors: [{ name: 'X', role: null }] }), null);
  });
  test('on the staged catalogue: Pliny, Agricola and Celsus are flagged, Darwin-era books are not', { skip: !existsSync(path.join(process.env.HOME, 'Developer/scrolls-data/sources/gutenberg-stemm/catalog.jsonl')) }, () => {
    const rows = readFileSync(path.join(process.env.HOME, 'Developer/scrolls-data/sources/gutenberg-stemm/catalog.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const flagged = new Set(rows.filter((r) => translationReason(r)).map((r) => r.id));
    for (const id of [60688, 38015, 64207, 58589]) assert.ok(flagged.has(id), `pg ${id} should be flagged`);
    const early = rows.filter((r) => r.language === 'en' && r.date_basis === 'author-lifetime-estimate' && r.year_hi < 1450);
    assert.ok(early.every((r) => flagged.has(r.id)), 'every English text dated by a pre-1450 life is flagged');
  });
});

describe('DocumentWriter and the boot repair', () => {
  let t, db;
  before(() => {
    t = makeTmpData();
    db = t.db;
    const mini = one(db, "SELECT * FROM collection WHERE slug = 'mini'");
    ensureCollection(db, { corpus: 'stemm', adapter_id: mini.adapter_id, slug: 'stemm-gutenberg', name: 'Gutenberg STEMM (test)',
      domain: mini.domain, modality: mini.modality, unit: mini.unit, sampling: mini.sampling });
  });
  after(() => t.cleanup());

  const text = 'Of the poison of serpents and the virus of the asp, which the ancients feared above all other venoms in the field. '.repeat(30);
  const doc = (ext, meta, extra = {}) => ({ ext_id: ext, kind: 'book', title: ext, author: 'Pliny the Elder', lang_declared: 'en',
    text: { original: text, decoder: 'utf-8' },
    dates: [{ role: 'publication', asserted_by: 'test', is_chronology: true,
      parsed: fromInterval(44, 79, { precision: 'range', basis: 'estimated', rule: 'test', raw: '44–79' }) }], original_meta: meta, ...extra });
  const write = (d) => {
    const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: 'stemm-gutenberg' }), collection: 'stemm-gutenberg', options: { now: NOW } });
    const r = w.addDocument(d);
    const counts = w.finish();
    return { r, counts };
  };

  test('a credited translation is flagged, dated as the original publication, and counted as a translation', () => {
    const { r, counts } = write(doc('pgs:60688', PLINY, { translation: { reason: translationReason(PLINY) } }));
    assert.ok(r.documentId);
    assert.deepEqual(r.issues.map((i) => i.code), ['W_TRANSLATION_CREDITED']);
    assert.equal(r.issues[0].severity, 'info');
    const d = one(db, 'SELECT is_translation, original_lang, date_role, lang_text FROM document WHERE id = ?', r.documentId);
    assert.deepEqual({ ...d }, { is_translation: 1, original_lang: null, date_role: 'original_publication', lang_text: 'en' });
    const a = one(db, "SELECT role, note FROM date_assertion WHERE subject_type = 'document' AND subject_id = ? AND is_chronology = 1", r.documentId);
    assert.equal(a.role, 'original_publication');
    assert.match(a.note, /credits a translator/);
    assert.equal(counts.documents.translations, 1);
  });

  test('the boot repair flags rows loaded before the rule, once, and invalidates cached slices', () => {
    const { r } = write(doc('pgs:58589', BOYS_PLINY)); // an old load: no translation hint
    assert.equal(one(db, 'SELECT is_translation FROM document WHERE id = ?', r.documentId).is_translation, 0);
    const dv = Number(one(db, "SELECT value FROM meta WHERE key = 'data_version'").value);
    const first = repairData(db);
    assert.equal(first.stemm_translations, 1);
    const d = one(db, 'SELECT is_translation, date_role FROM document WHERE id = ?', r.documentId);
    assert.deepEqual({ ...d }, { is_translation: 1, date_role: 'original_publication' });
    assert.equal(one(db, "SELECT role FROM date_assertion WHERE subject_type = 'document' AND subject_id = ? AND is_chronology = 1", r.documentId).role,
      'original_publication');
    assert.equal(Number(one(db, "SELECT value FROM meta WHERE key = 'data_version'").value), dv + 1);
    assert.ok(Number(one(db, "SELECT value FROM meta WHERE key = 'quality_version'").value) >= 1);
    assert.equal(repairData(db).stemm_translations, 0, 'idempotent');
  });

  test('the test data dir is a temp dir, never the live one', () => {
    assert.ok(!paths().db.includes('Developer/scrolls-data'));
  });
});
