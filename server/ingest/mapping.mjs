// OWNER: WP1
// mapping.mjs — field mapping and the closed transform list (SPEC §5.2): one source record → one
// CanonicalDocument (§12.3) plus the relationships it states. Everything unmapped stays in original_meta.
//
// Dates are parsed here (not by DocumentWriter) so that the dry run and the commit report the same issues
// with the same words: a date that does not parse is handed to the writer as an explicit 'unparsed'
// assertion (raw kept, undated), and its issue is recorded by the pipeline.

import { dayFromYMD, daysInMonth, fromDayInterval, fromInterval, parseDate, todayDay, ymdFromDay } from '../../src/shared/dates.mjs';
import { slugify } from '../../src/shared/ids.mjs';
import { REL_TYPE_BY_CODE } from '../../src/shared/vocab.mjs';
import { utf8Length } from './decode.mjs';
import { getPointer } from './json.mjs';
import { fileStem } from './txt.mjs';

/** Canonical targets (§5.2) → value type. `meta.<name>` targets are passthrough. */
export const TARGETS = Object.freeze({
  ext_id: 'id', title: 'string', text: 'text', author: 'string', date: 'date', date_end: 'date',
  date_precision: 'string', referenced_date: 'date', language: 'lang', kind: 'string', genre: 'string',
  community: 'string', culture: 'string', field: 'string', collection: 'string', source_url: 'string',
  license: 'string', cites: 'list', relations: 'relations', tags: 'list', notes: 'string',
});
/** Display order of the targets in the mapping table. */
export const TARGET_ORDER = Object.freeze(['text', 'title', 'ext_id', 'author', 'date', 'date_end', 'date_precision',
  'referenced_date', 'language', 'kind', 'genre', 'community', 'culture', 'field', 'source_url', 'license', 'cites',
  'relations', 'tags', 'notes', 'collection']);
/** The closed transform list (§5.2). */
export const TRANSFORMS = Object.freeze(['trim', 'join', 'split', 'lower', 'date', 'zero_is_unknown', 'map', 'regex_extract']);
const DATE_TARGETS = new Set(['date', 'date_end', 'referenced_date']);
/** 20 MB per text field (§5.1). */
export const MAX_FIELD_BYTES = 20 * 1024 * 1024;
const MAX_ID = 512;
const MAX_STRING = 4096;
const PRECISION_ORDER = ['day', 'month', 'year', 'decade', 'century', 'millennium'];
const DATE_OPTION_KEYS = { circa_radius: 'circaRadius', open_range_years: 'openRangeYears', two_digit_century: 'twoDigitCentury',
  zero_is_unknown: 'zeroIsUnknown', negative_year_convention: 'negativeYearConvention' };
/** Relationship types a file may state as documented: similarity and sense links are computed or proposed only. */
const PROPOSED_ONLY_FAMILIES = new Set(['similarity', 'sense']);

// ── languages ───────────────────────────────────────────────────────────────────────────────────────

const LANG_NAMES = (() => {
  const t = {
    en: 'english eng anglais ingles inglés englisch अंग्रेज़ी अंग्रेजी અંગ્રેજી',
    fr: 'french français francais fra fre francés frances französisch फ़्रांसीसी फ्रेंच ફ્રેન્ચ',
    es: 'spanish español espanol castellano spa espagnol spanisch स्पेनिश સ્પેનિશ',
    hi: 'hindi हिन्दी हिंदी hin hindí હિન્દી',
    gu: 'gujarati ગુજરાતી guj gujarātī गुजराती',
    de: 'german deutsch ger deu allemand alemán aleman जर्मन',
    la: 'latin latina lat latín latein',
    it: 'italian italiano ita italien',
    pt: 'portuguese português portugues por portugais',
    sa: 'sanskrit संस्कृतम् संस्कृत san sanscrit sánscrito',
    mr: 'marathi मराठी mar',
    ur: 'urdu اردو urd',
    bn: 'bengali bangla বাংলা ben',
    pa: 'punjabi ਪੰਜਾਬੀ pan',
    ta: 'tamil தமிழ் tam',
    te: 'telugu తెలుగు tel',
    nl: 'dutch nederlands nld dut',
    ru: 'russian русский rus',
    zh: 'chinese 中文 zho chi',
    ja: 'japanese 日本語 jpn',
    ar: 'arabic العربية ara',
  };
  const m = new Map();
  for (const [code, names] of Object.entries(t)) for (const n of names.split(' ')) m.set(n.normalize('NFC').toLowerCase(), code);
  return m;
})();

/**
 * A declared language as a code: names ('English', 'हिन्दी') and 3-letter codes map to the 2-letter code;
 * BCP-47 tags keep their subtags ('en-GB'). Null when the value is not recognisably a language.
 * @param {string} value
 * @returns {string|null}
 */
export function normalizeLang(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  const low = v.normalize('NFC').toLowerCase();
  if (LANG_NAMES.has(low)) return LANG_NAMES.get(low);
  const m = /^([a-z]{2,3})((?:[-_][a-z0-9]{2,8})*)$/i.exec(v);
  if (!m) return null;
  const primary = m[1].toLowerCase();
  const p2 = primary.length === 3 ? LANG_NAMES.get(primary) ?? primary : primary;
  return p2 + m[2].replace(/_/g, '-');
}

// ── transforms ──────────────────────────────────────────────────────────────────────────────────────

const unescapeDelim = (s) => String(s).replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\f/g, '\f');

/**
 * Normalize one transform to `{op, arg}`. Accepts 'trim', 'lower', 'zero_is_unknown', 'date', 'split(;)',
 * 'join(\f)', {split: ';'}, {join: '; '}, {date: {…}}, {map: {…}}, {regex_extract: {pattern, group}} (or
 * [pattern, group], or a pattern string).
 * @param {unknown} t
 * @returns {{op: string, arg: unknown}}
 * @throws {TypeError} for anything else
 */
export function normalizeTransform(t) {
  if (typeof t === 'string') {
    const m = /^([a-z_]+)(?:\((.*)\))?$/s.exec(t.trim());
    if (!m || !TRANSFORMS.includes(m[1])) throw new TypeError(`Unknown transform '${t}'.`);
    const [, op, arg] = m;
    if (op === 'split' || op === 'join') return { op, arg: unescapeDelim(arg ?? (op === 'split' ? ';' : '; ')) };
    if (op === 'date') return { op, arg: {} };
    if (op === 'map' || op === 'regex_extract') throw new TypeError(`Transform '${op}' needs an object form, e.g. {"${op}": …}.`);
    return { op, arg: null };
  }
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new TypeError(`A transform is a name or a one-key object (got ${JSON.stringify(t)}).`);
  const keys = Object.keys(t);
  if (keys.length !== 1 || !TRANSFORMS.includes(keys[0])) throw new TypeError(`Unknown transform ${JSON.stringify(t)}.`);
  const op = keys[0], arg = t[op];
  switch (op) {
    case 'split': case 'join':
      if (typeof arg !== 'string' || arg === '') throw new TypeError(`${op} needs a delimiter string.`);
      return { op, arg: unescapeDelim(arg) };
    case 'date': {
      const a = arg ?? {};
      if (typeof a !== 'object' || Array.isArray(a)) throw new TypeError('date options must be an object.');
      for (const k of Object.keys(a)) if (!(k in DATE_OPTION_KEYS)) throw new TypeError(`Unknown date option '${k}' (use ${Object.keys(DATE_OPTION_KEYS).join(', ')}).`);
      if (a.circa_radius !== undefined && !(Number.isInteger(a.circa_radius) && a.circa_radius >= 0 && a.circa_radius <= 100)) throw new TypeError('circa_radius must be a whole number of years (0–100).');
      if (a.open_range_years !== undefined && !(Number.isInteger(a.open_range_years) && a.open_range_years >= 1 && a.open_range_years <= 1000)) throw new TypeError('open_range_years must be 1–1000.');
      if (a.two_digit_century !== undefined && a.two_digit_century !== null && !(Number.isInteger(a.two_digit_century) && [17, 18, 19, 20, 1700, 1800, 1900, 2000].includes(a.two_digit_century))) {
        throw new TypeError("two_digit_century must be null, 18, 19 or 20 (for 18xx, 19xx, 20xx).");
      }
      if (a.negative_year_convention !== undefined && !['historical', 'astronomical'].includes(a.negative_year_convention)) throw new TypeError("negative_year_convention is 'historical' or 'astronomical'.");
      return { op, arg: a };
    }
    case 'map':
      if (!arg || typeof arg !== 'object' || Array.isArray(arg)) throw new TypeError('map needs an object of value → replacement.');
      return { op, arg };
    case 'regex_extract': {
      const spec = typeof arg === 'string' ? { pattern: arg } : Array.isArray(arg) ? { pattern: arg[0], group: arg[1] } : arg;
      if (!spec || typeof spec.pattern !== 'string') throw new TypeError('regex_extract needs a pattern.');
      let re;
      try { re = new RegExp(spec.pattern, 'u'); } catch (err) { throw new TypeError(`regex_extract pattern is not valid: ${err.message}`); }
      const group = spec.group ?? (/\((?!\?)/.test(spec.pattern) ? 1 : 0);
      if (!(Number.isInteger(group) && group >= 0) && typeof group !== 'string') throw new TypeError('regex_extract group must be a number or a group name.');
      return { op, arg: { pattern: spec.pattern, group, re } };
    }
    default: return { op, arg };
  }
}

/** Short text of a transform list for summaries: 'trim, date(circa_radius=5)'. */
export function describeTransforms(list) {
  return (list ?? []).map((t) => {
    const { op, arg } = typeof t === 'object' && t && 'op' in t ? t : normalizeTransform(t);
    if (op === 'split' || op === 'join') return `${op}(${JSON.stringify(arg).slice(1, -1)})`;
    if (op === 'date') {
      const parts = Object.entries(arg ?? {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${v}`);
      return `date(${parts.join(', ')})`;
    }
    if (op === 'map') return `map(${Object.keys(arg).length} values)`;
    if (op === 'regex_extract') return `regex_extract(/${arg.pattern}/, ${arg.group})`;
    return op;
  }).join(', ') || null;
}

/** Apply the value transforms (date options are collected, not applied). */
function runTransforms(value, list, dateOpts) {
  let v = value;
  for (const { op, arg } of list) {
    switch (op) {
      case 'trim': v = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : x)) : typeof v === 'string' ? v.trim() : v; break;
      case 'lower': v = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.toLowerCase() : x)) : typeof v === 'string' ? v.toLowerCase() : v; break;
      case 'split': if (typeof v === 'string') v = v.split(arg).map((x) => x.trim()).filter((x) => x !== ''); break;
      case 'join': if (Array.isArray(v)) v = v.filter((x) => x !== null && x !== undefined).map(String).join(arg); break;
      case 'map': {
        const lookup = (x) => {
          if (typeof x !== 'string' && typeof x !== 'number') return x;
          const s = String(x);
          if (Object.prototype.hasOwnProperty.call(arg, s)) return arg[s];
          const key = Object.keys(arg).find((k) => k.trim().toLowerCase() === s.trim().toLowerCase());
          return key === undefined ? x : arg[key];
        };
        v = Array.isArray(v) ? v.map(lookup) : lookup(v);
        break;
      }
      case 'regex_extract': {
        const one = (x) => {
          if (typeof x !== 'string') return x;
          const m = arg.re.exec(x);
          if (!m) return null;
          return (typeof arg.group === 'string' ? m.groups?.[arg.group] : m[arg.group]) ?? null;
        };
        v = Array.isArray(v) ? v.map(one).filter((x) => x !== null) : one(v);
        break;
      }
      case 'zero_is_unknown':
        dateOpts.zeroIsUnknown = true;
        if (v === 0 || (typeof v === 'string' && /^0+$/.test(v.trim()))) v = dateOpts.isDate ? v : null;
        break;
      case 'date':
        for (const [k, x] of Object.entries(arg ?? {})) if (x !== undefined) dateOpts[DATE_OPTION_KEYS[k]] = x;
        break;
      default: break;
    }
  }
  return v;
}

// ── normalization ───────────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a mapping: defaults filled, transforms parsed. `errors` lists what makes it unusable
 * (unknown target, bad transform, a field with neither from nor const).
 * @param {object} raw
 * @returns {{mapping: object, errors: Array<{target: string|null, message: string, hint: string}>}}
 */
export function normalizeMapping(raw) {
  const errors = [];
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (m !== raw) errors.push({ target: null, message: 'The mapping must be an object.', hint: 'Send {"mapping": {"fields": {…}}}.' });
  const options = { dedupe: 'flag', detect_language: true, on_bad_row: 'skip_and_report', line_mode: false, ...(m.options ?? {}) };
  if (!['flag', 'skip', 'off'].includes(options.dedupe)) errors.push({ target: null, message: `options.dedupe '${options.dedupe}' is not flag, skip or off.`, hint: "Use 'flag' (keep duplicates, excluded from counts by default)." });
  if (!['skip_and_report', 'abort'].includes(options.on_bad_row)) errors.push({ target: null, message: `options.on_bad_row '${options.on_bad_row}' is not skip_and_report or abort.`, hint: "Use 'skip_and_report'." });
  const fields = {};
  const rawFields = m.fields && typeof m.fields === 'object' && !Array.isArray(m.fields) ? m.fields : {};
  for (const [target, spec] of Object.entries(rawFields)) {
    if (!(target in TARGETS) && !/^meta\.[\p{L}\p{N}_ .-]{1,64}$/u.test(target)) {
      errors.push({ target, message: `'${target}' is not a target field.`, hint: `Targets: ${TARGET_ORDER.join(', ')}, or meta.<name>.` });
      continue;
    }
    if (spec === null || spec === undefined) continue;
    if (typeof spec !== 'object' || Array.isArray(spec)) {
      errors.push({ target, message: `Target '${target}' must be {"from": …} or {"const": …}.`, hint: 'Pick a column, or type a constant.' });
      continue;
    }
    const hasFrom = spec.from !== undefined && spec.from !== null && spec.from !== '';
    const hasConst = spec.const !== undefined;
    if (hasFrom === hasConst) {
      if (!hasFrom && !hasConst) continue; // "not mapped"
      errors.push({ target, message: `Target '${target}' has both a column and a constant.`, hint: 'Keep one of them.' });
      continue;
    }
    const list = [];
    for (const t of Array.isArray(spec.transform) ? spec.transform : spec.transform ? [spec.transform] : []) {
      try {
        const n = normalizeTransform(t);
        if ((n.op === 'date' || n.op === 'zero_is_unknown') && !DATE_TARGETS.has(target) && n.op === 'date') {
          throw new TypeError(`date() only applies to ${[...DATE_TARGETS].join(', ')}.`);
        }
        list.push(n);
      } catch (err) {
        errors.push({ target, message: `Target '${target}': ${err.message}`, hint: `Transforms: ${TRANSFORMS.join(', ')}.` });
      }
    }
    fields[target] = { ...spec, transformList: list };
  }
  const collection = m.collection && typeof m.collection === 'object' ? { ...m.collection } : null;
  return { mapping: { ...m, options, fields, collection }, errors };
}

/** Value of `from` in a record: a key, a 1-based column number, or a JSON Pointer inside the record. */
export function sourceValue(data, from) {
  if (!data) return undefined;
  if (typeof from === 'number') return Object.values(data)[from - 1];
  if (Object.prototype.hasOwnProperty.call(data, from)) return data[from];
  if (typeof from === 'string' && from.startsWith('/')) return getPointer(data, from);
  return undefined;
}

// ── per-record mapping ──────────────────────────────────────────────────────────────────────────────

const kindOf = (v) => (v === null ? 'empty' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object'
  : typeof v === 'number' ? 'a number' : typeof v === 'boolean' ? 'true/false' : 'text');
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** Unparsed date: kept with its raw value, undated (rule 'unparsed'). */
function unparsed(raw) {
  return { lo_day: null, hi_day: null, lo_year: null, hi_year: null, precision: 'unknown', basis: 'unknown', approx: 0,
    rule: 'unparsed', raw, label: 'undated', warnings: [] };
}

function rowRef(line) {
  return line === null || line === undefined ? 'The record' : `Row ${line}`;
}

/**
 * Parse one date value with the mapping's options; issues use the row number and column name.
 * @returns {{parsed: object|null, issues: object[]}}
 */
export function parseDateValue(raw, opts, { line = null, column = null, label = 'date', now = new Date() } = {}) {
  const issues = [];
  const s = String(raw).trim();
  if (!s) return { parsed: null, issues };
  const r = parseDate(s, { ...opts, now });
  const who = `${rowRef(line)} ${label}`;
  const base = { line, col: null, field: column, value_excerpt: s.slice(0, 200) };
  if (r.issue) {
    const readings = (r.issue.suggestions ?? []).map((x) => {
      const p = parseDate(String(x), { ...opts, now });
      return p.issue || !p.label || p.label === String(x) ? `'${x}'` : `'${x}' (${p.label})`;
    });
    const code = r.issue.code;
    let message, suggestion;
    if (code === 'E_DATE_INVALID') {
      message = `${who} ${s} does not exist; row imported as undated.`;
      suggestion = readings.length ? `Try ${readings.join(' or ')}.` : 'Check the day and the month (and that a range does not end before it starts).';
    } else if (code === 'E_DATE_AMBIGUOUS') {
      const prefix = `'${s}': `;
      const detail = r.issue.message.startsWith(prefix) ? r.issue.message.slice(prefix.length) : r.issue.message;
      message = `${who} '${s}': ${detail.replace(/\.$/, '')}. Row imported as undated.`;
      suggestion = /two-digit/.test(r.issue.message) ? "Set 'two-digit years → 19xx' (or 18xx/20xx) in the date options, or write the full decade such as 1990s."
        : readings.length ? `Write it unambiguously, for example ${readings.join(' or ')}.` : 'Write the date unambiguously (YYYY-MM-DD).';
    } else {
      message = `${who} '${s}' was not recognised; row imported as undated.`;
      suggestion = readings.length ? `Try ${readings.join(' or ')}.` : 'Write the date as YYYY, YYYY-MM-DD, "c. YYYY" or a range such as 1850–1855.';
    }
    issues.push({ code, severity: 'warning', ...base, message, suggestion });
    return { parsed: { ...unparsed(s), note: `${code}: ${r.issue.message}` }, issues };
  }
  for (const w of r.warnings ?? []) {
    if (w === 'W_DATE_FUTURE') {
      issues.push({ code: w, severity: 'info', ...base, message: `${who} '${s}' is after the import time; shown on the Scheduled shelf.`,
        suggestion: 'If this is a plan or an announcement, nothing to do; otherwise correct the date.' });
    } else if (w === 'W_AMBIGUOUS_HUNDREDS') {
      issues.push({ code: w, severity: 'warning', ...base, message: `${who} '${s}' was read as the whole century ${r.label}.`,
        suggestion: `Write ${r.lo_year}–${r.lo_year + 9} if the decade was meant.` });
    } else if (w === 'W_DATE_SEASON') {
      issues.push({ code: w, severity: 'info', ...base, message: `${who} '${s}' was read as ${r.label} (northern-hemisphere season).`,
        suggestion: 'Give the month if it is known.' });
    } else {
      issues.push({ code: w, severity: 'info', ...base, message: `${who} '${s}': ${w}.`, suggestion: 'See the date grammar in Docs/IMPORT-SCHEMA.md.' });
    }
  }
  return { parsed: { ...r, warnings: [] }, issues };
}

const BASIS_RANK = { stated: 0, estimated: 1, derived: 2, period: 3, announced: 4, unknown: 5 };
const worseBasis = (a, b) => (BASIS_RANK[a] >= BASIS_RANK[b] ? a : b);

/** Combine a start and an end date into one interval (date + date_end). */
function combineDates(a, b, raw, now) {
  const yearish = (p) => ['year', 'decade', 'century', 'millennium'].includes(p.precision);
  let basis = worseBasis(a.basis === 'announced' ? 'stated' : a.basis, b.basis === 'announced' ? 'stated' : b.basis);
  const approx = a.approx || b.approx ? 1 : 0;
  let p = yearish(a) && yearish(b)
    ? fromInterval(a.lo_year, b.hi_year, { basis, rule: 'range', raw, approx })
    : fromDayInterval(a.lo_day, b.hi_day, { precision: a.lo_day === b.hi_day ? 'day' : 'range', basis, rule: 'range', raw, approx });
  if (p.lo_day > todayDay(now)) {
    basis = 'announced';
    p = { ...p, basis, rule: 'range+future' };
  }
  return { ...p, warnings: [] };
}

/** Widen a parsed date to a stated precision; never narrows it (that would invent precision). */
function widenTo(p, want) {
  if (!p || p.lo_day === null) return { parsed: p, ok: true };
  const w = String(want ?? '').trim().toLowerCase();
  if (!PRECISION_ORDER.includes(w)) return { parsed: p, ok: false, reason: `'${want}' is not one of ${PRECISION_ORDER.join(', ')}` };
  const lo = p.lo_year, hi = p.hi_year;
  let out;
  if (w === 'day') return p.lo_day === p.hi_day ? { parsed: p, ok: true } : { parsed: p, ok: false, reason: `the date spans ${p.label}` };
  if (w === 'month') {
    const a = ymdFromDay(p.lo_day);
    const first = dayFromYMD(a.y, a.m, 1), last = dayFromYMD(a.y, a.m, daysInMonth(a.y, a.m));
    if (p.hi_day > last) return { parsed: p, ok: false, reason: `the date spans ${p.label}` };
    out = fromDayInterval(first, last, { precision: 'month', basis: p.basis, rule: `${p.rule}+precision`, raw: p.raw, approx: p.approx });
  } else {
    const width = { year: 1, decade: 10, century: 100, millennium: 1000 }[w];
    const b0 = Math.floor(lo / width) * width;
    if (hi > b0 + width - 1) return { parsed: p, ok: false, reason: `the date spans ${p.label}` };
    out = fromInterval(b0, b0 + width - 1, { precision: w, basis: p.basis, rule: `${p.rule}+precision`, raw: p.raw, approx: p.approx });
  }
  return { parsed: { ...out, warnings: [] }, ok: true };
}

/**
 * Map one source record to a CanonicalDocument.
 * @param {{line: number|null, ordinal: number, data: object, document?: object}} record a RawRecord
 * @param {object} mapping a normalized mapping (normalizeMapping().mapping)
 * @param {{fileName: string, sha256: string, decoder: string, batchId: number|null, format: string,
 *   byteRange?: {start: number, end: number}|null, now?: Date, defaultKind?: string}} ctx
 * @returns {{doc: object|null, rels: object[], issues: object[], reject: object|null,
 *   stats?: {date: 'parsed'|'unparsed'|null, referenced_date: 'parsed'|'unparsed'|null}}}
 */
export function applyMapping(record, mapping, ctx) {
  const issues = [];
  const rels = [];
  const line = record.line ?? null;
  const now = ctx.now ?? new Date();
  const data = record.data ?? {};
  const F = mapping.fields;
  const columnOf = (t) => (F[t] && F[t].from !== undefined ? String(F[t].from) : null);
  const dateOpts = {};
  const dateOptsByTarget = {};

  const value = (target) => {
    const spec = F[target];
    if (!spec) return undefined;
    const raw = spec.const !== undefined ? spec.const : sourceValue(data, spec.from);
    const opts = { isDate: DATE_TARGETS.has(target) };
    const v = runTransforms(raw, spec.transformList ?? [], opts);
    delete opts.isDate;
    dateOptsByTarget[target] = opts;
    return v;
  };
  const typeIssue = (target, v, expected) => issues.push({ code: 'E_FIELD_TYPE', severity: 'warning', line, col: null,
    field: columnOf(target) ?? target, value_excerpt: JSON.stringify(v)?.slice(0, 200) ?? null,
    message: `${rowRef(line)} '${columnOf(target) ?? target}' is ${kindOf(v)}; expected ${expected}. The field was ignored.`,
    suggestion: target === 'cites' ? 'Give the cited ids as a list, or as text separated by ";".'
      : `Map '${target}' to a column that holds ${expected}, or add a transform (join, split, regex_extract).` });

  const str = (target, { max = MAX_STRING } = {}) => {
    const v = value(target);
    if (isBlank(v)) return null;
    if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) {
      const s = v.filter((x) => !isBlank(x)).map(String).join('; ');
      return s || null;
    }
    typeIssue(target, v, 'text');
    return null;
  };
  const list = (target) => {
    const v = value(target);
    if (isBlank(v)) return [];
    const hasSplit = (F[target]?.transformList ?? []).some((t) => t.op === 'split' || t.op === 'join');
    if (typeof v === 'string') return (hasSplit ? [v] : v.split(/[;|]/)).map((x) => x.trim()).filter(Boolean);
    if (typeof v === 'number') return [String(v)];
    if (Array.isArray(v) && v.every((x) => x === null || typeof x === 'string' || typeof x === 'number')) {
      return v.filter((x) => !isBlank(x)).map((x) => String(x).trim());
    }
    typeIssue(target, v, target === 'cites' ? 'a list of ids' : 'a list of values');
    return [];
  };

  // ext_id
  let extId = str('ext_id', { max: 100000 });
  if (extId !== null) extId = extId.trim();
  if (extId !== null && extId.length > MAX_ID) {
    issues.push({ code: 'E_FIELD_TYPE', severity: 'warning', line, col: null, field: columnOf('ext_id'), value_excerpt: extId.slice(0, 200),
      message: `${rowRef(line)} id is ${extId.length} characters long (limit ${MAX_ID}); a generated id was used.`,
      suggestion: 'Map a shorter, unique id column.' });
    extId = null;
  }
  const generatedId = ctx.format === 'txt' || ctx.format === 'md'
    ? `${slugify(fileStem(ctx.fileName), 40)}-${String(ctx.sha256).slice(0, 8)}`
    : `${String(ctx.sha256).slice(0, 8)}#${record.ordinal}`;
  if (extId === null) {
    if (F.ext_id) {
      issues.push({ code: 'E_FIELD_TYPE', severity: 'warning', line, col: null, field: columnOf('ext_id'), value_excerpt: null,
        message: `${rowRef(line)} has no id; it was given the id '${generatedId}'.`,
        suggestion: 'Give every row an id if other rows cite it.' });
    }
    extId = generatedId;
  }

  // plain metadata
  const doc = { ext_id: extId, kind: (str('kind', { max: 40 }) ?? ctx.defaultKind ?? 'document').trim().toLowerCase() || 'document', dates: [] };
  for (const t of ['title', 'author', 'genre', 'community', 'culture', 'field', 'source_url', 'license']) {
    const v = str(t);
    if (v !== null) doc[t] = v;
  }

  // language
  const langRaw = str('language', { max: 64 });
  if (langRaw !== null) {
    const code = normalizeLang(langRaw);
    if (code) doc.lang_declared = code;
    else {
      issues.push({ code: 'E_FIELD_TYPE', severity: 'warning', line, col: null, field: columnOf('language'), value_excerpt: langRaw,
        message: `${rowRef(line)} language '${langRaw}' is not a language name or code; the language will be detected from the text.`,
        suggestion: `Use a code such as en, fr, es, hi or gu, or add a map transform ({"${langRaw}": "…"}).` });
    }
  }

  // text
  let textSpec = null;
  if (F.text) {
    const raw = F.text.const !== undefined ? F.text.const : sourceValue(data, F.text.from);
    const fromBody = record.document && F.text.from === 'text' && (F.text.transformList ?? []).length === 0;
    if (fromBody) {
      const d = record.document;
      const body = d.original.slice(d.body_start, d.body_end);
      if (/[\p{L}\p{N}\p{So}]/u.test(body)) {
        textSpec = { original: d.original, decoder: ctx.decoder, body_start: d.body_start, body_end: d.body_end,
          mode: mapping.options.line_mode ? 'verse' : d.mode ?? 'auto' };
        if (d.regions?.length) textSpec.regions = d.regions;
      }
    } else {
      const joinT = (F.text.transformList ?? []).find((t) => t.op === 'join');
      let v = runTransforms(raw, F.text.transformList ?? [], {});
      let decoder = ctx.decoder;
      if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) v = v.map(String).join('\n\n');
      if (joinT && joinT.arg === '\f') decoder = 'pages-joined-ff';
      if (typeof v === 'number') v = String(v);
      if (typeof v === 'string') {
        if (/[\p{L}\p{N}\p{So}]/u.test(v)) textSpec = { original: v, decoder, mode: mapping.options.line_mode ? 'verse' : 'auto' };
      } else if (!isBlank(v)) typeIssue('text', v, 'text');
    }
  }
  if (textSpec) {
    const chars = textSpec.original.length;
    const bytes = chars * 3 > MAX_FIELD_BYTES ? utf8Length(textSpec.original) : chars;
    if (bytes > MAX_FIELD_BYTES) {
      const mb = (bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1);
      return { doc: null, extId, rels, issues, reject: { code: 'E_ROW_TOO_LARGE', severity: 'rejected', line, col: null,
        field: columnOf('text') ?? 'text', value_excerpt: textSpec.original.slice(0, 120),
        message: `${rowRef(line)} text is ${mb} MB (limit 20 MB).`,
        suggestion: 'Split the text into parts under 20 MB (for example one row per chapter), or import the parts as separate TXT files.' } };
    }
    doc.text = textSpec;
  }

  // dates
  const ctxDate = (target, label) => ({ line, column: columnOf(target) ?? target, label, now });
  const dateRaw = (t) => {
    const v = value(t);
    if (isBlank(v)) return null;
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    typeIssue(t, v, 'a date');
    return null;
  };
  const optsFor = (t) => ({ ...dateOpts, ...dateOptsByTarget[t] });
  const rawDate = F.date ? dateRaw('date') : null;
  const rawEnd = F.date_end ? dateRaw('date_end') : null;
  let chrono = null;
  if (rawDate !== null) {
    const a = parseDateValue(rawDate, optsFor('date'), ctxDate('date', 'date'));
    issues.push(...a.issues);
    chrono = { parsed: a.parsed, raw: rawDate, note: a.parsed?.note ?? null };
    if (rawEnd !== null && a.parsed && a.parsed.lo_day !== null) {
      const b = parseDateValue(rawEnd, optsFor('date_end'), ctxDate('date_end', 'end date'));
      issues.push(...b.issues.filter((i) => i.code !== 'W_DATE_FUTURE'));
      if (b.parsed && b.parsed.lo_day !== null) {
        const raw = `${rawDate} – ${rawEnd}`;
        if (b.parsed.hi_day < a.parsed.lo_day) {
          issues.push({ code: 'E_DATE_INVALID', severity: 'warning', line, col: null, field: columnOf('date_end'), value_excerpt: raw,
            message: `${rowRef(line)} date range ${raw} ends before it starts; row imported as undated.`,
            suggestion: 'Swap the start and end dates, or correct the one that is wrong.' });
          chrono = { parsed: { ...unparsed(raw), note: 'E_DATE_INVALID: the range ends before it starts' }, raw, note: 'E_DATE_INVALID: the range ends before it starts' };
        } else {
          chrono = { parsed: combineDates(a.parsed, b.parsed, raw, now), raw, note: null };
          if (chrono.parsed.basis === 'announced' && !issues.some((i) => i.code === 'W_DATE_FUTURE')) {
            issues.push({ code: 'W_DATE_FUTURE', severity: 'info', line, col: null, field: columnOf('date'), value_excerpt: raw,
              message: `${rowRef(line)} date '${raw}' is after the import time; shown on the Scheduled shelf.`,
              suggestion: 'If this is a plan or an announcement, nothing to do; otherwise correct the date.' });
          }
        }
      }
    }
  } else if (rawEnd !== null) {
    issues.push({ code: 'E_DATE_UNPARSEABLE', severity: 'warning', line, col: null, field: columnOf('date_end'), value_excerpt: rawEnd,
      message: `${rowRef(line)} has an end date but no start date; row imported as undated.`,
      suggestion: 'Map the start date too, or map this column as the date.' });
  }
  if (chrono && chrono.parsed && chrono.parsed.lo_day !== null && F.date_precision) {
    const want = str('date_precision', { max: 32 });
    if (want !== null) {
      const w = widenTo(chrono.parsed, want);
      if (w.ok) chrono.parsed = w.parsed;
      else {
        issues.push({ code: 'E_FIELD_TYPE', severity: 'warning', line, col: null, field: columnOf('date_precision'), value_excerpt: want,
          message: `${rowRef(line)} precision '${want}' was not applied: ${w.reason}.`,
          suggestion: `A precision override can only widen a date (to ${PRECISION_ORDER.join(', ')}); it never narrows one.` });
      }
    }
  }
  const stats = { date: chrono ? (chrono.parsed && chrono.parsed.lo_day !== null ? 'parsed' : 'unparsed') : null, referenced_date: null };
  if (chrono) {
    doc.dates.push({ role: 'publication', raw: chrono.raw, parsed: stripNote(chrono.parsed), asserted_by: `import:${ctx.batchId ?? 'dry-run'}`,
      is_chronology: true, ...(chrono.note ? { note: chrono.note } : {}) });
  }
  if (F.referenced_date) {
    const r = dateRaw('referenced_date');
    if (r !== null) {
      const p = parseDateValue(r, optsFor('referenced_date'), ctxDate('referenced_date', 'referenced date'));
      issues.push(...p.issues.filter((i) => i.code !== 'W_DATE_FUTURE'));
      stats.referenced_date = p.parsed && p.parsed.lo_day !== null ? 'parsed' : 'unparsed';
      doc.dates.push({ role: 'referenced', raw: r, parsed: stripNote(p.parsed), asserted_by: `import:${ctx.batchId ?? 'dry-run'}`,
        is_chronology: false, note: p.parsed?.note ?? 'what the text is about, not when it was written' });
    }
  }

  // tags, citations, relations
  const tags = [...new Set(list('tags').map((t) => t.slice(0, 200)))];
  if (tags.length) doc.tags = tags.map((value) => ({ scheme: 'keyword', value, provenance: 'documented_category', method: `import:${ctx.fileName}` }));
  const locator = `sha256:${ctx.sha256}#line=${line ?? record.ordinal}`;
  for (const target of new Set(list('cites'))) {
    if (target === extId) {
      issues.push({ code: 'E_FIELD_TYPE', severity: 'warning', line, col: null, field: columnOf('cites'), value_excerpt: target,
        message: `${rowRef(line)} cites its own id '${target}'; that citation was ignored.`, suggestion: 'Check the id in the cites column.' });
      continue;
    }
    rels.push(statedRelationship('explicit_citation', extId, target, 'documented', ctx, locator));
  }
  if (F.relations) for (const r of relationsOf(value('relations'), line, columnOf('relations'), issues)) {
    if (r.target === extId) continue;
    rels.push(statedRelationship(r.type, extId, r.target, r.evidence, ctx, locator, r.collection));
  }

  // original_meta: the verbatim record (bulk text replaced by a pointer) + mapped meta.* + notes
  const recordCopy = { ...data };
  if (F.text && F.text.from !== undefined && typeof recordCopy[F.text.from] === 'string' && doc.text) {
    recordCopy[F.text.from] = { $text: 'document text', chars: recordCopy[F.text.from].length };
  }
  const meta = { file: ctx.fileName, line, record: recordCopy };
  if (record.header?.kind) meta.header_kind = record.header.kind;
  const notes = str('notes', { max: 100000 });
  if (notes !== null) meta.notes = notes;
  const metaTargets = Object.keys(F).filter((t) => t.startsWith('meta.'));
  if (metaTargets.length) meta.mapped = Object.fromEntries(metaTargets.map((t) => [t.slice(5), value(t) ?? null]));
  if (F.collection) {
    const c = str('collection');
    if (c !== null) meta.collection_value = c;
  }
  doc.original_meta = meta;
  if (ctx.byteRange) doc.source_file = { sha256: ctx.sha256, byte_start: ctx.byteRange.start, byte_end: ctx.byteRange.end };

  if (!doc.text && !doc.title) {
    return { doc: null, extId, rels: [], issues, stats, reject: { code: 'E_MISSING_TEXT', severity: 'rejected', line, col: null, field: columnOf('text'),
      value_excerpt: extId, message: `${rowRef(line)} has no text and no title.`,
      suggestion: F.text ? 'Map a title as well (rows without text are kept as metadata with their title), or fill in the text.'
        : 'Map a text column or a title, or allow metadata-only rows by mapping a title.' } };
  }
  return { doc, extId, rels, issues, stats, reject: null };
}

function stripNote(p) {
  if (!p) return p;
  const { note, ...rest } = p;
  return rest;
}

/** A relationship stated by the file: documented (with a locator into the stored original) or proposed. */
function statedRelationship(relType, srcExt, dstExt, evidence, ctx, locator, collection = null) {
  const dst = collection ? { collection, ext_id: dstExt } : { ext_id: dstExt };
  if (evidence === 'documented') {
    return { src: { ext_id: srcExt }, dst, rel_type: relType, evidence_status: 'documented', origin: 'source_dataset',
      source_dataset: `your import: ${ctx.fileName}`, source_locator: locator, provenance_quality: 'complete',
      created_by: `import:${ctx.batchId ?? 'dry-run'}`, provenance_note: 'as stated in your file' };
  }
  return { src: { ext_id: srcExt }, dst, rel_type: relType, evidence_status: 'proposed', origin: 'human',
    created_by: `human:import of ${ctx.fileName}`, provenance_note: `proposed in your file (${locator})` };
}

/**
 * Relations of a record: a list of {type, target|target_ext_id, evidence?, collection?} objects, or text
 * "type:target[:evidence]" items separated by ';'. Unknown types are reported and skipped.
 */
export function relationsOf(v, line, column, issues) {
  if (isBlank(v)) return [];
  let items = [];
  if (typeof v === 'string') {
    items = v.split(/[;|]/).map((x) => x.trim()).filter(Boolean).map((s) => {
      const parts = s.split(':');
      const last = parts[parts.length - 1].trim().toLowerCase();
      const evidence = parts.length >= 3 && ['documented', 'proposed'].includes(last) ? parts.pop().trim().toLowerCase() : undefined;
      const type = parts.shift().trim();
      return { type, target: parts.join(':').trim(), evidence };
    });
  } else if (Array.isArray(v)) {
    items = v.map((x) => (x && typeof x === 'object' ? { type: x.type ?? x.rel_type, target: x.target_ext_id ?? x.target ?? x.ext_id,
      evidence: x.evidence ?? x.evidence_status, collection: x.collection ?? null } : { bad: x }));
  } else if (typeof v === 'object') {
    items = [{ type: v.type ?? v.rel_type, target: v.target_ext_id ?? v.target, evidence: v.evidence, collection: v.collection ?? null }];
  }
  const out = [];
  for (const it of items) {
    const where = { line, col: null, field: column };
    if (it.bad !== undefined || !it.type || it.target === undefined || it.target === null || String(it.target).trim() === '') {
      issues.push({ code: 'E_FIELD_TYPE', severity: 'warning', ...where, value_excerpt: JSON.stringify(it.bad ?? it).slice(0, 200),
        message: `${rowRef(line)} has a relation without a type or a target; it was ignored.`,
        suggestion: 'Write relations as {"type": "samples", "target": "<id>"} or as "samples:<id>" separated by ";".' });
      continue;
    }
    const type = String(it.type).trim().toLowerCase().replace(/[\s-]+/g, '_');
    const rt = REL_TYPE_BY_CODE[type];
    if (!rt) {
      issues.push({ code: 'E_FIELD_TYPE', severity: 'warning', ...where, value_excerpt: String(it.type).slice(0, 200),
        message: `${rowRef(line)} relation type '${it.type}' is not known; that relation was ignored.`,
        suggestion: `Use one of: ${Object.keys(REL_TYPE_BY_CODE).filter((c) => !PROPOSED_ONLY_FAMILIES.has(REL_TYPE_BY_CODE[c].family)).join(', ')}.` });
      continue;
    }
    let evidence = it.evidence === undefined || it.evidence === null || it.evidence === '' ? 'documented' : String(it.evidence).toLowerCase();
    if (!['documented', 'proposed'].includes(evidence)) {
      issues.push({ code: 'E_FIELD_TYPE', severity: 'warning', ...where, value_excerpt: String(it.evidence),
        message: `${rowRef(line)} relation evidence '${it.evidence}' is not 'documented' or 'proposed'; it was read as proposed.`,
        suggestion: "A file can state a link (documented) or suggest one (proposed); 'computed' links come only from Scrolls' own analysis runs." });
      evidence = 'proposed';
    }
    if (evidence === 'documented' && PROPOSED_ONLY_FAMILIES.has(rt.family)) {
      issues.push({ code: 'E_FIELD_TYPE', severity: 'info', ...where, value_excerpt: type,
        message: `${rowRef(line)} relation '${type}' is a similarity type; it was recorded as proposed, not documented.`,
        suggestion: 'Similarity never establishes a documented link; state the documented relation (cites, samples, adaptation_of, …) if your source records one.' });
      evidence = 'proposed';
    }
    out.push({ type, target: String(it.target).trim(), evidence, collection: it.collection ? String(it.collection) : null });
  }
  return out;
}
