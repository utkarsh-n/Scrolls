// OWNER: WP5
// genealogy.mjs — the sampling family tree, works mode of the Lineage explorer (SPEC §2.C2).
//
// One row per work, grouped by generation from the seed (+1 = works that sample, interpolate, cover, remix or
// version it; −1 = what it sampled), sorted by date inside a generation, with a per-decade density count.
// Defaults: types {samples, interpolates, cover_of, remix_of, version_of}; documented only; depth ≤ 3 each way;
// ≤ 150 rows (the rest are counted and paged). Every edge carries its source dataset and locator. Absence of a
// link is never read as absence of sampling.

import { slugify } from '../../src/shared/ids.mjs';
import { stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';
import { asOfRows, edgeFilters, edgeWhere } from './graph.mjs';

export const DEFAULT_TYPES = Object.freeze(['samples', 'interpolates', 'cover_of', 'remix_of', 'version_of']);
export const MAX_ROWS = 150;
export const MAX_DEPTH = 3;
const NOTE_REAL = 'Documented links from Wikipedia, MusicBrainz, Wikidata and ItwoFS as collected by Cipher. Absence of a link is not evidence of no sampling.';
const NOTE_SYNTHETIC = "Documented links from the synthetic world's records. Absence of a link is not evidence of no sampling.";
const NOTE_EMPTY = 'No documented sample, cover, remix or version links. Absence of a link is not evidence of no sampling.';

const invalid = (message, field) => new HttpError(400, 'E_VALIDATION', message, null, { field });
/** First year of the decade holding an astronomical year (1994 → 1990; −5 → −10). */
const decadeOf = (y) => Math.floor(y / 10) * 10;

function docRow(db, id) {
  return stmt(db, `SELECT d.id, d.title, d.author, d.kind, d.y_lo, d.y_hi, d.precision, d.date_label, d.chrono_status, d.is_synthetic,
      d.collection_id, c.slug AS collection, c.rate_eligible FROM document d JOIN collection c ON c.id = d.collection_id
    WHERE d.id = ? AND d.deleted_at IS NULL`).get(id) ?? null;
}

const MAX_SEEDS = 500;

/**
 * Works of a maker: documents whose author is the name, or that carry it as a maker tag (Cipher splits multi-maker
 * credits into tags). A search suggestion's maker reference is a slug (`maker:<slugify(name)>`), resolved here to the
 * names with that slug.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} maker a name or a slug
 * @returns {{name: string, ids: number[]}} ids ordered by date (undated last), at most 500
 */
export function makerWorks(db, maker) {
  const byNames = (names) => {
    const list = JSON.stringify(names);
    return stmt(db, `SELECT d.id FROM document d WHERE d.deleted_at IS NULL AND d.id IN (
        SELECT id FROM document WHERE author IN (SELECT value FROM json_each(?1))
        UNION SELECT document_id FROM doc_tag WHERE scheme = 'maker' AND value IN (SELECT value FROM json_each(?1)))
      ORDER BY d.y_lo IS NULL, d.y_lo, d.id LIMIT ${MAX_SEEDS}`).all(list).map((r) => r.id);
  };
  const exact = byNames([maker]);
  if (exact.length || !/^[\p{Ll}\p{N}-]+$/u.test(maker)) return { name: maker, ids: exact };
  const words = maker.split('-').filter(Boolean);
  if (!words.length) return { name: maker, ids: [] };
  const like = `%${words.join('%')}%`;
  const names = stmt(db, `SELECT DISTINCT author AS name FROM document WHERE author LIKE ?1 AND deleted_at IS NULL
      UNION SELECT DISTINCT value FROM doc_tag WHERE scheme = 'maker' AND value LIKE ?1`).all(like)
    .map((r) => r.name).filter((n) => slugify(n) === maker);
  return { name: names[0] ?? maker, ids: names.length ? byNames(names) : [] };
}

/** Document id behind a relationship endpoint (works are documents; passage endpoints resolve to theirs). */
function docOfRef(db, type, ref) {
  if (type === 'document') return Number(ref);
  if (type === 'passage') return stmt(db, 'SELECT document_id FROM passage WHERE id = ?').get(Number(ref))?.document_id ?? null;
  return null;
}

/**
 * GET /api/genealogy?work=document:61002|maker=<name>&dir=forward|back|both&depth=&types=&status=&max=&cursor= — read pool.
 * `forward` = later works that reuse the seed (+1, +2, …); `back` = what the seed reused (−1, −2, …).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {object} args
 * @returns {object} SHAPES.Genealogy
 */
export function genealogyQuery(db, args = {}) {
  let seeds;
  let seedJson;
  if (args.maker) {
    const found = makerWorks(db, String(args.maker));
    seeds = found.ids;
    const maker = found.name;
    if (!seeds.length) throw new HttpError(404, 'E_NOT_FOUND', `No works by ${args.maker}.`);
    const first = docRow(db, seeds[0]);
    seedJson = { doc: first.id, title: `${maker} — ${seeds.length} work${seeds.length === 1 ? '' : 's'}`, maker, year: first.y_lo ?? null,
      works: seeds.length };
  } else {
    const m = /^document:(\d+)$/.exec(String(args.work ?? ''));
    if (!m) throw invalid("work must be a reference like 'document:61002' (or give maker=).", 'work');
    const d = docRow(db, Number(m[1]));
    if (!d) throw new HttpError(404, 'E_NOT_FOUND', `No work ${args.work}.`);
    seeds = [d.id];
    seedJson = { doc: d.id, title: d.title ?? `document ${d.id}`, maker: d.author ?? null, year: d.y_lo ?? null,
      date: { label: d.date_label, precision: d.precision } };
  }
  const dir = ['forward', 'back', 'both'].includes(args.dir) ? args.dir : 'both';
  const depth = Math.min(MAX_DEPTH, Math.max(1, Number.parseInt(args.depth ?? '3', 10) || 3));
  const max = Math.min(MAX_ROWS, Math.max(1, Number.parseInt(args.max ?? String(MAX_ROWS), 10) || MAX_ROWS));
  const f = edgeFilters({ ...args, types: args.types ?? DEFAULT_TYPES.join(','), status: args.status ?? 'documented' });
  const [where, params] = edgeWhere(f);
  const offset = (() => {
    if (!args.cursor) return 0;
    try { return Math.max(0, Number(JSON.parse(Buffer.from(String(args.cursor), 'base64url').toString('utf8')).offset) || 0); } catch {
      throw new HttpError(400, 'E_BAD_CURSOR', 'The cursor is not one this server issued.', 'Restart the list without a cursor.');
    }
  })();

  // breadth-first over document-level links, by generation (+ forward, − back)
  const placed = new Map(seeds.map((id) => [id, 0]));
  const rows = [];
  const rowAt = new Map(); // 'doc:gen' → row
  const walk = (sign) => {
    let frontier = [...seeds];
    for (let g = 1; g <= depth && frontier.length; g++) {
      const next = [];
      for (const docId of frontier) {
        const refs = [['document', String(docId)], ...stmt(db, 'SELECT id FROM passage WHERE document_id = ?').all(docId).map((p) => ['passage', String(p.id)])];
        for (const [type, ref] of refs) {
          const rels = asOfRows(db, f, sign > 0
            ? stmt(db, `SELECT r.* FROM relationship r WHERE r.dst_type = ? AND r.dst_ref = ? AND ${where}`).all(type, ref, ...params)
            : stmt(db, `SELECT r.* FROM relationship r WHERE r.src_type = ? AND r.src_ref = ? AND ${where}`).all(type, ref, ...params));
          for (const r of rels) {
            const other = sign > 0 ? docOfRef(db, r.src_type, r.src_ref) : docOfRef(db, r.dst_type, r.dst_ref);
            if (other === null || other === docId) continue;
            const edge = { rel_id: r.id, rel_type: r.rel_type, evidence_status: r.evidence_status, review_status: r.review_status,
              source_dataset: r.source_dataset ?? null, locator: r.source_locator ?? null, provenance_quality: r.provenance_quality,
              date_conflict: r.date_conflict === 1, parent: docId };
            const existing = rowAt.get(`${other}:${sign * g}`);
            if (existing) { if (!existing.edges.some((e) => e.rel_id === r.id)) existing.edges.push(edge); continue; }
            if (placed.has(other)) continue;
            const d = docRow(db, other);
            if (!d) continue;
            placed.set(other, sign * g);
            rows.push({ gen: sign * g, doc: d.id, title: d.title ?? `document ${d.id}`, maker: d.author ?? null, kind: d.kind,
              date: { label: d.date_label, precision: d.precision }, y: d.y_lo, undated: d.chrono_status !== 'dated', edges: [edge],
              // relation-endpoint works (not among the culture works) never enter title rates (§2.C2)
              collection: d.collection, rate_eligible: d.rate_eligible === 1, synthetic: d.is_synthetic === 1 });
            rowAt.set(`${other}:${sign * g}`, rows[rows.length - 1]);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
  };
  if (dir !== 'back') walk(1);
  if (dir !== 'forward') walk(-1);

  const byGen = new Map();
  for (const r of rows) {
    if (!byGen.has(r.gen)) byGen.set(r.gen, []);
    byGen.get(r.gen).push(r);
  }
  const gens = [...byGen.keys()].sort((a, b) => (Math.sign(a) - Math.sign(b)) || Math.abs(a) - Math.abs(b));
  let budget = max, skipped = offset, hidden = 0;
  const generations = gens.map((gen) => {
    const all = byGen.get(gen).sort((a, b) => (a.undated - b.undated) || (a.y ?? 0) - (b.y ?? 0) || a.doc - b.doc);
    const byDecade = {};
    for (const r of all) if (!r.undated && r.y !== null) { const k = String(decadeOf(r.y)); byDecade[k] = (byDecade[k] ?? 0) + 1; }
    const undated = all.filter((r) => r.undated).length;
    const start = Math.min(all.length, skipped);
    skipped -= start;
    const take = all.slice(start, start + budget);
    budget -= take.length;
    hidden += all.length - start - take.length;
    return { gen, total: all.length, returned: take.length, by_decade: byDecade, undated,
      rows: take.map(({ gen: _g, y: _y, ...row }) => row) };
  }).filter((g) => g.total > 0);
  const shownSoFar = offset + generations.reduce((s, g) => s + g.returned, 0);
  const anySynthetic = docRow(db, seeds[0])?.is_synthetic === 1;
  return {
    seed: seedJson,
    generations,
    truncated: { rows: hidden, cursor: hidden ? Buffer.from(JSON.stringify({ offset: shownSoFar })).toString('base64url') : null },
    filters: { dir, depth, max, types: f.types, status: f.status },
    note: rows.length ? (anySynthetic ? NOTE_SYNTHETIC : NOTE_REAL) : NOTE_EMPTY,
    synthetic: anySynthetic,
  };
}
