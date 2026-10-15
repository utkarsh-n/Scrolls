// OWNER: WP3
// routes/search.mjs — search with typed suggestions (SPEC §7.1, D16: expression · work · maker · theme), KWIC and
// titles. Heavy: runs in the read pool.
//
//   GET /api/search?q=&corpus=&scope=all|text|titles|works|makers|themes|etymology|annotations&f=&limit=
//
// Counts are exact and use the timeline's slice under the same filters (default toggles): a tracked expression
// reads its materialized run; an untracked one is matched on the fly over its FTS candidates (up to 5,000
// passages; beyond that the hits are FTS passage counts labelled preliminary). Trigram typeahead over titles and
// makers only suggests; it never counts (§4.4). Empty results are computed, with variants tried (§8.8).

import { formatCount, formatTokens } from '../../src/shared/format.mjs';
import { slugify } from '../../src/shared/ids.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { parseFilter } from '../../src/shared/viewstate.mjs';
import { TOGGLE_DEFAULTS } from '../../src/shared/vocab.mjs';
import { stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { ftsCandidates, passageHitCounts, passageRows, sampleCandidates } from '../aggregate/fts.mjs';
import { cubesCorpusSize, readyCubes } from '../aggregate/cube.mjs';
import { findLabels, peekLabelIndex } from '../aggregate/tagindex.mjs';
import { noteCorpusUse, warmAll } from '../aggregate/warm.mjs';
import { laneKey, rowCols } from '../aggregate/lanes.mjs';
import { COUNTED, occurrenceSql } from '../aggregate/marks.mjs';
import {
  corpusNames, expressionPayload, guessLanguage, matchPassages, strandLanguages, variantsOf,
} from '../aggregate/materialize.mjs';
import { buildDef, canonicalRequest, countValue, docWhere, provenanceOf, QUERY_VERSION, rowWhere, strandDocRows } from '../aggregate/query.mjs';
import { isVirtualCorpus, resolveCorpusScope } from '../aggregate/scope.mjs';
import { kwicRows } from '../text/kwic.mjs';
import { TRANSLIT_RULE, transliterationCandidates } from '../text/translit.mjs';
import { generateVariants, kindOfTokens } from '../text/variants.mjs';

const SEARCH_URL = import.meta.url;
/** Read timeout of a search (ms): the timeline query's, since a word's first search reads its candidates. */
export const SEARCH_TIMEOUT_MS = 15000;
const SCOPES = ['all', 'text', 'titles', 'works', 'makers', 'themes', 'etymology', 'annotations'];
const MAX_EXACT_CANDIDATES = 5000;
/** Maker names counted one by one while the maker index is being built. */
const FALLBACK_MAKERS = 12;

const wants = (scope, ...kinds) => scope === 'all' || kinds.includes(scope);

/** A def for counting an untracked search under the timeline's default slice (default toggles, filters `f`). */
function searchDef(scope, strand, f) {
  return { v: QUERY_VERSION, corpus: scope.slug, corpusId: scope.ids[0], corpusIds: scope.ids, virtual: scope.virtual,
    synthetic: scope.synthetic, strands: [strand], lanes: { facet: 'modality', order: 'first_observed', max: 10, manual: [] },
    f: parseFilter(f ?? ''), toggles: { ...TOGGLE_DEFAULTS }, timeBasis: 'publication' };
}

/** Passage ids of candidates that lie inside the def's slice (same SQL as every timeline count). */
function sliceFilter(db, def, ids, langs) {
  if (!ids.length) return new Set();
  const cols = rowCols('p', true);
  const a = docWhere(def), b = rowWhere(def, cols, langs);
  return new Set(stmt(db, `SELECT p.id FROM passage p JOIN document d ON d.id = p.document_id JOIN collection c ON c.id = d.collection_id
    WHERE p.id IN (SELECT value FROM json_each(?)) AND p.quality = 'ok' AND ${a.sql} AND ${b.sql}`)
    .all(JSON.stringify(ids), ...a.params, ...b.params).map((r) => r.id));
}

function docInfo(db, ids) {
  if (!ids.length) return new Map();
  return new Map(stmt(db, `SELECT d.id, d.title, d.kind, d.author, d.y_lo, d.y_hi, d.lo_day, d.hi_day, d.precision, d.date_label,
      d.chrono_status, d.is_synthetic, d.community, d.culture, d.field, d.basis, c.slug AS collection, c.domain, c.export_text_allowed
    FROM document d JOIN collection c ON c.id = d.collection_id WHERE d.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)).map((r) => [r.id, r]));
}

const yearOf = (d) => (d && d.chrono_status !== 'undated' ? d.y_lo : null);
const workLabel = (d) => `${d.title ?? '(untitled)'} — ${d.kind}${yearOf(d) !== null ? ` · ${d.date_label}` : ' · undated'}${d.is_synthetic ? ' (synthetic)' : ''}`;

/**
 * Exact counts of an untracked expression under a def: matches per variant, passages, documents, undated,
 * name-guard exclusions, KWIC candidates and matching titles.
 */
function onTheFly(db, def, scope, seqs, langs) {
  const phrases = seqs.map((s) => s.seq);
  let budget = MAX_EXACT_CANDIDATES;
  for (const id of scope.ids) {
    budget -= sampleCandidates(db, { phrases, corpusId: id, cap: budget + 1 }).length;
    if (budget < 0) return { preliminary: true };
  }
  // each corpus is matched with its own maker names (the title rule of the proper-noun guard), as when counted alone
  const found = [];
  for (const id of scope.ids) {
    const ids = ftsCandidates(db, { phrases, corpusId: id });
    const inSlice = sliceFilter(db, def, ids, langs);
    const rows = passageRows(db, ids.filter((i) => inSlice.has(i)));
    found.push(...matchPassages(db, rows, seqs, { names: corpusNames(db, id) }));
  }
  const byVariant = Object.fromEntries(seqs.map((s) => [s.id, 0]));
  const passages = new Set(), docs = new Set(), titleDocs = new Set();
  let names = 0;
  const kwic = [];
  for (const { passage: p, matches } of found) {
    for (const m of matches) {
      if (m.nameFlag && !def.toggles.nm) { names++; continue; }
      byVariant[m.variantId]++;
      passages.add(p.id);
      docs.add(p.document_id);
      if (p.field_class === 'title') titleDocs.add(p.document_id);
      kwic.push({ p, m });
    }
  }
  return { preliminary: false, byVariant, passages, docs, titleDocs, names, kwic };
}

/**
 * GET /api/search. Read-query convention (§12.2): runs in the read pool.
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{q: string, corpus?: string, scope?: string, f?: string, limit?: number, lang?: string|null}} args
 * @returns {object} Search payload (§7.2)
 */
export function searchQuery(db, { q, corpus: corpusSlug = 'demo', scope: scopeName = 'all', f = '', limit = 20, lang = null }) {
  const surface = String(q ?? '').trim();
  const tokens = tokenize(surface).tokens;
  if (!tokens.length) throw new HttpError(400, 'E_VALIDATION', 'The search is empty.', 'Type a word, a phrase, a title, a maker or a theme.', { field: 'q' });
  if (!SCOPES.includes(scopeName)) throw new HttpError(400, 'E_VALIDATION', `scope must be one of ${SCOPES.join(', ')}.`, null, { field: 'scope' });
  // contract 1.3.0: a corpus slug or the virtual corpus `real` (every non-synthetic corpus with documents, never the demo)
  const scope = resolveCorpusScope(db, corpusSlug);
  const corpus = { id: scope.ids[0], slug: scope.slug, is_synthetic: scope.synthetic ? 1 : 0 };
  const inScope = JSON.stringify(scope.ids);
  const lim = Math.max(1, Math.min(200, Number(limit) || 20));
  const norm = tokens.join(' ');
  const kind = kindOfTokens(tokens);
  // a word already tracked in this corpus in exactly one language is searched in that language (no guess needed)
  const tracked = lang ? [] : stmt(db, 'SELECT DISTINCT lang FROM expression WHERE kind = ? AND norm = ? AND corpus_id IN (SELECT value FROM json_each(?))')
    .all(kind, norm, inScope);
  const l = lang || (tracked.length === 1 ? tracked[0].lang : guessLanguage(db, tokens, scope.ids[0]));
  const generated = generateVariants(surface, { lang: l });

  // tracked = tracked in every corpus of the scope (a virtual corpus counts each member's expression)
  const own = scope.ids.map((id) => stmt(db, `SELECT id FROM expression WHERE kind = ? AND IFNULL(lang, '') = ? AND norm = ? AND corpus_id = ?`)
    .get(kind, l ?? '', norm, id) ?? null);
  const existing = own.every(Boolean) ? own[0] : null;
  const exprPayload = existing ? scopePayload(db, own.map((x) => x.id), scope) : null;
  const variants = existing
    ? variantsOf(db, existing.id).map((v) => ({ id: v.id, form: v.form, norm: v.norm, lang: v.lang, type: v.variant_type, rule: v.rule,
      status: v.evidence_status, enabled: v.enabled === 1 }))
    : [{ id: 0, form: surface, norm, lang: l, type: 'identity', rule: 'identity', status: 'documented', enabled: true },
      ...generated.map((v, i) => ({ ...v, id: i + 1 })),
      ...transliterationCandidates(db, surface).map((t, i) => ({ id: generated.length + i + 1, form: t.form, norm: t.norm, lang: null,
        type: 'transliteration', rule: TRANSLIT_RULE, status: 'computed', enabled: false }))];
  const enabled = variants.filter((v) => v.enabled);
  const langs = strandLanguages({ lang: l }, enabled.map((v) => ({ ...v, enabled: 1 })));

  const suggestions = [];
  const hits = { passages: 0, documents: 0, undated: 0, names_excluded: 0, preliminary: false };
  let kwic = [], titles = [], byVariant = {}, total = 0, runIds = {};

  if (wants(scopeName, 'text', 'titles', 'works')) {
    const run = exprPayload?.state.run ?? null;
    if (existing && run) {
      // tracked and counted: the materialized run under the default slice (same SQL as the timeline)
      const { def } = buildDef(db, canonicalRequest({ corpus: scope.slug, strands: [{ type: 'expression', ref: existing.id }],
        lanes: { facet: 'modality' }, f }));
      const strand = def.strands[0];
      runIds = { materialize: Object.fromEntries(strand.members.filter((m) => m.run).map((m) => [m.ref, m.run])) };
      const qs = occurrenceSql(def, strand);
      // counts from expr_doc (complete even when the contexts are a sample), exactly as the timeline counts
      const docRows = strandDocRows(db, def, strand);
      const counted = docRows.filter((r) => r.v > 0);
      total = docRows.reduce((acc, r) => acc + countValue(r.uc, [r]), 0);
      Object.assign(hits, { passages: counted.reduce((acc, r) => acc + r.passages, 0), documents: new Set(counted.map((r) => r.doc)).size,
        undated: new Set(counted.filter((r) => r.chrono_status === 'undated').map((r) => r.doc)).size });
      if (strand.sampled) hits.contexts_sampled = true;
      for (const v of exprPayload.variants) if (v.n !== null) byVariant[v.id] = v.n;
      hits.names_excluded = def.toggles.nm ? 0 : docRows.reduce((acc, r) => acc + r.names, 0);
      const krows = stmt(db, `WITH m AS (${qs.sql}) SELECT * FROM m WHERE ${COUNTED} AND uc = 'text' ORDER BY lo_day IS NULL, lo_day, occ LIMIT ?`)
        .all(...qs.params, lim).map((r) => ({ ...r, document_id: r.doc, is_synthetic: r.syn, lane: laneKey('modality', r.lv, r.uc) }));
      kwic = kwicRows(db, krows);
      const trows = stmt(db, `WITH m AS (${qs.sql}) SELECT DISTINCT doc FROM m WHERE ${COUNTED} AND uc = 'titles' LIMIT ?`).all(...qs.params, lim);
      const info = docInfo(db, trows.map((r) => r.doc));
      titles = trows.map((r) => info.get(r.doc)).filter(Boolean)
        .map((d) => ({ document_id: d.id, title: d.title ?? '', kind: d.kind, year: yearOf(d), synthetic: d.is_synthetic === 1 }));
    } else {
      const strand = { type: 'expression', ref: existing?.id ?? 0, key: 'search', run: null, langs, synthetic: scope.synthetic };
      const def = searchDef(scope, strand, f);
      const seqs = enabled.map((v) => ({ id: v.id, seq: v.norm.split(' ') }));
      const r = onTheFly(db, def, scope, seqs, langs);
      if (r.preliminary) {
        const counts = scope.ids.map((id) => passageHitCounts(db, { phrases: seqs.map((x) => x.seq), corpusId: id }));
        const add = (k) => counts.reduce((a, c) => a + (c[k] ?? 0), 0);
        Object.assign(hits, { passages: add('passages'), documents: add('documents') }, { preliminary: true });
      } else {
        const info = docInfo(db, [...r.docs]);
        Object.assign(hits, { passages: r.passages.size, documents: r.docs.size, names_excluded: r.names,
          undated: [...r.docs].filter((id) => info.get(id)?.chrono_status === 'undated').length });
        byVariant = r.byVariant;
        // works count once in title lanes; text matches count each
        total = r.kwic.filter((k) => k.p.field_class !== 'title').length + r.titleDocs.size;
        const textHits = r.kwic.filter((k) => k.p.field_class !== 'title')
          .sort((a, b) => (info.get(a.p.document_id)?.lo_day ?? Infinity) - (info.get(b.p.document_id)?.lo_day ?? Infinity));
        kwic = kwicRows(db, textHits.slice(0, lim).map(({ p, m }) => {
          const d = info.get(p.document_id);
          return { passage: p.id, document_id: p.document_id, field: p.field, p_start: p.start_off, p_end: p.end_off,
            start_off: m.start, end_off: m.end, title: d?.title, lo_day: d?.lo_day, hi_day: d?.hi_day, precision: d?.precision,
            date_label: d?.date_label, lane: laneKey('modality', 'text', 'text'), is_synthetic: d?.is_synthetic };
        }));
        titles = [...r.titleDocs].slice(0, lim).map((id) => info.get(id)).filter(Boolean)
          .map((d) => ({ document_id: d.id, title: d.title ?? '', kind: d.kind, year: yearOf(d), synthetic: d.is_synthetic === 1 }));
      }
    }
    const label = `${surface} (${kind}, ${l ?? 'any language'})`;
    suggestions.push({ type: 'expression', label, ref: existing ? `expression:${existing.id}` : 'expression:new',
      count: hits.preliminary ? null : total, preliminary: hits.preliminary });
  }

  // works: exact title matches first, then trigram typeahead (suggests, never counts)
  if (wants(scopeName, 'works', 'titles')) {
    const seen = new Set();
    for (const t of titles.slice(0, 5)) {
      const d = docInfo(db, [t.document_id]).get(t.document_id);
      seen.add(t.document_id);
      suggestions.push({ type: 'work', label: workLabel(d), ref: `document:${d.id}`, count: null });
    }
    if (surface.length >= 3) {
      const rows = scope.ids.flatMap((id) => trigram(db, surface, 'title', id, 10));
      for (const r of rows) {
        const id = Number(r.ref.split(':')[1]);
        if (seen.has(id) || seen.size >= 8) continue;
        seen.add(id);
        const d = docInfo(db, [id]).get(id);
        if (d) suggestions.push({ type: 'work', label: workLabel(d), ref: `document:${id}`, count: null, typeahead: true });
      }
    }
  }
  if (wants(scopeName, 'makers')) suggestions.push(...mergeSuggestions(scope.ids.flatMap((id) => makerSuggestions(db, surface, tokens, id))));
  if (wants(scopeName, 'themes')) suggestions.push(...mergeSuggestions(scope.ids.flatMap((id) => themeSuggestions(db, surface, tokens, id))));
  if (wants(scopeName, 'etymology')) suggestions.push(...etymologySuggestions(db, tokens, l));
  if (wants(scopeName, 'annotations')) suggestions.push(...annotationSuggestions(db, tokens));
  if (scopeName === 'all' && corpus.slug !== 'demo') suggestions.push(...adapterSuggestions(db));

  // a tracked expression whose run predates a revert can carry stale per-variant numbers: an empty current count is
  // empty whatever they say
  const identityCount = runIds.materialize && total === 0 ? 0 : byVariant[variants[0].id] ?? 0;
  const emptyNote = !hits.preliminary && wants(scopeName, 'text', 'titles', 'works') && identityCount === 0
    ? emptyNoteFor(db, scope, surface, variants, runIds.materialize && total === 0 ? {} : byVariant, titles, langs) : null;
  const strandForProv = { type: 'expression', ref: existing?.id ?? 0, run: runIds.materialize?.[existing?.id] ?? null,
    members: Object.entries(runIds.materialize ?? {}).map(([ref, run]) => ({ ref: Number(ref), run })) };
  return {
    query: { surface, norm, tokens, kind, lang: l,
      variants: variants.filter((v) => v.type !== 'identity').map((v) => ({ form: v.form, type: v.type, rule: v.rule, status: v.status,
        enabled: v.enabled, ...(byVariant[v.id] !== undefined && !hits.preliminary ? { n: byVariant[v.id] } : {}) })) },
    suggestions,
    expression: exprPayload ? { ...exprPayload.expression, state: exprPayload.state.status, n: exprPayload.state.n, job: exprPayload.state.job } : null,
    hits,
    kwic,
    titles,
    empty_note: emptyNote,
    provenance: provenanceOf(db, { corpus: scope.slug, corpusId: scope.ids[0], corpusIds: scope.ids, virtual: scope.virtual, synthetic: scope.synthetic,
      strands: strandForProv.run ? [strandForProv] : [] }),
  };
}

/**
 * The tracked expression of a search in its scope: the expression itself for one corpus; for a virtual corpus the
 * first member's, with the members' states added up (ready only when every member is).
 */
function scopePayload(db, ids, scope) {
  const all = ids.map((id) => expressionPayload(db, id));
  if (!scope.virtual) return all[0];
  const states = all.map((p) => p.state);
  const status = states.some((x) => x.status === 'materializing') ? 'materializing' : states.every((x) => x.status === 'ready') ? 'ready'
    : states.some((x) => x.status === 'failed') ? 'failed' : 'none';
  const sum = (k) => (states.every((x) => x[k] !== null && x[k] !== undefined) ? states.reduce((a, x) => a + x[k], 0) : null);
  const variants = all[0].variants.map((v) => {
    const same = all.map((p) => p.variants.find((x) => x.form === v.form && (x.lang ?? null) === (v.lang ?? null)));
    return { ...v, n: same.every((x) => x && x.n !== null) ? same.reduce((a, x) => a + x.n, 0) : null };
  });
  return { ...all[0], expression: { ...all[0].expression, corpus: scope.slug }, variants,
    state: { status, job: states.find((x) => x.job)?.job ?? null, run: status === 'ready' ? states[0].run : null, n: sum('n'), docs: sum('docs'),
      names_excluded: sum('names_excluded') },
    members: ids.map((id, i) => ({ id, state: states[i] })) };
}

/** Suggestions of several corpora: the same maker or theme once, counts added up, most first. */
function mergeSuggestions(list) {
  const by = new Map();
  for (const x of list) {
    const k = `${x.type}|${x.ref}`;
    const a = by.get(k);
    if (!a) { by.set(k, { ...x }); continue; }
    a.count = (a.count ?? 0) + (x.count ?? 0);
    if (x.type === 'maker') a.label = `${a.name} — ${formatCount(a.count)} document${a.count === 1 ? '' : 's'}`;
  }
  return [...by.values()].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 5);
}

function trigram(db, text, kind, corpusId, limit) {
  const qstr = `"${text.replace(/"/g, '""')}"`;
  try {
    // Join on the document's rowid (CAST of the ref), not on `'document:' || d.id`, which scans document per hit (M1 gate: 5 s on Cipher)
    return stmt(db, `SELECT l.label, l.ref FROM label_tri l JOIN document d ON d.id = CAST(substr(l.ref, 10) AS INTEGER)
      JOIN collection c ON c.id = d.collection_id
      WHERE label_tri MATCH ? AND l.kind = ? AND l.ref LIKE 'document:%' AND c.corpus_id = ? AND d.deleted_at IS NULL LIMIT ?`).all(qstr, kind, corpusId, limit);
  } catch {
    return [];
  }
}

/** Maker suggestions: from the maker index when it is ready, else from the trigram labels and the tag table. */
function makerSuggestions(db, surface, tokens, corpusId) {
  const label = (name, n) => ({ type: 'maker', label: `${name} — ${formatCount(n)} document${n === 1 ? '' : 's'}`,
    ref: `maker:${slugify(name)}`, name, count: n });
  const index = peekLabelIndex(db, corpusId, 'maker');
  if (index) return findLabels(index, tokens.join(' '), { limit: 5 }).map((r) => label(r.value, r.n));
  // fallback while the index is built: a bounded number of candidates, each counted with its own query
  const folded = tokens.join(' ');
  const names = new Set();
  const consider = (name) => { if (names.size < FALLBACK_MAKERS && tokenize(name).tokens.join(' ').includes(folded)) names.add(name); };
  if (surface.length >= 3) for (const r of trigram(db, surface, 'maker', corpusId, 30)) consider(r.label);
  for (const r of stmt(db, `SELECT DISTINCT t.value AS label FROM doc_tag t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
    WHERE t.scheme = 'maker' AND c.corpus_id = ? AND lower(t.value) LIKE ? LIMIT 20`).all(corpusId, `%${surface.toLowerCase()}%`)) consider(r.label);
  const out = [];
  for (const name of names) {
    const n = makerDocCount(db, name, corpusId);
    if (n) out.push(label(name, n));
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 5);
}

/**
 * Documents of a corpus whose author is `name` or that carry the maker tag `name` (the fallback while the maker index is
 * built). document.author has no index, so authors are found through the trigram index of maker labels when the name
 * is long enough for a trigram query.
 */
function makerDocCount(db, name, corpusId) {
  if ([...name].length >= 3) {
    try {
      return stmt(db, `SELECT count(*) AS n FROM (
          SELECT CAST(substr(l.ref, 10) AS INTEGER) AS id FROM label_tri l
            WHERE label_tri MATCH ? AND l.kind = 'maker' AND l.label = ? AND l.ref LIKE 'document:%'
          UNION SELECT document_id FROM doc_tag WHERE scheme = 'maker' AND value = ?) x
        JOIN document d ON d.id = x.id JOIN collection c ON c.id = d.collection_id
        WHERE c.corpus_id = ? AND d.deleted_at IS NULL`).get(`"${name.replace(/"/g, '""')}"`, name, name, corpusId).n;
    } catch { /* fall through to the scan */ }
  }
  return stmt(db, `SELECT count(DISTINCT d.id) AS n FROM document d JOIN collection c ON c.id = d.collection_id
    WHERE c.corpus_id = ? AND d.deleted_at IS NULL AND (d.author = ? OR d.id IN (SELECT document_id FROM doc_tag WHERE scheme = 'maker' AND value = ?))`)
    .get(corpusId, name, name).n;
}

/** Theme suggestions: from the theme index (trigram postings) when it is ready, else a LIKE scan of the theme tags. */
function themeSuggestions(db, surface, tokens, corpusId) {
  const folded = tokens.join(' ');
  const index = peekLabelIndex(db, corpusId, 'theme');
  const rows = index ? findLabels(index, folded, { limit: 5 }).map((r) => ({ value: r.value, n: r.n, provs: r.provenance.join(',') }))
    : stmt(db, `SELECT t.value, count(DISTINCT t.document_id) AS n, group_concat(DISTINCT t.provenance) AS provs FROM doc_tag t
      JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
      WHERE t.scheme = 'theme' AND c.corpus_id = ? AND d.deleted_at IS NULL AND lower(t.value) LIKE ? GROUP BY t.value ORDER BY n DESC LIMIT 20`)
      .all(corpusId, `%${surface.toLowerCase()}%`).filter((r) => tokenize(r.value).tokens.join(' ').includes(folded)).slice(0, 5);
  return rows.map((r) => ({ type: 'theme', label: `${r.value} (theme)`, ref: `theme:${r.value}`, count: r.n, provenance: String(r.provs).split(',') }));
}

function etymologySuggestions(db, tokens, lang) {
  if (tokens.length !== 1) return [];
  if (!stmt(db, 'SELECT 1 FROM etymon LIMIT 1').get()) return [];
  // with a language the (lang, norm) index answers at once; `? IS NULL OR m.lang = ?` made every search scan the members
  const rows = lang
    ? stmt(db, `SELECT DISTINCT m.key, e.lang, e.form, e.gloss FROM etymon_member m JOIN etymon e ON e.key = m.key
        WHERE m.lang = ? AND m.norm = ? LIMIT 5`).all(lang, tokens[0])
    : stmt(db, `SELECT DISTINCT m.key, e.lang, e.form, e.gloss FROM etymon_member m JOIN etymon e ON e.key = m.key
        WHERE m.norm = ? LIMIT 5`).all(tokens[0]);
  if (!rows.length) {
    return [{ type: 'etymology', label: "No etymology family in Cipher's roots data (Latin, Greek, Sanskrit, PIE only)", ref: 'etymon:none', count: null }];
  }
  return rows.map((r) => ({ type: 'etymology', label: `${r.form} (${r.lang})${r.gloss ? ` '${r.gloss}'` : ''} — listed by Wiktionary (via kaikki.org)`, ref: `etymon:${r.key}`, count: null }));
}

function annotationSuggestions(db, tokens) {
  try {
    // annotation_fts indexes every revision (rowid = revision id): count annotations whose current text mentions it
    const n = stmt(db, `SELECT count(DISTINCT a.id) AS n FROM annotation_fts f JOIN annotation_revision v ON v.id = f.rowid
      JOIN annotation a ON a.id = v.annotation_id AND a.current_rev = v.rev WHERE annotation_fts MATCH ?`).get(`"${tokens.join(' ').replace(/"/g, '""')}"`).n;
    return n ? [{ type: 'annotation', label: `${formatCount(n)} annotation${n === 1 ? ' mentions' : 's mention'} it`, ref: 'annotations', count: n }] : [];
  } catch {
    return [];
  }
}

function adapterSuggestions(db) {
  const rows = stmt(db, `SELECT a.label FROM source_adapter a WHERE a.id LIKE 'stemm.%' AND a.enabled = 1 AND NOT EXISTS
    (SELECT 1 FROM import_batch b WHERE b.adapter_id = a.id AND b.status = 'committed') ORDER BY a.id`).all();
  return rows.length ? [{ type: 'adapter', label: `STEMM sources not loaded yet: ${rows.map((r) => r.label).join(', ')}`, ref: 'adapters', count: null }] : [];
}

/**
 * The computed empty state (§8.8): what was searched, how big the index is, what the variants found, and
 * "0 is an observation about this index, not about culture."
 */
function emptyNoteFor(db, scope, surface, variants, byVariant, titles, langs) {
  // the size of the counted collections, from the slice cubes; the last year with full text in the query's languages
  // (as the modality seam reads it: modern Wikisource texts no longer make English full text "end" in 2023). A search
  // never waits for a large cube: until warm.mjs has built it, the note says the size is still being computed.
  const cubes = readyCubes(db, scope.ids);
  const size = cubes ? cubesCorpusSize(cubes, langs) : null;
  const parts = [];
  if (size?.tokens) parts.push(`${formatTokens(size.tokens)} tokens of full text${size.last_text !== null ? ` to ${size.last_text}` : ''}`);
  if (size?.works) parts.push(`${formatCount(size.works)} titles`);
  const sizeText = size ? (parts.length ? ` (${parts.join('; ')})` : '') : ' (its size is still being computed)';
  let note = `No occurrences of '${surface}' in the loaded corpus${sizeText}.`;
  const found = variants.filter((v) => v.type !== 'identity' && (byVariant[v.id] ?? 0) > 0);
  for (const v of found) {
    const n = byVariant[v.id];
    const what = v.type === 'inflection' ? `the ${v.form.endsWith('s') ? 'plural' : 'inflected'} variant '${v.form}'` : `the variant '${v.form}' (${v.type})`;
    const sample = titles[0] ? ` — ${titles[0].title} (${titles[0].kind}${titles[0].year !== null ? `, ${titles[0].year}` : ''})` : '';
    note += ` With ${what}: ${formatCount(n)} match${n === 1 ? '' : 'es'}${sample}.`;
  }
  return `${note} 0 is an observation about this index, not about culture.`;
}

/** @type {Array<{method: string, path: string, heavy?: boolean, handler: Function}>} */
export const routes = [
  {
    method: 'GET',
    path: '/api/search',
    heavy: true,
    async handler(req, ctx) {
      const q = req.query;
      const limit = q.limit === undefined ? 20 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, 'E_BAD_LIMIT', `limit must be a positive integer (got '${q.limit}').`, 'Use 1–200.');
      // the first request warms every corpus's shared artifacts in a read worker (cube, label and name indexes), so
      // the next search does not pay their scans
      warmAll(ctx);
      if (isVirtualCorpus(q.corpus)) for (const r of stmt(ctx.db, "SELECT id FROM corpus WHERE is_synthetic = 0 AND slug <> 'demo'").all()) noteCorpusUse(ctx, r.id);
      else noteCorpusUse(ctx, stmt(ctx.db, 'SELECT id FROM corpus WHERE slug = ?').get(String(q.corpus ?? 'demo'))?.id);
      // the first search of a word reads its candidate documents: on a loaded machine that passes 5 s (fix pass: 503s in
      // the console from the start card), so it gets the timeline query's limit
      const body = await ctx.pool.run(SEARCH_URL, 'searchQuery', { q: q.q, corpus: q.corpus ?? 'demo', scope: q.scope ?? 'all',
        f: q.f ?? '', limit, lang: q.lang ?? null }, { timeoutMs: SEARCH_TIMEOUT_MS });
      return { json: body };
    },
  },
];
