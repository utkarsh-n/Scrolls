// OWNER: WP6
// shell/presets.mjs — the lane presets of SPEC §1.3 and the Term trail of §10.5 (contract 1.3.0 C2). A Term
// trail follows one word across EVERY real corpus at once — the virtual corpus 'real', which never includes the
// synthetic demo — on a fixed lane set, each lane in its own unit: etymology periods, literature text, STEMM text
// and OpenAlex abstracts per field, culture titles and music relations. Etymology bands, the Wiktionary claim
// marker and the external baseline are switched on with it. Co-presence in two lanes is never drawn as a link.

import { defaultState } from '../../shared/viewstate.mjs';
import { LANE_FACETS } from '../../shared/vocab.mjs';
import { isAbort } from '../core/api.mjs';

/** The virtual corpus of every non-synthetic corpus (C2). */
export const REAL_CORPUS = 'real';
/** The lane facet of the Term trail's fixed lane set (C2). */
export const TRAIL_FACET = 'trail';
export const TRAIL_LABEL = 'Term trail (all real corpora)';
export const TRAIL_CHIP = 'Follow a word from science into culture';
/**
 * Lanes a Term trail asks for: the layout's limit (§1.3: 10 desktop, 5 narrow), never more (fix pass: 24 broke the
 * limits); the Scroll keeps its literature and culture lanes on screen (model.trailShownLanes).
 */
export const TRAIL_MAX_LANES = 10;
/** Words offered by the start chip, in order; the first with matches in every real corpus together is used. */
export const TRAIL_SEEDS = Object.freeze(['virus', 'gene', 'quantum', 'algorithm']);

/** Presets of the lanes menu (§1.3): value → label. `trail` switches the corpus too. */
export const LANE_PRESETS = Object.freeze([
  { id: 'trail', label: TRAIL_LABEL },
  { id: 'domains', label: 'Domains', facet: 'domain' },
  { id: 'languages', label: 'Languages', facet: 'language' },
  { id: 'community', label: 'Community (demo)', facet: 'community', corpus: 'demo' },
]);

/** Does the server know the Term trail's facet (contract ≥ 1.3.0)? */
export const trailFacetKnown = () => LANE_FACETS.includes(TRAIL_FACET);

/**
 * The view state of a Term trail over these strands: corpus 'real', lanes = trail, etymology, claims and the
 * external baseline on; everything else at the corpus defaults (a fresh, reproducible view).
 * @param {object} view the current ViewState (only reducedMotion is kept)
 * @param {Array<{type: string, id: number|string}>} strands strands tracked in the real corpus
 * @returns {object} ViewState
 */
export function trailState(view, strands) {
  const d = defaultState(REAL_CORPUS);
  return {
    ...d, reducedMotion: view?.reducedMotion ?? d.reducedMotion,
    strands: strands.slice(0, 4).map(({ type, id }) => ({ type, id, variants: 'default' })),
    lanes: { ...d.lanes, facet: TRAIL_FACET, max: TRAIL_MAX_LANES },
    layers: { ...d.layers, etymology: 1, claims: 1, baseline: 1 },
  };
}

/**
 * The pinned expression strands a Term trail can follow. In the real corpus an expression is counted across every
 * member corpus with the variants and exclusions it has in each (the server finds its namesakes), so the ids stay;
 * a synthetic (demo) expression never joins a real trail.
 * @param {object} api
 * @param {Array<{type: string, id: number|string}>} strands
 * @returns {Promise<Array<{type: string, id: number|string}>>}
 */
export async function realStrands(api, strands) {
  const out = [];
  for (const s of strands) {
    if (s.type !== 'expression') continue;
    try {
      const e = (await api.get(`/expressions/${encodeURIComponent(s.id)}`, null, { key: `trail-expr-${s.id}` }))?.expression;
      if (e?.synthetic) continue;   // the demo's invented phrases never join a real trail
    } catch (err) {
      if (isAbort(err)) throw err;
    }
    out.push({ type: 'expression', id: s.id });
  }
  return out;
}

/**
 * An expression id for a word in the real corpora: the search's existing expression, else a newly tracked one.
 * @param {object} api
 * @param {{surface: string, ref?: string|null, query?: object|null}} seed
 * @returns {Promise<number>}
 */
export async function trackInReal(api, seed) {
  const m = /^expression:(\d+)$/.exec(seed.ref ?? '');
  if (m) return Number(m[1]);
  const body = { surface: seed.query?.surface ?? seed.surface, kind: seed.query?.kind ?? undefined, lang: seed.query?.lang ?? undefined };
  try {
    return (await api.post('/expressions', { ...body, corpus: REAL_CORPUS })).expression.id;
  } catch (err) {
    if (isAbort(err) || err?.status !== 400) throw err;
    return (await api.post('/expressions', { ...body, corpus: 'cipher' })).expression.id;   // a server that tracks per member corpus
  }
}

/**
 * Find a seed word with matches in the real corpora (one search per word, in order, until one has some).
 * @param {object} api
 * @returns {Promise<{surface: string, count: number, query: object|null}|null>}
 */
export async function trailSeed(api) {
  for (const q of TRAIL_SEEDS) {
    try {
      const r = await api.get('/search', { q, corpus: REAL_CORPUS, scope: 'text', limit: 3 }, { key: `trail-seed-${q}` });
      const s = (r?.suggestions ?? []).find((x) => x.type === 'expression' && Number.isInteger(x.count) && x.count > 0);
      if (s) return { surface: q, count: s.count, query: r.query ?? null, ref: s.ref };
    } catch (err) {
      if (isAbort(err)) throw err;
      if (err?.status === 400 || err?.status === 404) return null;   // a server without the real corpus
    }
  }
  return null;
}

/**
 * Apply the Term trail: re-track the pinned expressions in 'real' (or track `surface`), then load the trail view.
 * With nothing to follow it opens the trail's start card and focuses the search.
 * @param {{store: object, api: object, announce?: Function}} ctx
 * @param {{surface?: string|null, seed?: {surface: string, ref?: string|null, query?: object|null}|null}} [opts]
 * @returns {Promise<void>}
 */
export async function applyTermTrail({ store, api, announce = () => {} }, { surface = null, seed = null } = {}) {
  const view = store.get().view;
  let strands = [];
  if (surface || seed) {
    strands = [{ type: 'expression', id: await trackInReal(api, seed ?? { surface }) }];
  } else {
    strands = await realStrands(api, view.strands);
  }
  store.dispatch({ type: 'LOAD_STATE', state: trailState(store.get().view, strands) });
  if (!strands.length) store.dispatch({ type: 'UI_SET', key: 'focusSearch', value: Date.now() });
  announce(strands.length ? 'Term trail: one word across every real corpus, each lane in its own unit.' : 'Term trail: search a word to follow across every real corpus.');
}

/**
 * Apply a lanes-menu preset.
 * @param {{store: object, api: object, announce?: Function}} ctx
 * @param {string} id LANE_PRESETS id
 */
export async function applyPreset(ctx, id) {
  const p = LANE_PRESETS.find((x) => x.id === id);
  if (!p) return;
  if (p.id === 'trail') { await applyTermTrail(ctx); return; }
  if (p.corpus && ctx.store.get().view.corpus !== p.corpus) ctx.store.dispatch({ type: 'SET_CORPUS', corpus: p.corpus });
  ctx.store.dispatch({ type: 'SET_LANES', lanes: { facet: p.facet } });
}

/** UI module contract (§8): a library of the lanes menu, the start card and the toolbar; nothing to mount. */
export const region = null;
export function mount() { return { unmount() {} }; }
