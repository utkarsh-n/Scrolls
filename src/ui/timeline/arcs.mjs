// OWNER: WP6
// timeline/arcs.mjs — Transmission (D4) on the Scroll (SPEC §1.8, §8.7): relationship arcs as display-list
// primitives. Forward arcs rise ABOVE the strands from the earlier to the later (derived) end, arrowhead at the
// later end; feedback arcs (only rel types the server marks `feedback: true` — reframes, answer_to,
// recontextualizes, parody_of — never similarity) hang BELOW in violet with the arrowhead on the EARLIER end,
// and that end gains a violet "re-read" halo once the vantage reaches the later work. A date conflict is a
// dotted danger stub with ⚠, never an arc. Beyond the 300-arc budget the server bundles arcs per (lane pair,
// bin pair): a thick translucent stroke, width ∝ log₂(count + 1), with its count.
//
// Line pattern, endpoint and badge come from shared/evidence-style.mjs (the only mapping); hue encodes role and
// is always backed by pattern, glyph and word. An arc is shown once both ends are ≤ the vantage; in context
// mode a later arc is ghosted like any later mark, in strict mode it is left out.

import { dayFromYMD, ymdFromDay } from '../../shared/dates.mjs';
import { edgeStyle } from '../../shared/evidence-style.mjs';
import { formatCount } from '../../shared/format.mjs';
import { summaryChip, summaryRibbons } from './arc-summary.mjs';

/** Above this many bundles, the bundles are drawn as density ribbons (arc-summary.mjs), never as fat arcs. */
export const BUNDLE_ARCS_MAX = 40;
/** Above this many individual arcs (a detail answer has up to 1,500), arcs on the same pixels are drawn once. */
export const DENSE_ARCS = 300;
/** Over a summary, individual arcs whose ends round to the same OVERPLOT_PX columns are drawn once (C4 legibility). */
export const OVERPLOT_PX = 3;
/** Above this many drawn arcs the ones that do not touch the selection fade with their number (fix pass, §1.4). */
export const CALM_ARCS = 40;
/** The faintest a faded arc gets (its line pattern still reads). */
export const QUIET_MIN = 0.18;
/** Over a summary (or a dense answer) a faded arc is drawn at this share of its fade. */
export const SUMMARY_TEXTURE = 0.5;

/**
 * How strongly an arc that does not touch the selection is drawn when `drawn` arcs are on screen: 1 up to CALM_ARCS,
 * then fading as CALM_ARCS / drawn down to QUIET_MIN — so hundreds of arcs read as a texture under the bars, not a
 * curtain over them; the selection's arcs always draw at full strength.
 * @param {number} drawn
 * @returns {number}
 */
export function quietAlpha(drawn) {
  return drawn > CALM_ARCS ? Math.max(QUIET_MIN, CALM_ARCS / drawn) : 1;
}
/** Points sampled along each arc for hit-testing (§8.4). */
export const ARC_SAMPLES = 16;
/** Geometry (§1.4): height = min(lane band, 0.25 × horizontal distance); 1.5 px lines. */
export const ARC = Object.freeze({ share: 0.25, minH: 10, stub: 18, halo: 8, ghost: 0.3 });
const YEAR_WIDTH = [1000, 100, 10, 1];
const TIER_LEVEL = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 3, L5: 3 };

/**
 * The `ev` parameter of GET /api/timeline/arcs for a view's evidence filter (E cycles it, §8.5).
 * @param {{documented: 0|1, computed: 0|1, proposed: 0|1, rejected: 0|1, kindred: 0|1}} ev
 * @returns {string}
 */
export function evParam(ev) {
  const out = ['documented', 'computed', 'proposed'].filter((k) => ev?.[k]);
  if (ev?.rejected) out.push('rejected');
  if (ev?.kindred) out.push('kindred');
  return out.join(',');
}

/** Middle day of an astronomical year: a year-precision end is never drawn at 1 January (§13 rule 18). */
export const midYearDay = (y) => Math.floor((dayFromYMD(y, 1, 1) + dayFromYMD(y + 1, 1, 1)) / 2);

/**
 * A quadratic arc from (x0, y0) to (x1, y1) whose apex is `h` px above (dir = -1) or below (dir = +1) the
 * nearer end. Returns the control point and ARC_SAMPLES + 1 points along the curve.
 * @returns {{cx: number, cy: number, points: Array<[number, number]>}}
 */
export function arcCurve(x0, y0, x1, y1, h, dir = -1) {
  const apex = dir < 0 ? Math.min(y0, y1) - h : Math.max(y0, y1) + h;
  const cx = (x0 + x1) / 2;
  const cy = 2 * apex - (y0 + y1) / 2;
  const points = [];
  for (let i = 0; i <= ARC_SAMPLES; i++) {
    const t = i / ARC_SAMPLES, u = 1 - t;
    points.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]);
  }
  return { cx, cy, points };
}

const bbox = (points, pad = 0) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
};

const words = (relType) => String(relType ?? 'link').replace(/_/g, ' ');

/**
 * Where an arc end sits: its lane's first strand row, at the day of a loaded mark of the same passage when the
 * occurrence override shows one, else the middle of its year.
 * @returns {{x: number, y: number, laneH: number}|null} null when the lane is not shown
 */
function anchorOf(end, { layout, X, markDay }) {
  const lane = layout.lanes.find((l) => l.key === end.lane);
  if (!lane || !Number.isInteger(end.y)) return null;
  const day = Number.isInteger(end.passage) && markDay.has(end.passage) ? markDay.get(end.passage) : midYearDay(end.y);
  return { x: X(day), y: lane.slots[0]?.mid ?? lane.y + lane.h / 2, laneH: lane.h };
}

/** Ends closer than this (px) make no readable arc when many links are drawn. */
export const MIN_ARC_PX = 8;
/** Are a link's ends (mid-year) closer than MIN_ARC_PX on the screen? */
function tooShort(it, X) {
  if (!Number.isInteger(it.src?.y) || !Number.isInteger(it.dst?.y)) return false;
  return Math.abs(X(midYearDay(it.src.y)) - X(midYearDay(it.dst.y))) < MIN_ARC_PX;
}

/** Does an arc touch the selection (the selected link, passage or document)? */
export function touchesSelection(it, selection) {
  if (!selection) return false;
  const { type, id } = selection;
  if (type === 'relationship') return it.rel_id === id;
  if (type === 'passage') return it.src?.passage === id || it.dst?.passage === id;
  if (type === 'document') return it.src?.doc === id || it.dst?.doc === id;
  return false;
}

/**
 * Display-list primitives (layer 'arcs', lane coordinates) for an Arcs response. A summary response (contract
 * 1.3.0, mode 'summary') draws density ribbons per lane pair with its ≤ 300 individual arcs on top; those arcs
 * are drawn quieter unless they touch the selection, so the summary never turns back into a hairball.
 * @param {{mode?: 'individual'|'summary', items?: object[], individual?: object[], buckets?: object[], bundles?: object[],
 *          hidden?: object, total?: number}|null} arcs GET /api/timeline/arcs
 * @param {{layout: object, X: (day: number) => number, model: object, vantage: {day: number, strict: boolean}|null,
 *          layers?: Record<string, 0|1>, selection?: {type: string, id: number}|null, tier?: string, visible?: [number, number]|null}} opts
 *   `visible`: the content x of the view; with many links, those with an end outside it are counted, not drawn
 * @returns {{prims: object[], stats: {drawn: number, bundled: number, ghosted: number, hiddenByVantage: number, offLane: number,
 *            summarised: number, chip: string}}}
 */
export function buildArcs(arcs, { layout, X, model, vantage = null, layers = {}, selection = null, tier = model?.tier ?? 'L2', visible = null }) {
  const prims = [];
  const stats = { drawn: 0, bundled: 0, ghosted: 0, hiddenByVantage: 0, offLane: 0, conflicts: 0, summarised: 0, chip: '', overplotted: 0, ribboned: 0 };
  if (!arcs || layers.arcs === 0) return { prims, stats };
  const summary = arcs.mode === 'summary';
  const overplot = new Map();   // pixel key → {n, id}: summary arcs drawn on the same pixels
  const dense = (arcs.items?.length ?? 0) > DENSE_ARCS;
  if (summary) {
    const labels = new Map((model?.lanes ?? []).map((l) => [l.key, l.label]));
    const r = summaryRibbons(arcs, { layout, X, tier, vantage, labels });
    prims.push(...r.prims);
    stats.summarised = Number.isFinite(arcs.total) ? arcs.total : r.stats.links;
    stats.hiddenByVantage += r.stats.hiddenByVantage;
    stats.chip = summaryChip(arcs);
  }
  const vYear = vantage ? yearOf(vantage.day) : Infinity;
  const markDay = new Map();
  for (const lane of model?.lanes ?? []) for (const s of lane.strands ?? []) for (const m of s.marks ?? []) {
    if (Number.isInteger(m.passage) && !markDay.has(m.passage)) markDay.set(m.passage, Math.floor((m.lo_day + m.hi_day) / 2));
  }
  const reread = new Map();   // earlier end key → {x, y, years:Set, statuses:{}}

  // §1.8 / §8.3: at most 300 individual arcs are drawn. A detail answer (C4) carries up to 1,500 so the view can move
  // inside its window without asking again; past the first 300 in the server's priority order (and those touching
  // the selection), the links are counted into the same quiet ribbons as the bundles.
  let list = (summary ? arcs.individual ?? arcs.items : arcs.items) ?? [];
  let overflow = [];
  if (!summary && list.length > DENSE_ARCS) {
    // Of many links, those leaving the view would only cross it: they are counted (ribbons), the ones inside are drawn.
    const inView = (end) => !visible || !Number.isInteger(end?.y) || (() => { const x = X(midYearDay(end.y)); return x >= visible[0] && x <= visible[1]; })();
    const keep = [], rest = [];
    for (const it of list) {
      const must = it.selected || touchesSelection(it, selection);
      (must || (keep.length < DENSE_ARCS && inView(it.src) && inView(it.dst) && !tooShort(it, X)) ? keep : rest).push(it);
    }
    list = keep;
    overflow = rest;
  }
  for (const it of list) {
    if (it.feedback && layers.feedback === 0) continue;
    // Over a summary, a link both of whose ends fall within a few pixels is a vertical stroke, not an arc: it stays
    // counted in its bucket (the chip says so) unless it touches the selection.
    if (summary && !it.selected && !touchesSelection(it, selection) && tooShort(it, X)) { stats.overplotted++; continue; }
    const a = anchorOf(it.src, { layout, X, markDay }), b = anchorOf(it.dst, { layout, X, markDay });
    if (!a || !b) { stats.offLane++; continue; }
    const later = Math.max(it.src.y, it.dst.y);
    let ghost = false;
    if (later > vYear) {
      if (vantage?.strict) { stats.hiddenByVantage++; continue; }
      ghost = true;
      stats.ghosted++;
    }
    const style = edgeStyle({ evidence_status: it.evidence_status, review_status: it.review_status ?? 'unreviewed',
      provenance_quality: it.provenance_quality ?? 'complete', family: it.family, cue: it.cue, is_synthetic: it.synthetic,
      date_conflict: it.date_conflict, origin: it.human ? 'human' : undefined });
    const ref = { type: 'relationship', id: it.rel_id, src: it.src, dst: it.dst };
    const head = `${style.badge} · ${words(it.rel_type)}${it.glyph ? ` ${it.glyph}` : ''}`;
    if (it.date_conflict) {
      // ⚠ never an arc: a short dotted stub from the dependent end towards its source.
      const dir = Math.sign(b.x - a.x) || 1;
      const points = [[a.x, a.y], [a.x + dir * ARC.stub, a.y - ARC.stub * 0.6]];
      prims.push({ id: `arc:${it.rel_id}`, kind: 'path', layer: 'arcs', style: 'arc-conflict', points, ...bbox(points, 1), openable: true, ref, ghost, edge: style,
        tip: [`⚠ date conflict · ${words(it.rel_type)}`, `the later item (${it.src.y}) is dated before its source (${it.dst.y}) — never drawn as feedback`, 'Click to open the evidence card'] });
      stats.conflicts++;
      continue;
    }
    // Forward: earlier → later above the strands, arrow at the later (derived) end. Feedback: below, arrow at the earlier end.
    const [early, late] = it.src.y <= it.dst.y ? [a, b] : [b, a];
    const dir = it.feedback ? 1 : -1;
    // Over a summary, links whose ends fall on the same pixels would only stack into a solid column: the first (the
    // server's priority order) is drawn and says how many more it stands for; one that touches the selection always draws.
    if ((summary || dense) && !it.selected && !touchesSelection(it, selection)) {
      const k = `${Math.round(early.x / OVERPLOT_PX)}|${Math.round(late.x / OVERPLOT_PX)}|${early.y}|${late.y}|${it.evidence_status}|${it.feedback ? 1 : 0}`;
      const first = overplot.get(k);
      if (first) { first.n++; stats.overplotted++; continue; }
      overplot.set(k, { n: 0, id: it.rel_id });
    }
    // Keep the apex inside the lane area so no arc is clipped at the ruler (or below the last lane).
    const room = dir < 0 ? Math.min(early.y, late.y) - 4 : layout.height - 4 - Math.max(early.y, late.y);
    const h = Math.max(Math.min(ARC.minH, room), Math.min(Math.max(a.laneH, b.laneH), ARC.share * Math.abs(late.x - early.x), room));
    const { cx, cy, points } = arcCurve(early.x, early.y, late.x, late.y, h, dir);
    const arrowAt = it.feedback ? 'start' : 'end';
    const tip = [head, `${Math.min(it.src.y, it.dst.y)} → ${later}${it.feedback ? ' · read back: the later work reframes the earlier one' : ''}`];
    if (it.source) tip.push(String(it.source));
    if (Number.isInteger(it.run_id)) tip.push(`run #${it.run_id}${it.score ? ` · ${it.score.kind ?? 'score'} ${it.score.value}` : ''}`);
    if (style.overlay) tip.push({ check: '✓ confirmed by a reviewer', cross: '✕ rejected by a reviewer', scales: '⚖ disputed' }[style.overlay]);
    if (it.synthetic) tip.push('SYNTHETIC');
    tip.push('Click to open the evidence card');
    prims.push({ id: `arc:${it.rel_id}`, kind: 'path', layer: 'arcs', style: it.feedback ? 'arc-feedback' : 'arc', points, cx, cy,
      p0: [early.x, early.y], p1: [late.x, late.y], arrowAt, ...bbox(points, 2), openable: true, ref, ghost, ghostAlpha: ARC.ghost, edge: style, tip,
      quiet: (summary || dense) && !it.selected && !touchesSelection(it, selection) });
    stats.drawn++;
    if (it.feedback && !ghost) {
      const k = `${it.dst.lane}|${it.dst.passage ?? it.dst.doc}`;
      const r = reread.get(k) ?? { x: early.x, y: early.y, years: new Set(), statuses: {}, ref };
      r.years.add(later);
      r.statuses[it.evidence_status] = (r.statuses[it.evidence_status] ?? 0) + 1;
      reread.set(k, r);
    }
  }
  // Many arcs fade with their number (fix pass: at STEMM scale hundreds of full-strength arcs buried the bars)
  const fade = quietAlpha(stats.drawn);
  if (fade < 1) {
    for (const p of prims) {
      if ((p.style !== 'arc' && p.style !== 'arc-feedback') || p.ref?.type !== 'relationship') continue;
      const it = { selected: false, src: p.ref.src, dst: p.ref.dst, rel_id: p.ref.id };
      if (touchesSelection(it, selection)) continue;
      const wasQuiet = p.quiet === true;   // already quieter over a summary or a dense answer
      p.quiet = true;
      // over a summary the counted ribbons carry the quantities: the hundreds of individual arcs are only a texture
      // (fix pass, second session: at 18% they still read as an amber curtain over 'gene' in STEMM)
      p.quietAlpha = wasQuiet ? Math.min(0.5, fade) * SUMMARY_TEXTURE : fade;
    }
  }
  if (overplot.size) {
    for (const o of overplot.values()) {
      if (!o.n) continue;
      const p = prims.find((x) => x.id === `arc:${o.id}`);
      if (p) p.tip.splice(Math.max(0, p.tip.length - 1), 0, `+${formatCount(o.n)} more ${o.n === 1 ? 'link' : 'links'} on the same pixels (zoom in to separate them)`);
    }
  }
  for (const [k, r] of reread) {
    const first = Math.min(...r.years);
    const parts = Object.entries(r.statuses).map(([st, n]) => `${n} ${st}`).join(', ');
    prims.push({ id: `halo:${k}`, kind: 'glyph', layer: 'arcs', style: 'halo', x0: r.x, x1: r.x, y0: r.y, y1: r.y, r: ARC.halo, openable: true, ref: r.ref,
      tip: [`re-read after ${first} (${parts})`, 'A later work reframes this one; only documented or proposed links draw this halo.'] });
  }
  // Count labels (§1.4: words only where there is room): the largest bundles first, never on top of another label,
  // never for a single arc (M5 gate: thousands of OpenAlex citation bundles printed "1 arc" over each other).
  const placed = [];
  const labelOf = (b, p) => {
    if (!(b.count >= 2)) return null;
    const text = b.label ?? `${b.count} arcs`;
    const x = (p.p0[0] + 2 * p.cx + p.p1[0]) / 4, y = (p.p0[1] + 2 * p.cy + p.p1[1]) / 4 - 4, w = 6.5 * text.length + 6;
    if (placed.some((r) => Math.abs(r.x - x) < (r.w + w) / 2 && Math.abs(r.y - y) < 13)) return null;
    placed.push({ x, y, w });
    return text;
  };
  let bundles = summary ? [] : [...(arcs.bundles ?? []).entries()].sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0));
  // Many bundles are themselves a hairball (M5 gate: 21,490 OpenAlex citations → 1,853 bundles): beyond
  // BUNDLE_ARCS_MAX — or with links past the 300 drawn — they are drawn as the summary's quiet ribbons instead
  // (the same counts, per lane pair and bin of the tier).
  if (bundles.length > BUNDLE_ARCS_MAX || overflow.length) {
    const w = YEAR_WIDTH[TIER_LEVEL[tier] ?? 2];
    const binOfYear = (y) => Math.floor(y / w);
    const buckets = bundles.map(([, b]) => {
      const bw = YEAR_WIDTH[TIER_LEVEL[b.tier ?? tier] ?? 2];
      return { src_lane: b.lanes?.[0], dst_lane: b.lanes?.[1], src_bin: binOfYear((b.bins?.[0] ?? 0) * bw), dst_bin: binOfYear((b.bins?.[1] ?? 0) * bw),
        n: b.count ?? 0, by_status: b.status ?? {} };
    });
    for (const it of overflow) {
      if ((it.feedback && layers.feedback === 0) || !Number.isInteger(it.src?.y) || !Number.isInteger(it.dst?.y)) continue;
      buckets.push({ src_lane: it.src.lane, dst_lane: it.dst.lane, src_bin: binOfYear(it.src.y), dst_bin: binOfYear(it.dst.y), n: 1,
        by_status: { [it.evidence_status]: 1 } });
    }
    const labels = new Map((model?.lanes ?? []).map((l) => [l.key, l.label]));
    const r = summaryRibbons({ mode: 'summary', bucket_width: w, buckets }, { layout, X, tier, vantage, labels });
    prims.unshift(...r.prims);   // under the individual arcs
    stats.ribboned = buckets.reduce((n, b) => n + b.n, 0);
    stats.hiddenByVantage += r.stats.hiddenByVantage;
    bundles = [];
  }
  for (const [i, b] of bundles) {
    const p = bundleGeometry(b, { layout, X });
    if (!p) { stats.offLane++; continue; }
    const laterYear = Math.max(p.years[0], p.years[1]);
    let ghost = false;
    if (laterYear > vYear) { if (vantage?.strict) { stats.hiddenByVantage += b.count; continue; } ghost = true; }
    const statuses = Object.entries(b.status ?? {}).map(([st, n]) => `${formatCount(n)} ${st}`).join(', ');
    prims.push({ id: `bun:${i}:${b.lanes.join('>')}:${b.bins.join('>')}`, kind: 'path', layer: 'arcs', style: 'arc-bundle', points: p.points, cx: p.cx, cy: p.cy,
      p0: p.p0, p1: p.p1, width: Math.max(1.5, b.width ?? Math.log2(b.count + 1)), label: labelOf(b, p), ...bbox(p.points, 2), ghost,
      openable: false, ref: { type: 'bundle' }, tip: [`${b.label ?? `${b.count} arcs`} bundled (more than 300 in view)`, statuses, 'Zoom in to see them one by one.'].filter(Boolean) });
    stats.bundled += b.count;
  }
  return { prims, stats };
}

/** Geometry of a bundle between two bins (bin centres at the bundle's tier). */
function bundleGeometry(b, { layout, X }) {
  const la = layout.lanes.find((l) => l.key === b.lanes?.[0]), lb = layout.lanes.find((l) => l.key === b.lanes?.[1]);
  if (!la || !lb) return null;
  const w = YEAR_WIDTH[TIER_LEVEL[b.tier] ?? 2];
  const yearOfBin = (bin) => bin * w + w / 2;
  const years = [yearOfBin(b.bins[0]), yearOfBin(b.bins[1])];
  const xa = X(dayFromYMD(Math.floor(years[0]), 1, 1)), xb = X(dayFromYMD(Math.floor(years[1]), 1, 1));
  const ya = la.slots[0]?.mid ?? la.y + la.h / 2, yb = lb.slots[0]?.mid ?? lb.y + lb.h / 2;
  const [p0, p1] = years[0] <= years[1] ? [[xa, ya], [xb, yb]] : [[xb, yb], [xa, ya]];
  const h = Math.max(ARC.minH, Math.min(Math.max(la.h, lb.h), ARC.share * Math.abs(p1[0] - p0[0])));
  const c = arcCurve(p0[0], p0[1], p1[0], p1[1], h, (b.feedback ?? 0) > b.count / 2 ? 1 : -1);
  return { ...c, p0, p1, years };
}

const yearOf = (day) => ymdFromDay(Math.floor(day)).y;

// Split (⑂) and merge (⑃) glyphs between context-group lanes live in clusters.mjs (contract 1.3.0 lane keys).
export { buildTransitions as buildSplits, SPLIT_CAVEAT } from './clusters.mjs';

/**
 * Footer words for what the arcs layer leaves out: "+212 more arcs (bundled) · 1 rejected hidden · 5 filtered".
 * @param {object|null} arcs Arcs response
 * @param {{bundled: number, hiddenByVantage: number, offLane: number}} stats
 * @returns {string}
 */
export function arcsNote(arcs, stats) {
  if (!arcs) return '';
  const h = arcs.hidden ?? {};
  const parts = [];
  if (arcs.mode === 'summary') parts.push(stats?.chip || summaryChip(arcs));
  if (stats?.bundled) parts.push(`+${formatCount(stats.bundled)} more arcs (bundled)`);
  if (stats?.ribboned) parts.push(`+${formatCount(stats.ribboned)} more links summarised; zoom in for detail`);
  if (h.rejected) parts.push(`${formatCount(h.rejected)} rejected hidden`);
  if (h.kindred) parts.push(`${formatCount(h.kindred)} kindred hidden`);
  if (h.filtered) parts.push(`${formatCount(h.filtered)} filtered by evidence`);
  if (stats?.hiddenByVantage) parts.push(`${formatCount(stats.hiddenByVantage)} after the vantage`);
  return parts.join(' · ');
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
