// OWNER: WP5
// graph.mjs — the bounded lineage graph, "chain of custody" view (SPEC §2.C, §7.2).
//
// Nodes are the items relationships connect (passages, documents, expressions, etymons, clusters, occurrences);
// rows are generations = hops from the root, never meaning. Opens at depth 2 both ways with ≤ 60 nodes; the
// hard cap is 150 nodes, beyond which the response says how many were left out ("Show as list"). Edges carry
// their evidence status (pattern), review status (overlay), type and family; rejected links and the similarity
// pairs kindred/counterpart are hidden unless asked for; rows of an analysis run are visible only when that run
// succeeded (or is pinned by a saved view). Passages whose wording is shared by > 25 documents get one
// "widely shared text (n documents)" node instead of n² quotation edges.

import { EVIDENCE_STATUS, REL_TYPE_BY_CODE } from '../../src/shared/vocab.mjs';
import { stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { resolveRef } from '../provenance/relationships.mjs';
import { reviewStatusOf } from '../provenance/reviews.mjs';
import { commonplaceFor, commonplaceNode } from './commonplace.mjs';

export const DEFAULT_NODES = 60;
export const HARD_CAP = 150;
export const MAX_DEPTH = 6;
/** Similarity pairs hidden from lineage by default (Appendix A: neither is transmission). */
export const HIDDEN_TYPES = Object.freeze(['kindred', 'counterpart']);

const invalid = (message, field) => new HttpError(400, 'E_VALIDATION', message, null, { field });

/** Parsed filters shared by lineage, path and genealogy. */
export function edgeFilters(args = {}) {
  const list = (v) => (v === undefined || v === null || v === '' ? [] : String(v).split(',').map((x) => x.trim()).filter(Boolean));
  const types = list(args.types);
  for (const t of types) if (!REL_TYPE_BY_CODE[t]) throw invalid(`Unknown relationship type '${t}'.`, 'types');
  const status = list(args.status);
  for (const s of status) if (!EVIDENCE_STATUS.includes(s)) throw invalid(`Unknown evidence status '${s}'.`, 'status');
  const runs = list(args.runs).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  let relRevCutoff = null;
  if (args.rel_rev_cutoff !== undefined && args.rel_rev_cutoff !== null && args.rel_rev_cutoff !== '') {
    relRevCutoff = Number(args.rel_rev_cutoff);
    if (!Number.isSafeInteger(relRevCutoff) || relRevCutoff < 0) throw invalid('rel_rev_cutoff must be a non-negative integer.', 'rel_rev_cutoff');
  }
  return {
    types, status, runs, relRevCutoff,
    rejected: args.rejected === '1' || args.rejected === true,
    kindred: args.kindred === '1' || args.kindred === true || types.some((t) => HIDDEN_TYPES.includes(t)),
  };
}

/** SQL condition (on alias r) for the filters; returns [sql, params]. */
export function edgeWhere(f) {
  const where = [`(r.run_id IS NULL OR EXISTS (SELECT 1 FROM analysis_run a WHERE a.id = r.run_id
    AND (a.status = 'succeeded' OR a.id IN (SELECT value FROM json_each(?)))))`];
  const params = [JSON.stringify(f.runs)];
  if (f.types.length) { where.push('r.rel_type IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(f.types)); }
  if (f.status.length) { where.push('r.evidence_status IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(f.status)); }
  if (f.relRevCutoff !== null) {
    // as saved: only links that existed at the view's relationship revision cutoff (review status: see asOfRows)
    where.push('EXISTS (SELECT 1 FROM relationship_revision v WHERE v.relationship_id = r.id AND v.rev = 1 AND v.id <= ?)');
    params.push(f.relRevCutoff);
  } else if (!f.rejected) {
    where.push("r.review_status <> 'rejected'");
  }
  if (!f.kindred) where.push(`r.rel_type NOT IN ('kindred', 'counterpart')`);
  return [where.join(' AND '), params];
}

/**
 * Rows as of a saved view's relationship revision cutoff: the review status each link had then (each reviewer's
 * latest decision up to the cutoff), and rejected-then links dropped unless asked for. Without a cutoff, as is.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} f edgeFilters result
 * @param {object[]} rows relationship rows
 * @returns {object[]}
 */
export function asOfRows(db, f, rows) {
  if (f.relRevCutoff === null) return rows;
  return rows.map((r) => ({ ...r, review_status: reviewStatusOf(stmt(db, `SELECT actor, action FROM relationship_revision
    WHERE relationship_id = ? AND id <= ? ORDER BY rev`).all(r.id, f.relRevCutoff)) }))
    .filter((r) => f.rejected || r.review_status !== 'rejected');
}

/**
 * The JSON form of a relationship row as an edge (lineage, path, genealogy).
 * @param {object} r relationship row
 * @returns {object}
 */
export function edgeJson(r) {
  const t = REL_TYPE_BY_CODE[r.rel_type];
  const out = {
    rel_id: r.id,
    src: `${r.src_type}:${r.src_ref}`,
    dst: `${r.dst_type}:${r.dst_ref}`,
    rel_type: r.rel_type,
    family: t?.family ?? 'similarity',
    glyph: t?.glyph ?? null,
    label: t?.label ?? r.rel_type,
    directed: r.directed === 1,
    evidence_status: r.evidence_status,
    provenance_quality: r.provenance_quality,
    review_status: r.review_status,
    origin: r.origin,
    score: r.score === null ? null : { value: r.score, kind: r.score_kind },
    method: r.method ?? null,
    run_id: r.run_id ?? null,
    hypothesis_group: r.hypothesis_group_id ?? null,
    date_conflict: r.date_conflict === 1,
    source_dataset: r.source_dataset ?? null,
    locator: r.source_locator ?? null,
    created_by: r.created_by,
    // a later item changing how an earlier one is read: feedback-capable types only, never computed similarity
    feedback: Boolean(t?.feedback_capable) && r.evidence_status !== 'computed' && r.date_conflict !== 1,
    synthetic: r.is_synthetic === 1,
  };
  if (r.cue) out.cue = true;
  return out;
}

/**
 * Node card of a reference: document facts for passages/documents/occurrences, a label for the rest.
 * @returns {object|null}
 */
export function nodeJson(db, ref) {
  const i = ref.indexOf(':');
  const type = ref.slice(0, i), id = ref.slice(i + 1);
  const r = resolveRef(db, type, id);
  if (!r) return null;
  const node = { id: ref, type, label: r.title ?? ref, synthetic: r.synthetic === 1 };
  if (r.docId) {
    const d = stmt(db, 'SELECT id, title, kind, y_lo, precision, date_label, chrono_status, author FROM document WHERE id = ?').get(r.docId);
    Object.assign(node, {
      doc: d.id, title: d.title, author: d.author ?? null, kind: d.kind, y: d.y_lo, label: d.date_label, precision: d.precision,
      undated: d.chrono_status !== 'dated',
    });
    if (r.passage) {
      const t = r.passage.field === 'body'
        ? stmt(db, 'SELECT substr(original, ? + 1, ?) AS s FROM document_text WHERE document_id = ?').get(r.passage.start_off, 160, r.docId)
        : stmt(db, 'SELECT substr(value, ? + 1, ?) AS s FROM document_field WHERE document_id = ? AND field = ?').get(r.passage.start_off, 160, r.docId, r.passage.field);
      node.snippet = t?.s?.replace(/\s+/g, ' ').trim() ?? null;
    }
  } else if (type === 'etymon') {
    node.label = `${r.title} (${String(id).split(':')[0]})`;
    node.note = 'period of the language, not a date';
  }
  return node;
}

function edgesOf(db, f, ref, dir, where, params) {
  const i = ref.indexOf(':');
  const type = ref.slice(0, i), id = ref.slice(i + 1);
  const out = [];
  if (dir !== 'in') out.push(...stmt(db, `SELECT r.*, EXISTS (SELECT 1 FROM relationship_evidence e WHERE e.relationship_id = r.id
    AND e.role = 'citation_cue') AS cue FROM relationship r WHERE r.src_type = ? AND r.src_ref = ? AND ${where}`).all(type, id, ...params));
  if (dir !== 'out') out.push(...stmt(db, `SELECT r.*, EXISTS (SELECT 1 FROM relationship_evidence e WHERE e.relationship_id = r.id
    AND e.role = 'citation_cue') AS cue FROM relationship r WHERE r.dst_type = ? AND r.dst_ref = ? AND ${where}`).all(type, id, ...params));
  return asOfRows(db, f, out);
}

/**
 * Bounded expansion of a "widely shared text" node (root=shared:<key>): the node and the passages recorded as made
 * mostly of that text, ≤ max_nodes − 1 of them, each linked to the node (never pairwise); truncation is stated.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} root 'shared:<8 hex digits>'
 * @param {object} args query parameters
 * @returns {object} SHAPES.Lineage
 */
export function commonplaceLineage(db, root, args = {}) {
  const key = root.slice('shared:'.length);
  if (!/^[0-9a-f]{8}$/.test(key)) throw invalid('A widely shared text is shared:<8 hex digits>.', 'root');
  const cp = commonplaceNode(db, key);
  const cap = Math.min(HARD_CAP, Math.max(2, Number.parseInt(args.max_nodes ?? String(DEFAULT_NODES), 10) || DEFAULT_NODES));
  const nodes = [{ id: cp.id, type: 'commonplace', label: cp.label, documents: cp.documents, generation: 0, direction: 'root', synthetic: false,
    expandable: 0 }];
  const links = [];
  let missing = 0;
  for (const pid of cp.passages) {
    if (nodes.length >= cap) break;
    const n = nodeJson(db, `passage:${pid}`);
    if (!n) { missing++; continue; }
    nodes.push({ ...n, generation: 1, direction: 'shares', expandable: 0 });
    links.push({ from: n.id, to: cp.id, kind: 'commonplace' });
  }
  const left = cp.passages.length - missing - links.length;
  const unrecorded = Math.max(0, cp.documents - cp.passages.length);
  return {
    root,
    nodes,
    edges: [],
    groups: [],
    links,
    truncated: left > 0 ? { nodes: left, reason: `showing ${links.length} of ${links.length + left} recorded passages — raise max_nodes` }
      : { nodes: 0, reason: null },
    note: `Text shared by ${cp.documents} documents is drawn as one node, not as pairs.${unrecorded ? ` The pass records up to 50 passages per text; ${unrecorded} more documents hold it.` : ''}`,
    filters: { max_nodes: cap },
    layout: 'x = the Scroll time scale; rows = hops from the root, never meaning',
  };
}

/**
 * GET /api/lineage?root=&depth=&dir=both|in|out&max_nodes=&types=&status=&rejected=&kindred=&runs=&rel_rev_cutoff= — read
 * pool. `runs` and `rel_rev_cutoff` reproduce a saved view "as saved" (its pinned runs and revision cutoff).
 * `in` follows links whose dst is the node (later items that depend on it); `out` follows links whose src is the
 * node (its sources). A passage root also shows the links of its document (node with root_document: true).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {object} args query parameters (strings)
 * @returns {object} SHAPES.Lineage
 */
export function lineageQuery(db, args = {}) {
  const root = String(args.root ?? '');
  if (!/^[a-z_]+:.+/.test(root)) throw invalid("root must be a reference like 'passage:77'.", 'root');
  if (root.startsWith('shared:')) return commonplaceLineage(db, root, args);
  const rootNode = nodeJson(db, root);
  if (!rootNode) throw new HttpError(404, 'E_NOT_FOUND', `No root ${root}.`);
  const depth = Math.min(MAX_DEPTH, Math.max(1, Number.parseInt(args.depth ?? '2', 10) || 2));
  const dir = ['both', 'in', 'out'].includes(args.dir) ? args.dir : 'both';
  const cap = Math.min(HARD_CAP, Math.max(1, Number.parseInt(args.max_nodes ?? String(DEFAULT_NODES), 10) || DEFAULT_NODES));
  const f = edgeFilters(args);
  const [where, params] = edgeWhere(f);

  const nodes = new Map([[root, { ...rootNode, generation: 0, direction: 'root' }]]);
  const edges = new Map();
  let frontier = [root];
  if (rootNode.type === 'passage' && rootNode.doc) {
    const docRef = `document:${rootNode.doc}`;
    if (edgesOf(db, f, docRef, dir, where, params).length) {
      nodes.set(docRef, { ...nodeJson(db, docRef), generation: 0, direction: 'root', root_document: true });
      frontier.push(docRef);
    }
  }
  const hidden = new Set();
  const pending = new Map(); // node → visible edges not drawn
  for (let gen = 1; gen <= depth && frontier.length; gen++) {
    const next = [];
    for (const ref of frontier) {
      for (const r of edgesOf(db, f, ref, dir, where, params)) {
        const other = `${r.src_type}:${r.src_ref}` === ref ? `${r.dst_type}:${r.dst_ref}` : `${r.src_type}:${r.src_ref}`;
        if (!nodes.has(other)) {
          if (nodes.size >= cap) {
            hidden.add(other);
            pending.set(ref, (pending.get(ref) ?? 0) + 1);
            continue;
          }
          const n = nodeJson(db, other);
          if (!n) continue;
          nodes.set(other, { ...n, generation: gen, direction: `${r.dst_type}:${r.dst_ref}` === other ? 'earlier' : 'later' });
          next.push(other);
        }
        edges.set(r.id, edgeJson(r));
      }
    }
    frontier = next;
  }
  // how many visible links each outermost node still has (the ＋ to expand one hop)
  for (const ref of frontier) {
    const extra = edgesOf(db, f, ref, dir, where, params).filter((r) => !edges.has(r.id)).length;
    if (extra) pending.set(ref, (pending.get(ref) ?? 0) + extra);
  }
  for (const [ref, n] of nodes) n.expandable = pending.get(ref) ?? 0;

  const groups = new Map();
  for (const e of edges.values()) {
    if (e.hypothesis_group === null || groups.has(e.hypothesis_group)) continue;
    const g = stmt(db, 'SELECT id, question FROM hypothesis_group WHERE id = ?').get(e.hypothesis_group);
    const members = asOfRows(db, f, stmt(db, `SELECT r.* FROM relationship r WHERE r.hypothesis_group_id = ? AND ${where} ORDER BY r.id`)
      .all(g.id, ...params));
    groups.set(g.id, { id: g.id, question: g.question, edges: members.map((m) => m.id), text: `⚖ ${members.length} competing` });
  }

  const links = [];
  const passages = [...nodes.values()].filter((n) => n.type === 'passage').map((n) => Number(n.id.slice(8)));
  for (const [pid, cp] of commonplaceFor(passages)) {
    const id = `shared:${cp.key}`;
    if (!nodes.has(id)) nodes.set(id, { id, type: 'commonplace', label: `widely shared text (${cp.docs} documents)`, documents: cp.docs, synthetic: false });
    links.push({ from: `passage:${pid}`, to: id, kind: 'commonplace' });
  }

  const truncated = hidden.size
    ? { nodes: hidden.size, reason: cap >= HARD_CAP ? `hard cap ${HARD_CAP} nodes — Show as list` : `showing ${cap} nodes — expand or raise max_nodes` }
    : { nodes: 0, reason: null };
  return {
    root,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    groups: [...groups.values()],
    links,
    truncated,
    filters: { depth, dir, max_nodes: cap, types: f.types, status: f.status, rejected: f.rejected, kindred: f.kindred,
      rel_rev_cutoff: f.relRevCutoff },
    layout: 'x = the Scroll time scale; rows = hops from the root, never meaning',
  };
}
