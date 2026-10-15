// OWNER: WP7
// panels/notebook.mjs — the interpretation notebook (SPEC §2.F, `N`). Lists the annotations on the selected
// target (GET /api/annotations?target=…), with superseded layers on request, an "as of" date (the vantage clock
// for human readings), search, and grouping by layer or author to compare interpretations side by side.
// Human annotations can be edited (a new revision), reinterpreted (a new annotation that supersedes) or
// withdrawn; nothing is deleted. Machine annotations are listed apart under "Machine annotations (fallible)"
// and can only be countered. Hypotheses are dashed violet cards that say "not evidence". Superseded layers show by
// default ("Layer 'Reader A, 2026-10-03' — superseded 2026-11-12"); the as-of slider steps through the dates when
// interpretations were written, revised or superseded. Evidence chips (amber = for, struck grey = against) open
// their passages; when interpretations are compared side by side, evidence they share is marked in each column.
// A context group as the target (a cluster lane's Rename) shows the group block first: its labels, its share over
// time and the rename control (context-group.mjs).

import { h, clear } from '../core/dom.mjs';
import { asSavedParams } from './views-menu.mjs';
import { formatCount, refWords } from '../../shared/format.mjs';
import { MACHINE_ANNOTATION_KINDS } from '../../shared/vocab.mjs';
import { createAnnotationEditor, HUMAN_KINDS, KIND_LABELS } from './annotation-editor.mjs';
import { exportUrl } from './export-menu.mjs';
import { renderEmptyCard, renderErrorCard, renderLoadingLine } from './gate-card.mjs';
import { createRevisions } from './revisions.mjs';
import { synBadge } from './passage-card.mjs';
import { selectPassage } from './inspector.mjs';
import { createGroupBlock, GROUP_CAPTION } from './context-group.mjs';

export const GROUPINGS = Object.freeze(['none', 'layer', 'author']);

/**
 * The annotation target of a selection: passage, document, relationship, cluster; an occurrence through its
 * known passage.
 * @param {{type: string, id: number|string}|null} selection
 * @param {{selectionContext?: {occ?: number, passage?: number}}} [ui]
 * @returns {string|null}
 */
export function targetForSelection(selection, ui = {}) {
  if (!selection) return null;
  if (selection.type === 'occurrence') {
    const c = ui.selectionContext;
    return c?.occ === selection.id && Number.isInteger(c.passage) ? `passage:${c.passage}` : null;
  }
  if (['passage', 'document', 'relationship', 'cluster'].includes(selection.type)) return `${selection.type}:${selection.id}`;
  return null;
}

/**
 * GET /api/annotations query.
 * @param {string} target
 * @param {{superseded?: boolean, asOf?: string|null, q?: string}} [opts]
 */
export function annotationsQuery(target, { superseded = false, asOf = null, q = '', kind = '', contradicted = false } = {}) {
  const out = { target, include: superseded ? 'superseded' : null, as_of: asOf || null, q: q.trim() || null, limit: 200 };
  if (kind) out.kind = kind;
  if (contradicted) out.contradicted = 1;
  return out;
}

/**
 * The dates the as-of slider stops at: every day an interpretation was written, revised, superseded or
 * withdrawn (YYYY-MM-DD, ascending).
 * @param {object[]} items
 * @returns {string[]}
 */
export function asOfStops(items) {
  const days = new Set();
  for (const a of items ?? []) {
    for (const t of [a.created_at, a.rev_at, a.superseded_at, a.withdrawn_at]) if (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t)) days.add(t.slice(0, 10));
  }
  return [...days].sort();
}

/**
 * The historical-layer line of a superseded or withdrawn annotation: "Layer 'Reader A, 2026-10-03' — superseded
 * 2026-11-12" (the layer name, else the author and the day it was written).
 * @param {object} a
 * @returns {string|null}
 */
export function layerLine(a) {
  if (a.status !== 'superseded' && a.status !== 'withdrawn') return null;
  const name = a.layer ?? `${a.author ?? 'unknown'}, ${String(a.created_at ?? '').slice(0, 10)}`;
  const when = String((a.status === 'superseded' ? a.superseded_at : a.withdrawn_at) ?? '').slice(0, 10);
  return `Layer '${name}' — ${a.status}${when ? ` ${when}` : ''}${a.status === 'superseded' && a.superseded_by ? ` by ${a.superseded_by}` : ''}`;
}

/** Stable key of an evidence reference (to find evidence two interpretations share). */
export function evidenceKey(r) {
  return `${r.type}:${r.id}${Number.isInteger(r.start) ? `:${r.start}-${r.end}` : ''}`;
}

/**
 * Evidence keys cited by annotations in at least two of the compared groups.
 * @param {Array<{items: object[]}>} groups
 * @returns {Set<string>}
 */
export function sharedEvidence(groups) {
  if (groups.length < 2) return new Set();
  const seen = new Map();
  groups.forEach((g, i) => {
    for (const a of g.items) for (const r of a.evidence_refs ?? []) {
      const k = evidenceKey(r);
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k).add(i);
    }
  });
  return new Set([...seen].filter(([, s]) => s.size > 1).map(([k]) => k));
}

/** Human and machine annotations, apart (§2.F). */
export function splitMachine(items) {
  const machine = [], human = [];
  for (const a of items ?? []) (a.is_machine || MACHINE_ANNOTATION_KINDS.includes(a.kind) ? machine : human).push(a);
  return { human, machine };
}

/**
 * Group annotations into columns by layer or author (compare interpretations).
 * @param {object[]} items
 * @param {'none'|'layer'|'author'} by
 * @returns {Array<{key: string, items: object[]}>}
 */
export function groupAnnotations(items, by) {
  if (by === 'none') return [{ key: 'all', items }];
  const groups = new Map();
  for (const a of items) {
    const k = (by === 'layer' ? a.layer : a.author) ?? (by === 'layer' ? 'no layer' : 'unknown');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  return [...groups].map(([key, list]) => ({ key, items: list }));
}

/** The label of a hypothesis card: the server's, else "Hypothesis — by X, date — not evidence". */
export function hypothesisLabel(a) {
  return a.label ?? `Hypothesis — by ${a.author ?? 'unknown'}, ${String(a.created_at ?? '').slice(0, 10)} — not evidence`;
}

/**
 * Mount the notebook into #panel.
 * @param {HTMLElement} el
 * @param {{store: object, api: object, keys?: object, announce?: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api, keys } = ctx;
  const announce = ctx.announce ?? (() => {});
  const local = { items: null, error: null, loading: false, seq: 0, superseded: true, asOf: '', q: '', group: 'none', kind: '', contradicted: false,
    full: false, passage: null, compose: null, editing: null, revisions: new Map(), withdrawArmed: null, lastKey: null, stops: new Set() };
  const root = h('div.notebook', { hidden: true });
  el.appendChild(root);
  const isOpen = () => store.get().view.panels.right === 'notebook';
  const target = () => store.get().ui.notebookTarget ?? targetForSelection(store.get().view.selection, store.get().ui);
  local.cg = null;

  /**
   * A context group as the target (a cluster lane's Rename, contract 1.3.0 C1): its block — machine label and any
   * reader's label, share over time, rename — above its annotations. The group is looked up in the pinned
   * expression's clustering run (the lanes' run when the view pins one).
   */
  async function loadGroup(t) {
    const m = /^cluster:(\d+)$/.exec(t ?? '');
    const v = store.get().view;
    const ex = (v.strands ?? []).filter((x) => x.type === 'expression');
    if (!m || ex.length !== 1) { local.cg = null; return; }
    const id = Number(m[1]);
    if (local.cg?.id === id && local.cg.state !== 'error') return;
    local.cg = { id, state: 'loading', block: null };
    try {
      const data = await api.get('/clusters', { expr: ex[0].id, run: v.lanes?.facet === 'cluster' ? v.lanes.run ?? null : null }, { key: 'notebook-group' });
      if (local.cg?.id !== id) return;
      const c = (data?.clusters ?? []).find((x) => x.id === id) ?? null;
      if (!c) { local.cg = { id, state: 'missing', run: data?.run ?? null }; render(); return; }
      const block = createGroupBlock({ api, cluster: c, data, announce, compact: true,
        onRenamed: () => { load({ force: true }); refreshGroup(id, ex[0].id); } });
      local.cg = { id, state: 'ok', block };
    } catch (err) {
      if (err?.name === 'AbortError' || local.cg?.id !== id) return;
      local.cg = { id, state: 'error', error: err };
    }
    render();
  }

  async function refreshGroup(id, expr) {
    try {
      const v = store.get().view;
      const data = await api.get('/clusters', { expr, run: v.lanes?.facet === 'cluster' ? v.lanes.run ?? null : null }, { key: 'notebook-group' });
      const c = (data?.clusters ?? []).find((x) => x.id === id);
      if (c && local.cg?.id === id && local.cg.block) local.cg.block.update({ cluster: c, data });
    } catch { /* the block keeps the label it saved */ }
  }

  function renderGroupBlock() {
    const g = local.cg;
    if (!g) return null;
    if (g.state === 'loading') return renderLoadingLine('Reading the context group…');
    if (g.state === 'error') return renderErrorCard(g.error, { what: 'The context group could not be loaded.' });
    if (g.state === 'missing') return h('p.meta', null, `Context group ${g.id} is not in the expression's ${Number.isInteger(g.run) ? `run #${g.run}` : 'latest run'}; its annotations are listed below.`);
    return h('section.nb-cgroup', { 'aria-label': 'The context group' }, g.block.el, h('p.meta', null, GROUP_CAPTION));
  }

  async function load({ force = false } = {}) {
    if (!isOpen()) return;
    const t = target();
    if (!t) { local.items = null; local.cg = null; render(); return; }
    loadGroup(t);
    const q = annotationsQuery(t, { superseded: local.superseded, asOf: local.asOf, q: local.q, kind: local.kind, contradicted: local.contradicted });
    const key = JSON.stringify(q);
    if (!force && key === local.lastKey && (local.items || local.loading)) { render(); return; }
    if (local.lastTarget !== t) { local.stops = new Set(); local.lastTarget = t; }
    local.lastKey = key;
    const seq = ++local.seq;
    local.loading = true; local.error = null;
    render();
    try {
      const [res, passage] = await Promise.all([
        api.get('/annotations', { ...q, ...asSavedParams(store.get().ui.savedView, 'annotations') }, { key: 'notebook' }),
        /^passage:\d+$/.test(t) && local.passage?.id !== Number(t.slice(8))
          ? api.get(`/passages/${t.slice(8)}`, null, { key: 'notebook-passage' }).catch(() => null) : Promise.resolve(local.passage),
      ]);
      if (seq !== local.seq) return;
      local.items = Array.isArray(res?.items) ? res.items : [];
      for (const d of asOfStops(local.items)) local.stops.add(d);
      local.passage = passage ?? null;
      local.loading = false;
      render();
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq) return;
      local.error = err; local.loading = false; local.lastKey = null;
      render();
    }
  }

  const refresh = () => { local.compose = null; local.editing = null; load({ force: true }); };

  async function withdraw(a) {
    try {
      await api.post(`/annotations/${a.id}/withdraw`, null, { key: `ann-withdraw-${a.id}` });
      announce(`Annotation ${a.id} withdrawn; it stays in the record`);
      local.withdrawArmed = null;
      refresh();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      store.dispatch({ type: 'UI_TOAST', toast: { kind: 'error', text: err.message, hint: err.hint ?? null } });
    }
  }

  function editorFor(mode, a, kind) {
    return createAnnotationEditor({ api, target: target(), passage: local.passage, mode, annotation: a, kind, announce,
      onSaved: refresh, onCancel: () => { local.compose = null; local.editing = null; render(); } }).el;
  }

  function openRef(r) {
    if (r.type === 'passage') selectPassage(store, { passage: r.id });
    else if (r.type === 'document') store.dispatch({ type: 'SELECT', selection: { type: 'document', id: r.id } });
    else if (r.type === 'relationship') store.dispatch({ type: 'SELECT', selection: { type: 'relationship', id: r.id } });
  }

  function renderEvidence(a, shared) {
    const refs = a.evidence_refs ?? [];
    if (!refs.length) return null;
    return h('ul.ev-chips', { role: 'list', 'aria-label': 'Evidence for and against' }, refs.map((r) => {
      const against = r.role === 'contradicting';
      const isShared = shared.has(evidenceKey(r));
      const where = `${r.type} ${r.id}${Number.isInteger(r.start) ? ` · ${r.start}–${r.end}` : ''}`;
      return h('li', null, h('button.chip.ev-chip', { type: 'button', class: { 'is-against': against, 'is-for': !against, 'is-shared': isShared },
        dataset: { role: against ? 'contradicting' : 'supporting' }, disabled: !['passage', 'document', 'relationship'].includes(r.type),
        onClick: () => openRef(r) },
      h('span.ev-chip-role', null, against ? 'against' : 'for'), ' ',
      r.quote ? h('q', null, r.quote.length > 60 ? `${r.quote.slice(0, 59)}…` : r.quote) : null, r.quote ? ' ' : null,
      h('span.ev-chip-where', null, where), isShared ? h('span.ev-chip-shared', null, ' · shared') : null));
    }));
  }

  function renderCard(a, { machine = false, shared = new Set() } = {}) {
    const hypothesis = a.kind === 'hypothesis';
    const status = a.status ?? 'active';
    const dims = Object.entries(a.dimensions ?? {});
    const revOpen = local.revisions.get(a.id);
    const total = Number.isInteger(a.revisions) ? a.revisions : a.rev ?? 1;
    const layer = layerLine(a);
    return h('article.ann-card', { class: { 'is-hypothesis': hypothesis, 'is-machine': machine, 'syn-frame': a.synthetic === true, 'is-layer': Boolean(layer) },
      dataset: { annotation: String(a.id), status, kind: a.kind } },
      layer ? h('p.ann-layer-line', null, layer) : null,
      h('header.ann-head', null,
        h('strong', null, hypothesis ? hypothesisLabel(a) : (KIND_LABELS[a.kind] ?? a.kind.replace(/_/g, ' ')).split(' (')[0]),
        h('span.meta', null, ` · ${a.author ?? '—'}${a.layer ? ` · layer “${a.layer}”` : ''} · rev ${a.rev ?? 1} of ${total} · ${String(a.created_at ?? '').slice(0, 10)}`),
        status !== 'active' && !layer ? h('span.chip.ann-status', null, status) : null,
        a.contradicted ? h('span.chip.ann-contra', null, 'has evidence against') : null,
        machine && a.method ? h('span.chip', null, `method: ${a.method}`) : null,
        a.synthetic ? synBadge() : null),
      a.anchor?.quote ? h('blockquote.ann-quote', null, a.anchor.quote) : null,
      h('p.ann-body', null, a.body_md),
      dims.length ? h('ul.tag-list', { role: 'list' }, dims.map(([k, v]) => h('li.chip', null, `${k.replace(/_/g, ' ')}: ${v}`))) : null,
      (a.tags ?? []).length ? h('ul.tag-list', { role: 'list' }, a.tags.map((t) => h('li.chip', null, `#${t}`))) : null,
      renderEvidence(a, shared),
      machine
        ? h('div.edge-actions', null, h('button.btn', { type: 'button', onClick: () => { local.compose = { kind: 'evidence_against' }; render(); } }, 'Counter (evidence against)'))
        : h('div.edge-actions', null,
          status === 'active' ? h('button.btn', { type: 'button', onClick: () => { local.editing = { mode: 'edit', a }; render(); } }, 'Edit') : null,
          status === 'active' ? h('button.btn', { type: 'button', onClick: () => { local.editing = { mode: 'reinterpret', a }; render(); } }, 'Reinterpret') : null,
          status !== 'active' ? null : local.withdrawArmed === a.id
            ? h('button.btn.is-danger', { type: 'button', onClick: () => withdraw(a) }, 'Confirm withdraw (kept in the record)')
            : h('button.btn', { type: 'button', onClick: () => { local.withdrawArmed = a.id; render(); } }, 'Withdraw'),
          h('button.btn', { type: 'button', 'aria-expanded': String(Boolean(revOpen)), onClick: () => {
            if (revOpen) local.revisions.delete(a.id); else local.revisions.set(a.id, createRevisions({ api, annotationId: a.id }));
            render();
          } }, revOpen ? 'Hide revisions' : 'Revisions')),
      revOpen ? revOpen.el : null,
      local.editing?.a?.id === a.id ? editorFor(local.editing.mode, a) : null);
  }

  function renderAsOf() {
    const stops = [...local.stops].sort();
    const i = local.asOf ? Math.max(0, stops.indexOf(local.asOf)) : stops.length;
    const label = local.asOf ? `As of ${local.asOf}: the interpretations that existed then, with the text they had then` : 'As of now: every interpretation, as it reads today';
    const slider = stops.length ? h('input.nb-asof-slider', { type: 'range', min: '0', max: String(stops.length), step: '1', value: String(i),
      'aria-label': 'As of (the vantage clock for interpretations)', 'aria-valuetext': local.asOf || 'now',
      onChange: (e) => { const k = Number(e.target.value); local.asOf = k >= stops.length ? '' : stops[k]; load(); } }) : null;
    const date = h('input', { type: 'date', value: local.asOf, 'aria-label': 'As of a chosen date',
      onChange: (e) => { local.asOf = e.target.value; load(); } });
    return h('div.nb-asof', { role: 'group', 'aria-label': 'As of' },
      h('span.nb-asof-label', null, label),
      slider ? h('div.nb-asof-row', null, h('span.meta', null, stops[0] ?? ''), slider, h('span.meta', null, 'now')) : null,
      h('label.meta', null, 'or a date ', date));
  }

  function render() {
    root.hidden = !isOpen();
    clear(root);
    if (!isOpen()) return;
    root.classList.toggle('is-full', local.full);
    const t = target();
    root.appendChild(h('header.cmp-head', null,
      h('button.btn.cmp-back', { type: 'button', onClick: () => store.dispatch({ type: 'CLOSE_PANEL', panel: 'notebook' }), 'aria-label': 'Close the notebook' }, '← Back'),
      h('div.cmp-heading', null, h('h2.cmp-h', null, 'Notebook — interpretations'), h('p.cmp-sub', null, t ? refWords(t) : 'nothing selected')),
      h('button.btn', { type: 'button', 'aria-pressed': String(local.full), onClick: () => { local.full = !local.full; render(); } }, local.full ? 'Drawer' : 'Full page')));
    if (!t) { root.appendChild(renderEmptyCard('Select a passage, document, relationship or context group to annotate it (N).')); return; }
    const groupBlock = renderGroupBlock();
    if (groupBlock) root.appendChild(groupBlock);
    const search = h('input', { type: 'search', value: local.q, placeholder: 'Search notes and tags', 'aria-label': 'Search annotations',
      onKeyDown: (e) => { if (e.key === 'Enter') { local.q = e.target.value; load(); } } });
    root.appendChild(h('div.nb-controls', null,
      h('label.lin-check', null, h('input', { type: 'checkbox', checked: local.superseded, onChange: (e) => { local.superseded = e.target.checked; load(); } }), ' show superseded layers'),
      search,
      h('label', null, 'Kind ', h('select', { 'aria-label': 'Kind of annotation', onChange: (e) => { local.kind = e.target.value; load(); } },
        h('option', { value: '' }, 'any'), HUMAN_KINDS.map((k) => h('option', { value: k, selected: local.kind === k }, KIND_LABELS[k]?.split(' (')[0] ?? k)))),
      h('label.lin-check', null, h('input', { type: 'checkbox', checked: local.contradicted, onChange: (e) => { local.contradicted = e.target.checked; load(); } }), ' has evidence against'),
      h('label', null, 'Compare by ', h('select', { 'aria-label': 'Group annotations', onChange: (e) => { local.group = e.target.value; render(); } },
        GROUPINGS.map((g) => h('option', { value: g, selected: g === local.group }, g === 'none' ? 'no grouping' : g)))),
      h('button.btn.btn-primary', { type: 'button', onClick: () => { local.compose = { kind: 'interpretation' }; render(); } }, 'New annotation'),
      h('a.btn', { href: exportUrl({ view: store.get().view, what: 'annotations', format: 'jsonl' }), download: 'scrolls-annotations.jsonl' }, 'Export (JSONL, every revision)')));
    root.appendChild(renderAsOf());
    if (local.compose) root.appendChild(editorFor('create', null, local.compose.kind));
    if (local.error) { root.appendChild(renderErrorCard(local.error, { onRetry: () => load({ force: true }) })); return; }
    if (local.loading && !local.items) { root.appendChild(renderLoadingLine('Loading annotations…')); return; }
    const { human, machine } = splitMachine(local.items ?? []);
    if (!human.length) root.appendChild(renderEmptyCard(local.asOf ? `No interpretations existed on ${local.asOf}.` : 'No annotations on this target yet.'));
    else {
      const groups = groupAnnotations(human, local.group);
      const shared = local.group === 'none' ? new Set() : sharedEvidence(groups);
      root.appendChild(h('div.nb-groups', { class: { 'is-columns': local.group !== 'none' } }, groups.map((g) => h('section.nb-group', { 'aria-label': g.key },
        local.group !== 'none' ? h('h3.section-title', null, `${g.key} (${formatCount(g.items.length)})`) : null,
        g.items.map((a) => renderCard(a, { shared }))))));
      if (shared.size) root.appendChild(h('p.meta', null, `${formatCount(shared.size)} piece${shared.size === 1 ? '' : 's'} of evidence cited in more than one column (marked “shared”).`));
    }
    if (machine.length) {
      root.appendChild(h('section.nb-machine', { 'aria-label': 'Machine annotations (fallible)' },
        h('h3.section-title', null, 'Machine annotations (fallible)'),
        machine.map((a) => renderCard(a, { machine: true }))));
    }
  }

  const unkeys = keys?.register?.('global', { n: { run: () => {
    store.dispatch({ type: 'OPEN_PANEL', panel: 'notebook' });
    local.compose = { kind: 'interpretation' };
    render();
  }, label: 'Annotate the selection (Notebook)' } }) ?? (() => {});
  const unsubs = [
    store.subscribe((s) => s.view.panels.right, () => { load(); render(); }),
    store.subscribe((s) => s.view.selection, () => { local.compose = null; local.editing = null; load(); }),
    store.subscribe((s) => s.ui.notebookTarget, () => load()),
    store.subscribe((s) => s.ui.notebookCompose, (c) => { if (c?.kind) { local.compose = { kind: c.kind }; store.dispatch({ type: 'OPEN_PANEL', panel: 'notebook' }); render(); } }),
  ];
  if (isOpen()) load();
  render();
  return { unmount() { unkeys(); for (const u of unsubs) u(); local.seq++; root.remove(); } };
}
