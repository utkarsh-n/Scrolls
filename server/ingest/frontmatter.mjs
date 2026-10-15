// OWNER: WP1
// frontmatter.mjs — dependency-free YAML-subset front-matter parser (SPEC §5.1).
//
// Supported: `key: value` scalars (plain, 'single' or "double" quoted), inline lists `[a, "b, c"]`, block
// lists (`- item` lines under a key), one level of indented `key: value` pairs under a key, and `|` / `>`
// block scalars. Anything else is kept as its raw text with a warning; the front matter itself always stays
// in the original text (body_start points after it).

const OPEN = /^---[ \t]*\r?$/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*\r?$/;
const MAX_LINES = 500;

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Strip a trailing ` # comment` outside quotes. */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

/** `[a, "b, c", 'd']` → ['a', 'b, c', 'd'] */
function inlineList(s) {
  const inner = s.trim().slice(1, -1);
  const out = [];
  let cur = '', q = null;
  for (const c of inner) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '' || out.length) out.push(cur);
  return out.map(unquote).filter((x) => x !== '');
}

function scalar(raw) {
  const s = stripComment(raw).trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.startsWith('[') && s.endsWith(']')) return inlineList(s);
  return unquote(s);
}

/**
 * Read a leading `---` block.
 * @param {string} text
 * @returns {{present: boolean, data: Record<string, unknown>, bodyStart: number, endLine: number, issues: object[]}}
 *   `bodyStart` = offset just after the closing line (0 when there is no front matter); `endLine` = its line.
 */
export function parseFrontMatter(text) {
  const issues = [];
  const none = { present: false, data: {}, bodyStart: 0, endLine: 0, issues };
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl < 0 ? text : text.slice(0, firstNl);
  if (!OPEN.test(firstLine)) return none;

  const lines = [];
  let pos = firstNl < 0 ? text.length : firstNl + 1;
  let closeAt = -1, closeLine = 0;
  for (let ln = 2; pos <= text.length && ln <= MAX_LINES + 1; ln++) {
    const nl = text.indexOf('\n', pos);
    const lineText = text.slice(pos, nl < 0 ? text.length : nl);
    if (CLOSE.test(lineText)) { closeAt = nl < 0 ? text.length : nl + 1; closeLine = ln; break; }
    lines.push({ ln, text: lineText.replace(/\r$/, '') });
    if (nl < 0) break;
    pos = nl + 1;
  }
  if (closeAt < 0) {
    issues.push({ code: 'E_FIELD_TYPE', severity: 'warning', line: 1, col: 1, field: 'front matter', value_excerpt: '---',
      message: 'The file opens a front-matter block (---) on line 1 that is never closed; it was read as ordinary text.',
      suggestion: 'Add a closing --- line after the metadata, or remove the opening ---.' });
    return none;
  }

  const data = {};
  let i = 0;
  while (i < lines.length) {
    const { ln, text: l } = lines[i];
    if (l.trim() === '' || l.trimStart().startsWith('#')) { i++; continue; }
    const m = /^([^\s:#][^:]*?):(?:\s+(.*)|\s*)$/.exec(l);
    if (!m || /^\s/.test(l)) {
      issues.push({ code: 'E_FIELD_TYPE', severity: 'warning', line: ln, col: 1, field: 'front matter', value_excerpt: l.slice(0, 200),
        message: `Front-matter line ${ln} is not a 'key: value' pair; it was kept in the text but not read as metadata.`,
        suggestion: 'Use one key: value per line, lists as [a, b] or "- item" lines.' });
      i++;
      continue;
    }
    const key = m[1].trim();
    const rest = (m[2] ?? '').trim();
    i++;
    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      const block = [];
      while (i < lines.length && (lines[i].text.trim() === '' || /^\s+/.test(lines[i].text))) block.push(lines[i++].text.trim());
      while (block.length && block[block.length - 1] === '') block.pop();
      data[key] = rest.startsWith('|') ? block.join('\n') : block.join(' ').replace(/\s+/g, ' ').trim();
      continue;
    }
    if (rest !== '') { data[key] = scalar(rest); continue; }
    // empty value: a block list, a nested map, or null
    const items = [];
    const nested = {};
    let kind = null;
    while (i < lines.length && /^\s*-\s+|^\s+\S/.test(lines[i].text)) {
      const t = lines[i].text;
      const li = /^\s*-\s+(.*)$/.exec(t);
      if (li && kind !== 'map') { kind = 'list'; items.push(scalar(li[1])); i++; continue; }
      const kv = /^\s+([^\s:#][^:]*?):(?:\s+(.*)|\s*)$/.exec(t);
      if (kv && kind !== 'list') { kind = 'map'; nested[kv[1].trim()] = scalar(kv[2] ?? ''); i++; continue; }
      issues.push({ code: 'E_FIELD_TYPE', severity: 'warning', line: lines[i].ln, col: 1, field: key, value_excerpt: t.slice(0, 200),
        message: `Front-matter line ${lines[i].ln} under '${key}' mixes list items and keys; it was not read.`,
        suggestion: `Write '${key}' either as a list ("- item" lines) or as indented key: value pairs.` });
      i++;
    }
    data[key] = kind === 'list' ? items.filter((x) => x !== null) : kind === 'map' ? nested : null;
  }
  return { present: true, data, bodyStart: closeAt, endLine: closeLine, issues };
}
