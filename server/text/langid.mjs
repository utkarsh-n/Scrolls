// OWNER: WP0 — language identification per passage and per document (SPEC §4.3, §5.6)
//
// Script first: Gujarati → gu; Devanagari → hi (or the declared sa/mr; confidence 0.6 when undeclared).
// Latin script: stop-word profiles (first 60 words of server/text/stopwords/<lang>.json) for
// en/fr/es/de/la/it/pt; a language wins when its hits per token are ≥ 0.15 and ≥ 1.5 × the runner-up
// over ≥ 8 tokens, else 'und'; Latin texts under 8 tokens are 'und-Latn'. Confidences are heuristic
// scores in [0, 1], not probabilities.

import { readFileSync } from 'node:fs';
import { tokenize } from '../../src/shared/tokenize.mjs';

/** Languages with a Latin-script stop-word profile. */
export const PROFILE_LANGS = Object.freeze(['en', 'fr', 'es', 'de', 'la', 'it', 'pt']);
/** Every stop-word list on disk. */
export const STOPWORD_LANGS = Object.freeze([...PROFILE_LANGS, 'hi', 'gu']);

const MIN_TOKENS = 8;
const MIN_SCORE = 0.15;
const MIN_RATIO = 1.5;
const TRANSLATION_SHARE = 0.7;
const TRANSLATION_CONFIDENCE = 0.6;
/**
 * Fewest identified tokens behind a translation claim (fix pass, §13 rule 1): a title of a few words is no evidence of a
 * document's language — three Gujarati Wikisource titles written in Devanagari ("Akabar Charitra") read as Hindi.
 */
export const TRANSLATION_MIN_TOKENS = 20;

const lists = new Map();

/**
 * The folded stop-word list of a language (all words, most frequent first).
 * @param {string} lang
 * @returns {string[]}
 */
export function stopwords(lang) {
  if (!lists.has(lang)) {
    const file = new URL(`./stopwords/${lang}.json`, import.meta.url);
    lists.set(lang, Object.freeze(JSON.parse(readFileSync(file, 'utf8')).words));
  }
  return lists.get(lang);
}

let profiles = null;
/** word → languages whose 60-word profile contains it */
function profileIndex() {
  if (profiles) return profiles;
  profiles = new Map();
  for (const lang of PROFILE_LANGS) {
    for (const w of stopwords(lang).slice(0, 60)) {
      if (!profiles.has(w)) profiles.set(w, []);
      profiles.get(w).push(lang);
    }
  }
  return profiles;
}

const LETTER = /\p{L}/u;

/** Script of one code point by block (fast path for the scripts we identify); null for non-letters. */
function scriptOfCode(c, ch) {
  if (c < 0x80) return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ? 'Latn' : null;
  if ((c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7) || (c >= 0x1e00 && c <= 0x1eff)) return 'Latn';
  if (c >= 0x0900 && c <= 0x097f) return c >= 0x0964 && c <= 0x096f ? null : 'Deva'; // dandas and digits are not letters
  if (c >= 0x0a80 && c <= 0x0aff) return c >= 0x0ae6 && c <= 0x0aef ? null : 'Gujr';
  return LETTER.test(ch) ? 'Other' : null;
}

/**
 * The dominant script among the letters of a text (Devanagari/Gujarati vowel signs count with their
 * script). A script needs more than half of the letters, else 'Other'.
 * @param {string} text
 * @returns {'Latn'|'Deva'|'Gujr'|'Other'}
 */
export function scriptOf(text) {
  const counts = { Latn: 0, Deva: 0, Gujr: 0, Other: 0 };
  let letters = 0;
  for (const ch of text) {
    const sc = scriptOfCode(ch.codePointAt(0), ch);
    if (!sc) continue;
    letters++;
    counts[sc]++;
  }
  if (letters === 0) return 'Other';
  let best = 'Other';
  for (const k of ['Latn', 'Deva', 'Gujr', 'Other']) if (counts[k] > counts[best]) best = k;
  return counts[best] * 2 > letters ? best : 'Other';
}

/**
 * Stop-word scores (hits per token) of folded tokens against the Latin-script profiles.
 * @param {string[]} tokens folded tokens
 * @returns {Record<string, number>}
 */
export function profileScores(tokens) {
  const idx = profileIndex();
  const hits = Object.fromEntries(PROFILE_LANGS.map((l) => [l, 0]));
  for (const t of tokens) for (const l of idx.get(t) ?? []) hits[l]++;
  const n = tokens.length || 1;
  return Object.fromEntries(PROFILE_LANGS.map((l) => [l, Math.round((hits[l] / n) * 1000) / 1000]));
}

/**
 * Language of already-tokenized text (the writer tokenizes once and reuses the tokens).
 * @param {string[]} tokens folded tokens
 * @param {{declared?: string|null, script: 'Latn'|'Deva'|'Gujr'|'Other'}} opts
 * @returns {{lang: string, confidence: number, scores: Record<string, number>}}
 */
export function detectLangFromTokens(tokens, { declared = null, script }) {
  const decl = declared ? String(declared).toLowerCase() : null;
  if (script === 'Gujr') return { lang: 'gu', confidence: decl === 'gu' ? 0.95 : 0.9, scores: {} };
  if (script === 'Deva') {
    if (decl === 'sa' || decl === 'mr') return { lang: decl, confidence: 0.8, scores: {} };
    return { lang: 'hi', confidence: decl === 'hi' ? 0.9 : 0.6, scores: {} };
  }
  if (script !== 'Latn') return { lang: 'und', confidence: 0, scores: {} };
  const scores = profileScores(tokens);
  if (tokens.length < MIN_TOKENS) return { lang: 'und-Latn', confidence: 0, scores };
  const ranked = PROFILE_LANGS.map((l) => [l, scores[l]]).sort((a, b) => b[1] - a[1]);
  const [[best, s1], [, s2]] = ranked;
  if (s1 < MIN_SCORE || s1 < MIN_RATIO * s2) return { lang: 'und', confidence: 0, scores };
  // separation from the runner-up, discounted for short texts
  const separation = 1 - s2 / s1;
  const length = Math.min(1, 0.7 + tokens.length / 100);
  const confidence = Math.round(Math.min(0.99, (0.5 + 0.5 * separation) * length) * 100) / 100;
  return { lang: best, confidence, scores };
}

/**
 * Detect the language of a passage.
 * @param {string} text
 * @param {{declared?: string|null}} [opts]
 * @returns {{lang: string, confidence: number, scores: Record<string, number>}}
 */
export function detectLang(text, { declared = null } = {}) {
  return detectLangFromTokens(tokenize(text).tokens, { declared, script: scriptOf(text) });
}

const isUnd = (lang) => !lang || lang === 'und' || lang.startsWith('und-');
const primary = (lang) => String(lang ?? '').toLowerCase().split('-')[0];

/**
 * Document language = token-weighted majority of its passages' languages (§5.6).
 * `is_translation` when a declared language differs from that majority, the majority covers ≥ 70% of the
 * tokens and its confidence is ≥ 0.6 (W_LANG_MISMATCH).
 * @param {Array<{lang: string, tokens: number, confidence: number}>} passages
 * @param {string|null} declared
 * @returns {{lang_text: string, confidence: number, is_translation: boolean, share: number,
 *   by_lang: Record<string, number>}}
 */
export function documentLang(passages, declared) {
  const byLang = {};
  const confSum = {};
  let total = 0;
  for (const p of passages) {
    const n = Math.max(0, p.tokens | 0);
    if (!n) continue;
    total += n;
    byLang[p.lang] = (byLang[p.lang] ?? 0) + n;
    confSum[p.lang] = (confSum[p.lang] ?? 0) + n * (p.confidence ?? 0);
  }
  if (total === 0) return { lang_text: 'und', confidence: 0, is_translation: false, share: 0, by_lang: {} };
  const ranked = Object.entries(byLang).sort((a, b) => b[1] - a[1]);
  const detected = ranked.filter(([l]) => !isUnd(l));
  const [lang, n] = detected.length ? detected[0] : ranked[0];
  const share = n / total;
  const confidence = isUnd(lang) ? 0 : Math.round((confSum[lang] / n) * 100) / 100;
  const is_translation = Boolean(declared) && !isUnd(lang) && primary(declared) !== primary(lang) &&
    share >= TRANSLATION_SHARE && confidence >= TRANSLATION_CONFIDENCE && n >= TRANSLATION_MIN_TOKENS;
  const by_lang = Object.fromEntries(ranked.map(([l, c]) => [l, Math.round((c / total) * 1000) / 1000]));
  return { lang_text: lang, confidence, is_translation, share: Math.round(share * 1000) / 1000, by_lang };
}
