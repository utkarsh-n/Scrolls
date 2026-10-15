// OWNER: N7
// G5 (IOS-SPEC §2.2, §8.5 N7): the reference's display list, built by Node (no DOM) exactly as viewport.mjs builds it,
// over real tile, mark and corpus payloads served by the reference server on `cp -c` clones of m1r (the demo) and m5r
// (Cipher *machine*, with the modality seam), at widths 430, 932 and 1440 pt × the six tiers × a vantage sweep (none,
// plus 12 days across the extent, each strict and context), with hit-grid answers for 200 probe points per case.
//
// Families:
//   g5.inputs        (committed) one line per m1r query: the request, the TimelineQuery (lanes' text examples left out),
//                    the corpora entry (the coverage-only start), the strand labels, and every tile and marks payload the
//                    cases read (tier → {answered, tiles: tile → payload | null = asked, not returned}).
//   g5.inputs-m5r    (private) the same for the m5r query (Cipher machine).
//   g5.display       (committed) the demo at 430 pt: one line per (query, tier[, variant]) with the axis, range, marks
//                    window and layout parameters the viewport used, and `out`: Node's model summary, layout, stats, the
//                    display list (top + lanes) without a vantage, 200 hit probes, and per vantage the hidden and
//                    ghosted indices, any primitive the vantage build has that the plain one lacks, and the probes whose
//                    answer changed.
//   g5.display-wide  (private, size only) the demo at 932 and 1440 pt and Cipher machine at every width.
// Reduce Motion is not an input of buildDisplay (it changes only fades and the Play cadence), so the sweep is the same
// with it on and off; ScrollsScrollModelTests assert that the Swift builder takes no such input.
//
// Determinism: fixed queries, fixed widths, tiers and vantage days, and a mulberry32 stream for the probes. Probes whose
// distance to any candidate lies within 0.01 pt of its threshold are re-drawn, so a ±1e-4 pt geometry difference cannot
// flip a hit.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import { dayFromYMD, ymdFromDay } from '../../src/shared/dates.mjs';
import { mulberry32 } from '../../src/shared/ids.mjs';
import { defaultState, formatFilter } from '../../src/shared/viewstate.mjs';
import { buildDisplay, describeModel, layoutLanes, GEOM } from '../../src/ui/timeline/display.mjs';
import { buildHitGrid } from '../../src/ui/timeline/hit.mjs';
import { buildCoverageModel, buildModel, strandSummary } from '../../src/ui/timeline/model.mjs';
import { createScale } from '../../src/ui/timeline/scale.mjs';
import { daysPerPxForTier, tierForDaysPerPx, tilesForDays } from '../../src/ui/timeline/tiers.mjs';
import { formatTokens, unitLabel } from '../../src/shared/format.mjs';

export const owner = 'N7';
export const group = 'display';

const WIDTHS = [430, 932, 1440];
/** Lane area heights the layout fills (portrait 430 pt, landscape 932 pt, a large canvas at 1440 pt). */
const FILL = { 430: 600, 932: 320, 1440: 700 };
const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
const VANTAGES = 12;
const PROBES = 200;
const TOL = 12;
const LAYERS = defaultState('demo').layers;
const MAX_TILES_PER_REQUEST = 16;

/** The queries: [key, snapshot, corpus, facet, strands [[id, glyph]], variants]. */
const QUERIES = [
  { key: 'demo-start', snapshot: 'm1r', corpus: 'demo', facet: 'community', strands: [] },
  { key: 'demo-carry', snapshot: 'm1r', corpus: 'demo', facet: 'community', strands: [[1, 'circle']], variants: ['washes-off', 'coverage-off'] },
  { key: 'demo-two', snapshot: 'm1r', corpus: 'demo', facet: 'community', strands: [[1, 'circle'], [2, 'square']] },
  { key: 'demo-sym', snapshot: 'm1r', corpus: 'demo', facet: 'community', strands: [[4, 'diamond']] },
  { key: 'demo-ghost-domain', snapshot: 'm1r', corpus: 'demo', facet: 'domain', strands: [[3, 'triangle']] },
  { key: 'cipher-machine', snapshot: 'm5r', corpus: 'cipher', facet: 'domain', strands: [[5, 'circle']], variants: ['seam-collapsed'] },
];

const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);

// ── The reference server on a clone ─────────────────────────────────────────────────────────────────────────────────

async function startServer(ctx, snapshot) {
  const clone = ctx.cloneSnapshot(snapshot);
  const env = { ...process.env, SCROLLS_DATA: clone.dir, SCROLLS_NO_AUTO_IMPORT: '1', SCROLLS_PORT: '0' };
  const child = spawn(process.execPath, [join(ctx.refRoot, 'server.mjs')], { cwd: ctx.refRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const lines = createInterface({ input: child.stdout });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server on ${snapshot} did not start in 180 s: ${stderr}`)), 180_000);
    lines.on('line', (l) => {
      try {
        const j = JSON.parse(l);
        if (j.event === 'listening') { clearTimeout(timer); resolve(j.url); }
      } catch { /* the human-readable line */ }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
  });
  ctx.log(`reference server on ${snapshot} clone at ${url}`);
  const call = async (method, path, body) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${url}${path}`, {
        method, headers: body ? { 'content-type': 'application/json', origin: url } : {}, body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (res.status === 503 && attempt < 8) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`);
      return JSON.parse(text);
    }
  };
  return {
    get: (path, params = {}) => call('GET', `${path}?${new URLSearchParams(params)}`),
    post: (path, body) => call('POST', path, body),
    async close() {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => {});
      clone.cleanup();
    },
  };
}

// ── Serialising the display list ───────────────────────────────────────────────────────────────────────────────────

/**
 * One primitive as the Swift side reconstructs it: [id, kind, layer, style, x0, y0, x1, y1, openable 0|1, extra], extra
 * holding whatever else the primitive carries (ghost, text, pattern, round, glyph, sub, size, feather, w, seamX,
 * synthetic, points, ref, tip, t) or 0. Geometry is rounded to 1e-4 pt, far inside the ±0.01 pt rule.
 */
function prim(p) {
  const o = {};
  if (p.ghost) o.ghost = true;
  for (const k of ['text', 'pattern', 'round', 'glyph', 'sub']) if (p[k] !== undefined && p[k] !== null) o[k] = p[k];
  for (const k of ['size', 'feather', 'w', 'seamX']) if (Number.isFinite(p[k])) o[k] = r4(p[k]);
  if (p.synthetic !== undefined) o.synthetic = Boolean(p.synthetic);
  if (p.points) o.points = p.points.map(([x, y]) => [r4(x), r4(y)]);
  if (p.ref) o.ref = p.ref;
  if (p.tip) o.tip = p.tip;
  if (Number.isFinite(p.t)) o.t = p.t;
  return [p.id, p.kind, p.layer, p.style, r4(p.x0), r4(p.y0), r4(p.x1), r4(p.y1), p.openable ? 1 : 0, Object.keys(o).length ? o : 0];
}

/**
 * Hit probes in content coordinates of one list: [x, y, hits] with hits flattened as [index into the list, distance, …]
 * in the reference's order (distances to 1e-4, so the Swift side can tell exact ties apart from order).
 */
function probes(grid, rand, { w, h, prims, index, count }) {
  const out = [];
  const anchors = prims.filter((p) => p.kind !== 'text' && (p.ref || p.tip));
  let guard = 0;
  while (out.length < count && guard++ < count * 20) {
    let x, y;
    if (anchors.length && out.length % 2 === 0) {
      const a = anchors[Math.floor(rand() * anchors.length)];
      x = (a.x0 + a.x1) / 2 + (rand() - 0.5) * 30;
      y = (a.y0 + a.y1) / 2 + (rand() - 0.5) * 30;
    } else {
      x = rand() * w;
      y = rand() * h;
    }
    x = r4(x); y = r4(y);
    // reject a probe that sits within 0.01 pt of any candidate's threshold
    const near = grid.queryAll(x, y, TOL + 0.02);
    const allowedOf = (e) => (e.cls === 'band' || e.cls === 'bin' || e.cls === 'wash' ? 0.5 : TOL);
    if (near.some((e) => Math.abs(e.d - allowedOf(e)) < 0.01)) continue;
    out.push([x, y, encodeHits(grid.queryAll(x, y, TOL), index)]);
  }
  return out;
}

function encodeHits(hits, index) {
  const flat = [];
  for (const e of hits) flat.push(index.get(e.id), r4(e.d));
  return flat;
}

function modelSummary(model) {
  return {
    tier: model.tier, coverageOnly: Boolean(model.coverageOnly), hiddenLanes: model.hiddenLanes, hiddenN: model.hiddenN,
    visibleN: model.visibleN, rangeN: model.rangeN, wantMarks: model.wantMarks, override: model.override,
    marksCheck: model.marksCheck ?? null, loadedTiles: model.loadedTiles, missingTiles: model.missingTiles, rowCount: model.rowCount,
    units: Object.values(model.units).map((u) => ({ unit: u.unit, max: u.max, lanes: u.lanes })),
    coverageTrack: model.coverageTrack.map((r) => ({ unit: r.unit, cells: r.cells.map((c) => [c.bin, c.loDay, c.hiDay, c.amount, c.cls]) })),
    summary: describeModel(model),
    lanes: model.lanes.map((l) => ({
      key: l.key, label: l.label, unit: l.unit, covUnit: l.covUnit, pending: Boolean(l.pending), synthetic: Boolean(l.synthetic),
      uncovered: l.uncovered, pendingRuns: l.pendingRuns, unloaded: l.unloaded,
      coverage: l.coverage.map((c) => [c.bin, c.cls]),
      strands: l.strands.map((s) => ({
        ref: s.ref, label: s.label, sub: s.sub ?? null,
        bins: Array.from(s.cols.bin), state: Array.from(s.cols.state), n: Array.from(s.cols.n), flags: Array.from(s.cols.flags),
        bars: s.bars.map((b) => ({ start: b.start, end: b.end, loDay: b.loDay, hiDay: b.hiDay, n: b.n, start_cap: b.startCap, end_cap: b.endCap })),
        washes: s.washes.map((w) => [w.loDay, w.hiDay, w.n, w.label, Boolean(w.circa), Boolean(w.synthetic)]),
        marks: s.marks ? s.marks.length : null,
        strandSummary: l.coverageOnly ? null : strandSummary(l, s, { tier: model.tier, formatTokens, unitLabel }),
      })),
    })),
  };
}

// ── The family ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function generate(ctx) {
  const inputs = [];
  const cases = [];
  const rand = mulberry32(5150);
  const bySnapshot = new Map();
  // GEN_DISPLAY_ONLY=key[,key] narrows the queries while developing the generator (never for a committed run).
  const only = process.env.GEN_DISPLAY_ONLY ? new Set(process.env.GEN_DISPLAY_ONLY.split(',')) : null;
  for (const q of QUERIES.filter((x) => !only || only.has(x.key))) {
    if (!bySnapshot.has(q.snapshot)) bySnapshot.set(q.snapshot, []);
    bySnapshot.get(q.snapshot).push(q);
  }
  const usedSnapshots = [];
  for (const [snapshot, queries] of bySnapshot) {
    if (!ctx.findSnapshot([snapshot])) throw new Error(`snapshot ${snapshot} is not complete on this Mac`);
    usedSnapshots.push({ snapshot, ...(ctx.snapshotInfo(snapshot)?.built_from ?? {}) });
    const server = await startServer(ctx, snapshot);
    try {
      for (const q of queries) {
        const t0 = Date.now();
        const { input, qcases } = await oneQuery(ctx, server, q, rand);
        inputs.push(input);
        cases.push(...qcases);
        ctx.log(`g5 ${q.key}: ${qcases.length} cases in ${Date.now() - t0} ms`);
      }
    } finally {
      await server.close();
    }
  }
  ctx.inputs = { snapshots: usedSnapshots, queries: QUERIES.map((q) => q.key), widths: WIDTHS, tiers: TIERS, vantages: VANTAGES * 2 + 1, probes: PROBES };
  return { inputs, cases };
}

async function oneQuery(ctx, server, q, rand) {
  const view = { ...defaultState(q.corpus) };
  view.strands = q.strands.map(([id, glyph]) => ({ type: 'expression', id, glyph }));
  view.lanes = { ...view.lanes, facet: q.facet };
  const body = {
    strands: view.strands.map((s) => ({ type: s.type, ref: s.id })), corpus: view.corpus,
    lanes: { facet: view.lanes.facet, order: view.lanes.order, max: view.lanes.max, run: null },
    f: formatFilter(view.f, { withDefaults: true }), toggles: { ...view.toggles }, timeBasis: view.timeBasis,
  };
  const corpora = await server.get('/api/corpora');
  const corpus = corpora.find((c) => c.slug === q.corpus);
  const strandLabels = {};
  for (const s of view.strands) {
    const e = await server.get(`/api/expressions/${s.id}`, { corpus: q.corpus });
    strandLabels[String(s.id)] = e?.expression?.surface ?? `expression ${s.id}`;
  }
  const start = view.strands.length === 0;
  let query = null;
  if (!start) {
    query = await server.post('/api/timeline/query', body);
    for (let i = 0; query.status !== 'ready' && i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      query = await server.post('/api/timeline/query', body);
    }
    if (query.status !== 'ready') throw new Error(`${q.key}: query not ready (${query.status})`);
  }
  // lanes[].examples are text samples the model never reads: left out of the stored payload (§2.6, size)
  const stored = query ? { ...query, lanes: query.lanes.map(({ examples, ...l }) => l) } : null;
  const input = { key: q.key, snapshot: q.snapshot, corpus: q.corpus, request: body, query: stored, corpus_entry: corpus ?? null,
    strands: view.strands.map((s) => ({ type: s.type, id: String(s.id), glyph: s.glyph })), strandLabels, tiles: {}, marks: {} };
  const labelsMap = new Map(Object.entries(strandLabels));

  // The extent the views open on and the vantage days.
  const extentOf = () => {
    if (start) {
      const spans = (corpus?.collections ?? []).flatMap((c) => c.span ?? []).filter(Boolean);
      return [dayFromYMD(1880, 1, 1), dayFromYMD(2026, 12, 31), spans];
    }
    const lo = query.lanes.map((l) => l.first?.lo_day).filter(Number.isFinite);
    const hi = query.lanes.map((l) => l.last?.hi_day).filter(Number.isFinite);
    return [Math.min(...lo), Math.max(...hi)];
  };
  const [extLo, extHi] = extentOf();
  // A day with observations for the fine tiers: the median of the first observation days, else the middle.
  const firsts = start ? [] : query.lanes.map((l) => l.first?.lo_day).filter(Number.isFinite).sort((x, y) => x - y);
  const focus = firsts.length ? firsts[Math.floor(firsts.length / 2)] : Math.round((extLo + extHi) / 2);
  const vantageDays = Array.from({ length: VANTAGES }, (_, i) => Math.round(extLo + ((i + 0.5) / VANTAGES) * (extHi - extLo)));

  const tilesFor = async (tier, list) => {
    input.tiles[tier] ??= { answered: tier, tiles: {} };
    const slot = input.tiles[tier];
    const need = list.filter((t) => !(String(t) in slot.tiles));
    for (let i = 0; i < need.length; i += MAX_TILES_PER_REQUEST) {
      const want = need.slice(i, i + MAX_TILES_PER_REQUEST);
      const res = await server.get('/api/timeline/tiles', { q: query.queryKey, tier, tiles: want.join(',') });
      if (res.tier !== tier) slot.answered = res.tier;
      for (const t of res.tiles ?? []) if (t) slot.tiles[String(t.tile)] = t;
      for (const t of want) if (!(String(t) in slot.tiles)) slot.tiles[String(t)] = null;
    }
    const m = new Map();
    for (const [k, v] of Object.entries(slot.tiles)) m.set(Number(k), v);
    return m;
  };
  const marksFor = async (fromYear, toYear) => {
    const key = `${fromYear}|${toYear}`;
    if (!input.marks[key]) {
      const res = await server.get('/api/timeline/marks', { q: query.queryKey, from: fromYear, to: toYear, limit: 4000 });
      input.marks[key] = { fromDay: dayFromYMD(fromYear, 1, 1), toDay: dayFromYMD(toYear, 12, 31), items: res.marks ?? [],
        truncated: Boolean(res.truncated), total: res.total ?? 0 };
    }
    return input.marks[key];
  };

  const qcases = [];
  const variants = [null, ...(q.variants ?? [])];
  for (const width of WIDTHS) {
    const seenTiers = new Set();
    for (const askTier of TIERS) {
      // the viewport's axis: the tier's middle zoom, clamped so the visible range stays inside the domain
      const dpp0 = daysPerPxForTier(askTier);
      const coarse = TIERS.indexOf(askTier) <= 2;
      const center0 = coarse ? (extLo + extHi) / 2 : focus;
      const axis = clampAxis({ centerDay: center0, daysPerPx: dpp0 }, width);
      const tier = tierForDaysPerPx(axis.daysPerPx);
      if (seenTiers.has(tier)) continue;
      seenTiers.add(tier);
      const sc = createScale({ centerDay: axis.centerDay, daysPerPx: axis.daysPerPx, width });
      const visible = [sc.loDay, sc.hiDay];
      const span = sc.hiDay - sc.loDay;
      const range = [sc.loDay - span, sc.hiDay + span];
      let model, marksKey = null;
      if (start) {
        model = buildCoverageModel(corpus?.collections ?? [], { synthetic: Boolean(corpus?.synthetic), tier });
      } else {
        const tiles = await tilesFor(tier, tilesForDays(tier, range[0], range[1], 48));
        const drawTier = input.tiles[tier].answered;
        const tilesDrawn = drawTier === tier ? tiles : await tilesFor(drawTier, tilesForDays(drawTier, range[0], range[1], 48));
        const mk = (marks) => buildModel({ query, tier: drawTier, tiles: tilesDrawn, range, visible, strands: view.strands, marks,
          strandLabels: labelsMap, laneLimit: view.lanes.max, lanesView: view.lanes });
        model = mk(null);
        if (model.wantMarks) {
          const yearOf = (d) => ymdFromDay(Math.floor(d)).y;
          const useRange = model.rangeN <= 4000;
          const [lo, hi] = useRange ? range : visible;
          const fromYear = yearOf(lo) - 1, toYear = yearOf(hi) + 1;
          const marks = await marksFor(fromYear, toYear);
          marksKey = `${fromYear}|${toYear}`;
          model = mk(marks);
        }
      }
      const layoutParams = { strandCount: model.rowCount ?? view.strands.length, slotH: GEOM.slotH, moreRow: model.hiddenLanes > 0, fillH: FILL[width] };
      const layout = layoutLanes(model.lanes, layoutParams.strandCount, { slotH: layoutParams.slotH, moreRow: layoutParams.moreRow,
        fillH: layoutParams.fillH, top: [], bottom: [] });
      for (const variant of variants) {
        const layers = { ...LAYERS, ...(variant === 'washes-off' ? { washes: 0 } : {}), ...(variant === 'coverage-off' ? { coverage: 0 } : {}) };
        const seamCollapsed = variant === 'seam-collapsed';
        if (variant && width !== 430) continue;  // variants at the portrait width only
        const opts = { originDay: range[0], daysPerPx: axis.daysPerPx, width: (range[1] - range[0]) / axis.daysPerPx, layout,
          layers, seams: query?.seams ?? [], seamCollapsed };
        const base = buildDisplay(model, { ...opts, vantage: null });
        const topPrims = base.top.map(prim), lanePrims = base.lanes.map(prim);
        const topIndex = new Map(base.top.map((p, i) => [p.id, i])), laneIndex = new Map(base.lanes.map((p, i) => [p.id, i]));
        const contentW = opts.width, topH = GEOM.rulerH + GEOM.coverageH;
        const hitBase = {
          top: probes(buildHitGrid(base.top, { group: 'top' }), rand, { w: contentW, h: topH, prims: base.top, index: topIndex, count: PROBES / 2 }),
          lanes: probes(buildHitGrid(base.lanes, { group: 'lanes' }), rand, { w: contentW, h: layout.height, prims: base.lanes, index: laneIndex, count: PROBES / 2 }),
        };
        const sweep = [];
        for (const day of vantageDays) {
          for (const strict of [true, false]) {
            const vantage = { day, strict };
            const d = buildDisplay(model, { ...opts, vantage });
            // per list: the indices of the plain build that this vantage hides, those it ghosts, and any primitive it has
            // that the plain build lacks (full)
            const enc = (list, index, plainCount) => {
              const seen = new Set(), ghost = [], extra = [];
              for (const p of list) {
                const i = index.get(p.id);
                if (i === undefined) { extra.push(prim(p)); continue; }
                seen.add(i);
                if (p.ghost) ghost.push(i);
              }
              const hidden = [];
              for (let i = 0; i < plainCount; i++) if (!seen.has(i)) hidden.push(i);
              return { hidden, ghost, extra };
            };
            const gt = buildHitGrid(d.top, { group: 'top' }), gl = buildHitGrid(d.lanes, { group: 'lanes' });
            // only the probes whose answer differs from the plain build's: {probe index: hits}
            const hitAt = (grid, pr, index) => {
              const changed = {};
              pr.forEach(([x, y, plain], i) => {
                const now = encodeHits(grid.queryAll(x, y, TOL), index);
                if (JSON.stringify(now) !== JSON.stringify(plain)) changed[i] = now;
              });
              return changed;
            };
            sweep.push({ day, strict, top: enc(d.top, topIndex, base.top.length), lanes: enc(d.lanes, laneIndex, base.lanes.length), overBudget: Boolean(d.overBudget),
              texts: d.stats.texts, hits: { top: hitAt(gt, hitBase.top, topIndex), lanes: hitAt(gl, hitBase.lanes, laneIndex) } });
          }
        }
        qcases.push({
          input: q.key, width, askTier, tier, variant, axis: { centerDay: axis.centerDay, daysPerPx: axis.daysPerPx },
          range, visible, marks: marksKey, layers, seamCollapsed, layoutParams,
          out: {
            model: modelSummary(model),
            layout: { height: layout.height, slotH: layout.slotH, more: layout.more,
              lanes: layout.lanes.map((l) => ({ key: l.key, index: l.index, y: l.y, h: l.h, slots: l.slots.map((s) => [s.y, s.h, s.mid]) })) },
            stats: base.stats, overBudget: Boolean(base.overBudget),
            top: topPrims, lanes: lanePrims, hits: hitBase, sweep,
          },
        });
      }
    }
  }
  return { input, qcases };
}

/** viewport.mjs `clampAxis` (pure; copied because viewport.mjs mounts DOM code at import). */
function clampAxis({ centerDay, daysPerPx }, width) {
  const AXIS = { minDay: dayFromYMD(-9999, 1, 1), maxDay: dayFromYMD(2100, 12, 31), minDaysPerPx: 1 / 40, maxDaysPerPx: 365.2425 / 0.05 };
  let dpp = Math.min(AXIS.maxDaysPerPx, Math.max(AXIS.minDaysPerPx, daysPerPx));
  const domain = AXIS.maxDay - AXIS.minDay;
  dpp = Math.min(dpp, domain / width);
  const half = (width / 2) * dpp;
  return { centerDay: Math.min(AXIS.maxDay - half, Math.max(AXIS.minDay + half, centerDay)), daysPerPx: dpp };
}

let generated = null;
const once_ = async (ctx) => (generated ??= generate(ctx));

/**
 * The committed subset: the demo (m1r) at the phone's portrait width, every query and tier. The wider widths and the m5r
 * Cipher query are private (size only: Cipher *machine* draws thousands of marks; nothing in either holds licensed text).
 */
const M1R = new Set(QUERIES.filter((q) => q.snapshot === 'm1r').map((q) => q.key));
const committed = (c) => c.width === 430 && M1R.has(c.input);

export const families = {
  'g5.inputs': {
    owner: 'N7',
    note: 'TimelineQuery, corpora, tiles and marks payloads of the reference server on an m1r clone (inputs of g5.display)',
    run: async (ctx) => (await once_(ctx)).inputs.filter((i) => M1R.has(i.key)),
  },
  'g5.inputs-m5r': {
    owner: 'N7',
    private: true,
    note: 'the same payloads on an m5r clone (Cipher machine; inputs of g5.display-wide)',
    run: async (ctx) => (await once_(ctx)).inputs.filter((i) => !M1R.has(i.key)),
  },
  'g5.display': {
    owner: 'N7',
    note: 'display.mjs buildDisplay + hit.mjs at 430/932/1440 pt × L0–L5 × a 25-vantage sweep (inputs: g5.inputs)',
    run: async (ctx) => (await once_(ctx)).cases.filter(committed),
  },
  'g5.display-wide': {
    owner: 'N7',
    private: true,
    note: 'the demo at 932 and 1440 pt and Cipher machine at every width (private for size only: no licensed text)',
    run: async (ctx) => (await once_(ctx)).cases.filter((c) => !committed(c)),
  },
};
