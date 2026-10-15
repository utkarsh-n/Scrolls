// OWNER: WP3
// names.mjs — the proper-noun guard (SPEC §4.5): name-shaped matches are excluded from counts by default and
// listed as "excluded as names (n)", each with its own override.
//
// A single-token match is flagged when
//  (a) body text (any passage that is not a title): the original token is capitalized, not sentence-initial, and
//      the next or previous token is capitalized and not a stop-word ("for Gene Halloran" → flagged;
//      "The selfish gene" → counted);
//  (b) body text: the token occurs in the document's author/maker field and is written as a name there and here
//      (capitalized, or in a caseless script such as Devanagari or Gujarati);
//  (a') body text (fix pass): the capitalized token starts with an elision apostrophe ("If 'Gene heard", "'Gene's
//      mother" — a clipped first name), outside sentence-initial position;
//  (c) title passages: the matched token lies inside a span of the title that EXACTLY equals a known maker name of
//      ≥ 2 tokens and is shorter than the whole title ("Gene Kelly Live" → flagged), or the whole title is its own
//      work's maker name (a self-titled work: "Madonna" by Madonna). Titles are title-cased, so capitalization alone
//      is never evidence of a name (M1 gate, lead decision): "Zero Dark Thirty", "Ground Zero", "Zero Hour" and
//      "Below Zero" are counted unless a span equals a maker's name. A whole title that merely equals SOME maker's
//      name is the word itself (fix pass: the film "Virus" (1999) is not the Argentine band Virus; "Love Affair" is
//      not the band Love Affair). Known names are the makers of the counted (rate-eligible) collections:
//      relation-endpoint collections (MusicBrainz artist credits — mostly band names made of ordinary words such as
//      "Ground Zero") are not name evidence.
//  (d) document consistency (fix pass; applied by the materializer over a whole document, see documentNameRule): in a
//      document whose body text never writes the word in lower case and where at least NAME_RECURRENCE_MIN of its
//      occurrences are flagged by (a), (a') or (b), every capitalized occurrence is the name — sentence-initial ones
//      included ("'Gene was off working", 44 of them in The Brimming Cup), since capitalization there says nothing.
// Phrases are never flagged: the guard protects single words from personal names. A possessive variant ("Gene's" =
// gene + s) is a single word with its clitic: it is guarded like the word.

import { isSentenceInitial, tokenize } from '../../src/shared/tokenize.mjs';
import { STOPWORD_LANGS, stopwords } from './langid.mjs';

/** Flagged occurrences a document needs before rule (d) treats the word as a name throughout it. */
export const NAME_RECURRENCE_MIN = 3;

/**
 * Rule (d): whether every capitalized occurrence of the word in a document's body text is a name.
 * @param {{flagged: number, lower: number, capitalized: number}} d the document's body-text occurrences: flagged by
 *   (a)/(a')/(b), written in lower case (or a caseless script), and capitalized but not flagged
 * @returns {boolean}
 */
export function documentNameRule(d) {
  return d.flagged >= NAME_RECURRENCE_MIN && d.lower === 0 && d.capitalized > 0;
}

/** Longest maker name (in tokens) the title rule looks for. */
export const MAX_NAME_TOKENS = 8;

let allStops = null;
/** Every stop-word of every language on disk (folded). */
function stopSet() {
  if (!allStops) {
    allStops = new Set();
    for (const l of STOPWORD_LANGS) for (const w of stopwords(l)) allStops.add(w);
  }
  return allStops;
}

const CAP_RE = /^[\p{Lu}\p{Lt}]/u;
const CASED_RE = /[\p{Lu}\p{Ll}\p{Lt}]/u;

/** Whether the original token starts with an upper-case (or title-case) letter. */
export function isCapitalized(raw) {
  return CAP_RE.test(raw);
}

/** Whether a token is written in a script without letter case (Devanagari, Gujarati, …). */
export function isCaseless(raw) {
  return /\p{L}/u.test(raw) && !CASED_RE.test(raw);
}

/**
 * Folded word set of an author/maker string ("Gene Kelly (synthetic)" → {gene, kelly, synthetic}).
 * @param {string|null|undefined} author
 * @returns {Set<string>}
 */
export function authorTokens(author) {
  return new Set(author ? tokenize(String(author)).tokens : []);
}

/**
 * The individual names in a maker string: the string without parenthetical notes ("(synthetic)", "(rev.)"), and,
 * when it is a comma or semicolon list whose every item has ≥ 2 words, each item ("Peter Thiel, Blake Masters").
 * A list with a one-word item ("Earth, Wind & Fire") stays whole, so its words never become names on their own.
 * @param {string} raw
 * @returns {string[]}
 */
export function splitMakerNames(raw) {
  const s = String(raw ?? '').replace(/\s*\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const parts = s.split(/\s*[;,]\s*/).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => tokenize(p).tokens.length >= 2)) return [s, ...parts];
  return [s];
}

/**
 * Index of known maker names for the title rule: folded token sequences joined by single spaces.
 * @param {Iterable<string>} names raw maker strings (author fields, maker tags)
 * @returns {{set: Set<string>, maxTokens: number}}
 */
export function nameIndex(names) {
  const set = new Set();
  let maxTokens = 1;
  for (const raw of names) {
    for (const name of splitMakerNames(raw)) {
      const toks = tokenize(name).tokens;
      if (!toks.length || toks.length > MAX_NAME_TOKENS || !toks.some((t) => /\p{L}/u.test(t))) continue;
      set.add(toks.join(' '));
      if (toks.length > maxTokens) maxTokens = toks.length;
    }
  }
  return { set, maxTokens };
}

/**
 * Title rule (c): the matched token i lies inside a span of the title that exactly equals a known maker name of ≥ 2
 * tokens, written as a name (first and last word capitalized, caseless or a numeral), shorter than the whole title; or
 * the whole title is the work's own maker name (self-titled).
 * @param {{tokens: string[], starts: Int32Array, ends: Int32Array}} t tokens of the passage text
 * @param {number} i index of the matched token
 * @param {string} original
 * @param {{set: Set<string>, maxTokens: number}|null} names
 * @param {number} lo first token index inside the passage clip
 * @param {number} hi last token index inside the passage clip
 * @param {Set<string>} authors folded words of the work's own author/maker field
 * @returns {boolean}
 */
function titleNameFlag(t, i, original, names, lo, hi, authors) {
  // written as a name: capitalized, caseless (Devanagari, Gujarati) or without letters ("Zero 7")
  const asName = (k) => {
    const raw = original.slice(t.starts[k], t.ends[k]);
    return isCapitalized(raw) || isCaseless(raw) || !/\p{L}/u.test(raw);
  };
  // the whole title is its own maker's name: a self-titled work ("Madonna" by Madonna)
  const whole = t.tokens.slice(lo, hi + 1);
  if (authors.size && whole.every((w) => authors.has(w)) && asName(lo) && asName(hi)) return true;
  if (!names?.set?.size) return false;
  // a span shorter than the title that is some maker's full name ("Gene Kelly Live"); a title that IS a maker's name
  // but not its own maker's is the word itself (the film "Virus", not the band Virus)
  const longest = Math.min(names.maxTokens, hi - lo);
  for (let len = 2; len <= longest; len++) {
    for (let a = Math.max(lo, i - len + 1); a <= Math.min(i, hi - len + 1); a++) {
      if (names.set.has(t.tokens.slice(a, a + len).join(' ')) && asName(a) && asName(a + len - 1)) return true;
    }
  }
  return false;
}

const ELISION = new Set(["'", '\u2019', '\u02BC']);

/** Whether the token at [start, end) begins with an elision apostrophe ("'Gene", "’Gene's") rather than a quotation. */
function elided(original, start, end) {
  if (!ELISION.has(original[start - 1])) return false;
  const before = original[start - 2];
  if (before !== undefined && /[\p{L}\p{N}]/u.test(before)) return false;          // o'Gene, d'Artagnan: inside a word
  // a quotation closes after the word, perhaps after its punctuation ('Gene', 'Gene,'); an elided name runs on
  // ("'Gene heard", "'Gene's")
  let k = end;
  while (k < original.length && /[.,;:!?]/u.test(original[k])) k++;
  return !(ELISION.has(original[k]) && !/\p{L}/u.test(original[k + 1] ?? ''));
}

/**
 * True when the single-token match at [start, end) of `original` is name-shaped per §4.5.
 * @param {string} original the passage text (or any text containing the match)
 * @param {number} start UTF-16 offset of the match in `original`
 * @param {number} end
 * @param {{author?: string|null, authorSet?: Set<string>|null, fieldClass?: string, clipStart?: number,
 *   clipEnd?: number, names?: {set: Set<string>, maxTokens: number}|null,
 *   tok?: {tokens: string[], starts: Int32Array, ends: Int32Array}|null}} [opts]
 *   `names` = nameIndex() of the corpus's makers (title rule); `tok` = tokenize(original) when the caller already has
 *   it; neighbours and title spans are looked up inside [clipStart, clipEnd)
 * @returns {boolean}
 */
export function nameFlag(original, start, end, { author = null, authorSet = null, fieldClass = 'text', clipStart = 0,
  clipEnd = original.length, names = null, tok = null } = {}) {
  const t = tok ?? tokenize(original);
  let i = -1;
  for (let k = 0; k < t.starts.length; k++) if (t.starts[k] === start) { i = k; break; }
  if (i < 0) return false;
  if (t.ends[i] !== end) return false;            // a phrase match: never flagged

  const authors = authorSet ?? authorTokens(author);
  if (fieldClass === 'title') {
    let lo = i, hi = i;
    while (lo > 0 && t.starts[lo - 1] >= clipStart) lo--;
    while (hi < t.tokens.length - 1 && t.ends[hi + 1] <= clipEnd) hi++;
    return titleNameFlag(t, i, original, names, lo, hi, authors);
  }

  const raw = original.slice(start, end);
  const folded = t.tokens[i];
  const caseless = isCaseless(raw);
  const cap = isCapitalized(raw);

  // (b) the token is part of the document's author/maker name
  if ((cap || caseless) && authors.has(folded)) return true;
  if (caseless || !cap) return false;
  // (a') a clipped first name written with an elision apostrophe ("If 'Gene heard")
  if (elided(original, start, end) && !isSentenceInitial(original, start - 1)) return true;

  const stops = stopSet();
  const neighbour = (k) => {
    if (k < 0 || k >= t.tokens.length || t.starts[k] < clipStart || t.ends[k] > clipEnd) return null;
    return { raw: original.slice(t.starts[k], t.ends[k]), folded: t.tokens[k], start: t.starts[k] };
  };
  const prev = neighbour(i - 1), next = neighbour(i + 1);

  // (a) capitalized mid-sentence next to another capitalized non-stop-word
  if (isSentenceInitial(original, start)) return false;
  const capWord = (n) => n && isCapitalized(n.raw) && !stops.has(n.folded);
  // the next word must belong to the same sentence ("I met Gene. Kelly left" says nothing about "Gene")
  return Boolean(capWord(prev) || (capWord(next) && !isSentenceInitial(original, next.start)));
}
