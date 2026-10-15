// OWNER: WP1
// import/mapping-table.mjs — step 2 of the import wizard: the mapping table (SPEC §5.2, §8.1).
//
// One row per canonical target: a source (a column, a constant, or nothing), its transforms written as text
// ("trim, split(;)", "date(circa_radius=5)"), and why it was suggested. Under the table, the live parse
// panel and a preview grid apply the mapping to the 20 sample rows in the browser with the shared date
// grammar (/shared/dates.mjs), so a bad date shows in red with its reason before any dry run. The server
// re-checks everything (PUT /api/imports/:id/mapping). This module is a library of the wizard: it mounts
// nothing by itself.

import { parseDate } from '../../shared/dates.mjs';
import { formatCount } from '../../shared/format.mjs';
import { h } from '../core/dom.mjs';

/** Targets in display order with a short explanation (SPEC §5.2). */
export const TARGETS = Object.freeze([
  ['text', 'Text', 'the words that are searched and counted'],
  ['title', 'Title', 'shown on marks and cards; searchable as a title'],
  ['ext_id', 'Id', 'your id for the record; other rows cite it (generated when empty)'],
  ['author', 'Author', 'author, speaker or maker'],
  ['date', 'Date', 'when it was published or made: the chronology'],
  ['date_end', 'Date (end)', 'end of a date range, read with Date'],
  ['date_precision', 'Date precision', 'widen a date to day, month, year, decade, century or millennium (never narrows)'],
  ['referenced_date', 'Referenced date', 'the time the text is about, kept apart from chronology'],
  ['language', 'Language', 'declared language (names or codes); passages are still identified one by one'],
  ['kind', 'Kind', 'book, letter, song, zine…'],
  ['genre', 'Genre', ''],
  ['community', 'Community', 'the group or scene it comes from'],
  ['culture', 'Country of origin', ''],
  ['field', 'STEMM field', ''],
  ['source_url', 'Source URL', ''],
  ['license', 'Licence', 'per record; the collection licence applies otherwise'],
  ['cites', 'Cites', 'ids this record cites → documented citation links, as stated in your file'],
  ['relations', 'Relations', 'typed links such as samples:z001 or parody_of:z002:proposed'],
  ['tags', 'Tags', 'keywords (catalogue tags, not text)'],
  ['notes', 'Notes', 'kept with the record, not searched'],
]);
const DATE_TARGETS = new Set(['date', 'date_end', 'referenced_date']);
const CONST = '\u0000const';
const NONE = '';
const DATE_KEYS = { circa_radius: 'circaRadius', open_range_years: 'openRangeYears', two_digit_century: 'twoDigitCentury',
  zero_is_unknown: 'zeroIsUnknown', negative_year_convention: 'negativeYearConvention' };

// ── transforms as text ──────────────────────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\f/g, '\\f');
const unesc = (s) => String(s).replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\f/g, '\f');

/** One transform → its text form. */
export function transformToText(t) {
  if (typeof t === 'string') return t;
  const [op] = Object.keys(t ?? {});
  const arg = t?.[op];
  switch (op) {
    case 'split': case 'join': return `${op}(${esc(arg)})`;
    case 'date': {
      const parts = Object.entries(arg ?? {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${v}`);
      return `date(${parts.join(', ')})`;
    }
    case 'map': return `map(${Object.entries(arg ?? {}).map(([k, v]) => `${k}=${v}`).join('; ')})`;
    case 'regex_extract': {
      const spec = typeof arg === 'string' ? { pattern: arg } : Array.isArray(arg) ? { pattern: arg[0], group: arg[1] } : arg ?? {};
      return `regex_extract(/${spec.pattern}/${spec.group !== undefined ? `, ${spec.group}` : ''})`;
    }
    default: return op ?? '';
  }
}

/** A transform list → "trim, split(;)". */
export const transformsToText = (list) => (list ?? []).map(transformToText).join(', ');

/** Split on top-level commas (not inside parentheses or /regex/). */
function splitTop(s) {
  const out = [];
  let depth = 0, cur = '', inRe = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '/' && depth > 0 && s[i - 1] !== '\\') inRe = !inRe;
    if (!inRe) {
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * Parse the text form back into transforms (the server's closed list: trim, lower, zero_is_unknown, split,
 * join, date, map, regex_extract).
 * @param {string} text
 * @returns {{list: Array<string|object>, error: string|null}}
 */
export function parseTransforms(text) {
  const list = [];
  for (const part of splitTop(String(text ?? ''))) {
    const m = /^([a-z_]+)\s*(?:\(([\s\S]*)\))?$/.exec(part);
    if (!m) return { list, error: `'${part}' is not a transform` };
    const [, op, arg] = m;
    if (['trim', 'lower', 'zero_is_unknown'].includes(op)) { list.push(op); continue; }
    if (op === 'split' || op === 'join') {
      if (!arg) return { list, error: `${op} needs a delimiter, e.g. ${op}(;)` };
      list.push({ [op]: unesc(arg) });
      continue;
    }
    if (op === 'date') {
      const o = {};
      for (const kv of (arg ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
        const [k, v] = kv.split('=').map((x) => x.trim());
        if (!(k in DATE_KEYS)) return { list, error: `unknown date option '${k}'` };
        o[k] = v === 'null' ? null : /^-?\d+$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
      }
      list.push({ date: o });
      continue;
    }
    if (op === 'map') {
      const o = {};
      for (const kv of (arg ?? '').split(';').map((x) => x.trim()).filter(Boolean)) {
        const i = kv.indexOf('=');
        if (i <= 0) return { list, error: `map entries are value=replacement (got '${kv}')` };
        o[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
      }
      list.push({ map: o });
      continue;
    }
    if (op === 'regex_extract') {
      const rm = /^\/([\s\S]*)\/\s*(?:,\s*(\w+))?$/.exec((arg ?? '').trim());
      if (!rm) return { list, error: 'regex_extract is written regex_extract(/pattern/, group)' };
      try { new RegExp(rm[1], 'u'); } catch (err) { return { list, error: `the pattern is not valid: ${err.message}` }; }
      list.push({ regex_extract: { pattern: rm[1], ...(rm[2] !== undefined ? { group: /^\d+$/.test(rm[2]) ? Number(rm[2]) : rm[2] } : {}) } });
      continue;
    }
    return { list, error: `'${op}' is not one of trim, lower, split, join, date, zero_is_unknown, map, regex_extract` };
  }
  return { list, error: null };
}

// ── applying a mapping to sample rows (display only; the server is the authority) ───────────────────

function valueAt(row, from) {
  if (!row || from === undefined || from === null) return undefined;
  if (Object.prototype.hasOwnProperty.call(row, from)) return row[from];
  if (typeof from === 'string' && from.startsWith('/')) {
    let v = row;
    for (const t of from.slice(1).split('/').map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'))) v = v && typeof v === 'object' ? v[t] : undefined;
    return v;
  }
  return undefined;
}

/**
 * The value a target gets for one sample row, after its transforms, plus the date options they set.
 * @returns {{value: unknown, dateOpts: object}}
 */
export function previewValue(row, spec) {
  if (!spec) return { value: undefined, dateOpts: {} };
  let v = spec.const !== undefined ? spec.const : valueAt(row, spec.from);
  const dateOpts = {};
  for (const t of spec.transform ?? []) {
    const op = typeof t === 'string' ? t : Object.keys(t)[0];
    const arg = typeof t === 'string' ? null : t[op];
    const each = (f) => (Array.isArray(v) ? v.map(f) : f(v));
    if (op === 'trim') v = each((x) => (typeof x === 'string' ? x.trim() : x));
    else if (op === 'lower') v = each((x) => (typeof x === 'string' ? x.toLowerCase() : x));
    else if (op === 'split' && typeof v === 'string') v = v.split(arg).map((x) => x.trim()).filter(Boolean);
    else if (op === 'join' && Array.isArray(v)) v = v.join(arg);
    else if (op === 'map') v = each((x) => (arg && Object.prototype.hasOwnProperty.call(arg, String(x)) ? arg[String(x)] : x));
    else if (op === 'regex_extract') {
      const spec2 = typeof arg === 'string' ? { pattern: arg } : arg ?? {};
      let re = null;
      try { re = new RegExp(spec2.pattern, 'u'); } catch { re = null; }
      const g = spec2.group ?? (/\((?!\?)/.test(spec2.pattern ?? '') ? 1 : 0);
      v = each((x) => { if (!re || typeof x !== 'string') return x; const m = re.exec(x); return m ? (m[g] ?? null) : null; });
    } else if (op === 'zero_is_unknown') dateOpts.zeroIsUnknown = true;
    else if (op === 'date') for (const [k, x] of Object.entries(arg ?? {})) if (DATE_KEYS[k]) dateOpts[DATE_KEYS[k]] = x;
  }
  return { value: v, dateOpts };
}

/**
 * Parse a sample value as the server would: {ok, label, kind: 'parsed'|'circa'|'unknown'|'invalid', message}.
 */
export function previewDate(value, dateOpts, now = new Date()) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const r = parseDate(String(value).trim(), { ...dateOpts, now });
  if (r.issue) return { ok: false, kind: 'invalid', label: null, message: r.issue.message, code: r.issue.code };
  if (r.lo_day === null) return { ok: true, kind: 'unknown', label: 'undated', message: 'read as unknown (undated)' };
  return { ok: true, kind: r.approx ? 'circa' : r.basis === 'announced' ? 'scheduled' : 'parsed', label: r.label, message: r.rule };
}

/**
 * The live parse line of a date target over the sample rows:
 * "date: 18 / 20 sample rows parse · 2 circa · 1 unknown · 1 invalid".
 */
export function dateParseLine(target, rows, spec, now = new Date()) {
  let filled = 0, parsed = 0, circa = 0, unknown = 0, invalid = 0;
  for (const row of rows) {
    const { value, dateOpts } = previewValue(row, spec);
    const d = previewDate(value, dateOpts, now);
    if (!d) continue;
    filled++;
    if (d.kind === 'invalid') invalid++;
    else if (d.kind === 'unknown') unknown++;
    else { parsed++; if (d.kind === 'circa') circa++; }
  }
  return { target, filled, parsed, circa, unknown, invalid, rows: rows.length,
    text: `${target}: ${formatCount(parsed)} / ${formatCount(rows.length)} sample rows parse · ${formatCount(circa)} circa · ${formatCount(unknown)} unknown · ${formatCount(invalid)} invalid` };
}

/** Why a field is mapped: a suggestion, or a reused mapping. */
const reasonText = (r) => (!r ? null : /^reused /.test(r) ? `${r.charAt(0).toUpperCase()}${r.slice(1)}.` : `Suggested: ${r}.`);

const shown = (v) => (v === undefined || v === null ? '' : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' | ')
  : typeof v === 'object' ? JSON.stringify(v) : String(v));
const clip = (s, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ── the table ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Render the mapping table. `mapping` is edited in place; `onChange(mapping)` fires after every edit.
 * @param {{mapping: object, columns: Array<{name: string, inferred?: string, samples?: string[]}>, sampleRows: object[],
 *   format: string, onChange: (mapping: object) => void, now?: Date}} opts
 * @returns {HTMLElement}
 */
export function renderMappingTable({ mapping, columns, sampleRows, format, onChange, now = new Date() }) {
  mapping.fields ??= {};
  const F = mapping.fields;
  const live = h('div.imp-live', { 'aria-live': 'polite' });
  const grid = h('div.imp-scroll-x', { tabindex: '0', role: 'region', 'aria-label': 'Mapped sample rows' });
  const rowsBody = h('tbody');

  const refreshLive = () => {
    live.replaceChildren();
    const dateTargets = [...DATE_TARGETS].filter((t) => F[t]);
    for (const t of dateTargets) {
      const line = dateParseLine(t, sampleRows, F[t], now);
      live.appendChild(h('p.imp-parse-line', { dataset: { bad: line.invalid ? '1' : '0' } }, line.invalid ? '⚠ ' : '', line.text));
    }
    if (!dateTargets.length) live.appendChild(h('p.meta', null, 'No date is mapped: every record will be undated (kept on the UNDATED shelf, outside chronology).'));
    if (!F.text && !F.title) live.appendChild(h('p.imp-error', { role: 'alert' }, 'Map a text column or a title: rows with neither are rejected.'));
    renderGrid();
  };

  const renderGrid = () => {
    // dates first (that is what the live check is about), the long text last
    const order = ['date', 'date_end', 'referenced_date', 'date_precision', 'title', 'ext_id', 'language', 'author'];
    const targets = [...order, ...TARGETS.map(([t]) => t).filter((t) => !order.includes(t) && t !== 'text'), 'text'].filter((t) => F[t]);
    if (!targets.length || !sampleRows.length) { grid.replaceChildren(h('p.meta', null, 'Nothing mapped yet.')); return; }
    const head = h('tr', null, h('th', { scope: 'col' }, 'Line'), targets.map((t) => h('th', { scope: 'col' }, t)));
    const body = sampleRows.map((row) => h('tr', null,
      h('td.num', null, row.$line ?? ''),
      targets.map((t) => {
        const { value, dateOpts } = previewValue(row, F[t]);
        if (DATE_TARGETS.has(t)) {
          const d = previewDate(value, dateOpts, now);
          if (d && !d.ok) {
            return h('td.is-bad', { title: d.message }, h('span', { 'aria-hidden': 'true' }, '⚠ '), clip(shown(value)),
              h('span.visually-hidden', null, ` — not read: ${d.message}`));
          }
          return h('td', null, clip(shown(value)), d?.label && d.label !== shown(value) ? h('span.meta', null, ` → ${d.label}`) : null);
        }
        return h('td', null, clip(shown(value), t === 'text' ? 80 : 120));
      })));
    grid.replaceChildren(h('table.imp-table', null, h('caption.visually-hidden', null, 'The 20 sample rows as they would be imported'),
      h('thead', null, head), h('tbody', null, body)));
  };

  const options = [h('option', { value: NONE }, '— not mapped —'),
    ...columns.map((c) => h('option', { value: c.name }, c.inferred ? `${c.name} (${c.inferred})` : c.name)),
    h('option', { value: CONST }, 'A constant value…')];

  const rowFor = ([target, label, help]) => {
    const spec = F[target];
    const id = `imp-src-${target}`;
    const select = h('select', { id, 'aria-describedby': `${id}-help` }, options.map((o) => o.cloneNode(true)));
    select.value = spec ? (spec.const !== undefined ? CONST : String(spec.from)) : NONE;
    const constInput = h('input.imp-input', { type: 'text', 'aria-label': `${label}: constant value`, value: spec?.const !== undefined ? String(spec.const) : '',
      hidden: !(spec && spec.const !== undefined), placeholder: 'value for every row' });
    const tInput = h('input.imp-input.imp-mono', { type: 'text', 'aria-label': `${label}: transforms`, value: transformsToText(spec?.transform),
      placeholder: DATE_TARGETS.has(target) ? 'date(circa_radius=5)' : target === 'cites' || target === 'tags' ? 'split(;)' : 'trim', disabled: !spec });
    const tErr = h('span.imp-error', { role: 'status' });
    const why = h('span.meta', { id: `${id}-help` }, reasonText(spec?.reason) ?? help);

    const update = () => {
      const v = select.value;
      constInput.hidden = v !== CONST;
      tInput.disabled = v === NONE;
      if (v === NONE) { delete F[target]; }
      else {
        const parsed = parseTransforms(tInput.value);
        tErr.textContent = parsed.error ? `⚠ ${parsed.error}` : '';
        const prev = F[target];
        const next = v === CONST ? { const: constInput.value } : { from: v };
        if (prev?.reason && ((v === CONST && prev.const !== undefined) || prev.from === v)) next.reason = prev.reason;
        if (!parsed.error && parsed.list.length) next.transform = parsed.list;
        else if (parsed.error && prev?.transform) next.transform = prev.transform;
        F[target] = next;
      }
      why.textContent = reasonText(F[target]?.reason) ?? help;
      refreshLive();
      onChange?.(mapping);
    };
    select.addEventListener('change', update);
    constInput.addEventListener('input', update);
    tInput.addEventListener('change', update);
    return h('tr', { dataset: { target } },
      h('th', { scope: 'row' }, h('label', { htmlFor: id }, label), h('br'), h('code.meta', null, target)),
      h('td', null,
        h('div.imp-map-src', null, select, tInput),
        constInput, tErr, h('div', null, why)));
  };

  rowsBody.replaceChildren(...TARGETS.map(rowFor));
  const extra = Object.keys(F).filter((k) => k.startsWith('meta.') || k === 'collection');
  const extraNote = extra.length ? h('p.meta', null, `Also mapped (kept as given): ${extra.join(', ')}.`) : null;

  const opt = mapping.options ?? (mapping.options = {});
  const sel = (label, key, values, dflt) => {
    const s = h('select', { 'aria-label': label }, values.map(([v, t]) => h('option', { value: v }, t)));
    s.value = String(opt[key] ?? dflt);
    s.addEventListener('change', () => { opt[key] = s.value; onChange?.(mapping); });
    return h('label.imp-opt', null, `${label} `, s);
  };
  const chk = (label, key, dflt) => {
    const c = h('input', { type: 'checkbox', checked: Boolean(opt[key] ?? dflt) });
    c.addEventListener('change', () => { opt[key] = c.checked; onChange?.(mapping); });
    return h('label.imp-opt', null, c, ` ${label}`);
  };
  const optionsBox = h('fieldset.imp-fieldset', null, h('legend', null, 'Options'),
    sel('Duplicate texts', 'dedupe', [['flag', 'keep, flagged (excluded from counts)'], ['skip', 'skip the later copy'], ['off', 'do not check']], 'flag'),
    sel('A bad row', 'on_bad_row', [['skip_and_report', 'skip it and report it'], ['abort', 'stop the whole import']], 'skip_and_report'),
    chk('Identify the language of every passage', 'detect_language', true),
    format === 'txt' || format === 'md' ? chk('Line mode (verse, transcripts): blocks become stanzas', 'line_mode', false) : null);

  refreshLive();
  return h('div.imp-mapping', null,
    h('div.imp-scroll-x', { tabindex: '0', role: 'region', 'aria-label': 'Field mapping' },
      h('table.imp-table.imp-map', null,
        h('caption.visually-hidden', null, 'Map each target field to a column of your file'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Target'), h('th', { scope: 'col' }, 'Source column · transforms'))),
        rowsBody)),
    extraNote,
    optionsBox,
    h('h4.imp-h4', null, 'Live check on the sample rows'),
    live,
    grid);
}

/**
 * Library module: the wizard renders the mapping table; nothing is mounted on its own.
 * @param {HTMLElement} el
 * @param {object} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  return { unmount() {} };
}

/** Not mounted in a region (the wizard imports it). */
export const region = null;
