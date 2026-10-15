// OWNER: WP5 — robust anchors (SPEC D18) and the re-anchoring migration of §11 row 8: after a re-segmentation
// every annotation and evidence span re-anchors by (sha256, offsets, quote) to a new passage, or is reported as
// orphaned — never silently dropped

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { tokenize } from '../src/shared/tokenize.mjs';
import { ftsDelete, tx } from '../server/db/open.mjs';
import { createAnnotation } from '../server/provenance/annotations.mjs';
import { ANCHOR_CONTEXT, checkAnchor, makeAnchor, reanchorDocument, resolveAnchor, sha256 } from '../server/provenance/anchors.mjs';
import { proposeRelationship, relationshipCard } from '../server/provenance/relationships.mjs';
import { segment } from '../server/text/segment.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

describe('makeAnchor / resolveAnchor', () => {
  const text = 'Carry the zero: it holds the place where nothing is.\n\nCarry the zero again, said the clerk, and carry it twice.';
  const second = text.lastIndexOf('Carry the zero');

  test('an anchor is (doc, sha256, field, offsets, quote, ≤ 32 characters of context)', () => {
    const a = makeAnchor(text, { field: 'body', start: second, end: second + 14 }, { docId: 7 });
    assert.deepEqual(Object.keys(a), ['doc_id', 'sha256', 'field', 'start', 'end', 'quote', 'prefix', 'suffix']);
    assert.equal(a.quote, 'Carry the zero');
    assert.equal(a.sha256, sha256(text));
    assert.equal(a.prefix, text.slice(second - ANCHOR_CONTEXT, second));
    assert.equal(a.suffix, text.slice(second + 14, second + 14 + ANCHOR_CONTEXT));
    assert.throws(() => makeAnchor(text, { field: 'body', start: 5, end: 5 }), RangeError);
    assert.throws(() => makeAnchor(text, { field: 'body', start: 0, end: text.length + 1 }), RangeError);
  });

  test('offsets are UTF-16 code units: Devanagari, emoji and surrogate pairs slice exactly', () => {
    const t = 'आज 🎬 शून्य को साथ ले चल ◉ end';
    const start = t.indexOf('शून्य'), end = t.indexOf(' ◉');
    const a = makeAnchor(t, { field: 'body', start, end });
    assert.equal(a.quote, 'शून्य को साथ ले चल');
    assert.equal(a.prefix, 'आज 🎬 ');
    assert.deepEqual(resolveAnchor(t, a), { start, end, method: 'exact', ambiguous: false });
  });

  test('resolution: exact → offsets → quote → context → normalized → orphaned', () => {
    const a = makeAnchor(text, { field: 'body', start: second, end: second + 14 });
    assert.equal(resolveAnchor(text, a).method, 'exact');
    // same offsets, other text elsewhere (a later edit)
    assert.equal(resolveAnchor(`${text} Added later.`, a).method, 'offsets');
    // text inserted before the span: the quote is unique once the offsets fail
    const once = makeAnchor(text, { field: 'body', start: 16, end: 34 });
    const moved = resolveAnchor(`PREFACE. ${text}`, once);
    assert.deepEqual(moved, { start: 25, end: 43, method: 'quote', ambiguous: false });
    // two candidates: prefix/suffix pick the second "Carry the zero"
    const shifted = `Note. ${text}`;
    const r = resolveAnchor(shifted, a);
    assert.equal(r.method, 'context');
    assert.equal(r.ambiguous, false);
    assert.equal(r.start, shifted.lastIndexOf('Carry the zero'));
    // without context the choice is flagged ambiguous, not guessed silently
    const bare = { ...a, prefix: '', suffix: '', start: 9999, end: 10013 };
    assert.equal(resolveAnchor(shifted, bare).ambiguous, true);
    // CRLF → LF and re-wrapped lines: found after whitespace normalization, offsets map back to the new text
    const crlf = 'One line\r\nand the next line\r\nend';
    const w = makeAnchor(crlf, { field: 'body', start: 4, end: crlf.indexOf('\r\nend') });
    const lf = crlf.replace(/\r\n/g, '\n');
    const n = resolveAnchor(lf, w);
    assert.equal(n.method, 'normalized');
    assert.equal(lf.slice(n.start, n.end), 'line\nand the next line');
    // the words are gone: orphaned
    assert.equal(resolveAnchor(text.replace(/zero/g, 'nought'), a), null);
    assert.equal(resolveAnchor(text, { ...a, quote: '' }), null);
  });
});

/** Re-segment a document's body with other segmentation parameters (new passage ids), as an upgrade would. */
function resegment(db, docId, opts) {
  const t = db.prepare('SELECT original, body_start, body_end FROM document_text WHERE document_id = ?').get(docId);
  const old = db.prepare("SELECT * FROM passage WHERE document_id = ? AND field = 'body' ORDER BY ord").all(docId);
  return tx(db, () => {
    const ids = JSON.stringify(old.map((p) => p.id));
    // evidence rows point at passages (FK): detach them; their anchors keep the identity
    db.prepare('UPDATE relationship_evidence SET passage_id = NULL WHERE passage_id IN (SELECT value FROM json_each(?))').run(ids);
    ftsDelete(db, 'DELETE FROM passage_fts WHERE rowid IN (SELECT value FROM json_each(?))', ids);
    db.prepare('DELETE FROM passage WHERE id IN (SELECT value FROM json_each(?))').run(ids);
    const ins = db.prepare(`INSERT INTO passage (document_id, ord, field, field_class, time_role, unit, quality, start_off, end_off,
      lang, token_count, y_lo, y_hi, is_synthetic) VALUES (?, ?, 'body', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const fts = db.prepare('INSERT INTO passage_fts (rowid, norm) VALUES (?, ?)');
    const out = [];
    segment(t.original, { ...opts, start: t.body_start, end: t.body_end }).forEach((s, ord) => {
      const toks = tokenize(t.original.slice(s.start, s.end)).tokens;
      const id = Number(ins.run(docId, ord, s.field_class, s.time_role, s.unit, s.quality, s.start, s.end, old[0].lang, toks.length,
        old[0].y_lo, old[0].y_hi, old[0].is_synthetic).lastInsertRowid);
      fts.run(id, toks.join(' '));
      out.push({ id, start: s.start, end: s.end });
    });
    return { old: old.map((p) => p.id), now: out };
  });
}

describe('re-anchoring migration (§11 row 8)', () => {
  let tmp, db, doc1, doc3, text1, p1, p3, annIds, relId;
  before(() => {
    tmp = makeTmpData();
    db = tmp.db;
    doc1 = tmp.mini.ids.get('mini:01');
    doc3 = tmp.mini.ids.get('mini:03');
    text1 = db.prepare('SELECT original FROM document_text WHERE document_id = ?').get(doc1).original;
    p1 = db.prepare("SELECT * FROM passage WHERE document_id = ? AND field = 'body'").get(doc1);
    p3 = db.prepare("SELECT * FROM passage WHERE document_id = ? AND field = 'body'").get(doc3);
    const sha = db.prepare('SELECT original_sha256 AS s FROM document_text WHERE document_id = ?').get(doc1).s;
    const at = (quote) => ({ doc_id: doc1, sha256: sha, field: 'body', start: text1.indexOf(quote), end: text1.indexOf(quote) + quote.length, quote });
    annIds = ['The Counting House', 'ghost in the margin', 'Gene Halloran', 'selfish gene'].map((q) => createAnnotation(db, {
      target: { type: 'passage', ref: String(p1.id) }, anchor: at(q), kind: 'interpretation', body_md: `A note on “${q}”.` }).id);
    // an occurrence-free document-level note with an anchor, too
    annIds.push(createAnnotation(db, { target: { type: 'document', ref: String(doc1) }, anchor: at('the clerk'), kind: 'question',
      body_md: 'Which clerk?' }).id);
    const span = at('carried the zero');
    relId = proposeRelationship(db, { src: `passage:${p3.id}`, dst: `passage:${p1.id}`, rel_type: 'proposed_allusion',
      evidence: [{ passage: p1.id, start: span.start, end: span.end, role: 'target_span' },
        { passage: p3.id, start: 0, end: 20, role: 'source_span' }], note: 'Both carry the zero in a ledger setting.' }).id;
  });
  after(() => tmp.cleanup());

  test('one passage becomes three: every anchor finds the new passage that holds its words', () => {
    // regions make each blank-line paragraph a hard boundary: different segmentation parameters, new ids
    const paras = [];
    for (const m of text1.matchAll(/[^\n]+(?:\n(?!\n)[^\n]*)*/g)) paras.push({ start: m.index, end: m.index + m[0].length });
    const seg = resegment(db, doc1, { regions: paras });
    assert.equal(seg.now.length, 3);
    assert.ok(seg.now.every((p) => !seg.old.includes(p.id)), 'passage ids changed');

    const before = db.prepare('SELECT count(*) AS n FROM annotation').get().n;
    const report = reanchorDocument(db, doc1);
    assert.equal(report.annotations.checked, 5);
    assert.equal(report.annotations.orphaned.length, 0);
    assert.equal(report.annotations.reanchored.length, 4, 'the four passage notes moved; the document note kept its target');
    assert.equal(report.annotations.unchanged, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM annotation').get().n, before, 'nothing dropped');
    for (const id of annIds) {
      const a = db.prepare('SELECT target_type, target_ref, anchor_json FROM annotation WHERE id = ?').get(id);
      const anchor = JSON.parse(a.anchor_json);
      assert.equal(text1.slice(anchor.start, anchor.end), anchor.quote);
      if (a.target_type !== 'passage') continue;
      const p = db.prepare('SELECT * FROM passage WHERE id = ?').get(Number(a.target_ref));
      assert.ok(p, `annotation ${id} points at an existing passage`);
      assert.ok(p.start_off <= anchor.start && anchor.end <= p.end_off, `passage ${p.id} holds “${anchor.quote}”`);
    }
    assert.equal(report.evidence.checked, 1);
    assert.equal(report.evidence.reanchored.length, 1);
    const ev = relationshipCard(db, relId).evidence.find((e) => e.role === 'target_span');
    const holder = db.prepare('SELECT * FROM passage WHERE id = ?').get(ev.passage);
    assert.ok(holder.start_off <= ev.start && ev.end <= holder.end_off);
    assert.equal(ev.quote, 'carried the zero');
    // the relationship's passage endpoint is immutable (§3 trigger): reported, never dropped or rewritten
    assert.deepEqual(report.endpoints.missing, [{ relationship: relId, end: 'dst', passage: p1.id }]);
    assert.equal(db.prepare('SELECT dst_ref FROM relationship WHERE id = ?').get(relId).dst_ref, String(p1.id));
    // running it again changes nothing
    const again = reanchorDocument(db, doc1);
    assert.equal(again.annotations.reanchored.length, 0);
    assert.equal(again.annotations.unchanged, 5);
  });

  test('changed text: moved words re-anchor by their quote; vanished words are reported as orphaned', () => {
    const doc2 = tmp.mini.ids.get('mini:02');
    const t2 = db.prepare('SELECT original, original_sha256 AS sha FROM document_text WHERE document_id = ?').get(doc2);
    const p2 = db.prepare("SELECT * FROM passage WHERE document_id = ? AND field = 'body'").get(doc2);
    const at = (q) => ({ doc_id: doc2, sha256: t2.sha, field: 'body', start: t2.original.indexOf(q), end: t2.original.indexOf(q) + q.length, quote: q });
    const keep = createAnnotation(db, { target: { type: 'passage', ref: String(p2.id) }, anchor: at('the old primer'), kind: 'interpretation', body_md: 'Which primer?' });
    const lose = createAnnotation(db, { target: { type: 'passage', ref: String(p2.id) }, anchor: at('Carry the zero, children'), kind: 'interpretation', body_md: 'A rule for children.' });
    // a re-decoding that changed some words and shifted everything (as a different decoder might)
    const changed = `[Transcriber's note] ${t2.original.replace('Carry the zero, children', 'Carry the nought, children')}`;
    db.prepare('UPDATE document_text SET original = ?, original_sha256 = ?, body_end = ? WHERE document_id = ?')
      .run(changed, sha256(changed), changed.length, doc2);
    db.prepare('UPDATE passage SET end_off = ? WHERE id = ?').run(changed.length, p2.id);
    const report = reanchorDocument(db, doc2);
    const moved = report.annotations.reanchored.find((r) => r.id === keep.id);
    assert.equal(moved.method, 'quote');
    const kept = JSON.parse(db.prepare('SELECT anchor_json FROM annotation WHERE id = ?').get(keep.id).anchor_json);
    assert.equal(changed.slice(kept.start, kept.end), 'the old primer');
    assert.equal(kept.sha256, sha256(changed));
    assert.deepEqual(report.annotations.orphaned.map((o) => [o.id, o.quote]), [[lose.id, 'Carry the zero, children']]);
    const orphan = db.prepare('SELECT status, anchor_json FROM annotation WHERE id = ?').get(lose.id);
    assert.equal(orphan.status, 'active', 'an orphaned annotation stays; it is reported, not deleted');
    assert.equal(JSON.parse(orphan.anchor_json).quote, 'Carry the zero, children');
  });

  test('checkAnchor refuses words outside the target passage and ambiguous quotes', () => {
    const p = db.prepare("SELECT * FROM passage WHERE document_id = ? AND field = 'body' ORDER BY start_off").all(doc1);
    const q = 'Gene Halloran';
    const start = text1.indexOf(q);
    const input = { doc_id: doc1, field: 'body', start, end: start + q.length, quote: q };
    assert.throws(() => checkAnchor(db, input, { docId: doc1, passage: p[0] }), (e) => e.status === 400 && e.detail.reason === 'outside_passage');
    assert.equal(checkAnchor(db, input, { docId: doc1, passage: p[2] }).anchor.quote, q);
    assert.throws(() => checkAnchor(db, { ...input, start: 0, end: 3, quote: 'the' }, { docId: doc1 }), (e) => e.detail.reason === 'ambiguous');
    assert.throws(() => checkAnchor(db, { ...input, doc_id: doc3 }, { docId: doc1 }), (e) => e.detail.reason === 'doc_mismatch');
  });
});
