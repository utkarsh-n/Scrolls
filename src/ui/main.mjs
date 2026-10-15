// OWNER: WP0 — boot: view state from the URL, store, API, keys, live region, error boundary, health poll, mount
//
// The boot shell (wordmark, toolbar placeholder, SYNTHETIC ribbon for the demo) is painted before any
// package module loads, and stays when one fails: the registry is imported dynamically so that a missing or
// broken module degrades the page instead of blanking it. Placeholders carry `data-boot`; the registry
// removes them once a module has rendered into the same region.

import { decodeHash, stateHash } from '../shared/viewstate.mjs';
import { createStore } from './core/store.mjs';
import { bindUrl, safeStorage, LAST_HASH_KEY } from './core/url.mjs';
import { createApi, isAbort } from './core/api.mjs';
import { createKeys } from './core/keys.mjs';
import { announce } from './core/announce.mjs';
import { h, clear } from './core/dom.mjs';
import { openedView } from './core/savedview.mjs';

/** The ribbon text of §1.11, shown whenever the demo corpus is in scope. */
export const RIBBON_TEXT = 'SYNTHETIC DEMONSTRATION CORPUS — invented people, texts, dates and links.';
export const REDUCED_MOTION_KEY = 'scrolls.reducedMotion';
const SESSION_KEY = 'scrolls.session';
const HEALTH_INTERVAL_MS = 10000;

const reported = new Set();
function logOnce(key, err) {
  if (reported.has(key)) return;
  reported.add(key);
  console.error(`[scrolls] ${key}:`, err);
}

/** A random id per browser tab (kept across reloads of that tab), sent as X-Scrolls-Session. */
function tabSessionId(win) {
  try {
    const have = win.sessionStorage.getItem(SESSION_KEY);
    if (have) return have;
  } catch { /* storage unavailable */ }
  const bytes = new Uint8Array(8);
  win.crypto.getRandomValues(bytes);
  const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  try { win.sessionStorage.setItem(SESSION_KEY, id); } catch { /* storage unavailable */ }
  return id;
}

/**
 * Paint the boot shell into the regions. Returns small setters so boot can update it until the package
 * modules replace it.
 * @param {Document} doc
 */
function renderBootShell(doc) {
  const ribbonEl = doc.getElementById('ribbon');
  const toolbarEl = doc.getElementById('toolbar');
  const scrollEl = doc.getElementById('scroll');

  const ribbon = h('div.ribbon', { dataset: { boot: '' }, role: 'note', hidden: true },
    h('span.ribbon-text', null, RIBBON_TEXT));
  const status = h('span.boot-status', { role: 'status' });
  const toolbar = h('div.boot-toolbar', { dataset: { boot: '' } },
    h('span.wordmark', null, 'Scrolls'),
    h('span.boot-tagline', null, 'A Living Atlas of Meaning'),
    status);
  const note = h('p.boot-note', null, 'Loading the Scroll');
  const scroll = h('div.boot-scroll', { dataset: { boot: '' } },
    note,
    h('div.skeleton-lanes', { 'aria-hidden': 'true' }, [1, 2, 3, 4, 5].map((i) => h('div.skeleton-lane', { style: { '--i': i } }))));

  ribbonEl?.appendChild(ribbon);
  toolbarEl?.appendChild(toolbar);
  scrollEl?.appendChild(scroll);

  return {
    setCorpus(corpus) { ribbon.hidden = corpus !== 'demo'; },
    setStatus(text, kind = 'info') { status.textContent = text; status.dataset.kind = kind; },
    setFailure(text) { note.textContent = text; note.dataset.kind = 'error'; scroll.classList.add('is-failed'); },
  };
}

/** html[data-motion] = 'reduce' | 'full' from the view setting ('system' follows the OS). */
function bindMotion(win, store, storage) {
  const media = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  const apply = () => {
    const rm = store.get().view.reducedMotion;
    const reduce = rm === 'on' || (rm === 'system' && Boolean(media?.matches));
    win.document.documentElement.dataset.motion = reduce ? 'reduce' : 'full';
  };
  apply();
  media?.addEventListener?.('change', apply);
  store.subscribe((s) => s.view.reducedMotion, (rm) => {
    storage.set(REDUCED_MOTION_KEY, rm);
    apply();
  });
}

/** A permanent strip in the ribbon region (outside any module slot) while the server answers from fixtures. */
function showMockBadge(doc) {
  if (doc.getElementById('mock-badge')) return;
  doc.documentElement.dataset.mock = '1';
  const host = doc.getElementById('ribbon') ?? doc.body;
  host.appendChild(h('div#mock-badge.mock-badge', { role: 'note', title: 'SCROLLS_MOCK=1: answers come from tests/contract/*.json' },
    'MOCK API — canned contract fixtures, not your data'));
}

function healthStatus(health) {
  if (!health?.ok) return null;
  const cipher = health.cipher?.message ? ` · Cipher: ${health.cipher.message}` : '';
  return `local server · data v${health.dataVersion}${cipher}`;
}

/**
 * Boot the app into the current page.
 * @param {{ win?: Window }} [opts]
 * @returns {Promise<{store: object, api: object, keys: object}>}
 */
export async function boot({ win = globalThis.window } = {}) {
  const doc = win.document;
  const root = doc.getElementById('app') ?? doc.body;
  const storage = safeStorage(win);
  const shell = renderBootShell(doc);

  // 1. State: the URL hash, else the last view of this browser (a convenience), else the demo default.
  const decoded = decodeHash(win.location.hash || storage.get(LAST_HASH_KEY) || '');
  const state = decoded.state;
  if (state.reducedMotion === 'system') {
    const saved = storage.get(REDUCED_MOTION_KEY);
    if (saved === 'on' || saved === 'off') state.reducedMotion = saved;
  }
  if (decoded.warnings.length) console.warn('[scrolls] the URL was repaired:', decoded.warnings);

  const store = createStore(state);
  store.dispatch({ type: 'UI_SET', key: 'warnings', value: decoded.warnings });
  shell.setCorpus(store.get().view.corpus);
  store.subscribe((s) => s.view.corpus, (corpus) => shell.setCorpus(corpus));
  bindMotion(win, store, storage);

  // 2. Services.
  const mockVariant = new URLSearchParams(win.location.search).get('mock');
  const api = createApi({ base: '/api', sessionId: tabSessionId(win), mockVariant });
  const keys = createKeys();
  doc.addEventListener('keydown', (evt) => {
    if (!evt.defaultPrevented && keys.handle(evt)) evt.preventDefault();
  });

  // 3. Error boundary: log once, tell the user once (server message + hint, §8.8).
  const toastError = (err) => {
    if (isAbort(err)) return;
    const message = err?.message ?? String(err);
    logOnce(`unhandled: ${message}`, err);
    store.dispatch({ type: 'UI_TOAST', toast: { kind: 'error', text: message, hint: err?.hint ?? null } });
  };
  // The browser reports 'ResizeObserver loop completed with undelivered notifications' (or '… limit exceeded') when an
  // observer's callback changes layout; the notifications are delivered on the next frame, nothing failed (M5 gate).
  const benign = (e) => !e.error && /^ResizeObserver loop/.test(String(e.message ?? ''));
  win.addEventListener('error', (e) => { if (!benign(e)) toastError(e.error ?? e.message); });
  win.addEventListener('unhandledrejection', (e) => toastError(e.reason));

  // 4. Saved views: '#view=<slug>' resolves through GET /api/views/:slug (immutable, D17).
  async function openSavedView(slug, asSaved) {
    try {
      const saved = await api.get(`/views/${encodeURIComponent(slug)}`, asSaved ? { as: 1 } : null, { key: 'saved-view' });
      // As saved (D17): pinned runs, cutoffs and the save time — core/savedview.mjs, shared with the verify journey
      const { state: viewState, savedView } = openedView({ ...saved, slug }, asSaved);
      store.dispatch({ type: 'LOAD_STATE', state: viewState, savedView: { ...savedView, stateHash: stateHash(viewState) } });
      if (saved.drift?.dataChanged && saved.drift.message) {
        store.dispatch({ type: 'UI_TOAST', toast: { kind: 'warn', text: saved.drift.message } });
      }
    } catch (err) {
      if (!isAbort(err)) toastError(err);
    }
  }
  bindUrl(store, { win, onSavedView: openSavedView });
  if (decoded.view) openSavedView(decoded.view.slug, decoded.view.asSaved);

  // 5. Health poll (visible tab only) and the shared event stream.
  async function pollHealth() {
    try {
      const health = await api.get('/health', null, { key: 'health' });
      store.dispatch({ type: 'UI_HEALTH', health });
      if (health?.mock) showMockBadge(doc);
      shell.setStatus(healthStatus(health) ?? '', 'info');
    } catch (err) {
      if (isAbort(err)) return;
      store.dispatch({ type: 'UI_HEALTH', health: { ok: false, error: { code: err.code, message: err.message, hint: err.hint ?? null } } });
      shell.setStatus(`${err.message}${err.hint ? ` ${err.hint}` : ''}`, 'error');
    }
  }
  pollHealth();
  win.setInterval(() => { if (doc.visibilityState !== 'hidden') pollHealth(); }, HEALTH_INTERVAL_MS);
  try {
    api.sse('/events', {
      job: (job) => store.dispatch({ type: 'UI_JOB', job }),
      data: (d) => store.dispatch({ type: 'UI_DATA_VERSION', dataVersion: d?.dataVersion }),
      bootstrap: (cipher) => {
        const health = store.get().ui.health;
        if (health?.ok) store.dispatch({ type: 'UI_HEALTH', health: { ...health, cipher: { ...health.cipher, ...cipher } } });
      },
      adapter: (a) => store.dispatch({ type: 'UI_SET', key: 'adapterEvent', value: a }),
    });
  } catch (err) {
    logOnce('event stream unavailable', err);
  }

  // 6. Package modules. A failure here leaves the boot shell up and says so.
  const ctx = {
    store, api, keys, announce,
    onModuleError: (id) => store.dispatch({ type: 'UI_SET', key: 'failedModules', value: [...(store.get().ui.failedModules ?? []), id] }),
  };
  try {
    const registry = await import('./registry.mjs');
    registry.mountApp(root, ctx);
  } catch (err) {
    logOnce('the UI modules could not be loaded', err);
    shell.setFailure('Some parts of Scrolls could not be loaded, so only this shell is shown. Details are in the browser console.');
  }

  win.__SCROLLS__ = Object.freeze({ store, api, keys, announce });
  return { store, api, keys };
}

if (typeof window !== 'undefined' && window.document && !window.__SCROLLS_NO_AUTOBOOT__) {
  boot().catch((err) => {
    logOnce('boot failed', err);
    const scroll = window.document.getElementById('scroll');
    if (scroll) {
      clear(scroll);
      scroll.appendChild(h('p.boot-note', { dataset: { kind: 'error' } }, `Scrolls could not start: ${err?.message ?? err}`));
    }
  });
}
