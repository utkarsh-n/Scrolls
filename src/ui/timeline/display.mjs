// OWNER: WP6
// timeline/display.mjs — the model → a DISPLAY LIST of primitives (SPEC §8.3). paint.mjs draws it on screen,
// svg.mjs serialises the very same list for snapshots, hit.mjs indexes it: what is clicked, painted and
// exported is one object.
//
// A primitive: { id, kind: 'rect'|'tick'|'diamond'|'path'|'text'|'glyph'|'band'|'wash', layer: 'bg'|'data'|'arcs',
//   x0, y0, x1, y1 | points, style: token, openable: boolean, ref, tip?, ghost?, t? }.
// x is in CONTENT pixels: (day − originDay) / daysPerPx, fixed at build time, so panning only translates
// (the hit grid is never rebuilt on pan, §8.4). Lane primitives have y relative to the top of the lane area;
// `top` primitives (ruler, coverage track) have y relative to the canvas top.
//
// The vantage (playhead) is applied here: observations later than the vantage are left out (strict) or
// ghosted at 15% (context). Absence, coverage and "no sources" describe the archive and stay (§1.9).

import { binStyle } from '../../shared/evidence-style.mjs';
import { formatCount, formatRate, formatTokens, formatCI } from '../../shared/format.mjs';
import { STRAND_GLYPH_CHARS } from '../../shared/vocab.mjs';
import { markLabel, STATE } from './model.mjs';
import { dayLabel, ticks as rulerTicks, createScale } from './scale.mjs';
import { binEndDay, binLabel, binOfDay, binStartDay, TIER_LEVEL } from './tiers.mjs';
import { drawableSeams, seamDay, shortSeamLabel } from './seams.mjs';
import { sharePrims, SHARE_UNIT } from './share-cells.mjs';

/** Geometry of §1.4 (px). */
export const GEOM = Object.freeze({
  rulerH: 32, coverageH: 24, laneMinH: 40, slotH: 24, slotCompact: 16, slotComfortable: 36, pad: 8, moreRowH: 28,
  underlayH: 3, markH: 8, diamond: 5, bracketH: 6, coarseH: 4, maxStrandsVisible: 48,
});
/** Per-frame budgets of §8.3. */
export const BUDGET = Object.freeze({ shapes: 20000, marks: 4000, texts: 150 });
/** Opacity of a ghosted (context-mode, later than the vantage) primitive. */
export const GHOST_ALPHA = 0.15;
/** Free room needed before chips and inline labels are drawn at rest (§1.4). */
export const LABEL_ROOM = 120;

/** Strand slot range when lanes fill the Scroll (§1.4 compact 24 … comfortable; the QA pass asked for ≈ 56). */
export const SLOT_RANGE = Object.freeze({ min: 24, max: 56 });
/** A filled lane grows to at most this multiple of its slots + padding (few lanes: room for arcs, no giant bands). */
const FILL_MAX = 2.5;

/** Width (px) of the seam caption at its 10.5 px semibold size ("Full text ends 1928 →"), a little generous. */
export const seamLabelWidth = (words) => Math.ceil(String(words).length * 6.4) + 4;
/**
 * Baseline of a folded overview's regime name: the ruler's top line, clear of the year labels (baseline rulerH − 12 at
 * 11.5 px, their caps start ≈ 11 px down) — names and years never share a line.
 */
export const REGIME_LABEL_Y = 9;
/** Width (px) of a ruler label at 11.5 px in the numeral font ('1900', '500 BCE'). */
export const rulerLabelWidth = (words) => Math.ceil(String(words).length * 7.2) + 2;

/** Width (px) of a wash label at its 10 px size: digits and dashes are narrow, so 5.8 px a character with a margin. */
export const washLabelWidth = (words) => Math.ceil(String(words).length * 5.8) + 4;

/**
 * Vertical layout of the lanes: a lane with one strand is 40 px tall; each strand row gets a slot (24 px);
 * every lane with the same number of rows has the same height (§1.3: no vertical scale of meaning). With
 * `fillH` the lanes share that height: the slot grows from 24 up to `slotMax` px and the lane keeps the rest
 * as padding (equal for every lane), so the Scroll is never half empty.
 * @param {Array<{key: string}>} lanes
 * @param {number} strandCount strand rows (0–12; a theme strand has up to three)
 * @param {{slotH?: number, moreRow?: boolean, fillH?: number|null, slotMax?: number,
 *          top?: Array<{key: string, h: number}>, bottom?: Array<{key: string, h: number}>}} [opts]
 *   `top` / `bottom`: extra rows (the etymology lane above, the external baseline track below)
 * @returns {{lanes: Array<{key: string, index: number, y: number, h: number, slots: Array<{y: number, h: number, mid: number}>}>,
 *            height: number, more: {y: number, h: number}|null, slotH: number, extra: Record<string, {y: number, h: number}>}}
 */
export function layoutLanes(lanes, strandCount, { slotH = GEOM.slotH, moreRow = false, fillH = null, slotMax = SLOT_RANGE.max, top = [], bottom = [] } = {}) {
  const k = Math.max(1, strandCount);
  let slot = slotH;
  let h = Math.max(GEOM.laneMinH, k * slotH + 2 * GEOM.pad);
  if (Number.isFinite(fillH) && fillH > 0 && lanes.length) {
    const extraH = [...top, ...bottom].reduce((sum, r) => sum + r.h, 0) + (moreRow ? GEOM.moreRowH : 0);
    const perLane = Math.floor((fillH - extraH) / lanes.length);
    slot = Math.max(slotH, Math.min(slotMax, Math.floor((perLane - 2 * GEOM.pad) / k)));
    h = Math.max(GEOM.laneMinH, k * slot + 2 * GEOM.pad, Math.min(perLane, Math.round((k * slot + 2 * GEOM.pad) * FILL_MAX)));
  }
  const pad = (h - k * slot) / 2;
  let y = 0;
  const extra = {};
  for (const r of top) { extra[r.key] = { y, h: r.h }; y += r.h; }
  const out = lanes.map((l, index) => {
    const slots = [];
    for (let i = 0; i < k; i++) {
      const sy = y + pad + i * slot;
      slots.push({ y: sy, h: slot, mid: sy + slot / 2 });
    }
    const lane = { key: l.key, index, y, h, slots };
    y += h;
    return lane;
  });
  const more = moreRow ? { y, h: GEOM.moreRowH } : null;
  if (more) y += more.h;
  for (const r of bottom) { extra[r.key] = { y, h: r.h }; y += r.h; }
  return { lanes: out, height: y, more, slotH: slot, extra };
}

/** Top of the lane area inside the Scroll canvas (ruler + coverage track). */
export const LANES_TOP = GEOM.rulerH + GEOM.coverageH;

const PRECISION_RANK = { millennium: 0, century: 1, decade: 2, year: 3, month: 4, day: 5 };
const TOOLTIP_STATE = {
  absent: (c, unit) => `0 occurrences in ${formatTokens(c.denom)} ${unit} — looked, found none`,
  low: (c, unit) => `low coverage: n = ${formatCount(c.n)} in ${formatTokens(c.denom)} ${unit} — rate not shown`,
};

/**
 * Tooltip lines of a bin, generated from the same numbers as the drawing.
 * @param {object} lane lane model
 * @param {object} strand strand model
 * @param {number} i column index
 * @param {string} tier
 * @returns {string[]}
 */
export function binTooltip(lane, strand, i, tier) {
  const c = strand.cols;
  const cell = { n: c.n[i], denom: c.denom[i], docs: c.docs[i] };
  const label = binLabel(tier, c.bin[i]);
  const unitWord = lane.covUnit;
  const lines = [`${strand.label} · ${lane.label} · ${label}`];
  const st = c.state[i];
  if (st === STATE.observed) {
    // an observed cell without a rate is a top-cited-per-cell sample (OpenAlex): its count only (§10.4, M5 gate)
    lines.push(Number.isFinite(c.rate[i]) ? `n = ${formatCount(cell.n)} · ${formatRate(c.rate[i], lane.unit)} ${formatCI([c.ciLo[i], c.ciHi[i]], lane.unit)} (95% CI)`
      : c.flags[i] & 8 ? `n = ${formatCount(cell.n)} · no rate: a top-cited sample per field × period (within-cell shares in Compare)`
        : `n = ${formatCount(cell.n)} · present: no rate is drawn for this lane`);
    lines.push(`${formatTokens(cell.denom)} ${unitWord} · ${formatCount(cell.docs)} ${cell.docs === 1 ? 'document' : 'documents'}`);
    const notes = [];
    if (c.flags[i] & 1) notes.push('sparse: 1–4 matches');
    if (c.flags[i] & 2) notes.push('¹ single-source burst (≥ 60% from one document)');
    if (c.flags[i] & 4) notes.push('≈ mostly estimated dates');
    if (c.flags[i] & 8) notes.push('sampled');
    if (notes.length) lines.push(notes.join(' · '));
  } else if (st === STATE.absent) lines.push(TOOLTIP_STATE.absent(cell, unitWord));
  else if (st === STATE.low) lines.push(TOOLTIP_STATE.low(cell, unitWord));
  else if (st === STATE.pending) lines.push('indexing — not yet looked');
  else lines.push('no sources');
  if (c.flags[i] & 16) lines.push('SYNTHETIC');
  return lines;
}

/** Visibility of something dated [lo, hi] at a vantage: 'show' | 'ghost' | 'hide'. */
export function vantageState(hiDay, vantage) {
  if (!vantage || hiDay <= vantage.day) return 'show';
  return vantage.strict ? 'hide' : 'ghost';
}

/**
 * Build the display list.
 * @param {object} model buildModel() output
 * @param {{originDay: number, daysPerPx: number, width: number, layout: ReturnType<typeof layoutLanes>,
 *          vantage?: {day: number, strict: boolean}|null, layers?: Record<string, 0|1>, seams?: object[],
 *          seamCollapsed?: boolean, textBudget?: number, focus?: object}} opts
 *   `width` is the content width in px of the built range.
 */
export function buildDisplay(model, { originDay, daysPerPx, width, layout, vantage = null, layers = {}, seams = [],
  seamCollapsed = false, textBudget = BUDGET.texts, xOffset = 0 }) {
  const X = (day) => (day - originDay) / daysPerPx + xOffset;
  // Marks and caps grow with the slot (spec sizes at the 24 px slot) so they stay legible in tall lanes.
  const slotH = layout.slotH ?? GEOM.slotH;
  const k = Math.min(1.6, Math.max(1, slotH / GEOM.slotH));
  const markH = Math.max(GEOM.markH, Math.min(28, slotH * 0.5)), diamond = Math.max(GEOM.diamond, Math.min(9, slotH * 0.16)), bracketH = GEOM.bracketH * k;
  const tier = model.tier;
  const top = [];
  const lanes = [];
  const stats = { rects: 0, ticks: 0, texts: 0, marks: 0 };
  let texts = 0;
  const text = (list, prim) => {
    if (texts >= textBudget) return;
    texts++;
    list.push(prim);
  };
  const add = (list, prim) => {
    if (prim.kind === 'tick' || prim.kind === 'diamond') stats.ticks++;
    else if (prim.kind !== 'text' && prim.kind !== 'glyph') stats.rects++;
    list.push(prim);
  };
  const gate = (prim, hiDay) => {
    const v = vantageState(hiDay, vantage);
    if (v === 'hide') return null;
    if (v === 'ghost') prim.ghost = true;
    return prim;
  };
  const showWashes = layers.washes !== 0;
  const showCoverage = layers.coverage !== 0;

  // ── Top: ruler ticks and labels (labels first in the text budget), coverage track ──────────────────
  // Ruler labels carry their estimated width: the painter lets one give way where a seam caption sits (seamCaptionPlace).
  const scale = createScale({ centerDay: originDay + (width / 2) * daysPerPx, daysPerPx, width });
  for (const t of rulerTicks(scale)) {
    const tx = t.x + xOffset;
    add(top, { id: `rt:${t.day}`, kind: 'tick', layer: 'bg', x0: tx, x1: tx, y0: GEOM.rulerH - 10, y1: GEOM.rulerH, style: 'ruler-major', openable: false, ref: null });
    text(top, { id: `rl:${t.day}`, kind: 'text', layer: 'bg', x0: tx + 5, y0: GEOM.rulerH - 12, x1: tx + 5, y1: GEOM.rulerH - 12, text: t.label, style: 'ruler-label',
      w: rulerLabelWidth(t.label), openable: false, ref: null });
  }
  // Minor ticks at bin edges (a bin is ≥ 8 px wide at its own tier).
  const [rLo, rHi] = [originDay, originDay + width * daysPerPx];
  const [b0, b1] = [binOfDay(tier, rLo), binOfDay(tier, rHi)];
  if (b1 - b0 <= 2000) {
    for (let b = b0; b <= b1 + 1; b++) {
      const x = X(binStartDay(tier, b));
      add(top, { id: `rm:${b}`, kind: 'tick', layer: 'bg', x0: x, x1: x, y0: GEOM.rulerH - 4, y1: GEOM.rulerH, style: 'ruler-minor', openable: false, ref: null });
    }
  }
  const ty = GEOM.rulerH;
  if (showCoverage) {
    const rows = model.coverageTrack.length || 1;
    const rowH = Math.floor((GEOM.coverageH - 4) / rows);
    model.coverageTrack.forEach((row, r) => {
      for (const c of row.cells) {
        add(top, {
          id: `ct:${row.unit}:${c.bin}`, kind: 'rect', layer: 'bg', x0: X(c.loDay), x1: X(c.hiDay + 1), y0: ty + 2 + r * rowH, y1: ty + 2 + (r + 1) * rowH - 1,
          style: `cov-${c.cls}`, openable: false, ref: { type: 'coverage', unit: row.unit, bin: c.bin },
          tip: [`coverage ${binLabel(tier, c.bin)}: ${formatTokens(c.amount)} ${row.unit} (step class ${c.cls} of 4)`],
        });
      }
    });
    // Bins no lane covers: hatched ("no sources"); bins only pending lanes cover: dots.
    for (const run of commonRuns(model.lanes.map((l) => l.uncovered), tier)) {
      add(top, { id: `ctu:${run[2]}`, kind: 'band', layer: 'bg', x0: X(run[0]), x1: X(run[1] + 1), y0: ty + 2, y1: ty + GEOM.coverageH - 2, style: 'hatch', openable: false, ref: { type: 'uncovered' }, tip: ['no sources in any shown lane'] });
    }
  }

  // ── Lanes ───────────────────────────────────────────────────────────────────────────────────────
  const unitMax = (unit) => model.units[unit]?.max ?? 0;
  const presence = tier === 'L0';
  for (const lane of model.lanes) {
    const lay = layout.lanes.find((l) => l.key === lane.key);
    if (!lay) continue;
    const ly0 = lay.y, ly1 = lay.y + lay.h;
    add(lanes, { id: `lb:${lane.key}`, kind: 'band', layer: 'bg', x0: xOffset, x1: xOffset + width, y0: ly0, y1: ly1, style: lay.index % 2 ? 'lane-1' : 'lane-0', openable: false, ref: null });
    if (lane.coverageOnly) {
      // Before a strand is pinned: the span of the collection's dated documents, as the corpus listing states it.
      if (lane.span) {
        const mid = (ly0 + ly1) / 2, hh = Math.min(10, (ly1 - ly0) / 4);
        const tip = [`${lane.label} · dated documents ${lane.span.label}`, `${lane.amount} · ${lane.docs} documents${lane.undated ? ` · ${lane.undated} undated` : ''}`,
          'coverage only: pin a strand to count occurrences'];
        add(lanes, { id: `span:${lane.key}`, kind: 'band', layer: 'data', x0: X(lane.span.loDay), x1: X(lane.span.hiDay + 1), y0: mid - hh, y1: mid + hh, style: 'cov-span',
          openable: false, ref: { type: 'span', lane: lane.key }, tip, synthetic: lane.synthetic });
      }
      continue;
    }
    for (const r of lane.uncovered) {
      add(lanes, { id: `lu:${lane.key}:${r[2]}`, kind: 'band', layer: 'bg', x0: X(r[0]), x1: X(r[1] + 1), y0: ly0, y1: ly1, style: 'hatch', openable: false,
        ref: { type: 'uncovered', lane: lane.key }, tip: [`${lane.label} · ${runLabel(tier, r)}`, 'no sources'] });
    }
    for (const r of lane.pendingRuns) {
      add(lanes, { id: `lp:${lane.key}:${r[2]}`, kind: 'band', layer: 'bg', x0: X(r[0]), x1: X(r[1] + 1), y0: ly0, y1: ly1, style: 'dots', openable: false,
        ref: { type: 'pending', lane: lane.key }, tip: [`${lane.label} · ${runLabel(tier, r)}`, 'indexing — not yet looked'] });
    }
    for (const r of lane.unloaded) {
      add(lanes, { id: `ll:${lane.key}:${r[2]}`, kind: 'band', layer: 'bg', x0: X(r[0]), x1: X(r[1] + 1), y0: ly0, y1: ly1, style: 'loading', openable: false, ref: null });
    }
    if (showCoverage) {
      for (const c of lane.coverage) {
        add(lanes, { id: `lc:${lane.key}:${c.bin}`, kind: 'rect', layer: 'bg', x0: X(c.loDay), x1: X(c.hiDay + 1), y0: ly1 - GEOM.underlayH, y1: ly1, style: `cov-${c.cls}`, openable: false, ref: null });
      }
    }

    lane.strands.forEach((s, si) => {
      const slot = lay.slots[si] ?? lay.slots[0];
      // OpenAlex lanes (C3): one box per OpenAlex cell, never bins, bars, caps or a line between cells.
      if (lane.share && s.share?.length) {
        for (const prim of sharePrims(lane, s, { slot, X, max: unitMax(SHARE_UNIT), tier, gate })) add(lanes, prim);
        return;
      }
      const c = s.cols;
      const max = unitMax(lane.unit);
      const ghostBars = model.override;
      for (let i = 0; i < c.length; i++) {
        const x0 = X(c.lo[i]), x1 = X(c.hi[i] + 1);
        const st = c.state[i];
        const style = binStyle({ state: st, flags: c.flags[i] });
        const ref = { type: 'bin', lane: lane.key, strand: s.ref, tier, bin: c.bin[i], i };
        const tip = binTooltip(lane, s, i, tier);
        if (st === STATE.observed) {
          const rate = c.rate[i];
          // No rate (a works-mode or sampled lane): a presence bar, as at L0 — never a height that reads as a rate.
          let h = presence || !Number.isFinite(rate) ? slot.h * 0.4 : (max > 0 ? (rate / max) * 0.7 * slot.h : 2);
          h = Math.max(2, h);
          const first = i === 0 || c.bin[i - 1] !== c.bin[i] - 1 || c.state[i - 1] !== STATE.observed;
          const last = i === c.length - 1 || c.bin[i + 1] !== c.bin[i] + 1 || c.state[i + 1] !== STATE.observed;
          const prim = gate({
            id: `b:${lane.key}:${s.ref}:${c.bin[i]}`, kind: 'rect', layer: 'data', x0, x1, y0: slot.mid - h / 2, y1: slot.mid + h / 2,
            style: ghostBars ? 'bar-backdrop' : (c.n[i] < 5 ? 'bar-sparse' : 'bar'), pattern: ghostBars ? null : style.pattern,
            round: (first ? 'l' : '') + (last ? 'r' : ''), openable: true, ref, tip, t: c.hi[i], sub: s.sub,
          }, c.hi[i]);
          if (prim) {
            add(lanes, prim);
            if (!ghostBars && (style.superscript || style.glyph) && x1 - x0 >= 10) {
              text(lanes, { id: `bs:${lane.key}:${s.ref}:${c.bin[i]}`, kind: 'text', layer: 'data', x0: x1 - 2, y0: slot.mid - h / 2 - 2, x1: x1 - 2, y1: slot.mid - h / 2 - 2,
                text: `${style.glyph ?? ''}${style.superscript ?? ''}`, style: 'superscript', openable: false, ref: null, ghost: prim.ghost });
            }
          }
        } else if (st === STATE.absent) {
          add(lanes, { id: `a:${lane.key}:${s.ref}:${c.bin[i]}`, kind: 'path', layer: 'data', points: [[x0 + 1, slot.mid], [x1 - 1, slot.mid]], x0, x1, y0: slot.mid - 3, y1: slot.mid + 3,
            style: 'absent', openable: true, ref, tip });
        } else if (st === STATE.low) {
          add(lanes, { id: `lowu:${lane.key}:${s.ref}:${c.bin[i]}`, kind: 'band', layer: 'bg', x0, x1, y0: slot.y, y1: slot.y + slot.h, style: 'hatch-low', openable: false, ref: null });
          if (c.n[i] > 0) {
            const prim = gate({ id: `lt:${lane.key}:${s.ref}:${c.bin[i]}`, kind: 'tick', layer: 'data', x0: (x0 + x1) / 2 - 1.5, x1: (x0 + x1) / 2 + 1.5, y0: slot.mid - 4, y1: slot.mid + 4,
              style: 'low-tick', openable: true, ref, tip, n: c.n[i], t: c.hi[i] }, c.hi[i]);
            if (prim) {
              add(lanes, prim);
              if (x1 - x0 >= 18) text(lanes, { id: `ln:${lane.key}:${s.ref}:${c.bin[i]}`, kind: 'text', layer: 'data', x0: (x0 + x1) / 2 + 4, y0: slot.mid + 4, x1: (x0 + x1) / 2 + 4, y1: slot.mid + 4,
                text: String(c.n[i]), style: 'low-n', openable: false, ref: null, ghost: prim.ghost });
            }
          } else {
            add(lanes, { id: `lt:${lane.key}:${s.ref}:${c.bin[i]}`, kind: 'band', layer: 'data', x0, x1, y0: slot.mid - 4, y1: slot.mid + 4, style: 'none', openable: true, ref, tip });
          }
        }
      }

      // Caps: the strand glyph at the first observed date (◁ when censored), a 2 px tick at the last (▷).
      if (!model.override) {
        const glyph = STRAND_GLYPH_CHARS[s.glyph] ?? '●';
        for (const bar of s.bars) {
          const sc = bar.startCap, ec = bar.endCap;
          const scp = gate({ id: `cs:${lane.key}:${s.ref}:${bar.loDay}`, kind: 'glyph', layer: 'data', x0: X(sc.day), x1: X(sc.day), y0: slot.mid, y1: slot.mid,
            text: sc.censored ? '◁' : glyph, style: sc.censored ? 'cap-chevron' : 'cap-start', size: Math.round((sc.censored ? 12 : 10) * k), openable: true,
            ref: { type: 'bin', lane: lane.key, strand: s.ref, tier, bin: s.cols.bin[bar.start], i: bar.start },
            tip: [sc.censored ? `first observed ${sc.label} — may be older than our record` : `first observed ${sc.label}${sc.exact ? '' : ' (bin precision)'}`] }, s.cols.hi[bar.start]);
          if (scp) add(lanes, scp);
          const ex = X(ec.day + 1);
          const ecp = gate(ec.censored
            ? { id: `ce:${lane.key}:${s.ref}:${bar.hiDay}`, kind: 'glyph', layer: 'data', x0: ex, x1: ex, y0: slot.mid, y1: slot.mid, text: '▷', style: 'cap-chevron', size: Math.round(12 * k), openable: true,
              ref: { type: 'bin', lane: lane.key, strand: s.ref, tier, bin: s.cols.bin[bar.end], i: bar.end }, tip: [`last observed ${ec.label} — may continue past our record`] }
            : { id: `ce:${lane.key}:${s.ref}:${bar.hiDay}`, kind: 'rect', layer: 'data', x0: ex - 1, x1: ex + 1, y0: slot.mid - slot.h * 0.35, y1: slot.mid + slot.h * 0.35, style: 'cap-end', openable: true,
              ref: { type: 'bin', lane: lane.key, strand: s.ref, tier, bin: s.cols.bin[bar.end], i: bar.end }, tip: [`last observed ${ec.label}${ec.exact ? '' : ' (bin precision)'}`] }, bar.hiDay);
          if (ecp) add(lanes, ecp);
        }
      }

      // Precision washes: translucent bands across [lo, hi] with a count label; never added to bars or rates. A label
      // is written only where it fits inside its band and clears every label already written in this slot (fix pass:
      // '3 · 1810–1860' and '2 · 1842–1882' printed over each other); the band keeps its tooltip either way.
      if (showWashes && !model.override) {
        const washLabels = [];
        for (const w of s.washes) {
          const x0 = X(w.loDay), x1 = X(w.hiDay + 1);
          const prim = gate({ id: `w:${lane.key}:${s.ref}:${w.loDay}:${w.hiDay}:${w.label}`, kind: 'wash', layer: 'data', x0, x1, y0: slot.y + 2, y1: slot.y + slot.h - 2,
            style: w.synthetic ? 'wash-syn' : 'wash', feather: w.circa ? 0.1 : 0, openable: true,
            ref: { type: 'wash', lane: lane.key, strand: s.ref, lo: w.loDay, hi: w.hiDay, label: w.label },
            tip: [`${w.n} ${w.n === 1 ? 'match' : 'matches'} dated ${w.label} — does not fit one ${tierWord(tier)}; not counted in bars or rates`] }, w.hiDay);
          if (!prim) continue;
          add(lanes, prim);
          const words = `${w.n} · ${w.label}`;
          const lw = washLabelWidth(words);
          const lx = x0 + 4;
          if (x1 - x0 >= Math.max(48, lw + 8) && !washLabels.some((r) => lx < r[1] && lx + lw > r[0])) {
            washLabels.push([lx - 4, lx + lw + 4]);
            text(lanes, { id: `wl:${prim.id}`, kind: 'text', layer: 'data', x0: lx, y0: slot.y + slot.h - 4, x1: lx, y1: slot.y + slot.h - 4,
              text: words, style: 'wash-label', openable: false, ref: null, ghost: prim.ghost });
          }
        }
      }

      // Individual marks (occurrence override, §1.6): ticks, diamonds, uncertainty brackets, coarse-dated band.
      if (model.override && s.marks) {
        const tierRank = TIER_LEVEL[tier];
        const coarse = new Map();
        for (const m of s.marks) {
          const rank = PRECISION_RANK[m.precision] ?? -1;
          if (tierRank >= 4 && rank < tierRank) {
            const k = `${m.lo_day}:${m.hi_day}`;
            if (!coarse.has(k)) coarse.set(k, { lo: m.lo_day, hi: m.hi_day, items: [], label: markLabel(m), precision: m.precision });
            coarse.get(k).items.push(m);
            continue;
          }
          const x0 = X(m.lo_day), x1 = X(m.hi_day + 1);
          const tip = [`${s.label} · ${lane.label} · ${markLabel(m)} · ${m.precision} · ${m.basis}`, m.synthetic ? 'SYNTHETIC · click to read the passage' : 'click to read the passage'];
          const ref = { type: 'occurrence', id: m.occ, passage: m.passage, doc: m.doc, lane: lane.key };
          const id = `m:${m.occ ?? `p${m.passage}`}:${lane.key}`;
          let prim;
          // An interval narrower than a readable bracket is a tick inside it (its middle, never 1 January).
          if (x1 - x0 < 12) {
            const cx = (x0 + x1) / 2;
            prim = m.kind === 'title'
              ? { id, kind: 'diamond', layer: 'data', x0: cx - diamond / 2, x1: cx + diamond / 2, y0: slot.mid - diamond / 2, y1: slot.mid + diamond / 2, style: 'mark-title', openable: true, ref, tip }
              : { id, kind: 'tick', layer: 'data', x0: cx - 0.5, x1: cx + 0.5, y0: slot.mid - markH / 2, y1: slot.mid + markH / 2, style: m.basis === 'estimated' ? 'mark-est' : 'mark-text', openable: true, ref, tip };
          } else {
            const style = { estimated: 'bracket-est', derived: 'bracket-derived', period: 'bracket-period' }[m.basis] ?? 'bracket-stated';
            prim = { id, kind: 'path', layer: 'data', x0, x1, y0: slot.mid - bracketH / 2, y1: slot.mid + bracketH / 2, style, openable: true, ref, tip,
              points: [[x0 + 0.5, slot.mid - bracketH / 2], [x0 + 0.5, slot.mid], [x1 - 0.5, slot.mid], [x1 - 0.5, slot.mid - bracketH / 2]],
              glyph: m.basis === 'estimated' ? '≈' : m.basis === 'derived' ? '⇄' : null };
          }
          prim = gate(prim, m.hi_day);
          if (prim) { add(lanes, prim); stats.marks++; }
        }
        for (const [k, g] of coarse) {
          const x0 = X(g.lo), x1 = X(g.hi + 1);
          const prim = gate({ id: `cb:${lane.key}:${s.ref}:${k}`, kind: 'band', layer: 'data', x0, x1, y0: slot.y + 1, y1: slot.y + 1 + GEOM.coarseH, style: 'coarse', openable: true,
            ref: { type: 'occurrence', id: g.items[0].occ, passage: g.items[0].passage, doc: g.items[0].doc, lane: lane.key, group: g.items.length },
            tip: [`${g.items.length} ${g.items.length === 1 ? 'item' : 'items'} dated only to ${g.label} — not drawn at a finer date`] }, g.hi);
          if (!prim) continue;
          add(lanes, prim);
          if (x1 - x0 >= LABEL_ROOM) text(lanes, { id: `cbl:${prim.id}`, kind: 'text', layer: 'data', x0: x0 + 4, y0: slot.y + 1 + GEOM.coarseH + 9, x1: x0 + 4, y1: slot.y + GEOM.coarseH + 10,
            text: `${g.items.length} dated only to ${g.label}`, style: 'coarse-label', openable: false, ref: null, ghost: prim.ghost });
        }
      }
    });
  }

  // ── The modality seam (§1.10): a permanent line across all lanes; collapsible to a ruler tick, never hidden ──
  for (const seam of drawableSeams(seams)) {
    const x = X(seamDay(seam));
    add(top, { id: `sm:${seam.year}`, kind: 'tick', layer: 'bg', x0: x, x1: x, y0: 0, y1: GEOM.rulerH, style: 'seam-tick', openable: false, ref: { type: 'seam' }, tip: [seam.label] });
    if (!seamCollapsed) {
      // §1.10's required caption: right of its line, or left of it where the visible view ends sooner (decided when
      // painting, since panning moves the view without rebuilding); fix pass: 'Full te' was cut by the shelf
      const words = shortSeamLabel(seam);
      text(top, { id: `sml:${seam.year}`, kind: 'text', layer: 'bg', x0: x - 4 - seamLabelWidth(words), y0: 11, x1: x + 4 + seamLabelWidth(words), y1: 11,
        text: words, style: 'seam-label', seamX: x, w: seamLabelWidth(words), openable: false, ref: null });
      add(lanes, { id: `sml2:${seam.year}`, kind: 'path', layer: 'bg', points: [[x, 0], [x, layout.height]], x0: x - 3, x1: x + 3, y0: 0, y1: layout.height, style: 'seam', openable: false,
        ref: { type: 'seam' }, tip: [seam.label] });
    }
  }

  stats.texts = texts;
  return {
    top, lanes, stats, originDay, daysPerPx, width, height: layout.height, tier,
    overBudget: stats.rects + stats.ticks > BUDGET.shapes || stats.marks > BUDGET.marks,
  };
}

/** Bin runs every list contains (bins that no shown lane covers), as [loDay, hiDay, binLo, binHi]. */
function commonRuns(lists, tier) {
  if (!lists.length) return [];
  let bins = null;
  for (const runs of lists) {
    const set = new Set();
    for (const r of runs) for (let b = r[2]; b <= r[3]; b++) set.add(b);
    bins = bins ? new Set([...bins].filter((b) => set.has(b))) : set;
  }
  const out = [];
  for (const b of [...bins].sort((x, y) => x - y)) {
    const last = out[out.length - 1];
    if (last && last[3] === b - 1) { last[3] = b; last[1] = binEndDay(tier, b); } else out.push([binStartDay(tier, b), binEndDay(tier, b), b, b]);
  }
  return out;
}

/** Label of a run of bins: '1940–1949', '1730–1949', 'Apr 1931 – Jun 1931'. */
export function runLabel(tier, run) {
  if (run[2] === run[3]) return binLabel(tier, run[2]);
  if (TIER_LEVEL[tier] <= 3) return `${dayLabel(run[0])}–${dayLabel(run[1])}`;
  return `${binLabel(tier, run[2])} – ${binLabel(tier, run[3])}`;
}

function tierWord(tier) {
  return { L0: 'millennium', L1: 'century', L2: 'decade', L3: 'year', L4: 'month', L5: 'day' }[tier];
}

/**
 * A plain-text summary of the Scroll for `aria-describedby` (§8.6): per lane and strand, the observed runs
 * and the gaps with their kind.
 * @param {object} model
 * @returns {string}
 */
export function describeModel(model) {
  if (!model?.lanes?.length) return 'The Scroll is empty: no lanes for this query.';
  const out = [];
  for (const lane of model.lanes) {
    for (const s of lane.strands) {
      const runs = s.bars.map((b) => `${dayLabel(b.loDay)}–${dayLabel(b.hiDay)}`);
      const parts = [`Lane ${lane.label} · ${lane.modality}: '${s.label}'`];
      parts.push(runs.length ? `observed ${runs.join(' and ')} in ${runs.length} ${runs.length === 1 ? 'bar' : 'bars'}` : 'no observed bins in this range');
      const gaps = lane.uncovered.filter((r) => s.bars.some((b) => b.hiDay < r[0]) && s.bars.some((b) => b.loDay > r[1]));
      for (const g of gaps) parts.push(`gap ${dayLabel(g[0])}–${dayLabel(g[1])}: no sources${lane.synthetic ? ' (synthetic)' : ''}`);
      out.push(`${parts[0]} ${parts.slice(1).join('; ')}.`);
    }
    if (!lane.strands.length) out.push(`Lane ${lane.label}: coverage only (no strand pinned).`);
  }
  return out.join(' ');
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }

