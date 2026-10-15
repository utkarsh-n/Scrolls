// OWNER: WP2
// tasks/bootstrap-cipher.mjs — job 'bootstrap-cipher': the metadata-first Cipher bootstrap (SPEC §6.8, D10).
//
//   Phase A · metadata   works (+ siblings → relationships, meanings → glosses) → themes → roots   (one job)
//   Phase A2 · genealogy  cipher.relations: relation endpoints in ≈ 20 s chunks, then aliases + relationships
//   Phase B · full text  Gutenberg books → Wikisource hi → gu, in chunks of ≈ 20 s → boilerplate pass → fts optimize
//
// In a server job (mode 'chain', the default) each run does ONE step and enqueues the next bootstrap-cipher
// job, so the single writer lock is never held for minutes and interactive writes (materialize, imports)
// slip in between chunks. The script (scripts/bootstrap-cipher.mjs) runs every step in one call (mode 'all').
// Every step is resumable: what is loaded is read back from the database (committed batches only — the
// queue rolls back unfinished batches after a restart), so an interrupted bootstrap continues where it was.
// Reconciliation counts (§6.8) go into the metrics_json of a 'bootstrap-cipher' analysis_run.

import { JOB_TYPES } from '../../../src/shared/vocab.mjs';
import { cipherStatus } from '../../config.mjs';
import { loadAdapter } from '../../adapters/registry.mjs';
import { clearSourceCache } from '../../adapters/cipher/source.mjs';
import { bumpDataVersion, checkpointWal, getMeta, nowIso, setMeta, stmt, tx } from '../../db/open.mjs';
import { setFtsBulkLoad } from '../../store/document-writer.mjs';
import { HttpError } from '../../http/errors.mjs';
import { ensureAdapterCollections, loadCollection, originalsKeeper, writeEtymons, writeThemeAssocs, adapterCtx } from './adapter-load.mjs';

export const type = 'bootstrap-cipher';
export const { writes, priority } = JOB_TYPES[type];

export const STATE_KEY = 'cipher_bootstrap';
/** meta key holding a collection's load status: 'pending' | 'indexing' | 'ready' (read by /api/corpora; tiles' pending state). */
export const collectionStatusKey = (slug) => `collection_status:${slug}`;
export const PHASE_A = 'A · metadata';
export const PHASE_A2 = 'A2 · genealogy';
const RELATIONS = 'cipher-music-relations';
export const PHASE_B = 'B · full text';
export const TEXT_COLLECTIONS = Object.freeze(['cipher-gutenberg', 'cipher-wikisource-hi', 'cipher-wikisource-gu']);
const CHUNK_MS = 20000;
const CANARY = 'computer virus or computer codes that damage';
const READY_MESSAGE = 'Cipher titles, relations and etymology are ready';

// ── state ───────────────────────────────────────────────────────────────────────────────────────────

/** @returns {object} the bootstrap state stored in meta */
export function readState(db) {
  try { return JSON.parse(getMeta(db, STATE_KEY) ?? '{}'); } catch { return {}; }
}

function writeState(db, patch) {
  const next = { ...readState(db), ...patch, updated_at: nowIso() };
  setMeta(db, STATE_KEY, JSON.stringify(next));
  return next;
}

function setCollectionStatus(db, slug, status) {
  setMeta(db, collectionStatusKey(slug), status);
}

const collectionId = (db, slug) => stmt(db, 'SELECT id FROM collection WHERE slug = ?').get(slug)?.id ?? null;

/** ext_ids already loaded (committed) in a collection. */
function loadedExtIds(db, slug) {
  const id = collectionId(db, slug);
  if (!id) return new Set();
  return new Set(stmt(db, `SELECT d.ext_id FROM document d JOIN import_batch b ON b.id = d.import_batch_id
    WHERE d.collection_id = ? AND b.status = 'committed' AND d.deleted_at IS NULL`).all(id).map((r) => r.ext_id));
}

// ── progress ────────────────────────────────────────────────────────────────────────────────────────

const A_SHARE = 0.08;
const A2_SHARE = 0.03;
const TEXT_SHARE = 0.82;
const B0 = A_SHARE + A2_SHARE;

const EMIT_INTERVAL_MS = 1000;
let lastEmit = { at: 0, phase: null };

/** Progress to the job (throttled by TaskCtx) and a `bootstrap` SSE event at most once a second per phase. */
function report(ctx, fraction, phase, message, counts = null) {
  ctx.progress(fraction, phase, message, counts);
  const now = Date.now();
  if (phase === lastEmit.phase && now - lastEmit.at < EMIT_INTERVAL_MS && fraction < 1) return;
  lastEmit = { at: now, phase };
  try {
    ctx.emit?.('bootstrap', { status: /^B\b/.test(phase) ? 'fulltext' : 'metadata', phase, progress: fraction, message });
  } catch { /* outside a job (script): no bus */ }
}

// ── phase A ─────────────────────────────────────────────────────────────────────────────────────────

async function phaseA(ctx, params) {
  const db = ctx.db;
  const t0 = Date.now();
  // no automatic checkpoints while phase A bulk-loads (≈ 400 MB of WAL, measured −4 s); the WAL is truncated at
  // the end of the phase. Phase B keeps the default: its WAL would pass 1 GB, where pauseForWal takes over.
  db.exec('PRAGMA wal_autocheckpoint = 0');
  try {
    return await phaseAInner(ctx, params, t0);
  } finally {
    db.exec('PRAGMA wal_autocheckpoint = 1000');
    checkpointWal(db, 'TRUNCATE');
  }
}

async function phaseAInner(ctx, params, t0) {
  const db = ctx.db;
  const keepOriginal = originalsKeeper(db);
  const writerOptions = params.now ? { now: new Date(params.now) } : {};
  const [works, themes, roots, books, wikisource] = await Promise.all(
    ['cipher.works', 'cipher.themes', 'cipher.roots', 'cipher.books', 'cipher.wikisource'].map((a) => loadAdapter(a)));
  const result = { started_at: nowIso() };

  // text collections exist from the start, so their lanes say "indexing — not yet looked" until phase B ends
  tx(db, () => {
    ensureAdapterCollections(db, books);
    ensureAdapterCollections(db, wikisource);
    for (const slug of TEXT_COLLECTIONS) if (getMeta(db, collectionStatusKey(slug)) !== 'ready') setCollectionStatus(db, slug, 'pending');
  });

  // 1. works + siblings + glosses (one batch: relationships resolve at finish)
  if (loadedExtIds(db, 'cipher-culture-works').size === 0) {
    const probe = await works.probe(adapterCtx(ctx, { keepOriginal }));
    if (!probe.available) throw new HttpError(409, 'E_CIPHER_UNAVAILABLE', `cipher.works: ${probe.reason}`, 'Check the Cipher files.');
    tx(db, () => ensureAdapterCollections(db, works, { caveats: probe.caveats }));
    setCollectionStatus(db, 'cipher-culture-works', 'indexing');
    const runId = ctx.startRun('cipher_load', { pipelineVersion: 'cipher-theme-cosine@build_culture.py',
      params: { threshold: 0.42, cap: 0.7, cross_culture: true, source: 'culture-works.tsv siblings' },
      scope: { collections: ['cipher-culture-works'] } });
    const total = probe.counts.works;
    const counts = await loadCollection(ctx, works, 'cipher-culture-works', { runIds: { cipher_load: runId }, writerOptions }, {
      keepOriginal,
      onDocument: (n) => { if (n % 2000 === 0) report(ctx, A_SHARE * 0.8 * (n / total), PHASE_A, `culture works ${n.toLocaleString('en')} / ${total.toLocaleString('en')}`); },
    });
    ctx.finishRun(runId, 'succeeded', { metrics: { kindred: counts.relationships?.computed ?? 0 } });
    tx(db, () => {
      // prominence terciles per kind (§6.5): prominence is never an evidence weight
      stmt(db, `UPDATE document SET prominence_tercile = x.t FROM (SELECT id, NTILE(3) OVER (PARTITION BY kind ORDER BY prominence) AS t
          FROM document WHERE collection_id = ? AND prominence IS NOT NULL) AS x WHERE x.id = document.id`).run(collectionId(db, 'cipher-culture-works'));
      setCollectionStatus(db, 'cipher-culture-works', 'ready');
      bumpDataVersion(db);
    });
    result.works = { documents: counts.documents, relationships: counts.relationships, annotations: counts.annotations,
      issues: counts.issues.by_code, kindred_run: runId };
  } else {
    result.works = { skipped: 'already loaded' };
  }
  ctx.checkpoint();
  report(ctx, A_SHARE * 0.85, PHASE_A, 'theme associations');

  // 2. themes
  if (!stmt(db, 'SELECT 1 FROM theme_assoc LIMIT 1').get()) {
    const tctx = adapterCtx(ctx, { keepOriginal });
    result.themes = await writeThemeAssocs(ctx, themes.themeAssocs({}, tctx), themes.themeLabels({}, tctx));
  } else result.themes = { skipped: 'already loaded' };
  ctx.checkpoint();
  report(ctx, A_SHARE * 0.9, PHASE_A, 'etymology (roots.tsv)');

  // 3. roots (idempotent: existing keys are kept)
  result.roots = await writeEtymons(ctx, roots.etymons({}, adapterCtx(ctx, { keepOriginal })));
  result.ms = Date.now() - t0;
  writeState(db, { A: { done_at: nowIso(), ms: result.ms } });
  report(ctx, A_SHARE, PHASE_A, READY_MESSAGE);
  try { ctx.emit?.('bootstrap', { status: 'metadata', phase: PHASE_A, progress: A_SHARE, message: READY_MESSAGE, ready: ['titles', 'relations', 'etymology'] }); } catch { /* script */ }
  ctx.log?.('info', `Cipher phase A done in ${(result.ms / 1000).toFixed(1)} s`, { works: result.works?.documents?.created });
  return result;
}

// ── phase A2 (genealogy) ────────────────────────────────────────────────────────────────────────────

const SOURCE_CODE = { wikipedia: 'w', wikidata: 'd', musicbrainz: 'm', itwofs: 'i' };

/**
 * Relation endpoints in chunks (≈ CHUNK_MS each, or all at once when `untilDone`), then one batch with the
 * endpoint aliases on culture works and every relationship; relations the culture-works siblings already state
 * gain an external_record evidence row instead of a second relationship.
 */
async function phaseA2(ctx, params, { untilDone = false } = {}) {
  const db = ctx.db;
  const t0 = Date.now();
  const writerOptions = params.now ? { now: new Date(params.now) } : {};
  const rel = await loadAdapter('cipher.relations');
  const { loadRelations } = await import('../../adapters/cipher/relations.mjs');
  const { loadWorks, siblingMapping } = await import('../../adapters/cipher/works.mjs');
  const m = loadRelations({ works: loadWorks().rows });
  tx(db, () => ensureAdapterCollections(db, rel));
  setCollectionStatus(db, RELATIONS, 'indexing');
  const keepOriginal = originalsKeeper(db);
  const refused = new Set(readState(db).unloadable?.[RELATIONS] ?? []);
  const total = m.counts.documents;
  let loaded = loadedExtIds(db, RELATIONS);
  const out = { ms: 0, done: false, documents: 0, counts: m.counts };
  while (loaded.size + refused.size < total) {
    if (!untilDone && Date.now() > t0 + CHUNK_MS) { out.ms = Date.now() - t0; return out; }
    const before = loaded.size;
    const refusedNow = [];
    const c = await loadCollection(ctx, rel, RELATIONS, { skip: [...loaded, ...refused], writerOptions }, {
      keepOriginal, relationships: false, annotations: false, deadline: (untilDone ? Date.now() : t0) + CHUNK_MS,
      onDocument: (n, r, doc) => {
        if (r?.documentId === null) refusedNow.push(doc.ext_id);
        if (n % 5000 === 0) report(ctx, A_SHARE + A2_SHARE * 0.7 * ((before + n) / total), PHASE_A2, `relation endpoints ${(before + n).toLocaleString('en')} / ${total.toLocaleString('en')}`);
      },
    });
    out.documents += c.documents.created;
    if (refusedNow.length) {
      for (const x of refusedNow) refused.add(x);
      const st = readState(db).unloadable ?? {};
      writeState(db, { unloadable: { ...st, [RELATIONS]: [...refused] } });
    }
    loaded = loadedExtIds(db, RELATIONS);
    if (c.documents.created + c.documents.rejected === 0) break;
  }
  if (!untilDone && Date.now() > t0 + CHUNK_MS) { out.ms = Date.now() - t0; return out; } // relationships in the next job

  report(ctx, A_SHARE + A2_SHARE * 0.7, PHASE_A2, 'documented relations');
  const siblingKeys = new Set(siblingMapping({}).relationships.filter((r) => r.evidence_status === 'documented' && SOURCE_CODE[r.source_dataset])
    .map((r) => `${r.rel_type}|${r.src.ext_id}|${r.dst.ext_id}|${SOURCE_CODE[r.source_dataset]}`));
  const merged = [];
  let aliases = 0;
  const counts = await loadCollection(ctx, rel, RELATIONS, { skip: [...loaded, ...refused], siblingKeys, merged, writerOptions }, {
    keepOriginal, annotations: false,
    beforeRelationships: async (writer) => {
      for (const a of await rel.endpointAliases()) if (writer.addAlias(a.target, a.alias)) aliases++;
    },
  });
  out.merged = mergeEvidence(db, merged);
  out.aliases = aliases;
  out.relationships = counts.relationships;
  setCollectionStatus(db, RELATIONS, 'ready');
  out.done = true;
  out.ms = Date.now() - t0;
  report(ctx, B0, PHASE_A2, 'Cipher music genealogy is ready');
  return out;
}

/** Add an external_record evidence row (+ an add_evidence revision) to sibling relationships a raw record restates. */
function mergeEvidence(db, merged) {
  const by = 'adapter:cipher.relations@1.0.0';
  let n = 0;
  tx(db, () => {
    const doc = stmt(db, `SELECT d.id FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug = ? AND d.ext_id = ?`);
    const relOf = stmt(db, `SELECT id, current_rev FROM relationship WHERE rel_type = ? AND src_type = 'document' AND src_ref = ?
      AND dst_type = 'document' AND dst_ref = ? AND source_dataset = ? ORDER BY id LIMIT 1`);
    const seen = stmt(db, `SELECT 1 FROM relationship_evidence WHERE relationship_id = ? AND role = 'external_record' AND detail_json = ?`);
    const insEv = stmt(db, `INSERT INTO relationship_evidence (relationship_id, passage_id, role, start_off, end_off, anchor_json, detail_json, added_by, added_at)
      VALUES (?, NULL, 'external_record', NULL, NULL, NULL, ?, ?, ?)`);
    const insRev = stmt(db, `INSERT INTO relationship_revision (relationship_id, rev, actor, at, action, before_json, after_json, reason)
      VALUES (?, ?, ?, ?, 'add_evidence', NULL, ?, ?)`);
    const bump = stmt(db, 'UPDATE relationship SET current_rev = ? WHERE id = ?');
    for (const x of merged) {
      const s = doc.get(x.src.collection, x.src.ext_id), d = doc.get(x.dst.collection, x.dst.ext_id);
      if (!s || !d) continue;
      const dataset = { w: 'wikipedia', m: 'musicbrainz', i: 'itwofs' }[x.source];
      const r = relOf.get(x.rel_type, String(s.id), String(d.id), dataset);
      if (!r) continue;
      const detail = JSON.stringify({ file: x.file, page: x.page, locator: x.locator });
      if (seen.get(r.id, detail)) continue;
      const at = nowIso();
      const ev = Number(insEv.run(r.id, detail, by, at).lastInsertRowid);
      insRev.run(r.id, r.current_rev + 1, by, at, JSON.stringify({ evidence_id: ev, role: 'external_record', locator: x.locator }),
        `the raw ${x.file} record restates this Cipher relation`);
      bump.run(r.current_rev + 1, r.id);
      n++;
    }
    if (n) bumpDataVersion(db);
  });
  return n;
}

// ── phase B ─────────────────────────────────────────────────────────────────────────────────────────

/** Books and Wikisource books still to load, in bootstrap order. */
async function textPlan(db) {
  const books = await loadAdapter('cipher.books');
  const ws = await loadAdapter('cipher.wikisource');
  const { loadBooks } = await import('../../adapters/cipher/books.mjs');
  const { loadWikisource } = await import('../../adapters/cipher/wikisource.mjs');
  const all = { 'cipher-gutenberg': loadBooks().books.map((b) => `pg:${b.id}`) };
  for (const lang of ['hi', 'gu']) {
    all[`cipher-wikisource-${lang}`] = loadWikisource(lang).records.filter((r) => r.rec).map((r) => `ws-${lang}:${r.rec.index}`);
  }
  const plan = [];
  const unloadable = readState(db).unloadable ?? {};
  let total = 0, done = 0;
  for (const slug of TEXT_COLLECTIONS) {
    const loaded = loadedExtIds(db, slug);
    const refused = new Set(unloadable[slug] ?? []);
    const ids = all[slug];
    total += ids.length;
    done += ids.filter((x) => loaded.has(x) || refused.has(x)).length;
    plan.push({ slug, adapter: slug === 'cipher-gutenberg' ? books : ws, loaded, refused,
      remaining: ids.filter((x) => !loaded.has(x) && !refused.has(x)) });
  }
  return { plan, total, done };
}

/** One text chunk (≈ CHUNK_MS of loading), or the whole of phase B text when `untilDone`. */
async function phaseBText(ctx, params, { untilDone = false } = {}) {
  const db = ctx.db;
  const t0 = Date.now();
  const writerOptions = params.now ? { now: new Date(params.now) } : {};
  let { plan, total, done } = await textPlan(db);
  const keepOriginal = originalsKeeper(db);
  setFtsBulkLoad(db, true);
  const result = { chunks: [] };
  try {
    for (const step of plan) {
      if (!step.remaining.length) {
        if (getMeta(db, collectionStatusKey(step.slug)) !== 'ready') setCollectionStatus(db, step.slug, 'ready');
        continue;
      }
      setCollectionStatus(db, step.slug, 'indexing');
      while (step.remaining.length) {
        const deadline = untilDone ? Date.now() + CHUNK_MS : t0 + CHUNK_MS;
        if (!untilDone && Date.now() > deadline) break;
        const before = done;
        const p = step.slug === 'cipher-gutenberg'
          ? { ids: step.remaining.map((x) => Number(x.slice(3))), writerOptions }
          : { skip: [...step.loaded, ...step.refused], writerOptions };
        const refusedNow = [];
        const counts = await loadCollection(ctx, step.adapter, step.slug, p, {
          keepOriginal, relationships: false, annotations: false, deadline,
          onDocument: (n, r, doc) => {
            if (r?.documentId === null) refusedNow.push(doc.ext_id);
            done = before + n;
            report(ctx, B0 + TEXT_SHARE * (done / total), PHASE_B, `full text ${done.toLocaleString('en')} / ${total.toLocaleString('en')} books`);
          },
        });
        if (refusedNow.length) {
          // a record the writer refuses (issues recorded in its batch) is not retried by later chunks
          const st = readState(db).unloadable ?? {};
          writeState(db, { unloadable: { ...st, [step.slug]: [...new Set([...(st[step.slug] ?? []), ...refusedNow])] } });
          for (const x of refusedNow) step.refused.add(x);
        }
        result.chunks.push({ collection: step.slug, documents: counts.documents.created, rejected: counts.documents.rejected,
          translations: counts.documents.translations, tokens: counts.tokens, issues: counts.issues.by_code });
        const loadedNow = loadedExtIds(db, step.slug);
        step.loaded = loadedNow;
        step.remaining = step.remaining.filter((x) => !loadedNow.has(x) && !step.refused.has(x));
        if (counts.documents.created + counts.documents.rejected === 0) break; // nothing left that can load
        if (!untilDone && Date.now() > t0 + CHUNK_MS) break;
      }
      if (!step.remaining.length) setCollectionStatus(db, step.slug, 'ready');
      if (!untilDone && Date.now() > t0 + CHUNK_MS) break;
    }
  } catch (err) {
    db.exec("INSERT INTO passage_fts (passage_fts, rank) VALUES ('automerge', 4)"); // leave the index merging normally
    throw err;
  }
  if (plan.every((x) => !x.remaining.length)) {
    report(ctx, B0 + TEXT_SHARE, PHASE_B, 'optimizing the full-text index');
    setFtsBulkLoad(db, false); // automerge back on + optimize (§4.4)
  }
  checkpointWal(db, 'PASSIVE');
  result.ms = Date.now() - t0;
  result.remaining = plan.reduce((s, x) => s + x.remaining.length, 0);
  return result;
}

/** The boilerplate pass (WP5, §4.7). A stub that is not built yet is reported, not fatal. */
async function phaseBBoilerplate(ctx) {
  const t0 = Date.now();
  report(ctx, B0 + TEXT_SHARE + 0.03, PHASE_B, 'boilerplate pass');
  let outcome;
  try {
    const { boilerplatePass } = await import('../../lineage/boilerplate.mjs');
    outcome = { status: 'done', result: await boilerplatePass(ctx.db, ctx) };
  } catch (err) {
    if (err?.code !== 'NOT_IMPLEMENTED') throw err;
    outcome = { status: 'not_available', reason: 'the boilerplate pass (WP5) is not built yet; licence paragraphs inside book bodies were flagged by the adapter regions only' };
  }
  return { ...outcome, ms: Date.now() - t0 };
}

// ── reconciliation (§6.8) ───────────────────────────────────────────────────────────────────────────

/**
 * Reconciliation counts: what the source files say vs what the database holds.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{expectedRelationships?: object|null}} [opts]
 * @returns {object}
 */
export async function reconcile(db, { expectedRelationships = null } = {}) {
  const coll = (slug) => collectionId(db, slug);
  const one = (sql, ...a) => stmt(db, sql).get(...a);
  const m = {};
  const cw = coll('cipher-culture-works');
  if (cw) {
    m.works = {
      documents: one('SELECT count(*) AS n FROM document WHERE collection_id = ? AND deleted_at IS NULL', cw).n,
      undated: one("SELECT count(*) AS n FROM document WHERE collection_id = ? AND chrono_status = 'undated'", cw).n,
      scheduled: one("SELECT count(*) AS n FROM document WHERE collection_id = ? AND chrono_status = 'scheduled'", cw).n,
      glosses: one(`SELECT count(*) AS n FROM annotation a JOIN document d ON a.target_type = 'document' AND d.id = CAST(a.target_ref AS INTEGER)
        WHERE d.collection_id = ? AND a.kind = 'machine_gloss'`, cw).n,
    };
    // the siblings' relationships only (cipher.relations also links culture works; it is reconciled separately)
    const SIB = "r.created_by = 'adapter:cipher.works@1.0.0'";
    const rels = {};
    for (const r of stmt(db, `SELECT r.rel_type, r.evidence_status, count(*) AS n FROM relationship r
      JOIN document d ON r.src_type = 'document' AND d.id = CAST(r.src_ref AS INTEGER) WHERE d.collection_id = ? AND ${SIB}
      GROUP BY r.rel_type, r.evidence_status`).all(cw)) rels[`${r.rel_type}|${r.evidence_status}`] = r.n;
    m.relationships = { by_type_status: rels,
      kindred_computed: rels['kindred|computed'] ?? 0, counterpart_proposed: rels['counterpart|proposed'] ?? 0,
      documented_unrecorded: one(`SELECT count(*) AS n FROM relationship r JOIN document d ON r.src_type = 'document'
        AND d.id = CAST(r.src_ref AS INTEGER) WHERE d.collection_id = ? AND ${SIB} AND r.provenance_quality = 'source_unrecorded'`, cw).n,
      with_locator: one(`SELECT count(*) AS n FROM relationship r JOIN document d ON r.src_type = 'document'
        AND d.id = CAST(r.src_ref AS INTEGER) WHERE d.collection_id = ? AND ${SIB} AND r.source_locator IS NOT NULL`, cw).n,
      date_conflicts: one(`SELECT count(*) AS n FROM relationship r JOIN document d ON r.src_type = 'document'
        AND d.id = CAST(r.src_ref AS INTEGER) WHERE d.collection_id = ? AND ${SIB} AND r.date_conflict = 1`, cw).n };
    if (expectedRelationships) {
      m.relationships.expected = expectedRelationships;
      m.relationships.match = Object.keys({ ...expectedRelationships, ...rels }).every((k) => (expectedRelationships[k] ?? 0) === (rels[k] ?? 0));
    }
  }
  const pg = coll('cipher-gutenberg');
  if (pg) {
    const tr = {};
    for (const r of stmt(db, `SELECT lang_declared, count(*) AS n FROM document WHERE collection_id = ? AND is_translation = 1
      GROUP BY lang_declared`).all(pg)) tr[r.lang_declared] = r.n;
    const basis = {};
    for (const r of stmt(db, 'SELECT basis, count(*) AS n FROM document WHERE collection_id = ? GROUP BY basis').all(pg)) basis[r.basis] = r.n;
    m.gutenberg = {
      documents: one('SELECT count(*) AS n FROM document WHERE collection_id = ? AND deleted_at IS NULL', pg).n,
      aliases: one('SELECT count(*) AS n FROM document_alias a JOIN document d ON d.id = a.document_id WHERE d.collection_id = ?', pg).n,
      translations: tr, by_basis: basis,
      undated: one("SELECT count(*) AS n FROM document WHERE collection_id = ? AND chrono_status = 'undated'", pg).n,
      lifetime_estimates: one("SELECT count(*) AS n FROM date_assertion a JOIN document d ON a.subject_type = 'document' AND a.subject_id = d.id WHERE d.collection_id = ? AND a.rule = 'cipher_lifetime_year'", pg).n,
      passages_by_quality: Object.fromEntries(stmt(db, `SELECT quality, count(*) AS n FROM passage p JOIN document d ON d.id = p.document_id
        WHERE d.collection_id = ? GROUP BY quality`).all(pg).map((r) => [r.quality, r.n])),
      apparatus_passages: one("SELECT count(*) AS n FROM passage p JOIN document d ON d.id = p.document_id WHERE d.collection_id = ? AND p.time_role = 'apparatus'", pg).n,
      canary_ok_passages: one(`SELECT count(*) AS n FROM passage_fts f JOIN passage p ON p.id = f.rowid JOIN document d ON d.id = p.document_id
        WHERE passage_fts MATCH ? AND d.collection_id = ? AND p.quality = 'ok'`, `"${CANARY}"`, pg).n,
      tokens: one("SELECT COALESCE(SUM(t.tokens), 0) AS n FROM doc_tokens t JOIN document d ON d.id = t.document_id WHERE d.collection_id = ? AND t.field_class = 'text'", pg).n,
    };
  }
  const mr = coll(RELATIONS);
  if (mr) {
    const byStatus = {};
    for (const r of stmt(db, `SELECT r.rel_type, r.provenance_quality, count(*) AS n FROM relationship r WHERE r.created_by = 'adapter:cipher.relations@1.0.0'
      GROUP BY r.rel_type, r.provenance_quality`).all()) byStatus[`${r.rel_type}|${r.provenance_quality}`] = r.n;
    m.music_relations = {
      documents: one('SELECT count(*) AS n FROM document WHERE collection_id = ? AND deleted_at IS NULL', mr).n,
      undated: one("SELECT count(*) AS n FROM document WHERE collection_id = ? AND chrono_status = 'undated'", mr).n,
      aliases_on_works: cw ? one("SELECT count(*) AS n FROM document_alias a JOIN document d ON d.id = a.document_id WHERE d.collection_id = ? AND a.note LIKE 'relation endpoint%'", cw).n : 0,
      relationships: byStatus,
      non_documented: one("SELECT count(*) AS n FROM relationship WHERE created_by = 'adapter:cipher.relations@1.0.0' AND evidence_status <> 'documented'").n,
      merged_evidence_rows: one("SELECT count(*) AS n FROM relationship_evidence WHERE added_by = 'adapter:cipher.relations@1.0.0'").n,
      date_conflicts: one("SELECT count(*) AS n FROM relationship WHERE created_by = 'adapter:cipher.relations@1.0.0' AND date_conflict = 1").n,
    };
  }
  for (const lang of ['hi', 'gu']) {
    const id = coll(`cipher-wikisource-${lang}`);
    if (!id) continue;
    m[`wikisource_${lang}`] = {
      documents: one('SELECT count(*) AS n FROM document WHERE collection_id = ? AND deleted_at IS NULL', id).n,
      undated: one("SELECT count(*) AS n FROM document WHERE collection_id = ? AND chrono_status = 'undated'", id).n,
      front_matter_passages: one("SELECT count(*) AS n FROM passage p JOIN document d ON d.id = p.document_id WHERE d.collection_id = ? AND p.quality = 'front_matter'", id).n,
      tokens: one("SELECT COALESCE(SUM(t.tokens), 0) AS n FROM doc_tokens t JOIN document d ON d.id = t.document_id WHERE d.collection_id = ? AND t.field_class = 'text'", id).n,
    };
  }
  m.etymology = {
    etymons: one('SELECT count(*) AS n FROM etymon').n,
    by_semantics: Object.fromEntries(stmt(db, 'SELECT parent_semantics AS k, count(*) AS n FROM etymon GROUP BY parent_semantics').all().map((r) => [r.k, r.n])),
    members: one('SELECT count(*) AS n FROM etymon_member').n,
  };
  m.themes = { associations: one('SELECT count(*) AS n FROM theme_assoc').n };
  return m;
}

/** Write the reconciliation into a succeeded 'bootstrap-cipher' run. */
async function recordRun(ctx, label, extra) {
  const { siblingMapping } = await import('../../adapters/cipher/works.mjs');
  const expected = siblingMapping({ runIds: { cipher_load: 0 } }).stats;
  const metrics = { label, ...extra, reconciliation: await reconcile(ctx.db, { expectedRelationships: expected.expected }),
    siblings_parse: { items: expected.items, collapsed: expected.collapsed, unknown_relation: expected.unknown_relation,
      unparsed: expected.unparsed, locators: expected.locators, raw_files: expected.raw_files, by_label: expected.by_label } };
  const runId = ctx.startRun('bootstrap-cipher', { pipelineVersion: 'bootstrap-cipher@1.0.0', params: { label },
    scope: { collections: ['cipher-culture-works', RELATIONS, ...TEXT_COLLECTIONS] } });
  ctx.finishRun(runId, 'succeeded', { metrics });
  return { runId, metrics };
}

// ── the job ─────────────────────────────────────────────────────────────────────────────────────────

/** The next step from the stored state. */
export function nextStep(db) {
  const s = readState(db);
  if (!s.A?.done_at) return 'A';
  if (!s.A2?.done_at) return 'A2';
  if (!s.text_done_at) return 'B-text';
  if (!s.boilerplate_done_at) return 'B-boilerplate';
  if (!s.finished_at) return 'B-final';
  return 'done';
}

/**
 * @param {object} ctx TaskCtx
 * @param {{mode?: 'chain'|'all', now?: string, through?: 'A'|'B'}} params
 *   mode 'chain' (job): one step, then enqueue the next bootstrap-cipher job; 'all' (script): every step now.
 *   through 'A': stop after phase A (tests).
 * @returns {Promise<object>} result_json
 */
export async function run(ctx, params = {}) {
  const db = ctx.db;
  const mode = params.mode === 'all' ? 'all' : 'chain';
  const st = cipherStatus();
  if (!st.ok) throw new HttpError(409, 'E_CIPHER_ABSENT', `Cipher files not found: ${st.missing.join(', ')}`, 'Check SCROLLS_CIPHER_ROOT.');
  db.exec('PRAGMA cache_size = -131072'); // 128 MB page cache for this job's connection only
  const results = {};
  const t0 = Date.now();
  if (!readState(db).started_at) writeState(db, { started_at: nowIso() });
  for (;;) {
    const step = nextStep(db);
    if (step === 'done') { results.status = 'ready'; break; }
    if (step === 'A') {
      results.A = await phaseA(ctx, params);
      results.A_run = (await recordRun(ctx, 'phase A', { phase_a_ms: results.A.ms })).runId;
      if (params.through === 'A') break;
    } else if (step === 'A2') {
      const r = await phaseA2(ctx, params, { untilDone: mode === 'all' });
      (results.A2 ??= []).push(r);
      if (r.done) writeState(db, { A2: { done_at: nowIso(), ms_last: r.ms, counts: r.counts } });
      if (params.through === 'A2' && r.done) break;
    } else if (step === 'B-text') {
      const r = await phaseBText(ctx, params, { untilDone: mode === 'all' });
      (results.B ??= []).push(r);
      if (r.remaining === 0) writeState(db, { text_done_at: nowIso() });
    } else if (step === 'B-boilerplate') {
      results.boilerplate = await phaseBBoilerplate(ctx);
      writeState(db, { boilerplate_done_at: nowIso(), boilerplate: { status: results.boilerplate.status, reason: results.boilerplate.reason ?? null } });
    } else if (step === 'B-final') {
      report(ctx, 0.99, PHASE_B, 'optimizing the full-text index');
      const s = readState(db);
      const total = Date.now() - Date.parse(s.started_at);
      const rec = await recordRun(ctx, 'complete', { phase_a_ms: s.A?.ms ?? null, elapsed_ms_since_start: total,
        boilerplate: s.boilerplate ?? null });
      tx(db, () => {
        writeState(db, { finished_at: nowIso(), final_run: rec.runId });
        bumpDataVersion(db);
      });
      checkpointWal(db, 'TRUNCATE');
      results.final_run = rec.runId;
      results.status = 'ready';
      report(ctx, 1, PHASE_B, 'Cipher full text is ready');
      break;
    }
    checkpointWal(db, 'PASSIVE');
    ctx.checkpoint();
    if (mode === 'chain') {
      ctx.enqueue('bootstrap-cipher', { mode: 'chain', ...(params.now ? { now: params.now } : {}) });
      results.next = nextStep(db);
      break;
    }
  }
  clearSourceCache();
  results.ms = Date.now() - t0;
  return results;
}
