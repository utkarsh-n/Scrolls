// OWNER: WP5 — saved views and annotations survive a restart (SPEC §11 row 8): spawn `node server.mjs` on a temp
// data dir, create a view, an annotation with 3 revisions, a reinterpretation, a proposal and its review; SIGKILL;
// restart; every object is byte-identical through the API; revisions and views refuse UPDATE/DELETE; re-save makes
// slug~2; after a new import the view reports dataChanged and its "as saved" counts equal the counts at save.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isConstraintError, openDb } from '../server/db/open.mjs';
import { checkResponse } from './helpers/shape.mjs';
import { startServerProcess } from './helpers/server.mjs';
import { loadMini, makeTmpData, miniDocuments } from './helpers/tmpdata.mjs';

const ENV = { SCROLLS_READ_WORKERS: '1' };

describe('persistence across a SIGKILL', () => {
  let tmp, srv, p2, p3, anchor, created = {}, snapshot = {};

  const call = async (method, path, body) => {
    const r = await srv.request(method, path, { body });
    const json = await checkResponse(new Response(r.status === 204 ? null : r.text, { status: r.status }), method, path);
    return { status: r.status, json, text: r.text, etag: r.headers.etag };
  };

  before(async () => {
    tmp = makeTmpData();
    const db = tmp.db;
    const body = (ext) => db.prepare("SELECT p.* FROM passage p JOIN document d ON d.id = p.document_id WHERE d.ext_id = ? AND p.field = 'body'").get(ext);
    p2 = body('mini:02');
    p3 = body('mini:03');
    const t = db.prepare('SELECT original, original_sha256 FROM document_text WHERE document_id = ?').get(p2.document_id);
    const q = 'Carry the zero, children';
    anchor = { doc_id: p2.document_id, sha256: t.original_sha256, field: 'body', start: t.original.indexOf(q), end: t.original.indexOf(q) + q.length, quote: q };
    db.close();
    srv = await startServerProcess({ dataDir: tmp.dir, env: ENV });
  });
  after(async () => {
    await srv?.cleanup();
    tmp?.cleanup();
  });

  test('create a view, an annotation with 3 revisions, a reinterpretation, a proposal and a review', async () => {
    const view = await call('POST', '/api/views', { name: 'carry the zero: persistence', state: { v: 1, corpus: 'test', tier: 'L2' }, comparisons_tried: 1 });
    assert.equal(view.status, 200);
    created.view = view.json;
    const ann = await call('POST', '/api/annotations', { target: { type: 'passage', ref: String(p2.id) }, anchor, kind: 'interpretation',
      body_md: 'A schoolroom rule.', dimensions: { pragmatic_function: 'sincere' }, tags: ['school'], author: 'Reader A' });
    assert.equal(ann.status, 200);
    created.ann = ann.json.id;
    assert.equal((await call('PATCH', `/api/annotations/${created.ann}`, { body_md: 'A schoolroom rule, repeated at work.', reason: 'reread' })).json.rev, 2);
    assert.equal((await call('PATCH', `/api/annotations/${created.ann}`, { body_md: 'A rule kept with irony.', dimensions: { pragmatic_function: 'ironic' } })).json.rev, 3);
    const re = await call('POST', `/api/annotations/${created.ann}/reinterpret`, { body_md: 'Both: sincere at school, ironic at work.', layer: 'Reader A, later' });
    created.re = re.json.id;
    const rel = await call('POST', '/api/relationships', { src: `passage:${p3.id}`, dst: `passage:${p2.id}`, rel_type: 'near_quotation',
      evidence: [{ passage: p3.id, start: 0, end: 20, relative: true }], note: 'The bulletin repeats the memo line.', author: 'Reader A' });
    created.rel = rel.json.id;
    const review = await call('POST', `/api/relationships/${created.rel}/review`, { action: 'confirm', note: 'Checked both texts word by word.', author: 'Reader B' });
    assert.equal(review.json.review_status, 'confirmed');
    const group = await call('POST', '/api/hypothesis-groups', { target: `passage:${p3.id}`, question: 'Where does the bulletin line come from?', relationships: [created.rel] });
    created.group = group.json.id;
  });

  const reads = () => ({
    view: `/api/views/${created.view.slug}`,
    views: '/api/views',
    notes: `/api/annotations?target=passage:${p2.id}&include=superseded,withdrawn`,
    revisions: `/api/annotations/${created.ann}/revisions`,
    relationship: `/api/relationships/${created.rel}`,
    group: `/api/hypothesis-groups/${created.group}`,
  });

  test('after SIGKILL and a restart every object is byte-identical through the API', async () => {
    for (const [k, path] of Object.entries(reads())) {
      const r = await call('GET', path);
      assert.equal(r.status, 200, `${k} ${r.text}`);
      snapshot[k] = r;
    }
    assert.equal(JSON.parse(snapshot.revisions.text).length, 3);
    assert.equal(await srv.kill('SIGKILL'), 'SIGKILL');
    srv = await startServerProcess({ dataDir: tmp.dir, env: ENV });
    for (const [k, path] of Object.entries(reads())) {
      const r = await call('GET', path);
      assert.equal(r.text, snapshot[k].text, `${k} is byte-identical after the restart`);
      assert.equal(r.etag, snapshot[k].etag, `${k} keeps its ETag`);
    }
    const notes = JSON.parse(snapshot.notes.text).items;
    assert.deepEqual(notes.map((a) => [a.id, a.status, a.rev]), [[created.ann, 'superseded', 3], [created.re, 'active', 1]]);
    const card = JSON.parse(snapshot.relationship.text);
    assert.equal(card.evidence_status, 'proposed');
    assert.equal(card.review_status, 'confirmed');
  });

  test('revisions and views refuse UPDATE/DELETE; re-save makes slug~2', async () => {
    const db = openDb({ path: `${tmp.dir}/scrolls.db` });
    try {
      for (const sql of ["UPDATE annotation_revision SET body_md = 'x'", 'DELETE FROM annotation_revision',
        "UPDATE relationship_revision SET reason = 'x'", 'DELETE FROM relationship_revision',
        "UPDATE saved_view SET state_json = '{}'", "UPDATE relationship SET evidence_status = 'documented'"]) {
        assert.throws(() => db.prepare(sql).run(), (err) => isConstraintError(err), sql);
      }
    } finally {
      db.close();
    }
    const again = await call('POST', '/api/views', { name: 'carry the zero: persistence', state: { v: 1, corpus: 'test', tier: 'L2' },
      parent_slug: created.view.slug });
    assert.equal(again.json.slug, `${created.view.slug}~2`);
    assert.equal(again.json.parent_slug, created.view.slug);
  });

  test('after a new import the view reports dataChanged and "as saved" counts equal the original', async () => {
    await srv.kill('SIGTERM');
    const db = openDb({ path: `${tmp.dir}/scrolls.db` });
    try {
      loadMini(db, { docs: miniDocuments().slice(0, 4).map((d) => ({ ...d, ext_id: `${d.ext_id}-later` })), slug: 'mini-later' });
    } finally {
      db.close();
    }
    srv = await startServerProcess({ dataDir: tmp.dir, env: ENV });
    const v = await call('GET', `/api/views/${created.view.slug}`);
    assert.equal(v.json.drift.dataChanged, true);
    assert.equal(v.json.drift.importsSince.length, 1);
    assert.match(v.json.drift.message, /^Corpus changed since this view was saved\. 'As saved' restricts to imports ≤ #\d+ and the pinned runs\.$/);
    assert.deepEqual(v.json.counts.asSaved, created.view.counts, '"as saved" counts equal the counts at save');
    assert.deepEqual(v.json.counts.asSaved, JSON.parse(snapshot.view.text).counts.asSaved);
    assert.equal(v.json.counts.current.documents, created.view.counts.documents + 4);
    assert.deepEqual(v.json.state, JSON.parse(snapshot.view.text).state, 'the saved state never changes');
    const asSaved = await call('GET', `/api/views/${created.view.slug}?as=1`);
    assert.equal(asSaved.json.state.asSaved, true);
  });
});
