// OWNER: WP4 — a synthetic corpus written straight into the tables and token-stream files that vector spaces
// are built from (documents, passages, doc_tokens, expr_doc, derived/tokens/en.*). A module with no tests:
// the vectors, drift and responsiveness tests import it. Everything here is invented and lives in the
// synthetic 'test' corpus (SPEC §13 rule 1).
//
// The language: 100 function words, 40 topics × 120 topic words and 1,000 background words. Every passage
// (≈ 200 tokens) has one topic: 45% function words, 40% words of its topic, 15% background (mild Zipf inside
// each group). The planted word "ledger" sits in passages of topics 0–4 in era A and of topics 20–24 in era B
// (a planted shift of usage contexts); "steady" is a topic-10 word in both eras (an unchanged control).

import { mkdirSync, writeFileSync } from 'node:fs';
import { endianness } from 'node:os';
import path from 'node:path';
import { canonicalJson, mulberry32 } from '../src/shared/ids.mjs';
import { dayFromYMD } from '../src/shared/dates.mjs';
import { TOKENIZER_VERSION } from '../src/shared/tokenize.mjs';
import { dataVersion, nowIso } from '../server/db/open.mjs';
import { stopwords } from '../server/text/langid.mjs';
import { createBatch, ensureCollection } from '../server/store/document-writer.mjs';
import { registerFileAdapters } from './helpers/tmpdata.mjs';

export const PLANTED = 'ledger';
export const STEADY = 'steady';
export const TOPICS = 40;
const TOPIC_WORDS = 120;
const BACKGROUND = 1000;
const SYLL = ['ka', 'lo', 'mi', 'ne', 'ru', 'sa', 'ti', 'vo', 'ze', 'pa', 'do', 'fi', 'gu', 'ha', 'je', 'bo'];

function pseudoWord(i) {
  let s = '';
  let x = i + 17;
  do { s += SYLL[x % SYLL.length]; x = Math.floor(x / SYLL.length); } while (x > 0);
  return `${s}${SYLL[(i * 7) % SYLL.length]}`;
}

/** Cumulative Zipf-like weights (exponent s) over n items, for sampling by binary search. */
function zipf(n, s) {
  const c = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += 1 / Math.pow(i + 1, s); c[i] = acc; }
  for (let i = 0; i < n; i++) c[i] /= acc;
  return c;
}
function draw(cum, r) {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * The vocabulary: function words, topic words (topic t owns ids [base + t·120, base + (t+1)·120)), background,
 * then the planted and steady words.
 */
export function syntheticVocab() {
  const fn = stopwords('en').slice(0, 100);
  const words = [...fn];
  const topicBase = words.length;
  const seen = new Set(words);
  let k = 0;
  const fresh = () => { let w; do { w = pseudoWord(k++); } while (seen.has(w)); seen.add(w); return w; };
  for (let t = 0; t < TOPICS; t++) for (let j = 0; j < TOPIC_WORDS; j++) words.push(fresh());
  const bgBase = words.length;
  for (let j = 0; j < BACKGROUND; j++) words.push(fresh());
  const planted = words.length;
  words.push(PLANTED);
  // "steady" replaces the third word of topic 10 so it is frequent in both eras
  const steady = topicBase + 10 * TOPIC_WORDS + 2;
  words[steady] = STEADY;
  return { words, fnCount: fn.length, topicBase, bgBase, planted, steady };
}

/**
 * Write the corpus: one 'space-text' collection (text, tokens) in the synthetic 'test' corpus, `docsPerEra`
 * documents per era of `tokensPerDoc` tokens in passages of `passageTokens`, 8 authors per era; the English
 * token stream files under `tokensDir`; and two tracked expressions (ledger, steady) with a succeeded
 * materialize run and expr_doc rows counted from the generated ids.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{tokensDir: string, eras?: Array<[number, number]>, docsPerEra?: number, tokensPerDoc?: number, passageTokens?: number,
 *   seed?: number}} opts
 * @returns {{exprs: {ledger: number, steady: number}, tokens: number, docs: number, vocab: ReturnType<typeof syntheticVocab>,
 *   eras: Array<[number, number]>, collection: string}}
 */
export function buildSpaceCorpus(db, { tokensDir, eras = [[1880, 1899], [1900, 1919]], docsPerEra = 30, tokensPerDoc = 100_000,
  passageTokens = 200, seed = 7 } = {}) {
  const rng = mulberry32(seed);
  const vocab = syntheticVocab();
  const fnCum = zipf(vocab.fnCount, 1.0), topicCum = zipf(TOPIC_WORDS, 0.5), bgCum = zipf(BACKGROUND, 0.8);
  db.prepare(`INSERT INTO corpus (slug, name, kind, is_synthetic, description, license, created_at)
    VALUES ('test', 'Test fixtures (synthetic)', 'synthetic', 1, 'Invented test documents', 'CC0 (synthetic)', ?)
    ON CONFLICT(slug) DO NOTHING`).run(nowIso());
  registerFileAdapters(db);
  const coll = ensureCollection(db, { slug: 'space-text', name: 'Synthetic space texts (synthetic)', corpus: 'test', adapter_id: 'file.jsonl',
    domain: 'imported', modality: 'text', unit: 'tokens', sampling: 'user', coverage_gate: 2000, selection_note: 'generated token streams (synthetic)' });
  const batch = createBatch(db, { collection: coll.id, format: 'jsonl', fileName: 'space-text.jsonl' });

  const insDoc = db.prepare(`INSERT INTO document (collection_id, import_batch_id, ext_id, kind, title, author, lang_declared, lang_text,
      lang_confidence, is_translation, has_full_text, lo_day, hi_day, y_lo, y_hi, precision, basis, date_role, chrono_status, date_label,
      original_meta_json, token_count, passage_count, is_synthetic, created_at)
    VALUES (?, ?, ?, 'book', ?, ?, 'en', 'en', 1, 0, 0, ?, ?, ?, ?, 'year', 'stated', 'publication', 'dated', ?, ?, ?, ?, 1, ?)`);
  const insPas = db.prepare(`INSERT INTO passage (document_id, ord, field, field_class, time_role, unit, quality, start_off, end_off, lang,
      lang_confidence, token_count, y_lo, y_hi, is_synthetic) VALUES (?, ?, 'body', 'text', 'document', 'paragraph', 'ok', ?, ?, 'en', 1, ?, ?, ?, 1)`);
  const insTok = db.prepare(`INSERT INTO doc_tokens (document_id, plang, field_class, tokens, passages) VALUES (?, 'en', 'text', ?, ?)`);

  const passagesPerDoc = Math.max(1, Math.round(tokensPerDoc / passageTokens));
  const ids = new Uint32Array(eras.length * docsPerEra * passagesPerDoc * (passageTokens + 4));
  const pidx = [];
  const counts = new Uint32Array(vocab.words.length);
  const perDoc = { ledger: new Map(), steady: new Map() };
  let total = 0, docs = 0;
  const now = nowIso();
  db.exec('BEGIN');
  eras.forEach(([lo, hi], e) => {
    const plantTopics = e === 0 ? [0, 1, 2, 3, 4] : [20, 21, 22, 23, 24];
    for (let d = 0; d < docsPerEra; d++) {
      const year = lo + Math.floor(rng() * (hi - lo + 1));
      const author = `Author ${String.fromCharCode(65 + e)}${d % 8} (synthetic)`;
      const docId = Number(insDoc.run(coll.id, batch, `space:${e}:${d}`, `Synthetic book ${e}-${d}`, author, dayFromYMD(year, 1, 1),
        dayFromYMD(year, 12, 31), year, year, String(year), JSON.stringify({ fixture: 'spaces', note: 'generated token stream (synthetic)' }),
        0, passagesPerDoc, now).lastInsertRowid);
      docs++;
      let docTokens = 0;
      for (let p = 0; p < passagesPerDoc; p++) {
        const topic = Math.floor(rng() * TOPICS);
        const start = total;
        for (let i = 0; i < passageTokens; i++) {
          const r = rng();
          let id;
          if (r < 0.45) id = draw(fnCum, rng());
          else if (r < 0.85) id = vocab.topicBase + topic * TOPIC_WORDS + draw(topicCum, rng());
          else id = vocab.bgBase + draw(bgCum, rng());
          ids[total++] = id;
        }
        if (plantTopics.includes(topic)) for (let k = 0; k < 2; k++) ids[start + Math.floor(rng() * passageTokens)] = vocab.planted;
        const n = total - start;
        const pid = Number(insPas.run(docId, p, start * 6, total * 6, n, year, year).lastInsertRowid);
        pidx.push(pid, start);
        for (let i = start; i < total; i++) {
          counts[ids[i]]++;
          if (ids[i] === vocab.planted) perDoc.ledger.set(docId, (perDoc.ledger.get(docId) ?? 0) + 1);
          else if (ids[i] === vocab.steady) perDoc.steady.set(docId, (perDoc.steady.get(docId) ?? 0) + 1);
        }
        docTokens += n;
      }
      insTok.run(docId, docTokens, passagesPerDoc);
      db.prepare('UPDATE document SET token_count = ? WHERE id = ?').run(docTokens, docId);
    }
  });
  db.prepare("UPDATE import_batch SET status = 'committed', committed_at = ? WHERE id = ?").run(now, batch);
  const exprs = {
    ledger: trackForTest(db, { surface: PLANTED, perDoc: perDoc.ledger }),
    steady: trackForTest(db, { surface: STEADY, perDoc: perDoc.steady }),
  };
  db.exec('COMMIT');
  writeStream(db, tokensDir, { ids: ids.subarray(0, total), pidx, words: vocab.words, counts });
  return { exprs, tokens: total, docs, vocab, eras, collection: coll.slug };
}

/** An expression counted from known per-document counts, under a succeeded materialize run (test-only). */
function trackForTest(db, { surface, perDoc }) {
  const corpusId = db.prepare("SELECT id FROM corpus WHERE slug = 'test'").get().id;
  const exprId = Number(db.prepare(`INSERT INTO expression (corpus_id, kind, surface, norm, lang, origin, is_synthetic, created_by, created_at)
    VALUES (?, 'word', ?, ?, 'en', 'user_query', 1, 'test', ?)`).run(corpusId, surface, surface, nowIso()).lastInsertRowid);
  db.prepare(`INSERT INTO expression_variant (expression_id, form, norm, lang, variant_type, rule, evidence_status, enabled)
    VALUES (?, ?, ?, 'en', 'identity', 'identity', 'documented', 1)`).run(exprId, surface, surface);
  const params = canonicalJson({ expr: exprId, fixture: 'spaces' });
  const runId = Number(db.prepare(`INSERT INTO analysis_run (stage, pipeline_version, code_hash, params_json, params_hash, scope_json,
      input_fingerprint, data_version, tokenizer_version, segmenter_version, icu_version, status, started_at, finished_at)
    VALUES ('materialize', 'materialize@test', 'test', ?, ?, ?, 'test', ?, 'u61m-1', 'seg-1', 'test', 'succeeded', ?, ?)`)
    .run(params, params, JSON.stringify({ expression: exprId }), dataVersion(db), nowIso(), nowIso()).lastInsertRowid);
  const ins = db.prepare(`INSERT INTO expr_doc (expression_id, document_id, plang, field_class, n, n_names, n_passages, first_off, run_id)
    VALUES (?, ?, 'en', 'text', ?, 0, ?, 0, ?)`);
  let total = 0;
  for (const [doc, n] of perDoc) { ins.run(exprId, doc, n, n, runId); total += n; }
  db.prepare(`INSERT INTO expression_state (expression_id, run_id, variants_hash, status, occ_total, docs_total, names_excluded, updated_at)
    VALUES (?, ?, 'test', 'ready', ?, ?, 0, ?)`).run(exprId, runId, total, perDoc.size, nowIso());
  return exprId;
}

function writeStream(db, dir, { ids, pidx, words, counts }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'en.u32'), new Uint8Array(ids.buffer, ids.byteOffset, ids.byteLength));
  const p = Uint32Array.from(pidx);
  writeFileSync(path.join(dir, 'en.pidx'), new Uint8Array(p.buffer));
  writeFileSync(path.join(dir, 'en.vocab.tsv'), words.map((w, i) => `${i}\t${w}\t${counts[i]}`).join('\n') + '\n');
  writeFileSync(path.join(dir, 'en.json'), JSON.stringify({ lang: 'en', version: 'fixture', data_version: dataVersion(db), tokenizer: TOKENIZER_VERSION,
    segmenter: 'seg-1', quality_version: '0', byte_order: endianness(), passages: pidx.length / 2, tokens: ids.length, types: words.length,
    run_id: null, built_at: nowIso() }));
}
