// OWNER: WP7
// panels/views-menu.mjs — saved views (SPEC §2, §7.2 views, §8.2, D17): save the current view (immutable; a
// re-save makes a new slug), open a saved view, and the "as saved" banner that says when the corpus changed
// since the view was saved and switches between "as saved" and current data. Opening goes through the URL
// ('#view=<slug>[&as=1]'), which core/url.mjs and main.mjs resolve. Also exports createMenu(), the toolbar
// popover the export menu uses too: a dialog under its button on desktop, a bottom sheet on narrow screens,
// opened and closed by click, tap, keyboard (Esc) — never by hover.

import { h, clear } from '../core/dom.mjs';
import { floatPopover } from '../shell/layout.mjs';
import { scrollHub } from '../timeline/viewport.mjs';
import { formatCount } from '../../shared/format.mjs';
import { stateHash } from '../../shared/viewstate.mjs';
import { renderEmptyCard, renderErrorCard, renderLoadingLine } from './gate-card.mjs';
import { synBadge } from './passage-card.mjs';

let menuSeq = 0;

/**
 * A toolbar menu: a button and a dialog panel.
 * @param {{label: string, title?: string, className?: string, render: (panel: HTMLElement, menu: object) => void,
 *          onOpen?: () => void}} opts
 * @returns {{el: HTMLElement, button: HTMLElement, panel: HTMLElement, open(): void, close(opts?: {focus?: boolean}): void,
 *            toggle(): void, isOpen(): boolean, refresh(): void, destroy(): void}}
 */
export function createMenu({ label, title = label, className = '', render, onOpen = null }) {
  const id = `menu-${++menuSeq}`;
  const content = h('div.menu-content');
  const panel = h('div.menu-panel', { id, role: 'dialog', 'aria-label': title, hidden: true },
    h('div.menu-head', null,
      h('h2.menu-title', null, title),
      h('button.btn.menu-close', { type: 'button', 'aria-label': `Close ${title}`, onClick: () => api.close() }, '×')),
    content);
  const button = h('button.btn.menu-button', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': id,
    onClick: () => api.toggle() }, label);
  const el = h('div.menu', { class: className || null }, button, panel);
  let doc = null;
  // Portalled and fixed, like the Filters popover (fix pass): inside the toolbar (overflow: hidden) the panel was clipped
  // to its strip, and focusing its first field scrolled the whole toolbar out of view. It opens under its button, or
  // under More when the toolbar has folded the button away; narrow screens get a bottom sheet (panels.css).
  const anchor = () => {
    const r = button.getBoundingClientRect?.();
    if (r && r.width > 0 && r.height > 0) return button;
    return button.ownerDocument?.querySelector?.('#toolbar .tb-more') ?? button;
  };
  const float = panel.ownerDocument?.body ? floatPopover(panel, anchor, { align: 'end' }) : null;

  const onDocPointer = (e) => { if (!el.contains(e.target) && !panel.contains(e.target)) api.close({ focus: false }); };
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation?.(); api.close(); } });

  const api = {
    el, button, panel,
    isOpen: () => !panel.hidden,
    refresh() { clear(content); render(content, api); },
    open() {
      if (!panel.hidden) return;
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      api.refresh();
      onOpen?.();
      float?.position();
      doc = el.ownerDocument;
      doc?.addEventListener('pointerdown', onDocPointer, true);
      const first = panel.querySelector('input, button:not(.menu-close), a[href], select');
      first?.focus?.();
    },
    close({ focus = true } = {}) {
      if (panel.hidden) return;
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      doc?.removeEventListener('pointerdown', onDocPointer, true);
      if (focus) button.focus?.();
    },
    toggle() { if (panel.hidden) api.open(); else api.close(); },
    destroy() { api.close({ focus: false }); float?.destroy(); panel.remove(); el.remove(); },
  };
  return api;
}

/** Short ISO date of a timestamp, or the raw value. */
export function shortDate(iso) {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : String(iso ?? '—');
}

/**
 * A default name for a new saved view: corpus · strands · date. `labels` (`type:id` → the strand's words, e.g.
 * 'expression:1' → 'carry the zero') names the strands as the reader sees them; an unknown one keeps its id.
 * @param {object} view
 * @param {Date} [now]
 * @param {Record<string, string>} [labels]
 * @returns {string}
 */
export function defaultViewName(view, now = new Date(), labels = {}) {
  const strands = (view.strands ?? []).map((s) => labels[`${s.type}:${s.id}`] ?? `${s.type} ${s.id}`).join(', ');
  return [view.corpus, strands || 'Scroll', now.toISOString().slice(0, 10)].join(' · ');
}

/**
 * The POST /api/views body. Saving while a saved view is on screen names it as the parent (the server makes
 * `slug~2`; the saved view itself never changes).
 * @param {object} view
 * @param {{name: string, comparisonsTried?: number, parentSlug?: string|null}} opts
 */
export function saveRequest(view, { name, comparisonsTried = 0, parentSlug = null }) {
  const body = { name: String(name).trim(), state: view, comparisons_tried: Number.isInteger(comparisonsTried) ? comparisonsTried : 0 };
  if (parentSlug) body.parent_slug = parentSlug;
  return body;
}

/**
 * Query parameters that read a saved view "as saved" (D17; WP5's runs / rel_rev_cutoff / rev_cutoff), or {} when
 * no saved view is open as saved. main.mjs stores the view's pinned runs and cutoffs in ui.savedView (M1 gate).
 * `kwic` (RF-2): the concordance counts with the view's counting runs, import cutoff and save time; `clusters`: the
 * readers' group labels as they stood at the save.
 * @param {{asSaved?: boolean, cutoffs?: object|null, runIds?: object|null}|null} saved ui.savedView
 * @param {'lineage'|'annotations'|'kwic'|'clusters'} kind
 * @returns {Record<string, string|number>}
 */
export function asSavedParams(saved, kind) {
  if (!saved?.asSaved) return {};
  const c = saved.cutoffs ?? {};
  if (kind === 'annotations' || kind === 'clusters') return Number.isInteger(c.annotation_rev) ? { rev_cutoff: c.annotation_rev } : {};
  if (kind === 'kwic') {
    const mat = Object.values(saved.runIds?.materialize ?? {}).map(Number).filter(Number.isInteger);
    return { ...(mat.length ? { runs: mat.join(',') } : {}), ...(Number.isInteger(c.import_batch) ? { import_batch: c.import_batch } : {}),
      ...(typeof c.at === 'string' ? { at: c.at } : {}) };
  }
  const runs = [saved.runIds?.quotes, saved.runIds?.cluster].filter((r) => Number.isInteger(r));
  return { ...(Number.isInteger(c.relationship_rev) ? { rel_rev_cutoff: c.relationship_rev } : {}), ...(runs.length ? { runs: runs.join(',') } : {}) };
}

/** The hash that opens a saved view, as saved or with current data. */
export function viewHash(slug, asSaved = false) {
  return `#view=${encodeURIComponent(slug)}${asSaved ? '&as=1' : ''}`;
}

/**
 * The banner of a saved view on screen (strings and actions only).
 * @param {{slug: string, asSaved?: boolean, stateHash?: string}} saved ui.savedView
 * @param {object|null} info GET /api/views/:slug
 * @param {object} view the current ViewState
 * @returns {{title: string, lines: string[], actions: Array<{label: string, hash: string}>, modified: boolean}}
 */
export function bannerModel(saved, info, view) {
  const name = info?.name ?? saved.slug;
  const meta = info ? ` · saved ${shortDate(info.savedAt)} · data v${formatCount(info.dataVersion)}` : '';
  const modified = Boolean(saved.stateHash) && stateHash(view) !== saved.stateHash;
  const lines = [];
  if (saved.asSaved) lines.push('As saved: only the imports, runs and revisions that existed when the view was saved.');
  if (info?.drift?.dataChanged && info.drift.message) lines.push(info.drift.message);
  else if (info?.drift?.dataChanged) lines.push(`Corpus changed since this view was saved (data v${info.dataVersion} → v${info.currentDataVersion}).`);
  if (modified) lines.push('Changed since you opened it. Save again to keep the changes as a new link; the saved view never changes.');
  const actions = [];
  if (info?.drift?.asSavedAvailable && (info.drift.dataChanged || saved.asSaved)) {
    actions.push(saved.asSaved ? { label: 'Show current data', hash: viewHash(saved.slug, false) } : { label: 'Show as saved', hash: viewHash(saved.slug, true) });
  }
  return { title: `Saved view “${name}”${meta}`, lines, actions, modified };
}

/**
 * Mount the views menu into the toolbar and its banner into the ribbon region.
 * @param {HTMLElement} el
 * @param {{store: object, api: object, keys?: object, announce?: Function, regions?: Record<string, HTMLElement>}} ctx
 * @returns {{unmount(): void, menu: ReturnType<typeof createMenu>}}
 */
export function mount(el, ctx) {
  const { store, api, keys } = ctx;
  const announce = ctx.announce ?? (() => {});
  const doc = el.ownerDocument;
  const win = doc?.defaultView ?? globalThis.window;
  const local = { list: null, listError: null, saving: false, saved: null, saveError: null, info: null, infoSlug: null, dismissed: null };

  const go = (hash) => { if (win?.location) win.location.hash = hash; };
  /** The strands' words as the Scroll shows them ('expression:1' → 'carry the zero'), for the suggested name. */
  const strandLabels = () => {
    const labels = scrollHub.get?.().strandLabels;
    const out = {};
    for (const st of store.get().view.strands ?? []) {
      const l = labels?.get?.(String(st.id));
      if (l && !/^expression \d+$/.test(l)) out[`${st.type}:${st.id}`] = l;
    }
    return out;
  };

  // The menu is built once per opening; the list and the save status re-render in their own slots, so a
  // name being typed is never thrown away by a list that arrives later.
  const slots = { list: null, status: null, saveBtn: null };

  async function loadList() {
    local.list = null; local.listError = null;
    renderList();
    try {
      const res = await api.get('/views', { limit: 50 }, { key: 'views-list' });
      local.list = Array.isArray(res?.items) ? res.items : [];
    } catch (err) {
      if (err?.name === 'AbortError') return;
      local.listError = err;
    }
    renderList();
  }

  async function save(name) {
    const s = store.get();
    if (!String(name).trim()) { local.saveError = { message: 'A saved view needs a name.' }; renderStatus(); return; }
    local.saving = true; local.saveError = null; local.saved = null;
    renderStatus();
    try {
      const body = saveRequest(s.view, { name, comparisonsTried: s.ui.comparisonsTried ?? 0, parentSlug: s.ui.savedView?.slug ?? null });
      const res = await api.post('/views', body, { key: 'views-save' });
      local.saved = res;
      store.dispatch({ type: 'UI_SET', key: 'savedView', value: { slug: res.slug, asSaved: false, stateHash: stateHash(store.get().view) } });
      store.dispatch({ type: 'UI_TOAST', toast: { kind: 'info', text: `Saved as ${res.slug}` } });
      announce(`View saved as ${res.slug}`);
      loadList();
    } catch (err) {
      local.saveError = err;
    } finally {
      local.saving = false;
      renderStatus();
    }
  }

  function renderStatus() {
    if (slots.saveBtn) {
      slots.saveBtn.disabled = local.saving;
      slots.saveBtn.textContent = local.saving ? 'Saving…' : 'Save view';
    }
    if (!slots.status) return;
    clear(slots.status);
    if (local.saveError) slots.status.appendChild(renderErrorCard(local.saveError));
    if (!local.saved) return;
    const link = `${win?.location?.origin ?? ''}${local.saved.url}`;
    slots.status.appendChild(h('div.views-saved', { role: 'status' },
      h('p', null, `Saved as ${local.saved.slug} (data v${formatCount(local.saved.dataVersion)}).`),
      h('div.views-link-row', null,
        h('input.views-link', { type: 'text', readOnly: true, value: link, 'aria-label': 'Link to the saved view' }),
        h('button.btn', { type: 'button', onClick: async (e) => {
          const btn = e.currentTarget;
          try { await win.navigator.clipboard.writeText(link); btn.textContent = 'Copied'; }
          catch { btn.textContent = 'Select the link and copy it'; }
        } }, 'Copy link'))));
  }

  function renderList() {
    if (!slots.list) return;
    clear(slots.list);
    let list;
    if (local.listError) list = renderErrorCard(local.listError, { onRetry: loadList });
    else if (local.list === null) list = renderLoadingLine('Loading saved views…');
    else if (!local.list.length) list = renderEmptyCard('No saved views yet.');
    else {
      list = h('ul.views-list', { role: 'list' }, local.list.map((v) => h('li', null,
        h('button.views-item', { type: 'button', dataset: { slug: v.slug }, onClick: () => { menu.close({ focus: false }); go(viewHash(v.slug)); announce(`Opening ${v.name}`); } },
          h('span.views-item-name', null, v.name),
          h('span.meta', null, ` saved ${shortDate(v.savedAt)} · data v${formatCount(v.dataVersion)}`),
          v.synthetic ? synBadge() : null))));
    }
    slots.list.appendChild(list);
  }

  function renderMenu(panel) {
    const s = store.get();
    // the suggested name is selected on focus, so typing replaces it (fix pass)
    const nameInput = h('input.views-name', { type: 'text', value: defaultViewName(s.view, new Date(), strandLabels()), 'aria-label': 'Name of the saved view', maxlength: '120',
      onFocus: (e) => e.target.select?.(),
      onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); save(nameInput.value); } } });
    const parent = s.ui.savedView?.slug;
    slots.saveBtn = h('button.btn.btn-primary', { type: 'button', onClick: () => save(nameInput.value) }, 'Save view');
    slots.status = h('div.views-status');
    slots.list = h('div.views-list-slot');
    panel.append(
      h('section.views-save', { 'aria-label': 'Save this view' },
        h('h3.section-title', null, 'Save this view'),
        h('div.views-save-row', null, nameInput, slots.saveBtn),
        h('p.meta', null, parent
          ? `Saved views never change: this saves a new view (from ${parent}).`
          : 'Saved views never change: they pin the data version, imports, runs and revisions as of now.'),
        slots.status),
      h('section.views-open', { 'aria-label': 'Saved views' }, h('h3.section-title', null, 'Saved views'), slots.list));
    local.saved = null; local.saveError = null;
    renderStatus();
    renderList();
  }

  const menu = createMenu({ label: 'Views', title: 'Saved views', className: 'views-menu', render: renderMenu, onOpen: loadList });
  el.appendChild(menu.el);

  // ── the banner (ribbon region) ──
  const bannerHost = ctx.regions?.ribbon ?? doc?.getElementById?.('ribbon') ?? null;
  const banner = h('div.saved-banner', { role: 'status', hidden: true });
  bannerHost?.appendChild(banner);

  async function loadInfo(saved) {
    const key = `${saved.slug}|${saved.asSaved ? 1 : 0}`;
    if (local.infoSlug === key) return;
    local.infoSlug = key; local.info = null;
    try {
      const info = await api.get(`/views/${encodeURIComponent(saved.slug)}`, saved.asSaved ? { as: 1 } : null, { key: 'views-banner' });
      if (local.infoSlug !== key) return;
      local.info = info;
    } catch (err) {
      if (err?.name === 'AbortError') return;
      local.info = null;
    }
    renderBanner();
  }

  function renderBanner() {
    const s = store.get();
    const saved = s.ui.savedView;
    clear(banner);
    if (!saved?.slug || local.dismissed === `${saved.slug}|${saved.asSaved}`) { banner.hidden = true; return; }
    const m = bannerModel(saved, local.info, s.view);
    banner.hidden = false;
    banner.classList.toggle('is-modified', m.modified);
    banner.append(
      h('strong.saved-banner-title', null, m.title),
      ...m.lines.map((l) => h('span.saved-banner-line', null, l)),
      ...m.actions.map((a) => h('button.btn', { type: 'button', onClick: () => go(a.hash) }, a.label)),
      h('button.btn.saved-banner-close', { type: 'button', 'aria-label': 'Hide this note', onClick: () => { local.dismissed = `${saved.slug}|${saved.asSaved}`; renderBanner(); } }, '×'));
  }

  const unsubs = [
    store.subscribe((s) => s.ui.savedView, (saved) => { if (saved?.slug) loadInfo(saved); else local.infoSlug = null; renderBanner(); }),
    store.subscribe((s) => s.view, () => { if (store.get().ui.savedView) renderBanner(); }),
  ];
  const saved0 = store.get().ui.savedView;
  if (saved0?.slug) loadInfo(saved0);
  renderBanner();

  const unkeys = keys?.register?.('global', {
    s: { run: () => { menu.open(); menu.panel.querySelector('.views-name')?.focus?.(); }, label: 'Save view' },
  }) ?? (() => {});

  return {
    menu,
    unmount() {
      unkeys();
      for (const u of unsubs) u();
      menu.destroy();
      banner.remove();
    },
  };
}
