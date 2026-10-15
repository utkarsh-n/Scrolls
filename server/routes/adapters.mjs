// OWNER: WP2
// routes/adapters.mjs — the source adapters (SPEC §7.1, §10.1):
//   GET  /api/adapters[?refresh=1]  every adapter: probe of its staged files (FORMAT.md + MANIFEST.json first), licence,
//                                   enabled, loaded, last load, and the state of a chained load (`load`, `job`); an
//                                   unavailable one says why and which fetcher to run
//   POST /api/adapters/:id/load     load a staged source as a job (adapter-load). STEMM document sources load as a chain
//                                   of ≈ 20 s jobs; a live chain answers with its current job (progress: GET /api/jobs/:id/
//                                   events; cancel: POST /api/jobs/:id/cancel, which stops the chain and keeps committed
//                                   chunks). A Cipher adapter resumes the bootstrap instead (it loads Cipher as one set).
//   POST /api/adapters/:id/enable   {enabled?: boolean, approve?: boolean}; network adapters need approve: true
//   GET  /api/adapters/:id/claims   ?word=&lang= | ?expr=<expression id> — the adapter's external claims (Wiktionary
//                                   attestation statements), never occurrences; additive, not yet in the contract fixtures
// The app never fetches: the page shows the command to re-run a fetcher; nothing here runs it.

import { homedir } from 'node:os';
import { CIPHER, cipherStatus, paths } from '../config.mjs';
import { ADAPTER_MODULES, loadAdapter } from '../adapters/registry.mjs';
import { makeAdapterCtx } from '../adapters/api.mjs';
import { badRequest, HttpError, notFound } from '../http/errors.mjs';
import { nowIso, stmt } from '../db/open.mjs';
import { CHAINED, loadStateKey } from '../jobs/tasks/adapter-load.mjs';

const MODULE_URL = import.meta.url;
const FETCHERS = Object.freeze({
  'stemm.gutenberg-stemm': 'node tools/fetch/gutenberg-stemm.mjs',
  'stemm.openalex': 'node tools/fetch/openalex.mjs',
  'stemm.wiktionary': 'node tools/fetch/wiktionary-coinage.mjs',
  'stemm.ngram': 'node tools/fetch/ngram-baseline.mjs',
});
const LIVE = "('queued', 'running', 'cancelling')";
const PROBE_TTL_MS = 60000;
const probes = new Map();

const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

async function probeOf(adapter) {
  const hit = probes.get(adapter.id);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;
  let value;
  if (adapter.id.startsWith('cipher.') || adapter.id === 'demo') {
    // Cipher and the demo are read in place; their full probes parse whole files, so the list only checks presence
    const st = cipherStatus();
    value = adapter.id === 'demo' ? { available: true, manifest_ok: true, format_ok: true, counts: {}, caveats: [] }
      : st.ok ? { available: true, manifest_ok: true, format_ok: true, counts: {}, caveats: [] }
        : { available: false, reason: `Cipher files not found under ${tilde(CIPHER.root)}: ${st.missing.join(', ')}`, manifest_ok: false, format_ok: false, counts: {}, caveats: [] };
  } else {
    try {
      value = await adapter.probe(makeAdapterCtx({ dataDir: paths().data, stagedDir: adapter.stagedDir }));
    } catch (err) {
      value = { available: false, reason: `probe failed: ${err.message}`, manifest_ok: false, format_ok: false, counts: {}, caveats: [] };
    }
  }
  probes.set(adapter.id, { at: Date.now(), value });
  return value;
}

const readState = (db, id) => {
  try { return JSON.parse(stmt(db, 'SELECT value FROM meta WHERE key = ?').get(loadStateKey(id))?.value ?? 'null'); } catch { return null; }
};

/** The live job of an adapter's load (queued, running or cancelling), or null. */
function liveJob(db, adapterId) {
  for (const j of stmt(db, `SELECT id, status, params_json FROM job WHERE type = 'adapter-load' AND status IN ${LIVE} ORDER BY id DESC`).all()) {
    try { if (JSON.parse(j.params_json).adapter === adapterId) return { id: j.id, status: j.status }; } catch { /* malformed params */ }
  }
  return null;
}

/** Collections an adapter created, with their committed batches; the state of a chained load. */
function loadState(db, adapter) {
  const last = stmt(db, `SELECT b.id, b.committed_at, b.job_id FROM import_batch b WHERE b.adapter_id = ? AND b.status = 'committed'
    ORDER BY b.id DESC LIMIT 1`).get(adapter.id);
  // an index-only count (adapter collections are never reverted; only user imports are soft-deleted)
  const total = stmt(db, 'SELECT count(*) AS n FROM document WHERE collection_id IN (SELECT id FROM collection WHERE adapter_id = ?)').get(adapter.id).n;
  let loaded = total > 0;
  if (adapter.id === 'cipher.roots') loaded = Boolean(stmt(db, 'SELECT 1 FROM etymon LIMIT 1').get());
  if (adapter.id === 'cipher.themes') loaded = Boolean(stmt(db, 'SELECT 1 FROM theme_assoc LIMIT 1').get());
  if (adapter.id === 'stemm.wiktionary') {
    loaded = Boolean(stmt(db, "SELECT 1 FROM date_assertion WHERE subject_type = 'expression' AND asserted_by = 'wiktionary' LIMIT 1").get()) || total > 0;
  }
  const out = { loaded, last_load: last ? { at: last.committed_at, documents: total, job: last.job_id ?? null, batch: last.id } : null };
  const state = readState(db, adapter.id);
  const job = liveJob(db, adapter.id);
  if (state) {
    out.load = { status: job ? 'running' : state.status === 'running' ? 'interrupted' : state.status, phase: state.phase, part: state.part,
      progress: state.progress ?? null, message: state.message ?? null, started_at: state.started_at, updated_at: state.updated_at,
      finished_at: state.finished_at ?? null, counts: state.counts ?? {}, coverage: state.coverage ?? null, params: state.params ?? {},
      error: state.error ?? null };
    if (out.load.status === 'interrupted' || out.load.status === 'cancelled' || out.load.status === 'failed') {
      out.load.resume = 'Load again: committed chunks are kept and the load continues from them.';
    }
    if (state.status === 'done' || (loaded && state.status !== 'running')) out.complete = state.status === 'done';
  }
  out.job = job;
  return out;
}

/**
 * Every adapter with its probe and load state (the Adapters shape of §7.2, plus additive `load`, `job`, `complete`).
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Promise<object[]>}
 */
export async function adaptersQuery(db, { refresh = false } = {}) {
  if (refresh) probes.clear();
  const rows = new Map(db.prepare('SELECT * FROM source_adapter').all().map((r) => [r.id, r]));
  const out = [];
  for (const adapterId of Object.keys(ADAPTER_MODULES)) {
    let adapter;
    try { adapter = await loadAdapter(adapterId); } catch (err) {
      out.push({ id: adapterId, version: '0.0.0', access: 'local-dataset', label: adapterId, staged: null, available: false,
        reason: err.message, license: '', loaded: false, last_load: null, enabled: false });
      continue;
    }
    const probe = await probeOf(adapter);
    const row = rows.get(adapterId);
    const state = loadState(db, adapter);
    out.push({
      id: adapter.id,
      version: adapter.version,
      access: adapter.access,
      label: adapter.label,
      staged: adapter.stagedDir
        ? (probe.manifest_ok || probe.available ? { path: tilde(`${paths().sources}/${adapter.stagedDir}`), manifest_ok: probe.manifest_ok,
          format_ok: probe.format_ok, counts: probe.counts ?? {} } : null)
        : null,
      available: probe.available,
      ...(probe.available ? {} : { reason: probe.reason ?? 'unavailable' }),
      ...(FETCHERS[adapterId] ? { command: FETCHERS[adapterId] } : {}),
      caveats: probe.caveats ?? [],
      license: adapter.license,
      attribution: adapter.attribution,
      enabled: row ? row.enabled === 1 : false,
      loadable: probe.available && adapterId !== 'stemm.ngram',
      ...(adapterId === 'stemm.ngram' ? { note: 'Read in place: GET /api/baseline?word=… (no documents, nothing to load).' } : {}),
      ...state,
    });
  }
  return out;
}

/**
 * Claims of the claims-capable adapter (Wiktionary): for a tracked expression, the claims written on it (with the
 * entry document and passage to highlight); for a word, a lookup in the word index (not yet tied to documents).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{adapter: string, word?: string|null, lang?: string|null, expr?: number|null}} args
 * @returns {Promise<object>}
 */
export async function claimsQuery(db, { adapter: adapterId, word = null, lang = null, expr = null }) {
  const adapter = await loadAdapter(adapterId);
  const base = { adapter: adapter.id, license: adapter.license, attribution: adapter.attribution,
    note: 'External claims quoted from Wiktionary: never occurrences, never a date for the word in this corpus.' };
  let surface = word, wlang = lang ?? 'en', expression = null, written = [];
  if (expr !== null) {
    expression = stmt(db, 'SELECT id, surface, lang, is_synthetic FROM expression WHERE id = ?').get(expr);
    if (!expression) throw notFound(`Expression ${expr}`);
    surface = expression.surface;
    wlang = lang ?? (expression.lang && /^(en|fr|es|hi|gu)\b/.test(expression.lang) ? expression.lang.slice(0, 2) : 'en');
    written = stmt(db, `SELECT * FROM date_assertion WHERE subject_type = 'expression' AND subject_id = ? AND role = 'first_attestation_claim'
      AND asserted_by = 'wiktionary' ORDER BY lo_year, id`).all(expr).map((r) => adapter.claimFromAssertion(r));
    if (written.length) {
      return { available: true, ...base, word: surface, lang: wlang, expression: expr, loaded: true,
        claims: written.sort((a, b) => (a.display === 'default' ? 0 : 1) - (b.display === 'default' ? 0 : 1) || (a.year_lo ?? 0) - (b.year_lo ?? 0)) };
    }
  }
  const probe = await adapter.probe({});
  if (!probe.available) return { available: false, ...base, reason: probe.reason, command: FETCHERS[adapter.id] ?? null };
  if (!adapter.indexReady()) {
    return { available: false, ...base, reason: 'The Wiktionary word index is not built yet: load the adapter on the Adapters page first.' };
  }
  const claims = await adapter.claims().lookup(surface, { lang: wlang, surface });
  return { available: true, ...base, word: surface, lang: wlang, expression: expression ? expression.id : null, loaded: false,
    claims: claims.map((c) => ({ ...c, written: false, ...(Number.isInteger(c.year_lo ?? c.year) && Number.isInteger(c.year_hi ?? c.year) ? {} : { open_ended: true }) })) };
}

function adapterId(params) {
  const id = String(params.id ?? '');
  if (!Object.hasOwn(ADAPTER_MODULES, id)) throw notFound(`Adapter '${id}'`);
  return id;
}

const isStrList = (v) => Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string' && x.length <= 200);

/** Load params a user may send, checked per adapter (the job's internal keys are never accepted from outside). */
function loadParams(id, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const out = {};
  const bad = (field, hint) => badRequest('E_VALIDATION', `${field} is not valid for ${id}.`, hint, { field });
  if (b.collections !== undefined) { if (!isStrList(b.collections)) throw bad('collections', 'A list of collection slugs.'); out.collections = b.collections; }
  if (id === 'stemm.openalex') {
    if (b.fields !== undefined) { if (!isStrList(b.fields)) throw bad('fields', 'A list of OpenAlex field names, e.g. ["Medicine"].'); out.fields = b.fields; }
    if (b.years !== undefined) {
      if (!Array.isArray(b.years) || b.years.length !== 2 || !b.years.every(Number.isInteger) || b.years[0] > b.years[1]) throw bad('years', 'Two years, e.g. [1900, 1950].');
      out.years = b.years;
    }
    if (b.abstracts !== undefined) { if (typeof b.abstracts !== 'boolean') throw bad('abstracts', 'true or false.'); out.abstracts = b.abstracts; }
  }
  if (id === 'stemm.gutenberg-stemm' && b.ids !== undefined) {
    if (!Array.isArray(b.ids) || b.ids.length > 5000 || !b.ids.every(Number.isInteger)) throw bad('ids', 'A list of Gutenberg ebook numbers.');
    out.ids = b.ids;
  }
  if (id === 'stemm.wiktionary') {
    if (b.expressionId !== undefined) { if (!Number.isInteger(b.expressionId)) throw bad('expressionId', 'An expression id.'); out.expressionId = b.expressionId; }
    if (b.words !== undefined) { if (!isStrList(b.words)) throw bad('words', 'A list of words.'); out.words = b.words; }
    if (b.lang !== undefined) { if (typeof b.lang !== 'string' || !/^(en|fr|es|hi|gu)$/.test(b.lang)) throw bad('lang', 'One of en, fr, es, hi, gu.'); out.lang = b.lang; }
  }
  return out;
}

export const routes = [
  {
    method: 'GET',
    path: '/api/adapters',
    async handler(req, ctx) {
      // ?refresh=1 probes the staged files again (after the user re-ran a fetcher)
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
      return { json: await ctx.pool.run(MODULE_URL, 'adaptersQuery', { refresh }, { timeoutMs: 20000 }), etag: false };
    },
  },
  {
    method: 'POST',
    path: '/api/adapters/:id/load',
    async handler(req, ctx) {
      const id = adapterId(req.params);
      const adapter = await loadAdapter(id);
      const row = stmt(ctx.db, 'SELECT * FROM source_adapter WHERE id = ?').get(id);
      if (adapter.access === 'network' && !(row?.approved_at || req.body?.approve === true)) {
        throw badRequest('E_APPROVAL_REQUIRED', 'This adapter uses the network and is off until you approve it.', 'Send {"approve": true} to enable it.');
      }
      if (row && row.enabled === 0) throw new HttpError(409, 'E_ADAPTER_DISABLED', `${id} is disabled.`, `POST /api/adapters/${id}/enable first.`, { adapter: id });
      if (id === 'stemm.ngram') {
        throw new HttpError(409, 'E_NOTHING_TO_LOAD', 'The Ngram baseline is read in place; there is nothing to load.', 'Use /api/baseline?word=… directly.', { adapter: id });
      }
      const params = loadParams(id, req.body);
      probes.delete(id);
      const probe = await probeOf(adapter);
      if (!probe.available) {
        throw new HttpError(409, 'E_ADAPTER_UNAVAILABLE', `${id} is unavailable: ${probe.reason}`,
          FETCHERS[id] ? `Run ${FETCHERS[id]} yourself, then retry.` : 'Check the source files, then retry.', { adapter: id });
      }
      if (id.startsWith('cipher.')) {
        // one bootstrap chain at a time: a queued or running one is the answer
        const live = stmt(ctx.db, `SELECT id FROM job WHERE type = 'bootstrap-cipher' AND status IN ${LIVE} ORDER BY id DESC LIMIT 1`).get();
        return { json: { job: { id: live?.id ?? ctx.jobs.enqueue('bootstrap-cipher', { mode: 'chain' }) } } };
      }
      // a chained load already under way is the answer (one chain per adapter)
      const live = CHAINED.includes(id) ? liveJob(ctx.db, id) : null;
      if (live) return { json: { job: { id: live.id }, already_running: true } };
      return { json: { job: { id: ctx.jobs.enqueue('adapter-load', { ...params, adapter: id }) } } };
    },
  },
  {
    method: 'POST',
    path: '/api/adapters/:id/enable',
    async handler(req, ctx) {
      const id = adapterId(req.params);
      const adapter = await loadAdapter(id);
      const enabled = req.body?.enabled !== false;
      if (enabled && adapter.access === 'network' && req.body?.approve !== true) {
        throw badRequest('E_APPROVAL_REQUIRED', 'This adapter uses the network and is off until you approve it.', 'Send {"approve": true} to enable it.');
      }
      ctx.withWrite((db) => {
        stmt(db, 'UPDATE source_adapter SET enabled = ?, approved_at = CASE WHEN ? THEN ? ELSE approved_at END WHERE id = ?')
          .run(enabled ? 1 : 0, adapter.access === 'network' && enabled ? 1 : 0, nowIso(), id);
      });
      return { json: await ctx.pool.run(MODULE_URL, 'adaptersQuery', {}, { timeoutMs: 20000 }), etag: false };
    },
  },
  {
    method: 'GET',
    path: '/api/adapters/:id/claims',
    heavy: true,
    async handler(req, ctx) {
      const id = adapterId(req.params);
      const adapter = await loadAdapter(id);
      if (typeof adapter.claims !== 'function') {
        throw new HttpError(404, 'E_NO_CLAIMS', `${id} states no claims.`, 'Claims come from stemm.wiktionary.', { adapter: id });
      }
      const word = req.query.word ? String(req.query.word).trim() : null;
      const exprRaw = req.query.expr ?? req.query.expression;
      const expr = exprRaw === undefined || exprRaw === '' ? null : Number(String(exprRaw).replace(/^expression:/, ''));
      if (expr !== null && !Number.isInteger(expr)) throw badRequest('E_VALIDATION', 'expr must be an expression id.', 'Use ?expr=12.');
      if (!word && expr === null) throw badRequest('E_VALIDATION', 'word or expr is required.', 'Use ?word=laser or ?expr=12.');
      if (word && word.length > 120) throw badRequest('E_VALIDATION', 'word is too long.', 'Claims are looked up per word or phrase.');
      const lang = req.query.lang ? String(req.query.lang) : null;
      if (lang && !/^(en|fr|es|hi|gu)$/.test(lang)) throw badRequest('E_VALIDATION', 'lang must be one of en, fr, es, hi, gu.', 'Wiktionary claims exist for these languages.');
      return { json: await ctx.pool.run(MODULE_URL, 'claimsQuery', { adapter: id, word, lang, expr }, { timeoutMs: 15000 }) };
    },
  },
];
