// OWNER: WP5
// cues.mjs — attribution cues (SPEC §4.7) in en, fr, es, hi and gu within ±30 tokens of a span. A cue is
// evidence that a text *names* a source; which document that name refers to is inferred. So a cue never makes a
// link documented: it yields an explicit_citation that is 'proposed', with a 'citation_cue' evidence row (CUE),
// and only a person can confirm it (D7, §13 rule 6).

import { tokenize } from '../../src/shared/tokenize.mjs';

/** Cue window around a span, in tokens. */
export const CUE_WINDOW = 30;

const NAME = String.raw`(\p{Lu}[\p{L}\p{M}'’.\-]*(?:\s+(?:(?:de|del|la|le|van|von|da|di)\s+)?\p{Lu}[\p{L}\p{M}'’.\-]*){0,2})`;
const DEVA_NAME = String.raw`((?:[\p{Script=Devanagari}\p{M}]+\s+){0,2}[\p{Script=Devanagari}\p{M}]+)`;
const GUJR_NAME = String.raw`((?:[\p{Script=Gujarati}\p{M}]+\s+){0,2}[\p{Script=Gujarati}\p{M}]+)`;

/** Cue patterns per language: `label` names the pattern on the card ("as <Name> put it"). */
export const CUE_PATTERNS = Object.freeze({
  en: [
    { label: 'as <Name> said/wrote/put it/observed', re: new RegExp(String.raw`\b[Aa]s\s+${NAME}\s+(?:said|wrote|put it|observed)\b`, 'gu') },
    { label: "in <Name>'s words", re: new RegExp(String.raw`\b[Ii]n\s+${NAME}['’]s\s+words\b`, 'gu') },
    { label: "<Name>'s phrase/line", re: new RegExp(String.raw`${NAME}['’]s\s+(?:phrase|line)\b`, 'gu') },
  ],
  fr: [
    { label: "comme (l'a) dit/écrit <Nom>", re: new RegExp(String.raw`\b[Cc]omme\s+(?:l['’]a\s+)?(?:dit|écrit)\s+${NAME}`, 'gu') },
    { label: 'selon <Nom>', re: new RegExp(String.raw`\b[Ss]elon\s+${NAME}`, 'gu') },
  ],
  es: [
    { label: 'como dijo/escribió <Nombre>', re: new RegExp(String.raw`\b[Cc]omo\s+(?:dijo|escribió)\s+${NAME}`, 'gu') },
    { label: 'según <Nombre>', re: new RegExp(String.raw`(?<![\p{L}\p{M}])[Ss]egún\s+${NAME}`, 'gu') },
  ],
  hi: [
    { label: '<नाम> ने कहा', re: new RegExp(String.raw`${DEVA_NAME}\s+ने\s+कहा`, 'gu') },
    { label: '<नाम> के शब्दों में', re: new RegExp(String.raw`${DEVA_NAME}\s+के\s+शब्दों\s+में`, 'gu') },
  ],
  gu: [
    { label: '<નામ> એ કહ્યું', re: new RegExp(String.raw`${GUJR_NAME}\s*એ\s+કહ્યું`, 'gu') },
    { label: '<નામ> ના શબ્દોમાં', re: new RegExp(String.raw`${GUJR_NAME}\s+ના\s+શબ્દોમાં`, 'gu') },
  ],
});

const QUOTE_PAIRS = [['“', '”'], ['"', '"'], ['«', '»'], ['‘', '’'], ['„', '“'], ["'", "'"]];

/**
 * Every attribution cue in a text.
 * @param {string} text
 * @param {{lang?: string|null}} [opts] a language code limits the patterns; null tries all five languages
 * @returns {Array<{start: number, end: number, quote: string, name: string, pattern: string, lang: string}>}
 */
export function allCues(text, { lang = null } = {}) {
  const langs = lang && CUE_PATTERNS[lang] ? [lang] : Object.keys(CUE_PATTERNS);
  const out = [];
  for (const l of langs) {
    for (const p of CUE_PATTERNS[l]) {
      p.re.lastIndex = 0;
      for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
        out.push({ start: m.index, end: m.index + m[0].length, quote: m[0], name: m[1].trim(), pattern: p.label, lang: l });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Cue matches near [start, end): attribution cues whose words lie within ±30 tokens of the span, plus a
 * 'quotation marks' cue (name null) when the span is enclosed in quotation marks.
 * @param {string} text
 * @param {number} start UTF-16 offset of the span in `text`
 * @param {number} end
 * @param {{lang?: string|null, window?: number}} [opts]
 * @returns {Array<{start: number, end: number, quote: string, name: string|null, pattern: string, lang: string|null, distance: number}>}
 */
export function findCues(text, start, end, { lang = null, window = CUE_WINDOW } = {}) {
  const tok = tokenize(text);
  const tokenAt = (off) => {
    let lo = 0, hi = tok.starts.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (tok.starts[mid] < off) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const s0 = tokenAt(start), s1 = tokenAt(end);
  const out = [];
  for (const c of allCues(text, { lang })) {
    const c0 = tokenAt(c.start), c1 = tokenAt(c.end);
    const distance = c1 <= s0 ? s0 - c1 : c0 >= s1 ? c0 - s1 : 0;
    if (distance <= window) out.push({ ...c, distance });
  }
  // quotation marks may sit outside trailing punctuation: “Carry the zero,” …
  const before = text.slice(Math.max(0, start - 3), start).replace(/\s+$/u, '');
  const after = text.slice(end, end + 4).replace(/^[\s,.;:!?…]+/u, '');
  for (const [open, close] of QUOTE_PAIRS) {
    if (before.endsWith(open) && after.startsWith(close)) {
      const qs = text.lastIndexOf(open, start), qe = text.indexOf(close, end) + close.length;
      out.push({ start: qs, end: qe, quote: text.slice(qs, qe), name: null, pattern: 'quotation marks around the span',
        lang: null, distance: 0 });
      break;
    }
  }
  return out;
}

const NAME_STOP = new Set(['the', 'a', 'an', 'of', 'and', 'mr', 'mrs', 'ms', 'dr', 'miss', 'sir', 'old', 'de', 'la', 'le', 'el', 'del', 'van', 'von', 's']);
/** Pronouns and other words a cue pattern can capture that never name a source ("as I said", "as He wrote"). */
const NOT_A_NAME = new Set(['i', 'he', 'she', 'it', 'we', 'they', 'you', 'one', 'someone', 'somebody', 'everybody', 'everyone', 'nobody',
  'god', 'lord', 'je', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'yo', 'él', 'ella', 'usted', 'nosotros', 'ellos', 'ellas']);
/** Share of a title's significant words a name must give to refer to it by title ("Ready Arithmetic" → "Brennock's Ready Arithmetic"). */
export const TITLE_COVER = 2 / 3;

/**
 * Significant words of a cue's name: folded, without articles, honorifics and particles; [] when the name is a
 * pronoun or another word that never names a source.
 * @param {string} name
 * @returns {string[]}
 */
export function nameWords(name) {
  const words = tokenize(String(name ?? '')).tokens;
  if (!words.length || words.every((w) => NOT_A_NAME.has(w) || NAME_STOP.has(w))) return [];
  return words.filter((t) => !NAME_STOP.has(t) && !NOT_A_NAME.has(t));
}

/**
 * Whether a cue's name can refer to a document: the author's surname (last word, "(synthetic)" and other
 * parentheticals dropped) is among the name's words; or the name gives the title — every word of the name is in the
 * title and the name covers ≥ 2/3 of the title's significant words (so a character's first name, "as Tom said",
 * does not cite *The History of Tom Jones*).
 * @param {string} name
 * @param {{author?: string|null, title?: string|null}} doc
 * @returns {boolean}
 */
export function nameMatches(name, { author = null, title = null } = {}) {
  const words = nameWords(name);
  if (!words.length) return false;
  const authorWords = tokenize(String(author ?? '').replace(/\([^)]*\)/g, ' ')).tokens;
  const surname = authorWords[authorWords.length - 1];
  if (surname && surname.length >= 2 && !NAME_STOP.has(surname) && words.includes(surname)) return true;
  const titleWords = [...new Set(tokenize(String(title ?? '').replace(/\([^)]*\)/g, ' ')).tokens.filter((t) => !NAME_STOP.has(t)))];
  if (!titleWords.length || !words.every((w) => titleWords.includes(w))) return false;
  return words.length >= TITLE_COVER * titleWords.length;
}
