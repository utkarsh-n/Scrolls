// OWNER: WP6
// timeline/coverage.mjs — coverage (SPEC §1.7): the grey 5-class STEP scale (0 · <10k · <100k · <1M · ≥1M
// tokens; works 0 · <10 · <100 · <1,000 · ≥1,000) — a stated step scale, never a log axis — and the global
// coverage track (24 px under the ruler) summed per bin over the shown lanes, one row per collection unit
// so tokens and works never mix. The per-lane 3 px underlay uses the server's step class per lane cell.

import { COVERAGE_STEPS, RATE_UNITS } from '../../shared/vocab.mjs';

/** Coverage step class of an amount in a unit (§1.7: 0 · <10k · <100k · <1M · ≥1M tokens; works 0 · <10 · <100 · <1,000 · ≥1,000). */
export function stepClass(amount, unit = 'tokens') {
  const steps = COVERAGE_STEPS[unit === 'works' ? 'works' : 'tokens'];
  if (!(amount > 0)) return 0;
  for (let i = 0; i < steps.length; i++) if (amount < steps[i]) return i + 1;
  return steps.length + 1;
}

/** Collection unit of a rate unit: 'tokens' or 'works'. */
export function coverageUnitOf(rateUnit) {
  return RATE_UNITS[rateUnit]?.collectionUnit === 'works' ? 'works' : 'tokens';
}

/**
 * The global coverage track (24 px under the ruler): per bin and per collection unit, the summed coverage
 * of the shown lanes and its step class. Units never mix: tokens and works get separate rows.
 * @param {Array<{covUnit: string, coverage: Array<{bin, loDay, hiDay, tokens, works}>}>} lanes
 */
export function coverageTrack(lanes) {
  const byUnit = new Map();
  for (const l of lanes) {
    if (!byUnit.has(l.covUnit)) byUnit.set(l.covUnit, new Map());
    const m = byUnit.get(l.covUnit);
    for (const c of l.coverage) {
      const amount = l.covUnit === 'works' ? c.works : c.tokens;
      const prev = m.get(c.bin);
      if (prev) prev.amount += amount; else m.set(c.bin, { bin: c.bin, loDay: c.loDay, hiDay: c.hiDay, amount });
    }
  }
  return [...byUnit.entries()].map(([unit, m]) => ({
    unit,
    cells: [...m.values()].sort((a, b) => a.bin - b.bin).map((c) => ({ ...c, cls: stepClass(c.amount, unit) })),
  }));
}

/** UI module contract (§8): a library imported by the model and the legend; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
