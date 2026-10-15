// OWNER: WP5
// hypotheses.mjs — competing hypothesis groups (SPEC §2.C, §4.7): a target and a question ("Where does
// Vyas's 2017 line come from?") gathering alternative parent edges from that target. Hypotheses are shown side
// by side with their evidence, authors and review status. Nothing is deleted, and confirming one hypothesis
// leaves the others exactly as they were (never auto-rejected).

import { REL_TYPE_BY_CODE } from '../../src/shared/vocab.mjs';
import { nowIso, stmt, tx } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { appendRelRevision, authorName, humanActor, relationshipRow, resolveRefString } from '../provenance/relationships.mjs';

const TARGET_TYPES = Object.freeze(['passage', 'document', 'occurrence', 'expression', 'cluster', 'etymon']);
const MIN_QUESTION = 5;
const MAX_QUESTION = 500;

const invalid = (message, field, hint = null) => new HttpError(400, 'E_VALIDATION', message, hint, { field });

function groupRow(db, id) {
  const n = Number(id);
  const g = Number.isSafeInteger(n) && n > 0 ? stmt(db, 'SELECT * FROM hypothesis_group WHERE id = ?').get(n) : null;
  if (!g) throw new HttpError(404, 'E_NOT_FOUND', `No hypothesis group ${id}.`);
  return g;
}

/** Who stated a hypothesis, from created_by ('human:Reader A' → 'Reader A'; 'run:9' and adapters kept as is). */
const authorOf = (createdBy) => (createdBy.startsWith('human:') ? createdBy.slice(6) : createdBy);

function labelOf(db, rel) {
  const end = resolveRefString(db, `${rel.dst_type}:${rel.dst_ref}`);
  if (!end) return `from ${rel.dst_type}:${rel.dst_ref}`;
  const what = end.title ?? `${rel.dst_type} ${rel.dst_ref}`;
  return end.dateLabel ? `from ${what} (${end.dateLabel})` : `from ${what}`;
}

/**
 * GET /api/hypothesis-groups/:id — the group with its hypotheses side by side.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number|string} id
 * @returns {object} SHAPES.HypothesisGroup
 */
export function getHypothesisGroup(db, id) {
  const g = groupRow(db, id);
  const rels = stmt(db, `SELECT r.* FROM relationship r WHERE r.hypothesis_group_id = ? AND (r.run_id IS NULL
    OR EXISTS (SELECT 1 FROM analysis_run a WHERE a.id = r.run_id AND a.status IN ('succeeded', 'superseded'))) ORDER BY r.id`).all(g.id);
  const hypotheses = rels.map((r) => {
    const t = REL_TYPE_BY_CODE[r.rel_type];
    return {
      rel_id: r.id,
      rel_type: r.rel_type,
      glyph: t?.glyph ?? null,
      family: t?.family ?? null,
      src: `${r.src_type}:${r.src_ref}`,
      dst: `${r.dst_type}:${r.dst_ref}`,
      label: labelOf(db, r),
      evidence_status: r.evidence_status,
      review_status: r.review_status,
      origin: r.origin,
      author: authorOf(r.created_by),
      method: r.method ?? null,
      score: r.score === null ? null : { value: r.score, kind: r.score_kind },
      evidence: stmt(db, 'SELECT count(*) AS n FROM relationship_evidence WHERE relationship_id = ?').get(r.id).n,
      y: r.dst_year ?? null,
      date_conflict: r.date_conflict === 1,
      synthetic: r.is_synthetic === 1,
    };
  });
  return {
    id: g.id,
    question: g.question,
    target: `${g.target_type}:${g.target_ref}`,
    created_by: g.created_by,
    created_at: g.created_at,
    hypotheses,
    text: `⚖ ${hypotheses.length} competing`,
    note: 'Confirming one hypothesis does not reject the others; each keeps its own evidence and review status.',
    synthetic: g.is_synthetic === 1,
  };
}

/**
 * POST /api/hypothesis-groups { target: 'passage:2210', question, relationships?: [ids], author? } — open a
 * group on a target. `relationships` regroups existing links from that target into it (a 'regroup' revision
 * each; their evidence status is untouched). The same target and question return the existing group.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} body
 * @returns {{id: number, existing: boolean, regrouped: number[]}}
 */
export function createHypothesisGroup(db, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Send a JSON object.', null);
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (question.length < MIN_QUESTION) throw invalid('A hypothesis group needs a question.', 'question');
  if (question.length > MAX_QUESTION) throw invalid(`A question may have at most ${MAX_QUESTION} characters.`, 'question');
  if (typeof body.target !== 'string') throw invalid('target must be a reference like passage:2210.', 'target');
  const target = resolveRefString(db, body.target);
  if (!target) throw new HttpError(404, 'E_NOT_FOUND', `No ${body.target}.`, null, { field: 'target' });
  if (!TARGET_TYPES.includes(target.type)) throw invalid(`A hypothesis group cannot target a ${target.type}.`, 'target');
  const actor = humanActor(authorName(body.author));
  const ids = body.relationships === undefined || body.relationships === null ? [] : body.relationships;
  if (!Array.isArray(ids) || ids.some((x) => !Number.isSafeInteger(x) || x <= 0)) throw invalid('relationships must be a list of ids.', 'relationships');

  return tx(db, () => {
    const found = stmt(db, 'SELECT id FROM hypothesis_group WHERE target_type = ? AND target_ref = ? AND question = ?')
      .get(target.type, target.ref, question);
    const id = found ? found.id : Number(stmt(db, `INSERT INTO hypothesis_group (target_type, target_ref, question, created_by,
        is_synthetic, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(target.type, target.ref, question, actor, target.synthetic ? 1 : 0,
      nowIso()).lastInsertRowid);
    const regrouped = [];
    for (const relId of ids) {
      const rel = relationshipRow(db, relId);
      if (rel.src_type !== target.type || rel.src_ref !== target.ref) {
        throw invalid(`Relationship ${relId} does not start at ${target.type}:${target.ref}; a hypothesis explains where the target came from.`,
          'relationships');
      }
      if (rel.hypothesis_group_id === id) continue;
      stmt(db, 'UPDATE relationship SET hypothesis_group_id = ? WHERE id = ?').run(id, rel.id);
      appendRelRevision(db, rel, { actor, action: 'regroup', reason: question,
        before: { hypothesis_group: rel.hypothesis_group_id ?? null }, after: { hypothesis_group: id } });
      regrouped.push(rel.id);
    }
    return { id, existing: Boolean(found), regrouped };
  });
}
