// OWNER: WP4
// layout.mjs — the meaning constellation (SPEC §2.B): nodes, edges and stable positions for pinned strands in
// one or two periods.
//
// Nodes (shape = type): expression ○, context group ⬡ (from the strand's clustering run), context word (a
// significant collocate), document □, etymon ▽. Node area ∝ one named quantity per period (occurrences,
// documents or distinct authors in the period; context words: co-occurrences within ±5 tokens when they are
// significant collocates, else no value). Edges: co-occurrence expression → word (logDice in the period,
// only collocates passing the §4.6 gates), membership expression → context group (share of the period's
// clustered occurrences; ≥ 30 needed), occurrence expression → document (occurrences in the document),
// relationships between documents (evidence styles; similarity never added here), etymological family
// expression → etymon ("shared ancestry, not shared meaning"). Bounds: ≤ 150 nodes, ≤ 400 edges, top-k by the
// size quantity; `expand` adds ≤ 20 neighbours of a node.
// Stable layout: positions are computed once per layout key (corpus, strands, run ids) by a deterministic
// Fruchterman–Reingold (300 iterations, seed = FNV-1a-32 of the key and generation, then a collision pass)
// inside the unit square and cached in layout_cache; nodes that appear later (another period, an expansion)
// are placed with every cached node pinned, so changing or comparing periods never moves a node. Re-layout
// is explicit (`relayout=1`) and says "Positions recomputed — movement is not semantic."

import { canonicalJson, fnv1a32, mulberry32 } from '../../src/shared/ids.mjs';
import { yearLabel } from '../../src/shared/dates.mjs';
import { dataVersion, nowIso } from '../db/open.mjs';
import { badRequest } from '../http/errors.mjs';
import { collocates, leadingModality, sliceContexts } from './collocations.mjs';
import { collocatesNote, THRESHOLDS } from './gates.mjs';
import { humanLabels } from './labels.mjs';
import { loadScope, modalityEvidence, normalizeToggles, resolveExpressions, sliceStats } from './slices.mjs';
import { latestClusterRun, WINDOW_RULE } from './transitions.mjs';

/** Layout algorithm name and iteration count (§2.B). */
export const LAYOUT_ALGORITHM = 'fruchterman-reingold-300';
export const LAYOUT_ITERATIONS = 300;
/** Bounds (§2.B). */
export const BOUNDS = Object.freeze({ nodes: 150, edges: 400, expand: 20, strands: 4 });
/** Per strand and period: context words and documents shown before expansion. */
export const PER_STRAND = Object.freeze({ words: 12, docs: 3, relDocs: 20 });
/** Size quantities (§2.B dropdown). */
export const SIZE_MODES = Object.freeze({ occurrences: 'occurrences in period', documents: 'documents in period', authors: 'distinct authors in period' });
/** Edge kinds this endpoint draws. */
export const EDGE_KINDS = Object.freeze(['cooc', 'member', 'occurs', 'rel', 'etym']);
/** The toast after an explicit re-layout (§2.B). */
export const RELAYOUT_TOAST = 'Positions recomputed — movement is not semantic.';
/** Legend note on positions. */
export const POSITION_NOTE = 'Positions are fixed for this layout key; movement is not semantic.';

/** Pull toward the centre, relative to n·k (a frame-bounded FR otherwise piles leaves on the frame). */
export const GRAVITY = 0.5;

// ── Stable layout (pure) ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic Fruchterman–Reingold in the unit square with pinned nodes, then a collision pass that moves
 * only free nodes. Node order is canonical (sorted ids), so positions never depend on request order.
 * @param {string[]} nodes node ids
 * @param {Array<[string, string, number?]>} edges [source, target, weight]
 * @param {{seed?: number, pinned?: Map<string, [number, number]>, iterations?: number, margin?: number}} [opts]
 * @returns {Map<string, [number, number]>} every node's position (pinned ones unchanged)
 */
export function stableLayout(nodes, edges, { seed = 42, pinned = new Map(), iterations = LAYOUT_ITERATIONS, margin = 0.04 } = {}) {
  const ids = [...new Set(nodes)].sort();
  const n = ids.length;
  const out = new Map();
  if (!n) return out;
  const at = new Map(ids.map((id, i) => [id, i]));
  const rng = mulberry32(seed);
  const x = new Float64Array(n), y = new Float64Array(n);
  const free = new Uint8Array(n);
  const lo = margin, hi = 1 - margin;
  const clamp = (v) => Math.min(hi, Math.max(lo, v));
  const adj = Array.from({ length: n }, () => []);
  const E = [];
  for (const [s, t, w = 1] of edges) {
    const a = at.get(s), b = at.get(t);
    if (a === undefined || b === undefined || a === b) continue;
    E.push([Math.min(a, b), Math.max(a, b), Math.max(0.1, Math.min(3, w))]);
    adj[a].push(b);
    adj[b].push(a);
  }
  E.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]); // summation order must not depend on the request
  for (const list of adj) list.sort((p, q) => p - q);
  ids.forEach((id, i) => {
    const p = pinned.get(id);
    if (p) { x[i] = p[0]; y[i] = p[1]; } else free[i] = 1;
  });
  ids.forEach((id, i) => {
    if (!free[i]) return;
    const anchors = adj[i].filter((j) => !free[j]);
    if (anchors.length) {
      const mx = anchors.reduce((s, j) => s + x[j], 0) / anchors.length, my = anchors.reduce((s, j) => s + y[j], 0) / anchors.length;
      x[i] = clamp(mx + (rng() - 0.5) * 0.1);
      y[i] = clamp(my + (rng() - 0.5) * 0.1);
    } else {
      x[i] = lo + rng() * (hi - lo);
      y[i] = lo + rng() * (hi - lo);
    }
  });
  const anyFree = free.some((f) => f);
  if (anyFree) {
    const k = 0.9 * Math.sqrt(1 / n);
    const k2 = k * k;
    const gravity = GRAVITY * n * k;
    const dx = new Float64Array(n), dy = new Float64Array(n);
    for (let it = 0; it < iterations; it++) {
      const temp = 0.1 * (1 - it / iterations) + 1e-4;
      dx.fill(0); dy.fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (!free[i] && !free[j]) continue;
          let ex = x[i] - x[j], ey = y[i] - y[j];
          let d2 = ex * ex + ey * ey;
          if (d2 < 1e-10) { ex = (rng() - 0.5) * 1e-3; ey = (rng() - 0.5) * 1e-3; d2 = ex * ex + ey * ey; }
          const f = k2 / d2; // (k²/d) along the unit vector (ex/d)
          dx[i] += ex * f; dy[i] += ey * f;
          dx[j] -= ex * f; dy[j] -= ey * f;
        }
      }
      for (const [a, b, w] of E) {
        const ex = x[a] - x[b], ey = y[a] - y[b];
        const d = Math.sqrt(ex * ex + ey * ey) || 1e-5;
        const f = (d / k) * w; // (d²/k) along the unit vector
        dx[a] -= ex * f; dy[a] -= ey * f;
        dx[b] += ex * f; dy[b] += ey * f;
      }
      for (let i = 0; i < n; i++) {
        if (!free[i]) continue;
        dx[i] -= gravity * (x[i] - 0.5); dy[i] -= gravity * (y[i] - 0.5); // keeps leaves off the frame
        const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
        if (len > 0) { const s = Math.min(len, temp) / len; x[i] = clamp(x[i] + dx[i] * s); y[i] = clamp(y[i] + dy[i] * s); }
      }
    }
    // collision pass: free nodes step away from anything closer than minDist
    const minDist = Math.min(0.04, 0.6 * k);
    for (let pass = 0; pass < 50; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (!free[i] && !free[j]) continue;
          let ex = x[i] - x[j], ey = y[i] - y[j];
          let d = Math.sqrt(ex * ex + ey * ey);
          if (d >= minDist) continue;
          if (d < 1e-9) { ex = rng() - 0.5; ey = rng() - 0.5; d = Math.sqrt(ex * ex + ey * ey); }
          const push = (minDist - d) / (free[i] && free[j] ? 2 : 1);
          const ux = ex / d, uy = ey / d;
          if (free[i]) { x[i] = clamp(x[i] + ux * push); y[i] = clamp(y[i] + uy * push); }
          if (free[j]) { x[j] = clamp(x[j] - ux * push); y[j] = clamp(y[j] - uy * push); }
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
  ids.forEach((id, i) => out.set(id, free[i] ? [Number(x[i].toFixed(4)), Number(y[i].toFixed(4))] : pinned.get(id)));
  return out;
}

/**
 * The layout key of (corpus, strands, run ids): 'fnv:' + FNV-1a-32 hex of its canonical JSON.
 * @param {{corpus: string|null, strands: number[], runs: object}} parts
 * @returns {string}
 */
export function layoutKey({ corpus, strands, runs }) {
  const json = canonicalJson({ corpus: corpus ?? null, strands: [...strands].sort((a, b) => a - b), runs });
  return `fnv:${fnv1a32(json).toString(16).padStart(8, '0')}`;
}

/**
 * Read a cached layout: {generation, seed, positions: {id: [x, y]}} or null.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @returns {{generation: number, seed: number, positions: Record<string, [number, number]>, created_at: string}|null}
 */
export function readLayoutCache(db, key) {
  const row = db.prepare('SELECT positions_json, created_at FROM layout_cache WHERE key = ?').get(key);
  if (!row) return null;
  try {
    const v = JSON.parse(row.positions_json);
    return { generation: v.generation ?? 0, seed: v.seed ?? null, positions: v.positions ?? {}, created_at: row.created_at };
  } catch { return null; }
}

/**
 * Store new positions under a key. Cached nodes keep their positions (a concurrent writer never moves them)
 * unless `replace` (an explicit re-layout of a newer generation) is set.
 * @param {import('node:sqlite').DatabaseSync} db writable connection, inside or outside a transaction
 * @param {{key: string, positions: Record<string, [number, number]>, generation: number, seed: number, replace?: boolean}} write
 * @returns {{stored: number, kept: number}}
 */
export function writeLayoutCache(db, { key, positions, generation, seed, replace = false }) {
  const cur = readLayoutCache(db, key);
  let merged, kept = 0;
  if (!cur || (replace && generation > cur.generation)) {
    merged = { algorithm: LAYOUT_ALGORITHM, generation, seed, positions };
  } else {
    const pos = { ...cur.positions };
    for (const [id, p] of Object.entries(positions)) { if (pos[id]) kept++; else pos[id] = p; }
    merged = { algorithm: LAYOUT_ALGORITHM, generation: cur.generation, seed: cur.seed ?? seed, positions: pos };
  }
  db.prepare(`INSERT INTO layout_cache (key, positions_json, created_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET positions_json = excluded.positions_json`).run(key, JSON.stringify(merged), nowIso());
  return { stored: Object.keys(merged.positions).length, kept };
}

// ── Request parsing ──────────────────────────────────────────────────────────────────────────────────

/**
 * 'lo-hi' or 'lo..hi' (astronomical years) → [lo, hi].
 * @param {unknown} raw
 * @param {string} name
 * @returns {[number, number]|null}
 */
export function parsePeriod(raw, name) {
  if (raw === undefined || raw === null || raw === '') return null;
  const m = /^(-?\d{1,5})(?:-|\.\.)(-?\d{1,5})$/.exec(String(raw).trim());
  if (!m || Number(m[1]) > Number(m[2])) {
    throw badRequest('E_VALIDATION', `${name} must be 'lo-hi' years with lo ≤ hi (got '${raw}').`, 'e.g. a=1955-1985&b=1994-2026', { field: name });
  }
  return [Number(m[1]), Number(m[2])];
}

function parseIds(raw, name, max) {
  const ids = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (!ids.length || ids.length > max || !ids.every((x) => Number.isSafeInteger(x) && x > 0)) {
    throw badRequest('E_VALIDATION', `${name} must list 1–${max} expression ids (got '${raw ?? ''}').`, 'Pin strands first.', { field: name });
  }
  return [...new Set(ids)];
}

function parseRuns(raw) {
  const out = {};
  for (const part of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+):(\d+)$/.exec(part);
    if (!m) throw badRequest('E_VALIDATION', `runs must be 'expr:run' pairs (got '${part}').`, 'e.g. runs=12:14', { field: 'runs' });
    out[Number(m[1])] = Number(m[2]);
  }
  return out;
}

// ── The constellation (read query) ───────────────────────────────────────────────────────────────────

const fits = (doc, [lo, hi]) => doc.y_lo !== null && doc.y_lo >= lo && doc.y_hi <= hi;
const sizeOf = (mode, s) => (s ? (mode === 'occurrences' ? s.n : mode === 'documents' ? s.docs : s.authors) : 0);

/**
 * Counted occurrences of each strand per period with the default exclusions. Strands of the same corpus and
 * languages share one scope (the corpus is read once); each strand is measured on a view whose documents carry
 * only its own matches.
 * @returns {Map<number, Array<object>>} expression id → per period {modality, n, docs, authors, perDoc, collections,
 *   synthetic, scope (the strand's view), spec, stats}
 */
function strandStats(db, exprs, periods, toggles, corpus) {
  const groups = new Map();
  for (const e of exprs) {
    const key = `${e.corpus_id ?? '*'}|${e.langs ? [...e.langs].sort().join(',') : '*'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const out = new Map();
  for (const list of groups.values()) {
    const scope = loadScope(db, { exprs: list, slices: periods.map((years) => ({ years, f: '' })), toggles, corpus });
    const withHits = [...scope.docs.values()].filter((d) => d.hits.length);
    const all = new Map(withHits.map((d) => [d, d.hits]));
    try {
      for (const e of list) {
        for (const d of withHits) d.hits = all.get(d).filter((h) => h.expr === e.id);
        const view = { ...scope, exprs: [e] };
        out.set(e.id, periods.map((_, i) => {
          const spec = view.specs[i];
          const modality = leadingModality(modalityEvidence(view, spec));
          const st = sliceStats(view, spec, modality);
          const docs = st.perDoc.filter((d) => d.n > 0).map((d) => ({ ...d, doc: view.docs.get(d.id) }));
          return { modality, n: st.n, docs: st.evidenceDocs, authors: st.evidenceAuthors.size, perDoc: docs, collections: [...st.collections],
            synthetic: st.synthetic, scope: view, spec, stats: st };
        }));
      }
    } finally {
      for (const [d, hits] of all) d.hits = hits;
    }
  }
  return out;
}

/**
 * Significant collocates of a strand in one period, or the gate (§4.6: n ≥ 20; slices too large to tokenize
 * need current token streams). Reuses the strand's scope instead of re-reading the corpus.
 */
function periodCollocates(db, s, limit) {
  const need = THRESHOLDS.collocates.occurrences;
  if (s.stats.n < need) {
    return { gate: 'insufficient_occurrences', value: null, needed: { occurrences: need }, have: { occurrences: s.stats.n },
      note: collocatesNote({ a: s.stats.n }, need), suggestion: null };
  }
  const ctx = sliceContexts(db, s.scope, s.spec, s.stats);
  if (ctx.unavailable) {
    const u = ctx.unavailable;
    return { gate: 'not_run', value: null, needed: { token_streams: u.langs }, have: { token_streams: u.status, slice_tokens: u.tokens },
      suggestion: { label: `Build token streams for ${u.langs.join(', ')}`, run: { stage: 'tokstream', params: { langs: u.langs } } },
      note: `Collocates for a slice of ${u.tokens} tokens need current token streams.` };
  }
  return { gate: 'ok', rows: collocates(ctx, { limit }).rows };
}

/** Default period A: the strands' whole dated extent (their counted documents). */
function extentOf(db, exprs) {
  const r = db.prepare(`SELECT MIN(d.y_lo) AS lo, MAX(d.y_hi) AS hi FROM expr_doc x JOIN document d ON d.id = x.document_id
    WHERE d.chrono_status = 'dated' AND d.deleted_at IS NULL AND x.n > 0 AND (x.expression_id, x.run_id) IN
    (SELECT value ->> 0, value ->> 1 FROM json_each(?))`).get(JSON.stringify(exprs.map((e) => [e.id, e.run])));
  return r && r.lo !== null ? [r.lo, r.hi] : null;
}

/** Context groups of a run with their members' documents (succeeded runs only). */
function clusterMembers(db, runId) {
  const groups = db.prepare(`SELECT c.* FROM sense_cluster c JOIN analysis_run r ON r.id = c.run_id
    WHERE c.run_id = ? AND r.status = 'succeeded' ORDER BY c.ord`).all(runId);
  const members = db.prepare(`SELECT m.cluster_id AS cluster, d.id AS doc, d.y_lo, d.y_hi, d.author FROM cluster_member m
    JOIN sense_cluster c ON c.id = m.cluster_id JOIN occurrence o ON o.id = m.occurrence_id JOIN document d ON d.id = o.document_id
    WHERE c.run_id = ? AND d.chrono_status = 'dated'`).all(runId);
  return { groups, members };
}

/**
 * Relationships touching some documents or passages (indexed lookups), with both ends resolved to documents.
 * `hit CROSS JOIN relationship` keeps the matched ids as the outer loop: with a plain JOIN the planner drove the
 * join from relationship(dst_type) and scanned ~600k rows once OpenAlex citations were loaded (M5 gate: 3.1 s →
 * QUERY_TIMEOUT for the demo constellation).
 */
function relationshipsAmong(db, docIds, passageIds) {
  if (!docIds.length && !passageIds.length) return [];
  return db.prepare(`WITH d(id) AS (SELECT CAST(value AS TEXT) FROM json_each(?)), p(id) AS (SELECT CAST(value AS TEXT) FROM json_each(?)),
    hit(id) AS (
      SELECT r.id FROM relationship r WHERE r.src_type = 'document' AND r.src_ref IN (SELECT id FROM d)
      UNION SELECT r.id FROM relationship r WHERE r.dst_type = 'document' AND r.dst_ref IN (SELECT id FROM d)
      UNION SELECT r.id FROM relationship r WHERE r.src_type = 'passage' AND r.src_ref IN (SELECT id FROM p)
      UNION SELECT r.id FROM relationship r WHERE r.dst_type = 'passage' AND r.dst_ref IN (SELECT id FROM p)),
    ends AS (
      SELECT r.*, CASE r.src_type WHEN 'document' THEN CAST(r.src_ref AS INTEGER) ELSE ps.document_id END AS src_doc,
        CASE r.dst_type WHEN 'document' THEN CAST(r.dst_ref AS INTEGER) ELSE pd.document_id END AS dst_doc
      FROM hit h CROSS JOIN relationship r ON r.id = h.id
      LEFT JOIN passage ps ON r.src_type = 'passage' AND ps.id = CAST(r.src_ref AS INTEGER)
      LEFT JOIN passage pd ON r.dst_type = 'passage' AND pd.id = CAST(r.dst_ref AS INTEGER)
      LEFT JOIN analysis_run ar ON ar.id = r.run_id
      WHERE r.src_type IN ('document', 'passage') AND r.dst_type IN ('document', 'passage') AND (r.run_id IS NULL OR ar.status = 'succeeded')
        AND r.review_status != 'rejected' AND r.rel_type NOT IN ('kindred', 'counterpart'))
    SELECT e.id, e.rel_type, e.evidence_status, e.review_status, e.provenance_quality, e.origin, e.run_id, e.is_synthetic,
      e.src_doc, e.dst_doc, t.family, s.y_lo AS src_lo, s.y_hi AS src_hi, s.title AS src_title, s.is_synthetic AS src_syn,
      s.chrono_status AS src_chrono, d.y_lo AS dst_lo, d.y_hi AS dst_hi, d.title AS dst_title, d.is_synthetic AS dst_syn, d.chrono_status AS dst_chrono
    FROM ends e JOIN rel_type t ON t.code = e.rel_type JOIN document s ON s.id = e.src_doc JOIN document d ON d.id = e.dst_doc
    WHERE e.src_doc != e.dst_doc AND s.deleted_at IS NULL AND d.deleted_at IS NULL
    ORDER BY CASE e.evidence_status WHEN 'documented' THEN 0 WHEN 'computed' THEN 1 ELSE 2 END, e.id LIMIT 400`)
    .all(JSON.stringify(docIds), JSON.stringify(passageIds));
}

function etymonsOf(db, expr) {
  if (!expr.lang) return [];
  try {
    return db.prepare(`SELECT e.key, e.lang, e.form, e.roman, e.gloss FROM etymon_member m JOIN etymon e ON e.key = m.key
      WHERE m.lang = ? AND m.norm = ? ORDER BY m.rank, e.key LIMIT 3`).all(expr.lang, expr.norm);
  } catch { return []; }
}

const docLabel = (title, synthetic) => `${title ?? 'untitled'}${synthetic && !/\(synthetic\)$/.test(title ?? '') ? ' (synthetic)' : ''}`;

/**
 * GET /api/constellation. Read-query convention (§12.2): runs in the read pool via ctx.pool.run(moduleUrl,
 * 'constellationQuery', args). When new nodes were placed (or on re-layout) the payload carries
 * `cache_write` for the main thread to store (read workers hold read-only connections).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{strands: string, a?: string, b?: string, size?: string, edges?: string, max_nodes?: string|number,
 *   max_edges?: string|number, toggles?: object, corpus?: string|null, expand?: string, relayout?: string|number, runs?: string,
 *   rev_cutoff?: string|number}} args
 * @returns {object} Constellation shape (+ cache_write)
 */
export function constellationQuery(db, args) {
  const ids = parseIds(args.strands ?? args.expr, 'strands', BOUNDS.strands);
  const sizeMode = args.size ?? 'occurrences';
  if (!SIZE_MODES[sizeMode]) throw badRequest('E_VALIDATION', `size must be one of ${Object.keys(SIZE_MODES).join(', ')}.`, null, { field: 'size' });
  const kinds = new Set(args.edges ? String(args.edges).split(',').map((s) => s.trim()).filter(Boolean) : EDGE_KINDS);
  for (const kk of kinds) if (!EDGE_KINDS.includes(kk)) throw badRequest('E_VALIDATION', `Unknown edge kind '${kk}'.`, `Use ${EDGE_KINDS.join(', ')}.`, { field: 'edges' });
  const maxNodes = Math.min(BOUNDS.nodes, Math.max(1, Number(args.max_nodes) || BOUNDS.nodes));
  const maxEdges = Math.min(BOUNDS.edges, Math.max(0, Number(args.max_edges ?? BOUNDS.edges) || 0));
  const toggles = normalizeToggles(args.toggles);
  const corpus = args.corpus || null;
  const expand = new Set(String(args.expand ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const relayout = args.relayout === 1 || args.relayout === '1' || args.relayout === true;
  const pins = parseRuns(args.runs);
  const exprs = resolveExpressions(db, ids);

  let a = parsePeriod(args.a, 'a'), b = parsePeriod(args.b, 'b');
  const periodNotes = [];
  if (!a) {
    a = extentOf(db, exprs);
    if (!a) throw badRequest('E_VALIDATION', 'The strands have no dated occurrences; give period a=lo-hi.', null, { field: 'a' });
    periodNotes.push(`Period A defaults to the strands' dated extent (${yearLabel(a[0])}–${yearLabel(a[1])}).`);
  }
  let swapped = false;
  if (b && b[0] < a[0]) { [a, b] = [b, a]; swapped = true; periodNotes.push('A is always the earlier period: the periods were swapped.'); }
  const periods = b ? [a, b] : [a];
  const pk = ['a', 'b'];

  // ── per strand: sizes, documents, words, groups ──
  const nodes = new Map();
  const edges = [];
  const gates = { cooc: {}, member: {} };
  const collections = new Set();
  let synthetic = false;
  const runIds = { materialize: {}, cluster: {} };
  const addNode = (id, n) => { if (!nodes.has(id)) nodes.set(id, n); return nodes.get(id); };
  const emptySize = () => Object.fromEntries(periods.map((_, i) => [pk[i], 0]));

  const docN = new Map(); // document → strand occurrences per period (all strands)
  const allStats = strandStats(db, exprs, periods, toggles, corpus);
  for (const e of exprs) {
    runIds.materialize[e.id] = e.run;
    const xid = `x:${e.id}`;
    const stats = allStats.get(e.id);
    stats.forEach((s, i) => {
      for (const d of s.perDoc) {
        if (!docN.has(d.id)) docN.set(d.id, { n: periods.map(() => 0), doc: d.doc });
        docN.get(d.id).n[i] += d.n;
      }
    });
    stats.forEach((s) => { s.collections.forEach((c) => collections.add(c)); if (s.synthetic) synthetic = true; });
    if (e.synthetic) synthetic = true;
    addNode(xid, { id: xid, type: 'expression', label: e.surface, ref: `expression:${e.id}`, prio: 0,
      size: Object.fromEntries(stats.map((s, i) => [pk[i], sizeOf(sizeMode, s)])),
      modality: Object.fromEntries(stats.map((s, i) => [pk[i], s.modality])), synthetic: e.synthetic });

    // documents with the most occurrences of the strand in each period
    if (kinds.has('occurs') || kinds.has('rel')) {
      const limit = PER_STRAND.docs + (expand.has(xid) ? BOUNDS.expand : 0);
      stats.forEach((s, i) => {
        for (const d of [...s.perDoc].sort((x, y) => y.n - x.n || x.id - y.id).slice(0, limit)) {
          const did = `d:${d.id}`;
          const node = addNode(did, { id: did, type: 'document', label: docLabel(d.doc.title, d.doc.syn), ref: `document:${d.id}`, prio: 3,
            size: emptySize(), year: d.doc.y_lo, doc: d.doc, synthetic: d.doc.syn });
          if (d.doc.syn) synthetic = true;
          node.prio = Math.min(node.prio, 3);
          if (kinds.has('occurs')) {
            let edge = edges.find((x) => x.kind === 'occurs' && x.s === xid && x.t === did);
            if (!edge) { edge = { s: xid, t: did, kind: 'occurs', weight: Object.fromEntries(periods.map((_, j) => [pk[j], null])), measure: 'occurrences' }; edges.push(edge); }
            edge.weight[pk[i]] = d.n;
          }
          node.size[pk[i]] = sizeMode === 'occurrences' ? (node.size[pk[i]] || 0) + d.n : sizeMode === 'documents' ? 1 : null;
        }
      });
    }

    // significant collocates per period
    if (kinds.has('cooc')) {
      gates.cooc[xid] = {};
      const limit = PER_STRAND.words + (expand.has(xid) ? BOUNDS.expand : 0);
      periods.forEach((years, i) => {
        const r = periodCollocates(db, stats[i], limit);
        if (r.gate !== 'ok') {
          gates.cooc[xid][pk[i]] = { gate: r.gate, value: null, needed: r.needed ?? null, have: r.have ?? null, note: r.note ?? null,
            suggestion: r.suggestion ?? null };
          return;
        }
        gates.cooc[xid][pk[i]] = { gate: 'ok' };
        for (const c of r.rows) {
          const wid = `w:${c.term}`;
          const node = addNode(wid, { id: wid, type: 'word', label: c.term, prio: 2, size: Object.fromEntries(periods.map((_, j) => [pk[j], null])) });
          // a collocate counted in synthetic text is a synthetic quantity (§13 rule 1, fix pass)
          if (stats[i].synthetic) node.synthetic = true;
          if (sizeMode === 'occurrences') node.size[pk[i]] = (node.size[pk[i]] ?? 0) + c.f_xy;
          node.sig = node.sig ?? {};
          node.sig[pk[i]] = true;
          let edge = edges.find((x) => x.kind === 'cooc' && x.s === xid && x.t === wid);
          if (!edge) { edge = { s: xid, t: wid, kind: 'cooc', weight: Object.fromEntries(periods.map((_, j) => [pk[j], null])), measure: 'logDice' }; edges.push(edge); }
          edge.weight[pk[i]] = c.logDice;
        }
      });
    }

    // context groups of the strand's clustering run
    if (kinds.has('member')) {
      const run = pins[e.id] ? db.prepare(`SELECT * FROM analysis_run WHERE id = ? AND stage = 'cluster' AND status = 'succeeded'
        AND json_extract(scope_json, '$.expression') = ?`).get(pins[e.id], e.id) : latestClusterRun(db, e.id);
      const perPeriod = (g) => Object.fromEntries(periods.map((_, j) => [pk[j], g]));
      gates.member[xid] = {};
      if (!run) {
        gates.member[xid] = perPeriod({ gate: 'not_run', value: null, needed: { run: 'cluster' }, have: { runs: 0 }, note: 'No clustering run for this strand.' });
      } else {
        runIds.cluster[e.id] = run.id;
        const { groups, members } = clusterMembers(db, run.id);
        if (!groups.length) {
          const g = JSON.parse(run.gate_json || '{}')?.cluster ?? {};
          gates.member[xid] = perPeriod({ gate: g.gate ?? 'no_cluster_structure', value: null, needed: g.needed ?? null, have: g.have ?? null, note: g.note ?? null });
        }
        const human = humanLabels(db, groups.map((g) => g.id), { revCutoff: Number(args.rev_cutoff) || null });
        const totals = periods.map((p) => members.filter((m) => fits(m, p)).length);
        for (const g of groups) {
          const kid = `k:${g.id}`;
          const mine = members.filter((m) => m.cluster === g.id);
          const size = {}, present = {};
          periods.forEach((p, i) => {
            const inP = mine.filter((m) => fits(m, p));
            size[pk[i]] = sizeMode === 'occurrences' ? inP.length : sizeMode === 'documents' ? new Set(inP.map((m) => m.doc)).size
              : new Set(inP.map((m) => m.author).filter(Boolean)).size;
            present[pk[i]] = inP.length > 0;
          });
          const h = human.get(g.id);
          addNode(kid, { id: kid, type: 'cluster', label: h?.label ?? g.label_auto, machine_label: g.label_auto, human_label: h?.label ?? null,
            status: g.status, tentative: g.status === 'unstable', ref: `cluster:${g.id}`, run: run.id, prio: 1, size, present,
            representation: run.representation, synthetic: e.synthetic });
          const weight = {};
          periods.forEach((p, i) => {
            const nIn = mine.filter((m) => fits(m, p)).length;
            if (totals[i] >= WINDOW_RULE.minN) {
              weight[pk[i]] = Number((nIn / totals[i]).toFixed(4));
              gates.member[xid][pk[i]] = { gate: 'ok' };
            } else {
              weight[pk[i]] = null;
              gates.member[xid][pk[i]] = { gate: 'insufficient_occurrences', value: null, needed: { occurrences: WINDOW_RULE.minN },
                have: { occurrences: totals[i] }, note: `Shares need ≥ ${WINDOW_RULE.minN} clustered occurrences in the period (${totals[i]}).` };
            }
          });
          edges.push({ s: xid, t: kid, kind: 'member', weight, measure: 'share', run: run.id });
        }
      }
    }

    // etymological family
    if (kinds.has('etym')) {
      for (const et of etymonsOf(db, e)) {
        const eid = `e:${et.key}`;
        addNode(eid, { id: eid, type: 'etymon', label: `${et.form}${et.gloss ? ` '${et.gloss}'` : ''}`, ref: `etymon:${et.key}`, prio: 1,
          size: Object.fromEntries(periods.map((_, j) => [pk[j], null])), present: Object.fromEntries(periods.map((_, j) => [pk[j], true])),
          note: 'period of the language, not a date' });
        edges.push({ s: xid, t: eid, kind: 'etym', weight: Object.fromEntries(periods.map((_, j) => [pk[j], null])), measure: null,
          note: 'shared ancestry, not shared meaning' });
      }
    }
  }

  // ── relationships between documents (evidence styles; never similarity-derived) ──
  if (kinds.has('rel')) {
    // relationships touching any document that holds the strands in the periods; their ends become nodes
    let added = 0;
    const passageIds = db.prepare(`SELECT DISTINCT passage_id AS id FROM occurrence WHERE (expression_id, run_id) IN
      (SELECT value ->> 0, value ->> 1 FROM json_each(?))`).all(JSON.stringify(exprs.map((e) => [e.id, e.run]))).map((r) => r.id);
    for (const r of relationshipsAmong(db, [...docN.keys()], passageIds)) {
      for (const [did, title, syn, lo, hi, chrono] of [[r.src_doc, r.src_title, r.src_syn, r.src_lo, r.src_hi, r.src_chrono],
        [r.dst_doc, r.dst_title, r.dst_syn, r.dst_lo, r.dst_hi, r.dst_chrono]]) {
        if (nodes.has(`d:${did}`) || added >= PER_STRAND.relDocs) continue;
        added++;
        const doc = { y_lo: chrono === 'dated' ? lo : null, y_hi: chrono === 'dated' ? hi : null };
        const counts = docN.get(did)?.n ?? periods.map(() => 0);
        addNode(`d:${did}`, { id: `d:${did}`, type: 'document', label: docLabel(title, syn === 1), ref: `document:${did}`, prio: 4,
          size: Object.fromEntries(periods.map((p, j) => [pk[j], sizeMode === 'occurrences' ? counts[j]
            : sizeMode === 'documents' ? (fits(doc, p) ? 1 : 0) : null])),
          year: lo, doc, synthetic: syn === 1 });
      }
      if (!nodes.has(`d:${r.src_doc}`) || !nodes.has(`d:${r.dst_doc}`)) continue;
      if (r.is_synthetic) synthetic = true;
      const madeBy = (p) => r.src_chrono === 'dated' && r.src_hi <= p[1];
      edges.push({ s: `d:${r.src_doc}`, t: `d:${r.dst_doc}`, kind: 'rel', weight: Object.fromEntries(periods.map((_, j) => [pk[j], null])),
        measure: null, rel_id: r.id, rel_type: r.rel_type, family: r.family, evidence_status: r.evidence_status, review_status: r.review_status,
        provenance_quality: r.provenance_quality, present: Object.fromEntries(periods.map((p, j) => [pk[j], madeBy(p)])), synthetic: r.is_synthetic === 1 });
    }
  }

  // ── presence and bounds ──
  for (const n of nodes.values()) {
    if (n.present) continue;
    if (n.type === 'word') n.present = Object.fromEntries(periods.map((_, j) => [pk[j], Boolean(n.sig?.[pk[j]])]));
    else if (n.type === 'document') n.present = Object.fromEntries(periods.map((p, j) => [pk[j], Boolean(n.doc && fits(n.doc, p))]));
    else n.present = Object.fromEntries(periods.map((_, j) => [pk[j], (n.size[pk[j]] ?? 0) > 0]));
  }
  const peak = (n) => Math.max(0, ...Object.values(n.size).map((v) => v ?? 0));
  const ranked = [...nodes.values()].sort((x, y) => x.prio - y.prio || peak(y) - peak(x) || (x.id < y.id ? -1 : 1));
  const kept = ranked.slice(0, maxNodes);
  const keep = new Set(kept.map((n) => n.id));
  const edgeRank = { member: 0, etym: 1, rel: 2, cooc: 3, occurs: 4 };
  const edgePeak = (e) => Math.max(0, ...Object.values(e.weight).map((v) => v ?? 0));
  const liveEdges = edges.filter((e) => keep.has(e.s) && keep.has(e.t))
    .sort((x, y) => edgeRank[x.kind] - edgeRank[y.kind] || edgePeak(y) - edgePeak(x) || (x.s + x.t < y.s + y.t ? -1 : 1));
  const shownEdges = liveEdges.slice(0, maxEdges);

  // ── stable positions ──
  const key = layoutKey({ corpus: corpus ?? (exprs[0].corpus_id ?? null), strands: ids, runs: { materialize: runIds.materialize, cluster: runIds.cluster } });
  const cached = readLayoutCache(db, key);
  const generation = relayout ? (cached?.generation ?? 0) + 1 : cached?.generation ?? 0;
  const seed = fnv1a32(`${key}:${generation}`);
  const pinned = new Map();
  if (!relayout && cached) for (const n of kept) if (cached.positions[n.id]) pinned.set(n.id, cached.positions[n.id]);
  const fresh = kept.filter((n) => !pinned.has(n.id)).map((n) => n.id);
  let positions = pinned;
  let cacheWrite = null;
  if (fresh.length) {
    positions = stableLayout(kept.map((n) => n.id), shownEdges.map((e) => [e.s, e.t, e.kind === 'member' || e.kind === 'etym' ? 2 : 1]),
      { seed, pinned });
    cacheWrite = { key, generation, seed, replace: relayout, positions: Object.fromEntries(fresh.map((id) => [id, positions.get(id)])) };
    if (relayout) cacheWrite.positions = Object.fromEntries([...positions]);
  }

  // ── payload ──
  const outNodes = kept.map((n) => {
    const o = { id: n.id, type: n.type, label: n.label, size: n.size, pos: positions.get(n.id), present: n.present };
    for (const f of ['ref', 'machine_label', 'human_label', 'status', 'tentative', 'run', 'representation', 'modality', 'note']) if (n[f] !== undefined) o[f] = n[f];
    if (n.year !== undefined && n.year !== null) o.year = n.year;
    o.synthetic = Boolean(n.synthetic);
    const more = edges.filter((e) => (e.s === n.id || e.t === n.id) && (!keep.has(e.s) || !keep.has(e.t))).length;
    if (more) o.more = more;
    return o;
  });
  const outEdges = shownEdges.map((e) => {
    const o = { s: e.s, t: e.t, kind: e.kind, weight: e.weight, measure: e.measure };
    for (const f of ['rel_id', 'rel_type', 'family', 'evidence_status', 'review_status', 'provenance_quality', 'run', 'note', 'present', 'synthetic']) {
      if (e[f] !== undefined) o[f] = e[f];
    }
    if (!o.present) o.present = Object.fromEntries(periods.map((_, j) => [pk[j], e.weight[pk[j]] !== null && e.weight[pk[j]] !== undefined]));
    return o;
  });
  const sizes = outNodes.flatMap((n) => Object.values(n.size)).filter((v) => typeof v === 'number' && v > 0).sort((x, y) => x - y);
  const refCircles = sizes.length ? [...new Set([sizes[0], sizes[Math.floor(sizes.length / 2)], sizes[sizes.length - 1]])] : [];
  const diff = b ? {
    only_a: outNodes.filter((n) => n.present.a && !n.present.b).map((n) => n.id),
    only_b: outNodes.filter((n) => !n.present.a && n.present.b).map((n) => n.id),
    grew: outNodes.filter((n) => typeof n.size.a === 'number' && typeof n.size.b === 'number' && n.size.a > 0 && n.size.b > 2 * n.size.a).map((n) => n.id),
  } : null;
  if (diff) diff.counts = { only_a: diff.only_a.length, only_b: diff.only_b.length, grew: diff.grew.length };
  const licenses = collections.size ? db.prepare(`SELECT DISTINCT license FROM collection WHERE slug IN (SELECT value FROM json_each(?))
    AND license IS NOT NULL ORDER BY license`).all(JSON.stringify([...collections])).map((r) => r.license) : [];
  return {
    nodes: outNodes,
    edges: outEdges,
    legend: {
      size: `${SIZE_MODES[sizeMode]} (area, sqrt radius)`, size_mode: sizeMode, reference_circles: refCircles, scale: 'area ∝ value (sqrt radius)',
      size_by_type: { expression: SIZE_MODES[sizeMode], cluster: `${SIZE_MODES[sizeMode]} assigned to the group`,
        word: sizeMode === 'occurrences' ? 'co-occurrences with the strand within ±5 tokens (significant collocates only)' : 'not sized in this mode',
        document: sizeMode === 'occurrences' ? 'occurrences of the strands in the document' : sizeMode === 'documents' ? '1 per document' : 'not sized in this mode',
        etymon: 'not sized: a period of the language, not a date' },
      edge: 'logDice, co-occurrence ±5 tokens',
      edge_by_kind: { cooc: 'logDice in the period (only collocates passing G² ≥ 10.83, q < .05, f ≥ 5)', member: 'share of the period\'s clustered occurrences (≥ 30 needed)',
        occurs: 'occurrences of the strand in the document', rel: 'relationship (line pattern = evidence status)', etym: 'shared ancestry, not shared meaning' },
      shapes: { expression: '○', cluster: '⬡', word: '·', document: '□', theme: '◇', etymon: '▽' },
      note: POSITION_NOTE, words_note: 'context words, not meanings',
    },
    layout: { key, algorithm: LAYOUT_ALGORITHM, pinned: pinned.size > 0, generation, seed, placed: fresh.length,
      toast: relayout ? RELAYOUT_TOAST : null },
    truncated: { nodes: nodes.size - kept.length, edges: liveEdges.length - shownEdges.length,
      reason: nodes.size > kept.length ? `top ${maxNodes} by ${SIZE_MODES[sizeMode]}` : null },
    periods: { a, b: b ?? null, swapped, labels: periods.map((p) => `${yearLabel(p[0])}–${yearLabel(p[1])}`), notes: periodNotes },
    gates, diff,
    synthetic,
    provenance: { data_version: dataVersion(db), run_ids: runIds, tokenizer: 'u61m-1', segmenter: 'seg-1', synthetic,
      collections: [...collections].sort(), licenses },
    cache_write: cacheWrite,
  };
}
