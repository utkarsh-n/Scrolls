// OWNER: WP6
// timeline/legend.mjs — the persistent legend (SPEC §1.2, §1.3, §1.7, §8.7). Always visible under the
// Scroll as ONE compact line: what a bar, a gap, a wash and a cap mean, the evidence line styles when arcs are
// drawn, the height scale per unit ("height: per million tokens · full = 84/M"), the coverage step classes and
// the lane-order note. When the line is short of room the least important items give way (priority+) — they
// stay in the Full legend, which lists every row of evidence-style.LEGEND_ROWS. Swatches are painted by
// paint.mjs — the same code as the Scroll — so a legend row can never disagree with a mark. On narrow screens
// the legend is a chip that opens the Full legend.

import { BADGES, LEGEND_ROWS } from '../../shared/evidence-style.mjs';
import { formatRate, formatCount, unitLabel } from '../../shared/format.mjs';
import { COVERAGE_STEPS, LANE_ORDER_NOTE, STRAND_GLYPH_CHARS } from '../../shared/vocab.mjs';
import { edgeStyle } from '../../shared/evidence-style.mjs';
import { h, clear, trapFocus } from '../core/dom.mjs';
import { fitPriority } from '../shell/layout.mjs';
import { paintSwatch, readPalette } from './paint.mjs';
import { scrollHub } from './viewport.mjs';

const W = 30, H = 14, MID = 7;
/** Swatch primitives (display-list form) for the bin states and marks of the Scroll. */
export const SWATCHES = Object.freeze({
  observed: [{ kind: 'rect', style: 'bar', x0: 2, x1: 28, y0: 3, y1: 11, round: 'lr' }],
  sparse: [{ kind: 'rect', style: 'bar-sparse', x0: 2, x1: 28, y0: 4, y1: 10, round: 'lr' }],
  absent: [{ kind: 'path', style: 'absent', x0: 2, x1: 28, y0: MID, y1: MID, points: [[2, MID], [28, MID]] }],
  low: [{ kind: 'band', style: 'hatch-low', x0: 0, x1: W, y0: 0, y1: H }, { kind: 'tick', style: 'low-tick', x0: 13, x1: 16, y0: 3, y1: 11 }],
  uncovered: [{ kind: 'band', style: 'hatch', x0: 0, x1: W, y0: 0, y1: H }],
  pending: [{ kind: 'band', style: 'dots', x0: 0, x1: W, y0: 0, y1: H }],
  wash: [{ kind: 'wash', style: 'wash', x0: 1, x1: 29, y0: 2, y1: 12, feather: 0 }],
  estimated: [{ kind: 'rect', style: 'bar', pattern: 'stripes', x0: 2, x1: 28, y0: 3, y1: 11, round: 'lr' }],
  synthetic: [{ kind: 'rect', style: 'bar', pattern: 'syn', x0: 2, x1: 28, y0: 3, y1: 11, round: 'lr' }],
  caps: [{ kind: 'rect', style: 'bar', x0: 6, x1: 24, y0: 4, y1: 10, round: 'lr' }, { kind: 'glyph', style: 'cap-start', text: '●', x0: 6, x1: 6, y0: MID, y1: MID }, { kind: 'rect', style: 'cap-end', x0: 23, x1: 25, y0: 2, y1: 12 }],
  censored: [{ kind: 'rect', style: 'bar', x0: 6, x1: 24, y0: 4, y1: 10, round: 'lr' }, { kind: 'glyph', style: 'cap-chevron', text: '◁', x0: 6, x1: 6, y0: MID, y1: MID }, { kind: 'glyph', style: 'cap-chevron', text: '▷', x0: 25, x1: 25, y0: MID, y1: MID }],
  mark: [{ kind: 'tick', style: 'mark-text', x0: 8, x1: 9, y0: 3, y1: 11 }, { kind: 'diamond', style: 'mark-title', x0: 17, x1: 22, y0: 4.5, y1: 9.5 }],
  bracket: [{ kind: 'path', style: 'bracket-stated', x0: 3, x1: 27, y0: 4, y1: 10, points: [[3.5, 4], [3.5, MID], [26.5, MID], [26.5, 4]] }],
  share: [{ kind: 'rect', style: 'share-box', x0: 3, x1: 13, y0: 6, y1: 13, whisker: [3, 9] }, { kind: 'rect', style: 'share-box', x0: 16, x1: 27, y0: 9, y1: 13, whisker: [7, 11] }],
  'share-low': [{ kind: 'rect', style: 'share-low', x0: 5, x1: 25, y0: 6, y1: 13 }],
  ribbon: [{ kind: 'band', style: 'arc-ribbon', status: 'documented', x0: 1, x1: 15, y0: 5, y1: 10 }, { kind: 'band', style: 'arc-ribbon', status: 'computed', x0: 15, x1: 29, y0: 7, y1: 10 }],
});

/** The compact rows of the persistent strip, in order, with their priority (lower gives way first). */
export const STRIP_ROWS = Object.freeze([
  ['observed', 'observed', 95], ['absent', 'looked, found none', 90], ['uncovered', 'no sources', 88], ['low', 'low coverage', 83],
  ['sparse', '1–4 matches', 70], ['pending', 'indexing', 52], ['wash', 'wash: wider date', 66],
  ['caps', 'first ● · last ▏', 58], ['censored', '◁ ▷ may extend', 54], ['mark', 'one occurrence', 80],
]);
/** Evidence line styles shown in the strip while arcs are drawn (§8.7). */
export const STRIP_EDGES = Object.freeze([
  ['documented', 'DOC documented', { evidence_status: 'documented', family: 'citation' }],
  ['computed', 'CALC computed', { evidence_status: 'computed', family: 'quotation' }],
  ['proposed', 'PROP proposed', { evidence_status: 'proposed', family: 'allusion' }],
]);

/**
 * Height-scale lines, one per unit present (§1.2 item 6): "height: per million tokens · full = 10,790/M tokens".
 * @param {Record<string, {unit: string, max: number}>} units
 * @returns {string[]}
 */
export function unitScaleLines(units) {
  return Object.values(units ?? {}).filter((u) => u.max > 0).map((u) => `height: ${unitLabel(u.unit)} · full = ${formatRate(u.max, u.unit)}`);
}

/** Coverage class labels per unit (§1.7). */
export function coverageClassLabels(unit = 'tokens') {
  const s = COVERAGE_STEPS[unit === 'works' ? 'works' : 'tokens'];
  const f = (n) => (n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}k` : formatCount(n));
  return ['0', `<${f(s[0])}`, `<${f(s[1])}`, `<${f(s[2])}`, `≥${f(s[2])}`];
}

/**
 * The coverage gate in force (§9.1: the demo's legend says "demo setting; real collections use 50,000").
 * @param {{coverage_gate?: Record<string, number>, note?: string}|null|undefined} gate query.gates.rates
 * @returns {string|null}
 */
export function gateLine(gate) {
  if (!gate?.coverage_gate) return null;
  const parts = Object.entries(gate.coverage_gate).filter(([, n]) => Number.isFinite(n)).map(([u, n]) => `${formatCount(n)} ${u}`);
  return parts.length ? `rates from ${parts.join(', ')} per bin${gate.note ? ` (${gate.note})` : ''}` : null;
}

function edgeSwatch(canvas, style, palette) {
  const c = canvas.getContext('2d');
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  canvas.width = 40 * dpr; canvas.height = H * dpr;
  canvas.style.width = '40px'; canvas.style.height = `${H}px`;
  c.scale(dpr, dpr);
  const hue = { amber: palette.amber, violet: palette.violet, ivory2: palette['ink-2'], danger: palette.danger, cyan: palette.cyan }[style.hue] ?? palette.ink;
  c.globalAlpha = style.opacity ?? 1;
  c.strokeStyle = hue; c.fillStyle = hue; c.lineWidth = style.width ?? 1.5;
  c.setLineDash(style.dash ?? []);
  c.beginPath(); c.moveTo(3, MID); c.lineTo(31, MID); c.stroke();
  c.setLineDash([]);
  if (style.endpoint === 'dot') { c.beginPath(); c.arc(34, MID, 2.6, 0, Math.PI * 2); c.fill(); }
  else if (style.endpoint === 'square') { c.strokeRect(31.5, MID - 2.5, 5, 5); }
  else if (style.endpoint === 'question') { c.font = `10px ${palette['font-ui']}`; c.fillText('?', 31.5, MID + 3.5); }
  if (style.strike) { c.beginPath(); c.moveTo(12, 3); c.lineTo(22, 11); c.stroke(); }
}

/**
 * @param {HTMLElement} el this module's slot in #legend
 * @param {{store: object}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store } = ctx;
  const doc = el.ownerDocument;
  let palette = readPalette(doc.documentElement);
  let release = null;
  const strip = h('div.legend-strip', { role: 'group', 'aria-label': 'Legend (compact; Full legend lists every row)' });
  const chip = h('button.chip.legend-chip', { type: 'button', onClick: () => openFull() }, 'Legend');
  const full = h('div.legend-full', { role: 'dialog', 'aria-label': 'Full legend', hidden: true });
  el.append(strip, chip, full);

  const swatch = (key) => {
    const cv = h('canvas.legend-swatch', { 'aria-hidden': 'true' });
    paintSwatch(cv, SWATCHES[key], palette, { width: W, height: H });
    return cv;
  };
  const item = (prio, ...children) => h('span.legend-item', { dataset: { prio: String(prio) } }, ...children);

  let lastKey = '';
  function renderStrip(st) {
    const model = st.model;
    const view = store.get().view;
    const arcsShown = Boolean(st.arcs?.items?.length || st.arcs?.bundles?.length || st.arcs?.individual?.length);
    const summary = st.arcs?.mode === 'summary';
    const shares = Boolean(model?.lanes?.some((l) => l.share));
    const key = JSON.stringify([unitScaleLines(model?.units), view.strands.map((s) => [s.glyph, st.strandLabels?.get(String(s.id))]), st.query?.gates?.rates,
      Boolean(st.query?.provenance?.synthetic), model?.coverageTrack?.map((r) => r.unit), Boolean(model?.override), arcsShown, Boolean(model?.coverageOnly), summary, shares]);
    if (key === lastKey) return;
    lastKey = key;
    clear(strip);
    for (const s of view.strands) {
      strip.append(item(100, h('span.strand-glyph', { 'aria-hidden': 'true' }, STRAND_GLYPH_CHARS[s.glyph] ?? '●'),
        h('span.legend-strand', null, st.strandLabels?.get(String(s.id)) ?? `${s.type} ${s.id}`)));
    }
    if (model?.coverageOnly) {
      strip.append(item(96, h('span.cov-span-sw', { 'aria-hidden': 'true' }), h('span', null, 'dated span of a collection (nothing counted yet)')));
    } else {
      for (const [k, label, prio] of STRIP_ROWS) {
        if (k === 'mark' && !model?.override) continue;
        strip.append(item(prio, swatch(k), h('span', null, label)));
      }
      if (st.query?.provenance?.synthetic) strip.append(item(92, swatch('synthetic'), h('span', null, 'synthetic (striped)')));
      if (arcsShown) for (const [k, label, rel] of STRIP_EDGES) {
        const cv = h('canvas.legend-swatch', { 'aria-hidden': 'true' });
        edgeSwatch(cv, edgeStyle(rel), palette);
        strip.append(item({ documented: 87, computed: 86, proposed: 85 }[k], cv, h('span', null, label)));
      }
      if (shares) {
        strip.append(item(84, swatch('share'), h('span', { title: 'OpenAlex cells: k of n sampled works mention the strand, with a Wilson 95% interval — within each cell only' }, 'share of a cell’s sample')));
        strip.append(item(64, swatch('share-low'), h('span', null, 'n < 20: no share')));
      }
      if (summary) strip.append(item(82, swatch('ribbon'), h('span', { title: 'Summarised links per lane pair: thickness ∝ log₂(n + 1); solid documented · dashed computed · dotted proposed' }, 'links summarised')));
      for (const line of unitScaleLines(model?.units)) strip.append(item(74, h('span.legend-scale.num', null, line)));
      const gl = gateLine(st.query?.gates?.rates);
      if (gl) strip.append(item(st.query?.provenance?.synthetic ? 72 : 46, h('span.legend-gate', { title: `Below the gate a bin is "low coverage": raw n, no rate.` }, gl)));
      const units = model?.coverageTrack?.map((r) => r.unit) ?? ['tokens'];
      for (const u of units.length ? units : ['tokens']) {
        strip.append(item(48, h('span.legend-coverage', { title: 'coverage (step classes): a stated 5-class scale, never a log axis' },
          h('span', null, `coverage (${u})`),
          coverageClassLabels(u).map((lab, i) => h('span.cov-step', { dataset: { cls: String(i) } }, h('span.cov-sw', { 'aria-hidden': 'true' }), lab)))));
      }
    }
    strip.append(h('span.legend-note', { title: LANE_ORDER_NOTE }, LANE_ORDER_NOTE));
    strip.append(h('button.btn.legend-more', { type: 'button', onClick: () => openFull() }, 'Full legend'));
    fitStrip();
  }

  /** One line, never wrapped: the least important items give way (they stay in the Full legend). */
  function fitStrip() {
    if (!strip.isConnected || !strip.clientWidth) return;
    const items = [...strip.querySelectorAll('.legend-item[data-prio]')];
    fitPriority(items.map((n) => ({ prio: Number(n.dataset.prio), hide: () => { n.hidden = true; }, show: () => { n.hidden = false; } })),
      () => strip.scrollWidth > strip.clientWidth + 1);
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitStrip()) : null;
  ro?.observe(strip);

  function openFull() {
    clear(full);
    const close = () => { full.hidden = true; release?.(); release = null; };
    const rows = LEGEND_ROWS.map((r) => {
      let sw;
      if (r.group === 'evidence' || r.group === 'overlay') {
        sw = h('canvas.legend-swatch', { 'aria-hidden': 'true' });
        edgeSwatch(sw, r.style, palette);
      } else if (r.group === 'bins') {
        sw = swatch({ observed: 'observed', sparse: 'sparse', single_source: 'observed', estimated: 'estimated', absent: 'absent', low: 'low', uncovered: 'uncovered', pending: 'pending' }[r.key] ?? 'observed');
      } else if (r.group === 'role') {
        sw = h('span.role-sw', { dataset: { hue: r.key }, 'aria-hidden': 'true' });
      } else sw = null;
      const badge = r.style?.badge ? h('span.badge', null, r.style.badge) : r.key === 'single_source' ? h('span.badge', null, '¹') : null;
      return h('tr', null, h('td.legend-sw-cell', null, sw), h('th', { scope: 'row' }, r.label, badge ? ' ' : null, badge), h('td.meta', null, r.description));
    });
    full.append(...[
      h('div.pop-head', null, h('h2.pop-title', null, 'Legend'), h('button.btn', { type: 'button', 'aria-label': 'Close', onClick: close }, '×')),
      h('p.meta', null, 'An analytical model, not a claim that meaning has four dimensions. Evidence is told apart by line pattern, endpoint and word — never by colour alone.'),
      h('table.legend-table', null, h('tbody', null, rows)),
      ...unitScaleLines(scrollHub.get().model?.units).map((l) => h('p.meta', null, l)),
      gateLine(scrollHub.get().query?.gates?.rates) ? h('p.meta', null, `Coverage gate: ${gateLine(scrollHub.get().query?.gates?.rates)}.`) : null,
      h('p.meta', null, 'Coverage (step classes): 0 · <10k · <100k · <1M · ≥1M tokens (works: 0 · <10 · <100 · <1,000 · ≥1,000); hatched = no sources; dotted = indexing.'),
      h('p.meta', null, 'Etymology bands are periods of a language, not dates for a word; Wiktionary claims are hollow amber diamonds (external claims); the external baseline is a different corpus.'),
      h('p.meta', null, 'OpenAlex lanes: one box per OpenAlex cell — the share of that cell’s top-cited sample that mentions the strand, with its Wilson 95% interval; hollow when the cell has fewer than 20 sampled works. A share of the top-cited sample in each cell — not a trend.'),
      h('p.meta', null, 'Beyond 1,500 links the arcs are summarised: a quiet ribbon per lane pair, thickness ∝ log₂(n + 1), solid = mostly documented, dashed = computed, dotted = proposed; the most important links are drawn on top. Below 50 years every link is drawn.'),
      h('p.meta', null, `Badges: ${Object.values(BADGES).map((b) => `${b.text} = ${b.title}`).join(' · ')}`)].filter(Boolean));
    full.hidden = false;
    release = trapFocus(full);
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); full.removeEventListener('keydown', onKey); } };
    full.addEventListener('keydown', onKey);
  }

  const unsub = scrollHub.subscribe(renderStrip, { immediate: true });
  const unsubS = store.subscribe((s) => s.view.strands, () => { lastKey = ''; renderStrip(scrollHub.get()); });
  return { unmount() { unsub(); unsubS(); ro?.disconnect(); release?.(); strip.remove(); chip.remove(); full.remove(); } };
}
