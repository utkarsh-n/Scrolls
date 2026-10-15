// OWNER: WP6
// timeline/svg.mjs — SVG serialiser of the SAME display list paint.mjs draws (SPEC §8.3, §7.3): snapshots
// and the portable bundle are guaranteed to match the screen because they come from one list. Text is
// escaped; nothing from the corpus is ever interpreted as markup.

import { seamCaptionPlace } from './seams.mjs';

import { COVERAGE_ALPHA, FALLBACK, withAlpha } from './paint.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const n = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0);

function defs(pal) {
  const ink = pal.ink, syn = pal.syn;
  return `<defs>
<pattern id="p-hatch" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M-6 6L0 0M0 6L6 0M6 6L12 0" stroke="${withAlpha(ink, 0.09)}" stroke-width="1"/></pattern>
<pattern id="p-hatch-low" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M-4 4L0 0M0 4L4 0M4 4L8 0" stroke="${withAlpha(ink, 0.07)}" stroke-width="1"/></pattern>
<pattern id="p-stripes" width="3" height="3" patternUnits="userSpaceOnUse"><path d="M-3 0L0 3M0 0L3 3M3 0L6 3" stroke="${withAlpha(ink, 0.3)}" stroke-width="1"/></pattern>
<pattern id="p-syn" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M-8 0L0 8M0 0L8 8M8 0L16 8" stroke="${withAlpha(syn, 0.16)}" stroke-width="3"/></pattern>
<pattern id="p-dots" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="0.9" fill="${withAlpha(ink, 0.26)}"/></pattern>
<pattern id="p-hatch-amber" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M-6 6L0 0M0 6L6 0M6 6L12 0" stroke="${withAlpha(pal.amber, 0.3)}" stroke-width="1"/></pattern>
</defs>`;
}

const HUE = { amber: 'amber', violet: 'violet', ivory2: 'ink-2', danger: 'danger', cyan: 'cyan' };

/**
 * One primitive as SVG markup.
 * @param {object} p
 * @param {Record<string, string>} pal
 * @param {{x0: number, x1: number}|null} [vis] the visible part of the content (sticky labels stay inside it)
 * @returns {string}
 */
export function primToSvg(p, pal, vis = null) {
  if (p.sticky) return stickyToSvg(p, pal, vis);
  const { x0, y0, x1, y1 } = p;
  const w = n(x1 - x0), h = n(y1 - y0);
  const op = p.ghost ? ' opacity="0.15"' : '';
  const rect = (fill, extra = '') => `<rect x="${n(x0)}" y="${n(y0)}" width="${Math.max(w, 0.5)}" height="${Math.max(h, 0.5)}" fill="${fill}"${extra}${op}/>`;
  const line = (stroke, dash, width = 1) => `<polyline points="${(p.points ?? []).map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}${op}/>`;
  const txt = (s, size, fill, anchor = 'start') => `<text x="${n(x0)}" y="${n(y0)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-family="${esc(pal['font-ui'])}"${op}>${esc(s)}</text>`;
  switch (p.style) {
    case 'lane-0': return rect(pal['bg-0']);
    case 'lane-1': return rect(pal['bg-1']);
    case 'hatch': case 'hatch-low': case 'dots': return rect(`url(#p-${p.style})`);
    case 'loading': case 'none': return '';
    case 'bar': return rect(withAlpha(pal.ink, 0.88), ' rx="2"') + (p.pattern ? rect(`url(#p-${p.pattern})`) : '');
    case 'bar-sparse': return rect(withAlpha(pal.ink, 0.25), ` rx="2" stroke="${withAlpha(pal.ink, 0.88)}" stroke-width="1"`) + (p.pattern ? rect(`url(#p-${p.pattern})`) : '');
    case 'bar-backdrop': return rect(withAlpha(pal.ink, 0.2), ' rx="2"');
    case 'absent': return line(pal['ink-3'], '1 3');
    case 'low-tick': return `<rect x="${n(x0)}" y="${n(y0)}" width="${Math.max(2, w)}" height="${h}" fill="none" stroke="${pal['ink-2']}"${op}/>`;
    case 'cap-start': case 'cap-chevron': return `<text x="${n(x0)}" y="${n(y0 + 4)}" font-size="${p.style === 'cap-chevron' ? 12 : 10}" fill="${pal.ink}" text-anchor="middle"${op}>${esc(p.text)}</text>`;
    case 'cap-end': return rect(pal.ink);
    case 'wash': return rect(withAlpha(pal.ink, 0.18)) + `<rect x="${n(x0)}" y="${n(y0)}" width="${w}" height="1" fill="${withAlpha(pal.ink, 0.55)}"${op}/>`;
    case 'wash-syn': return rect(withAlpha(pal.ink, 0.18)) + rect('url(#p-syn)') + `<rect x="${n(x0)}" y="${n(y0)}" width="${w}" height="1" fill="${withAlpha(pal.ink, 0.55)}"${op}/>`;
    case 'mark-text': return rect(pal.ink);
    case 'mark-est': return `<rect x="${n(x0)}" y="${n(y0)}" width="2" height="${h}" fill="none" stroke="${pal.ink}"${op}/>`;
    case 'mark-title': {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = w / 2;
      return `<path d="M${n(cx)} ${n(cy - r)}L${n(cx + r)} ${n(cy)}L${n(cx)} ${n(cy + r)}L${n(cx - r)} ${n(cy)}Z" fill="${pal.ink}"${op}/>`;
    }
    case 'bracket-stated': case 'bracket-derived': return line(pal.ink, null);
    case 'bracket-est': return line(pal.ink, '3 2');
    case 'bracket-period': return rect('url(#p-hatch)') + line(pal.ink, null);
    case 'coarse': return rect(withAlpha(pal.ink, 0.38));
    case 'ruler-major': case 'ruler-minor': case 'seam-tick':
      return `<line x1="${n(x0)}" y1="${n(y0)}" x2="${n(x0)}" y2="${n(y1)}" stroke="${p.style === 'ruler-minor' ? pal.rule : p.style === 'seam-tick' ? pal['ink-2'] : pal['ink-3']}"${op}/>`;
    case 'seam': return line(pal['ink-2'], '4 3');
    case 'seam-label': {
      if (!Number.isFinite(p.seamX)) return txt(p.text, 10, pal['ink-2']);
      const at = seamCaptionPlace(p, vis);   // as on the canvas: left of its line where the view ends sooner
      return `<text x="${n(at.x)}" y="${n(y0)}" font-size="10" fill="${pal['ink-2']}" text-anchor="${at.align}" font-family="${esc(pal['font-ui'])}"${op}>${esc(p.text)}</text>`;
    }
    case 'ruler-label': case 'wash-label': case 'coarse-label':
      return txt(p.text, p.style === 'ruler-label' ? 11 : 10, pal['ink-2'], p.align === 'end' ? 'end' : 'start');
    case 'superscript': return txt(p.text, 9, pal['ink-2'], 'end');
    case 'low-n': return txt(p.text, 9, pal['ink-3']);
    case 'span-label': case 'baseline-label': case 'regime-label': return txt(p.text, 10.5, pal['ink-2']);
    case 'etym-label': case 'bracket-label': case 'claim-label': return txt(p.text, 10.5, pal.amber);
    case 'split-glyph': return txt(p.text, 12, pal.ink);
    case 'cov-span': return rect(withAlpha(pal.ink, 0.08)) + (p.synthetic ? rect('url(#p-syn)') : '');
    case 'arc': case 'arc-feedback': case 'arc-bundle': {
      const e = p.edge ?? {};
      const bundle = p.style === 'arc-bundle';
      const stroke = bundle ? withAlpha(pal['ink-2'], 0.34) : pal[HUE[e.hue] ?? 'ink-2'];
      const d = `M${n(p.p0[0])} ${n(p.p0[1])}Q${n(p.cx)} ${n(p.cy)} ${n(p.p1[0])} ${n(p.p1[1])}`;
      const dash = !bundle && e.dash?.length ? ` stroke-dasharray="${e.dash.join(' ')}"` : '';
      const lx = (p.p0[0] + 2 * p.cx + p.p1[0]) / 4, ly = (p.p0[1] + 2 * p.cy + p.p1[1]) / 4 - 4;
      const lw = 6 * String(p.label ?? '').length + 6;
      // a bundle count sits on a plate of the ground colour, as on the canvas (fix pass)
      const label = bundle && p.label ? `<rect x="${n(lx - lw / 2)}" y="${n(ly - 10)}" width="${n(lw)}" height="13" fill="${pal['bg-0']}" opacity="0.9"/><text x="${n(lx)}" y="${n(ly)}" font-size="10" fill="${pal.ink}" text-anchor="middle"${op}>${esc(p.label ?? '')}</text>` : '';
      const badge = !bundle && e.badge ? `<title>${esc(e.badge)}</title>` : '';
      const alpha = p.ghost ? 0.15 : (e.opacity ?? 1) * (p.quiet ? p.quietAlpha ?? 0.5 : 1);
      return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${bundle ? n(p.width ?? 2) : e.width ?? 1.5}"${dash} opacity="${n(alpha)}">${badge}</path>${label}`;
    }
    case 'arc-conflict': return line(pal.danger, '1 3', 1.5);
    case 'halo': return `<circle cx="${n(x0)}" cy="${n(y0)}" r="${n(p.r ?? 8)}" fill="none" stroke="${pal.violet}" stroke-width="1.5"${op}/>`;
    case 'etym-band': return rect(withAlpha(pal.amber, 0.16)) + rect('url(#p-hatch-amber)');
    case 'roots-bracket': return line(withAlpha(pal.amber, 0.75), null);
    case 'descent': return line(withAlpha(pal.amber, 0.85), '1 3');
    case 'claim': {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = Math.max(3, w / 2);
      return `<path d="M${n(cx)} ${n(cy - r)}L${n(cx + r)} ${n(cy)}L${n(cx)} ${n(cy + r)}L${n(cx - r)} ${n(cy)}Z" fill="${pal['bg-0']}" stroke="${p.dim ? withAlpha(pal.amber, 0.45) : pal.amber}" stroke-width="1.5"${op}/>`;
    }
    case 'baseline-line': return line(pal['ink-2'], null, 1.25);
    case 'baseline-thin': return line(withAlpha(pal['ink-2'], 0.45), '2 3', 1.25);
    case 'baseline-ground': return rect(pal['bg-1']);
    case 'regime-seam': return line(pal['ink-3'], null);
    case 'share-box': return rect(withAlpha(pal.ink, 0.62)) + whiskerSvg(p, pal, op);
    case 'share-absent': return `<line x1="${n(x0)}" y1="${n(p.base)}" x2="${n(x1)}" y2="${n(p.base)}" stroke="${pal['ink-3']}" stroke-dasharray="1 3"${op}/>` + whiskerSvg(p, pal, op);
    case 'share-low': return `<rect x="${n(x0)}" y="${n(y0)}" width="${Math.max(w, 1)}" height="${Math.max(h, 1)}" fill="none" stroke="${withAlpha(pal.ink, 0.7)}" stroke-dasharray="3 2"${op}/>`
      + (p.label ? `<text x="${n((x0 + x1) / 2)}" y="${n(y1 - 4)}" font-size="9.5" fill="${pal['ink-2']}" text-anchor="middle"${op}>${esc(p.label)}</text>` : '');
    case 'arc-ribbon': {
      const st = p.status ?? 'documented';
      const box = (fill) => `<rect x="${n(x0 + 0.5)}" y="${n(y0)}" width="${Math.max(w - 1, 1)}" height="${Math.max(h, 1)}" fill="${fill}"${op}/>`;
      return box(withAlpha(pal['ink-2'], st === 'documented' ? 0.24 : 0.1)) + (st === 'documented' ? '' : box(`url(#p-${st === 'computed' ? 'stripes' : 'dots'})`));
    }
    case 'transition-emerge': case 'transition-vanish': return line(pal['ink-2'], '3 2', 1.25);
    case 'split-curve': {
      const [a, b, c2, d2] = p.points;
      return `<path d="M${n(a[0])} ${n(a[1])}C${n(b[0])} ${n(b[1])} ${n(c2[0])} ${n(c2[1])} ${n(d2[0])} ${n(d2[1])}" fill="none" stroke="${pal['ink-2']}" stroke-width="1.5" stroke-dasharray="5 3"${op}/>`;
    }
    default:
      if (/^cov-\d$/.test(p.style)) {
        const cls = Number(p.style.slice(4));
        return cls === 0 ? rect('url(#p-hatch)') : rect(withAlpha(pal.ink, COVERAGE_ALPHA[cls]));
      }
      return '';
  }
}

function whiskerSvg(p, pal, op) {
  if (!p.whisker) return '';
  const cx = n((p.x0 + p.x1) / 2), [ya, yb] = p.whisker;
  return `<line x1="${cx}" y1="${n(ya)}" x2="${cx}" y2="${n(yb)}" stroke="${pal['ink-2']}"${op}/>`;
}

/** A sticky label (etymology bands, brackets): placed and cut like the painter does, by an average glyph width. */
function stickyToSvg(p, pal, vis) {
  if (p.onlyIfNone && vis && p.onlyIfNone.some(([a, b]) => b >= vis.x0 && a <= vis.x1)) return '';
  const left = Math.max(p.minX ?? p.x0, (vis?.x0 ?? -Infinity) + 6);
  const right = Math.min(p.maxX ?? Infinity, (vis?.x1 ?? Infinity) - 4);
  if (!(right - left >= 24)) return '';
  const max = Math.floor((right - left) / 6.2);
  const s = p.short && String(p.text).length > max ? String(p.short) : String(p.text);
  const t = s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
  return `<text x="${n(left)}" y="${n(p.y0)}" font-size="${p.style === 'bracket-label' ? 10.5 : 11}" fill="${p.style === 'etym-note' ? pal['ink-2'] : pal.amber}" font-family="${esc(pal['font-ui'])}"${p.ghost ? ' opacity="0.15"' : ''}>${esc(t)}</text>`;
}

/** The ruler primitives to draw: a ruler label gives way where a seam caption sits (as paint.mjs does). */
function visibleTop(top, vis) {
  const captions = top.filter((p) => p.style === 'seam-label' && Number.isFinite(p.seamX)).map((p) => seamCaptionPlace(p, vis));
  if (!captions.length) return top;
  return top.filter((p) => p.style !== 'ruler-label' || !captions.some((c) => p.x0 < c.x1 + 4 && p.x0 + (p.w ?? 0) > c.x0 - 4));
}

/**
 * Serialise a display list (top + lanes groups) to a standalone SVG document. With `laneLabels` a column of
 * lane names is drawn at the left (synthetic lanes say SYN), so the snapshot reads without the app around it;
 * a synthetic view carries the SYNTHETIC stamp at the top and the bottom (§13 rule 1, §7.3).
 * @param {{top: object[], lanes: object[], width: number, height: number}} display
 * @param {{tx?: number, viewWidth?: number, lanesTop?: number, palette?: Record<string, string>, title?: string,
 *          synthetic?: boolean, caption?: string, laneLabels?: Array<{y: number, h: number, label: string, sub?: string, synthetic?: boolean}>,
 *          labelW?: number, height?: number}} [opts]
 * @returns {string}
 */
export function toSvg(display, { tx = 0, viewWidth = display.width, lanesTop = 56, palette = FALLBACK, title = 'Scrolls snapshot',
  synthetic = false, caption = '', laneLabels = null, labelW = 0, height: lanesH = display.height } = {}) {
  const pal = { ...FALLBACK, ...palette };
  const vis = { x0: -tx, x1: -tx + viewWidth };
  const stampH = synthetic ? 24 : 0;
  const lw = laneLabels?.length ? labelW || 168 : 0;
  const width = lw + viewWidth;
  const height = stampH + lanesTop + lanesH + (caption ? 24 : 0) + (synthetic ? 24 : 0);
  const stamp = 'SYNTHETIC DEMONSTRATION CORPUS — invented people, texts, dates and links.';
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}" role="img" aria-label="${esc(title)}">`,
    `<title>${esc(title)}</title>`, defs(pal), `<rect width="100%" height="100%" fill="${pal['bg-0']}"/>`];
  if (synthetic) parts.push(`<rect width="${n(width)}" height="${stampH}" fill="url(#p-syn)"/><text x="${n(width / 2)}" y="16" font-size="11" font-weight="600" fill="${pal.syn}" text-anchor="middle">${esc(stamp)}</text>`);
  parts.push(`<svg x="${lw}" y="${stampH}" width="${n(viewWidth)}" height="${n(lanesTop + lanesH)}" overflow="hidden">`,
    `<g transform="translate(${n(tx)} 0)">`, ...visibleTop(display.top, vis).map((p) => primToSvg(p, pal, vis)), '</g>',
    `<g transform="translate(${n(tx)} ${lanesTop})">`, ...display.lanes.map((p) => primToSvg(p, pal, vis)), '</g>', '</svg>');
  if (lw) {
    parts.push(`<rect x="0" y="${stampH}" width="${lw}" height="${n(lanesTop + lanesH)}" fill="${pal['bg-1']}"/>`);
    for (const l of laneLabels) {
      const y = stampH + lanesTop + l.y;
      parts.push(`<text x="10" y="${n(y + Math.min(l.h / 2, 18))}" font-size="13" fill="${pal.ink}">${esc(l.label)}${l.synthetic ? ` <tspan font-size="9.5" fill="${pal.syn}">SYN</tspan>` : ''}</text>`);
      if (l.sub && l.h >= 34) parts.push(`<text x="10" y="${n(y + Math.min(l.h / 2, 18) + 15)}" font-size="11" fill="${pal['ink-3']}">${esc(l.sub)}</text>`);
    }
  }
  let y = stampH + lanesTop + lanesH;
  if (caption) { parts.push(`<text x="8" y="${n(y + 16)}" font-size="11" fill="${pal['ink-2']}">${esc(caption)}</text>`); y += 24; }
  if (synthetic) parts.push(`<text x="8" y="${n(y + 16)}" font-size="11" font-weight="600" fill="${pal.syn}">SYNTHETIC — invented demonstration data</text>`);
  parts.push('</svg>');
  return parts.filter(Boolean).join('\n');
}

/** UI module contract (§8): a library; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
