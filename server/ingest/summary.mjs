// OWNER: WP1
// summary.mjs — the import summary object (SPEC §5.7; shape `ImportSummary` in src/shared/contracts.mjs).
//
// One builder serves the dry run (projected: nothing written, data_version and run_id null) and the commit,
// so the two summaries can be compared field by field.

import { describeTransforms } from './mapping.mjs';

/** problems.csv columns, in order (the contract fixture's header). */
export const PROBLEM_COLUMNS = Object.freeze(['code', 'severity', 'line', 'col', 'field', 'value_excerpt', 'message', 'suggestion']);

/** One CSV cell (RFC 4180 quoting). */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One problems.csv line for an issue. */
export function problemLine(issue) {
  return `${PROBLEM_COLUMNS.map((k) => csvCell(issue[k])).join(',')}\n`;
}

/** The header line of problems.csv. */
export const PROBLEMS_HEADER = `${PROBLEM_COLUMNS.join(',')}\n`;

/**
 * Mapping decisions for the summary: one per mapped target, with the column, transforms, the date parse
 * rate where it applies, and the reason (from the suggestion, or "chosen in the mapping step").
 * @param {object} mapping normalized mapping
 * @param {Record<string, {nonEmpty: number, parsed: number}>} dateStats per date target
 * @returns {Array<{target: string, from: string|null, transform: string|null, parse_rate: number|null, reason: string|null}>}
 */
export function mappingDecisions(mapping, dateStats = {}) {
  return Object.entries(mapping.fields).map(([target, spec]) => {
    const st = dateStats[target];
    const rate = st && st.nonEmpty ? Math.round((st.parsed / st.nonEmpty) * 1000) / 1000 : null;
    let reason = spec.reason ?? (spec.const !== undefined ? `constant ${JSON.stringify(spec.const).slice(0, 80)}` : 'chosen in the mapping step');
    if (st && st.nonEmpty) reason += `; ${st.parsed.toLocaleString('en-US')} of ${st.nonEmpty.toLocaleString('en-US')} values parse as dates`;
    return {
      target,
      from: spec.from !== undefined ? String(spec.from) : null,
      transform: describeTransforms(spec.transformList ?? spec.transform ?? []),
      parse_rate: rate,
      reason,
    };
  });
}

/**
 * Assemble an ImportSummary from writer (or projector) counts and the pipeline's row counts.
 * @param {object} counts DocumentWriter counts (finish() or counts())
 * @param {{batchId: number, collection: string, file: object, rows: {seen: number, accepted: number, accepted_with_warnings: number, rejected: number},
 *   mapping: object, dateStats?: object, dataVersion?: number|null, runId?: number|null, startedAt?: string|null,
 *   finishedAt?: string|null, durationMs?: number|null, projected?: boolean, fatal?: object|null, aborted?: object|null,
 *   notes?: string[], status?: string}} info
 * @returns {object} ImportSummary
 */
export function buildSummary(counts, info) {
  const c = counts;
  const summary = {
    import_batch_id: info.batchId,
    collection: info.collection,
    file: {
      name: info.file.name, sha256: info.file.sha256, bytes: info.file.bytes, encoding: info.file.encoding,
      format: info.file.format, delimiter: info.file.delimiter ?? null,
    },
    rows: { ...info.rows },
    documents: {
      created: c.documents.created, duplicates_flagged: c.documents.duplicates_flagged, metadata_only: c.documents.metadata_only,
      translations: c.documents.translations, near_duplicates: c.documents.near_duplicates ?? 0,
    },
    passages: c.passages,
    tokens: c.tokens,
    dates: { ...c.dates },
    languages: { ...c.languages },
    relationships: {
      documented: c.relationships.documented ?? 0, proposed: c.relationships.proposed ?? 0,
      unresolved_targets: c.relationships.unresolved_targets ?? 0, rejected: c.relationships.rejected ?? 0,
    },
    mapping_decisions: mappingDecisions(info.mapping, info.dateStats),
    problems: {
      by_code: { ...c.issues.by_code },
      total: c.issues.total,
      first: c.issues.first.map((i) => ({ code: i.code, severity: i.severity, line: i.line ?? null, col: i.col ?? null,
        field: i.field ?? null, value_excerpt: i.value_excerpt ?? null, message: i.message, suggestion: i.suggestion })),
      download: `/api/imports/${info.batchId}/problems.csv`,
    },
    data_version: info.dataVersion ?? null,
    run_id: info.runId ?? null,
    started_at: info.startedAt ?? null,
    finished_at: info.finishedAt ?? null,
    duration_ms: info.durationMs ?? null,
    projected: Boolean(info.projected),
    status: info.status ?? (info.projected ? 'validated' : 'committed'),
    fatal: info.fatal ?? null,
    aborted: info.aborted ?? null,
    notes: info.notes ?? [],
  };
  return summary;
}
