// OWNER: WP0 — passage segmentation seg-1: blocks, verse, long splits, merges, furniture, regions, pages (SPEC §4.3)

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mulberry32 } from '../src/shared/ids.mjs';
import { tokenize } from '../src/shared/tokenize.mjs';
import { segment, SEGMENTER_VERSION } from '../server/text/segment.mjs';
import { miniDocuments } from './helpers/tmpdata.mjs';

const WS = /\s/u;

/** Invariants every segmentation must satisfy over [start, end). */
function assertInvariants(text, passages, { start = 0, end = text.length, maxTokens = 200 } = {}) {
  const tok = tokenize(text);
  let prevEnd = start;
  let covered = 0;
  for (const p of passages) {
    assert.ok(p.start >= prevEnd, `passages are ordered and disjoint (${p.start} < ${prevEnd})`);
    assert.ok(p.start < p.end && p.end <= end, 'passage inside the range');
    assert.ok(!WS.test(text[p.start]) && !WS.test(text[p.end - 1]), `passage ${p.start}–${p.end} is trimmed`);
    const n = tokenize(text.slice(p.start, p.end)).tokens.length;
    assert.equal(p.token_count, n, 'token_count equals the tokens of the slice');
    if (maxTokens) assert.ok(n <= maxTokens, `passage has ${n} tokens`);
    covered += n;
    prevEnd = p.end;
  }
  const inRange = tok.starts.filter((s) => s >= start && s < end).length;
  assert.equal(covered, inRange, 'every token of the range lies in exactly one passage');
}

const words = (n, seed = 1) => {
  const rnd = mulberry32(seed);
  const vocab = ['the', 'zero', 'holds', 'place', 'carry', 'ledger', 'clerk', 'sum', 'margin', 'ghost', 'count', 'line'];
  return Array.from({ length: n }, () => vocab[Math.floor(rnd() * vocab.length)]);
};
const sentences = (n, per = 10, seed = 1) => {
  const w = words(n, seed);
  const out = [];
  for (let i = 0; i < w.length; i += per) {
    const s = w.slice(i, i + per).join(' ');
    out.push(`${s[0].toUpperCase()}${s.slice(1)}.`); // ICU does not end a sentence before a lowercase word
  }
  return out.join(' ');
};

describe('segment', () => {
  test('version', () => assert.equal(SEGMENTER_VERSION, 'seg-1'));

  test('mini corpus: invariants, units and page numbers', () => {
    for (const d of miniDocuments().filter((x) => x.text)) {
      const t = d.text.original;
      const ps = segment(t, { lang: d.lang_declared });
      assert.ok(ps.length >= 1, d.ext_id);
      assertInvariants(t, ps);
      for (const p of ps) {
        assert.equal(p.quality, 'ok', `${d.ext_id} passage quality`);
        assert.equal(p.field_class, 'text');
        assert.equal(p.time_role, 'document');
      }
      if (d.text.decoder === 'pages-joined-ff') {
        assert.deepEqual(ps.map((p) => p.page_no), [1, 2], `${d.ext_id} pages`);
        assert.ok(ps.every((p) => p.unit === 'page_paragraph'));
      } else {
        assert.ok(ps.every((p) => p.page_no === null));
      }
    }
  });

  test('CRLF blank lines split blocks; passages exclude the \\r', () => {
    const para = (k) => words(15, k).join(' ');
    const t = `${para(1)}\r\n\r\n${para(2)}\r\n\r\n`;
    const ps = segment(t);
    assert.equal(ps.length, 2);
    assert.equal(t.slice(ps[0].start, ps[0].end), para(1));
    assertInvariants(t, ps);
  });

  test('short blocks merge forward to ≥ 40 tokens; long blocks stay alone', () => {
    const blocks = [words(5, 1), words(6, 2), words(8, 3), words(30, 4), words(20, 5), words(3, 6)].map((w) => `${w.join(' ')}.`);
    const t = blocks.join('\n\n');
    const ps = segment(t);
    assertInvariants(t, ps);
    // 5+6+8 = 19 < 40 → keeps merging: +30 = 49 → stop; 20 alone (≥ 12); 3 alone at the end
    assert.deepEqual(ps.map((p) => p.token_count), [49, 20, 3]);
    assert.ok(ps.every((p) => p.unit === 'paragraph'));
  });

  test('a heading starts a new group; furniture and pages are barriers', () => {
    const t = [`${words(5, 1).join(' ')}.`, 'The Second Ledger', `${words(20, 2).join(' ')}.`, 'CHAPTER XII.', `${words(4, 3).join(' ')}.`,
      `${words(4, 4).join(' ')}.`].join('\n\n');
    const ps = segment(t);
    assertInvariants(t, ps);
    const texts = ps.map((p) => t.slice(p.start, p.end));
    assert.equal(ps.length, 4);
    assert.match(texts[1], /^The Second Ledger\n\n/);           // heading + its paragraph
    assert.equal(texts[2], 'CHAPTER XII.');
    assert.equal(ps[2].quality, 'furniture');
    assert.equal(ps[3].token_count, 8);                          // the two short blocks after furniture merge
    const paged = `${words(5, 1).join(' ')}.\f${words(5, 2).join(' ')}.`;
    const pp = segment(paged);
    assert.deepEqual(pp.map((p) => [p.page_no, p.token_count]), [[1, 5], [2, 5]]);
  });

  test('furniture is flagged, never dropped', () => {
    const cases = ['[Illustration: The clerk at his desk]', 'IV.', 'CHAPTER IX', '* * *', '12', '—', 'PREFACE', 'Chapitre XII'];
    for (const f of cases) {
      const t = `${words(20, 1).join(' ')}.\n\n${f}\n\n${words(20, 2).join(' ')}.`;
      const ps = segment(t);
      assertInvariants(t, ps);
      const mid = ps.find((p) => t.slice(p.start, p.end) === f);
      assert.ok(mid, `${f} is its own passage`);
      assert.equal(mid.quality, 'furniture', f);
    }
  });

  test('verse: ≥ 4 short lines make a stanza; more than 16 lines split', () => {
    const line = (k) => words(6, k).join(' ');
    const stanza = Array.from({ length: 4 }, (_, i) => line(i)).join('\n');
    const ps = segment(stanza);
    assert.deepEqual(ps.map((p) => p.unit), ['stanza']);
    const long = Array.from({ length: 40 }, (_, i) => line(i)).join('\n');
    const ls = segment(long);
    assert.deepEqual(ls.map((p) => p.unit), ['stanza', 'stanza', 'stanza']);
    assert.deepEqual(ls.map((p) => t2lines(long, p)), [16, 16, 8]);
    assertInvariants(long, ls);
    assert.deepEqual(segment(stanza, { mode: 'prose' }).map((p) => p.unit), ['paragraph']);
    assert.deepEqual(segment(line(1), { mode: 'verse' }).map((p) => p.unit), ['paragraph']); // one line is not a stanza
    const two = `${line(1)}\n${line(2)}`;
    assert.deepEqual(segment(two, { mode: 'verse' }).map((p) => p.unit), ['stanza']);
  });

  test('prose over 200 tokens splits at the sentence boundary nearest 120 tokens', () => {
    const t = sentences(500, 10, 7); // 50 sentences of 10 tokens
    const ps = segment(t, { lang: 'en' });
    assertInvariants(t, ps);
    assert.ok(ps.length >= 3);
    assert.ok(ps.every((p) => p.unit === 'sentence_group'));
    for (const p of ps.slice(0, -1)) {
      assert.equal(p.token_count, 120, 'cut nearest 120 tokens');
      assert.equal(t[p.end - 1], '.', 'cut at a sentence end');
    }
  });

  test('a paragraph without sentence boundaries is cut at 200 tokens', () => {
    const t = words(450, 3).join(' ');
    const ps = segment(t);
    assertInvariants(t, ps);
    assert.deepEqual(ps.map((p) => p.token_count), [200, 200, 50]);
  });

  test('Devanagari danda ends sentences', () => {
    const s = 'शून्य सबसे पहले आता है और गिनती वहीं से चलती है।';
    const t = Array.from({ length: 30 }, () => s).join(' ');
    const ps = segment(t, { lang: 'hi' });
    assertInvariants(t, ps);
    assert.ok(ps.length > 1);
    for (const p of ps.slice(0, -1)) assert.equal(t[p.end - 1], '।');
  });

  test('regions are hard boundaries with their own attributes; boundaries snap to token ends', () => {
    const a = `${words(20, 1).join(' ')}.`, b = `${words(20, 2).join(' ')}.`, c = `${words(20, 3).join(' ')}.`;
    const t = `${a}\n\n${b}\n\n${c}`;
    const bStart = t.indexOf(b);
    const regions = [{ start: bStart + 2, end: bStart + b.length, quality: 'boilerplate' }]; // starts inside a word
    const ps = segment(t, { regions });
    assertInvariants(t, ps);
    const q = ps.map((p) => p.quality);
    assert.ok(q.includes('boilerplate'));
    for (const p of ps) {
      const inside = p.start >= bStart && p.end <= bStart + b.length;
      if (p.quality === 'boilerplate') assert.ok(inside, 'boilerplate passage inside its region');
    }
    const app = segment(t, { regions: [{ start: 0, end: a.length, time_role: 'apparatus' }] });
    assert.equal(app[0].field_class, 'apparatus');
    assert.equal(app[0].time_role, 'apparatus');
    assert.equal(app[1].field_class, 'text');
  });

  test('body bounds limit segmentation to [start, end)', () => {
    const header = '*** START OF THE PROJECT GUTENBERG EBOOK X ***\n';
    const body = `${words(30, 1).join(' ')}.\n\n${words(30, 2).join(' ')}.\n`;
    const t = `${header}${body}*** END OF THE PROJECT GUTENBERG EBOOK X ***\n`;
    const start = header.length, end = header.length + body.length;
    const ps = segment(t, { start, end });
    assertInvariants(t, ps, { start, end });
    assert.equal(ps[0].start, start);
    assert.ok(ps.at(-1).end <= end);
  });

  test('paged documents: running heads and page numbers become furniture lines', () => {
    const page = (k) => `THE LEDGER BOOK\n${words(25, k).join(' ')}.\n${k + 1}`;
    const t = Array.from({ length: 6 }, (_, k) => page(k)).join('\f');
    const ps = segment(t);
    assertInvariants(t, ps);
    const furn = ps.filter((p) => p.quality === 'furniture').map((p) => t.slice(p.start, p.end));
    assert.equal(furn.filter((f) => f === 'THE LEDGER BOOK').length, 6);
    assert.equal(furn.filter((f) => /^\d+$/.test(f)).length, 6);
    assert.equal(ps.filter((p) => p.quality === 'ok').length, 6);
  });

  test('field mode is one passage', () => {
    const ps = segment('Zero Hour ◉ 🎬', { mode: 'field' });
    assert.deepEqual(ps.map((p) => [p.start, p.end, p.unit, p.token_count]), [[0, 14, 'field', 4]]);
  });

  test('empty and whitespace-only texts have no passages', () => {
    assert.deepEqual(segment(''), []);
    assert.deepEqual(segment(' \n\n \t'), []);
  });

  test('property: random texts keep every invariant and are deterministic', () => {
    const rnd = mulberry32(2026);
    const pieces = ['zero', 'ledger', 'शून्य', 'ગુજરાતી', 'Ünïcode', '◉', '👍🏽', 'co­operative', 'क्‍षण', '12', 'IV.',
      'CHAPTER', '.', ',', '।', '“', '”', ' ', ' ', ' ', '\n', '\n', '\n\n', '\r\n', '\f', '[Illustration]', 'ſaid', 'é'];
    for (let i = 0; i < 300; i++) {
      let t = '';
      const len = 1 + Math.floor(rnd() * 400);
      for (let k = 0; k < len; k++) t += pieces[Math.floor(rnd() * pieces.length)];
      const mode = ['auto', 'prose', 'verse'][i % 3];
      const ps = segment(t, { mode });
      assertInvariants(t, ps, { maxTokens: mode === 'verse' ? 0 : 200 });
      assert.deepEqual(segment(t, { mode }), ps);
    }
  });
});

function t2lines(text, p) {
  return text.slice(p.start, p.end).split('\n').length;
}
