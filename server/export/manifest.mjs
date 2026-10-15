// OWNER: WP3
// manifest.mjs — exports (SPEC §7.3): the manifest that travels with every export and the export itself.
//
//   GET /api/export?view=<slug>|state=<b64url or #hash>&what=occurrences|aggregates|passages|relationships|annotations
//       &format=json|jsonl|csv
//
// The manifest comes first (JSON key, JSONL first line, CSV `#` lines): view, state, data version, runs with their
// params, filters, toggles, whether synthetic rows are included, licences and attributions. Rows always carry
// evidence_status, review_status, origin, is_synthetic, date_label/precision/basis/role, offsets and
// source_locator where relevant. Collections with export_text_allowed = 0 (OpenAlex abstracts) export ids,
// offsets and locators only: their text fields are null and `text_withheld` is true, in every format.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { binOf } from '../../src/shared/dates.mjs';
import { canonicalize, decode, encode, formatFilter } from '../../src/shared/viewstate.mjs';
import { CELL_STATES, REL_TYPE_BY_CODE } from '../../src/shared/vocab.mjs';
import { paths } from '../config.mjs';
import { dataVersion, nowIso, stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { relationshipsTouching, strandDocIds } from '../aggregate/arcs.mjs';
import { laneKey } from '../aggregate/lanes.mjs';
import { COUNTED, occurrenceSql } from '../aggregate/marks.mjs';
import { countValue, defFromViewState, provenanceOf, strandDocRows, strandLangSpec } from '../aggregate/query.mjs';
import { SHARE_GATE, SHARE_LANE_NOTE, shareCells } from '../aggregate/trail.mjs';
import { computeTiles } from '../aggregate/tiles.mjs';
import { binLabel } from '../aggregate/bin.mjs';
import { kwic, passageBase } from '../text/kwic.mjs';
import { csvManifest, toCsv } from './csv.mjs';
import { jsonlExport } from './jsonl.mjs';
import { bundleHtml } from './bundle-html.mjs';

export const EXPORT_VERSION = '1';
const WHATS = ['occurrences', 'aggregates', 'passages', 'relationships', 'annotations', 'bundle'];
const FORMATS = { json: 'application/json; charset=utf-8', jsonl: 'application/x-ndjson; charset=utf-8', csv: 'text/csv; charset=utf-8' };
const MAX_ROWS = 500000;
const SYNTHETIC_WARNING = 'Contains SYNTHETIC demonstration data — invented people, texts, dates and links.';
/** Attributions that must travel with values of these sources (§7.3, honesty rule 15). */
const STANDARD_ATTRIBUTIONS = [
  [/wiktionary|kaikki/i, 'Wiktionary (via kaikki.org), CC BY-SA'],
  [/itwofs/i, 'ItwoFS, CC BY 2.5 (link back per row)'],
  [/ngram/i, 'Google Books Ngram Viewer (http://books.google.com/ngrams), CC BY 3.0'],
  [/openalex/i, 'OpenAlex, CC0'],
  [/gutenberg/i, 'Project Gutenberg texts: public domain in the USA'],
  [/wikisource/i, 'Wikisource, CC BY-SA'],
];

// ── state resolution ────────────────────────────────────────────────────────────────────────────────

/**
 * The ViewState an export describes: a saved view (by slug) or a state given as base64url JSON, base64url of a
 * URL hash, or the hash itself.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{view?: string|null, state?: string|null}} args
 * @returns {{state: object, view: string|null}}
 * @throws {HttpError} 400 / 404
 */
export function resolveState(db, { view = null, state = null }) {
  if (view) {
    const row = stmt(db, 'SELECT slug, state_json FROM saved_view WHERE slug = ? AND deleted_at IS NULL').get(String(view));
    if (!row) throw new HttpError(404, 'E_NOT_FOUND', `No saved view '${view}'.`);
    return { state: canonicalize(JSON.parse(row.state_json)), view: row.slug };
  }
  if (!state) throw new HttpError(400, 'E_VALIDATION', 'An export needs view=<slug> or state=<…>.', 'Export from a saved view, or pass the current state.', { field: 'state' });
  const s = String(state).trim();
  if (s.startsWith('#') || s.startsWith('v=')) return { state: decode(s.startsWith('#') ? s : `#${s}`), view: null };
  let text;
  try { text = Buffer.from(s, 'base64url').toString('utf8'); } catch { text = ''; }
  if (text.trim().startsWith('{')) {
    try { return { state: canonicalize(JSON.parse(text)), view: null }; } catch { /* fall through */ }
  }
  if (text.startsWith('#') || text.startsWith('v=')) return { state: decode(text.startsWith('#') ? text : `#${text}`), view: null };
  throw new HttpError(400, 'E_VALIDATION', 'state is neither a view-state hash nor base64url JSON.', null, { field: 'state' });
}

// ── manifest ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The manifest that travels with every export.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{view?: string|null, state?: object|null, what: string, format: string, def?: object|null, rows?: object[]}} args
 * @returns {object}
 */
export function buildManifest(db, { view = null, state = null, what, format, def = null, rows = [] }) {
  const prov = def ? provenanceOf(db, def) : { collections: [], licenses: [] };
  const runIds = { materialize: {} };
  const sampled = [];
  for (const s of def?.strands ?? []) {
    if (s.type !== 'expression' || !s.run) continue;
    // every member corpus's run (one for a single corpus; one per member of a virtual corpus)
    for (const m of s.members ?? [{ ref: s.ref, run: s.run }]) {
      if (!m.ref || !m.run) continue;
      const r = stmt(db, 'SELECT params_json, pipeline_version FROM analysis_run WHERE id = ?').get(m.run);
      runIds.materialize[m.ref] = { run: m.run, pipeline: r?.pipeline_version ?? null, params: r ? JSON.parse(r.params_json) : null };
    }
    if (s.sampled) sampled.push(s.ref);
  }
  if (def?.cluster?.run) runIds.cluster = def.cluster.run;
  const colls = def ? stmt(db, `SELECT slug, license, attribution, adapter_id FROM collection WHERE corpus_id IN (SELECT value FROM json_each(?))
    ORDER BY slug`).all(JSON.stringify(def.corpusIds ?? [def.corpusId])) : [];
  const attributions = new Set(colls.map((c) => c.attribution).filter(Boolean));
  for (const c of colls) {
    for (const [re, text] of STANDARD_ATTRIBUTIONS) if (re.test(`${c.slug} ${c.adapter_id}`) && !attributions.has(text)) attributions.add(text);
  }
  const synthetic = rows.some((r) => r.is_synthetic === 1 || r.is_synthetic === true) || (rows.length === 0 && Boolean(prov.synthetic));
  const m = {
    export_version: EXPORT_VERSION,
    generated_at: nowIso(),
    view,
    state: state ? encode(state) : null,
    what, format,
    data_version: dataVersion(db),
    run_ids: runIds,
    filters: def ? formatFilter(def.f) : null,
    toggles: def?.toggles ?? null,
    synthetic_included: synthetic,
    licenses: prov.licenses,
    attributions: [...attributions],
    collections: prov.collections,
    tokenizer: 'u61m-1',
    segmenter: 'seg-1',
    rows: rows.length,
    text_policy: 'Collections with export_text_allowed = 0 export ids, offsets and locators only (text_withheld = true).',
  };
  if (synthetic) m.warning = SYNTHETIC_WARNING;
  if (def && (what === 'relationships' || what === 'bundle')) {
    m.relationship_scope = 'relationships with an end in a document where a pinned strand is observed (the arcs of this view)';
  }
  if (rows.some((r) => r.kind === 'share_cell')) {
    m.share_cells_note = `share_cell rows: k of n top-cited works sampled in one OpenAlex field × period cell mention the term (${SHARE_LANE_NOTE}); no share or CI below n = ${SHARE_GATE}; never compare shares across cells.`;
  }
  if (sampled.length) {
    m.contexts_sampled = sampled;
    m.sampling_note = 'Very frequent expressions: aggregate counts are complete; occurrence and passage rows are a stratified sample of ≤ 200 per language and decade.';
  }
  return m;
}

// ── rows ────────────────────────────────────────────────────────────────────────────────────────────

const OCC_COLUMNS = ['occ', 'passage', 'document', 'title', 'lane', 'start', 'end', 'match', 'date_label', 'date_precision',
  'date_basis', 'date_role', 'evidence_status', 'review_status', 'origin', 'source_locator', 'is_synthetic', 'expression', 'variant',
  'collection', 'field', 'chrono_status', 'name_flag', 'context_left', 'context_right', 'text_withheld'];

function occurrenceRows(db, def) {
  const out = [];
  for (const s of def.strands) {
    if (s.type !== 'expression' || !s.run) continue;
    const forms = new Map(stmt(db, 'SELECT id, form FROM expression_variant WHERE expression_id = ?').all(s.ref).map((v) => [v.id, v.form]));
    const q = occurrenceSql(def, s);
    const rows = stmt(db, `WITH m AS (${q.sql}) SELECT m.*, (SELECT source_url FROM document WHERE id = m.doc) AS source_url FROM m
      WHERE ${COUNTED} ORDER BY lo_day IS NULL, lo_day, occ LIMIT ?`).all(...q.params, MAX_ROWS);
    for (const r of rows) {
      const withheld = r.export_text_allowed === 0;
      let k = null;
      if (!withheld) {
        const base = passageBase(db, { document_id: r.doc, field: r.field }) ?? '';
        k = kwic(base, r.start_off, r.end_off, { clipStart: r.p_start, clipEnd: r.p_end });
      }
      out.push({
        occ: r.occ, passage: r.passage, document: r.doc, title: r.title, lane: laneKey(def.lanes.facet, r.lv, r.uc),
        start: r.start_off, end: r.end_off, match: withheld ? null : k.match, date_label: r.date_label, date_precision: r.precision,
        date_basis: r.basis, date_role: r.date_role, evidence_status: null, review_status: null, origin: null,
        source_locator: r.source_url ?? null, is_synthetic: r.syn, expression: s.ref, variant: forms.get(r.variant_id) ?? null,
        collection: r.collection, field: r.field, chrono_status: r.chrono_status, name_flag: r.name_flag,
        context_left: withheld ? null : k.left, context_right: withheld ? null : k.right, text_withheld: withheld ? 1 : 0,
      });
    }
  }
  return { rows: out, columns: OCC_COLUMNS };
}

const PASSAGE_COLUMNS = ['passage', 'document', 'title', 'lane', 'field', 'start', 'end', 'n', 'text', 'lang', 'date_label',
  'date_precision', 'date_basis', 'date_role', 'evidence_status', 'review_status', 'origin', 'source_locator', 'is_synthetic',
  'expression', 'collection', 'text_withheld'];

function passageRows(db, def) {
  const out = [];
  for (const s of def.strands) {
    if (s.type !== 'expression' || !s.run) continue;
    const q = occurrenceSql(def, s);
    const rows = stmt(db, `WITH m AS (${q.sql}) SELECT passage, doc, field, p_start, p_end, plang, lv, uc, title, date_label, precision,
        basis, date_role, syn, collection, export_text_allowed, count(*) AS n, (SELECT source_url FROM document WHERE id = doc) AS source_url
      FROM m WHERE ${COUNTED} GROUP BY passage ORDER BY MIN(lo_day IS NULL), MIN(lo_day), passage LIMIT ?`).all(...q.params, MAX_ROWS);
    for (const r of rows) {
      const withheld = r.export_text_allowed === 0;
      out.push({
        passage: r.passage, document: r.doc, title: r.title, lane: laneKey(def.lanes.facet, r.lv, r.uc), field: r.field,
        start: r.p_start, end: r.p_end, n: r.n,
        text: withheld ? null : (passageBase(db, { document_id: r.doc, field: r.field }) ?? '').slice(r.p_start, r.p_end),
        lang: r.plang, date_label: r.date_label, date_precision: r.precision, date_basis: r.basis, date_role: r.date_role,
        evidence_status: null, review_status: null, origin: null, source_locator: r.source_url ?? null, is_synthetic: r.syn,
        expression: s.ref, collection: r.collection, text_withheld: withheld ? 1 : 0,
      });
    }
  }
  return { rows: out, columns: PASSAGE_COLUMNS };
}

const AGG_COLUMNS = ['kind', 'lane', 'strand', 'tier', 'bin', 'date_label', 'date_precision', 'date_basis', 'date_role', 'n', 'docs',
  'authors', 'denom', 'unit', 'rate', 'ci_lo', 'ci_hi', 'state', 'flags', 'dp', 'evidence_status', 'review_status', 'origin',
  'source_locator', 'is_synthetic', 'field'];
const TIER_PRECISION = { L0: 'millennium', L1: 'century', L2: 'decade', L3: 'year' };

/**
 * Aggregates at a tier: every cell, every wash (once), every OpenAlex share cell of the Term trail (C3: k of n sampled works,
 * the share and its CI only from n ≥ 20, never a rate across cells) with the matched works that have no cell, and the
 * undated / scheduled amounts per lane — so the export itself satisfies, per lane,
 * Σ bins + Σ washes + Σ share-cell k + no-cell works + undated + scheduled = total.
 */
function aggregateRows(db, def, tier) {
  if (!TIER_PRECISION[tier]) throw new HttpError(400, 'E_VALIDATION', 'Aggregates export at L0–L3 (millennia to years).', null, { field: 'tier' });
  const ext = stmt(db, `SELECT MIN(d.y_lo) AS lo, MAX(d.y_hi) AS hi FROM document d JOIN collection c ON c.id = d.collection_id
    WHERE c.corpus_id IN (SELECT value FROM json_each(?)) AND d.chrono_status = 'dated' AND d.deleted_at IS NULL`).get(JSON.stringify(def.corpusIds ?? [def.corpusId]));
  const out = [];
  const level = ['L0', 'L1', 'L2', 'L3'].indexOf(tier);
  const base = { evidence_status: null, review_status: null, origin: null, source_locator: null, date_basis: null, date_role: null, field: null };
  if (ext.lo !== null) {
    const t0 = Math.floor(binOf(ext.lo, level) / 64), t1 = Math.floor(binOf(ext.hi, level) / 64);
    const list = [];
    for (let t = t0; t <= t1; t++) list.push(t);
    const res = computeTiles(db, def, tier, list);
    for (const tile of res.tiles) {
      for (const [lane, { strands }] of Object.entries(tile.lanes)) {
        for (const [strand, cells] of Object.entries(strands)) {
          for (const c of cells) {
            const bin = tile.bin0 + c[0];
            out.push({ kind: 'bin', lane, strand, tier, bin, date_label: binLabel(tier, bin), date_precision: TIER_PRECISION[tier], n: c[1],
              docs: c[2], authors: c[3], denom: c[4], unit: null, rate: c[5], ci_lo: c[6], ci_hi: c[7], state: CELL_STATES[c[8]],
              flags: c[9], dp: c[10], ...base, is_synthetic: c[9] & 16 ? 1 : 0 });
          }
        }
      }
      for (const w of tile.washes) {
        if (!w.owner) continue;
        out.push({ kind: 'wash', lane: w.lane, strand: String(w.strand), tier, bin: null, date_label: w.label, date_precision: w.precision,
          n: w.n, docs: w.docs, authors: null, denom: null, unit: null, rate: null, ci_lo: null, ci_hi: null, state: null, flags: null,
          dp: null, ...base, is_synthetic: w.synthetic ? 1 : 0 });
      }
    }
  }
  for (const s of def.strands) {
    const docRows = strandDocRows(db, def, s);
    if (def.lanes?.facet === 'trail') out.push(...shareCellRows(db, def, s, docRows, tier, base));
    const per = new Map();
    for (const r of docRows) {
      if (r.chrono_status === 'dated') continue;
      const lane = laneKey(def.lanes.facet, r.lv, r.uc);
      const k = `${lane}|${r.chrono_status}`;
      if (!per.has(k)) per.set(k, { lane, which: r.chrono_status, uc: r.uc, rows: [], syn: 0 });
      per.get(k).rows.push(r);
      if (r.syn) per.get(k).syn = 1;
    }
    for (const g of per.values()) {
      const n = countValue(g.uc, g.rows);
      if (!n) continue;
      out.push({ kind: g.which, lane: g.lane, strand: s.type === 'expression' ? String(s.ref) : s.key, tier, bin: null,
        date_label: g.which === 'undated' ? 'undated' : 'scheduled', date_precision: null, n, docs: g.rows.filter((r) => r.v > 0).length,
        authors: null, denom: null, unit: null, rate: null, ci_lo: null, ci_hi: null, state: null, flags: null, dp: null, ...base,
        is_synthetic: g.syn });
    }
  }
  return { rows: out, columns: AGG_COLUMNS };
}

/** Share-cell rows of one strand on the Term trail's OpenAlex lanes (dated works; undated ones are counted with the rest). */
function shareCellRows(db, def, strand, docRows, tier, base) {
  const dated = docRows.filter((r) => r.uc === 'cells' && r.chrono_status === 'dated');
  if (!dated.length) return [];
  const { cells, outside } = shareCells(db, def, strand, dated, strandLangSpec(strand));
  const key = strand.type === 'expression' ? String(strand.ref) : strand.key;
  const out = [];
  for (const [lane, list] of cells) {
    for (const c of list) {
      out.push({ kind: 'share_cell', lane, strand: key, tier, bin: null, date_label: c.label, date_precision: 'sample_cell', n: c.k,
        docs: c.k, authors: null, denom: c.n, unit: 'share_of_sampled_works', rate: c.share, ci_lo: c.ci?.[0] ?? null,
        ci_hi: c.ci?.[1] ?? null, state: c.state, flags: null, dp: null, ...base, is_synthetic: c.synthetic ? 1 : 0, field: c.field });
    }
  }
  for (const [lane, n] of outside) {
    if (!n) continue;
    out.push({ kind: 'no_cell', lane, strand: key, tier, bin: null, date_label: 'no sample cell', date_precision: null, n, docs: n,
      authors: null, denom: null, unit: 'works', rate: null, ci_lo: null, ci_hi: null, state: null, flags: null, dp: null, ...base,
      is_synthetic: strand.synthetic ? 1 : 0, field: null });
  }
  return out;
}

const REL_COLUMNS = ['rel_id', 'rel_type', 'family', 'src_type', 'src_ref', 'dst_type', 'dst_ref', 'evidence_status', 'review_status',
  'origin', 'source_dataset', 'source_locator', 'provenance_quality', 'method', 'run_id', 'score', 'score_kind', 'date_conflict',
  'src_year', 'dst_year', 'date_label', 'date_precision', 'date_basis', 'date_role', 'license', 'attribution', 'is_synthetic'];

/**
 * Relationships of a view: those its arcs draw — with an end in a document where a pinned strand is observed —
 * under the view's evidence filter (rejected and kindred/counterpart only when the view shows them).
 */
function relationshipRows(db, def, evidence) {
  const statuses = ['documented', 'computed', 'proposed'].filter((k) => evidence?.[k] !== 0);
  const rows = relationshipsTouching(db, [...strandDocIds(db, def)]).filter((r) => statuses.includes(r.evidence_status)
    && (evidence?.rejected || r.review_status !== 'rejected') && (evidence?.kindred || !['kindred', 'counterpart'].includes(r.rel_type)));
  return {
    rows: rows.slice(0, MAX_ROWS).map((r) => ({
      rel_id: r.id, rel_type: r.rel_type, family: REL_TYPE_BY_CODE[r.rel_type]?.family ?? null, src_type: r.src_type, src_ref: r.src_ref,
      dst_type: r.dst_type, dst_ref: r.dst_ref, evidence_status: r.evidence_status, review_status: r.review_status, origin: r.origin,
      source_dataset: r.source_dataset, source_locator: r.source_locator, provenance_quality: r.provenance_quality, method: r.method,
      run_id: r.run_id, score: r.score, score_kind: r.score_kind, date_conflict: r.date_conflict, src_year: r.src_year,
      dst_year: r.dst_year, date_label: null, date_precision: null, date_basis: null, date_role: null, license: r.license,
      attribution: r.attribution, is_synthetic: r.is_synthetic,
    })),
    columns: REL_COLUMNS,
  };
}

const ANN_COLUMNS = ['annotation', 'target_type', 'target_ref', 'kind', 'author', 'is_machine', 'method', 'layer', 'status', 'rev',
  'current_rev', 'supersedes', 'body_md', 'stance', 'dimensions', 'tags', 'reason', 'revision_author', 'revision_at', 'anchor_start',
  'anchor_end', 'anchor_quote', 'created_at', 'evidence_status', 'review_status', 'origin', 'date_label', 'date_precision', 'date_basis',
  'date_role', 'source_locator', 'is_synthetic', 'text_withheld'];

/**
 * The corpus scope of every annotation: the document it is about (passage, occurrence, document, a hypothesis group's
 * target, a relationship's ends, another annotation's target), or the corpus of the expression, context group, run window
 * or saved view it is about. Returns, per annotation id, null (outside the def's corpora) or {doc} (doc may be null).
 */
function annotationScope(db, def, anns) {
  const corpora = new Set(def.corpusIds ?? [def.corpusId]);
  const corpusSlugs = new Set([def.corpus, ...stmt(db, 'SELECT slug FROM corpus WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify([...corpora])).map((r) => r.slug)]);
  const docCorpus = stmt(db, 'SELECT c.corpus_id AS k, c.export_text_allowed AS allowed FROM document d JOIN collection c ON c.id = d.collection_id WHERE d.id = ?');
  const docOf = { passage: stmt(db, 'SELECT document_id AS d FROM passage WHERE id = ?'), occurrence: stmt(db, 'SELECT document_id AS d FROM occurrence WHERE id = ?') };
  const exprCorpus = stmt(db, 'SELECT corpus_id AS k FROM expression WHERE id = ?');
  const endDoc = (type, ref) => {
    const id = Number(String(ref).split(':').pop());
    if (!Number.isSafeInteger(id)) return null;
    if (type === 'document') return id;
    return docOf[type]?.get(id)?.d ?? null;
  };
  const inDocs = (docs) => {
    for (const d of docs) {
      if (d === null || d === undefined) continue;
      const r = docCorpus.get(d);
      if (r && corpora.has(r.k)) return { doc: d, allowed: r.allowed };
    }
    return null;
  };
  const byId = new Map(anns.map((a) => [a.id, a]));
  const memo = new Map();
  const scopeOf = (a, depth = 0) => {
    if (memo.has(a.id)) return memo.get(a.id);
    let out = null;
    const ref = a.target_ref;
    switch (a.target_type) {
      case 'document': case 'passage': case 'occurrence': out = inDocs([endDoc(a.target_type, ref)]); break;
      case 'relationship': {
        const r = stmt(db, 'SELECT src_type, src_ref, dst_type, dst_ref FROM relationship WHERE id = ?').get(Number(ref));
        out = r ? inDocs([endDoc(r.src_type, r.src_ref), endDoc(r.dst_type, r.dst_ref)]) : null;
        break;
      }
      case 'hypothesis_group': {
        const g = stmt(db, 'SELECT target_type, target_ref FROM hypothesis_group WHERE id = ?').get(Number(ref));
        out = g ? inDocs([endDoc(g.target_type, g.target_ref)]) : null;
        break;
      }
      case 'expression': out = corpora.has(exprCorpus.get(Number(ref))?.k) ? { doc: null, allowed: 1 } : null; break;
      case 'cluster': {
        const k = stmt(db, 'SELECT e.corpus_id AS k FROM sense_cluster c JOIN expression e ON e.id = c.expression_id WHERE c.id = ?').get(Number(ref))?.k;
        out = corpora.has(k) ? { doc: null, allowed: 1 } : null;
        break;
      }
      case 'time_window': {
        const scope = stmt(db, 'SELECT r.scope_json FROM time_window w JOIN analysis_run r ON r.id = w.run_id WHERE w.id = ?').get(Number(ref))?.scope_json;
        let e = null;
        try { e = JSON.parse(scope ?? '{}').expression ?? null; } catch { e = null; }
        out = corpora.has(exprCorpus.get(Number(e))?.k) ? { doc: null, allowed: 1 } : null;
        break;
      }
      case 'saved_view': {
        const c = stmt(db, "SELECT json_extract(state_json, '$.corpus') AS c FROM saved_view WHERE slug = ? OR CAST(id AS TEXT) = ?").get(String(ref), String(ref))?.c;
        out = corpusSlugs.has(c) ? { doc: null, allowed: 1 } : null;
        break;
      }
      case 'annotation': {
        const t = byId.get(Number(ref));
        out = t && depth < 8 ? scopeOf(t, depth + 1) : null;
        break;
      }
      default: out = null;
    }
    memo.set(a.id, out);
    return out;
  };
  return scopeOf;
}

/**
 * Annotations of a view's corpora, every revision of every layer (brief §3F/§10: older interpretations are kept as layers):
 * one row per revision, for active, superseded and withdrawn annotations on any target — passages, documents, relationships,
 * context groups, expressions, saved views, hypothesis groups, run windows and other annotations. Quoted text of a
 * collection with export_text_allowed = 0 is withheld; the reader's own words are not the licensed text.
 */
function annotationRows(db, def) {
  const anns = stmt(db, 'SELECT * FROM annotation ORDER BY id').all();
  const scopeOf = annotationScope(db, def, anns);
  const revs = stmt(db, 'SELECT * FROM annotation_revision WHERE annotation_id = ? ORDER BY rev');
  const parse = (j, dflt) => { try { return JSON.parse(j); } catch { return dflt; } };
  const out = [];
  for (const a of anns) {
    const scope = scopeOf(a);
    if (!scope) continue;
    const withheld = scope.allowed === 0;
    const anchor = a.anchor_json ? parse(a.anchor_json, null) : null;
    for (const rv of revs.all(a.id)) {
      out.push({ annotation: a.id, target_type: a.target_type, target_ref: a.target_ref, kind: a.kind, author: a.author,
        is_machine: a.is_machine, method: a.method, layer: a.layer, status: a.status, rev: rv.rev, current_rev: a.current_rev,
        supersedes: a.supersedes ?? null, body_md: rv.body_md, stance: rv.stance, dimensions: rv.dimensions_json, tags: rv.tags_json,
        reason: rv.reason ?? null, revision_author: rv.author, revision_at: rv.at,
        anchor_start: anchor?.start ?? null, anchor_end: anchor?.end ?? null, anchor_quote: withheld ? null : anchor?.quote ?? null,
        created_at: a.created_at, evidence_status: null, review_status: null, origin: a.is_machine ? 'machine_tagger' : 'human',
        date_label: null, date_precision: null, date_basis: null, date_role: null, source_locator: null, is_synthetic: a.is_synthetic,
        text_withheld: withheld ? 1 : 0 });
      if (out.length >= MAX_ROWS) return { rows: out, columns: ANN_COLUMNS };
    }
  }
  return { rows: out, columns: ANN_COLUMNS };
}

// ── the export ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Build an export. Read-query convention (§12.2): runs in the read pool via ctx.pool.run(moduleUrl, 'exportQuery', args).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{view?: string|null, state?: string|null, what?: string, format?: string, tier?: string, snapshot?: string|null}} args
 *   `snapshot` names a stored SVG snapshot (POST /api/snapshots) for the HTML bundle
 * @returns {{contentType: string, filename: string, body: string, rows: number, manifest: object}}
 * @throws {HttpError} 400 E_EXPORT_FORMAT / E_VALIDATION, 404, 409 E_NOT_MATERIALIZED
 */
export function exportQuery(db, { view = null, state = null, what = 'occurrences', format = 'json', tier = 'L2', snapshot = null }) {
  if (!WHATS.includes(what)) throw new HttpError(400, 'E_VALIDATION', `what must be one of ${WHATS.join(', ')}.`, null, { field: 'what' });
  if ((what === 'bundle') !== (format === 'html')) {
    throw new HttpError(400, 'E_EXPORT_FORMAT', `Format '${format}' with what=${what} is not supported.`, 'Use json, jsonl or csv; html with what=bundle.', { format, what });
  }
  if (what === 'bundle') return bundleExport(db, { view, state, tier, snapshot });
  if (!FORMATS[format]) {
    throw new HttpError(400, 'E_EXPORT_FORMAT', `Format '${format}' is not supported.`, 'Use json, jsonl or csv; html with what=bundle.', { format });
  }
  const resolved = resolveState(db, { view, state });
  if (!resolved.state.strands.length && (what === 'occurrences' || what === 'aggregates' || what === 'passages')) {
    throw new HttpError(400, 'E_VALIDATION', 'The view pins no strand to export.', 'Pin an expression first.', { field: 'state' });
  }
  const { def, missing } = defFromViewState(db, resolved.state);
  if (missing.length && what !== 'relationships' && what !== 'annotations') {
    throw new HttpError(409, 'E_NOT_MATERIALIZED', `Counting has not finished for expression ${missing.join(', ')}.`, 'Wait for "counting…" to finish, then export.', { expressions: missing });
  }
  const { rows, columns } = what === 'occurrences' ? occurrenceRows(db, def)
    : what === 'passages' ? passageRows(db, def)
      : what === 'aggregates' ? aggregateRows(db, def, tier)
        : what === 'relationships' ? relationshipRows(db, def, resolved.state.evidence)
          : annotationRows(db, def);
  const manifest = buildManifest(db, { view: resolved.view, state: resolved.state, what, format, def, rows });
  const body = format === 'json' ? JSON.stringify({ manifest, rows })
    : format === 'jsonl' ? jsonlExport(manifest, rows)
      : csvManifest(manifest) + toCsv(rows, columns);
  return { contentType: FORMATS[format], filename: `scrolls-${def.corpus}-v${manifest.data_version}-${what}.${format}`, body,
    rows: rows.length, manifest };
}

/** Most occurrence rows a portable bundle carries (§7.3). */
export const BUNDLE_OCCURRENCES = 5000;
const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.svg$/;

/**
 * The portable bundle: aggregates + ≤ 5,000 occurrences (KWIC where text export is allowed) + relationships +
 * annotations, the manifest, and the view's SVG snapshot (a stored snapshot file, else the saved view's).
 */
function bundleExport(db, { view, state, tier, snapshot }) {
  const resolved = resolveState(db, { view, state });
  const { def, missing } = defFromViewState(db, resolved.state);
  if (missing.length) {
    throw new HttpError(409, 'E_NOT_MATERIALIZED', `Counting has not finished for expression ${missing.join(', ')}.`, 'Wait for "counting…" to finish, then export.', { expressions: missing });
  }
  const occ = def.strands.length ? occurrenceRows(db, def) : { rows: [], columns: OCC_COLUMNS };
  const data = {
    aggregates: def.strands.length ? aggregateRows(db, def, ['L0', 'L1', 'L2', 'L3'].includes(tier) ? tier : 'L2') : { rows: [], columns: AGG_COLUMNS },
    occurrences: { columns: occ.columns, rows: occ.rows.slice(0, BUNDLE_OCCURRENCES),
      ...(occ.rows.length > BUNDLE_OCCURRENCES ? { note: `first ${BUNDLE_OCCURRENCES} of ${occ.rows.length} by date` } : {}) },
    relationships: relationshipRows(db, def, resolved.state.evidence),
    annotations: annotationRows(db, def),
  };
  let svg = null;
  if (snapshot) {
    if (!SNAPSHOT_NAME.test(String(snapshot))) throw new HttpError(400, 'E_VALIDATION', 'snapshot must name a stored .svg snapshot.', null, { field: 'snapshot' });
    try { svg = readFileSync(path.join(paths().snapshots, String(snapshot)), 'utf8'); } catch {
      throw new HttpError(404, 'E_NOT_FOUND', `No snapshot ${snapshot}.`, 'POST the snapshot first, then download the bundle.');
    }
  } else if (resolved.view) {
    svg = stmt(db, 'SELECT snapshot_svg FROM saved_view WHERE slug = ?').get(resolved.view)?.snapshot_svg ?? null;
  }
  const all = Object.values(data).flatMap((t) => t.rows);
  const manifest = buildManifest(db, { view: resolved.view, state: resolved.state, what: 'bundle', format: 'html', def, rows: all });
  manifest.rows = Object.fromEntries(Object.entries(data).map(([k, t]) => [k, t.rows.length]));
  const body = bundleHtml({ manifest, svg, data });
  return { contentType: 'text/html; charset=utf-8', filename: `scrolls-${def.corpus}-v${manifest.data_version}-bundle.html`, body,
    rows: all.length, manifest };
}
