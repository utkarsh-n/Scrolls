// OWNER: WP3 — a deterministic, invented multilingual corpus for the WP3 property tests (not a test file itself).
//
// Every document is SYNTHETIC (corpus 'test', is_synthetic = 1) and every author ends "(synthetic)". The corpus
// exercises what aggregation must get right: every date precision (day … millennium, ranges, circa, calendar
// conversions, BCE), undated and scheduled items, translations, duplicates, boilerplate and apparatus regions,
// describes passages, titles (works unit), a collection whose text may not be exported, a collection that is not
// rate-eligible, name-shaped matches, and text features that break naive offsets (CRLF, BOM, combining marks,
// ZWJ, long s, emoji, Gutenberg _italics_).

import { mulberry32 } from '../src/shared/ids.mjs';
import { nowIso } from '../server/db/open.mjs';
import { createBatch, createDocumentWriter, ensureCollection } from '../server/store/document-writer.mjs';

/** Collections of the generated corpus. */
export const GEN_COLLECTIONS = Object.freeze({
  text: { slug: 'gen-text', name: 'Generated texts (synthetic)', domain: 'imported', modality: 'text', unit: 'tokens', sampling: 'user', coverage_gate: 300 },
  titles: { slug: 'gen-titles', name: 'Generated titles (synthetic)', domain: 'culture', modality: 'titles', unit: 'works', sampling: 'prominence_selected', coverage_gate: 5 },
  closed: { slug: 'gen-closed', name: 'Generated abstracts, text not exportable (synthetic)', domain: 'stemm', modality: 'abstracts', unit: 'tokens', sampling: 'top_cited_per_cell', coverage_gate: 300, export_text_allowed: 0 },
  endpoints: { slug: 'gen-endpoints', name: 'Generated relation endpoints (synthetic)', domain: 'culture', modality: 'titles', unit: 'works', sampling: 'relation_endpoints', rate_eligible: 0 },
});

/** A sentence that appears only in the non-exportable abstracts (the export test greps every export for it). */
export const CLOSED_SENTENCE = 'the closed abstract keeps its zero behind the licence wall';

const POOLS = {
  en: ['the', 'of', 'and', 'to', 'a', 'in', 'that', 'is', 'was', 'he', 'for', 'it', 'with', 'as', 'his', 'on', 'be', 'at', 'by',
    'this', 'had', 'not', 'are', 'but', 'from', 'or', 'have', 'ledger', 'column', 'clerk', 'number', 'place', 'count', 'house',
    'tray', 'sum', 'margin', 'page', 'office', 'line'],
  fr: ['le', 'la', 'les', 'de', 'des', 'et', 'un', 'une', 'du', 'que', 'qui', 'dans', 'est', 'pas', 'pour', 'sur', 'au', 'il',
    'elle', 'place', 'chiffre', 'registre', 'maison', 'leçon', 'cœur', 'école', 'ardoise', 'somme'],
  es: ['el', 'la', 'los', 'las', 'de', 'y', 'en', 'que', 'un', 'una', 'por', 'con', 'para', 'es', 'no', 'se', 'su', 'al', 'lo',
    'como', 'cuenta', 'niño', 'escuela', 'número', 'lección', 'cigüeña', 'pingüino', 'margen'],
  hi: ['का', 'की', 'के', 'है', 'में', 'और', 'से', 'को', 'पर', 'यह', 'वह', 'था', 'थे', 'नहीं', 'गिनती', 'किताब', 'पाठ', 'जगह', 'बच्चे', 'अंक'],
  gu: ['નો', 'ની', 'ના', 'છે', 'માં', 'અને', 'થી', 'ને', 'પર', 'આ', 'તે', 'હતો', 'નથી', 'ગણિત', 'પોથી', 'પાઠ', 'જગ્યા', 'બાળકો', 'અંક'],
};

/** Inserts per language: [text, weight]. Combining, ZWJ, nukta, emoji, long-s and italics cases included. */
const INSERTS = {
  en: [['zero', 6], ['zeros', 2], ['zero’s', 1], ['_zero_', 1], ['carry the zero', 3], ['carried the zero', 1],
    ['for Gene Halloran', 1], ['the selfish gene', 1], ['◉', 1], ['👍🏽', 1], ['ſaid', 1], ['Zero Mostel', 1], ['co­operative', 1]],
  fr: [['zéro', 5], ['zéros', 2], ['zéro', 1], ['l’école', 1]],
  es: [['cero', 5], ['ceros', 2], ['¿Quién cuenta?', 1]],
  hi: [['शून्य', 5], ['शून्यों', 2], ['क़लम', 1], ['कलम', 1], ['चाँद', 1], ['चांद', 1], ['क्‍षण', 1], ['४२', 1]],
  gu: [['શૂન્ય', 5], ['શૂન્યમાં', 2], ['શૂન્યનો', 1], ['૧૨', 1]],
};

const DATES = [['1903', 3], ['1958-03-14', 2], ['June 1963', 2], ['7 de abril de 1931', 1], ['années 1890', 2], ['vers 1894', 2],
  ['c. 1920', 2], ['early 20th century', 2], ['19th century', 1], ['1910–1915', 2], ['1850s', 2], ['1990s', 1], ['2003', 2],
  ['1994-05-17', 2], ['March 1995', 1], ['शक 1850', 1], ['સંવત ૧૯૮૭', 1], ['१९७१', 1], ['', 2], ['n.d.', 1], ['2090', 1],
  ['2031', 1], ['1066', 1], ['500 BCE', 1], ['1200', 1], ['3rd century BCE', 1], ['12 Feb 1809', 1], ['1999-12-31', 1], ['Dec 1999', 1]];

const COMMUNITIES = ['classroom', 'office-lab', 'hiphop', 'literature', null];
const CULTURES = ['in', 'us', 'fr', null];
const KINDS = { text: ['book', 'letter', 'memo', 'essay', 'poem'], titles: ['film', 'song', 'book', 'tv'] };
const TITLE_WORDS = ['Zero Hour', 'Zero', 'Gene Kelly Live', 'The Selfish Gene', 'Mickey Zero', 'Carry the Zero', 'Hackers',
  'Night Ledger', 'Column of Smoke', 'Blue Tray', 'शून्य', 'શૂન્ય ગીત', '◉ Marks', 'The Counting House', 'Zeros and Ones'];
const MAKERS = ['Gene Kelly (synthetic)', 'Kelly Marsh (synthetic)', 'Ada Ledger (synthetic)', 'MC Column (synthetic)', 'Rati Pothi (synthetic)'];
const THEMES = [['hip hop', 'documented_category'], ['protest', 'machine_tag'], ['love', 'genre_heuristic'], ['hip hop', 'machine_tag']];

function picker(rnd) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const weighted = (arr) => {
    const total = arr.reduce((s, [, w]) => s + w, 0);
    let x = rnd() * total;
    for (const [v, w] of arr) { x -= w; if (x < 0) return v; }
    return arr[arr.length - 1][0];
  };
  return { pick, weighted };
}

function paragraph(rnd, lang, words) {
  const { pick, weighted } = picker(rnd);
  const out = [];
  for (let i = 0; i < words; i++) {
    out.push(rnd() < 0.12 ? weighted(INSERTS[lang]) : pick(POOLS[lang]));
  }
  const s = out.join(' ');
  return `${s[0].toUpperCase()}${s.slice(1)}${lang === 'hi' ? '।' : '.'}`;
}

function textDoc(rnd, i, lang, { translation = false } = {}) {
  const { pick, weighted } = picker(rnd);
  const textLang = translation ? 'en' : lang;
  const paras = [];
  const n = 1 + Math.floor(rnd() * 4);
  for (let p = 0; p < n; p++) paras.push(paragraph(rnd, textLang, 25 + Math.floor(rnd() * 50)));
  const crlf = rnd() < 0.15;
  const nl = crlf ? '\r\n' : '\n';
  let original = (rnd() < 0.05 ? '﻿' : '') + paras.join(nl + nl) + nl;
  const regions = [];
  if (rnd() < 0.12) {
    const start = original.length;
    original += `${nl}This ebook is for the use of anyone, zero cost, under the licence terms of the project.${nl}`;
    regions.push({ start, end: original.length, quality: 'boilerplate' });
  }
  if (rnd() < 0.08) {
    const pre = `PREFACE by an editor: this zero edition was revised in 1990.${nl}${nl}`;
    original = pre + original;
    for (const r of regions) { r.start += pre.length; r.end += pre.length; }
    regions.unshift({ start: 0, end: pre.length - nl.length * 2, time_role: 'apparatus', field_class: 'apparatus' });
  }
  const date = weighted(DATES);
  const dates = [{ role: 'publication', raw: date, asserted_by: 'fixture:gen', is_chronology: true }];
  if (rnd() < 0.1) dates.push({ role: 'referenced', raw: '1911', asserted_by: 'fixture:gen', is_chronology: false });
  return {
    ext_id: `gen:t${i}`, kind: pick(KINDS.text), title: `Generated text ${i}`, author: `${pick(['Ada', 'Mireille', 'Lucía', 'रमा', 'રતિ'])} Gen${i % 17} (synthetic)`,
    community: pick(COMMUNITIES), culture: pick(CULTURES), field: rnd() < 0.2 ? 'mathematics' : null,
    lang_declared: translation ? 'fr' : lang,
    text: { original, decoder: 'utf-8', regions }, dates, original_meta: { generated: true, i },
  };
}

function titleDoc(rnd, i, prefix) {
  const { pick, weighted } = picker(rnd);
  const title = rnd() < 0.6 ? pick(TITLE_WORDS) : `${pick(['Night', 'Blue', 'Iron', 'Paper'])} ${pick(['Column', 'Tray', 'Ledger', 'Song'])} ${i}`;
  const year = rnd() < 0.08 ? '' : rnd() < 0.05 ? String(2027 + Math.floor(rnd() * 8)) : rnd() < 0.15 ? weighted(DATES) : String(1940 + Math.floor(rnd() * 85));
  const fields = { title };
  const field_roles = {};
  if (rnd() < 0.3) { fields.summary = `A catalogue note about a zero and a ledger, written decades later (item ${i}).`; field_roles.summary = 'describes'; }
  const [theme, provenance] = pick(THEMES);
  return {
    ext_id: `${prefix}${i}`, kind: pick(KINDS.titles), title, author: pick(MAKERS), community: pick(COMMUNITIES), culture: pick(CULTURES),
    fields, field_roles, dates: [{ role: 'publication', raw: year, asserted_by: 'fixture:gen', is_chronology: true }],
    tags: [{ scheme: 'theme', value: theme, provenance, method: 'fixture' }], original_meta: { generated: true, i },
  };
}

function abstractDoc(rnd, i) {
  const sentence = rnd() < 0.5 ? `${CLOSED_SENTENCE}. ` : '';
  return {
    ext_id: `gen:a${i}`, kind: 'abstract', title: `Generated paper ${i}`, author: `Paper Author ${i} (synthetic)`, field: 'mathematics',
    lang_declared: 'en',
    fields: { title: `Generated paper ${i}`, abstract: `${sentence}${paragraph(rnd, 'en', 30)}` }, field_roles: { abstract: 'document' },
    dates: [{ role: 'publication', raw: String(1950 + Math.floor(rnd() * 70)), asserted_by: 'fixture:gen', is_chronology: true }],
    original_meta: { generated: true, i },
  };
}

// ── RF-1: unidentified text inside identified books ───────────────────────────────────────────────────
// Paragraphs no stop-word profile identifies ('und', ≥ 8 tokens) and short headings ('und-Latn') inside Spanish, French,
// Hindi and English books, an all-unidentified document, and a French abstract with an unidentified paragraph. Before
// RF-1 the unidentified rows of an es/fr/hi book counted as English text (and as Spanish text, …): the property tests
// (aggregate.cube, aggregate.binning, aggregate.invariants) build the corpus with `und: true` so every random slice
// meets them, and the oracle below (inSlice) states the rule independently of server/aggregate/langgate.mjs.

// ≥ 12 tokens (so the segmenter keeps them apart, seg-1) with no stop word of any profile: langid says 'und'
const UND_PARA = {
  en: 'ledger column zero clerk tray margin page office zero number tray margin ledger column',
  es: 'ledger column cero clerk tray margin page office cero number tray margin ledger column',
};
// a short last block stays alone: 'und-Latn' (under 8 tokens)
const SHORT = 'Zero Column';
const IDENTIFIED = {
  en: 'The clerk of the office kept the ledger and wrote the number in the column for the house, and the boy at the desk carried the zero to the next line.',
  es: 'El niño de la escuela cuenta los números en la pizarra y la maestra escribe la lección para todos los niños de la clase con un cero.',
  fr: "Il est dans la maison et elle est pour le registre des enfants qui ne sont pas au jardin, mais il compte les chiffres sur une ardoise du maître.",
  hi: 'बच्चे किताब में गिनती का पाठ पढ़ते हैं और शून्य की जगह को समझते हैं और अंक लिखते हैं।',
};

/** Fixed documents of the `und` option (synthetic). */
export function unidentifiedTextDocs() {
  const book = (i, lang, date, paras, { apparatus = null } = {}) => {
    let original = paras.join('\n\n') + '\n';
    const regions = [];
    if (apparatus) {
      const pre = `${apparatus}\n\n`;
      original = pre + original;
      regions.push({ start: 0, end: apparatus.length, time_role: 'apparatus', field_class: 'apparatus' });
    }
    return { ext_id: `gen:u${i}`, kind: 'book', title: `Unidentified-text book ${i}`, author: `Und Author ${i} (synthetic)`,
      community: 'classroom', culture: null, field: null, lang_declared: lang, text: { original, decoder: 'utf-8', regions },
      dates: [{ role: 'publication', raw: date, asserted_by: 'fixture:gen', is_chronology: true }], original_meta: { generated: true, und: i } };
  };
  const { en: EN, es: ES, fr: FR, hi: HI } = IDENTIFIED;
  return [
    // Spanish, French and Hindi books holding an unidentified paragraph with the English word (and apparatus, a short block)
    book(1, 'es', '1891', [ES, UND_PARA.en, ES, ES], { apparatus: UND_PARA.en }),
    book(2, 'es', '1893', [ES, UND_PARA.en, ES, SHORT]),
    book(3, 'fr', '1895', [FR, UND_PARA.en, FR, FR]),
    book(4, 'hi', '1897', [HI, UND_PARA.en, HI]),
    // English books: their unidentified text stays English (and the Spanish word in it is not Spanish text)
    book(5, 'en', '1892', [EN, UND_PARA.en, UND_PARA.es, EN], { apparatus: UND_PARA.en }),
    book(6, 'en', '1896', [EN, UND_PARA.en, EN, SHORT]),
    // a Spanish book whose unidentified paragraph holds the Spanish word
    book(8, 'es', '1890', [ES, UND_PARA.es, ES]),
    // no identified passage at all: the document's language is itself unidentified, so its rows count for both
    book(7, null, '1894', [UND_PARA.en, UND_PARA.es, SHORT]),
  ];
}

/**
 * A French paper whose abstract is unidentified (gen-closed): an abstract is one passage, so the whole abstract is the
 * unidentified row; the French body text gives the document its language.
 */
function unidentifiedAbstractDoc() {
  return { ext_id: 'gen:ua1', kind: 'abstract', title: 'Unidentified-text paper', author: 'Und Paper Author (synthetic)', field: 'mathematics',
    lang_declared: 'fr', text: { original: `${IDENTIFIED.fr}\n\n${IDENTIFIED.fr}\n`, decoder: 'utf-8', regions: [] },
    fields: { title: 'Unidentified-text paper', abstract: UND_PARA.en }, field_roles: { abstract: 'document' },
    dates: [{ role: 'publication', raw: '1990', asserted_by: 'fixture:gen', is_chronology: true }], original_meta: { generated: true, und: 'abstract' } };
}

/**
 * A Hindi film listed under its English label (gen-titles): the label is a short Latin title ('und-Latn') while the
 * native title makes the work Hindi. Title rows keep their own language: the label still counts for an English word.
 */
function unidentifiedTitleDoc() {
  return { ext_id: 'gen:uw1', kind: 'film', title: 'Zero', author: 'Und Director (synthetic)', community: 'classroom', culture: 'in',
    fields: { title: 'Zero', native_title: 'शून्य की गिनती का पाठ' }, field_roles: {},
    dates: [{ role: 'publication', raw: '1958', asserted_by: 'fixture:gen', is_chronology: true }], original_meta: { generated: true, und: 'title' } };
}

function write(db, spec, docs) {
  const coll = ensureCollection(db, { ...spec, corpus: 'test', adapter_id: 'file.jsonl', selection_note: 'invented test documents' });
  const batchId = createBatch(db, { collection: coll.id, format: 'jsonl', fileName: `${spec.slug}.jsonl` });
  const writer = createDocumentWriter(db, { batchId, collection: coll.slug, corpus: 'test', options: { now: new Date('2026-10-04T12:00:00Z') } });
  for (let i = 0; i < docs.length; i++) writer.addDocument(docs[i], { line: i + 1 });
  return writer.finish();
}

/**
 * Write the generated corpus into a migrated, seeded database (after tests/helpers/tmpdata.mjs makeTmpData).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{seed?: number, texts?: number, titles?: number, abstracts?: number, und?: boolean}} [opts] `und` (RF-1): also the
 *   documents of unidentifiedTextDocs() and a French abstract with an unidentified paragraph
 * @returns {{counts: object}}
 */
export function buildGeneratedCorpus(db, { seed = 7, texts = 220, titles = 120, abstracts = 30, und = false } = {}) {
  db.prepare(`INSERT INTO corpus (slug, name, kind, is_synthetic, description, license, created_at)
    VALUES ('test', 'Test fixtures (synthetic)', 'synthetic', 1, 'Invented test documents', 'CC0 (synthetic)', ?)
    ON CONFLICT(slug) DO NOTHING`).run(nowIso());
  const rnd = mulberry32(seed);
  const langs = ['en', 'en', 'en', 'fr', 'es', 'hi', 'gu'];
  const textDocs = [];
  for (let i = 0; i < texts; i++) {
    const lang = langs[Math.floor(rnd() * langs.length)];
    if (i > 10 && rnd() < 0.05) {
      const src = textDocs[Math.floor(rnd() * textDocs.length)];   // an exact duplicate (dup_of)
      textDocs.push({ ...src, ext_id: `gen:t${i}`, original_meta: { generated: true, i, duplicate_of: src.ext_id } });
      continue;
    }
    textDocs.push(textDoc(rnd, i, lang, { translation: lang === 'fr' && rnd() < 0.25 }));
  }
  const counts = {
    text: write(db, GEN_COLLECTIONS.text, textDocs),
    titles: write(db, GEN_COLLECTIONS.titles, Array.from({ length: titles }, (_, i) => titleDoc(rnd, i, 'gen:w'))),
    closed: write(db, GEN_COLLECTIONS.closed, Array.from({ length: abstracts }, (_, i) => abstractDoc(rnd, i))),
    endpoints: write(db, GEN_COLLECTIONS.endpoints, Array.from({ length: 10 }, (_, i) => titleDoc(rnd, i, 'gen:e'))),
  };
  if (und) {
    counts.und = write(db, GEN_COLLECTIONS.text, unidentifiedTextDocs());
    counts.undAbstract = write(db, GEN_COLLECTIONS.closed, [unidentifiedAbstractDoc()]);
    counts.undTitle = write(db, GEN_COLLECTIONS.titles, [unidentifiedTitleDoc()]);
  }
  return { counts };
}

// ── an independent oracle: the slice rules of SPEC §1.2/§4.6 re-implemented in plain JS ──────────────────

const FACET_VALUE = {
  domain: (r) => r.domain, community: (r) => r.community, kind: (r) => r.kind, culture: (r) => r.culture,
  collection: (r) => r.coll, field: (r) => r.field, date_basis: (r) => r.basis, language: (r) => r.plang,
};
const UNIT_CLASS = (fc) => (fc === 'title' ? 'titles' : fc === 'abstract' ? 'abstracts' : 'text');
const LIST_COLS = { kind: 'kind', coll: 'coll', culture: 'culture', field: 'field', community: 'community', basis: 'basis' };

/** Whether a joined row (document + collection + passage-level columns) lies in a def's slice. */
export function inSlice(def, langs, r) {
  if (r.deleted_at !== null || r.corpus_id !== def.corpusId || r.rate_eligible !== 1) return false;
  if (!def.toggles.tr && r.is_translation) return false;
  if (!def.toggles.dup && r.dup_of !== null) return false;
  if (!def.toggles.est && r.basis === 'estimated') return false;
  if (def.f.syn === 0 && r.is_synthetic) return false;
  for (const [k, col] of Object.entries({ ...LIST_COLS, lang: 'plang' })) {
    const vals = def.f[k] ?? [];
    const inc = vals.filter((v) => !v.startsWith('-')), exc = vals.filter((v) => v.startsWith('-')).map((v) => v.slice(1));
    if (inc.length && !inc.includes(r[col])) return false;
    if (exc.length && r[col] !== null && exc.includes(r[col])) return false;
  }
  const classes = ['text', 'title', 'abstract', ...(def.toggles.ds ? ['describes'] : []), ...(def.toggles.ap ? ['apparatus'] : [])];
  if (!classes.includes(r.fc)) return false;
  if (langs && !langs.includes(r.plang)) return false;
  // RF-1 (stated here on its own, not imported): an unidentified row of a document's running text belongs to the
  // document's text language; a title or describing row keeps its own
  const unidentified = (l) => l === null || l === undefined || l === 'und' || String(l).startsWith('und-');
  if (langs && unidentified(r.plang) && ['text', 'abstract', 'apparatus'].includes(r.fc) && !unidentified(r.dlang) && !langs.includes(r.dlang)) return false;
  return true;
}

/** Lane key and unit class of a joined row under a def (the format of server/aggregate/lanes.mjs). */
export function oracleLane(def, r) {
  const uc = UNIT_CLASS(r.fc);
  const facet = def.lanes.facet;
  const v = facet === 'modality' ? uc : FACET_VALUE[facet](r);
  const value = v === null || v === undefined || v === '' ? '(none)' : String(v);
  return { key: facet === 'modality' || uc === 'text' ? `${facet}:${value}` : `${facet}:${value}~${uc}`, uc };
}

const JOIN = `JOIN document d ON d.id = x.document_id JOIN collection c ON c.id = d.collection_id`;
const DOC_COLS = `d.id AS doc, d.deleted_at, d.is_translation, d.dup_of, d.basis, d.is_synthetic, d.kind, d.culture, d.field, d.community, d.lang_text AS dlang,
  d.chrono_status, d.lo_day, d.hi_day, d.y_lo, d.y_hi, c.slug AS coll, c.domain, c.corpus_id, c.rate_eligible`;

/**
 * Counted amounts of an expression strand per lane, straight from the occurrence table: every match in text
 * lanes, works with ≥ 1 match in title lanes.
 * @returns {Map<string, {uc: string, total: number, undated: number, scheduled: number, docs: Map<number, {row: object, amount: number}>}>}
 */
export function oracleCounts(db, def, strand) {
  const rows = db.prepare(`SELECT x.name_flag, p.quality, p.field_class AS fc, p.lang AS plang, ${DOC_COLS}
    FROM occurrence x JOIN passage p ON p.id = x.passage_id ${JOIN} WHERE x.expression_id = ? AND x.run_id = ?`).all(strand.ref, strand.run);
  const lanes = new Map();
  for (const r of rows) {
    if (r.quality !== 'ok' || (r.name_flag && !def.toggles.nm) || !inSlice(def, strand.langs, r)) continue;
    const { key, uc } = oracleLane(def, r);
    if (!lanes.has(key)) lanes.set(key, { uc, total: 0, undated: 0, scheduled: 0, docs: new Map() });
    const l = lanes.get(key);
    const d = l.docs.get(r.doc) ?? { row: r, amount: 0 };
    l.docs.set(r.doc, d);
    if (uc === 'titles') { if (d.amount === 0) { d.amount = 1; l.total++; if (r.chrono_status !== 'dated') l[r.chrono_status]++; } continue; }
    d.amount++;
    l.total++;
    if (r.chrono_status !== 'dated') l[r.chrono_status]++;
  }
  return lanes;
}

/**
 * Denominators per lane × bin from doc_tokens: tokens (text, abstracts) or documents (titles) of documents that
 * fit the bin.
 * @param {(row: object) => number|null} binOfRow bin of a dated document at the tier, null when it does not fit
 * @returns {Map<string, number>} keyed `${lane}|${bin}`
 */
export function oracleDenominators(db, def, langs, binOfRow) {
  const rows = db.prepare(`SELECT x.plang, x.field_class AS fc, x.tokens, ${DOC_COLS} FROM doc_tokens x ${JOIN}`).all();
  const out = new Map();
  const seen = new Set();
  for (const r of rows) {
    if (r.chrono_status !== 'dated' || !inSlice(def, langs, r)) continue;
    const bin = binOfRow(r);
    if (bin === null) continue;
    const { key, uc } = oracleLane(def, r);
    const k = `${key}|${bin}`;
    if (uc === 'titles') {
      if (seen.has(`${k}|${r.doc}`)) continue;
      seen.add(`${k}|${r.doc}`);
      out.set(k, (out.get(k) ?? 0) + 1);
    } else out.set(k, (out.get(k) ?? 0) + r.tokens);
  }
  return out;
}

const pickN = (rnd, arr, max) => {
  const n = Math.floor(rnd() * (max + 1));
  const out = new Set();
  for (let i = 0; i < n; i++) out.add(arr[Math.floor(rnd() * arr.length)]);
  return [...out];
};

/**
 * A random timeline request over the generated corpus (facet, filters, toggles).
 * @param {() => number} rnd
 * @param {number[]} exprIds strands to pin (1–2 of them are used)
 * @returns {object} a POST /api/timeline/query body
 */
export function randomRequest(rnd, exprIds) {
  // contract 1.3.0: `cluster` lanes are context groups of a clustering run and `trail` the Term trail's fixed lanes; both
  // have their own property tests (aggregate.trail.test.mjs), so this oracle covers the column facets
  const facets = ['domain', 'community', 'kind', 'culture', 'language', 'collection', 'field', 'modality', 'date_basis'];
  const f = [];
  const lists = {
    lang: ['en', 'fr', '-en', 'hi', 'und-Latn', '-und-Latn', 'gu'], kind: ['book', 'film', '-song', 'abstract', 'letter'],
    coll: ['gen-text', 'gen-titles', '-gen-titles', 'gen-closed', '-gen-closed'], community: ['classroom', '-hiphop', 'office-lab'],
    culture: ['in', '-us'], basis: ['-estimated', 'stated', 'derived'],
  };
  for (const [k, vals] of Object.entries(lists)) if (rnd() < 0.35) { const v = pickN(rnd, vals, 2); if (v.length) f.push(`${k}:${v.join(',')}`); }
  if (rnd() < 0.08) f.push('syn:0');
  const bit = (p) => (rnd() < p ? 1 : 0);
  const n = rnd() < 0.3 ? 2 : 1;
  const strands = [];
  for (let i = 0; i < n; i++) strands.push({ type: 'expression', ref: exprIds[Math.floor(rnd() * exprIds.length)] });
  return {
    corpus: 'test', strands: [...new Map(strands.map((s) => [s.ref, s])).values()],
    lanes: { facet: facets[Math.floor(rnd() * facets.length)], order: 'first_observed', max: 48 }, f: f.join(';'),
    toggles: { tr: bit(0.3), ds: bit(0.4), ap: bit(0.3), dup: bit(0.3), nm: bit(0.3), est: bit(0.8), bp: 0 }, timeBasis: 'publication',
  };
}

/**
 * The coverage gate of every lane of a def (§1.2): the strictest among the lane's collections; a collection's own
 * coverage_gate applies only when it counts in the lane's unit (tokens for text/abstracts, works for titles).
 * @returns {Map<string, number>}
 */
/**
 * Lanes that hold a top-cited-per-cell sample (OpenAlex-like): their cells carry counts and states but no rate
 * (D14, §10.4; M5 gate). Independent of query.laneGatesOf.
 */
export function oracleCellSampledLanes(db, def) {
  const rows = db.prepare(`SELECT x.plang, x.field_class AS fc, c.sampling, ${DOC_COLS} FROM doc_tokens x ${JOIN}`).all();
  const out = new Set();
  for (const r of rows) if (inSlice(def, null, r) && r.sampling === 'top_cited_per_cell') out.add(oracleLane(def, r).key);
  return out;
}

export function oracleGates(db, def) {
  const rows = db.prepare(`SELECT x.plang, x.field_class AS fc, c.unit, c.coverage_gate, ${DOC_COLS} FROM doc_tokens x ${JOIN}`).all();
  const out = new Map();
  for (const r of rows) {
    if (!inSlice(def, null, r)) continue;
    const { key, uc } = oracleLane(def, r);
    const unit = uc === 'titles' ? 'works' : 'tokens';
    const dflt = unit === 'works' ? 30 : 50000;
    const g = r.unit === unit && r.coverage_gate !== null ? r.coverage_gate : dflt;
    out.set(key, Math.max(out.get(key) ?? 0, g));
  }
  return out;
}
