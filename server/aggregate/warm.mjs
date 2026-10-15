// OWNER: WP3
// warm.mjs — keep the shared artifacts of the corpora in use ready (M1 gate performance fix): after a data change
// that settles (no job running), one read worker rebuilds the slice cube, the theme and maker label indexes and the
// maker-name index of every corpus queried since boot, so the next query of every worker reads them from $SCROLLS_DATA/cache/ instead of
// paying the scan on the request path ("precompute at the end of an import or the bootstrap").
//
// Main thread: routes call noteCorpusUse(ctx, corpusId); the read-pool entry point is warmQuery (read-query
// convention §12.2), with a long timeout: it is the one place where a slow build (a loaded machine) may take its time,
// while request paths wait at most a few seconds or use their SQL fallbacks. An artifact whose inputs did not change (a
// materialization only bumps the data version) is found in memory or on disk at once, so warming after such a change
// costs milliseconds.

import { bus } from '../http/sse.mjs';
import { ensureArtifact } from './cache.mjs';
import { statsSpec } from './collstats.mjs';
import { cellsSpec, cubeSpec, readyCube, sliceCube } from './cube.mjs';
import { namesSpec, peekCorpusNames } from './materialize.mjs';
import { labelIndexSpec, peekLabelIndex } from './tagindex.mjs';

const SELF_URL = import.meta.url;
/** Quiet period after the last data change before warming. */
export const SETTLE_MS = 1500;

// corpora: whose artifacts are built (every corpus with collections, once the UI asked for the corpus list);
// used: the ones queried since boot, whose artifacts every read worker also loads into memory
const state = { pool: null, jobs: null, corpora: new Set(), used: new Set(), timer: null, running: false, loaded: new Set() };

function schedule(delay = SETTLE_MS) {
  if (!state.pool || !state.corpora.size) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(run, delay);
  state.timer.unref?.();
}

async function run() {
  state.timer = null;
  if (state.running) { schedule(); return; }
  let busy;
  try {
    // an import or the bootstrap still writing: its next commit would make the work moot
    busy = (state.jobs?.counts?.().running ?? 0) > 0;
  } catch {
    return;   // that server has closed: the next request names the live one
  }
  if (busy) { schedule(); return; }
  state.running = true;
  try {
    const corpusIds = [...state.corpora];
    const r = await state.pool.run(SELF_URL, 'warmQuery', { corpusIds }, { timeoutMs: 300000 });
    // every read worker decodes the files of the corpora in use into its own memory (contract 1.3.0 performance round:
    // the first search in each worker used to pay the decoding of the name and label indexes); idle workers take one
    // call each
    const used = [...state.used];
    // only when an artifact the workers hold was (re)built for a corpus in use, or a corpus is newly in use: a rebuilt
    // collection statistic (a Wiktionary entry written when a word is tracked) or Term-trail artifact is read where needed
    const fresh = used.some((id) => !state.loaded.has(id));
    const rebuilt = r.warmed.some((w) => state.used.has(w.corpus) && w.preload > 0);
    const n = used.length && (rebuilt || fresh) ? Math.max(0, (state.pool.stats?.().size ?? 1) - 1) : 0;
    for (const id of used) state.loaded.add(id);
    await Promise.allSettled(Array.from({ length: n }, () => state.pool.run(SELF_URL, 'loadQuery', { corpusIds: used }, { timeoutMs: 60000 })));
  } catch {
    // shutting down, or a timeout under load: the next request builds what it needs itself
  } finally {
    state.running = false;
  }
}

bus.on('data', () => schedule());

/**
 * Record that a corpus is in use (main thread, from a route handler). The first use also warms it.
 * @param {{pool: object, jobs: object}} ctx RouteCtx
 * @param {number|null|undefined} corpusId
 */
export function noteCorpusUse(ctx, corpusId) {
  if (!Number.isInteger(corpusId) || !ctx?.pool) return;
  state.pool = ctx.pool;
  state.jobs = ctx.jobs;
  if (state.corpora.has(corpusId) && state.used.has(corpusId)) return;
  state.corpora.add(corpusId);
  state.used.add(corpusId);
  schedule(0);
}

/**
 * Warm every corpus that has collections (main thread, from the first GET /api/corpora or search): the UI asks for the
 * corpus list first, so its first search and timeline query find the cube, the label indexes and the maker-name index
 * built instead of paying their scans (performance round of contract 1.3.0). Later calls only add new corpora.
 * @param {{pool: object, jobs: object, db: import('node:sqlite').DatabaseSync}} ctx RouteCtx
 */
export function warmAll(ctx) {
  if (!ctx?.pool || !ctx.db) return;
  state.pool = ctx.pool;
  state.jobs = ctx.jobs;
  let added = false;
  for (const r of ctx.db.prepare('SELECT k.id FROM corpus k WHERE EXISTS (SELECT 1 FROM collection c WHERE c.corpus_id = k.id) ORDER BY k.id').all()) {
    if (!state.corpora.has(r.id)) { state.corpora.add(r.id); added = true; }
  }
  if (added) schedule(0);
}

/**
 * Build the shared artifacts of corpora whose inputs changed (a file per artifact in $SCROLLS_DATA/cache/); an
 * artifact whose file already exists is not decoded here (ensureArtifact), so warming after a materialization — which
 * changes no input — costs the keys only. Read-query convention (§12.2): runs in the read pool via
 * ctx.pool.run(moduleUrl, 'warmQuery', args).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{corpusIds: number[]}} args
 * @returns {{warmed: object[], built: number}}
 */
export function warmQuery(db, { corpusIds = [] }) {
  const warmed = [];
  let built = 0;
  // the corpus list's per-collection statistics first: GET /api/corpora is the UI's first request
  const t1 = performance.now();
  const colls = db.prepare('SELECT * FROM collection ORDER BY id').all();
  for (const c of colls) if (ensureArtifact(db, statsSpec({ ...c }))) built++;
  warmed.push({ collections: colls.length, ms: Math.round(performance.now() - t1) });
  for (const id of corpusIds) {
    const t0 = performance.now();
    // what request paths need most first: tiles (cube), theme typeahead, the title rule, then the larger maker index;
    // then what only the Term trail reads (contract 1.3.0): relation endpoints and OpenAlex cells
    const cubeBuilt = ensureArtifact(db, cubeSpec(id));
    // what loadQuery puts into every worker (preload), then what only the Term trail reads
    const preload = [labelIndexSpec(id, 'theme'), namesSpec(id), labelIndexSpec(id, 'maker')]
      .reduce((acc, sp) => acc + (ensureArtifact(db, sp) ? 1 : 0), cubeBuilt ? 1 : 0);
    const n = [cubeSpec(id, true), cellsSpec(id)].reduce((acc, sp) => acc + (ensureArtifact(db, sp) ? 1 : 0), preload);
    built += n;
    warmed.push({ corpus: id, built: n, preload, rows: cubeBuilt ? sliceCube(db, id).n : null, ms: Math.round(performance.now() - t0) });
  }
  return { warmed, built };
}

/**
 * Load the shared artifacts of corpora into this worker's memory when their files exist (never builds). Read-query
 * convention (§12.2).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {{corpusIds: number[]}} args
 * @returns {{loaded: number}}
 */
export function loadQuery(db, { corpusIds = [] }) {
  let loaded = 0;
  for (const id of corpusIds) {
    if (readyCube(db, id)) loaded++;
    if (peekLabelIndex(db, id, 'theme')) loaded++;
    if (peekLabelIndex(db, id, 'maker')) loaded++;
    if (peekCorpusNames(db, id)) loaded++;
  }
  return { loaded };
}
