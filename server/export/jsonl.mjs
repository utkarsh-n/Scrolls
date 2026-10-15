// OWNER: WP3
// jsonl.mjs — JSONL export writer (SPEC §7.3): the first line is {"manifest": …}, then one row per line.

/**
 * One JSON object per line, each line ending with a newline.
 * @param {object[]} rows
 * @returns {string}
 */
export function toJsonl(rows) {
  let out = '';
  for (const r of rows) out += `${JSON.stringify(r)}\n`;
  return out;
}

/**
 * A JSONL export: manifest line first.
 * @param {object} manifest
 * @param {object[]} rows
 * @returns {string}
 */
export function jsonlExport(manifest, rows) {
  return toJsonl([{ manifest }, ...rows]);
}
