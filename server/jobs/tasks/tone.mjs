// OWNER: WP4
// tasks/tone.mjs — job 'tone': machine tone of the paragraphs of a comparison through the optional on-device
// adapter (SPEC §4.10). params: a Compare request {expr, a: {years, f}, b: {years, f}, toggles?, corpus?}.
//
// Scores every paragraph (passage) holding a counted occurrence of the expression in either slice — at most
// 2,000 per slice, a seeded sample beyond that — with Apple NLTagger's sentimentScore, and stores each score
// as a machine_tone annotation (is_machine = 1, method apple-nltagger-sentimentScore, the run's model_version
// = the macOS build). Compare shows them only as per-slice distributions. Fails with a clear message when
// the adapter is not installed or does not support the language; nothing is written then.

import { canonicalJson, mulberry32 } from '../../../src/shared/ids.mjs';
import { tokenize } from '../../../src/shared/tokenize.mjs';
import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { compareContext, evidenceDocIds } from '../../analysis/compare.mjs';
import { languageName } from '../../analysis/drift.mjs';
import { MAX_PARAGRAPHS, probeAdapter, sentimentScores, startAdapter, TONE_AUTHOR, TONE_LABEL, TONE_METHOD, TONE_VERSION,
  toneRunParams } from '../../analysis/tone.mjs';
import { nowIso, tx } from '../../db/open.mjs';
import { makeAnchor, sha256 } from '../../provenance/anchors.mjs';
import { assertInputsUnchanged, retryBusy, runWrites } from '../../analysis/commit.mjs';

export const type = 'tone';
export const { writes, priority } = JOB_TYPES[type];

const CODE_FILES = ['tone.mjs', 'compare.mjs'].map((f) => new URL(`../../analysis/${f}`, import.meta.url));

/**
 * @param {object} ctx TaskCtx (server/jobs/context.mjs)
 * @param {object} params a Compare request
 * @returns {Promise<object>} result_json
 */
export async function run(ctx, params) {
  const db = ctx.db;
  ctx.progress(0.01, 'evidence', 'reading the slices');
  const cx = compareContext(db, params);
  if (cx.mismatch && !cx.descriptive) {
    throw Object.assign(new Error(`Tone is not compared across media (A is ${cx.statsA.modality}, B is ${cx.statsB.modality}).`), { code: 'modality_mismatch' });
  }
  const runParams = toneRunParams(cx.runParams);
  const reuse = runWrites(ctx).findReusableRun('tone', { params: runParams, scope: cx.fp.scope, upstream: cx.fp.upstream });
  if (reuse) {
    ctx.progress(1, 'done', `reused tone run ${reuse}`);
    return { run_id: reuse, reused: true };
  }
  const adapter = startAdapter({ bin: ctx.paths.bin });
  try {
    const probe = await probeAdapter(adapter, { bin: ctx.paths.bin });
    const langs = probe?.languages?.sentiment ?? [];
    if (!probe.ok || !langs.includes(cx.lang)) {
      throw Object.assign(new Error(`Tone is not available for ${languageName(cx.lang)}`), { code: 'E_TONE_LANGUAGE',
        hint: `The on-device adapter scores ${langs.map(languageName).join(', ') || 'no language'} on this Mac.` });
    }
    const paragraphs = slicePassages(db, cx);
    const ids = [...new Set([...paragraphs.a, ...paragraphs.b])].sort((x, y) => x - y);
    const runId = runWrites(ctx).startRun('tone', { pipelineVersion: TONE_VERSION, params: runParams, scope: cx.fp.scope, upstream: cx.fp.upstream,
      model: 'Apple NaturalLanguage NLTagger sentimentScore', modelVersion: probe.macos ?? null, seed: 42, codeFiles: CODE_FILES });
    const texts = passageTexts(db, ids);
    ctx.progress(0.05, 'scoring', `${ids.length} paragraphs`);
    const scores = await sentimentScores(adapter, texts.map((t) => t?.text.replace(/\s+/g, ' ').trim() ?? ''), {
      lang: cx.lang, step: () => ctx.checkpoint(), onProgress: (done) => ctx.progress(0.05 + 0.85 * (done / Math.max(1, ids.length)), 'scoring',
        `${done} of ${ids.length} paragraphs`) });
    ctx.checkpoint();
    const at = nowIso();
    let written = 0, declined = 0;
    retryBusy(() => tx(db, () => {
      assertInputsUnchanged(db, runId);
      written = 0;
      declined = 0;
      const insA = db.prepare(`INSERT INTO annotation (target_type, target_ref, anchor_json, kind, author, is_machine, method, run_id, layer,
        supersedes, status, is_synthetic, current_rev, created_at) VALUES ('passage', ?, ?, 'machine_tone', ?, 1, ?, ?, 'machine tone', NULL,
        'active', ?, 1, ?)`);
      const insR = db.prepare(`INSERT INTO annotation_revision (annotation_id, rev, body_md, stance, dimensions_json, tags_json,
        evidence_refs_json, reason, author, at) VALUES (?, 1, ?, NULL, ?, '[]', '[]', NULL, ?, ?)`);
      const insF = db.prepare('INSERT INTO annotation_fts (rowid, body, tags) VALUES (?, ?, ?)');
      ids.forEach((pid, i) => {
        const s = scores[i], t = texts[i];
        if (s === null || !t || t.end <= t.start) { declined++; return; }
        const anchor = makeAnchor(t.original, { field: t.field, start: t.start, end: t.end }, { docId: t.doc, sha: t.sha });
        const id = Number(insA.run(String(pid), JSON.stringify(anchor), TONE_AUTHOR, TONE_METHOD, runId, t.synthetic, at).lastInsertRowid);
        const body = `Machine tone ${s.toFixed(2)} (−1 negative … 1 positive). ${TONE_LABEL}.`;
        const rev = Number(insR.run(id, body, canonicalJson({ machine_tone: s }), TONE_AUTHOR, at).lastInsertRowid);
        insF.run(rev, tokenize(body).tokens.join(' '), '');
        written++;
      });
    }), { checkpoint: () => ctx.checkpoint() });
    const metrics = { lang: cx.lang, paragraphs: { a: paragraphs.a.length, b: paragraphs.b.length, scored: written, declined },
      capped: paragraphs.capped, adapter: { macos: probe.macos ?? null, version: probe.version ?? null, languages: langs }, label: TONE_LABEL };
    runWrites(ctx).finishRun(runId, 'succeeded', { metrics });
    ctx.progress(1, 'done', `${written} paragraphs scored`);
    return { run_id: runId, reused: false, ...metrics };
  } finally {
    adapter.close();
  }
}

/**
 * Passages holding counted occurrences in each slice (the compared field classes and languages, names
 * excluded unless the toggle includes them), at most MAX_PARAGRAPHS per slice by a seeded sample.
 */
function slicePassages(db, cx) {
  const q = db.prepare(`SELECT DISTINCT o.passage_id AS id, p.field_class AS fc, p.lang, o.name_flag AS nm, d.lang_text FROM occurrence o
    JOIN passage p ON p.id = o.passage_id JOIN document d ON d.id = o.document_id
    WHERE o.expression_id = ? AND o.run_id = ? AND o.document_id IN (SELECT value FROM json_each(?)) AND p.quality = 'ok'`);
  const capped = {};
  const one = (st, spec, side) => {
    const classes = new Set(st.classes);
    const docs = JSON.stringify(evidenceDocIds(st));
    const ids = new Set();
    for (const e of cx.exprs) {
      for (const r of q.all(e.id, e.run, docs)) {
        if (!classes.has(r.fc) || (!cx.req.toggles.nm && r.nm)) continue;
        if (st.unit === 'tokens' && !spec.langOk(r.lang, r.fc, r.lang_text)) continue;
        ids.add(r.id);
      }
    }
    const list = [...ids].sort((x, y) => x - y);
    if (list.length <= MAX_PARAGRAPHS) return list;
    const rng = mulberry32(42 + (side === 'a' ? 0 : 1));
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    capped[side] = list.length;
    return list.slice(0, MAX_PARAGRAPHS).sort((x, y) => x - y);
  };
  return { a: one(cx.statsA, cx.specA, 'a'), b: one(cx.statsB, cx.specB, 'b'), capped };
}

/** Text of each passage with what its anchor needs (the full field text it indexes, and its sha256). */
function passageTexts(db, ids) {
  const p = db.prepare('SELECT id, document_id, field, start_off, end_off, is_synthetic FROM passage WHERE id = ?');
  const body = db.prepare('SELECT original, original_sha256 FROM document_text WHERE document_id = ?');
  const field = db.prepare('SELECT value FROM document_field WHERE document_id = ? AND field = ?');
  const cache = new Map();
  return ids.map((id) => {
    const r = p.get(id);
    if (!r) return null;
    const key = `${r.document_id}|${r.field}`;
    if (!cache.has(key)) {
      if (cache.size > 32) cache.clear();
      if (r.field === 'body') {
        const b = body.get(r.document_id);
        cache.set(key, b ? { original: b.original, sha: b.original_sha256 } : null);
      } else {
        const v = field.get(r.document_id, r.field)?.value ?? null;
        cache.set(key, v === null ? null : { original: v, sha: sha256(v) });
      }
    }
    const src = cache.get(key);
    if (!src) return null;
    return { doc: r.document_id, field: r.field, start: r.start_off, end: r.end_off, original: src.original, sha: src.sha,
      text: src.original.slice(r.start_off, r.end_off), synthetic: r.is_synthetic };
  });
}
