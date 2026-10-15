// OWNER: WP1 — the import API over HTTP on a real server: shapes as the contract fixtures, the job, problems.csv,
// errors (SPEC §5.2, §7; tests/contract/*imports*.json)

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { streamToFile } from '../server/ingest/pipeline.mjs';
import { fixtureBytes } from './fixtures/ingest/harness.mjs';
import { startServerInProcess } from './helpers/server.mjs';
import { assertShape } from './helpers/shape.mjs';

const RAW = { 'Content-Type': 'application/octet-stream' };
const coll = (c) => encodeURIComponent(JSON.stringify(c));

async function waitJob(s, id, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const j = await s.request('GET', `/api/jobs/${id}`);
    assertShape('Job', j.json);
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.json.status)) return j.json;
    if (Date.now() > until) throw new Error(`job ${id} still ${j.json.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('import API', () => {
  let s;
  before(async () => { s = await startServerInProcess(); });
  after(async () => { await s.cleanup(); });

  test('upload → preview → dry run → commit job → summary → problems.csv → revert', async () => {
    const up = await s.request('POST', '/api/imports', { body: fixtureBytes('letters.csv'),
      headers: { ...RAW, 'X-Scrolls-Filename': encodeURIComponent('letters.csv'), 'X-Scrolls-Collection': coll({ name: 'Letters (test)', unit: 'tokens', license: 'test' }) } });
    assert.equal(up.status, 200, up.text);
    assertShape('ImportCreated', up.json);
    const id = up.json.import_batch_id;
    const { preview } = up.json;
    assert.equal(preview.format, 'csv');
    assert.equal(preview.sample_rows.length, 20);
    assert.equal(preview.suggested_mapping.collection.slug, 'letters-test');

    const got = await s.request('GET', `/api/imports/${id}/preview`);
    assert.equal(got.status, 200);
    assertShape('ImportPreview', got.json);
    assert.deepEqual(got.json.columns, preview.columns);
    const semi = await s.request('GET', `/api/imports/${id}/preview?delimiter=semicolon`);
    assertShape('ImportPreview', semi.json);
    assert.equal(semi.json.delimiter, ';');
    assert.equal(semi.json.columns.length, 1);
    await s.request('GET', `/api/imports/${id}/preview?delimiter=comma`);

    const v = await s.request('PUT', `/api/imports/${id}/mapping`, { body: { mapping: preview.suggested_mapping } });
    assert.equal(v.status, 200, v.text);
    assertShape('ImportValidation', v.json);
    assert.equal(v.json.validation.projected, true);
    assert.deepEqual(v.json.validation.rows, { seen: 38, accepted: 37, accepted_with_warnings: 2, rejected: 1 });
    const dry = await s.request('GET', `/api/imports/${id}/problems.csv`);
    assert.equal(dry.status, 200);
    assert.match(dry.headers['content-type'], /^text\/csv/);
    assert.equal(dry.text.split('\n')[0], 'code,severity,line,col,field,value_excerpt,message,suggestion');
    assert.match(dry.text, /E_ROW_RAGGED,rejected,40,/);

    const c = await s.request('POST', `/api/imports/${id}/commit`, { body: { mapping: preview.suggested_mapping } });
    assert.equal(c.status, 200, c.text);
    assertShape('JobRef', c.json);
    const job = await waitJob(s, c.json.job.id);
    assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
    assert.equal(job.type, 'import');
    assertShape('ImportSummary', job.result);
    assert.equal(job.result.projected, false);
    assert.deepEqual(job.result.rows, v.json.validation.rows);
    assert.equal(job.result.documents.created, 37);
    assert.ok(Number.isInteger(job.result.data_version) && Number.isInteger(job.result.run_id));

    const again = await s.request('POST', `/api/imports/${id}/commit`, { body: { mapping: preview.suggested_mapping } });
    assert.equal(again.status, 409);
    assertShape('ErrorBody', again.json);
    assert.equal(again.json.error.code, 'E_IMPORT_STATE');
    assert.match(again.json.error.message, new RegExp(`^Batch ${id} was already committed \\(job ${c.json.job.id}\\)\\.$`));

    const probs = await s.request('GET', `/api/imports/${id}/problems.csv`);
    const lines = probs.text.trim().split('\n');
    assert.equal(lines.length, 1 + job.result.problems.total);
    assert.match(probs.headers['content-disposition'], /import-\d+-problems\.csv/);

    // mapping reuse: another file with the same columns is offered this batch's mapping
    const other = fixtureBytes('letters.csv').toString('utf8').replace('L01,Letter 1,', 'X01,Letter 1 (copy),');
    const up2 = await s.request('POST', '/api/imports', { body: other, headers: { ...RAW, 'X-Scrolls-Filename': 'letters-2.csv' } });
    assert.equal(up2.status, 200, up2.text);
    const reuse = up2.json.preview.previous_mappings;
    assert.equal(reuse[0].batch, id);
    assert.equal(reuse[0].file_name, 'letters.csv');
    assert.equal(reuse[0].collection, 'letters-test');
    assert.deepEqual(Object.keys(reuse[0].mapping.fields).sort(), Object.keys(preview.suggested_mapping.fields).sort());

    // the same file into the same collection is refused at upload
    const dup = await s.request('POST', '/api/imports', { body: fixtureBytes('letters.csv'),
      headers: { ...RAW, 'X-Scrolls-Filename': 'letters.csv', 'X-Scrolls-Collection': coll({ name: 'Letters (test)' }) } });
    assert.equal(dup.status, 409);
    assertShape('ErrorBody', dup.json);
    assert.equal(dup.json.error.code, 'E_DUP_FILE');
    assert.deepEqual(dup.json.error.detail, { batch: id });

    const rv = await s.request('POST', `/api/imports/${id}/revert`);
    assertShape('JobRef', rv.json);
    const rjob = await waitJob(s, rv.json.job.id);
    assert.equal(rjob.status, 'succeeded');
    assert.equal(rjob.result.documents, 37);
    const rv2 = await s.request('POST', `/api/imports/${id}/revert`);
    assert.equal(rv2.status, 409);
  });

  test('errors: 404, invalid mapping 400, 413 by Content-Length, bad collection header; a JSON-typed upload is a file', async () => {
    const nf = await s.request('GET', '/api/imports/99999/preview');
    assert.equal(nf.status, 404);
    assertShape('ErrorBody', nf.json);
    assert.equal((await s.request('GET', '/api/imports/99999/problems.csv')).status, 404);

    const up = await s.request('POST', '/api/imports', { body: 'id,title,issued\na,One,1990\n', headers: { ...RAW, 'X-Scrolls-Filename': 'tiny.csv' } });
    assert.equal(up.status, 200);
    const id = up.json.import_batch_id;
    const bad = await s.request('PUT', `/api/imports/${id}/mapping`, { body: { mapping: { ...up.json.preview.suggested_mapping, fields: { title: { from: 'title' }, date: { from: 'issued_on' } } } } });
    assert.equal(bad.status, 400);
    assertShape('ErrorBody', bad.json);
    assert.equal(bad.json.error.code, 'E_MAPPING_INVALID');
    assert.equal(bad.json.error.message, "Target 'date' maps to column 'issued_on', which the file does not have.");
    assert.equal(bad.json.error.hint, 'Pick a column from the preview.');
    assert.deepEqual([bad.json.error.detail.target, bad.json.error.detail.from], ['date', 'issued_on']);

    // over the limit while streaming: 413 E_FILE_TOO_LARGE and no partial file left behind
    const dir = mkdtempSync(path.join(tmpdir(), 'scrolls-up-'));
    const part = path.join(dir, 'x.part');
    const err = await streamToFile(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), part, 1000).catch((e) => e);
    assert.equal(err.status, 413);
    assert.equal(err.code, 'E_FILE_TOO_LARGE');
    assert.equal(existsSync(part), false);
    rmSync(dir, { recursive: true, force: true });

    const hdr = await s.request('POST', '/api/imports', { body: 'a', headers: { ...RAW, 'X-Scrolls-Collection': 'not%20json' } });
    assert.equal(hdr.status, 400);
    assert.equal(hdr.json.error.code, 'E_BAD_COLLECTION');

    const demo = await s.request('POST', '/api/imports', { body: 'a', headers: { ...RAW, 'X-Scrolls-Collection': coll({ slug: 'mini-x' }) } });
    assert.equal(demo.status, 200, 'a new user collection is fine');

    // M1 gate: a .json file sent as application/json is read as file bytes (the route is rawBody), not parsed
    const json = await s.request('POST', '/api/imports', { body: [{ id: 'j1', title: 'One', text: 'A line of text.' }], headers: { 'X-Scrolls-Filename': 'x.json' } });
    assert.equal(json.status, 200);
    assert.equal(json.json.preview.format, 'json');

    const empty = await s.request('POST', '/api/imports', { body: '', headers: { ...RAW, 'X-Scrolls-Filename': 'empty.txt' } });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error.code, 'E_EMPTY_FILE');
  });

  test('a failed commit is a failed job with the error code, message and hint', async () => {
    const lines = ['id,title,body'];
    for (let i = 2; i <= 30; i++) lines.push(i === 20 ? 'q20,"Unclosed,body text' : `q${i},T${i},Body ${i}.`);
    const up = await s.request('POST', '/api/imports', { body: `${lines.join('\n')}\n`, headers: { ...RAW, 'X-Scrolls-Filename': 'quote.csv' } });
    assert.equal(up.json.preview.fatal.code, 'E_CSV_QUOTE');
    const c = await s.request('POST', `/api/imports/${up.json.import_batch_id}/commit`, { body: { mapping: up.json.preview.suggested_mapping } });
    const job = await waitJob(s, c.json.job.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'E_CSV_QUOTE');
    assert.equal(job.error.message, 'An unclosed quote starts on line 20, column 5 and runs to the end of the file.');
    assert.ok(job.error.hint);
    const probs = await s.request('GET', `/api/imports/${up.json.import_batch_id}/problems.csv`);
    assert.match(probs.text, /E_CSV_QUOTE,fatal,20,5,/);
  });
});
