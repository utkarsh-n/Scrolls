<!-- OWNER: WP0 — the HTTP API (SPEC §7) and the index of its contract fixtures; tables are generated from tests/contract -->
# Scrolls API

JSON over `node:http`, everything under `/api`. This page restates SPEC §7 for implementers and indexes the
canned responses in `tests/contract/`, which are the API contract every package builds and tests against.
The shapes themselves live in [`src/shared/contracts.mjs`](../src/shared/contracts.mjs) (`SHAPES`, `ENDPOINTS`,
`check(shapeName, obj)`); where this page and the code disagree, the code and SPEC §7 win.

## Conventions

- **Local only.** The server binds `127.0.0.1:3460`. `Host` must be `127.0.0.1:3460` or `localhost:3460` (DNS-rebinding
  guard) and mutating requests need a same-origin `Origin`; otherwise `403 E_FORBIDDEN_ORIGIN`.
- **Errors** are `{"error": {"code", "message", "hint", "detail"}}` with the right status: 400 validation (`E_VALIDATION`
  and specific codes), 403, 404 `E_NOT_FOUND`, 409 conflict, 413 too large, 503 `QUERY_TIMEOUT` (a heavy read over 5 s;
  the hint suggests narrowing the range), 500. The UI shows `message` + `hint` + Retry (§8.8).
- **Gates are not errors.** A measure that fails its minimum-evidence gate answers 200 with
  `{gate, needed, have, suggestion, value: null}` — never a numeral (§13 rule 7; `check()` rejects a gated object that
  carries `value`, `ci`, `ci_lo`, `ci_hi` or `null_percentile`). `suggestion: null` means no widening inside the
  corpus reaches the gate.
- **Caching.** Every GET carries `ETag: W/"<dataVersion>-<hash>"` and honours `If-None-Match` (the client in
  `src/ui/core/api.mjs` revalidates automatically).
- **Lists** take `limit` (≤ 200; marks ≤ 4,000) and an opaque `cursor`; list bodies are `{items, cursor}` unless the
  shape says otherwise.
- **Provenance.** Data responses carry `provenance: {data_version, run_ids, tokenizer: "u61m-1", segmenter: "seg-1",
  synthetic, collections: […], licenses: […]}`; every object that can be synthetic carries `synthetic: true|false`,
  and synthetic people's names end with "(synthetic)".
- **Session.** The client sends `X-Scrolls-Session: <random per tab>`, used only for the Compare multiplicity log.
- **Filter grammar** (`f`): `lang:en,fr;kind:book,song;coll:cipher-gutenberg;culture:in;field:medicine;basis:-estimated;syn:1`
  (`-` excludes). **Toggles**: `tr` translations (0), `ds` describes (0), `ap` apparatus (0), `dup` (0), `nm`
  name-guard hits (0), `est` estimated dates (1), `bp` boilerplate (0).
- **Offsets** are UTF-16 code units into the decoded original (D4). Passage `highlights` are relative to the passage
  `text`; `start`/`end` of a passage index the document text.
- **Scripts and CLI clients** must send `Origin: http://127.0.0.1:<port>` on POST/PUT/PATCH/DELETE (a mutation without
  `Origin` is refused); any request with `Sec-Fetch-Site: cross-site` is refused too.

### Error codes the foundation (WP0) produces

| Status | Code | When |
|---|---|---|
| 400 | `E_BAD_JSON` | the body of a JSON request does not parse |
| 400 | `E_BAD_ID`, `E_BAD_STATUS`, `E_BAD_CURSOR`, `E_BAD_LIMIT` | a malformed id, job status filter, cursor or `limit` |
| 400 | `E_VALIDATION` | a request body does not match its request shape (mock mode checks this today) |
| 400 | `E_JOB_TYPE` | an unknown job type |
| 403 | `E_FORBIDDEN_ORIGIN` | foreign `Host`, cross-origin or Origin-less mutation |
| 404 | `E_NOT_FOUND` | no such endpoint, row or static file |
| 405 | `E_METHOD_NOT_ALLOWED` | the path exists with other methods (listed in the `Allow` header) |
| 409 | `E_CONSTRAINT` | a CHECK, UNIQUE or honesty trigger refused the write |
| 409 | `E_INPUTS_CHANGED` | a job error (1.3.0): an import or quality pass committed into an analysis run's own collections while it computed, so nothing of the run was stored — start the run again |
| 413 | `E_BODY_TOO_LARGE` | a JSON body over 25 MB (files go through `/api/imports`) |
| 501 | `NOT_IMPLEMENTED` | a module that is still the WP0 stub was called (see `Docs/WP0-STATUS.md`) |
| 503 | `QUERY_TIMEOUT` | a heavy read ran over its limit (5 s; `POST /api/timeline/query` and `GET /api/constellation` 15 s, `GET /api/timeline/arcs` 12 s, corpora and adapters 20 s); the read worker was replaced |
| 503 | `E_BUSY` · `E_SHUTTING_DOWN` · `E_MOCK` | the write lock stayed taken for 60 s (an interactive write waits 25 ms, then is parked and re-run once the lock is free) · the server is stopping · a write reached mock mode |
| 500 | `E_INTERNAL` · `E_READ_WORKER` | anything else; never with a stack trace or SQL |

**Before a package lands** its route file exports `routes = []`, so the real server answers `404 E_NOT_FOUND` for
its endpoints while `SCROLLS_MOCK=1` serves their fixtures. Job errors (`Job.error`) are `{code, message, hint}`; a
job whose task module is still a stub fails at once with `NOT_IMPLEMENTED`.

### Tile cells (GET /api/timeline/tiles)

At tier L2 a bin is a decade: `bin = floor(year / 10)`, `tile = floor(bin / 64)`. A cell is
`[binIndexInTile, n, docs, authors, denom, rate, ci_lo, ci_hi, state, flags, dp]`.

| state | meaning | rate / CI |
|---|---|---|
| 1 observed | n ≥ 1 | rate in the lane unit, 95% CI (Garwood) |
| 2 absent | n = 0 and denom ≥ gate: looked, found none | 0 and the upper bound |
| 3 low | 0 < denom < gate | null (raw n only) |
| 4 uncovered | denom = 0: no sources | null |
| 5 pending | the collection is still indexing | null |

Flags: 1 sparse (n < 5) · 2 single source · 4 estimated majority · 8 sampled · 16 synthetic · 32 names excluded ·
64 translations included. Cells are sent only for bins with n > 0 or denom > 0; a bin without a cell is uncovered (or
pending while indexing). The client takes the state from the cell and never infers it. Conservation holds per lane and
tier: Σ bin n + Σ wash n + undated + scheduled = total n.

### Exports and snapshots (§7.3)

`GET /api/export?view=<slug>|state=<b64url>&what=occurrences|aggregates|passages|relationships|annotations|bundle&format=json|jsonl|csv|html`.
The manifest comes first (JSON top-level key, JSONL first line, CSV `#` lines): `{export_version, generated_at, view,
state, data_version, run_ids, filters, toggles, synthetic_included, licenses[], attributions[]}`. Rows carry
`evidence_status`, `review_status`, `origin`, `is_synthetic`, `date_label`, `date_precision`, `date_basis`,
`date_role`, offsets and `source_locator` where relevant. Collections with `export_text_allowed=0` (OpenAlex abstracts)
export ids, offsets and locators only. `POST /api/snapshots {view, png, svg}` stores a snapshot; a synthetic view gets a
SYNTHETIC stamp.

## Endpoints

`Heavy` endpoints run in the read-worker pool (D11). Request/Response name shapes in `contracts.SHAPES`; `—` means no
JSON shape (event streams, downloads, a 204). The seven endpoints that `contracts.ENDPOINTS` does not list are in
`EXTRA_ENDPOINTS` of [`tests/helpers/shape.mjs`](../tests/helpers/shape.mjs).

### Health, jobs and events (WP0)

| Method & path | Purpose | Request | Response | Heavy | Fixture |
|---|---|---|---|---|---|
| GET `/api/events` | Shared SSE stream: `job` (progress/done), `data` (dataVersion bump), `bootstrap` (Cipher phases), `adapter`. | — | — |  | [GET__api_events.json](../tests/contract/GET__api_events.json) |
| GET `/api/health` | Version, contract, dataVersion, jobs, read pool (`size`, `busy`, plus `queued`), adapters (`nl`, plus `registered`: the number of `source_adapter` rows) and the Cipher bootstrap status (`cipher.status` ∈ `vocab.CIPHER_STATUS`: absent · disabled · not_started · queued · metadata (phases A, A2 running) · fulltext (phase B running) · ready · failed · cancelled · interrupted, with `phase`, `progress`, `message` of the latest bootstrap job; the `bootstrap` SSE event carries the same object). Mock bodies carry `mock: true`. | — | `Health` |  | [GET__api_health.json](../tests/contract/GET__api_health.json) |
| GET `/api/jobs` | Jobs, newest first; `?status=` filters. | — | `JobList` |  | [GET__api_jobs.json](../tests/contract/GET__api_jobs.json) |
| GET `/api/jobs/:id` | One job row. | — | `Job` |  | [GET__api_jobs_{id}.json](../tests/contract/GET__api_jobs_%7Bid%7D.json) |
| GET `/api/jobs/:id/events` | SSE progress of one job: `progress` events, then `done`. | — | — |  | [GET__api_jobs_{id}_events.json](../tests/contract/GET__api_jobs_%7Bid%7D_events.json) |
| POST `/api/jobs/:id/cancel` | Request cancellation; acknowledged ≤ 500 ms, the final "cancelled" arrives over SSE. | — | `JobCancel` |  | [POST__api_jobs_{id}_cancel.json](../tests/contract/POST__api_jobs_%7Bid%7D_cancel.json) |

### Imports (WP1, §5.2)

| Method & path | Purpose | Request | Response | Heavy | Fixture |
|---|---|---|---|---|---|
| GET `/api/imports/:id/preview` | Format, encoding, delimiter, columns with samples, 20 sample rows, suggested mapping, issues. | — | `ImportPreview` |  | [GET__api_imports_{id}_preview.json](../tests/contract/GET__api_imports_%7Bid%7D_preview.json) |
| GET `/api/imports/:id/problems.csv` | Every issue of the batch as CSV (one row per issue). | — | — |  | [GET__api_imports_{id}_problems.csv.json](../tests/contract/GET__api_imports_%7Bid%7D_problems.csv.json) |
| POST `/api/imports` | Upload a file (raw body; headers X-Scrolls-Filename and X-Scrolls-Collection, URL-encoded JSON) → batch id + preview. | — | `ImportCreated` |  | [POST__api_imports.json](../tests/contract/POST__api_imports.json) |
| POST `/api/imports/:id/commit` | Commit with a mapping → a job (SSE progress), then the summary. | `ImportMappingRequest` | `JobRef` |  | [POST__api_imports_{id}_commit.json](../tests/contract/POST__api_imports_%7Bid%7D_commit.json) |
| POST `/api/imports/:id/revert` | Soft-delete the batch's documents (a job); bumps data_version. | — | `JobRef` |  | [POST__api_imports_{id}_revert.json](../tests/contract/POST__api_imports_%7Bid%7D_revert.json) |
| PUT `/api/imports/:id/mapping` | Validate a mapping with a dry run over all rows → projected ImportSummary. | `ImportMappingRequest` | `ImportValidation` | ✓ | [PUT__api_imports_{id}_mapping.json](../tests/contract/PUT__api_imports_%7Bid%7D_mapping.json) |

### Sources and demo (WP2)

| Method & path | Purpose | Request | Response | Heavy | Fixture |
|---|---|---|---|---|---|
| GET `/api/adapters` | Staged-source adapters: probe result (FORMAT.md + MANIFEST.json first), licence, load state. | — | `Adapters` |  | [GET__api_adapters.json](../tests/contract/GET__api_adapters.json) |
| GET `/api/baseline` | External Ngram baseline for one word, or `{available: false, reason}`. | — | `Baseline` | ✓ | [GET__api_baseline.json](../tests/contract/GET__api_baseline.json) |
| GET `/api/corpora` | Corpora and their collections with coverage, selection notes, caveats, licences and status. | — | `Corpora` | ✓ | [GET__api_corpora.json](../tests/contract/GET__api_corpora.json) |
| GET `/api/facets` | Facet values with document counts for the current filter (`?f=`). | — | `Facets` | ✓ | [GET__api_facets.json](../tests/contract/GET__api_facets.json) |
| GET `/api/tour` | The demo tour (data/demo/tour.json) with ids resolved; 10 steps ≈ 4 minutes, steps 1–3 are the first 60 seconds. | — | `Tour` |  | [GET__api_tour.json](../tests/contract/GET__api_tour.json) |
| POST `/api/adapters/:id/enable` | Enable an adapter (network ones need `{approve: true}`); answers with the updated adapter list. | — | `Adapters` |  | [POST__api_adapters_{id}_enable.json](../tests/contract/POST__api_adapters_%7Bid%7D_enable.json) |
| POST `/api/adapters/:id/load` | Load a staged source (a job). Network adapters need `{approve: true}`. | — | `JobRef` |  | [POST__api_adapters_{id}_load.json](../tests/contract/POST__api_adapters_%7Bid%7D_load.json) |
| GET `/api/adapters/:id/claims` | Contract 1.2.0: an adapter's external claims (Wiktionary attestation statements) for `?word=&lang=` or a tracked `?expr=`; never occurrences. | — | `AdapterClaims` | ✓ | [GET__api_adapters_{id}_claims.json](../tests/contract/GET__api_adapters_%7Bid%7D_claims.json) |

### Search, timeline, passages, exports (WP3)

| Method & path | Purpose | Request | Response | Heavy | Fixture |
|---|---|---|---|---|---|
| GET `/api/documents/:id` | Document metadata: dates (every assertion), tags with provenance, aliases. | — | `Document` |  | [GET__api_documents_{id}.json](../tests/contract/GET__api_documents_%7Bid%7D.json) |
| GET `/api/documents/:id/text` | A slice (≤ 20k chars) of the decoded original; offsets are UTF-16 code units (D4). | — | `DocumentText` |  | [GET__api_documents_{id}_text.json](../tests/contract/GET__api_documents_%7Bid%7D_text.json) |
| GET `/api/occurrences/:id` | Contract 1.1.0 (M1 gate): an occurrence id → its passage, document and expression (offsets in the passage's base), so a reloaded `sel=occ:N` opens the passage. | — | `Occurrence` |  | [GET__api_occurrences_{id}.json](../tests/contract/GET__api_occurrences_%7Bid%7D.json) |
| GET `/api/export` | Export a view or state: manifest first (JSON key, JSONL first line, CSV # lines), then rows; licences travel with data. | — | — | ✓ | [GET__api_export.json](../tests/contract/GET__api_export.json) |
| GET `/api/expressions/:id` | An expression with its variants (n per variant) and materialization state. | — | `Expression` |  | [GET__api_expressions_{id}.json](../tests/contract/GET__api_expressions_%7Bid%7D.json) |
| GET `/api/etymology` | Contract 1.2.0: `?expr=` → the roots.tsv families of the expression's single-word variants, each with its listed parents and `parent_semantics` (periods, not dates). 1.3.0: `roots`, each listed root once (C5). | — | `Etymology` |  | [GET__api_etymology.json](../tests/contract/GET__api_etymology.json) |
| GET `/api/kwic` | Concordance rows (sorted by date or spread); each row opens its passage. | — | `Kwic` | ✓ | [GET__api_kwic.json](../tests/contract/GET__api_kwic.json) |
| GET `/api/passages/:id` | A passage with offsets into the original, highlights (relative to `text`), its document and date card, anchor, machine annotations. | — | `Passage` |  | [GET__api_passages_{id}.json](../tests/contract/GET__api_passages_%7Bid%7D.json) |
| GET `/api/search` | Typed suggestions (expression · work · maker · theme), KWIC and titles. Empty results are computed, with variants tried. | — | `Search` | ✓ | [GET__api_search.json](../tests/contract/GET__api_search.json) |
| GET `/api/snapshots/:file` | A stored snapshot file. | — | — |  | [GET__api_snapshots_{file}.json](../tests/contract/GET__api_snapshots_%7Bfile%7D.json) |
| GET `/api/timeline/arcs` | Relationship arcs in a range at a vantage: forward arcs above, feedback arcs below (feedback-capable types only), bundles beyond the 300-arc budget, hidden counts. | — | `Arcs` | ✓ | [GET__api_timeline_arcs.json](../tests/contract/GET__api_timeline_arcs.json) |
| GET `/api/timeline/bin` | Bin drawer: the denominator line, then KWIC rows sorted by date (50 per page); every row opens its passage. | — | `BinDrawer` | ✓ | [GET__api_timeline_bin.json](../tests/contract/GET__api_timeline_bin.json) |
| GET `/api/timeline/marks` | Individual matches in a range (≤ 4,000), each resolving to its passage. | — | `Marks` | ✓ | [GET__api_timeline_marks.json](../tests/contract/GET__api_timeline_marks.json) |
| GET `/api/timeline/shelf` | Shelf lists: UNDATED (outside chronology), SCHEDULED (after today), washes (records that do not fit the bin). | — | `Shelf` | ✓ | [GET__api_timeline_shelf.json](../tests/contract/GET__api_timeline_shelf.json) |
| GET `/api/timeline/tiles` | Binned cells + washes + coverage per lane and strand. Cell = [binIndexInTile, n, docs, authors, denom, rate, ci_lo, ci_hi, state, flags, dp]; state 1 observed · 2 absent · 3 low · 4 uncovered · 5 pending. A bin with no cell is uncovered. | — | `Tiles` | ✓ | [GET__api_timeline_tiles.json](../tests/contract/GET__api_timeline_tiles.json) |
| PATCH `/api/expressions/:id/variants` | Enable or disable variants; counting reruns as a job. | `VariantsPatch` | `Expression` |  | [PATCH__api_expressions_{id}_variants.json](../tests/contract/PATCH__api_expressions_%7Bid%7D_variants.json) |
| POST `/api/expressions` | Track an expression: variants + materialization state (a job when counting is needed). | `ExpressionRequest` | `Expression` |  | [POST__api_expressions.json](../tests/contract/POST__api_expressions.json) |
| POST `/api/snapshots` | Store a PNG/SVG snapshot (PNG = canvas layers + legend + caption, SYNTHETIC stamp when synthetic items are visible). | `SnapshotRequest` | `Snapshot` |  | [POST__api_snapshots.json](../tests/contract/POST__api_snapshots.json) |
| POST `/api/timeline/query` | Register a canonical query → queryKey, lanes (label · unit · coverage), extent, totals, modality seams, gates. | `TimelineQueryRequest` | `TimelineQuery` | ✓ | [POST__api_timeline_query.json](../tests/contract/POST__api_timeline_query.json) |

### Analysis (WP4)

| Method & path | Purpose | Request | Response | Heavy | Fixture |
|---|---|---|---|---|---|
| GET `/api/analysis/runs` | Runs with versions and parameters (`?stage=&expr=`). | — | `AnalysisRuns` |  | [GET__api_analysis_runs.json](../tests/contract/GET__api_analysis_runs.json) |
| GET `/api/clusters` | Sense hypotheses (context groups) of one expression: machine labels, shares, stability, transitions — or a gate. | — | `Clusters` |  | [GET__api_clusters.json](../tests/contract/GET__api_clusters.json) |
| GET `/api/collocations` | Collocates of an expression in a slice (logDice; G² ≥ 10.83, f ≥ 5, q < .05) or a gate with a widening suggestion. | — | `Collocations` | ✓ | [GET__api_collocations.json](../tests/contract/GET__api_collocations.json) |
| GET `/api/constellation` | Nodes and edges with stable positions (layout key); periods A and B never move nodes. | — | `Constellation` | ✓ | [GET__api_constellation.json](../tests/contract/GET__api_constellation.json) |
| POST `/api/analysis/runs` | Start an analysis run (cluster, vectors, drift, tone, reuse-index) as a job; an identical finished run is reused. | `AnalysisRunRequest` | `AnalysisRunStarted` |  | [POST__api_analysis_runs.json](../tests/contract/POST__api_analysis_runs.json) |
| POST `/api/compare` | Compare two slices: multiplicity, coverage and composition first, frequency with CIs, passages, collocates, context groups, gated measures, tone, human counts. | `CompareRequest` | `Compare` | ✓ | [POST__api_compare.json](../tests/contract/POST__api_compare.json) |

### Lineage and provenance (WP5)

| Method & path | Purpose | Request | Response | Heavy | Fixture |
|---|---|---|---|---|---|
| DELETE `/api/views/:slug` | Soft-delete a saved view (its links stop resolving; the row stays). | — | — |  | [DELETE__api_views_{slug}.json](../tests/contract/DELETE__api_views_%7Bslug%7D.json) |
| GET `/api/annotations` | Annotations on a target (`?target=&include=superseded&as_of=`); machine annotations are labelled and cannot be edited. | — | `Annotations` |  | [GET__api_annotations.json](../tests/contract/GET__api_annotations.json) |
| GET `/api/annotations/:id/revisions` | Every revision of an annotation (append-only). | — | `AnnotationRevisions` |  | [GET__api_annotations_{id}_revisions.json](../tests/contract/GET__api_annotations_%7Bid%7D_revisions.json) |
| GET `/api/genealogy` | Works-as-bars genealogy (samples, interpolates, cover_of, remix_of, version_of): generations, per-decade density, documented edges with locators. | — | `Genealogy` | ✓ | [GET__api_genealogy.json](../tests/contract/GET__api_genealogy.json) |
| GET `/api/hypothesis-groups/:id` | Competing hypotheses for one target, side by side; confirming one never rejects the others. | — | `HypothesisGroup` |  | [GET__api_hypothesis-groups_{id}.json](../tests/contract/GET__api_hypothesis-groups_%7Bid%7D.json) |
| GET `/api/lineage` | Bounded lineage graph around a root (depth 2 both ways, ≤ 60 nodes; hard cap 150); hypothesis groups; truncation stated. | — | `Lineage` | ✓ | [GET__api_lineage.json](../tests/contract/GET__api_lineage.json) |
| GET `/api/lineage/path` | Least-evidence-cost path (documented 1, computed 3, proposed 5; rejected excluded); chain strength = weakest link. | — | `LineagePath` | ✓ | [GET__api_lineage_path.json](../tests/contract/GET__api_lineage_path.json) |
| GET `/api/relationships/:id` | Edge card: status in words, origin, method/run, score kind, locator, evidence spans, revisions, review state, the fixed caution. | — | `Relationship` |  | [GET__api_relationships_{id}.json](../tests/contract/GET__api_relationships_%7Bid%7D.json) |
| GET `/api/views` | Saved views, newest first. | — | `Views` |  | [GET__api_views.json](../tests/contract/GET__api_views.json) |
| GET `/api/views/:slug` | A saved view as saved, with drift since it was saved; "as saved" (`?as=1`) restricts to the pinned imports and runs. | — | `View` |  | [GET__api_views_{slug}.json](../tests/contract/GET__api_views_%7Bslug%7D.json) |
| PATCH `/api/annotations/:id` | Edit = append a revision (revisions are never updated or deleted). | `AnnotationPatch` | `AnnotationRev` |  | [PATCH__api_annotations_{id}.json](../tests/contract/PATCH__api_annotations_%7Bid%7D.json) |
| POST `/api/annotations` | Create an annotation (passage and occurrence targets need an anchor). | `AnnotationRequest` | `AnnotationRev` |  | [POST__api_annotations.json](../tests/contract/POST__api_annotations.json) |
| POST `/api/annotations/:id/reinterpret` | Reinterpret: a new annotation that supersedes this one; the old one stays as a visible layer. | `AnnotationRequest` | `AnnotationReinterpreted` |  | [POST__api_annotations_{id}_reinterpret.json](../tests/contract/POST__api_annotations_%7Bid%7D_reinterpret.json) |
| POST `/api/annotations/:id/withdraw` | Withdraw (appends a revision; nothing is deleted). | — | `AnnotationRev` |  | [POST__api_annotations_{id}_withdraw.json](../tests/contract/POST__api_annotations_%7Bid%7D_withdraw.json) |
| POST `/api/hypothesis-groups` | Open a hypothesis group on a target with a question. | `HypothesisGroupRequest` | `Created` |  | [POST__api_hypothesis-groups.json](../tests/contract/POST__api_hypothesis-groups.json) |
| POST `/api/relationships` | Propose a link (server-forced: evidence_status proposed, origin human; never documented). | `RelationshipRequest` | `Created` |  | [POST__api_relationships.json](../tests/contract/POST__api_relationships.json) |
| POST `/api/relationships/:id/evidence` | Attach an evidence span to a relationship (appends a revision). | — | `Created` |  | [POST__api_relationships_{id}_evidence.json](../tests/contract/POST__api_relationships_%7Bid%7D_evidence.json) |
| POST `/api/relationships/:id/review` | Confirm / reject / dispute with a note (≥ 10 characters); evidence_status never changes. | `ReviewRequest` | `Review` |  | [POST__api_relationships_{id}_review.json](../tests/contract/POST__api_relationships_%7Bid%7D_review.json) |
| POST `/api/trace` | Targeted quotation trace of a span (≤ 1.5 s synchronous, else a job); creates computed relationships only. | `TraceRequest` | `Trace` | ✓ | [POST__api_trace.json](../tests/contract/POST__api_trace.json) |
| POST `/api/views` | Save an immutable view (pins data version, import cutoff, run ids, revision cutoffs); re-saving makes slug~2. | `ViewRequest` | `ViewSaved` |  | [POST__api_views.json](../tests/contract/POST__api_views.json) |

### Event streams

`GET /api/events` is one shared stream per tab (the client multiplexes it, see `src/ui/core/sse.mjs`): `job` (a
`JobProgressEvent` or `JobDoneEvent`), `data` (`{dataVersion}` after a committed write), `bootstrap` (the Cipher status
object of `/api/health`), `adapter` (`{id, loaded, staged, message}`). `GET /api/jobs/:id/events` streams `progress`
events then one `done`; cancel is acknowledged within 500 ms and the final `cancelled` arrives as `done`.

## Additive parameters and fields (contract 1.1.0, M1 integration gate)

The shapes allow extra keys, so these were added by the packages without a shape change; they are listed here so
clients can rely on them. Contract **1.1.0** adds one endpoint (`GET /api/occurrences/:id` → `Occurrence`) and the
`pragmatic_function` value `contested` (§9.4).

- **Uploads.** `POST /api/imports` reads the raw body whatever the `Content-Type` (the route is `rawBody`): a `.json`
  file sent as `application/json` is a file, not a request body. Send `X-Scrolls-Filename` and
  `X-Scrolls-Collection: encodeURIComponent(JSON.stringify({slug?, name, unit?, license?}))`.
- **Timeline (WP3).** `tiles=a..b` ranges (≤ the per-request tile limit). Lane keys are `facet:value` for text evidence and
  `facet:value~titles` / `facet:value~abstracts` for title and abstract evidence; a missing value is `(none)`. A wash
  listed in several tiles carries a stable `key` and `owner: true` only in the tile of its first bin — dedupe by `key`.
  Lanes carry `state: 'pending'` + `note` while a collection of their medium is still loading (an import batch is
  committing, or the Cipher bootstrap marks the collection `pending`/`indexing`), `gate`, `undated_warning` and
  `strands[strandKey]`. `totals.excluded[strand]` counts each default exclusion (attributed to the first rule that
  removes a match, in the order other language · not rate-eligible · describes · apparatus · translations · duplicates ·
  estimated · names, so with every toggle on `totals.n` rises by exactly the sum of the toggleable buckets; fix pass).
  **Three name counts, three scopes:** `totals.names_excluded` = `excluded[strand].names` = Search's
  `hits.names_excluded` (name-guard hits the view's default rules would otherwise show); `GET /api/expressions/:id`
  `state.names_excluded` counts every name-guard hit of the count, in every field, language and collection (before any
  view rule). `totals.by_unit {matches, works}` and `units_mixed` (fix pass, C2): a Term trail counts text matches
  beside works (titles, OpenAlex cells, relation endpoints); `totals.n` adds them only for a single unit, and clients
  print the units apart (`format.totalsText`); `sampling_note` and `time_basis_note` explain sampled counts and the `referenced` time basis (not
  built: publication time is used). `marks.sampled`; arcs `hidden.{budget, kindred, rejected, filtered, vantage, outside}`
  and `bundles`. Arcs, exports and lineage show relationships of succeeded analysis runs only. Errors:
  `E_QUERY_UNKNOWN` (404, re-register with POST /api/timeline/query), `E_NOT_MATERIALIZED` (409), `E_RANGE` (400).
- **Search (WP3).** `lang=` forces the query language; `hits.contexts_sampled`; maker suggestions use the ref
  `maker:<slugify(name)>`; the annotation suggestion counts annotations whose current revision mentions the query.
- **Documents (WP3).** `GET /api/documents/:id` carries `length` (UTF-16 units of the original) when it has full text.
- **Exports (WP3).** `state=` is base64url of the UTF-8 URL hash of a view state; `snapshot=` attaches a stored snapshot
  to a bundle; `POST /api/snapshots` takes `synthetic` (an SVG of a synthetic view must carry the SYNTHETIC stamp).
  The manifest is the first object/line/comment block of every export (shape not yet in `contracts.mjs`).
- **Compare (WP4).** Request extras: `seed` (reshuffle), `override: 'descriptive'` ("compare anyway": rates in their own
  units, no ratio, test or verdict), `toggles`, `lane_facet`, `corpus`. Response extras: `freq.a`/`freq.b` and
  `freq.rate_ratio` may themselves be gated (`insufficient_coverage`, `modality_mismatch`); `coverage.*.rate_gate`;
  collocates gated `not_run` carry `suggestion.run = {stage: 'tokstream', params}`.
- **Lineage and provenance (WP5).** Requests: `author` (default 'you') on reviews, annotations and proposals;
  `parent_slug` on `POST /api/views` (re-save → `slug~2`); `relative: true` on evidence and trace spans (offsets into
  the passage text instead of the document text); `as=1`, `rev_cutoff`, `rel_rev_cutoff`, `runs` to read a saved view as
  saved; `q`, `include=superseded`, `as_of`, facets on `GET /api/annotations`; `status`, `rejected` on lineage and
  genealogy. Responses: views carry `counts` and `cutoffs`; lineage carries `links` (commonplace nodes) and `filters`;
  edge cards carry `status_words`, `score_label`, `cue`, `run`.

## Contract 1.2.0 (M2–M5 integration gate)

Two endpoints, the SSE event shapes, one document kind and the additive fields the P2 packages added. Shapes still
allow extra keys; where a field is now named in `contracts.SHAPES` it is optional, so 1.1.0 bodies stay valid. No
schema change: `schema_version` stays 1 and an M1 database opens unchanged.

**New endpoints**

- `GET /api/etymology?expr=<id>` → `Etymology` `{available, expression, word, lang, families[], note, source}` or
  `{available: false, reason}` (phrases, symbols, roots data not loaded). A family is an `etymon` row whose member
  list holds one of the expression's enabled single-word variants in its language: `{key, lang, form, roman, gloss,
  kind, parent_semantics, parents[], members[]}`. `parents` are the listed roots in their listed order. Periods, not
  dates; a multi-parent list is a "listed roots" bracket, never competing hypotheses (§1.7, §13 rule 12). `note` is
  "No etymology family in Cipher's roots data (Latin, Greek, Sanskrit, PIE only)" when there is none. The Scroll
  (WP6) switches from the search fallback to this endpoint at `health.contract ≥ 1.2.0`. 400 for a bad id, 404 for
  an unknown expression.
- `GET /api/adapters/:id/claims?expr=<id>` | `?word=&lang=` → `AdapterClaims` `{available, adapter, license,
  attribution, note, word, lang, expression, loaded, claims[]}` or `{available: false, reason, command?}`. With
  `expr`, the claims already written on the expression come back (`loaded: true`, each with `assertion`,
  `highlight {passage, start, end}` into the entry document's `entry` passage); otherwise the word index is looked up
  (`loaded: false`, `written: false`; an open-ended claim carries `open_ended: true`). A claim is `{label, display:
  'default'|'dimmed', reasons[], year_lo, year_hi, precision, date_text, relation, span, span_start, span_end,
  span_in_excerpt, entry_ids, url, license, attribution}`. Errors: 404 `E_NO_CLAIMS` (an adapter without claims),
  400 `E_VALIDATION` (no word/expr, lang not en/fr/es/hi/gu).

**Events** (`GET /api/events`): `data` → `DataEvent {dataVersion}`; `bootstrap` → `BootstrapEvent` (the Health.cipher
object, plus `ready[]` when phase A finishes); `adapter` → `AdapterEvent {id, loaded, staged, message, job?,
progress?, status?}` (`job` names the next job of a chained load, null at its end). Only tasks put objects on the
`adapter` and `bootstrap` channels; job progress travels on `job` alone (before, the queue mirrored job events onto
them and the UI merged a job status into `health.cipher`). `JobDoneEvent` may carry `result` (a chained load's
`result.continued_by` is the next job id).

**Vocabulary.** `DOC_KINDS` gains `periodical` (issues of science periodicals on the Gutenberg STEMM shelf).

**Writer and data.** Loading a source again (the Adapters page's "Load again") no longer duplicates its links or
annotations: an identical relationship (type, ends, status, origin, author, dataset, locator, run) or annotation
(target, kind, author, layer, first text) is skipped and counted (`relationships.duplicates`, `annotations.duplicates`
in the batch counts). A hypothesis group's target is the item whose source is asked about — the `src` every hypothesis
starts from (as `POST /api/relationships {group}` requires); boot repairs groups written by the 1.1.0 writer, which used
the first hypothesis's `dst` (logged "data repaired at boot").

**Sources (WP2).**
- `GET /api/adapters[?refresh=1]` items add `label`, `available`, `reason`, `command` (the fetcher to run yourself),
  `caveats`, `attribution`, `enabled`, `loadable` (false for `stemm.ngram`, read in place), `note`, `complete`,
  `job {id, status} | null` (a live chained load) and `load {status: running|done|cancelled|failed|interrupted,
  phase, part, progress, message, counts, coverage, resume, error, …}`. `?refresh=1` probes the staged files again.
- `POST /api/adapters/:id/load` validates per adapter: `collections[]`; OpenAlex `fields[]`, `years [lo, hi]`,
  `abstracts`; gutenberg-stemm `ids[]`; Wiktionary `expressionId`, `words[]`, `lang`. STEMM document loads run as a
  chain of ≈ 20 s `adapter-load` jobs; a live chain answers `{job, already_running: true}`. Cancelling a chain job
  (POST /api/jobs/:id/cancel) rolls back the running chunk only (its batch becomes `cancelled`), keeps the committed
  chunks (collections `partial`) and stops the chain; loading again resumes without duplicates. Errors: 409
  `E_NOTHING_TO_LOAD` (stemm.ngram), `E_ADAPTER_UNAVAILABLE` (with the fetcher command), `E_ADAPTER_DISABLED`;
  400 `E_APPROVAL_REQUIRED` (network adapters), `E_VALIDATION`.
- `GET /api/corpora` collections add `dating {stated, estimated, derived, period, announced, undated, after_1928}`.
- `GET /api/tour` steps may carry `pending` and `track: [{surface, lang, kind, corpus}]` (what to POST to
  /api/expressions so the step's strand resolves).
- `GET /api/baseline` takes `lang` (a language other than English answers `{available: false}`); a reversed
  `from`/`to` is 400. Caveats now include hyphen splitting and pre-1800 OCR noise (long s).

**Search, timeline, exports (WP3).**
- `GET /api/timeline/arcs` takes `rel_rev_cutoff`, `rev_cutoff`, `runs` (a saved view read as saved). Budgets per tier:
  L0 0 (bundles only), L1 150, L2+ 300. Scope: relationships with at least one end in a document where a pinned strand
  is observed (`scope: 'strands'`). New fields: `budget`, `chip {count, label: '+N more arcs (filtered)'} | null`,
  `halos[] {doc, passages[], y, lane, after, documented, proposed, annotated, synthetic, sources[{kind, rel_id |
  annotation, y, visible_from}], label: 're-read after 2016 (1 documented, 1 annotated)'}` (the client applies the
  vantage through `visible_from`), `annotated[] {annotation, author, layer, kind: 'annotation', label: 'annotated',
  feedback: true, evidence_status: 'proposed', src, dst, synthetic}`. Arc ends gain `lo_day`/`hi_day`; bundles gain
  `feedback`, `date_conflicts`, `synthetic`. Date conflicts are never feedback.
- `GET /api/timeline/tiles`: each tile may carry `days[lane][strand] = [[binIndexInTile, first lo_day, last hi_day]]`
  so caps sit at exact dates. A lane holding a top-cited-per-cell sample (OpenAlex) carries counts and states but **no
  rate or CI** (flag 8 `sampled`); its `POST /api/timeline/query` lane has `rate_note` ("Top-cited sample: 200 works per
  field × period. Counts only on the Scroll …"). Rates across OpenAlex's cells are refused (D14, §10.4); within-cell
  shares are in Compare.
- `GET /api/kwic`: `denominator {tokens, works, docs, from, to, lane, note} | null` (null while a large corpus's
  slice cube is still being built).
- `GET /api/expressions/:id` (and `Search.expression`): `claims[]` = the Wiktionary claims written on the expression
  as markers `{label, date {lo_year, hi_year, label}, display, reasons[], source, license, relation, highlight}`.
  Default claims first; `dimmed` ones say why (§10.2). Synthetic expressions have none.
- Exports: relationship exports and bundles carry the view's arcs; the manifest adds `relationship_scope`.
- Search: theme and maker typeahead come from persisted label indexes (folded tokens: "hip hop" finds "hip-hop"), with
  SQL fallbacks while they build; a word tracked in exactly one language is searched in that language.

**Analysis (WP4).**
- `POST /api/analysis/runs` stages: `cluster` `{expr | expressionId, representation: auto | tfidf-hash-4096 |
  ppmi-svd-pooled, with?}`, `layout`, `vectors {lang, corpora?, scope?: all | pooled | era, threads?}`, `drift` and
  `tone` (the Compare request `{expr, a, b, toggles?, corpus?}`), `tokstream`, `collocations`, `reuse-index
  {collections[]}`. Identical succeeded runs are reused.
- `GET /api/clusters?expr=&run=&rev_cutoff=` adds `expression`, `seed`, `newer_run`, `newer_note`, `method`, `k`,
  `selection` (the k candidates), `windows[] {id, label, lo, hi, state, note}`, `shares` (with document-block
  bootstrap CIs), `convergence` (J per window, CI, `reported`), `excluded`, `n`, `docs`, `note`; clusters add `ord`,
  `machine_label`, `human_label`, `human_label_at`, `label_annotation`, `top_doc_share`, `silhouette`, `tentative`,
  `residual`, `distinctive`, `card`; transitions add `from_ord`, `to_ord`, `window`, `window_label`, `year`, `score`,
  `nearest`, `cosine`, `text`, `evidence_status`. Gated payloads carry `value: null` and `fallback_lanes: 'language'`.
- `GET /api/constellation` params: `strands`, `a`, `b` (periods; A is always the earlier), `size` (occurrences | docs |
  authors), `edges` (cooc, member, occurs, rel, etym), `max_nodes`, `max_edges`, `expand=x:<id>`, `relayout=1`,
  `runs`, `rev_cutoff`, `corpus`. Adds `periods`, `diff` (only in A, only in B, grew > 2×), `gates.{cooc, member}`,
  `layout.{generation, seed, placed, toast, cache}`; nodes add `ref`, `status`, `tentative`, `machine_label`,
  `human_label`, `more`; edges add `present`, `rel_id`, `rel_type`, `family`, `evidence_status`, `review_status`,
  `run`, `note`; node types `word`, `document`, `etymon`; edge kinds `occurs`, `etym`. Gated edges have `weight` null.
- `POST /api/compare` adds `coverage.spaces {lang, language, pooled | null, pooled_gate, suggestion | null, era {slices
  [{years, tokens, docs, authors, eligible}], eligible, needs, note}}`; `within_cell {a: [{cell, field, years, k, n,
  share, ci, abstracts, text}], b, method, note}` for OpenAlex (never a cross-cell rate); a clusters block `{gate:
  'ok', run, representation, k, shares[{cluster, ord, label, human_label?, status, a {share, ci, n}, b}], n, docs,
  new_uses, declining, note}`; ok measures carry `percentile`, `jaccard`, `controls`, `anchors`, `mean_anchor_cos`,
  `neighbours`, `verdict`, `threshold_percentile`, `text`, `run`; tone `ok` = `{gate, label, method, model_version,
  run, a/b {n, docs, mean, ci, sd, median, histogram}}`. A gate card may carry `suggestion.run = {stage, params}`:
  exactly the body to POST to /api/analysis/runs.

**Lineage (WP5).**
- `POST /api/trace`: `near[].via` (`lsh` | `fts`), `near_index {run} | null`, `exclusion {kind: structure |
  widely_shared | production_line, note, documents?} | null` (when set, matches are listed and no links are made),
  `similar_wording[].kind` may be `near_short`; near matches need ≥ 8 aligned tokens.
- `GET /api/lineage?root=shared:<8 hex>` expands a "widely shared text" node: the node plus ≤ max_nodes − 1 recorded
  passages, links passage → node, `edges: []`, a `note`.
- `GET /api/genealogy`: `maker=` takes a name or a search maker slug (`maker:<slug>`); rows carry `collection` and
  `rate_eligible` (relation-endpoint works say "not in title rates"); defaults: types samples, interpolates, cover_of,
  remix_of, version_of · status documented · depth 3 · 150 rows.
- reuse-index run metrics: `counts`, `exclusions {kind: [samples]}`, `carried_reviews`, index file sizes. Review
  revisions carried to a newer run have `after.carried_from {relationship, rev, run}`. A gc-runs result has
  `index_files_removed`.

## Contract 1.3.0 (Term trail, context-group lanes, OpenAlex cells, arc summaries)

Additive: no endpoint is removed or renamed, every 1.2.0 body stays valid, and `schema_version` stays 1. New shapes in
`contracts.SHAPES`: `ShareCell`, `ArcBucket`; `Lane.label` may be an object (context groups). Vocabulary: lane facet
`trail`, rate units `count_of_works` (counted, never a rate) and `period_bands` (etymology), `vocab.TRAIL_LANES`,
`vocab.VIRTUAL_CORPORA`, `vocab.SHARE_LANE_NOTE`. The slice cube is version 3 (its cache files rebuild once).

**C1 — context-group lanes.** `POST /api/timeline/query` with `lanes: {facet: 'cluster', run?}` and exactly one expression
strand of one corpus:
- With a succeeded clustering run of the expression (the newest, or `lanes.run`, which also pins the materialization the
  run grouped): one lane per non-residual group, key `cluster:<run>:<ord>` (`~titles` / `~abstracts` for title and
  abstract evidence, as every lane key), then `cluster:<run>:residual` ("other contexts": residual groups and the
  occurrences the run did not group). The lanes partition the strand's counted matches, so the conservation law holds per
  lane and Σ lane n = the strand's total.
- Each lane: `label: {machine, human|null}` (the machine label stays visible beside a human rename), `label_text` (a
  sentence), `cluster_id`, `ord`, `run`, `status`, `tentative` (unstable), `stability`, `group_size`, `note` ("machine
  label (editable) — a computed hypothesis over context words, not a meaning").
- Tiles count occurrences per group with fit-or-wash; every group lane divides by its unit class's slice denominator
  (the expression's language/modality slice), so group rates are comparable; the unit is printed as on every lane.
- Top level: `lane_state: 'ok'` and `cluster {run, groups, residual_groups, href}` (transitions stay on
  `GET /api/clusters`: split, merge, emerge, vanish with dates, run, stability, cosine).
- Without a run: `lanes: []`, `lane_state: 'not_run'`, `suggestion: {run: {stage: 'cluster', params: {expressionId}}}`
  (the body to POST to `/api/analysis/runs`); a run made from an earlier materialization is `not_run` too, with
  `lane_note`. A gated run: `lane_state: 'gated'` and `gate {gate, value: null, needed, have, suggestion}` — never a
  group. Several strands, or a virtual corpus: `lane_state: 'unavailable'` (groups are computed per corpus). While the
  expression is still counted: `lane_state: 'pending'`. A very frequent expression (sampled occurrence rows) is gated.
- `gates.cluster` mirrors the state. The request also takes `rev_cutoff` (a saved view's human labels as saved).

**C2 — the Term trail and the virtual corpus `real`.**
- `real` (`vocab.VIRTUAL_CORPORA`) = every non-synthetic corpus that holds documents; the synthetic demo is never a
  member. It is accepted wherever a corpus slug is (`POST /api/timeline/query`, `GET /api/search`, `POST /api/expressions`,
  `GET /api/expressions/:id?corpus=real`, `PATCH /api/expressions/:id/variants?corpus=real`, viewstate `c=real`, whose
  default lanes are `trail`). `GET /api/corpora` lists it last: `{slug: 'real', kind: 'real', virtual: true, members:
  [slugs], available, collections: []}`.
- An expression is tracked per corpus: in `real` a strand stands for its siblings (same kind, language and folded form)
  in every member corpus; each keeps its own variants, runs and exclusions, and a lane's count in `real` is the sum of the
  member corpora counted alone (property-tested). `POST /api/expressions {corpus: 'real'}` tracks it in every member and
  answers the first member's expression with `members: [{corpus, id, state}]` and counts added up; a variant change sent
  with `corpus: 'real'` is applied to every member. The timeline query tracks missing siblings itself.
- `provenance.corpora` lists the member corpora (and `provenance.corpus` the virtual slug); `run_ids.materialize` names
  every member's run.
- `lanes.facet: 'trail'` answers the ordered, fixed lane set of `vocab.TRAIL_LANES`, every present lane (no folding,
  `other.lanes` 0), in this order: `trail:etymology` (period bands only: `bands[{strand, href: /api/etymology?expr=}]`,
  unit `period_bands`, no counts) · `trail:literature-text` (Cipher Gutenberg + Wikisource text, per million tokens) ·
  `trail:stemm-text:<field>` per STEMM field (Gutenberg STEMM text) · `trail:stemm-abstracts:<field>` per field with an
  OpenAlex mapping (unit `share_of_sampled_works`, C3; a work counts once whether its title or abstract matches) ·
  `trail:culture-titles` (culture works, per 1,000 works) · `trail:music-relations` (genealogy endpoints, works mode:
  `mode: 'works'`, unit `count_of_works`, counts and states but never a rate). Units are never pooled across lanes or media.
  Lanes carry `kind` and `trail_field`. `trail: {lanes, absent: [{key, label, reason}], outside: {strand: n}, note}`:
  the lanes the corpora cannot show and the counted matches outside every lane (user imports, describing passages,
  title stubs). Lane order is fixed (`lane_order_note`).
- Every query response (any facet) carries `baseline: {available, href, reason?}` for a single English word (the Ngram
  track; multi-word: `available: false`, "single words only") and `claims: [ClaimMarker]` (the Wiktionary markers written
  on the expression in any member corpus, display rule as built), plus `strand_extras` per strand.
- Wiktionary claims attach when an expression is tracked after a Wiktionary load: `POST /api/expressions` queues the
  `adapter-load` job `{adapter: 'stemm.wiktionary', expressionId}` (word-index lookup, same display rule) once per real
  word or phrase, whenever the word index is built and the adapter is enabled — queued after the expression's count, and
  also for a sibling that a query in `real` tracks. The entry document it writes is read by no count (lexical collections
  are outside every materialization), so no other expression is counted again.

**C3 — OpenAlex share cells.** On lanes with unit `share_of_sampled_works` the tiles carry no calendar cells and no
washes; `tiles[i].cells[lane][strand]` lists OpenAlex's own cells (field × one of its 30 bins) that overlap the tile's
years, at every tier: `{lo_year, hi_year, label, field, cell, k, n, n_cell, share, ci, state, text, owner}` — `n` =
sampled works of that cell with a title or abstract in the strand's languages, `k` = those that mention the strand,
`n_cell` = all sampled works of the cell in the slice, `share` = k / n with a Wilson 95% `ci`; `state` 'observed' ·
'absent' (k = 0) · 'low' (n < 20: no share, k and n shown) · 'uncovered' (n = 0). `owner` is true in the one tile
holding the cell's first year. Cells of OpenAlex fields that share a STEMM lane (Medicine and Nursing) stay separate
cells — never pooled; the lane lists them as `cell_fields`. Never a cross-cell rate or trend; the lane header says
"share of the top-cited sample in each cell — not a trend" (`note`). `GET /api/timeline/bin?…&lane=<share lane>&cell=<field|lo-hi>`
opens a cell's drawer: its numbers, then the works that mention the strand.

**C4 — arc summaries.** `GET /api/timeline/arcs` adds `mode`: 'individual' when at most 1,500 arcs fall in the requested
range after the filters (as before: items within the tier budget, the rest bundled); above that 'summary': `buckets:
[{src_lane, dst_lane, src_bin, dst_bin, src_years, dst_years, n, by_status: {documented, computed, proposed}, feedback,
date_conflicts, synthetic}]` (they add up to `total`; bins start at the tier's level and coarsen until at most 600
buckets, `bucket_level` / `bucket_width`), and `individual` (also `items`): the ≤ 300 highest-priority arcs — touching the
selected item (`sel=document:<id>|passage:<id>|occurrence:<id>`, marked `selected: true`), documented first, nearest the
vantage. `detail=1` over a range narrower than 50 years returns individual arcs up to 1,500. `total` now counts the arcs
in the requested range after the filters; `candidates` counts every relationship touching a strand document (the 1.2.0
`total`): `returned + Σ hidden = candidates`.

**C5 — etymology roots once.** `GET /api/etymology` adds `roots: [Etymon + {families: [etymon keys that list it],
is_family}]`, each listed root once (la:virus and *wisós list the same three PIE roots); `families[].parents` stay, with
`shared: true` on a parent more than one family lists.

**Performance (no shape change).** `GET /api/corpora` reads per-collection statistics kept as shared artifacts keyed by
each collection's inputs (a materialization no longer forces a rescan) and warmed when a load settles; the first corpus
list or search after boot warms every corpus's shared artifacts and loads them into every read worker; slice-cube keys
are per corpus and per scope (a Wiktionary entry or another corpus's import no longer rebuilds every cube); relation
endpoints and OpenAlex cells are separate artifacts read only by the Term trail; arcs read only the columns they draw.
The theme and maker label indexes are keyed by the collections they read (lexical entries left out). Transliteration
candidates (§4.5) are read from one shared vocabulary group per initial letter instead of a vocabulary scan per word.
A materialization reads every collection of its corpus except lexical ones (Wiktionary entry documents are claims, never
occurrences — §10.2), so the entry document written when a word is tracked after a Wiktionary load leaves every other
expression's count fresh; on a database that holds a Wiktionary collection, expressions of that corpus are counted once
more after the upgrade (their input fingerprint changes once).

### Final-gate additions (still 1.3.0, additive)

Recorded by the final integration gate (WP8) from the needs of parts A3–A5; every field is optional and every 1.3.0
body stays valid.
- **`GET /api/health` → `integrity`** (shape in `Health`): the boot-time check of `originals/` (server/db/integrity.mjs),
  run once in a read worker after the server listens: `{status: 'checking'|'ok'|'missing_originals'|'unknown',
  checked_at, files, missing_files, size_mismatch, referenced_missing, documents_affected, sample: [{sha256, rel_path,
  problem: 'missing'|'size', documents}], reason?}`. `missing_originals` means live documents were made from a file that is
  gone or truncated: their text still opens from the database, only the verbatim source bytes (§4.2) are lost. Absent in
  mock mode.
- **`POST /api/compare` → `baseline_rho`** (shape `BaselineRho`): Spearman ρ of the strand's per-decade rate against the
  Ngram baseline per million over the same decades (§10.2). Not possible (several expressions, not English, a phrase,
  OpenAlex cells, a non-text slice, no Ngram store) → `{available: false, reason, note}`. Otherwise a gate: `gate: 'ok'`
  with `value`, `ci` (moving-block bootstrap, blocks of 3 decades, 1,000 resamples, seed 42), `n_bins`, `span`, `method`,
  `text`; any other gate (fewer than 8 shared decades, or a constant rate) carries `value: null`, `ci: null` and
  `needed`/`have`/`suggestion`. `series[]` lists every decade with our `n`, `tokens`, `rate` (null below our rate gate,
  `low_coverage: true`) and Google's `baseline_per_million` and `volumes`; `shared` marks the decades ρ uses. An ok result
  carries the note "Different corpus, different composition: … ρ only says whether the two decade series rise and fall
  together"; a gated one says in `note` what is missing.
- **Lane `first` / `last`** (`POST /api/timeline/query`, every facet, lanes and `strands`) add `basis` (the document's date
  basis, as on its date card: stated · estimated · derived · period · announced) and `document` (its id), so "first
  observed in this corpus 1906 (stated)" needs no passage lookup. The first passage itself is still found through
  `GET /api/kwic?…&sort=date&limit=1`.
- **Jobs:** analysis jobs (cluster, vectors, drift, tone, collocations) check their inputs inside the transaction that
  stores a run and fail with `E_INPUTS_CHANGED` (409) when an import into their own collections committed meanwhile. They
  still run as writers (`vocab.JOB_TYPES` unchanged): the queue has no job dependencies, and the demo's pipeline
  (materialize → cluster → the deferred label rename) relies on writer serialization for its order.
- **Writes:** job rows are inserted without waiting for the write lock (kept in memory while a job holds it, written within
  20 ms of it coming free; `GET /api/jobs/:id`, list, counts and cancel see them at once). An interactive write waits
  at most 25 ms, is then parked and re-run inside its own transaction once the lock is free; after 60 s it answers 503
  `E_BUSY`. An upload is parked only while its body is unread.

### Reference changes at `ref-freeze-1` (still 1.3.0, additive; R, IOS-SPEC §2.1)

The native port's reference is frozen at the git tag `ref-freeze-1`. Every change and its test is listed in
`Native/Docs/REFERENCE-CHANGES.md`. Every field below is optional; every 1.3.0 body stays valid and every fixture still
round-trips.
- **RF-1 — the language rule of every count** (`server/aggregate/langgate.mjs`). An unidentified row (`und`, `und-Latn`)
  of a document's running text (field classes text, abstract, apparatus) counts in a strand's languages only when the
  document's text language (`document.lang_text`) is one of them, or is itself unidentified. Title rows and describing
  passages keep their own language. The rule applies in the slice cube, which is now version 5 (it carries each
  document's language; its cache files rebuild once). It also applies in the SQL slice (numerators, marks, KWIC, search,
  exports), in the `other_language` exclusion bucket, in Compare (coverage, frequency, passages, collocates,
  convergence, tone), in the seam's "full text in these languages", and in clustering's occurrence selection and
  coverage. Response shapes are unchanged; counts and denominators move. Example: Cipher *machine* no longer divides by
  the unidentified headings of Spanish and French books.
- **RF-2 — as saved, everywhere a saved view shows a number** (D17).
  - `POST /api/compare` takes `runs` (`{materialize: {<expr id>: <run id>}, cluster?: <run id>}`) and `cutoffs`
    (`{import_batch?, at?, annotation_rev?}`), the pins and cutoffs of a view opened as saved.
    - Pins of expressions outside `expr` are dropped.
    - A pin that is not a succeeded count of its expression answers 400 `E_VALIDATION` (`field: 'runs'`).
    - The comparison then uses the pinned counting runs, and only the documents of imports up to the cutoff. Documents
      soft-deleted after `at` still count.
    - Context groups use the pinned clustering run, or else the newest one that had finished at `at`. Reader labels and
      the human counts are read as they stood at `annotation_rev`.
    - Drift and tone runs started from such a comparison carry the same pins and cutoffs. An as-saved run is its own
      comparison: its params hash differs from the same comparison on current data.
    - The response carries `as_saved: {runs, cutoffs, note}`, and only then.
    - The multiplicity log treats an as-saved comparison as the same comparison.
  - `GET /api/kwic?expr=…` takes `runs` (comma-separated run ids; the expression's own counting run among them is used),
    `import_batch` and `at`: the inspector's contemporary-uses and any-later counts as saved.
  - The page sends these from `ui.savedView` in three places: the Compare panel (`compareRequest(view, {saved})`); the
    inspector (concordance, lineage with `rel_rev_cutoff`/`runs`, hypotheses with `rev_cutoff`, context groups with the
    pinned run and `rev_cutoff`); and its Crossings card (the trail query with the pinned runs and cutoffs).
- **RF-3 — the verify journey** (`scripts/verify-journey.mjs`) adds:
  - tiles at L0–L5 with the conservation check;
  - a saved view of the imported text, opened as saved at once;
  - a link review;
  - an import reverted after the save, then the view as saved: timeline, tiles, concordance and lineage;
  - as-saved Compare.

  `npm run verify -- --record <file.jsonl>` writes every request and response as JSONL; the format is at the head of the
  script.

## Mock mode

`SCROLLS_MOCK=1 npm start` serves every endpoint from `tests/contract/*.json` through
[`server/http/mock.mjs`](../server/http/mock.mjs) (`mockRoutes(contractDirUrl)`), so the UI packages can build against the
contract before the real routes exist.

- **One file per endpoint**: `<METHOD>__<path>.json`, where the path drops its leading `/`, `/` becomes `_` and a
  `:param` segment is written `{param}` — `GET /api/passages/:id` → `GET__api_passages_{id}.json` (no `:` in file names).
- **Variants.** A fixture holds named variants (`ok`, `gated`, `empty`, `error`, `not_found` …). The variant served is
  the one named by the `X-Scrolls-Mock` request header or the `mock` query parameter; otherwise the first whose `when`
  (`{query, params, body}` of expected values) matches the request; otherwise the fixture's `default`. Responses name the
  variant in `X-Scrolls-Mock-Variant` and list the others in `X-Scrolls-Mock-Variants`.
- **From the browser**: open `/?mock=gated` (or `empty`, `error` …) and `core/api.mjs` sends that variant name with every
  request (EventSource gets it as `?mock=`). Endpoints without that variant answer with their default.
- **Requests are validated** against the endpoint's request shape exactly as the real server would (`400 E_VALIDATION`
  with the mismatches in `detail`), unless a variant is named explicitly.
- **Labelled.** Mock `/api/health` bodies say `"mock": true`; the page then shows a fixed "MOCK API" badge, because canned
  numbers are not anyone's data. Fixtures about the demo use the synthetic world of SPEC §9; the few about Cipher use only
  facts measured in SPEC §0.1 or carry a `mock_note`.
- **Fixture file format**: `"//"` (owner line), `method`, `path`, `owner`, `request` and `response` (shape names),
  `summary`, `default`, `example_request`, `variants: {name: {note?, when?, status, shape?, unshaped?, content_type?,
  request?, keep_open?, events? | text? | base64? | body?}}`. A variant's shape is its own `shape`, else `response` for a
  success and `ErrorBody` for status ≥ 400; `"shape": null` needs an `unshaped` reason.
- **Changing the contract** is the WP0 owner's job (§12.3): additive shape change in `contracts.mjs`, bump
  `CONTRACT_VERSION` (minor), update the fixtures and this page in one commit. `tests/contract-fixtures.test.mjs` fails
  when a fixture breaks its shape, a gate carries a numeral, a synthetic name is unlabelled, or this index misses a variant.

### Validating real responses in tests

```js
import { assertShape, checkResponse } from './helpers/shape.mjs';
assertShape('Passage', body);                                    // AssertionError listing every mismatch
const body = await checkResponse(res, 'GET', '/api/passages/901'); // status ≥ 400 → ErrorBody; route found by pattern
```

## Fixture index

Every variant of every fixture, generated from `tests/contract/`.

#### `DELETE__api_views_{slug}.json` — DELETE `/api/views/:slug` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 204 | none | **default** |  |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_adapters.json` — GET `/api/adapters` (WP2)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Adapters` | **default** |  |
| `empty` | 200 | `Adapters` | header / `?mock=` | No adapter modules registered. |
| `stemm_loaded` | 200 | `Adapters` | header / `?mock=` | Real (M5 gate, private clone): the four STEMM adapters after loading gutenberg-stemm, OpenAlex and Wiktionary; contract 1.2.0 fields load, job, complete, loadable, note. Caveats quoting the staged FORMAT.md that use a rule-11 word are left out of this fixture. |
| `error` | 403 | `ErrorBody` | header / `?mock=` | E_FORBIDDEN_ORIGIN |

#### `GET__api_adapters_{id}_claims.json` — GET `/api/adapters/:id/claims` (WP2; contract 1.2.0, M5 gate)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok_expr` | 200 | `AdapterClaims` | **default** | Real (M5 gate, private clone): the claim written on the tracked 'gene', shown by default. The quoted Wiktionary span is left out of this fixture (the copy scanner reads fixtures). |
| `dimmed` | 200 | `AdapterClaims` | query expr="6" | Real: 'virus' — the statement dates the computer sense only, so it is dimmed with its reason. |
| `ok_word` | 200 | `AdapterClaims` | query word="laser" | Real: a word-index lookup, not yet written on an expression (first two claims). Quoted Wiktionary spans are left out of this fixture. |
| `index_not_built` | 200 | `AdapterClaims` | header / `?mock=` | The word index is built by the first Wiktionary load. |
| `no_claims` | 404 | `ErrorBody` | header / `?mock=` | E_NO_CLAIMS |
| `bad_request` | 400 | `ErrorBody` | header / `?mock=` | E_VALIDATION |

#### `GET__api_analysis_runs.json` — GET `/api/analysis/runs` (WP4)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `AnalysisRuns` | **default** |  |
| `empty` | 200 | `AnalysisRuns` | query stage="vectors" |  |
| `error` | 403 | `ErrorBody` | header / `?mock=` | E_FORBIDDEN_ORIGIN |

#### `GET__api_annotations.json` — GET `/api/annotations` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Annotations` | **default** |  |
| `with_superseded` | 200 | `Annotations` | query include="superseded" |  |
| `empty` | 200 | `Annotations` | query target="passage:21" |  |
| `error` | 403 | `ErrorBody` | header / `?mock=` | E_FORBIDDEN_ORIGIN |

#### `GET__api_annotations_{id}_revisions.json` — GET `/api/annotations/:id/revisions` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `AnnotationRevisions` | **default** |  |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_baseline.json` — GET `/api/baseline` (WP2)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Baseline` | **default** |  |
| `multiword` | 200 | `Baseline` | query word="carry the zero" | The Ngram store holds 1-grams only. |
| `not_staged` | 200 | `Baseline` | header / `?mock=` |  |
| `other_language` | 200 | `Baseline` | query lang="fr" | Real: lang=fr (contract 1.2.0); the Ngram store is English-only. |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |

#### `GET__api_clusters.json` — GET `/api/clusters` (WP4)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Clusters` | **default** |  |
| `gated` | 200 | `Clusters` | query expr="13" |  |
| `not_run` | 200 | `Clusters` | header / `?mock=` |  |
| `real_demo` | 200 | `Clusters` | header / `?mock=` | Real demo run (M5 gate): carry the zero, k = 4, TF-IDF hash, ARI 0.992 against the planted senses. |
| `error` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_collocations.json` — GET `/api/collocations` (WP4)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Collocations` | **default** |  |
| `gated` | 200 | `Collocations` | query expr="13" |  |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |

#### `GET__api_constellation.json` — GET `/api/constellation` (WP4)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Constellation` | **default** |  |
| `truncated` | 200 | `Constellation` | header / `?mock=` | Bounded: ≤ 150 nodes, ≤ 400 edges; "+38 more". |
| `two_periods` | 200 | `Constellation` | header / `?mock=` | Real demo response (M5 gate): carry the zero, A 1955–1985 vs B 1994–2026; nodes keep their positions across periods. |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |

#### `GET__api_corpora.json` — GET `/api/corpora` (WP2)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Corpora` | **default** |  |
| `demo_only` | 200 | `Corpora` | header / `?mock=` | Cipher files absent: the Cipher corpus has no collections. |
| `with_stemm` | 200 | `Corpora` | header / `?mock=` | Real (M5 gate): demo, Cipher and the loaded STEMM corpus; collections carry 1.2.0 dating counts. Caveats quoting the staged FORMAT.md that use a rule-11 word are left out of this fixture. |
| `error` | 403 | `ErrorBody` | header / `?mock=` | E_FORBIDDEN_ORIGIN |
| `with_real` | 200 | `Corpora` | header / `?mock=` | Real (contract 1.3.0, the m5-stemm clone): the corpora, then the virtual corpus 'real' (virtual: true, its member corpora, no collections of its own). Caveats quoting a rule-11 word are left out. |

#### `GET__api_documents_{id}.json` — GET `/api/documents/:id` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Document` | **default** |  |
| `metadata_only` | 200 | `Document` | params id="61234" |  |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_documents_{id}_text.json` — GET `/api/documents/:id/text` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `DocumentText` | **default** |  |
| `out_of_range` | 400 | `ErrorBody` | header / `?mock=` | E_RANGE |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_etymology.json` — GET `/api/etymology` (WP3; contract 1.2.0, M5 gate)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `zero` | 200 | `Etymology` | **default** | Real Cipher roots data: 'zero' lists Latin zephirum and Sanskrit śūnyá, whose two listed roots are likely a chain (not stated). |
| `virus` | 200 | `Etymology` | query expr="5" | Real: la:virus and PIE *wisós each list the same three roots; how they relate is not recorded (listed_unresolved). 1.3.0: `roots` lists each once with both families (C5). |
| `no_family` | 200 | `Etymology` | header / `?mock=` | Real: 'bug' has no family in roots.tsv (Latin, Greek, Sanskrit, PIE only). |
| `phrase` | 200 | `Etymology` | query expr="1" | Multi-word expressions have no families. |
| `bad_id` | 400 | `ErrorBody` | header / `?mock=` | E_VALIDATION |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_occurrences_{id}.json` — GET `/api/occurrences/:id` (WP3; contract 1.1.0, M1 gate)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `o55012` | 200 | `Occurrence` | **default** |  |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_events.json` — GET `/api/events` (WP0)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | SSE: job, job, data, bootstrap, adapter (stays open) | **default** |  |
| `error` | 403 | `ErrorBody` | header / `?mock=` | E_FORBIDDEN_ORIGIN |

#### `GET__api_export.json` — GET `/api/export` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `json` | 200 | — (unshaped) | **default** | Download (format=json): { manifest, rows } — no shape in contracts.SHAPES yet. |
| `jsonl` | 200 | text (application/x-ndjson; charset=utf-8) | query format="jsonl" | Download (format=jsonl): manifest line, then one row per line. |
| `csv` | 200 | text (text/csv; charset=utf-8) | query format="csv" | Download (format=csv): # manifest lines, header, rows. |
| `invalid` | 400 | `ErrorBody` | header / `?mock=` | E_EXPORT_FORMAT |

#### `GET__api_expressions_{id}.json` — GET `/api/expressions/:id` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ready` | 200 | `Expression` | **default** |  |
| `materializing` | 200 | `Expression` | header / `?mock=` |  |
| `with_claims` | 200 | `Expression` | header / `?mock=` | Real (M5 gate): 'gene' tracked in the STEMM corpus with the Wiktionary claim written on it (contract 1.2.0 claims). |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_facets.json` — GET `/api/facets` (WP2)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Facets` | **default** |  |
| `empty` | 200 | `Facets` | query f="lang:la" |  |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |

#### `GET__api_genealogy.json` — GET `/api/genealogy` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Genealogy` | **default** |  |
| `empty` | 200 | `Genealogy` | query work="document:27" |  |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |

#### `GET__api_health.json` — GET `/api/health` (WP0)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Health` | **default** | Cipher metadata ready; full text indexing (phase B). |
| `bootstrap_metadata` | 200 | `Health` | header / `?mock=` | First minute: metadata-first import (D10). |
| `cipher_missing` | 200 | `Health` | header / `?mock=` |  |
| `ready` | 200 | `Health` | header / `?mock=` |  |
| `error` | 403 | `ErrorBody` | header / `?mock=` | E_FORBIDDEN_ORIGIN |
| `integrity_ok` | 200 | `Health` | header / `?mock=` | Real (final gate, contract 1.3.0): a server on an m5-stemm clone after the boot-time check of originals/ — 1,408 files, none missing. |

#### `GET__api_hypothesis-groups_{id}.json` — GET `/api/hypothesis-groups/:id` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `HypothesisGroup` | **default** |  |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_imports_{id}_preview.json` — GET `/api/imports/:id/preview` (WP1)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `ImportPreview` | **default** |  |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_imports_{id}_problems.csv.json` — GET `/api/imports/:id/problems.csv` (WP1)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | text (text/csv; charset=utf-8) | **default** | CSV download: code,severity,line,col,field,value_excerpt,message,suggestion. |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_jobs.json` — GET `/api/jobs` (WP0)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `JobList` | **default** |  |
| `empty` | 200 | `JobList` | query status="cancelled" |  |
| `error` | 403 | `ErrorBody` | header / `?mock=` | E_FORBIDDEN_ORIGIN |

#### `GET__api_jobs_{id}.json` — GET `/api/jobs/:id` (WP0)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `running` | 200 | `Job` | **default** |  |
| `succeeded` | 200 | `Job` | params id="288" |  |
| `failed` | 200 | `Job` | params id="295" | A failed import job carries the error with message and hint. |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_jobs_{id}_events.json` — GET `/api/jobs/:id/events` (WP0)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `succeeded` | 200 | SSE: progress, progress, progress, done | **default** |  |
| `cancelled` | 200 | SSE: progress, done | header / `?mock=` |  |
| `failed` | 200 | SSE: progress, done | header / `?mock=` |  |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_kwic.json` — GET `/api/kwic` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Kwic` | **default** |  |
| `empty` | 200 | `Kwic` | query from="1940", to="1949" |  |
| `with_denominator` | 200 | `Kwic` | header / `?mock=` | Real (M5 gate): 'virus' in the STEMM corpus, with the 1.2.0 denominator of what the rows were drawn from. |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |

#### `GET__api_lineage.json` — GET `/api/lineage` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Lineage` | **default** |  |
| `truncated` | 200 | `Lineage` | query max_nodes="150" |  |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |

#### `GET__api_lineage_path.json` — GET `/api/lineage/path` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `LineagePath` | **default** |  |
| `empty` | 200 | `LineagePath` | query to="passage:21" |  |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |

#### `GET__api_passages_{id}.json` — GET `/api/passages/:id` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `p901` | 200 | `Passage` | **default** | The 1994 Hip-hop mark of the first 60 seconds (§1.11). |
| `p77` | 200 | `Passage` | params id="77" |  |
| `p140_gu` | 200 | `Passage` | params id="140" | Gujarati; date derived from Vikram Samvat. |
| `title_cipher` | 200 | `Passage` | params id="61234" | A real culture-works title passage (metadata only, no lyrics). |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_relationships_{id}.json` — GET `/api/relationships/:id` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `r7811` | 200 | `Relationship` | **default** | Human-proposed allusion in hypothesis group 4, disputed. |
| `r7781` | 200 | `Relationship` | params id="7781" | Documented (synthetic liner-note record). |
| `r7790` | 200 | `Relationship` | params id="7790" | Computed 13-token exact quotation (run 9). |
| `r7795` | 200 | `Relationship` | params id="7795" | Attribution cue: proposed + CUE, confirmed by A, rejected by B → disputed; the line style never changes. |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_search.json` — GET `/api/search` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `demo` | 200 | `Search` | **default** |  |
| `hackers` | 200 | `Search` | query q="hackers" | SPEC §7.2 example (real titles: Hackers, film, 1995). |
| `empty` | 200 | `Search` | query q="hacker" | Computed empty state (§8.8): 0 is an observation about this index. |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |

#### `GET__api_snapshots_{file}.json` — GET `/api/snapshots/:file` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | binary (image/png) | **default** | Binary image (1×1 placeholder in mock mode). |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `GET__api_timeline_arcs.json` — GET `/api/timeline/arcs` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Arcs` | **default** | The rejected allusion (hospital → graffiti, §9.4 P3) is hidden by default and counted under hidden.rejected. |
| `documented_only` | 200 | `Arcs` | query ev="documented" |  |
| `bundled` | 200 | `Arcs` | header / `?mock=` | Zoomed out past the budget: arcs bundled per (lane pair, bin pair), width ∝ log2(count + 1). |
| `halos` | 200 | `Arcs` | header / `?mock=` | Real demo response (M5 gate, L2, vantage 2026): tier budget, halos with visible_from, no chip (10 arcs ≤ 300). |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |
| `summary` | 200 | `Arcs` | header / `?mock=` | Real (1.3.0): 'gene' in the STEMM corpus at L2 — 21,490 arcs in range → mode summary (C4): every bucket, individual arcs trimmed to 25 of 300. |

#### `GET__api_timeline_bin.json` — GET `/api/timeline/bin` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `BinDrawer` | **default** |  |
| `low` | 200 | `BinDrawer` | query bin="189" |  |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |
| `share_cell` | 200 | `BinDrawer` | query cell=… | Real (1.3.0): the drawer of one OpenAlex share cell; its rows (OpenAlex abstracts, never exported) are left out. |

#### `GET__api_timeline_marks.json` — GET `/api/timeline/marks` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Marks` | **default** | 1990–1999: Hip-hop and Criticism (§9.3 anchors A15, A16 + generated). |
| `truncated` | 200 | `Marks` | query limit="5" |  |
| `empty` | 200 | `Marks` | query from="1940", to="1949" | The 1940s: no sources (archive gap, synthetic). |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |

#### `GET__api_timeline_shelf.json` — GET `/api/timeline/shelf` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `undated` | 200 | `Shelf` | **default** |  |
| `scheduled` | 200 | `Shelf` | query which="scheduled" |  |
| `washes` | 200 | `Shelf` | query which="washes" |  |
| `empty` | 200 | `Shelf` | query lane="community:software" |  |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |

#### `GET__api_timeline_tiles.json` — GET `/api/timeline/tiles` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Tiles` | **default** | Demo L2, tiles 2–3 (1280–2559). 1940s: no cell anywhere (no sources). Hip-hop 1980s: absent (0 in 6.2k tokens). Classroom 1890s: low. |
| `pending` | 200 | `Tiles` | header / `?mock=` | The collection is still indexing: every cell is pending ("indexing — not yet looked"). |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |
| `share_cells` | 200 | `Tiles` | header / `?mock=` | Real (1.3.0): tile 3 at L2 of the Term trail of 'gene' in corpus real, trimmed to four lanes, with OpenAlex share cells (C3). |

#### `GET__api_tour.json` — GET `/api/tour` (WP2)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Tour` | **default** |  |
| `track_pending` | 200 | `Tour` | header / `?mock=` | Real (M5 gate): on a database where 'zero' is not tracked yet, step 10 is pending and says what to POST to /api/expressions. |
| `error` | 409 | `ErrorBody` | header / `?mock=` | E_DEMO_NOT_LOADED |

#### `GET__api_views.json` — GET `/api/views` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Views` | **default** |  |
| `empty` | 200 | `Views` | query q="nothing" |  |
| `error` | 403 | `ErrorBody` | header / `?mock=` | E_FORBIDDEN_ORIGIN |

#### `GET__api_views_{slug}.json` — GET `/api/views/:slug` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `View` | **default** |  |
| `drift` | 200 | `View` | header / `?mock=` | Request with X-Scrolls-Mock: drift. |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `PATCH__api_annotations_{id}.json` — PATCH `/api/annotations/:id` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `AnnotationRev` | **default** |  |
| `machine` | 409 | `ErrorBody` | header / `?mock=` | E_MACHINE_ANNOTATION |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `PATCH__api_expressions_{id}_variants.json` — PATCH `/api/expressions/:id/variants` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Expression` | **default** |  |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `POST__api_adapters_{id}_enable.json` — POST `/api/adapters/:id/enable` (WP2)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Adapters` | **default** |  |
| `needs_approval` | 400 | `ErrorBody` | header / `?mock=` | E_APPROVAL_REQUIRED |

#### `POST__api_adapters_{id}_load.json` — POST `/api/adapters/:id/load` (WP2)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `JobRef` | **default** |  |
| `unavailable` | 409 | `ErrorBody` | header / `?mock=` | E_ADAPTER_UNAVAILABLE |
| `needs_approval` | 400 | `ErrorBody` | header / `?mock=` | E_APPROVAL_REQUIRED |

#### `POST__api_analysis_runs.json` — POST `/api/analysis/runs` (WP4)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `AnalysisRunStarted` | **default** |  |
| `reused` | 200 | `AnalysisRunStarted` | header / `?mock=` | Same input fingerprint as run 14: nothing is recomputed. |
| `invalid` | 400 | `ErrorBody` | header / `?mock=` | E_VALIDATION |

#### `POST__api_annotations.json` — POST `/api/annotations` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `AnnotationRev` | **default** |  |
| `invalid` | 400 | `ErrorBody` | header / `?mock=` | E_VALIDATION |

#### `POST__api_annotations_{id}_reinterpret.json` — POST `/api/annotations/:id/reinterpret` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `AnnotationReinterpreted` | **default** |  |
| `conflict` | 409 | `ErrorBody` | header / `?mock=` | E_ANNOTATION_SUPERSEDED |

#### `POST__api_annotations_{id}_withdraw.json` — POST `/api/annotations/:id/withdraw` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `AnnotationRev` | **default** |  |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `POST__api_compare.json` — POST `/api/compare` (WP4)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Compare` | **default** | §9.6: sense_share_jsd ok; aligned displacement refused (slice_too_small, value null). |
| `gated` | 200 | `Compare` | body expr="[15]" | ◉ kiln eye (§9.6): insufficient_occurrences, suggestion null, "no widening inside this corpus reaches the gate". |
| `modality_mismatch` | 200 | `Compare` | header / `?mock=` | Cross-modality refused by default (D15). |
| `drift_not_run` | 200 | `Compare` | header / `?mock=` | Real (M5 gate): Cipher 'machine', Gutenberg text 1875–1899 vs 1900–1928, before any drift run: (b) and (c) are not_run with suggestion.run, the exact body to POST to /api/analysis/runs. |
| `drift_ok` | 200 | `Compare` | header / `?mock=` | Real (M5 gate): the same comparison after its drift run — neighbour overlap and aligned displacement with 500 controls, 4,142 anchors, verdict at the k = 2 threshold (97.5th percentile). |
| `invalid` | 400 | `ErrorBody` | header / `?mock=` | E_VALIDATION |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |
| `freq_gated` | 200 | `Compare` | header / `?mock=` | Added at the M1 gate from a real demo response: slice A (1906) is under the demo coverage gate, so freq.a and freq.rate_ratio are gated (insufficient_coverage, value null) with a widening suggestion; freq.b keeps its rate. |
| `collocates_not_run` | 200 | `Compare` | header / `?mock=` | Added at the M1 gate from a real Cipher response (public-domain Gutenberg text): slices of 5M and 10M tokens without current token streams → collocates gated not_run with suggestion.run {stage: tokstream}. Passages trimmed to two per slice. |
| `baseline_rho_ok` | 200 | `Compare` | header / `?mock=` | Real (final gate, contract 1.3.0): Cipher 'machine', Gutenberg text 1800–1874 vs 1875–1928 on the m5-stemm snapshot — baseline_rho gate ok: Spearman ρ 0.9 [0.29, 0.92] over 12 shared decades against the Ngram baseline. Passages trimmed to one per slice. |
| `baseline_rho_gated` | 200 | `Compare` | header / `?mock=` | Real (final gate): the same word, 1900–1914 vs 1915–1928 — only 2 shared decades of the 8 needed, so baseline_rho is gated (insufficient_coverage) with no value. Passages trimmed to one per slice. |

#### `POST__api_expressions.json` — POST `/api/expressions` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `materializing` | 200 | `Expression` | **default** |  |
| `ready` | 200 | `Expression` | header / `?mock=` | Already tracked: counts are known. |
| `invalid` | 400 | `ErrorBody` | header / `?mock=` | E_VALIDATION |
| `real_members` | 200 | `Expression` | body corpus="real" | Real (1.3.0): 'gene' tracked in the virtual corpus real — the first member's expression, counts added up, each member's own state under members. The claim's relation word is left out (copy scanner). |

#### `POST__api_hypothesis-groups.json` — POST `/api/hypothesis-groups` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Created` | **default** |  |
| `invalid` | 400 | `ErrorBody` | header / `?mock=` | E_VALIDATION |

#### `POST__api_imports.json` — POST `/api/imports` (WP1)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `ImportCreated` | **default** |  |
| `encoding_fallback` | 200 | `ImportCreated` | header / `?mock=` |  |
| `dup_file` | 409 | `ErrorBody` | header / `?mock=` | E_DUP_FILE |
| `too_large` | 413 | `ErrorBody` | header / `?mock=` | E_FILE_TOO_LARGE |

#### `POST__api_imports_{id}_commit.json` — POST `/api/imports/:id/commit` (WP1)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `JobRef` | **default** |  |
| `conflict` | 409 | `ErrorBody` | header / `?mock=` | E_IMPORT_STATE |

#### `POST__api_imports_{id}_revert.json` — POST `/api/imports/:id/revert` (WP1)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `JobRef` | **default** |  |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `POST__api_jobs_{id}_cancel.json` — POST `/api/jobs/:id/cancel` (WP0)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `cancelling` | 200 | `JobCancel` | **default** |  |
| `finished` | 200 | `JobCancel` | params id="288" |  |
| `not_found` | 200 | `JobCancel` | params id="999" |  |
| `error` | 403 | `ErrorBody` | header / `?mock=` | E_FORBIDDEN_ORIGIN |

#### `POST__api_relationships.json` — POST `/api/relationships` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Created` | **default** |  |
| `invalid` | 400 | `ErrorBody` | header / `?mock=` | E_VALIDATION |

#### `POST__api_relationships_{id}_evidence.json` — POST `/api/relationships/:id/evidence` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Created` | **default** |  |
| `invalid` | 400 | `ErrorBody` | header / `?mock=` | E_VALIDATION |
| `not_found` | 404 | `ErrorBody` | header / `?mock=` | E_NOT_FOUND |

#### `POST__api_relationships_{id}_review.json` — POST `/api/relationships/:id/review` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `confirmed` | 200 | `Review` | **default** |  |
| `disputed` | 200 | `Review` | body action="reject" | One confirm and one reject → disputed. |
| `invalid` | 400 | `ErrorBody` | header / `?mock=` | E_VALIDATION |

#### `POST__api_snapshots.json` — POST `/api/snapshots` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `Snapshot` | **default** |  |
| `invalid` | 400 | `ErrorBody` | header / `?mock=` | E_VALIDATION |

#### `POST__api_timeline_query.json` — POST `/api/timeline/query` (WP3)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ready` | 200 | `TimelineQuery` | **default** |  |
| `materializing` | 200 | `TimelineQuery` | header / `?mock=` | Counting in progress: show the lane skeleton and "counting… 41%" from the job SSE, never a spinner without a number. |
| `cipher_seam` | 200 | `TimelineQuery` | body corpus="cipher" | Text + titles lanes → the permanent 1928 modality seam. |
| `error` | 503 | `ErrorBody` | header / `?mock=` | QUERY_TIMEOUT |
| `trail_real` | 200 | `TimelineQuery` | body corpus="real" | Real (1.3.0): 'gene' in corpus real, lanes = the Term trail's fixed set (C2), with baseline and claims. |
| `cluster_lanes` | 200 | `TimelineQuery` | header / `?mock=` | Real (1.3.0): demo 'carry the zero', lanes = context groups of a clustering run (C1). |
| `cluster_not_run` | 200 | `TimelineQuery` | header / `?mock=` | Real (1.3.0): Cipher 'machine' — no clustering run: lane_state not_run with suggestion.run. |
| `cluster_gated` | 200 | `TimelineQuery` | header / `?mock=` | Real (1.3.0): Cipher 'war' — the clustering run is gated (no_cluster_structure): the gate, no lanes, no numeral. |

#### `POST__api_trace.json` — POST `/api/trace` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `done` | 200 | `Trace` | **default** |  |
| `running` | 200 | `Trace` | header / `?mock=` |  |
| `excluded` | 200 | `Trace` | header / `?mock=` | Contract 1.2.0 (WP5 P2): a span of production-line text lists its matches but makes no link. Canned values in the shape lineage/trace.mjs returns. |
| `invalid` | 400 | `ErrorBody` | header / `?mock=` | E_VALIDATION |

#### `POST__api_views.json` — POST `/api/views` (WP5)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `ViewSaved` | **default** |  |
| `resaved` | 200 | `ViewSaved` | header / `?mock=` | Saving again from a saved view creates a new slug; the original never changes. |
| `invalid` | 400 | `ErrorBody` | header / `?mock=` | E_VALIDATION |

#### `PUT__api_imports_{id}_mapping.json` — PUT `/api/imports/:id/mapping` (WP1)

| Variant | Status | Body | Selected by | Note |
|---|---|---|---|---|
| `ok` | 200 | `ImportValidation` | **default** |  |
| `invalid_mapping` | 400 | `ErrorBody` | header / `?mock=` | E_MAPPING_INVALID |
