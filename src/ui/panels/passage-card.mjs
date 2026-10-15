// OWNER: WP7
// panels/passage-card.mjs — the passage card of the Then column (SPEC §2.D, I2, D4): the document card (title,
// author, date chip, collection, licence, SYN), the passage text in the reading face with every match
// highlighted at its offsets, the "refers to" and "re-read" chips, the field / time-role / quality notes, and
// the machine annotations under "Machine annotations (fallible)". Also the KWIC row used by Compare and by the
// contemporary-uses list. Offsets are UTF-16 code units into `passage.text` (highlights are relative to it).

import { h } from '../core/dom.mjs';
import { formatCount, formatNumber } from '../../shared/format.mjs';
import { renderDateChip } from './date-chip.mjs';

const isHigh = (c) => c >= 0xD800 && c <= 0xDBFF;
const isLow = (c) => c >= 0xDC00 && c <= 0xDFFF;

/**
 * Split a text into plain and highlighted segments. Highlights are clamped to the text, never split a
 * surrogate pair, and overlapping highlights merge into one mark that lists every occurrence it covers.
 * Concatenating the segments' text always gives back `text` exactly.
 * A registered query pins its materialization run (§13 rule 17) while the passage highlights the newest one, so after a
 * later count the selected occurrence id may be absent from the highlights: `selectedSpan` (its offsets relative to the
 * passage text) then marks the highlight that covers the same characters.
 * @param {string} text
 * @param {Array<{start: number, end: number, occ?: number|null, expr?: number|null, variant?: string|null}>} highlights
 * @param {{selectedOcc?: number|null, selectedSpan?: {start: number, end: number}|null}} [opts]
 * @returns {Array<{text: string, start: number, end: number, mark: boolean, occs: number[], exprs: number[],
 *                  variants: string[], selected: boolean}>}
 */
export function highlightSegments(text, highlights, { selectedOcc = null, selectedSpan = null } = {}) {
  const n = text.length;
  const spans = [];
  for (const hl of Array.isArray(highlights) ? highlights : []) {
    let s = Math.max(0, Math.min(n, Math.trunc(Number(hl?.start))));
    let e = Math.max(0, Math.min(n, Math.trunc(Number(hl?.end))));
    if (!Number.isFinite(s) || !Number.isFinite(e) || s >= e) continue;
    if (s > 0 && isLow(text.charCodeAt(s)) && isHigh(text.charCodeAt(s - 1))) s -= 1;
    if (e < n && isLow(text.charCodeAt(e)) && isHigh(text.charCodeAt(e - 1))) e += 1;
    spans.push({ s, e, hl });
  }
  spans.sort((a, b) => a.s - b.s || a.e - b.e);
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp.s < last.e) { last.e = Math.max(last.e, sp.e); last.hls.push(sp.hl); }
    else merged.push({ s: sp.s, e: sp.e, hls: [sp.hl] });
  }
  const out = [];
  let at = 0;
  const plain = (s, e) => { if (e > s) out.push({ text: text.slice(s, e), start: s, end: e, mark: false, occs: [], exprs: [], variants: [], selected: false }); };
  for (const m of merged) {
    plain(at, m.s);
    const occs = m.hls.map((x) => x?.occ).filter((x) => Number.isInteger(x));
    out.push({
      text: text.slice(m.s, m.e), start: m.s, end: m.e, mark: true, occs,
      exprs: [...new Set(m.hls.map((x) => x?.expr).filter((x) => Number.isInteger(x)))],
      variants: [...new Set(m.hls.map((x) => x?.variant).filter((x) => typeof x === 'string'))],
      selected: (selectedOcc !== null && occs.includes(selectedOcc))
        || (selectedSpan !== null && m.s <= selectedSpan.start && selectedSpan.end <= m.e && selectedSpan.start < selectedSpan.end),
    });
    at = m.e;
  }
  plain(at, n);
  return out;
}

/** 'community:hiphop' → 'hiphop' (the facet value; lane headers carry the full label). */
export function laneValue(key) {
  const s = String(key ?? '');
  const i = s.indexOf(':');
  return i < 0 ? s : s.slice(i + 1);
}

const FIELD_NOTES = Object.freeze({
  title: 'title field',
  native_title: 'title in the original script',
  summary: 'summary field',
  abstract: 'abstract field',
  gloss: 'gloss field',
  entry: 'dictionary entry',
});

/**
 * Plain-language notes about where this text sits: non-body fields, retrospective descriptions, apparatus,
 * excluded qualities (§13 rule 9: default exclusions are visible).
 * @param {object} p a Passage
 * @returns {string[]}
 */
export function passageNotes(p) {
  const notes = [];
  if (p.field && p.field !== 'body') notes.push(FIELD_NOTES[p.field] ?? `${p.field} field`);
  if (p.time_role === 'describes') notes.push('describes the work and is not dated with it; excluded from counts by default');
  if (p.time_role === 'apparatus') notes.push('editorial apparatus; excluded from counts by default');
  if (p.quality && p.quality !== 'ok') notes.push(`quality: ${p.quality.replace(/_/g, ' ')}; excluded from counts by default`);
  if (p.document?.is_translation) notes.push('a translation: excluded from text-language chronology by default');
  return notes;
}

/**
 * The model of a passage card (strings and flags only).
 * @param {object} p a Passage (GET /api/passages/:id)
 * @param {{selectedOcc?: number|null, selectedSpan?: {start: number, end: number}|null}} [opts]
 */
export function passageCardModel(p, { selectedOcc = null, selectedSpan = null } = {}) {
  const doc = p.document ?? {};
  const referenced = p.refers_to?.label
    ?? (Array.isArray(doc.dates) ? doc.dates.find((d) => d.role === 'referenced')?.label : null) ?? null;
  const machine = (Array.isArray(p.machine) ? p.machine : []).map((m) => ({
    label: String(m.label ?? m.kind ?? 'machine annotation'),
    humanLabel: m.human_label ?? null,
    meta: [m.kind, Number.isInteger(m.run) ? `run ${m.run}` : null, typeof m.margin === 'number' ? `margin ${formatNumber(m.margin)}` : null]
      .filter(Boolean).join(' · '),
  }));
  const rel = p.relationships ?? null;
  return {
    id: p.id,
    title: doc.title ?? '(untitled)',
    author: doc.author ?? null,
    kind: doc.kind ?? null,
    collection: doc.collection ?? null,
    license: doc.license ?? null,
    synthetic: p.synthetic === true || doc.synthetic === true,
    isTranslation: doc.is_translation === true,
    dateCard: doc.date_card ?? null,
    referenced,
    reread: p.reread?.label ?? null,
    lang: p.lang ?? null,
    notes: passageNotes(p),
    segments: highlightSegments(String(p.text ?? ''), p.highlights, { selectedOcc, selectedSpan }),
    machine,
    counts: {
      out: Number.isInteger(rel?.out) ? rel.out : null,
      in: Number.isInteger(rel?.in) ? rel.in : null,
      annotations: Number.isInteger(p.annotations) ? p.annotations : null,
    },
    offsets: { start: p.start, end: p.end, field: p.field },
  };
}

/** The SYN badge (§8.7): a word, never colour alone. */
export function synBadge() {
  return h('span.badge.badge-syn', { title: 'synthetic: invented demonstration material', 'aria-label': 'synthetic' }, 'SYN');
}

/**
 * The document card: title, author, kind, the date chip with role and flags, collection, licence, SYN.
 * @param {ReturnType<typeof passageCardModel>} m
 * @returns {HTMLElement}
 */
export function renderDocCard(m) {
  return h('header.doc-card', null,
    h('div.doc-title-row', null,
      h('h3.doc-title', null, m.title),
      m.synthetic ? synBadge() : null),
    m.author || m.kind ? h('p.doc-byline', null, [m.author, m.kind].filter(Boolean).join(' · ')) : null,
    h('div.doc-date', null, renderDateChip(m.dateCard, { isTranslation: m.isTranslation })),
    h('p.doc-meta.meta', null, [m.collection ? `collection ${m.collection}` : null, m.license ? `licence ${m.license}` : null,
      m.lang ? `language ${m.lang}` : null].filter(Boolean).join(' · ')));
}

/**
 * The passage text with its highlights (amber marks; the selected occurrence carries the cyan ring), plus the
 * neighbouring passages when they were requested.
 * @param {object} p
 * @param {ReturnType<typeof passageCardModel>} m
 * @returns {HTMLElement}
 */
export function renderPassageText(p, m) {
  const body = h('p.passage-text', { lang: p.lang && !/^und/.test(p.lang) ? p.lang : null },
    m.segments.map((s) => (s.mark
      ? h('mark.hl', { class: { 'is-selected': s.selected }, dataset: { start: String(s.start), end: String(s.end) },
        title: s.variants.length ? `match: ${s.variants.join(', ')}` : null }, s.text)
      : s.text)));
  const ctxPara = (side, x) => (x && typeof x.text === 'string'
    ? h('p.passage-context', { dataset: { side } }, x.text) : null);
  return h('div.passage', { dataset: { passage: String(p.id) } },
    ctxPara('before', p.before),
    body,
    ctxPara('after', p.after));
}

/**
 * Machine annotations under their fixed heading (§2.D, §13 rule 10). The machine label stays visible after
 * a person renames it.
 * @param {ReturnType<typeof passageCardModel>} m
 * @returns {HTMLElement|null}
 */
export function renderMachineAnnotations(m) {
  if (!m.machine.length) return null;
  return h('section.machine-notes', { 'aria-label': 'Machine annotations (fallible)' },
    h('h4.section-title', null, 'Machine annotations (fallible)'),
    h('ul.machine-list', { role: 'list' }, m.machine.map((x) => h('li', null,
      h('span.machine-label', null, x.label),
      x.humanLabel ? h('span.human-label', null, ` — renamed by a reader: ${x.humanLabel}`) : null,
      x.meta ? h('span.meta', null, ` (${x.meta})`) : null))));
}

/**
 * The whole passage card.
 * @param {object} p a Passage
 * @param {{selectedOcc?: number|null, selectedSpan?: {start: number, end: number}|null, actions?: Node|null}} [opts]
 * @returns {HTMLElement}
 */
export function renderPassageCard(p, { selectedOcc = null, selectedSpan = null, actions = null } = {}) {
  const m = passageCardModel(p, { selectedOcc, selectedSpan });
  const chips = [
    m.referenced ? h('span.chip.chip-refers', null, `refers to ${m.referenced}`) : null,
    m.reread ? h('span.chip.chip-reread', null, m.reread) : null,
  ].filter(Boolean);
  return h('article.passage-card', { class: { 'syn-frame': m.synthetic }, dataset: { passage: String(m.id) } },
    renderDocCard(m),
    chips.length ? h('div.chip-row', null, chips) : null,
    m.notes.length ? h('ul.passage-notes', { role: 'list' }, m.notes.map((n) => h('li.meta', null, n))) : null,
    renderPassageText(p, m),
    h('p.meta.passage-offsets', null,
      `${m.offsets.field ?? 'body'} · characters ${formatCount(m.offsets.start)}–${formatCount(m.offsets.end)} of the original`),
    actions,
    renderMachineAnnotations(m));
}

/**
 * One KWIC row as a button that opens its passage: left context, match, right context, then title · date ·
 * lane · SYN.
 * @param {{passage: number, left: string, match: string, right: string, title?: string, date?: {label: string},
 *          lane?: string, synthetic?: boolean}} row
 * @param {{onOpen?: (passageId: number) => void}} [opts]
 * @returns {HTMLElement}
 */
export function renderKwicRow(row, { onOpen = null } = {}) {
  const meta = [row.title, row.date?.label, row.lane ? laneValue(row.lane) : null].filter(Boolean).join(' · ');
  return h('li.kwic-item', null,
    h('button.kwic-row', { type: 'button', dataset: { passage: String(row.passage) }, onClick: () => onOpen?.(row.passage) },
      h('span.kwic-line', null,
        h('span.kwic-left', null, String(row.left ?? '').replace(/\s+/g, ' ')),
        h('mark.hl', null, row.match),
        h('span.kwic-right', null, String(row.right ?? '').replace(/\s+/g, ' '))),
      h('span.kwic-meta.meta', null, meta, row.synthetic ? ' · ' : null, row.synthetic ? synBadge() : null)));
}

/**
 * Library module: nothing to mount on its own.
 * @param {HTMLElement} el
 * @param {object} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  return { unmount() {} };
}
