// OWNER: WP0 — static files: public/ at /, src/ui at /ui, src/shared at /shared; server/** is never served (SPEC §8)

import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.mjs';
import { etagMatches } from './etag.mjs';
import { SECURITY_HEADERS } from './security.mjs';

const MOUNTS = [
  { prefix: '/ui/', root: path.join(PROJECT_ROOT, 'src', 'ui') },
  { prefix: '/shared/', root: path.join(PROJECT_ROOT, 'src', 'shared') },
  { prefix: '/', root: path.join(PROJECT_ROOT, 'public') },
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve a URL pathname to a file inside one of the mounts, or null. Rejects traversal, NUL bytes,
 * dot-files and unknown extensions.
 * @param {string} pathname
 * @returns {string|null}
 */
export function resolveStatic(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  const mount = MOUNTS.find((m) => decoded.startsWith(m.prefix));
  if (!mount) return null;
  const rel = decoded.slice(mount.prefix.length);
  if (rel.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) return null;
  const file = path.resolve(mount.root, rel);
  if (file !== mount.root && !file.startsWith(mount.root + path.sep)) return null;
  if (!TYPES[path.extname(file).toLowerCase()]) return null;
  return file;
}

/**
 * Serve a static file for GET/HEAD. Returns false (and writes nothing) when no file matches, so the caller
 * can answer 404.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean}
 */
export function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname.startsWith('/api/')) return false;
  const file = resolveStatic(pathname);
  if (!file) return false;
  let st;
  try { st = statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': TYPES[path.extname(file).toLowerCase()],
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return true; }
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}
