// OWNER: WP8 — the acceptance journey of `npm run verify`, over HTTP against a running server (SPEC §11, §12.5);
// RF-3 (R, ref-freeze-1): the requests the phone journey needs, and a JSONL record of every request and response.
//
// import CSV / JSONL / malformed → search → track → timeline tiers L0–L5 + conservation → passage offsets → Compare
// gates → Compare and save a view of the imported text (as saved = current at the save) → save the demo view →
// annotation (+ revision) → review a link → restart → reopen the views → revert the import after the save → the views as
// saved (timeline, tiles, the inspector's concordance, lineage) and as-saved Compare (RF-2) → annotation as of a past
// time → integrity.
// Request bodies come from the UI's own builders (tiles-client, compare, views-menu, core/savedview, annotation-editor),
// so the journey sends what the page sends; every JSON response is checked against its contract shape.
//
// The record (createClient's `record`): one JSON object per line, in request order — {seq, step, method, path, headers?,
// body? | raw? {base64, bytes, sha256}, poll?, status, response | text, ms}, plus {seq, step, event: 'restart'} where the
// server restarts. `poll: true` marks a repeated read (a job's status, a query still counting, the integrity check) that a
// replayer may collapse to its last answer. G7 (IOS-SPEC §2.2) replays the record against the Swift engine.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { check, endpointFor } from '../tests/helpers/shape.mjs';
import { monthBinOfDay } from '../src/shared/dates.mjs';
import { tokenize } from '../src/shared/tokenize.mjs';
import { canonicalize, defaultState, formatFilter, stateHash } from '../src/shared/viewstate.mjs';
import { openedView } from '../src/ui/core/savedview.mjs';
import { queryBody } from '../src/ui/timeline/tiles-client.mjs';
import { suggestionAction } from '../src/ui/shell/search.mjs';
import { compareRequest } from '../src/ui/panels/compare.mjs';
import { asSavedParams, saveRequest } from '../src/ui/panels/views-menu.mjs';
import { annotationRequest } from '../src/ui/panels/annotation-editor.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fold = (s) => tokenize(String(s ?? '')).tokens.join(' ');
const FINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const JOB_WAIT_MS = 15 * 60 * 1000; // boot may re-run long jobs first (requeued clustering on an M1 database)
const TIER_WIDTH = { L0: 1000, L1: 100, L2: 10, L3: 1 };
const TIERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
/** Bins per tile, and tiles per request (server/aggregate/tiles.mjs MAX_TILES). */
const TILE_BINS = 64, MAX_TILES = 64;

// ── HTTP client with shape checks ───────────────────────────────────────────────────────────────────

/**
 * @param {string} baseUrl
 * @param {{record?: ((entry: object) => void)|null}} [opts] `record` receives every request and response (RF-3, see the head
 *   of this file)
 * @returns {{call: Function, setBase(url: string): void, setStep(name: string|null): void, event(name: string, data?: object): void,
 *   stats: {calls: number, checked: number, errors: Array<object>}}}
 */
export function createClient(baseUrl, { record = null } = {}) {
  let base = baseUrl;
  let step = null, seq = 0;
  const stats = { calls: 0, checked: 0, errors: [], retries: [] };
  // A heavy read over 5 s answers 503 QUERY_TIMEOUT (§4.12). Cold read workers on a freshly cloned database, next
  // to the jobs an older database re-runs at boot, can pass that on a loaded machine; one retry is made and
  // reported in the step's row, so a timeout that persists still fails.
  async function call(method, path, opts = {}) {
    const r = await once(method, path, opts);
    if (r.status === 503 && r.json?.error?.code === 'QUERY_TIMEOUT' && opts.retry !== false) {
      stats.retries.push(`${method} ${path.split('?')[0]}`);
      await sleep(1000);
      return once(method, path, opts);
    }
    return r;
  }
  async function once(method, path, { body, raw = null, headers = {}, timeoutMs = 120000, poll = false } = {}) {
    const h = { 'X-Scrolls-Session': 'verify', ...headers };
    if (method !== 'GET') h.Origin = base;
    let payload;
    if (raw !== null) payload = raw;
    else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    const t0 = performance.now();
    const res = await fetch(base + path, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    const ms = performance.now() - t0;
    stats.calls++;
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* CSV, HTML */ }
    const ep = endpointFor(method, path.split('?')[0]);
    const shape = res.status >= 400 ? 'ErrorBody' : ep?.response ?? null;
    let errs = [];
    if (shape && json !== null) {
      stats.checked++;
      errs = check(shape, json);
      if (errs.length) stats.errors.push({ method, path: path.slice(0, 120), shape, errs: errs.slice(0, 3) });
    }
    if (record) {
      const bytes = raw === null ? null : Buffer.from(raw);
      record({ seq: ++seq, step, method, path, ...(Object.keys(headers).length ? { headers } : {}),
        ...(bytes ? { raw: { base64: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
          : body !== undefined ? { body } : {}),
        ...(poll ? { poll: true } : {}), status: res.status, ...(json !== null ? { response: json } : { text }), ms: Math.round(ms) });
    }
    return { status: res.status, json, text, ms, shape, errs, headers: res.headers };
  }
  return {
    call, stats,
    setBase(url) { base = url; },
    setStep(name) { step = name; },
    event(name, data = {}) { record?.({ seq: ++seq, step, event: name, ...data }); },
  };
}

/** A step failure with a message for the table. */
class StepError extends Error {}
const must = (cond, message) => { if (!cond) throw new StepError(message); };
const ok200 = (r, what) => must(r.status === 200, `${what}: HTTP ${r.status} ${r.json?.error?.code ?? ''} ${r.json?.error?.message ?? r.text.slice(0, 160)}`);

async function waitJob(call, id, timeoutMs = JOB_WAIT_MS) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await call('GET', `/api/jobs/${id}`, { poll: true });
    ok200(r, `job ${id}`);
    if (FINAL.has(r.json.status)) return r.json;
    must(Date.now() < until, `job ${id} still ${r.json.status} after ${timeoutMs / 1000} s`);
    await sleep(250);
  }
}

// ── fixtures: real public-domain paragraphs from the snapshot itself ────────────────────────────────

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/**
 * Import files built from the snapshot's own Project Gutenberg texts (verbatim paragraphs, their titles, authors
 * and the year Scrolls holds for each book), or the repository's synthetic ingest fixtures when the snapshot has
 * no Cipher books. Read from the clone before the server starts.
 * @param {string} dbPath the clone
 * @param {URL} fixturesDir tests/fixtures/ingest/
 * @param {{collection?: string}} [opts] the collection whose English full texts are sampled
 * @returns {{kind: 'real'|'synthetic', csv: Buffer, jsonl: Buffer, malformed: Buffer, csvRows: number, jsonlRows: number, phrase: string, word: string}}
 */
export function buildImportFiles(dbPath, fixturesDir, { collection = 'cipher-gutenberg' } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows = [];
  try {
    const docs = db.prepare(`SELECT d.id, d.title, d.author, d.y_lo FROM document d JOIN collection c ON c.id = d.collection_id
      WHERE c.slug = ? AND d.deleted_at IS NULL AND d.has_full_text = 1 AND d.lang_text = 'en'
        AND d.is_translation = 0 AND d.chrono_status = 'dated' AND d.y_lo BETWEEN 1700 AND 1928 ORDER BY d.id LIMIT 24`).all(collection);
    const pick = db.prepare(`SELECT start_off, end_off FROM passage WHERE document_id = ? AND field = 'body' AND quality = 'ok'
      AND token_count BETWEEN 40 AND 140 AND ord >= 30 ORDER BY ord LIMIT 1`);
    const text = db.prepare('SELECT original FROM document_text WHERE document_id = ?');
    for (const d of docs) {
      const p = pick.get(d.id);
      if (!p) continue;
      const original = text.get(d.id)?.original;
      if (!original) continue;
      rows.push({ id: `pg${d.id}-verify`, title: d.title, author: d.author ?? '', year: String(d.y_lo),
        text: original.slice(p.start_off, p.end_off).replace(/\r\n?/g, '\n').trim() });
      if (rows.length === 10) break;
    }
  } finally {
    db.close();
  }
  if (rows.length >= 8) {
    const csvRows = rows.slice(0, 6), jsonRows = rows.slice(6, 10);
    const csv = ['id,title,author,published,language,text', ...csvRows.map((r) =>
      [r.id, r.title, r.author, r.year, 'English', r.text].map(csvCell).join(','))].join('\n') + '\n';
    const line = (r, extra = {}) => JSON.stringify({ id: r.id, title: r.title, author: r.author, date: r.year, lang: 'en', body: r.text, ...extra });
    const jsonl = jsonRows.map((r) => line(r)).join('\n') + '\n';
    const broken = line({ ...jsonRows[2], id: `${jsonRows[2].id}-b` }).slice(0, -12); // cut inside the body string
    const malformed = [
      line({ ...jsonRows[0], id: `${jsonRows[0].id}-again` }),
      line({ ...jsonRows[1], id: `${jsonRows[1].id}-again` }),
      broken,
      line({ ...jsonRows[3], id: `${jsonRows[3].id}-again` }, { date: '2019-02-30' }),
      line({ ...jsonRows[2], id: `${jsonRows[2].id}-again` }),
    ].join('\n') + '\n';
    const words = csvRows[0].text.match(/\p{L}+/gu) ?? [];
    const phrase = words.slice(5, 9).join(' ');
    const word = [...csvRows.flatMap((r) => r.text.match(/\p{Ll}{7,}/gu) ?? [])].sort((a, b) => b.length - a.length)[0] ?? words[0];
    return { kind: 'real', csv: Buffer.from(csv), jsonl: Buffer.from(jsonl), malformed: Buffer.from(malformed),
      csvRows: csvRows.length, jsonlRows: jsonRows.length, phrase, word: word.toLowerCase() };
  }
  const csv = readFileSync(new URL('letters.csv', fixturesDir));
  const jsonl = readFileSync(new URL('records.jsonl', fixturesDir));
  // records.jsonl has a blank line and a broken record of its own: the malformed file is made from its valid
  // records, like the real one (5 lines: one cut inside a value, one with an impossible date)
  const valid = jsonl.toString('utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const again = (r, suffix, extra = {}) => JSON.stringify({ ...r, id: `${r.id}-${suffix}`, ...extra });
  const cut = again(valid[2 % valid.length], 'b');
  const malformed = Buffer.from([
    again(valid[0], 'again'),
    again(valid[1 % valid.length], 'again'),
    cut.slice(0, Math.floor(cut.length * 0.6)),
    again(valid[0], 'again2', { date: '2019-02-30' }),
    again(valid[2 % valid.length], 'again'),
  ].join('\n') + '\n');
  return { kind: 'synthetic', csv, jsonl, malformed, csvRows: null, jsonlRows: null, phrase: 'the zero column', word: 'ledger' };
}

// ── steps ───────────────────────────────────────────────────────────────────────────────────────────

async function importFile(call, name, bytes, collection) {
  const up = await call('POST', '/api/imports', { raw: bytes, headers: { 'Content-Type': 'application/octet-stream',
    'X-Scrolls-Filename': encodeURIComponent(name), 'X-Scrolls-Collection': encodeURIComponent(JSON.stringify(collection)) } });
  ok200(up, `upload ${name}`);
  const id = up.json.import_batch_id, preview = up.json.preview;
  const v = await call('PUT', `/api/imports/${id}/mapping`, { body: { mapping: preview.suggested_mapping } });
  ok200(v, `dry run ${name}`);
  const c = await call('POST', `/api/imports/${id}/commit`, { body: { mapping: preview.suggested_mapping } });
  ok200(c, `commit ${name}`);
  const job = await waitJob(call, c.json.job.id);
  must(job.status === 'succeeded', `commit job ${job.id} ${job.status}: ${job.error?.message ?? ''}`);
  const sumErrs = check('ImportSummary', job.result);
  must(!sumErrs.length, `ImportSummary: ${sumErrs.slice(0, 2).join('; ')}`);
  const problems = await call('GET', `/api/imports/${id}/problems.csv`);
  ok200(problems, `problems.csv of ${name}`);
  return { id, preview, validation: v.json.validation, summary: job.result, problems: problems.text };
}

/**
 * The tile range [t0, t1] covering a span at a tier: years for L0–L3, months (L4) and days (L5) from the extent's days,
 * one tile of margin on each side.
 */
function tileRange(tier, { fromYear, toYear, fromDay, toDay }) {
  let b0, b1;
  if (tier in TIER_WIDTH) { b0 = Math.floor(fromYear / TIER_WIDTH[tier]); b1 = Math.floor(toYear / TIER_WIDTH[tier]); }
  else if (tier === 'L4') { b0 = monthBinOfDay(fromDay); b1 = monthBinOfDay(toDay); }
  else { b0 = fromDay; b1 = toDay; }
  return [Math.floor(b0 / TILE_BINS) - 1, Math.floor(b1 / TILE_BINS) + 1];
}

/** Σ bin n + Σ owned washes + undated + scheduled = lane n, per lane, for one tier over a span (≤ 64 tiles per request). */
async function conservation(call, q, tier, span) {
  const [t0, t1] = tileRange(tier, span);
  const sums = {};
  const washes = new Set();
  let tiles = 0, requests = 0;
  for (let a = t0; a <= t1; a += MAX_TILES) {
    const r = await call('GET', `/api/timeline/tiles?q=${q.queryKey}&tier=${tier}&tiles=${a}..${Math.min(t1, a + MAX_TILES - 1)}`);
    ok200(r, `tiles ${tier}`);
    requests++;
    tiles += r.json.tiles.length;
    for (const tile of r.json.tiles) {
      for (const [lane, { strands }] of Object.entries(tile.lanes)) {
        for (const cells of Object.values(strands)) for (const c of cells) sums[lane] = (sums[lane] ?? 0) + c[1];
      }
      for (const wsh of tile.washes ?? []) {
        const k = wsh.key ?? JSON.stringify(wsh);
        if (washes.has(k)) continue;
        washes.add(k);
        sums[wsh.lane] = (sums[wsh.lane] ?? 0) + wsh.n;
      }
    }
  }
  const bad = q.lanes.filter((l) => (sums[l.key] ?? 0) + l.undated + l.scheduled !== l.n)
    .map((l) => `${l.key}: ${(sums[l.key] ?? 0) + l.undated + l.scheduled} ≠ ${l.n}`);
  return { tiles, requests, bad };
}

/** POST /api/timeline/query for a view (as saved: with its cutoffs), waiting while its counts are made. */
async function timelineQuery(call, view, { cutoffs = null } = {}) {
  for (let i = 0; ; i++) {
    const r = await call('POST', '/api/timeline/query', { body: queryBody(view, { formatFilter, cutoffs }), poll: i > 0 });
    ok200(r, 'timeline query');
    if (r.json.status !== 'materializing') return r.json;
    const job = typeof r.json.job === 'object' && r.json.job !== null ? r.json.job.id : r.json.job;
    if (Number.isInteger(job)) await waitJob(call, job); else await sleep(500);
    must(i < 40, 'timeline query still materializing');
  }
}

/** Conservation at every tier L0–L5 (RF-3; L4/L5 need the extent's days). */
async function tiersAndConservation(call, q, label, tiers = TIERS) {
  const yearOf = (s) => Number(String(s ?? '').match(/-?\d{1,4}/)?.[0]);
  const span = { fromYear: Math.min(yearOf(q.extent?.from) || 1800, 1800) - 10, toYear: Math.max(yearOf(q.extent?.to) || 2026, 2030),
    fromDay: q.extent?.from_day ?? null, toDay: q.extent?.to_day ?? null };
  const parts = [];
  for (const tier of tiers) {
    if ((tier === 'L4' || tier === 'L5') && (span.fromDay === null || span.toDay === null)) { parts.push(`${tier} no dated match`); continue; }
    const c = await conservation(call, q, tier, span);
    must(!c.bad.length, `${label} ${tier}: ${c.bad.slice(0, 3).join('; ')}`);
    parts.push(`${tier} ${c.tiles} tiles`);
  }
  return `${label}: n=${q.totals.n} in ${q.lanes.length} lane(s); conservation holds at ${parts.join(', ')}`;
}

/** The numbers of a Compare payload that must not move under an as-saved reader (RF-2). */
const compareCounts = (p) => JSON.stringify(['a', 'b'].map((k) => ({ docs: p.coverage?.[k]?.docs, units: p.coverage?.[k]?.[p.coverage?.[k]?.unit],
  occurrences: p.freq?.[k]?.occurrences ?? null, n: p.freq?.[k]?.n ?? null, collections: p.coverage?.[k]?.collections })));

/**
 * Run the journey. `restart()` stops the server and starts it again on the same data directory; it resolves
 * with the new base URL.
 * @param {{client: ReturnType<typeof createClient>, files: ReturnType<typeof buildImportFiles>,
 *   restart: () => Promise<string>}} opts
 * @returns {Promise<Array<{name: string, ok: boolean|null, ms: number, detail: string}>>} ok null = skipped
 */
export async function runJourney({ client, files, restart }) {
  const { call } = client;
  const steps = [];
  const st = {}; // what later steps need
  async function step(name, needs, fn) {
    const missing = needs.filter((k) => st[k] === undefined);
    if (missing.length) { steps.push({ name, ok: null, ms: 0, detail: `skipped: needs ${missing.join(', ')}` }); return; }
    client.setStep?.(name);
    const errorsBefore = client.stats.errors.length, retriesBefore = client.stats.retries.length;
    const t0 = performance.now();
    try {
      let detail = await fn();
      const shapeErrs = client.stats.errors.slice(errorsBefore);
      if (shapeErrs.length) throw new StepError(`shape: ${shapeErrs.map((e) => `${e.method} ${e.path} (${e.shape}) ${e.errs[0]}`).slice(0, 2).join(' | ')}`);
      steps.push({ name, ok: true, ms: performance.now() - t0, detail: String(detail ?? '') + retried() });
    } catch (err) {
      steps.push({ name, ok: false, ms: performance.now() - t0,
        detail: (err instanceof StepError ? err.message : String(err?.stack ?? err).split('\n').slice(0, 2).join(' ')) + retried() });
    }
    function retried() {
      const r = client.stats.retries.slice(retriesBefore);
      return r.length ? ` [retried after QUERY_TIMEOUT: ${r.join(', ')}]` : '';
    }
  }

  await step('health', [], async () => {
    const h = await call('GET', '/api/health');
    ok200(h, 'health');
    must(h.json.ok === true, 'health.ok is not true');
    st.health = h.json;
    return `v${h.json.version}, contract ${h.json.contract}, dataVersion ${h.json.dataVersion}, cipher ${h.json.cipher?.status}, jobs running ${h.json.jobs.running} queued ${h.json.jobs.queued}`;
  });

  const collection = (name) => ({ name, unit: 'tokens', license: files.kind === 'real' ? 'Public domain (Project Gutenberg texts)' : 'Synthetic test fixture' });
  await step(`import CSV (${files.kind} text)`, ['health'], async () => {
    const r = await importFile(call, 'verify-paragraphs.csv', files.csv, collection('Verify CSV'));
    if (files.csvRows !== null) must(r.summary.rows.accepted === files.csvRows, `accepted ${r.summary.rows.accepted} of ${files.csvRows}`);
    must(r.summary.documents.created >= 1, 'no document created');
    st.csv = r;
    return `rows ${JSON.stringify(r.summary.rows)}; ${r.summary.passages} passages, ${r.summary.tokens} tokens`;
  });
  await step(`import JSONL (${files.kind} text)`, ['health'], async () => {
    const r = await importFile(call, 'verify-passages.jsonl', files.jsonl, collection('Verify JSONL'));
    if (files.jsonlRows !== null) must(r.summary.rows.accepted === files.jsonlRows, `accepted ${r.summary.rows.accepted} of ${files.jsonlRows}`);
    st.jsonl = r;
    return `rows ${JSON.stringify(r.summary.rows)}; ${r.summary.passages} passages`;
  });
  await step('import malformed JSONL', ['health'], async () => {
    const r = await importFile(call, 'verify-malformed.jsonl', files.malformed, collection('Verify malformed'));
    const issues = r.preview.issues ?? [];
    const parse = issues.find((i) => i.code === 'E_JSON_PARSE');
    must(parse && Number.isInteger(parse.line) && Number.isInteger(parse.col) && parse.suggestion, 'the preview names no E_JSON_PARSE with line, column and suggestion');
    must(r.summary.rows.rejected === 1 && r.summary.rows.seen === 5, `rows ${JSON.stringify(r.summary.rows)} (expected 5 seen, 1 rejected)`);
    const lines = r.problems.trim().split('\n');
    const header = lines[0].split(',');
    must(header.join(',') === 'code,severity,line,col,field,value_excerpt,message,suggestion', `problems.csv header ${lines[0]}`);
    must(lines.some((l) => l.startsWith('E_JSON_PARSE,')), 'problems.csv has no E_JSON_PARSE row');
    must(lines.some((l) => l.startsWith('E_DATE_INVALID,')), 'problems.csv has no E_DATE_INVALID row (2019-02-30)');
    return `E_JSON_PARSE at line ${parse.line}:${parse.col}; rows ${JSON.stringify(r.summary.rows)}; problems ${JSON.stringify(r.summary.problems?.by_code ?? {})}`;
  });

  await step('search (imported text)', ['csv'], async () => {
    const r = await call('GET', `/api/search?q=${encodeURIComponent(files.phrase)}&corpus=user&scope=all&limit=10`);
    ok200(r, 'search');
    must(r.json.hits?.passages >= 1, `'${files.phrase}': ${JSON.stringify(r.json.hits)}`);
    const row = (r.json.kwic ?? []).find((k) => fold(k.match) === fold(files.phrase));
    must(row, `no KWIC row matches '${files.phrase}'`);
    return `'${files.phrase}' → ${r.json.hits.passages} passage(s) in ${r.json.hits.documents} document(s), dated ${row.date?.label ?? 'undated'}`;
  });

  await step('search (demo)', ['health'], async () => {
    const r = await call('GET', `/api/search?q=${encodeURIComponent('carry the zero')}&corpus=demo&scope=all&limit=10`);
    ok200(r, 'search');
    const sug = r.json.suggestions.find((s) => s.type === 'expression');
    must(sug, 'no expression suggestion for the demo phrase');
    const act = suggestionAction(sug);
    let id = act.strand?.id;
    if (act.kind === 'track') {
      const e = await call('POST', '/api/expressions', { body: { surface: r.json.query.surface, corpus: 'demo' } });
      ok200(e, 'track expression');
      id = e.json.expression.id;
    }
    must(Number.isInteger(id), `suggestion ${sug.ref} gives no expression id`);
    st.demoExpr = id;
    return `${sug.ref}, ${sug.count} occurrences; ${r.json.hits.documents} documents`;
  });

  await step('timeline tiers L0–L5 + conservation (demo)', ['demoExpr'], async () => {
    const v = defaultState('demo');
    v.strands = [{ type: 'expression', id: st.demoExpr }];
    const q = await timelineQuery(call, v);
    must(q.totals.n > 0, 'the demo query counts nothing');
    st.demoView = v;
    st.demoQuery = q;
    return tiersAndConservation(call, q, 'demo');
  });

  await step('track + timeline tiers L0–L5 + conservation (imported)', ['csv'], async () => {
    const e = await call('POST', '/api/expressions', { body: { surface: files.word, corpus: 'user' } });
    ok200(e, `track '${files.word}'`);
    if (e.json.state?.job) await waitJob(call, e.json.state.job);
    const v = defaultState('user');
    v.strands = [{ type: 'expression', id: e.json.expression.id }];
    const q = await timelineQuery(call, v);
    must(q.totals.n >= 1, `'${files.word}' counts ${q.totals.n} in the imported texts`);
    st.userExpr = e.json.expression.id;
    st.userView = v;
    st.userQuery = q;
    return tiersAndConservation(call, q, `'${files.word}' (user corpus)`);
  });

  await step('passage offsets (marks → passage → document text)', ['demoQuery'], async () => {
    const q = st.demoQuery;
    const mk = await call('GET', `/api/timeline/marks?q=${q.queryKey}&from=1800&to=2030&limit=4000`);
    ok200(mk, 'marks');
    const marks = mk.json.marks.filter((m) => m.occ);
    must(marks.length > 0, 'no marks');
    st.markDocs = [...new Set(marks.map((m) => m.doc))];
    const sample = marks.filter((_, i) => i % Math.max(1, Math.floor(marks.length / 20)) === 0).slice(0, 20);
    const bad = [];
    let byOffsets = 0;
    for (const m of sample) {
      const o = await call('GET', `/api/occurrences/${m.occ}`);
      ok200(o, `occurrence ${m.occ}`);
      const p = await call('GET', `/api/passages/${o.json.passage}`);
      ok200(p, `passage ${o.json.passage}`);
      const d = await call('GET', `/api/documents/${p.json.document.id}/text?from=${o.json.start}&to=${o.json.end}`);
      ok200(d, 'document text');
      // the occurrence's document offsets, relative to its passage (Passage.start is a document offset)
      const rs = o.json.start - p.json.start, re = o.json.end - p.json.start;
      // A re-materialization (a later import bumps the data version) gives the same matches new occurrence ids: a
      // highlight is found by id, else by the same offsets (noted, not failed); the text must agree either way.
      let h = p.json.highlights.find((x) => x.occ === m.occ);
      if (!h) {
        h = p.json.highlights.find((x) => x.start === rs && x.end === re);
        if (h) byOffsets++;
      }
      const text = fold(d.json.text);
      if (rs < 0 || re > p.json.text.length) bad.push(`occ ${m.occ}: ${o.json.start}–${o.json.end} lies outside passage ${p.json.id}`);
      else if (!text || fold(p.json.text.slice(rs, re)) !== text) bad.push(`occ ${m.occ}: passage text ≠ document text`);
      else if (!h) bad.push(`occ ${m.occ}: passage ${p.json.id} does not highlight it`);
      else if (fold(p.json.text.slice(h.start, h.end)) !== text) bad.push(`occ ${m.occ}: its highlight shows other text`);
      if (!st.passage) st.passage = p.json;
    }
    must(!bad.length, `${bad.length} of ${sample.length} occurrences: ${bad.slice(0, 3).join('; ')}`);
    return `${sample.length} of ${mk.json.total} marks opened; passage highlight = passage slice = document-text slice for every one`
      + (byOffsets ? ` (${byOffsets} highlight(s) carry a newer materialization's occurrence ids; matched by offsets)` : '');
  });

  await step('Compare gates (thin slices gated, no numeral)', ['demoView'], async () => {
    const v = structuredClone(st.demoView);
    v.compare = { a: { years: [1906, 1906], f: '' }, b: { years: [2024, 2026], f: '' } };
    const thin = await call('POST', '/api/compare', { body: compareRequest(v).body });
    ok200(thin, 'compare (thin)');
    const gates = [thin.json.freq?.a, thin.json.freq?.b, thin.json.freq?.rate_ratio, thin.json.collocates, ...(thin.json.measures ?? [])]
      .filter((x) => x && typeof x.gate === 'string');
    const gated = gates.filter((x) => x.gate !== 'ok');
    must(gated.length > 0, 'thin slices produced no gate');
    must(gated.every((g) => g.value === null || g.value === undefined), 'a gated measure carries a value');
    v.compare = { a: { years: [1955, 1985], f: '' }, b: { years: [1994, 2026], f: '' } };
    const wide = await call('POST', '/api/compare', { body: compareRequest(v).body });
    ok200(wide, 'compare (adequate)');
    st.demoView.compare = v.compare;
    st.demoCompare = compareCounts(wide.json);
    return `thin: ${gated.length} gated (${[...new Set(gated.map((g) => g.gate))].join(', ')}); adequate: A n=${wide.json.freq?.a?.n ?? '—'}, B n=${wide.json.freq?.b?.n ?? '—'}`;
  });

  // RF-2/RF-3: a view of the imported text, saved with its comparison; opened as saved at once it equals current data
  await step('Compare + save a view of the imported text (as saved = current at the save)', ['userView'], async () => {
    const v = structuredClone(st.userView);
    v.compare = { a: { years: [1700, 1850], f: '' }, b: { years: [1851, 1928], f: '' } };
    const cur = await call('POST', '/api/compare', { body: compareRequest(v).body });
    ok200(cur, 'compare (imported, current data)');
    const r = await call('POST', '/api/views', { body: saveRequest(v, { name: `verify imported ${new Date().toISOString().slice(0, 16)}`, comparisonsTried: 1 }) });
    ok200(r, 'save view (imported)');
    const got = await call('GET', `/api/views/${encodeURIComponent(r.json.slug)}?as=1`);
    ok200(got, 'open the view as saved');
    const { state, savedView } = openedView(got.json, true);
    const q = await timelineQuery(call, state, { cutoffs: savedView.cutoffs });
    must(q.totals.n === st.userQuery.totals.n, `as saved n=${q.totals.n}, current n=${st.userQuery.totals.n} at the save`);
    const saved = await call('POST', '/api/compare', { body: compareRequest(state, { saved: savedView }).body });
    ok200(saved, 'compare (imported, as saved)');
    must(typeof saved.json.as_saved?.note === 'string', 'the as-saved comparison does not say so');
    must(compareCounts(saved.json) === compareCounts(cur.json), `as saved ${compareCounts(saved.json)} ≠ current ${compareCounts(cur.json)} at the save`);
    const kw = await call('GET', `/api/kwic?${new URLSearchParams({ expr: st.userExpr, limit: 1, ...asSavedParams(savedView, 'kwic') })}`);
    ok200(kw, 'the inspector\'s concordance as saved');
    must(kw.json.total === q.totals.n, `concordance ${kw.json.total} ≠ timeline ${q.totals.n} as saved`);
    st.userSaved = { slug: r.json.slug, n: q.totals.n, compare: compareCounts(cur.json) };
    return `${r.json.slug}: n=${q.totals.n}; Compare as saved = current (${compareCounts(cur.json).slice(0, 120)}…)`;
  });

  await step('save view', ['demoView', 'passage'], async () => {
    const v = structuredClone(st.demoView);
    v.selection = { type: 'passage', id: st.passage.id };
    const r = await call('POST', '/api/views', { body: saveRequest(v, { name: `verify ${new Date().toISOString().slice(0, 16)}`, comparisonsTried: 2 }) });
    ok200(r, 'save view');
    st.view = { slug: r.json.slug, hash: r.json.state_hash, state: v };
    const got = await call('GET', `/api/views/${encodeURIComponent(r.json.slug)}`);
    ok200(got, 'open view');
    st.viewBefore = JSON.stringify(got.json.state);
    return `${r.json.slug} (dataVersion ${r.json.dataVersion})`;
  });

  await step('annotation + revision', ['passage'], async () => {
    const p = st.passage;
    const a = await call('POST', '/api/annotations', { body: annotationRequest({ target: `passage:${p.id}`, passage: p, kind: 'interpretation',
      body: 'verify: first reading.', layer: 'Verify', tags: ['verify'] }) });
    ok200(a, 'create annotation');
    await sleep(1100);
    const asOf = new Date().toISOString();
    await sleep(1100);
    const rev = await call('PATCH', `/api/annotations/${a.json.id}`, { body: { body_md: 'verify: revised reading.', reason: 'verify revision' } });
    ok200(rev, 'revise annotation');
    must(rev.json.rev === 2, `revision number ${rev.json.rev}`);
    const revisions = await call('GET', `/api/annotations/${a.json.id}/revisions`);
    ok200(revisions, 'revisions');
    st.annotation = { id: a.json.id, asOf, target: `passage:${p.id}`, revisions: revisions.text };
    return `annotation ${a.json.id}: rev 1 → rev 2`;
  });

  await step('review a link (demo)', ['passage', 'view'], async () => {
    // the first document of the demo marks with a link (its own passage's document first)
    let doc = null, edges = [];
    for (const d of [st.passage.document.id, ...(st.markDocs ?? [])].slice(0, 40)) {
      const lin = await call('GET', `/api/lineage?${new URLSearchParams({ root: `document:${d}`, depth: 1, dir: 'both', max_nodes: 60 })}`);
      ok200(lin, 'lineage');
      if ((lin.json.edges ?? []).length) { doc = d; edges = lin.json.edges; break; }
    }
    // a link whose status a dispute changes, preferably not a documented one
    const edge = edges.find((e) => e.review_status !== 'disputed' && e.evidence_status !== 'documented')
      ?? edges.find((e) => e.review_status !== 'disputed') ?? edges[0];
    must(edge, 'no document of the demo marks has a link to review');
    const r = await call('POST', `/api/relationships/${edge.rel_id}/review`, { body: { action: 'dispute', note: 'verify: reviewed against both passages.' } });
    ok200(r, 'review');
    st.review = { rel: edge.rel_id, root: `document:${doc}`, before: edge.review_status, after: r.json.review_status };
    return `link ${edge.rel_id} (${edge.rel_type}, ${edge.evidence_status}): ${edge.review_status} → ${r.json.review_status}`;
  });

  await step('restart', ['health'], async () => {
    const url = await restart();
    client.event?.('restart', { url });
    client.setBase(url);
    const h = await call('GET', '/api/health');
    ok200(h, 'health after restart');
    st.restarted = true;
    return `listening again at ${url}`;
  });

  await step('reopen saved view', ['view', 'restarted'], async () => {
    const r = await call('GET', `/api/views/${encodeURIComponent(st.view.slug)}`);
    ok200(r, 'reopen view');
    must(JSON.stringify(r.json.state) === st.viewBefore, 'the saved state changed across the restart');
    must(stateHash(canonicalize(r.json.state)) === st.view.hash, 'the state hash differs from the one saved');
    const as = await call('GET', `/api/views/${encodeURIComponent(st.view.slug)}?as=1`);
    ok200(as, 'view as saved');
    return `${st.view.slug}: state byte-identical, hash equal; dataChanged ${r.json.drift?.dataChanged}`;
  });

  await step('revert an import after the save', ['userSaved', 'restarted'], async () => {
    const r = await call('POST', `/api/imports/${st.csv.id}/revert`, { body: {} });
    ok200(r, 'revert');
    const job = await waitJob(call, r.json.job.id);
    must(job.status === 'succeeded', `revert job ${job.id} ${job.status}: ${job.error?.message ?? ''}`);
    st.reverted = true;
    return `import #${st.csv.id} reverted (its documents are soft-deleted)`;
  });

  await step('as-saved reopen after the revert (timeline, tiles L0–L5, concordance, lineage)', ['userSaved', 'reverted'], async () => {
    const got = await call('GET', `/api/views/${encodeURIComponent(st.userSaved.slug)}?as=1`);
    ok200(got, 'view as saved');
    must((got.json.drift?.revertedSince ?? []).some((b) => b.batch === st.csv.id), 'the drift report does not name the revert');
    const { state, savedView } = openedView(got.json, true);
    const q = await timelineQuery(call, state, { cutoffs: savedView.cutoffs });
    must(q.totals.n === st.userSaved.n, `as saved n=${q.totals.n}, at the save n=${st.userSaved.n}`);
    const cons = await tiersAndConservation(call, q, 'as saved');
    const kw = await call('GET', `/api/kwic?${new URLSearchParams({ expr: st.userExpr, limit: 1, ...asSavedParams(savedView, 'kwic') })}`);
    ok200(kw, 'the inspector\'s concordance as saved');
    must(kw.json.total === st.userSaved.n, `concordance as saved ${kw.json.total} ≠ ${st.userSaved.n}`);
    const now = await timelineQuery(call, openedView(got.json, false).state);
    must(now.totals.n < st.userSaved.n, `current data still counts ${now.totals.n} (at the save ${st.userSaved.n})`);
    let lineage = 'no link reviewed';
    if (st.review) {
      const dv = await call('GET', `/api/views/${encodeURIComponent(st.view.slug)}?as=1`);
      ok200(dv, 'demo view as saved');
      const demoSaved = openedView(dv.json, true).savedView;
      const edgeOf = async (params) => {
        const l = await call('GET', `/api/lineage?${new URLSearchParams({ root: st.review.root, depth: 1, dir: 'both', max_nodes: 60, ...params })}`);
        ok200(l, 'lineage');
        return (l.json.edges ?? []).find((e) => e.rel_id === st.review.rel);
      };
      const then = await edgeOf(asSavedParams(demoSaved, 'lineage'));
      const cur = await edgeOf({});
      must(then?.review_status === st.review.before, `as saved the link reads ${then?.review_status}, before the review ${st.review.before}`);
      must(cur?.review_status === st.review.after, `current data reads ${cur?.review_status}, after the review ${st.review.after}`);
      lineage = `link ${st.review.rel}: ${then.review_status} as saved, ${cur.review_status} now`;
    }
    return `n=${q.totals.n} as saved (now ${now.totals.n}); ${cons.replace(/^as saved: /, '')}; concordance ${kw.json.total}; ${lineage}`;
  });

  await step('as-saved Compare (RF-2)', ['userSaved', 'reverted', 'view'], async () => {
    const got = await call('GET', `/api/views/${encodeURIComponent(st.userSaved.slug)}?as=1`);
    ok200(got, 'view as saved');
    const { state, savedView } = openedView(got.json, true);
    const saved = await call('POST', '/api/compare', { body: compareRequest(state, { saved: savedView }).body });
    ok200(saved, 'compare as saved');
    must(compareCounts(saved.json) === st.userSaved.compare, `as saved ${compareCounts(saved.json)} ≠ at the save ${st.userSaved.compare}`);
    const now = await call('POST', '/api/compare', { body: compareRequest(openedView(got.json, false).state).body });
    ok200(now, 'compare with current data');
    must(compareCounts(now.json) !== st.userSaved.compare, 'current data compares the same documents after the revert');
    const dv = await call('GET', `/api/views/${encodeURIComponent(st.view.slug)}?as=1`);
    ok200(dv, 'demo view as saved');
    const demo = openedView(dv.json, true);
    const dc = await call('POST', '/api/compare', { body: compareRequest(demo.state, { saved: demo.savedView }).body });
    ok200(dc, 'demo compare as saved');
    must(compareCounts(dc.json) === st.demoCompare, `demo as saved ${compareCounts(dc.json)} ≠ before the save ${st.demoCompare}`);
    return `imported: as saved = at the save, current differs (A docs ${saved.json.coverage.a.docs} → ${now.json.coverage.a.docs}); demo: as saved = before the save`;
  });

  await step('annotation as of a past time', ['annotation', 'restarted'], async () => {
    const a = st.annotation;
    const rev = await call('GET', `/api/annotations/${a.id}/revisions`);
    ok200(rev, 'revisions');
    must(rev.text === a.revisions, 'the revisions changed across the restart');
    const past = await call('GET', `/api/annotations?target=${encodeURIComponent(a.target)}&as_of=${encodeURIComponent(a.asOf)}`);
    ok200(past, 'annotations as of');
    const then = past.json.items.find((x) => x.id === a.id);
    must(then && then.rev === 1 && then.body_md === 'verify: first reading.', `as of ${a.asOf}: ${JSON.stringify(then ?? null).slice(0, 160)}`);
    const now = await call('GET', `/api/annotations?target=${encodeURIComponent(a.target)}`);
    ok200(now, 'annotations');
    const cur = now.json.items.find((x) => x.id === a.id);
    must(cur && cur.rev === 2, 'the current revision is not rev 2');
    return `as of ${a.asOf}: rev 1 "${then.body_md}"; now rev 2`;
  });

  await step('integrity (boot check of originals/)', ['restarted'], async () => {
    let integ = null;
    for (let i = 0; i < 120; i++) {
      const h = await call('GET', '/api/health', { poll: true });
      integ = h.json?.integrity ?? null;
      if (integ && integ.status !== 'checking') break;
      await sleep(500);
    }
    must(integ, '/api/health carries no integrity field');
    must(integ.status === 'ok', `${integ.status}: ${integ.referenced_missing ?? '?'} original(s) of ${integ.documents_affected ?? '?'} document(s) missing (${integ.reason ?? integ.sample?.[0]?.rel_path ?? ''})`);
    return `${integ.files} originals on disk, none missing`;
  });

  steps.push({ name: 'response shapes (tests/helpers/shape.mjs)', ok: client.stats.errors.length === 0, ms: 0,
    detail: `${client.stats.checked} JSON responses checked of ${client.stats.calls} calls; ${client.stats.errors.length} shape error(s)` });
  return steps;
}
