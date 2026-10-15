// OWNER: WP3
// variants.mjs — generated variants of an expression (SPEC §4.5): en/fr/es inflection, hi oblique/plural, gu
// plural + attached postpositions, orthographic folds (Devanagari nukta, chandrabindu ↔ anusvara) and
// hyphenation. Every generated variant is evidence `computed`, carries its rule id and is shown with its own
// count and toggle. Pure functions over folded tokens (src/shared/tokenize.mjs); no database.
//
// Matching is by exact folded-token sequence, so a variant is only useful when its token sequence differs
// from the expression's. Apostrophes and hyphens split tokens: "hacker's" is the sequence ["hacker", "s"] and
// "cold-wire" equals "cold wire"; the possessive and the joined form ("coldwire") are therefore their own
// variants.

import { canonicalJson, shortHash } from '../../src/shared/ids.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';

/** Rule ids stored in expression_variant.rule. */
export const RULES = Object.freeze({
  identity: 'identity',
  en: 'en-inflect@1',
  fr: 'fr-inflect@1',
  es: 'es-inflect@1',
  frFem: 'fr-feminine@1',
  esFem: 'es-feminine@1',
  hi: 'hi-oblique@1',
  gu: 'gu-postposition@1',
  nukta: 'nukta-fold@1',
  candra: 'candrabindu-anusvara@1',
  hyphen: 'hyphen-join@1',
});

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const isVowel = (c) => VOWELS.has(c);
const LATIN_WORD = /^[\p{Script=Latin}]+$/u;

// ── scripts ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Script of a folded token sequence: the script of its letters ('Latn', 'Deva', 'Gujr'), 'Symbol' for a lone
 * symbol/number token, else 'Other'.
 * @param {string[]} tokens
 * @returns {'Latn'|'Deva'|'Gujr'|'Symbol'|'Other'}
 */
export function scriptOfTokens(tokens) {
  const text = tokens.join('');
  if (/[઀-૿]/u.test(text)) return 'Gujr';
  if (/[ऀ-ॿ]/u.test(text)) return 'Deva';
  if (/\p{Script=Latin}/u.test(text)) return 'Latn';
  if (tokens.length === 1 && /^[\p{So}\p{N}]/u.test(tokens[0])) return 'Symbol';
  return 'Other';
}

/**
 * Expression kind from its folded tokens: 'symbol' for a lone \p{So} token, 'word' for one token, else 'phrase'.
 * @param {string[]} tokens
 * @returns {'word'|'phrase'|'symbol'}
 */
export function kindOfTokens(tokens) {
  if (tokens.length === 1 && /^\p{So}/u.test(tokens[0])) return 'symbol';
  return tokens.length > 1 ? 'phrase' : 'word';
}

// ── English ─────────────────────────────────────────────────────────────────────────────────────────

/** Single-syllable consonant–vowel–consonant ending whose final consonant doubles (stop → stopped). */
function doublesFinal(w) {
  if (w.length < 3 || w.length > 5) return false;
  const last = w[w.length - 1], mid = w[w.length - 2], before = w[w.length - 3];
  if (isVowel(last) || 'wxy'.includes(last) || !isVowel(mid) || isVowel(before)) return false;
  let groups = 0, prev = false;
  for (const ch of w) { const v = isVowel(ch); if (v && !prev) groups++; prev = v; }
  return groups === 1;
}

const consonantY = (w) => w.length > 2 && w.endsWith('y') && !isVowel(w[w.length - 2]);
const sibilant = (w) => /(s|x|z|ch|sh)$/.test(w);

function enPlural(b) {
  if (consonantY(b)) return [`${b.slice(0, -1)}ies`];
  if (sibilant(b)) return [`${b}es`];
  if (b.length > 1 && b.endsWith('o') && !isVowel(b[b.length - 2])) return [`${b}s`, `${b}es`];   // zeros, zeroes
  return [`${b}s`];
}

function enPast(b) {
  if (b.endsWith('e')) return `${b}d`;
  if (consonantY(b)) return `${b.slice(0, -1)}ied`;
  if (doublesFinal(b)) return `${b}${b[b.length - 1]}ed`;
  return `${b}ed`;
}

function enIng(b) {
  if (b.endsWith('ie')) return `${b.slice(0, -2)}ying`;
  if (b.endsWith('e') && !/(ee|ye|oe)$/.test(b) && b.length > 2) return `${b.slice(0, -1)}ing`;
  if (doublesFinal(b)) return `${b}${b[b.length - 1]}ing`;
  return `${b}ing`;
}

function enAgent(b) {
  if (/(er|or)$/.test(b)) return [];
  if (b.endsWith('e')) return [`${b}r`, `${b}rs`];
  if (consonantY(b)) return [`${b.slice(0, -1)}ier`, `${b.slice(0, -1)}iers`];
  if (doublesFinal(b)) return [`${b}${b[b.length - 1]}er`, `${b}${b[b.length - 1]}ers`];
  return [`${b}er`, `${b}ers`];
}

/** Likely singular bases of an English word typed in the plural (hackers → hacker, viruses → virus). */
function enBases(w) {
  const bases = [w];
  if (w.length > 4 && w.endsWith('ies')) bases.push(`${w.slice(0, -3)}y`);
  else if (w.length > 4 && /(ses|xes|zes|ches|shes|oes)$/.test(w)) bases.push(w.slice(0, -2));
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) bases.push(w.slice(0, -1));
  return bases;
}

function enWordForms(w) {
  const out = [];
  const bases = enBases(w);
  // a word typed in the plural is inflected from its singular, never as if it were a stem ("hackersed")
  for (const b of bases.length > 1 ? bases.slice(1) : bases) {
    if (b !== w) out.push({ tokens: [b] });
    for (const p of enPlural(b)) out.push({ tokens: [p] });
    out.push({ tokens: [enPast(b)] }, { tokens: [enIng(b)] });
    // agent/comparative -er forms are usually another word (hack → hacker) or no word at all (gene → 'gener', which
    // matched "De Gener." abbreviations): generated, but off by default like the fr/es feminines (fix pass)
    for (const a of enAgent(b)) out.push({ tokens: [a], enabled: false });
    out.push({ tokens: [b, 's'] });   // possessive: "hacker's" tokenizes as hacker + s
  }
  return out.map((f) => ({ ...f, type: 'inflection', rule: RULES.en }));
}

const EN_PHRASE_NEXT = new Set(['the', 'a', 'an', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that', 'it',
  'me', 'him', 'them', 'us', 'on', 'off', 'up', 'out', 'in', 'to', 'over', 'away', 'back', 'down', 'with', 'for']);

/** A phrase whose head is followed by a function word reads as verb + object ("carry the zero"): inflect the head. */
function enPhraseForms(tokens) {
  const head = tokens[0];
  if (!LATIN_WORD.test(head) || head.length < 2 || /(ed|ing|s)$/.test(head) || !EN_PHRASE_NEXT.has(tokens[1])) return [];
  const rest = tokens.slice(1);
  const heads = [...enPlural(head).slice(0, 1), enPast(head), enIng(head)];
  return heads.map((h) => ({ tokens: [h, ...rest], type: 'inflection', rule: RULES.en }));
}

// ── French and Spanish ──────────────────────────────────────────────────────────────────────────────

function frWordForms(w) {
  const out = [];
  const bases = [w];
  if (w.length > 3 && /[sx]$/.test(w)) bases.push(w.slice(0, -1));
  for (const b of bases) {
    if (b !== w) out.push({ tokens: [b], type: 'inflection', rule: RULES.fr });
    if (/(au|eu)$/.test(b)) out.push({ tokens: [`${b}x`], type: 'inflection', rule: RULES.fr });
    else if (b.endsWith('al')) out.push({ tokens: [`${b.slice(0, -2)}aux`], type: 'inflection', rule: RULES.fr });
    else if (!/[sxz]$/.test(b)) out.push({ tokens: [`${b}s`], type: 'inflection', rule: RULES.fr });
    if (!b.endsWith('e')) {
      out.push({ tokens: [`${b}e`], type: 'inflection', rule: RULES.frFem, enabled: false },
        { tokens: [`${b}es`], type: 'inflection', rule: RULES.frFem, enabled: false });
    }
  }
  return out;
}

function esWordForms(w) {
  const out = [];
  const bases = [w];
  if (w.length > 4 && w.endsWith('es')) bases.push(w.slice(0, -2));
  if (w.length > 3 && w.endsWith('s')) bases.push(w.slice(0, -1));
  for (const b of bases) {
    if (b !== w) out.push({ tokens: [b], type: 'inflection', rule: RULES.es });
    if (b.endsWith('z')) out.push({ tokens: [`${b.slice(0, -1)}ces`], type: 'inflection', rule: RULES.es });
    else if (/[aeiouáéíóú]$/.test(b)) out.push({ tokens: [`${b}s`], type: 'inflection', rule: RULES.es });
    else if (!b.endsWith('s')) out.push({ tokens: [`${b}es`], type: 'inflection', rule: RULES.es });
    // feminine forms often name a different word (cero → cera "wax"): generated, but off by default
    if (b.endsWith('o')) {
      out.push({ tokens: [`${b.slice(0, -1)}a`], type: 'inflection', rule: RULES.esFem, enabled: false },
        { tokens: [`${b.slice(0, -1)}as`], type: 'inflection', rule: RULES.esFem, enabled: false });
    }
  }
  return out;
}

// ── Hindi and Gujarati ──────────────────────────────────────────────────────────────────────────────

const DEVA_CONSONANT = /[क-हक़-य़]$/u;
const GUJR_CONSONANT = /[ક-હ]$/u;

function hiWordForms(w) {
  const out = [];
  const add = (form) => out.push({ tokens: [form], type: 'inflection', rule: RULES.hi });
  if (w.endsWith('ा')) {                       // -ा → -े / -ों / -ाओं
    const stem = w.slice(0, -1);
    add(`${stem}े`); add(`${stem}ों`); add(`${w}ओं`);
  } else if (w.endsWith('ी')) {                // -ी → -ियाँ / -ियों
    const stem = w.slice(0, -1);
    add(`${stem}ियाँ`); add(`${stem}ियों`);
  } else if (DEVA_CONSONANT.test(w) || w.endsWith('़')) {   // consonant-final: +ों / +ें / +ाएँ
    add(`${w}ों`); add(`${w}ें`); add(`${w}ाएँ`);
  }
  return out;
}

const GU_POSTPOSITIONS = ['નો', 'ની', 'ના', 'ને', 'માં', 'થી', 'એ'];

function guWordForms(w) {
  const out = [];
  const add = (form) => out.push({ tokens: [form], type: 'inflection', rule: RULES.gu });
  const plurals = GUJR_CONSONANT.test(w) ? [`${w}ો`, `${w}ઓ`] : [`${w}ઓ`];   // બાળક → બાળકો; -ઓ after a vowel
  for (const p of plurals) add(p);
  for (const base of [w, ...plurals]) for (const pp of GU_POSTPOSITIONS) add(`${base}${pp}`);
  return out;
}

// ── orthographic folds (hi/gu) ──────────────────────────────────────────────────────────────────────

// NFC keeps क़ ख़ ग़ ज़ फ़ decomposed (consonant + U+093C); ड़ ढ़ are distinct letters and keep their nukta.
const NUKTA = '़';
const NUKTA_FOLDABLE = new Set(['क', 'ख', 'ग', 'ज', 'फ']);   // क ख ग ज फ
const TO_ANUSVARA = { 'ँ': 'ं', 'ઁ': 'ં' };   // chandrabindu → anusvara (Deva, Gujr)
const TO_CANDRA = { 'ं': 'ँ', 'ં': 'ઁ' };
const HAS_NASAL = /[ँंઁં]/u;

/** Forms of one token with every foldable nukta removed and every combination of nuktas added (≤ 3 sites). */
function nuktaForms(t) {
  const chars = [...t];
  const out = new Set();
  const stripped = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === NUKTA && NUKTA_FOLDABLE.has(chars[i - 1])) continue;
    stripped.push(chars[i]);
  }
  const base = stripped.join('');
  if (base !== t) out.add(base);
  const sites = [];
  stripped.forEach((ch, i) => { if (NUKTA_FOLDABLE.has(ch) && stripped[i + 1] !== NUKTA) sites.push(i); });
  const n = Math.min(sites.length, 3);
  for (let mask = 1; mask < 1 << n; mask++) {
    const arr = stripped.slice();
    for (let b = n - 1; b >= 0; b--) if (mask & (1 << b)) arr.splice(sites[b] + 1, 0, NUKTA);
    out.add(arr.join(''));
  }
  out.delete(t);
  return [...out];
}

/** Nukta fold only: every foldable nukta removed (inflected forms get just this direction). */
function nuktaFolded(t) {
  const chars = [...t];
  const out = chars.filter((ch, i) => !(ch === NUKTA && NUKTA_FOLDABLE.has(chars[i - 1]))).join('');
  return out === t ? [] : [out];
}

/** The token spelled with anusvara throughout, and with chandrabindu throughout (when it has either). */
function candraForms(t) {
  if (!HAS_NASAL.test(t)) return [];
  const a = [...t].map((ch) => TO_ANUSVARA[ch] ?? ch).join('');
  const c = [...t].map((ch) => TO_CANDRA[ch] ?? ch).join('');
  return [...new Set([a, c])].filter((x) => x !== t);
}

/**
 * Orthographic variants of a token sequence. The typed form gets every nukta fold/addition and both nasal
 * spellings; an inflected form gets the nukta fold and both nasal spellings.
 */
function orthographicForms(tokens, { typed }) {
  const out = [];
  tokens.forEach((t, i) => {
    const swap = (f) => tokens.map((x, j) => (j === i ? f : x));
    for (const f of typed ? nuktaForms(t) : nuktaFolded(t)) out.push({ tokens: swap(f), type: 'spelling', rule: RULES.nukta });
    for (const f of candraForms(t)) out.push({ tokens: swap(f), type: 'spelling', rule: RULES.candra });
  });
  return out;
}

// ── entry point ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Generated variants of an expression (the identity form is not included).
 * @param {string} surface the expression as typed
 * @param {{lang?: string|null, kinds?: string[]|null}} [opts] `kinds` limits the variant types
 *   (e.g. ['inflection']); null = all generated types
 * @returns {Array<{form: string, norm: string, tokens: string[], lang: string|null, type: string, rule: string,
 *   status: 'computed', enabled: boolean}>}
 */
export function generateVariants(surface, { lang = null, kinds = null } = {}) {
  const tokens = tokenize(String(surface ?? '')).tokens;
  if (!tokens.length) return [];
  const script = scriptOfTokens(tokens);
  const l = lang ? String(lang).toLowerCase().split('-')[0] : script === 'Deva' ? 'hi' : script === 'Gujr' ? 'gu' : null;
  const raw = [];
  if (tokens.length === 1) {
    const w = tokens[0];
    if (l === 'en' && LATIN_WORD.test(w)) raw.push(...enWordForms(w));
    else if (l === 'fr' && LATIN_WORD.test(w)) raw.push(...frWordForms(w));
    else if (l === 'es' && LATIN_WORD.test(w)) raw.push(...esWordForms(w));
    else if (l === 'hi' && script === 'Deva') raw.push(...hiWordForms(w));
    else if (l === 'gu' && script === 'Gujr') raw.push(...guWordForms(w));
  } else if (l === 'en') {
    raw.push(...enPhraseForms(tokens));
  }
  if (script === 'Deva' || script === 'Gujr') {
    // orthographic folds of the typed form and (Devanagari) of each inflected form; Gujarati postposition
    // forms are left alone (their anusvara is the standard spelling)
    const inflected = script === 'Deva' ? raw.slice() : [];
    for (const o of orthographicForms(tokens, { typed: true })) raw.push(o);
    for (const f of inflected) {
      for (const o of orthographicForms(f.tokens, { typed: false })) raw.push({ ...o, enabled: f.enabled ?? true });
    }
  }
  if (tokens.length === 2 && /\p{L}[-‐‑–]\p{L}/u.test(String(surface))) {
    raw.push({ tokens: [tokens.join('')], type: 'hyphenation', rule: RULES.hyphen });
  }

  const own = tokens.join(' ');
  const seen = new Set([own]);
  const out = [];
  for (const r of raw) {
    if (kinds && !kinds.includes(r.type)) continue;
    const norm = r.tokens.join(' ');
    if (seen.has(norm) || r.tokens.some((t) => !t)) continue;
    seen.add(norm);
    out.push({ form: displayForm(surface, tokens, r.tokens), norm, tokens: r.tokens, lang: l, type: r.type, rule: r.rule,
      status: 'computed', enabled: r.enabled ?? true });
  }
  return out;
}

/** A readable form for a variant's tokens: possessives keep their apostrophe ("hacker's"). */
function displayForm(surface, tokens, vtokens) {
  if (vtokens.length === tokens.length + 1 && vtokens[vtokens.length - 1] === 's' && tokens.length === 1) return `${vtokens[0]}'s`;
  return vtokens.join(' ');
}

/**
 * Stable hash of the enabled variant set (expression_state.variants_hash).
 * @param {Array<{norm: string, lang?: string|null, enabled: boolean|number}>} variants
 * @returns {string}
 */
export function variantsHash(variants) {
  const enabled = variants.filter((v) => v.enabled === true || v.enabled === 1)
    .map((v) => `${v.lang ?? ''}\u0000${v.norm}`).sort();
  return shortHash(canonicalJson(enabled), 16);
}
