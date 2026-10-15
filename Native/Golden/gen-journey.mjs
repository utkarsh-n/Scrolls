// OWNER: N6
// G7 (IOS-SPEC §2.2, §8.5 N6): API journeys, writes included, as the reference answers them. Swift replays each family
// in process with `scrolls-cli api --golden <family>` on its own `cp -c` clone of the same snapshot and compares every
// answer, normalised by natural keys, timestamps and data_version (Tools/check.d/journey.sh).
//
//   g7.journey-m1r   the RF-3 recording of `npm run verify -- --record` on m1r (R's tools/verify/m1r-journey.jsonl):
//                    import, track, tiles L0–L5, passages, Compare, save, annotate, review, restart, reopen, as-saved,
//                    as-saved Compare, as-of. Every package's routes; the cases are attributed to their owners.
//   g7.journey-m5r   the same journey recorded on m5r (M2). Private: m5r holds licence-restricted collections.
//   g7.notebook-m1r  N6's notebook script, run here on a fresh m1r clone through the reference server's HTTP API:
//                    saved views (save, re-save → slug~n, parent, list, as-saved, delete, refusals), annotations
//                    (create with a D18 anchor, revise, revisions, reinterpret, withdraw, as-of, refusals), relationships
//                    (review, propose with an evidence span, external evidence, a hypothesis group) and a restart. It
//                    touches no route of another package, so it is exact on its own while the journey waits for theirs.
// A case is one exchange in the recording's format: {id, snapshot, seq, step, method, path, headers?, raw?, body?,
// poll?, status, response | text} or {id, snapshot, seq, step, event: 'restart'}. Responses are stored as the
// reference sent them; normalisation happens on comparison, on both sides the same way.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const owner = 'N6';
export const group = 'journey';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The RF-3 recording of one snapshot, as cases. */
function recording(name) {
  return async (ctx) => {
    const file = join(ctx.snapshots, 'tools', 'verify', `${name}-journey.jsonl`);
    if (!existsSync(file)) throw new Error(`${file} is missing (R records it with npm run verify -- --record)`);
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const header = lines.find((l) => l.journey) ?? null;
    ctx.inputs = { recording: `tools/verify/${name}-journey.jsonl`, sha256: sha256(text), header };
    return lines.filter((l) => !l.journey).map((l) => {
      const { ms, ...rest } = l;  // timings are not compared
      return { id: `${name}-${l.seq}`, snapshot: name, ...rest };
    });
  };
}

// ── The reference server on a clone (restartable on the same data) ─────────────────────────────────────────────────

async function startServer(ctx, dir) {
  const env = { ...process.env, SCROLLS_DATA: dir, SCROLLS_NO_AUTO_IMPORT: '1', SCROLLS_PORT: '0' };
  const child = spawn(process.execPath, [join(ctx.refRoot, 'server.mjs')], { cwd: ctx.refRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const lines = createInterface({ input: child.stdout });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the reference server did not start in 600 s: ${stderr}`)), 600_000);
    lines.on('line', (l) => {
      try {
        const j = JSON.parse(l);
        if (j.event === 'listening') { clearTimeout(timer); resolve(j.url); }
      } catch { /* the human-readable line */ }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
  });
  return {
    url,
    async call(method, path, body) {
      for (let attempt = 0; ; attempt++) {
        const headers = { origin: url };
        if (body !== undefined) headers['content-type'] = 'application/json';
        const res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        if (res.status === 503 && attempt < 8) { await new Promise((r) => setTimeout(r, 2000)); continue; }
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* a download */ }
        return { status: res.status, json, text };
      }
    },
    async close() {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => {});
    },
  };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ── N6's notebook script ─────────────────────────────────────────────────────────────────────────────────────────

/** The demo view state the RF-3 journey saves (expression 1, passage 94 selected), with a name of our own. */
function demoState() {
  return {
    v: 1, corpus: 'demo', strands: [{ type: 'expression', id: 1 }],
    lanes: { facet: 'community', sub: null, run: null, order: 'first_observed', manual: [], max: 10 },
    f: { lang: [], kind: [], coll: [], culture: [], field: [], community: [], basis: [], syn: 1 },
    toggles: { tr: 0, ds: 0, ap: 0, dup: 0, nm: 0, est: 1, bp: 0 }, timeBasis: 'publication',
    axis: { mode: 'linear', centerDay: -3653, daysPerPx: 50, keepLinear: false }, tier: 'auto',
    vantage: { day: -16072, strict: false }, range: null,
    evidence: { documented: 1, computed: 1, proposed: 1, rejected: 0, kindred: 0 },
    layers: { arcs: 1, feedback: 1, washes: 1, coverage: 1, etymology: 1, claims: 1, baseline: 0, variety: 0, tone: 0, superseded: 0 },
    selection: { type: 'passage', id: 94 }, panels: { inspector: 'tnn', right: null },
    compare: { a: { years: [1955, 1985], f: '' }, b: { years: [1994, 2026], f: '' } },
    constellation: { layoutKey: null, size: 'occurrences', a: null, b: null },
    lineage: { root: null, depth: 2, types: [], status: [] },
    runs: { materialize: {}, cluster: null, quotes: null, vectors: null }, asSaved: false, reducedMotion: 'system',
  };
}

async function notebook(ctx) {
  const snapshot = 'm1r';
  const clone = ctx.cloneSnapshot(snapshot);
  ctx.inputs = { snapshot, snapshot_info: ctx.snapshotInfo(snapshot)?.files?.['scrolls.db'] ?? null };
  const cases = [];
  let seq = 0;
  let server = await startServer(ctx, clone.dir);
  ctx.log(`reference server on a ${snapshot} clone at ${server.url}`);
  const call = async (step, method, path, body) => {
    const r = await server.call(method, path, body);
    seq++;
    const c = { id: `nb-${seq}`, snapshot, seq, step, method, path };
    if (body !== undefined) c.body = body;
    c.status = r.status;
    if (r.json !== null) c.response = r.json; else c.text = r.text;
    cases.push(c);
    if (method !== 'GET') await pause(40);  // distinct instants for the as-of cases
    return r.json;
  };
  try {
    // the passage the notes are about: demo passage 94 of document 32 (the RF-3 journey's), anchored on its text
    const passage = (await server.call('GET', '/api/passages/94')).json;
    if (!passage?.anchor?.sha256) throw new Error(`passage 94 of ${snapshot} has no anchor: ${JSON.stringify(passage).slice(0, 300)}`);
    const doc = passage.anchor.doc_id;
    const words = String(passage.text).slice(0, 120);
    const anchor = { ...passage.anchor, end: passage.anchor.start + words.length, quote: words };

    // saved views
    const v1 = await call('save a view', 'POST', '/api/views', { name: 'notebook demo view', state: demoState(), comparisons_tried: 2, description: 'The classroom passage, as saved.' });
    await call('save a view', 'GET', `/api/views/${v1.slug}`);
    await call('save a view', 'GET', `/api/views/${v1.slug}?as=1`);
    const v2 = await call('re-save: the same name and state make slug~2', 'POST', '/api/views', { name: 'notebook demo view', state: demoState(), comparisons_tried: 2 });
    await call('re-save from a parent: slug~3', 'POST', '/api/views', { name: 'notebook demo view, again', state: { ...demoState(), selection: null }, parent_slug: v1.slug, comparisons_tried: 3 });
    await call('list views', 'GET', '/api/views');
    await call('list views by name', 'GET', '/api/views?q=again&limit=5');
    await call('refusal: a view needs a name', 'POST', '/api/views', { state: demoState() });
    await call('refusal: a view needs its state', 'POST', '/api/views', { name: 'no state' });
    await call('refusal: an unknown parent', 'POST', '/api/views', { name: 'orphan', state: demoState(), parent_slug: 'no-such-view' });
    await call('refusal: an unknown view', 'GET', '/api/views/no-such-view');

    // annotations
    const a = await call('annotate a passage (D18 anchor)', 'POST', '/api/annotations', {
      target: { type: 'passage', ref: '94' }, kind: 'interpretation', body_md: 'notebook: the examiner repeats the rule.',
      dimensions: {}, tags: ['notebook'], layer: 'Notebook', anchor,
    });
    await call('revise it', 'PATCH', `/api/annotations/${a.id}`, { body_md: 'notebook: the examiner repeats the counting rule.', reason: 'more exact' });
    await call('its revisions', 'GET', `/api/annotations/${a.id}/revisions`);
    const between = new Date().toISOString();
    await pause(40);
    await call('revise it again', 'PATCH', `/api/annotations/${a.id}`, { body_md: 'notebook: the rule is the examiner\'s, not the teacher\'s.', tags: ['notebook', 'rule'] });
    const re = await call('reinterpret it', 'POST', `/api/annotations/${a.id}/reinterpret`, {
      target: { type: 'passage', ref: '94' }, kind: 'hypothesis', body_md: 'notebook: perhaps the rule is the textbook\'s.', anchor,
    });
    await call('withdraw the reinterpretation', 'POST', `/api/annotations/${re.id}/withdraw`, { reason: 'the textbook has no such rule' });
    await call('the notes on the passage', 'GET', '/api/annotations?target=passage%3A94&include=all');
    await call('the notes on the passage, as of between the revisions', 'GET', `/api/annotations?target=passage%3A94&as_of=${encodeURIComponent(between)}`);
    await call('refusal: a note needs a body', 'POST', '/api/annotations', { target: { type: 'passage', ref: '94' }, kind: 'interpretation', body_md: '', anchor });
    await call('refusal: a machine author', 'POST', '/api/annotations', { target: { type: 'document', ref: String(doc) }, kind: 'question', body_md: 'Who wrote this?', author: 'model: gpt' });
    await call('refusal: an unknown note', 'PATCH', '/api/annotations/999999999', { body_md: 'nothing here' });

    // relationships and hypotheses
    await call('the demo link', 'GET', '/api/relationships/1');
    await call('review the demo link', 'POST', '/api/relationships/1/review', { action: 'dispute', note: 'notebook: checked both passages by hand.' });
    await call('refusal: a review needs a note', 'POST', '/api/relationships/1/review', { action: 'confirm', note: 'ok' });
    await call('the demo link after the review', 'GET', '/api/relationships/1');
    const p = await call('propose a link', 'POST', '/api/relationships', {
      src: 'passage:94', dst: 'document:4', rel_type: 'proposed_allusion', note: 'notebook: the same rule in both.',
      evidence: [{ passage: 94, start: 0, end: Math.min(40, words.length), role: 'source_span', relative: true }],
    });
    if (p?.id) {
      await call('external evidence for it', 'POST', `/api/relationships/${p.id}/evidence`, { role: 'external_record', note: 'notebook: the syllabus names it.', locator: 'demo-records:syllabus' });
      await call('confirm it', 'POST', `/api/relationships/${p.id}/review`, { action: 'confirm', note: 'notebook: the spans match word for word.' });
      await call('the proposed link', 'GET', `/api/relationships/${p.id}`);
      await call('annotate the link', 'POST', '/api/annotations', { target: { type: 'relationship', ref: String(p.id) }, kind: 'question', body_md: 'notebook: who copied whom?' });
    }
    const g = await call('a hypothesis group', 'POST', '/api/hypothesis-groups', { target: 'passage:94', question: 'Where does the examiner\'s rule come from?' });
    if (g?.id) await call('the hypothesis group', 'GET', `/api/hypothesis-groups/${g.id}`);

    // restart: the server stops and starts on the same data
    await server.close();
    seq++;
    cases.push({ id: `nb-${seq}`, snapshot, seq, step: 'restart', event: 'restart' });
    server = await startServer(ctx, clone.dir);
    await call('reopen the view as saved', 'GET', `/api/views/${v1.slug}?as=1`);
    await call('reopen the re-saved view', 'GET', `/api/views/${v2.slug}`);
    await call('the notes after the restart', 'GET', '/api/annotations?target=passage%3A94&include=all');
    await call('the active notes after the restart', 'GET', '/api/annotations?target=passage%3A94');
    await call('its revisions after the restart', 'GET', `/api/annotations/${a.id}/revisions`);
    await call('delete a view', 'DELETE', `/api/views/${v2.slug}`);
    await call('a deleted view no longer resolves', 'GET', `/api/views/${v2.slug}`);
    await call('the list after the deletion', 'GET', '/api/views');
  } finally {
    await server.close();
    clone.cleanup();
  }
  return cases;
}

export const families = {
  'g7.journey-m1r': { run: recording('m1r'), owner: 'N6', note: 'RF-3 recording on m1r; replayed by scrolls-cli api --golden' },
  'g7.journey-m5r': { run: recording('m5r'), owner: 'N6', private: true, note: 'M2; m5r holds licence-restricted collections' },
  'g7.notebook-m1r': { run: notebook, owner: 'N6', note: "N6's notebook script through the reference server on an m1r clone" },
};
