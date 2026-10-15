// OWNER: WP6 — the Scroll's axis: linear TimeScale, ticks and labels (BCE, months, days), tiers and bins,
// folded regimes, viewport math (pan/zoom limits), wheel and touch input, the playhead (SPEC §1.5, §1.6, §1.9).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dayFromYMD, ymdFromDay } from '../src/shared/dates.mjs';
import { AXIS_LIMITS } from '../src/shared/viewstate.mjs';
import { binCaption, cmLabel, createScale, dayLabel, majorStep, ticks, MIN_LABEL_PX } from '../src/ui/timeline/scale.mjs';
import {
  binEndDay, binLabel, binOfDay, binStartDay, coarserTier, daysPerPxForTier, effectiveTier, finerTier, fitsTier, snapToBinEnd,
  stepBinEnd, tierForDaysPerPx, tileOf, tilesForDays, yearRangeLabel, DAYS_PER_YEAR,
} from '../src/ui/timeline/tiers.mjs';
import { createFolded, REGIMES, seamZigzag } from '../src/ui/timeline/folded.mjs';
import { clampAxis, fitAxis, panAxis, zoomAxis, binId, parseBinId, extentDays } from '../src/ui/timeline/viewport.mjs';
import { normalizeWheel, wheelAction } from '../src/ui/timeline/input.mjs';
import { createRecognizer, LONG_PRESS_MS } from '../src/ui/timeline/gestures.mjs';
import { autoPanCenter, createPlayer, gapAhead, gapMessage, needsAutoPan, seamCrossed, PLAY_MS, REDUCED_PLAY_MS } from '../src/ui/timeline/playhead.mjs';

const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

describe('TimeScale (linear, D3)', () => {
  test('x and day are inverse and linear', () => {
    const s = createScale({ centerDay: dayFromYMD(1960), daysPerPx: 50, width: 1000 });
    assert.equal(s.x(s.centerDay), 500);
    for (const d of [dayFromYMD(1900), dayFromYMD(1994, 5, 17), dayFromYMD(2026)]) assert.ok(Math.abs(s.day(s.x(d)) - d) < 1e-6);
    assert.ok(Math.abs((s.x(dayFromYMD(2000)) - s.x(dayFromYMD(1990))) - (s.x(dayFromYMD(1930)) - s.x(dayFromYMD(1920)))) < 0.2, 'equal decades, equal widths');
    assert.ok(Math.abs(s.ppy - DAYS_PER_YEAR / 50) < 1e-9);
  });

  test('major ticks are labelled historically and stay ≥ 84 px apart', () => {
    const s = createScale({ centerDay: dayFromYMD(1960), daysPerPx: 50, width: 1400 });
    const t = ticks(s);
    assert.ok(t.length >= 3);
    assert.ok(t.some((x) => x.label === '1900') && t.every((x) => Number(x.label) % 20 === 0), t.map((x) => x.label).join(' '));
    for (let i = 1; i < t.length; i++) assert.ok(t[i].x - t[i - 1].x >= MIN_LABEL_PX - 0.5, `${t[i - 1].label} → ${t[i].label}`);
    assert.ok(t.every((x) => /^\d{4}$/.test(x.label)), t.map((x) => x.label).join(' '));
  });

  test('BCE ticks sit on round historical years: "1000 BCE", "500 BCE", never "501 BCE"', () => {
    const s = createScale({ centerDay: dayFromYMD(0), daysPerPx: 500 * DAYS_PER_YEAR / 120, width: 1200 });
    const labels = ticks(s).map((t) => t.label);
    assert.ok(labels.includes('500 BCE'), labels.join(' '));
    assert.ok(labels.some((l) => /CE$/.test(l) && !/BCE/.test(l)), labels.join(' '));
    assert.ok(!labels.some((l) => /^\d*1 BCE$/.test(l) && l !== '1 BCE'), labels.join(' '));
    const t500 = ticks(s).find((t) => t.label === '500 BCE');
    assert.equal(ymdFromDay(t500.day).y, -499, '500 BCE = astronomical −499');
  });

  test('month and day ticks: "Apr 1931", "17 May 1994"', () => {
    const months = ticks(createScale({ centerDay: dayFromYMD(1931, 4, 15), daysPerPx: 0.25, width: 1200 })).map((t) => t.label);
    assert.ok(months.includes('Apr 1931'), months.join(' | '));
    const days = ticks(createScale({ centerDay: dayFromYMD(1994, 5, 17), daysPerPx: 1 / 40, width: 1400 })).map((t) => t.label);
    assert.ok(days.includes('16 May 1994') && days.every((l) => /^\d{1,2} [A-Z][a-z]{2} 1994$/.test(l)), days.join(' | '));
  });

  test('majorStep never picks a step closer than the minimum spacing', () => {
    for (const dpp of [1 / 40, 0.5, 3, 30, 300, 3000, 7000]) {
      const st = majorStep(dpp);
      assert.ok(st.days / dpp >= MIN_LABEL_PX || st.days === 5000 * DAYS_PER_YEAR, `${dpp}`);
    }
  });

  test('the footer caption: "Bins: decades · 1 cm ≈ 12.5 years"', () => {
    const dpp = 12.5 * DAYS_PER_YEAR / (96 / 2.54);
    assert.equal(binCaption('L2', dpp), 'Bins: decades · 1 cm ≈ 12.5 years');
    assert.equal(cmLabel(1 / 40), '22.7 hours');
    assert.match(binCaption('L4', 2), /^Bins: months · 1 cm ≈ /);
  });

  test('dayLabel at each precision', () => {
    assert.equal(dayLabel(dayFromYMD(1994, 5, 17), 'day'), '17 May 1994');
    assert.equal(dayLabel(dayFromYMD(1931, 4, 2), 'month'), 'Apr 1931');
    assert.equal(dayLabel(dayFromYMD(-499, 6, 1)), '500 BCE');
  });
});

describe('tiers and bins (§1.6)', () => {
  test('tier thresholds follow px/year', () => {
    assert.equal(tierForDaysPerPx(DAYS_PER_YEAR / 0.05), 'L0');
    assert.equal(tierForDaysPerPx(DAYS_PER_YEAR / 0.5), 'L1');
    assert.equal(tierForDaysPerPx(50), 'L2');
    assert.equal(tierForDaysPerPx(DAYS_PER_YEAR / 20), 'L3');
    assert.equal(tierForDaysPerPx(DAYS_PER_YEAR / 500), 'L4');
    assert.equal(tierForDaysPerPx(1 / 40), 'L5');
    for (const t of TIERS) assert.equal(tierForDaysPerPx(daysPerPxForTier(t)), t, `jump to ${t} lands in ${t}`);
  });

  test('a forced tier can be coarser, never finer', () => {
    assert.equal(effectiveTier('L3', 'L1'), 'L1');
    assert.equal(effectiveTier('L1', 'L3'), 'L1');
    assert.equal(effectiveTier('L2', 'auto'), 'L2');
    assert.equal(coarserTier('L0'), 'L0');
    assert.equal(finerTier('L5'), 'L5');
  });

  test('bin ↔ day arithmetic round-trips at every tier, BCE included', () => {
    const days = [dayFromYMD(-6999, 3, 4), dayFromYMD(-499, 12, 31), dayFromYMD(0, 1, 1), dayFromYMD(1, 1, 1), dayFromYMD(99, 7, 9),
      dayFromYMD(1911, 1, 1), dayFromYMD(1994, 5, 17), dayFromYMD(2026, 10, 3)];
    for (const tier of TIERS) {
      for (const d of days) {
        const b = binOfDay(tier, d);
        assert.ok(binStartDay(tier, b) <= d && d <= binEndDay(tier, b), `${tier} ${d}`);
        assert.equal(binOfDay(tier, binStartDay(tier, b)), b);
        assert.equal(binOfDay(tier, binEndDay(tier, b)), b);
        assert.equal(binStartDay(tier, b + 1), binEndDay(tier, b) + 1, 'bins tile the line without gaps');
      }
    }
  });

  test('bins match §7.2: decade bin of 1911 is 191; tile = floor(bin / 64)', () => {
    assert.equal(binOfDay('L2', dayFromYMD(1911, 6, 1)), 191);
    assert.deepEqual(tileOf(191), { tile: 2, idx: 63 });
    assert.deepEqual(tileOf(192), { tile: 3, idx: 0 });
    assert.deepEqual(tilesForDays('L2', dayFromYMD(1890), dayFromYMD(2030)), [2, 3]);
    assert.equal(binOfDay('L4', dayFromYMD(1931, 4, 15)), 1931 * 12 + 3);
    assert.equal(binOfDay('L5', 8902), 8902);
  });

  test('bin labels', () => {
    assert.equal(binLabel('L2', 191), '1910–1919');
    assert.equal(binLabel('L3', 1911), '1911');
    assert.equal(binLabel('L1', 18), '1800–1899');
    assert.equal(binLabel('L0', 1), '1000–1999');
    assert.equal(binLabel('L4', 1931 * 12 + 3), 'Apr 1931');
    assert.equal(binLabel('L5', 8902), '17 May 1994');
    assert.equal(binLabel('L2', -50), '501–492 BCE');
    assert.equal(yearRangeLabel(-499, 600), '500 BCE – 600 CE');
  });

  test('fit-or-wash: an interval fits a tier only inside one bin', () => {
    assert.ok(fitsTier('L2', dayFromYMD(1990), dayFromYMD(1999, 12, 31)));
    assert.ok(!fitsTier('L3', dayFromYMD(1990), dayFromYMD(1999, 12, 31)));
  });

  test('the vantage steps from bin end to bin end (discrete, §1.9)', () => {
    const v = dayFromYMD(1925, 12, 31);
    assert.equal(stepBinEnd('L2', v, 1), dayFromYMD(1929, 12, 31), 'inside a decade, +1 lands on that decade’s end');
    assert.equal(stepBinEnd('L2', dayFromYMD(1929, 12, 31), 1), dayFromYMD(1939, 12, 31));
    assert.equal(stepBinEnd('L2', v, -1), dayFromYMD(1919, 12, 31));
    assert.equal(stepBinEnd('L3', v, 10), dayFromYMD(1935, 12, 31));
    assert.equal(snapToBinEnd('L3', dayFromYMD(1997, 3, 3)), dayFromYMD(1997, 12, 31));
  });
});

describe('folded regimes (§1.5)', () => {
  test('fixed shares and computed seam ratios ×3.3 · ×8.9 · ×3.3 at any width', () => {
    for (const w of [700, 1400, 2400]) {
      const f = createFolded(w);
      assert.deepEqual(f.regimes.map((r) => Math.round(((r.x1 - r.x0) / w) * 100)), [15, 15, 20, 50]);
      assert.deepEqual(f.seams.map((s) => s.label), ['×3.3', '×8.9', '×3.3']);
    }
    const f = createFolded(1400);
    assert.ok(Math.abs(f.regimes[0].yearsPerPx - 31) < 0.1, '1 px ≈ 31 years in deep time');
    assert.ok(Math.abs(f.regimes[3].yearsPerPx - 0.33) < 0.01, '1 px ≈ 0.33 years in the modern regime');
    assert.equal(REGIMES.length, 4);
  });

  test('x ↔ year is monotone and invertible inside each regime', () => {
    const f = createFolded(1000);
    let prev = -Infinity;
    for (const y of [-6999, -3000, -499, 0, 1000, 1500, 1700, 1800, 1928, 2030]) {
      const x = f.xOfYear(y);
      assert.ok(x >= prev);
      prev = x;
      assert.ok(Math.abs(f.yearOfX(x) - y) < 1e-6, `${y}`);
    }
    assert.ok(seamZigzag(100, 0, 28).length > 4);
  });
});

describe('viewport math (§1.5 limits)', () => {
  test('zoom keeps the anchored day under the pointer and respects 0.05 px/year … 40 px/day', () => {
    const a = { centerDay: dayFromYMD(1960), daysPerPx: 50 };
    const before = a.centerDay + (300 - 500) * a.daysPerPx;
    const z = zoomAxis(a, 1000, 300, 2);
    assert.equal(z.daysPerPx, 25);
    assert.ok(Math.abs(z.centerDay + (300 - 500) * z.daysPerPx - before) < 1e-6);
    assert.equal(zoomAxis(a, 1000, 500, 1e9).daysPerPx, AXIS_LIMITS.minDaysPerPx, '40 px/day');
    assert.equal(zoomAxis(a, 500, 250, 1e-9).daysPerPx, AXIS_LIMITS.maxDaysPerPx, '0.05 px/year');
    // fix pass: zooming out stops once the pan domain fills the width (never empty time beyond 2100 CE or before 10000 BCE)
    assert.equal(zoomAxis(a, 1000, 500, 1e-9).daysPerPx, (AXIS_LIMITS.maxDay - AXIS_LIMITS.minDay) / 1000);
  });

  test('pan follows the pointer and stays in 10000 BCE – 2100 CE', () => {
    const a = { centerDay: dayFromYMD(1960), daysPerPx: 50 };
    assert.equal(panAxis(a, 100).centerDay, a.centerDay - 5000);
    assert.equal(panAxis(a, -1e12).centerDay, AXIS_LIMITS.maxDay);
    assert.equal(clampAxis({ centerDay: -1e12, daysPerPx: 1 }).centerDay, AXIS_LIMITS.minDay);
  });

  test('fit shows the extent with a margin', () => {
    const f = fitAxis(dayFromYMD(1905), dayFromYMD(2026, 12, 31), 1000);
    const s = createScale({ ...f, width: 1000 });
    assert.ok(s.x(dayFromYMD(1905)) > 40 && s.x(dayFromYMD(2027)) < 960);
    assert.deepEqual(extentDays({ extent: { from: '1905', to: '2026' } }), [dayFromYMD(1905), dayFromYMD(2026, 12, 31)]);
    assert.equal(extentDays({ extent: { from: null, to: null } }), null);
  });

  test('bin selection ids round-trip', () => {
    const ref = { lane: 'community:classroom', strand: '12', tier: 'L2', bin: 191 };
    assert.deepEqual(parseBinId(binId(ref)), ref);
    assert.equal(parseBinId('nonsense'), null);
  });
});

describe('input (§1.5, §8.6)', () => {
  test('wheel: vertical and pinch zoom, horizontal and Shift pan, Alt scrolls lanes', () => {
    assert.equal(wheelAction({ deltaX: 0, deltaY: -100 }).type, 'zoom');
    assert.ok(wheelAction({ deltaX: 0, deltaY: -100 }).factor > 1, 'wheel up zooms in');
    assert.ok(wheelAction({ deltaX: 0, deltaY: 10, ctrlKey: true }).factor < 1, 'pinch out zooms out');
    assert.deepEqual(wheelAction({ deltaX: 40, deltaY: 3 }), { type: 'pan', dx: 40 });
    assert.deepEqual(wheelAction({ deltaX: 0, deltaY: 30, shiftKey: true }), { type: 'pan', dx: 30 });
    assert.deepEqual(wheelAction({ deltaX: 0, deltaY: 30, altKey: true }), { type: 'scrollY', dy: 30 });
    assert.deepEqual(normalizeWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 }), { dx: 0, dy: 48 });
  });

  test('touch: tap, double-tap, horizontal pan, vertical scroll, pinch, two-finger tap, long-press', () => {
    const timers = [];
    const ev = [];
    const r = createRecognizer({
      onTap: (x) => ev.push(['tap', x]), onDoubleTap: () => ev.push(['dbl']), onPan: (dx) => ev.push(['pan', dx]), onPanEnd: () => ev.push(['panEnd']),
      onScrollY: (dy) => ev.push(['scroll', dy]), onPinch: (f, m) => ev.push(['pinch', Number(f.toFixed(2)), m]), onTwoFingerTap: (m) => ev.push(['two', m]),
      onLongPress: () => ev.push(['long']), setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    });
    r.down(1, 10, 10, 0); r.up(1, 11, 10, 50);
    r.down(1, 11, 11, 150); r.up(1, 11, 11, 200);
    assert.deepEqual(ev.splice(0), [['tap', 11], ['dbl']]);
    r.down(1, 100, 100, 1000); r.move(1, 130, 102); r.move(1, 140, 102); r.up(1, 140, 102, 1100);
    assert.deepEqual(ev.splice(0), [['pan', 30], ['pan', 10], ['panEnd']]);
    r.down(1, 100, 100, 2000); r.move(1, 101, 130); r.up(1, 101, 130, 2100);
    assert.deepEqual(ev.splice(0), [['scroll', -30]]);
    r.down(1, 100, 50, 3000); r.down(2, 200, 50, 3000); r.move(2, 300, 50); r.up(1, 0, 0, 3200); r.up(2, 0, 0, 3200);
    assert.deepEqual(ev.splice(0), [['pinch', 2, 200]]);
    r.down(1, 100, 50, 4000); r.down(2, 200, 50, 4010); r.up(1, 100, 50, 4100); r.up(2, 200, 50, 4110);
    assert.deepEqual(ev.splice(0), [['two', 150]]);
    r.down(1, 10, 10, 5000);
    const lp = timers.filter((t) => t.ms === LONG_PRESS_MS && t.fn).pop();
    lp.fn();
    assert.deepEqual(ev.splice(0), [['long']]);
  });
});

describe('playhead (§1.9)', () => {
  const model = {
    lanes: [
      { uncovered: [[dayFromYMD(1940), dayFromYMD(1949, 12, 31), 194, 194]] },
      { uncovered: [[dayFromYMD(1930), dayFromYMD(1959, 12, 31), 193, 195]] },
    ],
  };

  test('a gap is skipped only when EVERY lane has no sources ahead', () => {
    const g = gapAhead(model, dayFromYMD(1939, 12, 31), 'L2');
    assert.deepEqual([g.loDay, g.hiDay], [dayFromYMD(1940), dayFromYMD(1949, 12, 31)]);
    assert.equal(gapMessage(g, true), 'No coverage 1940–1949 in these lanes (synthetic) — skipping. Nothing is inferred.');
    assert.equal(gapAhead(model, dayFromYMD(1929, 12, 31), 'L2'), null, 'one lane has sources in the 1930s');
  });

  test('auto-pan keeps the playhead at 70% of the width', () => {
    const c = autoPanCenter(1000, 1000, 2);
    assert.equal(createScale({ centerDay: c, daysPerPx: 2, width: 1000 }).x(1000), 700);
    assert.ok(needsAutoPan(900, 1000) && !needsAutoPan(500, 1000));
  });

  test('play runs strict, steps one bin per tick, skips the gap with a message, pauses once at the seam, pausing is context', () => {
    let day = dayFromYMD(1919, 12, 31);
    const set = [];
    const msgs = [];
    const timers = [];
    const seams = [{ year: 1929, label: 'Full text ends 1928 → after this line …' }];
    const p = createPlayer({
      get: () => ({ day, tier: 'L2', model, seams, endDay: dayFromYMD(1969, 12, 31), reduced: false, synthetic: true }),
      setVantage: (d, { strict }) => { day = d; set.push([d, strict]); },
      onMessage: (t, kind) => msgs.push(kind),
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
    });
    p.play();
    assert.equal(set.at(-1)[1], true, 'play is strict');
    assert.equal(timers.at(-1).ms, PLAY_MS);
    timers.at(-1).fn();
    assert.equal(day, dayFromYMD(1929, 12, 31));
    assert.deepEqual(msgs, ['seam'], 'the 1929 seam is crossed: one pause');
    timers.at(-1).fn();
    assert.equal(day, dayFromYMD(1939, 12, 31));
    timers.at(-1).fn();
    assert.equal(day, dayFromYMD(1949, 12, 31), 'the 1940s gap is jumped, not drawn');
    assert.deepEqual(msgs, ['seam', 'gap']);
    p.pause();
    assert.deepEqual(set.at(-1), [day, false], 'pausing switches to context');
    assert.equal(p.playing, false);
  });

  test('reduced motion steps every 1.2 s', () => {
    const timers = [];
    const p = createPlayer({ get: () => ({ day: 0, tier: 'L3', model: null, seams: [], endDay: 1e6, reduced: true }), setVantage: () => {},
      setTimer: (fn, ms) => { timers.push(ms); return 1; }, clearTimer: () => {} });
    p.play();
    assert.equal(timers[0], REDUCED_PLAY_MS);
    assert.equal(seamCrossed([{ year: 1929 }], dayFromYMD(1928), dayFromYMD(1929, 6, 1)).year, 1929);
  });
});

test('with its width the visible range never leaves [10000 BCE, 2100 CE] (fix pass, §1.5)', () => {
  const W = 1440;
  for (const axis of [{ centerDay: AXIS_LIMITS.maxDay, daysPerPx: 365 }, { centerDay: 0, daysPerPx: AXIS_LIMITS.maxDaysPerPx },
    { centerDay: AXIS_LIMITS.minDay - 1e6, daysPerPx: 50 }]) {
    const a = clampAxis(axis, W);
    assert.ok(a.centerDay - (W / 2) * a.daysPerPx >= AXIS_LIMITS.minDay - 1e-6, 'left edge inside');
    assert.ok(a.centerDay + (W / 2) * a.daysPerPx <= AXIS_LIMITS.maxDay + 1e-6, 'right edge inside');
  }
  const panned = panAxis({ centerDay: AXIS_LIMITS.maxDay - 100 * 365, daysPerPx: 30 }, -1e6);
  assert.ok(panned.centerDay <= AXIS_LIMITS.maxDay);
});

test('the minimap bracket stays inside its strip at every pan, at least 4 px wide (fix pass, §1.5)', async () => {
  const { bracketBox } = await import('../src/ui/timeline/minimap.mjs');
  assert.deepEqual(bracketBox(1440, 1440, 1440), { left: 1436, width: 4 }, 'past the overview\'s last regime: at the right end, visible');
  assert.deepEqual(bracketBox(-30, -20, 1440), { left: 0, width: 10 }, 'before its first regime: at the left end');
  assert.deepEqual(bracketBox(100, 300, 1440), { left: 100, width: 200 });
  assert.deepEqual(bracketBox(0, 5000, 1440), { left: 0, width: 1440 }, 'never wider than the strip');
});
