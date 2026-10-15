// OWNER: N3
// The read path's goldens (IOS-SPEC §2.2, §8.5 N3).
//
//   g1.variants   server/text/variants.mjs generateVariants + variantsHash over en/fr/es/hi/gu words, phrases, hyphenated
//                 forms and the rule edge cases (CVC doubling, e-drop, y → ies, nukta, chandrabindu, Gujarati postpositions)
//   g1.translit   server/text/translit.mjs romanKey + translitMatch over Devanagari, Gujarati and Latin words of m1r's
//                 vocabulary and the §4.5 examples ("Shunya" ↔ शून्य)
//   g1.names      server/text/names.mjs nameFlag (rules a, a', b, c) on capitalized and lower-case tokens of m1r passages
//                 (demo + Cipher Gutenberg, public domain) and on titles with maker spans; authorTokens, nameIndex,
//                 splitMakerNames, documentNameRule
//   g1.kwic       server/text/kwic.mjs kwic(original, start, end, {window, clipStart, clipEnd}) on m1r passages
//   g3.read-m1r   the reference SERVER (node server.mjs on a cp -c clone of m1r, SCROLLS_NO_AUTO_IMPORT=1) replaying the plan
//                 requests/read/m1r.json over HTTP: search, expressions (tracked and counted by the reference's own
//                 materializer), timeline query → tiles L0–L5 → marks → shelves → bin pages → KWIC → passages →
//                 occurrences → documents → text slices, and exports. Every request and response is recorded in order;
//                 `scrolls-cli diff-read` replays the same requests in process on its own clone (InlineTextStore) after
//                 counting with the Swift engine.
//   g3.read-m5r   the same plan on m5r (milestone M2): declared, generated on request.
//
// G1 texts come only from collections with export_text_allowed = 1 (the synthetic demo, Cipher Gutenberg and Wikisource:
// public domain and CC BY-SA), so these families are committed. G3 is private (it is only useful next to the snapshot).

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { makeRedactor } from './lib/redact.mjs';
import { normalize } from './lib/normalize.mjs';

export const owner = 'N3';
export const group = 'read';

const GOLDEN = fileURLToPath(new URL('.', import.meta.url));

// ── deterministic sampling ─────────────────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(list, n, seed) {
  const r = mulberry32(seed);
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** A read-only connection on a fresh m1r clone; `fn(db, clone)` runs inside it. */
async function withM1r(ctx, fn) {
  const name = ctx.findSnapshot(['m1r']);
  if (!name) throw new Error('snapshot m1r is missing (~/Developer/scrolls-snapshots/m1r)');
  return ctx.withClone(name, async (clone) => {
    const db = new DatabaseSync(clone.db, { readOnly: true });
    try {
      ctx.inputs = { snapshot: name, sha256: ctx.snapshotInfo(name)?.files?.['scrolls.db']?.sha256 ?? null };
      return await fn(db, clone);
    } finally {
      db.close();
    }
  });
}

/** Vocabulary terms (folded FTS terms) of one script, by passage count, from m1r. */
function vocab(db, re, n, seed, minDocs = 2) {
  const rows = db.prepare('SELECT term, doc FROM passage_vocab_row WHERE doc >= ? ORDER BY doc DESC LIMIT 400000').all(minDocs);
  const terms = rows.map((r) => r.term).filter((t) => re.test(t));
  return sample(terms, n, seed);
}

// ── g1.variants ────────────────────────────────────────────────────────────────────────────────────────

const VARIANT_EDGES = [
  // en words: plurals, y → ies, sibilants, e-drop, CVC doubling, possessives, agents, irregular-looking forms
  ['hacker', 'en'], ['gene', 'en'], ['virus', 'en'], ['bank', 'en'], ['zero', 'en'], ['box', 'en'], ['church', 'en'],
  ['city', 'en'], ['day', 'en'], ['stop', 'en'], ['run', 'en'], ['make', 'en'], ['see', 'en'], ['agree', 'en'],
  ['hope', 'en'], ['admit', 'en'], ['visit', 'en'], ['travel', 'en'], ['quiz', 'en'], ['fix', 'en'], ['go', 'en'],
  ['a', 'en'], ['ai', 'en'], ['bus', 'en'], ['kiss', 'en'], ['wish', 'en'], ['fly', 'en'], ['play', 'en'],
  ['program', 'en'], ['machine', 'en'], ['algorithm', 'en'], ['quantum', 'en'], ['cafe', 'en'], ['café', 'en'],
  ['Hacker', 'en'], ['HACKER', 'en'], ["hacker's", 'en'], ['hackers', 'en'], ['data', 'en'], ['radio', 'en'],
  ['shy', 'en'], ['die', 'en'], ['lie', 'en'], ['tie', 'en'], ['canoe', 'en'], ['be', 'en'], ['x', 'en'],
  // en phrases
  ['carry the zero', 'en'], ['flux up', 'en'], ['ghost in the margin', 'en'], ['take it back', 'en'], ['make up', 'en'],
  ['the selfish gene', 'en'], ['hold my place', 'en'], ['run the numbers', 'en'], ['big bang', 'en'], ['go on', 'en'],
  // hyphenation
  ['e-mail', 'en'], ['hip-hop', 'en'], ['co-op', null], ['well–known', 'en'], ['x-ray', 'en'], ['data-base', 'en'],
  // fr / es
  ['zéro', 'fr'], ['machine', 'fr'], ['nouveau', 'fr'], ['bijou', 'fr'], ['cheval', 'fr'], ['fils', 'fr'], ['prix', 'fr'],
  ['banque', 'fr'], ['gène', 'fr'], ['virus', 'fr'], ['ami', 'fr'], ['grand', 'fr'], ['beau', 'fr'], ['travail', 'fr'],
  ['cero', 'es'], ['máquina', 'es'], ['banco', 'es'], ['gen', 'es'], ['ciudad', 'es'], ['luz', 'es'], ['virus', 'es'],
  ['niño', 'es'], ['amigo', 'es'], ['canción', 'es'], ['rey', 'es'], ['mes', 'es'], ['crisis', 'es'], ['lápiz', 'es'],
  // hi / gu, with and without an explicit language
  ['शून्य', 'hi'], ['शून्य', null], ['लड़का', 'hi'], ['लड़की', 'hi'], ['कमरा', 'hi'], ['किताब', 'hi'], ['नदी', 'hi'],
  ['ज़मीन', 'hi'], ['फ़िल्म', 'hi'], ['ख़बर', 'hi'], ['माँ', 'hi'], ['मां', 'hi'], ['गाँव', 'hi'], ['हँसी', 'hi'],
  ['राजा', 'hi'], ['घर', 'hi'], ['मशीन', 'hi'], ['बैंक', 'hi'], ['ग़ज़ल', 'hi'], ['क़लम', 'hi'], ['ड़', 'hi'],
  ['શૂન્ય', 'gu'], ['શૂન્ય', null], ['છોકરો', 'gu'], ['ઘર', 'gu'], ['નદી', 'gu'], ['ગામ', 'gu'], ['માં', 'gu'],
  ['પુસ્તક', 'gu'], ['રાજા', 'gu'], ['સંસાર', 'gu'], ['હઁસ', 'gu'], ['બેંક', 'gu'], ['મશીન', 'gu'],
  ['शून्य काल', 'hi'], ['घर घर', 'hi'], ['ઘર ઘર', 'gu'],
  // other languages and symbols: no variants
  ['zero', 'de'], ['zero', 'it'], ['zero', null], ['◉', null], ['42', 'en'], ['', 'en'], ['   ', 'en'], ['zero.', 'en'],
  ['Ζερο', 'el'], ['nul', 'la'], ['zero-sum', null], ['जीरो', 'en'], ['zero', 'EN'], ['zero', 'en-GB'],
];

async function variantCases(ctx) {
  const { generateVariants, variantsHash, scriptOfTokens, kindOfTokens } = await ctx.reference('server/text/variants.mjs');
  const { tokenize } = await ctx.reference('src/shared/tokenize.mjs');
  return withM1r(ctx, async (db) => {
    const words = [];
    const add = (surface, lang, kinds = null) => words.push({ surface, lang, kinds });
    for (const [s, l] of VARIANT_EDGES) add(s, l);
    for (const w of vocab(db, /^[a-z]{3,14}$/, 160, 11)) add(w, 'en');
    for (const w of vocab(db, /^[a-zàâçéèêëîïôûùüÿœæ]{3,14}$/, 50, 12)) add(w, 'fr');
    for (const w of vocab(db, /^[a-záéíóúñü]{3,14}$/, 50, 13)) add(w, 'es');
    for (const w of vocab(db, /^[ऀ-ॿ]{2,12}$/u, 90, 14)) add(w, 'hi');
    for (const w of vocab(db, /^[઀-૿]{2,12}$/u, 90, 15)) add(w, 'gu');
    for (const w of vocab(db, /^[ऀ-ॿ]{2,12}$/u, 20, 16)) add(w, null);
    const sentences = db.prepare(`SELECT p.document_id, p.field, p.start_off, p.end_off, dt.original FROM passage p
      JOIN document_text dt ON dt.document_id = p.document_id WHERE p.document_id IN (SELECT id FROM document
      WHERE collection_id = 1) AND p.field = 'body' ORDER BY p.id LIMIT 300`).all();
    for (const [i, p] of sample(sentences, 40, 17).entries()) {
      const toks = tokenize(p.original.slice(p.start_off, p.end_off)).tokens;
      if (toks.length < 3) continue;
      const k = 2 + (i % 3);
      add(toks.slice(0, k).join(' '), 'en');
    }
    // kinds filters (the materializer and the variant panel ask for one type)
    for (const s of ['hacker', 'शून्य', 'શૂન્ય', 'e-mail', 'carry the zero']) {
      add(s, s === 'शून्य' ? 'hi' : s === 'શૂન્ય' ? 'gu' : 'en', ['inflection']);
      add(s, s === 'शून्य' ? 'hi' : s === 'શૂન્ય' ? 'gu' : 'en', ['spelling', 'hyphenation']);
    }
    const cases = [];
    let i = 0;
    for (const w of words) {
      const out = generateVariants(w.surface, { lang: w.lang, kinds: w.kinds });
      const toks = tokenize(w.surface).tokens;
      const ident = toks.length ? [{ norm: toks.join(' '), lang: w.lang, enabled: true }] : [];
      cases.push({ id: `v${String(i++).padStart(4, '0')}`, surface: w.surface, lang: w.lang, kinds: w.kinds,
        script: toks.length ? scriptOfTokens(toks) : null, kind: toks.length ? kindOfTokens(toks) : null, out,
        hash: variantsHash([...ident, ...out.map((v) => ({ norm: v.norm, lang: v.lang, enabled: v.enabled }))]) });
    }
    return cases;
  });
}

// ── g1.translit ────────────────────────────────────────────────────────────────────────────────────────

const TRANSLIT_EDGES = ['shunya', 'Shunya', 'sunya', 'shoonya', 'shuniya', 'शून्य', 'શૂન્ય', 'kamal', 'कमल', 'लड़का', 'ladka',
  'larka', 'ज़मीन', 'zameen', 'jamin', 'फ़िल्म', 'film', 'gyan', 'ज्ञान', 'krishna', 'कृष्ण', 'ક્રિષ્ણ', 'Kṛṣṇa', 'rāma', 'राम',
  'ram', 'rama', 'raama', 'shiva', 'शिव', 'wish', 'vish', 'विष', 'zebra', 'jebra', 'quran', 'kuran', 'xerox', 'ksheer',
  'क्षीर', 'दुःख', 'dukh', 'duhkh', 'संसार', 'sansar', 'samsara', 'હઁસ', 'हँस', 'hans', 'अ', 'a', '', 'ab', 'abcd', 'ॐ',
  'Om', 'naïve', 'café', 'मशीन', 'machine', 'mashin', 'बैंक', 'bank', 'બેંક', 'ગામ', 'gaam', 'gam', 'घर', 'ghar', 'gar',
  'शून्यता', 'shunyata', 'आकाश', 'akash', 'aakaash', 'AKASH', 'ākāśa', 'ખ઼', '़', 'क़', 'qalam', 'क़लम', 'kalam'];

async function translitCases(ctx) {
  const { romanKey, translitMatch, MIN_KEY } = await ctx.reference('server/text/translit.mjs');
  return withM1r(ctx, async (db) => {
    const words = [...TRANSLIT_EDGES];
    words.push(...vocab(db, /^[ऀ-ॿ]+$/u, 700, 21));
    words.push(...vocab(db, /^[઀-૿]+$/u, 600, 22));
    words.push(...vocab(db, /^[a-z]{3,}$/, 500, 23));
    words.push(...vocab(db, /^[\p{Script=Latin}]+$/u, 150, 24).filter((w) => /[^a-z]/.test(w)));
    const keys = words.map((w) => romanKey(w));
    const cases = words.map((w, i) => ({ id: `k${String(i).padStart(4, '0')}`, word: w, key: keys[i] }));
    // match pairs: every pair of words that share a key, plus near misses (same first letter, different key)
    const byKey = new Map();
    words.forEach((w, i) => { const k = keys[i]; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(w); });
    let m = 0;
    for (const [k, ws] of byKey) {
      if (ws.length < 2) continue;
      for (let i = 0; i + 1 < ws.length && i < 4; i++) {
        cases.push({ id: `m${String(m++).padStart(4, '0')}`, a: ws[i], b: ws[i + 1], match: translitMatch(ws[i], ws[i + 1]), key: k });
      }
    }
    const r = mulberry32(25);
    for (let i = 0; i < 300; i++) {
      const a = words[Math.floor(r() * words.length)], b = words[Math.floor(r() * words.length)];
      cases.push({ id: `m${String(m++).padStart(4, '0')}`, a, b, match: translitMatch(a, b), key: null });
    }
    cases.push({ id: 'min-key', minKey: MIN_KEY });
    return cases;
  });
}

// ── g1.names ───────────────────────────────────────────────────────────────────────────────────────────

async function namesCases(ctx) {
  const names = await ctx.reference('server/text/names.mjs');
  const { tokenize } = await ctx.reference('src/shared/tokenize.mjs');
  return withM1r(ctx, async (db) => {
    const cases = [];
    let id = 0;
    const push = (c) => cases.push({ id: `n${String(id++).padStart(4, '0')}`, ...c });
    // body text: passages of the demo and of Cipher Gutenberg (public domain), every capitalized token plus a sample of
    // lower-case ones, with and without the document's author
    const docs = db.prepare(`SELECT d.id, d.author, d.collection_id FROM document d WHERE d.collection_id IN (1, 2)
      AND d.has_full_text = 1 AND d.deleted_at IS NULL ORDER BY d.id`).all();
    const picked = [...docs.filter((d) => d.collection_id === 1).slice(0, 40), ...sample(docs.filter((d) => d.collection_id === 2), 60, 31)];
    const passQ = db.prepare(`SELECT p.start_off, p.end_off FROM passage p WHERE p.document_id = ? AND p.field = 'body'
      AND p.field_class = 'text' ORDER BY p.ord LIMIT 400`);
    const origQ = db.prepare('SELECT original FROM document_text WHERE document_id = ?');
    const r = mulberry32(32);
    let budget = 1700;
    for (const d of picked) {
      if (budget <= 0) break;
      const original = origQ.get(d.id)?.original;
      if (!original) continue;
      const ps = sample(passQ.all(d.id), 4, 33 + d.id);
      for (const p of ps) {
        if (budget <= 0) break;
        const text = original.slice(p.start_off, p.end_off);
        if (text.length > 1600) continue;
        const t = tokenize(text);
        for (let k = 0; k < t.tokens.length && budget > 0; k++) {
          const raw = text.slice(t.starts[k], t.ends[k]);
          const cap = names.isCapitalized(raw);
          if (!cap && r() > 0.04) continue;
          const author = r() < 0.5 ? d.author : null;
          const clip = r() < 0.2 ? { clipStart: t.starts[Math.max(0, k - 1)], clipEnd: t.ends[Math.min(t.tokens.length - 1, k + 1)] } : {};
          push({ kind: 'body', text, start: t.starts[k], end: t.ends[k], author, ...clip,
            flag: names.nameFlag(text, t.starts[k], t.ends[k], { author, ...clip }) });
          budget--;
        }
      }
    }
    // the rule edges (§4.5 and the fix pass)
    const edges = [
      ['I met Gene Kelly yesterday.', 'Gene'], ['The selfish gene is a book.', 'gene'], ['for Gene Halloran, the clerk', 'Gene'],
      ["If 'Gene heard of it, he said nothing.", 'Gene'], ["'Gene's mother came in.", 'Gene'], ['I met Gene. Kelly left.', 'Gene'],
      ['Gene went home.', 'Gene'], ['They saw The Gene at noon.', 'Gene'], ['They said “Gene” was gone.', 'Gene'],
      ['a Zero Hour broadcast', 'Zero'], ['shunya and शून्य', 'शून्य'], ['by Virus and others', 'Virus'],
      ['de Gener. is an abbreviation', 'Gener'], ['Mr. Bank of England', 'Bank'], ['the Bank of England', 'Bank'],
      ['she read The Machine Stops', 'Machine'], ['IN ALL CAPS ZERO HERE', 'ZERO'], ['Ζήνων Ζερο', 'Ζερο'],
    ];
    for (const [text, word] of edges) {
      const s = text.indexOf(word);
      for (const author of [null, 'Gene Kelly', 'Virus; Kelly', 'तुलसीदास']) {
        push({ kind: 'body', text, start: s, end: s + word.length, author, flag: names.nameFlag(text, s, s + word.length, { author }) });
      }
      push({ kind: 'phrase', text, start: s, end: text.length, author: null, flag: names.nameFlag(text, s, text.length, {}) });
    }
    // titles: culture works with their own makers and a maker index of the corpus's counted collections
    const makerRows = db.prepare(`SELECT DISTINCT t.value FROM doc_tag t JOIN document d ON d.id = t.document_id
      WHERE t.scheme = 'maker' AND d.collection_id = 5 LIMIT 60000`).all().map((x) => x.value);
    const index = names.nameIndex(makerRows);
    const titles = sample(db.prepare(`SELECT d.id, d.title, d.author FROM document d WHERE d.collection_id = 5 AND d.title IS NOT NULL
      LIMIT 60000`).all(), 400, 34);
    titles.push({ id: 0, title: 'Gene Kelly Live', author: null }, { id: 0, title: 'Zero Dark Thirty', author: null },
      { id: 0, title: 'Ground Zero', author: null }, { id: 0, title: 'Madonna', author: 'Madonna' },
      { id: 0, title: 'Virus', author: 'Someone Else' }, { id: 0, title: 'Love Affair', author: null });
    for (const w of titles) {
      const t = tokenize(w.title);
      if (!t.tokens.length) continue;
      // the subset of the index that can be found inside this title (every n-gram of ≤ maxTokens tokens)
      const inTitle = [];
      for (let a = 0; a < t.tokens.length; a++) {
        for (let len = 1; len <= index.maxTokens && a + len <= t.tokens.length; len++) {
          const g = t.tokens.slice(a, a + len).join(' ');
          if (index.set.has(g) && !inTitle.includes(g)) inTitle.push(g);
        }
      }
      if (w.title === 'Gene Kelly Live' && !inTitle.includes('gene kelly')) inTitle.push('gene kelly');
      const nameIdx = { set: new Set(inTitle), maxTokens: index.maxTokens };
      for (let k = 0; k < t.tokens.length; k++) {
        push({ kind: 'title', text: w.title, start: t.starts[k], end: t.ends[k], author: w.author ?? null,
          names: { names: inTitle, maxTokens: index.maxTokens },
          flag: names.nameFlag(w.title, t.starts[k], t.ends[k], { author: w.author ?? null, fieldClass: 'title', names: nameIdx }) });
      }
    }
    // helpers
    for (const a of ['Gene Kelly', 'Kelly, Gene; Virus', 'MC Ledgerline (synthetic)', 'तुलसीदास', null, '', 'J. R. R. Tolkien',
      'Bach, Johann Sebastian', 'Madonna & The Band', 'feat. Someone']) {
      push({ kind: 'authorTokens', author: a, tokens: [...names.authorTokens(a)] });
      if (a) push({ kind: 'splitMakerNames', raw: a, out: names.splitMakerNames(a) });
    }
    const sample50 = sample(makerRows, 50, 35);
    const ix = names.nameIndex(sample50);
    push({ kind: 'nameIndex', input: sample50, names: [...ix.set], maxTokens: ix.maxTokens });
    for (const d of [{ flagged: 3, lower: 0, capitalized: 1 }, { flagged: 2, lower: 0, capitalized: 5 }, { flagged: 5, lower: 1, capitalized: 5 },
      { flagged: 3, lower: 0, capitalized: 0 }, { flagged: 9, lower: 0, capitalized: 2 }]) {
      push({ kind: 'documentNameRule', input: d, out: names.documentNameRule(d) });
    }
    for (const s of ['Gene', 'gene', 'GENE', 'ǅemal', 'शून्य', '42', 'Ζερο', 'ßtraße', '']) {
      push({ kind: 'classes', raw: s, capitalized: names.isCapitalized(s), caseless: names.isCaseless(s) });
    }
    return cases;
  });
}

// ── g1.kwic ────────────────────────────────────────────────────────────────────────────────────────────

async function kwicCases(ctx) {
  const { kwic } = await ctx.reference('server/text/kwic.mjs');
  const { tokenize } = await ctx.reference('src/shared/tokenize.mjs');
  return withM1r(ctx, async (db) => {
    const cases = [];
    const r = mulberry32(41);
    const rows = db.prepare(`SELECT p.id, p.document_id, p.start_off, p.end_off, d.collection_id FROM passage p JOIN document d
      ON d.id = p.document_id WHERE p.field = 'body' AND d.collection_id IN (1, 2, 3, 4) AND p.end_off - p.start_off BETWEEN 20 AND 1500
      AND p.id % 97 = 0 LIMIT 20000`).all();
    const origQ = db.prepare('SELECT original FROM document_text WHERE document_id = ?');
    const picked = [...rows.filter((x) => x.collection_id === 1).slice(0, 120), ...sample(rows.filter((x) => x.collection_id !== 1), 600, 42)];
    let i = 0;
    for (const p of picked) {
      const original = origQ.get(p.document_id)?.original;
      if (!original) continue;
      // a region around the passage: the passage plus up to 200 units on each side (the clip test needs both)
      const lo = Math.max(0, p.start_off - 200), hi = Math.min(original.length, p.end_off + 200);
      const region = original.slice(lo, hi);
      const clipStart = p.start_off - lo, clipEnd = p.end_off - lo;
      const t = tokenize(region.slice(clipStart, clipEnd));
      if (!t.tokens.length) continue;
      const a = Math.floor(r() * t.tokens.length);
      const len = 1 + Math.floor(r() * Math.min(3, t.tokens.length - a));
      const start = clipStart + t.starts[a], end = clipStart + t.ends[a + len - 1];
      const window = [12, 12, 12, 5, 0, 1, 30][i % 7];
      const clipped = i % 5 !== 4;
      const opts = clipped ? { window, clipStart, clipEnd } : { window };
      cases.push({ id: `w${String(i++).padStart(4, '0')}`, text: region, start, end, ...opts, out: kwic(region, start, end, opts) });
    }
    // edges: empty matches, matches at the bounds, surrogate pairs, Indic text, a match outside the clip
    const edges = [
      ['carry the zero', 6, 9, {}], ['carry the zero', 0, 0, {}], ['carry the zero', 14, 14, {}], ['a 😀 b c', 2, 4, { window: 1 }],
      ['शून्य से शुरू करो', 0, 5, { window: 2 }], ['x y z', 2, 3, { window: 12, clipStart: 2, clipEnd: 3 }],
      ['one two three four five', 4, 7, { window: 1, clipStart: 8, clipEnd: 23 }], ['   ', 1, 2, {}],
      ['Zero. Zero! Zero?', 6, 10, { window: 1 }], ['word', 0, 4, { window: 0 }],
    ];
    for (const [text, start, end, opts] of edges) {
      cases.push({ id: `e${String(i++).padStart(4, '0')}`, text, start, end, ...opts, out: kwic(text, start, end, opts) });
    }
    return cases;
  });
}

// ── g3: the reference server replaying a plan ──────────────────────────────────────────────────────────

const BOOT_TIMEOUT_MS = 180000;
const FINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bootServer(refRoot, dataDir, logFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(refRoot, 'server.mjs')], { cwd: refRoot, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SCROLLS_DATA: dataDir, SCROLLS_PORT: '0', SCROLLS_NO_AUTO_IMPORT: '1', SCROLLS_MOCK: '0',
        SCROLLS_LOG_LEVEL: 'warn' } });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`no "listening" line in ${BOOT_TIMEOUT_MS / 1000} s; see ${logFile}`)); }, BOOT_TIMEOUT_MS);
    child.stderr.setEncoding('utf8').on('data', (c) => appendFileSync(logFile, c));
    child.stdout.setEncoding('utf8').on('data', (c) => {
      appendFileSync(logFile, c);
      out += c;
      const line = out.split('\n').find((l) => l.startsWith('{') && l.includes('"listening"'));
      if (line) { clearTimeout(timer); resolve({ child, url: JSON.parse(line).url }); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}) before listening; see ${logFile}`)); });
  });
}

function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.once('exit', () => { clearTimeout(kill); resolve(); });
    child.kill('SIGTERM');
  });
}

/** `path?query` from a path and a parameter object (null/undefined parameters are left out; order kept). */
export function withQuery(path, params = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

/** Normalisation of a recorded response: timestamps, data versions and job ids (job ids depend on boot-time jobs). */
export function normalizeBody(body) {
  return normalize(body, { maskKeys: [] });
}

const TS_IN_TEXT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

/** A non-JSON body (CSV, JSONL, SVG) as compared: JSONL lines parsed and normalised, CSV with timestamps masked. */
function textBody(contentType, text) {
  if (/jsonl|ndjson/.test(contentType)) {
    return { jsonl: text.split('\n').filter((l) => l.length).map((l) => { try { return normalizeBody(JSON.parse(l)); } catch { return l; } }) };
  }
  if (/csv/.test(contentType)) return { csv: text.replace(TS_IN_TEXT, '<ts>').replace(/"data_version":\d+/g, '"data_version":"<dv>"') };
  return { text: text.length > 20000 ? { sha256: null, len: text.length } : text };
}

/** Redacts restricted text in a response body (collections with export_text_allowed = 0, §2.6). */
function redactBody(body, redactor) {
  if (!redactor.restricted.length) return body;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const coll = typeof v.collection === 'string' ? v.collection : null;
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (coll && !redactor.isOpen(coll) && typeof x === 'string' && ['text', 'left', 'match', 'right', 'quote'].includes(k)) out[k] = redactor.text(coll, x);
        else out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(body);
}

/** The binning of the reference (L0–L3 by year, L4 months, L5 days) for tile planning. */
async function binning(ctx) {
  const dates = await ctx.reference('src/shared/dates.mjs');
  const washes = await ctx.reference('server/aggregate/washes.mjs');
  const TILE = washes.TILE_BINS ?? 64;
  const tileOfYear = (y, level) => Math.floor(dates.binOf(y, level) / TILE);
  const tileOfDay = (day, tier) => {
    const ymd = dates.ymdFromDay ? dates.ymdFromDay(day) : null;
    const y = ymd ? ymd.y ?? ymd[0] : null;
    return Math.floor(washes.binOfDay(day, y, tier) / TILE);
  };
  return { TILE, tileOfYear, tileOfDay };
}

/** Runs one plan against a booted server; returns the recorded cases. */
async function runPlan(ctx, plan, base, redactor) {
  const cases = [];
  const vars = {};
  let seq = 0;
  const bins = await binning(ctx);
  const vs = await ctx.reference('src/shared/viewstate.mjs');
  const resolve = (v) => {
    if (typeof v === 'string' && v.startsWith('$')) {
      const k = v.slice(1);
      if (!(k in vars)) throw new Error(`plan: unknown variable ${v}`);
      return vars[k];
    }
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };
  async function http(method, path, body, { record = true, step = null, wait = null } = {}) {
    const headers = { 'X-Scrolls-Session': 'g3-read' };
    if (method !== 'GET') { headers.Origin = base; headers['Content-Type'] = 'application/json'; }
    let res, text;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(300000) });
      text = await res.text();
      // a heavy read over the deadline on a loaded machine: the request is repeated (and never recorded as a timeout)
      if (res.status === 503 && /QUERY_TIMEOUT/.test(text)) { await sleep(2000); continue; }
      break;
    }
    const ct = res.headers.get('content-type') ?? '';
    let json = null;
    if (/json/.test(ct) && !/jsonl|ndjson/.test(ct)) { try { json = JSON.parse(text); } catch { json = null; } }
    if (record) {
      const c = { id: `${plan.snapshot}-${String(seq++).padStart(4, '0')}`, step, method, path, ...(body !== undefined ? { body } : {}),
        status: res.status };
      if (json !== null) c.response = normalizeBody(redactBody(json, redactor));
      else c.response = { content_type: ct.split(';')[0], rows: res.headers.get('x-scrolls-rows'),
        disposition: res.headers.get('content-disposition'), ...textBody(ct, text) };
      if (wait) c.wait = wait;
      cases.push(c);
    }
    return { status: res.status, json, text };
  }
  async function waitJob(id) {
    const until = Date.now() + 1800000;
    for (;;) {
      const r = await http('GET', `/api/jobs/${id}`, undefined, { record: false });
      if (r.status !== 200) throw new Error(`job ${id}: HTTP ${r.status}`);
      if (FINAL.has(r.json.status)) return r.json;
      if (Date.now() > until) throw new Error(`job ${id} still ${r.json.status}`);
      await sleep(250);
    }
  }

  for (const [n, step] of plan.steps.entries()) {
    const name = step.name ?? `step ${n}`;
    const t0 = Date.now();
    if (step.search) {
      await http('GET', withQuery('/api/search', resolve(step.search)), undefined, { step: name });
    } else if (step.track) {
      const r = await http('POST', '/api/expressions', resolve(step.track), { step: name, wait: 'materialize' });
      if (r.status !== 200) throw new Error(`${name}: track HTTP ${r.status} ${r.text.slice(0, 200)}`);
      const id = r.json.expression.id;
      if (step.as) vars[step.as] = id;
      if (r.json.state?.job) {
        const j = await waitJob(r.json.state.job);
        if (j.status !== 'succeeded') throw new Error(`${name}: materialize job ${j.id} ${j.status}`);
      }
      await http('GET', withQuery(`/api/expressions/${id}`, { corpus: step.track.corpus }), undefined, { step: name });
    } else if (step.expression) {
      await http('GET', withQuery(`/api/expressions/${resolve(step.expression)}`, step.query ?? {}), undefined, { step: name });
    } else if (step.variants) {
      const id = resolve(step.variants.id);
      const r0 = await http('GET', `/api/expressions/${id}`, undefined, { record: false });
      const vs = r0.json.variants.filter((v) => step.variants.forms.includes(v.form));
      const body = { variants: vs.map((v) => ({ id: v.id, enabled: step.variants.enabled })) };
      const r = await http('PATCH', `/api/expressions/${id}/variants`, body, { step: name, wait: 'materialize' });
      if (r.json?.state?.job) await waitJob(r.json.state.job);
      await http('GET', `/api/expressions/${id}`, undefined, { step: name });
    } else if (step.query) {
      await probeQuery(step, name);
    } else if (step.request) {
      const q = resolve(step.request);
      await http(q.method ?? 'GET', withQuery(q.path, q.query ?? {}), q.body, { step: name });
    } else {
      throw new Error(`plan: step ${n} has no action`);
    }
    ctx.log(`${plan.snapshot} ${name}: ${Date.now() - t0} ms`);
  }

  /** A timeline query and everything a reader opens from it. */
  async function probeQuery(step, name) {
    const body = resolve(step.query);
    const r = await http('POST', '/api/timeline/query', body, { step: name });
    if (r.status !== 200) return;
    const q = r.json;
    if (q.status !== 'ready') throw new Error(`${name}: query ${q.status} (counting should have finished)`);
    const key = q.queryKey;
    const probe = step.probe ?? {};
    // tiles: the extent at L0–L3; at L4/L5 the tiles of the first and last observations
    const fromY = q.extent?.from_day !== null && q.extent?.from_day !== undefined ? yearOfLabel(q.extent.from) : null;
    const toY = q.extent?.to_day !== null && q.extent?.to_day !== undefined ? yearOfLabel(q.extent.to) : null;
    if (fromY !== null && toY !== null) {
      for (const [level, tier] of ['L0', 'L1', 'L2', 'L3'].entries()) {
        if (probe.tiers && !probe.tiers.includes(tier)) continue;
        const a = bins.tileOfYear(fromY, level), b = bins.tileOfYear(toY, level);
        const spec = b - a > 40 ? `${a}..${a + 40}` : a === b ? String(a) : `${a}..${b}`;
        await http('GET', withQuery('/api/timeline/tiles', { q: key, tier, tiles: spec }), undefined, { step: name });
      }
      for (const tier of ['L4', 'L5']) {
        if (probe.tiers && !probe.tiers.includes(tier)) continue;
        const ts = new Set([bins.tileOfDay(q.extent.from_day, tier), bins.tileOfDay(q.extent.to_day, tier)]);
        await http('GET', withQuery('/api/timeline/tiles', { q: key, tier, tiles: [...ts].sort((x, y) => x - y).join(',') }), undefined, { step: name });
      }
    }
    if (probe.minimal) return;
    // marks: the whole range (capped) and one lane's first decade
    const marks = await http('GET', withQuery('/api/timeline/marks', { q: key, limit: probe.marks ?? 300 }), undefined, { step: name });
    const lane0 = q.lanes?.[0]?.key ?? null;
    if (lane0 && fromY !== null) {
      await http('GET', withQuery('/api/timeline/marks', { q: key, from: fromY, to: fromY + 9, lane: lane0, limit: 4000 }), undefined, { step: name });
    }
    // shelves
    for (const which of ['undated', 'scheduled', 'washes']) {
      const s = await http('GET', withQuery('/api/timeline/shelf', { q: key, which, tier: 'L2', limit: 50 }), undefined, { step: name });
      if (which === 'undated' && s.json?.cursor) {
        await http('GET', withQuery('/api/timeline/shelf', { q: key, which, tier: 'L2', limit: 50, cursor: s.json.cursor }), undefined, { step: name });
      }
    }
    // bin pages of the first lane's first observed decade (and its second page)
    if (lane0 && q.lanes[0].first) {
      const y = yearOfLabel(q.lanes[0].first.label);
      if (y !== null) {
        const bin = Math.floor(y / 10);
        const strand = Object.keys(q.lanes[0].strands ?? {})[0] ?? null;
        const b = await http('GET', withQuery('/api/timeline/bin', { q: key, lane: lane0, strand, tier: 'L2', bin, limit: 20 }), undefined, { step: name });
        if (b.json?.cursor) {
          await http('GET', withQuery('/api/timeline/bin', { q: key, lane: lane0, strand, tier: 'L2', bin, limit: 20, cursor: b.json.cursor }), undefined, { step: name });
        }
      }
    }
    // KWIC of the query's slice, and of the expression alone
    const expr = body.strands?.find((s) => s.type === 'expression')?.ref ?? null;
    if (expr !== null) {
      const k = await http('GET', withQuery('/api/kwic', { q: key, expr, limit: 25, sort: probe.sort ?? 'date' }), undefined, { step: name });
      if (k.json?.cursor) await http('GET', withQuery('/api/kwic', { q: key, expr, limit: 25, cursor: k.json.cursor }), undefined, { step: name });
      if (probe.kwicSpread) await http('GET', withQuery('/api/kwic', { expr, limit: 25, sort: 'spread' }), undefined, { step: name });
    }
    // passages, occurrences and documents of a sample of marks
    const ms = marks.json?.marks ?? [];
    const pick = [ms[0], ms[Math.floor(ms.length / 2)], ms[ms.length - 1]].filter(Boolean);
    const seen = new Set();
    for (const [i, m] of pick.entries()) {
      if (seen.has(m.passage)) continue;
      seen.add(m.passage);
      await http('GET', withQuery(`/api/passages/${m.passage}`, i === 0 ? { context: 1, expr } : { expr, occ: m.occ ?? undefined }), undefined, { step: name });
      if (i === 0 && m.occ) await http('GET', `/api/occurrences/${m.occ}`, undefined, { step: name });
      if (i < 2) {
        await http('GET', `/api/documents/${m.doc}`, undefined, { step: name });
        await http('GET', withQuery(`/api/documents/${m.doc}/text`, i === 0 ? { from: 0, to: 600 } : {}), undefined, { step: name });
      }
    }
    for (const ex of probe.exports ?? []) {
      const state = viewState(vs, body);
      await http('GET', withQuery('/api/export', { state, what: ex.what, format: ex.format, tier: ex.tier }), undefined, { step: name });
    }
  }
  return cases;
}

/** The year of a date label of the reference ("1911", "c. 1894", "500 BCE", "17 May 1994", "1990s" …), or null. */
function yearOfLabel(label) {
  if (typeof label !== 'string') return null;
  const bce = /BCE/.test(label);
  const m = /(\d{1,5})(?!.*\d)/.exec(label.replace(/s$/, ''));
  if (!m) return null;
  const y = Number(m[1]);
  return bce ? 1 - y : y;
}

/** The ViewState of a timeline query body, encoded by the reference's own viewstate.mjs (exports take `state=`). */
function viewState(vs, body) {
  const s = vs.defaultState(body.corpus);
  s.strands = body.strands.map((x) => ({ type: x.type, id: x.ref, variants: 'default', glyph: 'circle' }));
  if (body.lanes?.facet) s.lanes.facet = body.lanes.facet;
  if (body.lanes?.order) s.lanes.order = body.lanes.order;
  if (body.lanes?.max) s.lanes.max = body.lanes.max;
  if (body.f) s.f = vs.parseFilter(body.f);
  for (const [k, v] of Object.entries(body.toggles ?? {})) s.toggles[k] = v;
  return vs.encode(s);
}

async function g3(ctx, snapshot) {
  const planFile = join(GOLDEN, 'requests', 'read', `${snapshot}.json`);
  if (!existsSync(planFile)) throw new Error(`g3.read-${snapshot}: no plan ${planFile}`);
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  plan.snapshot = snapshot;
  const name = ctx.findSnapshot([snapshot]);
  if (!name) throw new Error(`g3.read-${snapshot}: snapshot ${snapshot} is missing`);
  const clone = ctx.cloneSnapshot(name);
  const logFile = join(clone.dir, 'server.log');
  let server = null;
  try {
    const ro = new DatabaseSync(clone.db, { readOnly: true });
    const redactor = makeRedactor(ro);
    ro.close();
    server = await bootServer(ctx.refRoot, clone.dir, logFile);
    ctx.log(`g3.read-${snapshot}: reference server at ${server.url} on ${clone.dir}`);
    const cases = await runPlan(ctx, plan, server.url, redactor);
    ctx.inputs = { snapshot: name, sha256: ctx.snapshotInfo(name)?.files?.['scrolls.db']?.sha256 ?? null,
      plan: `requests/read/${snapshot}.json`, server: 'node server.mjs (SCROLLS_NO_AUTO_IMPORT=1, SCROLLS_PORT=0)' };
    return cases;
  } catch (e) {
    if (existsSync(logFile)) ctx.log(`server log tail:\n${readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n')}`);
    throw e;
  } finally {
    await stopServer(server?.child);
    clone.cleanup();
  }
}

const TEXT_ATTRIBUTION = ['Synthetic demonstration corpus (CC0)', 'Project Gutenberg texts via Cipher: public domain (US)',
  'Wikisource (hi, gu) via Cipher: CC BY-SA'];

export const families = {
  'g1.variants': { run: variantCases, owner: 'N3', note: 'generateVariants + variantsHash; exact' },
  'g1.translit': { run: translitCases, owner: 'N3', note: 'romanKey + translitMatch; exact' },
  'g1.names': { run: namesCases, owner: 'N3', attribution: TEXT_ATTRIBUTION,
    note: 'nameFlag (rules a, a\', b, c), authorTokens, splitMakerNames, nameIndex, documentNameRule; exact' },
  'g1.kwic': { run: kwicCases, owner: 'N3', attribution: TEXT_ATTRIBUTION, note: 'kwic(original, start, end, opts); exact' },
  'g3.read-m1r': { run: (ctx) => g3(ctx, 'm1r'), owner: 'N3', private: true, tier: 'g3',
    note: 'the reference server replaying requests/read/m1r.json; exact after timestamp, data-version and job-id normalisation' },
  'g3.read-m5r': { run: (ctx) => g3(ctx, 'm5r'), owner: 'N3', private: true, tier: 'g3',
    note: 'the same plan family on m5r (milestone M2)' },
};
