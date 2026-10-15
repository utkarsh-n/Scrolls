// OWNER: WP7
// panels/annotation-editor.mjs — the annotation editor (SPEC §2.F, D18). Creates an annotation (POST
// /api/annotations), edits one by appending a revision (PATCH, with a reason), or reinterprets one (POST
// …/reinterpret: a new annotation that supersedes the old, which stays visible as a layer). Passage targets are
// anchored by (doc_id, sha256, field, start, end, quote) so re-segmentation cannot orphan them. Kinds are the
// human kinds; machine annotations are never edited here, only countered (evidence_against). A hypothesis is
// labelled "not evidence" and never feeds counts or lineage.

import { h } from '../core/dom.mjs';
import { ANNOTATION_KINDS, DIMENSIONS, MACHINE_ANNOTATION_KINDS } from '../../shared/vocab.mjs';
import { renderErrorCard } from './gate-card.mjs';

export const HUMAN_KINDS = Object.freeze(ANNOTATION_KINDS.filter((k) => !MACHINE_ANNOTATION_KINDS.includes(k)));
export const KIND_LABELS = Object.freeze({
  interpretation: 'Interpretation', evidence_for: 'Evidence for', evidence_against: 'Evidence against', hypothesis: 'Hypothesis',
  question: 'Question', correction: 'Correction', label: 'Label (renames a machine label; the machine label stays visible)',
});
export const HYPOTHESIS_NOTE = 'A hypothesis is not evidence: it never feeds counts or lineage.';

/**
 * The anchor of a whole passage (D18): document, text hash, field, offsets and the quoted text.
 * @param {{anchor: {doc_id: number, sha256: string, field: string, start: number, end: number}, text: string}} passage
 * @returns {{doc_id: number, sha256: string, field: string, start: number, end: number, quote: string, prefix: string, suffix: string}|null}
 */
export function anchorFor(passage, span = null) {
  const a = passage?.anchor;
  if (!a || typeof passage.text !== 'string') return null;
  if (span && Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.end <= passage.text.length && span.start < span.end) {
    const t = passage.text;
    return { doc_id: a.doc_id, sha256: a.sha256, field: a.field, start: a.start + span.start, end: a.start + span.end,
      quote: t.slice(span.start, span.end), prefix: t.slice(Math.max(0, span.start - 32), span.start), suffix: t.slice(span.end, span.end + 32) };
  }
  return { doc_id: a.doc_id, sha256: a.sha256, field: a.field, start: a.start, end: a.end, quote: passage.text, prefix: '', suffix: '' };
}

/**
 * The words a reader selected inside a passage's text on screen, as offsets into `passage.text` (UTF-16), or
 * null when the selection is empty or lies outside that passage. The passage text element renders the text
 * exactly (highlight marks only wrap parts of it), so character counts map one to one.
 * @param {Document} doc
 * @param {{id: number, text: string}} passage
 * @returns {{start: number, end: number}|null}
 */
export function selectedSpan(doc, passage) {
  try {
    const sel = doc?.defaultView?.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const host = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)
      ?.closest?.('.passage-text');
    if (!host || host.closest('[data-passage]')?.dataset.passage !== String(passage.id)) return null;
    const pre = doc.createRange();
    pre.selectNodeContents(host);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const end = start + range.toString().length;
    return host.textContent === passage.text && end > start ? { start, end } : null;
  } catch {
    return null;
  }
}

/** Key rule of a custom dimension (server/provenance/annotations.mjs: lowercase letters, digits, _). */
export const CUSTOM_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * A custom dimension's value as typed: 'true'/'false' → boolean, a number → number, else the text.
 * @param {string} raw
 */
export function customValue(raw) {
  const v = String(raw ?? '').trim();
  if (v === 'true' || v === 'false') return v === 'true';
  if (v !== '' && Number.isFinite(Number(v))) return Number(v);
  return v;
}

/**
 * Evidence references from the editor rows (empty rows dropped; passage spans are relative to the passage text).
 * @param {Array<{role: string, type: string, id: string, start?: string, end?: string}>} rows
 * @returns {Array<{type: string, id: number, role: string, start?: number, end?: number, relative?: boolean}>}
 */
export function readEvidenceRefs(rows) {
  const out = [];
  for (const r of rows ?? []) {
    const id = Number.parseInt(r.id, 10);
    if (!Number.isInteger(id) || id <= 0) continue;
    const ref = { type: r.type || 'passage', id, role: r.role === 'contradicting' ? 'contradicting' : 'supporting' };
    const start = Number.parseInt(r.start, 10), end = Number.parseInt(r.end, 10);
    if (ref.type === 'passage' && Number.isInteger(start) && Number.isInteger(end) && start < end) Object.assign(ref, { start, end, relative: true });
    out.push(ref);
  }
  return out;
}

/** 'irony, tribute ,, ' → ['irony', 'tribute'] */
export function parseTags(s) {
  return [...new Set(String(s ?? '').split(',').map((t) => t.trim()).filter(Boolean))];
}

/** "passage:901" → {type: 'passage', ref: '901'} */
export function parseTarget(target) {
  const m = /^([a-z_]+):(.+)$/.exec(String(target ?? ''));
  return m ? { type: m[1], ref: m[2] } : null;
}

/**
 * The POST /api/annotations body.
 * @param {{target: string, passage?: object|null, kind: string, body: string, layer?: string, dimensions?: object, tags?: string[]}} f
 */
export function annotationRequest({ target, passage = null, kind, body, layer = '', dimensions = {}, tags = [], span = null, evidence = [] }) {
  const t = parseTarget(target);
  const out = { target: t, kind, body_md: String(body ?? '').trim(), dimensions, tags };
  if (layer && layer.trim()) out.layer = layer.trim();
  if (Array.isArray(evidence) && evidence.length) out.evidence_refs = evidence;
  if (t && (t.type === 'passage' || t.type === 'occurrence')) {
    const anchor = anchorFor(passage, span);
    if (anchor) out.anchor = anchor;
  }
  return out;
}

/** Dimension values from the form, dropping empty ones. */
export function readDimensions(inputs) {
  const out = {};
  for (const d of DIMENSIONS) {
    const el = inputs[d.key];
    if (!el) continue;
    if (d.type === 'bool') { if (el.checked) out[d.key] = true; continue; }
    const v = String(el.value ?? '').trim();
    if (!v) continue;
    out[d.key] = d.type === 'scale' ? Number(v) : v;
  }
  return out;
}

function dimensionField(d, value) {
  const id = `dim-${d.key}`;
  let input;
  if (d.type === 'enum') input = h('select', { id, 'aria-label': d.label }, h('option', { value: '' }, '—'), d.options.map((o) => h('option', { value: o, selected: value === o }, o)));
  else if (d.type === 'scale') input = h('input', { id, type: 'number', min: String(d.options.min), max: String(d.options.max), step: String(d.options.step), value: value ?? '', 'aria-label': `${d.label} (${d.options.min} to ${d.options.max})` });
  else if (d.type === 'bool') input = h('input', { id, type: 'checkbox', checked: value === true, 'aria-label': d.label });
  else input = h('input', { id, type: 'text', value: value ?? '', 'aria-label': d.label });
  return { input, row: h('label.ann-dim', null, h('span', null, d.label), input) };
}

/**
 * The editor form.
 * @param {{api: object, target: string, passage?: object|null, mode?: 'create'|'edit'|'reinterpret', annotation?: object|null,
 *          kind?: string, announce?: Function, onSaved?: (res: object) => void, onCancel?: () => void}} opts
 * @returns {{el: HTMLElement, submit(): Promise<void>}}
 */
export function createAnnotationEditor({ api, target, passage = null, mode = 'create', annotation = null, kind = 'interpretation',
  announce = () => {}, onSaved = null, onCancel = null }) {
  const a = annotation ?? {};
  const doc = globalThis.document;
  const kindSel = h('select.ann-kind', { 'aria-label': 'Kind', disabled: mode === 'edit' },
    HUMAN_KINDS.map((k) => h('option', { value: k, selected: (a.kind ?? kind) === k }, KIND_LABELS[k] ?? k)));
  const body = h('textarea.ann-body', { rows: '5', 'aria-label': 'Annotation text' });
  body.value = mode === 'create' ? '' : a.body_md ?? '';
  const layer = h('input.ann-layer', { type: 'text', value: mode === 'reinterpret' ? '' : a.layer ?? '', 'aria-label': 'Layer (e.g. "Reader A, 2026-10-04")' });
  const tags = h('input.ann-tags', { type: 'text', value: (a.tags ?? []).join(', '), 'aria-label': 'Tags, separated by commas' });
  const reason = mode === 'edit' ? h('input.ann-reason', { type: 'text', 'aria-label': 'Reason for this revision' }) : null;
  const dimInputs = {};
  const dims = DIMENSIONS.map((d) => { const f = dimensionField(d, a.dimensions?.[d.key]); dimInputs[d.key] = f.input; return f.row; });
  // Custom dimensions (§2.F "custom dimensions via dimension_def"): an unknown key defines one; its type is
  // inferred by the server from the value (text, scale or bool).
  const builtin = new Set(DIMENSIONS.map((d) => d.key));
  const customRows = [];
  const customHost = h('div.ann-custom');
  const addCustom = (key = '', value = '') => {
    const k = h('input', { type: 'text', value: key, placeholder: 'key, e.g. audience', 'aria-label': 'Custom dimension key (lowercase letters, digits, _)' });
    const v = h('input', { type: 'text', value: value === '' ? '' : String(value), placeholder: 'value (text, number or true/false)', 'aria-label': 'Custom dimension value' });
    customRows.push({ k, v });
    customHost.appendChild(h('div.ann-dim.is-custom', null, k, v));
  };
  for (const [key, value] of Object.entries(a.dimensions ?? {})) if (!builtin.has(key)) addCustom(key, value);
  // Evidence references: other passages (or documents, links, annotations) for or against this reading.
  const evRows = [];
  const evHost = h('div.ann-evidence');
  const addEvidence = (ref = {}) => {
    const row = {
      role: h('select', { 'aria-label': 'Evidence role' }, h('option', { value: 'supporting', selected: ref.role !== 'contradicting' }, 'for'),
        h('option', { value: 'contradicting', selected: ref.role === 'contradicting' }, 'against')),
      type: h('select', { 'aria-label': 'Evidence type' }, ['passage', 'document', 'relationship', 'annotation'].map((t) => h('option', { value: t, selected: (ref.type ?? 'passage') === t }, t))),
      id: h('input', { type: 'number', inputmode: 'numeric', value: ref.id ?? '', 'aria-label': 'Evidence id' }),
      start: h('input', { type: 'number', inputmode: 'numeric', 'aria-label': 'Start offset in the passage (optional)' }),
      end: h('input', { type: 'number', inputmode: 'numeric', 'aria-label': 'End offset in the passage (optional)' }),
    };
    evRows.push(row);
    evHost.appendChild(h('div.ann-ev-row', null, row.role, row.type, row.id, h('span.meta', null, 'chars'), row.start, row.end));
  };
  for (const r of a.evidence_refs ?? []) addEvidence(r);
  // Anchor: the words selected in the passage on screen when the editor opened, else the whole passage.
  const span = mode !== 'edit' && passage ? selectedSpan(doc, passage) : null;
  let useSpan = Boolean(span);
  const spanNote = span ? h('label.lin-check.ann-span', null,
    h('input', { type: 'checkbox', checked: true, onChange: (e) => { useSpan = e.target.checked; } }),
    ` anchored to the selected words: “${passage.text.slice(span.start, span.end).slice(0, 80)}”`) : null;
  const status = h('div.ann-status', { role: 'status' });
  const hypo = h('p.ann-hypothesis-note', { hidden: kindSel.value !== 'hypothesis' }, HYPOTHESIS_NOTE);
  kindSel.addEventListener('change', () => { hypo.hidden = kindSel.value !== 'hypothesis'; });
  const save = h('button.btn.btn-primary', { type: 'button', onClick: () => submit() },
    mode === 'edit' ? 'Save revision' : mode === 'reinterpret' ? 'Save reinterpretation' : 'Save annotation');

  function dimensionsOf() {
    const out = readDimensions(dimInputs);
    for (const { k, v } of customRows) {
      const key = String(k.value ?? '').trim();
      if (!key || String(v.value ?? '').trim() === '') continue;
      if (!CUSTOM_KEY.test(key)) throw Object.assign(new Error(`Dimension key '${key}' must be lowercase letters, digits or _ (start with a letter).`), { local: true });
      out[key] = customValue(v.value);
    }
    return out;
  }
  const evidenceOf = () => readEvidenceRefs(evRows.map((r) => ({ role: r.role.value, type: r.type.value, id: r.id.value, start: r.start.value, end: r.end.value })));

  async function submit() {
    status.replaceChildren?.();
    if (!body.value.trim()) { status.appendChild(renderErrorCard({ message: 'Write the annotation first.' })); return; }
    save.disabled = true;
    try {
      let res;
      if (mode === 'edit') {
        const patch = { body_md: body.value.trim(), reason: reason.value.trim() || null, dimensions: dimensionsOf(), tags: parseTags(tags.value) };
        const ev = evidenceOf();
        if (ev.length || (a.evidence_refs ?? []).length) patch.evidence_refs = ev;
        res = await api.patch(`/annotations/${a.id}`, patch, { key: `ann-edit-${a.id}` });
      } else {
        const req = annotationRequest({ target, passage, kind: kindSel.value, body: body.value, layer: layer.value,
          dimensions: dimensionsOf(), tags: parseTags(tags.value), span: useSpan ? span : null, evidence: evidenceOf() });
        res = mode === 'reinterpret'
          ? await api.post(`/annotations/${a.id}/reinterpret`, req, { key: `ann-reinterpret-${a.id}` })
          : await api.post('/annotations', req, { key: 'ann-create' });
      }
      announce(mode === 'edit' ? `Revision ${res?.rev ?? ''} saved` : mode === 'reinterpret' ? `Reinterpretation ${res?.id ?? ''} saved; ${a.id} is superseded` : `Annotation ${res?.id ?? ''} saved`);
      onSaved?.(res);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      status.appendChild(renderErrorCard(err));
    } finally {
      save.disabled = false;
    }
  }

  const el = h('div.ann-editor', { role: 'group', 'aria-label': mode === 'edit' ? 'Edit annotation' : mode === 'reinterpret' ? 'Reinterpret annotation' : 'New annotation' },
    h('p.meta', null, mode === 'edit' ? `Editing appends a revision to annotation ${a.id}; earlier revisions stay.`
      : mode === 'reinterpret' ? `A reinterpretation is a new annotation; ${a.id} stays visible as a superseded layer.`
        : `On ${target}${passage?.text ? `: “${passage.text.slice(0, 60)}${passage.text.length > 60 ? '…' : ''}”` : ''}`),
    spanNote,
    h('label.ann-row', null, h('span', null, 'Kind'), kindSel),
    hypo,
    body,
    h('label.ann-row', null, h('span', null, 'Layer'), layer),
    h('label.ann-row', null, h('span', null, 'Tags'), tags),
    reason ? h('label.ann-row', null, h('span', null, 'Reason'), reason) : null,
    h('details.ann-dims', null, h('summary', null, 'Dimensions (built-in and your own)'), dims, customHost,
      h('button.btn', { type: 'button', onClick: () => addCustom() }, '＋ Custom dimension')),
    h('details.ann-dims', { open: (a.evidence_refs ?? []).length > 0 }, h('summary', null, 'Evidence for or against'),
      h('p.meta', null, 'Point at passages (optionally a span of characters inside one), documents, links or other annotations.'),
      evHost, h('button.btn', { type: 'button', onClick: () => addEvidence() }, '＋ Evidence')),
    h('div.edge-actions', null, save, onCancel ? h('button.btn', { type: 'button', onClick: onCancel }, 'Cancel') : null),
    status);
  return { el, submit };
}

/**
 * Library module (the notebook embeds the editor): nothing to mount on its own.
 * @param {HTMLElement} el
 * @param {object} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  return { unmount() {} };
}
