// OWNER: WP6
// shell/ribbon.mjs — the SYNTHETIC ribbon (SPEC §1.11, §9.1, §13 rule 1): striped, across the top, whenever
// the demo corpus is in view or the Scroll shows synthetic material. The text is exactly §1.11's. On narrow
// screens the whole sentence wraps beside the jobs chips (shell.css), never cut or covered.

import { RIBBON_TEXT } from '../main.mjs';
import { h } from '../core/dom.mjs';
import { scrollHub } from '../timeline/viewport.mjs';

/**
 * Should the ribbon show?
 * @param {string} corpus
 * @param {object|null} query the timeline query (its provenance says whether synthetic data is drawn)
 * @returns {boolean}
 */
export function ribbonVisible(corpus, query) {
  return corpus === 'demo' || Boolean(query?.provenance?.synthetic);
}

/**
 * @param {HTMLElement} el this module's slot in #ribbon
 * @param {{store: object}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store } = ctx;
  const ribbon = h('div.ribbon.ribbon-live', { role: 'note', 'aria-label': 'Synthetic data notice' },
    h('button.ribbon-text', { type: 'button', 'aria-expanded': 'false', title: RIBBON_TEXT,
      onClick: (e) => { const on = ribbon.classList.toggle('is-expanded'); e.currentTarget.setAttribute('aria-expanded', String(on)); } }, RIBBON_TEXT));
  el.appendChild(ribbon);
  const sync = () => { ribbon.hidden = !ribbonVisible(store.get().view.corpus, scrollHub.get().query); };
  const a = store.subscribe((s) => s.view.corpus, sync, { immediate: true });
  const b = scrollHub.subscribe(sync);
  return { unmount() { a(); b(); ribbon.remove(); } };
}
