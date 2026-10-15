# Scrolls: A Living Atlas of Meaning. Systems-first proposal

*Author: architect 3 of 3 (systems-first). Date: 2026-10-03. Status: proposal for review.*
*Grounded in `Docs/brief.md`, `Docs/data-inventory.md`, and direct inspection of the Cipher files. Every number marked "measured" below came from running a command against the data on disk today.*

---

## 0. Decisions on one page

| # | Decision | Why (one line) |
|---|---|---|
| D1 | **The aggregation base is the per-(expression, document) count**, not the occurrence. | There are ≤ 200k documents, so any lane × bin × filter grouping is a join of at most about 100k rows and returns in under 60 ms. Occurrences are only needed for evidence and marks. |
| D2 | **Occurrences are materialized lazily, per expression**, and cached forever (run-versioned). | Storing all 68M token positions buys nothing. Users explore hundreds of expressions, not millions. |
| D3 | **FTS5 is used only for candidate retrieval.** Exact offsets come from a JS locator that runs on the verbatim passage text. | That makes offsets correct by construction (`original.slice(start,end)`) and testable. FTS5 never decides what counts. |
| D4 | **FTS5 tokenizer `unicode61 remove_diacritics 0 categories 'L* N* Co M*'`** runs over text we normalize ourselves in JS. | Measured: the default `unicode61` breaks Devanagari into pieces (`किताब` → `क`, `त`, `ब`). Adding `M*` keeps words whole. |
| D5 | **Time is one REAL: astronomical decimal year, stored as half-open ranges `[t_lo, t_hi)`**, with a precision enum and a basis enum. | One number line runs from PIE to a given day in 2026. BCE is display-only formatting. |
| D6 | **Precision-aware binning.** A record counts in a bin only if its date range fits within that bin. Otherwise it goes to a visible "imprecise" sub-row. | Without this, a "1990s" item would silently become 1995 data. |
| D7 | **There are two denominators and they are never mixed**: per-million tokens for full text, per-1,000 works for metadata. | Song and film rows have no text. A title match is not a token. |
| D8 | **Vantage time (the playhead) is the 4th dimension.** | Play shows what was observable as of T. The animation never fills gaps. |
| D9 | **Relationships carry `evidence_status`**, and a DB trigger stops any `scrolls.*` or `user:*` provenance from ever being stored as `documented`. | The rule "inferred lineage cannot be mistaken for documented" holds at the storage layer, not only in the UI. |
| D10 | **Annotation and relationship revisions are append-only** (triggers abort UPDATE and DELETE). | Older interpretations stay as historical layers. |
| D11 | **One writer at a time.** Unlimited readers (WAL). Heavy reads go to a pool of read-only worker threads. | `node:sqlite` is synchronous. Its calls must not block the HTTP loop. |
| D12 | **Saved views pin `data_version`, `max_import_batch`, analysis run ids and annotation revision ids**, and documents are only ever soft-deleted. | A view can be reproduced exactly after restarts and new imports. |
| D13 | **The build is WP0 foundation, then 7 parallel packages with disjoint file ownership, then integration.** Routes and job tasks are found by scanning directories, so no package edits a shared registry. | This gives conflict-free parallelism. |

Data layout (fixed): code at `~/Documents/AI Stuff/Scrolls/`. All runtime data lives at `${SCROLLS_DATA:-~/Developer/scrolls-data}`:

```
scrolls-data/
  scrolls.db  scrolls.db-wal  scrolls.db-shm
  originals/ab/<sha256>            # verbatim bytes of every imported file, content-addressed, immutable
  incoming/<importId>.part         # uploads in progress
  derived/tokens/<lang>.u32 .vocab.tsv .pidx   # token-id streams (one per language)
  derived/vectors/run-<id>/<lang>-<slice>.f32 + .vocab
  derived/winnow/run-<id>.bin
  cache/{gutenberg,openalex,wikidata,kaikki}/   # opt-in network adapters only
  bin/scrolls-nl                   # optional compiled Swift adapter
  exports/  logs/scrolls.log
```

Scale (measured and estimated):

| Source | Docs | Tokens | Passages (est.) |
|---|---|---|---|
| Gutenberg | 691 files for 693 entries (2 files missing) | 59.7M (measured: en 36.1M / fr 14.5M / es 9.3M) | ~540k |
| Wikisource hi/gu | 450 / 375 books, 18,614 / 16,524 pages | ~8M | ~120k |
| culture-works | 94,385 | metadata only | ~210k field passages |
| Total | | | ~870k passages, DB ~1.2 GB, originals ~0.5 GB |

---

## 1. The 4D Gantt

### 1.1 The four dimensions

| Dim | Name | Encoding | Never encodes |
|---|---|---|---|
| **X** | *When it was written* (document time) | Horizontal position on a linear axis. Basis toggle: `published` (default) or `referenced` (the historical time the text is about, when the record supplies one). | Interpolated time. |
| **Y** | *Where in culture* (lane) | One categorical slice per lane: `cluster` (sense hypothesis), `kind` (genre/medium), `culture` (community), `language`, `collection` (source), `stemm` (field), or `expression` (multi-expression mode). | Any scale of meaning. Lanes have no y-ticks and no gradient between them. |
| **Z** | *How much* | Bar **height** inside the lane equals the rate in that lane × bin slice: occurrences per million tokens (full text) or matching works per 1,000 works (metadata). There is one shared scale with a legend ("height: 0–40 per million tokens"). A per-lane scale is optional and then draws its own tick. | Importance, sentiment, "meaning score". |
| **T** | *As of* (vantage time) | **The playhead.** When vantage mode is on, only evidence from documents dated ≤ T exists. Lineage arcs whose later end is ≤ T are drawn. Earlier bars get **violet reinterpretation notches** once a later work that reframes them falls at or before T. | Hypothetical futures. Those appear only in Next, as labeled user hypotheses. |

The phrase "4D Gantt" maps to these four: X time, Y lane, Z magnitude, T vantage. The 4th dimension is not decoration. It answers the brief's central question ("what did this mean *here, at this time*, and how did it become material for what followed?") by letting the user stand at a moment in history and step forward through it.

### 1.2 What a bar is

For one expression in one lane at the current bin level L:

- A **bar segment** is a maximal run of consecutive bins at level L with `occ > 0`. It starts at the left edge of the first bin and ends at the right edge of the last.
- **Endpoint caps:** a 2 px ivory cap marks the exact **first observed** and **last observed** dates inside the segment, even when bins are coarse. The tooltip reads, for example, "first observed 1947 (Rask, lab notebook, year precision)". The UI never says "coined" or "born". It says "first observed in this corpus slice".
- **Height per bin** equals the rate (Z). Any observed bin has a minimum height of 2 px, so rare uses stay visible.
- **Gaps** are bins with `occ = 0` between segments. A gap is *never* bridged and *never* tweened. There are two kinds, styled differently:
  - **Observed absence**: the lane has material (≥ 100k tokens or ≥ 50 works) in the gap bins but no occurrence. The gap stays empty. The coverage strip under the lane is solid.
  - **No material**: under 10k tokens (or under 5 works). The lane background shows a 45° hatch with the label "corpus silent". The rate is suppressed and only raw counts appear.
  - Between those thresholds the bin is **thin**: the bar is drawn hollow and the tooltip shows "n tokens".
- **Estimated dates:** if more than 50% of a bin's count comes from records with `date_basis='estimated'`, the bin is drawn at 50% opacity with a dotted top edge. A filter can exclude estimated dates entirely.

### 1.3 The other tracks in a lane (top to bottom)

1. **Bar track** (the main 44 px lane; compact 28 px, comfortable 64 px).
2. **Imprecise sub-row** (8 px). Holds records whose range is wider than the current bin, drawn as a horizontal whisker across `[t_lo, t_hi)` with ends faded over 20% of the width. A badge shows the count: "± 12 items dated only to decade or wider".
3. **Coverage strip** (4 px). Material per bin as luminance (tokens or works), one level coarser.
4. A **variety strip** (optional, 4 px): the effective number of sense clusters, exp(Shannon entropy of cluster shares), when a clustering run exists. Otherwise, distinct documents per 10 occurrences. Its label and unit are shown in the legend.

Under all lanes sits a **global coverage track** (24 px): a histogram of corpus tokens (and works) per bin for the active filters, with the selected comparison periods A and B marked.

To the right of the time axis, behind a vertical rule labeled **"UNDATED, outside chronology"**, is a fixed 120 px **undated shelf**. It gives per-lane counts of `precision='unknown'` occurrences. Clicking it opens them as a list. They never enter rates or bars.

### 1.4 Lanes

- Each lane dimension is a single choice per view. The server returns the top N lanes (default 12, maximum 24) ranked by the chosen order, plus an "other (k lanes)" lane.
- **Order options:** `first_observed` (default), `volume`, `alpha`, `manual` (drag). The legend always says: *"Lanes are ordered by first observation. Vertical position carries no meaning."*
- **Lanes are typed by measure.** A lane whose material is metadata (song or film titles and summaries) shows a `‰ works` unit chip. A full-text lane shows `pm tok`. A lane never mixes the two. When the slice contains both, the lane splits into "<lane> · text" and "<lane> · titles".
- **Cluster lanes** are titled "Sense hypothesis · run #14 · ≈ coil · current · lab (machine label, editable)".

### 1.5 Zoom, scale and level of detail

The axis is **linear** in astronomical years. Zoom is in pixels per year (`ppy`), clamped to [0.05, 14,600], where 1 day = 40 px. Pan is clamped to [−10000, 2100]. There is no log axis. An optional **Fold deep time** mode is piecewise-linear with one visible zig-zag break at a chosen year (default 1500). The compressed segment gets a different background tint and a fixed label, "before 1500: 1 px = 20 years; after: 1 px = 0.5 years". Its state lives in the URL.

Bin level = **the finest level whose bin width is at least 6 px**. Levels are defined in `src/shared/time.mjs`:

| Tier | Typical ppy | Bin level | Drawn |
|---|---|---|---|
| Z0 Deep time | < 0.006 | millennium | Language period bands (etymology), coverage silhouette, bars at millennium bins |
| Z1 Long view | 0.006–0.6 | century | Period bands, bars, etymology descent links (dashed amber), no marks |
| Z2 Centuries | 0.6–6 | decade | Bars, imprecise sub-rows, lineage arcs **bundled** per (lane-pair, decade) with count labels |
| Z3 Years | 6–72 | year | Bars, individual arcs (≤ 300), occurrence ticks if ≤ 4,000 in view |
| Z4 Months | 72–2,190 | month | Only month-or-finer records fall in bins. Year-precision records become whiskers. |
| Z5 Days | ≥ 2,190 | day | Day bins, individual ticks, exact dates on hover |
| **Occurrence overlay** | any | none | When the viewport holds ≤ 4,000 occurrences, individual ticks replace aggregate bars. Text occurrences are 1×8 px ticks, title matches are 5 px diamonds, estimated dates are hollow ticks. |

**Scale changes are always announced.** The axis header always reads, for example, `Bins: decades · 1 px ≈ 0.6 years`. When the level changes, a pill shows "Now showing yearly bins" for 1.5 s (static text in reduced motion). The screen-reader live region says the same.

**Deep time.** Etymology is drawn only as **period bands** from `lang_period`: PIE ≈ 4500–2500 BCE, Ancient Greek ≈ 800 BCE–600 CE, Classical Latin ≈ 75 BCE–200 CE, Sanskrit ≈ 1500 BCE–. Each band has soft gradient edges and a fixed suffix: "period, not a date". A member word (for example *genetic*) is placed at its **first observed occurrence in the loaded corpus**, linked to its etymon band by a dashed amber descent line labeled "Wiktionary via kaikki.org (CC BY-SA)".

### 1.6 Branches, convergence, lineage arcs

- **Split (branch):** in cluster-lane mode, a new sense cluster's first observation is joined to the nearest earlier cluster (centroid cosine ≥ 0.5, see §4.7) by a **dashed** S-curve connector. The connector starts at the parent bar at the child's first-observed date. The tooltip reads: "Split hypothesis (computed, run #14): 'hype a crowd' first observed 1979-08; nearest earlier use 'energize coil' cos 0.58."
- **Merge / convergence:** two lanes (two clusters, or clusters of two expressions in multi-expression mode) are joined by a dashed **converging ribbon** at the first window where their per-window centroids reach cosine ≥ 0.7, after < 0.4 in earlier windows. It is labeled as a convergence hypothesis.
- **Lineage arcs** run between the source occurrence or document and the target. They are drawn **above** the lanes, left to right (earlier → later) for transmission. **Feedback arcs** (type `reinterprets` or `answer`, or any relationship whose later item reframes the earlier one) are drawn **below** the lanes in violet. Their arrowhead sits on the *earlier* item, and they appear only when vantage ≥ the later date. Arc style follows the evidence grammar in §8.7.
- **Bounds:** at most 300 arcs are drawn individually. Beyond that they are bundled per (source lane, target lane, decade pair) into one arc with width ∝ log(count) and a count label. Click a bundle to list its members.

### 1.7 Playhead, scrub, play, reduced motion

- **Playhead** = vantage T. Drag its handle (44 px touch target) or press `[` / `]` to step one bin at the current level. With vantage mode on, evidence after T is hidden. A "show later evidence as outlines" toggle (off by default) draws it at 15% opacity.
- **Play** moves T forward one bin of the current level every 300 ms (speed 1×/2×/4×). The level is frozen during play. A bin is revealed in one step, so nothing grows continuously across bins. When T enters a gap, a corner note appears: "1934–1951: no observations (corpus: 3.1M tokens here)" or "corpus silent here". Play skips through "corpus silent" spans at 4× and labels them "skipping 1929–1949: no material".
- **Range select:** shift-drag on the axis, or drag on the global coverage track. The selection becomes `range` in state, sets the inspector's period, and can be sent to Compare as A or B (`a` / `b` keys).
- **Reduced motion** (OS `prefers-reduced-motion` or the `m` key): no tweening on zoom or pan, no inertia, no arc draw-on, play advances every 1 s with no transition, pills become static text.

### 1.8 The first 60 seconds

| Time | What happens |
|---|---|
| 0 s | Fresh install, no user corpus. The app opens to the **synthetic demo**: expression *flux up*, lanes = sense hypothesis, decade bins, 1880–2030. A full-width ribbon reads **"SYNTHETIC DEMO: invented people, texts, dates and links"**, and demo bars carry a diagonal hatch. |
| 3 s | Coach mark 1 (non-modal, `Esc` dismisses): "Each bar shows where *flux up* was **observed**. Height = uses per million words in that lane. Gaps are real gaps." |
| 10 s | Coach mark 2 points at Play: "Play steps through time. Things appear only when a document exists." The user presses Play. The 1947 physics lane appears, then the gap, then the 1979 hype lane branches off with a dashed split connector. |
| 25 s | Coach mark 3: "Click any mark to read its passage." The user clicks. The inspector opens the 1979 zine passage, shows highlighted offsets and the SYNTHETIC pill, and opens Then/Now/Next. |
| 40 s | Coach mark 4 points at the lane switcher (`L`): "Change what lanes mean." It shows the same data by kind. |
| 55 s | Coach mark 5 points at search: "Try a real word from the Cipher corpus." Suggestions: *virus*, *gene*, *signal*, *electricity*. The full tour (§9.3) is offered. |

A second launch restores the last view, using the URL hash if there is one and otherwise the last state in `localStorage`. That is a convenience only. Saved views live in the DB.

---

## 2. Views B–F (interaction specs)

### 2.1 B: Meaning constellation

- **Scope:** one expression (or one cluster run) and a period A, optionally B. Nodes: expression (circle), sense cluster (ring), source work (square), theme or motif (diamond, metadata or tag), etymon (hexagon). At most 120 nodes per period and 200 for the union. Edges: co-occurrence (logDice; width in 3 bins with the thresholds printed in the legend) and relationship edges (evidence grammar, §8.7).
- **Named quantities only.** Node size is a user-selected quantity: `occurrences in period` (default) or `documents in period`. The legend is persistent (pinned bottom-left, never collapses on desktop) and lists the size quantity with min and max, the edge-width quantity, shapes, and evidence styles.
- **Stable layout.** A deterministic force layout (Fruchterman–Reingold, 300 iterations, seed = FNV-1a hash of `expression_id|run_id|filtersHash`) runs once on the **union** of A ∪ B and is cached in `layout_cache`. Both periods use the same coordinates. Nodes absent from a period are drawn as 20%-opacity outlines in place, so nothing moves. A new node joins with its neighbors' positions pinned, and only it is placed. "Re-layout" is an explicit button. Afterwards a toast says: *"Layout recomputed. Position changes are not semantic."*
- **Two-period comparison:** side-by-side small multiples on desktop, or a toggle (A, B, overlay) on narrow screens. Overlay draws A in an amber outline and B in an ivory fill. A diff list shows "in B only", "in A only" and "grew > 2×", with counts.
- **Click a node** to open the inspector with supporting passages (KWIC, 20 per page, sorted by date). **Click an edge** to open the relationship card: type, evidence status, provenance, method or annotator, supporting passages, and the revision history. For a co-occurrence edge: joint count, logDice, G², window and the slice's token count.

### 2.2 C: Lineage explorer ("chain of custody")

- **Layout:** time-ordered left to right on the *same* X scale as the timeline. Rows are documents, grouped by lane dimension. Edges are typed and styled by evidence status. The root is a passage, document, expression or quotation.
- **Relationship types are kept distinct.** The type is always printed as text, never only as color: exact quotation, near quotation, explicit citation, adaptation, parody, recontextualization, proposed allusion, similar contextual usage. The Cipher music types (sample, interpolation, cover, version, remake, remix, answer, soundtrack) fall into families for filtering: *quotation*, *citation*, *adaptation*, *response*, *containment*, *similarity*, *etymology*, *interpretive*.
- **Every edge card shows** the supporting passages (source span and target span, with offsets), method or annotator, run id, evidence status, confidence (only when the method yields a calibrated probability; otherwise `score`, labeled as a heuristic), creation date and revisions.
- **Competing hypotheses:** relationships sharing a `hypothesis_group` (for example, two candidate origins for *hold the circle*, or two PIE roots listed for *signal*) are drawn as parallel dotted alternatives, with an "A vs B" panel listing supporting and contradicting annotations for each. No votes and no winner unless a human records `human_confirmed` on one, which leaves the other as `disputed`, not deleted.
- **Review actions** (on any non-documented edge): Confirm, Reject, Dispute, Attach evidence. Each one writes a `relationship_revision` and an annotation. A rejected edge is hidden by default ("show rejected" toggle) and keeps its history.
- **Bounded expansion:** depth ≤ 3, ≤ 150 nodes. Each node shows "+k more" and expands 25 neighbors per click. The response carries a `truncated` block, and the UI prints it: "showing 150 of 412 nodes; expand to see more".

### 2.3 D: Then / Now / Next inspector

The inspector opens when a passage or occurrence is selected (right panel on desktop, bottom sheet on narrow screens).

- **Then:** the passage verbatim with the occurrence highlighted, plus ±1 neighbor passage on request. Document metadata, including the **date card**: label, precision, basis, source, and any `referenced` date. Documented setting: document facets, summary field, collection license. **Contemporaneous uses:** up to 5 other occurrences of the expression dated within ±25 years, from different documents, chosen for maximal lane diversity. Every item opens its own passage.
- **Now:** the user picks a *later* passage. The default is the strongest outgoing relationship target, else the next occurrence in a different lane. Both are shown side by side with the relationship (type and evidence) between them. A quotation shows the aligned shared span with token-level diff highlighting. Human annotations on either side appear underneath. If there is no relationship, the panel says "no recorded relationship; these are separate uses of the same expression".
- **Next:** documented subsequent uses (outgoing relationships from the Now passage, then later occurrences in time order, 10 per page) and a **Hypothesis** composer. A hypothesis is stored as `annotation.kind='hypothesis_next'`, drawn as a violet dotted chip, and labeled "Your hypothesis, not evidence". It never feeds counts or lineage.
- **No private minds:** the Then card has no "what the author felt" field. Interpretations are annotations with an author and a perspective field ("reading as: 1968 reader / 2026 reader / community X").

### 2.4 E: Compare meanings

Input: one or two expressions plus slices A and B. Each slice is `{t0, t1, filters}`; different filters per side let the user compare communities, languages, genres or collections. Output panels, top to bottom:

1. **Coverage first.** A stacked composition bar per slice (collection × kind × language) with tokens, works, documents and authors. **Composition divergence** (JSD over strata) of 0.2 or more raises a banner: *"A is 92% novels, B is 61% song metadata. Differences may reflect what was collected, not how the word was used."* A **Rebalance** toggle post-stratifies: B's rate is recomputed as Σ_s w_A(s)·rate_B(s) over shared strata, and the strata missing from B are listed.
2. **Relative frequency:** rate per million (or ‰ works) with Garwood 95% CIs, the rate ratio, and raw n.
3. **Representative passages:** 5 per side. Medoid-near occurrences per cluster when clusters exist, otherwise maximum document diversity. Never cherry-picked by sentiment.
4. **Neighbors:** collocates by logDice in A and B, with "shared", "new in B" (ΔlogDice ≥ 2 and G² ≥ 10.83 in B with joint < 3 in A) and "declining".
5. **Sense-cluster shares:** per-slice shares with document-bootstrap CIs, and JSD with a 95% CI. **Gated** (see §4.10). A failing gate shows a grey card: "Not enough evidence to compare uses: A has 23 occurrences (needs 40) in 6 documents (needs 8)."
6. **Semantic displacement:** only when an aligned vector run exists and the gates pass. The card shows "displacement 0.34 (cosine distance after Procrustes), 92nd percentile of 500 frequency-matched control words; neighbor overlap 0.18". It shows a verdict *only* if the percentile is ≥ 95 and overlap ≤ 0.2. Otherwise: "within typical variation". There is no single "meaning change" number.
7. **Tone/stance** (optional adapter): mean NLTagger score per slice with bootstrap CI, n, and the banner "machine sentiment, fallible, not the author's stance".

### 2.5 F: Interpretation notebook

- **Targets:** passage (optionally a span), occurrence, cluster, relationship, saved view, document, expression.
- **Kinds:** `interpretation`, `evidence_for`, `evidence_against`, `tag`, `dimension` (user-defined key/value such as `stance=ironic` or `community=dockworkers`), `label` (cluster label edit), `confirmation`, `rejection`, `hypothesis_next`, `tone` (machine).
- **Multiple interpretations per target** are shown as cards. Each card shows its **revision stack**: the current revision on top, older revisions as stacked layers below with timestamps and the reason for each change. "Superseded" is a layer state, never a deletion. Retracting adds a final revision with `status='retracted'`. The text stays visible under a fold.
- **Evidence links:** an interpretation can cite passages (spans) as supporting or contradicting. They render as amber chips (for) and grey-struck chips (against) that open the passage.
- **Notebook page:** a filterable list (by target type, kind, tag, author, has-contradiction, date range) with full-text search over annotation bodies (`annotation_fts`). It exports as JSONL with every revision included.
- **Human vs machine:** machine annotations (Cipher tags, NLTagger tone) are listed under a separate "Machine annotations (fallible)" heading and cannot be edited, only countered with a human annotation.

---

## 3. Data model: complete SQLite DDL

Connection pragmas (every connection, `src/server/db/connect.mjs`): `journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON; busy_timeout=5000; temp_store=MEMORY; cache_size=-262144; mmap_size=1073741824`. UDFs registered on every connection: `bin_of(t, level)`, `bin_fits(t_lo, t_hi, level)`, `t_label(t_lo, t_hi, precision)`.

```sql
-- src/server/db/schema.sql  (schema_version 1)

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
-- keys: schema_version, data_version (bumped by every committing job), created_at

------------------------------------------------------------------ sources
CREATE TABLE source_adapter (
  id TEXT PRIMARY KEY,                 -- 'file.csv','cipher.gutenberg','stemm.openalex','demo.synthetic'
  version TEXT NOT NULL,
  label TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('local-file','local-dataset','network')),
  enabled INTEGER NOT NULL DEFAULT 0,  -- network adapters stay 0 until the user opts in
  approved_at TEXT,                    -- timestamp of explicit opt-in (network only)
  license TEXT, attribution TEXT,
  config_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE corpus (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,           -- 'cipher','stemm','demo','user'
  title TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0,1)),
  description TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE collection (
  id INTEGER PRIMARY KEY,
  corpus_id INTEGER NOT NULL REFERENCES corpus(id),
  slug TEXT NOT NULL,                  -- 'gutenberg','wikisource-hi','culture-works','roots','pg-stemm'
  title TEXT NOT NULL,
  adapter_id TEXT NOT NULL REFERENCES source_adapter(id),
  measure TEXT NOT NULL CHECK (measure IN ('tokens','works')),
  license TEXT, notes TEXT,
  UNIQUE (corpus_id, slug)
) STRICT;

CREATE TABLE original_file (
  sha256 TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,              -- originals/ab/<sha256>
  source_path TEXT,                    -- informational: absolute path or URL it came from
  bytes INTEGER NOT NULL,
  encoding TEXT NOT NULL,              -- utf-8 | utf-16le | utf-16be | windows-1252
  media_type TEXT NOT NULL,
  stored_at TEXT NOT NULL
) STRICT;

CREATE TABLE import_batch (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER REFERENCES collection(id),
  adapter_id TEXT NOT NULL REFERENCES source_adapter(id),
  adapter_version TEXT NOT NULL,
  original_sha256 TEXT REFERENCES original_file(sha256),
  file_name TEXT,
  format TEXT,                          -- txt|md|csv|tsv|json|jsonl|adapter
  mapping_json TEXT, options_json TEXT,
  status TEXT NOT NULL CHECK (status IN
    ('uploaded','previewed','committing','committed','failed','cancelled','reverted')),
  summary_json TEXT,                    -- ImportSummary, §5.6
  job_id INTEGER,
  created_at TEXT NOT NULL, committed_at TEXT
) STRICT;

CREATE TABLE import_issue (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','rejected','fatal')),
  code TEXT NOT NULL,                   -- DATE_UNPARSEABLE, ROW_RAGGED, JSON_SYNTAX, EMPTY_TEXT, DUP_EXACT ...
  locator TEXT,                         -- 'row 57' | 'line 17' | 'file'
  field TEXT, value TEXT,
  message TEXT NOT NULL, hint TEXT
) STRICT;
CREATE INDEX import_issue_batch ON import_issue(batch_id, severity);

------------------------------------------------------------------ documents & dates
CREATE TABLE document (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collection(id),
  import_batch_id INTEGER NOT NULL REFERENCES import_batch(id),
  ext_id TEXT NOT NULL,                 -- Gutenberg id, culture-works row, OpenAlex W-id, user id
  form TEXT NOT NULL CHECK (form IN ('fulltext','metadata')),
  kind TEXT NOT NULL,                   -- book|song|film|tv|sport|channel|paper|article|post|lecture|letter|other
  title TEXT, native_title TEXT, author TEXT,
  language TEXT, culture TEXT, genre TEXT, stemm_field TEXT, community TEXT,
  url TEXT, license TEXT, citation TEXT,
  t_lo REAL, t_hi REAL,                 -- primary date, copied from doc_date.is_primary
  date_precision TEXT NOT NULL, date_basis TEXT NOT NULL, date_label TEXT NOT NULL,
  ingested_at TEXT NOT NULL,            -- ingestion time (never used as document time)
  original_sha256 TEXT REFERENCES original_file(sha256),
  original_start INTEGER, original_end INTEGER, -- UTF-16 span of this document inside the decoded file
  original_meta_json TEXT NOT NULL,     -- verbatim source record minus bulk text
  tokens INTEGER NOT NULL DEFAULT 0,
  passages INTEGER NOT NULL DEFAULT 0,
  prominence REAL,
  content_hash TEXT,                    -- sha256(normalized full text): exact duplicates
  minhash BLOB,                         -- 128 x u32: near duplicates (fulltext only)
  duplicate_of INTEGER REFERENCES document(id),
  synthetic INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,                      -- soft delete only (saved-view reproducibility)
  UNIQUE (collection_id, ext_id)
) STRICT;
CREATE INDEX doc_t       ON document(t_lo)              WHERE deleted_at IS NULL;
CREATE INDEX doc_lang    ON document(language, t_lo);
CREATE INDEX doc_kind    ON document(kind, t_lo);
CREATE INDEX doc_culture ON document(culture, t_lo);
CREATE INDEX doc_stemm   ON document(stemm_field, t_lo) WHERE stemm_field IS NOT NULL;
CREATE INDEX doc_hash    ON document(content_hash);
CREATE INDEX doc_batch   ON document(import_batch_id);

CREATE TABLE doc_date (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN
    ('published','composed','performed','released','referenced','attested','digitized')),
  t_lo REAL, t_hi REAL,                 -- astronomical decimal years, half-open; NULL when unknown
  precision TEXT NOT NULL CHECK (precision IN
    ('day','month','year','circa','decade','century','millennium','range','period','unknown')),
  basis TEXT NOT NULL CHECK (basis IN ('stated','estimated','period','inferred','unknown')),
  raw TEXT,                             -- the string as supplied
  source TEXT,                          -- 'gutenberg.json (Wikidata, unverified)', 'pg_catalog birth+40 rule' ...
  note TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX doc_date_doc ON doc_date(doc_id, role);

-- 1-D R*Tree. float32 boundaries are rounded outward, so always post-filter on document.t_lo/t_hi
CREATE VIRTUAL TABLE doc_time_rtree USING rtree(id, t_lo, t_hi);

-- precision-aware bin membership, precomputed per doc for levels 0..3 (millennium..year)
CREATE TABLE doc_bin (
  level INTEGER NOT NULL, bin INTEGER NOT NULL, doc_id INTEGER NOT NULL,
  PRIMARY KEY (level, bin, doc_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX doc_bin_doc ON doc_bin(doc_id);

CREATE TABLE doc_facet (               -- themes, canon lists, subjects, LoCC, mood (with provenance)
  doc_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  facet TEXT NOT NULL,                  -- theme|canon|subject|locc|bookshelf|sampled_count|maker
  value TEXT NOT NULL,
  weight REAL,
  provenance TEXT NOT NULL,             -- wikidata|wikipedia|cipher.tagging|pg_catalog|openalex ...
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('documented','computed','proposed')),
  PRIMARY KEY (doc_id, facet, value)
) STRICT, WITHOUT ROWID;
CREATE INDEX doc_facet_value ON doc_facet(facet, value);

CREATE TABLE lang_period (
  lang TEXT PRIMARY KEY,                -- ine-pro, grc, la, sa ...
  label TEXT NOT NULL, t_lo REAL NOT NULL, t_hi REAL NOT NULL,
  source TEXT NOT NULL, note TEXT       -- 'conventional scholarly period; not an attestation date'
) STRICT;

------------------------------------------------------------------ passages & search
CREATE TABLE passage (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES document(id),
  ord INTEGER NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN
    ('paragraph','page_paragraph','stanza','field','section','abstract','sentence_group')),
  field TEXT,                           -- metadata docs: title|native_title|summary
  start INTEGER NOT NULL, end INTEGER NOT NULL,  -- UTF-16 offsets into the document's original text
  page INTEGER,                         -- Wikisource page index (0-based)
  text TEXT NOT NULL,                   -- invariant: == docOriginal.slice(start, end)
  tokens INTEGER NOT NULL,
  lang TEXT, lang_conf REAL, script TEXT,
  quality TEXT NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','low','boilerplate','front_matter')),
  UNIQUE (doc_id, ord)
) STRICT;

-- contentless FTS over JS-normalized text; rowid = passage.id
CREATE VIRTUAL TABLE passage_fts USING fts5(
  body, content='', contentless_delete=1, detail=full,
  tokenize="unicode61 remove_diacritics 0 categories 'L* N* Co M*'");
CREATE VIRTUAL TABLE passage_vocab_row  USING fts5vocab(passage_fts, row);
CREATE VIRTUAL TABLE passage_vocab_inst USING fts5vocab(passage_fts, instance);

-- titles, authors, expressions, etymon forms, tags: substring/typeahead (MATCH, >= 3 chars)
CREATE VIRTUAL TABLE label_fts USING fts5(
  kind UNINDEXED, ref_id UNINDEXED, label, tokenize="trigram remove_diacritics 1");

------------------------------------------------------------------ expressions & occurrences
CREATE TABLE expression (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL, norm TEXT NOT NULL,
  lang TEXT,                            -- NULL = any language
  kind TEXT NOT NULL CHECK (kind IN ('word','phrase','quotation','symbol','motif','etymon','root','title')),
  match_mode TEXT NOT NULL DEFAULT 'tokens' CHECK (match_mode IN ('tokens','prefix','near')),
  etymon_key TEXT,                      -- link into etymon(key) when known
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0,
  UNIQUE (norm, lang, kind)
) STRICT;

CREATE TABLE expression_variant (
  id INTEGER PRIMARY KEY,
  expression_id INTEGER NOT NULL REFERENCES expression(id) ON DELETE CASCADE,
  text TEXT NOT NULL, norm TEXT NOT NULL, lang TEXT,
  relation TEXT NOT NULL CHECK (relation IN
    ('self','inflection','spelling','script','translation','cognate','user')),
  source TEXT NOT NULL,                 -- 'rule:en-inflect@1' | 'roots.tsv' | 'user'
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE (expression_id, norm, lang)
) STRICT;

CREATE TABLE expression_state (
  expression_id INTEGER PRIMARY KEY REFERENCES expression(id) ON DELETE CASCADE,
  run_id INTEGER,                       -- materialize run that produced current occurrences
  variants_hash TEXT NOT NULL,          -- re-materialize when enabled variants change
  status TEXT NOT NULL CHECK (status IN ('none','estimating','materializing','ready','failed')),
  occ_total INTEGER, docs_total INTEGER,
  sampled INTEGER NOT NULL DEFAULT 0,   -- 1 = offsets stored for a stratified sample only
  sample_note TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE occurrence (
  id INTEGER PRIMARY KEY,
  expression_id INTEGER NOT NULL REFERENCES expression(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL,
  passage_id INTEGER NOT NULL REFERENCES passage(id),
  doc_id INTEGER NOT NULL,
  start INTEGER NOT NULL, end INTEGER NOT NULL,  -- UTF-16 offsets in the document original text
  t_lo REAL, t_hi REAL, precision TEXT NOT NULL, -- denormalized from document
  run_id INTEGER NOT NULL
) STRICT;
CREATE INDEX occ_expr_t   ON occurrence(expression_id, t_lo);
CREATE INDEX occ_passage  ON occurrence(passage_id);

-- THE aggregation base (decision D1): exact counts per expression x document x passage-language
CREATE TABLE expr_doc (
  expression_id INTEGER NOT NULL, doc_id INTEGER NOT NULL, plang TEXT NOT NULL,
  occ INTEGER NOT NULL, passages INTEGER NOT NULL,
  first_start INTEGER,                  -- offset of first occurrence (for "first observed" caps)
  run_id INTEGER NOT NULL,
  PRIMARY KEY (expression_id, doc_id, plang)
) STRICT, WITHOUT ROWID;

------------------------------------------------------------------ etymology (deep time)
CREATE TABLE etymon (
  key TEXT PRIMARY KEY,                 -- 'grc:γενεσις', 'ine-pro:*genh₁-'
  kind TEXT NOT NULL CHECK (kind IN ('etymon','root')),
  lang TEXT NOT NULL, form TEXT, roman TEXT, gloss TEXT
) STRICT;
CREATE TABLE etymon_parent (            -- 'roots' column: deeper roots; >1 parent = competing hypotheses
  key TEXT NOT NULL, parent_key TEXT NOT NULL, ord INTEGER NOT NULL,
  PRIMARY KEY (key, parent_key)
) STRICT, WITHOUT ROWID;
CREATE TABLE etymon_member (            -- 'members' column (≤300 per family, 103,252 links measured)
  key TEXT NOT NULL, lang TEXT NOT NULL, word TEXT NOT NULL, rank INTEGER NOT NULL,
  PRIMARY KEY (key, lang, word)
) STRICT, WITHOUT ROWID;
CREATE INDEX etymon_member_word ON etymon_member(lang, word);

------------------------------------------------------------------ analysis runs & hypotheses
CREATE TABLE analysis_run (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL,                  -- materialize|tokenize|collocations|vectors|align|cluster|drift|quotes|boilerplate|tone|coverage
  pipeline_version TEXT NOT NULL,       -- package.json version + stage module version, e.g. '0.1.0/cluster@2'
  method TEXT NOT NULL,                 -- 'spherical-kmeans', 'ppmi-rsvd', 'winnow-align' ...
  model TEXT, model_version TEXT,       -- e.g. 'apple.NLEmbedding.en', 'macOS 27.2'
  params_json TEXT NOT NULL,            -- every parameter, including defaults
  scope_json TEXT NOT NULL,             -- expression ids, filters, languages, slices
  input_hash TEXT NOT NULL,             -- sha256(scope + data_version + params)
  data_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','done','failed','cancelled','superseded')),
  stats_json TEXT, gate_json TEXT,      -- gate results (what was disabled and why)
  started_at TEXT NOT NULL, finished_at TEXT, job_id INTEGER
) STRICT;
CREATE INDEX run_stage ON analysis_run(stage, status, input_hash);

CREATE TABLE time_window (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES analysis_run(id) ON DELETE CASCADE,
  label TEXT NOT NULL, t_lo REAL NOT NULL, t_hi REAL NOT NULL,
  scheme TEXT NOT NULL CHECK (scheme IN ('fixed','quantile','user','slice')),
  tokens INTEGER, docs INTEGER
) STRICT;

CREATE TABLE vector_space (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES analysis_run(id) ON DELETE CASCADE,
  lang TEXT NOT NULL, window_id INTEGER REFERENCES time_window(id),  -- NULL = pooled space
  tokens INTEGER NOT NULL, docs INTEGER NOT NULL, authors INTEGER NOT NULL,
  vocab INTEGER NOT NULL, dim INTEGER NOT NULL,
  rel_path TEXT NOT NULL,               -- derived/vectors/run-<id>/<lang>-<slice>.f32
  aligned_to INTEGER REFERENCES vector_space(id), rotation BLOB  -- Procrustes R (dim x dim f32)
) STRICT;

CREATE TABLE sense_cluster (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES analysis_run(id) ON DELETE CASCADE,
  expression_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  auto_label TEXT NOT NULL,             -- '≈ coil · current · lab' (machine)
  size INTEGER NOT NULL, docs INTEGER NOT NULL,
  first_t REAL, last_t REAL,
  centroid BLOB NOT NULL,               -- f32[dim]
  distinctive_json TEXT NOT NULL,       -- [{term, logodds_z, n}]
  stability REAL NOT NULL,              -- mean bootstrap Jaccard of matched cluster
  status TEXT NOT NULL DEFAULT 'hypothesis' CHECK (status IN ('hypothesis','unstable','confirmed','rejected'))
) STRICT;
CREATE INDEX cluster_expr ON sense_cluster(expression_id, run_id);
-- human label lives in annotation(kind='label', target_kind='cluster'); latest revision wins for display

CREATE TABLE occurrence_cluster (
  occurrence_id INTEGER NOT NULL, run_id INTEGER NOT NULL,
  cluster_id INTEGER NOT NULL, sim REAL NOT NULL,
  PRIMARY KEY (occurrence_id, run_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE expr_doc_cluster (         -- aggregation base for cluster lanes
  run_id INTEGER NOT NULL, cluster_id INTEGER NOT NULL, doc_id INTEGER NOT NULL, occ INTEGER NOT NULL,
  PRIMARY KEY (run_id, cluster_id, doc_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE cluster_link (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES analysis_run(id) ON DELETE CASCADE,
  from_cluster INTEGER NOT NULL, to_cluster INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('splits_into','converges_with','continues')),
  at_t REAL NOT NULL, similarity REAL NOT NULL, detail_json TEXT
) STRICT;

------------------------------------------------------------------ relationships (lineage)
CREATE TABLE relationship (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (
    'exact_quotation','near_quotation','explicit_citation','adaptation','parody',
    'recontextualization','proposed_allusion','similar_usage',
    'sample','interpolation','cover','version','remake','remix','answer','soundtrack','inspired_by',
    'counterpart','kindred','reinterprets','etymological_descent','shared_text')),
  family TEXT NOT NULL,                 -- quotation|citation|adaptation|response|containment|similarity|etymology|interpretive
  source_kind TEXT NOT NULL CHECK (source_kind IN ('passage','document','expression','etymon','cluster')),
  source_ref TEXT NOT NULL,             -- id or etymon key (TEXT to allow both)
  target_kind TEXT NOT NULL CHECK (target_kind IN ('passage','document','expression','etymon','cluster')),
  target_ref TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('forward','feedback','undirected')),
  evidence_status TEXT NOT NULL CHECK (evidence_status IN
    ('documented','computed','proposed','human_confirmed','human_rejected','disputed')),
  provenance TEXT NOT NULL,             -- wikipedia|wikidata|musicbrainz|itwofs|wiktionary|openalex|
                                        -- cipher.build|cipher.tagging|scrolls.<stage>@<ver>|user:<name>|demo.synthetic
  provenance_uncertain INTEGER NOT NULL DEFAULT 0,  -- e.g. Cipher '-' source code with ambiguous origin
  method TEXT,                          -- 'winnow k=7 w=10 + align' | 'Cipher theme similarity'
  run_id INTEGER REFERENCES analysis_run(id),
  annotator TEXT,                       -- human who created or last reviewed
  confidence REAL,                      -- ONLY a calibrated probability; else NULL
  score REAL,                           -- heuristic strength, labeled as such in UI
  hypothesis_group TEXT,                -- competing hypotheses share a group key
  license_note TEXT,                    -- e.g. ItwoFS CC BY 2.5 link-back
  synthetic INTEGER NOT NULL DEFAULT 0,
  current_rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX rel_source ON relationship(source_kind, source_ref, type);
CREATE INDEX rel_target ON relationship(target_kind, target_ref, type);
CREATE INDEX rel_group  ON relationship(hypothesis_group) WHERE hypothesis_group IS NOT NULL;
CREATE INDEX rel_status ON relationship(evidence_status, family);

CREATE TABLE relationship_evidence (
  relationship_id INTEGER NOT NULL REFERENCES relationship(id) ON DELETE CASCADE,
  passage_id INTEGER NOT NULL REFERENCES passage(id),
  role TEXT NOT NULL CHECK (role IN ('source','target','support','contradict','attribution_cue')),
  start INTEGER, end INTEGER,           -- doc-original offsets of the supporting span
  note TEXT,
  PRIMARY KEY (relationship_id, passage_id, role, start)
) STRICT, WITHOUT ROWID;

CREATE TABLE relationship_revision (
  id INTEGER PRIMARY KEY,
  relationship_id INTEGER NOT NULL REFERENCES relationship(id),
  rev INTEGER NOT NULL,
  changed_by TEXT NOT NULL,             -- 'user:utkarsh' | 'scrolls.quotes@1' | 'import:cipher'
  changed_at TEXT NOT NULL,
  before_json TEXT, after_json TEXT NOT NULL, reason TEXT,
  UNIQUE (relationship_id, rev)
) STRICT;

CREATE TRIGGER rel_doc_guard_ins BEFORE INSERT ON relationship
WHEN NEW.evidence_status = 'documented'
 AND (NEW.provenance LIKE 'scrolls.%' OR NEW.provenance LIKE 'user:%')
BEGIN SELECT RAISE(ABORT, 'computed or user-created relationships cannot be documented'); END;
CREATE TRIGGER rel_doc_guard_upd BEFORE UPDATE OF evidence_status ON relationship
WHEN NEW.evidence_status = 'documented' AND OLD.evidence_status <> 'documented'
BEGIN SELECT RAISE(ABORT, 'evidence cannot be promoted to documented; use human_confirmed'); END;
CREATE TRIGGER rel_rev_noupd BEFORE UPDATE ON relationship_revision
BEGIN SELECT RAISE(ABORT, 'relationship revisions are append-only'); END;
CREATE TRIGGER rel_rev_nodel BEFORE DELETE ON relationship_revision
BEGIN SELECT RAISE(ABORT, 'relationship revisions are append-only'); END;

------------------------------------------------------------------ annotations
CREATE TABLE annotation (
  id INTEGER PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN
    ('passage','occurrence','cluster','relationship','saved_view','document','expression')),
  target_ref TEXT NOT NULL,
  span_start INTEGER, span_end INTEGER, -- optional span (doc-original offsets) for passage targets
  kind TEXT NOT NULL CHECK (kind IN ('interpretation','evidence_for','evidence_against','tag','dimension',
    'label','confirmation','rejection','hypothesis_next','tone','motif','meaning','mood')),
  author TEXT NOT NULL,                 -- 'utkarsh' | 'cipher.tagging' | 'apple.NLTagger'
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human','machine')),
  method TEXT,                          -- machine only: 'Cipher tagging pass (Claude sub-agent, Oct 2026)'
  run_id INTEGER,
  parent_id INTEGER REFERENCES annotation(id),     -- replies / counter-interpretations
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retracted')),
  current_rev INTEGER NOT NULL DEFAULT 1,
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX ann_target ON annotation(target_kind, target_ref, kind);
CREATE INDEX ann_author ON annotation(author_kind, author);

CREATE TABLE annotation_revision (
  id INTEGER PRIMARY KEY,
  annotation_id INTEGER NOT NULL REFERENCES annotation(id),
  rev INTEGER NOT NULL,
  body_md TEXT,                         -- interpretation text
  data_json TEXT NOT NULL DEFAULT '{}', -- {tags:[], dims:{stance:'ironic'}, perspective:'1968 reader',
                                        --  evidence:[{passageId,start,end,role}], value:-0.4, label:'...'}
  status TEXT NOT NULL CHECK (status IN ('active','retracted')),
  author TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT,
  UNIQUE (annotation_id, rev)
) STRICT;
CREATE TRIGGER ann_rev_noupd BEFORE UPDATE ON annotation_revision
BEGIN SELECT RAISE(ABORT, 'annotation revisions are append-only'); END;
CREATE TRIGGER ann_rev_nodel BEFORE DELETE ON annotation_revision
BEGIN SELECT RAISE(ABORT, 'annotation revisions are append-only'); END;

CREATE VIRTUAL TABLE annotation_fts USING fts5(
  body, content='', contentless_delete=1,
  tokenize="unicode61 remove_diacritics 0 categories 'L* N* Co M*'");  -- rowid = annotation_revision.id

------------------------------------------------------------------ views, jobs, caches
CREATE TABLE saved_view (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,            -- 'flux-up-3f9a'; immutable; re-save => 'flux-up-3f9a~2'
  title TEXT NOT NULL, description TEXT,
  state_json TEXT NOT NULL, state_hash TEXT NOT NULL,
  data_version INTEGER NOT NULL, max_import_batch INTEGER NOT NULL, saved_at TEXT NOT NULL,
  run_ids_json TEXT NOT NULL,           -- {"materialize":{"12":31},"cluster":14,"vectors":4,"quotes":9}
  annotation_snapshot_json TEXT NOT NULL,   -- [[annotation_id, rev], ...] visible at save time
  relationship_snapshot_json TEXT NOT NULL, -- [[relationship_id, rev], ...]
  snapshot_svg TEXT,                    -- server-rendered thumbnail
  parent_slug TEXT
) STRICT;

CREATE TABLE job (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                   -- import|bootstrap|adapter-sync|materialize|coverage|tokenize|vectors|
                                        -- cluster|drift|tone|quotes|boilerplate|export
  params_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled','interrupted')),
  writes INTEGER NOT NULL,              -- 1 = needs the single writer lock
  progress REAL NOT NULL DEFAULT 0, phase TEXT, message TEXT, counts_json TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  result_json TEXT, error_json TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
) STRICT;
CREATE INDEX job_status ON job(status, created_at);

CREATE TABLE query_def (                -- canonical timeline queries; key = sha1(canonical JSON)[0:16]
  key TEXT PRIMARY KEY, def_json TEXT NOT NULL, created_at TEXT NOT NULL, last_used TEXT NOT NULL
) STRICT;
CREATE TABLE tile_cache (               -- persisted warm cache; LRU-evicted above 200 MB
  key TEXT PRIMARY KEY,                 -- queryKey|level|tile|data_version
  body BLOB NOT NULL, bytes INTEGER NOT NULL, last_used TEXT NOT NULL
) STRICT;
CREATE TABLE layout_cache (
  key TEXT PRIMARY KEY,                 -- constellation: expression|run|filtersHash|seed
  positions_json TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE theme_assoc (              -- culture-themes.tsv (computed NPMI)
  theme TEXT NOT NULL, other TEXT NOT NULL, npmi REAL NOT NULL,
  PRIMARY KEY (theme, other)
) STRICT, WITHOUT ROWID;
```

**Offsets contract:** every `start/end` is in UTF-16 code units of the *document's original text*, which is `decode(originals/<sha>).slice(original_start, original_end)`. For a TXT file that is the whole file. For a CSV, TSV or JSONL row it is that row's raw line. For Wikisource it is the pages joined with `\f` (§6.2). Invariants tested: `passage.text === docOriginal.slice(p.start, p.end)` and `p.start <= occ.start < occ.end <= p.end`.

**Time contract (`src/shared/time.mjs`):** `t = Y + (dayOfYear − 1) / daysInYear(Y)` with astronomical Y, so 1 BCE = 0 and 500 BCE = −499 (proleptic Gregorian). Levels: `0 millennium, 1 century, 2 decade, 3 year, 4 month, 5 day`. Bins: `floor(Y / w)` for levels 0–3, `Y*12 + (M−1)` for months, days since 0001-01-01 for days. Tiles hold 64 bins: `tile = floor(bin / 64)`. `bin_fits(t_lo, t_hi, L)` is true iff the range is non-empty and lies inside a single bin at L.

---

## 4. Analysis pipeline

Each stage is a module in `src/analysis/` or `src/lineage/` with a pure core plus a job task. Every execution writes an `analysis_run` row with all parameters, `pipeline_version`, `data_version` and `input_hash`. A cached run is reused only when `input_hash` matches. Runs are never edited. A rerun with new parameters marks the previous one `superseded` but keeps it, so saved views can still point at it.

### 4.1 Parse, validate, preserve

Incoming bytes go to `originals/<sha256>`. Encoding detection: a BOM, then strict UTF-8 decode. If that fails, Windows-1252, with warning `ENCODING_FALLBACK` naming the first bad byte offset. The decoded string is the offset space. Nothing is re-encoded.

### 4.2 Normalization (`src/core/normalize.mjs`)

`normalize(s) → { norm, map }`, where `map: Uint32Array` sends each `norm` code unit back to an index in `s`.

1. NFC.
2. Per character run, by script:
   - **Latin, Greek, Cyrillic:** NFKD, drop `\p{Mn}`, re-NFC. Fold `ſ→s`, `æ→ae`, `œ→oe`, `ß→ss`. Curly quotes become `'`. Dashes become `-`. Lowercase.
   - **Devanagari / Gujarati:** NFC, remove ZWJ/ZWNJ (U+200D/U+200C), keep matras, virama and nukta. Two variants that are off by default and enabled per expression: nukta folding (`क़→क`) and chandrabindu→anusvara.
3. Gutenberg `_italic_` underscores become separators.

**Tokenizer (`src/core/tokenize.mjs`):** a token is a maximal run of `[\p{L}\p{N}\p{Co}\p{M}]`. This deliberately matches the FTS5 `categories 'L* N* Co M*'` rule, so JS token offsets equal `fts5vocab` instance offsets. A parity test checks this on 1,000 random passages.

**Sentence segmentation:** `Intl.Segmenter(lang, {granularity: 'sentence'})`. ICU treats the danda `।` as a sentence terminator. Measured `Intl.Segmenter` word throughput: 3.3M words/s. The regex tokenizer is about 3× faster and is used for bulk work.

**Language ID (`src/core/langid.mjs`):** first by script (Devanagari → `hi`, Gujarati → `gu`). For Latin script, a stopword-profile log-likelihood over en/fr/es/de/it/pt/la/nl (top 100 stopwords each). A passage needs ≥ 8 tokens, and the top-2 margin must be ≥ 0.1, otherwise the passage inherits the document language with `lang_conf` < 0.5.

### 4.3 Passage segmentation (`src/core/segment.mjs`)

- **Prose (TXT, MD, Gutenberg body):** split on `\n\s*\n`. Merge forward while a passage is under 40 tokens, up to 3 paragraphs. Split passages over 400 tokens at sentence boundaries into chunks of ≤ 250 tokens. Markdown headings start a new passage and are kept inside its text.
- **Wikisource:** paragraphs inside each page. Never cross a page. `page` is recorded.
- **Metadata:** one passage per non-empty text field.
- **Line mode** (an import option for verse and transcripts): passages are stanzas, separated by blank lines.
- **Quality:** under 50% letters, or under 5 tokens, gives `low`. Gutenberg legal text (§6.1) and cross-document repeated spans (§4.6) give `boilerplate`. Both are excluded from counts and analysis by default, remain searchable with "include boilerplate", and the exclusion is shown in the coverage tooltip.

### 4.4 Search, KWIC, occurrence materialization

- **Query to FTS:** normalize, tokenize, then build a phrase `"t1 t2"`. Enabled variants are joined with `OR`. A trailing `*` gives a prefix query. Expressions with `match_mode='near'` use `NEAR(t1 t2, 1)` for the candidate step. Ranking is `bm25`, with an optional "spread across time" re-rank that caps results at 3 per decade per page.
- **Materialize (`src/aggregate/materialize.mjs`):**
  1. **Single-token expressions:** exact counts per document come straight from `passage_vocab_inst` (`SELECT p.doc_id, p.lang, count(*) … WHERE v.term = ? GROUP BY 1,2`). Offsets come from the JS locator over the candidate passages.
  2. **Phrases:** FTS candidate passages, then `locate(passage.text, variants)`, which runs `normalize`, matches the token sequence and maps back to original offsets (`map[]`). Combining marks after the last token are included.
  3. **Bounds:** up to 5,000 candidate passages are materialized synchronously in the request (about 300 ms). Above that, a `materialize` job runs (progress, cancellable), and tiles show **preliminary** counts of passages containing the expression, labeled as such. Over 250,000 occurrences: counts stay exact (from vocab for single tokens), but offsets are stored for a **stratified sample** of ≤ 200 per (decade × lane), with `sampled=1` and a note shown in the inspector.
- **KWIC:** display ±60 characters from `passage.text`, and analysis uses ±10 tokens, both clipped to the passage. "Expand" fetches the neighboring passage, and clipping is marked "…".

### 4.5 Frequency and collocations

- **Rate:** `occ / tokens × 1e6` for each lane × bin × filter slice, from the same SQL that builds the denominator (`SUM(document.tokens)` over `doc_bin` with identical filters, excluding `quality≠'ok'` token counts). Under 100k tokens the bin is **thin** (hollow). Under 10k tokens the rate is suppressed and only counts are shown. 95% CIs are Garwood exact Poisson intervals.
- **Metadata rate:** matching works per 1,000 works of that kind in the bin.
- **Collocations:** window ±5 tokens inside a passage, stopwords kept for counting and hidden by default in the display. Candidates need joint frequency ≥ 5, collocate frequency ≥ 10 and G² ≥ 10.83 (p < .001). They are ranked by **logDice** = 14 + log₂(2·f_xy / (f_x + f_y)). PMI is shown as a secondary column. Collocations are computed per slice from the token streams (§4.7) restricted to the passages of the slice. Fewer than 20 occurrences in the slice disables collocations ("Too few occurrences (n=12) for reliable neighbors").

### 4.6 Quotation detection (`src/lineage/`)

**A. Seeded trace** (interactive: "trace this quotation or passage"):
- Take token 5-shingles of the seed and pick the 16 rarest by summed IDF from `passage_vocab_row`. Run 16 FTS phrase queries, cap the union at 5,000 candidates, align at most 2,000 of them, and stay within a 1.5 s budget, after which it continues as a job.
- **Alignment:** a banded Smith–Waterman over token ids (match +2, mismatch −1, gap −2, band 8).
- **Classification:**
  - `exact_quotation`: an identical normalized token run of ≥ 12 tokens, or ≥ 6 tokens if it covers the whole seed.
  - `near_quotation`: aligned similarity (matches / aligned length) ≥ 0.8 over ≥ 12 tokens.
  - Anything below that is not a relationship. It is listed only as a "weak textual overlap" in the trace panel.

**B. Corpus-wide discovery and boilerplate** (job `quotes`, also run as `boilerplate` right after bootstrap):
- **Winnowing** over token-id streams: k = 7-token shingles, 32-bit FNV-1a, window w = 10. This guarantees detection of any shared span of ≥ 16 tokens at a density of about 2/(w+1) ≈ 18%, so 68M tokens give about 12M fingerprints (hash u32, passage u32, pos u16) ≈ 120 MB in one worker. Radix-sort by hash, then group:
  - 2–24 distinct documents: candidate pairs. Seeds need ≥ 2 shared fingerprints within 40 tokens. They are extended by alignment and classified as in A.
  - **> 24 distinct documents: boilerplate or formula.** If ≥ 50% of a passage's fingerprints fall in such groups, the passage gets `quality='boilerplate'`. This is how the Gutenberg licence ("…a computer virus, or computer codes that damage…", measured in at least 5 files whose licence sits inside the START/END body) stops counting as 1890s usage of *virus*.
- **Same work, different edition:** same normalized author, title trigram similarity ≥ 0.6, and document MinHash Jaccard ≥ 0.5. Such pairs become `duplicate_of` warnings, not quotations.
- **Direction:** the earlier `t_hi` ≤ the later `t_lo` gives `forward` (source = earlier). Overlapping or unknown dates give type `shared_text` with direction `undirected` and the message "cannot order: dates overlap".
- **Evidence:** always `computed`, provenance `scrolls.quotes@1`, `method='winnow k=7 w=10 + banded SW'`, `score` = aligned similarity, `confidence` NULL. Both spans go to `relationship_evidence`.
- **Attribution cues:** an author surname, title tokens or "as … said/says/wrote" within ±200 characters of the target span adds a second relationship, `explicit_citation`, with status **`proposed`** and the cue span as `attribution_cue` evidence. Only a human can confirm it. **Documented** citations come only from source metadata (OpenAlex `referenced_works`, Wikidata).
- **Translations** are not detected. The trace panel says "cross-language reuse is not detected".
- **Document-level near duplicates** (import time): MinHash with 128 permutations over word 5-shingles, LSH with 32 bands × 4 rows (threshold ≈ 0.42), confirmed by exact Jaccard ≥ 0.8 on sampled shingles.

### 4.7 Contextual representation (no paid APIs)

**Token streams** (`tokenize` job, built once per data_version per language): `derived/tokens/<lang>.u32` holds one u32 token id per token of `quality='ok'` passages. `.pidx` holds the passage id and offset per passage, and `.vocab.tsv` maps ids to strings. The full corpus is about 270 MB. Collocations, PPMI and winnowing all read these streams.

**Spaces** (`vectors` job):
- **Pooled language space**, one per language with ≥ 3M tokens:
  - Vocabulary: frequency ≥ 20, capped at 30k.
  - Contexts: the same vocabulary, window ±4, weight 1/d.
  - Counting is sharded by `targetId mod 8` across workers, each with a typed-array open-addressing table (2²⁴ slots, u32 key = i·30000+j, f32 value).
  - PPMI with context smoothing α = 0.75, stored as CSR.
  - **Randomized truncated SVD** (Halko): rank d = 128, oversampling 10, 2 power iterations. Sparse × dense products are split by row block across worker threads using `SharedArrayBuffer`. Householder QR runs in JS, and the small SVD uses one-sided Jacobi.
  - Embeddings `W = U·Σ^½`, rows L2-normalized.
  - Estimated cost for en (36M tokens): about 2–4 minutes on 6 workers.
- **Time-slice spaces:** contiguous slices per language, each needing **≥ 3M tokens, ≥ 10 documents and ≥ 5 authors**. From the measured era totals:
  - **en:** 4 slices (≤1824: 4.8M; 1825–1874: 6.6M; 1875–1904 and 1905–1928, splitting 24.4M).
  - **fr:** 2 slices (1825–1874: 7.5M; 1875–1928: 4.6M).
  - **es:** 1 slice (1825–1874 has 2.95M < 3M), **so drift is disabled for Spanish** with an explicit reason.
  - **hi/gu:** about 4–5M each, 1 slice each, so drift is disabled.
  - The modern era has **no** full text for en, fr or es. Modern drift exists only for user imports or OpenAlex abstracts, and the UI states this.
- **Alignment:** orthogonal Procrustes onto the latest slice, with anchors in the shared vocabulary that have frequency ≥ 100 in both slices. The top 100 stopwords and the target expression's tokens are excluded, capped at 10k. `R = UVᵀ` from the SVD of `AᵀB` (128×128).

**Occurrence vectors (Schütze-style):**
- **Second-order:** the IDF-weighted mean of pooled-space vectors over the ±10 context tokens, excluding stopwords and the target, then L2-normalized.
- **Fallback** when no pooled space exists (under 3M tokens, as for the demo and small user corpora): **first-order** TF-IDF context vectors hashed to 4,096 dimensions.
- The chosen representation is recorded in `params_json` and printed on every cluster card.

**Optional Apple adapter:** `scrolls-nl` (Swift CLI, JSONL over stdio: `{op:'sentvec'|'wordvec'|'sentiment', lang, text}`). If present and enabled, it can replace occurrence vectors with NLEmbedding sentence vectors for supported languages. That choice is recorded as model `apple.NLEmbedding.<lang>` with the macOS version. Hindi and Gujarati fall back to the in-house vectors.

### 4.8 Clustering into sense hypotheses (`cluster` job)

- **Input:** all materialized occurrences of one expression (sampled ones when `sampled=1`), with `quality='ok'`.
- **Gate:** n ≥ 30 occurrences from ≥ 5 documents. Otherwise there is no run and the UI says "Too few occurrences to separate uses (23 < 30)".
- **Algorithm:** spherical k-means (cosine), k-means++ seeding, 20 restarts, seed = hash(expression, data_version). k ∈ {2…8}, chosen by maximum mean silhouette, subject to every cluster having ≥ max(10, 5% of n) members. If the best silhouette is under 0.10, k = 1 and the card says "no separable uses found".
- **Stability:** 20 bootstrap resamples by **document**. Clusters are matched by Hungarian assignment on centroid cosine. Stability = mean Jaccard of matched member sets. Under 0.6, the cluster gets `status='unstable'`, drawn hatched with the label "tentative".
- **Labels:** the top 5 distinctive context terms by weighted log-odds with an informative Dirichlet prior (Monroe et al.), cluster vs. rest, z ≥ 1.96, rendered as `≈ coil · current · lab`. A **machine label** stays editable: an edit becomes an `annotation(kind='label')` revision, and the auto label is kept.
- **Splits and convergence** (`cluster_link`):
  - **Split:** for each cluster C whose first observation falls after the earliest observation of some other cluster, find the nearest older cluster P by centroid cosine. If cosine ≥ 0.5, record `splits_into` at C.first_t.
  - **Convergence:** across fixed windows (25-year windows, or quantile windows with ≥ 15 occurrences each), compute per-window centroids. Two clusters, or clusters from two expressions in multi-expression runs, with cosine < 0.4 in their first shared window and ≥ 0.7 in a later window, are recorded as `converges_with` at that window.
  - All of these are `computed` and drawn dashed.

### 4.9 Drift and displacement (`drift` job and compare endpoint)

- **Cluster-share divergence:** JSD between the cluster distributions of A and B. The 95% CI comes from **1,000 bootstrap resamples by document**, because occurrences inside one document are correlated.
- **Embedding displacement:** `1 − cos(R·w_A, w_B)` in the aligned slice spaces. It is reported with:
  - the percentile among **500 frequency-matched controls**: words in the same frequency decile in both slices, excluding the top 100 stopwords;
  - the neighbor overlap: Jaccard of the top 20 neighbors.
- **A verdict appears only if** the percentile is ≥ 95 **and** the neighbor overlap is ≤ 0.2. There is no single meaning score.

### 4.10 Evidence gates: what is disabled and how the UI says it

| Feature | Gate (all must hold) | When failing, the UI shows |
|---|---|---|
| Rate in a bin | slice tokens ≥ 10k (works ≥ 5) | count only, grey "thin coverage" |
| Collocations | ≥ 20 occurrences in slice | "Too few occurrences (n=12) for reliable neighbors" |
| Clustering | ≥ 30 occurrences, ≥ 5 docs | "Too few occurrences to separate uses" |
| Cluster-share comparison | each side ≥ 40 occurrences, ≥ 8 docs, max single-doc share ≤ 0.5 | grey card listing every failed condition with the numbers |
| Embedding displacement | aligned run exists; target freq ≥ 100 and ≥ 20 docs and ≥ 5 authors in each slice; slices ≥ 3M tokens | "Not available: Spanish has one eligible time slice (1825–1874 has 2.95M tokens, needs 3M)" |
| Tone/stance | adapter present and enabled, language supported, ≥ 30 passages per side | "Tone needs the optional on-device adapter (npm run build:nl)" / "Hindi not supported by NLTagger" |
| Quotation direction | non-overlapping dates | type `shared_text`, "cannot order: dates overlap" |

Gate results are stored in `analysis_run.gate_json` and returned in API responses as `{status:'insufficient', reasons:[{code, need, have, message}]}`. A failing gate never returns `value: 0`. It returns `value: null`.

### 4.11 Tone/stance

This exists only through the optional adapter: NLTagger `sentimentScore` per passage, stored as `annotation(kind='tone', author_kind='machine', author='apple.NLTagger', method='NLTagger.sentimentScore macOS 27.2', data_json.value ∈ [−1,1])`. It is aggregated per slice as a mean with a document-bootstrap CI. It is always shown with "machine sentiment, fallible" and is never used in lineage or clustering.

---

## 5. Ingestion

### 5.1 Formats

| Format | Parsing | Units |
|---|---|---|
| TXT | one document per file. An optional header block `---\nkey: value\n---` gives metadata. | paragraphs (or line mode) |
| MD | as TXT, plus the same front matter. Headings start passages. | paragraphs/sections |
| CSV/TSV | RFC 4180 state machine: quoted fields, embedded newlines, `""` escapes, BOM. Delimiter sniffed by consistency of field counts over the first 50 records among `, ; \t |`. | one row = one document. The text column is segmented, and other columns go to `original_meta_json`. |
| JSON | an array of objects, or `{documents:[…]}`, or `{data:[…]}`. Nested paths are addressed as `a.b.c`. | one object = one document |
| JSONL | one object per line. Blank lines are skipped. Every error carries its line number. | one line = one document |

A multi-file import is a series of single-file imports in one `import_batch` group. A directory of TXT files is uploaded as one file at a time by the wizard.

### 5.2 Server contract

1. `POST /api/imports {fileName, bytes, collection:{corpus:'user', slug, title}}` returns `{id, uploadUrl}`.
2. `PUT /api/imports/:id/file`: the raw body is streamed to `incoming/`, hashed, moved to `originals/`. The limit is 2 GB.
3. `GET /api/imports/:id/preview` returns the sniffed format, encoding and delimiter, the columns with 5 sample values each, the inferred type per column (`text|date|number|id|url|lang|list`), a **suggested mapping**, the first 20 parsed rows, and parse issues.
4. `POST /api/imports/:id/dry-run {mapping, options}` runs the full validate, date-parse and dedupe pass with no writes and returns an ImportSummary.
5. `POST /api/imports/:id/commit {mapping, options}` returns `{jobId}`. Commits are transactional per 5,000 documents. A fatal error rolls back everything in the batch: the batch gets `status='failed'`, its documents are deleted, and no partial import remains.
6. `POST /api/imports/:id/revert` soft-deletes the batch's documents and bumps `data_version`.

**Mapping targets:** `id, title, text, author, date, date_end, date_precision, referenced_date, language, kind, genre, community, culture, collection, url, license, citation_of (id or list), tags (list), stemm_field`, plus `meta.*` for anything else (always preserved).

**Suggestions** come from header names (`date|year|published|issued → date`, `body|text|content|lyrics_excerpt → text`, …) and value sniffing: over 80% of values parse as dates means a date column, and the longest average string means text.

### 5.3 Date grammar (`src/shared/dategrammar.mjs`)

`parseDate(raw, {role, defaultEra}) → {t_lo, t_hi, precision, basis, label, raw} | {issue}`. Matching is case-insensitive, whitespace is collapsed, and en/fr/es month names are accepted.

```
date      := unknown | range | circa | point | decade | century | millennium | relative
unknown   := "" | "unknown" | "n.d." | "nd" | "?" | "undated" | "s.f." | "s.d."
point     := iso_day | iso_month | year | day_name | month_name
iso_day   := YYYY "-" MM "-" DD [T...]          -> day      [d, d+1)
iso_month := YYYY "-" MM                        -> month
day_name  := D month_word YYYY | month_word D "," YYYY
month_name:= month_word YYYY                    -> month
year      := ["-"] digits{1,5} [era]            -> year     (era: BCE|BC|B.C.|av. J.-C.|a. C. ; CE|AD|A.D.)
circa     := ("c." | "ca." | "circa" | "~" | "around") year | year "?"
                                                -> circa    [Y-5, Y+6), basis stated
decade    := YYY "0s" | "the " YYY "0s" | "'" D "0s" (warn: century assumed 19xx/20xx by nearest to 2026)
                                                -> decade   [Y, Y+10)
century   := ordinal "century" [era] | ("early"|"mid"|"late") ordinal "century"
                                                -> century  (early = first third, mid = middle third, late = last third → precision 'range')
millennium:= ordinal "millennium" [era]
range     := point ("–"|"-"|"to"|"/"|"between … and") point   -> range [lo.t_lo, hi.t_hi)
             "1850/51" -> [1850, 1852)
relative  := "before" point | "after" point     -> issue OPEN_RANGE: stored as unknown + raw kept
```

Rules:
- A negative year or BCE uses astronomical numbering internally (`500 BCE → −499`).
- Year 0 in Cipher data means **unknown**, not 1 BCE (adapter-specific flag).
- Two-digit years such as `'93` are rejected with the hint "write 1993".
- A day-precision value outside the calendar (`2019-02-30`) is rejected and the row becomes undated, with a warning.
- The parser always returns `label`, which the UI shows verbatim with its precision ("c. 1850", "1990s", "3rd century BCE").

### 5.4 Duplicates, malformed rows, mixed languages

- **Exact duplicate** (same `content_hash`): rejected with the code `DUP_EXACT`, naming the existing document. An option keeps it as `duplicate_of`.
- **Near duplicate** (MinHash J ≥ 0.8): warning `DUP_NEAR` with the J value. The document is kept and flagged. Duplicate `ext_id` in a collection: rejected (`DUP_ID`), unless the option `upsert` is set.
- **Malformed:** ragged CSV rows (`ROW_RAGGED`: "row 57 has 9 fields, header has 8; check for an unquoted comma in 'title'"), JSON syntax errors (`JSON_SYNTAX`: "line 17, column 42: unexpected '}'"), empty text **and** empty title (`EMPTY_RECORD`, rejected), text-less rows with a title (accepted as `form='metadata'`), unparseable dates (`DATE_UNPARSEABLE`, the row is kept as undated and the message lists accepted examples), unknown language codes (`LANG_UNKNOWN`, detected language used instead), oversize text over 50 MB (`TEXT_TOO_LARGE`).
- **Mixed languages:** the document language comes from the mapping or the majority of passages. Each passage keeps its detected `lang`, and the language lane uses passage language through `expr_doc.plang`.

### 5.5 Field-mapping UI

The import wizard has three steps: **Upload**, then **Map** (a table of source columns × target field dropdowns, each with 5 sample values and an inline parse preview such as "c. 1850 → circa [1845–1856)"; red cells show issues), then **Review** (the dry-run summary). Commit leads to job progress over SSE and then the summary, with "open in timeline".

### 5.6 Import summary object

```json
{
  "batchId": 42, "file": "letters.csv", "format": "csv", "encoding": "utf-8", "delimiter": ",",
  "collection": {"corpus": "user", "slug": "letters", "title": "Family letters"},
  "counts": {"records": 412, "accepted": 401, "acceptedWithWarnings": 23, "rejected": 11,
             "passages": 1873, "tokens": 211044, "undated": 17, "duplicatesExact": 3, "duplicatesNear": 2},
  "dates": {"day": 210, "month": 44, "year": 90, "circa": 12, "decade": 18, "century": 5, "range": 5, "unknown": 17,
            "span": {"from": "1871", "to": "1964-08-02"}},
  "languages": {"en": 1601, "fr": 230, "und": 42},
  "mapping": {"text": "body", "date": "written", "author": "from", "meta.*": ["box", "folder"]},
  "mappingDecisions": [{"field": "date", "column": "written", "reason": "92% of values parse as dates"}],
  "issues": [{"severity": "warning", "code": "DATE_UNPARSEABLE", "locator": "row 57", "field": "written",
              "value": "Spring-ish 1890", "message": "Could not read 'Spring-ish 1890' as a date.",
              "hint": "Use '1890', 'c. 1890', '1890-04' or '1890s'. Row imported as undated."}],
  "issuesTruncated": false, "dataVersion": 48, "durationMs": 5210
}
```

---

## 6. Cipher mapping

Corpus `cipher` ("Cipher corpus: public-domain texts + culture metadata, no lyrics"). The adapters are in `src/adapters/cipher/`. Each one yields `NormalizedDocInput`, `RelationshipInput` and `AnnotationInput` objects to `DocumentWriter`. Adapters never write SQL themselves.

### 6.1 Gutenberg books (`cipher.gutenberg`, measure = tokens)

- **Documents:** 693 entries in `gutenberg.json`, of which 691 have a `.txt` file. The 2 missing files become warnings `TEXT_MISSING` and those entries are imported as metadata documents. Fields: `ext_id` = Gutenberg id, `kind=book`, `form=fulltext`, language from JSON, `prominence` = `links`, `original_meta_json` = the JSON object plus the matching `pg_catalog.csv` row.
- **Author:** the `author` field, falling back to `pg_catalog` Authors. 8 entries have an empty author, for example *Les Misérables*.
- **Original:** the whole `.txt` file. The **body region** runs from the line after `*** START OF` to `*** END OF`. 31 files lack one or both markers, and then the whole file is used with warning `NO_GUTENBERG_MARKERS`. Passages come only from the body. Paragraphs matching `/project gutenberg|small print|\*end\*the small print/i` are marked `boilerplate`, and the corpus-wide winnowing pass (§4.6B) catches the rest.
- **Dates:**
  - `published`, `year` precision.
  - `basis='estimated'` with source "pg_catalog author birth+40 rule (Cipher fetch_gutenberg_catalog.py)" when the year equals the first author's birth year + 40. Measured: **116 of 685 dated books** match that rule.
  - Otherwise `basis='stated'` with source "gutenberg.json (Wikidata-derived, unverified)". Spot check: *Pride and Prejudice* is listed as 1800 (first published 1813) and *Ulysses* as 1914 (first published as a book in 1922), so the UI's date card says "unverified". An optional `stemm.wikidata-dates` refresh (network, opt-in) can upgrade dates to P577.
  - 8 undated books become `unknown`.

### 6.2 Wikisource (`cipher.wikisource-hi`, `cipher.wikisource-gu`, measure = tokens)

- **Documents:** one per JSONL line. 450 hi and 375 gu, with `kind=book` and `ext_id` = `index`.
- **Original:** the raw JSONL line is stored as the source of truth (the batch's original file is the JSONL file, and `original_start/end` mark the line). The **document text** is `pages.join('\f')`, written as a derived text original (its own sha256), and offsets refer to it. The page number is the count of `\f` before the start.
- **Passages:** paragraphs inside pages. OCR noise rules: `low` for passages under 50% letters, and `front_matter` for the first page of a book when it has fewer than 30 tokens per line on average.
- **Dates:** `year` or unknown (hi 42 and gu 172 undated, measured), `basis='stated'` with source "Wikisource index metadata".

### 6.3 Culture works (`cipher.culture-works`, measure = works)

Each of the 94,385 rows becomes one **metadata document**. `ext_id` = the 0-based row number, the QID goes into `original_meta_json`, `kind` comes from the column, `culture` = country code, and `prominence` = weight. The original file is `culture-works.tsv`. `original_start/end` mark the row's line, so every passage offset points into the verbatim TSV line.

| Column | Becomes | Evidence |
|---|---|---|
| title, native title | passages `field=title/native_title` (searchable, the main "rap layer" signal) | documented (Wikidata/Wikipedia label) |
| maker | `document.author` + facet `maker` | documented |
| summary | passage `field=summary` (the Wikidata description, e.g. "1993 single by Dr. Dre") | documented |
| year | `published` date, `year` precision; **0 → unknown** (book 2,525, song 4,090, tv 1,269, …) | stated |
| canon | facets `canon` | documented |
| themes | facets `theme`, weight kept. Provenance is **`cipher.tagging`** (`proposed`) if the theme appears in that QID's `tags/*.jsonl` batch, otherwise `wikidata/wikipedia category` (`documented`) | per theme |
| motifs, meaning, mood | **machine annotations** (`kind=motif/meaning/mood`, `author='cipher.tagging'`, `method='Cipher tagging pass (Claude sub-agent, Oct 2026)'`). Genre-derived moods carry `data_json.heuristic=true`. Searchable only in the "Tags (machine, fallible)" scope, never counted as occurrences | computed |
| siblings | relationships (below) | per source code |
| sampled_count | facet `sampled_count` | documented (count of sampled-by links) |

**Siblings** (`row:relation:strength[:source]`). Reciprocal pairs such as `samples` and `sampled by` collapse into **one** directed relationship: source = the earlier, reused work, target = the later work.

| Relation (measured count) | type / family | evidence_status | provenance |
|---|---|---|---|
| samples / sampled by [w 1,030 · m 487 · d 47] | `sample` / adaptation | documented | wikipedia / musicbrainz / wikidata |
| interpolates [w 273 · m 109] | `interpolation` / adaptation | documented | per code |
| cover of [m 823 · w 136] | `cover` / adaptation | documented | per code |
| version of / other version [m, d, w, -] | `version` / adaptation (undirected if same year) | documented | per code, `-` → wikidata with `provenance_uncertain=1` |
| adapted as / based on [- 3.2k/3.1k] | `adaptation` | documented, **provenance_uncertain=1** | "wikidata P144/P737 via build_culture.py (source code not recorded)" |
| remade as / remake of [- ~1k] | `remake` / adaptation | documented, provenance_uncertain=1 | wikidata |
| inspired / inspired by [i 110 · w 103 · - ~500] | `inspired_by` | i/w: documented. `-`: **proposed** if the pair occurs in `tags/*.jsonl`, else documented with provenance_uncertain | itwofs (CC BY 2.5, `license_note` with link-back) / wikipedia / cipher.tagging |
| from film / features song [w 12.6k/10k · d 2.5k] | `soundtrack` / containment | documented | per code |
| written for / song from [w] | `soundtrack` / containment | documented | wikipedia |
| answered by | `answer` / response, `direction='feedback'` | documented | per code |
| remix of / remixed as | `remix` / adaptation | documented | per code |
| **kindred [26,001]** | `kindred` / similarity | **computed** (theme similarity ≤ 0.7; `score` = strength; label "thematic similarity, not influence") | cipher.build |
| **counterpart [871]** | `counterpart` / similarity | **proposed** | cipher.tagging (or title match) |

Strength is always stored as `score` (a heuristic), never as `confidence`. By default kindred and counterpart are **hidden** in the lineage explorer (they are not lineage) and shown in the constellation only through a "similarity edges" toggle.

### 6.4 Roots (`cipher.roots`)

- 54,989 rows go into `etymon`. The `roots` column goes into `etymon_parent`, and **more than one parent means competing hypotheses**. For example, `la:signale` lists both `ine-pro:*sek-` ("to cut") and `ine-pro:*sekʷ-` ("to follow"). Both are shown as alternatives in one `hypothesis_group='etym:la:signale'`, documented by Wiktionary, with the relationship between them unresolved.
- `members` goes to `etymon_member` (103,252 links, measured).
- `relationship` rows (`etymological_descent`, documented, provenance `wiktionary (kaikki.org, CC BY-SA)`) are **materialized on demand** when an expression is opened (bounded to ≤ 200 per expression), not all at bootstrap.
- `lang_period` is seeded from `data/lang-periods.tsv`:

| lang | t_lo | t_hi |
|---|---|---|
| ine-pro | −4499 | −2499 |
| grc | −799 | 601 |
| la | −74 | 201 (note: "includes later Latin forms in Wiktionary") |
| sa | −1499 | 1001 |

  These are conventional ranges, with the note "period, not attestation".
- A member word (`en:genetic`) is an `expression` placed by its first observed occurrence, labeled "first observed in loaded corpus (not coinage)".

### 6.5 Derived files

- `culture-lines.tsv` (254,733 lines) is **not imported**. It is derived from §6.1–6.2. It is used as a **test oracle**: a sample of 1,000 lines must be locatable in imported passages (target ≥ 95%, misses reported).
- `culture-themes.tsv` goes to `theme_assoc` (computed NPMI) for theme nodes in the constellation.
- `hinges.tsv` and the Loom lines are skipped (derived). MusicBrainz tables and `relations_*.json` are left to a later `cipher.musicbrainz` adapter. They are not in v1.

### 6.6 Provenance and evidence vocabulary (`src/shared/vocab.mjs`)

- `evidence_status`:
  - `documented`: an external source asserts it.
  - `computed`: Scrolls or Cipher calculated it.
  - `proposed`: a heuristic or hypothesis, from tagging, title match, an attribution cue or a user hypothesis.
  - `human_confirmed` and `human_rejected`: a reviewer decided, and a revision exists.
  - `disputed`: competing human positions, or a confirmed alternative exists.
- `synthetic` is **orthogonal**. A synthetic relationship can be documented *within the demo world* and still be drawn hatched with the "SYNTHETIC" pill.
- Provenance values: `wikipedia, wikidata, musicbrainz, itwofs, wiktionary, gutenberg, wikisource, pg_catalog, openalex, ngram, cipher.build, cipher.tagging, scrolls.<stage>@<ver>, apple.NLTagger, apple.NLEmbedding, user:<name>, demo.synthetic`.

---

## 7. API

Conventions:
- JSON over `http://127.0.0.1:3460`. The server binds only to loopback.
- The `Host` header must be `127.0.0.1:3460` or `localhost:3460` (protection against DNS rebinding). Mutating requests require a same-origin `Origin`.
- Errors take the form `{error:{code, message, hint, details}}` with a correct HTTP status.
- Every GET returns `ETag: W/"<dataVersion>-<hash>"` and honors `If-None-Match`.
- Every list has `limit` (maximum 200) and an opaque `cursor`.
- Every object that can be synthetic carries `synthetic: true|false`.
- Filters are encoded as `f=lang:en,fr;kind:book,song;basis:-estimated;evidence:documented,computed;syn:0`.

### 7.1 Endpoint list

| Method & path | Purpose | Heavy (read pool) |
|---|---|---|
| GET `/api/health` | version, dataVersion, db size, jobs running, adapters (`nl: available\|missing`) | |
| GET `/api/events` | SSE: `job` progress, `data` (dataVersion bump), `adapter` | |
| GET `/api/corpora` | corpora → collections, with docs, tokens or works, coverage summary, licenses, synthetic | |
| GET `/api/facets?f=` | available filter values with counts | ✓ |
| GET `/api/search?q=&scope=text\|titles\|tags\|etymology\|annotations\|all&f=&limit=&cursor=` | passages and suggestions | ✓ |
| POST `/api/expressions` | resolve or create an expression, return its state, and start materialization | |
| GET/PATCH `/api/expressions/:id` | variants, state, stats, etymology summary; PATCH toggles variants | |
| POST `/api/timeline/query` | register a canonical query and get its `queryKey`, lanes and extent | ✓ |
| GET `/api/timeline/tiles?q=&level=&tiles=` | aggregated bins per lane | ✓ |
| GET `/api/timeline/segments?q=&level=` | bar segments over the whole extent (overview, a11y table, SVG) | ✓ |
| GET `/api/timeline/marks?q=&t0=&t1=&limit=4000` | individual occurrences | ✓ |
| GET `/api/timeline/undated?q=&cursor=` | the undated shelf | |
| GET `/api/coverage?f=&level=&t0=&t1=&lanes=` | denominators per lane × bin | ✓ |
| GET `/api/passages/:id?context=1` | passage with offsets, document, occurrences, annotations, relationship counts | |
| GET `/api/documents/:id` · `/api/documents/:id/text?start=&end=` | metadata including `original_meta_json`; raw slice up to 20k chars | |
| GET `/api/kwic?expr=&t0=&t1=&lane=&f=&sort=date\|spread&cursor=` | concordance lines | ✓ |
| GET `/api/collocations?expr=&t0=&t1=&f=` | neighbors, or a gated response | ✓ |
| GET `/api/clusters?expr=&run=` | sense hypotheses, links, gates | |
| POST `/api/compare` | Compare view payload (§2.4) | ✓ |
| POST `/api/trace` | seeded quotation trace (synchronous within 1.5 s, else `{jobId}`) | ✓ |
| GET `/api/lineage?root=&depth=&maxNodes=&types=&evidence=&cursor=` | bounded lineage graph | ✓ |
| GET `/api/relationships/:id` · `/revisions` | edge card | |
| POST `/api/relationships` | human-proposed relationship (`proposed`, `provenance=user:<name>`) | |
| POST `/api/relationships/:id/review` | `{action: confirm\|reject\|dispute, note, evidence[]}` → revision | |
| GET `/api/constellation?expr=&a=&b=&size=occ\|docs&max=120` | nodes and edges with stable positions | ✓ |
| GET/POST `/api/annotations` · PATCH `/:id` · POST `/:id/retract` · GET `/:id/revisions` | notebook CRUD (append-only) | |
| POST `/api/views` · GET `/api/views/:slug` · GET `/api/views` | saved views | |
| POST/PUT/GET `/api/imports…` | §5.2 | |
| GET `/api/jobs?status=` · GET `/api/jobs/:id` · GET `/api/jobs/:id/events` · POST `/api/jobs/:id/cancel` | jobs | |
| GET `/api/export?view=\|state=&what=occurrences\|passages\|relationships\|annotations\|bins&format=json\|csv\|jsonl` | streamed export | ✓ |
| GET `/api/export/snapshot.svg?view=` | server-rendered vector snapshot | ✓ |
| GET `/api/adapters` · POST `/api/adapters/:id/enable {approve:true}` · POST `/api/adapters/:id/sync` | source adapters (network ones require approve) | |
| GET `/api/tour` | demo tour script (ids resolved) | |

### 7.2 Key shapes

```jsonc
// POST /api/timeline/query
{ "expressions": [12], "f": "lang:en,fr;syn:1", "lanes": {"dim": "cluster", "run": 14, "max": 12, "order": "first_observed"},
  "timeBasis": "published", "vantage": null }
// →
{ "queryKey": "9f2c41aa07b3e1d0", "dataVersion": 47,
  "status": "ready",                       // ready | estimating | materializing
  "jobId": null,
  "measure": {"text": "per_million_tokens", "metadata": "per_thousand_works"},
  "lanes": [ {"key": "c:3", "label": "≈ coil · current · lab", "labelSource": "machine", "measure": "text",
              "occ": 22, "docs": 9, "first": {"t": 1947.0, "label": "1947"}, "last": {"t": 1971.5, "label": "1971"},
              "evidence": "computed", "stability": 0.81, "synthetic": true } ],
  "other": {"lanes": 0, "occ": 0},
  "extent": {"tMin": 1947.0, "tMax": 2024.9},
  "totals": {"occ": 61, "dated": 57, "impreciseAtLevel": {"year": 4, "decade": 1}, "undated": 1, "docs": 27, "sampled": false},
  "gates": {"cluster": {"status": "ok"}} }

// GET /api/timeline/tiles?q=9f2c41aa07b3e1d0&level=2&tiles=3
// decade bin = floor(Y/10); tile = floor(bin/64) → tile 3 = bins 192..255 = years 1920–2559
{ "queryKey": "9f2c41aa07b3e1d0", "level": 2, "binWidth": 10, "dataVersion": 47,
  "tiles": [ { "tile": 3, "bin0": 192,
      // cells: [binIndexWithinTile, occ, docs, tokensOrWorks, rate, flags]; flags: 1 thin, 2 noMaterial,
      //        4 estimatedMajority, 8 sampled, 16 synthetic     (index 6 = bin 198 = the 1980s)
      "lanes": { "c:3": [[2, 9, 4, 18200, 494.5, 17]], "c:5": [[6, 14, 6, 21900, 639.3, 16]] },
      "imprecise": { "c:5": [{"tLo": 1900, "tHi": 2000, "precision": "century", "n": 1}] },  // wider than a decade bin
      "coverage": [[2, 0, 31, 18200], [6, 0, 40, 21900]] } ] }   // [idx, works, docs, tokens]

// GET /api/timeline/marks?q=…&t0=1979&t1=1980&limit=4000
{ "marks": [ { "occ": 5531, "t": 1979.63, "tLo": 1979.58, "tHi": 1979.67, "precision": "month", "basis": "stated",
               "lane": "c:5", "doc": 211, "passage": 1804, "kind": "text", "evidence": "documented", "synthetic": true } ],
  "truncated": false }

// GET /api/passages/1804?context=1
{ "id": 1804, "doc": { "id": 211, "title": "Circle Talk #1 (zine)", "author": "MC Static Ward [synthetic]",
      "date": {"label": "August 1979", "tLo": 1979.58, "tHi": 1979.67, "precision": "month", "basis": "stated",
               "source": "demo.synthetic", "role": "published"},
      "referencedDates": [], "kind": "zine", "language": "en", "collection": "demo/calder", "synthetic": true,
      "license": "CC0 (synthetic)", "originalMeta": {"…": "verbatim record"} },
  "start": 412, "end": 655, "unit": "paragraph", "page": null, "lang": "en", "quality": "ok",
  "text": "…we flux up the room till the floor forgets it is a floor…",
  "before": {"id": 1803, "text": "…(≤600 chars)"}, "after": {"id": 1805, "text": "…"},
  "occurrences": [ {"id": 5531, "expressionId": 12, "start": 431, "end": 438, "variant": "flux up"} ],
  "annotations": [ {"id": 77, "kind": "interpretation", "author": "demo-curator", "rev": 2, "synthetic": true} ],
  "relationships": {"out": {"near_quotation": 0, "proposed_allusion": 1}, "in": {}},
  "source": {"sha256": "3b1f…", "offsets": "utf16", "docSpan": [0, 2210]} }

// GET /api/lineage?root=passage:901&depth=2&maxNodes=150
{ "root": "passage:901",
  "nodes": [ {"id": "passage:901", "kind": "passage", "doc": 88, "label": "Varga, 'On Faithful Transmission' (lecture)",
              "t": {"label": "12 Apr 1911", "tLo": 1911.28, "tHi": 1911.28274, "precision": "day"}, "lane": "lecture", "synthetic": true} ],
  "edges": [ {"id": 3301, "type": "exact_quotation", "family": "quotation", "source": "passage:901", "target": "passage:1422",
              "direction": "forward", "evidence": "computed", "provenance": "scrolls.quotes@1",
              "method": "winnow k=7 w=10 + banded SW", "score": 1.0, "confidence": null,
              "support": [{"passage": 901, "role": "source", "start": 120, "end": 159}, {"passage": 1422, "role": "target", "start": 88, "end": 127}],
              "hypothesisGroup": null, "rev": 1, "synthetic": true } ],
  "groups": [ {"key": "hold-the-circle-origin", "edges": [3410, 3411], "status": "disputed"} ],
  "truncated": {"nodes": 0, "reason": null} }

// POST /api/compare  (response excerpt)
{ "a": {"label": "1940–1990", "tokens": 31100, "docs": 41, "authors": 19, "occ": 44, "ratePerM": 1414.8, "ci95": [1028, 1899]},
  "b": {"label": "1991–2026", "tokens": 26400, "docs": 52, "authors": 23, "occ": 57, "ratePerM": 2159.1, "ci95": [1635, 2797]},
  "composition": {"jsd": 0.31, "warning": "A is 70% lab/technical notes; B is 48% forum posts.", "strata": [ … ]},
  "neighbors": {"shared": ["coil"], "newInB": [{"term": "cluster", "logDiceB": 11.2}], "declining": [{"term": "reading"}]},
  "clusters": {"run": 14, "shares": {"a": [...], "b": [...]}, "jsd": {"value": 0.42, "ci95": [0.31, 0.55]}, "gate": {"status": "ok"}},
  "displacement": {"status": "insufficient", "value": null,
                   "reasons": [{"code": "NO_ALIGNED_SPACE", "message": "Corpus slice under 3M tokens; embedding comparison unavailable."}]},
  "tone": {"status": "unavailable", "reasons": [{"code": "ADAPTER_MISSING"}]},
  "representative": {"a": [1804, 1222], "b": [3001, 3120]} }

// annotation write
POST /api/annotations { "target": {"kind": "relationship", "ref": "3410"}, "kind": "interpretation",
  "body": "Origin in the 1931 boxing column is weaker: no attribution cue.", "data": {"tags": ["origin"], "evidence": [{"passage": 2101, "role": "against"}]} }
PATCH /api/annotations/88 { "body": "…revised…", "reason": "found 1979 zine" }  // → {id: 88, rev: 3}

// saved view
POST /api/views { "title": "flux up: four senses", "state": { /* ViewState §8.2 */ } }
→ { "slug": "flux-up-four-senses-3f9a", "url": "/#/v/flux-up-four-senses-3f9a", "dataVersion": 47, "runIds": {"cluster": 14} }
GET /api/views/flux-up-four-senses-3f9a
→ { "state": {…}, "savedAt": "…", "dataVersion": 47, "currentDataVersion": 52,
    "drift": {"dataChanged": true, "importsSince": [{"batch": 43, "file": "letters.csv"}],
              "asSavedAvailable": true, "message": "Corpus changed since this view was saved. 'As saved' restricts to imports ≤ #42."} }

// SSE /api/jobs/:id/events
event: progress
data: {"jobId": 19, "fraction": 0.42, "phase": "align", "message": "aligned 840 of 2000 candidates", "counts": {"pairs": 61}}
event: done
data: {"jobId": 19, "result": {"runId": 31, "relationships": 74}}
```

Exports always begin with a provenance header. In JSON it is a top-level object, in CSV `#` comment lines, and in JSONL the first line: `{view, state, dataVersion, runIds, filters, generatedAt, syntheticIncluded, licenses[]}`. Every row carries `synthetic`, `evidence_status` and `provenance`. The PNG snapshot is produced client-side (§8.9). The SVG comes from the server, rendered from segments and arcs, deterministic and testable.

---

## 8. Frontend architecture

Vanilla ES modules from `public/js/` and `src/shared/` (served at `/shared/`). No build step and no CDN libraries.

### 8.1 Modules

| Area | Modules |
|---|---|
| core | `store.mjs` (state, subscribe, URL sync), `api.mjs` (fetch, error mapping, abort on supersede), `sse.mjs`, `dom.mjs` (h(), focus management, live region), `keys.mjs` (scoped key registry), `evidence-style.mjs` (single evidence → style mapping), `tilecache.mjs` |
| shell | `layout.mjs` (desktop/narrow regions, bottom sheet), `searchbar.mjs`, `filters.mjs`, `help.mjs`, `synthetic-ribbon.mjs` |
| timeline | `timeline.mjs` (mount), `scale.mjs`, `lod.mjs`, `tiles-client.mjs`, `bars.mjs` (bins → segments), `layers/{axis,coverage,bars,imprecise,periods,marks,arcs,branches,playhead,selection}.mjs`, `hittest.mjs`, `gestures.mjs`, `play.mjs`, `lanes-dom.mjs`, `undated-shelf.mjs`, `legend.mjs`, `a11y-table.mjs`, `snapshot.mjs` |
| panels | `inspector.mjs` (Then/Now/Next), `passage-card.mjs`, `evidence-badge.mjs`, `lineage.mjs`, `constellation.mjs`, `compare.mjs`, `notebook.mjs`, `annotation-editor.mjs`, `revisions.mjs`, `views-menu.mjs`, `jobs-tray.mjs` |
| import | `wizard.mjs`, `mapping-table.mjs`, `summary.mjs` |
| tour | `tour.mjs` |

### 8.2 State and URL

```js
ViewState = {
  v: 1,
  route: 'timeline' | 'lineage' | 'constellation' | 'compare' | 'notebook' | 'import',
  expr: ['flux up'],                         // expression texts (ids resolved server-side; texts keep URLs readable)
  f: { lang: [], kind: [], culture: [], stemm: [], coll: [], basis: ['stated','estimated'],
       evidence: ['documented','computed','proposed','human_confirmed','disputed'], syn: 1, undated: 1 },
  lanes: { dim: 'cluster', max: 12, order: 'first_observed', pinned: [] },
  measure: 'rate' | 'count',
  x: { c: 1965.0, ppy: 4.2, fold: null },     // center & zoom; fold = break year or null
  basis: 'published' | 'referenced',
  vantage: { on: false, t: null },
  range: null | [t0, t1],
  sel: null | { kind: 'occ'|'passage'|'cluster'|'rel'|'doc', id },
  cmp: null | { a: {t0, t1, f}, b: {t0, t1, f} },
  layers: { documented: 1, computed: 1, proposed: 0, annotated: 1, tags: 0, similarity: 0 },
  runs: { cluster: 14, vectors: null, quotes: 9 },
  asOf: null                                   // saved-view "as saved" mode: max import batch
}
```

The URL hash is readable, not base64:
`#/timeline?e=flux%20up&ln=cluster:12:first&x=1965@4.2&f=lang:en;syn:1&vp=1994.5&r=1940-1990&sel=occ:5531&cmp=1940-1990~1991-2026&ly=dcah&run=c14`.
`store.mjs` writes the URL on change, debounced 250 ms with `history.replaceState`. Discrete actions (selection, route) use `pushState`. `viewstate.mjs` (shared) validates and canonicalizes the state: sorted filter lists and rounded numbers, so equal views produce equal hashes. A saved view is `#/v/<slug>`.

### 8.3 Canvas rendering

- **Two stacked canvases** per timeline. **Base**: axis, coverage, periods, bars, imprecise rows, marks, arcs. It is redrawn on pan, zoom or data change. **Overlay**: playhead, hover, selection, range brush. It is redrawn on pointer move. Lane labels, the legend and the undated shelf are **DOM**, not canvas, for crisp text and screen readers. Device pixel ratio is clamped to 2.
- Data per tile is held as `Float32Array` columns per lane (occ, rate, flags). `bars.mjs` turns the visible bins into segment lists once per (level, viewport) change, not per frame.
- All draws are coalesced into one `requestAnimationFrame`. Pan within the already-fetched tile range does no allocation.
- Tiles are prefetched for the viewport ±1 viewport width and kept in an LRU of 512 tiles keyed by `queryKey|level|tile|dataVersion`. On a level change the old level's bins stay visible, dimmed, until the new tiles arrive. They are never interpolated.

**Performance budgets** (verified by `?perf=1`, a HUD that logs p50 and p95 frame times):

| Budget | Target |
|---|---|
| Base redraw during pan/zoom | ≤ 8 ms p95 at 1440×900 @2x on M-series |
| Overlay redraw | ≤ 2 ms |
| Max drawn marks per frame | 20,000 rects/ticks (bars + coverage + marks); individual occurrence ticks ≤ 4,000; individual arcs ≤ 300; `fillText` calls ≤ 150 |
| Tile fetch, warm | ≤ 50 ms p95 |
| Tile fetch, cold (levels 0–3) | ≤ 300 ms |
| Marks fetch | ≤ 150 ms |
| Time to interactive (demo) | ≤ 1.5 s from cold server start; JS shipped ≤ 400 KB unminified |
| Long tasks | no main-thread task > 50 ms (lineage layout > 300 nodes goes to a Web Worker, `public/js/panels/layout.worker.mjs`) |

### 8.4 Hit-testing

On every base redraw `hittest.mjs` builds a **uniform grid** (16 px columns × lane rows) of drawn primitives `{kind, id, x0, x1, y0, y1}`. Arcs are flattened into 12-point polylines and inserted per segment. Pointer lookup checks the 3×3 neighboring cells and picks the nearest primitive (ticks are preferred over bars when within 4 px). The lookup is O(1) per move. Touch uses a 12 px radius (a 24 px target).

### 8.5 Keyboard map

| Key | Action |
|---|---|
| `/` | focus search |
| `←` `→` (`⇧` ×10) | pan by 10% of the viewport |
| `+` / `-` (or `=`) | zoom around center (or around the focused mark) |
| `0` | fit to extent |
| `1`–`6` | jump to tier Z0–Z5 |
| `[` / `]` | playhead back/forward one bin |
| `Space` | play/pause |
| `v` | toggle vantage mode |
| `Home` / `End` | first or last observation |
| `↑` `↓` | move focus between lanes |
| `Tab` / `⇧Tab` | move focus between segments in the lane (roving tabindex on DOM proxies) |
| `Enter` | open the focused segment's passages, or the selected mark's passage |
| `L` | cycle lane dimension |
| `a` / `b` | set compare slice A or B from the range |
| `c` | open Compare |
| `g` | lineage for the selection |
| `n` | new note on the selection |
| `s` | save view |
| `t` | toggle the data-table alternative |
| `m` | reduced motion |
| `?` | help overlay |
| `Esc` | close panel, clear selection |

### 8.6 Touch, narrow viewport, accessibility

- **Touch:** one-finger drag pans (inertia off in reduced motion). Pinch zooms around the midpoint. Tap selects. A long press (500 ms) opens the context sheet (annotate, lineage, compare). Two-finger tap zooms out one tier. Dragging the playhead handle needs a 44 px target. Pointer Events are used throughout.
- **Narrow (< 720 px):**
  - The timeline takes the top 55vh and the inspector becomes a bottom sheet with snap points at 30%, 60% and 92%.
  - At most 6 lanes are shown, with "+k lanes" collapsed.
  - Filters move into a sheet. The constellation and lineage views are full-screen routes with a back button.
  - Compare stacks A over B. The legend collapses to a single "Legend" chip that opens the full legend. It is still always reachable.
  - **The main flow (search → timeline → passage → compare → save) works without any hover.**
- **Accessibility:**
  - Ivory `#EDE6D6` on charcoal `#0E1013` gives about 15:1. Muted text `#8F897B` gives about 5.3:1, and nothing smaller than 12 px uses muted.
  - Focus rings are 2 px cyan with a 2 px offset.
  - Every canvas has `aria-hidden="true"` and is paired with a **data-table alternative**: a lane × visible-bins table with occ, rate and docs, plus a **segment list** per lane ("English: observed 1841–1879; gap 1880–1893, observed absence, 2.1M tokens; observed 1894–1928"). It is toggled with `t` and always present for screen readers via `aria-describedby`.
  - Focused segment changes are announced in a polite live region: "Lane English, 1850s: 37 occurrences, 4.1 per million tokens, 12 documents, 2 estimated dates."
  - No information is carried by color alone (§8.7).

### 8.7 Color tokens and the evidence grammar

```css
:root {
  --bg-0:#0E1013; --bg-1:#15181D; --bg-2:#1C2027; --line:#2A2F38;
  --ivory:#EDE6D6; --ivory-2:#C9C2B2; --muted:#8F897B;
  --cyan:#3FD0E0;   /* selection, focus, navigation, playhead */
  --amber:#E8A84A;  /* historical references, documented evidence, period bands */
  --violet:#A98BF5; /* reinterpretation, feedback arcs, hypotheses about later meaning */
  --computed:#7FA7B0; --proposed:#8F897B; --danger:#F07167; --ok:#7BD389;
  --hatch-synthetic: repeating-linear-gradient(135deg, #ffffff14 0 2px, transparent 2px 7px);
}
```

| Evidence | Stroke | Endpoint glyph | Color | Badge text |
|---|---|---|---|---|
| documented | solid 1.5 px | filled dot ● | amber | DOCUMENTED · Wikipedia |
| computed | dashed 6-4 | hollow square □ | `--computed` | COMPUTED · quotes@1 |
| proposed | dotted 1-4 | "?" | `--proposed` | PROPOSED · tagging |
| human_confirmed | solid 1.5 px + ✓ | filled dot + ✓ | amber | CONFIRMED by utkarsh |
| human_rejected | hidden by default; shown struck through | ✕ | `--danger` 60% | REJECTED |
| disputed | double line | ⇄ | ivory-2 | DISPUTED (2 hypotheses) |
| feedback / reinterpretation | any of the above, drawn **below** the lanes | arrowhead on the earlier end | violet | REINTERPRETS |
| synthetic (orthogonal) | + the `--hatch-synthetic` overlay | | | SYNTHETIC pill |

`evidence-style.mjs` is the **only** place this mapping exists. The timeline, lineage, constellation, legend, SVG export and PNG snapshot all import it. A unit test asserts that the dash patterns of documented and computed edges differ.

### 8.8 Empty, loading, error and low-evidence states

- **Empty search:** "No occurrences of 'hacker' in the loaded corpus (68M tokens, full text to 1928; 94k titles)." Then suggestions: variants, the etymology entry, and "enable the STEMM shelf (opt-in)".
- **Loading:** a skeleton of the lanes plus "counting… 41%" from SSE. Never a spinner without a number.
- **Error:** the server `message` and `hint`, plus a retry.
- **Low evidence:** gate cards (§4.10).

### 8.9 Snapshots

PNG: `snapshot.mjs` composites base + overlay + an off-screen render of the DOM legend, lane labels and a caption ("Scrolls · view flux-up-3f9a · data v47 · run c14 · contains SYNTHETIC data"), then `canvas.toBlob`. SVG: `GET /api/export/snapshot.svg`.

---

## 9. Demonstration corpus: "Calder Basin" (all synthetic)

Corpus `demo`, collection `demo/calder`. **Every** person, work, date, passage and link is invented. The corpus ships as `data/demo/*.jsonl` (about 150 documents, ~500 passages, ~55k tokens, CC0).

- The corpus title is "DEMO · Calder Basin (synthetic, invented)".
- Authors carry the suffix `[synthetic]`, so it survives copy/paste.
- `synthetic=1` is set on every row, and demo marks are hatched.
- The copy button on a passage appends "(synthetic demo passage)".
- Relationship provenance is `demo.synthetic`.
- The calibration of the corpus is published in the tour: *flux up* has 61 occurrences in 27 documents, so clustering and compare gates pass. *gutter saint* has only 12 occurrences before 1980, so the compare gate **fails on purpose**.

### 9.1 Cast (four generations)

| Gen | Years | Synthetic people and works |
|---|---|---|
| I · Founders | 1888–1923 | **Ines Halvorsen**, mine-safety engineer, *Signals for Shaft Work* (1891, year). **Dr. Amelie Varga**, physicist, lecture *On Faithful Transmission* (12 Apr 1911, day). **Marrow & Pike Ironworks**, hiring broadsheet (c. 1898, circa). **The Calder Courier**, satire column (June 1923, month). An anonymous broadside ("19th century", century precision). |
| II · Builders | 1931–1972 | **"Ringside" column** (1931, boxing). **Dr. Teodor Rask**, lab notebook (1947). **Blue Lantern Committee**, strike pamphlet (1963-10-02). **Ruth Okafor-Lane**, novel *The Long Shift* (1968). Electricians' union newsletter (1950s, decade precision). |
| III · Cipher era | 1979–2001 | **MC Static Ward**, verses in the zine *Circle Talk* #1 (Aug 1979) and the track *Quiet Static* (1984). **Iron Promise** (crew), track *Rust Delivery* (1986). **Lady Calder**, track *Gutter Saint* (1988) + liner notes. **DJ Mosfet**, track *Every Signal Remembers* (1994) + liner notes. *Circle Talk* #14 letters page (1990s, decade). |
| IV · Network | 2005–2026 | **Lantern Kids** crew site (2008). **Kira Vance**, systems-engineering blog (2012-02-03; 2021-05-19). **Dr. Priya Sol**, clinic memo (Sept 2016). **Gutter Saints Choir** programme (2015). Calder forum threads (2019–2025, day precision). *Basin Talk* podcast transcript (2023-11-08). Three **undated** scraps (chalk-mark photo captions, "n.d."). |

### 9.2 The seven phenomena

| # | Phenomenon | Expression | Synthetic evidence chain |
|---|---|---|---|
| 1 | sincere → ironic | **iron promise** | 1898 broadsheet: "our iron promise: a wage every Saturday" (sincere) → 1968 novel: "the iron promise rusted in the rain" → 1986 track *Rust Delivery*: "iron promise, rust delivery". Clusters separate *wage/Saturday/honest* from *rust/delivery/joke*. Human annotations tag stance `sincere` vs `ironic`. |
| 2 | ironic → reclaimed | **gutter saint** | 1923 satire mocks "gutter saints who preach from puddles" → 1988 Lady Calder: *Gutter Saint*, liner notes: "I took the insult and wore it" → 2015 choir name, sincere. A violet **feedback** arc (`reinterprets`, documented in synthetic liner notes) runs from 1988 back onto 1923. The Compare gate fails for 1920–1979 (n=12), showing gated honesty. |
| 3 | symbol across communities | **blue lantern** | 1891 shaft signal "blue lantern = cage clear, come up" → 1963 strike pamphlet "light the blue lantern: no one goes down alone" → 2008 crew insignia → 2021–24 forum: blue lantern emoji = "walk-you-home" safety signal. Lanes = community (miners, labour, hip-hop crew, nightlife forum). |
| 4 | remembered reference, new context | **"Every signal remembers its source."** | 1911 lecture (origin) → 1968 novel quotes it **verbatim** with the cue "as Varga said" (computed exact quotation + proposed explicit citation) → 1994 track title *Every Signal Remembers* (computed near quotation on the title + synthetic-documented `sample` of a 1911 lecture recording in the liner notes) → 2021 blog "every signal remembers its source, so log your provenance" (data-engineering maxim). |
| 5 | term splitting | **flux up** | 1947 physics notebook "flux up the coil before the reading" → 1979 zine "flux up the room" (hype) → 2012 blog "flux up the cluster before launch" (scale) → 2016 clinic memo "flux up the dose over three days" (medicine). Four clusters, split connectors from the 1947 trunk. |
| 6 | convergence | **ghost current** + **quiet static** | 1950s newsletter "ghost current", leakage that drains a battery (engineering) + 1984 *Quiet Static*, unspoken tension in a room (rap) → 2019–2025 forum: "that ghost current at work, the quiet static nobody names", both meaning *an unseen drain you live with*. A convergence ribbon in multi-expression mode. |
| 7 | disagreement becomes inheritance | **hold the circle** | 1979 Static Ward: "hold the circle", meaning guard who gets in → *Circle Talk* #14 letters: "holding the circle means keeping it OPEN" vs "means keeping it TIGHT" → 2023 podcast: "we hold the circle, meaning we keep arguing about who's in it". Two **competing origin hypotheses** (1931 boxing "hold the ring" vs 1979 zine) in one `hypothesis_group`, one human-annotated as stronger, the other `disputed`. A demo annotation has 2 revisions (rev1 "means exclusivity" → rev2 "means the argument itself"). |

### 9.3 Guided tour (`data/demo/tour.json`, served by `/api/tour`)

| Step | User action | What they see and learn |
|---|---|---|
| 1 | Opens app | *flux up* timeline, SYNTHETIC ribbon. Learns: bar = observed span, height = rate, gaps are gaps. |
| 2 | Presses Space (Play) | Vantage advances through 1947, then a visible gap, then the 1979 branch. Learns: nothing appears without a document. |
| 3 | Presses `L`, picks "Sense hypothesis" | 4 cluster lanes with machine labels and dashed split connectors. Learns: clusters are hypotheses (run #, stability). |
| 4 | Clicks the 2016 tick | Inspector Then shows the clinic memo with the highlighted span and offsets. Now = the 2012 blog. Learns: every mark opens its passage. |
| 5 | Searches the quotation, presses `g` | Lineage: 1911 → 1968 (dashed *computed exact quotation* + dotted *proposed citation* with the cue "as Varga said") → 1994 (near quotation, synthetic-documented sample) → 2021. Learns: computed ≠ documented, visibly. |
| 6 | Confirms the 1968 citation | The edge becomes CONFIRMED and a revision appears in the edge history. Learns: human review is a layer. |
| 7 | Opens *gutter saint*, selects 1920–1979 as A and 1980–2026 as B, presses `c` | Compare: frequency with CIs, the composition warning, and the cluster-share card **disabled** (n=12 < 40). Learns: insufficient evidence is shown, not hidden. |
| 8 | Notebook on *hold the circle* | Two interpretations, one with 2 revisions stacked. Two competing origin hypotheses. Learns: disagreement is preserved. |
| 9 | Presses `s` | Saved view URL copied. A reload restores it exactly. |
| 10 | "Now try real data": searches *signal* | Real Cipher data: the `la:signale` period band with **two competing PIE roots** (Wiktionary), Gutenberg occurrences per language lane, and the coverage gap after 1928 hatched "no full text (copyright)". |

---

## 10. STEMM integration

### 10.1 Adapter interface (`src/adapters/api.mjs`, frozen in WP0)

```js
/** @typedef {{
 *   id: string, version: string, label: string, license: string, attribution?: string,
 *   access: 'local-file'|'local-dataset'|'network', measure: 'tokens'|'works',
 *   describe(): { configFields: FieldSpec[], approvalText?: string },     // network adapters: what is fetched, from where, volume
 *   probe(ctx): Promise<{ available: boolean, reason?: string, estimate: { docs: number, bytes: number, requests?: number } }>,
 *   documents(ctx, opts): AsyncIterable<NormalizedDocInput>,
 *   relationships?(ctx, resolve): AsyncIterable<RelationshipInput>,     // resolve(extRef) -> doc/passage id
 *   annotations?(ctx, resolve): AsyncIterable<AnnotationInput>,
 *   expressions?(ctx): AsyncIterable<ExpressionInput>                    // e.g. term watchlists, etymons
 * }} SourceAdapter
 * ctx = { dataDir, readDb, progress(f, phase, msg), checkpoint(), log, config,
 *         fetch: (url, opts) => Response   // present ONLY when access==='network' && enabled && approved;
 *                                           // rate-limited (default 1 req/s), cached under cache/<adapter>/ }
 */
```

`NormalizedDocInput = {extId, form, kind, title, nativeTitle, author, language, culture, genre, stemmField, community, url, license, citation, dates:[{role, raw, parsed?}], text?:{original, unit, pages?}, fields?:{title, summary, abstract}, originalMeta, facets:[{facet, value, weight, provenance, evidence}], synthetic}`. The core writer does all segmentation, normalization, FTS insertion, binning and coverage. A new source is one adapter file plus a row in `source_adapter`. Nothing in the core changes.

### 10.2 The four candidate sources (each pending the user's approval; all off by default)

| Adapter | Access | What it yields | Dates | Notes |
|---|---|---|---|---|
| `stemm.pg-shelf` | local (`pg_catalog.csv`) + **opt-in network** for texts | Metadata docs for Gutenberg Type=Text with LoCC Q/R/T. Measured: en Q 2,503 · T 1,603 · R 669; fr Q 85 · T 40; de Q 135 (about 5,292 titles across all languages). Text download is opt-in (gutenberg.org mirror, 1 req/s, cached), giving full-text docs. | `Issued` is the **Gutenberg release date**. It is stored as role `digitized`, never as publication. Publication date: Wikidata P2034 → P577 (opt-in) → `stated`. Else the author-lifetime **range** [birth+20, death] → `estimated`. Else unknown. 3,771 of the 5,292 have life dates. | Already 5 of the 693 downloaded books are STEMM-classed (Flatland QA, Descent of Man QH, Wild Animals I Have Known QL, Principles of Scientific Management T, Opticks QC). These get `stemm_field` immediately. |
| `stemm.openalex` | **network, opt-in** | Works (title, abstract reconstructed from the inverted index, year, field/topic, `referenced_works`) **sampled ≤ 20 per field per year, 1665–2026**. The sample order is recorded as a run parameter: default `cited_by_count desc`, alternative random with seed. Cap 200k. | `published`, year precision, `stated` | Metadata is CC0. Abstracts carry `license_note`: "publisher copyright may apply; stored for local research". **Citations between sampled works** become `explicit_citation`, `documented`, provenance `openalex`, the only documented citation source. Sampling bias is shown in the coverage tooltip. |
| `stemm.wiktionary` | local file (user-provided kaikki JSONL) or **opt-in** download | For a watchlist of STEMM terms: etymology sentences containing "first attested", "coined", or a year. | Stored as `doc_date(role='attested', basis='stated')` on a small "claim" document. | Rendered as **amber diamonds** in a "Dictionary claims" lane: "Wiktionary: first attested 1898". These are referenced-time claims, *not* corpus observations, and the legend says so. |
| `stemm.ngram` | local file (user-provided Google Books Ngram CSV extract) | Yearly relative frequencies for chosen terms | year | Drawn as an **external baseline line** in its own track above the lanes, with its own axis and the label "Google Books Ngram (CC BY 3.0), external corpus, not comparable to lane rates". It never enters lane counts. |

### 10.3 STEMM fields as lanes

`stemm_field` vocabulary: `mathematics, computing, physics, astronomy, chemistry, earth-sciences, life-sciences, medicine, engineering, technology-general`.
- **LoCC map:** QA → mathematics (QA75–76 → computing), QB → astronomy, QC → physics, QD → chemistry, QE → earth-sciences, QH/QK/QL/QM/QP/QR → life-sciences (QR = microbiology), R* → medicine, TA/TC/TJ/TK (TK5101+ → computing) → engineering, T/TX/other T* → technology-general.
- **OpenAlex** fields are mapped to the same ten keys (table in `src/adapters/stemm/fields.mjs`).
- With **lane = stemm**, non-STEMM material falls in an "outside STEMM" lane, so the cross-over is visible: the same expression in *medicine* and in *song titles*.

### 10.4 Following a term from science into culture, honestly (worked examples on the real data)

The **term journey** preset uses lanes = collection, with grouping: etymology period, STEMM texts, literature (Gutenberg), Wikisource, song titles, film/TV titles, dictionary claims, Ngram baseline.

- ***virus***:
  - Etymology band: `la:virus` "venom" ← `ine-pro:*wisos` "poison" (periods).
  - Gutenberg body text: about 70 raw hits in 57 files, measured, **but** the licence text ("a computer virus, or computer codes that damage") falls inside the START/END body in at least 5 files. The boilerplate pass removes those. What remains are genuine figurative uses ("hereditary virus", "the virus of to-day's restlessness" in *Babbitt*, "the virus coursing in the soldier's blood"). The poison/contagion sense is therefore observable **before** any computing sense. The clusterer can test that hypothesis if n ≥ 30.
  - Song and film titles: 2 films (1999–2013), measured.
  - The computing sense is **not observable** in full text before 1928 (no texts after 1928). It can only appear through OpenAlex or a user import, and the UI says "no full text after 1928 (copyright); computing sense would need STEMM sources".
- ***viral***: 0 Gutenberg hits. 2 songs and 2 films with *viral* in the title (2013–2018). Without abstracts the bar exists only in title lanes, labeled ‰ works. A Wiktionary claim lane can add an attestation diamond. The UI does **not** draw any link between the medical and the "went viral" sense unless a clustering or lineage method supports one.
- ***bug***, ***hacker***, ***algorithm***: *hacker* and *algorithm* have 0 hits in the 693 books and 0 culture titles, measured. The Jargon File (Gutenberg, LoCC TK) via `stemm.pg-shelf` would be their first full-text source. *algorithm* has an etymon `la:algorismus`. The empty state says exactly that.
- ***gene / genetic***: `ine-pro:*genh₁-` with 30+ modern members. 8 Gutenberg files contain *gene* (135 hits, many will be names such as *Gene*). The name/term ambiguity is a **case for clustering**, not for a silent count. The inspector shows both.
- ***quantum***: 13 files, 31 hits (Latin "quantum" as "amount" in prose and law). OpenAlex physics would add the physics sense from 1900 on.

The rule shown in the term-journey legend: *"Lanes show where a word was observed. A link between lanes appears only when a documented relationship or a computed method connects specific passages. Similarity in spelling is not transmission."*

---

## 11. Test plan (mapped to §12 of the brief)

The runner is `node --test tests/*.test.mjs`. Every test uses `tests/helpers/tmpdb.mjs`, which creates a fresh `SCROLLS_DATA` in the scratch directory, migrates it and seeds the 12-document `tests/fixtures/mini/` corpus. Tests that need Cipher data skip with a message if the files are missing. `npm run test:cipher` runs them against a real bootstrap.

| Acceptance criterion | Tests (file: assertion) |
|---|---|
| **Real uploaded corpus imports and is searchable** | `ingest.csv.test`: `fixtures/import/letters.csv` (40 rows: quoted commas, embedded newlines, BOM, `;` delimiter variant) gives accepted 37 / warnings 2 / rejected 1 exactly, and `/api/search?q=hold%20the%20line` returns doc `L-12` with highlighted span offsets. `ingest.jsonl.test`, `ingest.txt.test` and `ingest.md.test` follow the same pattern. `adapters.gutenberg.test` imports ids 1342, 10007 and 1083 from the real path: search "Bennet" ≥ 1 result. **Canary:** occurrences of *virus* in 1083 = 0 after boilerplate. |
| **Dates and unknown dates behave correctly** | `dategrammar.test`: 70-case table (ISO day/month, "March 1990", "c. 1850", "1850?", "1990s", "19th century", "early 19th century", "3rd century BCE", "500 BC", "1850–1860", "1850/51", "n.d.", "before 1900", "'93" → issue, "2019-02-30" → issue). `time.test`: t ↔ calendar round trip for −4499…2026, BCE label formatting, leap years, `bin_fits`. `aggregate.binning.test`: a decade-precision document is absent from year bins, present in the decade bin and counted in `imprecise.decade`. An undated document appears only in `/timeline/undated`. An R*Tree query with 2019.19726 does not return documents dated 2019.1971 (post-filter). |
| **Every displayed occurrence opens its original passage** | `offsets.property.test`: for 2,000 random occurrences across en, fr, es, hi and gu fixtures (with combining marks, ZWJ, `ſ`, ligatures): `normalize(docOriginal.slice(occ.start, occ.end))` equals a variant's norm, `passage.text === docOriginal.slice(p.start, p.end)`, and the occurrence lies inside its passage. `core.tokenize.parity.test`: JS token offsets equal `fts5vocab` instance offsets on 1,000 passages. `api.marks.test`: every mark id from `/timeline/marks` resolves through `/api/passages/:id` and contains `[start,end)`. |
| **Filters update visualizations and counts consistently** | `aggregate.invariants.test` (property-based over random filter combinations): for each level L ∈ 0..3, Σ lanes Σ bins `occ` + `imprecise(L)` + `undated` = `totals.occ` = `SELECT count(*) FROM occurrence JOIN document … <same filters>`. Rate denominators equal the `/api/coverage` tokens for the same slice. The "other" lane makes the sum complete. `ui.bars.test`: bins → segments gives no segment spanning a zero bin. |
| **Demo material clearly labeled** | `adapters.demo.test`: every document, passage, relationship and annotation from `demo` has `synthetic=1` and authors end with `[synthetic]`. `api.synthetic.test`: every API object derived from demo rows carries `synthetic:true`, including tiles (flag 16), exports (column) and snapshot SVG (contains "SYNTHETIC"). `ui.passage-card.test` (DOM-free render to a string): synthetic gives a pill. |
| **Inferred lineage cannot be mistaken for documented citation** | `provenance.guard.test`: inserting `evidence_status='documented'` with provenance `scrolls.quotes@1` or `user:x` aborts (trigger), and promoting computed → documented aborts. `lineage.quotes.test`: the detector on the demo yields only `computed`/`proposed`, and the 1968 Varga quote is found as `exact_quotation` with both spans plus a `proposed` `explicit_citation` with an `attribution_cue`. `ui.evidence-style.test`: documented and computed have different dash patterns, glyphs and badge text. `provenance.review.test`: confirm sets `human_confirmed`, appends a revision and preserves the original `method` and `provenance`. |
| **Insufficient evidence never yields authoritative drift claims** | `analysis.gates.test`: boundary fixtures at 39/40 occurrences, 7/8 documents and doc-share 0.51. `/api/compare` returns `{status:'insufficient', value:null, reasons:[…]}` at 39 and a value with CI at 40. Displacement is `null` without an aligned space. Spanish slices at 2.95M tokens give `NO_ELIGIBLE_SLICES`. `ui.compare.test`: a gated payload renders "Not enough evidence" and no numeral. |
| **Saved views and annotations survive restart** | `persistence.restart.test`: spawn `server.mjs` on a temp data dir, create an annotation with 3 revisions, a relationship review and a saved view; kill with SIGKILL mid-idle; restart; all are byte-identical through the API. `UPDATE annotation_revision` aborts. After a new import, `GET /api/views/:slug` reports `dataChanged:true`, and "as saved" counts equal the original counts. |
| **Malformed input gives actionable feedback** | `ingest.malformed.test`: Latin-1 file gives `ENCODING_FALLBACK` with byte offset; ragged row 57 gives `ROW_RAGGED` naming the field counts; JSONL syntax error on line 17 with column; empty record gives `EMPTY_RECORD`; unparseable date gives a row kept as undated with a hint; a fatal error during commit leaves **zero** documents from the batch (transaction test). Every issue has `locator`, `code`, `message` and `hint`. |
| **Main flow works on desktop and narrow viewport** | `ui.layout.test` (pure functions): breakpoints → region assignment. WP8 manual verification with the Browser pane at 1440×900 and 375×812: search → timeline → open passage → compare → save → reload, with screenshots in `VERIFICATION.md`. |
| **Expensive analysis does not freeze the UI** | `jobs.responsiveness.test`: start a `vectors` job on a synthetic 3M-token fixture (generated in the test), fire 50 `/api/health` and 20 `/api/timeline/tiles` requests concurrently, and require p95 < 50 ms / < 300 ms. `POST /cancel` gives status `cancelled` within 2 s, no `vector_space` rows for the run, and the `analysis_run` status is `cancelled`. `jobs.restart.test`: a running job at kill becomes `interrupted` on boot. |
| **Explicitly requested test areas** | Ingestion: the rows above. Offsets: `offsets.property.test`. Temporal aggregation: `aggregate.*`. Relationship provenance: `provenance.*`, `adapters.siblings.test` (pair collapse; w/d/m/i → documented; kindred → computed; counterpart → proposed; `-`+tags → proposed). Persistence: `persistence.*`. |
| Oracle | `adapters.culture-lines-oracle.test` (`test:cipher`): ≥ 95% of 1,000 sampled concordance lines are locatable in imported passages. |
| Performance | `scripts/bench.mjs` (`npm run bench`) on the full Cipher DB: tile cold/warm p95, search p95, marks p95, bootstrap duration. Results go into `VERIFICATION.md`. Not part of CI pass/fail. |

---

## 12. Build plan (parallel, conflict-free)

### 12.1 Repository tree (owner in brackets)

```
Scrolls/
├── package.json  server.mjs  .gitignore                                  [WP0]
├── README.md  VERIFICATION.md                                            [WP8]
├── Docs/ brief.md data-inventory.md proposals/ (existing, read-only)
│   ├── api.md                                                            [WP0]  frozen contract (§7) + examples
│   ├── import-schema.md                                                  [WP1]
│   ├── analysis-and-limits.md                                            [WP4]
│   └── handoff.md                                                        [WP8]
├── data/
│   ├── lang-periods.tsv                                                  [WP2]
│   └── demo/ documents.jsonl relationships.jsonl annotations.jsonl tour.json [WP2]
├── scripts/ bootstrap.mjs [WP2] · bench.mjs [WP3] · verify.mjs [WP8]
├── tools/nl-adapter/ main.swift build.sh                                 [WP4]
├── src/
│   ├── shared/ time.mjs vocab.mjs viewstate.mjs format.mjs               [WP0]
│   │           dategrammar.mjs                                           [WP1]
│   ├── core/   normalize.mjs tokenize.mjs segment.mjs langid.mjs locate.mjs hash.mjs stopwords/*.json [WP0]
│   ├── store/  writer.mjs (DocumentWriter) bins.mjs                      [WP0]
│   ├── adapters/ api.mjs                                                 [WP0]
│   │   ├── cipher/ gutenberg.mjs wikisource.mjs culture-works.mjs siblings.mjs roots.mjs themes.mjs tags-provenance.mjs [WP2]
│   │   ├── stemm/  pg-shelf.mjs locc.mjs fields.mjs openalex.mjs wiktionary.mjs ngram.mjs wikidata-dates.mjs [WP2]
│   │   ├── demo/   demo.mjs                                              [WP2]
│   │   └── local/  nl.mjs                                                [WP4]
│   ├── ingest/ sniff.mjs decode.mjs csv.mjs json.mjs txt.mjs md.mjs mapping.mjs validate.mjs dedupe.mjs summary.mjs pipeline.mjs [WP1]
│   ├── aggregate/ query.mjs fts.mjs materialize.mjs tiles.mjs coverage.mjs segments.mjs marks.mjs lanes.mjs rates.mjs cache.mjs [WP3]
│   ├── export/ csv.mjs jsonl.mjs bundle.mjs svg.mjs                      [WP3]
│   ├── analysis/ tokstream.mjs collocations.mjs cooc.mjs ppmi.mjs linalg.mjs rsvd.mjs procrustes.mjs occvec.mjs kmeans.mjs stability.mjs labels.mjs drift.mjs bootstrap.mjs gates.mjs tone.mjs layout.mjs [WP4]
│   ├── lineage/ winnow.mjs minhash.mjs align.mjs trace.mjs classify.mjs graph.mjs hypotheses.mjs [WP5]
│   ├── provenance/ relationships.mjs annotations.mjs views.mjs revisions.mjs [WP5]
│   └── server/
│       ├── app.mjs http.mjs config.mjs security.mjs                      [WP0]
│       ├── db/ schema.sql migrate.mjs connect.mjs readpool.mjs readworker.mjs [WP0]
│       ├── jobs/ queue.mjs worker.mjs context.mjs                        [WP0]
│       ├── jobs/tasks/ _noop.mjs [WP0] · import.mjs [WP1] · bootstrap.mjs adapter-sync.mjs [WP2]
│       │               materialize.mjs coverage.mjs export.mjs [WP3] · tokenize.mjs vectors.mjs cluster.mjs drift.mjs tone.mjs [WP4]
│       │               quotes.mjs boilerplate.mjs [WP5]
│       └── routes/ health.mjs jobs.mjs events.mjs [WP0] · imports.mjs [WP1] · corpora.mjs adapters.mjs tour.mjs [WP2]
│                   search.mjs expressions.mjs timeline.mjs coverage.mjs passages.mjs documents.mjs kwic.mjs exports.mjs [WP3]
│                   analysis.mjs compare.mjs constellation.mjs [WP4] · lineage.mjs trace.mjs relationships.mjs annotations.mjs views.mjs [WP5]
├── public/
│   ├── index.html                                                        [WP0]
│   ├── styles/ tokens.css base.css [WP0] · shell.css timeline.css [WP6] · panels.css [WP7] · import.css [WP1]
│   └── js/ main.mjs registry.mjs [WP0]
│       ├── core/ store.mjs api.mjs sse.mjs dom.mjs keys.mjs evidence-style.mjs [WP0] · tilecache.mjs [WP6]
│       ├── shell/ layout.mjs searchbar.mjs filters.mjs help.mjs synthetic-ribbon.mjs [WP6]
│       ├── timeline/ (all files listed in §8.1)                          [WP6]
│       ├── tour/ tour.mjs                                                [WP6]
│       ├── panels/ (all files listed in §8.1) layout.worker.mjs          [WP7]
│       └── import/ wizard.mjs mapping-table.mjs summary.mjs              [WP1]
└── tests/
    ├── helpers/ tmpdb.mjs server.mjs shape.mjs  contract/*.json  fixtures/mini/*  [WP0]
    ├── shared.time.test.mjs core.*.test.mjs store.writer.test.mjs jobs.*.test.mjs db.schema.test.mjs [WP0]
    ├── fixtures/import/*  ingest.*.test.mjs dategrammar.test.mjs        [WP1]
    ├── adapters.*.test.mjs                                               [WP2]
    ├── aggregate.*.test.mjs api.marks.test.mjs api.synthetic.test.mjs export.*.test.mjs offsets.property.test.mjs [WP3]
    ├── analysis.*.test.mjs                                               [WP4]
    ├── lineage.*.test.mjs provenance.*.test.mjs persistence.*.test.mjs   [WP5]
    ├── ui.timeline.*.test.mjs ui.bars.test.mjs ui.layout.test.mjs        [WP6]
    ├── ui.panels.*.test.mjs ui.compare.test.mjs ui.evidence-style.test.mjs ui.passage-card.test.mjs [WP7]
    └── e2e.journey.test.mjs acceptance.*.test.mjs                        [WP8]
```

**Mechanisms that keep ownership disjoint:**
- `app.mjs` **auto-registers** every `src/server/routes/*.mjs`. Each exports `routes = [{method, path, heavy, handler}]`.
- `worker.mjs` dynamically imports `jobs/tasks/<type>.mjs` for types listed in `vocab.JOB_TYPES`.
- `public/js/registry.mjs` (WP0) statically imports every frontend module path in the tree. **WP0 creates a stub for every file in the tree** with its exported signatures (`export function mount(el, store) {}` and so on). After WP0, ownership of each stub transfers to its package.
- Keyboard bindings register at runtime through `keys.register(scope, map)`. Styles are separate files linked from `index.html`, which WP0 writes with all `<link>` tags up front.

### 12.2 Shared contracts (frozen at the end of WP0; changes are additive only, by the WP0 owner)

1. `schema.sql`, including every table above.
2. `vocab.mjs`: precision, basis, roles, evidence statuses, relationship types and families, lane dimensions, stemm fields, job types, error codes.
3. `time.mjs`: levels, bins, tiles, formatting.
4. `viewstate.mjs`.
5. `Docs/api.md` plus `tests/contract/*.json`. These are canned example responses for **every** endpoint. `SCROLLS_MOCK=1` makes `app.mjs` serve them, so WP6 and WP7 can build against them on day one, and `shape.mjs` validates real responses against them in tests.
6. `adapters/api.mjs` and the `DocumentWriter` API (`begin(batch)`, `addDocument(input)`, `addRelationship`, `addAnnotation`, `addExpression`, `commit()`, `rollback()`).
7. The job task interface: `export const type, writes; export async function run(ctx, params)`, where `ctx = {db, dataDir, progress, checkpoint, runStart(stage, method, params, scope) → runId, log}`.
8. `evidence-style.mjs` and `tokens.css`.
9. The offsets contract (§3).

### 12.3 Work packages

| WP | Agent | Depends on | Delivers (P1 = vertical slice first, P2 after) | Done when |
|---|---|---|---|---|
| **WP0 Foundation** | A | none | P1: everything marked [WP0]: server, security, DB and migrations, read pool, job queue with cancel and SSE, the text core (normalize, tokenize, segment, langid, locate), DocumentWriter, the time and vocab contracts, the frontend shell (store, URL, api, keys, evidence-style, tokens), stubs, the mock server, the mini fixture corpus, contract JSON, Docs/api.md | `npm test` green for the WP0 tests; `SCROLLS_MOCK=1 npm start` serves every endpoint; the mini corpus imports through DocumentWriter with the offset invariants |
| **WP1 Ingestion** | B | WP0 | P1: CSV/TSV/JSON/JSONL/TXT/MD parsers, decode, date grammar, mapping and suggestions, validation, dedupe, the imports routes and job, the wizard UI. P2: line mode, revert | the ingest and dategrammar tests pass; a 50 MB CSV dry-run takes ≤ 10 s |
| **WP2 Sources & demo** | C | WP0 (writer), WP1 (dategrammar, imported directly) | P1: the demo corpus (all of §9) + adapter, the Cipher gutenberg, wikisource and culture-works adapters, `npm run bootstrap` (enqueues the boilerplate job and then the coverage job by type name), the tour route. P2: roots and themes, the STEMM adapters (pg-shelf local part first; network adapters behind approval) | demo and siblings tests pass; a full bootstrap finishes in ≤ 15 min with counts printed (documents, passages, tokens per collection, undated, estimated-date share) |
| **WP3 Search & aggregation** | D | WP0 | P1: FTS query building, materialize (sync and job), expr_doc, tiles, segments, marks, coverage, undated, passages and documents, KWIC, the cache tiers. P2: data exports + SVG, bench | the aggregate invariants and offsets property tests pass; bench targets (§8.3) on the full DB |
| **WP4 Analysis** | E | WP0, WP3 (occurrences schema only) | P1: collocations, the compare endpoint (frequency, CI, composition, rebalance, gates). P2: token streams, PPMI/rSVD, Procrustes, occurrence vectors, clustering, links, drift, constellation layout and route, the NL adapter, Docs/analysis-and-limits.md | the gates boundary tests pass; clustering on the demo recovers 4 *flux up* clusters with stability ≥ 0.6; an en vectors run completes and cancels cleanly |
| **WP5 Lineage & provenance** | F | WP0 | P1: annotations with revisions, saved views (snapshot, as-saved), relationships review. P2: winnowing, boilerplate job, seeded trace, quotes job, the lineage graph with groups, MinHash | the provenance, persistence and lineage tests pass; on the demo, all designed quotation links are found and nothing is marked documented by the detector |
| **WP6 Timeline UI** | G | WP0 (mock server) | P1: canvas timeline (scale, LOD, tiles client, bars, coverage, imprecise rows, undated shelf, marks, hit-test, playhead and play, keyboard, gestures, a11y table, legend), the shell (search, filters, layout, synthetic ribbon). P2: arcs and bundling, branches, deep-time periods and fold, PNG snapshot, the tour | the UI pure-function tests pass; the perf HUD shows ≤ 8 ms p95 with 20k marks on a synthetic tile set |
| **WP7 Panels UI** | H | WP0 (mock server) | P1: passage card, Then/Now/Next inspector, compare view, views menu, jobs tray. P2: the lineage explorer, constellation, notebook, annotation editor and revision stack, review actions | the UI panel tests pass; every panel renders all contract fixtures, including gated and empty states |
| **WP8 Integration** | A (again) | all | E2E journey test, acceptance tests, browser verification at desktop and narrow widths, README (setup, import schema link, what works / needs an optional model / is unfinished), handoff.md, VERIFICATION.md | every §11 row is green or explicitly listed as manual with screenshots |

**Order:**
- **Phase 0:** WP0 alone. It is the critical path, about 2,800 LOC.
- **Phase 1:** WP1–WP7 in parallel. Each finishes its P1 slice first, so the brief's vertical slice (import → search → timeline → evidence → compare → save view) is integrable midway. Then P2 runs in the brief's order: lineage (WP5), clustering (WP4), constellation (WP4/WP7), notebook (WP5/WP7), advanced analysis (WP4).
- **Phase 2:** WP8. In this phase file ownership lapses, so the integrator may patch any file, and records each such patch in VERIFICATION.md.

**Coordination rules:** no package edits another package's files. A contract gap is reported to Agent A, who adds it to the contract (additively) and to the mock fixtures. Packages communicate only through the DB schema, HTTP contracts, job types and the shared modules.

### 12.4 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Synchronous SQLite blocks HTTP | heavy routes run in the read pool; writes are chunked into 5k-row transactions; one writer lock |
| FTS index build time or size | contentless FTS; bulk insert inside a transaction with `automerge` off, then `INSERT INTO passage_fts(passage_fts) VALUES('optimize')` |
| Phrase counts on huge expressions | stratified sampling, flagged `sampled`; exact counts for single tokens via vocab |
| JS linear algebra too slow | rank 128, 30k vocab cap, SharedArrayBuffer row-block parallelism; the vectors job is optional, and P1 features never depend on it |
| Date quality in Cipher (estimated/unverified) | basis flags, the "exclude estimated" filter, the opt-in Wikidata refresh |
| Gutenberg boilerplate polluting counts | marker stripping + regexes + the cross-document winnowing pass + the *virus* canary test |

---

## Appendix A. Ambiguities resolved

- **"4D":** X time, Y lane, Z rate, T vantage (§1.1). This is the only reading that adds explanatory power without inventing a meaning axis.
- **Infinite scroll:** bounded to [−10000, 2100], with the scale changes labeled. Truly unbounded time only adds empty space.
- **Song "occurrences":** title and summary matches in metadata, counted per 1,000 works. Lyrics do not exist in the corpus.
- **Kindred and counterpart:** kept as similarity edges, hidden from lineage by default, because neither is transmission.
- **culture-lines.tsv:** a test oracle, not evidence, because it is derived from texts that are already imported.
- **Sense clusters:** global per expression, tracked across windows, because global clusters keep lanes comparable through time while windowed clusters fragment.
- **Saved views are immutable:** "edit" creates `slug~2`, because a shared link must never change under the reader.
- **Port 3460, loopback only:** avoids the user's spectra-lab port (3002).
