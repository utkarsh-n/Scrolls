// OWNER: WP0 — tokenizer u61m-1 (§4.3): folding, offsets, helpers, and JS ↔ FTS5 parity (FTS token i = JS token i)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  TOKENIZER_VERSION, FTS_TOKENIZE, foldToken, tokenize, normString, findSequence, ftsPhrase, isSentenceInitial,
} from '../src/shared/tokenize.mjs';
import { mulberry32 } from '../src/shared/ids.mjs';
import { check } from '../src/shared/contracts.mjs';

const MINI_DOCS = readFileSync(new URL('./fixtures/mini/documents.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));
const MINI_EXPECTED = JSON.parse(readFileSync(new URL('./fixtures/mini/expected.json', import.meta.url), 'utf8'));

const EDGE_STRINGS = [
  "Carry the zero: it holds the place — don't!",
  'naïve café écrivaient ſo ß İstanbul ǅemal',
  'ગુજરાતી શૂન્ય ૧૯૮૭ નિશાળમાં',
  'शून्य क़लम क़लम ४२ क्‍षण ज़ि‌द चाँद। बात॥',
  '◉ kiln eye ⊙ not a token ◉◉',
  '❤️ \u{1F44D}\u{1F3FD} \u{1F468}‍\u{1F469}‍\u{1F467} 1️⃣ \u{1FAE8}',
  'a᙭b \u{1F3AC}film',
  'co­operate ­lead trail­',
  'line one\r\nline two\r\n\r\npara two',
  'pages\fjoined\f\fhere',
  '_italics_ and [Illustration: a ◉] (1903)',
  '́ lone mark,  private use, ½ ² Ⅷ',
  'l’école qu’il cœur leçon ¿Quién? ¡Nadie!',
  'MC Ledgerline (synthetic) — 17 May 1994',
];

test('version and FTS tokenize string are the fixed contract', () => {
  assert.equal(TOKENIZER_VERSION, 'u61m-1');
  assert.equal(FTS_TOKENIZE, "unicode61 remove_diacritics 2 categories 'L* N* Co M* So'");
});

test('foldToken: NFC, locale-independent lower case, Indic digits, invisible characters removed', () => {
  assert.equal(foldToken('Zero'), 'zero');
  assert.equal(foldToken('ZÉRO'), 'zéro');
  assert.equal(foldToken('écrivaient'), 'écrivaient');
  assert.equal(foldToken('४२'), '42');
  assert.equal(foldToken('૧૯૮૭'), '1987');
  assert.equal(foldToken('क्‍ष'), 'क्ष');
  assert.equal(foldToken('ज़ि‌द'.normalize('NFC')), 'ज़िद'.normalize('NFC'));
  assert.equal(foldToken('co­op'), 'coop');
  assert.equal(foldToken('İ'), 'i̇');
  assert.equal(foldToken('क़'), 'क़', 'precomposed nukta letters are NFC-decomposed');
  assert.equal(foldToken('ſ'), 'ſ', 'long s is kept (FTS folds it, analysis does not)');
});

test('tokenize: tokens, UTF-16 offsets and the fold(slice) invariant', () => {
  const t = tokenize("Carry the zero: it holds the place — don't!");
  assert.deepEqual(t.tokens, ['carry', 'the', 'zero', 'it', 'holds', 'the', 'place', 'don', 't']);
  assert.ok(t.starts instanceof Int32Array && t.ends instanceof Int32Array);
  assert.deepEqual(Array.from(t.starts), [0, 6, 10, 16, 19, 25, 29, 37, 41]);
  assert.deepEqual(Array.from(t.ends), [5, 9, 14, 18, 24, 28, 34, 40, 42]);
  const cases = [
    ['◉◉ a◉b', ['◉', '◉', 'a', '◉', 'b']],
    ['❤️!', ['❤️']],
    ['\u{1F44D}\u{1F3FD}', ['\u{1F44D}']],
    ['\u{1F468}‍\u{1F469}', ['\u{1F468}', '\u{1F469}']],
    ['a᙭b', ['a', 'b']],
    ['⊙ sum', ['sum']],
    ['क्‍षण', ['क्षण']],
    ['co­operate', ['cooperate']],
    ['­x', ['x']],
    ['cold-wire cold wire coldwire', ['cold', 'wire', 'cold', 'wire', 'coldwire']],
    ['१९७१ ૧૨ 42', ['1971', '12', '42']],
    ['½ ² Ⅷ', ['½', '²', 'ⅷ']],
    ['', []],
    ['  ,;. ', []],
  ];
  for (const [s, toks] of cases) assert.deepEqual(tokenize(s).tokens, toks, JSON.stringify(s));
  for (const s of [...EDGE_STRINGS, ...MINI_DOCS.map((d) => d.text?.original ?? '')]) {
    const r = tokenize(s);
    for (let i = 0; i < r.tokens.length; i++) {
      assert.equal(foldToken(s.slice(r.starts[i], r.ends[i])), r.tokens[i], `${JSON.stringify(s)} token ${i}`);
      assert.ok(r.starts[i] < r.ends[i] && (i === 0 || r.ends[i - 1] <= r.starts[i]), 'ordered, non-overlapping');
      assert.ok(r.tokens[i].length > 0 || /^\p{M}+$/u.test(s.slice(r.starts[i], r.ends[i])), 'non-empty');
    }
    assert.equal(normString(s), r.tokens.join(' '));
  }
});

test('findSequence and ftsPhrase', () => {
  const toks = tokenize('Carry the zero, children: carry the zero again').tokens;
  assert.equal(findSequence(toks, ['carry', 'the', 'zero']), 0);
  assert.equal(findSequence(toks, ['carry', 'the', 'zero'], 1), 4);
  assert.equal(findSequence(toks, ['carry', 'the', 'one']), -1);
  assert.equal(findSequence(toks, []), -1);
  assert.equal(findSequence(toks, ['again']), 7);
  assert.equal(findSequence(toks, ['again', 'and']), -1);
  assert.equal(ftsPhrase(['carry', 'the', 'zero']), '"carry the zero"');
  assert.equal(ftsPhrase('Carry the ZERO!'), '"carry the zero"');
  assert.equal(ftsPhrase(['a"b']), '"a""b"');
  assert.throws(() => ftsPhrase([]), RangeError);
  assert.throws(() => ftsPhrase('—'), RangeError);
});

test('isSentenceInitial (proper-noun guard boundaries)', () => {
  const at = (s, word) => isSentenceInitial(s, s.indexOf(word));
  assert.equal(at('Gene Kelly danced.', 'Gene'), true);
  assert.equal(at('He left. Gene Kelly danced.', 'Gene'), true);
  assert.equal(at('He said "Stop." Then he left.', 'Then'), true);
  assert.equal(at('¿Quién? Nadie.', 'Nadie'), true);
  assert.equal(at('शून्य है। बात', 'बात'), true);
  assert.equal(at('first para\n\nSecond para', 'Second'), true);
  assert.equal(at('first para\r\n\r\nSecond para', 'Second'), true);
  assert.equal(at('page one\fNext page', 'Next'), true);
  assert.equal(at('the selfish Gene of the account', 'Gene'), false);
  assert.equal(at('Dr. Varn said so', 'Varn'), false);
  assert.equal(at('J. R. Ostlund wrote', 'Ostlund'), false);
  assert.equal(at('a hard-wrapped line that names\nBennet in the middle', 'Bennet'), false);
  assert.equal(at('Carry the zero: It holds', 'It'), false);
});

/** In-memory FTS5 table with the contract tokenizer; returns helpers to read instance terms per row. */
function ftsTable() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE t USING fts5(norm, content='', contentless_delete=1, detail=full, tokenize="${FTS_TOKENIZE}")`);
  db.exec('CREATE VIRTUAL TABLE v USING fts5vocab(t, instance)');
  db.exec('BEGIN');   // one transaction for the whole in-memory table: reads see their own writes, inserts stay fast
  const ins = db.prepare('INSERT INTO t(rowid, norm) VALUES (?, ?)');
  const terms = db.prepare('SELECT term, offset FROM v WHERE doc = ? AND col = ? ORDER BY offset');
  const del = db.prepare('DELETE FROM t WHERE rowid = ?');
  let next = 1;
  return {
    db,
    add(text) { const id = next++; ins.run(id, text); return id; },
    terms(id) { return terms.all(id, 'norm'); },
    /** Read a row's terms and drop it, so instance scans stay small. */
    take(id) { const r = terms.all(id, 'norm'); del.run(id); return r; },
  };
}

/** Assert FTS indexes normString(text) as exactly the JS tokens, in order, one FTS token per JS token. */
function assertParity(fts, termOf, text, label) {
  const { tokens } = tokenize(text);
  const rows = fts.take(fts.add(tokens.join(' ')));
  assert.equal(rows.length, tokens.length, `${label}: FTS ${rows.length} tokens vs JS ${tokens.length}`);
  rows.forEach((r, i) => assert.equal(r.offset, i, `${label}: contiguous positions`));
  for (let i = 0; i < tokens.length; i++) {
    if (!termOf.has(tokens[i])) {
      const single = fts.take(fts.add(tokens[i]));
      assert.equal(single.length, 1, `${label}: JS token ${JSON.stringify(tokens[i])} is ${single.length} FTS tokens`);
      termOf.set(tokens[i], single[0].term);
    }
    assert.equal(rows[i].term, termOf.get(tokens[i]), `${label}: token ${i} ${JSON.stringify(tokens[i])}`);
  }
  return tokens.length;
}

test('FTS5 parity on the mini corpus, its metadata fields and edge cases', () => {
  const fts = ftsTable(), termOf = new Map();
  let n = 0;
  for (const d of MINI_DOCS) {
    if (d.text) n += assertParity(fts, termOf, d.text.original, d.ext_id);
    for (const [k, v] of Object.entries(d.fields ?? {})) n += assertParity(fts, termOf, v, `${d.ext_id}.${k}`);
  }
  for (const s of EDGE_STRINGS) n += assertParity(fts, termOf, s, JSON.stringify(s));
  assert.ok(n > 450, `${n} tokens compared`);
  // FTS adds accent-insensitivity on top of the JS fold, nothing else
  assert.equal(termOf.get('zéro'), 'zero');
  assert.equal(termOf.get('ſaid'), 'said');
  assert.equal(termOf.get('ગુજરાતી'), 'ગુજરાતી');
  assert.equal(termOf.get('शून्य'), 'शून्य');
  assert.equal(termOf.get('◉'), '◉');
});

test('FTS5 parity on 10,000 random strings of hard characters', () => {
  const rnd = mulberry32(1994);
  const alphabet = [...'abcXYZéÉñçœſßİ', 'é', 'शू', 'न्य', 'क़', 'क़', 'ँ', '।', 'ગુ', 'જ', 'ા', '૧', '४', '7',
    '◉', '⊙', '❤', '️', '\u{1F44D}', '\u{1F3FD}', '\u{1F3AC}', '‍', '‌', '­', '᙭',
    '́', '', '½', 'Ⅷ', ' ', ' ', ' ', '\n', '\r\n', '\f', "'", '’', '-', '—', ',', '.', '"', '«', '_', '(', ')'];
  const fts = ftsTable(), termOf = new Map();
  for (let k = 0; k < 10000; k++) {
    const len = 1 + Math.floor(rnd() * 24);
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const r = tokenize(s);
    for (let i = 0; i < r.tokens.length; i++) assert.equal(foldToken(s.slice(r.starts[i], r.ends[i])), r.tokens[i]);
    assertParity(fts, termOf, s, JSON.stringify(s));
  }
});

test('FTS5 phrase queries built by ftsPhrase find whole tokens; JS matching stays accent-exact', () => {
  const fts = ftsTable();
  const ids = new Map();
  for (const d of MINI_DOCS) if (d.text) ids.set(fts.add(normString(d.text.original)), d.ext_id);
  const hits = (q) => fts.db.prepare('SELECT rowid FROM t WHERE t MATCH ? ORDER BY rowid').all(q).map((r) => ids.get(r.rowid));
  assert.deepEqual(hits(ftsPhrase('carry the zero')), MINI_EXPECTED.phrases['carry the zero']);
  assert.deepEqual(hits(ftsPhrase(['ગુજરાતી'])), ['mini:10']);
  assert.deepEqual(hits(ftsPhrase(['शून्य'])), ['mini:08', 'mini:09']);
  assert.deepEqual(hits(ftsPhrase(['◉'])), ['mini:03']);
  assert.deepEqual(hits(ftsPhrase(['42'])), ['mini:07', 'mini:08'], 'Devanagari digits are indexed as ASCII');
  assert.deepEqual(hits(ftsPhrase(['zero'])), ['mini:01', 'mini:02', 'mini:03', 'mini:04', 'mini:05'], 'FTS candidates are accent-insensitive');
  const exact = MINI_DOCS.filter((d) => d.text && findSequence(tokenize(d.text.original).tokens, ['zero']) >= 0).map((d) => d.ext_id);
  assert.deepEqual(exact, ['mini:01', 'mini:02', 'mini:03'], 'the JS token match is accent-exact');
});

test('mini corpus offsets, token counts and shared run match tests/fixtures/mini/expected.json', () => {
  const byId = new Map(MINI_DOCS.map((d) => [d.ext_id, d]));
  for (const d of MINI_DOCS) assert.deepEqual(check('CanonicalDocument', d), [], d.ext_id);
  for (const e of MINI_EXPECTED.documents) {
    const d = byId.get(e.ext_id);
    if (e.body) {
      const text = d.text.original;
      const t = tokenize(text);
      assert.equal(text.length, e.body.length, `${e.ext_id} length`);
      assert.equal(t.tokens.length, e.body.tokens, `${e.ext_id} tokens`);
      assert.equal(normString(text), e.body.norm, `${e.ext_id} norm`);
      assert.equal(text.includes('\r\n'), e.body.crlf, `${e.ext_id} crlf`);
      e.body.paragraphs.forEach(([s, end], i) => {
        const para = text.slice(s, end);
        assert.ok(para.trim() === para && para.length > 0 && !/\n[ \t]*\r?\n|\f/.test(para), `${e.ext_id} paragraph ${i}`);
        const gap = text.slice(end, e.body.paragraphs[i + 1]?.[0] ?? text.length);
        if (i + 1 < e.body.paragraphs.length) assert.match(gap, /^\s*(\n[ \t]*\r?\n|\f)\s*$/, `${e.ext_id} blank line after paragraph ${i}`);
        else assert.match(gap, /^\s*$/);
      });
      for (const p of e.probes) {
        assert.equal(text.slice(p.start, p.end), p.surface, `${e.ext_id} probe ${p.surface}`);
        assert.equal(text.indexOf(p.surface), p.start, `${e.ext_id} first occurrence of ${p.surface}`);
        assert.equal(t.starts[p.token_index], p.start, `${e.ext_id} token index of ${p.surface}`);
        assert.equal(t.tokens.slice(p.token_index, p.token_index + p.tokens).join(' '), p.norm, `${e.ext_id} norm of ${p.surface}`);
      }
    }
    for (const [k, f] of Object.entries(e.fields ?? {})) {
      assert.equal(tokenize(d.fields[k]).tokens.length, f.tokens, `${e.ext_id}.${k}`);
      assert.equal(normString(d.fields[k]), f.norm, `${e.ext_id}.${k}`);
    }
  }
  for (const [term, perDoc] of Object.entries(MINI_EXPECTED.token_counts)) {
    for (const d of MINI_DOCS.filter((x) => x.text)) {
      const n = tokenize(d.text.original).tokens.filter((x) => x === term).length;
      assert.equal(n, perDoc[d.ext_id] ?? 0, `${term} in ${d.ext_id}`);
    }
  }
  for (const run of MINI_EXPECTED.shared_runs) {
    const seq = run.norm.split(' ');
    assert.equal(seq.length, run.tokens);
    for (const id of run.docs) assert.ok(findSequence(tokenize(byId.get(id).text.original).tokens, seq) >= 0, `${id} contains the run`);
  }
});
