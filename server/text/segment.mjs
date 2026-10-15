// OWNER: WP0 — passage segmentation seg-1 (SPEC §4.3)
//
// Over the ORIGINAL string (offsets are UTF-16 code units, D4):
//  · pages split on \f (page_no is 1-based when the document has page breaks, else null);
//  · regions (from adapters) and pages are hard boundaries; region boundaries snap outward to token ends;
//  · blocks split on blank lines; furniture blocks ([Illustration…], short all-caps or roman-numeral
//    headings, digit-only or ≤ 3-character blocks, blocks without tokens) are flagged, never dropped;
//    in paged documents digit-only lines, ≤ 3-character lines and lines repeated on > 30% of pages are
//    split out as furniture too;
//  · verse: a block with ≥ 4 lines of which ≥ 60% are < 60 chars → stanzas of ≤ 16 lines;
//  · prose blocks over 200 tokens split at the sentence boundary nearest 120 tokens (Intl.Segmenter plus
//    । ॥), hard max 200;
//  · blocks under 12 tokens merge forward until the group has ≥ 40 tokens, never across a heading, a
//    stanza, furniture, a region or a page, and never past 200 tokens.
// Every token of [start, end) lands in exactly one passage; passages never start or end with whitespace.

import { tokenize } from '../../src/shared/tokenize.mjs';

export const SEGMENTER_VERSION = 'seg-1';

const MERGE_BELOW = 12;
const MERGE_TARGET = 40;
const SPLIT_TARGET = 120;
const HARD_MAX = 200;
const VERSE_MIN_LINES = 4;
const VERSE_SHORT_LINE = 60;
const VERSE_SHARE = 0.6;
const STANZA_MAX_LINES = 16;
const REPEAT_SHARE = 0.3;
const REPEAT_MIN_PAGES = 5;

const WS = /\s/u;
const ILLUSTRATION = /^\[\s*(?:illustration|ilustraci[oó]n|gravure|figure|fig\.|image|plate)\b/iu;
const ROMAN_HEADING = /^(?:(?:chapter|chapitre|cap[ií]tulo|book|livre|libro|part|partie|parte|canto|act|acte|scene|sc[eè]ne|section)\s+)?[ivxlcdm]+\.?$/iu;
const DIGITS_ONLY = /^[\p{N}\p{P}\p{Z}\s]+$/u;
const SENTENCE_END = /[.!?…;:,।॥]["'”’»)\]]*$/u;
const DANDA = /[।॥]+/gu;

const DEFAULT_ATTRS = Object.freeze({ quality: 'ok', time_role: 'document', field_class: 'text' });

// ── token index helpers ─────────────────────────────────────────────────────────────────────────────

/** Index of the first token whose start is ≥ x. */
function lowerBound(starts, x) {
  let lo = 0, hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Move x forward to the end of a token it falls inside, so no boundary splits a token. */
function snap(tok, x) {
  const i = lowerBound(tok.starts, x) - 1;
  return i >= 0 && tok.ends[i] > x ? tok.ends[i] : x;
}

const countTokens = (tok, a, b) => lowerBound(tok.starts, b) - lowerBound(tok.starts, a);

function trimRange(text, a, b) {
  while (a < b && WS.test(text[a])) a++;
  while (b > a && WS.test(text[b - 1])) b--;
  return [a, b];
}

// ── spans: region × page pieces ─────────────────────────────────────────────────────────────────────

function regionAttrs(r) {
  const time_role = r.time_role ?? (r.field_class === 'apparatus' ? 'apparatus' : r.field_class === 'describes' ? 'describes' : 'document');
  const field_class = r.field_class ?? (time_role === 'apparatus' ? 'apparatus' : time_role === 'describes' ? 'describes' : 'text');
  return { quality: r.quality ?? 'ok', time_role, field_class };
}

/** Consecutive [a, b) intervals covering [start, end), each with its region attributes. */
function regionSpans(regions, start, end, tok) {
  const rs = regions
    .map((r) => ({ a: Math.max(start, snap(tok, r.start)), b: Math.min(end, snap(tok, r.end)), attrs: regionAttrs(r) }))
    .filter((r) => r.a < r.b)
    .sort((x, y) => x.a - y.a);
  const spans = [];
  let cur = start;
  for (const r of rs) {
    const a = Math.max(r.a, cur);
    if (a >= r.b) continue; // overlaps an earlier region: the earlier one wins
    if (a > cur) spans.push({ a: cur, b: a, attrs: DEFAULT_ATTRS });
    spans.push({ a, b: r.b, attrs: r.attrs });
    cur = r.b;
  }
  if (cur < end) spans.push({ a: cur, b: end, attrs: DEFAULT_ATTRS });
  return spans;
}

/** Page pieces of [a, b): {a, b, page} with 1-based page numbers (null when the text has no page breaks). */
function pagePieces(text, a, b, pageSep, paged, pageAt) {
  if (!paged) return [{ a, b, page: null }];
  const out = [];
  let page = pageAt(a), cur = a;
  for (let i = text.indexOf(pageSep, a); i !== -1 && i < b; i = text.indexOf(pageSep, i + 1)) {
    if (i > cur) out.push({ a: cur, b: i, page });
    cur = i + pageSep.length;
    page++;
  }
  if (cur < b) out.push({ a: cur, b, page });
  return out;
}

// ── lines and blocks ────────────────────────────────────────────────────────────────────────────────

/** Trimmed non-blank lines of [a, b). */
function linesOf(text, a, b) {
  const out = [];
  let ls = a;
  while (ls < b) {
    let le = text.indexOf('\n', ls);
    if (le === -1 || le > b) le = b;
    const [s, e] = trimRange(text, ls, le);
    out.push(s < e ? { start: s, end: e } : null); // null = blank line
    ls = le + 1;
  }
  return out;
}

const normLine = (s) => s.replace(/\p{N}+/gu, '#').replace(/\s+/gu, ' ').trim().toLowerCase();

/** Lines repeated on more than REPEAT_SHARE of the pages (running heads), as normalized strings. */
function repeatedLines(text, pageSep, start, end) {
  const pages = text.slice(start, end).split(pageSep);
  if (pages.length < REPEAT_MIN_PAGES) return new Set();
  const counts = new Map();
  for (const p of pages) {
    const seen = new Set(p.split('\n').map(normLine).filter((l) => l.length > 0));
    for (const l of seen) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const out = new Set();
  for (const [l, n] of counts) if (n > REPEAT_SHARE * pages.length && n > 1) out.add(l);
  return out;
}

/** Blocks of consecutive non-blank lines; in paged mode furniture lines become one-line blocks of their own. */
function blocksOf(text, a, b, lineFurniture) {
  const blocks = [];
  let cur = null;
  const close = () => { if (cur) blocks.push(cur); cur = null; };
  for (const line of linesOf(text, a, b)) {
    if (!line) { close(); continue; }
    if (lineFurniture && lineFurniture(text.slice(line.start, line.end))) {
      close();
      blocks.push({ start: line.start, end: line.end, lines: [line], forcedFurniture: true });
      continue;
    }
    if (!cur) cur = { start: line.start, end: line.end, lines: [] };
    cur.lines.push(line);
    cur.end = line.end;
  }
  close();
  return blocks;
}

function isAllCapsHeading(s, n) {
  const letters = s.match(/\p{L}/gu) ?? [];
  if (letters.length < 2 || n > 10) return false;
  return letters.every((c) => c !== c.toLowerCase() && c === c.toUpperCase());
}

function classify(text, block, tok) {
  const s = text.slice(block.start, block.end);
  const n = countTokens(tok, block.start, block.end);
  const oneLine = block.lines.length === 1;
  const furniture = block.forcedFurniture || n === 0 || s.length <= 3 || ILLUSTRATION.test(s) ||
    (DIGITS_ONLY.test(s) && n <= 3) || (oneLine && (isAllCapsHeading(s, n) || ROMAN_HEADING.test(s)));
  const heading = !furniture && oneLine && n <= 10 && s.length <= 80 && !SENTENCE_END.test(s);
  return { n, furniture, heading };
}

function isVerse(text, block, mode) {
  if (mode === 'prose') return false;
  if (mode === 'verse') return true;
  const lines = block.lines;
  if (lines.length < VERSE_MIN_LINES) return false;
  const short = lines.filter((l) => l.end - l.start < VERSE_SHORT_LINE).length;
  return short >= VERSE_SHARE * lines.length;
}

/** Stanzas of ≤ 16 lines (and, where lines allow, ≤ 200 tokens). */
function stanzas(block, tok) {
  const out = [];
  let first = 0;
  while (first < block.lines.length) {
    let last = first;
    while (last + 1 < block.lines.length && last + 1 - first < STANZA_MAX_LINES &&
      countTokens(tok, block.lines[first].start, block.lines[last + 1].end) <= HARD_MAX) last++;
    out.push({ start: block.lines[first].start, end: block.lines[last].end });
    first = last + 1;
  }
  return out;
}

const segmenters = new Map();
function sentenceSegmenter(lang) {
  const key = lang || '';
  if (!segmenters.has(key)) {
    let seg;
    try { seg = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' }); } catch { seg = new Intl.Segmenter(undefined, { granularity: 'sentence' }); }
    segmenters.set(key, seg);
  }
  return segmenters.get(key);
}

function sentenceBoundaries(text, a, b, lang) {
  const out = new Set();
  const seg = sentenceSegmenter(lang);
  const s = text.slice(a, b);
  for (const part of seg.segment(s)) if (part.index > 0) out.add(a + part.index);
  for (const m of s.matchAll(DANDA)) out.add(a + m.index + m[0].length);
  return [...out].filter((o) => o > a && o < b).sort((x, y) => x - y);
}

/** Split a long prose block into pieces at sentence boundaries nearest SPLIT_TARGET tokens (hard max 200). */
function splitLong(text, block, tok, lang) {
  const t0 = lowerBound(tok.starts, block.start);
  const t1 = lowerBound(tok.starts, block.end);
  const cuts = sentenceBoundaries(text, block.start, block.end, lang)
    .map((o) => ({ o, k: lowerBound(tok.starts, o) }))
    .filter((c) => c.k > t0 && c.k < t1);
  const pieces = [];
  let cur = t0, pieceStart = block.start;
  while (t1 - cur > HARD_MAX) {
    let best = null;
    for (const c of cuts) {
      if (c.k <= cur || c.k > cur + HARD_MAX) continue;
      if (!best || Math.abs(c.k - cur - SPLIT_TARGET) < Math.abs(best.k - cur - SPLIT_TARGET)) best = c;
    }
    const k = best ? best.k : cur + HARD_MAX;
    const cutAt = best ? best.o : tok.ends[k - 1];
    const [ps, pe] = trimRange(text, pieceStart, cutAt);
    pieces.push({ start: ps, end: pe, n: k - cur });
    cur = k;
    pieceStart = trimRange(text, cutAt, block.end)[0];
  }
  pieces.push({ start: pieceStart, end: block.end, n: t1 - cur });
  return pieces;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Segment a text into passages.
 * @param {string} text the original string
 * @param {{mode?: 'auto'|'prose'|'verse'|'field', lang?: string|null,
 *   regions?: Array<{start:number, end:number, quality?:string, time_role?:string, field_class?:string}>,
 *   pageSep?: string, start?: number, end?: number,
 *   tokens?: {starts: Int32Array, ends: Int32Array}}} [opts]
 *   `start`/`end` bound the body (default: the whole text); `tokens` = tokenize(text) when the caller has it.
 * @returns {Array<{start:number, end:number, unit:'paragraph'|'stanza'|'sentence_group'|'page_paragraph'|'field',
 *   page_no:number|null, quality:string, time_role:string, field_class:string, token_count:number}>}
 */
export function segment(text, { mode = 'auto', lang = null, regions = [], pageSep = '\f', start = 0, end = text.length, tokens = null } = {}) {
  const tok = tokens ?? tokenize(text);
  start = Math.max(0, start);
  end = Math.min(text.length, end);
  if (start >= end) return [];
  if (mode === 'field') {
    const attrs = regions.length ? regionAttrs(regions[0]) : DEFAULT_ATTRS;
    return [{ start, end, unit: 'field', page_no: null, ...attrs, token_count: countTokens(tok, start, end) }];
  }

  const paged = text.includes(pageSep);
  let breaksBefore = 0, breaksPos = 0;
  const pageAt = (x) => { // 1 + page separators before x (monotone calls)
    for (let i = text.indexOf(pageSep, breaksPos); i !== -1 && i < x; i = text.indexOf(pageSep, i + 1)) {
      breaksBefore++;
      breaksPos = i + 1;
    }
    return breaksBefore + 1;
  };
  const repeated = paged ? repeatedLines(text, pageSep, start, end) : new Set();
  const lineFurniture = paged
    ? (s) => s.length <= 3 || (DIGITS_ONLY.test(s) && /\p{N}/u.test(s)) || repeated.has(normLine(s))
    : null;

  const out = [];
  const emit = (a, b, unit, page, attrs, n) => out.push({ start: a, end: b, unit, page_no: page, ...attrs, token_count: n });

  for (const span of regionSpans(regions, start, end, tok)) {
    for (const piece of pagePieces(text, span.a, span.b, pageSep, paged, pageAt)) {
      const paraUnit = piece.page === null ? 'paragraph' : 'page_paragraph';
      let group = null;
      const flush = () => {
        if (!group) return;
        emit(group.start, group.end, group.items === 1 && group.split ? 'sentence_group' : paraUnit, piece.page, span.attrs, group.n);
        group = null;
      };
      const furnitureAttrs = span.attrs.quality === 'ok' ? { ...span.attrs, quality: 'furniture' } : span.attrs;

      for (const block of blocksOf(text, piece.a, piece.b, lineFurniture)) {
        const c = classify(text, block, tok);
        if (c.furniture) {
          flush();
          emit(block.start, block.end, paraUnit, piece.page, furnitureAttrs, c.n);
          continue;
        }
        if (block.lines.length > 1 && isVerse(text, block, mode)) {
          flush();
          for (const st of stanzas(block, tok)) emit(st.start, st.end, 'stanza', piece.page, span.attrs, countTokens(tok, st.start, st.end));
          continue;
        }
        const items = c.n > HARD_MAX ? splitLong(text, block, tok, lang).map((p) => ({ ...p, split: true }))
          : [{ start: block.start, end: block.end, n: c.n, split: false }];
        for (const item of items) {
          if (group && group.open && !c.heading && group.n + item.n <= HARD_MAX) {
            group.end = item.end;
            group.n += item.n;
            group.items++;
            group.open = group.n < MERGE_TARGET;
            continue;
          }
          flush();
          group = { start: item.start, end: item.end, n: item.n, items: 1, split: item.split,
            open: (c.heading || item.n < MERGE_BELOW) && item.n < MERGE_TARGET };
        }
      }
      flush();
    }
  }
  return out;
}
