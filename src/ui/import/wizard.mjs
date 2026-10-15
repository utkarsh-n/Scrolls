// OWNER: WP1
// import/wizard.mjs — the 4-step import wizard (SPEC §5.2, §8.1): (1) Upload — drop or choose a file, see
// format, encoding, delimiter and 20 sample rows; (2) Map — each target pre-filled from header synonyms and
// value sniffing, with a live parse check; (3) Validate — a dry run over every row, the projected summary;
// (4) Commit — a job with progress (SSE, polling as fallback), then the summary and "Open in timeline".
//
// It shows itself when the view's right panel is 'import' (OPEN_PANEL {panel: 'import'}; URL p=…,import) and
// also opens when a file is dropped anywhere on the page. Plain buttons, inputs and selects throughout, so it
// works with the keyboard alone; on narrow screens it is a full-screen sheet with a back button. Progress is
// always a number (bytes, rows, seconds), never a bare spinner (§8.8).

import { check } from '../../shared/contracts.mjs';
import { formatCount } from '../../shared/format.mjs';
import { slugify } from '../../shared/ids.mjs';
import { isAbort } from '../core/api.mjs';
import { h } from '../core/dom.mjs';
import { renderMappingTable } from './mapping-table.mjs';
import { renderIssues, renderSummary } from './summary.mjs';

const STEPS = Object.freeze([[1, 'Upload'], [2, 'Map'], [3, 'Validate'], [4, 'Commit']]);
const ACCEPT = '.txt,.text,.md,.markdown,.csv,.tsv,.tab,.json,.jsonl,.ndjson';
const MAX_BYTES = 2 * 1024 ** 3;
const FORMATS = [['csv', 'CSV'], ['tsv', 'TSV'], ['json', 'JSON'], ['jsonl', 'JSON Lines'], ['txt', 'Plain text'], ['md', 'Markdown']];
const DELIMS = [[',', 'comma'], ['\t', 'tab'], [';', 'semicolon'], ['|', 'pipe']];
const DELIM_WORD = Object.fromEntries(DELIMS.map(([d, w]) => [d, w]));
const FINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const POLL_MS = 1000;
const n = (x) => formatCount(x);

const mb = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${n(Math.ceil(bytes / 1024))} KB`);
const stemOf = (name) => String(name ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'import';
const errInfo = (err) => ({ code: err?.code ?? 'E_UNKNOWN', message: err?.message ?? String(err), hint: err?.hint ?? null, status: err?.status ?? null });

function fresh() {
  return {
    step: 1, file: null, uploading: null, reading: false,
    collection: { name: '', slug: '', slugEdited: false, unit: 'tokens', license: '' },
    batchId: null, preview: null, overrides: {}, mapping: null,
    validation: null, validating: false, validateStarted: 0,
    job: null, result: null, resultNote: null, jobError: null, revert: null,
    error: null,
  };
}

/**
 * @param {HTMLElement} el this module's slot in #panel
 * @param {{store: object, api: object, keys?: object, announce?: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api } = ctx;
  const announce = typeof ctx.announce === 'function' ? ctx.announce : () => {};
  const doc = el.ownerDocument ?? globalThis.document;
  let st = fresh();
  let root = null, body = null, stepper = null, progressBox = null;
  let offSse = null, pollTimer = null, tickTimer = null, pendingFile = null;
  let focusHeading = false, lastHeading = null, elapsedEl = null;

  const isOpen = (s) => s.view?.panels?.right === 'import';
  const setState = (patch, { rerender = true } = {}) => { st = { ...st, ...patch }; if (rerender) render(); };

  // ── shell ─────────────────────────────────────────────────────────────────────────────────────────

  function show() {
    if (!root) {
      body = h('div.imp-body');
      stepper = h('ol.imp-steps', { 'aria-label': 'Import steps' });
      root = h('section.imp', { 'aria-labelledby': 'imp-title', role: 'region' },
        h('header.imp-head', null,
          h('button.btn.imp-back', { type: 'button', onClick: close, 'aria-label': 'Back: close the import panel' }, '‹ Back'),
          h('h2#imp-title.imp-title', null, 'Import a file'),
          h('button.btn.imp-close', { type: 'button', onClick: close, 'aria-label': 'Close the import panel', title: 'Close' }, '×')),
        stepper, body);
    }
    if (!root.isConnected) el.appendChild(root);
    render();
    if (pendingFile) { const f = pendingFile; pendingFile = null; st = fresh(); render(); startUpload(f); }
  }

  function hide() {
    root?.remove();
  }

  function close() {
    store.dispatch({ type: 'CLOSE_PANEL', panel: 'import' });
  }

  function go(step) {
    focusHeading = true;
    setState({ step, error: null });
    announce(`Import step ${step} of 4: ${STEPS[step - 1][1]}.`);
  }

  function render() {
    if (!root) return;
    stepper.replaceChildren(...STEPS.map(([k, label]) => {
      const done = k < st.step;
      const canGo = done && st.step < 4 && !st.validating && !(k === 1 && st.step === 1);
      const text = [h('span.imp-step-n', { 'aria-hidden': 'true' }, done ? '✓' : String(k)), ` ${label}`];
      return h('li', { dataset: { state: k === st.step ? 'current' : done ? 'done' : 'todo' } },
        k === st.step ? h('span.imp-step', { 'aria-current': 'step' }, text, h('span.visually-hidden', null, ' (current step)'))
          : canGo ? h('button.imp-step', { type: 'button', onClick: () => go(k) }, text, h('span.visually-hidden', null, ' (done; go back)'))
            : h('span.imp-step', { 'aria-disabled': 'true' }, text));
    }));
    const view = [renderUpload, renderMap, renderValidate, renderCommit][st.step - 1]();
    body.replaceChildren(view);
    if (focusHeading) {
      focusHeading = false;
      lastHeading?.focus?.({ preventScroll: false });
    }
  }

  const heading = (text) => (lastHeading = h('h3.imp-h3', { tabindex: '-1' }, text));

  function errorBox(e, actions = []) {
    if (!e) return null;
    return h('div.imp-error-box', { role: 'alert' },
      h('p', null, h('code', null, e.code), ' ', e.message),
      e.hint ? h('p.imp-suggestion', null, h('span.meta', null, 'What to do: '), e.hint) : null,
      actions.length ? h('p.imp-actions', null, actions) : null);
  }

  // ── step 1: upload and preview ────────────────────────────────────────────────────────────────────

  function collectionFields() {
    const c = st.collection;
    const name = h('input#imp-coll-name.imp-input', { type: 'text', value: c.name, autocomplete: 'off', placeholder: 'e.g. Zines 1977–1999' });
    const slugOut = h('code#imp-coll-slug', null, c.slug || slugify(c.name || 'import'));
    name.addEventListener('input', () => {
      st.collection.name = name.value;
      if (!st.collection.slugEdited) st.collection.slug = slugify(name.value || 'import');
      slugOut.textContent = st.collection.slug;
      if (st.mapping) st.mapping.collection = collectionSpec();
    });
    const unit = (value, label, note) => {
      const r = h('input', { type: 'radio', name: 'imp-unit', value, checked: c.unit === value });
      r.addEventListener('change', () => { if (r.checked) { st.collection.unit = value; if (st.mapping) st.mapping.collection = collectionSpec(); } });
      return h('label.imp-radio', null, r, ` ${label} `, h('span.meta', null, note));
    };
    const lic = h('input#imp-coll-license.imp-input', { type: 'text', value: c.license, placeholder: 'e.g. own, CC BY 4.0, public domain' });
    lic.addEventListener('input', () => { st.collection.license = lic.value; if (st.mapping) st.mapping.collection = collectionSpec(); });
    return h('fieldset.imp-fieldset', null, h('legend', null, 'Collection'),
      h('label.imp-label', { htmlFor: 'imp-coll-name' }, 'Name'), name,
      h('p.meta', null, 'Slug: ', slugOut, ' — imports with the same slug go into one collection.'),
      h('div', { role: 'radiogroup', 'aria-label': 'What the collection holds' },
        unit('tokens', 'Texts', '(rates per million tokens)'), unit('works', 'Title lists', '(rates per 1,000 works)')),
      h('label.imp-label', { htmlFor: 'imp-coll-license' }, 'Licence'), lic);
  }

  function collectionSpec() {
    const c = st.collection;
    const name = c.name.trim() || stemOf(st.file?.name);
    return { slug: c.slug || slugify(name), name, unit: c.unit, license: c.license.trim() || null };
  }

  function chooser() {
    const input = h('input.visually-hidden', { type: 'file', accept: ACCEPT, tabindex: '-1', 'aria-hidden': 'true' });
    input.addEventListener('change', () => { const f = input.files?.[0]; if (f) startUpload(f); input.value = ''; });
    const pick = h('button.btn.btn-primary', { type: 'button', onClick: () => input.click() }, 'Choose a file…');
    const zone = h('div.imp-drop', null,
      h('p', null, 'Drop a file here, or ', pick),
      h('p.meta', null, 'TXT · Markdown · CSV · TSV · JSON · JSON Lines. Up to 2 GB per upload: CSV, TSV and JSON Lines are read in chunks; JSON, TXT and Markdown are read whole, up to 400 MB.'),
      h('p.meta', null, 'The file stays on this computer: it is stored, unchanged, in your Scrolls data folder.'),
      input);
    zone.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); zone.dataset.over = '1'; } });
    zone.addEventListener('dragleave', () => { delete zone.dataset.over; });
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      delete zone.dataset.over;
      const f = e.dataTransfer.files[0];
      if (f) startUpload(f);
    });
    return zone;
  }

  function uploadProgress() {
    const u = st.uploading;
    const pct = Math.round((u.fraction ?? 0) * 100);
    const bar = h('progress.imp-progress', { max: '100', value: String(pct), 'aria-label': 'Upload progress', 'aria-valuetext': `${pct}%` });
    const text = h('p', { role: 'status' }, `Uploading ${st.file.name}… ${pct}% (${mb(u.loaded ?? 0)} of ${mb(u.total ?? st.file.size)})`);
    progressBox = { bar, text };
    return h('div.imp-progress-box', null, bar, text);
  }

  function updateUploadProgress() {
    if (!progressBox || !st.uploading) return;
    const pct = Math.round((st.uploading.fraction ?? 0) * 100);
    progressBox.bar.value = pct;
    progressBox.bar.setAttribute('aria-valuetext', `${pct}%`);
    progressBox.text.textContent = pct >= 100 ? `Uploaded ${mb(st.uploading.total ?? 0)}; reading the first 200 records…`
      : `Uploading ${st.file.name}… ${pct}% (${mb(st.uploading.loaded ?? 0)} of ${mb(st.uploading.total ?? st.file.size)})`;
  }

  async function startUpload(file) {
    if (st.uploading || st.step !== 1) return;
    if (file.size > MAX_BYTES) {
      setState({ file: { name: file.name, size: file.size }, error: { code: 'E_FILE_TOO_LARGE',
        message: `${file.name} is ${mb(file.size)}; the limit is 2 GB per file.`, hint: 'Split the file and import the parts into one collection.' } });
      return;
    }
    if (!st.collection.name.trim()) {
      st.collection.name = stemOf(file.name);
      if (!st.collection.slugEdited) st.collection.slug = slugify(st.collection.name);
    }
    setState({ file: { name: file.name, size: file.size }, uploading: { fraction: 0, loaded: 0, total: file.size }, error: null, preview: null, batchId: null, overrides: {} });
    announce(`Uploading ${file.name}.`);
    try {
      const res = await api.upload('/imports', file, {
        'Content-Type': 'application/octet-stream',
        'X-Scrolls-Filename': encodeURIComponent(file.name),
        'X-Scrolls-Collection': encodeURIComponent(JSON.stringify(collectionSpec())),
      }, (fraction, loaded, total) => { st.uploading = { fraction, loaded, total }; updateUploadProgress(); });
      const errs = check('ImportCreated', res);
      if (errs.length) throw Object.assign(new Error(`The server's answer was not an import preview (${errs[0]}).`), { code: 'E_CONTRACT', hint: 'Reload the page; if it persists, the server and page versions differ.' });
      acceptPreview(res.preview, res.import_batch_id);
      announce(`Read ${file.name}: ${res.preview.format.toUpperCase()}, ${n(res.preview.columns.length)} columns.`);
    } catch (err) {
      if (isAbort(err)) return;
      setState({ uploading: null, error: errInfo(err) });
      announce(`Upload failed: ${err?.message ?? err}`, { politeness: 'assertive' });
    }
  }

  function acceptPreview(preview, batchId = st.batchId) {
    const mapping = structuredClone(preview.suggested_mapping ?? {});
    mapping.collection = collectionSpec();
    setState({ preview, batchId, mapping, uploading: null, reading: false, validation: null, error: null });
  }

  async function reloadPreview(patch) {
    const overrides = { ...st.overrides, ...patch };
    setState({ overrides, reading: true, error: null });
    const q = {};
    if (overrides.format) q.format = overrides.format;
    if (overrides.delimiter) q.delimiter = DELIM_WORD[overrides.delimiter] ?? overrides.delimiter;
    if (overrides.header !== undefined) q.header = overrides.header ? '1' : '0';
    if (overrides.encoding) q.encoding = overrides.encoding;
    if (overrides.pointer !== undefined) q.pointer = overrides.pointer;
    if (overrides.line_mode !== undefined) q.line_mode = overrides.line_mode ? '1' : '0';
    try {
      const preview = await api.get(`/imports/${st.batchId}/preview`, q, { key: 'import-preview' });
      const errs = check('ImportPreview', preview);
      if (errs.length) throw Object.assign(new Error(`The server's answer was not an import preview (${errs[0]}).`), { code: 'E_CONTRACT' });
      acceptPreview(preview);
      announce(`Preview read again as ${preview.format.toUpperCase()}.`);
    } catch (err) {
      if (isAbort(err)) return;
      setState({ reading: false, error: errInfo(err) });
    }
  }

  function previewControls(p) {
    const fmt = h('select#imp-format', null, FORMATS.map(([v, t]) => h('option', { value: v }, t)));
    fmt.value = p.format;
    fmt.addEventListener('change', () => reloadPreview({ format: fmt.value }));
    const enc = h('select#imp-encoding', null, [['', `as read (${p.encoding})`], ['utf-8', 'UTF-8, strict'], ['windows-1252', 'Windows-1252']].map(([v, t]) => h('option', { value: v }, t)));
    enc.value = st.overrides.encoding ?? '';
    enc.addEventListener('change', () => reloadPreview({ encoding: enc.value || 'auto' }));
    const parts = [h('label.imp-opt', null, 'Format ', fmt), h('label.imp-opt', null, 'Encoding ', enc)];
    if (p.format === 'csv' || p.format === 'tsv') {
      const del = h('select#imp-delim', null, DELIMS.map(([v, t]) => h('option', { value: v }, t)));
      del.value = p.delimiter ?? ',';
      del.addEventListener('change', () => reloadPreview({ delimiter: del.value }));
      const hdr = h('input', { type: 'checkbox', checked: p.header !== false });
      hdr.addEventListener('change', () => reloadPreview({ header: hdr.checked }));
      parts.push(h('label.imp-opt', null, 'Delimiter ', del), h('label.imp-opt', null, hdr, ' First row is a header'));
    }
    if (p.format === 'json' && (p.pointer_candidates?.length ?? 0) > 0) {
      const ptr = h('select#imp-pointer', null, p.pointer_candidates.map((c) => h('option', { value: c.pointer }, `${c.pointer || '(top level)'} — ${n(c.count)} items`)));
      ptr.value = p.pointer ?? '';
      ptr.addEventListener('change', () => reloadPreview({ pointer: ptr.value }));
      parts.push(h('label.imp-opt', null, 'Records at ', ptr));
    }
    if (p.format === 'txt' || p.format === 'md') {
      const lm = h('input', { type: 'checkbox', checked: Boolean(st.overrides.line_mode) });
      lm.addEventListener('change', () => reloadPreview({ line_mode: lm.checked }));
      parts.push(h('label.imp-opt', null, lm, ' Line mode (verse, transcripts)'));
    }
    return h('fieldset.imp-fieldset.imp-inline', { disabled: st.reading }, h('legend', null, 'How the file is read'), parts);
  }

  function sampleTable(p) {
    const cols = p.columns ?? [];
    const rows = p.sample_rows ?? [];
    if (!cols.length) return h('p.meta', null, 'No columns could be read.');
    const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    return h('div.imp-scroll-x', { tabindex: '0', role: 'region', 'aria-label': `Sample rows (${rows.length})` },
      h('table.imp-table', null,
        h('caption.visually-hidden', null, `The first ${rows.length} rows of ${st.file?.name ?? 'the file'}`),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Line'), cols.map((c) => h('th', { scope: 'col' }, c.name, h('span.imp-type', null, ` ${c.inferred}`))))),
        h('tbody', null, rows.map((r) => h('tr', null, h('td.num', null, r.$line ?? ''),
          cols.map((c) => { const t = cell(r[c.name] ?? (c.name.startsWith('/') ? undefined : r[c.name])); return h('td', null, t.length > 140 ? `${t.slice(0, 140)}…` : t); }))))));
  }

  function renderUpload() {
    const p = st.preview;
    const facts = p ? h('dl.imp-facts', null,
      h('div', null, h('dt', null, 'File'), h('dd', null, `${st.file?.name ?? p.file?.name ?? '—'}${p.file?.bytes ? ` · ${mb(p.file.bytes)}` : ''}`)),
      h('div', null, h('dt', null, 'Format'), h('dd', null, p.format.toUpperCase())),
      h('div', null, h('dt', null, 'Encoding'), h('dd', null, p.encoding)),
      p.delimiter ? h('div', null, h('dt', null, 'Delimiter'), h('dd', null, DELIM_WORD[p.delimiter] ?? JSON.stringify(p.delimiter))) : null,
      p.header !== null && p.header !== undefined ? h('div', null, h('dt', null, 'Header row'), h('dd', null, p.header ? 'yes' : 'no')) : null,
      h('div', null, h('dt', null, 'Sampled'), h('dd', null, `${n(p.sample_rows?.length ?? 0)} ${(p.sample_rows?.length ?? 0) === 1 ? 'row' : 'rows'} shown${p.records_sampled ? ` · ${n(p.records_sampled)} read for the column types` : ''}`
        + (p.partial ? ` · from the first ${mb(p.partial.bytes_read)} of ${mb(p.partial.bytes_total)}` : '')))) : null;
    const fatal = p?.fatal ?? null;
    return h('div.imp-step-body', null,
      heading('1 · Upload'),
      collectionFields(),
      st.uploading ? uploadProgress() : chooser(),
      st.reading ? h('p', { role: 'status' }, 'Reading the file again with the new settings…') : null,
      errorBox(st.error),
      p ? h('section.imp-preview', { 'aria-label': 'Preview' },
        h('h4.imp-h4', null, 'Preview'),
        p.mock_note ? h('p.imp-mock', { role: 'note' }, p.mock_note) : null,
        facts, previewControls(p),
        renderIssues(p.issues, { title: 'Found while reading the file' }),
        sampleTable(p),
        fatal ? h('p.imp-error', { role: 'alert' }, 'This file cannot be imported as it is (see above).') : null,
        h('p.imp-actions', null,
          h('button.btn.btn-primary', { type: 'button', disabled: Boolean(fatal) || st.reading, onClick: () => go(2) }, 'Next: map the fields ›'))) : null);
  }

  // ── step 2: map ───────────────────────────────────────────────────────────────────────────────────

  // Mapping reuse (P2): earlier imports with the same columns offer their fields and options.
  function reuseBox(p) {
    const prev = p.previous_mappings ?? [];
    if (!prev.length) return null;
    const sel = h('select#imp-reuse', null, prev.map((x, i) => h('option', { value: String(i) },
      `batch ${x.batch} · ${x.file_name ?? 'file'} · ${String(x.at ?? '').slice(0, 10)}${x.collection ? ` · ${x.collection}` : ''}`)));
    const apply = () => {
      const x = prev[Number(sel.value)];
      if (!x) return;
      st.mapping.fields = structuredClone(x.mapping.fields ?? {});
      for (const f of Object.values(st.mapping.fields)) f.reason = `reused from batch ${x.batch} (${x.file_name ?? 'file'})`;
      if (x.mapping.options) st.mapping.options = { ...st.mapping.options, ...structuredClone(x.mapping.options) };
      st.validation = null;
      announce(`Mapping of batch ${x.batch} applied.`);
      render();
    };
    return h('fieldset.imp-fieldset.imp-inline', null, h('legend', null, 'Reuse a mapping'),
      h('label.imp-opt', { htmlFor: 'imp-reuse' }, 'Same columns as '), sel,
      h('button.btn', { type: 'button', onClick: apply }, 'Apply'),
      h('span.meta', null, 'Fields and options only; the collection stays as chosen in step 1.'));
  }

  function renderMap() {
    const p = st.preview;
    st.mapping.collection = collectionSpec();
    const table = renderMappingTable({ mapping: st.mapping, columns: p.columns ?? [], sampleRows: p.sample_rows ?? [], format: p.format,
      onChange: () => { st.validation = null; } });
    return h('div.imp-step-body', null,
      heading('2 · Map the fields'),
      h('p.meta', null, `Into collection ${st.mapping.collection.name} (${st.mapping.collection.slug}). Every column you leave unmapped is still kept, verbatim, with its record.`),
      reuseBox(p),
      table,
      errorBox(st.error),
      h('p.imp-actions', null,
        h('button.btn', { type: 'button', onClick: () => go(1) }, '‹ Back'),
        h('button.btn.btn-primary', { type: 'button', onClick: validate }, 'Validate: dry run over every row ›')));
  }

  // ── step 3: validate (dry run) ────────────────────────────────────────────────────────────────────

  async function validate() {
    st.mapping.collection = collectionSpec();
    focusHeading = true;
    setState({ step: 3, validating: true, validation: null, error: null, validateStarted: Date.now() });
    announce('Dry run started: every row is checked; nothing is written.');
    clearInterval(tickTimer);
    tickTimer = setInterval(() => { if (elapsedEl) elapsedEl.textContent = elapsed(); }, 1000);
    try {
      const res = await api.put(`/imports/${st.batchId}/mapping`, { mapping: st.mapping }, { key: 'import-validate' });
      const errs = check('ImportValidation', res);
      if (errs.length) throw Object.assign(new Error(`The server's answer was not an import summary (${errs[0]}).`), { code: 'E_CONTRACT' });
      setState({ validation: res.validation, validating: false });
      const v = res.validation;
      announce(`Dry run done: ${n(v.rows.accepted)} rows would be accepted, ${n(v.rows.rejected)} rejected.`);
    } catch (err) {
      if (isAbort(err)) return;
      setState({ validating: false, error: errInfo(err) });
      announce(`Dry run failed: ${err?.message ?? err}`, { politeness: 'assertive' });
    } finally {
      clearInterval(tickTimer);
    }
  }

  const elapsed = () => `${n(Math.floor((Date.now() - st.validateStarted) / 1000))} s`;

  function renderValidate() {
    const v = st.validation;
    const blocked = Boolean(v?.fatal || v?.aborted);
    return h('div.imp-step-body', null,
      heading('3 · Validate'),
      st.validating ? h('p', { role: 'status' }, 'Checking every row (dry run; nothing is written)… ', (elapsedEl = h('span.num', null, elapsed()))) : null,
      errorBox(st.error, [h('button.btn', { type: 'button', onClick: () => go(2) }, '‹ Back to the mapping')]),
      v ? renderSummary(v, { projected: true, downloadUrl: v.problems?.download ? apiUrl(v.problems.download) : null }) : null,
      !st.validating ? h('p.imp-actions', null,
        h('button.btn', { type: 'button', onClick: () => go(2) }, '‹ Back'),
        v ? h('button.btn.btn-primary', { type: 'button', disabled: blocked, onClick: commit },
          blocked ? 'Cannot commit (see above)' : `Commit: import ${n(v.rows.accepted)} rows ›`) : null) : null);
  }

  // ── step 4: commit (job) ──────────────────────────────────────────────────────────────────────────

  async function commit() {
    focusHeading = true;
    setState({ step: 4, job: null, result: null, resultNote: null, jobError: null, error: null });
    try {
      const res = await api.post(`/imports/${st.batchId}/commit`, { mapping: st.mapping });
      const errs = check('JobRef', res);
      if (errs.length) throw Object.assign(new Error(`The server's answer was not a job (${errs[0]}).`), { code: 'E_CONTRACT' });
      setState({ job: { id: res.job.id, status: 'queued', fraction: 0, phase: null, message: null, counts: null } });
      announce(`Import job ${res.job.id} started.`);
      watchJob(res.job.id);
    } catch (err) {
      if (isAbort(err)) return;
      setState({ error: errInfo(err) });
      announce(`The import could not start: ${err?.message ?? err}`, { politeness: 'assertive' });
    }
  }

  function stopJobWatch() {
    offSse?.();
    offSse = null;
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  function onProgress(d) {
    if (!st.job || FINAL.has(st.job.status)) return;
    st.job = { ...st.job, status: d.status && d.status !== 'queued' ? d.status : 'running', fraction: typeof d.fraction === 'number' ? d.fraction : st.job.fraction,
      phase: d.phase ?? st.job.phase, message: d.message ?? st.job.message, counts: d.counts ?? st.job.counts };
    updateJobProgress();
  }

  function watchJob(id) {
    stopJobWatch();
    let finished = false;
    const done = (d) => { if (finished) return; finished = true; stopJobWatch(); finishJob(id, d); };
    try {
      offSse = api.sse(`/jobs/${id}/events`, {
        progress: onProgress,
        done,
        onError: (info) => { if (!finished && info?.readyState === 2) { offSse?.(); offSse = null; poll(id, done); } },
      });
    } catch {
      poll(id, done);
    }
  }

  function poll(id, done) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try {
        const job = await api.get(`/jobs/${id}`, null, { key: `import-job-${id}` });
        if (FINAL.has(job.status)) { done({ job: id, status: job.status, error: job.error ?? null, run_id: job.run_id ?? null, row: job }); return; }
        onProgress({ status: job.status, fraction: job.progress, phase: job.phase, message: job.message, counts: job.counts });
      } catch (err) {
        if (isAbort(err)) return;
      }
      poll(id, done);
    }, POLL_MS);
  }

  async function finishJob(id, d) {
    let row = d.row ?? null;
    if (!row) {
      try { row = await api.get(`/jobs/${id}`, null, { key: `import-job-${id}` }); } catch { row = null; }
    }
    const status = d.status ?? row?.status ?? 'failed';
    const result = row?.result && check('ImportSummary', row.result).length === 0 ? row.result : null;
    const job = { ...(st.job ?? { id }), status, fraction: status === 'succeeded' ? 1 : st.job?.fraction ?? 0 };
    if (status === 'succeeded') {
      setState({ job, result, resultNote: result ? null : 'The job finished, but the server sent no import summary with it; the dry-run projection is shown instead.' });
      announce(result ? `Import done: ${n(result.documents.created)} documents.` : 'Import job finished.');
    } else {
      const e = d.error ?? row?.error ?? null;
      setState({ job, jobError: status === 'cancelled' ? { code: 'E_CANCELLED', message: 'The import was cancelled; nothing from this file was kept.', hint: 'Commit again when you are ready.' }
        : { code: e?.code ?? 'E_IMPORT_FAILED', message: e?.message ?? `The import job ended ${status}.`, hint: e?.hint ?? 'Nothing from this file was kept; fix the problem and commit again.' } });
      announce(`Import ${status}: ${e?.message ?? ''}`, { politeness: 'assertive' });
    }
  }

  function jobProgressEls() {
    const j = st.job;
    const pct = Math.round((j?.fraction ?? 0) * 100);
    const bar = h('progress.imp-progress', { max: '100', value: String(pct), 'aria-label': 'Import progress', 'aria-valuetext': `${pct}%` });
    const text = h('p', { role: 'status' }, jobText(j, pct));
    progressBox = { bar, text };
    return [bar, text];
  }

  function jobText(j, pct) {
    if (!j) return 'Starting the import…';
    if (j.status === 'queued') return `Job ${j.id} is waiting for the writer (another write job may be running)… 0%`;
    if (j.status === 'cancelling') return `Cancelling job ${j.id}… ${pct}%`;
    return `${j.phase === 'links' ? 'Resolving links' : 'Writing'}… ${pct}%${j.message ? ` — ${j.message}` : ''}`;
  }

  function updateJobProgress() {
    if (!progressBox || !st.job || st.step !== 4) return;
    const pct = Math.round((st.job.fraction ?? 0) * 100);
    progressBox.bar.value = pct;
    progressBox.bar.setAttribute('aria-valuetext', `${pct}%`);
    progressBox.text.textContent = jobText(st.job, pct);
  }

  async function cancelJob() {
    if (!st.job) return;
    try {
      await api.post(`/jobs/${st.job.id}/cancel`, {});
      st.job = { ...st.job, status: 'cancelling' };
      updateJobProgress();
      announce('Cancelling the import.');
    } catch (err) {
      if (!isAbort(err)) setState({ error: errInfo(err) });
    }
  }

  function openInTimeline() {
    const slug = st.result?.collection ?? st.mapping?.collection?.slug;
    store.dispatch({ type: 'SET_CORPUS', corpus: 'user' });
    if (slug) store.dispatch({ type: 'SET_FILTER', key: 'coll', values: [slug] });
    store.dispatch({ type: 'CLOSE_PANEL', panel: 'import' });
    announce(`Showing your collection ${slug ?? ''} on the timeline.`);
  }

  function another() {
    stopJobWatch();
    st = fresh();
    focusHeading = true;
    render();
  }

  // Revert (P2): soft-delete this batch's documents through the 'revert' job; asks once before doing it.
  async function revert() {
    setState({ revert: { phase: 'running', job: null } });
    try {
      const res = await api.post(`/imports/${st.batchId}/revert`, {});
      const errs = check('JobRef', res);
      if (errs.length) throw Object.assign(new Error(`The server's answer was not a job (${errs[0]}).`), { code: 'E_CONTRACT' });
      setState({ revert: { phase: 'running', job: res.job.id } });
      announce(`Revert job ${res.job.id} started.`);
      const until = Date.now() + 120000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        const job = await api.get(`/jobs/${res.job.id}`, null, { key: `import-revert-${res.job.id}` });
        if (FINAL.has(job.status)) {
          const ok = job.status === 'succeeded';
          setState({ revert: { phase: ok ? 'done' : 'error', job: res.job.id, result: job.result ?? null,
            error: ok ? null : { code: job.error?.code ?? 'E_REVERT', message: job.error?.message ?? `The revert job ended ${job.status}.`, hint: job.error?.hint ?? null } } });
          announce(ok ? 'Import reverted.' : 'The revert did not finish.');
          return;
        }
        if (Date.now() > until) throw Object.assign(new Error(`Revert job ${res.job.id} is still ${job.status}.`), { code: 'E_TIMEOUT', hint: 'Follow it in the jobs list.' });
      }
    } catch (err) {
      if (isAbort(err)) return;
      setState({ revert: { phase: 'error', error: errInfo(err) } });
    }
  }

  function revertBox() {
    const r = st.revert;
    const docs = st.result?.documents?.created;
    if (!r) return h('p.imp-actions', null, h('button.btn', { type: 'button', onClick: () => setState({ revert: { phase: 'confirm' } }) }, 'Undo this import…'));
    if (r.phase === 'confirm') {
      return h('div.imp-error-box', { role: 'group', 'aria-label': 'Confirm the revert' },
        h('p', null, `Revert this import? Its ${docs !== undefined ? `${n(docs)} documents` : 'documents'} are hidden (soft-deleted: kept on disk, so saved views that pinned them still resolve) and their ids stay taken in the collection.`),
        h('p.imp-actions', null,
          h('button.btn', { type: 'button', onClick: () => setState({ revert: null }) }, 'Keep the import'),
          h('button.btn.btn-primary', { type: 'button', onClick: revert }, 'Revert')));
    }
    if (r.phase === 'running') return h('p', { role: 'status' }, r.job ? `Reverting (job ${r.job})…` : 'Starting the revert…');
    if (r.phase === 'done') return h('p', { role: 'status' }, `Reverted: ${n(r.result?.documents ?? null)} documents hidden${Number.isInteger(r.result?.data_version) ? ` (data v${r.result.data_version})` : ''}.`);
    return errorBox(r.error);
  }

  function renderCommit() {
    const j = st.job;
    const running = j && !FINAL.has(j.status);
    return h('div.imp-step-body', null,
      heading('4 · Commit'),
      errorBox(st.error, [h('button.btn', { type: 'button', onClick: () => go(3) }, '‹ Back to the dry run')]),
      running || (!j && !st.error) ? h('div.imp-progress-box', null, jobProgressEls(),
        j ? h('p.imp-actions', null, h('button.btn', { type: 'button', onClick: cancelJob, disabled: j.status === 'cancelling' }, 'Cancel the import')) : null,
        h('p.meta', null, 'You can close this panel: the job keeps running and shows in the jobs list.')) : null,
      st.jobError ? errorBox(st.jobError, [h('button.btn', { type: 'button', onClick: () => go(2) }, '‹ Back to the mapping')]) : null,
      j?.status === 'succeeded' ? h('div', null,
        st.resultNote ? h('p.imp-mock', { role: 'note' }, st.resultNote) : null,
        st.result ? renderSummary(st.result, { projected: false, downloadUrl: st.result.problems?.download ? apiUrl(st.result.problems.download) : null })
          : st.validation ? renderSummary(st.validation, { projected: true }) : null,
        st.revert?.phase === 'done' ? null : h('p.imp-actions', null,
          h('button.btn.btn-primary', { type: 'button', onClick: openInTimeline }, 'Open in timeline'),
          h('button.btn', { type: 'button', onClick: another }, 'Import another file')),
        revertBox(),
        st.revert?.phase === 'done' ? h('p.imp-actions', null, h('button.btn', { type: 'button', onClick: another }, 'Import another file')) : null) : null);
  }

  // ── wiring ────────────────────────────────────────────────────────────────────────────────────────

  function apiUrl(p) {
    if (/^\/api\//.test(p) && typeof api.url === 'function') return api.url(p.slice(4));
    return p;
  }

  const onDocDragOver = (e) => { if (hasFiles(e)) e.preventDefault(); };
  const onDocDrop = (e) => {
    if (e.defaultPrevented || !hasFiles(e)) return;
    const f = e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    if (!isOpen(store.get())) {
      pendingFile = f;
      store.dispatch({ type: 'OPEN_PANEL', panel: 'import' });
    } else if (st.step === 1 && !st.uploading) startUpload(f);
  };
  doc?.addEventListener?.('dragover', onDocDragOver);
  doc?.addEventListener?.('drop', onDocDrop);

  const unsub = store.subscribe(isOpen, (open) => (open ? show() : hide()), { immediate: true });

  return {
    unmount() {
      unsub();
      stopJobWatch();
      clearInterval(tickTimer);
      doc?.removeEventListener?.('dragover', onDocDragOver);
      doc?.removeEventListener?.('drop', onDocDrop);
      root?.remove();
      root = null;
    },
    /** For tests: the current wizard state. */
    state: () => st,
  };
}

function hasFiles(e) {
  const types = e?.dataTransfer?.types;
  return Boolean(types && (typeof types.includes === 'function' ? types.includes('Files') : Array.from(types).includes('Files')));
}
