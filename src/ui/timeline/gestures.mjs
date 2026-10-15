// OWNER: WP6
// timeline/gestures.mjs — touch on the Scroll (SPEC §8.6), with Pointer Events: one-finger horizontal drag
// pans (inertia off in reduced motion), vertical drag scrolls the lanes, pinch zooms x only around the
// midpoint, tap selects, long-press (500 ms) opens the action sheet, double-tap zooms in one tier, two-finger
// tap zooms out. createRecognizer() is pure (fake clock in tests); attachTouch() wires it to an element.

import { capturePointer } from './input.mjs';

export const LONG_PRESS_MS = 500;
export const DOUBLE_TAP_MS = 300;
export const TAP_SLOP = 10;
/** A drag commits to an axis once it has moved this far. */
export const AXIS_LOCK_PX = 8;

/**
 * @typedef {{
 *   onPan?(dx: number): void, onPanEnd?(): void, onScrollY?(dy: number): void,
 *   onPinch?(factor: number, midX: number): void, onPinchEnd?(): void,
 *   onTap?(x: number, y: number): void, onDoubleTap?(x: number, y: number): void,
 *   onLongPress?(x: number, y: number): void, onTwoFingerTap?(midX: number): void
 * }} GestureHandlers
 */

/**
 * A touch gesture recognizer.
 * @param {GestureHandlers & {setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout}} h
 */
export function createRecognizer(h) {
  const setTimer = h.setTimer ?? setTimeout;
  const clearTimer = h.clearTimer ?? clearTimeout;
  const pts = new Map();
  let mode = null;                  // null | 'pending' | 'pan' | 'scroll' | 'pinch' | 'long'
  let start = null;                 // { x, y, t }
  let longTimer = null;
  let lastTap = null;               // { x, y, t }
  let pinch = null;                 // { dist, mid, moved, t }

  const clearLong = () => { if (longTimer) { clearTimer(longTimer); longTimer = null; } };
  const two = () => [...pts.values()];
  const dist = ([a, b]) => Math.hypot(a.x - b.x, a.y - b.y);
  const midX = ([a, b]) => (a.x + b.x) / 2;

  return {
    down(id, x, y, t) {
      pts.set(id, { x, y, lx: x, ly: y });
      if (pts.size === 1) {
        mode = 'pending';
        start = { x, y, t };
        clearLong();
        longTimer = setTimer(() => { longTimer = null; if (mode === 'pending') { mode = 'long'; h.onLongPress?.(x, y); } }, LONG_PRESS_MS);
      } else if (pts.size === 2) {
        clearLong();
        if (mode === 'pan') h.onPanEnd?.();
        mode = 'pinch';
        const p = two();
        pinch = { dist: Math.max(1, dist(p)), mid: midX(p), moved: false, t };
      }
    },
    move(id, x, y) {
      const p = pts.get(id);
      if (!p) return;
      const dx = x - p.lx, dy = y - p.ly;
      p.lx = x; p.ly = y; p.x = x; p.y = y;
      if (mode === 'pending') {
        const tx = x - start.x, ty = y - start.y;
        if (Math.hypot(tx, ty) < AXIS_LOCK_PX) return;
        clearLong();
        mode = Math.abs(tx) >= Math.abs(ty) ? 'pan' : 'scroll';
        if (mode === 'pan') h.onPan?.(tx); else h.onScrollY?.(-ty);
        return;
      }
      if (mode === 'pan') h.onPan?.(dx);
      else if (mode === 'scroll') h.onScrollY?.(-dy);
      else if (mode === 'pinch' && pts.size === 2) {
        const pp = two();
        const d = Math.max(1, dist(pp));
        const factor = d / pinch.dist;
        if (Math.abs(factor - 1) > 0.02 || pinch.moved) {
          pinch.moved = true;
          h.onPinch?.(factor, midX(pp));
          pinch.dist = d;
        }
      }
    },
    up(id, x, y, t) {
      if (!pts.has(id)) return;
      pts.delete(id);
      clearLong();
      if (mode === 'pinch') {
        if (pts.size === 0) {
          if (!pinch.moved && t - pinch.t < 300) h.onTwoFingerTap?.(pinch.mid); else h.onPinchEnd?.();
          mode = null;
        }
        return;
      }
      if (pts.size) return;
      if (mode === 'pan') h.onPanEnd?.();
      else if (mode === 'pending' && Math.hypot(x - start.x, y - start.y) < TAP_SLOP) {
        if (lastTap && t - lastTap.t < DOUBLE_TAP_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < TAP_SLOP * 2) {
          lastTap = null;
          h.onDoubleTap?.(x, y);
        } else {
          lastTap = { x, y, t };
          h.onTap?.(x, y);
        }
      }
      mode = null;
    },
    cancel(id) {
      pts.delete(id);
      clearLong();
      if (!pts.size) { if (mode === 'pan') h.onPanEnd?.(); mode = null; }
    },
    get mode() { return mode; },
  };
}

/**
 * Wire touch pointers of an element to a recognizer.
 * @param {HTMLElement} el
 * @param {GestureHandlers} handlers
 * @returns {() => void} detach
 */
export function attachTouch(el, handlers) {
  const r = createRecognizer(handlers);
  const local = (e) => { const b = el.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  const only = (fn) => (e) => { if (e.pointerType !== 'touch') return; e.preventDefault(); fn(e); };
  const down = only((e) => { capturePointer(el, e.pointerId); const [x, y] = local(e); r.down(e.pointerId, x, y, e.timeStamp); });
  const move = only((e) => { const [x, y] = local(e); r.move(e.pointerId, x, y, e.timeStamp); });
  const up = only((e) => { const [x, y] = local(e); r.up(e.pointerId, x, y, e.timeStamp); });
  const cancel = only((e) => r.cancel(e.pointerId));
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
  };
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
