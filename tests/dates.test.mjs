// OWNER: WP0 — date grammar (§5.3, ≥ 90 cases), day arithmetic (D5, rule 18), bins and tiers (§1.6)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dayFromYMD, ymdFromDay, parseDate, fromInterval, fromDayInterval, formatDateLabel, yearLabel, LEVELS, binOf, fits,
  fitsDays, tierForPpy, isLeapYear, daysInMonth,
} from '../src/shared/dates.mjs';
import { check } from '../src/shared/contracts.mjs';

const NOW = new Date('2026-10-04T12:00:00Z');

/** Independent reference: Howard Hinnant's days_from_civil (proleptic Gregorian, astronomical years). */
function civil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}
/** '1931-04-07' / '-0499-01-01' → day number via the independent reference. */
function day(s) {
  const m = /^(-?\d+)-(\d+)-(\d+)$/.exec(s);
  return civil(Number(m[1]), Number(m[2]), Number(m[3]));
}
const Y = (a, b = a) => [civil(a, 1, 1), civil(b, 12, 31)];
const D = (a, b = a) => [day(a), day(b)];

// [input, rule, precision, basis, [lo_day, hi_day], extra?]   extra: { approx, label, warnings, opts }
const OK = [
  // ISO and named-month days
  ['1931-04-07', 'iso_day', 'day', 'stated', D('1931-04-07'), { label: '7 Apr 1931' }],
  ['1931-4-7', 'iso_day', 'day', 'stated', D('1931-04-07')],
  ['1931-04-07T10:00:00Z', 'iso_day', 'day', 'stated', D('1931-04-07')],
  ['1931-04-07 23:59', 'iso_day', 'day', 'stated', D('1931-04-07')],
  ['1931-04-07T10:00:00+05:30', 'iso_day', 'day', 'stated', D('1931-04-07')],
  ['1931/04/07', 'iso_day', 'day', 'stated', D('1931-04-07')],
  ['2000-02-29', 'iso_day', 'day', 'stated', D('2000-02-29')],
  ['7 April 1931', 'dmy_named', 'day', 'stated', D('1931-04-07')],
  ['7 avril 1931', 'dmy_named', 'day', 'stated', D('1931-04-07')],
  ['7 de abril de 1931', 'dmy_named', 'day', 'stated', D('1931-04-07')],
  ['1er avril 1931', 'dmy_named', 'day', 'stated', D('1931-04-01')],
  ['April 7, 1931', 'dmy_named', 'day', 'stated', D('1931-04-07')],
  ['7 Apr. 1931', 'dmy_named', 'day', 'stated', D('1931-04-07')],
  ['17 May 1994', 'dmy_named', 'day', 'stated', D('1994-05-17'), { label: '17 May 1994' }],
  ['14 février 1958', 'dmy_named', 'day', 'stated', D('1958-02-14')],
  ['3 de diciembre de 1890', 'dmy_named', 'day', 'stated', D('1890-12-03')],
  ['7 अप्रैल 1931', 'dmy_named', 'day', 'stated', D('1931-04-07')],
  ['२ अक्टूबर १८६९', 'dmy_named', 'day', 'stated', D('1869-10-02')],
  ['૭ એપ્રિલ ૧૯૩૧', 'dmy_named', 'day', 'stated', D('1931-04-07')],
  ['7 सितंबर 1931', 'dmy_named', 'day', 'stated', D('1931-09-07')],
  // months
  ['1931-04', 'month', 'month', 'stated', D('1931-04-01', '1931-04-30'), { label: 'Apr 1931' }],
  ['April 1931', 'month', 'month', 'stated', D('1931-04-01', '1931-04-30')],
  ['avril 1931', 'month', 'month', 'stated', D('1931-04-01', '1931-04-30')],
  ['abril de 1931', 'month', 'month', 'stated', D('1931-04-01', '1931-04-30')],
  ['Feb 2000', 'month', 'month', 'stated', D('2000-02-01', '2000-02-29')],
  ['février 1900', 'month', 'month', 'stated', D('1900-02-01', '1900-02-28')],
  ['septiembre 1810', 'month', 'month', 'stated', D('1810-09-01', '1810-09-30')],
  ['अगस्त 1947', 'month', 'month', 'stated', D('1947-08-01', '1947-08-31')],
  ['ઑગસ્ટ ૧૯૪૭', 'month', 'month', 'stated', D('1947-08-01', '1947-08-31')],
  ['June 1963', 'month', 'month', 'stated', D('1963-06-01', '1963-06-30'), { label: 'Jun 1963' }],
  // years
  ['1931', 'year', 'year', 'stated', Y(1931), { label: '1931' }],
  ['1', 'year', 'year', 'stated', Y(1), { label: '1 CE' }],
  ['99', 'year', 'year', 'stated', Y(99), { label: '99 CE' }],
  ['१९७१', 'year', 'year', 'stated', Y(1971)],
  ['૧૯૮૭', 'year', 'year', 'stated', Y(1987)],
  ['AD 79', 'year', 'year', 'stated', Y(79), { label: '79 CE' }],
  ['79 CE', 'year', 'year', 'stated', Y(79)],
  ['in 1931', 'year', 'year', 'stated', Y(1931)],
  ['en 1931', 'year', 'year', 'stated', Y(1931)],
  // circa (± circa_radius, default 5)
  ['c. 1931', 'circa', 'range', 'estimated', Y(1926, 1936), { approx: 1, label: 'c. 1931' }],
  ['ca. 1931', 'circa', 'range', 'estimated', Y(1926, 1936), { approx: 1 }],
  ['circa 1931', 'circa', 'range', 'estimated', Y(1926, 1936), { approx: 1 }],
  ['~1931', 'circa', 'range', 'estimated', Y(1926, 1936), { approx: 1 }],
  ['1931?', 'circa', 'range', 'estimated', Y(1926, 1936), { approx: 1 }],
  ['hacia 1931', 'circa', 'range', 'estimated', Y(1926, 1936), { approx: 1 }],
  ['vers 1931', 'circa', 'range', 'estimated', Y(1926, 1936), { approx: 1 }],
  ['around 1931', 'circa', 'range', 'estimated', Y(1926, 1936), { approx: 1 }],
  ['c1931', 'circa', 'range', 'estimated', Y(1926, 1936), { approx: 1 }],
  ['लगभग 1931', 'circa', 'range', 'estimated', Y(1926, 1936), { approx: 1 }],
  ['c. 1931', 'circa', 'range', 'estimated', Y(1921, 1941), { approx: 1, opts: { circaRadius: 10 } }],
  ['c. 1894', 'circa', 'range', 'estimated', Y(1889, 1899), { approx: 1, label: 'c. 1894' }],
  ['c. 500 BCE', 'circa', 'range', 'estimated', Y(-504, -494), { approx: 1, label: 'c. 500 BCE' }],
  ['c. 1890s', 'circa', 'decade', 'estimated', Y(1890, 1899), { approx: 1, label: 'c. 1890s' }],
  // decades and hundreds
  ['1990s', 'decade', 'decade', 'stated', Y(1990, 1999), { label: '1990s' }],
  ['the 1990s', 'decade', 'decade', 'stated', Y(1990, 1999)],
  ["1990's", 'decade', 'decade', 'stated', Y(1990, 1999)],
  ['années 1990', 'decade', 'decade', 'stated', Y(1990, 1999)],
  ['les années 1890', 'decade', 'decade', 'stated', Y(1890, 1899)],
  ['década de 1990', 'decade', 'decade', 'stated', Y(1990, 1999)],
  ['1990 का दशक', 'decade', 'decade', 'stated', Y(1990, 1999)],
  ['1990નો દાયકો', 'decade', 'decade', 'stated', Y(1990, 1999)],
  ['the 1800s', 'hundreds', 'century', 'stated', Y(1800, 1899), { warnings: ['W_AMBIGUOUS_HUNDREDS'], label: '1800s' }],
  ['1900s', 'hundreds', 'century', 'stated', Y(1900, 1999), { warnings: ['W_AMBIGUOUS_HUNDREDS'] }],
  ["'90s", 'decade_2digit', 'decade', 'stated', Y(1990, 1999), { opts: { twoDigitCentury: 19 } }],
  ['60s', 'decade_2digit', 'decade', 'stated', Y(1960, 1969), { opts: { twoDigitCentury: 1900 } }],
  // centuries (popular usage: 19th = 1800–1899)
  ['19th century', 'century', 'century', 'stated', Y(1800, 1899), { label: '19th century' }],
  ['19th c.', 'century', 'century', 'stated', Y(1800, 1899)],
  ['19th cent.', 'century', 'century', 'stated', Y(1800, 1899)],
  ['XIXe siècle', 'century', 'century', 'stated', Y(1800, 1899)],
  ['siglo XIX', 'century', 'century', 'stated', Y(1800, 1899)],
  ['s. XIX', 'century', 'century', 'stated', Y(1800, 1899)],
  ['1st century', 'century', 'century', 'stated', Y(1, 99), { label: '1st century' }],   // fix pass: year 0 is 1 BCE
  ['21st century', 'century', 'century', 'stated', Y(2000, 2099), { label: '21st century' }],
  ['5th century BCE', 'century', 'century', 'stated', Y(-499, -400), { label: '5th century BCE' }],
  ['Ier siècle av. J.-C.', 'century', 'century', 'stated', Y(-99, 0), { label: '1st century BCE' }],
  ['19वीं सदी', 'century', 'century', 'stated', Y(1800, 1899)],
  ['19મી સદી', 'century', 'century', 'stated', Y(1800, 1899)],
  ['early 19th century', 'century_part', 'range', 'stated', Y(1800, 1833), { label: 'early 19th century' }],
  ['mid 19th century', 'century_part', 'range', 'stated', Y(1833, 1866), { label: 'mid 19th century' }],
  ['mid-19th century', 'century_part', 'range', 'stated', Y(1833, 1866)],
  ['middle 19th century', 'century_part', 'range', 'stated', Y(1833, 1866)],
  ['late 19th century', 'century_part', 'range', 'stated', Y(1866, 1899), { label: 'late 19th century' }],
  ['early 20th century', 'century_part', 'range', 'stated', Y(1900, 1933), { label: 'early 20th century' }],
  ['début du XXe siècle', 'century_part', 'range', 'stated', Y(1900, 1933)],
  ['fin du XIXe siècle', 'century_part', 'range', 'stated', Y(1866, 1899)],
  ['principios del siglo XX', 'century_part', 'range', 'stated', Y(1900, 1933)],
  ['mediados del siglo XIX', 'century_part', 'range', 'stated', Y(1833, 1866)],
  ['finales del siglo XIX', 'century_part', 'range', 'stated', Y(1866, 1899)],
  // millennia
  ['2nd millennium BCE', 'millennium', 'millennium', 'stated', Y(-1999, -1000), { label: '2nd millennium BCE' }],
  ['2nd millennium', 'millennium', 'millennium', 'stated', Y(1000, 1999), { label: '2nd millennium' }],
  ['IIe millénaire av. J.-C.', 'millennium', 'millennium', 'stated', Y(-1999, -1000)],
  ['II milenio a. C.', 'millennium', 'millennium', 'stated', Y(-1999, -1000)],
  // ranges
  ['1850–1855', 'range', 'range', 'stated', Y(1850, 1855), { label: '1850–1855' }],
  ['1850-1855', 'range', 'range', 'stated', Y(1850, 1855)],
  ['1850 - 1855', 'range', 'range', 'stated', Y(1850, 1855)],
  ['1850-55', 'range', 'range', 'stated', Y(1850, 1855)],
  ['1850–5', 'range', 'range', 'stated', Y(1850, 1855)],
  ['1850 to 1855', 'range', 'range', 'stated', Y(1850, 1855)],
  ['between 1850 and 1855', 'range', 'range', 'stated', Y(1850, 1855)],
  ['from 1850 to 1855', 'range', 'range', 'stated', Y(1850, 1855)],
  ['de 1850 à 1855', 'range', 'range', 'stated', Y(1850, 1855)],
  ['entre 1850 et 1855', 'range', 'range', 'stated', Y(1850, 1855)],
  ['de 1850 a 1855', 'range', 'range', 'stated', Y(1850, 1855)],
  ['entre 1850 y 1855', 'range', 'range', 'stated', Y(1850, 1855)],
  ['1850/1851', 'range', 'range', 'stated', Y(1850, 1851)],
  ['1850 से 1855 तक', 'range', 'range', 'stated', Y(1850, 1855)],
  ['1850 થી 1855', 'range', 'range', 'stated', Y(1850, 1855)],
  ['500–400 BCE', 'range', 'range', 'stated', Y(-499, -399), { label: '500–400 BCE' }],
  ['1931-04-07/1931-04-09', 'range', 'range', 'stated', D('1931-04-07', '1931-04-09'), { label: '7–9 Apr 1931' }],
  ['c. 1850 – 1860', 'range', 'range', 'estimated', Y(1845, 1860), { approx: 1 }],
  // open ranges (open_range_years, default 50)
  ['before 1850', 'open_range', 'range', 'estimated', Y(1800, 1849), { label: 'before 1850' }],
  ['after 1850', 'open_range', 'range', 'estimated', Y(1851, 1900), { label: 'after 1850' }],
  ['antes de 1850', 'open_range', 'range', 'estimated', Y(1800, 1849)],
  ['avant 1850', 'open_range', 'range', 'estimated', Y(1800, 1849)],
  ['después de 1850', 'open_range', 'range', 'estimated', Y(1851, 1900)],
  ['après 1850', 'open_range', 'range', 'estimated', Y(1851, 1900)],
  ['pre-1850', 'open_range', 'range', 'estimated', Y(1800, 1849)],
  ['1850 से पहले', 'open_range', 'range', 'estimated', Y(1800, 1849), { label: 'before 1850' }],
  ['1850 પછી', 'open_range', 'range', 'estimated', Y(1851, 1900), { label: 'after 1850' }],
  ['before 1850', 'open_range', 'range', 'estimated', Y(1830, 1849), { opts: { openRangeYears: 20 } }],
  ['before 500 BCE', 'open_range', 'range', 'estimated', Y(-549, -500), { label: 'before 500 BCE' }],
  // BCE and negative years (astronomical internally, historical labels)
  ['500 BCE', 'bce', 'year', 'stated', Y(-499), { label: '500 BCE' }],
  ['500 BC', 'bce', 'year', 'stated', Y(-499)],
  ['500 B.C.', 'bce', 'year', 'stated', Y(-499)],
  ['500 av. J.-C.', 'bce', 'year', 'stated', Y(-499)],
  ['500 a. C.', 'bce', 'year', 'stated', Y(-499)],
  ['500 a.C.', 'bce', 'year', 'stated', Y(-499)],
  ['500 ईसा पूर्व', 'bce', 'year', 'stated', Y(-499)],
  ['1 BCE', 'bce', 'year', 'stated', Y(0), { label: '1 BCE' }],
  ['4500 BCE', 'bce', 'year', 'stated', Y(-4499), { label: '4500 BCE' }],
  ['10000 BCE', 'bce', 'year', 'stated', Y(-9999), { label: '10000 BCE' }],
  ['-300', 'negative_year', 'year', 'stated', Y(-299), { label: '300 BCE' }],
  ['-300', 'negative_year', 'year', 'stated', Y(-300), { label: '301 BCE', opts: { negativeYearConvention: 'astronomical' } }],
  ['−300', 'negative_year', 'year', 'stated', Y(-299)],
  ['0', 'year', 'year', 'stated', Y(0), { label: '1 BCE', opts: { negativeYearConvention: 'astronomical' } }],
  // calendar conversions
  ['संवत 1987', 'vikram_samvat', 'range', 'derived', Y(1930, 1931), { label: '1930–1931 (VS 1987)' }],
  ['સંવત ૧૯૮૭', 'vikram_samvat', 'range', 'derived', Y(1930, 1931), { label: '1930–1931 (VS 1987)' }],
  ['VS 1987', 'vikram_samvat', 'range', 'derived', Y(1930, 1931)],
  ['वि. सं. 1987', 'vikram_samvat', 'range', 'derived', Y(1930, 1931)],
  ['1987 VS', 'vikram_samvat', 'range', 'derived', Y(1930, 1931)],
  ['शक 1850', 'shaka_samvat', 'range', 'derived', Y(1928, 1929), { label: '1928–1929 (Saka 1850)' }],
  ['Saka 1850', 'shaka_samvat', 'range', 'derived', Y(1928, 1929)],
  ['शक संवत 1850', 'shaka_samvat', 'range', 'derived', Y(1928, 1929)],
  ['શક ૧૮૫૦', 'shaka_samvat', 'range', 'derived', Y(1928, 1929)],
  // seasons (northern hemisphere, estimated + warning)
  ['spring 1850', 'season', 'range', 'estimated', D('1850-03-01', '1850-05-31'), { warnings: ['W_DATE_SEASON'], label: 'Mar–May 1850' }],
  ['Easter 1850', 'season', 'range', 'estimated', D('1850-03-01', '1850-04-30'), { warnings: ['W_DATE_SEASON'], label: 'Mar–Apr 1850' }],
  ['printemps 1850', 'season', 'range', 'estimated', D('1850-03-01', '1850-05-31'), { warnings: ['W_DATE_SEASON'] }],
  ['primavera de 1850', 'season', 'range', 'estimated', D('1850-03-01', '1850-05-31'), { warnings: ['W_DATE_SEASON'] }],
  ['summer 1850', 'season', 'range', 'estimated', D('1850-06-01', '1850-08-31'), { warnings: ['W_DATE_SEASON'] }],
  ['autumn 1850', 'season', 'range', 'estimated', D('1850-09-01', '1850-11-30'), { warnings: ['W_DATE_SEASON'] }],
  // after the import time → announced (Scheduled shelf)
  ['2027', 'year+future', 'year', 'announced', Y(2027), { warnings: ['W_DATE_FUTURE'], label: '2027' }],
  ['2026-12-25', 'iso_day+future', 'day', 'announced', D('2026-12-25'), { warnings: ['W_DATE_FUTURE'] }],
  ['2030s', 'decade+future', 'decade', 'announced', Y(2030, 2039), { warnings: ['W_DATE_FUTURE'] }],
  ['2026', 'year', 'year', 'stated', Y(2026)],
  ['c. 2030', 'circa', 'range', 'estimated', Y(2025, 2035), { approx: 1 }],
];

const UNKNOWN = ['unknown', 'n.d.', 'N.D.', 's.d.', 's.f.', 'sin fecha', 'sans date', '?', '', '   ', 'undated', 'अज्ञात', null, undefined];

// [input, code, opts?, suggestionsInclude?]
const ISSUES = [
  ['2019-02-30', 'E_DATE_INVALID'],
  ['1900-02-29', 'E_DATE_INVALID'],
  ['1931-13-01', 'E_DATE_INVALID'],
  ['31 June 1931', 'E_DATE_INVALID'],
  ['1855–1850', 'E_DATE_INVALID'],
  ['1898–5', 'E_DATE_INVALID'],
  ["'90s", 'E_DATE_AMBIGUOUS', {}, ['1990s']],
  ['90s', 'E_DATE_AMBIGUOUS', {}, ['1990s']],
  ['les années 60', 'E_DATE_AMBIGUOUS'],
  ['0', 'E_DATE_AMBIGUOUS', {}, ['1 BCE']],
  ['winter 1850', 'E_DATE_AMBIGUOUS'],
  ['07/04/1931', 'E_DATE_AMBIGUOUS', {}, ['1931-04-07', '1931-07-04']],
  ['25/12/1931', 'E_DATE_UNPARSEABLE', {}, ['1931-12-25']],
  ['Spring-ish 1850', 'E_DATE_UNPARSEABLE', {}, ['spring 1850', 'c. 1850']],
  ['sometime', 'E_DATE_UNPARSEABLE'],
  ['yesterday', 'E_DATE_UNPARSEABLE'],
  ['12000', 'E_DATE_UNPARSEABLE'],
  ['1995s', 'E_DATE_UNPARSEABLE'],
  ['the 1995s', 'E_DATE_UNPARSEABLE'],
];

test(`date grammar: ${OK.length} accepted forms`, () => {
  for (const [raw, rule, precision, basis, [lo, hi], extra = {}] of OK) {
    const p = parseDate(raw, { now: NOW, ...(extra.opts ?? {}) });
    assert.ok(!p.issue, `${raw}: unexpected issue ${JSON.stringify(p.issue)}`);
    assert.equal(p.rule, rule, `${raw}: rule`);
    assert.equal(p.precision, precision, `${raw}: precision`);
    assert.equal(p.basis, basis, `${raw}: basis`);
    assert.deepEqual([p.lo_day, p.hi_day], [lo, hi], `${raw}: interval ${JSON.stringify(ymdFromDay(p.lo_day))}…${JSON.stringify(ymdFromDay(p.hi_day))}`);
    assert.equal(p.lo_year, ymdFromDay(lo).y, `${raw}: lo_year`);
    assert.equal(p.hi_year, ymdFromDay(hi).y, `${raw}: hi_year`);
    assert.equal(p.approx, extra.approx ?? 0, `${raw}: approx`);
    assert.deepEqual(p.warnings, extra.warnings ?? [], `${raw}: warnings`);
    assert.equal(p.raw, String(raw));
    if (extra.label) assert.equal(p.label, extra.label, `${raw}: label`);
    assert.equal(p.label, formatDateLabel(p), `${raw}: label is formatDateLabel(p)`);
    assert.deepEqual(check('DateParse', p), [], `${raw}: DateParse shape`);
  }
});

test(`date grammar: ${UNKNOWN.length} unknown forms and zero_is_unknown`, () => {
  for (const raw of UNKNOWN) {
    const p = parseDate(raw, { now: NOW });
    assert.equal(p.rule, 'unknown', String(raw));
    assert.deepEqual([p.lo_day, p.hi_day, p.lo_year, p.hi_year], [null, null, null, null]);
    assert.equal(p.precision, 'unknown');
    assert.equal(p.basis, 'unknown');
    assert.equal(p.label, 'undated');
    assert.deepEqual(check('DateParse', p), []);
  }
  for (const raw of ['0', 0, '0000']) assert.equal(parseDate(raw, { zeroIsUnknown: true }).rule, 'unknown', String(raw));
});

test(`date grammar: ${ISSUES.length} rejected forms carry a code, message and suggestions`, () => {
  for (const [raw, code, opts = {}, include = []] of ISSUES) {
    const r = parseDate(raw, { now: NOW, ...opts });
    assert.ok(r.issue, `${raw}: expected ${code}, got ${JSON.stringify(r)}`);
    assert.equal(r.issue.code, code, `${raw}: code`);
    assert.ok(r.issue.message.length > 10, `${raw}: message`);
    assert.ok(Array.isArray(r.issue.suggestions) && r.issue.suggestions.length <= 3, `${raw}: ≤ 3 suggestions`);
    for (const s of include) assert.ok(r.issue.suggestions.includes(s), `${raw}: suggests ${s} (got ${r.issue.suggestions})`);
    for (const s of r.issue.suggestions) {
      if (/^\d{4}-\d{2}\/\d{4}-\d{2}$/.test(s)) continue;   // month spans for winter are hints, not a single date
      assert.ok(!parseDate(s, { now: NOW }).issue, `${raw}: suggestion '${s}' must itself parse`);
    }
  }
});

test('total grammar cases ≥ 90', () => {
  assert.ok(OK.length + UNKNOWN.length + ISSUES.length >= 90, `${OK.length + UNKNOWN.length + ISSUES.length} cases`);
});

test('dayFromYMD: matches an independent civil-day algorithm, years 0–99 included (never Date.UTC)', () => {
  assert.equal(dayFromYMD(1970, 1, 1), 0);
  assert.equal(dayFromYMD(2026, 10, 3), 20729);
  assert.equal(dayFromYMD(1994, 5, 17), 8902);
  assert.equal(dayFromYMD(1996, 12, 31), 9861);
  assert.equal(dayFromYMD(1, 1, 1), -719162);
  assert.equal(dayFromYMD(99, 12, 31), -683004);
  for (let y = 0; y <= 99; y++) {
    for (const [m, d] of [[1, 1], [2, 28], [3, 1], [12, 31]]) assert.equal(dayFromYMD(y, m, d), civil(y, m, d), `${y}-${m}-${d}`);
    assert.notEqual(dayFromYMD(y, 1, 1), Math.floor(Date.UTC(y, 0, 1) / 86400000), `Date.UTC would shift year ${y}`);
  }
  for (const y of [-9999, -4499, -2499, -1999, -500, -499, -1, 0, 1, 4, 100, 400, 1600, 1700, 1800, 1900, 2000, 2100]) {
    for (let m = 1; m <= 12; m++) assert.equal(dayFromYMD(y, m, 1), civil(y, m, 1), `${y}-${m}-01`);
  }
  for (let y = -4499; y <= 2100; y += 37) assert.equal(dayFromYMD(y, 7, 15), civil(y, 7, 15), `${y}-07-15`);
  assert.equal(dayFromYMD(-4499), civil(-4499, 1, 1));
});

test('leap years, month lengths and ymdFromDay round-trips', () => {
  for (const [y, leap] of [[2000, true], [1900, false], [2024, true], [2026, false], [0, true], [-4, true], [-100, false], [-400, true], [1600, true]]) {
    assert.equal(isLeapYear(y), leap, String(y));
    assert.equal(daysInMonth(y, 2), leap ? 29 : 28, `Feb ${y}`);
  }
  assert.equal(dayFromYMD(2000, 3, 1) - dayFromYMD(2000, 2, 28), 2);
  assert.equal(dayFromYMD(1900, 3, 1) - dayFromYMD(1900, 2, 28), 1);
  for (let dd = civil(-4499, 1, 1); dd <= civil(2100, 12, 31); dd += 997) {
    const { y, m, d } = ymdFromDay(dd);
    assert.equal(dayFromYMD(y, m, d), dd);
  }
  assert.deepEqual(ymdFromDay(20729), { y: 2026, m: 10, d: 3 });
  assert.deepEqual(ymdFromDay(dayFromYMD(-499, 1, 1)), { y: -499, m: 1, d: 1 });
});

test('yearLabel is historical; formatDateLabel never places a year at 1 January', () => {
  assert.equal(yearLabel(-499), '500 BCE');
  assert.equal(yearLabel(0), '1 BCE');
  assert.equal(yearLabel(1), '1 CE');
  assert.equal(yearLabel(600), '600 CE');
  assert.equal(yearLabel(1931), '1931');
  assert.equal(formatDateLabel(fromInterval(1931, 1931, { basis: 'stated' })), '1931');
  assert.equal(formatDateLabel({ lo_day: null, precision: 'unknown' }), 'undated');
  assert.equal(formatDateLabel(fromInterval(1990, 1999, { basis: 'stated' })), '1990s');
  assert.equal(formatDateLabel(fromInterval(1800, 1899, { basis: 'stated' })), '19th century');
  assert.equal(formatDateLabel(fromInterval(-1999, -1000, { basis: 'stated' })), '2nd millennium BCE');
  assert.equal(formatDateLabel(fromInterval(-4499, -2499, { precision: 'period', basis: 'period' })), '4500–2500 BCE (period)');
  assert.equal(formatDateLabel(fromInterval(-50, 50, { precision: 'range', basis: 'stated' })), '51 BCE–50 CE');
  assert.equal(formatDateLabel(fromDayInterval(day('1931-04-07'), day('1931-05-09'), { precision: 'range' })), '7 Apr – 9 May 1931');
});

test('fromInterval and fromDayInterval build checked DateParse values', () => {
  const p = fromInterval(1900, 1933, { basis: 'stated', rule: 'century_part' });
  assert.equal(p.precision, 'range');
  assert.equal(p.label, 'early 20th century');
  assert.deepEqual([p.lo_day, p.hi_day], Y(1900, 1933));
  assert.equal(fromInterval(1931, 1931, { basis: 'stated' }).precision, 'year');
  assert.equal(fromInterval(1990, 1999, { basis: 'stated' }).precision, 'decade');
  assert.throws(() => fromInterval(1999, 1990, { basis: 'stated' }), RangeError);
  assert.throws(() => fromInterval(1.5, 1990, { basis: 'stated' }), RangeError);
  assert.equal(fromDayInterval(8902, 8902, { precision: 'day' }).label, '17 May 1994');
  assert.throws(() => fromDayInterval(9, 8, { precision: 'day' }), RangeError);
});

test('LEVELS, binOf, fits (fit-or-wash) and tierForPpy', () => {
  assert.deepEqual(LEVELS.map((l) => l.name), ['millennium', 'century', 'decade', 'year', 'month', 'day']);
  assert.deepEqual(LEVELS.slice(0, 4).map((l) => l.width), [1000, 100, 10, 1]);
  assert.equal(binOf(1994, 2), 199);
  assert.equal(binOf(-499, 1), -5);
  assert.equal(binOf(-1, 3), -1);
  assert.equal(binOf(1999, 0), 1);
  // a decade-precision document fits its decade bin, not a year bin; a circa range fits neither decade nor year
  assert.equal(fits(1990, 1999, 2), true);
  assert.equal(fits(1990, 1999, 3), false);
  assert.equal(fits(1889, 1899, 2), false);
  assert.equal(fits(1889, 1899, 1), true);
  assert.equal(fits(1900, 1933, 1), true);
  assert.equal(fits(1930, 1931, 2), true);
  assert.equal(fits(1929, 1930, 2), false);
  assert.equal(fits(-510, -501, 2), true);
  assert.equal(fits(-509, -500, 2), false);
  assert.throws(() => binOf(1994, 4), RangeError);
  assert.equal(fitsDays(day('1963-06-01'), day('1963-06-30'), 4), true);
  assert.equal(fitsDays(day('1963-06-01'), day('1963-07-01'), 4), false);
  assert.equal(fitsDays(8902, 8902, 5), true);
  const tiers = [[0.05, 'L0'], [0.079, 'L0'], [0.08, 'L1'], [0.79, 'L1'], [0.8, 'L2'], [7.99, 'L2'], [8, 'L3'], [95, 'L3'],
    [96, 'L4'], [2921, 'L4'], [2922, 'L5'], [14610, 'L5']];
  for (const [ppy, t] of tiers) assert.equal(tierForPpy(ppy), t, String(ppy));
});

test('mini fixture dates parse exactly as tests/fixtures/mini/expected.json lists them', () => {
  const exp = JSON.parse(readFileSync(new URL('./fixtures/mini/expected.json', import.meta.url), 'utf8'));
  const now = new Date(`${exp.generated_with.now}T00:00:00Z`);
  assert.equal(exp.documents.length, 12);
  for (const d of exp.documents) {
    const c = d.chronology;
    const p = parseDate(c.raw, { now });
    for (const k of ['rule', 'precision', 'basis', 'approx', 'lo_day', 'hi_day', 'lo_year', 'hi_year', 'label']) {
      assert.deepEqual(p[k], c[k], `${d.ext_id} ${k}`);
    }
    const status = p.precision === 'unknown' ? 'undated' : p.basis === 'announced' ? 'scheduled' : 'dated';
    assert.equal(status, c.chrono_status, d.ext_id);
  }
  const statuses = exp.documents.map((d) => d.chronology.chrono_status);
  assert.equal(statuses.filter((s) => s === 'undated').length, 1);
  assert.equal(statuses.filter((s) => s === 'scheduled').length, 1);
  assert.deepEqual([...new Set(exp.documents.map((d) => d.lang))].sort(), ['en', 'es', 'fr', 'gu', 'hi']);
});

test('the 1st century CE starts at 1 CE and never overlaps the 1st century BCE (fix pass, §13 rule 18)', () => {
  const ce = parseDate('1st century'), bce = parseDate('1st century BCE');
  assert.deepEqual([ce.lo_year, ce.hi_year, ce.label, ce.precision], [1, 99, '1st century', 'century']);
  assert.deepEqual([bce.lo_year, bce.hi_year], [-99, 0]);
  assert.ok(ce.lo_year > bce.hi_year, 'astronomical year 0 (1 BCE) is only in the 1st century BCE');
  const c19 = parseDate('19th century');
  assert.deepEqual([c19.lo_year, c19.hi_year], [1800, 1899], 'Appendix A: modern centuries keep 1800–1899');
});
