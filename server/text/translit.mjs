// OWNER: WP3
// translit.mjs — transliteration keys for Devanagari/Gujarati ↔ Latin (SPEC §4.5), off by default.
//
// romanKey() maps a Devanagari or Gujarati word to a loose Latin skeleton (ISO-15919-lite) and folds Latin words
// with the same rules: long and short vowels merged, ś ṣ s → s, v w → v, z j → j, aspirate h dropped after
// stops, anusvara → n, and one final schwa 'a' dropped on both sides. Two words match when their keys are equal
// and at least 4 characters long ("Shunya" ↔ शून्य). Matches are offered as `transliteration` variants — real
// forms found in the corpus vocabulary, each with its own count and toggle, never silently merged.

import { shortHash } from '../../src/shared/ids.mjs';
import { foldToken, tokenize } from '../../src/shared/tokenize.mjs';
import { stmt } from '../db/open.mjs';
import { sharedArtifact } from '../aggregate/cache.mjs';

/** Rule id of transliteration variants. */
export const TRANSLIT_RULE = 'translit-key@1';
/** Shortest key that may match. */
export const MIN_KEY = 4;

// Devanagari and Gujarati share one table: the Gujarati block is the Devanagari block + 0x180.
const CONSONANTS = {
  'क': 'k', 'ख': 'k', 'ग': 'g', 'घ': 'g', 'ङ': 'n', 'च': 'c', 'छ': 'c', 'ज': 'j', 'झ': 'j', 'ञ': 'n',
  'ट': 't', 'ठ': 't', 'ड': 'd', 'ढ': 'd', 'ण': 'n', 'त': 't', 'थ': 't', 'द': 'd', 'ध': 'd', 'न': 'n',
  'प': 'p', 'फ': 'p', 'ब': 'b', 'भ': 'b', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'ळ': 'l', 'व': 'v',
  'श': 's', 'ष': 's', 'स': 's', 'ह': 'h',
};
const NUKTA_CONSONANTS = { 'क': 'k', 'ख': 'k', 'ग': 'g', 'ज': 'j', 'फ': 'f', 'ड': 'd', 'ढ': 'd' };
const VOWELS = { 'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऍ': 'e', 'ऑ': 'o' };
const SIGNS = { 'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॅ': 'e', 'ॉ': 'o' };
const VIRAMA = '्', NUKTA = '़', ANUSVARA = 'ं', CANDRABINDU = 'ँ', VISARGA = 'ः';

/** Map a Gujarati code point onto its Devanagari twin (same layout, offset 0x180). */
function toDeva(ch) {
  const c = ch.codePointAt(0);
  return c >= 0x0A80 && c <= 0x0AFF ? String.fromCodePoint(c - 0x180) : ch;
}

/**
 * Units of a Devanagari/Gujarati word: consonants with their vowel (explicit sign, inherent schwa, or none after a
 * virama) and independent vowels. Schwa deletion (Ohala's rule, right to left): an inherent 'a' is dropped at the
 * end of the word and between a vowel and a consonant that carries a vowel (कमल → kamal, लड़का → laḍkā).
 */
function indicKey(word) {
  const chars = [...word.normalize('NFD')].map(toDeva);
  const units = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (CONSONANTS[ch] !== undefined) {
      const nukta = chars[i + 1] === NUKTA;
      const c = nukta ? NUKTA_CONSONANTS[ch] ?? CONSONANTS[ch] : CONSONANTS[ch];
      if (nukta) i++;
      const next = chars[i + 1];
      if (next === VIRAMA) { units.push({ c, v: '' }); i++; } else if (SIGNS[next] !== undefined) { units.push({ c, v: SIGNS[next] }); i++; } else units.push({ c, v: 'a', schwa: true });
    } else if (VOWELS[ch] !== undefined) units.push({ c: '', v: VOWELS[ch] });
    else if (SIGNS[ch] !== undefined) units.push({ c: '', v: SIGNS[ch] });
    else if (ch === ANUSVARA || ch === CANDRABINDU) units.push({ c: 'n', v: '' });
    else if (ch === VISARGA) units.push({ c: 'h', v: '' });
  }
  for (let k = units.length - 1; k >= 0; k--) {
    const u = units[k];
    if (!u.schwa) continue;
    if (k === units.length - 1 && k > 0) { u.v = ''; continue; }
    const prev = units[k - 1], next = units[k + 1];
    if (prev && prev.v && next && next.c && next.v) u.v = '';
  }
  return units.map((u) => u.c + u.v).join('');
}

function latinKey(word) {
  let s = word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, '');
  s = s.replace(/sh/g, 's').replace(/([kgcjtdpb])h/g, '$1').replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k')
    .replace(/x/g, 'ks').replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/([aiu])\1+/g, '$1');
  return s;
}

/**
 * Loose ISO-15919-lite Latin skeleton of a word; a match needs equal keys and length ≥ 4.
 * Cross-package: named in SPEC §4.5.
 * @param {string} word
 * @returns {string}
 */
export function romanKey(word) {
  const w = String(word ?? '');
  const indic = /[ऀ-ॿ઀-૿]/u.test(w);
  let key = indic ? indicKey(w) : latinKey(w);
  // merged long/short vowels and the dropped final schwa make both sides comparable
  key = key.replace(/([aiu])\1+/g, '$1');
  if (key.length > 1 && key.endsWith('a')) key = key.slice(0, -1);
  return key;
}

/**
 * Whether two words are transliteration matches.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function translitMatch(a, b) {
  const ka = romanKey(a), kb = romanKey(b);
  return ka.length >= MIN_KEY && ka === kb;
}

/** Latin initials whose folded key starts with a given letter (w → v, z → j, q/x → k). */
const LATIN_INITIALS = { v: ['v', 'w'], j: ['j', 'z'], k: ['k', 'q', 'x'] };

const INDIC_INITIALS = (() => {
  const byKey = new Map();
  const add = (k, ch) => { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(ch, String.fromCodePoint(ch.codePointAt(0) + 0x180)); };
  for (const [ch, k] of Object.entries(CONSONANTS)) add(k[0], ch);
  for (const [ch, k] of Object.entries(VOWELS)) add(k[0], ch);
  return byKey;
})();

const INDIC_RE = /[\u0900-\u097F\u0A80-\u0AFF]/u;
const GROUP_VERSION = 1;

/**
 * Fingerprint of the FTS vocabulary the transliteration groups read: import batches by status (documents and their
 * passages are only written, reverted or rolled back through one) and the passage quality version. Lexical collections
 * are left out: a Wiktionary entry document is written each time a real word is tracked after a Wiktionary load, and a
 * term found only in an entry's etymology text is never counted (entries are claims, not occurrences).
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string} 16 hex characters
 */
export function vocabularyKey(db) {
  const batches = stmt(db, `SELECT b.status, count(*) AS n, max(b.id) AS m FROM import_batch b JOIN collection c ON c.id = b.collection_id
    WHERE c.modality <> 'lexical' GROUP BY b.status ORDER BY b.status`).all();
  const quality = stmt(db, "SELECT value FROM meta WHERE key = 'quality_version'").get()?.value ?? '0';
  return shortHash(JSON.stringify([GROUP_VERSION, batches, quality]), 16);
}

/**
 * The vocabulary terms of the other script family whose keys start with one letter, with their keys and passage
 * counts: one range scan of the initials that can produce that letter (0.1–1 s on Cipher + STEMM). A shared artifact
 * (memory → $SCROLLS_DATA/cache/ → scan), so searches and materializations of any word with the same initial — in any
 * read worker or job — read it instead of scanning again until an import changes the vocabulary.
 * @param {boolean} indicQuery whether the query word is Devanagari/Gujarati (then Latin terms are listed)
 * @param {string} letter first letter of the query's key (a–z)
 * @returns {object} sharedArtifact spec
 */
function groupSpec(indicQuery, letter) {
  return {
    name: `translit${GROUP_VERSION}-${indicQuery ? 'latn' : 'indic'}-${letter}`,
    key: vocabularyKey,
    build: (db) => scanGroup(db, indicQuery, letter),
    encode: (g) => Buffer.from(JSON.stringify(g)),
    decode: (bytes) => JSON.parse(bytes.toString('utf8')),
  };
}

/** The range scan behind a group: terms (other script family) whose key starts with `letter` and is long enough to match. */
function scanGroup(db, indicQuery, letter) {
  const top = String.fromCodePoint(0x10FFFF);
  // vocabulary ranges (terms sort by code point) of the initials whose key can start with the letter
  const initials = indicQuery ? (LATIN_INITIALS[letter] ?? [letter]) : (INDIC_INITIALS.get(letter) ?? []);
  const g = { terms: [], keys: [], docs: [] };
  for (const ch of initials) {
    for (const r of stmt(db, 'SELECT term, doc FROM passage_vocab_row WHERE term >= ? AND term < ?').iterate(ch, `${ch}${top}`)) {
      if (indicQuery === INDIC_RE.test(r.term)) continue;
      const k = romanKey(r.term);
      if (k.length < MIN_KEY) continue;
      g.terms.push(r.term);
      g.keys.push(k);
      g.docs.push(r.doc);
    }
  }
  return g;
}

/**
 * Words of the other script family in the corpus vocabulary whose key equals the word's key: real forms that
 * can be offered as transliteration variants (single words only).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} surface
 * @param {{limit?: number}} [opts]
 * @returns {Array<{form: string, norm: string, key: string, passages: number}>}
 */
export function transliterationCandidates(db, surface, { limit = 12 } = {}) {
  const toks = tokenize(String(surface ?? '')).tokens;
  if (toks.length !== 1) return [];
  const word = toks[0];
  const key = romanKey(word);
  if (key.length < MIN_KEY || !/^[a-z]/.test(key)) return [];
  const g = sharedArtifact(db, groupSpec(INDIC_RE.test(word), key[0]));
  const out = new Map();
  for (let i = 0; i < g.keys.length; i++) {
    if (g.keys[i] !== key) continue;
    const t = g.terms[i];
    const norm = foldToken(t);
    out.set(norm, { form: t, norm, key, passages: (out.get(norm)?.passages ?? 0) + g.docs[i] });
  }
  return [...out.values()].sort((a, b) => b.passages - a.passages).slice(0, limit);
}
