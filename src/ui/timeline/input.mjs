// OWNER: WP6
// timeline/input.mjs — mouse, wheel and trackpad → Scroll actions (SPEC §1.5, §8.5). The pure functions
// below turn events into actions; attachPointer() wires them to the overlay canvas. Touch is gestures.mjs.
//
// Wheel: a pinch (ctrlKey wheel on trackpads) or a vertical wheel zooms around the pointer; a horizontal
// swipe or Shift+wheel pans. Drag pans (inertia off in reduced motion). A press becomes a pan only once it has
// moved ≥ 4 px AND lasted ≥ 150 ms (or moved ≥ 12 px at once): a slightly shaky click on a 1 px mark still
// selects it instead of nudging the Scroll.

/** Pixels per wheel line / page (deltaMode 1 / 2). */
const LINE_PX = 16;
/** Zoom sensitivity per wheel pixel (mouse wheel) and per pinch pixel (trackpad, ctrlKey). */
export const WHEEL_ZOOM = 0.0016;
export const PINCH_ZOOM = 0.01;
/** A press that moves less than this is a click, not a drag. */
export const CLICK_SLOP = 4;
/** …and one that moves more but ends sooner than this is still a click, unless it moved FLICK_PX. */
export const CLICK_MS = 150;
export const FLICK_PX = 12;

/**
 * Capture a pointer; a pointer that is no longer active (a synthetic or already-cancelled event) is ignored
 * instead of throwing NotFoundError into the page.
 * @param {Element} el
 * @param {number} pointerId
 */
export function capturePointer(el, pointerId) {
  try { el.setPointerCapture?.(pointerId); } catch { /* pointer not active */ }
}

/**
 * Has a press turned into a drag? (pure; the rule of the header comment)
 * @param {number} distPx distance from the press point
 * @param {number} elapsedMs time since the press
 * @returns {boolean}
 */
export function isDrag(distPx, elapsedMs) {
  return distPx >= FLICK_PX || (distPx >= CLICK_SLOP && elapsedMs >= CLICK_MS);
}
/** Velocity decay per frame of inertial panning. */
export const INERTIA_DECAY = 0.92;

/**
 * Wheel deltas in pixels.
 * @param {{deltaX: number, deltaY: number, deltaMode?: number}} evt
 * @param {number} [pageHeight=800]
 * @returns {{dx: number, dy: number}}
 */
export function normalizeWheel(evt, pageHeight = 800) {
  const k = evt.deltaMode === 1 ? LINE_PX : evt.deltaMode === 2 ? pageHeight : 1;
  return { dx: (evt.deltaX || 0) * k, dy: (evt.deltaY || 0) * k };
}

/**
 * What a wheel event does.
 * @param {{deltaX: number, deltaY: number, deltaMode?: number, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean}} evt
 * @returns {{type: 'zoom', factor: number} | {type: 'pan', dx: number} | {type: 'scrollY', dy: number} | {type: 'none'}}
 *   factor > 1 zooms in (fewer days per pixel)
 */
export function wheelAction(evt) {
  const { dx, dy } = normalizeWheel(evt);
  if (evt.altKey) return dy ? { type: 'scrollY', dy } : { type: 'none' };
  if (evt.ctrlKey || evt.metaKey) return dy ? { type: 'zoom', factor: Math.exp(-dy * PINCH_ZOOM) } : { type: 'none' };
  if (evt.shiftKey) return (dy || dx) ? { type: 'pan', dx: dy || dx } : { type: 'none' };
  if (Math.abs(dx) > Math.abs(dy)) return { type: 'pan', dx };
  return dy ? { type: 'zoom', factor: Math.exp(-dy * WHEEL_ZOOM) } : { type: 'none' };
}

/**
 * Attach mouse/pen pointer handling (drag pan, click, hover) to an element. Touch pointers are left to
 * gestures.mjs.
 * @param {HTMLElement} el
 * @param {{
 *   onPan(dxPx: number): void, onPanEnd(): void, onClick(x: number, y: number, evt: PointerEvent): void,
 *   onHover(x: number|null, y: number|null): void, onWheel(action: ReturnType<typeof wheelAction>, x: number, y: number): void,
 *   reducedMotion(): boolean, onDoubleClick?(x: number, y: number): void
 * }} h
 * @returns {() => void} detach
 */
export function attachPointer(el, h) {
  let drag = null;
  let raf = 0;
  let hoverRaf = 0;
  let hoverPos = null;
  const local = (e) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  const onDown = (e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    cancelAnimationFrame(raf);
    const [x, y] = local(e);
    const now = performance.now();
    drag = { id: e.pointerId, x0: x, y0: y, x, t: now, t0: now, v: 0, moved: false };
    capturePointer(el, e.pointerId);
  };
  const onMove = (e) => {
    if (e.pointerType === 'touch') return;
    const [x, y] = local(e);
    if (drag && e.pointerId === drag.id) {
      if (!drag.moved) {
        if (!isDrag(Math.hypot(x - drag.x0, y - drag.y0), performance.now() - drag.t0)) return;
        drag.moved = true;
        el.classList.add('is-dragging');
        drag.x = drag.x0;   // the pan starts with the whole distance already travelled
      }
      const dx = x - drag.x;
      if (dx) {
        const now = performance.now();
        drag.v = dx / Math.max(1, now - drag.t);
        drag.t = now;
        h.onPan(dx);
      }
      drag.x = x;
      return;
    }
    hoverPos = [x, y];
    if (!hoverRaf) hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; if (hoverPos) h.onHover(...hoverPos); });
  };
  const onUp = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    el.classList.remove('is-dragging');
    if (!d.moved) { h.onClick(d.x0, d.y0, e); return; }
    // Inertia: keep panning with a decaying velocity (px/ms), unless reduced motion.
    let v = d.v * 16;
    if (h.reducedMotion() || Math.abs(v) < 0.5) { h.onPanEnd(); return; }
    const step = () => {
      v *= INERTIA_DECAY;
      if (Math.abs(v) < 0.4) { h.onPanEnd(); return; }
      h.onPan(v);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };
  const onLeave = () => { hoverPos = null; h.onHover(null, null); };
  const onWheel = (e) => {
    const action = wheelAction(e);
    if (action.type === 'none') return;
    e.preventDefault();
    cancelAnimationFrame(raf);
    const [x, y] = local(e);
    h.onWheel(action, x, y);
  };
  const onDbl = (e) => { const [x, y] = local(e); h.onDoubleClick?.(x, y); };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('dblclick', onDbl);
  return () => {
    cancelAnimationFrame(raf);
    cancelAnimationFrame(hoverRaf);
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('dblclick', onDbl);
  };
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
