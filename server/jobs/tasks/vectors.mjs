// OWNER: WP4
// tasks/vectors.mjs — job 'vectors': PPMI-SVD spaces per language (SPEC §4.8).
// params: {lang: string, corpora?: string[], collections?: string[], scope?: 'all'|'pooled'|'era', threads?: number}
//   lang        the passage language (required)
//   corpora     corpus slugs whose running text is used; default every corpus that is not synthetic
//   collections collection slugs instead of whole corpora (a per-collection space, e.g. OpenAlex abstracts alone);
//               they must hold running text or abstracts
//   scope    'pooled' = the pooled space only; 'era' = the eligible era slices (+ alignments of neighbours);
//            'all' (default) = both
// A space is one 'vectors' analysis run (params: language, years, document set, parameters) with one
// vector_space row and its files in derived/spaces/; an identical succeeded run is reused. Consecutive era
// slices are aligned ('align' runs, space_alignment rows, R in derived/align/<id>.f32). Each step reports
// progress; the counting and the sparse products run in worker threads that a cancel terminates at once.
// buildSpace() is also what the drift job uses for the spaces of two Compare slices.

import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { endianness } from 'node:os';
import path from 'node:path';
import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { TOKENIZER_VERSION } from '../../../src/shared/tokenize.mjs';
import { chooseVocab, cooccurrencePpmi, defaultThreads, LIMITS, passageRanges, readSharedIds, spaceDocuments, unigramCounts,
  WINDOW } from '../../analysis/cooc.mjs';
import { eraDocuments, eraNote, eraSlices, SLICE_GATE } from '../../analysis/drift.mjs';
import { commitSpaceFiles, discardSpaceFiles, loadSpace, REPRESENTATION, writeSpaceFiles } from '../../analysis/occvec.mjs';
import { ALPHA } from '../../analysis/ppmi.mjs';
import { alignSpaces, chooseAnchors } from '../../analysis/procrustes.mjs';
import { randomizedSvd, RSVD, wordVectors } from '../../analysis/rsvd.mjs';
import { buildTokenStreams, openTokenStream, streamFiles, streamStatus } from '../../analysis/tokstream.mjs';
import { dataVersion, nowIso, tx } from '../../db/open.mjs';
import { badRequest } from '../../http/errors.mjs';
import { assertInputsUnchanged, retryBusy, runWrites } from '../../analysis/commit.mjs';

export const type = 'vectors';
export const { writes, priority } = JOB_TYPES[type];

/** Pipeline version of vectors and align runs. */
export const VECTORS_VERSION = 'vectors@1.0.0';
const CODE_FILES = ['cooc.mjs', 'ppmi.mjs', 'rsvd.mjs', 'linalg.mjs', 'occvec.mjs'].map((f) => new URL(`../../analysis/${f}`, import.meta.url));

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {{lang: string, corpora?: string[], scope?: string, threads?: number}} params
 * @returns {Promise<object>} result_json
 */
export async function run(ctx, params) {
  const p = normalizeVectorsParams(params);
  const db = ctx.db;
  const named = p.collections ? namedCollections(db, p.collections) : null;
  const corpora = named ? resolveCorpora(db, [...new Set(named.map((c) => c.corpus))]) : resolveCorpora(db, p.corpora);
  const collections = named ?? collectionsOf(db, corpora.map((c) => c.id));
  const collIds = collections.map((c) => c.id);
  const synthetic = corpora.some((c) => c.is_synthetic === 1);
  const plan = [];
  let pooled = null;
  if (p.scope !== 'era') {
    const sel = spaceDocuments(db, { lang: p.lang, collections: collIds });
    const gate = sliceGate(sel);
    pooled = { tokens: sel.tokens, docs: sel.docs, authors: sel.authors, eligible: gate === null, missing: gate };
    if (!gate) plan.push({ pooled: true, years: null, docIds: sel.docIds, tokens: sel.tokens, docs: sel.docs, authors: sel.authors });
  }
  let era = null;
  if (p.scope !== 'pooled') {
    const e = eraSlices(eraDocuments(db, { lang: p.lang, collections: collIds }));
    era = { ...e, note: eraNote(p.lang, e) };
    for (const s of e.slices.filter((x) => x.eligible)) {
      const sel = spaceDocuments(db, { lang: p.lang, collections: collIds, years: s.years });
      plan.push({ pooled: false, years: s.years, docIds: sel.docIds, tokens: sel.tokens, docs: sel.docs, authors: sel.authors });
    }
  }
  const out = { lang: p.lang, corpora: corpora.map((c) => c.slug), ...(named ? { collections: named.map((c) => c.slug) } : {}), pooled, era,
    spaces: [], alignments: [] };
  if (!plan.length) {
    ctx.progress(1, 'done', 'no space passes its gate');
    return out;
  }
  const source = await ensureStream(ctx, p.lang);
  const weights = plan.map((s) => s.tokens);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let before = 0;
  for (const [i, s] of plan.entries()) {
    const share = weights[i] / total * 0.95;
    const label = s.pooled ? `pooled ${p.lang}` : `${p.lang} ${s.years[0]}–${s.years[1]}`;
    const built = await buildSpace(ctx, { lang: p.lang, docIds: s.docIds, years: s.years, pooled: s.pooled, synthetic, stats: s, threads: p.threads, source,
      onProgress: (f, m) => ctx.progress(0.03 + before + share * f, label, m) });
    before += share;
    out.spaces.push({ ...built, label, years: s.years, pooled: s.pooled });
  }
  const eraSpaces = out.spaces.filter((s) => !s.pooled);
  for (let i = 0; i + 1 < eraSpaces.length; i++) {
    ctx.checkpoint();
    out.alignments.push(alignPair(ctx, eraSpaces[i], eraSpaces[i + 1]));
  }
  ctx.progress(1, 'done', `${out.spaces.length} space(s), ${out.alignments.length} alignment(s)`);
  return out;
}

/**
 * Validate the job's params.
 * @param {unknown} params
 * @returns {{lang: string, corpora: string[]|null, scope: 'all'|'pooled'|'era', threads: number}}
 * @throws {HttpError} 400
 */
export function normalizeVectorsParams(params) {
  const lang = params?.lang;
  if (typeof lang !== 'string' || !/^[a-z]{2,3}(-[A-Za-z]{2,8})?$/.test(lang)) {
    throw badRequest('E_VALIDATION', 'params.lang must be a language code, e.g. "en".', 'Spaces are built per passage language.', { field: 'params.lang' });
  }
  const corpora = params.corpora ?? null;
  if (corpora !== null && (!Array.isArray(corpora) || !corpora.length || !corpora.every((c) => typeof c === 'string' && /^[a-z0-9-]{1,48}$/.test(c)))) {
    throw badRequest('E_VALIDATION', 'params.corpora must list corpus slugs.', 'e.g. ["cipher"]; leave it out for every real corpus.', { field: 'params.corpora' });
  }
  const scope = params.scope ?? 'all';
  if (!['all', 'pooled', 'era'].includes(scope)) throw badRequest('E_VALIDATION', "params.scope must be 'all', 'pooled' or 'era'.", null, { field: 'params.scope' });
  const threads = params.threads === undefined ? defaultThreads() : Number(params.threads);
  if (!Number.isInteger(threads) || threads < 0 || threads > 8) throw badRequest('E_VALIDATION', 'params.threads must be 0–8.', null, { field: 'params.threads' });
  const collections = params.collections ?? null;
  if (collections !== null && (!Array.isArray(collections) || !collections.length || !collections.every((c) => typeof c === 'string' && /^[a-z0-9-]{1,64}$/.test(c)))) {
    throw badRequest('E_VALIDATION', 'params.collections must list collection slugs.', 'e.g. ["stemm-openalex"]; leave it out for whole corpora.',
      { field: 'params.collections' });
  }
  if (collections && corpora) throw badRequest('E_VALIDATION', 'Send params.corpora or params.collections, not both.', null, { field: 'params.collections' });
  return { lang, corpora, scope, threads, collections: collections ? [...new Set(collections)].sort() : null };
}

/** Collections named by slug, with their corpus; each must hold running text or abstracts. */
function namedCollections(db, slugs) {
  const rows = db.prepare(`SELECT c.id, c.slug, c.modality, k.slug AS corpus FROM collection c JOIN corpus k ON k.id = c.corpus_id
    WHERE c.slug IN (SELECT value FROM json_each(?)) ORDER BY c.slug`).all(JSON.stringify(slugs));
  const unknown = slugs.filter((s) => !rows.some((r) => r.slug === s));
  if (unknown.length) throw badRequest('E_VALIDATION', `Unknown collection ${unknown.map((s) => `'${s}'`).join(', ')}.`, null, { field: 'params.collections' });
  const other = rows.filter((r) => !['text', 'abstracts'].includes(r.modality));
  if (other.length) {
    throw badRequest('E_VALIDATION', `${other.map((r) => r.slug).join(', ')} holds no running text; spaces are built from text and abstracts.`, null,
      { field: 'params.collections' });
  }
  return rows;
}

function resolveCorpora(db, slugs) {
  const rows = db.prepare('SELECT id, slug, is_synthetic FROM corpus ORDER BY slug').all();
  if (!slugs) return rows.filter((r) => r.is_synthetic === 0);
  const out = rows.filter((r) => slugs.includes(r.slug));
  const unknown = slugs.filter((s) => !out.some((r) => r.slug === s));
  if (unknown.length) throw badRequest('E_VALIDATION', `Unknown corpus ${unknown.map((s) => `'${s}'`).join(', ')}.`, null, { field: 'params.corpora' });
  return out;
}

function collectionsOf(db, corpusIds) {
  return db.prepare(`SELECT id, slug FROM collection WHERE corpus_id IN (SELECT value FROM json_each(?))
    AND modality IN ('text', 'abstracts') ORDER BY slug`).all(JSON.stringify(corpusIds));
}

/** The §4.8 slice gate: null when it passes, else what is missing. */
export function sliceGate({ tokens, docs, authors }) {
  const missing = {};
  if (tokens < SLICE_GATE.tokens) missing.tokens = { needed: SLICE_GATE.tokens, have: tokens };
  if (docs < SLICE_GATE.docs) missing.docs = { needed: SLICE_GATE.docs, have: docs };
  if (authors < SLICE_GATE.authors) missing.authors = { needed: SLICE_GATE.authors, have: authors };
  return Object.keys(missing).length ? missing : null;
}

/**
 * A fresh token stream of the language (built here when the current one is older than the data) with
 * its ids in shared memory.
 * @returns {Promise<{stream: object, ids: Uint32Array}>}
 */
export async function ensureStream(ctx, lang) {
  const dir = ctx.paths.tokens;
  if (!streamStatus(ctx.db, dir, lang).fresh) {
    ctx.progress(0.005, 'token stream', `writing the ${lang} token stream`);
    buildTokenStreams(ctx.db, { langs: [lang], dir, runId: null }, { checkpoint: () => ctx.checkpoint(),
      progress: (f, phase, message) => ctx.progress(0.005 + 0.02 * f, 'token stream', message) });
  }
  const stream = openTokenStream(lang, { dir, ids: false });
  const ids = readSharedIds(streamFiles(dir, lang).ids, stream.tokens, { tick: () => ctx.checkpoint() });
  return { stream, ids };
}

/**
 * Build (or reuse) one space: the documents' running-text passages → vocabulary → co-occurrence → PPMI →
 * randomized SVD → files + vector_space row under a 'vectors' run.
 * @param {object} ctx TaskCtx
 * @param {{lang: string, docIds: number[], years: [number, number]|null, pooled: boolean, synthetic?: boolean,
 *   stats: {tokens: number, docs: number, authors: number}, threads: number,
 *   source: {stream: object, ids: Uint32Array}, onProgress?: (f: number, m: string) => void, extra?: object}} def
 * @returns {Promise<{space_id: number, run_id: number, reused: boolean, vocab: number, tokens: number}>}
 */
export async function buildSpace(ctx, def) {
  const db = ctx.db;
  const onProgress = def.onProgress ?? (() => {});
  // A space is identified by its documents: the same documents give the same run, whichever job asks
  // (an era slice of the vectors job and an identical Compare slice of the drift job share one space).
  const docIds = [...def.docIds].sort((a, b) => a - b);
  const docsHash = createHash('sha256').update(docIds.join(',')).digest('hex').slice(0, 32);
  const where = db.prepare(`SELECT DISTINCT c.slug AS coll, k.slug AS corpus, k.is_synthetic AS syn FROM document d JOIN collection c ON c.id = d.collection_id
    JOIN corpus k ON k.id = c.corpus_id WHERE d.id IN (SELECT value FROM json_each(?)) ORDER BY c.slug`).all(JSON.stringify(docIds));
  const collections = [...new Set(where.map((r) => r.coll))];
  const corpora = [...new Set(where.map((r) => r.corpus))].sort();
  const synthetic = def.synthetic || where.some((r) => r.syn === 1);
  const params = { version: VECTORS_VERSION, lang: def.lang, pooled: def.pooled, years: def.years, corpora, docs: docsHash,
    window: WINDOW, limits: LIMITS, alpha: ALPHA, rsvd: RSVD, ...(def.extra ?? {}) };
  const scope = { collections };
  const reuse = runWrites(ctx).findReusableRun('vectors', { params, scope });
  if (reuse) {
    const row = db.prepare('SELECT id, vocab_size, tokens FROM vector_space WHERE run_id = ?').get(reuse);
    if (row) {
      onProgress(1, 'reused an identical space');
      return { space_id: row.id, run_id: reuse, reused: true, vocab: row.vocab_size, tokens: row.tokens };
    }
  }
  const runId = runWrites(ctx).startRun('vectors', { pipelineVersion: VECTORS_VERSION, params, scope,
    representation: def.pooled ? REPRESENTATION.pooled : REPRESENTATION.slice, seed: RSVD.seed, codeFiles: CODE_FILES });
  const dir = ctx.paths.spaces;
  const stem = `tmp-r${runId}`;
  const check = () => ctx.checkpoint();
  try {
    const { stream, ids } = def.source;
    onProgress(0.01, 'selecting passages');
    const sel = passageRanges(db, stream, { lang: def.lang, docIds });
    check();
    const uni = unigramCounts(ids, sel.ranges, stream.vocab.length, { tick: check });
    const voc = chooseVocab(uni.counts);
    if (voc.targets.length < 2 || voc.contexts.length < 2) throw Object.assign(new Error(`Too few word types (${voc.targets.length}) to build a space.`), { code: 'E_SPACE_EMPTY' });
    onProgress(0.05, `${voc.targets.length.toLocaleString('en-US')} target words, ${voc.contexts.length.toLocaleString('en-US')} contexts`);
    const co = await cooccurrencePpmi({ ids, ranges: sel.ranges, targetIndex: voc.targetIndex, contextIndex: voc.contextIndex,
      nTargets: voc.targets.length, nContexts: voc.contexts.length }, { threads: def.threads, signal: ctx.signal, tick: check,
      onProgress: (f, m) => onProgress(0.05 + 0.3 * f, m) });
    check();
    onProgress(0.36, `PPMI: ${co.csr.nnz.toLocaleString('en-US')} non-zero cells`);
    const svd = await randomizedSvd(co.csr, { threads: def.threads, signal: ctx.signal, step: check,
      onProgress: (f, m) => onProgress(0.36 + 0.58 * f, `SVD: ${m}`) });
    const W = wordVectors(svd);
    const vocab = Array.from(voc.targets, (id) => stream.vocab[id]);
    const counts = Array.from(voc.targets, (id) => uni.counts[id]);
    const df = Array.from(voc.targets, (id) => uni.df[id]);
    const manifest = { lang: def.lang, pooled: def.pooled, years: def.years, corpora, collections, run_id: runId,
      tokens: sel.tokens, passages: sel.passages, missing_passages: sel.missing, docs: def.stats.docs, authors: def.stats.authors,
      contexts: voc.contexts.length, window: WINDOW, alpha: ALPHA, rsvd: { ...RSVD, d: svd.d, l: svd.l }, singular_values: Array.from(svd.s, (x) => Number(x.toFixed(4))),
      pairs: co.pairs, nnz: co.csr.nnz, data_version: dataVersion(db), tokenizer: TOKENIZER_VERSION, stream_data_version: stream.manifest.data_version,
      synthetic, representation: def.pooled ? REPRESENTATION.pooled : REPRESENTATION.slice, built_at: nowIso() };
    onProgress(0.95, 'writing the space');
    writeSpaceFiles(dir, stem, { W, rows: vocab.length, dim: svd.d, vocab, counts, df, manifest });
    check();
    const spaceId = retryBusy(() => tx(db, () => {
      assertInputsUnchanged(db, runId);
      const id = Number(db.prepare(`INSERT INTO vector_space (run_id, lang, lo_year, hi_year, pooled, collections_json, tokens, docs, authors,
          vocab_size, dim, rel_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(runId, def.lang, def.years?.[0] ?? null, def.years?.[1] ?? null, def.pooled ? 1 : 0, JSON.stringify(collections), sel.tokens,
          def.stats.docs, def.stats.authors, vocab.length, svd.d).lastInsertRowid);
      db.prepare('UPDATE vector_space SET rel_path = ? WHERE id = ?').run(`spaces/${id}`, id);
      return id;
    }), { checkpoint: check });
    commitSpaceFiles(dir, stem, spaceId, { space_id: spaceId });
    const metrics = { space_id: spaceId, lang: def.lang, years: def.years, pooled: def.pooled, tokens: sel.tokens, passages: sel.passages,
      docs: def.stats.docs, authors: def.stats.authors, vocab: vocab.length, contexts: voc.contexts.length, nnz: co.csr.nnz, pairs: co.pairs,
      dim: svd.d, top_singular_values: manifest.singular_values.slice(0, 5), synthetic };
    runWrites(ctx).finishRun(runId, 'succeeded', { metrics });
    onProgress(1, 'done');
    return { space_id: spaceId, run_id: runId, reused: false, vocab: vocab.length, tokens: sel.tokens };
  } catch (err) {
    discardSpaceFiles(dir, stem);
    throw err;
  }
}

/**
 * Align a later era slice onto the one before it (no target excluded: a general alignment whose quality
 * says whether the two eras can be compared at all) and store R.
 */
function alignPair(ctx, from, to) {
  const db = ctx.db;
  const sa = loadSpace(db, from.space_id, { dir: ctx.paths.spaces });
  const sb = loadSpace(db, to.space_id, { dir: ctx.paths.spaces });
  const params = { version: VECTORS_VERSION, method: 'orthogonal_procrustes', a: from.space_id, b: to.space_id };
  const scope = { spaces: [from.space_id, to.space_id] };
  const upstream = [from.run_id, to.run_id];
  const reuse = runWrites(ctx).findReusableRun('align', { params, scope, upstream });
  const prior = reuse ? db.prepare('SELECT id FROM space_alignment WHERE run_id = ?').get(reuse) : null;
  if (prior) {
    const m = JSON.parse(db.prepare('SELECT metrics_json FROM analysis_run WHERE id = ?').get(reuse).metrics_json ?? '{}');
    return { ...m, alignment_id: prior.id, reused: true };
  }
  const runId = runWrites(ctx).startRun('align', { pipelineVersion: VECTORS_VERSION, params, scope, upstream, codeFiles: CODE_FILES });
  const anchors = chooseAnchors(sa, sb);
  const al = alignSpaces(sa, sb, anchors);
  mkdirSync(ctx.paths.align, { recursive: true });
  const tmp = path.join(ctx.paths.align, `tmp-r${runId}.f32`);
  const r32 = Float32Array.from(al.r);
  writeFileSync(tmp, new Uint8Array(r32.buffer));
  try {
    const id = retryBusy(() => tx(db, () => {
      const i = Number(db.prepare(`INSERT INTO space_alignment (run_id, from_space, to_space, method, anchors, mean_anchor_cos, rel_path)
        VALUES (?, ?, ?, 'orthogonal_procrustes', ?, ?, 'pending')`).run(runId, to.space_id, from.space_id, al.anchors, al.meanCos).lastInsertRowid);
      db.prepare('UPDATE space_alignment SET rel_path = ? WHERE id = ?').run(`align/${i}.f32`, i);
      return i;
    }), { checkpoint: () => ctx.checkpoint() });
    renameSync(tmp, path.join(ctx.paths.align, `${id}.f32`));
    const metrics = { alignment_id: id, from: to.years, to: from.years, anchors: al.anchors, anchors_available: anchors.available,
      mean_anchor_cos: Number(al.meanCos.toFixed(4)), mean_anchor_cos_before: Number(al.meanCosBefore.toFixed(4)), byte_order: endianness() };
    runWrites(ctx).finishRun(runId, 'succeeded', { metrics });
    return metrics;
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
