// OWNER: WP2
// siblings.mjs — culture-works `siblings` → CanonicalRelationship rows (SPEC §6.6).
//
// Cipher writes each link on both rows (build_culture.py link(): the forward label on one, the backward
// label on the other) and keeps only each row's top 8 relatives, so a pair may appear once or twice.
// Every item maps to (rel_type, src = later/dependent, dst = earlier/source); items with the same
// (rel_type, src, dst, source code) collapse into one relationship. Evidence status is fixed here, once, by
// the source code: w/d/m/i → documented; kindred → computed (Cipher's theme cosine, with a run);
// counterpart → proposed; any other '-' relation → proposed (machine_tagger) when the pair appears in either
// work's tagging batch, else documented with provenance_quality 'source_unrecorded' (DOC*).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REL_TYPE_BY_CODE } from '../../../src/shared/vocab.mjs';
import { fold, TAGGING_METHOD } from './source.mjs';

/**
 * Cipher relation label → [rel_type, direction]. 'fwd': the row is the later/dependent end (src = row);
 * 'back': the sibling is (src = sibling); 'sym': undirected.
 */
export const RELATION_MAP = Object.freeze({
  'samples': ['samples', 'fwd'], 'sampled by': ['samples', 'back'],
  'interpolates': ['interpolates', 'fwd'], 'interpolated in': ['interpolates', 'back'],
  'cover of': ['cover_of', 'fwd'], 'covered as': ['cover_of', 'back'],
  'version of': ['version_of', 'fwd'], 'other version': ['version_of', 'back'],
  'remix of': ['remix_of', 'fwd'], 'remixed as': ['remix_of', 'back'],
  'answer song to': ['answer_to', 'fwd'], 'answered by': ['answer_to', 'back'],
  'inspired by': ['inspired_by', 'fwd'], 'inspired': ['inspired_by', 'back'],
  'from film': ['part_of', 'fwd'], 'features song': ['part_of', 'back'],
  'written for': ['part_of', 'fwd'], 'song from': ['part_of', 'back'],
  'based on': ['adaptation_of', 'fwd'], 'adapted as': ['adaptation_of', 'back'],
  'remake of': ['remake_of', 'fwd'], 'remade as': ['remake_of', 'back'],
  'homage to': ['homage_to', 'fwd'], 'echoed by': ['homage_to', 'back'],
  'kindred': ['kindred', 'sym'], 'counterpart': ['counterpart', 'sym'],
});

/** Source code → source_dataset, licence and attribution of the documented record. */
export const SOURCES = Object.freeze({
  w: { dataset: 'wikipedia', label: 'Wikipedia', license: 'CC BY-SA', attribution: 'Wikipedia contributors (CC BY-SA)' },
  d: { dataset: 'wikidata', label: 'Wikidata', license: 'CC0', attribution: 'Wikidata (CC0)' },
  m: { dataset: 'musicbrainz', label: 'MusicBrainz', license: 'CC0', attribution: 'MusicBrainz (CC0)' },
  i: { dataset: 'itwofs', label: 'ItwoFS', license: 'CC BY 2.5', attribution: 'ItwoFS (itwofs.com), CC BY 2.5 — link back to the source page' },
});

export const KINDRED_METHOD = 'cipher-theme-cosine (build_culture.py): rarity-weighted theme cosine ≥ 0.42, capped 0.7, cross-culture';
export const COUNTERPART_METHOD = 'Cipher tagging pass or title match';
export const UNRECORDED_NOTE = 'Wikidata P144/P941/P4969, Wikipedia lead or remake/format table — source not recorded by Cipher';
const RAW_FILES = { w: 'relations_wiki.json', m: 'relations_mb.json', i: 'relations_itwofs.json' };

/**
 * Split `row:relation:strength[:source]` items separated by |. Unknown shapes are returned with ok=false.
 * @param {string} field
 * @returns {Array<{row: number, relation: string, strength: number|null, source: string|null, ok: boolean, raw: string}>}
 */
export function parseSiblings(field) {
  if (!field) return [];
  return field.split('|').filter(Boolean).map((raw) => {
    const p = raw.split(':');
    const row = Number(p[0]);
    const strength = p.length >= 3 ? Number(p[2]) : NaN;
    const source = p.length >= 4 && p[3] ? p[3] : null;
    const ok = (p.length === 3 || p.length === 4) && Number.isInteger(row) && row >= 0 && Number.isFinite(strength);
    return { row, relation: p[1] ?? '', strength: Number.isFinite(strength) ? strength : null, source, ok, raw };
  });
}

/**
 * Map one parsed item (on row `from`) to rel_type, direction, evidence_status and origin per the §6.6 table.
 * `taggedPair` is whether the pair appears in either work's tagging batch (only consulted for '-' items).
 * @param {{row: number, relation: string, source: string|null}} item
 * @param {{from: number, taggedPair?: boolean}} ctx
 * @returns {{rel_type: string, src: number, dst: number, directed: boolean, evidence_status: string, origin: string,
 *   source: string|null}|null} null for an unknown relation label
 */
export function mapSibling(item, { from, taggedPair = false }) {
  const m = RELATION_MAP[item.relation];
  if (!m) return null;
  const [rel_type, dir] = m;
  const directed = dir !== 'sym';
  // undirected pairs get a deterministic canonical order (higher row first) so both sides collapse
  const [src, dst] = dir === 'fwd' ? [from, item.row] : dir === 'back' ? [item.row, from]
    : [Math.max(from, item.row), Math.min(from, item.row)];
  const source = item.source && SOURCES[item.source] ? item.source : null;
  let evidence_status, origin;
  if (rel_type === 'kindred') [evidence_status, origin] = ['computed', 'algorithm'];
  else if (rel_type === 'counterpart') [evidence_status, origin] = ['proposed', 'machine_tagger'];
  else if (source) [evidence_status, origin] = ['documented', 'source_dataset'];
  else if (taggedPair) [evidence_status, origin] = ['proposed', 'machine_tagger'];
  else [evidence_status, origin] = ['documented', 'source_dataset'];
  return { rel_type, src, dst, directed, evidence_status, origin, source: rel_type === 'kindred' || rel_type === 'counterpart' ? null : source };
}

// ── raw relation files: locators ────────────────────────────────────────────────────────────────────

/**
 * Index the raw music relation files by (source, folded title) for the locator join.
 * Only keys present in `wanted` are kept (the 94k works need a few thousand of the 172k records).
 * @param {string} relationsDir
 * @param {Set<string>} wanted keys `${source}|${joinTitle(title)}`
 * @returns {{index: Map<string, Array<{rec: object, side: 'a'|'b'}>>, counts: Record<string, number>, missing: string[]}}
 */
export function loadRawRelations(relationsDir, wanted) {
  const index = new Map();
  const counts = {};
  const missing = [];
  for (const [code, file] of Object.entries(RAW_FILES)) {
    let list;
    try { list = JSON.parse(readFileSync(path.join(relationsDir, file), 'utf8')); } catch { missing.push(file); continue; }
    counts[file] = list.length;
    for (const rec of list) {
      for (const side of ['a', 'b']) {
        const e = rec[side];
        if (!e?.title) continue;
        const key = rawKeyOf(code, e);
        if (!wanted.has(key)) continue;
        const arr = index.get(key);
        if (arr) arr.push({ rec, side }); else index.set(key, [{ rec, side }]);
      }
    }
  }
  return { index, counts, missing };
}

/**
 * A title as the raw files and culture-works compare (build_songs.py norm()): no "(…)", "[…]" or
 * "feat. …" tail, then folded.
 */
export function joinTitle(title) {
  return fold(String(title ?? '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s(?:feat\.?|ft\.|featuring)\s.*$/i, ' '));
}

const ARTIST_SPLIT = /\s*(?:,|;|&|\+|\/|\bfeat\.?|\bft\.|\bfeaturing\b|\bwith\b|\band\b|\by\b|\bet\b|\bx\b)\s*/i;

/** Every credited artist, folded ("Beyoncé, Jay-Z" / "Beyoncé feat. Jay-Z" → {beyoncé, jay z}). */
export function joinArtists(artist) {
  return new Set(String(artist ?? '').split(ARTIST_SPLIT).map((p) => fold(p)).filter(Boolean));
}

/** The work's join key in the raw files: source + folded title (artists are compared after the lookup). */
export const rawKey = (code, work) => `${code}|${joinTitle(work.title)}`;
const rawKeyOf = (code, e) => `${code}|${joinTitle(e.title)}`;
const shareArtist = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };

const yearsAgree = (a, b) => a === null || b === null || a === undefined || b === undefined || Math.abs(a - b) <= 1;

/**
 * A raw record's page turned into a locator URL: MusicBrainz and ItwoFS pages are URLs already; Wikipedia
 * pages are article titles, prefixed "fr:"/"es:" for those editions (fetch_samples.py).
 * @param {string} code
 * @param {string} page
 * @returns {string|null}
 */
export function pageLocator(code, page) {
  if (!page) return null;
  if (/^https?:\/\//.test(page)) return page;
  if (code !== 'w') return null;
  const m = /^(fr|es|en):(.+)$/.exec(page);
  const site = m ? m[1] : 'en';
  const title = (m ? m[2] : page).replace(/ /g, '_');
  return `https://${site}.wikipedia.org/wiki/${encodeURIComponent(title).replace(/%2F/g, '/').replace(/%3A/g, ':')}`;
}

/**
 * Find the raw record documenting a pair (folded title and a shared folded artist on both ends, years ±1
 * where both are known) and return its locator, or null.
 * @param {Map} index from loadRawRelations
 * @param {string} code w | m | i
 * @param {{title: string, maker: string, year: number|null}} a
 * @param {{title: string, maker: string, year: number|null}} b
 * @returns {string|null}
 */
export function findLocator(index, code, a, b) {
  const kb = rawKey(code, b);
  const artistsA = joinArtists(a.maker), artistsB = joinArtists(b.maker);
  for (const { rec, side } of index.get(rawKey(code, a)) ?? []) {
    const other = side === 'a' ? rec.b : rec.a;
    if (!other?.title || rawKeyOf(code, other) !== kb) continue;
    if (!shareArtist(artistsA, joinArtists(rec[side].artist)) || !shareArtist(artistsB, joinArtists(other.artist))) continue;
    if (!yearsAgree(rec[side].year, a.year) || !yearsAgree(other.year, b.year)) continue;
    const loc = pageLocator(code, rec.page);
    if (loc) return loc;
  }
  return null;
}

// ── tagging-batch pairs ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether work B is named among work A's tagging-batch siblings (folded title equal to B's title or native
 * title; year within ±2 where both are known — build_culture.py find()).
 */
function taggedNames(tagged, b) {
  if (!tagged) return false;
  const titles = new Set([fold(b.title), fold(b.native)].filter(Boolean));
  return tagged.siblings.some((s) => titles.has(s.title) && (s.year === null || b.year === null || Math.abs(s.year - b.year) <= 2));
}

// ── the whole mapping ───────────────────────────────────────────────────────────────────────────────

/**
 * Build the culture-works relationships.
 * @param {{rows: Array<{row: number, qid: string, title: string, native: string, maker: string, year: number|null,
 *   siblings: string}>, tagIndex: Map, relationsDir: string|null, kindredRunId: number|null, createdBy: string,
 *   collection: string}} input
 * @returns {{relationships: object[], stats: object}}
 */
export function buildSiblingRelationships({ rows, tagIndex, relationsDir, kindredRunId, createdBy, collection }) {
  const stats = { items: 0, unparsed: 0, unknown_relation: 0, bad_row: 0, self: 0, collapsed: 0,
    by_label: {}, expected: {}, locators: { matched: 0, unmatched: 0 }, raw_files: {} };
  const groups = new Map(); // key → { mapped, strength, items }
  for (const r of rows) {
    for (const item of parseSiblings(r.siblings)) {
      stats.items++;
      const label = `${item.relation} [${item.source ?? '-'}]`;
      stats.by_label[label] = (stats.by_label[label] ?? 0) + 1;
      if (!item.ok) { stats.unparsed++; continue; }
      if (!rows[item.row]) { stats.bad_row++; continue; }
      if (item.row === r.row) { stats.self++; continue; }
      const other = rows[item.row];
      const needsTagCheck = !item.source && RELATION_MAP[item.relation] && !['kindred', 'counterpart'].includes(RELATION_MAP[item.relation][0]);
      const taggedPair = needsTagCheck
        && (taggedNames(tagIndex.get(r.qid), other) || taggedNames(tagIndex.get(other.qid), r));
      const mapped = mapSibling(item, { from: r.row, taggedPair });
      if (!mapped) { stats.unknown_relation++; continue; }
      const key = `${mapped.rel_type}|${mapped.src}|${mapped.dst}|${mapped.source ?? '-'}`;
      const g = groups.get(key);
      if (g) {
        stats.collapsed++;
        g.strength = Math.max(g.strength, item.strength);
        g.labels.add(item.relation);
        // a '-' pair is machine-proposed if either side's batch names it
        if (mapped.evidence_status === 'proposed' && g.mapped.evidence_status === 'documented' && !mapped.source) g.mapped = mapped;
      } else {
        groups.set(key, { mapped, strength: item.strength, labels: new Set([item.relation]) });
      }
    }
  }

  // locator join for w/m/i
  let index = new Map();
  if (relationsDir) {
    const wanted = new Set();
    for (const { mapped } of groups.values()) {
      if (!RAW_FILES[mapped.source]) continue;
      wanted.add(rawKey(mapped.source, rows[mapped.src]));
      wanted.add(rawKey(mapped.source, rows[mapped.dst]));
    }
    const raw = loadRawRelations(relationsDir, wanted);
    index = raw.index;
    stats.raw_files = raw.counts;
    if (raw.missing.length) stats.raw_missing = raw.missing;
  }

  const relationships = [];
  for (const { mapped, strength, labels } of groups.values()) {
    const src = rows[mapped.src], dst = rows[mapped.dst];
    const rel = {
      src: { collection, ext_id: `cw:${mapped.src}` },
      dst: { collection, ext_id: `cw:${mapped.dst}` },
      rel_type: mapped.rel_type,
      evidence_status: mapped.evidence_status,
      origin: mapped.origin,
      created_by: createdBy,
      score: { value: strength, kind: 'heuristic_strength' },
      provenance_note: `Cipher ${[...labels].map((l) => `'${l}'`).join(' / ')}`,
    };
    if (mapped.rel_type === 'kindred') {
      rel.method = KINDRED_METHOD;
      rel.run_id = kindredRunId;
    } else if (mapped.rel_type === 'counterpart') {
      rel.method = COUNTERPART_METHOD;
    } else if (mapped.evidence_status === 'proposed') {
      rel.method = `${TAGGING_METHOD}; pair named in a tagging batch (title, year ±2)`;
    } else if (mapped.source) {
      const s = SOURCES[mapped.source];
      rel.source_dataset = s.dataset;
      rel.license = s.license;
      rel.attribution = s.attribution;
      rel.method = `${s.label} via Cipher ('${mapped.source}')`;
      const loc = RAW_FILES[mapped.source] ? findLocator(index, mapped.source, src, dst) ?? findLocator(index, mapped.source, dst, src) : null;
      if (loc) {
        rel.source_locator = loc;
        stats.locators.matched++;
      } else {
        rel.provenance_quality = 'source_unrecorded';
        if (RAW_FILES[mapped.source]) stats.locators.unmatched++;
        rel.provenance_note += mapped.source === 'd' ? '; Wikidata statement, item not recorded'
          : `; not found in ${RAW_FILES[mapped.source]}`;
      }
    } else {
      rel.source_dataset = 'wikidata-or-wikipedia';
      rel.provenance_quality = 'source_unrecorded';
      rel.provenance_note += `; ${UNRECORDED_NOTE}`;
    }
    if (!REL_TYPE_BY_CODE[rel.rel_type]) continue; // RELATION_MAP only names seeded rel_types
    const k = `${rel.rel_type}|${rel.evidence_status}`;
    stats.expected[k] = (stats.expected[k] ?? 0) + 1;
    relationships.push(rel);
  }
  stats.relationships = relationships.length;
  return { relationships, stats };
}
