// OWNER: WP1 — malformed input gives actionable feedback, and failed imports leave nothing (SPEC §5.5, §11 row 9)

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { check } from '../src/shared/contracts.mjs';
import { allDocs, commit, dryRun, stageFile } from './fixtures/ingest/harness.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

const one = (db, sql, ...a) => db.prepare(sql).get(...a);

/** Every issue is actionable: code, line (where the file has one), message, non-empty suggestion. */
function assertActionable(issue, { line = true } = {}) {
  assert.deepEqual(check('Issue', issue), [], JSON.stringify(issue));
  assert.ok(issue.code && issue.message && issue.suggestion.trim().length > 0, JSON.stringify(issue));
  if (line) assert.ok(Number.isInteger(issue.line), `${issue.code} has a line`);
}

const HEADER8 = 'id,title,author,date,lang,body,refs,notes';
const row8 = (i) => `r${i},Title ${i},Author (synthetic),${1900 + (i % 90)},en,A short body of text for row ${i} about the ledger.,,note ${i}`;

/** A CSV whose line `at` is `bad`, padded with good rows (one record per line). */
function csvWith(at, bad, total = at + 3) {
  const lines = [HEADER8];
  for (let ln = 2; ln <= total; ln++) lines.push(ln === at ? bad : row8(ln));
  return `${lines.join('\n')}\n`;
}

describe('malformed input → actionable issues', () => {
  let t, db;
  before(() => { t = makeTmpData({ seed: false }); db = t.db; });
  after(() => t.cleanup());

  test('invalid UTF-8: byte offset, line and the Windows-1252 fallback; strict UTF-8 is fatal with zero documents', async () => {
    const head = Buffer.from(`${HEADER8}\n${row8(2)}\n`, 'utf8');
    const bad = Buffer.concat([head, Buffer.from('r3,Caf'), Buffer.from([0xe9]), Buffer.from(`,Author (synthetic),1903,fr,Un texte court sur le registre du café.,,\n${row8(4)}\n`)]);
    const s = stageFile(db, bad, { fileName: 'latin1.csv', collection: { name: 'Latin1' } });
    assert.equal(s.preview.encoding, 'windows-1252');
    const w = s.preview.issues.find((i) => i.code === 'W_ENCODING_FALLBACK');
    assertActionable(w);
    assert.equal(w.line, 3);
    assert.match(w.message, new RegExp(`0xE9 at byte ${head.length + 6}`));
    assert.equal(w.value_excerpt.includes('Café'), true, 'the fallback reading is shown');
    const ok = await dryRun(db, s.batchId, s.mapping);
    assert.equal(ok.rows.accepted, 3);
    const strict = { ...s.mapping, encoding: 'utf-8' };
    const projected = await dryRun(db, s.batchId, strict);
    assert.equal(projected.fatal.code, 'E_ENCODING');
    assertActionable(projected.fatal);
    const c = await commit(db, s.batchId, strict);
    assert.equal(c.error.code, 'E_ENCODING');
    assert.equal(allDocs(db, s.batchId), 0);
    assert.equal(one(db, 'SELECT status FROM import_batch WHERE id = ?', s.batchId).status, 'failed');
  });

  test('ragged row 57: field counts and the column to check', async () => {
    const s = stageFile(db, csvWith(57, 'r57,Title, with comma,Author (synthetic),1950,en,Body text of the ragged row.,,n'), { fileName: 'ragged.csv', collection: { name: 'Ragged' } });
    const r = await dryRun(db, s.batchId, s.mapping);
    const i = r.problems.first.find((x) => x.code === 'E_ROW_RAGGED');
    assertActionable(i);
    assert.equal(i.line, 57);
    assert.equal(i.message, 'Row 57 has 9 fields, the header has 8.');
    assert.match(i.suggestion, /^Check for an unquoted comma in '.+'/);
    assert.equal(r.rows.rejected, 1);
    assert.equal(r.rows.accepted, 58);
  });

  test('unclosed quote: line 77, column 14; the whole import is refused (zero documents)', async () => {
    const s = stageFile(db, csvWith(77, 'r77,Title 77,"Unclosed author,1950,en,body,,n', 90), { fileName: 'quote.csv', collection: { name: 'Quote' } });
    const pi = s.preview.issues.find((x) => x.code === 'E_CSV_QUOTE');
    assertActionable(pi);
    assert.equal(s.preview.fatal.code, 'E_CSV_QUOTE', 'the preview already shows why the file cannot be imported');
    const r = await dryRun(db, s.batchId, s.mapping);
    assert.equal(r.fatal.code, 'E_CSV_QUOTE');
    assertActionable(r.fatal);
    assert.equal(r.fatal.line, 77);
    assert.equal(r.fatal.col, 14);
    assert.equal(r.fatal.message, 'An unclosed quote starts on line 77, column 14 and runs to the end of the file.');
    assert.equal(r.fatal.suggestion.startsWith('Check for a stray " in \'author\''), true);
    // forcing the commit anyway: the fatal error comes mid-commit, after 75 rows were written, and leaves none
    const c = await commit(db, s.batchId, s.mapping);
    assert.equal(c.error.code, 'E_CSV_QUOTE');
    assert.equal(c.error.hint, r.fatal.suggestion);
    assert.equal(allDocs(db, s.batchId), 0);
    assert.equal(one(db, "SELECT count(*) AS n FROM import_issue WHERE batch_id = ? AND code = 'E_CSV_QUOTE'", s.batchId).n, 1);
  });

  test('JSONL syntax error on line 7 with its column; the other lines import', async () => {
    const lines = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(i === 7 ? '{"id": "j7", "title": "Seven", "text": "broken" "x"}' : JSON.stringify({ id: `j${i}`, title: `T${i}`, text: `Body number ${i} of the JSON lines file.` }));
    }
    const s = stageFile(db, `${lines.join('\n')}\n`, { fileName: 'lines.jsonl', collection: { name: 'Lines' } });
    const pi = s.preview.issues.find((x) => x.code === 'E_JSON_PARSE');
    assertActionable(pi);
    assert.equal(pi.line, 7);
    assert.equal(pi.col, 49);
    assert.match(pi.message, /^Line 7, column 49: expected ',' or '}' after property value/);
    const c = await commit(db, s.batchId, s.mapping);
    assert.equal(c.error, null);
    assert.deepEqual(c.summary.rows, { seen: 10, accepted: 9, accepted_with_warnings: 0, rejected: 1 });
  });

  test('an unexpected token (V8 names no position) still gets its line and column, in JSONL and in a whole JSON file', async () => {
    const lines = [];
    for (let i = 1; i <= 9; i++) lines.push(i === 8 ? '{"id":"u8", "title": broken json line' : JSON.stringify({ id: `u${i}`, title: `T${i}`, text: `Body ${i} of the file.` }));
    const s = stageFile(db, `${lines.join('\n')}\n`, { fileName: 'tokens.jsonl', collection: { name: 'Tokens' } });
    const pi = s.preview.issues.find((x) => x.code === 'E_JSON_PARSE');
    assertActionable(pi);
    assert.equal(pi.line, 8);
    assert.equal(pi.col, 22);
    assert.match(pi.message, /^Line 8, column 22: unexpected token 'b'/);
    const arr = `[\n${Array.from({ length: 40 }, (_, i) => (i === 26 ? '  {"id": "T27", "title": T27}' : `  {"id": "T${i + 1}", "title": "x"}`)).join(',\n')}\n]`;
    const f = stageFile(db, arr, { fileName: 'bad.json', collection: { name: 'Bad JSON' } });
    const fatal = f.preview.issues.find((x) => x.code === 'E_JSON_PARSE');
    assertActionable(fatal);
    assert.equal(fatal.line, 28);
    assert.equal(fatal.col, 26);
    assert.match(fatal.message, /^Line 28, column 26: unexpected token 'T'/);
  });

  test('a CSV with a header row and no records says so (W_NO_RECORDS) at preview and at commit', async () => {
    const s = stageFile(db, 'id,title\n', { fileName: 'headeronly.csv', collection: { name: 'Header only' } });
    const d = await dryRun(db, s.batchId, s.mapping);
    const w = d.problems.first.find((x) => x.code === 'W_NO_RECORDS');
    assertActionable(w);
    assert.equal(w.line, 1);
    assert.match(w.message, /header row but no records/);
    const c = await commit(db, s.batchId, s.mapping);
    assert.equal(one(db, "SELECT count(*) AS n FROM import_issue WHERE batch_id = ? AND code = 'W_NO_RECORDS'", s.batchId).n, 1);
    assert.equal(c.summary.rows.seen, 0);
  });

  test('an empty record is rejected as E_MISSING_TEXT; dates that do not parse keep the row, undated, with a suggestion', async () => {
    const csv = [
      'id,title,body,date',
      'a,,,1901',
      'b,Bad date,Body text one,Spring-ish 1850',
      "c,Ambiguous,Body text two,'90s",
      'd,Invalid,Body text three,2019-02-30',
      'e,Fine,Body text four,1904',
    ].join('\n');
    const s = stageFile(db, `${csv}\n`, { fileName: 'dates.csv', collection: { name: 'Dates' } });
    const c = await commit(db, s.batchId, s.mapping);
    assert.equal(c.error, null);
    assert.deepEqual(c.summary.rows, { seen: 5, accepted: 4, accepted_with_warnings: 3, rejected: 1 });
    const by = Object.fromEntries(c.summary.problems.first.map((i) => [i.code, i]));
    for (const code of ['E_MISSING_TEXT', 'E_DATE_UNPARSEABLE', 'E_DATE_AMBIGUOUS', 'E_DATE_INVALID']) assertActionable(by[code]);
    assert.equal(by.E_MISSING_TEXT.message, 'Row 2 has no text and no title.');
    assert.equal(by.E_DATE_AMBIGUOUS.message, "Row 4 date ''90s': which century? Set 'two-digit years → 19xx'. Row imported as undated.");
    assert.equal(by.E_DATE_INVALID.message, 'Row 5 date 2019-02-30 does not exist; row imported as undated.');
    for (const ext of ['b', 'c', 'd']) {
      const d = one(db, 'SELECT chrono_status FROM document WHERE ext_id = ? AND import_batch_id = ?', ext, s.batchId);
      assert.equal(d.chrono_status, 'undated');
      const a = one(db, "SELECT raw, rule, note FROM date_assertion WHERE subject_type = 'document' AND role = 'publication' AND subject_id = (SELECT id FROM document WHERE ext_id = ? AND import_batch_id = ?)", ext, s.batchId);
      assert.equal(a.rule, 'unparsed');
      assert.ok(a.raw && a.note, 'the raw date and why it was not read are kept');
    }
  });

  test('a 31 MB field is rejected (E_ROW_TOO_LARGE) and the other rows import', async () => {
    const big = 'word '.repeat(Math.ceil((31 * 1024 * 1024) / 5));
    const csv = `id,title,body\nsmall,Small,A small body of text.\nbig,Big,${big}\nafter,After,Another small body.\n`;
    const s = stageFile(db, csv, { fileName: 'big.csv', collection: { name: 'Big' } });
    const r = await dryRun(db, s.batchId, s.mapping);
    const i = r.problems.first.find((x) => x.code === 'E_ROW_TOO_LARGE');
    assertActionable(i);
    assert.equal(i.line, 3);
    assert.equal(i.message, 'Row 3 text is 31 MB (limit 20 MB).');
    assert.deepEqual(r.rows, { seen: 3, accepted: 2, accepted_with_warnings: 0, rejected: 1 });
  });

  test('duplicate id in one file: the second row is rejected, citing both lines', async () => {
    const s = stageFile(db, 'id,title,body\nx1,One,Body one.\nx2,Two,Body two.\nx1,Again,Body three.\n', { fileName: 'dupid.csv', collection: { name: 'Dup ids' } });
    const c = await commit(db, s.batchId, s.mapping);
    const i = c.summary.problems.first.find((x) => x.code === 'E_DUP_ID');
    assertActionable(i);
    assert.equal(i.message, "Row 4 repeats id 'x1' first seen on line 2.");
    assert.equal(c.summary.rows.rejected, 1);
  });

  test("on_bad_row 'abort' stops the import with zero documents and says where", async () => {
    const s = stageFile(db, csvWith(30, 'r30,Title, extra,Author (synthetic),1950,en,Body.,,n', 40), { fileName: 'abort.csv', collection: { name: 'Abort' } });
    const mapping = { ...s.mapping, options: { ...s.mapping.options, on_bad_row: 'abort' } };
    const projected = await dryRun(db, s.batchId, mapping);
    assert.equal(projected.aborted.code, 'E_ROW_RAGGED');
    assert.equal(projected.aborted.line, 30);
    const c = await commit(db, s.batchId, mapping);
    assert.equal(c.error.code, 'E_IMPORT_ABORTED');
    assert.match(c.error.message, /^Import aborted at line 30: Row 30 has 9 fields/);
    assert.ok(c.error.hint);
    assert.equal(allDocs(db, s.batchId), 0);
    assert.equal(one(db, 'SELECT status FROM import_batch WHERE id = ?', s.batchId).status, 'failed');
  });

  test('a cancelled commit leaves zero documents and the batch cancelled', async () => {
    const s = stageFile(db, csvWith(5, row8(5), 50), { fileName: 'cancel.csv', collection: { name: 'Cancel' } });
    const c = await commit(db, s.batchId, s.mapping, { cancelNow: true });
    assert.equal(c.error.name, 'CancelledError');
    assert.equal(allDocs(db, s.batchId), 0);
    assert.equal(one(db, 'SELECT status FROM import_batch WHERE id = ?', s.batchId).status, 'cancelled');
  });

  test('not a text file: ZIP, UTF-16 and binary uploads are explained at preview', () => {
    const zip = stageFile(db, Buffer.from('PK\u0003\u0004\u0014\u0000binary', 'latin1'), { fileName: 'book.xlsx' });
    assert.equal(zip.preview.fatal.code, 'E_ENCODING');
    assertActionable(zip.preview.fatal);
    assert.match(zip.preview.fatal.suggestion, /Export it as CSV/);
    const u16 = stageFile(db, Buffer.from('﻿id,title', 'utf16le'), { fileName: 'u16.csv' });
    assert.match(u16.preview.fatal.message, /UTF-16/);
  });
});
