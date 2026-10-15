// OWNER: WP1
// suggest.mjs — mapping suggestions from header synonyms and value sniffing (SPEC §5.2 step 2).
//
// A column is inferred as text | date | number | id | url | lang | list from its sampled values; the
// suggestion then fills each canonical target from header synonyms first, value sniffing second
// (> 80% of values parse as dates → date; the longest average string → text). Every suggested field carries
// the reason it was chosen, which the import summary reports as a mapping decision.

import { parseDate } from '../../src/shared/dates.mjs';
import { slugify } from '../../src/shared/ids.mjs';
import { normalizeLang } from './mapping.mjs';
import { fileStem } from './txt.mjs';

const DATE_SHARE = 0.8;

/** Header synonyms per target (folded: lower case, accents dropped, separators → '_'). */
export const SYNONYMS = Object.freeze({
  ext_id: ['id', 'ext_id', 'identifier', 'key', 'doc_id', 'document_id', 'record_id', 'uid', 'uuid', 'slug', 'no', 'nr', 'number', '#', 'item_id'],
  title: ['title', 'name', 'headline', 'heading', 'titulo', 'titre', 'शीर्षक', 'नाम', 'શીર્ષક', 'નામ', 'work', 'work_title'],
  text: ['text', 'body', 'content', 'contents', 'lyrics_excerpt', 'lyrics', 'passage', 'transcript', 'full_text', 'fulltext',
    'texto', 'contenu', 'texte', 'पाठ', 'सामग्री', 'લખાણ', 'સામગ્રી', 'pages', 'message', 'post'],
  author: ['author', 'authors', 'creator', 'by', 'writer', 'artist', 'speaker', 'maker', 'autor', 'auteur', 'लेखक', 'લેખક', 'poet', 'composer'],
  date: ['date', 'year', 'published', 'issued', 'pub_date', 'publication_date', 'date_published', 'fecha', 'तारीख', 'તારીખ',
    'created', 'creation_date', 'released', 'release_date', 'ano', 'annee', 'when', 'datum', 'start_date', 'year_start', 'from'],
  date_end: ['date_end', 'end_date', 'year_end', 'end', 'until', 'to', 'end_year'],
  date_precision: ['precision', 'date_precision'],
  referenced_date: ['referenced_date', 'about_date', 'subject_date', 'setting_date', 'period', 'refers_to', 'era'],
  language: ['language', 'lang', 'idioma', 'langue', 'भाषा', 'ભાષા', 'locale', 'lang_code', 'language_code'],
  kind: ['kind', 'type', 'medium', 'document_type', 'doc_type', 'form'],
  genre: ['genre', 'genero', 'category', 'categorie'],
  community: ['community', 'scene', 'group', 'comunidad', 'communaute', 'audience'],
  culture: ['culture', 'country', 'country_of_origin', 'pais', 'pays', 'origin', 'nation'],
  field: ['field', 'discipline', 'subject_area', 'domain'],
  source_url: ['url', 'link', 'source_url', 'href', 'uri', 'source', 'permalink', 'web'],
  license: ['license', 'licence', 'rights', 'licencia', 'copyright'],
  cites: ['cites', 'refs', 'references', 'citations', 'cited', 'cited_ids', 'sources_cited', 'quotes'],
  relations: ['relations', 'related', 'links', 'relationships'],
  tags: ['tags', 'keywords', 'labels', 'subjects', 'themes', 'topics'],
  notes: ['notes', 'note', 'comment', 'comments', 'remarks', 'description'],
});

/** Fold a header for synonym matching. */
export function foldHeader(h) {
  return String(h ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC').toLowerCase().trim()
    .replace(/[\s\-./]+/g, '_').replace(/^_+|_+$/g, '');
}

const SYN_INDEX = (() => {
  const m = new Map();
  for (const [target, names] of Object.entries(SYNONYMS)) for (const n of names) if (!m.has(foldHeader(n))) m.set(foldHeader(n), target);
  return m;
})();

const nonEmpty = (v) => v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '') && !(Array.isArray(v) && !v.length);
const asText = (v) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) ? v.join('; ') : JSON.stringify(v));

/**
 * Infer a column's type from its values (§5.2: "text|date|number|id|url|lang|list").
 * @param {string} name
 * @param {unknown[]} values all sampled values (blanks included)
 * @param {{now?: Date}} [opts]
 * @returns {{inferred: string, dateShare: number, avgLength: number, unique: boolean, distinct: number, listSep: string|null, filled: number}}
 */
export function inferColumn(name, values, { now = new Date() } = {}) {
  const vals = values.filter(nonEmpty);
  const n = vals.length;
  const texts = vals.map(asText);
  const avgLength = n ? texts.reduce((s, t) => s + t.length, 0) / n : 0;
  const distinctN = new Set(texts).size;
  const unique = n > 0 && distinctN === n;
  const distinct = n ? distinctN / n : 0;
  const out = (inferred, extra = {}) => ({ inferred, dateShare: 0, avgLength, unique, distinct, listSep: null, filled: n, ...extra });
  if (!n) return out('text');
  if (vals.some(Array.isArray) && vals.filter(Array.isArray).length >= n / 2) return out('list', { listSep: null });
  const share = (pred) => texts.filter(pred).length / n;
  if (share((t) => /^https?:\/\/\S+$/i.test(t.trim())) > 0.8) return out('url');
  if (share((t) => t.length <= 30 && normalizeLang(t) !== null && (t.length <= 3 || /^[\p{L}-]+$/u.test(t))) > 0.8
    && share((t) => t.length > 3 || /^[a-z]{2,3}([-_][a-z0-9]{2,8})*$/i.test(t.trim())) > 0.8) return out('lang');
  const folded = foldHeader(name);
  const idName = SYN_INDEX.get(folded) === 'ext_id';
  const allInt = share((t) => /^-?\d+$/.test(t.trim())) === 1;
  const dateShare = share((t) => {
    const p = parseDate(t, { now });
    return !p.issue && p.lo_day !== null;
  });
  const thisYear = now.getUTCFullYear();
  const plausibleYears = allInt && share((t) => { const y = Number(t); return y >= 1000 && y <= thisYear + 10; }) === 1;
  if (dateShare > DATE_SHARE && !idName && (!allInt || plausibleYears) && !(allInt && unique && n >= 20 && !SYN_INDEX.get(folded))) {
    return out('date', { dateShare });
  }
  if (share((t) => /^[-+]?\d+([.,]\d+)?$/.test(t.trim())) > 0.8) {
    return out(idName || (allInt && unique) ? 'id' : 'number', { dateShare });
  }
  for (const sep of [';', '|']) {
    const withSep = share((t) => t.includes(sep));
    if (withSep >= 0.3 && avgLength < 200) return out('list', { listSep: sep, dateShare });
  }
  if (unique && avgLength <= 40 && share((t) => !/\s/.test(t.trim())) > 0.9) return out('id', { dateShare });
  return out('text', { dateShare });
}

/** Language values found in a column → an explicit map transform for the names that are not codes. */
function languageMap(values) {
  const map = {};
  for (const v of new Set(values.filter(nonEmpty).map((x) => asText(x).trim()))) {
    const code = normalizeLang(v);
    if (code && code !== v) map[v] = code;
  }
  return Object.keys(map).length ? map : null;
}

/**
 * Pre-fill each canonical target from header synonyms and sampled values.
 * @param {Array<{name: string, samples: unknown[], values?: unknown[], inferred?: string}>} columns `values` = every
 *   sampled value (up to a few hundred), `samples` = the 5 shown
 * @param {{format?: string, delimiter?: string|null, header?: boolean|null, encoding?: string, pointer?: string|null,
 *   fileName?: string, collection?: object|null, now?: Date}} [opts]
 * @returns {object} a mapping (§5.2) whose fields carry a `reason`
 */
export function suggestMapping(columns, { format = 'csv', delimiter = null, header = null, encoding = 'utf-8', pointer = null,
  fileName = 'import', collection = null, now = new Date() } = {}) {
  const info = columns.map((c) => ({ ...c, ...inferColumn(c.name, c.values ?? c.samples ?? [], { now }), folded: foldHeader(c.name) }));
  const fields = {};
  const used = new Set();
  const take = (target, col, reason, extra = {}) => {
    fields[target] = { from: col.name, ...extra, reason };
    used.add(col.name);
  };

  // 1. header synonyms (first match per target wins; a column serves one target), checked against the values
  const datey = (c) => !c.filled || c.inferred === 'date' || c.dateShare >= 0.3;
  const guard = {
    ext_id: (c) => !c.filled || c.distinct >= 0.5,
    source_url: (c) => c.inferred === 'url' || ['url', 'link', 'href', 'uri', 'source_url', 'permalink'].includes(c.folded),
    date: datey, date_end: datey, referenced_date: datey,
    text: (c) => c.inferred !== 'number' && c.inferred !== 'date',
    language: (c) => !c.filled || c.inferred === 'lang' || c.avgLength <= 24,
  };
  for (const col of info) {
    const target = SYN_INDEX.get(col.folded);
    if (!target || fields[target] || used.has(col.name)) continue;
    if (guard[target] && !guard[target](col)) continue;
    take(target, col, `header '${col.name}' is a common name for ${target.replace('_', ' ')}`);
  }
  // 2. value sniffing
  if (!fields.date) {
    const best = info.filter((c) => !used.has(c.name) && c.inferred === 'date').sort((a, b) => b.dateShare - a.dateShare)[0];
    if (best) take('date', best, `${Math.round(best.dateShare * 100)}% of sampled values parse as dates`);
  }
  if (!fields.text) {
    const best = info.filter((c) => !used.has(c.name) && c.inferred === 'text' && c.avgLength >= 20).sort((a, b) => b.avgLength - a.avgLength)[0];
    if (best) take('text', best, `longest average value (${Math.round(best.avgLength)} characters)`);
  }
  if (!fields.title) {
    const best = info.filter((c) => !used.has(c.name) && c.inferred === 'text' && c.avgLength > 0 && c.avgLength < 160)
      .sort((a, b) => a.avgLength - b.avgLength).pop();
    if (best && fields.text) take('title', best, `short text column (average ${Math.round(best.avgLength)} characters)`);
  }
  if (!fields.ext_id) {
    const best = info.find((c) => !used.has(c.name) && c.inferred === 'id' && c.unique);
    if (best) take('ext_id', best, 'every sampled value is distinct and id-like');
  }
  if (!fields.language) {
    const best = info.find((c) => !used.has(c.name) && c.inferred === 'lang');
    if (best) take('language', best, 'values are language names or codes');
  }
  if (!fields.source_url) {
    const best = info.find((c) => !used.has(c.name) && c.inferred === 'url');
    if (best) take('source_url', best, 'values are web addresses');
  }

  // 3. transforms
  if (fields.title) fields.title.transform = ['trim'];
  for (const t of ['date', 'date_end', 'referenced_date']) {
    if (fields[t]) fields[t].transform = [{ date: { circa_radius: 5, two_digit_century: null } }];
  }
  if (fields.language) {
    const col = info.find((c) => c.name === fields.language.from);
    const map = languageMap(col?.values ?? col?.samples ?? []);
    if (map) fields.language.transform = [{ map }];
  }
  for (const t of ['cites', 'tags']) {
    if (!fields[t]) continue;
    const col = info.find((c) => c.name === fields[t].from);
    if (col?.inferred === 'list' && col.listSep === null) continue; // JSON arrays need no split
    const sep = col?.listSep ?? (t === 'tags' && (col?.values ?? []).some((v) => typeof v === 'string' && v.includes(',') && !v.includes(';')) ? ',' : ';');
    fields[t].transform = [{ split: sep }];
  }
  if (format === 'txt' || format === 'md') {
    fields.text = { from: 'text', reason: `the body of the ${format.toUpperCase()} file` };
    if (!fields.title) fields.title = { from: 'title', transform: ['trim'], reason: 'the title line, front matter, first heading or file name' };
  }

  const stem = fileStem(fileName);
  const coll = {
    slug: slugify(collection?.slug || collection?.name || stem),
    name: collection?.name || stem,
    unit: collection?.unit === 'works' || collection?.unit === 'tokens' ? collection.unit : fields.text ? 'tokens' : 'works',
    license: collection?.license ?? null,
  };
  const out = { format, encoding, collection: coll, fields, options: { dedupe: 'flag', detect_language: true, on_bad_row: 'skip_and_report', line_mode: false } };
  if (format === 'csv' || format === 'tsv') { out.delimiter = delimiter ?? (format === 'tsv' ? '\t' : ','); out.header = header ?? true; }
  if (format === 'json') out.pointer = pointer ?? '';
  return out;
}
