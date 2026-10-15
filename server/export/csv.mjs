// OWNER: WP3
// csv.mjs — CSV export writer (SPEC §7.3): the manifest as `#` comment lines first, then a header and RFC 4180
// rows. Withheld text (collections with export_text_allowed = 0) arrives here already as null — this writer
// never sees it.

/**
 * One CSV field: null/undefined → empty; objects → JSON; quoted when it holds a comma, quote, CR or LF.
 * @param {unknown} v
 * @returns {string}
 */
export function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * RFC 4180 CSV text: a header of `columns`, then one line per row (LF line ends).
 * @param {object[]} rows
 * @param {string[]} columns
 * @returns {string}
 */
export function toCsv(rows, columns) {
  const lines = [columns.map(csvField).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvField(r[c])).join(','));
  return `${lines.join('\n')}\n`;
}

/**
 * The manifest as `#` comment lines (pretty-printed JSON, one space indent), ending with a newline.
 * @param {object} manifest
 * @returns {string}
 */
export function csvManifest(manifest) {
  return `${JSON.stringify(manifest, null, 1).split('\n').map((l) => `# ${l}`).join('\n')}\n`;
}
