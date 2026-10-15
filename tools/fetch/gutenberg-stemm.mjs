#!/usr/bin/env node
// Scrolls source fetcher: Project Gutenberg STEMM shelf (public-domain science, technology,
// engineering, mathematics and medicine books, plus dated science-periodical issues).
//
//   node tools/fetch/gutenberg-stemm.mjs                 full run (plan + download + write outputs)
//   node tools/fetch/gutenberg-stemm.mjs --plan-only     plan the selection, download nothing
//   node tools/fetch/gutenberg-stemm.mjs --limit 10      download at most 10 new texts this run
//
// Inputs: Gutenberg's own catalogue (pg_catalog.csv, already on disk from the Cipher crawl),
// Cipher's list of 693 already-downloaded literature books, Gutenberg's RDF catalogue streamed
// once from the pglaf.org mirror (download counts, file sizes, MARC 260/906 original-publication
// notes) and Wikidata SPARQL (P2034 -> P577 / P629 -> P577, sitelinks).
// Output: $SCROLLS_DATA/sources/gutenberg-stemm/{catalog.jsonl, texts/<id>.txt,
// cipher-overlap.jsonl, MANIFEST.json, FORMAT.md}. Idempotent and resumable: every network
// result is cached on disk, texts already on disk are never fetched again.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { DATA, USER_AGENT, log, sourceDir, jsonlWriter, writeManifest } from "./lib.mjs";

const SOURCE = "gutenberg-stemm";
const SCRIPT = "tools/fetch/gutenberg-stemm.mjs";
const OUT = sourceDir(SOURCE);
const TEXTS = join(OUT, "texts");
const TMP = join(DATA, "cache", `${SOURCE}-tmp`);
mkdirSync(TEXTS, { recursive: true });
mkdirSync(TMP, { recursive: true });

const CIPHER = "/path/to/developer/Documents/AI Stuff/Cipher/Tools/data/culture";
const CATALOG_CSV = join(CIPHER, "pg_catalog.csv");
const CIPHER_LIST = join(CIPHER, "texts", "gutenberg.json");
const CIPHER_TEXTS = join(CIPHER, "texts", "gutenberg");
const MIRROR = "https://gutenberg.pglaf.org";
const RDF_TARBALL = `${MIRROR}/cache/epub/feeds/rdf-files.tar.bz2`;
const SPARQL = "https://query.wikidata.org/sparql";
const LICENSE = "Public domain in the USA (Project Gutenberg)";
const LANGUAGES = new Set(["en", "fr", "es"]);
const MIRROR_PAUSE_MS = 800; // Cipher's fetch_gutenberg.py pause
const WIKIDATA_PAUSE_MS = 1500;
const BATCH = 300; // ebook IDs per SPARQL query (task limit)
const MIN_BYTES = 30_000; // "long texts"
const MAX_BYTES = 12_000_000; // larger plain-text files are skipped (datasets, not prose)
const BOOK_TARGET = 600; // books (periodical issues come on top)
const FIELD_MIN = 25;
const PERIODICAL_CAP = 120;
const PER_SERIES_CAP = 36; // at most this many issues of one periodical series
const NON_EN_SHARE = 0.13; // cap on fr+es share of books (target en ~ 85-90 %)
const MIN_LETTER_RATIO = 0.5; // letters / non-space chars in the body; below = tables of numbers, not prose

const args = process.argv.slice(2);
const PLAN_ONLY = args.includes("--plan-only");
const LIMIT = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const readJSON = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);
function writeJSONAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".part", JSON.stringify(value));
  renameSync(path + ".part", path);
}

// ───────────────────────────── catalogue ─────────────────────────────

/** RFC-4180 CSV (quoted fields may contain commas, quotes and newlines). */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const splitList = (s) => (s || "").split(/;\s*/).map((x) => x.trim()).filter(Boolean);

/** "Darwin, Charles, 1809-1882 [Editor]" → {name, birth, death, ...}. Never guesses a year. */
function parseAuthor(raw) {
  let s = raw.replace(/[‎‏‪-‮]/g, "").trim();
  let role = null;
  const r = s.match(/\s*\[([^\]]+)\]\s*$/);
  if (r) { role = r[1].trim(); s = s.slice(0, r.index).trim(); }
  const author = { name: s, birth: null, death: null, birth_approx: false, death_approx: false, active: null, role, raw };
  const year = (t) => {
    const m = t.trim().match(/^(\d{1,4})(\?)?\s*(BCE|B\.C\.)?$/);
    if (!m) return null;
    return { y: m[3] ? -Number(m[1]) : Number(m[1]), approx: !!m[2] };
  };
  let m = s.match(/,\s*active\s+([^,]+)$/i);
  if (m) { author.active = m[1].trim(); author.name = s.slice(0, m.index).trim(); return author; }
  m = s.match(/,\s*((?:\d{1,4}\??(?:\s*BCE)?)?)\s*-\s*((?:\d{1,4}\??(?:\s*BCE)?)?)\s*$/);
  if (m && (m[1] || m[2])) {
    const b = m[1] ? year(m[1]) : null, d = m[2] ? year(m[2]) : null;
    // "325? BCE-265? BCE" and "65? BCE-8": a bare second year after a BCE birth is CE.
    if (b) { author.birth = b.y; author.birth_approx = b.approx; }
    if (d) { author.death = d.y; author.death_approx = d.approx; }
    author.name = s.slice(0, m.index).trim();
    return author;
  }
  m = s.match(/,\s*(\d{3,4})\??$/); // a single year with no dash is ambiguous; record nothing but strip it
  if (m) { author.name = s.slice(0, m.index).trim(); author.unparsed_dates = m[0].replace(/^,\s*/, ""); }
  return author;
}

// ───────────────────────────── STEMM classes → field ─────────────────────────────

const COMPUTING_SUBJECTS = /\b(computers?|computer\b|computing machines|electronic data processing|electronic digital computers|microcomputers|internet|world wide web|computer programming|programming languages|computer programs?|software|hackers?|cyberspace|linux|operating systems|ibm \d|pdp-|trs-80|algol|fortran|cobol)/i;

function isStemmClass(l) {
  return /^[QRT]/.test(l) && !/^T[XT]/.test(l);
}

/** One primary field per book. LoCC in pg_catalog.csv carries only the 1-2 letter class
 *  (e.g. "QA", never "QA76"), so QA75-76 cannot be read from it: computing is decided from
 *  Subjects/Bookshelves. Returns {field, field_class, field_rule} or null. */
function fieldOf(locc, subjects, bookshelves) {
  const stemm = locc.filter(isStemmClass);
  if (!stemm.length) return null;
  const computingText = subjects.join("; ") + "; " + bookshelves.filter((b) => !/^Category:/.test(b)).join("; ");
  for (const cls of stemm) {
    const two = cls.slice(0, 2);
    if ((two === "QA" || cls === "T" || two === "TK") && COMPUTING_SUBJECTS.test(computingText))
      return { field: "computing", field_class: cls, field_rule: `${cls} + computing subject` };
  }
  const cls = stemm[0];
  const two = cls.length >= 2 ? cls.slice(0, 2) : cls;
  const map = {
    Q: "general-science", QA: "mathematics", QB: "astronomy", QC: "physics", QD: "chemistry", QE: "earth-sciences",
    QH: "biology", QK: "biology", QL: "biology", QM: "biology", QP: "biology", QR: "biology",
    TP: "chemistry",
  };
  let field = map[two] || map[cls];
  if (!field && cls[0] === "R") field = "medicine";
  if (!field && cls[0] === "T") field = "engineering-technology"; // T, TA-TN, TR, TS (TX/TT excluded, TP above)
  if (!field) return null;
  return { field, field_class: cls, field_rule: `first STEMM LoCC class ${cls}` };
}

const FIELDS = ["mathematics", "computing", "physics", "chemistry", "astronomy", "earth-sciences", "biology", "medicine", "engineering-technology", "general-science"];

// ───────────────────────────── titles, dates ─────────────────────────────

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  janvier: 1, "février": 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, "août": 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, "décembre": 12, decembre: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const pad = (n) => String(n).padStart(2, "0");

/** An exact issue date stated in a periodical title: day or month precision. Never year-only.
 *  The first title line (the issue designation) is read first; subtitle lines only when it has no
 *  date, because they can carry other dates ("Vol. LXX, Dec. 1910 / Address … June 21st, 1910"). */
function titleDate(title) {
  const lines = title.split("\n");
  const first = titleDateIn(lines[0]);
  if (first !== undefined) return first;
  return lines.length > 1 ? titleDateIn(lines.join(" ")) ?? null : null;
}
// A number right after one of these labels is an issue/volume number, not a day ("No. 4 April 1888").
const NUMBER_LABEL = /(?:\b(?:no|nos|num|number|nr|vol|vols|volume|part|pt|tome|tomo|issue|livraison)\.?|#|n[°º]\.?)\s*$/i;
/** Returns a date, null (the text has a date but it is no issue date: a span of several months),
 *  or undefined (no date at all). */
function titleDateIn(text) {
  const t = text.replace(/\s+/g, " ");
  const valid = (y, m, d) => y >= 1600 && y <= 2030 && m >= 1 && m <= 12 && (!d || (d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate()));
  // "November 19, 1887" and also "November 19,1887" (no space after the comma)
  let m = t.match(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*|\\s+)(\\d{4})\\b`, "i"));
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()], d = Number(m[2]), y = Number(m[3]);
    if (valid(y, mo, d)) return { date: `${y}-${pad(mo)}-${pad(d)}`, year: y, precision: "day", raw: m[0] };
  }
  for (const e of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:er|st|nd|rd|th)?\\s+(?:de\\s+)?(${MONTH_RE})\\.?(?:,\\s*|\\s+)(?:de\\s+)?(\\d{4})\\b`, "gi"))) {
    if (NUMBER_LABEL.test(t.slice(0, e.index))) continue;
    const mo = MONTHS[e[2].toLowerCase()], d = Number(e[1]), y = Number(e[3]);
    if (valid(y, mo, d)) return { date: `${y}-${pad(mo)}-${pad(d)}`, year: y, precision: "day", raw: e[0] };
  }
  m = t.match(new RegExp(`\\b(${MONTH_RE})\\.?,?\\s+(?:de\\s+)?(\\d{4})\\b`, "i"));
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()], y = Number(m[2]);
    if (!valid(y, mo)) return undefined;
    // Month spans: "March-April 1916" (a two-month issue: dated as the two-month range
    // "1916-03/1916-04") or "April-October 1850" / "Nov. 1899 to April, 1900" (a volume: no issue date).
    const startOf = t.slice(0, m.index).match(new RegExp(`\\b(${MONTH_RE})\\.?,?\\s*(?:(\\d{4}),?\\s*)?(?:-|–|—|to|&|and|y|et)\\s*$`, "i"));
    if (startOf) {
      const m1 = MONTHS[startOf[1].toLowerCase()], y1 = startOf[2] ? Number(startOf[2]) : y;
      const raw = startOf[0] + m[0];
      if ((y - y1) * 12 + (mo - m1) === 1) {
        return { date: `${y1}-${pad(m1)}/${y}-${pad(mo)}`, year: y1, year_lo: y1, year_hi: y, precision: "month-range", raw, note: `two-month issue "${raw}": dated as the range ${y1}-${pad(m1)}/${y}-${pad(mo)}` };
      }
      return null;
    }
    if (new RegExp(`^,?\\s*(?:-|–|—|to|&|and)\\s*(${MONTH_RE})\\b`, "i").test(t.slice(m.index + m[0].length))) return null;
    return { date: `${y}-${pad(mo)}`, year: y, precision: "month", raw: m[0] };
  }
  return undefined;
}

/** Key for "one edition per work": first title line without volume/part/edition tags, + language + first author surname. */
function plain(text) {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(the|a|an|el|la|los|las|un|una|le|les|l|une|des|du|de) /, "");
}
const PART_RE = /[,.;:(\[\s—–-]*\b(vol(?:ume)?|v|tome|tomo|part|partie|parte|book|livre|libro|no|number)\.?\s*([0-9]+|[ivxlc]+)\b(\s*\(of\s*[0-9ivxlc]+\))?/i;
function workKey(row) {
  const first = row.title.split("\n")[0];
  const partMatch = first.match(PART_RE);
  let base = first;
  if (partMatch) base = first.slice(0, partMatch.index);
  base = base.split(/\s[—–]\s|:|;|\(|\[|, version|, being|, or,/i)[0];
  base = base.replace(/[,.\s]*\b(\d+(st|nd|rd|th|e|me|a|o)|first|second|third|fourth|fifth|sixth|seventh|new|revised|enlarged|nouvelle|nueva)\s+(ed\.|edition|édition|edición)\b.*$/i, "");
  const lead = row.authors.find((a) => !a.role) || row.authors[0];
  const surname = lead ? plain(lead.name.split(",")[0]) : "";
  const words = plain(base).split(" ").filter(Boolean);
  return { key: `${row.language}|${words.join(" ")}|${surname}`, bucket: `${row.language}|${surname}`, words, part: partMatch ? partMatch[2].toLowerCase() : null };
}
/** Same work when the title words are equal, or one is a prefix (≥3 words) of the other. */
function sameWork(a, b) {
  if (a.bucket !== b.bucket) return false;
  const [s, l] = a.words.length <= b.words.length ? [a.words, b.words] : [b.words, a.words];
  if (s.length === l.length) return s.join(" ") === l.join(" ");
  return s.length >= 3 && s.every((w, i) => w === l[i]);
}

/** Wikidata time → {date, year, year_lo, year_hi, precision}. Negative years are BCE. */
function wikidataTime(time, prec) {
  const m = String(time).match(/^([+-]?)(\d{1,})-(\d{2})-(\d{2})T/);
  if (!m) return null;
  const y = (m[1] === "-" ? -1 : 1) * Number(m[2]);
  const p = Number(prec);
  if (p >= 11) return { date: `${y}-${m[3]}-${m[4]}`, year: y, year_lo: y, year_hi: y, precision: "day", wikidata_precision: p };
  if (p === 10) return { date: `${y}-${m[3]}`, year: y, year_lo: y, year_hi: y, precision: "month", wikidata_precision: p };
  if (p === 9) return { date: `${y}`, year: y, year_lo: y, year_hi: y, precision: "year", wikidata_precision: p };
  if (p === 8) { // decade: 1850 → 1850-1859
    const lo = Math.floor(y / 10) * 10;
    return { date: null, year: null, year_lo: lo, year_hi: lo + 9, precision: "range", wikidata_precision: p };
  }
  const span = p === 7 ? 100 : p === 6 ? 1000 : null;
  if (!span || y <= 0) return null;
  // century/millennium, Wikibase convention: ordinal = ceil(year/span), e.g. 1801..1900 = 19th century
  const n = Math.ceil(y / span);
  return { date: null, year: null, year_lo: (n - 1) * span + 1, year_hi: n * span, precision: "range", wikidata_precision: p };
}

/** Task rule: range [birth+20, death or issued year], point = min(birth+40, death). */
function lifetimeEstimate(authors, issuedYear) {
  const author = authors.find((a) => (!a.role || /^author$/i.test(a.role)) && Number.isInteger(a.birth));
  if (!author) return null;
  // Upper bound: death, or the release year when no death is known. The release year also caps a
  // later death (a text cannot appear after Gutenberg released it) — a bound, not a date.
  let hi = Number.isInteger(author.death) ? author.death : issuedYear;
  if (Number.isInteger(hi) && Number.isInteger(issuedYear)) hi = Math.min(hi, issuedYear);
  if (!Number.isInteger(hi)) return null;
  let lo = author.birth + 20;
  if (lo > hi) lo = hi; // died (or was released) before 20: the range collapses onto its upper end
  let point = Number.isInteger(author.death) ? Math.min(author.birth + 40, author.death) : author.birth + 40;
  point = Math.min(Math.max(point, lo), hi);
  return { year: point, year_lo: lo, year_hi: hi, precision: "range", author: author.name };
}

// ───────────────────────────── RDF catalogue (downloads, sizes, MARC) ─────────────────────────────

const RDF_EXTRACT = join(TMP, "rdf-extract.json");

/** Streams rdf-files.tar.bz2 once (curl | tar -xjO) and keeps a compact per-ebook extract. */
async function loadRdf() {
  if (existsSync(RDF_EXTRACT)) {
    const extract = readJSON(RDF_EXTRACT);
    const sample = Object.values(extract)[0];
    if (!sample || "rights" in sample) return extract;
    // An extract made before dcterms:rights was captured: stream once more and merge ONLY the
    // rights statements, so download counts (and therefore the selection) stay as they were.
    log("RDF extract has no rights statements — streaming the catalogue once more to add them");
    const fresh = await streamRdf();
    for (const [id, e] of Object.entries(extract)) e.rights = fresh[id]?.rights ?? null;
    writeJSONAtomic(RDF_EXTRACT, extract);
    return extract;
  }
  const extract = await streamRdf();
  writeJSONAtomic(RDF_EXTRACT, extract);
  return extract;
}

async function streamRdf() {
  log("streaming Gutenberg RDF catalogue from the mirror (~127 MB bz2) …");
  const curl = spawn("curl", ["-sS", "-L", "--fail", "-A", USER_AGENT, RDF_TARBALL], { stdio: ["ignore", "pipe", "inherit"] });
  const tar = spawn("tar", ["-xjOf", "-"], { stdio: ["pipe", "pipe", "inherit"] });
  curl.stdout.pipe(tar.stdin);
  const lines = createInterface({ input: tar.stdout, crlfDelay: Infinity });
  const extract = {};
  let current = null, file = null, field = null, buffer = "", n = 0;
  const decode = (s) => s.replace(/&#13;/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  for await (const line of lines) {
    if (field) { // continuation of a multi-line MARC value
      const end = line.indexOf(`</pgterms:${field}>`);
      buffer += "\n" + (end >= 0 ? line.slice(0, end) : line);
      if (end >= 0) { current[field] = decode(buffer).trim(); field = null; }
      continue;
    }
    let m = line.match(/<pgterms:ebook rdf:about="ebooks\/(\d+)">/);
    if (m) { current = extract[m[1]] = { downloads: null, marc260: null, marc906: null, rights: null, txt: [] }; file = null; if (++n % 10000 === 0) log(`  rdf ${n} ebooks`); continue; }
    if (!current) continue;
    m = line.match(/<pgterms:downloads[^>]*>(\d+)<\/pgterms:downloads>/);
    if (m) { current.downloads = Number(m[1]); continue; }
    m = line.match(/<dcterms:rights>([^<]*)<\/dcterms:rights>/); // "Public domain in the USA." | "Copyrighted. …"
    if (m) { current.rights = decode(m[1]).trim(); continue; }
    m = line.match(/<pgterms:(marc260|marc906)>(.*)$/);
    if (m) {
      const end = m[2].indexOf(`</pgterms:${m[1]}>`);
      if (end >= 0) current[m[1]] = decode(m[2].slice(0, end)).trim();
      else { field = m[1]; buffer = m[2]; }
      continue;
    }
    m = line.match(/<pgterms:file rdf:about="([^"]+)">/);
    if (m) { file = /\.txt(\.utf-8)?$|\.txt$/.test(m[1]) || /\/files\/\d+\/[^/]+\.txt$/.test(m[1]) ? { url: m[1], bytes: null } : null; if (file) current.txt.push(file); continue; }
    m = line.match(/<dcterms:extent[^>]*>(\d+)<\/dcterms:extent>/);
    if (m && file && file.bytes === null) { file.bytes = Number(m[1]); continue; }
  }
  const code = await new Promise((resolve) => (tar.exitCode !== null ? resolve(tar.exitCode) : tar.on("close", resolve)));
  if (code !== 0 || n < 50_000) throw new Error(`RDF stream incomplete (tar exit ${code}, ${n} ebooks) — not caching`);
  log(`  rdf extract: ${n} ebooks`);
  return extract;
}

// ───────────────────────────── Wikidata ─────────────────────────────

class QueryTimeout extends Error {}

/** One SPARQL query, cached on disk by query hash. Throws QueryTimeout when the server times out. */
async function sparql(query) {
  const path = join(TMP, "sparql", sha1(query) + ".json");
  if (existsSync(path)) return readJSON(path);
  let tries = 0, waits = 0;
  while (true) {
    let response;
    try {
      response = await fetch(SPARQL, {
        method: "POST",
        headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
        body: "query=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(75_000),
      });
    } catch (error) {
      if (++tries > 4) throw error;
      log(`  sparql network error (${error.message}); retry ${tries}`);
      await pause(5000 * tries);
      continue;
    }
    const text = await response.text();
    if (response.status === 200) {
      const json = JSON.parse(text);
      writeJSONAtomic(path, json);
      await pause(WIKIDATA_PAUSE_MS);
      return json;
    }
    if (response.status === 429) {
      const wait = Number(response.headers.get("retry-after")) || 30 * ++waits;
      log(`  sparql 429 — waiting ${wait}s`);
      if (waits > 12) throw new Error("Wikidata keeps refusing (429)");
      await pause(wait * 1000);
      continue;
    }
    if (/TimeoutException|timeout/i.test(text) || response.status === 504) throw new QueryTimeout(`status ${response.status}`);
    if (++tries > 4) throw new Error(`sparql HTTP ${response.status}: ${text.slice(0, 200)}`);
    log(`  sparql HTTP ${response.status}; retry ${tries}`);
    await pause(10_000 * tries);
  }
}

const VALUES = (ids) => ids.map((id) => `"${id}"`).join(" ");
const Q_ITEMS = (ids) => `SELECT ?pg ?item (SAMPLE(?sl) AS ?sitelinks)
  (GROUP_CONCAT(DISTINCT STRAFTER(STR(?c), "entity/"); separator="|") AS ?p31)
  (GROUP_CONCAT(DISTINCT STRAFTER(STR(?pb), "entity/"); separator="|") AS ?p123) WHERE {
  VALUES ?pg { ${VALUES(ids)} }
  ?item wdt:P2034 ?pg .
  OPTIONAL { ?item wikibase:sitelinks ?sl . }
  OPTIONAL { ?item wdt:P31 ?c . }
  OPTIONAL { ?item wdt:P123 ?pb . }
} GROUP BY ?pg ?item`;
const Q_DATES = (ids) => `SELECT ?pg ?item ?time ?prec ?rank WHERE {
  VALUES ?pg { ${VALUES(ids)} }
  ?item wdt:P2034 ?pg ; p:P577 ?st .
  ?st psv:P577 ?tv ; wikibase:rank ?rank .
  ?tv wikibase:timeValue ?time ; wikibase:timePrecision ?prec .
}`;
const Q_WORKS = (ids) => `SELECT ?pg ?item ?work ?wsl ?time ?prec ?rank WHERE {
  VALUES ?pg { ${VALUES(ids)} }
  ?item wdt:P2034 ?pg ; wdt:P629 ?work .
  OPTIONAL { ?work wikibase:sitelinks ?wsl . }
  OPTIONAL { ?work p:P577 ?st . ?st psv:P577 ?tv ; wikibase:rank ?rank . ?tv wikibase:timeValue ?time ; wikibase:timePrecision ?prec . }
}`;

// Authors (P50) of the items found, to catch P2034 statements placed on an unrelated item
// (e.g. PG 1708, H. S. Williams's "A History of Science", carried by Byron's "Don Juan").
const Q_AUTHORS = (ids) => `SELECT ?pg ?item (GROUP_CONCAT(DISTINCT ?name; separator="|") AS ?names) WHERE {
  VALUES ?pg { ${VALUES(ids)} }
  ?item wdt:P2034 ?pg ; wdt:P50 ?a .
  ?a rdfs:label ?name .
  FILTER(LANG(?name) IN ("en", "fr", "es", "de", "it", "la", "mul"))
} GROUP BY ?pg ?item`;

/** Runs one query kind over all IDs in batches of ≤300, halving a batch whenever it times out. */
async function sparqlBatched(ids, build, label, failures) {
  const rows = [];
  const queue = [];
  for (let i = 0; i < ids.length; i += BATCH) queue.push(ids.slice(i, i + BATCH));
  let done = 0;
  while (queue.length) {
    const batch = queue.shift();
    try {
      const json = await sparql(build(batch));
      rows.push(...json.results.bindings);
      done += batch.length;
    } catch (error) {
      if (error instanceof QueryTimeout && batch.length > 10) {
        log(`  ${label}: timeout on ${batch.length} ids — splitting`);
        queue.unshift(batch.slice(0, batch.length >> 1), batch.slice(batch.length >> 1));
        continue;
      }
      log(`  ${label}: FAILED batch of ${batch.length} (${error.message})`);
      failures.push({ stage: `wikidata-${label}`, ids: batch.length, first_id: batch[0], error: error.message });
    }
  }
  log(`  wikidata ${label}: ${done}/${ids.length} ids, ${rows.length} rows`);
  return rows;
}

const val = (b, k) => (b[k] ? b[k].value : null);
const qidOf = (uri) => (uri ? uri.replace(/^.*\/entity\//, "") : null);
const RANK = { "http://wikiba.se/ontology#PreferredRank": 2, "http://wikiba.se/ontology#NormalRank": 1, "http://wikiba.se/ontology#DeprecatedRank": 0 };

/** Picks one P577 statement: preferred rank wins, then the earliest; deprecated never. */
function pickDate(statements) {
  const usable = statements.filter((s) => s.rank > 0 && s.parsed);
  if (!usable.length) return null;
  const top = Math.max(...usable.map((s) => s.rank));
  const best = usable.filter((s) => s.rank === top).sort((a, b) => (a.parsed.year_lo ?? 0) - (b.parsed.year_lo ?? 0) || String(a.time).localeCompare(String(b.time)));
  return { ...best[0].parsed, raw: best[0].time, all: usable.map((s) => s.time) };
}

async function wikidata(ids, failures) {
  const items = await sparqlBatched(ids, Q_ITEMS, "items", failures);
  const dates = await sparqlBatched(ids, Q_DATES, "P577", failures);
  const works = await sparqlBatched(ids, Q_WORKS, "P629-P577", failures);
  const byId = {};
  for (const b of items) {
    const pg = val(b, "pg"), qid = qidOf(val(b, "item"));
    (byId[pg] ||= { items: {} }).items[qid] = {
      qid, sitelinks: val(b, "sitelinks") === null ? null : Number(val(b, "sitelinks")),
      p31: (val(b, "p31") || "").split("|").filter(Boolean), p123: (val(b, "p123") || "").split("|").filter(Boolean),
      dates: [], works: {},
    };
  }
  for (const b of dates) {
    const item = byId[val(b, "pg")]?.items[qidOf(val(b, "item"))];
    if (item) item.dates.push({ time: val(b, "time"), rank: RANK[val(b, "rank")] ?? 1, parsed: wikidataTime(val(b, "time"), val(b, "prec")) });
  }
  for (const b of works) {
    const item = byId[val(b, "pg")]?.items[qidOf(val(b, "item"))];
    if (!item) continue;
    const wq = qidOf(val(b, "work"));
    const work = (item.works[wq] ||= { qid: wq, sitelinks: val(b, "wsl") === null ? null : Number(val(b, "wsl")), dates: [] });
    if (val(b, "time")) work.dates.push({ time: val(b, "time"), rank: RANK[val(b, "rank")] ?? 1, parsed: wikidataTime(val(b, "time"), val(b, "prec")) });
  }
  // P50 authors only for the ebooks that have an item at all (one small query).
  const linked = Object.keys(byId).sort((a, b) => a - b);
  for (const b of await sparqlBatched(linked, Q_AUTHORS, "P50", failures)) {
    const item = byId[val(b, "pg")]?.items[qidOf(val(b, "item"))];
    if (item) item.p50 = (val(b, "names") || "").split("|").filter(Boolean);
  }
  return byId;
}

// ───────────────────────────── dates for one record ─────────────────────────────

const NOT_A_PERSON = /^(various|anonymous|unknown)$/i;
/** True when the Wikidata item names P50 authors and none of them shares a surname word with
 *  anyone Gutenberg credits (author, editor, translator …): the P2034 link is on another work. */
function authorMismatch(row, item) {
  if (!item?.p50?.length) return false;
  const people = row.authors.filter((a) => !NOT_A_PERSON.test(a.name.trim()));
  if (!people.length) return false;
  const words = (s) => plain(s).split(" ").filter((w) => w.length >= 3);
  const wdWords = new Set(item.p50.flatMap(words));
  return !people.some((a) => words(a.name.split(",")[0]).some((w) => wdWords.has(w)));
}

const PROJECT_GUTENBERG_QID = "Q22673";

/** All date evidence for a book, then the primary date by a fixed precedence.
 *  Precedence: title-stated (periodical issues) > gutenberg-marc906 (the printed source PG
 *  transcribed) > wikidata-P577 (the ebook's own item) > wikidata-work-P577
 *  > author-lifetime-estimate > unknown. */
function dateRecord(row, wd, rdf, isPeriodical) {
  const evidence = [];
  const notes = [];
  const issuedYear = /^\d{4}/.test(row.issued) ? Number(row.issued.slice(0, 4)) : null;
  if (isPeriodical && row.title_date) {
    const t = row.title_date;
    evidence.push({ basis: "title-stated", date: t.date, year: t.year, year_lo: t.year_lo ?? t.year, year_hi: t.year_hi ?? t.year, precision: t.precision, raw: t.raw });
    if (t.note) notes.push(t.note);
  }
  // A Wikidata date earlier than the birth of the credited author means the P2034 link points at
  // the wrong item (e.g. PG "Kepler" by W. W. Bryant linked to Kepler's own 1619 book).
  const lead = row.authors.find((a) => (!a.role || /^author$/i.test(a.role)) && Number.isInteger(a.birth));
  let suspect = false;
  if (wd && authorMismatch(row, wd.item)) {
    suspect = true;
    notes.push(`wikidata item ${wd.item.qid} rejected: its author(s) (P50: ${wd.item.p50.join("; ")}) match none of the people Gutenberg credits — the P2034 link points at another work; no date, work or sitelinks taken from it`);
  }
  if (wd && !suspect) {
    const item = wd.item;
    const d = item ? pickDate(item.dates) : null;
    if (d) {
      let rejected = null;
      if (item.p123.includes(PROJECT_GUTENBERG_QID)) rejected = "item publisher (P123) is Project Gutenberg: P577 is the ebook release, not the text's publication";
      else if (issuedYear && d.year_lo >= 1971 && d.year_lo >= issuedYear) rejected = `P577 ${d.raw} is not before the Gutenberg release (${row.issued})`;
      else if (lead && d.year_hi < lead.birth) { rejected = `P577 ${d.raw} precedes the birth (${lead.birth}) of credited author ${lead.name}: the linked item is probably another work`; suspect = true; }
      else if (lead && Number.isInteger(lead.death) && d.year_lo >= 1929 && d.year_lo > lead.death + 30) rejected = `P577 ${d.raw} is more than 30 years after the death (${lead.death}) of credited author ${lead.name}: a modern edition, not the source Gutenberg transcribed`;
      if (rejected) notes.push(`wikidata-P577 ${d.raw} on ${item.qid} rejected: ${rejected}`);
      else evidence.push({ basis: "wikidata-P577", date: d.date, year: d.year, year_lo: d.year_lo, year_hi: d.year_hi, precision: d.precision, raw: d.raw, qid: item.qid, wikidata_precision: d.wikidata_precision });
    }
  }
  if (rdf && rdf.marc906) {
    const m = rdf.marc906.match(/^\s*(\d{4})\s*$/);
    const dec = rdf.marc906.match(/^\s*(\d{3})-\s*\??\s*$/);
    if (m) evidence.push({ basis: "gutenberg-marc906", date: m[1], year: Number(m[1]), year_lo: Number(m[1]), year_hi: Number(m[1]), precision: "year", raw: rdf.marc906 });
    else if (dec) evidence.push({ basis: "gutenberg-marc906", date: null, year: null, year_lo: Number(dec[1]) * 10, year_hi: Number(dec[1]) * 10 + 9, precision: "range", raw: rdf.marc906 });
    else notes.push(`marc906 "${rdf.marc906}" not parsed`);
  }
  if (wd && wd.work && !suspect) {
    const d = pickDate(wd.work.dates);
    if (d && lead && d.year_hi < lead.birth) notes.push(`wikidata-work-P577 ${d.raw} on ${wd.work.qid} rejected: precedes the birth (${lead.birth}) of credited author ${lead.name}`);
    else if (d) evidence.push({ basis: "wikidata-work-P577", date: d.date, year: d.year, year_lo: d.year_lo, year_hi: d.year_hi, precision: d.precision, raw: d.raw, qid: wd.work.qid, wikidata_precision: d.wikidata_precision });
  }
  const life = lifetimeEstimate(row.authors, issuedYear);
  if (life) evidence.push({ basis: "author-lifetime-estimate", date: null, year: life.year, year_lo: life.year_lo, year_hi: life.year_hi, precision: "range", raw: `author ${life.author}` });
  // MARC 906 is the printed source Gutenberg actually transcribed, so it outranks Wikidata's P577,
  // which is often the work's first publication (e.g. Harvey 1628 for a 1906 English translation).
  const order = ["title-stated", "gutenberg-marc906", "wikidata-P577", "wikidata-work-P577", "author-lifetime-estimate"];
  evidence.sort((a, b) => order.indexOf(a.basis) - order.indexOf(b.basis));
  const primary = evidence[0] || { basis: "unknown", date: null, year: null, year_lo: null, year_hi: null, precision: "unknown" };
  const stated = evidence.filter((e) => e.basis !== "author-lifetime-estimate" && Number.isInteger(e.year_lo));
  const span = stated.length > 1 ? Math.max(...stated.map((e) => e.year_lo)) - Math.min(...stated.map((e) => e.year_lo)) : 0;
  return { primary, evidence, disagreement_years: span, notes, qid_suspect: suspect };
}

// ───────────────────────────── downloads ─────────────────────────────

const STATE = join(TMP, "downloads.json");
const PARKED = join(TMP, "unselected"); // texts downloaded in an earlier run but no longer selected

function folderOf(id) {
  const digits = String(id);
  return digits.length > 1 ? digits.slice(0, -1).split("").join("/") : "0";
}

/** Candidate mirror URLs in Cipher's order (<id>-0.txt, <id>.txt, <id>-8.txt), then the
 *  generated cache/epub/<id>/pg<id>.txt as a last resort. When the RDF lists the files, only
 *  listed variants are tried (fewer 404s). */
function candidateUrls(id, rdf) {
  const listed = new Set((rdf?.txt || []).map((f) => f.url.replace(/^.*\//, "")));
  const variants = [`${id}-0.txt`, `${id}.txt`, `${id}-8.txt`];
  const urls = [];
  for (const name of variants) if (!rdf || !rdf.txt.length || listed.has(name)) urls.push({ url: `${MIRROR}/${folderOf(id)}/${id}/${name}`, variant: name });
  urls.push({ url: `${MIRROR}/cache/epub/${id}/pg${id}.txt`, variant: `pg${id}.txt (generated)` });
  return urls;
}

async function getBytes(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(120_000) });
      if (response.status === 200) return { status: 200, body: Buffer.from(await response.arrayBuffer()) };
      if (response.status === 429 || response.status >= 500) {
        const wait = Number(response.headers.get("retry-after")) || 15 * attempt;
        log(`  ${response.status} on ${url} — waiting ${wait}s`);
        await pause(wait * 1000);
        continue;
      }
      return { status: response.status, body: null };
    } catch (error) {
      log(`  ${error.name} on ${url} (attempt ${attempt})`);
      await pause(4000 * attempt);
    }
  }
  return { status: "error", body: null };
}

/** Where the work's text lies inside a raw Gutenberg file (byte offsets; the file is never altered).
 *  - START: just after the complete "*** START OF THE/THIS PROJECT GUTENBERG EBOOK <title> ***" marker,
 *    whose title can wrap over up to three more lines ("…EXPERIMENTAL RESEARCHES IN" / "ELECTRICITY,
 *    VOLUME 1***"); the marker ends at its closing "***".
 *  - END: the start of the "*** END OF THE/THIS PROJECT GUTENBERG" line, moved back over Gutenberg's own
 *    "End of the Project Gutenberg EBook of …" / "End of Project Gutenberg's …" line (and its wrapped
 *    continuation) when that is the last text before the marker.
 *  - Old releases without these markers: the body starts after "*END*THE SMALL PRINT! …*END*" and ends
 *    before the closing "End of [the] Project Gutenberg …" line.
 *  Returns byte offsets into the raw file plus what was adjusted. */
const END_OF_EBOOK_LINE = /(^|\n)[ \t]*End of (?:the )?Project Gutenberg/gi;
function bodyBounds(body) {
  const raw = body.toString("latin1"); // 1 char = 1 byte, so string offsets are byte offsets
  const out = { start: null, end: null, markerStart: null, markerEnd: null, bounds: null, startWrapped: false, endLineTrimmed: false };
  const startM = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG/i.exec(raw);
  const endM = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG/i.exec(raw);
  if (startM) {
    out.markerStart = raw.lastIndexOf("\n", startM.index) + 1;
    const from = startM.index + startM[0].length;
    const window = raw.slice(from, from + 1000);
    const close = window.indexOf("***");
    const span = close >= 0 ? window.slice(0, close) : "";
    let markerClose = from;
    if (close >= 0 && (span.match(/\n/g) || []).length <= 3 && !/\n[ \t\r]*\n/.test(span)) {
      markerClose = from + close + 3;
      out.startWrapped = /\n/.test(span);
    }
    const nl = raw.indexOf("\n", markerClose);
    out.start = nl >= 0 ? nl + 1 : null;
    out.bounds = "start-end-markers";
  }
  if (endM && (out.start === null || endM.index > out.start)) {
    out.markerEnd = raw.lastIndexOf("\n", endM.index) + 1;
    out.end = out.markerEnd;
  }
  if (!startM && !endM) {
    const small = /\*END\*?\s*THE SMALL PRINT[^\n]*/i.exec(raw);
    if (small && small.index < raw.length / 2) {
      const nl = raw.indexOf("\n", small.index);
      out.start = nl >= 0 ? nl + 1 : null;
      out.markerStart = raw.lastIndexOf("\n", small.index) + 1;
      out.bounds = "small-print-header";
    }
  }
  // Gutenberg's own closing line right before the END marker (or at the end of an old release).
  const tailFrom = Math.max(out.start ?? 0, (out.end ?? raw.length) - 3000);
  const tail = raw.slice(tailFrom, out.end ?? raw.length);
  let last = null;
  for (const m of tail.matchAll(END_OF_EBOOK_LINE)) last = m;
  if (last) {
    const lineStart = tailFrom + last.index + last[1].length;
    const rest = raw.slice(lineStart, out.end ?? raw.length).split(/\r?\n/).filter((l) => l.trim());
    if (rest.length <= 3) { out.end = lineStart; out.endLineTrimmed = true; if (!out.bounds) out.bounds = "end-line-only"; }
  }
  return out;
}

/** Text facts computed from the raw bytes (nothing is altered on disk). */
function inspectText(body) {
  const ascii = !body.some((b) => b > 0x7f);
  let encoding = "ascii", text;
  if (!ascii) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); encoding = "utf-8"; }
    catch { text = new TextDecoder("windows-1252").decode(body); encoding = "8-bit (not valid UTF-8)"; }
  } else text = body.toString("latin1");
  const head = text.slice(0, 6000);
  const declared = (head.match(/Character set encoding:\s*([^\r\n]+)/i) || [])[1]?.trim() || null;
  const b = bodyBounds(body);
  const slice = body.subarray(b.start ?? 0, b.end ?? body.length).toString(encoding === "utf-8" ? "utf8" : "latin1");
  const nonSpace = slice.replace(/\s+/g, "").length;
  const letters = (slice.match(/\p{L}/gu) || []).length;
  return {
    encoding, declared_encoding: declared, body_start_byte: b.start, body_end_byte: b.end,
    letter_ratio: nonSpace ? Math.round((letters / nonSpace) * 1000) / 1000 : 0,
  };
}

/** Licence from Gutenberg's own rights statement (RDF dcterms:rights). Most STEMM texts are
 *  public domain in the USA; some (1990s-2000s Internet guides, Marie Lebert's essays …) are
 *  copyrighted works Gutenberg distributes with the rights holder's permission. */
function licenseOf(rights) {
  if (!rights) return "Not stated in Gutenberg's RDF catalogue (check the notice inside the text)";
  if (/^Public domain in the USA/i.test(rights)) return LICENSE;
  if (/^Copyrighted/i.test(rights)) return "Copyrighted (distributed by Project Gutenberg with the rights holder's permission; terms in the copyright notice inside the text)";
  return `Project Gutenberg rights statement: ${rights}`;
}

/** What Gutenberg boilerplate the raw file carries. Many files in the mirror's ebook folders hold
 *  only the "*** START/END OF THE PROJECT GUTENBERG EBOOK" lines, without header or licence. */
function boilerplateOf(raw, b) {
  let head, tail;
  if (b.markerStart === null) { head = raw.subarray(0, 6000); tail = raw.subarray(Math.max(0, raw.length - 30000)); }
  else {
    head = raw.subarray(0, b.markerStart);
    tail = b.end === null ? Buffer.alloc(0) : raw.subarray(b.end);
  }
  const header = /Project Gutenberg/i.test(head.toString("latin1"));
  // The licence sits after the END marker, or (old releases) in the "SMALL PRINT" block of the header.
  const licenceText = tail.toString("latin1") + (b.markerStart === null || b.bounds === "small-print-header" ? raw.subarray(0, (b.start ?? 6000)).toString("latin1") : "");
  const licence = /START: FULL LICENSE|PROJECT GUTENBERG(-tm)? (EBOOK )?LICENSE|Project Gutenberg-tm License|SMALL PRINT/i.test(licenceText);
  return header && licence ? "header+licence" : header ? "header" : licence ? "licence" : "markers-only";
}

/** Gutenberg material still inside [body_start_byte, body_end_byte) after the bounds above:
 *  transcriber/producer credits at the top ("Produced by …", "E-text prepared by …"). */
function bodyResidueOf(raw, b) {
  if (b.start === null) return ["no-bounds"];
  const head = raw.subarray(b.start, Math.min(raw.length, b.start + 1500)).toString("latin1");
  const residue = [];
  if (/^\s*(?:\S[^\n]*\n){0,12}?[ \t]*(?:Produced by|E-?text prepared by|Transcribed (?:from|by)|This e-?(?:book|text) was produced by|Prepared by)\b/i.test(head)) residue.push("credits-at-start");
  return residue;
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  const failures = [];
  log(`${SOURCE}: reading catalogue ${CATALOG_CSV}`);
  const csv = parseCSV(readFileSync(CATALOG_CSV, "utf8"));
  const header = csv.shift();
  const rows = csv.filter((r) => r.length >= header.length).map((r) => Object.fromEntries(header.map((h, k) => [h, r[k]])));
  const catalogSha = createHash("sha256").update(readFileSync(CATALOG_CSV)).digest("hex");

  const books = new Map(); // id → normalised catalogue row
  for (const r of rows) {
    const id = Number(r["Text#"]);
    if (!Number.isInteger(id)) continue;
    const title = r.Title.replace(/\r\n?/g, "\n").trim();
    books.set(id, {
      id, type: r.Type, issued: r.Issued, title, language: r.Language.trim(),
      authors: splitList(r.Authors).map(parseAuthor), subjects: splitList(r.Subjects), locc: splitList(r.LoCC), bookshelves: splitList(r.Bookshelves),
    });
  }
  log(`  ${books.size} catalogue rows`);

  // Cipher's 693 literature books: never re-downloaded here.
  const cipherList = readJSON(CIPHER_LIST, []);
  const cipherIds = new Set(cipherList.map((b) => Number(b.id)));

  // ── candidates
  const counts = { catalogue_rows: books.size, cipher_books: cipherList.length, cipher_unique_ids: cipherIds.size };
  const skips = {};
  const skip = (reason) => (skips[reason] = (skips[reason] || 0) + 1);
  const bookCandidates = [], periodicalCandidates = [];
  for (const b of books.values()) {
    if (b.type !== "Text") continue;
    if (!LANGUAGES.has(b.language)) continue;
    const stemm = b.locc.some(isStemmClass);
    const sciencePeriodical = b.locc.includes("AP") && b.subjects.some((s) => /^(Science|Technology) -- Periodicals$/.test(s)) && !b.subjects.some((s) => /Literature/.test(s));
    if (!stemm && !sciencePeriodical) continue;
    b.field_info = stemm ? fieldOf(b.locc, b.subjects, b.bookshelves) : { field: "general-science", field_class: "AP", field_rule: "AP science periodical (Science/Technology -- Periodicals)" };
    if (!b.field_info) continue;
    const isPeriodical = b.subjects.some((s) => /-- Periodicals\b/.test(s)) || sciencePeriodical;
    if (cipherIds.has(b.id)) { skip("already in Cipher's 693 (see cipher-overlap.jsonl)"); continue; }
    if (b.subjects.some((s) => /Mathematical constants/i.test(s)) || /\bto [\d,]+ (places|digits)\b|\(to [\d,]+ (places|digits)\)/i.test(b.title)) { skip("numeric table (constants/digits), not prose"); continue; }
    if (isPeriodical) {
      b.title_date = titleDate(b.title);
      if (!b.title_date) { skip("periodical without an exact (day/month) issue date in its title"); continue; }
      periodicalCandidates.push(b);
    } else bookCandidates.push(b);
  }
  counts.book_candidates = bookCandidates.length;
  counts.periodical_candidates = periodicalCandidates.length;
  log(`  candidates: ${bookCandidates.length} books, ${periodicalCandidates.length} dated periodical issues`);

  // Cipher overlap (books that carry STEMM classes)
  const cipherStemm = cipherList.filter((c) => {
    const b = books.get(Number(c.id));
    return b && b.locc.some(isStemmClass);
  });

  // ── RDF + Wikidata enrichment
  const rdf = await loadRdf();
  const wdIds = [...new Set([...bookCandidates, ...periodicalCandidates].map((b) => b.id).concat(cipherStemm.map((c) => Number(c.id))))].sort((a, b) => a - b).map(String);
  log(`wikidata: ${wdIds.length} ebook ids in batches of ${BATCH}`);
  const wdRaw = await wikidata(wdIds, failures);
  /** Chooses one item per ebook (most sitelinks) and one work per item (most sitelinks). */
  const wdFor = (id) => {
    const entry = wdRaw[String(id)];
    if (!entry) return null;
    const items = Object.values(entry.items).sort((a, b) => (b.sitelinks ?? -1) - (a.sitelinks ?? -1));
    const item = items[0];
    const work = Object.values(item.works).sort((a, b) => (b.sitelinks ?? -1) - (a.sitelinks ?? -1))[0] || null;
    return { item, work, all_qids: items.map((i) => i.qid) };
  };

  // ── enrich every candidate
  const enrich = (b, isPeriodical) => {
    let wd = wdFor(b.id);
    const r = rdf[String(b.id)] || null;
    const dates = dateRecord(b, wd, r, isPeriodical);
    // A link rejected as pointing at another work (see dateRecord) lends nothing: no qid, work,
    // sitelinks or edition grouping. Its QID stays in qids_all; date_notes says why.
    if (dates.qid_suspect) wd = { item: null, work: null, all_qids: wd.all_qids };
    const txt = (r?.txt || []).filter((f) => /\/files\/\d+\/\d+(-0|-8)?\.txt$/.test(f.url));
    const anyTxt = (r?.txt || []).find((f) => /\.txt\.utf-8$/.test(f.url));
    const size = txt.length ? Math.max(...txt.map((f) => f.bytes || 0)) : anyTxt ? anyTxt.bytes : null;
    const sitelinks = wd?.item?.sitelinks ?? null;
    const workSitelinks = wd?.work?.sitelinks ?? null;
    const notability = Math.max(sitelinks || 0, workSitelinks || 0);
    const p = dates.primary;
    const mid = Number.isInteger(p.year) ? p.year : Number.isInteger(p.year_lo) ? Math.round((p.year_lo + p.year_hi) / 2) : null;
    const dateBonus = { "title-stated": 1, "wikidata-P577": 1, "gutenberg-marc906": 1, "wikidata-work-P577": 1, "author-lifetime-estimate": 0, unknown: -1.5 }[p.basis];
    const score = 2 * Math.log2(1 + notability) + Math.log10(1 + (r?.downloads || 0)) + dateBonus + (size && size >= MIN_BYTES ? 0.5 : 0);
    Object.assign(b, { wd, rdf: r, dates, expected_bytes: size, sitelinks, work_sitelinks: workSitelinks, notability, mid_year: mid, score: Math.round(score * 1000) / 1000 });
    return b;
  };
  bookCandidates.forEach((b) => enrich(b, false));
  periodicalCandidates.forEach((b) => enrich(b, true));

  // ── book selection
  const periodBin = (y) => (y === null ? "unknown" : y < 1700 ? "<1700" : y < 1800 ? "1700-1799" : y < 1850 ? "1800-1849" : y < 1875 ? "1850-1874" : y < 1900 ? "1875-1899" : y <= 1928 ? "1900-1928" : ">1928");
  const BIN_WEIGHT = { "<1700": 1, "1700-1799": 1, "1800-1849": 1, "1850-1874": 1, "1875-1899": 1, "1900-1928": 1, ">1928": 0.5, unknown: 0.5 };
  // Size filter (RDF-reported), then one edition per work (best score), ≤2 volumes of a multi-volume work.
  const eligible = [];
  for (const b of bookCandidates) {
    if (b.expected_bytes !== null && b.expected_bytes > MAX_BYTES) { skip(`plain text larger than ${MAX_BYTES} bytes (dataset-like)`); continue; }
    if (b.rdf && !b.rdf.txt.some((f) => /\/\d+(-0|-8)?\.txt$|\.txt\.utf-8$/.test(f.url))) { skip("no plain-text file in Gutenberg's RDF (PDF/TeX/HTML-only ebook)"); continue; }
    b.short = b.expected_bytes !== null && b.expected_bytes < MIN_BYTES;
    b.work = workKey(b);
    b.period_bin = periodBin(b.mid_year);
    eligible.push(b);
  }
  const cipherWorks = new Map(); // bucket → work keys of Cipher's books
  for (const c of cipherList) {
    const b = books.get(Number(c.id));
    if (!b) continue;
    const w = workKey(b);
    if (!cipherWorks.has(w.bucket)) cipherWorks.set(w.bucket, []);
    cipherWorks.get(w.bucket).push(w);
  }
  const cipherQids = new Set(cipherList.map((c) => c.q).filter(Boolean));
  const groups = [], byBucket = new Map(), byWorkQid = new Map();
  for (const b of eligible.sort((a, b) => b.score - a.score || a.id - b.id)) {
    const qids = [b.wd?.item?.qid, b.wd?.work?.qid].filter(Boolean);
    if ((cipherWorks.get(b.work.bucket) || []).some((w) => sameWork(w, b.work)) || qids.some((q) => cipherQids.has(q))) {
      skip("another edition of a work already in Cipher's 693"); b.excluded = "cipher-work"; continue;
    }
    const wq = b.wd?.work?.qid ? `${b.language}|${b.wd.work.qid}` : null;
    const group = (wq && byWorkQid.get(wq)) || (byBucket.get(b.work.bucket) || []).find((g) => g.some((x) => sameWork(x.work, b.work)));
    if (!group) {
      const g = [b];
      groups.push(g);
      if (!byBucket.has(b.work.bucket)) byBucket.set(b.work.bucket, []);
      byBucket.get(b.work.bucket).push(g);
      if (wq) byWorkQid.set(wq, g);
      continue;
    }
    const parts = new Set(group.map((x) => x.work.part));
    if (b.work.part && !parts.has(b.work.part) && group.length < 2 && group.every((x) => x.work.part)) {
      group.push(b);
      if (wq) byWorkQid.set(wq, group);
      continue;
    }
    b.excluded = "duplicate-edition";
    skip("another edition/volume of the same work ranked higher");
  }
  const unique = groups.flat();
  const long = unique.filter((b) => !b.short);
  counts.books_unique_works = unique.length;
  counts.books_unique_long = long.length;

  // Field quotas: ≥ FIELD_MIN where available, the rest split in proportion to √(availability).
  const avail = Object.fromEntries(FIELDS.map((f) => [f, long.filter((b) => b.field_info.field === f).length]));
  const availShort = Object.fromEntries(FIELDS.map((f) => [f, unique.filter((b) => b.field_info.field === f).length]));
  const quota = {};
  let remaining = BOOK_TARGET;
  for (const f of FIELDS) { quota[f] = Math.min(FIELD_MIN, availShort[f]); remaining -= quota[f]; }
  for (let round = 0; round < 6 && remaining > 0; round++) {
    const open = FIELDS.filter((f) => quota[f] < avail[f]);
    const weight = open.reduce((s, f) => s + Math.sqrt(avail[f]), 0);
    if (!open.length) break;
    let given = 0;
    for (const f of open) {
      const add = Math.min(avail[f] - quota[f], Math.floor((remaining * Math.sqrt(avail[f])) / weight));
      quota[f] += add; given += add;
    }
    remaining -= given;
    if (given === 0) break;
  }
  log("  field availability (≥30 KB, unique works):", JSON.stringify(avail));
  log("  field quotas:", JSON.stringify(quota));

  /** Ranked order inside a field: always draw the best remaining book from the period bin that
   *  is furthest below its weighted share, so 1900-1928 cannot swamp the field. */
  const rankField = (pool) => {
    const bins = {};
    for (const b of pool.sort((a, b) => b.score - a.score || a.id - b.id)) (bins[b.period_bin] ||= []).push(b);
    const taken = Object.fromEntries(Object.keys(bins).map((k) => [k, 0]));
    const order = [];
    while (Object.values(bins).some((l) => l.length)) {
      const open = Object.keys(bins).filter((k) => bins[k].length);
      open.sort((a, c) => taken[a] / BIN_WEIGHT[a] - taken[c] / BIN_WEIGHT[c] || bins[c][0].score - bins[a][0].score);
      const k = open[0];
      order.push(bins[k].shift());
      taken[k]++;
    }
    return order;
  };
  const ranked = {};
  for (const f of FIELDS) {
    const longPool = long.filter((b) => b.field_info.field === f);
    const shortPool = unique.filter((b) => b.field_info.field === f && b.short);
    ranked[f] = rankField(longPool).concat(rankField(shortPool)); // short texts only fill a field below its minimum
  }

  // Language balance: fr/es are interleaved by rank but capped to NON_EN_SHARE of the book target.
  const nonEnCap = Math.round(BOOK_TARGET * NON_EN_SHARE);

  // ── periodical series: the three headline science weeklies/monthlies first (whole runs, the
  // Supplement capped and spread over its dates), then one issue per other series, largest
  // series first, round after round, until PERIODICAL_CAP.
  const seriesOf = (b) => {
    let s = plain(b.title.split("\n")[0].split(/,|\bvol\b|\bvolume\b|\bno\b\.?|\[|\d/i)[0]);
    s = s.replace(/^appletons /, "").replace(new RegExp(`\\b(${MONTH_RE})\\b`, "g"), "").replace(/\bmagazine$/, "").replace(/\s+/g, " ").trim();
    if (s === "birds illustrated by color photography") s = "birds";
    // "Scientific American, September 29, 1883 Supplement. No. 404" is a Supplement issue.
    if (s && !/\bsupplement\b/.test(s) && /\bsupplement\b/i.test(b.title.split("\n")[0])) s += " supplement";
    return s || "untitled";
  };
  const HEADLINE = ["scientific american", "scientific american supplement", "popular science monthly"];
  const series = {};
  for (const b of periodicalCandidates) (series[seriesOf(b)] ||= []).push(b);
  const seriesQueues = Object.entries(series).map(([name, issues]) => {
    issues.sort((a, b) => a.dates.primary.date.localeCompare(b.dates.primary.date) || a.id - b.id);
    // evenly spaced picks first, then the rest (fallbacks if a download fails)
    const n = Math.min(issues.length, PER_SERIES_CAP);
    const picks = [], used = new Set();
    for (let i = 0; i < n; i++) { const k = Math.floor((i * issues.length) / n); picks.push(issues[k]); used.add(k); }
    issues.forEach((b, k) => { if (!used.has(k)) picks.push(b); });
    return { name, size: issues.length, issues: picks, cap: Math.min(PER_SERIES_CAP, issues.length), headline: HEADLINE.includes(name) };
  });
  seriesQueues.sort((a, b) => b.headline - a.headline || b.size - a.size || a.name.localeCompare(b.name));
  counts.periodical_series_available = Object.fromEntries(seriesQueues.map((s) => [s.name, s.size]));

  // ── download (or plan) ──
  const state = readJSON(STATE, {}); // id → {status, url, variant, bytes, sha256, ...}
  let newDownloads = 0, limitHit = false;
  const saveState = () => writeJSONAtomic(STATE, state);

  async function ensure(b) {
    const id = b.id;
    const path = join(TEXTS, `${id}.txt`);
    const s = state[id];
    if (s && s.status === "ok" && existsSync(path)) return s;
    if (s && s.status === "ok" && existsSync(join(PARKED, `${id}.txt`))) { renameSync(join(PARKED, `${id}.txt`), path); return s; }
    // A recorded rejection or a definite miss (every variant 404/too small) is final; a failure
    // caused by network errors or 5xx is retried on the next run.
    if (s && s.status === "rejected-not-prose") return s;
    if (s && s.status === "failed" && s.permanent) return s;
    if (existsSync(path) && s) { // text on disk, state complete enough to rebuild
      return s;
    }
    if (PLAN_ONLY) return { status: "planned" };
    if (newDownloads >= LIMIT) { limitHit = true; return { status: "limit" }; }
    const tried = [];
    for (const { url, variant } of candidateUrls(id, b.rdf)) {
      const { status, body } = await getBytes(url);
      await pause(MIRROR_PAUSE_MS);
      tried.push(`${variant}:${status}`);
      if (!body) continue;
      if (body.length <= 5000) { tried.push(`${variant}:too-small(${body.length})`); continue; } // Cipher's threshold
      newDownloads++;
      const facts = inspectText(body);
      const record = { status: "ok", url, variant, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), downloaded_at: new Date().toISOString(), tried, ...facts };
      if (facts.letter_ratio < MIN_LETTER_RATIO) {
        record.status = "rejected-not-prose"; // body is mostly digits/symbols (tables, constants)
        state[id] = record; saveState();
        return record;
      }
      writeFileSync(path + ".part", body);
      renameSync(path + ".part", path);
      state[id] = record; saveState();
      if (newDownloads % 25 === 0) log(`  downloaded ${newDownloads} new texts`);
      return record;
    }
    const permanent = tried.every((t) => /:(404|410|too-small)/.test(t) || /:200$/.test(t));
    state[id] = { status: "failed", permanent, tried, at: new Date().toISOString() };
    saveState();
    failures.push({ stage: "download", id, tried });
    return state[id];
  }

  // Restore download facts for texts already on disk but missing from state (e.g. state file lost).
  for (const name of readdirSync(TEXTS)) {
    const m = name.match(/^(\d+)\.txt$/);
    if (!m || (state[m[1]] && state[m[1]].status === "ok")) continue;
    const body = readFileSync(join(TEXTS, name));
    state[m[1]] = { status: "ok", url: null, variant: null, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), downloaded_at: statSync(join(TEXTS, name)).mtime.toISOString(), tried: ["(state rebuilt from file on disk; source URL not recorded)"], ...inspectText(body) };
  }

  const selected = [];
  const accepted = (r) => r.status === "ok" || r.status === "planned";
  /** Next downloadable issue of a series; false when the series is exhausted (or the run limit hit). */
  async function takeIssue(s) {
    while (s.issues.length) {
      const b = s.issues.shift();
      const r = await ensure(b);
      if (r.status === "limit") return false;
      if (accepted(r)) { b.kind = "periodical-issue"; b.series = s.name; selected.push(b); s.taken = (s.taken || 0) + 1; return true; }
    }
    return false;
  }
  // Periodicals (≤ PERIODICAL_CAP): headline series first, then rounds of one issue per other series.
  {
    let picked = 0;
    for (const s of seriesQueues.filter((q) => q.headline))
      while (picked < PERIODICAL_CAP && (s.taken || 0) < s.cap && (await takeIssue(s))) picked++;
    let progress = true;
    while (picked < PERIODICAL_CAP && progress) {
      progress = false;
      for (const s of seriesQueues.filter((q) => !q.headline)) {
        if (picked >= PERIODICAL_CAP || (s.taken || 0) >= s.cap) continue;
        if (await takeIssue(s)) { picked++; progress = true; }
      }
    }
    counts.periodicals_selected = picked;
    counts.periodical_series_selected = Object.fromEntries(seriesQueues.filter((s) => s.taken).map((s) => [s.name, s.taken]));
  }
  // Books. First French/Spanish (best score first, ≤ NON_EN_SHARE of the target overall and
  // ≤ 25 % of any field's quota), then English, field by field in period-balanced rank order.
  const got = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  const nonEnPerField = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  let nonEn = 0;
  for (const b of long.filter((x) => x.language !== "en").sort((a, c) => c.score - a.score || a.id - c.id)) {
    const f = b.field_info.field;
    if (nonEn >= nonEnCap) break;
    if (got[f] >= quota[f] || nonEnPerField[f] >= Math.ceil(quota[f] * 0.25)) continue;
    const r = await ensure(b);
    if (!accepted(r)) continue;
    b.kind = "book"; selected.push(b); got[f]++; nonEnPerField[f]++; nonEn++;
  }
  const fieldLog = Object.fromEntries(FIELDS.map((f) => [f, { quota: quota[f], ranked_candidates: ranked[f].length, examined: 0, unavailable: 0, quota_met: false }]));
  for (const f of FIELDS) {
    let i = 0;
    for (const b of ranked[f]) {
      i++;
      if (got[f] >= quota[f]) { i--; break; }
      if (b.language !== "en") continue; // fr/es were placed above
      if (b.short && got[f] >= Math.min(FIELD_MIN, quota[f])) { i--; break; } // short texts only to reach the minimum
      const r = await ensure(b);
      if (!accepted(r)) { if (r.status !== "limit") fieldLog[f].unavailable++; continue; }
      b.kind = "book"; selected.push(b); got[f]++;
    }
    fieldLog[f].examined = i;
    fieldLog[f].quota_met = got[f] >= quota[f];
  }
  counts.field_selection = fieldLog;
  counts.books_selected_by_field = got;
  counts.books_non_en_selected = nonEn;

  // Texts on disk that are no longer selected are parked outside the output folder (kept, so a
  // later re-selection costs no download), so texts/ holds exactly the catalogued files.
  if (!PLAN_ONLY && !limitHit) {
    const keep = new Set(selected.map((b) => `${b.id}.txt`));
    for (const name of readdirSync(TEXTS)) {
      if (!/^\d+\.txt$/.test(name) || keep.has(name)) continue;
      mkdirSync(PARKED, { recursive: true });
      renameSync(join(TEXTS, name), join(PARKED, name));
      counts.parked_unselected = (counts.parked_unselected || 0) + 1;
    }
  }

  // ── write catalog.jsonl
  const catalog = jsonlWriter(join(OUT, "catalog.jsonl"));
  const stats = { by_kind: {}, by_language: {}, by_field: {}, by_basis: {}, by_precision: {}, by_period: {}, by_license: {}, by_boilerplate: {}, by_body_bounds: {}, bytes: 0, with_qid: 0, short_texts: 0,
    text_export_allowed: 0, text_export_blocked: 0, start_marker_wrapped: 0, end_of_ebook_line_excluded: 0, credits_at_body_start: 0, sha256_mismatch: 0 };
  const inc = (o, k) => (o[k] = (o[k] || 0) + 1);
  const out = [];
  for (const b of selected.sort((a, c) => a.id - c.id)) {
    const s = state[b.id] || {};
    if (s.status !== "ok" && !PLAN_ONLY) continue;
    const p = b.dates.primary;
    // Body bounds and text facts are recomputed from the file on disk on every run, so a fix to the
    // bounds logic reaches every record without re-downloading anything.
    let facts = s, bounds = null, rawText = null;
    if (s.status === "ok") {
      rawText = readFileSync(join(TEXTS, `${b.id}.txt`));
      if (createHash("sha256").update(rawText).digest("hex") !== s.sha256) { stats.sha256_mismatch++; failures.push({ stage: "verify", id: b.id, error: "file on disk does not match the recorded sha256" }); }
      bounds = bodyBounds(rawText);
      facts = { ...s, ...inspectText(rawText) };
    }
    const rights = b.rdf?.rights ?? null;
    const record = {
      id: b.id,
      kind: b.kind,
      title: b.title.split("\n")[0].trim(),
      title_full: b.title,
      language: b.language,
      authors: b.authors.map((a) => ({ name: a.name, birth: a.birth, death: a.death, role: a.role, ...(a.birth_approx ? { birth_approx: true } : {}), ...(a.death_approx ? { death_approx: true } : {}), ...(a.active ? { active: a.active } : {}), raw: a.raw })),
      locc: b.locc,
      subjects: b.subjects,
      bookshelves: b.bookshelves,
      field: b.field_info.field,
      field_class: b.field_info.field_class,
      field_rule: b.field_info.field_rule,
      series: b.series || null,
      year: p.year ?? null,
      year_lo: p.year_lo ?? null,
      year_hi: p.year_hi ?? null,
      date: p.date ?? null,
      date_precision: p.precision,
      date_basis: p.basis,
      date_evidence: b.dates.evidence,
      date_disagreement_years: b.dates.disagreement_years,
      date_notes: b.dates.notes,
      qid: b.wd?.item?.qid ?? null,
      qids_all: b.wd?.all_qids ?? [],
      sitelinks: b.sitelinks,
      work_qid: b.wd?.work?.qid ?? null,
      work_sitelinks: b.work_sitelinks,
      downloads: b.rdf?.downloads ?? null,
      marc260: b.rdf?.marc260 ?? null,
      gutenberg_issued: b.issued || null,
      file: s.status === "ok" ? `texts/${b.id}.txt` : null,
      bytes: s.bytes ?? null,
      sha256: s.sha256 ?? null,
      source_url: s.url ?? null,
      source_variant: s.variant ?? null,
      encoding: facts.encoding ?? null,
      declared_encoding: facts.declared_encoding ?? null,
      body_start_byte: facts.body_start_byte ?? null,
      body_end_byte: facts.body_end_byte ?? null,
      body_bounds: bounds?.bounds ?? null,
      body_residue: bounds ? bodyResidueOf(rawText, bounds) : [],
      letter_ratio: facts.letter_ratio ?? null,
      downloaded_at: s.downloaded_at ?? null,
      priority_score: b.score,
      period_bin: b.kind === "book" ? b.period_bin : periodBin(p.year),
      below_30kb: b.kind === "book" ? !!b.short : (s.bytes ?? 0) < MIN_BYTES,
      pg_boilerplate: bounds ? boilerplateOf(rawText, bounds) : null,
      pg_rights: rights,
      license: licenseOf(rights),
      // The app may export/share the full text only when Gutenberg says public domain in the USA.
      text_export_allowed: Boolean(rights && /^Public domain in the USA/i.test(rights)),
    };
    out.push(record);
    catalog.write(record);
    inc(stats.by_kind, record.kind); inc(stats.by_language, record.language); inc(stats.by_field, record.field);
    inc(stats.by_basis, record.date_basis); inc(stats.by_precision, record.date_precision); inc(stats.by_period, record.period_bin);
    inc(stats.by_license, record.license); inc(stats.by_boilerplate, record.pg_boilerplate); inc(stats.by_body_bounds, String(record.body_bounds));
    if (record.text_export_allowed) stats.text_export_allowed++; else stats.text_export_blocked++;
    if (bounds?.startWrapped) stats.start_marker_wrapped++;
    if (bounds?.endLineTrimmed) stats.end_of_ebook_line_excluded++;
    if (record.body_residue.includes("credits-at-start")) stats.credits_at_body_start++;
    stats.bytes += record.bytes || 0; if (record.qid) stats.with_qid++; if (record.below_30kb) stats.short_texts++;
  }
  await catalog.close();

  // ── cipher-overlap.jsonl: every one of Cipher's books, marked STEMM or not.
  const overlap = jsonlWriter(join(OUT, "cipher-overlap.jsonl"));
  let overlapStemm = 0;
  const seenCipher = new Set();
  for (const c of cipherList) {
    const id = Number(c.id);
    if (seenCipher.has(id)) continue;
    seenCipher.add(id);
    const b = books.get(id);
    const locc = b ? b.locc : [];
    const stemmClasses = locc.filter(isStemmClass);
    const field = b && stemmClasses.length ? fieldOf(b.locc, b.subjects, b.bookshelves) : null;
    let dates = null;
    if (field) {
      overlapStemm++;
      const d = dateRecord(b, wdFor(id), rdf[String(id)] || null, false);
      dates = { year: d.primary.year ?? null, year_lo: d.primary.year_lo ?? null, year_hi: d.primary.year_hi ?? null, date: d.primary.date ?? null, date_precision: d.primary.precision, date_basis: d.primary.basis, date_evidence: d.evidence, date_notes: d.notes };
    }
    const textPath = join(CIPHER_TEXTS, `${id}.txt`);
    overlap.write({
      id, cipher_q: c.q || null, cipher_title: c.title, cipher_author: c.author, cipher_year: c.year ?? null, cipher_links: c.links ?? null, language: c.language,
      in_pg_catalog: !!b, pg_title: b ? b.title.split("\n")[0] : null, locc, subjects: b ? b.subjects : [],
      stemm: !!field, stemm_classes: stemmClasses, field: field ? field.field : null, field_class: field ? field.field_class : null,
      ...(dates || {}),
      cipher_text_path: existsSync(textPath) ? textPath : null,
      gutenberg_issued: b ? b.issued : null,
    });
  }
  await overlap.close();

  // ── manifest + format
  const stateFailures = Object.entries(state).filter(([, s]) => s.status !== "ok").map(([id, s]) => ({ id: Number(id), status: s.status, tried: s.tried, letter_ratio: s.letter_ratio ?? null }));
  writeManifest(OUT, {
    source: "Project Gutenberg — STEMM shelf (LoCC Q*, R*, T* except TX/TT) + dated science-periodical issues",
    urls: {
      mirror: MIRROR, texts: `${MIRROR}/<d>/<d>/.../<id>/<id>-0.txt | <id>.txt | <id>-8.txt (fallback ${MIRROR}/cache/epub/<id>/pg<id>.txt)`,
      rdf_catalogue: RDF_TARBALL, wikidata_sparql: SPARQL, catalogue_csv: `${MIRROR}/cache/epub/feeds/pg_catalog.csv (local copy ${CATALOG_CSV}, sha256 ${catalogSha})`,
    },
    license: `Per record (catalog.jsonl license / pg_rights, from Gutenberg's own RDF dcterms:rights): ${stats.by_license[LICENSE] || 0} texts "${LICENSE}" (text_export_allowed true), ${stats.text_export_blocked} not public domain (text_export_allowed false: ${out.filter((r) => !r.text_export_allowed).map((r) => r.id).join(", ") || "none"}) — copyrighted works Gutenberg distributes with the rights holder's permission (terms inside each text); the app must not export or share their text. Gutenberg header/licence present only where the mirror's file has it (pg_boilerplate). Wikidata facts: CC0.`,
    attribution: "Texts from Project Gutenberg (www.gutenberg.org) via the gutenberg.pglaf.org mirror; dates and sitelinks from Wikidata (CC0); download counts and MARC 260/906 notes from Project Gutenberg's RDF catalogue.",
    script: SCRIPT,
    method: [
      "Parse pg_catalog.csv (Cipher's local copy); keep Type=Text, Language exactly en|fr|es, any LoCC class Q*/R*/T* except TX/TT; plus AP-classed issues whose Subjects say 'Science -- Periodicals' or 'Technology -- Periodicals' (Popular Science Monthly) and no 'Literature' subject.",
      "Rows whose Subjects contain '-- Periodicals' are periodical issues; they are kept only when the title states a day or month issue date (date_basis title-stated).",
      "Stream rdf-files.tar.bz2 once from the mirror for download counts, plain-text file sizes and MARC 260/906 original-publication notes.",
      `Wikidata SPARQL, batches of ≤${BATCH} ebook IDs (VALUES on P2034 strings), three small queries per batch (item+sitelinks+P31+P123; item P577 with precision and rank; P629 work + work sitelinks + work P577), plus one P50-author query over the ebooks that have an item, one query at a time, ${WIKIDATA_PAUSE_MS} ms apart, cached. An item whose P50 authors share no surname with anyone Gutenberg credits is rejected as a wrong link (no date, work, sitelinks or qid taken from it).`,
      "Date precedence: title-stated > gutenberg-marc906 > wikidata-P577 > wikidata-work-P577 > author-lifetime-estimate > unknown (MARC 906 first because it is the printed source Gutenberg transcribed, while P2034-linked Wikidata items are often the work and carry its first-publication date); every piece of evidence kept in date_evidence. gutenberg_issued (release date) is never used as a publication date.",
      "One primary field per book from its first STEMM LoCC class (computing decided from Subjects because the CSV holds no QA75-76 subclass).",
      `Books: drop >${MAX_BYTES} B files; one edition per work (title+language+first-author key, and Wikidata P629 work); ≤2 volumes of a multi-volume work; skip works Cipher already holds; per-field quota (≥${FIELD_MIN} where available, rest ∝ √availability, total ${BOOK_TARGET}); inside a field, best score first while keeping period bins balanced; French/Spanish books placed first by score, capped at ${Math.round(NON_EN_SHARE * 100)} % of the book target and at 25 % of any field's quota; short (<30 KB) texts only to bring a field up to its minimum.`,
      `Score = 2·log2(1+max(item,work sitelinks)) + log10(1+downloads) + 1 if dated by a stated source (−1.5 if undated) + 0.5 if ≥30 KB; a QID whose date precedes the credited author's birth contributes no sitelinks.`,
      `Periodicals: ≤${PERIODICAL_CAP} issues. Headline series first (${HEADLINE.join(', ')}; ≤${PER_SERIES_CAP} issues each, spread evenly over each series' dates), then rounds of one issue per remaining series, largest series first.`,
      `Download raw bytes from the mirror (${MIRROR_PAUSE_MS} ms pause), Cipher's variant order <id>-0.txt, <id>.txt, <id>-8.txt then cache/epub/<id>/pg<id>.txt; files ≤5000 B treated as missing (Cipher's rule); texts whose body is <${MIN_LETTER_RATIO * 100}% letters are rejected as tables and replaced by the next candidate.`,
    ],
    selection_criteria: { languages: [...LANGUAGES], locc_included: "Q*, R*, T* (excluding TX, TT)", fields: FIELDS, book_target: BOOK_TARGET, field_min: FIELD_MIN, quotas: quota, availability_long_unique: avail, availability_unique_incl_short: availShort, periodical_cap: PERIODICAL_CAP, per_series_cap: PER_SERIES_CAP, non_en_cap: nonEnCap, min_bytes: MIN_BYTES, max_bytes: MAX_BYTES, period_bin_weights: BIN_WEIGHT, min_letter_ratio: MIN_LETTER_RATIO },
    counts: { ...counts, skipped: skips, catalog_records: out.length, cipher_overlap_records: seenCipher.size, cipher_overlap_stemm: overlapStemm, new_downloads_this_run: newDownloads, limit_hit: limitHit, plan_only: PLAN_ONLY, ...stats },
    coverage: {
      year_min: Math.min(...out.map((r) => r.year_lo ?? Infinity)), year_max: Math.max(...out.map((r) => r.year_hi ?? -Infinity)),
      undated: out.filter((r) => r.date_basis === "unknown").length,
      estimated_only: out.filter((r) => r.date_basis === "author-lifetime-estimate").length,
      date_disagreement_over_5y: out.filter((r) => r.date_disagreement_years > 5).length,
    },
    caveats: [
      "gutenberg_issued is the Project Gutenberg release date, never a publication date.",
      "author-lifetime-estimate dates are ranges derived from the first credited author's life dates (birth+20 … min(death, Gutenberg release year)); 'year' is the rule's point estimate min(birth+40, death), not evidence. For translations it reflects the original author, not the translation.",
      "wikidata-P577 may describe the work rather than the specific edition Gutenberg transcribed; gutenberg-marc906 (when present) is the year of the printed source PG catalogued and therefore wins. Both are kept in date_evidence; date_disagreement_years flags spreads (first publication vs. later edition/translation).",
      "Wikidata P577 rejected when the item's publisher is Project Gutenberg or the date is 1971+ and not before the Gutenberg release (it is then the ebook release), and when it precedes the credited author's birth. An item whose P50 authors match none of the credited people, or whose P577 precedes the author's birth, is treated as a wrong P2034 link: it lends no date, work, sitelinks or qid (it stays in qids_all; see date_notes). Wikidata P2034 links are sparse for STEMM books, so most dates come from MARC 906 or lifetime estimates.",
      "Wikidata decade/century precision is reported as date_precision 'range' with year null.",
      "Field is a single primary label from the first STEMM LoCC class; many books span fields. pg_catalog.csv LoCC holds only class letters, so QA75-76 is approximated by computing Subjects.",
      `Texts are the raw files exactly as the mirror serves them. ${stats.by_boilerplate["markers-only"] || 0} of them (mostly <id>-0.txt from the mirror's ebook folders) carry only the '*** START/END OF THE PROJECT GUTENBERG EBOOK' lines, without the Gutenberg header or licence text; ${(stats.by_boilerplate["header+licence"] || 0) + (stats.by_boilerplate.header || 0)} carry the header (see pg_boilerplate). Encoding varies: see encoding/declared_encoding; -8.txt files are 8-bit (ISO-8859-1/Windows-1252), -0.txt UTF-8.`,
      `${out.length - (stats.by_license[LICENSE] || 0)} texts are not public domain: Gutenberg's rights statement says 'Copyrighted' (Internet guides of the 1990s-2000s, Marie Lebert's essays, a few modern books); they are redistributable only under the notice inside each text. text_export_allowed is false for them: the app may read and index them but must block exporting or sharing their text. Filter on text_export_allowed (or license/pg_rights) if only public-domain texts are wanted.`,
      "Periodical issue dates come from the first title line (the issue designation); a subtitle date is read only when that line has none; a number after No./Vol. is never a day. A two-month issue ('March-April 1916') is dated as the month range '1916-03/1916-04' (date_precision 'month-range', note in date_notes); a title naming a span of several months is a volume, not an issue, and is skipped.",
      "Cipher's 693 books are not duplicated here; cipher-overlap.jsonl marks the STEMM ones, whose texts live in Cipher's folder (re-encoded to UTF-8 by Cipher's script).",
      "Selection favours Wikidata-notable and downloaded works, so it is not a random sample of Gutenberg's STEMM holdings; Gutenberg itself skews to English, 1850-1928 and US/UK publications.",
      "Popular Science Monthly issues are LoCC AP (not STEMM); they were admitted by the explicit science-periodical rule and labelled general-science. Periodical fields follow LoCC literally: Scientific American and its Supplement are LoCC T, hence engineering-technology, although they cover all sciences.",
      `${skips["no plain-text file in Gutenberg's RDF (PDF/TeX/HTML-only ebook)"] || 0} otherwise-eligible ebooks exist on Gutenberg only as PDF/TeX/HTML (no .txt), mostly mathematics and physics; they were skipped, so mathematics is smaller and leans to prose (history, philosophy, popular works) rather than formula-heavy treatises.`,
      `Fields whose quota could not be met from English ≥30 KB texts: ${FIELDS.filter((f) => counts.field_selection?.[f] && !counts.field_selection[f].quota_met).map((f) => `${f} (${got[f]}/${quota[f]})`).join(", ") || "none"}. Computing texts are mostly 1990s-2000s Internet guides and manuals whose authors carry no life dates, so many are undated.`,
      `Wikidata links (P2034) exist for only ${Object.keys(wdRaw).length} of ${wdIds.length} queried ebooks; sitelinks are null for the rest. 'downloads' is Gutenberg's recent (~30-day) count at fetch time, not all-time popularity.`,
      `Body offsets: body_start_byte follows the complete START marker even when its title wraps onto further lines (${stats.start_marker_wrapped} files); body_end_byte excludes Gutenberg's 'End of the Project Gutenberg EBook of …' closing line (${stats.end_of_ebook_line_excluded} files); old releases without markers are bounded by their '*END*THE SMALL PRINT' header and closing line (body_bounds: ${JSON.stringify(stats.by_body_bounds)}). ${stats.credits_at_body_start} slices still begin with producer/transcriber credits (body_residue 'credits-at-start'), and ${stats.by_boilerplate["markers-only"] || 0} files have no Gutenberg header (markers only) — the importer must strip credits and must not expect header metadata in the file (FORMAT.md 'Gutenberg residue').`,
      "Field quotas cap biology, medicine and engineering far below what Gutenberg holds (see selection_criteria.availability_long_unique); re-running with a larger BOOK_TARGET extends the shelf without re-downloading anything.",
    ],
    revisions: REVISIONS.map((r) => ({ ...r, before: REVISION_BEFORE[r.date] || null })),
    // download failures and rejections across all runs (from the download state), plus this run's Wikidata failures
    failures: [...failures.filter((f) => f.stage !== "download"), ...stateFailures],
  });
  writeFileSync(join(OUT, "FORMAT.md"), FORMAT_MD({
    records: out.length, exportAllowed: stats.text_export_allowed, exportBlocked: stats.text_export_blocked,
    markersOnly: stats.by_boilerplate["markers-only"] || 0, startWrapped: stats.start_marker_wrapped, endLineExcluded: stats.end_of_ebook_line_excluded,
    credits: stats.credits_at_body_start, noBounds: out.filter((r) => r.body_residue.includes("no-bounds")).length,
    byBounds: Object.entries(stats.by_body_bounds).map(([k, v]) => `${k} ${v}`).join(", "),
  }));
  log(`catalog: ${out.length} records (${JSON.stringify(stats.by_kind)}), languages ${JSON.stringify(stats.by_language)}`);
  log(`fields ${JSON.stringify(stats.by_field)}`);
  log(`date basis ${JSON.stringify(stats.by_basis)} periods ${JSON.stringify(stats.by_period)}`);
  console.log(`DONE ${SOURCE}: ${out.length} records, ${newDownloads} new downloads${limitHit ? " (limit hit — re-run to continue)" : ""}${PLAN_ONLY ? " (plan only)" : ""}`);
}

// What changed between published builds, and why (copied into MANIFEST.revisions and FORMAT.md).
const REVISIONS = [
  {
    date: "2026-10-04",
    why: "Fixes for the defects found by the 2026-10-04 audits of the build written 2026-10-04 00:42 UTC (704 records), whose outputs were also stale relative to the script (it had gained pg_rights, pg_boilerplate and the P50 author check after that run). This build re-runs the script; texts already on disk are reused.",
    changes: [
      "Licence from Gutenberg's own RDF dcterms:rights (pg_rights): the old build said 'Public domain in the USA' for 20 texts Gutenberg marks Copyrighted (34, 39, 49, 56, 80, 118, 250, 254, 729, 929, 5768, 6527, 27028, 27030, 27032, 27098, 30422, 41814, 54360, 55002). New boolean text_export_allowed (true only for 'Public domain in the USA') so the app can block exporting/sharing the text of the others.",
      "Wikidata items whose P50 authors share no surname with anyone Gutenberg credits are rejected as wrong P2034 links (no qid, work, sitelinks, date or score from them; QID kept in qids_all, reason in date_notes). PG 1708 (Williams, A History of Science, Vol. 4) was matched to Q1245187, an unrelated literary work.",
      "Title-stated issue dates: an issue/volume number is never read as a day ('No. 4 April 1888' → 1888-04, 'No. 1 / January, 1897' → 1897-01); the issue designation (first title line) wins over subtitle dates ('Dec. 1910 / Address … June 21st, 1910' → 1910-12); a span of several months is a volume, not an issue (42128 'April-October 1850' is no longer a dated periodical issue); two-month issues are dated as a two-month range (date 'YYYY-MM/YYYY-MM', date_precision 'month-range': 39854, 59611, 63005); 'November 19,1887' (no space after the comma) is now read. 'Scientific American, … Supplement. No. 404' is in the Supplement series.",
      "Body offsets recomputed from the files on every run: body_start_byte now follows the complete START marker when its title wraps onto further lines (33 files in the old build began with the marker's tail); body_end_byte now excludes Gutenberg's own 'End of the Project Gutenberg EBook of …' / 'End of Project Gutenberg's …' line (387 files); 3 old releases without START/END markers get bounds from their '*END*THE SMALL PRINT' header and closing line. body_bounds says how; body_residue flags what Gutenberg material can remain (credits).",
      "FORMAT.md documents the residue that remains and that markers-only files (no Gutenberg header) still have correct bounds.",
    ],
  },
];

// FORMAT.md is written from here so the documentation always travels with the script.
// Counts of the build each revision replaced (for before/after comparison with MANIFEST.counts).
const REVISION_BEFORE = {
  "2026-10-04": {
    built_at: "2026-10-04T00:42:31Z", catalog_records: 704, by_kind: { book: 584, "periodical-issue": 120 }, by_language: { en: 626, fr: 69, es: 9 },
    by_basis: { "title-stated": 120, "gutenberg-marc906": 234, "wikidata-P577": 58, "wikidata-work-P577": 6, "author-lifetime-estimate": 226, unknown: 60 },
    license_public_domain_claimed: 704, actually_copyrighted: 20, wrong_wikidata_links_kept: "PG 1708 → Q1245187", wrong_title_dates: [58951, 30221, 18795, 42128, 39854, 59611, 63005],
    body_start_inside_wrapped_marker: 33, body_slices_ending_with_end_of_ebook_line: 387, files_without_markers: 3, markers_only_files: 426,
  },
};

const FORMAT_MD = (k) => `# gutenberg-stemm — output format

Produced by \`tools/fetch/gutenberg-stemm.mjs\` (Scrolls repo). Everything in this folder is
regenerated by re-running the script; texts already on disk are never re-downloaded.

Project Gutenberg's STEMM shelf: science, technology, engineering, mathematics and medicine
books (LoCC classes Q\\*, R\\*, T\\* except TX cooking and TT handicrafts) in English,
French and Spanish, plus dated issues of science periodicals (Scientific American, its
Supplement, Popular Science Monthly, Birds and Nature …). Cipher's 693 literature books are NOT
repeated here; \`cipher-overlap.jsonl\` says which of them are STEMM.

Rights: ${k.exportAllowed} of the ${k.records} texts are "Public domain in the USA" by Gutenberg's own rights
statement; ${k.exportBlocked} are copyrighted works Gutenberg distributes with the rights holder's permission
(\`text_export_allowed: false\` — the app must not let users export or share their text).

| File | What it is |
|---|---|
| \`catalog.jsonl\` | One JSON object per line, one line per selected text (books and periodical issues). Sorted by \`id\`. |
| \`texts/<id>.txt\` | Exactly one file per catalogue record (texts downloaded earlier but no longer selected are parked in the fetch cache, not here). The raw file exactly as served by the Gutenberg mirror (bytes untouched: original line endings, original encoding). Whatever Gutenberg boilerplate the mirror's file has is kept, but ${k.markersOnly} files (the mirror's \`<id>-0.txt\` copies) have only the \`*** START/END OF THE PROJECT GUTENBERG EBOOK\` lines and no header or licence text: see \`pg_boilerplate\` and *Gutenberg residue* below. \`sha256\` and \`bytes\` in the catalogue refer to this file. |
| \`cipher-overlap.jsonl\` | One line per distinct ebook id in Cipher's \`texts/gutenberg.json\` (691 distinct ids; the list has 693 entries, 2 ids repeat), with STEMM marking. |
| \`MANIFEST.json\` | Provenance: URLs, licence, method, selection criteria, counts, coverage, caveats, failures. |
| \`FORMAT.md\` | This file. |
| \`fetch.log\` | Log of the last run (not data). |

## Conventions

- Years are plain integers; **negative = BCE** (\`-300\` = 300 BCE, as Wikidata and Gutenberg's
  "300 BCE" both mean it). No astronomical year-zero conversion is applied.
- \`null\` always means "not known / not applicable". Nothing is filled in by guesswork: when a
  value is not stated by a source it is \`null\`, never a default.
- Dates come with a **basis** (where the date comes from) and a **precision**. The Gutenberg
  release date (\`gutenberg_issued\`) is kept separately and is **never** a publication date.
- Byte offsets (\`body_start_byte\`, \`body_end_byte\`) index into the raw bytes of \`texts/<id>.txt\`.

## catalog.jsonl

| Field | Type | Null? | Meaning / provenance |
|---|---|---|---|
| \`id\` | integer | no | Project Gutenberg ebook number (\`Text#\` in pg_catalog.csv). Unique. |
| \`kind\` | \`"book"\` \\| \`"periodical-issue"\` | no | \`periodical-issue\` = a row whose Subjects contain "-- Periodicals" (or an AP-classed science periodical) and whose title states a day or month issue date. Everything else is \`book\`. |
| \`title\` | string | no | First line of the Gutenberg title. |
| \`title_full\` | string | no | Full Gutenberg title; subtitle lines joined with \`\\n\` (CR removed). |
| \`language\` | \`"en"\` \\| \`"fr"\` \\| \`"es"\` | no | pg_catalog.csv \`Language\` (only single-language rows were taken). |
| \`authors\` | array of objects | no (may be \`[]\`) | Parsed from pg_catalog.csv \`Authors\`, in catalogue order. See *authors[]* below. |
| \`locc\` | string[] | no | Library of Congress classes as Gutenberg lists them (1–2 letters, e.g. \`"QH"\`; never subclasses like QA76). |
| \`subjects\` | string[] | no | Gutenberg LCSH subjects. |
| \`bookshelves\` | string[] | no | Gutenberg bookshelves (including "Category: …" entries). |
| \`field\` | string | no | One primary field, see *Fields*. |
| \`field_class\` | string | no | The LoCC class the field was derived from (\`"AP"\` for Popular-Science-Monthly-type periodicals). |
| \`field_rule\` | string | no | Human-readable rule that produced \`field\`. |
| \`series\` | string \\| null | periodicals only | Normalised periodical series name used for balancing (e.g. \`"scientific american supplement"\`); \`null\` for books. |
| \`year\` | integer \\| null | yes | Point year of the primary date. For \`range\` precision from \`author-lifetime-estimate\` this is the rule's point estimate (min(birth+40, death)), **not evidence**. \`null\` for Wikidata decade/century ranges and for \`unknown\`. |
| \`year_lo\` | integer \\| null | yes | Earliest plausible year (inclusive). Equals \`year\` for day/month/year precision. \`null\` only when \`date_basis\` is \`unknown\`. |
| \`year_hi\` | integer \\| null | yes | Latest plausible year (inclusive). |
| \`date\` | string \\| null | yes | ISO date at the stated precision: \`"YYYY-MM-DD"\` (day), \`"YYYY-MM"\` (month), \`"YYYY-MM/YYYY-MM"\` (month-range: an ISO 8601 interval of two consecutive months, for two-month periodical issues), \`"YYYY"\` (year); \`null\` for \`range\` and \`unknown\`. Negative years appear as e.g. \`"-300"\`. |
| \`date_precision\` | \`"day"\` \\| \`"month"\` \\| \`"month-range"\` \\| \`"year"\` \\| \`"range"\` \\| \`"unknown"\` | no | Precision of the primary date. \`month-range\`: a two-month issue ("March-April 1916" → \`date\` \`"1916-03/1916-04"\`, \`year\` = the first month's year, \`year_lo\`/\`year_hi\` the years of the two months). |
| \`date_basis\` | see *Date bases* | no | Source of the primary date. |
| \`date_evidence\` | array of objects | no (may be \`[]\`) | **All** date evidence found, best first (same precedence as below). Each: \`{basis, date, year, year_lo, year_hi, precision, raw, qid?, wikidata_precision?}\`; \`raw\` is the source string (Wikidata timeValue, MARC 906 value, matched title text, or \`"author <name>"\` for lifetime estimates). The first element (if any) is the primary date. |
| \`date_disagreement_years\` | integer | no | Spread in years between the \`year_lo\` values of all *stated* evidence (everything except author-lifetime-estimate). 0 when there is one or no stated date. A large spread usually means the work's first publication vs. the edition Gutenberg transcribed. |
| \`date_notes\` | string[] | no | Why some evidence was rejected (e.g. a Wikidata P577 that is really the ebook release date, or a Wikidata item that is another work) or not parsed, and how a two-month periodical issue was dated. |
| \`qid\` | string \\| null | yes | Wikidata item whose P2034 (Project Gutenberg ebook ID) equals \`id\`; if several, the one with most sitelinks. \`null\` also when that link was rejected as pointing at another work (its P50 authors match none of the people Gutenberg credits, or its P577 precedes the author's birth); the QID then stays only in \`qids_all\` and \`date_notes\` says why. |
| \`qids_all\` | string[] | no | All such items (usually 0 or 1). |
| \`sitelinks\` | integer \\| null | yes | Wikimedia sitelink count of \`qid\` (prominence). \`null\` when no (accepted) item. |
| \`work_qid\` | string \\| null | yes | Work the item is an edition of (P629), most-sitelinked if several. |
| \`work_sitelinks\` | integer \\| null | yes | Sitelink count of \`work_qid\`. |
| \`downloads\` | integer \\| null | yes | Gutenberg download count from the RDF catalogue (\`pgterms:downloads\`, a recent 30-day figure) at fetch time. |
| \`marc260\` | string \\| null | yes | Gutenberg's MARC 260 imprint of the printed source (raw, e.g. \`"  $aNew York :$bJ. Wiley, $c1890."\`). Present mostly for recent releases. |
| \`gutenberg_issued\` | string \\| null | yes | Gutenberg release date \`"YYYY-MM-DD"\` (pg_catalog.csv \`Issued\`). NOT a publication date. |
| \`file\` | string | no | Path relative to this folder: \`"texts/<id>.txt"\`. |
| \`bytes\` | integer | no | Size of the raw file. |
| \`sha256\` | string | no | Hex SHA-256 of the raw file. |
| \`source_url\` | string \\| null | yes | Mirror URL actually fetched (\`null\` only if the download state was rebuilt from a file already on disk). |
| \`source_variant\` | string \\| null | yes | Which file variant: \`"<id>-0.txt"\` (UTF-8), \`"<id>.txt"\` (ASCII or legacy 8-bit), \`"<id>-8.txt"\` (8-bit, ISO-8859-1), or \`"pg<id>.txt (generated)"\`. |
| \`encoding\` | \`"ascii"\` \\| \`"utf-8"\` \\| \`"8-bit (not valid UTF-8)"\` | no | Detected from the bytes: pure 7-bit ASCII; valid UTF-8; otherwise 8-bit (decode as ISO-8859-1 / Windows-1252). |
| \`declared_encoding\` | string \\| null | yes | The "Character set encoding:" line of the Gutenberg header, verbatim, if present. |
| \`body_start_byte\` | integer \\| null | yes | Byte offset just after the complete \`*** START OF THE/THIS PROJECT GUTENBERG EBOOK <title> ***\` marker — after the line holding its closing \`***\` when the title wraps onto further lines (${k.startWrapped} files). Old releases without the marker: just after the \`*END*THE SMALL PRINT! …*END*\` line. \`null\` when neither exists. Recomputed from the file on every run. |
| \`body_end_byte\` | integer \\| null | yes | Byte offset of the start of the line containing \`*** END OF THE/THIS PROJECT GUTENBERG …\`, moved back to the start of Gutenberg's own closing line \`End of the Project Gutenberg EBook of …\` / \`End of Project Gutenberg's …\` when that (with at most two wrapped continuation lines) is the last text before the marker (${k.endLineExcluded} files); for old releases without the marker, the start of that closing line. \`null\` if none is found. The work's text is \`bytes[body_start_byte, body_end_byte)\`. |
| \`body_bounds\` | \`"start-end-markers"\` \\| \`"small-print-header"\` \\| \`"end-line-only"\` \\| null | yes | How the bounds were found: the standard markers, an old release's SMALL PRINT header (+ closing line), or only a closing line. |
| \`body_residue\` | string[] | no | Gutenberg material that can remain INSIDE the body slice: \`"credits-at-start"\` = producer/transcriber credits ("Produced by …", "E-text prepared by …") in the first lines (${k.credits} files); \`"no-bounds"\` = no start bound, the slice starts at byte 0. See *Gutenberg residue*. |
| \`letter_ratio\` | number | no | Letters / non-whitespace characters inside the body (0–1). Texts below 0.5 were rejected as tables; low values (0.5–0.7) mean formula- or table-heavy text. |
| \`downloaded_at\` | string | no | ISO timestamp of the download. |
| \`priority_score\` | number | no | Selection score (see MANIFEST.method). For transparency only. |
| \`period_bin\` | string | no | \`"<1700"\`, \`"1700-1799"\`, \`"1800-1849"\`, \`"1850-1874"\`, \`"1875-1899"\`, \`"1900-1928"\`, \`">1928"\`, \`"unknown"\` — from \`year\`, or the midpoint of \`year_lo..year_hi\`. Used for period balancing. |
| \`below_30kb\` | boolean | no | True when the text is shorter than 30 KB (only admitted to bring a small field up to its minimum; periodical issues may be short). |
| \`pg_boilerplate\` | \`"header+licence"\` \\| \`"header"\` \\| \`"licence"\` \\| \`"markers-only"\` | no | Which Gutenberg boilerplate the raw file carries OUTSIDE the body: the Gutenberg header before the START marker and/or the licence text after the END marker (old releases: the SMALL PRINT block), or only the START/END marker lines. |
| \`pg_rights\` | string \\| null | yes | Gutenberg's own rights statement for the ebook (RDF \`dcterms:rights\`), verbatim: \`"Public domain in the USA."\` or \`"Copyrighted. Read the copyright notice inside this book for details."\`. |
| \`license\` | string | no | From \`pg_rights\`: \`"Public domain in the USA (Project Gutenberg)"\`, or \`"Copyrighted (distributed by Project Gutenberg with the rights holder's permission; terms in the copyright notice inside the text)"\`. |
| \`text_export_allowed\` | boolean | no | \`true\` only when \`pg_rights\` says "Public domain in the USA". \`false\` for copyrighted texts (and if Gutenberg stated no rights): the app may read, index and quote them for study but must block exporting or sharing the text. |

### authors[]

| Field | Type | Null? | Meaning |
|---|---|---|---|
| \`name\` | string | no | Name as Gutenberg writes it, usually inverted (\`"Darwin, Charles"\`), with life dates and role removed. |
| \`birth\` | integer \\| null | yes | Birth year from the catalogue string (negative = BCE). \`null\` when absent. |
| \`death\` | integer \\| null | yes | Death year; \`null\` when absent (living, unknown, or only "active"). |
| \`role\` | string \\| null | yes | Bracketed role from the catalogue (\`"Editor"\`, \`"Translator"\`, \`"Illustrator"\`, \`"Contributor"\`, …); \`null\` = author. |
| \`birth_approx\` / \`death_approx\` | \`true\` | optional | Present when the catalogue marks the year with \`?\`. |
| \`active\` | string | optional | Floruit text when Gutenberg gives \`active 1850-1890\` instead of life dates. |
| \`raw\` | string | no | The original catalogue string for this person. |

### Date bases (\`date_basis\`, \`date_evidence[].basis\`)

Precedence for the primary date (first available wins):

1. \`title-stated\` — periodical issues only: an exact issue date in the Gutenberg title
   ("…, No. 275, April 9, 1881" → day; "Appletons' Popular Science Monthly, December 1898" →
   month). Year-only titles are never used. The first title line (the issue designation) is read
   first, subtitle lines only when it has no date ("Vol. LXX, Dec. 1910 / Address … June 21st,
   1910" → 1910-12); a number after "No."/"Vol." is never a day ("No. 4 April 1888" → month); a
   two-month issue ("March-April 1916") is dated as the month range \`1916-03/1916-04\`
   (precision \`month-range\`, with a note); a span of several months ("April-October 1850") is a
   volume, not an issue, and is skipped.
2. \`gutenberg-marc906\` — the original-publication year Gutenberg's catalogers recorded for the
   printed source they transcribed (\`pgterms:marc906\` in the RDF; mostly releases since ~2019).
   Year precision (\`"189-"\` style values become a decade \`range\`). Ranked above Wikidata because
   it dates the edition whose text is in the file (a translation, a later edition).
3. \`wikidata-P577\` — publication date (P577) on the Wikidata item that carries this ebook's
   P2034. Preferred rank wins, else the earliest normal-rank value; deprecated values ignored.
   Often the *work's* first publication rather than the transcribed edition. Rejected (reason in
   \`date_notes\`) when: the item's publisher (P123) is Project Gutenberg, or the value is 1971+ and
   not before the Gutenberg release (ebook release dates); it precedes the birth of the credited
   author (the P2034 link points at another work, e.g. a biography of Kepler linked to Kepler's
   own 1619 book — that QID then lends nothing at all: no qid, work or sitelinks); or it is 1929+
   and more than 30 years after the credited author's death (a modern edition). An item whose P50
   authors share no surname with anyone Gutenberg credits is likewise rejected outright (e.g. PG
   1708, Williams's *A History of Science*, carried on Wikidata by Byron's *Don Juan*).
4. \`wikidata-work-P577\` — P577 of the work the item is an edition of (P629 → P577): the work's
   first publication, not necessarily this edition. Same birth check as above.
5. \`author-lifetime-estimate\` — range \`[birth+20, min(death, release year)]\` of the first credited
   author (no role, or role "Author") who has a birth year; when no death year is known the upper
   bound is the Gutenberg release year (a text cannot appear after its release — a bound, not a date).
   \`year\` = min(birth+40, death), clamped into the range. Always precision \`range\`.
   An estimate, not evidence; for translations it reflects the original author.
6. \`unknown\` — none of the above; \`year\`, \`year_lo\`, \`year_hi\`, \`date\` are \`null\`.

Wikidata precision mapping: 11 → \`day\`, 10 → \`month\`, 9 → \`year\`, 8 (decade) / 7 (century) /
6 (millennium) → \`range\` with \`year: null\`; decade 1850 → 1850–1859, century/millennium by the
Wikibase ordinal convention (19th century = 1801–1900).

### Fields (\`field\`)

| Value | Rule (first STEMM LoCC class of the book, in catalogue order) |
|---|---|
| \`mathematics\` | QA (unless computing) |
| \`computing\` | QA, T or TK **and** a computing subject/bookshelf (computers, programming, software, Internet, World Wide Web, electronic data processing, hackers, named machines …). pg_catalog.csv has no QA75–76 subclass, so this is subject-based. |
| \`physics\` | QC |
| \`chemistry\` | QD, TP |
| \`astronomy\` | QB |
| \`earth-sciences\` | QE |
| \`biology\` | QH, QK, QL, QM, QP, QR (biology / natural history, botany, zoology, anatomy, physiology, microbiology) |
| \`medicine\` | R, RA–RZ |
| \`engineering-technology\` | T, TA–TN, TR, TS (TX, TT excluded from the shelf) |
| \`general-science\` | Q (general science); also AP-classed science periodicals (Popular Science Monthly) |

## cipher-overlap.jsonl

One line per distinct id in Cipher's \`texts/gutenberg.json\`.

| Field | Type | Null? | Meaning |
|---|---|---|---|
| \`id\` | integer | no | Gutenberg ebook number. |
| \`cipher_q\` | string \\| null | yes | Cipher's Wikidata QID for the book (\`""\` in Cipher becomes \`null\`). |
| \`cipher_title\`, \`cipher_author\` | string | no | As in Cipher's list. |
| \`cipher_year\` | integer \\| null | yes | Cipher's year — may be a Wikidata year or an author-birth+40 estimate; Cipher does not say which. |
| \`cipher_links\` | integer \\| null | yes | Cipher's sitelink count. |
| \`language\` | string | no | Cipher's language code. |
| \`in_pg_catalog\` | boolean | no | Whether the id exists in pg_catalog.csv. |
| \`pg_title\` | string \\| null | yes | First line of the Gutenberg title. |
| \`locc\`, \`subjects\` | string[] | no | From pg_catalog.csv. |
| \`stemm\` | boolean | no | True when any LoCC class is Q\\*/R\\*/T\\* other than TX/TT. |
| \`stemm_classes\` | string[] | no | Those classes. |
| \`field\`, \`field_class\` | string \\| null | yes | Same mapping as the catalogue; \`null\` when not STEMM. |
| \`year\`, \`year_lo\`, \`year_hi\`, \`date\`, \`date_precision\`, \`date_basis\`, \`date_evidence\`, \`date_notes\` | as in catalog.jsonl | present only when \`stemm\` | Dates computed by this script's rules (Wikidata/MARC/lifetime), independent of \`cipher_year\`. |
| \`cipher_text_path\` | string \\| null | yes | Absolute path of Cipher's copy (\`…/Cipher/Tools/data/culture/texts/gutenberg/<id>.txt\`), \`null\` if missing. Cipher re-encoded these to UTF-8 (its \`-8.txt\` fallbacks were decoded as Latin-1), so they are not byte-identical to Gutenberg. |
| \`gutenberg_issued\` | string \\| null | yes | Gutenberg release date (not publication). |

## Reading a text

\`\`\`js
const raw = readFileSync(\`texts/\${rec.id}.txt\`);
const bytes = raw.subarray(rec.body_start_byte ?? 0, rec.body_end_byte ?? raw.length);
const text = new TextDecoder(rec.encoding === "8-bit (not valid UTF-8)" ? "windows-1252" : "utf-8").decode(bytes);
\`\`\`

Keep \`raw\` as the preserved original; offsets of passages should be recorded against the decoded
text you store, together with \`sha256\` of the raw file they came from.

## Gutenberg residue (what the importer must still strip)

The body slice excludes the Gutenberg header, the START/END marker lines (including a START
marker whose title wraps onto 1–3 further lines — ${k.startWrapped} files in this build) and
Gutenberg's own closing line "End of the Project Gutenberg EBook of …" / "End of Project
Gutenberg's …" (${k.endLineExcluded} files). Anyone reading the RAW file instead of the slice must
strip all of these, matching:

- start: \`/\\*\\*\\*\\s*START OF (THE|THIS) PROJECT GUTENBERG[\\s\\S]*?\\*\\*\\*/i\` (the title between the
  stars can contain line breaks) — or, for old releases, everything up to the \`*END*THE SMALL PRINT\` line;
- end: the last line-initial \`/End of (the )?Project Gutenberg/i\` and everything after it, or the
  \`*** END OF … PROJECT GUTENBERG\` line and everything after it.

What can REMAIN inside the slice and should be stripped when building reading text:

- producer/transcriber credits in the first lines ("Produced by …", "E-text prepared by …",
  "Transcribed from …") — flagged \`body_residue: ["credits-at-start"]\` (${k.credits} files);
- transcriber's notes and Gutenberg-added cover/illustration placeholders inside the text (not flagged).

${k.markersOnly} files have no Gutenberg header at all (\`pg_boilerplate: "markers-only"\`, the mirror's
\`<id>-0.txt\` copies): their title, author and encoding are NOT in the file, so take them from this
catalogue; their bounds are still the START/END markers. ${k.noBounds} file(s) have no bounds
(\`body_residue: ["no-bounds"]\`). Bounds by kind: ${k.byBounds}.

## Revisions

${REVISIONS.map((r) => `### ${r.date}\n\n${r.why}\n\n${r.changes.map((c) => `- ${c}`).join("\n")}\n`).join("\n")}
Counts before and after are in MANIFEST.json (\`revisions\`, \`counts\`).
`;

main().catch((error) => {
  console.error(error);
  console.log("DONE with error:", error.message);
  process.exit(1);
});
