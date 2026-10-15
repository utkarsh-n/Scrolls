// OWNER: WP6
// shell/toasts.mjs — toasts (SPEC §8.8): the server's message + hint (+ Retry when the toast carries an
// action); info and notes dismiss themselves, errors stay until closed. Every toast is also announced
// through the polite live region by whoever raised it; this module only shows them.

import { h, clear } from '../core/dom.mjs';

/** Auto-dismiss delay per kind (ms); errors never auto-dismiss. */
export const TOAST_MS = Object.freeze({ info: 6000, note: 4000, ok: 5000, warn: 10000, error: 0 });

/**
 * @param {HTMLElement} el this module's slot in #toasts
 * @param {{store: object}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store } = ctx;
  const timers = new Map();
  const nodes = new Map();

  function render(toasts) {
    const ids = new Set(toasts.map((t) => t.id));
    for (const [id, node] of nodes) {
      if (ids.has(id)) continue;
      node.remove();
      nodes.delete(id);
      clearTimeout(timers.get(id));
      timers.delete(id);
    }
    for (const t of toasts) {
      if (nodes.has(t.id)) continue;
      const dismiss = () => store.dispatch({ type: 'UI_DISMISS_TOAST', id: t.id });
      const node = h(`div.toast.toast-${t.kind}`, { role: t.kind === 'error' ? 'alert' : 'status' },
        h('div.toast-body', null,
          h('p.toast-text', null, t.text),
          t.hint ? h('p.toast-hint', null, t.hint) : null,
          t.action?.label && typeof t.action.run === 'function' ? h('button.btn.toast-action', { type: 'button', onClick: () => { dismiss(); t.action.run(); } }, t.action.label) : null),
        h('button.toast-close', { type: 'button', 'aria-label': 'Dismiss', onClick: dismiss }, '×'));
      nodes.set(t.id, node);
      el.appendChild(node);
      const ms = TOAST_MS[t.kind] ?? TOAST_MS.info;
      if (ms) timers.set(t.id, setTimeout(dismiss, ms));
    }
  }
  const unsub = store.subscribe((s) => s.ui.toasts, render, { immediate: true });
  return {
    unmount() {
      unsub();
      for (const t of timers.values()) clearTimeout(t);
      clear(el);
    },
  };
}
