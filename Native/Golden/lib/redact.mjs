// OWNER: N0
// Licensed text never enters git or the test bundle (IOS-SPEC §2.6). Every generator writes text through these
// helpers: text from a collection with export_text_allowed = 0 becomes {"$redacted": sha256(UTF-8), "len": UTF-16
// length}, which the Swift comparator matches by hashing its own output.

import { createHash } from 'node:crypto';

/** SHA-256 (lowercase hex) of the UTF-8 bytes of `s`. */
export function sha256Utf8(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/** The redacted stand-in of one text. */
export function redactText(s) {
  const str = String(s);
  return { $redacted: sha256Utf8(str), len: str.length };
}

/** Whether a value is a redaction stand-in. */
export function isRedacted(v) {
  return v !== null && typeof v === 'object' && typeof v.$redacted === 'string' && Number.isInteger(v.len);
}

/**
 * A redactor bound to one database: `text(collection, s)` returns `s` for open collections and the stand-in for
 * restricted ones. `collection` is a collection id or slug. Unknown collections are treated as restricted.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function makeRedactor(db) {
  const rows = db.prepare('SELECT id, slug, export_text_allowed AS ok FROM collection').all();
  const open = new Set();
  const known = new Set();
  for (const r of rows) {
    known.add(r.id); known.add(r.slug);
    if (r.ok === 1) { open.add(r.id); open.add(r.slug); }
  }
  const restricted = rows.filter((r) => r.ok !== 1).map((r) => r.slug);
  return {
    restricted,
    isOpen: (collection) => open.has(collection),
    text: (collection, s) => (open.has(collection) ? s : redactText(s)),
    known: (collection) => known.has(collection),
  };
}

/**
 * Walks a fixture value and throws if a string of ≥ 40 UTF-16 units hashes to one of `restrictedHashes` (a Set of
 * sha256 hex of restricted passages): the generator-side twin of FixtureLicenceTests.
 */
export function assertNoRestrictedText(value, restrictedHashes, where = '$') {
  if (!restrictedHashes || restrictedHashes.size === 0) return;
  if (typeof value === 'string') {
    if (value.length >= 40 && restrictedHashes.has(sha256Utf8(value))) {
      throw new Error(`redact: restricted text would be written at ${where}`);
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => assertNoRestrictedText(v, restrictedHashes, `${where}[${i}]`)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoRestrictedText(v, restrictedHashes, `${where}.${k}`);
  }
}
