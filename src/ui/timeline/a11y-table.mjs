// OWNER: WP6
// timeline/a11y-table.mjs — the `T` table alternative (SPEC §8.6): an accessible <table> per lane and
// strand (bin, n, rate, CI, coverage, state, flags) plus a segment list, built from the SAME typed-array
// columns the painter reads (model.lanes[i].strands[j].cols — identity-tested), so the table cannot
// disagree with the picture. Gated or suppressed numbers print "—", never 0.

import { formatCI, formatCount, formatRate, formatTokens, unitLabel } from '../../shared/format.mjs';
import { CELL_STATES } from '../../shared/vocab.mjs';
import { h, clear } from '../core/dom.mjs';
import { describeModel } from './display.mjs';
import { STATE } from './model.mjs';
import { dayLabel } from './scale.mjs';
import { binLabel } from './tiers.mjs';
import { SHARE_NOTE, shareTableRows } from './share-cells.mjs';
import { scrollHub } from './viewport.mjs';

const FLAG_WORDS = [[1, 'sparse'], [2, 'single source ¹'], [4, 'mostly estimated ≈'], [8, 'sampled'], [16, 'synthetic'], [32, 'names excluded'], [64, 'translations included']];

/** Flag words of a cell. @param {number} flags @returns {string} */
export function flagWords(flags) {
  return FLAG_WORDS.filter(([bit]) => flags & bit).map(([, w]) => w).join(', ');
}

/**
 * Rows of one strand's table, read straight from its columns.
 * @param {{cols: object}} strand
 * @param {{unit: string, covUnit: string}} lane
 * @param {string} tier
 * @returns {Array<{bin: string, n: string, rate: string, ci: string, coverage: string, state: string, flags: string}>}
 */
export function strandRows(strand, lane, tier) {
  const c = strand.cols;
  const out = [];
  for (let i = 0; i < c.length; i++) {
    const st = c.state[i];
    const observed = st === STATE.observed || st === STATE.absent;
    out.push({
      bin: binLabel(tier, c.bin[i]),
      n: st === STATE.pending ? '—' : formatCount(c.n[i]),
      rate: observed ? formatRate(c.rate[i], lane.unit) : '—',
      ci: observed ? formatCI([c.ciLo[i], c.ciHi[i]], lane.unit) : '—',
      coverage: Number.isFinite(c.denom[i]) ? `${formatTokens(c.denom[i])} ${lane.covUnit}` : '—',
      state: { observed: 'observed', absent: 'looked, found none', low: 'low coverage (rate not shown)', uncovered: 'no sources', pending: 'indexing — not yet looked' }[CELL_STATES[st]] ?? String(st),
      flags: flagWords(c.flags[i]),
    });
  }
  return out;
}

/**
 * The segment list of a strand: bars, absences, low-coverage bins and gaps in order.
 * @param {object} strand
 * @param {object} lane
 * @param {string} tier
 * @returns {string[]}
 */
export function segmentList(strand, lane, tier) {
  const segs = [];
  for (const b of strand.bars) {
    segs.push({ lo: b.loDay, text: `observed ${dayLabel(b.loDay)}–${dayLabel(b.hiDay)}: ${b.bins} ${b.bins === 1 ? 'bin' : 'bins'}, n = ${formatCount(b.n)}; first ${b.startCap.label}${b.startCap.censored ? ' (may be older than our record)' : ''}, last ${b.endCap.label}${b.endCap.censored ? ' (may continue past our record)' : ''}` });
  }
  const c = strand.cols;
  for (let i = 0; i < c.length; i++) {
    if (c.state[i] === STATE.absent) segs.push({ lo: c.lo[i], text: `${binLabel(tier, c.bin[i])}: looked, found none (0 in ${formatTokens(c.denom[i])} ${lane.covUnit})` });
    if (c.state[i] === STATE.low) segs.push({ lo: c.lo[i], text: `${binLabel(tier, c.bin[i])}: low coverage, n = ${formatCount(c.n[i])} in ${formatTokens(c.denom[i])} ${lane.covUnit}` });
  }
  for (const r of lane.uncovered) segs.push({ lo: r[0], text: `${dayLabel(r[0])}–${dayLabel(r[1])}: no sources` });
  for (const r of lane.pendingRuns) segs.push({ lo: r[0], text: `${dayLabel(r[0])}–${dayLabel(r[1])}: indexing — not yet looked` });
  for (const w of strand.washes) segs.push({ lo: w.loDay, text: `wash ${w.label}: ${formatCount(w.n)} ${w.n === 1 ? 'match' : 'matches'} not counted in bars or rates` });
  return segs.sort((a, b) => a.lo - b.lo).map((s) => s.text);
}

/**
 * The table model: one entry per lane and strand, each holding a reference to the painter's columns.
 * @param {object} model buildModel() output
 * @returns {Array<{lane: string, strand: string, unit: string, source: object, rows: object[], segments: string[]}>}
 */
export function tableModel(model) {
  const out = [];
  for (const lane of model?.lanes ?? []) {
    for (const s of lane.strands) {
      // An OpenAlex lane (C3): one row per OpenAlex cell, k of n and the within-cell share, never a rate.
      if (lane.share && s.share?.length) {
        out.push({ lane: lane.label, laneKey: lane.key, strand: s.label, unit: SHARE_NOTE, source: s.share, rows: shareTableRows(s), share: true,
          segments: [`${s.share.length} OpenAlex cells; each share is within its own cell — not a trend.`], synthetic: lane.synthetic });
        continue;
      }
      out.push({ lane: lane.label, laneKey: lane.key, strand: s.label, unit: unitLabel(lane.unit), source: s.cols,
        rows: strandRows(s, lane, model.tier), segments: segmentList(s, lane, model.tier), synthetic: lane.synthetic });
    }
  }
  return out;
}

/**
 * @param {HTMLElement} el this module's slot in #a11y
 * @param {{store: object, keys: object, announce: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, keys, announce } = ctx;
  const section = h('div.a11y-tables', { hidden: true });
  el.appendChild(section);
  let lastModel = null;

  function render(st) {
    if (section.hidden || st.model === lastModel) return;
    lastModel = st.model;
    clear(section);
    const head = h('div.pop-head', null, h('h2.pop-title', null, 'Table alternative'),
      h('button.btn', { type: 'button', onClick: () => store.dispatch({ type: 'UI_SET', key: 'table', value: false }) }, 'Close (T)'));
    section.append(head, h('p.a11y-summary', null, describeModel(st.model)));
    if (!st.model) { section.append(h('p.meta', null, 'Nothing is drawn yet.')); return; }
    section.append(h('p.meta', null, `${st.model.tier} · bins of the visible range ±1 screen · rates ${Object.values(st.model.units).map((u) => unitLabel(u.unit)).join(', ') || '—'}`));
    for (const t of tableModel(st.model)) {
      section.append(h(`section.a11y-lane${t.synthetic ? '.syn-frame' : ''}`, null,
        h('table.a11y-table', null,
          h('caption', null, `Lane ${t.lane} · '${t.strand}' · ${t.unit}${t.synthetic ? ' · SYNTHETIC' : ''}`),
          h('thead', null, h('tr', null, (t.share ? ['cell', 'k of n', 'share', 'Wilson 95%', 'sampled', 'state', 'note'] : ['bin', 'n', 'rate', '95% CI', 'coverage', 'state', 'flags'])
            .map((c) => h('th', { scope: 'col' }, c)))),
          h('tbody', null, t.rows.length ? t.rows.map((r) => h('tr', null, h('th', { scope: 'row' }, r.bin), h('td.num', null, r.n), h('td.num', null, r.rate), h('td.num', null, r.ci),
            h('td.num', null, r.coverage), h('td', null, r.state), h('td', null, r.flags))) : h('tr', null, h('td', { colspan: '7' }, 'No cells in this range: no sources.')))),
        h('ul.a11y-segments', { 'aria-label': `Segments of lane ${t.lane}` }, t.segments.map((s) => h('li', null, s)))));
    }
  }

  const toggle = (on) => {
    section.hidden = !on;
    el.classList?.toggle('is-open', Boolean(on));
    if (on) { lastModel = null; render(scrollHub.get()); announce('Table alternative shown below the Scroll.'); }
  };
  const a = store.subscribe((s) => s.ui.table, toggle, { immediate: true });
  const b = scrollHub.subscribe(render);
  const c = keys.register('global', { t: { run: () => store.dispatch({ type: 'UI_SET', key: 'table', value: !store.get().ui.table }), label: 'table alternative' } });
  return { unmount() { a(); b(); c(); section.remove(); } };
}
