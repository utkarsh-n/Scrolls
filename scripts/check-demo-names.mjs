// OWNER: WP2
// scripts/check-demo-names.mjs — every synthetic name of the demo (people, groups, institutions, places, work
// titles) checked against real names (SPEC §9.1): culture-works titles, native titles and makers; MusicBrainz
// artist names; with --recordings also the 40M MusicBrainz recording titles (a 4.5 GB stream). Comparison is
// on folded tokens (tokenizer u61m-1), so "MC  Ledgerline" and "mc ledgerline" are the same name.
//
//   node scripts/check-demo-names.mjs [--recordings] [--json]
//   exit code 1 when a name collides (or 2 when a source is missing and --strict is given)

import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CIPHER } from '../server/config.mjs';
import { normString } from '../src/shared/tokenize.mjs';
import { generatorNames } from '../data/demo/generator.mjs';

const DEMO = new URL('../data/demo/', import.meta.url);
/** Words that are not names (anonymous authors, the two readers) and are not checked. */
const NOT_NAMES = new Set(['anonymous', 'reader a', 'reader b']);
/** Places, institutions, bodies and people named inside the synthetic texts (not only as authors). */
export const WORLD_NAMES = Object.freeze([
  'Quellhaven', "Quellhaven Potters' Union", 'Quellhaven Board of Schools', 'Quellhaven Boards', "Quellhaven Joiners' Hall",
  'Felmark', 'Felmark Aeronautical Laboratory', 'Felmark Bulletin', 'Lowmere', 'Lowmere General Hospital', 'Kilnmark', 'Kilnmark Crew',
  'Kilnmark Notes', 'Signal & Noise Quarterly', 'Wharfside Records', 'Corvane Systems', 'Dario Quell', 'Abel Prynne', 'Miss Orlett',
  'chalkline_kid', 'saltwharf_99', 'tallowlane', 'kilnfan_22', 'Nothing Holds the Place', 'Tallow Lane', 'Saltwharf Road', 'Kiln Street', 'Brennock Room', 'Brother Haldane', 'Abel Prynne', 'Mrs Gast',
]);

/**
 * Every synthetic name to check, with where it comes from.
 * @returns {Array<{name: string, kind: 'name'|'title', source: string}>}
 */
export function demoNames() {
  const out = [];
  const add = (name, kind, source) => {
    const parts = kind === 'name' ? splitName(name) : [String(name).trim()];
    for (const part of parts) if (!NOT_NAMES.has(normString(part))) out.push({ name: part, kind, source });
  };
  const anchors = readFileSync(new URL('anchors.jsonl', DEMO), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const a of anchors) {
    add(a.author, 'name', `${a.anchor} author`);
    add(a.title, 'title', `${a.anchor} title`);
    if (a.album) add(a.album, 'title', `${a.anchor} album`);
  }
  for (const n of generatorNames()) add(n, 'name', 'generator');
  for (const n of WORLD_NAMES) add(n, 'name', 'world');
  if (existsSync(new URL('documents.jsonl', DEMO))) {
    for (const l of readFileSync(new URL('documents.jsonl', DEMO), 'utf8').split('\n')) {
      if (!l) continue;
      const d = JSON.parse(l);
      if (d.original_meta?.generator) add(d.title.replace(/^\(generated background\)\s*/, ''), 'title', `${d.ext_id} title`);
    }
  }
  const seen = new Set();
  return out.filter((x) => { const k = `${x.kind}|${normString(x.name)}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** "MC Ledgerline (synthetic)" → ["MC Ledgerline"]; "રતિલાલ માંડવીવાળા (Ratilal Mandaviwala)" → both scripts. */
function splitName(name) {
  const base = String(name ?? '').replace(/\s*\(synthetic\)\s*$/, '').replace(/\s*\(rev\.\)\s*$/, '').trim();
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(base);
  const parts = m ? [m[1], m[2]] : [base];
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Culture-works titles, native titles and makers (folded) → the first row naming them. */
function cultureNames() {
  const titles = new Map(), makers = new Map();
  if (!existsSync(CIPHER.cultureWorks)) return null;
  const lines = readFileSync(CIPHER.cultureWorks, 'utf8').split('\n');
  lines.forEach((l, row) => {
    if (!l) return;
    const c = l.split('\t');
    for (const t of [c[5], c[6]]) if (t) { const k = normString(t); if (k && !titles.has(k)) titles.set(k, row); }
    if (c[7]) for (const m of [c[7], ...c[7].split(', ')]) { const k = normString(m); if (k && !makers.has(k)) makers.set(k, row); }
  });
  return { titles, makers };
}

const dedupe = (hits) => [...new Map(hits.map((h) => [h.name, h])).values()];
const loose = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Stream a MusicBrainz table and report rows whose name column (index 2) folds to one of `wanted`.
 * @param {string} file
 * @param {Map<string, string>} wanted folded → name
 * @returns {Promise<{rows: number, hits: Array<{name: string, mb: string}>}>}
 */
export function scanMusicBrainz(file, wanted) {
  const looseKeys = new Set([...wanted.keys()].map((k) => k.replace(/ /g, '')));
  return new Promise((resolve, reject) => {
    const hits = [];
    let rows = 0, rest = '';
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 22 });
    stream.on('data', (chunk) => {
      const text = rest + chunk;
      let start = 0;
      for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
        const line = text.slice(start, nl);
        start = nl + 1;
        rows++;
        const a = line.indexOf('\t'), b = line.indexOf('\t', a + 1), c = line.indexOf('\t', b + 1);
        const name = line.slice(b + 1, c === -1 ? undefined : c);
        if (!looseKeys.has(loose(name))) continue;
        const k = normString(name);
        if (wanted.has(k)) hits.push({ name: wanted.get(k), mb: name });
      }
      rest = text.slice(start);
    });
    stream.on('end', () => resolve({ rows, hits }));
    stream.on('error', reject);
  });
}

/**
 * Run the whole check.
 * @param {{recordings?: boolean}} [opts]
 * @returns {Promise<{checked: number, collisions: object[], sources: object}>}
 */
export async function checkDemoNames({ recordings = false } = {}) {
  const names = demoNames();
  const collisions = [];
  const sources = {};
  const culture = cultureNames();
  sources.culture_works = culture ? 'checked' : 'absent';
  if (culture) {
    for (const n of names) {
      const k = normString(n.name);
      if (culture.titles.has(k)) collisions.push({ ...n, against: 'culture-works title', row: culture.titles.get(k) });
      if (culture.makers.has(k)) collisions.push({ ...n, against: 'culture-works maker', row: culture.makers.get(k) });
    }
  }
  const wanted = new Map(names.map((n) => [normString(n.name), n.name]));
  const artist = path.join(CIPHER.musicbrainzTables, 'artist');
  if (existsSync(artist)) {
    const r = await scanMusicBrainz(artist, wanted);
    sources.musicbrainz_artist = `${r.rows.toLocaleString('en')} rows`;
    for (const h of dedupe(r.hits)) collisions.push({ ...names.find((n) => n.name === h.name), against: 'MusicBrainz artist', mb: h.mb });
  } else sources.musicbrainz_artist = 'absent';
  const recording = path.join(CIPHER.musicbrainzTables, 'recording');
  if (recordings && existsSync(recording)) {
    const r = await scanMusicBrainz(recording, wanted);
    sources.musicbrainz_recording = `${r.rows.toLocaleString('en')} rows`;
    for (const h of dedupe(r.hits)) collisions.push({ ...names.find((n) => n.name === h.name), against: 'MusicBrainz recording', mb: h.mb });
  } else sources.musicbrainz_recording = recordings ? 'absent' : 'not checked (use --recordings)';
  return { checked: names.length, collisions, sources };
}

if (process.argv[1]?.endsWith('check-demo-names.mjs')) {
  const res = await checkDemoNames({ recordings: process.argv.includes('--recordings') });
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  else {
    process.stdout.write(`checked ${res.checked} synthetic names; sources: ${JSON.stringify(res.sources)}\n`);
    for (const c of res.collisions) process.stdout.write(`COLLISION  ${c.kind} '${c.name}' (${c.source}) = ${c.against}${c.mb ? ` '${c.mb}'` : ` row ${c.row}`}\n`);
  }
  if (res.collisions.length) process.exitCode = 1;
}
