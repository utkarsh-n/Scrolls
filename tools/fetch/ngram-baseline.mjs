#!/usr/bin/env node
/**
 * ngram-baseline.mjs — stages the Google Books Ngram Viewer dataset v3 (20200217), English ("eng")
 * 1-grams, as an external yearly print-frequency baseline for Scrolls.
 *
 * What it does (see FORMAT.md / MANIFEST.json beside the output for the full contract):
 *   1. GETs totalcounts-1 (cached by lib.mjs) and HEADs the 24 shards (size + md5 from x-goog-hash).
 *   2. Pass 1, one child process per shard (≤ 6 at once): streams curl | gzip -dc (the .gz is never
 *      stored), md5-checks the streamed bytes against Google's published md5, drops POS-tagged forms
 *      (any token containing "_": word_NOUN, _NOUN_, _START_ …), folds the token to lowercase NFC,
 *      keeps only letter tokens (internal apostrophes / hyphens allowed, 1–40 code points), keeps
 *      years 1500–2019, and appends each surviving line to one of 64 hash buckets in the tmp dir.
 *   3. Merge, one child per bucket: case/normalisation variants (which live in different shards) are
 *      aggregated globally — match counts summed, volume counts max-ed (a lower bound; see FORMAT.md).
 *      Every type with total ≥ FLOOR (10,000), plus the seed words, is encoded as a candidate row.
 *   4. Picks the threshold (smallest step of a 1-2-5 ladder ≥ FLOOR whose store fits ≤ 250 MB,
 *      unless --threshold N), writes ngram-eng-1.sqlite (+ seed words below threshold), verifies
 *      every blob decodes to its stored total, prints per-decade per-million shapes for a few words,
 *      writes MANIFEST.json, removes the tmp dir, prints "DONE …".
 *
 * Usage:
 *   node ngram-baseline.mjs                         full run (idempotent; a re-run resumes per shard / bucket)
 *   node ngram-baseline.mjs --test --shards 12,23 --max-lines 300000
 *                                                   tiny slice; everything goes to <tmp>/test/, nothing to sources/
 *   flags: --threshold N  --keep-tmp  --force (rebuild the DB even if a complete one exists)
 *   internal (spawned by the parent): --child-shard N | --child-bucket N
 */
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, writeSync,
  closeSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { DATA, SOURCES, USER_AGENT, fetchCached, log, writeManifest } from "./lib.mjs";

// ---------------------------------------------------------------------------------------------
// constants
const SCRIPT = fileURLToPath(import.meta.url);
const VERSION = "20200217";
const BASE = `https://storage.googleapis.com/books/ngrams/books/${VERSION}/eng`;
const NSHARDS = 24;
const shardName = (i) => `1-${String(i).padStart(5, "0")}-of-${String(NSHARDS).padStart(5, "0")}.gz`;
const shardUrl = (i) => `${BASE}/${shardName(i)}`;
const TOTALS_URL = `${BASE}/totalcounts-1`;
const Y0 = 1500, Y1 = 2019, NY = Y1 - Y0 + 1; // 520 yearly slots
const NBUCKETS = 64;
const FLOOR = 10_000; // candidate rows are built for every type at or above this total
const LADDER = [1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7];
const TARGET_MAX = 250e6; // bytes; the automatic rule keeps the store at or below this estimate
const BAND = [100e6, 300e6]; // acceptable final size; the rule steps the ladder if the built file falls outside
const MAX_CHILDREN = 6;
const MAX_ATTEMPTS = 3;
const UINT32_MAX = 0xffffffff;
// letters (any script, with combining marks), optionally joined by single internal ' or -
const TOKEN_RE = /^\p{L}[\p{L}\p{M}]*(?:['-]\p{L}[\p{L}\p{M}]*)*$/u;
const POS_TAGS = new Set(["NOUN", "VERB", "ADJ", "ADV", "PRON", "DET", "ADP", "NUM", "CONJ", "PRT", "X", "."]);
const SEED_TEXT = `virus viral bug debug hacker hack algorithm computer computing robot scientist vaccine
vaccinate atom atomic electron quantum gene genetic genome dna evolution entropy energy radiation radioactive
nuclear rocket orbit satellite internet online network software hardware cyber digital data database code
program programming byte pixel laser radar sonar transistor microchip calculus statistics probability theorem
infinity vector matrix algorithm logarithm germ bacteria microbe antibiotic penicillin insulin hormone neuron
synapse dopamine adrenaline cholesterol cancer tumor immune immunity pandemic epidemic quarantine inoculation
anesthesia surgery stethoscope x-ray telescope microscope galaxy gravity relativity electricity magnet magnetic
voltage circuit engine motor turbine dynamo steam telegraph telephone radio television video cell mitochondria
protein enzyme catalyst chemistry alchemy oxygen hydrogen carbon plutonium uranium spectrum frequency
wavelength amplitude feedback cybernetics automation algorithmic meme viral rap rapper hip-hop beat sample
remix flow bars cipher mixtape freestyle diss`;
const VERIFY_WORDS = ["computer", "virus", "hacker", "telegraph", "dna", "internet", "radio", "steam"];

// ---------------------------------------------------------------------------------------------
// args and paths
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const TEST = flag("--test");
const MAX_LINES = Number(opt("--max-lines", 0)) || 0;
const TMP_ROOT = join(DATA, "cache", "ngram-baseline-tmp");
const TMP = TEST ? join(TMP_ROOT, "test") : TMP_ROOT;
const OUT_DIR = TEST ? join(TMP, "out") : join(SOURCES, "ngram-baseline");
const DB_NAME = "ngram-eng-1.sqlite";
const SHARDS = opt("--shards", null)
  ? opt("--shards").split(",").map((s) => Number(s.trim()))
  : Array.from({ length: NSHARDS }, (_, i) => i);
const pad2 = (n) => String(n).padStart(2, "0");
const shardDir = (i) => join(TMP, "shards", pad2(i));
const bucketFile = (i, b) => join(shardDir(i), `b${pad2(b)}.tsv`);
const mergeDir = join(TMP, "merge");

// ---------------------------------------------------------------------------------------------
// shared helpers
export function fold(token) {
  // ASCII needs no normalisation; everything else: NFC → lowercase → NFC (lowercasing can denormalise)
  return /^[\x00-\x7f]*$/.test(token) ? token.toLowerCase() : token.normalize("NFC").toLowerCase().normalize("NFC");
}
export function keepToken(folded) {
  if (!TOKEN_RE.test(folded)) return false;
  const n = /^[\x00-\x7f]*$/.test(folded) ? folded.length : [...folded].length;
  return n >= 1 && n <= 40;
}
function isPosTagged(token) {
  if (/^_[A-Z.]+_$/.test(token)) return true; // bare tag tokens: _NOUN_, _START_, _END_, _ROOT_, _._
  const u = token.lastIndexOf("_");
  return u > 0 && POS_TAGS.has(token.slice(u + 1));
}
function seedWords() {
  const seen = new Set(), list = [];
  for (const w of SEED_TEXT.split(/\s+/).filter(Boolean)) {
    const f = fold(w);
    if (!seen.has(f)) { seen.add(f); list.push(f); }
  }
  return list;
}
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function readJSON(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
function writeJSONAtomic(path, value) {
  writeFileSync(path + ".part", JSON.stringify(value, null, 2) + "\n");
  renameSync(path + ".part", path);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1e6).toFixed(1) + " MB";

/** Iterate lines of a Buffer: fn(start, end) with end exclusive (newline not included). */
function eachLine(buf, fn) {
  let s = 0;
  while (s < buf.length) {
    let e = buf.indexOf(10, s);
    if (e < 0) e = buf.length;
    if (e > s) fn(s, e);
    s = e + 1;
  }
}

// ---------------------------------------------------------------------------------------------
// pass 1 (child): one shard → 64 bucket files
class BucketWriter {
  constructor(dir) {
    this.dir = dir;
    this.fds = new Array(NBUCKETS).fill(null);
    this.bufs = new Array(NBUCKETS).fill(null);
    this.offs = new Int32Array(NBUCKETS);
    this.bytes = 0;
  }
  put(b, head, src, s, e) {
    let buf = this.bufs[b];
    if (!buf) {
      buf = this.bufs[b] = Buffer.allocUnsafe(1 << 20);
      this.fds[b] = openSync(join(this.dir, `b${pad2(b)}.tsv`), "w");
    }
    const need = Buffer.byteLength(head) + (e - s) + 1;
    if (this.offs[b] + need > buf.length) this.flush(b);
    let o = this.offs[b];
    o += buf.write(head, o, "utf8");
    if (e > s) o += src.copy(buf, o, s, e);
    buf[o++] = 10;
    this.offs[b] = o;
    this.bytes += need;
  }
  flush(b) {
    if (this.offs[b] > 0) { writeSync(this.fds[b], this.bufs[b], 0, this.offs[b]); this.offs[b] = 0; }
  }
  close() {
    for (let b = 0; b < NBUCKETS; b++) if (this.fds[b] !== null) { this.flush(b); closeSync(this.fds[b]); }
  }
}

async function shardPass(i) {
  const heads = readJSON(join(TMP, "heads.json"), {});
  const expect = heads[i] || null;
  const finalDir = shardDir(i), partDir = finalDir + ".part";
  rmSync(partDir, { recursive: true, force: true });
  mkdirSync(partDir, { recursive: true });
  const out = new BucketWriter(partDir);
  const t0 = Date.now();
  const st = {
    shard: i, url: shardUrl(i), lines: 0, raw_bytes: 0, gz_bytes: 0, md5: null,
    pos_tagged_lines: 0, underscore_untagged_lines: 0, malformed_lines: 0, malformed_examples: [],
    untagged_lines: 0, untagged_match_in_range: 0, untagged_match_all_years: 0,
    rejected_lines: 0, rejected_match_in_range: 0, rejected_examples: [],
    kept_lines: 0, kept_match_in_range: 0, kept_lines_no_in_range_years: 0, kept_noncontiguous_lines: 0,
    folded_lines: 0, min_line_total_all_years: Infinity, max_year_seen: 0, min_year_seen: 99999,
    truncated_test_slice: false,
  };

  const curl = spawn("curl", ["-sS", "-L", "--fail", "-A", USER_AGENT, st.url], { stdio: ["ignore", "pipe", "pipe"] });
  const gz = spawn("gzip", ["-dc"], { stdio: ["pipe", "pipe", "pipe"] });
  let curlErr = "", gzErr = "";
  curl.stderr.on("data", (d) => (curlErr += d));
  gz.stderr.on("data", (d) => (gzErr += d));
  const md5 = createHash("md5");
  curl.stdout.on("data", (c) => { md5.update(c); st.gz_bytes += c.length; });
  curl.stdout.pipe(gz.stdin);
  gz.stdin.on("error", () => {}); // EPIPE when a test slice stops early
  const curlDone = new Promise((r) => curl.on("close", (code, sig) => r(code ?? sig)));
  const gzDone = new Promise((r) => gz.on("close", (code, sig) => r(code ?? sig)));

  const handle = (buf, s, e) => {
    st.lines++;
    st.raw_bytes += e - s + 1;
    let t = s, underscore = false, ascii = true;
    for (; t < e; t++) {
      const c = buf[t];
      if (c === 9) break;
      if (c === 95) underscore = true;
      else if (c >= 128) ascii = false;
    }
    if (t >= e) return malformed(buf, s, e, "no tab");
    const token = buf.toString(ascii ? "latin1" : "utf8", s, t);
    if (underscore && isPosTagged(token)) { st.pos_tagged_lines++; return; }
    // parse "year,match,volumes" entries
    let p = t + 1, inTot = 0, allTot = 0, firstIn = -1, lastInEnd = -1, outAfterIn = false, contiguous = true;
    while (p < e) {
      const entStart = p;
      let y = 0, c = 0, v = 0, d = 0, k;
      while (p < e && (k = buf[p]) !== 44) { if (k < 48 || k > 57) return malformed(buf, s, e, "year"); y = y * 10 + k - 48; p++; d++; }
      if (p >= e || d === 0) return malformed(buf, s, e, "year field");
      p++; d = 0;
      while (p < e && (k = buf[p]) !== 44) { if (k < 48 || k > 57) return malformed(buf, s, e, "match"); c = c * 10 + k - 48; p++; d++; }
      if (p >= e || d === 0) return malformed(buf, s, e, "match field");
      p++; d = 0;
      while (p < e && (k = buf[p]) !== 9) { if (k < 48 || k > 57) return malformed(buf, s, e, "volume"); v = v * 10 + k - 48; p++; d++; }
      if (d === 0) return malformed(buf, s, e, "volume field");
      const entEnd = p;
      p++;
      allTot += c;
      if (y > st.max_year_seen) st.max_year_seen = y;
      if (y < st.min_year_seen) st.min_year_seen = y;
      if (y >= Y0 && y <= Y1) {
        inTot += c;
        if (firstIn < 0) firstIn = entStart; else if (outAfterIn) contiguous = false;
        lastInEnd = entEnd;
      } else if (firstIn >= 0) outAfterIn = true;
    }
    if (underscore) st.underscore_untagged_lines++;
    st.untagged_lines++;
    st.untagged_match_in_range += inTot;
    st.untagged_match_all_years += allTot;
    if (allTot < st.min_line_total_all_years) st.min_line_total_all_years = allTot;
    const folded = fold(token);
    if (!keepToken(folded)) {
      st.rejected_lines++;
      st.rejected_match_in_range += inTot;
      if (st.rejected_examples.length < 25 && inTot > 1e6) st.rejected_examples.push([token, inTot]);
      return;
    }
    if (inTot === 0) { st.kept_lines_no_in_range_years++; return; }
    st.kept_lines++;
    st.kept_match_in_range += inTot;
    if (folded !== token) st.folded_lines++;
    const b = fnv1a(folded) % NBUCKETS;
    const head = `${folded}\t${token}\t${inTot}\t`;
    if (contiguous) out.put(b, head, buf, firstIn, lastInEnd);
    else {
      // rebuild the in-range entries (years outside 1500–2019 interleaved — not expected, counted)
      st.kept_noncontiguous_lines++;
      const parts = buf.toString("latin1", t + 1, e).split("\t").filter((x) => {
        const y = Number(x.slice(0, x.indexOf(",")));
        return y >= Y0 && y <= Y1;
      });
      out.put(b, head + parts.join("\t"), buf, 0, 0);
    }
  };
  function malformed(buf, s, e, why) {
    st.malformed_lines++;
    if (st.malformed_examples.length < 10) st.malformed_examples.push(`${why}: ${buf.toString("utf8", s, Math.min(e, s + 120))}`);
  }

  let rest = null, nextLog = 1_000_000;
  for await (let chunk of gz.stdout) {
    if (rest) { chunk = Buffer.concat([rest, chunk]); rest = null; }
    let s = 0;
    for (;;) {
      const nl = chunk.indexOf(10, s);
      if (nl < 0) break;
      if (nl > s) handle(chunk, s, nl);
      s = nl + 1;
    }
    if (s < chunk.length) rest = Buffer.from(chunk.subarray(s));
    if (st.lines >= nextLog) { log(`  shard ${pad2(i)}: ${(st.lines / 1e6).toFixed(0)}M lines, ${mb(st.gz_bytes)} gz streamed`); nextLog += 1_000_000; }
    if (MAX_LINES && st.lines >= MAX_LINES) { st.truncated_test_slice = true; break; }
  }
  if (rest && rest.length && !st.truncated_test_slice) handle(rest, 0, rest.length);
  out.close();

  if (st.truncated_test_slice) { curl.kill(); gz.kill(); }
  const [curlCode, gzCode] = await Promise.all([curlDone, gzDone]);
  st.md5 = md5.digest("base64");
  st.seconds = Math.round((Date.now() - t0) / 1000);
  st.bucket_bytes = out.bytes;
  if (!st.truncated_test_slice) {
    if (curlCode !== 0) throw new Error(`curl exited ${curlCode}: ${curlErr.trim()}`);
    if (gzCode !== 0) throw new Error(`gzip exited ${gzCode}: ${gzErr.trim()}`);
    if (expect && expect.length && st.gz_bytes !== expect.length) throw new Error(`streamed ${st.gz_bytes} bytes, expected ${expect.length}`);
    if (expect && expect.md5 && st.md5 !== expect.md5) throw new Error(`md5 ${st.md5} != published ${expect.md5}`);
    st.md5_verified = !!(expect && expect.md5);
  }
  if (st.min_line_total_all_years === Infinity) st.min_line_total_all_years = null;
  writeJSONAtomic(join(partDir, "stats.json"), st);
  rmSync(finalDir, { recursive: true, force: true });
  renameSync(partDir, finalDir);
  log(`  shard ${pad2(i)} done: ${st.lines.toLocaleString()} lines, kept ${st.kept_lines.toLocaleString()}, ${mb(st.gz_bytes)} gz, md5 ${st.md5_verified ? "ok" : "unchecked"}, ${st.seconds}s`);
}

// ---------------------------------------------------------------------------------------------
// merge (child): one bucket from every shard → candidate rows
function mergeBucket(b) {
  const seeds = new Set(seedWords());
  const files = SHARDS.map((i) => bucketFile(i, b)).filter((f) => existsSync(f));
  const bufs = files.map((f) => readFileSync(f));
  const totals = new Map(), forms = new Map();
  // pass A: totals per folded type
  for (const buf of bufs) {
    eachLine(buf, (s, e) => {
      const t1 = buf.indexOf(9, s), t2 = buf.indexOf(9, t1 + 1), t3 = buf.indexOf(9, t2 + 1);
      const word = buf.toString("utf8", s, t1);
      const total = Number(buf.toString("latin1", t2 + 1, t3 < 0 || t3 > e ? e : t3));
      totals.set(word, (totals.get(word) || 0) + total);
      forms.set(word, (forms.get(word) || 0) + 1);
    });
  }
  // pass B: dense yearly arrays for candidates
  const acc = new Map();
  for (const [word, total] of totals) if (total >= FLOOR || seeds.has(word)) acc.set(word, { a: new Float64Array(2 * NY), top: "", topTotal: -1 });
  for (const buf of bufs) {
    eachLine(buf, (s, e) => {
      const t1 = buf.indexOf(9, s);
      const word = buf.toString("utf8", s, t1);
      const slot = acc.get(word);
      if (!slot) return;
      const t2 = buf.indexOf(9, t1 + 1), t3 = buf.indexOf(9, t2 + 1);
      const lineTotal = Number(buf.toString("latin1", t2 + 1, t3));
      if (lineTotal > slot.topTotal) { slot.topTotal = lineTotal; slot.top = buf.toString("utf8", t1 + 1, t2); }
      const a = slot.a;
      let p = t3 + 1;
      while (p < e) {
        let y = 0, c = 0, v = 0, k;
        while ((k = buf[p]) !== 44) { y = y * 10 + k - 48; p++; }
        p++;
        while ((k = buf[p]) !== 44) { c = c * 10 + k - 48; p++; }
        p++;
        while (p < e && (k = buf[p]) !== 9) { v = v * 10 + k - 48; p++; }
        p++;
        const yi = y - Y0;
        a[yi] += c;
        if (v > a[NY + yi]) a[NY + yi] = v;
      }
    });
  }
  // encode rows
  const lines = [], overflow = [], mismatch = [];
  const cbuf = Buffer.alloc(NY * 4), vbuf = Buffer.alloc(NY * 4);
  for (const [word, slot] of acc) {
    const a = slot.a;
    let first = 0, last = 0, sum = 0;
    for (let yi = 0; yi < NY; yi++) {
      const c = a[yi], v = a[NY + yi];
      if (c > UINT32_MAX || v > UINT32_MAX) { overflow.push([word, Y0 + yi, c, v]); }
      cbuf.writeUInt32LE(Math.min(c, UINT32_MAX), yi * 4);
      vbuf.writeUInt32LE(Math.min(v, UINT32_MAX), yi * 4);
      if (c > 0) { if (!first) first = Y0 + yi; last = Y0 + yi; }
      sum += c;
    }
    const total = totals.get(word);
    if (sum !== total) mismatch.push([word, sum, total]);
    const cz = deflateRawSync(cbuf), vz = deflateRawSync(vbuf);
    lines.push([word, total, first, last, forms.get(word), slot.top, cz.toString("base64"), vz.toString("base64"),
      cz.length + vz.length + Buffer.byteLength(word) + Buffer.byteLength(slot.top)].join("\t"));
  }
  // histogram of all folded types in this bucket by order of magnitude of their 1500–2019 total
  const hist = {};
  for (const total of totals.values()) {
    const k = total < 1 ? "0" : String(Math.floor(Math.log10(total)));
    const h = (hist[k] ||= { types: 0, matches: 0 });
    h.types++; h.matches += total;
  }
  const seedTotals = {};
  for (const w of seeds) if (totals.has(w)) seedTotals[w] = totals.get(w);
  mkdirSync(mergeDir, { recursive: true });
  const rowsPath = join(mergeDir, `b${pad2(b)}.rows.tsv`);
  writeFileSync(rowsPath + ".part", lines.join("\n") + (lines.length ? "\n" : ""));
  renameSync(rowsPath + ".part", rowsPath);
  writeJSONAtomic(join(mergeDir, `b${pad2(b)}.done.json`), {
    bucket: b, floor: FLOOR, shards: SHARDS, files: files.length, types: totals.size,
    source_lines: [...forms.values()].reduce((x, y) => x + y, 0), candidates: lines.length,
    hist, seed_totals: seedTotals, overflow, sum_mismatch: mismatch,
  });
  log(`  bucket ${pad2(b)}: ${totals.size.toLocaleString()} types, ${lines.length.toLocaleString()} candidates`);
}

// ---------------------------------------------------------------------------------------------
// parent orchestration
function runChild(childArgs) {
  return new Promise((resolve) => {
    const extra = [];
    if (TEST) extra.push("--test");
    if (MAX_LINES) extra.push("--max-lines", String(MAX_LINES));
    if (opt("--shards", null)) extra.push("--shards", opt("--shards"));
    const child = spawn(process.execPath, [SCRIPT, ...childArgs, ...extra], { stdio: ["ignore", "inherit", "inherit"] });
    child.on("close", (code) => resolve(code));
  });
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function headInfo(url) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch(url, { method: "HEAD", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
      if (r.ok) {
        const hash = r.headers.get("x-goog-hash") || "";
        return {
          length: Number(r.headers.get("content-length")) || null,
          md5: (hash.match(/md5=([^,\s]+)/) || [])[1] || null,
          crc32c: (hash.match(/crc32c=([^,\s]+)/) || [])[1] || null,
          last_modified: r.headers.get("last-modified"),
          etag: r.headers.get("etag"),
        };
      }
      log(`  HEAD ${r.status} ${url}`);
    } catch (error) {
      log(`  HEAD retry ${attempt}: ${error.message}`);
    }
    await sleep(2000 * attempt);
  }
  return null;
}

function parseTotals(text) {
  const rows = [];
  for (const tuple of text.split(/\s+/).filter(Boolean)) {
    const [year, match, pages, volumes] = tuple.split(",").map(Number);
    if ([year, match, pages, volumes].some((x) => !Number.isFinite(x))) throw new Error(`bad totals tuple ${tuple}`);
    rows.push({ year, match, pages, volumes });
  }
  return rows;
}

function decodeU32(blob) {
  const buf = inflateRawSync(blob);
  if (buf.length !== NY * 4) throw new Error(`blob decodes to ${buf.length} bytes, expected ${NY * 4}`);
  const out = new Uint32Array(NY);
  for (let i = 0; i < NY; i++) out[i] = buf.readUInt32LE(i * 4);
  return out;
}

function perDecadePerMillion(counts, totalsByYear) {
  const out = {};
  for (let d = Y0; d <= Y1; d += 10) {
    let c = 0, t = 0;
    for (let y = d; y < d + 10 && y <= Y1; y++) { c += counts[y - Y0]; t += totalsByYear.get(y) || 0; }
    out[`${d}s`] = t > 0 ? Number(((c / t) * 1e6).toFixed(4)) : null;
  }
  return out;
}

function buildDb(path, rows, totalsRows, meta) {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA page_size = 16384;
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    CREATE TABLE ngram (
      word TEXT PRIMARY KEY,
      total INTEGER NOT NULL,
      first_year INTEGER NOT NULL,
      last_year INTEGER NOT NULL,
      counts BLOB NOT NULL,
      volumes BLOB NOT NULL,
      forms INTEGER NOT NULL,
      top_form TEXT NOT NULL
    );
    CREATE TABLE totals (year INTEGER PRIMARY KEY, match_count INTEGER NOT NULL, page_count INTEGER NOT NULL, volume_count INTEGER NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const ins = db.prepare("INSERT INTO ngram (word, total, first_year, last_year, counts, volumes, forms, top_form) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  for (const r of rows) {
    ins.run(r.word, BigInt(r.total), BigInt(r.first), BigInt(r.last), Buffer.from(r.cz, "base64"), Buffer.from(r.vz, "base64"), BigInt(r.forms), r.top);
  }
  const insT = db.prepare("INSERT INTO totals (year, match_count, page_count, volume_count) VALUES (?, ?, ?, ?)");
  for (const t of totalsRows) insT.run(BigInt(t.year), BigInt(t.match), BigInt(t.pages), BigInt(t.volumes));
  const insM = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(meta)) insM.run(k, typeof v === "string" ? v : JSON.stringify(v));
  db.exec("COMMIT");
  db.close();
  return statSync(path).size;
}

async function main() {
  if (flag("--child-shard")) { await shardPass(Number(opt("--child-shard"))); return; }
  if (flag("--child-bucket")) { mergeBucket(Number(opt("--child-bucket"))); return; }

  mkdirSync(OUT_DIR, { recursive: true });
  const dbPath = join(OUT_DIR, DB_NAME);
  if (existsSync(dbPath) && !flag("--force")) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const done = db.prepare("SELECT value FROM meta WHERE key = 'complete'").get();
    const n = db.prepare("SELECT count(*) AS n FROM ngram").get().n;
    db.close();
    if (done && done.value === "1") { log(`${dbPath} is already complete (${n} types); use --force to rebuild`); console.log("DONE already complete"); return; }
  }
  mkdirSync(TMP, { recursive: true }); // only after the completeness check, so an idempotent re-run leaves no tmp dir behind
  log(`ngram-baseline ${TEST ? "TEST " : ""}shards ${SHARDS.join(",")} → ${OUT_DIR}`);

  // 1. totalcounts + shard heads
  const totalsBody = await fetchCached(TOTALS_URL);
  if (!totalsBody) throw new Error("could not fetch totalcounts-1");
  const totalsRows = parseTotals(totalsBody.toString("utf8"));
  const totalsByYear = new Map(totalsRows.map((t) => [t.year, t.match]));
  const headsPath = join(TMP, "heads.json");
  const heads = readJSON(headsPath, {});
  for (const i of SHARDS) if (!heads[i]) heads[i] = await headInfo(shardUrl(i));
  writeJSONAtomic(headsPath, heads);
  log(`totalcounts: ${totalsRows.length} years; shards to stream: ${mb(SHARDS.reduce((s, i) => s + (heads[i]?.length || 0), 0))}`);

  // 2. pass 1 — biggest shards first so the pool drains evenly
  const failures = [];
  const attempts = {};
  const order = [...SHARDS].sort((a, b) => (heads[b]?.length || 0) - (heads[a]?.length || 0));
  await pool(order, MAX_CHILDREN, async (i) => {
    if (existsSync(join(shardDir(i), "stats.json"))) { log(`  shard ${pad2(i)} already done (cached)`); return; }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attempts[i] = attempt;
      log(`  shard ${pad2(i)} start (attempt ${attempt}, ${mb(heads[i]?.length || 0)} gz)`);
      const code = await runChild(["--child-shard", String(i)]);
      if (code === 0 && existsSync(join(shardDir(i), "stats.json"))) return;
      log(`  shard ${pad2(i)} failed with exit ${code}`);
      await sleep(15_000 * attempt);
    }
    failures.push({ stage: "pass1", shard: i, url: shardUrl(i), attempts: MAX_ATTEMPTS });
  });
  if (failures.length) {
    writeJSONAtomic(join(TMP, "failures.json"), failures);
    console.log(`DONE incomplete: ${failures.length} shard(s) failed (${failures.map((f) => f.shard).join(", ")}); re-run to resume`);
    process.exitCode = 1;
    return;
  }
  const shardStats = SHARDS.map((i) => readJSON(join(shardDir(i), "stats.json")));

  // 3. merge buckets
  const buckets = Array.from({ length: NBUCKETS }, (_, b) => b);
  const seeds = seedWords();
  await pool(buckets, MAX_CHILDREN, async (b) => {
    const done = readJSON(join(mergeDir, `b${pad2(b)}.done.json`));
    if (done && done.floor === FLOOR && JSON.stringify(done.shards) === JSON.stringify(SHARDS)) return;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const code = await runChild(["--child-bucket", String(b)]);
      if (code === 0) return;
      log(`  bucket ${pad2(b)} failed with exit ${code}`);
    }
    failures.push({ stage: "merge", bucket: b });
  });
  if (failures.length) {
    console.log(`DONE incomplete: merge failed for bucket(s) ${failures.map((f) => f.bucket).join(", ")}; re-run to resume`);
    process.exitCode = 1;
    return;
  }
  const mergeStats = buckets.map((b) => readJSON(join(mergeDir, `b${pad2(b)}.done.json`)));
  const overflow = mergeStats.flatMap((m) => m.overflow);
  const sumMismatch = mergeStats.flatMap((m) => m.sum_mismatch);
  if (overflow.length) log(`  WARNING: ${overflow.length} yearly values exceed uint32 and were clamped`, overflow.slice(0, 5));
  if (sumMismatch.length) throw new Error(`yearly sums disagree with totals for ${sumMismatch.length} types, e.g. ${JSON.stringify(sumMismatch.slice(0, 3))}`);

  // 4. threshold: scan candidate rows (total, estimated bytes) without holding them all
  const seedSet = new Set(seeds);
  const cand = []; // [total, bytes, isSeed]
  for (const b of buckets) {
    const text = readFileSync(join(mergeDir, `b${pad2(b)}.rows.tsv`), "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      const f = line.split("\t");
      cand.push([Number(f[1]), Number(f[8]) + 48, seedSet.has(f[0])]);
    }
  }
  const estimate = (t) => cand.reduce((s, [total, bytes, seed]) => s + (total >= t || seed ? bytes : 0), 0) * 1.08;
  const typesAt = (t) => cand.reduce((s, [total]) => s + (total >= t ? 1 : 0), 0);
  const ladderTable = LADDER.map((t) => ({ threshold: t, types: typesAt(t), estimated_bytes: Math.round(estimate(t)) }));
  log("  ladder:", ladderTable.map((r) => `≥${r.threshold}: ${r.types} types ≈ ${mb(r.estimated_bytes)}`).join(" | "));
  let rule;
  let li;
  if (opt("--threshold", null)) {
    li = -1;
    rule = "set by --threshold";
  } else {
    li = LADDER.findIndex((t) => estimate(t) <= TARGET_MAX);
    if (li < 0) li = LADDER.length - 1;
    rule = `smallest step of the 1-2-5 ladder ${LADDER[0]}…${LADDER.at(-1)} whose estimated store ≤ ${TARGET_MAX / 1e6} MB (then stepped if the built file falls outside ${BAND[0] / 1e6}–${BAND[1] / 1e6} MB)`;
  }

  // 5. build (and, under the automatic rule, step the ladder if the file lands outside the band)
  const tmpDb = join(OUT_DIR, DB_NAME + ".part");
  let threshold, size, kept, seedOnly, seedMissing;
  const seedPresent = Object.assign({}, ...mergeStats.map((m) => m.seed_totals));
  const allTypes = mergeStats.reduce((s, m) => s + m.types, 0);
  const builtAt = new Date().toISOString();
  const shardTotals = (k) => shardStats.reduce((s, st) => s + st[k], 0);
  const tried = new Set();
  let belowExamples = [];
  if (li < 0 && !(Number(opt("--threshold")) >= FLOOR)) throw new Error(`--threshold must be a number ≥ ${FLOOR} (rows below FLOOR are not materialised)`);
  for (let guard = 0; guard < 6; guard++) {
    threshold = li >= 0 ? LADDER[li] : Number(opt("--threshold"));
    const rows = [];
    const below = []; // evidence for the manifest: what sits just under the threshold
    belowExamples = below;
    for (const b of buckets) {
      const text = readFileSync(join(mergeDir, `b${pad2(b)}.rows.tsv`), "utf8");
      for (const line of text.split("\n")) {
        if (!line) continue;
        const f = line.split("\t");
        const total = Number(f[1]);
        if (total >= threshold || seedSet.has(f[0])) {
          rows.push({ word: f[0], total, first: Number(f[2]), last: Number(f[3]), forms: Number(f[4]), top: f[5], cz: f[6], vz: f[7] });
        } else if (total >= threshold * 0.8 && fnv1a(f[0]) % 997 === 0) below.push([f[0], total]);
      }
    }
    rows.sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
    kept = rows.length;
    seedOnly = rows.filter((r) => r.total < threshold).map((r) => [r.word, r.total]);
    seedMissing = seeds.filter((w) => !(w in seedPresent));
    const meta = {
      schema_version: "1",
      complete: "0",
      source: "Google Books Ngram Viewer dataset, version 3 (20200217), English (eng) 1-grams",
      source_urls: { shards: SHARDS.map(shardUrl), totals: TOTALS_URL },
      license: "CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/)",
      attribution: "Google Books Ngram Viewer (http://books.google.com/ngrams), dataset version 20200217. Michel et al. 2011, Science 331:176–182; Lin et al. 2012, ACL System Demonstrations.",
      year_min: String(Y0), year_max: String(Y1), n_years: String(NY),
      counts_encoding: `zlib deflateRaw (no header) of a little-endian Uint32Array of ${NY} values; index i = year ${Y0}+i; value = match_count summed over every source token that folds to this word`,
      volumes_encoding: `same encoding; value = MAX over the folded source tokens of their volume_count for that year (a lower bound on the number of distinct volumes containing any variant; the true count is ≤ the sum over variants, which is not stored)`,
      date_basis: "stated",
      date_precision: "year",
      date_meaning: "publication year that Google Books metadata assigns to each scanned volume (not a coinage or attestation date; misdated volumes exist)",
      normalization: "token → Unicode NFC → String.prototype.toLowerCase() (locale-independent) → NFC; ASCII tokens are only lowercased",
      token_filter: `${TOKEN_RE.source} (flag u) and 1–40 code points; tokens containing "_" whose suffix is a POS tag (${[...POS_TAGS].join(" ")}) or bare tag tokens like _NOUN_/_START_ are POS-tagged duplicates and are skipped; other tokens containing "_" fail the letter filter`,
      threshold: String(threshold),
      threshold_rule: rule,
      threshold_ladder: ladderTable,
      types_kept: String(kept),
      types_kept_by_threshold: String(kept - seedOnly.length),
      types_kept_by_seed_only: seedOnly,
      folded_types_seen: String(allTypes),
      seed_words: seeds,
      seed_words_missing: seedMissing,
      verify_words: VERIFY_WORDS,
      built_at: builtAt,
      script: "tools/fetch/ngram-baseline.mjs",
      corpus_note: "The 2020 (v3) corpus is a different, larger scan set with different tokenisation and metadata than the 2012 (v2) and 2009 (v1) corpora; values are not comparable across versions. Google Books is a library-scan corpus whose composition changes over time (e.g. the share of scientific/technical literature grows in the 20th century); it is NOT a balanced sample of English and is a different corpus from Scrolls' local sources.",
      test_slice: TEST ? "1" : "0",
    };
    size = buildDb(tmpDb, rows, totalsRows, meta);
    log(`  built ${DB_NAME} at threshold ${threshold}: ${kept} types, ${mb(size)}`);
    if (li < 0 || TEST) break;
    tried.add(li);
    const k = size / estimate(threshold); // measured file size / estimate, used to predict a neighbouring step
    if (size > BAND[1] && li < LADDER.length - 1 && !tried.has(li + 1)) { li++; continue; }
    if (size < BAND[0] && li > 0 && !tried.has(li - 1) && estimate(LADDER[li - 1]) * k <= BAND[1]) { li--; continue; }
    break;
  }

  // 6. verify: every row decodes to its total; shape checks on a few words
  const db = new DatabaseSync(tmpDb);
  const integrity = db.prepare("PRAGMA integrity_check").get();
  let decoded = 0, decodeErrors = [];
  for (const r of db.prepare("SELECT word, total, counts, volumes, first_year, last_year FROM ngram").iterate()) {
    const c = decodeU32(r.counts);
    const v = decodeU32(r.volumes);
    let sum = 0, first = 0, last = 0;
    for (let i = 0; i < NY; i++) { sum += c[i]; if (c[i] > 0) { if (!first) first = Y0 + i; last = Y0 + i; } }
    if (sum !== Number(r.total) || first !== Number(r.first_year) || last !== Number(r.last_year)) {
      if (decodeErrors.length < 10) decodeErrors.push([r.word, sum, Number(r.total)]);
    }
    for (let i = 0; i < NY; i++) if (v[i] > 0 && c[i] === 0) { if (decodeErrors.length < 10) decodeErrors.push([r.word, "volume>0 with count 0", Y0 + i]); break; }
    decoded++;
  }
  const types = db.prepare("SELECT typeof(total) AS t, typeof(first_year) AS f, typeof(counts) AS c FROM ngram LIMIT 1").get();
  const verification = {};
  for (const w of VERIFY_WORDS) {
    const r = db.prepare("SELECT * FROM ngram WHERE word = ?").get(w);
    if (!r) { verification[w] = null; continue; }
    const c = decodeU32(r.counts);
    verification[w] = { total: Number(r.total), first_year: Number(r.first_year), top_form: r.top_form, forms: Number(r.forms), per_million_by_decade: perDecadePerMillion(c, totalsByYear) };
  }
  const dec = (w, d) => verification[w]?.per_million_by_decade?.[d] ?? null;
  const ratio = (a, b) => (a !== null && b ? Number((a / b).toFixed(2)) : a ? Infinity : null);
  const checks = [
    { check: "telegraph rises from the 1840s (1850s vs 1820s per-million ratio > 3)", value: ratio(dec("telegraph", "1850s"), dec("telegraph", "1820s")) },
    { check: "computer surges after 1945 (1960s vs 1930s ratio > 5)", value: ratio(dec("computer", "1960s"), dec("computer", "1930s")) },
    { check: "hacker after 1975 (1990s vs 1960s ratio > 3)", value: ratio(dec("hacker", "1990s"), dec("hacker", "1960s")) },
    { check: "internet after 1990 (2000s vs 1980s ratio > 10)", value: ratio(dec("internet", "2000s"), dec("internet", "1980s")) },
  ].map((c, k) => ({ ...c, pass: c.value !== null && c.value > [3, 5, 3, 10][k] }));
  const observations = observe(db);
  const upd = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  upd.run("verification", JSON.stringify({ decoded_rows: decoded, decode_errors: decodeErrors, integrity: integrity.integrity_check, shapes: checks }));
  upd.run("complete", decodeErrors.length === 0 && integrity.integrity_check === "ok" ? "1" : "0");
  db.close();
  if (decodeErrors.length || integrity.integrity_check !== "ok") throw new Error(`verification failed: ${JSON.stringify({ decodeErrors, integrity })}`);
  renameSync(tmpDb, dbPath);
  size = statSync(dbPath).size;
  for (const w of VERIFY_WORDS) {
    const v = verification[w];
    if (!v) { log(`  verify ${w}: not present`); continue; }
    const pm = v.per_million_by_decade;
    log(`  verify ${w} (total ${v.total}, first ${v.first_year}, top form "${v.top_form}", ${v.forms} forms):`,
      Object.entries(pm).filter(([d]) => Number(d.slice(0, 4)) >= 1700).map(([d, x]) => `${d.slice(0, 4)} ${x}`).join("  "));
  }
  for (const c of checks) log(`  check ${c.pass ? "PASS" : "FAIL"}: ${c.check} → ${c.value}`);

  // 7. manifest
  const totalsInRange = totalsRows.filter((t) => t.year >= Y0 && t.year <= Y1).reduce((s, t) => s + t.match, 0);
  const gzBytes = shardTotals("gz_bytes");
  const hist = {};
  for (const m of mergeStats) for (const [k, h] of Object.entries(m.hist)) {
    const x = (hist[k] ||= { types: 0, matches: 0 });
    x.types += h.types; x.matches += h.matches;
  }
  const db2 = new DatabaseSync(dbPath, { readOnly: true });
  const keptMatches = Number(db2.prepare("SELECT sum(total) AS s FROM ngram").get().s);
  db2.close();
  const manifest = {
    source: "Google Books Ngram Viewer dataset v3 (20200217), English (eng) 1-grams",
    urls: { shards: SHARDS.map(shardUrl), totals: TOTALS_URL, about: "https://storage.googleapis.com/books/ngrams/books/datasetsv3.html" },
    license: "CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/)",
    attribution: "Google Books Ngram Viewer (http://books.google.com/ngrams), dataset version 20200217. Jean-Baptiste Michel et al., 'Quantitative Analysis of Culture Using Millions of Digitized Books', Science 331 (2011) 176–182; Yuri Lin et al., 'Syntactic Annotations for the Google Books Ngram Corpus', ACL 2012 System Demonstrations.",
    script: "tools/fetch/ngram-baseline.mjs",
    test_slice: TEST,
    method: [
      "GET totalcounts-1 (via lib.mjs fetchCached) and HEAD each shard for content-length + Google's published md5 (x-goog-hash).",
      `Pass 1: each of the ${SHARDS.length} shards streamed with curl | gzip -dc (never stored), ≤ ${MAX_CHILDREN} child processes at once; streamed bytes md5-checked against the published md5 and length.`,
      "POS-tagged duplicate lines (token ends in _NOUN/_VERB/_ADJ/_ADV/_PRON/_DET/_ADP/_NUM/_CONJ/_PRT/_X/_. or is a bare tag like _NOUN_, _START_, _END_) skipped.",
      "Remaining tokens folded: NFC → lowercase → NFC. Kept only if letters (any script, combining marks allowed) with optional single internal apostrophes (') or hyphens (-), 1–40 code points. Digits, periods, other punctuation, underscores → rejected.",
      `Years outside ${Y0}–${Y1} dropped; lines with no in-range year dropped. Surviving lines hashed (FNV-1a of the folded word) into ${NBUCKETS} buckets on local disk.`,
      "Merge per bucket: all source tokens folding to the same word (case variants live in different shards) aggregated: match_count summed per year, volume_count max-ed per year (lower bound).",
      `Every folded type with total ≥ ${FLOOR} or in the seed list encoded as a candidate row; threshold chosen by rule (see selection_criteria); rows written to SQLite sorted by word.`,
      "Verification: PRAGMA integrity_check; every row's counts blob decoded and re-summed to equal `total` and to reproduce first_year/last_year; per-decade per-million shapes printed for sample words.",
    ],
    selection_criteria: {
      threshold_total_match_count_1500_2019: threshold,
      threshold_rule: rule,
      threshold_why: `${thresholdWhy(li, threshold, size, ladderTable, estimate)} It keeps the ${(kept - seedOnly.length).toLocaleString()} most frequent folded types. ${threshold.toLocaleString()} occurrences over ${(totalsInRange / 1e12).toFixed(2)} trillion tokens (1500–2019) ≈ ${((threshold / totalsInRange) * 1e9).toFixed(2)} per billion tokens. See examples_just_below_threshold for what is excluded.`,
      examples_just_below_threshold: belowExamples.slice(0, 60),
      threshold_ladder: ladderTable,
      seed_words: seeds,
      seed_rule: "seed words are kept whenever present at all (any total), even below the threshold",
      years: `${Y0}–${Y1}`,
    },
    counts: {
      shards_streamed: SHARDS.length,
      bytes_streamed_gz: gzBytes,
      bytes_streamed_uncompressed: shardTotals("raw_bytes"),
      source_lines: shardTotals("lines"),
      pos_tagged_lines_skipped: shardTotals("pos_tagged_lines"),
      untagged_lines: shardTotals("untagged_lines"),
      untagged_lines_with_underscore: shardTotals("underscore_untagged_lines"),
      malformed_lines: shardTotals("malformed_lines"),
      rejected_lines_by_token_filter: shardTotals("rejected_lines"),
      kept_lines: shardTotals("kept_lines"),
      kept_lines_changed_by_folding: shardTotals("folded_lines"),
      kept_lines_without_in_range_years: shardTotals("kept_lines_no_in_range_years"),
      folded_types_after_filter: allTypes,
      folded_types_by_order_of_magnitude_of_total: hist,
      types_kept: kept,
      types_kept_by_threshold: kept - seedOnly.length,
      seed_words_kept_below_threshold: seedOnly,
      seed_words_missing: seedMissing,
      db_bytes: size,
    },
    coverage: {
      totalcounts_match_1500_2019: totalsInRange,
      untagged_match_1500_2019: shardTotals("untagged_match_in_range"),
      untagged_vs_totalcounts_ratio: Number((shardTotals("untagged_match_in_range") / totalsInRange).toFixed(6)),
      letter_token_match_1500_2019: shardTotals("kept_match_in_range"),
      letter_token_share_of_untagged: Number((shardTotals("kept_match_in_range") / shardTotals("untagged_match_in_range")).toFixed(6)),
      kept_types_match_1500_2019: keptMatches,
      kept_types_share_of_letter_tokens: Number((keptMatches / shardTotals("kept_match_in_range")).toFixed(6)),
      observed_min_ngram_total_all_years: Math.min(...shardStats.map((s) => s.min_line_total_all_years ?? Infinity)),
      observed_year_span_in_shards: [Math.min(...shardStats.map((s) => s.min_year_seen)), Math.max(...shardStats.map((s) => s.max_year_seen))],
      totals_years_present: [totalsRows[0].year, totalsRows.at(-1).year, totalsRows.length],
      totals_years_missing_1500_2019: Array.from({ length: NY }, (_, k) => Y0 + k).filter((y) => !totalsByYear.has(y)),
    },
    verification: { decoded_rows: decoded, decode_errors: decodeErrors, integrity: integrity.integrity_check, sqlite_types: types, shapes: checks, words: verification },
    observations,
    shards: shardStats.map((s) => ({
      shard: s.shard, url: s.url, gz_bytes: s.gz_bytes, md5: s.md5, md5_verified: s.md5_verified ?? false,
      published: heads[s.shard], attempts: attempts[s.shard] || "cached", lines: s.lines, kept_lines: s.kept_lines, seconds: s.seconds,
      malformed_examples: s.malformed_examples, rejected_high_frequency_examples: s.rejected_examples,
    })),
    caveats: buildCaveats({ threshold, observations, overflowCount: overflow.length, verification }),
    failures: [...failures, ...overflow.map((o) => ({ stage: "encode", clamped_uint32: o }))],
  };
  if (!TEST) writeManifest(OUT_DIR, manifest);
  else writeJSONAtomic(join(OUT_DIR, "MANIFEST.test.json"), { fetched_at: new Date().toISOString(), ...manifest });

  // 8. cleanup
  if (!TEST && !flag("--keep-tmp")) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
    log(`  removed ${TMP_ROOT}`);
  }
  console.log(`DONE ngram-baseline: ${kept} types (threshold ${threshold}, ${seedOnly.length} seed-only, ${seedMissing.length} seed missing), ${mb(size)}, streamed ${mb(gzBytes)} gz`);
}

/** Why this threshold, stated exactly: the rule works on ESTIMATED sizes, so say what the next step down was estimated at. */
export function thresholdWhy(li, threshold, size, ladderTable, estimate) {
  if (li < 0) return `Set explicitly with --threshold ${threshold}; the built file is ${mb(size)}.`;
  const lower = li > 0 ? ladderTable[li - 1] : null;
  let s = `The brief asked for a store of roughly 100–300 MB. Under threshold_rule this step's estimated store is ${mb(estimate(threshold))} and the built file is ${mb(size)}.`;
  if (lower) {
    s += ` The next step down (${lower.threshold.toLocaleString()}) was estimated at ${mb(lower.estimated_bytes)}`;
    s += lower.estimated_bytes > TARGET_MAX ? `, over the ${TARGET_MAX / 1e6} MB target (a margin under the 300 MB ceiling), so it was not built.` : ".";
  }
  return s;
}

/** The caveats written into MANIFEST.json; computed from the finished store so they stay truthful on a re-run. */
export function buildCaveats({ threshold, observations, overflowCount, verification }) {
  const pm = (w, d) => verification?.[w]?.per_million_by_decade?.[d];
  const early = [["computer", "1710s"], ["dna", "1710s"], ["internet", "1780s"]]
    .filter(([w, d]) => pm(w, d) > 0).map(([w, d]) => `'${w}' ${pm(w, d)} per million in the ${d}`);
  return [
    "Different corpus: Google Books is a library-scan corpus, not a balanced sample of English and not the Scrolls local corpus; its composition changes over time (the share of scientific and technical literature grows through the 20th century — Pechenick, Danforth & Dodds 2015, PLOS ONE 10(10): e0137041). Its frequencies are a print baseline, not a measure of speech, rap or any community's usage.",
    "Version: v3 (2020, '20200217') differs from v2 (2012) and v1 (2009) in scans, metadata and tokenisation; do not compare values across versions.",
    "OCR errors, especially before 1800 and in low-volume years; early decades rest on few volumes (see totals.volume_count) and are noisy" + (early.length ? ` — e.g. in this store ${early.join(", ")}, which are artefacts (OCR or misdated volumes), not usage.` : "."),
    `Long s: in pre-1800 printing 'ſ' is frequently OCR'd as 'f', so words containing 's' are undercounted before ~1800 and spurious f-forms exist as their own types (observed totals: ${JSON.stringify(observations.long_s_ocr_pairs)}). Tokens literally containing 'ſ' would be kept as their own types (NFC does not fold ſ to s); kept types containing 'ſ': ${observations.long_s_types}.`,
    `Tokenisation is Google's and evidently splits hyphenated words: only ${observations.hyphenated_types} kept types contain '-' (${JSON.stringify(observations.hyphenated_examples)}), and ${observations.apostrophe_types} contain an apostrophe. 'x-ray' and 'hip-hop' therefore have tiny totals (kept only as seed words); their occurrences presumably appear as separate 1-grams ('x', 'ray'; 'hip', 'hop'), which this store cannot reassemble. Low totals for hyphenated or apostrophised forms are a tokenisation artefact, not evidence of rarity.`,
    "Dates are publication years from Google Books metadata (basis: stated by the source; precision: year). Misdated volumes exist, producing anachronisms such as modern words in early years. first_year/last_year are the first/last years with a nonzero count in this dataset, NOT coinage or attestation dates.",
    `first_year is left-censored at ${Y0}: ${observations.first_year_at_window_start} kept types have first_year = ${Y0}, meaning 'present from the start of the window', not 'first printed in ${Y0}'.`,
    "Case folding merges proper nouns, sentence-initial capitals and common words (e.g. 'Hacker' the surname with 'hacker'; 'Bill' with 'bill'); top_form and forms show the dominant original spelling and how many source tokens were merged.",
    "Homographs and cross-language tokens share one curve: e.g. 'rap' (a knock, since Middle English) and the music genre; 'meme' has counts throughout the 1800s, long before Dawkins' 1976 coinage (OCR'd French 'même', names or noise — the source cannot say which). A curve is the sum of every sense, language and error sharing the spelling.",
    "Abbreviations containing periods ('Mr.', 'Mrs.', 'No.', 'e.g.') fail the token filter by design; the period-less forms ('mr', 'mrs') are separate tokens and are kept where frequent.",
    "Volumes per word-year are the MAX over the merged case variants (lower bound on distinct volumes); a per-word volume series is therefore not directly comparable to totals.volume_count.",
    "Per-million values must be computed against totals.match_count, which counts all 1-gram tokens (including punctuation and numbers) — the Ngram Viewer convention.",
    `Types with a ${Y0}–${Y1} total below ${threshold.toLocaleString()} are absent (except seed words); absence from the table is not evidence that a word was never printed.`,
    "Uint32 storage: " + (overflowCount ? `${overflowCount} yearly values exceeded 4,294,967,295 and were clamped (listed in failures).` : `no yearly value exceeded 4,294,967,295 (none clamped; largest ${JSON.stringify(observations.max_yearly_count)}).`),
  ];
}

/** Facts about the finished store that the caveats cite (computed, so a re-run stays truthful). */
export function observe(db) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const totalOf = (w) => { const r = one("SELECT total FROM ngram WHERE word = ?", w); return r ? Number(r.total) : null; };
  let maxValue = 0, maxAt = null;
  for (const r of db.prepare("SELECT word, counts FROM ngram").iterate()) {
    const c = decodeU32(r.counts);
    for (let i = 0; i < NY; i++) if (c[i] > maxValue) { maxValue = c[i]; maxAt = { word: r.word, year: Y0 + i }; }
  }
  return {
    first_year_at_window_start: Number(one("SELECT count(*) AS n FROM ngram WHERE first_year = ?", Y0).n),
    last_year_before_window_end: Number(one("SELECT count(*) AS n FROM ngram WHERE last_year < ?", Y1).n),
    hyphenated_types: Number(one("SELECT count(*) AS n FROM ngram WHERE word LIKE '%-%'").n),
    hyphenated_examples: db.prepare("SELECT word, total FROM ngram WHERE word LIKE '%-%' ORDER BY total DESC LIMIT 10").all().map((r) => [r.word, Number(r.total)]),
    apostrophe_types: Number(one("SELECT count(*) AS n FROM ngram WHERE word LIKE '%''%'").n),
    apostrophe_examples: db.prepare("SELECT word, total FROM ngram WHERE word LIKE '%''%' ORDER BY total DESC LIMIT 10").all().map((r) => [r.word, Number(r.total)]),
    long_s_types: Number(one("SELECT count(*) AS n FROM ngram WHERE word LIKE '%ſ%'").n),
    long_s_ocr_pairs: Object.fromEntries(["such", "fuch", "best", "beft", "first", "firft"].map((w) => [w, totalOf(w)])),
    non_ascii_types: db.prepare("SELECT word FROM ngram").all().filter((r) => /[^\x00-\x7f]/.test(r.word)).length,
    max_yearly_count: { ...maxAt, value: maxValue, uint32_headroom: Number((UINT32_MAX / maxValue).toFixed(2)) },
  };
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    if (!flag("--child-shard") && !flag("--child-bucket")) console.log(`DONE failed: ${error.message}`);
    process.exit(1);
  });
}
