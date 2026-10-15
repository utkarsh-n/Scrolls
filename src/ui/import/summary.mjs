// OWNER: WP1
// import/summary.mjs — the import summary (SPEC §5.7, §8.1): the projected one after the dry run (step 3)
// and the committed one (step 4). Every number carries its unit; a projection says, in its heading, that
// nothing has been written. Library of the wizard: it mounts nothing by itself.

import { formatCount, formatTokens } from '../../shared/format.mjs';
import { h } from '../core/dom.mjs';

const SEVERITY = { fatal: ['⛔', 'fatal'], rejected: ['✕', 'rejected'], warning: ['⚠', 'warning'], info: ['ⓘ', 'info'] };
const DATE_ORDER = ['day', 'month', 'year', 'decade', 'century', 'millennium', 'range', 'circa', 'period', 'scheduled', 'unknown'];
const DATE_WORDS = { unknown: 'undated', scheduled: 'scheduled (after today)', circa: 'circa' };
const n = (x) => formatCount(Number.isFinite(x) ? x : null);

/** Severity as a glyph and a word (never colour alone, §8.7). */
export function severityBadge(severity) {
  const [glyph, word] = SEVERITY[severity] ?? ['•', severity ?? 'issue'];
  return h(`span.imp-sev.imp-sev-${word}`, null, h('span', { 'aria-hidden': 'true' }, `${glyph} `), word);
}

/**
 * One issue as a list item: where, what, and what to do.
 * @param {object} i Issue
 * @returns {HTMLElement}
 */
export function renderIssue(i) {
  const where = [i.line !== null && i.line !== undefined ? `line ${n(i.line)}` : null, i.col ? `column ${n(i.col)}` : null, i.field ? `'${i.field}'` : null]
    .filter(Boolean).join(', ');
  return h('li.imp-issue', { dataset: { severity: i.severity ?? 'warning' } },
    h('div.imp-issue-head', null, severityBadge(i.severity), ' ', h('code', null, i.code), where ? h('span.meta', null, ` · ${where}`) : null),
    h('p', null, i.message),
    i.suggestion ? h('p.imp-suggestion', null, h('span.meta', null, 'What to do: '), i.suggestion) : null,
    i.value_excerpt ? h('p.meta.imp-excerpt', null, 'Value: ', h('q', null, i.value_excerpt)) : null);
}

/** A list of issues, or nothing. */
export function renderIssues(issues, { title = 'Problems found' } = {}) {
  if (!issues?.length) return null;
  return h('section.imp-issues', { 'aria-label': title }, h('h4.imp-h4', null, title), h('ul.imp-issue-list', { role: 'list' }, issues.map(renderIssue)));
}

const stat = (label, value, note = null, wide = false) => h(wide ? 'div.imp-stat.imp-stat-wide' : 'div.imp-stat', null, h('dt', null, label),
  h('dd', null, h('span.num', null, value), note ? h('span.meta', null, ` ${note}`) : null));

/**
 * Render an ImportSummary.
 * @param {object} s ImportSummary (§5.7)
 * @param {{projected?: boolean, downloadUrl?: string|null}} [opts]
 * @returns {HTMLElement}
 */
export function renderSummary(s, { projected = Boolean(s?.projected), downloadUrl = null } = {}) {
  const rows = s.rows ?? {};
  const docs = s.documents ?? {};
  const rels = s.relationships ?? {};
  const dates = s.dates ?? {};
  const title = projected ? 'Projected import — a dry run; nothing has been written yet'
    : s.status && s.status !== 'committed' ? `Import ${s.status}` : `Imported into ${s.collection ?? 'the collection'}`;
  const dl = downloadUrl ?? s.problems?.download ?? null;

  const dateItems = DATE_ORDER.filter((k) => dates[k]).map((k) => h('li', null, h('span.num', null, n(dates[k])), ` ${DATE_WORDS[k] ?? k}`));
  const span = dates.span?.from ? (dates.span.from === dates.span.to ? dates.span.from : `${dates.span.from} – ${dates.span.to}`) : null;
  const langs = Object.entries(s.languages ?? {}).sort((a, b) => b[1] - a[1]);
  const byCode = Object.entries(s.problems?.by_code ?? {}).sort((a, b) => b[1] - a[1]);
  const shownIssues = s.problems?.first ?? [];
  const totalIssues = s.problems?.total ?? byCode.reduce((a, [, c]) => a + c, 0);

  return h('section.imp-summary', { 'aria-label': title, dataset: { projected: projected ? '1' : '0' } },
    h('h4.imp-h4', null, title),
    s.mock_note ? h('p.imp-mock', { role: 'note' }, s.mock_note) : null,
    s.fatal ? h('div.imp-fatal', { role: 'alert' }, h('p', null, severityBadge('fatal'), ' ', h('code', null, s.fatal.code ?? 'error'), ' ', s.fatal.message),
      s.fatal.suggestion ? h('p.imp-suggestion', null, h('span.meta', null, 'What to do: '), s.fatal.suggestion) : null,
      h('p', null, projected ? 'This file would be refused as it is: nothing would be imported.' : 'Nothing from this file was kept.')) : null,
    s.aborted ? h('div.imp-fatal', { role: 'alert' }, h('p', null, `The import stops at line ${n(s.aborted.line)} (a bad row and "stop the whole import"): `, s.aborted.message),
      h('p.imp-suggestion', null, h('span.meta', null, 'What to do: '), s.aborted.suggestion ?? 'Fix that row, or choose "skip it and report it".')) : null,
    h('dl.imp-stats', null,
      stat('Rows seen', n(rows.seen)),
      stat('Accepted', n(rows.accepted), rows.accepted_with_warnings ? `(${n(rows.accepted_with_warnings)} with warnings)` : null),
      stat('Rejected', n(rows.rejected)),
      stat('Documents', n(docs.created), (() => {
        const parts = [docs.metadata_only ? `${n(docs.metadata_only)} title-only` : null,
          docs.duplicates_flagged ? `${n(docs.duplicates_flagged)} duplicates flagged` : null,
          docs.near_duplicates ? `${n(docs.near_duplicates)} near-duplicates` : null,
          docs.translations ? `${n(docs.translations)} translations` : null].filter(Boolean);
        return parts.length ? `(${parts.join(' · ')})` : null;
      })()),
      stat('Passages', n(s.passages)),
      stat('Tokens', formatTokens(s.tokens), s.tokens >= 1000 ? `(${n(s.tokens)})` : null),
      stat('Citations and links', `${n(rels.documented)} documented · ${n(rels.proposed)} proposed`, rels.unresolved_targets ? `· ${n(rels.unresolved_targets)} targets not found` : null, true)),
    h('div.imp-cols', null,
      h('section', { 'aria-label': 'Dates' }, h('h5.imp-h5', null, 'Dates'), h('p.meta', null, 'documents by date precision'),
        dateItems.length ? h('ul.imp-plain', { role: 'list' }, dateItems) : h('p.meta', null, 'No documents.'),
        span ? h('p.meta', null, `Span: ${span}`) : null),
      h('section', { 'aria-label': 'Languages' }, h('h5.imp-h5', null, 'Languages'), h('p.meta', null, 'documents, by the language detected in their text'),
        langs.length ? h('ul.imp-plain', { role: 'list' }, langs.map(([l, c]) => h('li', null, h('span.num', null, n(c)), ` ${l}`)))
          : h('p.meta', null, 'No documents.'))),
    s.mapping_decisions?.length ? h('section', { 'aria-label': 'Mapping decisions' }, h('h5.imp-h5', null, 'Mapping decisions'),
      h('ul.imp-plain.imp-decisions', { role: 'list' }, s.mapping_decisions.map((d) => h('li', null,
        h('code', null, d.target), ' ← ', d.from !== null && d.from !== undefined ? h('code', null, d.from) : h('span.meta', null, 'constant'),
        d.transform ? h('span.meta', null, ` · ${d.transform}`) : null,
        d.parse_rate !== null && d.parse_rate !== undefined ? h('span.meta', null, ` · ${Math.round(d.parse_rate * 1000) / 10}% parse`) : null,
        d.reason ? h('div.meta', null, d.reason) : null)))) : null,
    h('section', { 'aria-label': 'Problems' },
      h('h5.imp-h5', null, totalIssues ? `Problems (${n(totalIssues)})` : 'Problems'),
      byCode.length ? h('ul.imp-plain.imp-codes', { role: 'list' }, byCode.map(([code, c]) => h('li', null, h('code', null, code), ` ${n(c)}`)))
        : h('p.meta', null, 'None.'),
      shownIssues.length ? h('ul.imp-issue-list', { role: 'list' }, shownIssues.map(renderIssue)) : null,
      totalIssues > shownIssues.length ? h('p.meta', null, `Showing the first ${n(shownIssues.length)} of ${n(totalIssues)}.`) : null,
      dl && totalIssues ? h('p', null, h('a.btn', { href: dl, download: '' }, 'Download every problem (CSV)')) : null),
    (s.notes ?? []).length ? h('ul.imp-notes', { role: 'list' }, s.notes.map((x) => h('li.meta', null, x))) : null,
    h('p.meta.imp-foot', null, [
      s.file?.name ? `${s.file.name} · ${s.file.format?.toUpperCase?.() ?? ''} · ${s.file.encoding ?? ''}${s.file.bytes ? ` · ${n(s.file.bytes)} bytes` : ''}` : null,
      s.collection ? `collection ${s.collection}` : null,
      Number.isInteger(s.data_version) ? `data v${s.data_version}` : null,
      Number.isInteger(s.run_id) ? `run ${s.run_id}` : null,
      Number.isFinite(s.duration_ms) ? `${n(s.duration_ms)} ms` : null,
    ].filter(Boolean).join(' · ')));
}

/**
 * Library module: the wizard renders summaries; nothing is mounted on its own.
 * @param {HTMLElement} el
 * @param {object} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  return { unmount() {} };
}

/** Not mounted in a region (the wizard imports it). */
export const region = null;
