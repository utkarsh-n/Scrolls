// OWNER: WP2
// scripts/build-demo.mjs — `npm run build:demo`: regenerate data/demo/documents.jsonl, relationships.jsonl and
// annotations.jsonl from the hand-authored anchors (data/demo/anchors.jsonl) and the seeded generator
// (SPEC §9). Everything it writes is SYNTHETIC. It refuses to write when a calibration number of §9.5/§9.6
// or a lineage guard fails, so a bad edit cannot ship a demo whose tour tells something untrue.
//
//   node scripts/build-demo.mjs [--check]     --check: verify only, write nothing

import { readFileSync, writeFileSync } from 'node:fs';
import { parseDate } from '../src/shared/dates.mjs';
import { tokenize } from '../src/shared/tokenize.mjs';
import { COMMUNITIES, findOccurrences, generate, GENERATOR_TAG, NO_SOURCE_DECADE } from '../data/demo/generator.mjs';

const DIR = new URL('../data/demo/', import.meta.url);
export const DEMO_NOW = new Date('2026-10-04T12:00:00Z'); // dates are parsed against a fixed "now": the 2027 reissue stays announced
export const SEED = 1994;
const BY = 'adapter:demo@1.0.0';
const COLL = 'demo-world';
const READER_A = 'Reader A (synthetic)';
const READER_B = 'Reader B (synthetic)';

const readJsonl = (name) => readFileSync(new URL(name, DIR), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ── documents ───────────────────────────────────────────────────────────────────────────────────────

/** The original text of an anchor/generated record: paragraphs (verse stanzas keep their line breaks). */
export const textOf = (rec) => rec.paragraphs.join('\n\n');

function parsed(raw) {
  const p = parseDate(raw, { now: DEMO_NOW });
  if (p.issue) throw new Error(`build-demo: date '${raw}': ${p.issue.message}`);
  return p;
}

/** Anchor or generated record → CanonicalDocument (all synthetic). */
export function toCanonical(rec) {
  const original = textOf(rec);
  const p = parsed(rec.date.raw);
  const dates = [{ role: 'publication', raw: rec.date.raw, parsed: p, asserted_by: BY, is_chronology: true,
    note: 'date in the synthetic demo world' }];
  for (const r of rec.referenced ?? []) {
    dates.push({ role: 'referenced', raw: r.raw, parsed: parsed(r.raw), asserted_by: BY, is_chronology: false, note: r.note });
  }
  return {
    ext_id: rec.ext_id,
    kind: rec.kind,
    title: rec.title,
    author: rec.author,
    community: rec.community,
    lang_declared: rec.lang ?? 'en',
    license: 'CC0 (synthetic)',
    text: { original, decoder: 'utf-8', mode: rec.mode === 'verse' ? 'verse' : 'prose' },
    dates,
    original_meta: {
      synthetic: true,
      ...(rec.anchor ? { anchor: rec.anchor } : { generator: rec.meta?.generator ?? GENERATOR_TAG(SEED), cell: rec.meta?.cell ?? null }),
      ...(rec.album ? { album: rec.album } : {}),
      planted: rec.planted ?? {},
      senses: rec.senses ?? {},
    },
  };
}

// ── checks ──────────────────────────────────────────────────────────────────────────────────────────

const EXPRS = ['carry the zero', 'flux up', 'ghost in the margin', '◉', 'શૂન્ય ઉપાડ', 'शून्य को साथ'];

/** Calibration of §9.5/§9.6 as numbers over the built records. */
export function calibrate(records) {
  const stats = {};
  for (const e of EXPRS) stats[e] = { n: 0, docs: 0, authors: new Set(), senses: {}, anchors: 0, generated: 0 };
  const errors = [];
  for (const r of records) {
    const text = textOf(r);
    for (const e of EXPRS) {
      const n = findOccurrences(text, e).length;
      const planted = r.planted?.[e] ?? 0;
      if (n !== planted) errors.push(`${r.ext_id}: '${e}' occurs ${n}×, planted ${planted}×`);
      if (!n) continue;
      const s = stats[e];
      s.n += n; s.docs++; s.authors.add(r.author);
      if (r.anchor) s.anchors += n; else s.generated += n;
      const sense = r.senses?.[e] ?? '?';
      const ss = s.senses[sense] ??= { n: 0, docs: 0, authors: new Set() };
      ss.n += n; ss.docs++; ss.authors.add(r.author);
    }
  }
  const plain = JSON.parse(JSON.stringify(stats, (k, v) => (v instanceof Set ? v.size : v)));
  return { stats: plain, errors };
}

const EXPECT = [
  ['carry the zero total n = 340', (s) => s['carry the zero'].n === 340],
  ['carry the zero in ≥ 90 documents', (s) => s['carry the zero'].docs >= 90],
  ['carry the zero · place value 90 / 24 / 12', (s) => sense(s, 'carry the zero', 'place', 90, 24, 12)],
  ['carry the zero · bureaucratic irony 70 / 18 / 9', (s) => sense(s, 'carry the zero', 'irony', 70, 18, 9)],
  ['carry the zero · honoring the uncounted 110 / 30 / 16', (s) => sense(s, 'carry the zero', 'honor', 110, 30, 16)],
  ['carry the zero · null placeholder 70 / 20 / 11', (s) => sense(s, 'carry the zero', 'null', 70, 20, 11)],
  ['flux up: 120 generated + 5 anchors', (s) => s['flux up'].generated === 120 && s['flux up'].anchors === 5],
  ['ghost in the margin: 90 generated + 4 anchors', (s) => s['ghost in the margin'].generated === 90 && s['ghost in the margin'].anchors === 4],
  ['◉: 26 in 9 documents by 7 authors', (s) => s['◉'].n === 26 && s['◉'].docs === 9 && s['◉'].authors === 7],
  ['gu forms: 14 / 6 / 4', (s) => s['શૂન્ય ઉપાડ'].n === 14 && s['શૂન્ય ઉપાડ'].docs === 6 && s['શૂન્ય ઉપાડ'].authors === 4],
  ['hi forms: 8 / 4 / 3', (s) => s['शून्य को साथ'].n === 8 && s['शून्य को साथ'].docs === 4 && s['शून्य को साथ'].authors === 3],
];
function sense(s, e, name, n, docs, authors) {
  const x = s[e].senses[name];
  return Boolean(x) && x.n === n && x.docs === docs && x.authors === authors;
}

/** Shared runs of ≥ 13 folded tokens between documents (only the planted A11↔A4 and A20↔A3 may exist). */
export function sharedRuns(docs, k = 13) {
  const seen = new Map();
  const pairs = new Map();
  for (const d of docs) {
    const t = tokenize(d.text.original).tokens;
    const mine = new Set();
    for (let i = 0; i + k <= t.length; i++) {
      const g = t.slice(i, i + k).join(' ');
      if (mine.has(g)) continue;
      mine.add(g);
      const other = seen.get(g);
      if (other && other !== d.ext_id) {
        const key = [other, d.ext_id].sort().join(' ↔ ');
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      } else if (!other) seen.set(g, d.ext_id);
    }
  }
  return pairs;
}
const PLANTED_RUNS = new Set(['demo:A11 ↔ demo:A4', 'demo:A20 ↔ demo:A3']);

/**
 * Sentences (verse lines in verse documents) of ≥ 6 tokens whose word-3-shingle Jaccard with a sentence of
 * another document is ≥ 0.5 — what the near-quotation detector (§4.7) would verify as a near quotation.
 * @returns {Array<{a: string, b: string, jaccard: number, text: string}>}
 */
export function nearDuplicateSentences(docs) {
  const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
  const units = [];
  for (const d of docs) {
    const parts = d.text.mode === 'verse' ? d.text.original.split('\n') : [...seg.segment(d.text.original)].map((x) => x.segment);
    for (const p of parts) {
      const t = tokenize(p).tokens;
      if (t.length < 6) continue;
      const sh = new Set();
      for (let i = 0; i + 3 <= t.length; i++) sh.add(`${t[i]} ${t[i + 1]} ${t[i + 2]}`);
      units.push({ doc: d.ext_id, sh, text: p.trim() });
    }
  }
  const index = new Map();
  units.forEach((u, i) => { for (const s of u.sh) { const l = index.get(s); if (l) l.push(i); else index.set(s, [i]); } });
  const out = [];
  units.forEach((u, i) => {
    const shared = new Map();
    for (const s of u.sh) for (const j of index.get(s)) if (j > i && units[j].doc !== u.doc) shared.set(j, (shared.get(j) ?? 0) + 1);
    for (const [j, n] of shared) {
      const jac = n / (u.sh.size + units[j].sh.size - n);
      if (jac >= 0.5) out.push({ a: u.doc, b: units[j].doc, jaccard: Number(jac.toFixed(2)), text: u.text });
    }
  });
  return out;
}

function structuralChecks(docs) {
  const errors = [];
  for (const d of docs) {
    const p = d.dates[0].parsed;
    if (p.lo_year !== null && (Math.floor(p.lo_year / 10) * 10 === NO_SOURCE_DECADE || Math.floor(p.hi_year / 10) * 10 === NO_SOURCE_DECADE)) {
      errors.push(`${d.ext_id} is dated in the 1940s (the no-sources gap)`);
    }
    if (p.basis === 'announced' && d.ext_id !== 'demo:A31') errors.push(`${d.ext_id} is dated after the demo's today (${d.dates[0].raw})`);
    if (!d.author.endsWith('(synthetic)')) errors.push(`${d.ext_id}: author '${d.author}' lacks the (synthetic) suffix`);
    if (!COMMUNITIES[d.community]) errors.push(`${d.ext_id}: unknown community '${d.community}'`);
  }
  const hh = docs.filter((d) => d.community === 'hiphop' && d.dates[0].parsed.lo_year >= 1984 && d.dates[0].parsed.hi_year <= 1993);
  if (hh.length !== 12) errors.push(`Hip-hop 1984–1993 has ${hh.length} documents (12 expected)`);
  if (hh.some((d) => findOccurrences(d.text.original, 'carry the zero').length)) errors.push('Hip-hop 1984–1993 contains carry the zero');
  for (const [pair, n] of sharedRuns(docs)) if (!PLANTED_RUNS.has(pair)) errors.push(`unplanned shared 13-token run(s) ${pair} (${n})`);
  for (const pair of PLANTED_RUNS) if (!sharedRuns(docs).has(pair)) errors.push(`planted run ${pair} is missing`);
  const planted = new Set(['demo:A11|demo:A4', 'demo:A4|demo:A11', 'demo:A20|demo:A3', 'demo:A3|demo:A20', 'demo:A11|demo:A9', 'demo:A9|demo:A11',
    'demo:A9|demo:A4', 'demo:A4|demo:A9']);
  for (const n of nearDuplicateSentences(docs)) {
    if (!planted.has(`${n.a}|${n.b}`)) errors.push(`near-duplicate sentence ${n.a} ↔ ${n.b} (Jaccard ${n.jaccard}): ${n.text.slice(0, 80)}`);
  }
  return errors;
}

// ── relationships and annotations (authored records of the synthetic world) ─────────────────────────

function spanOf(doc, quote, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = doc.text.original.indexOf(quote, at + 1);
  if (at < 0) throw new Error(`build-demo: quote not found in ${doc.ext_id}: ${quote}`);
  return { field: 'body', start: at, end: at + quote.length, quote };
}
function firstOcc(doc, expr) {
  const o = findOccurrences(doc.text.original, expr)[0];
  if (!o) throw new Error(`build-demo: no '${expr}' in ${doc.ext_id}`);
  return { field: 'body', start: o.start, end: o.end, quote: doc.text.original.slice(o.start, o.end) };
}
const end = (anchor) => ({ collection: COLL, ext_id: `demo:${anchor}` });

function documented(key, rel_type, src, dst, locator, evidence, note) {
  return { key, src: end(src), dst: end(dst), rel_type, evidence_status: 'documented', origin: 'source_dataset',
    source_dataset: 'demo-records', source_locator: `demo-records:${locator}`, created_by: BY,
    provenance_note: `${note} (synthetic record)`, evidence };
}

export function buildRelationships(byExt) {
  const d = (a) => byExt.get(`demo:${a}`);
  const ev = (a, quote, role = 'external_record') => ({ role, ext_id: `demo:${a}`, ...spanOf(d(a), quote) });
  const rels = [
    documented('liner-citation', 'explicit_citation', 'A15', 'A4', 'liner-notes/nothing-holds-the-place/track-3',
      [ev('A15', "for Mrs Brennock's book")], 'liner notes of Nothing Holds the Place name the source'),
    documented('liner-sample', 'samples', 'A15', 'A9', 'liner-notes/nothing-holds-the-place/track-3#samples',
      [ev('A15', 'Contains a sample of Counting Lesson No. 4')], 'sample clearance listed in the liner notes'),
    documented('essay-reframes', 'reframes', 'A24', 'A4', 'essays/ledgers-of-the-uncounted#p2',
      [ev('A24', "After Ledgerline, Brennock's primer reads as a lesson about who gets counted.")], 'the essay states the rereading'),
    documented('essay-cites-wrexley', 'explicit_citation', 'A24', 'A3', 'essays/ledgers-of-the-uncounted#works-cited',
      [ev('A24', 'Wrexley, T., The Ledger House (1903)')], 'works cited'),
    documented('essay-cites-brennock', 'explicit_citation', 'A24', 'A4', 'essays/ledgers-of-the-uncounted#works-cited',
      [ev('A24', "Brennock, A., Brennock's Ready Arithmetic (1911)")], 'works cited'),
    documented('essay-cites-ledgerline', 'explicit_citation', 'A24', 'A15', 'essays/ledgers-of-the-uncounted#works-cited',
      [ev('A24', 'MC Ledgerline, Zero Holds the Place (1994)')], 'works cited'),
    documented('manual-cites-potters', 'explicit_citation', 'A8', 'A1', 'manuals/field-manual-wireless#bibliography',
      [ev('A8', "Quellhaven Potters' Union, On Marks (c. 1894)")], 'bibliography of the field manual'),
    documented('interview-answers-review', 'answer_to', 'A17', 'A16', 'interviews/ledgerline-1995-04',
      [ev('A17', "It's a thank-you note, not a sneer.")], 'the interview answers the review by name'),
    { key: 'kiln-allusion', src: end('A22'), dst: end('A14'), rel_type: 'proposed_allusion', evidence_status: 'proposed', origin: 'human',
      created_by: `human:${READER_A}`, provenance_note: 'proposed by a reader of the synthetic demo',
      evidence: [ev('A22', 'The ◉ sticker means sterilized, through the fire', 'supporting'),
        ev('A14', "the ◉ kiln eye on the wall means we've been through the fire", 'supporting')],
      review: [{ action: 'reject', actor: `human:${READER_B}`, reason: 'hospital usage comes from autoclave tape; no link to graffiti' }] },
    { key: 'vyas-from-ledgerline', src: end('A25'), dst: end('A15'), rel_type: 'proposed_allusion', evidence_status: 'proposed', origin: 'human',
      created_by: `human:${READER_A}`, hypothesis_group: { key: 'vyas', question: "Is Vyas 2017 from Ledgerline 1994 or from Mandaviwala's primer (VS 1987)?" },
      evidence: [ev('A25', 'શૂન્ય ઉપાડી ચાલ', 'supporting'), ev('A15', 'carry the zero, carry the block', 'supporting')] },
    { key: 'vyas-from-mandaviwala', src: end('A25'), dst: end('A6'), rel_type: 'proposed_allusion', evidence_status: 'proposed', origin: 'human',
      created_by: `human:${READER_A}`, hypothesis_group: { key: 'vyas', question: "Is Vyas 2017 from Ledgerline 1994 or from Mandaviwala's primer (VS 1987)?" },
      evidence: [ev('A25', 'શૂન્ય ઉપાડી ચાલ', 'supporting'), ev('A6', 'શૂન્ય ઉપાડો, બાળકો', 'supporting')] },
  ];
  return rels;
}

/** The 18 pragmatic_function labels, the two readings of A15, Reader B on A4, Reader A's hypothesis, deferred items. */
export function buildAnnotations(byExt, generated) {
  const d = (a) => byExt.get(`demo:${a}`);
  const yearOf = (doc) => doc.dates[0].parsed.lo_year;
  const pick = (cell, lo, hi, n) => generated.filter((g) => g.original_meta.cell === cell && yearOf(g) >= lo && yearOf(g) <= hi)
    .sort((a, b) => yearOf(a) - yearOf(b) || a.ext_id.localeCompare(b.ext_id)).slice(0, n);
  const label = (doc, reader, value, quoteAnchor = null) => {
    const anchor = quoteAnchor ?? firstOcc(doc, 'carry the zero');
    return { target: { type: 'passage', ext_id: doc.ext_id }, anchor, kind: 'label', author: reader, is_machine: false,
      layer: reader === READER_A ? 'Reading A' : 'Reading B', body_md: `pragmatic function: ${value}`,
      dimensions: { pragmatic_function: value }, tags: [],
      stance: null };
  };
  const out = [];
  // 1911 sincere ×2
  out.push(label(d('A4'), READER_A, 'sincere'), label(d('A4'), READER_B, 'sincere'));
  // 1958–1963 ironic ×6
  out.push(label(d('A10'), READER_A, 'ironic', spanOf(d('A10'), 'carrying zeros for the auditors')), label(d('A11'), READER_B, 'ironic'));
  const irony = pick('irony', 1958, 1963, 4);
  const ironyMore = irony.length < 4 ? pick('irony', 1955, 1966, 4) : irony;
  ironyMore.slice(0, 4).forEach((g, i) => out.push(label(g, i % 2 ? READER_B : READER_A, 'ironic')));
  // 1994–2003 reclaimed ×4, ironic ×2
  out.push(label(d('A15'), READER_B, 'reclaimed'), label(d('A19'), READER_B, 'reclaimed'));
  pick('honor', 1994, 2003, 2).forEach((g, i) => out.push(label(g, i ? READER_B : READER_A, 'reclaimed')));
  out.push(label(d('A15'), READER_A, 'ironic'), label(d('A16'), READER_A, 'ironic'));
  // 2011–2024 reclaimed ×3, contested ×1 ('contested' joined the pragmatic_function enum at the M1 gate)
  out.push(label(d('A24'), READER_B, 'reclaimed', firstOcc(d('A24'), 'carry the zero')), label(d('A29'), READER_A, 'reclaimed',
    spanOf(d('A29'), 'Both readings are in the song now.')));
  pick('honor', 2011, 2024, 1).forEach((g) => out.push(label(g, READER_B, 'reclaimed')));
  out.push(label(d('A21'), READER_A, 'contested', spanOf(d('A21'), 'the argument over whether it mocks teachers is half the song now')));

  // two readings of A15 (Reader A revises hers), Reader B on A4, Reader A's hypothesis
  out.push({ key: 'reading-a-a15', target: { type: 'passage', ext_id: 'demo:A15' }, anchor: spanOf(d('A15'), 'carry the zero, carry the block, carry my name'),
    kind: 'interpretation', author: READER_A, is_machine: false, layer: 'Reading A', stance: null,
    body_md: "Reads as a mockery of schooling: the teacher's rule turned into a boast.", dimensions: { pragmatic_function: 'ironic' }, tags: ['irony'],
    revisions: [{ body_md: 'Ironic distance from schooling rather than mockery: the rule is quoted, not attacked.',
      dimensions: { pragmatic_function: 'ironic' }, tags: ['irony'], reason: 'the 1995 interview (Ledgerline answers the Quarterly) calls it a thank-you note' }] });
  out.push({ key: 'reading-b-a15', target: { type: 'passage', ext_id: 'demo:A15' }, anchor: spanOf(d('A15'), 'the ones they never counted hold the place for the number'),
    kind: 'interpretation', author: READER_B, is_machine: false, layer: 'Reading B', stance: null,
    body_md: 'Tribute — the zero is the uncounted.', dimensions: { pragmatic_function: 'reclaimed' }, tags: ['tribute'] });
  out.push({ key: 'reading-b-a4', target: { type: 'passage', ext_id: 'demo:A4' }, anchor: spanOf(d('A4'), 'Carry the zero, children'),
    kind: 'interpretation', author: READER_B, is_machine: false, layer: 'Reading B', stance: null,
    body_md: 'After Ledgerline, this rule reads as a lesson about who gets counted.', dimensions: { reframes_target: true }, tags: ['reframed'] });
  out.push({ key: 'hypothesis-2035', target: { type: 'passage', ext_id: 'demo:A15' }, anchor: spanOf(d('A15'), 'carry the zero, carry the block, carry my name'),
    kind: 'hypothesis', author: READER_A, is_machine: false, layer: 'Reading A', stance: null,
    body_md: "By 2035 'carry the zero' may be mainly a data-engineering term outside hip-hop.", tags: ['next'] });
  // deferred: they target rows the real pipeline creates after loading (demo-load applies them later)
  // the group's computed machine label is 'hold · mic · verse · block' (TF-IDF hash, seed 1994): match any two of these
  // context words (M5 gate, WP4 need; 'ones' is shared with the classroom group)
  out.push({ deferred: 'cluster_label', author: READER_A, expression: 'carry the zero', match_terms: ['hold', 'mic', 'verse', 'block', 'counted'],
    body_md: 'honoring the uncounted', layer: 'Reading A' });
  out.push({ deferred: 'review', match: { rel_type: 'explicit_citation', src: 'demo:A13', dst: 'demo:A3', evidence_status: 'proposed' },
    reviews: [{ action: 'confirm', actor: `human:${READER_A}`, reason: 'the notebook names Wrexley right before the phrase' },
      { action: 'reject', actor: `human:${READER_B}`, reason: 'a lab joke about bit flips, not a citation of the novel' }] });
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build everything in memory.
 * @returns {{documents: object[], relationships: object[], annotations: object[], calibration: object, errors: string[]}}
 */
export function buildDemo() {
  const anchors = readJsonl('anchors.jsonl');
  const generated = generate({ seed: SEED, anchors });
  const records = [...anchors, ...generated];
  const documents = records.map(toCanonical);
  const byExt = new Map(documents.map((x) => [x.ext_id, x]));
  const cal = calibrate(records);
  const errors = [...cal.errors];
  for (const [label, ok] of EXPECT) if (!ok(cal.stats)) errors.push(`calibration: ${label} — got ${JSON.stringify(summary(cal.stats))}`);
  errors.push(...structuralChecks(documents));
  const relationships = buildRelationships(byExt);
  const annotations = buildAnnotations(byExt, documents.filter((x) => x.original_meta.generator));
  return { documents, relationships, annotations, calibration: cal.stats, errors };
}

function summary(stats) {
  return Object.fromEntries(Object.entries(stats).map(([e, s]) => [e, { n: s.n, docs: s.docs, authors: s.authors,
    senses: Object.fromEntries(Object.entries(s.senses).map(([k, v]) => [k, `${v.n}/${v.docs}/${v.authors}`])) }]));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-demo.mjs')) {
  const check = process.argv.includes('--check');
  const { documents, relationships, annotations, calibration, errors } = buildDemo();
  const tokens = documents.reduce((s, x) => s + tokenize(x.text.original).tokens.length, 0);
  process.stdout.write(`${JSON.stringify({ documents: documents.length, tokens, relationships: relationships.length,
    annotations: annotations.length, calibration: summary(calibration) }, null, 2)}\n`);
  if (errors.length) {
    process.stderr.write(`build-demo: ${errors.length} problem(s):\n  ${errors.slice(0, 40).join('\n  ')}\n`);
    process.exitCode = 1;
  } else if (!check) {
    const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    writeFileSync(new URL('documents.jsonl', DIR), jl(documents));
    writeFileSync(new URL('relationships.jsonl', DIR), jl(relationships));
    writeFileSync(new URL('annotations.jsonl', DIR), jl(annotations));
    process.stdout.write('wrote data/demo/documents.jsonl, relationships.jsonl, annotations.jsonl\n');
  }
}
