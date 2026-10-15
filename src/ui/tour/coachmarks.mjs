// OWNER: WP6
// tour/coachmarks.mjs — the first 60 seconds (SPEC §1.11): three coach marks and a last card on the synthetic
// demo, anchored to what is actually drawn (the first lane's earliest bar, a documented and a computed arc, the
// Play button). Non-blocking (only the card takes pointer events), Esc or × dismisses them, and they never
// return unless the user clicks Tour (localStorage, try/catch; when storage fails they show again: fail safe).
// The wording is §1.11's; names and years in it come from the data on screen, never from this file.

import { formatCount } from '../../shared/format.mjs';
import { h, clear } from '../core/dom.mjs';
import { isAbort } from '../core/api.mjs';
import { cipherOpenable } from '../shell/toolbar.mjs';
import { scrollHub } from '../timeline/viewport.mjs';
import { chipAction, setTourDismissed, startChips, tourDismissed } from './tour.mjs';

/** When each coach mark appears (ms after the previous one; §1.11: ~2 s, ~12 s, ~40 s, 55–60 s). */
// final: how long coach ③ ("Press ▶") waits for Play before the "Your turn." card (§1.11: ③ at ≈ 40 s, the card at 55–60 s);
// once Play starts it waits for the play to end instead (fix pass: the card no longer cut the beat short)
export const COACH_DELAYS = Object.freeze({ first: 2000, second: 10000, third: 14000, final: 20000 });

const words = (t) => String(t ?? 'link').replace(/_/g, ' ');

/** Open panels a coach mark must never cover (M5 gate): docked inspector, right panel, drawer, cards, sheets, menus. */
// The regions themselves can span the screen while empty (narrow: #panel is a fixed full-screen layer), so the
// panels inside them are measured.
export const PANEL_SELECTORS = Object.freeze(['#inspector:not([data-dock="closed"]) > .slot > :not([hidden])', '#panel > .slot > :not([hidden])',
  '.drawer:not([hidden])', '.arc-card:not([hidden])',
  '.tour-card:not([hidden])', '.lanes-sheet:not([hidden])', '.lane-sheet:not([hidden])', '.more-pop:not([hidden])', '.filters-pop:not([hidden])',
  '.legend-full:not([hidden])', '.search-pop:not([hidden])', '.scroll-actions:not([hidden])']);

const overlaps = (a, b, pad = 6) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/**
 * Where a coach card of size {w, h} can go without covering any open panel: the first candidate inside the viewport
 * that overlaps none of `panels`, or null (then the card waits until the panels close).
 * @param {Array<{x: number, y: number}>} candidates top-left corners, in order of preference
 * @param {{w: number, h: number}} size
 * @param {Array<{x: number, y: number, w: number, h: number}>} panels
 * @param {{w: number, h: number}} vp viewport
 * @returns {{x: number, y: number}|null}
 */
export function coachPlacement(candidates, size, panels, vp) {
  for (const c of candidates) {
    const x = Math.max(8, Math.min(c.x, vp.w - size.w - 8)), y = Math.max(8, Math.min(c.y, vp.h - size.h - 8));
    const box = { x, y, w: size.w, h: size.h };
    if (!panels.some((p) => overlaps(box, p))) return { x, y };
  }
  return null;
}

/**
 * The words of a coach mark (§1.11), filled from the data on screen.
 * @param {1|2|3|4} stage
 * @param {{label?: string, doc?: object|null, calc?: object|null, health?: object|null}} data
 * @returns {{title: string|null, lines: Array<string|{strong: string}|Array<string|{strong: string}>>}}
 */
export function coachCopy(stage, { label = 'the phrase', doc = null, calc = null, health = null } = {}) {
  if (stage === 1) {
    return { title: null, lines: [[`Bars span where '${label}' was `, { strong: 'observed' }, '. Gaps are real: dotted = looked and found none; hatched = no sources.']] };
  }
  if (stage === 2) {
    const arcLine = (it, badge, how) => (it ? `${badge} — ${it.src.y} ${words(it.rel_type)} → ${it.dst.y}: ${how(it)}` : null);
    return {
      title: null,
      lines: [
        arcLine(doc, 'DOC', (it) => `${it.source ? `${it.source}` : 'a documented record'}${it.synthetic ? ' (synthetic)' : ''}`),
        arcLine(calc, 'CALC', (it) => `computed by text matching${Number.isInteger(it.run_id) ? ` (run #${it.run_id})` : ''}`),
        'Line style = evidence. Click any mark to read its source.',
      ].filter(Boolean),
    };
  }
  if (stage === 3) return { title: null, lines: ['Press ▶ to watch the phrase acquire history.'] };
  const c = health?.cipher;
  const status = !c ? 'Waiting for the local server.'
    : c.status === 'ready' ? 'Cipher titles, relations, etymology and full text are ready.'
      : c.status === 'fulltext' ? `Cipher titles, relations and etymology ready · ${c.message ?? 'full text indexing'}`
        : c.status === 'metadata' || c.status === 'queued' ? `Cipher: importing titles & relations${Number.isFinite(c.progress) ? ` · ${Math.round(c.progress * 100)}%` : ''}`
          : c.message ?? `Cipher: ${c.status}`;
  return { title: 'Your turn.', lines: [status] };
}

function line(l) {
  if (typeof l === 'string') return h('p.coach-line', null, l);
  const parts = Array.isArray(l) ? l : [l];
  return h('p.coach-line', null, parts.map((p) => (typeof p === 'string' ? p : h('strong', null, p.strong))));
}

/**
 * @param {HTMLElement} el this module's slot in #tour
 * @param {{store: object, api: object, announce: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api, announce } = ctx;
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const card = h('section.coach', { role: 'note', 'aria-live': 'polite', hidden: true });
  const marks = h('div.coach-marks', { 'aria-hidden': 'true' });
  el.append(marks, card);
  let stage = 0;
  let timer = 0;
  let armed = false;
  let sawPlay = false;
  let chips = null;

  const later = (ms, fn) => { win.clearTimeout(timer); timer = win.setTimeout(fn, ms); };
  const isDemo = () => store.get().view.corpus === 'demo';

  function dismiss() {
    win.clearTimeout(timer);
    stage = 0;
    paused = false;
    marks.hidden = false;
    card.hidden = true;
    clear(marks);
    setTourDismissed(true);
  }

  function go(next) {
    stage = next;
    if (stage === 0 || stage > 4 || !isDemo()) { dismiss(); return; }
    setTourDismissed(true);   // shown once: it never returns unless Tour is clicked
    // The next stage's timer is set before rendering, so a card that must wait for a panel to close pauses it.
    if (stage === 1) later(COACH_DELAYS.second, () => go(2));
    else if (stage === 2) later(COACH_DELAYS.third, () => go(3));
    else if (stage === 3) later(COACH_DELAYS.final, () => go(4));
    else if (stage === 4) {
      win.clearTimeout(timer);
      store.dispatch({ type: 'UI_SET', key: 'focusSearch', value: { at: Date.now(), source: 'tour' } });
      if (cipherOpenable(store.get().ui.health) && chips === null) {
        chips = [];
        startChips(api, 'cipher').then((list) => { chips = list.filter((c) => c.kind === 'expression').slice(0, 3); if (stage === 4) render(); })
          .catch((err) => { if (!isAbort(err)) chips = []; });
      }
    }
    render();
  }

  function anchorRect() {
    if (stage === 1) return scrollHub.actions.locate?.('first-bar');
    if (stage === 2) return scrollHub.actions.locate?.('arc:documented') ?? scrollHub.actions.locate?.('arc:computed');
    if (stage === 3) {
      const b = doc.querySelector(doc.documentElement.dataset.layout === 'narrow' ? '.narrow-bar .nb-btn:nth-child(2)' : '#toolbar .tb-play');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    return null;
  }

  function render() {
    clear(card);
    clear(marks);
    if (!stage) { card.hidden = true; return; }
    const st = scrollHub.get();
    const label = st.model?.strands?.[0]?.label ?? 'the phrase';
    const docArc = stage === 2 ? scrollHub.actions.locate?.('arc:documented') : null;
    const calcArc = stage === 2 ? scrollHub.actions.locate?.('arc:computed') : null;
    const copy = coachCopy(stage, { label, doc: docArc?.item ?? null, calc: calcArc?.item ?? null, health: store.get().ui.health });
    card.dataset.stage = String(stage);
    card.classList.toggle('coach-final', stage === 4);
    card.append(...[
      h('div.coach-head', null, h('span.coach-step', null, stage < 4 ? `${stage} of 3` : 'first minute'),
        h('button.coach-close', { type: 'button', 'aria-label': 'Dismiss the coach marks (Esc)', onClick: dismiss }, '×')),
      copy.title ? h('p.coach-title', null, copy.title) : null,
      ...copy.lines.map(line)].filter(Boolean));
    if (stage === 4) {
      const cipherOk = cipherOpenable(store.get().ui.health);
      const row = h('div.coach-chips');
      for (const c of chips ?? []) {
        row.append(h('button.start-chip', { type: 'button', title: c.count ? `${formatCount(c.count)} matches in Cipher` : '', onClick: () => { dismiss(); chipAction(ctx, c).catch(() => {}); } }, c.label));
      }
      row.append(h('button.btn.btn-primary', { type: 'button', disabled: !cipherOk, onClick: () => { dismiss(); store.dispatch({ type: 'SET_CORPUS', corpus: 'cipher' }); } }, 'Switch to Cipher (real data)'));
      card.append(row, h('div.coach-actions', null,
        h('button.btn', { type: 'button', onClick: () => { dismiss(); store.dispatch({ type: 'UI_SET', key: 'tour', value: { open: true, step: 1 } }); } }, 'Full tour (4 min)'),
        h('button.btn', { type: 'button', onClick: dismiss }, 'Close')));
    } else {
      card.append(h('div.coach-actions', null, h('button.btn', { type: 'button', onClick: () => go(stage + 1) }, 'Next')));
    }
    card.hidden = false;
    placeMarks();
    position();
    announce(copy.lines.map((l) => (typeof l === 'string' ? l : (Array.isArray(l) ? l : [l]).map((p) => (typeof p === 'string' ? p : p.strong)).join(''))).join(' '));
  }

  /** Small rings on the two arcs of coach ②, each with its badge word; they follow the Scroll as it pans. */
  function placeMarks() {
    clear(marks);
    if (stage !== 2) return;
    for (const [what, badge] of [['arc:documented', 'DOC'], ['arc:computed', 'CALC']]) {
      const a = scrollHub.actions.locate?.(what);
      if (!a) continue;
      marks.append(h('span.coach-ring', { style: { left: `${Math.round(a.x)}px`, top: `${Math.round(a.y)}px` } }, h('span.coach-ring-label', null, badge)));
    }
  }

  /** Rectangles of the panels that are open now (never covered by a coach mark). */
  function openPanels() {
    const out = [];
    for (const sel of PANEL_SELECTORS) {
      for (const n of doc.querySelectorAll(sel)) {
        if (n === card || card.contains(n)) continue;
        const r = n.getBoundingClientRect();
        if (r.width >= 8 && r.height >= 8 && win.getComputedStyle(n).display !== 'none' && win.getComputedStyle(n).visibility !== 'hidden') {
          out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
        }
      }
    }
    return out;
  }

  /**
   * Place the card beside its anchor, or wherever no open panel is covered; when every place would cover a
   * panel the card waits (hidden, its timer paused) until the panel closes.
   */
  function position() {
    if (!stage) return;
    const vw = win.innerWidth, vh = win.innerHeight;
    const w = Math.min(stage === 4 ? 440 : 340, vw - 16);
    card.style.width = `${w}px`;
    const size = { w, h: card.offsetHeight || 140 };
    const a = anchorRect();
    const scroll = doc.getElementById('scroll')?.getBoundingClientRect();
    const cands = [];
    if (stage === 4 || !a) {
      if (scroll) cands.push({ x: scroll.left + (scroll.width - w) / 2, y: scroll.top + 64 }, { x: scroll.left + 16, y: scroll.top + 64 }, { x: scroll.right - w - 16, y: scroll.top + 64 });
      else cands.push({ x: (vw - w) / 2, y: 96 });
    } else if (stage === 3) {
      const narrow = doc.documentElement.dataset.layout === 'narrow';
      cands.push({ x: Math.max(8, a.x - 20), y: narrow ? a.y - size.h - 12 : a.y + a.h + 10 });
    } else {
      cands.push({ x: a.x + a.w + 14, y: a.y - 8 }, { x: a.x - w - 14, y: a.y - 8 }, { x: a.x - w / 2, y: a.y + a.h + 12 }, { x: a.x - w / 2, y: a.y - size.h - 12 });
    }
    if (scroll) cands.push({ x: scroll.left + 16, y: scroll.bottom - size.h - 16 }, { x: scroll.right - w - 16, y: scroll.bottom - size.h - 16 });
    const at = coachPlacement(cands, size, openPanels(), { w: vw, h: vh });
    if (!at) { pause(); return; }
    resume();
    card.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
  }

  // Paused while a panel leaves no room: the card is hidden and its stage timer waits (§1.11: non-blocking).
  let paused = false;
  function pause() {
    card.hidden = true;
    marks.hidden = true;
    if (paused) return;
    paused = true;
    win.clearTimeout(timer);
  }
  function resume() {
    if (!paused) { card.hidden = false; return; }
    paused = false;
    card.hidden = false;
    marks.hidden = false;
    if (stage === 1) later(COACH_DELAYS.second, () => go(2));
    else if (stage === 2) later(COACH_DELAYS.third, () => go(3));
    else if (stage === 3) later(COACH_DELAYS.final, () => go(4));
  }

  /** Start once the demo's bars are drawn (§1.11: coach ① at ≈ 2 s). */
  function arm() {
    if (armed || stage || !isDemo() || tourDismissed()) return;
    const st = scrollHub.get();
    if (st.status !== 'ready' || !st.model?.lanes?.some((l) => l.strands.some((s) => s.bars.length))) return;
    armed = true;
    later(COACH_DELAYS.first, () => go(1));
  }

  const unsubHub = scrollHub.subscribe((st) => {
    arm();
    if (stage === 3 && st.playing && !sawPlay) { sawPlay = true; win.clearTimeout(timer); }
    if (stage === 3 && sawPlay && !st.playing) { sawPlay = false; go(4); return; }
    if (stage && stage < 4) { placeMarks(); position(); }
  });
  const unsubSel = store.subscribe((s) => s.view.selection, (sel) => {
    // Coach ② says "click any mark": opening a passage moves on to ③.
    if (stage === 2 && (sel?.type === 'occurrence' || sel?.type === 'passage')) later(1200, () => go(3));
  });
  const unsubCoach = store.subscribe((s) => s.ui.coach, (c) => {
    if (!c?.replay) return;
    armed = false;
    stage = 0;
    chips = null;
    if (isDemo()) arm(); else store.dispatch({ type: 'SET_CORPUS', corpus: 'demo' });
  });
  const unsubCorpus = store.subscribe((s) => s.view.corpus, () => { if (!isDemo() && stage) { stage = 0; card.hidden = true; clear(marks); win.clearTimeout(timer); } });
  // Panels open and close through the store (inspector, right panel, drawer, tour card): re-place the card each time.
  const unsubPanels = store.subscribe((s) => [s.view.panels, s.view.selection, s.ui.drawer, s.ui.tour, s.ui.lanesOpen, s.ui.filtersOpen, s.ui.sheet],
    () => { if (stage) win.requestAnimationFrame(() => { if (stage) { placeMarks(); position(); } }); },
    { equals: (a, b) => a.every((x, i) => x === b[i]) });
  const panelObserver = typeof win.MutationObserver === 'function' ? new win.MutationObserver(() => { if (stage) position(); }) : null;
  for (const id of ['inspector', 'panel', 'sheet']) { const n = doc.getElementById(id); if (n) panelObserver?.observe(n, { attributes: true, childList: true, subtree: false }); }
  const onKey = (e) => {
    if (e.key !== 'Escape' || !stage) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    dismiss();
    announce('Coach marks dismissed. The Tour button brings them back.');
  };
  doc.addEventListener('keydown', onKey, true);
  const onResize = () => position();
  win.addEventListener('resize', onResize);
  return {
    unmount() {
      win.clearTimeout(timer);
      unsubHub(); unsubSel(); unsubCoach(); unsubCorpus(); unsubPanels(); panelObserver?.disconnect();
      doc.removeEventListener('keydown', onKey, true);
      win.removeEventListener('resize', onResize);
      card.remove(); marks.remove();
    },
  };
}
