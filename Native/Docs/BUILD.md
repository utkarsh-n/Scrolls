<!-- OWNER: N0 — mirrors, build-time measurements, check.sh stages, toolchain notes -->
# Build

> **SIMULATOR HOLD (since 2026-10-14 09:25, his instruction):** no `simctl` of any kind, no simulator-destination
> `xcodebuild`, no iOS Simulator MCP tools until the recovery chat's explicit release. While
> `~/Developer/scrolls-build/.simulator-hold` exists the simulator modes of the tools exit 4. Device builds,
> `swift build`/`swift test` and the phone are still allowed. Details: `Docs/status/I.md` → SIMULATOR HOLD.

## N0 · mirrors, tools and measurements (N0a, 2026-10-10)

### Never build in iCloud: the mirror

`Native/` lives in the iCloud-synced `Scrolls/` folder, where xcodebuild and SwiftPM hang or misbehave. Every tool
first mirrors `Scrolls/` (Native plus the Node reference the goldens import) and `LabKit/` side by side into
`$SCROLLS_BUILD_DIR/src/` and builds there:

| Path in the mirror | What |
|---|---|
| `src/Scrolls/`, `src/LabKit/` | rsync copies (`.git`, `.build`, `.swiftpm`, `node_modules`, `Native/Reports`, `Native/Scrolls.xcodeproj`, the bundled packs and iCloud conflict copies `* 2*` excluded); `ScrollsKit/Package.swift` (layout-stamped) and `ScrollsCore/Generated/BuildInfo.swift` are written by the tools |
| `kit/` | SwiftPM scratch for `target` / `test` and `check.sh quick` without `--wp` (release; persistent, so builds are incremental) |
| `kit-quick-<pkg>/` | SwiftPM scratch of `check.sh quick --wp <pkg>` (the narrowed package; see below) |
| `kit-cli/` | SwiftPM scratch for `cli` (full BuildInfo values; kept apart so it does not invalidate `kit/`) |
| `dd/` | Xcode derived data (`sim`, `app-test`, `device`) |
| `module-cache/` | `CLANG_MODULE_CACHE_PATH` / `SWIFTPM_MODULECACHE_OVERRIDE`: one per mirror, so parallel agents never share a cache (LabKit's `lk.sh` pattern) |
| `logs/check-<stage>-<stamp>/` | per-row logs of `Tools/check.sh` |

**One mirror per agent:** `SCROLLS_BUILD_DIR=$TMPDIR/scrolls-<part>` (this part used `$TMPDIR/scrolls-N0a`).
`SCROLLS_JOBS=4` caps `-j`. `build.sh` refuses a `SCROLLS_BUILD_DIR` under `~/Documents`.

### Tools

| Command | Does |
|---|---|
| `Tools/build.sh mirror` | rsync only, then `gen-buildinfo.sh` in the mirror |
| `Tools/build.sh target <T…>` | `swift build -c release --target T` per target (a package's quick build) |
| `Tools/build.sh test [filter]` | `swift build -c release -Xswiftc -enable-testing --build-tests`, then `swift test … --skip-build [--filter …]` |
| `Tools/build.sh cli` | `swift build -c release --product scrolls-cli`; prints the binary's path |
| `Tools/build.sh xcodegen` | mirror, then `xcodegen generate` in the mirror; prints the project path |
| `Tools/build.sh sim` / `app-test` | Debug app build / `xcodebuild test` on `$SCROLLS_SIM` |
| `Tools/build.sh device` / `install` | Release build for the iPhone / build + `devicectl device install app` |
| `Tools/build.sh sim-create` | creates `$SCROLLS_SIM` (default "Scrolls 15 Pro Max"): iPhone 15 Pro Max device type, iOS 27 runtime; simctl runs under a 300 s alarm |
| `Tools/gen-buildinfo.sh <mirror> [dev\|full]` | writes `ScrollsCore/Generated/BuildInfo.swift` **in the mirror only**; replaces the file only when its bytes change |
| `Tools/golden.sh [families]` | regenerates goldens (see DIFFERENTIAL.md); serialised by a lock in `~/Developer/scrolls-golden/.regenerating` |
| `Tools/check.sh <stage>` | the §2.7 gates; table + `Reports/check-<stage>-<stamp>.json`; exit 0 pass · 1 fail · 3 pending device |
| `Tools/device-check.sh <suite>` | the device rows; `PENDING_DEVICE` + `Reports/device-queue.json` when the phone is not there |

**BuildInfo modes.** `dev` (target, test): the committed `"dev"` values, stable bytes, so quick builds stay incremental.
`full` (cli, xcodegen, sim, app-test, device): `engineVersion` (MARKETING_VERSION), `gitCommit` (HEAD of
`~/Developer/git/Scrolls.git`), `sourceDigest` (sha256 over every engine source) and `stageCodeHashes`. A stage's hash
covers the targets that implement it (ingest stages: Core, Store, Ingest, Sources; materialize/export: + Query;
analysis stages: + Analysis; tone: + NL; boilerplate/reuse-index/trace: + Lineage). Coarse on purpose: a code change can
only cause an unneeded recount, never a missed one. `SCROLLS_BUILDINFO` overrides the mode. The mirror's
`BuildInfo.swift` is excluded from rsync so its mtime survives.

**`check.sh` stages.** `quick [--wp Nx]` is `check.d/quick.sh` (N0); `golden [families]` regenerates then runs
`quick`; `device <suite>` delegates to `device-check.sh`; every other stage runs `check.d/<stage>.sh`, owned by the
package that owns the code it checks, and a missing script is a FAIL row. A stage script is sourced with
`row <name> <PASS|FAIL|SKIP|PENDING|PENDING_DEVICE|INFO> <detail> [evidence]` and `step <name> <log> <command…>`; a
script that stops on an error adds a FAIL row, so a truncated table can never read PASS. SKIP is never a pass.

**`quick`**: mirror → `swift package dump-package` (which declared targets the bring-up manifest builds; the rest are
PENDING rows) → **one** `swift build --build-tests` of the package's targets and test targets → `swift test --skip-build
--filter` on that build (the package's tests, ScrollsCoreTests for G1, and `DifferentialTests.ContractRoundTripTests`
for C0 once ScrollsService exists) → one row per golden family from `Reports/golden-<family>.json` (private families
absent on the Mac are SKIP rows) → a shell lint over `Native/` (`.lowercased()` in ScrollsKit/Sources, networking API
anywhere, `import LabKit` in ScrollsKit, files without an `// OWNER:` first line).
**`--wp <pkg>` narrows the package.** `swift test` compiles every test target of a package, so one package's broken test
would block every gate. With `--wp`, `SCROLLS_TARGETS` makes `build.sh mirror` write `ScrollsKit/.scrolls-targets` in
the mirror, and `Package.swift` then declares only those targets and what they depend on (the package's targets and
tests, plus ScrollsCoreTests; plus DifferentialTests for N0). C0 therefore runs in `quick --wp N0` and in `quick`
without `--wp`; other packages get an INFO row. Each narrowing builds in its own `kit-quick-<pkg>/`.
**Same environment, same build.** `build.sh` and `check.sh` export `TOOLCHAINS=metal` and the per-mirror module caches
for every SwiftPM call, and both build with `-Xswiftc -enable-testing` and test with `--skip-build`: measured, a build
whose `TOOLCHAINS` differs from the test run's, or a `swift test` that builds by itself, recompiles ScrollsCore (≈ 15 s)
on every switch.
Package → targets: N0 Core, Contracts, Store, Jobs, Service, ScrollModel · N1 Ingest · N2 Sources (+ Store/Pack) ·
N3 Query · N4 Analysis, NL · N5 Lineage · N6 Provenance · N7 ScrollModel, Render · N8/I none (G1 + lint only).

**`device-check.sh`.** Reads `devicectl list devices --json-output <file>` (devicectl also prints a table on stdout and
lists simulators: only `reality == physical` iOS devices count). It needs the iPhone paired, tunnel connected, Developer
Mode enabled and DDI services available; otherwise it appends `{suite, wp, requested_at, reason, fresh, device,
status: PENDING_DEVICE}` to `Reports/device-queue.json` under a file lock and exits 3. Available: install
(`--fresh` uninstalls first), launch `-selftest <suite> -atlasRoot selftest[-fresh] -perf`, wait up to
`SCROLLS_DEVICE_TIMEOUT` (1800 s) for `Documents/selftest/<run>/result.json` — **`<run>` is the UTC start time
`yyyyMMdd'T'HHmmss'Z'`**, a convention for the app's SelfTestRunner (N0 shell) — copy the run folder to
`Reports/device/<suite>-<run>/`, print rows, signposts, peak `phys_footprint` and the thermal log, and write
`Reports/device-<suite>-<stamp>.json`. Expected `result.json`: `{suite, status, rows: [{name, status, detail}],
signposts, peak_phys_footprint, thermal: […]}`.

### ScrollsKit manifest: the bring-up rule

`Package.swift` declares every target and product of IOS-SPEC §1.2/§8.4.3 (14 libraries, `scrolls-cli`, 14 test
targets). A declared target is built once its folder holds a `.swift` file **and** every target it depends on is built; a
declared resource is bundled once it exists. Packages therefore add files, never manifest entries, and one package's
missing folder never breaks another's build. With every folder and resource present the evaluated manifest is exactly
§8.4.3; `check.sh quick` reports the declared targets not yet created as a PENDING row. (Line 1 of `Package.swift` must
stay the tools-version comment; its `// OWNER: N0` is line 2.)

SwiftPM and Xcode cache an evaluated manifest by its text, so a manifest that reads the file system would not notice a
new folder (measured: a new `Sources/ScrollsContracts/` stayed invisible to `swift build --target ScrollsContracts`).
`build.sh mirror` therefore copies `Package.swift` into the mirror itself (rsync excludes it) and appends
`// mirror layout <hash of the Sources/ and Tests/ file list> (Tools/build.sh)`; the copy is replaced only when that
line changes, so a new folder or resource re-evaluates the manifest (verified: the target appears, builds, and
disappears again with its folder) and nothing is rebuilt otherwise. Always build through `Tools/build.sh`, never with
`swift build` on the iCloud tree.

### The Xcode project

`project.yml` is §8.4.1 with `optional: true` on the `Scrolls`, `ScrollsAppTests` and `ScrollsUITests` source folders,
so `xcodegen generate` succeeds before the app shell exists (an existing folder is an ordinary source folder). In the
mirror, `xcodegen generate` writes `Scrolls/Resources/{Info.plist,Scrolls.entitlements}` from the spec and
`xcodebuild -resolvePackageDependencies` resolves both local packages (LabKit at `src/LabKit`, ScrollsKit). The app
target does not compile until the shell (N0, app part) and the ScrollsService/ScrollModel/Render products exist.

### Measured (this Mac, 2026-10-10; M1 Max, macOS 27.2)

| What | Wall | Load avg (1/5/15 min) |
|---|---|---|
| `swift build -c release --target ScrollsCore`, clean scratch | 19.6 s (user 22.4 s) | 8.7 / 11.7 / 14.9 |
| same, incremental after touching one file (whole-module release) | 14.8 s | ≈ 10 |
| same, nothing changed | 1.4 s | ≈ 10 |
| `swift build --target ScrollsCore` (Debug, engine `-O`), clean scratch | 17.1 s (user 30.8 s) | ≈ 9 |
| `build.sh test ScrollsCoreTests`, clean `kit/` (build Core + tests, run the tests) | 24–30 s | 11–19 |
| same, nothing changed | 4.2 s | ≈ 12 |
| `check.sh quick --wp N0`, fresh `kit-quick-N0/` (mirror, build, 32 tests, 21 golden rows, lint) | 33.5 s | 12.6 / 12.4 / 12.9 |
| same, nothing changed | 6.5 s | 12.1 / 12.3 / 12.9 |
| `check.sh quick` (no `--wp`), nothing changed | 6.5 s | 12.3 / 12.4 / 12.8 |
| `golden.sh g1.core` (21 families, snapshot clone included) | 7–25 s | 15–21 |
| `build.sh xcodegen` | 0.4 s | ≈ 16 |

The 32 ScrollsCoreTests run in 1.7 s (the fold family checks all 1,112,064 scalars). Package-wide clean builds, per-package
`quick --wp` times, a simulator app build and the first transfer measurement (§8.4.10 items 5–6) are recorded when the
other N0 parts and the app shell exist (they are: "N0 · the stitch" below).

### Toolchain and environment notes

- Xcode 27.0 (27A5194q), Swift 6.4 (swiftlang-6.4.0.20.104), XcodeGen 2.46.0, macOS 27.2; `TOOLCHAINS=metal` resolves to
  the default toolchain.
- Node v26.10.0 (ICU 78.3, Unicode 17.0). Homebrew's node is broken by an outside upgrade: every tool runs it with
  `DYLD_LIBRARY_PATH=/opt/homebrew/Cellar/simdjson/4.6.11/lib:/opt/homebrew/Cellar/hdrhistogram_c/0.11.10/lib`
  (`SCROLLS_NODE_ENV` overrides).
- Simulator for this part: "Scrolls N0a" (iPhone 15 Pro Max, iOS 27.0), created with
  `SCROLLS_SIM="Scrolls N0a" Tools/build.sh sim-create`.
- His iPhone (iPhone16,2, `47C11007-…`) is paired with Developer Mode on but unavailable (tunnel unavailable, no DDI):
  `device-check.sh probe` queued the M0 probe row as PENDING_DEVICE.
- Fixed while porting the spec's script text: zsh does not split `${2:+--filter "$2"}` (it passed one argument
  "--filter X"), and the spec's `device_id` piped `--json-output /dev/stdout`, which mixes devicectl's table into the
  JSON and would pick a simulator.

## N0 · the app shell on the simulator (N0d, 2026-10-10)

**Mirror and simulator.** `SCROLLS_BUILD_DIR=$TMPDIR/scrolls-N0d`, simulator "Scrolls N0d" (iPhone 15 Pro Max,
iOS 27.0, `52FF2D7E-…`), created with `SCROLLS_SIM="Scrolls N0d" Tools/build.sh sim-create`.

**What the app build needs today.** The app links the products ScrollsService, ScrollsScrollModel and ScrollsRender.
Under the bring-up rule ScrollsService is built only once ScrollsIngest, Sources, Query, Analysis, NL, Lineage and
Provenance hold sources, and ScrollsRender belongs to N7; none of those folders existed during N0d. The verification
builds therefore ran `Tools/build.sh mirror`, then wrote one empty `enum <Target>MirrorScaffold {}` into each missing
target **in the mirror only** (and re-stamped the mirror's Package.swift), then `xcodegen generate` + `xcodebuild`.
`Tools/build.sh sim` succeeds without scaffolds once those packages have their first source file. The mirror's
project.yml also got `GENERATE_INFOPLIST_FILE: YES` on the two test bundles (without it xcodebuild refuses to sign
them; the change belongs in project.yml).

### Measured (M1 Max, macOS 27.2)

| What | Wall | Load avg (1 min) |
|---|---|---|
| Clean Debug simulator build of the app: fresh derived data and module cache (LabKit Core/Feedback/UI, ScrollsCore, Contracts, Store, Jobs, Service, ScrollModel, scaffolds, app) | 55.6 s (user 160 s) | 61 → 53 |
| Incremental: one app source touched (mirror + xcodegen + build) | 6.0 s | 44 |
| Nothing changed (mirror + xcodegen + build) | 3.6 s | 44 |
| `xcodebuild test -only-testing:ScrollsAppTests` (build + 39 Swift Testing tests on the simulator) | 34 s; the tests themselves 1.9 s | ≈ 60 |

The app target compiles with **0 Swift warnings**. One build-system warning remains in the app target: the
'Strip extended attributes' run-script phase of project.yml has no outputs (it needs `basedOnDependencyAnalysis: false`).
After a failing test run, xcodebuild sat in its post-failure `simctl diagnose` for > 10 min under load and was stopped
by hand once the results were written.

## N0 · the stitch: the whole tree builds (2026-10-10)

**What changed for builds.** Every declared target now has sources (N0's ports and the other packages' stubs), so the
bring-up manifest evaluates to exactly §8.4.3 (`check.sh quick`: "all 29 declared targets built") and the app builds
from the real tree with no mirror scaffolds. `quick --wp N1…N6` now also builds ScrollsService (and scrolls-cli for N2,
N3, N4, N6), because those packages' `LiveAtlas+<Area>.swift` files and CLI commands live there; test targets stay
narrowed to the package's own. A test target whose every test is skipped (the stubs) is a SKIP row, never PASS. The
lint row also checks first-line OWNER headers of `.metal`, `.h`, `.mjs` and `.sh` files and the inline-SQL rule.

**Mirror and simulator of this part.** `SCROLLS_BUILD_DIR=$TMPDIR/scrolls-N0`; simulator "Scrolls N0" (iPhone 15 Pro
Max, iOS 27.0, `59811F73-5C10-43FC-8CE3-89645060C09D`), created with `SCROLLS_SIM="Scrolls N0" Tools/build.sh
sim-create`. All measurements on this Mac (M1 Max, macOS 27.2, Xcode 27.0, Swift 6.4), `SCROLLS_JOBS=4`, while other
sessions loaded the machine; the load averages are the 1 / 5 / 15-minute values at start → end.

### The whole package and the app

| What | Wall | Load at start → end |
|---|---|---|
| Clean gate of the whole package on a brand-new mirror (`check.sh quick`, no `--wp`): mirror, one build of all 15 targets and 14 test targets (81 s), every test target (51 s), golden rows, lint — PASS, 41 rows | 139 s | 73 / 85 / 80 → 49 / 70 / 75 |
| The same gate on a warm mirror, nothing to compile (build 2 s, tests 52 s) | 57 s | 27 / 19 / 20 → 33 / 22 / 22 |
| `check.sh quick --wp N0` on a fresh `kit-quick-N0/` (N0 now pulls ScrollsService's whole closure: build 80 s, tests 48 s) | 132 s | 118 / 143 / 90 → 69 / 116 / 87 |
| Clean Debug simulator build of the app (new mirror, fresh derived data and module cache: LabKit Core/Feedback/UI, all 14 engine libraries, the app) — 0 Swift warnings | 58.2 s (user 165 s) | 27 / 22 / 21 → 25 / 22 / 22 |
| Incremental simulator build after a ScrollsJobs + app change | 15.8 s | 63 / 113 / 86 → 57 / 109 / 85 |
| Incremental simulator build after one ScrollsStore file | 11.5 s | 53 / 100 / 83 → 51 / 98 / 82 |
| No-op simulator build (mirror + xcodegen + xcodebuild) | 3.2 s | 16 / 23 / 42 |
| `build.sh app-test` (incremental build, ScrollsAppTests 40 tests + 6 skipped UI-test stubs, on "Scrolls N0") | 23.0 s | 47 / 89 / 80 → 62 / 89 / 80 |
| `build.sh cli` on a fresh `kit-cli/` (release, full BuildInfo; SwiftPM's own time) | 67.3 s | 16 / 26 / 45 → 17 / 24 / 43 |
| `golden.sh g1.core` (21 families, m5r clone included) | 13.3 s | ≈ 16 |

### `check.sh quick --wp <pkg>` per package

"fresh" = a brand-new `kit-quick-<pkg>/` scratch (the package's first gate: everything its narrowed package needs is
compiled); "touched" = the same gate after `touch` of one file the package owns (N8 and I own no engine target, so
theirs is a no-op rerun). Build and test are the gate's own step times.

| Package | Gate | Wall | Build step | Test step | Rows | Load at start → end |
|---|---|---|---|---|---|---|
| N0 | fresh | 132 s | 80 s | 48 s | 33 | 118 / 143 / 90 → 69 / 116 / 87 |
| N0 | one-line edit of `ScrollsJobs/JobQueue.swift` | 56 s | 6 s | 47 s | 33 | 18 / 28 / 48 → 17 / 26 / 46 |
| N1 | fresh | 75 s | 67 s | 4 s | 29 | 49 / 70 / 75 → 54 / 67 / 73 |
| N1 | one-line edit of `ScrollsIngest/ImportPipeline.swift` | 14 s | 8 s | 3 s | 29 | 29 / 33 / 51 → 29 / 33 / 51 |
| N2 | fresh | 81 s | 71 s | 5 s | 30 | 53 / 66 / 73 → 75 / 68 / 73 |
| N2 | one-line edit of `ScrollsSources/SourceRegistry.swift` | 15 s | 7 s | 5 s | 30 | 29 / 33 / 51 → 26 / 32 / 50 |
| N3 | fresh | 77 s | 69 s | 4 s | 29 | 80 / 69 / 73 → 65 / 69 / 73 |
| N3 | one-line edit of `ScrollsQuery/QueryDef.swift` | 13 s | 7 s | 3 s | 29 | 26 / 32 / 50 → 23 / 31 / 49 |
| N4 | fresh | 77 s | 70 s | 3 s | 29 | 62 / 68 / 72 → 33 / 58 / 68 |
| N4 | one-line edit of `ScrollsAnalysis/ScrollsAnalysis.swift` | 13 s | 7 s | 3 s | 29 | 23 / 31 / 49 → 22 / 30 / 49 |
| N5 | fresh | 75 s | 67 s | 3 s | 29 | 29 / 56 / 67 → 30 / 49 / 64 |
| N5 | one-line edit of `ScrollsLineage/Boilerplate/BoilerplatePass.swift` | 12 s | 6 s | 3 s | 29 | 22 / 30 / 49 → 20 / 29 / 48 |
| N6 | fresh | 78 s | 70 s | 3 s | 29 | 30 / 49 / 63 → 68 / 55 / 65 |
| N6 | one-line edit of `ScrollsProvenance/ScrollsProvenance.swift` | 12 s | 6 s | 3 s | 29 | 20 / 29 / 48 → 19 / 29 / 48 |
| N7 | fresh | 54 s | 46 s | 3 s | 30 | 67 / 56 / 65 → 43 / 51 / 62 |
| N7 | one-line edit of `ScrollsRender/ScrollRenderer.swift` | 8 s | 2 s | 3 s | 30 | 19 / 29 / 48 → 18 / 28 / 47 |
| N8 | fresh (ScrollsCore + ScrollsCoreTests only) | 34 s | 27 s | 3 s | 28 | 39 / 50 / 62 → 26 / 45 / 60 |
| N8 | rerun, nothing changed | 8 s | 2 s | 2 s | 28 | 26 / 45 / 60 → 25 / 45 / 59 |
| I | fresh (ScrollsCore + ScrollsCoreTests only) | 34 s | 28 s | 2 s | 28 | 25 / 45 / 59 → 19 / 41 / 57 |
| I | rerun, nothing changed | 7 s | 2 s | 2 s | 28 | 19 / 41 / 57 → 18 / 40 / 57 |

Every gate above passed. Each also writes its report (`Reports/check-quick-<stamp>.json`). Two lessons: a bare `touch`
recompiles nothing (Swift 6.4's incremental build compares contents; the touched reruns took 7–11 s with 2 s build
steps), so an incremental measurement needs a real edit; and N0's gate is dominated by its tests (ScrollsJobsTests
≈ 41 s, of which the StallTests' 30 s statement), not by compiling. A fresh narrowed scratch costs ≈ 70 s for N1–N6
(the ScrollsService closure) at load 30–80.

### Store and Jobs (from N0b, its mirror `$TMPDIR/scrolls-N0b`)

A fresh mirror of Core, Contracts, Store and Jobs built in 59 s; touching a Store file cost 10.6 s, a Jobs file 4.9 s,
and a no-op build 1.9 s (load 15–29). ScrollsJobsTests take ≈ 41 s, 30 of them the StallTests' 30 s statement.

### Transfer to the phone

Not measured: his iPhone was not connected (tunnel unavailable, no DDI services). The row is queued in
`Reports/device-queue.json` as suite `transfer` with the exact command (a 236 MB file by `devicectl device copy to` into
Documents/Import); MB/s and the cable type go here when the integrator runs it.
