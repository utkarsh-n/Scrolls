// OWNER: WP5
// exact.mjs — the exact-quotation stages of the reuse index (SPEC §4.7): winnowing (k = 8, w = 6) of every document's
// ok token stream; fingerprint records (hash u32, document u32, position u32) and an edge-zone flag in typed arrays,
// radix-sorted by hash and grouped; groups of more than 25 documents are widespread (never seeds), groups in ≥ 3
// documents lying ≥ 80% in the edge zones are production-line; seeds per document pair are verified by
// seed-and-extend into maximal common runs of ≥ 13 tokens, which the filters then sort into quotation candidates,
// structure, production-line text and widely shared text (lineage/filters.mjs). Never stored as SQLite rows.

import { seedExtend } from './align.mjs';
import { Growable, orderBy } from './corpus.mjs';
import { coveredTokens, inEdgeZone, informative, isNameList, PRODUCTION, stableFlagShare } from './filters.mjs';
import { radixSortPairs, winnow } from './winnow.mjs';

/** Fingerprint flags: production-line group, widespread group (> 25 documents). */
export const FLAG = Object.freeze({ PROD: 1, WIDE: 2 });
const MAX_GROUP_OCCURRENCES = 200;

/**
 * Load every document of the corpus and winnow it.
 * @param {object} ctx TaskCtx (checkpoint, progress)
 * @param {import('./corpus.mjs').ScopeCorpus} corpus
 * @param {{k: number, w: number, capacity: number}} opts
 * @returns {{n: number, hashes: Uint32Array, docCol: Uint32Array, posCol: Uint32Array, edgeCol: Uint8Array, docFp: Uint32Array, tokens: number}}
 *   records of document di are docFp[di] … docFp[di + 1] − 1, positions ascending
 */
export function fingerprintCorpus(ctx, corpus, { k, w, capacity }) {
  const fp = new Growable(3, capacity);
  const edges = new Growable(1, capacity, Uint8Array);
  const docFp = new Uint32Array(corpus.docs.length + 1);
  let tokens = 0;
  for (let di = 0; di < corpus.docs.length; di++) {
    ctx.checkpoint();
    docFp[di] = fp.n;
    const len = corpus.load(di);
    tokens += len;
    const { hashes, positions } = winnow(corpus.docIds(di), { k, w });
    for (let i = 0; i < hashes.length; i++) {
      fp.push(hashes[i], di, positions[i]);
      edges.push(inEdgeZone(positions[i], len, PRODUCTION.edge) ? 1 : 0);
    }
    if (di % 50 === 0) ctx.progress(0.25 * (di + 1) / corpus.docs.length, 'fingerprints', `${di + 1} / ${corpus.docs.length} documents`);
  }
  docFp[corpus.docs.length] = fp.n;
  const [hashes, docCol, posCol] = fp.cols;
  return { n: fp.n, hashes, docCol, posCol, edgeCol: edges.cols[0], docFp, tokens };
}

/**
 * Group fingerprints by hash: flag widespread and production-line groups, and emit seeds (one per pair of
 * occurrences in two documents) for groups of 2–25 documents.
 * @param {object} ctx TaskCtx
 * @param {ReturnType<typeof fingerprintCorpus>} fp
 * @param {{maxGroupDocs: number, production: boolean, sameWork: Function, docs: object[], counts: object}} opts
 * @returns {{flags: Uint8Array, seeds: Growable}} seeds columns: doc a, position a, doc b, position b (a < b)
 */
export function groupFingerprints(ctx, fp, { maxGroupDocs, production, sameWork, docs, counts }) {
  const { n, docCol, posCol, edgeCol } = fp;
  const flags = new Uint8Array(n);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const keys = fp.hashes.slice(0, n);
  radixSortPairs(keys, order, n);
  const seeds = new Growable(4, 1 << 14);
  let groups = 0;
  for (let i = 0; i < n;) {
    let j = i, nDocs = 0, nEdge = 0, last = -1;
    while (j < n && keys[j] === keys[i]) {
      const o = order[j];
      if (docCol[o] !== last) { nDocs++; last = docCol[o]; }
      nEdge += edgeCol[o];
      j++;
    }
    const occ = j - i;
    let flag = 0;
    if (nDocs > maxGroupDocs) { flag = FLAG.WIDE; counts.widespread_groups++; }
    else if (production && nDocs >= PRODUCTION.minDocs && nEdge >= PRODUCTION.edgeShare * occ) { flag = FLAG.PROD; counts.production_groups++; }
    if (flag) for (let r = i; r < j; r++) flags[order[r]] = flag;
    // production groups still seed runs: the verified run is then classified (and counted, with a sample) as a whole
    if (flag !== FLAG.WIDE && nDocs >= 2 && occ <= MAX_GROUP_OCCURRENCES) {
      for (let x = i; x < j; x++) {
        for (let y = x + 1; y < j; y++) {
          let a = order[x], b = order[y];
          if (docCol[a] === docCol[b]) continue;
          if (docCol[a] > docCol[b]) [a, b] = [b, a];
          if (sameWork(docs[docCol[a]], docs[docCol[b]])) continue;
          seeds.push(docCol[a], posCol[a], docCol[b], posCol[b]);
        }
      }
    }
    i = j;
    if ((++groups & 0xffff) === 0) ctx.checkpoint();
  }
  counts.seeds = seeds.n;
  return { flags, seeds };
}

/**
 * Verify seeds by document pair into maximal runs of ≥ exactMin tokens and sort them out.
 * @param {object} ctx TaskCtx
 * @param {import('./corpus.mjs').ScopeCorpus} corpus
 * @param {ReturnType<typeof fingerprintCorpus>} fp
 * @param {{flags: Uint8Array, seeds: Growable}} grouped
 * @param {{exactMin: number, k: number, w: number, log: import('./filters.mjs').ExclusionLog, counts: object}} opts
 * @returns {Map<string, {da: number, db: number, runs: object[], covered: number, shorter: number}>} kept runs per document
 *   pair 'da:db' (global token indexes), with the tokens they cover on the shorter document's side
 */
export function verifySeeds(ctx, corpus, fp, { flags, seeds }, { exactMin, k, w, log, counts }) {
  const [sDa, sPa, sDb, sPb] = seeds.cols;
  const seedOrder = orderBy(sDa, sDb, seeds.n);
  const docs = corpus.docs;
  const quote = (g0, g1) => { const s = corpus.span(g0, g1); return s.text.slice(s.start, s.end); };
  const out = new Map();
  for (let i = 0; i < seeds.n;) {
    const da = sDa[seedOrder[i]], dbi = sDb[seedOrder[i]];
    let j = i;
    const list = [];
    while (j < seeds.n && sDa[seedOrder[j]] === da && sDb[seedOrder[j]] === dbi) { list.push({ a: sPa[seedOrder[j]], b: sPb[seedOrder[j]] }); j++; }
    i = j;
    counts.pairs_checked++;
    if ((counts.pairs_checked & 1023) === 0) ctx.checkpoint();
    const oa = corpus.docStart[da], ob = corpus.docStart[dbi];
    const idsA = corpus.docIds(da);
    const fpA = { positions: fp.posCol, flags, lo: fp.docFp[da], hi: fp.docFp[da + 1], k, w };
    const kept = [];
    for (const r of seedExtend(idsA, corpus.docIds(dbi), list, { minRun: exactMin })) {
      const g = { a0: oa + r.a0, a1: oa + r.a1, b0: ob + r.b0, b1: ob + r.b1, len: r.len };
      if (!informative(corpus.ids, g.a0, g.a1, corpus.classes)) {
        counts.structural_runs++;
        log.add('structure', quote(g.a0, g.a1));
        continue;
      }
      const text = quote(g.a0, g.a1);
      if (isNameList(text)) {
        counts.list_runs++;
        log.add('name_list', text);
        continue;
      }
      const share = stableFlagShare(idsA, r.a0, r.a1, { ...fpA, mask: FLAG.PROD | FLAG.WIDE });
      if (share.total > 0 && share.flagged >= PRODUCTION.runShare * share.total) {
        const wide = stableFlagShare(idsA, r.a0, r.a1, { ...fpA, mask: FLAG.WIDE }).flagged * 2 >= share.flagged;
        counts[wide ? 'widely_shared_runs' : 'production_runs']++;
        log.add(wide ? 'widely_shared' : 'production_line', text, { e_g: `${docs[da].title} · ${docs[dbi].title}` });
        continue;
      }
      // a run stays inside one field on each side (body and abstract are separate texts)
      if (corpus.passageAt(g.a1 - 1).field !== corpus.passageAt(g.a0).field || corpus.passageAt(g.b1 - 1).field !== corpus.passageAt(g.b0).field) continue;
      kept.push(g);
    }
    if (!kept.length) continue;
    const aShorter = corpus.docLength(da) <= corpus.docLength(dbi);
    out.set(`${da}:${dbi}`, { da, db: dbi, runs: kept, covered: coveredTokens(kept, aShorter ? 'a' : 'b'),
      shorter: aShorter ? corpus.docLength(da) : corpus.docLength(dbi) });
  }
  return out;
}
