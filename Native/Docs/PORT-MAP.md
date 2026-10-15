<!-- OWNER: N0 — the living IOS-SPEC §1.3: reference file → Swift file → status (one section per package) -->
# Port map

The living form of IOS-SPEC §1.3. **One section per package; each package edits only its own section** (N0 wrote the
first version of every section at the M0 stitch, from the files that exist on 2026-10-10).

Status: **P** ported 1:1 and differential-tested · **R** redesigned (same contract, new mechanism) · **N** new on the
phone · **D** dropped · **stub** the file exists with its final signatures and answers `NOT_IMPLEMENTED` (or, for a
non-throwing frozen signature, stops with a message) until its owner lands it · **—** not created yet (the package
names the files). Paths are relative to `Native/`; reference paths to `Scrolls/`.

## N0 — foundation

| Reference | Swift | St | Evidence |
|---|---|---|---|
| `src/shared/tokenize.mjs` | `ScrollsKit/Sources/ScrollsCore/Text/{Tokenizer,TokenClassTable (generated),Fold,TokenInterner}.swift` | P | G1 token-classes (all 1,114,112 code points), tokenize, tokenize-corpus (private), fold (1,112,111 checks), text-helpers: 0 mismatches |
| `Intl.Segmenter` sentence starts (`text/segment.mjs` long-block splits) | `ScrollsCore/Text/SentenceBreaker.swift` | P | G1 sentences (273) and sentences-books (private, 673,566 / 673,566); the simulator probe hashes 3 bundled books = Node's (`Reports/probe-sim.json`); device PENDING_DEVICE (DV-3) |
| `src/shared/dates.mjs` | `ScrollsCore/Dates/{DayMath,DateGrammar,DateParse,Bins,Labels}.swift` | P | G1 daymath, dates, date-labels, bins |
| `src/shared/vocab.mjs` | `ScrollsCore/{Vocab,Copy} (generated)`, `VocabSupport.swift`, `Resources/vocab.json` | P | G1 vocab (every export) |
| `src/shared/ids.mjs` | `ScrollsCore/IDs.swift` | P | G1 ids (1,540) |
| `JSON.stringify` / `Number::toString` / `Math.log*` | `ScrollsCore/{JSONValue,CanonicalJSON,JSNumber,JSMath,JSString}.swift` | P | G1 canonical-json, jsnumber (20,552), js-math (bit-exact) |
| `mulberry32` (`analysis/bootstrap.mjs`) | `ScrollsCore/Mulberry32.swift` | P | G1 mulberry32 (32 seeds × 300 draws) |
| `src/shared/format.mjs` | `ScrollsCore/Format.swift` | P | G1 format (6,205) |
| `src/shared/evidence-style.mjs` | `ScrollsCore/EvidenceStyle.swift` | P | G1 evidence-style (2,214) |
| `src/shared/viewstate.mjs` | `ScrollsCore/ViewState{,+Canonical,+Hash}.swift` | P | G1 viewstate (561) |
| `localeCompare(…, 'en')` | `ScrollsCore/ReferenceCollation.swift` | P | G1 collation (3,100); DV-4 open until the M1 sweep over every label |
| — | `ScrollsCore/{EngineAssert,Generated/BuildInfo}.swift` | N | `Tools/gen-buildinfo.sh` |
| `src/shared/contracts.mjs`, `tests/contract/*.json` | `ScrollsContracts/**` | R | C0: 260 / 260 bodies byte-equal in canonical JSON (`Reports/c0-contracts.json`) |
| `server/db/schema.sql`, `seed-vocab.mjs`, `migrate.mjs` | `ScrollsStore/Resources/{schema.sql,device-profile.sql}`, `Migrations.swift`, `SeedVocab.swift` | P + N | schema sha256 equal; 119 / 119 CHECKs reject; 12 / 12 triggers fire |
| `server/db/{open,readpool,readworker}.mjs` | `ScrollsStore/SQLite/{Connection,Statement,Row,SQLValue,SQL,Pragmas,ReadConnection,ReadPool,Writer,WriteLease,StoreFailures}.swift` | R | ScrollsStoreTests 57; interrupt ≤ 500 ms; QUERY_TIMEOUT; one snapshot per read |
| `server/db/integrity.mjs` | `ScrollsStore/Atlas/Integrity.swift` | R | `quick_check(100)` at open |
| `server/config.mjs` | `ScrollsStore/Atlas/AtlasLocation.swift` | R | iCloud refusal, `-atlasRoot` isolation |
| — (§1.4 probe) | `ScrollsStore/Atlas/{Probe,ProbeSQL}.swift` | N | `Reports/probe-mac.json`, `Reports/probe-sim.json` (simulator PASS) |
| — (§3.3) | `ScrollsStore/{RowIDPolicy,Identifiers}.swift` | N | RowIDPolicyTests |
| — (§3.4) | `ScrollsStore/Text/{TextStore,ChunkedTextStore}.swift` | N | every Unicode plane round-trips; chunked dump = inline dump (DV-11, mini database) |
| — (§2.3) | `ScrollsStore/Dump/{LogicalDump,CompactRevisions}.swift`, `Resources/dump-spec.json` | N | LogicalDump Swift = Node on the mini database: 50 / 50 tables byte-equal (`Reports/golden-logicaldump-mini.json`) |
| — (§6.2) | `ScrollsStore/Journal/{JournalTypes,JournalFile}.swift` | N | JournalTests (CRC, torn line, rotation, fsync) |
| — (§3.8) | `ScrollsStore/Atlas/Memory.swift` | N | memory admission, mapping budget |
| `server/jobs/{queue,worker,job-rows,context}.mjs` | `ScrollsJobs/{JobQueue,JobRows,JobContext,JobTask,JobTypes,Runs,BoundedChannel,ConcurrentMap,ComputeThrottle}.swift` | R | ScrollsJobsTests 27 incl. StallTests (30 s statement: ≥ 120 increments) |
| — (§8.4.10 device rows) | `ScrollsJobs/SelfTest/{EngineSelfTest,SelfTestSQL}.swift` | N | EngineSelfTestTests; on the simulator: read interrupt 0.09–0.24 ms, job cancel 0.27–1.8 ms, stall rule 120 increments in 30 s |
| `server/routes/{health,jobs,events}.mjs`, `server/http/mock.mjs` | `ScrollsService/{AtlasService,AtlasPlatform,Events,LiveAtlas,LiveAtlas+Health,LiveAtlas+Jobs,MockAtlas,UserWrites,TaskRegistry}.swift`, `Resources/contract-fixtures/` | R | ScrollsServiceTests 17; MockAtlas serves all 65 fixtures |
| `src/ui/timeline/{scale,tiers}.mjs` (thresholds), `display.mjs` `vantageState` | `ScrollsScrollModel/{Primitives,TimeScale,Vantage}.swift` | P (frozen types) | PresentationTests (tier thresholds = `tierForPpy`, vantage predicate) |
| `scripts/verify.mjs` (dump, probe parts) | `scrolls-cli/{main,Commands/Dump,Commands/Probe}.swift` | R | `scrolls-cli dump` = dump.mjs on the mini database |
| `src/ui/{core,shell}` (shell, design tokens, gate card, ribbon) | `Scrolls/{App,Design,Shell,Diagnostics}/**`, `Scrolls/Resources/**` | R | the shell on MockAtlas on the simulator; `-selftest probe` PASS |

## N1 — ingest and import

| Reference | Swift | St |
|---|---|---|
| `server/store/document-writer.mjs` | `ScrollsIngest/Writer/{DocumentWriting (frozen protocol),DocumentWriter,FTSWriter,TextChunker,DateWriter,TagWriter,RelationshipWriter}.swift` | stub |
| `server/store/bins.mjs` | `ScrollsIngest/Writer/Bins.swift` (`DocBins`: not `Bins`, which is ScrollsCore's) | stub |
| `server/store/dup-index.mjs` | `ScrollsIngest/Writer/DupIndex.swift` | stub |
| `server/text/segment.mjs`, `text/langid.mjs` + stopwords | `ScrollsIngest/Text/{Segmenter,LangID}.swift`, `Resources/stopwords` (—) | stub |
| `server/ingest/*` | `ScrollsIngest/ImportPipeline.swift`, `ScrollsIngest/{Formats,Mapping}/**` (—) | stub |
| `server/jobs/tasks/{import,revert}.mjs` | `ScrollsIngest/Tasks/*` (—) | — |
| `server/routes/imports.mjs` | `ScrollsService/LiveAtlas+Imports.swift` (6 methods) | stub |
| `src/ui/import/*` | `Scrolls/Import/**` (—) | — |
| — | `Golden/gen-pipeline.mjs` (g1.segment, g1.langid, g2.mini, g2.ingest, g2.demo), `Scrolls/Diagnostics/Steps/N1Steps.swift`, `ScrollsUITests/ImportUITests.swift`, `Tests/ScrollsIngestTests/IngestStubTests.swift` | stub |

## N2 — sources, packs, generations and the CLI

Status as of the M1 round (2026-10-13). P = ported 1:1 and differential-tested · W = written, tested by unit tests or
self-tests only · N = new · M2 = later.

| Reference | Swift | St |
|---|---|---|
| `server/adapters/api.mjs` | `ScrollsSources/SourceAdapter.swift` (frozen protocol), `AdapterSupport.swift` (etymons, theme associations, aliases, record issues, batching), `SourceFiles.swift` (pack members, `keep` = keepOriginal) | W |
| `server/adapters/registry.mjs` | `ScrollsSources/SourceRegistry.swift` (adapters, file adapters, corpus and slot per adapter) | W |
| `server/adapters/demo/demo.mjs`, `data/demo/*` | `ScrollsSources/Demo/DemoAdapter.swift` (+ `DemoPack`), `Resources/demo/*` (byte-equal) | W (G2 demo is N1's family) |
| `server/adapters/cipher/{source,works,siblings,tags-provenance,themes,roots,relations,books,gutenberg-text,wikisource}.mjs` | `ScrollsSources/Cipher/*` | P via G2 g2.cipher-slice |
| `server/jobs/tasks/adapter-load.mjs` (loading half), `demo-load.mjs` | `ScrollsSources/Loading/SourceLoader.swift`, `ScrollsService/Pipelines/AdapterLoad.swift` | W |
| `server/jobs/tasks/bootstrap-cipher.mjs` | `ScrollsService/Pipelines/{BootstrapCipher,BootstrapPhases,SourcePipelines,PackLibrary,PipelineSQL}.swift` | P via G2 (phases A, A2, B) |
| — (§3.5 SPK1) | `ScrollsStore/Pack/{PackManifest,PackReader,PackWriter}.swift` | N, tested |
| — (§3.5 generations) | `ScrollsService/Generations/{AtlasEngine,GenerationManifest,StarterBuild,SourceSelfTest}.swift`; install/swap/rollback/rebuild | N; M2 |
| `server/routes/corpora.mjs` (+ `aggregate/collstats.mjs`) | `ScrollsService/LiveAtlas+Corpora.swift` (corpora, facets) | W (G3 is N3's) |
| `server/routes/tour.mjs` | `ScrollsService/LiveAtlas+Tour.swift` | W |
| `server/routes/etymology.mjs` | `ScrollsService/LiveAtlas+Etymology.swift` | W |
| `server/routes/adapters.mjs` | `ScrollsService/LiveAtlas+Adapters.swift` (list, load for Cipher and the demo; claims, enable, STEMM: M2) | W / M2 |
| `server/routes/baseline.mjs` | `ScrollsService/LiveAtlas+Baseline.swift` | M2 |
| — (AtlasPlatform P1) | `ScrollsService/LivePlatform.swift` (packs, installPack, inbox, generations, storage, purgeCaches) | W |
| `scripts/{bootstrap-cipher,build-demo,bench}.mjs` | `scrolls-cli/Commands/{Pack,Starter,Fingerprint,ConvertReference,Bench}.swift`; `Atlas.swift` (M2) | W |
| — | `Tools/{packs.sh,atlas.sh,check.d/slice.sh}`, `Golden/{gen-sources.mjs,slices.mjs}`, `Scrolls/Diagnostics/Steps/N2Steps.swift`, `Tests/ScrollsSourcesTests/**`, `DifferentialTests/Sources/**` | N |
| — | `Scrolls/Sources/{SourcesScreen,SourcesModel,SourcesCopy}.swift`; `Scrolls/Resources/Bundled/` (build products) | N |

## N3 — query, search and exports

| Reference | Swift | St |
|---|---|---|
| `server/aggregate/query.mjs` | `ScrollsQuery/{QueryDef,CanonicalRequest,SliceSQL,TrailLanes,ClusterLanes}.swift` | stub |
| `server/aggregate/*` (cube, tiles, materialize, washes, coverage, seams, …), `server/text/{variants,translit,names,kwic}.mjs`, `server/export/{manifest,csv,jsonl}.mjs` | `ScrollsQuery/{Match,Slice,Timeline,Stats,Cache,Text,Export}/**` (—) | — |
| `server/routes/{search,expressions,timeline,passages,documents,kwic,exports}.mjs` | `ScrollsService/LiveAtlas+{Search,Expressions,Timeline,Passages,Occurrences,Documents,Kwic,Exports,Snapshots}.swift` (18 methods) | stub |
| `scripts/verify.mjs` (read requests) | `scrolls-cli/Commands/DiffRead.swift` | stub |
| — | `Tools/check.d/read.sh`, `Golden/gen-read.mjs`, `Scrolls/Diagnostics/Steps/N3Steps.swift`, `Tests/ScrollsQueryTests/QueryStubTests.swift` | stub |
| `src/ui/panels/export-menu.mjs` | `Scrolls/Exports/**` (—) | — |

## N4 — analysis, Compare and Constellation

| Reference | Swift | St |
|---|---|---|
| `server/analysis/*` | `ScrollsAnalysis/**` (module placeholder `ScrollsAnalysis.swift`) | stub |
| `server/analysis/tone.mjs`, `tools/nl-adapter` | `ScrollsNL/**` (module placeholder `ScrollsNL.swift`) | stub |
| `server/routes/{compare,collocations,clusters,analysis,constellation}.mjs` | `ScrollsService/LiveAtlas+{Compare,Collocations,Clusters,Analysis,Constellation}.swift` (6 methods) | stub |
| — | `scrolls-cli/Commands/DiffAnalysis.swift`, `Tools/check.d/analysis.sh`, `Golden/gen-analysis.mjs`, `Scrolls/Diagnostics/Steps/N4Steps.swift`, `Tests/ScrollsAnalysisTests/AnalysisStubTests.swift` | stub |
| `src/ui/panels/{compare,constellation,context-group}.mjs` | `Scrolls/{Compare,Constellation}/**` (—) | — |

## N5 — lineage

| Reference | Swift | St | Evidence |
|---|---|---|---|
| `server/lineage/winnow.mjs` | `ScrollsLineage/Winnow/Winnow.swift` (+ `WinnowProbe.swift`, the device parity check) | P | G1 `g1.winnow` exact (token ids, shingles, fingerprints, demo texts, probe books, radix sort) |
| `server/lineage/minhash.mjs` | `ScrollsLineage/Near/MinHash.swift` | P | G1 `g1.minhash` exact (permutations, 3-shingles, Jaccard, signatures, band keys, units) |
| `server/lineage/boilerplate.mjs`, `jobs/tasks/boilerplate.mjs` | `ScrollsLineage/Boilerplate/{BoilerplatePass,BoilerplateKernel}.swift`, `Tasks/BoilerplateTask.swift` | P | G2 `g2.boilerplate` exact (7 passes); `g2.boilerplate-m1r` exact on full Cipher, canary 0 |
| `server/lineage/commonplace.mjs` | `ScrollsLineage/Boilerplate/Commonplace.swift` | P | `g2.boilerplate` records and the "widely shared text" lineage cases |
| `server/lineage/align.mjs` | `ScrollsLineage/Near/Align.swift` | P | G1 `g1.align` |
| `server/lineage/filters.mjs` (structure, name lists, numerals, edge zones) | `ScrollsLineage/Near/Filters.swift`, `Support/LineageStopwords.swift` (generated) | P (trace subset) | G1 `g1.filters` |
| `server/lineage/cues.mjs` | `ScrollsLineage/Cues/Cues.swift` (ICU patterns with JavaScript's `\b` and `\s`) | P | G1 `g1.cues` |
| `server/lineage/near.mjs` `lookupNear` | `ScrollsLineage/Near/NearIndex.swift` | P | read by the trace (m1r run 7's index) |
| `server/lineage/classify.mjs` | `ScrollsLineage/Trace/Classify.swift` (ids from the row-id allocator; compact create revisions on the device profile) | P | the trace job's writes |
| `server/lineage/trace.mjs`, `routes/trace.mjs`, `jobs/tasks/trace.mjs` | `ScrollsLineage/Trace/Trace.swift`, `Tasks/TraceTask.swift`, `ScrollsService/LiveAtlas+Trace.swift` | P | (G3 trace cases: next) |
| `server/lineage/graph.mjs`, `path.mjs`, `routes/lineage.mjs` | `ScrollsLineage/Graph/{EdgeFilters,LineageGraph,ChainOfCustody,GraphSQL,RequestArgs}.swift`, `ScrollsService/LiveAtlas+Lineage.swift` | P | G3 `g3.lineage` on m1r |
| `server/lineage/genealogy.mjs`, `routes/genealogy.mjs` | `ScrollsLineage/Graph/Genealogy.swift`, `ScrollsService/LiveAtlas+Genealogy.swift` | P | G3 `g3.lineage` (Funky Drummer 32 / 98 / 48) |
| `provenance/relationships.mjs` `resolveRef`, `reviews.mjs` `reviewStatusOf`, `anchors.mjs` `makeAnchor` | `ScrollsLineage/Support/LineageRefs.swift` (Lineage cannot import Provenance, §1.2) | P | through G3 |
| `server/lineage/{corpus,exact,cue-links,carry}.mjs`, `near.mjs` `nearVerified/acceptNear/writeNearIndex`, `jobs/tasks/reuse-index.mjs`, `hypotheses` of a run (`groupCompetingSources`) | — | — | the global reuse index: remaining M2 work |
| `src/ui/panels/lineage.mjs` | `Scrolls/Lineage/{LineageView,LineageModel,LineageLayout,ChainOfCustodyView,LineageCopy}.swift` | R | `ScrollsAppTests/LineageTests.swift` |
| `src/ui/panels/genealogy.mjs` | `Scrolls/Lineage/GenealogyView.swift` | R | `ScrollsAppTests/LineageTests.swift` |
| `src/ui/panels/edge-card.mjs` | `Scrolls/Lineage/EdgeCardView.swift`, `HypothesisGroupCard.swift` (+ the node card) | R | `ScrollsAppTests/LineageTests.swift` |
| — | `Tools/check.d/lineage.sh`, `Golden/gen-lineage.mjs`, `Golden/requests/lineage/g3-lineage-m1r.json`, `Scrolls/Diagnostics/Steps/N5Steps.swift` | N | `Reports/check-lineage-*.json` |

## N6 — provenance, journal and notebook

Status: **P** ported 1:1 and differential-tested (G7) · **R** redesigned (same contract, new mechanism) · **N** new on the
phone · **—** not yet (M2/M3).

| Reference | Swift | St |
|---|---|---|
| `server/provenance/anchors.mjs` | `ScrollsProvenance/Anchors.swift` (D18: make, resolve by offsets → quote + context, re-anchor a document) | P |
| `server/provenance/annotations.mjs` | `ScrollsProvenance/Annotations.swift` (create, revise, reinterpret, withdraw, revisions, list with as-of / rev cutoff and facets) | P |
| `server/provenance/relationships.mjs`, `reviews.mjs` | `ScrollsProvenance/{Relationships,Refs}.swift` (card, propose, review, evidence; `resolveRef`, author guard, notes) | P |
| `server/lineage/hypotheses.mjs` (groups) | `ScrollsProvenance/Relationships.swift` (`Hypotheses`) | P |
| `server/provenance/views.mjs` (+ the timeline def it pins) | `ScrollsProvenance/{Views,ViewScope}.swift` (save, `slug~n`, list, as-saved, drift, counts, soft delete) | P |
| — (SQL of the above) | `ScrollsProvenance/{ProvenanceSQL,ProvenanceErrors}.swift` | P |
| — (§6.2–§6.5) | `ScrollsProvenance/{ProvenanceJournal,StableKeys,PortableResolver}.swift` (ops ↔ requests, stable keys, replay, portable cutoffs) | N |
| `server/routes/{relationships,hypotheses,annotations,views}.mjs` | `ScrollsService/LiveAtlas+{Relationships,Hypotheses,Annotations,Views}.swift` (16 methods; dry run → journal → apply) | R |
| — (§6.4, §6.5) | `ScrollsService/{JournalReplayer,ViewCutoffResolver}.swift` | N |
| `scripts/verify-journey.mjs` (as a replayer) | `scrolls-cli/Commands/Api.swift` (`api`, `api --golden`), `Tools/check.d/journey.sh`, `Golden/gen-journey.mjs` | R |
| `src/ui/panels/views-menu.mjs` | `Scrolls/Views/{SavedViewsSheet,SavedViewsModel,ViewThumbnail,ViewsCopy}.swift` | R |
| `src/ui/panels/{notebook,annotation-editor,revisions}.mjs` (M1 part) | `Scrolls/Notebook/{NotebookView,NotebookModel,AnnotationEditor,NotebookCopy}.swift` | R |
| — | `Scrolls/Diagnostics/Steps/N6Steps.swift` (journey and generation suites) | N |
| `src/ui/panels/notebook.mjs` (layers, dimensions, scrubber, compare interpretations, orphans; export) | — | — (M3) |

## N7 — the Scroll

Status: **P** ported 1:1 and differential-tested · **R** redesigned (same contract, new mechanism) · **—** not yet (M2).

| Reference | Swift | St |
|---|---|---|
| `src/ui/timeline/scale.mjs`, the pure axis half of `viewport.mjs` (`clampAxis`, `zoomAxis`, `panAxis`, `fitAxis`) | `ScrollsScrollModel/Scale.swift` (`AxisScale`, `RulerScale`, `ScrollAxis`) | P (G5: ruler ticks and labels of every case) |
| `src/ui/timeline/tiers.mjs` | `ScrollsScrollModel/Tiers.swift` (extensions of N0's `Tier`) | P (G5) |
| `src/ui/timeline/model.mjs` | `ScrollsScrollModel/Model.swift` (`ScrollModelBuilder`, `LabelParse`) | P (G5: model summary, runs, columns, bars, caps, washes, strand summaries) |
| `src/ui/timeline/display.mjs` (`buildDisplay`, `layoutLanes`, `GEOM`) | `ScrollsScrollModel/{Display,Layout,Styles,Reference}.swift` (`DisplayBuilder`, `DisplayList.visible(at:)`, `LaneLayouts.reference/phone`, `ScrollStyle`) | P (G5: every primitive, ±0.01 pt, the 25-vantage sweep) |
| `src/ui/timeline/hit.mjs` | `ScrollsScrollModel/Hit.swift` (`HitGrid.hits/hitIDs/hit`, `DisplayList.hit`) | P (G5: 200 probes per case, at every vantage) |
| `src/ui/timeline/{coverage,seams}.mjs` | `ScrollsScrollModel/Coverage.swift` | P (G5) |
| `src/ui/timeline/a11y-table.mjs`, `describeModel`, `strandSummary`, the tooltips of `display.mjs`, `laneSubtitle`/`laneNotes` of `shell/lanes-menu.mjs` | `ScrollsScrollModel/Sentences.swift` (`ScrollWords`) | P (G5: `describeModel`, `strandSummary`, every tooltip byte-equal) |
| `src/ui/timeline/folded.mjs`, the helpers of `minimap.mjs` | `ScrollsScrollModel/Folded.swift` (`FoldedScale`, `MinimapGeometry`) | P (unit-tested; the folded *overview* of the Scroll is M2) |
| `src/ui/timeline/tiles-client.mjs` (policy), `playhead.mjs` (clock) | `ScrollsScrollModel/Client.swift` (`ScrollQuery`, `TileCache`, `ViewportPlan`, `VantageClock`) | P |
| — (load model for budgets) | `ScrollsScrollModel/PerfLoad.swift` | N |
| `src/ui/timeline/paint.mjs` | `ScrollsRender/{ScrollRenderer,ScrollUniforms,LabelAtlas,OffscreenRenderer}.swift`, `Shaders/{Scroll.metal,ScrollShaderTypes.h}` | R (Metal, uniforms-only vantage; G8 vs the Canvas painter) |
| `src/ui/timeline/paint.mjs` (2-D) | `ScrollsRender/DisplayListCanvas.swift` (`ScrollPainter`, `DisplayListCanvas`) | R (the fallback and snapshot renderer) |
| `src/ui/timeline/snapshot.mjs` | `ScrollsRender/ScrollSnapshot.swift` | R |
| `src/ui/timeline/svg.mjs` | `ScrollsRender/SVGWriter.swift` | — (M2) |
| `src/ui/timeline/{arcs,arc-summary,clusters,deeptime,share-cells}.mjs` | — | — (M2: arcs, bundles, feedback, etymology, claims, baseline, share cells) |
| `src/ui/timeline/viewport.mjs` (state, loading, rebuild rules, selection, tap/open, Play) | `Scrolls/Scroll/{ScrollModel,Playhead,TapSentences,Ruler}.swift` | R |
| `src/ui/timeline/{input,gestures}.mjs` | `Scrolls/Scroll/ScrollGestureHost.swift` (UIKit recognisers, momentum, rubber band, display link) | R |
| `src/ui/timeline/minimap.mjs` | `Scrolls/Scroll/Minimap.swift` | R |
| `src/ui/timeline/shelves.mjs`, the lanes column of `shell/lanes-menu.mjs` | `Scrolls/Scroll/{ShelfChips,LaneHeaders}.swift` | R |
| the action sheet of `viewport.mjs` | `Scrolls/Scroll/{MarkPreview,AmbiguityChooser}.swift` | R |
| the a11y layer of `viewport.mjs`, `a11y-table.mjs` | `Scrolls/Scroll/{ScrollAccessibility,ScrollTableView,CoverageTrack}.swift` | R |
| `src/ui/timeline/perf.mjs` | `Scrolls/Scroll/PerfHUD.swift`, `Diagnostics/Steps/N7Steps.swift` | R |
| — | `Tools/check.d/display.sh`, `Golden/gen-display.mjs`, `ScrollsUITests/ScrollGestureTests.swift`, `Tests/{ScrollsScrollModelTests,ScrollsRenderTests}/**` | N |
| — | `Tools/Scrolls.tracetemplate` (an Instruments document; recorded at the M1 device session) | — |

## N8 — shell, inspector and the experience

| Reference | Swift | St |
|---|---|---|
| `src/ui/shell/{toolbar,ribbon,jobs-chip,layout}.mjs` | `Scrolls/Shell/{TopBar,StrandChips,MoreMenu,LandscapeShell}.swift` (+ N0's `StatusChip`, `SyntheticRibbon`) | R |
| `src/ui/core/store.mjs` (PIN/UNPIN/SET_CORPUS/LOAD_STATE), the inspector's state | `Scrolls/Inspector/{ExperienceModel,SheetMode,ScrollBridge}.swift` | R |
| `src/ui/panels/{inspector,passage-card,date-chip}.mjs` | `Scrolls/Inspector/{ThenModel,ThenColumn,ThenCopy,PassageText,KwicRowView,InspectorContent,PeekRow}.swift` | P (highlight segments, contemporary window, stratified uses) + R (SwiftUI) |
| `src/ui/panels/reader.mjs` | `Scrolls/Inspector/ReaderView.swift` (TextKit 2 `UITextView`, slices of `documentText`) | P (slice arithmetic) + R |
| `src/ui/timeline/drawer.mjs`, `timeline/shelves.mjs` | `Scrolls/Inspector/{ListModel,ListViews}.swift`, shelf buttons in `Scrolls/Lanes/LanesSheet.swift` | P + R |
| `src/ui/timeline/playhead.mjs` (createPlayer), `tiers.mjs` stepBinEnd | `Scrolls/Inspector/{TransportModel,YearPicker}.swift` (the stepper until N7's transport registers) | P |
| `src/ui/timeline/tiles-client.mjs` queryBody | `Scrolls/Inspector/ViewQuery.swift` | P |
| `src/ui/shell/search.mjs` | `Scrolls/Search/{SearchModel,SearchResultsView,SearchCopy}.swift` | P + R (typed groups, romanised rows) |
| `src/ui/shell/{filters,lanes-menu}.mjs` | `Scrolls/Lanes/{FiltersSheet,LanesSheet}.swift` | P + R |
| `src/ui/timeline/legend.mjs`, `shared/evidence-style.mjs` LEGEND_ROWS | `Scrolls/Legend/LegendSheet.swift` (swatches from `EvidenceStyle.legendRows`) | R |
| `src/ui/panels/jobs-tray.mjs` | `Scrolls/Jobs/JobsTray.swift` | P + R |
| `src/ui/tour/{coachmarks,tour}.mjs` | `Scrolls/Tour/{TourModel,TourCopy,CoachMarksOverlay,YourTurnView}.swift` | P (coachCopy, cipherOpenable, startChips, seedStrands) + R |
| `src/ui/shell/help.mjs` | `Scrolls/Settings/{HowItWorks,SettingsSheet,SettingsCopy}.swift` (LabKit `LabInfoSheet` 01–09) | R |
| — (phone) | `Scrolls/Shell/{HapticsMap,StateRestoration,DeepLinks}.swift` | N |
| — | `Tools/check.d/app.sh`, `Scrolls/Diagnostics/Steps/N8Steps.swift`, `ScrollsAppTests/{IndicTypographyTests,N8ExperienceTests}.swift`, `ScrollsUITests/{FirstMinuteTests,AccessibilityAuditTests,StateRestorationTests}.swift` | N |

## I — integration

| Reference | Swift | St |
|---|---|---|
| `scripts/verify-journey.mjs` | `ScrollsUITests/JourneyTests.swift` | stub |
| — | `Tools/check.d/full.sh`, `Scrolls/Diagnostics/Steps/ISteps.swift` | stub |
