// OWNER: WP5
// views.mjs — immutable saved views (SPEC D17, §7.2, §8.2).
//
// A saved view pins the data version, the import cutoff (max committed import_batch), the run ids, and the
// annotation and relationship revision cutoffs; the view_immutable trigger refuses any later UPDATE of them.
// Re-saving never edits: it creates '<slug>~2', '~3' … with parent_slug set. Deleting is soft (the link stops
// resolving; the row stays). Opening a view reports how the data drifted since, and its "as saved" counts
// (documents ≤ the import cutoff, soft-deleted ones still counted, pinned runs) reproduce the counts at save.

import { canonicalJson, shortHash, slugify } from '../../src/shared/ids.mjs';
import { canonicalize, encode, stateHash, VIEWSTATE_VERSION } from '../../src/shared/viewstate.mjs';
import { dataVersion, nowIso, stmt, tx } from '../db/open.mjs';
import { decodeCursor, encodeCursor, limitParam } from '../http/router.mjs';
import { HttpError } from '../http/errors.mjs';
import { authorName, humanActor } from './relationships.mjs';
import { defFromViewState } from '../aggregate/query.mjs';
import { resolveCorpusScope, siblingExpressions } from '../aggregate/scope.mjs';

/** Exact copy of §7.2 for a view whose corpus changed. */
export const DRIFT_MESSAGE = (cutoff) =>
  `Corpus changed since this view was saved. 'As saved' restricts to imports ≤ #${cutoff} and the pinned runs.`;

/** The drift sentence for imports reverted after the save (their documents are only soft-deleted, D17). */
export const REVERTED_NOTE = (batches) => `${batches.length === 1 ? `Import #${batches[0].batch} was` : `Imports ${batches.map((b) => `#${b.batch}`).join(', ')} were`} reverted since; 'As saved' still counts ${batches.length === 1 ? 'its' : 'their'} documents.`;

/** Run kinds a view state pins besides materialize (§8.2 runs). */
const PINNED_RUNS = Object.freeze(['cluster', 'quotes', 'vectors']);
const MAX_NAME = 120;

const invalid = (message, field, hint = null) => new HttpError(400, 'E_VALIDATION', message, hint, { field });
const parseJson = (s, dflt) => {
  if (s === null || s === undefined) return dflt;
  try { return JSON.parse(s); } catch { return dflt; }
};
const notFound = (slug) => new HttpError(404, 'E_NOT_FOUND', `No saved view ${slug}.`);

// ── pins ────────────────────────────────────────────────────────────────────────────────────────────

const runRow = (db, id) => stmt(db, 'SELECT id, stage, status, scope_json, params_hash FROM analysis_run WHERE id = ?').get(id) ?? null;

/**
 * Run ids the view pins: the state's runs (when they succeeded); the materialize run of every member of its expression
 * strands (each member corpus of a virtual corpus such as `real`) and, for context-group lanes, the clustering run the
 * query shows — both as the timeline query resolves them now; the current reuse-index run (quotes) when the state
 * names none; and the boilerplate pass behind its denominators. A saved view never follows a newer run (§13 rule 17).
 */
function pinnedRuns(db, state, warnings, scope = null) {
  const runs = state.runs ?? {};
  const out = {};
  const mat = {};
  const pin = (key, id) => {
    if (!Number.isSafeInteger(id) || mat[key] !== undefined) return;
    if (runRow(db, id)?.status === 'succeeded') mat[key] = id;
    else warnings.push(`materialize run ${id} for expression ${key} is not a succeeded run; not pinned`);
  };
  // the def the timeline query would build for this state (pinned runs honoured, current ones otherwise)
  let def = null;
  try { def = defFromViewState(db, state, { scope }).def; } catch (err) { warnings.push(`the view's query could not be resolved: ${err.message}`); }
  for (const s of def?.strands ?? []) {
    if (s.type !== 'expression') continue;
    for (const m of s.members ?? []) if (m.ref) pin(String(m.ref), m.run);
  }
  // a strand the def could not resolve keeps the rule of contract 1.0: its asked or current materialize run
  for (const s of state.strands ?? []) {
    if (s.type !== 'expression' || !Number.isSafeInteger(Number(s.id))) continue;
    const key = String(s.id);
    if (mat[key] !== undefined) continue;
    const asked = runs.materialize?.[key];
    pin(key, Number.isSafeInteger(asked) ? asked
      : stmt(db, "SELECT run_id FROM expression_state WHERE expression_id = ? AND status = 'ready'").get(Number(s.id))?.run_id ?? null);
  }
  if (Object.keys(mat).length) out.materialize = mat;
  for (const k of PINNED_RUNS) {
    const id = runs[k];
    if (id === null || id === undefined) continue;
    if (runRow(db, id)?.status === 'succeeded') out[k] = id;
    else warnings.push(`${k} run ${id} is not a succeeded run; not pinned`);
  }
  // context-group lanes show one clustering run's groups and labels: pin the one on screen (lanes.run or the default)
  if (out.cluster === undefined && state.lanes?.facet === 'cluster' && def?.cluster?.state === 'ok' && Number.isSafeInteger(def.cluster.run)) {
    out.cluster = def.cluster.run;
  }
  // the quotation links in view are those of the current reuse index unless the state names a run
  if (out.quotes === undefined) {
    const q = stmt(db, "SELECT id FROM analysis_run WHERE stage = 'reuse-index' AND status = 'succeeded' ORDER BY id DESC LIMIT 1").get();
    if (q) out.quotes = q.id;
  }
  // passage quality (boilerplate) is part of every denominator: pin the pass the counts were made under
  const bp = stmt(db, "SELECT id FROM analysis_run WHERE stage = 'boilerplate' AND status = 'succeeded' ORDER BY id DESC LIMIT 1").get();
  if (bp) out.boilerplate = bp.id;
  return out;
}

// ── scope and counts ────────────────────────────────────────────────────────────────────────────────

/** The corpora of a view's corpus slug (the members of a virtual corpus such as `real`); null for an unknown slug. */
function viewScope(db, state, override = null) {
  if (override) return override;
  try { return resolveCorpusScope(db, state.corpus); } catch { return null; }
}

/** Collection ids in the view's corpus or corpora, after its coll filter (values may be ids or slugs; '-x' excludes). */
function scopeCollections(db, state, scope = viewScope(db, state)) {
  const rows = stmt(db, 'SELECT c.id, c.slug FROM collection c WHERE c.corpus_id IN (SELECT value FROM json_each(?)) ORDER BY c.id')
    .all(JSON.stringify(scope?.ids ?? []));
  const coll = state.f?.coll ?? [];
  const inc = coll.filter((v) => !v.startsWith('-'));
  const exc = coll.filter((v) => v.startsWith('-')).map((v) => v.slice(1));
  return rows.filter((c) => (!inc.length || inc.includes(c.slug) || inc.includes(String(c.id)))
    && !exc.includes(c.slug) && !exc.includes(String(c.id))).map((c) => c.id);
}

/** The expression ids an expression strand stands for: itself, or its sibling in every member of a virtual corpus. */
function strandMemberIds(db, scope, id) {
  if (!scope?.virtual) return [id];
  const expr = stmt(db, 'SELECT * FROM expression WHERE id = ?').get(id);
  if (!expr) return [id];
  return siblingExpressions(db, expr, scope.members).map((s) => s.expr?.id).filter(Number.isSafeInteger);
}

/**
 * Raw counts of a view's scope: documents, passages, quality='ok' text tokens, and per expression strand the
 * materialized matches (summed over the members of a virtual corpus). With `asSaved`, only documents of imports ≤ the
 * cutoff that existed at save time count (soft-deleted later still count) and strands use the pinned materialize runs.
 * @returns {{documents: number, passages: number, tokens: number, strands: Record<string, {n: number, docs: number, run: number,
 *   runs?: Record<string, number>}>}}
 */
export function viewCounts(db, view, { asSaved = false, scope: override = null } = {}) {
  const state = view.state;
  const scope = viewScope(db, state, override);
  const colls = JSON.stringify(scopeCollections(db, state, scope));
  // as saved: imports ≤ the cutoff that had committed by then; documents soft-deleted later still count
  const docFilter = asSaved
    ? `d.collection_id IN (SELECT value FROM json_each(?)) AND d.import_batch_id <= ? AND (d.deleted_at IS NULL OR d.deleted_at > ?)
       AND EXISTS (SELECT 1 FROM import_batch b WHERE b.id = d.import_batch_id AND (b.committed_at IS NULL OR b.committed_at <= ?))`
    : 'd.collection_id IN (SELECT value FROM json_each(?)) AND d.deleted_at IS NULL';
  const docArgs = asSaved ? [colls, view.max_import_batch, view.created_at, view.created_at] : [colls];
  const docs = stmt(db, `SELECT count(*) AS n, COALESCE(SUM(d.passage_count), 0) AS p FROM document d WHERE ${docFilter}`).get(...docArgs);
  const tokens = stmt(db, `SELECT COALESCE(SUM(t.tokens), 0) AS n FROM doc_tokens t JOIN document d ON d.id = t.document_id
    WHERE t.field_class = 'text' AND ${docFilter}`).get(...docArgs).n;
  const strands = {};
  const pinned = view.runIds?.materialize ?? {};
  const current = (id) => stmt(db, "SELECT run_id FROM expression_state WHERE expression_id = ? AND status = 'ready'").get(id)?.run_id ?? null;
  for (const s of state.strands ?? []) {
    if (s.type !== 'expression' || !Number.isSafeInteger(Number(s.id))) continue;
    const key = String(s.id);
    let n = 0, docsN = 0, first = null;
    const runs = {};
    for (const id of strandMemberIds(db, scope, Number(s.id))) {
      const run = asSaved ? pinned[String(id)] : current(id) ?? pinned[String(id)];
      if (!Number.isSafeInteger(run)) continue;
      const r = stmt(db, `SELECT COALESCE(SUM(e.n), 0) AS n, COUNT(DISTINCT e.document_id) AS docs FROM expr_doc e
        JOIN document d ON d.id = e.document_id WHERE e.expression_id = ? AND e.run_id = ? AND ${docFilter}`)
        .get(id, run, ...docArgs);
      n += r.n; docsN += r.docs; runs[String(id)] = run;
      if (first === null) first = run;
    }
    if (first === null) continue;
    strands[key] = { n, docs: docsN, run: first, ...(Object.keys(runs).length > 1 ? { runs } : {}) };
  }
  return { documents: docs.n, passages: docs.p, tokens, strands };
}

// ── rows → JSON ─────────────────────────────────────────────────────────────────────────────────────

function viewRow(db, slug, { includeDeleted = false } = {}) {
  if (typeof slug !== 'string' || !slug) throw notFound(slug);
  const v = stmt(db, 'SELECT * FROM saved_view WHERE slug = ?').get(slug);
  if (!v || (v.deleted_at && !includeDeleted)) throw notFound(slug);
  return v;
}

function hydrate(db, v) {
  const state = parseJson(v.state_json, {});
  const corpus = stmt(db, 'SELECT is_synthetic FROM corpus WHERE slug = ?').get(state.corpus);
  return { ...v, state, runIds: parseJson(v.run_ids_json, {}), synthetic: corpus?.is_synthetic === 1 };
}

/** Succeeded runs newer than a pinned one, of the same stage and scope ("A newer analysis exists (run #19)"). */
function newerRuns(db, runIds) {
  const out = [];
  const newerThan = (pinnedId, label) => {
    const pinned = runRow(db, pinnedId);
    if (!pinned) return;
    const newer = stmt(db, `SELECT id FROM analysis_run WHERE stage = ? AND status = 'succeeded' AND id > ? AND scope_json = ?
      ORDER BY id DESC LIMIT 1`).get(pinned.stage, pinned.id, pinned.scope_json);
    if (newer) out.push({ stage: label, run: newer.id, pinned: pinned.id });
  };
  for (const [expr, id] of Object.entries(runIds.materialize ?? {})) {
    const current = stmt(db, "SELECT run_id FROM expression_state WHERE expression_id = ? AND status = 'ready'").get(Number(expr))?.run_id;
    if (current && current !== id) out.push({ stage: 'materialize', run: current, pinned: id, expression: Number(expr) });
  }
  for (const k of [...PINNED_RUNS, 'boilerplate']) if (Number.isSafeInteger(runIds[k])) newerThan(runIds[k], k);
  return out;
}

function driftOf(db, v) {
  const current = dataVersion(db);
  const importsSince = stmt(db, `SELECT b.id, b.file_name, c.slug AS collection, b.committed_at FROM import_batch b
    LEFT JOIN collection c ON c.id = b.collection_id WHERE b.status = 'committed' AND b.id > ? ORDER BY b.id`)
    .all(v.max_import_batch).map((b) => ({ batch: b.id, file: b.file_name ?? null, collection: b.collection ?? null, committed_at: b.committed_at }));
  // imports of the view's scope reverted after its save: 'as saved' still counts their (soft-deleted) documents (D17)
  const revertedSince = stmt(db, `SELECT b.id, b.file_name, c.slug AS collection, MAX(d.deleted_at) AS reverted_at FROM import_batch b
    JOIN document d ON d.import_batch_id = b.id LEFT JOIN collection c ON c.id = b.collection_id
    WHERE b.status = 'reverted' AND b.id <= ? AND d.deleted_at > ? GROUP BY b.id ORDER BY b.id`)
    .all(v.max_import_batch, v.created_at)
    .map((b) => ({ batch: b.id, file: b.file_name ?? null, collection: b.collection ?? null, reverted_at: b.reverted_at }));
  const changed = current !== v.data_version || importsSince.length > 0 || revertedSince.length > 0;
  const annotationsSince = stmt(db, 'SELECT count(*) AS n FROM annotation_revision WHERE id > ?').get(v.annotation_rev_cutoff).n;
  const reviewsSince = stmt(db, 'SELECT count(*) AS n FROM relationship_revision WHERE id > ?').get(v.relationship_rev_cutoff).n;
  return {
    currentDataVersion: current,
    drift: {
      dataChanged: changed,
      importsSince,
      revertedSince,
      asSavedAvailable: true,
      newerRuns: newerRuns(db, v.runIds),
      annotationsSince,
      relationshipRevisionsSince: reviewsSince,
      message: changed ? `${DRIFT_MESSAGE(v.max_import_batch)}${revertedSince.length ? ` ${REVERTED_NOTE(revertedSince)}` : ''}` : null,
    },
  };
}

function viewJson(db, v, { asSaved = false, scope = null } = {}) {
  const state = asSaved ? { ...v.state, asSaved: true } : v.state;
  const { currentDataVersion, drift } = driftOf(db, v);
  return {
    slug: v.slug,
    name: v.name,
    description: v.description ?? null,
    parent_slug: v.parent_slug ?? null,
    state,
    state_hash: v.state_hash,
    hash: encode(v.state),
    url: `/#view=${v.slug}`,
    savedAt: v.created_at,
    savedBy: v.created_by,
    dataVersion: v.data_version,
    currentDataVersion,
    runIds: v.runIds,
    cutoffs: { import_batch: v.max_import_batch, annotation_rev: v.annotation_rev_cutoff, relationship_rev: v.relationship_rev_cutoff },
    comparisons_tried: v.comparisons_tried,
    asSaved,
    drift,
    counts: { asSaved: viewCounts(db, v, { asSaved: true, scope }), current: viewCounts(db, v, { scope }) },
    synthetic: v.synthetic,
  };
}

// ── API ─────────────────────────────────────────────────────────────────────────────────────────────

function nextSlug(db, root) {
  const rows = stmt(db, "SELECT slug FROM saved_view WHERE slug = ? OR slug LIKE ? ESCAPE '\\'")
    .all(root, `${root.replace(/[\\%_]/g, (c) => `\\${c}`)}~%`);
  let n = 1;
  for (const r of rows) {
    const m = /~(\d+)$/.exec(r.slug);
    if (m && r.slug === `${root}~${m[1]}`) n = Math.max(n, Number(m[1]));
  }
  return `${root}~${n + 1}`;
}

/**
 * POST /api/views { name, state, comparisons_tried?, description?, parent_slug?, author? }.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} body
 * @param {{scope?: object|null}} [opts] a resolved corpus scope instead of state.corpus (tests compose synthetic members)
 * @returns {{slug: string, url: string, dataVersion: number, runIds: object, hash: string, parent_slug: string|null,
 *   savedAt: string, state_hash: string, counts: object, warnings: string[]}}
 */
export function saveView(db, body, { scope = null } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Send a JSON object.', null);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw invalid('A saved view needs a name.', 'name');
  if (name.length > MAX_NAME) throw invalid(`A view name may have at most ${MAX_NAME} characters.`, 'name');
  if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)) throw invalid('A saved view needs its state.', 'state');
  const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim().slice(0, 2000) : null;
  const tried = body.comparisons_tried ?? 0;
  if (!Number.isSafeInteger(tried) || tried < 0) throw invalid('comparisons_tried must be a non-negative integer.', 'comparisons_tried');
  const actor = humanActor(authorName(body.author));
  const warnings = [];
  const state = canonicalize(body.state, warnings);
  const hash = stateHash(state);
  return tx(db, () => {
    const parent = body.parent_slug ?? body.parent ?? null;
    let slug, parentSlug = null;
    if (parent !== null) {
      if (typeof parent !== 'string' || !stmt(db, 'SELECT 1 FROM saved_view WHERE slug = ?').get(parent)) {
        throw new HttpError(404, 'E_NOT_FOUND', `No saved view ${parent} to save from.`, null, { field: 'parent_slug' });
      }
      parentSlug = parent;
      slug = nextSlug(db, parent.split('~')[0]);
    } else {
      const base = `${slugify(name, 40)}-${shortHash(canonicalJson([name, hash]), 4)}`;
      if (stmt(db, 'SELECT 1 FROM saved_view WHERE slug = ?').get(base)) {
        parentSlug = base;
        slug = nextSlug(db, base);
      } else {
        slug = base;
      }
    }
    const runIds = pinnedRuns(db, state, warnings, scope);
    const maxBatch = stmt(db, "SELECT COALESCE(MAX(id), 0) AS n FROM import_batch WHERE status = 'committed'").get().n;
    const annCut = stmt(db, 'SELECT COALESCE(MAX(id), 0) AS n FROM annotation_revision').get().n;
    const relCut = stmt(db, 'SELECT COALESCE(MAX(id), 0) AS n FROM relationship_revision').get().n;
    const dv = dataVersion(db);
    const at = nowIso();
    stmt(db, `INSERT INTO saved_view (slug, parent_slug, name, description, state_json, state_version, state_hash, data_version,
        max_import_batch, run_ids_json, annotation_rev_cutoff, relationship_rev_cutoff, comparisons_tried, snapshot_svg, created_by,
        created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(slug, parentSlug, name, description, canonicalJson(state), VIEWSTATE_VERSION, hash, dv, maxBatch, canonicalJson(runIds),
        annCut, relCut, tried, actor, at);
    const v = hydrate(db, viewRow(db, slug));
    return {
      slug, url: `/#view=${slug}`, dataVersion: dv, runIds, hash: encode(state), parent_slug: parentSlug, savedAt: at,
      state_hash: hash, cutoffs: { import_batch: maxBatch, annotation_rev: annCut, relationship_rev: relCut },
      counts: viewCounts(db, v, { asSaved: true, scope }), warnings, synthetic: v.synthetic,
    };
  });
}

/**
 * GET /api/views/:slug (?as=1 → the state with asSaved: true; the response always carries the cutoffs, pins
 * and both "as saved" and current counts).
 * @returns {object} SHAPES.View
 */
export function getView(db, slug, { asSaved = false, scope = null } = {}) {
  return viewJson(db, hydrate(db, viewRow(db, slug)), { asSaved, scope });
}

/**
 * GET /api/views?q=&limit=&cursor= — newest first; soft-deleted views are not listed.
 * @returns {{items: object[], cursor: string|null}} SHAPES.Views
 */
export function listViews(db, query = {}) {
  const limit = limitParam(query, { max: 200, dflt: 50 });
  const before = decodeCursor(query.cursor)?.before ?? Number.MAX_SAFE_INTEGER;
  const q = typeof query.q === 'string' && query.q.trim() ? `%${query.q.trim().toLowerCase()}%` : null;
  const rows = stmt(db, `SELECT v.id, v.slug, v.name, v.description, v.parent_slug, v.created_at, v.data_version, v.state_json,
      k.is_synthetic FROM saved_view v LEFT JOIN corpus k ON k.slug = json_extract(v.state_json, '$.corpus')
    WHERE v.deleted_at IS NULL AND v.id < ? AND (? IS NULL OR lower(v.name) LIKE ? OR lower(v.slug) LIKE ?)
    ORDER BY v.id DESC LIMIT ?`).all(before, q, q, q, limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map((v) => ({
      slug: v.slug, name: v.name, description: v.description ?? null, savedAt: v.created_at, dataVersion: v.data_version,
      parent_slug: v.parent_slug ?? null, corpus: parseJson(v.state_json, {}).corpus ?? null, synthetic: v.is_synthetic === 1,
    })),
    cursor: rows.length > limit ? encodeCursor({ before: page[page.length - 1].id }) : null,
  };
}

/**
 * DELETE /api/views/:slug — soft delete (deleted_at); the row and its pins stay.
 * @returns {void}
 */
export function deleteView(db, slug) {
  tx(db, () => {
    const v = viewRow(db, slug);
    stmt(db, 'UPDATE saved_view SET deleted_at = ? WHERE id = ?').run(nowIso(), v.id);
  });
}
