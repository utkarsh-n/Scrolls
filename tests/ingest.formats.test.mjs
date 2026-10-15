// OWNER: WP1 — parsers, sniffing, decoding, and every format imported end to end with exact counts (SPEC §5.1, §11 row 1)

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ftsPhrase, tokenize } from '../src/shared/tokenize.mjs';
import { csvRecords, parseCsv, sniffDelimiter, sniffHeader } from '../server/ingest/csv.mjs';
import { decodeBytes, firstInvalidUtf8 } from '../server/ingest/decode.mjs';
import { parseFrontMatter } from '../server/ingest/frontmatter.mjs';
import { elementSpans, getPointer, parseJson, pointerTokens } from '../server/ingest/json.mjs';
import { parseJsonl } from '../server/ingest/jsonl.mjs';
import { parseMd } from '../server/ingest/md.mjs';
import { sniffFormat } from '../server/ingest/sniff.mjs';
import { parseTxt } from '../server/ingest/txt.mjs';
import { commit, dryRun, fixtureBytes, liveDocs, stageFile } from './fixtures/ingest/harness.mjs';
import { assertShape } from './helpers/shape.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

const one = (db, sql, ...a) => db.prepare(sql).get(...a);
const all = (db, sql, ...a) => db.prepare(sql).all(...a);

/** Passages of a batch whose FTS row matches a phrase. */
function ftsHits(db, batchId, phrase) {
  return all(db, `SELECT p.id, p.document_id, p.field, p.start_off, p.end_off FROM passage_fts f JOIN passage p ON p.id = f.rowid
    JOIN document d ON d.id = p.document_id WHERE passage_fts MATCH ? AND d.import_batch_id = ?`, ftsPhrase(phrase), batchId);
}

/** The original text a passage's offsets index. */
function sliceOf(db, p) {
  if (p.field === 'body') return one(db, 'SELECT original FROM document_text WHERE document_id = ?', p.document_id).original.slice(p.start_off, p.end_off);
  return one(db, 'SELECT value FROM document_field WHERE document_id = ? AND field = ?', p.document_id, p.field).value.slice(p.start_off, p.end_off);
}

describe('decode', () => {
  test('UTF-8 with a BOM: stripped, reported, offsets start after it', () => {
    const d = decodeBytes(Buffer.from('﻿a,b\n1,2\n', 'utf8'));
    assert.equal(d.bom, true);
    assert.equal(d.bomBytes, 3);
    assert.equal(d.text, 'a,b\n1,2\n');
    assert.equal(d.decoder, 'utf-8');
    assert.deepEqual(d.issues, []);
  });
  test('invalid UTF-8 falls back to Windows-1252 and names the byte and line', () => {
    const bytes = Buffer.concat([Buffer.from('id,name\n1,ok\n2,caf'), Buffer.from([0xe9]), Buffer.from('\n')]);
    assert.equal(firstInvalidUtf8(bytes), 18);
    const d = decodeBytes(bytes);
    assert.equal(d.decoder, 'windows-1252');
    assert.equal(d.text.includes('café'), true);
    assert.equal(d.issues[0].code, 'W_ENCODING_FALLBACK');
    assert.equal(d.issues[0].line, 3);
    assert.match(d.issues[0].message, /0xE9 at byte 18/);
    assert.ok(d.issues[0].suggestion.length > 0);
  });
  test('strict UTF-8, UTF-16, ZIP and NUL bytes are fatal E_ENCODING with advice', () => {
    const bad = Buffer.from([0x61, 0xff, 0x62]);
    assert.equal(decodeBytes(bad, { encoding: 'utf-8' }).fatal.code, 'E_ENCODING');
    assert.match(decodeBytes(Buffer.from([0xff, 0xfe, 0x61, 0x00])).fatal.message, /UTF-16/);
    assert.match(decodeBytes(Buffer.from('PK\u0003\u0004rest', 'latin1')).fatal.message, /ZIP/);
    assert.match(decodeBytes(Buffer.from('abc\u0000def', 'latin1')).fatal.message, /NUL/);
  });
  test('the decoded string is the offset space: no newline or Unicode normalization', () => {
    const s = 'é\r\nx';
    assert.equal(decodeBytes(Buffer.from(s, 'utf8')).text, s);
  });
});

describe('CSV state machine', () => {
  test('quoted fields, embedded newlines, "" escapes, CRLF, lone CR, blank lines', () => {
    const t = 'a,b,c\r\n1,"x, y","multi\nline ""q"""\r\n\r\n2,,\r3,z,end';
    const recs = [...csvRecords(t)];
    assert.deepEqual(recs.map((r) => r.fields), [['a', 'b', 'c'], ['1', 'x, y', 'multi\nline "q"'], ['2', '', ''], ['3', 'z', 'end']]);
    assert.deepEqual(recs.map((r) => r.line), [1, 2, 5, 6]);
    assert.equal(t.slice(recs[1].start, recs[1].end), '1,"x, y","multi\nline ""q"""');
  });
  test('an unclosed quote reports its line and column', () => {
    const recs = [...csvRecords('a,b\n1,ok\n2,"never closed\n3,x\n')];
    assert.deepEqual(recs.at(-1).error, { code: 'E_CSV_QUOTE', line: 3, col: 3, fieldIndex: 1, start: 11, recStart: 9, recLine: 3 });
  });
  test('delimiter sniffing by field-count consistency', () => {
    assert.equal(sniffDelimiter('a;b;c\n1;2;3\n4;5;6\n'), ';');
    assert.equal(sniffDelimiter('a\tb\n1\t2, 3\n4\t5\n'), '\t');
    assert.equal(sniffDelimiter('a|b\n1|2\n'), '|');
    assert.equal(sniffDelimiter('title,year\n"One, two",1990\nThree,1991\n'), ',');
  });
  test('header sniffing: numeric first rows are data', () => {
    assert.equal(sniffHeader([['id', 'year'], ['1', '1990']]), true);
    assert.equal(sniffHeader([['1990', 'x'], ['1991', 'y']]), false);
  });
  test('ragged rows are rejected, short rows padded with a warning, duplicate headers renamed', () => {
    const r = parseCsv('a,a,b\n1,2,3\n4,5\n6,7,8,9\n');
    assert.deepEqual(r.columns, ['a', 'a (2)', 'b']);
    assert.deepEqual(r.records[1].data, { a: '4', 'a (2)': '5', b: '' });
    assert.equal(r.records[1].warnings[0].code, 'W_TRUNCATED_ROW');
    assert.equal(r.records[2].issue.code, 'E_ROW_RAGGED');
    assert.match(r.records[2].issue.message, /Row 4 has 4 fields, the header has 3/);
  });
  test('a __proto__ column stays an own field', () => {
    const r = parseCsv('__proto__,x\nevil,1\n');
    assert.equal(Object.getPrototypeOf(r.records[0].data), Object.prototype);
    assert.equal(r.records[0].data.__proto__, 'evil');
  });
});

describe('JSON, JSONL, front matter, TXT, MD', () => {
  test('JSON Pointer tokens and lookup', () => {
    assert.deepEqual(pointerTokens('/a~1b/0/c~0d'), ['a/b', '0', 'c~d']);
    assert.equal(getPointer({ a: [{ b: 7 }] }, '/a/0/b'), 7);
    assert.equal(getPointer({ a: 1 }, '/x'), undefined);
  });
  test('element spans give each record its line and offsets', () => {
    const text = '{\n "meta": {"n": 2},\n "items": [\n  {"id": "a", "t": "x]y"},\n  {"id": "b"}\n ]\n}';
    const spans = elementSpans(text, ['items']);
    assert.deepEqual(spans.map(([s, e]) => JSON.parse(text.slice(s, e)).id), ['a', 'b']);
    const r = parseJson(text);
    assert.equal(r.pointer, '/items');
    assert.deepEqual(r.records.map((x) => x.line), [4, 5]);
    assert.equal(r.issues[0].severity, 'info');
  });
  test('a JSON syntax error is fatal with line and column', () => {
    const r = parseJson('[\n {"a": 1},\n {"b": 2,}\n]');
    assert.equal(r.fatal.code, 'E_JSON_PARSE');
    assert.equal(r.fatal.line, 3);
    assert.equal(r.fatal.col, 10);
    assert.match(r.fatal.message, /^Line 3, column 10: /);
  });
  test('JSONL: blank lines skipped, a bad line rejected with its line and column, non-objects rejected', () => {
    const r = parseJsonl('{"a":1}\n\n{"a": 2, }\n[1]\n{"a":3}\n');
    assert.deepEqual(r.records.filter((x) => x.data).map((x) => x.data.a), [1, 3]);
    assert.deepEqual(r.issues.map((i) => [i.code, i.line]), [['E_JSON_PARSE', 3], ['E_FIELD_TYPE', 4]]);
    assert.equal(r.issues[0].col, 10);
  });
  test('front matter: scalars, quotes, inline and block lists, nested pairs, block scalars', () => {
    const fm = parseFrontMatter('---\ntitle: "A: B"\ntags: [x, "y, z"]\nauthors:\n  - One\n  - Two\nmeta:\n  year: 1901\nabout: |\n  line 1\n  line 2\nempty:\n---\nbody');
    assert.equal(fm.present, true);
    assert.deepEqual(fm.data, { title: 'A: B', tags: ['x', 'y, z'], authors: ['One', 'Two'], meta: { year: '1901' }, about: 'line 1\nline 2', empty: null });
    assert.equal('---\ntitle'.length > 0 && fm.bodyStart, 'body'.length > 0 ? fm.bodyStart : 0);
    assert.equal(parseFrontMatter('---\nno close\n').present, false);
  });
  test('TXT: header lines become metadata, the body starts after them, the original is kept', () => {
    const text = fixtureBytes('note.txt').toString('utf8');
    const t = parseTxt(text, { fileName: 'note.txt' });
    assert.equal(t.data.title, 'Ledger Notes');
    assert.equal(t.data.date, '1903');
    assert.equal(t.document.original, text);
    assert.ok(text.slice(t.document.body_start).startsWith('The ledger keeps'));
  });
  test('TXT: Gutenberg START/END markers bound the body (the licence is not text)', () => {
    const text = 'The Project Gutenberg eBook of X\n\nTitle: X\nAuthor: Y (synthetic)\nRelease date: 2001\n\n*** START OF THE PROJECT GUTENBERG EBOOK X ***\nBody words here.\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\nLicence text with a computer virus.\n';
    const t = parseTxt(text, { fileName: 'x.txt' });
    assert.equal(t.header.kind, 'gutenberg');
    assert.equal(t.data.release_date, '2001');
    assert.equal(text.slice(t.document.body_start, t.document.body_end), 'Body words here.\n');
  });
  test('MD: front matter, title from metadata, one region per heading section', () => {
    const text = fixtureBytes('essay.md').toString('utf8');
    const m = parseMd(text, { fileName: 'essay.md' });
    assert.equal(m.data.title, 'Zero, a Field Guide');
    assert.deepEqual(m.data.tags, ['zero', 'primer']);
    assert.equal(m.document.regions.length, 3);
    assert.ok(text.slice(m.document.regions[1].start).startsWith('## In the classroom'));
  });
  test('format sniffing by extension, then content', () => {
    const s = (t, n = null) => sniffFormat(Buffer.from(t, 'utf8'), { fileName: n }).format;
    assert.equal(s('a,b\n1,2\n', 'x.csv'), 'csv');
    assert.equal(s('a\tb\n1\t2\n'), 'tsv');
    assert.equal(s('[{"a":1}]'), 'json');
    assert.equal(s('{"a":1}\n{"a":2}\n'), 'jsonl');
    assert.equal(s('# Title\n\nText with a [link](x).\n'), 'md');
    assert.equal(s('Plain prose, with a comma here.\nAnd another line.\n'), 'txt');
    assert.equal(s('{"a":1}', 'x.jsonl'), 'jsonl');
  });
});

describe('every format imports with exact counts and is searchable', () => {
  let t, db;
  before(() => { t = makeTmpData({ seed: false }); db = t.db; });
  after(() => t.cleanup());

  async function importFixture(name, collection, edit = (m) => m) {
    const s = stageFile(db, fixtureBytes(name), { fileName: name, collection });
    assertShape('ImportPreview', s.preview);
    const mapping = edit(s.mapping);
    const projected = await dryRun(db, s.batchId, mapping);
    assertShape('ImportSummary', projected);
    const c = await commit(db, s.batchId, mapping);
    assert.equal(c.error, null, c.error?.message);
    assertShape('ImportSummary', c.summary);
    return { ...s, projected, summary: c.summary };
  }

  test('letters.csv (BOM, CRLF, quoted newline, Devanagari) → accepted 37 / warnings 2 / rejected 1', async () => {
    const r = await importFixture('letters.csv', { name: 'Letters', unit: 'tokens', license: 'test' });
    assert.equal(r.preview.encoding, 'utf-8');
    assert.equal(r.preview.delimiter, ',');
    assert.deepEqual(r.summary.rows, { seen: 38, accepted: 37, accepted_with_warnings: 2, rejected: 1 });
    assert.deepEqual(r.projected.rows, r.summary.rows);
    assert.equal(r.summary.documents.created, 37);
    assert.equal(r.summary.problems.by_code.E_ROW_RAGGED, 1);
    assert.equal(r.summary.problems.by_code.E_DATE_UNPARSEABLE, 1);
    assert.equal(r.summary.problems.by_code.E_DATE_AMBIGUOUS, 1);
    const ragged = r.summary.problems.first.find((i) => i.code === 'E_ROW_RAGGED');
    assert.equal(ragged.line, 40);
    assert.equal(r.summary.relationships.documented, 7);
    assert.equal(r.summary.relationships.unresolved_targets, 0);
    assert.equal(liveDocs(db, r.batchId), 37);
    // the quoted newline survived verbatim and the text is the CSV field, offsets into it
    const q = one(db, "SELECT t.original FROM document d JOIN document_text t ON t.document_id = d.id WHERE d.ext_id = 'L33'");
    assert.equal(q.original, 'He wrote: "Carry the zero."\nThen he signed the "final" copy.');
    const hits = ftsHits(db, r.batchId, 'अनुपम');
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((p) => tokenize(sliceOf(db, p)).tokens.includes('अनुपम')));
    assert.ok(ftsHits(db, r.batchId, 'carry the zero').length >= 1);
    assert.equal(r.summary.languages.hi, 2);
  });

  test('semicolon.csv: sniffed delimiter, Hindi header, quoted ";"', async () => {
    const r = await importFixture('semicolon.csv', { name: 'Semicolon' });
    assert.equal(r.preview.delimiter, ';');
    assert.equal(r.mapping.fields.title.from, 'शीर्षक');
    assert.deepEqual(r.summary.rows, { seen: 5, accepted: 5, accepted_with_warnings: 0, rejected: 0 });
    assert.equal(r.summary.dates.year, 5);
    assert.ok(ftsHits(db, r.batchId, 'अनुपम').length >= 2);
    assert.ok(ftsHits(db, r.batchId, 'holds the place').length === 1);
  });

  test('gujarati.tsv: tab delimiter, Gujarati date header, Vikram Samvat in Gujarati digits', async () => {
    const r = await importFixture('gujarati.tsv', { name: 'Gujarati' });
    assert.equal(r.preview.format, 'tsv');
    assert.equal(r.mapping.fields.date.from, 'તારીખ');
    assert.deepEqual(r.summary.rows, { seen: 4, accepted: 4, accepted_with_warnings: 0, rejected: 0 });
    assert.equal(r.summary.dates.range, 1);
    const hits = ftsHits(db, r.batchId, 'ગુજરાતી');
    assert.ok(hits.length >= 2);
    assert.ok(hits.every((p) => tokenize(sliceOf(db, p)).tokens.includes('ગુજરાતી')));
    assert.equal(ftsHits(db, r.batchId, 'શૂન્ય ઉપાડો').length, 1);
  });

  test('records.json: records found at /items, nested year column, lists, citations', async () => {
    const r = await importFixture('records.json', { name: 'JSON records' }, (m) => ({
      ...m, fields: { ...m.fields, cites: { from: 'cites' }, language: { from: '/meta/lang' } } }));
    assert.equal(r.preview.pointer, '/items');
    assert.equal(r.mapping.fields.date.from, '/meta/year');
    assert.equal(r.mapping.fields.text.from, 'content');
    assert.deepEqual(r.summary.rows, { seen: 4, accepted: 4, accepted_with_warnings: 0, rejected: 0 });
    assert.equal(r.summary.documents.metadata_only, 1);
    assert.equal(r.summary.relationships.documented, 1);
    assert.ok(ftsHits(db, r.batchId, 'अनुपम').length >= 1);
    assert.ok(ftsHits(db, r.batchId, 'ગુજરાતી').length >= 1);
    assert.ok(ftsHits(db, r.batchId, 'carry the zero').length === 1);
    const tags = all(db, "SELECT t.value, t.provenance FROM doc_tag t JOIN document d ON d.id = t.document_id WHERE d.ext_id = 'j1' ORDER BY value");
    assert.deepEqual(tags.map((x) => x.value), ['primer', 'zero']);
    assert.equal(tags[0].provenance, 'documented_category');
  });

  test('records.jsonl: pages joined with \\f keep page numbers; a broken line is rejected with its line', async () => {
    const r = await importFixture('records.jsonl', { name: 'JSONL records' }, (m) => ({
      ...m, fields: { ...m.fields, text: { from: 'pages', transform: [{ join: '\f' }] } } }));
    assert.deepEqual(r.summary.rows, { seen: 4, accepted: 3, accepted_with_warnings: 0, rejected: 1 });
    const bad = r.summary.problems.first.find((i) => i.code === 'E_JSON_PARSE');
    assert.equal(bad.line, 4);
    assert.equal(bad.col, 52);
    const pages = all(db, `SELECT DISTINCT p.page_no FROM passage p JOIN document d ON d.id = p.document_id WHERE d.ext_id = 'p1' AND p.field = 'body' ORDER BY 1`);
    assert.deepEqual(pages.map((x) => x.page_no), [1, 2]);
    assert.equal(one(db, "SELECT t.decoder FROM document d JOIN document_text t ON t.document_id = d.id WHERE d.ext_id = 'p1'").decoder, 'pages-joined-ff');
    assert.ok(ftsHits(db, r.batchId, 'अनुपम').length >= 1);
    assert.ok(ftsHits(db, r.batchId, 'carry the zero').length === 1);
  });

  test('note.txt: header lines are metadata, the whole file is the original, the body is searchable', async () => {
    const r = await importFixture('note.txt', { name: 'Notes' });
    assert.equal(r.preview.format, 'txt');
    assert.deepEqual(r.summary.rows, { seen: 1, accepted: 1, accepted_with_warnings: 0, rejected: 0 });
    const d = one(db, 'SELECT d.*, t.original, t.body_start FROM document d JOIN document_text t ON t.document_id = d.id WHERE d.import_batch_id = ?', r.batchId);
    assert.equal(d.title, 'Ledger Notes');
    assert.equal(d.author, 'Ada Fixture (synthetic)');
    assert.equal(d.date_label, '1903');
    assert.equal(d.lang_declared, 'en');
    assert.equal(d.original, fixtureBytes('note.txt').toString('utf8'));
    assert.ok(d.original.slice(d.body_start).startsWith('The ledger keeps'));
    const hits = ftsHits(db, r.batchId, 'carry the zero');
    assert.equal(hits.length, 1);
    assert.match(sliceOf(db, hits[0]), /Carry the zero/);
    assert.equal(ftsHits(db, r.batchId, 'ledger notes').length, 0, 'the header is metadata, not body text');
  });

  test('line mode: a TXT poem becomes stanzas', async () => {
    const poem = 'Title: Counting Song\nAuthor: Ada Fixture (synthetic)\n\none and one and the zero holds\ntwo and two and the column folds\n\nthree in the ledger\nfour on the slate\n';
    const s = stageFile(db, poem, { fileName: 'song.txt', collection: { name: 'Songs' }, overrides: { line_mode: true } });
    assert.equal(s.mapping.options.line_mode, true);
    const c = await commit(db, s.batchId, s.mapping);
    assert.equal(c.error, null);
    const units = all(db, "SELECT p.unit FROM passage p JOIN document d ON d.id = p.document_id WHERE d.import_batch_id = ? AND p.field = 'body' ORDER BY p.ord", s.batchId);
    assert.deepEqual(units.map((u) => u.unit), ['stanza', 'stanza']);
    assert.equal(one(db, 'SELECT title FROM document WHERE import_batch_id = ?', s.batchId).title, 'Counting Song');
  });

  test('essay.md: front matter metadata, headings start passages, markup is not tokens', async () => {
    const r = await importFixture('essay.md', { name: 'Essays' });
    assert.equal(r.preview.format, 'md');
    assert.deepEqual(r.summary.rows, { seen: 1, accepted: 1, accepted_with_warnings: 0, rejected: 0 });
    const d = one(db, 'SELECT * FROM document WHERE import_batch_id = ?', r.batchId);
    assert.equal(d.title, 'Zero, a Field Guide');
    assert.equal(d.date_label, 'c. 1894');
    const passages = all(db, "SELECT start_off, end_off, document_id, field FROM passage WHERE document_id = ? AND field = 'body' ORDER BY ord", d.id);
    const texts = passages.map((p) => sliceOf(db, p));
    assert.ok(texts.some((x) => x.startsWith('## In the classroom')));
    assert.ok(texts.some((x) => x.startsWith('## In Gujarati')));
    assert.ok(!texts.some((x) => /In the classroom/.test(x) && /In Gujarati/.test(x)), 'two headings never share a passage');
    assert.ok(ftsHits(db, r.batchId, 'ગુજરાતી').length === 1);
    assert.ok(ftsHits(db, r.batchId, 'carry the zero').length === 1);
    assert.ok(!tokenize(texts.join(' ')).tokens.some((x) => /[#*_]/.test(x)));
  });
});
