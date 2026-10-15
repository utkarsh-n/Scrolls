// OWNER: WP6
// timeline/playhead.mjs — the vantage clock (SPEC §1.1, §1.9): stepping by whole bins, the play loop (one bin
// every 400 ms at 1×, 0.25×–4×; 1.2 s in reduced motion), auto-pan that keeps the playhead at 70% of the
// width, gap skipping ("No coverage 1940–1949 in these lanes — skipping. Nothing is inferred."), one pause
// at the modality seam, and strict (play) vs context (paused) visibility.
// Values change discretely by bin; nothing is tweened between bins.

import { dayFromYMD } from '../../shared/dates.mjs';
import { dayLabel } from './scale.mjs';
import { binOfDay, stepBinEnd } from './tiers.mjs';

export const PLAY_MS = 400;
export const REDUCED_PLAY_MS = 1200;
export const GAP_PAUSE_MS = 600;
export const SEAM_PAUSE_MS = 2400;
export const SPEEDS = Object.freeze([0.25, 0.5, 1, 2, 4]);
/** Where auto-pan keeps the playhead (share of the width). */
export const PLAYHEAD_AT = 0.7;

/**
 * Step the vantage by whole bins.
 * @param {number} day current vantage day
 * @param {string} tier
 * @param {number} steps
 * @returns {number}
 */
export function stepVantage(day, tier, steps) {
  return stepBinEnd(tier, day, steps);
}

/**
 * The centre day that puts `vantageDay` at 70% of the width (auto-pan during play).
 * @param {number} vantageDay
 * @param {number} width
 * @param {number} daysPerPx
 * @returns {number}
 */
export function autoPanCenter(vantageDay, width, daysPerPx) {
  return vantageDay - (PLAYHEAD_AT - 0.5) * width * daysPerPx;
}

/**
 * Does auto-pan need to move? (playhead left of 10% or right of 85%).
 * @param {number} x playhead x in px
 * @param {number} width
 */
export function needsAutoPan(x, width) {
  return x < width * 0.1 || x > width * 0.85;
}

/**
 * The stretch of bins right after `day` that EVERY shown lane has no sources for, or null (§1.9 gaps).
 * @param {{lanes: Array<{uncovered: Array<[number, number, number, number]>}>}} model
 * @param {number} day the current vantage day
 * @param {string} tier
 * @returns {{loDay: number, hiDay: number, label: string}|null}
 */
export function gapAhead(model, day, tier) {
  if (!model?.lanes?.length) return null;
  const nextBin = binOfDay(tier, day + 1);
  let lo = null, hi = Infinity;
  for (const lane of model.lanes) {
    const run = lane.uncovered.find((r) => r[2] <= nextBin && r[3] >= nextBin);
    if (!run) return null;
    lo = lo === null ? run[0] : Math.max(lo, run[0]);
    hi = Math.min(hi, run[1]);
  }
  // Only the part from the next bin on is "ahead".
  const from = Math.max(lo, day + 1);
  if (!(hi >= from)) return null;
  return { loDay: from, hiDay: hi, label: `${dayLabel(from)}–${dayLabel(hi)}` };
}

/** Copy of the gap pause (§1.9). */
export function gapMessage(gap, synthetic = false) {
  return `No coverage ${gap.label} in these lanes${synthetic ? ' (synthetic)' : ''} — skipping. Nothing is inferred.`;
}

/**
 * The first seam crossed when the vantage moves from `fromDay` to `toDay`, or null.
 * @param {Array<{year: number, label: string}>} seams
 * @param {number} fromDay
 * @param {number} toDay
 */
export function seamCrossed(seams, fromDay, toDay) {
  for (const s of seams ?? []) {
    const d = dayFromYMD(s.year, 1, 1);
    if (fromDay < d && toDay >= d) return s;
  }
  return null;
}

/**
 * The play loop. All side effects go through callbacks so the loop is testable with a fake clock.
 * @param {{
 *   get(): {day: number, tier: string, model: object|null, seams: object[], endDay: number, reduced: boolean, synthetic?: boolean},
 *   setVantage(day: number, opts: {strict: boolean}): void,
 *   onMessage?(text: string, kind: 'gap'|'seam'|'end'): void,
 *   onState?(playing: boolean): void,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout
 * }} io
 */
export function createPlayer(io) {
  const setTimer = io.setTimer ?? setTimeout;
  const clearTimer = io.clearTimer ?? clearTimeout;
  let timer = null;
  let playing = false;
  let speed = 1;
  const seamsPaused = new Set();

  const interval = () => (io.get().reduced ? REDUCED_PLAY_MS : PLAY_MS / speed);

  function schedule(ms) {
    if (timer) clearTimer(timer);
    timer = setTimer(tick, ms);
  }

  function stop(message = null) {
    if (timer) clearTimer(timer);
    timer = null;
    if (!playing) return;
    playing = false;
    const { day } = io.get();
    io.setVantage(day, { strict: false });   // pausing switches to context (§1.9)
    if (message) io.onMessage?.(message, 'end');
    io.onState?.(false);
  }

  function tick() {
    timer = null;
    if (!playing) return;
    const st = io.get();
    if (st.day >= st.endDay) { stop('Reached the end of the record.'); return; }
    const gap = gapAhead(st.model, st.day, st.tier);
    if (gap && gap.hiDay < st.endDay) {
      io.onMessage?.(gapMessage(gap, st.synthetic), 'gap');
      io.setVantage(gap.hiDay, { strict: true });
      schedule(GAP_PAUSE_MS + interval());
      return;
    }
    const next = Math.min(stepVantage(st.day, st.tier, 1), Math.max(st.endDay, st.day));
    const seam = seamCrossed(st.seams, st.day, next);
    io.setVantage(next, { strict: true });
    if (seam && !seamsPaused.has(seam.year)) {
      seamsPaused.add(seam.year);
      io.onMessage?.(seam.label, 'seam');
      schedule(SEAM_PAUSE_MS);
      return;
    }
    if (next >= st.endDay) { stop('Reached the end of the record.'); return; }
    schedule(interval());
  }

  return {
    get playing() { return playing; },
    get speed() { return speed; },
    setSpeed(s) { if (SPEEDS.includes(s)) speed = s; },
    play() {
      if (playing) return;
      playing = true;
      seamsPaused.clear();
      const { day } = io.get();
      io.setVantage(day, { strict: true });   // play runs strict
      io.onState?.(true);
      schedule(interval());
    },
    pause() { stop(); },
    toggle() { if (playing) stop(); else this.play(); },
    /** One manual step (Step ▸ / [ ] / { }); pauses play. */
    step(steps) {
      if (playing) stop();
      const st = io.get();
      io.setVantage(stepVantage(st.day, st.tier, steps), { strict: undefined });
    },
    dispose() { if (timer) clearTimer(timer); timer = null; playing = false; },
  };
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
