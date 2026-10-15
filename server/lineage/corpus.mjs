// OWNER: WP5
// corpus.mjs — the token stream of a reuse-index scope (SPEC §4.7): every quality='ok' text/abstract passage of the
// scope's live, non-duplicate documents, as one array of u32 token ids (4 bytes per token), with tables mapping a
// token back to its passage and document. Sentence units for near quotations are kept in typed arrays too. Character
// offsets are recomputed per passage (re-tokenizing it) only where a link is written.

import { tokenize } from '../../src/shared/tokenize.mjs';
import { stmt } from '../db/open.mjs';
import { DOC_COLUMNS } from './classify.mjs';
import { TokenClasses } from './filters.mjs';
import { unitsOf } from './minhash.mjs';
import { radixSortPairs, tokenId } from './winnow.mjs';

/** Characters of document text kept in the corpus's text cache (≈ 128 MB). */
const TEXT_CACHE_CHARS = 64_000_000;

/** Columnar store of u32 (or other typed) records that doubles its capacity when full. */
export class Growable {
  /**
   * @param {number} columns number of columns
   * @param {number} [capacity]
   * @param {Function} [Type] typed-array constructor of every column
   */
  constructor(columns, capacity = 4096, Type = Uint32Array) {
    this.n = 0;
    this.Type = Type;
    this.cols = Array.from({ length: columns }, () => new Type(Math.max(16, capacity)));
  }
  push(...vals) {
    if (this.n === this.cols[0].length) {
      this.cols = this.cols.map((c) => { const d = new this.Type(c.length * 2); d.set(c); return d; });
    }
    for (let i = 0; i < vals.length; i++) this.cols[i][this.n] = vals[i];
    this.n++;
  }
}

/**
 * Indices 0…n−1 ordered by (major, minor), using two stable radix passes.
 * @param {Uint32Array} major
 * @param {Uint32Array} minor
 * @param {number} n
 * @returns {Uint32Array}
 */
export function orderBy(major, minor, n) {
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const k1 = minor.slice(0, n);
  radixSortPairs(k1, idx, n);
  const k2 = new Uint32Array(n);
  for (let i = 0; i < n; i++) k2[i] = major[idx[i]];
  radixSortPairs(k2, idx, n);
  return idx;
}

/**
 * Collection ids of a scope given by slugs or ids (null = every collection).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<string|number>|null} collections
 * @returns {number[]|null}
 */
export function scopeCollectionIds(db, collections) {
  if (!collections || !collections.length) return null;
  return collections.map((c) => stmt(db, 'SELECT id FROM collection WHERE slug = ? OR CAST(id AS TEXT) = ?').get(String(c), String(c))?.id)
    .filter(Boolean);
}

/**
 * Documents of a scope that have ok text, and the scope's ok token total.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]|null} scopeIds
 * @returns {{docs: object[], tokens: number}}
 */
export function scopeDocuments(db, scopeIds) {
  const args = [scopeIds ? 1 : null, JSON.stringify(scopeIds ?? [])];
  const docs = stmt(db, `SELECT ${DOC_COLUMNS} FROM document d WHERE d.deleted_at IS NULL AND d.dup_of IS NULL
      AND (? IS NULL OR d.collection_id IN (SELECT value FROM json_each(?)))
      AND EXISTS (SELECT 1 FROM passage p WHERE p.document_id = d.id AND p.quality = 'ok' AND p.field_class IN ('text', 'abstract'))
    ORDER BY d.id`).all(...args);
  const tokens = stmt(db, `SELECT COALESCE(SUM(p.token_count), 0) AS n FROM passage p JOIN document d ON d.id = p.document_id
    WHERE p.quality = 'ok' AND p.field_class IN ('text', 'abstract') AND d.deleted_at IS NULL AND d.dup_of IS NULL
      AND (? IS NULL OR d.collection_id IN (SELECT value FROM json_each(?)))`).get(...args).n;
  return { docs, tokens };
}

/**
 * The scope's ok text as one token-id array. Load documents in order with load(di).
 */
export class ScopeCorpus {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {object[]} docs rows with DOC_COLUMNS
   * @param {number} totalTokens capacity hint
   * @param {{units?: boolean, maxUnits?: number}} [opts] collect sentence units (near quotations) up to maxUnits
   */
  constructor(db, docs, totalTokens, { units = false, maxUnits = Infinity } = {}) {
    this.db = db;
    this.docs = docs;
    this.ids = new Uint32Array(Math.max(1, totalTokens));
    this.docStart = new Uint32Array(docs.length + 1);
    this.docPassages = new Uint32Array(docs.length + 1); // index range of each document's passages
    this.passages = []; // {id, doc, field, start_off, end_off, unit, t0, t1} in stream order
    this.pStart = [];
    // sentence units: document index, global token range
    this.units = units ? new Growable(3, Math.max(1024, Math.ceil(totalTokens / 16))) : null;
    this.maxUnits = maxUnits;
    this.unitsOverflow = false;
    this.n = 0;
    this.textCache = new Map();
    this.textChars = 0;
    this.tokCache = new Map();
    this.tokenIdCache = new Map();
    this.classes = new TokenClasses();
  }

  /** Number of sentence units collected. */
  get unitCount() { return this.units ? this.units.n : 0; }

  /**
   * A document field's text (LRU cache bounded by characters, so random access over a large scope stays cheap).
   * @returns {{text: string, sha: string|null}}
   */
  text(docId, field) {
    const key = `${docId}:${field}`;
    let t = this.textCache.get(key);
    if (t) {
      this.textCache.delete(key);
      this.textCache.set(key, t);
      return t;
    }
    t = field === 'body'
      ? stmt(this.db, 'SELECT original AS text, original_sha256 AS sha FROM document_text WHERE document_id = ?').get(docId)
      : stmt(this.db, 'SELECT value AS text, NULL AS sha FROM document_field WHERE document_id = ? AND field = ?').get(docId, field);
    t ??= { text: '', sha: null };
    this.textCache.set(key, t);
    this.textChars += t.text.length;
    while (this.textCache.size > 1 && this.textChars > TEXT_CACHE_CHARS) {
      const [oldest, v] = this.textCache.entries().next().value;
      this.textCache.delete(oldest);
      this.textChars -= v.text.length;
    }
    return t;
  }

  id(token) {
    let v = this.tokenIdCache.get(token);
    if (v === undefined) {
      v = tokenId(token);
      this.classes.see(token, v);
      if (this.tokenIdCache.size < 500_000) this.tokenIdCache.set(token, v);
    }
    return v;
  }

  /**
   * Append document di.
   * @param {number} di
   * @returns {number} its token count
   */
  load(di) {
    const doc = this.docs[di];
    this.docStart[di] = this.n;
    this.docPassages[di] = this.passages.length;
    const rows = stmt(this.db, `SELECT id, field, start_off, end_off, unit FROM passage WHERE document_id = ? AND quality = 'ok'
      AND field_class IN ('text', 'abstract') ORDER BY field = 'body' DESC, field, start_off`).all(doc.id);
    for (const p of rows) {
      const local = this.text(doc.id, p.field).text.slice(p.start_off, p.end_off);
      const tk = tokenize(local);
      if (this.n + tk.tokens.length > this.ids.length) {
        const grown = new Uint32Array(Math.ceil((this.n + tk.tokens.length) * 1.25));
        grown.set(this.ids.subarray(0, this.n));
        this.ids = grown;
      }
      const t0 = this.n;
      for (const t of tk.tokens) this.ids[this.n++] = this.id(t);
      this.passages.push({ id: p.id, doc: di, field: p.field, start_off: p.start_off, end_off: p.end_off, unit: p.unit, t0, t1: this.n });
      this.pStart.push(t0);
      if (this.units && !this.unitsOverflow) {
        for (const u of unitsOf(local, tk, { verse: p.unit === 'stanza' })) this.units.push(di, t0 + u.t0, t0 + u.t1);
        if (this.units.n > this.maxUnits) this.unitsOverflow = true;
      }
    }
    this.docStart[di + 1] = this.n;
    this.docPassages[di + 1] = this.passages.length;
    return this.n - this.docStart[di];
  }

  /** Token ids of document di. */
  docIds(di) { return this.ids.subarray(this.docStart[di], this.docStart[di + 1]); }

  /** Token count of document di. */
  docLength(di) { return this.docStart[di + 1] - this.docStart[di]; }

  /** Index (into this.passages) of the passage holding global token g. */
  passageIndexAt(g) {
    let lo = 0, hi = this.pStart.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.pStart[mid] <= g) lo = mid + 1; else hi = mid; }
    return lo - 1;
  }

  /** Passage record of global token g. */
  passageAt(g) { return this.passages[this.passageIndexAt(g)]; }

  /** Tokenization of a passage's text (cached), for character offsets. */
  passageTokens(p) {
    let tk = this.tokCache.get(p.id);
    if (!tk) {
      tk = tokenize(this.text(this.docs[p.doc].id, p.field).text.slice(p.start_off, p.end_off));
      this.tokCache.set(p.id, tk);
      if (this.tokCache.size > 4096) this.tokCache.delete(this.tokCache.keys().next().value);
    }
    return tk;
  }

  /**
   * Evidence span of the global token run [g0, g1) (within one field), for insertAlgorithmRelationship.
   * @returns {{passage: number, field: string, start: number, end: number, text: string, sha: string|null, doc: object}}
   */
  span(g0, g1) {
    const p0 = this.passageAt(g0), p1 = this.passageAt(g1 - 1);
    const tk0 = this.passageTokens(p0), tk1 = this.passageTokens(p1);
    const doc = this.docs[p0.doc];
    const t = this.text(doc.id, p0.field);
    return { passage: p0.id, field: p0.field, start: p0.start_off + tk0.starts[g0 - p0.t0], end: p1.start_off + tk1.ends[g1 - 1 - p1.t0],
      text: t.text, sha: t.sha, doc };
  }

  /** Global token index of the first token of document di's `field` at or after character offset `off` (null if none). */
  tokenAtOffset(di, field, off) {
    for (let i = this.docPassages[di]; i < this.docPassages[di + 1]; i++) {
      const p = this.passages[i];
      if (p.field !== field || p.end_off <= off) continue;
      const tk = this.passageTokens(p);
      for (let j = 0; j < tk.starts.length; j++) if (p.start_off + tk.starts[j] >= off) return p.t0 + j;
    }
    return null;
  }
}
