// OWNER: WP3
// tagindex.mjs — typeahead over the theme and maker labels of a corpus (M1 gate: theme suggestions were a LIKE scan over
// 285k doc_tag rows on every Cipher search — label_tri holds only 4,213 of the 15,287 theme values — and each maker
// candidate cost one counting query).
//
// Two label indexes per corpus, each a shared artifact (cache.sharedArtifact: built once per state of the corpus's
// inputs, persisted in $SCROLLS_DATA/cache/, loaded by every read worker):
//  · themes: each distinct theme tag with its document count and provenances, plus a trigram index over the folded
//    labels (15k labels on Cipher);
//  · makers: each document author or maker tag with its document count and slug (98k on Cipher; a substring scan of the
//    folded labels takes a few milliseconds, so it carries no postings).
// A query is folded like the labels (tokenize: tokens joined by one space) and matches a label whose folded form
// contains it; trigram postings only narrow the candidates. Suggestions never count occurrences (§4.4): `n` is the
// number of tagged documents. Request paths read an index only when it is ready (peekLabelIndex) and otherwise fall back
// to their SQL; warm.mjs builds them off the request path.

import { slugify } from '../../src/shared/ids.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { peekArtifact, sharedArtifact } from './cache.mjs';
import { corpusInputsKey } from './cube.mjs';

const MAGIC = 0x534c4932;   // 'SLI2'

const SCHEMES = {
  theme: {
    name: 'themes2', trigrams: true, slugs: false,
    sql: `SELECT t.value, count(DISTINCT t.document_id) AS n, group_concat(DISTINCT t.provenance) AS provs
      FROM doc_tag t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
      WHERE t.scheme = 'theme' AND c.corpus_id = ?1 AND c.modality <> 'lexical' AND d.deleted_at IS NULL GROUP BY t.value`,
  },
  // a maker is a document author or a maker tag; n = documents with either (what a maker strand pins)
  maker: {
    name: 'makers2', trigrams: false, slugs: true,
    sql: `SELECT name AS value, count(DISTINCT doc) AS n, NULL AS provs FROM (
        SELECT d.author AS name, d.id AS doc FROM document d JOIN collection c ON c.id = d.collection_id
          WHERE c.corpus_id = ?1 AND c.modality <> 'lexical' AND d.deleted_at IS NULL AND d.author IS NOT NULL
        UNION ALL
        SELECT t.value, t.document_id FROM doc_tag t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
          WHERE t.scheme = 'maker' AND c.corpus_id = ?1 AND c.modality <> 'lexical' AND d.deleted_at IS NULL)
      GROUP BY name`,
  },
};

/** Label schemes indexed for typeahead. */
export const LABEL_SCHEMES = Object.freeze(Object.keys(SCHEMES));

/** Folded form of a label or query: its tokens joined by single spaces. */
export const foldLabel = (s) => tokenize(String(s ?? '')).tokens.join(' ');

/** Distinct trigrams (by code point) of a folded string. */
function trigramsOf(s) {
  const cps = [...s];
  const out = new Set();
  for (let i = 0; i + 3 <= cps.length; i++) out.add(cps.slice(i, i + 3).join(''));
  return out;
}

/**
 * Build a label index from rows {value, n, provs}: labels ranked by n (then label), folded forms, and optionally slugs
 * and trigram postings (ids ascending, i.e. in rank order).
 * @param {Array<{value: string, n: number, provs?: string|null}>} rows
 * @param {{trigrams?: boolean, slugs?: boolean}} [opts]
 * @returns {{labels: string[], folded: string[], slugs: string[]|null, provs: string[], n: Int32Array, grams: string[]|null,
 *   offsets: Int32Array|null, postings: Int32Array|null}}
 */
export function buildLabelIndex(rows, { trigrams = true, slugs = false } = {}) {
  const sorted = rows.slice().sort((a, b) => b.n - a.n || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  const labels = sorted.map((r) => r.value);
  const folded = labels.map(foldLabel);
  const out = { labels, folded, slugs: slugs ? labels.map((l) => slugify(l)) : null, provs: sorted.map((r) => String(r.provs ?? '')),
    n: Int32Array.from(sorted, (r) => r.n), grams: null, offsets: null, postings: null };
  if (!trigrams) return out;
  const lists = new Map();
  folded.forEach((f, id) => { for (const g of trigramsOf(f)) { let l = lists.get(g); if (!l) lists.set(g, (l = [])); l.push(id); } });
  const grams = [...lists.keys()].sort();
  const offsets = new Int32Array(grams.length + 1);
  let total = 0;
  grams.forEach((g, i) => { offsets[i] = total; total += lists.get(g).length; });
  offsets[grams.length] = total;
  const postings = new Int32Array(total);
  grams.forEach((g, i) => postings.set(lists.get(g), offsets[i]));
  return { ...out, grams, offsets, postings };
}

const STRING_LISTS = ['labels', 'folded', 'slugs', 'provs', 'grams'];

/**
 * Binary form: magic, header length, JSON header (layout), then each string list as UTF-8 joined by NUL (labels
 * never contain one; splitting a 98k-name list is ~10× faster than JSON.parse of it), then the typed arrays.
 */
export function encodeLabelIndex(x) {
  const parts = [];
  const layout = { strings: {}, arrays: {} };
  let offset = 0;
  for (const k of STRING_LISTS) {
    if (!x[k]) continue;
    const bytes = Buffer.from(x[k].join('\0'), 'utf8');
    layout.strings[k] = { offset, bytes: bytes.length, count: x[k].length };
    parts.push(bytes);
    offset += bytes.length;
  }
  offset = Math.ceil(offset / 4) * 4;
  const arraysAt = offset;
  for (const [k, a] of Object.entries({ n: x.n, offsets: x.offsets, postings: x.postings })) {
    if (!a) continue;
    layout.arrays[k] = { offset: offset - arraysAt, length: a.length };
    offset += a.byteLength;
  }
  layout.arraysAt = arraysAt;
  const head = Buffer.from(JSON.stringify(layout));
  const start = Math.ceil((8 + head.length) / 4) * 4;
  const out = new Uint8Array(start + offset);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, head.length, true);
  out.set(head, 8);
  let o = start;
  for (const b of parts) { out.set(b, o); o += b.length; }
  for (const [k, a] of Object.entries({ n: x.n, offsets: x.offsets, postings: x.postings })) {
    if (a) out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), start + arraysAt + layout.arrays[k].offset);
  }
  return out;
}

/** @param {Uint8Array} bytes @returns {object} the index @throws {Error} on a foreign or truncated file */
export function decodeLabelIndex(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || buf.readUInt32LE(0) !== MAGIC) throw new Error('not a label index');
  const len = buf.readUInt32LE(4);
  const layout = JSON.parse(buf.toString('utf8', 8, 8 + len));
  const start = Math.ceil((8 + len) / 4) * 4;
  const out = { labels: null, folded: null, slugs: null, provs: null, grams: null, n: null, offsets: null, postings: null };
  for (const [k, { offset, bytes: n, count }] of Object.entries(layout.strings)) {
    if (start + offset + n > buf.length) throw new Error('truncated label index');
    out[k] = count ? buf.toString('utf8', start + offset, start + offset + n).split('\0') : [];
  }
  const body = new Uint8Array(buf.length - start - layout.arraysAt);
  body.set(buf.subarray(start + layout.arraysAt));
  for (const [k, { offset, length }] of Object.entries(layout.arrays)) {
    if (offset + length * 4 > body.byteLength) throw new Error('truncated label index');
    out[k] = new Int32Array(body.buffer, offset, length);
  }
  return out;
}

/** The sharedArtifact spec of a corpus's label index of a scheme (warm.mjs ensures it). */
export function labelIndexSpec(corpusId, scheme) {
  const s = SCHEMES[scheme];
  if (!s) throw new RangeError(`unknown label scheme '${scheme}'`);
  // keyed by the collections the index reads (not lexical entries), so tracking a word after a Wiktionary load keeps it
  return { name: `${s.name}-c${corpusId}`, key: (d) => corpusInputsKey(d, corpusId, { scope: 'labels' }), encode: encodeLabelIndex, decode: decodeLabelIndex,
    build: (d) => buildLabelIndex(d.prepare(s.sql).all(corpusId), { trigrams: s.trigrams, slugs: s.slugs }) };
}

/**
 * The label index of a corpus (memory → cache file → one scan; builds when missing).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} corpusId
 * @param {'theme'|'maker'} scheme
 * @returns {object}
 */
export function labelIndex(db, corpusId, scheme) {
  return sharedArtifact(db, labelIndexSpec(corpusId, scheme));
}

/**
 * The label index of a corpus when it is ready (in memory or in the cache), else null — never builds: request paths
 * fall back to their SQL while warm.mjs builds it.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} corpusId
 * @param {'theme'|'maker'} scheme
 * @returns {object|null}
 */
export function peekLabelIndex(db, corpusId, scheme) {
  return peekArtifact(db, labelIndexSpec(corpusId, scheme));
}

function postingsOf(x, gram) {
  let lo = 0, hi = x.grams.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const g = x.grams[mid];
    if (g === gram) return x.postings.subarray(x.offsets[mid], x.offsets[mid + 1]);
    if (g < gram) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

/**
 * Labels whose folded form contains the folded query, most-tagged first.
 * @param {object|null} x a label index
 * @param {string} query raw or folded text
 * @param {{limit?: number}} [opts]
 * @returns {Array<{value: string, n: number, provenance: string[]}>}
 */
export function findLabels(x, query, { limit = 5 } = {}) {
  const q = foldLabel(query);
  if (!x || !q) return [];
  let candidates = null;   // null: every label (no postings, or a one- or two-character query)
  const grams = x.grams ? [...trigramsOf(q)] : [];
  for (const g of grams) {
    const p = postingsOf(x, g);
    if (!p) return [];
    if (!candidates || p.length < candidates.length) candidates = p;   // the rarest trigram bounds the candidates
  }
  const out = [];
  const total = candidates ? candidates.length : x.labels.length;
  for (let k = 0; k < total && out.length < limit; k++) {
    const id = candidates ? candidates[k] : k;
    if (!x.folded[id].includes(q)) continue;
    out.push({ value: x.labels[id], n: x.n[id], provenance: x.provs[id] ? x.provs[id].split(',') : [] });
  }
  return out;
}

/**
 * Labels named by a ref: the exact label, or a label whose slug (ids.slugify) equals it — how a maker strand is pinned
 * (search suggests `maker:<slug>`).
 * @param {object} x a label index built with slugs
 * @param {string} ref
 * @returns {string[]} sorted
 */
export function labelsForRef(x, ref) {
  const out = [];
  for (let i = 0; i < x.labels.length; i++) if (x.labels[i] === ref || x.slugs?.[i] === ref) out.push(x.labels[i]);
  return out.sort();
}
