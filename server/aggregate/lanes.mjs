// OWNER: WP3
// lanes.mjs — lane facets, keys, labels and order rules (SPEC §1.3, §1.2 item 8).
//
// A lane is a facet value × unit class. Units never mix: text (tokens) and titles (works) evidence of one facet
// value become sub-lanes. Keys are data-independent: `community:classroom` for text evidence,
// `community:classroom~titles` / `~abstracts` for the others (the modality facet's value already is the unit
// class). Lane order is a sorting choice, never derived from an embedding or projection.
//
// Contract 1.3.0 adds two facets whose lanes are not one document column:
//  · `trail` — the Term trail's fixed lane set (vocab.TRAIL_LANES): the lane follows from the collection (domain,
//    sampling), the STEMM field and the field class, and its unit class from the lane itself: text (tokens), titles
//    (works) or `cells` (OpenAlex works, counted once whether the title or the abstract matches; shares per cell).
//    Rows outside every trail lane (user imports, describing passages, Wikisource title stubs) are outside the slice
//    and counted apart.
//  · `cluster` — one lane per context group of a clustering run, `cluster:<run>:<ord>` (+ `cluster:<run>:residual`):
//    the value is per occurrence, so callers provide it as the `grp` column of their rows (clusterlanes.groupCaseSql).

import { LANE_FACETS, LANE_ORDER_NOTE, SAMPLING_LABELS, STEMM_LANES, TRAIL_LANES } from '../../src/shared/vocab.mjs';
import { stmt } from '../db/open.mjs';
import { COMMUNITIES } from '../../data/demo/generator.mjs';

const TRAIL_BY_KEY = new Map(TRAIL_LANES.map((l) => [l.key, l]));
const TRAIL_TEXT_FIELDS = STEMM_LANES.map((l) => l.key);
const TRAIL_CELL_FIELDS = STEMM_LANES.filter((l) => l.openalex.length).map((l) => l.key);
const sqlList = (xs) => xs.map((x) => `'${x}'`).join(', ');
/** Unit class of each trail lane kind: what its counts and denominators are made of. */
const TRAIL_UNIT_CLASS = Object.freeze({ 'literature-text': 'text', 'stemm-text': 'text', 'stemm-abstracts': 'cells',
  'culture-titles': 'titles', 'music-relations': 'titles', etymology: 'none' });

/**
 * The trail lane value (key without `trail:`) of a row, as SQL over collection `c`, document `d` and a row's field
 * class; NULL outside every trail lane.
 * @param {{fc: string}} cols
 * @returns {string}
 */
export function trailValueSql(cols) {
  const fc = cols.fc;
  const textish = `${fc} NOT IN ('title', 'abstract')`;
  return `(CASE WHEN c.sampling = 'relation_endpoints' THEN (CASE WHEN ${fc} = 'title' THEN 'music-relations' END)
    WHEN c.sampling = 'top_cited_per_cell' THEN (CASE WHEN ${fc} IN ('title', 'abstract') AND d.field IN (${sqlList(TRAIL_CELL_FIELDS)})
      THEN 'stemm-abstracts:' || d.field END)
    WHEN c.domain = 'literature' THEN (CASE WHEN ${textish} THEN 'literature-text' END)
    WHEN c.domain = 'stemm' THEN (CASE WHEN ${textish} AND d.field IN (${sqlList(TRAIL_TEXT_FIELDS)}) THEN 'stemm-text:' || d.field END)
    WHEN c.domain = 'culture' THEN (CASE WHEN ${fc} = 'title' THEN 'culture-titles' END) END)`;
}

/**
 * JS twin of trailValueSql for one row.
 * @param {{sampling?: string|null, domain?: string|null, field?: string|null, field_class: string}} r
 * @returns {string|null}
 */
export function trailValueOfRow(r) {
  const fc = r.field_class, textish = fc !== 'title' && fc !== 'abstract';
  if (r.sampling === 'relation_endpoints') return fc === 'title' ? 'music-relations' : null;
  if (r.sampling === 'top_cited_per_cell') return (fc === 'title' || fc === 'abstract') && TRAIL_CELL_FIELDS.includes(r.field) ? `stemm-abstracts:${r.field}` : null;
  if (r.domain === 'literature') return textish ? 'literature-text' : null;
  if (r.domain === 'stemm') return textish && TRAIL_TEXT_FIELDS.includes(r.field) ? `stemm-text:${r.field}` : null;
  if (r.domain === 'culture') return fc === 'title' ? 'culture-titles' : null;
  return null;
}

/** The trail lane definition (vocab.TRAIL_LANES row) of a lane key or value, or null. */
export function trailLane(keyOrValue) {
  const k = String(keyOrValue ?? '');
  return TRAIL_BY_KEY.get(k.startsWith('trail:') ? k : `trail:${k}`) ?? null;
}

/** Unit class of a trail lane value: 'text' | 'titles' | 'cells' | 'none'. */
export function trailUnitClass(value) {
  const l = trailLane(value);
  return l ? TRAIL_UNIT_CLASS[l.kind] : 'text';
}

/** The unit class of a trail row as SQL (aligned with trailValueSql for every row that has a trail lane). */
const trailUnitSql = () => `(CASE WHEN c.sampling = 'top_cited_per_cell' THEN 'cells'
  WHEN c.sampling = 'relation_endpoints' OR c.domain = 'culture' THEN 'titles' ELSE 'text' END)`;

/**
 * The unit class of a row under a facet as SQL: the field class's unit (text · titles · abstracts), except on the
 * Term trail where the lane decides it (OpenAlex works count once as `cells`).
 * @param {string} facet
 * @param {{plang: string, fc: string}} cols
 * @returns {string}
 */
export function unitClassSql(facet, cols) {
  return facet === 'trail' ? trailUnitSql() : unitSql(cols);
}

/**
 * Column names of a passage-level row: expr_doc / doc_tokens have `plang` and `field_class`, passage has
 * `lang` and `field_class`.
 * @param {string} a table alias
 * @param {boolean} [passage=false] whether the alias is the passage table
 * @param {string|null} [grp] SQL of the row's context-group key (cluster facet only)
 * @returns {{plang: string, fc: string, grp?: string}}
 */
export const rowCols = (a, passage = false, grp = null) => ({ plang: `${a}.${passage ? 'lang' : 'plang'}`, fc: `${a}.field_class`,
  ...(grp ? { grp } : {}) });

/** The unit class of a passage-level row as SQL. @param {{fc: string}} cols */
export const unitSql = (cols) => `CASE ${cols.fc} WHEN 'title' THEN 'titles' WHEN 'abstract' THEN 'abstracts' ELSE 'text' END`;

/**
 * SQL expression of a facet's lane value over document `d`, collection `c` and a passage-level row (expr_doc,
 * doc_tokens or passage columns). The cluster facet needs a clustering run (WP4); until one exists it falls back
 * to language (§4.11).
 * @param {string} facet
 * @param {{plang: string, fc: string}} cols
 * @returns {string}
 */
export function facetSql(facet, cols) {
  switch (facet) {
    case 'trail': return trailValueSql(cols);
    case 'cluster':
      if (!cols.grp) throw new RangeError('the cluster facet needs the rows\' context group (cols.grp)');
      return cols.grp;
    case 'domain': return 'c.domain';
    case 'community': return 'd.community';
    case 'kind': return 'd.kind';
    case 'culture': return 'd.culture';
    case 'collection': return 'c.slug';
    case 'field': return 'd.field';
    case 'date_basis': return 'd.basis';
    case 'modality': return unitSql(cols);
    case 'language': return cols.plang;
    default: throw new RangeError(`unknown lane facet '${facet}'`);
  }
}

/**
 * JS twin of facetSql for one row (document `d.*` columns plus `domain`, `coll`, `plang`, `field_class`): the
 * lane key of the row under a facet. Used where rows are resolved in JS (arc endpoints).
 * @param {string} facet
 * @param {{domain?: string, coll?: string, community?: string|null, kind?: string, culture?: string|null, field?: string|null,
 *   basis?: string, plang: string, field_class: string}} r
 * @returns {string}
 */
export function laneKeyOfRow(facet, r) {
  const uc = r.field_class === 'title' ? 'titles' : r.field_class === 'abstract' ? 'abstracts' : 'text';
  if (facet === 'trail') { const v = trailValueOfRow(r); return v === null ? null : `trail:${v}`; }
  if (facet === 'cluster') return r.grp ? laneKey(facet, r.grp, uc) : null;
  const value = { domain: r.domain, community: r.community, kind: r.kind, culture: r.culture, collection: r.coll, field: r.field,
    date_basis: r.basis, modality: uc, language: r.plang }[facet];
  return laneKey(facet, value, uc);
}

/** Placeholder value of a lane whose facet value is missing. */
export const NONE = '(none)';
const UNIT_SUFFIXES = new Set(['titles', 'abstracts']);

/**
 * @param {string} facet
 * @param {string|null} value
 * @param {'text'|'titles'|'abstracts'} unitClass
 * @returns {string}
 */
export function laneKey(facet, value, unitClass) {
  const v = value === null || value === undefined || value === '' ? NONE : String(value);
  // a trail lane's unit is part of the lane itself
  return facet === 'modality' || facet === 'trail' || unitClass === 'text' ? `${facet}:${v}` : `${facet}:${v}~${unitClass}`;
}

/**
 * @param {string} key
 * @returns {{facet: string, value: string|null, unitClass: string}}
 */
export function parseLaneKey(key) {
  const s = String(key ?? '');
  const i = s.indexOf(':');
  if (i <= 0) throw new RangeError(`not a lane key: '${s}'`);
  const facet = s.slice(0, i);
  if (!LANE_FACETS.includes(facet)) throw new RangeError(`unknown lane facet in '${s}'`);
  let value = s.slice(i + 1), unitClass = 'text';
  const t = value.lastIndexOf('~');
  if (t > 0 && UNIT_SUFFIXES.has(value.slice(t + 1))) { unitClass = value.slice(t + 1); value = value.slice(0, t); }
  if (facet === 'modality') unitClass = value;
  if (facet === 'trail') {
    if (!trailLane(value)) throw new RangeError(`not a Term trail lane: '${s}'`);
    unitClass = trailUnitClass(value);
  }
  return { facet, value: value === NONE ? null : value, unitClass };
}

const LANGUAGE_NAMES = {
  en: 'English', fr: 'French', es: 'Spanish', de: 'German', la: 'Latin', it: 'Italian', pt: 'Portuguese',
  hi: 'Hindi', gu: 'Gujarati', sa: 'Sanskrit', mr: 'Marathi', und: 'Unidentified language',
  'und-Latn': 'Unidentified (Latin script, too short to identify)',
};
const MODALITY_LABELS = { text: 'Text (full text)', titles: 'Titles', abstracts: 'Abstracts' };
const NONE_LABELS = { community: '(no community)', culture: '(no country of origin)', field: '(no field)', kind: '(no kind)' };

/** Domain lane labels where capitalising the value is wrong. */
const DOMAIN_LABELS = { stemm: 'STEMM' };

const humanize = (s) => {
  const t = String(s).replace(/[-_]+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
};

/**
 * Display label of a lane value.
 * @param {string} facet
 * @param {string|null} value
 * @param {'text'|'titles'|'abstracts'} unitClass
 * @param {{collectionNames?: Record<string, string>}} [opts]
 * @returns {string}
 */
export function laneLabel(facet, value, unitClass, { collectionNames = {} } = {}) {
  let base;
  if (facet === 'trail') return trailLane(value)?.label ?? String(value);
  if (value === null || value === undefined) base = NONE_LABELS[facet] ?? '(none)';
  else if (facet === 'cluster') base = String(value).endsWith(':residual') ? 'Other contexts' : `Context group ${String(value).split(':')[1]}`;
  else if (facet === 'language') base = LANGUAGE_NAMES[value] ?? value;
  else if (facet === 'modality') base = MODALITY_LABELS[value] ?? value;
  else if (facet === 'collection') base = collectionNames[value] ?? value;
  else if (facet === 'culture') base = String(value);
  // human labels, never the internal value (fix pass: 'Hiphop', 'Office lab', 'Stemm')
  else if (facet === 'community') base = COMMUNITIES[value] ?? humanize(value);
  else if (facet === 'domain') base = DOMAIN_LABELS[value] ?? humanize(value);
  else if (facet === 'field') base = STEMM_LANES.find((l) => l.key === value)?.label ?? humanize(value);
  else base = humanize(value);
  return facet === 'modality' || unitClass === 'text' ? base : `${base} · ${unitClass}`;
}

/**
 * Order lanes by a rule (§1.3). first_observed: earliest first observation, lanes without one after them
 * (alphabetical); total_n: descending n; alphabetical; manual: the given keys first, the rest alphabetical.
 * @param {Array<{key: string, label: string, n: number, firstDay: number|null}>} lanes
 * @param {string} rule
 * @param {string[]} [manual]
 * @returns {Array} a new array
 */
export function orderLanes(lanes, rule, manual = []) {
  const alpha = (a, b) => a.label.localeCompare(b.label, 'en') || a.key.localeCompare(b.key);
  const out = lanes.slice();
  if (rule === 'total_n') return out.sort((a, b) => b.n - a.n || alpha(a, b));
  if (rule === 'alphabetical') return out.sort(alpha);
  if (rule === 'manual') {
    const pos = new Map(manual.map((k, i) => [k, i]));
    return out.sort((a, b) => (pos.get(a.key) ?? Infinity) - (pos.get(b.key) ?? Infinity) || alpha(a, b));
  }
  return out.sort((a, b) => {
    if (a.firstDay === null && b.firstDay === null) return alpha(a, b);
    if (a.firstDay === null) return 1;
    if (b.firstDay === null) return -1;
    return a.firstDay - b.firstDay || alpha(a, b);
  });
}

/** The legend sentence printed with every lane order (§1.3). */
export function orderNote(rule) {
  const names = { first_observed: 'first observed', total_n: 'total n', alphabetical: 'alphabetical', manual: 'manual' };
  return LANE_ORDER_NOTE.replace('(first observed)', `(${names[rule] ?? rule})`);
}

/**
 * Selection wording for lane headers (honesty rule 14): every non-complete sampling among the lane's
 * collections, e.g. "selected by prominence".
 * @param {string[]} samplings
 * @returns {string|null}
 */
export function selectionNote(samplings) {
  const notes = [...new Set(samplings.filter((s) => s && s !== 'complete' && s !== 'user').map((s) => SAMPLING_LABELS[s] ?? s))];
  return notes.length ? notes.join('; ') : null;
}

/**
 * Lane values of a facet with their document counts in a corpus (every unit class, quality='ok' passages, no
 * filters), most documents first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{facet: string, corpus: string}} args
 * @returns {Array<{key: string, value: string|null, unitClass: string, label: string, docs: number}>}
 */
export function lanesFor(db, { facet, corpus }) {
  if (!LANE_FACETS.includes(facet)) throw new RangeError(`unknown lane facet '${facet}'`);
  if (facet === 'trail') return TRAIL_LANES.map((l) => ({ key: l.key, value: l.key.slice(6), unitClass: TRAIL_UNIT_CLASS[l.kind], label: l.label, docs: null }));
  if (facet === 'cluster') return [];
  const names = Object.fromEntries(stmt(db, 'SELECT slug, name FROM collection').all().map((r) => [r.slug, r.name]));
  const cols = rowCols('t');
  const rows = stmt(db, `SELECT ${facetSql(facet, cols)} AS lv, ${unitSql(cols)} AS uc, count(DISTINCT t.document_id) AS docs
    FROM doc_tokens t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
    JOIN corpus k ON k.id = c.corpus_id WHERE k.slug = ? AND d.deleted_at IS NULL GROUP BY lv, uc ORDER BY docs DESC`).all(corpus);
  return rows.map((r) => ({ key: laneKey(facet, r.lv, r.uc), value: r.lv, unitClass: r.uc,
    label: laneLabel(facet, r.lv, r.uc, { collectionNames: names }), docs: r.docs }));
}
