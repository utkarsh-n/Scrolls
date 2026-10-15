// OWNER: WP5 — what shared wording is NOT a quotation (SPEC §4.7, §13 rules 6 and 9), with the exclusions counted and
// sampled: production-line text shared by many files at the same place, numbering, reprints of whole texts, text shared
// by more than 25 documents; cue names that are pronouns or a character's first name, and referents written later. Also:
// the near-quotation index is stored and serves the targeted trace (LSH lookup), and people's reviews survive a rerun.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { makeTaskContext } from '../server/jobs/context.mjs';
import { run as reuseIndex } from '../server/jobs/tasks/reuse-index.mjs';
import { nameMatches, nameWords } from '../server/lineage/cues.mjs';
import { contentTokens, coveredTokens, inEdgeZone, informative, isNameList, isNumeral, isReprint, PRODUCTION, TokenClasses } from '../server/lineage/filters.mjs';
import { lineageQuery } from '../server/lineage/graph.mjs';
import { lookupNear } from '../server/lineage/near.mjs';
import { traceQuery, traceSpan } from '../server/lineage/trace.mjs';
import { tokenIds } from '../server/lineage/winnow.mjs';
import { attachEvidence, relationshipCard } from '../server/provenance/relationships.mjs';
import { reviewRelationship } from '../server/provenance/reviews.mjs';
import { createBatch, createDocumentWriter, ensureCollection } from '../server/store/document-writer.mjs';
import { mulberry32 } from '../src/shared/ids.mjs';
import { tokenize } from '../src/shared/tokenize.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

// ── deterministic filler: invented words that are neither function words nor cue patterns ──
const SYL = ['ka', 'lo', 'mi', 'ru', 'ten', 'vas', 'pol', 'dre', 'nu', 'gim', 'sot', 'bra', 'fel', 'qui', 'zan', 'hob', 'wex', 'tor'];
function filler(seed, tokens) {
  const rnd = mulberry32(seed);
  const words = [];
  while (words.length < tokens) {
    const n = 2 + Math.floor(rnd() * 2);
    let w = '';
    for (let i = 0; i < n; i++) w += SYL[Math.floor(rnd() * SYL.length)];
    words.push(w);
  }
  const out = [];
  for (let i = 0; i < words.length; i += 12) out.push(`${words.slice(i, i + 12).join(' ')}.`);
  return out.join(' ');
}
const NOTE = "Transcriber's note: obvious printer errors have been corrected silently, and the spelling of the original edition is otherwise kept exactly as printed.";
const QUOTE = 'the river keeps no ledger of the stones it carries down to the sea, yet every stone remembers the mountain it left';
const TOC = 'I II III IV V VI VII VIII IX X XI XII XIII XIV XV XVI';
const WIDE = 'Here begins the common grace that every reader in the valley once learned by heart before the harvest.';
const STOCK = 'I beg your pardon, I am sure.';
// one word changed in the middle: identical runs of 6 tokens only (below the trace's exact minimum of 8)
const NEAR_A = 'Keep every quiet zero in the long column so the sum can stand.';
const NEAR_B = 'Keep every quiet zero in the wide column so the sum can stand.';

function addDocs(db, slug, docs) {
  const coll = ensureCollection(db, { slug, name: `${slug} (synthetic)`, corpus: 'test', adapter_id: 'file.jsonl', domain: 'imported',
    modality: 'text', unit: 'tokens', sampling: 'user' });
  const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: coll.id, format: 'jsonl' }), collection: slug, corpus: 'test' });
  const ids = {};
  for (const d of docs) {
    const r = w.addDocument({ ext_id: d.ext, kind: 'book', title: d.title ?? `${d.ext} (synthetic)`, author: d.author ?? `${d.ext} Writer (synthetic)`,
      lang_declared: 'en', text: { original: d.text, decoder: 'utf-8' },
      dates: d.year ? [{ role: 'publication', raw: d.year, asserted_by: 'fixture', is_chronology: true }] : [], original_meta: { fixture: 'filters' } });
    assert.ok(r.documentId, `${d.ext}: ${JSON.stringify(r.issues)}`);
    ids[d.ext] = r.documentId;
  }
  w.finish();
  return ids;
}

describe('filters: pure parts', () => {
  test('numerals, structure and wording', () => {
    for (const t of ['xiv', 'iv', '1928', 'mcmxcix', '٣']) assert.ok(isNumeral(t), t);
    for (const t of ['vivid', 'civil', 'did', 'mild', 'zero']) assert.ok(!isNumeral(t), t);
    const classes = new TokenClasses();
    const ids = (s) => { const tk = tokenize(s).tokens; const out = tokenIds(tk); tk.forEach((t, i) => classes.see(t, out[i])); return out; };
    const toc = ids(TOC);
    assert.ok(!informative(toc, 0, toc.length, classes), 'roman numbering is structure');
    assert.ok(informative(toc, 0, toc.length, null), 'without classes the numerals look like words (the reason classes exist)');
    const q = ids(QUOTE);
    assert.ok(informative(q, 0, q.length, classes));
    const stock = ids("I don't know, I'm sure");
    assert.equal(contentTokens(stock, 0, stock.length, classes), 2, 'know, sure: contraction pieces and single letters are not content words');
  });
  test('lists of names or titles are not wording; verse and constitutional prose are', () => {
    assert.ok(isNameList('The Muse of the Department A Prince of Bohemia A Man of Business The Member for Arcis'));
    assert.ok(isNameList('Rastignac, Eugene de Father Goriot A Distinguished Provincial at Paris'));
    assert.ok(!isNameList('No Tax or Duty shall be laid on Articles exported from any State'));
    assert.ok(!isNameList('Too like the lightning, which doth cease to be Ere one can say, "It lightens"'));
    assert.ok(!isNameList('शून्य को साथ ले चल, जिसे कोई नहीं गिनता वही जगह रखता है'), 'scripts without case never qualify');
  });
  test('edge zones need a text of ≥ 1,000 tokens; reprints need ≥ 2,000 shared tokens and ≥ 30% of the shorter text', () => {
    assert.ok(inEdgeZone(10, 2000) && inEdgeZone(1900, 2000) && !inEdgeZone(1000, 2000));
    assert.ok(!inEdgeZone(0, 999), 'a short text has no front matter');
    assert.equal(PRODUCTION.minDocs, 3);
    assert.equal(coveredTokens([{ a0: 0, a1: 10, b0: 0, b1: 10 }, { a0: 5, a1: 20, b0: 30, b1: 45 }], 'a'), 20);
    assert.ok(isReprint(2400, 2500) && !isReprint(1999, 2000) && !isReprint(3000, 20000));
  });
  test('cue names: pronouns name no one; a first name does not cite a title that merely contains it', () => {
    assert.deepEqual(nameWords('I'), []);
    assert.deepEqual(nameWords('He'), []);
    assert.deepEqual(nameWords('Mr Wrexley'), ['wrexley']);
    assert.ok(!nameMatches('I', { title: 'Platero and I' }));
    assert.ok(!nameMatches('Tom', { author: 'Henry Fielding', title: 'The History of Tom Jones, a Foundling' }));
    assert.ok(!nameMatches('Jo', { title: "Jo's Boys" }));
    assert.ok(nameMatches('Hamlet', { title: 'Hamlet' }));
    assert.ok(nameMatches('Ready Arithmetic', { title: "Brennock's Ready Arithmetic" }), 'two of three title words');
    assert.ok(nameMatches('Miguel de Cervantes Saavedra', { author: 'Miguel de Cervantes Saavedra', title: 'Don Quijote' }));
  });
});

describe('reuse index: exclusions on a production line', () => {
  let tmp, db, ctx, res, ids;
  const passageOf = (docId, needle) => {
    const rows = db.prepare(`SELECT p.id, p.start_off, p.end_off, t.original FROM passage p JOIN document_text t ON t.document_id = p.document_id
      WHERE p.document_id = ? AND p.field = 'body' ORDER BY p.start_off`).all(docId);
    const at = rows[0].original.indexOf(needle);
    assert.ok(at >= 0, `${needle.slice(0, 20)}… in ${docId}`);
    return rows.find((r) => r.start_off <= at && at < r.end_off);
  };
  const rels = () => db.prepare('SELECT * FROM relationship WHERE run_id = ? ORDER BY id').all(res.run_id);
  const between = (a, b) => rels().filter((r) => [r.src_ref, r.dst_ref].sort().join() === [String(a), String(b)].sort().join());

  before(async () => {
    tmp = makeTmpData({ seed: false });
    db = tmp.db;
    db.prepare(`INSERT INTO corpus (slug, name, kind, is_synthetic, created_at) VALUES ('test', 'Test (synthetic)', 'synthetic', 1, '2026-10-04')`).run();
    const docs = [];
    // four books of one production line: the same transcriber's note opens each; the third quotes the first mid-body
    for (const [i, year] of [[1, '1900'], [2, '1910'], [3, '1920'], [4, '1930']]) {
      const mid = i === 1 || i === 3 ? ` ${QUOTE[0].toUpperCase()}${QUOTE.slice(1)}. ` : ' ';
      docs.push({ ext: `line-${i}`, year, text: `${NOTE}\n\n${filler(100 + i, 700)}${mid}${filler(200 + i, 700)}` });
    }
    // two tables of contents
    docs.push({ ext: 'toc-a', year: '1880', text: `${TOC}\n\n${filler(301, 300)}` }, { ext: 'toc-b', year: '1890', text: `${TOC}\n\n${filler(302, 300)}` });
    // a collected edition reprinting a whole book
    const book = filler(400, 2600);
    docs.push({ ext: 'book', year: '1940', title: 'The Long Book (synthetic)', text: book },
      { ext: 'collected', year: '1950', title: 'Collected Works (synthetic)', author: 'Other Editor (synthetic)', text: `${filler(401, 300)}\n\n${book}\n\n${filler(402, 300)}` });
    // 27 short texts sharing one sentence: widely shared, never pairs
    for (let i = 0; i < 27; i++) docs.push({ ext: `wide-${i}`, year: String(1950 + i), text: `${filler(500 + i, 40)} ${WIDE} ${filler(600 + i, 40)}` });
    // a stock phrase in two novels: under 10 aligned tokens, never a near quotation
    docs.push({ ext: 'stock-a', year: '1960', text: `${filler(900, 30)} ${STOCK} ${filler(901, 30)}` },
      { ext: 'stock-b', year: '1980', text: `${filler(902, 30)} ${STOCK} ${filler(903, 30)}` });
    // near quotation, one word changed
    docs.push({ ext: 'near-a', year: '1970', text: `${filler(700, 30)} ${NEAR_A} ${filler(701, 30)}` },
      { ext: 'near-b', year: '1990', text: `${filler(702, 30)} ${NEAR_B} ${filler(703, 30)}` });
    // cues: a pronoun; a character's first name; an author named after a later book
    docs.push({ ext: 'cues', year: '1975', text: `As I said, ${QUOTE}. And as Tom said, the dancing bear wore golden shoes all winter. `
      + `As Laterman wrote, the lantern swung over the empty harbour wall. ${filler(800, 60)}` },
    { ext: 'tom', year: '1940', title: 'Tom Ferris and the Fair (synthetic)', text: `${filler(801, 40)} the dancing bear wore golden shoes all winter ${filler(802, 40)}` },
    { ext: 'later', year: '2001', author: 'Ola Laterman (synthetic)', text: `${filler(803, 40)} the lantern swung over the empty harbour wall ${filler(804, 40)}` });
    ids = addDocs(db, 'filters', docs);
    ctx = makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
    res = await reuseIndex(ctx, {});
  });
  after(() => tmp.cleanup());

  test('a transcriber’s note opening every book of a production line is not a quotation; a mid-body quotation is', () => {
    const l1 = passageOf(ids['line-1'], 'Transcriber'), l2 = passageOf(ids['line-2'], 'Transcriber');
    assert.deepEqual(between(l1.id, l2.id), [], 'no link for the shared note');
    assert.ok(res.production_runs >= 1, JSON.stringify(res));
    assert.ok(res.exclusions.production_line.some((x) => /printer errors/.test(x.text)), JSON.stringify(res.exclusions));
    const q1 = passageOf(ids['line-1'], 'river keeps no ledger'), q3 = passageOf(ids['line-3'], 'river keeps no ledger');
    const link = between(q1.id, q3.id);
    assert.equal(link.length, 1);
    assert.deepEqual([link[0].rel_type, link[0].src_ref, link[0].dst_ref, link[0].evidence_status], ['exact_quotation', String(q3.id), String(q1.id), 'computed']);
  });

  test('numbering, reprints and widely shared text are excluded and counted; nothing algorithmic is documented', () => {
    const t = (ext) => passageOf(ids[ext], 'I II III').id;
    assert.deepEqual(between(t('toc-a'), t('toc-b')), []);
    assert.ok(res.structural_runs >= 1 && res.exclusions.structure.length >= 1);
    const book = db.prepare("SELECT id FROM passage WHERE document_id = ? AND field = 'body'").all(ids.book).map((r) => String(r.id));
    assert.ok(!rels().some((r) => book.includes(r.src_ref) || book.includes(r.dst_ref)), 'a reprint is an edition, not a quotation');
    assert.equal(res.reprint_pairs, 1);
    assert.match(res.exclusions.reprint[0].text, /Long Book/);
    assert.ok(res.exclusions.reprint[0].shared_tokens >= 2000);
    const wide = db.prepare(`SELECT p.id FROM passage p JOIN document d ON d.id = p.document_id WHERE d.ext_id LIKE 'wide-%'`).all().map((r) => String(r.id));
    assert.deepEqual(rels().filter((r) => wide.includes(r.src_ref)).map((r) => [r.rel_type, r.method, relationshipCard(db, r.id).evidence[0].quote]), [],
      'text shared by 27 documents makes no pairs');
    assert.ok(res.widespread_groups >= 1);
    assert.ok(rels().every((r) => r.evidence_status !== 'documented' && r.origin === 'algorithm'));
  });

  test('a stock phrase shared by two novels is not a near quotation; it is counted and sampled', () => {
    const a = passageOf(ids['stock-a'], 'beg your pardon'), b = passageOf(ids['stock-b'], 'beg your pardon');
    assert.deepEqual(between(a.id, b.id), []);
    assert.ok(res.near_short >= 1, JSON.stringify(res));
    assert.ok(res.exclusions.short_match.some((x) => /beg your pardon/.test(x.text)));
  });

  test('cues: "as I said" names no one, "as Tom said" does not cite a book titled Tom …, a later book is never the referent', () => {
    const cites = rels().filter((r) => r.rel_type === 'explicit_citation');
    assert.deepEqual(cites, []);
    assert.ok(res.cue_not_a_name >= 1, JSON.stringify(res));
    assert.equal(res.cue_referent_later, 1);
  });

  test('the near index is stored with the run and serves the trace (LSH lookup)', () => {
    const r = rels().find((x) => x.rel_type === 'near_quotation');
    assert.ok(r, 'near quotation found');
    const dir = path.join(tmp.dir, 'derived', 'reuse', `run-${res.run_id}`);
    assert.ok(existsSync(path.join(dir, 'units.bin')) && existsSync(path.join(dir, 'lsh.bin')));
    assert.ok(res.index.lsh_entries >= 2);
    const a = passageOf(ids['near-a'], 'in the long column');
    const hits = lookupNear(dir, tokenIds(tokenize(NEAR_B).tokens));
    assert.ok(hits.some((h) => h.passage === a.id), JSON.stringify(hits));
    const b = passageOf(ids['near-b'], 'in the wide column');
    const start = b.original.indexOf(NEAR_B);
    const q = traceQuery(db, { passage: b.id, start, end: start + NEAR_B.length });
    assert.deepEqual(q.near_index, { run: res.run_id });
    const viaLsh = q.near.find((x) => x.passage === a.id);
    assert.equal(viaLsh.via, 'lsh');
    assert.ok(viaLsh.score >= 0.75 && viaLsh.jaccard >= 0.5);
  });

  test('the targeted trace applies the same exclusions: matches are listed, no links are made', () => {
    const span = (ext, needle) => {
      const p = passageOf(ids[ext], needle);
      const start = p.original.indexOf(needle);
      return { passage: p.id, start, end: start + needle.length };
    };
    const note = traceSpan(db, ctx, span('line-2', NOTE));
    assert.equal(note.exclusion.kind, 'production_line');
    assert.equal(note.exact.length, 3, 'the other three books are listed');
    assert.deepEqual(note.created_relationships, []);
    assert.match(note.note, /^Cross-language reuse is not detected\. This wording opens or closes 4 documents/);
    const wide = traceSpan(db, ctx, span('wide-3', WIDE));
    assert.deepEqual([wide.exclusion.kind, wide.exclusion.documents, wide.created_relationships], ['widely_shared', 27, []]);
    const toc = traceQuery(db, span('toc-a', TOC));
    assert.equal(toc.exclusion.kind, 'structure');
    const quote = traceQuery(db, span('line-3', 'river keeps no ledger of the stones it carries down to the sea'));
    assert.equal(quote.exclusion, null);
    assert.ok(quote.exact.some((m) => m.doc === ids['line-1']));
  });

  test('people’s reviews survive a rerun: the new run’s link carries them; the evidence status never moves', async () => {
    const q1 = passageOf(ids['line-1'], 'river keeps no ledger'), q3 = passageOf(ids['line-3'], 'river keeps no ledger');
    const old = between(q1.id, q3.id)[0];
    reviewRelationship(db, old.id, { action: 'reject', note: 'Both copy a proverb from an older almanac.', author: 'Reader B (synthetic)' });
    const quote = q3.original.indexOf('river keeps no ledger');
    attachEvidence(db, old.id, { passage: q3.id, start: quote, end: quote + 15, role: 'contradicting', note: 'The almanac line, for comparison.',
      author: 'Reader A (synthetic)' });
    const again = await reuseIndex(ctx, { force: true });
    assert.equal(db.prepare('SELECT status FROM analysis_run WHERE id = ?').get(res.run_id).status, 'superseded');
    assert.deepEqual(again.carried_reviews, { reviews_carried: 2, links: 1, not_found: 0, not_found_ids: [] });
    const fresh = db.prepare(`SELECT * FROM relationship WHERE run_id = ? AND rel_type = 'exact_quotation' AND src_ref = ? AND dst_ref = ?`)
      .get(again.run_id, String(q3.id), String(q1.id));
    assert.ok(fresh && fresh.id !== old.id);
    assert.equal(fresh.review_status, 'rejected');
    assert.equal(fresh.evidence_status, 'computed');
    const card = relationshipCard(db, fresh.id);
    assert.deepEqual(card.revisions.map((v) => [v.rev, v.action, v.actor]),
      [[1, 'create', `run:${again.run_id}`], [2, 'reject', 'human:Reader B (synthetic)'], [3, 'add_evidence', 'human:Reader A (synthetic)']]);
    assert.deepEqual(card.revisions[1].after.carried_from, { relationship: old.id, rev: 2, run: res.run_id });
    const oldCard = relationshipCard(db, old.id);
    assert.equal(card.revisions[1].annotation_id, oldCard.revisions[1].annotation_id, 'the reviewer’s note is the same annotation');
    assert.ok(card.evidence.some((e) => e.role === 'contradicting' && e.added_by === 'human:Reader A (synthetic)'));
    // the default lineage hides the rejected link, as before the rerun; on request it is shown, still computed
    const root = `passage:${q1.id}`;
    assert.ok(!lineageQuery(db, { root }).edges.some((e) => e.rel_id === fresh.id));
    const shown = lineageQuery(db, { root, rejected: '1' }).edges.find((e) => e.rel_id === fresh.id);
    assert.deepEqual([shown.evidence_status, shown.review_status], ['computed', 'rejected']);
  });
});
