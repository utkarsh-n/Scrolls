// OWNER: WP0 — keeps the URL hash and the store's view in step (SPEC §8.2, D17)
//
// The hash is written with replaceState (throttled to one write per 250 ms) for continuous changes such as
// panning, and with pushState for selection and panel changes so Back undoes them. While an unchanged
// saved view is on screen the hash stays '#view=<slug>' (plus '&as=1' when shown "as saved").

import { decodeHash, encode, stateHash } from '../../shared/viewstate.mjs';
import { canonicalJson } from '../../shared/ids.mjs';

export const LAST_HASH_KEY = 'scrolls.lastHash';
export const REPLACE_THROTTLE_MS = 250;

/**
 * localStorage wrapped in try/catch: a per-viewer convenience that may be missing (private mode,
 * blocked storage) and must never break the app.
 * @param {Window|undefined} win
 * @returns {{ get(key: string): string|null, set(key: string, value: string): void }}
 */
export function safeStorage(win = globalThis.window) {
  return {
    get(key) { try { return win?.localStorage?.getItem(key) ?? null; } catch { return null; } },
    set(key, value) { try { win?.localStorage?.setItem(key, value); } catch { /* storage unavailable */ } },
  };
}

/**
 * The hash that represents an AppState: '#view=<slug>[&as=1]' while the saved view in `ui.savedView` is
 * shown unchanged (same stateHash), otherwise encode(view).
 * @param {{view: object, ui?: {savedView?: {slug: string, asSaved?: boolean, stateHash?: string}|null}}} state
 * @returns {string}
 */
export function hashFor(state) {
  const sv = state.ui?.savedView;
  if (sv?.slug && sv.stateHash && stateHash(state.view) === sv.stateHash) {
    return `#view=${encodeURIComponent(sv.slug)}${sv.asSaved ? '&as=1' : ''}`;
  }
  return encode(state.view);
}

const differs = (a, b) => canonicalJson(a ?? null) !== canonicalJson(b ?? null);

/**
 * Bind the store to the URL hash. Back/forward and edited hashes load into the store (LOAD_STATE); a
 * '#view=<slug>' hash is handed to `onSavedView`, which resolves it through GET /api/views/:slug.
 * The last written hash is kept in localStorage (LAST_HASH_KEY) as a convenience for the next visit.
 * @param {import('./store.mjs').Store} store
 * @param {{ win?: Window, throttleMs?: number, onSavedView?: (slug: string, asSaved: boolean) => void }} [opts]
 * @returns {() => void} unbind
 */
export function bindUrl(store, { win = globalThis.window, throttleMs = REPLACE_THROTTLE_MS, onSavedView = null } = {}) {
  if (!win?.history || !win.location) return () => {};
  const storage = safeStorage(win);
  let written = win.location.hash || '';
  let timer = null;

  function write(push) {
    if (timer) { clearTimeout(timer); timer = null; }
    const hash = hashFor(store.get());
    if (hash === written) return;
    written = hash;
    try {
      win.history[push ? 'pushState' : 'replaceState'](win.history.state, '', `${win.location.pathname}${win.location.search}${hash}`);
    } catch { /* history unavailable (sandboxed frame) */ }
    storage.set(LAST_HASH_KEY, hash);
  }
  const schedule = () => { if (!timer) timer = setTimeout(() => write(false), throttleMs); };

  const unsubView = store.subscribe((s) => s.view, (view, prev) => {
    if (prev && (differs(view.selection, prev.selection) || differs(view.panels, prev.panels))) write(true);
    else schedule();
  });
  const unsubSaved = store.subscribe((s) => s.ui.savedView, schedule);

  function onNavigate() {
    const hash = win.location.hash || '';
    if (hash === written) return;
    written = hash;
    const { state, view } = decodeHash(hash);
    if (view) { onSavedView?.(view.slug, view.asSaved); return; }
    if (encode(state) !== encode(store.get().view)) store.dispatch({ type: 'LOAD_STATE', state, source: 'url' });
  }
  win.addEventListener('popstate', onNavigate);
  win.addEventListener('hashchange', onNavigate);

  // A saved-view hash is resolved by onSavedView; anything else is rewritten in canonical form.
  if (!decodeHash(written).view) write(false);

  return function unbind() {
    if (timer) clearTimeout(timer);
    unsubView();
    unsubSaved();
    win.removeEventListener('popstate', onNavigate);
    win.removeEventListener('hashchange', onNavigate);
  };
}
