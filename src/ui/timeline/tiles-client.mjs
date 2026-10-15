// OWNER: WP6
// timeline/tiles-client.mjs — the Scroll's data client (SPEC §8.1, §7.1): registers the canonical query
// (POST /api/timeline/query), fetches tiles (LRU 512, prefetch ±1 viewport, debounce 120 ms, abort on
// supersede) and the individual marks of the occurrence override (≤ 4,000).
//
// A tile the server was asked for and did not return is cached as `null`: loaded, no cells — every bin in it
// is uncovered (§7.2: a bin without a cell is uncovered). A tile never fetched is `undefined`: unknown, drawn
// as "loading", never as absence. If the server answers at a different tier than requested, the answer is
// cached under its own tier and the Scroll draws that tier (labelled), never relabelled as the asked one.

import { isAbort } from '../core/api.mjs';

export const LRU_MAX = 512;
export const DEBOUNCE_MS = 120;
/** Tiles per request (visible first, then prefetch). */
export const MAX_TILES_PER_REQUEST = 16;
/** Delays (ms) before retrying tiles the server could not answer in time (503). */
export const RETRIES = Object.freeze([1500, 4000]);

/**
 * A small LRU over a Map (insertion order = recency).
 * @param {number} max
 */
export function createLru(max = LRU_MAX) {
  const m = new Map();
  return {
    get(k) {
      if (!m.has(k)) return undefined;
      const v = m.get(k);
      m.delete(k);
      m.set(k, v);
      return v;
    },
    peek: (k) => m.get(k),
    has: (k) => m.has(k),
    set(k, v) {
      m.delete(k);
      m.set(k, v);
      while (m.size > max) m.delete(m.keys().next().value);
    },
    delete: (k) => m.delete(k),
    clear: () => m.clear(),
    keys: () => m.keys(),
    get size() { return m.size; },
  };
}

/**
 * The timeline query body (§7.2 TimelineQueryRequest) for a view state.
 * @param {object} view ViewState
 * @param {{maxLanes?: number, formatFilter: (f: object) => string}} opts
 */
export function queryBody(view, { maxLanes = view.lanes.max, formatFilter, cutoffs = null }) {
  const body = {
    strands: view.strands.map((s) => ({ type: s.type, ref: s.id })),
    corpus: view.corpus,
    lanes: { facet: view.lanes.facet, order: view.lanes.order, max: Math.min(view.lanes.max, maxLanes), run: view.lanes.run ?? null },
    f: formatFilter(view.f, { withDefaults: true }),
    toggles: { ...view.toggles },
    timeBasis: view.timeBasis,
  };
  // Pinned counting runs (a saved view opened as saved) and its import cutoff (M1 gate, D17)
  const pinned = view.runs?.materialize ?? {};
  if (Object.keys(pinned).length) body.runs = { materialize: { ...pinned } };
  if (cutoffs && (Number.isInteger(cutoffs.import_batch) || typeof cutoffs.at === 'string')) {
    body.cutoffs = { ...(Number.isInteger(cutoffs.import_batch) ? { import_batch: cutoffs.import_batch } : {}),
      ...(typeof cutoffs.at === 'string' ? { at: cutoffs.at } : {}) };
  }
  return body;
}

/**
 * The arcs parameters of a saved view opened "as saved" (D17, D7): its relationship and annotation revision cutoffs and
 * its pinned quotation and clustering runs, so the Scroll shows the links and reviews of the save, never later ones.
 * @param {{asSaved?: boolean, cutoffs?: object|null, runIds?: object|null}|null} saved ui.savedView
 * @returns {{rel_rev_cutoff?: number, rev_cutoff?: number, runs?: string}|null}
 */
export function arcsAsSaved(saved) {
  if (!saved?.asSaved) return null;
  const c = saved.cutoffs ?? {};
  const runs = [saved.runIds?.quotes, saved.runIds?.cluster].filter((r) => Number.isInteger(r));
  const out = { ...(Number.isInteger(c.relationship_rev) ? { rel_rev_cutoff: c.relationship_rev } : {}),
    ...(Number.isInteger(c.annotation_rev) ? { rev_cutoff: c.annotation_rev } : {}), ...(runs.length ? { runs: runs.join(',') } : {}) };
  return Object.keys(out).length ? out : null;
}

/**
 * Create the data client.
 * @param {{api: object, onChange?: () => void, debounceMs?: number, max?: number, setTimer?: typeof setTimeout,
 *          clearTimer?: typeof clearTimeout, onError?: (err: unknown, what: string) => void}} opts
 */
export function createTilesClient({ api, onChange = () => {}, debounceMs = DEBOUNCE_MS, max = LRU_MAX,
  setTimer = setTimeout, clearTimer = clearTimeout, onError = () => {} }) {
  const cache = createLru(max);
  const answered = new Map();          // `${base}|${askedTier}` → tier the server answered with
  const inflight = new Set();          // cache keys being fetched
  const redirected = new Set();        // asked keys the server answered at another tier
  let base = null;                     // `${queryKey}|${dataVersion}`
  const timers = new Map();            // tier → debounce timer
  const pending = new Map();           // tier → { list, queryKey }
  let marks = null;
  let arcs = null;                     // { key, data }
  let arcsKey = null;                    // { base, fromDay, toDay, items, truncated, total }
  let marksKey = null;
  let lastError = null;

  const key = (tier, tile) => `${base}|${tier}|${tile}`;

  function setQuery(queryKey, dataVersion) {
    const next = queryKey ? `${queryKey}|${dataVersion ?? 0}` : null;
    if (next === base) return false;
    base = next;
    for (const tier of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']) api.abort?.(`tiles-${tier}`);
    api.abort?.('marks');
    api.abort?.('arcs');
    inflight.clear();
    marks = null;
    marksKey = null;
    arcs = null;
    arcsKey = null;
    lastError = null;
    return true;
  }

  /**
   * Loaded tiles of a tier for the current query: tile → tile object or null (loaded, empty).
   * @param {string} tier
   * @returns {Map<number, object|null>}
   */
  function tilesFor(tier) {
    const out = new Map();
    if (!base) return out;
    const prefix = `${base}|${tier}|`;
    for (const k of cache.keys()) if (k.startsWith(prefix)) out.set(Number(k.slice(prefix.length)), cache.peek(k));
    return out;
  }

  /** The tier the server answers for an asked tier (itself until it says otherwise). */
  const tierFor = (tier) => answered.get(`${base}|${tier}`) ?? tier;

  /**
   * Fetch tiles of one tier. A retry (`attempt` > 0) asks again for exactly the tiles it was given, which stayed
   * marked in flight while it waited, so no frame asks for them in between.
   */
  async function fetchTiles(tier, list, queryKey, attempt = 0) {
    const want = attempt ? list : list.filter((t) => !cache.has(key(tier, t)) && !inflight.has(key(tier, t)) && !redirected.has(key(tier, t)))
      .slice(0, MAX_TILES_PER_REQUEST);
    if (!want.length) return;
    const myBase = base;
    for (const t of want) inflight.add(key(tier, t));
    let retrying = false;
    try {
      const res = await api.get('/timeline/tiles', { q: queryKey, tier, tiles: want }, { key: `tiles-${tier}` });
      if (myBase !== base) return;
      const got = res?.tier ?? tier;
      if (got !== tier) {
        answered.set(`${base}|${tier}`, got);
        for (const t of want) redirected.add(key(tier, t));
      }
      for (const tile of res?.tiles ?? []) cache.set(`${base}|${got}|${tile.tile}`, tile);
      // Asked and not returned: loaded with no cells (uncovered), at the tier that was answered.
      if (got === tier) for (const t of want) if (!cache.has(key(tier, t))) cache.set(key(tier, t), null);
      lastError = null;
      onChange();
    } catch (err) {
      if (isAbort(err)) return;
      // A busy read pool (503 QUERY_TIMEOUT) usually clears: try again twice, a little later, before saying so.
      if (err?.status === 503 && attempt < RETRIES.length && myBase === base) {
        retrying = true;
        setTimer(() => {
          for (const t of want) inflight.delete(`${myBase}|${tier}|${t}`);
          if (myBase === base) fetchTiles(tier, want, queryKey, attempt + 1);
        }, RETRIES[attempt]);
        return;
      }
      lastError = err;
      onError(err, 'tiles');
      onChange();
    } finally {
      if (!retrying) for (const t of want) inflight.delete(`${myBase}|${tier}|${t}`);
    }
  }

  /**
   * Ask for tiles (debounced, per tier: the folded overview asks several tiers at once). `visible` tiles are
   * fetched before `prefetch` tiles.
   * @param {{tier: string, visible: number[], prefetch?: number[], immediate?: boolean}} req
   */
  function request({ tier, visible, prefetch = [], immediate = false }) {
    if (!base) return;
    const queryKey = base.split('|')[0];
    const need = (t) => !cache.has(key(tier, t)) && !inflight.has(key(tier, t)) && !redirected.has(key(tier, t));
    const list = [...visible, ...prefetch.filter((t) => !visible.includes(t))].filter(need);
    if (timers.has(tier)) { clearTimer(timers.get(tier)); timers.delete(tier); }
    if (!list.length) { pending.delete(tier); return; }
    pending.set(tier, { tier, list, queryKey });
    const run = () => { timers.delete(tier); const p = pending.get(tier); pending.delete(tier); if (p) fetchTiles(p.tier, p.list, p.queryKey); };
    if (immediate) run(); else timers.set(tier, setTimer(run, debounceMs));
  }

  /**
   * Fetch the individual marks of [fromDay, toDay] (whole years are asked; ≤ 4,000).
   * @param {{fromDay: number, toDay: number, fromYear: number, toYear: number}} range
   */
  async function requestMarks({ fromDay, toDay, fromYear, toYear }) {
    if (!base) return;
    const k = `${base}|${fromYear}|${toYear}`;
    if (marksKey === k) return;
    marksKey = k;
    const myBase = base;
    try {
      const res = await api.get('/timeline/marks', { q: base.split('|')[0], from: fromYear, to: toYear, limit: 4000 }, { key: 'marks' });
      if (myBase !== base || marksKey !== k) return;
      marks = { fromDay, toDay, items: res?.marks ?? [], truncated: Boolean(res?.truncated), total: res?.total ?? 0 };
      onChange();
    } catch (err) {
      if (isAbort(err)) return;
      if (marksKey === k) marksKey = null;
      onError(err, 'marks');
    }
  }

  /**
   * Fetch the arcs of a year range (GET /api/timeline/arcs: individual arcs, or a summary with ≤ 300 individual
   * arcs beyond 1,500 links — contract 1.3.0 C4). `detail: 1` (a range narrower than 50 years) asks for individual
   * arcs up to 1,500. The vantage is applied by the client (strict hides, context ghosts), so scrubbing never refetches.
   * `sel` (document:<id> · passage:<id> · occurrence:<id>) lets a summary draw the links touching the selection; it is
   * part of the request only while the answer is a summary, so a selection never refetches individual arcs.
   * `lanes` (the lane keys shown; folded lanes left out) ranks the arcs between shown lanes first; it changes only with
   * the query, so it is not part of the request key.
   * `saved` (arcsAsSaved) reads a saved view as saved: its revision cutoffs and pinned runs.
   * @param {{fromYear: number, toYear: number, ev: string, tier: string, detail?: 0|1, sel?: string|null, lanes?: string[]|null,
   *   saved?: object|null}} req
   */
  async function requestArcs({ fromYear, toYear, ev, tier, detail = 0, sel = null, lanes = null, saved = null }, attempt = 0) {
    if (!base) return;
    const useSel = sel && arcs?.data?.mode === 'summary' ? sel : null;
    const k = `${base}|${fromYear}|${toYear}|${ev}|${tier}|${detail ? 1 : 0}|${useSel ?? ''}|${saved ? JSON.stringify(saved) : ''}`;
    if (arcsKey === k && !attempt) return;
    arcsKey = k;
    const myBase = base;
    try {
      const params = { q: base.split('|')[0], from: fromYear, to: toYear, ev, tier, limit: detail ? 1500 : 300 };
      if (detail) params.detail = 1;
      if (useSel) params.sel = useSel;
      if (Array.isArray(lanes) && lanes.length && lanes.length <= 200) params.lanes = lanes.join(',');
      if (saved) Object.assign(params, saved);
      const res = ev ? await api.get('/timeline/arcs', params, { key: 'arcs' })
        : { total: 0, returned: 0, hidden: {}, items: [], bundles: [] };
      if (myBase !== base || arcsKey !== k) return;
      arcs = { key: k, fromYear, toYear, data: res };
      onChange();
    } catch (err) {
      if (isAbort(err)) return;
      // A busy read pool (503) usually clears: ask again twice, later, before saying so (as for tiles).
      if (err?.status === 503 && attempt < RETRIES.length && myBase === base && arcsKey === k) {
        setTimer(() => { if (arcsKey === k && myBase === base) requestArcs({ fromYear, toYear, ev, tier, detail, sel, lanes, saved }, attempt + 1); }, RETRIES[attempt]);
        return;
      }
      if (arcsKey === k) arcsKey = null;
      onError(err, 'arcs');
    }
  }

  return {
    setQuery, tilesFor, tierFor, request, requestMarks, requestArcs,
    get marks() { return marks; },
    get arcs() { return arcs; },
    get error() { return lastError; },
    get loading() { return inflight.size > 0 || pending.size > 0; },
    get size() { return cache.size; },
    clear() { cache.clear(); answered.clear(); redirected.clear(); marks = null; marksKey = null; arcs = null; arcsKey = null; },
    dispose() {
      for (const t of timers.values()) clearTimer(t);
      timers.clear();
      for (const tier of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']) api.abort?.(`tiles-${tier}`);
      api.abort?.('marks');
      api.abort?.('arcs');
    },
  };
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
