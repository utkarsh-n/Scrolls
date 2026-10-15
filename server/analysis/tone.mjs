// OWNER: WP4
// tone.mjs — machine tone as a fallible annotation (SPEC §4.10): the optional on-device adapter
// (tools/nl-adapter → $SCROLLS_DATA/bin/scrolls-nl, JSONL over stdio) scores paragraphs with Apple's
// NLTagger sentimentScore (−1…1). Scores are stored as machine_tone annotations of a 'tone' run and shown
// only as a distribution per slice with a document-block bootstrap CI of the mean — never as a label on one
// passage. Gate: adapter installed, language supported, ≥ 30 paragraphs per slice. Scrolls works without
// the adapter; tone then says "Tone needs the optional on-device adapter (not installed)".
// Stance and irony are never inferred: they come from human annotations only.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { canonicalJson } from '../../src/shared/ids.mjs';
import { paths } from '../config.mjs';
import { inputFingerprint } from '../jobs/context.mjs';
import { blockBootstrap, quantile } from './bootstrap.mjs';

/** Pipeline version of tone runs. */
export const TONE_VERSION = 'tone@1.0.0';
/** annotation.method of machine tone (§4.10). */
export const TONE_METHOD = 'apple-nltagger-sentimentScore';
/** The label every tone value carries (§2.E item 7). */
export const TONE_LABEL = 'Apple NLTagger — modern reader model, fallible, anachronistic for historical text';
/** At most this many paragraphs are scored per slice (a seeded sample beyond it). */
export const MAX_PARAGRAPHS = 2000;
/** Author of machine tone annotations. */
export const TONE_AUTHOR = 'scrolls-nl (Apple NLTagger)';
const HIST_BINS = 10;

/** Path of the compiled adapter. */
export const adapterPath = (bin = paths().bin) => path.join(bin, 'scrolls-nl');
const probeFile = (bin = paths().bin) => path.join(bin, 'scrolls-nl.probe.json');

/**
 * What is known about the adapter without running it: installed or not, and the languages its last probe
 * (written by build.sh and refreshed by every tone run) reported.
 * @param {{bin?: string}} [opts]
 * @returns {{installed: boolean, probe: object|null, sentimentLanguages: string[]|null}}
 */
export function adapterStatus({ bin = paths().bin } = {}) {
  const installed = existsSync(adapterPath(bin));
  let probe = null;
  if (installed && existsSync(probeFile(bin))) {
    try { probe = JSON.parse(readFileSync(probeFile(bin), 'utf8')); } catch { probe = null; }
  }
  const langs = probe?.languages?.sentiment;
  return { installed, probe, sentimentLanguages: Array.isArray(langs) ? langs : null };
}

/**
 * Start the adapter as a child process and talk JSONL to it: request() sends one object with an id and
 * resolves with the response carrying that id.
 * @param {{bin?: string, timeoutMs?: number}} [opts]
 * @returns {{request(obj: object): Promise<object>, close(): void}}
 * @throws {Error} code E_NL_ADAPTER_MISSING when it is not installed
 */
export function startAdapter({ bin = paths().bin, timeoutMs = 30000 } = {}) {
  const file = adapterPath(bin);
  if (!existsSync(file)) throw Object.assign(new Error('Tone needs the optional on-device adapter (not installed)'), { code: 'E_NL_ADAPTER_MISSING',
    hint: 'Build it with npm run build:nl (macOS, Xcode command-line tools).' });
  const child = spawn(file, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let seq = 0, dead = null;
  const failAll = (err) => {
    dead ??= err;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(dead); }
    pending.clear();
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
  });
  child.on('error', (err) => failAll(Object.assign(new Error(`The NL adapter could not start: ${err.message}`), { code: 'E_NL_ADAPTER' })));
  child.on('exit', (code) => failAll(Object.assign(new Error(`The NL adapter exited (${code}).`), { code: 'E_NL_ADAPTER' })));
  child.stdin.on('error', () => { /* reported by exit */ });
  return {
    request(obj) {
      if (dead) return Promise.reject(dead);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error('The NL adapter did not answer in time.'), { code: 'E_NL_ADAPTER' }));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ ...obj, id })}\n`);
      });
    },
    close() {
      try { child.stdin.end(); } catch { /* already closed */ }
      child.kill();
    },
  };
}

/**
 * Probe the adapter and remember the answer next to it (what Compare reads to say which languages work).
 * @param {{request: Function}} adapter
 * @param {{bin?: string}} [opts]
 * @returns {Promise<object>}
 */
export async function probeAdapter(adapter, { bin = paths().bin } = {}) {
  const probe = await adapter.request({ op: 'probe' });
  const { id, ...rest } = probe;
  if (rest.ok) {
    try { writeFileSync(probeFile(bin), JSON.stringify(rest)); } catch { /* the cache is a convenience */ }
  }
  return rest;
}

/**
 * Sentiment scores of passages (null where the adapter declined one).
 * @param {{request: Function}} adapter
 * @param {string[]} texts
 * @param {{lang?: string, step?: () => void, onProgress?: (done: number) => void, concurrency?: number}} [opts]
 * @returns {Promise<Array<number|null>>}
 */
export async function sentimentScores(adapter, texts, { lang = 'en', step = () => {}, onProgress = () => {}, concurrency = 16 } = {}) {
  const out = new Array(texts.length).fill(null);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < texts.length) {
      const i = next++;
      step();
      const r = await adapter.request({ op: 'sentiment', lang, text: texts[i] });
      if (typeof r.score === 'number' && Number.isFinite(r.score)) out[i] = Math.max(-1, Math.min(1, r.score));
      if (++done % 50 === 0) onProgress(done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  onProgress(done);
  return out;
}

/**
 * Distribution of tone scores: n, mean with a bootstrap 95% CI (by document when `docs` is given), SD,
 * median and a 10-bin histogram over [−1, 1].
 * @param {number[]} scores
 * @param {{docs?: number[]|null, resamples?: number, seed?: number}} [opts] docs[i] = document of scores[i]
 * @returns {{n: number, docs: number|null, mean: number|null, ci: [number, number]|null, sd: number|null, median: number|null,
 *   histogram: Array<{lo: number, hi: number, n: number}>}}
 */
export function toneDistribution(scores, { docs = null, resamples = 1000, seed = 42 } = {}) {
  const n = scores.length;
  const histogram = Array.from({ length: HIST_BINS }, (_, i) => ({ lo: -1 + (2 * i) / HIST_BINS, hi: -1 + (2 * (i + 1)) / HIST_BINS, n: 0 }));
  for (const s of scores) histogram[Math.min(HIST_BINS - 1, Math.max(0, Math.floor(((s + 1) / 2) * HIST_BINS)))].n++;
  if (!n) return { n: 0, docs: docs ? 0 : null, mean: null, ci: null, sd: null, median: null, histogram };
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const sorted = [...scores].sort((a, b) => a - b);
  let blocks;
  if (docs) {
    const byDoc = new Map();
    scores.forEach((s, i) => { const b = byDoc.get(docs[i]) ?? [0, 0]; b[0] += s; b[1]++; byDoc.set(docs[i], b); });
    blocks = [...byDoc.values()];
  } else {
    blocks = scores.map((s) => [s, 1]);
  }
  const ci = blockBootstrap(blocks, (sample) => {
    let s = 0, c = 0;
    for (const b of sample) { s += b[0]; c += b[1]; }
    return c ? s / c : null;
  }, { resamples, seed });
  return { n, docs: docs ? new Set(docs).size : null, mean, ci, sd, median: quantile(sorted, 0.5), histogram };
}

// ── Stored tone runs ─────────────────────────────────────────────────────────────────────────────────

/**
 * Canonical parameters of a tone run for a comparison (Compare and the tone job hash the same object).
 * @param {{expr: number[], a: object, b: object, toggles: object, corpus: string|null}} req
 * @returns {object}
 */
export function toneRunParams(req) {
  return { version: TONE_VERSION, expr: [...req.expr].sort((x, y) => x - y), a: { years: req.a.years, f: req.a.f ?? '' },
    b: { years: req.b.years, f: req.b.f ?? '' }, toggles: req.toggles, corpus: req.corpus ?? null, max_paragraphs: MAX_PARAGRAPHS,
    // as saved (RF-2): a run of the saved view's pins and cutoffs is its own comparison
    ...(req.runs ? { runs: req.runs } : {}), ...(req.cutoffs ? { cutoffs: req.cutoffs } : {}) };
}

/**
 * Scores of the newest succeeded tone run for this comparison on the current data, or null.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} params toneRunParams()
 * @param {{scope: object, upstream: number[]}} fp
 * @returns {{run: number, model_version: string|null, metrics: object|null, rows: Array<{passage: number, doc: number, score: number}>}|null}
 */
export function storedTone(db, params, fp) {
  const hash = createHash('sha256').update(canonicalJson(params)).digest('hex');
  const run = db.prepare(`SELECT id, model_version, metrics_json FROM analysis_run WHERE stage = 'tone' AND status = 'succeeded'
    AND params_hash = ? AND input_fingerprint = ? ORDER BY id DESC LIMIT 1`).get(hash, inputFingerprint(db, fp));
  if (!run) return null;
  const rows = db.prepare(`SELECT CAST(a.target_ref AS INTEGER) AS passage, p.document_id AS doc,
      json_extract(r.dimensions_json, '$.machine_tone') AS score
    FROM annotation a JOIN annotation_revision r ON r.annotation_id = a.id AND r.rev = a.current_rev
    JOIN passage p ON p.id = CAST(a.target_ref AS INTEGER)
    WHERE a.run_id = ? AND a.kind = 'machine_tone' AND a.status = 'active'`).all(run.id).filter((r) => typeof r.score === 'number');
  let metrics = null;
  try { metrics = JSON.parse(run.metrics_json); } catch { metrics = null; }
  return { run: run.id, model_version: run.model_version ?? null, metrics, rows };
}
