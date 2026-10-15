// OWNER: WP0 — tokenizer u61m-1, the single source of truth for counts (SPEC §4.3, D4)
//
// A token is a single \p{So} character, or a maximal run of [\p{L}\p{M}\p{N}\p{Co}] found over the ORIGINAL
// string with [start, end) UTF-16 offsets. Three precisions keep FTS token i equal to JS token i (FTS indexes
// normString(text) and only adds accent-insensitivity, remove_diacritics 2):
//  · zero-width joiners/non-joiners and soft hyphens INSIDE a run do not split it — fold removes them, and
//    SQLite would split there (Devanagari/Gujarati conjuncts written with ZWJ/ZWNJ stay one word);
//  · combining marks right after a symbol stay with it ('❤' + U+FE0F is one token, not a symbol plus a
//    lone variation selector); SQLite also keeps them together;
//  · U+166D (CANADIAN SYLLABICS CHI SIGN) is \p{So} for ICU but not a token character for SQLite's
//    unicode61 tables — the only such code point (verified over all of Unicode on SQLite 3.53.4) — so it
//    is not a token.

export const TOKENIZER_VERSION = 'u61m-1';
export const FTS_TOKENIZE = "unicode61 remove_diacritics 2 categories 'L* N* Co M* So'";

const TOKEN_RE = /(?:(?!᙭)\p{So})\p{M}*|[\p{L}\p{M}\p{N}\p{Co}]+(?:[‌‍­]+[\p{L}\p{M}\p{N}\p{Co}]+)*/gu;
const ASCII_RE = /^[\x00-\x7F]*$/;
const INDIC_DIGIT_RE = /[०-९૦-૯]/g;
const INVISIBLE_RE = /[‌‍­]/g;

/**
 * Fold one token: NFC → toLowerCase() (locale-independent) → Devanagari/Gujarati digits → ASCII →
 * remove U+200C, U+200D, U+00AD. Accents are kept (analysis is accent-sensitive; FTS is not).
 * @param {string} raw
 * @returns {string}
 */
export function foldToken(raw) {
  if (ASCII_RE.test(raw)) return raw.toLowerCase();
  return raw.normalize('NFC').toLowerCase()
    .replace(INDIC_DIGIT_RE, (c) => {
      const cp = c.charCodeAt(0);
      return String.fromCharCode(48 + cp - (cp >= 0x0AE6 ? 0x0AE6 : 0x0966));
    })
    .replace(INVISIBLE_RE, '');
}

/**
 * Tokenize the original text. Offsets are UTF-16 code units into `text` (D4); tokens are folded.
 * Invariant: foldToken(text.slice(starts[i], ends[i])) === tokens[i].
 * @param {string} text
 * @returns {{tokens: string[], starts: Int32Array, ends: Int32Array}}
 */
export function tokenize(text) {
  const tokens = [], starts = [], ends = [];
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(text); m !== null; m = TOKEN_RE.exec(text)) {
    tokens.push(foldToken(m[0]));
    starts.push(m.index);
    ends.push(m.index + m[0].length);
  }
  return { tokens, starts: Int32Array.from(starts), ends: Int32Array.from(ends) };
}

/**
 * Folded tokens joined by single spaces — the string FTS indexes and expression norms are stored as.
 * @param {string} text
 * @returns {string}
 */
export function normString(text) {
  return tokenize(text).tokens.join(' ');
}

/**
 * Index of the first exact occurrence of the folded token sequence `seq` in `tokens` at or after `from`,
 * or -1. An empty sequence never matches.
 * @param {string[]} tokens
 * @param {string[]} seq
 * @param {number} [from=0]
 * @returns {number}
 */
export function findSequence(tokens, seq, from = 0) {
  const n = seq.length;
  if (n === 0) return -1;
  const first = seq[0];
  outer: for (let i = Math.max(0, from), last = tokens.length - n; i <= last; i++) {
    if (tokens[i] !== first) continue;
    for (let j = 1; j < n; j++) if (tokens[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * An FTS5 phrase query for a token sequence (or a raw string, tokenized first): `"carry the zero"`.
 * Tokens never contain a double quote, but one is escaped anyway.
 * @param {string[]|string} seq
 * @returns {string}
 */
export function ftsPhrase(seq) {
  const toks = typeof seq === 'string' ? tokenize(seq).tokens : seq;
  if (!toks.length) throw new RangeError('ftsPhrase: empty token sequence');
  return `"${toks.join(' ').replace(/"/g, '""')}"`;
}

// Sentence boundaries for the proper-noun guard (§4.5). A '.' after an initial or a common abbreviation
// does not end a sentence; a single newline (hard-wrapped prose) does not either, a blank line does.
const TERMINATORS = new Set(['.', '!', '?', '…', '।', '॥', '؟', '。', '！', '？']);
const SKIPPABLE = /[\s"'“”‘’«»„‚‹›()[\]{}¿¡*_—–-]/u;
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'sra', 'srta', 'prof', 'rev', 'gen', 'capt',
  'col', 'lt', 'sgt', 'mt', 'vs', 'cf', 'vol', 'fig', 'mme', 'mlle', 'dña', 'sta']);

/**
 * Whether the token starting at `start` begins a sentence: start of text, after a blank line or page
 * break, or after a sentence terminator (skipping quotes, brackets and spaces).
 * @param {string} text original text
 * @param {number} start UTF-16 offset of the token
 * @returns {boolean}
 */
export function isSentenceInitial(text, start) {
  let i = start - 1, newlines = 0;
  for (; i >= 0; i--) {
    const c = text[i];
    if (c === '\n') { if (++newlines >= 2) return true; continue; }
    if (c === '\f') return true;
    if (!SKIPPABLE.test(c)) break;
  }
  if (i < 0) return true;
  const c = text[i];
  if (!TERMINATORS.has(c)) return false;
  if (c !== '.') return true;
  // the word before the full stop: an initial ("J. R.") or an abbreviation ("Mr.") does not end a sentence
  let j = i - 1;
  while (j >= 0 && /[\p{L}\p{M}]/u.test(text[j])) j--;
  const word = text.slice(j + 1, i).toLowerCase();
  if (word.length === 1 && /\p{Lu}/u.test(text[j + 1])) return false;
  return !ABBREVIATIONS.has(word);
}
