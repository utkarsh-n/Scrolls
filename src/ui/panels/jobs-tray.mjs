// OWNER: WP7
// panels/jobs-tray.mjs — the jobs tray (SPEC §4.12, §7.2 jobs, §8.8). Lists the jobs of GET /api/jobs, kept
// live by the shared SSE stream (main.mjs turns /api/events `job` events into UI_JOB) and, while the tray is
// open, by each active job's own stream GET /api/jobs/:id/events. Every running job shows a number
// ("counting… 41%"), never a bare spinner; failed jobs show the server's message and hint; Cancel posts
// POST /api/jobs/:id/cancel and the final "cancelled" arrives over SSE. The tray opens from its own button or
// when another module sets ui.sheet to 'jobs' or {kind: 'jobs'} (the jobs chip).

import { h, clear } from '../core/dom.mjs';
import { formatCount } from '../../shared/format.mjs';
import { renderEmptyCard, renderErrorCard } from './gate-card.mjs';

export const JOB_LABELS = Object.freeze({
  '_noop': 'Test job', 'import': 'Import', 'revert': 'Revert an import', 'bootstrap-cipher': 'Cipher import',
  'adapter-load': 'Load a staged source', 'demo-load': 'Load the demo corpus', 'materialize': 'Counting matches',
  'export': 'Export', 'tokstream': 'Token streams', 'collocations': 'Neighbouring terms', 'vectors': 'Word vectors',
  'cluster': 'Context groups', 'drift': 'Displacement measures', 'tone': 'Machine tone', 'layout': 'Constellation layout',
  'boilerplate': 'Boilerplate pass', 'reuse-index': 'Reuse index', 'trace': 'Quotation trace', 'gc-runs': 'Clean up old runs',
});
export const STATUS_WORDS = Object.freeze({
  queued: 'queued', running: 'running', succeeded: 'done', failed: 'failed', cancelling: 'cancelling…',
  cancelled: 'cancelled', interrupted: 'interrupted (the server restarted)',
});
export const ACTIVE_STATUS = Object.freeze(['queued', 'running', 'cancelling']);
/** At most this many per-job event streams at once (browsers allow ~6 connections per origin). */
export const MAX_JOB_STREAMS = 3;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** '79 of 188 documents', or 'k 4 · occurrences 340'. */
export function countsText(counts) {
  if (!isObj(counts)) return '';
  const entries = Object.entries(counts).filter(([, v]) => typeof v === 'number');
  if ('of' in counts && entries.length === 2) {
    const [k, v] = entries.find(([key]) => key !== 'of');
    return `${formatCount(v)} of ${formatCount(counts.of)} ${k.replace(/_/g, ' ')}`;
  }
  return entries.map(([k, v]) => `${k.replace(/_/g, ' ')} ${formatCount(v)}`).join(' · ');
}

/**
 * The model of one job row.
 * @param {object} job a Job row or the merged SSE state of one (store ui.jobs[id])
 */
export function jobRowModel(job) {
  const status = job.status ?? 'queued';
  const active = ACTIVE_STATUS.includes(status);
  const frac = typeof job.progress === 'number' && Number.isFinite(job.progress) ? Math.max(0, Math.min(1, job.progress)) : null;
  const percent = frac === null ? null : Math.round(frac * 100);
  const detail = [job.phase, job.message].filter((x) => typeof x === 'string' && x).join(' · ');
  return {
    id: job.id,
    label: JOB_LABELS[job.type] ?? (job.type ? String(job.type) : `Job ${job.id}`),
    status,
    statusWord: STATUS_WORDS[status] ?? status,
    active,
    percent,
    progressText: percent === null ? '' : `${percent}%`,
    detail,
    counts: countsText(job.counts),
    error: isObj(job.error) ? { code: job.error.code ?? null, message: job.error.message ?? String(job.error.code ?? 'failed'), hint: job.error.hint ?? null } : null,
    canCancel: status === 'queued' || status === 'running',
    run: Number.isInteger(job.run_id) ? `run ${job.run_id}` : '',
  };
}

const ORDER = { running: 0, cancelling: 1, queued: 2 };
/**
 * Active jobs first (running, cancelling, queued), newest first within each; then finished jobs, newest first.
 * @param {Record<string, object>|object[]} jobs
 * @returns {object[]}
 */
export function sortJobs(jobs) {
  const list = Array.isArray(jobs) ? [...jobs] : Object.values(jobs ?? {});
  const when = (j) => j.finished_at ?? j.started_at ?? j.created_at ?? '';
  return list.filter((j) => Number.isInteger(j?.id)).sort((x, y) => {
    const ox = ORDER[x.status] ?? 9, oy = ORDER[y.status] ?? 9;
    if (ox !== oy) return ox - oy;
    if (ox === 9) { const c = String(when(y)).localeCompare(String(when(x))); if (c) return c; }
    return y.id - x.id;
  });
}

/** The jobs chip asks for the tray with ui.sheet = 'jobs' or {kind: 'jobs'}. */
export function isJobsSheet(sheet) {
  return sheet === 'jobs' || (sheet !== null && typeof sheet === 'object' && sheet.kind === 'jobs');
}

/** Number of active jobs. */
export function activeCount(jobs) {
  return Object.values(jobs ?? {}).filter((j) => ACTIVE_STATUS.includes(j?.status)).length;
}

/**
 * Mount the tray into the #jobs region.
 * @param {HTMLElement} el
 * @param {{store: object, api: object, announce?: Function}} ctx
 * @returns {{unmount(): void, open(): void, close(): void}}
 */
export function mount(el, ctx) {
  const { store, api } = ctx;
  const announce = ctx.announce ?? (() => {});
  const local = { open: false, error: null, loaded: false, streams: new Map() };

  const count = h('span.jobs-count.num');
  const button = h('button.btn.jobs-tray-button', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'jobs-tray-panel',
    onClick: () => (local.open ? close() : open()) }, 'Jobs', count);
  const list = h('div.jobs-list');
  const panel = h('section.jobs-panel', { id: 'jobs-tray-panel', 'aria-label': 'Jobs', hidden: true },
    h('div.menu-head', null,
      h('h2.menu-title', null, 'Jobs'),
      h('button.btn', { type: 'button', title: 'Load the staged sources (Gutenberg science shelf, OpenAlex, Wiktionary, Ngram)',
        onClick: () => { close(); store.dispatch({ type: 'OPEN_PANEL', panel: 'adapters' }); } }, 'Sources'),
      h('button.btn', { type: 'button', onClick: () => refresh() }, 'Refresh'),
      h('button.btn.menu-close', { type: 'button', 'aria-label': 'Close jobs', onClick: () => close() }, '×')),
    list);
  const root = h('div.jobs-tray', null, button, panel);
  el.appendChild(root);
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); button.focus?.(); } });

  async function refresh() {
    try {
      const res = await api.get('/jobs', { limit: 20 }, { key: 'jobs-tray' });
      local.error = null; local.loaded = true;
      store.dispatch({ type: 'UI_JOBS', jobs: Array.isArray(res?.items) ? res.items : [] });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      local.error = err; local.loaded = true;
    }
    render();
  }

  async function cancel(id) {
    try {
      const res = await api.post(`/jobs/${id}/cancel`, null, { key: `jobs-cancel-${id}` });
      const st = res?.status;
      if (st === 'cancelling' || st === 'cancelled') {
        store.dispatch({ type: 'UI_JOB', job: { id, status: st } });
        follow(id);
        announce(st === 'cancelled' ? `Job ${id} cancelled` : `Cancelling job ${id}`);
      } else if (st === 'finished') {
        const job = await api.get(`/jobs/${id}`, null, { key: `jobs-get-${id}` });
        store.dispatch({ type: 'UI_JOB', job });
        announce(`Job ${id} had already finished`);
      } else if (st === 'not_found') {
        store.dispatch({ type: 'UI_TOAST', toast: { kind: 'warn', text: `Job ${id} no longer exists.` } });
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      store.dispatch({ type: 'UI_TOAST', toast: { kind: 'error', text: err.message ?? String(err), hint: err.hint ?? null } });
    }
  }

  // Each active job's own stream while the tray is open (the shared stream keeps the rest current).
  function follow(id) {
    if (local.streams.has(id) || local.streams.size >= MAX_JOB_STREAMS || typeof api.sse !== 'function') return;
    try {
      const stop = api.sse(`/jobs/${id}/events`, {
        progress: (d) => { if (isObj(d)) store.dispatch({ type: 'UI_JOB', job: d }); },
        done: (d) => {
          if (isObj(d)) store.dispatch({ type: 'UI_JOB', job: d });
          const job = store.get().ui.jobs[d?.job ?? id];
          announce(`${JOB_LABELS[job?.type] ?? 'Job'} ${d?.job ?? id}: ${STATUS_WORDS[d?.status] ?? d?.status ?? 'finished'}`);
          unfollow(id);
        },
      });
      local.streams.set(id, stop);
    } catch { /* the shared stream still updates the job */ }
  }
  function unfollow(id) {
    const stop = local.streams.get(id);
    if (stop) { local.streams.delete(id); try { stop(); } catch { /* already closed */ } }
  }
  function syncStreams() {
    const jobs = store.get().ui.jobs;
    for (const id of [...local.streams.keys()]) if (!local.open || !ACTIVE_STATUS.includes(jobs[id]?.status)) unfollow(id);
    if (!local.open) return;
    for (const j of sortJobs(jobs)) if (j.status === 'running' || j.status === 'cancelling') follow(j.id);
  }

  function renderRow(job) {
    const m = jobRowModel(job);
    return h('li.job-row', { dataset: { job: String(m.id), status: m.status } },
      h('div.job-line', null,
        h('strong.job-label', null, m.label),
        h('span.job-status', { dataset: { status: m.status } }, m.statusWord),
        h('span.meta.num', null, `#${m.id}`)),
      m.percent !== null && (m.active || m.status === 'failed')
        ? h('div.job-progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(m.percent),
          'aria-label': `${m.label}: ${m.progressText}` },
          h('span.job-progress-bar', { style: { width: `${m.percent}%` } }),
          h('span.job-progress-text.num', null, m.progressText)) : null,
      m.detail ? h('p.job-detail', null, m.detail) : null,
      m.counts ? h('p.meta.num', null, m.counts) : null,
      m.run && m.status === 'succeeded' ? h('p.meta', null, m.run) : null,
      m.error ? h('div.job-error', { role: 'alert' }, h('p', null, m.error.message), m.error.hint ? h('p.state-hint', null, m.error.hint) : null,
        m.error.code ? h('p.meta', null, m.error.code) : null) : null,
      m.canCancel ? h('button.btn.job-cancel', { type: 'button', onClick: () => cancel(m.id), 'aria-label': `Cancel ${m.label} (job ${m.id})` }, 'Cancel') : null);
  }

  function render() {
    const jobs = store.get().ui.jobs;
    const n = activeCount(jobs);
    count.textContent = n ? ` · ${n} active` : '';
    button.setAttribute('aria-expanded', String(local.open));
    panel.hidden = !local.open;
    if (!local.open) return;
    clear(list);
    const rows = sortJobs(jobs).slice(0, 20);
    if (local.error && !rows.length) list.appendChild(renderErrorCard(local.error, { onRetry: refresh }));
    else if (!rows.length) list.appendChild(local.loaded ? renderEmptyCard('No jobs yet.') : h('p.state-loading', { role: 'status' }, 'Loading jobs…'));
    else list.appendChild(h('ul.job-list', { role: 'list' }, rows.map(renderRow)));
  }

  function open() {
    if (local.open) return;
    local.open = true;
    render();
    refresh().then(syncStreams);
  }
  function close() {
    if (!local.open) return;
    local.open = false;
    if (isJobsSheet(store.get().ui.sheet)) store.dispatch({ type: 'UI_SHEET', sheet: null });
    syncStreams();
    render();
  }

  const unsubs = [
    store.subscribe((s) => s.ui.jobs, () => { render(); syncStreams(); }),
    store.subscribe((s) => s.ui.sheet, (sheet) => { if (isJobsSheet(sheet)) open(); }),
  ];
  refresh();
  render();

  return {
    open, close,
    unmount() {
      for (const u of unsubs) u();
      local.open = false;
      syncStreams();
      root.remove();
    },
  };
}
