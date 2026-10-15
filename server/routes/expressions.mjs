// OWNER: WP3
// routes/expressions.mjs — track an expression, its variants and its materialization state (SPEC §7.1, §7.2).
//
//   POST  /api/expressions                 { surface, lang?, kind?, corpus? } → Expression (a job when counting is needed)
//   GET   /api/expressions/:id[?corpus=real]
//                                          → Expression
//   PATCH /api/expressions/:id/variants[?corpus=real]
//                                          { variants: [{id, enabled}], names?: [{document_id, field, start, counted}] }
//                                          → Expression; counting reruns as a job
//
// Contract 1.3.0: `corpus: 'real'` (vocab.VIRTUAL_CORPORA) tracks the expression in every member corpus and answers the
// first member's expression with `members` (each corpus's id and state) and counts added up; a variant change made in
// `real` is applied to every member, so each corpus keeps counting the same variants. When the Wiktionary word index
// has been built (a Wiktionary load ran before), tracking a real word or phrase queues the claim lookup for it at once
// (the same adapter-load job and display rule as a load).

import { HttpError } from '../http/errors.mjs';
import { stmt } from '../db/open.mjs';
import {
  ensureMaterialized, expressionPayload, getExpression, setNameOverrides, setVariantsEnabled, trackExpression, variantsOf,
} from '../aggregate/materialize.mjs';
import { isVirtualCorpus, resolveCorpusScope, siblingExpressions, trackAcross } from '../aggregate/scope.mjs';
import { indexReady } from '../adapters/stemm/wiktionary.mjs';

function idParam(params) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'E_BAD_ID', `'${params.id}' is not an expression id.`);
  return id;
}

function requireExpression(db, id) {
  if (!getExpression(db, id)) throw new HttpError(404, 'E_NOT_FOUND', `No expression ${id}.`);
}

/** Expression payload with the newest job's live state from the queue. */
function payload(ctx, id) {
  const st = ensureMaterialized(ctx.db, ctx.jobs, id);
  return expressionPayload(ctx.db, id, { job: st.job });
}

/** The member expressions of an expression in a virtual corpus (the expression itself first when it is a member). */
function memberIds(db, id, corpus) {
  const scope = resolveCorpusScope(db, corpus);
  const e = getExpression(db, id);
  if (!scope.ids.includes(e.corpus_id)) {
    throw new HttpError(400, 'E_VALIDATION', `Expression ${id} belongs to a corpus outside '${corpus}' (the synthetic demo is never part of it).`,
      `Track '${e.surface}' in ${corpus}.`, { field: 'corpus' });
  }
  return siblingExpressions(db, e, scope.members).filter((s) => s.expr).map((s) => ({ corpus: s.corpus, id: s.expr.id }));
}

/**
 * The Expression payload of an expression in a virtual corpus: the first member's expression (corpus = the virtual
 * slug), variants with n added up over the members (matched by form and language), the state of all members, and every
 * member's own payload under `members`. Claims are listed once.
 */
function virtualPayload(ctx, id, corpus) {
  const members = memberIds(ctx.db, id, corpus).map((m) => ({ ...m, payload: payload(ctx, m.id) }));
  const lead = members.find((m) => m.id === id) ?? members[0];
  const p = lead.payload;
  const states = members.map((m) => m.payload.state);
  const status = states.some((s) => s.status === 'materializing') ? 'materializing'
    : states.every((s) => s.status === 'ready') ? 'ready' : states.some((s) => s.status === 'failed') ? 'failed' : 'none';
  const sum = (k) => (states.every((s) => s[k] !== null && s[k] !== undefined) ? states.reduce((a, s) => a + s[k], 0) : null);
  const variants = p.variants.map((v) => {
    const same = members.map((m) => m.payload.variants.find((x) => x.form === v.form && (x.lang ?? null) === (v.lang ?? null)));
    const n = same.every((x) => x && x.n !== null) ? same.reduce((a, x) => a + x.n, 0) : null;
    return { ...v, n };
  });
  const seen = new Set(), claims = [];
  for (const m of members) {
    for (const c of m.payload.claims ?? []) {
      const k = `${c.label}|${c.date.lo_year}|${c.date.hi_year}`;
      if (!seen.has(k)) { seen.add(k); claims.push(c); }
    }
  }
  return {
    expression: { ...p.expression, corpus },
    variants,
    state: { status, job: states.find((s) => s.job)?.job ?? null, run: null, n: sum('n'), docs: sum('docs'), names_excluded: sum('names_excluded') },
    claims,
    members: members.map((m) => ({ corpus: m.corpus, id: m.id, state: m.payload.state })),
  };
}

/**
 * Queue the Wiktionary claim lookup for a newly tracked real word or phrase when the word index was built by an
 * earlier load (C2 item 6): the same adapter-load job and display rule as a load. Synthetic and demo expressions never
 * get external claims; a job is queued once per expression. Also used by the timeline route when a virtual-corpus query
 * tracks a missing sibling.
 * @param {{db: import('node:sqlite').DatabaseSync, jobs: object, withWrite: Function}} ctx RouteCtx
 * @param {number} id expression id
 * @returns {number|null} the job id
 */
export function queueClaims(ctx, id) {
  const e = getExpression(ctx.db, id);
  if (!e || e.is_synthetic === 1 || !['word', 'phrase'].includes(e.kind)) return null;
  const corpus = e.corpus_id === null ? null : stmt(ctx.db, 'SELECT slug FROM corpus WHERE id = ?').get(e.corpus_id)?.slug;
  if (corpus === 'demo') return null;
  let meta = {};
  try { meta = JSON.parse(e.meta_json ?? '{}') ?? {}; } catch { meta = {}; }
  if (meta.wiktionary_lookup) return null;
  const adapter = stmt(ctx.db, "SELECT enabled FROM source_adapter WHERE id = 'stemm.wiktionary'").get();
  if (adapter && adapter.enabled === 0) return null;
  let ready = false;
  try { ready = indexReady(); } catch { ready = false; }
  if (!ready) return null;
  const job = ctx.jobs.enqueue('adapter-load', { adapter: 'stemm.wiktionary', expressionId: id });
  ctx.withWrite((db) => stmt(db, 'UPDATE expression SET meta_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...meta, wiktionary_lookup: { job, at: new Date().toISOString() } }), id));
  return job;
}

const corpusParam = (v) => (typeof v === 'string' && v ? v : null);

/** @type {Array<{method: string, path: string, heavy?: boolean, handler: Function}>} */
export const routes = [
  {
    method: 'POST',
    path: '/api/expressions',
    async handler(req, ctx) {
      const b = req.body ?? {};
      if (typeof b.surface !== 'string') {
        throw new HttpError(400, 'E_VALIDATION', 'surface is required.', 'Type a word, a phrase or a symbol.', { field: 'surface' });
      }
      const spec = { surface: b.surface, lang: b.lang ?? null, kind: b.kind ?? null, corpus: b.corpus ?? null, origin: 'user_query', createdBy: 'user' };
      // the count is queued first (payload → ensureMaterialized), the claim lookup after it: both take the writer slot,
      // and a new word's count is what the user waits for
      if (isVirtualCorpus(spec.corpus)) {
        const t = ctx.withWrite((db) => trackAcross(db, spec));
        const json = virtualPayload(ctx, t.id, spec.corpus);
        for (const m of t.members) queueClaims(ctx, m.id);
        return { json };
      }
      const { id } = ctx.withWrite((db) => trackExpression(db, spec));
      const json = payload(ctx, id);
      queueClaims(ctx, id);
      return { json };
    },
  },
  {
    method: 'GET',
    path: '/api/expressions/:id',
    async handler(req, ctx) {
      const id = idParam(req.params);
      requireExpression(ctx.db, id);
      const corpus = corpusParam(req.query.corpus);
      return { json: isVirtualCorpus(corpus) ? virtualPayload(ctx, id, corpus) : payload(ctx, id) };
    },
  },
  {
    method: 'PATCH',
    path: '/api/expressions/:id/variants',
    async handler(req, ctx) {
      const id = idParam(req.params);
      requireExpression(ctx.db, id);
      const b = req.body ?? {};
      if (!Array.isArray(b.variants) && !Array.isArray(b.names)) {
        throw new HttpError(400, 'E_VALIDATION', 'Send variants: [{id, enabled}] (and/or names: [{document_id, field, start, counted}]).', null, { field: 'variants' });
      }
      const corpus = corpusParam(req.query.corpus ?? b.corpus);
      ctx.withWrite((db) => {
        if (Array.isArray(b.variants) && b.variants.length) {
          setVariantsEnabled(db, id, b.variants);
          if (isVirtualCorpus(corpus)) mirrorVariants(db, id, b.variants, corpus);
        }
        if (Array.isArray(b.names) && b.names.length) setNameOverrides(db, id, b.names);
      });
      return { json: isVirtualCorpus(corpus) ? virtualPayload(ctx, id, corpus) : payload(ctx, id) };
    },
  },
];

/** Apply a variant change to every sibling of a virtual corpus, matching variants by folded form, language and type. */
function mirrorVariants(db, id, changes, corpus) {
  const own = new Map(variantsOf(db, id).map((v) => [v.id, v]));
  for (const m of memberIds(db, id, corpus)) {
    if (m.id === id) continue;
    const theirs = variantsOf(db, m.id);
    const mapped = [];
    for (const c of changes) {
      const v = own.get(c.id);
      const t = v && theirs.find((x) => x.norm === v.norm && (x.lang ?? null) === (v.lang ?? null) && x.variant_type === v.variant_type);
      if (t) mapped.push({ id: t.id, enabled: c.enabled });
    }
    if (mapped.length) setVariantsEnabled(db, m.id, mapped);
  }
}
