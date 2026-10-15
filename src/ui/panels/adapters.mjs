// OWNER: WP7
// panels/adapters.mjs — the Adapters page (SPEC §10, D13, §13 rules 14–16). Staged-source adapters read files
// already under $SCROLLS_DATA/sources/<name>/ (FORMAT.md and MANIFEST.json first); the app never fetches by
// surprise. The STEMM sources come first, then Cipher's and the demo's. Each card shows the probe result, counts,
// caveats, licence and attribution, and the load state; Load starts an adapter-load job whose progress is shown
// on the card with a number ("loading… 41%", never a bare spinner) and a Cancel button. A missing staging says
// which command the person can run themselves. A network adapter stays off until the person approves it.

import { h, clear } from '../core/dom.mjs';
import { formatCount } from '../../shared/format.mjs';
import { renderEmptyCard, renderErrorCard, renderLoadingLine } from './gate-card.mjs';

/** Card groups, in display order. */
export const ADAPTER_GROUPS = Object.freeze([
  Object.freeze({ key: 'stemm', title: 'STEMM sources (staged files)', test: (id) => id.startsWith('stemm.') }),
  Object.freeze({ key: 'cipher', title: 'Cipher (local dataset)', test: (id) => id.startsWith('cipher.') }),
  Object.freeze({ key: 'other', title: 'Other sources', test: () => true }),
]);
/** Job statuses that are still moving. */
const ACTIVE = Object.freeze(['queued', 'running', 'cancelling']);

/**
 * The model of one adapter card.
 * @param {object} a an Adapters item
 */
export function adapterModel(a) {
  const staged = a.staged ?? null;
  const available = a.available !== false && (staged === null ? a.loaded === true || a.access !== 'local-dataset' : staged.manifest_ok !== false && staged.format_ok !== false);
  const counts = staged?.counts ? Object.entries(staged.counts).map(([k, v]) => `${formatCount(v)} ${k.replace(/_/g, ' ')}`).join(' · ') : '';
  return {
    id: a.id,
    label: a.label ?? a.id,
    meta: `${a.id} · v${a.version} · ${a.access}`,
    path: staged?.path ?? null,
    checks: staged ? `MANIFEST.json ${staged.manifest_ok ? 'ok' : 'missing or invalid'} · FORMAT.md ${staged.format_ok ? 'ok' : 'missing or invalid'}` : null,
    counts,
    caveats: Array.isArray(a.caveats) ? a.caveats : [],
    license: a.license,
    attribution: a.attribution ?? null,
    loaded: a.loaded === true,
    lastLoad: a.last_load ? `last loaded ${String(a.last_load.at ?? '').slice(0, 10)}${Number.isInteger(a.last_load.documents) ? ` · ${formatCount(a.last_load.documents)} documents` : ''}` : null,
    unavailable: a.available === false ? a.reason ?? 'not available' : null,
    command: a.command ?? null,
    network: a.access === 'network',
    enabled: a.enabled === true,
    canLoad: a.loadable !== false && (available && a.access !== 'network' || (a.access === 'network' && a.enabled === true)),
    // contract 1.2.0 (M5 gate): STEMM document sources load as a chain of jobs; `load` is the chain's state
    chained: Boolean(a.load),
    liveJob: a.job && ACTIVE.includes(a.job.status) ? a.job.id : null,
    loadState: a.load ? loadStateText(a.load) : null,
    resume: a.load?.resume ?? null,
    note: a.note ?? null,
  };
}

/**
 * Words for the state of a chained load (GET /api/adapters `load`), with its coverage line when it has one.
 * @param {{status: string, message?: string|null, part?: number|null, coverage?: object|null}} load
 * @returns {string}
 */
export function loadStateText(load) {
  const words = { running: 'loading', done: 'loaded', cancelled: 'cancelled (documents already loaded are kept)', failed: 'failed',
    interrupted: 'interrupted (the server restarted)' }[load.status] ?? load.status;
  const cov = load.coverage && typeof load.coverage === 'object' ? Object.entries(load.coverage)
    .filter(([, v]) => v && typeof v === 'object' && Number.isInteger(v.dated_by_evidence))
    .map(([coll, v]) => `${coll}: dated by evidence ${formatCount(v.dated_by_evidence)} · lifetime estimate ${formatCount(v.lifetime_estimate ?? 0)} · undated ${formatCount(v.undated ?? 0)} · after 1928 ${formatCount(v.after_1928 ?? 0)}`) : [];
  return [`Last load: ${words}`, load.message ?? null, ...cov].filter(Boolean).join(' · ');
}

/**
 * Words for a load job's progress: "loading… 41% · phase · message" (a number, never a bare spinner), or the
 * finished state.
 * @param {{status?: string, progress?: number, fraction?: number, phase?: string, message?: string, error?: {message?: string}}|null} job
 * @returns {string}
 */
export function progressText(job, { chained = false } = {}) {
  if (!job) return 'starting…';
  const f = Number.isFinite(job.fraction) ? job.fraction : job.progress;
  const pct = Number.isFinite(f) ? `${Math.round(f * 100)}%` : null;
  switch (job.status) {
    case 'queued': return 'queued — waiting for the writer';
    case 'succeeded': return 'loaded';
    case 'failed': return `failed${job.error?.message ? `: ${job.error.message}` : ''}`;
    // a chained load keeps its committed chunks: only the chunk in progress is rolled back (M5 gate, WP2 need)
    case 'cancelled': return chained ? 'cancelled — the chunk in progress was rolled back; documents already loaded are kept, and Load again continues'
      : 'cancelled — nothing half-loaded is kept';
    case 'cancelling': return 'cancelling…';
    case 'interrupted': return 'interrupted (the server restarted)';
    default: return ['loading…', pct, job.phase, job.message].filter(Boolean).join(' · ');
  }
}

/**
 * Mount the Adapters page into #panel.
 * @param {HTMLElement} el
 * @param {{store: object, api: object, announce?: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api } = ctx;
  const announce = ctx.announce ?? (() => {});
  const local = { items: null, error: null, loading: false, results: new Map(), approve: null, jobs: new Map(), streams: new Map(), chained: new Set() };
  const root = h('div.adapters', { hidden: true });
  el.appendChild(root);
  const isOpen = () => store.get().view.panels.right === 'adapters';

  async function load() {
    if (!isOpen()) return;
    local.loading = true; local.error = null;
    render();
    try {
      const res = await api.get('/adapters', null, { key: 'adapters' });
      local.items = Array.isArray(res) ? res : [];
      // a chained load continues as a new job after each ≈ 20 s chunk: follow whichever job is live now
      for (const a of local.items) {
        if (a.job && ACTIVE.includes(a.job.status) && local.jobs.get(a.id) !== a.job.id) {
          store.dispatch({ type: 'UI_JOB', job: { id: a.job.id, type: 'adapter-load', status: a.job.status } });
          follow(a.id, a.job.id, { chained: Boolean(a.load) });
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      local.error = err;
    }
    local.loading = false;
    render();
  }

  // A load job's own stream while the page is open; the shared stream (main.mjs → UI_JOB) keeps it current too.
  function follow(adapterId, jobId, { chained = false } = {}) {
    local.jobs.set(adapterId, jobId);
    if (chained) local.chained.add(adapterId);
    if (local.streams.has(jobId) || typeof api.sse !== 'function') return;
    try {
      const stop = api.sse(`/jobs/${jobId}/events`, {
        progress: (d) => { if (d && typeof d === 'object') store.dispatch({ type: 'UI_JOB', job: { ...d, id: d.job ?? jobId, status: d.status ?? 'running' } }); },
        done: (d) => {
          if (d && typeof d === 'object') store.dispatch({ type: 'UI_JOB', job: { ...d, id: d.job ?? jobId } });
          announce(`${adapterId}: ${progressText(store.get().ui.jobs?.[jobId], { chained: local.chained.has(adapterId) })}`);
          unfollow(jobId);
          // a succeeded chunk may have queued the next one (GET /api/adapters then names it in `job`); a cancelled
          // chained load reports what it kept
          if (d?.status === 'succeeded' || local.chained.has(adapterId)) load();
        },
      });
      local.streams.set(jobId, stop);
    } catch { /* the shared stream still updates the job */ }
  }
  function unfollow(jobId) {
    const stop = local.streams.get(jobId);
    if (stop) { local.streams.delete(jobId); try { stop(); } catch { /* already closed */ } }
  }

  async function startLoad(m) {
    try {
      const res = await api.post(`/adapters/${encodeURIComponent(m.id)}/load`, {}, { key: `adapter-load-${m.id}` });
      const id = res?.job?.id;
      local.results.delete(m.id);
      if (Number.isInteger(id)) {
        store.dispatch({ type: 'UI_JOB', job: { id, type: 'adapter-load', status: 'queued', progress: 0 } });
        follow(m.id, id, { chained: m.chained || /^stemm\.(gutenberg-stemm|openalex)$/.test(m.id) });
      }
      announce(`${m.label}: load started (job ${id})`);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      local.results.set(m.id, { error: err });
    }
    render();
  }

  async function cancel(m, jobId) {
    try {
      const res = await api.post(`/jobs/${jobId}/cancel`, null, { key: `adapter-cancel-${jobId}` });
      store.dispatch({ type: 'UI_JOB', job: { id: jobId, status: res?.status === 'cancelled' ? 'cancelled' : 'cancelling' } });
      announce(`${m.label}: cancelling`);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      local.results.set(m.id, { error: err });
      render();
    }
  }

  async function enable(m) {
    try {
      const res = await api.post(`/adapters/${encodeURIComponent(m.id)}/enable`, { approve: true }, { key: `adapter-enable-${m.id}` });
      if (Array.isArray(res)) local.items = local.items.map((a) => res.find((b) => b.id === a.id) ?? a);
      local.results.set(m.id, { ok: 'Enabled with your approval.' });
      local.approve = null;
    } catch (err) {
      if (err?.name === 'AbortError') return;
      local.results.set(m.id, { error: err });
    }
    render();
  }

  function renderJob(m) {
    const jobId = local.jobs.get(m.id);
    if (!Number.isInteger(jobId)) return null;
    const job = store.get().ui.jobs?.[jobId] ?? null;
    const f = Number.isFinite(job?.fraction) ? job.fraction : job?.progress;
    const active = !job || ACTIVE.includes(job.status);
    return h('div.adapter-job', { role: 'status', dataset: { status: job?.status ?? 'queued' } },
      h('div.job-progress', null,
        h('span.job-progress-bar', { style: { width: `${Math.round(Math.max(0, Math.min(1, Number.isFinite(f) ? f : 0)) * 100)}%` } }),
        h('span.job-progress-text', null, `job ${jobId} · ${progressText(job, { chained: local.chained.has(m.id) })}`)),
      job?.status === 'failed' && job.error?.hint ? h('p.meta', null, job.error.hint) : null,
      active && job?.status !== 'cancelling' ? h('button.btn.adapter-cancel', { type: 'button', 'aria-label': `Cancel loading ${m.label}`, onClick: () => cancel(m, jobId) }, 'Cancel') : null);
  }

  function renderCard(a) {
    const m = adapterModel(a);
    const r = local.results.get(m.id);
    const jobId = local.jobs.get(m.id);
    const busy = Number.isInteger(jobId) && ACTIVE.includes(store.get().ui.jobs?.[jobId]?.status ?? 'queued');
    return h('article.adapter-card', { dataset: { adapter: m.id } },
      h('header.adapter-head', null, h('h3', null, m.label), h('span.chip', null, m.loaded ? 'loaded' : 'not loaded')),
      h('p.meta', null, m.meta),
      m.path ? h('p.adapter-path', null, h('span.meta', null, 'staged at '), h('code', null, m.path)) : null,
      m.checks ? h('p.meta', null, m.checks) : null,
      m.counts ? h('p.num.adapter-counts', null, m.counts) : null,
      m.caveats.length ? h('p.adapter-caveat-first', null, m.caveats[0]) : null,
      m.caveats.length > 1 ? h('details.adapter-caveats-box', null, h('summary', null, `${formatCount(m.caveats.length - 1)} more caveat${m.caveats.length === 2 ? '' : 's'}`),
        h('ul.adapter-caveats', { role: 'list' }, m.caveats.slice(1).map((c) => h('li', null, c)))) : null,
      h('dl.adapter-rights', null,
        h('div', null, h('dt', null, 'Licence'), h('dd', null, m.license ?? '—')),
        m.attribution ? h('div', null, h('dt', null, 'Attribution'), h('dd', null, m.attribution)) : null),
      m.lastLoad ? h('p.meta', null, m.lastLoad) : null,
      m.loadState ? h('p.meta.adapter-load-state', null, m.loadState) : null,
      m.resume && !busy ? h('p.meta', null, m.resume) : null,
      m.note ? h('p.meta', null, m.note) : null,
      m.unavailable ? h('div.state-card.is-empty', { role: 'note' }, h('p', null, m.unavailable),
        m.command ? h('p', null, 'Run it yourself when you want it: ', h('code', null, m.command)) : null) : null,
      m.network && !m.enabled ? (local.approve === m.id
        ? h('div.edge-actions', null, h('p', null, 'This adapter uses the network. Enable it?'),
          h('button.btn.btn-primary', { type: 'button', onClick: () => enable(m) }, 'Yes, enable network access'),
          h('button.btn', { type: 'button', onClick: () => { local.approve = null; render(); } }, 'No'))
        : h('button.btn', { type: 'button', onClick: () => { local.approve = m.id; render(); } }, 'Enable (needs your approval)')) : null,
      renderJob(m),
      m.canLoad && !busy ? h('div.edge-actions', null, h('button.btn', { type: 'button', onClick: () => startLoad(m) }, m.loaded ? 'Load again' : 'Load')) : null,
      r?.ok ? h('p.edge-done', { role: 'status' }, r.ok) : null,
      r?.error ? renderErrorCard(r.error) : null);
  }

  function render() {
    root.hidden = !isOpen();
    clear(root);
    if (!isOpen()) return;
    root.appendChild(h('header.cmp-head', null,
      h('button.btn.cmp-back', { type: 'button', onClick: () => store.dispatch({ type: 'CLOSE_PANEL', panel: 'adapters' }), 'aria-label': 'Close Adapters' }, '← Back'),
      h('div.cmp-heading', null, h('h2.cmp-h', null, 'Sources and adapters'),
        h('p.cmp-sub', null, 'Adapters read files already staged on this computer; Scrolls makes no network request on its own.'))));
    if (local.error) { root.appendChild(renderErrorCard(local.error, { onRetry: load })); return; }
    if (local.loading && !local.items) { root.appendChild(renderLoadingLine('Probing staged sources: reading each MANIFEST.json and FORMAT.md…')); return; }
    if (!local.items) return;
    if (!local.items.length) { root.appendChild(renderEmptyCard('No adapter modules are registered.')); return; }
    const left = [...local.items];
    for (const g of ADAPTER_GROUPS) {
      const mine = left.filter((a) => g.test(String(a.id)));
      for (const a of mine) left.splice(left.indexOf(a), 1);
      if (!mine.length) continue;
      root.appendChild(h('section.adapter-group', { 'aria-label': g.title }, h('h3.section-title', null, g.title),
        h('div.adapter-list', null, mine.map(renderCard))));
    }
    root.appendChild(h('p.meta', null, 'Loading writes the staged records into this Scrolls database; the staged files are only read. Attributions travel with every export.'));
  }

  const unsubs = [
    store.subscribe((s) => s.view.panels.right, () => { load(); render(); }),
    // Repaint the progress of the jobs this page started.
    store.subscribe((s) => s.ui.jobs, () => { if (isOpen() && local.jobs.size) render(); }),
  ];
  if (isOpen()) load();
  render();
  return { unmount() { for (const u of unsubs) u(); for (const id of [...local.streams.keys()]) unfollow(id); root.remove(); } };
}
