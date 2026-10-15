// OWNER: N5
// Lineage goldens (IOS-SPEC §2.2, §8.5 N5), generated from the frozen reference (server/lineage/*, read-only imports):
//   g1.winnow            winnow.mjs: token ids, shingle hashes, fingerprints (random id streams, k/w variants, the
//                        demo world's texts end to end), the stable radix sort                                   exact
//   g1.minhash           minhash.mjs: permutations, 3-shingles, Jaccard, signatures (id and string shingles), LSH band
//                        keys, bandKeysRange, near-quote units (prose and verse)                                exact
//   g2.boilerplate       boilerplate.mjs on the reference test's synthetic books (invented text): the input rows the
//                        reference's DocumentWriter wrote, then seven passes in order (results, flagged passages,
//                        doc_tokens, runs, commonplace records)                                                  exact
//   g2.boilerplate-m1r   the pass on an m1r clone (full Cipher): as bootstrapped (idempotent) and with every
//                        boilerplate passage reset to ok first (the canary must hold either way)                  exact
//   g3.lineage           graph.mjs, path.mjs, genealogy.mjs on an m1r clone (requests/lineage + a systematic sample)  exact
//   g4.reuse-index       planned (M2)
// Every input is deterministic (mulberry32 streams, fixed seeds, the reference's own fixture texts).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fnv1a32, mulberry32 } from '../../src/shared/ids.mjs';
import { snapshotsRoot } from './lib/clone.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { K, W, radixSortPairs, shingleHashes, tokenIds, winnow } from '../../server/lineage/winnow.mjs';
import { BANDS, PERMS, bandKeysRange, jaccard, lshBands, minhash, shingles3, unitsOf } from '../../server/lineage/minhash.mjs';

export const owner = 'N5';
export const group = 'lineage';

const pending = (name) => async () => {
  throw new Error(`${name}: not implemented yet (package N5, M2)`);
};

/** sha256 of the little-endian bytes of a u32 array (the Swift side hashes the same bytes). */
function u32sha(arr) {
  const a = Uint32Array.from(arr);
  return createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
}

function randomIds(rnd, n, vocab = 50000) {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = fnv1a32(`w${Math.floor(rnd() * vocab)}`);
  return a;
}

function demoTexts() {
  const lines = readFileSync(new URL('../../data/demo/documents.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    const d = JSON.parse(line);
    if (typeof d.text?.original === 'string') out.push({ source: `demo:${d.ext_id}`, text: d.text.original });
  }
  return out;
}

const EDGE_TOKENS = ['carry', 'the', 'zero', 'ΟΔΟΣ', 'σας', 'शून्य', 'શૂન્ય', 'é', 'é', '◉', '😀', 'ﬁ', 'İstanbul', '१९४७',
  'project', 'gutenberg', 'ebooks', 'licensed', 'computer', 'virus', '', 'a'.repeat(300), 'x‍y'];

const EDGE_TEXTS = [
  '', 'one', 'one two three four five six seven', 'one two three four five six seven eight',
  'The clerk counted the long rows by lamplight; a zero kept in its column is worth more than a number lost.',
  'Carry the zero.\n\nCarry the zero!   Carry   the zero? Carry the zero… carry the zero',
  'शून्य का अर्थ है खाली। यह एक संख्या है॥ और यह भी एक वाक्य है जो लंबा है',
  'line one of the verse is here\nline two of the verse is here too\n\n\nline three after a blank stanza gap',
  'tabs\tand spaces line separator para separator with enough tokens here',
  'emoji 😀 ◉ ◉ ◉ symbols count as tokens in u61m one two three four five six seven eight nine ten',
  'a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z',
  'Project Gutenberg-tm ebooks are licensed; a computer virus, or computer codes that damage your equipment.',
];

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// G1 winnow
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The sample books N0 bundles for the device probe (Golden/probe-samples.mjs). */
const PROBE_BOOKS = ['en-third-class-in-indian-railways', 'hi-kavitavali', 'gu-mameru'];

function winnowFamily(ctx) {
  const cases = [];
  // token ids
  const toks = [...EDGE_TOKENS];
  const rnd0 = mulberry32(20261010);
  for (let i = 0; i < 200; i++) toks.push(`w${Math.floor(rnd0() * 1e6)}`);
  cases.push({ kind: 'tokenIds', tokens: toks, ids: [...tokenIds(toks)] });

  // shingle hashes
  const rnd1 = mulberry32(11);
  for (const [n, k] of [[0, 8], [7, 8], [8, 8], [9, 8], [40, 8], [40, 1], [40, 3], [40, 13], [5, 5]]) {
    const ids = randomIds(rnd1, n);
    cases.push({ kind: 'shingles', k, ids: [...ids], shingles: [...shingleHashes(ids, k)] });
  }

  // fingerprints of random id streams (k = 8, w = 6 and variants), lengths across the short-sequence boundaries
  const rnd2 = mulberry32(1994);
  const lengths = [0, 1, 7, 8, 9, 12, 13, 14, 20, 50];
  for (let i = 0; i < 120; i++) lengths.push(1 + Math.floor(rnd2() * 400));
  for (const n of lengths) {
    const ids = randomIds(rnd2, n, n % 3 === 0 ? 40 : 50000);  // small vocabularies make equal hashes (ties)
    const f = winnow(ids);
    cases.push({ kind: 'winnow', k: K, w: W, ids: [...ids], hashes: [...f.hashes], positions: [...f.positions] });
  }
  for (const [k, w] of [[5, 4], [3, 1], [13, 2], [8, 20], [1, 6]]) {
    for (let t = 0; t < 6; t++) {
      const ids = randomIds(rnd2, 5 + Math.floor(rnd2() * 200), t % 2 ? 30 : 50000);
      const f = winnow(ids, { k, w });
      cases.push({ kind: 'winnow', k, w, ids: [...ids], hashes: [...f.hashes], positions: [...f.positions] });
    }
  }
  // a long stream by digest
  const big = randomIds(mulberry32(7), 200000, 1e6);
  const fb = winnow(big);
  cases.push({ kind: 'winnow-digest', seed: 7, n: 200000, vocab: 1e6, ids_sha256: u32sha(big), count: fb.hashes.length,
    hashes_sha256: u32sha(fb.hashes), positions_sha256: u32sha(fb.positions) });

  // texts end to end: tokenize → fold → FNV ids → winnow (edge texts and every demo document)
  for (const [i, text] of EDGE_TEXTS.entries()) {
    const ids = tokenIds(tokenize(text).tokens);
    const f = winnow(ids);
    cases.push({ kind: 'text', source: `edge:${i}`, text, count: f.hashes.length, hashes: [...f.hashes], positions: [...f.positions] });
  }
  for (const d of demoTexts()) {
    const ids = tokenIds(tokenize(d.text).tokens);
    const f = winnow(ids);
    cases.push({ kind: 'text', source: d.source, text: d.text, tokens: ids.length, count: f.hashes.length,
      hashes_sha256: u32sha(f.hashes), positions_sha256: u32sha(f.positions) });
  }

  // the probe books bundled in the app (Scrolls/Resources/Probe): the device self-test repeats this check on iOS
  const probeDir = join(ctx.native, 'Scrolls', 'Resources', 'Probe');
  for (const name of PROBE_BOOKS) {
    const text = readFileSync(join(probeDir, `${name}.txt`), 'utf8');
    const ids = tokenIds(tokenize(text).tokens);
    const f = winnow(ids);
    cases.push({ kind: 'probe-book', name, tokens: ids.length, ids_sha256: u32sha(ids), count: f.hashes.length,
      hashes_sha256: u32sha(f.hashes), positions_sha256: u32sha(f.positions) });
  }

  // the stable radix sort
  const rnd3 = mulberry32(11);
  for (const [n, spread] of [[0, 10], [1, 10], [2, 1], [17, 3], [500, 20], [3000, 3000], [5000, 65536 * 3]]) {
    const keys = new Uint32Array(n), vals = new Uint32Array(n);
    for (let i = 0; i < n; i++) { keys[i] = (Math.floor(rnd3() * spread) * 1000003) >>> 0; vals[i] = i; }
    const input = [...keys];
    radixSortPairs(keys, vals);
    cases.push({ kind: 'radix', keys: input, sorted_keys: [...keys], sorted_vals: [...vals] });
  }
  {
    const n = 200000, rnd = mulberry32(12);
    const keys = new Uint32Array(n), vals = new Uint32Array(n);
    for (let i = 0; i < n; i++) { keys[i] = (Math.floor(rnd() * 3000) * 1000003) >>> 0; vals[i] = i; }
    const inSha = u32sha(keys);
    radixSortPairs(keys, vals);
    cases.push({ kind: 'radix-digest', seed: 12, n, spread: 3000, multiplier: 1000003, keys_sha256: inSha,
      sorted_keys_sha256: u32sha(keys), sorted_vals_sha256: u32sha(vals) });
  }
  return cases;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// G1 minhash
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** a and b of the reference's private permutations(perms, seed): the first `perms` pairs of its mulberry32 stream. */
function permutationsOf(perms, seed) {
  // the reference keeps them private; reproduce them from the signature of single shingles: sig[p] = a[p]·h + b[p]
  // for one shingle h, so h = 0 gives b and h = 1 gives a + b (mod 2³²)
  const b = minhash([0], { perms, seed });
  const ab = minhash([1], { perms, seed });
  const a = Uint32Array.from(ab, (x, i) => (x - b[i]) >>> 0);
  return { a: [...a], b: [...b] };
}

const STRING_SHINGLES = ['carry the zero', 'the zero kept', 'शून्य का अर्थ', '😀 ◉ ﬁ', 'é', 'é', '', 'x'.repeat(100),
  'ΟΔΟΣ ΣΑΣ', 'a\uFFFDb'];  // a lone surrogate is out of the Swift domain (a String holds U+FFFD), so none is used

function minhashFamily() {
  const cases = [];
  for (const [perms, seed] of [[PERMS, 42], [16, 7], [64, 1994], [128, 0], [1, 42]]) {
    cases.push({ kind: 'permutations', perms, seed, ...permutationsOf(perms, seed) });
  }
  const rnd = mulberry32(42);
  // 3-shingles (repeated ids make repeated shingles: first-seen order is kept)
  for (let t = 0; t < 120; t++) {
    const n = t < 8 ? t : Math.floor(rnd() * 40);
    const ids = randomIds(rnd, n, t % 4 === 0 ? 3 : 50000);
    cases.push({ kind: 'shingles3', ids: [...ids], shingles: [...shingles3(ids)] });
  }
  // Jaccard
  for (let t = 0; t < 120; t++) {
    const a = shingles3(randomIds(rnd, Math.floor(rnd() * 30), 12));
    const b = shingles3(randomIds(rnd, Math.floor(rnd() * 30), 12));
    cases.push({ kind: 'jaccard', a: [...a], b: [...b], value: jaccard(a, b) });
  }
  cases.push({ kind: 'jaccard', a: [], b: [], value: jaccard([], []) });
  // signatures and band keys
  for (let t = 0; t < 120; t++) {
    const sh = shingles3(randomIds(rnd, Math.floor(rnd() * 60), 50000));
    const sig = minhash(sh);
    cases.push({ kind: 'minhash', shingles: [...sh], perms: PERMS, seed: 42, signature: [...sig], bands: lshBands(sig) });
  }
  for (const [perms, seed, bands, rows] of [[16, 7, 4, 4], [64, 1994, 16, 4], [128, 42, 64, 2]]) {
    const sh = shingles3(randomIds(rnd, 30));
    const sig = minhash(sh, { perms, seed });
    cases.push({ kind: 'minhash', shingles: [...sh], perms, seed, signature: [...sig], bands: lshBands(sig, { bands, rows }),
      band_count: bands, rows });
  }
  cases.push({ kind: 'minhash-strings', strings: STRING_SHINGLES, perms: PERMS, seed: 42,
    signature: [...minhash(STRING_SHINGLES)] });
  for (let t = 0; t < 40; t++) {
    const sh = shingles3(randomIds(rnd, 5 + Math.floor(rnd() * 50)));
    const b0 = Math.floor(rnd() * BANDS);
    const b1 = b0 + 1 + Math.floor(rnd() * (BANDS - b0));
    cases.push({ kind: 'bandKeysRange', shingles: [...sh], band0: b0, band1: b1, keys: [...bandKeysRange(sh, b0, b1)] });
  }
  // near-quote units: prose and verse, over the reference tokenizer's offsets (the Swift side tokenizes itself)
  const unitCase = (source, text, variants) => {
    const tok = tokenize(text);
    return { kind: 'units', source, text, results: variants.map(([verse, minTokens]) => ({ verse, min_tokens: minTokens,
      units: unitsOf(text, tok, { verse, minTokens }).map((u) => [u.t0, u.t1]) })) };
  };
  const all = [[false, 6], [true, 6], [false, 1], [true, 1], [false, 3], [true, 3]];
  for (const [i, text] of EDGE_TEXTS.entries()) cases.push(unitCase(`edge:${i}`, text, all));
  for (const d of demoTexts()) cases.push(unitCase(d.source, d.text, [[false, 6], [true, 6]]));
  return cases;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// G1 align, cues and filters (the trace's kernels)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

async function alignFamily(ctx) {
  const { kgramSeeds, seedExtend, smithWaterman } = await ctx.reference('server/lineage/align.mjs');
  const cases = [];
  const rnd = mulberry32(8);
  const plant = (a, b, len) => {
    const run = randomIds(rnd, len, 50000);
    const ia = Math.floor(rnd() * Math.max(1, a.length - len)), ib = Math.floor(rnd() * Math.max(1, b.length - len));
    for (let i = 0; i < len && ia + i < a.length && ib + i < b.length; i++) { a[ia + i] = run[i]; b[ib + i] = run[i]; }
  };
  for (let t = 0; t < 120; t++) {
    const vocab = t % 3 === 0 ? 6 : 50000;
    const a = randomIds(rnd, 10 + Math.floor(rnd() * 120), vocab), b = randomIds(rnd, 10 + Math.floor(rnd() * 120), vocab);
    if (t % 2 === 0) plant(a, b, 8 + Math.floor(rnd() * 12));
    if (t % 5 === 0) plant(a, b, 4 + Math.floor(rnd() * 6));
    const k = [8, 4, 13][t % 3], minRun = [8, 4, 13][(t + 1) % 3];
    const aLo = t % 4 === 1 ? Math.floor(a.length / 4) : 0, aHi = t % 4 === 1 ? a.length - 2 : a.length;
    const seeds = kgramSeeds(a, b, { k, aLo, aHi });
    const runs = seedExtend(a, b, seeds, { minRun, aLo, aHi });
    cases.push({ kind: 'seeds', a: [...a], b: [...b], k, a_lo: aLo, a_hi: aHi, min_run: minRun,
      seeds: seeds.map((x) => [x.a, x.b]), runs: runs.map((r) => [r.a0, r.a1, r.b0, r.b1]) });
  }
  for (let t = 0; t < 150; t++) {
    const vocab = [4, 12, 60][t % 3];
    const a = randomIds(rnd, Math.floor(rnd() * 40), vocab), b = randomIds(rnd, Math.floor(rnd() * 40), vocab);
    if (t % 4 === 0) plant(a, b, 6);
    const opts = t % 7 === 3 ? { match: 3, mismatch: -2, gap: -2 } : {};
    const sw = smithWaterman(a, b, opts);
    cases.push({ kind: 'sw', a: [...a], b: [...b], opts, result: sw });
  }
  return cases;
}

const CUE_TEXTS = [
  'As Brennock wrote in his primer, “carry the zero” is the first rule; in Brennock’s words the zero keeps its column.',
  'As I said before, and as He wrote, nothing names a source here; as Mr. Brennock put it, the rows are long.',
  'Wrexley’s phrase “a zero kept in its column” and Wrexley\'s line about the margin are quoted twice.',
  'Comme l’a dit Victor Hugo, « le zéro garde la colonne ». Selon Pascal, le cœur a ses raisons. comme écrit Molière.',
  'Como dijo Miguel de Cervantes, «el cero guarda la columna»; según Lope de Vega, y según él mismo, no.',
  'तुलसीदास ने कहा कि शून्य का अर्थ है। कबीर के शब्दों में यह एक संख्या है।',
  'નરસિંહ મહેતા એ કહ્યું કે શૂન્ય. પ્રેમાનંદ ના શબ્દોમાં આ વાક્ય છે.',
  'In the clerk’s words nothing; In Dickens’s words, the zero; in Dickens\'s words.',
  'He quoted “Carry the zero,” and moved on; then ‘keep the column’ again; „Null bleibt“ said the German edition.',
  'sauvegardé selon Laplace; Nosegún Pedro; según Pedro.',
  '',
];

async function cuesFamily(ctx) {
  const { allCues, findCues, nameMatches, nameWords } = await ctx.reference('server/lineage/cues.mjs');
  const cases = [];
  for (const [i, text] of CUE_TEXTS.entries()) {
    cases.push({ kind: 'all', source: `cue:${i}`, text, cues: allCues(text) });
    for (const lang of ['en', 'fr', 'hi', 'xx']) cases.push({ kind: 'all-lang', source: `cue:${i}`, lang, text, cues: allCues(text, { lang }) });
    const tk = tokenize(text);
    for (let t = 0; t + 3 < tk.tokens.length; t += 5) {
      const start = tk.starts[t], end = tk.ends[t + 3];
      cases.push({ kind: 'find', source: `cue:${i}`, text, start, end, cues: findCues(text, start, end) });
      cases.push({ kind: 'find', source: `cue:${i}`, text, start, end, window: 3, cues: findCues(text, start, end, { window: 3 }) });
    }
  }
  for (const d of demoTexts().slice(0, 60)) {
    const cues = allCues(d.text);
    if (cues.length) cases.push({ kind: 'all', source: d.source, text: d.text, cues });
  }
  const names = ['Brennock', 'Mr. Brennock', 'I', 'He', 'the Old Clerk', 'Ready Arithmetic', 'Tom', 'Victor Hugo', 'de Vega',
    'तुलसीदास', 'Dickens', 'Charles Dickens (synthetic)', '', 'Brennock’s Ready'];
  const docs = [{ author: 'Ada Brennock', title: "Brennock's Ready Arithmetic" }, { author: null, title: 'The History of Tom Jones' },
    { author: 'Victor Hugo', title: 'Les Misérables' }, { author: 'Lope de Vega', title: 'Fuenteovejuna' },
    { author: 'तुलसीदास', title: 'कवितावली' }, { author: 'Dickens, Charles (synthetic)', title: 'Bleak House' },
    { author: 'Ready (synthetic)', title: 'Ready Arithmetic' }, {}];
  for (const n of names) {
    cases.push({ kind: 'nameWords', name: n, words: nameWords(n) });
    for (const d of docs) cases.push({ kind: 'nameMatches', name: n, author: d.author ?? null, title: d.title ?? null, value: nameMatches(n, d) });
  }
  return cases;
}

async function filtersFamily(ctx) {
  const { informative, contentTokens, isNameList, isNumeral, TokenClasses, stopIds } = await ctx.reference('server/lineage/filters.mjs');
  const cases = [];
  const ids = stopIds();
  cases.push({ kind: 'stopIds', count: ids.size, sha256: u32sha([...ids].sort((a, b) => a - b)) });
  for (const t of ['xiv', 'mmxxiv', 'iiii', 'ic', '१९४७', '42', '4a', '', 'mcm', 'x', 'vix', 'cd', 'dc', 'Ⅻ', '½', 'lil']) {
    cases.push({ kind: 'isNumeral', token: t, value: isNumeral(t) });
  }
  const texts = [...EDGE_TEXTS, 'The Muse of the Department A Prince of Bohemia A Man of Business The Firm of Nucingen',
    'CHAPTER I CHAPTER II CHAPTER III CHAPTER IV CHAPTER V', 'I II III IV V VI VII VIII IX X XI XII XIII XIV',
    'Émile Zola Honoré de Balzac Ἀριστοτέλης Ólafur Arnalds', 'the the the the of of and to a in that it',
    ...demoTexts().slice(0, 40).map((d) => d.text.slice(0, 400))];
  for (const text of texts) {
    const tk = tokenize(text);
    const tids = tokenIds(tk.tokens);
    const classes = new TokenClasses();
    tk.tokens.forEach((t, i) => classes.see(t, tids[i]));
    const windows = [];
    for (let a0 = 0; a0 < tids.length; a0 += 7) {
      const a1 = Math.min(tids.length, a0 + 13);
      if (a1 > a0) windows.push([a0, a1, informative(tids, a0, a1, classes), informative(tids, a0, a1, null), contentTokens(tids, a0, a1, classes)]);
    }
    cases.push({ kind: 'text', text, name_list: isNameList(text), numerals: [...classes.numerals].sort((a, b) => a - b), windows });
  }
  return cases;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// G2 boilerplate: the reference test's synthetic books (tests/lineage.boilerplate.test.mjs, invented text)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const WORDS = ('the a and of to in that it was he she they we his her their for on with as at by from but not or one ' +
  'all were when there which said would been this had could clerk ledger column margin river garden window morning ' +
  'evening letter house street market harbour winter summer lamp table chair door road field hill bridge village town ' +
  'mother father brother sister friend neighbour teacher farmer sailor baker miller weaver carpenter shepherd rain snow ' +
  'wind stone bread salt iron silver copper paper ink candle bell clock coat boot hat basket barrel wagon horse dog cat ' +
  'bird fish apple pear plum walked carried counted wrote read opened closed waited listened answered laughed slept ' +
  'early late quiet loud slow quick old young little great long short green grey white black brown warm cold').split(' ');
const LICENCE = 'This synthetic test edition is offered under the test licence of the Fixture Foundation. Volunteers expend ' +
  'considerable effort, yet a copy may contain defects, such as a defective or damaged disk or other medium, a computer ' +
  'virus, or computer codes that damage or cannot be read by your equipment. Donations keep the test archive going and ' +
  'the trademark stays with the fixture.';
const SAYING = 'Every clerk who counts the long rows by lamplight learns that a zero kept in its column is worth more than ' +
  'a number lost in the margin of the book.';
const OLD_LICENCE = 'Small print for the fixture etexts: by reading any part of this text you accept the license here. Despite ' +
  'these efforts the etexts may hold flaws, a defective or damaged disk or other medium, a computer virus, or computer ' +
  'codes that damage or cannot be read by your equipment.';

function prose(rnd, words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]);
  return `${out.join(' ')}.`;
}

function book(seed, { saying = false, licence = 'body', oldLicence = false } = {}) {
  const rnd = mulberry32(seed);
  const paras = [];
  if (oldLicence) paras.push(OLD_LICENCE);
  for (let i = 0; i < 12; i++) paras.push(prose(rnd, 60));
  if (saying) paras.splice(6, 0, SAYING);
  if (licence === 'body') paras.push(LICENCE);
  const body = paras.join('\n\n');
  if (licence !== 'footer') return { original: `${body}\n`, body_start: 0, body_end: body.length };
  const original = `${body}\n\n*** END OF THE FIXTURE ***\n\n${LICENCE}\n`;
  return { original, body_start: 0, body_end: body.length };
}

/** The six collections of the reference test, in its order. */
const SCENARIO_BOOKS = [
  ['bp-wide', Array.from({ length: 30 }, () => ({ saying: true }))],
  ['bp-few', Array.from({ length: 25 }, (_, i) => ({ seed: 100 + i }))],
  ['bp-dups', [...Array.from({ length: 20 }, (_, i) => ({ seed: 200 + i })), ...Array.from({ length: 10 }, (_, i) => ({ seed: 200 + i }))]],
  ['bp-footer', [...Array.from({ length: 29 }, (_, i) => ({ seed: 300 + i, licence: 'footer' })), { seed: 399, licence: 'body' }]],
  ['bp-old', [...Array.from({ length: 28 }, (_, i) => ({ seed: 400 + i })), { seed: 499, licence: 'none', oldLicence: true }]],
  ['bp-dry', Array.from({ length: 27 }, (_, i) => ({ seed: 500 + i }))],
];

/** The passes, in order: [label, collection, opts]; `explain: 'old'` names the old-licence passage. */
const SCENARIO_PASSES = [
  ['wide', 'bp-wide', {}], ['wide-again', 'bp-wide', {}], ['few', 'bp-few', {}], ['dups', 'bp-dups', {}],
  ['footer', 'bp-footer', {}], ['old', 'bp-old', { explain: 'old' }], ['dry', 'bp-dry', { dryRun: true }],
];

const rowsOf = (db, sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r }));

async function boilerplateSynthetic(ctx) {
  const { makeTmpData } = await ctx.reference('tests/helpers/tmpdata.mjs');
  const { createBatch, createDocumentWriter, ensureCollection } = await ctx.reference('server/store/document-writer.mjs');
  const { boilerplatePass, canaryCount } = await ctx.reference('server/lineage/boilerplate.mjs');
  const { makeTaskContext } = await ctx.reference('server/jobs/context.mjs');
  const { nowIso } = await ctx.reference('server/db/open.mjs');
  const { paths } = await ctx.reference('server/config.mjs');

  const tmp = makeTmpData({ seed: false });
  try {
    const db = tmp.db;
    db.prepare(`INSERT INTO corpus (slug, name, kind, is_synthetic, description, license, created_at)
      VALUES ('test', 'Test fixtures (synthetic)', 'synthetic', 1, 'Invented test documents', 'CC0 (synthetic)', ?)
      ON CONFLICT(slug) DO NOTHING`).run(nowIso());
    for (const [slug, specs] of SCENARIO_BOOKS) {
      const coll = ensureCollection(db, { slug, name: `${slug} (synthetic)`, corpus: 'test', adapter_id: 'file.jsonl',
        domain: 'imported', modality: 'text', unit: 'tokens', sampling: 'user' });
      const w = createDocumentWriter(db, { batchId: createBatch(db, { collection: coll.id, format: 'jsonl' }), collection: slug,
        corpus: 'test', options: { now: new Date('2026-10-04T12:00:00Z') } });
      specs.forEach((s, i) => {
        const t = book(s.seed ?? i + 1, s);
        const r = w.addDocument({ ext_id: `${slug}:${i}`, kind: 'book', title: `Fixture book ${i} (synthetic)`, lang_declared: 'en',
          text: { original: t.original, decoder: 'utf-8', body_start: t.body_start, body_end: t.body_end }, dates: [],
          original_meta: { fixture: 'synthetic boilerplate test' } });
        if (!r.documentId) throw new Error(`g2.boilerplate: book ${slug}:${i} not imported: ${JSON.stringify(r.issues)}`);
      });
      w.finish();
    }

    // the input rows (what the Swift test inserts verbatim into a fresh reference-schema database)
    const collIds = rowsOf(db, "SELECT id FROM collection WHERE slug LIKE 'bp-%'").map((r) => r.id);
    const inColl = `(${collIds.join(',')})`;
    const docs = rowsOf(db, `SELECT * FROM document WHERE collection_id IN ${inColl} ORDER BY id`);
    const docIds = `(${docs.map((d) => d.id).join(',')})`;
    const passages = rowsOf(db, `SELECT * FROM passage WHERE document_id IN ${docIds} ORDER BY id`);
    const texts = rowsOf(db, `SELECT * FROM document_text WHERE document_id IN ${docIds} ORDER BY document_id`);
    const input = {
      kind: 'input',
      tables: {
        corpus: rowsOf(db, "SELECT * FROM corpus WHERE slug = 'test'"),
        source_adapter: rowsOf(db, "SELECT * FROM source_adapter WHERE id = 'file.jsonl'"),
        collection: rowsOf(db, `SELECT * FROM collection WHERE id IN ${inColl} ORDER BY id`),
        import_batch: rowsOf(db, `SELECT * FROM import_batch WHERE collection_id IN ${inColl} ORDER BY id`),
        document: docs,
        document_text: texts,
        document_field: rowsOf(db, `SELECT * FROM document_field WHERE document_id IN ${docIds} ORDER BY document_id, field`),
        passage: passages,
        doc_tokens: rowsOf(db, `SELECT * FROM doc_tokens WHERE document_id IN ${docIds} ORDER BY document_id, plang, field_class`),
      },
      // passage_fts is contentless: the Swift side indexes each passage's slice with its own (G1-equal) tokenizer, and
      // every pass case checks canary_before, which reads the FTS index
      meta: Object.fromEntries(rowsOf(db, "SELECT key, value FROM meta WHERE key IN ('data_version', 'quality_version')")
        .map((r) => [r.key, r.value])),
      runs_before: db.prepare('SELECT count(*) AS n FROM analysis_run').get().n,
    };
    const cases = [input];

    // the passes
    const cancel = new Int32Array(new SharedArrayBuffer(4));
    for (const [label, slug, opts] of SCENARIO_PASSES) {
      const coll = db.prepare('SELECT id FROM collection WHERE slug = ?').get(slug).id;
      const before = new Map(rowsOf(db, `SELECT p.id, p.quality FROM passage p JOIN document d ON d.id = p.document_id
        WHERE d.collection_id = ?`, coll).map((r) => [r.id, r.quality]));
      const canaryBefore = canaryCount(db, [coll]);
      let explain = [];
      if (opts.explain === 'old') {
        explain = rowsOf(db, `SELECT p.id FROM passage p JOIN document d ON d.id = p.document_id JOIN document_text t ON t.document_id = d.id
          WHERE d.collection_id = ? AND p.field = 'body' AND substr(t.original, p.start_off + 1, p.end_off - p.start_off) LIKE ?`,
        coll, `%${OLD_LICENCE.slice(0, 40)}%`).map((r) => r.id);
      }
      const taskCtx = opts.dryRun ? null : makeTaskContext({ db, jobId: null, cancelFlag: cancel, post: () => {} });
      const m = boilerplatePass(db, taskCtx, { collections: [slug], dryRun: Boolean(opts.dryRun), explain });
      const after = rowsOf(db, `SELECT p.id, p.quality FROM passage p JOIN document d ON d.id = p.document_id
        WHERE d.collection_id = ?`, coll);
      const flagged = after.filter((r) => r.quality === 'boilerplate' && before.get(r.id) !== 'boilerplate').map((r) => r.id).sort((a, b) => a - b);
      const run = m.run_id === null ? null : db.prepare('SELECT id, stage, status, pipeline_version, params_json, scope_json, metrics_json FROM analysis_run WHERE id = ?').get(m.run_id);
      const cpFile = join(paths().reuse, `commonplace-${slug}.json`);
      const commonplace = !opts.dryRun && existsSync(cpFile) ? JSON.parse(readFileSync(cpFile, 'utf8')) : null;
      cases.push({
        kind: 'pass', label, collection: slug, options: { dryRun: Boolean(opts.dryRun), explain },
        canary_before: canaryBefore,
        result: { ...m, duration_ms: '<masked>', finished_at: '<ts>' },
        flagged,
        doc_tokens: rowsOf(db, `SELECT t.* FROM doc_tokens t JOIN document d ON d.id = t.document_id WHERE d.collection_id = ?
          ORDER BY t.document_id, t.plang, t.field_class`, coll),
        run: run && { ...run, params: JSON.parse(run.params_json), scope: JSON.parse(run.scope_json),
          metrics: { ...JSON.parse(run.metrics_json), duration_ms: '<masked>', finished_at: '<ts>' },
          params_json: undefined, scope_json: undefined, metrics_json: undefined },
        commonplace: commonplace && { ...commonplace, at: '<ts>' },
        meta: Object.fromEntries(rowsOf(db, "SELECT key, value FROM meta WHERE key IN ('data_version', 'quality_version')")
          .map((r) => [r.key, r.value])),
      });
    }

    // the lineage of the widely shared text the passes recorded (graph.mjs commonplaceLineage, and the links of a
    // passage made of it): the "widely shared text (n documents)" node, never n² pairs
    const { lineageQuery } = await ctx.reference('server/lineage/graph.mjs');
    const lineage = (args) => {
      try { return { response: lineageQuery(db, args) }; } catch (e) { return { error: errorOf(e) }; }
    };
    const wide = JSON.parse(readFileSync(join(paths().reuse, 'commonplace-bp-wide.json'), 'utf8'));
    const keys = Object.keys(wide.groups).sort().slice(0, 3);
    for (const key of keys) {
      for (const args of [{ root: `shared:${key}` }, { root: `shared:${key}`, max_nodes: '5' }, { root: `shared:${key}`, max_nodes: '1' }]) {
        cases.push({ kind: 'lineage', args, ...lineage(args) });
      }
    }
    if (keys.length) {
      const pid = wide.groups[keys[0]].passages[0];
      for (const args of [{ root: `passage:${pid}` }, { root: `document:${db.prepare('SELECT document_id FROM passage WHERE id = ?').get(pid).document_id}` }]) {
        cases.push({ kind: 'lineage', args, ...lineage(args) });
      }
    }
    cases.push({ kind: 'lineage', args: { root: 'shared:ffffffff' }, ...lineage({ root: 'shared:ffffffff' }) });
    return cases;
  } finally {
    tmp.cleanup();
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// G2 boilerplate on full Cipher (m1r)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const COMPARED = ['documents', 'duplicates_not_counted', 'tokens', 'fingerprints', 'groups', 'widespread', 'boilerplate',
  'commonplace', 'passages_flagged', 'passages_would_flag', 'flagged_by_rule', 'documents_affected', 'commonplace_passages',
  'canary_ok_passages', 'params', 'dry_run'];

function deltas(sorted) {
  let prev = 0;
  return sorted.map((x) => { const d = x - prev; prev = x; return d; });
}

async function boilerplateM1r(ctx) {
  if (!ctx.findSnapshot(['m1r'])) throw new Error('g2.boilerplate-m1r needs the m1r snapshot');
  const { boilerplatePass, canaryCount } = await ctx.reference('server/lineage/boilerplate.mjs');
  const { openDb } = await ctx.reference('server/db/open.mjs');
  const info = ctx.snapshotInfo('m1r');
  ctx.inputs = { snapshot: 'm1r', built_from: info?.built_from?.commit ?? null };
  const cases = [];
  await ctx.withClone('m1r', async (clone) => {
    const saved = process.env.SCROLLS_DATA;
    process.env.SCROLLS_DATA = clone.dir;
    const db = openDb({ path: clone.db });
    try {
      const recorded = JSON.parse(db.prepare("SELECT metrics_json FROM analysis_run WHERE stage = 'boilerplate' AND status = 'succeeded' ORDER BY id DESC LIMIT 1").get().metrics_json);
      const pick = (m) => Object.fromEntries(COMPARED.map((k) => [k, m[k]]));
      const state = () => ({
        quality: Object.fromEntries(rowsOf(db, 'SELECT quality, count(*) AS n FROM passage GROUP BY quality ORDER BY quality').map((r) => [r.quality, r.n])),
        doc_tokens_sha256: createHash('sha256').update(rowsOf(db, 'SELECT document_id, plang, field_class, tokens, passages FROM doc_tokens ORDER BY document_id, plang, field_class')
          .map((r) => `${r.document_id}\t${r.plang}\t${r.field_class}\t${r.tokens}\t${r.passages}`).join('\n')).digest('hex'),
      });

      // 1. as bootstrapped: a second pass over everything finds nothing new; the corpus-level counts equal the
      //    snapshot's recorded run
      const t0 = Date.now();
      const m1 = boilerplatePass(db, null, {});
      ctx.log(`g2.boilerplate-m1r: idempotent pass ${Date.now() - t0} ms`);
      cases.push({ kind: 'idempotent', recorded_run: pick(recorded), result: pick(m1), canary: canaryCount(db, null), state: state() });

      // 2. every boilerplate passage reset to ok first (the adapter's licence regions and the pass's own flags)
      const reset = rowsOf(db, "SELECT id FROM passage WHERE quality = 'boilerplate' ORDER BY id").map((r) => r.id);
      db.exec("UPDATE passage SET quality = 'ok' WHERE quality = 'boilerplate'");
      const canaryReset = canaryCount(db, null);
      const t1 = Date.now();
      const m2 = boilerplatePass(db, null, {});
      ctx.log(`g2.boilerplate-m1r: reset pass ${Date.now() - t1} ms`);
      const flagged = rowsOf(db, "SELECT id FROM passage WHERE quality = 'boilerplate' ORDER BY id").map((r) => r.id);
      cases.push({ kind: 'reset', reset_deltas: deltas(reset), canary_after_reset: canaryReset, result: pick(m2),
        canary: canaryCount(db, null), flagged_deltas: deltas(flagged), state: state() });
    } finally {
      db.close();
      if (saved === undefined) delete process.env.SCROLLS_DATA; else process.env.SCROLLS_DATA = saved;
    }
  });
  return cases;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// G3 lineage, chain of custody and genealogy on m1r
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** An HttpError as the Swift side reports it (status, code, message, hint, detail). */
function errorOf(e) {
  if (e?.name !== 'HttpError') throw e;
  return { status: e.status, code: e.code, message: e.message, hint: e.hint ?? null, detail: e.detail ?? null };
}

/** The reference's read for one request: the route handler's `pool.run(MODULE, fn, req.query)` without HTTP. */
function runRequest(fns, db, req) {
  const fn = { lineage: fns.lineageQuery, path: fns.pathQuery, genealogy: fns.genealogyQuery }[req.method];
  try {
    return { response: fn(db, { ...req.args }) };
  } catch (e) {
    return { error: errorOf(e) };
  }
}

/** A systematic sample: per (relationship type, evidence status), the first and the last link by id — the lineage of
 * its later end, and the chain of custody between its ends. */
function systematicRequests(db) {
  const out = [];
  const groups = db.prepare(`SELECT rel_type, evidence_status, min(id) AS lo, max(id) AS hi FROM relationship
    GROUP BY rel_type, evidence_status ORDER BY rel_type, evidence_status`).all();
  const row = db.prepare('SELECT src_type, src_ref, dst_type, dst_ref FROM relationship WHERE id = ?');
  for (const g of groups) {
    for (const id of [...new Set([g.lo, g.hi])]) {
      const r = row.get(id);
      const src = `${r.src_type}:${r.src_ref}`, dst = `${r.dst_type}:${r.dst_ref}`;
      out.push({ id: `sys-${g.rel_type}-${g.evidence_status}-${id}`, method: 'lineage', args: { root: src } });
      out.push({ id: `sys-${g.rel_type}-${g.evidence_status}-${id}-dst-in`, method: 'lineage', args: { root: dst, dir: 'in', depth: '1' } });
      if (src !== dst) out.push({ id: `sys-path-${g.rel_type}-${g.evidence_status}-${id}`, method: 'path', args: { from: src, to: dst } });
    }
  }
  // the five most sampled works' family trees
  for (const w of db.prepare(`SELECT dst_ref AS id, count(*) AS n FROM relationship WHERE rel_type = 'samples' AND dst_type = 'document'
      GROUP BY dst_ref ORDER BY n DESC, CAST(dst_ref AS INTEGER) LIMIT 5`).all()) {
    out.push({ id: `sys-gen-${w.id}`, method: 'genealogy', args: { work: `document:${w.id}` } });
  }
  return out;
}

async function lineageM1r(ctx) {
  if (!ctx.findSnapshot(['m1r'])) throw new Error('g3.lineage needs the m1r snapshot');
  const graph = await ctx.reference('server/lineage/graph.mjs');
  const path = await ctx.reference('server/lineage/path.mjs');
  const genealogy = await ctx.reference('server/lineage/genealogy.mjs');
  const fns = { lineageQuery: graph.lineageQuery, pathQuery: path.pathQuery, genealogyQuery: genealogy.genealogyQuery };
  const { openDb } = await ctx.reference('server/db/open.mjs');
  const info = ctx.snapshotInfo('m1r');
  const file = new URL('./requests/lineage/g3-lineage-m1r.json', import.meta.url);
  const handPicked = JSON.parse(readFileSync(file, 'utf8')).requests;
  ctx.inputs = { snapshot: 'm1r', built_from: info?.built_from?.commit ?? null, requests: 'requests/lineage/g3-lineage-m1r.json' };
  const cases = [];
  await ctx.withClone('m1r', async (clone) => {
    // the commonplace records and the near index live in derived/ beside the database
    execFileSync('/bin/cp', ['-cR', join(snapshotsRoot(), 'm1r', 'derived'), join(clone.dir, 'derived')]);
    const saved = process.env.SCROLLS_DATA;
    process.env.SCROLLS_DATA = clone.dir;
    const db = openDb({ path: clone.db, readOnly: true });
    try {
      const requests = [...handPicked, ...systematicRequests(db)];
      for (const req of requests) {
        const t0 = Date.now();
        const r = runRequest(fns, db, req);
        cases.push({ kind: req.method, id: req.id, args: req.args, ...r, ms: '<masked>' });
        // paging: follow the cursor `page` − 1 more times
        let last = r.response;
        for (let p = 2; p <= (req.page ?? 1) && last?.truncated?.cursor; p++) {
          const args = { ...req.args, cursor: last.truncated.cursor };
          const next = runRequest(fns, db, { ...req, args });
          cases.push({ kind: req.method, id: `${req.id}-page${p}`, args, ...next, ms: '<masked>' });
          last = next.response;
        }
        if (Date.now() - t0 > 5000) ctx.log(`g3.lineage: ${req.id} took ${Date.now() - t0} ms`);
      }
    } finally {
      db.close();
      if (saved === undefined) delete process.env.SCROLLS_DATA; else process.env.SCROLLS_DATA = saved;
    }
  });
  return cases;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Generated sources
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** ScrollsLineage/Support/LineageStopwords.swift: the reference's stop-word lists as written (filters.mjs `stopIds`
 * hashes them with tokenId, trace.mjs `isStop` compares folded tokens with them). */
export function generate(ctx) {
  const dir = join(ctx.refRoot, 'server/text/stopwords');
  const langs = ['en', 'fr', 'es', 'de', 'la', 'it', 'pt', 'hi', 'gu'];
  let out = '// OWNER: N5 — generated by Native/Golden/gen-lineage.mjs from server/text/stopwords/*.json; do not edit\n';
  out += "// The stop-word lists of the nine languages lineage/filters.mjs and lineage/trace.mjs read, as written, in their order.\n\n";
  out += 'enum LineageStopwords {\n  static let lists: [(lang: String, words: [String])] = [\n';
  for (const l of langs) {
    const words = JSON.parse(readFileSync(join(dir, `${l}.json`), 'utf8')).words;
    out += `    (${JSON.stringify(l)}, [${words.map((w) => JSON.stringify(w)).join(', ')}]),\n`;
  }
  out += '  ]\n}\n';
  ctx.writeGenerated('ScrollsKit/Sources/ScrollsLineage/Support/LineageStopwords.swift', out);
}

export const families = {
  'g1.winnow': { run: winnowFamily, owner: 'N5',
    note: 'token ids, shingle hashes, fingerprints (random streams, k/w variants, demo texts end to end), stable radix sort' },
  'g1.minhash': { run: minhashFamily, owner: 'N5',
    note: 'permutations, 3-shingles, Jaccard, signatures, LSH band keys, bandKeysRange, near-quote units' },
  'g1.align': { run: alignFamily, owner: 'N5', note: 'kgramSeeds, seedExtend (limits, diagonals) and Smith–Waterman on random id streams' },
  'g1.cues': { run: cuesFamily, owner: 'N5', note: 'attribution cues in en, fr, es, hi and gu: allCues, findCues, nameWords, nameMatches' },
  'g1.filters': { run: filtersFamily, owner: 'N5', note: 'stop ids, numerals, name lists, informative and content tokens' },
  'g2.boilerplate': { run: boilerplateSynthetic, owner: 'N5',
    attribution: ['Synthetic boilerplate test books (invented text from tests/lineage.boilerplate.test.mjs; CC0)'],
    note: 'input rows written by the reference DocumentWriter, then seven passes in order, then the lineage of the widely shared text they recorded' },
  'g2.boilerplate-m1r': { run: boilerplateM1r, owner: 'N5',
    note: 'the pass over an m1r clone (full Cipher), as bootstrapped and after resetting every boilerplate passage' },
  'g3.lineage': { run: lineageM1r, owner: 'N5',
    note: 'lineage graph, chain of custody and genealogy on an m1r clone: hand-picked requests (requests/lineage) and a systematic sample per relationship type and status' },
  'g4.reuse-index': { run: pending('g4.reuse-index'), owner: 'N5' },
};
