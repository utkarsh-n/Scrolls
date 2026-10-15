<!-- OWNER: lead (iOS synthesis, 2026-10-09). Replaces the placeholder. A DELTA on Docs/SPEC.md: SPEC's semantics (§1–§2), data model (§3), algorithms (§4) and honesty rules (§13) remain the law unless a ΔS row in §0.3 below overrides one explicitly. -->
# Scrolls for iPhone — native SPEC (IOS-SPEC v1.0)

**Status:** the final build specification of the native port, 2026-10-09. It is a **delta on SPEC v1.0**: everything SPEC.md says about meaning, evidence, the schema, the algorithms and honesty still holds on the phone, and this file changes it only where a row of the ΔS register (§0.3) says so in words.

**Base:** the *engine-port-first* proposal (`Docs/ios-proposals/engine.md`), which both judges chose. Grafted onto it are the named ideas of the *experience* and *platform* proposals. Every fatal flaw the judges found is fixed, and every gap they listed is closed; §7.4 maps each one to the section that fixes it.

**Measurements.** A number marked **(measured)** was taken on 2026-10-09 on this Mac (M1 Max, macOS 27.2, Swift 6.4, system SQLite 3.54.0, Node 26.10.0 / ICU 78.3 / Unicode 17.0) by a proposal author or a judge, and the source is named. The Mac ran at load average 300–1,000, so times are CPU times or pessimistic. A number marked **(est.)** is a planning estimate for the A17 Pro. Package N0's device probe and each milestone's device run replace it with a measured value in `Native/Docs/VERIFICATION.md`.

**How implementation agents use this file:**
1. Read §0 first: the decisions, the ground truth and the ΔS register.
2. Then read §8, the build plan, which gives every file one owner.
3. Then read the sections your package implements, and the SPEC sections your package ports (named in the port map, §1.3).
4. Read SPEC §13. Reviewers reject code that breaks an honesty rule.

Where this file gives a name (a file, type, function, table, launch argument), use that name. A contract change goes through the N0 owner (§8.2).

**The rule behind the port.** SPEC says every pixel answers three questions: what is the evidence, how was it obtained, and how much of the record did we look at. On the phone, every number must also carry its past. That means the reference computation it equals, the tolerance it was checked against, and the generation and journal entry it came from.

---

## 0. Decisions, ground truth, and the deltas to SPEC

### 0.1 Decisions in one page

| # | Decision | Why |
|---|---|---|
| N-01 | **Native SwiftUI, iPhone only, iOS 27,** on his iPhone 15 Pro Max (A17 Pro: 2 performance + 4 efficiency cores; 8 GB; 430 × 932 pt; 120 Hz ProMotion). Portrait first. The Scroll, the reader and Compare also work in landscape. | His decision (brief, 2026-10-09); Cipher and Loom are the same. |
| N-02 | **The whole engine runs in Swift on the phone by default.** That covers import, search, timeline aggregation, Compare, lineage and quotation detection (including the global reuse index), clustering, vector spaces, drift and tone. The Mac runs the **same** Swift engine only for development, for the device = Mac check (G6), and to recover a lost atlas. **No phone feature requires an artefact built on the Mac.** | His fixed decision. Both judges marked the "Mac builds the spaces and the reuse index by default" path as a violation of it. |
| N-03 | **The web build is the reference implementation.** It is frozen at the git tag `ref-freeze-1` once the RF fixes of §2.1 land. The golden fixtures are generated from it, and it changes only through the finding protocol (§2.1). | Differential testing needs an oracle that stays still. |
| N-04 | **Code lives in `Scrolls/Native/`.** It holds an XcodeGen `project.yml`, the `Scrolls` app target, the `ScrollsKit` package (14 library targets plus the `scrolls-cli` Mac executable), plus `Tools/`, `Golden/` and `Docs/`. **The engine** links only Foundation, Accelerate, Compression, CryptoKit, NaturalLanguage and the system `SQLite3`. **The app** adds SwiftUI, UIKit, Metal, Charts, BackgroundTasks, UniformTypeIdentifiers and LabKit. **There is no third-party code.** | His conventions (Loom, Rheo, LabKit). The same engine runs on the phone, in `swift test` and in the CLI. |
| N-05 | **The schema DDL is byte-identical:** `schema.sql` is copied verbatim and its sha256 is tested. The **device profile** only *adds* tables; it never ALTERs a §3 table. `original_meta_json` stays verbatim. **Compact create revisions** keep every `relationship_revision` row and id. | The reference's own readers then keep working, verified at `cube.mjs:777`, `compare.mjs:898`, `arcs.mjs:121`, `graph.mjs:56` and `documents.mjs:86`. Swift can also open the reference's own databases. |
| N-06 | **Routes become `AtlasService`,** an in-process async API. Its request and response types are Codable mirrors of contract 1.3.0, and all **65** `tests/contract/*.json` fixtures round-trip byte-equal in canonical form. `Gated<T>` is an **enum** with no numeric accessor, and every data response has a required `provenance` block. | The contract is where the honesty rules were designed in. |
| N-07 | **Concurrency** uses: <br>• a `Writer` actor; <br>• **3 `ReadConnection` actors** on `DispatchSerialQueue` executors, one of them reserved for interactive reads; <br>• a `JobQueue` actor with `after:` dependencies; <br>• analysis jobs that are `writes: false` and commit through a guarded short write (`E_INPUTS_CHANGED`). <br>Public async entry points are actor-isolated or `@concurrent` under `NonisolatedNonsendingByDefault`. `EngineAssert.offMain()` guards the kernels. `BoundedChannel` gives adapters backpressure, and TaskGroups split work into ≤ 5 ms work-stealing chunks. | D11 on iOS. It closes HANDOFF's "analysis jobs take the writer slot". |
| N-08 | **Parity is designed, not hoped for.** The engine uses: <br>• a generated token-class table; <br>• an `NSString` fold, with `String.lowercased()` banned by lint; <br>• `NSString` `.bySentences` enclosing ranges; <br>• `JSNumber` (ECMA-262 Number::toString) for canonical JSON; <br>• `ReferenceCollation` for `localeCompare`; <br>• a bit-exact `mulberry32`; <br>• exact paths written as f64 loops in the reference's summation order. | Each item was measured (§0.2). |
| N-09 | **Text is stored in passage-aligned LZFSE chunks** (target 32,768 UTF-16 units) behind `TextStore`. `InlineTextStore` reads the reference databases and `ChunkedTextStore` reads the device atlas. | 917 MB becomes ≈ 390 MB. Counting decodes only the candidate chunks, which fixes HANDOFF's "counting reads whole books". |
| N-10 | **The data path, all on the phone.** <br>• The demo starter is bundled, prebuilt by the same engine. <br>• Cipher's metadata pack (≈ 29 MB) and full-text pack (≈ 163 MB) are **bundled** and built on the phone (phases A, A2, B). <br>• STEMM arrives from the Mac as a source pack (≈ 236 MB) plus the Ngram file (173 MB), because the fetchers stay Node scripts (D13). It is **loaded on the phone**. <br>• Token streams, the English pooled space, era slices and the global reuse index are **built on the phone**. | Per N-02. The bundled text pack is the platform graft: his whole Cipher corpus is on the phone with no Mac. |
| N-11 | **Ids:** entity rows from a source take ids from a **source slot range** (`slot × 10⁸ + n`). Rows made by the user or by on-phone runs take ids from the **local range** (≥ 1.5 × 10⁹). Log-ordered tables keep commit order. **Every id is < 2³¹.** | Ids stay stable across rebuilds, so the ids inside saved view states keep resolving. The cube's `Int32` and the winnow `u32` packing stay valid. |
| N-12 | **Generations.** An atlas generation is a **deterministic replay** of three inputs (the starter, the packs, the journal) by one engine build. The phone and the Mac produce identical generations (G6). A Mac-built generation arrives by `devicectl`, Finder or AirDrop and is installed by **swap**: `Atlas.next` → `Atlas`, with `Atlas.prev` kept for a one-step rollback. **No layer is ever copy-merged.** | It replaces the engine proposal's per-layer copy-apply, which an iOS expiry could roll back forever. D17 holds across generations by construction (§6.4). |
| N-13 | **User state** stays in the atlas's own tables and triggers. Every user act is first appended (with fsync and a CRC) to a **write-ahead JSONL journal** in the backed-up `Notebook/` folder. **No SwiftData.** | D17, D18 and I3 live in SQLite triggers and CHECKs. The atlas is excluded from backup; his notebook is not. |
| N-14 | **Background work.** <br>• User-started long work runs under **`BGContinuedProcessingTask`** with stall-proof progress: no SQL statement may run longer than 2 s without reporting progress. <br>• `BGProcessingTask` is opportunistic only. <br>• Heavy analysis never *starts* in the background. | The SDK header warns that stalled tasks "may be forcibly expired". |
| N-15 | **Memory.** <br>• Dirty-memory budgets: interactive ≤ 400 MB, any job ≤ 600 MB, total ≤ 1.2 GB. <br>• File mappings total ≤ 2.0 GiB through `MappedFileRegistry`. <br>• The app requests `increased-memory-limit` and `extended-virtual-addressing`, and **no budget depends on either**. | Jetsam limits and the per-process VM map are unpublished; they are measured at M0. |
| N-16 | **Experience** (experience proposal §4, adopted wholesale with its flaws fixed). <br>• A Maps-style persistent inspector built as a **custom overlay**, not a `.sheet`, with peek, half and large detents. <br>• One `NavigationStack` for the pushed destinations, and **at most one system presentation** at a time. <br>• The timed first-minute script. <br>• Tap replaces hover: every bin, gap, wash, cap, arc and seam answers with its generated sentence. | Thumb reach on a 6.7" phone. The judges found that the presentation stack and the stagger animation were broken in the original. |
| N-17 | **Rendering.** <br>• Metal instanced primitives from the ported display list. <br>• `DisplayListCanvas` (SwiftUI `Canvas`) is both the fallback renderer (`-renderer canvas`) and the snapshot renderer. <br>• A Metal vs Canvas pixel diff of ≤ 1% is a test. <br>• The vantage, ghosting and fades are shader uniforms. <br>• The hit grid and VoiceOver use **the same vantage predicate** as `display.mjs` `gate()`. | 20k cells at 120 Hz is a GPU job. The snapshot equals the screen *by test*, not by assumption. |
| N-18 | **Accessibility.** <br>• Audio Graphs with `isContinuous: false`, so audio never bridges a gap. <br>• Rotors for bars, gaps, arcs, marks and seams. <br>• An adjustable playhead, and Magic Tap for Play. <br>• The table alternative built from the same arrays as the renderer. | SPEC §8.6 on iOS. |
| N-19 | **LabKit:** adopt LabKitCore (`DeviceConditions`, `FramePacing`, `Throttle`, `CopyLint`), LabKitFeedback (`HapticEngine`, `HapticTap`) and the chrome parts of LabKitUI (§4.22). **Not adopted:** LabKitRender, LabKitSensors, `ProvenanceBadge`, `LabPlot`, `.labChrome`, `CanvasRegion` and `KnobConsole`. The engine never imports LabKit; it sees `DeviceConditionsSource`. | Scrolls is an instrument for reading evidence, not a physics toy (§4.22 says why for each piece). |
| N-20 | **Tests.** <br>• Eight golden tiers plus the contract round-trip. <br>• `DIVERGENCES.json`. <br>• Licensed text is redacted from committed fixtures. <br>• `Tools/check.sh` and `Tools/device-check.sh`. <br>• A device row that cannot run is recorded `PENDING_DEVICE`, never PASS. | The reference is the specification that runs. |
| N-21 | **Reference stewardship.** <br>• The RF fixes land before the goldens freeze: the high-severity 'und' denominator bug, and as-saved Compare and inspector. <br>• Fresh snapshots `m1r` and `m5r` are built from the frozen reference. <br>• Golden regeneration is serialised, with a mid-round rebase protocol. | Otherwise the goldens would freeze known bugs into the Swift engine. |
| N-22 | **Self-tests run in an isolated root** (`-atlasRoot`). They never write into his notebook or his atlas. | The judges found that the device journeys would have written into his real data. |
| N-23 | **State restoration:** `@SceneStorage` holds the canonical view-state hash plus the phone's UI state (sheet detent, pushed route, inspector tab). | iOS kills apps in the background. |
| N-24 | **Indic scripts** get a font cascade, their own line height and checks on the label atlas. Search offers romanised typeahead through the ported `romanKey` (शून्य from "shunya"). | 825 Wikisource books are in Hindi and Gujarati, and he types on an English keyboard. |
| N-25 | **Builds for parallel agents** use a persistent mirror per agent (`SCROLLS_BUILD_DIR`), builds per target and a `-j` cap. Their real cost is measured at M0. | The Mac runs at load 300–1,000. |

### 0.2 Ground truth for the port (measured; agents must not re-discover it differently)

| Fact | Value | Consequence |
|---|---|---|
| System SQLite | **3.54.0** in the iOS 27 SDK header and the macOS library. It supports FTS5 with the exact tokenizer `unicode61 remove_diacritics 2 categories 'L* N* Co M* So'` (Gujarati and Devanagari words stay whole; ◉ is a token), `trigram`, `fts5vocab` instance, `contentless_delete=1`, `rtree_i32`, JSON1 and STRICT. Compile options: `THREADSAFE=2`, `MAX_MMAP_SIZE=1073741824`, `OMIT_LOAD_EXTENSION`; the session extension is not in the iOS header (engine, platform and experience, measured) | `Store/Probe.swift` re-checks all of this on the device at first launch and refuses to open an atlas, with a clear message, if any of it differs. |
| m5-stemm snapshot (`dbstat`) | 3,554 MB: <br>• `document_text` 917 MB; <br>• `document` 463 MB (`original_meta_json` 278 MB, of which OpenAlex 192 MB); <br>• `passage_fts` 391 + 37 MB; <br>• `relationship_revision` 242 MB (595,524 rows, 593,078 of them `create`); <br>• `passage` 202 MB + 160 MB of indexes; <br>• `relationship` 180 MB; <br>• `doc_tag` 148 + 79 MB; <br>• `date_assertion` 135 MB + R-tree 34 MB; <br>• `label_tri` 121 MB. <br>394,317 documents · 2,763,200 passages · 146.7 M passage tokens (engine, measured) | Storage budget, §3.1. |
| Readers of `original_meta_json` | `cube.mjs:777` (`cellsSpec`) and `compare.mjs:898` (`withinCellShares`) read `json_extract(original_meta_json,'$.sample_cell')` (verified here) | **The metadata is kept verbatim.** Pointer-only metadata (experience Δ2, platform Δ2) would quietly empty the OpenAlex share cells (C3). |
| As-saved relationship filter | `EXISTS (… relationship_revision v WHERE v.relationship_id = r.id AND v.rev = 1 AND v.id <= ?)` at `arcs.mjs:121` and `graph.mjs:56` (verified here) | **Every rev-1 row stays.** Synthesising rev 1 (experience Δ3) would drop every documented and computed arc from as-saved views. |
| Document card | `routes/documents.mjs:86` returns every `doc_tag` row (verified here) | OpenAlex `keyword` tags stay (platform Δ7 rejected). |
| Token classes | Over all 1,112,064 scalar values, Swift 6.4 `generalCategory` and Node's regex classes differ in **0** (engine, measured) | The table is still shipped (generated), so `u61m-1` stays frozen when iOS updates Unicode. |
| Fold | `precomposedStringWithCanonicalMapping` + `NSString.lowercased` = JS on all 2,572 code points whose fold changes, plus the word-context cases. Swift `String.lowercased()` breaks **Final_Sigma**: `"ΟΔΟΣ ΣΑΣ"` → `οδοσ σασ`, against JS and NSString `οδος σας` (engine; both judges re-measured) | Fold goes through NSString; `String.lowercased()` is banned in the engine (lint test). |
| Sentence breaks (`seg-1` long-block splits) | The starts of `NSString.enumerateSubstrings(.bySentences)` **enclosing ranges** = `Intl.Segmenter('en')`: **562,089 / 562,089** over 30 Cipher books. `NLTokenizer(.sentence)` missed 6,507 (engine, measured) | The segmenter uses NSString enclosing ranges plus the reference's ।/॥ pass. No `seg-1i` fallback exists (experience's was rejected). |
| Canonical JSON numbers | `JSONEncoder` and `JSON.stringify` disagree on **6 of 9** probe doubles (`5e-07`/`5e-7`, `1e-06`/`0.000001`, `-0`/`0`, …) (engine, measured) | `JSNumber.format`, golden over 20,000 doubles. |
| Swift throughput (M1 Max, one thread) | Tokenizer **40.3 M tokens/s** (229 MB/s). Naive Foundation fold 2.4–3.3 M tokens/s. FTS5 insert **0.35–0.37 s CPU per M tokens**, index 5.1–5.5 MB per M tokens. 1 M-row insert in one transaction 2.12 s (engine, experience, measured) | ASCII fast path + `TokenInterner` (each distinct form folded once). |
| Text compression | LZFSE over UTF-8: 2.11× at 8k-unit chunks, **2.24× at 16k, 2.35× at 32 KB**, 2.42× at 64k. Decode 46–50 µs per 32 KB chunk (engine, platform, experience, measured) | 32k-unit passage-aligned chunks: ≈ 390 MB for 917 MB. |
| CPU raster | Core Graphics fills 20,000 rects at 1290 × 2796 px in **82–115 ms** per frame (experience, measured) | The Scroll is drawn in Metal. Canvas is the fallback (≤ 60 Hz, coarser tier). |
| Denominators | Cold SQL denominator for one tile: **3.75 s** (experience) and 623 ms (platform) (measured) | The slice cube is ported, not replaced by SQL. |
| Contract fixtures | **65** files in `tests/contract/` (counted here) | All 65 round-trip (C0). |
| Reference state | HEAD `3607c28`; the fix pass is committed (`6cc124c`, `3607c28`). Snapshots `m1` (4 Oct) and `m5-stemm` (8 Oct 13:49) predate both commits. `m5-stemm/originals` is a **symlink into a session scratchpad** (checked here) | RF-4 builds fresh snapshots `m1r`/`m5r` with their originals stored inside them. |
| Source packs (LZFSE, measured by platform) | `cipher-meta` ≈ 29 MB · `cipher-text` ≈ 163 MB (134.9 + 27.9) · STEMM ≈ 236 MB (gutenberg-stemm 141 · OpenAlex 73 · Wiktionary 22) · Ngram baseline 173 MB (incompressible; shipped as its own file) | App bundle ≈ 210 MB with both Cipher packs. |
| Node on this Mac | Homebrew `node` is broken; run it with `DYLD_LIBRARY_PATH=/opt/homebrew/Cellar/simdjson/4.6.11/lib:/opt/homebrew/Cellar/hdrhistogram_c/0.11.10/lib` | `Tools/golden.sh` sets it from `$SCROLLS_NODE_ENV`. |

### 0.3 Explicit deltas to SPEC.md (the ΔS register)

Only these rows override SPEC.md. Anything SPEC says that is not listed here holds on the phone unchanged.

| ΔS | SPEC section | Change on the phone | Why |
|---|---|---|---|
| ΔS-1 | D12, D20, §7, §8 | **No Node, HTTP server or browser.** The contract 1.3.0 shapes are served in-process by `AtlasService`. Host/Origin checks, static serving and mock mode are dropped. ETag becomes a memo keyed by `data_version`. SSE becomes `AsyncStream<AtlasEvent>`. `X-Scrolls-Session` becomes a `SessionID` minted per launch (it feeds `compare_log` only). | No transport exists on the device. |
| ΔS-2 | D11, §4.12 | **Concurrency.** <br>• 3 reader actors and 1 writer actor. <br>• Cancellation is Task cancellation plus `sqlite3_interrupt`; the 5 s deadline is a progress handler. <br>• Jobs gain `after:` dependencies. <br>• `cluster`, `vectors`, `drift`, `tone`, `collocations` and `layout` become `writes: false` and commit in one short guarded write. | Worker threads and SharedArrayBuffers do not exist in Swift. |
| ΔS-3 | §0 runtime layout; `config.mjs` | The container layout of §3.9 replaces `~/Developer/scrolls-data`. The phone's analogue of `E_DB_IN_ICLOUD`: the atlas never lives under `Documents/` or in an App Group. The CLI keeps `E_DB_IN_ICLOUD`. | iOS sandbox; avoids `0xdead10cc` on suspension. |
| ΔS-4 | §3 | The **device profile** (§3.2) adds tables only. In it: <br>• `document_text.original` is `''` for chunked documents, and the text lives in `text_chunk`; <br>• adapter and algorithm `create` revisions store `after_json = '{"$row":1}'`. <br>No §3 statement is edited or removed. | 917 → ≈ 390 MB and 242 → ≈ 35 MB, with every reader's output unchanged. |
| ΔS-5 | D10, §6.8 | Cipher's bootstrap reads the **bundled packs**, not `SCROLLS_CIPHER_ROOT`. Phases A, A2 and B keep their meaning; budgets are in §5. | The phone cannot read his iCloud folder. |
| ΔS-6 | D13, §10.1–§10.2 | STEMM adapters read **source packs**. A pack's members are the staged files themselves, including `FORMAT.md` and `MANIFEST.json`, each checked by sha256. The fetchers stay Node scripts that he runs on the Mac; `scrolls-cli pack` wraps their output. | The app has no networking code. |
| ΔS-7 | §4.0, §13.17 | Runs record `code_hash` = the hash of the Swift sources of that stage. `meta.icu_version` = `ios<version>/unicode<N>` (`macos…` for the CLI). The tokenizer and segmenter versions stay `u61m-1` and `seg-1`, because their parity is tested. | Reproducibility, honestly recorded. |
| ΔS-8 | §1.4, §1.11, §8.6 | Geometry is in points (§4.3). The demo's first paint is **one 200 ms fade of the whole data plane** (none under Reduce Motion), **not** a left-to-right stagger. | A stagger reads as growth over time before Play is pressed (judge). |
| ΔS-9 | §8 (all) | The frontend is §4 of this file (SwiftUI + Metal). The §8.5 keyboard map is kept for hardware keyboards. The display list and hit grid keep their §8.3–§8.4 meaning, through the uniform-vantage path of §4.23 (DV-7). | Native port. |
| ΔS-10 | §2.B | The two-period constellation ships in **overlay** mode only; *split* mode is later. | Two layouts side by side are unreadable at 430 pt. Overlay plus the diff list carries the same comparison. |
| ΔS-11 | §1.8 | In portrait, arcs are requested with `limit=150` (300 in landscape). The engine's own bundling rule covers the rest, with its "+n more arcs" chip. | The API's own `limit` parameter; no semantic change. |
| ΔS-12 | §2.F | The notebook's as-of slider has **one stop per revision timestamp**, not one per day. | HANDOFF's open item; the API already takes a timestamp. |
| ΔS-13 | §2.B, §10.5 | A constellation opened from a Term trail defaults to the **decade with the most matches**, not the current decade. | HANDOFF's open item: 2020–2029 is nearly empty for pre-1928 words. |
| ΔS-14 | §7.3, §14 | The portable HTML bundle export is **later**. PNG, SVG, JSON, JSONL, CSV, the notebook export and `.scrollsview` ship in v1. | Scope (§7.3). |
| ΔS-15 | §11 | The test plan is §2 and §8 of this file: Swift tests plus the differential tiers. An acceptance row passes only on the device, or on the proxy its row declares. | Native port. |
| ΔS-16 | §12 | The build plan is §8 of this file. | Native port. |
| ΔS-17 | §13.16 | **The app contains no networking code.** There are two network surfaces, both opt-in and labelled: <br>(a) the system download of Apple's NaturalLanguage assets, offered on the Tone gate card; <br>(b) a source link, which opens in Safari when tapped. | Local only. |
| ΔS-18 | §8.2 | The view-state grammar `v=1` is **unchanged**, so web and phone links are interchangeable. Phone-only UI state lives outside the hash, in `@SceneStorage("ui")`. | Reproducible views. |
| ΔS-19 | §4.12 | WAL pause threshold 256 MB on the phone (1 GB in the CLI). No `VACUUM` on the phone. FTS merges run incrementally (`'merge'` steps) instead of one `'optimize'` statement. | Stall-proof background work (N-14). |
| ΔS-20 | §14 | The v1 vs later table is §7.3 of this file. | Native scope. |

Unchanged, and worth saying so:
- D1–D9, D14–D19, I1–I4 and the §13 honesty rules.
- The tokenizer, segmenter, date grammar, fit-or-wash, the conservation law and every gate and threshold of §4.11.
- The evidence vocabulary and styles, and the contract shapes.
- The demo world, the UI copy (ported byte-equal) and the colour tokens of §8.7.
- D17 is **strengthened**: it now holds across atlas generations (§6.4).

---
## 1. Architecture

### 1.1 Folder layout (the full tree with owners is §8.1)

```
Scrolls/                          iCloud folder; gitdir ~/Developer/git/Scrolls.git (the existing repo)
├─ server/ src/ public/ tests/ scripts/ data/ tools/    the Node REFERENCE (frozen at ref-freeze-1; RF findings only)
├─ Docs/                          SPEC.md (law), IOS-SPEC.md (this delta), the reference's docs
└─ Native/
   ├─ project.yml                 XcodeGen: app + unit-test + UI-test targets, iOS 27, iPhone only
   ├─ Tools/                      build.sh · check.sh (+ check.d/) · golden.sh · device-check.sh · packs.sh · atlas.sh
   ├─ Golden/                     Node generators that import ../../server and ../../src read-only
   ├─ ScrollsKit/                 the engine package (14 library targets + scrolls-cli) and its tests
   ├─ Scrolls/                    the app target (SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor)
   ├─ ScrollsAppTests/  ScrollsUITests/
   ├─ Reports/                    machine-readable outputs (JSON), git-ignored except Reports/milestones/*.json
   └─ Docs/                       pre-created placeholders (§8.9)
```

Runtime data never lives in iCloud.
- **The phone's container** follows §3.9.
- **On the Mac:**
  - goldens go to `~/Developer/scrolls-golden/<refcommit>/`;
  - packs to `~/Developer/scrolls-packs/<pack-version>/`;
  - CLI-built generations to `~/Developer/scrolls-atlas/<date>/`;
  - fresh reference snapshots to `~/Developer/scrolls-snapshots/{m1r,m5r}/`.
- **The CLI** keeps the reference's `E_DB_IN_ICLOUD` refusal.

### 1.2 Package targets, dependencies and isolation

| Target | Depends on | Holds |
|---|---|---|
| `ScrollsCore` | — | dates, tokenizer, fold, sentence breaks, ids, canonical JSON, viewstate, evidence style, format, generated vocab and copy |
| `ScrollsContracts` | Core | the Codable contract 1.3.0 types, `Gated`, `ScrollsError`, `Canonical*` |
| `ScrollsStore` | Core, Contracts | SQLite layer, schema + device profile, `TextStore`, row ids, journal file, packs, LogicalDump, probe |
| `ScrollsJobs` | Store | `JobQueue`, `JobContext`, runs, `BoundedChannel`, throttle |
| `ScrollsIngest` | Jobs | `DocumentWriter`, segmenter, langid, formats, mapping, validation |
| `ScrollsSources` | Ingest | the demo, Cipher and STEMM adapters |
| `ScrollsQuery` | Jobs | search, materialise, cube, timeline, KWIC, exports |
| `ScrollsAnalysis` | Query | Compare, collocations, spaces, clustering, drift, layout |
| `ScrollsNL` | Analysis | tone and modern-reader neighbours (NaturalLanguage) |
| `ScrollsLineage` | Analysis | boilerplate, winnowing, reuse index, near quotes, cues, trace, graph, genealogy |
| `ScrollsProvenance` | Query | relationships, reviews, annotations, anchors, views |
| `ScrollsService` | Sources, Query, Analysis, NL, Lineage, Provenance | `AtlasService`, `LiveAtlas`, `MockAtlas`, pipelines, generations, journal replay |
| `ScrollsScrollModel` | Core, Contracts | the pure display-list port (scale, tiers, model, display, hit, a11y rows) |
| `ScrollsRender` | ScrollModel | Metal renderer, `DisplayListCanvas`, `SVGWriter`, `LabelAtlas` (iOS + macOS) |
| `scrolls-cli` | Service, ScrollModel | the Mac executable |

- **14 library targets plus `scrolls-cli`.** Each WP compiles and tests its own targets alone (`swift build --target`). This keeps one package's compile error from blocking every agent (platform's single-target flaw).
- **Bootstrap pipelines and layer orchestration live in `ScrollsService`.** It is the only target that sees every module, so adapters (Sources) never import Lineage or Analysis. Bootstrap phase B is adapters → boilerplate (Lineage) → derived builds (Analysis).
- **The isolation rules hold in review and in a test:**
  1. **Engine targets have no default isolation.** Data types are `Sendable` structs and enums. `Connection`, `Statement` and the writers are non-Sendable classes confined to one actor.
  2. Every engine target enables `NonisolatedNonsendingByDefault`. Under it, a plain `nonisolated async` function runs on its **caller's** actor. So every public async entry point is either **actor-isolated** (`ReadConnection`, `Writer`, `JobQueue`) or marked **`@concurrent`** (`LiveAtlas`'s methods, `DisplayBuilder.build`, every kernel).
     - In Debug, `EngineAssert.offMain()` (`precondition(!Thread.isMainThread)`) opens every kernel: materialize, tiles, cube build, compare, k-means, rSVD, cooc, winnow, layout and display build.
     - A UI test drives the M1 journey with the assertion on.
  3. **The app target** uses `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor` (his convention). Its view models are `@MainActor @Observable`. App types that cross into engine tasks are declared `nonisolated struct … : Sendable`. The app touches the engine only through `AtlasService`, `AtlasPlatform` (§8.4.6), and the value types of `ScrollsContracts`, `ScrollsScrollModel` and `ScrollsRender`.
  4. **The engine never imports LabKit.** Thermal and Low Power policy arrive through `protocol DeviceConditionsSource`; the app bridges LabKitCore's `DeviceConditions.current`, and the CLI passes `.unthrottled`.
  5. **Debug engine builds are `-O`** (`.unsafeFlags(["-O"], .when(configuration: .debug))`; Loom's rule: `-Onone` is ≈ 20× slower on arithmetic). `-Xcc -DACCELERATE_NEW_LAPACK` applies to Analysis and Lineage.

### 1.3 Port map (reference → Swift)

Status: **P** ported 1:1 and differential-tested · **R** redesigned (same contract, new mechanism) · **D** dropped · **N** new. The reference line counts are in the engine proposal §1.3; the Swift estimate is ≈ 31k engine lines, ≈ 14k app lines and ≈ 12k test lines plus generated goldens.

| Reference | Swift target / files | St | Notes |
|---|---|---|---|
| `src/shared/tokenize.mjs` | `ScrollsCore/Text/{Tokenizer,TokenClassTable(generated),Fold,TokenInterner}.swift` | P | Works on `UnsafeBufferPointer<UInt16>`, so offsets are UTF-16 (D4). `findSequence`, `ftsPhrase` and `isSentenceInitial` are verbatim. |
| `dates.mjs` | `ScrollsCore/Dates/{DayMath,DateGrammar,Bins,Labels}.swift` | P | Integer days-from-civil with JS `setUTCFullYear` rollover semantics. Never `Calendar` for years 0–99 (§13.18). Same rule ids and messages. |
| `vocab.mjs`, `ids.mjs`, `format.mjs`, `evidence-style.mjs`, `viewstate.mjs` | `ScrollsCore/{Vocab(generated),IDs,CanonicalJSON,JSNumber,Mulberry32,Format,EvidenceStyle,ViewState,ReferenceCollation}.swift`, `Resources/vocab.json` | P | Copy and issue templates byte-equal. `EvidenceStyle` is the **only** evidence → style map, read by Metal, Canvas, SVG and the legend. |
| `contracts.mjs` | `ScrollsContracts/**` | R | ≈ 70 Codable types; `Gated<T>` enum; `Canonical{Document,Relationship,Annotation}`; `Issue`; `ScrollsError`. |
| `db/schema.sql`, `seed-vocab`, `migrate` | `ScrollsStore/Resources/{schema.sql,device-profile.sql}`, `Migrations.swift`, `SeedVocab.swift` | P + N | DDL verbatim (sha test). Profile = §3.2. The reference's one-off boot repairs are **not** ported (RF-4 regenerates the snapshots, so they are no-ops; Swift atlases are always built by current rules). |
| `db/open`, `readpool`, `readworker` | `ScrollsStore/{Connection,Statement,Row,SQLValue,ReadConnection,ReadPool,Writer,WriteLease,Pragmas,Probe}.swift` | R | §1.4, §1.5. |
| `db/integrity` | `ScrollsStore/Integrity.swift` | R | `quick_check(100)` at open and a full `quick_check` as a maintenance job. Pack and member sha256; user originals under `Notebook/originals/`. |
| `config.mjs` | `ScrollsStore/AtlasLocation.swift` | R | Container paths, `-atlasRoot`, the iCloud and App Group refusals. |
| `jobs/queue`, `worker`, `job-rows`, `context` | `ScrollsJobs/{JobQueue,JobRows,JobContext,Runs,BoundedChannel,ComputeThrottle}.swift` | R | Same job table semantics and `startRun`/`finishRun`/reuse; adds `after:`. |
| `jobs/tasks/*` (19) | `<Module>/Tasks/<Name>Task.swift`, registered in `ScrollsService/TaskRegistry.swift` | P | Same `JOB_TYPES` codes and priorities, plus the phone types `pack-install`, `generation-build`, `generation-swap`, `journal-replay`, `maintenance`. |
| `store/document-writer`, `bins`, `dup-index` | `ScrollsIngest/Writer/{DocumentWriter,FTSWriter,TextChunker,DateWriter,TagWriter,RelationshipWriter,Bins,DupIndex}.swift` | P + R | Same rows and checks. Ids come from `RowIDAllocator`, text from `ChunkedTextStore.Writer`. Commits every 5,000 documents or 50,000 rows **or 2 s, whichever comes first**. |
| `text/segment`, `langid` + stopwords | `ScrollsIngest/Text/{Segmenter,LangID}.swift` | P | `seg-1`. NSString enclosing sentence ranges plus ।/॥. |
| `ingest/*` | `ScrollsIngest/{Formats,Mapping}/**`, `ImportPipeline.swift` | P | Streams through `FileHandle` in 1 MB reads. Hand-written streaming JSON for > 100 MB files. The Windows-1252 table is ported. |
| `adapters/{demo,cipher/*,stemm/*}`, `api`, `registry` | `ScrollsSources/{SourceAdapter,SourceRegistry,Demo/*,Cipher/*,STEMM/*}.swift` | P + R | Same mapping (CIPHER-MAPPING). Adapters read **pack members** through `PackReader`, not loose folders. Ngram is `ATTACH`ed read-only, in place. |
| `aggregate/*` | `ScrollsQuery/{Match,Slice,Timeline,Stats,Cache,Text}/**` | P (+R cube, cache) | Cube = an mmap'd columnar file in `Caches/` keyed by its inputs. `query.mjs` is split into `{QueryDef,CanonicalRequest,SliceSQL,TrailLanes,ClusterLanes}.swift`. `cache.mjs` becomes an in-memory LRU keyed by `data_version` plus purgeable files; the `tile_cache` table is not used. |
| `text/{variants,translit,names,kwic}` | `ScrollsQuery/Text/*.swift` | P | The name-guard code hash covers these Swift files. |
| `export/{manifest,csv,jsonl}` | `ScrollsQuery/Export/*.swift` | P | `export_text_allowed = 0` respected. `bundle-html` → **later** (ΔS-14). |
| `analysis/*` | `ScrollsAnalysis/**` | P; linalg R | **Exact paths** (§2.4): stats, intervals, bootstrap, gates, compare, composition, multiplicity, collocations, keyness, labels, transitions, convergence, k-means, stability and baseline ρ, as f64 loops in reference order. **Tolerance paths:** `linalg`/`rsvd`/`procrustes` → LAPACK `sgeqrf`/`sorgqr`/`sgesdd`, `cblas_sgemm` and a hand-written CSR × dense kernel; `cooc` → TaskGroup shards with the same `targetId mod 8` layout, processed in memory-budgeted blocks. |
| `analysis/tone.mjs` + `tools/nl-adapter` | `ScrollsNL/**` | R | In-process `NLTagger`/`NLEmbedding`, with the availability gates of §4.10. Labelled "modern reader model (Apple NLEmbedding en rev N)". |
| `lineage/*` | `ScrollsLineage/**` | P (+R reuse index) | The **global reuse index runs on the phone**: per-collection winnowing, then an external merge of sorted fingerprint files (mmap) with peak ≤ 600 MB and output identical to the reference (G2, G3). |
| `provenance/*` | `ScrollsProvenance/**` | P | The append-only triggers do the enforcing. |
| — | `ScrollsStore/Journal/**` (format), `ScrollsService/{UserWrites,JournalReplayer,ViewCutoffResolver}.swift` | N | §6. |
| `http/*`, `routes/*` | `ScrollsService/{AtlasService,LiveAtlas,LiveAtlas+<Area>,MockAtlas,Events}.swift` | R/D | One `LiveAtlas+<Area>.swift` per route file. Validation and gate logic stay as in the reference. |
| `src/ui/timeline/{scale,tiers,folded,model,display,hit,arcs,arc-summary,clusters,deeptime,share-cells,coverage,seams,a11y-table,svg}` + the state half of `viewport` + the `tiles-client` policy | `ScrollsScrollModel/**`, `ScrollsRender/SVGWriter.swift` | P | Pure and Mac-testable; golden-tested (G5). |
| `src/ui/timeline/{paint,input,gestures,playhead,minimap,drawer,snapshot,perf}`, `src/ui/{core,shell,panels,import,tour}` | `ScrollsRender/**`, the `Scrolls/` app folders | R | Metal, UIKit recognisers, SwiftUI. UI copy is ported verbatim and linted. |
| `scripts/{verify,verify-journey,bench,bootstrap-cipher,build-demo}` | `scrolls-cli {verify,api,bench,starter,atlas build}` | R | `check-demo-names.mjs` stays Node (the MusicBrainz tables are Mac-only). |
| `tools/fetch/*` | — | stays Node | Run by him on the Mac (D13). |

### 1.4 SQLite layer (system SQLite3 C API)

- **Connections.**
  - Every connection is opened with `SQLITE_OPEN_NOMUTEX` (THREADSAFE=2 means one thread per connection at a time, which is exactly one connection per actor).
  - Statements are prepared with `sqlite3_prepare_v3(…, SQLITE_PREPARE_PERSISTENT)` into an LRU of 128 per connection.
  - `sqlite3_column_text16` is the UTF-16 fast path. It is already the D4 offset space, so short fields are sliced with no `String` round trip.
- **The statement catalogue (platform graft).**
  - Every SQL text lives in a per-area `enum <Area>SQL: SQLCatalog` file as `static let` entries of type `SQL(id:text:scan:)`. No SQL is written inline.
  - `SQLCatalogTests` runs `EXPLAIN QUERY PLAN` for every entry against the demo atlas and against a 5% Cipher slice. It fails on a full scan of `passage`, `document`, `relationship`, `doc_tag`, `expr_doc`, `occurrence` or `date_assertion` unless the entry is marked `.scanOK(reason:)`.
  - The same test fails any SQL in the engine that names `document_text.original` or `length(original)`, except in `InlineTextStore`. Text goes through `TextStore` only.
- **PRAGMAs.**

  | Connection | Settings |
  |---|---|
  | All | `foreign_keys=ON`, `busy_timeout=5000`, `temp_store=MEMORY` |
  | Writer | `journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-65536`, `mmap_size=0`, `wal_autocheckpoint=1000`. During bulk phases: `PASSIVE` checkpoints after each commit, and a pause while the WAL exceeds 256 MB (ΔS-19). |
  | Readers | `query_only=1`, `cache_size=-32768`, `mmap_size=268435456` (256 MB each: platform and experience; not the engine's 1 GB, because of the VM budget, §3.8) |

- **Snapshots.** A handler that runs several statements (a timeline query plus its lane gates) runs inside one `BEGIN DEFERRED` on its reader, so it sees one WAL snapshot. No transaction is ever held across an `await` on another actor, and none across app suspension.
- **Deadlines and interruption.**
  - `sqlite3_progress_handler` runs every 10,000 VM steps. It checks the request deadline (5 s interactive) and the task's cancellation, and it calls the job's `heartbeat()` (§3.7) so that long statements still report progress.
  - `Connection.interrupt()` (`sqlite3_interrupt`) is the one thread-safe call. `withTaskCancellationHandler` installs it.
- **The probe** (`Store/Probe.swift`, run at first launch, in `-selftest probe`, and on the Mac in tests) checks:
  - `sqlite3_libversion_number() ≥ 3_046_000`;
  - the compile options;
  - a fixed parity string tokenized through a temporary FTS5 table and `fts5vocab`, compared with the generated tokenizer;
  - `rtree_i32` with BCE day numbers, JSON1 and `contentless_delete`.

  Any mismatch refuses the atlas with "This phone's SQLite tokenizes differently from the one Scrolls was built against (details). Nothing was changed." The fallback, a vendored amalgamation, needs his approval (§7.1 R5).

### 1.5 Concurrency (exact signatures in §8.4.4)

| Piece | Behaviour |
|---|---|
| `Writer` actor | The single read-write connection, on its own `DispatchSerialQueue` executor (QoS `.utility`). <br>• `write { }` = one short `BEGIN IMMEDIATE`. <br>• `lease(for:)` gives bulk writers batched transactions, and interactive writes run between batches (they are never parked for 5 s). |
| `ReadPool` (3 `ReadConnection` actors, each on its own `DispatchSerialQueue`) | Reader 0 is **reserved for `.interactive`**. Readers 1–2 are shared, and a `.job` read may hold at most one of them. Interactive reads run at `.userInitiated` (so the scheduler prefers the 2 performance cores); job reads at `.utility`. |
| `JobQueue` actor | At most **one bulk-writing job** and **two read-mostly jobs** at once. <br>• Job priority 1–9 orders the queue. <br>• Swift `TaskPriority` orders CPU: `.userInitiated` for priority ≤ 2, `.utility` for 3–6, `.background` for 7–9. <br>• `after:` dependencies replace serialisation (demo: materialize → cluster → label). <br>• `recoverInterrupted()` at boot turns `running` into `interrupted`, and **resumable** types re-queue from the cursor read back from committed rows (the reference's bootstrap rule). |
| Compute fan-out | `withThrowingTaskGroup` with **work-stealing chunks of ≤ 5 ms**, not equal static shards (2 performance + 4 efficiency cores: static shards finish at the speed of the slowest efficiency core). <br>• Each chunk ends with `try await ctx.checkpoint()`. <br>• Accelerate calls with large operands are never nested inside a TaskGroup (BLAS threads internally). <br>• `ctx.parallelism` follows `DeviceConditionsSource`: 6 / 4 / 1 / 0 for nominal / fair / serious / critical. |
| Backpressure | An adapter parses on a producer task and `send`s `[CanonicalDocument]` batches of 500 into `BoundedChannel(capacity: 4)`, whose `send` suspends while it is full. The writer drains it. `AsyncStream` is never used for data, because it has no backpressure. |
| Cancellation | Task cancellation makes `ctx.checkpoint()` throw; the run becomes `cancelled`, and its rows stay invisible until `gc-runs`. A running statement is stopped by `interrupt()`. **Acknowledged within 500 ms** (tested). |
| Events | `AtlasService.events: AsyncStream<AtlasEvent>` carries `.job`, `.dataChanged(dataVersion)`, `.adapter`, `.bootstrap`, `.generation`, `.journal(seq)` and `.thermal`. Job progress is sent at most 4 times a second; phase changes go out at once. The app's `@MainActor @Observable JobsModel` consumes them. |

### 1.6 The in-process API

- **`protocol AtlasService: Sendable`** has one async method per contract fixture (65 fixtures; `GET /api/events` becomes the `events` stream). The full list is in §8.4.6. The implementations are `LiveAtlas`, a `final class` with immutable stored properties whose every method is `@concurrent`, and `MockAtlas`, which decodes the 65 fixtures (UI agents build against it from day 1).
- **Phone-only operations** are not part of contract 1.3.0. They live on a second protocol, **`AtlasPlatform`**: packs, the inbox, generations, storage, the probe, self-tests and diagnostics. They are additive, and they are versioned `P1`.
- **Shapes.**
  - Swift properties are camelCase. One shared `ScrollsJSON.encoder`/`decoder` converts to snake_case, with explicit `CodingKeys` for the few keys the conversion would mangle.
  - **The round-trip test (C0):** for each of the 65 fixtures, the canonical JSON of the decoded-then-encoded value equals the fixture's canonical JSON. A field missing from a Swift struct therefore fails a test instead of disappearing.
- **`Gated<T>`** is `enum { case value(T); case gated(Gate) }`.
  - Its custom Codable writes `value: null` exactly as the contract does.
  - **No numeric accessor exists**, so SPEC rule 7 is a type.
  - The struct with an optional value that platform proposed was rejected.
- **`Provenance`** (`data_version`, `run_ids`, tokenizer, segmenter, `synthetic`, collections, licences) is a **required** stored property of every data response.
- **User writes** go through `UserWrites.perform(_ op: JournalOp, …)` (§6.2), which appends to the journal before the transaction.

### 1.7 Unicode, ICU and number parity (rules that follow from §0.2)

| Concern | Rule | Test |
|---|---|---|
| Token classes | `TokenClassTable.swift`: a two-stage table (≈ 30 KB) generated by `Golden/gen-core.mjs` from Node's regex classes, frozen with `u61m-1`. | Over all scalars, the table = Node (G1). A drift report against the runtime's `Unicode.Scalar.Properties` is printed, never auto-applied. |
| Fold | NFC → lowercase → Indic digit folds → strip ZWJ/ZWNJ/SHY. The ASCII fast path covers ASCII. Otherwise `(s as NSString).precomposedStringWithCanonicalMapping` and then `NSString.lowercased`, memoised per distinct form by `TokenInterner`. | G1 covers all 2,572 changing code points plus Greek sigma contexts. `LintTests` fails the build on `.lowercased()` applied to a Swift `String` anywhere in `ScrollsKit/Sources`. |
| Sentences | `NSString.enumerateSubstrings(in:options: [.bySentences, .substringNotRequired])` with **enclosing** ranges and locale `en`, then the ।/॥ pass. | G1 sentence goldens on 30 + 10 + 10 books. The device probe hashes the boundaries of 3 bundled books against the Mac hash, because iOS's ICU must agree too. |
| Canonical JSON | `CanonicalJSON` sorts keys and renders numbers with `JSNumber.format(Double)` (ECMA-262 Number::toString from Swift's shortest round-trip digits). It feeds `params_hash`, `state_hash` and `input_fingerprint`. | Golden: 20,000 doubles plus the edge cases (−0, 1e21, 5e-7, 2⁵³ + 2). |
| `localeCompare(…,'en')` sorts | `ReferenceCollation.compare(a,b)` = `a.compare(b, locale: Locale(identifier: "en"))`. | G3 sort-order goldens over every lane label, title and shelf. A mismatch opens DV-4, and the fallback is an explicit collation table exported from Node. |
| `toLocaleString('en-US')` | `Format.int` groups with "," using en_US_POSIX digits. | Vocab copy goldens, byte-equal. |
| Seeds | `Mulberry32` uses wrapping `UInt32` arithmetic (`&*` for `Math.imul`), bit-exact. Box–Muller over Darwin libm may differ in the last ulp. | Stream goldens exact; Gaussian draws within tolerance (DV-5). |

### 1.8 What stays identical, and what changes

| Identical (tested byte- or value-equal) | Changes on the phone (same meaning) |
|---|---|
| The DDL and every CHECK and trigger; gated values stay NULL | Transport (ΔS-1); concurrency substrate (ΔS-2) |
| Tokenizer `u61m-1`, the fold, the FTS tokenizer string, offsets in UTF-16 | Text in chunks; `document_text.original = ''` in the device profile (ΔS-4) |
| Segmenter `seg-1`, langid, the date grammar, bins, fit-or-wash, the conservation law | Row-id allocation by source slot (§3.3) |
| Vocab, copy, the view-state grammar, the evidence style | Analysis jobs `writes: false` with a guarded commit |
| Every algorithm, constant, gate, seed and threshold of SPEC §4 | Linear algebra on Accelerate (tolerance paths only) |
| Contract 1.3.0 shapes, gate objects, provenance blocks | Adapters read packs (ΔS-5, ΔS-6); generations and the journal (§3.5, §6) |
| The demo world (`data/demo/*.jsonl` copied; the generator stays Node) | Compact create revisions (expanded on read) |

---

## 2. Differential testing against the Node reference

### 2.1 Reference stewardship (package R, before and during the port)

- **The freeze.**
  - After RF-1…RF-4 land, the reference is tagged `ref-freeze-1` and **frozen**.
  - `server/`, `src/`, `tests/`, `scripts/` and `data/` change only through the **finding protocol**: a differential diff is a finding against one side.
  - If Swift is wrong, the Swift owner fixes it. If the reference is wrong, package R:
    1. fixes it in the reference;
    2. re-runs `npm test` (with the DYLD workaround);
    3. tags `ref-freeze-<n+1>`;
    4. records the fix in `Native/Docs/REFERENCE-CHANGES.md` (finding, files, test).

    N0 then regenerates the affected golden families in one commit (below).
  - **A golden is never edited by hand.**
- **RF changes before the first golden freeze** (owner R; a finding becomes an RF only when it would otherwise be frozen into Swift):

  | RF | Change | Why now |
  |---|---|---|
  | RF-1 | **English denominators stop counting 'und' passages of es/fr books** (HANDOFF's open high-severity finding: Cipher *machine* 1875–1899 lists 148 documents, 76 of them es/fr books). 'und' rows are gated by the document's text language in the slice cube, the SQL slice and Compare at once. `CUBE_VERSION` is bumped, and the invariant tests get new oracles. | Bug-compatible goldens would freeze a wrong denominator into the phone. |
  | RF-2 | **As-saved views apply the cutoffs and pinned runs to the inspector's counts and to Compare too** (HANDOFF: "the inspector's counts and Compare still read current data"). | D17 is the rule that a shared link must never change under its reader. |
  | RF-3 | The verify journey (`scripts/verify-journey.mjs`) gains the requests the phone journey needs: import, track, tiles at L0–L5, a passage sample, Compare, save, as-saved reopen, and as-saved Compare (RF-2). It also records every request and response as JSONL. | G7 replays them. |
  | RF-4 | **Fresh snapshots `m1r` and `m5r`** are built from `ref-freeze-1` by a full reference bootstrap: the demo, full Cipher (A, A2, B), the four STEMM loads, and the M5-gate runs (the English pooled space and era slices, the drift pair, clustering of *bank*, *zero*, *virus*, *gene* and the demo). `originals/` are stored **inside** each snapshot directory, not symlinked into a scratchpad. | The current snapshots predate the fix pass, carry duplicate demo relationship groups, pre-fix double-BOM offsets and ItwoFS coincidence links, and point at scratch files. On fresh snapshots the boot repairs are no-ops. |

- **What Swift does not port:** the reference's one-off boot repairs: the 1.1.0 hypothesis-group re-target, switching off the `-er/-ers` variants, the translation-flag repair for loaded databases, and the forced recounts after a guard change. Swift atlases are always built by the current rules. The rules themselves are ported where they apply at load time (for example `W_TRANSLATION_CREDITED`).
- **Golden regeneration is serialised.** Only N0 (or the integrator at a milestone) runs `Tools/check.sh golden`.
  - It writes `~/Developer/scrolls-golden/<refcommit>/` and the committed subset, and records `{reference_commit, ref_tag, node, icu, unicode, generator_sha256, families:{name:{cases,sha256}}}` in `MANIFEST.json`.
  - It writes `Native/Reports/golden-diff-<old>-<new>.json`, listing which families changed and how many cases.
- **The mid-round rebase protocol.**
  - When a new `ref-freeze-n` lands while packages hold goldens from an older tag, N0 posts the diff report in `Native/Docs/status/N0.md`.
  - Each package rebases at its next checkpoint: it pulls the new committed subset, re-runs its own families, and records "rebased to ref-freeze-n" in its status file.
  - A package whose families did not change rebases with nothing to fix.
  - **No package may declare a milestone done on goldens older than the milestone's tag.**

### 2.2 The golden tiers

| Tier | What | Generated by (`Native/Golden/`, Node, read-only imports of the reference) | Inputs | Compared |
|---|---|---|---|---|
| **C0 contracts** | 65 fixtures | copied from `tests/contract/` | — | decode → encode → canonical JSON **byte-equal** |
| **G1 pure** | dates, tokenizer, fold, sentences, langid, ids/canonical JSON/`JSNumber`, `mulberry32`, `fnv1a32`, viewstate, evidence style, vocab templates, format, stats primitives (Garwood, Wilson, G², BH-FDR, logDice, Gries DP), variants, translit `romanKey` + `transliterationCandidates`, name guard, minhash signatures, winnow fingerprints | `gen-core.mjs` (N0), `gen-pipeline.mjs` text part (N1), `gen-read.mjs` text part (N3), `gen-lineage.mjs` (N5) | • 5,000 raw date strings (every distinct year value in Cipher, Wikisource, culture-works, OpenAlex and Wiktionary; the §5.3 examples; 2,000 fuzz strings); <br>• day math every 97th day of [−10000, 3000]; <br>• the code-point table; 5,000 passages sampled by language (redacted per §2.6); Greek, emoji and ZWJ edge strings; <br>• segments of 30 Cipher books, 10 paged Wikisource books, 10 STEMM books and every demo document; <br>• 2,000 langid passages; 500 viewstates; every vocab template; <br>• 500 expressions × languages for variants; 2,000 words for translit; 2,000 name-guard contexts | **exact** |
| **G2 pipeline** | Ingest and adapters into an empty database, then a **LogicalDump** (§2.3) | `gen-pipeline.mjs` (N1), `gen-sources.mjs` + `slices.mjs` (N2) | `tests/fixtures/ingest/*`, `tests/fixtures/mini`, the demo, and **Cipher and STEMM slices** written in the original formats: <br>• 25 Gutenberg books (6 with `***START OF`, 3 SMALL PRINT, #1661 with its 3 QIDs, the 2 double-BOM books, #135 and #19942); <br>• 20 hi + 20 gu Wikisource books; <br>• 2,000 culture-works rows covering every relation code; 5,000 music relations; 500 roots families including the multi-parent classes; <br>• 500 OpenAlex works with their in-sample citations, including date-conflict pairs; 50 gutenberg-stemm books, including translated ones; 300 Wiktionary entries | **exact** per table, ids mapped to natural keys |
| **G3 read path** | Contract responses | `gen-read.mjs` (N3) and `gen-analysis.mjs` Compare part (N4): they start the reference server on a `cp -c` clone and replay `requests/**.json` over HTTP | ≈ 400 requests on clones of **m1r** (the demo) and **m5r**: <br>• search for 40 queries (*virus, zero, gene, bank, hacker*, phrases, शून्य, શૂન્ય, ◉, "shunya", empty results); <br>• timeline query and tiles at L0–L5 for 12 expressions × facets (domain, language, community, trail, cluster); <br>• marks, arcs (the C4 summaries of *gene*), shelves, bin pages, passages, documents, KWIC, facets, corpora; <br>• Compare for 40 slice pairs (every gate code); <br>• views as saved, including as-saved Compare | Swift runs the same requests **in process on its own clone of the same snapshot** through `InlineTextStore`, after materialising with its own engine. Exact for counts, states, ids, labels, copy and sort orders; §2.4 tolerance for floats. |
| **G4 analysis** | Runs with randomness or float32 linear algebra | `gen-analysis.mjs` (N4), `gen-lineage.mjs` reuse part (N5) | On an m5r clone: <br>• vectors (the English pooled space and both era slices); <br>• clustering of *bank, zero, virus, gene* and the demo, plus the **reference's occurrence vectors exported** for the exact k-means check; <br>• drift (the M5-gate pair); collocations for 20 slices; convergence (demo); <br>• the constellation for 5 queries; tone (English, when the Mac has the model); <br>• the global reuse index sets | §2.4 |
| **G5 display list** | `ScrollsScrollModel` vs `src/ui/timeline/{model,display,scale,tiers,folded,arcs,arc-summary,hit,a11y-table}` | `gen-display.mjs` (N7): Node, no DOM | Tile and arc payloads from G3 at 3 widths (430, 932, 1440 pt) × 6 tiers × **a vantage sweep**: none, plus 12 days across the extent, each in strict and context mode, with Reduce Motion on and off | `DisplayList.visible(at:mode:)` (§4.23) = Node `buildDisplay(…, {vantage})`. Primitive ids, kinds, states, flags, ghost marks and label strings **exact**; geometry ±0.01 pt; hit-grid query results for 200 probe points per case exact |
| **G6 device = Mac** | The same Swift engine on the phone and in the CLI | — (Swift only; `Tools/atlas.sh fingerprint`) | The starter; then the generation the phone built from its own journal; then the CLI's replay of the **same** journal | Per-table LogicalDump sha256 equal for all evidence and user tables. Analysis tables within §2.4. The Diagnostics screen shows PASS/FAIL against the CLI's fingerprint. |
| **G7 API journey** | The reference journey (RF-3), writes included: import, track, annotate, review, save, restart, reopen, as-saved | `gen-journey.mjs` (N6) | Two `cp -c` clones each of **m1r and m5r**. On the Swift side, `scrolls-cli convert-reference` turns a clone into a device-profile atlas (chunked text, compact revisions), which also proves the conversion lossless. Then `scrolls-cli api --atlas … < requests.jsonl` | Normalised by natural keys, timestamps and `data_version`; every response also passes Node's `contracts.check` (`validate-contracts.mjs`) |
| **G8 render parity** | Metal vs `DisplayListCanvas` on the same display list | — (Swift; `ScrollsRenderTests`, macOS offscreen, `TOOLCHAINS=metal` as in LabKit) | Demo and Cipher viewports at 6 tiers × 3 vantages × {strict, context} × {default, Increase Contrast} | ≤ 1% of pixels differ by more than 8/255 in any channel, outside text anti-aliasing masks. Hatch phase and dash phase are checked by probes. |

### 2.3 The LogicalDump (one spec, two dumpers)

`ScrollsStore/Resources/dump-spec.json` (N0) lists, for every table:
- its **natural key** and its id columns, each mapped to a natural key;
- its masked columns (timestamps, `job_id`, `heartbeat_at`, the `meta` keys that legitimately differ);
- its float and JSON rules;
- its virtual columns.

`Native/Golden/dump.mjs` (Node, `node:sqlite`) and `ScrollsStore/LogicalDump.swift` both read this one file.

```json
{ "document": { "key": ["collection.slug","ext_id"], "ids": {"id":"self","collection_id":"collection","import_batch_id":"import_batch","dup_of":"document"},
                "mask": ["created_at"], "json": ["original_meta_json"] },
  "passage":  { "key": ["document","field","ord"], "ids": {"id":"self","document_id":"document"} },
  "document_text": { "key": ["document"], "virtual": {"original": "TextStore.fullText → sha256"} },
  "relationship_revision": { "key": ["relationship","rev"], "virtual": {"after_json": "Revisions.expanded"} },
  "relationship": { "key": ["rel_type","src","dst","source_dataset","method"], "ids": {"run_id":"analysis_run"}, "mask": ["created_at"] },
  "import_batch": { "key": ["collection.slug","file_sha256","adapter_id","ord"], "mask": ["created_at","committed_at","job_id"] },
  "passage_fts":  { "virtual": {"rows": "rowid → passage key; fts5vocab instance (term, doc key, offset) → sha256"} },
  "text_chunk":   { "skip": "device profile; covered by document_text.original" } }
```

- **Row format.** Rows are JSONL sorted by natural key. Floats are written with `JSNumber` to 12 significant digits, JSON columns are canonicalised, timestamps become `"<ts>"` and text bodies become their sha256.
- **FTS** is compared through `fts5vocab` instance rows (term, document key, offset). That also re-proves "FTS token i = JS token i".
- **Device and reference dumps are equal.** `TextStore` sits behind the virtual `original` column and the revision expander behind `after_json`. So a device-profile atlas (chunked text, compact revisions) and a reference database give **the same dump**, which proves chunking and compaction lossless.

### 2.4 Comparison rules

| Quantity | Rule |
|---|---|
| Counts, ids (as natural keys), bin states, tiers and bin indices, gate codes, evidence status, labels and copy, sort orders, offsets, token counts, conservation sums | **exact** |
| **Exact float paths:** rates, Garwood and Wilson CIs, G², q-values, logDice, collocation PPMI, JSD, Gries DP, bootstrap CIs (resample indices from the bit-exact `mulberry32`), **k-means assignments, stability and labels on the reference's exported vectors**, transitions and convergence on the same inputs | f64 scalar loops in the **reference's summation order**. Interleaving independent accumulators (for example all k centroid dot products in one pass) is allowed; reassociating within one sum is forbidden; no BLAS. Values `abs(Δ) ≤ 1e-9 · max(1,abs(x))`; assignments and labels **exact**. |
| float32 paths (PPMI matrix values, cosines, occurrence vectors) | `abs(Δ) ≤ 1e-5 · max(1,abs(x))` |
| rSVD spaces | **Subspace check:** cosines of the principal angles between the top-64 left singular subspaces ≥ 0.999. Per word, top-25 neighbour Jaccard ≥ 0.9 for 2,000 words with f ≥ 100. |
| End-to-end clustering on Swift-built spaces | k equal; adjusted Rand index ≥ 0.98; per window, shares within 0.01 and CI bounds within 0.02; machine labels equal for clusters with stability ≥ 0.5 |
| Drift (b), (c) | value within 0.01; null percentile within ±1.0; gate and verdict **exact** |
| Gaussian draws (DV-5) | within 1e-12 relative |
| Constellation layout | node and edge sets exact; positions within 2% of the layout extent after Procrustes alignment (≤ 1e-6 when the inputs are identical) |
| Display-list geometry | ±0.01 pt; ids and kinds exact |
| G6 analysis tables between phone and Mac | the same rules as the rSVD and clustering rows; evidence tables exact |

### 2.5 The divergence register

`Native/ScrollsKit/Tests/DifferentialTests/Golden/DIVERGENCES.json` lists every accepted difference: `{id, area, description, rule, owner, status: open|resolved, evidence}`. **Exact modules must have zero `open` entries at a milestone gate.** It is seeded with:

| DV | Divergence | Status / rule |
|---|---|---|
| DV-1 | Swift `String.lowercased()` breaks Final_Sigma | resolved: the NSString fold plus lint |
| DV-2 | Unicode version drift between Node and iOS | resolved: the generated class table; drift is reported |
| DV-3 | `Intl.Segmenter` vs Apple sentence breaks | resolved on the Mac (562,089/562,089); the device probe re-checks it at M0 |
| DV-4 | `localeCompare('en')` vs Foundation | measured at M1 over all labels; fallback: an exported collation table |
| DV-5 | libm last-ulp differences (Box–Muller, `log`, `exp`) | tolerance 1e-12 |
| DV-6 | BLAS reassociation on spaces | the subspace rule (§2.4) |
| DV-7 | The phone builds the display list once without a vantage and gates with a uniform. Its `simplified` budget is therefore counted over **ungated** primitives (the reference counts after `gate()`). | accepted, and conservative: the phone may simplify where the web would not, never the reverse. G5 compares visible sets only where neither side simplified. |
| DV-8 | Scheduling: analysis jobs are `writes: false` | no output change (tested) |
| DV-9 | `code_hash` values differ between Swift and Node | the reuse and recount semantics are identical |
| DV-10 | `meta.icu_version` and run version strings | masked in dumps (ΔS-7) |
| DV-11 | Chunked text storage | LogicalDump virtual column equal |
| DV-12 | Compact create revisions | expanded form equal |

### 2.6 Licensed text never enters git or the test bundle

- **Redaction at generation.** Generators read `collection.export_text_allowed`. Any text from a collection with `export_text_allowed = 0` (the OpenAlex abstracts and `stemm-gutenberg-restricted`) is written into a fixture as `{"$redacted":"<sha256 of UTF-8>","len":<utf16 length>}`. The Swift comparator hashes its own output for those cases. `Golden/lib/redact.mjs` (N0) does this, and no generator may write text without it.
- **What may be committed.** Only redacted fixtures, under `Native/ScrollsKit/Tests/DifferentialTests/Golden/` (≤ 30 MB in total). Unredacted families (needed only for G3/G4 runs on the Mac) stay in `~/Developer/scrolls-golden/<ref>/private/`, outside git and outside iCloud. The tests that need them skip with a message when they are absent.
- **`FixtureLicenceTests`** scans every committed fixture. It fails on any string ≥ 40 characters whose sha256 matches a passage of a restricted collection; the hash list of restricted passages lives in the private folder.
- **No lyrics exist anywhere**, by SPEC rule 1. Public-domain Gutenberg text and CC BY-SA Wikisource text may appear in fixtures, with their attribution recorded in `MANIFEST.json`.

### 2.7 Gates: `check.sh`, `device-check.sh`, and when the phone is not there

`Tools/check.sh <stage>` runs in the caller's mirror (`SCROLLS_BUILD_DIR`). It prints a PASS/FAIL table and writes `Native/Reports/check-<stage>-<timestamp>.json`. Exit codes: 0 pass · 1 fail · 3 pending device. Each stage's body is in `Tools/check.d/<stage>.sh`, owned by the package that owns the code it checks.

| Stage | Contents | Owner |
|---|---|---|
| `quick [--wp Nx]` | mirror → `swift build --target <the WP's targets>` → that WP's unit tests + G1 + C0 + `LintTests` + `SQLCatalogTests` | N0 |
| `golden` | regenerate goldens (serialised; N0 or the integrator only) → `quick` | N0 |
| `slice` | G2 on the Cipher and STEMM slices (Node build vs Swift build) | N2 |
| `read` | G3 on `cp -c` clones of m1r/m5r (`scrolls-cli diff-read`) | N3 |
| `analysis` | G3 Compare, G4 | N4 |
| `lineage` | G1/G2/G3/G4 lineage families | N5 |
| `journey` | G7 on m1r and m5r | N6 |
| `display` | G5, G8 | N7 |
| `app` | `xcodegen` → simulator build → `ScrollsAppTests` + `ScrollsUITests` (first minute, gestures, accessibility audit, state restoration) on the "Scrolls 15 Pro Max" simulator | N8 |
| `full` | all of the above, plus G6 against the last device fingerprint, plus `scrolls-cli bench` (timings never fail the gate) | integrator |
| `device <suite>` | delegates to `device-check.sh` | integrator |

**`Tools/device-check.sh`** (N0) automates the device rows:
1. **Availability.** It runs `xcrun devicectl list devices --json-output`. It requires his iPhone to be connected, paired, unlocked and in Developer Mode, with DDI services available.
   - If it is not, the script appends `{suite, wp, requested_at, reason}` to `Native/Reports/device-queue.json`, prints `PENDING_DEVICE`, and exits 3.
   - **A pending row is never recorded as PASS.** No agent waits for the phone.
2. **Install and run.** `install [--fresh]`, then launch with `-selftest <suite> -atlasRoot selftest[-fresh] -perf` (`devicectl device process launch`). It waits for `Documents/selftest/<run>/result.json` and copies it back (`devicectl device copy from --domain-type appDataContainer --domain-identifier com.utkarsh.scrolls`).
3. **Report.** It prints the same table, plus the signpost timings, peak `phys_footprint` and the thermal log.

The suites are `probe`, `first-minute`, `journey`, `perf`, `packs`, `generation`, `background` and `full`.

**Proxies.** Every acceptance row in §5 and §8 declares one:
- **`sim`**: functional behaviour, layout, accessibility audit;
- **`mac`**: algorithms, parity, CPU-time scaling;
- **`device`**: timings, thermal, memory, background, transfer, 120 Hz.

Only `device` rows need Utkarsh. The integrator batches the device queue into one session per milestone, when he is present with the phone unlocked and on its cable. Device rows are recorded in `Native/Docs/DEVICE-RUNS.md`.

---
## 3. On-device data

### 3.1 Storage budget (from the measured snapshot to the device)

| Item | Reference (m5-stemm) | On the phone | How |
|---|---|---|---|
| `document_text` | 917 MB | **≈ 390 MB** | passage-aligned chunks, target 32,768 UTF-16 units, LZFSE over UTF-8 (2.35× measured at 32 KB). Chunks under 2 KB are stored raw. |
| `relationship_revision` | 242 MB | **≈ 35 MB** | compact create revisions (§3.2): **the rows and ids are kept** |
| `original_meta_json` | 278 MB | **278 MB** | kept verbatim (N-05). Hot-key slimming is later (§7.3). |
| everything else (FTS, passage, relationship, doc_tag, date_assertion + `date_rtree`, label_tri, …) | ≈ 2,117 MB | ≈ 2,117 MB | unchanged. No §3 object is dropped (`date_rtree` and `passage_time` stay; dropping them is a later SPEC amendment, §7.3) |
| **Atlas database** | 3,554 MB | **≈ 2.82 GB** | |
| STEMM source pack | (1.0 GB loose files on the Mac) | 236 MB | the originals of STEMM documents (`pack:` paths). Deleting it is allowed; the consequence is shown (§4.16). |
| Ngram baseline | 174 MB | 173 MB | `ngram-eng-1.sqlite`, attached read-only in place |
| Cipher packs | — | 0 (in the app bundle) | 192 MB in the container only for `SCROLLS_BUNDLE_PACKS=0` development installs |
| Derived (`Atlas/derived/`) | `derived/` on the Mac | ≈ 0.45 GB | English pooled space 37,022 × 256 × 4 B = 38 MB; 2 era slices ≈ 76 MB; fr/es/hi/gu spaces ≈ 60 MB; reuse index ≈ 200 MB; dup indexes ≈ 60 MB |
| Caches (`Library/Caches/Scrolls`, purgeable) | `cache/` 1.4 GB | ≤ 0.8 GB, capped | slice cubes (≈ 15–40 MB per corpus); token streams (u32, the reference layout; English ≈ 380 MB, built on demand); tile and memo files; thumbnails |
| **Durable total** | | **≈ 3.7 GB** | **target ≤ 4.0 GB; hard ceiling 5.0 GB including caches**. Above the ceiling, derived jobs refuse and the Storage page opens. |
| During a generation swap | | + ≈ 2.9 GB, transient | the free-space guard (§3.5) |

His 15 Pro Max has ≥ 256 GB, so space is not the limit; time, heat and transfer are.

### 3.2 The device profile (`ScrollsStore/Resources/device-profile.sql`, `meta.profile = 'device-1'`)

It runs after `schema.sql`. It **only creates**: no §3 table is altered and no §3 object is dropped.

```sql
-- text in chunks (DP-1). document_text keeps every column; original = '' for chunked documents;
-- original_sha256 stays the sha256 of the whole UTF-8 original (the D18 anchor key).
CREATE TABLE text_storage (
  document_id INTEGER PRIMARY KEY REFERENCES document_text(document_id),
  layout TEXT NOT NULL CHECK (layout IN ('chunked-1')),
  utf16_len INTEGER NOT NULL, utf8_len INTEGER NOT NULL, chunk_count INTEGER NOT NULL
) STRICT;
CREATE TABLE text_chunk (
  document_id INTEGER NOT NULL REFERENCES document_text(document_id),
  ord INTEGER NOT NULL,
  start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,        -- UTF-16 units of the decoded original; every chunk end is a passage end
  codec TEXT NOT NULL CHECK (codec IN ('lzfse-utf8','utf8')),
  z BLOB NOT NULL,
  PRIMARY KEY (document_id, ord), CHECK (start_off < end_off)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER text_chunk_no_update BEFORE UPDATE ON text_chunk
BEGIN SELECT RAISE(ABORT, 'text chunks are immutable'); END;

-- per-source id counters (DP-2, §3.3)
CREATE TABLE id_counter (tbl TEXT NOT NULL, slot INTEGER NOT NULL, next INTEGER NOT NULL,
  PRIMARY KEY (tbl, slot)) STRICT, WITHOUT ROWID;

-- installed source packs (DP-3)
CREATE TABLE pack_install (
  pack_sha256 TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, slot INTEGER NOT NULL,
  member_count INTEGER NOT NULL, journal_seq INTEGER, installed_at TEXT NOT NULL) STRICT;

-- the journal ops applied to this generation, and the largest log-table id each one created (DP-4, §6)
CREATE TABLE journal_applied (
  seq INTEGER PRIMARY KEY, op TEXT NOT NULL, applied_at TEXT NOT NULL,
  max_ids_json TEXT NOT NULL CHECK (json_valid(max_ids_json))   -- {"import_batch":12,"relationship_revision":593101,"annotation_revision":88}
) STRICT;
CREATE TRIGGER journal_applied_no_update BEFORE UPDATE ON journal_applied
BEGIN SELECT RAISE(ABORT, 'journal_applied is append-only'); END;
CREATE TRIGGER journal_applied_no_delete BEFORE DELETE ON journal_applied
BEGIN SELECT RAISE(ABORT, 'journal_applied is append-only'); END;

-- portable cutoffs of each saved view (DP-5, §6.4); saved_view itself is untouched
CREATE TABLE saved_view_portable (
  view_id INTEGER PRIMARY KEY REFERENCES saved_view(id),
  portable_json TEXT NOT NULL CHECK (json_valid(portable_json)), created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER svp_no_update BEFORE UPDATE ON saved_view_portable
BEGIN SELECT RAISE(ABORT, 'saved views are immutable'); END;
CREATE TRIGGER svp_no_delete BEFORE DELETE ON saved_view_portable
BEGIN SELECT RAISE(ABORT, 'saved views are immutable'); END;
```

- **New `meta` keys** (keys are data, not DDL): `profile`, `generation` (uuid), `generation_built_on` (`device`|`mac`), `engine_version`, `engine_code_hash`, `starter_sha256`, `journal_applied_seq`, `base_max_ids` (JSON).
- **Compact create revisions (DP-6, engine §3.2).** For relationships with `origin IN ('source_dataset','algorithm')`, the `rev = 1, action = 'create'` row is written with `after_json = '{"$row":1}'`.
  - The row, its id and its `at` are kept, so `relationship_rev_cutoff` and the as-saved `EXISTS` filter work unchanged.
  - The evidence fields are immutable by trigger, so the creation state is recoverable: it is the relationship row with `review_status = 'unreviewed'` and the `before_json` of the first `regroup` revision when one exists.
  - `Provenance/Revisions.swift` expands the marker on every read. LogicalDump compares the expanded form, so G2 proves the compaction lossless.
  - Human relationships keep their full revisions.
- **Rejected slimming (do not implement):**
  - pointer-only `original_meta_json` (experience Δ2, platform Δ2 at threshold 0): it breaks C3 Compare and the share cells;
  - synthesised rev-1 revisions (experience Δ3): they break D17 as-saved arcs and lineage;
  - dropping ingestion `date_assertion` rows (platform Δ3): SPEC §5.3 names them;
  - dropping OpenAlex keyword tags (platform Δ7): the document card returns them.

### 3.3 Row ids: source slots, the local range, commit order

`ScrollsStore/RowIDPolicy.swift` (N0) classifies **every** table of `schema.sql` and the profile. `RowIDPolicyTests` parses `sqlite_master` and fails on any table that is not classified.

| Class | Tables (complete list in the file) | Ids |
|---|---|---|
| **entity** | collection, document, passage (and its FTS rowid), date_assertion (and its R-tree id), document_field, document_alias, doc_tag, relationship, relationship_evidence, hypothesis_group, annotation, expression, expression_variant, occurrence, etymon, sense_cluster, time_window, vector_space, space_alignment, cluster_transition, drift_result, saved_view, import_issue, collocation | rows written by a **source load** take `slot × 100,000,000 + n`; every other writer takes the **local range**, `1,500,000,000 + n`, in commit order |
| **log** | import_batch, analysis_run, relationship_revision, annotation_revision, job, job_event, compare_log, journal_applied | `max + 1` at insert: id order = commit order. The as-saved cutoffs and "a newer run exists" rely on this. |
| **keyed** | tables keyed by another row's id or a natural key (`doc_minhash`, `doc_bin`, `doc_tokens`, `expr_doc`, `text_storage`, `text_chunk`, `meta`, …) | none of their own |
| **cache** | `tile_cache`, `query_def`, `layout_cache` | not used, or rebuilt |

| Slot | Source | Loaded by |
|---|---|---|
| 0 | base: seeded vocab, corpora, the demo world | the bundled starter |
| 1 | `cipher-meta`: works, themes, roots, siblings | phase A |
| 2 | `cipher-relations`: relation endpoints and documented music relations | phase A2 |
| 3 | `cipher-text`: 691 Gutenberg + 825 Wikisource books | phase B |
| 4 | `stemm-gutenberg` (+ `-restricted`) | STEMM load |
| 5 | `stemm-openalex` | STEMM load |
| 6 | `stemm-wiktionary` (claims) | STEMM load |
| 7–14 | future packs. A corrected source arrives as a new pack in a new slot, and the old rows are soft-deleted through the normal writer, never rewritten in place. | — |

- **Every id is < 2³¹** (asserted at allocation). The cube's `Int32` doc-id columns and the winnow `u32` record packing stay valid.
- **Why slots.** Entity ids depend only on (engine build, pack). A rebuild, a generation built on the Mac, or a different order of loads all give the same passage, document and relationship ids. So the ids inside saved view states (`s=e12`, `sel=…`) keep resolving.
- **Rows whose ids are not reproducible** (occurrences and clusters made by on-demand runs) are resolved through portable keys when they appear in a saved view (§6.4).

### 3.4 The text store

```swift
public protocol TextStore: Sendable {
  func utf16(_ doc: DocumentID, _ range: Range<Int32>, on c: Connection) throws -> [UInt16]   // the D4 offset space
  func slice(_ doc: DocumentID, _ range: Range<Int32>, on c: Connection) throws -> String
  func fullText(_ doc: DocumentID, on c: Connection) throws -> String                        // reader, export, anchors
  func verify(_ doc: DocumentID, on c: Connection) throws -> Bool                            // sha256(UTF-8) == original_sha256
}
public struct InlineTextStore: TextStore { public init() }   // reference databases (G3, G7 inputs, the CLI on snapshots)
public struct ChunkedTextStore: TextStore {                    // device profile
  public init(cacheBytesPerConnection: Int = 8 << 20)          // decoded-chunk LRU per reader
  public struct Writer { public mutating func append(document: DocumentID, original: String,
                                                     passageEnds: [Int32], on c: Connection) throws -> TextStorageRow }
}
```

- **Chunk boundaries.** A chunk closes at the first passage end at or after 16,384 units and never exceeds 65,536 units. A single passage longer than that is its own chunk. No passage spans two chunks, and no boundary falls inside a surrogate pair.
- **Reading cost.** A passage costs one chunk decode (46–50 µs measured), plus a walk of ≤ 64k units. Counting a word decodes only the chunks of its candidate passages.

### 3.5 Source packs and atlas generations

**The source pack** (`.scrollspack`, UTType `com.utkarsh.scrolls.pack`, format `SPK1`, ≈ 300 lines in `ScrollsStore/Pack/`):
- **Layout.** The magic `SCROLLSPACK\u{1}`, then a canonical-JSON manifest, a member index, and each member's bytes in **1 MiB LZFSE frames** with a frame table. `PackReader.bytes(member:range:)` decodes only the covering frames.
- **The manifest:** `{pack_id, name, version, slot, adapter_ids, created_by: "scrolls-cli <engine version> <git sha>", reference_commit, licences, attribution, caveats, members: [{path, size, sha256}], counts}`. Each member's sha256 is the sha256 of the file on the Mac, so `import_once` and provenance behave as in the reference.
- **Originals.** A document loaded from a pack records `original_file.rel_path = 'pack:<name>@<sha8>/<member>'`.
- **Integrity.** The whole file's sha256 is checked by streaming (CryptoKit) at install. A member's sha256 is checked the first time an adapter reads it in full.

| Pack | Members | Size (measured LZFSE) | Where it lives |
|---|---|---|---|
| `demo` | `data/demo/*.jsonl`, `tour.json` | < 1 MB | engine resource (the CLI's starter build and the self-test rebuild) |
| `cipher-meta` | `culture-works.tsv`, `culture-themes.tsv`, `roots.tsv`, `hinges.tsv` (when read by the reference), `relations_{mb,wiki,itwofs,songs}.json`, `gutenberg.json`, the `pg_catalog.csv` rows used, `tags/*.jsonl` | ≈ 29 MB | app bundle |
| `cipher-text` | `texts/gutenberg/*.txt` (691), `wikisource-{hi,gu}.jsonl` | ≈ 163 MB | app bundle (left out when `SCROLLS_BUNDLE_PACKS=0`, then pushed once) |
| `stemm` | `gutenberg-stemm/`, `openalex/`, `wiktionary-coinage/`, each with its `FORMAT.md` and `MANIFEST.json` | ≈ 236 MB | pushed from the Mac into `Documents/Import/` |
| Ngram baseline | `ngram-eng-1.sqlite`, shipped as a plain file with its sha256 in the stemm manifest | 173 MB | pushed; attached read-only |

`Tools/packs.sh` (N2) builds the packs with `scrolls-cli pack` from `~/Documents/AI Stuff/Cipher` and `~/Developer/scrolls-data/sources`. It reads both and never writes there. Packs are cached in `~/Developer/scrolls-packs/<version>/`, keyed by the sha256 of their inputs.

**Generations.** An atlas generation is the deterministic result of one engine build replaying:
- the **starter** (slot 0);
- the **journal**, in sequence order. The journal holds every source load, every import and every user act (§6). A source load names its pack by sha256.

The phone builds generations in place, and that is the default. The CLI builds the same generation from the same inputs (`scrolls-cli atlas build --starter … --packs … --notebook <pulled Notebook/> --out …`). Equal fingerprints of the two are G6.

**The `.scrollsatlas` package** is a directory:
- `atlas.sqlite`;
- `derived/`;
- `ATLAS.json`: `{generation, engine_version, engine_code_hash, stage_code_hashes, schema_version, profile, tokenizer, segmenter, starter_sha256, packs:[{name, sha256, slot}], journal_seq, built_on, built_at, fingerprints:{table:{rows, sha256}}}`.

For AirDrop and Files it travels as a single file, `.scrollsarchive` (UTType `com.utkarsh.scrolls.archive`: an Apple Archive of the package, LZFSE, extracted by streaming with the AppleArchive framework).

**Installing a generation is the only way an atlas is replaced** (a swap, never a merge; platform graft):
1. **Detect.** `Inbox.scan()` runs whenever the scene becomes active. It lists `Documents/Import/` and then the system's `Documents/Inbox/` (the same file in both, by name and size, once, from Import; §3.9). (Not wired yet: nothing installs `Lifecycle.inboxScan`, so this build lists the drop folders only when Sources & storage opens or refreshes.) It reads `ATLAS.json` and refuses a mismatch with actionable copy. An atlas is compatible when the schema version, profile, tokenizer, segmenter and every evidence stage's code hash equal this app's, and its starter and journal prefix match this phone's. Example: *"Built by engine 1.1.0 (segmenter seg-1, matching code 3f9a); this app runs 1.0.0. Rebuild it with Tools/atlas.sh from the same commit."*
2. **Free space.** The free-space guard requires `volumeAvailableCapacityForImportantUsage ≥ 1.3 × incoming + 2 GB`. Otherwise it explains what to delete (§4.16).
3. **Move.** `Documents/Import/<x>.scrollsatlas` (or `Documents/Inbox/<x>`) → `Application Support/Atlas.next/`: a rename on the same volume, so no copy.
4. **Verify.** The sha256 of `atlas.sqlite` against `ATLAS.json`; open read-only; the probe; `PRAGMA quick_check(100)`.
5. **Catch up.** Replay the journal entries with `seq > ATLAS.json.journal_seq` into `Atlas.next` (a `journal-replay` job).
6. **Swap.**
   1. `JobQueue.suspendAll(within: .seconds(5))`, then drain the `ReadPool`.
   2. Rename `Atlas` → `Atlas.prev` and `Atlas.next` → `Atlas`.
   3. Reopen, and post `AtlasEvent.generation(.swapped)`.

   `Atlas.prev` is the one-step rollback (Settings → Diagnostics → *Roll back to the previous atlas*). It is deleted at the next successful launch.
7. **Fingerprint.** A maintenance job recomputes the LogicalDump fingerprints of the evidence tables and compares them with `ATLAS.json` (G6). It is shown in Diagnostics.

There is no 2.9 GB `INSERT … SELECT`, no FTS rebuild, and no per-layer transaction that an expiry could roll back. The phone uses the same mechanism for its own rebuilds:
- **Rebuild atlas** (Settings) replays into `Atlas.next` while the current atlas stays usable, then swaps.
- **An engine update** that changes an evidence stage's code hash, or `u61m-1`/`seg-1`, requires a rebuild. The app says so at launch: *"This version of Scrolls segments text differently (seg-2). Rebuild your atlas (≈ 25 min). Your notebook is kept."*

### 3.6 The data path on the phone (default; no Mac needed for Cipher)

| Step | Work | Budget / estimate | Where it runs |
|---|---|---|---|
| Starter | Clone `Bundled/starter.atlas` (≈ 6 MB): seeded vocab, the demo world and its runs. `clonefile`, falling back to a copy. | ≤ 50 ms | launch, off the main actor |
| Phase A | Cipher works (94,385), themes, roots (54,989 families), siblings. Then `label_tri`. Journaled as `sourceLoad(cipher-meta, phase: "A")`. | **≤ 60 s** (est. 20–45 s); QoS `.userInitiated` while in the foreground | foreground job |
| Phase A2 | 179,014 relation endpoints and the documented music relations (genealogy) | ≤ 90 s after launch (est.) | foreground job |
| Phase B | 691 Gutenberg + 825 Wikisource books (68.6 M tokens) → the boilerplate pass (Lineage, through `ScrollsService/Pipelines`) → incremental FTS merges | est. 6–10 min; **bound 20 min**; resumable per 5,000-document chunk | foreground job; under `BGContinuedProcessingTask` when he leaves with *Keep building when I leave Scrolls* on |
| Derived (automatic; the setting *Build analysis artefacts automatically* is on by default) | token streams per language (on demand); the English pooled space (`vectors`); era slices; the global reuse index over Cipher text | est. 1–3 min · 2–4 min · 2–4 min; each peak ≤ 600 MB | foreground and unconstrained only; never *started* in the background |
| STEMM | When the pack arrives: *"STEMM sources arrived (236 MB) · Load ≈ 15 min"* → Load. It brings gutenberg-stemm (704 books, 62.2 M tokens), OpenAlex (118,466 works, 60,574 abstracts, 381,800 citations) and Wiktionary claims. Spaces, era slices and the reuse index are then rebuilt for the new inputs. | est. 10–20 min; **bound 40 min** | user-started; continued processing |

- **Measured switches** (recorded at M1 and M2; never silent):
  - **Phase A.** If phase A exceeds 60 s on his phone, the starter becomes demo + Cipher metadata prebuilt by the CLI (≈ 180 MB in the bundle). Its fingerprint must equal the on-phone build, and the on-phone path keeps A2, B and every import.
  - **STEMM.** If the STEMM load exceeds 40 min, or cannot finish within thermal limits, the Sources page *also* offers the CLI-built generation from the same journal, with its measured time. The on-phone load stays supported and tested.
- **Pending text.** Until phase B finishes, text lanes of Cipher books show the `pending` state ("indexing — not yet looked"), and the Sources page says what is missing and why. Lanes of sources that are not on the phone are `uncovered` ("no sources"), never `absent`.

### 3.7 Background time, heat, and stall-proof progress

- **`BGContinuedProcessingTask`.**
  - It is submitted **only from a user action in the foreground**: Load, Build, Rebuild, or turning on *Keep building when I leave Scrolls*.
  - Request: `BGContinuedProcessingTaskRequest(identifier: "com.utkarsh.scrolls.job.<jobID>", title: "Indexing Cipher books", subtitle: "312 of 1,516")`, with `strategy = .queue`, under the permitted wildcard `com.utkarsh.scrolls.job.*`.
  - The task's `progress` is bound to the job's `Progress`.
  - On expiry the job is cancelled at its next checkpoint. Its committed chunks stay, and it becomes `interrupted` and is re-queued when the app is active.
- **The stall rule** (fixes the engine flaw the judges named).
  - A running job's progress must **advance at least every 2 s** of wall time.
  - `JobContext.checkpoint()` calls `heartbeat()`, and so does the SQLite progress handler, every 10,000 VM steps. `heartbeat()` advances the job's `completedUnitCount` within the current phase's unit budget.
  - **Banned in tasks that run on the phone** (enforced by `SQLCatalogTests` and a `StallLint` over task sources):
    - `VACUUM`;
    - FTS `'optimize'` (use `'merge', 500` steps instead);
    - `CREATE INDEX` on a populated table (every index exists from `schema.sql`);
    - `INSERT … SELECT` over more than 50,000 rows (chunk by rowid ranges);
    - `wal_checkpoint(TRUNCATE)` with a WAL over 256 MB (use `PASSIVE` after each chunk).
  - `StallTests` injects a 30 s statement and asserts ≥ 15 progress increments.
- **Suspension without a lease.**
  - When the scene goes to `.background`, `beginBackgroundTask` covers `JobQueue.suspendAll(within: .seconds(5))`: the current chunk commits, then the job stops.
  - `wal_checkpoint(PASSIVE)` runs. No lock or transaction is held across suspension.
  - The atlas never lives in an App Group container (avoids `0xdead10cc`).
- **`BGProcessingTask`** (`com.utkarsh.scrolls.maintenance`, `requiresExternalPower = true`) is **opportunistic only**.
  - It runs incremental FTS merges, the full `quick_check`, text verification, `gc-runs`, cube warm-up and leftover derived jobs.
  - Every grant is appended to `Documents/Diagnostics/bgtasks.jsonl` (`identifier, granted_at, duration, outcome`).
  - The gate card of an unbuilt space never promises it: *"The English space is not built yet (≈ 2 min on this phone). Build now — or Scrolls builds it while charging when iOS allows (last allowed: never)."*
  - M2–M4 record in VERIFICATION how often iOS actually grants this development build such time.
- **Thermal and Low Power Mode** (`DeviceConditionsSource`, bridged from LabKitCore `DeviceConditions`):

  | Condition | Jobs | Scroll frame rate |
  |---|---|---|
  | nominal | 6 workers | 120 Hz |
  | fair | 4 workers | 120 Hz |
  | serious | 1 worker, a 50 ms sleep after each chunk; background-priority jobs pause | 60 Hz (`FramePacing`) |
  | critical | every job pauses (*"paused — the phone is hot"*) until fair | 60 Hz (`FramePacing`) |
  | Low Power Mode | no automatic job starts; user-started jobs run with 2 workers | 60 Hz |

  Interactive reads are never throttled.

### 3.8 Memory and virtual memory

| Budget | Value | Mechanism |
|---|---|---|
| Interactive resident (dirty) | ≤ 400 MB | SQLite caches (3 × 32 MB readers, 64 MB writer), decoded-chunk LRU 3 × 8 MB, tile and memo LRU ≤ 64 MB, renderer ≤ 24 MB, UI |
| Any job (dirty) | ≤ 600 MB peak; only one job above 256 MB at a time | `ResourceBudget.peakBytes` is declared per task. Admission requires `os_proc_available_memory() ≥ peak + 600 MB`; otherwise the job waits with a message. |
| Declared peaks | co-occurrence 512 MB as 8 shards × 2²³ slots × 8 B, run as **two blocks of 4 shards (256 MB)**; rSVD ≈ 180 MB; winnow records ≈ 10 B per fingerprint per collection (≤ 175 MB at 60 M tokens) plus 64 MB of external-merge buffers; k-means ≤ 20k × 256 × 8 B | `MemoryBudget.reserve(bytes:)` |
| In the background (continued processing) | ≤ 300 MB per job | heavy analysis never starts in the background; if he leaves, it stops at its next checkpoint |
| **File mappings (virtual)** | **≤ 2.0 GiB in total** | `MappedFileRegistry` (N0) accounts every mapping: SQLite reader mmap 3 × 256 MB, cubes, spaces, token streams, dup and reuse indexes. A mapping that would exceed the budget falls back to `pread` streaming (slower, same result). |
| Memory warning | drop the tile and memo LRU and the chunk caches | `didReceiveMemoryWarning` → `AtlasPlatform.trim()` |

- **Entitlements.** The app requests `com.apple.developer.kernel.increased-memory-limit` and `com.apple.developer.kernel.extended-virtual-addressing`. **No budget depends on them.**
- **Device probe at M0** (in `-selftest probe` only, never at a normal launch). It records:
  - `os_proc_available_memory()` at launch;
  - the largest successful total mapping (map 256 MB windows of a sparse file until failure, capped at 6 GiB);
  - `task_vm_info.phys_footprint` during each suite.

  The numbers go into VERIFICATION, and the budgets above are revised only downward.

### 3.9 Container layout, backup and protection

```
<container>/
  Documents/                     visible in Files and Finder (UIFileSharingEnabled, LSSupportsOpeningDocumentsInPlace); nothing precious
    Import/                      packs, atlases and import files land here (devicectl, Finder, Files); emptied after a verified install
    Inbox/                       the system's: AirDrop and share-sheet copies, scanned after Import. iOS reserves it (the app may
                                 read and remove there but not create it: NSCocoaErrorDomain 513), hence the app's own Import/.
                                 A pack opened in place from Files is copied into Import/ (DeepLinks → DropFolder.receive)
    Exports/                     exports he chose to keep
    Diagnostics/                 probe.json, last-run.json, bgtasks.jsonl
    selftest/<run>/result.json   pulled by device-check.sh
  Library/Application Support/
    Atlas/                       isExcludedFromBackup · NSFileProtectionCompleteUntilFirstUserAuthentication
      atlas.sqlite (-wal, -shm) · ATLAS.json · derived/{spaces,align,reuse,dup}/ · packs/{stemm-*.scrollspack, ngram-eng-1.sqlite}
    Atlas.next/ · Atlas.prev/    transient generations (§3.5)
    Notebook/                    BACKED UP: journal-000001.jsonl … (rotated at 32 MB), originals/<aa>/<sha256> (user imports), settings.json
    SelfTest/<run>/              isolated roots for -atlasRoot (own Atlas/ and Notebook/); deleted after the result is pulled
  Library/Caches/Scrolls/        purgeable: cubes/, tokens/<lang>-<inputs>.u32|.pidx|.vocab.tsv, tiles/, thumbnails/
  tmp/                           export staging, archive extraction
```

**Restore from an iCloud backup.** `Notebook/` comes back; the atlas does not. Scrolls then:
1. clones the starter;
2. replays the journal in order (§6.5). Source loads of the bundled Cipher packs run on the phone;
3. if a journalled load names a pack that is not on the phone, says so and waits: *"Your notebook refers to the STEMM pack (sha 3f9a…, 236 MB). Send it from your Mac; 12 later actions wait for it."* Replay is strictly in order (§6.5).

### 3.10 Imports in, exports out

- **In.**
  - `fileImporter` accepts `.plainText`, `.utf8PlainText`, `.commaSeparatedText`, `.tabSeparatedText`, `.json`, `UTType("net.daringfireball.markdown")` and the imported `org.jsonlines.jsonl`.
  - `CFBundleDocumentTypes` (rank Alternate) puts **Open in Scrolls** in the share sheet and in Files.
  - Staging is a security-scoped, streamed copy into `Notebook/originals/<aa>/<sha256>`, hashed incrementally, so a journal replay can re-run the import.
  - The reference limits stay: 2 GB per file, 20 MB per field, 5 M rows. An original over 200 MB gets a Storage toggle *"exclude from iCloud backup — if excluded, a restored phone cannot replay this import"*.
- **Out.** `ShareLink` with `Transferable` `FileRepresentation`s that run the export job lazily, with progress:
  - JSON, JSONL and CSV with the manifest first (licences travel; `export_text_allowed = 0` respected);
  - PNG (`DisplayListCanvas` through `ImageRenderer` at 3×, with legend, caption and the SYNTHETIC stamp when synthetic material is visible);
  - SVG (`SVGWriter`);
  - the notebook (every revision plus the journal, JSONL);
  - `.scrollsview` (§6.4);
  - `problems.csv`.
- **Exported UTTypes:** `com.utkarsh.scrolls.pack` (`.scrollspack`), `com.utkarsh.scrolls.atlas` (`.scrollsatlas` package), `com.utkarsh.scrolls.archive` (`.scrollsarchive`), `com.utkarsh.scrolls.view` (`.scrollsview`, JSON).

### 3.11 Transfer between the Mac and the phone

- **`Tools/atlas.sh` (N2) subcommands:** `push-pack <name>`, `push-baseline`, `push-atlas <dir>`, `pull-notebook`, `fingerprint`, `transfer-bench`. They use:
  - `xcrun devicectl device copy to --device <id> --domain-type appDataContainer --domain-identifier com.utkarsh.scrolls --source <path> --destination Documents/Import/` (not `Documents/Inbox/`: iOS reserves that folder for AirDrop and share-sheet copies, and the app cannot create it);
  - `copy from` for `Notebook/` and Diagnostics.

  A re-push skips unmodified files, so a directory package resumes file by file after an interruption.
- **Finder file sharing** works too: drag the file into Scrolls' `Import` folder. A drag onto Scrolls itself lands in `Documents/`, which the scan does not read.
- **AirDrop** is supported for packs and `.scrollsarchive` files. It is **not recommended** for a full atlas: an interrupted AirDrop of a 2.9 GB file starts again from zero.
- **Cable speed.** The 15 Pro Max's stock USB-C cable is USB 2 (480 Mb/s), so ≈ 2.9 GB takes about 1.5–2 min at best (est.). A USB 3 cable (10 Gb/s) is faster. `transfer-bench` measures MB/s with the STEMM pack at M0 and a full atlas at M2, and records it in VERIFICATION. **No figure in this file assumes a USB 3 cable.**

---
## 4. The iPhone experience

This section adopts the experience proposal's §4.1–§4.21 **wholesale**, with three kinds of change:
- the presentation architecture, which judges found unbuildable as written, is replaced by §4.2;
- the launch stagger is removed (ΔS-8);
- the vantage path is tied to the reference's `gate()` (§4.23).

The engine proposal's §4 survives only where it agreed with these.

### 4.1 Principles

1. **The Scroll is the map, and the sheet is the inspector.** This is the Maps and Find My idiom: one full-bleed canvas and one persistent inspector at the bottom. He never navigates away from the timeline to read evidence.
2. **Thumbs live at the bottom.** On a 6.7" phone, search, ▶ Play and Step ▸ sit in the inspector's peek row (y ≈ 800–890 pt). The top bar carries state he reads (strands, corpus, jobs), not controls he hammers.
3. **Glass is chrome; data is opaque.** Liquid Glass is used only for controls that float over the Scroll. Bars, passages, gate cards, edge cards and Compare panels sit on opaque `bg-0`/`bg-1`, so evidence is never refracted.
4. **Nothing moves unless the evidence or the user moved it.** There is no idle animation, no decorative motion and no layout drift. The renderer draws **zero frames at rest**. The first paint is one 200 ms fade, never a stagger (ΔS-8).
5. **Tap replaces hover, and nothing is lost.** Every bin, gap, wash, cap, arc, seam and band answers a tap with its **generated sentence** in the peek row, made from the same numbers as the drawing. That is the phone form of "every pixel answers three questions".
6. **Every count names its denominator,** even in the peek row: "14 in 38,120 tokens", never a bare 14.

### 4.2 Screen map and the presentation architecture

```
WindowGroup (one scene)
└─ RootView                                  NavigationStack(path: $coordinator.path)
   ├─ ScrollScreen (the stack's root)        ZStack:
   │   ├─ ScrollCanvas (Metal) + chrome      TopBar · SYNTHETIC ribbon · minimap · ruler · coverage · lane headers
   │   └─ InspectorSheet                     CUSTOM OVERLAY with detents peek / half / large; part of the root view
   ├─ .navigationDestination(for: Route)     Compare · Lineage · Genealogy · Constellation · Notebook  (zoom transitions)
   └─ .sheet(item: $coordinator.modal)       RootModal: import · sources · savedViews · lanes · filters · legend ·
                                              howItWorks · settings · jobs · yearPicker
   Pushed destinations present their own cards with .sheet(item: $coordinator.card): edgeCard · nodeCard · hypothesisGroup · annotationEditor
```

- **The inspector is not a system sheet.** `InspectorSheet` (N0 frame, N8 content) is a SwiftUI overlay inside `ScrollScreen`.
  - It has a drag handle and three detents:
    - **peek:** 104 pt (search plus transport);
    - **half:** 50% of the container (Then/Now/Next, drawers, results);
    - **large:** up to the top safe area + 44 pt (reader, results with the keyboard).
  - It snaps with velocity, and it is never dismissed.
  - It reports its height through `onGeometryChange` into `ScrollModel.occludedBottom`, and only touches inside its own frame reach it, so the Scroll receives every touch above it. **No `presentationBackgroundInteraction` is needed.**
  - Its partial-height background is glass (`.glassEffect(.regular, in: .rect(cornerRadius: 28))`), and its content panels are opaque.
- **Pushed destinations cover the inspector naturally,** because the overlay belongs to the root view.
  - **Zoom transitions** use `matchedTransitionSource(id:in:)` on SwiftUI views that live in the root. The sources are the brushed-range chip on the ruler, the buttons in the inspector, and a transparent anchor view that `ScrollScreen` positions over a long-pressed mark.
  - **System back swipe:** pushed canvases keep a 20 pt leading dead zone, so the system back swipe wins at the edge.
- **At most one system presentation at a time.** `PresentationCoordinator` (N0) holds `path: [Route]`, `modal: RootModal?` and `card: CardModal?`.
  - Setting `modal` while a card is up dismisses the card first.
  - The `card` sheet is presented only by the top pushed destination.
  - Popovers (the ambiguity chooser, the year picker) exist only on the root, when `modal == nil`.
  - `PresentationTests` drive every pair of transitions.
- **Landscape** has no overlay sheet. Selecting something opens a 360 pt **inspector column** at the trailing edge (§4.4).

### 4.3 Portrait geometry (430 × 932 pt; safe area 59 top, 34 bottom)

| y (pt) | Region | Contents |
|---|---|---|
| 0–59 | status bar | kept visible (a reading instrument), dark |
| 59–103 | **TopBar** 44 | Leading: the corpus chip ("Demo" + `SYN`, "Cipher", "STEMM", "All real"). Centre: up to 4 strand chips in one `GlassEffectContainer` (`● carry the zero ✕`), morphing with `glassEffectID` — the root screen's only morph, and it means "this is now on the Scroll". Trailing: the status chip (a determinate ring, "Cipher 45%") and `⋯` More. |
| 103–117 | **SYNTHETIC ribbon** 14 | The striped band "SYNTHETIC DEMONSTRATION CORPUS — invented people, texts, dates and links." whenever any demo collection is in scope. It cannot be dismissed. At accessibility sizes its label wraps into More, and the stripes stay. |
| 117–141 | **Minimap** 24 | The folded overview: one 3 pt density row per lane group (≤ 5), the modality seam, and a draggable cyan bracket. Double-tap = fit the data. |
| 141–169 | **Ruler** 28 | Major ticks ("1850", "500 BCE", "Apr 1931"), the playhead handle "as of 1925" (a 44 × 44 pt target), and the tier pill when the bin changes. |
| 169–179 | **Coverage track** 10 | Five grey step classes; hatched = none; dotted = pending. |
| 179–794 | **Lanes** (615 pt at peek, 287 at half) | A lane = an 18 pt header strip + n × 24 pt strand slots + 10 pt of arc room. A one-strand lane is 52 pt, so 5 lanes fit even at half. **The default is 5 lanes**; the "+n more lanes" row expands in place up to 10, and the lanes then scroll. |
| 794–898 | **Inspector, peek** 104 | The search field (44) and the transport row (44): ▶ Play · Step ▸ · "as of 1925" · the strict/context eye. |
| 898–932 | home indicator | nothing interactive within 12 pt of it |

- **The lane header strip (18 pt).**
  - A sticky label chip stays put while time pans, for example "English · text · 12.4M tok · 1823–1928". Unit and coverage always show; long labels truncate in the middle; a tap opens the full header with its prominence and selection notes.
  - Sticky shelf chips sit at the trailing edge: `⊘ 172` (undated) and `⇥ 1` (scheduled). Warnings append to the label chip (`⚠ 34% undated`), and cluster lanes add "machine label (editable)".
  - The chips are glass on the reserved header strip, **never over bars**.
- **The strand slot** is 24 pt (16 compact, 32 comfortable). Bar height is linear in the lane unit up to 70% of the slot, and every observed bin is ≥ 1 pt.

### 4.4 Landscape (932 × 430 pt; safe insets 59 left and right, 21 bottom)

The app supports portrait and both landscape orientations. Landscape layouts are defined for the Scroll, the reader and Compare; other screens adapt as lists.
- **The Scroll** gets:
  - a 36 pt TopBar, with strand chips as glyphs only (● ■ ▲ ◆) and labels on tap;
  - minimap 20, ruler 24, coverage 8;
  - a 120 pt lane rail holding the full header text in two lines;
  - **694 pt of timeline** (1.6× portrait);
  - lanes ≈ 320 pt (6 one-strand lanes);
  - the transport as a trailing-bottom glass capsule.
- **Selecting a mark** opens a 360 pt inspector column with Then/Now/Next tabs. The rail then collapses to portrait-style chips, keeping 454 pt of timeline.
- **Rotation** keeps `centerDay`, `pointsPerDay` and the selection: the time under the screen's centre stays under the centre.
- **Compare** shows A | B side by side, and its arcs are requested with `limit=300` (ΔS-11).

### 4.5 Gestures (`ScrollGestureHost: UIView` with UIKit recognisers, wrapped by `ScrollCanvas: UIViewRepresentable`)

| Gesture | Effect | Details |
|---|---|---|
| One-finger pan, mostly horizontal | pan time | Direction lock after 10 pt (`|dx| > 1.2·|dy|`). Momentum at `UIScrollView.DecelerationRate.normal`, stopping below 5 pt/s. Rubber band 0.55 beyond [10000 BCE, 2100 CE]. **No momentum under Reduce Motion.** |
| One-finger pan, mostly vertical | scroll lanes | Uniform offset; headers follow. |
| Pinch | zoom **x only** around the centroid's day | `pointsPerDay *= scale`, clamped to [0.05 pt/yr, 40 pt/day]; the day under the centroid stays under it, and centroid travel pans at the same time. A tier change plays `.detent` and shows the pill "Now showing yearly bins". |
| Pinch out past 0.05 pt/yr | **folded overview** | `.boundary` haptic and the pill "Deep time: four linear regimes (×3.3 · ×8.9 · ×3.3)". Panning is disabled; tapping a regime unfolds there ("Linear axis · 1 pt = 0.11 yr"). The Deep-time button in More does the same. |
| Tap | select the topmost hit | Priority mark > arc > cap/fork > bin > wash > band (SPEC §8.4); tolerance 12 pt. When ≥ 2 marks lie within 6 pt of each other, the **ambiguity chooser** opens: a popover with `.presentationCompactAdaptation(.popover)` listing up to 6 rows such as "1994 · Zero Holds the Place · song". |
| Tap on an empty bin, a gap, a wash or the seam | its **sentence** in the peek row | e.g. "1980s · Hip-hop · 0 occurrences in 6.2k tokens: looked, found none" |
| Long press (0.4 s) on a mark | **preview and actions** (`UIContextMenuInteraction`) | The preview is the passage with its highlight and date chip. Actions: Open · Annotate · Lineage · Trace this quotation (spans ≥ 4 tokens) · Compare from this bin · Pin expression · Copy citation. |
| Long press on the ruler, then drag | brush a range | A cyan range with **A** and **B** chips → Compare. Releasing without a drag cancels. |
| Drag the playhead handle | scrub the vantage | Discrete by bin; a loupe "1997" floats 44 pt above the finger. Haptics: `.tick` per bin (≤ 30/s), `.soft` on entering a stretch with no coverage, `.boundary` at the modality seam. |
| Double tap / two-finger tap | zoom in / out one tier | 250 ms ease; a jump under Reduce Motion |
| Drag the minimap bracket | pan | the bracket's width follows the viewport |

- **Conflicts.**
  - Pan and pinch recognise simultaneously with each other only.
  - A tap requires the double tap to fail, with a 180 ms limit.
  - The playhead handle wins over pan.
  - Nothing interactive sits in the bottom 34 pt, and `defersSystemGestures` is **not** used: a reading app must not fight the home gesture.
  - `ScrollGestureTests` drive pans with the inspector at each detent.
- **A hardware keyboard** gets the SPEC §8.5 map through `onKeyPress`: Space, `[ ]`, `{ }`, `0`–`6`, `D`, `L`, `E`, `V`, `T`, `P`, `C`, `G`, `K`, `N`, `S`, `X`, `?`.

### 4.6 The vantage, scrubbing and Play

- **The playhead** is a cyan line through every lane, with a glass handle on the ruler reading "as of 1997". Tapping the label opens the year picker: era chips (Deep time · Classical · Early modern · Modern) plus a year wheel. The pick snaps to the bin that contains that year.
- **The vantage is a shader uniform** (§4.23).
  - In *strict* mode, primitives whose `revealDay` is later than the vantage are discarded; in *context* mode they are drawn at 15%.
  - An arc appears only when both its ends are ≤ the vantage. A feedback arc and its violet halo appear when the vantage reaches the later work.
  - **The hit grid and VoiceOver apply the same predicate.**
  - Scrubbing and Play rebuild nothing.
- **Play** (▶; Magic Tap under VoiceOver) advances one bin every 400 ms at 1×.
  - Long-pressing ▶ opens a tray with one LabKit `GlassKnob` (detents 0.25×, 0.5×, 1×, 2×, 4×).
  - The bin level is frozen while it plays.
  - Auto-pan keeps the playhead at 70% of the width, easing 120 ms per step (a jump under Reduce Motion).
  - Newly revealed marks fade in over 150 ms through the fade uniform (none under Reduce Motion). An interval item is drawn dashed at `lo` and solid at `hi`.
- **Gaps.**
  - When every visible lane ahead is uncovered, Play pauses 600 ms with the pill *"No coverage 1940–1949 in these lanes: skipping. Nothing is inferred."*, plays `.soft`, then jumps.
  - At the modality seam it pauses once with the seam caption and plays `.boundary`.
- **Strict vs context.** Play runs strict; pausing switches to context. The eye toggle (or `V`) switches by hand.
- **Reduce Motion.** Play steps every 1.2 s, **Step ▸** becomes the filled primary control, and each step is announced at most once a second: "As of 1950: 2 new occurrences in Classroom".

### 4.7 Honesty encodings on the phone (every SPEC §1/§8.7 element)

| SPEC element | Phone form | Verified by |
|---|---|---|
| `observed` bin | Metal rect, height = rate, ≥ 1 pt; 2 pt corners at ≥ 6 pt width | G5 geometry; G8 |
| `absent` | 1 pt dotted baseline; tap → "0 occurrences in 4.1M tokens: looked, found none" | G5; sentence test |
| `low` | hollow 1 × 8 pt tick + a 45° hatch at 30%; tap → "low coverage: n = 3 in 18k tokens" (**no rate numeral**) | G5; the copy test greps for the absence of a rate |
| `uncovered` | 45° hatch at a **6 pt pitch** in screen space, in the lane underlay; tap → "no sources" + the collection's span | G8 pattern probes |
| `pending` | sparse dots, and the header chip "indexing 41%" | UI test with a pending pack |
| Bars never bridge gaps | one rect per maximal run; nothing drawn between | G5 run boundaries exact |
| Caps ● ■ ▲ ◆ at the exact first date; end tick; censoring ◁ ▷ ("may be older than our record") | label-atlas glyphs at 7 pt; end tick 1 × 6 pt | G5 |
| Sparse (n ≤ 4), single-source `¹`, estimated majority (stripes + `≈`), synthetic `--syn-stripe` | per-instance flags → fragment-shader patterns. `¹` and `≈` are drawn only at ≥ 14 pt bar width and are otherwise spelled out in the tap sentence. | G8; sentence test |
| Precision washes (circa ends feathered 10%) | band at opacity .18 with a 1 pt top rule; count label at ≥ 40 pt; tap lists the items | conservation (G3) |
| UNDATED / SCHEDULED shelves | header chips `⊘ n` / `⇥ n` → searchable lists; ≥ 20% undated → `⚠ 34% undated` + "compare undated vs dated" | UI test |
| Modality seam (1928) | a permanent 1 pt `ink-2` line through all lanes + the ruler label "Full text ends 1928 →"; tap → the full caption. Collapsible to a tick in Settings, **never hidden**. | UI test: present whenever text and title lanes share the view |
| Coverage track + lane underlay | 10 pt + 3 pt, 5 grey classes, legend in the Legend sheet | G8 |
| Arcs: earlier → later; colour by role; pattern by status | quadratic 1.5 pt with **dash by arc length** in the shader (solid / 6–4 / 1–3); endpoint ● / □ / ?; arrowhead at the later end; `limit` 150 portrait / 300 landscape | G5 bundles; G8 dash probes |
| Feedback arcs below, violet; the re-read halo | gated by the vantage uniform; halo tap → "re-read after 2016 (1 documented, 2 annotated)" | journey step 4 |
| Date conflict | `danger` dotted stub + ⚠ | G5 |
| Review overlay ✓ ✕ ⚖ | midpoint glyphs; **the line pattern never changes**; rejected arcs hidden by default and drawn at 30% with a strike when shown | style test: 3 statuses → 3 distinct (dash, endpoint, badge) triples |
| Split ⑂ / merge ⑃ | dashed S-curve + glyph; tap → "a split in usage contexts, not a claim about speakers" | G4 transitions + G5 |
| Etymology bands, listed-roots bracket, "no family" note | hatched bands in the Etymology lane; the bracket label wraps to two lines; tap → the band sentence ("period of the language, not a date for the word") | UI test with *zero*, *virus* |
| Wiktionary claim | hollow amber diamond left of the strand; tap → "Wiktionary: first attested 1898 (external claim)" | — |
| External baseline | its own 24 pt track and axis label; the licence line is in the tap sentence | — |
| Lane order note | first line of the Legend sheet **and** of the Lanes sheet: "Lane order is a sorting choice (first observed), not a scale of meaning." | copy test |
| Selection | cyan 2 pt + a 6 pt halo at 20%, static (no pulse) | — |
| SYNTHETIC everywhere | ribbon; `SYN` badge on passage cards; a dashed 1 pt frame around panels showing demo material; the stamp on PNG exports | snapshot + export tests |
| Over budget | the pill "Simplified: decade bins (too many marks for one screen)" | perf test forces it |
| Differentiate Without Colour | role-hue arcs gain a family glyph at the midpoint (`“ ”` · `§` · `♪` · `↺` · `∼`); the selection gains a dot | accessibility test |

### 4.8 The inspector: Then / Now / Next, drawers, shelves

The content is a small state machine, `SheetMode`: `idle` · `search` · `inspector(Selection)` · `drawer(BinRef)` · `shelf(ShelfRef)` · `yourTurn`. When a mark is selected, the Scroll pans (250 ms; a jump under Reduce Motion) so that the mark sits in the visible band above the sheet.

- **The Crossings card** sits at the top, collapsed to one line by default: "Literature 1911 · STEMM — · Culture 3 titles · Etymology Sanskrit śūnyá (period) · Claims ◇ 1898". Expanded, it is SPEC §2.D's card with every row's basis and the caption "First observation in THIS corpus is not the date of coinage, and not evidence of borrowing."
- **Then** (amber accents):
  - the date chip ("17 May 1994 · stated · day", plus "unverified" or "translation, dated by the original" where relevant);
  - the document card (title, author, collection, licence, `SYN`);
  - the passage, with the match highlighted **at its UTF-16 offsets** (cyan 25% background + underline);
  - "±1 passage" expanders, and **Open in reader** (TextKit 2, scrolled to the offset; whole books are laid out by viewport);
  - the "refers to 1911" chip;
  - **contemporary uses** (≤ 9, stratified ≤ 3 per lane) under the denominator line "n = 37 in 1925–1945 · 6.1M tokens";
  - "Machine annotations (fallible)" in a disclosure group.
- **Now** (violet accents):
  - a later-passage picker (every later related passage, plus "any later occurrence") and the relationship card;
  - a **stacked** alignment, Then over Now: shared tokens ivory, substitutions with a violet underline, insertions dotted;
  - then "context words, not meanings", or "No recorded relationship; these are separate uses of the same expression."
- **Next:**
  - subsequent relationships (≤ 20);
  - a Swift Charts sparkline of later occurrences, with denominators;
  - **Add a hypothesis about later reinterpretation**, which makes the dashed violet card "Hypothesis — by you, 9 Oct 2026 — not evidence".
- **The fixed footer:** "Then shows documents and their settings, not anyone's private thoughts."
- **The bin drawer** (tap an aggregate bin) starts with the denominator line ("1910s · Classroom · 14 occurrences in 38,120 tokens · 367 per million [201–616]"). Then a `LazyVStack` of KWIC rows (50 per page, by date), each opening Then. Sampled bins say "contexts sampled: 200 of 1,894 in this bin".
- **Shelves** (`⊘`/`⇥` chips) open searchable lists in the same sheet.

### 4.9 Search, including Hindi and Gujarati from an English keyboard

- **Focusing the field** raises the inspector to large with the keyboard.
- **Suggestions are typed and grouped:** Expressions (with "Track as ● strand", count, unit and corpus) · Works (→ Genealogy) · Makers · Themes · Etymology · Annotations.
  - Each row comes from the `label_tri` typeahead (≤ 2 ms) plus FTS counts (≤ 10 ms).
  - Tracking an expression drops the sheet to peek, and its strand chip morphs into the TopBar.
- **Romanised Indic typeahead** (closes a gap all three proposals missed).
  - When the query is Latin script and ≥ 4 characters, search also runs the ported `transliterationCandidates` (`translit-key@1`, `romanKey`) against the corpus vocabulary.
  - Matches appear as Expression rows such as "शून्य · Hindi · 412 matches" and "શૂન્ય · Gujarati · 88 matches", labelled "romanised match — a suggestion, not a merge".
  - Tapping one tracks the **native-script** form. Romanised and native forms are never silently merged (SPEC §4.5).
  - Typing "shunya" therefore finds both, with no keyboard switch. The system Hindi and Gujarati transliteration keyboards also work, because the field accepts any script.
  - Golden G1 covers `romanKey`; G3 covers the "shunya" request.
- **Counts before materialisation.** While materialise runs, the lanes show a skeleton with **"preliminary: passages containing"** counts, then "counting… 41%". There is never a spinner without a number.
- **Empty results** use the computed copy (§4.18).

### 4.10 Compare (a pushed destination)

- **Entry points:** the ruler brush (A/B chips) · "Compare from this bin" in the mark menu · More → Compare · `C`. It opens with a zoom transition from its source.
- **Layout.** A vertical stack; **A is always the earlier slice**, and A sits over B in every panel (A | B in landscape). At the top is a range-edit strip: the same renderer at 64 pt, with draggable A and B brackets.
  1. The **multiplicity line** is pinned under the title ("Comparison #7 for 'virus' in this session; …").
  2. **Coverage and composition always come first:** two compact rows of slice facts, then a stacked kind × language × collection bar. The JSD caveat card is amber; the modality gate card has **[Compare titles with titles]**; the prominence caveat follows.
  3. **Frequency:** a Swift Charts dot and CI rule per slice in its unit, plus the rate ratio with its CI when the units match. Axes are linear only.
  4. **Representative passages:** 5 per slice, with the seed printed and a **Reshuffle** button.
  5. **Neighbouring terms:** tabs for shared / A only / B only, with logDice and q.
  6. **Context groups:** shares with CIs, or a gate card.
  7. **Estimated displacement:** gate cards, or values named "estimated shift in usage contexts".
  8. **Tone:**
     - The label reads "Apple NLTagger — modern reader model, fallible, anachronistic for historical text", followed by the human stance and pragmatic counts.
     - **Availability is probed on the device.** If `NLTagger` sentiment or `NLEmbedding` English is not present, the gate card says *"Tone needs Apple's English sentiment model, which is not on this phone."* It offers *Download Apple's language assets (a system download)* — the opt-in network surface of ΔS-17.
  9. Last: **"How coverage could affect this"**.
- **Gate cards are opaque, never glass.** Each shows `{gate, needed, have, suggestion}` and an **[Apply]** button that widens the slice and re-runs. A gated measure renders **no numeral**; `Gated<T>` makes that unrepresentable.
- **Long panels stream in** as they finish. Each panel shows its own "counting… 41%".
- **As-saved views** compute Compare with the view's cutoffs (RF-2).

### 4.11 Lineage and Genealogy (pushed)

- **The canvas** is SwiftUI `Canvas` with `.drawingGroup()`, bounded at ≤ 150 nodes and ≤ 400 edges.
  - x uses the same linear `TimeScale` as the Scroll, with the same pinch and pan; the "ordinal spacing" toggle is labelled as such.
  - Rows are generations, never meaning. Undated nodes sit in a 44 pt gutter, and the root is outlined in cyan.
- **Edges** use `EvidenceStyle`: pattern = status, glyph + label = type, hue = family. Chip filters scroll horizontally, and the evidence control cycles all → documented + computed → documented.
- **Tap a node** → the Then card, in the `card` sheet. **Tap an edge** → the **edge card** (N5), which shows:
  - type, direction and status in words (`DOC*` when the source was not recorded);
  - origin, method or annotator, run and parameters;
  - the score with its kind ("similarity 0.71 — not a probability");
  - the external locator ("opens in Safari, outside Scrolls");
  - the supporting spans, stacked with an aligned diff, and the CUE badge;
  - the revisions, with the compact create revision expanded;
  - **Confirm / Reject / Dispute / Attach evidence**, each needing a note of ≥ 10 characters;
  - the fixed caution sentence.
- **Chain of custody.** Long-press a node → "Path from here", then tap a second node. The result is a vertical list of link cards headed "Chain strength = weakest link: PROPOSED".
- **Bounded expansion:** a ＋ per node (≤ 30). At 150 nodes the view offers **Show as list** and says "showing 150 of 412 nodes". Commonplaces collapse into "widely shared text (n documents)".
- **Hypothesis groups:** a fan marked "⚖ 2 competing". The group card pages through the hypotheses (one per page, with a page indicator) and offers "Add a hypothesis".
- **Genealogy** is the works-as-rows gantt.
  - Rows are 32 pt ("title — maker (year · precision)"), grouped by generation under sticky generation headers that carry a density strip, with pages of 50 ("+214 more samplers — 1990s: 88").
  - The honesty line is pinned: "Absence of a link is not evidence of no sampling."

### 4.12 Constellation (pushed)

- **Canvas and scale.** SwiftUI `Canvas` with pinch and pan, ≤ 150 nodes and ≤ 400 edges.
  - Positions come from the engine's deterministic Fruchterman–Reingold layout (`layout_cache`) and **never move on a period change**.
  - **Re-layout** is an explicit button, with the toast "Positions recomputed — movement is not semantic."
- **Overlay mode only** (ΔS-10): A-only nodes are hollow amber, B-only nodes dashed ivory, nodes in both filled, and two-tone rings show size change. The diff list ("only in A / only in B / grew > 2×") is a card.
- **A persistent legend:** a one-line glass bar at the bottom-leading edge ("area ∝ occurrences in period (sqrt radius) · edges: logDice ±5 tokens"). It expands to the full legend and never closes.
- **The size quantity** is a segmented control: occurrences · documents · authors.
- **From a Term trail** it opens on the decade with the most matches (ΔS-13).

### 4.13 Notebook (pushed; also "Annotate" from any mark)

- **The list** groups annotations by target, then by layer. Each card shows "rev 3 of 3", the kind, the dimensions as chips, the evidence chips (amber = for, struck grey = against) and the author.
- **The editor** (`card`, large): a body `TextEditor` (`body_md`), the kind picker, dimension rows (enum → chips, scale → slider, text, bool → toggle), tags, and evidence picked from recent selections. Saving appends a revision through the journaled write path.
- **Revisions:** a scrubber with **one stop per revision** and a word-level diff. The **as-of slider** has a stop at every revision timestamp and is the human vantage clock (ΔS-12).
- **Reinterpret** creates a new annotation with `supersedes`. The old one stays as a visible layer: "Layer 'Reader A, 3 Oct 2026' — superseded 12 Nov 2026".
- **Compare interpretations** pages one column per layer or author, with the shared evidence highlighted.
- **Machine annotations** sit in their own section ("fallible") and can only be countered, never edited.
- **Orphaned interpretations** (§6.5) are listed with their quote and the reason; they are never dropped.

### 4.14 Term trail and Crossings

The **Term trail (all real corpora)** preset draws 18 fixed lanes in collapsible domain groups: Etymology · Literature en/fr/es/hi/gu · STEMM fields · Culture titles · OpenAlex shares.
- Group headers are sticky, with a chevron.
- Each lane keeps its own unit. OpenAlex lanes say "share of the top-cited sample in each cell — not a trend".
- A final row lists absent sources with their reason: "STEMM lanes need the STEMM pack: not on this phone (236 MB)".
- The Crossings card is the first thing in the inspector.

### 4.15 Saved views, links and state restoration

- **Save** (More → Save view, or `S`) asks for a name and makes an immutable view, with its pinned runs and cutoffs plus its **portable cutoffs** (§6.4). A re-save becomes `slug~2`. Feedback: the `success()` haptic and the toast "Saved: carry-the-zero-four-uses-3f9a".
- **Links** use the web grammar unchanged (ΔS-18):
  - `scrolls://open#v=1&c=demo&s=e12&l=community:fo&…` carries the state;
  - `scrolls://view/<slug>` opens a saved view, and `?as=1` opens it as saved.

  The parser is `ViewState(hash:)`, and G1 proves it equal to the web's.
- **Sharing a view** produces:
  1. the link;
  2. a `.scrollsview` file: `{scrolls_view:1, slug, state_hash, state, portable, generation, saved_at}`;
  3. the PNG.
- **Opening a view on another phone or generation.** The portable cutoffs are resolved (§6.4), and the banner names the difference: "Saved on generation 3; opened on generation 4: ids remapped, counts as saved". If the view's packs are absent: "Not saved on this phone: opened from its state. Counts reflect this phone's atlas."
- **The Saved views sheet** lists the views with snapshot thumbnails, each with its drift note ("Corpus changed since this view was saved…") and **As saved / Current** chips.
- **State restoration (N8):**
  - `@SceneStorage("view")` holds the canonical view-state hash: centre day, zoom, lanes, strands, vantage, selection, range, panels.
  - `@SceneStorage("ui")` holds a small JSON: the inspector detent and `SheetMode`, the pushed `Route` path, the inspector tab, the lane scroll offset and the reader position.
  - At launch both are restored before the first tile request. A selection whose id no longer resolves is cleared, with a toast.
  - `StateRestorationTests` background the app, terminate it, relaunch, and compare the hash.

### 4.16 Import wizard, and Sources & storage

- **Import** (More → Import a file, or through Open in Scrolls) is a modal sheet at large with a step indicator:
  1. **File:** the name, the sniffed format, the encoding (with `W_ENCODING_FALLBACK` and the first bad byte's offset) and the first 5 records.
  2. **Map:** one row per detected field, with a role picker (date, title, author, text, language, community, genre, URL, ID, metadata, ignore) and 3 sample values. The date role previews the grammar live ("c. 1894 → 1889–1899 · estimated").
  3. **Validate:** accepted, warnings and rejected counts; the problem list (line:col, code, message, suggestion); **Share problems.csv**.
  4. **Commit:** a journaled job with progress; he may leave and the status chip carries it. Then the summary, with **Revert**.
- **Sources & storage** (More → Sources and storage, or the status chip) shows:
  - **Bundled:** "Cipher metadata — built 9 Oct · 94,385 works · 179,014 relation endpoints"; "Cipher full text — 1,516 books · building 312 / 1,516".
  - **Each absent pack** with how to send it: "On your Mac: Tools/atlas.sh push-pack stemm — or put stemm.scrollspack in Scrolls' Import folder (Finder, Files) — or AirDrop it". Then **Load** with the time estimated from this phone's own bench.
  - **Generations:** the current one, its fingerprint check, *Roll back to the previous atlas* (while `Atlas.prev` exists), and *Rebuild atlas*.
  - **Storage:** a stacked bar (atlas · packs · derived · caches) with "rebuildable" tags, **Purge caches**, and "Remove the STEMM source pack (236 MB): STEMM 'Original record' then says 'kept in the STEMM pack on your Mac (sha 3f9a…)'".
  - The setting **Build analysis artefacts automatically** (on).

### 4.17 The first minute (scripted; coach marks never block and never return unless he asks for the Tour)

| t | On screen | Engine | Feel | Teaches |
|---|---|---|---|---|
| 0–1.0 s | The launch colour `#0E1013`, then the Scroll: *carry the zero*, lanes = community (5 + "+n more lanes"), 1890–2030 in decade bins, vantage 1925, the SYNTHETIC ribbon. **The data plane fades in once over 200 ms** (none under Reduce Motion; no stagger). The status chip reads "Cipher: titles & relations 4%". | starter cloned and opened; tiles at L2 from the cube; phase A enqueued | — | one phrase, across communities, over time |
| 2 s | **Coach ①**, a glass callout with a leader to the 1911 Classroom bar: "Bars span where 'carry the zero' was **observed**. Gaps are real: dotted = looked and found none; hatched = no sources." The 1940s hatch and the 1984–93 dotted stretch get a static 1 pt cyan outline (no pulse). | — | — | absence has two kinds |
| ~12 s | **Coach ②** at the two arcs. Solid amber `DOC`: "1994 liner notes cite Brennock's 1911 primer — a synthetic record". Dashed `CALC`: "1963 bulletin repeats 13 words of the primer — computed by text matching". Then: "Line style = evidence. Tap any mark to read its source." A static ring marks the 1994 Hip-hop mark. | — | — | documented ≠ computed |
| ~25 s | He taps the 1994 mark. The inspector rises to half: the passage with its highlighted span, `SYN`, "17 May 1994 · stated · day", "refers to 1911". | `passage(901)` ≤ 10 ms | `.select` | every mark opens its passage |
| ~40 s | **Coach ③** above the peek row: "Press ▶ to watch the phrase acquire history." Play runs 1925 → 2026 in ≈ 5 s at 400 ms per decade, pausing 600 ms at the 1940s gap (the "Nothing is inferred" pill). At 2016 the 1911 primer gains a violet halo and the feedback arc draws below the lanes. | uniforms only; zero rebuilds | `.tick` per decade, `.soft` at the gap, `.ripple` when the halo appears | change over time; gaps preserved; re-reading only where a link says so |
| 55–60 s | The inspector shows **"Your turn."**: the search field focused, the chips `virus` · `zero` · `sample`, and **Switch to Cipher (real data)**. The switch is enabled once phase A is done ("Cipher titles, relations and etymology ready · full text 312 / 1,516 books"); until then it shows the live percentage. Below: [Full tour (4 min)]. | phase A ≤ 60 s | — | where to go next, on his own data |

- **The full tour.** The 10 steps of SPEC §9.7 run from the same `tour.json`. The phone versions of its steps:
  - step 3's "`E` twice" becomes tapping the Evidence chip twice;
  - step 5's `L` becomes the Lanes chip;
  - step 7 becomes a ruler brush;
  - step 9's `G`/`N`/`S` become the mark menu's Lineage and Annotate, and More → Save view.
- **Launch arguments** (DEBUG and UI tests): `-tour`, `-tourStep n`, `-ui-testing` (deterministic: no Cipher bootstrap), `-corpus cipher`, `-strand <word>`, `-renderer canvas`, `-perf`, `-selftest <suite>`, `-atlasRoot <name>`, `-fakeThermal 0|1|2|3`, `-fakeLowPower`. The last two use LabKit's argument names and install `DeviceConditions.setOverride`.

### 4.18 Empty, loading, error and low-evidence states

| State | Phone presentation |
|---|---|
| Empty search | In the sheet, computed: "No occurrences of 'hacker' in the loaded corpus (68M tokens of full text to 1928; 94,385 titles). With the plural variant: 1 title — Hackers (film, 1995). 0 is an observation about this index, not about culture." Then variant chips, the etymology entry or "no family in roots data", romanised matches, and "STEMM pack not on this phone" when that applies. |
| Loading tiles | Lane skeletons with "counting… 41%" and preliminary counts. The previous tier stays drawn, dimmed 40%, until the new tiles arrive; never interpolated, and **never a spinner without a number**. |
| Pending collection | The sparse-dot underlay and "indexing — not yet looked". |
| Engine error | An opaque card with the message, the hint and **Retry**. An interrupted read (the 5 s deadline) suggests "Narrow the range or the lanes". The selection is never lost. |
| Low evidence | Gate cards and `low` bins; never a numeral for a gated measure. |
| Integrity failure (boot check) | A full-screen card, e.g. "3 originals missing from this phone's atlas", with **Rebuild from packs** and **Open read-only**. |
| SQLite probe mismatch | A full-screen card (§1.4); nothing is changed. |
| Storage full | The Storage page opens, rebuildable items first. |
| Thermal pause | The status chip shows "paused: phone is hot" and resumes by itself. |
| Replay waiting for a pack | The banner "Restoring your notebook: 28 of 40 actions applied; waiting for the STEMM pack". |

### 4.19 Accessibility

- **The Scroll for VoiceOver** (`ScrollAccessibility`, N7):
  - one element per lane, with the generated summary ("Lane Classroom · text: 'carry the zero' observed 1905–1939 and 1950–1960 in 2 bars; gap 1940–1949: no sources (archive gap, synthetic).");
  - child elements per bar and per gap, in time order, **filtered by the vantage predicate**;
  - **custom rotors** for Bars · Gaps · Arcs · Marks · Seams (`accessibilityRotor`);
  - the playhead as an **adjustable** element ("as of 1925"; swiping up or down steps one bin);
  - actions: Play, Step, Strict or context, Open bin drawer;
  - **Magic Tap** = Play or Pause; **Escape** (two-finger Z) = clear the selection or lower the sheet.
- **Audio Graphs.** Each lane provides `accessibilityChartDescriptor`. x is the bin's midpoint year and y the rate in the lane's unit. The series has `isContinuous: false`: only observed bins are data points, so **the audio never bridges a gap**. Absent, low and uncovered bins are described in the summary.
- **The table alternative** (More → Table, or `T`) is `ScrollTableView`: a `List` grouped by lane, one row per bin ("1910s · 14 · 367 per million [201–616] · 38k tokens · observed · single source"). It is built from **the same `LaneSeries` arrays** the renderer uses; the identity test is in N7.
- **Dynamic Type.**
  - Chrome over the Scroll (TopBar chips, lane chips, pills, transport) caps at `.accessibility1` and offers the Large Content Viewer (LabKit's `stageChromeTypeCap`).
  - Sheets, passages, cards and Compare are uncapped.
  - At accessibility sizes, Then/Now/Next becomes one vertical scroll with section headers, and the peek detent grows to fit.
- **Other settings.**
  - Reduce Motion: §4.6.
  - Reduce Transparency makes the glass opaque (system); the ribbon keeps its stripes.
  - Increase Contrast raises hairlines and swaps `ink-3` for `ink-2`.
  - Differentiate Without Colour: §4.7.
  - Bold Text is honoured.
- **Hit targets** are ≥ 44 pt everywhere, except marks, which use the tolerance and the chooser.
- **Copy.** Every UI string lives in `ScrollsCore/Copy.swift` (generated from vocab, byte-equal) or in the app's `Localizable.xcstrings` (British English as the source). `CopyLintTests` check:
  - LabKit `CopyLint.americanSpellings` over the app's own strings (copy ported from vocab is byte-equal to the reference; a spelling fix there is an RF);
  - Scrolls' `MENTAL_STATE_VERBS` and forbidden phrases ("thought", "felt", "intended", "meant to", "wanted", "believed"; "meaning changed", "coined", "born").
- **`AccessibilityAuditTests`** run `performAccessibilityAudit` on the root, the inspector at each detent, Compare, Lineage and the Notebook.

### 4.20 Typography, including Devanagari and Gujarati

- **UI:** SF Pro, with `.monospacedDigit()` for counts. **Numbers in tables:** SF Mono.
- **Passages:** New York for Latin script, at Dynamic Type `.body` (17 pt), line height 1.6, ≈ 45 characters per line at 430 pt. New York has **no Devanagari or Gujarati glyphs**, so passage text uses a `UIFontDescriptor` **cascade list**: New York → Kohinoor Devanagari → Kohinoor Gujarati → the system fallback.
- **Line height by script.** A passage whose `lang_text` is `hi` or `gu`, or whose text is mostly Indic, gets line height 1.8, to leave room for vowel signs above and below the line, and `.body` + 1 pt.
- **The M0 probe** confirms that the Kohinoor faces exist on the device; if one is missing, the system cascade is used and recorded.
- **Tests:**
  - `IndicTypographyTests` render a Hindi and a Gujarati passage in TextKit 2 and assert **no `.notdef` glyph** (`CTRunGetGlyphs` ≠ 0) and **no clipped line fragment** (fragment height ≥ ascent + descent).
  - The same test runs on KWIC rows and on lane chips ("हिन्दी · text", "ગુજરાતી · text").
- **The Metal label atlas** stores **shaped label runs** (whole `CTLine`s rendered with the cascade), not single glyphs. Devanagari and Gujarati conjuncts need shaping, so a per-glyph atlas would draw them wrongly. `LabelAtlasTests` render the Indic lane labels and compare them with a Core Text reference raster.

### 4.21 Haptics (LabKitFeedback `HapticEngine` + `HapticTap`; transients only; no hum, no sound)

| Event | Tap | Why |
|---|---|---|
| Tier change while pinching | `.detent` | zoom has detents, like a knob |
| The vantage steps one bin (scrub or Play) | `.tick` (`Throttle` ≤ 30/s) | time advancing |
| The vantage enters a stretch with no coverage | `.soft` | an honest "nothing here" |
| Modality seam crossed; pan hits the domain edge; pinch into the folded overview | `.boundary` | a change of medium or regime, not of meaning |
| A feedback halo appears | `.ripple` | a later work re-reads an earlier one (an event, never a magnitude) |
| A mark or edge is selected | `.select` | — |
| A review recorded, a view saved, a pack loaded | `success()` | — |
| A gate card is shown | **none** | a refusal is information, not an error buzz |

- **A hard rule:** **no haptic encodes a data magnitude.** Nothing scales with a count, a rate or a score.
- Haptics stop when the app is not active (LabKit `setActive`).
- The strength slider lives in How Scrolls works → 08 (`FeedbackSettings`). Sound is off and has no UI.

### 4.22 Liquid Glass and LabKit

- **Glass:** TopBar chips, the status chip and More, the inspector at partial heights, the transport capsule, coach marks, pills and toasts, lane chips (on the header strip only), the constellation's legend bar and system context menus.
- **Opaque:** the Scroll's data plane, passage text, the Then/Now/Next bodies, gate cards, edge cards, Compare panels and the import mapping table.
- **Tint** is reserved: cyan for selection and navigation only.

| LabKit piece | Adopted? | Use in Scrolls / why not |
|---|---|---|
| LabKitFeedback: `HapticEngine`, `HapticTap`, `.labHaptics`, `FeedbackSettings` | **yes** | the haptic map above; the same feel as Gyre, Loom and Rheo |
| LabKitCore: `DeviceConditions`, `FramePacing`, `Throttle`, `CopyLint` | **yes** | job throttling (bridged into `DeviceConditionsSource`), the 60 fps cap, the haptic throttle, the British-spelling lint |
| LabKitUI: `StatusBanner`/`StatusBannerHost` | **yes** | tier, gap and seam pills; toasts |
| LabKitUI: `ChoiceChips`, `GlassToggle` | **yes** | lanes, filters, the evidence filter ("chips, never a menu that hides the choice") |
| LabKitUI: `LabInfoSheet`, `FieldNote`, `SourceList`, `InfoRow`, `LegendRow` | **yes** | **How Scrolls works**, in LabKit's fixed order: <br>01 What you're looking at · 02 Touch · 03 What you're seeing (the encodings, with drawn swatches) · 04 Controls · 05 Presets · 06 What's documented, computed and proposed (+ synthetic) · 07 On this phone (packs, generations, storage) · 08 Sound & feel · 09 Sources & licences (every licence and attribution of §13.15) |
| LabKitUI: `GlassKnob` | **one** | the play-speed knob, the only continuous control |
| `LabPalette` | **a Scrolls value** | `LabPalette.scrolls` is built in the app from the SPEC §8.7 tokens (signature = cyan) and applied with `.labPalette(.scrolls)` |
| LabKitUI: `.labChrome(_:)` | no | it hides the status bar and applies the phosphor palettes |
| LabKitCore: `Provenance` / `ProvenanceBadge` / `ProvenanceLegend` | **no** | "measured, modelled, live, simulated, illustrative" must never sit next to documented / computed / proposed (I3) |
| LabKitUI: `CanvasRegion` | no | it is one accessibility element with raw touches; Scrolls needs recognisers, rotors and many elements |
| LabKitUI: `KnobConsole`, `LabTopBar`, `TelemetryCard`, `LabPlot` | no | Scrolls is not a parameter toy; `LabPlot` offers log axes, which D3 bans for time (Compare uses Swift Charts) |
| LabKitRender, LabKitSensors, physics | no | the renderer runs continuously and adds bloom, EDR and scanlines; an instrument must be crisp and draw zero frames at rest. No sensor is needed; the thermal fakes reuse LabKit's argument names. |

The dependency is declared as `packages: LabKit: { path: ../../LabKit }`. `Tools/build.sh` mirrors LabKit beside `Scrolls/` (Rheo's pattern). Products used: `LabKitCore`, `LabKitFeedback`, `LabKitUI`.

### 4.23 Rendering the Scroll

**The decision.**
- The data plane is **Metal** (`MTKView`, drawn on demand) in the `ScrollsRender` target.
- Chrome is SwiftUI.
- **`DisplayListCanvas`** (SwiftUI `Canvas` drawing the *same* `DisplayList`) is:
  1. the **fallback renderer** from day one (`-renderer canvas`; ≤ 60 Hz; it steps to a coarser tier sooner);
  2. the **snapshot renderer** (`ImageRenderer` → PNG);
  3. the bounded canvases' drawing code (lineage, genealogy, constellation).

**The pipeline.**

```
LiveAtlas.tiles/marks/arcs ─▶ DisplayBuilder.build(input)  (@concurrent; ≤ 12 ms p95 for 20k cells)
                               ─▶ DisplayList (content space: x in days relative to originDay; y in lane-stack points)
                                  ├─▶ ScrollRenderer.install(list)   ring of 3 instance buffers; swap on the next drawable
                                  ├─▶ DisplayListCanvas → ImageRenderer → PNG    ·  SVGWriter → SVG
                                  ├─▶ LaneSeries → ScrollTableView, Audio Graphs, tap sentences
                                  └─▶ HitGrid (24 pt cells, content coordinates)
```

**The vantage, tied to the reference.**
- `display.mjs` `gate()` drops every primitive whose `hiDay > vantage.day` in strict mode and marks it `ghost` in context mode. Ghosted primitives stay hit-testable in the reference; hidden ones do not exist.
- On the phone, `DisplayBuilder` builds the list **once, without a vantage**, and stores `revealDay = hiDay` in every primitive. `ScrollsScrollModel` defines the predicate once:

  ```swift
  public enum VantageMode: Sendable { case strict, context }
  public struct Vantage: Sendable, Equatable { public var day: Int32; public var mode: VantageMode }
  public enum Visibility: Sendable { case show, ghost, hide }
  public func visibility(revealDay: Int32, at v: Vantage?) -> Visibility      // == display.mjs vantageState
  extension DisplayList { public func visible(at v: Vantage?) -> DisplayList } // == buildDisplay(…, {vantage}) minus `simplified` (DV-7)
  extension HitGrid { public func hit(_ p: CGPoint, tolerance: CGFloat, vantage: Vantage?) -> [PrimRef] }   // hides `hide`, keeps `ghost`
  ```

- The shader implements the same predicate from `revealDay` and the uniforms. G5 compares `visible(at:)` with Node across a vantage sweep, and G8 compares Metal and Canvas at several vantages, so the uniform path is differentially tested.
- VoiceOver's elements and rotors filter through `visibility`.

**Why Metal.**
- Core Graphics fills 20,000 rects in 82–115 ms at 1290 × 2796 px (measured): 10–14× over the 8.33 ms frame.
- Pinch is x-only, with constant stroke widths, dash lengths and glyph sizes. A Core Animation layer transform would stretch them.
- Metal does x-only zoom in the vertex shader while the instance buffers stay unchanged.

**One render pass, seven instanced draws, in z-order:**
1. bands (banding, coverage underlay, hatch, dot and period patterns, the seam);
2. washes;
3. bars and ticks (rounded-rect SDF with analytic antialiasing via `fwidth`; sparse outline; stripes; the synthetic overlay);
4. diamonds and work marks;
5. arcs (quadratic Béziers tessellated to 24 segments in the vertex shader, dashed by cumulative arc length);
6. glyphs and labels from the **`LabelAtlas`** (shaped `CTLine` runs at 3× in an R8 2048² texture, LRU, ≈ 4 MB);
7. the overlay (playhead, selection glow, brush, focus ring).

- Patterns are computed in screen space (`pitch = 6 pt × contentScale`), so a hatch never stretches under zoom.
- The pixel format is `bgra8Unorm` with sRGB-encoded tokens, and there is no MSAA.
- Instance days are stored relative to `originDay` (the viewport centre at build time), so a `Float` keeps sub-day accuracy at 40 pt/day across ±4.4 M days.

**When frames are drawn.**
- `MTKView.isPaused = true`.
- A `CADisplayLink` (`preferredFrameRateRange` 80–120, preferred 120) runs only during a gesture, momentum, Play, a fade, or the 250 ms pan to a selection.
- A data or selection change otherwise draws exactly one frame.
- `FramePacing` caps the rate at 60 under Low Power Mode or thermal `.serious`.
- `Info.plist` sets `CADisableMinimumFrameDurationOnPhone = YES`.

**What rebuilds what.**

| Change | Work |
|---|---|
| pan; pinch within a tier; lane scroll; scrub; Play; strict/context; selection | uniforms only (≤ 0.1 ms CPU) |
| tier crossing | tiles for the new tier → `DisplayBuilder` off main → swap; the old tier stays drawn at 40% until then |
| filter, lanes, strands, evidence filter, layers | a new query key → tiles → build → swap |
| a pan beyond the prefetched ±1 viewport | tiles for the new range, prefetched during momentum by velocity × 0.5 s |

**Budgets** (A17 Pro, 1290 × 2796 px, 120 Hz). These are **device acceptance criteria**, measured by `-selftest perf` with `os_signpost` and by an `XCTOSSignpostMetric` UI test:

| Item | Budget |
|---|---|
| Main-thread time per gesture frame (recognisers → uniforms → encode) | ≤ 1.0 ms p95 |
| GPU time per frame at maximum load (20k bar/tick instances + 4k marks + 300 arcs + 150 labels) | ≤ 3.0 ms p95 |
| Hitches during a scripted 10 s pan + pinch + momentum session | < 1 ms/s, and no single hitch longer than one frame |
| `DisplayBuilder` for 20k cells, off main | ≤ 12 ms p95 |
| Tier change → first paint | warm ≤ 33 ms; cold ≤ 150 ms |
| Tap → selection drawn and inspector content requested | ≤ 16 ms; passage text in the sheet ≤ 50 ms |
| Cold launch → first frame with demo data | ≤ 1.0 s |
| Idle | 0 frames; < 1% CPU |
| Renderer memory | ≤ 24 MB |
| Labels per frame | ≤ 150 |

If a viewport's list would exceed a budget, `DisplayBuilder` steps to the next coarser tier and returns `simplified` (the "Simplified" pill), as SPEC §8.3 says. The budget is counted over ungated primitives (DV-7).

**`PerfHUD`** (`-perf`) shows the p50 and p95 of main-thread frame time and GPU time (`MTLCommandBuffer.gpuStartTime`/`gpuEndTime`), the instance counts, the tier and the rebuild cause. Signposts are also written to `Documents/Diagnostics/last-run.json`.

---
## 5. Performance on the A17 Pro: budgets and how each is bounded

**Planning factors** until N0's device bench replaces them, against an M1 Max: single-thread ≈ 1.0–1.2× a performance core; multi-thread ≈ 0.4× (2 performance + 4 efficiency cores); sustained ≈ 0.6–0.7× after 2–3 minutes of load. "Reference" figures come from HANDOFF and were measured at load averages of 300–1,000. A row's **proxy** says where it may be checked before the device: `mac` (CPU-time scaling) or `sim` (function only). Every row in this table passes **only on the device**.

| Operation | Reference / measured on the Mac | Phone budget | Bounded by | Proxy |
|---|---|---|---|---|
| FTS term or phrase count | 0.2–5 ms (measured) | ≤ 10 ms warm, ≤ 60 ms cold | contentless FTS5 `detail=full` | mac |
| Typeahead (`label_tri`) | 0.4–0.8 ms (measured) | ≤ 5 ms | trigram, `LIMIT 20` | mac |
| Search endpoint (suggestions + 20 KWIC rows) | budget 120 ms | ≤ 150 ms | ≤ 20 chunk decodes at ≈ 50 µs | mac |
| Romanised candidates ("shunya") | — | ≤ 30 ms | the `vocabularyKey` artefact, cached per `data_version` | mac |
| Materialise a new word (*bank*: 988 documents, 8.5k candidate passages) | 1–14 s; reads whole books | **≤ 1.5 s** | only the candidate chunks; `TokenInterner`; a TaskGroup over documents | mac |
| Very frequent word (> 300k matches) | streaming worker | ≤ 3 s | `fts5vocab` instance counts plus a stratified sample (≤ 200 per lane and decade) | mac |
| Slice cube build | cached file 12–14 MB | ≤ 0.8 s once per inputs key | mmap'd columnar file in Caches | mac |
| Tiles, one viewport | warm ≤ 80 ms; cold p95 618 ms | **warm ≤ 16 ms, cold ≤ 120 ms** | cube + `expr_doc` numerators (4–5 ms measured) | mac |
| Marks (≤ 4,000) · arcs (≤ 300 + bundles; *gene* 21,490 links) | budget ≤ 150 ms | ≤ 40 ms · ≤ 150 ms | SPEC §1.6/§1.8 caps | mac |
| Term trail, first query | ≈ 9 s cold | ≤ 1.5 s | member cubes prewarmed after launch | mac |
| Compare (coverage, frequency, passages, collocates, gates, 1,000 bootstrap draws) | — | first panel ≤ 150 ms; all ≤ 1.5 s | cube; slice scans of the token streams; f64 bootstrap | mac |
| Collocations, first time per language | — | token-stream job 10–25 s once, then 0.2–1 s | u32 token streams, mmap'd, purgeable | mac |
| Clustering (Cipher *bank*) | 46–208 s (Node, loaded) | **≤ 15 s**, cancellable ≤ 500 ms | exact f64 k-means (multi-accumulator), restarts and 30 stability subsamples on a TaskGroup | mac |
| English pooled PPMI–SVD (36.0 M tokens × 37,022 types; 13.9 M non-zeros) | 34–36 s (8 workers) | **≤ 3 min**, peak ≤ 600 MB | co-occurrence in two 256 MB blocks; CSR × dense on a TaskGroup; LAPACK QR/SVD | mac |
| Era slices + Procrustes + 500 controls (drift) | 100 s | ≤ 6 min | the same | mac |
| Global reuse index | off by default on the web | Cipher text ≤ 4 min; Cipher + STEMM ≤ 8 min; peak ≤ 600 MB | per-collection winnowing, then an external merge | mac |
| Targeted trace (13-token span) | ≤ 1.5 s sync | ≤ 1.5 s sync, otherwise a job | FTS phrase + reuse buckets | mac |
| Constellation layout (≤ 150 nodes, 300 iterations) | > 5 s first time per worker | ≤ 300 ms | Fruchterman–Reingold, cached in `layout_cache` | mac |
| Lineage graph (≤ 150 nodes) | — | ≤ 80 ms | bounded expansion | mac |
| Tone (NLTagger) | CLI round trip | 1–3 ms per paragraph; ≤ 2,000 paragraphs per slice (seeded sample) | job | — (device only) |
| Launch → first frame with demo marks | first paint 236–472 ms (web) | **≤ 1.0 s** | starter clone; no database work on the main actor | sim |
| Phase A (Cipher metadata) | 39 s (budget 30 s on the Mac) | **≤ 60 s** (measured switch, §3.6) | 5,000-document commits; label trigrams last | mac |
| Phase A2 | — | ≤ 90 s after launch | — | mac |
| Phase B (68.6 M tokens + boilerplate) | 3,449 s full bootstrap (loaded) | est. 6–10 min; **bound 20 min** | tokenizer 40 M tokens/s; FTS 0.37 s per M tokens; one writer with parallel parse and segment | mac |
| STEMM load | — | est. 10–20 min; **bound 40 min** | the same | mac |
| Journal append (fsync) | — | ≤ 10 ms p95 | one line + `fsync` | — (device only) |
| Generation swap after transfer | — | ≤ 30 s plus the replay of new journal entries | rename; sha256 at ≈ 300–600 MB/s | — (device only) |
| 50 MB CSV dry run | ≤ 10 s on the Mac | ≤ 20 s | streaming parse | mac |
| UI while analysis runs | p95 health < 50 ms; tiles < 300 ms | during *bank* clustering plus the English space build: no main-thread hitch longer than 1 frame; tiles p95 ≤ 120 ms | reserved reader; jobs at `.utility` or below | — (device only) |

`os_signpost` covers every job phase and every `AtlasService` call. A Scrolls Instruments template ships in `Native/Tools/Scrolls.tracetemplate`. `scrolls-cli bench` produces the Mac proxies. The device numbers go into VERIFICATION per milestone.

---

## 6. Persistence of user state

### 6.1 Decision: the atlas's own SQLite tables, plus a write-ahead journal. No SwiftData.

SwiftData is rejected for six reasons:
1. D17, D18, I3 and the append-only revisions are enforced by **triggers and CHECKs**, which SwiftData cannot express.
2. As-saved reads join revision-id cutoffs with the evidence tables in one SQL statement (`arcs.mjs`, `graph.mjs`).
3. Annotations need FTS5 (`annotation_fts`).
4. A review is **one** transaction: an annotation, a `relationship_revision` row and `review_status`.
5. CloudKit merge semantics contradict append-only history.
6. The CLI and the differential tests need the same store.

Cipher keeps SwiftData for itself; Scrolls shares nothing with it. Per-viewer conveniences go to `@AppStorage`: tour dismissed, density, play speed, *Build analysis artefacts automatically*.

### 6.2 The journal (platform's design, adopted over the engine's debounced export)

- **Files.** `Application Support/Notebook/journal-NNNNNN.jsonl`, rotated at 32 MB and **backed up**.
- **Lines.** One canonical-JSON object per line: `{seq, at, actor, op, crc32}`. The CRC covers the canonical JSON of `{seq, at, actor, op}`.
- **The write protocol (write-ahead)**, in `UserWrites.perform`:
  1. Append the line and **`fsync`**.
  2. Run the atlas transaction that applies the op. In the **same** transaction, insert its `journal_applied` row (`max_ids_json`: the largest id created in each log table) and set `meta.journal_applied_seq = seq`.
  3. Return.
- **At launch,** lines with `seq > meta.journal_applied_seq` are re-applied; applying is deterministic and idempotent by `seq`. A torn last line fails its CRC and is truncated. **The atlas never holds user rows that the journal lacks.**
- **What is journaled.** Every operation that creates `import_batch`, `relationship_revision` or `annotation_revision` rows, or that the user started. The set is frozen by `JournalPolicyTests`: they run every job type on the demo and fail if a job writes those tables without being journaled. The ops (frozen in N0's `JournalTypes.swift`):

```swift
public enum JournalOp: Codable, Sendable, Equatable {
  case sourceLoad(SourceLoadOp)                    // pack name + sha256, adapter id + version, phase, params, slot; auto ops have actor "scrolls"
  case adapterEnable(adapter: String, enabled: Bool)
  case importCommit(ImportCommitOp)                // original sha256 + Notebook/originals path, mapping, options, collection spec
  case importRevert(BatchKey)
  case trackExpression(ExprKey, TrackExpressionRequest)
  case setVariants(ExprKey, VariantsPatchRequest)
  case annotationCreate(AnnotationCreateOp)        // targets as stable keys; anchors per D18
  case annotationRevise(AnnotationKey, AnnotationPatchRequest)
  case annotationReinterpret(AnnotationKey, AnnotationCreateOp)
  case annotationWithdraw(AnnotationKey, reason: String)
  case relationshipPropose(RelationshipProposeOp)  // origin = human ⇒ proposed (trigger)
  case relationshipReview(RelKey, ReviewRequest)   // confirm | reject | dispute, note ≥ 10 characters
  case relationshipEvidence(RelKey, EvidenceRequest)
  case hypothesisGroupCreate(HypothesisGroupCreateOp)
  case dimensionDefine(DimensionDefOp)
  case clusterLabel(ClusterKey, label: String)     // stored as a label annotation, as in the reference
  case runCommit(RunKey, stage: Stage, params: JSONValue)   // runs that write evidence or revision rows (reuse-index, trace, …), and runs he started
  case viewSave(SaveViewRequest, portable: PortableCutoffs)
  case viewDelete(slug: String)                    // soft
}
```

- **Backup.** The atlas (≈ 2.8 GB) is excluded from backup, and `Notebook/` (journal + user import originals, usually ≤ 50 MB) is included.
- **The notebook export** (share sheet) is the journal plus every revision, as JSONL with the manifest. A fixture checks that the web build can read it back.

### 6.3 Stable keys (how a journal op finds its rows in any generation)

| Key | Definition |
|---|---|
| `DocKey` | `collection slug : ext_id` (UNIQUE in the DDL) |
| Passage and occurrence targets | the **D18 anchor** `{doc key, original_sha256, field, start, end, quote, prefix, suffix}` |
| `BatchKey` | `(collection slug, file or pack sha256, adapter id, ordinal)` |
| `RelKey` | documented: hash of `(rel_type, src key, dst key, source_dataset, source_locator)`; computed: `(RunKey, src anchor, dst anchor)`; human: the `seq` of its proposal |
| `RunKey` | `(stage, params_hash, input_fingerprint, code_hash)` — the reference's reuse rule plus the code hash |
| `ExprKey` | `(kind, lang, norm, corpus slug)` |
| `AnnotationKey` | the `seq` of its `annotationCreate` |
| `ClusterKey` | `(RunKey, cluster ordinal)` |

### 6.4 D17 across generations: portable cutoffs

**At save**, `viewSave` stores the reference's numeric cutoffs in the immutable `saved_view` row: `max_import_batch`, `annotation_rev_cutoff`, `relationship_rev_cutoff` and `run_ids_json`. In `saved_view_portable` it also stores:

```swift
public struct PortableCutoffs: Codable, Sendable, Equatable {
  public var generation: String                  // meta.generation at save
  public var journalSeq: UInt64                  // this viewSave op's own seq; "before the view" = seq < journalSeq
  public var runKeys: [String: RunKey]           // each run id in run_ids_json → its RunKey
  public var strands: [String: ExprKey]          // "e12" → ExprKey
  public var selection: PortableSelection?       // occurrence: (ExprKey, D18 anchor) · cluster: ClusterKey · passage/document/relationship: their stable keys
  public var packs: [String]                     // sha256 of every pack installed before the save (a cross-check)
}
```

**At open**, `ViewCutoffResolver` (N6) picks the cutoffs:
- **In the generation where the view was saved,** the `saved_view` numbers are used, exactly as in the reference. A test asserts that the resolver recomputes the same numbers there.
- **In any other generation,** every numeric cutoff is recomputed. For each cutoff table `T` (import_batch, annotation_revision, relationship_revision):
  - `cutoff'(T)` = the maximum of `max_ids_json[T]` over the `journal_applied` rows with `seq < journalSeq`, together with `meta.base_max_ids[T]` (the starter).
  - Every generation is a replay of the same journal in `seq` order, and only journaled ops create rows in these tables (§6.2). So the rows created "before the view" are exactly a **prefix** of each table's id order, and `id <= cutoff'` selects exactly them. **As-saved counts are therefore identical.**
  - Each pinned run is found by its `RunKey`. A missing one is recomputed (same parameters and inputs give the same result; the evidence stages are deterministic, analysis stages within §2.4), and the view shows *"pinned analysis being restored (run #14 → job 302)"* until the recomputation lands.
  - The strand, selection and run ids in the stored state are remapped through the portable keys. The banner says *"Saved on generation 3; opened on generation 4: ids remapped, counts as saved"*.
  - **Nothing is silently re-pinned, and "as-saved unavailable" is never shown.**

Tests (N6 with N2):
- save a view → load STEMM → as-saved counts unchanged (the engine's dedicated D17 test, adapted);
- save a view → swap to a CLI-built generation from the same journal → as-saved counts unchanged and the remap banner shown;
- save a view → simulated restore from backup (delete the atlas, keep `Notebook/`, rebuild) → unchanged;
- save a view → engine-version rebuild → unchanged.

### 6.5 Replay, anchors and restore

- **`JournalReplayer.replay(into:after:)`** (N6) applies ops **strictly in `seq` order**, through the same service code paths as live writes. It produces a `ReplayReport {resolved, reanchored, orphaned, waiting}`.
- **Anchors resolve** through `DocKey`, then `original_sha256` + offsets, then a quote search inside the document with prefix and suffix (the D18 algorithm, `anchors.mjs` ported). An act whose anchor no longer resolves stays in the atlas as an **orphaned interpretation**, listed in the Notebook with its quote and the reason. It is never dropped.
- **A missing input blocks the rest of the replay.** If an op needs a pack or an original that is not on the phone, replay stops there with a named reason, and the generation opens read-only behind the waiting banner (§4.18). Skipping it would break the prefix property that D17 relies on.
- **Restore from backup** works in three steps: starter → replay (bundled Cipher packs load on the phone) → wait for STEMM if the journal names it. Alternatively, `Tools/atlas.sh pull-notebook` and a CLI build give the same generation, which is then pushed and swapped.

### 6.6 Self-test isolation (closes the gap "device self-tests would write into his notebook")

- **`-atlasRoot <name>`** points `AtlasLocation` at `Application Support/SelfTest/<name>-<run>/` with its own `Atlas/` and `Notebook/`. Every device suite runs with it. There are two modes:
  - `-atlasRoot selftest` APFS-clones the live atlas **read-only** as the starting state and gives it an empty journal;
  - `-atlasRoot selftest-fresh` starts from the bundled starter (the first-minute suite).
- **`SelfTestIsolationTests`** assert that after any suite the live `Notebook/` journal head and the live atlas's `meta.data_version` are unchanged.
- **The selftest root is deleted** after `device-check.sh` pulls `result.json`.
- **A visible banner** ("Self-test running in an isolated copy") is shown during the run.

### 6.7 Persistence tests (N6, with N0 for the journal format)

Persistence tests:
- crash injection between the journal append and the commit, at 6 kill points;
- a torn last line;
- 30 scripted notebook operations replayed into a rebuilt generation, giving identical user-visible responses;
- D17 as in §6.4;
- D18 re-anchoring after re-segmentation;
- trigger tests through `AtlasService` (UPDATE/DELETE of revisions and views abort; a re-save makes `slug~2`);
- force quit → reopen byte-identical (`state_hash`), on the device;
- notebook export read by the web build.

---

## 7. Risks, cuts, and the v1 boundary

### 7.1 Risks

| # | Risk | Likelihood · impact | Mitigation | If it happens |
|---|---|---|---|---|
| R1 | Tokens, fold or sentences diverge between JS and Swift, or between macOS and iOS | low (measured) · high | §1.7 rules; G1 exact; the M0 device parity probe | Block M0 until fixed |
| R2 | Float and RNG differences | certain at ulp level · low | exact paths in f64 in reference order; tolerances only where §2.4 declares them | — |
| R3 | Port scope (≈ 40k reference lines) slips | high · high | the read path ported against the reference snapshots before any Swift ingest exists (G3 via `InlineTextStore`); `MockAtlas` keeps the UI moving; the phone runs at every milestone | Cut along §7.3, never an honesty rule |
| R4 | Main-thread stalls from `nonisolated(nonsending)` defaults | medium · medium | §1.2 rule 2; `EngineAssert.offMain()`; the UI journey with the assertions on | — |
| R5 | iOS SQLite differs from the SDK's | low · high | the probe refuses to open | A vendored amalgamation as a C target: one third-party file, **needs his approval** |
| R6 | Jetsam or the VM limit during heavy jobs | medium · medium | §3.8 budgets; `MappedFileRegistry`; admission control | Smaller blocks (slower, same output) |
| R7 | Heat and time on long builds | medium · medium | §3.7 throttle; 5,000-document checkpoints; continued processing; the measured switches (§3.6) | the CLI-built generation from the same journal |
| R8 | Expiry of `BGContinuedProcessingTask` | medium · low | the stall rule; chunked commits; resumable jobs | resumes when active |
| R9 | Metal renderer effort (patterns, antialiasing, labels, hit testing) | medium · high | `DisplayBuilder` and G5 land first; `DisplayListCanvas` runs from day one | ship the Canvas renderer at reduced budgets |
| R10 | D17 broken by a load or a generation | high if naïve · high | §6.4, with dedicated tests | — |
| R11 | Contract drift while the reference changes | medium · medium | the freeze; serialised goldens; the rebase protocol (§2.1) | — |
| R12 | Agent build contention on a loaded Mac | high · medium | per-agent persistent mirrors; per-target builds; `-j 4`; timings measured at M0 | serialise app builds through the integrator |
| R13 | The device is not available when agents need it | high · low | `PENDING_DEVICE`, sim/mac proxies, batched device sessions | — |
| R14 | Licensed text leaks into git | low · high | §2.6 redaction plus `FixtureLicenceTests` | revert and rewrite the history of the fixture path |
| R15 | Collation differs from `localeCompare` | medium · low | DV-4 measured at M1 | an exported collation table |

### 7.2 Open findings of the reference → decisions for the port (none are frozen in silently)

| Finding (HANDOFF) | Decision |
|---|---|
| English denominators include 'und' passages of es/fr books (high) | **RF-1**: fixed in the reference before the goldens freeze |
| As-saved views: the inspector counts and Compare read current data | **RF-2**: fixed in the reference before the M1 goldens |
| Title Case scientific names excluded as names (low) | Ported as is: it is a policy with a user override (the names toggle, per-match overrides). Recorded in `Native/Docs/REFERENCE-CHANGES.md` as "known, by design in v1". |
| Translation flag on Hugo's *Le Dernier Jour…* (low) | A data issue; ported as is |
| Source byte ranges missing for relation endpoints and Wiktionary entries (low) | Ported as is. The metadata is kept verbatim, so "Original record" works without pointers. |
| Double-BOM offsets in databases loaded before the fix | Absent from the fresh snapshots (RF-4). Swift implements the fixed behaviour; G2 covers both double-BOM books. |
| Duplicated demo relationship groups and ItwoFS coincidence links in m5-stemm | Absent from m5r (RF-4) |
| Analysis jobs take the writer slot | Fixed by the port's design (ΔS-2); no output changes (DV-8) |
| One as-of stop per day | Fixed on the phone (ΔS-12) |
| A Term trail's constellation defaults to 2020–2029 | Fixed on the phone (ΔS-13) |
| `/?selftest=journey` not built | Replaced by `-selftest journey` (§2.7) |
| Search and the Term trail count different units | By design; both say their unit |
| A mark under an emergence tick loses hover to the tick | On the phone, the ambiguity chooser lists both |

### 7.3 v1 vs later

| Area | v1 (this port, in milestone order) | Later (stated as unfinished in HANDOFF) |
|---|---|---|
| **M1 vertical slice on the phone** | the demo (instant); Cipher phases A/A2 in the first minute and B in the background; TXT/MD/CSV/TSV/JSON/JSONL import with the wizard and Revert; search (expressions, works, makers, themes, romanised Indic); the Scroll (linear axis, tiers, bars, washes, shelves, coverage, seam, minimap, playhead, Play, Reduce Motion, VoiceOver, table alternative); Then + reader; Compare (coverage, composition, modality, prominence, frequency, passages, collocates, gates, multiplicity); saved views (immutable, as-saved, portable); JSON/JSONL/CSV + PNG exports; state restoration; the journal | PDF/EPUB import; multi-user |
| **M2 full corpus and lineage on the phone** | the STEMM pack loaded on the phone; generations and swap; G6 phone = Mac; the boilerplate pass; the global reuse index on the phone; near quotes; cues; targeted trace; the Lineage explorer with hypothesis groups and chain of custody; Genealogy; review actions; arcs, feedback and date conflicts; Term trail (C2), share cells (C3), arc summaries (C4); etymology bands, claims, baseline; the folded overview; SVG export | cross-language reuse; MusicBrainz full chains and date recovery |
| **M3 analysis on the phone** | TF-IDF-hash fallback; pooled PPMI–SVD spaces built on the phone; spherical k-means with stability, labels, transitions and convergence; cluster lanes and ⑂/⑃; era slices, Procrustes and drift; tone and modern-reader neighbours (with availability gates); the constellation (overlay); the full notebook (layers, dimensions, revisions, as-of by revision, compare interpretations); Now/Next + hypotheses; Crossings | the constellation's *split* mode; a sense-level external baseline; tone beyond Apple's on-device languages |
| **M4 polish** | the full tour; landscape polish; the accessibility audit; perf budgets on the device; Diagnostics; HANDOFF | App Intents / Action button, Spotlight for saved views, widgets |
| **Data-format levers** | — | S3 hot-key-preserving meta slimming (−218 MB, with a reader census test); dropping `date_rtree` and `passage_time` (−90 MB, a SPEC amendment behind the SQLCatalog plan test) |
| **Sharing** | links, `.scrollsview`, PNG/SVG/JSON/CSV, the notebook export | the portable HTML bundle (ΔS-14); universal links (needs a domain); a share extension (document types cover Open in Scrolls); iCloud sync of the atlas |
| **Platforms** | iPhone | iPad, Mac Catalyst |
| **Never** | — | automatic irony or stance detection; the Foundation Models framework for any annotation; a single "meaning score"; feedback or influence from similarity; lyrics of real songs |

### 7.4 Every judged flaw and gap → where this spec fixes it

| Flaw or gap (judges) | Fix |
|---|---|
| Engine: vectors, drift and reuse built on the Mac by default, against his "all on the phone" | N-02, N-10, §3.6 (derived builds on the phone, auto by default), §5 budgets |
| Engine: thin first minute (relations and books need a Mac pack) | Bundled `cipher-meta` + `cipher-text` packs; phases A/A2/B on the phone (§3.6, §4.17) |
| Engine: "snapshot equals screen by construction" unproven | `DisplayListCanvas` snapshots + the G8 Metal-vs-Canvas pixel diff (§2.2, §4.23) |
| Engine: the phone experience delegated | §4 (the experience proposal, adopted and corrected) |
| Engine: per-layer atomic apply vs iOS expiry | No layer apply: generations by replay plus swap (§3.5); the stall rule (§3.7) |
| Engine: the log renumbering remap could miss JSON id columns | No renumbering: generations replay the journal (§3.5, §6.4) |
| Engine: packs cannot express cross-layer updates | Adapters run on the phone through the normal writer (Wiktionary claims attach, recounts trigger as in the reference) |
| Engine: "well under a minute" assumed USB 3 | §3.11: USB 2 assumed; `transfer-bench` measures it |
| Experience Δ3 breaks D17 | Rejected; compact create rows keep their ids (§3.2) |
| Experience presentation stack unbuildable | Custom overlay plus the one-presentation rule (§4.2) |
| Experience fold via `String.lowercased()`; `seg-1i` | NSString fold with a lint ban; NSString sentences; no `seg-1i` (§1.7) |
| Experience vantage uniform not tied to `gate()` | `visibility()` shared by shader, hit grid and VoiceOver; G5 vantage sweep (§4.23) |
| Experience launch stagger | ΔS-8 |
| Experience and platform Δ2 break C3 | Metadata verbatim (§3.2) |
| Platform Δ7 false claim; Δ3 against §5.3 | Rejected (§3.2) |
| Platform: STEMM and spaces Mac-default | On the phone (N-02); the Mac path is recovery and G6 only |
| Platform: search in the top bar; one VoiceOver element; custom glass menu; crowded bottom bar | Search in the peek row; per-lane elements and rotors; `UIContextMenuInteraction`; transport in the peek row (§4) |
| Platform: segmentation left as a spike | Measured rule (§0.2, §1.7) |
| Platform: monolithic engine target | 14 targets (§1.2) |
| Platform: `Gated` as a struct | Enum (§1.6) |
| Platform: k-means BLAS vs f64 contradiction | Exact f64 paths vs tolerance paths declared (§2.4) |
| Gap: presentation under a persistent sheet | §4.2 |
| Gap: Indic typography | §4.20 |
| Gap: typing Hindi and Gujarati | §4.9 |
| Gap: known reference bugs frozen into goldens | §2.1 RF-1/RF-2, §7.2 |
| Gap: licensed text in fixtures | §2.6 |
| Gap: virtual memory | §3.8 |
| Gap: device availability for acceptance | §2.7 `PENDING_DEVICE` and proxies |
| Gap: state restoration | §4.15 |
| Gap: overnight jobs | §3.7 (opportunistic, logged, never relied upon) |
| Gap: stall expiry of continued processing | §3.7 stall rule |
| Gap: self-tests writing his notebook | §6.6 |
| Gap: stale snapshots and boot repairs | §2.1 RF-4; repairs not ported |
| Gap: build throughput for parallel agents | §8.2, N0 measures it |
| Gap: NaturalLanguage availability on the device | §4.10 Tone gate; the M0 probe |
| Gap: transfer time | §3.11 |
| Gap: reference stability during the port | §2.1 freeze, finding protocol, rebase |

---
## 8. Build plan — one reference steward, one foundation, eight parallel packages, an integration package per milestone

### 8.1 Repository tree (owner in brackets; **no file has two owners**)

N0 creates every file below as a **stub** with its final signatures, a `// OWNER: <package>` header, and bodies that throw `ScrollsError.notImplemented(area:)`. A stub then belongs to the package named here. "[I]" is the integrator; "[R]" is the reference steward.

```
Scrolls/                                              iCloud folder; gitdir ~/Developer/git/Scrolls.git
├─ server/ src/ public/ tests/ scripts/ data/ tools/ package.json     [R]  the reference, frozen at ref-freeze-n
├─ README.md · Docs/{SPEC,API,IMPORT-SCHEMA,ANALYSIS-AND-LIMITS,CIPHER-MAPPING,HANDOFF,VERIFICATION,…}.md   [R]
├─ Docs/IOS-SPEC.md                                   [lead]  this file
└─ Native/
   ├─ project.yml                                     [N0]
   ├─ README.md                                       [I]   placeholder (§8.9)
   ├─ Docs/…                                          placeholders (§8.9), owners listed there
   ├─ Reports/                                        any package writes its own *.json; [I] owns milestones/*.json
   ├─ Tools/
   │  ├─ build.sh · gen-buildinfo.sh · golden.sh · check.sh · device-check.sh                      [N0]
   │  ├─ check.d/quick.sh [N0] · slice.sh [N2] · read.sh [N3] · analysis.sh [N4] · lineage.sh [N5]
   │  │         journey.sh [N6] · display.sh [N7] · app.sh [N8] · full.sh [I]
   │  ├─ packs.sh · atlas.sh                          [N2]
   │  └─ Scrolls.tracetemplate                        [N7]
   ├─ Golden/                                         Node generators; read-only imports of ../../server, ../../src
   │  ├─ run.mjs · dump.mjs · validate-contracts.mjs · gen-core.mjs · lib/{clone,manifest,redact,normalize}.mjs   [N0]
   │  ├─ gen-pipeline.mjs                             [N1]
   │  ├─ gen-sources.mjs · slices.mjs                 [N2]
   │  ├─ gen-read.mjs · requests/read/*.json          [N3]
   │  ├─ gen-analysis.mjs · requests/analysis/*.json  [N4]
   │  ├─ gen-lineage.mjs · requests/lineage/*.json    [N5]
   │  ├─ gen-journey.mjs                              [N6]
   │  └─ gen-display.mjs                              [N7]
   ├─ ScrollsKit/
   │  ├─ Package.swift                                [N0]  (a package edits only its own targets' settings, through N0)
   │  ├─ Sources/
   │  │  ├─ ScrollsCore/**                            [N0]  Text/{Tokenizer,TokenClassTable,Fold,TokenInterner,SentenceBreaker}, Dates/**,
   │  │  │                                                  JSONValue, CanonicalJSON, JSNumber, IDs, Mulberry32, Format, EvidenceStyle,
   │  │  │                                                  ViewState, ReferenceCollation, EngineAssert, Vocab (generated), Copy (generated),
   │  │  │                                                  Generated/BuildInfo.swift, Resources/vocab.json
   │  │  ├─ ScrollsContracts/**                       [N0]
   │  │  ├─ ScrollsStore/**                           [N0]  except Pack/** [N2]
   │  │  ├─ ScrollsJobs/**                            [N0]
   │  │  ├─ ScrollsIngest/**                          [N1]
   │  │  ├─ ScrollsSources/**                         [N2]
   │  │  ├─ ScrollsQuery/**                           [N3]
   │  │  ├─ ScrollsAnalysis/** · ScrollsNL/**         [N4]
   │  │  ├─ ScrollsLineage/**                         [N5]
   │  │  ├─ ScrollsProvenance/**                      [N6]
   │  │  ├─ ScrollsService/
   │  │  │  ├─ AtlasService · AtlasPlatform · Events · LiveAtlas · MockAtlas · UserWrites · TaskRegistry ·
   │  │  │  │  LiveAtlas+Health · LiveAtlas+Jobs (.swift) · Resources/contract-fixtures/         [N0]
   │  │  │  ├─ LiveAtlas+Imports.swift                                                         [N1]
   │  │  │  ├─ LiveAtlas+{Corpora,Adapters,Tour,Baseline,Etymology}.swift · LivePlatform.swift ·
   │  │  │  │  Pipelines/** · Generations/**                                                     [N2]
   │  │  │  ├─ LiveAtlas+{Search,Expressions,Timeline,Passages,Documents,Kwic,Occurrences,Exports,Snapshots}.swift [N3]
   │  │  │  ├─ LiveAtlas+{Compare,Collocations,Clusters,Analysis,Constellation}.swift            [N4]
   │  │  │  ├─ LiveAtlas+{Lineage,Genealogy,Trace}.swift                                       [N5]
   │  │  │  └─ LiveAtlas+{Relationships,Hypotheses,Annotations,Views}.swift ·
   │  │  │     JournalReplayer.swift · ViewCutoffResolver.swift                                [N6]
   │  │  ├─ ScrollsScrollModel/{Primitives,TimeScale,Vantage}.swift [N0]; everything else      [N7]
   │  │  ├─ ScrollsRender/**                          [N7]  ScrollRenderer, ScrollUniforms, Shaders/{Scroll.metal,ScrollShaderTypes.h},
   │  │  │                                                  LabelAtlas, DisplayListCanvas, SVGWriter, OffscreenRenderer
   │  │  └─ scrolls-cli/  main.swift · Commands/{Dump,Probe}.swift                             [N0]
   │  │                   Commands/{Pack,Starter,Atlas,Fingerprint,ConvertReference,Bench}.swift [N2]
   │  │                   Commands/DiffRead.swift [N3] · DiffAnalysis.swift [N4] · Api.swift [N6]
   │  └─ Tests/
   │     ├─ <Target>Tests/**                          the owner of <Target>
   │     ├─ DifferentialTests/Support/** · ContractRoundTripTests.swift · Golden/{MANIFEST,DIVERGENCES}.json   [N0]
   │     └─ DifferentialTests/<Area>/** · Golden/<family>/**    the package owning the family (§2.2)
   ├─ Scrolls/                                        the app target
   │  ├─ App/{ScrollsApp,AppModel,EngineHost,LaunchArgs,Lifecycle,BackgroundTasks,JobsModel}.swift   [N0]
   │  ├─ Design/{Tokens,Palette,Typography,Glass}.swift ·
   │  │  Design/Components/{GateCard,EvidenceBadge,DenominatorLine,SyntheticRibbon,StatusChip,CountingLabel,ErrorCard,DateChip}.swift [N0]
   │  ├─ Shell/{RootView,ScrollScreen,InspectorSheet,SheetDetent,PresentationCoordinator,Routes}.swift   [N0]
   │  ├─ Shell/{TopBar,StrandChips,MoreMenu,LandscapeShell,HapticsMap,StateRestoration,DeepLinks}.swift  [N8]
   │  ├─ Scroll/**                                    [N7]  ScrollModel, ScrollCanvas, ScrollGestureHost, Playhead, Ruler, Minimap,
   │  │                                                     CoverageTrack, LaneHeaders, ShelfChips, AmbiguityChooser, MarkPreview,
   │  │                                                     TapSentences, ScrollAccessibility, ScrollTableView, PerfHUD
   │  ├─ Inspector/** · Search/** · Tour/** · Settings/** · Jobs/** · Legend/** · Lanes/**          [N8]
   │  ├─ Import/**                                    [N1]
   │  ├─ Sources/**                                   [N2]  Packs & storage, Inbox, generations UI
   │  ├─ Exports/**                                   [N3]
   │  ├─ Compare/** · Constellation/**                [N4]
   │  ├─ Lineage/**                                   [N5]  explorer, genealogy, EdgeCardView, chain of custody
   │  ├─ Notebook/** · Views/**                       [N6]
   │  ├─ Diagnostics/{SelfTestRunner,SelfTestSteps,ProbeView,DiagnosticsView,PerfLog}.swift [N0]; Diagnostics/Steps/<Pkg>Steps.swift [each]
   │  └─ Resources/{Assets.xcassets,Info.plist,Scrolls.entitlements} [N0]; Resources/Bundled/ (build products, git-ignored) [N2]
   ├─ ScrollsAppTests/<Area>Tests.swift               the package owning the area (PresentationTests, LintTests: N0)
   └─ ScrollsUITests/ FirstMinuteTests · AccessibilityAuditTests · StateRestorationTests [N8] · ScrollGestureTests [N7] ·
                      ImportUITests [N1] · JourneyTests [I]
```

There is **no shared string catalogue.** Ported copy is generated into `ScrollsCore/Copy.swift` (byte-equal to vocab). Each feature keeps its own `enum <Feature>Copy` in its own folder. `CopyLintTests` (N0) scan every `*Copy.swift` file.

### 8.2 Rules for every package

1. **One owner per file.**
   - A package edits only its own files. It talks to other packages only through frozen contracts: `AtlasService`, `AtlasPlatform`, the Contracts types, `JobTask`/`JobContext`, `TextStore`, `SourceAdapter`, the `Canonical*` types, `JournalOp` and the keys, the `DisplayList` primitives, and the schema plus the device profile.
   - A missing contract goes to N0. N0 makes the change **additively**, regenerates what it touches in one commit, and notes it in `Native/Docs/status/N0.md`.
2. **Agents cannot create new `.md` files.**
   - The lead pre-creates every placeholder in §8.9.
   - Machine-readable outputs are JSON (`Native/Reports/*.json`).
   - Fixture folders carry `MANIFEST.json`, never a README.
   - Swift, `.mjs`, `.sh`, `.json` and `.metal` files may be created inside a package's own paths.
3. **Every package builds in its own persistent mirror:** `SCROLLS_BUILD_DIR=$TMPDIR/scrolls-<pkg>`. `rsync` keeps `.build` between runs, so builds are incremental. Packages compile their own targets (`Tools/build.sh target <T…>`) with `SCROLLS_JOBS=4`. **Nobody builds inside `~/Documents`.**
4. **Keep the gate green.** Every package keeps `Tools/check.sh quick --wp <pkg>` green. Before declaring a milestone slice done, it runs its own `check.d` stage plus `quick` for all packages.
5. **Goldens are regenerated only by N0 (or I at a milestone).** A package that needs a new case adds it to its own generator and requests regeneration in its status file. The rebase protocol is §2.1.
6. **Every package finishes its milestone slice first:** the demo path, end to end, in its own area.
7. **Status.** Each package keeps `Native/Docs/status/<pkg>.md` with: what is done, its evidence (report file names), what is pending on the device, and its contract requests.
8. **Honesty rules.** SPEC §13 binds every package. Reviewers reject code that breaks one.

### 8.3 R — reference steward (runs in parallel with N0; the web build only)

- **Owns:**
  - changes to `server/`, `src/`, `tests/`, `scripts/` and `data/`, made only for RF items and findings;
  - `Native/Docs/REFERENCE-CHANGES.md` and `Native/Docs/status/R.md`;
  - the snapshots `~/Developer/scrolls-snapshots/{m1r,m5r}`;
  - the `ref-freeze-n` tags.
- **Delivers, in this order:**
  1. **RF-1**, the 'und' gating, with a cube version bump and the invariant oracles.
  2. **RF-2**, as-saved Compare and inspector.
  3. **RF-3**, the journey requests, recorded as JSONL.
  4. `npm test` green (with the DYLD workaround), and the tag `ref-freeze-1`.
  5. **RF-4**: fresh `m1r` and `m5r` built from `ref-freeze-1` by a full bootstrap with every STEMM source and the M5-gate runs, `originals/` stored inside, and a `SNAPSHOT.json` (commit, counts, run ids). `npm run verify` passes on both.
- **Then:** fixes findings from the differential stages as they arrive (§2.1).
- **Acceptance:** `npm test` and `npm run verify` green on `m1r` and `m5r`. REFERENCE-CHANGES.md lists every change with its test.
- **Timing:** G1 core goldens may be generated from HEAD at once (RF-1/RF-2 do not touch `src/shared`). G2 slices, G3, G4 and G7 wait for `ref-freeze-1`.

### 8.4 N0 — FOUNDATION (one agent, first; the critical path, ≈ 5–6k lines)

#### 8.4.1 `Native/project.yml`

```yaml
name: Scrolls
options:
  bundleIdPrefix: com.utkarsh
  deploymentTarget: { iOS: "27.0" }
  xcodeVersion: "27.0"
  createIntermediateGroups: true
packages:
  ScrollsKit: { path: ScrollsKit }
  LabKit: { path: ../../LabKit }                 # Tools/build.sh mirrors LabKit beside Scrolls/ (Rheo's pattern)
settings:
  base:
    SWIFT_VERSION: "6.0"
    SWIFT_APPROACHABLE_CONCURRENCY: YES
    SWIFT_STRICT_CONCURRENCY: complete
    MARKETING_VERSION: "1.0"
    CURRENT_PROJECT_VERSION: "1"
    DEVELOPMENT_TEAM: ""
    CODE_SIGN_STYLE: Automatic
targets:
  Scrolls:
    type: application
    platform: iOS
    sources:
      - path: Scrolls
        excludes: ["Resources/Bundled/**"]
      - path: Scrolls/Resources/Bundled          # starter.atlas, cipher-meta.scrollspack, cipher-text.scrollspack (build products)
        type: folder
        buildPhase: resources
        optional: true
    dependencies:
      - package: ScrollsKit
        products: [ScrollsService, ScrollsScrollModel, ScrollsRender]
      - package: LabKit
        products: [LabKitCore, LabKitFeedback, LabKitUI]
    info:
      path: Scrolls/Resources/Info.plist
      properties:
        CFBundleDisplayName: Scrolls
        CFBundleShortVersionString: $(MARKETING_VERSION)
        CFBundleVersion: $(CURRENT_PROJECT_VERSION)
        UILaunchScreen: { UIColorName: LaunchBackground }
        UIApplicationSceneManifest: { UIApplicationSupportsMultipleScenes: false }
        UISupportedInterfaceOrientations: [UIInterfaceOrientationPortrait, UIInterfaceOrientationLandscapeLeft, UIInterfaceOrientationLandscapeRight]
        UIUserInterfaceStyle: Dark
        CADisableMinimumFrameDurationOnPhone: true
        ITSAppUsesNonExemptEncryption: false
        LSApplicationCategoryType: public.app-category.education
        UIFileSharingEnabled: true
        LSSupportsOpeningDocumentsInPlace: true
        UIBackgroundModes: [processing]
        BGTaskSchedulerPermittedIdentifiers: [com.utkarsh.scrolls.maintenance, "com.utkarsh.scrolls.job.*"]
        CFBundleURLTypes: [{ CFBundleURLName: com.utkarsh.scrolls, CFBundleURLSchemes: [scrolls] }]
        CFBundleDocumentTypes:
          - { CFBundleTypeName: Scrolls source pack, LSHandlerRank: Owner, LSItemContentTypes: [com.utkarsh.scrolls.pack] }
          - { CFBundleTypeName: Scrolls atlas, LSHandlerRank: Owner, LSItemContentTypes: [com.utkarsh.scrolls.atlas, com.utkarsh.scrolls.archive] }
          - { CFBundleTypeName: Scrolls view, LSHandlerRank: Owner, LSItemContentTypes: [com.utkarsh.scrolls.view] }
          - { CFBundleTypeName: Text or data to import, LSHandlerRank: Alternate,
              LSItemContentTypes: [public.plain-text, public.comma-separated-values-text, public.tab-separated-values-text,
                                   public.json, net.daringfireball.markdown, org.jsonlines.jsonl] }
        UTExportedTypeDeclarations:
          - { UTTypeIdentifier: com.utkarsh.scrolls.pack, UTTypeDescription: Scrolls source pack, UTTypeConformsTo: [public.data],
              UTTypeTagSpecification: { public.filename-extension: [scrollspack] } }
          - { UTTypeIdentifier: com.utkarsh.scrolls.atlas, UTTypeDescription: Scrolls atlas, UTTypeConformsTo: [com.apple.package],
              UTTypeTagSpecification: { public.filename-extension: [scrollsatlas] } }
          - { UTTypeIdentifier: com.utkarsh.scrolls.archive, UTTypeDescription: Scrolls atlas archive, UTTypeConformsTo: [public.data],
              UTTypeTagSpecification: { public.filename-extension: [scrollsarchive] } }
          - { UTTypeIdentifier: com.utkarsh.scrolls.view, UTTypeDescription: Scrolls view, UTTypeConformsTo: [public.json],
              UTTypeTagSpecification: { public.filename-extension: [scrollsview] } }
        UTImportedTypeDeclarations:
          - { UTTypeIdentifier: org.jsonlines.jsonl, UTTypeDescription: JSON Lines, UTTypeConformsTo: [public.plain-text],
              UTTypeTagSpecification: { public.filename-extension: [jsonl] } }
    entitlements:
      path: Scrolls/Resources/Scrolls.entitlements
      properties:
        com.apple.developer.kernel.increased-memory-limit: true         # requested; no budget depends on it
        com.apple.developer.kernel.extended-virtual-addressing: true    # requested; no budget depends on it
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.utkarsh.scrolls
        TARGETED_DEVICE_FAMILY: "1"
        SWIFT_DEFAULT_ACTOR_ISOLATION: MainActor
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: AccentColor
        SUPPORTS_MACCATALYST: NO
      configs:
        Debug:
          SWIFT_OPTIMIZATION_LEVEL: "-O"         # Loom's convention
    postCompileScripts:
      - name: Strip extended attributes
        script: '/usr/bin/xattr -cr "$TARGET_BUILD_DIR/$WRAPPER_NAME" || true'
  ScrollsAppTests:
    type: bundle.unit-test
    platform: iOS
    sources: [ScrollsAppTests]
    dependencies: [{ target: Scrolls }]
    settings: { base: { SWIFT_DEFAULT_ACTOR_ISOLATION: MainActor } }
  ScrollsUITests:
    type: bundle.ui-testing
    platform: iOS
    sources: [ScrollsUITests]
    dependencies: [{ target: Scrolls }]
schemes:
  Scrolls:
    build: { targets: { Scrolls: all } }
    test: { config: Debug, targets: [ScrollsAppTests, ScrollsUITests] }
```

#### 8.4.2 `Native/Tools/build.sh`

```zsh
#!/bin/zsh
# xcodebuild and SwiftPM hang or misbehave inside the iCloud-synced folder, and the app depends on ../../LabKit by relative
# path, so mirror Scrolls/ (Native + the Node reference that the goldens import) and LabKit/ side by side into a local work
# directory and build there. Never build inside ~/Documents.
#   Tools/build.sh mirror             rsync only (the other tools call it first)
#   Tools/build.sh target <T…>        swift build -c release --target T for engine targets (a package's quick build)
#   Tools/build.sh test [filter]      ScrollsKit tests on the Mac (swift test -c release; TOOLCHAINS=metal for ScrollsRender)
#   Tools/build.sh cli                swift build -c release --product scrolls-cli; prints the binary's path
#   Tools/build.sh sim                Debug app build for the simulator ($SCROLLS_SIM)
#   Tools/build.sh app-test           xcodebuild test (ScrollsAppTests + ScrollsUITests) on the simulator
#   Tools/build.sh device             Release app build for a connected iPhone
#   Tools/build.sh install            device build, then devicectl install on $SCROLLS_DEVICE (default: the one connected iPhone)
#   Tools/build.sh sim-create         creates "Scrolls 15 Pro Max" (iPhone 15 Pro Max device type, iOS 27 runtime: his phone's 430×932 pt)
# Env: SCROLLS_BUILD_DIR (one per parallel agent) · SCROLLS_SIM · SCROLLS_DEVICE · SCROLLS_BUNDLE_PACKS=1|0 · SCROLLS_JOBS (4)
set -e
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"                  # …/AI Stuff
WORK="${SCROLLS_BUILD_DIR:-${TMPDIR:-/tmp}/ScrollsBuild}"
SIM="${SCROLLS_SIM:-Scrolls 15 Pro Max}"
JOBS="${SCROLLS_JOBS:-4}"
PACKS="${SCROLLS_PACKS_DIR:-$HOME/Developer/scrolls-packs/current}"
KIT="$WORK/src/Scrolls/Native/ScrollsKit"
mkdir -p "$WORK/src"
mirror() {
  rsync -a --delete --exclude '.build' --exclude '.swiftpm' --exclude '* 2.*' --exclude '* 2' \
        "$ROOT/LabKit/" "$WORK/src/LabKit/"
  rsync -a --delete --exclude '.git' --exclude '.build' --exclude '.swiftpm' --exclude 'node_modules' \
        --exclude 'Native/Scrolls.xcodeproj' --exclude 'Native/Reports' --exclude 'Native/Scrolls/Resources/Bundled' \
        --exclude '* 2.*' --exclude '* 2' "$ROOT/Scrolls/" "$WORK/src/Scrolls/"
  "$WORK/src/Scrolls/Native/Tools/gen-buildinfo.sh" "$WORK/src/Scrolls"   # stage code hashes → ScrollsCore/Generated/BuildInfo.swift (mirror only)
  local B="$WORK/src/Scrolls/Native/Scrolls/Resources/Bundled"; mkdir -p "$B"
  for f in starter.atlas cipher-meta.scrollspack; do [[ -e "$PACKS/$f" ]] && cp -c "$PACKS/$f" "$B/" ; done
  [[ "${SCROLLS_BUNDLE_PACKS:-1}" == 1 && -e "$PACKS/cipher-text.scrollspack" ]] && cp -c "$PACKS/cipher-text.scrollspack" "$B/" || rm -f "$B/cipher-text.scrollspack"
  [[ -e "$B/starter.atlas" ]] || echo "build.sh: no starter in $PACKS — the app will generate the demo on first launch (Tools/packs.sh builds it)" >&2
}
xcode() { cd "$WORK/src/Scrolls/Native" && xcodegen generate --quiet && xcodebuild -project Scrolls.xcodeproj -scheme Scrolls \
          -derivedDataPath "$WORK/dd" -jobs "$JOBS" "$@" ; }
device_id() { xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null | /usr/bin/python3 -I -c \
  'import json,sys;d=json.load(sys.stdin)["result"]["devices"];print(next(x["identifier"] for x in d if x["hardwareProperties"]["platform"]=="iOS"))' ; }
case "${1:-sim}" in
  mirror)     mirror ;;
  target)     mirror; shift; for t in "$@"; do (cd "$KIT" && swift build -c release -j "$JOBS" --scratch-path "$WORK/kit" --target "$t"); done ;;
  test)       mirror; (cd "$KIT" && TOOLCHAINS=metal swift test -c release -Xswiftc -enable-testing -j "$JOBS" --scratch-path "$WORK/kit" ${2:+--filter "$2"}) ;;
  cli)        mirror; (cd "$KIT" && swift build -c release -j "$JOBS" --scratch-path "$WORK/kit" --product scrolls-cli) && echo "$WORK/kit/release/scrolls-cli" ;;
  sim)        mirror; xcode -configuration Debug -destination "platform=iOS Simulator,name=$SIM" build ;;
  app-test)   mirror; xcode -configuration Debug -destination "platform=iOS Simulator,name=$SIM" test ;;
  device)     mirror; xcode -configuration Release -destination 'generic/platform=iOS' -allowProvisioningUpdates build ;;
  install)    "$0" device && xcrun devicectl device install app --device "${SCROLLS_DEVICE:-$(device_id)}" \
                "$WORK/dd/Build/Products/Release-iphoneos/Scrolls.app" ;;
  sim-create) xcrun simctl create "Scrolls 15 Pro Max" com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro-Max \
                "$(xcrun simctl list runtimes | awk '/iOS 27/ {print $NF; exit}')" ;;
  *) echo "usage: build.sh mirror|target|test|cli|sim|app-test|device|install|sim-create" >&2; exit 2 ;;
esac
```

`gen-buildinfo.sh` writes `ScrollsCore/Generated/BuildInfo.swift` **in the mirror only**. Its fields:
- `engineVersion`;
- `gitCommit` (from `git --git-dir ~/Developer/git/Scrolls.git rev-parse HEAD`);
- `stageCodeHashes`: the sha256 of each stage's source files, the analogue of `MATCHING_CODE_FILES`.

The committed copy holds `"dev"` values.

#### 8.4.3 `Native/ScrollsKit/Package.swift`

```swift
// swift-tools-version: 6.4
// .iOS(.v27)/.macOS(.v27) need tools 6.4 (LabKit's note). Ownership: N0. A package edits only its own targets' settings, via N0.
import PackageDescription

let engine: [SwiftSetting] = [
  .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
  .unsafeFlags(["-O"], .when(configuration: .debug)),        // Loom's rule: the engine is arithmetic; -Onone is ≈ 20× slower
]
let numeric: [SwiftSetting] = engine + [.unsafeFlags(["-Xcc", "-DACCELERATE_NEW_LAPACK"])]

let package = Package(
  name: "ScrollsKit",
  platforms: [.iOS(.v27), .macOS(.v27)],
  products: [
    .library(name: "ScrollsCore", targets: ["ScrollsCore"]),
    .library(name: "ScrollsContracts", targets: ["ScrollsContracts"]),
    .library(name: "ScrollsService", targets: ["ScrollsService"]),
    .library(name: "ScrollsScrollModel", targets: ["ScrollsScrollModel"]),
    .library(name: "ScrollsRender", targets: ["ScrollsRender"]),
    .executable(name: "scrolls-cli", targets: ["scrolls-cli"]),
  ],
  targets: [
    .target(name: "ScrollsCore", resources: [.copy("Resources/vocab.json")], swiftSettings: engine),
    .target(name: "ScrollsContracts", dependencies: ["ScrollsCore"], swiftSettings: engine),
    .target(name: "ScrollsStore", dependencies: ["ScrollsCore", "ScrollsContracts"],
            resources: [.copy("Resources/schema.sql"), .copy("Resources/device-profile.sql"), .copy("Resources/dump-spec.json")],
            swiftSettings: engine, linkerSettings: [.linkedLibrary("sqlite3")]),
    .target(name: "ScrollsJobs", dependencies: ["ScrollsStore"], swiftSettings: engine),
    .target(name: "ScrollsIngest", dependencies: ["ScrollsJobs"], resources: [.copy("Resources/stopwords")], swiftSettings: engine),
    .target(name: "ScrollsSources", dependencies: ["ScrollsIngest"],
            resources: [.copy("Resources/demo"), .copy("Resources/field-taxonomy.json")], swiftSettings: engine),
    .target(name: "ScrollsQuery", dependencies: ["ScrollsJobs"], swiftSettings: engine),
    .target(name: "ScrollsAnalysis", dependencies: ["ScrollsQuery"], swiftSettings: numeric),
    .target(name: "ScrollsNL", dependencies: ["ScrollsAnalysis"], swiftSettings: engine),
    .target(name: "ScrollsLineage", dependencies: ["ScrollsAnalysis"], swiftSettings: numeric),
    .target(name: "ScrollsProvenance", dependencies: ["ScrollsQuery"], swiftSettings: engine),
    .target(name: "ScrollsService",
            dependencies: ["ScrollsSources", "ScrollsQuery", "ScrollsAnalysis", "ScrollsNL", "ScrollsLineage", "ScrollsProvenance"],
            resources: [.copy("Resources/contract-fixtures")],          // the 65 tests/contract/*.json, for MockAtlas
            swiftSettings: engine),
    .target(name: "ScrollsScrollModel", dependencies: ["ScrollsCore", "ScrollsContracts"], swiftSettings: engine),
    .target(name: "ScrollsRender", dependencies: ["ScrollsScrollModel"], resources: [.process("Shaders")],
            swiftSettings: engine + [.defaultIsolation(MainActor.self)]),   // SVGWriter is declared nonisolated
    .executableTarget(name: "scrolls-cli", dependencies: ["ScrollsService", "ScrollsScrollModel"], swiftSettings: engine),

    .testTarget(name: "ScrollsCoreTests", dependencies: ["ScrollsCore"]),
    .testTarget(name: "ScrollsContractsTests", dependencies: ["ScrollsContracts"]),
    .testTarget(name: "ScrollsStoreTests", dependencies: ["ScrollsStore"]),
    .testTarget(name: "ScrollsJobsTests", dependencies: ["ScrollsJobs"]),
    .testTarget(name: "ScrollsIngestTests", dependencies: ["ScrollsIngest"]),
    .testTarget(name: "ScrollsSourcesTests", dependencies: ["ScrollsSources"]),
    .testTarget(name: "ScrollsQueryTests", dependencies: ["ScrollsQuery"]),
    .testTarget(name: "ScrollsAnalysisTests", dependencies: ["ScrollsAnalysis", "ScrollsNL"]),
    .testTarget(name: "ScrollsLineageTests", dependencies: ["ScrollsLineage"]),
    .testTarget(name: "ScrollsProvenanceTests", dependencies: ["ScrollsProvenance"]),
    .testTarget(name: "ScrollsServiceTests", dependencies: ["ScrollsService"]),
    .testTarget(name: "ScrollsScrollModelTests", dependencies: ["ScrollsScrollModel"]),
    .testTarget(name: "ScrollsRenderTests", dependencies: ["ScrollsRender"]),
    .testTarget(name: "DifferentialTests", dependencies: ["ScrollsService", "ScrollsScrollModel", "ScrollsRender"],
                resources: [.copy("Golden")]),                         // committed, redacted subset (§2.6)
  ],
  swiftLanguageModes: [.v6]
)
```

#### 8.4.4 The SQLite layer and the job system (frozen at the N0 merge)

```swift
// ScrollsStore ───────────────────────────────────────────────────────────────────────────────────────────────
public enum SQLValue: Sendable, Equatable { case int(Int64), double(Double), text(String), blob([UInt8]), null }
public enum TxKind: Sendable { case deferred, immediate }
public enum StoreProfile: String, Sendable { case reference, device }        // reference = a Node-built database
public enum OpenMode: Sendable { case readWrite, readOnly, readOnlyImmutable } // immutable: ?immutable=1 for test clones
public struct StoreError: Error, Sendable, Equatable { public let code: Int32; public let message: String; public let sql: String? }

public enum ScanPolicy: Sendable, Hashable { case indexOnly, scanOK(reason: String) }
public struct SQL: Sendable, Hashable {                                        // every statement lives in a catalogue
  public let id: String; public let text: String; public let scan: ScanPolicy
  public init(_ id: String, _ text: String, scan: ScanPolicy = .indexOnly)
}
public protocol SQLCatalog { static var all: [SQL] { get } }                 // one enum per area; SQLCatalogTests reads them all

public struct InterruptHandle: Sendable { public func interrupt() }          // wraps sqlite3_interrupt (thread-safe)
public final class Connection {                                              // not Sendable: confined to its owning actor
  public init(path: String, mode: OpenMode, profile: StoreProfile, mmapBytes: Int = 0) throws(StoreError)
  public func prepared(_ sql: SQL) throws(StoreError) -> Statement            // LRU 128, SQLITE_PREPARE_PERSISTENT
  public func prepared(dynamic text: String) throws(StoreError) -> Statement  // IN-lists only; LRU 64
  public func exec(_ text: String) throws(StoreError)
  public func transaction<T>(_ kind: TxKind = .deferred, _ body: () throws -> T) throws -> T
  public func setDeadline(_ deadline: ContinuousClock.Instant?)              // checked by the progress handler (every 10k VM steps)
  public func setHeartbeat(_ beat: (@Sendable () -> Void)?)                  // the stall rule (§3.7)
  public var interruptHandle: InterruptHandle { get }
  public var changes: Int { get }
  public var lastInsertRowID: Int64 { get }
  public let profile: StoreProfile
}
public final class Statement {
  public func bind(_ values: SQLValue...) throws(StoreError)
  public func bind(_ values: [SQLValue]) throws(StoreError)
  public func step() throws(StoreError) -> Row?
  public func run() throws(StoreError)
  public func all<T>(_ map: (Row) throws -> T) throws -> [T]
}
public struct Row {                                                           // valid until the next step()
  public func int(_ i: Int32) -> Int64
  public func double(_ i: Int32) -> Double
  public func text(_ i: Int32) -> String
  public func utf16(_ i: Int32) -> UnsafeBufferPointer<UInt16>               // sqlite3_column_text16: the D4 offset space
  public func blob(_ i: Int32) -> [UInt8]
  public func isNull(_ i: Int32) -> Bool
}

public enum ReadLane: Sendable { case interactive, job }
public actor ReadConnection {
  public nonisolated var unownedExecutor: UnownedSerialExecutor { get }     // its own DispatchSerialQueue
  public func run<T: Sendable>(deadline: Duration?, _ body: @Sendable (Connection) throws -> T) throws -> T
}
public final class ReadPool: Sendable {                                       // reader 0 reserved for .interactive
  public init(path: String, profile: StoreProfile, size: Int = 3, mmapBytesPerReader: Int = 256 << 20) throws
  public func read<T: Sendable>(_ lane: ReadLane = .interactive, deadline: Duration = .seconds(5),
                                _ body: @Sendable (Connection) throws -> T) async throws -> T
  public func drain() async                                                   // a swap: wait for in-flight reads, refuse new ones
  public func reopen(path: String) async throws
}

public final class WriteTx {                                                  // only inside Writer.write / WriteLease.batch
  public let connection: Connection
  public let ids: RowIDAllocator
  public func bumpDataVersion()
  public func recordJournalApplied(_ entry: JournalEntry)                     // inserts journal_applied + meta.journal_applied_seq
}
public enum CheckpointMode: Sendable { case passive, truncate }
public struct WALStatus: Sendable { public let walBytes: Int; public let checkpointedFrames: Int }
public actor Writer {
  public nonisolated var unownedExecutor: UnownedSerialExecutor { get }
  public init(path: String, profile: StoreProfile) throws
  public func write<T: Sendable>(_ label: String, _ body: @Sendable (WriteTx) throws -> T) throws -> T   // one BEGIN IMMEDIATE
  public func lease(for job: JobID) -> WriteLease
  public func checkpoint(_ mode: CheckpointMode) throws -> WALStatus
  public func close() throws
}
public final class WriteLease: Sendable {
  public func batch<T: Sendable>(_ label: String, _ body: @Sendable (WriteTx) throws -> T) async throws -> T  // one tx, then yield
  public func end() async
}

public enum TableClass: Sendable, Equatable { case entity, log, keyed, cache }
public struct SourceSlot: RawRepresentable, Sendable, Hashable, Codable {
  public let rawValue: Int                                                    // 0…14
  public init(rawValue: Int)
  public static let base = SourceSlot(rawValue: 0), cipherMeta = SourceSlot(rawValue: 1), cipherRelations = SourceSlot(rawValue: 2),
                    cipherText = SourceSlot(rawValue: 3), stemmGutenberg = SourceSlot(rawValue: 4),
                    stemmOpenAlex = SourceSlot(rawValue: 5), stemmWiktionary = SourceSlot(rawValue: 6)
}
public enum IDScope: Sendable, Equatable { case slot(SourceSlot), local }
public enum RowIDPolicy {
  public static let classes: [String: TableClass]                             // every table of schema.sql + device-profile.sql
  public static let slotWidth: Int64 = 100_000_000
  public static let localBase: Int64 = 1_500_000_000
  public static let ceiling: Int64 = Int64(Int32.max)
}
public final class RowIDAllocator {
  public func next(_ table: String, _ scope: IDScope) throws -> Int64         // entity tables; id_counter in the same tx; < 2³¹
  public func nextLog(_ table: String) throws -> Int64                        // max + 1
}

public enum MemoryBudget {
  public static func reserve(bytes: Int, headroom: Int = 600 << 20) throws -> MemoryReservation   // os_proc_available_memory()
}
public final class MemoryReservation: Sendable { public func release() }
public enum MappedFileRegistry {
  public static let budgetBytes = 2 << 30
  public static func map(_ url: URL, purpose: String) throws -> MappedFile    // throws .overBudget → callers stream with pread
}
public final class MappedFile: @unchecked Sendable { public var bytes: UnsafeRawBufferPointer { get }; public func unmap() }

public struct AtlasLocation: Sendable {                                       // §3.9; -atlasRoot isolation (§6.6)
  public static func live() throws -> AtlasLocation
  public static func selfTest(_ name: String, cloneLive: Bool) throws -> AtlasLocation
  public let atlasDir: URL; public let nextDir: URL; public let prevDir: URL; public let notebookDir: URL
  public let derivedDir: URL; public let cachesDir: URL; public let inboxDir: URL; public let diagnosticsDir: URL
  public var atlasPath: String { get }
}
public enum Probe { public static func run(sampleTexts: URL?) -> ProbeReport }   // §1.4; also fonts, NL, memory and VM (§3.8)
public enum LogicalDump {                                                     // §2.3; reads Resources/dump-spec.json
  public static func dump(_ c: Connection, text: any TextStore, to dir: URL, tables: [String]?) throws -> [String: TableDigest]
}
public struct TableDigest: Codable, Sendable, Equatable { public let rows: Int; public let sha256: String }

// ScrollsStore/Journal ─────────────────────────────────────────────────────────────────────────────────────────
public struct JournalEntry: Codable, Sendable, Equatable {
  public let seq: UInt64; public let at: String; public let actor: String; public let op: JournalOp; public let crc32: UInt32
}
// `JournalOp` and the key types (DocKey, PassageAnchor, BatchKey, RelKey, RunKey, ExprKey, AnnotationKey, ClusterKey,
// PortableCutoffs, PortableSelection) exactly as in §6.2–§6.4.
public actor JournalFile {
  public init(directory: URL) throws                                          // newest journal-NNNNNN.jsonl; truncates a torn last line
  public func append(_ op: JournalOp, actor: String) throws -> JournalEntry   // canonical JSON + CRC + fsync; rotates at 32 MB
  public var head: UInt64 { get }
  public nonisolated func entries(after seq: UInt64) -> AsyncThrowingStream<JournalEntry, any Error>
}

// ScrollsStore/Pack (stub frozen by N0, implemented by N2) ─────────────────────────────────────────────────────
public struct PackMemberInfo: Codable, Sendable, Equatable { public let path: String; public let size: Int64; public let sha256: String }
public struct PackManifest: Codable, Sendable, Equatable {
  public let packID: String; public let name: String; public let version: String; public let slot: SourceSlot
  public let adapterIDs: [String]; public let createdBy: String; public let referenceCommit: String
  public let licences: [String]; public let attribution: [String]; public let caveats: [String]
  public let members: [PackMemberInfo]; public let counts: [String: Int]
}
public final class PackReader: Sendable {
  public init(url: URL) throws
  public var manifest: PackManifest { get }
  public func fileSHA256() async throws -> String
  public func bytes(member: String, range: Range<Int64>) throws -> Data           // decodes only the covering 1 MiB frames
  public func stream(member: String) -> AsyncThrowingStream<Data, any Error>
  public func verify(member: String) async throws -> Bool
}
public struct PackWriter { public init(url: URL, manifest: PackManifest) throws
  public mutating func add(member: String, from file: URL) throws; public mutating func finish() throws -> String }

// ScrollsJobs ─────────────────────────────────────────────────────────────────────────────────────────────────
public struct JobID: RawRepresentable, Hashable, Sendable, Codable { public let rawValue: Int64; public init(rawValue: Int64) }
public struct JobType: RawRepresentable, Hashable, Sendable, Codable {
  public let rawValue: String; public init(rawValue: String)
  // Vocab.jobTypes (the 19 reference types), plus:
  public static let packInstall = JobType(rawValue: "pack-install"), generationBuild = JobType(rawValue: "generation-build"),
                    generationSwap = JobType(rawValue: "generation-swap"), journalReplay = JobType(rawValue: "journal-replay"),
                    maintenance = JobType(rawValue: "maintenance")
}
public enum WriteNeed: Sendable { case none, commitsOnly, exclusive }
public struct ResourceBudget: Sendable { public var peakBytes: Int; public var mappedBytes: Int; public var maxThreads: Int; public var mayStartInBackground: Bool }
public enum ComputeThrottle: Sendable, Equatable { case nominal, fair, serious, critical, lowPower
  public var workers: Int { get }                      // 6, 4, 1, 0, 2
  public var allowsAutomaticStarts: Bool { get } }
public protocol DeviceConditionsSource: Sendable { var current: ComputeThrottle { get } }
public struct Unthrottled: DeviceConditionsSource { public init(); public var current: ComputeThrottle { get } }   // the CLI

public struct JobSpec: Sendable {
  public var type: JobType; public var params: JSONValue; public var priority: Int; public var after: [JobID]
  public var journal: JournalOp?                                    // set when the job is a journaled act (written at commit, §6.2)
  public var continuedProcessing: ContinuedProcessingRequest?       // title/subtitle when the user asked to keep it running
}
public protocol JobTask: Sendable {
  static var type: JobType { get }
  static var writes: WriteNeed { get }
  static var resumable: Bool { get }
  static var budget: ResourceBudget { get }
  init(params: JSONValue) throws
  func run(_ ctx: JobContext) async throws -> JSONValue
}
public final class JobContext: Sendable {
  public let id: JobID; public let reads: ReadPool; public let text: any TextStore
  public var parallelism: Int { get }
  public func write<T: Sendable>(_ label: String, _ body: @Sendable (WriteTx) throws -> T) async throws -> T  // .commitsOnly
  public func lease() async -> WriteLease                                                                 // .exclusive
  public func progress(_ fraction: Double, phase: String? = nil, message: String? = nil, counts: [String: Int] = [:])
  public func heartbeat()
  public func checkpoint() async throws               // cancellation + thermal pause + memory admission + heartbeat + Task.yield()
  public func startRun(_ stage: Stage, params: JSONValue, scope: JSONValue, upstream: [RunID],
                       representation: String?, seed: Int?) async throws -> RunHandle   // reuse on (stage, params_hash, input_fingerprint, code_hash)
  public func finishRun(_ run: RunHandle, _ status: RunStatus, metrics: JSONValue?) async throws
  public func concurrentMap<T: Sendable, R: Sendable>(_ items: [T], chunkBudget: Duration = .milliseconds(5),
                                                       _ f: @Sendable (T) throws -> R) async throws -> [R]   // work-stealing, ordered
}
public actor JobQueue {
  public init(reads: ReadPool, writer: Writer, text: any TextStore, registry: TaskRegistry,
              conditions: any DeviceConditionsSource, journal: JournalFile)
  public func enqueue(_ spec: JobSpec) async throws -> JobID
  public func cancel(_ id: JobID) async                         // acknowledged ≤ 500 ms
  public func suspendAll(within: Duration) async
  public func resumeAll() async
  public func recoverInterrupted() async throws                 // running → interrupted; resumable types re-queued from their cursor
  public func snapshot(_ status: JobStatus?) async throws -> [JobSnapshot]
  public nonisolated var events: AsyncStream<JobEvent> { get }
}
public actor BoundedChannel<Element: Sendable> {
  public init(capacity: Int)
  public func send(_ element: Element) async throws             // suspends while full; throws CancellationError
  public func finish()
  public func next() async -> Element?
}
public struct RunKey: Codable, Sendable, Hashable { public var stage: Stage; public var paramsHash: String
  public var inputFingerprint: String; public var codeHash: String }
```

#### 8.4.5 Shared value types (frozen)

```swift
// ScrollsCore
public typealias Day = Int32                                                  // days since 1970-01-01, proleptic Gregorian (D5)
public struct DayInterval: Sendable, Hashable, Codable { public var lo: Day; public var hi: Day }
public struct DateParse: Sendable, Codable, Equatable {                       // = dates.mjs parse output
  public var loDay: Day?; public var hiDay: Day?; public var yLo: Int32?; public var yHi: Int32?
  public var precision: String; public var basis: String; public var approx: Bool; public var rule: String
  public var label: String; public var warnings: [String] }
public enum DateGrammar { public static func parse(_ raw: String, context: DateContext) -> DateParse }
public enum Bins { public static func binOf(_ day: Day, level: Level) -> Int64; public static func fits(_ yLo: Int32, _ yHi: Int32, _ level: Level) -> Bool }
public enum JSONValue: Sendable, Hashable, Codable { case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue]) }
public enum CanonicalJSON { public static func string(_ v: JSONValue) -> String }       // sorted keys; numbers via JSNumber
public enum JSNumber { public static func format(_ x: Double) -> String }               // ECMA-262 Number::toString
public enum IDs { public static func shortHash(_ s: String) -> String; public static func fnv1a32(_ s: String) -> UInt32; public static func slug(_ s: String) -> String }
public struct Mulberry32: Sendable { public init(seed: UInt32); public mutating func next() -> Double }
public struct TokenSpan: Sendable, Equatable { public var start: Int32; public var end: Int32; public var norm: TokenID }
public struct TokenID: RawRepresentable, Hashable, Sendable { public let rawValue: UInt32 }
public enum Tokenizer {
  public static let version = "u61m-1"
  public static func spans(_ utf16: UnsafeBufferPointer<UInt16>, interner: TokenInterner, into out: inout [TokenSpan])
  public static func tokenize(_ s: String) -> [(start: Int, end: Int, norm: String)]    // convenience; tests and goldens
}
public final class TokenInterner { public init(); public func norm(_ id: TokenID) -> String }  // not Sendable; one per task
public enum Fold { public static func fold(_ s: String) -> String }                     // NSString path; ASCII fast path
public enum SentenceBreaker { public static func starts(_ s: String) -> [Int] }         // NSString .bySentences enclosing + ।/॥
public struct ViewState: Sendable, Codable, Equatable {                              // §8.2 of SPEC, grammar v1
  public init(hash: String) throws; public var hash: String { get }; public func canonicalized() -> ViewState }
public enum EvidenceStyle { public static func style(_ key: EvidenceStyleKey) -> ArcStyle }   // the only evidence → style map
public enum ReferenceCollation { public static func compare(_ a: String, _ b: String) -> ComparisonResult }
public enum Format { public static func int(_ n: Int) -> String; public static func rate(_ x: Double, unit: String) -> String
  public static func tokens(_ n: Int) -> String }                                       // byte-equal with format.mjs
public enum EngineAssert { public static func offMain(_ file: StaticString = #fileID, _ line: UInt = #line) }

// ScrollsContracts (Codable mirrors of contract 1.3.0)
public struct DocumentID: RawRepresentable, Hashable, Sendable, Codable { public let rawValue: Int64; public init(rawValue: Int64) }
//   …likewise PassageID, ExpressionID, OccurrenceID, RelationshipID, AnnotationID, RunID, ImportBatchID, CollectionID,
//   HypothesisGroupID (each encodes as a bare JSON number)
public struct Provenance: Codable, Sendable, Equatable {
  public var dataVersion: Int; public var runIds: [RunID]; public var tokenizer: String; public var segmenter: String
  public var synthetic: Bool; public var collections: [String]; public var licenses: [String] }
public struct GateCode: RawRepresentable, Codable, Sendable, Hashable { public let rawValue: String }   // generated from vocab
public struct Gate: Codable, Sendable, Equatable {
  public var code: GateCode; public var needed: JSONValue; public var have: JSONValue
  public var suggestion: JSONValue?; public var note: String?; public var reason: String? }
public protocol GatedValue: Codable, Sendable, Equatable {
  static var nullKeysWhenGated: [String] { get } }            // keys the contract writes as null on a gated object, e.g. ["value","ci"]
public enum Gated<Value: GatedValue>: Codable, Sendable, Equatable {
  case value(Value)
  case gated(Gate)
  public var code: GateCode { get }                           // "ok" for .value
}   // Codable FLATTENS into the enclosing object: {gate:"ok", …Value's keys} or {gate:<code>, needed, have, suggestion, note?, reason?,
    // <nullKeysWhenGated>: null}. No accessor returns a number: callers pattern-match. The C0 round trip proves the shape.
public struct ErrorCode: RawRepresentable, Codable, Sendable, Hashable { public let rawValue: String }   // QUERY_TIMEOUT, E_*, …
public struct ScrollsError: Error, Codable, Sendable, Equatable {
  public let code: ErrorCode; public let message: String; public let hint: String; public let detail: JSONValue?
  public static func notImplemented(area: String) -> ScrollsError }
public enum ScrollsJSON {
  public static let encoder: JSONEncoder; public static let decoder: JSONDecoder       // snake_case conversion + CodingKeys
  public static func value<T: Encodable>(_ v: T) throws -> JSONValue
  public static func canonical<T: Encodable>(_ v: T) throws -> String }
public struct CanonicalDocument: Sendable, Codable, Equatable { … }          // SPEC §12.3, field for field
public struct CanonicalRelationship: Sendable, Codable, Equatable { … }
public struct CanonicalAnnotation: Sendable, Codable, Equatable { … }
public struct Issue: Sendable, Codable, Equatable { public var code: String; public var severity: String; public var line: Int?
  public var col: Int?; public var field: String?; public var valueExcerpt: String?; public var message: String; public var suggestion: String }
```

The contract fixtures are wrappers (`{"//", method, path, owner, request, response, summary, default, example_request, variants:{name:{body}}}`). **C0 round-trips every `variants.*.body` and `default`**, not just the 65 files.

#### 8.4.6 The in-process API (frozen; one method per contract fixture)

```swift
public protocol AtlasService: Sendable {
  // health · events · jobs
  func health() async throws -> HealthResponse                                             // GET  /api/health
  var events: AsyncStream<AtlasEvent> { get }                                              // GET  /api/events
  func jobs(_ r: JobsRequest) async throws -> JobsResponse                                 // GET  /api/jobs
  func job(_ id: JobID) async throws -> JobResponse                                        // GET  /api/jobs/:id
  func jobEvents(_ id: JobID) async throws -> JobEventsResponse                            // GET  /api/jobs/:id/events
  func cancelJob(_ id: JobID) async throws -> JobResponse                                  // POST /api/jobs/:id/cancel
  // imports (commit and revert are journaled)
  func stageImport(_ r: StageImportRequest) async throws -> ImportStagedResponse           // POST /api/imports
  func setImportMapping(_ id: ImportBatchID, _ r: ImportMappingRequest) async throws -> ImportMappingResponse   // PUT
  func importPreview(_ id: ImportBatchID) async throws -> ImportPreviewResponse            // GET  …/preview
  func importProblems(_ id: ImportBatchID) async throws -> ImportProblemsResponse          // GET  …/problems.csv
  func commitImport(_ id: ImportBatchID) async throws -> ImportCommitResponse              // POST …/commit
  func revertImport(_ id: ImportBatchID) async throws -> ImportRevertResponse              // POST …/revert
  // corpora · adapters · baseline · tour · etymology (load and enable are journaled)
  func corpora() async throws -> CorporaResponse
  func facets(_ r: FacetsRequest) async throws -> FacetsResponse
  func adapters() async throws -> AdaptersResponse
  func adapterClaims(_ id: String, _ r: AdapterClaimsRequest) async throws -> AdapterClaimsResponse
  func loadAdapter(_ id: String, _ r: AdapterLoadRequest) async throws -> AdapterLoadResponse
  func enableAdapter(_ id: String, _ r: AdapterEnableRequest) async throws -> AdapterEnableResponse
  func baseline(_ r: BaselineRequest) async throws -> BaselineResponse
  func tour() async throws -> TourResponse
  func etymology(_ r: EtymologyRequest) async throws -> EtymologyResponse
  // search · expressions · timeline · passages · documents · KWIC · occurrences · exports · snapshots
  func search(_ r: SearchRequest) async throws -> SearchResponse
  func trackExpression(_ r: TrackExpressionRequest) async throws -> ExpressionResponse    // journaled
  func expression(_ id: ExpressionID) async throws -> ExpressionResponse
  func setVariants(_ id: ExpressionID, _ r: VariantsPatchRequest) async throws -> ExpressionResponse   // journaled
  func timelineQuery(_ r: TimelineQueryRequest) async throws -> TimelineQueryResponse
  func tiles(_ r: TilesRequest) async throws -> TilesResponse
  func marks(_ r: MarksRequest) async throws -> MarksResponse
  func arcs(_ r: ArcsRequest) async throws -> ArcsResponse
  func shelf(_ r: ShelfRequest) async throws -> ShelfResponse
  func bin(_ r: BinRequest) async throws -> BinResponse
  func passage(_ id: PassageID, context: Bool) async throws -> PassageResponse
  func document(_ id: DocumentID) async throws -> DocumentResponse
  func documentText(_ id: DocumentID, from: Int, to: Int) async throws -> DocumentTextResponse   // ≤ 20k UTF-16 units
  func kwic(_ r: KwicRequest) async throws -> KwicResponse
  func occurrence(_ id: OccurrenceID) async throws -> OccurrenceResponse
  func export(_ r: ExportRequest) async throws -> ExportResponse
  func createSnapshot(_ r: SnapshotCreateRequest) async throws -> SnapshotCreateResponse
  func snapshot(_ file: String) async throws -> SnapshotResponse
  // analysis
  func compare(_ r: CompareRequest) async throws -> CompareResponse
  func collocations(_ r: CollocationsRequest) async throws -> CollocationsResponse
  func clusters(_ r: ClustersRequest) async throws -> ClustersResponse
  func startRun(_ r: StartRunRequest) async throws -> StartRunResponse                     // journaled when it writes evidence (§6.2)
  func runs(_ r: RunsRequest) async throws -> RunsResponse
  func constellation(_ r: ConstellationRequest) async throws -> ConstellationResponse
  // lineage · provenance · notebook · views (writes are journaled)
  func lineage(_ r: LineageRequest) async throws -> LineageResponse
  func lineagePath(_ r: LineagePathRequest) async throws -> LineagePathResponse
  func genealogy(_ r: GenealogyRequest) async throws -> GenealogyResponse
  func relationship(_ id: RelationshipID) async throws -> RelationshipResponse
  func proposeRelationship(_ r: ProposeRelationshipRequest) async throws -> RelationshipResponse
  func review(_ id: RelationshipID, _ r: ReviewRequest) async throws -> RelationshipResponse
  func addEvidence(_ id: RelationshipID, _ r: EvidenceRequest) async throws -> RelationshipResponse
  func hypothesisGroup(_ id: HypothesisGroupID) async throws -> HypothesisGroupResponse
  func createHypothesisGroup(_ r: HypothesisGroupCreateRequest) async throws -> HypothesisGroupResponse
  func trace(_ r: TraceRequest) async throws -> TraceResponse                              // ≤ 1.5 s inline, else {job}
  func annotations(_ r: AnnotationsRequest) async throws -> AnnotationsResponse
  func createAnnotation(_ r: AnnotationCreateRequest) async throws -> AnnotationResponse
  func reviseAnnotation(_ id: AnnotationID, _ r: AnnotationPatchRequest) async throws -> AnnotationResponse
  func reinterpret(_ id: AnnotationID, _ r: AnnotationCreateRequest) async throws -> AnnotationResponse
  func withdraw(_ id: AnnotationID, _ r: WithdrawRequest) async throws -> AnnotationResponse
  func annotationRevisions(_ id: AnnotationID) async throws -> AnnotationRevisionsResponse
  func saveView(_ r: SaveViewRequest) async throws -> SavedViewResponse                    // + PortableCutoffs (§6.4)
  func views() async throws -> ViewsResponse
  func view(_ slug: String, asSaved: Bool) async throws -> SavedViewResponse              // resolved by ViewCutoffResolver
  func deleteView(_ slug: String) async throws -> DeleteViewResponse                       // soft
}

public protocol AtlasPlatform: Sendable {                      // phone-only, versioned P1; not part of contract 1.3.0
  func probe() async -> ProbeReport
  func packs() async throws -> [PackStatus]
  func installPack(_ url: URL) async throws -> PackStatus       // verify + move into Atlas/packs; Load is AtlasService.loadAdapter
  func inbox() async throws -> [InboxItem]
  func generations() async throws -> GenerationsStatus
  func installGeneration(_ url: URL) async throws -> JobID      // §3.5 steps 1–7
  func rollbackGeneration() async throws
  func rebuildGeneration() async throws -> JobID
  func storage() async throws -> StorageReport
  func purgeCaches() async throws
  func trim() async                                              // memory warning
  func replayStatus() async -> ReplayReport?
  func runSelfTest(_ suite: SelfTestSuite) async throws -> SelfTestResult
  func diagnostics() async throws -> DiagnosticsReport
}
public enum AtlasEvent: Sendable {
  case job(JobSnapshot), dataChanged(Int), adapter(AdapterStatus), bootstrap(BootstrapStatus)
  case generation(GenerationEvent), journal(UInt64), thermal(ComputeThrottle)
}
public final class LiveAtlas: AtlasService, AtlasPlatform {     // immutable stored properties; every method is @concurrent
  public static func open(_ location: AtlasLocation, conditions: any DeviceConditionsSource,
                          launch: EngineLaunchOptions) async throws -> LiveAtlas
}
public struct MockAtlas: AtlasService { public init(variant: [String: String] = [:]) }   // decodes the 65 fixtures; picks a variant per method
public struct UserWrites: Sendable {                            // §6.2: append + fsync, then apply in one tx with journal_applied
  public func perform<T: Sendable>(_ op: JournalOp, actor: String,
                                   apply: @Sendable (WriteTx, JournalEntry) throws -> T) async throws -> T
}
public struct TaskRegistry: Sendable { public static let all: [any JobTask.Type] }   // every task, each in its own module
```

#### 8.4.7 The display-list primitives (frozen; N7 builds them)

```swift
public struct TimeScale: Sendable, Equatable {
  public var centerDay: Double; public var pointsPerDay: Double; public var width: Double
  public func x(day: Double) -> Double
  public func day(x: Double) -> Double
  public var pointsPerYear: Double { get }
  public var tier: Tier { get }                                 // the thresholds of dates.tierForPpy
}
public enum Tier: Int, Sendable, CaseIterable, Codable { case millennia, centuries, decades, years, months, days }
public struct PrimID: RawRepresentable, Hashable, Sendable { public let rawValue: UInt32 }
public enum PrimRef: Hashable, Sendable {
  case occurrence(OccurrenceID), bin(BinRef), passage(PassageID), relationship(RelationshipID)
  case wash(WashRef), shelf(ShelfRef), seam(Day), band(LaneKey), none }
public struct BarPrim: Sendable, Equatable {                    // 32 bytes in the GPU buffer
  public var d0: Float, d1: Float                               // days relative to DisplayList.originDay
  public var y0: Float, y1: Float                               // lane-stack points
  public var style: UInt16, flags: UInt16                       // EvidenceStyle / BinStyle id; sparse, ¹, ≈, synthetic, censor ◁ ▷
  public var revealDay: Int32                                   // the vantage predicate (§4.23)
  public var id: PrimID }
// BandPrim, WashPrim, TickPrim, DiamondPrim, ArcPrim (d0, d1, y, height, dash, endpoint, role, review, flags, revealDay, id),
// GlyphPrim and LabelPrim (an atlas key for a shaped run) follow the same layout rules.
public struct DisplayList: Sendable {
  public var originDay: Day
  public var bands: [BandPrim], washes: [WashPrim], bars: [BarPrim], ticks: [TickPrim]
  public var diamonds: [DiamondPrim], arcs: [ArcPrim], glyphs: [GlyphPrim], labels: [LabelPrim]
  public var refs: [PrimID: PrimRef]
  public var referenceIDs: [PrimID: String]                     // display.mjs string ids, for G5
  public var lanes: [LaneSeries]                                // the numbers behind every primitive (table, Audio Graphs, sentences)
  public var simplified: SimplifiedReason?
  public var hit: HitGrid }
// Vantage, VantageMode, Visibility, visibility(revealDay:at:), DisplayList.visible(at:), HitGrid.hit(_:tolerance:vantage:) as in §4.23.
```

#### 8.4.8 The golden-fixture generator

**Node side** (`Native/Golden/`, N0's harness; each package owns its `gen-<area>.mjs`):

```
node Golden/run.mjs --families g1.core,g1.text,g2.mini,… --ref <commit> --out ~/Developer/scrolls-golden/<commit>
                    [--commit-subset Native/ScrollsKit/Tests/DifferentialTests/Golden] [--snapshots ~/Developer/scrolls-snapshots]
```

- `run.mjs` imports each `gen-*.mjs` (`export const families = { name: async (ctx) => cases }`) and writes `<family>/*.jsonl` plus `MANIFEST.json`.
- **`lib/clone.mjs`** makes `cp -c` clones of `m1r`/`m5r` in `$TMPDIR`. **It refuses any path under `~/Developer/scrolls-data` or `~/Documents`.**
- `lib/redact.mjs` applies §2.6; `lib/normalize.mjs` handles natural keys, timestamps and `data_version`; `dump.mjs` is the LogicalDump.
- `validate-contracts.mjs` runs Node's `contracts.check` over Swift-encoded responses (G7).
- `gen-core.mjs` writes G1-core and **generates three Swift files**: `ScrollsCore/Text/TokenClassTable.swift`, `ScrollsCore/Vocab.swift` with `Resources/vocab.json`, and `ScrollsCore/Copy.swift`.
- **`Tools/golden.sh`** sets `DYLD_LIBRARY_PATH` from `$SCROLLS_NODE_ENV` (default: the two Homebrew Cellar paths of §0.2) and runs `run.mjs` with the mirror's reference tree.

**Swift side** (`DifferentialTests/Support/`, N0):

```swift
public enum GoldenTier: String, Sendable { case c0, g1, g2, g3, g4, g5, g6, g7, g8 }
public enum GoldenRule: Sendable {
  case exact
  case relative(Double)                                  // |a − b| ≤ tol · max(1, |b|)
  case partition(minARI: Double)
  case subspace(k: Int, minCos: Double)
  case topK(k: Int, minJaccard: Double)
  case geometry(points: Double) }
public struct GoldenFamily<Input: Decodable & Sendable, Expected: Decodable & Sendable>: Sendable {
  public init(_ name: String, tier: GoldenTier) throws   // committed subset first, then ~/Developer/scrolls-golden/<ref>/; checks MANIFEST sha
  public func check(_ rule: GoldenRule, _ run: @Sendable (Input) async throws -> Expected) async throws -> GoldenReport }
public struct GoldenReport: Codable, Sendable { public let family: String; public let cases: Int; public let diffs: [GoldenDiff]
  public let passed: Bool }                              // the first 20 diffs; written to Native/Reports/golden-<family>.json
```

A family whose inputs are absent (private unredacted data, or snapshots missing on this Mac) **skips with a message**. A skip is not a pass, and the stage table shows SKIP.

#### 8.4.9 The app shell (N0)

```swift
@main struct ScrollsApp: App {
  @State private var model = AppModel(launch: LaunchArgs.parse(ProcessInfo.processInfo.arguments))
  @Environment(\.scenePhase) private var phase
  var body: some Scene {
    WindowGroup {
      RootView().environment(model).labPalette(.scrolls).labHaptics(model.haptics.engine).preferredColorScheme(.dark)
        .task { await model.start() }
    }
    .onChange(of: phase) { _, p in model.lifecycle.scenePhase(p) }   // haptics active, suspendAll + PASSIVE checkpoint, Inbox.scan
  }
}
@MainActor @Observable final class AppModel {
  init(launch: LaunchArgs)
  let launch: LaunchArgs; let coordinator: PresentationCoordinator; let jobs: JobsModel
  let haptics: HapticsMap; let lifecycle: Lifecycle
  private(set) var phase: AppPhase                    // .launching · .ready · .probeFailed(ProbeReport) · .integrityFailed(…) · .replaying(ReplayReport)
  private(set) var atlas: (any AtlasService)?; private(set) var platform: (any AtlasPlatform)?
  func start() async   // AtlasLocation (live or -atlasRoot) → starter clone if empty → LiveAtlas.open → probe → recoverInterrupted
                       // → journal catch-up → enqueue phase A if needed; -ui-testing uses MockAtlas
}
nonisolated struct LaunchArgs: Sendable {
  var uiTesting = false, tour = false, tourStep: Int?, corpus: String?, strand: String?
  var renderer: RendererChoice = .metal, perf = false, selfTest: SelfTestSuite?, atlasRoot: String?
  var fakeThermal: Int?, fakeLowPower = false
  static func parse(_ args: [String]) -> LaunchArgs }
nonisolated final class DeviceConditionsBridge: DeviceConditionsSource { var current: ComputeThrottle { get } }  // LabKitCore DeviceConditions.current
@MainActor @Observable final class PresentationCoordinator {   // at most one system presentation (§4.2)
  var path: [Route] = []; var modal: RootModal?; var card: CardModal?
  func push(_ r: Route); func present(_ m: RootModal); func show(_ c: CardModal); func dismissAll() }
enum Route: Hashable, Codable { case compare(CompareSeed), lineage(LineageSeed), genealogy(GenealogySeed),
                                 constellation(ConstellationSeed), notebook(NotebookSeed) }
enum RootModal: Hashable, Identifiable { case importFile(URL?), sources, savedViews, lanes, filters, legend, howItWorks, settings, jobs, yearPicker }
enum CardModal: Hashable, Identifiable { case edge(RelationshipID), node(NodeRef), hypothesisGroup(HypothesisGroupID), annotationEditor(AnnotationTarget) }
enum SheetDetent: String, Hashable, Codable { case peek, half, large }
struct RootView: View          // NavigationStack(path:) { ScrollScreen() } + .navigationDestination(for: Route.self) + .sheet(item: modal)
struct ScrollScreen: View      // ZStack { ScrollCanvas (N7) + chrome slots (N8) ; InspectorSheet(detent:) { InspectorContent (N8) } }
struct InspectorSheet<Content: View>: View { init(detent: Binding<SheetDetent>, occluded: Binding<CGFloat>, @ViewBuilder content: () -> Content) }
enum BackgroundTasks {                                          // BGTaskScheduler registration and submission
  static func registerMaintenance()
  static func submitContinued(job: JobID, title: String, subtitle: String) throws   // com.utkarsh.scrolls.job.<id>, strategy .queue
  static func scheduleMaintenance() }
nonisolated enum SelfTestSuite: String, Codable, Sendable, CaseIterable { case probe, firstMinute = "first-minute", journey, perf, packs, generation, background, full }
@MainActor protocol SelfTestSteps { static func steps(for suite: SelfTestSuite) -> [SelfTestStep] }   // one conformer per package (Steps/<Pkg>Steps.swift)
```

**Design tokens** (`Design/Tokens.swift`, N0) are SPEC §8.7 verbatim:
- `bg0` #0E1013 · `bg1` #161A20 · `bg2` #1F242C · `bg3` #2A303A · `rule` #343A45;
- `ink` #EDE6D6 · `ink2` #BDB5A5 · `ink3` #8E887B;
- `cyan` #4FD8E8 · `amber` #E8A84A · `violet` #B59AF5 · `danger` #F2826F · `ok` #7BD389 · `syn` #D9CFB8;
- the syn-stripe and hatch pattern parameters.

`LabPalette.scrolls` is built from them (signature = cyan). `Design/Components` holds the shared, opaque evidence components every panel uses. **`GateCard` has no initialiser that accepts a number.**

#### 8.4.10 N0 deliverables and exit (= M0)

**Delivers:**
- every file of §8.1 as a stub with its final signatures;
- the generated Core files and the Core ports: dates, tokenizer, fold, sentence breaker, ids, `JSNumber`, canonical JSON, `mulberry32`, viewstate, evidence style, format, collation;
- the Contracts for all fixtures, with `Gated`;
- the Store (connection, pool, writer, the profile, `RowIDPolicy`, `TextStore` Inline + Chunked, `LogicalDump`, the journal, the memory and mapping registries, the probe);
- the Jobs (queue with `after:`, context, runs, `BoundedChannel`);
- `MockAtlas` (the 65 fixtures copied into `ScrollsService/Resources/contract-fixtures/`; a test asserts they are byte-equal to `tests/contract/`), `UserWrites` and `TaskRegistry`;
- the Golden harness and `gen-core.mjs`;
- `check.sh quick` and `device-check.sh`;
- the app shell running on `MockAtlas`: the root, the inspector overlay, the coordinator, the design tokens, Diagnostics with the probe view, and the self-test runner.

**Exit criteria (M0 gate):**
1. **C0:** every fixture body and variant round-trips; **G1** is exact for N0's families.
2. **Store tests:**
   - `schema.sql` sha equals `server/db/schema.sql`; the DDL and profile execute;
   - every trigger fires and every CHECK rejects;
   - WAL readers see one snapshot; interrupt acknowledged ≤ 500 ms; the deadline produces `QUERY_TIMEOUT`;
   - `RowIDPolicyTests` complete; the chunk codec round-trips on all Unicode planes;
   - **LogicalDump Swift = Node** on the reference's mini fixture database (read through `InlineTextStore`);
   - the journal's append, CRC, torn-line and fsync tests; `StallTests`.
3. **`LintTests`:**
   - no `String.lowercased()` in `ScrollsKit/Sources`;
   - no inline SQL outside catalogues;
   - no `import LabKit*` in ScrollsKit;
   - **no networking API** (`URLSession`, `Network`, `NWConnection`, sockets) anywhere in `Native/` (ΔS-17).
4. **The app** builds for the simulator and **installs and launches on his iPhone 15 Pro Max**. `-selftest probe` passes there and writes `probe.json`, covering:
   - SQLite and FTS parity;
   - the hash of the sentence boundaries of 3 bundled books equal to the Mac's;
   - Final_Sigma;
   - the Kohinoor faces;
   - NL availability;
   - memory and VM, and the BG identifiers.
5. **Build throughput** is measured and written to `Native/Docs/BUILD.md`: a clean build, an incremental `quick --wp` per package, and a simulator app build, each with the load average.
6. **A first transfer measurement:** one raw `xcrun devicectl device copy to` of a 236 MB file into the app's `Documents/Import/`, with MB/s and the cable type recorded in BUILD.md. N2's `transfer-bench` later automates this.

### 8.5 The parallel packages (start together after the M0 merge; each finishes its M1 slice first)

**Rules every package shares:**
- UI work builds against `MockAtlas` until its engine lands. Engine work implements its own `LiveAtlas+<Area>.swift`.
- Every package fills its own `Diagnostics/Steps/<Pkg>Steps.swift` with the device self-test steps of its acceptance rows, so the device rows are commands.
- Two cross-package protocols are frozen at M0 so that work can proceed in parallel:
  - **`DocumentWriting`**: the stub is `ScrollsIngest/Writer/DocumentWriting.swift`, owned by N1, and N2 develops against a fake of it;
  - **`BoilerplatePass`**: the stub is `ScrollsLineage/Boilerplate/BoilerplatePass.swift`, owned by N5, and N2's pipelines call it.

#### N1 — Ingest and import

- **Owns:** `ScrollsIngest/**`, `ScrollsService/LiveAtlas+Imports.swift`, `Scrolls/Import/**`, `Golden/gen-pipeline.mjs`, `Tests/ScrollsIngestTests/**`, `DifferentialTests/Ingest/**`, `ScrollsUITests/ImportUITests.swift`, `Steps/N1Steps.swift`.
- **Consumes:** Core, Contracts (`Canonical*`, `Issue`), Store (`Writer`, `RowIDAllocator`, `ChunkedTextStore.Writer`), Jobs, and the `importCommit`/`importRevert` journal ops.
- **M1 slice:**
  - **`DocumentWriter`**, with every write of `document-writer.mjs`:
    - document, `document_text` + chunks, passages + FTS, fields, aliases, tags;
    - date assertions + R-tree, `doc_bin`, `doc_tokens`, minhash, the dup index;
    - relationships, with compact create revisions;
    - commits every 5,000 documents, 50,000 rows or 2 s.
  - **Text:** the `seg-1` segmenter and langid.
  - **Formats:** TXT, MD (front matter), CSV/TSV, JSON, JSONL; sniffing and decoding (UTF-8, Windows-1252).
  - **The import flow:** mapping and suggestions; the validate dry run (a read-only job with progress); the journaled commit and revert jobs; the summary; `problems.csv`.
  - **The wizard** (4 steps) with `fileImporter`. Open-in-Scrolls URLs reach it through N8's `DeepLinks` as `RootModal.importFile(url)`.
- **M2:** streaming 2 GB files, line mode, mapping reuse, the near-duplicate resolution UI.
- **Tests (including differential):**
  - G1 segment and langid families;
  - **G2 exact** for the mini, ingest and demo dumps (Swift-built against Node-built);
  - malformed-input issues byte-equal (code, line, col, message, suggestion);
  - offsets: every passage slice through `TextStore` equals Node's;
  - `abort` and a mid-commit fatal error leave zero documents.
- **Acceptance:**
  - sim: `letters.csv` → accepted 37 / warnings 2 / rejected 1 exactly;
  - **device:** a CSV pushed to `Documents/Import/` → wizard → summary → Open in timeline → Revert; a 50 MB CSV dry run ≤ 20 s; the import replays from the journal.

#### N2 — Sources, packs, generations and the CLI

- **Owns:** `ScrollsSources/**`, `ScrollsStore/Pack/**`, `ScrollsService/{LiveAtlas+{Corpora,Adapters,Tour,Baseline,Etymology},LivePlatform}.swift`, `ScrollsService/{Pipelines,Generations}/**`, `scrolls-cli/Commands/{Pack,Starter,Atlas,Fingerprint,ConvertReference,Bench}.swift`, `Scrolls/Sources/**`, `Tools/{packs.sh,atlas.sh,check.d/slice.sh}`, `Golden/{gen-sources.mjs,slices.mjs}`, `Tests/ScrollsSourcesTests/**`, `DifferentialTests/Sources/**`, `Steps/N2Steps.swift`, and the `Resources/Bundled` build products.
- **Consumes:** `DocumentWriting` (N1), `BoilerplatePass` (N5), and job types by name (the vectors and reuse-index jobs are enqueued, never imported).
- **M1 slice:**
  - **Packs:** the pack format; `scrolls-cli pack`; `Tools/packs.sh` (demo, cipher-meta, cipher-text).
  - **The starter:** `scrolls-cli starter` builds slot 0 (seeded vocab + the demo world + its runs).
  - **Adapters:** the demo adapter; the Cipher adapters (works, themes, roots, siblings and tags provenance for phase A; relations for A2; books, Gutenberg text and Wikisource for B), run by `Pipelines/BootstrapCipher.swift`. It is resumable from committed rows, journals each phase as a `sourceLoad`, and calls `BoilerplatePass` after the text.
  - **Routes:** corpora, facets, tour, etymology.
  - **The Sources & storage UI**, including *Keep building when I leave Scrolls* (it submits the continued-processing task); the Inbox scan; `LivePlatform`'s packs, storage and probe.
- **M2:**
  - **STEMM adapters:** gutenberg-stemm (translation flags, field map), OpenAlex (`sample_cell` kept verbatim, citations, date conflicts), Wiktionary claims (attached to tracked expressions too), the Ngram attach and the baseline route; the `stemm` pack.
  - **Generations:** `scrolls-cli atlas build --notebook`, `.scrollsatlas`/`.scrollsarchive`; `Tools/atlas.sh` push, pull, fingerprint and transfer-bench; install, swap, rollback and rebuild on the phone; the free-space guard.
- **Tests:**
  - **G2 exact** on the Cipher and STEMM slices;
  - the reconciliation counts of SPEC §6.8: 94,385 works · 179,014 relation endpoints · 691 + 450 + 375 books · 118,466 OpenAlex works · 381,800 citations · 6,666 date conflicts flagged and 0 drawn as feedback;
  - the demo calibration (SPEC §9.6);
  - **G6:** the starter rebuilt on the device = the bundled one, then the full generation phone = Mac;
  - kill during phase B → resume from the cursor with no duplicates (fingerprint);
  - D17 across a load and a swap (with N6).
- **Acceptance (device):**
  - first frame ≤ 1.0 s; phase A ≤ 60 s; A2 ≤ 90 s;
  - phase B ≤ 20 min, surviving a kill and running under continued processing;
  - the STEMM pack pushed and loaded ≤ 40 min;
  - a CLI-built generation swapped in with the notebook intact; phone = Mac fingerprints;
  - transfer MB/s recorded.

#### N3 — Query, search and exports

- **Owns:** `ScrollsQuery/**`, `ScrollsService/LiveAtlas+{Search,Expressions,Timeline,Passages,Documents,Kwic,Occurrences,Exports,Snapshots}.swift`, `scrolls-cli/Commands/DiffRead.swift`, `Scrolls/Exports/**`, `Golden/{gen-read.mjs,requests/read/**}`, `Tools/check.d/read.sh`, `Tests/ScrollsQueryTests/**`, `DifferentialTests/Read/**`, `Steps/N3Steps.swift`.
- **M1 slice:**
  - search: typed suggestions, `label_tri`, FTS counts, **transliteration candidates**;
  - expressions and variants (en/fr/es/hi/gu, orthographic);
  - materialise + `expr_doc` + the name guard (chunk reads, `TokenInterner`);
  - the slice cube (an mmap'd file at RF-1's cube version);
  - timeline query, tiles, washes, marks, shelves, bin, coverage, seams, lanes and rates;
  - passages, documents, text slices, KWIC, occurrences;
  - JSON/JSONL/CSV exports with the manifest; snapshot storage; the `ShareLink` Transferables (Exports UI).
- **M2:** arcs + summaries (C4), feedback and date conflicts; the very-frequent path; the Term trail (C2); OpenAlex share cells (C3); the tag index; collection statistics.
- **Tests:**
  - G1 for variants, translit, names and KWIC;
  - **G3 on m1r (M1) and m5r (M2)** through `InlineTextStore`;
  - conservation at every tier for 50 random filter combinations;
  - offsets 100% exact;
  - cube = SQL denominators on 1,000 random slices;
  - `SQLCatalog` plan tests;
  - `export_text_allowed = 0` respected in every format.
- **Acceptance (device, full Cipher):** *virus* search ≤ 150 ms; materialise *bank* ≤ 1.5 s; tiles warm ≤ 16 ms and cold ≤ 120 ms; a 20-mark sample opens at exact offsets; Term trail first query ≤ 1.5 s (M2).

#### N4 — Analysis, Compare and Constellation

- **Owns:** `ScrollsAnalysis/**`, `ScrollsNL/**`, `ScrollsService/LiveAtlas+{Compare,Collocations,Clusters,Analysis,Constellation}.swift`, `scrolls-cli/Commands/DiffAnalysis.swift`, `Scrolls/{Compare,Constellation}/**`, `Golden/{gen-analysis.mjs,requests/analysis/**}`, `Tools/check.d/analysis.sh`, `Tests/ScrollsAnalysisTests/**`, `DifferentialTests/Analysis/**`, `Steps/N4Steps.swift`.
- **M1 slice:**
  - **Compare:** the multiplicity log; coverage, composition, modality and prominence; frequency + CIs; passages with a seed; gates with widening suggestions; as-saved per RF-2;
  - **exact f64 statistics:** intervals, bootstrap, gates;
  - collocations and keyness; token streams;
  - **the Compare UI:** the stacked panels, gate cards with [Apply], the range strip, landscape A | B.
- **During M2:** the pure kernels against fixtures (k-means, PPMI blocks, rSVD, Procrustes).
- **M3:**
  - TF-IDF hash; co-occurrence, PPMI and rSVD on Accelerate (in blocks); the `vectors` task (pooled + era slices) with **automatic scheduling on the phone**; Procrustes; occurrence vectors;
  - **exact k-means** with stability, labels, transitions and convergence; drift;
  - tone and modern-reader neighbours, with the NL availability gates;
  - `layout` and the constellation (overlay);
  - Compare's context-group and displacement panels.
- **Tests:**
  - G1 stats;
  - **G3 Compare** exact / 1e-9 (40 pairs covering every gate code);
  - **G4** within §2.4, plus k-means exact on the reference's vectors;
  - `Gated` shows no numeral (by type, and by a UI text scan);
  - a responsiveness test: no hitch while clustering and the vectors job run.
- **Acceptance (device):** Compare ≤ 1.5 s (M1); *bank* clusters ≤ 15 s, cancellable in ≤ 500 ms; the English pooled space built **on the phone** in ≤ 3 min with peak ≤ 600 MB; drift ≤ 6 min; constellation ≤ 300 ms (M3).

#### N5 — Lineage

- **Owns:** `ScrollsLineage/**`, `ScrollsService/LiveAtlas+{Lineage,Genealogy,Trace}.swift`, `Scrolls/Lineage/**` (the explorer, genealogy, `EdgeCardView`, chain of custody, the hypothesis-group card), `Golden/{gen-lineage.mjs,requests/lineage/**}`, `Tools/check.d/lineage.sh`, `Tests/ScrollsLineageTests/**`, `DifferentialTests/Lineage/**`, `Steps/N5Steps.swift`.
- **M1 slice:** `BoilerplatePass` (phase B needs it: the "computer virus" canary); minhash and winnowing primitives.
- **M2:**
  - the **global reuse index on the phone** (per collection, with an external merge);
  - near quotes; cues (5 languages) and cue links; classify, commonplace, carry and filters;
  - the targeted trace; the lineage graph and path; hypotheses; genealogy;
  - the Lineage and Genealogy UI;
  - `EdgeCardView` with the review actions (they write through N6's API).
- **Tests:**
  - G1 minhash and winnow;
  - **G2 boilerplate canary:** 0 `ok` passages contain the licence sentence;
  - G3 lineage, genealogy and trace on m1r and m5r;
  - G4 reuse-index sets exact on m5r;
  - the demo detector finds A11→A4, A20→A3 and A13→A3 (proposed + CUE), and creates **no** documented edge.
- **Acceptance (device):** genealogy of *Funky Drummer* 32 / 98 / 48 works over 3 generations; trace of a 13-token span ≤ 1.5 s; the reuse index ≤ 8 min with peak ≤ 600 MB.

#### N6 — Provenance, journal and notebook

- **Owns:** `ScrollsProvenance/**`, `ScrollsService/LiveAtlas+{Relationships,Hypotheses,Annotations,Views}.swift`, `ScrollsService/{JournalReplayer,ViewCutoffResolver}.swift`, `scrolls-cli/Commands/Api.swift`, `Scrolls/{Notebook,Views}/**`, `Golden/gen-journey.mjs`, `Tools/check.d/journey.sh`, `Tests/ScrollsProvenanceTests/**`, `DifferentialTests/Journey/**`, `Steps/N6Steps.swift`.
- **M1 slice:**
  - **annotations:** create, revise, reinterpret, withdraw; revisions; as-of by timestamp; D18 anchors;
  - **saved views:** immutable, `slug~n`, as-saved, the drift report, **portable cutoffs**;
  - **relationships:** review, propose, evidence, hypothesis groups; revision expansion;
  - **the journal:** the op handlers, `JournalReplayer`, crash recovery;
  - **the Views UI:** the save flow, the saved-views sheet with thumbnails, the as-saved banner; the Annotate editor card.
- **M2:** D17 across loads and generations (with N2); replay waiting for packs.
- **M3:** the full Notebook (layers, dimensions, a revision scrubber with one stop per revision, compare interpretations, machine annotations, orphaned interpretations); the notebook export.
- **Tests:** everything in §6.7; **G7 on m1r (M1) and m5r (M2)**, writes included; `JournalPolicyTests` (with N0).
- **Acceptance (device):**
  - save a view → force quit (`devicectl device process terminate`) → reopen byte-identical;
  - restore simulation (delete the atlas, keep `Notebook/`, rebuild) → annotations and views intact, and as-saved counts identical;
  - the live journal head is unchanged after every self-test.

#### N7 — The Scroll

- **Owns:** `ScrollsScrollModel/**` (except `Primitives`, `TimeScale` and `Vantage`), `ScrollsRender/**`, `Scrolls/Scroll/**`, `Golden/gen-display.mjs`, `Tools/Scrolls.tracetemplate`, `Tools/check.d/display.sh`, `Tests/{ScrollsScrollModelTests,ScrollsRenderTests}/**`, `DifferentialTests/Display/**`, `ScrollsUITests/ScrollGestureTests.swift`, `Steps/N7Steps.swift`.
- **M1 slice:**
  - the ports of scale, tiers, model, display and hit, plus `visible(at:)`;
  - **the Metal renderer:** bands, washes, bars, ticks, glyphs, labels, the overlay, the patterns;
  - **`DisplayListCanvas`** (`-renderer canvas`) and the PNG snapshot;
  - the UIKit gesture host; the playhead, Play, strict/context, the vantage uniform and fades;
  - the ruler, minimap, coverage track and seam; lane headers and shelf chips;
  - tap sentences, the ambiguity chooser, the mark-preview context menu, the ruler brush;
  - **VoiceOver** (lanes, children, rotors, the adjustable playhead, Magic Tap) and Audio Graphs; the table alternative; `PerfHUD`; `LabelAtlas`, including Indic runs.
- **M2:** arcs, bundles, feedback arcs, halos and date conflicts; ⑂/⑃ glyphs; the folded overview and the pinch-out; etymology bands and the roots bracket; claim diamonds; the baseline track; share cells; `SVGWriter`. Cluster lanes render as soon as N4's M3 data exists.
- **Tests:**
  - **G5** exact / ±0.01 pt, including the vantage sweep;
  - **G8** ≤ 1%;
  - table identity; hit-grid vantage filtering; `LabelAtlasTests` (Indic);
  - gesture UI tests; perf signposts.
- **Acceptance (device):** every row of the §4.23 budget table; zero idle frames; Reduce Motion behaviours; VoiceOver reads a lane summary and every rotor works.

#### N8 — Shell, inspector and the experience

- **Owns:** `Scrolls/Shell/{TopBar,StrandChips,MoreMenu,LandscapeShell,HapticsMap,StateRestoration,DeepLinks}.swift`, `Scrolls/{Inspector,Search,Tour,Settings,Jobs,Legend,Lanes}/**`, `ScrollsUITests/{FirstMinuteTests,AccessibilityAuditTests,StateRestorationTests}.swift`, `ScrollsAppTests/IndicTypographyTests.swift`, `Tools/check.d/app.sh`, `Steps/N8Steps.swift`.
- **M1 slice:**
  - **chrome:** the TopBar (the corpus chip, the strand-chip morph, the status chip, More) and the ribbon's placement;
  - **the Search UI** (typed, romanised);
  - **the inspector's Then:** passage, date chip, document card, the TextKit 2 reader, contemporary uses;
  - the bin drawer and the shelf lists;
  - the Lanes, Filters and Legend sheets; the Jobs tray;
  - **the tour:** coach marks ①②③, *Your turn*, Switch to Cipher;
  - How Scrolls works (`LabInfoSheet`), Settings and the haptic map;
  - state restoration; deep links (`scrolls://`, and Open in Scrolls routing);
  - the first-minute XCUITest.
- **M2:** the Crossings card, the Term trail presentation, the landscape inspector column.
- **M3:** the Now and Next tabs, and the hypothesis UI (with N6).
- **M4:** the full 10-step tour; accessibility audits passing; layouts at accessibility sizes.
- **Tests:**
  - `FirstMinuteTests` (signposts on the simulator; the device timing via `-selftest first-minute`);
  - `AccessibilityAuditTests`, `StateRestorationTests`;
  - `IndicTypographyTests` (reader, KWIC, chips);
  - `CopyLintTests` over its own `*Copy.swift` files.
- **Acceptance (device):**
  - **the first-minute script timed:** demo frame ≤ 1.0 s; coach ① at 2 s; *Your turn* by 60 s, with Switch to Cipher enabled once phase A finishes in ≤ 60 s;
  - the main flow works one-handed in portrait and in landscape;
  - layouts hold at accessibility sizes;
  - state is restored after a kill.

### 8.6 Integration packages (one per milestone; owner I — the N0 agent once N0 is done, or a dedicated agent)

- **Owns:** `Native/README.md`, `Native/Docs/{HANDOFF,VERIFICATION,DEVICE-RUNS}.md`, `Native/Docs/status/I.md`, `Tools/check.d/full.sh`, `ScrollsUITests/JourneyTests.swift`, `Native/Reports/milestones/**`.
- **For each milestone (I-M1 … I-M4):**
  1. **Freeze.** Every package's slice is marked done in its status file on the milestone's `ref-freeze-n` tag (rebased per §2.1).
  2. **Merge in contract order:** N0 → N1 → N2 → N3 → N4 → N5 → N6 → N7 → N8, with `check.sh quick` green after each.
  3. **`check.sh full`.** Failures go back to their owners.
     - **Ownership lapses only** for an integration patch of ≤ 30 lines that comes with a test.
     - Each such patch is logged (file, reason, test) in VERIFICATION, as SPEC §12.5 does.
  4. **The device session,** with Utkarsh present, phone unlocked and on its cable:
     - `device-check.sh` for the milestone's suites, then the manual walk-through with screenshots (`Reports/milestones/<M>/shots/`);
     - queued `PENDING_DEVICE` rows are cleared here.
  5. **VERIFICATION section:** every gate row → PASS / FAIL / PENDING_DEVICE with its evidence file, the measured budgets, and the DIVERGENCES state. **A milestone with an open FAIL or an open exact-module DV is not done.**
  6. **Commit and tag** `native-M<n>` in the existing repo (`~/Developer/git/Scrolls.git`), with the attribution lines.
- **I-M4 also writes HANDOFF** in three parts:
  - what works;
  - what needs a pack, a run or Apple's on-device assets;
  - what is unfinished (from §7.3).

### 8.7 Milestones (an app that runs on his phone at every one)

| Milestone | Packages | Exit gate (device rows need his phone; sim/mac rows may pass earlier) |
|---|---|---|
| **M0 Foundation** | R, N0 | §8.3 acceptance and §8.4.10. `ref-freeze-1` tagged; `m1r` and `m5r` built. The app shell on his iPhone with `MockAtlas`; `-selftest probe` passes on the device. |
| **M1 — the vertical slice on his iPhone** | N1–N8 M1 slices, I-M1 | **On the device, from a fresh install:** <br>1. the demo paints in ≤ 1.0 s and the coach marks run; <br>2. phase A finishes in ≤ 60 s and *Switch to Cipher* enables; <br>3. search *zero*, and *shunya* to reach शून्य/શૂન્ય; <br>4. the Scroll shows honest bars, washes, shelves, coverage and the seam; <br>5. tap a mark → its passage at exact offsets (20 of 20 sampled); <br>6. Compare: coverage first, frequency with CIs, collocates, gates; <br>7. save the view → force quit → relaunch: the state is restored and the view reopens identical. <br>Also: `letters.csv` imports from Files with exact counts, and phase B completes within its bound and survives a kill. <br>**Gates:** C0, G1, G2 (mini, ingest, demo, Cipher slice), G3 on m1r, G5 for the M1 families, G7 on m1r, G8; the §5 M1 rows on the device; zero open DV in exact modules. |
| **M2 — full corpus and lineage on the phone** | N1–N8 M2 parts, I-M2 | STEMM pack loaded **on the phone**; G2 STEMM slice; G3 on m5r; **G6 phone = Mac** for a full generation; D17 holds across a load, a swap and a restore; *Funky Drummer* 32/98/48; trace ≤ 1.5 s; the reuse index built on the phone; C4 arcs at STEMM scale; Term trail; share cells; etymology bands; the folded overview; G7 on m5r; transfer MB/s recorded. |
| **M3 — analysis on the phone** | N4, N6, N7, N8 M3 parts, I-M3 | Cipher *bank* gives the reference's two groups ('money · account · notes · mr', 'river · along · water · stream') within §2.4, in ≤ 15 s; the English space built on the phone in ≤ 3 min; drift; collocations; the Tone gate behaves on the device; the overlay constellation; the full notebook; G4. |
| **M4 — polish and handoff** | all, I-M4 | The full tour; accessibility audits pass; every §5 row measured on the device; landscape; VoiceOver walk-through recorded; HANDOFF and README written. |

### 8.8 Order and coordination

1. **Phase 0.** N0 runs alone on `Native/` while R works on the reference. N0's G1-core goldens may come from HEAD; every other family waits for `ref-freeze-1`. N0 also pre-checks that every placeholder of §8.9 exists, and stops if one is missing.
2. **Phase 1.** N1–N8 start together on their M1 slices. N4 and N5 may also build their pure kernels (exact k-means, winnowing, minhash, PPMI blocks) against fixtures alongside.
3. **Phases 2–4** follow the milestones. Each ends with its integration package.
4. **Device time** is a resource:
   - agents never block on it (`PENDING_DEVICE`);
   - I batches device rows into one session per milestone, plus ad-hoc sessions whenever Utkarsh is available;
   - `Native/Reports/device-queue.json` is the queue.
5. **Contract changes** go through N0, additively, and are recorded in `status/N0.md`. **Golden regeneration** goes through N0 or I only.

### 8.9 Placeholder files the lead must pre-create (agents cannot create `.md` files)

Each starts with `<!-- OWNER: <package> — <purpose> -->` and a title line.

| File | Owner | Purpose |
|---|---|---|
| `Native/README.md` | I | setup, build, run, the launch arguments, where the data lives |
| `Native/Docs/HANDOFF.md` | I | works / needs a pack, run or Apple assets / unfinished |
| `Native/Docs/VERIFICATION.md` | I | one section per milestone: gate rows, evidence, budgets, patch log |
| `Native/Docs/DEVICE-RUNS.md` | I | every device session: date, build, suites, results, thermal and memory notes |
| `Native/Docs/BUILD.md` | N0 | mirrors, build-time measurements, `check.sh` stages, toolchain notes |
| `Native/Docs/PORT-MAP.md` | N0 (one section per package; each edits only its own) | the living §1.3: reference file → Swift file → status |
| `Native/Docs/DIFFERENTIAL.md` | N0 (sections per tier owner) | golden families, rules, the regeneration log |
| `Native/Docs/DEVICE-DATA.md` | N2 | the measured storage budget, the device profile and slots as built |
| `Native/Docs/PACK-FORMAT.md` | N2 | `SPK1`, `.scrollsatlas`, `.scrollsarchive`, `ATLAS.json` |
| `Native/Docs/JOURNAL.md` | N6 | the journal format, the ops, replay, portable cutoffs as built |
| `Native/Docs/RENDERER.md` | N7 | the pipeline, shaders, budgets as measured, the G8 results |
| `Native/Docs/EXPERIENCE.md` | N8 | the first-minute timings as measured, copy decisions, the haptic map as built |
| `Native/Docs/REFERENCE-CHANGES.md` | R | RF-1…RF-n and findings, each with its test and tag |
| `Native/Docs/status/R.md`, `N0.md`, `N1.md`, `N2.md`, `N3.md`, `N4.md`, `N5.md`, `N6.md`, `N7.md`, `N8.md`, `I.md` | the named package | progress, evidence, pending device rows, contract requests, rebase notes |

Not needed as Markdown:
- **Fixture and golden folders** carry `MANIFEST.json`.
- **Pack `FORMAT.md` files** are archive members written by `scrolls-cli pack`, not repository files.
- **Reports** are JSON.

---

*Guiding principle, kept for the phone: an expression carries its past into each new encounter. On the phone every number carries its past too: the reference computation it equals, the tolerance it was checked against, and the journal entry and generation it came from.*
