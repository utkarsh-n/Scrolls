// OWNER: WP6
// timeline/snapshot.mjs — PNG and SVG snapshots of the Scroll (SPEC §7.3, §8.3, §13 rule 1).
// PNG = the composite of the four canvas layers, with the lane names, a one-line legend and the caption baked
// in, and the SYNTHETIC stamp whenever synthetic material is visible. SVG = the same display list serialised by
// svg.mjs, so the snapshot matches the screen. Both are offered as a download and stored through
// POST /api/snapshots (the server refuses a synthetic SVG without its stamp).

import { totalsText } from '../../shared/format.mjs';
import { LANE_ORDER_NOTE } from '../../shared/vocab.mjs';
import { isAbort } from '../core/api.mjs';
import { laneSubtitle } from '../shell/lanes-menu.mjs';
import { toSvg } from './svg.mjs';
import { scrollHub } from './viewport.mjs';

export const STAMP = 'SYNTHETIC DEMONSTRATION CORPUS — invented people, texts, dates and links.';
const LABEL_W = 176;
const STAMP_H = 26;
const FOOT_H = 46;

/**
 * The caption baked into every snapshot (§7.3): "Scrolls · demo · carry the zero · data v47 · contains SYNTHETIC data".
 * @param {{view: object, query: object|null, labels: string[]}} o
 * @returns {string}
 */
export function snapshotCaption({ view, query, labels = [] }) {
  const parts = ['Scrolls', view.corpus];
  if (labels.length) parts.push(labels.join(' · '));
  if (Number.isInteger(query?.dataVersion)) parts.push(`data v${query.dataVersion}`);
  const runs = Object.entries(view.runs?.materialize ?? {}).map(([e, r]) => `e${e}→run ${r}`);
  if (runs.length) parts.push(runs.join(', '));
  if (query?.totals) parts.push(totalsText(query.totals));
  if (query?.provenance?.synthetic || view.corpus === 'demo') parts.push('contains SYNTHETIC data');
  return parts.join(' · ');
}

/** Lane rows for the label column (lane coordinates). */
export function laneLabels(model, layout) {
  return (model?.lanes ?? []).map((lane) => {
    const l = layout?.lanes?.find((x) => x.key === lane.key);
    return l ? { y: l.y, h: l.h, label: lane.label, sub: laneSubtitle(lane), synthetic: Boolean(lane.synthetic) } : null;
  }).filter(Boolean);
}

/**
 * Compose the PNG snapshot from the Scroll's canvases.
 * @param {ReturnType<NonNullable<typeof scrollHub.actions.snapshotInput>>} input
 * @param {{doc?: Document, synthetic: boolean, caption: string}} opts
 * @returns {string} data:image/png;base64,…
 */
export function composePng(input, { doc = globalThis.document, synthetic, caption }) {
  const pal = input.palette;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const top = synthetic ? STAMP_H : 0;
  const W = LABEL_W + input.width, H = top + input.height + FOOT_H;
  const cv = doc.createElement('canvas');
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const c = cv.getContext('2d');
  c.scale(dpr, dpr);
  c.fillStyle = pal['bg-0'];
  c.fillRect(0, 0, W, H);
  if (synthetic) {
    c.fillStyle = pal['bg-1'];
    c.fillRect(0, 0, W, STAMP_H);
    c.strokeStyle = 'rgba(217,207,184,0.16)';
    c.lineWidth = 3;
    for (let x = -STAMP_H; x < W; x += 8) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x + STAMP_H, STAMP_H); c.stroke(); }
    c.fillStyle = pal.syn;
    c.font = `600 12px ${pal['font-ui']}`;
    c.textAlign = 'center';
    c.fillText(STAMP, W / 2, 17);
    c.textAlign = 'start';
  }
  for (const layer of input.canvases) c.drawImage(layer, LABEL_W, top, input.width, input.height);
  // Lane names (baked in, synthetic lanes marked SYN), aligned with the lanes as scrolled on screen.
  c.fillStyle = pal['bg-1'];
  c.fillRect(0, top, LABEL_W, input.height);
  c.save();
  c.beginPath();
  c.rect(0, top + input.lanesTop, LABEL_W, input.height - input.lanesTop);
  c.clip();
  for (const l of laneLabels(input.model, input.layout)) {
    const y = top + input.lanesTop + l.y - input.scrollY;
    c.fillStyle = pal.ink;
    c.font = `500 13px ${pal['font-ui']}`;
    const ly = y + Math.min(l.h / 2, 20);
    c.fillText(l.label, 10, ly, LABEL_W - 44);
    if (l.synthetic) { c.fillStyle = pal.syn; c.font = `600 9.5px ${pal['font-num']}`; c.fillText('SYN', LABEL_W - 32, ly); }
    if (l.sub && l.h >= 36) { c.fillStyle = pal['ink-3']; c.font = `11px ${pal['font-ui']}`; c.fillText(l.sub, 10, ly + 15, LABEL_W - 16); }
  }
  c.restore();
  c.fillStyle = pal['ink-2'];
  c.font = `11px ${pal['font-ui']}`;
  c.fillText('▬ observed · ┈ looked, found none · ▨ no sources · ⁘ indexing · ▭ wash: date wider than the bin · DOC solid · CALC dashed · PROP dotted', 10, top + input.height + 16, W - 20);
  c.fillText(`${caption} · ${LANE_ORDER_NOTE}`, 10, top + input.height + 34, W - 20);
  return cv.toDataURL('image/png');
}

/** The SVG snapshot of the same display list. */
export function composeSvg(input, { synthetic, caption, title = 'Scrolls snapshot' }) {
  return toSvg(input.display, { tx: input.tx, viewWidth: input.width, lanesTop: input.lanesTop, palette: input.palette, synthetic, caption, title,
    laneLabels: laneLabels(input.model, input.layout), labelW: LABEL_W, height: input.layout?.height ?? input.display.height });
}

function download(doc, href, name) {
  const a = doc.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Take a snapshot of the Scroll as it is on screen: download it and store it on the local server.
 * @param {{store: object, api: object, announce?: Function}} ctx
 * @param {'png'|'svg'} format
 * @returns {Promise<{file: string|null, href: string}|null>}
 */
export async function takeSnapshot({ store, api, announce = () => {} }, format = 'png') {
  const input = scrollHub.actions.snapshotInput?.();
  if (!input) { store.dispatch({ type: 'UI_TOAST', toast: { kind: 'info', text: 'Nothing is drawn yet: there is nothing to snapshot.' } }); return null; }
  const view = store.get().view;
  const synthetic = Boolean(input.query?.provenance?.synthetic) || view.corpus === 'demo';
  const labels = (input.model?.strands ?? []).map((s) => s.label).filter(Boolean);
  const caption = snapshotCaption({ view, query: input.query, labels });
  const doc = globalThis.document;
  let href, body;
  if (format === 'svg') {
    const svg = composeSvg(input, { synthetic, caption });
    href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    body = { svg, synthetic };
  } else {
    const png = composePng(input, { doc, synthetic, caption });
    href = png;
    body = { png, synthetic };
  }
  const saved = store.get().ui.savedView;
  if (saved?.slug) body.view = saved.slug;
  download(doc, href, `scrolls-${view.corpus}-${Date.now()}.${format}`);
  if (format === 'svg') setTimeout(() => URL.revokeObjectURL(href), 10000);
  try {
    const res = await api.post('/snapshots', body, { key: 'snapshot' });
    announce(`Snapshot saved as ${res?.file ?? format}.`);
    store.dispatch({ type: 'UI_TOAST', toast: { kind: 'ok', text: `Snapshot downloaded and stored on this computer (${res?.file ?? format}).` } });
    return { file: res?.file ?? null, href };
  } catch (err) {
    if (!isAbort(err)) store.dispatch({ type: 'UI_TOAST', toast: { kind: 'warn', text: `Snapshot downloaded; storing it failed: ${err.message}`, hint: err.hint ?? null } });
    return { file: null, href };
  }
}

/** UI module contract (§8): a library (the toolbar's More menu calls takeSnapshot); the registry mounts nothing. */
export function mount() { return { unmount() {} }; }
