// OWNER: WP6
// shell/filters.mjs — the filter popover (SPEC §7 filter grammar, §13 rule 9): facet values with counts from
// /api/facets (include / exclude), and the default exclusions as visible, labelled toggles — translations,
// retrospective descriptions, editorial apparatus, duplicates, proper-noun-guard hits and boilerplate are
// excluded by default and say so; estimated dates are included by default; synthetic material is shown
// labelled. A badge on the button counts the active filters.

import { formatCount } from '../../shared/format.mjs';
import { formatFilter } from '../../shared/viewstate.mjs';
import { LANE_FACET_LABELS, TOGGLE_DEFAULTS } from '../../shared/vocab.mjs';
import { h, clear, trapFocus } from '../core/dom.mjs';
import { isAbort } from '../core/api.mjs';
import { scrollHub } from '../timeline/viewport.mjs';
import { floatPopover } from './layout.mjs';
import { icon } from './toolbar.mjs';

/** The default-exclusion toggles, in the order of §7, with what turning them on does. */
export const TOGGLE_ROWS = Object.freeze([
  { key: 'tr', label: 'Translations', off: 'excluded: a translated text was not written in the original\'s year (D8)', on: 'included, dated by the original' },
  { key: 'ds', label: 'Retrospective descriptions', off: 'excluded: summaries and glosses describe a work later (D9)', on: 'included' },
  { key: 'ap', label: 'Editorial apparatus', off: 'excluded: prefaces, notes and later editorial text', on: 'included' },
  { key: 'dup', label: 'Duplicates', off: 'excluded: the same text counted once', on: 'included' },
  { key: 'nm', label: 'Proper-noun guard hits', off: 'excluded: names that look like the expression (e.g. a person called Gene)', on: 'included' },
  { key: 'est', label: 'Estimated dates', off: 'excluded', on: 'included, drawn with stripes and ≈' },
  { key: 'bp', label: 'Boilerplate', off: 'excluded: licences and front matter', on: 'included' },
]);
/** Facets offered as filters, in order (keys of the `f` grammar; `lang` is the facets endpoint's name). */
export const FILTER_FACETS = Object.freeze(['community', 'kind', 'lang', 'coll', 'culture', 'field', 'basis']);
const FACET_LABEL = { ...LANE_FACET_LABELS, lang: 'Language', coll: 'Collection', basis: 'Date basis', culture: 'country of origin (Wikidata)', field: 'STEMM field' };

/**
 * Number of active filters and toggles that differ from their defaults.
 * @param {{f: object, toggles: object}} view
 * @returns {number}
 */
export function activeCount(view) {
  let n = 0;
  for (const [k, v] of Object.entries(view.f)) if (k !== 'syn' && Array.isArray(v)) n += v.length;
  if (view.f.syn === 0) n++;
  for (const [k, d] of Object.entries(TOGGLE_DEFAULTS)) if (view.toggles[k] !== d) n++;
  return n;
}

/**
 * Cycle a facet value through include → exclude → off (`basis:-estimated` excludes).
 * @param {string[]} values current values of the facet
 * @param {string} value
 * @returns {string[]}
 */
export function cycleValue(values, value) {
  const set = new Set(values);
  if (set.has(value)) { set.delete(value); set.add(`-${value}`); } else if (set.has(`-${value}`)) set.delete(`-${value}`); else set.add(value);
  return [...set];
}

/**
 * @param {HTMLElement} el this module's slot in #toolbar
 * @param {{store: object, api: object, keys: object, announce: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api, announce } = ctx;
  const cleanups = [];
  let facets = null;
  let facetsErr = null;
  let release = null;

  const count = h('span.tb-count.num', { hidden: true });
  const button = h('button.btn.tb-btn.tb-filters', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Filters and default exclusions',
    onClick: () => toggle() }, icon('filter'), h('span.tb-text', { dataset: { prio: '38' } }, 'Filters'), count);
  const pop = h('div.filters-pop', { role: 'dialog', 'aria-label': 'Filters and default exclusions', hidden: true });
  const wrap = h('div.tb-group.tb-filtergroup', null, button);
  el.appendChild(wrap);
  // Portalled and fixed: the toolbar's overflow never clips it (narrow: a bottom sheet, shell.css).
  const float = floatPopover(pop, () => button, { align: 'end' });
  cleanups.push(() => float.destroy());

  function toggle(force) {
    const open = force ?? pop.hidden;
    pop.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) { load(); render(); float.position(); release = trapFocus(pop); } else { release?.(); release = null; }
    if (store.get().ui.filtersOpen !== open) store.dispatch({ type: 'UI_SET', key: 'filtersOpen', value: open });
  }

  async function load() {
    const v = store.get().view;
    try {
      const res = await api.get('/facets', { corpus: v.corpus, f: formatFilter(v.f) || null }, { key: 'facets' });
      facets = res?.facets ?? {};
      facetsErr = null;
    } catch (err) {
      if (isAbort(err)) return;
      facetsErr = err;
    }
    if (!pop.hidden) render();
  }

  function render() {
    const v = store.get().view;
    clear(pop);
    pop.append(h('div.pop-head', null, h('h2.pop-title', null, 'Filters'),
      h('button.btn.pop-close', { type: 'button', 'aria-label': 'Close filters', onClick: () => toggle(false) }, icon('close'))));
    // Default exclusions first: they change every count (§13 rule 9).
    const tg = h('fieldset.filter-toggles', null, h('legend', null, 'Default exclusions'));
    for (const row of TOGGLE_ROWS) {
      const on = v.toggles[row.key] === 1;
      tg.append(h('label.toggle-row', null,
        h('input', { type: 'checkbox', checked: on, onChange: (e) => { store.dispatch({ type: 'SET_TOGGLE', key: row.key, value: e.target.checked ? 1 : 0 }); announce(`${row.label} ${e.target.checked ? 'included' : 'excluded'}.`); } }),
        h('span.toggle-label', null, row.label),
        h('span.toggle-note.meta', null, on ? row.on : row.off)));
    }
    tg.append(h('label.toggle-row', null,
      h('input', { type: 'checkbox', checked: v.f.syn === 1, onChange: (e) => store.dispatch({ type: 'SET_FILTER', key: 'syn', value: e.target.checked ? 1 : 0 }) }),
      h('span.toggle-label', null, 'Synthetic material'),
      h('span.toggle-note.meta', null, v.f.syn === 1 ? 'shown, always labelled SYNTHETIC' : 'hidden')));
    const totals = scrollHub.get().query?.totals;
    if (totals?.names_excluded) tg.append(h('p.meta', null, `${formatCount(totals.names_excluded)} proper-noun guard hits are excluded from the current Scroll.`));
    pop.append(tg);

    if (facetsErr) {
      pop.append(h('div.pop-error', { role: 'alert' }, h('p', null, facetsErr.message), facetsErr.hint ? h('p.meta', null, facetsErr.hint) : null,
        h('button.btn', { type: 'button', onClick: load }, 'Retry')));
    } else if (!facets) {
      pop.append(h('p.meta', null, 'Counting facet values…'));
    } else {
      const keys = FILTER_FACETS.filter((k) => facets[k]?.length);
      if (!keys.length) pop.append(h('p.meta', null, 'No facet values with these filters. 0 is an observation about this index.'));
      for (const k of keys) {
        const fs = h('fieldset.filter-facet', null, h('legend', null, FACET_LABEL[k] ?? k));
        const current = v.f[k] ?? [];
        for (const val of facets[k]) {
          const state = current.includes(val.value) ? 'include' : current.includes(`-${val.value}`) ? 'exclude' : 'off';
          fs.append(h('button.facet-val', {
            type: 'button', dataset: { state }, 'aria-pressed': state === 'off' ? 'false' : 'true',
            title: state === 'off' ? 'Click to keep only this' : state === 'include' ? 'Click to exclude this' : 'Click to clear',
            onClick: () => store.dispatch({ type: 'SET_FILTER', key: k, values: cycleValue(current, val.value) }),
          }, h('span.facet-mark', { 'aria-hidden': 'true' }, state === 'include' ? '✓' : state === 'exclude' ? '−' : ''),
          h('span.facet-label', null, val.label),
          h('span.facet-count.num', null, formatCount(val.count)),
          h('span.visually-hidden', null, state === 'include' ? ' (only this)' : state === 'exclude' ? ' (excluded)' : '')));
        }
        pop.append(fs);
      }
    }
    pop.append(h('div.pop-foot', null,
      h('code.filter-grammar', { title: 'The filter as it is sent to the server' }, formatFilter(v.f, { withDefaults: true })),
      h('button.btn', { type: 'button', onClick: () => { store.dispatch({ type: 'SET_FILTER', f: 'syn:1' }); for (const [k, d] of Object.entries(TOGGLE_DEFAULTS)) store.dispatch({ type: 'SET_TOGGLE', key: k, value: d }); } }, 'Reset')));
    float.position();
  }

  function sync() {
    const n = activeCount(store.get().view);
    count.hidden = n === 0;
    count.textContent = String(n);
    button.setAttribute('aria-label', n ? `Filters (${n} active)` : 'Filters');
    if (!pop.hidden) { load(); render(); }
  }
  cleanups.push(store.subscribe((s) => [s.view.f, s.view.toggles], sync, { equals: (a, b) => a[0] === b[0] && a[1] === b[1], immediate: true }));
  cleanups.push(store.subscribe((s) => s.ui.filtersOpen, (open) => { if (Boolean(open) !== !pop.hidden) toggle(Boolean(open)); }));

  const onDocKey = (e) => { if (e.key === 'Escape' && !pop.hidden) { e.preventDefault(); toggle(false); button.focus(); } };
  const onDocDown = (e) => { if (!pop.hidden && !wrap.contains(e.target) && !pop.contains(e.target)) toggle(false); };
  document.addEventListener('keydown', onDocKey, true);
  document.addEventListener('pointerdown', onDocDown);
  cleanups.push(() => { document.removeEventListener('keydown', onDocKey, true); document.removeEventListener('pointerdown', onDocDown); });

  return { unmount() { release?.(); for (const fn of cleanups.splice(0)) fn(); wrap.remove(); } };
}
