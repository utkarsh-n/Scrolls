// OWNER: WP4 — vector spaces (SPEC §4.8, §4.9 (c), §11 row 7): Householder QR and Jacobi SVD, PPMI, sharded
// co-occurrence counting against an in-memory reference, randomized SVD against an exact SVD, Procrustes
// recovering a known rotation, occurrence vectors, space files, and the vectors job end to end on a
// synthetic token-stream corpus (pooled + era slices + alignment, reuse, nearest neighbours).

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { mulberry32 } from '../src/shared/ids.mjs';
import { chooseVocab, cooccurrence, cooccurrencePpmi, passageRanges, spaceDocuments, unigramCounts } from '../server/analysis/cooc.mjs';
import { eraNote, eraSlices, nearest } from '../server/analysis/drift.mjs';
import { gaussianMatrix, householderQr, jacobiSvd, matmul, matmulTN, transpose } from '../server/analysis/linalg.mjs';
import { commitSpaceFiles, listSpaces, loadSpace, occurrenceVectors, pooledSpaceFor, writeSpaceFiles } from '../server/analysis/occvec.mjs';
import { csrToDense, ppmi, ppmiCell } from '../server/analysis/ppmi.mjs';
import { alignSpaces, chooseAnchors, displacement, procrustes } from '../server/analysis/procrustes.mjs';
import { randomizedSvd, wordVectors } from '../server/analysis/rsvd.mjs';
import { openTokenStream } from '../server/analysis/tokstream.mjs';
import { paths } from '../server/config.mjs';
import { buildSpaceCorpus, PLANTED, TOPICS } from './analysis.vectors.fixture.test.mjs';
import { startServerInProcess } from './helpers/server.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'silent';

const maxAbs = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

describe('dense linear algebra (linalg.mjs)', () => {
  test('Householder QR: A = QR, QᵀQ = I, R upper triangular with a non-negative diagonal', () => {
    const m = 120, n = 17;
    const a = gaussianMatrix(m, n, 3);
    const { q, r } = householderQr(a, m, n);
    assert.ok(maxAbs(matmul(q, r, m, n, n), a) < 1e-12);
    const qtq = matmulTN(q, q, m, n, n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) assert.ok(Math.abs(qtq[i * n + j] - (i === j ? 1 : 0)) < 1e-12);
    for (let i = 0; i < n; i++) {
      assert.ok(r[i * n + i] >= 0);
      for (let j = 0; j < i; j++) assert.equal(r[i * n + j], 0);
    }
    assert.throws(() => householderQr(a, 5, 10), RangeError);
  });

  test('one-sided Jacobi SVD reconstructs tall and wide matrices with sorted singular values', () => {
    for (const [m, n] of [[40, 12], [7, 15]]) {
      const a = gaussianMatrix(m, n, m * n);
      const { u, s, v } = jacobiSvd(a, m, n);
      const p = Math.min(m, n);
      const us = new Float64Array(m * p);
      for (let i = 0; i < m; i++) for (let j = 0; j < p; j++) us[i * p + j] = u[i * p + j] * s[j];
      assert.ok(maxAbs(matmul(us, transpose(v, n, p), m, p, n), a) < 1e-12, `${m}×${n}`);
      for (let j = 1; j < p; j++) assert.ok(s[j - 1] >= s[j]);
    }
  });
});

describe('PPMI and co-occurrence counting (ppmi.mjs, cooc.mjs)', () => {
  test('PPMI with context smoothing α = 0.75 matches the formula on a hand table; non-positive cells are dropped', () => {
    const cooc = { rows: 2, cols: 3, entries: [[0, 0, 10], [0, 1, 2], [1, 1, 8], [1, 2, 4]] };
    const csr = ppmi(cooc);
    const rows = [12, 12], cols = [10, 10, 4];
    const sa = cols.reduce((s, c) => s + c ** 0.75, 0);
    const expect = (n, t, c) => Math.max(0, Math.log((n * sa) / (rows[t] * cols[c] ** 0.75)));
    const dense = csrToDense(csr);
    for (const [t, c, n] of cooc.entries) assert.ok(Math.abs(dense[t * 3 + c] - expect(n, t, c)) < 1e-6);
    assert.equal(csr.nnz, cooc.entries.filter(([t, c, n]) => expect(n, t, c) > 0).length);
    assert.equal(ppmiCell(0, 10, 1, 1), 0);
  });

  test('sharded counting (in this thread and in 3 workers) equals the in-memory reference; windows never cross passages', async () => {
    const rng = mulberry32(11);
    const V = 300, N = 60000;
    const ids = new Uint32Array(N);
    for (let i = 0; i < N; i++) ids[i] = Math.floor(rng() ** 2 * V);
    const ranges = [];
    for (let p = 0; p < N;) { const len = 3 + Math.floor(rng() * 40); ranges.push(p, Math.min(N, p + len)); p += len; }
    const R = Uint32Array.from(ranges);
    const uni = unigramCounts(ids, R, V);
    assert.equal(uni.tokens, N);
    const voc = chooseVocab(uni.counts, { minTargetFreq: 20, maxTargets: 200, contexts: 120 });
    assert.ok(voc.targets.length <= 200 && voc.contexts.length === 120);
    assert.ok([...voc.targets].every((id) => uni.counts[id] >= 20));
    const ref = cooccurrence({ ids, ranges: R }, { window: 4, targets: voc.targets, contexts: voc.contexts });
    const dense = csrToDense(ppmi(ref));
    for (const threads of [0, 3]) {
      const out = await cooccurrencePpmi({ ids, ranges: R, targetIndex: voc.targetIndex, contextIndex: voc.contextIndex,
        nTargets: voc.targets.length, nContexts: voc.contexts.length }, { threads });
      assert.equal(out.pairs, ref.entries.length, `distinct pairs (threads ${threads})`);
      assert.equal(out.total, ref.entries.reduce((s, e) => s + e[2], 0));
      assert.ok(maxAbs(csrToDense(out.csr), dense) < 1e-6, `PPMI cells (threads ${threads})`);
    }
    // two one-token passages side by side never pair
    const two = cooccurrence({ ids: Uint32Array.from([1, 2]), ranges: Uint32Array.from([0, 1, 1, 2]) }, { targets: [1, 2], contexts: [1, 2] });
    assert.deepEqual(two.entries, []);
  });

  test('a cancelled count rejects with the abort reason and leaves no worker behind', async () => {
    const ids = new Uint32Array(3_000_000).map((_, i) => i % 500);
    const voc = chooseVocab(unigramCounts(ids, Uint32Array.from([0, ids.length]), 500).counts);
    const ac = new AbortController();
    const p = cooccurrencePpmi({ ids, ranges: Uint32Array.from([0, ids.length]), targetIndex: voc.targetIndex, contextIndex: voc.contextIndex,
      nTargets: voc.targets.length, nContexts: voc.contexts.length }, { threads: 2, signal: ac.signal });
    setTimeout(() => ac.abort(Object.assign(new Error('stop'), { name: 'CancelledError' })), 20);
    await assert.rejects(p, (err) => err.name === 'CancelledError');
  });
});

describe('randomized SVD (rsvd.mjs)', () => {
  // a 400 × 150 sparse matrix of rank 12 with a decaying spectrum plus small noise
  const m = 400, n = 150, rank = 12;
  const rng = mulberry32(5);
  const L = gaussianMatrix(m, rank, 1), Rm = gaussianMatrix(rank, n, 2);
  for (let k = 0; k < rank; k++) for (let j = 0; j < n; j++) Rm[k * n + j] *= 10 / (k + 1);
  const dense = matmul(L, Rm, m, rank, n);
  const entries = [];
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
    const v = dense[i * n + j] + (rng() - 0.5) * 0.01;
    if (Math.abs(v) > 0.05) entries.push([i, j, v]);
  }
  const rowPtr = new Uint32Array(m + 1);
  for (const [i] of entries) rowPtr[i + 1]++;
  for (let i = 0; i < m; i++) rowPtr[i + 1] += rowPtr[i];
  const csr = { rows: m, cols: n, nnz: entries.length, rowPtr, colIdx: Uint16Array.from(entries, (e) => e[1]), vals: Float32Array.from(entries, (e) => e[2]) };
  const exact = jacobiSvd(csrToDense(csr), m, n);

  test('the top singular values and vectors match an exact SVD; workers agree with this thread to rounding, and repeat exactly', async () => {
    const r0 = await randomizedSvd(csr, { d: 10, oversample: 8, powerIters: 2, seed: 42, threads: 0 });
    for (let j = 0; j < 10; j++) assert.ok(Math.abs(r0.s[j] - exact.s[j]) / exact.s[j] < 1e-3, `σ${j}`);
    for (let j = 0; j < 5; j++) {
      let dot = 0;
      for (let i = 0; i < m; i++) dot += r0.u[i * 10 + j] * exact.u[i * n + j];
      assert.ok(Math.abs(dot) > 0.999, `u${j} · exact = ${dot}`);
    }
    const big = { ...csr };
    const r2 = await randomizedSvd(big, { d: 10, oversample: 8, powerIters: 2, seed: 42, threads: 2, minParallelNnz: 0 });
    for (let j = 0; j < 10; j++) assert.ok(Math.abs(r2.s[j] - r0.s[j]) / r0.s[j] < 1e-12, 'partial sums differ only in rounding');
    const r3 = await randomizedSvd(big, { d: 10, oversample: 8, powerIters: 2, seed: 42, threads: 2, minParallelNnz: 0 });
    assert.deepEqual(Array.from(r3.s), Array.from(r2.s), 'the same thread count repeats bit for bit');
    const w = wordVectors(r0);
    for (let i = 0; i < 5; i++) {
      let s = 0;
      for (let j = 0; j < 10; j++) s += w[i * 10 + j] ** 2;
      assert.ok(Math.abs(Math.sqrt(s) - 1) < 1e-5, 'rows are L2-normalized');
    }
  });
});

describe('orthogonal Procrustes (procrustes.mjs)', () => {
  test('recovers a known rotation: residual < 1e-4, aligned cosine > 0.999', () => {
    const dim = 16, k = 300;
    const { q: rot } = householderQr(gaussianMatrix(dim, dim, 9), dim, dim);
    const a = gaussianMatrix(k, dim, 10);
    // b_i = Rᵀ a_i, so R·b_i = a_i
    const b = matmul(a, rot, k, dim, dim);
    const r = procrustes(a, b, dim);
    assert.ok(maxAbs(r, rot) < 1e-4, `residual ${maxAbs(r, rot)}`);
    const sa = { W: Float32Array.from(a), dim }, sb = { W: Float32Array.from(b), dim };
    for (let i = 0; i < 20; i++) assert.ok(1 - displacement(sa, i, sb, i, r) > 0.999);
  });

  test('anchors are shared words with f ≥ 100 in both spaces, most frequent first, capped; excluded words never anchor', () => {
    const space = (words, counts) => ({ vocab: words, counts, index: new Map(words.map((w, i) => [w, i])) });
    const sa = space(['a', 'b', 'c', 'd', 'x'], [500, 300, 120, 99, 1000]);
    const sb = space(['d', 'c', 'b', 'a'], [400, 100, 200, 150]);
    const an = chooseAnchors(sa, sb, { cap: 2, exclude: new Set(['x']) });
    assert.deepEqual(an.words, ['b', 'a']);
    assert.equal(an.available, 3, 'a, b and c qualify; d has 99 in A');
  });

  test('a shifted word is displaced; unchanged words are not (rotation plus noise)', () => {
    const dim = 12, n = 400;
    const a = gaussianMatrix(n, dim, 21);
    const { q: rot } = householderQr(gaussianMatrix(dim, dim, 22), dim, dim);
    const b = matmul(a, rot, n, dim, dim);
    const rng = mulberry32(3);
    for (let i = 0; i < b.length; i++) b[i] += (rng() - 0.5) * 0.05;
    const shifted = gaussianMatrix(1, dim, 99);
    b.set(matmul(shifted, rot, 1, dim, dim), 0); // word 0 moves
    const words = Array.from({ length: n }, (_, i) => `w${i}`);
    const mk = (W) => ({ W: Float32Array.from(W), dim, vocab: words, counts: new Uint32Array(n).fill(500), index: new Map(words.map((w, i) => [w, i])) });
    const sa = mk(a), sb = mk(b);
    const al = alignSpaces(sa, sb, chooseAnchors(sa, sb, { exclude: new Set(['w0']) }));
    assert.ok(al.meanCos > 0.95);
    assert.ok(displacement(sa, 0, sb, 0, al.r) > 0.5);
    assert.ok(displacement(sa, 5, sb, 5, al.r) < 0.05);
  });
});

describe('occurrence vectors (occvec.mjs)', () => {
  const dim = 4;
  const vocab = ['river', 'bank', 'money', 'loan', 'the'];
  const W = new Float32Array([1, 0, 0, 0, 0.7, 0.7, 0, 0, 0, 0, 1, 0, 0, 0, 0.6, 0.8, 0, 0, 0, 1]);
  const space = { id: 1, lang: 'en', dim, pooled: true, vocab, W, index: new Map(vocab.map((w, i) => [w, i])), idf: new Float32Array([1, 0.5, 2, 2, 0.1]) };

  test('IDF-weighted mean of context vectors, L2-normalized; the target and stop-words are skipped', () => {
    const r = occurrenceVectors([{ tokens: ['the', 'river', 'bank', 'money', 'loan', 'the'], start: 2, end: 3 }], space, { stop: new Set(['the']) });
    assert.equal(r.thin[0], 0);
    assert.equal(r.usable[0], 3, 'river, money, loan (bank is the target, the is a stop-word)');
    const v = Array.from(r.vectors[0]);
    // idf·W: river 1·[1,0,0,0] + money 2·[0,0,1,0] + loan 2·[0,0,0.6,0.8] = [1, 0, 3.2, 1.6]
    const want = [1, 0, 3.2, 1.6];
    const nrm = Math.hypot(...want);
    want.forEach((x, i) => assert.ok(Math.abs(v[i] - x / nrm) < 1e-6, `dim ${i}`));
    assert.equal(r.representation, 'ppmi-svd-pooled');
  });

  test('fewer than 3 usable context words → context_thin, no vector', () => {
    const r = occurrenceVectors([{ context: ['river', 'the', 'nowhere'] }, { missing: true }], space, { stop: new Set(['the']) });
    assert.deepEqual(Array.from(r.thin), [1, 1]);
    assert.equal(r.thinCount, 2);
    assert.ok(Array.from(r.vectors[0]).every((x) => x === 0));
  });

  test('space files round-trip (vectors, vocabulary, frequencies, IDF)', () => {
    const tmp = makeTmpData({ seed: false });
    try {
      const dir = paths().spaces;
      writeSpaceFiles(dir, 'tmp-x', { W, rows: 5, dim, vocab, counts: [50, 40, 30, 20, 900], df: [5, 4, 3, 2, 10], manifest: { lang: 'en', pooled: true, passages: 10 } });
      commitSpaceFiles(dir, 'tmp-x', 77);
      const s = loadSpace(null, 77, { dir });
      assert.deepEqual(s.vocab, vocab);
      assert.deepEqual(Array.from(s.W), Array.from(W));
      assert.ok(Math.abs(s.idf[0] - Math.log(10 / 5)) < 1e-6);
      assert.ok(!readdirSync(dir).some((f) => f.startsWith('tmp-')));
      assert.throws(() => loadSpace(tmp.db, 77, { dir }), (e) => e.code === 'E_NO_SPACE', 'no vector_space row of a succeeded run');
    } finally { tmp.cleanup(); }
  });
});

describe('era slices (§4.8)', () => {
  const doc = (y, tokens, author) => ({ y_lo: y, y_hi: y, tokens, author });
  test('greedy from the earliest year at the preferred boundaries; a short remainder is listed, not merged', () => {
    const docs = [];
    for (let i = 0; i < 12; i++) docs.push(doc(1820 + i, 300_000, `a${i % 6}`));
    for (let i = 0; i < 12; i++) docs.push(doc(1851 + i, 200_000, `b${i % 6}`));
    for (let i = 0; i < 12; i++) docs.push(doc(1880 + i, 200_000, `c${i % 6}`));
    docs.push(doc(1905, 2_950_000, 'z'));
    const e = eraSlices(docs);
    assert.deepEqual(e.slices.map((s) => [s.years, s.eligible]), [[[1820, 1849], true], [[1850, 1899], true], [[1900, 1905], false]]);
    assert.equal(e.eligible, 2);
    assert.equal(eraNote('en', e), null);
    const one = eraSlices(docs.slice(0, 12).concat([doc(1880, 2_950_000, 'q')]));
    assert.equal(eraNote('es', one), 'Aligned displacement unavailable for Spanish: one eligible slice (1850–1880 has 2.95M tokens; needs 3M)');
  });
});

describe('space selection', () => {
  test('space selection: translations, duplicates and other languages never enter; passage ranges come from the stream', () => {
    const tmp2 = makeTmpData({ seed: false });
    try {
      const db = tmp2.db;
      buildSpaceCorpus(db, { tokensDir: paths().tokens, docsPerEra: 2, tokensPerDoc: 2000 });
      const docs = spaceDocuments(db, { lang: 'en' });
      assert.equal(docs.docs, 4);
      db.prepare('UPDATE document SET is_translation = 1 WHERE id = ?').run(docs.docIds[0]);
      db.prepare('UPDATE document SET dup_of = ? WHERE id = ?').run(docs.docIds[2], docs.docIds[1]);
      const after = spaceDocuments(db, { lang: 'en' });
      assert.deepEqual(after.docIds, docs.docIds.slice(2));
      const years = spaceDocuments(db, { lang: 'en', years: [1900, 1919] });
      assert.ok(years.docIds.every((id) => db.prepare('SELECT y_lo FROM document WHERE id = ?').get(id).y_lo >= 1900));
      const stream = openTokenStream('en', { dir: paths().tokens, ids: false });
      const pr = passageRanges(db, stream, { lang: 'en', docIds: after.docIds });
      assert.equal(pr.tokens, after.tokens);
      assert.equal(pr.missing, 0);
      assert.equal(spaceDocuments(db, { lang: 'fr' }).docs, 0);
    } finally { tmp2.cleanup(); }
  });
});

describe('the vectors job end to end (synthetic token streams, 6M tokens)', () => {
  let tmp, srv, corpus;
  before(async () => {
    tmp = makeTmpData({ seed: false });
    corpus = buildSpaceCorpus(tmp.db, { tokensDir: paths().tokens });
    tmp.db.close();
    srv = await startServerInProcess({ dataDir: tmp.dir });
  });
  after(async () => {
    await srv?.cleanup();
    tmp?.cleanup();
  });

  const waitJob = async (id, ms = 540000) => {
    const t0 = Date.now();
    for (;;) {
      const r = await srv.request('GET', `/api/jobs/${id}`);
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(r.json.status)) return r.json;
      if (Date.now() - t0 > ms) throw new Error(`job ${id} still ${r.json.status} after ${ms} ms`);
      await new Promise((res) => setTimeout(res, 200));
    }
  };

  test('builds the pooled space, two era slices and their alignment; files, rows and runs agree; neighbours follow topics', { timeout: 1200000 }, async () => {
    assert.equal(corpus.tokens, 6_000_000);
    const started = await srv.request('POST', '/api/analysis/runs', { body: { stage: 'vectors', params: { lang: 'en', corpora: ['test'], threads: 2 } } });
    assert.equal(started.status, 200, started.text);
    const job = await waitJob(started.json.job.id);
    assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
    const res = job.result;
    assert.equal(res.pooled.eligible, true);
    assert.deepEqual(res.era.slices.map((s) => [s.years, s.eligible]), [[[1880, 1899], true], [[1900, 1919], true]]);
    assert.equal(res.spaces.length, 3);
    assert.equal(res.alignments.length, 1);
    assert.ok(res.alignments[0].anchors >= 3000 && res.alignments[0].mean_anchor_cos > 0.5, JSON.stringify(res.alignments[0]));
    const db = srv.app.ctx.db;
    const spaces = listSpaces(db, { lang: 'en' });
    assert.equal(spaces.length, 3);
    for (const s of spaces) {
      for (const ext of ['f32', 'vocab.tsv', 'json']) assert.ok(existsSync(path.join(paths().spaces, `${s.id}.${ext}`)));
      assert.equal(s.dim, 256);
    }
    const pooled = pooledSpaceFor(db, 'en', { collections: ['space-text'] });
    assert.ok(pooled && pooled.pooled === 1);
    const sp = loadSpace(db, pooled.id);
    assert.equal(sp.synthetic, true);
    // a topic word's nearest neighbours are words of its own topic
    const { vocab } = corpus;
    const topicOf = (w) => { const id = vocab.words.indexOf(w); return id >= vocab.topicBase && id < vocab.bgBase ? Math.floor((id - vocab.topicBase) / 120) : -1; };
    const probe = vocab.words[vocab.topicBase + 7 * 120 + 5];
    const nn = nearest(sp, sp.index.get(probe), Int32Array.from({ length: sp.rows }, (_, i) => i), 20).map((i) => sp.vocab[i]);
    assert.ok(nn.filter((w) => topicOf(w) === 7).length >= 15, `neighbours of ${probe}: ${nn.join(' ')}`);
    assert.ok(TOPICS === 40 && sp.index.has(PLANTED));
    // the same request reuses every run
    const again = await waitJob((await srv.request('POST', '/api/analysis/runs', { body: { stage: 'vectors', params: { lang: 'en', corpora: ['test'], threads: 2 } } })).json.job.id);
    assert.equal(again.status, 'succeeded');
    assert.ok(again.result.spaces.every((s) => s.reused), 'identical spaces are reused');
    const runs = await srv.request('GET', '/api/analysis/runs?stage=vectors');
    assert.ok(runs.json.items.filter((r) => r.status === 'succeeded').length >= 3);
  });

  test('drift on the era slices: the planted shift is notable, the unchanged word is within typical variation; Compare reads the stored run', { timeout: 1200000 }, async () => {
    const slices = { a: { years: [1880, 1899] }, b: { years: [1900, 1919] } };
    const before = await srv.request('POST', '/api/compare', { body: { expr: [corpus.exprs.ledger], ...slices }, headers: { 'X-Scrolls-Session': 'drift-a' }, timeoutMs: 60000 });
    assert.equal(before.status, 200, before.text.slice(0, 300));
    const pending = Object.fromEntries(before.json.measures.map((m) => [m.metric, m]));
    assert.equal(pending.aligned_displacement.gate, 'not_run');
    assert.deepEqual(pending.aligned_displacement.suggestion.run.stage, 'drift');
    assert.equal(before.json.coverage.spaces.era.eligible, 2);
    for (const expr of [corpus.exprs.ledger, corpus.exprs.steady]) {
      const st = await srv.request('POST', '/api/analysis/runs', { body: { stage: 'drift', params: { expr: [expr], ...slices } } });
      assert.equal(st.status, 200, st.text);
      const job = await waitJob(st.json.job.id);
      assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
      assert.ok(job.result.spaces.every((s) => s.reused), 'the era spaces are the Compare slices\' spaces: reused, not rebuilt');
      // the Jobs tray reads the measures in words, never their codes (fix pass)
      assert.ok(!/neighbor_overlap|aligned_displacement|: ok\b/.test(job.message ?? ''), job.message);
      assert.match(job.message ?? '', /neighbour overlap: (computed|withheld)/);
    }
    const cmp = async (expr, session) => {
      const r = await srv.request('POST', '/api/compare', { body: { expr: [expr], ...slices }, headers: { 'X-Scrolls-Session': session }, timeoutMs: 60000 });
      assert.equal(r.status, 200, r.text.slice(0, 300));
      return Object.fromEntries(r.json.measures.map((m) => [m.metric, m]));
    };
    const ledger = await cmp(corpus.exprs.ledger, 'drift-b');
    assert.equal(ledger.aligned_displacement.gate, 'ok', JSON.stringify(ledger.aligned_displacement));
    assert.ok(ledger.aligned_displacement.percentile >= 95, `ledger at the ${ledger.aligned_displacement.percentile}th percentile`);
    assert.equal(ledger.neighbor_overlap.gate, 'ok');
    assert.ok(ledger.neighbor_overlap.jaccard <= 0.2, `ledger neighbour Jaccard ${ledger.neighbor_overlap.jaccard}`);
    assert.equal(ledger.aligned_displacement.verdict, 'notable');
    assert.match(ledger.aligned_displacement.text, /estimated shift in usage contexts/);
    const steady = await cmp(corpus.exprs.steady, 'drift-c');
    assert.equal(steady.aligned_displacement.gate, 'ok');
    assert.ok(steady.aligned_displacement.percentile < 95, `steady at the ${steady.aligned_displacement.percentile}th percentile`);
    assert.equal(steady.aligned_displacement.verdict, 'within typical variation');
    const rows = srv.app.ctx.db.prepare("SELECT gate, value FROM drift_result WHERE gate <> 'ok'").all();
    assert.ok(rows.every((r) => r.value === null));
  });


});
