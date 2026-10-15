// OWNER: WP5
// boilerplate.mjs — boilerplate vs commonplace classification of widespread fingerprint groups (SPEC §4.7).
//
// Every full-text document of the scope is winnowed (k = 8, w = 6) over its WHOLE decoded original — the body
// and also any header/footer the adapter left outside the body, which is boilerplate by construction
// (Gutenberg licence text) and counts as an edge occurrence. Fingerprint records live in typed arrays (never
// SQLite rows), radix-sorted by hash and grouped:
//  · a group whose hash occurs in > 25 distinct documents is *widespread*;
//  · a widespread group is *boilerplate* if ≥ 50% of its occurrences lie in the first or last 15% of their
//    documents' bodies (or outside them), or if its text matches the licence lexicon (project gutenberg |
//    ebook | license | licence | donation | trademark | small print | computer virus | computer codes);
//  · other widespread groups are *commonplaces* (Bible verses, proverbs): counted normally, collapsed into the
//    "widely shared text" node in Lineage.
// A quality='ok' body passage becomes 'boilerplate' by rule
//  (A) shared text — ≥ 50% of its fingerprints are in boilerplate groups (§4.7);
// and, because a licence version carried by only a few files can never be widespread (Cipher's old "Small
// Print!" licence sits inside the body of 2 of the 4 files that have it), by two narrow edge-zone rules:
//  (B) licence wording at an edge — it starts in the first/last 15% of the body, holds ≥ 2 licence-lexicon
//      matches and ≥ 1 boilerplate fingerprint;
//  (C) inside a licence block — it starts in the edge zone, holds a lexicon match or a boilerplate fingerprint,
//      and both neighbours (or the body edge) are boilerplate (applied until nothing changes).
// Then doc_tokens are rewritten and meta.quality_version and data_version bumped. Canary (§11): afterwards no
// ok passage contains the licence sentence "computer virus, or computer codes that damage".

import { tokenize } from '../../src/shared/tokenize.mjs';
import { bumpDataVersion, getMeta, nowIso, setMeta, stmt, tx } from '../db/open.mjs';
import { rewriteDocTokens } from '../store/bins.mjs';
import { writeCommonplaces } from './commonplace.mjs';
import { K, W, radixSortPairs, tokenIds, winnow } from './winnow.mjs';

/** Pipeline version recorded on the analysis_run. */
export const PIPELINE_VERSION = 'boilerplate@1.0.0';

/** Parameters of SPEC §4.7 (and of the two edge-zone rules). */
export const DEFAULTS = Object.freeze({
  k: K, w: W,
  minDocs: 25,          // widespread: hash in MORE than 25 distinct documents
  edge: 0.15,           // first / last 15% of the body
  groupEdgeShare: 0.5,  // ≥ 50% of a group's occurrences at the edges
  passageShare: 0.5,    // rule A: ≥ 50% of a passage's fingerprints in boilerplate groups
  edgeLexicon: 2,       // rule B: lexicon matches needed in an edge-zone passage
});

/** Licence lexicon of §4.7 as folded-token patterns; a single-token term matches tokens that start with it. */
export const LICENCE_LEXICON = Object.freeze([
  ['project', 'gutenberg'], ['ebook'], ['license'], ['licence'], ['donation'], ['trademark'], ['small', 'print'],
  ['computer', 'virus'], ['computer', 'codes'],
]);

/** The canary sentence (folded tokens) that must not survive in an ok passage. */
export const CANARY_TOKENS = Object.freeze(['computer', 'virus', 'or', 'computer', 'codes', 'that', 'damage']);

// a record's ref: slot * 4 + edge * 2 + lexicon (slots < 2^30)
const EDGE_BIT = 2, LEX_BIT = 1;
// slot quality codes
const Q_OK = 1, Q_BOILERPLATE = 2, Q_OTHER = 3;

/**
 * Length of the lexicon term starting at each token (0 = none).
 * @param {string[]} tokens folded tokens
 * @returns {Uint8Array}
 */
export function lexiconStarts(tokens) {
  const out = new Uint8Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    for (const term of LICENCE_LEXICON) {
      if (term.length === 1) {
        if (tokens[i].startsWith(term[0])) { out[i] = 1; break; }
      } else if (tokens[i] === term[0] && i + 1 < tokens.length && tokens[i + 1].startsWith(term[1])) {
        out[i] = 2;
        break;
      }
    }
  }
  return out;
}

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Growable (hash, ref) record store in typed arrays. */
export class Records {
  constructor(capacity = 1024) {
    this.n = 0;
    this.hashes = new Uint32Array(Math.max(1024, capacity));
    this.refs = new Uint32Array(this.hashes.length);
  }
  push(hash, ref) {
    if (this.n === this.hashes.length) {
      const grow = (a) => { const b = new Uint32Array(a.length * 2); b.set(a); return b; };
      this.hashes = grow(this.hashes);
      this.refs = grow(this.refs);
    }
    this.hashes[this.n] = hash;
    this.refs[this.n] = ref;
    this.n++;
  }
}

/**
 * Per-slot tallies of a pass: fingerprints, lexicon matches, edge-zone flag, and (after classifyGroups)
 * boilerplate and commonplace fingerprints.
 */
export class SlotTable {
  constructor(size) {
    this.passage = new Int32Array(size).fill(-1); // passage id; -1 = a document's outside-body slot
    this.doc = new Uint32Array(size);              // document index
    this.quality = new Uint8Array(size);           // Q_OK | Q_BOILERPLATE | Q_OTHER
    this.fp = new Uint32Array(size);
    this.lex = new Uint16Array(size);
    this.edgeZone = new Uint8Array(size);
    this.bp = new Uint32Array(size);
    this.cp = new Uint32Array(size);
    this.cpKey = new Uint32Array(size);   // the most widely shared commonplace group of the slot
    this.cpDocs = new Uint32Array(size);  // … and its document count
  }
}

/**
 * Fingerprint one document into the record store and fill its slots' tallies.
 * @param {string} original decoded original text
 * @param {{bodyStart: number, bodyEnd: number, passages: Array<{start_off: number, end_off: number, slot: number}>,
 *   outsideSlot: number, k?: number, w?: number, edge?: number}} doc passages sorted by start_off, slots preassigned
 * @param {Records} records
 * @param {SlotTable} slots
 * @returns {number} tokens in the document
 */
export function fingerprintDocument(original, { bodyStart, bodyEnd, passages, outsideSlot, k = K, w = W, edge = DEFAULTS.edge }, records, slots) {
  const tok = tokenize(original);
  const n = tok.tokens.length;
  if (n === 0) return 0;
  const lex = lexiconStarts(tok.tokens);
  const b0 = lowerBound(tok.starts, bodyStart);
  const b1 = Math.max(b0, lowerBound(tok.starts, bodyEnd));
  const bodyLen = Math.max(1, b1 - b0);
  const inEdge = (i) => i < b0 || i >= b1 || (i - b0) / bodyLen < edge || (i - b0) / bodyLen >= 1 - edge;

  for (const p of passages) {
    const t0 = lowerBound(tok.starts, p.start_off), t1 = lowerBound(tok.starts, p.end_off);
    let m = 0;
    for (let i = t0; i < t1; i++) if (lex[i]) m++;
    slots.lex[p.slot] = Math.min(65535, m);
    slots.edgeZone[p.slot] = t0 < t1 && inEdge(t0) ? 1 : 0;
  }

  const { hashes, positions } = winnow(tokenIds(tok.tokens), { k, w });
  let pi = 0;
  for (let f = 0; f < hashes.length; f++) {
    const pos = positions[f];
    let slot = outsideSlot;
    if (pos >= b0 && pos < b1) {
      const off = tok.starts[pos];
      while (pi < passages.length && passages[pi].end_off <= off) pi++;
      const p = passages[pi];
      if (p && p.start_off <= off) slot = p.slot;
    }
    let isLex = 0;
    for (let j = pos, e = Math.min(n, pos + k); j < e; j++) if (lex[j] && j + lex[j] <= e) { isLex = 1; break; }
    records.push(hashes[f], slot * 4 + (inEdge(pos) ? EDGE_BIT : 0) + isLex);
    slots.fp[slot]++;
  }
  return n;
}

/**
 * Classify sorted fingerprint groups; adds each widespread group's occurrences to slots.bp or slots.cp.
 * @param {Uint32Array} hashes sorted (stable) by hash
 * @param {Uint32Array} refs
 * @param {number} n
 * @param {SlotTable} slots
 * @param {Uint8Array} countable 1 when a document counts toward document frequency (not a duplicate)
 * @param {{minDocs: number, groupEdgeShare: number}} p
 * @returns {{groups: number, widespread: number, boilerplate: number, commonplace: number}}
 */
export function classifyGroups(hashes, refs, n, slots, countable, { minDocs, groupEdgeShare }) {
  const stats = { groups: 0, widespread: 0, boilerplate: 0, commonplace: 0 };
  let i = 0;
  while (i < n) {
    const h = hashes[i];
    let j = i, occ = 0, edges = 0, lexes = 0, docs = 0, lastDoc = -1;
    while (j < n && hashes[j] === h) {
      const ref = refs[j];
      const d = slots.doc[ref >>> 2];
      if (countable[d]) {
        occ++;
        if (ref & EDGE_BIT) edges++;
        if (ref & LEX_BIT) lexes++;
        if (d !== lastDoc) { docs++; lastDoc = d; }
      }
      j++;
    }
    stats.groups++;
    if (docs > minDocs) {
      stats.widespread++;
      const boiler = edges >= groupEdgeShare * occ || lexes * 2 > occ;
      if (boiler) stats.boilerplate++; else stats.commonplace++;
      const target = boiler ? slots.bp : slots.cp;
      for (let r = i; r < j; r++) {
        const slot = refs[r] >>> 2;
        target[slot]++;
        if (!boiler && docs > slots.cpDocs[slot]) { slots.cpDocs[slot] = docs; slots.cpKey[slot] = h; }
      }
    }
    i = j;
  }
  return stats;
}

/**
 * Apply rules A, B and C to the slots (passage slots of one document are consecutive, in document order).
 * @param {SlotTable} slots
 * @param {number} used number of slots in use
 * @param {{passageShare: number, edgeLexicon: number}} p
 * @returns {{flagged: number[], byRule: {shared_text: number, licence_wording_at_edge: number, licence_block: number}}}
 */
export function decidePassages(slots, used, { passageShare, edgeLexicon }) {
  const flagged = [];
  const byRule = { shared_text: 0, licence_wording_at_edge: 0, licence_block: 0 };
  const isBp = new Uint8Array(used);
  for (let s = 0; s < used; s++) {
    if (slots.passage[s] < 0) continue;
    if (slots.quality[s] === Q_BOILERPLATE) { isBp[s] = 1; continue; }
    if (slots.quality[s] !== Q_OK) continue;
    if (slots.fp[s] > 0 && slots.bp[s] >= passageShare * slots.fp[s]) {
      isBp[s] = 1; flagged.push(s); byRule.shared_text++;
    } else if (slots.edgeZone[s] && slots.lex[s] >= edgeLexicon && slots.bp[s] >= 1) {
      isBp[s] = 1; flagged.push(s); byRule.licence_wording_at_edge++;
    }
  }
  // a neighbour that is another document's slot, or a document's outside slot, is the body edge
  const edgeOrBp = (s, t) => t < 0 || t >= used || slots.passage[t] < 0 || slots.doc[t] !== slots.doc[s] || isBp[t] === 1;
  for (let changed = true; changed;) {
    changed = false;
    for (let s = 0; s < used; s++) {
      if (slots.passage[s] < 0 || isBp[s] || slots.quality[s] !== Q_OK || !slots.edgeZone[s]) continue;
      if (!(slots.lex[s] >= 1 || slots.bp[s] >= 1)) continue;
      if (edgeOrBp(s, s - 1) && edgeOrBp(s, s + 1)) {
        isBp[s] = 1; flagged.push(s); byRule.licence_block++; changed = true;
      }
    }
  }
  return { flagged, byRule };
}

function scopeCollections(db, collections) {
  if (!collections || !collections.length) return null;
  const ids = [];
  for (const c of collections) {
    const row = typeof c === 'number' ? stmt(db, 'SELECT id FROM collection WHERE id = ?').get(c)
      : stmt(db, 'SELECT id FROM collection WHERE slug = ?').get(String(c));
    if (row) ids.push(row.id);
  }
  return ids;
}

/**
 * Ok passages of a scope that still contain the canary sentence (FTS phrase, accent-insensitive).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]|null} [collectionIds] null = every collection
 * @returns {number}
 */
export function canaryCount(db, collectionIds = null) {
  const phrase = `"${CANARY_TOKENS.join(' ')}"`;
  return stmt(db, `SELECT count(*) AS n FROM passage_fts f JOIN passage p ON p.id = f.rowid JOIN document d ON d.id = p.document_id
    WHERE passage_fts MATCH ? AND p.quality = 'ok' AND d.deleted_at IS NULL
      AND (? IS NULL OR d.collection_id IN (SELECT value FROM json_each(?)))`)
    .get(phrase, collectionIds ? 1 : null, JSON.stringify(collectionIds ?? [])).n;
}

/**
 * Flag boilerplate passages, rewrite doc_tokens and bump data_version (the 'boilerplate' job; run by the
 * Cipher bootstrap right after books load). Safe to call with a minimal ctx (or none) from scripts and tests.
 * @param {import('node:sqlite').DatabaseSync} db writable connection
 * @param {object} [ctx] TaskCtx: progress(), checkpoint(), startRun(), finishRun() are used when present
 * @param {{collections?: Array<string|number>|null, minDocs?: number, edge?: number, groupEdgeShare?: number,
 *   passageShare?: number, edgeLexicon?: number, k?: number, w?: number, dryRun?: boolean, explain?: number[]}} [opts]
 *   `explain` lists passage ids whose tallies are returned in metrics.explain
 * @returns {object} metrics: documents, tokens, fingerprints, groups, widespread, boilerplate/commonplace groups,
 *   passages flagged (by rule), documents affected, canary (ok passages still holding the licence sentence),
 *   run_id, data_version
 */
export function boilerplatePass(db, ctx = null, opts = {}) {
  const p = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts ?? {}).filter(([, v]) => v !== undefined)) };
  const started = Date.now();
  const scope = scopeCollections(db, p.collections);
  const scopeArgs = [scope ? 1 : null, JSON.stringify(scope ?? [])];
  const params = { k: p.k, w: p.w, min_docs: p.minDocs, edge: p.edge, group_edge_share: p.groupEdgeShare,
    passage_share: p.passageShare, edge_lexicon: p.edgeLexicon };
  const runId = ctx?.startRun ? ctx.startRun('boilerplate', { pipelineVersion: PIPELINE_VERSION, params,
    scope: { collections: p.collections ?? null } }) : null;

  const docs = stmt(db, `SELECT d.id, d.dup_of, t.body_start, t.body_end FROM document d JOIN document_text t ON t.document_id = d.id
    WHERE d.deleted_at IS NULL AND (? IS NULL OR d.collection_id IN (SELECT value FROM json_each(?))) ORDER BY d.id`).all(...scopeArgs);
  const size = stmt(db, `SELECT count(*) AS n, COALESCE(SUM(p.token_count), 0) AS t FROM passage p
    JOIN document_text x ON x.document_id = p.document_id JOIN document d ON d.id = p.document_id
    WHERE p.field = 'body' AND d.deleted_at IS NULL AND (? IS NULL OR d.collection_id IN (SELECT value FROM json_each(?)))`).get(...scopeArgs);

  // ── 1. fingerprints ──
  const slots = new SlotTable(size.n + docs.length);
  const countable = new Uint8Array(docs.length);
  const records = new Records(Math.ceil(size.t * 0.4));
  let used = 0, tokens = 0;
  const getText = stmt(db, 'SELECT original FROM document_text WHERE document_id = ?');
  const getPassages = stmt(db, "SELECT id, start_off, end_off, quality FROM passage WHERE document_id = ? AND field = 'body' ORDER BY start_off");
  for (let di = 0; di < docs.length; di++) {
    ctx?.checkpoint?.();
    const d = docs[di];
    countable[di] = d.dup_of === null ? 1 : 0;
    const passages = getPassages.all(d.id).map((row) => {
      const slot = used++;
      slots.passage[slot] = row.id;
      slots.doc[slot] = di;
      slots.quality[slot] = row.quality === 'ok' ? Q_OK : row.quality === 'boilerplate' ? Q_BOILERPLATE : Q_OTHER;
      return { start_off: row.start_off, end_off: row.end_off, slot };
    });
    const outsideSlot = used++;
    slots.doc[outsideSlot] = di;
    tokens += fingerprintDocument(getText.get(d.id).original, { bodyStart: d.body_start, bodyEnd: d.body_end, passages,
      outsideSlot, k: p.k, w: p.w, edge: p.edge }, records, slots);
    if (di % 25 === 0) ctx?.progress?.(0.8 * (di + 1) / docs.length, 'boilerplate', `fingerprints: ${di + 1} / ${docs.length} documents`);
  }

  // ── 2. groups ──
  ctx?.progress?.(0.82, 'boilerplate', `sorting ${records.n.toLocaleString('en-US')} fingerprints`);
  radixSortPairs(records.hashes, records.refs, records.n);
  ctx?.checkpoint?.();
  const groups = classifyGroups(records.hashes, records.refs, records.n, slots, countable, p);

  // ── 3. passages ──
  const { flagged, byRule } = decidePassages(slots, used, p);
  const commonplace = { passages: {}, groups: {} };
  for (let s = 0; s < used; s++) {
    if (slots.passage[s] < 0 || slots.fp[s] === 0 || slots.cp[s] < 0.5 * slots.fp[s]) continue;
    const key = slots.cpKey[s].toString(16).padStart(8, '0');
    commonplace.passages[slots.passage[s]] = { key, docs: slots.cpDocs[s] };
    const g = commonplace.groups[key] ??= { docs: slots.cpDocs[s], passages: [] };
    if (g.passages.length < 50) g.passages.push(slots.passage[s]);
  }
  const commonplacePassages = Object.keys(commonplace.passages).length;
  const explain = {};
  const explainIds = new Set((p.explain ?? []).map(Number));
  if (explainIds.size) {
    for (let s = 0; s < used; s++) {
      if (!explainIds.has(slots.passage[s])) continue;
      explain[slots.passage[s]] = { fingerprints: slots.fp[s], boilerplate: slots.bp[s], commonplace: slots.cp[s],
        lexicon: slots.lex[s], edge_zone: slots.edgeZone[s] === 1, flagged: flagged.includes(s) };
    }
  }
  ctx?.progress?.(0.9, 'boilerplate', `${flagged.length} passages are boilerplate`);
  ctx?.checkpoint?.();

  // ── 4. write ──
  const affected = new Set(flagged.map((s) => docs[slots.doc[s]].id));
  let version = null;
  if (!p.dryRun && flagged.length) {
    version = tx(db, () => {
      const upd = stmt(db, "UPDATE passage SET quality = 'boilerplate' WHERE id = ? AND quality = 'ok'");
      for (const s of flagged) upd.run(slots.passage[s]);
      rewriteDocTokens(db, affected);
      setMeta(db, 'quality_version', Number(getMeta(db, 'quality_version') ?? 0) + 1);
      return bumpDataVersion(db);
    });
  }
  const metrics = {
    documents: docs.length,
    duplicates_not_counted: docs.length - countable.reduce((a, b) => a + b, 0),
    tokens,
    fingerprints: records.n,
    ...groups,
    passages_flagged: p.dryRun ? 0 : flagged.length,
    passages_would_flag: flagged.length,
    flagged_by_rule: byRule,
    documents_affected: affected.size,
    commonplace_passages: commonplacePassages,
    canary_ok_passages: canaryCount(db, scope),
    params,
    dry_run: Boolean(p.dryRun),
    data_version: version,
    duration_ms: Date.now() - started,
    finished_at: nowIso(),
    ...(explainIds.size ? { explain } : {}),
  };
  if (!p.dryRun) writeCommonplaces({ run: runId, collections: p.collections ?? null, at: metrics.finished_at, ...commonplace });
  if (runId !== null) ctx.finishRun(runId, 'succeeded', { metrics });
  ctx?.progress?.(1, 'boilerplate', `boilerplate: ${metrics.passages_flagged} passages flagged in ${affected.size} documents`);
  return { run_id: runId, collections: p.collections ?? null, ...metrics };
}
