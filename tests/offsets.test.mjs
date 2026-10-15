// OWNER: WP3 — every displayed occurrence opens its original passage (SPEC §11 row 3, I2, D4).
//
// Property test over ≥ 5,000 occurrences of a generated en/fr/es/hi/gu corpus whose originals carry combining
// marks, ZWJ, long s, emoji with modifiers, CRLF, a BOM and Gutenberg _italics_: the original slice at the stored
// UTF-16 offsets folds to the matched variant, lies inside its passage, and the passage endpoint's highlights
// slice to the same tokens; JS tokens agree with the FTS index position by position.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mulberry32 } from '../src/shared/ids.mjs';
import { normString, tokenize } from '../src/shared/tokenize.mjs';
import { materializeInline, trackExpression } from '../server/aggregate/materialize.mjs';
import { documentOriginal, kwic, passageText } from '../server/text/kwic.mjs';
import { documentTextQuery } from '../server/routes/documents.mjs';
import { passageQuery } from '../server/routes/passages.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';
import { assertShape } from './helpers/shape.mjs';
import { buildGeneratedCorpus } from './aggregate.corpus.mjs';

const SURFACES = [['zero', 'en'], ['the', 'en'], ['carry the zero', 'en'], ['gene', 'en'], ['zéro', 'fr'], ['la', 'fr'], ['de', 'es'],
  ['cero', 'es'], ['शून्य', 'hi'], ['की', 'hi'], ['कलम', 'hi'], ['चाँद', 'hi'], ['શૂન્ય', 'gu'], ['માં', 'gu'], ['◉', null], ['👍', null],
  ['ſaid', 'en'], ['क्षण', 'hi'], ['cooperative', 'en']];

describe('offsets round-trip (UTF-16 code units into the original)', () => {
  let tmp, db, occs;
  before(() => {
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    buildGeneratedCorpus(db, { seed: 5, texts: 300 });
    for (const [s, lang] of SURFACES) materializeInline(db, trackExpression(db, { surface: s, lang, corpus: 'test' }).id);
    occs = db.prepare(`SELECT o.*, v.norm AS vnorm, p.field, p.start_off AS ps, p.end_off AS pe, p.document_id AS pdoc
      FROM occurrence o JOIN expression_variant v ON v.id = o.variant_id JOIN passage p ON p.id = o.passage_id`).all();
  });
  after(() => tmp.cleanup());

  test('≥ 5,000 occurrences: the original slice folds to the matched variant and lies inside its passage', () => {
    assert.ok(occs.length >= 5000, `${occs.length} occurrences`);
    const kinds = { crlf: 0, bom: 0, combining: 0, zwj: 0, emoji: 0, longS: 0, italics: 0 };
    for (const o of occs) {
      assert.equal(o.document_id, o.pdoc);
      assert.ok(o.ps <= o.start_off && o.start_off < o.end_off && o.end_off <= o.pe, `occurrence ${o.id} inside passage ${o.passage_id}`);
      const base = o.field === 'body' ? documentOriginal(db, o.document_id)
        : db.prepare('SELECT value FROM document_field WHERE document_id = ? AND field = ?').get(o.document_id, o.field).value;
      const slice = base.slice(o.start_off, o.end_off);
      assert.equal(normString(slice), o.vnorm, `occurrence ${o.id}: '${slice}'`);
      // the slice starts and ends on token boundaries of the passage
      const ptext = base.slice(o.ps, o.pe);
      const t = tokenize(ptext);
      assert.ok(t.starts.includes(o.start_off - o.ps) && t.ends.includes(o.end_off - o.ps), `occurrence ${o.id} on token boundaries`);
      assert.equal(t.tokens[o.tok_index], o.vnorm.split(' ')[0], `occurrence ${o.id}: tok_index`);
      const pre = base.slice(0, o.start_off);
      if (pre.includes('\r\n')) kinds.crlf++;
      if (base.startsWith('﻿')) kinds.bom++;
      if (/\p{M}/u.test(pre.normalize('NFD').slice(-200)) && slice !== slice.normalize('NFC')) kinds.combining++;
      if (/[‌‍]/u.test(pre)) kinds.zwj++;
      if (/\p{Extended_Pictographic}/u.test(pre)) kinds.emoji++;
      if (pre.includes('ſ') || slice.includes('ſ')) kinds.longS++;
      if (base.slice(o.start_off - 1, o.start_off) === '_') kinds.italics++;
    }
    for (const [k, n] of Object.entries(kinds)) assert.ok(n > 0, `the corpus exercises ${k} before a match (${n})`);
  });

  test('passage payloads: text is the original slice; every highlight slices to its variant', () => {
    const rnd = mulberry32(3);
    const ids = [...new Set(occs.map((o) => o.passage_id))];
    for (let i = 0; i < 400; i++) {
      const id = ids[Math.floor(rnd() * ids.length)];
      const p = passageQuery(db, { id, context: true });
      assertShape('Passage', p);
      const row = db.prepare('SELECT * FROM passage WHERE id = ?').get(id);
      assert.equal(p.text, passageText(db, row));
      const doc = documentOriginal(db, row.document_id);
      if (row.field === 'body') assert.equal(p.text, doc.slice(p.start, p.end));
      const mine = occs.filter((o) => o.passage_id === id);
      assert.equal(p.highlights.length, mine.length);
      for (const h of p.highlights) {
        const o = mine.find((x) => x.id === h.occ);
        assert.ok(o, `highlight ${h.occ} is an occurrence of passage ${id}`);
        assert.equal(normString(p.text.slice(h.start, h.end)), o.vnorm);
        assert.equal(h.start + p.start, o.start_off);
      }
      if (p.before) assert.equal(p.before.text, passageText(db, db.prepare('SELECT * FROM passage WHERE id = ?').get(p.before.passage)));
      assert.equal(p.anchor.start, p.start);
      assert.equal(p.anchor.doc_id, row.document_id);
    }
  });

  test('KWIC lines are contiguous slices of the passage, ±12 tokens, never crossing its bounds', () => {
    for (const o of occs.slice(0, 1500)) {
      const base = documentOriginal(db, o.document_id) ?? db.prepare('SELECT value FROM document_field WHERE document_id = ? AND field = ?').get(o.document_id, o.field).value;
      const k = kwic(base, o.start_off, o.end_off, { clipStart: o.ps, clipEnd: o.pe });
      assert.equal(k.match, base.slice(o.start_off, o.end_off));
      assert.equal(base.slice(o.start_off - k.left.length, o.end_off + k.right.length), k.left + k.match + k.right);
      assert.ok(o.start_off - k.left.length >= o.ps && o.end_off + k.right.length <= o.pe);
      assert.ok(tokenize(k.left).tokens.length <= 12 && tokenize(k.right).tokens.length <= 12);
    }
  });

  test('tokenizer parity: JS tokens equal the FTS instances of every passage, position by position', () => {
    const passages = db.prepare('SELECT * FROM passage').all();
    const byDoc = new Map();
    for (const r of db.prepare('SELECT term, doc, offset FROM passage_vocab_inst').iterate()) {
      if (!byDoc.has(r.doc)) byDoc.set(r.doc, []);
      byDoc.get(r.doc).push(r);
    }
    let checked = 0;
    for (const p of passages) {
      const toks = tokenize(passageText(db, p)).tokens;
      const fts = (byDoc.get(p.id) ?? []).sort((a, b) => a.offset - b.offset);
      assert.equal(fts.length, toks.length, `passage ${p.id}: token count`);
      fts.forEach((r, i) => {
        assert.equal(r.offset, i);
        if (/^[a-z0-9]+$/.test(toks[i])) assert.equal(r.term, toks[i], `passage ${p.id} token ${i}`);
      });
      checked++;
    }
    assert.ok(checked > 800, `${checked} passages`);
  });

  test('document text slices use the same offsets and refuse ranges outside the document', () => {
    const d = db.prepare('SELECT document_id AS id FROM document_text LIMIT 1').get();
    const original = documentOriginal(db, d.id);
    const r = documentTextQuery(db, { id: d.id, from: 3, to: 40 });
    assertShape('DocumentText', r);
    assert.equal(r.text, original.slice(3, 40));
    assert.equal(r.length, original.length);
    assert.throws(() => documentTextQuery(db, { id: d.id, from: 10, to: original.length + 1 }), (e) => e.code === 'E_RANGE' && e.status === 400);
    assert.throws(() => documentTextQuery(db, { id: 999999 }), (e) => e.status === 404);
    const meta = db.prepare('SELECT id FROM document WHERE has_full_text = 0 LIMIT 1').get();
    assert.throws(() => documentTextQuery(db, { id: meta.id }), (e) => e.status === 404);
  });
});
