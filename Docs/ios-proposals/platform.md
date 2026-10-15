<!-- OWNER: platform architect (iOS proposals round, 2026-10-09). One of three independent proposals; the synthesizer writes Docs/IOS-SPEC.md. -->
# iOS proposal: platform — on-device data first

**Angle.** I treat the iPhone as a storage, memory, background-time and transfer problem first, and a UI problem second.
SPEC §1–§4 and §13 stay the law. This document decides:
- where every byte of the atlas lives on the phone, and how it gets there;
- how the engine runs inside iOS limits;
- how the Swift port is proved equal to the Node reference.

**Measured, not assumed.** Every number marked **(measured)** was taken on 2026-10-09 on this Mac (M1 Max, Darwin 27.2). The load average was 300–900 during the session, so timings are pessimistic. I measured:
- with `/usr/bin/sqlite3` 3.54.0, read-only (`immutable=1`) on `~/Developer/scrolls-snapshots/m5-stemm/scrolls.db`, and on an APFS clone of that file in the scratchpad (the live database was never opened);
- with small `xcrun swiftc -O` probes (`import SQLite3`, `Compression`).

Estimates are marked **(est.)** and say what they are scaled from.

---

## 0. Decisions in one page

| # | Decision | Why |
|---|---|---|
| P1 | Code lives in `Scrolls/Native/`. The engine is a SwiftPM package, **ScrollsKit**, with 4 library targets and 1 Mac CLI. The app target is **ScrollsApp**. | Same idiom as Loom/Rheo. The engine builds and tests on the Mac and runs unchanged on the phone. |
| P2 | **One SQLite file, the atlas**, on the system `SQLite3`. It uses the reference DDL verbatim plus 10 written **device deltas** (Δ1–Δ10). Text lives in compressed chunks inside the same file. | The DDL, CHECKs and triggers carry I3/I4/D7/D17. Keeping them makes the reference SQL portable and the differential tests meaningful. |
| P3 | **The device atlas holds the full corpus in ≈ 2.1 GB** (measured: 1,742 MB database + 365 MB text), against 3.4 GB plus 2.2 GB of originals and sources for the reference. Target **≤ 3.0 GB** for everything durable, hard ceiling **3.5 GB**. | Slimming removes bytes that no reader uses, never evidence (§3.2). |
| P4 | **Two ways to produce the atlas, one engine.** <br>• Cipher is **built on the phone** from source packs bundled in the app (the D10 first minute). <br>• STEMM and the heavy derived artefacts are **built on the Mac** by the same engine (`scrolls build`), then pushed with `devicectl`, Finder or AirDrop and swapped in. <br>The phone can also load STEMM from a source pack. Both paths must give the same **atlas fingerprint**. | The first minute and imports prove the port on real hardware. A 400 MB STEMM load plus PPMI-SVD should not depend on a phone's thermal envelope. |
| P5 | **User state stays in the atlas** (same tables, triggers and FTS), written through an **append-only journal**. The journal lives outside the atlas, is backed up to iCloud, and is replayed into any new atlas. **No SwiftData.** | D17/D18 and append-only revisions are enforced by SQLite triggers. The atlas (2 GB) must be excluded from backup; the notebook must not be lost. |
| P6 | Concurrency: <br>• one `AtlasWriter` actor and 3 `ReadConnection` actors, each on its own serial `DispatchSerialQueue` executor so blocking SQLite never sits on the cooperative pool; <br>• a `JobQueue` actor with dependencies (`after:`), resumable chunked tasks, `sqlite3_interrupt` for timeouts and cancellation, and QoS mapping (interactive work on P-cores, jobs on E-cores). | This is D11 on iOS, and it closes the reference's open item: analysis jobs no longer hold the writer slot. |
| P7 | Background work: <br>• foreground jobs commit every ≤ 5 s; <br>• `beginBackgroundTask` lets the current chunk finish; <br>• **`BGContinuedProcessingTask`** handles user-started long work (Cipher full text, a STEMM load, rebuilds) with the system progress UI; <br>• **`BGProcessingTask`** (external power) handles maintenance. <br>Thermal and Low Power Mode throttle through LabKitCore's `DeviceConditions`. | Nothing assumes a job finishes in one session. |
| P8 | The Scroll renders with a **Metal renderer of the shared display list**, which keeps the reference's model → display list → painter split. A Core Graphics painter of the same list produces PNG/SVG snapshots and tests. SwiftUI is used for chrome only. | 20,000 cells + 4,000 marks + 300 arcs at 120 Hz is a GPU job. One display list keeps "what is drawn = what is exported = what is hit-tested". |
| P9 | **Differential testing is the definition of done.** <br>• Node exports golden fixtures per module. <br>• Swift tests compare exactly wherever the reference is deterministic. <br>• Table fingerprints compare whole atlases built by both engines. <br>• An API journey runs against both. | The reference is the specification that runs. |
| P10 | **LabKit adoption:** LabKitCore (`DeviceConditions`, `CopyLint`), LabKitFeedback (haptic detents), and selected LabKitUI chrome (chips, toggles, info sheet, banners). <br>**Not adopted:** knobs, LabKitRender, sensors, physics, and **not `ProvenanceBadge`**, whose vocabulary would collide with the evidence encoding. | Scrolls is an instrument for reading evidence, not a physics toy. |

---

## 1. Architecture

### 1.1 Folder layout

The web build stays where it is as the reference. Everything native lives under `Native/`; the git repository is still `~/Developer/git/Scrolls.git`. Owners in brackets refer to the work packages of §8.

```
Scrolls/
  Docs/ … (unchanged; the SPEC stays the law)
  tools/golden/                      [N0, then each WP adds its own exporter file]  Node golden exporters (new .mjs files)
    export-shared.mjs  export-text.mjs  export-ingest.mjs  export-aggregate.mjs  export-analysis.mjs
    export-lineage.mjs export-timeline.mjs  make-cipher-slice.mjs  fingerprint.mjs  journey.mjs  validate-contracts.mjs
  Native/
    project.yml                      [N0]   XcodeGen, iOS 27, iPhone only
    Tools/build.sh                   [N0]   sim | device | install | test | cli   (mirrors Native + ../../LabKit to $TMPDIR)
    Tools/check.sh                   [N0; stage sections owned per WP]  CI-like gate (§2.6)
    Tools/golden.sh                  [N0]   runs tools/golden/*.mjs with the DYLD workaround
    Tools/atlas.sh                   [N2]   pack | build | fingerprint | push-pack | push-atlas | pull-diagnostics
    Docs/                            (pre-created placeholders, §8.6)
    ScrollsKit/
      Package.swift                  [N0]
      Sources/ScrollsCore/           pure, nonisolated, no SQLite: Vocab(+Generated), IDs, Dates, Tokenizer(+TokenClassTable),
                                     ViewState, EvidenceStyle, Format, Contracts/, Timeline/ (model, display list, scale, tiers,
                                     folded, hit grid, svg, a11y table, tile cache)
      Sources/ScrollsStore/          SQLite3 + Compression + CryptoKit: Connection, StatementCache, Pragmas, Schema (schema.sql
                                     verbatim + device-deltas.sql), AtlasWriter, ReaderPool, TextStore, Pack (format r/w),
                                     Capability probe, Fingerprint
      Sources/ScrollsEngine/         Accelerate: Ingest/ Text/ Writer/ Adapters/ Packs/ Aggregate/ Analysis/ Lineage/
                                     Provenance/ Journal/ Jobs/ Export/ Service/ Config/
      Sources/ScrollsNL/             NaturalLanguage adapter (tone, modern-reader neighbours); iOS + macOS
      Sources/scrolls/               Mac CLI (ArgumentParser-free; hand-rolled argv) — build, pack, fingerprint, api, convert, verify, bench, push
      Tests/ScrollsCoreTests/  ScrollsStoreTests/  ScrollsEngineTests/  ScrollsDifferentialTests/
      Tests/Fixtures/golden/<area>/*.json   (generated; INDEX.json records reference commit, node, ICU 78.3, Unicode 17.0)
    ScrollsApp/
      App/        ScrollsApp.swift, AppModel.swift, EngineHost.swift, Lifecycle.swift, DeepLinks.swift
      Platform/   Storage.swift, Inbox.swift, AtlasSwap.swift, Background.swift, FileImport.swift, ShareExport.swift,
                  Diagnostics.swift, Haptics.swift, ThemeTokens.swift
      Scroll/     ScrollScreen.swift, ScrollCanvas.swift (UIViewRepresentable MTKView), ScrollRenderer.swift, Scroll.metal,
                  TextAtlas.swift, Gestures.swift, Playhead.swift, Shelves.swift, Minimap.swift, Legend.swift, TableAlternative.swift
      Inspector/  Compare/  Lineage/  Constellation/  Notebook/  Search/  Import/  Tour/  Jobs/  Settings/  Shared/
      Resources/  Assets.xcassets, Info.plist (generated by XcodeGen), Starter/ (build product, not in git), Packs/ (build product)
    ScrollsAppTests/   (simulator: journal, swap, background expiry, storage guard, render goldens)
    ScrollsUITests/    (the journey, the first minute, accessibility audits)
```

`project.yml` (abridged). It follows Loom's conventions: Swift 6, `SWIFT_DEFAULT_ACTOR_ISOLATION: MainActor` in the app target, team YOUR_TEAM_ID, dark, and Debug engine builds at `-O`.

```yaml
name: Scrolls
options: { bundleIdPrefix: com.utkarsh, deploymentTarget: { iOS: "27.0" }, xcodeVersion: "27.0", createIntermediateGroups: true }
packages:
  ScrollsKit: { path: ScrollsKit }
  LabKit: { path: ../../LabKit }          # Tools/build.sh mirrors LabKit beside Scrolls/Native, like Rheo
settings: { base: { SWIFT_VERSION: "6.0", SWIFT_APPROACHABLE_CONCURRENCY: YES, SWIFT_STRICT_CONCURRENCY: complete,
                    DEVELOPMENT_TEAM: ""
targets:
  Scrolls:
    type: application
    platform: iOS
    sources: [ { path: ScrollsApp, excludes: ["Resources/Starter", "Resources/Packs"] },
               { path: ScrollsApp/Resources/Starter, type: folder, buildPhase: resources, optional: true },
               { path: ScrollsApp/Resources/Packs,   type: folder, buildPhase: resources, optional: true } ]
    dependencies:
      - { package: ScrollsKit, product: ScrollsEngine }
      - { package: ScrollsKit, product: ScrollsNL }
      - { package: LabKit, product: LabKitCore }
      - { package: LabKit, product: LabKitUI }
      - { package: LabKit, product: LabKitFeedback }
    info:
      path: ScrollsApp/Resources/Info.plist
      properties:
        CFBundleDisplayName: Scrolls
        UIUserInterfaceStyle: Dark
        CADisableMinimumFrameDurationOnPhone: true          # 120 Hz
        UISupportedInterfaceOrientations: [UIInterfaceOrientationPortrait, UIInterfaceOrientationLandscapeLeft, UIInterfaceOrientationLandscapeRight]
        UIFileSharingEnabled: true                           # Finder → Scrolls → Documents (packs, atlases, imports)
        LSSupportsOpeningDocumentsInPlace: true              # Files → On My iPhone → Scrolls
        UIBackgroundModes: [processing]
        BGTaskSchedulerPermittedIdentifiers: [com.utkarsh.scrolls.maintenance, "com.utkarsh.scrolls.job.*"]
        CFBundleURLTypes: [ { CFBundleURLSchemes: [scrolls], CFBundleURLName: com.utkarsh.scrolls } ]
        # CFBundleDocumentTypes / UTExportedTypeDeclarations: .scrollspack, .scrollsatlas (package), .scrollsview (JSON);
        # UTImportedTypeDeclarations: .jsonl; document types for txt, md, csv, tsv, json, jsonl (LSHandlerRank Alternate)
        ITSAppUsesNonExemptEncryption: false
    entitlements: { properties: { com.apple.developer.kernel.increased-memory-limit: true } }   # requested; budgets do not depend on it
    settings:
      base: { PRODUCT_BUNDLE_IDENTIFIER: com.utkarsh.scrolls, TARGETED_DEVICE_FAMILY: "1", SWIFT_DEFAULT_ACTOR_ISOLATION: MainActor,
              ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon, ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: AccentColor, SUPPORTS_MACCATALYST: NO }
    postCompileScripts: [ { name: Strip extended attributes, script: '/usr/bin/xattr -cr "$TARGET_BUILD_DIR/$WRAPPER_NAME" || true' } ]   # Cipher's iCloud fix
```

`Tools/build.sh` mirrors `Scrolls/Native` and `LabKit` side by side into `$SCROLLS_BUILD_DIR` (default `$TMPDIR/ScrollsBuild`); parallel agents each pass their own directory. It then:
- runs `xcodegen`;
- **caches two build products** keyed by the hash of the engine sources: `Starter/starter.atlas` (the demo, built by `scrolls build --packs demo`) and `Packs/cipher-*.scrollspack` (built by `scrolls pack` from the Cipher root);
- with `SCROLLS_BUNDLE_PACKS=0`, leaves the 190 MB of packs out of fast development installs. The app then finds the packs pushed once into its container (§3.6).

It never builds inside `~/Documents`.

### 1.2 Package targets and isolation

```swift
// swift-tools-version: 6.4   (matches LabKit; .iOS(.v27)/.macOS(.v27) need 6.4)
let package = Package(
  name: "ScrollsKit",
  platforms: [.iOS(.v27), .macOS(.v27)],
  products: [
    .library(name: "ScrollsCore", targets: ["ScrollsCore"]), .library(name: "ScrollsStore", targets: ["ScrollsStore"]),
    .library(name: "ScrollsEngine", targets: ["ScrollsEngine"]), .library(name: "ScrollsNL", targets: ["ScrollsNL"]),
    .executable(name: "scrolls", targets: ["scrolls"]),
  ],
  targets: [
    .target(name: "ScrollsCore", resources: [.copy("Resources/token-classes-u61m-1.bin")], swiftSettings: fast),
    .target(name: "ScrollsStore", dependencies: ["ScrollsCore"], resources: [.copy("Resources/schema.sql"), .copy("Resources/device-deltas.sql")],
            linkerSettings: [.linkedLibrary("sqlite3")], swiftSettings: fast),
    .target(name: "ScrollsEngine", dependencies: ["ScrollsCore", "ScrollsStore"],
            resources: [.copy("Resources/stopwords"), .copy("Resources/field-taxonomy.json"), .copy("Resources/demo")],
            swiftSettings: fast + [.unsafeFlags(["-Xcc", "-DACCELERATE_NEW_LAPACK"])]),
    .target(name: "ScrollsNL", dependencies: ["ScrollsEngine"]),
    .executableTarget(name: "scrolls", dependencies: ["ScrollsEngine", "ScrollsNL"]),
    .testTarget(name: "ScrollsCoreTests", dependencies: ["ScrollsCore"]),
    .testTarget(name: "ScrollsStoreTests", dependencies: ["ScrollsStore"]),
    .testTarget(name: "ScrollsEngineTests", dependencies: ["ScrollsEngine"]),
    .testTarget(name: "ScrollsDifferentialTests", dependencies: ["ScrollsEngine", "ScrollsNL"], resources: [.copy("Fixtures")]),
  ],
  swiftLanguageModes: [.v6])
let fast: [SwiftSetting] = [.unsafeFlags(["-O"], .when(configuration: .debug))]   // Loom's rule: the engine is arithmetic
```

- Package targets are **nonisolated by default**: every engine type is `Sendable` or confined to an actor. The app target is MainActor by default; view models are `@MainActor @Observable` and talk to the engine only through `async` calls and the event stream.
- **ScrollsEngine does not import LabKit.** It declares `protocol DeviceConditionsSource: Sendable { var throttle: Throttle { get } }`, and the app bridges LabKitCore's `DeviceConditions.current` into it. The CLI passes `.unthrottled`.
- **Zero third-party dependencies** (Foundation, Accelerate, Compression, CryptoKit, SQLite3, NaturalLanguage, Metal, BackgroundTasks, UniformTypeIdentifiers, Charts). **No networking code at all** (honesty rule 16). The four fetchers stay Node scripts that he runs on the Mac.

### 1.3 SQLite access layer (system `SQLite3`, verified)

**Capabilities (measured).** `import SQLite3` from Swift on macOS 27 links **SQLite 3.54.0**, and all of the following work:
- the exact tokenizer `unicode61 remove_diacritics 2 categories 'L* N* Co M* So'` (`ગુજરાતી ◉ हिन्दी café` → 4 tokens, Gujarati and Devanagari whole, `◉` kept);
- `contentless_delete=1`, `fts5vocab … instance`, phrase queries, trigram, `rtree_i32`, JSON1 and `STRICT`.

Compile options are `THREADSAFE=2` (multi-thread: one connection per thread at a time), `DEFAULT_MMAP_SIZE=0` and `MAX_MMAP_SIZE=1073741824`. The iOS 27 library should be the same release; the M0 **capability probe** (`SQLiteCapabilities.probe()`) runs in a unit test on the simulator and on his iPhone, and its result is part of `health()`.

```swift
public final class Connection: @unchecked Sendable {             // confined: only its owning actor touches it
  init(path: String, mode: OpenMode, role: Role) throws            // SQLITE_OPEN_NOMUTEX; role = .writer | .reader(n) | .cli
  func prepared(_ sql: SQL) throws -> Statement                    // cache keyed by SQL.id; sqlite3_prepare_v3(PERSISTENT)
  func exec(_ sql: String) throws
  func interrupt()                                                 // thread-safe: sqlite3_interrupt
  func setProgressHandler(every n: Int32, _ shouldStop: @escaping @Sendable () -> Bool)
}
public struct SQL: Sendable, Hashable { public let id: StaticString; public let text: StaticString }  // every statement lives in a catalog
public struct Statement { mutating func bind(_ v: some SQLBindable..., ) throws; mutating func step() throws -> Bool;
                          func column<T: SQLColumn>(_ i: Int32) -> T; mutating func reset() }

public actor AtlasWriter {                                          // executor: DispatchSerialQueue(label: "atlas.writer", qos: .utility)
  public nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }
  public func transaction<T: Sendable>(_ label: StaticString, immediate: Bool = true,
                                       _ body: (inout WriteTx) throws -> T) throws -> T        // BEGIN IMMEDIATE … COMMIT; bumps data_version if asked
  public func bulk(_ phase: StaticString, _ body: (inout BulkTx) throws -> Void) throws         // wal_autocheckpoint=0, commit every 5,000 docs / 50,000 rows
  public func checkpoint(_ mode: CheckpointMode) throws -> WALStatus
}
public struct ReaderPool: Sendable {                                 // 3 ReadConnection actors (D11), each on its own serial queue
  public func read<T: Sendable>(qos: QoS = .userInitiated, timeout: Duration = .seconds(5),
                                _ body: @Sendable (ReadTx) throws -> T) async throws -> T     // timeout → interrupt → ScrollsError.queryTimeout(hint:)
}
```

**Pragmas.**

| Pragma | Value |
|---|---|
| `journal_mode` | `WAL` |
| `synchronous` | `NORMAL` |
| `foreign_keys` | `ON` |
| `busy_timeout` | `5000` |
| `temp_store` | `MEMORY` |
| `cache_size` | readers −32768 (32 MB), writer −65536 |
| `mmap_size` | 268435456 (256 MB) |
| `wal_autocheckpoint` | 1000; 0 during bulk phases, then `wal_checkpoint(TRUNCATE)` |

**WAL and file safety.**
- When `scenePhase` becomes `.background`, the app runs `wal_checkpoint(PASSIVE)`.
- The atlas stays in the app's **own** container, never an App Group container: a suspended app holding a SQLite lock in a shared container is killed with `0xdead10cc`.
- `NSFileProtectionCompleteUntilFirstUserAuthentication` is set explicitly, so background tasks can open the atlas while the phone is locked.

**Statement catalog and plan tests.**
- Every SQL text lives in an `enum SQLCatalog` file per area (`AggregateSQL`, `LineageSQL`, …), never inline.
- A test runs `EXPLAIN QUERY PLAN` for every catalog entry against the demo atlas. It asserts no full scan of `passage`, `document`, `relationship`, `doc_tag` or `expr_doc` unless the entry is marked `.scanOK`.
- That test is how Δ5 (dropping `passage_time`) is proven safe.

**Text never goes through SQL.** `TextStore.slice(document:utf16:)` (§3.4) is the only reader of document text. Search, KWIC, materialize, reader and trace call it.

### 1.4 Jobs: actors, task groups, cancellation, progress

```swift
public struct JobType: RawRepresentable, Sendable, Hashable { … }    // the reference's JOB_TYPES, generated from vocab.mjs
public protocol JobTask: Sendable {
  static var type: JobType { get }
  static var writes: WriteNeed { get }      // .none | .commitsOnly (holds the writer only inside ctx.commit) | .exclusive (bulk loads)
  static var resumable: Bool { get }        // reads its cursor back from the atlas (committed chunks only)
  static var budget: ResourceBudget { get } // memory MB, threads, may run in background?
  func run(_ ctx: JobContext) async throws -> JobResult
}
public struct JobContext: Sendable {
  public let id: JobID; public let readers: ReaderPool; public let writer: AtlasWriter; public let text: TextStore
  public func checkpoint() throws                                   // ≤ every 200 ms of work: Task.checkCancellation + suspend request + thermal pause
  public func commit<T: Sendable>(_ label: StaticString, _ body: (inout WriteTx) throws -> T) async throws -> T
  public func report(_ fraction: Double, phase: String, counts: [String: Int] = [:])   // throttled 100 ms → EngineEvent; job row every 2 s
  public var parallelism: Int { get }                               // DeviceConditions → 6/4/2/1 (nominal/fair/serious/critical)
  public func concurrentMap<T: Sendable, R: Sendable>(_ items: [T], _ f: @Sendable (T) throws -> R) async throws -> [R]  // TaskGroup, ordered results
}
public actor JobQueue {
  public func enqueue(_ type: JobType, params: JobParams, priority: Int? = nil, after: [JobID] = []) throws -> JobID
  public func cancel(_ id: JobID)                       // acknowledged ≤ 500 ms: flag + sqlite3_interrupt of the job's connection
  public func suspendAll(within: Duration) async        // app → background without a continued-processing lease
  public func resumeInterrupted() throws                // boot: running → interrupted; resumable types re-enqueue from their cursor
  public nonisolated func events() -> AsyncStream<EngineEvent>
}
public enum EngineEvent: Sendable { case job(JobSnapshot), dataVersion(Int), adapter(AdapterStatus), bootstrap(BootstrapStatus),
                                    atlas(AtlasEvent), journal(UInt64), thermal(Throttle) }
```

**Scheduling.**
- One `.exclusive` writer job runs at a time, plus up to two read-only or `.commitsOnly` jobs (`parallelism`-aware).
- Interactive reads always go first: they run on their own reader actors at `.userInitiated` QoS, so the scheduler prefers the A17's two P-cores. Jobs run at `.utility` or `.background` QoS, mostly on the four E-cores, which is better for heat and battery.
- `after:` dependencies replace the reference's reliance on writer serialization (materialize → cluster → label). This fixes HANDOFF's unfinished "analysis jobs still take the writer slot".
- `materialize`, `trace`, `layout` and `import` are interactive (priority 1–2). `bootstrap`, `adapter-load`, `vectors` and `reuse-index` are background (priority 6–9).

**Chunking.**
- Every long task commits a chunk at least every **5 s** (the reference used 20 s).
- When the app leaves the foreground without a continued-processing lease, `suspendAll(within: .seconds(5))` finishes the current chunk inside the ≈ 30 s that `beginBackgroundTask` grants.
- The cursor (for example the last committed Gutenberg id) is read back from committed rows, never from memory, so a killed app resumes where it stopped (the reference's `bootstrap-cipher` rule).

### 1.5 Routes become an in-process API

The 60 endpoints of contract 1.3.0 become one `ScrollsService` protocol. The JSON shapes become `Codable & Sendable` value types with the reference's snake_case keys, so the same objects serve exports, the CLI's `api` command and the contract differential (§2.5).

```swift
public protocol ScrollsService: Sendable {
  func health() async -> Health
  func search(_ r: SearchRequest) async throws -> SearchResponse
  func trackExpression(_ r: ExpressionCreate) async throws -> ExpressionResponse
  func setVariants(_ id: ExpressionID, _ p: VariantsPatch) async throws -> ExpressionResponse
  func timelineQuery(_ r: TimelineQueryRequest) async throws -> TimelineQueryResponse
  func tiles(_ r: TilesRequest) async throws -> TilesResponse
  func marks(_ r: MarksRequest) async throws -> MarksResponse
  func arcs(_ r: ArcsRequest) async throws -> ArcsResponse
  func shelf(_ r: ShelfRequest) async throws -> ShelfResponse
  func bin(_ r: BinRequest) async throws -> BinResponse
  func passage(_ id: PassageID, context: Bool) async throws -> PassageResponse
  func document(_ id: DocumentID) async throws -> DocumentResponse
  func documentText(_ id: DocumentID, utf16: Range<Int>) async throws -> DocumentTextResponse   // ≤ 20k UTF-16 units
  func kwic(_ r: KwicRequest) async throws -> KwicResponse
  func compare(_ r: CompareRequest, session: SessionID) async throws -> CompareResponse
  func collocations(_ r: CollocationsRequest) async throws -> CollocationsResponse
  func clusters(_ r: ClustersRequest) async throws -> ClustersResponse
  func constellation(_ r: ConstellationRequest) async throws -> ConstellationResponse
  func lineage(_ r: LineageRequest) async throws -> LineageResponse
  func genealogy(_ r: GenealogyRequest) async throws -> GenealogyResponse
  func trace(_ r: TraceRequest) async throws -> TraceOutcome      // .done(TraceResponse) | .continuing(JobID, partial:)  (≤ 1.5 s sync)
  func review(_ id: RelationshipID, _ a: ReviewAction) async throws -> RelationshipCard            // journaled
  func createAnnotation(_ r: AnnotationCreate) async throws -> AnnotationResponse                  // journaled
  func saveView(_ r: ViewSave) async throws -> SavedViewResponse                                   // journaled, D17
  func stageImport(_ file: URL, collection: CollectionSpec) async throws -> ImportStaged          // copies + hashes the original first
  func commitImport(_ id: ImportID, _ m: ImportMapping) async throws -> JobID                     // journaled
  // … the remaining endpoints of SPEC §7.1 / API.md 1.3.0, one method each (jobs, corpora, facets, adapters, baseline, tour,
  //   expressions, occurrences, etymology, export, snapshot, runs, lineage path, relationships, hypothesis groups, annotations list,
  //   revisions, reinterpret, withdraw, views list/get/delete, import preview/validate/problems/revert)
}
public struct Provenance: Codable, Sendable { public let dataVersion: Int; public let runIDs: [RunID]; public let tokenizer = "u61m-1"
  public let segmenter = "seg-1"; public let synthetic: Bool; public let collections: [String]; public let licenses: [String] }
public struct Gated<Value: Codable & Sendable>: Codable, Sendable {           // I4 in the type system
  public let gate: GateCode; public let needed: [String: Double]?; public let have: [String: Double]?; public let suggestion: Suggestion?
  public let value: Value?                                                    // init precondition: gate == .ok ⇔ value != nil
}
public struct ScrollsError: Error, Codable, Sendable { public let code: ErrorCode; public let message: String; public let hint: String; public let detail: JSONValue? }
```

How the reference's HTTP plumbing maps:
- **ETags** become an in-memory response cache keyed by `(request hash, data_version)`: an LRU of 64 MB, cleared on a memory warning.
- **SSE** becomes `EngineEvent` streams.
- **Host/Origin security, static serving and mock mode are dropped.** SwiftUI previews read golden fixtures instead.
- **`X-Scrolls-Session`** becomes a `SessionID` minted per app launch; it is used only for the multiplicity log.

### 1.6 Port map (reference → Swift)

Status: **P** = ported (same algorithm and outputs); **R** = redesigned for the phone (same semantics); **D** = dropped.

| Reference (lines) | Swift | Status | Notes |
|---|---|---|---|
| `src/shared/tokenize` (128) | `ScrollsCore/Tokenizer.swift` + `TokenClassTable` | P, exact | The token class of every scalar comes from a table exported by Node (Unicode 17.0, U+166D excluded), not from Swift's own Unicode tables. Folding implements **Final_Sigma**: Swift `"ΣΑΣ".lowercased()` = "σασ", JS = "σας" (measured; `NSString.lowercased` = "σας"). |
| `dates` (729) | `Dates.swift` | P, exact | `dayFromYMD` uses proleptic Gregorian integer arithmetic (no `Calendar`); years 0–99 and −4499 are tested. |
| `viewstate` (611) | `ViewState.swift` | P, exact | Identical hash strings, so web and phone links share one grammar. |
| `vocab` (456), `evidence-style` (141), `format`, `ids` (193) | `Vocab+Generated.swift` (generated by `export-shared.mjs`), `EvidenceStyle.swift`, `Format.swift`, `IDs.swift` | P, exact | `mulberry32` is ported bit-exact (UInt32 `&*` for `Math.imul`); FNV-1a-32 and `canonicalJson` likewise. |
| `contracts` (818) | `Contracts/*.swift` (Codable) | R | Shapes become types. The Node `check(shape)` validates Swift-encoded JSON in CI. |
| `server/db/schema.sql`, `seed-vocab`, `migrate` | `ScrollsStore/Schema` + `device-deltas.sql` | P + Δ | DDL verbatim; Δ1–Δ10 in §3.2. |
| `db/open`, `readpool`, `readworker` | `Connection`, `AtlasWriter`, `ReaderPool` | R | Worker threads become actors on serial queues; the 5 s kill becomes `sqlite3_interrupt`. |
| `db/integrity` | `Store/Integrity.swift` | R | Checks pack and member SHA-256 and user originals instead of `originals/`. |
| `store/document-writer` (1214), `bins`, `dup-index` | `Engine/Writer/*` | P + R | Same rows. Text goes into chunks (Δ1); `original_meta_json` becomes a source pointer when a byte range exists (Δ2); the dup index is an mmap'd file. |
| `ingest/*` (14 files, ≈ 2,900) | `Engine/Ingest/*` | P | Streams through `FileHandle` (2 GB/file); the same issue codes and messages. |
| `text/{segment,langid,names,variants,translit,kwic}` | `Engine/Text/*` | P | Segmentation needs ICU sentence breaks (`Intl.Segmenter`). The Swift side uses `CFStringTokenizer(kCFStringTokenizerUnitSentence)` (Apple ICU); an M0 spike measures parity on every Cipher book (risk R2). |
| `adapters/{demo,cipher/*,stemm/*}` | `Engine/Adapters/*` | P + R | Read source **packs** instead of loose files; same mapping (CIPHER-MAPPING). The demo generator is ported, deterministic and fingerprint-checked. |
| `aggregate/*` (23 files, ≈ 5,600) | `Engine/Aggregate/*` | P + R | Tiles, marks, washes, shelf, bin, arcs, lanes, trail and seams are ported. **cube** becomes an mmap'd column file (clean memory). **materialize** reads only the text chunks holding candidate passages (§5). `cache`/`warm` become an `ArtifactStore` plus launch prewarm. |
| `analysis/*` (27 files, ≈ 7,600) | `Engine/Analysis/*` | P + R | Same algorithms, gates and copy. `kmeans-pool` and the cooc shards become TaskGroups. rSVD uses Accelerate (`sparse_matrix_product_dense_float`, LAPACK `sgesdd`). PPMI is blocked (§5). `tone` calls NaturalLanguage in process (no CLI). |
| `lineage/*` (17 files, ≈ 3,400) | `Engine/Lineage/*` | P | Winnowing runs over varint token streams; the global reuse index is Mac-built by default (§5). |
| `provenance/{anchors,annotations,relationships,reviews,views}` | `Engine/Provenance/*` + `Engine/Journal/*` | P + R | Same rows and triggers; every user write is journaled (§6). |
| `jobs/{queue,context,worker,job-rows,tasks/*}` | `Engine/Jobs/*` | R | §1.4; tasks ported one-to-one (`bootstrap-cipher`, `adapter-load`, `import`, `revert`, `materialize`, `tokstream`, `collocations`, `vectors`, `cluster`, `drift`, `tone`, `layout`, `boilerplate`, `reuse-index`, `trace`, `gc-runs`, `export`). |
| `export/{csv,jsonl,manifest}` | `Engine/Export/*` | P | `export_text_allowed=0` respected. |
| `export/bundle-html` | — | D (v1) | Deferred; JSON/CSV/JSONL + PNG/SVG + `.scrollsview` cover sharing. |
| `http/*` (8 files), `routes/*` (28 files) | `Engine/Service/*` | R/D | Routes become `ScrollsService` methods. Security, static, etag and mock are dropped. |
| `config.mjs` | `Engine/Config/AtlasLocation.swift` | R | Container paths. `E_DB_IN_ICLOUD`'s phone analogue refuses an atlas under `Documents/` or iCloud Drive. |
| `src/ui/timeline/{model,display,scale,tiers,folded,hit,svg,a11y-table,clusters,share-cells,seams,coverage,arc-summary,tiles-client}` | `ScrollsCore/Timeline/*` | P, exact | Pure and Mac-testable; display lists are compared with Node's (§2). |
| `src/ui/timeline/{paint,input,gestures,viewport,playhead,minimap,drawer,snapshot,perf}` | `ScrollsApp/Scroll/*` | R | Metal renderer, UIKit gestures, SwiftUI chrome. |
| `src/ui/{shell,panels,import,tour,core}` | `ScrollsApp/*` | R | SwiftUI (§4). |
| `tools/nl-adapter` | `ScrollsNL` | R | In process. Tone becomes available whenever the language is supported. |
| `tools/fetch/*` | — | stay Node | He runs them on the Mac; `scrolls pack` wraps their output. |
| `scripts/{verify,verify-journey,bench,bootstrap-cipher,build-demo}` | `scrolls verify/bench/build`, `tools/golden/journey.mjs` | R | |

**What stays identical:**
- the schema DDL, triggers and CHECKs;
- tokenizer `u61m-1` and segmenter `seg-1` outputs, the date grammar and the variant rules;
- every gate, threshold, seed, window and copy string;
- run reuse by `(stage, params_hash, input_fingerprint)`;
- the conservation law and the display-list geometry;
- view-state links.

**What changes for the phone:**
- where text and originals live (Δ1, Δ2);
- four write-only or unused structures are not stored (Δ3–Δ5, Δ7);
- `create` revisions point at their row (Δ6);
- the concurrency substrate, background policy and transfer formats;
- the journal;
- the renderer.

---

## 2. Differential testing against the Node reference

### 2.1 Policy: exact where the reference is deterministic

| Module | Fixture input | Comparison |
|---|---|---|
| tokenize | 50k strings: edge cases, 2,000 passages per collection, and **every distinct token type of the Cipher corpus** (folded on both sides) | exact tokens and UTF-16 `[start, end)` |
| dates | every grammar row of §5.3 + 10k fuzzed strings | exact (all fields, warning codes) |
| viewstate, vocab, ids, format, evidence-style | 1,000 random states; table dumps; PRNG sequences | exact |
| segment, langid, names, variants, translit | 200 documents (verse, prose, Wikisource `\f` pages, BOM, no-marker); 5,000 passages; 1,000 cases | exact (langid confidence ≤ 1e-12) |
| ingest parsers + issues | every file in `tests/fixtures/` incl. malformed | exact documents and issues (code, line, col, message, suggestion) |
| DocumentWriter | demo; Cipher slice | **table fingerprints** exact (§2.3) |
| materialize, cube, tiles L0–L5, marks, washes, shelf, bin, arcs, trail | 12 expressions × facets × tiers on demo + Cipher slice | exact counts and states; rates and CIs ≤ 1e-9 relative |
| compare, collocations, keyness, composition, gates, multiplicity | 20 requests | gate codes and suggestions exact; numbers ≤ 1e-9; seeded samples exact |
| kmeans, stability, labels, transitions, convergence | exported vector fixtures | exact assignments and labels (same mulberry32 order, f64 plain loops — no BLAS on these paths) |
| tfidf-hash, occvec, PPMI | mini corpora | co-occurrence counts exact; values ≤ 1e-6 |
| rSVD spaces | mini corpus + Cipher-slice en | subspace equality: top-25 neighbour Jaccard ≥ 0.9 on 200 probes; Procrustes-aligned mean cosine ≥ 0.995 |
| procrustes, drift, baseline ρ | fixtures | gates exact; values ≤ 1e-4; control percentiles within ±1 rank |
| layout (Fruchterman–Reingold) | constellation keys | positions ≤ 1e-6 px |
| winnow, boilerplate, commonplace, near, cues, classify, trace, graph, path, genealogy | Cipher slice + fixtures | exact sets |
| anchors, annotations, reviews, views (D17 as-saved) | scripted operation sequences | exact responses (ids normalized by natural keys) |
| timeline model and display list, a11y table | tiles goldens from the aggregate exporter | exact primitive lists (geometry ≤ 1e-6), exact strings |
| contracts | every Swift response type, encoded | Node `contracts.check(shape)` passes |

The Swift side never uses BLAS where an exact comparison is promised; summation order is the reference's. Accelerate is used where the policy says "tolerance": SVD, sparse products and large cosine matrices.

### 2.2 Golden exporters (Node side)

New files in `tools/golden/` import the reference modules unchanged and write `Native/ScrollsKit/Tests/Fixtures/golden/<area>/<case>.json`, plus `INDEX.json` (reference git commit, node 26.10.0, ICU 78.3, Unicode 17.0). They run under `Tools/golden.sh` with the Homebrew workaround (`DYLD_LIBRARY_PATH=…/simdjson/4.6.11/lib:…/hdrhistogram_c/0.11.10/lib`).

- `export-shared.mjs` writes `Vocab+Generated.swift` (constants, rel_type table, issue codes, job types) and the 1.1 M-entry token-class table (≈ 280 KB, 2 bits per scalar).
- `make-cipher-slice.mjs` writes a deterministic **Cipher slice** to `$TMPDIR/cipher-slice/` with the same file layout as Cipher:
  - 20 Gutenberg books: including *Pride and Prejudice*, *Les Misérables* (declared fr, English text), a Spanish book, both double-BOM cases and two no-marker cases;
  - 5 + 5 Wikisource books;
  - culture-works rows 0–1,999 plus the rows they reference, and their relations;
  - the roots families of words in the slice.
  
  Both engines load it.
- Aggregate, analysis and lineage exporters build a private data directory with the reference code (demo + slice), then dump responses.

### 2.3 Atlas fingerprints (whole-build equality)

`fingerprint.mjs` (Node, on any reference database) and `scrolls fingerprint` (Swift, on any atlas) write the same JSON: `{table: {rows, sha256}}`.
- Each table is hashed over canonical rows ordered by **natural keys**: document `(collection slug, ext_id)`, passage `(doc key, field, ord)`, relationship `(rel_type, src key, dst key, source_dataset, source_locator)`, and so on.
- Surrogate ids are replaced by natural keys. Timestamps, `job*` and caches are omitted.
- Device deltas are normalized: `original_meta_json` pointers are expanded from the pack, and `create` revisions are expanded from their row.

Equal fingerprints mean the two engines wrote the same evidence. Three uses:
1. Swift-built slice vs Node-built slice (every `check.sh slice`);
2. Swift-built full Cipher atlas vs a Node full bootstrap (`check.sh full`);
3. **phone-built vs Mac-built** atlas from the same packs (the device acceptance check, §8.5).

### 2.4 Known divergence register

`Fixtures/golden/DIVERGENCES.json` lists every accepted difference with its reason and owner. Exact modules must have zero entries. Seeded from this session:
- (a) Final_Sigma in `String.lowercased()` — fixed by an explicit rule;
- (b) Swift's Unicode tables vs Node's Unicode 17.0 — fixed by the exported class table;
- (c) `Intl.Segmenter` vs `CFStringTokenizer` — to be measured in M0;
- (d) `localeCompare(…, 'en')`, used for lane, shelf and wash ordering in `lanes.mjs`, `shelf.mjs`, `washes.mjs` and `arcs.mjs`, vs `String.compare(_:options:range:locale:)` — to be measured on all lane labels and titles in M1.

### 2.5 API journey differential

`journey.mjs` runs the reference's acceptance journey (`scripts/verify-journey.mjs`: 19 rows, 140 responses) against a Node server on clone A of the m1 snapshot. It records `requests.jsonl` and `responses.node.jsonl`.

`scrolls convert-reference` turns clone B into an atlas: text moves into chunks, the deltas are applied, and meta stays verbatim because there are no packs. Then `scrolls api atlas < requests.jsonl > responses.swift.jsonl` replays the same requests, including the writes (import, annotation, save, restart and reopen).

The comparison normalizes ids by natural key, timestamps and `data_version`. Each Swift response is also checked against `contracts.check`.

### 2.6 `Native/Tools/check.sh` (the gate)

```
check.sh quick     swift build + swift test (unit + golden fixtures) in a $TMPDIR mirror            ≈ 3–6 min
check.sh golden    regenerate fixtures with node, then quick; fails if fixtures changed unexpectedly ≈ 8 min
check.sh slice     Cipher slice: Node build vs `scrolls build`; fingerprint table PASS/FAIL           ≈ 5 min
check.sh journey   API journey differential on the m1 snapshot (two clones, `cp -c`)                ≈ 10 min
check.sh app       xcodegen + xcodebuild (sim) + ScrollsAppTests + ScrollsUITests (iPhone 15 Pro Max sim)  ≈ 12 min
check.sh device    device build, devicectl install + launch with -diagnostics, pull Documents/Diagnostics/*.json
check.sh full      all of the above + full Cipher atlas both ways + `scrolls bench`                   ≈ 60–90 min
```

Each stage prints a PASS/FAIL table, like `npm run verify`. A stage section of `check.sh` is owned by the work package that owns the code it checks.

---

## 3. On-device data

### 3.1 What the reference stores (measured, m5-stemm snapshot: demo + Cipher + all STEMM)

| Item | Size | Notes |
|---|---|---|
| `scrolls.db` total | **3,389 MB** (3.55 GB decimal) | 394,317 documents · 2.76 M passages · 639k relationships · ≈ 146 M tokens of text |
| `document_text` | 918 MB | 894.6 MB of UTF-8 originals in 62,757 documents (stemm-gutenberg 380, cipher-gutenberg 337, OpenAlex abstracts 65, Wikisource hi 60 and gu 48) |
| `document` | 463 MB | of which `original_meta_json` **266 MB** (OpenAlex 192 MB at 1.7 KB/row) |
| `passage_fts_*` | 430 MB | 392 data + 38 docsize; 2.7 MB per million tokens |
| `relationship_revision` | 250 MB | 593,078 of 595,524 rows are `create` copies of their relationship's immutable fields (318 B of `after_json` each) |
| `passage` + 3 indexes | 364 MB | `passage_time` (55 MB) is **named by no query** |
| `relationship` + 4 indexes | 233 MB | OpenAlex citations are 381,800 of the rows |
| `doc_tag` + index | 228 MB | 768,367 OpenAlex `keyword` tags are **written but read by no module** |
| `date_assertion` + indexes + `date_rtree` | 197 MB | 394,317 `ingestion` rows (one per document; readers exclude them); `date_rtree` (35 MB) is **only written, never queried** |
| `label_tri` | 122 MB | trigram typeahead over 868k labels (a prefix index measured 49 vs 72 MB of data: not worth changing) |
| `doc_minhash` · `doc_bin` · `document_field` · `doc_tokens` · etymology | 32 · 34 · 25 · 13 · 14 MB | |
| outside the DB (live data dir) | originals 1.2 GB · sources 1.0 GB · cache 1.4 GB (892 MB of it is `cache/http`) | |

### 3.2 The device profile: same DDL, ten written deltas

`device-deltas.sql` runs after `schema.sql`. Each delta preserves a reader's result, is listed in the atlas manifest, and is undone by `scrolls fingerprint` normalization.

| Δ | Change | Readers affected | Saving (measured) |
|---|---|---|---|
| Δ1 | `document_text.original` is not stored. A new table `document_text_chunk(document_id, ord, u16_start, u16_end, codec, data BLOB, UNIQUE(document_id, ord))` holds the original in **≈ 32,768-UTF-16-unit chunks, cut at a newline**, compressed with LZFSE (Brotli for texts under 8 KB). `document_text` keeps `body_start/end`, `original_sha256` and `decoder`, plus `u16_len` and `utf8_len`. | Only `TextStore` reads text | 918 → **≈ 356 MB** (LZFSE everywhere measured 365.2 MB; abstracts 43.3 → 34.5 MB with Brotli) |
| Δ2 | `original_meta_json` = `{"$src":"source_file"}` when `source_file_sha256 + source_byte_start/end` point into a pack member (the reference's own >64 KB rule, with threshold 0). Records aggregated from several source rows keep verbatim compact JSON. | "Original record" view: reads the range from the pack | **≈ 300 MB** of `document` |
| Δ3 | No per-document `role='ingestion'` assertion. Ingestion time is `import_batch.committed_at`, which is what Imports/Jobs show. | none (every reader excludes `ingestion`) | ≈ 60 MB |
| Δ4 | `date_rtree` is not created | none (write-only in 1.3.0) | 35 MB |
| Δ5 | `passage_time` is not created | none (plan test, §1.3) | 55 MB |
| Δ6 | `create` rows of `relationship_revision` store `after_json = '{"$row":1}'` and `reason = NULL`. The immutability trigger guarantees the row equals its creation state; `relationship_rev_cutoff` semantics are unchanged because the rows and ids still exist. | the revision reader expands the row | ≈ 190 MB |
| Δ7 | OpenAlex `keyword` tags (`adapter_machine`) are not stored; they stay in the pack record | none in 1.3.0 | ≈ 105 MB |
| Δ8 | `tile_cache` table unused (an in-memory LRU replaces it) | none | — |
| Δ9 | `meta` gains `atlas_id`, `engine_version`, `device_delta_version`, `journal_applied_seq`, `generation` | Health, swap | — |
| Δ10 | New table `pack_install(pack_sha256 PK, name, version, member_count, installed_at, batch_ids_json)` | integrity, provenance | — |

**Result (measured).** Δ2–Δ7 were applied to an APFS clone, followed by `VACUUM`, FTS `optimize` and dropping `passage_time`. The database came to **1,742 MB without text**. Adding the measured Δ1 chunks gives **≈ 2,100 MB for the complete demo + Cipher + STEMM atlas**, down from 3,389 MB (plus 2.2 GB of originals and sources).

### 3.3 Storage budget on the iPhone 15 Pro Max

| Configuration | atlas (DB + text) | derived artefacts (mmap'd: cubes, spaces as Float16, reuse index, Ngram) | source packs kept on device | Total durable |
|---|---|---|---|---|
| **Starter** after the first minute (demo + Cipher metadata) | ≈ 0.55 GB (est.: 273k title documents, 257k relationships, 800k labels) | ≈ 0.02 GB | Cipher packs live in the app bundle (≈ 0.19 GB, not counted) | **≈ 0.6 GB** |
| **Cipher** (+ full text, 68.6 M tokens) | ≈ 1.1 GB (est., table-by-table share of measured sizes) | ≈ 0.2 GB (en/fr/es pooled spaces, cubes) | bundle | **≈ 1.3 GB** |
| **Full** (+ STEMM) | **2.1 GB (measured)** | ≈ 0.5 GB: Ngram baseline 174 MB as is (incompressible: 173 MB LZFSE), spaces ≈ 150 MB as f16, reuse index ≈ 150 MB | STEMM source pack 0.41 GB (measured LZFSE: gutenberg-stemm 141, OpenAlex 73, Wiktionary 22, Ngram 173) | **≈ 3.0 GB** |

- **Target ≤ 3.0 GB durable for Full; hard ceiling 3.5 GB.** Purgeable `Caches/` (varint token streams ≈ 250 MB, decoded-chunk and thumbnail caches) are capped at 0.6 GB.
- During a generation swap (§3.6) one more atlas exists transiently (≈ +2.1 GB). The **free-space guard** refuses unless `volumeAvailableCapacityForImportantUsage ≥ 1.3 × incoming + 2 GB`; it offers "replace in place (Scrolls paused ≈ 2 min)" otherwise.
- **Optional cut (Storage screen):** "Remove the STEMM source pack" saves 0.41 GB. The atlas stays complete; only "Original record" for STEMM documents then says *"kept in the STEMM pack on your Mac (sha 3f9a…); not on this iPhone"*.
- Further optional cuts, each with its saving shown: OpenAlex citations (≈ 180 MB; the C4 arc summaries for STEMM then show their gate) and the reuse index (Mac-only near-quote lookup; targeted trace still works by FTS phrase).

### 3.4 The text store

```swift
public struct TextStore: Sendable {
  public func slice(_ doc: DocumentID, utf16 r: Range<Int>, on tx: ReadTx) throws -> String   // ≤ 2 chunk decodes for a passage
  public func original(_ doc: DocumentID, on tx: ReadTx) throws -> String                    // reader view; streams chunks
  public func verify(_ doc: DocumentID, on tx: ReadTx) throws -> Bool                        // sha256(UTF-8) == original_sha256
}
```

- **Offsets stay UTF-16 code units (D4).** A chunk records its `u16_start`. Slicing decodes the chunk's UTF-8 and walks at most 32k units. Chunk ends never split a surrogate pair.
- **Measured cost:** LZFSE decode runs at 738 MB/s, **46 µs per chunk** (single thread, loaded M1 Max).
- **Cache:** each read connection keeps an 8 MB LRU of decoded chunks.
- **Integrity:** `verify` re-hashes the whole original, so D18 anchors (keyed by `original_sha256`) keep their meaning. A Diagnostics job verifies all 895 MB in ≈ 3 s (est.: decode plus SHA-256).
- **Why inside SQLite, not loose files:** chunks commit in the same transaction as their passages, the atlas moves as one file, and `sqlite3_blob_read` reads them without copies.

### 3.5 Packs

A **source pack** (`.scrollspack`, UTType `com.utkarsh.scrolls.pack`) is one file with a simple random-access layout (≈ 300 lines in `ScrollsStore/Pack/`):
- a header, then a JSON manifest: `name`, `version`, `created_by`, licences, the `MANIFEST.json` / `FORMAT.md` of STEMM sources, and the members (`path`, `sha256` of the uncompressed bytes, `size`, `chunk table`);
- the member bytes in 1 MB LZFSE chunks.

`PackMember.bytes(range)` decodes only the covering chunks. That is what makes Δ2 pointers cheap.

**Packs are the originals.** `original_file.rel_path = "pack:<name>@<sha8>/<member>"`, and every member's SHA-256 is the SHA-256 of the file on the Mac, so provenance and `import_once` behave as in the reference.

| Pack | Members | Size (LZFSE, measured) | Where |
|---|---|---|---|
| `demo` | generator seed + `data/demo` | < 1 MB | engine resource |
| `cipher-meta` | culture-works.tsv, culture-themes.tsv, roots.tsv, relations_{mb,wiki,itwofs}.json, gutenberg.json, pg_catalog.csv, tags/*.jsonl | ≈ 29 MB (works 5.8 · relations_mb 15.8 · pg_catalog 5.2 · roots 1.5 · …) | app bundle |
| `cipher-text` | texts/gutenberg/*.txt (691 files), wikisource-{hi,gu}.jsonl | ≈ 163 MB (134.9 + 27.9) | app bundle |
| `stemm` | gutenberg-stemm, openalex, wiktionary-coinage (+ ngram-eng-1.sqlite kept as a raw member) | ≈ 409 MB | pushed from the Mac |

### 3.6 Producing and delivering the atlas

**One engine, two hosts, three paths.**

| Path | How | When |
|---|---|---|
| **A. Built on the phone from bundled packs** | First launch: the starter (demo) is copied, then the `bootstrap-cipher` job runs phase A (metadata), phase A2 (relations) and phase B (full text). | Default for Cipher; also every user import. |
| **B. STEMM source pack, loaded on the phone** | `Tools/atlas.sh push-pack stemm` (devicectl into `Documents/Inbox/`), or Finder/AirDrop. The app offers *"STEMM sources arrived (409 MB) · Load ≈ 12 min"* and runs `adapter-load` jobs under a `BGContinuedProcessingTask`. | Supported and acceptance-tested on a 5% slice; the full run is optional. |
| **C. Prebuilt atlas, built on the Mac** | `Tools/atlas.sh build full` runs `scrolls build --packs demo,cipher-meta,cipher-text,stemm --derive cubes,spaces,eras,reuse,tokstreams` (est. 6–12 min on an idle M1 Max). `push-atlas` sends `Full-<date>.scrollsatlas/` (a package: `atlas.sqlite`, `ATLAS.json`, `derived/`). | Default for STEMM and heavy derived artefacts; also the recovery path. |

**Transfer mechanisms, all landing in `Documents/Inbox/`:**
- **`xcrun devicectl device copy to --device <his iPhone> --source <pack or .scrollsatlas> --domain-type appDataContainer --domain-identifier com.utkarsh.scrolls --destination Documents/Inbox`** (verified available on this Mac). Its help says it copies "skipping files that have not been modified", so a re-push after an interruption resumes per file; that is why the atlas package keeps `derived/` as separate files. This is the scripted path agents use.
- **Finder file sharing:** drag onto Scrolls under the iPhone in Finder (`UIFileSharingEnabled`).
- **AirDrop / Files / share sheet:** a single-file `.scrollsatlas.aar` (Apple Archive, LZFSE), extracted by streaming with the AppleArchive framework.

**Installing a generation (the only way an atlas is replaced).**
1. **Detect.** `Inbox.scan()` runs whenever the scene becomes active. It reads `ATLAS.json` and refuses mismatches with actionable copy, e.g. *"Built by engine 1.1.0 (schema 1, deltas 3); this app runs 1.0.0. Rebuild with Tools/atlas.sh from the same commit."*
2. **Move.** `Inbox` → `Application Support/Atlas.next/`: a rename on the same volume, so no copy.
3. **Verify.** SHA-256 of `atlas.sqlite` against the manifest (≈ 1–2 s for 2 GB with CryptoKit, est.). Open read-only and run the capability probe and `PRAGMA quick_check(100)`; the full `quick_check` is a background job.
4. **Replay the journal** (§6) into `Atlas.next`: user imports re-run from `Notebook/originals/`, annotations, reviews, views, tracked expressions and labels. Pinned runs are remapped by `RunKey`.
5. **Swap.** `JobQueue.suspendAll`, drain the `ReaderPool`, rename `Atlas` → `Atlas.prev` and `Atlas.next` → `Atlas`, reopen, and post `EngineEvent.atlas(.swapped)`. `Atlas.prev` is deleted at the next launch after a successful open. It is the one-step rollback.

Path A rebuilds (for example a new bundled Cipher pack version) use the same mechanism. The new generation is built beside the old one while the old one stays usable.

### 3.7 The first minute on the phone (D10)

| t | What happens | Budget |
|---|---|---|
| 0–0.4 s | Launch. No database work on the main actor. `AtlasBootstrapper` sees no atlas and clones `Starter/starter.atlas` (≈ 6 MB: demo, demo runs, layout) into `Application Support/Atlas/` (APFS `clonefile`, < 50 ms). | first frame ≤ 400 ms |
| 0.4–1.2 s | The Scroll paints *carry the zero* with the SYNTHETIC ribbon (tiles ≈ 30 ms from the demo cube). The tour's coach ① appears. If the starter is missing (an Xcode build without `build.sh`), the demo is generated on device with a counted skeleton: "building the demo… 41%", ≤ 3 s. | ≤ 1.2 s (SPEC §1.11) |
| ≈ 1 s | `bootstrap-cipher` phase A starts as a foreground job; chip "Cipher: importing titles & relations · 12%". | — |
| ≤ 45 s | Phase A done: 94,385 works, siblings, themes, roots. Toast *"Cipher titles, relations and etymology are ready"*. **Switch to Cipher** enables on the tour's last card. | target 45 s; est. 25–60 s (A17 Pro, JSON + 1.5 M row inserts + trigram labels) |
| ≤ 90 s | Phase A2: the relation endpoints (179k) and genealogy relationships. | — |
| after | Phase B: 1,516 books (68.6 M tokens) → boilerplate pass → FTS optimize. Progress reads "full text 312 / 1,516 books". Text lanes show `pending` until done. | est. 5–8 min in the foreground, ≤ 15 min bound |

**Measured switch for M1.**
- If phase A exceeds 60 s on his phone, the starter atlas becomes demo + Cipher metadata, prebuilt on the Mac (path C, est. ≈ 180 MB compressed in the bundle), and the on-device path keeps phase B and imports.
- The fingerprint test guarantees both starters hold the same rows.

**Leaving the app during phase B.**
- The last tour card offers the toggle *"Keep indexing when you leave Scrolls"*. A user action is required to submit a `BGContinuedProcessingTaskRequest` (title "Indexing Cipher books", subtitle "312 of 1,516").
- Without that lease, phase B suspends at the next chunk and resumes on return.
- A `BGProcessingTask` with `requiresExternalPower = true` finishes leftovers overnight.

### 3.8 iOS limits: background time, heat, memory

| Limit | Policy |
|---|---|
| **Background time** | Chunks ≤ 5 s; `beginBackgroundTask` covers finishing a chunk. **`BGContinuedProcessingTask`** (identifier `com.utkarsh.scrolls.job.<jobID>`, wildcard permitted): submitted only from a user action (Start, Load, Rebuild, the toggle above). Its `progress` is bound to the job's `Progress`; the expiration handler calls `JobQueue.suspendAll(within: .seconds(2))`; `strategy = .queue`. **`BGProcessingTask`** `com.utkarsh.scrolls.maintenance` (external power): FTS optimize, token streams, cube rebuilds, full `quick_check`, text verification. |
| **Thermal** (LabKitCore `DeviceConditions`) | nominal → 6 workers · fair → 4 · serious → 1 worker, and background-priority jobs pause · critical → all jobs pause until fair. Shown in the Jobs tray ("paused: the phone is hot"). |
| **Low Power Mode** | No automatic job starts. Foreground user-started jobs run with 2 workers. |
| **Memory (jetsam)** | Footprint targets are below 2 GB, whatever limit the 8 GB phone imposes (≈ 3–4 GB, higher with the requested `increased-memory-limit` entitlement): <br>• **interactive ≤ 400 MB resident**; <br>• **any job ≤ 600 MB** (vectors and the reuse index are the only ones above 256 MB); <br>• never above 1.2 GB. <br>Big read-only arrays (cubes, spaces, token streams, dup index) are **mmap'd files**, which are clean pages that do not count against the footprint. Before a heavy job, `os_proc_available_memory() ≥ 1.5 × budget` or the job waits with a message. `didReceiveMemoryWarning` drops the response LRU and chunk caches. |
| **Storage** | Free-space guard (§3.3). `SQLITE_FULL` becomes `E_DISK_FULL` with what to delete (Storage screen). Transactions keep the atlas consistent. |
| **Suspension** | WAL checkpoint (PASSIVE) on background. No lock held across suspension, because no transaction spans an `await` on another actor. |

### 3.9 Container layout, backup and protection

```
<container>/
  Documents/                                   Files + Finder visible · backed up · nothing precious lives here
    Inbox/        packs, atlases and import files land here (devicectl, Finder, AirDrop); emptied after install
    Exports/      user-visible exports (also handed to the share sheet)
    Diagnostics/  last-run.json (timings, memory peaks, thermal log) — pulled by check.sh device
  Library/Application Support/
    Atlas/        isExcludedFromBackup = true · FileProtectionCompleteUntilFirstUserAuthentication
      atlas.sqlite (+ -wal, -shm) · ATLAS.json · derived/{cube-*.bin, spaces/*.f16 + vocab, align/, reuse/, dup/}
      packs/      pushed source packs (STEMM; Cipher packs when SCROLLS_BUNDLE_PACKS=0)
    Atlas.next/ · Atlas.prev/   transient generations (§3.6)
    Notebook/     BACKED UP · journal-000001.jsonl …, originals/<sha2>/<sha256> (user imports), settings.json
  Library/Caches/ tokens/<lang>-<inputs>.vtok (varint token streams), thumbnails/   (purgeable; rebuilt on demand with progress)
  tmp/            export staging, archive extraction
```

Restoring the phone from an iCloud backup brings `Notebook/` back but not the atlas. On first open, Scrolls:
1. builds the Cipher atlas from the bundled packs (path A);
2. asks for the STEMM pack or a prebuilt atlas;
3. replays the journal.

The notebook survives intact; a test simulates exactly this.

### 3.10 Imports in, exports out

**Imports in.**
- **Sources:** `fileImporter` (UTTypes plainText, utf8PlainText, commaSeparatedText, tabSeparatedText, json, the imported `.jsonl` type, markdown) and "Open in Scrolls" from the share sheet or Files (document types, `LSHandlerRank Alternate`). `onOpenURL` receives the security-scoped URL.
- **Staging:** `stageImport` streams the file into `Notebook/originals/` while computing SHA-256 (CryptoKit, incremental). The reference limits stay: 2 GB per file, 20 MB per text field, 5 M rows.
- **The wizard** keeps the four steps of §5.2. Preview and dry run run on a reader; commit runs as a journaled `import` job.
- **Backup:** originals over 200 MB get a Storage toggle "exclude from iCloud backup", stating the consequence: *"if excluded, a restored phone cannot replay this import"*.

**Exports out.**
- **Formats:** JSON/JSONL/CSV with the manifest (licences travel, `export_text_allowed=0` respected); PNG and SVG snapshots from the display list; `.scrollsview` (the saved view's state, portable cutoffs, atlas fingerprint and a PNG thumbnail); the notebook as JSONL with every revision.
- **Delivery:** all are written to `tmp/` and offered through `ShareLink` / `UIActivityViewController`; a copy goes to `Documents/Exports/` on request.

---

## 4. The iPhone experience (platform-shaped)

### 4.1 Layout on a 6.7" screen (430 × 932 pt portrait; safe areas 59 top, 34 bottom)

**Portrait, top to bottom:**
1. **Glass top bar** (52 pt): the search pill with up to 4 strand chips ● ■ ▲ ◆, the corpus menu (Demo · Cipher · STEMM · All real) and More.
2. **SYNTHETIC ribbon** (20 pt, striped, cannot be dismissed) whenever synthetic material is visible.
3. **Minimap** (28 pt): the folded overview with the modality seam and the cyan bracket.
4. **Ruler** (32 pt, with the "as of 1997" playhead flag) and the **coverage track** (12 pt, 5 step classes).
5. **Lanes**, filling the rest:
   - lane band 40 pt for one strand, 24 pt per strand slot after that;
   - lane headers become a glass chip at the band's top-left, "English · text · 12.4M tokens, 1823–1928" (prominence note when selected); tap opens the lane sheet;
   - at most 5 lanes visible, then a "+7 more lanes" row;
   - **UNDATED** becomes a 36 pt left rail ("⊘ 172" per lane); **SCHEDULED** becomes a 28 pt right rail.
6. **Glass bottom bar** (56 pt): Play (Step ▸ under Reduce Motion), the vantage chip ("as of 1997 · strict"), tier, Lanes, Evidence filter, Compare.

**Landscape (932 × 430):** the time axis gains 2.2× its width.
- Lane chips move to a 132 pt left rail.
- The bottom bar becomes a floating glass capsule.
- The inspector becomes a 360 pt trailing panel instead of a sheet, and Compare shows A | B side by side.
- The minimap and ruler stay. The Dynamic Island side is handled by safe-area insets.

**Inspector (Then | Now | Next).** A sheet with detents `.height(148)` (peek: the passage line, the date chip and the SYN badge), `.medium` and `.large`. `presentationBackgroundInteraction(.enabled(upThrough: .medium))` keeps the Scroll live under it. The Crossings card collapses to one line in peek.

### 4.2 Gestures

The gestures are UIKit recognizers on the `MTKView` host, which gives exact velocities and priorities.

**On the Scroll:**
- **One finger** locks to an axis after 8 pt:
  - horizontal pans time, with momentum at a deceleration rate of 0.998/ms (UIScrollView "normal"), switched off under Reduce Motion;
  - vertical scrolls lanes, with rubber-banding.
- **Pinch** zooms x only, around the centroid, clamped to 0.05 px/year–40 px/day. A tier change shows the pill "Now showing yearly bins" and gives a light haptic.
- **Tap** selects with a 12 pt hit tolerance (§8.4 grid) and opens the peek.
- **Long-press** (0.5 s) opens a glass action menu: Open passage · Annotate · Lineage · Compare from here · Pin.
- **Double-tap** zooms in one tier; a **two-finger tap** zooms out one.

**On the ruler and minimap:**
- **Playhead** handle 44 × 44 pt on the ruler; dragging it takes priority over the pan. It moves bin by bin, with a selection haptic per bin and no tweening.
- **Range:** long-press then drag on the ruler or coverage track (instead of shift-drag) sets a range and offers the chips "Set as A" and "Set as B".
- **Minimap:** drag the bracket, or tap to jump.

**System gestures.**
- The Scroll is the root, so there is no back-swipe conflict.
- `.defersSystemGestures(on: .bottom)` applies only in landscape, so a lane pan near the home indicator is not lost.
- The top edge is never deferred.

### 4.3 Rendering: Metal over the shared display list

- **Pipeline** (unchanged from §8.3): tiles → `TimelineModel` → `DisplayList`, built off the main actor in a `TimelineBuilder` actor in ≤ 25 ms for 20k cells. The renderer takes the new list in one atomic swap.
- **x in content coordinates:** a pan changes only a uniform; a zoom past the bin threshold rebuilds the list (the previous tier stays drawn at 40% until then, never interpolated).
- **Six instanced draws:**

  | Draw | Contents |
  |---|---|
  | 1. backgrounds | bands, hatches as fragment-shader patterns in screen space (45° 6 pt "no sources", sparse dots "pending", light hatch "low") |
  | 2. washes | translucent bands with 10% feathered circa ends |
  | 3. bars and ticks | |
  | 4. marks and glyphs | |
  | 5. arcs | quadratic curves tessellated in the vertex shader, 32 segments; dash patterns solid / 6-4 / 1-3 computed from arc length in the fragment shader |
  | 6. overlay | playhead, selection glow, focus |

- **Labels:** ruler labels come from a Core Text glyph atlas rebuilt per Dynamic Type size; lane chips and every other text are SwiftUI.
- **Budgets at 120 Hz:**

  | Item | Budget |
  |---|---|
  | main-thread work per frame during pan | ≤ 2 ms |
  | GPU per frame | ≤ 3 ms |
  | instances | ≤ 20,000 cells + 4,000 marks + 300 arcs + 600 bundles + 2,000 washes |
  | labels | ≤ 150 |

  Above budget, `DisplayList` steps to a coarser tier with the `simplified` badge (§8.3 rule).
- **Idle and play:** the view is drawn on demand (`isPaused`, `enableSetNeedsDisplay`) and runs at 120 Hz only during gestures, momentum and 150 ms fades. Play steps redraw once per bin.
- **The CG painter** of the same list produces PNG snapshots, SVG (a port of `svg.mjs`) and the render-golden tests in `ScrollsAppTests`.
- **Rejected alternatives:**
  - *SwiftUI Canvas* redraws everything on the CPU every frame and cannot hold 20k primitives at 8 ms.
  - *Core Animation* needs one layer per primitive or a re-tessellation per zoom.
  - *LabKitRender* owns the frame loop continuously and carries bloom/EDR: an instrument should not glow, and Scrolls needs on-demand frames and pixel-exact hairlines.

### 4.4 Honesty encodings on the phone (SPEC §1, §8.7 → pt on a 3× display)

| Encoding | Phone rendering |
|---|---|
| `observed` / `absent` / `low` / `uncovered` / `pending` | bar · 1 pt dotted baseline · hollow tick + light hatch · 45° hatch 6 pt "no sources" · sparse dots "indexing — not yet looked". Tooltips become the peek sheet's first line, generated from the same numbers. |
| bar = maximal run of observed bins; never bridged | `TimelineModel`, ported exactly; a display-list golden asserts no primitive spans a non-observed bin |
| washes (never added to rates) | translucent band with a count label; the conservation law is asserted per lane in tests and shown in the a11y table |
| caps: exact first/last date; censoring ◁ ▷ | glyph caps; chevrons at the first/last covered bin |
| sparse fill (n ≤ 4), single-source `¹`, estimated `≈` stripes, synthetic stripe | instance flags → shader patterns; the `¹` and `≈` glyphs come from the atlas |
| evidence lines: documented solid ● / computed dashed □ / proposed dotted ? | identical patterns, 1.5 pt; DOC / CALC / PROP badges on cards; never colour alone (the Differentiate Without Colour setting has no effect because none is needed) |
| review overlays ✓ ✕ ⚖, human ✎ | midpoint glyphs; rejected hidden by default |
| feedback arcs below, violet, arrow on the earlier mark; re-read halo; date-conflict red stub ⚠ | as specified; visible once the vantage reaches the later date |
| modality seam "Full text ends 1928 →" | a permanent vertical seam; collapses to a ruler tick, never hidden |
| folded overview, seams ×3.3 / ×8.9 / ×3.3; no log axis | the `D` key becomes the Deep-time button; panning is disabled there |
| etymology bands ("period of the language, not a date"), listed-roots bracket, Wiktionary ◇ claims, Ngram baseline track | dedicated rows at the lane-group top; the baseline track is 32 pt with its own label |
| "Lane order is a sorting choice (first observed), not a scale of meaning" | always the first line of the Legend sheet and of the lane sheet |
| copy rules (first observed; estimated shift; no mental-state verbs) | `CopyLint` from LabKitCore, extended with `MENTAL_STATE_VERBS`, runs over all `Localizable` strings in a unit test |

### 4.5 The other views on a phone

| View | Presentation | Platform notes |
|---|---|---|
| **Search** | The top-bar pill expands into a full-height glass panel with typed suggestions (expression · work · maker · theme). Results show counts with their unit. Empty states are computed (§8.8). | Typeahead hits `label_tri` (0.8 ms measured); KWIC rows decode ≤ 20 chunks (≈ 1 ms). |
| **Compare** | A full-screen sheet; portrait stacks A over B; panels 0–8 in SPEC order with **coverage first**. Gate cards carry an **Apply** button. Charts use Swift Charts with linear axes and an `AXChartDescriptor`. | Long panels (clusters, displacement) stream in as they finish (`AsyncStream` of panel results); each shows its own "counting… 41%". |
| **Lineage / Genealogy** | Full-screen sheets on the same TimeScale (Metal renderer reused with a node/edge list). "Show as list" past 150 nodes. Edge cards are sheets with review actions; each needs a note of ≥ 10 characters. | Bounded expansion per the SPEC. |
| **Constellation** | Full screen; positions come from `layout_cache` (they never move unless Re-layout); the legend is persistent (collapses to one line). | The layout job takes ≤ 300 ms est. for 150 nodes. |
| **Notebook** | A sheet or full page: cards with "rev 3 of 3", a revision scrubber and a word diff. The as-of slider works **to the second** (fixing the reference's one-stop-per-day issue: the slider snaps to revision timestamps). | Every write is journaled before it commits (§6). |
| **Term trail / Crossings** | A preset in the Lanes sheet; Crossings is the header of the Then tab. | |
| **Saved views and links** | Save gives `slug`, `slug~2` and so on. Links are `scrolls://v/<slug>` and `scrolls://s#v=1&c=…` (the **same** hash grammar as the web). Sharing exports a `.scrollsview` file; opening one on another atlas compares fingerprints and shows the as-saved banner, *"saved on a different atlas build: counts may differ — details"*. | Universal links need a hosted AASA file and are deferred. |
| **Import wizard** | 4 steps as sheets: upload preview (20 rows), mapping table (one row per target field, value-sniffed), validate (dry-run summary + `problems.csv` via share), commit (a job, then "Open in timeline"). | Runs from `fileImporter` or "Open in Scrolls". |
| **Jobs and Storage** | The jobs chip opens a tray: progress with numbers, cancel, thermal or paused state. **Storage** lists every component of §3.3 with sizes and Delete/Rebuild. **Diagnostics** shows health, the capability probe, integrity, and a perf HUD (p50/p95 frame times). | |
| **Tour** | Coach marks per §1.11, with timings as specified; dismissed state in `UserDefaults` (fails safe to showing the tour). | |
| **States** | Loading is always a number ("counting… 41%"; "indexing — not yet looked"). Errors show `message` + `hint` + Retry. Low evidence shows a gate card, never a numeral. | |

### 4.6 Accessibility, haptics, Liquid Glass, LabKit

- **VoiceOver.**
  - The Scroll is one `accessibilityElement` with a generated summary, plus the **Table alternative** (the `T` key becomes a toolbar button and a rotor). The table is built from the same `TimelineModel` arrays (identity test, as in the reference): per lane, rows of bin, n, rate, CI, coverage, state and flags, plus the segment list.
  - Rotors: Lanes, Marks, Arcs.
  - Each mark is reachable in date order through accessibility proxies for the visible marks.
  - Play announcements are throttled to ≤ 1/s.
- **Dynamic Type:** chrome and passages scale; data geometry does not. Chrome over the Scroll caps at `.accessibility1` with the Large Content Viewer (LabKit's rule). Passages use New York 17 pt, scaling.
- **Reduce Motion:** no momentum, no fades, no draw-on; play steps every 1.2 s and **Step ▸** becomes primary.
- **Increase Contrast:** raises hatch and wash alpha.
- **Haptics** (LabKitFeedback `HapticEngine`/`HapticTap`):
  - a selection tick per bin while scrubbing the playhead;
  - a light impact on a tier change;
  - success when a job the user started finishes while the app is active.
  - **No haptics on data** (nothing that could feel like magnitude or meaning). The system haptics setting is respected.
- **Liquid Glass:** on chrome only (bars, chips, sheets, capsule). **Never over the data layer while it is being read**, because refraction would distort marks.
- **LabKit — adopted:**
  - LabKitCore: `DeviceConditions` (bridged into the engine's throttle), `CopyLint`;
  - LabKitFeedback: haptics;
  - LabKitUI: `ChoiceChips` (lane facets, evidence filter: "chips, never a menu that hides the choice"), `GlassToggle`, `StatusBanner`, `LabInfoSheet` + `FieldNote` + `SourceList` ("How Scrolls works" and **Sources & licences**, where Wiktionary CC BY-SA, ItwoFS CC BY 2.5 link-back, Ngram CC BY 3.0 and OpenAlex CC0 attributions live);
  - a `LabPalette` value built in the app from the SPEC §8.7 tokens (bg-0 #0E1013, ink #EDE6D6, cyan #4FD8E8, amber #E8A84A, violet #B59AF5), with the status bar kept visible.
- **LabKit — not adopted:**
  - `GlassKnob`/`KnobConsole`: there are no continuous physical parameters;
  - `LabPlot`: its log axes are banned for time; Swift Charts covers Compare;
  - `ProvenanceBadge`/`ProvenanceLegend`: "measured/modelled/simulated/illustrative" must never sit next to documented/computed/proposed (I3);
  - LabKitRender, LabKitSensors, physics.

---

## 5. Performance on A17 Pro (2 P + 4 E cores, 8 GB)

Phone estimates scale the Mac numbers by ≈ 1× for SQLite-bound work and 0.8–1.5× for CPU-bound Swift. An A17 Pro P-core is ≥ an M1 Max P-core, but the phone has 2 of them, and the Mac numbers were taken under load.

| Operation | Reference / measured on Mac | iPhone est. (warm) | How it is bounded |
|---|---|---|---|
| FTS term / phrase | 1.1–1.5 ms (measured, sqlite3) | 2–6 ms; ≤ 60 ms cold | system FTS5; mmap 256 MB |
| Typeahead (`label_tri`) | 0.8 ms (measured) | ≤ 5 ms | |
| Search endpoint (suggestions + 20 KWIC) | budget ≤ 120 ms | ≤ 150 ms | ≤ 20 chunk decodes at 46 µs |
| Tiles, one viewport | warm ≤ 80 ms, cold p95 618 ms (reference M1 numbers). The denominator SQL alone is **623 ms** (measured) — the reason the cube exists. | ≤ 30 ms warm, ≤ 150 ms cold | the slice cube is an mmap'd column file built at load (≈ 40 MB, clean memory); numerators join ≤ ~5k `expr_doc` rows (1.0 ms measured for *war*) |
| Materialize a new word (≤ 20k candidate passages) | 1–14 s; 54% of CPU reads each candidate's **whole** text | **0.3–2 s** | reads only the chunks holding candidate passages (HANDOFF's "passage-level text storage" fix, delivered by Δ1); tokenizes those passages only; 4-way TaskGroup over documents |
| Very frequent (> 300k matches) | vocab instance counts | 1–3 s | `passage_vocab_inst` (1.2 ms count measured) + stratified sample |
| Arcs at STEMM scale (C4) | — | ≤ 100 ms | SQL + bucketing in Swift |
| Compare without vectors | — | 0.5–2 s | collocate frequencies come from one scan of the slice's ranges in the **varint token stream** (en ≈ 95 M tokens ≈ 160 MB, mmap'd); bootstrap CIs are 1,000 document-block resamples with vDSP |
| Clustering (Cipher *bank*, ≈ 4.3k matches) | 46 s (Node, loaded) | 5–15 s | occurrence vectors from the pooled space (mmap, f16 → f32 per row); 10 restarts × k ≤ 8 and 30 stability subsamples in a TaskGroup; cosine via `cblas_sgemm` |
| Pooled PPMI-SVD (en, ≈ 95 M tokens) | 36 s (8 workers) | 2–4 min if run on the phone; **Mac-prebuilt by default** | blocked PPMI: 5,000 targets × 10,000 contexts Float32 = 200 MB per block; streaming randomized SVD (d = 256, oversampling 16, 2 power iterations, seed 42). Peak ≤ 350 MB. |
| Era slices + Procrustes + drift | 100 s (M5 gate) | 5–10 min on phone; **Mac-prebuilt by default**; on-phone runs allowed for user-import corpora | same blocking |
| Boilerplate pass (Cipher books) | — | 30–60 s | winnowing over token ids; hash records in ≤ 150 MB typed arrays, radix-sorted |
| Global reuse index (full corpus) | ≈ 200 MB typed arrays | **Mac-built**; targeted trace on phone ≤ 1.5 s sync | LSH buckets mmap'd from `derived/reuse/` |
| Cipher phase B on device (68.6 M tokens) | 3,449 s (Node full bootstrap, loaded) | **5–8 min** foreground, ≤ 15 min bound | tokenizer prototype **3.3 M tokens/s per thread English, 0.7 M Hindi** (measured, unoptimized; Hindi skips `lowercased()` for caseless scripts, since only NFC is needed); FTS insert 0.37 s per M tokens (SPEC measured) ≈ 30–40 s; a single writer with parallel parse/segment |
| Constellation layout (≤ 150 nodes, FR 300 it) | first per worker > 5 s (mostly query) | ≤ 300 ms | |
| Cold launch → first Scroll frame | FCP 236–472 ms (web) | ≤ 400 ms shell, ≤ 1.2 s demo marks | no database work on the main actor; starter clone |

**Instrumentation.**
- Every job phase and service call is an `os_signpost` interval; a Scrolls Instruments template ships with the project.
- `Diagnostics/last-run.json` records phase timings, peak `phys_footprint` (`task_vm_info`) and the thermal history. `check.sh device` pulls it.

---

## 6. Persistence of user state

**Decision: the same SQLite atlas (reference tables, triggers and FTS), with an append-only journal as the durable, backed-up record. Not SwiftData.**

Why not SwiftData:
1. D17, D18, I3 and append-only revisions are enforced by **triggers and CHECKs**, which SwiftData cannot express.
2. As-saved reads join revision-id cutoffs with evidence tables in one SQL statement (`arcs.mjs`, `graph.mjs`).
3. Annotations need FTS5 (`annotation_fts`).
4. A review is one transaction: annotation + `relationship_revision` + `review_status`.
5. SwiftData's natural sync path (CloudKit) brings merge semantics that contradict append-only history.
6. The Mac CLI and the differential tests need the same store.

Cipher keeps SwiftData for its own app; nothing is shared with it.

**The journal** (`Application Support/Notebook/journal-NNNNNN.jsonl`, rotated at 32 MB, backed up):

```swift
public struct JournalEntry: Codable, Sendable { public let seq: UInt64; public let at: Date; public let actor: String; public let op: JournalOp; public let crc32: UInt32 }
public enum JournalOp: Codable, Sendable {
  case importCommit(ImportReplay)            // original sha256 + path in Notebook/originals, mapping, options, collection spec
  case importRevert(batch: BatchKey)
  case trackExpression(ExprKey, variants: VariantsPatch?)
  case annotationCreate(AnnotationCreate)    // targets as stable keys (below), anchors per D18
  case annotationRevise(AnnotationKey, AnnotationRevise)
  case annotationReinterpret(AnnotationKey, AnnotationCreate)
  case annotationWithdraw(AnnotationKey, reason: String)
  case relationshipPropose(RelationshipProposal)          // origin=human, proposed
  case relationshipReview(RelKey, ReviewAction)          // confirm | reject | dispute (+ note ≥ 10 chars)
  case relationshipAttachEvidence(RelKey, EvidenceAttach)
  case hypothesisGroupCreate(HypothesisGroupCreate)
  case dimensionDefine(DimensionDef)
  case clusterLabel(ClusterKey, label: String)           // stored as a `label` annotation, as in the reference
  case viewSave(ViewSave, portable: PortableCutoffs)     // + numeric cutoffs as computed at save
  case viewDelete(slug: String)                          // soft
  case analysisRequest(RunKey, params: JobParams)        // runs a user asked for, so pinned runs can be recomputed
}
public actor Journal {
  public func append(_ op: JournalOp) async throws -> UInt64         // write line + fsync BEFORE the DB transaction
  public func entries(after seq: UInt64) -> AsyncThrowingStream<JournalEntry, Error>
}
public struct JournalReplayer { public func replay(into atlas: Atlas, after seq: UInt64) async throws -> ReplayReport }  // resolved / fuzzy / orphaned
```

**Write protocol (write-ahead).**
1. Append the line and `fsync`.
2. Run the DB transaction that applies it **and** sets `meta.journal_applied_seq = seq`.

On launch, lines with `seq > journal_applied_seq` are re-applied (application is deterministic and idempotent by seq). A torn last line fails its CRC and is truncated. The DB never holds user rows the journal lacks.

**Stable keys across atlases.**

| Key | Definition |
|---|---|
| `DocKey` | `collection slug : ext_id` (UNIQUE in the DDL) |
| passage and occurrence targets | the **D18 anchor** `{doc key, original_sha256, field, start, end, quote, prefix, suffix}`; resolution goes exact → quote search inside the document → orphaned (kept and shown as *"anchor not found in this atlas"*) |
| `RelKey` | documented: hash of `(rel_type, src key, dst key, source_dataset, source_locator)`; computed: `(RunKey, src anchor, dst anchor)`; human: the journal seq of its proposal |
| `RunKey` | `(stage, params_hash, input_fingerprint, code_hash)` — the reference's reuse rule |
| `ExprKey` | `(kind, lang, norm, corpus slug)` |

**D17 still holds across atlases.**
- `viewSave` stores the numeric cutoffs (`max_import_batch`, `annotation_rev_cutoff`, `relationship_rev_cutoff`, `run_ids`) and **portable cutoffs**: pack SHA-256s, the user-import journal seq, the annotation and review seqs, and `RunKey`s.
- Replayed into a new generation, the numeric cutoffs are recomputed from the portable ones.
- A pinned `RunKey` missing from the new atlas is recomputed: same params and inputs give the same result, and differential determinism makes that a testable promise. Until then the view shows *"pinned analysis being restored (run #14 → job 302)"*.
- A view whose packs differ from the current atlas opens with the as-saved banner naming the difference. Nothing silently upgrades.
- Documents are still only soft-deleted (reverts are journaled).

**Tests (ScrollsAppTests + engine).**
- Crash between journal append and commit (kill points injected).
- Torn line.
- Replay into a rebuilt atlas gives identical user-visible responses for 30 scripted notebook operations.
- Restore from backup.
- Swap during a running job.
- An as-saved view before and after a swap.

---

## 7. Risks, and what to cut to keep v1 coherent

| # | Risk | Mitigation | If it fails |
|---|---|---|---|
| R1 | Tokenizer or fold divergence (Final_Sigma found; Unicode version) | Exported class table; explicit Final_Sigma; fold every Cipher type on both sides | Block M0 |
| R2 | Sentence segmentation (`Intl.Segmenter` vs CF/ICU) changes passage boundaries in prose blocks over 200 tokens | M0 spike: segment all 1,516 Cipher books both ways | Port UAX #29 sentence rules with a property table exported from Node; or freeze `seg-1` boundaries in packs for bundled corpora (user imports then segment natively, and the divergence is listed) |
| R3 | Phase A slower than 60 s on device | Measured switch (§3.7) | Prebuilt metadata starter |
| R4 | Phase B or a STEMM load hits thermal throttling or jetsam | Chunking, adaptive workers, mmap, memory gate | Mac-built path C |
| R5 | System SQLite on iOS 27 differs from macOS 3.54 | Capability probe on device in M0 | Vendored amalgamation (a C target, the one third-party exception — needs his approval) |
| R6 | Metal renderer effort | The CG painter of the same display list is a working fallback (slower: fewer instances, a coarser tier) | Ship CG at reduced budgets |
| R7 | Numeric tolerance drift (BLAS, summation order) hides real bugs | Exact paths use f64 loops in reference order; tolerance only where declared | — |
| R8 | Journal replay bugs lose a reading | Write-ahead protocol, CRC, replay tests, `Atlas.prev` rollback, a JSONL export of the journal in the Notebook menu | — |
| R9 | `localeCompare` vs Foundation collation reorders lanes | Differential on all labels | Sort keys with an explicit collation table for the en root order |
| R10 | Storage pressure on a full phone | Guard, Storage screen, optional cuts | Cipher-only configuration (≈ 1.3 GB) |
| R11 | UI scope (≈ 20k lines of web UI to rebuild) | The vertical slice first; views behind feature flags | Defer as below |

**Cut or defer for v1** (each shown in HANDOFF-NATIVE as unfinished, never hidden):
- **Defer:**
  - an on-phone global reuse index for the full corpus, on-phone pooled en spaces and era slices (Mac-built; on-phone runs are offered for small corpora and imports);
  - the portable HTML bundle export;
  - universal links;
  - a Share Extension (document types cover "Open in Scrolls");
  - iPad and landscape-specific Compare polish beyond A | B.
- **Cut** (replaced): `?selftest` (XCTest + the Diagnostics screen); mock mode (previews from goldens); the HTTP security layer; the NL CLI.
- **Keep in v1 at full honesty:** every encoding of §4.4, every gate, the D10 first minute, D17/D18, the conservation law, and the table alternative.

---

## 8. Build plan for parallel agents

### 8.1 Milestones

| Milestone | Gate (simulator + his iPhone 15 Pro Max) |
|---|---|
| **M0 Foundation** (N0 alone) | The package and app build. Contracts are frozen. `check.sh quick` is green on core goldens (tokenize, dates, viewstate, vocab, ids). The capability probe passes on the **device**. Segmentation spike (R2) and phase-A spike (R3) are measured and recorded. |
| **M1-N Vertical slice on device** | First minute ≤ 1.2 s demo / ≤ 60 s Cipher metadata. Phase B completes on device and is resumable across a kill. Search → Scroll → passage at exact offsets (20 of 20) → Compare (coverage, frequency, collocates, gates) → save view → kill → reopen identical. Journal replay into a rebuilt atlas. `check.sh slice` and `journey` green for the M1 rows. |
| **M2-N Lineage, clusters, vectors** | STEMM prebuilt atlas pushed and swapped (path C), with the notebook surviving. Genealogy of *Funky Drummer* matches the reference (32/98/48). Cipher *bank* clusters match the goldens. Drift with Mac-built spaces. Arc summaries for *gene*. **Phone-built Cipher atlas fingerprint = Mac-built** (from the same packs). |
| **M3-N Polish** | Constellation, full notebook (as-of to the second), Term trail, accessibility audits (XCUITest `performAccessibilityAudit`), perf budgets met on device (signposts), HANDOFF-NATIVE and VERIFICATION-NATIVE written. |

### 8.2 Work packages (exclusive file ownership)

| WP | Owns (only these paths) | Consumes (frozen) | Tests it adds | Acceptance |
|---|---|---|---|---|
| **N0 Foundation** (critical path) | `Native/project.yml`, `Tools/{build,check,golden}.sh`, `ScrollsKit/Package.swift`; `ScrollsCore/{Vocab*,IDs,Dates,Tokenizer*,ViewState,EvidenceStyle,Format}.swift`, `ScrollsCore/Contracts/**`; `ScrollsStore/**`; `ScrollsEngine/Jobs/**`, `ScrollsEngine/Service/ScrollsService.swift` (protocol + `StubService` over goldens), `ScrollsEngine/Journal/JournalTypes.swift`; `Sources/scrolls/main.swift` (dispatcher); `ScrollsApp/App/**` skeleton; `tools/golden/{export-shared,fingerprint,validate-contracts}.mjs` | SPEC, API 1.3.0 | core goldens; store tests (WAL, interrupt, statement cache, text store round trip on all Unicode planes, pack r/w); job queue tests (cancel ≤ 500 ms, `after:`, suspend/resume) | M0 |
| **N1 Ingest and text** | `Engine/Ingest/**`, `Engine/Text/**`, `Engine/Writer/**`; tasks `import`, `revert`; `tools/golden/export-{text,ingest}.mjs` | Store, Contracts, Jobs | segment, langid, names, variants, translit, parsers, writer fingerprints (demo) | slice fingerprints for writer tables exact |
| **N2 Adapters, packs, atlas build** | `Engine/Adapters/**`, `Engine/Packs/**`, demo generator, tasks `bootstrap-cipher`, `adapter-load`, `demo-load`; `Sources/scrolls/{Build,Pack,Fingerprint,Push,Convert}.swift`; `Tools/atlas.sh`; `tools/golden/make-cipher-slice.mjs` | N1's `DocumentWriter` API (frozen at M0 as a protocol) | reconciliation counts (§6.8), demo calibration (§9.6), slice and full fingerprints | phase A/A2/B on device; fingerprint phone = Mac |
| **N3 Aggregate and search** | `Engine/Aggregate/**`, `Engine/Service/{Search,Timeline,Passages,Documents,Kwic,Corpora,Etymology,Export}+Service.swift`, `Engine/Export/**`; tasks `materialize`, `export`; `tools/golden/export-aggregate.mjs` | Store, Text (tokenizer) | tiles L0–L5, conservation, marks, shelves, bins, arcs, trail; plan tests for their SQL | journey rows 1–8 |
| **N4 The Scroll** | `ScrollsCore/Timeline/**`, `ScrollsApp/Scroll/**`, `ScrollsApp/Shared/TimelineChrome/**`; `tools/golden/export-timeline.mjs` | Tiles/Marks/Arcs contracts | display-list goldens; render goldens (CG); perf tests (XCTest `measure` on sim; signposts on device) | 120 Hz pan with 20k cells on device; table alternative identity |
| **N5 Platform and shell** | `ScrollsApp/{App,Platform,Search,Jobs,Settings,Tour,Import}/**`, `Engine/Journal/{Journal,Reconciler,Replayer}.swift` (framework; op handlers belong to their owners), `Engine/Config/**` | Service, Jobs, Journal types | journal crash and torn-line tests, swap, inbox, free-space guard, background expiry simulation, restore-from-backup simulation | first minute; swap with notebook intact; BG continued processing on device |
| **N6 Provenance and notebook** | `Engine/Provenance/**`, `Engine/Journal/Ops/{Annotations,Relationships,Views,Hypotheses}.swift`, `Engine/Service/{Annotations,Relationships,Views,Hypotheses}+Service.swift`, `ScrollsApp/{Notebook,Inspector}/**` | Store, Journal framework | anchors (D18), revisions append-only, D17 as-saved incl. across a swap, review semantics | journey rows for save/annotate/restart |
| **N7 Lineage** (after M1) | `Engine/Lineage/**`, tasks `boilerplate`, `reuse-index`, `trace`, `gc-runs`, `Engine/Service/{Lineage,Genealogy,Trace}+Service.swift`, `ScrollsApp/Lineage/**`; `tools/golden/export-lineage.mjs` | Aggregate (arcs read-only), Provenance | winnow, boilerplate canary ("computer virus" = 0), near, cues, graph, path, genealogy | M2 genealogy, trace ≤ 1.5 s on device |
| **N8 Analysis** (after M1) | `Engine/Analysis/**`, `ScrollsNL/**`, tasks `tokstream`, `collocations`, `vectors`, `cluster`, `drift`, `tone`, `layout`, `Engine/Service/{Compare,Collocations,Clusters,Analysis,Constellation,Baseline}+Service.swift`, `ScrollsApp/{Compare,Constellation}/**`; `tools/golden/export-analysis.mjs` | Aggregate, token streams | the §2.1 analysis rows | M2 clusters and drift; Compare budgets on device |
| **N9 Integration** (lead or N0 agent) | `Native/Docs/**` finalization, `check.sh full` / `device` stages, cross-WP fixes by patch request to owners | all | full journeys | M3 |

### 8.3 Contracts frozen at M0 (additive changes only, through N0)

- `ScrollsService` and every request/response type (contract 1.3.0 shapes); `Gated<T>`; `ScrollsError` codes.
- `Connection`, `AtlasWriter`, `ReaderPool`, `ReadTx`, `WriteTx`, `SQL` catalog rules; `TextStore`; `Pack`/`PackMember`.
- `JobTask`, `JobContext`, `JobQueue`, `EngineEvent`, `ResourceBudget`, `DeviceConditionsSource`.
- `DocumentWriting` (the writer protocol N2 consumes before N1 lands, with a fake for tests).
- `JournalOp` (all cases) and the stable key types.
- `TimelineModel` input (tiles, marks, arcs) and the `DisplayList` primitive.

### 8.4 Order and coordination

1. N0 runs alone until M0, roughly 3,500–4,500 lines.
2. N1–N6 then start together, each finishing its M1 slice first.
3. N7 and N8 start at M1. They may begin their pure cores (winnowing, k-means, PPMI on arrays) during M1 against fixtures.

Rules:
- Every WP keeps `check.sh quick` green on its own mirror (`SCROLLS_BUILD_DIR=$TMPDIR/scrolls-<wp>`).
- Golden regeneration (`check.sh golden`) is run by N0 or N9 only, so fixtures never churn under other agents.

### 8.5 Acceptance checks on the device (his iPhone 15 Pro Max, iOS 27)

1. **Install:** `Tools/build.sh device && xcrun devicectl device install app …`.
2. **Launch with `-diagnostics`:** the first-minute timings land in `Documents/Diagnostics/last-run.json` (pulled by `check.sh device`).
3. **Kill during phase B** (`devicectl device process terminate`), relaunch, and confirm the resumed cursor and no duplicate rows (fingerprint).
4. **Push and swap:** `Tools/atlas.sh push-atlas full`, then confirm the swap and that the 30 scripted notebook operations survive.
5. **Hot phone and background:** with Low Power Mode on and the phone warm, a STEMM slice load throttles and pauses as specified. Backgrounding with the continued-processing toggle shows the system progress and completes.
6. **Fingerprint:** pull `fingerprint.json` from the phone and compare it with the Mac build of the same packs; must be identical.
7. **Instruments:** a 120 Hz pan with 20k cells keeps main ≤ 2 ms and GPU ≤ 3 ms p95, peak footprint stays below the §3.8 budgets, and no main-thread hang exceeds 50 ms.

### 8.6 Documents (agents cannot create new .md files)

The lead pre-creates these placeholders before M0:
- `Native/README.md`;
- `Native/Docs/PORT-MAP.md`, the living §1.6, with a section per WP;
- `Native/Docs/DEVICE-DATA.md` (§3; N2 + N5);
- `Native/Docs/DIFFERENTIAL.md` (§2; N0, with sections per WP);
- `Native/Docs/VERIFICATION-NATIVE.md` (numbers and screenshots per gate);
- `Native/Docs/HANDOFF-NATIVE.md`;
- `Native/Docs/STATUS.md`, with one `## N0 … ## N9` section each. Each WP edits only its own section, like LabKit's README rule.

Machine-readable outputs (fixtures, `DIVERGENCES.json`, `fingerprint.json`, `last-run.json`) are JSON, which agents may create.

---

### Appendix: how the measurements can be reproduced

- **Device slimming** (on an APFS clone; never the live database):
  ```sql
  PRAGMA journal_mode=OFF; DROP TRIGGER relrev_no_update; DROP TRIGGER relrev_no_delete;
  UPDATE document SET original_meta_json = json_object('$src','pk'||collection_id||':'||id);
  DELETE FROM date_assertion WHERE role='ingestion'; DROP TABLE date_rtree;
  UPDATE relationship_revision SET after_json='{"$row":1}', reason=NULL WHERE action='create';
  DELETE FROM doc_tag WHERE scheme='keyword' AND provenance='adapter_machine';
  DROP TABLE document_text; DELETE FROM tile_cache; DELETE FROM job_event;
  VACUUM INTO 'slim2.db';
  ```
  Then `INSERT INTO passage_fts(passage_fts) VALUES('optimize'); DROP INDEX passage_time; VACUUM;` gives **1,826,254,848 bytes**.
- **Text chunking:** a Swift probe read `document_text` from the snapshot and cut 32,768-UTF-16-unit chunks at newlines (86,065 chunks). It compressed each with `compression_encode_buffer` (LZFSE and Brotli): 894.6 → 365.2 MB (LZFSE) / 362.5 MB (Brotli). Decode ran at 738 MB/s.
- **Packs:** `compression_tool -encode -a lzfse` over the Cipher and STEMM source trees.
- **SQLite and lowercasing probes:** `xcrun swiftc -O` snippets (`import SQLite3`; `"ΣΑΣ".lowercased()`), compared with `node -e` under the DYLD workaround.
