// OWNER: WP6
// shell/search.mjs — search with typed suggestions (SPEC §7.2 /api/search, D16, §8.8): one box for
// expressions, works, makers and themes; a combobox listbox with type badges and counts; the computed empty
// state ("0 is an observation about this index"); pinned strand chips (● ■ ▲ ◆, ≤ 4) with unpin.
// `/` focuses the box, `P` pins the searched expression.

import { formatCount } from '../../shared/format.mjs';
import { formatFilter } from '../../shared/viewstate.mjs';
import { STRAND_GLYPH_CHARS } from '../../shared/vocab.mjs';
import { h, clear } from '../core/dom.mjs';
import { isAbort } from '../core/api.mjs';
import { scrollHub } from '../timeline/viewport.mjs';
import { floatPopover } from './layout.mjs';
import { icon } from './toolbar.mjs';

export const DEBOUNCE_MS = 180;
/** The placeholder, and its shorter form when the box is narrow (never cut mid-word). */
export const PLACEHOLDER = Object.freeze({ long: 'Search a word, phrase, work, maker or theme', short: 'Search words, works, themes', min: 'Search' });

/**
 * The placeholder that fits a box `px` wide (≈ 7 px per character at 13 px, plus the icon's 40 px).
 * @param {number} px
 * @returns {string}
 */
export function placeholderFor(px) {
  const fits = (t) => t.length * 7 + 44 <= px;
  return fits(PLACEHOLDER.long) ? PLACEHOLDER.long : fits(PLACEHOLDER.short) ? PLACEHOLDER.short : PLACEHOLDER.min;
}
/** Badge word per suggestion type (always a word, never colour alone). */
export const TYPE_BADGE = Object.freeze({ expression: 'EXPR', work: 'WORK', maker: 'MAKER', theme: 'THEME', etymology: 'ETYM', adapter: 'SOURCES', annotation: 'NOTE' });

/**
 * What choosing a suggestion does.
 * @param {{type: string, ref: string}} s
 * @returns {{kind: 'pin', strand: {type: string, id: number|string}} | {kind: 'track'} | {kind: 'select', selection: object}
 *           | {kind: 'panel', panel: string} | {kind: 'info'}}
 */
export function suggestionAction(s) {
  const i = s.ref.indexOf(':');
  const [type, id] = i < 0 ? [s.ref, ''] : [s.ref.slice(0, i), s.ref.slice(i + 1)];
  if (type === 'expression') return id === 'new' ? { kind: 'track' } : { kind: 'pin', strand: { type: 'expression', id: Number(id) } };
  if (type === 'document' && /^\d+$/.test(id)) return { kind: 'select', selection: { type: 'document', id: Number(id) } };
  if (type === 'maker' && id) return { kind: 'pin', strand: { type: 'maker', id } };
  if (type === 'theme' && id) return { kind: 'pin', strand: { type: 'theme', id } };
  if (type === 'work' && /^\d+$/.test(id)) return { kind: 'pin', strand: { type: 'work', id: Number(id) } };
  if (s.ref === 'adapters' || type === 'adapters') return { kind: 'panel', panel: 'adapters' };
  return { kind: 'info' };
}

/**
 * @param {HTMLElement} el this module's slot in #toolbar
 * @param {{store: object, api: object, keys: object, announce: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api, keys, announce } = ctx;
  const cleanups = [];
  let timer = 0;
  let result = null;
  let active = -1;
  let items = [];
  let lastQ = '';

  const input = h('input.search-input', {
    type: 'search', placeholder: PLACEHOLDER.long, autocomplete: 'off', spellcheck: false,
    role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'search-list', 'aria-autocomplete': 'list', 'aria-label': 'Search (press /)',
  });
  const list = h('div#search-list.search-pop', { role: 'listbox', 'aria-label': 'Suggestions', hidden: true });
  // Strand chip labels fold to their glyphs only after the other optional controls when the toolbar is short of
  // room (priority+, toolbar.mjs): the pinned word is what the Scroll shows, so it stays readable at 1024 px.
  const chips = h('div.strand-chips', { role: 'list', 'aria-label': 'Pinned strands', dataset: { prio: '47' } });
  const closeNarrow = h('button.btn.search-close', { type: 'button', 'aria-label': 'Close search', onClick: () => { store.dispatch({ type: 'UI_SET', key: 'searchOpen', value: false }); hide(); } }, icon('close'));
  const box = h('div.search', null, h('span.search-icon', { 'aria-hidden': 'true' }, icon('search')), input, closeNarrow);
  const wrap = h('div.tb-group.tb-search', null, box, chips);
  el.appendChild(wrap);
  // The suggestion list floats above everything (portalled, fixed): no toolbar overflow or canvas layer can hide it.
  const float = floatPopover(list, () => box, { matchWidth: true, minWidth: 360 });
  cleanups.push(() => float.destroy());
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { input.placeholder = placeholderFor(box.clientWidth); }) : null;
  ro?.observe(box);
  cleanups.push(() => ro?.disconnect());

  function hide() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; input.removeAttribute('aria-activedescendant'); }
  function show() { list.hidden = false; input.setAttribute('aria-expanded', 'true'); float.position(); }

  async function run(q) {
    lastQ = q;
    if (!q.trim()) { result = null; clear(list); hide(); return; }
    const v = store.get().view;
    try {
      const res = await api.get('/search', { q, corpus: v.corpus, scope: 'all', f: formatFilter(v.f) || null, limit: 10 }, { key: 'search' });
      if (q !== lastQ) return;
      result = res;
      render();
    } catch (err) {
      if (isAbort(err)) return;
      result = null;
      clear(list);
      list.append(h('div.search-error', { role: 'alert' }, h('p', null, err.message), err.hint ? h('p.meta', null, err.hint) : null,
        h('button.btn', { type: 'button', onClick: () => run(q) }, 'Retry')));
      show();
    }
  }

  function render() {
    clear(list);
    items = [];
    const r = result;
    if (!r) { hide(); return; }
    (r.suggestions ?? []).forEach((s, i) => {
      const act = suggestionAction(s);
      const id = `search-opt-${i}`;
      const opt = h('div.search-opt', {
        id, role: 'option', 'aria-selected': 'false', 'aria-disabled': act.kind === 'info' ? 'true' : null, dataset: { kind: act.kind },
        onMouseDown: (e) => e.preventDefault(),
        onClick: () => choose(s),
      },
      h('span.badge', null, TYPE_BADGE[s.type] ?? s.type.toUpperCase()),
      h('span.opt-label', null, s.label),
      Number.isInteger(s.count) ? h('span.opt-count.num', null, formatCount(s.count)) : null,
      act.kind === 'pin' || act.kind === 'track' ? h('span.opt-hint', null, 'pin') : null);
      items.push({ el: opt, s, act });
      list.append(opt);
    });
    const hits = r.hits;
    if (hits) {
      const parts = [`${formatCount(hits.passages)} passages`, `${formatCount(hits.documents)} documents`];
      if (hits.undated) parts.push(`${formatCount(hits.undated)} undated`);
      if (hits.names_excluded) parts.push(`${formatCount(hits.names_excluded)} proper-noun hits excluded`);
      if (hits.preliminary) parts.push('preliminary (not yet counted)');
      list.append(h('p.search-hits.meta', null, parts.join(' · ')));
    }
    if (r.query?.variants?.length) {
      list.append(h('p.search-variants.meta', null, `variants: ${r.query.variants.map((x) => `${x.form} (${x.type}, ${x.status})`).join(', ')}`));
    }
    if (r.empty_note) list.append(h('p.search-empty', { role: 'status' }, r.empty_note));
    for (const row of (r.kwic ?? []).slice(0, 3)) {
      list.append(h('button.search-kwic', { type: 'button', onMouseDown: (e) => e.preventDefault(), onClick: () => openPassage(row.passage) },
        h('span.kwic-date.num', null, row.date?.label ?? ''),
        h('span.kwic-text', null, h('span.kwic-l', null, row.left), h('mark', null, row.match), h('span.kwic-r', null, row.right)),
        row.synthetic ? h('span.badge.badge-syn', null, 'SYN') : null));
    }
    if (r.provenance?.synthetic) list.classList.add('syn-frame'); else list.classList.remove('syn-frame');
    show();
    announce(r.empty_note ?? `${r.suggestions?.length ?? 0} suggestions.`);
  }

  function openPassage(id) {
    store.dispatch({ type: 'SELECT', selection: { type: 'passage', id } });
    store.dispatch({ type: 'OPEN_PANEL', panel: 'inspector' });
    hide();
  }

  async function choose(s) {
    const act = suggestionAction(s);
    if (act.kind === 'info') return;
    hide();
    if (act.kind === 'pin') pin(act.strand, s.label);
    else if (act.kind === 'select') { store.dispatch({ type: 'SELECT', selection: act.selection }); store.dispatch({ type: 'OPEN_PANEL', panel: 'inspector' }); }
    else if (act.kind === 'panel') store.dispatch({ type: 'OPEN_PANEL', panel: act.panel });
    else if (act.kind === 'track') {
      const q = result?.query;
      try {
        const res = await api.post('/expressions', { surface: q?.surface ?? input.value.trim(), kind: q?.kind ?? undefined, corpus: store.get().view.corpus });
        pin({ type: 'expression', id: res.expression.id }, res.expression.surface);
        if (res.state?.status === 'materializing') announce('Counting the new expression…');
      } catch (err) {
        if (!isAbort(err)) store.dispatch({ type: 'UI_TOAST', toast: { kind: 'error', text: err.message, hint: err.hint ?? null } });
      }
    }
    if (store.get().ui.searchOpen) store.dispatch({ type: 'UI_SET', key: 'searchOpen', value: false });
  }

  function pin(strand, label) {
    store.dispatch({ type: 'PIN_STRAND', strand });
    announce(`Pinned ${label}.`);
  }

  /** P: pin the searched expression (the first expression suggestion). */
  function pinSearched() {
    const s = result?.suggestions?.find((x) => x.type === 'expression');
    if (s) choose(s);
    else store.dispatch({ type: 'UI_TOAST', toast: { kind: 'info', text: 'Search for an expression first, then press P to pin it.' } });
  }

  function setActive(i) {
    if (!items.length) return;
    active = (i + items.length) % items.length;
    items.forEach((it, k) => it.el.setAttribute('aria-selected', String(k === active)));
    input.setAttribute('aria-activedescendant', items[active].el.id);
    items[active].el.scrollIntoView?.({ block: 'nearest' });
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value;
    timer = setTimeout(() => run(q), DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden && result) show(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[active >= 0 ? active : items.findIndex((x) => x.act.kind !== 'info')];
      if (it) choose(it.s); else run(input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!list.hidden) hide(); else { input.blur(); store.dispatch({ type: 'UI_SET', key: 'searchOpen', value: false }); }
    }
  });
  input.addEventListener('focus', () => { if (result) show(); });
  input.addEventListener('blur', () => setTimeout(() => { if (!list.contains(document.activeElement)) hide(); }, 150));

  // Pinned strand chips (re-rendered only when the strands or their labels change).
  let chipsKey = '';
  function renderChips(strands) {
    const labels = scrollHub.get().strandLabels;
    const key = JSON.stringify(strands.map((s) => [s.type, s.id, s.glyph, labels?.get(String(s.id))]));
    if (key === chipsKey) return;
    chipsKey = key;
    clear(chips);
    for (const s of strands) {
      const label = labels?.get(String(s.id)) ?? (s.type === 'expression' ? `expression ${s.id}` : String(s.id));
      chips.append(h('span.strand-chip', { role: 'listitem', title: `${s.type}: ${label}` },
        h('span.strand-glyph', { 'aria-hidden': 'true' }, STRAND_GLYPH_CHARS[s.glyph] ?? '●'),
        h('span.strand-label', null, label),
        h('button.strand-unpin', { type: 'button', 'aria-label': `Unpin ${label}`, onClick: () => store.dispatch({ type: 'UNPIN_STRAND', id: s.id, strandType: s.type }) }, '×')));
    }
  }
  cleanups.push(store.subscribe((s) => s.view.strands, renderChips, { immediate: true }));
  cleanups.push(scrollHub.subscribe(() => renderChips(store.get().view.strands)));
  // Narrow screens (fix pass, §8.6, §13 rule 1): the search overlay opens below the top row (the SYNTHETIC ribbon and
  // the jobs chips), so it never covers the ribbon and its × is never under a chip; a tap outside it, or on the Search
  // tab again, closes it.
  const narrow = () => document.documentElement.dataset.layout === 'narrow';
  const topRowBottom = () => {
    let b = 0;
    for (const id of ['ribbon', 'jobs']) {
      const r = document.getElementById(id)?.getBoundingClientRect?.();
      if (r && r.height > 0) b = Math.max(b, r.bottom);
    }
    return b;
  };
  const onOutside = (e) => {
    const t = e.target;
    if (!store.get().ui.searchOpen || !narrow() || wrap.contains(t) || list.contains(t) || t?.closest?.('.nb-search')) return;
    store.dispatch({ type: 'UI_SET', key: 'searchOpen', value: false });
  };
  document.addEventListener('pointerdown', onOutside, true);
  cleanups.push(() => document.removeEventListener('pointerdown', onOutside, true));
  cleanups.push(store.subscribe((s) => s.ui.searchOpen, (open) => {
    wrap.classList.toggle('is-open', Boolean(open));
    if (open && narrow()) wrap.style.top = `${Math.round(topRowBottom())}px`; else wrap.style.top = '';
    if (open) setTimeout(() => input.focus(), 0);
    else hide();
  }));
  // Other modules (the start card, the tour's last card) ask for the search box. On a phone the tour's card does not open
  // the overlay over the Scroll on its own (fix pass): its Search tab is one tap away.
  cleanups.push(store.subscribe((s) => s.ui.focusSearch, (t) => {
    if (!t) return;
    if (narrow()) {
      if (t?.source === 'tour') return;
      store.dispatch({ type: 'UI_SET', key: 'searchOpen', value: true });
    }
    input.focus();
    input.select();
  }));

  cleanups.push(keys.register('global', {
    '/': { run: () => { if (document.documentElement.dataset.layout === 'narrow') store.dispatch({ type: 'UI_SET', key: 'searchOpen', value: true }); input.focus(); input.select(); }, label: 'focus search' },
    p: { run: pinSearched, label: 'pin the searched expression' },
  }));

  return { unmount() { clearTimeout(timer); for (const fn of cleanups.splice(0)) fn(); wrap.remove(); } };
}
