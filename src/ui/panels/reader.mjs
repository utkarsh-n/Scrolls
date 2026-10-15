// OWNER: WP7
// panels/reader.mjs — the virtualized document reader (SPEC §2.D "Open in reader", §1.4 typography, D4).
// The full original text is read in slices of GET /api/documents/:id/text (≤ 20k characters per request) and
// at most MAX_CHUNKS slices are kept in the page; scrolling near either end (or the Earlier/Later buttons,
// which work without a wheel or hover) loads the neighbour and drops the farthest slice. The passage that
// opened the reader is outlined and its matches are highlighted at their offsets. Slices overlap by one UTF-16
// code unit so a surrogate pair cut by a slice boundary is shown whole, in exactly one slice.

import { h, clear } from '../core/dom.mjs';
import { formatCount } from '../../shared/format.mjs';
import { renderDateChip } from './date-chip.mjs';
import { renderErrorCard, renderLoadingLine } from './gate-card.mjs';
import { synBadge } from './passage-card.mjs';

/** Characters per slice (a request asks for one more: the overlap unit). */
export const READER_CHUNK = 16000;
/** Slices kept in the page at once. */
export const MAX_CHUNKS = 5;
/** Distance from an end of the scroll area (px) that loads the next slice. */
const EDGE_PX = 400;

const isHigh = (c) => c >= 0xD800 && c <= 0xDBFF;

/**
 * Index of the slice that holds a document offset.
 * @param {number} offset
 * @param {number} [size]
 * @returns {number}
 */
export function chunkIndexOf(offset, size = READER_CHUNK) {
  return Math.max(0, Math.floor(Math.max(0, offset) / size));
}

/**
 * The text request for slice i: one code unit of overlap before the slice (so the slice can tell whether its
 * first unit completes a pair), clipped to the document when its length is known.
 * @param {number} i
 * @param {number|null} length
 * @param {number} [size]
 * @returns {{from: number, to: number}}
 */
export function chunkRequest(i, length, size = READER_CHUNK) {
  const from = Math.max(0, i * size - 1);
  const to = (i + 1) * size;
  return { from, to: Number.isInteger(length) ? Math.min(length, to) : to };
}

/**
 * What slice i shows of a fetched text: its nominal range [i·size, (i+1)·size) ∩ [0, length), moved back by one
 * unit at either end where that end would split a surrogate pair. Consecutive slices tile the document
 * exactly (no unit shown twice or dropped).
 * @param {number} i
 * @param {string} text the fetched text
 * @param {number} reqFrom the offset the fetched text starts at
 * @param {number} length document length (UTF-16 units)
 * @param {number} [size]
 * @returns {{start: number, end: number, text: string}}
 */
export function chunkDisplay(i, text, reqFrom, length, size = READER_CHUNK) {
  const unitAt = (off) => text.charCodeAt(off - reqFrom);
  let start = Math.min(i * size, length);
  let end = Math.min((i + 1) * size, length);
  if (start > 0 && start - 1 >= reqFrom && isHigh(unitAt(start - 1))) start -= 1;
  if (end < length && end - 1 >= reqFrom && end - 1 < reqFrom + text.length && isHigh(unitAt(end - 1))) end -= 1;
  return { start, end, text: text.slice(start - reqFrom, end - reqFrom) };
}

/**
 * Split a slice of the document into segments by the spans that cover them (the passage outline, matches).
 * @param {string} text the slice text
 * @param {number} start document offset of text[0]
 * @param {Array<{start: number, end: number, kind: string}>} spans document offsets
 * @returns {Array<{text: string, start: number, end: number, kinds: string[]}>}
 */
export function readerSegments(text, start, spans) {
  const end = start + text.length;
  const cuts = new Set([start, end]);
  const live = [];
  for (const s of Array.isArray(spans) ? spans : []) {
    const a = Math.max(start, s.start), b = Math.min(end, s.end);
    if (a >= b) continue;
    live.push({ a, b, kind: s.kind });
    cuts.add(a); cuts.add(b);
  }
  const points = [...cuts].sort((x, y) => x - y);
  const out = [];
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k], b = points[k + 1];
    if (a === b) continue;
    const kinds = live.filter((s) => s.a <= a && s.b >= b).map((s) => s.kind);
    const last = out[out.length - 1];
    if (last && last.kinds.join() === kinds.join()) { last.text += text.slice(a - start, b - start); last.end = b; }
    else out.push({ text: text.slice(a - start, b - start), start: a, end: b, kinds });
  }
  return out;
}

/**
 * Spans to mark in the reader for a passage: the passage itself and each highlight, in document offsets.
 * Only body passages index the document text; other fields (titles, summaries) have no span in it.
 * @param {object|null} passage
 * @returns {Array<{start: number, end: number, kind: 'passage'|'match'}>}
 */
export function passageSpans(passage) {
  if (!passage || passage.field !== 'body' || !Number.isInteger(passage.start)) return [];
  const spans = [{ start: passage.start, end: passage.end, kind: 'passage' }];
  for (const hl of passage.highlights ?? []) {
    if (Number.isInteger(hl.start) && Number.isInteger(hl.end) && hl.start < hl.end) {
      spans.push({ start: passage.start + hl.start, end: passage.start + hl.end, kind: 'match' });
    }
  }
  return spans;
}

/**
 * Which loaded slice to drop when more than `max` are loaded: the one farthest from the slice just added.
 * @param {number[]} loaded slice indexes
 * @param {number} added
 * @param {number} [max]
 * @returns {number|null}
 */
export function chunkToDrop(loaded, added, max = MAX_CHUNKS) {
  if (loaded.length <= max) return null;
  return loaded.reduce((far, i) => (Math.abs(i - added) > Math.abs(far - added) ? i : far), loaded[0]);
}

function renderSlice(slice, spans) {
  return h('div.reader-chunk', { dataset: { start: String(slice.start), end: String(slice.end) } },
    readerSegments(slice.text, slice.start, spans).map((s) => {
      if (!s.kinds.length) return s.text;
      if (s.kinds.includes('match')) return h('mark.hl', { class: { 'in-passage': s.kinds.includes('passage') } }, s.text);
      return h('span.reader-passage', null, s.text);
    }));
}

/**
 * Create a reader for one document.
 * @param {{api: object, documentId: number, passage?: object|null, onClose?: () => void,
 *          announce?: (text: string) => void}} opts
 * @returns {{el: HTMLElement, ready: Promise<void>, loadPrev(): Promise<void>, loadNext(): Promise<void>,
 *            loaded(): number[], destroy(): void}}
 */
export function createReader({ api, documentId, passage = null, onClose = null, announce = () => {} }) {
  const spans = passageSpans(passage);
  const chunks = new Map();          // index → { slice, node }
  let length = null;
  let destroyed = false;
  let busy = false;
  const keyBase = `reader-${documentId}`;

  const title = h('h3.reader-title', null, passage?.document?.title ?? `Document ${documentId}`);
  const dateSlot = h('div.reader-date');
  const status = h('p.reader-status.meta', { role: 'status' });
  const prevBtn = h('button.btn.reader-more', { type: 'button', hidden: true, onClick: () => loadPrev() }, '↑ Earlier text');
  const nextBtn = h('button.btn.reader-more', { type: 'button', hidden: true, onClick: () => loadNext() }, '↓ Later text');
  const pages = h('div.reader-pages');
  const body = h('div.reader-body', { tabindex: '0', 'aria-label': 'Document text' }, prevBtn, pages, nextBtn);
  const note = h('div.reader-note');
  const el = h('section.reader', { 'aria-label': 'Reader' },
    h('header.reader-head', null,
      onClose ? h('button.btn.reader-back', { type: 'button', onClick: onClose }, '← Then · Now · Next') : null,
      h('div.reader-heading', null, title, dateSlot),
      status),
    note,
    body);

  function updateStatus() {
    const idx = [...chunks.keys()].sort((a, b) => a - b);
    if (!idx.length || length === null) return;
    const first = chunks.get(idx[0]).slice.start, last = chunks.get(idx[idx.length - 1]).slice.end;
    status.textContent = `Showing characters ${formatCount(first)}–${formatCount(last)} of ${formatCount(length)}`;
    prevBtn.hidden = first <= 0;
    nextBtn.hidden = last >= length;
  }

  async function load(i) {
    if (destroyed || chunks.has(i) || i < 0 || (length !== null && i * READER_CHUNK >= length && i > 0)) return;
    const req = chunkRequest(i, length);
    const res = await api.get(`/documents/${documentId}/text`, { from: req.from, to: req.to }, { key: `${keyBase}-${i}` });
    if (destroyed) return;
    length = Number.isInteger(res?.length) ? res.length : length ?? (res?.to ?? 0);
    const text = String(res?.text ?? '');
    const from = Number.isInteger(res?.from) ? res.from : req.from;
    const slice = chunkDisplay(i, text, from, length);
    const node = renderSlice(slice, spans);
    const after = [...chunks.keys()].filter((k) => k > i).sort((a, b) => a - b)[0];
    if (after === undefined) pages.appendChild(node);
    else pages.insertBefore(node, chunks.get(after).node);
    chunks.set(i, { slice, node });
    const drop = chunkToDrop([...chunks.keys()], i);
    if (drop !== null) {
      const gone = chunks.get(drop);
      const height = gone.node.offsetHeight ?? 0;
      gone.node.remove();
      chunks.delete(drop);
      if (drop < i && height) body.scrollTop = Math.max(0, body.scrollTop - height);
    }
    updateStatus();
  }

  async function guarded(fn) {
    if (busy || destroyed) return;
    busy = true;
    try { await fn(); } catch (err) {
      if (err?.name === 'AbortError') return;
      clear(note).appendChild(renderErrorCard(err, { what: 'The text could not be loaded.', onRetry: () => { clear(note); guarded(fn); } }));
    } finally { busy = false; }
  }

  function loadPrev() {
    const first = Math.min(...chunks.keys());
    return guarded(async () => { if (Number.isFinite(first)) await load(first - 1); announce('Earlier text loaded'); });
  }
  function loadNext() {
    const last = Math.max(...chunks.keys());
    return guarded(async () => { if (Number.isFinite(last)) await load(last + 1); announce('Later text loaded'); });
  }

  body.addEventListener('scroll', () => {
    if (busy) return;
    if (body.scrollTop < EDGE_PX && !prevBtn.hidden) loadPrev();
    else if (body.scrollHeight - body.scrollTop - body.clientHeight < EDGE_PX && !nextBtn.hidden) loadNext();
  }, { passive: true });

  const ready = (async () => {
    pages.appendChild(renderLoadingLine('Loading the document text…'));
    try {
      const doc = await api.get(`/documents/${documentId}`, null, { key: `${keyBase}-meta` });
      if (destroyed) return;
      title.textContent = doc?.title ?? title.textContent;
      clear(dateSlot).appendChild(renderDateChip(doc?.date_card ?? passage?.document?.date_card ?? null, { isTranslation: false }));
      if (doc?.synthetic) dateSlot.appendChild(synBadge());
      clear(pages);
      if (doc && doc.has_full_text === false) {
        note.appendChild(h('div.state-card.is-empty', { role: 'status' },
          h('p', null, doc.text_note ?? 'No full text is stored for this document; only its metadata.'),
          passage?.text ? h('p.passage-text', null, passage.text) : null));
        return;
      }
      if (Number.isInteger(doc?.length)) length = doc.length;
      const centre = spans[0]?.start ?? 0;
      await load(chunkIndexOf(centre));
      const endChunk = spans[0] ? chunkIndexOf(Math.max(spans[0].start, spans[0].end - 1)) : null;
      if (endChunk !== null && endChunk !== chunkIndexOf(centre)) await load(endChunk);
      if (!chunks.size) status.textContent = 'This document has no text.';
      const target = pages.querySelector('.reader-passage, .hl');
      target?.scrollIntoView?.({ block: 'center' });
      announce(`Reader open: ${title.textContent}`);
    } catch (err) {
      if (err?.name === 'AbortError' || destroyed) return;
      clear(pages);
      note.appendChild(renderErrorCard(err, { what: 'The document could not be opened.' }));
    }
  })();

  return {
    el, ready, loadPrev, loadNext,
    loaded: () => [...chunks.keys()].sort((a, b) => a - b),
    destroy() { destroyed = true; },
  };
}

/**
 * Library module (the inspector embeds the reader): nothing to mount on its own.
 * @param {HTMLElement} el
 * @param {object} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  return { unmount() {} };
}
