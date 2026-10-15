// OWNER: WP6
// timeline/paint.mjs — the Canvas 2D painter of the display list (SPEC §8.3): four stacked layers (bg, data,
// arcs, overlay), devicePixelRatio ≤ 2, CanvasPatterns created once per context, culling to the viewport.
// The legend draws its swatches with paintPrim(), so a legend row and a mark on the Scroll are the same code.
//
// Colours come from the CSS tokens (tokens.css) read at runtime, so forced-colors and future token changes
// reach the canvas; the fallbacks equal the token values of §8.7.

import { seamCaptionPlace } from './seams.mjs';

/** Token fallbacks (tokens.css, §8.7). */
export const FALLBACK = Object.freeze({
  'bg-0': '#0E1013', 'bg-1': '#161A20', 'bg-2': '#1F242C', 'bg-3': '#2A303A', rule: '#343A45',
  ink: '#EDE6D6', 'ink-2': '#BDB5A5', 'ink-3': '#8E887B', cyan: '#4FD8E8', amber: '#E8A84A', violet: '#B59AF5',
  danger: '#F2826F', ok: '#7BD389', syn: '#D9CFB8',
  'font-ui': 'system-ui, -apple-system, "SF Pro Text", "Segoe UI", sans-serif',
  'font-num': 'ui-monospace, "SF Mono", Menlo, monospace',
});

/** Maximum backing-store scale (§8.3: DPR ≤ 2). */
export const MAX_DPR = 2;
/** Bars narrower than this (px) are painted in batches, without rounded corners or glow (invisible at that width). */
const BATCH_W = 6;

/**
 * Read the palette from CSS custom properties on an element (falls back per token).
 * @param {Element|null} el
 * @returns {Record<string, string>}
 */
export function readPalette(el) {
  const out = { ...FALLBACK };
  if (!el || typeof getComputedStyle !== 'function') return out;
  const cs = getComputedStyle(el);
  for (const k of Object.keys(FALLBACK)) {
    const v = cs.getPropertyValue(`--${k}`).trim();
    if (v) out[k] = v;
  }
  return out;
}

/** '#EDE6D6' + alpha → 'rgba(237,230,214,a)'; other colour strings pass through with globalAlpha instead. */
export function withAlpha(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Pattern tiles (§8.7): hatch 45° 6 px, light hatch 4 px, pending dots 6 px, estimated stripes 3 px, synthetic stripes 8 px. */
export const PATTERNS = Object.freeze({
  hatch: { size: 6, draw: (c, s, ink) => diag(c, s, withAlpha(ink, 0.09), 1, false) },
  'hatch-low': { size: 4, draw: (c, s, ink) => diag(c, s, withAlpha(ink, 0.07), 1, false) },
  stripes: { size: 3, draw: (c, s, ink) => diag(c, s, withAlpha(ink, 0.30), 1, true) },
  syn: { size: 8, draw: (c, s, _ink, syn) => diag(c, s, withAlpha(syn, 0.16), 3, true) },
  dots: { size: 6, draw: (c, s, ink) => { c.fillStyle = withAlpha(ink, 0.26); c.beginPath(); c.arc(s / 2, s / 2, 0.9, 0, Math.PI * 2); c.fill(); } },
  'hatch-strong': { size: 4, draw: (c, s, _ink, _syn, _amber, pal) => diag(c, s, withAlpha(pal['bg-0'], 0.55), 1, false) },
  'hatch-amber': { size: 6, draw: (c, s, _ink, _syn, amber) => diag(c, s, withAlpha(amber, 0.30), 1, false) },
});

function diag(c, s, color, w, backslash) {
  c.strokeStyle = color;
  c.lineWidth = w;
  c.beginPath();
  for (let o = -s; o <= s; o += s) {
    if (backslash) { c.moveTo(o, 0); c.lineTo(o + s, s); } else { c.moveTo(o, s); c.lineTo(o + s, 0); }
  }
  c.stroke();
}

/**
 * CanvasPatterns for a context (created once; recreate when the palette changes).
 * @param {CanvasRenderingContext2D} ctx
 * @param {Record<string, string>} palette
 * @param {number} [dpr=1]
 * @returns {Record<string, CanvasPattern|string>}
 */
export function makePatterns(ctx, palette, dpr = 1) {
  const out = {};
  for (const [name, spec] of Object.entries(PATTERNS)) {
    const size = spec.size;
    const tile = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(size * dpr, size * dpr) : Object.assign(document.createElement('canvas'), { width: size * dpr, height: size * dpr });
    const c = tile.getContext('2d');
    c.scale(dpr, dpr);
    spec.draw(c, size, palette.ink, palette.syn, palette.amber, palette);
    const pat = ctx.createPattern(tile, 'repeat');
    if (pat && typeof pat.setTransform === 'function' && typeof DOMMatrix === 'function') pat.setTransform(new DOMMatrix().scale(1 / dpr));
    out[name] = pat ?? withAlpha(palette.ink, 0.08);
  }
  return out;
}

/** Coverage step-class opacities (§1.7 grey 5-class step scale; legend swatches use the same values). */
export const COVERAGE_ALPHA = Object.freeze([0, 0.12, 0.24, 0.38, 0.56]);
const HUE_TOKEN = { amber: 'amber', violet: 'violet', ivory2: 'ink-2', danger: 'danger', cyan: 'cyan' };

function roundRect(ctx, x, y, w, h, r, round) {
  const rl = round.includes('l') ? r : 0, rr = round.includes('r') ? r : 0;
  ctx.beginPath();
  ctx.moveTo(x + rl, y);
  ctx.lineTo(x + w - rr, y);
  if (rr) ctx.arcTo(x + w, y, x + w, y + rr, rr); else ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - rr);
  if (rr) ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr); else ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + rl, y + h);
  if (rl) ctx.arcTo(x, y + h, x, y + h - rl, rl); else ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + rl);
  if (rl) ctx.arcTo(x, y, x + rl, y, rl); else ctx.lineTo(x, y);
  ctx.closePath();
}

function strokePoints(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}

/** Snap a coordinate to the device-pixel grid so 1 px marks stay crisp (DPR read from the transform). */
function snap(ctx, x) {
  const k = ctx.getTransform?.().a || 1;
  return Math.round(x * k) / k;
}

/**
 * The longest prefix of `s` (with an ellipsis when cut) that fits `maxW` px in the current font; '' when not even
 * one character and the ellipsis fit.
 * @param {{measureText(t: string): {width: number}}} ctx
 * @param {string} s
 * @param {number} maxW
 * @returns {string}
 */
export function fitText(ctx, s, maxW) {
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${s.slice(0, mid).trimEnd()}…`).width <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? `${s.slice(0, lo).trimEnd()}…` : '';
}

/**
 * Where a sticky label goes: inside [minX, maxX] and inside the visible part [vis.x0, vis.x1] of the content.
 * @returns {{x: number, maxW: number}|null} null when less than 24 px are left
 */
export function stickyPlace(p, vis) {
  const left = Math.max(p.minX ?? p.x0, (vis?.x0 ?? -Infinity) + 6);
  const right = Math.min(p.maxX ?? Infinity, (vis?.x1 ?? Infinity) - 4);
  return right - left >= 24 ? { x: left, maxW: right - left } : null;
}

function text(ctx, p, pal, { size = 11, color = pal['ink-2'], weight = '', font = pal['font-ui'], align = 'start', halo = false, plate = false } = {}, vis = null) {
  ctx.font = `${weight}${size}px ${font}`;
  ctx.textAlign = align;
  let x = p.x0, s = p.text;
  if (p.sticky) {
    // A label that follows the view inside its band and never runs past its band's end or a seam (C5, §1.5).
    if (p.onlyIfNone && vis && p.onlyIfNone.some(([a, b]) => b >= vis.x0 && a <= vis.x1)) { ctx.textAlign = 'start'; return; }
    const place = stickyPlace(p, vis);
    if (!place) { ctx.textAlign = 'start'; return; }
    x = place.x;
    // A narrow band shows its short form ("PIE *weys-") whole rather than its long label cut to a stub.
    const full = String(p.text);
    s = p.short && ctx.measureText(full).width > place.maxW ? fitText(ctx, String(p.short), place.maxW) : fitText(ctx, full, place.maxW);
    if (!s) { ctx.textAlign = 'start'; return; }
  }
  if (plate) {
    // a label over a mass of lines sits on a clear plate of the ground colour (fix pass: bundle counts over arcs)
    const w = ctx.measureText(s).width;
    const left = align === 'center' ? x - w / 2 : align === 'end' || align === 'right' ? x - w : x;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = Math.max(prev, 0.9);
    ctx.fillStyle = pal['bg-0'];
    ctx.fillRect(left - 3, p.y0 - size + 1, w + 6, size + 4);
    ctx.globalAlpha = prev;
  }
  if (halo) { ctx.lineWidth = 3; ctx.strokeStyle = pal['bg-0']; ctx.lineJoin = 'round'; ctx.strokeText(s, x, p.y0); }
  ctx.fillStyle = color;
  ctx.fillText(s, x, p.y0);
  ctx.textAlign = 'start';
}

/** Arrowhead at (x, y) pointing along (dx, dy). */
function arrow(ctx, x, y, dx, dy, size = 6) {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - ux * size - uy * size * 0.55, y - uy * size + ux * size * 0.55);
  ctx.lineTo(x - ux * size + uy * size * 0.55, y - uy * size - ux * size * 0.55);
  ctx.closePath();
  ctx.fill();
}

/** Evidence endpoint (§8.7): documented ● · computed □ · proposed ?. */
function endpoint(ctx, kind, x, y, color, pal) {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  if (kind === 'dot') { ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill(); }
  else if (kind === 'square') { ctx.fillStyle = pal['bg-0']; ctx.fillRect(x - 2.5, y - 2.5, 5, 5); ctx.strokeRect(x - 2.5, y - 2.5, 5, 5); }
  else { ctx.font = `600 10px ${pal['font-ui']}`; ctx.textAlign = 'center'; ctx.fillText('?', x, y + 3.5); ctx.textAlign = 'start'; }
}

function paintArc(ctx, p, pal) {
  const e = p.edge ?? { dash: [], width: 1.5, hue: 'ivory2', opacity: 1, endpoint: 'dot' };
  const color = pal[HUE_TOKEN[e.hue] ?? 'ink-2'] ?? pal.ink;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * (e.opacity ?? 1);
  ctx.strokeStyle = color;
  ctx.lineWidth = e.width ?? 1.5;
  ctx.setLineDash(e.dash ?? []);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(p.p0[0], p.p0[1]);
  ctx.quadraticCurveTo(p.cx, p.cy, p.p1[0], p.p1[1]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineCap = 'butt';
  // Arrowhead: at the later (derived) end for forward arcs, at the earlier end for feedback (§1.8).
  ctx.fillStyle = color;
  const [ax, ay] = p.arrowAt === 'start' ? p.p0 : p.p1;
  const tdx = ax - p.cx, tdy = ay - p.cy;
  arrow(ctx, ax, ay, tdx, tdy, 6);
  const [ex, ey] = p.arrowAt === 'start' ? p.p1 : p.p0;
  endpoint(ctx, e.endpoint, ex, ey, color, pal);
  if (e.strike) {
    const mx = (p.p0[0] + 2 * p.cx + p.p1[0]) / 4, my = (p.p0[1] + 2 * p.cy + p.p1[1]) / 4;
    ctx.beginPath(); ctx.moveTo(mx - 5, my - 5); ctx.lineTo(mx + 5, my + 5); ctx.stroke();
  }
  if (e.overlay) {
    const mx = (p.p0[0] + 2 * p.cx + p.p1[0]) / 4, my = (p.p0[1] + 2 * p.cy + p.p1[1]) / 4;
    text(ctx, { text: { check: '✓', cross: '✕', scales: '⚖' }[e.overlay], x0: mx, y0: my - 4 }, pal, { size: 11, color, align: 'center', halo: true });
  }
  ctx.globalAlpha = prev;
}

/**
 * Paint one primitive. `alpha` multiplies the style's own opacity (ghosting, fade-in).
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} p primitive (display.mjs)
 * @param {Record<string, string>} pal palette
 * @param {Record<string, CanvasPattern|string>} pats patterns
 * @param {number} [alpha=1]
 * @param {{x0: number, x1: number}|null} [vis] the visible part of the content (sticky labels stay inside it)
 */
export function paintPrim(ctx, p, pal, pats, alpha = 1, vis = null) {
  const { x0, y0, x1, y1 } = p;
  const w = x1 - x0, h = y1 - y0;
  ctx.globalAlpha = alpha;
  switch (p.style) {
    case 'lane-0': case 'lane-1':
      ctx.fillStyle = pal[p.style === 'lane-0' ? 'bg-0' : 'bg-1'];
      ctx.fillRect(x0, y0, w, h);
      ctx.fillStyle = withAlpha(pal.rule, 0.55);
      ctx.fillRect(x0, y1 - 1, w, 1);
      return;
    case 'hatch': case 'hatch-low': case 'dots':
      ctx.fillStyle = pats[p.style];
      ctx.fillRect(x0, y0, w, h);
      return;
    case 'loading':
      ctx.fillStyle = withAlpha(pal.ink, 0.03);
      ctx.fillRect(x0, y0, w, h);
      return;
    case 'none':
      return;
    case 'bar': case 'bar-sparse': case 'bar-backdrop': {
      const bw = Math.max(w - 0.75, 0.75);
      const r = Math.min(2, bw / 2, h / 2);
      const round = p.round ?? '';
      if (p.style === 'bar') {
        // Luminous ivory: a soft glow, the 88% body, a 1 px lighter top edge and a faint lower shade (§1.4).
        if (h >= 4 && bw >= 2) {
          ctx.fillStyle = withAlpha(pal.ink, 0.07);
          roundRect(ctx, x0 - 1.5, y0 - 1.5, bw + 3, h + 3, r + 1.5, round);
          ctx.fill();
        }
        const dotted = p.sub === 'genre_heuristic';
        roundRect(ctx, x0, y0, bw, h, r, round);
        ctx.fillStyle = withAlpha(pal.ink, dotted ? 0.25 : 0.88);
        ctx.fill();
        if (dotted) { ctx.strokeStyle = withAlpha(pal.ink, 0.9); ctx.lineWidth = 1; ctx.setLineDash([1, 2]); ctx.stroke(); ctx.setLineDash([]); }
        const inset = (round.includes('l') ? r : 0);
        const topW = Math.max(0, bw - inset - (round.includes('r') ? r : 0));
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x0 + inset, y0, topW, 1);
        if (h >= 6) { ctx.fillStyle = 'rgba(0,0,0,0.14)'; ctx.fillRect(x0 + inset, y0 + h - 1, topW, 1); }
        if (p.sub === 'machine_tag' && pats.hatch) { roundRect(ctx, x0, y0, bw, h, r, round); ctx.fillStyle = pats['hatch-strong'] ?? pats.hatch; ctx.fill(); }
      } else if (p.style === 'bar-sparse') {
        roundRect(ctx, x0, y0, bw, h, r, round);
        ctx.fillStyle = withAlpha(pal.ink, 0.25);
        ctx.fill();
        ctx.strokeStyle = withAlpha(pal.ink, 0.88);
        ctx.lineWidth = 1;
        if (p.sub === 'genre_heuristic') ctx.setLineDash([1, 2]);
        roundRect(ctx, x0 + 0.5, y0 + 0.5, Math.max(bw - 1, 0.5), Math.max(h - 1, 0.5), r, round);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        // The occurrence override's backdrop: the bar at 20%, with a faint top edge so its run still reads.
        roundRect(ctx, x0, y0, bw, h, r, round);
        ctx.fillStyle = withAlpha(pal.ink, 0.2);
        ctx.fill();
        ctx.fillStyle = withAlpha(pal.ink, 0.22);
        ctx.fillRect(x0 + (round.includes('l') ? r : 0), y0, Math.max(0, bw - (round.includes('l') ? r : 0) - (round.includes('r') ? r : 0)), 1);
      }
      if (p.pattern && pats[p.pattern]) {
        roundRect(ctx, x0, y0, bw, h, r, round);
        ctx.fillStyle = pats[p.pattern];
        ctx.fill();
      }
      return;
    }
    case 'absent':
      ctx.strokeStyle = pal['ink-3'];
      ctx.lineWidth = 1;
      ctx.setLineDash([1, 3]);
      strokePoints(ctx, p.points.map(([x, y]) => [x, Math.round(y) + 0.5]));
      ctx.setLineDash([]);
      return;
    case 'low-tick':
      ctx.strokeStyle = pal['ink-2'];
      ctx.lineWidth = 1;
      ctx.strokeRect(snap(ctx, x0) + 0.5, y0 + 0.5, Math.max(2, w - 1), h - 1);
      return;
    case 'cap-start': case 'cap-chevron': {
      ctx.font = `${p.size ?? (p.style === 'cap-chevron' ? 12 : 10)}px ${pal['font-ui']}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = pal['bg-0'];
      ctx.strokeText(p.text, x0, y0 + 0.5);
      ctx.fillStyle = pal.ink;
      ctx.fillText(p.text, x0, y0 + 0.5);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
      return;
    }
    case 'cap-end':
      ctx.fillStyle = pal.ink;
      ctx.fillRect(snap(ctx, x0), y0, Math.max(2, w), h);
      return;
    case 'wash': case 'wash-syn': {
      const f = p.feather ? Math.min(w * p.feather, 40) : 0;
      if (f > 0.5) {
        const g = ctx.createLinearGradient(x0, 0, x1, 0);
        const c = withAlpha(pal.ink, 0.18), t = withAlpha(pal.ink, 0);
        g.addColorStop(0, t); g.addColorStop(f / w, c); g.addColorStop(1 - f / w, c); g.addColorStop(1, t);
        ctx.fillStyle = g;
      } else ctx.fillStyle = withAlpha(pal.ink, 0.18);
      ctx.fillRect(x0, y0, w, h);
      if (p.style === 'wash-syn') { ctx.fillStyle = pats.syn; ctx.fillRect(x0, y0, w, h); }
      ctx.fillStyle = withAlpha(pal.ink, 0.55);
      ctx.fillRect(x0 + f, y0, Math.max(0, w - 2 * f), 1);
      return;
    }
    case 'mark-text':
      ctx.fillStyle = pal.ink;
      ctx.fillRect(snap(ctx, (x0 + x1) / 2 - 0.5), y0, 1, h);
      return;
    case 'mark-est':
      ctx.strokeStyle = pal.ink;
      ctx.lineWidth = 1;
      ctx.strokeRect(snap(ctx, x0) - 0.5, y0 + 0.5, 2, h - 1);
      return;
    case 'mark-title': {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = w / 2;
      ctx.fillStyle = pal.ink;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy);
      ctx.closePath();
      ctx.fill();
      return;
    }
    case 'bracket-stated': case 'bracket-est': case 'bracket-derived': case 'bracket-period': {
      if (p.style === 'bracket-period') { ctx.fillStyle = pats.hatch; ctx.fillRect(x0, y0, w, h); }
      ctx.strokeStyle = pal.ink;
      ctx.lineWidth = 1;
      if (p.style === 'bracket-est') ctx.setLineDash([3, 2]);
      strokePoints(ctx, p.points);
      ctx.setLineDash([]);
      if (p.glyph && w >= 12) {
        ctx.fillStyle = pal['ink-2'];
        ctx.font = `10px ${pal['font-ui']}`;
        ctx.fillText(p.glyph, (x0 + x1) / 2 - 3, y0 - 1);
      }
      return;
    }
    case 'coarse':
      ctx.fillStyle = withAlpha(pal.ink, 0.38);
      ctx.fillRect(x0, y0, w, h);
      return;
    case 'cov-span': {
      // Coverage only (no strand pinned): the dated span of a collection, as the corpus listing states it.
      ctx.fillStyle = withAlpha(pal.ink, p.synthetic ? 0.06 : 0.08);
      ctx.fillRect(x0, y0, w, h);
      if (p.synthetic) { ctx.fillStyle = pats.syn; ctx.fillRect(x0, y0, w, h); }
      ctx.fillStyle = withAlpha(pal.ink, 0.32);
      ctx.fillRect(x0, y0, w, 1);
      ctx.fillRect(x0, y1 - 1, w, 1);
      ctx.fillRect(snap(ctx, x0), y0 - 3, 1, h + 6);
      ctx.fillRect(snap(ctx, x1) - 1, y0 - 3, 1, h + 6);
      return;
    }
    case 'ruler-major': case 'ruler-minor': case 'seam-tick':
      ctx.strokeStyle = p.style === 'ruler-major' ? pal['ink-3'] : p.style === 'seam-tick' ? pal['ink-2'] : pal.rule;
      ctx.lineWidth = p.style === 'seam-tick' ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(snap(ctx, x0) + 0.5, y0);
      ctx.lineTo(snap(ctx, x0) + 0.5, y1);
      ctx.stroke();
      return;
    case 'seam':
      ctx.strokeStyle = withAlpha(pal['ink-2'], 0.85);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      strokePoints(ctx, p.points.map(([x, y]) => [snap(ctx, x) + 0.5, y]));
      ctx.setLineDash([]);
      return;
    case 'regime-seam':
      // Folded overview: a 10 px zig-zag seam between two fixed linear regimes (§1.5).
      ctx.fillStyle = pal['bg-0'];
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = pal['ink-3'];
      ctx.lineWidth = 1;
      strokePoints(ctx, p.points);
      return;
    case 'arc': case 'arc-feedback':
      paintArc(ctx, p, pal);
      return;
    case 'arc-bundle': {
      ctx.strokeStyle = withAlpha(pal['ink-2'], 0.34);
      ctx.lineWidth = p.width ?? 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.p0[0], p.p0[1]);
      ctx.quadraticCurveTo(p.cx, p.cy, p.p1[0], p.p1[1]);
      ctx.stroke();
      ctx.lineCap = 'butt';
      const mx = (p.p0[0] + 2 * p.cx + p.p1[0]) / 4, my = (p.p0[1] + 2 * p.cy + p.p1[1]) / 4;
      if (p.label) text(ctx, { text: p.label, x0: mx, y0: my - 4 }, pal, { size: 10.5, color: pal.ink, font: pal['font-num'], align: 'center', plate: true });
      return;
    }
    case 'arc-conflict': {
      ctx.strokeStyle = pal.danger;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([1, 3]);
      strokePoints(ctx, p.points);
      ctx.setLineDash([]);
      const [tx, ty] = p.points[p.points.length - 1];
      text(ctx, { text: '⚠', x0: tx + 2, y0: ty }, pal, { size: 11, color: pal.danger, halo: true });
      return;
    }
    case 'halo': {
      // The violet "re-read" halo on an earlier mark that a later work reframes (§1.8).
      const r = p.r ?? 8;
      ctx.strokeStyle = withAlpha(pal.violet, 0.28);
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(x0, y0, r + 1, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = pal.violet;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x0, y0, r, 0, Math.PI * 2); ctx.stroke();
      return;
    }
    case 'etym-band': {
      // A language period, not a date: amber hatch with feathered ends (§1.7).
      const f0 = Math.min(p.fuzz0 ?? 0, w / 3), f1 = Math.min(p.fuzz1 ?? 0, w / 3);
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      const c = withAlpha(pal.amber, 0.16), t = withAlpha(pal.amber, 0);
      g.addColorStop(0, t); g.addColorStop(Math.max(0.0001, f0 / w), c); g.addColorStop(Math.min(0.9999, 1 - f1 / w), c); g.addColorStop(1, t);
      ctx.fillStyle = g;
      ctx.fillRect(x0, y0, w, h);
      if (pats['hatch-amber']) { ctx.fillStyle = pats['hatch-amber']; ctx.fillRect(x0 + f0, y0, Math.max(0, w - f0 - f1), h); }
      if (p.core) { ctx.fillStyle = withAlpha(pal.amber, 0.14); ctx.fillRect(p.core[0], y0 + 2, Math.max(0, p.core[1] - p.core[0]), h - 4); }
      ctx.fillStyle = withAlpha(pal.amber, 0.7);
      ctx.fillRect(x0 + f0, y0, Math.max(0, w - f0 - f1), 1);
      return;
    }
    case 'roots-bracket': case 'descent': {
      ctx.strokeStyle = withAlpha(pal.amber, p.style === 'descent' ? 0.85 : 0.75);
      ctx.lineWidth = 1;
      if (p.style === 'descent') ctx.setLineDash([1, 3]);
      strokePoints(ctx, p.points);
      ctx.setLineDash([]);
      return;
    }
    case 'claim': {
      // Wiktionary's stated first attestation: a hollow amber diamond, never an occurrence (§1.7).
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = Math.max(3, w / 2);
      ctx.strokeStyle = p.dim ? withAlpha(pal.amber, 0.45) : pal.amber;   // a dimmed claim (§10.2): subject unclear
      ctx.lineWidth = 1.5;
      ctx.fillStyle = pal['bg-0'];
      ctx.beginPath();
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      return;
    }
    case 'baseline-line': case 'baseline-thin':
      ctx.strokeStyle = p.style === 'baseline-thin' ? withAlpha(pal['ink-2'], 0.45) : pal['ink-2'];
      ctx.lineWidth = 1.25;
      if (p.style === 'baseline-thin') ctx.setLineDash([2, 3]);
      ctx.lineJoin = 'round';
      strokePoints(ctx, p.points);
      ctx.setLineDash([]);
      return;
    case 'baseline-ground':
      ctx.fillStyle = pal['bg-1'];
      ctx.fillRect(x0, y0, w, h);
      ctx.fillStyle = withAlpha(pal.rule, 0.8);
      ctx.fillRect(x0, y0, w, 1);
      return;
    case 'split-curve':
      ctx.strokeStyle = pal['ink-2'];
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(p.points[0][0], p.points[0][1]);
      ctx.bezierCurveTo(p.points[1][0], p.points[1][1], p.points[2][0], p.points[2][1], p.points[3][0], p.points[3][1]);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    case 'share-box': case 'share-absent': case 'share-low': {
      // An OpenAlex cell (C3): a box over the cell's years, its height the share of the cell's top-cited sample;
      // never joined to its neighbours. Low cells (n < 20) are hollow, absent ones a dotted floor.
      if (p.style === 'share-box') {
        ctx.fillStyle = withAlpha(pal.ink, 0.62);
        ctx.fillRect(x0, y0, Math.max(w, 1), h);
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(x0, y0, Math.max(w, 1), 1);
        if (p.synthetic && pats.syn) { ctx.fillStyle = pats.syn; ctx.fillRect(x0, y0, Math.max(w, 1), h); }
      } else if (p.style === 'share-absent') {
        ctx.strokeStyle = pal['ink-3'];
        ctx.lineWidth = 1;
        ctx.setLineDash([1, 3]);
        strokePoints(ctx, [[x0, Math.round(p.base) - 0.5], [x1, Math.round(p.base) - 0.5]]);
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = withAlpha(pal.ink, 0.7);
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(snap(ctx, x0) + 0.5, y0 + 0.5, Math.max(w - 1, 1), Math.max(h - 1, 1));
        ctx.setLineDash([]);
        if (p.label) text(ctx, { text: p.label, x0: (x0 + x1) / 2, y0: y1 - 4 }, pal, { size: 9.5, color: pal['ink-2'], font: pal['font-num'], align: 'center' });
      }
      if (p.whisker) {
        // The Wilson 95% interval of this cell only.
        const cx = snap(ctx, (x0 + x1) / 2) + 0.5;
        const [ya, yb] = p.whisker;
        ctx.strokeStyle = pal['ink-2'];
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, ya); ctx.lineTo(cx, yb);
        const cap = Math.min(3, w / 3);
        ctx.moveTo(cx - cap, Math.round(yb) + 0.5); ctx.lineTo(cx + cap, Math.round(yb) + 0.5);
        ctx.stroke();
      }
      return;
    }
    case 'arc-ribbon': {
      // Summarised links (C4): quiet density per lane pair, one segment per bin with a gap between bins (a count per
      // bin, never a line across time); pattern by the dominant status — solid, striped (computed), dotted (proposed).
      const st = p.status ?? 'documented';
      const bx = x0 + 0.5, bw = Math.max(1, w - 1), bh = Math.max(1, h);
      ctx.fillStyle = withAlpha(pal['ink-2'], st === 'documented' ? 0.24 : 0.1);
      ctx.fillRect(bx, y0, bw, bh);
      if (st !== 'documented' && pats[st === 'computed' ? 'stripes' : 'dots']) { ctx.fillStyle = pats[st === 'computed' ? 'stripes' : 'dots']; ctx.fillRect(bx, y0, bw, bh); }
      return;
    }
    case 'transition-emerge': case 'transition-vanish': {
      // A context group emerging or fading (computed): a dashed tick with a small open mark at its top.
      const [[x, ya], [, yb]] = p.points;
      ctx.strokeStyle = pal['ink-2'];
      ctx.lineWidth = 1.25;
      ctx.setLineDash([3, 2]);
      ctx.beginPath(); ctx.moveTo(snap(ctx, x) + 0.5, ya); ctx.lineTo(snap(ctx, x) + 0.5, yb); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      if (p.style === 'transition-emerge') { ctx.moveTo(x - 3, ya + 3); ctx.lineTo(x, ya); ctx.lineTo(x + 3, ya + 3); } else { ctx.moveTo(x - 3, yb - 3); ctx.lineTo(x, yb); ctx.lineTo(x + 3, yb - 3); }
      ctx.stroke();
      return;
    }
    case 'superscript': case 'low-n': case 'wash-label': case 'coarse-label': case 'ruler-label': case 'seam-label': case 'span-label':
    case 'etym-label': case 'bracket-label': case 'etym-note': case 'claim-label': case 'baseline-label': case 'split-glyph': case 'regime-label': {
      const spec = {
        superscript: { size: 9, align: 'right' }, 'low-n': { size: 9, color: pal['ink-3'], font: pal['font-num'] },
        'wash-label': { size: 10 }, 'coarse-label': { size: 10 }, 'ruler-label': { size: 11.5, color: withAlpha(pal.ink, 0.78), font: pal['font-num'] },
        'seam-label': { size: 10.5, weight: '600 ' }, 'span-label': { size: 11, color: pal['ink-2'], halo: true },
        'etym-label': { size: 11, color: pal.amber, halo: true }, 'bracket-label': { size: 10.5, color: pal.amber, halo: true },
        'etym-note': { size: 11, color: pal['ink-2'] },
        'claim-label': { size: 10.5, color: pal.amber, halo: true }, 'baseline-label': { size: 10.5, color: pal['ink-2'] },
        'split-glyph': { size: 12, color: pal.ink, halo: true }, 'regime-label': { size: 10.5, color: pal['ink-2'], weight: '600 ' },
      }[p.style];
      if (p.style === 'seam-label' && Number.isFinite(p.seamX)) {
        // the seam caption sits left of its line where the visible view ends sooner (seams.seamCaptionPlace)
        const at = seamCaptionPlace(p, vis);
        text(ctx, { ...p, x0: at.x }, pal, { ...spec, align: at.align === 'end' ? 'right' : 'left' }, vis);
        return;
      }
      text(ctx, p, pal, p.align ? { ...spec, align: p.align } : spec, vis);
      return;
    }
    default:
      if (/^cov-\d$/.test(p.style)) {
        const cls = Number(p.style.slice(4));
        if (cls === 0) { ctx.fillStyle = pats.hatch; ctx.fillRect(x0, y0, w, h); return; }
        ctx.fillStyle = withAlpha(pal.ink, COVERAGE_ALPHA[cls]);
        ctx.fillRect(x0, y0, Math.max(w - 0.5, 0.5), h);
      }
  }
}

/**
 * A canvas layer sized to CSS pixels with a DPR ≤ 2 backing store.
 * @param {HTMLCanvasElement} canvas
 */
export function createLayer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true });
  const layer = {
    canvas, ctx, width: 0, height: 0, dpr: 1, patterns: null, palette: null,
    resize(width, height, dpr = Math.min(MAX_DPR, globalThis.devicePixelRatio || 1)) {
      const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
      if (w === layer.width && h === layer.height && dpr === layer.dpr) return false;
      layer.width = w; layer.height = h; layer.dpr = dpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      layer.patterns = null;
      return true;
    },
    begin(palette) {
      if (!layer.patterns || layer.palette !== palette) { layer.patterns = makePatterns(ctx, palette, layer.dpr); layer.palette = palette; }
      ctx.setTransform(layer.dpr, 0, 0, layer.dpr, 0, 0);
      ctx.clearRect(0, 0, layer.width, layer.height);
      ctx.globalAlpha = 1;
      return ctx;
    },
  };
  return layer;
}

/**
 * Paint a list of primitives translated by (tx, ty), culled to the layer, clipped to `clip`.
 * @param {ReturnType<typeof createLayer>} layer
 * @param {object[]} prims
 * @param {{tx?: number, ty?: number, clip?: [number, number, number, number]|null, layerName?: string|null,
 *          alphaOf?: (p: object) => number, palette: Record<string, string>}} opts
 * @returns {number} primitives painted
 */
export function paintList(layer, prims, { tx = 0, ty = 0, clip = null, layerName = null, alphaOf = null, palette }) {
  const { ctx } = layer;
  const pats = layer.patterns;
  ctx.save();
  if (clip) { ctx.beginPath(); ctx.rect(...clip); ctx.clip(); }
  // Whole device pixels only: a fractional pan offset would blur every 1 px mark.
  const dpr = layer.dpr || 1;
  ctx.translate(Math.round(tx * dpr) / dpr, Math.round(ty * dpr) / dpr);
  const minX = -tx - 24, maxX = -tx + layer.width + 24;
  const minY = clip ? clip[1] - ty - 24 : -Infinity, maxY = clip ? clip[1] + clip[3] - ty + 24 : Infinity;
  const vis = { x0: -tx, x1: -tx + layer.width };
  let n = 0;
  // Narrow plain bars (the common case when zoomed out) are collected per run and alpha, then drawn as plain
  // fillRects with one fill style for the bodies and one for the 1 px highlights — no rounded paths, no state
  // changes per bar (§8.3: one fillRect pass per fill style). fillRect batches far better on the GPU than a path.
  let batch = null;
  const flush = () => {
    if (!batch) return;
    const r = batch.rects;
    ctx.globalAlpha = batch.a;
    ctx.fillStyle = batch.style === 'bar' ? withAlpha(palette.ink, 0.88) : withAlpha(palette.ink, 0.2);
    for (let i = 0; i < r.length; i += 4) ctx.fillRect(r[i], r[i + 1], r[i + 2], r[i + 3]);
    ctx.fillStyle = batch.style === 'bar' ? 'rgba(255,255,255,0.12)' : withAlpha(palette.ink, 0.22);
    for (let i = 0; i < r.length; i += 4) ctx.fillRect(r[i], r[i + 1], r[i + 2], 1);
    batch = null;
  };
  // a ruler label gives way where a seam caption is painted (its tick stays; §1.10, fix pass)
  const captions = prims.filter((p) => p.style === 'seam-label' && Number.isFinite(p.seamX) && (!layerName || p.layer === layerName))
    .map((p) => seamCaptionPlace(p, vis));
  const underCaption = (p) => captions.some((c) => p.x0 < c.x1 + 4 && p.x0 + (p.w ?? 0) > c.x0 - 4);
  for (const p of prims) {
    if (layerName && p.layer !== layerName) continue;
    if (p.x1 < minX || p.x0 > maxX || p.y1 < minY || p.y0 > maxY) continue;
    if (captions.length && p.style === 'ruler-label' && underCaption(p)) continue;
    // Ghosted (later than the vantage, context mode): 15% for marks; a 1.5 px arc needs a little more to be seen.
    let a = p.ghost ? (p.ghostAlpha ?? 0.15) : 1;
    if (p.quiet) a *= p.quietAlpha ?? 0.5;
    if (alphaOf) a *= alphaOf(p);
    if (a <= 0.003) continue;
    n++;
    if ((p.style === 'bar' || p.style === 'bar-backdrop') && !p.pattern && !p.sub && p.x1 - p.x0 < BATCH_W) {
      if (!batch || batch.style !== p.style || batch.a !== a) { flush(); batch = { style: p.style, a, rects: [] }; }
      batch.rects.push(p.x0, p.y0, Math.max(p.x1 - p.x0 - 0.75, 0.75), p.y1 - p.y0);
      continue;
    }
    flush();
    paintPrim(ctx, p, palette, pats, a, vis);
  }
  flush();
  ctx.restore();
  ctx.globalAlpha = 1;
  return n;
}

/**
 * Paint a small legend swatch with the very code that paints the Scroll.
 * @param {HTMLCanvasElement} canvas
 * @param {object[]} prims primitives in swatch coordinates
 * @param {Record<string, string>} palette
 * @param {{width?: number, height?: number}} [size]
 */
export function paintSwatch(canvas, prims, palette, { width = 36, height = 16 } = {}) {
  const layer = createLayer(canvas);
  layer.resize(width, height);
  layer.begin(palette);
  paintList(layer, prims, { palette });
}

/** UI module contract (§8): a library imported by the Scroll and the legend; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
