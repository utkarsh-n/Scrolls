// OWNER: WP7
// panels/export-menu.mjs — the export menu (SPEC §7.3, §8.5 `X`, §13 rules 1 and 15). Builds the
// GET /api/export link for the saved view on screen (`view=<slug>`) or for the current state
// (`state=<base64url of the URL hash>`), for what × format, and offers it as a download. The file starts with
// its manifest (data version, runs, filters, toggles, licences, attributions, synthetic flag); the menu says so,
// and says when the export contains synthetic data. Text the licence does not allow (OpenAlex abstracts) is
// exported as ids and offsets only — by the server; the menu states it.

import { h } from '../core/dom.mjs';
import { encode, stateHash } from '../../shared/viewstate.mjs';
import { createMenu } from './views-menu.mjs';

export const EXPORT_WHATS = Object.freeze([
  Object.freeze({ key: 'occurrences', label: 'Occurrences', note: 'one row per match, with offsets and dates' }),
  Object.freeze({ key: 'aggregates', label: 'Aggregates', note: 'bins with n, denominators, rates and CIs' }),
  Object.freeze({ key: 'passages', label: 'Passages', note: 'the passages behind the matches' }),
  Object.freeze({ key: 'relationships', label: 'Relationships', note: 'with evidence and review status' }),
  Object.freeze({ key: 'annotations', label: 'Annotations', note: 'with every revision' }),
]);
export const EXPORT_FORMATS = Object.freeze([
  Object.freeze({ key: 'csv', label: 'CSV', ext: 'csv' }),
  Object.freeze({ key: 'json', label: 'JSON', ext: 'json' }),
  Object.freeze({ key: 'jsonl', label: 'JSONL', ext: 'jsonl' }),
]);

/**
 * base64url (RFC 4648 §5, no padding) of a string's UTF-8 bytes.
 * @param {string} s
 * @returns {string}
 */
export function b64url(s) {
  const bytes = new TextEncoder().encode(String(s));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The export link. A saved view shown unchanged exports by slug (its pinned versions apply); anything else
 * exports the current state, encoded as the URL hash.
 * @param {{view: object, savedView?: {slug: string, stateHash?: string}|null, what: string, format: string, base?: string}} opts
 * @returns {string}
 */
export function exportUrl({ view, savedView = null, what, format, base = '/api' }) {
  const p = new URLSearchParams();
  const unchanged = savedView?.slug && savedView.stateHash && stateHash(view) === savedView.stateHash;
  if (unchanged) p.set('view', savedView.slug);
  else p.set('state', b64url(encode(view)));
  p.set('what', what);
  p.set('format', format);
  return `${base}/export?${p.toString()}`;
}

/**
 * The download file name: scrolls-<corpus>-<what>-<yyyy-mm-dd>.<ext>.
 * @param {object} view
 * @param {string} what
 * @param {string} format
 * @param {Date} [now]
 */
export function exportFileName(view, what, format, now = new Date()) {
  const ext = EXPORT_FORMATS.find((f) => f.key === format)?.ext ?? format;
  return `scrolls-${view.corpus}-${what}-${now.toISOString().slice(0, 10)}.${ext}`;
}

/**
 * Mount the export menu into the toolbar.
 * @param {HTMLElement} el
 * @param {{store: object, api: object, keys?: object, announce?: Function}} ctx
 * @returns {{unmount(): void, menu: ReturnType<typeof createMenu>}}
 */
export function mount(el, ctx) {
  const { store, api, keys } = ctx;
  const announce = ctx.announce ?? (() => {});
  const choice = { what: 'occurrences', format: 'csv' };

  function renderMenu(panel) {
    const s = store.get();
    const base = typeof api?.url === 'function' ? api.url('').replace(/\/$/, '') : '/api';
    const link = h('a.btn.btn-primary.export-download', {
      onClick: () => { announce(`Exporting ${choice.what} as ${choice.format.toUpperCase()}`); },
    });
    const update = () => {
      const now = store.get();
      link.setAttribute('href', exportUrl({ view: now.view, savedView: now.ui.savedView, what: choice.what, format: choice.format, base }));
      link.setAttribute('download', exportFileName(now.view, choice.what, choice.format));
      link.textContent = `Download ${choice.what} (${choice.format.toUpperCase()})`;
    };
    const radios = (name, items, cur, onPick) => h('fieldset.export-group', null,
      h('legend', null, name),
      items.map((it) => h('label.export-option', null,
        h('input', { type: 'radio', name: `export-${name}`, value: it.key, checked: it.key === cur,
          onChange: () => { onPick(it.key); update(); } }),
        ` ${it.label}`, it.note ? h('span.meta', null, ` — ${it.note}`) : null)));
    update();
    panel.append(
      radios('What', EXPORT_WHATS, choice.what, (k) => { choice.what = k; }),
      radios('Format', EXPORT_FORMATS, choice.format, (k) => { choice.format = k; }),
      link,
      h('ul.export-notes', { role: 'list' },
        h('li.meta', null, 'The file starts with its manifest: data version, runs, filters, toggles, licences and attributions.'),
        h('li.meta', null, s.ui.savedView?.slug ? `Exports the saved view ${s.ui.savedView.slug} when it is shown unchanged; otherwise the view on screen.`
          : 'Exports the view on screen.'),
        h('li.meta', null, 'Collections whose licence does not allow text export (OpenAlex abstracts) give ids, offsets and locators only.'),
        s.view.corpus === 'demo' ? h('li.export-syn', null, 'Contains SYNTHETIC demonstration data; every row and the manifest say so.') : null));
  }

  const menu = createMenu({ label: 'Export', title: 'Export', className: 'export-menu', render: renderMenu });
  el.appendChild(menu.el);
  const unkeys = keys?.register?.('global', { x: { run: () => menu.toggle(), label: 'Export menu' } }) ?? (() => {});
  const unsub = store.subscribe((s) => s.view, () => { if (menu.isOpen()) menu.refresh(); });

  return {
    menu,
    unmount() { unkeys(); unsub(); menu.destroy(); },
  };
}
