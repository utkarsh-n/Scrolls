// OWNER: WP5
// trace.mjs — the targeted quotation trace (SPEC §4.7): for a span of ≥ 4 tokens of one passage,
//  · exact — FTS phrase windows of 8 tokens, then seed-and-extend: verified identical runs of ≥ 8 tokens;
//  · near  — candidates from the LSH index of the latest reuse-index run covering the span's collection (its sentences
//            that share a band key with the span's sentences) and from FTS (passages sharing the span's word
//            3-shingles), verified by Smith–Waterman ≥ 0.75 of the shorter unit and 3-shingle Jaccard ≥ 0.5, over an
//            aligned stretch of ≥ 8 tokens (shorter ones are listed as similar wording);
//  · similar wording — FTS NEAR(…, 6) of the span's rarest content words: computed similarity, never quotation;
//  · attribution cues around the span that name the author (or title) of a matched document.
// The reuse index's exclusions apply: a span that is structure, wording held by more than 25 documents, or
// production-line text lists its matches but makes no links (`exclusion` says which and why).
// traceQuery only reads (read pool or job); traceSpan (the 'trace' job) also writes the computed links of a run
// ('trace' stage): exact/near quotations directed by dates, shared wording otherwise, cue citations 'proposed'.
// Cross-language reuse is not detected, and the response says so.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { paths } from '../config.mjs';
import { nowIso, stmt, tx } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { resolveRef } from '../provenance/relationships.mjs';
import { stopwords } from '../text/langid.mjs';
import { kgramSeeds, seedExtend, smithWaterman } from './align.mjs';
import { classifyCandidate, insertAlgorithmRelationship, METHODS, writeCreateRevisions } from './classify.mjs';
import { findCues, nameMatches } from './cues.mjs';
import { informative, isNameList, PRODUCTION, TokenClasses } from './filters.mjs';
import { jaccard, shingles3, unitsOf } from './minhash.mjs';
import { lookupNear } from './near.mjs';
import { tokenIds } from './winnow.mjs';

export const PIPELINE_VERSION = 'trace@1.1.0';
const PRODUCTION_WIDE = 25;
export const MIN_SPAN_TOKENS = 4;
export const EXACT_MIN = 8;
export const NOTE = 'Cross-language reuse is not detected.';
const MAX_CANDIDATES = 400;
const MAX_LIST = 50;
const NEAR_SCORE = 0.75, NEAR_JACCARD = 0.5;

const invalid = (message, hint = null, detail = {}) => new HttpError(400, 'E_VALIDATION', message, hint, detail);
const ftsQuote = (toks) => `"${toks.join(' ').replace(/"/g, '""')}"`;

let stopSet = null;
const isStop = (t) => (stopSet ??= new Set(['en', 'fr', 'es', 'de', 'la', 'it', 'pt', 'hi', 'gu'].flatMap((l) => stopwords(l)))).has(t);

function fieldText(db, docId, field) {
  return field === 'body'
    ? stmt(db, 'SELECT original AS text, original_sha256 AS sha FROM document_text WHERE document_id = ?').get(docId)
    : stmt(db, 'SELECT value AS text, NULL AS sha FROM document_field WHERE document_id = ? AND field = ?').get(docId, field);
}

/**
 * Check a trace request and resolve its span (offsets index the document text, D4; `relative: true` = passage text).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{passage: number, start: number, end: number, relative?: boolean}} body
 * @returns {{passage: object, docId: number, field: string, start: number, end: number, text: string, sha: string|null,
 *   tokens: string[], starts: number[], ends: number[]}}
 */
export function checkTraceRequest(db, body) {
  if (!body || typeof body !== 'object') throw invalid('Send { passage, start, end }.');
  const pid = Number(body.passage);
  const target = Number.isSafeInteger(pid) ? resolveRef(db, 'passage', pid) : null;
  if (!target) throw new HttpError(404, 'E_NOT_FOUND', `No passage ${body.passage}.`);
  const p = target.passage;
  if (!Number.isInteger(body.start) || !Number.isInteger(body.end)) throw invalid('A trace needs integer start and end.', null, { field: 'start' });
  const shift = body.relative === true ? p.start_off : 0;
  const start = body.start + shift, end = body.end + shift;
  if (start < p.start_off || end > p.end_off || start >= end) {
    throw invalid(`Span ${start}–${end} is not inside passage ${pid} (${p.start_off}–${p.end_off}).`,
      'Offsets index the document text (D4); send relative: true for offsets into the passage text.', { field: 'start' });
  }
  const t = fieldText(db, p.document_id, p.field);
  const tk = tokenize(t.text.slice(start, end));
  if (tk.tokens.length < MIN_SPAN_TOKENS) {
    throw invalid(`A trace needs a span of at least ${MIN_SPAN_TOKENS} tokens (this one has ${tk.tokens.length}).`, 'Select a longer span.',
      { tokens: tk.tokens.length, min: MIN_SPAN_TOKENS });
  }
  return { passage: p, docId: p.document_id, field: p.field, start, end, text: t.text, sha: t.sha,
    tokens: tk.tokens, starts: Array.from(tk.starts, (x) => x + start), ends: Array.from(tk.ends, (x) => x + start) };
}

/**
 * The stored near-quotation index of the latest succeeded reuse-index run whose scope covers a document's collection.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} docId
 * @returns {{run: number, dir: string}|null}
 */
export function nearIndexFor(db, docId) {
  const coll = stmt(db, 'SELECT c.id, c.slug FROM document d JOIN collection c ON c.id = d.collection_id WHERE d.id = ?').get(docId);
  if (!coll) return null;
  for (const r of stmt(db, "SELECT id, scope_json FROM analysis_run WHERE stage = 'reuse-index' AND status = 'succeeded' ORDER BY id DESC").all()) {
    let cs = null;
    try { cs = JSON.parse(r.scope_json).collections ?? null; } catch { continue; }
    if (cs && !cs.includes(coll.slug) && !cs.includes(String(coll.id))) continue;
    const dir = path.join(paths().reuse, `run-${r.id}`);
    if (existsSync(path.join(dir, 'lsh.bin'))) return { run: r.id, dir };
  }
  return null;
}

function passageRow(db, id, exclude) {
  return stmt(db, `SELECT p.id, p.document_id, p.field, p.start_off, p.end_off, p.unit FROM passage p JOIN document d ON d.id = p.document_id
    WHERE p.id = ? AND p.quality = 'ok' AND p.document_id <> ? AND d.deleted_at IS NULL AND d.dup_of IS NULL`).get(id, exclude) ?? null;
}

function candidates(db, match, exclude) {
  if (!match) return [];
  return stmt(db, `SELECT p.id, p.document_id, p.field, p.start_off, p.end_off, p.unit FROM passage_fts f JOIN passage p ON p.id = f.rowid
    JOIN document d ON d.id = p.document_id
    WHERE passage_fts MATCH ? AND p.quality = 'ok' AND p.document_id <> ? AND d.deleted_at IS NULL AND d.dup_of IS NULL
    ORDER BY bm25(passage_fts) LIMIT ?`).all(match, exclude, MAX_CANDIDATES);
}

const docCache = (db) => {
  const m = new Map();
  return (id) => {
    if (!m.has(id)) {
      m.set(id, stmt(db, `SELECT id, title, author, lo_day, hi_day, y_lo, y_hi, chrono_status, is_synthetic, date_label
        FROM document WHERE id = ?`).get(id));
    }
    return m.get(id);
  };
};

function passageTokens(db, c) {
  const t = fieldText(db, c.document_id, c.field);
  const text = t.text.slice(c.start_off, c.end_off);
  const tk = tokenize(text);
  return { text: t.text, sha: t.sha, local: text, tk, ids: tokenIds(tk.tokens) };
}

/**
 * Search for the span's reuse elsewhere (no writes).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{passage: number, start: number, end: number, relative?: boolean}} args
 * @returns {object} SHAPES.Trace without created_relationships: {status: 'done', span, exact, near, similar_wording, cues, note}
 */
export function traceQuery(db, args) {
  const span = checkTraceRequest(db, args);
  const docOf = docCache(db);
  const spanIds = tokenIds(span.tokens);
  const exact = [], near = [], similar = [];
  const seen = new Set();
  const entry = (c, extra) => {
    const d = docOf(c.document_id);
    return { passage: c.id, doc: d.id, title: d.title, author: d.author ?? null, date: d.date_label, synthetic: d.is_synthetic === 1, ...extra };
  };

  // exact: verified identical runs of ≥ 8 tokens
  if (span.tokens.length >= EXACT_MIN) {
    const windows = [];
    for (let i = 0; i + EXACT_MIN <= span.tokens.length; i += 4) windows.push(ftsQuote(span.tokens.slice(i, i + EXACT_MIN)));
    const last = ftsQuote(span.tokens.slice(-EXACT_MIN));
    if (!windows.includes(last)) windows.push(last);
    for (const c of candidates(db, windows.join(' OR '), span.docId)) {
      const t = passageTokens(db, c);
      const runs = seedExtend(spanIds, t.ids, kgramSeeds(spanIds, t.ids, { k: EXACT_MIN }), { minRun: EXACT_MIN });
      if (!runs.length) continue;
      const r = runs.sort((x, y) => y.len - x.len)[0];
      seen.add(c.id);
      exact.push(entry(c, { start: c.start_off + t.tk.starts[r.b0], end: c.start_off + t.tk.ends[r.b1 - 1], tokens: r.len,
        quote: t.local.slice(t.tk.starts[r.b0], t.tk.ends[r.b1 - 1]),
        span: { start: span.starts[r.a0], end: span.ends[r.a1 - 1] } }));
      if (exact.length >= MAX_LIST) break;
    }
  } else {
    for (const c of candidates(db, ftsQuote(span.tokens), span.docId)) {
      seen.add(c.id);
      similar.push(entry(c, { kind: 'phrase', note: `the same ${span.tokens.length} words; too short for a quotation (needs ${EXACT_MIN})` }));
      if (similar.length >= MAX_LIST) break;
    }
  }

  // near: indexed sentences sharing an LSH band with the span's sentences, and passages sharing its 3-shingles; verified
  const spanText = span.text.slice(span.start, span.end);
  const spanTok = tokenize(spanText);
  let spanUnits = unitsOf(spanText, spanTok);
  if (!spanUnits.length) spanUnits = [{ t0: 0, t1: span.tokens.length }];
  const nearCands = new Map(); // passage id → { row, via }
  const index = nearIndexFor(db, span.docId);
  if (index) {
    for (const su of spanUnits) {
      for (const hit of lookupNear(index.dir, spanIds.subarray(su.t0, su.t1)) ?? []) {
        if (nearCands.has(hit.passage) || seen.has(hit.passage)) continue;
        const row = passageRow(db, hit.passage, span.docId);
        if (row) nearCands.set(row.id, { row, via: 'lsh' });
      }
    }
  }
  const shingleQueries = [];
  for (let i = 0; i + 3 <= span.tokens.length && shingleQueries.length < 30; i++) {
    const tri = span.tokens.slice(i, i + 3);
    if (tri.some((t) => !isStop(t))) shingleQueries.push(ftsQuote(tri));
  }
  for (const c of candidates(db, [...new Set(shingleQueries)].join(' OR '), span.docId)) {
    if (!nearCands.has(c.id)) nearCands.set(c.id, { row: c, via: 'fts' });
  }
  for (const { row: c, via } of nearCands.values()) {
    if (seen.has(c.id)) continue;
    const t = passageTokens(db, c);
    let units = unitsOf(t.local, t.tk, { verse: c.unit === 'stanza' });
    if (!units.length) units = [{ t0: 0, t1: t.tk.tokens.length }];
    let best = null;
    for (const su of spanUnits) {
      const a = spanIds.subarray(su.t0, su.t1), sa = shingles3(a);
      for (const u of units) {
        const b = t.ids.subarray(u.t0, u.t1);
        const ja = jaccard(sa, shingles3(b));
        if (ja < NEAR_JACCARD) continue;
        const sw = smithWaterman(a, b);
        if (sw.normalized < NEAR_SCORE) continue;
        if (!best || sw.normalized > best.sw.normalized) best = { sw, ja, su, u };
      }
    }
    if (!best) continue;
    seen.add(c.id);
    const b0 = best.u.t0 + best.sw.bStart, b1 = best.u.t0 + best.sw.bEnd;
    const a0 = best.su.t0 + best.sw.aStart, a1 = best.su.t0 + best.sw.aEnd;
    if (a1 - a0 < EXACT_MIN) {
      // a short aligned stretch is similar wording (a stock phrase, a formula), never a quotation
      if (similar.length < MAX_LIST) similar.push(entry(c, { kind: 'near_short', score: Math.round(best.sw.normalized * 1000) / 1000,
        note: `${a1 - a0} aligned words; a near quotation needs ${EXACT_MIN}` }));
      continue;
    }
    near.push(entry(c, { start: c.start_off + t.tk.starts[b0], end: c.start_off + t.tk.ends[b1 - 1],
      score: Math.round(best.sw.normalized * 1000) / 1000, jaccard: Math.round(best.ja * 1000) / 1000, via,
      quote: t.local.slice(t.tk.starts[b0], t.tk.ends[b1 - 1]), span: { start: span.starts[a0], end: span.ends[a1 - 1] } }));
    if (near.length >= MAX_LIST) break;
  }

  // similar wording: the rarest content words close together, in any order
  const content = [...new Set(span.tokens.filter((t) => !isStop(t) && t.length > 1))];
  if (content.length >= 2) {
    const rarity = (t) => stmt(db, "SELECT doc FROM passage_vocab_row WHERE term = ?").get(t)?.doc ?? 0;
    const words = content.map((t) => [t, rarity(t)]).filter(([, n]) => n > 0).sort((x, y) => x[1] - y[1]).slice(0, 5).map(([t]) => t);
    if (words.length >= 2) {
      for (const c of candidates(db, `NEAR(${words.map((w) => ftsQuote([w])).join(' ')}, 6)`, span.docId)) {
        if (seen.has(c.id)) continue;
        similar.push(entry(c, { kind: 'near_words', words }));
        if (similar.length >= MAX_LIST) break;
      }
    }
  }

  // cues around the span naming the author or title of a matched document
  const cues = [];
  for (const cue of findCues(span.text, span.start, span.end).filter((c) => c.name)) {
    for (const m of [...exact, ...near]) {
      const d = docOf(m.doc);
      if (nameMatches(cue.name, d)) cues.push({ ...cue, cited: { passage: m.passage, doc: m.doc, title: d.title } });
    }
  }
  const exclusion = traceExclusion(db, span, spanIds, [...exact, ...near]);
  return {
    status: 'done',
    span: { passage: span.passage.id, start: span.start, end: span.end, tokens: span.tokens.length, quote: spanText },
    exact, near, similar_wording: similar, cues, note: exclusion ? `${NOTE} ${exclusion.note}` : NOTE,
    near_index: index ? { run: index.run } : null, exclusion,
  };
}

/** Body characters below which a text has no front or back matter (≈ 1,000 tokens, PRODUCTION.minDocTokens). */
const MIN_BODY_CHARS = 5000;

/**
 * Why the matches of a span must not become quotation links, as in the reuse index (lineage/filters.mjs): the span is
 * structure (numbering, a list of names or titles), its wording is held by more than 25 documents (the "widely
 * shared text" node), or it is production-line text (≥ 3 documents hold it and ≥ 80% of the occurrences lie in the
 * first or last 15% of their bodies). The matches are still listed.
 * @returns {{kind: 'structure'|'widely_shared'|'production_line', note: string, documents?: number}|null}
 */
function traceExclusion(db, span, spanIds, matches) {
  const spanText = span.text.slice(span.start, span.end);
  if (!informative(spanIds, 0, spanIds.length, classesOf(span.tokens, spanIds)) || isNameList(spanText)) {
    return { kind: 'structure', note: 'The span is numbering or a list of names or titles: matches are listed, no links are made.' };
  }
  const docs = new Set([span.docId, ...matches.map((m) => m.doc)]);
  if (docs.size > PRODUCTION_WIDE) {
    return { kind: 'widely_shared', documents: docs.size,
      note: `This wording is held by ${docs.size} documents: widely shared text is one node, not pairs, so no links are made.` };
  }
  if (docs.size >= PRODUCTION.minDocs) {
    const body = stmt(db, 'SELECT body_start, body_end FROM document_text WHERE document_id = ?');
    const atEdge = (docId, off) => {
      const b = body.get(docId);
      if (!b || b.body_end - b.body_start < MIN_BODY_CHARS) return false;
      const rel = (off - b.body_start) / (b.body_end - b.body_start);
      return rel < PRODUCTION.edge || rel >= 1 - PRODUCTION.edge;
    };
    const occ = [[span.docId, span.start], ...matches.map((m) => [m.doc, m.start])];
    if (occ.filter(([d, o]) => atEdge(d, o)).length >= PRODUCTION.edgeShare * occ.length) {
      return { kind: 'production_line', documents: docs.size,
        note: `This wording opens or closes ${docs.size} documents (production-line text such as a transcriber's note): matches are listed, no links are made.` };
    }
  }
  return null;
}

/** Numeral classes of a token list (TokenClasses learns them from the strings). */
function classesOf(tokens, ids) {
  const c = new TokenClasses();
  tokens.forEach((t, i) => c.see(t, ids[i]));
  return c;
}

/** A visible algorithmic link of the same type between the same passages (from the reuse index or an earlier trace). */
function existing(db, relType, src, dst) {
  return stmt(db, `SELECT r.id FROM relationship r JOIN analysis_run a ON a.id = r.run_id WHERE r.rel_type = ? AND r.src_type = 'passage'
    AND r.src_ref = ? AND r.dst_type = 'passage' AND r.dst_ref = ? AND r.origin = 'algorithm' AND a.status = 'succeeded'
    ORDER BY r.id LIMIT 1`).get(relType, String(src), String(dst))?.id ?? null;
}

/**
 * The 'trace' job: search, then write the computed (and cue-proposed) links of a 'trace' run. Links the reuse index
 * or an earlier trace already made (same type, same passages) are reported, not duplicated.
 * @param {import('node:sqlite').DatabaseSync} db writable connection
 * @param {object} ctx TaskCtx (startRun, finishRun, checkpoint, progress)
 * @param {{passage: number, start: number, end: number, relative?: boolean}} args
 * @returns {object} SHAPES.Trace
 */
export function traceSpan(db, ctx, args) {
  const span = checkTraceRequest(db, args);
  const result = traceQuery(db, args);
  ctx?.checkpoint?.();
  const runId = ctx.startRun('trace', { pipelineVersion: PIPELINE_VERSION, params: { passage: span.passage.id, start: span.start, end: span.end } });
  const docOf = docCache(db);
  const me = { passage: span.passage.id, doc: docOf(span.docId) };
  const created = [];
  tx(db, () => {
    const write = (m, kind) => {
      if (result.exclusion) return;
      const other = { passage: m.passage, doc: docOf(m.doc) };
      const c = classifyCandidate({ a: me, b: other, kind, score: m.score ?? null });
      const method = kind === 'exact' ? METHODS.traceExact : m.via === 'lsh' ? METHODS.traceNearLsh : METHODS.traceNear;
      const found = existing(db, c.rel_type, c.src.passage, c.dst.passage);
      if (found) { created.push(found); return; }
      const field = stmt(db, 'SELECT field FROM passage WHERE id = ?').get(m.passage).field;
      const t = fieldText(db, other.doc.id, field);
      const detail = kind === 'exact' ? { tokens: m.tokens } : { alignment_score: m.score, jaccard: m.jaccard };
      const mine = { role: 'source_span', passage: me.passage, doc: me.doc, field: span.field, start: m.span.start, end: m.span.end,
        text: span.text, sha: span.sha, detail };
      const theirs = { role: 'target_span', passage: m.passage, doc: other.doc, field, start: m.start, end: m.end, text: t.text, sha: t.sha, detail };
      const [s, d] = c.src.passage === me.passage ? [mine, theirs] : [{ ...theirs, role: 'source_span' }, { ...mine, role: 'target_span' }];
      created.push(insertAlgorithmRelationship(db, { rel_type: c.rel_type, evidence_status: 'computed', src: c.src, dst: c.dst,
        directed: c.directed, score: c.score, method, runId, evidence: [s, d] }));
    };
    for (const m of result.exact) write(m, 'exact');
    for (const m of result.near) write(m, 'near');
    const perCue = new Map();
    // a cue naming the source of a famous line still proposes a citation; structure and production text never do
    const cues = result.exclusion && result.exclusion.kind !== 'widely_shared' ? [] : result.cues;
    for (const cue of cues) {
      const method = `attribution cue (${cue.lang}): "${cue.pattern}"`;
      const found = existing(db, 'explicit_citation', me.passage, cue.cited.passage);
      if (found) { created.push(found); continue; }
      const id = insertAlgorithmRelationship(db, { rel_type: 'explicit_citation', evidence_status: 'proposed', src: me,
        dst: { passage: cue.cited.passage, doc: docOf(cue.cited.doc) }, directed: 1, score: null, method, runId,
        evidence: [{ role: 'citation_cue', passage: me.passage, doc: me.doc, field: span.field, start: cue.start, end: cue.end, text: span.text,
          sha: span.sha, detail: { quote: cue.quote, name: cue.name, referent: 'inferred' } }] });
      created.push(id);
      const key = `${cue.start}:${cue.end}`;
      perCue.set(key, [...(perCue.get(key) ?? []), { id, quote: cue.quote }]);
    }
    // one cue naming an author with several matching texts: competing referents, side by side
    for (const list of perCue.values()) {
      if (list.length < 2) continue;
      const gid = Number(stmt(db, `INSERT INTO hypothesis_group (target_type, target_ref, question, created_by, is_synthetic, created_at)
        VALUES ('passage', ?, ?, ?, ?, ?)`).run(String(me.passage), `Which text does “${list[0].quote}” refer to?`, `run:${runId}`,
        me.doc.is_synthetic, nowIso()).lastInsertRowid);
      for (const x of list) stmt(db, 'UPDATE relationship SET hypothesis_group_id = ? WHERE id = ?').run(gid, x.id);
    }
    writeCreateRevisions(db, runId);
    ctx.finishRun(runId, 'succeeded', { metrics: { exact: result.exact.length, near: result.near.length,
      similar_wording: result.similar_wording.length, cues: result.cues.length, relationships: created.length } });
  });
  return { ...result, run_id: runId, created_relationships: [...new Set(created)] };
}
