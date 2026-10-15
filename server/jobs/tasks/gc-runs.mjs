// OWNER: WP5
// tasks/gc-runs.mjs — job 'gc-runs' (SPEC §3 visibility rule, §4.12): remove the rows of cancelled and failed
// analysis runs. Such rows were never visible (every analysis query requires a succeeded run); this reclaims them.
// Only cancelled/failed runs are touched — superseded runs stay, because saved views may pin them. The run rows
// themselves stay (with a note), and so does anything append-only: a relationship that already has a revision,
// and machine annotations (their revisions cannot be deleted); those are counted as kept. Superseded reuse-index
// runs keep their rows and metrics but lose their near-quotation lookup files (units.bin, lsh.bin): only the latest
// run of a scope serves the targeted trace.

import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { nowIso, stmt, tx } from '../../db/open.mjs';

export const type = 'gc-runs';
export const { writes, priority } = JOB_TYPES[type];

// Deletion order respects foreign keys (children first). Each entry: [label, SQL with one ? = run id].
const STEPS = Object.freeze([
  ['relationship_evidence', `DELETE FROM relationship_evidence WHERE relationship_id IN (SELECT r.id FROM relationship r WHERE r.run_id = ?
    AND NOT EXISTS (SELECT 1 FROM relationship_revision v WHERE v.relationship_id = r.id))`],
  ['relationship', `DELETE FROM relationship WHERE run_id = ?
    AND NOT EXISTS (SELECT 1 FROM relationship_revision v WHERE v.relationship_id = relationship.id)`],
  ['hypothesis_group', `DELETE FROM hypothesis_group WHERE created_by = 'run:' || ?
    AND NOT EXISTS (SELECT 1 FROM relationship r WHERE r.hypothesis_group_id = hypothesis_group.id)
    AND NOT EXISTS (SELECT 1 FROM annotation a WHERE a.target_type = 'hypothesis_group' AND a.target_ref = CAST(hypothesis_group.id AS TEXT))`],
  ['cluster_share', 'DELETE FROM cluster_share WHERE cluster_id IN (SELECT id FROM sense_cluster WHERE run_id = ?)'],
  ['cluster_transition', 'DELETE FROM cluster_transition WHERE run_id = ?'],
  ['cluster_member', 'DELETE FROM cluster_member WHERE cluster_id IN (SELECT id FROM sense_cluster WHERE run_id = ?)'],
  ['sense_cluster', `DELETE FROM sense_cluster WHERE run_id = ?
    AND NOT EXISTS (SELECT 1 FROM annotation a WHERE a.target_type = 'cluster' AND a.target_ref = CAST(sense_cluster.id AS TEXT))`],
  ['time_window', 'DELETE FROM time_window WHERE run_id = ? AND NOT EXISTS (SELECT 1 FROM cluster_share s WHERE s.window_id = time_window.id)'],
  ['cluster_member_by_occurrence', 'DELETE FROM cluster_member WHERE occurrence_id IN (SELECT id FROM occurrence WHERE run_id = ?)'],
  ['occurrence', 'DELETE FROM occurrence WHERE run_id = ?'],
  ['expr_doc', 'DELETE FROM expr_doc WHERE run_id = ?'],
  ['collocation', 'DELETE FROM collocation WHERE run_id = ?'],
  ['drift_result', 'DELETE FROM drift_result WHERE run_id = ?'],
  ['space_alignment', 'DELETE FROM space_alignment WHERE run_id = ?'],
  ['vector_space', 'DELETE FROM vector_space WHERE run_id = ? AND NOT EXISTS (SELECT 1 FROM space_alignment a WHERE a.from_space = vector_space.id OR a.to_space = vector_space.id)'],
  ['doc_tag', 'DELETE FROM doc_tag WHERE run_id = ?'],
  ['expression_state', 'UPDATE expression_state SET run_id = NULL WHERE run_id = ?'],
]);

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {{runs?: number[]}} params limit to these run ids (each must be cancelled or failed)
 * @returns {Promise<{runs: number[], rows: Record<string, number>, kept: {relationships: number, annotations: number}, index_files_removed: number}>}
 */
export async function run(ctx, params = {}) {
  const db = ctx.db;
  const only = Array.isArray(params.runs) ? params.runs.filter((n) => Number.isSafeInteger(n)) : null;
  const runs = stmt(db, `SELECT id FROM analysis_run WHERE status IN ('cancelled', 'failed')
    AND (? IS NULL OR id IN (SELECT value FROM json_each(?))) ORDER BY id`).all(only ? 1 : null, JSON.stringify(only ?? [])).map((r) => r.id);
  const rows = Object.fromEntries(STEPS.map(([label]) => [label, 0]));
  const kept = { relationships: 0, annotations: 0 };
  runs.forEach((id, i) => {
    ctx.checkpoint();
    tx(db, () => {
      for (const [label, sql] of STEPS) rows[label] += Number(stmt(db, sql).run(id).changes);
      kept.relationships += stmt(db, 'SELECT count(*) AS n FROM relationship WHERE run_id = ?').get(id).n;
      kept.annotations += stmt(db, 'SELECT count(*) AS n FROM annotation WHERE run_id = ?').get(id).n;
      stmt(db, "UPDATE analysis_run SET notes = trim(COALESCE(notes, '') || ' gc-runs ' || ?) WHERE id = ?").run(nowIso(), id);
    });
    try { rmSync(path.join(ctx.paths.reuse, `run-${id}`), { recursive: true, force: true }); } catch { /* nothing derived */ }
    ctx.progress((i + 1) / runs.length, 'gc', `${i + 1} / ${runs.length} runs`);
  });
  let indexFiles = 0;
  for (const { id } of stmt(db, "SELECT id FROM analysis_run WHERE stage = 'reuse-index' AND status = 'superseded'").all()) {
    for (const f of ['units.bin', 'lsh.bin']) {
      const file = path.join(ctx.paths.reuse, `run-${id}`, f);
      if (!existsSync(file)) continue;
      try { rmSync(file); indexFiles++; } catch { /* a file held open elsewhere is left for the next pass */ }
    }
  }
  return { runs, rows, kept, index_files_removed: indexFiles };
}
