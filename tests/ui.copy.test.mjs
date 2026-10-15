// OWNER: WP0 — UI copy never claims what the evidence cannot show (§13 rule 11), and the HTML shell matches §12.2
//
// The scanner reads every user-facing string: string literals of src/ui, src/shared and server code (not
// comments), the text and labelled attributes of public/*.html and *.svg, the copy fields of the contract
// fixtures and of data/demo/tour.json. Corpus text (passages, quotes, titles, annotation bodies) is data,
// not copy, and is not scanned. Allowed exceptions: a string that is exactly a vocabulary term (the lists
// that define the rule), a string that quotes an external source and says "(external claim)", and a line
// marked `copy-ok: <reason>` in a comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MENTAL_STATE_VERBS, FORBIDDEN_PHRASES } from '../src/shared/vocab.mjs';
import { RIBBON_TEXT } from '../src/ui/main.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPEC = readFileSync(join(ROOT, 'Docs/SPEC.md'), 'utf8');
// registry.mjs imports every package module, which may not exist yet, so its source is read, not imported.
const REGISTRY_SRC = readFileSync(join(ROOT, 'src/ui/registry.mjs'), 'utf8');
const MOUNT_POINTS = JSON.parse(/MOUNT_POINTS = Object\.freeze\((\[[^\]]+\])\)/.exec(REGISTRY_SRC)[1].replace(/'/g, '"'));
const TERMS = [...MENTAL_STATE_VERBS, ...FORBIDDEN_PHRASES];
const TERM_RES = TERMS.map((t) => [t, new RegExp(`(?<![\\p{L}\\p{N}_])${t.replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}_])`, 'iu')]);
/** Keys whose values are corpus data or user data, not UI copy. */
const DATA_KEYS = new Set(['text', 'quote', 'left', 'match', 'right', 'prefix', 'suffix', 'body_md', 'title', 'native_title',
  'sample_rows', 'samples', 'before', 'after', 'raw', 'surface', 'norm', 'form', 'variant', 'base64', 'sha256', 'examples']);

// ── Extraction ──────────────────────────────────────────────────────────────────────────────────────

const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^',
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', '=>']);

/**
 * String literals of a JavaScript source (quotes and template chunks), with their line numbers.
 * Comments and regular-expression literals are skipped.
 * @param {string} src
 * @returns {Array<{text: string, line: number}>}
 */
export function jsStrings(src) {
  const out = [];
  let i = 0, line = 1, prev = '';
  const n = src.length;
  const lineAt = (from, to) => { for (let k = from; k < to; k++) if (src[k] === '\n') line++; };

  function readQuoted(q) {
    const start = i, startLine = line;
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') i++;
      else if (src[i] === '\n') break;
      i++;
    }
    out.push({ text: src.slice(start + 1, i), line: startLine });
    i++;
  }
  function readTemplate() {
    i++;
    let chunk = '', chunkLine = line;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { chunk += src.slice(i, i + 2); i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        out.push({ text: chunk, line: chunkLine });
        chunk = '';
        i += 2;
        scan(true);
        chunkLine = line;
        continue;
      }
      if (src[i] === '\n') line++;
      chunk += src[i++];
    }
    out.push({ text: chunk, line: chunkLine });
    i++;
  }
  function readRegex() {
    i++;
    let inClass = false;
    while (i < n && src[i] !== '\n') {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      i++;
    }
    i++;
    while (i < n && /[a-z]/i.test(src[i])) i++;
  }
  function scan(untilBrace) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue; }
      if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2; lineAt(i, e); i = e; continue; }
      if (c === '"' || c === "'") { readQuoted(c); prev = 'str'; continue; }
      if (c === '`') { readTemplate(); prev = 'str'; continue; }
      if (c === '/') { if (REGEX_PREV.has(prev)) { readRegex(); prev = 'regex'; } else { i++; prev = '/'; } continue; }
      if (/[\p{L}\p{N}_$]/u.test(c)) {
        const m = /^[\p{L}\p{N}_$]+/u.exec(src.slice(i, i + 64));
        prev = m[0];
        i += m[0].length;
        continue;
      }
      if (c === '=' && src[i + 1] === '>') { prev = '=>'; i += 2; continue; }
      if (untilBrace) {
        if (c === '{') depth++;
        else if (c === '}') { if (depth === 0) { i++; return; } depth--; }
      }
      prev = c;
      i++;
    }
  }
  scan(false);
  return out;
}

/** Visible text and labelled attributes of HTML/SVG, with line numbers. */
function markupStrings(src) {
  const out = [];
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  const noComments = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  for (const m of noComments.matchAll(/>([^<]+)</g)) if (m[1].trim()) out.push({ text: m[1].trim(), line: lineOf(m.index) });
  for (const m of noComments.matchAll(/\b(?:title|aria-label|alt|placeholder|content)="([^"]*)"/g)) out.push({ text: m[1], line: lineOf(m.index) });
  return out;
}

/** Copy strings of a JSON document (every string not under a DATA_KEYS key). */
function jsonStrings(value, path = '$', out = []) {
  if (typeof value === 'string') out.push({ text: value, line: path });
  else if (Array.isArray(value)) value.forEach((x, i) => jsonStrings(x, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, x] of Object.entries(value)) if (!DATA_KEYS.has(k)) jsonStrings(x, `${path}.${k}`, out);
  }
  return out;
}

function files(dir, pred) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const name of readdirSync(abs)) {
    const p = join(abs, name);
    if (statSync(p).isDirectory()) out.push(...files(relative(ROOT, p), pred));
    else if (pred(p)) out.push(p);
  }
  return out;
}

/**
 * Violations of the copy rules in a list of strings.
 * @param {string} file
 * @param {Array<{text: string, line: number|string}>} strings
 * @param {string[]} [lines] source lines, for `copy-ok` markers
 */
export function violations(file, strings, lines = []) {
  const found = [];
  for (const { text, line } of strings) {
    if (TERMS.includes(text.trim().toLowerCase())) continue;          // a vocabulary entry defining the rule
    if (text.includes('(external claim)')) continue;                    // quoting a source, not Scrolls' voice
    if (typeof line === 'number' && /copy-ok:/.test(lines[line - 1] ?? '')) continue;
    for (const [term, re] of TERM_RES) if (re.test(text)) found.push(`${relative(ROOT, file)}:${line}: '${term}' in "${text.slice(0, 120)}"`);
  }
  return found;
}

function corpus() {
  const out = [];
  const js = (p) => p.endsWith('.mjs') && !p.includes(`${join('server', 'text', 'stopwords')}`);
  for (const f of [...files('src/ui', js), ...files('src/shared', js)]) {
    const src = readFileSync(f, 'utf8');
    out.push({ file: f, strings: jsStrings(src), lines: src.split('\n') });
  }
  for (const f of files('server', js)) {
    const src = readFileSync(f, 'utf8');
    // Server code: only sentence-like literals (messages, hints, notes) are copy.
    out.push({ file: f, strings: jsStrings(src).filter((s) => /\S+\s+\S+\s+\S+/.test(s.text)), lines: src.split('\n') });
  }
  for (const f of files('public', (p) => /\.(html|svg)$/.test(p))) out.push({ file: f, strings: markupStrings(readFileSync(f, 'utf8')) });
  for (const f of files('tests/contract', (p) => p.endsWith('.json'))) out.push({ file: f, strings: jsonStrings(JSON.parse(readFileSync(f, 'utf8'))) });
  const tour = join(ROOT, 'data/demo/tour.json');
  if (existsSync(tour)) out.push({ file: tour, strings: jsonStrings(JSON.parse(readFileSync(tour, 'utf8'))) });
  return out;
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────────

test('the scanner finds the terms in copy and skips comments, regexes, definitions and quoted claims', () => {
  const src = [
    "const a = 'The author felt the change';           // flagged",
    'const b = `in ${year} the meaning changed`;       // flagged (template chunk)',
    "// a comment: thought, felt, coined",
    "const re = /believed|wanted/g;",
    "const list = ['thought', 'meant to'];",
    "const c = 'Wiktionary: coined 1946 (external claim)';",
    "const d = 'He wanted it'; // copy-ok: quoting a passage in a test fixture",
    "const e = 'feltwork and thoughtful reborn stubborn words';",
    'const f = "first observed in this corpus"; const g = `x ${`nested born`} y`;',
  ].join('\n');
  const found = violations('/x.mjs', jsStrings(src), src.split('\n'));
  assert.equal(found.length, 3, found.join('\n'));
  assert.match(found[0], /'felt'/);
  assert.match(found[1], /'meaning changed'/);
  assert.match(found[2], /'born'/);
});

test('UI copy has no mental-state verbs about people and no "coined" / "meaning changed" claims (§13 rule 11)', () => {
  const all = corpus();
  const scanned = all.reduce((s, f) => s + f.strings.length, 0);
  assert.ok(all.length >= 20 && scanned >= 1000, `the scanner read real copy (${all.length} files, ${scanned} strings)`);
  const found = all.flatMap(({ file, strings, lines }) => violations(file, strings, lines));
  assert.deepEqual(found, []);
});

test('index.html has every mount point once, the six stylesheets and one module script (§12.2)', () => {
  const specPoints = /mount points: `([^`]+)`/.exec(SPEC)[1].split(/\s+/).map((x) => x.replace(/^#/, ''));
  assert.deepEqual(MOUNT_POINTS, specPoints, 'registry MOUNT_POINTS = §12.2 mount points');
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  for (const id of MOUNT_POINTS) assert.equal(html.match(new RegExp(`id="${id}"`, 'g'))?.length, 1, `#${id}`);
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sheets, ['/styles/tokens.css', '/styles/base.css', '/styles/shell.css', '/styles/timeline.css', '/styles/panels.css', '/styles/import.css']);
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(scripts, ['<script type="module" src="/ui/main.mjs">']);
  assert.match(html, /http-equiv="Content-Security-Policy"[^>]*connect-src 'self'/, 'the page may only talk to its own server');
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no external URLs');
});

test('the boot ribbon says exactly what §1.11 says', () => {
  const m = /\*\*"(SYNTHETIC DEMONSTRATION CORPUS[^"]+)"\*\*/.exec(SPEC);
  assert.ok(m, 'ribbon text found in SPEC §1.11');
  assert.equal(RIBBON_TEXT, m[1]);
});

test('registry.mjs statically imports every UI module of the §12.1 tree', () => {
  const spec = SPEC.split('\n');
  const from = spec.findIndex((l) => /└─ ui\/\s*$/.test(l));
  const to = spec.findIndex((l, i) => i > from && /├─ public\//.test(l));
  assert.ok(from > 0 && to > from, 'the src/ui block of §12.1');
  const tree = [];
  let dir = '';
  for (const raw of spec.slice(from + 1, to)) {
    const l = raw.replace(/\[WP\d\]/g, '').replace(/[│├└─]/g, ' ').trim();
    if (!l) continue;
    const parts = l.split(/\s+/);
    if (/[├└]─/.test(raw)) dir = parts[0].endsWith('/') ? parts.shift() : '';   // a new entry; other lines continue it
    for (const p of parts) if (p.endsWith('.mjs')) tree.push(dir + p);
  }
  const expected = tree.filter((p) => !['main.mjs', 'registry.mjs'].includes(p) && !p.startsWith('core/'));
  assert.ok(expected.length > 50, `parsed the tree (${expected.length} modules)`);
  const src = REGISTRY_SRC;
  const imported = [...src.matchAll(/^import \* as \w+ from '\.\/([^']+)';$/gm)].map((m) => m[1]);
  const workers = [...src.matchAll(/new URL\('\.\/([^']+\.worker\.mjs)'/g)].map((m) => m[1]);
  assert.deepEqual([...imported, ...workers].sort(), [...expected].sort());
  assert.deepEqual(workers, ['panels/layout.worker.mjs'], 'worker scripts are registered by URL, never imported');
});
