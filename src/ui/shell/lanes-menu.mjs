// OWNER: WP6
// shell/lanes-menu.mjs — the lanes column (SPEC §1.3, §1.4): the facet picker and the ORDER RULE (always
// printed), then one DOM header per lane aligned with the Scroll — "label · unit · coverage", the selection
// note ("selected by prominence"), "⚠ 34% of matches undated", "indexing — not yet looked" — and the
// "+n more lanes" row. `L` cycles the facet. No y-axis, no ticks: lanes are categories, not a scale.
// The informative line wraps to two lines (the full header is the row's tooltip); on narrow screens the
// column is a ≤ 88 px label rail and a tap opens the lane's details in a sheet.

import { formatCount, formatShare, formatTokens, unitLabel } from '../../shared/format.mjs';
import { LANE_FACETS, LANE_FACET_LABELS, LANE_ORDERS, LANE_ORDER_NOTE, RATE_UNITS } from '../../shared/vocab.mjs';
import { h, clear, trapFocus } from '../core/dom.mjs';
import { isAbort } from '../core/api.mjs';
import { canClusterLanes, clusterHeader, MACHINE_NOTE } from '../timeline/clusters.mjs';
import { scrollHub } from '../timeline/viewport.mjs';
import { GEOM, LANES_TOP } from '../timeline/display.mjs';
import { SHARE_NOTE } from '../timeline/share-cells.mjs';
import { applyPreset, LANE_PRESETS, REAL_CORPUS, TRAIL_FACET, trailFacetKnown } from './presets.mjs';

export const ORDER_LABELS = Object.freeze({ first_observed: 'first observed', total_n: 'total n', alphabetical: 'alphabetical', manual: 'manual (drag)' });
/** Facet names in the menu (the vocabulary's header labels, with the C1/C2 names for the new ones). */
export const FACET_MENU_LABELS = Object.freeze({ ...LANE_FACET_LABELS, cluster: 'Context groups', trail: 'Term trail' });
/** Share of undated matches from which a lane header warns (§1.7). */
export const UNDATED_WARN = 0.2;

/**
 * The second line of a lane header: unit · coverage (from the server's header when it has one).
 * @param {{label: string, header?: string|null, modality: string, unit: string, laneCoverage?: object, covUnit?: string}} lane
 * @returns {string}
 */
export function laneSubtitle(lane) {
  if (lane.header && lane.header.startsWith(`${lane.label} · `)) return lane.header.slice(lane.label.length + 3);
  const cov = lane.laneCoverage ?? {};
  const amount = lane.covUnit === 'works' ? cov.works : cov.tokens;
  const span = Array.isArray(cov.span) && cov.span.every(Number.isFinite) ? `, ${cov.span[0]}–${cov.span[1]}` : '';
  return [lane.modality, `${formatTokens(amount)} ${lane.covUnit ?? 'tokens'}${span}`].filter(Boolean).join(' · ');
}

/**
 * Notes printed under a lane header.
 * @param {object} lane lane model
 * @param {string} facet
 * @returns {Array<{kind: string, text: string}>}
 */
export function laneNotes(lane, facet) {
  const out = [];
  if (lane.pending) out.push({ kind: 'pending', text: lane.note ?? 'indexing — not yet looked' });
  // The server's header may already end with the selection note ("… · curated selection"): never say it twice.
  if (lane.selection && !String(lane.header ?? '').includes(lane.selection)) out.push({ kind: 'selection', text: lane.selection });
  if (lane.undatedShare >= UNDATED_WARN) out.push({ kind: 'warn', text: `⚠ ${formatShare(lane.undatedShare)} of matches undated` });
  if (lane.share) out.push({ kind: 'share', text: SHARE_NOTE });
  if (facet === 'cluster' && !lane.residual) {
    const ch = clusterHeader(lane);
    out.push({ kind: 'machine', text: ch.machine ?? MACHINE_NOTE });
  } else if (facet === 'cluster') out.push({ kind: 'machine', text: 'uses no context group holds' });
  return out;
}

/**
 * What a lane's heights are, in words: "rates per million tokens"; an OpenAlex lane's within-cell share note; for a
 * lane that never carries a rate (works counted, periods) the unit's own words.
 * @param {{unit: string, share?: boolean}} lane
 * @returns {string}
 */
export function rateWords(lane) {
  if (lane.share) return SHARE_NOTE;
  if (RATE_UNITS[lane.unit]?.scale === 0) return unitLabel(lane.unit);
  return `rates ${unitLabel(lane.unit)}`;
}

/**
 * The facet options of the lanes menu: every facet; 'cluster' only for exactly one pinned expression (C1).
 * @param {{strands: object[]}} view
 * @returns {Array<{value: string, label: string, disabled: boolean, title: string|null}>}
 */
export function facetOptions(view) {
  return LANE_FACETS.map((f) => {
    // The Term trail's lane set spans every real corpus: inside one corpus it is reached through its preset.
    const off = (f === 'cluster' && !canClusterLanes(view.strands)) || (f === TRAIL_FACET && view.corpus !== REAL_CORPUS);
    return { value: f, label: FACET_MENU_LABELS[f] ?? f, disabled: off,
      title: f === 'cluster' && off ? 'Context groups are drawn for exactly one pinned expression.' : f === TRAIL_FACET && off ? 'The Term trail spans every real corpus: use the preset “Term trail (all real corpora)”.' : null };
  });
}

/** Next facet for `L` (skips 'cluster' unless exactly one expression is pinned, and the corpus-wide 'trail'). */
export function nextFacet(facet, canCluster = false) {
  const list = LANE_FACETS.filter((f) => (f !== 'cluster' || canCluster) && f !== TRAIL_FACET);
  return list[(list.indexOf(facet) + 1) % list.length];
}

/**
 * @param {HTMLElement} el this module's slot in #lanes
 * @param {{store: object, keys: object, announce: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, keys, announce } = ctx;
  const cleanups = [];

  const presetCtx = { store, api: ctx.api, announce };
  const runPreset = (id) => applyPreset(presetCtx, id).catch((err) => {
    if (!isAbort(err)) store.dispatch({ type: 'UI_TOAST', toast: { kind: 'error', text: err.message, hint: err.hint ?? null } });
  });
  const facetSel = h('select.lanes-facet', { 'aria-label': 'Lanes by facet, or a preset', onChange: (e) => {
    const v = e.target.value;
    if (v.startsWith('preset:')) { e.target.value = store.get().view.lanes.facet; runPreset(v.slice(7)); return; }
    store.dispatch({ type: 'SET_LANES', lanes: { facet: v } });
  } });
  /** Facet options follow the pinned strands (context groups need exactly one expression). */
  function renderFacets(view) {
    clear(facetSel);
    facetSel.append(h('optgroup', { label: 'Lanes by' }, facetOptions(view).map((o) => h('option', { value: o.value, disabled: o.disabled, title: o.title }, o.label))),
      h('optgroup', { label: 'Presets' }, LANE_PRESETS.filter((p) => p.id !== 'trail' || trailFacetKnown()).filter((p) => !p.corpus || p.corpus === view.corpus)
        .map((p) => h('option', { value: `preset:${p.id}` }, p.label))));
    facetSel.value = view.lanes.facet;
  }
  const orderSel = h('select.lanes-order', { 'aria-label': 'Lane order rule', title: LANE_ORDER_NOTE, onChange: (e) => store.dispatch({ type: 'SET_LANES', lanes: { order: e.target.value } }) },
    LANE_ORDERS.map((o) => h('option', { value: o }, `order: ${ORDER_LABELS[o]}`)));
  const head = h('div.lanes-head', { style: { height: `${LANES_TOP}px` } },
    h('div.lanes-head-row', { style: { height: `${GEOM.rulerH}px` } }, facetSel),
    h('div.lanes-head-row.lanes-head-sub', { style: { height: `${GEOM.coverageH}px` } }, orderSel, h('span.meta.lanes-cov', { title: 'Grey step classes: 0 · <10k · <100k · <1M · ≥1M tokens (works: 0 · <10 · <100 · <1,000 · ≥1,000). Hatched = no coverage.' }, 'coverage')));
  const body = h('div.lanes-body', { role: 'list', 'aria-label': 'Lanes' });
  const column = h('div.lanes-col', null, head, body);
  el.appendChild(column);

  let rows = new Map();
  let lastKey = '';

  function render(st) {
    const model = st.model;
    const lay = st.layout;
    const view = store.get().view;
    if (facetSel.value !== view.lanes.facet) facetSel.value = view.lanes.facet;
    orderSel.value = view.lanes.order;
    body.style.setProperty('--lanes-scroll', `${-st.scrollY}px`);
    if (!model || !lay) {
      const key = `empty:${st.status}`;
      if (key === lastKey) return;
      lastKey = key;
      clear(body);
      rows = new Map();
      body.append(h('p.lanes-status.meta', null, st.status === 'error' ? 'The lanes could not be loaded.' : st.status === 'materializing' ? 'counting…' : st.status === 'loading' ? 'Registering the query…' : ''));
      return;
    }
    const key = JSON.stringify([model.lanes.map((l) => [l.key, l.label, l.header, l.undatedShare, l.pending]), lay.lanes.map((l) => [l.y, l.h]), lay.extra,
      lay.height, model.hiddenLanes, view.lanes.facet, st.focusLane, model.coverageOnly]);
    if (key !== lastKey) {
      lastKey = key;
      clear(body);
      rows = new Map();
      const narrow = store.get().ui.layout?.mode === 'narrow';
      model.lanes.forEach((lane, i) => {
        const l = lay.lanes[i];
        const notes = laneNotes(lane, view.lanes.facet);
        const sub = laneSubtitle(lane);
        const full = model.coverageOnly ? `${lane.label} · ${sub}${lane.selection ? ` · ${lane.selection}` : ''}`
          : `${lane.label} · ${sub} · ${rateWords(lane)} · n = ${formatCount(lane.n)} in ${formatCount(lane.docs)} documents${notes.length ? ` · ${notes.map((n) => n.text).join(' · ')}` : ''}`;
        const row = h('div.lane-head', {
          role: 'listitem', tabindex: narrow ? '0' : null, dataset: { focus: String(i === st.focusLane), alt: String(i % 2 === 1), lines: String(l.h >= 64 ? 3 : l.h >= 48 ? 2 : 1),
            ...(notes.length ? { notes: '1' } : {}) },
          style: { top: `${l.y}px`, height: `${l.h}px` },
          title: full, 'aria-label': full,
          onClick: () => (narrow ? openLaneSheet(lane, i, full) : scrollHub.actions.focusLane?.(i)),
          onKeyDown: (e) => { if (narrow && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openLaneSheet(lane, i, full); } },
        },
        h('span.lane-label', null, view.lanes.facet === 'cluster' && lane.humanLabel ? h('span.lane-human', { title: 'human label (a notebook annotation)' }, '✎ ') : null,
          lane.label, lane.synthetic ? h('span.lane-syn', { title: 'synthetic demonstration data' }, 'SYN') : null),
        h('span.lane-sub', null, sub),
        notes.length ? h('span.lane-notes', null, renameButton(lane), notes.map((n) => h(`span.lane-note.note-${n.kind}`, null, n.text))) : renameButton(lane));
        rows.set(lane.key, row);
        body.append(row);
      });
      for (const [k, r] of Object.entries(lay.extra ?? {})) {
        const etym = k === 'etym';
        body.append(h(`div.lane-head.lane-extra.extra-${etym ? 'etym' : 'baseline'}`, {
          role: 'listitem', style: { top: `${r.y}px`, height: `${r.h}px` },
          title: etym ? 'Etymology — periods, not dates. Bands are the periods of the languages Wiktionary (via kaikki.org, CC BY-SA) lists; they are never dates for the word.'
            : 'External baseline: Google Books Ngram, English, 2020 edition — a different corpus (CC BY 3.0), on its own axis.',
        }, h('span.lane-label', null, etym ? 'Etymology' : 'Ngram baseline'), h('span.lane-sub', null, etym ? 'periods, not dates' : 'a different corpus')));
      }
      if (lay.more && model.hiddenLanes > 0) {
        const max = store.get().view.lanes.max;
        body.append(h('button.lanes-more', {
          type: 'button', style: { top: `${lay.more.y}px`, height: `${lay.more.h}px` },
          onClick: () => {
            if (narrow) store.dispatch({ type: 'UI_SET', key: 'lanesOpen', value: true });
            else store.dispatch({ type: 'SET_LANES', lanes: { max: Math.min(48, max + model.hiddenLanes) } });
          },
          title: `${formatCount(model.hiddenLanes)} more ${model.hiddenLanes === 1 ? 'lane' : 'lanes'}${model.hiddenN ? ` (n = ${formatCount(model.hiddenN)})` : ''}`,
        }, narrow ? `+${formatCount(model.hiddenLanes)} more` : `+${formatCount(model.hiddenLanes)} more ${model.hiddenLanes === 1 ? 'lane' : 'lanes'}${model.hiddenN ? ` (n = ${formatCount(model.hiddenN)})` : ''}`));
      }
      body.style.height = `${lay.height}px`;
    }
  }

  /** A context group's label is a notebook annotation of kind 'label' (§4.8): Rename opens the notebook on the group. */
  function renameButton(lane) {
    if (store.get().view.lanes.facet !== 'cluster' || lane.residual || !Number.isInteger(lane.clusterId)) return null;
    return h('button.lane-rename', { type: 'button', title: 'Rename this context group (a label annotation; the machine label stays visible)',
      'aria-label': `Rename the context group ${lane.label}`,
      onClick: (e) => {
        e.stopPropagation();
        store.dispatch({ type: 'SELECT', selection: { type: 'cluster', id: lane.clusterId } });
        store.dispatch({ type: 'OPEN_PANEL', panel: 'notebook' });
      } }, 'Rename');
  }

  // Narrow: the details of a lane in a sheet (the rail shows only its name).
  const laneSheet = h('div.lane-sheet', { role: 'dialog', 'aria-label': 'Lane details', hidden: true });
  el.appendChild(laneSheet);
  let releaseLane = null;
  function closeLaneSheet() { laneSheet.hidden = true; releaseLane?.(); releaseLane = null; }
  function openLaneSheet(lane, i, full) {
    clear(laneSheet);
    const notes = laneNotes(lane, store.get().view.lanes.facet);
    laneSheet.append(...[
      h('div.pop-head', null, h('h2.pop-title', null, lane.label, lane.synthetic ? h('span.badge.badge-syn', null, 'SYN') : null),
        h('button.btn', { type: 'button', 'aria-label': 'Close', onClick: closeLaneSheet }, '×')),
      h('p', null, laneSubtitle(lane)),
      lane.coverageOnly ? null : h('p.meta', null, `${rateWords(lane)} · n = ${formatCount(lane.n)} in ${formatCount(lane.docs)} documents`),
      notes.length ? h('ul.lane-sheet-notes', null, notes.map((n) => h('li', null, n.text))) : null,
      lane.undated ? h('p.meta', null, `${formatCount(lane.undated)} undated (outside chronology)`) : null,
      h('p.meta', null, LANE_ORDER_NOTE),
      h('div.pop-foot', null, h('button.btn', { type: 'button', onClick: () => { scrollHub.actions.focusLane?.(i); closeLaneSheet(); } }, 'Focus this lane'))].filter(Boolean));
    laneSheet.hidden = false;
    laneSheet.setAttribute('aria-label', full);
    releaseLane = trapFocus(laneSheet);
  }
  const onLaneKey = (e) => { if (e.key === 'Escape' && !laneSheet.hidden) { e.preventDefault(); e.stopImmediatePropagation(); closeLaneSheet(); } };
  document.addEventListener('keydown', onLaneKey, true);
  cleanups.push(() => { document.removeEventListener('keydown', onLaneKey, true); releaseLane?.(); laneSheet.remove(); });

  cleanups.push(store.subscribe((s) => [s.view.strands, s.view.corpus], () => {
    const v = store.get().view;
    renderFacets(v);
    // Context groups belong to exactly one expression (C1): a second strand (or none) returns the lanes to languages.
    if (v.lanes.facet === 'cluster' && v.strands.length && !canClusterLanes(v.strands)) {
      queueMicrotask(() => {
        store.dispatch({ type: 'SET_LANES', lanes: { facet: 'language', run: null } });
        announce('Context groups are drawn for exactly one pinned expression: lanes by language.');
      });
    }
  }, { immediate: true, equals: (a, b) => a[0] === b[0] && a[1] === b[1] }));
  cleanups.push(scrollHub.subscribe(render, { immediate: true }));
  cleanups.push(store.subscribe((s) => s.view.lanes, () => { lastKey = ''; renderFacets(store.get().view); render(scrollHub.get()); }));

  // Wheel over the column scrolls the lanes (the canvas wheel zooms).
  const onWheel = (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); scrollHub.actions.scrollBy?.(e.deltaY); } };
  column.addEventListener('wheel', onWheel, { passive: false });
  cleanups.push(() => column.removeEventListener('wheel', onWheel));

  // Narrow: the lanes sheet (facet + order + more lanes).
  const sheet = h('div.lanes-sheet', { role: 'dialog', 'aria-label': 'Lanes', hidden: true });
  el.appendChild(sheet);
  cleanups.push(store.subscribe((s) => s.ui.lanesOpen, (open) => {
    sheet.hidden = !open;
    if (!open) return;
    clear(sheet);
    const v = store.get().view;
    sheet.append(h('div.pop-head', null, h('h2.pop-title', null, 'Lanes'),
      h('button.btn', { type: 'button', 'aria-label': 'Close', onClick: () => store.dispatch({ type: 'UI_SET', key: 'lanesOpen', value: false }) }, '×')));
    sheet.append(h('p.meta', null, LANE_ORDER_NOTE));
    for (const o of facetOptions(v)) {
      sheet.append(h('button.action-item', { type: 'button', 'aria-pressed': String(v.lanes.facet === o.value), disabled: o.disabled, title: o.title,
        onClick: () => { store.dispatch({ type: 'SET_LANES', lanes: { facet: o.value } }); store.dispatch({ type: 'UI_SET', key: 'lanesOpen', value: false }); } }, o.label));
    }
    sheet.append(h('p.more-title', null, 'Presets'));
    for (const p of LANE_PRESETS.filter((x) => (x.id !== 'trail' || trailFacetKnown()) && (!x.corpus || x.corpus === v.corpus))) {
      sheet.append(h('button.action-item', { type: 'button', onClick: () => { store.dispatch({ type: 'UI_SET', key: 'lanesOpen', value: false }); runPreset(p.id); } }, p.label));
    }
    const st = scrollHub.get();
    if (st.model?.hiddenLanes) sheet.append(h('p.meta', null, `${st.model.hiddenLanes} more lanes are folded: narrow screens show 5 lanes; filter or change the facet to see others.`));
  }));

  cleanups.push(keys.register('global', {
    l: {
      run: () => {
        const v = store.get().view;
        const next = nextFacet(v.lanes.facet, canClusterLanes(v.strands));
        store.dispatch({ type: 'SET_LANES', lanes: { facet: next } });
        announce(`Lanes by ${FACET_MENU_LABELS[next] ?? next}.`);
      },
      label: 'cycle lane facet',
    },
  }));

  return { unmount() { for (const fn of cleanups.splice(0)) fn(); column.remove(); sheet.remove(); } };
}
