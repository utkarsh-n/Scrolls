// OWNER: R — RF-1 (IOS-SPEC §2.1, ref-freeze-1)
// langgate.mjs — which passage-level rows count in a strand's languages (SPEC §4.6, §5.6, §13 rules 2–3).
//
// A strand counts — and is divided by — the passages of its own languages plus the unidentified buckets of its script
// ('und': Latin text no stop-word profile matched, or another script; 'und-Latn': Latin text under 8 tokens). Before
// RF-1 an unidentified passage of a Spanish or French book counted as English text: Cipher *machine* 1875–1899 listed
// 148 documents, 76 of them es/fr books that added only unidentified headings, verse numbers and old spellings.
//
// The rule (one definition, read by the slice cube, the SQL slice, Compare, the exclusion buckets and clustering): an
// unidentified row of the document's own running text — field classes text, abstract and apparatus — belongs to the
// document's text language. It counts in a strand's languages only when that language is one of them, or when the
// document's language is itself unidentified. Title rows (the works unit: a Wikidata English label of a Hindi film is
// 'und-Latn' while the film's language is Hindi) and describing passages (catalogue notes, written by others and often
// in another language than the work) keep the passage-level rule: their own language decides.

/** Passage languages that mean "not identified" (server/text/langid.mjs). */
export const UNIDENTIFIED_LANGS = Object.freeze(['und', 'und-Latn']);

/** Field classes of a document's own running text: their unidentified rows take the document's text language. */
export const DOC_TEXT_CLASSES = Object.freeze(['text', 'abstract', 'apparatus']);

/**
 * Whether a language code says "not identified" ('und', 'und-…', or none), as langid's documentLang reads it.
 * @param {string|null|undefined} lang
 * @returns {boolean}
 */
export const isUnidentified = (lang) => lang === null || lang === undefined || lang === '' || lang === 'und' || String(lang).startsWith('und-');

const has = (langs, l) => (Array.isArray(langs) ? langs.includes(l) : langs.has(l));

/**
 * Whether a passage-level row (expr_doc, doc_tokens or passage) counts in a strand's languages.
 * @param {string[]|Set<string>|null} langs the strand's languages (null = any language: every row counts)
 * @param {string} plang the row's passage language
 * @param {string} fieldClass the row's field class
 * @param {string|null} docLang the document's text language (document.lang_text)
 * @returns {boolean}
 */
export function langAdmits(langs, plang, fieldClass, docLang) {
  if (langs === null || langs === undefined) return true;
  if (!has(langs, plang)) return false;
  if (!isUnidentified(plang) || !DOC_TEXT_CLASSES.includes(fieldClass)) return true;
  return isUnidentified(docLang) || has(langs, docLang);
}

const UND_SQL = (col) => `(${col} = 'und' OR ${col} LIKE 'und-%')`;

/**
 * langAdmits as SQL over a passage-level row and its document (alias `d` unless `cols.dlang` names another column).
 * @param {{plang: string, fc: string, dlang?: string}} cols
 * @param {string[]} langs
 * @returns {{sql: string, params: string[]}}
 */
export function langAdmitsSql(cols, langs) {
  const dlang = cols.dlang ?? 'd.lang_text';
  const json = JSON.stringify(langs);
  return {
    sql: `(${cols.plang} IN (SELECT value FROM json_each(?)) AND (NOT ${UND_SQL(cols.plang)}
      OR ${cols.fc} NOT IN ('text', 'abstract', 'apparatus') OR ${dlang} IS NULL OR ${dlang} = '' OR ${UND_SQL(dlang)}
      OR ${dlang} IN (SELECT value FROM json_each(?))))`,
    params: [json, json],
  };
}
