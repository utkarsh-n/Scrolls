// OWNER: WP3
// routes/exports.mjs — exports and snapshots (SPEC §7.3). Exports are built in the read pool.
//
//   GET  /api/export?view=<slug>|state=<b64url or #hash>&what=occurrences|aggregates|passages|relationships|annotations|bundle
//        &format=json|jsonl|csv|html[&tier=L2][&snapshot=<file.svg>]      (html only with what=bundle)
//   POST /api/snapshots { view?, png?: "data:image/png;base64,…", svg?: "<svg…>", synthetic? } → { file, url, files }
//   GET  /api/snapshots/:file                                             the stored PNG or SVG
//
// A snapshot of synthetic material must carry the SYNTHETIC stamp: an SVG for a synthetic view (or flagged
// synthetic) without it is refused (honesty rule 1). The PNG is composed by the client; its stamp cannot be read
// back here.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { shortHash } from '../../src/shared/ids.mjs';
import { paths } from '../config.mjs';
import { stmt } from '../db/open.mjs';
import { HttpError } from '../http/errors.mjs';

const EXPORT_URL = new URL('../export/manifest.mjs', import.meta.url).href;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(png|svg)$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG = 20 * 1024 * 1024;
const MAX_SVG = 5 * 1024 * 1024;
const TYPES = { png: 'image/png', svg: 'image/svg+xml; charset=utf-8' };

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/**
 * Store a snapshot (PNG and/or SVG) under $SCROLLS_DATA/snapshots/ and, for a saved view, its SVG in
 * saved_view.snapshot_svg.
 * @param {object} ctx RouteCtx
 * @param {{view?: string|null, png?: string, svg?: string, synthetic?: boolean}} body
 * @returns {{file: string, url: string, files: string[]}}
 * @throws {HttpError} 400 E_VALIDATION, 404 for an unknown view
 */
export function storeSnapshot(ctx, body) {
  const b = body ?? {};
  if (typeof b.png !== 'string' && typeof b.svg !== 'string') {
    throw new HttpError(400, 'E_VALIDATION', 'A snapshot needs a PNG data URL or an SVG document.', null, { fields: ['png', 'svg'] });
  }
  let view = null, corpus = null, synthetic = b.synthetic === true;
  if (b.view !== undefined && b.view !== null) {
    view = stmt(ctx.db, 'SELECT slug, state_json FROM saved_view WHERE slug = ? AND deleted_at IS NULL').get(String(b.view));
    if (!view) throw new HttpError(404, 'E_NOT_FOUND', `No saved view '${b.view}'.`);
    try { corpus = JSON.parse(view.state_json).corpus ?? null; } catch { corpus = null; }
    if (corpus && stmt(ctx.db, 'SELECT is_synthetic FROM corpus WHERE slug = ?').get(corpus)?.is_synthetic === 1) synthetic = true;
  }
  const files = [];
  const dv = ctx.dataVersion();
  const base = `scrolls-${corpus ?? 'view'}-v${dv}`;
  const dir = paths().snapshots;
  mkdirSync(dir, { recursive: true });
  if (typeof b.png === 'string') {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(b.png);
    if (!m) throw new HttpError(400, 'E_VALIDATION', 'png must be a data:image/png;base64 URL.', null, { field: 'png' });
    const bytes = Buffer.from(m[1].replace(/\s/g, ''), 'base64');
    if (bytes.length > MAX_PNG) throw new HttpError(400, 'E_VALIDATION', 'The PNG is larger than 20 MB.', null, { field: 'png' });
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new HttpError(400, 'E_VALIDATION', 'The png data is not a PNG image.', null, { field: 'png' });
    const file = `${base}-${shortHash(m[1], 8)}.png`;
    writeAtomic(path.join(dir, file), bytes);
    files.push(file);
  }
  if (typeof b.svg === 'string') {
    if (Buffer.byteLength(b.svg) > MAX_SVG) throw new HttpError(400, 'E_VALIDATION', 'The SVG is larger than 5 MB.', null, { field: 'svg' });
    if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(b.svg)) throw new HttpError(400, 'E_VALIDATION', 'svg must be an SVG document.', null, { field: 'svg' });
    if (synthetic && !/SYNTHETIC/.test(b.svg)) {
      throw new HttpError(400, 'E_VALIDATION', 'A snapshot of synthetic data must carry the SYNTHETIC stamp.',
        'Render the snapshot with its SYNTHETIC stamp (the display list adds it whenever synthetic items are visible).', { field: 'svg' });
    }
    const file = `${base}-${shortHash(b.svg, 8)}.svg`;
    writeAtomic(path.join(dir, file), b.svg);
    files.push(file);
    if (view) ctx.withWrite((db) => stmt(db, 'UPDATE saved_view SET snapshot_svg = ? WHERE slug = ?').run(b.svg, view.slug));
  }
  return { file: files[0], url: `/api/snapshots/${files[0]}`, files };
}

/** @type {Array<{method: string, path: string, heavy?: boolean, handler: Function}>} */
export const routes = [
  {
    method: 'GET',
    path: '/api/export',
    heavy: true,
    async handler(req, ctx) {
      const q = req.query;
      if (!q.view && !q.state) {
        throw new HttpError(400, 'E_VALIDATION', 'An export needs view=<slug> or state=<…>.', 'Export from a saved view, or pass the current state.', { field: 'state' });
      }
      const r = await ctx.pool.run(EXPORT_URL, 'exportQuery', {
        view: q.view || null, state: q.state || null, what: q.what ?? 'occurrences', format: q.format ?? 'json', tier: q.tier ?? 'L2',
        snapshot: q.snapshot || null,
      }, { timeoutMs: 30000 });
      return {
        body: r.body,
        headers: { 'Content-Type': r.contentType, 'Content-Disposition': `attachment; filename="${r.filename}"`, 'X-Scrolls-Rows': String(r.rows) },
      };
    },
  },
  {
    method: 'POST',
    path: '/api/snapshots',
    async handler(req, ctx) {
      return { json: storeSnapshot(ctx, req.body) };
    },
  },
  {
    method: 'GET',
    path: '/api/snapshots/:file',
    async handler(req) {
      const name = String(req.params.file);
      const m = FILE_RE.exec(name);
      if (!m) throw new HttpError(404, 'E_NOT_FOUND', `No snapshot ${name}.`);
      let bytes;
      try { bytes = readFileSync(path.join(paths().snapshots, name)); } catch { throw new HttpError(404, 'E_NOT_FOUND', `No snapshot ${name}.`); }
      return { body: bytes, headers: { 'Content-Type': TYPES[m[1]], 'Content-Disposition': `inline; filename="${name}"` } };
    },
  },
];
