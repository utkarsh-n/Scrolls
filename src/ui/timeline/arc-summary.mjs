// OWNER: WP6
// timeline/arc-summary.mjs — Transmission at scale (SPEC §1.8 budget; contract 1.3.0 C4). When more than 1,500
// links fall in the requested range, GET /api/timeline/arcs answers `mode: 'summary'`: counts per (lane pair,
// bin pair) plus at most 300 individual arcs of the highest priority. The Scroll then draws, per lane pair, a
// quiet density RIBBON in the arc zone of the lane that holds the later end — one segment per bin, thickness
// ∝ log₂(n + 1), pattern by the dominant evidence status (solid documented, dashed computed, dotted proposed) —
// with the individual arcs on top and a chip "21,490 citation links — summarised; zoom in for detail". Below
// 50 years of visible time the client asks for `detail=1` (individual arcs, up to 1,500).
//
// A ribbon counts recorded links; it is never a rate, never a claim that one lane influenced another, and it
// is gated by the vantage like every arc (strict hides, context ghosts).

import { dayFromYMD, todayDay, yearRangeLabel, ymdFromDay } from '../../shared/dates.mjs';
import { edgeStyle } from '../../shared/evidence-style.mjs';
import { formatCount } from '../../shared/format.mjs';

/** Visible span (years) below which individual arcs are requested (C4). */
export const DETAIL_YEARS = 50;
/** Ribbon geometry (px): thickness = K · log₂(n + 1), at most MAX_T; gap between stacked ribbons. */
export const RIBBON = Object.freeze({ k: 1, maxT: 9, minT: 1, gap: 2, maxPairs: 4 });
const BIN_YEARS = { L0: 1000, L1: 100, L2: 10, L3: 1, L4: 1, L5: 1 };
const STATUSES = ['documented', 'computed', 'proposed'];

const yearOf = (day) => ymdFromDay(Math.floor(day)).y;

/**
 * The arcs request for a viewport: below 50 visible years a window narrower than 50 years around the view with
 * `detail: 1`; otherwise the built range (≈ 3 viewport widths).
 * @param {{loDay: number, hiDay: number}} visible
 * @param {[number, number]} range
 * @returns {{fromYear: number, toYear: number, detail: 0|1}}
 */
export function arcsWindow(visible, range) {
  const span = (visible.hiDay - visible.loDay) / 365.2425;
  if (span < DETAIL_YEARS) {
    const want = Math.min(DETAIL_YEARS - 1, Math.max(Math.ceil(span) + 1, Math.ceil(span * 3)));
    const mid = yearOf((visible.loDay + visible.hiDay) / 2);
    const fromYear = mid - Math.floor((want - 1) / 2);
    return { fromYear, toYear: fromYear + want - 1, detail: 1 };
  }
  return { fromYear: yearOf(range[0]), toYear: yearOf(range[1]), detail: 0 };
}

/**
 * The `sel` parameter of the arcs request: the selected document, passage or occurrence, so the server can put the
 * links touching it among the individual arcs of a summary.
 * @param {{type: string, id: number}|null} selection
 * @returns {string|null}
 */
export function selParam(selection) {
  if (!selection || !Number.isInteger(selection.id)) return null;
  return { document: 'document', passage: 'passage', occurrence: 'occurrence' }[selection.type] ? `${selection.type}:${selection.id}` : null;
}

/** The dominant evidence status of a bucket (ties go to the stronger status). */
export function dominantStatus(byStatus) {
  let best = 'documented', n = -1;
  for (const st of STATUSES) if ((byStatus?.[st] ?? 0) > n) { n = byStatus?.[st] ?? 0; best = st; }
  return best;
}

/** The word for what was summarised: "citation links" when every link said so, else "links". */
export function summaryNoun(arcs) {
  const fams = arcs?.families ? Object.keys(arcs.families) : [...new Set((arcs?.individual ?? arcs?.items ?? []).map((a) => a.family))];
  if (arcs?.family === 'citation' || (fams.length === 1 && fams[0] === 'citation')) return 'citation links';
  return 'links';
}

/**
 * The summary chip (C4): "21,490 citation links — summarised; zoom in for detail".
 * @param {object|null} arcs Arcs response
 * @returns {string}
 */
export function summaryChip(arcs) {
  if (arcs?.mode !== 'summary') return '';
  const total = Number.isFinite(arcs.total) ? arcs.total : (arcs.buckets ?? []).reduce((s, b) => s + (b.n ?? 0), 0);
  return `${formatCount(total)} ${summaryNoun(arcs)} — summarised; zoom in for detail`;
}

/**
 * Aggregate buckets into per-lane-pair series keyed by the bin of the later end.
 * @param {Array<{src_lane: string, dst_lane: string, src_bin: number, dst_bin: number, n: number, by_status?: object}>} buckets
 * @returns {Array<{host: string, other: string, total: number, bins: Map<number, {n: number, by: Record<string, number>}>}>}
 */
export function ribbonSeries(buckets) {
  const pairs = new Map();
  for (const b of buckets ?? []) {
    if (!(b.n > 0) || !Number.isInteger(b.src_bin) || !Number.isInteger(b.dst_bin)) continue;
    const srcLater = b.src_bin > b.dst_bin;
    const host = srcLater ? b.src_lane : b.dst_lane, other = srcLater ? b.dst_lane : b.src_lane;
    const bin = Math.max(b.src_bin, b.dst_bin);
    const k = `${host}\u0000${other}`;
    if (!pairs.has(k)) pairs.set(k, { host, other, total: 0, bins: new Map() });
    const p = pairs.get(k);
    p.total += b.n;
    const cur = p.bins.get(bin) ?? { n: 0, by: { documented: 0, computed: 0, proposed: 0 } };
    cur.n += b.n;
    for (const st of STATUSES) cur.by[st] += b.by_status?.[st] ?? 0;
    p.bins.set(bin, cur);
  }
  return [...pairs.values()].sort((a, b) => b.total - a.total || a.host.localeCompare(b.host) || a.other.localeCompare(b.other));
}

/**
 * Ribbon primitives (layer 'arcs', lane coordinates) for a summary response.
 * @param {object} arcs Arcs response with mode 'summary'
 * @param {{layout: object, X: (day: number) => number, tier: string, vantage?: {day: number, strict: boolean}|null,
 *          labels?: Map<string, string>}} opts  `labels`: lane key → label for the tooltips
 * @returns {{prims: object[], stats: {links: number, offLane: number, hiddenByVantage: number}}}
 */
export function summaryRibbons(arcs, { layout, X, tier, vantage = null, labels = new Map() }) {
  const prims = [];
  const stats = { links: 0, offLane: 0, hiddenByVantage: 0 };
  if (arcs?.mode !== 'summary') return { prims, stats };
  // The server coarsens bins (decade → century → millennium) until its buckets fit: `bucket_width` says which.
  const width = Number.isInteger(arcs.bucket_width) && arcs.bucket_width > 0 ? arcs.bucket_width : BIN_YEARS[arcs.tier ?? tier] ?? 10;
  const vYear = vantage ? yearOf(vantage.day) : Infinity;
  const byHost = new Map();
  for (const p of ribbonSeries(arcs.buckets)) {
    const lane = layout.lanes.find((l) => l.key === p.host);
    if (!lane || !layout.lanes.some((l) => l.key === p.other)) { stats.offLane += p.total; continue; }
    if (!byHost.has(p.host)) byHost.set(p.host, { lane, pairs: [] });
    byHost.get(p.host).pairs.push(p);
  }
  const name = (k) => labels.get(k) ?? k;
  for (const { lane, pairs } of byHost.values()) {
    // The busiest pairs get their own ribbon; the rest share one ("other lanes").
    let shown = pairs;
    if (pairs.length > RIBBON.maxPairs) {
      const rest = pairs.slice(RIBBON.maxPairs - 1);
      const merged = { host: lane.key, other: null, total: 0, bins: new Map(), count: rest.length };
      for (const p of rest) {
        merged.total += p.total;
        for (const [bin, v] of p.bins) {
          const cur = merged.bins.get(bin) ?? { n: 0, by: { documented: 0, computed: 0, proposed: 0 } };
          cur.n += v.n;
          for (const st of STATUSES) cur.by[st] += v.by[st];
          merged.bins.set(bin, cur);
        }
      }
      shown = [...pairs.slice(0, RIBBON.maxPairs - 1), merged];
    }
    // Stack from the top of the lane band down into the top third of the first strand slot (quiet enough to sit over
    // a bar's upper edge); scale down when the room is short.
    const slot0 = lane.slots[0] ?? { y: lane.y + 8, h: Math.max(8, lane.h - 16) };
    const room = Math.max(6, slot0.y - lane.y - 3 + slot0.h * 0.35);
    const thick = (n) => Math.max(RIBBON.minT, Math.min(RIBBON.maxT, RIBBON.k * Math.log2(n + 1)));
    const need = shown.reduce((s, p) => s + Math.max(...[...p.bins.values()].map((v) => thick(v.n))) + RIBBON.gap, 0);
    const scale = need > room ? Math.max(0.25, room / need) : 1;
    let y = lane.y + 2;
    for (const p of shown) {
      const pairMax = Math.max(...[...p.bins.values()].map((v) => thick(v.n))) * scale;
      const between = p.other === null ? `${name(p.host)} ← ${p.count} other lanes` : p.other === p.host ? `within ${name(p.host)}` : `${name(p.other)} → ${name(p.host)}`;
      for (const [bin, v] of [...p.bins.entries()].sort((a, b) => a[0] - b[0])) {
        const loYear = bin * width, hiYear = loYear + width - 1;
        stats.links += v.n;
        let ghost = false;
        if (hiYear > vYear) {
          if (vantage?.strict) { stats.hiddenByVantage += v.n; continue; }
          ghost = true;
        }
        const t = thick(v.n) * scale;
        const status = dominantStatus(v.by);
        // A coarse bin (2000–2099) never draws past today: no recorded link lies in the future.
        const endDay = Math.min(dayFromYMD(hiYear + 1, 1, 1), todayDay() + 1);
        const x0 = X(dayFromYMD(loYear, 1, 1)), x1 = X(endDay);
        const parts = STATUSES.filter((st) => v.by[st]).map((st) => `${formatCount(v.by[st])} ${st}`).join(', ');
        prims.push({
          id: `rib:${lane.key}:${p.other ?? '*'}:${bin}`, kind: 'band', layer: 'arcs', style: 'arc-ribbon', status, edge: edgeStyle({ evidence_status: status }),
          x0, x1: Math.max(x0 + 1, x1), y0: y + (pairMax - t), y1: y + pairMax, openable: true, ghost, ghostAlpha: 0.3,
          ref: { type: 'ribbon', lane: lane.key, other: p.other, loDay: dayFromYMD(loYear, 1, 1), hiDay: dayFromYMD(hiYear, 12, 31) },
          tip: [`${between} · ${yearRangeLabel(loYear, hiYear)}: ${formatCount(v.n)} ${v.n === 1 ? 'link' : 'links'}${parts ? ` (${parts})` : ''}`,
            'Recorded links counted per bin of the later end — not a rate, and not evidence that one lane influenced another.',
            'Click to zoom in: below 50 years each link is drawn on its own.'],
        });
      }
      y += pairMax + RIBBON.gap * scale;
    }
  }
  return { prims, stats };
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
