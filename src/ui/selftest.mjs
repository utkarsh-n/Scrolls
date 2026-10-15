// OWNER: WP8 — the in-browser self-test: open /?selftest=1 (SPEC §11, §12.5)
//
// Checks, in the real page against the real server: every UI module that has a region is mounted (none failed),
// read-only API smoke calls answer with their contract shapes, the Scroll's canvas is painted, and no console
// error, uncaught exception or unhandled rejection happened after the module graph loaded. The result is a small
// overlay, plus window.__SCROLLS_SELFTEST__ and html[data-selftest] = 'running' | 'pass' | 'fail' | 'incomplete' (a check could
// not be judged, e.g. painting while the page is hidden) for scripts.
// Nothing runs — no hook, no request — unless the page URL asks for it; it never writes.

/** Read-only endpoints called by the smoke check, with the shape each must match. */
export const API_CHECKS = Object.freeze([
  { path: '/health', shape: 'Health' },
  { path: '/corpora', shape: 'Corpora' },
  { path: '/jobs', query: { limit: 5 }, shape: 'JobList' },
  { path: '/views', shape: 'Views' },
  { path: '/adapters', shape: 'Adapters' },
]);
const PAINT_TIMEOUT_MS = 20000;   // of visible time: a hidden page paints nothing (requestAnimationFrame is paused)
const HIDDEN_GIVE_UP_MS = 60000;
const MOUNT_TIMEOUT_MS = 10000;
const POLL_MS = 250;
// The browser's own note when a ResizeObserver callback changes layout; nothing failed (main.mjs treats it the same).
const BENIGN = /^ResizeObserver loop/;

/**
 * Whether (and how) the page asked for the self-test.
 * @param {string} search location.search
 * @returns {null|'checks'|'journey'} null: do nothing
 */
export function selftestMode(search) {
  const v = new URLSearchParams(search ?? '').get('selftest');
  if (v === null || v === '0' || v === 'false') return null;
  return v === 'journey' ? 'journey' : 'checks';
}

/**
 * Module ids that must have a slot in the page: those with a region the page has (the selftest's own excluded).
 * @param {ReadonlyArray<{id: string}>} modules registry MODULES
 * @param {(m: object) => string[]} regionsOf registry.regionsOf
 * @param {(region: string) => boolean} hasRegion
 * @returns {string[]}
 */
export function expectedModuleIds(modules, regionsOf, hasRegion) {
  return modules.filter((m) => m.id !== 'selftest.mjs' && regionsOf(m).some(hasRegion)).map((m) => m.id);
}

/**
 * Whether RGBA pixel data holds anything drawn (any pixel with alpha > 0).
 * @param {Uint8ClampedArray|number[]} rgba
 * @returns {boolean}
 */
export function isPainted(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return true;
  return false;
}

/**
 * Overall verdict of a list of check results.
 * @param {Array<{ok: boolean|null, skipped?: boolean}>} results ok null = not judged (skipped) or informational
 * @returns {'pass'|'fail'|'incomplete'} incomplete: nothing failed, but a check could not be judged
 */
export function summarize(results) {
  if (results.some((r) => r.ok === false)) return 'fail';
  return results.some((r) => r.skipped) ? 'incomplete' : 'pass';
}

// ── capture of console errors (installed when this module loads, only when the page asked) ──────────

const captured = [];
let uninstall = null;

function installCapture(win) {
  if (uninstall) return;
  const orig = win.console.error;
  const note = (kind, text) => { if (!BENIGN.test(text)) captured.push({ kind, text: text.slice(0, 300), at: Math.round(win.performance.now()) }); };
  win.console.error = function selftestConsoleError(...args) {
    note('console.error', args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : safeJson(a))).join(' '));
    return orig.apply(this, args);
  };
  const onError = (e) => note('error', String(e.error?.message ?? e.message ?? 'error'));
  const onRejection = (e) => note('unhandledrejection', String(e.reason?.message ?? e.reason ?? 'rejection'));
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  uninstall = () => {
    win.console.error = orig;
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onRejection);
    uninstall = null;
  };
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

if (typeof window !== 'undefined' && window.document && selftestMode(window.location?.search)) installCapture(window);

// ── the checks ───────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkModules(doc, ctx) {
  const { MODULES, regionsOf } = await import('./registry.mjs');
  const hasRegion = (name) => name === 'app' || Boolean(ctx.regions?.[name] ?? doc.getElementById(name));
  const want = expectedModuleIds(MODULES, regionsOf, hasRegion);
  const until = Date.now() + MOUNT_TIMEOUT_MS;
  let missing, failed;
  for (;;) {
    failed = [...new Set(ctx.store?.get().ui.failedModules ?? [])];
    missing = want.filter((id) => !doc.querySelector(`[data-module="${CSS.escape(id)}"]`));
    if ((!missing.length && !failed.length) || Date.now() > until) break;
    await sleep(POLL_MS);
  }
  const bad = [...new Set([...missing, ...failed])];
  return { name: 'modules mounted', ok: bad.length === 0,
    detail: bad.length ? `not mounted: ${bad.join(', ')}` : `${want.length} of ${want.length} modules with a region` };
}

async function checkApi(ctx) {
  const { check } = await import('../shared/contracts.mjs');
  const out = [];
  for (const c of API_CHECKS) {
    const t0 = performance.now();
    try {
      const body = await ctx.api.get(c.path, c.query ?? null);
      const errs = check(c.shape, body);
      const ms = Math.round(performance.now() - t0);
      out.push({ name: `GET /api${c.path}`, ok: errs.length === 0, detail: errs.length ? `${c.shape}: ${errs.slice(0, 2).join('; ')}` : `${c.shape} · ${ms} ms` });
    } catch (err) {
      out.push({ name: `GET /api${c.path}`, ok: false, detail: `${err?.status ?? ''} ${err?.code ?? ''} ${err?.message ?? err}`.trim() });
    }
  }
  return out;
}

/** Sample a few rows of a canvas (a full read of a HiDPI canvas is tens of MB). */
function canvasPainted(cv) {
  if (!cv.width || !cv.height) return false;
  let g;
  try { g = cv.getContext('2d'); } catch { return null; }
  if (!g) return null;
  for (let k = 1; k <= 9; k++) {
    const y = Math.min(cv.height - 1, Math.floor((cv.height * k) / 10));
    if (isPainted(g.getImageData(0, y, cv.width, 1).data)) return true;
  }
  return false;
}

/**
 * The canvas layer that must be painted: with a strand pinned, the data layer (bars and marks), since the background
 * layer paints lanes before any data arrives; with none, any layer.
 * @param {number} strands pinned strands
 * @returns {(layer: string) => boolean}
 */
export function requiredLayer(strands) {
  return strands > 0 ? (layer) => layer === 'data' : () => true;
}

async function checkCanvas(doc, ctx) {
  const strands = ctx.store?.get().view.strands?.length ?? 0;
  const need = requiredLayer(strands);
  const started = Date.now();
  let visibleMs = 0, last = started, layers = [];
  for (;;) {
    const now = Date.now();
    if (doc.visibilityState !== 'hidden') visibleMs += now - last;
    last = now;
    layers = [...doc.querySelectorAll('#scroll canvas')].map((cv) => ({ name: cv.dataset.layer ?? cv.className ?? 'canvas', painted: canvasPainted(cv) }));
    if (layers.some((l) => l.painted && need(l.name)) || visibleMs > PAINT_TIMEOUT_MS) break;
    if (doc.visibilityState === 'hidden' && now - started > HIDDEN_GIVE_UP_MS) {
      return { name: 'Scroll canvas painted', ok: null, skipped: true,
        detail: 'not judged: the page is hidden, and a hidden page does not paint (show it and reload)' };
    }
    await sleep(POLL_MS);
  }
  const painted = layers.filter((l) => l.painted).map((l) => l.name);
  const ok = layers.some((l) => l.painted && need(l.name));
  const what = strands ? `the data layer (${strands} strand${strands === 1 ? '' : 's'} pinned)` : 'a layer';
  return { name: 'Scroll canvas painted', ok,
    detail: !layers.length ? 'no canvas in #scroll'
      : ok ? `painted: ${painted.join(', ')}`
        : `${what} not painted after ${PAINT_TIMEOUT_MS / 1000} s of visible time (painted: ${painted.join(', ') || 'none'})` };
}

function checkConsole() {
  return { name: 'no console errors', ok: captured.length === 0,
    detail: captured.length ? `${captured.length}: ${captured.slice(0, 3).map((c) => `${c.kind}: ${c.text}`).join(' | ')}` : 'none since the modules loaded' };
}

// ── the overlay ──────────────────────────────────────────────────────────────────────────────────────

function overlay(doc) {
  const box = doc.createElement('section');
  box.className = 'selftest-report';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-label', 'Self-test');
  Object.assign(box.style, {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483000', maxWidth: 'min(440px, calc(100vw - 24px))',
    maxHeight: '60vh', overflow: 'auto', padding: '10px 12px', borderRadius: '8px', font: '12px/1.45 ui-monospace, Menlo, monospace',
    background: 'var(--surface-2, #16191e)', color: 'var(--ink, #ede6d6)', border: '1px solid var(--line, #3a3f47)',
    boxShadow: '0 6px 24px rgba(0,0,0,.45)',
  });
  const head = doc.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;gap:12px;font-weight:600;margin-bottom:6px';
  const title = doc.createElement('span');
  const close = doc.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.style.cssText = 'font:inherit;background:none;color:inherit;border:1px solid currentColor;border-radius:4px;padding:0 6px;cursor:pointer';
  close.addEventListener('click', () => box.remove());
  head.append(title, close);
  const list = doc.createElement('ul');
  list.style.cssText = 'list-style:none;margin:0;padding:0';
  box.append(head, list);
  doc.body.appendChild(box);
  return {
    box,
    render(status, results, note) {
      title.textContent = `Self-test: ${status === 'running' ? 'running…' : status.toUpperCase()}`;
      title.style.color = status === 'fail' ? 'var(--danger, #ff6b6b)' : status === 'pass' ? 'var(--ok, #7bd88f)' : 'inherit';
      list.replaceChildren(...results.map((r) => {
        const li = doc.createElement('li');
        li.textContent = `${r.skipped ? 'SKIP' : r.ok === null ? 'INFO' : r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`;
        if (r.ok === false) li.style.color = 'var(--danger, #ff6b6b)';
        return li;
      }), ...(note ? [Object.assign(doc.createElement('li'), { textContent: note })] : []));
    },
  };
}

/**
 * @param {HTMLElement} el this module's slot (only present with ?selftest=…, src/ui/registry.mjs)
 * @param {{store: object, api: object, regions?: Record<string, HTMLElement>}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const win = el?.ownerDocument?.defaultView ?? globalThis.window;
  const mode = selftestMode(win?.location?.search);
  if (!mode) return { unmount() {} };
  const doc = win.document;
  installCapture(win);
  const view = overlay(doc);
  const note = mode === 'journey' ? 'journey mode (writes) is not built here: these are the read-only checks; npm run verify runs the journey over HTTP' : null;
  const results = [];
  let stopped = false;
  const publish = (status) => {
    win.__SCROLLS_SELFTEST__ = Object.freeze({ status, results: results.map((r) => ({ ...r })), errors: captured.slice() });
    doc.documentElement.dataset.selftest = status;
    view.render(status, results, note);
  };
  publish('running');
  (async () => {
    const steps = [() => checkModules(doc, ctx), () => checkApi(ctx), () => checkCanvas(doc, ctx)];
    for (const step of steps) {
      if (stopped) return;
      let r;
      try { r = await step(); } catch (err) { r = { name: 'self-test step', ok: false, detail: String(err?.message ?? err) }; }
      results.push(...(Array.isArray(r) ? r : [r]));
      publish('running');
    }
    if (stopped) return;
    results.push(checkConsole());
    publish(summarize(results));
  })();
  return {
    unmount() {
      stopped = true;
      view.box.remove();
      uninstall?.();
    },
  };
}
