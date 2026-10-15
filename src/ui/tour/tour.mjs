// OWNER: WP6
// tour/tour.mjs — the demo tour (SPEC §1.11, §9.7) and the Scroll's start card.
//
// · First launch opens the synthetic demo with its first strand pinned — the strand comes from the tour's
//   step 1 state served by /api/tour (data/demo/tour.json, ids resolved), never from an id hard-coded here.
// · The guided tour: ten steps (action · what you see · what it shows) in a non-modal card; "Show me" loads the
//   step's view state. Esc closes it. The Tour button (toolbar / More) opens it and re-arms the coach marks.
// · Start chips: with no strand pinned the Scroll offers places to start — only chips whose data exists in the
//   loaded corpus, each checked against the server (search counts, theme tags, a genealogy with links).

import { decodeHash } from '../../shared/viewstate.mjs';
import { formatCount } from '../../shared/format.mjs';
import { h, clear } from '../core/dom.mjs';
import { isAbort } from '../core/api.mjs';
import { applyTermTrail, REAL_CORPUS, TRAIL_CHIP, trailFacetKnown, trailSeed } from '../shell/presets.mjs';

/** localStorage key: the first-60-seconds coach marks were dismissed (§1.11; per-viewer convenience). */
export const TOUR_DISMISSED_KEY = 'scrolls.tour.dismissed';

/**
 * Was the tour dismissed in this browser? Storage that throws counts as "not dismissed" (§1.11: fail safe to
 * showing the tour).
 * @param {Storage|null} [storage]
 */
export function tourDismissed(storage = globalThis.localStorage ?? null) {
  try { return storage?.getItem(TOUR_DISMISSED_KEY) === '1'; } catch { return false; }
}

/** Remember (or forget) the dismissal; storage errors are ignored. */
export function setTourDismissed(value, storage = globalThis.localStorage ?? null) {
  try { if (value) storage?.setItem(TOUR_DISMISSED_KEY, '1'); else storage?.removeItem(TOUR_DISMISSED_KEY); } catch { /* private mode */ }
}

/**
 * The strands to seed from a tour: step 1's state, when the current view is the demo with none pinned.
 * @param {{steps: Array<{n: number, state?: string}>}|null} tour
 * @param {{corpus: string, strands: object[]}} view
 * @returns {Array<{type: string, id: number|string}>}
 */
export function seedStrands(tour, view) {
  if (view.corpus !== 'demo' || view.strands.length) return [];
  const step = (tour?.steps ?? []).find((s) => s.n === 1) ?? tour?.steps?.[0];
  if (!step?.state) return [];
  const { state } = decodeHash(step.state);
  return state.corpus === 'demo' ? state.strands.map(({ type, id }) => ({ type, id })) : [];
}

/**
 * Candidate start points per corpus (§1.11 final card, QA: "virus · zero · sample · hip hop (theme) · Rapper's
 * Delight (genealogy)"). Each is offered only when the server confirms it has data.
 */
export const START_CANDIDATES = Object.freeze({
  cipher: Object.freeze([
    { kind: 'trail' },
    { kind: 'expression', q: 'virus' }, { kind: 'expression', q: 'zero' }, { kind: 'expression', q: 'sample' },
    { kind: 'theme', q: 'hip hop' }, { kind: 'genealogy', q: "Rapper's Delight" },
  ]),
  stemm: Object.freeze([{ kind: 'trail' }, { kind: 'expression', q: 'gene' }, { kind: 'expression', q: 'quantum' }, { kind: 'expression', q: 'algorithm' }]),
  // The virtual corpus of every real corpus (contract 1.3.0 C2): the Term trail first.
  real: Object.freeze([{ kind: 'trail' }, { kind: 'expression', q: 'virus' }, { kind: 'expression', q: 'gene' }, { kind: 'expression', q: 'zero' }]),
});

const chipCache = new Map();

/**
 * Check one candidate against the server; null when it has no data here.
 * @returns {Promise<{kind: string, label: string, corpus: string, count: number|null, suggestion?: object, work?: number, theme?: string}|null>}
 */
async function checkCandidate(api, corpus, c) {
  if (c.kind === 'trail') {
    // "Follow a word from science into culture": offered only when the server knows the Term trail and one of the
    // seed words has matches across the real corpora.
    if (!trailFacetKnown()) return null;
    const seed = await trailSeed(api);
    return seed ? { kind: 'trail', label: TRAIL_CHIP, corpus: REAL_CORPUS, count: seed.count, surface: seed.surface, seed } : null;
  }
  if (c.kind === 'expression') {
    const r = await api.get('/search', { q: c.q, corpus, scope: 'text', limit: 3 }, { key: `start-${corpus}-${c.q}` });
    const s = (r?.suggestions ?? []).find((x) => x.type === 'expression' && Number.isInteger(x.count) && x.count > 0);
    return s ? { kind: 'expression', label: c.q, corpus, count: s.count, suggestion: s, query: r.query } : null;
  }
  if (c.kind === 'theme') {
    const r = await api.get('/search', { q: c.q, corpus, scope: 'themes', limit: 5 }, { key: `start-${corpus}-t-${c.q}` });
    const s = (r?.suggestions ?? []).find((x) => x.type === 'theme' && x.count > 0 && /^theme:/.test(x.ref) && x.ref.slice(6).startsWith(c.q));
    return s ? { kind: 'theme', label: `${s.ref.slice(6)} (theme)`, corpus, count: s.count, theme: s.ref.slice(6) } : null;
  }
  if (c.kind === 'genealogy') {
    const r = await api.get('/search', { q: c.q, corpus, scope: 'works', limit: 3 }, { key: `start-${corpus}-w-${c.q}` });
    const s = (r?.suggestions ?? []).find((x) => x.type === 'work' && /^document:\d+$/.test(x.ref));
    if (!s) return null;
    const g = await api.get('/genealogy', { work: s.ref, dir: 'forward', depth: 1, max: 1 }, { key: `start-${corpus}-g-${c.q}` });
    const total = (g?.generations ?? []).reduce((n, gen) => n + (gen.total ?? 0), 0);
    return total > 0 ? { kind: 'genealogy', label: `${c.q} (genealogy)`, corpus, count: total, work: Number(s.ref.slice(9)) } : null;
  }
  return null;
}

/**
 * Start chips for a corpus: the demo's come from the tour's strands; Cipher's from START_CANDIDATES, each
 * checked one after the other (gentle on the read pool; `onChip` shows each as soon as it is confirmed).
 * Cached per corpus for the session.
 * @param {object} api
 * @param {string} corpus
 * @param {{onChip?: (chips: object[]) => void}} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function startChips(api, corpus, { onChip = null } = {}) {
  if (chipCache.has(corpus)) return chipCache.get(corpus);
  const run = (async () => {
    if (corpus === 'demo') {
      const tour = await api.get('/tour', null, { key: 'start-tour' });
      const seen = new Map();
      for (const step of tour?.steps ?? []) {
        const st = step.state ? decodeHash(step.state).state : null;
        if (st?.corpus !== 'demo') continue;
        for (const s of st.strands) if (s.type === 'expression' && !seen.has(s.id)) seen.set(s.id, s);
      }
      const out = [];
      for (const s of seen.values()) {
        const e = await api.get(`/expressions/${encodeURIComponent(s.id)}`, null, { key: `start-expr-${s.id}` });
        const n = e?.state?.n ?? null;
        if (e?.expression?.surface && n !== 0) out.push({ kind: 'expression', label: e.expression.surface, corpus, count: n, strand: { type: 'expression', id: s.id } });
      }
      return out;
    }
    const out = [];
    for (const c of START_CANDIDATES[corpus] ?? []) {
      let chip = null;
      for (let attempt = 0; attempt < 2 && !chip; attempt++) {
        try { chip = await checkCandidate(api, corpus, c); break; } catch (err) {
          if (isAbort(err)) throw err;
          if (err?.status !== 503) break;   // a busy read pool: one more try, then leave the chip out
        }
      }
      if (chip) { out.push(chip); onChip?.([...out]); }
    }
    return out;
  })();
  chipCache.set(corpus, run);
  try { return await run; } catch (err) { chipCache.delete(corpus); throw err; }
}

/**
 * Do what a start chip says: pin an expression (tracking it first when new), pin a theme, or open a work's
 * genealogy. Switches corpus first when the chip belongs to another corpus.
 * @param {{store: object, api: object, announce?: Function}} ctx
 * @param {object} chip
 */
export async function chipAction({ store, api, announce = () => {} }, chip) {
  if (chip.kind === 'trail') { await applyTermTrail({ store, api, announce }, { seed: chip.seed ?? { surface: chip.surface } }); return; }
  if (store.get().view.corpus !== chip.corpus) store.dispatch({ type: 'SET_CORPUS', corpus: chip.corpus });
  if (chip.kind === 'expression') {
    let strand = chip.strand ?? null;
    const ref = chip.suggestion?.ref ?? '';
    if (!strand && /^expression:\d+$/.test(ref)) strand = { type: 'expression', id: Number(ref.slice(11)) };
    if (!strand) {
      const res = await api.post('/expressions', { surface: chip.query?.surface ?? chip.label, kind: chip.query?.kind ?? undefined, corpus: chip.corpus });
      strand = { type: 'expression', id: res.expression.id };
    }
    store.dispatch({ type: 'PIN_STRAND', strand });
    announce(`Pinned ${chip.label}.`);
  } else if (chip.kind === 'theme') {
    store.dispatch({ type: 'PIN_STRAND', strand: { type: 'theme', id: chip.theme } });
    announce(`Pinned the theme ${chip.theme}.`);
  } else if (chip.kind === 'genealogy') {
    store.dispatch({ type: 'SET_LINEAGE', lineage: { root: `document:${chip.work}` } });
    store.dispatch({ type: 'OPEN_PANEL', panel: 'genealogy' });
    announce(`Opening the genealogy of ${chip.label.replace(/ \(genealogy\)$/, '')}.`);
  }
}

/**
 * The start card of the Scroll (no strand pinned): a welcome, not an error (§8.8 empty states).
 * @param {{corpus: string, chips: object[]|null, error?: string|null, onChip: (chip: object) => void, onSearch: () => void}} o
 * @returns {HTMLElement}
 */
export function renderStartCard({ corpus, chips, pending = false, error = null, onChip, onSearch }) {
  const list = h('span.start-chips');
  if (chips === null) list.append(h('span.meta', null, 'checking what this corpus holds…'));
  else if (!chips.length && !pending) list.append(h('span.meta', null, error ? `(${error})` : 'nothing suggested for this corpus yet'));
  chips?.forEach((c, i) => {
    if (i) list.append(h('span.start-sep', { 'aria-hidden': 'true' }, ' · '));
    const title = c.kind === 'trail' ? `Term trail of '${c.surface}' across every real corpus (${formatCount(c.count)} matches) — the demo is never in it`
      : c.count !== null && c.count !== undefined ? `${formatCount(c.count)} ${c.kind === 'genealogy' ? 'documented links' : c.kind === 'theme' ? 'tagged works' : 'matches'}` : '';
    list.append(h(`button.start-chip${c.kind === 'trail' ? '.start-chip-trail' : ''}`, { type: 'button', title, onClick: () => onChip(c) }, c.label));
  });
  if (chips?.length && pending) list.append(h('span.meta', null, ' · checking…'));
  return h('div.start-card', null,
    h('p.state-title', null, corpus === 'demo' ? 'Pin a strand to draw it' : 'Where would you like to start?'),
    h('p.start-line', null, h('button.start-search', { type: 'button', onClick: onSearch }, 'Search a word, phrase, work, maker or theme'), ' — or start from: ', list),
    corpus === REAL_CORPUS ? h('p.state-hint', null, 'All real corpora together: Cipher, the STEMM sources and your imports — never the synthetic demo.') : null,
    h('p.state-hint', null, 'Until a strand is pinned the lanes show only each collection’s dated span and size: nothing is counted yet.'));
}

/**
 * The guided tour card (10 steps, §9.7).
 * @param {HTMLElement} el this module's slot in #tour
 * @param {{store: object, api: object, keys: object, announce: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api, announce } = ctx;
  let done = false;
  let tour = null;
  const hashHasStrands = /(?:^|[#&])s=/.test(globalThis.location?.hash ?? '');
  const loadTour = () => api.get('/tour', null, { key: 'tour' }).then((t) => { tour = t; return t; });
  if (!hashHasStrands) {
    loadTour().then((t) => {
      if (done) return;
      for (const strand of seedStrands(t, store.get().view)) store.dispatch({ type: 'PIN_STRAND', strand });
    }).catch((err) => { if (!isAbort(err)) { /* no tour (demo not loaded yet): the Scroll shows its start card */ } });
  }

  const card = h('section.tour-card', { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'tour-title', hidden: true });
  el.appendChild(card);

  const state = () => store.get().ui.tour ?? null;
  const setStep = (n) => store.dispatch({ type: 'UI_SET', key: 'tour', value: { open: true, step: n } });
  const close = () => store.dispatch({ type: 'UI_SET', key: 'tour', value: null });

  function render() {
    const st = state();
    clear(card);
    card.hidden = !st?.open;
    if (!st?.open) return;
    if (!tour) {
      card.append(h('p.meta', null, 'Loading the tour…'));
      loadTour().then(render).catch((err) => { if (!isAbort(err)) { clear(card); card.append(h('p', null, err.message), h('button.btn', { type: 'button', onClick: close }, 'Close')); } });
      return;
    }
    const steps = tour.steps ?? [];
    const i = Math.max(0, Math.min(steps.length - 1, (st.step ?? 1) - 1));
    const step = steps[i];
    card.classList.toggle('syn-frame', step.synthetic !== false);
    card.append(...[
      h('div.tour-head', null,
        h('h2#tour-title.tour-title', null, `Guided tour · step ${i + 1} of ${steps.length}`),
        step.synthetic !== false ? h('span.badge.badge-syn', null, 'SYN') : null,
        h('button.btn.tour-close', { type: 'button', 'aria-label': 'Close the tour (Esc)', onClick: close }, '×')),
      h('p.tour-action', null, h('strong', null, 'Do: '), step.action),
      h('p.tour-see', null, h('strong', null, 'You see: '), step.see),
      h('p.tour-learn', null, h('strong', null, 'It shows: '), step.learn),
      h('div.tour-actions', null,
        h('button.btn', { type: 'button', disabled: i === 0, onClick: () => setStep(i) }, 'Back'),
        h('button.btn.btn-primary', { type: 'button', onClick: () => showMe(step) }, 'Show me'),
        h('button.btn', { type: 'button', disabled: i === steps.length - 1, onClick: () => setStep(i + 2) }, 'Next')),
      h('p.meta.tour-time', null, `About ${tour.minutes ?? 4} minutes in all; steps 1–3 are the first minute.`)].filter(Boolean));
    announce(`Tour step ${i + 1} of ${steps.length}: ${step.action}`);
  }

  function showMe(step) {
    if (!step?.state) return;
    const { state: next } = decodeHash(step.state);
    store.dispatch({ type: 'LOAD_STATE', state: next });
    const anchor = step.anchor ? document.querySelector(step.anchor) : null;
    if (anchor) {
      anchor.classList.add('tour-flash');
      setTimeout(() => anchor.classList.remove('tour-flash'), 1600);
    }
  }

  const onKey = (e) => {
    if (e.key !== 'Escape' || card.hidden) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);
  const unsub = store.subscribe((s) => s.ui.tour, render, { immediate: true });
  return { unmount() { done = true; unsub(); document.removeEventListener('keydown', onKey, true); card.remove(); } };
}
