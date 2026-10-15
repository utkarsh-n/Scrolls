<!-- OWNER: I — progress, evidence, pending device rows, contract requests, rebase notes -->
# Status: I

## Qwen bring-up

### B1 — make the current native tree build and run (log; newest last)

- 2026-10-13 22:30 local. Mac rebooted ~5 min earlier (all `$TMPDIR/scrolls-*` mirrors gone, load avg ≈ 280 from
  parallel agents). Mirrors of this part: `$TMPDIR/scrolls-B1` (check.sh quick), `$TMPDIR/scrolls-B1sim` (sim + device).
  Simulator: "Scrolls Qwen" (iPhone 15 Pro Max, iOS 27).
- Lint fixed: the 3 banned `String.lowercased()` calls (`ScrollsQuery/Export/Snapshots.swift:81,84`,
  `ScrollsService/LivePlatform.swift:89`) now use `Fold.asciiLowercased` (both patterns are ASCII, so ASCII-only folding
  is exactly the JS `/i` semantics they port).
- No `~/Developer/scrolls-packs/current`: no starter or Cipher packs to bundle; the app generates the demo at first launch.
- Next: `check.sh quick` (no `--wp`) and `build.sh sim` in parallel to find compile errors; then TaskRegistry wiring and
  the Cipher bootstrap start in `LiveAtlas.open`.
- 22:39 Mac rebooted again (up 4 min, load avg 437); mirrors recreated. Done before the reboot and kept in the working
  tree: TaskRegistry.all now lists the 9 task types that exist (import, revert, adapter-load, demo-load,
  bootstrap-cipher, materialize, tokstream, boilerplate, trace); `LiveAtlas.open` calls `BootstrapCipher.start(atlas)`
  when `launch.startBootstrap && launch.selfTest == nil` (returns at once; no-op without the cipher-meta pack).
  Started `check.sh quick` (`$TMPDIR/scrolls-B1`) and `build.sh sim` (`$TMPDIR/scrolls-B1sim`, "Scrolls Qwen") in parallel.
- 22:46 First `build.sh sim` (353 s at load ≈ 400–760) failed in one place: `ScrollsLineage/Tasks/TraceTask.swift:48,66`,
  `TraceQuery.Result` not Sendable (the Xcode Debug build; the SwiftPM release build of `check.sh` did not flag it). Fixed
  by declaring `Sendable` on `TraceQuery.{FieldText, Span, Match, CitedCue, Result}` (all members already Sendable).
  Rebuilding. Also started `Tools/packs.sh starter cipher-meta` (`$TMPDIR/scrolls-B1cli`) so the app can open live on
  the starter (demo world) instead of MockAtlas, and the bootstrap has its cipher-meta pack.
- 22:50 Second sim build (47 s) found two more pre-existing errors in ScrollsService (N2's files), now fixed:
  `Pipelines/BootstrapPhases.swift:461` `CollectionSpec` ambiguous (ScrollsIngest vs ScrollsSources) → qualified as
  `ScrollsSources.CollectionSpec`; `Generations/StarterBuild.swift:59` `e.id` → `e.expression.id` (ExpressionResponse).
  The first `check.sh quick` (535 s, load ≈ 875) FAILed at its build step on the pre-fix mirror, as did the first
  `packs.sh` (scrolls-cli). Third sim build failed "Unable to find a device … Scrolls Qwen" (CoreSimulator under load;
  the device exists, 4CC7F9BD-…): booted it and rerunning sim build, packs and quick in parallel.
- 22:56 More compile fixes, each found by one build round: `ScrollsQuery/CanonicalRequest.swift` (N3) gained public
  memberwise inits for `StrandRef` and `Cutoffs` (`LiveAtlas+Kwic.swift:36,38` could not construct them);
  `Scrolls/Compare/CompareView.swift:465` (app) had one extraneous top-level `}` (removed);
  `Tests/ScrollsLineageTests/BoilerplateTests.swift:137` captured a `var` in a Sendable closure (now a `let` copy).
  The ScrollsKit package itself now compiles in the Xcode Debug build. Rerunning sim build, packs (starter,
  cipher-meta) and the quick gate in parallel.
- 23:02 App-target fixes (sim build rounds 6–8): `import ScrollsService` added to 7 app files that use `AtlasService`
  (Lineage/{HypothesisGroupCard,LineageModel,GenealogyView,EdgeCardView,LineageView}, Compare/{CompareView,CompareModel});
  `Notebook/NotebookModel.swift` `Anchor` → `ScrollsContracts.Anchor` (SwiftUI.Anchor clash); `ScrollsRender.RenderStats`
  got `public init() {}`; `ScrollModel.isPlaying` lost `private(set)` (Playhead.swift's extension sets it);
  `N6Steps.swift` adds `nonisolated extension SelfTestRow: Error {}` (its `Result<LiveAtlas, SelfTestRow>`);
  `Inspector/ThenColumn.swift:39` passes `atlas: model.atlas` to `EdgeCardView`. Quick gate round 3 failed only on
  `Tests/DifferentialTests/Sources/CipherSliceTests.swift:129` (`await … ?? (try await …)` in an autoclosure; rewritten
  as if/else). Rerunning both.
- 23:09 **Sim build PASSES** (round 9, 339 s at load ≈ 300–900, after one more fix set:
  `Compare/CompareModel.swift` imports ScrollsStore for `JobID`; `CompareView.swift:367` `TermsTab` →
  `CompareView.TermsTab`; `CompareContent.swift` `SliceEdit` gained `init(a:b:)` (its failable init hid the memberwise one)).
  **Quick gate round 4** (387 s): mirror, manifest, build, lint, C0 260/260, G1 31 families all PASS; 4 private families
  SKIP; FAIL only in tests: ScrollsProvenanceTests 5 issues (N6: AnnotationsTests:56-57 message "…$.anchor: expected
  object, got null" instead of "a passage target needs an anchor"; ViewsTests:84 items 2 ≠ 1; JournalTests:189,208 "no
  such table: text_storage / id_counter" on a rebuilt generation) and ScrollsJobsTests 3 issues (N0: JobQueueTests:99
  cancel 500 ms bound and :26/:28 priority order, both timing at load ≈ 300+).
  **Packs built** (712 s incl. the release CLI): starter.atlas (228 documents, 1,437 passages, 4 expressions, 4 runs,
  22 annotations) and cipher-meta.scrollspack (29.6 MB) in ~/Developer/scrolls-packs/v1, `current` → v1.
  **Device build 1 FAILED at signing**: personal team YOUR_TEAM_ID cannot have `extended-virtual-addressing`; removed from
  project.yml and Scrolls.entitlements (increased-memory-limit kept; no budget depends on either, IOS-SPEC §3.8).
  Device build 2 running (`$TMPDIR/scrolls-B1dev`, started 23:06:14); sim rebuild with the starter bundled running.
  First sim launch (no starter: fixtures) showed the home screen; simctl stalls at load ≈ 850.

### B2 — Qwen inside Scrolls (log; newest last)

Build dirs (outside iCloud; survive reboots): `~/Developer/scrolls-build/b2/` — `sim` (app, "Scrolls Qwen"),
`mac` (scrolls-qwen CLI for S6 parity), `kit` (swift test ScrollsQwen), `src/` (read-only copies of mlx-swift 0.32.3 and
mlx-swift-lm 3.32.3 from the SwiftPM cache, for reading their APIs), `data/` (APFS clone of m5r scrolls.db, fixtures).

- 2026-10-13 23:30. Mac up 6 min after another reboot (load ≈ 630). Lead's `build.sh install` running (pid 6811;
  `~/Developer/scrolls-build/device`), so no device install from B2. Read IOS-SPEC-QWEN §0–§3, QWEN-LAB §1–§4,
  the critique, AttentionMachine's engine, and the 3.32.3 sources of GuidedGenerationLoop, GrammarConstraint,
  MLXEmbedders (Qwen3, Pooling, factory) and MLXLMCommon (TokenizerLoader, factories).
  Plan: (1) pure `ScrollsKit/Sources/ScrollsQwen` + `Tests/ScrollsQwenTests` (depends on ScrollsCore only, for the
  u61m-1 word window); (2) `Native/ScrollsQwenKit` local package (MLX pinned exactVersion as AttentionMachine) with
  `ScrollsQwenRuntime` + a macOS `scrolls-qwen` CLI; (3) `Scrolls/Qwen` screen (-qwen-demo) and `-selftest qwen`;
  (4) fixtures from a clone of m5r: ~60 'bank' passages for the demo, 200 R1 windows for S6 parity (Python MLX).
  project.yml is patched only in the B2 mirror until the simulator run works, so the lead's builds are not slowed by
  an MLX compile they did not ask for; the tree's project.yml changes land with the commit.
- 23:42 ScrollsQwen (pure) + tests written; running `SCROLLS_TARGETS=ScrollsQwenTests build.sh test` in ~/Developer/scrolls-build/b2/kit.
- 23:50 `swift test` ScrollsQwen: 25 tests in 6 suites PASS (44 s). ScrollsQwenKit written (ModelManager, Embedder,
  Generator/GuidedRun, ModelStore, QwenMemoryGuard, QwenDemoRunner, QwenSelfTest, scrolls-qwen CLI); its
  Package.resolved is AttentionMachine's (same pins). Next: xcodebuild the macOS CLI in `~/Developer/scrolls-build/b2/mac`
  (first MLX compile) → S6 parity on the Mac; in parallel the app screen.
- 23:53 Tree now needs ScrollsQwenKit: project.yml gains the package, ScrollsQwen product, Resources/Qwen folder; build.sh seeds the app's Package.resolved from ScrollsQwenKit's (AttentionMachine pins). App: Scrolls/Qwen/{QwenHost,QwenScreen,QwenSnapshot,QwenLaunch}.swift; LaunchArgs -qwen-demo / -selftest qwen; no Cipher bootstrap in those modes; Diagnostics link. Started `build.sh sim` in ~/Developer/scrolls-build/b2/sim (first iOS-sim MLX compile).
- 23:56 Lead's install finished (Scrolls 1.0 (1) on the iPhone, iPhone16,2, connected over the local network). Pushing both models into its container with the new `Tools/models.sh push` (log ~/Developer/scrolls-build/b2/models-push.log) so the Qwen build only needs an app install; devicectl skips unchanged files on a re-push.
- 23:58 Xcode's Debug config compiles the packages' C++ (Cmlx) at -O0, which matters for MLX on the simulator's CPU, so a Release simulator build runs too (~/Developer/scrolls-build/b2/simrel, own mirror). Three builds in flight (mac CLI Release, sim Debug, sim Release) + the model push; load ≈ 888.11. Added Tools/models.sh (check|push|push-sim; check PASSED: all 24 files match the catalogue) and Tools/check.d/qwen.sh.
- 2026-10-14 00:27 · B2 · resumed (attempt 2) after the ~23:59 reboot (up 27 min, load ≈ 414); all three builds and the
  4B push had been cut mid-flight · resume: rerun the builds in `~/Developer/scrolls-build/b2/{mac,sim,simrel}` (+ `dev`
  for the device build) · progress: Reports/progress/B2.json
- 2026-10-14 01:13 · B2 · split (45-min rule; load ≈ 700–1000 makes every MLX compile slow): **B2-r2a** = this attempt's
  first 45 min, **B2-r2b** = the rest (builds finish → S6 on the Mac → simulator run → device build → commit).
  r2a so far: `swift test` ScrollsQwen 25/25 PASS again (00:44); copy brought to the spec in the tree — §5.10's runtime-check
  header, rule 19's machine card (opaque bg-1, dotted ink-3 border, `cpu` glyph, "machine reading" chip; no violet or
  amber), rule 27's footer, §3.6's computed words first (they were mislabelled "machine label"), and "verified" removed
  from the model-file check's words (rule 25) — plus 2 copy tests; the Release simulator build restarted arm64-only (it
  was compiling MLX for x86_64 too); the MLX builds (mac CLI, sim Release, device Release) are compiling, and the device
  build is already compiling MLXCXGrammar (XGrammar), so the `-w` unsafe flag was accepted at planning ·
  resume: Reports/progress/B2.json
- 2026-10-14 01:32 · B2 · resumed (attempt 3, **B2-r3**) after the attempt-2 session ended at ~01:30 (every xcodebuild
  `BUILD INTERRUPTED`; no reboot: up 1 h 31 min, load ≈ 600); kept objects: mac 187 Cmlx `.o`, dev 35, simrel 0 ·
  resume: `~/Developer/scrolls-build/b2/{mac-build.sh, app-build.sh simrel|dev …, s6.sh}` · progress: Reports/progress/B2.json
- 2026-10-14 02:14 · B2 · split (45-min rule): **B2-r3a** (01:32–02:14) restarted the three MLX builds detached
  (`nohup`, so a session end no longer interrupts them; `-jobs 12`; the simulator build is now `generic/platform=iOS
  Simulator` arm64-only) and the `swift test` re-run; created the simulator stand-in **"Scrolls SimDevice"** (iPhone 15 Pro
  Max, iOS 27.0, B2627557-…; booting took 20 min 38 s at load ≈ 670); wrote `b2/sim-run.sh` (install → `models.sh
  push-sim` → launch `-qwen-demo` / `-selftest qwen` → screenshots) and taught `b2/s6.sh` to write the app's S6 sample
  `Scrolls/Resources/Qwen/qwen-parity.json` (40 windows, Python MLX vectors). At 02:12 the builds were still compiling
  MLX (Cmlx C++ and Metal; 57 clang jobs) · **B2-r3b** = builds finish → S6 → SimDevice run → device build → commit ·
  progress: Reports/progress/B2.json

## SIMULATOR HOLD — in force since 2026-10-14 09:25 (his instruction)

Repeated Mac kernel panic reports name `simctl` as the panicked task (identical fault backtraces), and Time Machine has
no verified completed backup. Until the recovery chat sends an explicit release (a completed backup and sample restore
checks passed), the Scrolls work runs **no** `xcrun simctl` command of any kind (not list, shutdown, reset, terminate,
launch, get_app_container, io, spawn), **no** simulator-destination `xcodebuild` (it runs `simctl diagnose` after a
failure), and no iOS Simulator MCP tool. CoreSimulator services and the booted "Scrolls SimDevice" are left exactly as
they are.

- Marker: `~/Developer/scrolls-build/.simulator-hold` (read-only). `Tools/build.sh sim|app-test|sim-create`,
  `Tools/models.sh push-sim`, `b2/sim-run.sh` and simulator-destination `b2/app-build.sh` exit 4 while it exists;
  `Tools/check.sh app` records a SKIP row. The paused overnight workflow script's SIMULATE THE TESTS rule is replaced
  by the hold rule (original kept at `~/Developer/scrolls-build/parked/overnight-m1ab-before-sim-hold.js`).
- Rows that need the simulator are SIM-HELD (never SIM-PASS, never PASS); device rows stay PENDING_DEVICE until the
  phone runs them.
- Allowed meanwhile: source edits, `swift build` / `swift test` on the Mac, `generic/platform=iOS` device builds, model
  work, and his iPhone through `devicectl` under `Tools/device-lock.sh`.
- Release: only the lead chat removes the marker, quoting the recovery chat's release; then this section gets a
  "released at" line.

### 09:30 state at the hold
- Fixed and committed (1d65b59): the layout runaway behind the 0x8BADF00D kills (state line padded by the large
  inspector → canvas → inspector, +46 pt per pass), the Scroll asking the engine before it opened, ScrollsQwenRuntime
  compile errors. Verified before the hold on Scrolls SimDevice (Release, live atlas): the Scroll draws the demo lanes.
- On his iPhone the new build installs, but a devicectl launch was SIGKILLed ~7 s in with no crash report (the jetsam
  report at 09:15:33 does not name Scrolls), and `Application Support/Atlas/` is still empty, so the live engine has
  never opened there. Next (device-only): the launch trail (`Documents/Diagnostics/launch.jsonl`, new) to see the
  engine-open error, then re-push the models (the 4B safetensors there is 1.63 of 2.26 GB).
- 09:31 resolved on the phone (06345e7): the engine failure was `Documents/Inbox` (reserved on iOS, NSCocoaErrorDomain
  513 in `AtlasLocation.prepare`), found by the launch trail. Now: engine "Live atlas", phase ready, atlas.sqlite 5.5 MB.
  Models re-push (`Tools/models.sh push`) started 09:33 under the device lock.
- Follow-up for N2 (not done): the spec's drop zone is `Documents/Inbox`, which the app cannot create or write. Check on
  the phone whether `devicectl copy to … Documents/Inbox/` (Tools/atlas.sh) can create it; if not, packs need an
  app-created folder (e.g. `Documents/Import/`) scanned alongside the system Inbox, and the copy in SourcesCopy and
  IOS-SPEC §3.5 / §6.6 updated.
- 09:35 review of 1d65b59/5d5a596 (workflow wf_a62b729f-740, 5 reviewers + verifiers, read-only, no simulator):
  confirmed and fixed: the Scroll stayed on "Loading" for ever when the engine failed to open (it now re-asks when the
  launch settles, either way); fillHeight subtracted the home-indicator inset from the peek twice (lanes ran ~34 pt
  under the peek); `check.sh` reported a stage whose only row is SKIP as PASS (now SKIP, exit 4). Confirmed, NOT fixed
  (pre-existing, visual, needs the simulator or the phone in hand): the Playhead scrub loupe is offset above the
  canvas and always removed by canvasLayers' `.clipped()` (take Playhead out of the clipped stack and bring the loupe
  down to just above the handle; the top chrome covers anything higher).
- Other sessions and the hold: CoreSimulator.prev.log shows simctl clients at 09:22:59–09:23:31 installing and
  launching an OfflineIntelligence build (`~/Developer/offline-intelligence-build`) on Scrolls SimDevice, and `axe`
  (XcodeBuildMCP) at 09:26. Not this chat; the marker cannot stop them. Device (`generic/platform=iOS`) xcodebuilds also
  connect to CoreSimulatorService as clients (they never run simctl).
- 10:30 another agent (Codex, "integration coordinator", OfflineIntelligenceKit) is moving Scrolls' text generation onto
  the shared OfflineIntelligence API (Qwen3.5 2B/4B; Docs/SHARED-OFFLINE-INTELLIGENCE.md), uncommitted in this tree:
  project.yml, ScrollsKit/Package.swift, ScrollsQwen*, Scrolls/Qwen/*, Tools/build.sh (device → build_hosts.py),
  Tools/models.sh. Until it lands the lead makes no app builds, no phone installs and no edits to those paths; the B3
  Qwen device session waits for it (it would measure the model being replaced). Running meanwhile (workflow
  wf_0a053fb2-efa, Mac-side SwiftPM only): bootstrap write amplification, packs drop folder (Documents/Import + the
  system Inbox).

### packs-dropzone (2026-10-14)
- Drop folder that always works: `AtlasLocation.importDir` = `Documents/Import`, created by `prepare()` with `try`
  (AtlasLocation.swift:21,75,84); `Documents/Inbox` stays best effort (`try?`, :91), read and remove only.
- Everything that lists or installs what waits reads both, Import first, de-duplicated by file name (Import wins), each
  item saying its folder: `DropFolder {import, inbox}` (AtlasPlatform.swift:87), `InboxItem.folder` (:108),
  `PackStatus.folder` (optional, :70); `LiveAtlas.waitingFiles()` (LivePlatform.swift:197) feeds `inbox()` (:95) and
  `packs()` (:36); `storage()` measures `import` and `inbox` as separate areas (:173). `installPack` (:72) moves from
  either folder by rename and then removes the same name in the other drop folder only when it is the same file (size and
  streamed sha256, :82); a different file of that name stays and is listed next. A missing or unlistable Inbox is empty.
- App (read-checked only, no app build allowed): SourcesCopy.inboxCaption now says devicectl, Finder and Files go to
  Documents/Import and AirDrop / Open in arrive through the system Documents/Inbox; stemmHow points at the Import
  folder; the Inbox panel shows each item's folder; packs say "in Import" / "in the Inbox"; storage lists Import
  (SourcesCopy.swift:38,46,50,69; SourcesScreen.swift:149,175,219). Lifecycle/SourcesModel comments updated.
- Tools/atlas.sh pushes to `Documents/Import/` (`DROP_DIR`, :48,54); subcommands unchanged; `zsh -n` OK. IOS-SPEC
  §3.5 (lines 580, 599, 601), §3.9 (694-696), §3.11 (734) say Import plus the system Inbox, with the 513 reason.
- Tests (mirror ~/Developer/scrolls-build/packs-dropzone, `swift build -c release -Xswiftc -enable-testing --build-tests`
  narrowed to ScrollsStoreTests + ScrollsServiceTests, 236 s at load ~190–240): ScrollsStoreTests 59 tests / 9 suites
  PASS (PlatformTests 9, incl. new `inboxNotCreatable`: Documents chmod 555 reproduces CocoaError 513 and prepare still
  succeeds with Import made, and `importCreated`); ScrollsServiceTests 23 tests / 7 suites PASS (new
  LivePlatformTests.swift, 5: both folders listed + de-dup + JSON folder, missing Inbox is empty, packs from both
  folders, install from either folder with identical/different twins, storage areas). The mirror included other
  agents' uncommitted edits (bootstrap writes: ScrollsIngest/ScrollsStore Writer, BootstrapWritesBench.swift).
- Open: whether `devicectl copy to Documents/Import/x` creates the folder when the new build has not launched yet
  (prepare makes it at launch); a Finder drag onto "Scrolls" lands in Documents/ root, which is not scanned; IOS-SPEC
  lines 2438/2472, BUILD.md:251, N0.md and Reports/device-queue.json `transfer` still name Documents/Inbox;
  `Lifecycle.inboxScan` is never assigned (pre-existing), so only the Sources screen scans.
- Review round (11 verifier findings, 2026-10-14 11:06; all checked against the code, all real, 2 pairs were duplicates):
  - atlas.sh recorded a push before the copy ran, so a failed push was skipped on retry, and push-baseline reported
    success when its copy failed. Fixed: `pushed_before` only checks, and `record_push` runs after `copy_to_import`
    returns 0 (Tools/atlas.sh:61-73,88,96). push-baseline now assigns `s=$(copy_to_import …)` before echoing it, so
    errexit applies. Ledger lines now carry the destination (`name<TAB>sha<TAB>Documents/Import`), so old 2-column
    lines no longer skip a push. `SCROLLS_PUSH_FORCE=1` re-pushes (useful after a reinstall). Checked with a fake
    `xcrun` first on PATH, SCROLLS_DEVICE=FAKE-DEVICE-0000 and a temporary SCROLLS_PACKS_ROOT; no real devicectl ran.
    A failed push-pack exits 1 and writes 0 ledger lines; the retry copies; a third run skips; FORCE copies again.
    A failed push-baseline exits 1 without printing a success line. An old 2-column line does not skip.
  - De-duplication by name alone let a partial Import copy hide a good Inbox copy. `waitingFiles()` now
    de-duplicates only when the name and the size both match (LivePlatform.swift:196-215); otherwise both copies are
    listed, each with its folder.
  - Finder "drag onto Scrolls" lands in Documents/, which is not scanned. Contract chosen: put the file in Scrolls'
    Import folder. The PackLibrary.absent hint (PackLibrary.swift:97), IOS-SPEC :739 and :1039 now say so, as stemmHow
    already did. Scanning the Documents root as well is left as an open question for him.
  - Packs opened in place from Files were dropped: DeepLinks routed `.packOrAtlas` to Sources and ignored the URL.
    New `DropFolder.receive` (LivePlatform.swift:245-285):
    - a file already in Import or the system Inbox stays where it is;
    - a file elsewhere in Documents is moved into Import;
    - a file outside the container is copied into Import under security-scoped access and a coordinated read. It is
      written to a hidden `.receiving-<name>` first, then renamed, and it replaces a same-named file.
    DeepLinks.swift:15,42,100-107 calls it before presenting Sources. On failure it shows a banner. inboxCaption
    (SourcesCopy.swift:50) and IOS-SPEC :695-697 are reworded: AirDrop copies go to the Inbox; a pack opened from Files
    is copied into Import.
  - `Lifecycle.inboxScan` is still never assigned. Not wired here: it is the §3.5 detect step, which is M2 work, and
    wiring it needs a decision about the banner it would show. IOS-SPEC :599 now says "Not wired yet". The Lifecycle
    header and `inboxScan` comments say the same.
  - Import creation failure no longer stops the engine: `prepare()` now creates Import with `try?`, as it does Inbox
    (AtlasLocation.swift:88-94).
  - Stale "Inbox" text retargeted to Documents/Import: N1Steps.swift:12 (N1's pending journey row), IOS-SPEC :2441 and
    :2475, BUILD.md:251, N0.md rows 24 and 140, and Reports/device-queue.json `transfer` (that file is untracked and
    gitignored, so the edit is local only).
  - Tests, run in the mirror at load ~290-370. The `--build-tests` build of ScrollsStoreTests and ScrollsServiceTests
    took 103.7 s. Results:
    - ScrollsStoreTests: 60 tests in 9 suites PASS. PlatformTests has 10, including the new `importNotCreatable`.
    - ScrollsServiceTests: 26 tests in 7 suites PASS. LivePlatformTests has 8, including the new
      `partialImportDoesNotHideInbox`, `receiveIntoImport` and `importBlockedByAFile`; `bothFoldersListed` now uses
      same-size twins.
    - App code is still not built (no app xcodebuild in this task). The exact DeepLinks `.packOrAtlas` lines were
      typechecked with `swiftc -typecheck -swift-version 6 -default-isolation MainActor` plus the approachable-
      concurrency features, against the built ScrollsService module and stubs for AppModel and ErrorCardModel: exit 0.
      A negative control (wrong argument label) failed as it should.

### bootstrap-writes (2026-10-14)
- Phone evidence: `Scrolls.diskwrites_resource-2026-10-14-094321.ips` = 1073.74 MB over 35,717 s (23:48 → 09:43) for the
  app's resource coalition; its 67 stackshots, one per 10.49 MB written, all fall in a 7.62 s window of pid 19361 (launched
  09:43:09): ~700 MB in under 8 s, 38 samples on the heaviest stack (… DocumentWriter.drain → WriteLease.batch →
  Writer.checkpoint, as symbolicated by the lead), 29 on a second libsqlite3 write path.
- Cause: `SourceLoader.loadCollection` wrote each document with `writer.add(doc, line:)` (HEAD SourceLoader.swift:237)
  → `DocumentWriter.add(_:line:)` → `drain` → one `WriteLease.batch` per document (HEAD DocumentWriter.swift:230/246/376)
  = one BEGIN IMMEDIATE…COMMIT per document, plus the PASSIVE `wal_checkpoint` (and its fsyncs) that every lease batch
  runs (WriteLease.swift:24). Phase A2's aliases the same, one transaction each (HEAD BootstrapPhases.swift:165,
  AdapterLoad.swift:53). Every transaction rewrites the leaf pages of the random-key indexes it touches (doc_tag_value
  26 MB, date_rtree 17 MB, doc_bin 8 MB, passage_time 8 MB, the (collection_id, ext_id) autoindex, the label_tri FTS
  segments) into the WAL, and the checkpoint copies them into the file again.
- Measurement: `Tests/ScrollsServiceTests/BootstrapWritesBench.swift` (SCROLLS_BENCH=1, skipped otherwise; run alone with
  `--filter BootstrapWritesBench`): the real phases A then A2 from `~/Developer/scrolls-packs/current` (starter.atlas +
  cipher-meta 28.26 MB) in a fresh root under ~/Developer/scrolls-build/…/roots; per phase the `proc_pid_rusage
  (RUSAGE_INFO_V4)` deltas (`ri_logical_writes`, `ri_diskio_byteswritten`), the writer's transactions, explicit checkpoints
  and WAL pages (new `WriterStats`, Writer.swift:66/127), atlas growth; then the §6.8 counts and the LogicalDump
  fingerprints. Mac release builds in ~/Developer/scrolls-build/bootstrap-writes, Mac load 100–240 (timings noisy).

  | run | A logical MB | A transactions | A s | A2 logical MB | A2 tx | total logical MB | disk MB | per atlas MB added |
  |---|---|---|---|---|---|---|---|---|
  | HEAD (v0) | 46,326 | 95,091 (94,410 checkpoints) | 720 | 66,171 | 199,975 | 112,497 | 234,928 | 147.1 |
  | HEAD again, A2 in one chunk (v0id) | 46,290 | 95,288 | 934 | 66,155 | 199,303 | 112,445 | 234,978 | 147.1 |
  | 500 docs per call, checkpoint per batch (v1) | 4,144 | 300 | 109 | 6,521 | 1,450 | 10,665 | 21,684 | 13.9 |
  | 500 per call, no per-batch checkpoint (v2) | 4,138 | 300 | 108 | 5,591 | 1,326 | 9,729 | 18,518 | 12.7 |
  | 5,000 per call, no per-batch checkpoint (v3) | 2,354 | 146 | 102 | 2,991 | 342 | 5,346 | 9,354 | 7.0 |
  | 5,000 per call, checkpoint per batch (v3p) | 2,357 | 144 | 101 | 3,031 | 345 | 5,389 | 9,485 | 7.0 |
  | the fix one revision earlier (error path only differs), busier Mac (final) | 2,594 | 193 | 186 | 3,129 | 548 | 5,723 | 10,154 | 7.5 |
  | **committed tree ac5189b** (final2) | 2,349 | 139 | 78 | 2,562 | 222 | 4,911 | 8,372 | 6.4 |

  Bytes dirtied per MB of atlas built: 147.1 → 6.4–7.5 (20–23×; the spread is the 2 s transaction cap under Mac load);
  per MB of pack imported 3,981 → 174–203; disk bytes 235 GB → 8.4–10.2 GB; phase A alone 46.3 GB → 2.3–2.6 GB (18–20×),
  A2 66.2 GB → 2.6–3.1 GB (21–26×). Phase A took 720–934 s on HEAD and 78–186 s with the fix (Mac, loaded).
- Fix (smallest that keeps results identical): `SourceLoader` queues producer batches and writes up to 5,000 documents per
  `DocumentWriter.add(_ records:)` call (one writer transaction; the writer still closes at 50,000 rows / 2 s); loads with
  a deadline (A2 and B chunks) size each call to ~1 s from the last call's pace, ≥ 1 document (`SlicePace`,
  SourceLoader.swift:239-296, :452), so a 20 s chunk still ends within ~1 s of its deadline. `DocumentWriting` gains
  `add(_ records:)` and `addAliases` (additive, defaults make the one-by-one calls, so fakes are unchanged;
  DocumentWriting.swift:101/103/129/141); `DocumentWriter.addAliases` (:260); A2's and AdapterLoad's alias loops make one
  call (BootstrapPhases.swift:165, AdapterLoad.swift:52). The per-batch PASSIVE checkpoint of §1.4 stays: once
  transactions are large, `wal_autocheckpoint` (1,000 pages) fires after nearly every one anyway (v3 vs v3p: −0.1 % in A,
  −1.3 % in A2).
- Same results: with A2 in one chunk (SCROLLS_BENCH_CHUNK_SECONDS=1000000) HEAD (v0id) and the fix (finalid) have equal
  LogicalDump fingerprints in 51 of 55 tables — document 273,618 rows, passage, passage_fts 1,810,244 instance rows,
  label_tri, relationship, import_issue, import_batch, journal_applied …; the other 4 differ only by the clock:
  analysis_run `metrics_json.phase_a_ms` (930,389 vs 173,828), meta `cipher_bootstrap` ms, date_assertion rows equal once
  ISO timestamps are masked (the ingestion assertions carry the writer's clock), date_rtree keyed by them. With the
  phone's 20 s chunks import_batch has fewer rows (fewer chunks) — chunking was already time-based. The §6.8 counts PASS
  in every run (works 94,385 / undated 8,227 / scheduled 28, etymons 54,989 with 704/351/1,170, endpoints 179,005,
  aliases on works 19,077, non-documented 0).
- Tests (final2 = the committed tree, mirror ~/Developer/scrolls-build/bootstrap-writes/final2, `swift test -c release
  -Xswiftc -enable-testing --skip-build`, targets Store/Jobs/Ingest/Sources/Service/Differential): ScrollsStoreTests
  60/60, ScrollsSourcesTests 16/16 (SourceLoader through the one-by-one fake), ScrollsServiceTests 25/25 + the bench
  skipped (no SCROLLS_BENCH), ScrollsJobsTests 27/27, ScrollsIngestTests 7/7 (G2 writer dumps g2.demo/g2.mini, device
  and reference profiles); DifferentialTests 8/10 — the two G2 Cipher slice tests fail on `diffs.isEmpty` only (below).
  Source lint (check.d/quick.sh's) clean for these files.
- G2 Cipher slice (`Reports/golden-g2.cipher-slice.json` in final2/reports): 43 of 50 tables equal the frozen
  reference's build (document, passage, passage_fts, relationship and the rest, phases A, A2 and B); the phase-B resume test's own checks pass (interrupted between chunks, 25 of 25 books after the reopen, 0
  documents twice). The 7 that differ do so in values this change does not touch: date_assertion/date_rtree the ingestion
  clock (reference pinned at 2026-10-04T12:00Z, Swift uses now), import_issue raw slot ids in message text ("document 27"
  vs "document 100000027"), relationship_revision raw ids in after_json (evidence_id 7 vs 200000007),
  relationship_evidence the detail JSON's key order, import_batch `job_id` null vs masked, analysis_run the boilerplate
  run's input fingerprint (differs between two Swift runs too). The same 7 tables, same kinds, were reported by an
  earlier build of this fix; on full Cipher (v0id vs finalid above) import_issue, relationship_evidence,
  relationship_revision and import_batch are equal between HEAD and the fix. A HEAD G2 run was started for a direct
  comparison and stopped after 75 min: on the slice HEAD's phase A took 894 s and A2 3,120 s (the fix: 70 s and 116 s),
  and its phase B had 1 of 65 books after 20 more minutes. (The raw-id rules are the open dump-spec item 4 of N2.md.)
- Found, not fixed (owners named; none blocks this change):
  1. **Phase A cannot finish on a fresh install** (N0/N2): the bundled starter carries `journal_applied` seq 1…4 (the
     tour's trackExpression acts; meta journal_applied_seq = 4) and `LiveAtlas.cloneStarter` (LiveAtlas.swift:160) copies
     only atlas.sqlite, so the new notebook's journal starts at 1 (JournalFile.swift:114/151) and phase A's journaled
     "done" commit fails "UNIQUE constraint failed: journal_applied.seq" (Writer.swift:38-45) — measured: bench v0–v3
     failed both phases' final commits until the bench padded its notebook past seq 4. From the code, each launch retries
     phase A (cheap: works stay loaded) and burns one journal seq, so A succeeds on the 5th attempt and A2/B wait until
     then. Fix belongs in the journal/starter design (start the journal after `journal_applied_seq`, or ship the starter
     without those rows).
  2. **A kill mid-phase leaves an orphan 'committing' batch** (N2): nothing rolls stale 'committing' batches back at
     boot; the resumed phase reads only committed batches (LoadSQL.swift:36-38), so every document the killed run
     committed is refused as E_DUP_ID (DocumentWriter.swift:550) — in A2/B also recorded as `unloadable` — and the
     collection's modality stays in the timeline's pending list (TimelineSQL.swift:10-14). Pre-existing; unchanged here.
  3. **Suspension during phase A restarts it from scratch** (N2, by design today): phase A's works load has no
     commitOnSuspend, so leaving the app rolls the whole works batch back (SourceLoader.swift:323) and the resumed job
     reloads all 94,385 works.
  4. **Still over iOS's budget** (lead): 1 GB/24 h vs ~2.6 GB (A) + 3.1 GB (A2) logical per bootstrap on the Mac proxy.
     Measured further step, not applied (spec §1.4 values): no per-batch PASSIVE + `wal_autocheckpoint` 16,384 pages
     → 3,874 MB logical / 4,756 MB disk (x-ck16k). Bigger levers: building phases A/A2 into the bundled starter on the
     Mac (no bootstrap writes on the phone), a 16 KB page_size (disk bytes are 1.8× logical with 4 KB pages on 16 KB VM
     pages), larger writer transactions than 50,000 rows.
  5. Unverified on the device: macOS `ri_logical_writes` counts every write() byte (probe: rewriting a dirty page
     counts again); whether iOS's "file backed memory dirtied" counts identically needs a device run (no devicectl in
     this task).
- Commits: ac5189b (the fix, the bench, WriterStats); this entry and Reports/progress/bootstrap-writes.json in the next.
  Bench reports: ~/Developer/scrolls-build/bootstrap-writes/bench-{v0,v0id,v1,v2,v3,v3p,final,finalid,final2,x-ck16k}.json.
