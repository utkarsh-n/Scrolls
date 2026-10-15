// OWNER: WP3 — contract 1.3.0 (C1)
// clusterlanes.mjs — lanes = context groups of one expression (SPEC §1.3 `cluster`, §4.8). With a succeeded clustering
// run of the pinned expression, every non-residual group is a lane `cluster:<run>:<ord>` and everything else the strand
// counts — residual groups and occurrences the run did not group (too few context words, outside its slice) — is the
// lane `cluster:<run>:residual`, so the lanes partition the strand's counted occurrences and the conservation law holds
// per lane. Groups are computed hypotheses over context words; their labels are machine labels with any human rename
// beside them. Rates divide by the same slice denominators as the expression's language/modality slice, so group rates
// are comparable. Without a run the lanes are empty with lane_state 'not_run' and the run to start; a gated run answers
// 'gated' with its gate (never a group, §13 rule 7). Transitions stay on GET /api/clusters.

import { stmt } from '../db/open.mjs';
import { humanLabels, MACHINE_LABEL_PREFIX } from '../analysis/labels.mjs';
import { latestClusterRun } from '../analysis/transitions.mjs';

const parse = (s, dflt = null) => { try { return JSON.parse(s); } catch { return dflt; } };

/** The lane value of a group and of the residual lane. */
export const groupValue = (run, ord) => `${run}:${ord}`;
export const residualValue = (run) => `${run}:residual`;

/**
 * Resolve the clustering run behind cluster lanes for one expression strand.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} strand a resolved expression strand of a single-corpus def (query.buildDef)
 * @param {number|null} pinned lanes.run of the request (a saved view's run), or null for the newest succeeded run
 * @returns {{state: 'ok'|'not_run'|'gated', run: number|null, materialize: number|null, groups: Array<{id: number, ord: number,
 *   status: string}>, residual: number[], note: string|null, gate?: object, suggestion?: object|null, pinned: boolean}}
 */
export function resolveClusterRun(db, strand, pinned = null) {
  const exprId = strand.members[0].ref;
  const run = pinned
    ? stmt(db, `SELECT * FROM analysis_run WHERE id = ? AND stage = 'cluster' AND status = 'succeeded'
        AND json_extract(scope_json, '$.expression') = ?`).get(pinned, exprId) ?? null
    : latestClusterRun(db, exprId);
  const suggestion = { run: { stage: 'cluster', params: { expressionId: exprId } } };
  const empty = { run: null, materialize: null, groups: [], residual: [], pinned: Boolean(pinned) };
  if (!run) {
    return { ...empty, state: 'not_run', suggestion,
      note: pinned ? `Run ${pinned} is not a succeeded clustering run of this expression.` : 'No clustering run exists for this expression yet.' };
  }
  const params = parse(run.params_json, {}) ?? {};
  const gate = parse(run.gate_json, {})?.cluster ?? { gate: 'ok' };
  if (gate.gate !== 'ok') {
    return { ...empty, run: run.id, state: 'gated', suggestion: null, note: gate.note ?? null,
      gate: { gate: gate.gate, value: null, needed: gate.needed ?? null, have: gate.have ?? null, suggestion: gate.suggestion ?? null } };
  }
  const materialize = Number.isInteger(params.materialize) ? params.materialize : null;
  let sameCounts = false;
  if (!pinned && materialize !== null && strand.run !== null && materialize !== strand.run) {
    // the groups' members are occurrences of an earlier count: a newer materialization needs its own run — unless the
    // newer count found exactly the same matches (a recount after a code change that did not change them, fix pass), in
    // which case the groups still describe this count and are shown over the count they grouped
    if (!sameCount(db, exprId, materialize, strand.run)) {
      return { ...empty, run: run.id, state: 'not_run', suggestion,
        note: `Clustering run #${run.id} grouped an earlier count of this expression (materialization #${materialize}); run it again.` };
    }
    sameCounts = true;
  }
  const clusters = stmt(db, 'SELECT id, ord, status FROM sense_cluster WHERE run_id = ? ORDER BY ord').all(run.id);
  return { run: run.id, materialize, pinned: Boolean(pinned), sameCounts, state: 'ok', note: null, suggestion: null,
    groups: clusters.filter((c) => c.status !== 'residual').map((c) => ({ id: c.id, ord: c.ord, status: c.status })),
    residual: clusters.filter((c) => c.status === 'residual').map((c) => c.id) };
}

/**
 * Whether two materialization runs of an expression counted exactly the same thing: the same per-document rows
 * (language, field class, matches, name-guard hits, passages) — so the occurrence groups of one describe the other.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} exprId
 * @param {number} a run id
 * @param {number} b run id
 * @returns {boolean}
 */
export function sameCount(db, exprId, a, b) {
  const rows = (run) => stmt(db, `SELECT document_id, plang, field_class, n, n_names, n_passages FROM expr_doc
    WHERE expression_id = ? AND run_id = ? ORDER BY document_id, plang, field_class`).all(exprId, run);
  const x = rows(a), y = rows(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const p = x[i], q = y[i];
    if (p.document_id !== q.document_id || p.plang !== q.plang || p.field_class !== q.field_class || p.n !== q.n
      || p.n_names !== q.n_names || p.n_passages !== q.n_passages) return false;
  }
  return true;
}

/**
 * SQL of an occurrence's lane value from its cluster_member row's cluster id column (NULL → residual).
 * @param {{run: number, groups: Array<{id: number, ord: number}>}} cl def.cluster
 * @param {string} idCol e.g. 'm.cluster_id'
 * @returns {string}
 */
export function groupCaseSql(cl, idCol) {
  const whens = cl.groups.map((g) => `WHEN ${Number(g.id)} THEN '${groupValue(cl.run, g.ord)}'`).join(' ');
  return `(CASE ${whens ? `${idCol} ${whens} ` : ''}ELSE '${residualValue(cl.run)}' END)`;
}

/**
 * The join that attaches a run's membership to occurrence alias `o` (alias `m`).
 * @param {{groups: Array<{id: number}>, residual: number[]}} cl
 * @returns {string}
 */
export function memberJoinSql(cl) {
  const ids = [...cl.groups.map((g) => g.id), ...cl.residual].map(Number);
  return `LEFT JOIN cluster_member m ON m.occurrence_id = o.id AND m.cluster_id IN (${ids.length ? ids.join(', ') : 'NULL'})`;
}

/**
 * Lane descriptions of a run: one per group in `ord` order, then the residual lane, with the machine label and any
 * human rename (as of a revision cutoff), stability and status.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} cl def.cluster (state 'ok')
 * @param {{revCutoff?: number|null}} [opts]
 * @returns {Array<{value: string, cluster_id: number|null, ord: number|null, label: {machine: string, human: string|null}, status: string,
 *   tentative: boolean, stability: number|null, size: number|null}>}
 */
export function groupLanes(db, cl, { revCutoff = null } = {}) {
  const rows = stmt(db, 'SELECT id, ord, label_auto, size, n_docs, stability, status FROM sense_cluster WHERE run_id = ? ORDER BY ord').all(cl.run);
  const human = humanLabels(db, rows.map((r) => r.id), { revCutoff });
  const strip = (l) => (l.startsWith(MACHINE_LABEL_PREFIX) ? l.slice(MACHINE_LABEL_PREFIX.length) : l);
  const out = rows.filter((r) => r.status !== 'residual').map((r) => ({
    value: groupValue(cl.run, r.ord), cluster_id: r.id, ord: r.ord,
    label: { machine: r.label_auto, human: human.get(r.id)?.label ?? null },
    text: `Context group ${r.ord}: ${strip(r.label_auto)}${human.get(r.id) ? ` (“${human.get(r.id).label}”)` : ''}`,
    status: r.status, tentative: r.status === 'unstable', stability: r.stability, size: r.size,
  }));
  const residualSize = rows.filter((r) => r.status === 'residual').reduce((s, r) => s + r.size, 0);
  out.push({ value: residualValue(cl.run), cluster_id: null, ord: null, label: { machine: 'other contexts', human: null },
    text: 'Other contexts (residual groups and occurrences the run did not group)', status: 'residual', tentative: false,
    stability: null, size: residualSize });
  return out;
}
