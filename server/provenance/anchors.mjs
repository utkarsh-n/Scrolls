// OWNER: WP5
// anchors.mjs — durable anchors for annotations and evidence spans (SPEC D18):
//   { doc_id, sha256, field, start, end, quote, prefix (≤ 32), suffix (≤ 32) }
// Offsets are UTF-16 code units (D4) into document_text.original (field 'body') or document_field.value (any
// other field) — never passage-relative — so re-segmentation or an ICU upgrade cannot orphan an interpretation.
// Resolution order: exact (same text, same offsets) → offsets (quote still at its offsets) → quote (unique
// verbatim match) → context (several matches, chosen by prefix/suffix agreement) → normalized (whitespace and
// line endings collapsed) → orphaned (null; reported, never silently dropped).

import { createHash } from 'node:crypto';
import { PASSAGE_FIELDS } from '../../src/shared/vocab.mjs';
import { stmt, tx } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';

/** Characters of context kept on each side of an anchor. */
export const ANCHOR_CONTEXT = 32;

/** sha256 hex of a string's UTF-8 bytes (document_text.original_sha256 uses the same rule). */
export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

const invalid = (message, hint = null, detail = {}) =>
  new HttpError(400, 'E_VALIDATION', message, hint, { field: 'anchor', ...detail });

/**
 * Anchor for a span of a document field.
 * @param {string} original the full text the offsets index (document body or field value)
 * @param {{field: string, start: number, end: number}} span UTF-16 offsets, start < end
 * @param {{docId?: number|null, sha?: string|null}} [opts] sha defaults to sha256(original)
 * @returns {{doc_id: number|null, sha256: string, field: string, start: number, end: number, quote: string,
 *   prefix: string, suffix: string}}
 * @throws {RangeError} when the span is empty or outside the text
 */
export function makeAnchor(original, { field, start, end }, { docId = null, sha = null } = {}) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > original.length || start >= end) {
    throw new RangeError(`makeAnchor: span ${start}–${end} is empty or outside the text (length ${original.length})`);
  }
  return {
    doc_id: docId,
    sha256: sha ?? sha256(original),
    field,
    start,
    end,
    quote: original.slice(start, end),
    prefix: original.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
    suffix: original.slice(end, end + ANCHOR_CONTEXT),
  };
}

// ── resolution ──────────────────────────────────────────────────────────────────────────────────────

function allIndexes(hay, needle) {
  const out = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** Characters shared at the end of a and b. */
function commonSuffix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Characters shared at the start of a and b. */
function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** The candidate start whose surroundings agree best with the anchor's prefix/suffix (ties: nearest old start). */
function bestByContext(text, candidates, anchor, len) {
  let best = null;
  for (const c of candidates) {
    const score = commonSuffix(text.slice(Math.max(0, c - ANCHOR_CONTEXT), c), anchor.prefix ?? '') +
      commonPrefix(text.slice(c + len, c + len + ANCHOR_CONTEXT), anchor.suffix ?? '');
    const dist = Math.abs(c - (anchor.start ?? 0));
    if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { start: c, score, dist, tie: false };
    else if (score === best.score && dist === best.dist) best.tie = true;
  }
  return best;
}

const WS = /\s/u;

/** Collapse every whitespace run to one space; map[i] = original index of normalized char i. */
function collapseWhitespace(s) {
  let out = '';
  const map = [];
  let prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (WS.test(c)) {
      if (!prevSpace) { out += ' '; map.push(i); }
      prevSpace = true;
    } else {
      out += c;
      map.push(i);
      prevSpace = false;
    }
  }
  return { text: out, map };
}

/**
 * Re-locate an anchor in a (possibly changed) text.
 * @param {string} original the current text of the anchor's field
 * @param {{sha256?: string, start: number, end: number, quote: string, prefix?: string, suffix?: string}} anchor
 * @param {{sha?: string|null}} [opts] the current text's sha256, when known (saves hashing a large text)
 * @returns {{start: number, end: number, method: 'exact'|'offsets'|'quote'|'context'|'normalized', ambiguous: boolean}|null}
 *   null when the quoted words cannot be found: the anchor is orphaned
 */
export function resolveAnchor(original, anchor, { sha = null } = {}) {
  const quote = anchor?.quote;
  if (typeof original !== 'string' || typeof quote !== 'string' || quote.length === 0) return null;
  const { start, end } = anchor;
  if (Number.isInteger(start) && Number.isInteger(end) && original.slice(start, end) === quote) {
    const same = anchor.sha256 && (sha ?? sha256(original)) === anchor.sha256;
    return { start, end, method: same ? 'exact' : 'offsets', ambiguous: false };
  }
  const hits = allIndexes(original, quote);
  if (hits.length === 1) return { start: hits[0], end: hits[0] + quote.length, method: 'quote', ambiguous: false };
  if (hits.length > 1) {
    const b = bestByContext(original, hits, anchor, quote.length);
    return { start: b.start, end: b.start + quote.length, method: 'context', ambiguous: b.tie || b.score === 0 };
  }
  // whitespace and line endings may differ (CRLF → LF, re-wrapped lines, NBSP)
  const q = collapseWhitespace(quote.trim()).text;
  if (!q) return null;
  const norm = collapseWhitespace(original);
  const nHits = allIndexes(norm.text, q);
  if (!nHits.length) return null;
  const toOrig = (i) => ({ start: norm.map[i], end: norm.map[i + q.length - 1] + 1 });
  if (nHits.length === 1) return { ...toOrig(nHits[0]), method: 'normalized', ambiguous: false };
  const b = bestByContext(original, nHits.map((i) => norm.map[i]), anchor, quote.length);
  const i = nHits[nHits.map((h) => norm.map[h]).indexOf(b.start)];
  return { ...toOrig(i), method: 'normalized', ambiguous: b.tie || b.score === 0 };
}

// ── texts and passages ──────────────────────────────────────────────────────────────────────────────

/**
 * The text an anchor's offsets index: document_text.original for 'body', document_field.value otherwise.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} docId
 * @param {string} field
 * @returns {{text: string, sha: string}|null}
 */
export function loadFieldText(db, docId, field) {
  if (field === 'body') {
    const t = stmt(db, 'SELECT original, original_sha256 FROM document_text WHERE document_id = ?').get(docId);
    return t ? { text: t.original, sha: t.original_sha256 } : null;
  }
  const f = stmt(db, 'SELECT value FROM document_field WHERE document_id = ? AND field = ?').get(docId, field);
  return f ? { text: f.value, sha: sha256(f.value) } : null;
}

/**
 * The passage of a document field that contains [start, end); when no single passage does (the span crosses a
 * passage boundary), the passage containing `start`, with `split: true`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{id: number, start_off: number, end_off: number, split: boolean}|null}
 */
export function passageFor(db, docId, field, start, end) {
  const inside = stmt(db, `SELECT id, start_off, end_off FROM passage WHERE document_id = ? AND field = ?
    AND start_off <= ? AND end_off >= ? ORDER BY start_off DESC LIMIT 1`).get(docId, field, start, end);
  if (inside) return { ...inside, split: false };
  const first = stmt(db, `SELECT id, start_off, end_off FROM passage WHERE document_id = ? AND field = ?
    AND start_off <= ? AND end_off > ? ORDER BY start_off DESC LIMIT 1`).get(docId, field, start, start);
  return first ? { ...first, split: true } : null;
}

/**
 * Check an anchor sent by a client and return the server's anchor (prefix/suffix recomputed). A stale anchor
 * (other text version, or offsets that do not hold) is re-located by its quote; one that cannot be found is
 * refused.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input {doc_id, sha256, field, start, end, quote}
 * @param {{docId?: number|null, passage?: {id: number, document_id: number, field: string, start_off: number, end_off: number}|null}} [expect]
 * @returns {{anchor: object, relocated: string|null}} relocated = resolution method when the offsets were corrected
 * @throws {HttpError} 400 E_VALIDATION (detail.field = 'anchor')
 */
export function checkAnchor(db, input, { docId = null, passage = null } = {}) {
  if (!input || typeof input !== 'object') throw invalid('An anchor is required.', 'Select the words the note is about.');
  const field = input.field ?? 'body';
  if (!PASSAGE_FIELDS.includes(field)) throw invalid(`Anchor field '${field}' is not one of ${PASSAGE_FIELDS.join(', ')}.`);
  const doc = Number.isInteger(input.doc_id) ? input.doc_id : docId;
  if (!Number.isInteger(doc)) throw invalid('The anchor needs doc_id.');
  if (docId !== null && doc !== docId) {
    throw invalid(`The anchor names document ${doc}, but the target belongs to document ${docId}.`, null, { reason: 'doc_mismatch' });
  }
  if (typeof input.quote !== 'string' || input.quote.length === 0) {
    throw invalid('The anchor needs the quoted words (quote).', 'Select the words the note is about.');
  }
  const loaded = loadFieldText(db, doc, field);
  if (!loaded) throw invalid(`Document ${doc} has no '${field}' text to anchor to.`, null, { reason: 'no_text' });
  const r = resolveAnchor(loaded.text, { ...input, field }, { sha: loaded.sha });
  if (!r) {
    throw invalid(`The quoted words are not in document ${doc} (${field}).`,
      'Offsets are UTF-16 code units into the document text (D4); copy the passage anchor and select again.', { reason: 'not_found' });
  }
  if (r.ambiguous) {
    throw invalid('The quoted words occur more than once and the offsets do not say which.',
      'Send start/end as offsets into the document text (the passage anchor gives the passage start).', { reason: 'ambiguous' });
  }
  if (passage) {
    if (passage.field !== field || r.start < passage.start_off || r.end > passage.end_off) {
      throw invalid(`The anchored words (${r.start}–${r.end}) lie outside passage ${passage.id} (${passage.start_off}–${passage.end_off}).`,
        'Offsets index the document text, not the passage text; add the passage start.', { reason: 'outside_passage' });
    }
  }
  const anchor = makeAnchor(loaded.text, { field, start: r.start, end: r.end }, { docId: doc, sha: loaded.sha });
  return { anchor, relocated: r.method === 'exact' || r.method === 'offsets' ? null : r.method };
}

// ── re-anchoring after re-segmentation (or a changed decoding) ─────────────────────────────────────────

const parseJson = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

function texts(db) {
  const cache = new Map();
  return (docId, field) => {
    const key = `${docId}\u0000${field}`;
    if (!cache.has(key)) cache.set(key, loadFieldText(db, docId, field));
    return cache.get(key);
  };
}

/**
 * Re-anchor every annotation and evidence span of a document to the passages it has now (after a
 * re-segmentation, a segmenter/ICU upgrade or a re-decoding). Anchors are re-located by (sha256, offsets,
 * quote); rows whose words cannot be found are reported as orphaned and left untouched — nothing is deleted.
 * Relationship endpoints are immutable (§3 trigger): passage endpoints that no longer exist are reported.
 * @param {import('node:sqlite').DatabaseSync} db writable connection
 * @param {number} documentId
 * @returns {{document: number, annotations: object, evidence: object, endpoints: {missing: object[]}}}
 */
export function reanchorDocument(db, documentId) {
  const textOf = texts(db);
  const report = {
    document: documentId,
    annotations: { checked: 0, unchanged: 0, reanchored: [], orphaned: [] },
    evidence: { checked: 0, unchanged: 0, reanchored: [], orphaned: [] },
    endpoints: { missing: [] },
  };

  function locate(anchor) {
    const t = textOf(documentId, anchor.field ?? 'body');
    if (!t) return null;
    const r = resolveAnchor(t.text, anchor, { sha: t.sha });
    if (!r) return null;
    const p = passageFor(db, documentId, anchor.field ?? 'body', r.start, r.end);
    const moved = r.start !== anchor.start || r.end !== anchor.end || t.sha !== anchor.sha256;
    const next = moved ? makeAnchor(t.text, { field: anchor.field ?? 'body', start: r.start, end: r.end }, { docId: documentId, sha: t.sha }) : anchor;
    return { r, passage: p, moved, anchor: next };
  }

  tx(db, () => {
    const anns = stmt(db, `SELECT id, target_type, target_ref, anchor_json FROM annotation
      WHERE anchor_json IS NOT NULL AND json_extract(anchor_json, '$.doc_id') = ? ORDER BY id`).all(documentId);
    for (const a of anns) {
      report.annotations.checked++;
      const anchor = parseJson(a.anchor_json);
      const loc = anchor ? locate(anchor) : null;
      if (!loc || !loc.passage) {
        report.annotations.orphaned.push({ id: a.id, target: `${a.target_type}:${a.target_ref}`, quote: anchor?.quote ?? null,
          reason: loc ? 'no passage covers the words' : 'the quoted words are not in the text' });
        continue;
      }
      const newRef = a.target_type === 'passage' ? String(loc.passage.id) : a.target_ref;
      if (newRef === a.target_ref && !loc.moved) { report.annotations.unchanged++; continue; }
      stmt(db, 'UPDATE annotation SET target_ref = ?, anchor_json = ? WHERE id = ?').run(newRef, JSON.stringify(loc.anchor), a.id);
      report.annotations.reanchored.push({ id: a.id, from: a.target_ref, to: newRef, passage: loc.passage.id,
        method: loc.r.method, split: loc.passage.split });
    }

    const evs = stmt(db, `SELECT id, relationship_id, passage_id, anchor_json FROM relationship_evidence
      WHERE anchor_json IS NOT NULL AND json_extract(anchor_json, '$.doc_id') = ? ORDER BY id`).all(documentId);
    for (const e of evs) {
      report.evidence.checked++;
      const anchor = parseJson(e.anchor_json);
      const loc = anchor ? locate(anchor) : null;
      if (!loc || !loc.passage) {
        report.evidence.orphaned.push({ id: e.id, relationship: e.relationship_id, quote: anchor?.quote ?? null,
          reason: loc ? 'no passage covers the words' : 'the quoted words are not in the text' });
        continue;
      }
      if (e.passage_id === loc.passage.id && !loc.moved) { report.evidence.unchanged++; continue; }
      stmt(db, 'UPDATE relationship_evidence SET passage_id = ?, start_off = ?, end_off = ?, anchor_json = ? WHERE id = ?')
        .run(loc.passage.id, loc.anchor.start, loc.anchor.end, JSON.stringify(loc.anchor), e.id);
      report.evidence.reanchored.push({ id: e.id, relationship: e.relationship_id, from: e.passage_id, to: loc.passage.id,
        method: loc.r.method, split: loc.passage.split });
    }
  });

  for (const end of ['src', 'dst']) {
    for (const r of stmt(db, `SELECT r.id, r.${end}_ref AS ref FROM relationship r WHERE r.${end}_type = 'passage'
      AND NOT EXISTS (SELECT 1 FROM passage p WHERE p.id = CAST(r.${end}_ref AS INTEGER))`).all()) {
      report.endpoints.missing.push({ relationship: r.id, end, passage: Number(r.ref) });
    }
  }
  return report;
}
