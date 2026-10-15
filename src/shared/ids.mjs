// OWNER: WP0 — references, slugs, hashes and seeded randomness shared by server and browser (SPEC §12.2)
//
// No node: imports: sha256Hex uses globalThis.crypto.subtle, available in Node ≥ 19 and every browser.

const REF_TYPE_RE = /^[a-z_][a-z0-9_-]*$/;

/**
 * A typed reference string: ref('passage', 901) → 'passage:901'.
 * @param {string} type
 * @param {string|number} id
 * @returns {string}
 */
export function ref(type, id) {
  if (!REF_TYPE_RE.test(type)) throw new TypeError(`ref: invalid type '${type}'`);
  if (id === null || id === undefined || id === '') throw new TypeError('ref: missing id');
  return `${type}:${id}`;
}

/**
 * Parse 'passage:901' → { type: 'passage', id: 901 }. Only the first ':' separates, so etymon keys keep
 * theirs ('etymon:sa:शून्य' → id 'sa:शून्य'); all-digit ids become numbers.
 * @param {string} s
 * @returns {{type: string, id: string|number}}
 * @throws {TypeError} when `s` is not a reference
 */
export function parseRef(s) {
  const str = String(s ?? '');
  const i = str.indexOf(':');
  const type = str.slice(0, i), id = str.slice(i + 1);
  if (i <= 0 || !REF_TYPE_RE.test(type) || id === '') throw new TypeError(`parseRef: not a reference: '${str}'`);
  return { type, id: /^\d{1,15}$/.test(id) ? Number(id) : id };
}

/**
 * URL-safe slug that keeps letters of every script ('ગણિત પોથી' → 'ગણિત-પોથી'); Latin accents are
 * dropped; cut at a '-' boundary when longer than `max`. Returns 'untitled' when nothing is left.
 * @param {string} s
 * @param {number} [max=48]
 * @returns {string}
 */
export function slugify(s, max = 48) {
  let out = String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC').toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (out.length > max) {
    const cut = out.slice(0, max);
    const at = cut.lastIndexOf('-');
    out = (at >= max / 2 ? cut.slice(0, at) : cut).replace(/-+$/, '');
  }
  return out || 'untitled';
}

const FNV_OFFSET = 0x811c9dc5, FNV_PRIME = 0x01000193;

/**
 * FNV-1a 32-bit. Strings are hashed over their UTF-8 bytes; a Uint32Array over each element's four
 * little-endian bytes; a Uint8Array over its bytes.
 * @param {string|Uint32Array|Uint8Array} input
 * @returns {number} unsigned 32-bit
 */
export function fnv1a32(input) {
  if (input instanceof Uint32Array) return fnv1a32U32(input, 0, input.length);
  let h = FNV_OFFSET;
  if (input instanceof Uint8Array) {
    for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input[i], FNV_PRIME);
    return h >>> 0;
  }
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
    }
    if (c >= 0xD800 && c <= 0xDFFF) c = 0xFFFD;   // lone surrogate → U+FFFD, as TextEncoder does
    if (c < 0x80) {
      h = Math.imul(h ^ c, FNV_PRIME);
    } else if (c < 0x800) {
      h = Math.imul(h ^ (0xC0 | (c >> 6)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME);
    } else if (c < 0x10000) {
      h = Math.imul(h ^ (0xE0 | (c >> 12)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 63)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME);
    } else {
      h = Math.imul(h ^ (0xF0 | (c >> 18)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | ((c >> 12) & 63)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 63)), FNV_PRIME);
      h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME);
    }
  }
  return h >>> 0;
}

/**
 * FNV-1a 32-bit over elements [start, end) of a Uint32Array (little-endian bytes), without allocating —
 * for winnowing shingles of token ids.
 * @param {Uint32Array} arr @param {number} start @param {number} end
 * @returns {number}
 */
export function fnv1a32U32(arr, start, end) {
  let h = FNV_OFFSET;
  for (let i = start; i < end; i++) {
    const v = arr[i];
    h = Math.imul(h ^ (v & 255), FNV_PRIME);
    h = Math.imul(h ^ ((v >>> 8) & 255), FNV_PRIME);
    h = Math.imul(h ^ ((v >>> 16) & 255), FNV_PRIME);
    h = Math.imul(h ^ (v >>> 24), FNV_PRIME);
  }
  return h >>> 0;
}

/**
 * Short lowercase hex digest of a string (FNV-1a based; not cryptographic). n ≤ 16.
 * @param {string} s
 * @param {number} [n=4]
 * @returns {string}
 */
export function shortHash(s, n = 4) {
  if (!(n >= 1 && n <= 16)) throw new RangeError('shortHash: n must be 1–16');
  const a = fnv1a32(String(s)).toString(16).padStart(8, '0');
  if (n <= 8) return a.slice(0, n);
  const b = fnv1a32(`\u0001${s}`).toString(16).padStart(8, '0');
  return (a + b).slice(0, n);
}

/**
 * Deterministic PRNG (mulberry32): mulberry32(1994)() → a float in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * JSON with recursively sorted object keys and no whitespace — the canonical form hashed for params,
 * view states and run fingerprints. Follows JSON.stringify for undefined, functions, toJSON and
 * non-finite numbers; throws on cycles.
 * @param {unknown} obj
 * @returns {string}
 */
export function canonicalJson(obj) {
  const seen = new Set();
  const walk = (v) => {
    if (v && typeof v.toJSON === 'function') v = v.toJSON();
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    if (typeof v === 'bigint') throw new TypeError('canonicalJson: BigInt is not JSON');
    if (typeof v !== 'object') return undefined;
    if (seen.has(v)) throw new TypeError('canonicalJson: cyclic structure');
    seen.add(v);
    let out;
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      out = `[${Array.from(v, (x) => walk(x) ?? 'null').join(',')}]`;
    } else {
      const parts = [];
      for (const k of Object.keys(v).sort()) {
        const s = walk(v[k]);
        if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
      }
      out = `{${parts.join(',')}}`;
    }
    seen.delete(v);
    return out;
  };
  return walk(obj) ?? 'null';
}

/**
 * SHA-256 hex digest (lowercase) via WebCrypto. Strings are hashed as UTF-8.
 * @param {string|ArrayBuffer|ArrayBufferView} input
 * @returns {Promise<string>}
 */
export async function sha256Hex(input) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('sha256Hex: WebCrypto (globalThis.crypto.subtle) is unavailable');
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input)
    : input instanceof ArrayBuffer ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}
