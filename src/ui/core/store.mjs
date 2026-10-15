// OWNER: WP0 — the app store: the reproducible ViewState plus transient UI state (SPEC §8.2, §12.2)
//
// AppState = { view: ViewState, ui }. Only `view` reaches the URL and saved views. Every view action ends
// in viewstate.canonicalize(), so `view` is always valid and canonical; an action with an invalid value is
// refused (its warnings go to ui.warnings) instead of resetting that setting to a default. Unchanged
// branches keep their object identity (structural sharing), so `subscribe(s => s.view.lanes, …)` fires
// only when lanes change.
// Note for the timeline: canonical axis values are rounded (integer centerDay, 6 significant digits of
// daysPerPx) — keep sub-day pan offsets in the viewport and commit them to the store when a gesture ends.

import { canonicalJson } from '../../shared/ids.mjs';
import { canonicalize, defaultState, parseFilter, MAX_STRANDS, REDUCED_MOTION } from '../../shared/viewstate.mjs';
import {
  CONSTELLATION_SIZES, FILTER_KEYS, LANE_FACETS, LANE_ORDERS, RIGHT_PANELS, SELECTION_TYPES, TIERS, TIME_BASES,
} from '../../shared/vocab.mjs';

/**
 * Actions that change the view (§12.2 list, plus SET_TIME_BASIS, SET_CONSTELLATION, SET_LINEAGE, SET_AS_SAVED).
 * Payloads:
 *   SET_CORPUS {corpus} — resets the view to that corpus's defaults (keeps reducedMotion)
 *   PIN_STRAND {strand: {type, id, variants?}} · UNPIN_STRAND {index} | {id, strandType?}
 *   SET_LANES {lanes: Partial<lanes>} · SET_FILTER {f: string|Partial<f>} | {key, values|value}
 *   SET_TOGGLE {key, value?} (no value = flip) · SET_AXIS {axis: Partial<axis>|{mode:'folded'}} · SET_TIER {tier}
 *   SET_VANTAGE {day?, strict?, toggleStrict?} · SET_RANGE {range: [loDay, hiDay]|null}
 *   SET_EVIDENCE {evidence: Partial<evidence>} | {cycle: true} · SET_LAYER {layer, value?} | {layers}
 *   SELECT {selection: {type, id}|null} · OPEN_PANEL {panel: 'inspector'|RIGHT_PANELS[n], mode?}
 *   CLOSE_PANEL {panel?: 'inspector'|'right'|RIGHT_PANELS[n]} · SET_COMPARE {compare|null} | {slice: 'a'|'b', years, f?}
 *   SET_RUNS {runs: Partial<runs>} · LOAD_STATE {state, savedView?} · SET_REDUCED_MOTION {value: 'system'|'on'|'off'}
 *   SET_TIME_BASIS {timeBasis} · SET_CONSTELLATION {constellation} · SET_LINEAGE {lineage} · SET_AS_SAVED {value}
 */
export const VIEW_ACTIONS = Object.freeze(['SET_CORPUS', 'PIN_STRAND', 'UNPIN_STRAND', 'SET_LANES', 'SET_FILTER',
  'SET_TOGGLE', 'SET_AXIS', 'SET_TIER', 'SET_VANTAGE', 'SET_RANGE', 'SET_EVIDENCE', 'SET_LAYER', 'SELECT',
  'OPEN_PANEL', 'CLOSE_PANEL', 'SET_COMPARE', 'SET_RUNS', 'LOAD_STATE', 'SET_REDUCED_MOTION', 'SET_TIME_BASIS',
  'SET_CONSTELLATION', 'SET_LINEAGE', 'SET_AS_SAVED']);
/** UI actions (never reach the URL). */
export const UI_ACTIONS = Object.freeze(['UI_HOVER', 'UI_TOAST', 'UI_DISMISS_TOAST', 'UI_JOB', 'UI_JOBS', 'UI_COACH',
  'UI_SHEET', 'UI_HEALTH', 'UI_DATA_VERSION', 'UI_SET']);
export const MAX_TOASTS = 5;

const VIEW_ACTION_SET = new Set(VIEW_ACTIONS);
const TERMINAL_JOB_STATUS = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const flip = (bit) => (bit ? 0 : 1);
const asList = (x) => (Array.isArray(x) ? x : x === undefined || x === null || x === '' ? [] : [x]);
const isBit = (x) => x === undefined || x === 0 || x === 1 || x === true || x === false;

/**
 * Why an action's enumerated value is invalid, or null. canonicalize() would silently replace such a value
 * with the corpus default; the store refuses the action instead, so a bad payload never resets a setting.
 */
function invalidValue(a) {
  const notIn = (value, list, what) => (value !== undefined && !list.includes(value) ? `${a.type}: ${what} '${value}' is not one of ${list.join(', ')}` : null);
  switch (a.type) {
    case 'SET_LANES':
      return notIn(a.lanes?.facet, LANE_FACETS, 'facet') ?? notIn(a.lanes?.order, LANE_ORDERS, 'order')
        ?? (a.lanes?.sub === null ? null : notIn(a.lanes?.sub, LANE_FACETS, 'sub-facet'));
    case 'SET_TIER': return notIn(a.tier, ['auto', ...TIERS], 'tier');
    case 'SET_TIME_BASIS': return notIn(a.timeBasis, TIME_BASES, 'time basis');
    case 'SET_REDUCED_MOTION': return notIn(a.value, REDUCED_MOTION, 'reduced motion');
    case 'SET_AXIS': return notIn(a.axis?.mode, ['linear', 'folded'], 'axis mode');
    case 'SELECT': return a.selection ? notIn(a.selection.type, SELECTION_TYPES, 'selection type') : null;
    case 'SET_CONSTELLATION': return notIn(a.constellation?.size, CONSTELLATION_SIZES, 'size');
    case 'SET_TOGGLE': case 'SET_LAYER': return isBit(a.value) ? null : `${a.type}: value must be 0 or 1`;
    default: return null;
  }
}

/**
 * The initial transient UI state. `hover`, `toasts`, `jobs`, `coach` and `sheet` are the §12.2 keys; the
 * rest are additive: server `health` and `dataVersion`, the Compare slice being assembled (`compareDraft`),
 * the saved view currently shown (`savedView`), and the warnings of the last view repair.
 * @returns {{hover: unknown, toasts: object[], toastSeq: number, jobs: Record<string, object>, coach: unknown,
 *            sheet: unknown, health: object|null, dataVersion: number|null,
 *            compareDraft: {a: object|null, b: object|null}, savedView: {slug: string, asSaved: boolean, stateHash?: string}|null,
 *            warnings: string[]}}
 */
export function initialUi() {
  return {
    hover: null, toasts: [], toastSeq: 0, jobs: {}, coach: null, sheet: null,
    health: null, dataVersion: null, compareDraft: { a: null, b: null }, savedView: null, warnings: [],
  };
}

/**
 * Reuse `prev` (or its branches) wherever `next` is deeply equal, so identity tracks change.
 * @template T
 * @param {T} prev
 * @param {T} next
 * @returns {T}
 */
export function share(prev, next) {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length !== next.length) return next;
    const out = next.map((x, i) => share(prev[i], x));
    return out.every((x, i) => x === prev[i]) ? prev : out;
  }
  if (isObj(prev) && isObj(next)) {
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(prev).length;
    const out = {};
    for (const k of keys) {
      out[k] = share(prev[k], next[k]);
      if (out[k] !== prev[k] || !(k in prev)) same = false;
    }
    return same ? prev : out;
  }
  return next;
}

/** E cycles the evidence filter: all → documented + computed → documented → all (§8.5). */
function cycleEvidence(ev) {
  if (ev.documented && ev.computed && ev.proposed) return { ...ev, proposed: 0 };
  if (ev.documented && ev.computed) return { ...ev, computed: 0, proposed: 0 };
  return { ...ev, documented: 1, computed: 1, proposed: 1 };
}

function setFilter(v, a) {
  if (typeof a.f === 'string') return parseFilter(a.f);
  if (isObj(a.f)) return { ...v.f, ...a.f };
  if (!FILTER_KEYS.includes(a.key)) return v.f;
  if (a.key === 'syn') return { ...v.f, syn: a.value === undefined ? flip(v.f.syn) : a.value };
  return { ...v.f, [a.key]: asList(a.values ?? a.value) };
}

function openPanel(panels, a) {
  if (a.panel === 'inspector') return { ...panels, inspector: a.mode ?? 'tnn' };
  return RIGHT_PANELS.includes(a.panel) ? { ...panels, right: a.panel } : panels;
}

function closePanel(panels, a) {
  if (a.panel === 'inspector') return { ...panels, inspector: null };
  if (a.panel === 'right' || RIGHT_PANELS.includes(a.panel)) {
    return a.panel === 'right' || panels.right === a.panel ? { ...panels, right: null } : panels;
  }
  // No panel named: close the right panel first, then the inspector (Esc semantics).
  return panels.right ? { ...panels, right: null } : { ...panels, inspector: null };
}

/**
 * Apply a view action to a view (not yet canonical). Unknown or malformed payloads leave the view as is;
 * canonicalize() repairs whatever remains invalid.
 * @param {import('../../shared/viewstate.mjs').ViewState} v
 * @param {{type: string} & Record<string, any>} a
 */
function applyView(v, a) {
  switch (a.type) {
    case 'SET_CORPUS': return { ...defaultState(a.corpus), reducedMotion: v.reducedMotion };
    case 'PIN_STRAND': {
      const s = a.strand;
      if (!isObj(s) || v.strands.some((x) => x.type === s.type && String(x.id) === String(s.id))) return v;
      return { ...v, strands: [...v.strands, { variants: 'default', ...s }] };
    }
    case 'UNPIN_STRAND': {
      const keep = (x, i) => (Number.isInteger(a.index) ? i !== a.index
        : !(x.id !== undefined && String(x.id) === String(a.id) && (a.strandType === undefined || x.type === a.strandType)));
      // Glyphs follow position, so drop them and let canonicalize reassign.
      return { ...v, strands: v.strands.filter(keep).map(({ glyph, ...rest }) => rest) };
    }
    case 'SET_LANES': return isObj(a.lanes) ? { ...v, lanes: { ...v.lanes, ...a.lanes } } : v;
    case 'SET_FILTER': return { ...v, f: setFilter(v, a) };
    case 'SET_TOGGLE':
      if (!(a.key in v.toggles)) return v;
      return { ...v, toggles: { ...v.toggles, [a.key]: a.value === undefined ? flip(v.toggles[a.key]) : a.value } };
    case 'SET_AXIS': {
      if (!isObj(a.axis)) return v;
      if (a.axis.mode === 'folded') return { ...v, axis: { mode: 'folded' } };
      const base = v.axis.mode === 'linear' ? v.axis : defaultState(v.corpus).axis;
      return { ...v, axis: { ...base, ...a.axis, mode: 'linear' } };
    }
    case 'SET_TIER': return { ...v, tier: a.tier };
    case 'SET_VANTAGE': {
      const next = { ...v.vantage };
      if (a.day !== undefined) next.day = a.day;
      if (a.strict !== undefined) next.strict = a.strict;
      if (a.toggleStrict) next.strict = !v.vantage.strict;
      return { ...v, vantage: next };
    }
    case 'SET_RANGE': return { ...v, range: a.range ?? null };
    case 'SET_EVIDENCE':
      return { ...v, evidence: a.cycle ? cycleEvidence(v.evidence) : isObj(a.evidence) ? { ...v.evidence, ...a.evidence } : v.evidence };
    case 'SET_LAYER':
      if (isObj(a.layers)) return { ...v, layers: { ...v.layers, ...a.layers } };
      if (!(a.layer in v.layers)) return v;
      return { ...v, layers: { ...v.layers, [a.layer]: a.value === undefined ? flip(v.layers[a.layer]) : a.value } };
    case 'SELECT': return { ...v, selection: a.selection ?? null };
    case 'OPEN_PANEL': return { ...v, panels: openPanel(v.panels, a) };
    case 'CLOSE_PANEL': return { ...v, panels: closePanel(v.panels, a) };
    case 'SET_COMPARE': return { ...v, compare: a.compare ?? null };
    case 'SET_RUNS': {
      if (!isObj(a.runs)) return v;
      const materialize = isObj(a.runs.materialize) ? { ...v.runs.materialize, ...a.runs.materialize } : v.runs.materialize;
      return { ...v, runs: { ...v.runs, ...a.runs, materialize } };
    }
    // a loaded state (URL, saved view) never changes the viewer's reduced-motion setting (§8.2, fix pass)
    case 'LOAD_STATE': return { ...a.state, reducedMotion: v.reducedMotion };
    case 'SET_REDUCED_MOTION': return { ...v, reducedMotion: a.value };
    case 'SET_TIME_BASIS': return { ...v, timeBasis: a.timeBasis };
    case 'SET_CONSTELLATION': return isObj(a.constellation) ? { ...v, constellation: { ...v.constellation, ...a.constellation } } : v;
    case 'SET_LINEAGE': return isObj(a.lineage) ? { ...v, lineage: { ...v.lineage, ...a.lineage } } : v;
    case 'SET_AS_SAVED': return { ...v, asSaved: Boolean(a.value) };
    default: return v;
  }
}

/** Merge a Job row, a JobProgressEvent or a JobDoneEvent (§7.2) into the job map. */
function upsertJob(jobs, input) {
  if (!isObj(input)) return jobs;
  const id = input.id ?? input.job;
  if (!Number.isInteger(id)) return jobs;
  const prev = jobs[id] ?? { id, type: null, status: 'queued', progress: 0, phase: null, message: null };
  const next = { ...prev, ...input, id };
  delete next.job;
  if (typeof input.fraction === 'number') {
    next.progress = input.fraction;
    if (!input.status) next.status = 'running';
    delete next.fraction;
  }
  if (input.status === 'succeeded') next.progress = 1;
  // A finished job keeps no stale "counting… 63%" message from its last progress event.
  if (TERMINAL_JOB_STATUS.has(input.status) && input.message === undefined) next.message = null;
  return share(jobs, { ...jobs, [id]: next });
}

/** Set one UI key, keeping `ui` itself when the value is deeply unchanged (hover fires every pointer frame). */
function setKey(ui, key, value) {
  const next = share(ui[key], value);
  return next === ui[key] && key in ui ? ui : { ...ui, [key]: next };
}

function pushToast(ui, toast) {
  if (!isObj(toast) || !toast.text) return ui;
  const kind = toast.kind ?? 'info';
  if (ui.toasts.some((t) => t.text === toast.text && t.kind === kind)) return ui;
  const id = ui.toastSeq + 1;
  return { ...ui, toastSeq: id, toasts: [...ui.toasts, { ...toast, kind, id }].slice(-MAX_TOASTS) };
}

/**
 * Pure reducer of the transient UI state.
 * @param {ReturnType<typeof initialUi>} ui
 * @param {{type: string} & Record<string, any>} a
 */
export function reduceUi(ui, a) {
  switch (a.type) {
    case 'UI_HOVER': return setKey(ui, 'hover', a.hover ?? null);
    case 'UI_TOAST': return pushToast(ui, a.toast);
    case 'UI_DISMISS_TOAST': {
      const toasts = ui.toasts.filter((t) => t.id !== a.id);
      return toasts.length === ui.toasts.length ? ui : { ...ui, toasts };
    }
    case 'UI_JOB': {
      const jobs = upsertJob(ui.jobs, a.job);
      return jobs === ui.jobs ? ui : { ...ui, jobs };
    }
    case 'UI_JOBS': {
      let jobs = {};
      for (const j of asList(a.jobs)) jobs = upsertJob(jobs, j);
      return setKey(ui, 'jobs', jobs);
    }
    case 'UI_COACH': return setKey(ui, 'coach', a.coach ?? null);
    case 'UI_SHEET': return setKey(ui, 'sheet', a.sheet ?? null);
    case 'UI_HEALTH': {
      const health = a.health ?? null;
      const dataVersion = Number.isInteger(health?.dataVersion) ? health.dataVersion : ui.dataVersion;
      return setKey(setKey(ui, 'health', health), 'dataVersion', dataVersion);
    }
    case 'UI_DATA_VERSION': return Number.isInteger(a.dataVersion) ? setKey(ui, 'dataVersion', a.dataVersion) : ui;
    case 'UI_SET': return typeof a.key === 'string' ? setKey(ui, a.key, a.value) : ui;
    default: return ui;
  }
}

/**
 * Pure reducer of the whole AppState. View actions are canonicalized; UI actions go to reduceUi.
 * `SET_COMPARE` with `{slice: 'a'|'b', years, f}` assembles a slice in `ui.compareDraft` and sets
 * `view.compare` once both slices exist. `LOAD_STATE` may carry `savedView` (`{slug, asSaved, stateHash}`).
 * `PIN_STRAND` beyond four strands is refused with a toast.
 * @param {{view: object, ui: object}} state
 * @param {{type: string} & Record<string, any>} action
 */
export function reduce(state, action) {
  if (!isObj(action) || typeof action.type !== 'string') return state;
  if (action.type.startsWith('UI_')) {
    const ui = reduceUi(state.ui, action);
    return ui === state.ui ? state : { ...state, ui };
  }
  if (!VIEW_ACTION_SET.has(action.type)) return state;

  let ui = state.ui;
  let act = action;
  if (action.type === 'SET_COMPARE' && (action.slice === 'a' || action.slice === 'b')) {
    const draft = { ...ui.compareDraft, [action.slice]: { years: action.years, f: action.f ?? '' } };
    ui = setKey(ui, 'compareDraft', draft);
    if (!(draft.a && draft.b)) return ui === state.ui ? state : { ...state, ui };
    act = { type: 'SET_COMPARE', compare: draft };
  }
  if (action.type === 'PIN_STRAND' && state.view.strands.length >= MAX_STRANDS
      && !state.view.strands.some((x) => x.type === action.strand?.type && String(x.id) === String(action.strand?.id))) {
    const refused = pushToast(ui, { kind: 'warn', text: `At most ${MAX_STRANDS} strands can be pinned; unpin one first.` });
    return refused === state.ui ? state : { ...state, ui: refused };
  }

  const replaces = action.type === 'LOAD_STATE' || action.type === 'SET_CORPUS';
  const bad = invalidValue(act);
  const warnings = bad ? [bad] : [];
  const candidate = bad ? state.view : canonicalize(applyView(state.view, act), warnings);
  // An action carrying an invalid value is refused rather than half-applied (canonicalize would reset the
  // field to its default); a loaded state (URL, saved view) is always applied, repaired.
  if (warnings.length && !replaces) {
    const refused = setKey(ui, 'warnings', warnings);
    return refused === state.ui ? state : { ...state, ui: refused };
  }
  const view = share(state.view, candidate);
  if (replaces) {
    ui = setKey(setKey(ui, 'savedView', action.savedView ?? null), 'compareDraft', view.compare ?? { a: null, b: null });
  } else if (action.type === 'SET_COMPARE' && !view.compare) {
    ui = setKey(ui, 'compareDraft', { a: null, b: null });
  }
  ui = setKey(ui, 'warnings', warnings);
  return view === state.view && ui === state.ui ? state : { view, ui };
}

/**
 * @typedef {{ view: import('../../shared/viewstate.mjs').ViewState, ui: ReturnType<typeof initialUi> }} AppState
 * @typedef {{
 *   get(): AppState,
 *   dispatch(action: {type: string} & Record<string, any>): void,
 *   subscribe<T>(selector: (s: AppState) => T, fn: (next: T, prev: T, state: AppState) => void,
 *                opts?: { equals?: (a: T, b: T) => boolean, immediate?: boolean }): () => void
 * }} Store
 */

/**
 * Create the store. Dispatch is synchronous; a dispatch made from inside a subscriber is queued and runs
 * after the current notification round. A throwing subscriber is reported and does not stop the others.
 * @param {import('../../shared/viewstate.mjs').ViewState} [initial] defaults to defaultState('demo')
 * @param {{ onError?: (err: unknown, where: string) => void }} [opts]
 * @returns {Store}
 */
export function createStore(initial, { onError = (err, where) => console.error(`[scrolls] store ${where}:`, err) } = {}) {
  let state = { view: canonicalize(initial ?? defaultState()), ui: initialUi() };
  const subs = new Set();
  const queue = [];
  let dispatching = false;

  function notify() {
    for (const s of [...subs]) {
      if (!subs.has(s)) continue;
      let next;
      try { next = s.selector(state); } catch (err) { onError(err, 'selector'); continue; }
      if (s.equals(next, s.last)) continue;
      const prev = s.last;
      s.last = next;
      try { s.fn(next, prev, state); } catch (err) { onError(err, 'subscriber'); }
    }
  }

  return {
    get: () => state,

    dispatch(action) {
      queue.push(action);
      if (dispatching) return;
      dispatching = true;
      try {
        while (queue.length) {
          const prev = state;
          try { state = reduce(state, queue.shift()); } catch (err) { onError(err, 'reducer'); continue; }
          if (state !== prev) notify();
        }
      } finally {
        dispatching = false;
      }
    },

    subscribe(selector, fn, { equals = Object.is, immediate = false } = {}) {
      const s = { selector, fn, equals, last: selector(state) };
      subs.add(s);
      if (immediate) {
        try { fn(s.last, undefined, state); } catch (err) { onError(err, 'subscriber'); }
      }
      return () => { subs.delete(s); };
    },
  };
}

/** Deep equality for subscribe({ equals }) on small JSON values. */
export const jsonEqual = (a, b) => a === b || canonicalJson(a) === canonicalJson(b);
