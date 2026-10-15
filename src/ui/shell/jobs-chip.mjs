// OWNER: WP6
// shell/jobs-chip.mjs — the jobs chip at the top right (SPEC §1.11, §8.8): the Cipher bootstrap phase with
// its number ("Cipher: importing titles & relations · 12%", never a spinner without a number) and the other
// running jobs. Clicking it asks for the jobs tray (panels/jobs-tray.mjs, WP7) through ui.sheet.

import { formatShare } from '../../shared/format.mjs';
import { h } from '../core/dom.mjs';
import { isAbort } from '../core/api.mjs';
import { icon } from './toolbar.mjs';

const PHASE_WORDS = Object.freeze({
  queued: 'Cipher: queued',
  not_started: 'Cipher: not started',
  metadata: 'Cipher: importing titles & relations',
  fulltext: 'Cipher: full text',
  ready: 'Cipher ready',
  absent: 'Cipher files not found',
  disabled: 'Cipher import off',
  failed: 'Cipher import failed',
  cancelled: 'Cipher import cancelled',
  interrupted: 'Cipher import interrupted',
});

/**
 * Text of the chip.
 * @param {{status: string, progress?: number|null, message?: string|null}|null} cipher health.cipher
 * @param {Array<{type: string, status: string, progress: number}>} running running jobs other than the bootstrap
 * @returns {{text: string, kind: 'busy'|'ok'|'muted'|'error', title: string}}
 */
export function chipText(cipher, running = []) {
  const parts = [];
  let kind = 'muted';
  let title = '';
  if (cipher?.status) {
    const st = cipher.status;
    let t = PHASE_WORDS[st] ?? `Cipher: ${st}`;
    if (st === 'fulltext' && cipher.message) t = `Cipher: ${cipher.message}`;
    if ((st === 'metadata' || st === 'fulltext') && Number.isFinite(cipher.progress)) t += ` · ${formatShare(cipher.progress)}`;
    parts.push(t);
    kind = st === 'ready' ? 'ok' : st === 'failed' || st === 'interrupted' ? 'error' : st === 'metadata' || st === 'fulltext' || st === 'queued' ? 'busy' : 'muted';
    title = cipher.message ?? '';
  }
  const others = running.filter((j) => j.type !== 'bootstrap-cipher');
  if (others.length) {
    const j = others[0];
    parts.push(others.length === 1 ? `${j.type} ${formatShare(j.progress ?? 0)}` : `${others.length} jobs running`);
    if (kind !== 'error') kind = 'busy';
  }
  return { text: parts.join(' · '), kind, title, short: shortText(cipher, others) };
}

/** The chip's short form for tight toolbars and phones: still a number while something runs (§8.8). */
function shortText(cipher, others) {
  const pct = (p) => (Number.isFinite(p) ? formatShare(p) : null);
  if (others.length === 1 && Number.isFinite(others[0].progress)) return pct(others[0].progress);
  if (others.length > 1) return `${others.length} jobs`;
  const st = cipher?.status;
  if (!st) return '';
  if (st === 'metadata' || st === 'fulltext') return pct(cipher.progress) ?? (st === 'fulltext' ? 'full text' : 'metadata');
  return { ready: 'ready', failed: 'failed', interrupted: 'stopped', queued: 'queued', absent: 'no Cipher' }[st] ?? st;
}

/**
 * @param {HTMLElement} el this module's slot in #jobs
 * @param {{store: object, api: object}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api } = ctx;
  const label = h('span.jobs-text');
  const short = h('span.jobs-short', { 'aria-hidden': 'true' });
  const chip = h('button.chip.jobs-chip', { type: 'button', hidden: true, onClick: () => store.dispatch({ type: 'UI_SHEET', sheet: { kind: 'jobs' } }) },
    icon('jobs'), label, short);
  el.appendChild(chip);
  const sync = () => {
    const ui = store.get().ui;
    const running = Object.values(ui.jobs ?? {}).filter((j) => j.status === 'running' || j.status === 'queued');
    const c = chipText(ui.health?.ok ? ui.health.cipher : null, running);
    chip.hidden = !c.text;
    chip.dataset.kind = c.kind;
    label.textContent = c.text;
    short.textContent = c.short ?? '';
    chip.title = c.title ? `${c.title} — open the jobs tray` : 'Open the jobs tray';
    chip.setAttribute('aria-label', `${c.text}. Open the jobs tray.`);
  };
  // The jobs region overlays the toolbar (desktop) or the ribbon (narrow); both keep its width free.
  const region = el.parentElement;
  const app = el.ownerDocument.getElementById('app');
  // Deferred to the next frame: changing the toolbar's padding inside this callback would resize a sibling
  // that is observed too (toolbar.mjs), which the browser reports as a ResizeObserver loop.
  let roRaf = 0;
  const reserve = () => { roRaf = 0; app.style.setProperty('--jobs-w', `${Math.ceil(region.getBoundingClientRect().width) + 8}px`); };
  const ro = region && app && typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (!roRaf) roRaf = requestAnimationFrame(reserve); }) : null;
  ro?.observe(region);
  const a = store.subscribe((s) => s.ui.health, sync, { immediate: true });
  const b = store.subscribe((s) => s.ui.jobs, sync);
  // The job list at start (later changes arrive over the shared event stream).
  api.get('/jobs', { status: 'running' }, { key: 'jobs-chip' }).then((res) => store.dispatch({ type: 'UI_JOBS', jobs: res?.items ?? [] }))
    .catch((err) => { if (!isAbort(err)) { /* the chip still shows the bootstrap from /api/health */ } });
  return { unmount() { a(); b(); ro?.disconnect(); cancelAnimationFrame(roRaf); chip.remove(); } };
}
