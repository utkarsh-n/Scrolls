// OWNER: WP0 — runtime configuration: version, port, data directory layout, Cipher paths, flags (SPEC §0.2, §12.2)
//
// The data directory lives outside iCloud (D10, §0.2): `dataDir()` refuses any path under ~/Documents or
// ~/Library/Mobile Documents with E_DB_IN_ICLOUD before anything is created there.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** App version, from package.json. */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * TCP port: SCROLLS_PORT or 3460. `SCROLLS_PORT=0` asks the OS for a free port (tests); the bound port is
 * then reported by startServer().
 */
export const PORT = portFromEnv(process.env.SCROLLS_PORT);
/** Loopback only (D12). */
export const HOST = '127.0.0.1';

/** Project root (the folder holding package.json). */
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

function portFromEnv(raw) {
  if (raw === undefined || raw === '') return 3460;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < 65536 ? n : 3460;
}

/**
 * Directories under which a SQLite database must never live (iCloud Drive syncs them and corrupts WAL files).
 * @returns {string[]}
 */
export function icloudRoots() {
  const home = homedir();
  return [path.join(home, 'Documents'), path.join(home, 'Library', 'Mobile Documents')];
}

/** The nearest existing ancestor of `p`, resolved through symlinks (so a symlink into iCloud is caught). */
function realpathOfExistingAncestor(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    if (existsSync(cur)) return path.join(realpathSync(cur), ...rest.reverse());
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.push(path.basename(cur));
    cur = parent;
  }
}

/**
 * Whether `p` lies under an iCloud-synced directory (checked on the path as written and on its real path).
 * @param {string} p
 * @returns {boolean}
 */
export function isUnderICloud(p) {
  const candidates = [path.resolve(p), realpathOfExistingAncestor(p)];
  const roots = icloudRoots().flatMap((r) => (existsSync(r) ? [r, realpathSync(r)] : [r]));
  return candidates.some((c) => roots.some((r) => c === r || c.startsWith(r + path.sep)));
}

/**
 * Throw E_DB_IN_ICLOUD when `p` is under iCloud.
 * @param {string} p
 */
export function assertNotICloud(p) {
  if (!isUnderICloud(p)) return;
  const err = new Error(`Refusing to keep Scrolls data under iCloud (${p}). Set SCROLLS_DATA to a folder outside ` +
    '~/Documents and ~/Library/Mobile Documents, e.g. ~/Developer/scrolls-data.');
  err.code = 'E_DB_IN_ICLOUD';
  throw err;
}

/**
 * The runtime data directory: $SCROLLS_DATA or ~/Developer/scrolls-data.
 * @returns {string}
 * @throws {Error} code E_DB_IN_ICLOUD when the directory is under iCloud
 */
export function dataDir() {
  const dir = path.resolve(process.env.SCROLLS_DATA || path.join(homedir(), 'Developer', 'scrolls-data'));
  assertNotICloud(dir);
  return dir;
}

/**
 * Every path of the runtime data layout (§0.2).
 * @returns {{data:string, db:string, originals:string, incoming:string, derived:string, tokens:string,
 *   spaces:string, align:string, reuse:string, wiktionary:string, sources:string, cache:string, exports:string,
 *   snapshots:string, logs:string, bin:string}}
 */
export function paths() {
  const data = dataDir();
  const derived = path.join(data, 'derived');
  return {
    data,
    db: path.join(data, 'scrolls.db'),
    originals: path.join(data, 'originals'),
    incoming: path.join(data, 'incoming'),
    derived,
    tokens: path.join(derived, 'tokens'),
    spaces: path.join(derived, 'spaces'),
    align: path.join(derived, 'align'),
    reuse: path.join(derived, 'reuse'),
    wiktionary: path.join(derived, 'wiktionary'),
    sources: path.join(data, 'sources'),
    cache: path.join(data, 'cache'),
    exports: path.join(data, 'exports'),
    snapshots: path.join(data, 'snapshots'),
    logs: path.join(data, 'logs'),
    bin: path.join(data, 'bin'),
  };
}

/** Create every directory of the layout (never the database file itself). */
export function ensureDirs() {
  const p = paths();
  for (const [key, dir] of Object.entries(p)) if (key !== 'db') mkdirSync(dir, { recursive: true });
}

// ── Cipher (read in place; §0.1, §6) ────────────────────────────────────────────────────────────────

const CIPHER_ROOT = path.resolve(process.env.SCROLLS_CIPHER_ROOT || path.join(homedir(), 'Documents', 'AI Stuff', 'Cipher'));
const R = path.join(CIPHER_ROOT, 'Cipher', 'Resources');
const T = path.join(CIPHER_ROOT, 'Tools', 'data', 'culture');

/** Paths of the Cipher datasets (data-inventory.md; `SCROLLS_CIPHER_ROOT` overrides the root). */
export const CIPHER = Object.freeze({
  root: CIPHER_ROOT,
  resources: R,
  cultureWorks: path.join(R, 'culture-works.tsv'),
  cultureThemes: path.join(R, 'culture-themes.tsv'),
  cultureLines: path.join(R, 'culture-lines.tsv'),
  roots: path.join(R, 'roots.tsv'),
  gutenbergJson: path.join(T, 'texts', 'gutenberg.json'),
  gutenbergDir: path.join(T, 'texts', 'gutenberg'),
  pgCatalog: path.join(T, 'pg_catalog.csv'),
  wikisourceHi: path.join(T, 'texts', 'wikisource-hi.jsonl'),
  wikisourceGu: path.join(T, 'texts', 'wikisource-gu.jsonl'),
  tagsDir: path.join(T, 'tags'),
  relationsDir: path.join(T, 'songs'),
  musicbrainzTables: path.join(homedir(), 'Developer', 'cipher-data', 'musicbrainz', 'tables'),
});

// culture-lines is a test oracle and the MusicBrainz tables serve only the demo-name test: neither is
// needed for the bootstrap, so neither makes Cipher "missing".
const CIPHER_REQUIRED = ['cultureWorks', 'cultureThemes', 'roots', 'gutenbergJson', 'gutenbergDir', 'pgCatalog',
  'wikisourceHi', 'wikisourceGu', 'tagsDir', 'relationsDir'];

/**
 * Whether the Cipher files needed by the bootstrap exist.
 * @returns {{ok:boolean, missing:string[]}} `missing` lists the CIPHER keys whose path is absent
 */
export function cipherStatus() {
  const missing = CIPHER_REQUIRED.filter((k) => !existsSync(CIPHER[k]));
  return { ok: missing.length === 0, missing };
}

// ── Flags (read lazily so tests can set the environment after import) ──────────────────────────────

/** Runtime flags from the environment. */
export const FLAGS = Object.freeze({
  /** SCROLLS_MOCK=1 serves tests/contract fixtures instead of the real routes. */
  get mock() { return process.env.SCROLLS_MOCK === '1'; },
  /** SCROLLS_NO_AUTO_IMPORT=1 disables the first-launch Cipher bootstrap (D10). */
  get noAutoImport() { return process.env.SCROLLS_NO_AUTO_IMPORT === '1'; },
  /** SCROLLS_NO_DEMO=1 skips the first-launch demo load (tests that do not need the demo). */
  get noDemo() { return process.env.SCROLLS_NO_DEMO === '1'; },
  /** Read-pool size (D11: 3). SCROLLS_READ_WORKERS overrides it for tests and small machines. */
  get readWorkers() {
    const n = Number(process.env.SCROLLS_READ_WORKERS);
    return Number.isInteger(n) && n > 0 && n <= 16 ? n : 3;
  },
  /** 'debug' | 'info' | 'warn' | 'error' (SCROLLS_LOG_LEVEL). */
  get logLevel() {
    const l = process.env.SCROLLS_LOG_LEVEL;
    return ['debug', 'info', 'warn', 'error', 'silent'].includes(l) ? l : 'info';
  },
});

// ── Logging: JSON lines to stderr and $SCROLLS_DATA/logs/scrolls.log ─────────────────────────────────

const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Write one log line. Messages at or above FLAGS.logLevel go to stderr; info and above always go to
 * logs/scrolls.log when the data directory exists.
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} message
 * @param {object} [data]
 */
export function log(level, message, data) {
  const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...(data ? { data } : {}) });
  if ((LEVEL_RANK[level] ?? 20) >= LEVEL_RANK[FLAGS.logLevel]) process.stderr.write(line + '\n');
  if ((LEVEL_RANK[level] ?? 20) < LEVEL_RANK.info) return;
  try {
    const logs = paths().logs;
    if (existsSync(logs)) appendFileSync(path.join(logs, 'scrolls.log'), line + '\n');
  } catch { /* logging never breaks the caller */ }
}
