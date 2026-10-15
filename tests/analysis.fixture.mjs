// OWNER: WP4 — synthetic corpus and a test-only materializer for the analysis tests (not a test file itself)
//
// Everything here is invented for tests and loaded into the synthetic 'test' corpus (SPEC §13 rule 1).
// Until WP3's materialize job lands, `materializeForTest` writes expression, occurrence and expr_doc rows
// the way §3/§4.6 define them (exact folded token-sequence matches; expr_doc.n excludes proper-noun-guard
// hits, which go to n_names), under a succeeded materialize run.

import { createHash } from 'node:crypto';
import { canonicalJson, mulberry32 } from '../src/shared/ids.mjs';
import { isSentenceInitial, normString, tokenize } from '../src/shared/tokenize.mjs';
import { dataVersion, nowIso } from '../server/db/open.mjs';
import { createBatch, createDocumentWriter, ensureCollection } from '../server/store/document-writer.mjs';

const FILLER = ('river window stone morning bread copper garden lamp harbour letter market winter music engine paper '
  + 'orchard bridge candle meadow signal thread mirror ladder kettle tower valley pocket ribbon basket compass anchor '
  + 'lantern hammer feather blanket saddle barrel button carpet cellar chimney cottage doorway fence gravel hedge '
  + 'island jacket kitchen ledge marble needle oven pillow quarry rafter shovel spindle tunnel umbrella velvet wagon '
  + 'yard bright quiet early late slow quick warm cold heavy light narrow wide gentle rough steady walked carried '
  + 'opened closed painted counted measured folded mended gathered sorted watched waited moved turned kept found').split(' ');
const STOP = 'the a of and in to with for on at by from as it was'.split(' ');

export const ERA_A = [1900, 1949];
export const ERA_B = [1990, 2020];
const TEMPLATES = {
  a: ['the auditors kept the {T} in triplicate', 'every {T} went to the auditors with forms', 'forms and the {T} for the auditors'],
  b: ['they counted the {T} and hold the place', 'hold the {T} for the uncredited', 'the uncredited {T} counted what they hold'],
};

function sentence(rng, words = 10) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(rng() < 0.3 ? STOP[Math.floor(rng() * STOP.length)] : FILLER[Math.floor(rng() * FILLER.length)]);
  return out.join(' ');
}

function paragraph(rng, era, target, hits) {
  const parts = [];
  for (let s = 0; s < 4; s++) parts.push(sentence(rng, 8 + Math.floor(rng() * 6)));
  for (let h = 0; h < hits; h++) {
    const t = TEMPLATES[era][Math.floor(rng() * TEMPLATES[era].length)].replace('{T}', target);
    parts.splice(1 + Math.floor(rng() * parts.length), 0, t);
  }
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1) + '.').join(' ');
}

const yearIn = (rng, [lo, hi]) => lo + Math.floor(rng() * (hi - lo + 1));

function textDoc(i, { era, year, raw = null, hits = [1, 1, 1], extra = '', lang = 'en', author, kind = 'memo', prominence = null, rng }) {
  const body = hits.map((h) => paragraph(rng, era, 'ledger', h)).join('\n\n') + (extra ? `\n\n${extra}` : '');
  return {
    ext_id: `ana:${i}`, kind, title: `Synthetic record ${i}`, author, lang_declared: lang, prominence, community: era === 'a' ? 'office' : 'hiphop',
    text: { original: `Synthetic record ${i}\n\n${body}\n`, decoder: 'utf-8', mode: 'prose' },
    dates: [{ role: 'publication', raw: raw ?? String(year), asserted_by: 'fixture:analysis', is_chronology: true }],
    original_meta: { fixture: 'analysis', note: 'invented test document (synthetic)' },
  };
}

/**
 * Build the analysis test corpus (synthetic): collection `ana-text` (text, tokens, coverage gate 2,000),
 * `ana-titles` (titles, works, selected by prominence) and `ana-oa` (abstracts, top-cited sample).
 * Era A (1900–1949) uses "ledger" with auditors/forms/triplicate, era B (1990–2020) with counted/hold/uncredited;
 * "tally" is rare (7 in A, 15 in B). Also: 2 washes (1945–1955), 2 undated, 1 translation (declared fr,
 * English text), 1 exact duplicate, 1 name-guard hit ("Mr Ledger Holt"), a sparse 1890s pair.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{seed?: number, perEra?: number, paragraphs?: number}} [opts]
 * @returns {{counts: object, ids: Map<string, number>}}
 */
export function buildAnalysisCorpus(db, { seed = 1994, perEra = 40, paragraphs = 3 } = {}) {
  db.prepare(`INSERT INTO corpus (slug, name, kind, is_synthetic, description, license, created_at)
    VALUES ('test', 'Test fixtures (synthetic)', 'synthetic', 1, 'Invented test documents', 'CC0 (synthetic)', ?)
    ON CONFLICT(slug) DO NOTHING`).run(nowIso());
  const rng = mulberry32(seed);
  const authorsA = Array.from({ length: 8 }, (_, i) => `Clerk ${String.fromCharCode(65 + i)} (synthetic)`);
  const authorsB = Array.from({ length: 8 }, (_, i) => `MC ${String.fromCharCode(75 + i)} (synthetic)`);
  const docs = [];
  let n = 0;
  const hitsOf = () => Array.from({ length: paragraphs }, () => 1);
  for (let i = 0; i < perEra; i++) {
    docs.push(textDoc(++n, { era: 'a', year: yearIn(rng, ERA_A), author: authorsA[i % 8], kind: i % 3 ? 'memo' : 'bulletin',
      prominence: rng(), hits: hitsOf(), rng }));
  }
  for (let i = 0; i < perEra; i++) {
    docs.push(textDoc(++n, { era: 'b', year: yearIn(rng, ERA_B), author: authorsB[i % 8], kind: i % 4 ? 'song' : 'post',
      prominence: rng(), hits: hitsOf(), rng }));
  }
  // rare expression "tally": 7 in A (2 documents), 15 in B (5 documents)
  const tally = (k) => Array.from({ length: k }, () => 'the tally stick').join(', ');
  docs.push(textDoc(++n, { era: 'a', year: 1911, author: authorsA[0], extra: `${tally(4)}.`, rng }));
  docs.push(textDoc(++n, { era: 'a', year: 1912, author: authorsA[1], extra: `${tally(3)}.`, rng }));
  for (let i = 0; i < 5; i++) docs.push(textDoc(++n, { era: 'b', year: 2001 + i, author: authorsB[i], extra: `${tally(3)}.`, rng }));
  // washes: 1945–1955 straddles the end of era A
  docs.push(textDoc(++n, { era: 'a', raw: '1945-1955', author: authorsA[2], rng }));
  docs.push(textDoc(++n, { era: 'a', raw: '1945-1955', author: authorsA[3], rng }));
  // undated
  docs.push(textDoc(++n, { era: 'b', raw: 'n.d.', author: authorsB[0], rng }));
  docs.push(textDoc(++n, { era: 'b', raw: 'n.d.', author: authorsB[1], rng }));
  // a translation: declared French, English text, dated inside era A
  docs.push(textDoc(++n, { era: 'a', year: 1920, author: 'Traductrice (synthetic)', lang: 'fr', rng }));
  // an exact duplicate of the first A document
  docs.push({ ...docs[0], ext_id: `ana:${++n}` });
  // a name-guard hit in era B
  docs.push(textDoc(++n, { era: 'b', year: 2005, author: authorsB[2], extra: 'Yesterday Mr Ledger Holt walked to the market.', rng }));
  // sparse 1890s: two short documents (below the 2,000-token gate)
  docs.push(textDoc(++n, { era: 'a', year: 1893, author: authorsA[4], hits: [1], rng }));
  docs.push(textDoc(++n, { era: 'a', year: 1897, author: authorsA[5], hits: [1], rng }));

  const text = writeCollection(db, docs, { slug: 'ana-text', name: 'Analysis test texts (synthetic)', modality: 'text', unit: 'tokens',
    sampling: 'user', coverage_gate: 2000, adapter_id: 'file.jsonl' });

  const titles = [];
  const titleWords = ['Night Train', 'Copper Rain', 'Lantern Song', 'Paper Harbour', 'Quiet Engine', 'Velvet Signal', 'Steady Bridge'];
  let t = 0;
  const title = (year, withTarget) => ({
    ext_id: `anat:${++t}`, kind: t % 2 ? 'song' : 'film', title: withTarget ? `Ledger ${titleWords[t % 7]}` : `${titleWords[t % 7]} ${t}`,
    author: `Maker ${t} (synthetic)`, prominence: rng(), fields: { title: withTarget ? `Ledger ${titleWords[t % 7]}` : `${titleWords[t % 7]} ${t}` },
    dates: [{ role: 'release', raw: String(year), asserted_by: 'fixture:analysis', is_chronology: true }],
    original_meta: { fixture: 'analysis', note: 'invented test title (synthetic)' },
  });
  for (let i = 0; i < 35; i++) titles.push(title(yearIn(rng, ERA_A), i < 2));
  for (let i = 0; i < 60; i++) titles.push(title(yearIn(rng, ERA_B), i < 6));
  const tit = writeCollection(db, titles, { slug: 'ana-titles', name: 'Analysis test titles (synthetic)', modality: 'titles', unit: 'works',
    sampling: 'prominence_selected', coverage_gate: null, selection_note: 'chosen by prominence (synthetic)', adapter_id: 'file.csv' });

  const oa = [];
  for (let i = 0; i < 24; i++) {
    const year = i < 12 ? 1920 : 2010;
    oa.push({ ext_id: `anao:${i}`, kind: 'paper', title: `Paper ${i}`, author: `Author ${i} (synthetic)`,
      fields: { title: `Paper ${i}`, abstract: `We study the ledger of ${FILLER[i]} and ${FILLER[i + 1]} in detail.` },
      dates: [{ role: 'publication', raw: String(year), asserted_by: 'fixture:analysis', is_chronology: true }],
      original_meta: { fixture: 'analysis', note: 'invented test abstract (synthetic)' } });
  }
  const oaRes = writeCollection(db, oa, { slug: 'ana-oa', name: 'Analysis test abstracts (synthetic)', modality: 'abstracts', unit: 'works',
    sampling: 'top_cited_per_cell', coverage_gate: 10, selection_note: 'top-cited sample (synthetic)', adapter_id: 'file.jsonl',
    export_text_allowed: 0 });
  return { counts: { text: text.counts, titles: tit.counts, oa: oaRes.counts }, ids: new Map([...text.ids, ...tit.ids, ...oaRes.ids]) };
}

function writeCollection(db, docs, spec) {
  const coll = ensureCollection(db, { corpus: 'test', domain: 'imported', rate_eligible: 1, ...spec });
  const batchId = createBatch(db, { collection: coll.id, format: 'jsonl', fileName: `${spec.slug}.jsonl` });
  const writer = createDocumentWriter(db, { batchId, collection: coll.slug, corpus: 'test',
    options: { now: new Date('2026-10-04T12:00:00Z') } });
  const results = docs.map((d, i) => writer.addDocument(d, { line: i + 1 }));
  const counts = writer.finish();
  return { counts, ids: new Map(docs.map((d, i) => [d.ext_id, results[i].documentId])) };
}

function passageText(db, p) {
  const src = p.field === 'body'
    ? db.prepare('SELECT original FROM document_text WHERE document_id = ?').get(p.document_id)?.original
    : db.prepare('SELECT value FROM document_field WHERE document_id = ? AND field = ?').get(p.document_id, p.field)?.value;
  return src === undefined || src === null ? null : src.slice(p.start_off, p.end_off);
}

const CAP = /^\p{Lu}/u;

/**
 * Track an expression and count it like the materialize job (§4.6): exact folded token-sequence matches in
 * every quality='ok' passage of the corpus; a match is a name-guard hit when its first token is
 * capitalized, not sentence-initial, and a neighbour token is capitalized (§4.5).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{surface: string, lang?: string|null, kind?: string, corpus?: string, variants?: string[]}} spec
 * @returns {{exprId: number, runId: number, n: number, names: number}}
 */
export function materializeForTest(db, { surface, lang = 'en', kind = 'word', corpus = 'test', variants = [] }) {
  const corpusId = db.prepare('SELECT id FROM corpus WHERE slug = ?').get(corpus).id;
  const norm = normString(surface);
  const exprId = Number(db.prepare(`INSERT INTO expression (corpus_id, kind, surface, norm, lang, origin, is_synthetic, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 'user_query', 1, 'test', ?)`).run(corpusId, kind, surface, norm, lang, nowIso()).lastInsertRowid);
  const forms = [{ form: surface, type: 'identity', rule: 'identity', status: 'documented' },
    ...variants.map((v) => ({ form: v, type: 'inflection', rule: 'en-inflect@1', status: 'computed' }))];
  const vrows = forms.map((f) => ({ ...f, norm: normString(f.form), tokens: normString(f.form).split(' '),
    id: Number(db.prepare(`INSERT INTO expression_variant (expression_id, form, norm, lang, variant_type, rule, evidence_status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(exprId, f.form, normString(f.form), lang, f.type, f.rule, f.status).lastInsertRowid) }));
  const params = { expr: exprId, variants: 'default' };
  const runId = Number(db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
      input_fingerprint, data_version, tokenizer_version, segmenter_version, icu_version, status, started_at)
    VALUES ('materialize', 'materialize@test', 'test', ?, ?, ?, 'test', ?, 'u61m-1', 'seg-1', ?, 'running', ?)`)
    .run(canonicalJson(params), createHash('sha256').update(canonicalJson(params)).digest('hex'), JSON.stringify({ expression: exprId }),
      dataVersion(db), process.versions.icu ?? 'none', nowIso()).lastInsertRowid);
  const insOcc = db.prepare(`INSERT INTO occurrence (expression_id, variant_id, passage_id, document_id, start_off, end_off, tok_index,
    name_flag, sampled, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`);
  const agg = new Map();
  let total = 0, names = 0;
  db.exec('BEGIN');
  for (const p of db.prepare(`SELECT p.* FROM passage p JOIN document d ON d.id = p.document_id JOIN collection c ON c.id = d.collection_id
    WHERE c.corpus_id = ? AND p.quality = 'ok' AND d.deleted_at IS NULL ORDER BY p.id`).all(corpusId)) {
    const text = passageText(db, p);
    if (text === null) continue;
    const { tokens, starts, ends } = tokenize(text);
    for (let i = 0; i < tokens.length; i++) {
      const v = vrows.find((x) => x.tokens.every((t, j) => tokens[i + j] === t));
      if (!v) continue;
      const end = i + v.tokens.length - 1;
      const raw = text.slice(starts[i], ends[i]);
      const nb = (k) => k >= 0 && k < tokens.length && CAP.test(text.slice(starts[k], ends[k]));
      const flag = CAP.test(raw) && !isSentenceInitial(text, starts[i]) && (nb(i - 1) || nb(end + 1)) ? 1 : 0;
      insOcc.run(exprId, v.id, p.id, p.document_id, p.start_off + starts[i], p.start_off + ends[end], i, flag, runId);
      const key = `${p.document_id}|${p.lang}|${p.field_class}`;
      const a = agg.get(key) ?? { doc: p.document_id, plang: p.lang, fc: p.field_class, n: 0, names: 0, passages: new Set(), first: null };
      if (flag) { a.names++; names++; } else { a.n++; total++; a.passages.add(p.id); a.first ??= p.start_off + starts[i]; }
      agg.set(key, a);
    }
  }
  const insDoc = db.prepare(`INSERT INTO expr_doc (expression_id, document_id, plang, field_class, n, n_names, n_passages, first_off, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const a of agg.values()) insDoc.run(exprId, a.doc, a.plang, a.fc, a.n, a.names, a.passages.size, a.first, runId);
  db.prepare(`INSERT INTO expression_state (expression_id, run_id, variants_hash, status, occ_total, docs_total, names_excluded, updated_at)
    VALUES (?, ?, 'test', 'ready', ?, ?, ?, ?)`).run(exprId, runId, total, new Set([...agg.values()].filter((a) => a.n).map((a) => a.doc)).size,
    names, nowIso());
  db.prepare("UPDATE analysis_run SET status = 'succeeded', finished_at = ? WHERE id = ?").run(nowIso(), runId);
  db.exec('COMMIT');
  return { exprId, runId, n: total, names };
}
