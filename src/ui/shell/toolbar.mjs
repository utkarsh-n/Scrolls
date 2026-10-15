// OWNER: WP6
// shell/toolbar.mjs — the toolbar (SPEC §8.1, §8.5, §8.6): wordmark, corpus switch, playback (step back,
// play/pause, Step ▸, speed, vantage strict/context), zoom (−, +, fit, bin level), Deep time, Tour and More.
//
// Priority+: every optional control carries `data-prio` (lower goes first). Whenever the toolbar is too narrow
// the lowest-priority controls move into the More menu, one at a time, until nothing overflows — so nothing is
// ever truncated or overlapped at any desktop width. Search and Filters (their own modules) take part through
// the same attributes. On narrow viewports the toolbar is a bottom bar (Search · Play · Lanes · Filters · More)
// and every other action, including Views and Export (panels/views-menu.mjs, export-menu.mjs), is in More.

import { VANTAGE_OPEN_DAY } from '../../shared/viewstate.mjs';
import { TIERS } from '../../shared/vocab.mjs';
import { h, clear } from '../core/dom.mjs';
import { isAbort } from '../core/api.mjs';
import { scrollHub } from '../timeline/viewport.mjs';
import { dayLabel } from '../timeline/scale.mjs';
import { BIN_PLURAL, TIER_LEVEL } from '../timeline/tiers.mjs';
import { SPEEDS } from '../timeline/playhead.mjs';
import { takeSnapshot } from '../timeline/snapshot.mjs';
import { setTourDismissed } from '../tour/tour.mjs';
import { fitPriority, floatPopover } from './layout.mjs';
import { REAL_CORPUS } from './presets.mjs';
import { contractAtLeast } from '../timeline/viewport.mjs';

export { fitPriority };

const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/icons.svg#i-${name}`);
  svg.appendChild(use);
  return svg;
};
export { icon };

/** WP7's toolbar menus and their priority in the fit (they fold late: after zoom, Deep time, Tour and Step). */
const WP7_MENUS = Object.freeze([['export-menu', 41], ['views-menu', 42]]);

/** Layers the More menu can switch (view.layers keys of §8.2), with their words. */
export const LAYER_ITEMS = Object.freeze([
  ['arcs', 'Arcs (transmission)'], ['feedback', 'Feedback arcs (re-readings)'], ['washes', 'Precision washes'], ['coverage', 'Coverage'],
  ['etymology', 'Etymology periods'], ['claims', 'Wiktionary claims'], ['baseline', 'External baseline (Ngram)'],
]);

/** Is the Cipher metadata phase finished, so the real corpus can be opened (§1.11)? */
export function cipherOpenable(health) {
  const st = health?.cipher?.status;
  return st === 'fulltext' || st === 'ready';
}

/** Words for the Cipher corpus button when it cannot be opened yet. */
export function cipherReason(health) {
  const c = health?.cipher;
  if (!c) return 'Waiting for the local server.';
  if (c.status === 'absent') return c.message ?? 'Cipher files were not found; the demo still works.';
  if (c.status === 'metadata' || c.status === 'queued' || c.status === 'not_started') return `Available when the metadata phase finishes (${c.message ?? c.status}).`;
  if (c.status === 'failed') return `The Cipher import failed: ${c.message ?? 'see the jobs tray'}.`;
  return c.message ?? c.status;
}

/**
 * @param {HTMLElement} el this module's slot in #toolbar
 * @param {{store: object, api: object, keys: object, announce: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api, keys } = ctx;
  const cleanups = [];
  const dispatch = (a) => store.dispatch(a);
  const toolbar = el.closest('#toolbar') ?? el.parentElement;
  const btn = (cls, label, iconName, onClick, { text = null, prio = null, more = null } = {}) => h(`button.btn.tb-btn${cls}`, {
    type: 'button', 'aria-label': label, title: label, onClick,
    dataset: { ...(prio !== null ? { prio: String(prio) } : {}), ...(more ? { more } : {}) },
  }, iconName ? icon(iconName) : null, text ? h('span.tb-text', null, text) : null);

  // ── Brand + corpus ──
  const corpusDemo = h('button.seg', { type: 'button', 'aria-pressed': 'true', onClick: () => setCorpus('demo') }, 'Demo');
  const corpusCipher = h('button.seg', { type: 'button', 'aria-pressed': 'false', onClick: () => setCorpus('cipher') }, 'Cipher');
  const corpusUser = h('button.seg', { type: 'button', 'aria-pressed': 'false', hidden: true, onClick: () => setCorpus('user') }, 'Your imports');
  const corpusStemm = h('button.seg', { type: 'button', 'aria-pressed': 'false', hidden: true, title: 'STEMM sources (staged files): Gutenberg science shelf, OpenAlex, Wiktionary',
    onClick: () => setCorpus('stemm') }, 'STEMM');
  // The virtual corpus of every real corpus at once (contract 1.3.0): the Term trail's ground; the demo is never in it.
  const corpusReal = h('button.seg', { type: 'button', 'aria-pressed': 'false', hidden: true, title: 'Every real corpus together (Cipher, STEMM, your imports) — never the synthetic demo',
    onClick: () => setCorpus(REAL_CORPUS) }, 'All real');
  const brand = h('div.tb-group.tb-brand', null,
    h('span.wordmark', { title: 'Scrolls — A Living Atlas of Meaning', dataset: { prio: '32' } }, 'Scrolls'),
    h('div.segmented', { role: 'group', 'aria-label': 'Corpus' }, corpusDemo, corpusCipher, corpusStemm, corpusUser, corpusReal));

  function setCorpus(c) {
    if (store.get().view.corpus === c) return;
    if (c === 'cipher' && !cipherOpenable(store.get().ui.health)) {
      dispatch({ type: 'UI_TOAST', toast: { kind: 'info', text: cipherReason(store.get().ui.health) } });
      return;
    }
    dispatch({ type: 'SET_CORPUS', corpus: c });
  }

  // ── Playback ──
  const playBtn = btn('.tb-play', 'Play (Space)', 'play', () => scrollHub.actions.togglePlay?.());
  const stepBack = btn('', 'Step back one bin ([)', 'step-back', () => scrollHub.actions.step?.(-1), { prio: 22, more: 'step-back' });
  const stepFwd = btn('.tb-step', 'Step forward one bin (])', 'step', () => scrollHub.actions.step?.(1), { text: 'Step', prio: 40, more: 'step' });
  const speed = h('select.tb-select', { 'aria-label': 'Play speed', title: 'Play speed', dataset: { prio: '12', more: 'speed' }, onChange: (e) => scrollHub.actions.setSpeed?.(Number(e.target.value)) },
    SPEEDS.map((s) => h('option', { value: String(s), selected: s === 1 }, `${s}×`)));
  const vantage = h('button.chip.tb-vantage', { type: 'button', dataset: { prio: '44', more: 'vantage' }, onClick: () => dispatch({ type: 'SET_VANTAGE', toggleStrict: true }) });
  const playback = h('div.tb-group.tb-playback', { role: 'group', 'aria-label': 'Playback' }, stepBack, playBtn, stepFwd, speed, vantage);

  // ── Zoom ──
  const tierSel = h('select.tb-select', { 'aria-label': 'Bin level', title: 'Bin level (you can force coarser bins, never finer)', dataset: { prio: '10', more: 'bins' }, onChange: (e) => dispatch({ type: 'SET_TIER', tier: e.target.value }) },
    h('option', { value: 'auto' }, 'Bins: auto'),
    TIERS.map((t) => h('option', { value: t }, `Bins: ${BIN_PLURAL[t]}`)));
  const zoom = h('div.tb-group.tb-zoom', { role: 'group', 'aria-label': 'Zoom' },
    btn('', 'Zoom out (−)', 'zoom-out', () => scrollHub.actions.zoomBy?.(1 / 1.6), { prio: 16, more: 'zoom-out' }),
    btn('', 'Zoom in (+)', 'zoom-in', () => scrollHub.actions.zoomBy?.(1.6), { prio: 17, more: 'zoom-in' }),
    btn('', 'Fit the data (0)', 'fit', () => scrollHub.actions.fit?.(), { prio: 20, more: 'fit' }),
    tierSel);

  // ── Deep time, Tour, More ──
  const deepBtn = h('button.btn.tb-btn.tb-deep', { type: 'button', 'aria-pressed': 'false', title: 'Folded deep-time overview (D)', dataset: { prio: '26', more: 'deep' },
    onClick: () => scrollHub.actions.toggleFolded?.() }, h('span.tb-text', null, 'Deep time'));
  const tourBtn = h('button.btn.tb-btn.tb-tour', { type: 'button', title: 'Guided tour of the demo (4 min)', dataset: { prio: '30', more: 'tour' },
    onClick: () => openTour() }, h('span.tb-text', null, 'Tour'));
  const moreBtn = h('button.btn.tb-btn.tb-more', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'More actions', title: 'More',
    onClick: () => toggleMore() }, h('span.tb-text', null, 'More'), h('span.tb-caret', { 'aria-hidden': 'true' }, '▾'));
  // M1 gate: the import wizard (src/ui/import/wizard.mjs) opens on OPEN_PANEL 'import'; this is its visible entry point.
  const importBtn = btn('', 'Import a file', 'import', () => dispatch({ type: 'OPEN_PANEL', panel: 'import' }), { prio: 14, more: 'import' });
  const tools = h('div.tb-group.tb-tools', null, deepBtn, tourBtn, importBtn);
  const moreGroup = h('div.tb-group.tb-moregroup', null, moreBtn);

  // ── Narrow bottom bar ──
  const nb = (label, iconName, onClick, cls = '') => h(`button.nb-btn${cls}`, { type: 'button', onClick }, icon(iconName), h('span', null, label));
  const nbPlay = nb('Play', 'play', () => scrollHub.actions.togglePlay?.());
  const nbMore = nb('More', 'more', () => toggleMore(nbMore));
  const bottom = h('nav.narrow-bar', { 'aria-label': 'Main actions' },
    // the Search tab toggles the search overlay (fix pass: it could only be closed by choosing a suggestion)
    nb('Search', 'search', () => dispatch({ type: 'UI_SET', key: 'searchOpen', value: !store.get().ui.searchOpen }), '.nb-search'),
    nbPlay,
    nb('Lanes', 'lanes', () => dispatch({ type: 'UI_SET', key: 'lanesOpen', value: !store.get().ui.lanesOpen })),
    nb('Filters', 'filter', () => dispatch({ type: 'UI_SET', key: 'filtersOpen', value: !store.get().ui.filtersOpen })),
    nbMore);

  el.append(brand, playback, zoom, tools, moreGroup, bottom);

  function openTour() {
    setTourDismissed(false);
    dispatch({ type: 'UI_SET', key: 'tour', value: { open: true, step: 1 } });
    dispatch({ type: 'UI_COACH', coach: { stage: 1, replay: Date.now() } });
  }

  // ── The More menu ──
  const morePop = h('div.more-pop', { role: 'menu', 'aria-label': 'More actions', hidden: true });
  let moreAnchor = moreBtn;
  const float = floatPopover(morePop, () => moreAnchor, { align: 'end' });
  cleanups.push(() => float.destroy());
  const narrow = () => store.get().ui.layout?.mode === 'narrow';
  /** WP7's toolbar menus (Views, Export): their own buttons, clicked from More when they are folded away. */
  const wp7Button = (mod) => toolbar?.querySelector(`[data-module="panels/${mod}.mjs"] .menu-button`) ?? null;

  function toggleMore(anchor = moreBtn) {
    if (!morePop.hidden) { closeMore(); return; }
    moreAnchor = anchor;
    renderMore();
    morePop.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    float.position();
    morePop.querySelector('[role^="menuitem"]')?.focus();
  }
  function closeMore({ focus = false } = {}) {
    if (morePop.hidden) return;
    morePop.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
    if (focus) moreAnchor?.focus?.();
  }
  const item = (label, fn, { hint = null, pressed = null, disabled = false } = {}) => h('button.action-item.more-item', {
    type: 'button', role: pressed === null ? 'menuitem' : 'menuitemcheckbox', 'aria-checked': pressed === null ? null : String(Boolean(pressed)), disabled,
    onClick: () => { closeMore(); fn(); },
  }, pressed !== null ? h('span.more-check', { 'aria-hidden': 'true' }, pressed ? '✓' : '') : null, h('span.more-label', null, label), hint ? h('kbd', null, hint) : null);
  const section = (title, ...items) => (items.filter(Boolean).length ? h('div.more-section', { role: 'group', 'aria-label': title }, h('p.more-title', null, title), items.filter(Boolean)) : null);

  /** Menu entries of the controls currently folded out of the toolbar. */
  function overflowEntries() {
    const v = store.get().view;
    const folded = new Set([...toolbar.querySelectorAll('[data-more].is-overflow')].map((x) => x.dataset.more));
    if (narrow()) for (const k of ['step-back', 'step', 'vantage', 'fit', 'deep', 'tour', 'speed']) folded.add(k);
    const out = [];
    if (folded.has('step-back')) out.push(item('Step back one bin', () => scrollHub.actions.step?.(-1), { hint: '[' }));
    if (folded.has('step')) out.push(item('Step forward one bin', () => scrollHub.actions.step?.(1), { hint: ']' }));
    if (folded.has('vantage')) out.push(item(`Vantage: ${v.vantage.strict ? 'strict → context' : 'context → strict'}`, () => dispatch({ type: 'SET_VANTAGE', toggleStrict: true }), { hint: 'V' }));
    if (folded.has('zoom-in')) out.push(item('Zoom in', () => scrollHub.actions.zoomBy?.(1.6), { hint: '+' }));
    if (folded.has('zoom-out')) out.push(item('Zoom out', () => scrollHub.actions.zoomBy?.(1 / 1.6), { hint: '−' }));
    if (folded.has('fit')) out.push(item('Fit the data', () => scrollHub.actions.fit?.(), { hint: '0' }));
    if (folded.has('deep')) out.push(item('Deep-time overview', () => scrollHub.actions.toggleFolded?.(), { hint: 'D', pressed: v.axis.mode === 'folded' }));
    if (folded.has('tour')) out.push(item('Guided tour (4 min)', openTour));
    if (folded.has('import') && narrow()) out.push(item('Import a file', () => dispatch({ type: 'OPEN_PANEL', panel: 'import' })));
    if (!narrow()) {
      const views = toolbar.querySelector('[data-module="panels/views-menu.mjs"] .menu.is-folded .menu-button');
      const exp = toolbar.querySelector('[data-module="panels/export-menu.mjs"] .menu.is-folded .menu-button');
      if (views) out.push(item('Saved views…', () => views.click()));
      if (exp) out.push(item('Export…', () => exp.click()));
    }
    if (folded.has('speed')) {
      const cur = scrollHub.get().speed ?? 1;
      out.push(h('div.more-row', { role: 'group', 'aria-label': 'Play speed' }, h('span.more-label', null, 'Speed'),
        SPEEDS.map((s) => h('button.seg', { type: 'button', 'aria-pressed': String(s === cur), onClick: () => { scrollHub.actions.setSpeed?.(s); speed.value = String(s); renderMore(); } }, `${s}×`))));
    }
    if (folded.has('bins')) {
      out.push(h('div.more-row.more-wrap', { role: 'group', 'aria-label': 'Bin level' }, h('span.more-label', null, 'Bins'),
        ['auto', ...TIERS].map((t) => h('button.seg', { type: 'button', 'aria-pressed': String(v.tier === t), disabled: tierSel.querySelector(`option[value="${t}"]`)?.disabled,
          onClick: () => { dispatch({ type: 'SET_TIER', tier: t }); renderMore(); } }, t === 'auto' ? 'auto' : BIN_PLURAL[t]))));
    }
    return out;
  }

  function renderMore() {
    clear(morePop);
    const v = store.get().view;
    const health = store.get().ui.health;
    const views = wp7Button('views-menu'), exp = wp7Button('export-menu');
    morePop.append(...[
      narrow() ? section('Corpus',
        item('Demo corpus', () => setCorpus('demo'), { pressed: v.corpus === 'demo' }),
        item('Cipher corpus (real data)', () => setCorpus('cipher'), { pressed: v.corpus === 'cipher', disabled: !cipherOpenable(health) && v.corpus !== 'cipher' }),
        corpusStemm.hidden ? null : item('STEMM sources', () => setCorpus('stemm'), { pressed: v.corpus === 'stemm' }),
        corpusReal.hidden ? null : item('All real corpora (never the demo)', () => setCorpus(REAL_CORPUS), { pressed: v.corpus === REAL_CORPUS })) : null,
      section('Controls', ...overflowEntries()),
      narrow() ? section('Views and export',
        views ? item('Saved views…', () => views.click()) : null,
        exp ? item('Export…', () => exp.click()) : null) : null,
      section('Layers', ...LAYER_ITEMS.map(([k, label]) => item(label, () => dispatch({ type: 'SET_LAYER', layer: k }), { pressed: v.layers[k] === 1 }))),
      section('Snapshot',
        item('Snapshot as PNG', () => takeSnapshot(ctx, 'png')),
        item('Snapshot as SVG', () => takeSnapshot(ctx, 'svg'))),
      section('More',
        item('Table alternative', () => dispatch({ type: 'UI_SET', key: 'table', value: !store.get().ui.table }), { hint: 'T', pressed: Boolean(store.get().ui.table) }),
        item('Reduced motion', () => motionToggle(), { hint: 'R', pressed: document.documentElement.dataset.motion === 'reduce' }),
        item('Import a file', () => dispatch({ type: 'OPEN_PANEL', panel: 'import' })),
        // the Adapters page, where the staged STEMM sources are loaded (fix pass: it had no menu entry)
        item('Sources and adapters…', () => dispatch({ type: 'OPEN_PANEL', panel: 'adapters' })),
        item('Keyboard shortcuts', () => dispatch({ type: 'UI_SHEET', sheet: { kind: 'help' } }), { hint: '?' }))].filter(Boolean));
  }
  const motionToggle = () => {
    const reduce = document.documentElement.dataset.motion === 'reduce';
    dispatch({ type: 'SET_REDUCED_MOTION', value: reduce ? 'off' : 'on' });
  };
  const onDocDown = (e) => { if (!morePop.hidden && !morePop.contains(e.target) && !moreBtn.contains(e.target) && !nbMore.contains(e.target)) closeMore(); };
  const onDocKey = (e) => { if (e.key === 'Escape' && !morePop.hidden) { e.preventDefault(); e.stopImmediatePropagation(); closeMore({ focus: true }); } };
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onDocKey, true);
  cleanups.push(() => { document.removeEventListener('pointerdown', onDocDown, true); document.removeEventListener('keydown', onDocKey, true); });
  morePop.addEventListener('keydown', (e) => {
    const list = [...morePop.querySelectorAll('[role^="menuitem"]:not([disabled])')];
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
  });

  // ── Focus order = visual order (WCAG 2.4.3, fix pass) ──
  // The controls of several modules share the toolbar; their visual order (wordmark and corpus, search and strands,
  // playback, zoom, tools, filters, Views, Export, More) is also their DOM order, so Tab walks them left to right. The
  // wordmark leads the toolbar and More closes it; the search module's slot sits between them. Idempotent: it moves
  // nothing that is already in place (it runs on every content change).
  function orderToolbar() {
    if (!toolbar) return;
    if (toolbar.firstElementChild !== brand) toolbar.insertBefore(brand, toolbar.firstElementChild);
    const search = toolbar.querySelector(':scope > [data-module="shell/search.mjs"]');
    if (search && brand.nextElementSibling !== search) toolbar.insertBefore(search, brand.nextElementSibling);
    if (toolbar.lastElementChild !== moreGroup) toolbar.appendChild(moreGroup);
  }
  cleanups.push(() => { brand.remove(); moreGroup.remove(); });

  /** The flex items of the toolbar (the module slots are `display: contents`). */
  const flexItems = () => [...toolbar.children].flatMap((c) => (c.classList.contains('slot') ? [...c.children] : [c]));
  /**
   * Whether the controls run past the toolbar's content box. The right padding reserves the jobs chip's width; content
   * that slides under it does not raise scrollWidth (the padding is not scrollable overflow), so the edges are compared.
   */
  function overflows() {
    if (toolbar.scrollWidth > toolbar.clientWidth + 1) return true;
    const box = toolbar.getBoundingClientRect();
    const padRight = parseFloat(getComputedStyle(toolbar).paddingRight) || 0;
    // the jobs chips overlay the toolbar's right end: their own left edge counts too (the padding that reserves their
    // width is updated a frame after they change)
    const jobs = toolbar.ownerDocument.getElementById('jobs')?.getBoundingClientRect();
    const jobsLeft = jobs && jobs.width > 0 && jobs.top < box.bottom && jobs.bottom > box.top ? jobs.left - 8 : Infinity;
    let right = -Infinity;
    for (const n of flexItems()) {
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.right > right) right = r.right;
    }
    return right > Math.min(box.right - padRight, jobsLeft) + 0.5;
  }

  // ── Priority+ fit ──
  let fitRaf = 0;
  function fit() {
    fitRaf = 0;
    if (!toolbar) return;
    orderToolbar();
    const nodes = [...toolbar.querySelectorAll('[data-prio]')];
    // WP7's Views and Export menus fold too: their buttons step aside (More opens them) but their panels stay
    // anchored beside More, so they still open in place.
    const menus = WP7_MENUS.map(([mod, prio]) => [toolbar.querySelector(`[data-module="panels/${mod}.mjs"] .menu`), prio]).filter(([m]) => m);
    if (narrow()) { for (const n of nodes) n.classList.remove('is-overflow'); for (const [m] of menus) m.classList.remove('is-folded'); return; }
    fitPriority([
      ...nodes.map((n) => ({ prio: Number(n.dataset.prio), hide: () => n.classList.add('is-overflow'), show: () => n.classList.remove('is-overflow') })),
      ...menus.map(([m, prio]) => ({ prio, hide: () => m.classList.add('is-folded'), show: () => m.classList.remove('is-folded') })),
    ], overflows);
    toolbar.classList.add('is-fitted');
  }
  const scheduleFit = () => { if (!fitRaf) fitRaf = requestAnimationFrame(fit); };
  const ro = typeof ResizeObserver === 'function' && toolbar ? new ResizeObserver(() => fit()) : null;
  ro?.observe(toolbar);
  // a jobs chip that grows ("Cipher ready", a running import) refits too, a frame later (fix pass: More slid under it)
  const jobsRegion = toolbar?.ownerDocument.getElementById('jobs');
  const roJobs = jobsRegion && typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleFit()) : null;
  roJobs?.observe(jobsRegion);
  cleanups.push(() => roJobs?.disconnect());
  // text widens when the web fonts arrive, with no change to the toolbar's own size or content: refit then too
  const fonts = toolbar?.ownerDocument.fonts;
  fonts?.ready?.then?.(() => scheduleFit());
  fonts?.addEventListener?.('loadingdone', scheduleFit);
  cleanups.push(() => fonts?.removeEventListener?.('loadingdone', scheduleFit));
  // Content changes (strand chips, the vantage label, a jobs chip) change the widths: refit.
  const mo = typeof MutationObserver === 'function' && toolbar ? new MutationObserver(scheduleFit) : null;
  // `hidden` too (fix pass): the STEMM, All real and Your imports buttons appear by attribute once /api/corpora answers,
  // which changed nothing the observers saw, so More slid under the jobs chip (fit itself only toggles classes)
  mo?.observe(toolbar, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  cleanups.push(() => { ro?.disconnect(); mo?.disconnect(); cancelAnimationFrame(fitRaf); });

  // ── Sync ──
  function syncView(v) {
    corpusDemo.setAttribute('aria-pressed', String(v.corpus === 'demo'));
    corpusCipher.setAttribute('aria-pressed', String(v.corpus === 'cipher'));
    corpusUser.setAttribute('aria-pressed', String(v.corpus === 'user'));
    corpusStemm.setAttribute('aria-pressed', String(v.corpus === 'stemm'));
    corpusReal.setAttribute('aria-pressed', String(v.corpus === REAL_CORPUS));
    if (v.corpus === 'stemm') corpusStemm.hidden = false;
    if (v.corpus === REAL_CORPUS) corpusReal.hidden = false;
    tierSel.value = v.tier;
    deepBtn.setAttribute('aria-pressed', String(v.axis.mode === 'folded'));
    const open = v.vantage.day >= VANTAGE_OPEN_DAY;
    const text = open ? 'as of: no limit' : `as of ${dayLabel(v.vantage.day)}`;
    if (vantage.dataset.text !== `${text}|${v.vantage.strict}`) {
      vantage.dataset.text = `${text}|${v.vantage.strict}`;
      clear(vantage);
      vantage.append(text);
      if (!open) vantage.append(h('span.vantage-mode', null, ` · ${v.vantage.strict ? 'strict' : 'context'}`));
    }
    vantage.title = v.vantage.strict ? 'Strict: evidence later than the vantage is hidden. Press V to ghost it instead.' : 'Context: evidence later than the vantage is ghosted at 15%. Press V to hide it.';
    vantage.setAttribute('aria-label', `Vantage ${vantage.textContent}. Toggle strict or context (V).`);
  }
  function syncHealth(health) {
    const ok = cipherOpenable(health);
    if (contractAtLeast(health?.contract, [1, 3]) && !health?.mock) corpusReal.hidden = false;
    corpusCipher.setAttribute('aria-disabled', String(!ok && store.get().view.corpus !== 'cipher'));
    corpusCipher.title = ok ? 'Cipher: your real corpus (public-domain texts + culture metadata; no lyrics)' : cipherReason(health);
  }
  function syncHub(st) {
    const label = st.playing ? 'Pause (Space)' : 'Play (Space)';
    for (const b of [playBtn, nbPlay]) {
      if (b.dataset.state === String(Boolean(st.playing))) continue;
      b.dataset.state = String(Boolean(st.playing));
      clear(b);
      b.append(icon(st.playing ? 'pause' : 'play'));
      if (b === nbPlay) b.append(h('span', null, st.playing ? 'Pause' : 'Play'));
      b.setAttribute('aria-label', label);
      b.title = label;
      b.setAttribute('aria-pressed', String(Boolean(st.playing)));
    }
    // Options finer than the automatic tier cannot be forced (§1.6).
    const auto = st.tier && store.get().view.tier === 'auto' ? st.tier : null;
    for (const opt of tierSel.options) {
      if (opt.value === 'auto') continue;
      opt.disabled = auto ? TIER_LEVEL[opt.value] > TIER_LEVEL[auto] : false;
    }
  }
  function syncMotion() {
    const reduce = document.documentElement.dataset.motion === 'reduce';
    toolbar?.classList.toggle('is-reduced', reduce);
    // Reduced motion makes Step ▸ the primary control (§1.9): it keeps its place longest.
    stepFwd.classList.toggle('btn-primary', reduce);
    stepFwd.dataset.prio = reduce ? '60' : '40';
    scheduleFit();
  }

  cleanups.push(store.subscribe((s) => s.view, syncView, { immediate: true }));
  cleanups.push(store.subscribe((s) => s.ui.health, syncHealth, { immediate: true }));
  cleanups.push(store.subscribe((s) => s.view.reducedMotion, () => queueMicrotask(syncMotion), { immediate: true }));
  cleanups.push(store.subscribe((s) => s.ui.layout, () => { closeMore(); scheduleFit(); }));
  // On a phone one sheet at a time (fix pass, §8.6): opening Lanes closes Filters and the other way round.
  cleanups.push(store.subscribe((s) => s.ui.lanesOpen, (open) => { if (open && narrow() && store.get().ui.filtersOpen) dispatch({ type: 'UI_SET', key: 'filtersOpen', value: false }); }));
  cleanups.push(store.subscribe((s) => s.ui.filtersOpen, (open) => { if (open && narrow() && store.get().ui.lanesOpen) dispatch({ type: 'UI_SET', key: 'lanesOpen', value: false }); }));
  cleanups.push(scrollHub.subscribe(syncHub, { immediate: true }));

  // Corpora list: show "Your imports" only when that corpus has collections.
  api.get('/corpora', null, { key: 'corpora' }).then((list) => {
    const user = Array.isArray(list) ? list.find((c) => c.slug === 'user') : null;
    corpusUser.hidden = !(user?.collections?.length);
    const stemm = Array.isArray(list) ? list.find((c) => c.slug === 'stemm') : null;
    corpusStemm.hidden = !(stemm?.collections?.some((c) => (c.docs ?? 0) > 0)) && store.get().view.corpus !== 'stemm';
  }).catch((err) => { if (!isAbort(err)) { /* corpora are optional for the toolbar */ } });

  cleanups.push(keys.register('global', {
    '?': { run: () => dispatch({ type: 'UI_SHEET', sheet: { kind: 'help' } }), label: 'shortcut sheet' },
  }));
  return { unmount() { for (const fn of cleanups.splice(0)) fn(); clear(el); } };
}
