#!/usr/bin/env node
// OWNER: N0
// LogicalDump, Node side (IOS-SPEC §2.3): a database as natural-keyed JSONL per table, so a reference database and a
// Swift-built device-profile atlas can be compared row by row. ScrollsStore/LogicalDump.swift reads the same
// ScrollsStore/Resources/dump-spec.json and must write byte-identical lines; Native/Docs/DIFFERENTIAL.md specifies the
// format (both dumpers implement that text, not each other).
//
//   node Golden/dump.mjs --db <scrolls.db> --out <dir> [--spec <dump-spec.json>] [--tables a,b] [--fts full|skip]
//   node Golden/dump.mjs --mini --out <dir> [--keep-db <path>]    the reference's mini fixture database, built by the
//                                                                  reference's own test helper in a temp directory
// Output: <out>/<table>.jsonl (one canonical JSON row per line, sorted by natural key) and <out>/digest.json
// ({table: {rows, sha256}} or {table: {skipped: reason}}).

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson } from '../../src/shared/ids.mjs';
import { refuseForbidden } from './lib/clone.mjs';
import { float12 } from './lib/normalize.mjs';

const GOLDEN = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SPEC = join(GOLDEN, '..', 'ScrollsKit', 'Sources', 'ScrollsStore', 'Resources', 'dump-spec.json');
export const MASKED = '<masked>';

/** Code-unit order (Array.prototype.sort's default), the order both dumpers sort keys in. */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Tables never dumped: SQLite internals and the shadow tables of FTS5 and R-tree virtual tables. */
export function isShadowTable(name, virtualTables) {
  if (name.startsWith('sqlite_')) return true;
  for (const v of virtualTables) {
    for (const suffix of ['_data', '_idx', '_content', '_docsize', '_config', '_node', '_parent', '_rowid']) {
      if (name === v + suffix) return true;
    }
  }
  return false;
}

/** The built-in virtual-column rules (IOS-SPEC §2.3). */
const COLUMN_RULES = {
  // document_text.original: a device atlas reads it through TextStore; both sides write the text's digest
  'TextStore.fullText → sha256': (v) => (v === null ? null : { $sha256: sha256(Buffer.from(String(v), 'utf8')), len: String(v).length }),
  // relationship_revision.after_json: compact device rows expand to the reference's full JSON before dumping
  'Revisions.expanded': (v) => (v === null ? null : JSON.parse(v)),
};
const FTS_RULE = 'rowid → passage key; fts5vocab instance (term, doc key, offset) → sha256';

function value(v, declared) {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return { $blob: sha256(Buffer.from(v)), len: v.length };
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return /REAL|FLOA|DOUB/i.test(declared) || !Number.isInteger(v) ? float12(v) : v;
  return v;
}

/**
 * Dumps `db` per `spec` into `out`. Returns the digest object.
 * @param {DatabaseSync} db
 * @param {{tables: Record<string, object>}} spec
 */
export function dump(db, spec, out, { tables = null, fts = 'full' } = {}) {
  mkdirSync(out, { recursive: true });
  const master = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  const virtualTables = master.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql ?? '')).map((t) => t.name);
  const names = master.map((t) => t.name).filter((n) => !isShadowTable(n, virtualTables));
  const wanted = tables ?? names;
  const missing = wanted.filter((n) => !spec.tables[n]);
  if (missing.length) throw new Error(`dump-spec.json has no entry for: ${missing.join(', ')}`);

  const columns = new Map();
  const colsOf = (t) => {
    if (!columns.has(t)) columns.set(t, db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all().map((c) => ({ name: c.name, type: c.type })));
    return columns.get(t);
  };
  const selfColumn = (t) => Object.entries(spec.tables[t]?.ids ?? {}).find(([, to]) => to === 'self')?.[0] ?? null;
  const rowById = new Map();
  const fetchRow = (t, id) => {
    const col = selfColumn(t);
    if (!col) throw new Error(`dump-spec: ${t} is referenced by id but has no "self" id column`);
    if (!rowById.has(t)) rowById.set(t, db.prepare(`SELECT * FROM ${JSON.stringify(t)} WHERE ${JSON.stringify(col)} = ?`));
    return rowById.get(t).get(id);
  };
  const keyMemo = new Map();

  /** The table an id column of `t` points to for `row` (polymorphic ids name it in another column). */
  const target = (t, col, row) => {
    const to = spec.tables[t]?.ids?.[col];
    if (!to) return null;
    if (typeof to === 'string') return to;
    if (to.by) return row[to.by] === null ? null : (to.map?.[row[to.by]] ?? row[to.by]);
    throw new Error(`dump-spec: ${t}.${col}: unknown id rule`);
  };

  /** The natural key of the row of table `t` (an array of resolved key parts). */
  function naturalKey(t, row) {
    const parts = spec.tables[t]?.key;
    if (!parts) throw new Error(`dump-spec: ${t} has no key`);
    return parts.map((p) => part(t, row, p));
  }
  function keyOfId(t, id) {
    if (id === null || id === undefined) return null;
    const memo = `${t}\u0000${id}`;
    if (keyMemo.has(memo)) return keyMemo.get(memo);
    const row = fetchRow(t, id);
    const k = row ? naturalKey(t, row) : { $dangling: t, id: Number(id) };
    keyMemo.set(memo, k);
    return k;
  }
  function part(t, row, p) {
    const ids = spec.tables[t]?.ids ?? {};
    if (p in ids && ids[p] !== 'self') return keyOfId(target(t, p, row), row[p]);
    const dot = p.indexOf('.');
    const refTable = dot < 0 ? p : p.slice(0, dot);
    const viaCol = Object.keys(ids).find((c) => ids[c] === refTable);
    if (viaCol && dot < 0) return keyOfId(refTable, row[viaCol]);
    if (viaCol && dot > 0) {
      const ref = row[viaCol] === null ? null : fetchRow(refTable, row[viaCol]);
      return ref ? value(ref[p.slice(dot + 1)], '') : null;
    }
    if (!(p in row)) throw new Error(`dump-spec: ${t}: key part '${p}' is neither a column nor a referenced table`);
    return value(row[p], colsOf(t).find((c) => c.name === p)?.type ?? '');
  }

  const digest = {};
  for (const t of wanted.sort(byCodeUnits)) {
    const s = spec.tables[t];
    if (s.skip) { digest[t] = { skipped: s.skip }; continue; }
    let lines;
    if (s.virtual?.rows) {
      if (fts === 'skip') { digest[t] = { skipped: '--fts skip' }; continue; }
      lines = dumpFts(db, t, s.virtual.rows, (doc) => keyOfId(typeof s.virtual.rows === 'object' ? s.virtual.rows.doc : 'passage', doc));
    } else {
      const cols = colsOf(t);
      const mask = new Set(s.mask ?? []);
      const json = new Set(s.json ?? []);
      const text = new Set(s.text ?? []);
      const virtual = s.virtual ?? {};
      const maskIf = s.maskIf ?? null;
      lines = [];
      for (const row of db.prepare(`SELECT * FROM ${JSON.stringify(t)}`).iterate()) {
        const out = { $key: naturalKey(t, row) };
        const rowMasked = maskIf && maskIf.in.includes(row[maskIf.column]) ? new Set(maskIf.mask) : null;
        for (const { name, type } of cols) {
          const to = s.ids?.[name];
          if (to === 'self') continue;
          let v = row[name];
          if (v !== null && (mask.has(name) || rowMasked?.has(name))) v = MASKED;
          else if (to) v = keyOfId(target(t, name, row), v);
          else if (virtual[name]) {
            const rule = COLUMN_RULES[virtual[name]];
            if (!rule) throw new Error(`dump-spec: ${t}.${name}: unknown virtual rule '${virtual[name]}'`);
            v = rule(v);
          } else if (json.has(name)) v = v === null ? null : JSON.parse(v);
          else if (text.has(name)) v = v === null ? null : { $sha256: sha256(Buffer.from(String(v), 'utf8')), len: String(v).length };
          else v = value(v, type);
          out[name] = v;
        }
        lines.push([canonicalJson(out.$key), canonicalJson(out)]);
      }
    }
    lines.sort((a, b) => byCodeUnits(a[0], b[0]) || byCodeUnits(a[1], b[1]));
    const body = lines.map((l) => l[1]).join('\n') + (lines.length ? '\n' : '');
    writeFileSync(join(out, `${t}.jsonl`), body);
    digest[t] = { rows: lines.length, sha256: sha256(Buffer.from(body, 'utf8')) };
  }
  writeFileSync(join(out, 'digest.json'), `${JSON.stringify(digest, null, 2)}\n`);
  return digest;
}

/** FTS5 table rows through its fts5vocab instance table: [term, document key, column, offset], i.e. "FTS token i = JS token i". */
function dumpFts(db, table, rule, docKey) {
  const vocab = typeof rule === 'object' ? rule.fts5vocab : rule === FTS_RULE && table === 'passage_fts' ? 'passage_vocab_inst' : null;
  if (!vocab) throw new Error(`dump-spec: ${table}: unknown rows rule`);
  const lines = [];
  for (const r of db.prepare(`SELECT term, doc, col, offset FROM ${JSON.stringify(vocab)}`).iterate()) {
    const row = [r.term, docKey(r.doc), r.col, r.offset];
    lines.push([canonicalJson(row.slice(1)), canonicalJson(row)]);
  }
  return lines;
}

async function buildMini(keepDb) {
  const helper = await import(pathToFileURL(join(GOLDEN, '..', '..', 'tests', 'helpers', 'tmpdata.mjs')).href);
  const t = helper.makeTmpData({ seed: true, open: true });
  const path = t.dbPath ?? t.db?.location?.() ?? null;
  if (!path) throw new Error('tests/helpers/tmpdata.mjs makeTmpData() did not report its database path');
  t.db?.close?.();
  if (keepDb) { mkdirSync(dirname(resolve(keepDb)), { recursive: true }); copyFileSync(path, resolve(keepDb)); }
  return { path, cleanup: t.cleanup ?? (() => {}) };
}

async function main() {
  const a = { fts: 'full' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], next = () => argv[++i];
    if (k === '--db') a.db = next(); else if (k === '--out') a.out = next(); else if (k === '--spec') a.spec = next();
    else if (k === '--tables') a.tables = next().split(',').filter(Boolean); else if (k === '--fts') a.fts = next();
    else if (k === '--mini') a.mini = true; else if (k === '--keep-db') a.keepDb = next();
    else throw new Error(`unknown argument '${k}'`);
  }
  if (!a.out || (!a.db && !a.mini)) throw new Error('usage: dump.mjs (--db <path> | --mini [--keep-db <path>]) --out <dir> [--spec f] [--tables a,b] [--fts full|skip]');
  refuseForbidden(a.out, '--out');
  const specPath = resolve(a.spec ?? DEFAULT_SPEC);
  if (!existsSync(specPath)) throw new Error(`no dump spec at ${specPath} (ScrollsStore/Resources/dump-spec.json is written by the Store package)`);
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  let dbPath = a.db, cleanup = () => {};
  if (a.mini) ({ path: dbPath, cleanup } = await buildMini(a.keepDb));
  else refuseForbidden(dbPath, '--db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const digest = dump(db, spec, resolve(a.out), { tables: a.tables ?? null, fts: a.fts });
    console.log(JSON.stringify({ db: a.mini ? 'mini' : dbPath, out: resolve(a.out), tables: Object.keys(digest).length }));
  } finally {
    db.close();
    cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[dump] FAILED: ${e?.stack ?? e}`); process.exit(1); });
}
