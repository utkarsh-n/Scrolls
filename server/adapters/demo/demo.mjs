// OWNER: WP2
// demo.mjs — source adapter 'demo': data/demo/*.jsonl → corpus demo, collection demo-world (SPEC §9). Every
// row it leads to is is_synthetic=1 (DocumentWriter copies it from the synthetic corpus). The files are built
// by scripts/build-demo.mjs from the hand-written anchors and the seeded generator; this adapter only reads.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMUNITIES } from '../../../data/demo/generator.mjs';
import { lineRecords } from '../cipher/source.mjs';

export { COMMUNITIES };
export const id = 'demo';
export const version = '1.0.0';
export const label = 'Synthetic demonstration — carry the zero';
export const access = 'local-file';
export const license = 'CC0 (synthetic)';
export const attribution = 'Scrolls demo (synthetic)';
export const stagedDir = null;
export const COLLECTION = 'demo-world';
export const collections = [
  {
    slug: COLLECTION,
    name: 'Quellhaven (synthetic)',
    domain: 'demo',
    modality: 'text',
    unit: 'tokens',
    sampling: 'curated',
    rate_eligible: true,
    export_text_allowed: true,
    coverage_gate: 2000,
    selection_note: 'invented corpus; coverage gate 2,000 tokens (demo setting; real collections use 50,000)',
    caveats: [
      'Everything here is invented: people, texts, dates and links.',
      "No sources 1940–1949: the Quellhaven Board of Schools archive was 'lost in the 1951 flood' (synthetic).",
    ],
  },
];

const DIR = new URL('../../../data/demo/', import.meta.url);
const FILES = ['documents.jsonl', 'relationships.jsonl', 'annotations.jsonl', 'tour.json'];
const path = (name) => fileURLToPath(new URL(name, DIR));

/**
 * Lines of a data/demo JSONL file.
 * @param {string} name
 * @returns {object[]}
 */
export function readDemo(name) {
  return readFileSync(new URL(name, DIR), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** @returns {string[]} */
export function sourceFiles() {
  return FILES.filter((f) => f.endsWith('.jsonl')).map(path);
}

/** @returns {Promise<object>} ProbeResult */
export async function probe() {
  const missing = FILES.filter((f) => !existsSync(path(f)));
  if (missing.length) {
    return { available: false, reason: `missing ${missing.join(', ')} (run npm run build:demo)`, manifest_ok: false,
      format_ok: false, counts: {}, caveats: [] };
  }
  return { available: true, manifest_ok: true, format_ok: true, caveats: [],
    counts: { documents: readDemo('documents.jsonl').length, relationships: readDemo('relationships.jsonl').length,
      annotations: readDemo('annotations.jsonl').filter((a) => !a.deferred).length } };
}

/** @returns {Promise<{units: number}>} */
export async function plan() {
  return { units: readDemo('documents.jsonl').length };
}

/**
 * CanonicalDocument records (already canonical: built by scripts/build-demo.mjs), each pointing at its line in the kept
 * copy of documents.jsonl (source_file, D18 provenance chain; fix pass: the pointer was missing).
 */
export async function* documents(params = {}, ctx = {}) {
  const sha = ctx.keepOriginal?.(path('documents.jsonl')) ?? null;
  for (const rec of lineRecords(readFileSync(new URL('documents.jsonl', DIR)))) {
    if (!rec.text.trim()) continue;
    const doc = JSON.parse(rec.text);
    yield sha ? { ...doc, source_file: { sha256: sha, byte_start: rec.byteStart, byte_end: rec.byteEnd } } : doc;
  }
}

/** Authored relationships of the synthetic world (reviews are applied after loading, by demo-load). */
export async function* relationships(params = {}, ctx = {}) {
  ctx.keepOriginal?.(path('relationships.jsonl'));
  for (const { key, review, ...rel } of readDemo('relationships.jsonl')) yield rel;
}

/** Authored annotations (revisions and deferred items are applied by demo-load). */
export async function* annotations(params = {}, ctx = {}) {
  ctx.keepOriginal?.(path('annotations.jsonl'));
  for (const a of readDemo('annotations.jsonl')) {
    if (a.deferred) continue;
    const { revisions, ...ann } = a;
    yield ann;
  }
}

/** The guided tour as stored (ids are resolved by routes/tour.mjs). @returns {object} */
export function readTour() {
  return JSON.parse(readFileSync(new URL('tour.json', DIR), 'utf8'));
}
