<!-- OWNER: engine architect (iOS design panel, 2026-10-09). Input to Docs/IOS-SPEC.md; SPEC.md stays the law for semantics (§1, §3, §4, §13). -->
# Scrolls for iPhone — the engine-port-first proposal

**Angle.** A senior Swift systems engineer's plan. The aim is to port a 40k-line Node engine to Swift without losing one honesty guarantee, and to keep an app that works at every milestone. The web build is the **reference implementation**: every Swift module that has a Node twin is accepted only when its output equals the twin's, exactly or within a tolerance this document names. Where this document says *measured*, the number was taken on this Mac (M1 Max, macOS 27.2, Swift 6.4, system SQLite 3.54.0, Node 26.10.0 / ICU 78.3 / Unicode 17). The machine ran at load average ~850 from other sessions, so timings are **CPU time of the measuring thread**, not wall time. Everything else is an estimate and says so.

---

## 0. Decisions in one page

| # | Decision | Why |
|---|---|---|
| E1 | One SwiftPM package, `ScrollsKit`, with 13 library targets plus a Mac CLI (`scrolls-cli`). It uses Foundation, Accelerate, Compression, CryptoKit, NaturalLanguage and system SQLite3 only. The app target holds UI only. | The same engine runs on the phone, in `swift test` on the Mac, and as the Mac atlas builder. |
| E2 | The schema DDL is **byte-identical** (`schema.sql` copied verbatim, checksum-tested). The device adds a small **device profile** (`device-profile.sql`) and never changes a v1 column's meaning. | Swift can open the reference's own databases. Read-path ports are then tested against the m1/m5-stemm snapshots from day 1, before any Swift ingest exists. |
| E3 | Routes become `AtlasService`, an in-process async API whose request and response types are Codable mirrors of contract 1.3.0. All 65 `tests/contract/*.json` fixtures decode and re-encode **identically** in a Swift test. | The contract is the seam that the honesty rules were designed into (gate objects, provenance blocks, `synthetic` flags). |
| E4 | Concurrency: a `Writer` actor (one RW connection), a `ReadPool` of 2 read-only connections on **dedicated serial executors** (blocking SQLite never runs on the cooperative pool), a `JobQueue` actor with job dependencies, and TaskGroups for compute. Cancellation uses Task cancellation, `sqlite3_interrupt` and a progress-handler deadline. | This maps the reference's D11 (one writer, read pool, cancel flags) onto Swift 6 strict concurrency. It also fixes HANDOFF's open item "analysis jobs take the writer slot". |
| E5 | Text on the device is stored as **passage-aligned 16k-unit chunks, LZFSE-compressed UTF-8**, behind a `TextStore` protocol. The reference's inline `document_text.original` is the other implementation of that protocol. | 917 MB → ≈ 420 MB (measured 2.24× at this chunk size). Counting a word decodes only the chunks that hold its candidate passages, which fixes HANDOFF's "counting reads whole books". |
| E6 | **Atlas layers with deterministic row ids.** Entity rows get ids from per-layer ranges (`L × 10⁸`). Rows the user creates on the device get ids from a local range (≥ 1.5 × 10⁹). Log-ordered rows (`import_batch`, `analysis_run`, `*_revision`) are numbered in commit order and **renumbered when a pack is applied**. | A pack built on the Mac can merge into a phone that already holds annotations and saved views, and D17's id-ordered as-saved cutoffs stay true. |
| E7 | The full corpus is built **on the Mac by the same Swift engine** (`scrolls-cli atlas build`). It moves to the phone as one `.scrollsatlas` file over Finder/USB-C, AirDrop or Files. The phone applies it in 3–5 min (estimate) with `BGContinuedProcessingTask`. The phone can also build any layer from a `.scrollssource` pack with the same code. | This is the most reliable path for 146M tokens on a phone with 6 cores, thermal limits and jetsam, and it can be verified (layer hashes). |
| E8 | First launch: the bundled demo layer (L0, ≈ 4 MB) opens in < 1 s. **Cipher's metadata layer (L1) is then built on the phone** from ≈ 9 MB of bundled LZFSE sources in ≈ 20–45 s (estimate). This is D10 done by the ported engine itself. | His data appears in the first minute, and the engine proves itself on the device on day 1. |
| E9 | User state stays in the **same SQLite database** (append-only triggers, revision ids, cutoffs), not SwiftData. Every user write also appends to an in-database `user_journal` within the same transaction. The journal is exported to a small backed-up file. | D17/D18 need relational joins, triggers and one transaction. The atlas file (≈ 2.85 GB) is excluded from backup, but the user's work is not. |
| E10 | Unicode and number parity is designed, not hoped for: a generated token-class table, Foundation fold (Final_Sigma), `NSString` sentence breaks, an ECMAScript number formatter for canonical JSON, and ports of `mulberry32`/FNV-1a. | Each one was measured; see §1.8. |
| E11 | The Scroll renders with **Metal instanced primitives** fed by a pure-Swift port of `model.mjs`/`display.mjs`, which is checked against the JS display lists. A CoreGraphics painter draws the same display list for PNG/SVG snapshots. | 20k bin cells + 4k marks + 300 arcs at 120 Hz; the snapshot equals the screen by construction. |
| E12 | Golden fixtures come from the Node reference in six tiers: pure functions, pipeline logical dumps, read-path responses on snapshot clones, analysis with tolerances, display lists, and device = Mac. One script, `Native/Tools/check.sh`, runs them. | Differential testing replaces most re-derivation of expected values. |

---

## 1. Architecture

### 1.1 Folder layout (inside the existing repo; the web build stays where it is)

```
Scrolls/                                  iCloud folder, git (gitdir ~/Developer/git/Scrolls.git)
├─ server/ src/ public/ tests/ data/ …    the Node REFERENCE — unchanged except bug fixes found by diff tests
├─ Docs/ SPEC.md IOS-SPEC.md …            SPEC stays law; IOS-SPEC is the delta
└─ Native/
   ├─ project.yml                         XcodeGen: app + UI-test targets (iOS 27, iPhone only)
   ├─ Tools/
   │   ├─ build.sh                        mirrors Native/ + ../../LabKit to $TMPDIR/ScrollsBuild/src/{Scrolls/Native,LabKit}; sim|device|install|test|cli
   │   ├─ check.sh                        the CI-like gate (§2.5)
   │   ├─ golden.sh                       runs Native/Golden/*.mjs with the DYLD workaround; writes ~/Developer/scrolls-golden/<ref>/
   │   └─ atlas.sh                        scrolls-cli atlas build → ~/Developer/scrolls-atlas/<date>/Scrolls-<engine>.scrollsatlas
   ├─ Golden/                             Node generators that import ../../server and ../../src/shared (read-only use)
   │   ├─ dump-spec.json                  the LogicalDump specification, read by BOTH dumpers
   │   ├─ dump.mjs  gen-core.mjs  gen-pipeline.mjs  gen-read.mjs  gen-analysis.mjs  gen-display.mjs  slices.mjs
   │   └─ requests/*.json                 the read-path request corpus (≈ 400 requests)
   ├─ ScrollsKit/                         the engine (SwiftPM, tools 6.4, iOS 27 + macOS 27)
   │   ├─ Package.swift
   │   ├─ Sources/
   │   │   ├─ ScrollsCore/                dates, tokenizer, fold, ids, vocab, viewstate, format, evidence style (pure, no SQLite)
   │   │   ├─ ScrollsContracts/           Codable request/response value types, Canonical* inputs, ScrollsError, Gated<T>
   │   │   ├─ ScrollsStore/               SQLite C-API layer, schema resources, migrations, ReadPool, Writer, TextStore, RowIDPolicy, layers
   │   │   ├─ ScrollsJobs/                JobQueue, JobContext, runs (analysis_run), BoundedChannel, task registry
   │   │   ├─ ScrollsIngest/              DocumentWriter, segmenter, langid, formats, mapping, validate, dedupe, import/revert tasks
   │   │   ├─ ScrollsSources/             adapters: cipher/*, stemm/*, demo; bootstrap & adapter-load tasks; Resources/demo
   │   │   ├─ ScrollsQuery/               search, expressions, materialize, cube, tiles/washes/marks/arcs/shelves/bin, KWIC, exports
   │   │   ├─ ScrollsAnalysis/            stats, collocations, compare, tokstream, cooc, PPMI, rSVD, Procrustes, k-means, drift, layout
   │   │   ├─ ScrollsLineage/             winnow, minhash, boilerplate, near quotes, cues, trace, graph, genealogy, path
   │   │   ├─ ScrollsProvenance/          relationships, reviews, annotations, anchors, views, user journal
   │   │   ├─ ScrollsNL/                  NaturalLanguage tone + modern-reader neighbours (optional, labelled)
   │   │   ├─ ScrollsService/             AtlasService protocol, LiveAtlas (+ one extension file per area), MockAtlas
   │   │   ├─ ScrollsScrollModel/         pure port of src/ui/timeline/{scale,tiers,folded,model,display,hit,arcs,…}: display list
   │   │   └─ scrolls-cli/                macOS executable: atlas build|verify|apply, dump, diff-read, bench, starter
   │   └─ Tests/                          one test target per library + DifferentialTests (reads goldens)
   └─ Scrolls/                            the app target (SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor)
       ├─ App/  Design/  Render/  Features/{Scroll,Inspector,Search,Compare,Lineage,Constellation,Notebook,Views,Import,Sources,Jobs,Tour,Settings,Diagnostics}/
       └─ Resources/Starter/              starter.sqlite.lzfse (L0), cipher-meta.scrollssource (L1 inputs), baseline/ (optional)
```

The runtime data never lives in iCloud. The CLI keeps the reference's `E_DB_IN_ICLOUD` refusal. Atlas builds write to `~/Developer/scrolls-atlas/`, and goldens go to `~/Developer/scrolls-golden/`. `Native/Tools/build.sh` follows Rheo's pattern: it mirrors `AI Stuff/LabKit` and `AI Stuff/Scrolls/Native` side by side under `$TMPDIR/ScrollsBuild/src/` (an override `SCROLLS_BUILD_DIR` lets each parallel agent use its own directory), so `project.yml`'s `LabKit: { path: ../../LabKit }` resolves in the mirror. `xcodebuild` never runs inside `~/Documents`.

### 1.2 Package and isolation rules

```swift
// swift-tools-version: 6.4          (LabKit needs 6.4 for .iOS(.v27)/.macOS(.v27); the engine matches it)
let engineFlags: [SwiftSetting] = [
  .unsafeFlags(["-Xcc", "-DACCELERATE_NEW_LAPACK"]),
  .unsafeFlags(["-O"], .when(configuration: .debug)),   // Loom's rule: the engine is arithmetic; -Onone is ~20× slower
  .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
]
let package = Package(name: "ScrollsKit", platforms: [.iOS(.v27), .macOS(.v27)],
  products: [ .library(name: "ScrollsService", targets: ["ScrollsService"]),
              .library(name: "ScrollsScrollModel", targets: ["ScrollsScrollModel"]),
              .library(name: "ScrollsCore", targets: ["ScrollsCore"]),
              .library(name: "ScrollsContracts", targets: ["ScrollsContracts"]),
              .executable(name: "scrolls-cli", targets: ["scrolls-cli"]) ],
  targets: [
    .target(name: "ScrollsCore", resources: [.copy("Resources")], swiftSettings: engineFlags),          // vocab.json, token-class table
    .target(name: "ScrollsContracts", dependencies: ["ScrollsCore"], swiftSettings: engineFlags),
    .target(name: "ScrollsStore", dependencies: ["ScrollsCore", "ScrollsContracts"],
            resources: [.copy("Resources/schema.sql"), .copy("Resources/device-profile.sql")], swiftSettings: engineFlags),
    .target(name: "ScrollsJobs", dependencies: ["ScrollsStore"], swiftSettings: engineFlags),
    .target(name: "ScrollsIngest", dependencies: ["ScrollsJobs"], resources: [.copy("Resources/stopwords")], swiftSettings: engineFlags),
    .target(name: "ScrollsSources", dependencies: ["ScrollsIngest"], resources: [.copy("Resources/demo"), .copy("Resources/field-taxonomy.json")], swiftSettings: engineFlags),
    .target(name: "ScrollsQuery", dependencies: ["ScrollsJobs"], swiftSettings: engineFlags),
    .target(name: "ScrollsAnalysis", dependencies: ["ScrollsQuery"], swiftSettings: engineFlags),
    .target(name: "ScrollsLineage", dependencies: ["ScrollsAnalysis"], swiftSettings: engineFlags),   // uses tokstream
    .target(name: "ScrollsProvenance", dependencies: ["ScrollsQuery"], swiftSettings: engineFlags),
    .target(name: "ScrollsNL", dependencies: ["ScrollsAnalysis"], swiftSettings: engineFlags),
    .target(name: "ScrollsService", dependencies: ["ScrollsSources", "ScrollsQuery", "ScrollsAnalysis", "ScrollsLineage",
                                                   "ScrollsProvenance", "ScrollsNL"], swiftSettings: engineFlags),
    .target(name: "ScrollsScrollModel", dependencies: ["ScrollsCore", "ScrollsContracts"], swiftSettings: engineFlags),
    .executableTarget(name: "scrolls-cli", dependencies: ["ScrollsService"], swiftSettings: engineFlags),
    // test targets: one per library + "DifferentialTests" (deps: everything) with resources: [.copy("Golden")]
  ], swiftLanguageModes: [.v6])
```

**Isolation rules** (they hold in review and in a test):
1. The engine targets have **no default isolation**. Data types are `Sendable` structs and enums. `Connection`, `Statement` and the writers are non-Sendable classes that stay confined to one actor.
2. With `NonisolatedNonsendingByDefault`, a plain `nonisolated async` function runs on its **caller's** actor. A heavy engine function called from a `@MainActor` view model would then run on the main thread. So every public async engine entry point is **actor-isolated** (`ReadPool`, `Writer`, `JobQueue`, `LiveAtlas`) or marked **`@concurrent`**. In Debug, `EngineAssert.offMain()` (`precondition(!Thread.isMainThread)`) sits at the top of every kernel: materialize, tiles, compare, k-means, rSVD, winnow. A UI test drives the main journey with it enabled.
3. The app target uses `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor` (his convention). It touches the engine only through `AtlasService` and the value types of `ScrollsContracts`/`ScrollsScrollModel`.

### 1.3 Port map (module by module)

Status codes: **P** = ported 1:1 (same algorithm, same constants, differential-tested); **R** = re-designed (same contract, new mechanism); **D** = dropped (no phone equivalent needed); **N** = new; **M** = Mac-only (CLI). LOC = reference lines.

**Shared (`src/shared`, 3.2k) → `ScrollsCore` / `ScrollsContracts`**

| Reference | Swift | St | Notes |
|---|---|---|---|
| `tokenize.mjs` (128) | `Core/Text/Tokenizer.swift`, `TokenClassTable.swift` (generated), `Fold.swift`, `TokenInterner.swift` | P | Works on `UnsafeBufferPointer<UInt16>` with UTF-16 offsets (D4). The class table is generated from Node (§1.8). `findSequence`, `ftsPhrase` and `isSentenceInitial` are verbatim. |
| `dates.mjs` (729) | `Core/Dates/{DayMath,DateGrammar,Bins,Labels}.swift` | P | `dayFromYMD` uses days-from-civil with JS `setUTCFullYear` rollover semantics. The grammar keeps the same rule ids and messages. |
| `vocab.mjs` (456) | `Core/Vocab.swift` + `Resources/vocab.json` (emitted by Node) | P | Closed enums with raw values. Issue templates and UI copy are byte-equal. |
| `ids.mjs` (193) | `Core/IDs.swift`, `CanonicalJSON.swift`, `JSNumber.swift` | P | `canonicalJson`, `shortHash`, slug, `fnv1a32`, `mulberry32`. |
| `viewstate.mjs` (611) | `Core/ViewState.swift` | P | URL grammar v1, `decode(encode(s)) == canonicalize(s)`. |
| `format.mjs` (143), `evidence-style.mjs` (141) | `Core/Format.swift`, `Core/EvidenceStyle.swift` | P | The only evidence → style mapping on the phone too. |
| `contracts.mjs` (818) | `Contracts/*.swift` (≈ 70 types), `Canonical{Document,Relationship,Annotation}.swift`, `Gated.swift` | R | Codable mirrors of API 1.3.0 (§1.7). |

**Store, jobs, transport (`server/db`, `server/jobs`, `server/http`, `server/config`; 6.6k)**

| Reference | Swift | St | Notes |
|---|---|---|---|
| `db/schema.sql` | `Store/Resources/schema.sql` | P | Verbatim. A test compares its sha256 with the reference file. |
| — | `Store/Resources/device-profile.sql`, `Store/Profile.swift` | N | §3.2 |
| `db/open.mjs` (295) | `Store/{Connection,Statement,Row,SQLValue,Transaction,Pragmas}.swift` | R | C API, statement cache, interrupt and deadline (§1.5). |
| `db/readpool.mjs`, `readworker.mjs` | `Store/ReadPool.swift`, `ReadConnection.swift` | R | Actors on dedicated serial executors. |
| `db/migrate.mjs` (154), `seed-vocab.mjs` | `Store/Migrations.swift`, `SeedVocab.swift` | P | Idempotent repairs are kept. Profile migration is new. |
| `db/integrity.mjs` | `Store/Integrity.swift` | R | Checks originals as "on device" versus "held on the Mac (atlas build)", and runs `quick_check`. |
| `config.mjs` (201) | `Store/Paths.swift` | R | App container paths; the CLI keeps the iCloud guard. |
| `jobs/queue.mjs` (570), `worker.mjs`, `job-rows.mjs` | `Jobs/JobQueue.swift`, `JobRows.swift` | R | Actor; adds `after:` dependencies (HANDOFF next step). |
| `jobs/context.mjs` (227) | `Jobs/JobContext.swift`, `Runs.swift` | R | Same `startRun`/`finishRun`/`inputFingerprint`/reuse semantics. `code_hash` = engine build hash per stage. |
| `jobs/tasks/*.mjs` (19) | `<Module>/Tasks/<Name>Task.swift` | P | Same job types and priorities as `vocab.JOB_TYPES`. Analysis tasks become `writes: false` and commit through short writer transactions guarded by `E_INPUTS_CHANGED`. |
| `http/{app,router,security,static,sse,etag}.mjs` | — | D | No server. SSE becomes `AsyncStream<AtlasEvent>`; ETag becomes the memo key `dataVersion`. |
| `http/errors.mjs` | `Contracts/ScrollsError.swift` | R | Same codes (`QUERY_TIMEOUT`, `E_*`) with message and hint. |
| `http/mock.mjs` | `Service/MockAtlas.swift` | R | Serves the decoded contract fixtures; UI agents build against it from day 1. |
| `routes/*.mjs` (28 files, 3.2k) | `Service/LiveAtlas+<Area>.swift` (one per route file) | R | Query-string parsing becomes request structs. Validation and gate logic stay. |

**Ingest and writer (`server/store`, `server/text`, `server/ingest`; 6.8k)**

| Reference | Swift | St | Notes |
|---|---|---|---|
| `store/document-writer.mjs` (1,214) | `Ingest/Writer/{DocumentWriter,FTSWriter,TextChunker,DateWriter,TagWriter,RelationshipWriter}.swift` | P+R | Same rows and checks. Ids come from `RowIDAllocator` (§3.3) and text from the `TextStoreWriter` (chunks). Commits every 5,000 documents or 50,000 rows. |
| `store/bins.mjs`, `dup-index.mjs` (372) | `Ingest/Writer/{Bins,DupIndex}.swift` | P | The dup index cache becomes a binary file in Caches. |
| `text/segment.mjs` (327) | `Ingest/Text/Segmenter.swift` | P | `seg-1`. Sentences come from `NSString.enumerateSubstrings(.bySentences)` enclosing ranges, which equal `Intl.Segmenter` (§1.8). |
| `text/langid.mjs` (171) + `stopwords/*.json` | `Ingest/Text/LangID.swift` + resources | P | |
| `ingest/{sniff,decode,csv,json,jsonl,txt,md,frontmatter}` | `Ingest/Formats/*.swift` | P | Streams through `FileHandle` in 1 MB reads. The JSON > 100 MB streaming parser is hand-written (no third-party code). Windows-1252 table is ported. |
| `ingest/{mapping,suggest,validate,dedupe,summary,pipeline}` (2.3k) | `Ingest/Mapping/*.swift`, `Ingest/ImportPipeline.swift` | P | The dry run runs as a read-only job with progress. |

**Sources (`server/adapters`, 3.5k) → `ScrollsSources`** — every adapter is **P**: `Cipher/{Books,GutenbergText,Wikisource,Works,Siblings,TagsProvenance,Relations,Roots,Themes,Source}.swift`, `STEMM/{GutenbergSTEMM,OpenAlex,Wiktionary,Ngram,FieldMap,Translation}.swift`, `Demo/DemoAdapter.swift`, with `SourceAdapter.swift` and `SourceRegistry.swift` (P, §1.7). The Ngram baseline stays a read-only SQLite file, `ATTACH`ed read-only (as "read in place" does now). `tools/fetch/*.mjs` stays Node on the Mac (D13 unchanged).

**Query (`server/aggregate`, `server/text/{variants,translit,names,kwic}`, `server/export`; 7.5k) → `ScrollsQuery`**

| Reference | Swift | St | Notes |
|---|---|---|---|
| `fts.mjs`, `materialize.mjs` (821), `exprdoc.mjs` | `Query/Match/{FTS,Materialize,ExprDoc,VeryFrequent}.swift` | P | Reads candidate passages through `TextStore` chunks, not whole books. |
| `cube.mjs` (813) | `Query/Slice/{SliceCube,CubeCodec}.swift` | P | Columnar `ContiguousArray`s (`Int32` doc ids: **all row ids stay < 2³¹**). Cached in `Caches/` by its inputs key. |
| `query.mjs` (984) | `Query/Timeline/{QueryDef,CanonicalRequest,SliceSQL,TrailLanes,ClusterLanes}.swift` | P | Split as HANDOFF suggests. `QUERY_VERSION` 2 is kept. |
| `tiles,washes,marks,arcs,arc summaries,shelf,bin,coverage,lanes,rates,stats,seams,scope,trail,tagindex,collstats,clusterlanes` | `Query/Timeline/*.swift`, `Query/Stats/*.swift` | P | Conservation law test at every tier. |
| `cache.mjs` (260), `warm.mjs` | `Query/Cache/{Memo,ArtifactCache}.swift`, `WarmTask.swift` | R | In-memory LRU keyed by `dataVersion` plus purgeable files. The `tile_cache` table is not used on the phone. |
| `text/{variants,translit,names,kwic}.mjs` (965) | `Query/Text/*.swift` | P | Guard hash = engine hash of these files (`MATCHING_CODE_FILES` analogue). |
| `export/{manifest,csv,jsonl}.mjs` | `Query/Export/*.swift` | P | Respects `export_text_allowed`. |
| `export/bundle-html.mjs` | — | D (v1) | §7 cut. PNG/SVG snapshots stay (N6). |

**Analysis (`server/analysis`, 8.6k) → `ScrollsAnalysis`** — **P** for `stats/intervals/bootstrap/gates/compare/composition/multiplicity/collocations/keyness/labels/transitions/convergence/drift/occvec/tfidf-hash/kmeans/stability/slices/ppmi/baseline-rho/layout/commit`. **R** for `linalg.mjs`/`rsvd.mjs`/`procrustes.mjs`: Householder QR becomes LAPACK `sgeqrf`/`sorgqr`, one-sided Jacobi becomes `sgesdd`, dense products become `cblas_sgemm`, and the sparse × dense product becomes a hand-written CSR kernel over TaskGroup row blocks. Also **R** for `cooc.mjs` (8 worker shards become 8 TaskGroup shards with the same open-addressing layout `targetId mod 8`, 2²³ slots) and `kmeans-pool.mjs` (TaskGroup). `tone.mjs` + `tools/nl-adapter` become `ScrollsNL` (**R**: in-process `NLTagger`/`NLEmbedding`, labelled "modern reader model (Apple NLEmbedding en rev 1)").

**Lineage and provenance (`server/lineage`, `server/provenance`; 5.1k)** — **P**: `Lineage/{Winnow,MinHash,Boilerplate,Exact,Near,Align,Cues,CueLinks,Classify,Commonplace,Carry,Filters,Corpus,Trace,Graph,Genealogy,Path,Hypotheses}.swift` and `Provenance/{Relationships,Reviews,Annotations,Anchors,Views}.swift`. **N**: `Provenance/UserJournal.swift`. The global `reuse-index` task is **M** in v1 (it runs in the atlas build); the targeted trace ships on the phone.

**UI (`src/ui`, 20.5k)** — the **pure** timeline modules are **P** into `ScrollsScrollModel` and differential-tested: `scale` (152), `tiers` (227), `folded` (120), `model` (513), `display` (478), `hit` (142), `arcs` (349), `arc-summary` (184), `clusters` (259), `deeptime` (405), `share-cells` (223), `coverage`, `seams`, `shelves` model, `a11y-table` (data part), `svg` (198), the state half of `viewport` (≈ 700 of 1,688) and the `tiles-client` policy (LRU 512, prefetch ±1 viewport). Everything DOM — `core/*`, `shell/*`, `panels/*`, `import/*`, `tour/*`, `paint`, `input`, `gestures`, `minimap`, `legend`, `drawer`, `perf` — is **R** in SwiftUI or Metal (§4).

**Sizing (estimate).** Engine ≈ 31k Swift lines (store/jobs 3k, core/contracts 5k, ingest 5k, sources 3.2k, query 6.5k, analysis 6.5k, lineage/provenance 4.5k, model 4k). App ≈ 14k. Tests ≈ 12k plus generated goldens. The 24k lines of Node tests stay the reference's tests. Most Swift expectations come from goldens instead of being re-derived.

### 1.4 What stays identical, what changes

| Stays identical (tested byte- or value-equal) | Changes on the phone (same semantics) |
|---|---|
| Schema v1 DDL and every CHECK and trigger (I3 immutability, append-only revisions, gated values are NULL) | Transport (HTTP → in-process), SSE → `AsyncStream`, ETag → `dataVersion` memo keys |
| Tokenizer `u61m-1`, fold, FTS tokenizer string, `normString`, offsets in UTF-16 units | Text storage (passage-aligned LZFSE chunks); `document_text.original` is empty in the device profile |
| Segmenter `seg-1`, langid, date grammar, bins and fit-or-wash, conservation law | Row id allocation (layer ranges, local range, log renumbering on apply) |
| `vocab` (closed lists, issue codes, UI copy), `viewstate` URL grammar v1, evidence style | Read pool 3 → 2 connections; 5 s query deadline through a progress handler, not worker termination |
| Algorithms and constants of SPEC §4 (gates, windows, k, seeds, thresholds, BH-FDR, Garwood, Wilson, Procrustes) | Linear algebra on Accelerate/LAPACK (tolerance-tested, §2.4); co-occurrence and k-means on TaskGroups |
| Contract 1.3.0 shapes, gate objects, provenance blocks | Analysis jobs become read-only with a guarded commit; jobs gain `after:` dependencies |
| Demo world data (`data/demo/*.jsonl` copied; the generator stays Node) | Originals of atlas layers stay on the Mac (`original_file.rel_path = 'atlas:<pack>/…'`); user imports keep theirs on the phone |
| Honesty rules §13 | `relationship_revision` "create" rows of adapter and algorithm relationships stored compactly (§3.2) |

### 1.5 SQLite layer (system SQLite3 C API)

What was measured on the phone SDK and on macOS 27: SQLite **3.54.0** in both the iOS 27 SDK header and the macOS library. `THREADSAFE=2` (multi-thread: a connection must not be used by two threads at once, which is exactly connection-per-actor). FTS5 with `categories 'L* N* Co M* So'`: Gujarati and Devanagari words stay whole and ◉ is a token; `remove_diacritics 2` folds *café* → *cafe*. `contentless_delete=1`, `fts5vocab` instance, `rtree_i32` with BCE day numbers, the trigram tokenizer and JSON1 all work. Other compile options: `ENABLE_DBSTAT_VTAB`, `ENABLE_SNAPSHOT`, `ENABLE_CARRAY`, `MAX_MMAP_SIZE=1073741824`, `OMIT_LOAD_EXTENSION`. The session-extension API is **not** declared in the iOS SDK header, so it is not used. The boot probe (`Store/Probe.swift`) asserts `sqlite3_libversion_number() ≥ 3_046_000`. It also tokenizes a fixed parity string through a temporary FTS5 table and `fts5vocab`, and refuses to open the atlas (with a clear error) if the device's SQLite ever tokenizes differently.

```swift
public final class Connection {                       // non-Sendable; confined to one executor
  public enum Mode: Sendable { case readWrite, readOnly }
  public init(path: String, mode: Mode, profile: StoreProfile) throws   // SQLITE_OPEN_NOMUTEX | (URI for immutable test clones)
  public func statement(_ sql: String) throws -> Statement            // LRU cache (128) per connection, sqlite3_prepare_v3(..., SQLITE_PREPARE_PERSISTENT)
  public func exec(_ sql: String) throws
  public func transaction<T>(_ kind: TxKind = .deferred, _ body: () throws -> T) throws -> T   // BEGIN DEFERRED|IMMEDIATE … COMMIT / ROLLBACK
  public nonisolated func interrupt()                 // sqlite3_interrupt — thread-safe
  public func setDeadline(_ d: ContinuousClock.Instant?)   // sqlite3_progress_handler every 10k VM steps → SQLITE_INTERRUPT
  public var changes: Int { get }; public var lastInsertRowID: Int64 { get }
}
public final class Statement {
  public func bind(_ values: [SQLValue]) throws       // .int(Int64) .double .text(String) .blob(Data) .null; json lists via json_each(?) as in the reference
  public func step() throws -> Row?                   // Row: int(_:), double(_:), text(_:), utf16(_:) → UnsafeBufferPointer<UInt16> via sqlite3_column_text16, blob(_:), isNull(_:)
  public func all<T>(_ map: (Row) throws -> T) throws -> [T]
}
```

- **PRAGMAs.** Every connection: `foreign_keys=ON`, `busy_timeout=5000`, `temp_store=MEMORY`. Writer: `journal_mode=WAL`, `synchronous=NORMAL`, `wal_autocheckpoint=1000` (0 during layer builds, then `wal_checkpoint(TRUNCATE)` per phase; the 1 GB WAL pause rule is ported), `cache_size=-65536`. Readers: `query_only=1`, `cache_size=-24576`, `mmap_size=1073741824` (the Apple cap). mmapped pages are file-backed and clean, so jetsam treats them better than heap.
- **FTS5.** The writer keeps the reference's bulk mode: `automerge=0` during a layer build, then `INSERT INTO passage_fts(passage_fts) VALUES('optimize')`. Contentless deletes go through `FTSWriter.delete(rowid:)`. The node:sqlite BigInt workaround (`ftsDelete`) is not needed.
- **UTF-16 fast path.** `sqlite3_column_text16` returns UTF-16 in native byte order, which is already the offset space of D4. Short fields (`document_field.value`) slice with no `String` round trip.
- **Snapshots.** A multi-statement read handler (timeline query plus its lane gates) runs inside one `BEGIN DEFERRED` on its reader, so it sees one WAL snapshot. Readers never hold a transaction across requests (as in the reference).

### 1.6 Concurrency design

```swift
public actor ReadConnection {                         // one per reader; blocking SQLite work never runs on the cooperative pool
  private let queue: DispatchSerialQueue
  public nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }
  func run<T: Sendable>(deadline: Duration?, _ body: @Sendable (Connection) throws -> T) throws -> T
}
public actor ReadPool {
  public init(path: String, size: Int = 2, profile: StoreProfile) throws        // phone 2, Mac CLI 4
  public func read<T: Sendable>(_ lane: ReadLane = .interactive, deadline: Duration = .seconds(5),
                                _ body: @Sendable (Connection) throws -> T) async throws -> T
  // .interactive requests jump the queue; .job requests may use at most size-1 connections, so the UI always has one
}
public actor Writer {                                  // the single RW connection, own serial executor
  public func write<T: Sendable>(_ body: @Sendable (Connection) throws -> T) async throws -> T   // short BEGIN IMMEDIATE
  public func lease(for job: JobID) async -> WriteLease   // bulk writers; interactive writes run between lease batches
}
public final class WriteLease: Sendable {
  public func batch<T: Sendable>(_ body: @Sendable (Connection) throws -> T) async throws -> T  // one transaction; then yields
}
public actor JobQueue {
  public func enqueue(_ spec: JobSpec) async throws -> JobID     // JobSpec(type:, params: JSONValue, priority:, after: [JobID])
  public func cancel(_ id: JobID) async
  public func recoverInterrupted() async throws                   // running → interrupted, their runs → failed (§4.12)
  public nonisolated let events: AsyncStream<JobEvent>            // progress ≤ 4/s per job, phase changes immediately
}
public protocol JobTask: Sendable {
  static var type: JobType { get }                                 // the 19 reference types + .applyLayer, .buildLayer
  static var writes: Bool { get }                                  // only ingest/layer/materialize/boilerplate/gc write in bulk
  func run(_ ctx: JobContext) async throws -> JSONValue
}
public final class JobContext: Sendable {
  public let id: JobID; public let reads: ReadPool
  public func write<T: Sendable>(_ body: @Sendable (Connection) throws -> T) async throws -> T
  public func progress(_ f: Double, phase: String? = nil, message: String? = nil, counts: JSONValue? = nil)
  public func checkpoint() async throws        // Task.checkCancellation + thermal gate + Task.yield(); call ≤ every 200 ms of work
  public func startRun(_ stage: Stage, params: JSONValue, scope: JSONValue, upstream: [RunID],
                       representation: String?, seed: Int?) async throws -> RunHandle   // reuse on (stage, params_hash, input_fingerprint)
  public func finishRun(_ r: RunHandle, _ status: RunStatus, metrics: JSONValue?) async throws
}
```

- **Scheduling.** At most one bulk-writing job and at most two read-only jobs run at once. Both priorities matter: job priority 1–9 orders the queue, and Swift `TaskPriority` (`.userInitiated` for priority ≤ 2, `.utility` for 3–6, `.background` for 7–9) orders CPU. Interactive reads always take `.userInitiated` and the reserved reader.
- **Dependencies.** `after:` replaces the reference's reliance on serialization (demo: materialize → cluster → label). This lets cluster, vectors, drift, tone, collocations and layout run `writes: false` and commit their rows in one short `Writer.write` that re-checks `input_fingerprint` (`E_INPUTS_CHANGED`). That was the remaining HANDOFF item.
- **Compute fan-out.** `withThrowingTaskGroup` uses work-stealing chunks, not equal static shards: the A17 Pro has 2 performance and 4 efficiency cores, so static 6-way shards finish at the speed of the slowest efficiency core. Chunks are ≤ 5 ms each, and every chunk ends with `try await ctx.checkpoint()`. Accelerate calls with large operands are **not** run concurrently (BLAS threads internally; nesting would oversubscribe).
- **Backpressure.** Adapters parse on a producer task and push `[CanonicalDocument]` batches of 500 into a `BoundedChannel<T>(capacity: 4)`, an actor of about 40 lines whose `send` suspends while it is full. The writer drains it. `AsyncStream` cannot apply backpressure, so it is not used here.
- **Cancellation.** Task cancellation → `ctx.checkpoint()` throws `CancellationError` → the run becomes `cancelled`, and its rows stay invisible (visibility rule) until `gc-runs` deletes them. A cancelled SQL statement is stopped by `Connection.interrupt()`, installed through `withTaskCancellationHandler`. Cancel is acknowledged in ≤ 500 ms (tested).
- **UI observation.** `@MainActor @Observable final class JobsModel` consumes `JobQueue.events`. `AtlasEvent.dataChanged(dataVersion)` invalidates memo caches and the Scroll's tile LRU.

### 1.7 The in-process API (routes → `AtlasService`)

```swift
public protocol AtlasService: Sendable {
  // health · jobs · imports (N1)
  func health() async throws -> Health
  func jobs(_ status: JobStatus?) async throws -> [Job];  func cancelJob(_ id: JobID) async throws -> Job
  func stageImport(_ file: URL, collection: CollectionSpec) async throws -> ImportPreview
  func validateImport(_ id: ImportBatchID, mapping: Mapping) async throws -> ImportSummary      // dry run (job)
  func commitImport(_ id: ImportBatchID, mapping: Mapping) async throws -> JobRef
  func revertImport(_ id: ImportBatchID) async throws -> JobRef;  func problemsCSV(_ id: ImportBatchID) async throws -> URL
  // corpora · adapters · atlas layers · tour · baseline (N2)
  func corpora() async throws -> CorporaResponse;  func facets(_ f: FilterSpec) async throws -> FacetsResponse
  func adapters() async throws -> [AdapterInfo];   func loadAdapter(_ id: String, params: JSONValue) async throws -> JobRef
  func installAtlas(_ pack: URL) async throws -> JobRef;  func layers() async throws -> [LayerInfo]
  func tour() async throws -> TourResponse;        func baseline(word: String, from: Int?, to: Int?) async throws -> BaselineResponse
  // search · expressions · timeline · passages · KWIC · exports (N3)
  func search(_ r: SearchRequest) async throws -> SearchResponse
  func track(_ r: TrackExpressionRequest) async throws -> ExpressionPayload
  func expression(_ id: ExpressionID) async throws -> ExpressionPayload
  func setVariants(_ id: ExpressionID, _ changes: [VariantToggle]) async throws -> ExpressionPayload
  func timelineQuery(_ r: TimelineQueryRequest) async throws -> TimelineQueryResponse      // → queryKey (query_def table kept)
  func tiles(_ r: TilesRequest) async throws -> TilesResponse
  func marks(_ r: MarksRequest) async throws -> MarksResponse;   func arcs(_ r: ArcsRequest) async throws -> ArcsResponse
  func shelf(_ r: ShelfRequest) async throws -> ShelfPage;       func bin(_ r: BinRequest) async throws -> BinPage
  func passage(_ id: PassageID, context: Bool) async throws -> PassagePayload
  func document(_ id: DocumentID) async throws -> DocumentPayload
  func documentText(_ id: DocumentID, from: Int, to: Int) async throws -> TextSlice        // ≤ 20k UTF-16 units
  func kwic(_ r: KwicRequest) async throws -> KwicPage
  func export(_ r: ExportRequest) async throws -> JobRef
  // analysis (N4)
  func compare(_ r: CompareRequest) async throws -> ComparePayload
  func collocations(_ r: CollocationsRequest) async throws -> Gated<CollocationsPayload>
  func clusters(expression: ExpressionID, run: RunID?) async throws -> ClustersPayload
  func startRun(_ r: StartRunRequest) async throws -> JobRef;  func runs(stage: Stage?, expression: ExpressionID?) async throws -> [RunInfo]
  func constellation(_ r: ConstellationRequest) async throws -> ConstellationPayload
  // lineage · provenance · notebook · views (N5)
  func lineage(_ r: LineageRequest) async throws -> LineageGraph;  func lineagePath(from: NodeRef, to: NodeRef) async throws -> LineagePath
  func genealogy(_ r: GenealogyRequest) async throws -> GenealogyPage
  func relationship(_ id: RelationshipID) async throws -> EdgeCard
  func proposeRelationship(_ r: ProposeRelationshipRequest) async throws -> EdgeCard
  func review(_ id: RelationshipID, _ r: ReviewRequest) async throws -> EdgeCard
  func addEvidence(_ id: RelationshipID, _ r: EvidenceRequest) async throws -> EdgeCard
  func hypothesisGroup(_ id: HypothesisGroupID) async throws -> HypothesisGroupPayload
  func createHypothesisGroup(_ r: HypothesisGroupRequest) async throws -> HypothesisGroupPayload
  func trace(_ r: TraceRequest) async throws -> TraceResult                                  // ≤ 1.5 s inline, else .job
  func annotations(_ q: AnnotationQuery) async throws -> AnnotationPage
  func annotate(_ r: AnnotationRequest) async throws -> Annotation
  func revise(_ id: AnnotationID, _ r: AnnotationRevisionRequest) async throws -> Annotation
  func reinterpret(_ id: AnnotationID, _ r: AnnotationRequest) async throws -> Annotation
  func withdraw(_ id: AnnotationID, reason: String) async throws -> Annotation
  func revisions(_ id: AnnotationID) async throws -> [AnnotationRevision]
  func saveView(_ r: SaveViewRequest) async throws -> SavedView;  func views() async throws -> [SavedViewSummary]
  func view(slug: String, asSaved: Bool) async throws -> SavedViewPayload;  func deleteView(slug: String) async throws
  nonisolated var events: AsyncStream<AtlasEvent> { get }       // .job, .dataChanged, .adapter, .bootstrap, .layer
}
public actor LiveAtlas: AtlasService { … }                       // one extension file per area: LiveAtlas+Search.swift, …
public struct MockAtlas: AtlasService { … }                       // decodes tests/contract/*.json (copied as resources)
```

- **Contracts.** Swift properties are camelCase. A shared `ScrollsJSON.decoder/encoder` uses `convertFromSnakeCase`/`convertToSnakeCase`, and explicit `CodingKeys` handle the few keys the conversion would mangle. **The round-trip test:** for each of the 65 fixtures, the canonical JSON of the decoded-then-encoded value must equal the fixture's canonical JSON. A field missing from a Swift struct therefore fails a test instead of disappearing.
- **`Gated<T>`** makes rule 7 a type: `enum Gated<T> { case value(T); case gated(Gate) }`, with `Gate { code: GateCode, needed: JSONValue, have: JSONValue, suggestion: Suggestion? }`. A gated measure **cannot** carry a number. The custom Codable writes `value: null` exactly as the contract does.
- **`provenance` block** (`data_version`, `run_ids`, tokenizer, segmenter, `synthetic`, collections, licences) is a required field of every data response struct, not an optional one.
- **Source adapters** keep the frozen §10.1 shape:

```swift
public protocol SourceAdapter: Sendable {
  static var id: String { get }; static var version: String { get }              // 'stemm.openalex', semver
  var label: String { get }; var access: AdapterAccess { get }; var license: String { get }; var attribution: String { get }
  var stagedDir: String? { get }; var collections: [CollectionSpec] { get }; var layer: LayerID { get }
  func probe(_ ctx: AdapterContext) async -> ProbeResult                          // reads FORMAT.md + MANIFEST.json first
  func plan(_ params: JSONValue, _ ctx: AdapterContext) async throws -> Int
  func documents(_ params: JSONValue, _ ctx: AdapterContext, into: BoundedChannel<[CanonicalDocument]>) async throws
  func relationships(_ params: JSONValue, _ ctx: AdapterContext, into: BoundedChannel<[CanonicalRelationship]>) async throws
  func annotations(_ params: JSONValue, _ ctx: AdapterContext, into: BoundedChannel<[CanonicalAnnotation]>) async throws
}
```

### 1.8 Unicode, ICU and number parity (measured, with the rule each measurement implies)

| Concern | Measurement (2026-10-09) | Rule |
|---|---|---|
| Token classes (`\p{L}\p{M}\p{N}\p{Co}` run, `\p{So}`, U+166D) | Over all 1,112,064 scalar values, Swift 6.4 `generalCategory` and Node's regex classes give **0 differences**. | Still ship a **generated two-stage table** (`TokenClassTable.swift`, about 30 KB) from Node. Lookup is O(1), and `u61m-1` stays frozen even when a later iOS updates Unicode. A test also compares the table with the runtime properties and prints any drift. |
| Fold: NFC → lowercase → Indic digits → strip ZWJ/ZWNJ/SHY | Over all 2,572 code points whose fold changes, plus 5 word-context cases, `precomposedStringWithCanonicalMapping` + `NSString.lowercased` = JS **exactly**. Swift's `String.lowercased()` fails **Final_Sigma** in 4 of the 5 context cases (ΟΔΟΣ → οδοσ, JS οδος). | Fold uses an ASCII fast path, else Foundation, memoized through `TokenInterner`. `String.lowercased()` is banned in the engine (a lint test greps for it). |
| Sentence breaks for `seg-1` long-block splits | Over 30 Cipher books, `NSString.enumerateSubstrings(.bySentences)` **enclosing-range** starts = `Intl.Segmenter('en')` boundaries: **562,089 / 562,089**. `NLTokenizer(.sentence)` missed 6,507. | Use `NSString` enclosing ranges, plus the reference's ।/॥ pass. |
| Throughput | A simplified Swift tokenizer prototype runs at **40M tokens/s** (CPU). A naive fold+join is 3.3M tokens/s, so `TokenInterner` hashes raw UTF-16 slices and folds each distinct form once (85k distinct per 2.7M tokens). FTS5 insert **0.35 s CPU per million tokens**; index **5.1 MB per million tokens** (the reference measured 0.37 s and 5.5 MB). | — |
| Canonical JSON (`params_hash`, `state_hash`, `input_fingerprint`) | `JSONEncoder` and `JSON.stringify` disagree on **6 of 9** probe numbers: `5e-07` vs `5e-7`, `1e-06` vs `0.000001`, `1.2345678901234568e+20` vs `123456789012345680000`, `9.007199254740994e+15` vs `9007199254740994`, `-0` vs `0`. | `JSNumber.format(Double)` implements ECMA-262 Number::toString from Swift's shortest round-trip digits. The golden covers 20,000 doubles plus the edge cases. |
| `localeCompare` sorts (lanes alphabetical, shelves, arcs, washes) | — | `ReferenceCollation.compare(a, b)` = `a.compare(b, locale: Locale(identifier: "en"))` (ICU). G3 sort-order goldens prove it. |
| `toLocaleString('en-US')` in messages and copy | — | `Format.int` groups with "," (en_US_POSIX digits). The copy is byte-equal (vocab goldens). |
| Seeds | `mulberry32` + Box–Muller over `Math.log/cos/sqrt` | `mulberry32` ported with wrapping UInt32 arithmetic (bit-exact). Darwin libm may differ from V8's fdlibm in the last ulp, so Gaussian draws are compared with a tolerance (§2.4). |

---

## 2. Differential testing against the Node reference

### 2.1 Six golden tiers

| Tier | What | Generated by (Node, `Native/Golden/`) | Inputs | Compare |
|---|---|---|---|---|
| **G1 pure** | dates, tokenizer, fold, segment, langid, ids/canonical JSON/JSNumber, mulberry32, fnv1a32, viewstate, evidence style, vocab templates, format, stats (Garwood, Wilson, G², BH-FDR, logDice, Gries DP), variants, translit `romanKey`, name guard, minhash signatures, winnow fingerprints | `gen-core.mjs` | 5,000 raw date strings (every distinct year/date value in `gutenberg.json`, Wikisource, `culture-works.tsv`, OpenAlex, Wiktionary, the ingest fixtures, all §5.3 examples, 2,000 grammar fuzz strings); day math every 97th day of [−10000, 3000]; tokens: the code-point table, the mini fixture, 5,000 passages sampled by language from m5-stemm, Greek/emoji/ZWJ edge strings; segments: 30 Cipher books, 10 paged Wikisource books, 10 STEMM books, all demo docs; 2,000 langid passages; 500 viewstates; every vocab template; stats grids; 500 expressions × languages for variants; 2,000 words for translit | **exact** (JSON-equal) |
| **G2 pipeline** | Ingest and adapters into an empty database, then a **logical dump** (§2.3) | `gen-pipeline.mjs` + `slices.mjs` | `tests/fixtures/ingest/*`, `tests/fixtures/mini`, the demo, and **Cipher slices** written by `slices.mjs` in the original formats: 25 Gutenberg books (including 6 with `***START OF` and 3 with SMALL PRINT markers, #1661 with its 3 QIDs, 2 double-BOM books), 20 hi + 20 gu Wikisource books, 2,000 `culture-works.tsv` rows with every relation code, 5,000 music relations, 500 roots families (including the 2,225-type multi-parent cases), 500 OpenAlex works + their in-sample citations (including date-conflict pairs), 50 gutenberg-stemm books (including translated ones), 300 Wiktionary entries | **exact** per table (ids mapped to natural keys) |
| **G3 read path** | Contract responses | `gen-read.mjs` (starts the reference server on a `cp -c` clone, replays `requests/*.json` over HTTP) | ≈ 400 requests on clones of **m1** (demo checks) and **m5-stemm**: search for 40 queries (*virus, zero, gene, bank, hacker*, phrases, शून्य, શૂન્ય, ◉, empty results); timeline query + tiles at L0–L5 for 12 expressions × facets (`domain`, `language`, `community`, `trail`, `cluster`); marks, arcs (C4 summaries for *gene*), shelves, bin pages, passages, documents, KWIC, facets, corpora; Compare for 40 slice pairs (including every gate code); views as saved | Swift runs the same requests **in-process on its own clone of the same snapshot**, using `InlineTextStore`, after materializing on that clone with its own engine. **Exact** for counts, states, ids, labels, copy and sort orders; tolerance (§2.4) for floats |
| **G4 analysis** | Runs with randomness or float32 linear algebra | `gen-analysis.mjs` | On a m5-stemm clone: vectors (en pooled + both era slices), cluster (*bank, zero, virus, gene* + the demo), drift (the M5-gate pair), collocations for 20 slices, convergence (demo), constellation for 5 queries, tone (English, if the CLI is present) | invariants with tolerances (§2.4) |
| **G5 display list** | `ScrollsScrollModel` vs `src/ui/timeline/{model,display,scale,tiers,folded,arcs,hit}` | `gen-display.mjs` (Node, no DOM: these modules are pure) | Tiles and arcs payloads from G3 for 3 widths (430, 932, 1440 pt) × 6 tiers × vantage {strict, context} × reduced-motion | **exact** for primitive ids, kinds, states, flags and label strings; geometry ±0.01 pt |
| **G6 device = Mac** | The same Swift engine on the phone and on the Mac | — (Swift only) | L0 starter and L1 Cipher metadata built on the phone and by the CLI | per-table `LogicalDump` sha256 equal. The phone's Diagnostics screen shows PASS/FAIL against the pack manifest. |

### 2.2 How goldens are stored and frozen

- `Tools/golden.sh` records the **reference commit** (`git rev-parse HEAD` of the web build), the Node, ICU and Unicode versions, and a sha256 of the generator scripts in `MANIFEST.json`. Goldens live in `~/Developer/scrolls-golden/<refcommit>/` (outside iCloud, outside git). G1 and the G2 mini/ingest dumps are small (< 8 MB) and are also copied into `ScrollsKit/Tests/DifferentialTests/Golden/` so `swift test` runs anywhere.
- **A diff is a finding against one side.** If the Swift side is wrong, it is fixed. If the reference is wrong, that is a reference bug: it is fixed in `server/`, the node tests are re-run, the goldens are regenerated, and the fix is recorded in VERIFICATION. A golden is never edited by hand.
- The fixture folders carry `MANIFEST.json`, not README files (agents cannot create `.md` files).

### 2.3 The LogicalDump (one spec, two dumpers)

`Golden/dump-spec.json` lists every table with its **natural key**, its id columns and how each maps to a natural key, its masked columns, and its float and JSON rules. `Golden/dump.mjs` (Node, over `node:sqlite`) and `ScrollsStore/LogicalDump.swift` both read this file:

```json
{ "document": { "key": ["collection.slug", "ext_id"], "ids": {"id": "self", "collection_id": "collection", "import_batch_id": "import_batch", "dup_of": "document"},
                "mask": ["created_at"], "text_hash": [], "json": ["original_meta_json"] },
  "passage":  { "key": ["document", "field", "ord"], "ids": {"id": "self", "document_id": "document"} },
  "document_text": { "key": ["document"], "virtual": {"original": "TextStore.fullText → sha256"} },
  "relationship": { "key": ["rel_type", "src", "dst", "source_dataset", "method"], "ids": {"run_id": "analysis_run"}, "mask": ["created_at"] },
  "import_batch": { "key": ["collection.slug", "file_sha256", "adapter_id", "ord"], "mask": ["created_at", "committed_at", "job_id"] },
  "passage_fts": { "virtual": {"rows": "SELECT rowid → passage key, fts5vocab instance terms → sha256"} } }
```

Rows are emitted as JSONL sorted by natural key. Floats use `JSNumber` with 12 significant digits. JSON columns are canonicalized. Timestamps become `"<ts>"`. Text bodies become sha256. FTS is compared through `passage_vocab_inst` (term, document key, offset), which also re-proves "FTS token i = JS token i". Because the `TextStore` sits behind the virtual column, a device-profile database (chunked text) and a reference database (inline text) produce **the same dump**. That is how chunking is proved lossless.

### 2.4 Comparison rules

| Quantity | Rule |
|---|---|
| counts, ids (as natural keys), bin states, tier/bin indices, gate codes, evidence status, labels and copy, sort orders, offsets, token counts, conservation sums, tile counts | exact |
| rates, CIs (Garwood, Wilson), G², q-values, logDice, PPMI of collocations, JSD, Gries DP (float64, same summation order in the port) | abs(Δ) ≤ 1e-9 · max(1, abs(x)) |
| float32 paths (PPMI matrix values, cosines, occurrence vectors) | abs(Δ) ≤ 1e-5 · max(1, abs(x)) |
| rSVD spaces | **subspace** check: the principal angles between the top-64 left singular subspaces have cos ≥ 0.999; per word the top-25 neighbour Jaccard ≥ 0.9 for 2,000 words with f ≥ 100 |
| k-means / clustering | k equal; adjusted Rand index vs reference assignments ≥ 0.98; per window, cluster shares within 0.01 and CI bounds within 0.02; machine labels equal (top 4 distinctive words) for clusters with stability ≥ 0.5 |
| drift (b), (c) | value within 0.01; null percentile within 1.0; gate and verdict ("notable" / "within typical variation") **exact** |
| bootstrap CIs | bounds within 0.01 (resample indices come from the bit-exact `mulberry32`; only libm ulps differ) |
| constellation layout | node set and edge set exact; positions after Procrustes alignment within 2% of the layout extent |
| display list geometry | ±0.01 pt; ids and kinds exact |

### 2.5 `Native/Tools/check.sh` (the CI-like gate)

```
Tools/check.sh quick     # ≈ 3 min: mirror → swift build -c release → unit tests → G1 → G2(mini, ingest, demo) → contract round-trip
Tools/check.sh full      # + G2 Cipher/STEMM slices, G3 on m1 + m5-stemm clones, G4, G5, the app build for the simulator, UI journey test
Tools/check.sh golden    # regenerate goldens when the reference commit or a generator changed (otherwise reuse)
Tools/check.sh device    # Release build, devicectl install on his iPhone, launch with -selftest, pull the result JSON from the container
```

Steps for `full`:
1. `rsync` the `Native/` and `LabKit/` mirrors to `$SCROLLS_BUILD_DIR`.
2. `swift build -c release`, then `swift test -c release --parallel` for the unit targets.
3. `golden.sh` if `MANIFEST.json` is stale. It runs Node with `DYLD_LIBRARY_PATH=/opt/homebrew/Cellar/simdjson/4.6.11/lib:/opt/homebrew/Cellar/hdrhistogram_c/0.11.10/lib` while Homebrew node is broken.
4. `swift test --filter DifferentialTests` (G1, G2-small, G5).
5. `scrolls-cli diff-pipeline --slices ~/Developer/scrolls-golden/<ref>/slices` (G2 large).
6. `cp -c` both snapshots into `$TMPDIR`, then `scrolls-cli diff-read --snapshot … --requests Golden/requests --expected <G3 dir>` and `diff-analysis` (G4). The CLI opens clones only, never `~/Developer/scrolls-data`.
7. `xcodebuild … -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test` (the UI journey).

It prints one PASS/FAIL table, writes `Native/Reports/check-<date>.json`, and exits non-zero on any FAIL. Timings run under `--bench` only and never fail the gate (the Mac is often loaded).

---

## 3. On-device data

### 3.1 Storage budget

The m5-stemm snapshot (measured, `dbstat`) is 3,554 MB on 4 KB pages: `document_text` 917, `document` 463 (of which `original_meta_json` 278, 192 of it OpenAlex), `passage_fts` 391 + 37, `relationship_revision` 242 (`after_json` 189 MB for 595,524 rows, nearly all "create"), `passage` 202 + indexes 160, `relationship` 180, `doc_tag` 148 + 79, `date_assertion` 135 + R-tree 34, `label_tri` 121, `doc_minhash` 32. It holds 394,317 documents, 2,763,200 passages, 146.7M passage tokens (145.2M in `quality='ok'`), 593,078 relationships and 881,618 date assertions.

| Item | Reference | Device profile | How |
|---|---|---|---|
| `document_text` | 917 MB | **≈ 420 MB** | passage-aligned 16k-unit chunks, LZFSE over UTF-8 (measured **2.24×**: 2.11× at 8k, 2.35× at 32k, 2.42× at 64k); chunks shorter than 2 KB stored raw |
| `relationship_revision` | 242 MB | **≈ 35 MB** | compact "create" rows (§3.2) |
| `original_meta_json` | 278 MB | 278 MB in v1; **≈ 60 MB** with S3 | S3 (deferred): records > 1 KB move to LZFSE meta blocks; hot keys (`sample_cell`) stay inline |
| everything else | ≈ 2,117 MB | ≈ 2,117 MB | unchanged (no index dropped in v1) |
| **Atlas database** | 3,554 MB | **≈ 2.85 GB** (≈ 2.63 GB with S3) | 2,117 + 420 + 35 + 278 MB; the snapshot has 0 free pages and 140 MB of in-page slack, so `VACUUM` gains little |
| Vector spaces (en pooled 37,022 × 256 + 2 era slices, f32) | 78 MB | 78 MB | shipped in the pack (layer L7) |
| Purgeable caches: slice cubes (≈ 12 MB per corpus), token streams (≈ 4 B/token, built per language on demand), tile and memo files | — | ≤ 700 MB, OS-purgeable | `Library/Caches` |
| Ngram baseline (`ngram-eng-1.sqlite`) | 174 MB | 174 MB, optional | attached read-only |

**Target:** ≤ **3.2 GB** installed for the full corpus (database 2.85 + spaces 0.08 + baseline 0.17 = 3.1 GB), plus purgeable caches; S3 is the first lever if a later layer pushes past it. **Hard ceiling:** **4.0 GB** including caches. `installAtlas` refuses when free space is < 2.2 × the pack size (the merge needs the pack, the WAL and the grown database at once) and says what to free. His 15 Pro Max has ≥ 256 GB, so storage is not the limit. Transfer and apply time are.

### 3.2 Device profile DDL (additive; `device-profile.sql`, `meta.profile = 'device-1'`)

```sql
ALTER TABLE document_text ADD COLUMN storage TEXT NOT NULL DEFAULT 'inline' CHECK (storage IN ('inline','chunked'));
-- chunked rows keep body_start, body_end, original_sha256 (sha of the full UTF-8 original, the D18 anchor key), decoder;
-- original = '' and the text lives in:
CREATE TABLE text_chunk (
  document_id INTEGER NOT NULL REFERENCES document(id),
  ord INTEGER NOT NULL,
  start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,      -- UTF-16 units; boundaries at passage ends, so no passage spans two chunks
  codec TEXT NOT NULL CHECK (codec IN ('lzfse-utf8','utf8')),
  z BLOB NOT NULL,
  PRIMARY KEY (document_id, ord)) STRICT;
CREATE TABLE layer (                                          -- installed atlas layers, in install order
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, ord INTEGER NOT NULL UNIQUE,
  engine_version TEXT NOT NULL, built_on TEXT NOT NULL CHECK (built_on IN ('mac','device')),
  entity_hash TEXT NOT NULL, pack_id TEXT, installed_at TEXT NOT NULL) STRICT;
CREATE TABLE user_journal (                                   -- every user-authored write, same transaction (§6)
  id INTEGER PRIMARY KEY, op TEXT NOT NULL, body_json TEXT NOT NULL CHECK (json_valid(body_json)), at TEXT NOT NULL) STRICT;
CREATE TRIGGER journal_no_update BEFORE UPDATE ON user_journal BEGIN SELECT RAISE(ABORT, 'the user journal is append-only'); END;
CREATE TRIGGER journal_no_delete BEFORE DELETE ON user_journal BEGIN SELECT RAISE(ABORT, 'the user journal is append-only'); END;
```

**Compact create revisions.** For relationships with `origin IN ('source_dataset','algorithm')`, the `rev = 1, action = 'create'` row stores `after_json = '{"$row":1}'`. Evidence fields are immutable by trigger, and the creation state of `review_status`/`hypothesis_group_id` is recoverable: it is `'unreviewed'` plus the `before_json` of the first `regroup` revision when one exists. `Provenance/Revisions.swift` expands the marker. LogicalDump compares the **expanded** form, so G2 proves the compaction is lossless. Human relationships keep full revisions.

The `TextStore` protocol has two implementations:

```swift
public protocol TextStore: Sendable {
  func utf16(_ doc: DocumentID, _ r: Range<Int32>, on c: Connection) throws -> [UInt16]   // the D4 offset space
  func fullText(_ doc: DocumentID, on c: Connection) throws -> String
}
public struct InlineTextStore: TextStore { … }     // reference databases (diff tests, Mac CLI on snapshots)
public struct ChunkedTextStore: TextStore { … }    // device profile; per-reader LRU of decoded chunks (24 MB)
```

### 3.3 Atlas layers and the row-id policy (how a Mac-built corpus merges into a phone that already has user state)

**Layers** (fixed order; a pack carries a contiguous run of them):

| Layer | Content | Built where (v1) |
|---|---|---|
| L0 `base` | seeded vocab, corpora, the demo world (228 documents, synthetic relationships and annotations), tour | CLI → bundled `starter.sqlite.lzfse` |
| L1 `cipher-meta` | culture works (94,385), themes, etymology (54,989 families), sibling relations (bootstrap phase A) | **phone** at first launch (bundled sources) or CLI |
| L2 `cipher-relations` | 179,014 relation endpoints + documented music relations (phase A2) | CLI (phone from a source pack) |
| L3 `cipher-text` | 691 Gutenberg + 825 Wikisource books, boilerplate pass (phase B) | CLI (phone from a source pack: estimated 6–10 min) |
| L4 `stemm-gutenberg` | 684 + 20 restricted books | CLI |
| L5 `stemm-openalex` | 118,466 works, 60,574 abstracts, 381,800 citations | CLI |
| L6 `stemm-wiktionary` | attestation claims | CLI |
| L7 `derived-en` | pooled + era vector spaces, the commonplace index | CLI |

**Id rules** (`Store/RowIDPolicy.swift`; every writer allocates through `RowIDAllocator`):
1. **Entity tables** (collection, document, passage + its FTS rowid, date_assertion + its R-tree id, relationship, relationship_evidence, hypothesis_group, annotation, expression, expression_variant, occurrence, sense_cluster, time_window, vector_space, space_alignment, cluster_transition, drift_result, saved_view, import_issue, text_chunk). Layer rows take explicit ids `L × 100,000,000 + counter`, so a layer build is deterministic on any machine. Rows created on the phone take `1,500,000,000 + counter`. **Every id stays < 2³¹**: the cube's `Int32Array` contract and the u32 packing of winnow records stay valid.
2. **Log-ordered tables** (`import_batch`, `analysis_run`, `relationship_revision`, `annotation_revision`, `job`, `job_event`, `compare_log`). Ids are max+1 at insert, so id order = commit order on that device. That is what the as-saved cutoffs (`max_import_batch`, `annotation_rev_cutoff`, `relationship_rev_cutoff`) and "a newer run exists" rely on (`provenance/views.mjs` compares ids).
3. **Applying a pack** (`ApplyLayerTask`, a bulk writer job):
   1. `ATTACH` the pack read-only.
   2. Verify that its first layer is the next one: its manifest's hash of the previous layer must equal the phone's `layer.entity_hash`.
   3. Copy entity rows unchanged (their id ranges are disjoint by construction).
   4. Copy log rows with **new max+1 ids**, remapping every referencing column through temporary `map_<table>(old, new)` tables. The remap plan is generated from `PRAGMA foreign_key_list` plus a short explicit list of undeclared references (`expr_doc.run_id`, `analysis_run.upstream_run_ids` JSON, `import_batch.job_id`).
   5. **Rebuild FTS rows** for the new passages. A contentless FTS5 table cannot be copied row by row, so `FTSWriter` re-tokenizes from the chunks; estimate 2–3 min for 146M tokens on the A17 Pro. Meanwhile those collections show the existing `pending` state, "indexing — not yet looked".
   6. Bump `data_version` once per layer and invalidate cubes.

   Saved views made before the pack therefore keep counting exactly what existed at their save (D17). A view saved on day 1 never starts to include the STEMM layer installed on day 3.
4. **Layer updates are new layers** (append-only). There are 15 layer slots (L0–L14) below the local range; when they run out, a re-base rebuilds the atlas and replays the journal (§6). A corrected Cipher text arrives as a later layer that soft-deletes or upserts through the normal writer paths, never by rewriting L3 in place. An engine whose `u61m-1`/`seg-1` output changed requires a rebuild through the journal (§6).

**Pack format.** `.scrollsatlas` is one SQLite file (device profile, `VACUUM`ed, `page_size 4096`). It has a `pack_manifest` table (engine version, reference commit, layer list, per-layer and per-table LogicalDump sha256, row counts, sizes) and a `pack_file` table for the binary space files (`*.f32` as 64 MB BLOB parts). It is one file, so it moves as one item over AirDrop, Finder or Files, needs no unarchiving, and is checked by a streamed sha256 (CryptoKit). A `.scrollssource` is an Apple Archive (`.aar`, LZFSE) of a staged-sources directory, extracted with the system `AppleArchive` framework.

**Transfer.** The primary path is Finder file sharing over USB-C: `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace`, as Cipher does. The Pro model's USB 3 port is 10 Gb/s, so ≈ 2.9 GB takes well under a minute. AirDrop or "Open in Scrolls" from Files also works. The app watches `Documents/Inbox/`, verifies the pack, shows its manifest ("8 layers · 2.93 GB · engine 1.0.0 · built 2026-10-xx on the Mac"), and applies it on confirmation. Applying is resumable per layer: a layer commits as a unit, and a half-applied layer is rolled back at the next launch. The phone keeps the pack file until the apply succeeds, then deletes it (this is the app's own staging copy, not user data).

### 3.4 First launch (scripted, D10 on the phone)

| t | What happens | Engine path |
|---|---|---|
| 0–0.6 s | The bundled `starter.sqlite.lzfse` (≈ 4 MB, L0) is decompressed with `compression_stream` into Application Support and adopted as the database. The Scroll paints *carry the zero* with the SYNTHETIC ribbon. The tour's coach ① appears at 2 s. | `Store.adoptStarter()` |
| 1 s | `buildLayer(L1)` is queued at priority 9: phase A from `cipher-meta.scrollssource` (≈ 9 MB LZFSE: `culture-works.tsv` 20 MB, `culture-themes.tsv` 0.65 MB, `roots.tsv` 5.2 MB). The jobs chip reads "Cipher: titles & etymology · 12%". | the same `CipherWorks/Themes/Roots` adapters the CLI uses |
| ≈ 20–45 s (estimate) | L1 commits. Search reaches 94,385 titles, makers, themes and etymology families. The tour's final card enables **Switch to Cipher (real data)**. The G6 check runs in the background: L1 entity hash = the hash in the bundled manifest. | |
| later | The Sources sheet states what is missing, with the reason: "Full text of 1,516 Cipher books and the STEMM sources are not on this phone yet. Install an atlas from your Mac (Finder → Scrolls) or build from a source pack (≈ 6–10 min, keep Scrolls open or let it continue in the background)." Lanes of those collections are `uncovered` ("no sources"), never `absent`. | |

### 3.5 Background work, thermal and memory limits

- **`BGContinuedProcessingTask`** (iOS 26+) runs `applyLayer`, `buildLayer` and long imports. It is submitted only from a user tap ("Install atlas", "Build from source pack"), with identifiers `com.utkarsh.scrolls.atlas.<jobId>` under the permitted wildcard `com.utkarsh.scrolls.atlas.*`. The task's `progress` is fed by `JobContext.progress`. If the system expires it, the job cancels at the next checkpoint. Committed chunks stay (5,000 documents or 50,000 rows; `import_once` and `UNIQUE(collection_id, ext_id)` make reloads skip them), and the job is re-queued as `interrupted → queued` the next time the app is active.
- **`BGProcessingTask`** (`requiresExternalPower = true`) runs maintenance: FTS `optimize` after merges, `gc-runs`, cube warm-up, `wal_checkpoint(TRUNCATE)`.
- **Thermal.** `JobContext.checkpoint()` reads `ProcessInfo.thermalState`. At `.serious`, TaskGroup fan-out drops to 1 and each chunk is followed by a 50 ms sleep. At `.critical`, the job pauses with phase "paused — the phone is hot", and the UI shows it. Interactive reads are never throttled.
- **Memory.** The app carries the `com.apple.developer.kernel.increased-memory-limit` entitlement. Every large allocation asks `MemoryBudget.reserve(bytes:)`, which checks `os_proc_available_memory()` with a 600 MB headroom. Kernels are sized for ≤ 1.2 GB peak: co-occurrence 8 × 2²³ slots = 512 MB, winnow records 10 B × fingerprints (a 60M-token collection ≈ 175 MB), and k-means on ≤ 20k × 256 floats. When the budget fails, the job ends with a gate-like message and a suggestion ("Build the English space on your Mac (scrolls-cli) — this phone has 0.9 GB free for Scrolls now"). Heavy analysis jobs refuse to *start* in the background (the background jetsam limit is unknown and much lower), and they resume when the app is in front.
- **File protection.** The class is `CompleteUntilFirstUserAuthentication` (the default), so background tasks can open the database while the phone is locked.

### 3.6 Files, backup, import, export

| Location | What | Backup |
|---|---|---|
| `Library/Application Support/Scrolls/atlas.sqlite` (+ `-wal`, `-shm`) | the database | **excluded** (`isExcludedFromBackup`) |
| `…/Scrolls/spaces/*.f32`, `…/baseline/ngram-eng-1.sqlite` | derived | excluded |
| `…/Scrolls/originals/<aa>/<sha256>` | verbatim bytes of **user** imports | included |
| `…/Scrolls/user/journal-export.sqlite` | the user journal copy (§6) | included |
| `Library/Caches/Scrolls/` | cubes, token streams, memo files | purgeable |
| `Documents/Inbox/`, `Documents/Exports/` | packs, files to import, exports (visible in Files and Finder) | Inbox excluded; Exports included |

- **Import** comes from `.fileImporter` (`.plainText`, `.commaSeparatedText`, `.tabSeparatedText`, `.json`, `net.daringfireball.markdown`, and the imported type `org.jsonlines.jsonl`) and from "Open in Scrolls" through `CFBundleDocumentTypes`. The flow: security-scoped read, streamed copy into `tmp/`, sha256, `originals/`, then the import wizard (sniff → map → validate dry-run → commit job). Exported UTTypes: `com.utkarsh.scrolls.atlas` (`.scrollsatlas`), `com.utkarsh.scrolls.source` (`.scrollssource`), `com.utkarsh.scrolls.view` (`.scrollsview`).
- **Export** goes through `ShareLink` with `Transferable` `FileRepresentation`s that run the export job lazily with progress. Formats: JSON, JSONL and CSV with the manifest; a notebook export with every revision; PNG and SVG snapshots of the Scroll; a `.scrollsview` (the saved view's immutable record, re-openable on another phone holding the same layers). `export_text_allowed = 0` (OpenAlex abstracts) is enforced in each.

---

## 4. The iPhone experience (the engine-side view; the experience architect owns the details)

### 4.1 Layouts (iPhone 15 Pro Max: 430 × 932 pt portrait, 932 × 430 pt landscape)

- **Portrait (default)**
  - Top: Liquid Glass search field with the corpus chip and the jobs chip.
  - Below it: the minimap (20 pt, folded overview with the cyan viewport bracket) and the ruler (28 pt, with the coverage track).
  - The Scroll fills ≈ 55% of the height with ≤ 5 lanes and a "+n more lanes" row. A 76 pt lane rail shows `label · unit · coverage` truncated, with a full header on tap. The UNDATED and SCHEDULED shelves become chips at the rail's top (`⊘ 4`, `⏵ 2`).
  - Bottom: the inspector sheet (`presentationDetents([.height(132), .medium, .large])`, background interaction enabled at the peek detent) with Then / Now / Next tabs, above a glass bottom bar (Search · Play · Lanes · Filters · More).
- **Landscape: the "wide Scroll"**
  - ≤ 10 lanes, a 120 pt rail, and real shelves (UNDATED 64 pt, SCHEDULED 48 pt).
  - The inspector becomes a trailing panel (≈ 38% of the width) instead of a sheet.
  - Compare puts A and B side by side; portrait stacks A over B.

### 4.2 Gestures

- **Axis lock.** The first 10 pt of travel decide the axis: within 30° of horizontal it is time, otherwise lanes.
- **Pan and zoom.**
  - Horizontal pan has momentum (deceleration 0.998 per ms; off under Reduce Motion).
  - Vertical drag scrolls lanes.
  - Pinch zooms **x only**, anchored at the centroid, clamped to [0.05 px/year, 40 px/day] (§1.5).
- **Taps.**
  - Double-tap zooms in one tier; a two-finger tap zooms out one tier.
  - A tap selects through the hit grid (12 pt touch tolerance; priority mark > arc > cap > bin > wash > band).
  - A long press (0.5 s) opens a context menu: Open, Annotate, Lineage, Compare A/B, Pin.
- **Playhead.** The handle has a 44 × 44 pt target.
- **System gestures.** The Scroll is the root view, so there is no back-swipe on it. Full-screen sheets close with an explicit button. While scrubbing or dragging near the bottom edge, `defersSystemGestures(on: .bottom)` holds the home gesture.

### 4.3 Rendering: Metal, fed by the ported display list

| Option | Verdict |
|---|---|
| SwiftUI `Canvas` | Immediate-mode CoreGraphics on the CPU. 20k rects + 4k ticks per frame is ≈ 10–25 ms (estimate), which misses the 8.3 ms frame of 120 Hz. **Used only for the ≤ 150 text labels and chips** (cached `ResolvedText`). |
| Core Animation tiles (map-app style) | Pan is free, but pinch shows stale scaled bitmaps until re-render, which contradicts "the previous tier stays drawn dimmed until new tiles arrive; never interpolated". |
| **Metal instanced primitives** | **Chosen.** Geometry is in content space: x in days, y in lane slots. Pan and zoom change only a uniform. Bars, ticks, diamonds, washes and bands are instanced quads. Hatches (45°, 6 pt pitch), dots, `--syn-stripe` and feathered circa ends are procedural fragment shaders in screen space. Arcs are quadratic curves tessellated to 16 segments with dash patterns by arc length (documented solid · computed 6/4 · proposed 1/3). |

- **Pipeline.** Tiles from `LiveAtlas`, then `ScrollsScrollModel.buildModel(...)` (off main, `@concurrent`), then `buildDisplayList(...)`, which produces the `DisplayList` (typed arrays of primitives with stable ids). The `ScrollRenderer` (MTKView delegate, triple-buffered instance buffers) draws it. `CGScrollPainter` draws the same list for PNG export, and `SVGWriter` (port of `svg.mjs`) writes the SVG. Hit testing uses the same 24 pt content-space grid as `hit.mjs`.
- **Frame pacing.** `CADisableMinimumFrameDurationOnPhone = YES`. The view is paused and redraws on demand. `CADisplayLink.preferredFrameRateRange` is 80–120 while a gesture or play runs, and it is idle otherwise.
- **Budgets (A17 Pro, @3x, 1290 × 2796 px)**

  | Item | Budget |
  |---|---|
  | CPU encode per frame | ≤ 1.5 ms |
  | GPU per frame | ≤ 3 ms at 20,000 bin cells + 4,000 marks + 300 arcs + patterns |
  | Display-list rebuild on a tier change or tile arrival | ≤ 16 ms, off main |
  | Hit test | ≤ 0.5 ms |
  | Cached tile → paint | ≤ 50 ms |
  | Demo first paint | ≤ 600 ms after launch |
  | Main-thread stalls | none > 16 ms (the perf HUD logs p50/p95; `-perf` launch argument) |

  As in the reference, a list over budget steps to a coarser tier and shows a `simplified` badge with the reason.

### 4.4 Honesty encodings on the phone (SPEC §1, §8.7 — all kept)

| Encoding | Phone rendering | VoiceOver / table |
|---|---|---|
| bin states observed / absent / low / uncovered / pending | rect height = rate; 1 pt dotted baseline; hollow tick + light hatch underlay; 45° hatch underlay "no sources"; sparse dots "indexing — not yet looked" | state word + n + denominator per bin ("0 in 4.1M tokens — looked, found none") |
| bar = maximal observed run; never bridged | instanced runs only; nothing drawn between | "observed in 19 of 31 covered years · 3 gaps" |
| precision washes (never in rates) | translucent band + count label; circa ends feathered 10% | "6 · dated to decade" |
| censoring ◁ ▷, exact first/last caps, strand glyph ● ■ ▲ ◆ | glyph atlas sprites | "may be older than our record" |
| sparse fill (n ≤ 4), single-source superscript ¹, ≈ estimated-date stripes, SYNTHETIC stripe + `SYN` | pattern shader flags per instance | flags spelled out |
| evidence: documented solid ● `DOC`/`DOC*`; computed dashed □ `CALC`; proposed dotted ? `PROP`/`PROP · CUE` | dash + endpoint sprite + badge text (never hue alone; Differentiate Without Colour changes nothing because it is never colour-only) | badge words read out |
| review ✓ / ✕ (hidden, 30%) / ⚖ | midpoint glyph overlay; **the line pattern never changes** | "confirmed by a reader" etc. |
| feedback arcs below, violet, only after the vantage reaches the later work; re-read halo | below-lane arc pass + halo sprite | "re-read after 1994 (1 documented, 2 annotated)" |
| date conflict | `--danger` dotted stub + ⚠ | "date conflict" |
| modality seam (1928) | permanent vertical rule + ruler caption; collapsible to a tick, never hidden | caption read at the seam |
| coverage track (5-class step), lane underlay | 24 pt track under the ruler | class names |
| etymology bands (periods, not dates), listed-roots bracket, Wiktionary claim ◇ | hatched bands, bracket label, hollow amber diamond left of the strand | full labels |
| external baseline | its own 32 pt track and axis | "a different corpus" |
| playhead / vantage (strict vs context ghost 15%) | cyan line + handle "as of 1997" | value announced ≤ 1/s |

### 4.5 Views

- **Search.** A typed suggestion list (expression · work · maker · theme · etymology · annotations). Empty states are computed: "0 is an observation about this index".
- **Then / Now / Next.** Sheet tabs. The passage reader uses New York with Dynamic Type and shows the exact highlight at its offsets, the date chip ("17 May 1994 · stated · day") and the Crossings card.
- **Compare.** A full-screen sheet. A over B in portrait, side by side in landscape. Gate cards never show a numeral (`Gated<T>` makes that impossible), and the coverage-difference explanation sits on top.
- **Lineage and Genealogy.** Full-screen. A vertical chain of custody with hypothesis groups; edge cards carry evidence, method and status.
- **Constellation.** Stable layout from the `layout` run, with a persistent legend and a two-period toggle.
- **Notebook.** Annotations with revisions, layers and dimensions. The as-of slider uses **timestamps**, which fixes the reference's one-stop-per-day limit.
- **Term trail.** A lane preset.
- **Saved views and share links.** A view is saved immutably (`slug~n`). The link is `scrolls://view/<slug>?as=1`, or the full v1 state as `scrolls://scroll?v=1&c=…` with the same grammar as `viewstate`, or a `.scrollsview` file. Universal Links need a domain and are out of scope.
- **Import wizard.** Four steps in one sheet: drop → map → validate → commit.
- **First-minute tour.** Non-blocking coach marks that remember dismissal (`@AppStorage`).
- **States.** Loading always shows a number ("counting… 41%"); errors show the message, the hint and Retry.

### 4.6 Accessibility, haptics, glass, LabKit

- **VoiceOver.** The Scroll is an `accessibilityRepresentation` with one element per lane and a custom rotor over marks. Each lane exposes an `AXChartDescriptor` for Audio Graphs. The table alternative (`T` in the reference, a toolbar button here) is a SwiftUI `Table`-style list built from **the same arrays** the renderer uses (identity test, as in `ui.a11y-table`).
- **Dynamic Type.** Chrome and passages scale. Labels inside the Scroll stop at `.accessibility1` (LabKit's rule) and offer the Large Content Viewer.
- **Reduce Motion.** No momentum and no fades. Play steps every 1.2 s, and **Step ▸** becomes the primary control.
- **LabKit.** Adopt **LabKitCore** (`CopyLint` runs over all user-facing strings, next to a Scrolls test that scans for SPEC's `MENTAL_STATE_VERBS`; `LabFormat`), **LabKitFeedback** (`HapticEngine`: a detent tick on each tier change, a light tick per vantage bin step capped at 20 Hz, success on a commit, nothing else), and the **LabKitUI** chrome components (`GlassToggle`, `ChoiceChips`, `StatusBanner`, `LabInfoSheet` in its fixed panel order for "How Scrolls works", `ProminentGlassButton`).
- **Not adopted.** LabKitRender (its bloom/EDR `PostChain` would distort honest encodings, and it has no dash/hatch/endpoint model), LabKitSensors, physics, and the phosphor palettes. Scrolls keeps SPEC §8.7's tokens (charcoal, ivory, cyan, amber, violet) as `Scrolls/Design/Tokens.swift`. Scrolls is an instrument for reading evidence, not a toy: it takes LabKit's feel and accessibility discipline, not its look.

---

## 5. Performance on the A17 Pro

Estimates scale the CPU times measured here (M1 Max performance core) by ≈ 1.2× for an A17 Pro performance core and ≈ 0.7× sustained under thermal load, with 2 performance + 4 efficiency cores.

| Operation | Reference (Node, loaded Mac) | Measured here (Swift, CPU) | A17 Pro estimate | How it is bounded |
|---|---|---|---|---|
| FTS term / phrase count | — | *virus* < 1 ms; phrase 2 ms; *the* (1.34M passages) 45 ms | 1–60 ms | FTS5; the very-frequent path uses `passage_vocab_inst` |
| Typed search + 50 KWIC rows | ≤ 120 ms budget | label_tri 0 ms; FTS join for *bank* 11 ms (8,563 passages) | 15–40 ms | KWIC decodes ≤ 50 chunks (≈ 30 µs each) |
| Materialize a new word (*bank*: 988 docs, 8.5k candidate passages) | 1–14 s; reads 519M UTF-16 units of whole books | reading those whole books alone: 319 ms CPU | **0.3–0.8 s** | reads only candidate chunks (≈ 6k × 32 KB); tokenizes ≈ 1M tokens |
| Very frequent word (> 300k matches) | streaming worker | vocab row for *the*: 35 ms | 1–3 s | per-document counts from `fts5vocab` instance; stratified sample ≤ 200 per (lane, decade) |
| Slice cube build (562,643 `doc_tokens` rows) | cached file 12–14 MB | — | 0.3–0.8 s once per inputs key | Caches file; memory ≈ 38 MB per corpus |
| Tiles (one viewport) | warm ≤ 80 ms, cold p95 618 ms | — | warm ≤ 5 ms, cold ≤ 40 ms | cube + `expr_doc` (≤ ~20k rows per expression); memo LRU |
| Compare (coverage, composition, frequency, CIs) | — | — | ≤ 150 ms | cube; gates first |
| Collocations for a slice | — | — | first per language: token-stream job 10–25 s; then 0.2–1 s | token stream (u32, mmap, purgeable); gate n ≥ 20 |
| Clustering (*bank*, 6,596 occurrences) | 208 s (loaded) | — | **5–15 s** | k-means distances via `cblas_sgemm`; 10 restarts, ≤ 100 iterations, 30 stability subsamples on a TaskGroup; gate ≥ 60 |
| Pooled PPMI–SVD space (en: 36M tokens, 37,022 types, 13.9M non-zeros) | 34 s | — | 15–30 s on the phone | **precomputed in L7 by the CLI**; on the phone only for user imports and other languages (gate ≥ 3M tokens); ≈ 23 GMAC sparse in 6 products + LAPACK QR/SVD |
| Drift run (neighbour overlap + aligned displacement + 500 controls) | 100 s | — | 3–10 s | BLAS neighbour search (500 × 37k × 256) + 256 × 256 SVD |
| Boilerplate pass (146M tokens, ≈ 42M fingerprints) | in bootstrap | — | CLI only for the full corpus; ≤ 60M-token collections on the phone (≈ 175 MB) | memory budget |
| Global reuse index | off by default | — | **Mac CLI only** (v1) | — |
| L1 build (phase A) on the phone | phase A 39 s | — | 20–45 s | ≈ 1.3M rows + FTS of ≈ 2M tokens |
| Apply the full atlas | — | FTS insert 0.35 s/Mtok | **3–5 min** (copy ≈ 2.9 GB + FTS for 146M tokens) | `BGContinuedProcessingTask`, per-layer commits |
| Build L3 from a source pack on the phone | full bootstrap 3,449 s (loaded) | tokenize 40 Mtok/s | 6–10 min | same, resumable |

All on-phone timings are estimates until N8 measures them with the perf HUD and `scrolls-cli bench` on the device build. VERIFICATION will record them as measured.

---

## 6. Persistence of user state

**Decision: the same SQLite database, the same tables, no SwiftData.**

**Why.** The reference already settles the semantics:
- Annotations and relationship revisions are append-only through triggers.
- A reinterpretation supersedes and never deletes.
- A review is a separate layer: `review_status` plus a `relationship_revision` written in **one** transaction.
- Saved views are immutable through a trigger and carry id-ordered cutoffs.
- As-of queries join revisions by id and time.
- D18 anchors resolve against `document_text.original_sha256` and passage offsets.

SwiftData can express none of the triggers or CHECKs, and it would split a review from its revision across two stores. Per-viewer conveniences (tour dismissed, Reduce Motion override, last view) go to `@AppStorage`.

**The journal.** The atlas database is excluded from backup because of its size. User-authored writes are therefore made durable a second way:
- In the **same transaction** as the write, `UserWrites` appends one canonical op to `user_journal`, with both row ids and natural keys. The ops: `annotate`, `revise`, `reinterpret`, `withdraw`, `review`, `propose_relationship`, `add_evidence`, `hypothesis_group`, `dimension_def`, `save_view`, `delete_view`, `track_expression`, `set_variants`, `name_override`, `import_batch` with its originals' sha256, and `revert`.
- `JournalExporter` copies new journal rows into the backed-up `user/journal-export.sqlite`. It runs debounced 2 s after a write and on `scenePhase == .background` under `beginBackgroundTask`. The copy is idempotent because it is keyed by journal id.
- **Replay.** On a new phone, or after an atlas rebuild forced by an engine change:
  1. Install the layers.
  2. Replay the journal in order through the same service methods. Ids are checked against natural keys; on a mismatch the row is resolved by natural key, and passage anchors are re-anchored by the D18 algorithm (`anchors.mjs`, ported).
  3. Recompute each saved view's cutoffs as "the maximum id among replayed log rows that preceded the view's op". The view's `state_hash` must equal the journal's.
  4. An op that cannot be resolved is kept and listed in the notebook as "could not re-attach (reason)", never dropped.
- The notebook export (share sheet) is the journal plus every revision, in machine-readable JSONL with the manifest.

Revision history, D17 immutability and D18 anchoring therefore hold on one phone, across restore, and across atlas replacement.

---

## 7. Risks, and what to cut or defer

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Unicode/ICU drift between JS and Swift (tokens, fold, sentences, collation, number text) | measured low for tokens, fold and sentences; high for number formatting if ignored | §1.8 rules + G1 exact goldens; boot probe of the device's FTS5 tokenizer |
| Float and RNG differences in analysis | certain at ulp level | tolerance contracts (§2.4) on invariants, not raw arrays; `mulberry32` bit-exact |
| Port scope (≈ 40k lines) slips | high | phased plan (§8) where every milestone runs on the phone; read path ported against snapshots before ingest exists; stubs + `MockAtlas` keep the app runnable |
| Main-thread stalls from `nonisolated(nonsending)` defaults | medium | rule 2 of §1.2 + `EngineAssert.offMain()` + UI journey test |
| Jetsam / thermal during heavy jobs | medium | `MemoryBudget`, thermal gate, Mac-built layers by default, background refusal for heavy analysis |
| D17 broken by packs merged after views exist | high if naïve | layer id policy + log renumbering (§3.3); a dedicated test: save a view → apply L4 → the as-saved counts are unchanged |
| Device SQLite differs from the SDK's | low | boot probe; refuse with an explanation |
| Contract drift (Node keeps changing while Swift ports it) | medium | goldens pinned to a reference commit; contract 1.3.0 frozen for the port; reference changes only through diff-test findings |
| `xcodebuild` hangs in iCloud; agents collide on build dirs | known | `Tools/build.sh` mirror with `SCROLLS_BUILD_DIR` per agent |
| App size / install time during development | medium | starter ≈ 13 MB (L0 4 MB + L1 sources 9 MB); the atlas is never bundled |

**Cut from v1** (stated as unfinished, as SPEC §14 does):
1. The portable HTML bundle export (PNG/SVG/JSON/CSV/notebook exports stay).
2. The global reuse index on the phone (it runs in the atlas build; the targeted trace ships).
3. S3 meta slimming (−218 MB).
4. The share extension (document types cover "Open in Scrolls").
5. Universal Links.
6. Building STEMM layers on the phone from raw fetches (the fetchers stay Node on the Mac; the phone takes source packs).
7. Tone beyond English (Apple's on-device models; labelled).
8. Multi-device sync.

**Deferred inside v1's order, not cut:** convergence, the two-period constellation, the folded overview and the Term trail come in M4 after the core is solid.

---

## 8. Build plan for parallel agents

**Rules** (carried over from SPEC §12 and adapted):
- No file has two owners. A package changes only its own files and talks to others only through frozen contracts.
- A contract change goes to the N0 owner, is made additively, is recorded in the per-WP notes file, and every golden is regenerated in one commit.
- **Agents cannot create new `.md` files.** The lead pre-creates these placeholders, each with an `<!-- OWNER: … -->` header:
  - `Native/README.md` [N8]
  - `Native/Docs/ARCHITECTURE.md` [N0]
  - `Native/Docs/DIFFERENTIAL.md` [N0]
  - `Native/Docs/DEVICE-DATA.md` [N2]
  - `Native/Docs/VERIFICATION.md` [N8]
  - `Native/Docs/HANDOFF.md` [N8]
  - `Native/Docs/wp/N0.md` … `N8.md` (each WP's notes and contract requests)
- Machine-readable reports go to `Native/Reports/*.json` (any agent can create JSON). Fixture folders use `MANIFEST.json`.
- Every package keeps `Tools/check.sh quick` green and runs `full` before declaring done.

### Phase 0 — N0 Foundation (one agent; critical path)

- **Owns**
  - Native scaffolding: `Native/project.yml`, `Native/Tools/*`, `ScrollsKit/Package.swift`.
  - Engine targets: all of `ScrollsCore`, `ScrollsContracts`, `ScrollsStore` (except `Layers/` → N2) and `ScrollsJobs`.
  - Service: `ScrollsService/{AtlasService,LiveAtlas,MockAtlas,Events}.swift`.
  - Goldens: `Native/Golden/{dump-spec.json,dump.mjs,gen-core.mjs,harness/*}` and `Tests/DifferentialTests/Support/*`.
  - App shell: `Scrolls/App/*`, `Scrolls/Design/*`, `Scrolls/Features/FeatureRegistry.swift`.
  - **A stub for every file in the tree**: correct signatures, a `// OWNER: Nx` header, and bodies that throw `ScrollsError.notImplemented(area:)`. Each stub then belongs to its package.
- **Delivers**
  - The schema and device profile, Connection/ReadPool/Writer, `RowIDPolicy`, `TextStore` (Inline + Chunked).
  - JobQueue with `after:`; the Core ports (dates, tokenizer + generated table, fold, ids/JSNumber, vocab, viewstate, format, evidence style).
  - The Contracts for all 65 fixtures with `Gated<T>`, and `MockAtlas`.
  - The LogicalDump (Swift + Node), `check.sh quick`, and an app shell on the simulator browsing MockAtlas data.
- **Frozen at N0 merge:** the Core APIs, Contracts, `AtlasService`, `JobTask`/`JobContext`/`JobType`, the `Connection`/`ReadPool`/`Writer`/`WriteLease` APIs, `RowIDPolicy` + layer constants, `TextStore`, `SourceAdapter`, `Canonical*`, `DisplayList` primitive types (declared in `ScrollsScrollModel/Primitives.swift`, owned by N0), the dump spec and the golden formats.
- **Exit:** all 65 fixtures round-trip; G1 exact for dates, tokenizer, fold, ids, viewstate, vocab and evidence style; `swift test` green on the Mac; the app shell runs in the iPhone 17 Pro simulator and on his iPhone (`build.sh device` + `devicectl install`).

### Phase 1 — seven packages in parallel; each finishes its P1 slice first

| WP | Owns (exclusive) | Consumes | P1 (→ M1) | P2 (→ M2/M3) | Tests (incl. differential) | Acceptance |
|---|---|---|---|---|---|---|
| **N1 Ingest & writer** | `ScrollsIngest/**`, `Scrolls/Features/Import/**`, `Native/Golden/gen-pipeline.mjs` (ingest part), `Tests/ScrollsIngestTests/**` | Core, Store, Jobs, Canonical* | DocumentWriter (ids, chunks, FTS, dates, tags, bins, doc_tokens, minhash), segmenter, langid, TXT/MD/CSV/TSV/JSON/JSONL, sniff/decode, mapping + suggestions, validate dry-run, commit and revert jobs, summary, problems.csv, the wizard | streaming 2 GB, line mode, mapping reuse, near-duplicate resolution UI | G1 segment/langid; G2 mini + ingest fixtures + demo **exact**; malformed-input messages byte-equal | on the simulator and his phone: import `letters.csv` from Files → summary → Open in timeline; a 50 MB CSV dry run ≤ 20 s on the phone |
| **N2 Sources, layers & CLI** | `ScrollsSources/**`, `ScrollsStore/Layers/**`, `ScrollsService/{LiveAtlas+Sources,LayerPipelines}.swift` (layer builds sequence adapters → boilerplate (N5) → spaces (N4); only `ScrollsService` sees every module), `scrolls-cli/**`, `Scrolls/Features/Sources/**`, `Scrolls/Resources/Starter/**`, `Native/Golden/slices.mjs`, `Tests/ScrollsSourcesTests/**` | N0 contracts, DocumentWriter (N1 P1; stubs until then) | demo adapter + L0 starter build; cipher works/themes/roots/siblings (L1) built **on the phone** at first launch; `buildLayer`/`applyLayer` (log renumbering, FTS rebuild); CLI `starter build`, `atlas build/verify`, `dump` | cipher relations (L2), books/Wikisource (L3) with boilerplate (calls N5's pass), the four STEMM adapters (L4–L6), L7 spaces (calls N4), source packs, the Ngram baseline attach | G2 Cipher/STEMM slices **exact**; reconciliation counts (§6.8); G6 device = Mac for L0/L1; the D17 pack test (save view → apply → as-saved unchanged) | his phone: demo < 1 s, L1 ≤ 60 s with chip; the full atlas built on the Mac, moved over Finder, applied, `layers()` lists L0–L7 with matching hashes |
| **N3 Query & exports** | `ScrollsQuery/**`, `ScrollsService/LiveAtlas+{Search,Expressions,Timeline,Passages,Documents,Kwic,Exports}.swift`, `Native/Golden/gen-read.mjs` + `requests/*.json` (timeline/search part), `Tests/ScrollsQueryTests/**` | Store, TextStore, Core | search (typed), expressions + variants (en/fr/es/hi/gu, orthographic), materialize + `expr_doc` + name guard, slice cube, timeline query/tiles/washes/marks/shelves/bin, coverage, seams, passages/documents/KWIC, JSON/JSONL/CSV exports | arcs + summaries (C4), transliteration, the very-frequent path, Term trail (C2), OpenAlex share cells (C3), tag index | G3 on m1 and m5-stemm clones (Swift reading the **reference** database through InlineTextStore); conservation at every tier; offsets 100% exact | on his phone with the full atlas: *virus* search ≤ 100 ms; materialize *bank* ≤ 1 s; every mark of a 20-mark sample opens its passage at exact offsets |
| **N4 Analysis** | `ScrollsAnalysis/**`, `ScrollsNL/**`, `ScrollsService/LiveAtlas+{Compare,Collocations,Clusters,Analysis,Constellation}.swift`, `Native/Golden/gen-analysis.mjs`, `Tests/ScrollsAnalysisTests/**` | Query (expr_doc, cube), Jobs | Compare (coverage, composition, modality, prominence, frequency + CIs, passages, multiplicity, gates + widening suggestions), collocations + keyness, token streams | TF-IDF hash fallback, cooc/PPMI/rSVD on Accelerate, era slices, Procrustes, occurrence vectors, k-means + stability + labels + transitions + convergence, drift, constellation layout, tone + modern-reader neighbours | G3 Compare payloads exact/1e-9; G4 tolerances (§2.4); a gated payload has no number (type and test) | on the phone: Compare ≤ 150 ms; cluster *bank* ≤ 15 s, cancellable within 500 ms; the en space comes from L7 with no on-phone build |
| **N5 Lineage, provenance & user state** | `ScrollsLineage/**`, `ScrollsProvenance/**`, `ScrollsService/LiveAtlas+{Lineage,Genealogy,Relationships,Hypotheses,Trace,Annotations,Views}.swift`, `Tests/ScrollsLineageTests/**`, `Tests/ScrollsProvenanceTests/**` | Store, Query, Analysis (token streams) | annotations (revisions, reinterpret, withdraw, as-of by timestamp, anchors), saved views (immutable, as-saved, drift report), reviews, human proposals, hypothesis groups, **user journal + exporter + replay**, the boilerplate pass (needed by L3) | winnow, near quotes, cues, targeted trace, lineage graph + path + commonplace node, genealogy | G1 minhash/winnow; G2 demo relationships and anchors; G3 lineage/genealogy/views; the "virus canary" (0 `ok` passages with the licence sentence); a replay test (wipe → layers → journal → identical user dump) | on the phone: save view → force quit → reopen byte-identical (`state_hash`); review a relationship (line pattern unchanged); trace a 13-token span ≤ 1.5 s |
| **N6 The Scroll** | `ScrollsScrollModel/**` (except `Primitives.swift`), `Scrolls/Features/Scroll/**`, `Scrolls/Render/**` (Metal, shaders, `CGScrollPainter`, `SVGWriter`), `Scrolls/Features/Tour/**`, `Native/Golden/gen-display.mjs`, `Tests/ScrollsScrollModelTests/**` | Contracts (tiles/marks/arcs), Core (evidence style, dates), `MockAtlas` until N3 lands | scale/tiers/model/display/hit port; Metal renderer for bars, caps, washes, states, coverage track, shelves chips, seam, playhead/play/strict-context, gestures, a11y table, bin drawer, minimap | arcs + bundles + feedback, split/merge glyphs, folded overview, etymology bands + bracket, claim diamonds, baseline track, cluster lanes, share cells, PNG/SVG snapshots, the tour | G5 display lists exact/±0.01 pt; a11y-table identity test; render tests (pixel probes of states and patterns on the CG painter) | his phone: 120 Hz pan/pinch p95 ≤ 8.3 ms on a 20k-cell synthetic tile set (perf HUD); Reduce Motion behaviours; VoiceOver reads a lane summary |
| **N7 Panels** | `Scrolls/Features/{Inspector,Search,Compare,Lineage,Constellation,Notebook,Views,Jobs,Settings,Exports}/**`, `Tests/ScrollsUITests/Panels*` | AtlasService (MockAtlas first), Contracts, Design | search UI, inspector Then/Now/Next + reader + date chip, Compare view + gate cards, views menu (save, open, as-saved banner), jobs tray, exports via ShareLink | lineage explorer, genealogy, constellation, edge card + reviews, notebook + editor + revisions, Crossings card, Sources sheet (with N2) | each panel renders every contract fixture, including gated/empty/error; no numeral under a gate (snapshot text scan); `CopyLint` + MENTAL_STATE_VERBS | simulator + phone: the main flow works one-handed, without hover, in portrait and landscape |

### Phase 2 — N8 Integration and the device (one agent, last; may be the N0 agent)

- **Owns:** `Native/README.md`, `Native/Docs/{VERIFICATION,HANDOFF}.md`, `Scrolls/Features/Diagnostics/**` (self-test screen: G6 hashes, SQLite probe, layer table, perf HUD export), `Tests/ScrollsUITests/Journey*`, `Native/Reports/`.
- **Does:** runs the journey on his iPhone and in the simulator, measures every §5 estimate, and writes HANDOFF in three parts: what works, what needs a pack or source, what is unfinished. File ownership lapses here; every patch is logged (file, reason, test) as in SPEC §12.5.

### Milestones (an app that runs on his phone at every one)

1. **M0** (end of phase 0): the app shell on the phone with MockAtlas data; G1 exact.
2. **M1 — the vertical slice on the device:**
   - the demo opens in < 1 s and L1 builds on the phone in ≤ 60 s;
   - import a CSV from Files → search → the Scroll with honest bars, washes, shelves, coverage and seam → tap a mark → the passage at exact offsets;
   - Compare with coverage, frequency and gates → save the view → force quit → reopen it identical;
   - gates: G2 (mini, ingest, demo, L1 slices) and G3 on m1.
3. **M2 — the full atlas and lineage:**
   - the CLI builds L2–L7 and the pack moves over Finder and applies on the phone;
   - G3 passes on m5-stemm;
   - arcs, genealogy (*Funky Drummer*: 32 / 98 / 48 works over 3 generations), targeted trace, reviews;
   - the D17 pack test passes.
4. **M3 — analysis:** clusters (Cipher *bank*: the reference's two groups, 'money · account · notes · mr' and 'river · along · water · stream', within the §2.4 tolerances), vectors from L7, drift, collocations, the constellation and the notebook with as-of; G4 within tolerances.
5. **M4 — polish:**
   - Term trail, folded overview, baseline, claims, etymology bands, the tour;
   - an accessibility audit (VoiceOver, Dynamic Type, Reduce Motion, Differentiate Without Colour);
   - performance measured on his iPhone 15 Pro Max and recorded in VERIFICATION;
   - HANDOFF written.

---

*Guiding principle, kept for the port: an expression carries its past into each new encounter. Here every number on the phone has to carry its past too: the reference computation it equals, the tolerance it was checked against, and the layer it came from.*
