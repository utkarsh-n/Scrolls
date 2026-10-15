// OWNER: WP6
// shell/help.mjs — the `?` shortcut sheet (SPEC §8.5): the whole keyboard map, in the spec's order, plus the
// pointer and touch gestures. A modal dialog: focus is trapped, Esc or ? closes it.

import { h, clear, trapFocus } from '../core/dom.mjs';

/** The keyboard map of §8.5 (scoped; `?` shows it). */
export const KEY_MAP = Object.freeze([
  ['/', 'focus search'], ['Space', 'play / pause'],
  ['[  ]', 'vantage −/+ 1 bin'], ['{  }', 'vantage −/+ 10 bins'],
  ['←  →', 'pan 10% (Shift 50%); in the marks region: previous/next mark'], ['↑  ↓', 'lane focus'],
  ['+ / =   −', 'zoom at the playhead (or focused mark)'], ['0', 'fit data'],
  ['1 – 6', 'jump to tier L0–L5 (millennia … days)'], ['D', 'folded deep-time overview ↔ linear'],
  ['Home / End', 'first / last observation in the focused lane'], ['Tab / Shift+Tab', 'next / previous control in reading order: toolbar, minimap, lanes, marks, inspector'],
  ['Enter', 'open the focused mark / bin'], ['Esc', 'close panel, clear selection, dismiss coach mark'],
  ['L', 'cycle lane facet'], ['E', 'evidence filter: all → documented+computed → documented'],
  ['V', 'vantage strict ↔ context'], ['R', 'reduced motion'],
  ['T', 'table alternative'], ['P', 'pin the searched expression as a strand'],
  ['A / B', 'set Compare slice A / B from the range'], ['C', 'Compare'],
  ['G', 'Lineage of the selection (works: Genealogy)'], ['K', 'Constellation'],
  ['N', 'annotate the selection (Notebook)'], ['S', 'save view'],
  ['X', 'export menu'], ['?', 'this sheet'],
]);

/** Pointer and touch gestures (§1.5, §8.6). */
export const GESTURES = Object.freeze([
  ['Wheel / pinch', 'zoom around the pointer'], ['Horizontal swipe, Shift+wheel, drag', 'pan'],
  ['Alt+wheel, wheel over the lane names', 'scroll the lanes'], ['Shift+drag on the ruler', 'select a range'],
  ['Double-click / double-tap', 'zoom in one bin level'], ['Two-finger tap', 'zoom out one bin level'],
  ['Long-press', 'actions: open, annotate, lineage, compare'], ['Drag the cyan handle', 'scrub the vantage (by whole bins)'],
]);

/**
 * @param {HTMLElement} el this module's slot in #sheet
 * @param {{store: object, keys: object}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, keys } = ctx;
  let release = null;
  let unkeys = null;
  const close = () => store.dispatch({ type: 'UI_SHEET', sheet: null });
  const dialog = h('div.help-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'help-title', hidden: true });
  const scrim = h('div.scrim', { hidden: true, onClick: close });
  el.append(scrim, dialog);

  function render() {
    clear(dialog);
    const table = (rows, caption) => h('table.help-table', null, h('caption', null, caption),
      h('tbody', null, rows.map(([k, a]) => h('tr', null, h('th', { scope: 'row' }, h('kbd', null, k)), h('td', null, a)))));
    dialog.append(
      h('div.pop-head', null, h('h2#help-title.pop-title', null, 'Keyboard and gestures'),
        h('button.btn', { type: 'button', 'aria-label': 'Close', onClick: close }, '×')),
      h('div.help-cols', null, table(KEY_MAP, 'Keys (scoped: typing in a field never triggers them)'), table(GESTURES, 'Pointer and touch')),
      h('p.meta', null, 'Lane order is a sorting choice, not a scale of meaning. The vantage is the reading clock: strict hides later evidence, context ghosts it.'));
  }

  const unsub = store.subscribe((s) => s.ui.sheet, (sheet) => {
    const open = sheet?.kind === 'help';
    if (open === !dialog.hidden) return;
    dialog.hidden = scrim.hidden = !open;
    if (open) {
      render();
      release = trapFocus(dialog);
      unkeys = keys.register('help', { Escape: close, '?': close }, { exclusive: true });
      keys.setScope('help');
    } else {
      release?.(); release = null;
      unkeys?.(); unkeys = null;
      if (keys.getScope() === 'help') keys.setScope('global');
    }
  }, { immediate: true });

  return { unmount() { unsub(); release?.(); unkeys?.(); scrim.remove(); dialog.remove(); } };
}
