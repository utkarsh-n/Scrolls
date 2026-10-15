// OWNER: R — RF-1 (IOS-SPEC §2.1): the language rule of every count and denominator (server/aggregate/langgate.mjs).
// The JS rule, its SQL twin and the clustering filter agree on every combination of strand languages, passage language,
// field class and document language.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { DOC_TEXT_CLASSES, isUnidentified, langAdmits, langAdmitsSql, UNIDENTIFIED_LANGS } from '../server/aggregate/langgate.mjs';
import { clusterFilter } from '../server/analysis/tfidf-hash.mjs';

const EN = ['en', 'und', 'und-Latn'];
const FIELD_CLASSES = ['text', 'title', 'abstract', 'describes', 'apparatus'];
const PLANGS = ['en', 'es', 'fr', 'hi', 'und', 'und-Latn'];
const DOC_LANGS = [null, 'en', 'es', 'fr', 'hi', 'und', 'und-Latn'];
const STRANDS = [EN, ['es', 'und', 'und-Latn'], ['hi'], ['de', 'en', 'es', 'fr', 'hi', 'it', 'la', 'pt', 'und', 'und-Latn'], ['und']];

describe('RF-1: unidentified text belongs to its document\'s language', () => {
  test('the rule, case by case', () => {
    assert.deepEqual(UNIDENTIFIED_LANGS, ['und', 'und-Latn']);
    assert.deepEqual(DOC_TEXT_CLASSES, ['text', 'abstract', 'apparatus']);
    for (const l of ['und', 'und-Latn', 'und-Deva', null, undefined, '']) assert.equal(isUnidentified(l), true, String(l));
    for (const l of ['en', 'fr', 'hi', 'under']) assert.equal(isUnidentified(l), false, l);
    // identified rows: the passage language alone decides
    assert.equal(langAdmits(EN, 'en', 'text', 'es'), true, 'an English paragraph of a Spanish book is English text');
    assert.equal(langAdmits(EN, 'es', 'text', 'en'), false);
    // unidentified running text: the document's language decides
    assert.equal(langAdmits(EN, 'und', 'text', 'en'), true);
    assert.equal(langAdmits(EN, 'und', 'text', 'es'), false, 'a heading of a Spanish book is not English text');
    assert.equal(langAdmits(EN, 'und-Latn', 'apparatus', 'fr'), false);
    assert.equal(langAdmits(EN, 'und', 'abstract', 'de'), false);
    assert.equal(langAdmits(EN, 'und', 'text', 'und'), true, 'a document with no identified passage keeps its rows');
    assert.equal(langAdmits(EN, 'und', 'text', null), true);
    // titles and describing passages keep their own language
    assert.equal(langAdmits(EN, 'und-Latn', 'title', 'hi'), true, 'the English label of a Hindi film is an English title');
    assert.equal(langAdmits(EN, 'und-Latn', 'describes', 'hi'), true);
    // any language, and the strand's own languages first
    assert.equal(langAdmits(null, 'und', 'text', 'es'), true);
    assert.equal(langAdmits(['hi'], 'und', 'text', 'hi'), false, 'a Hindi word has no unidentified bucket');
    assert.equal(langAdmits(new Set(EN), 'und', 'text', 'es'), false, 'a Set works like an array');
  });

  test('the SQL twin and the clustering filter agree with the rule on every combination', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE r (plang TEXT, fc TEXT, dlang TEXT)');
    const ins = db.prepare('INSERT INTO r VALUES (?, ?, ?)');
    for (const p of PLANGS) for (const fc of FIELD_CLASSES) for (const d of DOC_LANGS) ins.run(p, fc, d);
    const all = db.prepare('SELECT rowid AS id, * FROM r').all();
    const { reason } = clusterFilter({ tr: 1, ds: 1, ap: 1, dup: 1, nm: 1, est: 1 });
    let checked = 0;
    for (const langs of STRANDS) {
      const g = langAdmitsSql({ plang: 'r.plang', fc: 'r.fc', dlang: 'r.dlang' }, langs);
      const admitted = new Set(db.prepare(`SELECT rowid AS id FROM r WHERE ${g.sql}`).all(...g.params).map((x) => x.id));
      for (const row of all) {
        const want = langAdmits(langs, row.plang, row.fc, row.dlang);
        assert.equal(admitted.has(row.id), want, `SQL ${JSON.stringify(langs)} ${row.plang} ${row.fc} ${row.dlang}`);
        const occ = { deleted_at: null, rate_eligible: 1, name_flag: 0, is_translation: 0, dup_of: null, basis: 'stated', quality: 'ok',
          field_class: row.fc, lang: row.plang, lang_text: row.dlang };
        const why = reason(occ, new Set(langs));
        if (row.fc === 'text' || row.fc === 'abstract' || row.fc === 'title') {
          assert.equal(why === 'other_language', !want, `cluster filter ${JSON.stringify(langs)} ${row.plang} ${row.fc} ${row.dlang}`);
        }
        checked++;
      }
    }
    db.close();
    assert.equal(checked, STRANDS.length * PLANGS.length * FIELD_CLASSES.length * DOC_LANGS.length);
  });
});
