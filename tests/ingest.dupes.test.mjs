// OWNER: WP1 — duplicates: file, id, content, near-content, metadata; dry run and commit agree (SPEC §5.4)

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { makeTaskContext } from '../server/jobs/context.mjs';
import { findDuplicates } from '../server/ingest/dedupe.mjs';
import { revertImport } from '../server/ingest/pipeline.mjs';
import { allDocs, commit, dryRun, liveDocs, stageFile } from './fixtures/ingest/harness.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

const one = (db, sql, ...a) => db.prepare(sql).get(...a);
const LONG = 'the clerk kept the ledger open all night and counted every column twice so that the auditors would find each sum exactly where the old primer said it should be';

describe('duplicates', () => {
  let t, db;
  before(() => { t = makeTmpData({ seed: false }); db = t.db; });
  after(() => t.cleanup());

  test('same file into the same collection → E_DUP_FILE, whole import refused; another collection is fine', async () => {
    const csv = 'id,title,body\nf1,One,The first body of the file.\nf2,Two,The second body of the file.\n';
    const a = stageFile(db, csv, { fileName: 'same.csv', collection: { name: 'Same file' } });
    assert.equal((await commit(db, a.batchId, a.mapping)).error, null);
    const b = stageFile(db, csv, { fileName: 'same-again.csv', collection: { name: 'Same file' } });
    assert.equal(b.sha256, a.sha256);
    const projected = await dryRun(db, b.batchId, b.mapping);
    assert.equal(projected.fatal.code, 'E_DUP_FILE');
    assert.match(projected.fatal.message, new RegExp(`^Already imported on \\d{4}-\\d{2}-\\d{2} as batch ${a.batchId}\\.$`));
    assert.ok(projected.fatal.suggestion);
    const c = await commit(db, b.batchId, b.mapping);
    assert.equal(c.error.code, 'E_DUP_FILE');
    assert.equal(allDocs(db, b.batchId), 0);
    const other = { ...b.mapping, collection: { ...b.mapping.collection, slug: 'same-file-copy', name: 'Copy' } };
    assert.equal((await commit(db, b.batchId, other)).error, null);
    assert.equal(liveDocs(db, b.batchId), 2);
  });

  test('an id that exists in the collection from an earlier import → E_DUP_ID naming the batch', async () => {
    const a = stageFile(db, 'id,title,body\nk1,One,Body one of batch A.\n', { fileName: 'a.csv', collection: { name: 'Ids' } });
    await commit(db, a.batchId, a.mapping);
    const b = stageFile(db, 'id,title,body\nk1,One again,Different body.\nk2,Two,Body two.\n', { fileName: 'b.csv', collection: { name: 'Ids' } });
    const projected = await dryRun(db, b.batchId, b.mapping);
    const c = await commit(db, b.batchId, b.mapping);
    for (const s of [projected, c.summary]) {
      assert.deepEqual(s.rows, { seen: 2, accepted: 1, accepted_with_warnings: 0, rejected: 1 });
      const i = s.problems.first.find((x) => x.code === 'E_DUP_ID');
      assert.equal(i.message, `Row 2 id 'k1' already exists in collection 'ids' (import batch ${a.batchId}).`);
    }
  });

  test('same text twice → W_DUP_CONTENT and dup_of; dedupe skip rejects, off ignores', async () => {
    const csv = `id,title,body\nd1,One,"${LONG}"\nd2,Two,"${LONG.toUpperCase()}"\nd3,Three,A different and short body.\n`;
    const s = stageFile(db, csv, { fileName: 'dups.csv', collection: { name: 'Dup text' } });
    const projected = await dryRun(db, s.batchId, s.mapping);
    assert.equal(projected.documents.duplicates_flagged, 1);
    assert.equal(projected.problems.by_code.W_DUP_CONTENT, 1);
    const skip = await dryRun(db, s.batchId, { ...s.mapping, options: { ...s.mapping.options, dedupe: 'skip' } });
    assert.deepEqual(skip.rows, { seen: 3, accepted: 2, accepted_with_warnings: 0, rejected: 1 });
    const off = await dryRun(db, s.batchId, { ...s.mapping, options: { ...s.mapping.options, dedupe: 'off' } });
    assert.equal(off.problems.by_code.W_DUP_CONTENT, undefined);
    const c = await commit(db, s.batchId, s.mapping);
    assert.equal(c.summary.documents.duplicates_flagged, 1);
    assert.deepEqual(c.summary.rows, projected.rows);
    const d1 = one(db, "SELECT id FROM document WHERE ext_id = 'd1' AND import_batch_id = ?", s.batchId).id;
    assert.equal(one(db, "SELECT dup_of FROM document WHERE ext_id = 'd2' AND import_batch_id = ?", s.batchId).dup_of, d1);
    // a later import with the same text points at the stored document
    const later = stageFile(db, `id,title,body\ne1,Echo,"${LONG}"\n`, { fileName: 'echo.csv', collection: { name: 'Echo' } });
    const p2 = await dryRun(db, later.batchId, later.mapping);
    assert.equal(p2.problems.first.find((x) => x.code === 'W_DUP_CONTENT').message, `Same text as document ${d1}; excluded from counts by default.`);
  });

  test('near-duplicate text (MinHash ≥ 0.9) → W_NEAR_DUP in the dry run and at commit', async () => {
    const words = `${LONG} ${LONG.split(' ').reverse().join(' ')} ${LONG} while the rain kept falling on the roof of the counting house`.split(' ');
    assert.ok(words.length >= 100);
    const text = words.join(' ');
    const variant = [...words.slice(0, -1), 'office'].join(' ');
    const csv = `id,title,body\nn1,One,"${text}"\nn2,Two,"${variant}"\nn3,Three,"A short and unrelated body."\n`;
    const s = stageFile(db, csv, { fileName: 'near.csv', collection: { name: 'Near' } });
    const projected = await dryRun(db, s.batchId, s.mapping);
    const c = await commit(db, s.batchId, s.mapping);
    assert.equal(projected.documents.near_duplicates, 1);
    assert.equal(c.summary.documents.near_duplicates, 1);
    assert.equal(c.summary.problems.by_code.W_NEAR_DUP, 1);
    assert.equal(projected.rows.accepted_with_warnings, c.summary.rows.accepted_with_warnings);
  });

  test('metadata-only records with the same title, author and year → W_DUP_METADATA', async () => {
    const csv = 'id,title,author,year\nm1,Zero Hour,Ana (synthetic),1990\nm2,zero hour,ana (synthetic),1990\nm3,Zero Hour,Ana (synthetic),1991\n';
    const s = stageFile(db, csv, { fileName: 'meta.csv', collection: { name: 'Meta', unit: 'works' } });
    const projected = await dryRun(db, s.batchId, s.mapping);
    const c = await commit(db, s.batchId, s.mapping);
    for (const r of [projected, c.summary]) {
      assert.equal(r.problems.by_code.W_DUP_METADATA, 1);
      assert.equal(r.documents.metadata_only, 3);
    }
  });

  test('revert soft-deletes a batch; its ids stay taken and re-importing them says so', async () => {
    const s = stageFile(db, 'id,title,body\nv1,One,Body one to revert.\nv2,Two,Body two to revert.\n', { fileName: 'rev.csv', collection: { name: 'Revert me' } });
    await commit(db, s.batchId, s.mapping);
    const before = Number(one(db, "SELECT value FROM meta WHERE key = 'data_version'").value);
    const ctx = makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
    const r = await revertImport(ctx, { batchId: s.batchId });
    assert.equal(r.documents, 2);
    assert.equal(r.data_version, before + 1);
    assert.equal(liveDocs(db, s.batchId), 0);
    assert.equal(allDocs(db, s.batchId), 2, 'soft delete only');
    assert.equal(one(db, 'SELECT status FROM import_batch WHERE id = ?', s.batchId).status, 'reverted');
    await assert.rejects(() => revertImport(ctx, { batchId: s.batchId }), /only a committed import can be reverted/);
    const again = stageFile(db, 'id,title,body\nv1,One,"Body one, imported again."\n', { fileName: 'rev2.csv', collection: { name: 'Revert me' } });
    const p = await dryRun(db, again.batchId, again.mapping);
    assert.match(p.problems.first.find((x) => x.code === 'E_DUP_ID').message, /since reverted/);
  });

  test('M1 gate: reverting the original of a duplicate makes the earliest live copy the original', async () => {
    const body = 'A body of text that two later imports repeat word for word for the revert check.';
    const a = stageFile(db, `id,title,body\no1,Orig,${body}\n`, { fileName: 'orig.csv', collection: { name: 'Dup revert A' } });
    await commit(db, a.batchId, a.mapping);
    const b = stageFile(db, `id,title,body\nc1,Copy one,${body}\n`, { fileName: 'copy1.csv', collection: { name: 'Dup revert B' } });
    await commit(db, b.batchId, b.mapping);
    const c = stageFile(db, `id,title,body\nc2,Copy two,${body}\n`, { fileName: 'copy2.csv', collection: { name: 'Dup revert C' } });
    await commit(db, c.batchId, c.mapping);
    const idOf = (batch) => one(db, 'SELECT id FROM document WHERE import_batch_id = ?', batch).id;
    const [ida, idb, idc] = [idOf(a.batchId), idOf(b.batchId), idOf(c.batchId)];
    assert.equal(one(db, 'SELECT dup_of FROM document WHERE id = ?', idb).dup_of, ida);
    assert.equal(one(db, 'SELECT dup_of FROM document WHERE id = ?', idc).dup_of, ida);
    const ctx = makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });
    await revertImport(ctx, { batchId: a.batchId });
    assert.equal(one(db, 'SELECT dup_of FROM document WHERE id = ?', idb).dup_of, null, 'the earliest live copy is now the original');
    assert.equal(one(db, 'SELECT dup_of FROM document WHERE id = ?', idc).dup_of, idb, 'the other copy points to it');
  });

  test('findDuplicates reports repeated ids and texts in a sample', () => {
    const d = findDuplicates([{ line: 2, extId: 'a', text: LONG }, { line: 3, extId: 'b', text: ` ${LONG}  ` }, { line: 4, extId: 'a', text: 'x' }]);
    assert.deepEqual(d.map((x) => [x.kind, x.line, x.first_line]), [['text', 3, 2], ['id', 4, 2]]);
    assert.deepEqual(findDuplicates([{ line: 1, extId: 'a' }, { line: 2, extId: 'a' }], { mode: 'off' }), []);
  });
});
