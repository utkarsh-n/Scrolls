// OWNER: WP2
// relations.mjs — source adapter 'cipher.relations': the documented music genealogy beyond the 94k culture works
// (SPEC §6.6). songs/relations_{mb,wiki,itwofs}.json (161,803 + 9,581 + 428 records) → one document per
// relation endpoint in `cipher-music-relations` (relation_endpoints, rate_eligible 0), keyed by its MusicBrainz
// recording (`mb:<uuid>`), its Wikidata item (`wd:Q…`) or `t:<fold(title)>|<fold(artist)>|<year>`. An endpoint that
// is a culture work (same Wikidata item, or folded title + a shared artist with years ±1) is not duplicated: the
// work gets the endpoint key as an alias. Every relationship is documented by its source record (`page`).
// A relation the culture-works siblings already state (same type, ends and source) is not repeated: it gains an
// `external_record` evidence row instead (applied by tasks/bootstrap-cipher.mjs after the batch).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fromInterval } from '../../../src/shared/dates.mjs';
import { CIPHER } from '../../config.mjs';
import { joinArtists, joinTitle, mapSibling, pageLocator, SOURCES } from './siblings.mjs';
import { assertedBy, exists, fold, readSource, unknownDate } from './source.mjs';

export const id = 'cipher.relations';
export const version = '1.0.0';
export const label = 'Cipher music relations (genealogy)';
export const access = 'local-dataset';
export const license = 'MusicBrainz CC0; Wikipedia CC BY-SA; ItwoFS CC BY 2.5 (link-back required)';
export const attribution = 'MusicBrainz; Wikipedia; ItwoFS';
export const stagedDir = null;
export const COLLECTION = 'cipher-music-relations';
export const collections = [
  {
    slug: COLLECTION,
    name: 'Music relations: endpoints (Cipher)',
    domain: 'culture',
    modality: 'titles',
    unit: 'works',
    sampling: 'relation_endpoints',
    rate_eligible: false,
    export_text_allowed: true,
    coverage_gate: null,
    selection_note: 'works that appear in documented sample/cover/version links',
    caveats: [
      'Selected because they appear in a documented link: never a sample of music in general, so no rates.',
      'Absence of a link is not evidence of no sampling.',
    ],
  },
];
export const FILES = Object.freeze({ m: 'relations_mb.json', w: 'relations_wiki.json', i: 'relations_itwofs.json' });
const YEAR_NOTE = 'year as recorded by Cipher from MusicBrainz/Wikipedia; may be a first-release year';
const WORKS = 'cipher-culture-works';

/** @returns {string[]} */
export function sourceFiles() {
  return Object.values(FILES).map((f) => path.join(CIPHER.relationsDir, f));
}

/** The document key of a relation endpoint. */
export function endpointKey(e) {
  if (typeof e.qid === 'string' && e.qid.startsWith('mb:')) return e.qid;
  if (typeof e.qid === 'string' && /^Q\d+$/.test(e.qid)) return `wd:${e.qid}`;
  return `t:${fold(e.title)}|${fold(e.artist)}|${Number.isInteger(e.year) ? e.year : ''}`;
}

/**
 * Whether a raw record states a link at all (fix pass, §13 rules 5–6). Cipher's scraper labels every ItwoFS row
 * 'inspired by', including the site's coincidence page, which lists songs that sound alike by coincidence: its 8 rows
 * (the only ones Cipher weighs 0.4) state a resemblance, not an inspiration, so they are left out and counted.
 * @param {string} code source code ('m' | 'w' | 'i')
 * @param {{page?: string}} rec
 * @returns {boolean}
 */
export function statesLink(code, rec) {
  return !(code === 'i' && /\/coincidence\.html$/i.test(String(rec?.page ?? '')));
}

let model = null;

/**
 * Parse the raw files and decide every endpoint: a culture work (alias) or its own document.
 * @param {{works?: Array<object>}} [opts] culture-works rows (from works.mjs loadWorks) for the alias match
 * @returns {{records: Array<{code: string, rec: object}>, endpoints: Map<string, object>, counts: object}}
 */
export function loadRelations({ works = null } = {}) {
  if (model && model.works === works) return model;
  const records = [];
  const counts = { records: {}, endpoints: 0, aliased: 0, documents: 0, ambiguous: 0, left_out: 0 };
  for (const [code, file] of Object.entries(FILES)) {
    const f = path.join(CIPHER.relationsDir, file);
    if (!exists(f)) { counts.records[file] = 'absent'; continue; }
    const list = JSON.parse(readSource(f, { cache: false }).bytes.toString('utf8'));
    counts.records[file] = list.length;
    for (const rec of list) {
      if (statesLink(code, rec)) records.push({ code, rec });
      else counts.left_out++;
    }
  }
  // culture works by Wikidata item and by folded title
  const byQid = new Map(), byTitle = new Map();
  for (const w of works ?? []) {
    if (w.qid) byQid.set(w.qid, w);
    const k = joinTitle(w.title);
    if (!k) continue;
    const l = byTitle.get(k);
    if (l) l.push(w); else byTitle.set(k, [w]);
  }
  const endpoints = new Map();
  for (const { rec } of records) {
    for (const side of ['a', 'b']) {
      const e = rec[side];
      if (!e?.title) continue;
      const key = endpointKey(e);
      if (endpoints.has(key)) continue;
      let work = null;
      if (typeof e.qid === 'string' && byQid.has(e.qid)) work = byQid.get(e.qid);
      else {
        const artists = joinArtists(e.artist);
        const hits = (byTitle.get(joinTitle(e.title)) ?? []).filter((w) => {
          const wa = joinArtists(w.maker);
          let shared = false;
          for (const a of artists) if (wa.has(a)) { shared = true; break; }
          return shared && (w.year === null || !Number.isInteger(e.year) || Math.abs(w.year - e.year) <= 1);
        });
        if (hits.length === 1) work = hits[0];
        else if (hits.length > 1) counts.ambiguous++;
      }
      endpoints.set(key, { key, e, work });
      if (work) counts.aliased++; else counts.documents++;
    }
  }
  counts.endpoints = endpoints.size;
  model = { works, records, endpoints, counts };
  return model;
}

/** Forget the parsed files. */
export function clearCache() {
  model = null;
}

async function worksRows() {
  const { loadWorks } = await import('./works.mjs');
  return exists(CIPHER.cultureWorks) ? loadWorks().rows : [];
}

/** @returns {Promise<object>} ProbeResult */
export async function probe() {
  const missing = Object.values(FILES).filter((f) => !exists(path.join(CIPHER.relationsDir, f)));
  if (missing.length === 3) {
    return { available: false, reason: `no raw relation files in ${CIPHER.relationsDir}`, manifest_ok: false, format_ok: false, counts: {}, caveats: [] };
  }
  const m = loadRelations({ works: await worksRows() });
  return { available: true, manifest_ok: true, format_ok: true, counts: { ...m.counts, records: undefined, ...m.counts.records },
    caveats: [...(missing.length ? [`not found: ${missing.join(', ')}`] : []),
      ...(m.counts.left_out ? [`${m.counts.left_out} ItwoFS rows of its coincidence page left out: they state a resemblance, not an inspiration`] : [])] };
}

/** @returns {Promise<{units: number}>} */
export async function plan() {
  return { units: loadRelations({ works: await worksRows() }).counts.documents };
}

/**
 * One metadata document per endpoint that is not a culture work.
 * @param {{skip?: Iterable<string>}} params ext_ids already loaded (a resumed bootstrap)
 * @param {object} ctx AdapterCtx (+ keepOriginal)
 */
export async function* documents(params = {}, ctx = {}) {
  const m = loadRelations({ works: await worksRows() });
  for (const f of sourceFiles()) if (exists(f)) ctx.keepOriginal?.(f);
  const skip = new Set(params.skip ?? []);
  const by = assertedBy({ id, version });
  const thisYear = new Date().getUTCFullYear();
  for (const ep of m.endpoints.values()) {
    if (ep.work || skip.has(ep.key)) continue;
    const e = ep.e;
    const y = Number.isInteger(e.year) ? e.year : null;
    const date = y === null
      ? { role: 'release', parsed: unknownDate('cipher.relations.year'), asserted_by: by, is_chronology: true, note: 'no year in the relation record' }
      : y <= thisYear
        ? { role: 'release', parsed: fromInterval(y, y, { precision: 'year', basis: 'stated', rule: 'cipher.relations.year', raw: String(y) }),
          asserted_by: by, is_chronology: true, note: YEAR_NOTE }
        : { role: 'release', raw: String(y), asserted_by: by, is_chronology: true, note: YEAR_NOTE };
    yield {
      ext_id: ep.key,
      kind: 'song',
      title: e.title,
      author: e.artist || null,
      culture: e.culture || null,
      source_url: ep.key.startsWith('mb:') ? `https://musicbrainz.org/recording/${ep.key.slice(3)}` : null,
      fields: { title: e.title },
      dates: [date],
      ...(e.qid && /^Q\d+$/.test(e.qid) ? { aliases: [{ ext_id: e.qid, note: 'Wikidata item' }] } : {}),
      original_meta: { source: 'songs/relations_*.json endpoint', endpoint: e },
    };
  }
}

/** Aliases for endpoints that are culture works: [{work ext_id, alias}] (the loader calls writer.addAlias). */
export async function endpointAliases() {
  const m = loadRelations({ works: await worksRows() });
  const out = [];
  for (const ep of m.endpoints.values()) {
    if (ep.work) out.push({ target: { collection: WORKS, ext_id: `cw:${ep.work.row}` }, alias: { ext_id: ep.key, title: ep.e.title, note: 'relation endpoint (MusicBrainz/Wikipedia/ItwoFS)' } });
  }
  return out;
}

/**
 * Relationships, one per record: documented by the record's page. Records whose relation the culture-works
 * siblings already state are returned separately in `params.merged` (an array the caller passes in).
 * @param {{merged?: object[], siblingKeys?: Set<string>}} params siblingKeys: `${rel_type}|cw:src|cw:dst|${source}`
 */
export async function* relationships(params = {}) {
  const m = loadRelations({ works: await worksRows() });
  const by = assertedBy({ id, version });
  const seen = new Set();
  for (const { code, rec } of m.records) {
    const a = m.endpoints.get(endpointKey(rec.a)), b = m.endpoints.get(endpointKey(rec.b));
    if (!a || !b || a.key === b.key) continue;
    const mapped = mapSibling({ row: 1, relation: rec.forward, source: code }, { from: 0 });
    if (!mapped) continue;
    const [src, dst] = mapped.src === 0 ? [a, b] : [b, a];
    const end = (ep) => (ep.work ? { collection: WORKS, ext_id: `cw:${ep.work.row}` } : { collection: COLLECTION, ext_id: ep.key });
    const locator = pageLocator(code, rec.page);
    if (src.work && dst.work && params.siblingKeys?.has(`${mapped.rel_type}|cw:${src.work.row}|cw:${dst.work.row}|${code}`)) {
      params.merged?.push({ rel_type: mapped.rel_type, src: end(src), dst: end(dst), source: code, locator, page: rec.page,
        file: FILES[code] });
      continue;
    }
    const dedupe = `${mapped.rel_type}|${src.key}|${dst.key}|${code}`;
    if (seen.has(dedupe)) continue; // the same record listed twice in a raw file
    seen.add(dedupe);
    const s = SOURCES[code];
    yield {
      src: end(src), dst: end(dst), rel_type: mapped.rel_type, evidence_status: 'documented', origin: 'source_dataset',
      source_dataset: s.dataset, ...(locator ? { source_locator: locator } : { provenance_quality: 'source_unrecorded' }),
      method: `${s.label} relation record (${FILES[code]})`, created_by: by, license: s.license, attribution: s.attribution,
      score: Number.isFinite(rec.strength) ? { value: rec.strength, kind: 'heuristic_strength' } : null,
      provenance_note: `Cipher raw relation '${rec.forward}'`,
    };
  }
}
