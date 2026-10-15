// OWNER: WP1 — the chunked ("2 GB streaming") path for CSV, TSV and JSON Lines gives exactly what the
// in-memory path gives: same records, lines, offsets, byte ranges, issues and summary (SPEC §5.1, §12.4 P2).
// Tiny chunks (and a 0-byte threshold) put chunk boundaries inside fields, quotes, CRLFs and characters.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { csvRecords, csvRecordsChunked } from '../server/ingest/csv.mjs';
import { fileTextChunks, scanFileEncoding } from '../server/ingest/decode.mjs';
import { jsonlRecords, jsonlRecordsChunked } from '../server/ingest/jsonl.mjs';
import { previewQuery } from '../server/ingest/pipeline.mjs';
import { commit, dryRun, fixtureBytes, stageFile } from './fixtures/ingest/harness.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

const enc = new TextEncoder();
const pieces = (t, n) => { const out = []; for (let i = 0; i < t.length; i += n) out.push({ text: t.slice(i, i + n) }); return out; };
const STREAM = { streamAboveBytes: 0, chunkSize: 61 };
const SUMMARY_KEYS = ['rows', 'documents', 'passages', 'tokens', 'dates', 'languages', 'relationships'];

describe('chunked readers', () => {
  test('CSV records are identical for every chunk size, byte ranges included', () => {
    const text = `a,b,c\r\n1,"x, y","multi\nline ""q"""\r\n\r\n2,é,€\r3,z,end\n4,"long ${'w'.repeat(50)}",😀\n5,"open ""quote"" at the end"`;
    const whole = [...csvRecords(text)];
    for (const n of [1, 2, 3, 5, 7, 13, 64, 4096]) {
      const got = [...csvRecordsChunked(pieces(text, n))];
      assert.deepEqual(got.map((r) => [r.fields, r.line, r.start, r.end]), whole.map((r) => [r.fields, r.line, r.start, r.end]), `chunk ${n}`);
      for (const r of got) {
        assert.equal(r.byteStart, enc.encode(text.slice(0, r.start)).length);
        assert.equal(r.byteEnd, enc.encode(text.slice(0, r.end)).length);
      }
    }
    const bad = 'a,b\n1,ok\n2,"never closed\n3,x\n';
    for (const n of [1, 4, 100]) assert.deepEqual([...csvRecordsChunked(pieces(bad, n))].at(-1), [...csvRecords(bad)].at(-1));
  });

  test('JSON Lines records and issues are identical for every chunk size', () => {
    const text = '{"a":1}\n\n{"a": 2, }\n[1]\n{"a":"é😀"}\r\n{"a":3}';
    const whole = [...jsonlRecords(text)];
    for (const n of [1, 3, 8, 100]) {
      const got = [...jsonlRecordsChunked(pieces(text, n))];
      assert.deepEqual(got.map((r) => [r.line, r.start, r.end, r.data, r.issue?.message ?? null]), whole.map((r) => [r.line, r.start, r.end, r.data, r.issue?.message ?? null]), `chunk ${n}`);
      for (const r of got) assert.equal(r.byteStart, enc.encode(text.slice(0, r.start)).length);
    }
  });

  test('file decoding in chunks completes characters cut at a boundary; the encoding scan finds the bad byte', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scrolls-chunks-'));
    try {
      const f = path.join(dir, 'x.csv');
      const s = 'id,t\n1,€😀é\n2,ok\n';
      writeFileSync(f, `﻿${s}`);
      for (const n of [1, 2, 3, 5]) assert.equal([...fileTextChunks(f, { decoder: 'utf-8', bomBytes: 3, chunkSize: n })].map((c) => c.text).join(''), s);
      assert.equal(scanFileEncoding(f, { chunkSize: 2 }).decoder, 'utf-8');
      const g = path.join(dir, 'y.csv');
      writeFileSync(g, Buffer.concat([Buffer.from('id,t\n1,ok\n2,caf'), Buffer.from([0xe9]), Buffer.from('\n')]));
      for (const n of [1, 3, 64]) {
        const e = scanFileEncoding(g, { chunkSize: n });
        assert.equal(e.decoder, 'windows-1252');
        assert.equal(e.issues[0].line, 3);
        assert.match(e.issues[0].message, /0xE9 at byte 15/);
      }
      assert.equal(scanFileEncoding(g, { encoding: 'utf-8', chunkSize: 4 }).fatal.code, 'E_ENCODING');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the streaming pipeline equals the in-memory one', () => {
  let t, db;
  before(() => { t = makeTmpData({ seed: false }); db = t.db; });
  after(() => t.cleanup());

  for (const [file, edit] of [['letters.csv', null], ['semicolon.csv', null], ['gujarati.tsv', null],
    ['records.jsonl', (m) => ({ ...m, fields: { ...m.fields, text: { from: 'pages', transform: [{ join: '\f' }] } } })]]) {
    test(`${file}: dry run and commit, chunked vs whole`, async () => {
      const a = stageFile(db, fixtureBytes(file), { fileName: file, collection: { name: `${file} whole` } });
      const b = stageFile(db, fixtureBytes(file), { fileName: file, collection: { name: `${file} chunked` } });
      // the two copies share their texts: duplicate checks (global across collections) are off for both
      const off = (m) => ({ ...m, options: { ...m.options, dedupe: 'off' } });
      const ma = off(edit ? edit(a.mapping) : a.mapping);
      const mb = off({ ...(edit ? edit(b.mapping) : b.mapping), collection: b.mapping.collection });
      const pa = await dryRun(db, a.batchId, ma);
      const pb = await dryRun(db, b.batchId, mb, STREAM);
      for (const k of SUMMARY_KEYS) assert.deepEqual(pb[k], pa[k], `dry run ${k}`);
      assert.deepEqual(pb.problems.by_code, pa.problems.by_code);
      assert.deepEqual(pb.problems.first.map((i) => [i.code, i.line, i.message]), pa.problems.first.map((i) => [i.code, i.line, i.message]));
      const ca = await commit(db, a.batchId, ma);
      const cb = await commit(db, b.batchId, mb, STREAM);
      assert.equal(cb.error, null, cb.error?.message);
      for (const k of SUMMARY_KEYS) assert.deepEqual(cb.summary[k], ca.summary[k], `commit ${k}`);
      // the same records point at the same bytes of the stored file
      const ranges = (batch) => db.prepare('SELECT ext_id, source_byte_start, source_byte_end FROM document WHERE import_batch_id = ? ORDER BY ext_id').all(batch);
      assert.deepEqual(ranges(b.batchId), ranges(a.batchId));
      const bytes = fixtureBytes(file);
      for (const r of ranges(b.batchId)) {
        const rec = bytes.subarray(r.source_byte_start, r.source_byte_end).toString('utf8');
        assert.ok(rec.includes(r.ext_id), `${r.ext_id} is inside its byte range`);
      }
    });
  }

  test('a Windows-1252 file streams with the fallback warning and the same text', async () => {
    const bytes = Buffer.concat([Buffer.from('id,title,body\nw1,Caf'), Buffer.from([0xe9]), Buffer.from(',Le caf'), Buffer.from([0xe9]), Buffer.from(' du coin.\nw2,Two,Second body.\n')]);
    const s = stageFile(db, bytes, { fileName: 'cp1252.csv', collection: { name: 'cp1252 stream' } });
    const c = await commit(db, s.batchId, { ...s.mapping, encoding: 'auto' }, STREAM);
    assert.equal(c.error, null);
    assert.equal(c.summary.problems.by_code.W_ENCODING_FALLBACK, 1);
    assert.equal(db.prepare("SELECT title FROM document WHERE ext_id = 'w1' AND import_batch_id = ?").get(s.batchId).title, 'Café');
  });

  test('an unclosed quote found mid-stream still leaves zero documents', async () => {
    const lines = ['id,title,body'];
    for (let i = 2; i <= 60; i++) lines.push(i === 50 ? 'q50,"Unclosed,body' : `q${i},T${i},Body ${i}.`);
    const s = stageFile(db, `${lines.join('\n')}\n`, { fileName: 'quote-stream.csv', collection: { name: 'quote stream' } });
    const c = await commit(db, s.batchId, s.mapping, STREAM);
    assert.equal(c.error.code, 'E_CSV_QUOTE');
    assert.equal(c.error.message, 'An unclosed quote starts on line 50, column 5 and runs to the end of the file.');
    assert.equal(db.prepare('SELECT count(*) AS n FROM document WHERE import_batch_id = ?').get(s.batchId).n, 0);
  });

  test('the preview of a large file reads its first part and says so; large JSON and TXT are refused with advice', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scrolls-large-'));
    try {
      const csv = path.join(dir, 'big.csv');
      writeFileSync(csv, fixtureBytes('letters.csv'));
      const p = previewQuery(null, { path: csv, fileName: 'big.csv', streamAboveBytes: 100 }).preview;
      assert.equal(p.format, 'csv');
      assert.ok(p.partial.bytes_read <= p.partial.bytes_total);
      assert.ok(p.issues.some((i) => /read all of it, in chunks/.test(i.message)));
      assert.equal(p.fatal ?? null, null);
      const json = path.join(dir, 'big.json');
      writeFileSync(json, fixtureBytes('records.json'));
      const pj = previewQuery(null, { path: json, fileName: 'big.json', streamAboveBytes: 100 }).preview;
      assert.equal(pj.fatal, null, 'under 400 MB JSON is still read whole');
      const txt = path.join(dir, 'big.txt');
      writeFileSync(txt, `Title: Big\n\n${'word '.repeat(4.3 * 1024 * 1024)}`);
      const pt = previewQuery(null, { path: txt, fileName: 'big.txt', streamAboveBytes: 100 }).preview;
      assert.equal(pt.fatal.code, 'E_ROW_TOO_LARGE');
      assert.match(pt.fatal.message, /a document holds at most 20 MB/);
      assert.match(pt.fatal.suggestion, /Split it into one file per chapter/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
