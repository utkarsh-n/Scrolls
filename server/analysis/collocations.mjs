// OWNER: WP4
// collocations.mjs — collocations (SPEC §4.6): window ±5 tokens clipped at passage boundaries; a candidate
// needs f(x,y) ≥ 5 and f(y) ≥ 10; significance is Dunning's G² ≥ 10.83 with Benjamini–Hochberg q < .05 over
// all candidates of the slice; strength is logDice = 14 + log₂(2·f_xy / (f_x + f_y)), PPMI (context
// smoothing α = 0.75) a secondary column; ranked by logDice. Per-language stop-words are hidden by default
// (and counted). Gate: the target needs n ≥ 20 in the slice, else "Too few occurrences (12; needs 20).
// Showing KWIC." Context words, not meanings.
//
// Counts come from the token streams (tokstream) when they match the current data version; without them a
// slice of at most SYNC_TOKEN_LIMIT tokens is tokenized on the fly; larger slices need the streams (or a
// stored `collocations` run) and say so instead of guessing.

import { createHash } from 'node:crypto';
import { canonicalJson, mulberry32 } from '../../src/shared/ids.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { paths } from '../config.mjs';
import { dataVersion } from '../db/open.mjs';
import { inputFingerprint } from '../jobs/context.mjs';
import { stopwords } from '../text/langid.mjs';
import { badRequest } from '../http/errors.mjs';
import { collocatesNote, gated, NO_WIDENING_NOTE, THRESHOLDS, widenLabel, widenSuggestion } from './gates.mjs';
import { benjaminiHochberg, chi2Sf, g2 } from './intervals.mjs';
import { loadScope, modalityEvidence, normalizeSlice, normalizeToggles, passageTextReader, resolveExpressions, samplePassages,
  sliceStats, wideningIndex } from './slices.mjs';
import { openTokenStream, streamStatus } from './tokstream.mjs';

/** Pipeline version of collocation runs and payloads. */
export const COLLOCATIONS_VERSION = 'collocations@1.0.0';
/** Window on each side, in tokens (§4.4). */
export const WINDOW = 5;
/** PPMI context smoothing. */
export const PPMI_ALPHA = 0.75;
/** Largest slice (tokens) tokenized on the fly when no fresh token stream exists. */
export const SYNC_TOKEN_LIMIT = 2_000_000;
/** The label every collocate list carries (§13 rule 11). */
export const CONTEXT_LABEL = 'context words, not meanings';

/**
 * Folded stop-words of the given languages (server/text/stopwords; languages without a list add none).
 * @param {Iterable<string>} langs
 * @returns {Set<string>}
 */
export function stopSet(langs) {
  const out = new Set();
  for (const l of langs) {
    const base = String(l).split('-')[0];
    try { for (const w of stopwords(base)) out.add(w); } catch { /* no list for this language */ }
  }
  return out;
}

/**
 * Score collocates from context counts.
 * @param {{fxy: Map<string, number>, fy: Map<string, number>, fx: number, W: number, N: number, sumFyAlpha: number,
 *   stop?: Set<string>}} ctx window counts (fxy), slice frequencies of those terms (fy), the target's frequency (fx),
 *   window positions (W), slice tokens (N) and Σ f(y)^α over the slice vocabulary
 * @param {{minFxy?: number, minFy?: number, g2Min?: number, qMax?: number, showStop?: boolean, limit?: number}} [opts]
 * @returns {{rows: Array<{term: string, f_xy: number, f_y: number, logDice: number, ppmi: number, g2: number, q: number}>,
 *   candidates: number, significant: number, hidden_stopwords: number}}
 */
export function collocates(ctx, { minFxy = THRESHOLDS.collocates.f_xy, minFy = THRESHOLDS.collocates.f_y,
  g2Min = THRESHOLDS.collocates.g2, qMax = THRESHOLDS.collocates.q, showStop = false, limit = 100 } = {}) {
  const { fxy, fy, fx, W, N, sumFyAlpha } = ctx;
  const stop = ctx.stop ?? new Set();
  const cands = [];
  for (const [term, f] of fxy) {
    const y = fy.get(term) ?? 0;
    if (f < minFxy || y < minFy) continue;
    const o11 = f, o12 = Math.max(0, W - f), o21 = Math.max(0, y - f), o22 = Math.max(0, N - W - y + f);
    const g = g2(o11, o12, o21, o22);
    cands.push({ term, f_xy: f, f_y: y, g2: g, p: chi2Sf(g, 1), attract: N > 0 && o11 > W * y / N });
  }
  const qs = benjaminiHochberg(cands.map((c) => c.p));
  let hidden = 0;
  const rows = [];
  cands.forEach((c, i) => {
    if (!(c.attract && c.g2 >= g2Min && qs[i] < qMax)) return;
    if (!showStop && stop.has(c.term)) { hidden++; return; }
    const pY = sumFyAlpha > 0 ? c.f_y ** PPMI_ALPHA / sumFyAlpha : 0;
    const pmi = W > 0 && pY > 0 ? Math.log2((c.f_xy / W) / pY) : 0;
    rows.push({ term: c.term, f_xy: c.f_xy, f_y: c.f_y, logDice: round(14 + Math.log2(2 * c.f_xy / (fx + c.f_y)), 2),
      ppmi: round(Math.max(0, pmi), 2), g2: round(c.g2, 2), q: Number(qs[i].toPrecision(3)) });
  });
  rows.sort((x, y) => y.logDice - x.logDice || y.g2 - x.g2 || (x.term < y.term ? -1 : 1));
  return { rows: rows.slice(0, limit), candidates: cands.length, significant: rows.length, hidden_stopwords: hidden };
}

const round = (x, d) => Number(x.toFixed(d));

// Like the materialize job, every enabled variant matches in every passage of the slice (the slice's passages
// are already restricted to the strand's languages); at one position the longest variant wins.
function variantSeqs(scope, toId) {
  const byFirst = new Map();
  for (const e of scope.exprs) {
    for (const v of e.variants) {
      const ids = v.tokens.map(toId);
      if (!ids.length || ids.some((x) => x === undefined)) continue;
      if (!byFirst.has(ids[0])) byFirst.set(ids[0], []);
      byFirst.get(ids[0]).push(ids);
    }
  }
  for (const list of byFirst.values()) list.sort((x, y) => y.length - x.length);
  return byFirst;
}

/**
 * Token positions of name-guard hits (excluded unless nm = 1), by passage: the passage text is tokenized to
 * turn each flagged match's offsets into a token index.
 */
function nameExclusions(db, scope, docIds, readText) {
  const out = new Map();
  if (scope.toggles.nm) return out;
  const q = db.prepare(`SELECT o.passage_id AS pid, o.start_off, p.document_id, p.field, p.start_off AS p_start, p.end_off AS p_end
    FROM occurrence o JOIN passage p ON p.id = o.passage_id
    WHERE o.expression_id = ? AND o.run_id = ? AND o.name_flag = 1 AND o.document_id IN (SELECT value FROM json_each(?))`);
  const json = JSON.stringify(docIds);
  for (const e of scope.exprs) {
    for (const r of q.all(e.id, e.run, json)) {
      const text = readText({ document_id: r.document_id, field: r.field, start_off: r.p_start, end_off: r.p_end });
      if (text === null) continue;
      const { starts } = tokenize(text);
      const i = starts.indexOf(r.start_off - r.p_start);
      if (i < 0) continue;
      if (!out.has(r.pid)) out.set(r.pid, new Set());
      out.get(r.pid).add(i);
    }
  }
  return out;
}

/**
 * Context counts of the target in one slice: f(y) over the slice's passages, f(x,y) inside the ±window
 * windows of each counted match, from the token streams or (small slices) by tokenizing the passages.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} scope slices.loadScope()
 * @param {object} spec the slice
 * @param {object} stats slices.sliceStats()
 * @param {{window?: number, dir?: string, tokenLimit?: number, readText?: Function, checkpoint?: () => void}} [opts] a job
 *   passes its checkpoint (cancellation) and no token limit
 * @returns {{source: 'stream'|'tokenized', fx: number, W: number, N: number, fxy: Map<string, number>, fy: Map<string, number>,
 *   sumFyAlpha: number, langs: string[], passages: number, stop: Set<string>}|{unavailable: {langs: string[], tokens: number,
 *   limit: number, status: Record<string, string>}}}
 */
export function sliceContexts(db, scope, spec, stats, { window = WINDOW, dir = paths().tokens, tokenLimit = SYNC_TOKEN_LIMIT,
  readText = passageTextReader(db), checkpoint = () => {} } = {}) {
  const docIds = stats.perDoc.map((d) => d.id);
  const classes = new Set(stats.classes);
  // Decide from the denominators (doc_tokens, already loaded) before reading any passage: a large slice
  // without current streams is refused at once instead of after listing hundreds of thousands of passages.
  const early = new Set();
  let earlyTokens = 0;
  for (const id of docIds) {
    const doc = scope.docs.get(id);
    for (const t of doc?.tok ?? []) {
      if (!classes.has(t.fc) || !(stats.unit === 'works' || spec.langOk(t.plang, t.fc, doc.lang_text))) continue;
      early.add(t.plang);
      earlyTokens += t.tokens;
    }
  }
  if (earlyTokens > tokenLimit) {
    const st = Object.fromEntries([...early].sort().map((l) => [l, streamStatus(db, dir, l)]));
    const staleEarly = Object.keys(st).filter((l) => !st[l].fresh);
    if (staleEarly.length) {
      return { unavailable: { langs: staleEarly, tokens: earlyTokens, limit: tokenLimit, status: Object.fromEntries(Object.entries(st).map(([l, s]) =>
        [l, !s.exists ? 'not built' : s.fresh ? 'current' : `out of date (built at data version ${s.manifest.data_version}, now ${s.data_version})`])) } };
    }
  }
  const passages = db.prepare(`SELECT p.id, p.document_id, p.field, p.field_class AS fc, p.lang, p.start_off, p.end_off, p.token_count
    FROM passage p WHERE p.document_id IN (SELECT value FROM json_each(?)) AND p.quality = 'ok' ORDER BY p.id`)
    .all(JSON.stringify(docIds))
    .filter((p) => classes.has(p.fc) && (stats.unit === 'works' || spec.langOk(p.lang, p.fc, scope.docs.get(p.document_id)?.lang_text ?? null)));
  const langs = [...new Set(passages.map((p) => p.lang))].sort();
  const tokens = passages.reduce((s, p) => s + p.token_count, 0);
  const status = Object.fromEntries(langs.map((l) => [l, streamStatus(db, dir, l)]));
  const stale = langs.filter((l) => !status[l].fresh);
  let source;
  if (!stale.length) source = 'stream';
  else if (tokens <= tokenLimit) source = 'tokenized';
  else {
    return { unavailable: { langs: stale, tokens, limit: tokenLimit, status: Object.fromEntries(langs.map((l) => {
      const s = status[l];
      return [l, !s.exists ? 'not built' : s.fresh ? 'current' : `out of date (built at data version ${s.manifest.data_version}, now ${s.data_version})`];
    })) } };
  }
  const excluded = nameExclusions(db, scope, docIds, readText);
  const fxyAll = new Map(), fyAll = new Map();
  let fx = 0, W = 0, N = 0, sumFyAlpha = 0;

  for (const lang of langs) {
    const own = passages.filter((p) => p.lang === lang);
    let counts, vocab, toId, chunks, stream = null;
    if (source === 'stream') {
      stream = openTokenStream(lang, { dir, ids: false });
      counts = new Uint32Array(stream.vocab.length);
      vocab = stream.vocab;
      toId = (t) => stream.idOf(t);
      // consecutive passages are contiguous in the stream: read each run of them once
      chunks = [];
      let run = null;
      for (const p of own) {
        const r = stream.range(p.id);
        if (!r) continue;
        if (run && run.end === r[0]) { run.end = r[1]; run.items.push([p, r]); } else { run = { start: r[0], end: r[1], items: [[p, r]] }; chunks.push(run); }
      }
      chunks = chunks.map((c) => ({ ...c, read: () => stream.readIds(c.start, c.end) }));
    } else {
      const local = new Map();
      vocab = [];
      toId = (t) => { let id = local.get(t); if (id === undefined) { id = vocab.length; local.set(t, id); vocab.push(t); } return id; };
      counts = [];
      chunks = own.map((p) => ({ items: [[p, null]], read: () => {
        const text = readText(p);
        return text === null ? [] : tokenize(text).tokens.map(toId);
      } }));
    }
    const seqs = variantSeqs(scope, toId);
    const fxy = new Map();
    try {
      for (const chunk of chunks) {
        checkpoint();
        const ids = chunk.read();
        for (const [p, r] of chunk.items) {
          const a = r ? r[0] - chunk.start : 0, b = r ? r[1] - chunk.start : ids.length;
          const skip = excluded.get(p.id);
          for (let i = a; i < b; i++) counts[ids[i]] = (counts[ids[i]] ?? 0) + 1;
          N += b - a;
          for (let i = a; i < b; i++) {
            const cands = seqs.get(ids[i]);
            if (!cands) continue;
            let len = 0;
            for (const s of cands) {
              if (i + s.length > b) continue;
              let ok = true;
              for (let j = 1; j < s.length; j++) if (ids[i + j] !== s[j]) { ok = false; break; }
              if (ok) { len = s.length; break; }
            }
            if (!len || skip?.has(i - a)) continue;
            fx++;
            for (let j = Math.max(a, i - window); j < i; j++) { fxy.set(ids[j], (fxy.get(ids[j]) ?? 0) + 1); W++; }
            for (let j = i + len; j < Math.min(b, i + len + window); j++) { fxy.set(ids[j], (fxy.get(ids[j]) ?? 0) + 1); W++; }
          }
        }
      }
    } finally {
      stream?.close(); // the ids file stays open across the chunk reads
    }
    for (let id = 0; id < counts.length; id++) if (counts[id]) sumFyAlpha += counts[id] ** PPMI_ALPHA;
    for (const [id, c] of fxy) {
      const term = vocab[id];
      fxyAll.set(term, (fxyAll.get(term) ?? 0) + c);
      fyAll.set(term, (fyAll.get(term) ?? 0) + (counts[id] ?? 0));
    }
  }
  return { source, fx, W, N, fxy: fxyAll, fy: fyAll, sumFyAlpha, langs, passages: passages.length, stop: stopSet(langs) };
}

// ── Stored runs (the collocations job) ───────────────────────────────────────────────────────────────

/**
 * Canonical params of a collocation run for one expression and slice (what makes two runs the same).
 * @param {{exprs: object[], slice: {years: number[], f: string}, toggles: object}} q
 * @returns {object}
 */
export function collocationRunParams({ exprs, slice, toggles }) {
  return { expr: exprs.map((e) => e.id), materialize: exprs.map((e) => e.run), years: slice.years, f: slice.f, toggles,
    window: WINDOW, version: COLLOCATIONS_VERSION };
}

/** The slice key stored in collocation.slice_key. */
export const sliceKey = (slice) => `${slice.years[0]}..${slice.years[1]}|${slice.f}`;

/**
 * Rows of a succeeded collocations run with the same params and input fingerprint, or null.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} params collocationRunParams()
 * @param {string[]} collections slugs in scope (the fingerprint's scope)
 * @returns {{run: number, rows: object[]}|null}
 */
export function storedCollocations(db, params, collections) {
  const hash = createHash('sha256').update(canonicalJson(params)).digest('hex');
  const fp = inputFingerprint(db, { scope: { collections }, upstream: params.materialize });
  const run = db.prepare(`SELECT id FROM analysis_run WHERE stage = 'collocations' AND params_hash = ? AND input_fingerprint = ?
    AND status = 'succeeded' ORDER BY id DESC LIMIT 1`).get(hash, fp)?.id ?? null;
  if (run === null) return null;
  const rows = db.prepare(`SELECT collocate AS term, f_xy, f_y, g2, q_value AS q, log_dice AS logDice, ppmi FROM collocation
    WHERE run_id = ? AND expression_id = ? AND slice_key = ? ORDER BY log_dice DESC, g2 DESC`)
    .all(run, params.expr[0], sliceKey({ years: params.years, f: params.f }));
  return { run, rows };
}

// ── GET /api/collocations ────────────────────────────────────────────────────────────────────────────

function parseSliceParam(raw) {
  const m = /^(-?\d{1,5})(?:-|\.\.)(-?\d{1,5})$/.exec(String(raw ?? '').trim());
  if (!m) {
    throw badRequest('E_VALIDATION', `slice must be 'lo-hi' years (got '${raw ?? ''}').`, "Use e.g. slice=1994-2026.", { field: 'slice' });
  }
  return [Number(m[1]), Number(m[2])];
}

function parseExprParam(raw) {
  const ids = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (!ids.length || ids.length > 2 || !ids.every((x) => Number.isSafeInteger(x) && x > 0)) {
    throw badRequest('E_VALIDATION', `expr must be one or two expression ids (got '${raw ?? ''}').`, 'Track the expression first.', { field: 'expr' });
  }
  return ids;
}

/**
 * The modality a single slice is read in: the one holding most of its matches (then most documents).
 * @param {Record<string, {n: number, docs: number}>} ev
 * @returns {string}
 */
export function leadingModality(ev) {
  const entries = Object.entries(ev);
  if (!entries.length) return 'text';
  entries.sort(([, x], [, y]) => y.n - x.n || y.docs - x.docs);
  return entries[0][0];
}

/**
 * GET /api/collocations (collocates or gate). Read-query convention (§12.2): runs in the read pool via
 * ctx.pool.run(moduleUrl, 'collocationsQuery', args).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{expr: string|number, slice: string, f?: string, toggles?: object, stop?: string|number, corpus?: string|null,
 *   seed?: number, limit?: number, lane?: string}} args
 * @returns {object} Collocations shape
 */
export function collocationsQuery(db, args) {
  const ids = parseExprParam(args.expr);
  const slice = normalizeSlice({ years: parseSliceParam(args.slice), f: args.f ?? '' }, 'a');
  const toggles = normalizeToggles(args.toggles);
  const showStop = args.stop === 1 || args.stop === '1' || args.stop === true;
  const exprs = resolveExpressions(db, ids);
  const scope = loadScope(db, { exprs, slices: [slice], toggles, corpus: args.corpus ?? null });
  const spec = scope.specs[0];
  const modality = leadingModality(modalityEvidence(scope, spec));
  const stats = sliceStats(scope, spec, modality);
  const label = exprs.map((e) => e.surface).join(' + ');
  const provenance = {
    data_version: dataVersion(db), run_ids: { materialize: Object.fromEntries(exprs.map((e) => [e.id, e.run])) },
    tokenizer: 'u61m-1', segmenter: 'seg-1', synthetic: stats.synthetic || exprs.some((e) => e.synthetic),
    collections: [...stats.collections].sort(),
    licenses: [...new Set([...stats.collections].map((s) => [...scope.collections.values()].find((c) => c.slug === s)?.license).filter(Boolean))].sort(),
  };
  const base = { expr: ids.length === 1 ? ids[0] : ids, expression_label: label, label: CONTEXT_LABEL, slice: `${slice.years[0]}-${slice.years[1]}`, f: slice.f, modality,
    window: `±${WINDOW} tokens`, measure: 'logDice' };
  const need = THRESHOLDS.collocates.occurrences;

  if (stats.n < need) {
    const index = wideningIndex(scope, spec, modality);
    const w = widenSuggestion(index, slice.years, { occurrences: need });
    const suggestion = w ? { label: widenLabel(null, w.years, `${w.stats.n} occurrences`), slice: `${w.years[0]}-${w.years[1]}`,
      years: w.years, f: slice.f, would_have: { occurrences: w.stats.n, documents: w.stats.docs } } : null;
    const kwic = samplePassages(db, scope, spec, stats, { rng: mulberry32(Number(args.seed) || 1), count: 10, laneFacet: args.lane ?? 'collection',
      readText: passageTextReader(db) });
    return gated('insufficient_occurrences', { ...base, needed: { occurrences: need }, have: { occurrences: stats.n }, suggestion,
      note: collocatesNote({ a: stats.n }, need) + (suggestion ? '' : ` ${capitalize(NO_WIDENING_NOTE)}.`), kwic, provenance });
  }

  const params = collocationRunParams({ exprs, slice, toggles });
  const stored = storedCollocations(db, params, [...stats.collections].sort());
  if (stored) {
    const rows = stored.rows.filter((r) => showStop || !stopSet(Object.keys(stats.languages)).has(r.term)).slice(0, Number(args.limit) || 100);
    return { gate: 'ok', ...base, thresholds: thresholdsOut(), collocates: rows, source: 'stored', run: stored.run,
      f_x: stats.n, provenance: { ...provenance, run_ids: { ...provenance.run_ids, collocations: stored.run } } };
  }
  const ctx = sliceContexts(db, scope, spec, stats);
  if (ctx.unavailable) return streamsGate(base, ctx.unavailable, provenance);
  const scored = collocates(ctx, { showStop, limit: Number(args.limit) || 100 });
  return { gate: 'ok', ...base, thresholds: thresholdsOut(), collocates: scored.rows, candidates: scored.candidates,
    hidden_stopwords: scored.hidden_stopwords, source: ctx.source, f_x: ctx.fx, window_positions: ctx.W, slice_tokens: ctx.N, provenance };
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The thresholds every collocate payload prints. */
export function thresholdsOut() {
  const t = THRESHOLDS.collocates;
  return { g2: t.g2, f: t.f_xy, f_y: t.f_y, q: t.q, min_occurrences: t.occurrences };
}

/**
 * The gate when a slice is too large to tokenize on the fly and its token streams are missing or stale.
 * @param {object} base
 * @param {{langs: string[], tokens: number, limit: number, status: object}} u
 * @param {object} provenance
 * @returns {object}
 */
export function streamsGate(base, u, provenance) {
  return gated('not_run', { ...base, needed: { token_streams: u.langs }, have: { token_streams: u.status, slice_tokens: u.tokens },
    suggestion: { label: `Build token streams for ${u.langs.join(', ')}`, run: { stage: 'tokstream', params: { langs: u.langs } } },
    note: `Collocates for a slice of ${u.tokens} tokens need current token streams (${u.langs.map((l) => `${l}: ${u.status[l]}`).join('; ')}).`,
    provenance });
}


/**
 * What a collocations run for an expression and slice would store, and the succeeded run that already
 * stores it (POST /api/analysis/runs reuses it). Read-query convention: runs in the read pool.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{expr: number[], years: [number, number], f?: string, toggles?: object, corpus?: string|null}} args
 * @returns {{expr: number[], slice: {years: [number, number], f: string}, toggles: object, corpus: string|null,
 *   stored_run: number|null, job: number|null}}
 */
export function collocationsPlanQuery(db, { expr, years, f = '', toggles, corpus = null }) {
  const ids = Array.isArray(expr) ? expr : [expr];
  if (!ids.length || ids.length > 2 || !ids.every((x) => Number.isSafeInteger(x) && x > 0)) {
    throw badRequest('E_VALIDATION', 'A collocations run needs expr (one or two expression ids).', 'Send {stage, expr, params: {years, f}}.', { field: 'expr' });
  }
  const slice = normalizeSlice({ years, f }, 'a');
  const tg = normalizeToggles(toggles);
  const exprs = resolveExpressions(db, ids);
  const scope = loadScope(db, { exprs, slices: [slice], toggles: tg, corpus });
  const stats = sliceStats(scope, scope.specs[0], leadingModality(modalityEvidence(scope, scope.specs[0])));
  const stored = storedCollocations(db, collocationRunParams({ exprs, slice, toggles: tg }), [...stats.collections].sort());
  const job = stored ? db.prepare('SELECT job_id FROM analysis_run WHERE id = ?').get(stored.run)?.job_id ?? null : null;
  return { expr: ids, slice, toggles: tg, corpus, stored_run: stored?.run ?? null, job };
}
