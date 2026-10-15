// OWNER: WP2
// routes/tour.mjs — GET /api/tour: the demo tour of data/demo/tour.json with its ids resolved (expressions,
// passages, occurrences, relationships) into reproducible view-state hashes, and its {placeholders} filled with
// numbers computed from the database at request time (SPEC §9.7). Nothing numeric is written in tour.json.

import { dayFromYMD } from '../../src/shared/dates.mjs';
import { formatTokens } from '../../src/shared/format.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { defaultState, encode } from '../../src/shared/viewstate.mjs';
import { findOccurrences } from '../../data/demo/generator.mjs';
import { readDemo, readTour } from '../adapters/demo/demo.mjs';
import { HttpError } from '../http/errors.mjs';

const COLL = 'demo-world';

const docByExt = (db, ext) => db.prepare(`SELECT d.* FROM document d JOIN collection c ON c.id = d.collection_id
  WHERE c.slug = ? AND d.ext_id = ? AND d.deleted_at IS NULL`).get(COLL, ext) ?? null;

/** The passage holding a quote (or the first match of a demo expression) in an anchor document. */
function passageFor(db, anchor, { quote = null, expr = null } = {}) {
  const doc = docByExt(db, `demo:${anchor}`);
  if (!doc) return null;
  const text = db.prepare('SELECT original FROM document_text WHERE document_id = ?').get(doc.id)?.original ?? '';
  let start = -1, end = -1;
  if (quote) { start = text.indexOf(quote); end = start + quote.length; }
  else if (expr) { const o = findOccurrences(text, expr)[0]; if (o) ({ start, end } = o); }
  if (start < 0) return null;
  const p = db.prepare(`SELECT id FROM passage WHERE document_id = ? AND field = 'body' AND start_off <= ? AND end_off >= ?
    ORDER BY start_off DESC LIMIT 1`).get(doc.id, start, end);
  return p ? { doc: doc.id, passage: p.id, start, end } : null;
}

/** A tracked expression of a corpus by its surface (an expression tracked for any corpus counts for a real one). */
function expressionId(db, surface, corpus = 'demo') {
  const norm = tokenize(surface).tokens.join(' ');
  return db.prepare(`SELECT e.id FROM expression e LEFT JOIN corpus k ON k.id = e.corpus_id
    WHERE e.norm = ? AND (k.slug = ? OR (e.corpus_id IS NULL AND ? <> 'demo'))
    ORDER BY (k.slug = ?) DESC, e.id LIMIT 1`).get(norm, corpus, corpus, corpus)?.id ?? null;
}

function relationshipFor(db, key) {
  const spec = readDemo('relationships.jsonl').find((r) => r.key === key);
  if (!spec) return null;
  const s = docByExt(db, spec.src.ext_id), d = docByExt(db, spec.dst.ext_id);
  if (!s || !d) return null;
  return db.prepare(`SELECT id FROM relationship WHERE rel_type = ? AND src_type = 'document' AND src_ref = ? AND dst_type = 'document'
    AND dst_ref = ? ORDER BY id LIMIT 1`).get(spec.rel_type, String(s.id), String(d.id))?.id ?? null;
}

/** Longest run of identical folded tokens shared by two documents (a fact about the texts). */
function longestSharedRun(db, a, b) {
  const t = (ext) => {
    const d = docByExt(db, ext);
    return d ? tokenize(db.prepare('SELECT original FROM document_text WHERE document_id = ?').get(d.id)?.original ?? '').tokens : [];
  };
  const x = t(a), y = t(b);
  let best = 0;
  const prev = new Uint16Array(y.length + 1), cur = new Uint16Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) best = cur[j];
    }
    prev.set(cur);
  }
  return best;
}

/** Numbers the tour text quotes, computed from the loaded demo. */
function placeholders(db) {
  const out = {};
  out.hiphop_1980s_tokens = formatTokens(db.prepare(`SELECT COALESCE(SUM(t.tokens), 0) AS n FROM doc_tokens t JOIN document d ON d.id = t.document_id
    JOIN collection c ON c.id = d.collection_id WHERE c.slug = ? AND d.community = 'hiphop' AND d.chrono_status = 'dated'
    AND d.y_lo >= 1980 AND d.y_hi <= 1989 AND t.field_class = 'text'`).get(COLL).n);
  const a15 = docByExt(db, 'demo:A15');
  out.a15_date = a15?.date_label ?? 'the song\'s date';
  out.a15_referenced = a15 ? db.prepare(`SELECT raw FROM date_assertion WHERE subject_type = 'document' AND subject_id = ? AND role = 'referenced'`).get(a15.id)?.raw ?? '1911' : '1911';
  out.a11_a4_run = String(longestSharedRun(db, 'demo:A11', 'demo:A4'));
  const reuse = db.prepare("SELECT id FROM analysis_run WHERE stage = 'reuse-index' AND status = 'succeeded' ORDER BY id DESC LIMIT 1").get();
  out.reuse_run = reuse ? `run #${reuse.id}` : 'the reuse-index run, once it has run';
  const sliceTokens = (lo, hi) => formatTokens(db.prepare(`SELECT COALESCE(SUM(t.tokens), 0) AS n FROM doc_tokens t JOIN document d ON d.id = t.document_id
    JOIN collection c ON c.id = d.collection_id WHERE c.slug = ? AND d.chrono_status = 'dated' AND d.y_lo >= ? AND d.y_hi <= ?
    AND t.field_class = 'text'`).get(COLL, lo, hi).n);
  out.slice_a_tokens = sliceTokens(1955, 1985);
  out.slice_b_tokens = sliceTokens(1994, 2026);
  let kiln = 0;
  for (const r of db.prepare(`SELECT t.original FROM document_text t JOIN document d ON d.id = t.document_id JOIN collection c ON c.id = d.collection_id
    WHERE c.slug = ? AND instr(t.original, '◉') > 0`).all(COLL)) kiln += findOccurrences(r.original, '◉').length;
  out.kiln_total = String(kiln);
  return out;
}

/** A tour step's state spec → ViewState hash, and the ids it resolved. */
function resolveState(db, spec) {
  const corpus = spec.corpus ?? 'demo';
  const s = defaultState(corpus);
  const refs = {};
  const missing = [];
  const track = [];
  for (const surface of spec.strands ?? []) {
    const id = expressionId(db, surface, corpus);
    if (id) s.strands.push({ type: 'expression', id, variants: 'default', glyph: ['circle', 'square', 'triangle', 'diamond'][s.strands.length] });
    else {
      missing.push(`expression '${surface}' is not tracked yet`);
      // what the UI posts to /api/expressions to track it (the step's strand then resolves on the next /api/tour)
      track.push({ surface, lang: spec.lang ?? null, kind: /\s/.test(surface) ? 'phrase' : 'word', corpus });
    }
  }
  if (spec.lanes) s.lanes = { ...s.lanes, facet: spec.lanes };
  if (spec.evidence) s.evidence = { ...s.evidence, ...spec.evidence };
  if (spec.vantage) s.vantage = { day: dayFromYMD(spec.vantage, 12, 31), strict: true };
  if (spec.panels) s.panels = { ...s.panels, ...spec.panels };
  if (spec.compare) s.compare = { a: { years: spec.compare.a, f: '' }, b: { years: spec.compare.b, f: '' } };
  const sel = spec.selection;
  if (sel?.type === 'occurrence') {
    const p = passageFor(db, sel.anchor, { expr: sel.expr });
    const exprId = expressionId(db, sel.expr);
    const occ = p && exprId ? db.prepare(`SELECT o.id FROM occurrence o JOIN expression_state st ON st.expression_id = o.expression_id
      AND st.run_id = o.run_id WHERE o.expression_id = ? AND o.passage_id = ? ORDER BY o.start_off LIMIT 1`).get(exprId, p.passage) : null;
    if (occ) { s.selection = { type: 'occurrence', id: occ.id }; refs.occurrence = occ.id; }
    else if (sel.fallback) {
      const f = passageFor(db, sel.fallback.anchor, { quote: sel.fallback.quote });
      if (f) { s.selection = { type: 'passage', id: f.passage }; refs.passage = f.passage; }
      missing.push('occurrence not materialized yet; the passage is selected instead');
    }
  } else if (sel?.type === 'passage') {
    const p = passageFor(db, sel.anchor, { quote: sel.quote });
    if (p) { s.selection = { type: 'passage', id: p.passage }; refs.passage = p.passage; } else missing.push(`passage of ${sel.anchor} not found`);
  } else if (sel?.type === 'relationship') {
    const id = relationshipFor(db, sel.key);
    if (id) { s.selection = { type: 'relationship', id }; refs.relationship = id; } else missing.push(`relationship ${sel.key} not found`);
  }
  if (spec.lineage) {
    const p = passageFor(db, spec.lineage.anchor, { quote: spec.lineage.quote });
    if (p) { s.lineage = { ...s.lineage, root: `passage:${p.passage}` }; refs.lineage_root = `passage:${p.passage}`; }
    else missing.push(`lineage root ${spec.lineage.anchor} not found`);
  }
  return { hash: encode(s), refs, missing, track };
}

/**
 * The resolved tour.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{steps: object[], minutes: number}}
 */
export function tourQuery(db) {
  const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'data_version'").get()?.value ?? 0);
  if (tourCache.version === version && tourCache.body) return tourCache.body;
  if (!docByExt(db, 'demo:A15')) {
    throw new HttpError(409, 'E_DEMO_NOT_LOADED', 'The tour needs the demo corpus, which is still loading.', 'Wait a few seconds and retry.');
  }
  const tour = readTour();
  const vars = placeholders(db);
  const fill = (s) => String(s).replace(/\{([a-z0-9_]+)\}/g, (m, k) => vars[k] ?? m);
  const body = {
    minutes: tour.minutes,
    steps: tour.steps.map((st) => {
      const r = resolveState(db, st.state ?? {});
      return {
        n: st.n, action: fill(st.action), see: fill(st.see), learn: fill(st.learn), anchor: st.anchor, state: r.hash,
        synthetic: st.synthetic !== false, first_minute: st.first_minute === true, refs: r.refs,
        ...(r.missing.length ? { pending: r.missing } : {}),
        ...(r.track.length ? { track: r.track } : {}),
      };
    }),
  };
  tourCache = { version, body };
  return body;
}
let tourCache = { version: -1, body: null };

export const routes = [
  {
    method: 'GET',
    path: '/api/tour',
    async handler(req, ctx) {
      return { json: tourQuery(ctx.db) };
    },
  },
];
