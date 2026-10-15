<!-- OWNER: rewrite architect (Qwen rewrite, 2026-10-13). Replaces the lead's placeholder. A proposal for IOS-SPEC v2 (the Qwen edition): the critic answers in qwen-critique.md, the synthesiser writes Docs/IOS-SPEC-QWEN.md. SPEC §13 stays law; this file extends it (§4). -->
# Proposal: the Qwen-centred rewrite

**What this is.** Utkarsh's decision of 2026-10-13 (brief.md, "Qwen decision") makes Qwen **power the app itself, on his iPhone**. It supplies contextual vectors for every occurrence, labels and explanations of what changed, and answers built from cited quotes, all labelled as machine output. This proposal recentres IOS-SPEC v1 on that decision and drops most of the heavy statistical port.

It is written against **what is on disk today**, not against the plan:
- the M0 commit `5a66c69`;
- the two M1 WIP commits `5a9cbe0` and `4520591` (≈ 36.8k lines in the second alone);
- the status files, PORT-MAP, BUILD, DIFFERENTIAL and the latest `Reports/`;
- AttentionMachine's on-device Qwen evidence;
- the mlx-swift-lm 3.32.3 sources in SwiftPM's cache.

**Tags on numbers and facts:**

| Tag | Meaning |
|---|---|
| **(measured: where)** | taken by someone, somewhere named |
| **(read: file)** | verified by reading source or config |
| **(est.)** | a planning estimate |
| **(reported)** | an external figure nobody here has verified |
| **(LAB-n)** | the lab agent's row in `Native/Docs/QWEN-LAB.md` replaces the assumption; §0.4 lists every slot and the switch it drives |

---

## 0. The rewrite in one page

### 0.1 Decisions

| # | Decision | Why |
|---|---|---|
| Q-01 | **Two Qwen models run inside the app process on his iPhone 15 Pro Max:** <br>• **Qwen3-Embedding-0.6B** for vectors: groups, shift, similar uses and retrieval; <br>• **Qwen3-4B-Instruct-2507 4-bit** for text: labels, explanations, grounded answers, drafts and tone. <br>There is no server and no network. | His decision. The reference's TF-IDF-hash vectors never found structure on real text (best silhouette 0.035 against the 0.10 gate, 45 of 45 runs gated: ANALYSIS-AND-LIMITS §7). PPMI-SVD found groups in only 35 of 45 runs. |
| Q-02 | **One model is resident at a time.** One `ModelManager` actor owns residency. <br>• It unloads on background, on a memory warning and at thermal *critical*. <br>• It also unloads when idle: the 4B after 90 s, the embedder after 30 s. | AttentionMachine's 4B reached a **2.662 GB peak footprint** on his phone and ended twice with an unexplained **signal 9** (measured: AttentionMachine QUALITY.md). |
| Q-03 | **Vectors are read lazily, per tracked expression.** <br>• A *first look* reads ≤ 600 stratified occurrences. <br>• *Read all* then continues while the app is open (cap 20,000, design-weighted). <br>• Vectors are cached in the atlas as float16 at a Matryoshka width of 256 (LAB-4). <br>"Every occurrence" means every occurrence of every expression he tracks, never the whole 146.7 M-token corpus. | Reading the whole corpus would take ≈ 2 days of phone GPU (est.: 2.76 M passages × ≈ 100 tokens at ≈ 1.5k tokens/s). |
| Q-04 | **Context groups** use spherical k-means on centred Qwen vectors, with SPEC's gate discipline unchanged in kind: <br>• ≥ 60 read occurrences in ≥ 5 documents; <br>• a stable k (mean ARI ≥ 0.6); <br>• a silhouette above the no-groups reference cloud; <br>• a silhouette floor calibrated **once** on pseudo-words and frozen per representation version (LAB-5). <br>Gated means no groups and no labels. | Keeps §4.8's honesty; swaps the representation, not the rules. |
| Q-05 | **Shift is measured in one model space:** <br>• the group-share JSD (kept); <br>• the centroid displacement with a document-permutation null (new). <br>No alignment is needed. Era slices, Procrustes and neighbour overlap are dropped. Every result carries the anachronism caveat. | One embedder reads every period, so there are no independently trained spaces to align. |
| Q-06 | **Generation is always grounded.** <br>• The output is guided JSON (MLXGuidedGeneration) at temperature 0. <br>• Claims cite passages **by id**. The app renders every quote from the atlas through `TextStore`, never from the model's text. <br>• The grammar forbids digits in generated prose, so dates and counts can only come from data. <br>• **Nothing generated is shown before it is verified.** | Makes the honesty rules of §4 mechanical rather than hoped for. |
| Q-07 | **Machine readings are a fourth class**, beside observed, computed/proposed and human annotation. They are never evidence. They have their own card style and badge, never enter a count, and never create a documented or computed relationship. | The brief: "preserve a clear distinction between observed corpus patterns, computational estimates, and human annotations". |
| Q-08 | **The heavy statistical port is cut:** co-occurrence and PPMI, rSVD, pooled and era-slice spaces, Procrustes, neighbour overlap with controls, TF-IDF-hash, exact k-means parity, Apple NL tone, the constellation as specified, and tier G4. | **Almost none of it exists:** ScrollsAnalysis has no clustering or space code, and ScrollsNL is 37 lines (read: `Native/ScrollsKit/Sources`). The cut deletes plans, not working code. |
| Q-09 | **Differential testing is kept only for deterministic parts:** tokenizer, fold, sentences, dates, the writer, counts, tiles, offsets, search, the display list, render parity, the journey, and Compare's frequencies, CIs, gates and collocations. | The oracle stays useful where an exact answer exists. |
| Q-10 | **The MLX stack is the only third-party code.** It lives in a separate local package, `Native/ScrollsQwenKit`, and in the app. Engine targets stay dependency-free and `swift test`-able. | SwiftPM on the command line cannot build MLX's Metal shaders; only xcodebuild can (read: mlx-swift 0.32.3 README). So `check.sh quick` stays MLX-free. |
| Q-11 | **Models arrive from the Mac:** `Tools/models.sh push` → `Documents/Inbox/Models/` → sha256-verified → `Library/Application Support/Models/` (excluded from backup). **The app has no download code** (ΔS-17 holds). | AttentionMachine downloads from Hugging Face; Scrolls must not (SPEC §13.16). |
| Q-12 | **The simulator runs `RecordedRuntime`**, labelled "recorded" in the UI. MLX runs on the device and in the macOS `scrolls-qwen` CLI (xcodebuild). | MLX does not run in the simulator (AttentionMachine MODEL.md). |
| Q-13 | **Machine outputs are journaled verbatim** with a `machineRun` op: group assignments, raw JSON and verification. Restores, generations and as-saved views therefore show exactly what he saw. Vectors are a rebuildable cache and are never journaled. | D17 across generations without re-running a model. |
| Q-14 | **M1 is his phone:** the demo, Cipher, search, the Scroll, the passage, and **Qwen groups and labels for *bank* computed on the device**. Compare, saved views, Ask and import move to M2. | His instruction: a working app on his phone fast. Nothing of the native app has run on the phone yet (every device row since 2026-10-10 is `PENDING_DEVICE`). |
| Q-15 | **Stance and irony suggestions are off by default.** They sit behind a κ gate (LAB-11) and his opt-in. Tone is reported as distributions only. | IOS-SPEC §7.3 and SPEC §14 say "never automatic irony or stance detection"; the brief says "sentiment/stance = fallible annotations". This needs his decision (§7.2). |

### 0.2 Ground truth for the rewrite

| Fact | Value | Consequence |
|---|---|---|
| Models on the Mac (read: `~/Developer/scrolls-models`, MODELS.json, MODEL.md) | **Qwen3-4B-Instruct-2507-4bit:** 2,263,022,417 B weights, sha256 `2a73c6c2…`; 36 layers, 32 query heads, 8 KV heads, head dim 128. <br>**Qwen3-Embedding-0.6B-8bit:** 649,088,604 B, `fe956e8d…`. <br>**Qwen3-Embedding-0.6B-4bit-DWQ:** 351,233,351 B, `3d773d5e…`. <br>The embedder has hidden size 1024, 28 layers and vocabulary 151,669. | 2.6–2.9 GB of models on the phone, outside the app bundle by default. |
| 4B on his phone (measured: AttentionMachine QUALITY.md, MODEL.md, iOS 27.2) | <br>• peak `phys_footprint` 2.662 GB; 246.5 MB after unload (95.9 MB baseline); <br>• 24 input + 16 output tokens: 1.6–2.1 s excluding load (5.1 s on the first run); <br>• cancel 0.385 s; <br>• MLX cache back to 0 after every unload; <br>• **two signal-9 terminations, cause unknown**, built **without** `increased-memory-limit`. <br>AttentionMachine caps the prompt at 96 tokens, output at 64 and the allocator cache at 16 MB. | **Memory is the central risk.** Scrolls needs prompts of 1–2k tokens (§2.4). The first device session measures the ceiling with Scrolls's entitlement (S3). |
| Engine memory budgets (IOS-SPEC §3.8) | interactive ≤ 400 MB; one job ≤ 600 MB; total ≤ 1.2 GB | Engine plus 4B ≈ 3.1–3.9 GB, so admission control must couple them (§2.2). |
| KV cache of the 4B (computed from the config) | 36 layers × 2 × 8 heads × 128 × 2 B = **147,456 B per token**: 302 MB at 2,048 tokens; ≈ half with `kvBits: 8` | Prompt cap 2,048 (LAB-9). `GenerateParameters` has `kvBits`, `maxKVSize` and `prefillStepSize` (read: MLXLMCommon/Evaluate.swift@3.32.3). |
| MLXEmbedders 3.32.3 (read: Pooling.swift, Models/Qwen3.swift, README) | <br>• Qwen3 uses `.last` pooling, whose index is (number of mask ones − 1), which is **correct only for right padding**. <br>• The README pads with EOS, masks EOS and passes `applyLayerNorm: true`. **Both are wrong for Qwen3-Embedding**: the mask would hide the pooled token, and the model has no pooled LayerNorm. | The embedder pads on the right, appends `<|endoftext|>`, uses `normalize: true` and `applyLayerNorm: false`. It must equal the Python reference to cos ≥ 0.999 (test Q1). |
| Tokenizer loading (read: MLXLMCommon/TokenizerLoader.swift) | The loader protocol is implemented by `MLXLMTokenizers` (swift-tokenizers-mlx), which is **not** in the cache | Scrolls writes a 40-line `TransformersTokenizerLoader` over swift-transformers 1.3.0 `AutoTokenizer.from(modelFolder:)`, as AttentionMachine does. Nothing is downloaded. |
| MLXGuidedGeneration (read: Package.swift, GuidedGenerationLoop.swift) | <br>• Built on vendored XGrammar C++ (`MLXCXGrammar`), which carries `.unsafeFlags(["-w"])`. <br>• `run(input:context:constraint:maxTokens:vocabSize:kvBits:…prefill:emit:)` takes no temperature. <br>• It checks `Task.checkCancellation()` per token. <br>• A cold grammar compile blocks for hundreds of ms, so schemas are pre-warmed off the main actor. | Spike S1 checks that a versioned dependency with unsafe flags is accepted. The fallback is in §7.1. Determinism is checked by S5. |
| mlx-swift (read: README@0.32.3) | "SwiftPM (command line) cannot build the Metal shaders"; xcodebuild can | MLX code lives in `ScrollsQwenKit`, built by xcodebuild (app, `scrolls-qwen` CLI, its tests). |
| Native tree today (measured: `wc -l`, 2026-10-13) | **Engine ≈ 69k lines.** By target: <br>• Core 5,968 · Contracts 6,388 · Store 4,263 · Jobs 1,671 <br>• Ingest 9,161 · Sources 3,886 · Query 9,396 · Analysis 5,547 <br>• Lineage 4,228 · Provenance 4,263 · Service 5,925 <br>• ScrollModel 4,432 · Render 1,455 · NL 37 · cli 2,203 <br>**App ≈ 19.4k lines; ScrollsKit tests ≈ 10.4k.** <br>**Gates:** <br>• G1 21/21 families PASS; C0 260/260; <br>• G5 681,728 checks PASS; G8 worst 0.042% (budget 1%); <br>• G2 boilerplate exact; G2 Cipher slice generated. <br>• **G3 has never run.** | Most of what M1 needs is written. What is missing is wiring (§1.2). |
| Reference clustering method (read: ANALYSIS-AND-LIMITS §7) | <br>• the pseudo-word benchmark (6 words, 15 pairs, 400 occurrences each, Cipher text and STEMM text); <br>• the Gaussian-on-sphere no-groups reference; <br>• stability by document subsamples; <br>• the 45-run real-word table. | Reused unchanged as the lab's yardstick (LAB-2, LAB-5). Qwen must beat PPMI-SVD on the same benchmark before it ships as the default (§3.2). |

### 0.3 ΔQ register: what this rewrite overrides

Only these rows override IOS-SPEC v1 and SPEC. Everything else holds.

| ΔQ | Overrides | Change |
|---|---|---|
| ΔQ-1 | N-02, N-10, §3.6 "Derived" | The phone builds **no** pooled spaces, era slices or co-occurrence tables. Token streams remain for collocations. The reuse index remains (deterministic). Qwen vectors are built lazily (§2.7). |
| ΔQ-2 | N-04 "no third-party code" | Allowed, and only in `Native/ScrollsQwenKit` and the app's Qwen host: <br>• mlx-swift 0.32.3; <br>• mlx-swift-lm 3.32.3 (MLXLLM, MLXLMCommon, MLXEmbedders, MLXGuidedGeneration); <br>• swift-transformers 1.3.0 (Tokenizers); <br>• swift-collections 1.5.0. <br>Each is `exactVersion`, as in AttentionMachine. Not linked: MLXHuggingFace, MLXFoundationModels, MLXVLM. |
| ΔQ-3 | N-08, §2.2–§2.5 | Parity is kept for deterministic modules only (§1.3). G4 is removed. DV-5 and DV-6 are closed as obsolete. A new **Q tier** of tests is added (§6.3). |
| ΔQ-4 | N-15, §3.8 | Model residency gets its own budget: the 4B ≤ 3.0 GB (est.: the 2.662 GB peak was measured at 24 prompt tokens; add ≈ 0.15–0.3 GB of KV at 2k tokens) and the embedder ≤ 0.8 GB (LAB-9). While the 4B is resident, no engine job above 256 MB is admitted. Admission is `os_proc_available_memory() ≥ model peak + 600 MB`, through the existing `MemoryBudget.reserve`. |
| ΔQ-5 | SPEC §4.8 | Representation, clustering and labels move to §3.1–§3.4 of this file. The gate *structure* is unchanged; the silhouette floor is recalibrated per representation (LAB-5) and **never lowered after real words are seen**. |
| ΔQ-6 | SPEC §4.9 | Measures (a) context-share JSD (kept) and (b′) centroid displacement in one space. The old (b) and (c) are dropped. The verdict rule is in §3.5. |
| ΔQ-7 | SPEC §4.10, §2.E panel 7 | Tone becomes a Qwen reading, shown as distributions only. Apple NLTagger and the NL-assets download (ΔS-17a) are removed. Stance follows Q-15. |
| ΔQ-8 | SPEC §13.8 "No unaligned comparisons" | Becomes: **no comparison across different representations or models**. Every period is read by one embedder version; a mismatch is gated `representation_mismatch`. |
| ΔQ-9 | SPEC §13.10 | Extended by rules 19–30 (§4 of this file). |
| ΔQ-10 | IOS-SPEC §7.3 "Never: the Foundation Models framework for any annotation" | Holds for Apple's model. Qwen (local open weights, recorded by sha) is the annotation model. MLXFoundationModels is not linked. |
| ΔQ-11 | Contract 1.3.0 | Unchanged. C0 stays 260/260. <br>• Qwen surfaces get a third protocol, **`AtlasQwen`** (version Q1, additive), like `AtlasPlatform`. <br>• `clusters` and Compare's `clusters` and `measures` fields serve Qwen groups and shifts in the same shapes, with `representation` naming the Qwen representation key. |
| ΔQ-12 | `vocab.STAGES`, `JOB_TYPES` | Generated vocab stays byte-equal to the reference, so G1 stays exact. The phone-only stages live in `QwenVocab`: <br>`qvec · qgroups · qshift · qedges · qlabel · qexplain · qask · qreuse · qdraft · qtone · qstance · qallusion` <br>`TaskRegistry.missing` gains a `retired` set: `vectors · align · drift` (b, c) `· tone` (NL). |
| ΔQ-13 | IOS-SPEC §4.12, ΔS-10 | The constellation moves to M4, laid out by Fruchterman–Reingold over collocation and similar-usage edges. It has no vector-space positions, so there is no projection axis to label. |

### 0.4 Lab slots (the lab's numbers replace these assumptions)

| Slot | Question | Assumption until measured | Decision it drives |
|---|---|---|---|
| LAB-1 | Embedder: 8-bit or 4-bit DWQ? | **4-bit DWQ**, if pseudo-word mean ARI is within 0.02 of 8-bit and per-vector cos ≥ 0.98 | which model ships; 0.35 vs 0.65 GB |
| LAB-2 | Occurrence representation | **R1:** instructed target-centred window, last-token pooled (§2.3). <br>Alternatives: R2 (the same window, no instruction); R3 (target-token states at a middle layer, "echo" repetition so the token sees right context); R4 (4B middle-layer states). | `q_representation.key`. Must beat PPMI-SVD (1.1.0) on the ANALYSIS-AND-LIMITS §7 benchmark: Cipher mean ARI 0.302, lowest 0.13; STEMM text 0.502, lowest 0.23. |
| LAB-2b | Centre vectors per expression before clustering? | **yes** (LLM embeddings are anisotropic) | clustering input |
| LAB-3 | Window size; Hindi and Gujarati behaviour | **±32 Qwen tokens** clipped to the passage. hi/gu are flagged if group quality drops (Qwen tokenises them at ≈ 4.75 and ≈ 8.86 tokens per word, reported) | window rule; hi/gu caveat copy |
| LAB-4 | Matryoshka width | **256**: the smallest of {128, 256, 512, 1024} within 0.02 ARI of 1024 | storage 512 B per vector |
| LAB-5 | Silhouette floor and reference margin, calibrated on pseudo-words | **0.10** and "above the reference" (SPEC's) | the `no_cluster_structure` gate |
| LAB-6 | Throughput (Mac now; device at S4) | embedder 600–2,000 tokens/s on the A17 Pro; 4B prefill 150–300 tokens/s, decode 12–20 tokens/s (est., scaled from the reported 1.7B figures) | first-look size (600 → 300 if > 90 s); task caps |
| LAB-7 | Label quality | ≥ 80% of labels acceptable to him on the 15 polysemous words of ANALYSIS-AND-LIMITS §7 and the demo; 100% valid citation ids (by grammar); ≥ 95% of model-offered quotes verbatim | label prompt version; whether labels run automatically |
| LAB-8 | Grounded answers | ≥ 90% refusal on 20 unanswerable questions; ≥ 1 verified claim on ≥ 80% of 30 answerable ones | Ask ships at M2 or not |
| LAB-9 | Memory: 4B with 1k / 2k prompts; embedder at batch 8 / 16 / 32 × 128 tokens | 4B peak ≤ 3.0 GB at 2k; embedder ≤ 0.8 GB at 16 × 128 | prompt cap 1,024 or 2,048; batch size |
| LAB-10 | Determinism and parity | the same input twice gives byte-identical output (same device); Swift = Python cos ≥ 0.999 | reproducibility claims (§4 rule 25) |
| LAB-11 | Stance agreement | κ vs the demo's 18 human `pragmatic_function` labels and ≥ 50 of his | stance stays off unless κ ≥ 0.4 **and** he opts in |
| LAB-12 | Similar-usage threshold τ | the per-run p99 of within-expression random-pair cosines, plus an absolute floor | edge density |

---

## 1. KEEP / CUT / CHANGE

### 1.1 Package by package (the code on disk)

| Pkg | On disk (2026-10-13) | KEEP | CUT | CHANGE (Qwen) |
|---|---|---|---|---|
| **N0** foundation | Core, Contracts, Store, Jobs, the Service core, ScrollModel's frozen types, cli, the app shell and Diagnostics. G1 21/21, C0 260/260, Store 57 tests, Jobs 27 tests. | All of it, with every N0 rule (one owner per file, contracts through N0, `PENDING_DEVICE`) | <br>• the §2.4 rows for float32, rSVD, clustering and drift tolerance; <br>• DV-5 and DV-6; <br>• the `MappedFileRegistry` budgets for spaces and stream-for-space mappings; <br>• `derived/{spaces,align}` | <br>• `qwen-profile.sql` (§2.5), RowIDPolicy and dump-spec entries; <br>• `ScrollsStore/Qwen/{VectorCodec,RepresentationKey,QwenSQL}.swift`, shared by Qwen and N4 to avoid an import cycle; <br>• the `AtlasQwen` protocol and Q1 value types; <br>• `JournalOp.machineRun`; <br>• `QwenVocab`; <br>• `project.yml` packages; <br>• `build.sh qwen-cli \| qwen-test`; <br>• lint: MLX imports only in ScrollsQwenKit and `Scrolls/Qwen`; `HubClient`, `Downloader` and `#huggingFace…` banned everywhere; <br>• the probe's model rows; <br>• **`TaskRegistry` registers every landed task (it is empty today)** |
| **N1** ingest | `ScrollsIngest` 9,161 lines: formats, mapping, validate, writer, segmenter, langid. Used by G2 (demo, Cipher slice). `LiveAtlas+Imports` has 6 `NOT_IMPLEMENTED` methods. No `Scrolls/Import/` UI exists. | All engine code | — | None for Qwen: imported text is read lazily like any text. The import routes and the wizard move to **M2**. |
| **N2** sources | Pack format (11 tests); Cipher and demo adapters; BootstrapCipher A/A2/B (resumable, G2 slice); starter; Sources UI; `atlas.sh`. Packs never built ("pending", DEVICE-DATA). | All of it | — | <br>• **Wire it**: requests #1 (TaskRegistry) and #2 (`BootstrapCipher.start` in `LiveAtlas.open`) are still open. <br>• `Tools/packs.sh starter` then calls `scrolls-qwen demo-runs` (Q) to add the demo's Qwen runs. <br>• The Sources page shows a Models row from `AtlasQwen.models()`. |
| **N3** query | `ScrollsQuery` 9,396 lines: search, translit, materialise, cube, tiles, timeline, KWIC, exports, `ClusterLanes`. **G3 never run.** | All of it; G3 on m1r becomes the M1 read gate | — | <br>• `ClusterLanes` reads Qwen groups. Bins whose members were not all read become `estimated` (design-weighted, §3.4), and conservation still holds. <br>• Lane label precedence: human label > Qwen label > distinctive words, all three visible in the card. <br>• Exports carry machine readings with `machine_reading: true`. |
| **N4** analysis | `ScrollsAnalysis` 5,547 lines: Compare blocks, query and context; Stats (intervals, bootstrap, gates, composition, keyness, multiplicity); collocations; token streams; BaselineRho; slices. `Scrolls/Compare/**` 1,600 lines. **No space or cluster code exists.** | All of it; G3 Compare exact | <br>• the whole M3 plan: TF-IDF-hash, co-occurrence/PPMI/rSVD, the `vectors` task, era slices, Procrustes, occurrence vectors, exact k-means parity, drift (b) and (c); <br>• `ScrollsNL` (delete the target); <br>• the G4 half of `gen-analysis.mjs`; <br>• `StoredRuns`' readers of spaces, era slices, neighbour overlap and aligned displacement | **N4 becomes "Groups, shift and Compare":** <br>• `Groups/**`, `Shift/**`, `Edges/**`; <br>• the `qgroups`, `qshift` and `qedges` tasks; <br>• `LiveAtlas+Clusters` implemented; <br>• Compare panels 5–7 plus the machine-reading slot (§5.4). <br>The demo calibration of SPEC §9.6 is kept as the test of truth (Q3). |
| **N5** lineage | `ScrollsLineage` 4,228 lines: winnow, minhash, boilerplate (P, G1/G2 exact), trace, graph, genealogy (P, G3 on m1r). `Scrolls/Lineage/**` 1,776 lines. | All of it; the reuse index stays (M3) | — | <br>• The edge card shows machine readings and the on-request allusion reading (M3). <br>• A `similar` filter for `similar_contextual_usage` edges, hidden by default. |
| **N6** provenance | `ScrollsProvenance` 4,263 lines: anchors, annotations, relationships, views, journal ops, `PortableResolver`. Views and Notebook UI 943 lines. | All of it | — | <br>• The `machineRun` handler and replay. <br>• `ViewCutoffResolver` pins Qwen runs by `RunKey`, including model and template sha. <br>• The Notebook's machine layer and "Make it mine" (§5.6). <br>• Qwen labels are stored as `machine_gloss` annotations and renames as `label` annotations. |
| **N7** the Scroll | ScrollModel 4,432 + Render 1,455 + Scroll UI 3,437 lines. G5 PASS (681,728 checks); G8 PASS. | All of it | — | <br>• Cluster-lane bins may be `estimated` (stripes + ≈, an existing encoding), with the tap sentence "estimated: 40 of 312 occurrences read by the model". <br>• Lane chips say "Qwen label: …" or, before Qwen has labelled, the reference's "machine label: …" (computed words). <br>• `ScrollModel.isInteracting` is published so Qwen batches yield during gestures (§2.7). |
| **N8** experience | Shell, inspector (Then, reader, drawer), search, lanes, legend, jobs, tour, settings: ≈ 7k lines. | All of it | — | <br>• `SheetMode` gains `.groupCard` and `.ask`. <br>• Search offers "Ask the atlas". <br>• Then gains a context-group row. <br>• The status chip shows model states. <br>• Settings links Q's model page. <br>• The tour gains a "machine reading" step (M4). |
| **R** reference | frozen at `ref-freeze-1`; m1r and m5r built | frozen | analysis findings (no oracle for them any more) | The finding protocol now applies to the deterministic tiers only. |
| **I** integration | — | the role | — | adds Q's device rows and the `qwen-soak` suite |

**New package: Q (Qwen).** Q owns:
- `ScrollsKit/Sources/ScrollsQwen/**` (pure);
- `Native/ScrollsQwenKit/**` (the MLX runtime and the `scrolls-qwen` CLI);
- `ScrollsService/LiveQwen*.swift`;
- `Scrolls/{Qwen,Ask}/**`;
- `Tools/{models.sh,qwen-ref.py,check.d/qwen.sh}`;
- `Golden/qwen/**`;
- `Diagnostics/Steps/QSteps.swift`.

§6.1 has the full tree.

### 1.2 Integration gaps found on disk (the M1 critical path, Qwen or not)

1. **`TaskRegistry.all` is empty** (read: `ScrollsService/TaskRegistry.swift`). The live app therefore answers `E_JOB_TYPE` for every job, including demo-load, bootstrap-cipher and materialise. Only the CLI and self-tests run them, through `AtlasEngine`'s own registry.
2. **`BootstrapCipher.start` is not called** from `LiveAtlas.open` (N2 request #2). It is reachable only from the `loadAdapter` route, so phase A never starts by itself at first launch.
3. **`LiveAtlas+Imports`: 6 stubs**, and there is no import UI. This is M2 under this plan.
4. **The last quick gate failed.** At `check-quick-20261013T201704Z`: <br>• lint FAIL, 3 findings of the banned `String.lowercased()`: `ScrollsQuery/Export/Snapshots.swift:81,84` and `ScrollsService/LivePlatform.swift:89`; <br>• the Render row FAILed in 0.6 s with 6 issues, while `check.d/display.sh` passed G8 26 s later. That is a gate-environment mismatch (TOOLCHAINS), owned by N0.
5. **G3 (the read path) has never run**, and the packs and the starter have never been built.
6. **The app has never been on his phone.** All 16 rows of `Reports/device-queue.json` are `PENDING_DEVICE`: 6 because the phone was not connected ("tunnel unavailable"), 10 waiting for the integrator's device session.
7. **Build cost.** A `quick --wp N7` build took 871 s at load average ≈ 990. MLX and XGrammar add a large one-time C++ compile, so each agent keeps a persistent mirror (`dd/`) and the M0Q build is timed (S1).

### 1.3 Differential testing after the cut

| Tier | After the rewrite |
|---|---|
| C0 contracts | **keep** (260/260) |
| G1 pure | **keep**: every family, including stats primitives (Garwood, Wilson, G², BH-FDR, logDice, Gries DP), variants, translit, winnow and minhash |
| G2 pipeline | **keep**: mini, ingest, demo, the Cipher slice, boilerplate; STEMM slice at M3 |
| G3 read path | **keep**: search, expressions, timeline, tiles L0–L5, marks, passages, documents, KWIC, shelves, coverage, seams (m1r at M1, m5r at M3) |
| G3 Compare | **keep exact**: multiplicity, coverage, composition, modality, prominence, frequency + CIs, seeded passages, collocates, keyness, gates and widening suggestions. **Masked**: the `clusters`, `measures` (sense_share_jsd, neighbor_overlap, aligned_displacement) and `tone` fields, which the reference computes with methods that no longer exist. |
| G4 analysis | **cut entirely** (vectors, era slices, k-means on exported vectors, drift, convergence, constellation layout, NL tone) |
| G5 display list | **keep** (passing) |
| G6 device = Mac | **keep for evidence and user tables**. Analysis tables are excluded: Qwen outputs come back from the journal, not from recomputation. |
| G7 journey | **keep**, writes included; the Compare responses inside the RF-3 journey mask `clusters`, `measures` and `tone`, as in G3 |
| G8 render parity | **keep** (passing) |
| **Q (new)** | Q1 runtime parity, Q2 determinism, Q3 demo truth, Q4 honesty, Q5 device lifecycle, Q6 evaluation sets (§6.3) |

---

## 2. The new architecture: ScrollsQwen

### 2.1 Targets and the dependency rule

```
ScrollsKit (SwiftPM, swift test-able, no third-party code)
  ScrollsStore ── Qwen/{VectorCodec, RepresentationKey, QwenSQL}     [N0, frozen at M0Q]
  ScrollsQwen (pure) ── depends on Core, Contracts, Store, Jobs, Query  [Q]
     Models/   ModelManifest · ModelCatalog (the 3 known models + sha) · ModelVerify (streamed sha256)
     Policy/   Residency · Admission · ThermalPolicy · Budgets          (pure decisions, unit-tested)
     Read/     SamplePlan · ContextWindow · Templates · ReadContextsTask
     Generate/ PromptLibrary (versioned prompts as resources) · Schemas (one JSON Schema per task) · PassageSet (P-ids)
               Verifier · Refusals · ClaimRenderer · Label/Explain/Ask/Reuse/Draft/Tone/Stance/Allusion tasks
     Runtime/  protocol QwenRuntime · RecordedRuntime (fixtures keyed by prompt+input sha) · types
  ScrollsCore/QwenVocab (phone-only stages, tasks, gate codes; shared by Q and N4)  [N0]
  ScrollsAnalysis/Groups, Shift, Edges                                   [N4]  (reads q_vector through QwenSQL)
  ScrollsService: AtlasQwen (protocol, N0) · LiveQwen, LiveQwen+<Area> (Q)  (runtime injected; no MLX import)

Native/ScrollsQwenKit (local package; built only by xcodebuild; MLX lives here)          [Q]
  ScrollsQwenRuntime: MLXQwenRuntime: QwenRuntime · ModelManager (actor) · Embedder · Generator · GuidedJSON
                      TransformersTokenizerLoader · MemoryProbe (phys_footprint, os_proc_available_memory)
  scrolls-qwen (macOS executable): demo-runs · vectors (parity fixtures) · eval (prompt sets) · bench

Scrolls (app): Scrolls/Qwen/QwenHost injects MLXQwenRuntime (device) or RecordedRuntime (simulator, -qwen recorded) [Q]
```

- **Why the split.** Everything that decides anything lives in `ScrollsQwen`, so it is `swift test`-able in `check.sh quick`: sampling, windows, prompts, schemas, verification, admission, residency rules, refusals. Only tensor work is in `ScrollsQwenKit`.
- **Groups and labels without an import cycle.** `qvec` (Q) → `qgroups` (N4) → `qlabel` (Q) are chained by job type through `JobQueue` `after:` dependencies. They share only `ScrollsStore/Qwen`.

### 2.2 The model manager

```swift
public actor ModelManager {                       // ScrollsQwenRuntime (Q); policy decisions come from ScrollsQwen/Policy
  public enum Role: Sendable { case embedder, generator }
  public enum State: Sendable { case none, loading(Role, since: ContinuousClock.Instant), resident(Role, footprint: Int),
                                  paused(ThermalReason), refused(needed: Int, available: Int) }
  public var events: AsyncStream<ModelEvent> { get }          // → AtlasService.events as .qwen(…) and the status chip
  public func withEmbedder<R: Sendable>(priority: QwenPriority, _ body: (Embedder) async throws -> R) async throws -> R
  public func withGenerator<R: Sendable>(priority: QwenPriority, _ body: (Generator) async throws -> R) async throws -> R
  public func unloadNow(reason: UnloadReason) async          // background · memoryWarning · thermalCritical · idle · user
}
```

- **One resident at a time.** Switching roles unloads the resident model first: references are dropped, then `Memory.clearCache()` runs (the AttentionMachine pattern). Only then does the other model load.
  - `Memory.cacheLimit = 16 MB` while the embedder is resident, and 64 MB while the 4B is (LAB-9).
  - Work for one role is batched before switching. For example, every label of an expression is generated in one 4B residency.
- **Admission** reuses `MemoryBudget.reserve(bytes:headroom:)`:
  - the 4B reserves 3.0 GB and the embedder 0.8 GB (est., LAB-9);
  - the request is refused, with copy, when `os_proc_available_memory() < peak + 600 MB`;
  - while the 4B holds its reservation, an engine job whose declared peak is above 256 MB waits.
  - A **measured switch**: if S3 shows ≥ 5.5 GB available with the entitlement, both models may be co-resident (setting *Keep both models loaded*, off by default).
- **Unload triggers:**
  - scene → background (inside `Lifecycle`'s `beginBackgroundTask`, before `suspendJobs`);
  - `didReceiveMemoryWarning`;
  - a `DispatchSource` memory-pressure event of `.critical`;
  - thermal `.critical`;
  - idle (90 s for the 4B, 30 s for the embedder once its queue is empty);
  - **Unload now** in Settings.
  - After an unload, the footprint must return to ≤ the pre-load baseline + 300 MB (test Q5).
- **No GPU in the background.** Qwen work never starts or continues in the background. The assumption is that his phone does not offer `BGContinuedProcessingTask` with `.gpu` resources; S3 probes `BGTaskScheduler.supportedResources`, and if `.gpu` is present, *Read all* may continue under the continued-processing task (M3).
- **Cancellation.**
  - Embedding checks between batches; generation checks per token (`Task.checkCancellation()` in the guided loop).
  - It is acknowledged in ≤ 500 ms (the existing rule, tested on the device).
  - A cancelled run is `cancelled`, writes no annotation, and its `q_output` row records `failed`.

### 2.3 The embedding service

- **The input, R1** (LAB-2 may replace it). The text is wrapped in Qwen3-Embedding's instruction format and terminated with `<|endoftext|>`:

  ```
  Instruct: Represent how the marked expression is used in this passage.
  Query: …left context… «carry the zero» …right context…
  ```

  - The window is **±32 Qwen tokens** around the target span, clipped at the passage and never across it (LAB-3).
  - The target span comes from the occurrence's UTF-16 offsets (D4), so the marker sits exactly where the match is.
  - **Titles are never read for sense.** A song or film title has no usage context, so it is excluded with the gate copy "titles have no usage context to read" (§3.11).
- **Batching.**
  - Windows are sorted by token length and batched 16 at a time (LAB-9), padded on the right.
  - Last-token pooling uses the key-padding mask, which is correct for right padding (§0.2). Then `normalize: true` and `applyLayerNorm: false`.
  - Vectors are cut to the Matryoshka width (256, LAB-4) and re-normalised.
  - Each batch is one GPU submission of ≤ ≈ 100 ms (est.). The service yields while `isInteracting` is true (§2.7).
- **The cache.**
  - `q_vector` rows are float16, keyed by (representation, passage id, target span). Passage ids are slot-stable for source data, so a re-track costs nothing.
  - `input_sha256` guards against stale vectors after a text change. A row whose stored hash differs from the recomputed input is recomputed.
  - Rows are purgeable from Storage ("rebuildable").
  - **Cost:** 512 B per vector, so 100k vectors take 51 MB.
- **Passage-level vectors** for Ask retrieval use the same model in document mode (no instruction) with span `(0, 0)`, under a separate representation key.
- **The representation key** names every input to the vector, for example `qe06-q4dwq@3d773d5e/occ-instr@1/w32/d256/c`: model sha, template version, window rule, width, centring. A change of any part is a new key, and analyses never mix keys (ΔQ-8).

### 2.4 The generation service

- **Loading.** `LLMModelFactory.shared.loadContainer(from: <model dir>, using: TransformersTokenizerLoader())` loads the model; that local-directory overload needs no downloader (read: MLXLMCommon/ModelFactory.swift@3.32.3). There is never a `HubClient` (lint).
- **Decoding.**
  - Chat template: Qwen3-2507 non-thinking.
  - `GuidedGenerationLoop.run` with a `GrammarConstraint` compiled from the task's JSON Schema. Schemas are pre-warmed off the main actor when the 4B loads (the README's warning).
  - Prefill in 256-token steps, so no single GPU submission is long.
  - `kvBits: 8` when the prompt exceeds 1,024 tokens (LAB-9).
  - The guided loop takes no temperature (§0.2): S5 verifies it is greedy, and if it samples, a fixed seed is passed and recorded.
- **Task budgets.** Each task is capped twice: tokens, and a wall time of 90 s, after which it stops with "stopped after 90 s; nothing shown".

  | Task | Passages in | Prompt cap | Output cap | Started |
  |---|---|---|---|---|
  | `qlabel` | ≤ 4 per group (±24 tokens around the target), ≤ 8 groups, plus distinctive words | 2,048 (LAB-9) | 80 per group | after `qgroups`, automatically for a strand on screen (setting, on) |
  | `qexplain` (Compare) | ≤ 5 per slice | 2,048 | 256 | tap |
  | `qask` | ≤ 10 (≤ 3 per document) | 2,048 | 320 | Ask |
  | `qreuse` | Then + Now + the computed alignment | 1,024 | 192 | tap (M3) |
  | `qdraft` | ≤ 6 later uses + group words | 1,536 | 160 | tap (M3) |
  | `qtone` / `qstance` | 8 passages per call, ±32 tokens | 768 | 48 | Compare tone panel / opt-in (M3) |
  | `qallusion` | 2 passages | 768 | 96 | edge card, on request (M3) |

  Timing estimates for the 4B (from LAB-6): a label pass of ≈ 1.8k tokens in and ≈ 250 out takes 20–30 s; Ask takes 20–35 s plus a 2–8 s load (est.). **Measured switch:** if Ask's p50 on the device exceeds 45 s, Ask uses 6 passages and 160 output tokens.
- **Prompts are data.**
  - Each prompt is `ScrollsQwen/Resources/prompts/<task>@<n>.txt`, with its sha256 recorded on the run. A change is a new version, never an edit.
  - Passages are listed as `[P1]`…`[Pn]` together with their **period slot** (`{A}`, `{B}`, `{W3}`) and language. Each period slot is resolved by the app from the data, so the prompt states no date of its own. A year inside a passage's text cannot come back as the model's claim either, because the output grammar has no digits.
  - The demo's passages are introduced as "from a synthetic demonstration corpus".
- **The schemas** (example: `qlabel`):

  ```json
  {"type":"object","required":["groups"],"properties":{"groups":{"type":"array","maxItems":8,"items":{"type":"object",
   "required":["group","label","gloss","cites","kind"],"properties":{
     "group":{"type":"string","pattern":"^G[1-8]$"},
     "label":{"type":"string","maxLength":40,"pattern":"^[^0-9]*$"},
     "gloss":{"type":"string","maxLength":200,"pattern":"^[^0-9]*$"},
     "cites":{"type":"array","minItems":2,"maxItems":4,"items":{"type":"string","pattern":"^P[0-9]{1,2}$"}},
     "kind":{"enum":["usage","one_source","register_or_spelling","unclear"]}}}}}}
  ```

  - Every free-text field carries `"pattern":"^[^0-9]*$"`. If XGrammar's pattern support fails at S5, the Verifier rejects the field instead.
  - `qask` items are `{text, cites[], quote?:{p, text≤160}}` plus `answerable: bool`.
  - `qexplain` items are `{text, cites_a[], cites_b[]}`.

### 2.5 Storage: `qwen-profile.sql` (N0; create-only, applied after `device-profile.sql`; `meta.profile_qwen = 'qwen-1'`)

```sql
CREATE TABLE q_model (sha256 TEXT PRIMARY KEY, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('embedder','generator')),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),       -- files, sizes, sha256s, licence, upstream revision
  installed_at TEXT NOT NULL) STRICT;
CREATE TABLE q_representation (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE,
  model_sha256 TEXT NOT NULL, runtime TEXT NOT NULL,                   -- 'mlx-swift 0.32.3 / mlx-swift-lm 3.32.3 / ios27.2'
  template_sha256 TEXT NOT NULL, window TEXT NOT NULL,
  dim INTEGER NOT NULL CHECK (dim IN (128,256,512,1024)), centred INTEGER NOT NULL CHECK (centred IN (0,1)),
  created_at TEXT NOT NULL) STRICT;
CREATE TABLE q_vector (rep_id INTEGER NOT NULL REFERENCES q_representation(id),
  passage_id INTEGER NOT NULL, start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,  -- target span (D4); (0,0) = whole passage
  input_sha256 BLOB NOT NULL, vec BLOB NOT NULL,                       -- f16, L2-normalised after truncation
  PRIMARY KEY (rep_id, passage_id, start_off, end_off)) STRICT, WITHOUT ROWID;
CREATE TABLE q_centroid (cluster_id INTEGER PRIMARY KEY REFERENCES sense_cluster(id), vec BLOB NOT NULL) STRICT;
CREATE TABLE q_output (run_id INTEGER PRIMARY KEY REFERENCES analysis_run(id),
  task TEXT NOT NULL CHECK (task IN ('label','explain','answer','reuse','hypothesis','tone','stance','allusion')),
  prompt_sha256 TEXT NOT NULL, grammar_sha256 TEXT NOT NULL,
  inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),           -- [{pid:'P3', passage_id, start, end, text_sha256, slot}]
  raw TEXT NOT NULL,                                                   -- the model's bytes, unedited
  verified_json TEXT NOT NULL CHECK (json_valid(verified_json)),       -- per claim: kept | dropped(reason)
  verdict TEXT NOT NULL CHECK (verdict IN ('shown','partly_withheld','refused','failed')),
  tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, wall_ms INTEGER NOT NULL) STRICT;
CREATE TRIGGER q_output_no_update BEFORE UPDATE ON q_output BEGIN SELECT RAISE(ABORT, 'machine outputs are immutable'); END;
CREATE TRIGGER q_output_no_delete BEFORE DELETE ON q_output
WHEN NOT EXISTS (SELECT 1 FROM analysis_run r WHERE r.id = OLD.run_id AND r.status IN ('cancelled','failed'))
BEGIN SELECT RAISE(ABORT, 'machine outputs are kept'); END;
CREATE TABLE q_shift (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  expression_id INTEGER NOT NULL, slice_a_json TEXT NOT NULL, slice_b_json TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('group_share_jsd','centroid_displacement')),
  value REAL, ci_lo REAL, ci_hi REAL, null_percentile REAL,
  n_a INTEGER, n_b INTEGER, docs_a INTEGER, docs_b INTEGER, authors_a INTEGER, authors_b INTEGER,
  gate TEXT NOT NULL CHECK (gate IN ('ok','insufficient_occurrences','insufficient_documents','insufficient_authors',
        'single_source','composition_mismatch','modality_mismatch','sampling_design','no_cluster_structure',
        'language_mismatch','representation_mismatch','not_read','not_run')),
  gate_detail_json TEXT NOT NULL, caveats_json TEXT NOT NULL DEFAULT '[]',
  CHECK (gate = 'ok' OR (value IS NULL AND ci_lo IS NULL AND ci_hi IS NULL AND null_percentile IS NULL))) STRICT;
```

**Reused §3 tables** (the schema is untouched; N-05 holds):
- `analysis_run` (the `representation`, `model`, `model_version` and `seed` columns exist already);
- `sense_cluster`, `cluster_member`, `cluster_share`, `time_window` and `cluster_transition` for groups;
- `annotation`: Qwen labels and glosses as `machine_gloss`, tone as `machine_tone`, stance as `machine_tag`, drafts as `hypothesis` with `is_machine = 1`, all with `method` and `run_id`, as the DDL CHECKs require;
- `relationship`:
  - similar uses: `similar_contextual_usage`, `computed`, origin `algorithm`;
  - allusion readings: `proposed_allusion`, origin `machine_tagger`, `proposed`.

  The existing CHECKs already make a documented status impossible for both.

**RowIDPolicy:** `q_vector` and `q_centroid` are *keyed*, `q_output` and `q_shift` *entity* (local range), `q_model` and `q_representation` *keyed*. **dump-spec** skips `q_vector` and masks `wall_ms`.

### 2.6 Runs, reproducibility and the journal

- **Every Qwen step is an `analysis_run`.**
  - `stage` comes from QwenVocab.
  - `model` is the model name; `model_version` is the weights sha256 plus `mlx-swift-lm 3.32.3`.
  - `representation` is the representation key; `seed` is 42.
  - `params_json` holds the prompt id, prompt sha, grammar sha, caps, sample plan and scope. So `params_hash`, and therefore the `RunKey`, covers model, prompt and grammar.
  - `input_fingerprint` covers the passage ids and their text sha256s in prompt order.
- **Reuse rule.** An identical `RunKey` is reused, never regenerated. **Regenerate** makes a new run, and the old one stays visible as an earlier layer.
- **The journal** gains one op (N0 freezes it; N6 applies it):

  ```swift
  case machineRun(MachineRunOp)   // stage, RunKey, params, built_on; and what restores the run exactly:
                                  // qgroups → LZFSE table {anchor key → group ordinal} + centroids + gate;
                                  // q-generation → q_output.raw + verified_json + inputs (as D18 anchors);
                                  // qedges → endpoint anchor pairs + scores; qshift → the q_shift rows
  ```

  - Replay re-inserts these results without running a model, so restores, CLI-built generations and as-saved views are identical (D17).
  - `qvec` is not journaled: vectors are a cache, and their absence costs only time.
  - A groups op is ≈ 30–60 KB for 2,000 members (16 B per member before LZFSE; est.).

### 2.7 Scheduling Qwen work on the phone

- **The queue.** `ScrollsQwen/Policy` orders the work. A higher priority preempts at the next batch or token boundary.

  | Priority | Work |
  |---|---|
  | P0 | generation he is waiting for (Ask, a tapped explanation, a draft) |
  | P1 | embedding he is waiting for (*Read this occurrence*, the first look of a strand he just opened) |
  | P2 | labels for groups on screen |
  | P3 | *Read all* of tracked strands; similar-use edges |

  All of it runs through `JobQueue` as read-mostly jobs (`writes: false`, guarded short commit), so the reserved interactive reader is never touched.
- **When an expression is tracked:**
  1. after materialise, `qvec{plan: firstLook}` (P1 when its strand is visible, otherwise P3);
  2. then `qgroups`;
  3. then `qlabel` (if *Label groups automatically* is on).
- **First look and Read all.**
  - **First look:** a stratified sample (§3.1) of ≤ 600 occurrences, chosen so that the gate is reachable when possible.
  - **Read all:** continues at P3 while the app is in the foreground, up to 20,000 occurrences per expression. *bank* has 4,309 occurrences in Cipher's English literature text (ANALYSIS-AND-LIMITS §7): ≈ 4–8 min (est., LAB-6).
- **Budgets.**
  - One embedding batch is ≤ ≈ 100 ms of GPU work (est.; S8 measures hitches).
  - Generation prefills in 256-token steps.
  - While the Scroll is interacting (pan, pinch, momentum, Play), batches wait. Decode steps continue, because they are short.
- **Thermal and power** (`DeviceConditionsSource`, bridged from LabKit as today):

  | Condition | Embedding | Generation |
  |---|---|---|
  | nominal | continuous | allowed |
  | fair | 20% rest after each batch | allowed |
  | serious | only P0 and P1, with a 2 s rest between batches | only P0, with the copy "the phone is warm; Qwen is slower" |
  | critical | stops | stops; models unload; "paused — the phone is hot" |
  | Low Power Mode | no automatic Qwen work | explicit requests only |

- **Background.** Everything Qwen pauses and the models unload. The queue resumes when the scene is active again.

### 2.8 What ships, and whether bulk precompute ships in packs

| Artefact | Where | Size | Notes |
|---|---|---|---|
| The two chosen models | pushed: `Tools/models.sh push qwen3-4b qwen3-emb` → `Documents/Inbox/Models/<name>/` (devicectl) → streamed sha256 against `ModelCatalog` → renamed into `Library/Application Support/Models/<name>@<sha8>/` (excluded from backup; `CompleteUntilFirstUserAuthentication`) | 2.26 GB + 0.35 GB (or 0.65 GB, LAB-1) | `SCROLLS_BUNDLE_MODELS=1` puts them in the app bundle (AttentionMachine's pattern) for a standalone build. The default keeps device installs small. |
| The demo's Qwen runs (vectors, groups, labels for *carry the zero*, *flux up*, *ghost in the margin*) | inside `starter.atlas`, built on the Mac by `scrolls-qwen demo-runs`, the same Swift code through xcodebuild | ≈ 1 MB | The first minute cannot wait 20–40 s for the embedder. The runs record `built_on: mac` and the model sha. The phone's `-selftest qwen` re-reads 40 demo contexts and requires cos ≥ 0.999 against the starter (the G6 analogue). |
| Cipher and STEMM vectors | **not shipped.** Read on the phone, lazily. | — | Per N-02. A **measured switch**, recorded and never silent: if the first look of a median word exceeds 3 min on the device, the lead may offer an optional "vector pack" built by `scrolls-qwen` for the words he tracks. It would carry the same representation key and the same parity check, and the phone path stays default. |

If `scrolls-qwen` cannot be built by M1, the demo runs come from the Python reference (`~/Developer/cipher-llm/venv`, mlx 0.32.3), imported as JSON with `runtime: 'mlx (Python) on Mac'`. Its parity is checked the same way.

### 2.9 `AtlasQwen` (Q1; protocol by N0, implementation `LiveQwen` by Q)

```swift
public protocol AtlasQwen: Sendable {
  func models() async -> [ModelStatus]                                   // installed · in Inbox · missing (with the push command) · verifying %
  func installModels() async throws -> [ModelStatus]
  func unloadModels() async
  func readContexts(_ r: ReadContextsRequest) async throws -> JobID       // expr + plan: .firstLook | .all | .occurrences([OccurrenceID])
  func readingStatus(_ expr: ExpressionID) async throws -> ReadingStatus  // read n of N, sample plan, representation, ETA from this phone's bench
  func startGroups(_ r: GroupsRequest) async throws -> StartRunResponse   // qgroups (N4's task); results through AtlasService.clusters
  func label(groupsRun: RunID) async throws -> JobID
  func explain(_ r: CompareRequest) async throws -> JobID                 // the Compare card
  func ask(_ r: AskRequest) -> AsyncThrowingStream<QwenEvent, Error>      // stage(name, done, total) · tokens(n) · reading(MachineReading)
  func readReuse(then: PassageID, now: PassageID) -> AsyncThrowingStream<QwenEvent, Error>
  func draftHypothesis(_ r: DraftRequest) -> AsyncThrowingStream<QwenEvent, Error>
  func tone(_ r: CompareRequest) async throws -> Gated<ToneDistribution>
  func similarUses(_ occ: OccurrenceID) async throws -> [SimilarUse]
  func machineReadings(_ target: TargetRef, asOf: Cutoffs?) async throws -> [MachineReading]
}
public struct MachineReading: Codable, Sendable, Equatable {
  public var run: RunID; public var task: String; public var badge: ModelBadge        // name · sha8 · runtime · built_on
  public var claims: [VerifiedClaim]       // text + [Citation(passage, start, end, dateChip from date_assertion, synthetic)]
  public var withheld: [WithheldNote]      // reason codes + copy (§4)
  public var read: ReadDisclosure          // "read 12 of 4,309 occurrences, sampled by decade and source"
  public var verdict: Verdict              // shown · partlyWithheld · refused
  public var synthetic: Bool
}
```

- **`RecordedRuntime`** answers the same calls from `Resources/qwen-fixtures/*.json`, recorded on the device or by `scrolls-qwen`, and keyed by (task, prompt sha, inputs sha).
  - Selected by `-qwen recorded`, the default in UI tests and on the simulator.
  - Every card it produces says **"recorded"**.
  - `-qwen off` hides every Qwen surface; that is the state of a phone without models.
- **Events.** `AtlasService.events` gains `.qwen(ModelEvent)` (additive).

---

## 3. Methods replacing the cut ones

### 3.1 Sampling occurrences to read

- **What is eligible.** The counted occurrences of the strand: default exclusions applied, name-guard hits excluded, and titles excluded (they have no context).
- **Cells.** Occurrences are stratified by (decade × collection). Within a cell, at most 3 per document are taken, by a seeded draw: `mulberry32(42 ⊕ fnv1a32(expression key))`, so the sample is reproducible.
- **Allocation.**
  - The first look allocates 600 in proportion to √(cell size), so small periods are not drowned. Every cell gets at least 1 when it has any.
  - *Read all* takes the rest in random order within cells, up to 20,000.
- **Design weights.** Each read occurrence carries the weight N_cell / n_cell. Shares, centroids and estimated lane counts are weighted, and the run records the plan.
- **Disclosure.** Every view of the result prints "read 600 of 4,309 (first look: sampled by decade and source)".

### 3.2 Context groups (`qgroups`, N4)

- **Input.** The read vectors of the strand in one representation: f16 widened to f32, and centred by the weighted mean of the sample then re-normalised (LAB-2b).
- **Gate.** ≥ 60 read, non-thin occurrences from ≥ 5 documents. A thin occurrence is a window with < 8 content tokens; thin ones are excluded and counted. Otherwise:
  - `insufficient_occurrences` or `insufficient_documents` with SPEC's copy;
  - `not_read` when more reading would pass: "Read 41 of 312; groups need 60 in 5 documents. [Read all · ≈ 40 s]".
- **Clustering.**
  - Spherical k-means: k-means++, 10 restarts, ≤ 100 iterations, seeded.
  - `cblas_sgemm` for the n × k cosines, in f32. Determinism is checked per device; there is no cross-implementation parity.
  - k ∈ {1 … min(8, ⌊n/20⌋)}.
- **Choosing k** (the reference's 1.1.0 rule, kept):
  1. the mean cosine silhouette of every k ≥ 2, exact up to 2,000 points;
  2. stability, measured in falling-silhouette order until the first stable k: 30 document-block subsamples of 80%, each the best of 3 restarts, mean ARI ≥ 0.6;
  3. the winner must beat the **no-groups reference**: the silhouette of the same k on a Gaussian with the sample's weighted mean and covariance, put on the sphere;
  4. and reach the **floor** (0.10 until LAB-5).
  - Otherwise k = 1 with `no_cluster_structure`: "k = 3 reaches silhouette 0.11; a cloud of the same shape without groups reaches 0.12."
- **Group status.**
  - Groups smaller than max(10, 5% of n) are `residual` ("other contexts").
  - Per-group Jaccard stability < 0.5 is `unstable` ("tentative", dashed).
  - A top-document share > 0.5, or one collection holding > 80%, adds the flag "mostly one source", shown on the card and the lane chip.
- **Members and the remaining occurrences.**
  - Each member keeps its cosine to the centroid and its margin over the runner-up (`cluster_member`).
  - Centroids go to `q_centroid`, so occurrences read later (Read all, *Read this occurrence*) are **assigned without refitting**.
  - A refit happens only on request, or when Read all doubles n. It is a new run, and the old one stays pinnable.
- **The pseudo-word acceptance rule** (LAB-2).
  - Before Qwen becomes the default, the chosen representation must reach mean ARI **≥ 0.302 on Cipher text and ≥ 0.502 on STEMM text**, with the lowest pair ≥ 0.13 and ≥ 0.23, on the ANALYSIS-AND-LIMITS §7 benchmark. These are the PPMI-SVD 1.1.0 figures.
  - If it does not, groups stay available, labelled "experimental: below the reference method on the benchmark", and the lead decides with Utkarsh.
  - The demo's planted senses must still give ARI ≥ 0.8 (*carry the zero*, k = 4) and ≥ 0.7 (*flux up*), from SPEC §9.6 (test Q3).

### 3.3 Labels: computed words first, Qwen's label beside them

1. **Distinctive words (computed, deterministic).** The top 4 context words per group by weighted log-odds with an informative Dirichlet prior (Monroe et al. 2008), from the engine's tokens within ±10 of the target: z ≥ 1.96, in-group f ≥ 3. They are stored in `sense_cluster.label_auto` and `distinctive_json` as before ("machine label: river · streams · sand · near"). This is a port of the algorithm without parity (N4, ≈ 150 lines). They appear the moment groups exist.
2. **Qwen's label (`qlabel`).** One 4B residency labels every group of the run. The prompt shows the 4 passages nearest each centroid (≤ 1 per document, spread across windows), all groups' distinctive words for contrast, and the instruction to name the *use* in ≤ 4 words with a ≤ 25-word gloss.
   - Stored as an `annotation(kind = 'machine_gloss', target cluster, is_machine = 1, method = 'qlabel@1', run_id, author = 'machine:qwen3-4b@2a73c6c2')`, with the citations in `evidence_refs_json`.
   - `kind: one_source | register_or_spelling` becomes the card's flag ("this group may be one book's vocabulary" / "may be spelling or register, not use").
3. **His rename** is a `label` annotation, as in the reference.
   - Precedence on the lane chip: his label, then "Qwen label: …", then the computed "machine label: …" words. The two machine classes never share a prefix.
   - **The card always shows all three**, with "(editable)" beside the machine ones.

### 3.4 Windows, shares and transitions

- **Windows (SPEC §4.8, kept).** Decades, merged forward until each holds ≥ 30 read occurrences. An uncovered decade is never merged across, and items dated wider than the window are excluded and counted.
- **Shares** are design-weighted, with a document-block bootstrap 95% CI (1,000 draws, the existing exact `Stats/Bootstrap.swift`).
- **Lanes on the Scroll.** For each (group, bin), the estimated count is Σ over cells of N_cell × the weighted share. The bin is drawn **`estimated`** (stripes + ≈) unless every occurrence in it has been read. The lanes still partition the strand's count exactly: the residual lane absorbs the rounding, and the conservation tests stay.
  - Occurrences that are never read for sense, such as titles, get their own lane, "titles — no usage context". They are never filed under "other contexts".
- **Transitions** keep SPEC's definitions (emerge, vanish, split, merge; uncovered windows → `unknown_gap`). They are computed on per-window weighted centroids in the one space and drawn dashed (computed). The ⑂/⑃ copy is unchanged: "a split in usage contexts, not a claim about speakers".
- **Convergence of two expressions** keeps SPEC's J(t) of collocates. Its C(t) becomes the cosine of their mean vectors in **one** representation; the expressions must share the representation key, otherwise `representation_mismatch`.

### 3.5 Shift between two slices, in one model space (`qshift`, N4)

| Measure | What | Uncertainty / null | Gate per slice |
|---|---|---|---|
| (a) group-share shift | JSD (base 2) of design-weighted group shares; groups fitted on A ∪ B | document-block bootstrap, 1,000 → 95% CI | ≥ 50 read, ≥ 5 documents, ≥ 3 authors, top-document share ≤ 0.5, k ≥ 2 |
| (b′) centroid displacement | 1 − cos(μ_A, μ_B), where μ are the design-weighted means of the **un-centred** unit vectors | 500 permutations of **documents** between A and B (each slice's document count kept) → percentile; also a split-half self-baseline per slice | the same as (a) without k; plus the same language and the same representation key |

- **Verdict.**
  - "notable" only if (b′)'s percentile ≥ 100 − 5/k (the multiplicity from `compare_log`, as today) **and**, when k ≥ 2, (a)'s CI excludes 0.
  - Otherwise "within typical variation".
  - Wording, always: *"estimated shift in usage contexts, read by one modern model"*.
- **Gates and caveats.**
  - The composition caveat fires at JSD > 0.15; (b′) is not reported at > 0.4 (`composition_mismatch`).
  - `modality_mismatch`, `sampling_design` (OpenAlex cells) and the prominence caveat are unchanged.
  - New gates: **`language_mismatch`** (a cross-language shift is refused by default; one multilingual space does not make English and Hindi uses comparable) and **`representation_mismatch`**.
- **The fixed caveat on every shift card:** *"Both periods were read by the same 2025 model. It reads older spelling and register through today's language, so some 'shift' can be spelling or genre."*

### 3.6 Similar-usage edges (`qedges`, N4; M3)

- **Where they come from.** For each read occurrence of a strand, the nearest neighbours by cosine among occurrences **in other documents by other authors**.
- **When an edge is made.** Only when two occurrences are **mutual top-3** neighbours **and** cos ≥ τ (LAB-12). Each occurrence keeps ≤ 3 edges, and a run makes ≤ 300.
- **What is stored.** `relationship(rel_type = 'similar_contextual_usage', evidence_status = 'computed', origin = 'algorithm', method = 'qedges@1', run_id, score = cos, score_kind = 'similarity', directed = 0)`. The DDL's CHECKs make "documented" impossible.
- **How they are shown.** Hidden in lineage by default, like `kindred`. They appear in Then's "similar uses elsewhere" list with the type's fixed sentence: "Similar usage contexts (computed). Not influence, ancestry or intent." They never make arcs on the Scroll and never make feedback.

### 3.7 Tone and stance (fallible annotations; M3)

- **Tone (`qtone`).**
  - Up to 2,000 paragraphs per slice (seeded) are each classified `positive | negative | neutral | mixed`, 8 per call, as `machine_tone` annotations.
  - Shown **only as distributions** per slice, with a document-block bootstrap CI, **never as a label on a single passage** (SPEC §4.10 kept).
  - Gate: ≥ 30 paragraphs per slice.
  - Label: *"Qwen3-4B tone reading — modern, fallible, anachronistic for historical text."*
- **Stance (`qstance`)** follows Q-15.
  - It suggests the `pragmatic_function` vocabulary plus `unclear`, as `machine_tag` annotations, **in the Notebook only**, as "machine suggestion — confirm or reject".
  - Its counts **never** mix with human stance counts.
  - It is enabled only when κ ≥ 0.4 (LAB-11) **and** he turns it on.

### 3.8 Explaining what changed (`qexplain`; Compare, M2)

- **The input.**
  - The engine's facts, as data: slices as `{A}`/`{B}`, the group labels, the shares with CIs, and the shift measures that are **ok**. A gated measure is passed as "not estimated", never as a number.
  - ≤ 5 representative passages per slice, the seeded Compare passages, stratified by group.
  - The caveats that fired.
- **The output.** Comparative claims, each requiring ≥ 1 citation in A **and** ≥ 1 in B. A one-sided claim is dropped.
- **Placement.** The card always sits **below** the computed panels. It never replaces a number, and the engine's caveats appear above it.

### 3.9 Ask the atlas (`qask`; M2)

- **The scope** is explicit and shown as chips: *this strand* · *this range* · *this group* · *this view* · *all loaded text (keywords)*. Ask is never open-domain over 146.7 M tokens.
- **The pipeline,** with each stage shown with its number:
  1. **Candidates.** FTS5 `bm25` over the passages in scope, ≤ 64. The query is the question's content tokens through the engine tokenizer, without stop-words. S2 confirms that `bm25` works on the contentless `passage_fts`; otherwise the fallback is the matched passages ordered by date-stratified sampling.
  2. **Re-rank** with the embedder: the question in query mode against the cached passage vectors, computing missing ones in ≤ 2 batches. Keep 10, ≤ 3 per document, and stratify by period when the question names two periods.
  3. **Switch models** (embedder → 4B), then generate guided JSON.
  4. **Verify** (§4 rules 20–23).
  5. **Render** the claims with citations taken from the atlas.
- **Refusal** when nothing in scope matches, when the model says `answerable: false`, or when no claim survives verification. The passages it read are listed anyway, so the evidence is never hidden.
- **Questions the atlas does not answer by generation:**
  - questions about what people thought or intended → the fixed refusal;
  - questions about *when* → answered from the data ("first observed in this corpus: …"), never by the model.
- **Keeping an answer.** **Keep in notebook** stores it as a `machine_gloss` annotation on the scope target, with his question as his own `question` annotation.

### 3.10 Then / Now / Next (M3)

- **Then** shows, as computed facts, the occurrence's group (label, cosine to the centre, margin) and "similar uses elsewhere" (§3.6). Qwen has nothing to say here unless asked.
- **Now** shows, on tap, a **machine reading of the reuse** (`qreuse`).
  - The input is the Then and Now passages plus the engine's deterministic alignment and the relationship card's facts (type, status) as data.
  - Every claim must cite both passages.
  - It can never change, upgrade or add a relationship.
- **Next** offers **Draft a hypothesis** (`qdraft`).
  - The input is later uses in the same group, and the group's share trend as computed facts.
  - The output is one hypothesis (≤ 40 words, framed as a possibility) plus cited grounds.
  - It is stored as a **machine** `hypothesis` annotation and rendered as a machine card headed *"Hypothesis drafted by Qwen3-4B — not evidence"*. It is never violet (rule 19): violet stays for his own reinterpretations.
  - **Make it mine** opens his editor prefilled. His saved annotation is his own and becomes the usual dashed violet card *"Hypothesis — by you"*, with `dimensions_json.drafted_from = <machine annotation>`. The draft stays as a machine layer.
- **Allusion readings (`qallusion`)** happen only from an edge card or a two-passage selection, on his request. The result (`none | wording | idea | unclear` plus cited basis) is shown as a reading.
  - Only **Add as a proposed allusion** creates `proposed_allusion` (origin `machine_tagger`, `proposed`, `created_by = 'run:n'`).
  - His review overlays it as for any edge. The line style never changes.

### 3.11 What is disabled when evidence is insufficient (additions to SPEC §4.11)

| Feature | Gate code | UI copy when failing |
|---|---|---|
| Groups, not enough read yet | `not_read` | "Read 41 of 312 occurrences; groups need 60 in 5 documents. [Read all · ≈ 40 s]" |
| Groups for titles | `titles_only` (QwenVocab) | "These matches are titles; a title has no usage context to read. Groups use running text." |
| Groups | `no_cluster_structure` | SPEC's copy, plus "representation: Qwen3-Embedding (…)" |
| Labels | — | groups gated → no labels; model absent → distinctive words plus "Qwen is not on this phone" |
| Shift | `language_mismatch`, `representation_mismatch` | "A is English, B is Hindi: one model reads both, but their uses are not comparable as a shift." / "A and B were read by different model versions; re-read B with the current model. [Read]" |
| Machine readings of gated results | — | not offered: the model is never asked to explain a gated measure |
| Ask | refusal | §4 rule 23 |
| Tone | `not_run` / < 30 paragraphs | "Tone needs Qwen3-4B on this phone" / SPEC's count copy |
| Stance suggestions | — | "Off: machine stance agreed with human readers at κ = 0.31 (needs 0.4)" |

---

## 4. Honesty rules for LLM output (SPEC §13, rules 19–30)

Reviewers reject code that breaks one. The `Verifier` (Q) makes rules 20–23 mechanical, and the Q4 tests feed it adversarial outputs.

19. **A machine reading is never evidence.** It never:
    - enters a count, denominator or rate;
    - creates a `documented` or `computed` relationship (only `proposed`, origin `machine_tagger`, on his request; similar-usage edges are computed by the *embedder's* algorithm, not by generation);
    - sets a date;
    - changes a review;
    - appears as a mark on the Scroll. Group lanes are computed, and only their *labels* may be machine text.

    It is rendered in the **machine card** style only: opaque `bg-1`, a 1 pt dotted `ink-3` border, and the chip **"machine reading"**. Never glass, and never amber, violet or cyan, which belong to history, reinterpretation and selection. Exports mark it `machine_reading: true`.
20. **Every claim cites passages it was given.**
    - Citations are `P`-ids from the prompt's own list; an id outside it drops the claim.
    - The app renders each citation from the atlas: the text through `TextStore` at its offsets, and the date chip from `date_assertion`. **The model's text is never shown as a quotation.**
    - A claim with no valid citation is dropped. Comparative claims need both sides (§3.8).
21. **Quotes are verified verbatim or dropped.**
    - A model-offered `quote` must equal a substring of the cited passage after NFC, whitespace collapse and quote-mark normalisation only.
    - Otherwise it is removed, with the note "a quotation the model offered did not match the passage and was removed". The claim may stay if its citation holds.
22. **Dates and numbers come from the data.**
    - The grammar forbids digits in every free-text field (`"pattern":"^[^0-9]*$"`); if the pattern is unsupported, the Verifier rejects the field instead.
    - Periods are slot tokens (`{A}`, `{W3}`) that the app fills from the data.
    - The model is never asked "when"; such questions are answered from the data.
    - The cost is accepted: a label that would need a digit ("COVID-19") is written without it, and the distinctive words beside it show the original token.
23. **Refusal is a first-class result.** Copy (exact):
    - *"No passages in {scope} match this question. Nothing was generated."*
    - *"Qwen's answer could not be tied to the passages it read (0 of 3 claims verified), so it is not shown. The 10 passages it read are below."*
    - *"Scrolls does not reconstruct what historical people thought, felt or intended. These passages use the words in your question:"*
    - *"Dates come from the records, not from the model. First observed in this corpus: {date chip}."*
24. **No mental-state claims about historical people.**
    - Prompts forbid them.
    - The Verifier runs the existing `Copy.mentalStateVerbs` and forbidden phrases ("meaning changed", "coined", "born") over every generated sentence. A matching sentence is withheld with *"1 sentence withheld: it described what a historical person thought or intended."*
    - There is no silent rewrite. One retry with a reminder is allowed; both outputs are stored in `q_output`.
25. **Reproducibility.** Every reading has a run with:
    - model sha and runtime versions;
    - prompt id and sha, and grammar sha;
    - caps and seed;
    - its inputs (passage ids, offsets and text sha, in order);
    - the raw output and the verification.

    It is journaled verbatim (`machineRun`). Saved views pin it, and it is never silently regenerated: **Regenerate** makes a new run and keeps the old one as a layer.
26. **The modern model's reading is always labelled.** Every machine card's footer:

    > *"Read by Qwen3-4B (2025) on this iPhone. A modern model's reading of these passages: it can be wrong, and it reads old text with today's sense of words. Quotes and dates come from the atlas, not the model."*

    The badge carries the model name and sha8 and, where applicable, "recorded" or "built on the Mac".
27. **Coverage is disclosed.** Every reading states what it read: *"Read 12 passages of 4,309 occurrences (sampled by decade and source)."* Answers speak of "the passages read", never of "the corpus".
28. **Gated means silent.** The model is never given a gated value and never asked to speculate about missing groups or shifts. A gated card stays a gate card.
29. **Synthetic stays synthetic.** Prompts over demo material say it is synthetic. Machine cards that cite demo passages carry `SYN` and the dashed demo frame, and the ribbon rules apply.
30. **Local, licensed, his.**
    - All inference runs in the app process; there is no network (ΔS-17).
    - His annotations enter a prompt only when he selects them as inputs.
    - Readings that cite `export_text_allowed = 0` passages export citation ids and quote hashes, never the text.
    - Machine labels stay visible after he renames a group (SPEC rule 10, extended).

**Nothing generated is shown before it is verified.** The UI shows a token counter while Qwen writes, then the verified claims at once. There is no streamed prose.

---

## 5. The iPhone experience: what changes

The §4 principles of IOS-SPEC v1 hold: thumbs at the bottom, glass is chrome, nothing moves at rest, every count names its denominator. Qwen appears in seven places, always as opaque machine cards.

### 5.1 The status chip, loading, memory and thermal states

Every state has a number or a reason, never a spinner alone.

| State | Status chip (TopBar, trailing) | Elsewhere |
|---|---|---|
| reading | "Qwen · reading 312 / 600" with a ring | — |
| loading | "Qwen3-4B · loading (last 3.1 s)" | — |
| writing | "Qwen · writing 41 tokens" | **Cancel** on the card |
| paused | "Qwen paused: phone is warm" or "…hot" | — |
| refused | "Not enough memory for Qwen3-4B (needs ≈ 3.0 GB, 1.9 GB free). Nothing changed." | — |
| absent | — | Settings shows "Qwen is not on this phone: on your Mac run `Tools/models.sh push`" with sizes |

### 5.2 Cluster lanes and the group card (M1)

- **The lanes** come from `Lanes → Context groups` or from the strand chip's menu.
  - A lane's header chip reads "Qwen label: river side" (or "machine label: river · along · water" until Qwen has labelled), with `¹`/tentative flags. Read progress shows as "read 600 of 4,309".
  - Estimated bins use the stripes + ≈ encoding, and a tap gives the sentence.
- **Tapping a lane header** opens the **group card** (`SheetMode.groupCard`, half detent), in this order:
  1. his label (if any) / Qwen's label and gloss (machine card, with 4 cited passages, each opening Then);
  2. the distinctive words (computed);
  3. n, documents, top-document share, stability, silhouette and reference, representation, run;
  4. flags ("mostly one source"; "may be spelling or register");
  5. actions: **Rename** · **Read all (≈ 4 min)** · **Regenerate label** · **Notes**.
- **A gated strand** shows its gate card with **[Read all]** or **[Widen]**.

### 5.3 The inspector

- **Then (M1).** A "Context group" row (computed: label, cos and margin). "Machine annotations (fallible)" lists Qwen glosses that touch this passage. An unread occurrence shows **Read this occurrence** (≈ 0.3 s est.).
- **Now and Next (M3).** As in §3.10.
- **The fixed footer stays:** "Then shows documents and their settings, not anyone's private thoughts."

### 5.4 Compare (M2)

- **Panel 5, Context groups:** shares per slice with CIs, "new" and "declining" uses, from `qgroups` on A ∪ B. A gate card when gated.
- **Panel 6, Estimated shift:** the (a) and (b′) lines with the anachronism caveat (§3.5).
- **Panel 6½, new: Machine reading of the difference.** A collapsed machine card: *"Ask Qwen to read 10 passages from A and B (≈ 25 s)"*. It runs on tap and **never above the computed panels**.
- **Panel 7, Tone (M3):** Qwen distributions; human stance and `pragmatic_function` counts as before.

### 5.5 Ask (M2)

- **No new modal and no new tab.**
  - Search's suggestions gain a group, **"Ask the atlas — machine reading"**, whenever the query has ≥ 4 words or ends with "?".
  - Tapping it sets `SheetMode.ask(session)` at the large detent.
- **The Ask panel** (Q's view) has:
  - scope chips at the top;
  - the stage list with numbers ("Finding passages · 64", "Reading with the embedder · 64", "Loading Qwen3-4B", "Writing · 212 tokens") and **Cancel**;
  - then the verified claims, each with tappable citation chips (date chip from the data, `SYN` when synthetic);
  - then "Passages read (10)";
  - and **Keep in notebook**.
- **VoiceOver** reads "Machine reading:" before every claim, and citation chips are buttons ("Passage, 1911, Brennock's primer, synthetic"). Completion is announced once.

### 5.6 Notebook (M2)

- **A "Machine readings" section** groups Qwen layers by target (labels, explanations, kept answers, drafts) as "rev 1 · machine · Qwen3-4B@2a73c6c2 · run #41".
- **Machine layers can be countered or rejected, never edited** (as IOS-SPEC §4.13 says for machine annotations).
- **Draft with Qwen** in the editor creates a machine draft from the evidence he selected. **Make it mine** copies it into his editor and records `drafted_from`.

### 5.7 Settings → On-device model (Q), and How Scrolls works

- **Settings → On-device model** shows, per model: name, size, sha8, status (missing · in Inbox · verifying 41% · installed · resident), last load time and measured footprint. It also has:
  - free memory now;
  - **Unload now**;
  - toggles: *Read contexts automatically when I track a word* (on) · *Label groups automatically* (on) · *Keep Qwen3-4B loaded while Scrolls is open* (off) · *Machine stance suggestions* (off; locked until κ passes) · **Machine readings** (master switch, on).
- **How Scrolls works** sections 06 and 07 gain:
  - 06 "Machine readings: generated text about cited passages; never evidence", with the machine-card swatch;
  - 07 the models row.
- **The Legend** gains the machine-card row and the estimated-group-bin row.

### 5.8 First minute, tour, haptics, accessibility

- **The first minute is unchanged in timing.**
  - The demo's groups and labels are prebuilt (§2.8), so its lanes show their Qwen labels and the computed "machine label: counted · hold · ones" words from second 0, and Qwen is never on the critical path.
  - *Your turn* gains the chip **Ask: why did "carry the zero" turn ironic?**. In the demo it answers from the starter's recorded run and is labelled "built on the Mac" until he asks something new.
- **The tour (M4)** gains step 11: open a group card, compare its machine label with the distinctive words, rename it.
- **Haptics.** None for Qwen events: a refusal, like a gate card, is information, not an error.
- **Reduce Motion.** Changes nothing here (no streaming).
- **Copy.** Every Qwen string lives in `QwenCopy.swift` / `AskCopy.swift`, linted by `CopyLintTests` (British spelling, mental-state verbs).

---

## 6. Build plan for the rewrite

### 6.1 Packages and exclusive ownership (additions and changes to IOS-SPEC §8.1; everything else keeps its owner)

```
Native/
├─ project.yml                                        [N0]  + packages: ScrollsQwenKit (path), mlx-swift 0.32.3, mlx-swift-lm 3.32.3,
│                                                           swift-transformers 1.3.0, swift-collections 1.5.0 (exactVersion);
│                                                           app deps MLX*, Tokenizers only via ScrollsQwenRuntime
├─ Tools/build.sh                                     [N0]  + qwen-cli (xcodebuild macOS scrolls-qwen) · qwen-test (xcodebuild test ScrollsQwenKit)
├─ Tools/{models.sh, qwen-ref.py, check.d/qwen.sh}    [Q]   push/verify models; the Python reference (cipher-llm venv, no new installs); the Q stage
├─ Golden/qwen/                                       [Q]   fixture windows + Python reference vectors, eval sets (labels, Ask, unanswerable)
├─ ScrollsKit/Sources/
│  ├─ ScrollsStore/Resources/qwen-profile.sql · ScrollsStore/Qwen/**              [N0]
│  ├─ ScrollsContracts/Qwen/** (Q1 types) · ScrollsService/AtlasQwen.swift        [N0]
│  ├─ ScrollsStore/Journal/JournalTypes.swift (+ machineRun) · ScrollsCore/QwenVocab.swift [N0]
│  ├─ ScrollsQwen/**                                                               [Q]
│  ├─ ScrollsAnalysis/{Groups,Shift,Edges}/** · Tasks/{QGroups,QShift,QEdges}Task.swift   [N4]
│  ├─ ScrollsNL/**                                                                 deleted (N4)
│  └─ ScrollsService/{LiveQwen,LiveQwen+Models,LiveQwen+Read,LiveQwen+Generate,LiveQwen+Ask}.swift [Q]
│     ScrollsService/LiveAtlas+Clusters.swift [N4] · TaskRegistry.swift [N0] · JournalReplayer machineRun [N6]
├─ ScrollsQwenKit/ (Package.swift, Sources/ScrollsQwenRuntime/**, Sources/scrolls-qwen/**, Tests/**)   [Q]
├─ Scrolls/Qwen/{QwenHost,ModelSettingsView,QwenStatusModel,MachineReadingCard,MachineBadge,QwenCopy}.swift [Q]
├─ Scrolls/Ask/{AskPanel,AskModel,AskCopy}.swift                                   [Q]
├─ Scrolls/Inspector/{SheetMode,GroupCard}.swift (+ .groupCard, .ask cases)        [N8]
├─ Scrolls/Compare/** (panels 5, 6, 6½, 7)                                         [N4]
├─ Scrolls/Notebook/** (machine section, Make it mine)                             [N6]
├─ Scrolls/Diagnostics/Steps/QSteps.swift                                          [Q]
└─ ScrollsAppTests/QwenUITests.swift (RecordedRuntime) [Q] · ScrollsUITests/FirstMinuteTests (+ demo lanes) [N8]
```

- **Rules (IOS-SPEC §8.2) unchanged:**
  - one owner per file; contracts through N0, additively;
  - agents create no `.md` files;
  - every agent builds in its own mirror;
  - `PENDING_DEVICE` is never PASS.
- **Q's MLX builds** use the agent's mirror `dd/` (xcodebuild derived data) and run serially with app builds on a loaded Mac (R12).
- **Placeholders the lead must pre-create:**
  - `Native/Docs/status/Q.md` (owner Q);
  - `Native/Docs/QWEN.md` (owner Q: models as installed, prompts registry, budgets as measured, the Verifier's rules as built);
  - `Native/Docs/EVAL.md` (owner Q: the label and Ask evaluation sets, and his judgements).
  - `Native/Docs/QWEN-LAB.md` already exists (lab).

### 6.2 Milestones: a working app on his phone at every one

| Milestone | Packages | Exit gate (device rows need him with the phone unlocked on its cable) |
|---|---|---|
| **M0Q: Qwen bring-up** (first; one device session) | N0 (additive contracts, profile, journal op, vocab, lint, build modes, **TaskRegistry wiring**), Q (runtime spikes), I | **S1** the app with the MLX packages builds for the device (time recorded; versioned unsafe-flags dependency accepted or the fallback applied) and installs. <br>**S2** models pushed and sha-verified on the phone; `bm25` on contentless FTS confirmed. <br>**S3** `os_proc_available_memory()` at launch, with the entitlement signed (or the signing refusal recorded); `BGTaskScheduler.supportedResources`. <br>**S4** embedder tokens/s at batch 1/8/16/32 and the 4B prefill/decode tokens/s and load time, cold and after 5 min. <br>**S5** guided JSON round trip (label schema), grammar compile time, greedy determinism (same prompt twice → identical bytes). <br>**S6** Swift (Mac, xcodebuild) = Python vectors, cos ≥ 0.999 on 200 windows (padding and pooling rules of §0.2). <br>**S7** cancel ≤ 500 ms; background unload with footprint back to ≤ baseline + 300 MB; memory warning; `-fakeThermal 3`. <br>**S8** a 10 s scripted pan while embedding: hitches recorded. <br>Also the old M0 device rows (`-selftest probe`, transfer MB/s). |
| **M1: *bank* on his phone** | N2 (wiring, packs, starter + demo Qwen runs), N3 (G3 m1r), N4 (Groups), Q (read, label, LiveQwen, model page), N6 (`machineRun` + label replay), N7 (estimated group bins, labels), N8 (group card, Then row, status chip), I | **On the device, from a fresh install with models pushed:** <br>1. the demo paints in ≤ 1.0 s with the coach marks, and *carry the zero* shows 4 group lanes with machine labels (prebuilt); <br>2. phase A ≤ 60 s → *Switch to Cipher*; phase B completes within its bound and survives a kill; <br>3. search *bank* (and *shunya* → शून्य/શૂન્ય) → strand → honest bars, shelves, coverage, seam; <br>4. tap a mark → the passage at exact offsets (20 of 20); <br>5. **Context groups for *bank*:** the first look (≤ 600 read) on the phone within ≤ 90 s (LAB-6 revises), with progress and Cancel ≤ 500 ms → groups, or an honest gate. The reference's PPMI-SVD run found two groups here, "money · account · notes · mr" (2,053) and "river · along · water · stream" (2,256), stability 0.99. A Qwen run that recovers neither is recorded as a finding for the lab, not hidden; <br>6. **Qwen labels** for every group, each with ≥ 2 verified citations, ≤ 60 s after the groups; lanes on the Scroll with estimated bins; <br>7. rename a group → the machine label stays visible → force quit → relaunch: lanes, labels and rename restored identically; <br>8. backgrounding unloads the model (footprint rule); <br>9. **`-selftest qwen-soak`**: 20 min of reading and labelling three words (*bank*, *current*, *spring*) with **no signal 9**, peak footprint recorded. <br>**Gates:** C0, G1, G2 (mini, ingest, demo, Cipher slice, boilerplate), **G3 on m1r** (read path), G5, G8, Q1–Q4; lint and quick green. |
| **M2: Compare, Ask, views, import** | N1 (routes + wizard), N3 (exports), N4 (Compare + groups/shift panels + `qshift`), Q (`qexplain`, Ask), N6 (views as-saved with pinned Qwen runs, Notebook machine layer, Make it mine), N8 (Ask entry), I | Compare on the phone (coverage first, frequency + CIs, collocates, gates, groups, shift with caveat, machine reading on tap); **Ask** on *bank* and *carry the zero* (LAB-8 met, or Ask stays off); save a view → force quit → reopen identical, including its machine readings; `letters.csv` imports with exact counts; exports flag machine readings. **Gates:** G3 Compare exact on m1r, G7 on m1r, Q1–Q6. |
| **M3: full corpus, lineage, Qwen edges** | N2 (STEMM pack, generations, swap), N5 (reuse index, lineage UI), N4 (`qedges`, tone), Q (`qreuse`, `qdraft`, `qtone`, `qstance`, `qallusion`), N6, N7 (arcs, Term trail), N8 (Now/Next, Crossings), I | The STEMM pack loaded on the phone; G2 STEMM slice; G3 on m5r; **G6 evidence phone = Mac**; D17 across a load, a swap and a restore, **including machine readings replayed from the journal**; Funky Drummer 32/98/48; similar-use edges hidden by default; Now's reuse reading; Next drafts; tone distributions; stance stays off unless κ ≥ 0.4 and he opts in. |
| **M4: polish and handoff** | all, I-M4 | The full tour with the machine-reading step; the constellation (Fruchterman–Reingold; collocation and similar-use edges; overlay); accessibility audits including machine cards and the Ask panel; every budget measured on the device; a 60-minute Qwen soak; HANDOFF (what needs the models, what is machine output, what is unfinished). |

### 6.3 Tests

| Tier | Where | What |
|---|---|---|
| **Q1** runtime parity | `qwen-test` (Mac, xcodebuild) | the Swift embedder = the Python reference, cos ≥ 0.999 on 200 fixture windows, including right padding, last-token pooling and no LayerNorm; the 4B gives token-identical greedy output on 20 prompts (≥ 18/20; differences are recorded with their first divergent token) |
| **Q2** determinism | Mac and device (`-selftest qwen`) | the same input twice → byte-identical vectors and outputs on one device; the starter's demo vectors re-read on the phone at cos ≥ 0.999 |
| **Q3** truth | `swift test` (`ScrollsAnalysisTests`) on recorded vectors + `qwen-test` live | the demo's planted senses: ARI ≥ 0.8 (*carry the zero*, k = 4) and ≥ 0.7 (*flux up*); ◉ *kiln eye* Compare gated `insufficient_occurrences`; the pseudo-word benchmark (LAB-2) recorded per representation; k-means invariant to input order |
| **Q4** honesty | `swift test` (`ScrollsQwenTests`, pure) | the Verifier on adversarial outputs: invented `P`-ids; fabricated quotes (one character off); digits (if the grammar is bypassed); mental-state verbs; one-sided comparative claims; `answerable: false`; empty scope; gated inputs never reach a prompt (a prompt-builder test); **no machine reading can create a documented or computed relationship** (a DDL + service test); exports carry `machine_reading`; a UI text scan finds no machine card without its footer |
| **Q5** lifecycle (device) | `-selftest qwen-probe`, `qwen-soak` (AttentionMachine's `DeviceStabilityCheck` pattern: memory-pressure source, watchdog, heartbeat JSON) | cancel ≤ 500 ms; unload on background; footprint rules; thermal pause; no signal 9 in 20 min (M1) and 60 min (M4) |
| **Q6** evaluation | `scrolls-qwen eval` + `Native/Docs/EVAL.md` | labels for the 15 words and the demo (LAB-7, judged by him); Ask: 30 answerable + 20 unanswerable questions (LAB-8); stance κ (LAB-11) |

The trimmed differential tiers are in §1.3. `check.sh` gains the stage `qwen` (Q): pure tests plus `qwen-test` on the Mac. `full` adds it.

### 6.4 Order and coordination

1. **M0Q.**
   - N0 lands the additive contracts, the profile, the journal op and `TaskRegistry` first (≈ 1–1.5k lines).
   - Q builds its pure target against them and the runtime against mlx-swift-lm.
   - Q's `RecordedRuntime` and the Q1 types let N4, N6, N7 and N8 start at once.
   - The I agent books **one device session early**. Every M1 risk depends on S3/S4/S7.
2. **M1** runs N2, N3, N4, Q, N6, N7 and N8 in parallel. N1 and N5 hold, except for keeping `quick` green.
3. **The lab** feeds LAB-1…LAB-12. Each slot's decision lands as a one-line change in `ScrollsQwen/Policy` or a new representation key. No agent waits for the lab: every assumption above is buildable as written.
4. **Effort (est.):**
   - Q ≈ 6–8k lines (pure 2.5k, runtime 2k, service and tasks 1.5k, UI 1.5k) plus ≈ 1.5k of tests;
   - N4 ≈ +2.5k, against ≈ 6k of planned statistics never written;
   - N0 ≈ 1–1.5k.

---

## 7. Risks and questions for Utkarsh

### 7.1 Risks

| # | Risk | Likelihood · impact | Mitigation | If it happens |
|---|---|---|---|---|
| QR1 | Jetsam (signal 9) with the 4B plus the engine | **high** (seen twice in AttentionMachine) · high | One resident model; admission coupled to engine jobs; `kvBits`; prompt cap; idle and background unload; 20-min soak at M1 | prompt cap 1,024; labels per group instead of per run; a smaller generator (QR2) |
| QR2 | `increased-memory-limit` unavailable to his signing, ceiling near 3 GB | unknown · high | S3 measures on the first install | Qwen3-1.7B-4bit (≈ 1 GB; **needs his OK to download**) as the generator, or generation off: groups plus distinctive words still work |
| QR3 | MLXGuidedGeneration does not build: unsafe flags in a versioned dependency, or XGrammar C++ on Xcode-beta 27A5194q | medium · medium | S1 first | pin by revision or a local path checkout of the cached 3.32.3 (no download); else a 200-line logit-mask decoder for our fixed schemas (enum + bounded string + id-pattern arrays); else parse-then-validate with one retry |
| QR4 | Qwen does not beat PPMI-SVD on the pseudo-word benchmark | medium · medium | LAB-2 tries R1–R4 and centring | groups ship labelled "experimental"; the honest gate stays; the lead and Utkarsh decide |
| QR5 | Too slow on the phone (first look > 90 s, Ask > 45 s) | medium · medium | measured switches (§2.4, §2.7); batching; caches | smaller first look; fewer passages; an optional vector pack (§2.8) |
| QR6 | Heat throttles long reading | medium · low | the thermal table; foreground-only | Read all resumes later; nothing is lost (cache) |
| QR7 | GPU contention makes the Scroll hitch | medium · medium | yield while interacting; ≤ 100 ms batches; S8 | smaller batches; pause reading while the Scroll is on screen and moving |
| QR8 | Hindi and Gujarati read poorly (token-inefficient) | medium · low | LAB-3 measures | hi/gu groups carry a caveat; labels show original-script distinctive words |
| QR9 | Build time of MLX on the loaded Mac | high · medium | persistent `dd/` per agent; Q builds serialised through I | the MLX-free path: only Q and I build MLX; others use `RecordedRuntime` |
| QR10 | Model or runtime updates change readings | certain over time · low | representation keys; pinned runs; journaled outputs | old readings stay as layers; new ones are new runs |
| QR11 | The simulator cannot run MLX, so UI tests see only recorded output | certain · low | `RecordedRuntime` fixtures recorded on the device, labelled "recorded" | device rows cover the live path |

### 7.2 Decisions this proposal needs from him (through the lead)

1. **Stance and irony suggestions (Q-15).** IOS-SPEC §7.3 and SPEC §14 say "never". This proposal keeps them off unless κ ≥ 0.4 **and** he opts in. Should he prefer "never", `qstance` is cut and nothing else changes.
2. **Model delivery.**
   - Push once from the Mac (the default: small device installs).
   - Or bundle the models in the app as AttentionMachine does (every Xcode install copies ≈ 2.6 GB over the USB 2 cable).
   - A later option is a shared App Group store with AttentionMachine and Cipher, which use the same 4B (saves 2.26 GB). Not v1.
3. **The fallback generator if S3 shows ≈ 3 GB:** Qwen3-1.7B-4bit (a ≈ 1 GB download, needs his OK), or no generation on the phone.
4. **M1 scope.** It moves Compare, saved views, import and exports to M2 so that a Qwen-powered *bank* reaches his phone first. Confirm.

*Guiding principle, kept: an expression carries its past into each new encounter. Qwen adds a reader from the present. Scrolls shows what that reader read, cites every line it leans on, and never lets it speak for the evidence.*
