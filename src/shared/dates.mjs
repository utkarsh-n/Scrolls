// OWNER: WP0 — date grammar and day arithmetic shared by server and browser (SPEC §5.3, D5, §13 rule 18)
//
// Time is an integer number of days since 1970-01-01, proleptic Gregorian, astronomical years (1 BCE = 0).
// Intervals are inclusive [lo_day, hi_day]. Date.UTC is never used: it maps years 0–99 to 1900–1999.

const DAY_MS = 86400000;
const MONTH_ABBR = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
export { MONTH_ABBR };

/**
 * Days since 1970-01-01 for a proleptic-Gregorian astronomical date. Uses setUTCFullYear (never Date.UTC).
 * @param {number} y astronomical year (1 BCE = 0)
 * @param {number} [m=1] month 1–12 (out-of-range values roll over, as Date does)
 * @param {number} [d=1] day of month
 * @returns {number}
 */
export function dayFromYMD(y, m = 1, d = 1) {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.floor(t.getTime() / DAY_MS);
}

/**
 * Inverse of dayFromYMD.
 * @param {number} day days since 1970-01-01
 * @returns {{y:number, m:number, d:number}}
 */
export function ymdFromDay(day) {
  const t = new Date(day * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** @param {number} y astronomical year @returns {boolean} */
export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** @param {number} y @param {number} m 1–12 @returns {number} */
export function daysInMonth(y, m) {
  return dayFromYMD(y, m + 1, 1) - dayFromYMD(y, m, 1);
}

/** The UTC day number of a JS Date (default: now). @param {Date} [now] @returns {number} */
export function todayDay(now = new Date()) {
  return Math.floor(now.getTime() / DAY_MS);
}

// ── Bins and tiers (§1.6, §3 doc_bin) ───────────────────────────────────────────────────────────────

/** Calendar bin levels. Levels 0–3 bin by year; 4 (month) and 5 (day) bin by day number. */
export const LEVELS = Object.freeze([
  Object.freeze({ level: 0, name: 'millennium', width: 1000 }),
  Object.freeze({ level: 1, name: 'century', width: 100 }),
  Object.freeze({ level: 2, name: 'decade', width: 10 }),
  Object.freeze({ level: 3, name: 'year', width: 1 }),
  Object.freeze({ level: 4, name: 'month' }),
  Object.freeze({ level: 5, name: 'day' }),
]);

function widthOf(level) {
  const w = LEVELS[level]?.width;
  if (!w) throw new RangeError(`level ${level} has no year width; months and days bin by day number (fitsDays)`);
  return w;
}

/**
 * Bin index of a year at a year-based level: Math.floor(year / width).
 * @param {number} year astronomical year
 * @param {0|1|2|3} level
 * @returns {number}
 */
export function binOf(year, level) {
  return Math.floor(year / widthOf(level));
}

/**
 * Whether the interval [yLo, yHi] fits inside ONE bin of a year-based level (fit-or-wash, D2).
 * @param {number} yLo @param {number} yHi @param {0|1|2|3} level
 * @returns {boolean}
 */
export function fits(yLo, yHi, level) {
  const w = widthOf(level);
  return Math.floor(yLo / w) === Math.floor(yHi / w);
}

/**
 * Month/day counterpart of `fits`: level 4 = same calendar month, level 5 = same day.
 * @param {number} loDay @param {number} hiDay @param {4|5} level
 * @returns {boolean}
 */
export function fitsDays(loDay, hiDay, level) {
  if (level === 5) return loDay === hiDay;
  if (level !== 4) throw new RangeError('fitsDays takes level 4 (month) or 5 (day)');
  const a = ymdFromDay(loDay), b = ymdFromDay(hiDay);
  return a.y === b.y && a.m === b.m;
}

/** Month bin index of a day (months since year 0): y * 12 + (m - 1). @param {number} day @returns {number} */
export function monthBinOfDay(day) {
  const { y, m } = ymdFromDay(day);
  return y * 12 + (m - 1);
}

/**
 * Level-of-detail tier for a zoom in pixels per year (§1.6).
 * @param {number} ppy
 * @returns {'L0'|'L1'|'L2'|'L3'|'L4'|'L5'}
 */
export function tierForPpy(ppy) {
  if (ppy < 0.08) return 'L0';
  if (ppy < 0.8) return 'L1';
  if (ppy < 8) return 'L2';
  if (ppy < 96) return 'L3';
  if (ppy < 2922) return 'L4';
  return 'L5';
}

// ── Labels ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Historical label of an astronomical year: -499 → '500 BCE', 0 → '1 BCE', 600 → '600 CE', 1931 → '1931'.
 * @param {number} astroYear
 * @returns {string}
 */
export function yearLabel(astroYear) {
  if (astroYear <= 0) return `${1 - astroYear} BCE`;
  if (astroYear < 1000) return `${astroYear} CE`;
  return String(astroYear);
}

function ordinal(n) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * A span of astronomical years labelled historically (§13 rule 18): '1955–1985', '500–2 BCE', '44–79 CE'; an unknown end
 * reads '?'.
 * @param {number} lo astronomical year
 * @param {number} hi astronomical year
 * @returns {string}
 */
export function yearRangeLabel(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return `${Number.isFinite(lo) ? yearLabel(lo) : '?'}–${Number.isFinite(hi) ? yearLabel(hi) : '?'}`;
  if (lo === hi) return yearLabel(lo);
  if (hi <= 0) return `${1 - lo}–${1 - hi} BCE`;
  if (lo > 0 && hi < 1000) return `${lo}–${hi} CE`;
  return `${yearLabel(lo)}–${yearLabel(hi)}`;
}

/** Century [lo, hi] (astronomical) whose label covers year y: CE 1800–1899; BCE 500–401 BCE = -499…-400. */
function centuryOf(y) {
  if (y >= 0) return [Math.floor(y / 100) * 100, Math.floor(y / 100) * 100 + 99];
  const n = Math.ceil((1 - y) / 100);
  return [1 - n * 100, 1 - n * 100 + 99];
}

function centuryLabel(lo, hi) {
  if (lo === 1 && hi === 99) return '1st century';
  if (lo >= 0 && lo % 100 === 0 && hi === lo + 99) return `${ordinal(lo / 100 + 1)} century`;
  if (hi <= 0 && (1 - lo) % 100 === 0 && hi === lo + 99) return `${ordinal((1 - lo) / 100)} century BCE`;
  return null;
}

function millenniumLabel(lo, hi) {
  if (lo >= 0 && lo % 1000 === 0 && hi === lo + 999) return `${ordinal(lo / 1000 + 1)} millennium`;
  if (hi <= 0 && (1 - lo) % 1000 === 0 && hi === lo + 999) return `${ordinal((1 - lo) / 1000)} millennium BCE`;
  return null;
}

function centuryPartLabel(lo, hi) {
  const [cLo, cHi] = centuryOf(lo);
  const base = centuryLabel(cLo, cHi);
  if (!base || hi > cHi) return null;
  const off = lo - cLo;
  if (off === 0 && hi - lo === 33) return `early ${base}`;
  if (off === 33 && hi - lo === 33) return `mid ${base}`;
  if (off === 66 && hi === cHi) return `late ${base}`;
  return null;
}

function dayLabel({ y, m, d }) {
  return `${d} ${MONTH_ABBR[m - 1]} ${yearLabel(y)}`;
}

function dayRangeLabel(a, b) {
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTH_ABBR[a.m - 1]} ${yearLabel(a.y)}`;
  if (a.y === b.y) return `${a.d} ${MONTH_ABBR[a.m - 1]} – ${b.d} ${MONTH_ABBR[b.m - 1]} ${yearLabel(a.y)}`;
  return `${dayLabel(a)} – ${dayLabel(b)}`;
}

/** Generic label for any inclusive day interval, using the coarsest calendar alignment it has. */
function intervalLabel(loDay, hiDay) {
  const a = ymdFromDay(loDay), b = ymdFromDay(hiDay);
  const startsYear = a.m === 1 && a.d === 1, endsYear = b.m === 12 && b.d === 31;
  if (startsYear && endsYear) return yearRangeLabel(a.y, b.y);
  const startsMonth = a.d === 1, endsMonth = b.d === daysInMonth(b.y, b.m);
  if (startsMonth && endsMonth) {
    if (a.y === b.y && a.m === b.m) return `${MONTH_ABBR[a.m - 1]} ${yearLabel(a.y)}`;
    if (a.y === b.y) return `${MONTH_ABBR[a.m - 1]}–${MONTH_ABBR[b.m - 1]} ${yearLabel(a.y)}`;
    return `${MONTH_ABBR[a.m - 1]} ${yearLabel(a.y)} – ${MONTH_ABBR[b.m - 1]} ${yearLabel(b.y)}`;
  }
  if (loDay === hiDay) return dayLabel(a);
  return dayRangeLabel(a, b);
}

const BEFORE_RE = /^(before|pre|antes|avant|prior|से पहले|के पहले|से पूर्व|પહેલ|પૂર્વે)|(से पहले|के पहले|से पूर्व|પહેલાં|પહેલા|પૂર્વે)$/i;

/**
 * Human label of a parsed date: 'c. 1894', '1990s', 'Apr 1931', '17 May 1994', '500 BCE',
 * 'early 20th century', '1930–1931 (VS 1987)', 'undated'.
 * @param {DateParse} p
 * @returns {string}
 */
export function formatDateLabel(p) {
  if (!p || p.lo_day === null || p.lo_day === undefined || p.precision === 'unknown') return 'undated';
  const lo = ymdFromDay(p.lo_day), hi = ymdFromDay(p.hi_day);
  const rule = String(p.rule ?? '').replace(/\+future$/, '');
  const circa = p.approx ? 'c. ' : '';
  switch (p.precision) {
    case 'day':
      return circa + (p.lo_day === p.hi_day ? dayLabel(lo) : dayRangeLabel(lo, hi));
    case 'month':
      return circa + intervalLabel(p.lo_day, p.hi_day);
    case 'year':
      return circa + yearRangeLabel(lo.y, hi.y);
    case 'decade':
      if (lo.y >= 0 && lo.y % 10 === 0 && hi.y === lo.y + 9) return `${circa}${lo.y}s`;
      return circa + yearRangeLabel(lo.y, hi.y);
    case 'century':
      if (rule === 'hundreds' && lo.y % 100 === 0 && hi.y === lo.y + 99) return `${circa}${lo.y}s`;
      return circa + (centuryLabel(lo.y, hi.y) ?? yearRangeLabel(lo.y, hi.y));
    case 'millennium':
      return circa + (millenniumLabel(lo.y, hi.y) ?? yearRangeLabel(lo.y, hi.y));
    case 'period':
      return `${yearRangeLabel(lo.y, hi.y)} (period)`;
    default: break;
  }
  // precision 'range'
  if (rule === 'circa' && (hi.y - lo.y) % 2 === 0 && lo.m === 1 && lo.d === 1 && hi.m === 12 && hi.d === 31) {
    return `c. ${yearLabel((lo.y + hi.y) / 2)}`;
  }
  if (rule === 'century_part') {
    const part = centuryPartLabel(lo.y, hi.y);
    if (part) return part;
  }
  if (rule === 'vikram_samvat') return `${yearRangeLabel(lo.y, hi.y)} (VS ${lo.y + 57})`;
  if (rule === 'shaka_samvat') return `${yearRangeLabel(lo.y, hi.y)} (Saka ${lo.y - 78})`;
  if (rule === 'open_range' && typeof p.raw === 'string') {
    return BEFORE_RE.test(p.raw.trim()) ? `before ${yearLabel(hi.y + 1)}` : `after ${yearLabel(lo.y - 1)}`;
  }
  return circa + intervalLabel(p.lo_day, p.hi_day);
}

// ── Building DateParse values ───────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DateParse
 * @property {number|null} lo_day   inclusive, days since 1970-01-01
 * @property {number|null} hi_day   inclusive
 * @property {number|null} lo_year  astronomical year of lo_day
 * @property {number|null} hi_year  astronomical year of hi_day
 * @property {'day'|'month'|'year'|'decade'|'century'|'millennium'|'range'|'period'|'unknown'} precision
 * @property {'stated'|'estimated'|'derived'|'period'|'announced'|'unknown'} basis
 * @property {0|1} approx           circa qualifier
 * @property {string} rule          grammar rule id ('year', 'circa', 'vikram_samvat', 'year+future', …)
 * @property {string|null} raw      verbatim input
 * @property {string} label         formatDateLabel(this)
 * @property {string[]} warnings    issue codes (W_DATE_FUTURE, W_AMBIGUOUS_HUNDREDS, W_DATE_SEASON)
 */

function build(loDay, hiDay, { precision, basis, approx = 0, rule, raw = null, warnings = [] }) {
  const p = {
    lo_day: loDay, hi_day: hiDay,
    lo_year: loDay === null ? null : ymdFromDay(loDay).y,
    hi_year: hiDay === null ? null : ymdFromDay(hiDay).y,
    precision, basis, approx: approx ? 1 : 0, rule, raw, label: '', warnings: [...warnings],
  };
  p.label = formatDateLabel(p);
  return p;
}

function unknownParse(raw) {
  return build(null, null, { precision: 'unknown', basis: 'unknown', rule: 'unknown', raw });
}

function inferPrecision(loYear, hiYear) {
  if (loYear === hiYear) return 'year';
  if (loYear % 10 === 0 && hiYear === loYear + 9) return 'decade';
  if (centuryLabel(loYear, hiYear)) return 'century';
  if (millenniumLabel(loYear, hiYear)) return 'millennium';
  return 'range';
}

/**
 * DateParse for a whole-year interval stated by a source (adapters, language periods).
 * @param {number} loYear astronomical
 * @param {number} hiYear astronomical, ≥ loYear
 * @param {{precision?:string, basis:string, rule?:string, raw?:string|null, approx?:0|1}} opts
 * @returns {DateParse}
 */
export function fromInterval(loYear, hiYear, { precision, basis, rule = 'interval', raw = null, approx = 0 } = {}) {
  if (!Number.isInteger(loYear) || !Number.isInteger(hiYear) || loYear > hiYear) {
    throw new RangeError(`fromInterval: invalid years ${loYear}…${hiYear}`);
  }
  return build(dayFromYMD(loYear, 1, 1), dayFromYMD(hiYear, 12, 31),
    { precision: precision ?? inferPrecision(loYear, hiYear), basis: basis ?? 'stated', approx, rule, raw });
}

/**
 * DateParse for an explicit day interval (e.g. an OpenAlex publication_date with its precision).
 * @param {number} loDay @param {number} hiDay
 * @param {{precision:string, basis?:string, rule?:string, raw?:string|null, approx?:0|1}} opts
 * @returns {DateParse}
 */
export function fromDayInterval(loDay, hiDay, { precision, basis = 'stated', rule = 'interval', raw = null, approx = 0 }) {
  if (!Number.isInteger(loDay) || !Number.isInteger(hiDay) || loDay > hiDay) {
    throw new RangeError(`fromDayInterval: invalid days ${loDay}…${hiDay}`);
  }
  return build(loDay, hiDay, { precision, basis, approx, rule, raw });
}

// ── The grammar (§5.3) ──────────────────────────────────────────────────────────────────────────────

const DEVA_GUJR_DIGITS = /[०-९૦-૯]/g;
const mapDigits = (s) => s.replace(DEVA_GUJR_DIGITS,
  (c) => String.fromCharCode(48 + (c.charCodeAt(0) - (c.charCodeAt(0) >= 0x0AE6 ? 0x0AE6 : 0x0966))));

/** Lower-case, NFC, Indic digits → ASCII, Latin accents and nukta dropped, dashes/quotes unified. */
function prep(raw) {
  let s = mapDigits(String(raw).normalize('NFC'));
  s = s.replace(/[​-‍⁠﻿­]/g, '')
    .replace(/[‐‑]/g, '-').replace(/−/g, '-')
    .replace(/[‒–—―]/g, '–')
    .replace(/[‘’ʼ′`´]/g, "'")
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[़઼]/g, '').normalize('NFC')
    .replace(/\s+/g, ' ').trim();
  return s;
}

const MONTH_NAMES = (() => {
  const t = {
    1: 'january jan janvier janv enero ene जनवरी જાન્યુઆરી',
    2: 'february feb fevrier fevr fev febrero फरवरी ફેબ્રુઆરી',
    3: 'march mar mars marzo मार्च માર્ચ',
    4: 'april apr avril avr abril abr अप्रैल अप्रेल એપ્રિલ',
    5: 'may mai mayo मई મે',
    6: 'june jun juin junio जून જૂન જુન',
    7: 'july jul juillet juil julio जुलाई જુલાઈ જુલાઇ',
    8: 'august aug aout agosto ago अगस्त ઑગસ્ટ ઓગસ્ટ ઑગષ્ટ ઓગષ્ટ',
    9: 'september sept sep septembre septiembre setiembre set सितंबर सितम्बर સપ્ટેમ્બર',
    10: 'october oct octobre octubre अक्टूबर अक्तूबर ઑક્ટોબર ઓક્ટોબર',
    11: 'november nov novembre noviembre नवंबर नवम्बर નવેમ્બર',
    12: 'december dec decembre diciembre dic दिसंबर दिसम्बर ડિસેમ્બર',
  };
  const map = new Map();
  for (const [m, names] of Object.entries(t)) for (const n of names.split(' ')) map.set(prep(n), Number(m));
  return map;
})();
const MONTH_ALT = [...MONTH_NAMES.keys()].sort((a, b) => b.length - a.length)
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

const UNKNOWN = new Set(['', 'unknown', 'undated', 'no date', 'n.d.', 'n. d.', 'n.d', 'nd', 's.d.', 's. d.', 's.d',
  's.f.', 's. f.', 's.f', 'sin fecha', 'sans date', 'date inconnue', 'fecha desconocida', '?', '??', '???',
  '-', '–', 'n/a', 'na', 'null', 'none', 'अज्ञात', 'तिथि अज्ञात', 'અજ્ઞાત', 'તારીખ અજ્ઞાત'].map(prep));

const BCE = String.raw`(?:bce|b\.c\.e\.?|bc|b\.c\.?|av\.? ?j\.?-?c\.?|a\.? ?c\.?|a\.? de ?c\.?|ईसा पूर्व|ई\.? ?पू\.?|ઈ\.? ?સ\.? ?પૂ\.?|ઈસવીસન પૂર્વે)`;
const CE_SUFFIX = String.raw`(?:ce|c\.e\.?|ad|a\.d\.?|ap\.? ?j\.?-?c\.?|d\.? ?c\.?|d\.? de ?c\.?|ईस्वी|ई\.?|ઈ\.? ?સ\.?)`;
const CE_PREFIX = String.raw`(?:ad|a\.d\.?|सन्?|ई\.? ?स\.?|ઈ\.? ?સ\.?|year|ano|annee|an)`;
const RE_BCE_YEAR = new RegExp(`^(\\d{1,5}) ?${BCE}$`);
const RE_CE_YEAR = new RegExp(`^(\\d{1,4}) ?${CE_SUFFIX}$`);
const RE_CE_PREFIX_YEAR = new RegExp(`^${CE_PREFIX} ?(\\d{1,4})$`);

/**
 * A single year: '1931', '500 BCE', 'AD 79', '-300' (by convention). Returns null when `s` is not a year.
 * @returns {{year:number, rule:string}|{issue:object}|null}
 */
function yearAtom(s, opts) {
  let m;
  if ((m = /^(\d{1,4})$/.exec(s))) {
    const y = Number(m[1]);
    if (y === 0) {
      if (opts.negativeYearConvention === 'astronomical') return { year: 0, rule: 'year' };
      return issue('E_DATE_AMBIGUOUS', opts.raw,
        "Year 0 does not exist in the historical calendar: set 'zero means unknown', or write '1 BCE'.", ['1 BCE']);
    }
    return { year: y, rule: 'year' };
  }
  if ((m = RE_BCE_YEAR.exec(s))) {
    const n = Number(m[1]);
    return n >= 1 ? { year: 1 - n, rule: 'bce' } : null;
  }
  if ((m = RE_CE_YEAR.exec(s) ?? RE_CE_PREFIX_YEAR.exec(s))) {
    const y = Number(m[1]);
    return y >= 1 ? { year: y, rule: 'year' } : null;
  }
  if ((m = /^-(\d{1,5})$/.exec(s))) {
    const n = Number(m[1]);
    if (n === 0) return null;
    return { year: opts.negativeYearConvention === 'astronomical' ? -n : 1 - n, rule: 'negative_year' };
  }
  return null;
}

const span = (loY, hiY) => [dayFromYMD(loY, 1, 1), dayFromYMD(hiY, 12, 31)];
const ok = (lo, hi, precision, basis, rule, extra = {}) => ({ lo, hi, precision, basis, rule, approx: 0, warnings: [], ...extra });

function issue(code, raw, message, suggestions = []) {
  return { issue: { code, message, suggestions: suggestions.slice(0, 3) } };
}

function roman(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[ivxlc]+$/.test(s)) return null;
  const v = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const a = v[s[i]], b = v[s[i + 1]] ?? 0;
    n += a < b ? -a : a;
  }
  return n;
}

const BCE_TAIL = String.raw`(?: ?(${BCE}))?`;

/** Century → [loYear, hiYear] astronomical (popular usage: 19th century = 1800–1899). */
function centuryAtom(s) {
  let m, n = null, bce = false;
  if ((m = new RegExp(String.raw`^(\d{1,2})(?:st|nd|rd|th) (?:century|cent\.?|c\.?)${BCE_TAIL}$`).exec(s))) {
    n = Number(m[1]); bce = Boolean(m[2]);
  } else if ((m = new RegExp(String.raw`^([ivxlc]+|\d{1,2}) ?(?:e|eme|er|ieme) (?:siecle|s\.)${BCE_TAIL}$`).exec(s))) {
    n = roman(m[1]); bce = Boolean(m[2]);
  } else if ((m = new RegExp(String.raw`^(?:siglo|s\.) ?([ivxlc]+|\d{1,2})${BCE_TAIL}$`).exec(s))) {
    n = roman(m[1]); bce = Boolean(m[2]);
  } else if ((m = /^(\d{1,2}) ?(?:वीं|वी|वां|वाँ)? ?(?:सदी|शताब्दी|शती)$/.exec(s))) {
    n = Number(m[1]);
  } else if ((m = /^(\d{1,2}) ?(?:મી|માં|મો)? ?સદી$/.exec(s))) {
    n = Number(m[1]);
  }
  if (!n || n < 1 || n > 30) return null;
  // the 1st century CE starts at 1 CE: astronomical year 0 is 1 BCE, which belongs to the 1st century BCE (fix pass)
  return bce ? [1 - n * 100, -(n - 1) * 100] : [Math.max(1, (n - 1) * 100), n * 100 - 1];
}

function millenniumAtom(s) {
  let m, n = null, bce = false;
  if ((m = new RegExp(String.raw`^(\d{1,2})(?:st|nd|rd|th) millennium${BCE_TAIL}$`).exec(s))) {
    n = Number(m[1]); bce = Boolean(m[2]);
  } else if ((m = new RegExp(String.raw`^([ivx]+|\d{1,2}) ?(?:e|er|eme|ieme) millenaire${BCE_TAIL}$`).exec(s))) {
    n = roman(m[1]); bce = Boolean(m[2]);
  } else if ((m = new RegExp(String.raw`^(?:([ivx]+|\d{1,2})(?:º|o|er)? milenio|milenio ([ivx]+|\d{1,2}))${BCE_TAIL}$`).exec(s))) {
    n = roman(m[1] ?? m[2]); bce = Boolean(m[3]);
  }
  if (!n || n < 1 || n > 12) return null;
  return bce ? [1 - n * 1000, -(n - 1) * 1000] : [(n - 1) * 1000, n * 1000 - 1];
}

const CIRCA_PREFIXES = ['approximately', 'aproximadamente', 'hacia el ano', 'cerca de', 'around', 'environ', 'approx.',
  'approx', 'aprox.', 'aprox', 'circa', 'about', 'hacia', 'vers', 'env.', 'cca.', 'cca', 'ca.', 'ca', 'c.', 'c', '~', '≈',
  'लगभग', 'करीब', 'લગભગ', 'આશરે', 'અંદાજે'].map((p) => p.normalize('NFC'));

const SEASONS = [
  [/^(spring|printemps|primavera|वसंत|बसंत|વસંત)$/, 'spring', 3, 5],
  [/^(summer|ete|verano|गर्मी|ग्रीष्म|ઉનાળો|ગ્રીષ્મ)$/, 'summer', 6, 8],
  [/^(autumn|fall|automne|otono|पतझड़|पतझड|शरद|પાનખર|શરદ)$/, 'autumn', 9, 11],
  [/^(easter|paques|pascua|semana santa|ईस्टर)$/, 'Easter', 3, 4],
  [/^(winter|hiver|invierno|सर्दी|शीत|શિયાળો)$/, 'winter', 0, 0],
];

/** Rules that read ONE date (no ranges). Each returns an interval result, an {issue}, or null. */
function single(s, opts, allowCirca = true) {
  let m, r;

  // shaka before vikram: 'शक संवत 1850' contains 'संवत'
  if ((m = /^(?:शक(?: संवत)?|शके|શક(?: સંવત)?|saka(?: era| samvat)?|shaka(?: samvat)?) ?(\d{1,4})$/.exec(s))) {
    const n = Number(m[1]);
    return ok(...span(n + 78, n + 79), 'range', 'derived', 'shaka_samvat');
  }
  if ((m = /^(?:विक्रम संवत|वि\.? ?सं\.?|संवत|सम्वत|सं\.|વિક્રમ સંવત|વિ\.? ?સં\.?|સંવત|vikram samvat|samvat|v\. ?s\.|vs) ?(\d{1,4})$/.exec(s)
    ?? /^(\d{1,4}) ?(?:vs|v\. ?s\.|संवत|સંવત)$/.exec(s))) {
    const n = Number(m[1]);
    return ok(...span(n - 57, n - 56), 'range', 'derived', 'vikram_samvat');
  }

  // ISO day / date-time: the stated calendar date is kept as written
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?: ?(?:z|utc|[+-]\d{2}(?::?\d{2})?))?)?$/.exec(s)
    ?? /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s))) {
    return dayResult(Number(m[1]), Number(m[2]), Number(m[3]), 'iso_day', opts);
  }
  // all-numeric day-first or month-first dates are not guessed
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) {
    const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    const readings = [];
    if (validDay(y, b, a)) readings.push(isoString(y, b, a));
    if (validDay(y, a, b) && a !== b) readings.push(isoString(y, a, b));
    return readings.length === 2
      ? issue('E_DATE_AMBIGUOUS', opts.raw, `'${opts.raw}' could be day-first or month-first: write ${readings.join(' or ')}.`, readings)
      : issue('E_DATE_UNPARSEABLE', opts.raw, `'${opts.raw}' is not an unambiguous date: write it as YYYY-MM-DD.`, readings);
  }
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(s)) && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    const y = Number(m[1]), mo = Number(m[2]);
    return ok(dayFromYMD(y, mo, 1), dayFromYMD(y, mo, daysInMonth(y, mo)), 'month', 'stated', 'month');
  }

  // named month with a day: '7 April 1931', '7 avril 1931', '7 de abril de 1931', 'April 7, 1931'
  if ((m = new RegExp(String.raw`^(\d{1,2})(?:st|nd|rd|th|er|º|°|o)?\.? (?:de )?(${MONTH_ALT})\.?,? (?:de |del )?(.+)$`).exec(s))) {
    r = yearAtom(m[3], opts);
    if (r && !r.issue) return dayResult(r.year, MONTH_NAMES.get(m[2]), Number(m[1]), 'dmy_named', opts);
  }
  if ((m = new RegExp(String.raw`^(${MONTH_ALT})\.? (\d{1,2})(?:st|nd|rd|th)?,? (.+)$`).exec(s))) {
    r = yearAtom(m[3], opts);
    if (r && !r.issue) return dayResult(r.year, MONTH_NAMES.get(m[1]), Number(m[2]), 'dmy_named', opts);
  }
  // named month: 'April 1931', 'avril 1931', 'abril de 1931'
  if ((m = new RegExp(String.raw`^(${MONTH_ALT})\.?,? (?:de |del )?(.+)$`).exec(s))) {
    r = yearAtom(m[2], opts);
    if (r && !r.issue) {
      const mo = MONTH_NAMES.get(m[1]);
      return ok(dayFromYMD(r.year, mo, 1), dayFromYMD(r.year, mo, daysInMonth(r.year, mo)), 'month', 'stated', 'month');
    }
  }

  // seasons (northern hemisphere); winter straddles two years and is not guessed
  if ((m = /^(.+?) (?:of |de |del )?(\d{4})$/.exec(s))) {
    for (const [re, name, m0, m1] of SEASONS) {
      if (!re.test(m[1])) continue;
      const y = Number(m[2]);
      if (name === 'winter') {
        const sug = [`${y - 1}-12/${y}-02`, `${y}-12/${y + 1}-02`];
        return issue('E_DATE_AMBIGUOUS', opts.raw,
          `'${opts.raw}': which winter? Write Dec ${y - 1}–Feb ${y} (${sug[0]}) or Dec ${y}–Feb ${y + 1} (${sug[1]}).`, sug);
      }
      return ok(dayFromYMD(y, m0, 1), dayFromYMD(y, m1, daysInMonth(y, m1)), 'range', 'estimated', 'season',
        { warnings: ['W_DATE_SEASON'] });
    }
  }

  // early / mid / late Nth century
  if ((m = /^(early|mid|middle|late|debut|milieu|fin|principios|comienzos|inicios|mediados|finales|fines)(?=[ -]) ?-?(?:the |du |de la |del |de )?(.+)$/.exec(s))) {
    const c = centuryAtom(m[2]);
    if (c) {
      const part = /^(early|debut|principios|comienzos|inicios)$/.test(m[1]) ? 0
        : /^(mid|middle|milieu|mediados)$/.test(m[1]) ? 1 : 2;
      const lo = c[0] + 33 * part, hi = part === 2 ? c[1] : c[0] + 33 * (part + 1);
      return ok(...span(lo, hi), 'range', 'stated', 'century_part');
    }
  }
  if ((r = centuryAtom(s))) return ok(...span(r[0], r[1]), 'century', 'stated', 'century');
  if ((r = millenniumAtom(s))) return ok(...span(r[0], r[1]), 'millennium', 'stated', 'millennium');

  // decades: '1990s', 'the 1990s', 'années 1990', 'década de 1990'; 'the 1800s' is a whole century
  if ((m = /^(?:the )?(\d{3,4})'?s$/.exec(s))) {
    const y = Number(m[1]);
    if (y % 10 !== 0) return null;
    if (m[1].length === 4 && y % 100 === 0) {
      return ok(...span(y, y + 99), 'century', 'stated', 'hundreds', { warnings: ['W_AMBIGUOUS_HUNDREDS'] });
    }
    return ok(...span(y, y + 9), 'decade', 'stated', 'decade');
  }
  if ((m = /^(?:les )?annees (\d{3,4})$/.exec(s) ?? /^(?:la )?decada de(?: los)? (\d{3,4})$/.exec(s)
    ?? /^(?:los )?anos (\d{3,4})$/.exec(s) ?? /^(\d{3,4}) ?(?:का|के) दशक$/.exec(s) ?? /^(\d{3,4}) ?(?:નો|ના) દાયકો$/.exec(s))) {
    const y = Number(m[1]);
    if (y % 10 !== 0) return null;
    return ok(...span(y, y + 9), 'decade', 'stated', 'decade');
  }
  if ((m = /^(?:the )?'?(\d)0'?s$/.exec(s) ?? /^(?:les )?annees (\d)0$/.exec(s) ?? /^(?:los (?:anos )?|anos )'?(\d)0$/.exec(s))) {
    const d = Number(m[1]);
    const tdc = opts.twoDigitCentury;
    if (tdc === null || tdc === undefined) {
      const thisYear = ymdFromDay(todayDay(opts.now)).y;
      const sug = [1900, 1800, 2000].map((c) => c + d * 10).filter((y) => y <= thisYear).map((y) => `${y}s`);
      return issue('E_DATE_AMBIGUOUS', opts.raw, `'${opts.raw}': which century? Set 'two-digit years → 19xx'.`, sug);
    }
    const base = tdc < 100 ? tdc * 100 : tdc;
    return ok(...span(base + d * 10, base + d * 10 + 9), 'decade', 'stated', 'decade_2digit');
  }

  // open ranges: 'before 1850', 'after 1850', 'antes de 1850', '1850 से पहले'
  if ((m = /^(?:before|pre-?|prior to|antes de(?:l ano)?|avant(?: l'an)?) ?(.+)$/.exec(s)
    ?? /^(.+?) ?(?:से पहले|के पहले|से पूर्व|પહેલાં|પહેલા|પૂર્વે)$/.exec(s))) {
    r = yearAtom(m[1], opts);
    if (r && !r.issue) return ok(...span(r.year - opts.openRangeYears, r.year - 1), 'range', 'estimated', 'open_range');
  }
  if ((m = /^(?:after|post-?|despues de(?:l ano)?|apres(?: l'an)?) ?(.+)$/.exec(s)
    ?? /^(.+?) ?(?:के बाद|के पश्चात|પછી|બાદ)$/.exec(s))) {
    r = yearAtom(m[1], opts);
    if (r && !r.issue) return ok(...span(r.year + 1, r.year + opts.openRangeYears), 'range', 'estimated', 'open_range');
  }

  // circa: a prefix word or a trailing '?'; the remainder must itself be a date
  if (allowCirca) {
    const rests = CIRCA_PREFIXES.filter((p) => s.startsWith(p)).map((p) => s.slice(p.length).trim());
    if ((m = /^(.+?) ?\?$/.exec(s))) rests.push(m[1]);
    for (const rest of rests) {
      const inner = rest && single(rest, opts, false);
      if (!inner || inner.issue) continue;
      if (inner.precision === 'year') {
        const y = ymdFromDay(inner.lo).y, rad = opts.circaRadius;
        return ok(...span(y - rad, y + rad), 'range', 'estimated', 'circa', { approx: 1 });
      }
      return { ...inner, basis: inner.basis === 'derived' ? 'derived' : 'estimated', approx: 1, rule: 'circa' };
    }
  }

  r = yearAtom(s, opts);
  if (r?.issue) return r;
  if (r) return ok(...span(r.year, r.year), 'year', 'stated', r.rule);
  return null;
}

function validDay(y, mo, d) {
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}
function isoString(y, mo, d) {
  const yy = y < 0 ? `-${String(-y).padStart(4, '0')}` : String(y).padStart(4, '0');
  return `${yy}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function dayResult(y, mo, d, rule, opts) {
  if (!validDay(y, mo, d)) {
    return issue('E_DATE_INVALID', opts.raw, `Date ${opts.raw} does not exist.`);
  }
  const day = dayFromYMD(y, mo, d);
  return ok(day, day, 'day', 'stated', rule);
}

/** Ranges combine two single dates: '1850–1855', '1850-55', 'between 1850 and 1855', '1850/1851'. */
function range(s, opts) {
  let m;
  // shared era: '500–400 BCE'
  if ((m = new RegExp(`^(\\d{1,5}) ?[-–] ?(\\d{1,5}) ?(${BCE})$`).exec(s))) {
    return combine(single(`${m[1]} bc`, opts, false), single(`${m[2]} bc`, opts, false), opts);
  }
  // abbreviated end: '1850-55', '1850–5'
  if ((m = /^(\d{4}) ?[-–] ?(\d{1,2})$/.exec(s))) {
    const k = m[2].length, start = Number(m[1]);
    const end = start - (start % 10 ** k) + Number(m[2]);
    return combine(single(m[1], opts, false), single(String(end), opts, false), opts);
  }
  const forms = [
    /^(?:between|entre) (.+?) (?:and|et|y|e) (.+)$/,
    /^(?:from|de|desde|du|des) (.+?) (?:to|a|à|al|au|hasta|until|till|-|–) (.+)$/,
    /^(.+?) (?:to|until|till|a|à|al|au|hasta) (.+)$/,
    /^(.+?) (?:से|થી) (.+?)(?: तक| સુધી)?$/,
    /^(.+?) ?[–/] ?(.+)$/,
    /^(.+?) - (.+)$/,
    /^(\d{3,4})-(\d{3,4})$/,
  ];
  for (const re of forms) {
    if (!(m = re.exec(s))) continue;
    const a = single(m[1], opts), b = single(m[2], opts);
    if (a && b && !a.issue && !b.issue) return combine(a, b, opts);
  }
  return null;
}

function combine(a, b, opts) {
  if (!a || !b) return null;
  if (a.issue) return a;
  if (b.issue) return b;
  if (a.lo > b.hi) {
    return issue('E_DATE_INVALID', opts.raw, `Range '${opts.raw}' ends before it starts.`);
  }
  const basis = a.basis === 'derived' || b.basis === 'derived' ? 'derived'
    : a.basis === 'estimated' || b.basis === 'estimated' ? 'estimated' : 'stated';
  return ok(a.lo, b.hi, 'range', basis, 'range',
    { approx: a.approx || b.approx ? 1 : 0, warnings: [...new Set([...a.warnings, ...b.warnings])] });
}

const SUGGEST_SEASONS = [['spring', /spring|printemps|primavera/], ['summer', /summer|ete|verano/],
  ['autumn', /autumn|fall|automne|otono/], ['Easter', /easter|paques|pascua/]];

function suggestionsFor(s, opts) {
  const years = s.match(/(?<!\d)\d{4}(?!\d)/g) ?? [];
  const out = [];
  if (years.length >= 2) out.push(`${years[0]}–${years[1]}`);
  if (years.length >= 1) {
    const y = years[0];
    for (const [name, re] of SUGGEST_SEASONS) if (re.test(s)) out.push(`${name} ${y}`);
    for (const [name, mo] of MONTH_NAMES) {
      if (name.length >= 3 && new RegExp(`(^|[^a-z])${name}`).test(s)) { out.push(`${MONTH_ABBR[mo - 1]} ${y}`); break; }
    }
    out.push(`c. ${y}`, y);
  }
  const valid = [];
  for (const cand of out) {
    if (valid.includes(cand)) continue;
    const r = single(prep(cand), { ...opts, raw: cand }) ?? range(prep(cand), { ...opts, raw: cand });
    if (r && !r.issue) valid.push(cand);
    if (valid.length === 3) break;
  }
  return valid;
}

/**
 * Parse a date as written (§5.3). Devanagari/Gujarati digits are mapped first; matching is
 * case-insensitive with en/fr/es/hi/gu month names. A date after `now` gets basis 'announced', rule
 * '<rule>+future' and the W_DATE_FUTURE warning (Scheduled shelf).
 * @param {string|number|null|undefined} raw
 * @param {{circaRadius?:number, openRangeYears?:number, twoDigitCentury?:number|null, zeroIsUnknown?:boolean,
 *          negativeYearConvention?:'historical'|'astronomical', now?:Date}} [options]
 * @returns {DateParse | {issue:{code:string, message:string, suggestions:string[]}}}
 */
export function parseDate(raw, { circaRadius = 5, openRangeYears = 50, twoDigitCentury = null, zeroIsUnknown = false,
  negativeYearConvention = 'historical', now = new Date() } = {}) {
  const rawStr = raw === null || raw === undefined ? null : String(raw);
  const s = rawStr === null ? '' : prep(rawStr);
  if (UNKNOWN.has(s) || (zeroIsUnknown && /^0+$/.test(s))) return unknownParse(rawStr);

  const opts = { circaRadius, openRangeYears, twoDigitCentury, negativeYearConvention, now, raw: rawStr };
  const t = s.replace(/^(?:in|en|au|during|durante|pendant) /, '');
  const r = single(t, opts) ?? range(t, opts);
  if (!r) {
    const suggestions = suggestionsFor(t, opts);
    const hint = suggestions.length ? `; try ${suggestions.map((x) => `'${x}'`).join(' or ')}` : '';
    return issue('E_DATE_UNPARSEABLE', rawStr, `Date '${rawStr}' was not recognised${hint}.`, suggestions);
  }
  if (r.issue) return r;

  let { basis, rule } = r;
  const warnings = [...r.warnings];
  if (r.lo > todayDay(now)) {
    basis = 'announced';
    rule = `${rule}+future`;
    warnings.push('W_DATE_FUTURE');
  }
  return build(r.lo, r.hi, { precision: r.precision, basis, approx: r.approx, rule, raw: rawStr, warnings });
}
