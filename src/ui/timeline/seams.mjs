// OWNER: WP6
// timeline/seams.mjs — the modality seam (SPEC §1.10, D15): where full text ends (e.g. 1928, public domain)
// and the evidence continues as titles and abstracts, a permanent vertical seam crosses every lane with the
// ruler caption "Full text ends 1928 → after this line the evidence is titles and abstracts: a change of
// medium, not of meaning." It can be collapsed to a ruler tick, never hidden. The server computes the seam
// (query.seams); display.mjs draws it from these helpers.

import { dayFromYMD } from '../../shared/dates.mjs';

/** First day of the seam year (the line sits at `last_covered_year + 1`). @param {{year: number}} seam */
export function seamDay(seam) {
  return dayFromYMD(seam.year, 1, 1);
}

/** "Full text ends 1928 →" — the ruler form of the seam caption. */
export function shortSeamLabel(seam) {
  const m = /^([^→]+→)/.exec(seam.label ?? '');
  return m ? m[1].trim() : `seam ${seam.year}`;
}

/**
 * Seams that may be drawn: modality seams with a year; `hideable: false` is honoured by never offering a
 * way to remove them (only `collapsed`).
 * @param {Array<object>} seams
 */
export function drawableSeams(seams) {
  return (seams ?? []).filter((s) => Number.isFinite(s?.year));
}

/**
 * Where a seam caption is painted in the visible part [vis.x0, vis.x1] of the content: right of its line when it fits,
 * else left of it (right-aligned); its box, so a ruler label under it gives way (the tick stays).
 * @param {{seamX: number, w: number}} p the caption primitive
 * @param {{x0: number, x1: number}|null} vis
 * @returns {{x: number, align: 'start'|'end', x0: number, x1: number}}
 */
export function seamCaptionPlace(p, vis) {
  const right = !vis || p.seamX + 4 + p.w <= vis.x1 - 4 || p.seamX - 4 - p.w < vis.x0 + 4;
  return right ? { x: p.seamX + 4, align: 'start', x0: p.seamX + 4, x1: p.seamX + 4 + p.w }
    : { x: p.seamX - 4, align: 'end', x0: p.seamX - 4 - p.w, x1: p.seamX - 4 };
}

/** UI module contract (§8): a library imported by the display list; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
