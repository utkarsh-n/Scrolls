// OWNER: WP7
// panels/revisions.mjs — annotation revisions (SPEC §2.F "rev 3 of 3", a revision scrubber and a word-level
// diff). Revisions are append-only on the server; this view only reads GET /api/annotations/:id/revisions.

import { h, clear } from '../core/dom.mjs';
import { alignTokens } from './edge-card.mjs';
import { renderErrorCard, renderLoadingLine } from './gate-card.mjs';

/**
 * Word-level diff of two revision bodies.
 * @param {string} before
 * @param {string} after
 * @returns {Array<{op: 'same'|'sub'|'ins'|'del', a: string|null, b: string|null}>}
 */
export function revisionDiff(before, after) {
  return alignTokens(before ?? '', after ?? '');
}

/** "rev 2 of 3" */
export function revLabel(rev, total) {
  return `rev ${rev} of ${total}`;
}

/** Words for what changed besides the body: dimensions and tags. */
export function metaChanges(prev, next) {
  if (!prev) return [];
  const out = [];
  const dims = new Set([...Object.keys(prev.dimensions ?? {}), ...Object.keys(next.dimensions ?? {})]);
  for (const d of dims) {
    const a = prev.dimensions?.[d], b = next.dimensions?.[d];
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${d.replace(/_/g, ' ')}: ${a ?? '—'} → ${b ?? '—'}`);
  }
  const ta = (prev.tags ?? []).join(', '), tb = (next.tags ?? []).join(', ');
  if (ta !== tb) out.push(`tags: ${ta || '—'} → ${tb || '—'}`);
  return out;
}

/**
 * Render one revision against the one before it.
 * @param {object[]} revs all revisions, oldest first
 * @param {number} index
 */
export function renderRevision(revs, index) {
  const r = revs[index];
  const prev = index > 0 ? revs[index - 1] : null;
  const diff = prev ? revisionDiff(prev.body_md, r.body_md) : null;
  return h('div.rev-view', { dataset: { rev: String(r.rev) } },
    h('p.meta', null, `${revLabel(r.rev, revs.length)} · ${r.author ?? '—'} · ${String(r.at ?? '').slice(0, 10)}${r.reason ? ` · reason: ${r.reason}` : ''}`),
    diff
      ? h('p.rev-diff', null, diff.map((o) => (o.op === 'same' ? `${o.b} `
        : o.op === 'del' ? h('del.tok.tok-del', null, o.a, ' ')
          : o.op === 'ins' ? h('ins.tok.tok-ins', null, o.b, ' ')
            : [h('del.tok.tok-del', null, o.a, ' '), h('ins.tok.tok-sub', null, o.b, ' ')])))
      : h('p.rev-body', null, r.body_md),
    metaChanges(prev, r).length ? h('ul.rev-meta', { role: 'list' }, metaChanges(prev, r).map((c) => h('li.meta', null, c))) : null);
}

/**
 * A revisions viewer with a scrubber (a range input: keyboard and touch, no hover).
 * @param {{api: object, annotationId: number}} opts
 * @returns {{el: HTMLElement, ready: Promise<void>}}
 */
export function createRevisions({ api, annotationId }) {
  const el = h('section.revisions', { 'aria-label': `Revisions of annotation ${annotationId}` }, renderLoadingLine('Loading revisions…'));
  const ready = (async () => {
    try {
      const revs = await api.get(`/annotations/${annotationId}/revisions`, null, { key: `revisions-${annotationId}` });
      const list = Array.isArray(revs) ? [...revs].sort((a, b) => a.rev - b.rev) : [];
      clear(el);
      if (!list.length) { el.appendChild(h('p.meta', null, 'No revisions recorded.')); return; }
      const slot = h('div.rev-slot');
      const show = (i) => { clear(slot).appendChild(renderRevision(list, i)); };
      const scrub = h('input.rev-scrubber', { type: 'range', min: '0', max: String(list.length - 1), step: '1', value: String(list.length - 1),
        'aria-label': 'Revision', 'aria-valuetext': revLabel(list[list.length - 1].rev, list.length),
        onInput: (e) => { const i = Number(e.target.value); e.target.setAttribute('aria-valuetext', revLabel(list[i].rev, list.length)); show(i); } });
      el.append(...[h('h4.section-title', null, 'Revisions'), list.length > 1 ? scrub : null, slot].filter(Boolean));
      show(list.length - 1);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      clear(el).appendChild(renderErrorCard(err));
    }
  })();
  return { el, ready };
}

/**
 * Library module (the notebook embeds revisions): nothing to mount on its own.
 * @param {HTMLElement} el
 * @param {object} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  return { unmount() {} };
}
