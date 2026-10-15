<!-- OWNER: experience architect (iOS proposal round, 2026-10-09). Replaces the lead's placeholder. -->
# Scrolls for iPhone: proposal from the experience side

**Angle.** iPhone experience first: an Apple-platform interaction designer and SwiftUI engineer's proposal for the native port. It covers all eight required areas, and goes deepest on §4 (the phone experience and the first minute) and §4.21 (how the Scroll is rendered, and its frame budgets). SPEC v1.0 still governs semantics, the §3 data model, the §4 algorithms and the §13 honesty rules. Nothing here changes them. Where the phone needs a different *form*, that is stated as a device delta and kept as small as possible.

**What this rests on.** Every number below marked **(measured)** was measured on 2026-10-09 on this Mac (M1 Max, Darwin 27.2), against the m5-stemm snapshot opened read-only (`?mode=ro&immutable=1`) with `/usr/bin/sqlite3` 3.54.0, or with small `xcrun swiftc -O` probes in the scratchpad. The iOS 27 SDK in `Xcode-beta.app` was also checked: it ships `sqlite3.h` 3.54.0, `BGContinuedProcessingTaskRequest` (iOS 26+, with title/subtitle, `strategy` and `requiredResources`, progress through `NSProgressReporting`) and `os_proc_available_memory()`. Its SwiftUICore declares `glassEffect`/`GlassEffectContainer`, and its SwiftUI declares `presentationBackgroundInteraction`, `navigationTransition`/`matchedTransitionSource`, `accessibilityChartDescriptor`, `accessibilityRotor` and `sensoryFeedback`. Numbers marked **(est.)** are planning estimates for the A17 Pro, and WP N0's on-device bench re-measures them.

| Measured fact | Value |
|---|---|
| m5-stemm `scrolls.db` | 3.55 GB: `document_text` 917 MB · `document` 463 MB (of which `original_meta_json` 265 MB) · `passage_fts` 391 + 37 MB · `relationship_revision` 242 MB (595,524 rows) · `passage` 202 MB + 3 indexes 160 MB (2,763,200 rows) · `relationship` 180 MB (593,078) · `doc_tag` 148 + 79 MB (1,690,497) · `date_assertion` 135 MB (881,618) · `label_tri` ≈ 121 MB |
| Corpus | 394,317 documents (62,757 with full text), 145.2 M `doc_tokens` tokens, 1,355,438 FTS terms |
| FTS5 on 3.54 | `virus` 1.3 ms · `zero` 0.2 ms · `"carry the zero"` 5.1 ms · `machine OR machines` 0.9 ms (15,655 passages) · `passage_vocab_inst` term `machine` 1.1 ms · trigram `hack` 0.4 ms |
| Tile SQL | numerator (`expr_doc` ⋈ `doc_bin` ⋈ `document`, *machine*, L2) 4–5 ms; the **denominator by SQL, cold: 3.75 s**. This is why the slice cube must be ported, not replaced by SQL |
| Text compression (120 Gutenberg books, 52 MB) | LZFSE 2.60× whole file, **2.35× in 32 KB chunks**, zlib 32 KB 2.39×, LZMA 64 KB 2.69×; LZFSE decode **50 µs per 32 KB chunk** (656 MB/s) |
| Swift `u61m-1` tokenizer over UTF-16 | **229 MB/s, 40.3 M tokens/s** (60 books, one thread); Foundation `precomposed…lowercased()` fold only 2.4 M tokens/s, so an ASCII fast path is mandatory |
| System SQLite inserts from Swift | 1 M rows into a `WITHOUT ROWID` table with PK + 1 index in one transaction: **2.12 s** |
| CPU raster (Core Graphics, 1290 × 2796 px = the 15 Pro Max at @3x) | 20,000 rects: **82–115 ms per frame**; 300 dashed quadratic arcs: 9.4 ms. A 120 Hz frame is 8.33 ms |

---

## 0. Decisions in one page

1. **Folder and targets.** All native code goes under `Scrolls/Native/`: an XcodeGen `project.yml`, the `Scrolls` app target (SwiftUI, `SWIFT_DEFAULT_ACTOR_ISOLATION: MainActor`), the `ScrollsKit` package (Foundation + Accelerate + SQLite3 + Compression + NaturalLanguage, no third-party code, `swift test` on the Mac), a `scrolls-cli` Mac executable and `Tools/`. The web build stays where it is as the reference.
2. **No HTTP inside the app.** The 1.3.0 contract becomes Swift `Codable` value types with the same field names. Routes become `async` methods on one `AtlasAPI` protocol. The read pool becomes 3 connection actors, the job queue an actor with real dependencies (`after:`), and cancellation runs through `Task` cancellation plus `sqlite3_interrupt`.
3. **One SQLite schema, the §3 DDL verbatim, plus six small device deltas**: chunked LZFSE text, pointer-only `original_meta_json`, synthesized first revisions for source relationships, pack-backed originals, an applied-op ledger, and derived files outside the database. Expected device atlas: **≈ 2.5 GB** of database, **≤ 3.8 GB in total**, with a **5 GB hard ceiling**.
4. **Data onto the phone.** The demo is bundled prebuilt, so it paints in ≤ 1 s. *Cipher metadata* is bundled as a ≈ 25 MB source pack and **imported on the phone during the first minute** (D10, on device). Full text and STEMM arrive as `.scrollspack` source packs (AirDrop, Finder, Files or `devicectl`) and are **built on the phone** by the same engine, in ≈ 10 min (est.), with checkpoints and system progress UI. A prebuilt atlas from `scrolls-cli` is the developer and recovery path.
5. **The Scroll is drawn with Metal; everything else is SwiftUI.** Geometry lives in *day space*, and the camera, vantage, ghosting and fades are shader uniforms. Pan, pinch, scrub and Play therefore cost **no instance rebuilds**. Only a tier, data or filter change rebuilds the display list, off the main thread. SwiftUI Canvas draws the bounded views (Lineage, Genealogy, Constellation) and the **snapshot renderer** of the same `DisplayList`, so a snapshot always matches the screen.
6. **Portrait first, Maps-style.** The Scroll fills the screen, with one **persistent sheet** at three detents: *peek* (search and transport) · *half* (Then/Now/Next, drawers, results) · *large* (reader, notebook). The timeline stays live behind the half sheet. Landscape gives a wide Scroll with a trailing inspector column. Compare, Lineage, Genealogy, Constellation and Notebook are pushed destinations with zoom transitions from the item they came from.
7. **The gestures are UIKit recognisers** in a host view: direction-locked pan with momentum, x-only pinch around the centroid, tap with an ambiguity chooser, and long-press with a passage *preview* through `UIContextMenuInteraction`. LabKit's `CanvasRegion` is not used; §4.20 says why.
8. **Every honesty encoding of SPEC §1/§8 has a phone form** (the table in §4.7). Hover becomes tap: tapping any bin, gap, wash or arc yields its generated sentence. No pixel goes unexplained just because a phone has no hover.
9. **User state stays in the same SQLite file and the same append-only tables**, so D17 and D18 hold by trigger. Every user act is also written first to a small **`journal.sqlite`** that *is* backed up to iCloud, while the 2.5 GB atlas is excluded from backup. SwiftData is rejected.
10. **The differential tests are generated by the reference.** A new `scripts/golden.mjs` in the web repo writes fixtures in 14 families. Swift compares them exactly where the reference is deterministic (tokens, offsets, dates, bins, tile integers, conservation, contract shapes, display-list geometry) and within stated tolerances where it is numeric. `Native/Tools/ci.sh` prints a PASS/FAIL table.
11. **LabKit is adopted where it fits:** `LabKitFeedback` (the haptic vocabulary), `LabKitCore` (`DeviceConditions`, `FramePacing`, `Throttle`, `CopyLint`) and parts of `LabKitUI` (`StatusBanner`, `ChoiceChips`, `GlassToggle`, `LabInfoSheet`/`FieldNote`/`SourceList`, and one `GlassKnob` for play speed). It is not adopted for `LabKitRender` (a continuous 120 Hz loop is wrong for an idle instrument), `.labChrome`, `Provenance` (a different vocabulary from documented/computed/proposed) or `CanvasRegion`.
12. **v1 cuts:** the portable HTML bundle, the share extension, the Constellation's *split* mode, the global reuse index on the full corpus outside overnight charging, and on-device MusicBrainz. Each is listed with its reason in §7.

---

## 1. Architecture

### 1.1 Folder layout (inside the existing repo; the web build is untouched)

```
Scrolls/                                  ← existing repo root (git dir: ~/Developer/git/Scrolls.git)
├── server/ src/ tests/ scripts/ …        ← the web build: REFERENCE IMPLEMENTATION (unchanged, plus scripts/golden.mjs)
└── Native/
    ├── project.yml                       ← XcodeGen, iOS 27, Swift 6, team YOUR_TEAM_ID
    ├── Scrolls/                          ← app target (MainActor by default)
    │   ├── App/        ScrollsApp.swift AppModel.swift Routes.swift LaunchArgs.swift BackgroundTasks.swift
    │   ├── Shell/      RootView.swift PersistentSheet.swift TopBar.swift StrandChips.swift StatusChip.swift
    │   │               SyntheticRibbon.swift Pills.swift LandscapeShell.swift MoreMenu.swift
    │   ├── Scroll/     ScrollModel.swift ScrollCanvas.swift ScrollGestureHost.swift ScrollRenderer.swift
    │   │               LabelAtlas.swift Shaders/Scroll.metal Shaders/ScrollShaderTypes.h
    │   │               LaneHeaders.swift Ruler.swift Minimap.swift Playhead.swift Transport.swift
    │   │               AmbiguityChooser.swift MarkPreview.swift BinDrawer.swift ShelfList.swift
    │   │               ScrollAccessibility.swift ScrollTableView.swift PerfHUD.swift
    │   ├── Inspector/  InspectorView.swift ThenView.swift NowView.swift NextView.swift CrossingsCard.swift
    │   │               PassageText.swift DateChip.swift ReaderView.swift (TextKit 2)
    │   ├── Search/     SearchField.swift SuggestionList.swift EmptyStateView.swift LanesSheet.swift FiltersSheet.swift
    │   ├── Compare/    CompareView.swift RangeBrush.swift CoveragePanel.swift FrequencyPanel.swift PassagesPanel.swift
    │   │               CollocatesPanel.swift SharesPanel.swift DisplacementPanel.swift TonePanel.swift GateCard.swift
    │   ├── Lineage/    LineageView.swift LineageCanvas.swift EdgeCard.swift ChainOfCustody.swift
    │   │               HypothesisGroupCard.swift GenealogyView.swift GenealogyCanvas.swift
    │   ├── Constellation/ ConstellationView.swift ConstellationCanvas.swift LegendBar.swift
    │   ├── Notebook/   NotebookView.swift AnnotationEditor.swift RevisionScrubber.swift AsOfSlider.swift
    │   │               InterpretationColumns.swift MachineAnnotations.swift
    │   ├── Views/      SavedViewsSheet.swift DeepLinks.swift SnapshotRenderer.swift ShareItems.swift
    │   ├── Import/     ImportWizard.swift FileStep.swift MappingStep.swift ValidateStep.swift CommitStep.swift
    │   │               PacksView.swift StorageView.swift
    │   ├── Tour/       TourDirector.swift CoachMark.swift YourTurnCard.swift
    │   ├── Settings/   HowScrollsWorks.swift SettingsView.swift SelfTest.swift
    │   └── Resources/  Assets.xcassets  Info.plist  Scrolls.entitlements
    │                   Bundled/demo.atlas.sqlite  Bundled/tour.json  Bundled/cipher-meta.scrollspack
    ├── ScrollsKit/
    │   ├── Package.swift                 ← owned by the integrator (N0); WPs edit only their own target block
    │   ├── Sources/
    │   │   ├── ScrollsCore/        Dates.swift Tokenizer.swift Fold.swift Vocab.swift IDs.swift Format.swift
    │   │   │                       EvidenceStyle.swift Palette.swift ViewState.swift Copy.swift
    │   │   │                       Contracts/*.swift (Codable 1.3.0 shapes)
    │   │   ├── ScrollsStore/       Connection.swift Statement.swift StatementCache.swift ReadPool.swift Writer.swift
    │   │   │                       Schema.swift schema.sql device-deltas.sql Migrate.swift SeedVocab.swift
    │   │   │                       TextStore.swift SourceStore.swift Integrity.swift Probe.swift AtlasLocation.swift
    │   │   ├── ScrollsText/        Segment.swift LangID.swift Names.swift Variants.swift Translit.swift KWIC.swift
    │   │   │                       Resources/stopwords/*.json
    │   │   ├── ScrollsIngest/      Decode.swift Sniff.swift CSV.swift JSON.swift JSONL.swift TXT.swift MD.swift
    │   │   │                       FrontMatter.swift Mapping.swift Validate.swift Suggest.swift Summary.swift
    │   │   │                       Dedupe.swift DupIndex.swift DocumentWriter.swift Bins.swift ImportPipeline.swift
    │   │   ├── ScrollsAdapters/    AdapterAPI.swift Registry.swift Packs.swift Demo.swift
    │   │   │                       Cipher/{Books,GutenbergText,Wikisource,Works,Siblings,Relations,Roots,Themes,TagsProvenance}.swift
    │   │   │                       STEMM/{GutenbergSTEMM,OpenAlex,Wiktionary,Ngram,FieldMap,Translation}.swift
    │   │   ├── ScrollsQuery/       Cube.swift CollStats.swift Scope.swift Lanes.swift Materialize.swift ExprDoc.swift
    │   │   │                       FTS.swift Tiles.swift Washes.swift Marks.swift Arcs.swift Shelf.swift Coverage.swift
    │   │   │                       Seams.swift Trail.swift TagIndex.swift ClusterLanes.swift Search.swift Rates.swift
    │   │   │                       ArtifactCache.swift Warm.swift
    │   │   ├── ScrollsAnalysis/    Stats.swift Intervals.swift Bootstrap.swift PRNG.swift Collocations.swift Keyness.swift
    │   │   │                       Composition.swift Multiplicity.swift Gates.swift TokStream.swift Cooc.swift PPMI.swift
    │   │   │                       RSVD.swift Procrustes.swift LinAlg.swift TFIDFHash.swift OccVec.swift KMeans.swift
    │   │   │                       Stability.swift Labels.swift Transitions.swift Convergence.swift Slices.swift
    │   │   │                       Drift.swift Compare.swift Tone.swift BaselineRho.swift Layout.swift
    │   │   ├── ScrollsLineage/     Winnow.swift MinHash.swift Near.swift Exact.swift Align.swift Boilerplate.swift
    │   │   │                       Commonplace.swift Cues.swift CueLinks.swift Classify.swift Trace.swift Graph.swift
    │   │   │                       Path.swift Genealogy.swift Hypotheses.swift Filters.swift Carry.swift
    │   │   ├── ScrollsProvenance/  Anchors.swift Annotations.swift Relationships.swift Reviews.swift Views.swift
    │   │   │                       Journal.swift Export/{Manifest,CSV,JSONL,Bundle}.swift
    │   │   ├── ScrollsTimeline/    TimeScale.swift Folded.swift Tiers.swift LaneLayout.swift Model.swift
    │   │   │                       DisplayList.swift DisplayBuilder.swift ArcGeometry.swift HitGrid.swift
    │   │   │                       A11ySummary.swift LaneSeries.swift SVGWriter.swift DisplayListCanvas.swift
    │   │   ├── ScrollsEngine/      AtlasAPI.swift Atlas.swift PreviewAtlas.swift JobQueue.swift JobContext.swift
    │   │   │                       Tasks/*.swift BootstrapCipher.swift PackBuilder.swift Health.swift
    │   │   └── scrolls-cli/        main.swift  (build-demo · pack · build-atlas · golden-check · bench · verify)
    │   └── Tests/  <Target>Tests/…   Fixtures/golden/<family>/…   Fixtures/contract/ (copied from tests/contract)
    ├── Tools/   build.sh  ci.sh  golden.sh  packs.sh  push-packs.sh  device-check.sh
    └── Docs/    (pre-created placeholders, §8.4)
```

### 1.2 Package and targets

```swift
// swift-tools-version: 6.4          (iOS 27 / macOS 27 platform enums need 6.4, as LabKit notes)
let package = Package(
  name: "ScrollsKit",
  platforms: [.iOS(.v27), .macOS(.v27)],
  products: [.library(name: "ScrollsKit", targets: ["ScrollsEngine", "ScrollsTimeline"]),
             .executable(name: "scrolls-cli", targets: ["scrolls-cli"])],
  targets: [
    .target(name: "ScrollsCore"),                                                // nonisolated, Foundation only
    .target(name: "ScrollsStore", dependencies: ["ScrollsCore"], resources: [.copy("schema.sql"), .copy("device-deltas.sql")],
            linkerSettings: [.linkedLibrary("sqlite3")]),
    .target(name: "ScrollsText", dependencies: ["ScrollsCore"], resources: [.copy("Resources/stopwords")]),
    .target(name: "ScrollsIngest", dependencies: ["ScrollsStore", "ScrollsText"]),
    .target(name: "ScrollsAdapters", dependencies: ["ScrollsIngest"]),
    .target(name: "ScrollsQuery", dependencies: ["ScrollsStore", "ScrollsText"]),
    .target(name: "ScrollsAnalysis", dependencies: ["ScrollsQuery"], swiftSettings: opt),      // Accelerate, NaturalLanguage
    .target(name: "ScrollsLineage", dependencies: ["ScrollsQuery", "ScrollsAnalysis"], swiftSettings: opt),
    .target(name: "ScrollsProvenance", dependencies: ["ScrollsQuery"]),
    .target(name: "ScrollsTimeline", dependencies: ["ScrollsCore"]),            // pure; no SQLite; testable on Mac
    .target(name: "ScrollsEngine", dependencies: ["ScrollsAdapters", "ScrollsQuery", "ScrollsAnalysis",
                                                  "ScrollsLineage", "ScrollsProvenance"], swiftSettings: opt),
    .executableTarget(name: "scrolls-cli", dependencies: ["ScrollsEngine", "ScrollsTimeline"], swiftSettings: opt),
    // one .testTarget per library target, resources: [.copy("../Fixtures")]
  ],
  swiftLanguageModes: [.v6])
let opt: [SwiftSetting] = [.unsafeFlags(["-O"], .when(configuration: .debug)),           // Loom rule: Debug engines need -O
                           .unsafeFlags(["-Xcc", "-DACCELERATE_NEW_LAPACK"])]
```

Package targets stay nonisolated (the default). The app sets `SWIFT_DEFAULT_ACTOR_ISOLATION: MainActor`, so its data types that cross to engine tasks are declared `nonisolated struct … : Sendable` (the convention Loom and LabKit already use).

### 1.3 Concurrency: the read pool, writer and jobs become actors

```swift
// ScrollsStore — connection confinement: a Connection never leaves the actor that owns it.
public final class Connection {                       // not Sendable
  public init(path: String, readOnly: Bool, cacheMB: Int = 32, mmapMB: Int = 256) throws(StoreError)
  public func statement(_ sql: StaticString) throws(StoreError) -> Statement      // LRU cache keyed by SQL pointer, 128 entries
  public func statement(dynamic sql: String) throws(StoreError) -> Statement      // for IN-lists; cached by string, 64 entries
  public func transaction<T>(_ kind: TxKind = .immediate, _ body: () throws -> T) throws -> T
  public nonisolated func interrupt()                 // sqlite3_interrupt: the one call that is thread-safe
}
public actor ReadConnection { public func run<T: Sendable>(_ body: (Connection) throws -> T) throws -> T }
public final class ReadPool: Sendable {               // 3 read-only WAL connections (2 P-cores + 4 E-cores on A17 Pro)
  public init(path: String, size: Int = 3) throws
  public func read<T: Sendable>(_ label: StaticString, deadline: Duration = .seconds(5),
                                _ body: @Sendable (Connection) throws -> T) async throws -> T
}   // least-busy connection; Task cancellation or deadline → interrupt() → StoreError.interrupted (UI: QUERY_TIMEOUT copy)
public actor Writer {                                  // D11: one writer at a time
  public func write<T: Sendable>(_ label: StaticString, _ body: (Connection) throws -> T) throws -> T   // BEGIN IMMEDIATE
  public func bulk(commitEvery docs: Int = 5_000, rows: Int = 50_000) -> BulkSession
}
```

PRAGMAs are those of §3 (`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `temp_store=MEMORY`), plus `cache_size=-32768` and `mmap_size=268435456` per connection. The WAL policy follows §4.12: autocheckpoint off during bulk phases, then `wal_checkpoint(TRUNCATE)`, and a pause when the WAL passes 1 GB. Interactive writes from UI acts (annotations, reviews, views) go through `Writer.write` in short transactions. The web build's "second write in one request keeps the 5 s busy-wait" problem cannot occur here, because a user act is a single `write` closure.

```swift
// ScrollsEngine — jobs (replaces queue.mjs + worker threads + SSE)
public protocol JobTask: Sendable {
  static var type: JobType { get }                    // vocab.JOB_TYPES codes, unchanged
  static var writes: Bool { get }                     // holds the Writer only for its commits
  static var peakBytes: Int { get }                   // admission control against os_proc_available_memory()
  func run(_ ctx: JobContext) async throws -> RunID?
}
public struct JobContext: Sendable {
  public let reads: ReadPool; public let writer: Writer; public let jobID: JobID
  public func progress(_ fraction: Double, phase: String, message: String, counts: [String: Int] = [:])
  public func checkpoint() throws                      // ≤ every 200 ms of work; throws CancellationError (§4.12)
}
public actor JobQueue {
  public func enqueue<T: JobTask>(_ task: T, after: [JobID] = [], priority: Int = 5) throws -> JobID   // fixes HANDOFF: dependencies
  public func cancel(_ id: JobID)                       // acknowledged ≤ 500 ms; run → cancelled; rows invisible (visibility rule)
  public nonisolated var events: AsyncStream<JobEvent> { get }                                       // replaces SSE
}
```

Parallel cores (k-means restarts, co-occurrence shards, winnowing by language) use `withThrowingTaskGroup` capped at `ProcessInfo.activeProcessorCount − 1`. Each child calls `ctx.checkpoint()`. Jobs are persisted in the §3 `job` and `job_event` tables exactly as on the web, so boot recovery (running → interrupted) is the same code.

### 1.4 The in-process API (routes become methods; the HTTP contract becomes value types)

```swift
public protocol AtlasAPI: Sendable {
  func health() async -> Health
  func corpora() async throws -> [CorpusInfo]
  func facets(_ f: FilterSpec) async throws -> FacetsResponse
  func search(_ r: SearchRequest) async throws -> SearchResponse
  func track(_ r: TrackRequest) async throws -> TrackResponse                          // POST /api/expressions
  func patchVariants(_ id: Int64, _ p: VariantPatch) async throws -> TrackResponse
  func registerTimeline(_ q: TimelineQuery) async throws -> TimelineQueryResponse      // queryKey, lanes, extent, seams
  func tiles(_ r: TilesRequest) async throws -> TilesResponse
  func marks(_ r: MarksRequest) async throws -> MarksResponse                          // ≤ 4,000
  func arcs(_ r: ArcsRequest) async throws -> ArcsResponse                             // ≤ 300 + bundles
  func shelf(_ r: ShelfRequest) async throws -> ShelfResponse
  func bin(_ r: BinRequest) async throws -> BinResponse                                // drawer pages of 50
  func passage(_ id: Int64, context: Bool) async throws -> PassageResponse
  func document(_ id: Int64) async throws -> DocumentResponse
  func documentText(_ id: Int64, from: Int, to: Int) async throws -> DocumentTextResponse   // ≤ 20k UTF-16 units
  func kwic(_ r: KWICRequest) async throws -> KWICResponse
  func compare(_ r: CompareRequest) async throws -> CompareResponse
  func collocations(_ r: CollocationsRequest) async throws -> CollocationsResponse
  func clusters(_ r: ClustersRequest) async throws -> ClustersResponse
  func constellation(_ r: ConstellationRequest) async throws -> ConstellationResponse
  func lineage(_ r: LineageRequest) async throws -> LineageResponse
  func lineagePath(from: NodeRef, to: NodeRef) async throws -> LineagePathResponse
  func genealogy(_ r: GenealogyRequest) async throws -> GenealogyResponse
  func relationship(_ id: Int64) async throws -> RelationshipResponse
  func perform(_ act: UserAct) async throws -> UserActResult                           // every user write (§6)
  func annotations(_ q: AnnotationQuery) async throws -> [AnnotationResponse]
  func view(_ slug: String) async throws -> SavedViewResponse
  func trace(_ r: TraceRequest) async throws -> TraceResponse                          // ≤ 1.5 s, else a job
  func baseline(word: String) async throws -> BaselineResponse
  func export(_ r: ExportRequest) async throws -> ExportFiles
  var imports: any ImportAPI { get }
  var packs: any PackAPI { get }
  var jobs: JobQueue { get }
}
public struct Atlas: AtlasAPI { … }            // the real engine over ReadPool + Writer + JobQueue
public struct PreviewAtlas: AtlasAPI { … }     // replaces server/http/mock.mjs: answers from tests/contract/*.json (SwiftUI previews, UI tests)
```

Every response type is `Codable` with `CodingKeys` that spell the contract's snake_case names. Each carries `provenance` (`data_version`, `run_ids`, `tokenizer: "u61m-1"`, `segmenter`, `synthetic`, `collections`, `licenses`) and `synthetic` wherever the contract has it. Gates are values, not errors: a gated measure decodes to `Gated<T>` with `.gate(code:, needed:, have:, suggestion:)`, and that type has no numeric accessor (§13.7 holds in the type system as well as in the DB CHECK).

### 1.5 Port map (JS reference → Swift)

Status: **P** ported, same algorithm and same outputs, checked by golden tests · **R** re-designed for the phone, same semantics · **D** dropped.

| Reference (lines) | Swift | Status | Notes |
|---|---|---|---|
| `src/shared/dates.mjs` (729) | `ScrollsCore/Dates.swift` | P | Integer day arithmetic only; `Int32` days, astronomical years; never `Calendar` for years 0–99 (§13.18) |
| `src/shared/tokenize.mjs` (128) | `Tokenizer.swift`, `Fold.swift` | P | Scans `UnsafeBufferPointer<UInt16>`, so offsets are UTF-16 natively (D4 = `NSRange`). ASCII fast path; non-ASCII → NFC → `lowercased()` → digit folds → strip ZWNJ/ZWJ/SHY |
| `vocab.mjs`, `ids.mjs`, `format.mjs` (790) | `Vocab.swift`, `IDs.swift`, `Format.swift` | P | Format strings ported verbatim, not through `NumberFormatter`, so the text matches ("4.1M tokens") |
| `contracts.mjs` (818) | `Contracts/*.swift` | R | Shapes as `Codable` types; the 60 `tests/contract/*.json` fixtures must round-trip |
| `viewstate.mjs` (611) | `ViewState.swift` | P | The same hash grammar (`#v=1&c=demo&s=e12…`), so a web link and a phone link are interchangeable |
| `evidence-style.mjs` (141) | `EvidenceStyle.swift` | P | Still the **only** evidence → style map. It yields dash arrays, endpoint kinds, badges and role hues; Metal (as pattern ids), Canvas, SVG and the legend all read it |
| `server/db/*` (open, migrate, schema.sql, seed-vocab, integrity: 1,190) | `ScrollsStore/*` | P/R | DDL verbatim plus `device-deltas.sql` (§3.2); `Probe.swift` checks compile options at first launch (FTS5, RTREE, JSON1, `contentless_delete`) |
| `readpool.mjs`, `readworker.mjs` (168) | `ReadPool.swift` | R | Actors instead of worker threads; the 5 s deadline becomes `sqlite3_interrupt` |
| `server/http/*` (1,130) | — / `PreviewAtlas` | D / R | No server, origin checks, ETag or SSE in-process. The mock becomes `PreviewAtlas` |
| `server/routes/*` (31 files, 3,346) | `Atlas.swift` + one `Atlas+<Area>.swift` per route file | R | Same request/response shapes |
| `server/jobs/*` (queue, context, rows, worker: 921) | `JobQueue.swift`, `JobContext.swift` | R | `after:` dependencies; analysis jobs hold the writer only while committing |
| `server/jobs/tasks/*` (19 files, 3,186) | `ScrollsEngine/Tasks/*.swift` | P | `bootstrap-cipher` R: its phases read packs instead of `SCROLLS_CIPHER_ROOT` |
| `server/ingest/*` (13 files, 3,620) | `ScrollsIngest/*` | P | windows-1252 decode table ported; `problems.csv` via the share sheet |
| `server/store/document-writer.mjs`, `dup-index`, `bins` (1,638) | `DocumentWriter.swift`, `DupIndex.swift`, `Bins.swift` | P + Δ | Writes `text_chunk` (Δ1) and pointer metadata (Δ2); `is_synthetic` propagation unchanged |
| `server/text/*` (segment, langid, names, variants, translit, kwic: 1,463) | `ScrollsText/*` | P; segment **R** | `Intl.Segmenter` sentence splitting becomes ICU through `CFStringTokenizer(kCFStringTokenizerUnitSentence)` plus `।`/`॥`. Parity is measured, not assumed (§2.3) |
| `server/adapters/*` (19 files, 3,709) | `ScrollsAdapters/*` | P | Read packs (`SourceStore`) instead of Cipher/STEMM folders; field taxonomy JSON bundled |
| `server/aggregate/*` (24 files, 6,014) | `ScrollsQuery/*` | P; cube **R** | The cube is a memory-mapped columnar file (`Cube.swift`, the same column set as `CUBE_VERSION` 4); `cache.mjs` → `ArtifactCache`; `warm.mjs` → a launch-time prewarm task |
| `server/analysis/*` (29 files, 9,322) | `ScrollsAnalysis/*` | P; linalg **R** | `linalg`/`rsvd`/`procrustes` → Accelerate (`cblas_sgemm`, Sparse BLAS `SparseMultiply`, LAPACK `sgesdd`); `kmeans-pool` → TaskGroup; `tone` → in-process `NLTagger`; PRNGs ported bit-exact (mulberry32, seeds) |
| `server/lineage/*` (18 files, 3,415) | `ScrollsLineage/*` | P | Winnowing radix sort on `UnsafeMutableBufferPointer<UInt64>` |
| `server/provenance/*` (5 files, 1,753) | `ScrollsProvenance/*` + `Journal.swift` | P + new | The journal is new (§6) |
| `server/export/*` (649) | `Export/*` | P | HTML bundle in M4 |
| `src/ui/timeline/{scale,folded,tiers,model,display,arcs geometry,arc-summary,hit,a11y-table,svg}` | `ScrollsTimeline/*` | P | The display-list builder is pure Swift and gets golden tests against `model.mjs`/`display.mjs` |
| `src/ui/timeline/{paint,viewport,input,gestures,playhead,minimap,shelves,perf,snapshot}` | `Scroll/*` (app) | R | Metal, UIKit gestures and SwiftUI chrome; snapshot through `DisplayListCanvas` + `ImageRenderer` |
| `src/ui/{panels,shell,import,tour}` (≈ 12k) | app SwiftUI folders | R | Same copy strings, linted |
| `tools/nl-adapter` | — | D | NaturalLanguage runs in-process |
| `tools/fetch/*` | stay Node, Mac only | D (phone) | §13.16: network fetchers remain scripts the user runs; `scrolls-cli pack` packs their output |
| `scripts/{bench,verify,bootstrap-cipher,build-demo}` | `scrolls-cli bench / verify / build-atlas / build-demo` | R | `check-demo-names.mjs` stays Node (MusicBrainz tables are Mac-only) |

### 1.6 What stays identical, and what changes on the phone

**Identical (a golden test or the DDL enforces each):** the §3 DDL with every CHECK and trigger; both FTS5 tokenizers (`unicode61 remove_diacritics 2 categories 'L* N* Co M* So'` and `trigram remove_diacritics 1`); tokenizer `u61m-1` and its fold; the date grammar and `LEVELS`; fit-or-wash; the conservation law; every gate and threshold of §4.11; every algorithm and parameter of §4 (k = 8, w = 6, 128 permutations, d = 256, seed 42, 30 subsamples, 1,000 bootstrap resamples, 500 controls…); the evidence vocabulary and styles; the view-state grammar; the contract shapes; the UI copy (each string ported verbatim and linted, §4.18).

**Different, and recorded on every run (§13.17):** `icu_version` holds `"ios<os version>/unicode-<N>"`: the OS version, plus the Unicode version found by a canary probe of `Unicode.Scalar.Properties.age` over recently assigned code points. On the phone `segmenter_version` is `seg-1` only if the parity test passes, and `seg-1i` otherwise (§2.3). Transport, concurrency, text storage and rendering also differ.

---

## 2. Differential testing against the Node reference

### 2.1 Fixtures are generated by the reference

There is one new reference script, `scripts/golden.mjs`. It is a `.mjs` file, which agents may create. It imports the reference modules directly (not over HTTP) and boots private temp databases cloned with `cp -c` from `~/Developer/scrolls-snapshots/m1` (demo checks) and `m5-stemm` (Cipher/STEMM slices). It never touches `~/Developer/scrolls-data`. Node runs through the known workaround (`DYLD_LIBRARY_PATH=/opt/homebrew/Cellar/simdjson/4.6.11/lib:/opt/homebrew/Cellar/hdrhistogram_c/0.11.10/lib`, read from `$SCROLLS_NODE_ENV` in `Tools/golden.sh`). Output goes to `Native/ScrollsKit/Tests/Fixtures/golden/<family>/*.jsonl`, plus `MANIFEST.json`: `{reference_commit, node, icu, unicode, generated_at, families: {name: {cases, sha256}}}`.

| # | Family | Reference module(s) | Inputs | Compared | Rule |
|---|---|---|---|---|---|
| G1 | tokenize | `tokenize.mjs` | 6,000 strings: random passages from all 5 languages + an edge list (emoji ZWJ sequences, ◉ vs ⊙, Gujarati/Devanagari digits, combining marks, surrogate pairs, Greek final sigma, `İ`, U+00AD, BOM) | spans `[start,end)` (UTF-16), folded norm, `normString` | exact |
| G2 | dates | `dates.mjs` + IMPORT-SCHEMA grammar | 2,500 raw strings (every `tests/dates.test.mjs` case, all Cipher year forms, Vikram Samvat, circa, BCE, ranges, invalid) + exhaustive `binOf/fits/tierForPpy/yearLabel` sweeps | `{lo_day, hi_day, y_lo, y_hi, precision, basis, approx, rule, label}` | exact |
| G3 | viewstate | `viewstate.mjs` | 500 random states (seeded) + every hash in `tests/viewstate.test.mjs` | `encode`, `decode(encode)`, canonical form | exact |
| G4 | text | `segment.mjs`, `langid.mjs` | 60 documents (20 en Gutenberg incl. verse, 10 fr, 10 es, 10 hi, 10 gu Wikisource) | passages `[start,end,unit,quality,lang,page_no]`, `doc lang_text`, `is_translation` | exact; segmentation see §2.3 |
| G5 | variants · names · translit | `variants.mjs`, `names.mjs`, `translit.mjs` | 3,000 words per language; 2,000 name-guard contexts (incl. *The Brimming Cup* 'Gene) | variant lists with rules; `name_flag`; `romanKey` | exact |
| G6 | ingest | `server/ingest/*` | every file under `tests/fixtures` (malformed ones too) | sniff result, mapping suggestion, `import_issue` rows (code, line, col), summary object | exact |
| G7 | writer | `document-writer.mjs` | demo + a Cipher slice (40 fixed Gutenberg ids, 5,000 culture-work rows 0–4,999, 2,000 relation rows, 10 hi + 10 gu books) | per document: `doc_tokens`, `doc_bin`, chronology fields, `original_sha256`; relationships with evidence status; integrity counts | exact |
| G8 | materialize | `materialize.mjs`, `exprdoc.mjs` | 12 expressions (*virus, zero, machine, gene, quantum, algorithm, war, love, शून्य, શૂન્ય, carry the zero, ◉*) on the slice | `expr_doc` rows `(expr, doc, plang, field_class, n, n_names, n_passages, first_off)`; occurrence offsets | exact |
| G9 | tiles | `tiles.mjs`, `cube.mjs`, `washes.mjs`, `shelf.mjs`, `trail.mjs` | the 12 expressions × tiers L0–L5 × facets {domain, language, kind, collection, community} × toggles {default, tr1, est0} | cell tuples: `bin, n, docs, authors, denom, state, flags` exact; `rate, ci_lo, ci_hi, dp` relative 1e-9; washes, shelves; **conservation recomputed independently** | exact / 1e-9 |
| G10 | stats | `intervals`, `bootstrap`, `collocations`, `keyness`, `composition`, `multiplicity`, `gates` | seeded synthetic tables + the demo Compare inputs | Garwood, Wilson, G², logDice, PPMI, BH-q, JSD, Gries DP, bootstrap index streams, gate payloads with suggestions | streams exact; reals 1e-9 |
| G11 | clustering | `tfidf-hash`, `occvec`, `kmeans`, `stability`, `labels`, `transitions`, `convergence` | demo *carry the zero*, *flux up*; the convergence pair | k, assignments up to permutation, stability, labels, transitions | k exact; ARI ≥ 0.99; reals 1e-6; labels exact |
| G12 | spaces | `cooc`, `ppmi`, `rsvd`, `procrustes`, `drift` | a 20k-type × 2k-context PPMI fixture from 6 M English tokens; the drift fixture | singular values; subspace angle; top-25 neighbours; controls percentile | σ rel 1e-4; angle ≤ 1e-3 rad; neighbour overlap ≥ 0.96; percentile ± 1 |
| G13 | lineage | `winnow`, `minhash`, `near`, `exact`, `cues`, `boilerplate`, `graph`, `path`, `genealogy` | the demo + 40 Gutenberg books | fingerprint multisets; A11→A4 (13 tokens) and A20→A3 (15); the cue citation; the boilerplate passage set (the "computer virus" canary); lineage graphs; least-cost paths | exact |
| G14 | display list | `src/ui/timeline/model.mjs`, `display.mjs`, `arcs.mjs`, `arc-summary.mjs`, `a11y-table.mjs` | the G9 tile payloads + arcs for the demo at fixed viewports | bars (`d0, d1`, lane, strand), caps incl. censor chevrons, washes, ticks, arc bundles, a11y rows | exact in day space; pixel positions via `TimeScale` 1e-9 |

Contract shapes are not a generated family: the 60 checked-in `tests/contract/*.json` fixtures are copied in. Every Swift response type must decode its fixture and re-encode JSON that deep-equals the original, ignoring key order (`ContractRoundTripTests`).

### 2.2 How Swift compares

```swift
public enum GoldenRule: Sendable {
  case exact
  case relative(Double)                       // |a − b| ≤ tol · max(1, |b|)
  case partition(minARI: Double)              // cluster assignments up to label permutation
  case subspace(maxAngle: Double)             // principal angle between column spaces
  case topK(k: Int, minOverlap: Double)
}
public struct GoldenFamily<Input: Decodable, Expected: Decodable>: Sendable {
  public init(_ name: String)                 // reads Fixtures/golden/<name>/*.jsonl, checks MANIFEST sha256
  public func check(_ rule: GoldenRule, _ run: (Input) throws -> Expected) throws -> GoldenReport   // reports first 20 diffs
}
```

Tests whose inputs live outside the repo (whole Cipher books, STEMM sources) check the sha256 listed in `MANIFEST.json`. When the source is absent they skip with a message, the same pattern as `npm run test:cipher`. Fixture bytes in the repo stay under 30 MB.

### 2.3 Divergences we expect, and the policy for each

- **Sentence segmentation.** `Intl.Segmenter` (V8 with ICU 78.3) and `CFStringTokenizer` (iOS ICU) may break differently. G4 reports a boundary agreement ratio. At 100% the phone records `seg-1`. Below 100% it records `seg-1i`, and the G7–G9 counts are compared at the levels that segmentation cannot change (document totals: `doc_tokens`, `expr_doc.n` per document, tile cells). Passage ids and offsets are then compared only on documents whose boundaries agree. The Mac CLI and the phone always share the Swift segmenter, so native atlases agree with each other.
- **Unicode version.** Categories of newly assigned code points can differ between Node's ICU and iOS's ICU. G1 lists each mismatched code point, and the run records the Unicode version. Any mismatch outside emoji fails the build.
- **Case mapping.** JS `toLowerCase()` and Swift `lowercased()` are both locale-independent. G1 includes the special cases, so a difference fails loudly instead of silently changing counts.
- **Floating summation order.** Accelerate reorders sums, so reals get tolerances and k-means ties are broken by the reference's index rule, which is ported. PRNG streams, which decide sampling and bootstrap, must match bit for bit.

### 2.4 `Native/Tools/ci.sh` (a CI-like run on the Mac)

```
1  mirror Native/ and the reference to $TMPDIR/ScrollsBuild (rsync; never build inside iCloud)
2  golden.sh --check     : node scripts/golden.mjs --verify (fixtures current vs reference HEAD; --write regenerates)
3  swift test -c release --package-path ScrollsKit   (unit + golden G1–G14 + contract round-trip + CopyLint)
4  swift run -c release scrolls-cli verify --demo    (builds the demo atlas from source, runs the journey of SPEC §11 in-process,
                                                       checks conservation at every tier, 20 random marks → passage offsets)
5  scrolls-cli build-atlas --packs <slice packs> && scrolls-cli verify --atlas … (reconciliation counts vs G7 expectations)
6  xcodegen generate && xcodebuild build -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max'
7  xcodebuild test -only-testing:ScrollsUITests     (first-minute journey with -ui-testing -tour; screenshots to $WORK/shots)
8  print PASS/FAIL table (family · cases · diffs · time) and exit non-zero on any FAIL
```

`Tools/device-check.sh` covers the phone. It installs the Release build with `xcrun devicectl device install app`, launches it with `-selftest journey -perf` (`devicectl device process launch`), waits for `Documents/selftest/result.json`, copies it back with `devicectl device copy from`, and prints the same table plus the device perf signposts. So the device acceptance in §8 is a command, not a manual checklist.

---

## 3. On-device data

### 3.1 Storage budget (from the measured snapshot to the device)

| Item | m5-stemm today | On device | How |
|---|---|---|---|
| `document_text` | 917 MB | **≈ 390 MB** | Δ1: passage-aligned 32 KB LZFSE chunks (2.35×, measured) |
| `document` | 463 MB | **≈ 200 MB** | Δ2: `original_meta_json` becomes a 40-byte pointer (−265 MB) |
| `relationship_revision` | 249 MB | **≈ 1 MB** | Δ3: rev 1 of source and algorithm relationships is synthesized from the relationship row |
| FTS (`passage_fts*`, vocab) | 428 MB | 428 MB | unchanged: `detail=full` is needed for phrases and positions |
| `passage` + 3 indexes | 362 MB | 362 MB | unchanged |
| relationships, tags, dates, `label_tri`, bins, rest | ≈ 1,130 MB | ≈ 1,130 MB | unchanged |
| **Atlas database** | 3.55 GB | **≈ 2.5 GB** | |
| Source packs kept as originals (Δ4) | 1.2 GB `originals/` | ≈ 0.15 GB | metadata files LZFSE in 1 MB seekable frames; book bytes reconstructible from the text (sha-checked) |
| Derived: token streams | — | ≤ 0.6 GB | per language, rebuilt on demand (en ≈ 120 M tokens: u16 ids with escape) |
| Derived: spaces, alignments, reuse runs | — | ≤ 0.4 GB | en pooled space 50k × 256 × 4 B = 51 MB; era slices ≤ 4 × 51 MB |
| Caches (cubes, layout, tiles) | 1.4 GB `cache/` on the Mac | ≤ 0.1 GB | `Library/Caches`, purgeable, rebuilt |
| **Total** | | **target ≤ 3.8 GB · hard ceiling 5 GB** | above 5 GB, heavy derived jobs refuse with the Storage page's breakdown |

The app bundle is ≈ 45 MB: code ≈ 12 MB, `demo.atlas.sqlite` ≈ 4 MB, `cipher-meta.scrollspack` ≈ 25 MB.

### 3.2 Device deltas to the §3 DDL (`device-deltas.sql`, applied after `schema.sql`)

```sql
-- Δ1 text in chunks. document_text keeps every column; `original` is '' when storage='chunked'.
ALTER TABLE document_text ADD COLUMN storage TEXT NOT NULL DEFAULT 'inline' CHECK (storage IN ('inline','chunked'));
CREATE TABLE text_chunk (
  document_id INTEGER NOT NULL REFERENCES document(id), chunk INTEGER NOT NULL,
  start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,     -- UTF-16 units into the decoded original (D4)
  codec TEXT NOT NULL CHECK (codec IN ('lzfse','raw')), bytes BLOB NOT NULL,   -- UTF-8 of [start_off, end_off)
  PRIMARY KEY (document_id, chunk), CHECK (start_off < end_off)) STRICT, WITHOUT ROWID;
-- chunk boundaries are passage boundaries (never inside a surrogate pair); original_sha256 stays the sha of the whole original
-- Δ2 original_meta_json = '{"$src":{"pack":"cipher-meta@1","file":"culture-works.tsv","bytes":[a,b]}}' (json_valid holds)
-- Δ3 relationship_revision: rev 1 is stored only for origin='human'; RelationshipRevisions.list() synthesizes
--    {rev:1, action:'create', actor: created_by, at: created_at} for the others. Triggers unchanged (append-only).
-- Δ4 original_file.rel_path may be 'pack:<pack-id>/<file>'; for book texts the bytes are re-encoded from the text
--    (UTF-8, BOM if had_bom) and the sha256 is checked at build time
-- Δ5 derived/ and cache/ live outside the database (Application Support/Scrolls/derived, Library/Caches/Scrolls)
-- Δ6 the user-act ledger that makes the journal replay idempotent (§6)
CREATE TABLE applied_op (op_uuid TEXT PRIMARY KEY, seq INTEGER NOT NULL, applied_at TEXT NOT NULL) STRICT, WITHOUT ROWID;
```

`TextStore` is the only reader of text:

```swift
public struct TextStore: Sendable {
  public func slice(_ doc: Int64, _ range: Range<Int>, on c: Connection) throws -> String   // decodes only overlapping chunks (≈ 50 µs each)
  public func original(_ doc: Int64, on c: Connection) throws -> String                    // reader, export, anchors
}
```

Materialize decodes each candidate passage's chunk once, through an LRU of 64 decoded chunks. This also removes the web build's main counting cost (HANDOFF: 54% of materialize CPU went on reading whole document texts).

### 3.3 How the atlas gets onto the phone

| Layer | Contents | Size | Arrives by | Built where | When |
|---|---|---|---|---|---|
| Demo | "carry the zero" (228 docs, 64k tokens) with its reuse and cluster runs | ≈ 4 MB | app bundle, prebuilt by `scrolls-cli build-demo` (the same Swift engine) | Mac at build time; the self-test rebuilds it on the phone and compares canonical table checksums | first paint |
| Cipher metadata | `culture-works.tsv`, `culture-themes.tsv`, `roots.tsv`, `relations_{wiki,mb,itwofs,songs}.json`, `gutenberg.json`, `pg_catalog` rows used | ≈ 25 MB packed (≈ 110 MB raw) | app bundle | **on the phone**, D10 phase A | first minute (target ≤ 45 s, budget ≤ 60 s, est.) |
| Cipher text | 691 Gutenberg + 825 Wikisource books | ≈ 190 MB packed (467 MB raw) | `.scrollspack` by AirDrop, Finder file sharing, Files, or `Tools/push-packs.sh` (`devicectl device copy to … --domain-type appDataContainer`) | **on the phone** | ≈ 3–5 min (est.) |
| STEMM | gutenberg-stemm 704 texts, OpenAlex 118,466 works + 381,800 citations, Wiktionary claims, Ngram decade table | ≈ 320 MB packed | same | **on the phone** | ≈ 4–6 min (est.) |
| Prebuilt atlas (developer and recovery path) | the whole atlas | ≈ 2.6 GB | `scrolls-cli build-atlas` → `.scrollsatlas` → AirDrop/devicectl | Mac | the app verifies the manifest and swaps it in; the journal is replayed (§6) |

**Pack format.** A `.scrollspack` is one file: an uncompressed Apple Archive (`AppleArchive`) used only as a container. It holds `MANIFEST.json`, `FORMAT.md` and, for each source file, LZFSE-compressed 1 MB frames plus a frame index, so reading a byte range means decoding one or two frames. The manifest records: `{pack_id, version, adapter_ids, files:[{path, bytes, sha256}], counts, licences, caveats, produced_by: "scrolls-cli <git sha>"}`. `scrolls-cli pack` is the only thing that reads `~/Developer/scrolls-data/sources` or the Cipher folders, and it never writes there.

**Why build on the phone by default.** It proves the port. It transfers ≈ 0.5 GB of packs instead of a 2.6 GB atlas. It needs no Mac for future packs. And the measured parts make it affordable: 40 M tokens/s tokenizing, about 0.5 M rows/s inserting, and FTS at 0.37 s per million tokens (SPEC, measured) give ≈ 1 min of FTS for 145 M tokens on M1 Max-class single-thread speed. Planning factors for the A17 Pro (est., re-measured by N0's bench): single-thread ≈ 1.0× an M1 Max P-core; multi-thread ≈ 0.4× (2 P + 4 E cores); sustained ≈ 0.6× after 2–3 min of load (thermal).

### 3.4 What happens at first launch (the data side of §4.16)

1. `t = 0` Copy `demo.atlas.sqlite` to `Application Support/Scrolls/Atlas/atlas.sqlite` (APFS clone, ≤ 50 ms) and open the read pool. The Scroll queries the demo.
2. `t ≈ 0.3 s` Enqueue `bootstrap-cipher` phase A (`priority 1`, utility QoS) over the bundled pack: culture works, relations, themes and roots, then label trigram rows. The writer commits every 5,000 documents. The UI's read connections keep reading the demo snapshot under WAL with no contention.
3. `t ≈ 45 s` (est.) Phase A commits. `Health.cipher.status` becomes `metadata`, the status chip says "Cipher titles, relations and etymology ready", and the tour's **Switch to Cipher** enables.
4. When no text pack is present, the status chip reads "Cipher full text: not on this phone (pack 190 MB)" and opens the Packs page. It never shows a spinner.

### 3.5 Background work on iOS

| Work | iOS mechanism | Limits handled |
|---|---|---|
| Building a pack the user started (text, STEMM) | `BGContinuedProcessingTaskRequest(identifier: "com.utkarsh.scrolls.continued.<pack>", title: "Building Cipher full text", subtitle: "691 books")`, `strategy = .queue`, progress via the task's `Progress` updated from `JobContext.progress` | Continues when the app is backgrounded and shows system progress UI. On expiration it finishes the current 5,000-document chunk, records a checkpoint (`import_batch` + pack cursor in `meta`) and resumes on the next launch. |
| Heavy derived work: token streams, pooled spaces, era slices, global reuse index, boilerplate re-pass | `BGProcessingTaskRequest(identifier: "com.utkarsh.scrolls.overnight")`, `requiresExternalPower = true`, `requiresNetworkConnectivity = false` | Overnight while charging. The same jobs can be started in the foreground from a gate card ("Build the English space — about 2 min") as continued-processing tasks. |
| Interactive analysis (materialize, Compare, cluster ≤ 10 s, trace) | foreground `Task`s in the JobQueue | Cancelled when the user leaves the view that asked. |

- **Thermal.** `LabKitCore.DeviceConditions` is read every 0.5 s. At `.serious` the JobQueue pauses admissions of `writes` and `peakBytes > 256 MB` jobs and the Scroll caps at 60 fps (`FramePacing`). At `.critical` it cancels running background analysis, which resumes from its checkpoint.
- **Memory.** Plan for a ≈ 3 GB foreground limit on an 8 GB A17 Pro (Apple does not publish it) and add the `com.apple.developer.kernel.increased-memory-limit` entitlement. A job is admitted only if `os_proc_available_memory() − peakBytes ≥ 600 MB`. Declared peaks: winnowing the English token stream ≈ 520 MB (records of 12 B ≈ 0.29 per token); co-occurrence shards 8 × 2²³ slots × 8 B = 512 MB; randomized SVD ≈ 180 MB; the rest ≤ 128 MB. The UI and engine at rest use ≤ 350 MB: SQLite caches 3 × 32 MB, mapped cubes ≈ 30 MB, tiles LRU ≤ 30 MB, Metal ≤ 24 MB.
- **Data protection.** Every Scrolls file uses `NSFileProtectionCompleteUntilFirstUserAuthentication`, never `.complete`, because overnight jobs run while the phone is locked.

### 3.6 Locations and backup

| Path | Contents | Backup |
|---|---|---|
| `Application Support/Scrolls/Atlas/` | `atlas.sqlite` (+wal/shm), `sources/` (packs kept as originals), `originals/` (user imports' bytes) | **excluded** (`isExcludedFromBackup`); rebuildable from packs |
| `Application Support/Scrolls/Notebook/journal.sqlite` | every user act (§6), ≤ 50 MB | **included** |
| `Application Support/Scrolls/derived/` | token streams, spaces, alignments, reuse runs | excluded |
| `Library/Caches/Scrolls/` | cubes, collection stats, layout cache, label atlas | purgeable |
| `Documents/` (visible in Files and Finder: `UIFileSharingEnabled`) | `Inbox/` (dropped packs and imports), `Exports/`, `selftest/` | included (small; packs are deleted from Inbox after a verified build, after asking) |

### 3.7 Imports and exports

- **In.** The wizard's `fileImporter` covers `.plainText`, `.utf8PlainText`, `.commaSeparatedText`, `.tabSeparatedText`, `.json`, `UTType("net.daringfireball.markdown")` and the exported `org.jsonlines.jsonl`. `CFBundleDocumentTypes` (rank Alternate) puts **Open in Scrolls** in every share sheet and in Files. `onOpenURL` copies the file into `Documents/Inbox/` and opens the wizard. Packs (`com.utkarsh.scrolls.pack`, `.scrollspack`) and atlases (`com.utkarsh.scrolls.atlas`) are exported UTTypes that open the Packs page. The original bytes go to `originals/ab/<sha256>` exactly as on the Mac.
- **Out.** `ShareLink` with `Transferable` items: the view link; a PNG snapshot (from `DisplayListCanvas` through `ImageRenderer`, at 3×, with legend, caption and a SYNTHETIC stamp when synthetic material is visible); data files (JSON/JSONL/CSV with the manifest first, `export_text_allowed = 0` respected); `problems.csv`; the notebook export (every revision as JSONL). From M4 also the portable HTML bundle, with the SVG from `SVGWriter` over the same display list.

---

## 4. The iPhone experience

### 4.1 Principles, made concrete

1. **The Scroll is the map; the sheet is the inspector.** This is the Maps / Find My idiom. Portrait has one full-bleed canvas and one persistent bottom sheet, and the user never navigates "away" from the timeline to read evidence.
2. **Thumbs live at the bottom.** On a 6.7" phone, search, Play and Step sit in the sheet's peek row (y ≈ 800–890 pt), within reach without shifting grip. The top carries state you read (strands, corpus, jobs), not controls you hammer.
3. **Glass is chrome; data is opaque.** Liquid Glass is for controls floating over the Scroll. Bars, passage text, gate cards and edge cards sit on opaque `bg-0`/`bg-1`, so evidence is never refracted.
4. **Nothing moves unless the evidence or the user moved it.** No idle animation, no decorative network, no drift of layout. The renderer draws zero frames when nothing changes.
5. **Tap replaces hover, and nothing is lost.** Every state, wash, gap, cap, arc and seam is tappable and answers with its generated sentence (§4.7). That is the phone form of "every pixel answers three questions".
6. **Every count names its denominator, even in the peek row.** "14 in 38,120 tokens", never a bare 14.

### 4.2 Screen map

```
Root (portrait)                                         Root (landscape, compact height)
┌───────────────────────────────────┐                   ┌──────────────────────────────────────────────┐
│ TopBar · Ribbon · Minimap · Ruler │                   │ TopBar(compact) · Minimap · Ruler · Coverage │
│ Coverage                          │                   │ Lane rail │ Scroll (wide)       │ Inspector   │
│ Scroll (lanes, strands, arcs)     │                   │ 120 pt    │                     │ column 360  │
│ ┌─PersistentSheet───────────────┐ │                   │           │                     │ (on select) │
│ │ peek: Search · ▶ · Step · asOf│ │                   └──────────────────────────────────────────────┘
│ │ half: Then|Now|Next · drawers │ │
│ │ large: reader · results       │ │                   Pushed (NavigationStack, zoom transition from source):
│ └───────────────────────────────┘ │                     Compare · Lineage · Genealogy · Constellation · Notebook
└───────────────────────────────────┘                   Modal sheets: Import wizard · Packs & storage · Saved views ·
                                                          Lanes · Filters · Legend · How Scrolls works · Settings · Jobs
```

The Term trail is not a separate screen. It is a lane preset on the Scroll, with the Crossings card in the sheet.

### 4.3 Portrait geometry (iPhone 15 Pro Max: 430 × 932 pt, safe area top 59, bottom 34)

| y (pt) | Region | Contents |
|---|---|---|
| 0–59 | status bar | kept visible (a reading instrument; time awareness), dark |
| 59–103 | **TopBar** 44 | leading: corpus chip ("Demo" + `SYN`, or "Cipher", "STEMM", "All real"); centre: up to 4 strand chips in one `GlassEffectContainer` ("● carry the zero ✕"), morphing in and out with `glassEffectID`; trailing: status chip (a determinate ring with "Cipher 45%") and `⋯` More |
| 103–117 | **SYNTHETIC ribbon** 14 | the striped band "SYNTHETIC DEMONSTRATION CORPUS — invented people, texts, dates and links." while any demo collection is in scope; the text marquee is off, and the label wraps into the More menu at AX sizes |
| 117–141 | **Minimap** 24 | the folded overview, one 3 pt density row per lane group (≤ 5), the modality seam, and a draggable cyan bracket; double-tap = fit data |
| 141–169 | **Ruler** 28 | major ticks ("1850", "500 BCE", "Apr 1931"), the playhead handle "as of 1925" (44 × 44 hit target, extending ±8 pt into neighbours) and the tier pill when the bin changes |
| 169–179 | **Coverage track** 10 | 5-class grey steps, hatched = none, dotted = pending |
| 179–794 | **Lanes** 615 at peek, 287 at half | one lane = 18 pt header strip + n × 24 pt strand slots + 10 pt arc room; a one-strand lane is 52 pt, so 5 lanes fit even at the half detent. The default lane limit is **5** (SPEC narrow); the "+n more lanes" row expands in place up to 10 (the desktop limit), and the lanes then scroll vertically |
| 794–898 | **Sheet, peek detent** 104 | the search field (44) and transport (44): ▶ Play · Step ▸ · "as of 1925" · strict/context eye |
| 898–932 | home indicator | nothing interactive within 12 pt of it |

**Lane header strip (18 pt).** The leading edge holds a sticky label chip that stays put while time pans, e.g. "English · text · 12.4M tok · 1823–1928" (unit and coverage always; long labels truncate in the middle; tap shows the full header popover with prominence and selection notes, e.g. "selected by Wikipedia prominence"). The trailing edge holds sticky shelf chips: `⊘ 172` (undated) and `⇥ 1` (scheduled). Warnings append to the label chip: `⚠ 34% undated`. Cluster lanes add "machine label (editable)". The chips are glass, but they sit on the lane's banded background strip, **never over bars**, because the strip is reserved and holds no data.

**Strand slot.** 24 pt (density setting: compact 16 / comfortable 32). Bar height is linear in the lane unit up to 70% of the slot, and every observed bin is ≥ 2 px (0.67 pt at @3x, drawn as 1 pt).

### 4.4 Landscape (932 × 430 pt; safe insets 59 left and right, 21 bottom)

The Scroll rotates; every other root screen stays portrait-only. The layout:
- the TopBar compacts to 36 pt (strand chips as glyph-only ● ■ ▲ ◆ with labels on tap);
- minimap 20, ruler 24 and coverage 8;
- a lane rail of 120 pt holds the full header text in two lines;
- the timeline gets **694 pt**, 1.6× portrait's 430, so the same zoom shows 1.6× the years;
- the lanes area is ≈ 320 pt (6 one-strand lanes);
- the transport becomes a trailing-bottom glass capsule.

Selecting a mark opens a 360 pt **inspector column** at the trailing edge (Then/Now/Next as tabs). The lane rail then collapses to the portrait-style chips, keeping 454 pt of timeline. Rotation keeps `centerDay`, `pointsPerDay` and the selection: the time under the screen's centre stays under the centre. No sheet is presented in landscape; the column replaces it.

### 4.5 Gestures (`ScrollGestureHost: UIView`, UIKit recognisers, wrapped by `ScrollCanvas: UIViewRepresentable`)

| Gesture | Effect | Details |
|---|---|---|
| One-finger pan, mostly horizontal | pan time | direction lock after 10 pt (|dx| > 1.2·|dy|); momentum with `UIScrollView.DecelerationRate.normal` (v·0.998^ms, stops < 5 pt/s); rubber band 0.55 beyond [10000 BCE, 2100 CE]; **no momentum in Reduce Motion** |
| One-finger pan, mostly vertical | scroll lanes | uniform offset; lane headers follow; overscroll bounce |
| Pinch (two fingers) | zoom **x only** about the centroid's day | `pointsPerDay *= scale`, clamped to [0.05 pt/yr, 40 pt/day]; the day under the centroid stays under it; simultaneous centroid travel pans; tier changes fire `.detent` and the pill "Now showing yearly bins" |
| Pinch out past 0.05 pt/yr | **folded overview** | `.boundary` haptic + pill "Deep time: four linear regimes (×3.3 · ×8.9 · ×3.3)"; panning disabled; tap a regime to unfold there ("Linear axis · 1 pt = 0.11 yr") |
| Tap | select the topmost hit | priority mark > arc > cap/fork > bin > wash > band (§8.4); tolerance 12 pt; **ambiguity chooser** popover (`.presentationCompactAdaptation(.popover)`) when ≥ 2 marks are within 6 pt of each other: up to 6 rows "1994 · Zero Holds the Place · song" |
| Tap on an empty bin, gap or seam | its sentence in the peek row | e.g. "1980s · Hip-hop · 0 occurrences in 6.2k tokens: looked, found none" |
| Long press 0.4 s on a mark | **preview + actions** (`UIContextMenuInteraction`) | the preview is the passage with highlight and date chip; actions: Open · Annotate · Lineage · Trace this quotation (span ≥ 4 tokens) · Compare from this bin · Pin expression · Copy citation |
| Long press on the ruler, then drag | brush a range | cyan range with **A** and **B** chips → Compare; release with no drag cancels |
| Drag the playhead handle | scrub the vantage | discrete by bin; a loupe bubble "1997" floats 44 pt above the finger; `.tick` per bin (throttled ≤ 30/s); `.soft` on entering a stretch with no coverage; `.boundary` at the modality seam |
| Double tap | zoom in one tier, centred | 250 ms ease; a jump in Reduce Motion |
| Two-finger tap | zoom out one tier | — |
| Drag the minimap bracket | pan | the bracket's width follows the viewport |

**Conflicts and system gestures.**
- The Scroll is the root, so there is no interactive-pop edge swipe there. Pushed canvases (Lineage, Constellation) keep a 20 pt leading dead zone, so the system back swipe wins at the edge.
- Nothing interactive sits in the bottom 34 pt; the sheet owns that area. `defersSystemGestures` is **not** used, because a reading app must not fight the home gesture.
- Top-edge pulls (Notification Center, Control Center) start above the TopBar.
- The sheet's drag and the Scroll's pan never compete. `presentationBackgroundInteraction(.enabled(upThrough: .fraction(0.5)))` hands touches above the sheet to the Scroll, and the sheet's own content scrolls inside it.
- The pan and pinch recognisers are simultaneous with each other only. Tap requires double tap to fail, but only after 180 ms (`UITapGestureRecognizer.require(toFail:)`), so a single tap still feels instant.

**Hardware keyboard.** `onKeyPress` maps the SPEC §8.5 keys when a keyboard is attached (Space, `[ ]`, `{ }`, `0`–`6`, `D`, `L`, `E`, `V`, `T`, `P`, `C`, `G`, `K`, `N`, `S`, `X`, `?`). This is free parity and costs nothing on touch.

### 4.6 The vantage, scrubbing and Play

- **The playhead** is a cyan line through all lanes, with a glass handle on the ruler reading "as of 1997".
- **The vantage is a shader uniform.** Marks after it are discarded (*strict*) or drawn at 15% (*context*). An arc appears only when both its ends are ≤ the vantage; a feedback arc and its violet halo appear when the vantage reaches the later work. **Scrubbing and Play therefore rebuild nothing.**
- **Play** (▶ in the peek row; Magic Tap under VoiceOver) advances one bin every 400 ms at 1×. Long-press ▶ opens a small tray with a LabKit `GlassKnob` with detents 0.25×, 0.5×, 1×, 2× and 4×.
  - The bin level is frozen during play.
  - Auto-pan keeps the playhead at 70% of the width. It eases over 120 ms per step, and jumps in Reduce Motion.
  - Newly revealed marks fade in over 150 ms through a fade uniform, with none in Reduce Motion. An interval item is drawn dashed at `lo` and solid at `hi`.
- **Gaps.** When every visible lane ahead is uncovered, play pauses 600 ms with the pill "No coverage 1940–1949 in these lanes: skipping. Nothing is inferred.", plays `.soft` and jumps. At the modality seam it pauses once with the seam caption and plays `.boundary`.
- **Strict vs context.** Play runs strict and pausing switches to context. The eye toggle in the peek row (`V`) switches by hand.
- **Reduce Motion.** Play steps every 1.2 s, and **Step ▸** becomes the primary (filled) control. Each step is announced (≤ 1/s): "As of 1950: 2 new occurrences in Classroom".
- **Year picker.** Tapping "as of 1925" opens a picker: era chips (Deep time · Classical · Early modern · Modern) and a year wheel. The vantage snaps to the bin containing that year.

### 4.7 Honesty encodings on the phone (every SPEC §1/§8 element, mapped)

| SPEC element | Desktop form | Phone form | How it is verified |
|---|---|---|---|
| `observed` bin | rect, height = rate | the same rect in Metal, ≥ 1 pt tall, 2 pt corners at ≥ 6 pt width | G14 geometry + snapshot test |
| `absent` | 1 px dotted baseline | 1 pt dotted baseline (dots 1/3 pt); tap → "0 occurrences in 4.1M tokens: looked, found none" | G14 + tap sentence test |
| `low` | hollow tick + light hatch | hollow 1 × 8 pt tick + 45° hatch at 30% opacity; tap → "low coverage: n = 3 in 18k tokens" (no rate numeral) | G14; copy test greps the absence of a rate |
| `uncovered` | 45° hatch, 6 px pitch, "no sources" | 45° hatch, **6 pt pitch** (18 px), in the lane underlay; tap → "no sources" plus the collection span | shader pattern test (offscreen render on the Mac) |
| `pending` | sparse dots, "indexing: not yet looked" | sparse dots + the header chip "indexing 41%" | UI test with a pending pack |
| Bars never bridge gaps | maximal runs | the builder emits one rect per run; nothing is drawn between | G14 (run boundaries exact) |
| Start cap glyph ● ■ ▲ ◆ at the exact first date; end tick at the last | glyphs | atlas glyphs at 7 pt; end tick 1 pt × 6 pt | G14 |
| Censoring ◁ ▷ | chevrons | the same chevrons; tap → "may be older than our record" | G14 |
| Sparse (n ≤ 4), single-source `¹`, estimated majority (stripes + `≈`), synthetic `--syn-stripe` | fills and overlays | the same, computed in the fragment shader: sparse = 1 pt outline + 25% fill; `¹` and `≈` glyphs drawn only at ≥ 14 pt bar width, otherwise listed in the tap sentence | pattern test + sentence test |
| Precision washes (feathered 10% for circa; count label) | translucent band | the same band (opacity .18, 1 pt top rule); the count label only when ≥ 40 pt wide; tap lists the items ("6 items dated to the 1900s–1930s") | conservation test G9; tap test |
| Conservation law | tested | tested on every tile the phone builds (DEBUG assert + unit) | G9, `scrolls-cli verify` |
| UNDATED / SCHEDULED shelves | 88 / 64 px columns | header chips `⊘ n`, `⇥ n` → searchable lists; ≥ 20% undated → `⚠ 34% undated` + "compare undated vs dated" in the list | UI test |
| Modality seam (1928) | permanent line + caption | a permanent 1 pt ivory-2 line through all lanes + ruler label "Full text ends 1928 →"; tap → the full caption; collapsible to a tick in Settings, **never hidden** | UI test: present whenever text and title lanes share the view |
| Coverage track + lane underlay | 24 px + 3 px | 10 pt + 3 pt, 5 grey classes, legend in the Legend sheet | snapshot |
| Arcs above strands, earlier → later, colour by role, pattern by status | quadratic 1.5 px | quadratic 1.5 pt, dash by arc length in the shader (solid / 6–4 / 1–3), endpoint ● / □ / ?, arrowhead at the later end; ≤ 300 from the engine, **phone display budget 150**, "+n more arcs" chip states the rest | G14 bundles; shader dash test |
| Feedback arcs below, violet; halo "re-read after 1994" | below the strands | the same, gated by the vantage uniform; halo tap → "re-read after 2016 (1 documented, 2 annotated)" | demo journey step 4 |
| Date conflict stub | dotted danger + ⚠ | the same | G14 |
| Review overlay ✓ ✕ ⚖ | midpoint glyphs; the line never changes | the same glyphs; rejected arcs hidden by default and drawn at 30% with a strike when shown | style test (3 statuses → 3 distinct triples) |
| Split ⑂ / merge ⑃ / convergence | dashed S-curve + glyph | the same; tap → the computed caption "a split in usage contexts, not a claim about speakers" | G11 transitions + G14 |
| Etymology bands ("periods, not dates"), listed-roots bracket, "no family" note | hatched bands + bracket | hatched bands in the Etymology lane; the bracket label wraps in two lines; tap → the band sentence | UI test with *zero*, *virus* |
| Wiktionary claim marker | hollow amber diamond | the same, left of the strand; tap → "Wiktionary: first attested 1898 (external claim)" | — |
| External baseline | 32 px own track | 24 pt own track under the lane group, own axis label, licence line in the tap sentence | — |
| Lane order note | in the legend | in the Legend sheet **and** the Lanes sheet header: "Lane order is a sorting choice (first observed), not a scale of meaning." | copy test |
| Selection | cyan 2 px + 6 px halo | cyan 2 pt + 6 pt 20% halo (static, no pulse) | — |
| SYNTHETIC everywhere | ribbon, `SYN`, dashed frames, stamp | ribbon; `SYN` badge on passage cards; a dashed 1 pt frame around sheets showing demo material; the stamp on PNG exports | snapshot + export tests |
| "simplified" when over budget | badge | the pill "Simplified: decade bins (too many marks for one screen)" | perf test forces it |
| Differentiate Without Colour | patterns already | role-hue arcs gain a family glyph at the midpoint (`“ ”` · `§` · `♪` · `↺` · `∼`); selection gains a dot | accessibility test |

### 4.8 The persistent sheet: search, inspector and drawers

Detents are `.height(104)` (peek), `.fraction(0.5)` (half) and `.large`, with `interactiveDismissDisabled()` and the default glass background at partial heights. Content is a small state machine (`SheetMode`): `idle` · `search` · `inspector(Selection)` · `drawer(BinRef)` · `shelf(ShelfRef)` · `yourTurn`.

**Search.** Focusing the field raises the sheet to large, with the keyboard.
- Suggestions are typed and grouped: **Expressions** (with "Track as ● strand", count, unit and corpus), **Works** (→ Genealogy), **Makers**, **Themes**, **Etymology**, **Annotations**. Each row comes from `label_tri` typeahead (≤ 1 ms, measured 0.4 ms) plus FTS counts (≈ 1–5 ms).
- Tracking an expression drops the sheet to peek, and the strand chip morphs into the TopBar.
- The lanes show the skeleton with **"preliminary: passages containing" counts** and then "counting… 41%" until materialize completes. Never a spinner without a number.
- Empty results use the computed copy of §4.17.

**Inspector (half detent, `Then | Now | Next` glass segmented control).**
- **Crossings card** (collapsed to one line by default, at the top): "Literature 1911 · STEMM — · Culture 3 titles · Etymology Sanskrit śūnyá (period) · Claims ◇ 1898". Expanded, it is the SPEC §2.D card with every row's basis and the caption "First observation in THIS corpus is not the date of coinage, and not evidence of borrowing."
- **Then** (amber accents): the date chip ("17 May 1994 · stated · day", plus "unverified" or "translation, dated by the original" where relevant) and the document card (title, author, collection, licence, `SYN`). Then the passage in New York serif at Dynamic Type `.body` (17 pt default, line spacing 0.6 em, ≈ 45 characters per line at 430 pt), with the match highlighted at its UTF-16 offsets (cyan 25% background + underline). Below that:
  - "±1 passage" expanders and **Open in reader** (TextKit 2 `UITextView`, scrolled to the offset; whole books are viewport-laid-out);
  - the "refers to 1911" chip;
  - **contemporary uses** (≤ 9, stratified ≤ 3 per lane) under the denominator line "n = 37 in 1925–1945 · 6.1M tokens";
  - "Machine annotations (fallible)" in a disclosure group.
- **Now** (violet accents): a later-passage picker (a menu of every later related passage plus "any later occurrence") and the relationship card. On the phone the alignment is **stacked**, Then over Now: shared tokens ivory, substitutions with a violet underline, insertions dotted. Then come "context words, not meanings" (only around Then / only around Now), or the sentence "No recorded relationship; these are separate uses of the same expression."
- **Next:** subsequent relationships (≤ 20) and a Swift Charts sparkline of later occurrences with denominators, then **Add a hypothesis about later reinterpretation**. That makes a dashed violet card: "Hypothesis — by you, 9 Oct 2026 — not evidence".
- **The fixed footer**, pinned and always visible: "Then shows documents and their settings, not anyone's private thoughts."

When a mark is selected the Scroll pans (250 ms, a jump in Reduce Motion) so the mark sits in the visible band above the sheet. The sheet reports its height through `onGeometryChange` into `ScrollModel.occludedBottom`.

**The bin drawer** (tap an aggregate bin): the denominator line first ("1910s · Classroom · 14 occurrences in 38,120 tokens · 367 per million [201–616]"), then a `LazyVStack` of KWIC rows (50 per page, by date), each opening Then. Sampled bins say "contexts sampled: 200 of 1,894 in this bin".

### 4.9 Compare (a pushed destination)

- **Entry points:** brushing a range on the ruler (A/B chips) · "Compare from this bin" in the mark menu · More → Compare · `C`. It opens with a zoom transition from the brushed range.
- **Layout:** a vertical stack. A is always the earlier slice, and A sits over B in every panel.
  - The **multiplicity line** is pinned under the navigation title ("Comparison #7 for 'virus' in this session; …").
  - Then **Coverage & composition always first.** Two compact rows of slice facts, then a stacked kind × language × collection bar. The JSD caveat card is amber, the modality gate card has **[Compare titles with titles]**, and the prominence caveat follows.
  - **Frequency:** a Swift Charts dot + CI rule per slice in its unit, plus the rate ratio with its CI when the units match.
  - **Representative passages:** 5 per slice, seed printed, **Reshuffle**.
  - **Neighbouring terms:** three tabs (shared / A only / B only) with logDice and q.
  - **Context groups:** shares with CIs, or a gate card.
  - **Estimated displacement:** gate cards, or "estimated shift in usage contexts" values.
  - **Tone:** NLTagger runs in-process and is labelled "Apple NLTagger — modern reader model, fallible, anachronistic for historical text". Human stance and pragmatic counts follow.
  - Last, **"How coverage could affect this"**.
- **Gate cards** are opaque, never glass, with `{gate, needed, have, suggestion}` and an **[Apply]** button that widens the slice and re-runs. A gated measure renders no numeral; the `Gated<T>` type makes that unrepresentable.
- **Range editing** sits at the top: a mini Scroll strip (the same renderer at 64 pt tall) with two draggable brackets A and B.

### 4.10 Lineage and Genealogy (pushed)

- **Canvas.** A SwiftUI `Canvas` with `.drawingGroup()`; bounded at ≤ 150 nodes and ≤ 400 edges. x is the same linear `TimeScale` as the Scroll (pinch and pan, same feel), with the "ordinal spacing" toggle labelled as such. Rows are generations, never meaning. Undated nodes sit in a 44 pt leading gutter. The root is outlined cyan.
- **Edges** use `EvidenceStyle` (pattern = status, glyph + label = type, hue = family). The chip filters scroll horizontally, and the evidence control cycles all → documented + computed → documented.
- **Tap a node** → the Then card in a sheet. **Tap an edge** → the **edge card** sheet:
  - the type and direction, and the status in words (`DOC*` when the source is unrecorded);
  - the origin, method or annotator, run and parameters, and the score with its kind ("similarity 0.71 — not a probability");
  - the external locator ("opens in Safari, outside Scrolls" — the only network surface, and only on tap);
  - supporting spans stacked with an aligned diff, and the CUE badge;
  - the revisions (rev 1 synthesized for source rows, Δ3);
  - **Confirm / Reject / Dispute / Attach evidence**, each needing a note of ≥ 10 characters;
  - the fixed caution sentence.
- **Chain of custody.** Long-press a node → "Path from here", then tap a second node. The result is a vertical list of link cards headed "Chain strength = weakest link: PROPOSED".
- **Bounded expansion.** Each node has a ＋ (≤ 30). At 150 nodes the view offers **Show as list**, and prints "showing 150 of 412 nodes". Commonplaces collapse into "widely shared text (n documents)".
- **Hypothesis groups** are a fan with "⚖ 2 competing". The group card pages through the hypotheses side by side (one per page on the phone, with a page indicator) and offers "Add a hypothesis".
- **Genealogy** is the works-as-rows gantt. Each row is 32 pt ("title — maker (year · precision)"), grouped by generation, with sticky generation headers carrying a density strip, and pages of 50 per generation ("+214 more samplers — 1990s: 88"). The honesty line is pinned: "Absence of a link is not evidence of no sampling."

### 4.11 Constellation (pushed)

- **Canvas and scale.** A SwiftUI `Canvas` with pinch and pan, ≤ 150 nodes and ≤ 400 edges. Positions come from the engine's deterministic Fruchterman–Reingold layout (`layout_cache`) and never move on a period change. **Re-layout** is an explicit button with the toast "Positions recomputed — movement is not semantic."
- **Period comparison.** On the phone only the **overlay** mode ships (§7 cuts *split*). A-only nodes are hollow amber, B-only dashed ivory, both filled, and two-tone rings show size change. The diff list ("only in A / only in B / grew > 2×") is a sheet.
- **The legend is persistent:** a one-line glass bar at the bottom-leading edge ("area ∝ occurrences in period (sqrt radius) · edges: logDice ±5 tokens") that expands to the full legend and never closes.
- **The size quantity** is chosen in a segmented control (occurrences · documents · authors).

### 4.12 Notebook (pushed; also the "Annotate" action from any mark)

- **The list.** Annotations grouped by target, then layer. Each card shows "rev 3 of 3", the kind, the dimensions as chips, the evidence chips (amber = for, struck grey = against) and the author.
- **The editor.** A sheet at large: a body `TextEditor` (Markdown text, the `body_md` of §3), the kind picker, dimension rows (built-in plus `dimension_def`: enum → chips, scale → slider, text, bool → toggle), tags, and evidence references picked from recent selections. Saving appends a revision through `perform(.annotation…)`.
- **Revisions.** A scrubber with one stop **per revision**, not per day. That fixes the web build's open "same-day readings cannot be told apart" item, since the API's `as_of` takes a timestamp. It comes with a word-level diff.
- **Reinterpret** creates a new annotation with `supersedes`. The old one stays as a visible layer: "Layer 'Reader A, 3 Oct 2026' — superseded 12 Nov 2026".
- **As-of slider.** It has stops at every revision timestamp and is the human vantage clock.
- **Compare interpretations** pages one column per layer or author; shared evidence is highlighted in each.
- **Machine annotations** sit in their own section ("fallible") and cannot be edited, only countered.

### 4.13 Term trail and Crossings

The preset **Term trail (all real corpora)** draws 18 fixed lanes in collapsible domain groups (Etymology · Literature en/fr/es/hi/gu · STEMM fields · Culture titles · OpenAlex shares). The group headers are sticky, with a chevron. Each lane keeps its own unit, and OpenAlex lanes say "share of the top-cited sample in each cell — not a trend". Absent sources are listed with their reason in a final row: "STEMM lanes need the STEMM pack: not on this phone (320 MB)". The Crossings card is the first thing in the sheet. The Constellation from a trail defaults to the decade with the most matches, not the current decade (HANDOFF open item).

### 4.14 Saved views, deep links, share

- **Save** (More → Save view, or `S`): a name field, then an immutable view (a re-save becomes `slug~2`) with its pinned runs and cutoffs. Feedback is the `success()` haptic and the toast "Saved: carry-the-zero-four-uses-3f9a".
- **Links** use the same grammar as the web:
  - `scrolls://open#v=1&c=demo&s=e12&l=community:fo&…` carries the state hash;
  - `scrolls://view/<slug>` opens a saved view, with `?as=1` for as-saved.
  - The parser is `ViewState(hash:)`, and the G3 golden test proves it equals the web's.
- **Sharing a view** produces (1) the link, (2) a `.scrollsview` file (`com.utkarsh.scrolls.view`, JSON `{scrolls_view:1, slug, state_hash, data_version, atlas_build, saved_at}`), which opens in Scrolls by AirDrop, and (3) the PNG snapshot. No domain exists for universal links, so "universal-ish" means the custom scheme plus the document type. On a phone whose atlas lacks the slug, the hash opens with the banner "Not saved on this phone: opened from its state. Counts reflect this phone's atlas (build 4, data v52)."
- **Saved Views sheet:** a list with snapshot thumbnails (`saved_view.snapshot_svg` rendered once), each showing its drift ("Corpus changed since this view was saved…") and **As saved / Current** chips.

### 4.15 Import wizard and packs

**Import** (More → Import a file, or arriving through Open in Scrolls) is a sheet at large with four steps and a step indicator:
1. **File:** the name, sniffed format, encoding (with `W_ENCODING_FALLBACK` and the first bad byte offset) and the first 5 records.
2. **Map:** one row per detected field, with a role picker (date, title, author, text, language, community, genre, URL, ID, metadata, ignore) and 3 sample values. The date role previews the grammar output live ("c. 1894 → 1889–1899 · estimated").
3. **Validate:** the dry run's accepted / warnings / rejected counts, a problem list (line:col, code, message, suggestion) and **Share problems.csv**.
4. **Commit:** a job with progress. The user can leave; the status chip carries it. Then the summary, with **Revert**.

**Packs & storage** (More → Sources and packs):
- **Bundled:** "Cipher metadata — built 9 Oct, 94,385 works · 179,014 relation endpoints".
- **For each absent pack**, how to send it: "AirDrop cipher-text.scrollspack from your Mac, drop it in Finder › iPhone › Files › Scrolls, or run Tools/push-packs.sh". **Build** starts the continued-processing task, with the estimated time measured from this phone's bench.
- **Storage:** a stacked bar (atlas · sources · derived · caches), with "rebuildable" tags and **Purge caches**.

### 4.16 The first minute on the phone (scripted; coach marks are non-blocking and never return unless the user asks for the Tour)

| t | On screen | Engine | Feel | Teaches |
|---|---|---|---|---|
| 0–1.0 s | Launch colour `#0E1013`, then the Scroll: *carry the zero*, lanes = community (5 lanes + "+n more lanes"), 1890–2030 at decade bins (3.07 pt per year, 30.7 pt per bin), vantage 1925, the SYNTHETIC ribbon. Bars stagger in left to right over 600 ms (none in Reduce Motion). Status chip "Cipher: titles & relations 4%" | demo atlas copied and opened; tiles L2 from the cube; `bootstrap-cipher` A enqueued | — | one phrase, across communities, over time |
| 2 s | **Coach ①** (a glass callout with a leader to the 1911 Classroom bar): "Bars span where 'carry the zero' was **observed**. Gaps are real: dotted = looked and found none; hatched = no sources." The 1940s hatch and the 1984–93 dotted stretch are lit by a 1 pt cyan outline, not a pulse | — | — | absence has two kinds |
| ~12 s | **Coach ②** at the two arcs: solid amber `DOC` ("1994 liner notes cite Brennock's 1911 primer — a synthetic record") and dashed `CALC` ("1963 bulletin repeats 13 words of the primer — computed by text matching"): "Line style = evidence. Tap any mark to read its source." A static ring marks the 1994 Hip-hop mark | — | — | documented ≠ computed |
| ~25 s | The user taps the 1994 mark. The sheet rises to half: the passage with its highlighted span, `SYN`, "17 May 1994 · stated · day", "refers to 1911" | `passage(901)` ≤ 10 ms | `.select` | every mark opens its passage |
| ~40 s | **Coach ③** above the peek row: "Press ▶ to watch the phrase acquire history." Play: 1925 → 2026 in ≈ 5 s at 400 ms per decade, with a 600 ms pause at the 1940s gap (pill: "No coverage 1940–1949… Nothing is inferred."). At 2016 the 1911 primer gains a violet halo and the feedback arc draws below the lanes | uniforms only; zero rebuilds | `.tick` per decade, `.soft` at the gap, `.ripple` when the halo appears | change over time; gaps preserved; re-reading only where a link says so |
| 55–60 s | The sheet shows **"Your turn."**: the search field focused, chips `virus` · `zero` · `sample`, and **Switch to Cipher (real data)**. It is enabled when phase A is done ("Cipher titles, relations and etymology ready · full text: send the pack (190 MB)") and otherwise shows its live percentage. Below: [Full tour (4 min)] | phase A done ≈ 45 s (est.) | — | where to go next, on his data |

The full 10-step tour (SPEC §9.7) runs from the same `tour.json`. The phone versions of its steps:
- step 3's "`E` twice" becomes tapping the Evidence chip twice;
- step 5's `L` is the Lanes chip;
- step 7 is a ruler brush;
- step 9's `G`/`N`/`S` are the mark menu's Lineage and Annotate actions and More → Save view.

Launch arguments: `-tour`, `-tourStep n`, `-ui-testing` (deterministic, no Cipher bootstrap), `-corpus cipher`, `-strand virus`, `-selftest journey`, `-perf`.

### 4.17 Empty, loading, error and low-evidence states (copy as in SPEC §8.8, computed)

| State | Phone presentation |
|---|---|
| Empty search | In the sheet, computed: "No occurrences of 'hacker' in the loaded corpus (68M tokens of full text to 1928; 94,385 titles). With the plural variant: 1 title — Hackers (film, 1995). 0 is an observation about this index, not about culture." Then variant chips, the etymology entry or "no family in roots data", and "STEMM pack not on this phone" when that applies |
| Loading tiles | Lane skeletons with "counting… 41%" and preliminary counts. The previous tier stays drawn, dimmed 40%, until the new tiles arrive; **never a spinner without a number** |
| Pending collection | The lane underlay of sparse dots and "indexing — not yet looked" |
| Engine error | An opaque card with the message, hint and **Retry**. An interrupted read (the 5 s deadline) suggests "Narrow the range or the lanes". The selection is never lost |
| Low evidence | Gate cards (§4.9) and `low` bins; never a numeral for a gated measure |
| Atlas integrity failure (boot check) | A full-screen card: "3 originals missing from this phone's atlas" with **Rebuild from packs** / **Open read-only** |
| Storage full | The Packs page opens on the Storage bar, with "rebuildable" items first |
| Thermal pause | The status chip shows "paused: phone is hot" and resumes on its own |

### 4.18 Accessibility

- **The Scroll for VoiceOver.** `ScrollAccessibility` exposes:
  - one element per lane with the generated summary ("Lane Classroom · text: 'carry the zero' observed 1905–1939 and 1950–1960 in 2 bars; gap 1940–1949: no sources (archive gap, synthetic).");
  - child elements per bar and per gap (swipe order: time);
  - **custom rotors** for Bars · Gaps · Arcs · Marks · Seams (`accessibilityRotor`);
  - the playhead as an **adjustable** element ("as of 1925"; swipe up and down steps a bin);
  - actions: Play, Step, Strict or context, Open bin drawer;
  - **Magic Tap** = Play or Pause, and **Escape** (two-finger Z) = clear selection or drop the sheet.
- **Audio Graphs.** Each lane provides `accessibilityChartDescriptor`. x is the bin midpoint year, y the rate in the lane unit, and the series is **not continuous** (`isContinuous: false`): only observed bins are data points, so the audio never bridges a gap. Absent, low and uncovered bins are described in the summary.
- **The table alternative** (More → Table, or `T`) is `ScrollTableView`: a `List` grouped by lane, one row per bin ("1910s · 14 · 367 per million [201–616] · 38k tokens · observed · single source"). It is built from the **same `LaneSeries` arrays** the renderer uses, and an identity test checks every row against the display list.
- **Dynamic Type.** Chrome over the Scroll (TopBar chips, lane header chips, pills, transport) caps at `.accessibility1` and offers the Large Content Viewer (LabKit's rule for stage chrome). Sheets, passage text, cards and Compare are uncapped. At AX sizes Then/Now/Next becomes one vertical scroll with section headers, and the peek detent grows to fit.
- **Reduce Motion** as §4.6. **Reduce Transparency** makes glass opaque (system), and the ribbon's stripes stay. **Increase Contrast** raises hairlines and swaps `ink-3` for `ink-2`. **Differentiate Without Colour** as in the §4.7 table. **Bold Text** is honoured. Every hit target is ≥ 44 pt except marks, which use the tolerance and the chooser.
- **Copy.** Every UI string lives in `ScrollsCore/Copy.swift` (or `Localizable.xcstrings` with British English as the source). `CopyLintTests` checks two things. First, LabKit's `CopyLint.americanSpellings`, because house copy is British. Second, Scrolls' `MENTAL_STATE_VERBS` and `FORBIDDEN_PHRASES` ("thought", "felt", "intended", "meant to", "wanted", "believed"; "meaning changed", "coined", "born"), the port of `ui.copy.test.mjs`.

### 4.19 Haptics (LabKitFeedback `HapticEngine` + `HapticTap`; transients only, no hum, no sound)

| Event | Tap | Why |
|---|---|---|
| Tier change while pinching | `.detent` | zoom has detents like a knob; you feel decades become years |
| Vantage steps one bin (scrub or Play) | `.tick` (minGap 0.045 s, `Throttle` ≤ 30/s) | time advancing |
| Vantage enters a stretch with no coverage | `.soft` | an honest "nothing here" |
| Modality seam crossed; pan hits the domain edge; pinch into folded | `.boundary` | a change of medium or regime, not of meaning |
| Feedback halo appears | `.ripple` | a later work re-reads an earlier one |
| Mark or edge selected | `.select` | — |
| Review recorded, view saved, pack built | `success()` | — |
| Gate card shown | none | refusal is information, not an error buzz |

Haptics stop on background (LabKit `setActive`). The strength slider lives in How Scrolls works → 08 (LabKit `FeedbackSettings`). Sound is off and has no UI: no quantity here has a causal sound, and LabKit's rule ties sound to causes.

### 4.20 Liquid Glass and LabKit

**Glass rules.**
- **Glass:** TopBar chips, the status chip and More, the sheet at partial detents (system), the transport, coach marks, pills and toasts, lane header chips (on the reserved header strip only), the Constellation legend bar and context menus (system).
- **Opaque:** the Scroll's data plane, passage text, the Then/Now/Next bodies, gate cards, edge cards, Compare panels and the import mapping table.
- **Morphs.** One `GlassEffectContainer` holds the strand chips, so pinning or unpinning a strand *morphs* a chip in or out. That is the only morph on the root screen, and it carries meaning ("this is now on the Scroll"). Tint is reserved: cyan only for selection and navigation, never decoration.

**LabKit adoption.**

| LabKit piece | Adopt? | Use in Scrolls / reason |
|---|---|---|
| `LabKitFeedback`: `HapticEngine`, `HapticTap`, `.labHaptics` | **yes** | the haptic map above; the same feel as Gyre, Loom and Rheo; the background stop rules |
| `LabKitCore`: `DeviceConditions`, `FramePacing`, `Throttle` | **yes** | 60 fps cap and job pause under Low Power or `.serious`; haptic throttle |
| `LabKitCore`: `CopyLint` | **yes** | British spelling lint; Scrolls adds its own forbidden-phrase list |
| `LabKitUI`: `StatusBanner`/`StatusBannerHost` | **yes** | tier pills, gap and seam pills, toasts |
| `LabKitUI`: `ChoiceChips`, `GlassToggle` | **yes** | Lanes, Filters, the evidence filter and toggles ("chips, never a menu that hides the choice" fits §1.3's printed order rule) |
| `LabKitUI`: `LabInfoSheet`, `FieldNote`, `SourceList`, `FeedbackSettings` | **yes** | **How Scrolls works**, in LabKit's fixed panel order: 01 What you're looking at · 02 Touch · 03 What you're seeing (the encodings, with drawn swatches) · 04 Controls · 05 Presets (Domains · Term trail · Community · Languages) · 06 What's documented, computed and proposed (+ synthetic) · 07 On this phone (packs, storage) · 08 Sound & feel · 09 Sources & licences (every licence and attribution of §13.15) |
| `LabKitUI`: `GlassKnob` | **one** | the play-speed knob (detents 0.25–4×), the one continuous parameter |
| `LabKitUI`: `KnobConsole`, `LabTopBar`, `TelemetryCard` | no | Scrolls is not a parameter toy; its top bar holds strands and status |
| `LabKitUI`: `.labChrome(palette)` | no | it hides the status bar and applies the "glass over phosphor" palettes; Scrolls keeps the SPEC §8.7 tokens (charcoal, ivory, cyan, amber, violet) and the status bar |
| `LabKitCore`: `Provenance` / `ProvenanceBadge` | **no** | its words (measured, modelled, live, simulated, illustrative) would blur documented / computed / proposed (§13.5) |
| `LabKitUI`: `CanvasRegion` | no | it is one accessibility element with raw touches. Scrolls needs momentum, direction lock, context-menu previews, many accessibility elements and rotors |
| `LabKitRender` | no | its renderer runs continuously and adds bloom, EDR and scanlines. A data instrument must be crisp and draw **zero frames at rest**. Scrolls' renderer is on demand (§4.21) |
| `LabPlot` | no | Swift Charts gives Compare its audio graphs, and keeps any log time axis out by construction (D3) |

Dependency: `packages: LabKit: { path: ../../LabKit }`, mirrored side by side by `Native/Tools/build.sh` (Rheo's pattern). Products: `LabKitCore`, `LabKitFeedback`, `LabKitUI`.

### 4.21 Rendering the Scroll: technology decision and budgets

**Decision.** The Scroll's data plane is drawn by **Metal** (`MTKView`, on demand). Chrome is SwiftUI. The bounded canvases (Lineage, Genealogy, Constellation, sparklines) and the **export/snapshot renderer** are SwiftUI `Canvas` drawing the *same* `DisplayList`.

**Why not SwiftUI Canvas, Core Graphics or Core Animation for the Scroll.**
- The budget is ≤ 20,000 bin cells + ≤ 4,000 marks + ≤ 300 arcs + ≤ 150 labels per viewport (§1.6/§8.3) at 120 Hz on 1290 × 2796 px.
- Core Graphics, which backs `Canvas` rasterisation, filled 20,000 rects in **82–115 ms** per frame on an M1 Max **(measured)**, 10–14× over the 8.33 ms frame.
- Pinch is **x-only zoom with constant stroke widths, dash lengths and glyph sizes**. A layer transform (Core Animation) would stretch strokes and glyphs. So any retained approach must re-issue all geometry on every pinch frame, and Canvas re-runs its closure on the main thread.
- Metal does x-only zoom in the vertex shader for free, and the instance buffers do not change.

**The data path.**

```
Atlas.tiles/marks/arcs ──▶ DisplayBuilder.build(input) ──▶ DisplayList (day space) ──▶ ScrollRenderer.install()
 (ReadPool, async)          (nonisolated, background task;        │                     (upload to 1 of 3
                             ≤ 12 ms p95 for 20k cells)            │                      instance buffers)
                                                                   ├──▶ DisplayListCanvas (SwiftUI Canvas) → ImageRenderer → PNG
                                                                   ├──▶ SVGWriter → snapshot / HTML bundle
                                                                   ├──▶ LaneSeries → ScrollTableView, Audio Graphs, tap sentences
                                                                   └──▶ HitGrid (24 pt cells, content coordinates)
```

```swift
// ScrollsTimeline (pure; golden-tested against model.mjs/display.mjs)
public struct TimeScale: Sendable, Equatable {
  public var centerDay: Double, pointsPerDay: Double, width: Double
  public func x(day: Double) -> Double; public func day(x: Double) -> Double
  public var pointsPerYear: Double { pointsPerDay * 365.2425 }
  public var tier: Tier { Tier(pointsPerYear: pointsPerYear) }            // same thresholds as dates.tierForPpy
}
public struct DisplayList: Sendable {
  public var originDay: Int32                                               // instance x = Float(day − originDay)
  public var bands: [BandPrim], washes: [WashPrim], bars: [BarPrim], ticks: [TickPrim]
  public var diamonds: [DiamondPrim], arcs: [ArcPrim], glyphs: [GlyphPrim], labels: [LabelPrim]
  public var lanes: [LaneSeries]                                            // the numbers behind every primitive
  public var simplified: SimplifiedReason?
  public var hit: HitGrid
}
public struct BarPrim: Sendable {        // 32 bytes in the GPU buffer
  public var d0, d1: Float                // days relative to originDay
  public var y0, y1: Float                // lane-stack points
  public var style: UInt16                // EvidenceStyle / BinStyle id: fill, sparse, stripes, syn overlay
  public var flags: UInt16                // single-source, estimated-majority, synthetic, censor-left/right
  public var revealDay: Float             // vantage gating: hidden (strict) or ghosted (context) when revealDay > vantage
  public var id: UInt32                   // stable primitive id → HitGrid → Ref (occurrence | bin | passage)
}
public enum DisplayBuilder { public static func build(_ input: DisplayInput) -> DisplayList }

// App (MainActor)
final class ScrollRenderer: NSObject, MTKViewDelegate {
  func install(_ list: DisplayList)                 // ring of 3 buffers; swap on the next drawable
  var uniforms = ScrollUniforms()                   // the camera and the clocks
  func requestFrame()                               // on demand; a CADisplayLink runs only while something moves
}
struct ScrollUniforms {                             // shared with Scroll.metal through ScrollShaderTypes.h
  var centerRel: Float; var pointsPerDay: Float     // centerRel = Float(centerDay − originDay): exact to < 1 day at ±8 M days
  var viewSize: SIMD2<Float>; var laneScroll: Float; var contentScale: Float   // 3.0
  var vantageRel: Float; var vantageMode: UInt32; var ghostAlpha: Float       // strict 0 · context 0.15
  var fadeFromRel: Float; var fadeToRel: Float; var fadeT: Float              // the 150 ms reveal
  var selectedID: UInt32; var reduceMotion: UInt32
}
```

**One render pass, seven instanced draws, in z-order:**
1. bands (lane banding, coverage underlay, hatch / dot / period patterns, the modality seam);
2. washes;
3. bars and ticks: rounded-rect SDF with analytic AA (`fwidth`), sparse outline, stripes, the syn overlay;
4. diamonds and work marks;
5. arcs: each instance is a quadratic Bézier tessellated to 24 segments in the vertex shader, with **dash by cumulative arc length** (solid / 6–4 / 1–3 pt) and the endpoint glyph and arrowhead as separate glyph instances;
6. glyphs and labels from a **`LabelAtlas`**: Core Text rasterises SF Pro and SF Mono runs (year labels, counts, ● ■ ▲ ◆ ◁ ▷ ⑂ ⑃ ¹ ≈ ✓ ✕ ⚖ ⚠) at 3× into an R8 2048² texture (LRU, ≈ 4 MB);
7. the overlay: playhead, selection glow, brush, focus ring, all from uniforms.

Patterns are computed in screen space (`pitch = 6 pt × contentScale`), so a hatch never stretches under zoom. The pixel format is `bgra8Unorm` with sRGB-encoded tokens (LabKit's convention), and there is no MSAA. **Precision:** days span about ±4.4 M for 10000 BCE–2100 CE. Instance days are stored relative to `originDay` (the viewport centre at build time), so `Float` keeps sub-day accuracy at 40 pt/day.

**When frames are drawn.** `MTKView.isPaused = true`. A `CADisplayLink` with `preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)` runs only during a gesture, momentum, Play, a fade, or the 250 ms pan to a selection. Otherwise a data or selection change draws exactly one frame. `FramePacing` caps it at 60 under Low Power Mode or thermal `.serious`. `Info.plist` sets `CADisableMinimumFrameDurationOnPhone = YES` (as Loom does).

**What rebuilds what.**

| Change | Work |
|---|---|
| pan, pinch within a tier, lane scroll, scrub, Play, strict/context, selection | uniforms only (≤ 0.1 ms CPU) |
| tier crossing | tiles for the new tier (cube, in-process) → `DisplayBuilder` in the background → swap; the old tier stays drawn at 40% until then |
| filter, lanes, strands, evidence filter, layers | a new query key → tiles → build → swap |
| pan beyond the prefetched ±1 viewport | tiles for the new range, prefetched during momentum by velocity × 0.5 s |

**Budgets (A17 Pro, 1290 × 2796 px, 120 Hz). These are acceptance criteria, measured on the device by `-selftest perf` with `os_signpost` and by an `XCTOSSignpostMetric` UI test.**

| Item | Budget |
|---|---|
| Main-thread time per gesture frame (recognisers → uniforms → encode) | ≤ 1.0 ms p95 |
| GPU time per frame at the maximum load (20k bar/tick instances + 4k marks + 300 arcs + 150 labels) | ≤ 3.0 ms p95 |
| Hitch ratio during a scripted 10 s pan + pinch + momentum session | < 1 ms/s, and no single hitch > 1 frame |
| `DisplayBuilder` for 20k cells (background) | ≤ 12 ms p95; swap on the next frame |
| Tile → first paint after a tier change | warm ≤ 33 ms; cold ≤ 150 ms |
| Tap → selection drawn and sheet content requested | ≤ 16 ms; passage text in the sheet ≤ 50 ms |
| Launch → first frame with demo data | ≤ 1.0 s cold |
| Idle | 0 frames, < 1% CPU |
| Renderer memory | ≤ 24 MB (3 × ≈ 1.2 MB instance rings + label atlas + pipelines) |
| `fillText`-equivalent labels per frame | ≤ 150 (as SPEC) |

If a viewport's display list would exceed a budget, `DisplayBuilder` steps to the next coarser tier and returns `simplified` (the "Simplified" pill), the SPEC §8.3 rule unchanged.

**Snapshot equals screen.** `DisplayListCanvas` paints the same `DisplayList` with `GraphicsContext`. A Mac test renders the demo viewport offscreen through the Metal pipeline (`MTLDevice` + `MTLTexture`; the renderer's shaders are also built for macOS in a test-only target) and through the Canvas, and requires ≤ 1% pixel difference outside text anti-aliasing. Arc dashes and hatch phases are equal by construction (both read `EvidenceStyle`).

**`PerfHUD` (`-perf`).** It shows p50/p95 of main-thread frame time, GPU time (`MTLCommandBuffer.gpuStartTime/EndTime`), instance counts, tier and the rebuild cause. It replaces `?perf=1`.

---

## 5. Performance on the A17 Pro: costs and how each is bounded

Planning factors as in §3.3. "Web" figures come from HANDOFF and were measured at load averages of 300–1,000; they are not quiet-machine numbers.

| Operation | Web reference | A17 Pro (est.) | Bounded by | Where |
|---|---|---|---|---|
| Typeahead (`label_tri`) | — | ≤ 2 ms | trigram, `LIMIT 20` | foreground |
| FTS term / phrase | 0.2–5 ms (measured) | ≤ 10 ms | contentless FTS5 `detail=full` | foreground |
| First search of a new word | 0.2–2.7 s | ≤ 150 ms | FTS + preliminary counts only | foreground |
| Materialize a new word (≤ 20k candidate passages) | 1–14 s | ≤ 1.5 s | chunk decode 50 µs × distinct chunks + tokenising at 40 M tok/s; LRU of 64 chunks | job, priority 1, progress % |
| Very frequent word (> 300k matches) | — | ≤ 3 s | `passage_vocab_inst` exact counts (1.1 ms measured for 16k rows) + a stratified sample of ≤ 200 per (lane, decade) | job |
| Denominators | 3.75 s by SQL, cold (measured) | ≤ 5 ms per (tier, facet) | the **mmap'd cube** (≈ 14 MB per corpus, built ≈ 0.5 s once per data version) | cache |
| Tiles, one strand, a viewport | cold p95 618 ms | warm ≤ 16 ms, cold ≤ 120 ms | `expr_doc` numerator 4–5 ms (measured) + cube | read pool |
| Marks ≤ 4,000 · arcs ≤ 300 + bundles (*gene* 21,490 links) | ≤ 150 ms budget | ≤ 40 ms · ≤ 150 ms | caps of §1.6/§1.8 | read pool |
| Term trail, first query | ≈ 9 s cold | ≤ 1.5 s | cubes of every member corpus, prewarmed at launch in the background | prewarm task |
| Compare (coverage, frequency, passages, collocates, gates, 1,000 bootstrap) | — | ≤ 1.5 s | collocations from slice-restricted token streams; bootstrap in Accelerate | foreground with progress |
| Cluster an expression (*bank*: ≈ 4.3k occurrences) | 46 s | ≤ 10 s | sgemm distances; 10 restarts × k ≤ 8 + 30 stability subsamples in a TaskGroup | job (gate card Start) |
| Pooled PPMI–SVD, English (≈ 120 M tokens, 50k × 10k) | 36 s | 60–120 s | 8 co-occurrence shards (512 MB peak), Sparse BLAS, randomized SVD d = 256 | **overnight or continued-processing**; offered on the gate card with its time |
| Era slices + Procrustes + 500 controls (drift) | 100 s | 2–4 min | the same | overnight or continued |
| Global reuse index (winnowing 145 M tokens) | — | 1–2 min, ≈ 520 MB peak | radix sort over packed `UInt64` | overnight only (§7) |
| Targeted trace | ≤ 1.5 s sync | ≤ 1.5 s | FTS phrase + LSH for the span | foreground, then job |
| Constellation layout (≤ 150 nodes, 300 iterations) | > 5 s first per worker | ≤ 60 ms | FR on ≤ 150 nodes; cached in `layout_cache` | foreground |
| Lineage graph (≤ 150 nodes) | — | ≤ 80 ms | bounded expansion | read pool |
| Tone (NLTagger, ≥ 30 paragraphs per slice) | CLI round-trip | ≈ 1–3 ms per paragraph | per-slice cap of 2,000 paragraphs, sampled with seed | job |
| Cipher metadata phase A (on the phone) | 39 s (budget 30 s) | ≤ 45 s | 5,000-document commits; label trigram rows built last | first launch |
| Cipher text / STEMM builds | 3,449 s full bootstrap (loaded Mac) | ≈ 3–5 / 4–6 min | checkpointed per 5,000 documents | continued-processing |

Pooled spaces, era slices and the global reuse index are **precomputable on the Mac** by `scrolls-cli` into a pack (`derived-en.scrollspack`) when the user wants them without waiting. They are the same Swift code, imported as runs with full provenance.

---

## 6. Persistence of user state

**Decision: the same SQLite file, the §3 tables and triggers, plus a backed-up journal. Not SwiftData.**

- **Why SQLite and not SwiftData.**
  - D17/D18 are enforced *by the DDL*: the append-only `annotation_revision` and `relationship_revision` triggers, `rel_evidence_immutable`, `rel_no_delete`, `view_immutable`, the anchor CHECK and the drift-gate CHECK. SwiftData has no triggers or CHECKs and would move every one of these rules into code.
  - A review writes an annotation, a `relationship_revision` and the review status in one transaction, and the arcs query joins them. Two stores cannot be joined or committed atomically.
  - `annotation_fts` needs FTS5.
  - Exports must be byte-compatible with the web's ("every revision as JSONL").
- **Why a journal as well.** The atlas is 2.5 GB, rebuildable and excluded from backup. His interpretations are small and irreplaceable. So every user act goes through one API:

```swift
public enum UserAct: Sendable, Codable {
  case annotationCreate(AnnotationCreate), annotationRevise(id: Int64, AnnotationPatch), annotationReinterpret(id: Int64, AnnotationCreate)
  case annotationWithdraw(id: Int64, reason: String), relationshipPropose(ProposeRelationship)
  case relationshipReview(id: Int64, ReviewRequest), relationshipEvidence(id: Int64, EvidenceRef)
  case hypothesisGroupCreate(HypothesisGroupCreate), viewSave(SaveViewRequest), viewDelete(slug: String)
  case clusterLabel(cluster: Int64, label: String), dimensionDefine(DimensionDef)
  case expressionTrack(TrackRequest), variantsPatch(id: Int64, VariantPatch)
  case importCommit(batch: Int64), importRevert(batch: Int64)
}
// perform(): 1) append {op_uuid, seq, at, actor, act, anchors (collection slug + ext_id + text sha256)} to journal.sqlite
//            (synchronous=FULL; append-only triggers); 2) apply to atlas.sqlite in BEGIN IMMEDIATE with the ported SQL,
//            inserting applied_op(op_uuid) in the same transaction (Δ6); 3) return. Crash between 1 and 2 → replayed at launch.
```

- **Atlas swap or rebuild.** All ops are replayed in `seq` order through the same code. Anchors re-resolve through `(collection slug, ext_id)`, and then `text sha256` + offsets + quote/prefix/suffix (D18). An act whose anchor no longer resolves is listed in the Notebook as **"orphaned interpretation"** with its quote. It is never dropped.
- **Saved views** pin run ids. After a rebuild those runs do not exist, so the view says "Saved on atlas build 3; this phone now runs build 4: as-saved is unavailable; showing current data". That is honest (D17 within a build) and nothing is silently re-pinned.
- **Reviews** are relationship revisions plus annotations, exactly as on the web. `evidence_status` never changes, by trigger.
- **The notebook export** is the journal plus current state as JSONL, and opens on the Mac with the web build's import of annotations (one fixture checks this).

---

## 7. Risks, and what to cut or defer for a coherent v1

| Risk | Likelihood · impact | Mitigation |
|---|---|---|
| iOS system SQLite lacks a compile option the Mac has (FTS5 `contentless_delete`, `rtree_i32`, JSON1) | low · high | `Probe.swift` runs `PRAGMA compile_options` and executes the §3 DDL on the simulator **and the device** in N0 (acceptance). Fallback: vendor the SQLite amalgamation as a C target (FTS5 + RTREE on), which is still Apple-free code but one third-party file. Decided only if the probe fails |
| Sentence-segmentation parity (`Intl.Segmenter` vs ICU through CF) | medium · medium | §2.3: `seg-1i`, counts compared at segmentation-invariant levels; the native atlases agree with each other |
| Metal renderer scope (patterns, AA, labels, hit-testing) | medium · high | the pure `DisplayBuilder` lands first with G14 goldens; `DisplayListCanvas` is a working (60 Hz) fallback renderer from day one, behind `-renderer canvas`; Metal replaces it in M1 |
| Thermal and time limits on long builds | medium · medium | 5,000-document checkpoints; continued-processing tasks; Mac-built derived packs |
| Jetsam during vectors or reuse | medium · medium | declared `peakBytes`; `os_proc_available_memory` admission; mmap'd spaces; the increased-memory-limit entitlement |
| Gesture conflicts: sheet vs pan vs pinch vs system | medium · medium | UIKit recognisers with explicit failure requirements; UI tests that drive pans with the sheet at each detent |
| Copy drift between web and phone | medium · low | strings ported verbatim; CopyLint; the forbidden-phrase test |
| Contract drift (1.3.0 shapes) | low · medium | the contract round-trip tests over 60 fixtures |

**Cut or deferred, with the reason:**
- **Portable HTML bundle** → M4. PNG, JSON, CSV and the link cover sharing in v1.
- **Share extension** → later. Open in Scrolls through document types covers the share sheet without an app-group container.
- **Constellation *split* mode** → later. At 430 pt two side-by-side layouts are unreadable; overlay + diff list conveys the same thing.
- **The global reuse index on the full corpus** runs only overnight or ships precomputed. The targeted trace and the boilerplate pass are in v1.
- **On-device MusicBrainz** (collision test, chains): never on the phone. The demo-name test stays a Mac test.
- **The convergence glyph ⑃** stays (cheap); the human-asserted convergence bracket stays.
- **App Intents / Action button** ("Scroll a word"), **Spotlight for saved views** and **widgets** → polish milestone, only if M1–M4 are green.
- **Never:** automatic irony or stance detection; the Foundation Models framework for any annotation (§14 "Never"); a single meaning score; feedback from similarity.

---

## 8. Build plan for parallel agents

### 8.1 Milestones

| Milestone | Goal | Exit |
|---|---|---|
| **M0 Foundation** (N0, one agent) | the skeleton, frozen contracts, the store, Core, golden plumbing, build scripts, device probe | `ci.sh` green on G1–G3 + contract round-trip; the app launches on simulator and **his phone**, opens the demo atlas, and shows the probe result |
| **M1 Vertical slice on device** (N1–N7 in parallel) | import → search → Scroll → passage → Compare → save view, with the demo + Cipher meta on the phone | the SPEC §11 journey passes in `scrolls-cli verify --demo`, in XCUITest and through `device-check.sh`; the §4.21 budgets met on the device |
| **M2 Lineage** (N8) | reuse/trace/cues, the Lineage explorer, Genealogy, arcs at STEMM scale | G13 green; demo journey steps 3, 8, 9 on the device |
| **M3 Context groups, spaces, drift, tone** (N9) | cluster lanes, splits, pooled spaces, era slices, drift, tone | G11, G12 green; *bank* clusters on the device ≤ 10 s |
| **M4 Constellation + full notebook + exports** (N10, N7 continues) | overlay constellation; notebook layers, as-of and compare-interpretations; HTML bundle | journey step 9; export fixtures |
| **M5 Polish + integration** (N11) | full packs on the device, accessibility audit, perf pass, HANDOFF | `device-check.sh full` green; VoiceOver run documented |

### 8.2 Work packages: exclusive ownership, frozen contracts consumed, tests, acceptance

**Frozen at the M0 merge (N0 owns them; additive changes only, through N0):**
- `ScrollsCore` public API;
- `Contracts/*.swift`;
- the `AtlasAPI` protocol;
- `UserAct`;
- `JobTask`/`JobContext`;
- `CanonicalDocument`/`CanonicalRelationship`/`CanonicalAnnotation`;
- `DisplayList`, `TimeScale`, `LaneSeries` and `HitGrid` types;
- `EvidenceStyle`;
- `Palette`;
- `schema.sql` + `device-deltas.sql`;
- the golden fixture format;
- `Package.swift`, `project.yml`, `Tools/*.sh`.

| WP | Owns (exclusively) | Consumes | Tests (incl. differential) | Acceptance |
|---|---|---|---|---|
| **N0 Foundation** | `Native/project.yml`, `ScrollsKit/Package.swift`, `ScrollsCore/**`, `ScrollsStore/**`, `ScrollsEngine/{AtlasAPI,PreviewAtlas,JobQueue,JobContext,Health}.swift`, `ScrollsTimeline/{TimeScale,Tiers,Folded,DisplayList,LaneSeries,HitGrid}.swift` (types), `Scrolls/App/**`, `Tools/**`, `scripts/golden.mjs` (reference repo), placeholders in `Native/Docs/` | — | G1, G2, G3, contract round-trip, store tests (DDL executes; triggers fire; CHECKs reject; WAL concurrency; interrupt), CopyLint | the device probe passes on his iPhone 15 Pro Max; the demo atlas opens; bench numbers recorded in `Docs/VERIFICATION.md` |
| **N1 Text + Ingest** | `ScrollsText/**`, `ScrollsIngest/**`, `ScrollsStore/TextStore.swift`, `Scrolls/Import/{ImportWizard,FileStep,MappingStep,ValidateStep,CommitStep}.swift` | Core, Store, `UserAct.importCommit` | G4, G5, G6, G7 (the writer half), offset round-trip (every passage slice equals its original), chunk-codec tests, malformed-input messages | a CSV from Files imports on the device with a problem list; Revert works |
| **N2 Adapters + Packs + CLI** | `ScrollsAdapters/**`, `ScrollsEngine/{BootstrapCipher,PackBuilder}.swift`, `ScrollsEngine/Tasks/{AdapterLoad,BootstrapCipher,DemoLoad}.swift`, `ScrollsStore/SourceStore.swift`, `scrolls-cli/**`, `Scrolls/Import/{PacksView,StorageView}.swift`, `Resources/Bundled/**` | N1's `DocumentWriter` | G7 (adapters), reconciliation counts per collection equal to the reference (94,385 works; 179,014 endpoints; 691 + 450 + 375 books; 118,466 OpenAlex works; 381,800 citations), demo rebuild checksum | Cipher meta phase A ≤ 60 s **on the device**; the text pack builds by continued processing and survives backgrounding |
| **N3 Query** | `ScrollsQuery/**`, `ScrollsEngine/Atlas+{Search,Timeline,Passages,Documents,KWIC,Corpora,Baseline}.swift`, `ScrollsEngine/Tasks/Materialize.swift` | Store, Text | G8, G9 (with conservation), the cube equals SQL denominators on 1,000 random slices, perf tests | tiles budgets of §5 on the device |
| **N4 Timeline + renderer** | `ScrollsTimeline/{Model,DisplayBuilder,ArcGeometry,A11ySummary,SVGWriter,DisplayListCanvas,LaneLayout}.swift`, `Scrolls/Scroll/**` | `DisplayList` types, `AtlasAPI` (`PreviewAtlas` until N3 lands) | G14, the Metal vs Canvas pixel test, the table-identity test, the gesture UI tests, signpost perf tests | **every row of the §4.21 budget table on the device**; every §4.7 row visible in the demo |
| **N5 Shell, Inspector, Search, Tour, Settings** | `Scrolls/{Shell,Inspector,Search,Tour,Settings}/**` | `AtlasAPI`, `ScrollModel` public surface (from N4, frozen at M1 start) | snapshot tests at AX sizes; the copy lint; the first-minute XCUITest (t marks by signpost) | the first-minute script of §4.16 on the device, timed |
| **N6 Compare + analysis core** | `ScrollsAnalysis/{Stats,Intervals,Bootstrap,PRNG,Collocations,Keyness,Composition,Multiplicity,Gates,TokStream,Compare,Tone,BaselineRho}.swift`, `ScrollsEngine/Atlas+{Compare,Collocations}.swift`, `Scrolls/Compare/**` | Query | G10, the demo Compare calibration (§9.6), the `Gated<T>` no-numeral test | journey step 7 on the device ≤ 1.5 s |
| **N7 Provenance, Notebook, Views** | `ScrollsProvenance/**`, `ScrollsEngine/Atlas+{Annotations,Relationships,Views,Export}.swift`, `Scrolls/{Notebook,Views}/**` | Query, `UserAct` | the trigger tests through the API, journal replay (crash-injection between steps 1 and 2), D17 as-saved, the D18 re-anchoring after a synthetic rebuild, export fixtures | an annotation survives app delete → restore from an iCloud backup simulation (journal only) → rebuild |
| **N8 Lineage** | `ScrollsLineage/**`, `ScrollsEngine/Tasks/{ReuseIndex,Boilerplate,Trace}.swift`, `Atlas+{Lineage,Genealogy,Trace}.swift`, `Scrolls/Lineage/**` | Query, Analysis core | G13, the canary test, path costs | *Funky Drummer* genealogy 32/98/48 over 3 generations on the device |
| **N9 Clusters, spaces, drift, tone jobs** | `ScrollsAnalysis/{Cooc,PPMI,RSVD,Procrustes,LinAlg,TFIDFHash,OccVec,KMeans,Stability,Labels,Transitions,Convergence,Slices,Drift}.swift`, `ScrollsEngine/Tasks/{Cluster,Vectors,Drift,Tone,TokStream}.swift`, `ScrollsQuery/ClusterLanes.swift` (moved from N3 at M2) | Analysis core | G11, G12, admission and peak-memory tests | *bank* on the device ≤ 10 s; the English space overnight |
| **N10 Constellation** | `ScrollsAnalysis/Layout.swift`, `Atlas+Constellation.swift`, `Scrolls/Constellation/**` | Analysis core | layout determinism (FNV seed), "positions never move on period change" test | demo P6 constellation on the device |
| **N11 Integration** | `Native/Docs/{HANDOFF,VERIFICATION}.md`, `Tools/device-check.sh` extensions, the final journey | everything | the full journey, perf, accessibility | `device-check.sh full` green; a VoiceOver walk-through recorded |

**Coordination rules (the SPEC §12.6 pattern).**
- No file has two owners.
- A WP that needs a contract change asks N0.
- `Package.swift` target blocks are edited only by the target's owner.
- Every WP finishes a P1 slice first: the demo path end to end in its area.
- Each WP's status goes in its pre-created `Native/Docs/status/<WP>.md`.

### 8.3 Acceptance mechanics

- **Simulator:** `Tools/ci.sh` (the §2.4 table) on the iPhone 17 Pro Max simulator, including the XCUITest journey with screenshots.
- **His phone:** `Tools/build.sh device`, then `Tools/device-check.sh [journey|perf|packs|full]`. That installs, launches with `-selftest …`, retrieves `selftest/result.json` and prints PASS/FAIL with the timings. A row in the §4.21 or §5 tables "passes" only on the device.

### 8.4 Documents to pre-create (agents cannot create `.md` files)

- `Native/README.md`
- `Native/Docs/NATIVE-SPEC.md` (the synthesizer's)
- `Native/Docs/PORT-MAP.md`
- `Native/Docs/DEVICE-DATA.md`
- `Native/Docs/EXPERIENCE.md`
- `Native/Docs/RENDERER.md`
- `Native/Docs/PACK-FORMAT.md`
- `Native/Docs/VERIFICATION.md`
- `Native/Docs/HANDOFF.md`
- `Native/Docs/status/{N0,N1,N2,N3,N4,N5,N6,N7,N8,N9,N10,N11}.md`
- `Native/ScrollsKit/Tests/Fixtures/golden/README.md`
- `Native/ScrollsKit/Tests/Fixtures/golden/FORMAT.md`

Pack `FORMAT.md` files are generated *inside* packs by `scrolls-cli`. They are archive members, not repository files.
