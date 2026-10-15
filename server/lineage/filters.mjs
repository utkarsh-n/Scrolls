// OWNER: WP5
// filters.mjs — what shared wording is NOT a quotation (SPEC §4.7, §13 rules 6 and 9). Each filter is counted in the
// run's metrics, with samples, so the exclusions stay visible:
//
//  · structure — a run made of numbering or layout (tables of contents "I II III … XIV", "Chapter I Chapter II …",
//    box rules): fewer than 4 distinct tokens, one token over 40% of the run, fewer than 2 content words, or at
//    least half numerals; and lists of names or titles (≥ 60% capitalised words: a series catalogue, an index of
//    characters);
//  · production-line text — wording that a production line puts into many files at the same place: transcriber's
//    and editor's notes, publisher's advertisements, licence preambles, series addenda. A fingerprint group is
//    *production* when its hash occurs in ≥ 3 documents and ≥ 80% of its occurrences lie in the first or last 15% of
//    their documents (the §4.7 edge zones; a text under 1,000 tokens has none); a verified run is production-line when
//    ≥ 50% of its stable fingerprints are (those chosen by windows wholly inside the run, see stableFlagShare).
//    Groups of more than 25 documents (boilerplate or commonplace, §4.7) are *widespread*; a run made mostly of them
//    belongs to the "widely shared text" node, never to a pair;
//  · same work — editions of one work (same folded author, title trigram similarity ≥ 0.6, document MinHash
//    Jaccard ≥ 0.5; §4.7, W_NEAR_DUP);
//  · reprints — one text reprints most of the other (a collected edition containing a play, an anthology): the pair
//    shares ≥ 2,000 tokens (exact runs plus near-aligned sentences, so a modernised spelling still counts) covering
//    ≥ 30% of the shorter text. A long quotation stays a quotation; a whole book is an edition, not a quotation.
// Near quotations have a further gate of their own (lineage/near.mjs acceptNear: ≥ 10 aligned tokens, ≥ 3 content words).

import { tokenize } from '../../src/shared/tokenize.mjs';
import { stmt } from '../db/open.mjs';
import { minhashJaccard } from '../store/document-writer.mjs';
import { stopwords } from '../text/langid.mjs';
import { shingleHashes, tokenId } from './winnow.mjs';

/** Production-line thresholds (see the header). */
export const PRODUCTION = Object.freeze({ minDocs: 3, edgeShare: 0.8, runShare: 0.5, edge: 0.15, minDocTokens: 1000 });
/** Reprint thresholds (see the header). */
export const REPRINT = Object.freeze({ minTokens: 2000, share: 0.3 });

const STOP_LANGS = ['en', 'fr', 'es', 'de', 'la', 'it', 'pt', 'hi', 'gu'];
/** Pieces of contractions the tokenizer splits off ("don't" → don + t), and single letters: never content words. */
const FRAGMENTS = ['don', 'didn', 'doesn', 'isn', 'wasn', 'weren', 'aren', 'couldn', 'wouldn', 'shouldn', 'won', 'hasn', 'haven', 'hadn',
  'mustn', 'needn', 'ain', 'll', 're', 've', 'em'];
/** Share of capitalised words at which a run is a list of names or titles (an index, a cast list, a series catalogue). */
export const LIST_CAPITALS = 0.6;
const ROMAN = /^m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;

/**
 * Whether a folded token is numbering rather than wording: digits, or a roman numeral.
 * @param {string} token
 * @returns {boolean}
 */
export function isNumeral(token) {
  return /^\p{N}+$/u.test(token) || (token.length > 0 && ROMAN.test(token));
}

let stopIdSet = null;
/** Token ids of the function words of every stop-list language. */
export function stopIds() {
  stopIdSet ??= new Set([...STOP_LANGS.flatMap((l) => stopwords(l)), ...FRAGMENTS].map((w) => tokenId(w)));
  return stopIdSet;
}

/**
 * Classifies token ids as numerals while a corpus is read (ids are hashes, so the class is learnt from the strings).
 */
export class TokenClasses {
  constructor() { this.numerals = new Set(); }
  /** Note a token string and its id (single letters count with the numerals: neither is wording). */
  see(token, id) { if (isNumeral(token) || [...token].length === 1) this.numerals.add(id); }
}

/**
 * Whether a stretch of original text is a list of names or titles rather than wording: at least 60% of its words
 * start with a capital letter (scripts without case never qualify). Series catalogues ("The Muse of the Department A
 * Prince of Bohemia A Man of Business …") and indexes of characters are shared by the books of one edition.
 * @param {string} text
 * @returns {boolean}
 */
export function isNameList(text) {
  const tk = tokenize(text);
  const n = tk.tokens.length;
  if (n < 4) return false;
  let caps = 0;
  for (let i = 0; i < n; i++) if (/^\p{Lu}/u.test(text.slice(tk.starts[i], tk.starts[i] + 2))) caps++;
  return caps >= LIST_CAPITALS * n;
}

/**
 * Whether ids[a0, a1) carries wording rather than structure.
 * @param {Uint32Array} ids
 * @param {number} a0
 * @param {number} a1
 * @param {TokenClasses|null} classes numeral ids (null: numerals are not recognised)
 * @returns {boolean}
 */
export function informative(ids, a0, a1, classes = null) {
  const stop = stopIds();
  const freq = new Map();
  let max = 0, content = 0, numerals = 0;
  for (let i = a0; i < a1; i++) {
    const id = ids[i];
    const n = (freq.get(id) ?? 0) + 1;
    freq.set(id, n);
    if (n > max) max = n;
    if (classes?.numerals.has(id)) numerals++;
    else if (!stop.has(id)) content++;
  }
  const len = a1 - a0;
  return freq.size >= 4 && max <= 0.4 * len && content >= 2 && numerals * 2 < len;
}

/**
 * Number of content tokens (neither function words nor numerals) in ids[a0, a1).
 * @returns {number}
 */
export function contentTokens(ids, a0, a1, classes = null) {
  const stop = stopIds();
  let n = 0;
  for (let i = a0; i < a1; i++) if (!stop.has(ids[i]) && !classes?.numerals.has(ids[i])) n++;
  return n;
}

/**
 * Whether token position `pos` of a document of `len` tokens lies in its first or last `edge` share. A text of fewer
 * than 1,000 tokens has no front or back matter to speak of: no position in it is an edge.
 * @param {number} pos
 * @param {number} len
 * @param {number} [edge]
 * @returns {boolean}
 */
export function inEdgeZone(pos, len, edge = PRODUCTION.edge) {
  return len >= PRODUCTION.minDocTokens && (pos < edge * len || pos >= (1 - edge) * len);
}

/**
 * Of the fingerprints that are the minimum of a winnowing window lying wholly inside the run [a0, a1) of one
 * document, how many carry a flag. Those fingerprints are selected in every document holding the same words, so
 * their groups count the documents that share the text; fingerprints near the run's ends are chosen by neighbouring
 * words and may be missing elsewhere. The document's fingerprints are records lo…hi−1 with ascending positions.
 * @param {Uint32Array} ids the document's token ids
 * @param {number} a0 run start (token index within the document)
 * @param {number} a1 run end (exclusive)
 * @param {{positions: Uint32Array, flags: Uint8Array, lo: number, hi: number, k: number, w: number, mask: number}} fp
 * @returns {{total: number, flagged: number}}
 */
export function stableFlagShare(ids, a0, a1, { positions, flags, lo, hi, k, w, mask }) {
  const h = shingleHashes(ids.subarray(a0, a1), k);
  const picked = new Set();
  for (let s = 0; s + w <= h.length; s++) {
    let m = s;
    for (let j = s + 1; j < s + w; j++) if (h[j] <= h[m]) m = j;
    picked.add(a0 + m);
  }
  let total = 0, flagged = 0;
  for (const pos of picked) {
    let l = lo, r = hi;
    while (l < r) { const mid = (l + r) >>> 1; if (positions[mid] < pos) l = mid + 1; else r = mid; }
    if (l >= hi || positions[l] !== pos) continue;
    total++;
    if (flags[l] & mask) flagged++;
  }
  return { total, flagged };
}

/**
 * Tokens covered by the union of runs on one side.
 * @param {Array<{a0: number, a1: number, b0: number, b1: number}>} runs
 * @param {'a'|'b'} side
 * @returns {number}
 */
export function coveredTokens(runs, side) {
  const iv = runs.map((r) => (side === 'a' ? [r.a0, r.a1] : [r.b0, r.b1])).sort((x, y) => x[0] - y[0]);
  let covered = 0, end = -Infinity;
  for (const [s, e] of iv) {
    if (e <= end) continue;
    covered += e - Math.max(s, end);
    end = e;
  }
  return covered;
}

/**
 * Whether two documents' shared runs make one a reprint of the other (an edition or a collection).
 * @param {number} shared tokens covered on the shorter document's side
 * @param {number} shorter token count of the shorter document
 * @returns {boolean}
 */
export function isReprint(shared, shorter) {
  return shared >= REPRINT.minTokens && shared >= REPRINT.share * shorter;
}

const fold = (s) => tokenize(String(s ?? '').replace(/\([^)]*\)/g, ' ')).tokens.join(' ');
function trigrams(s) {
  const t = ` ${fold(s)} `;
  const set = new Set();
  for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
  return set;
}
function setJaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return a.size + b.size - inter ? inter / (a.size + b.size - inter) : 0;
}

/**
 * Same work in another edition (§4.7): same folded author, title trigram similarity ≥ 0.6, document MinHash
 * Jaccard ≥ 0.5 (W_NEAR_DUP, not a quotation). Results are cached per pair; check.count() reports the positives.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {((a: object, b: object) => boolean) & {count: () => number, samples: () => string[]}}
 */
export function sameWorkChecker(db) {
  const sigs = new Map(), pairs = new Map();
  const sig = (id) => {
    if (!sigs.has(id)) {
      const r = stmt(db, 'SELECT sig FROM doc_minhash WHERE document_id = ?').get(id);
      sigs.set(id, r ? new Uint32Array(r.sig.buffer.slice(r.sig.byteOffset, r.sig.byteOffset + r.sig.byteLength)) : null);
    }
    return sigs.get(id);
  };
  const samples = [];
  const check = (a, b) => {
    const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
    if (!pairs.has(key)) {
      let same = false;
      if (a.author && b.author && fold(a.author) === fold(b.author) && setJaccard(trigrams(a.title), trigrams(b.title)) >= 0.6) {
        const sa = sig(a.id), sb = sig(b.id);
        same = Boolean(sa && sb && minhashJaccard(sa, sb) >= 0.5);
      }
      pairs.set(key, same);
      if (same && samples.length < 10) samples.push(`${a.title} ≡ ${b.title}`);
    }
    return pairs.get(key);
  };
  check.count = () => [...pairs.values()].filter(Boolean).length;
  check.samples = () => samples;
  return check;
}

/**
 * A bounded list of examples per exclusion kind, for the run's metrics (so exclusions can be inspected).
 */
export class ExclusionLog {
  constructor(max = 12) { this.max = max; this.items = {}; }
  /**
   * @param {string} kind
   * @param {string} text
   * @param {object} [extra]
   */
  add(kind, text, extra = {}) {
    const list = this.items[kind] ??= [];
    const t = String(text).replace(/\s+/g, ' ').trim().slice(0, 160);
    if (list.length < this.max && !list.some((x) => x.text === t)) list.push({ text: t, ...extra });
  }
}
