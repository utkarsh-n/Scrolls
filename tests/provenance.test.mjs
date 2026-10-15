// OWNER: WP5 — inferred lineage can never be stored or rendered as documented; review is an overlay; annotations
// are append-only with layers and as-of; hypothesis groups; saved views are immutable (SPEC §2.C, §2.F, §3, D7,
// D17, §11 rows 6 and 8)

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, test } from 'node:test';
import { edgeStyle } from '../src/shared/evidence-style.mjs';
import { isConstraintError, nowIso } from '../server/db/open.mjs';
import { createHypothesisGroup, getHypothesisGroup } from '../server/lineage/hypotheses.mjs';
import {
  annotationRevisions, createAnnotation, listAnnotations, reinterpretAnnotation, reviseAnnotation, withdrawAnnotation,
} from '../server/provenance/annotations.mjs';
import { attachEvidence, CAUTION, proposeRelationship, relationshipCard } from '../server/provenance/relationships.mjs';
import { reviewRelationship, reviewStatusOf } from '../server/provenance/reviews.mjs';
import { deleteView, DRIFT_MESSAGE, getView, listViews, saveView } from '../server/provenance/views.mjs';
import { assertShape, checkResponse } from './helpers/shape.mjs';
import { startServerInProcess } from './helpers/server.mjs';
import { loadMini, makeTmpData, miniDocuments } from './helpers/tmpdata.mjs';

const RUN13 = 'it holds the place where nothing is, so that something can be counted';

function throwsHttp(fn, status, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.status, status, `expected ${status} ${code}, got ${err.status} ${err.code}: ${err.message}`);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

function throwsConstraint(fn, re) {
  assert.throws(fn, (err) => {
    assert.ok(isConstraintError(err), `expected a constraint error, got ${err.code} ${err.message}`);
    if (re) assert.match(err.message, re);
    return true;
  });
}

/** The body passage of a mini document and its text. */
function bodyOf(db, ids, ext) {
  const docId = ids.get(ext);
  const p = db.prepare("SELECT * FROM passage WHERE document_id = ? AND field = 'body' ORDER BY start_off LIMIT 1").get(docId);
  const t = db.prepare('SELECT original, original_sha256 FROM document_text WHERE document_id = ?').get(docId);
  return { docId, passage: p, text: t.original, sha: t.original_sha256 };
}

function anchorOf(b, quote) {
  const start = b.text.indexOf(quote);
  assert.ok(start >= 0, `'${quote}' is in the text`);
  return { doc_id: b.docId, sha256: b.sha, field: 'body', start, end: start + quote.length, quote };
}

/** A succeeded analysis run, so computed rows can exist (origin algorithm needs run_id and method). */
function fakeRun(db, stage = 'reuse-index') {
  return Number(db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
      input_fingerprint, data_version, tokenizer_version, segmenter_version, icu_version, status, started_at)
    VALUES (?, 'test@1', 'x', '{}', 'x', '{}', 'x', 0, 'u61m-1', 'seg-1', 'icu', 'succeeded', ?)`).run(stage, nowIso()).lastInsertRowid);
}

function insertRel(db, { rel_type = 'exact_quotation', src, dst, status, origin, runId = null, method = null, dataset = null,
  locator = null, quality = 'complete', createdBy = 'run:1' }) {
  return Number(db.prepare(`INSERT INTO relationship (rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin,
      source_dataset, source_locator, provenance_quality, method, run_id, created_by, created_at)
    VALUES (?, 'passage', ?, 'passage', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(rel_type, String(src), String(dst), status, origin, dataset, locator, quality, method, runId, createdBy, nowIso()).lastInsertRowid);
}

describe('relationships: a person can only propose (D7)', () => {
  let tmp, db, ids, b1, b2, b3;
  before(() => {
    tmp = makeTmpData();
    db = tmp.db;
    ids = tmp.mini.ids;
    b1 = bodyOf(db, ids, 'mini:01');
    b2 = bodyOf(db, ids, 'mini:02');
    b3 = bodyOf(db, ids, 'mini:03');
  });
  after(() => tmp.cleanup());

  test('a human link is forced to proposed + origin human, whatever the request asks', () => {
    const a = anchorOf(b3, RUN13);
    const out = proposeRelationship(db, {
      src: `passage:${b3.passage.id}`, dst: `passage:${b2.passage.id}`, rel_type: 'explicit_citation',
      evidence: [{ passage: b3.passage.id, start: a.start, end: a.end, role: 'source_span' }],
      note: 'The bulletin repeats the memo wording verbatim.', evidence_status: 'documented', origin: 'source_dataset', author: 'Tester',
    });
    assert.equal(out.evidence_status, 'proposed');
    assert.equal(out.origin, 'human');
    assert.match(out.note, /always proposed/);
    const row = db.prepare('SELECT * FROM relationship WHERE id = ?').get(out.id);
    assert.equal(row.evidence_status, 'proposed');
    assert.equal(row.origin, 'human');
    assert.equal(row.created_by, 'human:Tester');
    assert.equal(row.is_synthetic, 1, 'a link between synthetic passages is synthetic');
    assert.equal(row.date_conflict, 0, '1963 bulletin → 1958 memo: no conflict');

    const card = relationshipCard(db, out.id);
    assertShape('Relationship', card);
    assert.equal(card.caution, CAUTION);
    assert.match(card.status_words, /^proposed/);
    assert.equal(card.evidence[0].quote, RUN13);
    assert.equal(card.evidence[0].anchor.sha256, b3.sha);
    assert.deepEqual(card.revisions.map((r) => r.action), ['create']);
    assert.equal(card.revisions[0].reason, 'The bulletin repeats the memo wording verbatim.');
    assert.equal(card.src.doc, 'Bench Bulletin No. 7');
    assert.equal(card.dst.y, 1958);
  });

  test('requests that cannot become a proposal are refused with actionable errors', () => {
    const base = { src: `passage:${b3.passage.id}`, dst: `passage:${b2.passage.id}`, rel_type: 'proposed_allusion',
      evidence: [{ passage: b3.passage.id, start: 0, end: 5 }], note: 'A note long enough to keep.' };
    throwsHttp(() => proposeRelationship(db, { ...base, evidence: [] }), 400, 'E_VALIDATION');
    throwsHttp(() => proposeRelationship(db, { ...base, note: 'short' }), 400, 'E_VALIDATION');
    throwsHttp(() => proposeRelationship(db, { ...base, rel_type: 'influenced' }), 400, 'E_VALIDATION');
    throwsHttp(() => proposeRelationship(db, { ...base, dst: 'passage:99999' }), 404, 'E_NOT_FOUND');
    throwsHttp(() => proposeRelationship(db, { ...base, dst: base.src }), 400, 'E_VALIDATION');
    // offsets index the document text: a span outside the passage is refused, relative: true shifts it
    throwsHttp(() => proposeRelationship(db, { ...base, evidence: [{ passage: b3.passage.id, start: 0, end: 999 }] }), 400, 'E_VALIDATION');
    throwsHttp(() => proposeRelationship(db, { ...base, evidence: [{ passage: b3.passage.id, start: 0, end: 5, role: 'citation_cue' }] }),
      400, 'E_VALIDATION');
    throwsHttp(() => proposeRelationship(db, { ...base, evidence: [{ passage: b3.passage.id, start: 0, end: 5, quote: 'nope!' }] }),
      400, 'E_VALIDATION');
    const ok = proposeRelationship(db, { ...base, evidence: [{ passage: b3.passage.id, start: 0, end: 5, relative: true }] });
    assert.equal(relationshipCard(db, ok.id).evidence[0].quote, 'Bench');
  });

  test('the database refuses documented lineage that is inferred, and never edits or deletes evidence', () => {
    const run = fakeRun(db);
    for (const origin of ['algorithm', 'human', 'machine_tagger']) {
      throwsConstraint(() => insertRel(db, { src: b3.passage.id, dst: b2.passage.id, status: 'documented', origin, runId: run,
        method: 'm', dataset: 'x', locator: 'y', createdBy: 'human:x' }));
    }
    throwsConstraint(() => insertRel(db, { src: b3.passage.id, dst: b2.passage.id, status: 'documented', origin: 'source_dataset',
      dataset: 'wikipedia' }), /CHECK/);
    throwsConstraint(() => insertRel(db, { src: b3.passage.id, dst: b2.passage.id, status: 'proposed', origin: 'human', createdBy: 'run:1' }));
    const id = insertRel(db, { src: b3.passage.id, dst: b2.passage.id, status: 'computed', origin: 'algorithm', runId: run,
      method: 'winnow k=8 w=6 + seed-extend' });
    for (const set of ["evidence_status = 'documented'", "origin = 'source_dataset'", "src_ref = '1'", 'run_id = NULL', "method = 'x'"]) {
      throwsConstraint(() => db.prepare(`UPDATE relationship SET ${set} WHERE id = ?`).run(id), /immutable/);
    }
    throwsConstraint(() => db.prepare('DELETE FROM relationship WHERE id = ?').run(id), /never deleted/);
    assert.match(relationshipCard(db, id).status_words, /^computed/);
  });

  test('reviews change only review_status (per reviewer, latest decision) and append a revision + an annotation', () => {
    const run = fakeRun(db);
    const id = insertRel(db, { src: b3.passage.id, dst: b2.passage.id, status: 'computed', origin: 'algorithm', runId: run, method: 'winnow' });
    db.prepare(`INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, after_json) VALUES (?, 1, 'run:1', ?, 'create', '{}')`)
      .run(id, nowIso());
    throwsHttp(() => reviewRelationship(db, id, { action: 'confirm', note: 'too short' }), 400, 'E_VALIDATION');
    throwsHttp(() => reviewRelationship(db, id, { action: 'approve', note: 'A long enough note.' }), 400, 'E_VALIDATION');
    throwsHttp(() => reviewRelationship(db, 99999, { action: 'confirm', note: 'A long enough note.' }), 404, 'E_NOT_FOUND');

    const steps = [
      ['Reader A', 'confirm', 'confirmed'],
      ['Reader B', 'reject', 'disputed'],
      ['Reader A', 'reject', 'rejected'],
      ['Reader C', 'dispute', 'disputed'],
    ];
    for (const [i, [author, action, expected]] of steps.entries()) {
      const r = reviewRelationship(db, id, { action, note: `${action}: checked the 13-token run by hand.`, author });
      assertShape('Review', r);
      assert.equal(r.review_status, expected, `${author} ${action}`);
      assert.equal(r.evidence_status, 'computed');
      assert.equal(r.revision, i + 2);
      const ann = db.prepare('SELECT * FROM annotation WHERE id = ?').get(r.annotation_id);
      assert.equal(ann.target_type, 'relationship');
      assert.equal(ann.target_ref, String(id));
      assert.equal(ann.kind, action === 'confirm' ? 'evidence_for' : 'evidence_against');
      assert.equal(ann.author, author);
    }
    const row = db.prepare('SELECT evidence_status, review_status, current_rev FROM relationship WHERE id = ?').get(id);
    assert.deepEqual({ ...row }, { evidence_status: 'computed', review_status: 'disputed', current_rev: 5 });
    const card = relationshipCard(db, id);
    assert.deepEqual(card.revisions.map((r) => r.action), ['create', 'confirm', 'reject', 'reject', 'dispute']);
    assert.equal(card.annotations.length, 4);
    // the line style is set by evidence status only; review is an overlay
    const s1 = edgeStyle({ evidence_status: 'computed', review_status: 'unreviewed', family: 'quotation' });
    const s2 = edgeStyle({ evidence_status: 'computed', review_status: card.review_status, family: 'quotation' });
    assert.deepEqual([s1.dash, s1.endpoint, s1.badge], [s2.dash, s2.endpoint, s2.badge]);
  });

  test('reviewStatusOf follows each reviewer’s latest decision; retract removes it', () => {
    assert.equal(reviewStatusOf([]), 'unreviewed');
    assert.equal(reviewStatusOf([{ actor: 'a', action: 'create' }, { actor: 'b', action: 'confirm' }]), 'confirmed');
    assert.equal(reviewStatusOf([{ actor: 'b', action: 'confirm' }, { actor: 'c', action: 'reject' }]), 'disputed');
    assert.equal(reviewStatusOf([{ actor: 'b', action: 'confirm' }, { actor: 'b', action: 'reject' }]), 'rejected');
    assert.equal(reviewStatusOf([{ actor: 'b', action: 'dispute' }, { actor: 'b', action: 'retract' }]), 'unreviewed');
  });

  test('a documented link stays documented when a person rejects it', () => {
    const id = insertRel(db, { rel_type: 'explicit_citation', src: b3.passage.id, dst: b1.passage.id, status: 'documented',
      origin: 'source_dataset', dataset: 'demo-records', locator: 'demo-records:x', createdBy: 'adapter:demo@1' });
    db.prepare(`INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, after_json) VALUES (?, 1, 'adapter:demo@1', ?, 'create', '{}')`)
      .run(id, nowIso());
    const r = reviewRelationship(db, id, { action: 'reject', note: 'The record names a different book.' });
    assert.equal(r.review_status, 'rejected');
    assert.equal(r.evidence_status, 'documented');
    assert.match(relationshipCard(db, id).status_words, /^documented/);
  });

  test('attribution cues stay proposed + CUE; attaching evidence appends a revision, never a status', () => {
    const run = fakeRun(db, 'trace');
    const id = insertRel(db, { rel_type: 'explicit_citation', src: b3.passage.id, dst: b1.passage.id, status: 'proposed',
      origin: 'algorithm', runId: run, method: 'attribution cue (en): "as <Name> put it"' });
    db.prepare(`INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, after_json) VALUES (?, 1, 'run:1', ?, 'create', '{}')`)
      .run(id, nowIso());
    db.prepare(`INSERT INTO relationship_evidence (relationship_id, passage_id, role, start_off, end_off, detail_json, added_by, added_at)
      VALUES (?, ?, 'citation_cue', 0, 5, '{"quote":"Bench"}', 'run:1', ?)`).run(id, b3.passage.id, nowIso());
    const card = relationshipCard(db, id);
    assertShape('Relationship', card);
    assert.deepEqual(card.cue, { quote: 'Bench', referent: 'inferred' });
    assert.equal(edgeStyle({ evidence_status: card.evidence_status, cue: Boolean(card.cue), family: card.family }).badge, 'PROP · CUE');

    const a = anchorOf(b3, 'Carry the zero');
    const ev = attachEvidence(db, id, { passage: b3.passage.id, start: a.start, end: a.end, role: 'supporting', note: 'The phrase opens the bulletin.' });
    assertShape('Created', ev);
    const after2 = relationshipCard(db, id);
    assert.equal(after2.evidence_status, 'proposed');
    assert.equal(after2.evidence.at(-1).quote, 'Carry the zero');
    assert.deepEqual(after2.revisions.map((r) => r.action), ['create', 'add_evidence']);
    throwsHttp(() => attachEvidence(db, id, { passage: b3.passage.id, start: 0, end: 4, role: 'proof', note: 'A long enough note.' }), 400, 'E_VALIDATION');
    throwsHttp(() => attachEvidence(db, id, { role: 'external_record', note: 'A long enough note.' }), 400, 'E_VALIDATION');
    const ext = attachEvidence(db, id, { role: 'external_record', locator: 'demo-records:liner-notes', quote: 'for the bench', note: 'Liner notes name it.' });
    assert.equal(relationshipCard(db, id).evidence.find((e) => e.id === ext.id).quote, 'for the bench');
  });

  test('hypothesis groups: competing parents side by side; confirming one leaves the others as they were', () => {
    const g = createHypothesisGroup(db, { target: `passage:${b3.passage.id}`, question: "Where does the bulletin's line come from?", author: 'Reader A' });
    assertShape('Created', g);
    assert.equal(g.existing, false);
    assert.equal(createHypothesisGroup(db, { target: `passage:${b3.passage.id}`, question: "Where does the bulletin's line come from?" }).id, g.id);
    throwsHttp(() => createHypothesisGroup(db, { target: `passage:${b3.passage.id}`, question: '' }), 400, 'E_VALIDATION');
    throwsHttp(() => createHypothesisGroup(db, { target: 'passage:99999', question: 'Where from, then?' }), 404, 'E_NOT_FOUND');

    const a3 = anchorOf(b3, RUN13);
    const span = [{ passage: b3.passage.id, start: a3.start, end: a3.end }];
    const h1 = proposeRelationship(db, { src: `passage:${b3.passage.id}`, dst: `passage:${b2.passage.id}`, rel_type: 'near_quotation',
      evidence: span, note: 'Same 13 tokens as the 1958 memo.', group: g.id, author: 'Reader A' });
    const h2 = proposeRelationship(db, { src: `passage:${b3.passage.id}`, dst: `passage:${b1.passage.id}`, rel_type: 'proposed_allusion',
      evidence: span, note: 'The counting-house novel says it first?', group: g.id, author: 'Reader B' });
    throwsHttp(() => proposeRelationship(db, { src: `passage:${b2.passage.id}`, dst: `passage:${b1.passage.id}`, rel_type: 'proposed_allusion',
      evidence: [{ passage: b2.passage.id, start: 0, end: 4 }], note: 'Wrong start for this group.', group: g.id }), 400, 'E_VALIDATION');

    reviewRelationship(db, h1.id, { action: 'confirm', note: 'The memo is the earlier dated source.', author: 'Reader C' });
    const group = getHypothesisGroup(db, g.id);
    assertShape('HypothesisGroup', group);
    assert.equal(group.text, '⚖ 2 competing');
    assert.deepEqual(group.hypotheses.map((h) => [h.rel_id, h.review_status, h.evidence_status, h.author]),
      [[h1.id, 'confirmed', 'proposed', 'Reader A'], [h2.id, 'unreviewed', 'proposed', 'Reader B']]);
    assert.match(group.hypotheses[0].label, /^from Ledger Memo \(14 Mar 1958\)$/);

    // an existing computed link from the target joins the group with a 'regroup' revision
    const run = fakeRun(db);
    const c = insertRel(db, { src: b3.passage.id, dst: b2.passage.id, status: 'computed', origin: 'algorithm', runId: run, method: 'winnow' });
    db.prepare(`INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, after_json) VALUES (?, 1, 'run:1', ?, 'create', '{}')`)
      .run(c, nowIso());
    const again = createHypothesisGroup(db, { target: `passage:${b3.passage.id}`, question: "Where does the bulletin's line come from?", relationships: [c] });
    assert.deepEqual(again.regrouped, [c]);
    assert.equal(getHypothesisGroup(db, g.id).text, '⚖ 3 competing');
    assert.deepEqual(relationshipCard(db, c).revisions.map((r) => r.action), ['create', 'regroup']);
    assert.equal(relationshipCard(db, c).evidence_status, 'computed');
    throwsHttp(() => getHypothesisGroup(db, 99999), 404, 'E_NOT_FOUND');
  });
});

describe('annotations: append-only, layers, as-of (§2.F)', () => {
  let tmp, db, ids, b2, b4;
  before(() => {
    tmp = makeTmpData();
    db = tmp.db;
    ids = tmp.mini.ids;
    b2 = bodyOf(db, ids, 'mini:02');
    b4 = bodyOf(db, ids, 'mini:04');
  });
  after(() => tmp.cleanup());

  const note = (b, extra = {}) => ({
    target: { type: 'passage', ref: String(b.passage.id) }, anchor: anchorOf(b, 'Carry the zero, children'),
    kind: 'interpretation', body_md: 'Reads as a schoolroom rule repeated at work.', author: 'Reader A', ...extra,
  });

  test('create: anchors are checked against the text and completed by the server', () => {
    const r = createAnnotation(db, note(b2, { dimensions: { pragmatic_function: 'ironic', perspective: '2026 reader' }, tags: ['irony', 'irony', ' work '] }));
    assertShape('AnnotationRev', r);
    assert.equal(r.rev, 1);
    const row = db.prepare('SELECT * FROM annotation WHERE id = ?').get(r.id);
    const anchor = JSON.parse(row.anchor_json);
    assert.equal(anchor.quote, 'Carry the zero, children');
    assert.equal(anchor.sha256, b2.sha);
    assert.equal(anchor.prefix, b2.text.slice(Math.max(0, anchor.start - 32), anchor.start));
    assert.equal(anchor.suffix, b2.text.slice(anchor.end, anchor.end + 32));
    assert.equal(row.is_synthetic, 1);
    assert.deepEqual(JSON.parse(db.prepare('SELECT tags_json FROM annotation_revision WHERE annotation_id = ?').get(r.id).tags_json), ['irony', 'work']);

    throwsHttp(() => createAnnotation(db, { ...note(b2), anchor: undefined }), 400, 'E_VALIDATION');
    throwsHttp(() => createAnnotation(db, { ...note(b2), anchor: { ...anchorOf(b2, 'Carry the zero'), quote: 'not in this memo' } }), 400, 'E_VALIDATION');
    throwsHttp(() => createAnnotation(db, { ...note(b2), anchor: { ...anchorOf(b4, 'zéro'), doc_id: b4.docId } }), 400, 'E_VALIDATION');
    throwsHttp(() => createAnnotation(db, { ...note(b2), kind: 'machine_tag' }), 400, 'E_VALIDATION');
    // fix pass (§13 rule 10): a person cannot sign as a machine
    for (const author of ['machine:tagger', 'run:12', 'Adapter: cipher', 'model:gpt-x']) {
      throwsHttp(() => createAnnotation(db, { ...note(b2), author }), 400, 'E_VALIDATION');
    }
    throwsHttp(() => createAnnotation(db, { ...note(b2), kind: 'label' }), 400, 'E_VALIDATION');
    throwsHttp(() => createAnnotation(db, { ...note(b2), body_md: '   ' }), 400, 'E_VALIDATION');
    throwsHttp(() => createAnnotation(db, { ...note(b2), dimensions: { pragmatic_function: 'sarcastic' } }), 400, 'E_VALIDATION');
    throwsHttp(() => createAnnotation(db, { ...note(b2), dimensions: { tone: 7 } }), 400, 'E_VALIDATION');
    throwsHttp(() => createAnnotation(db, { ...note(b2), target: { type: 'passage', ref: '99999' } }), 404, 'E_NOT_FOUND');

    const a2 = anchorOf(b2, 'Carry the zero, children');
    // offsets sent relative to the passage with the right quote are re-located by the quote (and said so)
    const a = anchorOf(b4, 'le cœur de la leçon');
    const rel = createAnnotation(db, { ...note(b2), target: { type: 'passage', ref: String(b4.passage.id) },
      anchor: { ...a, start: a.start + 1, end: a.end + 1 } });
    assert.equal(rel.relocated, 'quote');
    assert.equal(rel.anchor.start, a.start);

    // offsets alone are enough: the server derives doc_id, quote and sha256 (a numeric ref is accepted too)
    const bare = createAnnotation(db, { target: { type: 'passage', ref: b2.passage.id }, anchor: { start: a2.start, end: a2.end },
      kind: 'question', body_md: 'Which children?' });
    assert.deepEqual({ ...bare.anchor, prefix: undefined, suffix: undefined }, { ...a2, prefix: undefined, suffix: undefined });

    // a custom dimension is defined on first use
    createAnnotation(db, note(b2, { dimensions: { classroom_echo: 'strong' } }));
    assert.equal(db.prepare("SELECT type, created_by FROM dimension_def WHERE key = 'classroom_echo'").get().type, 'text');
  });

  test('editing appends revisions; revisions can never be updated or deleted', () => {
    const { id } = createAnnotation(db, note(b2, { dimensions: { pragmatic_function: 'parodic' }, tags: ['mockery'] }));
    assert.deepEqual(reviseAnnotation(db, id, { body_md: 'Not mockery: ironic distance.', reason: 'reread the memo', dimensions: { pragmatic_function: 'ironic' } }), { id, rev: 2 });
    assert.deepEqual(reviseAnnotation(db, id, { body_md: 'Ironic distance; the clerk keeps the rule.', tags: ['irony'] }), { id, rev: 3 });
    const revs = annotationRevisions(db, id);
    assertShape('AnnotationRevisions', revs);
    assert.deepEqual(revs.map((r) => r.rev), [1, 2, 3]);
    assert.deepEqual(revs.map((r) => r.dimensions.pragmatic_function), ['parodic', 'ironic', 'ironic'], 'dimensions carry over');
    assert.deepEqual(revs.map((r) => r.tags), [['mockery'], ['mockery'], ['irony']]);
    assert.equal(revs[1].reason, 'reread the memo');
    throwsConstraint(() => db.prepare("UPDATE annotation_revision SET body_md = 'x' WHERE annotation_id = ?").run(id), /append-only/);
    throwsConstraint(() => db.prepare('DELETE FROM annotation_revision WHERE annotation_id = ?').run(id), /append-only/);
    throwsHttp(() => reviseAnnotation(db, id, { reason: 'no body' }), 400, 'E_VALIDATION');
    throwsHttp(() => reviseAnnotation(db, 99999, { body_md: 'x' }), 404, 'E_NOT_FOUND');
    const listed = listAnnotations(db, { target: `passage:${b2.passage.id}` }).items.find((a) => a.id === id);
    assert.equal(listed.rev, 3);
    assert.equal(listed.revisions, 3);
    assert.equal(listed.body_md, 'Ironic distance; the clerk keeps the rule.');
  });

  test('reinterpret keeps the old layer visible; as-of shows what existed then; withdraw appends', async () => {
    const target = `passage:${b4.passage.id}`;
    const old = createAnnotation(db, {
      target: { type: 'passage', ref: String(b4.passage.id) }, anchor: anchorOf(b4, 'le zéro n’est pas rien'),
      kind: 'interpretation', body_md: 'A sneer at the schoolroom.', layer: 'Reader A, 2026-10-02', author: 'Reader A',
    });
    const cutoff = db.prepare('SELECT MAX(id) AS n FROM annotation_revision').get().n;
    await sleep(5);
    const t1 = nowIso();
    await sleep(5);
    reviseAnnotation(db, old.id, { body_md: 'A sneer at the schoolroom, or a lesson kept?' });
    const re = reinterpretAnnotation(db, old.id, { body_md: 'The lesson kept: the zero is not nothing.', author: 'Reader A' });
    assertShape('AnnotationReinterpreted', re);
    assert.equal(re.supersedes, old.id);
    const fresh = db.prepare('SELECT * FROM annotation WHERE id = ?').get(re.id);
    assert.equal(fresh.supersedes, old.id);
    assert.match(fresh.layer, /^Reader A, \d{4}-\d{2}-\d{2}$/);
    assert.equal(fresh.anchor_json, db.prepare('SELECT anchor_json FROM annotation WHERE id = ?').get(old.id).anchor_json, 'the anchor carries over');
    assert.equal(db.prepare('SELECT status FROM annotation WHERE id = ?').get(old.id).status, 'superseded');

    const now = listAnnotations(db, { target });
    assertShape('Annotations', now);
    assert.ok(!now.items.some((a) => a.id === old.id), 'superseded layers are hidden by default');
    const all = listAnnotations(db, { target, include: 'superseded' });
    const layer = all.items.find((a) => a.id === old.id);
    assert.equal(layer.status, 'superseded');
    assert.equal(layer.superseded_by, re.id);
    assert.equal(layer.superseded_at, fresh.created_at);
    assert.equal(layer.body_md, 'A sneer at the schoolroom, or a lesson kept?');

    for (const asOf of [{ as_of: t1 }, { rev_cutoff: String(cutoff) }]) {
      const then = listAnnotations(db, { target, include: 'superseded', ...asOf });
      const was = then.items.find((a) => a.id === old.id);
      assert.equal(was.status, 'active', `${JSON.stringify(asOf)}: not yet superseded`);
      assert.equal(was.rev, 1);
      assert.equal(was.body_md, 'A sneer at the schoolroom.');
      assert.ok(!then.items.some((a) => a.id === re.id), 'the reinterpretation did not exist yet');
    }
    assert.equal(listAnnotations(db, { target, as_of: '1999-01-01' }).items.length, 0);
    throwsHttp(() => listAnnotations(db, { target, as_of: 'yesterday' }), 400, 'E_VALIDATION');

    assert.throws(() => reinterpretAnnotation(db, old.id, { body_md: 'Third reading.' }), (err) => err.status === 409 &&
      err.code === 'E_ANNOTATION_SUPERSEDED' && err.detail.by === re.id);
    throwsHttp(() => reviseAnnotation(db, old.id, { body_md: 'editing history' }), 409, 'E_ANNOTATION_SUPERSEDED');
    throwsHttp(() => reinterpretAnnotation(db, re.id, { body_md: 'x', target: { type: 'passage', ref: '1' } }), 400, 'E_VALIDATION');

    const w = withdrawAnnotation(db, re.id, { reason: 'posted on the wrong passage' });
    assertShape('AnnotationRev', w);
    assert.deepEqual(w, { id: re.id, rev: 2, status: 'withdrawn' });
    assert.ok(!listAnnotations(db, { target }).items.some((a) => a.id === re.id));
    const gone = listAnnotations(db, { target, include: 'withdrawn' }).items.find((a) => a.id === re.id);
    assert.equal(gone.status, 'withdrawn');
    assert.equal(gone.reason, 'withdrawn: posted on the wrong passage');
    assert.equal(listAnnotations(db, { target, include: 'withdrawn', as_of: t1 }).items.find((a) => a.id === re.id), undefined);
    throwsHttp(() => reviseAnnotation(db, re.id, { body_md: 'too late' }), 409, 'E_ANNOTATION_WITHDRAWN');
    assert.equal(db.prepare('SELECT count(*) AS n FROM annotation WHERE id IN (?, ?)').get(old.id, re.id).n, 2, 'nothing deleted');
  });

  test('machine annotations are listed as fallible and can only be countered', () => {
    const run = fakeRun(db, 'tone');
    const id = Number(db.prepare(`INSERT INTO annotation (target_type, target_ref, kind, author, is_machine, method, run_id, created_at)
      VALUES ('document', ?, 'machine_gloss', 'Cipher tagging pass', 1, 'Cipher tagging pass (Claude sub-agent, Oct 2026)', ?, ?)`)
      .run(String(b2.docId), run, nowIso()).lastInsertRowid);
    db.prepare(`INSERT INTO annotation_revision (annotation_id, rev, body_md, author, at) VALUES (?, 1, 'A memo about zeros.', 'Cipher tagging pass', ?)`)
      .run(id, nowIso());
    throwsHttp(() => reviseAnnotation(db, id, { body_md: 'better gloss' }), 409, 'E_MACHINE_ANNOTATION');
    throwsHttp(() => reinterpretAnnotation(db, id, { body_md: 'better gloss' }), 409, 'E_MACHINE_ANNOTATION');
    throwsHttp(() => withdrawAnnotation(db, id), 409, 'E_MACHINE_ANNOTATION');
    const listed = listAnnotations(db, { target: `document:${b2.docId}` }).items;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].fallible, true);
    assert.equal(listed[0].is_machine, true);
    assert.equal(listAnnotations(db, { target: `document:${b2.docId}`, machine: '0' }).items.length, 0);
    const counter = createAnnotation(db, { target: { type: 'annotation', ref: String(id) }, kind: 'evidence_against',
      body_md: 'The memo is about auditors, not zeros.' });
    assert.equal(db.prepare('SELECT target_type FROM annotation WHERE id = ?').get(counter.id).target_type, 'annotation');
  });

  test('hypotheses are labelled "not evidence"; search, filters and paging work', () => {
    const h = createAnnotation(db, { target: { type: 'document', ref: String(b2.docId) }, kind: 'hypothesis',
      body_md: "By 2035 'carry the zero' may be mainly a data-engineering term.", tags: ['forecast'], author: 'Reader B' });
    const item = listAnnotations(db, { target: `document:${b2.docId}`, kind: 'hypothesis' }).items[0];
    assert.equal(item.id, h.id);
    assert.equal(item.label, `Hypothesis — by Reader B, ${item.created_at.slice(0, 10)} — not evidence`);
    assert.deepEqual(listAnnotations(db, { q: 'engineering' }).items.map((a) => a.id), [h.id]);
    assert.deepEqual(listAnnotations(db, { tag: 'forecast' }).items.map((a) => a.id), [h.id]);
    assert.ok(listAnnotations(db, { doc: String(b2.docId) }).items.length >= 3);
    const page1 = listAnnotations(db, { limit: '2' });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.cursor);
    const page2 = listAnnotations(db, { limit: '2', cursor: page1.cursor });
    assert.ok(page2.items[0].id > page1.items[1].id);
    // facets: dimension, contradiction, dates
    const ironic = listAnnotations(db, { dimension: 'pragmatic_function:ironic' }).items;
    assert.ok(ironic.length >= 1 && ironic.every((a) => a.dimensions.pragmatic_function === 'ironic'));
    assert.ok(listAnnotations(db, { dimension: 'pragmatic_function' }).items.length >= ironic.length);
    const target = listAnnotations(db, { kind: 'interpretation' }).items[0];
    assert.equal(target.contradicted, false);
    createAnnotation(db, { target: { type: 'annotation', ref: String(target.id) }, kind: 'evidence_against', body_md: 'The memo is literal.' });
    assert.ok(listAnnotations(db, { contradicted: '1' }).items.some((a) => a.id === target.id));
    assert.equal(listAnnotations(db, { from: '2999-01-01' }).items.length, 0);
    assert.ok(listAnnotations(db, { to: '2999-01-01' }).items.length > 0);
    throwsHttp(() => listAnnotations(db, { dimension: 'Bad Key' }), 400, 'E_VALIDATION');
    throwsHttp(() => listAnnotations(db, { target: 'nonsense' }), 400, 'E_VALIDATION');
    throwsHttp(() => listAnnotations(db, { kind: 'rumour' }), 400, 'E_VALIDATION');
  });
});

describe('saved views: immutable, slug~n, drift and as-saved counts (D17)', () => {
  let tmp, db;
  const state = { v: 1, corpus: 'test', strands: [], f: { coll: [] } };
  before(() => {
    tmp = makeTmpData();
    db = tmp.db;
  });
  after(() => tmp.cleanup());

  test('save pins data version, import cutoff, runs and revision cutoffs; re-save makes slug~2', () => {
    const v = saveView(db, { name: 'carry the zero: four uses', state, comparisons_tried: 2 });
    assertShape('ViewSaved', v);
    assert.match(v.slug, /^carry-the-zero-four-uses-[0-9a-f]{4}$/);
    assert.equal(v.url, `/#view=${v.slug}`);
    assert.equal(v.parent_slug, null);
    assert.deepEqual(v.cutoffs, { import_batch: tmp.mini.batchId, annotation_rev: 0, relationship_rev: 0 });
    const again = saveView(db, { name: 'carry the zero: four uses', state });
    assert.equal(again.slug, `${v.slug}~2`);
    assert.equal(again.parent_slug, v.slug);
    const third = saveView(db, { name: 'renamed while saving', state: { ...state, tier: 'L2' }, parent_slug: again.slug });
    assert.equal(third.slug, `${v.slug}~3`);
    assert.equal(third.parent_slug, again.slug);
    throwsHttp(() => saveView(db, { name: '', state }), 400, 'E_VALIDATION');
    throwsHttp(() => saveView(db, { name: 'x', state: null }), 400, 'E_VALIDATION');
    throwsHttp(() => saveView(db, { name: 'x', state, parent_slug: 'no-such-view' }), 404, 'E_NOT_FOUND');
    for (const set of ["state_json = '{}'", "slug = 'x'", 'data_version = 99', 'max_import_batch = 0', "run_ids_json = '{}'",
      'annotation_rev_cutoff = 9', 'relationship_rev_cutoff = 9', "state_hash = 'x'"]) {
      throwsConstraint(() => db.prepare(`UPDATE saved_view SET ${set} WHERE slug = ?`).run(v.slug), /immutable/);
    }
    const listed = listViews(db, {});
    assertShape('Views', listed);
    assert.deepEqual(listed.items.map((x) => x.slug), [third.slug, again.slug, v.slug], 'newest first');
    assert.equal(listed.items[0].synthetic, true);
    assert.deepEqual(listViews(db, { q: 'nothing' }).items, []);
  });

  test('after a new import the view reports drift and its "as saved" counts equal the counts at save', () => {
    const v = saveView(db, { name: 'drift check', state });
    const atSave = getView(db, v.slug);
    assertShape('View', atSave);
    assert.equal(atSave.drift.dataChanged, false);
    assert.equal(atSave.drift.message, null);
    assert.deepEqual(atSave.counts.asSaved, v.counts);
    assert.deepEqual(atSave.counts.current, v.counts);
    assert.equal(v.counts.documents, 12);

    // a later import, and a soft delete of a document that existed at save time
    const docs = miniDocuments().slice(0, 3).map((d) => ({ ...d, ext_id: `${d.ext_id}-again` }));
    const later = loadMini(db, { docs, slug: 'mini-later' });
    db.prepare("UPDATE document SET deleted_at = ? WHERE ext_id = 'mini:05'").run(nowIso());
    const now = getView(db, v.slug);
    assertShape('View', now);
    assert.equal(now.drift.dataChanged, true);
    assert.deepEqual(now.drift.importsSince.map((b) => b.batch), [later.batchId]);
    assert.equal(now.drift.message, DRIFT_MESSAGE(v.cutoffs.import_batch));
    assert.equal(now.drift.message, `Corpus changed since this view was saved. 'As saved' restricts to imports ≤ #${v.cutoffs.import_batch} and the pinned runs.`);
    assert.deepEqual(now.counts.asSaved, v.counts, 'as saved reproduces the counts at save');
    assert.equal(now.counts.current.documents, 12 + 3 - 1);
    assert.ok(now.currentDataVersion > now.dataVersion);
    const asSaved = getView(db, v.slug, { asSaved: true });
    assert.equal(asSaved.state.asSaved, true);
    assert.equal(asSaved.asSaved, true);
  });

  test('delete is soft: the link stops resolving, the row stays', () => {
    const v = saveView(db, { name: 'to be deleted', state });
    deleteView(db, v.slug);
    throwsHttp(() => getView(db, v.slug), 404, 'E_NOT_FOUND');
    throwsHttp(() => deleteView(db, v.slug), 404, 'E_NOT_FOUND');
    assert.ok(!listViews(db, {}).items.some((x) => x.slug === v.slug));
    assert.ok(db.prepare('SELECT deleted_at FROM saved_view WHERE slug = ?').get(v.slug).deleted_at);
  });
});

describe('HTTP: every WP5 P1 endpoint answers with its contract shape', () => {
  let tmp, srv, p2, p3, b2;
  before(async () => {
    tmp = makeTmpData();
    b2 = bodyOf(tmp.db, tmp.mini.ids, 'mini:02');
    p2 = b2.passage.id;
    p3 = bodyOf(tmp.db, tmp.mini.ids, 'mini:03').passage.id;
    process.env.SCROLLS_READ_WORKERS = '1';
    srv = await startServerInProcess({ dataDir: tmp.dir });
  });
  after(async () => {
    await srv?.cleanup();
    delete process.env.SCROLLS_READ_WORKERS;
    tmp.cleanup();
  });

  const call = async (method, path, body) => {
    const r = await srv.request(method, path, { body });
    const res = new Response(r.status === 204 ? null : r.text, { status: r.status });
    return { status: r.status, json: await checkResponse(res, method, path) };
  };

  test('annotations, revisions, reinterpret, withdraw', async () => {
    const a = anchorOf(b2, 'Carry the zero');
    const c = await call('POST', '/api/annotations', { target: { type: 'passage', ref: String(p2) }, anchor: a, kind: 'interpretation',
      body_md: 'A rule from school.', tags: ['school'] });
    assert.equal(c.status, 200);
    assert.equal((await call('PATCH', `/api/annotations/${c.json.id}`, { body_md: 'A rule from school, kept at work.' })).json.rev, 2);
    assert.equal((await call('GET', `/api/annotations/${c.json.id}/revisions`)).json.length, 2);
    const re = await call('POST', `/api/annotations/${c.json.id}/reinterpret`, { target: { type: 'passage', ref: String(p2) }, anchor: a,
      kind: 'interpretation', body_md: 'The rule turned into a joke.' });
    assert.equal(re.json.supersedes, c.json.id);
    const list = await call('GET', `/api/annotations?target=passage:${p2}&include=superseded`);
    assert.deepEqual(list.json.items.map((x) => [x.id, x.status]), [[c.json.id, 'superseded'], [re.json.id, 'active']]);
    assert.equal((await call('POST', `/api/annotations/${re.json.id}/withdraw`)).json.status, 'withdrawn');
    assert.equal((await call('POST', '/api/annotations', { target: { type: 'passage', ref: String(p2) }, kind: 'interpretation', body_md: 'x' })).status, 400);
    assert.equal((await call('PATCH', '/api/annotations/99999', { body_md: 'x' })).status, 404);
    assert.equal((await call('GET', '/api/annotations/abc/revisions')).status, 400);
  });

  test('relationships, review, evidence, hypothesis groups', async () => {
    const g = await call('POST', '/api/hypothesis-groups', { target: `passage:${p3}`, question: 'Where does this line come from?' });
    const r = await call('POST', '/api/relationships', { src: `passage:${p3}`, dst: `passage:${p2}`, rel_type: 'proposed_allusion',
      evidence: [{ passage: p3, start: 0, end: 5 }], note: 'Same opening words as the memo.', group: g.json.id, evidence_status: 'documented' });
    assert.equal(r.status, 200);
    assert.equal(r.json.evidence_status, 'proposed');
    const card = await call('GET', `/api/relationships/${r.json.id}`);
    assert.equal(card.json.origin, 'human');
    const rv = await call('POST', `/api/relationships/${r.json.id}/review`, { action: 'dispute', note: 'A common phrase in office memos.' });
    assert.equal(rv.json.review_status, 'disputed');
    assert.equal(rv.json.evidence_status, 'proposed');
    assert.equal((await call('POST', `/api/relationships/${r.json.id}/review`, { action: 'confirm', note: 'short' })).status, 400);
    const ev = await call('POST', `/api/relationships/${r.json.id}/evidence`, { passage: p2, start: 0, end: 4, role: 'contradicting',
      note: 'The memo heading is not the same phrase.' });
    assert.equal(ev.status, 200);
    const group = await call('GET', `/api/hypothesis-groups/${g.json.id}`);
    assert.equal(group.json.hypotheses.length, 1);
    assert.equal((await call('GET', '/api/relationships/99999')).status, 404);
    assert.equal((await call('GET', '/api/hypothesis-groups/99999')).status, 404);
  });

  test('views: save, re-save, open, list, soft delete', async () => {
    const s = await call('POST', '/api/views', { name: 'http view', state: { v: 1, corpus: 'test' } });
    assert.equal(s.status, 200);
    const s2 = await call('POST', '/api/views', { name: 'http view', state: { v: 1, corpus: 'test' }, parent_slug: s.json.slug });
    assert.equal(s2.json.slug, `${s.json.slug}~2`);
    assert.equal((await call('GET', `/api/views/${encodeURIComponent(s2.json.slug)}`)).json.slug, s2.json.slug);
    assert.equal((await call('GET', '/api/views')).json.items.length, 2);
    assert.equal((await call('DELETE', `/api/views/${s.json.slug}`)).status, 204);
    assert.equal((await call('GET', `/api/views/${s.json.slug}`)).status, 404);
    assert.equal((await call('POST', '/api/views', { state: {} })).status, 400);
  });
});
