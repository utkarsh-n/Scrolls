#!/usr/bin/env node
// OpenAlex fetcher for Scrolls: a budgeted, cached sample of the most-cited STEMM works per
// (field x time bin), with titles, reconstructed abstracts, machine topics/keywords and the
// documented citation links between sampled works.
//
//   node tools/fetch/openalex.mjs                 full run (stops cleanly when the daily budget is low)
//   node tools/fetch/openalex.mjs --max-cells 3   fetch at most 3 new (uncached) cells, then build outputs
//   node tools/fetch/openalex.mjs --offline       no network at all: rebuild outputs from the cache
//   node tools/fetch/openalex.mjs --core-only     only the 16 core STEMM fields (skip the 4 optional ones)
//
// Every 200 response is cached on disk (DATA/cache/http, same layout as lib.mjs, plus a .meta.json
// sidecar with the rate-limit headers), so re-running is free for everything already fetched and
// continues with whatever is still missing. Outputs are rebuilt from the cache on every run.
//
// Budget: anonymous OpenAlex clients get 1,000 credits/day (reset 00:00 UTC); one list request =
// 1 credit. The wrapper reads x-ratelimit-* headers on every response and stops making requests
// when remaining <= STOP_AT, writes what it has, and prints how to resume.
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { DATA, CONTACT, USER_AGENT, log, sourceDir, jsonlWriter, writeManifest } from "./lib.mjs";

const SOURCE = "openalex";
const API = "https://api.openalex.org";
const OUT = sourceDir(SOURCE);
const CACHE = join(DATA, "cache", "http");
const LEDGER = join(OUT, "requests.jsonl");
const SCRIPT = "/path/to/developer/Documents/AI Stuff/Scrolls/tools/fetch/openalex.mjs";
const STOP_AT = 40; // stop making requests when x-ratelimit-remaining <= this
const CONCURRENCY = 3;
const PER_PAGE = 200;
const MAX_AUTHORS = 10;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const OFFLINE = flag("--offline");
const CORE_ONLY = flag("--core-only");
const MAX_CELLS = Number(opt("--max-cells", Infinity));

const TYPES = "article|book|review|book-chapter|preprint";
const SELECT = [
  "id", "doi", "title", "publication_year", "publication_date", "type", "language", "primary_topic",
  "keywords", "cited_by_count", "referenced_works", "referenced_works_count", "authorships",
  "abstract_inverted_index", "primary_location", "open_access", "is_retracted", "is_authors_truncated",
].join(",");

// Names as OpenAlex spells them in /fields (verified against the live list at run time).
const CORE_FIELDS = [
  "Mathematics", "Physics and Astronomy", "Chemistry", "Computer Science", "Engineering",
  "Materials Science", "Energy", "Chemical Engineering", "Earth and Planetary Sciences",
  "Environmental Science", "Medicine", "Biochemistry, Genetics and Molecular Biology", "Neuroscience",
  "Immunology and Microbiology", "Pharmacology, Toxicology and Pharmaceutics", "Nursing",
];
const OPTIONAL_FIELDS = ["Agricultural and Biological Sciences", "Health Professions", "Dentistry", "Veterinary"];

const BINS = [[1665, 1799], [1800, 1849], [1850, 1874], [1875, 1899]];
for (let a = 1900; a <= 2020; a += 5) BINS.push([a, a + 4]);
BINS.push([2025, 2026]);
const binLabel = ([a, b]) => `${a}-${b}`;

// ---------------------------------------------------------------- budgeted, cached GET
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const budget = {
  first: null, // headers snapshot of the first network response this run
  last: null, // headers snapshot of the latest network response this run
  network: 0, // network requests sent this run (any status)
  ok: 0,
  cacheHits: 0,
  creditsUsed: 0, // sum of x-ratelimit-credits-used this run
  costUsd: 0,
  exhausted: false,
  exhaustedReason: null,
};

function buildUrl(path, params) {
  // Values used here only contain URL-safe characters plus ":" "," "|" "/" which OpenAlex accepts raw;
  // keeping them raw makes the cached URLs readable in requests.jsonl / MANIFEST.json.
  const query = Object.entries({ ...params, mailto: CONTACT }).map(([k, v]) => `${k}=${v}`).join("&");
  return `${API}/${path}?${query}`;
}

function cachePaths(url) {
  const key = createHash("sha1").update(url).digest("hex");
  const base = join(CACHE, key.slice(0, 2), key);
  return { body: base + ".bin", meta: base + ".meta.json" };
}

function rateHeaders(response) {
  const h = (name) => response.headers.get(name);
  const num = (name) => (h(name) === null ? null : Number(h(name)));
  return {
    status: response.status,
    remaining: num("x-ratelimit-remaining"),
    limit: num("x-ratelimit-limit"),
    remaining_usd: num("x-ratelimit-remaining-usd"),
    credits_used: num("x-ratelimit-credits-used"),
    credits_required: num("x-ratelimit-credits-required"),
    cost_usd: num("x-ratelimit-cost-usd"),
    reset_seconds: num("x-ratelimit-reset"),
    retry_after: h("retry-after"),
    at: new Date().toISOString(),
  };
}

function cached(url) {
  const paths = cachePaths(url);
  if (!existsSync(paths.body)) return null;
  budget.cacheHits++;
  return JSON.parse(readFileSync(paths.body, "utf8"));
}

/** Returns {data, status, fromCache, error}. Never throws for HTTP problems. */
async function oaGet(path, params) {
  const url = buildUrl(path, params);
  const hit = cached(url);
  if (hit) return { data: hit, status: 200, fromCache: true, url };
  if (OFFLINE) return { data: null, status: "offline", fromCache: false, url };
  let serverWaits = 0, networkErrors = 0;
  while (true) {
    if (budget.exhausted) return { data: null, status: "budget", fromCache: false, url };
    if (budget.last && budget.last.remaining !== null && budget.last.remaining <= STOP_AT) {
      budget.exhausted = true;
      budget.exhaustedReason = `x-ratelimit-remaining=${budget.last.remaining} <= ${STOP_AT}`;
      return { data: null, status: "budget", fromCache: false, url };
    }
    let response;
    try {
      budget.network++;
      response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(180_000) });
    } catch (error) {
      networkErrors++;
      appendFileSync(LEDGER, JSON.stringify({ url, status: "network-error", error: `${error.name}: ${error.message}`, at: new Date().toISOString() }) + "\n");
      log(`  network error (${networkErrors}) ${error.name}: ${error.message}`);
      if (networkErrors >= 4) return { data: null, status: "network-error", fromCache: false, url, error: error.message };
      await pause(5000 * networkErrors);
      continue;
    }
    const rate = rateHeaders(response);
    budget.first ??= rate;
    budget.last = rate;
    if (rate.credits_used !== null) budget.creditsUsed += rate.credits_used;
    if (rate.cost_usd !== null) budget.costUsd += rate.cost_usd;
    appendFileSync(LEDGER, JSON.stringify({ url, ...rate }) + "\n");
    if (response.status === 200) {
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (error) {
        return { data: null, status: "bad-json", fromCache: false, url, error: error.message };
      }
      const paths = cachePaths(url);
      mkdirSync(dirname(paths.body), { recursive: true });
      writeFileSync(paths.body + ".part", text);
      renameSync(paths.body + ".part", paths.body);
      writeFileSync(paths.meta, JSON.stringify({ url, ...rate }, null, 2) + "\n");
      budget.ok++;
      await pause(150);
      return { data, status: 200, fromCache: false, url };
    }
    const body = (await response.text()).slice(0, 600);
    if (response.status === 429) {
      // Either a per-second burst limit (short Retry-After) or the daily budget (remaining ~0).
      const retry = Number(rate.retry_after);
      if ((rate.remaining !== null && rate.remaining <= STOP_AT) || !(retry > 0) || retry > 120 || serverWaits >= 5) {
        budget.exhausted = true;
        budget.exhaustedReason = `429 (remaining=${rate.remaining}, retry-after=${rate.retry_after}): ${body.slice(0, 200)}`;
        return { data: null, status: "budget", fromCache: false, url, error: body };
      }
      serverWaits++;
      log(`  429, waiting ${retry}s`);
      await pause(retry * 1000);
      continue;
    }
    if (response.status >= 500 && serverWaits < 4) {
      serverWaits++;
      log(`  ${response.status}, retrying in ${10 * serverWaits}s`);
      await pause(10_000 * serverWaits);
      continue;
    }
    log(`  HTTP ${response.status} on ${url.slice(0, 160)}: ${body.slice(0, 200)}`);
    return { data: null, status: response.status, fromCache: false, url, error: body };
  }
}

// ---------------------------------------------------------------- transforms
const shortId = (value) => (value ? String(value).replace(/^https:\/\/openalex\.org\//, "") : null);

/** Abstract from OpenAlex's inverted index {word: [positions]}: place each word at its positions,
 *  read in position order, join with single spaces. Missing positions are skipped (counted). */
function reconstructAbstract(index) {
  if (!index || typeof index !== "object") return { text: null, tokens: 0, gaps: 0 };
  const slots = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) slots[p] = word;
  let gaps = 0;
  const words = [];
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] === undefined) gaps++;
    else words.push(slots[i]);
  }
  if (words.length === 0) return { text: null, tokens: 0, gaps };
  return { text: words.join(" "), tokens: words.length, gaps };
}

/** Precision of OpenAlex's publication_date. OpenAlex always serialises a full YYYY-MM-DD, filling
 *  unknown month/day with 01. We therefore read "-01-01" as year-only and "-MM-01" as month-only
 *  (conservative: a genuine 1 January / 1st-of-month date is downgraded, never upgraded). */
function datePrecision(date, year) {
  if (year === null || year === undefined) return { precision: "unknown", basis: "unknown", note: "no publication_year in OpenAlex" };
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { precision: "year", basis: "stated", note: date ? `unparsed publication_date ${date}` : "no publication_date" };
  if (Number(date.slice(0, 4)) !== year) return { precision: "year", basis: "stated", note: `publication_date ${date} disagrees with publication_year ${year}; year kept` };
  if (date.endsWith("-01-01")) return { precision: "year", basis: "stated", note: null };
  if (date.endsWith("-01")) return { precision: "month", basis: "stated", note: null };
  // 31 December is heavily over-represented (some publishers stamp whole volumes with year-end);
  // kept as stated, but flagged so consumers can treat the day as uncertain.
  if (date.endsWith("-12-31")) return { precision: "day", basis: "stated", note: "YYYY-12-31: possibly a year-end/volume placeholder (over-represented in OpenAlex); day uncertain" };
  return { precision: "day", basis: "stated", note: null };
}

function transformWork(raw, field, bin, rank) {
  const abstract = reconstructAbstract(raw.abstract_inverted_index);
  const date = datePrecision(raw.publication_date, raw.publication_year);
  const topic = raw.primary_topic || null;
  const location = raw.primary_location || null;
  const authorships = Array.isArray(raw.authorships) ? raw.authorships : [];
  const keywords = (Array.isArray(raw.keywords) ? raw.keywords : [])
    .map((k) => ({ term: k.display_name ?? null, score: typeof k.score === "number" ? Math.round(k.score * 10000) / 10000 : null }))
    .filter((k) => k.term)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return {
    id: shortId(raw.id),
    doi: raw.doi ? raw.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") : null,
    title: raw.title ?? null,
    abstract: abstract.text,
    abstract_tokens: abstract.tokens,
    abstract_gaps: abstract.gaps,
    year: raw.publication_year ?? null,
    publication_date: raw.publication_date ?? null,
    date_precision: date.precision,
    date_basis: date.basis,
    date_note: date.note,
    type: raw.type ?? null,
    language: raw.language ?? null,
    field: topic?.field?.display_name ?? null,
    field_id: shortId(topic?.field?.id),
    subfield: topic?.subfield?.display_name ?? null,
    subfield_id: shortId(topic?.subfield?.id),
    topic: topic?.display_name ?? null,
    topic_id: shortId(topic?.id),
    topic_score: typeof topic?.score === "number" ? Math.round(topic.score * 10000) / 10000 : null,
    domain: topic?.domain?.display_name ?? null,
    keywords,
    cited_by_count: raw.cited_by_count ?? null,
    authors: authorships.slice(0, MAX_AUTHORS).map((a) => a?.author?.display_name ?? a?.raw_author_name ?? null),
    author_count: authorships.length,
    authors_truncated_by_openalex: raw.is_authors_truncated ?? null,
    venue: location?.source?.display_name ?? null,
    venue_type: location?.source?.type ?? null,
    referenced_works: (Array.isArray(raw.referenced_works) ? raw.referenced_works : []).map(shortId),
    referenced_works_count: raw.referenced_works_count ?? null,
    is_oa: raw.open_access?.is_oa ?? null,
    oa_status: raw.open_access?.oa_status ?? null,
    oa_license: location?.license ?? null,
    is_retracted: raw.is_retracted ?? null,
    landing_page_url: location?.landing_page_url ?? null,
    sample_cell: `${field.name}|${binLabel(bin)}`,
    sample_rank: rank,
  };
}

// ---------------------------------------------------------------- main
async function main() {
  const startedAt = new Date().toISOString();
  log(`OpenAlex fetch → ${OUT}${OFFLINE ? " (offline)" : ""}${Number.isFinite(MAX_CELLS) ? ` (max ${MAX_CELLS} new cells)` : ""}`);
  const failures = [];

  // 1. Field list (confirms names -> IDs).
  const fieldsRes = await oaGet("fields", { "per-page": 50 });
  if (!fieldsRes.data) {
    log(`cannot get /fields (${fieldsRes.status}); nothing to do`);
    console.log(`DONE openalex: aborted, /fields unavailable (${fieldsRes.status})`);
    return;
  }
  const allFields = fieldsRes.data.results.map((f) => ({ id: shortId(f.id), num: shortId(f.id).replace("fields/", ""), name: f.display_name, domain: f.domain?.display_name ?? null, works_count: f.works_count }));
  writeFileSync(join(OUT, "fields.json"), JSON.stringify(allFields, null, 2) + "\n");
  const byName = new Map(allFields.map((f) => [f.name, f]));
  const wanted = CORE_ONLY ? CORE_FIELDS : [...CORE_FIELDS, ...OPTIONAL_FIELDS];
  const fields = [];
  for (const name of wanted) {
    const f = byName.get(name);
    if (!f) failures.push({ stage: "fields", detail: `field name not found in /fields: ${name}` });
    else fields.push({ ...f, tier: CORE_FIELDS.includes(name) ? "core" : "optional" });
  }
  log(`fields: ${fields.map((f) => `${f.name}=${f.num}`).join(", ")}`);

  // 2. Population matrix: one group_by request per bin gives works per field (the 26 fields; the API
  //    returns no bucket for works without a primary topic, so that number is derived as total - sum).
  const population = new Map(); // `${fieldId}|${bin}` -> count
  const populationRows = [];
  for (const bin of BINS) {
    const res = await oaGet("works", { filter: `publication_year:${bin[0]}-${bin[1]},type:${TYPES}`, group_by: "primary_topic.field.id", "per-page": 200 });
    if (!res.data) {
      failures.push({ stage: "population", bin: binLabel(bin), status: res.status, error: res.error ?? null });
      continue;
    }
    let sum = 0;
    for (const g of res.data.group_by || []) {
      const key = g.key && g.key !== "unknown" ? shortId(g.key).replace(/^(?!fields\/)/, "fields/") : "unknown";
      population.set(`${key}|${binLabel(bin)}`, g.count);
      populationRows.push([binLabel(bin), bin[0], bin[1], "group_by", key, g.key_display_name ?? "", g.count]);
      sum += g.count;
    }
    const total = res.data.meta?.count;
    populationRows.push([binLabel(bin), bin[0], bin[1], "total", "ALL", "all works matching the year+type filter", total ?? ""]);
    if (typeof total === "number") populationRows.push([binLabel(bin), bin[0], bin[1], "derived", "NONE", "no primary topic (total minus sum of group_by rows)", total - sum]);
  }
  log(`population: ${populationRows.length} rows${budget.exhausted ? " (budget stop)" : ""}`);

  // 3. Cells, field-major (core fields first). One page of the 200 most-cited works per cell.
  const cells = [];
  for (const field of fields) for (const bin of BINS) cells.push({ field, bin });
  let newCells = 0;
  const results = new Array(cells.length);
  let next = 0;
  async function worker() {
    while (next < cells.length) {
      const index = next++;
      const { field, bin } = cells[index];
      const pop = population.has(`${field.id}|${binLabel(bin)}`) ? population.get(`${field.id}|${binLabel(bin)}`) : null;
      const params = {
        filter: `primary_topic.field.id:${field.id},publication_year:${bin[0]}-${bin[1]},type:${TYPES}`,
        sort: "cited_by_count:desc",
        "per-page": PER_PAGE,
        select: SELECT,
      };
      const url = buildUrl("works", params);
      if (pop === 0 && !existsSync(cachePaths(url).body)) {
        results[index] = { field, bin, status: "empty", population: 0, url, works: [] };
        continue;
      }
      if (!existsSync(cachePaths(url).body)) {
        if (newCells >= MAX_CELLS) {
          results[index] = { field, bin, status: "pending (--max-cells)", population: pop, url, works: [] };
          continue;
        }
        newCells++;
      }
      const res = await oaGet("works", params);
      if (!res.data) {
        const status = res.status === "budget" ? "pending (budget)" : res.status === "offline" ? "pending (offline)" : `failed (${res.status})`;
        if (status.startsWith("failed")) failures.push({ stage: "cell", cell: `${field.name}|${binLabel(bin)}`, status: res.status, error: res.error ?? null, url });
        results[index] = { field, bin, status, population: pop, url, works: [] };
        continue;
      }
      const works = (res.data.results || []).map((w, i) => transformWork(w, field, bin, i + 1));
      results[index] = { field, bin, status: "ok", population: res.data.meta?.count ?? pop, url, works, fromCache: res.fromCache };
      if (!res.fromCache) log(`  ${field.name} | ${binLabel(bin)}: ${works.length} of ${res.data.meta?.count} (remaining ${budget.last?.remaining})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // 4. Outputs, rebuilt from the cache every run.
  const seen = new Map();
  const duplicates = [];
  for (const cell of results) for (const w of cell.works) {
    if (seen.has(w.id)) duplicates.push({ id: w.id, first: seen.get(w.id).sample_cell, again: w.sample_cell });
    else seen.set(w.id, w);
  }
  const works = [...seen.values()];
  const writer = jsonlWriter(join(OUT, "works.jsonl"));
  for (const w of works) writer.write(w);
  await writer.close();

  const year = new Map(works.map((w) => [w.id, w.year]));
  const citationLines = ["citing\tcited\tciting_year\tcited_year"];
  let citationPairs = 0, backwardPairs = 0;
  for (const w of works) for (const ref of new Set(w.referenced_works)) {
    if (!seen.has(ref) || ref === w.id) continue;
    citationLines.push(`${w.id}\t${ref}\t${w.year ?? ""}\t${year.get(ref) ?? ""}`);
    citationPairs++;
    if (w.year !== null && year.get(ref) !== null && year.get(ref) > w.year) backwardPairs++;
  }
  writeFileSync(join(OUT, "citations.tsv"), citationLines.join("\n") + "\n");

  const coverageLines = ["field\tfield_id\ttier\tbin\tbin_start\tbin_end\tstatus\tpopulation\tfetched\twith_abstract\twith_references\tdate_precision_day\tdate_precision_month\tdate_precision_year"];
  for (const cell of results) {
    const w = cell.works;
    const count = (pred) => w.filter(pred).length;
    coverageLines.push([
      cell.field.name, cell.field.id, cell.field.tier, binLabel(cell.bin), cell.bin[0], cell.bin[1], cell.status,
      cell.population ?? "", w.length, count((x) => x.abstract), count((x) => x.referenced_works.length > 0),
      count((x) => x.date_precision === "day"), count((x) => x.date_precision === "month"), count((x) => x.date_precision === "year"),
    ].join("\t"));
  }
  writeFileSync(join(OUT, "coverage.tsv"), coverageLines.join("\n") + "\n");
  writeFileSync(join(OUT, "population.tsv"), ["bin\tbin_start\tbin_end\trow_kind\tfield_id\tfield\tworks"].concat(populationRows.map((r) => r.join("\t"))).join("\n") + "\n");

  // 5. Manifest.
  const statusCounts = {};
  for (const cell of results) statusCounts[cell.status] = (statusCounts[cell.status] || 0) + 1;
  const pending = results.filter((c) => c.status.startsWith("pending")).map((c) => `${c.field.name}|${binLabel(c.bin)}`);
  const ledger = existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const credits = ledger.reduce((s, r) => s + (typeof r.credits_used === "number" ? r.credits_used : 0), 0);
  const byField = {};
  for (const w of works) byField[w.field ?? "null"] = (byField[w.field ?? "null"] || 0) + 1;
  const precision = { day: 0, month: 0, year: 0, unknown: 0 };
  for (const w of works) precision[w.date_precision]++;
  const languages = {};
  for (const w of works) languages[w.language ?? "null"] = (languages[w.language ?? "null"] || 0) + 1;
  const types = {};
  for (const w of works) types[w.type ?? "null"] = (types[w.type ?? "null"] || 0) + 1;
  const resetAt = budget.last?.reset_seconds != null ? new Date(Date.parse(budget.last.at) + budget.last.reset_seconds * 1000).toISOString() : null;

  writeManifest(OUT, {
    source: "OpenAlex (https://openalex.org) — REST API",
    urls: {
      api: API,
      fields: buildUrl("fields", { "per-page": 50 }),
      population_pattern: buildUrl("works", { filter: `publication_year:<a>-<b>,type:${TYPES}`, group_by: "primary_topic.field.id", "per-page": 200 }),
      cell_pattern: buildUrl("works", { filter: `primary_topic.field.id:fields/<n>,publication_year:<a>-<b>,type:${TYPES}`, sort: "cited_by_count:desc", "per-page": PER_PAGE, select: SELECT }),
      every_request: "requests.jsonl (this directory) logs every network request with status and rate-limit headers",
    },
    license: "OpenAlex metadata is CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/). Abstract text (reconstructed from abstract_inverted_index) remains under the publishers' copyright: local research use only, do not republish wholesale.",
    attribution: "Priem, J., Piwowar, H., & Orr, R. (2022). OpenAlex: A fully-open index of scholarly works, authors, venues, institutions, and concepts. arXiv:2205.01833. Data from https://openalex.org (CC0).",
    script: SCRIPT,
    // fetched_at (written by lib.mjs) is the time of THIS run, which may be an --offline rebuild; the
    // data itself was fetched over the network in the window below (from requests.jsonl).
    data_fetched_window: { first_request_at: ledger[0]?.at ?? null, last_request_at: ledger.at(-1)?.at ?? null, note: "network fetch window from requests.jsonl; fetched_at / run describe the run that wrote this manifest (possibly an --offline rebuild)" },
    run: { started_at: startedAt, finished_at: new Date().toISOString(), argv, offline: OFFLINE, core_only: CORE_ONLY, max_cells: Number.isFinite(MAX_CELLS) ? MAX_CELLS : null },
    method: [
      "GET /fields once to confirm field names -> IDs (fields.json).",
      `For each time bin, GET /works?filter=publication_year:<a>-<b>,type:${TYPES}&group_by=primary_topic.field.id -> population.tsv (how many works exist per field per bin; the denominator for every sample).`,
      `For each (field x bin) cell with population > 0, GET ONE page: /works?filter=primary_topic.field.id:<field>,publication_year:<a>-<b>,type:${TYPES}&sort=cited_by_count:desc&per-page=${PER_PAGE}&select=<${SELECT}>. Cells with population 0 are not requested.`,
      "Every 200 response is cached on disk (DATA/cache/http/<sha1[0:2]>/<sha1(url)>.bin + .meta.json); outputs are rebuilt from the cache on each run.",
      "Abstracts rebuilt from abstract_inverted_index by word position; citations.tsv keeps only pairs where both works are in the sample.",
      `Budget wrapper reads x-ratelimit-* headers and stops sending requests when remaining <= ${STOP_AT}.`,
    ],
    selection_criteria: {
      fields: fields.map((f) => ({ name: f.name, id: f.id, tier: f.tier })),
      bins: BINS.map(binLabel),
      types: TYPES.split("|"),
      field_assignment: "primary_topic.field.id (OpenAlex's single primary topic per work, machine-classified)",
      year_basis: "publication_year as recorded by OpenAlex",
      ranking: "cited_by_count descending (OpenAlex citation count at fetch time); top 200 per cell (one page)",
      per_cell_cap: PER_PAGE,
    },
    budget: {
      stop_at_remaining: STOP_AT,
      this_run: {
        network_requests: budget.network,
        ok_responses: budget.ok,
        cache_hits: budget.cacheHits,
        credits_used: budget.creditsUsed,
        cost_usd: Math.round(budget.costUsd * 1e6) / 1e6,
        remaining_at_first_response: budget.first?.remaining ?? null,
        remaining_at_last_response: budget.last?.remaining ?? null,
        remaining_usd_at_last_response: budget.last?.remaining_usd ?? null,
        daily_limit: budget.last?.limit ?? null,
        budget_resets_at: resetAt,
        stopped_for_budget: budget.exhausted,
        stop_reason: budget.exhaustedReason,
      },
      all_runs: {
        source: "requests.jsonl (every network request any run of this script has sent)",
        network_requests_logged: ledger.length,
        ok_responses_logged: ledger.filter((r) => r.status === 200).length,
        credits_used_logged: credits,
        cost_usd_logged: Math.round(ledger.reduce((s, r) => s + (typeof r.cost_usd === "number" ? r.cost_usd : 0), 0) * 1e6) / 1e6,
        first_request_at: ledger[0]?.at ?? null,
        last_request_at: ledger.at(-1)?.at ?? null,
        remaining_after_first_request: ledger.find((r) => typeof r.remaining === "number")?.remaining ?? null,
        remaining_after_last_request: ledger.findLast((r) => typeof r.remaining === "number")?.remaining ?? null,
      },
      note: "Two manual probe requests (GET /fields and a 2-row select test) were made with curl before the script existed; they are not in requests.jsonl. The anonymous budget is per client/IP, not exclusively ours: on 2026-10-03 x-ratelimit-remaining read 997 after our first probe (so ~2 credits had been used by something else that day) and 365 after our last request, i.e. 635 consumed vs 633 requests we sent (2 probes + 631 logged). The remaining counter is only approximately monotonic under concurrent requests. Offline rebuilds (--offline) send nothing. A post-run audit (2026-10-03 23:50 UTC) sent 1 more request by curl (/works?filter=openalex:<18 sampled ids>, 1 credit, remaining 365 -> 364) to spot-check records against the live API; it is not in requests.jsonl either.",
    },
    counts: {
      works: works.length,
      cells_total: results.length,
      cells_by_status: statusCounts,
      works_with_abstract: works.filter((w) => w.abstract).length,
      works_with_referenced_works: works.filter((w) => w.referenced_works.length > 0).length,
      citation_pairs_within_sample: citationPairs,
      citation_pairs_cited_later_than_citing: backwardPairs,
      works_by_field: byField,
      date_precision: precision,
      works_by_type: types,
      works_by_language: languages,
      retracted: works.filter((w) => w.is_retracted).length,
      duplicate_ids_across_cells: duplicates.length,
      dates_dec31_flagged: works.filter((w) => w.publication_date?.endsWith("-12-31")).length,
      dates_conflicting_year: works.filter((w) => w.date_note?.includes("disagrees")).length,
      abstracts_under_10_tokens: works.filter((w) => w.abstract && w.abstract_tokens < 10).length,
      abstracts_first_token_Abstract: works.filter((w) => w.abstract && w.abstract.split(" ")[0] === "Abstract").length,
      abstracts_only_the_word_Abstract: works.filter((w) => w.abstract === "Abstract").length,
      abstracts_over_1000_tokens: works.filter((w) => w.abstract && w.abstract_tokens > 1000).length,
      abstracts_over_3000_tokens: works.filter((w) => w.abstract && w.abstract_tokens > 3000).length,
      top20_works_with_no_authors: works.filter((w) => w.author_count === 0 && w.sample_rank <= 20).length,
      abstracts_with_position_gaps: works.filter((w) => w.abstract_gaps > 0).length,
      works_with_no_authorships: works.filter((w) => w.author_count === 0).length,
      works_with_author_count_100: works.filter((w) => w.author_count === 100).length,
      max_author_count: works.reduce((m, w) => Math.max(m, w.author_count), 0),
      works_without_title: works.filter((w) => !w.title).length,
    },
    coverage: "coverage.tsv: per field x bin — status, population (all matching works in OpenAlex), fetched, with_abstract, with_references, date precision counts. population.tsv: per bin, the 26 OpenAlex fields (row_kind group_by), the API total (total) and works with no primary topic (derived = total - sum of fields).",
    cells_skipped: {
      empty_population: results.filter((c) => c.status === "empty").map((c) => `${c.field.name}|${binLabel(c.bin)}`),
      pending: pending,
    },
    caveats: [
      "Sample = the 200 most-cited works per (field x bin) cell, so it heavily over-represents canonical, highly cited works; it is NOT a random or representative sample of the literature. Compare cells via population.tsv / coverage.tsv, never by raw counts in works.jsonl.",
      "cited_by_count is a snapshot at fetch time and favours older works within a bin (more time to accumulate citations) and fields/venues OpenAlex indexes well; the 2025-2026 bin is especially noisy.",
      "field / subfield / topic / topic_score / domain come from OpenAlex's machine topic classifier (primary_topic) and can be wrong (e.g. Newton's Principia gets subfield 'Theoretical Computer Science'). keywords are also machine-derived by OpenAlex, with OpenAlex's own scores.",
      "language is OpenAlex's (machine-detected) language code; it can be null or wrong for short or mixed-language records.",
      "Abstracts: rebuilt from OpenAlex's inverted index, so original spacing/line breaks are lost and tokens are joined with single spaces; many works (esp. pre-1950 and some publishers) have no abstract; some 'abstracts' are junk (page ranges, boilerplate, front matter). Copyright of abstract text sits with publishers — local research use only.",
      "Dates: publication_year/publication_date are as recorded by OpenAlex (date_basis 'stated'). OpenAlex fills unknown month/day with 01, so date_precision is 'year' for YYYY-01-01 and 'month' for YYYY-MM-01 (a genuine 1 Jan / 1st-of-month date is conservatively downgraded). For digitised old works OpenAlex's year is sometimes the reprint/digitisation year rather than first publication; we cannot detect that and did not correct it.",
      "referenced_works only lists references OpenAlex could match to its own records; pre-1950 works usually have none, so citation lineage in citations.tsv is sparse for early bins. A pair in citations.tsv is a documented citation (reference-list link), not evidence of semantic influence.",
      "authors: at most 10 display names (OpenAlex author disambiguation is itself machine-made). author_count is the number of authorships the list API returned; it is capped at 100 (observed: max exactly 100, hundreds of works at 100, almost none at 99), so 100 means '100 or more'. is_authors_truncated was accepted by select without error but the key is absent from every returned work, so authors_truncated_by_openalex is always null in this snapshot.",
      "cited_by_count can be grossly inflated where OpenAlex has merged citations of a famous book, manual or series onto an unrelated or same-titled record, and such records then rank at the top of their cell: e.g. W4297081765 'Harvard business review' (1994, J Am Diet Assoc, sample cell Engineering|1990-1994, topic 'Human auditory perception and evaluation') with 46,511 citations at rank 1; W2298230951 'Official Methods of Analysis of' (1980, Analytical Chemistry) 59,431; W2166785990 'Manual of Clinical Microbiology.' (1980, an Annals of Internal Medicine book review) 14,441. A top-ranked record with author_count 0 is a useful red flag (counts.top20_works_with_no_authors), but not proof.",
      "Reprints and e-book editions put old works into modern bins: e.g. Einstein's 'The Foundation of the General Theory of Relativity (1916)' is a 2025 Princeton book chapter at rank 1 of Physics and Astronomy|2025-2026, and 'Computing Machinery and Intelligence (1950)' sits in Computer Science|2000-2004. The year is the edition OpenAlex indexed, not first publication; not corrected.",
      "Some 'abstracts' are not abstracts but long excerpts of the work's body text supplied in OpenAlex's inverted index (counts.abstracts_over_1000_tokens; max 5,132 tokens for Turing's 1950 'Computing Machinery and Intelligence', which also has 6,324 missing positions). Positions missing from the index are skipped, so gap-heavy texts read as spliced fragments; check abstract_gaps. These excerpts make the copyright point above more acute: never display them as abstracts or republish them.",
      "publication_date YYYY-12-31 is strongly over-represented (about 6% of day-precision dates vs ~0.3% expected), suggesting year-end/volume placeholders from some publishers; those keep date_precision 'day' (as stated) but carry a date_note.",
      "citations.tsv contains some pairs where the cited work's year is later than the citing work's (counts.citation_pairs_cited_later_than_citing): these come from OpenAlex reference matching or dating errors (e.g. reprints dated by a later edition). They are kept as OpenAlex states them; the year columns let consumers flag them.",
      "Machine language detection produces implausible codes, mostly on old works but not only (e.g. 'war', 'ceb', 'lv'; the 2019 English paper 'Hamiltonian Simulation by Qubitization' is tagged 'lv'); keep them as OpenAlex states them.",
      "Types limited to article|book|review|book-chapter|preprint; letters, editorials, datasets, dissertations etc. are excluded. OpenAlex type labels are themselves heuristic for old material.",
      "Works with no primary topic (population.tsv row_kind 'derived', field_id 'NONE') cannot appear in any cell.",
    ],
    failures: failures.concat(duplicates.length ? [{ stage: "dedupe", detail: `${duplicates.length} work ids appeared in more than one cell; kept the first`, examples: duplicates.slice(0, 10) }] : []),
  });

  log(`works ${works.length}, citation pairs ${citationPairs}, cells ${JSON.stringify(statusCounts)}`);
  log(`budget this run: ${budget.network} requests, ${budget.creditsUsed} credits, remaining ${budget.last?.remaining ?? "n/a"}${resetAt ? `, resets ${resetAt}` : ""}`);
  if (pending.length) {
    log(`${pending.length} cells pending. To resume: wait for the budget reset (${resetAt ?? "00:00 UTC"}), then re-run`);
    log(`  node "${SCRIPT}"`);
    log("  (cached responses are re-used for free; only the pending cells cost credits)");
    console.log(`DONE openalex: partial — ${works.length} works, ${pending.length} cells pending (${budget.exhausted ? "budget" : "limit"})`);
  } else {
    console.log(`DONE openalex: complete — ${works.length} works, ${citationPairs} citation pairs`);
  }
}

main().catch((error) => {
  console.error(error);
  console.log(`DONE openalex: crashed — ${error.message}`);
  process.exitCode = 1;
});
