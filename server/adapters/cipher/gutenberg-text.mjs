// OWNER: WP2
// gutenberg-text.mjs — Gutenberg body bounds and regions (SPEC §4.3, §6.3): the three marker variants, the
// licence paragraphs left inside the body, and editorial apparatus. Furniture ([Illustration], headings,
// page numbers) is flagged by the segmenter; this module only says where the book is and which parts of it
// are someone else's later text. Nothing is deleted: regions are flagged, offsets stay in the original.
//
// Marker variants measured on Cipher's 691 files: 660 `*** START OF …`, 28 `***START OF …` (no space), 3 old
// "SMALL PRINT" headers (`***START**THE SMALL PRINT!` … `*END*THE SMALL PRINT!…*END*`, ended by
// "End of [the] Project Gutenberg Etext …").

const START_RE = /^[^\S\n]*\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*(?:\n|$)/im;
const END_RE = /^[^\S\n]*\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG/im;
const SMALL_PRINT_START_RE = /\*{3}\s*START\*{2}\s*(?:THE\s+)?SMALL PRINT/i;
// the old header ends on the line carrying "*END*" after a SMALL PRINT mention ("*END*THE SMALL PRINT! …*END*"
// or "*SMALL PRINT! Ver.04.29.93 … ETEXTS*END*")
const SMALL_PRINT_END_RE = /^[^\n]*(?:\*END\*\s*THE SMALL PRINT|SMALL PRINT![^\n]*\*END\*)[^\n]*(?:\n|$)/im;
const OLD_FOOTER_RE = /^[^\S\n]*End of (?:the |this )?(?:is COPYRIGHTED )?Project Gutenberg(?:'s)? E-?text\b/gim;

/** §4.3 licence lexicon for paragraphs inside the body, plus the old "Etext" licence wording. */
export const LICENCE_PARAGRAPH_RE = /project gutenberg|gutenberg-tm|small print|this ebook is for the use of|\betexts?\b|computer virus, or computer codes/i;

/** Producer / transcriber credits at the start of a body ("Produced by …", "E-text prepared by …"). */
const CREDITS_RE = new RegExp('^[\\[(]?\\s*(?:produced by|e-?text prepared by|this e-?(?:text|book) was (?:prepared|produced|created|made|transcribed)'
  + '|this file was (?:produced|prepared|created|made)|transcribed (?:from|by)|prepared by|scanned (?:and proofed )?by|html version by'
  + '|e-?book (?:prepared|produced) by)\\b', 'i');
/** Distributed Proofreaders / pgdp.net production credits and dedications (Gutenberg production residue). */
const DP_CREDIT_RE = /distributed proofread(?:ers|ing)|pgdp\.net|online distributed/i;
const APPARATUS_HEADING_RE = /^(?:PREFACE|INTRODUCTION|EDITOR'?S NOTE|TRANSCRIBER['’]?S NOTES?|NOTES|BIOGRAPHICAL (?:NOTE|SKETCH)|PRÉFACE|AVANT-PROPOS|INTRODUCCIÓN|PRÓLOGO|NOTA DEL EDITOR)\b/i;
const TRANSCRIBER_RE = /^TRANSCRIBER['’]?S NOTES?\b/i;
// Transcriber residue inside the body (gutenberg-stemm FORMAT.md "Gutenberg residue": transcriber's notes are not
// flagged by the catalogue and must be stripped by the importer): a note in brackets, a note under its own
// heading, an ASCII box around such a note, and the e-text's notes on its own transcription conventions.
const BRACKET_NOTE_RE = /\[\s*\**\s*Transcribers?['’`]?s?\s+Notes?\b/gi;
const NOTE_HEADING_RE = /^[\s|*[(+]*(?:<b>)?Transcribers?['’`]?s?\s+Notes?\b[\s:.\])*|]*/i;
const END_NOTE_RE = /\[?\s*End(?: of(?: the)?)? Transcribers?['’`]?s?\s+Notes?\.?\s*\]?/i;
const BOX_EDGE_RE = /^[^\S\n]*(?:\+[-—─=]{5,}|\*{10,})/;
const BOX_TOPIC_RE = /transcriber|e-?text|e-?book|unicode|utf-8|character set|this file/i;
const CONVENTION_RE = new RegExp([
  '^(?:note:\\s*)?images of the original pages are available',
  '\\b(?:texts?|words?|passages?) (?:printed )?in (?:italics?|bold)[^.]{0,80}\\b(?:transcribed|represented|denoted|indicated|shown|rendered)\\b',
  '\\bitali[cs]\\w*(?: text| texts)? (?:is|are|has been|have been|were) (?:denoted|transcribed|represented|indicated|shown|rendered)\\b',
  '^(?:the )?(?:texts?|words?) (?:transcribed )?between _?underscores',
  '\\bsmall capitals (?:in the original(?: text)? )?(?:have been|are|were|has been) (?:transcribed|replaced|represented|rendered)',
  '^(?:this|the) e-?(?:text|book) (?:includes|contains|comes in|is based on|uses|was produced)',
  '^some characters (?:might|may) not display',
].join('|'), 'i');
const RESIDUE_FRONT = 0.08;
const RESIDUE_FRONT_MIN = 3000;
const NOTE_MAX_CHARS = 30000;
const HEADING_NOTE_BLOCKS = 12;
const HEADING_NOTE_CHARS = 6000;
const FOOTNOTE_RE = /^\s*\[(?:Footnote\b[^\]]*|\d{1,3})\]/i;
const YEAR_RE = /\b(1[0-9]{3}|20[0-9]{2})\b/g;
const BY_NAME_RE = /\b(?:by|par|por|edited by|translated by|introduction by)\s+((?:[A-Z][\p{L}'’.-]*\.?\s+){0,3}[A-Z][\p{L}'’-]+)/u;
const NEXT_SECTION_RE = /^(?:CHAPTER|CHAPITRE|CAP[IÍ]TULO|BOOK|LIVRE|LIBRO|PART|PARTIE|PARTE|ACT|ACTE|CANTO|[IVXLC]+\.?)\b/i;
const APPARATUS_FRONT = 0.15;
const APPARATUS_BACK = 0.10;

/** [start, end) of blank-line separated blocks of text[a, b). */
function blocks(text, a, b) {
  const out = [];
  const re = /\n[^\S\n]*\n/g;
  re.lastIndex = a;
  let cur = a;
  for (let m = re.exec(text); m && m.index < b; m = re.exec(text)) {
    if (m.index > cur) out.push([cur, m.index]);
    cur = m.index + m[0].length;
  }
  if (cur < b) out.push([cur, b]);
  return out.map(([s, e]) => trim(text, s, e)).filter(([s, e]) => e > s);
}

function trim(text, s, e) {
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return [s, e];
}

/**
 * Body bounds of a Gutenberg file (UTF-16 offsets into the decoded original).
 * @param {string} text
 * @returns {{body_start: number, body_end: number, marker: 'exact'|'nospace'|'small_print'|'none'}}
 */
export function gutenbergBounds(text) {
  const s = START_RE.exec(text);
  if (s) {
    const bodyStart = s.index + s[0].length;
    const rest = text.slice(bodyStart);
    const e = END_RE.exec(rest);
    const marker = /\*{3}START/i.test(s[0]) ? 'nospace' : 'exact';
    return { body_start: bodyStart, body_end: e ? bodyStart + e.index : text.length, marker };
  }
  const sp = SMALL_PRINT_START_RE.exec(text);
  if (sp) {
    const after = text.slice(sp.index);
    const end = SMALL_PRINT_END_RE.exec(after);
    const bodyStart = end ? sp.index + end.index + end[0].length : sp.index;
    let bodyEnd = text.length;
    OLD_FOOTER_RE.lastIndex = bodyStart;
    for (let m = OLD_FOOTER_RE.exec(text); m; m = OLD_FOOTER_RE.exec(text)) bodyEnd = m.index; // the last one
    return { body_start: bodyStart, body_end: Math.max(bodyStart, bodyEnd), marker: 'small_print' };
  }
  return { body_start: 0, body_end: text.length, marker: 'none' };
}

/** A person named in the first lines of a section who is not the document's author. */
function namesOtherPerson(lines, author) {
  const authorTokens = new Set(String(author ?? '').toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 2));
  for (const line of lines) {
    const m = BY_NAME_RE.exec(line);
    if (!m) continue;
    const words = m[1].toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 2);
    if (words.length && !words.some((w) => authorTokens.has(w))) return true;
  }
  return false;
}

function hasLateYear(s, yHi) {
  if (yHi === null || yHi === undefined) return false;
  for (const m of s.matchAll(YEAR_RE)) if (Number(m[1]) > yHi + 5) return true;
  return false;
}

/**
 * Editorial apparatus regions (§4.3): a section headed PREFACE/INTRODUCTION/… in the first 15% or last 10%
 * of the body that names another person in its first 3 lines, carries a year > y_hi + 5, or is a
 * transcriber's note; footnote blocks with such a year.
 */
function apparatusRegions(text, bodyStart, bodyEnd, { yHi, author }) {
  const regions = [];
  const len = bodyEnd - bodyStart;
  if (len <= 0) return regions;
  const bl = blocks(text, bodyStart, bodyEnd);
  for (let i = 0; i < bl.length; i++) {
    const [s, e] = bl[i];
    const firstLine = text.slice(s, e).split('\n')[0].trim();
    const pos = (s - bodyStart) / len;
    if (firstLine.length <= 60 && APPARATUS_HEADING_RE.test(firstLine) && (pos <= APPARATUS_FRONT || pos >= 1 - APPARATUS_BACK)) {
      // the section runs to the next chapter-like heading (or another apparatus heading), capped at 15% of the body
      let j = i + 1;
      const cap = s + Math.max(2000, Math.floor(len * APPARATUS_FRONT));
      while (j < bl.length && bl[j][0] < cap) {
        const head = text.slice(bl[j][0], bl[j][1]).split('\n')[0].trim();
        const isHeading = text.slice(bl[j][0], bl[j][1]).indexOf('\n') === -1 && head.length <= 60 &&
          (NEXT_SECTION_RE.test(head) || APPARATUS_HEADING_RE.test(head));
        if (isHeading) break;
        j++;
      }
      const end = j > i + 1 ? bl[j - 1][1] : e;
      const body = text.slice(s, end);
      const firstLines = body.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4);
      if (TRANSCRIBER_RE.test(firstLine) || namesOtherPerson(firstLines, author) || hasLateYear(body, yHi)) {
        regions.push({ start: s, end, time_role: 'apparatus', field_class: 'apparatus', reason: 'section' });
      }
      i = j - 1;
      continue;
    }
    if (FOOTNOTE_RE.test(text.slice(s, Math.min(e, s + 40))) && hasLateYear(text.slice(s, e), yHi)) {
      regions.push({ start: s, end: e, time_role: 'apparatus', field_class: 'apparatus', reason: 'footnote' });
    }
  }
  return regions;
}

/**
 * Body bounds and regions[] for DocumentWriter; W_NO_GUTENBERG_MARKERS when no marker matches.
 * Regions: licence paragraphs inside the body → quality 'boilerplate'; apparatus → time_role/field_class
 * 'apparatus'. Overlaps resolve to the earlier region (segment.mjs), so licence paragraphs come first.
 * @param {string} text decoded original (BOM stripped)
 * @param {{yHi?: number|null, author?: string|null}} [opts]
 * @returns {{body_start: number, body_end: number, marker: string, regions: object[], issues: object[],
 *   counts: {boilerplate: number, apparatus: number}}}
 */
export function gutenbergRegions(text, { yHi = null, author = null } = {}) {
  const { body_start, body_end, marker } = gutenbergBounds(text);
  const issues = [];
  if (marker === 'none') {
    issues.push({ code: 'W_NO_GUTENBERG_MARKERS', severity: 'warning',
      message: 'No Project Gutenberg START/END markers; the whole file is the body.',
      suggestion: 'Check the file: licence text may be counted as book text until the boilerplate pass flags it.' });
  }
  const { regions, counts } = bodyRegions(text, body_start, body_end, { yHi, author });
  return { body_start, body_end, marker, regions, issues, counts };
}

/**
 * Regions inside known body bounds (e.g. bounds a catalogue already measured): licence and producer-credit
 * paragraphs → quality 'boilerplate'; editorial apparatus → time_role/field_class 'apparatus'.
 * @param {string} text
 * @param {number} bodyStart UTF-16 offset
 * @param {number} bodyEnd UTF-16 offset
 * @param {{yHi?: number|null, author?: string|null}} [opts]
 * @returns {{regions: object[], counts: {boilerplate: number, apparatus: number}}}
 */
export function bodyRegions(text, bodyStart, bodyEnd, { yHi = null, author = null } = {}) {
  const regions = [];
  const creditsUntil = bodyStart + Math.max(2000, Math.floor((bodyEnd - bodyStart) * 0.05));
  for (const [s, e] of blocks(text, bodyStart, bodyEnd)) {
    const t = text.slice(s, e);
    if (LICENCE_PARAGRAPH_RE.test(t) || (s < creditsUntil && (CREDITS_RE.test(t) || DP_CREDIT_RE.test(t)))) {
      regions.push({ start: s, end: e, quality: 'boilerplate' });
    }
  }
  const boilerplate = regions.length;
  const apparatus = apparatusRegions(text, bodyStart, bodyEnd, { yHi, author });
  regions.push(...apparatus.map(({ reason, ...r }) => r));
  const residue = residueRegions(text, bodyStart, bodyEnd);
  regions.push(...residue);
  regions.sort((a, b) => a.start - b.start);
  return { regions, counts: { boilerplate, apparatus: apparatus.length, residue: residue.length } };
}

/** Index of the `]` that closes the `[` at `open` (nested brackets counted), or -1 within `limit` characters. */
function closingBracket(text, open, limit) {
  let depth = 0;
  const stop = Math.min(text.length, open + limit);
  for (let i = open; i < stop; i++) {
    const c = text.charCodeAt(i);
    if (c === 91) depth++;
    else if (c === 93 && --depth === 0) return i;
  }
  return -1;
}

const NOTE_LIKE_RE = /\b(?:original|typo\w*|errors?|errata|corrected|corrections?|amended|misprints?|normali[sz]ed|regulari[sz]ed|standardi[sz]ed|spelling|punctuation|italics?|bold|underscores?|transcri\w+|e-?text|e-?book|printer\w*|footnotes?|illustrations?|pages?|inconsisten\w*|hyphenat\w*|retained|preserved|silently|chang\w*|moved|archaic|variant|unicode|utf-8|display|symbols?|characters?)\b/i;
const lineEnd = (text, i) => { const n = text.indexOf('\n', i); return n < 0 ? text.length : n; };

/**
 * Where a note that starts with a bare heading ("Transcriber's Notes", "[Transcriber's Note]") ends: at an explicit
 * "[End of Transcriber's Notes]" when there is one; otherwise after the run of following blocks that read as notes
 * (corrections, conventions), so the author's text after a short note is never swallowed. In the last 10% of the
 * body (where the notes usually list every correction) the run has no length cap.
 */
function headingNoteEnd(text, bl, i, bodyStart, bodyEnd) {
  const from = bl[i][1];
  const tail = text.slice(from, Math.min(bodyEnd, from + NOTE_MAX_CHARS));
  const endMark = END_NOTE_RE.exec(tail);
  if (endMark) return from + endMark.index + endMark[0].length;
  const back = (bl[i][0] - bodyStart) / Math.max(1, bodyEnd - bodyStart) >= 1 - APPARATUS_BACK;
  const maxBlocks = back ? Infinity : HEADING_NOTE_BLOCKS, maxChars = back ? Infinity : HEADING_NOTE_CHARS;
  let end = bl[i][1];
  for (let j = i + 1; j < bl.length && j <= i + maxBlocks && bl[j][0] - bl[i][0] < maxChars; j++) {
    const t = text.slice(bl[j][0], bl[j][1]);
    const head = t.split('\n')[0].trim();
    if (NEXT_SECTION_RE.test(head) || (APPARATUS_HEADING_RE.test(head) && !TRANSCRIBER_RE.test(head)) || !NOTE_LIKE_RE.test(t)) break;
    end = bl[j][1];
  }
  return end;
}

/**
 * Transcriber residue inside a Gutenberg body (gutenberg-stemm FORMAT.md, "Gutenberg residue"): bracketed
 * transcriber's notes anywhere; a "Transcriber's Note(s)" heading and the note under it; an ASCII box around a note
 * about the e-text; and, near the start or the end of the body, the e-text's notes on its own transcription
 * conventions ("Text printed in italics has been transcribed between _underscores_", "Images of the original pages
 * are available through Internet Archive"). All of it is later editorial text: time_role/field_class 'apparatus'.
 * @param {string} text
 * @param {number} bodyStart
 * @param {number} bodyEnd
 * @returns {Array<{start: number, end: number, time_role: 'apparatus', field_class: 'apparatus'}>}
 */
export function residueRegions(text, bodyStart, bodyEnd) {
  const out = [];
  const add = (start, end) => {
    const [s, e] = trim(text, Math.max(bodyStart, start), Math.min(bodyEnd, end));
    if (e > s && !out.some((r) => s >= r.start && e <= r.end)) out.push({ start: s, end: e, time_role: 'apparatus', field_class: 'apparatus' });
  };
  const len = Math.max(1, bodyEnd - bodyStart);
  const frontUntil = bodyStart + Math.max(RESIDUE_FRONT_MIN, Math.floor(len * RESIDUE_FRONT));
  const backFrom = bodyStart + Math.floor(len * (1 - APPARATUS_BACK));
  const bl = blocks(text, bodyStart, bodyEnd);
  const blockAt = (pos) => {
    let lo = 0, hi = bl.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (bl[mid][0] <= pos) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best;
  };

  // 1. "[Transcriber's Note: …]" anywhere (the bracket may span several paragraphs); a bracket that holds only the
  //    heading ("[Transcriber's Notes]") opens a note that runs on under it.
  BRACKET_NOTE_RE.lastIndex = bodyStart;
  for (let m = BRACKET_NOTE_RE.exec(text); m && m.index < bodyEnd; m = BRACKET_NOTE_RE.exec(text)) {
    const close = closingBracket(text, m.index, NOTE_MAX_CHARS);
    if (close < 0) continue;
    const inside = text.slice(m.index + 1, close).replace(/^\s*\**\s*Transcribers?['’`]?s?\s+Notes?\b[\s:.*]*/i, '').trim();
    if (!inside) {
      const i = blockAt(m.index);
      if (i >= 0) add(bl[i][0], headingNoteEnd(text, bl, i, bodyStart, bodyEnd));
    } else {
      add(m.index, close + 1);
    }
    BRACKET_NOTE_RE.lastIndex = close + 1;
  }

  for (let i = 0; i < bl.length; i++) {
    const [s, e] = bl[i];
    const t = text.slice(s, e);
    const firstLine = t.split('\n')[0];
    // 2. an ASCII box ("+------+ | Transcriber's Note: … | +------+") about the e-text
    if (BOX_EDGE_RE.test(firstLine)) {
      const after = lineEnd(text, s) + 1;
      const rest = text.slice(after, Math.min(bodyEnd, after + NOTE_MAX_CHARS));
      const bottom = /^[^\S\n]*(?:\+[-—─=]{5,}|\*{10,})[^\n]*$/m.exec(rest);
      if (bottom && BOX_TOPIC_RE.test(rest.slice(0, bottom.index))) {
        add(s, lineEnd(text, after + bottom.index));
        while (i + 1 < bl.length && bl[i + 1][0] < after + bottom.index) i++;
        continue;
      }
    }
    // 3. "Transcriber's Note(s)" as a heading, or a block that opens with it
    if (!firstLine.trimStart().startsWith('[') && NOTE_HEADING_RE.test(firstLine) && /transcri/i.test(firstLine)) {
      const headingOnly = t.replace(NOTE_HEADING_RE, '').trim().length === 0;
      add(s, headingOnly ? headingNoteEnd(text, bl, i, bodyStart, bodyEnd) : e);
      continue;
    }
    // 4. the e-text's notes on its own transcription conventions, near the start or the end of the body
    if ((s < frontUntil || s >= backFrom) && CONVENTION_RE.test(t.replace(/\s+/g, ' '))) add(s, e);
  }
  return out.sort((a, b) => a.start - b.start);
}
