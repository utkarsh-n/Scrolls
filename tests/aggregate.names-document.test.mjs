// OWNER: WP3 (fix pass) — the proper-noun guard over a whole document (names.mjs rule (d)) and possessive variants.
// The adversarial data review found 109 of the 122 default Cipher 'gene' matches were the character 'Gene of The
// Brimming Cup (1921): mid-sentence ones caught by the elision rule (a'), but sentence-initial ones ("'Gene was off
// working") and possessives ("'Gene's mother", the variant gene + s) still counted. Invented test documents only.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { materializeInline, trackExpression } from '../server/aggregate/materialize.mjs';
import { documentNameRule, NAME_RECURRENCE_MIN } from '../server/text/names.mjs';
import { loadMini, makeTmpData } from './helpers/tmpdata.mjs';

const doc = (ext_id, text, year, author = 'Ada Fixture (synthetic)') => ({
  ext_id, kind: 'book', title: `Fixture ${ext_id}`, author, community: 'literature', lang_declared: 'en',
  text: { original: text, decoder: 'utf-8', mode: 'prose' },
  dates: [{ role: 'publication', raw: String(year), asserted_by: 'fixture:names', is_chronology: true }],
  original_meta: { fixture: 'names-document', note: 'invented test document' },
});

// a novel whose character is called 'Gene: never "gene" in lower case
const NOVEL = [
  "The farm lay quiet in the long evening, and the barn stood dark against the hill above the river road.",
  "If 'Gene heard the cart, he did not turn round, and the dogs kept their places by the gate all evening.",
  "She saw again poor 'Gene's outraged face at the door, and she said nothing more to anyone about the deed.",
  "They planted the elms that his grandfather had chosen, and the trees grew straight and high over the house.",
  "'Gene was off working in the far field when the letter came, and nobody went out to fetch him back again.",
  "'Gene's mother came to the door with her apron full of beans and looked down the road toward the bridge.",
  "The best thing to do with Gene was to keep him busy, his mother said, and nobody in the house disagreed.",
  "Nelly waited for 'Gene by the gate until the stars came out and the cold came up from the wet meadow.",
].join('\n\n');
// a science book: the word in lower case, and a capitalized heading use
const SCIENCE = [
  'Every gene in the chromosome is copied before the cell divides, and the copies are checked for errors.',
  'Gene expression varies from tissue to tissue, and a gene may be silent in one organ but active in another.',
  "The selfish gene is a way of describing what is copied, not a claim about anyone's intentions or plans.",
].join('\n\n');

let tmp, db, exprId, run;
before(() => {
  tmp = makeTmpData({ seed: false });
  db = tmp.db;
  loadMini(db, { docs: [doc('names:novel', NOVEL, 1921), doc('names:science', SCIENCE, 1976)], slug: 'names' });
  exprId = trackExpression(db, { surface: 'gene', lang: 'en', corpus: 'test' }).id;
  run = materializeInline(db, exprId);
});
after(() => tmp.cleanup());

const rowsOf = (ext) => db.prepare(`SELECT o.start_off, o.end_off, o.name_flag FROM occurrence o JOIN document d ON d.id = o.document_id
  WHERE o.run_id = ? AND d.ext_id = ? ORDER BY o.start_off`).all(run.run, ext);
const exprDoc = (ext) => db.prepare(`SELECT SUM(x.n) AS n, SUM(x.n_names) AS names, SUM(x.n_passages) AS passages FROM expr_doc x
  JOIN document d ON d.id = x.document_id WHERE x.run_id = ? AND d.ext_id = ? AND x.field_class = 'text'`).get(run.run, ext);

describe('the proper-noun guard over a whole document (rule d) and possessives (fix pass, §13 rule 9)', () => {
  test('rule (d) needs repeated name evidence and no lower-case use in the document', () => {
    assert.equal(documentNameRule({ flagged: NAME_RECURRENCE_MIN, lower: 0, capitalized: 2 }), true);
    assert.equal(documentNameRule({ flagged: NAME_RECURRENCE_MIN - 1, lower: 0, capitalized: 2 }), false, 'too little evidence');
    assert.equal(documentNameRule({ flagged: 9, lower: 1, capitalized: 2 }), false, 'the document also uses the word');
    assert.equal(documentNameRule({ flagged: 9, lower: 0, capitalized: 0 }), false, 'nothing to move');
  });

  test("a character's name is excluded throughout the novel: mid-sentence, possessive and sentence-initial", () => {
    const occ = rowsOf('names:novel');
    assert.equal(occ.length, 6, 'every Gene / Gene\'s of the novel is an occurrence');
    assert.deepEqual(occ.filter((o) => !o.name_flag), [], 'none counted');
    const x = exprDoc('names:novel');
    assert.equal(x.n, 0);
    assert.equal(x.names, 6);
    assert.equal(x.passages, 0);
  });

  test('in the science book the word counts, lower case and capitalized alike; the run\'s totals agree with expr_doc', () => {
    const occ = rowsOf('names:science');
    assert.ok(occ.length >= 4);
    assert.deepEqual(occ.filter((o) => o.name_flag), [], 'no name in the science book');
    const x = exprDoc('names:science');
    assert.equal(x.n, occ.length);
    const state = db.prepare('SELECT occ_total, docs_total, names_excluded FROM expression_state WHERE expression_id = ?').get(exprId);
    assert.equal(state.occ_total, occ.length, 'the expression counts only the science book');
    assert.equal(state.docs_total, 1);
    assert.equal(state.names_excluded, 6);
    const metrics = JSON.parse(db.prepare('SELECT metrics_json FROM analysis_run WHERE id = ?').get(run.run).metrics_json);
    const counted = Object.values(metrics.by_variant).reduce((a, b) => a + b, 0);
    const names = Object.values(metrics.names_by_variant).reduce((a, b) => a + b, 0);
    assert.equal(counted, occ.length);
    assert.equal(names, 6);
  });
});
