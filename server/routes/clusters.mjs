// OWNER: WP4
// routes/clusters.mjs — GET /api/clusters?expr=&run=&rev_cutoff= → Clusters (SPEC §4.8, §7.1, §1.8).
//
// The context groups (sense hypotheses) of one expression from a succeeded clustering run (the newest one,
// or the pinned `run` of a saved view): machine labels with the human label beside them, stability, shares
// per window with document-block CIs, computed transitions with their sentences, and convergence with the
// corpus's other tracked expressions. Without a run: gate `not_run` with how to start one (and the job when
// one is queued or running). A run that failed its gate answers the gate, never a group (§13 rule 7).

import { yearLabel } from '../../src/shared/dates.mjs';
import { dataVersion } from '../db/open.mjs';
import { badRequest, HttpError, notFound } from '../http/errors.mjs';
import { humanLabels, MACHINE_LABEL_PREFIX } from '../analysis/labels.mjs';
import { STABILITY } from '../analysis/stability.mjs';
import { latestClusterRun, readClusterRun, transitionText, WINDOW_RULE } from '../analysis/transitions.mjs';
import { CONVERGENCE_CAVEAT } from '../analysis/convergence.mjs';

/** The label every list of context groups carries (§13 rule 11). */
export const CONTEXT_NOTE = 'Context groups are computed hypotheses over context words, not meanings; labels are machine labels (editable).';

const parse = (s, dflt = null) => { try { return JSON.parse(s); } catch { return dflt; } };
const posInt = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const terms = (label) => (label.startsWith(MACHINE_LABEL_PREFIX) ? label.slice(MACHINE_LABEL_PREFIX.length) : label);

/** State of a stored window: uncovered (no tokens, no occurrences), thin (< 30), measured, or a convergence slice. */
export function windowState(w) {
  if (w.scheme === 'slice') return 'slice';
  if (!w.tokens && !w.n_occ) return 'uncovered';
  return w.n_occ >= WINDOW_RULE.minN ? 'measured' : 'thin';
}

function windowNote(w, state) {
  if (state === 'uncovered') return `No sources in ${w.label}.`;
  if (state === 'thin') return `Fewer than ${WINDOW_RULE.minN} occurrences (${w.n_occ}) in ${w.label}: shares not estimated.`;
  if (w.scheme === 'merged_for_min_n') return `Windows merged to reach n ≥ ${WINDOW_RULE.minN}: ${w.label}`;
  return null;
}

/** The newest cluster job of an expression (queued, running or finished), for the not_run card. */
function lastJob(db, exprId) {
  const j = db.prepare(`SELECT id, status, progress, phase, message, error_json FROM job WHERE type = 'cluster'
    AND (json_extract(params_json, '$.expressionId') = ? OR json_extract(params_json, '$.expr') = ?) ORDER BY id DESC LIMIT 1`).get(exprId, exprId);
  if (!j) return null;
  return { id: j.id, status: j.status, progress: j.progress, phase: j.phase, message: j.message, error: parse(j.error_json) };
}

function provenanceOf(db, run, expr, synthetic) {
  const scope = parse(run.scope_json, {});
  const params = parse(run.params_json, {});
  const collections = Array.isArray(scope.collections) ? scope.collections : [];
  const licenses = collections.length ? db.prepare(`SELECT DISTINCT license FROM collection WHERE slug IN (SELECT value FROM json_each(?))
    AND license IS NOT NULL ORDER BY license`).all(JSON.stringify(collections)).map((r) => r.license) : [];
  return { data_version: dataVersion(db), run_ids: { cluster: run.id, materialize: { [expr.id]: params.materialize ?? null } },
    tokenizer: run.tokenizer_version, segmenter: run.segmenter_version, synthetic, collections, licenses };
}

/** Convergence evaluations stored with a run: gated ones carry no value (§13 rule 7). */
function convergenceOf(stored) {
  return stored.convergence.map((d) => {
    const det = parse(d.gate_detail_json, {}) ?? {};
    const other = { id: det.with ?? null, surface: det.surface ?? null };
    const wins = (det.windows ?? []).map((w) => ({ label: w.label, lo: w.lo, hi: w.hi, n: w.n, gated: Boolean(w.gated), J: w.J ?? null,
      C: w.C ?? null, shared: w.shared ?? [] }));
    if (d.gate !== 'ok') {
      return { with: other, gate: d.gate, value: null, ci: null, needed: det.needed ?? null, have: det.have ?? null, suggestion: det.suggestion ?? null,
        note: det.note ?? null, windows: wins, reported: false, evidence_status: 'computed' };
    }
    const a = parse(d.slice_a_json, {}), b = parse(d.slice_b_json, {});
    const first = wins.find((w) => w.label === a.label), last = wins.find((w) => w.label === b.label);
    const reported = Boolean(det.reported);
    const text = `J (shared top-50 significant collocates) ${first?.J ?? '–'} in ${a.label} → ${last?.J ?? '–'} in ${b.label}; `
      + `difference ${d.value} [${d.ci_lo}, ${d.ci_hi}] (document-block bootstrap, ${det.resamples ?? 1000} resamples). `
      + (reported ? 'Reported as convergence. ' : 'Not reported: needs a rise ≥ 0.15 with a CI excluding 0. ') + CONVERGENCE_CAVEAT;
    return { with: other, gate: 'ok', value: d.value, ci: [d.ci_lo, d.ci_hi], first: a.label, last: b.label, windows: wins, reported,
      rule: det.rule ?? null, evidence_status: 'computed', text };
  });
}

/**
 * The Clusters payload. Plain JSON; reads only succeeded runs (visibility rule).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{expr: string|number, run?: string|number, rev_cutoff?: string|number}} args
 * @returns {object} Clusters shape
 */
export function clustersPayload(db, args) {
  const exprId = posInt(args.expr);
  if (exprId === null) throw badRequest('E_VALIDATION', `expr must be an expression id (got '${args.expr ?? ''}').`, 'Track the expression first.', { field: 'expr' });
  const expr = db.prepare('SELECT id, surface, norm, lang, kind, is_synthetic FROM expression WHERE id = ?').get(exprId);
  if (!expr) throw notFound(`Expression ${exprId}`);
  const latest = latestClusterRun(db, exprId);
  let run = latest;
  if (args.run !== undefined && args.run !== null && args.run !== '') {
    const runId = posInt(args.run);
    if (runId === null) throw badRequest('E_BAD_ID', `'${args.run}' is not a run id.`);
    run = db.prepare(`SELECT * FROM analysis_run WHERE id = ? AND stage = 'cluster' AND json_extract(scope_json, '$.expression') = ?`).get(runId, exprId) ?? null;
    if (!run) throw new HttpError(404, 'E_NOT_FOUND', `No run ${runId}.`, 'The run is not a clustering run of this expression.', { run: runId });
    if (run.status !== 'succeeded') {
      throw new HttpError(409, 'E_RUN_NOT_SUCCEEDED', `Run ${runId} is ${run.status}; only succeeded runs are shown.`, null, { run: runId, status: run.status });
    }
  }
  const expression = { id: expr.id, surface: expr.surface, lang: expr.lang, synthetic: expr.is_synthetic === 1 };
  if (!run) {
    const job = lastJob(db, exprId);
    const running = job && ['queued', 'running', 'cancelling'].includes(job.status);
    return { gate: 'not_run', value: null, expr: exprId, expression, needed: { run: 'cluster' }, have: { runs: 0, job },
      suggestion: running ? null : { label: 'Start a clustering run',
        request: { method: 'POST', path: '/api/analysis/runs', body: { stage: 'cluster', expr: exprId } } },
      note: running ? `Clustering is ${job.status} (job ${job.id}).` : job?.status === 'failed'
        ? `The last clustering job (${job.id}) failed: ${job.error?.message ?? 'no message'}` : 'No clustering run exists for this expression yet.',
      fallback_lanes: 'language', synthetic: expression.synthetic };
  }

  const stored = readClusterRun(db, run.id);
  const params = parse(run.params_json, {});
  const metrics = parse(run.metrics_json, {}) ?? {};
  const gate = parse(run.gate_json, {})?.cluster ?? { gate: 'ok' };
  const newer = latest && latest.id > run.id ? latest.id : null;
  const synthetic = expression.synthetic || db.prepare(`SELECT 1 FROM collection WHERE is_synthetic = 1 AND slug IN
    (SELECT value FROM json_each(?)) LIMIT 1`).get(JSON.stringify(parse(run.scope_json, {}).collections ?? [])) !== undefined;
  const runScope = parse(run.scope_json, {}) ?? {};
  // cluster@1.1.0 runs cluster one medium; a top-cited-per-cell scope (OpenAlex) has groups but no windows across cells
  const scope = { modality: runScope.modality ?? null, collections: runScope.collections ?? [], sampled: Boolean(runScope.sampled),
    note: metrics.scope?.note ?? null };
  const base = { run: run.id, representation: run.representation, expr: exprId, expression, seed: run.seed, scope,
    newer_run: newer, newer_note: newer ? `A newer analysis exists (run #${newer}).` : null, synthetic,
    provenance: provenanceOf(db, run, expr, synthetic) };
  if (gate.gate !== 'ok') {
    return { ...base, gate: gate.gate, value: null, needed: gate.needed ?? null, have: gate.have ?? null, suggestion: null,
      note: gate.note ?? null, fallback_lanes: 'language', excluded: { context_thin: metrics.context_thin ?? 0, ...(metrics.excluded ?? {}) },
      selection: metrics.selection?.candidates ?? [], reference: metrics.selection?.reference ?? null, convergence: convergenceOf(stored) };
  }

  const revCutoff = posInt(args.rev_cutoff);
  const human = humanLabels(db, stored.clusters.map((c) => c.id), { revCutoff });
  const byId = new Map(stored.clusters.map((c) => [c.id, c]));
  const ordOf = (id) => byId.get(id)?.ord ?? null;
  const k = stored.clusters.length;
  const clusters = stored.clusters.map((c) => {
    const h = human.get(c.id) ?? null;
    return {
      id: c.id, ord: c.ord, label: c.label_auto, machine_label: c.label_auto,
      human_label: h?.label ?? null, human_label_by: h?.by ?? null, human_label_at: h?.at ?? null, label_annotation: h?.annotation ?? null,
      n: c.size, docs: c.n_docs, top_doc_share: c.top_doc_share, stability: c.stability, silhouette: c.silhouette, status: c.status,
      tentative: c.status === 'unstable', residual: c.status === 'residual',
      first: c.first_year === null ? null : { label: yearLabel(c.first_year), year: c.first_year },
      last: c.last_year === null ? null : { label: yearLabel(c.last_year), year: c.last_year },
      distinctive: parse(c.distinctive_json, []),
      card: [`Run #${run.id}`, `k = ${k}`, c.stability === null ? null : `stability ${c.stability.toFixed(2)}${c.status === 'unstable' ? ' (tentative)' : ''}`,
        `representation: ${run.representation}`, h ? `machine label kept: ${terms(c.label_auto)}` : 'machine label (editable)'].filter(Boolean).join(' · '),
      synthetic,
    };
  });
  const windows = stored.windows.filter((w) => w.scheme !== 'slice').map((w) => {
    const state = windowState(w);
    return { id: w.id, label: w.label, lo: w.lo_year, hi: w.hi_year, scheme: w.scheme, n: w.n_occ, tokens: w.tokens, state, note: windowNote(w, state) };
  });
  const windowById = new Map(stored.windows.map((w) => [w.id, w]));
  const shares = stored.shares.map((s) => ({ cluster: s.cluster_id, window: s.window_id, n: s.n, share: s.share, ci: [s.ci_lo, s.ci_hi] }));
  const labelOf = (ord) => terms(stored.clusters.find((c) => c.ord === ord)?.label_auto ?? '');
  const stabilityOf = (ord) => stored.clusters.find((c) => c.ord === ord)?.stability ?? null;
  const transitions = stored.transitions.filter((t) => t.kind !== 'convergence').map((t) => {
    const note = parse(t.note, {}) ?? {};
    const w = windowById.get(t.window_id);
    const view = { kind: t.kind, from: ordOf(t.from_cluster), to: ordOf(t.to_cluster), score: t.score, year: note.year ?? null,
      nearest: note.nearest ? { ...note.nearest, display: ordOf(note.nearest.cluster) } : null,
      detail: note.apart ? { apart: { window: note.apart.window, cosine: note.apart.cosine } } : null };
    const text = transitionText(view, { window: w?.label ?? '', labelOf, run: run.id, k, stabilityOf, representation: run.representation,
      windowOf: (id) => windowById.get(id)?.label });
    return { kind: t.kind, from: t.from_cluster, to: t.to_cluster, from_ord: view.from, to_ord: view.to, window: t.window_id,
      window_label: w?.label ?? null, year: note.year ?? (w ? w.lo_year : null), cosine: t.kind === 'split' || t.kind === 'merge' ? t.score
        : note.nearest?.cosine ?? null, score: t.score, nearest: note.nearest ?? null, evidence_status: 'computed', text };
  });
  const sel = metrics.selection ?? {};
  return {
    ...base, gate: 'ok', k,
    stability_note: `bootstrap over ${STABILITY.subsamples} subsamples (${Math.round(STABILITY.share * 100)}% of documents)`,
    method: { representation: run.representation, representation_note: metrics.representation_note ?? null, window: metrics.window ?? '±10 tokens',
      weighting: metrics.weighting ?? null, reference: sel.reference ?? null,
      min_context_words: metrics.min_context_words ?? 3, k_rule: sel.rule ?? null, k_reason: sel.reason ?? null, silhouette: metrics.silhouette ?? null,
      mean_ari: metrics.mean_ari ?? null, fit_sample: sel.fit_sample ?? null, seed: run.seed, pipeline_version: run.pipeline_version,
      labels: 'top 4 context words by weighted log-odds with an informative Dirichlet prior (z ≥ 1.96, in-group f ≥ 3)',
      params },
    selection: sel.candidates ?? [],
    clusters, windows, shares, transitions, convergence: convergenceOf(stored),
    ...(metrics.windows_gate ? { windows_gate: metrics.windows_gate } : {}),
    n: metrics.clustered ?? clusters.reduce((s, c) => s + c.n, 0), docs: metrics.documents ?? null,
    excluded: { context_thin: metrics.context_thin ?? 0, date_too_coarse: metrics.date_too_coarse ?? 0, undated: metrics.undated ?? 0,
      ...(metrics.excluded ?? {}) },
    note: CONTEXT_NOTE,
  };
}

/** @type {Array<{method: string, path: string, heavy?: boolean, sse?: boolean, handler: Function}>} */
export const routes = [
  {
    method: 'GET',
    path: '/api/clusters',
    async handler(req, ctx) {
      return { json: clustersPayload(ctx.db, { expr: req.query.expr, run: req.query.run, rev_cutoff: req.query.rev_cutoff }) };
    },
  },
];
