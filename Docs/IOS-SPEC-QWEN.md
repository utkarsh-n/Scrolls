<!-- OWNER: lead (Qwen synthesis, 2026-10-13). Replaces the placeholder. A DELTA on Docs/IOS-SPEC.md, which is itself a delta on Docs/SPEC.md. SPEC §13 stays law and is extended by §4 below. Supersedes Docs/ios-proposals/qwen-rewrite.md (the architect's draft) and folds in every required change of Docs/ios-proposals/qwen-critique.md §8 (P0-1 … P2-25) and the lab evidence in Native/Docs/QWEN-LAB.md. -->
# Scrolls for iPhone, Qwen edition: native SPEC v2

**Status.** The build specification for the Qwen-centred rewrite, 2026-10-13. §0–§3 written at 23:10; §4–§9 and the ground-truth refresh of §0.2, §1.1 and §1.2 at 23:40, while the bring-up (B2/B3) and the lead's first install run.

**His decision** (brief.md, "Qwen decision", 2026-10-13): Qwen powers the app itself, on his iPhone.
- **Qwen3-Embedding-0.6B** gives a contextual vector for every occurrence that is read. Context groups (sense hypotheses) are **computed** from those vectors.
- **Qwen3-4B-Instruct-2507** writes labels, explanations and answers from cited quotes.
- Everything Qwen writes is **labelled machine output**.

**Layering.**
1. `SPEC.md` holds the semantics, the data model, the algorithms and the honesty rules (§13 is law).
2. `IOS-SPEC.md` holds the native port (its ΔS register).
3. **This file** holds the Qwen delta (the ΔQ register, §0.3).

Where this file is silent, IOS-SPEC holds. Where both are silent, SPEC holds.

**What this file replaces** (each line has a ΔQ row in §0.3):
- IOS-SPEC **N-02 / N-10** "derived builds on the phone" (pooled spaces, era slices, co-occurrence): cut. Qwen vectors per tracked expression replace them.
- IOS-SPEC **N-04** "no third-party code": the MLX stack is allowed, in `Native/ScrollsQwenKit` and the app's `Scrolls/Qwen` only.
- IOS-SPEC **N-15 / §3.8** memory: model budgets and model admission are added (§2.5).
- IOS-SPEC **§1.2 / §1.3** analysis targets: `ScrollsQwen` is added; `ScrollsNL` is deleted (M2); TF-IDF-hash, PPMI-SVD, rSVD, Procrustes and exact k-means parity are cut.
- IOS-SPEC **§2** tier G4: cut. The Q tiers are added (§6).
- IOS-SPEC **§3.1 / §3.6** derived storage and derived build steps: replaced by the vector cache (§2.7).
- IOS-SPEC **§4.8** (Then), **§4.10** (Compare panels 6–8), **§4.12** (constellation), **§4.17** (first minute): changed (§5).
- IOS-SPEC **§7.3** (v1 vs later) and **§8.7–§8.9** (milestones, order, placeholders): replaced by §7 and §9 here.
- SPEC **§4.8** contextual clustering, **§4.9** drift, **§4.10** tone: replaced by §3.
- SPEC **§13** rules 8 and 10: amended. Rules 19–34 are added (§4).
- SPEC **§14** rows M3 and M5 (clustering, spaces, Apple NL): replaced.
- The draft `Docs/ios-proposals/qwen-rewrite.md`: superseded entirely. Its LAB-1…LAB-12 slots are set in §0.4.

**Tags on numbers.**

| Tag | Meaning |
|---|---|
| **(measured: where)** | taken by someone, somewhere named |
| **(lab §n)** | a Mac measurement in `Native/Docs/QWEN-LAB.md` §n (M1 Max, MLX, contended) |
| **(read: file)** | verified by reading source or config |
| **(derived: how)** | counted by the synthesiser from a named file |
| **(est.)** | a planning estimate |
| **(gate: …)** | the behaviour ships only after the named measurement |

**No Qwen number in this file has been measured on the iPhone.** M1a (§7.3) measures them. Until then each budget is provisional, and `Native/Docs/QWEN.md` records the device value that replaces it.

**How agents use this file.**
1. Read §0.
2. Read §7: your package, your task and the task rules (§7.2).
3. Read the sections your task names.
4. Read SPEC §13 and §4 here. Reviewers reject code that breaks a rule.

---

## 0. Decisions, evidence and the deltas

### 0.1 Decisions

| # | Decision | Evidence / why |
|---|---|---|
| Q-01 | **Two Qwen models run inside the app process** on his iPhone 15 Pro Max: <br>• the embedder **Qwen3-Embedding-0.6B 8-bit** (sha256 `fe956e8d…`, 649,088,604 B); <br>• the generator **Qwen3-4B-Instruct-2507 4-bit** (`2a73c6c2…`, 2.26 GB). <br>No server, no network, no download code. | His decision. 8-bit, not 4-bit DWQ: per-vector cosine 0.952 to the 8-bit model (fails ≥ 0.98), and 4-bit is not faster (lab §1.3, §2.2). |
| Q-02 | **One model is resident at a time.** One `ModelManager` actor owns residency. It unloads on background, memory warning, critical memory pressure, thermal *critical*, idle (embedder 30 s, 4B 90 s) and **Unload now**. | Both resident: 3.6–3.8 GB peaks (measured, lab §2.6); one at a time stays near 3.0 GB with the step rules. AttentionMachine's two signal-9 terminations are **unexplained, and one came before any model load** (read: AttentionMachine QUALITY.md), so they are not evidence about memory. The soak classifies every termination (§6.4). |
| Q-03 | **Memory comes from the measurements:** <br>• the prefill step is passed explicitly: **256 for prompts ≤ 1,024 tokens, 128 above**; <br>• no `kvBits`; <br>• prompts are capped at **1,024 tokens at M1**; <br>• embedder **batch 8**, and 4 while the Scroll is visible; <br>• admission reserves only a model's **remaining growth** once it is loaded (§2.5). | Step 512 peaked at 3.086 GB at 1k (lab §2.3), and mlx-swift-lm 3.32.3 defaults to 512 (read: `PrefillParameters.swift`). `kvBits 8` did not lower the peak. The old admission rule double-counted the weights (critique §1.1). |
| Q-04 | **Vectors are read lazily, per tracked expression.** <br>• A *first look* reads ≤ 600 occurrences, ≤ 3 per document, stratified by decade × collection. <br>• **Read all is an explicit opt-in per strand**, capped at 5,000 per scope, resumable, and it only *assigns* occurrences to existing groups. | 600 ≈ 30–60 s on the phone; a typical STEMM word ≈ 7–14 min and a p90 word 15–31 min for everything (est., lab §2.7). |
| Q-05 | **Context groups**: spherical k-means on centred **R1** vectors (the measured `instr` template, a ±24-word window, 256 dims), gated by **rule_v2**: <br>• the first k, in falling-silhouette order, with stability ≥ 0.8; <br>• silhouette − no-groups reference ≥ 0.03; <br>• silhouette ≥ 0.10. <br>The thresholds are frozen per representation key and recorded as **provisional** (set on 13 real-word runs, not calibrated on pseudo-words). **English only at M1.** | rule_v2 keeps *bank*, *charge* ×2 and *current* ×2, and gates *cell* ×2, *plant* ×2, *key* ×2 and *spring*/literature (lab §1.5). The old 0.6 / 0.10 rule admitted subject splits. |
| Q-06 | **Every fit keeps the per-document cap** (≤ 3). Concentration is **computed** as enrichment on the assigned population: a document flag, a collection flag and a **subject flag** from `doc_tag`. The model is never asked to judge concentration. | Every group's top document holds exactly 2 or 3 occurrences, forced by the sampling (derived, lab §1.6). A "collection > 80%" flag fires on 52 of 54 groups. The model's `kind` enum was used sensibly 0 of 6 times (lab §3.3). |
| Q-07 | **Shift is measured in one model space:** the group-share JSD plus the centroid displacement with a document-permutation null, a composition caveat and a **subject-mix** caveat. No alignment and no era spaces. | One embedder reads every period. STEMM subject groups differ in median year (air-cells 1858 against battery 1885; lab §1.4). |
| Q-08 | **Generation is grounded and guided:** <br>• XGrammar JSON, greedy; **one call per group** for labels; <br>• claims cite passage ids, and quotes are rendered from the atlas; <br>• **a hard quote gate**; <br>• digits banned by the grammar (`\p{Nd}`) **and** numbers and dates rejected by the Verifier, in depth; <br>• change, cause and mental-state wording withheld; <br>• nothing is shown before the Verifier has run. | One call per group labelled better (demo 3 + 1 partial against 2 + 1 + 1 wrong). The lab's verifier kept a stitched quote. The Ask digit ban was never exercised (`masked_steps = 0`) (lab §3.3–§3.5). |
| Q-09 | **Ask and `qexplain` retrieve passages stratified by context group and by period.** <br>• Index and heading lines are dropped. <br>• 6 passages at ±32 words, prompt cap 1,024. <br>• Refuse **before generating** below 3 passages from 2 documents. <br>• "What does X mean" questions go to the group card. <br>• The selection method is disclosed. | Ranking by similarity to the question gave only financial *bank* (the river group is larger) and only "bank" for *banco* (bench is 87 of 160) (lab §3.5). |
| Q-10 | **Machine readings are a fourth class**, beside observed, computed/proposed and human. They are never evidence, never counted, never a documented or computed relationship, and **never called "verified"**. | Brief §1; critique §2.3. |
| Q-11 | **The heavy statistical port is cut:** co-occurrence/PPMI, rSVD, pooled and era spaces, Procrustes, neighbour overlap, TF-IDF-hash, exact k-means parity, Apple NL tone, tier G4. | None of it exists: ScrollsAnalysis has no space or cluster code, and ScrollsNL is 37 lines (read). The cut deletes plans, not code. |
| Q-12 | **Differential testing stays for the deterministic parts** (§6.1). | The oracle is useful where an exact answer exists. |
| Q-13 | **MLX is the only third-party code.** It lives in `Native/ScrollsQwenKit` (a local package that only xcodebuild builds) and in the app's `Scrolls/Qwen`. Every decision lives in the pure target `ScrollsQwen` (`swift test`). | SwiftPM on the command line cannot build MLX's Metal shaders (read: mlx-swift README@0.32.3). `check.sh quick` stays MLX-free. |
| Q-14 | **Models arrive from the Mac** (`Tools/models.sh push`) and are sha-verified on the phone. The simulator and UI tests use `RecordedRuntime`, labelled **"recorded"**. | SPEC §13.16. MLX does not run in the simulator. |
| Q-15 | **Machine outputs are immutable rows, appended to the journal (`machineRun`) from M1.** Replay is built at M2. | The atlas already survives a force quit. D17 across generations needs replay only at M2. |
| Q-16 | **M1 is staged so that each stage lands on his phone:** <br>• **M1a** Qwen on this iPhone (the bring-up = M0Q); <br>• **M1b** *carry the zero* computed live; <br>• **M1c** *bank* on Cipher; <br>• **M1d** soak and gates. <br>Compare, Ask, saved views and import move to M2. | The Cipher text pack has never been built (only the starter and cipher-meta exist, since 23:06); six package status files are empty; sessions end without warning (critique §4). **He must confirm the reorder** (§8): the brief's vertical slice puts Compare and Save view before clustering. |
| Q-17 | **Defaults that need his judgement stay off until he gives it:** <br>• *Label groups automatically* (his verdict on ≈ 20 labels at the M1c session); <br>• Ask (his semantic-support judgement on the 30 + 20 set); <br>• stance (κ ≥ 0.4 **and** his opt-in); <br>• tone (an evaluation). | The lab's judgements are the lab agent's. 2 of 9 claims were only partly supported and passed every mechanical check (lab §3.5). |

### 0.2 Ground truth (corrected 2026-10-13, 23:40)

| Fact | Value | Consequence |
|---|---|---|
| Models on the Mac (read: `~/Developer/scrolls-models`, MODELS.json; lab §2) | **4B:** 2,263,022,417 B of weights on disk, sha256 `2a73c6c2…`, resident 2,264,693,768 B after load; 36 layers, 8 KV heads, head dim 128 (147,456 B of f16 KV per token). <br>**Embedder 8-bit:** 649,088,604 B, `fe956e8d…`, 633 MB resident. Hidden 1024, 28 layers, vocabulary 151,669. <br>**Embedder 4-bit DWQ:** 351,233,351 B, `3d773d5e…`. Not shipped. | ≈ 2.91 GB of models on the phone, outside the app bundle. |
| AttentionMachine, the same 4B on his phone (read: QUALITY.md, MODEL.md, README; lab §2.5) | <br>• process-ledger peak footprint **2.662 GB** at ≤ 95 prompt tokens (largest sampled footprint 2.520 GB); <br>• 246.5 MB after unload against a 95.9 MB baseline; the MLX cache back to 0; <br>• warm decode ≥ 8.6–9.3 tok/s (a hard bound); <br>• **two signal-9 terminations, causes unidentified: one at the initial validation, one "after its CPU benchmark and before its first model load"**; <br>• built with no entitlements file (read). | A footprint near 2.7 GB for the 4B at a tiny prompt is achievable. Signal 9 alone proves nothing about memory. |
| Scrolls' entitlements (read: `Scrolls.entitlements`, status/I.md) | `increased-memory-limit` requested. `extended-virtual-addressing` is refused for a personal team. | M1a records whether the memory entitlement was signed. |
| mlx-swift-lm 3.32.3 (read: the SwiftPM cache at tag 3.32.3) | <br>• `PrefillParameters.defaultStepSize = 512`, and `GuidedGenerationLoop.run(…, prefill: .init(stepSize: PrefillParameters.defaultStepSize), emit:)`; chunking `.balanced` by default; a `progress` callback runs after each chunk; <br>• `run` throws `GuidedGenerationError.incompleteOutput` when `maxTokens` runs out before the grammar stops; <br>• `closingBias` bends tokens towards closing JSON from `maxTokens − completionReserve` (64); <br>• no temperature parameter (argmax); <br>• `GrammarConstraint(tokenizer:jsonSchema:)`; <br>• local loads: `LLMModelFactory.shared.loadContainer(from:using:)` and `EmbedderModelFactory.shared.load(from:using:)` with a `TokenizerLoader` (`load(from:) async throws -> any Tokenizer`); <br>• `Pooling.callAsFunction(_:mask:normalize:applyLayerNorm:)`; `.last` takes index (mask ones − 1). | The prefill step must be a **required** argument (§2.3). Never pass `closingBias` or `kvBits`. Padding goes on the right, with padding masked 0 and the final `<|endoftext|>` unmasked; `applyLayerNorm: false`. |
| Native tree (the draft's `wc -l`, 2026-10-13; git) | Engine ≈ 69k lines, app ≈ 19.4k, tests ≈ 10.4k. Commits: M0 `5a66c69`; WIP `5a9cbe0`, `4520591`; the draft `9fb0724`; the lab `133b400`. **The status files of N1, N3, N4, N5, N6 and N7 are empty**; N0, N2 and N8 are written. | Nothing records which of the ≈ 69k lines compile or pass, beyond the bring-up's log. |
| Gates | G1 21/21, C0 260/260, G5 681,728 checks, G8 worst 0.042% (draft). G2 boilerplate exact. **`check.sh quick` SKIPs four private families on this Mac:** `g2.cipher-slice-inputs`, `g2.cipher-slice-rows`, `g2.demo-fts` and **`g3.read-m1r`** ("private family absent on this Mac (~/Developer/scrolls-golden/<ref>/private)"; read: check-quick-20261014T035759Z.json). **G3 has never run.** That quick run (started 22:57): mirror, manifest, build, lint, C0 (260 bodies, 0 mismatches) and 31 G1 families PASS; it FAILs on 8 test issues: ScrollsProvenanceTests 5 (N6: the anchor message, ViewsTests item count, JournalTests "no such table" on a rebuilt generation) and ScrollsJobsTests 3 (N0: the 500 ms cancel bound and priority order, timing at load ≈ 300). | A SKIP is recorded, never PASS. The private families are generated at M1c (task I-1c-0). |
| Bring-up B1 (status/I.md; `git log`) | **Committed as `a27c498` (23:24):** `TaskRegistry.all` lists 9 task types; `LiveAtlas.open` calls `BootstrapCipher.start`; the 3 banned `lowercased()` calls → `Fold.asciiLowercased`; Sendable and compile fixes in ScrollsLineage, ScrollsService, ScrollsQuery and app files; `extended-virtual-addressing` removed (refused for a personal team). The simulator build passes (23:09). | Gaps 1, 2 and 4 of §1.2 are closed in code. They count as **gated** once quick is green. |
| Packs (read: `~/Developer/scrolls-packs/v1`, status/I.md) | Built at 23:06, `current` → v1: **`starter.atlas`** (228 documents, 1,437 passages, 4 expressions, 4 runs, 22 annotations) and **`cipher-meta.scrollspack`** (29.6 MB). **`cipher-text` has never been built**, so no Cipher full text can reach the phone and phase B has nothing to load. | M1c builds `cipher-text`. |
| The phone | Nothing of the native app had run on it before tonight. **At 23:25 the lead is building and installing the current app, without Qwen** (`Tools/build.sh install`, build dir `~/Developer/scrolls-build/device`). All 16 rows of `Reports/device-queue.json` are `PENDING_DEVICE`. | B3 (M1a's device session) waits for that install to finish (`pgrep -f "build.sh install"`). |
| Build directories | The Mac rebooted twice on 2026-10-13 (≈ 22:25 and 22:39) and wiped every `$TMPDIR/scrolls-*` mirror. `build.sh` and `check.sh` **still default** to `${TMPDIR}/ScrollsBuild` (read, 23:30). The lead's install and the bring-up's B2/B3 already pass `~/Developer/scrolls-build/<part>`. | ΔQ-14; task N0-Q0 changes the defaults. |
| The bring-up's Qwen code | `Native/ScrollsQwenKit`, `ScrollsKit/Sources/ScrollsQwen` and `Scrolls/Qwen` **did not exist at 23:26** (checked). **B2** (started 23:25) creates them: the pure `ScrollsQwen` target, `ScrollsQwenKit` (ModelStore, QwenEmbedder, QwenGenerator, QwenMemoryGuard), the "Qwen on this iPhone" screen (`-qwen-demo`) and `-selftest qwen`. **B3** then runs the device session. | §2's signatures are the M1b target. The rule is §2.1; the known differences are in §7.3 (Alignment). |
| Corpus (lab §2.4) | 2,763,209 passages, 146,664,878 atlas tokens. *bank* in Cipher literature: 4,309 clustered occurrences. | "Every occurrence" means every occurrence of a word he reads, never the corpus. |

### 0.3 The ΔQ register: what this file overrides

Only these rows override IOS-SPEC and SPEC. Everything else holds.

| ΔQ | Overrides | Change |
|---|---|---|
| ΔQ-1 | IOS-SPEC N-02, N-10, §3.1 "Derived", §3.6 "Derived" | The phone builds **no** pooled spaces, era slices or co-occurrence tables. Token streams remain (collocations), and so does the reuse index (deterministic). Qwen vectors are read lazily per tracked expression (§3.1) into a purgeable cache (§2.7). |
| ΔQ-2 | IOS-SPEC N-04 | Third-party code is allowed **only** in `Native/ScrollsQwenKit` and `Scrolls/Qwen`: mlx-swift 0.32.3; mlx-swift-lm 3.32.3 (MLXLLM, MLXLMCommon, MLXEmbedders, MLXGuidedGeneration); swift-transformers 1.3.0 (Tokenizers); swift-collections 1.5.0. Each is pinned `exactVersion`. **Not linked:** MLXHuggingFace, MLXFoundationModels, MLXVLM, MLXRerankers. |
| ΔQ-3 | IOS-SPEC N-08, §2.2–§2.5 | Parity is kept for deterministic modules only (§6.1). G4 is removed. DV-5 and DV-6 are closed as obsolete. The Q tiers are added (§6.2). |
| ΔQ-4 | IOS-SPEC N-15, §3.8 | Models get their own budgets and admission (§2.5). The engine rules stay: one job above 256 MB at a time, 600 MB headroom for engine jobs. A model's reservation, once loaded, is its remaining growth only. |
| ΔQ-5 | SPEC §4.8 | Representation, groups, gate, concentration and labels are §3.2–§3.6. The gate is rule_v2 per representation key, **never lowered after real words are seen**. |
| ΔQ-6 | SPEC §4.9 | Measures (a) group-share JSD (kept) and (b′) centroid displacement in one space (§3.7). The old (b) and (c) are dropped. |
| ΔQ-7 | SPEC §4.10; IOS-SPEC §4.10 panel 8; ΔS-17(a) | Tone becomes a Qwen reading behind an evaluation gate (M3, §3.9). Apple NLTagger, NLEmbedding and the NL-asset download are removed, so ΔS-17 keeps one network surface: a source link opened in Safari. |
| ΔQ-8 | SPEC §13.8 | Becomes: **no comparison across different representations or models**, and no cross-language shift by default (`representation_mismatch`, `language_mismatch`). |
| ΔQ-9 | SPEC §13.10, §13.11 | Rule 10 now covers Qwen labels and readings. Rule 11's words bind generated text through the Verifier. Rules 19–34 are added (§4). |
| ΔQ-10 | IOS-SPEC §7.3 "Never: the Foundation Models framework for any annotation" | Holds for Apple's model. Qwen (local open weights, recorded by sha) is the annotation model. MLXFoundationModels is not linked. |
| ΔQ-11 | Contract 1.3.0 | Unchanged; C0 stays 260/260. Qwen surfaces get the protocol **`AtlasQwen`** (version Q1, additive), like `AtlasPlatform`. The contract's `clusters` and Compare's `clusters`/`measures` fields serve Qwen groups and shifts in the same shapes, with `representation` = the Qwen key. |
| ΔQ-12 | `vocab.STAGES`, `JOB_TYPES` | The generated vocab stays byte-equal (G1 exact). Phone-only stages live in `QwenVocab` (§2.2). `TaskRegistry` gains `retired` = {`vectors`, `align`, `drift`, `tone`} and `mapped` = {`cluster` → `qgroups`}. |
| ΔQ-13 | IOS-SPEC §4.12, ΔS-10 | The constellation moves to M4, laid out by Fruchterman–Reingold over collocation and similar-usage edges. No vector-space positions, so no projection axis to label. |
| ΔQ-14 | IOS-SPEC §8.2 rule 3, `build.sh`, `check.sh` | Build mirrors and xcodebuild derived data live in **`~/Developer/scrolls-build/<agent>/`** (`SCROLLS_BUILD_DIR`, `-derivedDataPath $SCROLLS_BUILD_DIR/dd`), never in `$TMPDIR`. |
| ΔQ-15 | IOS-SPEC §8.7, §8.8, §8.9 | Replaced by §7 and §9 here. |
| ΔQ-16 | SPEC §9.6 demo calibration | *flux up* is scored against the **3** uses the generator actually plants (ARI ≥ 0.8); the 4-class ARI is recorded as information (§6.2 Q3). |
| ΔQ-17 | IOS-SPEC §4.17 | At M1b the demo's groups are computed live and never block the first minute; prebuilt demo runs arrive at M2. The draft's "Ask: why did … turn ironic?" chip is never built (§5.8). |
| ΔQ-18 | IOS-SPEC §8.7 M3 "*bank* gives the reference's two groups … ≤ 15 s" | *bank* through Qwen is an M1c exit (§7.3), with its own timing. |

### 0.4 The evidence table: the lab slots, set

| Slot | Set to | Evidence | Gate where evidence is missing |
|---|---|---|---|
| LAB-1 embedder | **8-bit** (`fe956e8d`) | cos 0.952 to 4-bit; 4-bit not faster; *bank* silver 0.942 against 0.928 (lab §1.3, §2.2) | — |
| LAB-2 representation | **R1 = `occ-instr@1`**: `Instruct: Represent the meaning of the {word\|expression} '<w>' in this passage` + newline + `Query: <window>` | every real-word result used it; demo styles equal within 0.012 ARI (lab §1.2) | pseudo-word acceptance against PPMI-SVD (LQ-1, LQ-2) before the "provisional" note goes |
| LAB-2b centring | yes, at analysis time | neutral (lab §1.7) | — |
| LAB-3 window | **±24 words** (engine tokens), clipped to the passage, ≤ 128 Qwen tokens in all | *bank*: ±32 Qwen tokens 0.942 > ±64 0.872 > passage 0.818 (lab §1.3); ±32 Qwen tokens ≈ ±21–25 English words (est.: 1.3–1.5 tokens per word, not measured), ≈ ±7 Hindi, ≈ ±4 Gujarati | LQ-3 measures ±24 words on *bank* and re-runs rule_v2 on the 13 runs; if *bank* silver < 0.92 the key reverts to ±32 Qwen tokens for English. Non-English groups: `language_not_evaluated` |
| LAB-4 width | 256 dims, f16 | 256 vs 1024 differ ±0.02–0.09 in both directions (lab §1.5) | thresholds per representation key |
| LAB-5 gate | **rule_v2**: stability ≥ 0.8, margin ≥ 0.03, floor 0.10 | 12 runs (lab §1.5) | **provisional**; LQ-1/LQ-2 calibrate on pseudo-words |
| LAB-6 throughput | embedder 10–20 R1 windows/s; 4B prefill 60–120 tok/s, decode 9–15 tok/s, load 3–8 s | lab §2.7 (est.; decode ≥ 8.6 measured on the phone) | M1a S4 measures; **ETAs always come from the rate measured live on this phone** |
| LAB-7 labels | one call per group; *Label groups automatically* **off** until his ≈ 20 labels | 12/14 acceptable to the lab agent (lab §3.4) | his judgement; re-measured through the Swift guided path |
| LAB-8 Ask | M2, **behind his semantic-support judgement** | 4/4 refused, 7/8 answered, claims 7 fully / 2 partly supported; a stitched quote in the thin run (lab §3.5) | the 30 + 20 set through the Swift guided path |
| LAB-9 memory | step 256 up to 1,024 tokens, 128 above; cap 1,024 at M1; embedder batch 8; no `kvBits`; reservations §2.5 | 2.938 GB at 1k/256; 3.086 at 1k/512; 2.964 at 2k/128; embedder 1.249 GB at 8 × 64, 1.520 at 8 × 128 (lab §2.2, §2.3) | M1a footprints replace the Mac peaks |
| LAB-10 determinism | byte identity **within one batch plan**; cos ≥ 0.999 across plans and against Python | Mac greedy 6/6 byte-identical across two processes (lab §3.3) | M1a S5, S6 |
| LAB-11 stance | off | not measured | κ ≥ 0.4 on ≥ 50 of his labels **and** his opt-in |
| LAB-12 similar-usage τ | max(per-run p99 of different-document cosines, 0.85) | *bank* only: p99 0.8517 at 256 d (lab §1.3) | recalibrated per key at M3 |
| LAB-13 tone (new) | off | not measured | κ ≥ 0.4 against his labels on ≥ 100 paragraphs (M3) |

---

## 1. Keep / cut / change, package by package

### 1.1 The packages and the code on disk

| Pkg | On disk (2026-10-13, 23:40) | KEEP | CUT | CHANGE (Qwen) |
|---|---|---|---|---|
| **N0** foundation | Core 5,968 · Contracts 6,388 · Store 4,263 · Jobs 1,671 lines; G1 21/21, C0 260/260; status written. The lint fix and TaskRegistry wiring landed in `a27c498`; ScrollsJobsTests has 3 timing failures under load. | all of it, with every N0 rule | <br>• the §2.4 tolerance rows for rSVD, clustering and drift; <br>• DV-5, DV-6; <br>• the `MappedFileRegistry` budgets for spaces; <br>• `derived/{spaces,align}` | <br>• `qwen-profile.sql`, RowIDPolicy and dump-spec rows; <br>• `ScrollsStore/Qwen/{VectorCodec,RepresentationKey,QwenSQL}.swift`; <br>• `MemoryBudget.reserveModel` (§2.5); <br>• `JournalOp.machineRun`; <br>• `ScrollsCore/QwenVocab.swift`; <br>• `AtlasQwen` and the Q1 contracts; <br>• TaskRegistry lines, `retired`, `mapped`; <br>• lint (§2.1); <br>• build dirs (ΔQ-14); <br>• `project.yml` packages |
| **N1** ingest | Ingest 9,161 lines; status empty; `LiveAtlas+Imports` has 6 `NOT_IMPLEMENTED`; no Import UI | all | — | none; the import routes and the wizard are M2 |
| **N2** sources | Sources 3,886 lines plus Service pipelines; status written; starter and cipher-meta built (23:06); **`cipher-text` never built**; `BootstrapCipher.start` wired (`a27c498`) | all | prebuilt demo Qwen runs inside the starter (replaced by a JSON resource at M2) | <br>• `DemoLoadTask` applies tracking and the pipeline runs (`cluster` → `qgroups`) instead of reporting them pending (M1b); <br>• packs built and bundled (M1c); <br>• the Sources page gets a Models row from `AtlasQwen.models()` |
| **N3** query | Query 9,396 lines; status empty; **G3 never run** | all; G3 on m1r is the M1c read gate | — | <br>• `ClusterLanes` reads Qwen groups: estimated bins, bins not split below 5 read, a titles lane, a "not grouped" lane (§3.5); <br>• exports mark `machine_reading: true` |
| **N4** analysis | Analysis 5,547 lines: Compare, stats, collocations, token streams, BaselineRho, slices; **no cluster or space code**; ScrollsNL 37 lines; status empty | all of it; G3 Compare exact | <br>• the whole M3 plan (TF-IDF-hash, co-occurrence/PPMI/rSVD, era slices, Procrustes, exact k-means parity, drift b and c); <br>• `ScrollsNL` (deleted at M2 with N0's manifest change); <br>• the G4 half of `gen-analysis.mjs` | **N4 becomes "groups, shift and Compare":** `Groups/**`, `Shift/**`, `Edges/**`; the `qgroups`, `qassign`, `qshift`, `qedges` tasks; `LiveAtlas+Clusters`; Compare panels 6, 7 and 7½ |
| **N5** lineage | Lineage 4,228 lines; status empty; compile fixes in flight | all; the reuse index stays (M3) | — | the edge card shows machine readings (M3); a `similar` filter, hidden by default |
| **N6** provenance | Provenance 4,263 lines; Views and Notebook UI 943; status empty; ScrollsProvenanceTests has 5 failures (quick, 22:57) | all | — | <br>• the demo's human layer (M1b); <br>• `machineRun` appended from M1, replayed from M2; <br>• `ViewCutoffResolver` pins Qwen runs; <br>• the Notebook's machine layer and *Make it mine*; <br>• Qwen labels stored as `machine_gloss` |
| **N7** the Scroll | ScrollModel 4,432 + Render 1,455 + Scroll UI 3,437 lines; G5 PASS, G8 PASS; status empty | all | — | <br>• estimated and not-split bins; <br>• the machine glyph on lane chips; <br>• `isInteracting` and `isVisible` feed `InteractionSignal` (§2.6) |
| **N8** experience | ≈ 7k app lines; status written; first-minute test written; device rows pending | all | the draft's "Ask: why …" chip (never built) | `.groupCard`; the Then context-group row; status-chip model states; tour step 5's copy (DV-Q1); the Your-turn chip (§5.8) |
| **R** reference | frozen at `ref-freeze-1`; m1r and m5r built | frozen | analysis findings (no oracle for them any more) | the finding protocol applies to the deterministic tiers only |
| **I** integration | B1 done (`a27c498`); the lead's first install running (23:25); B2 and B3 running (status/I.md) | the role | — | runs the bring-up (M1a), the staged device sessions and the `qwen-soak` suite |
| **Q** (new) | nothing on disk at 23:26; B2 is creating the first files | — | — | owns `ScrollsQwen`, `ScrollsQwenKit`, `LiveQwen*`, `Scrolls/{Qwen,Ask}`, `Tools/{models.sh,qwen-ref.py,check.d/qwen.sh}`, `Golden/qwen`, `QSteps` (§7.1). The bring-up creates the first files and hands them over at the end of M1a (§7.3). |
| **LQ** (new) | lab scripts and `.jsonl` committed (`133b400`) | — | — | the Mac follow-ups of QWEN-LAB §6, as resumable tasks (§7.4) |

### 1.2 Integration gaps on the M1 critical path, with today's state

| # | Gap | State | Where it is closed |
|---|---|---|---|
| 1 | `TaskRegistry.all` was empty, so the live app answered `E_JOB_TYPE` for every job | 9 types, committed (`a27c498`). `qvec`, `qgroups`, `qassign` and `qlabel` are still missing. | B1 (done); N0-Q1d (M1b) |
| 2 | `BootstrapCipher.start` was not called from `LiveAtlas.open` | committed (`a27c498`) | B1 (done) |
| 3 | `LiveAtlas+Imports`: 6 stubs, no import UI | open | M2 |
| 4 | Lint: 3 banned `String.lowercased()`; the Render row's TOOLCHAINS mismatch | lint PASS in quick (22:57); the Render row is N0's | B1 (done); N0 |
| 5 | G3 never run (its private family is absent on this Mac); `cipher-text` never built (the starter and cipher-meta exist) | open | M1c (I-1c-0, N2-2) |
| 6 | The app has never been on his phone | the lead's install is running (23:25) | M1a |
| 7 | Build cost and reboots (871 s for one `quick --wp N7` at load ≈ 990; mirrors wiped) | open | ΔQ-14; Q and I build MLX, other packages build with `RecordedRuntime` |
| 8 | **`DemoLoadTask` leaves the human layer, tracking and the pipeline runs pending** (read: `ScrollsService/Pipelines/AdapterLoad.swift:160–191`). The coach marks and the tour depend on them. | open | N2-1 (tracking, pipeline runs), N6-1 (Reader A/B reviews and revisions) at M1b |
| 9 | **The deferred rename matches TF-IDF words**: it finds the group whose `label_auto` holds ≥ 2 of *hold · mic · verse · block · counted* (read: `server/jobs/tasks/demo-load.mjs:161–166`; `annotations.jsonl:23`). Under the rewrite, `label_auto` holds log-odds words. | open | N6-1: **re-target the rename by anchors** (the group holding most of the planted hip-hop anchor passages), and test that rule plus the new distinctive words (`DemoRenameTests`) |
| 10 | **Tour step 5 names "representation: tfidf-hash-4096"** (`tour.json`, a byte-equal engine resource) | open | N8-0: a recorded divergence **DV-Q1** and phone copy "representation: Qwen3-Embedding-0.6B (8-bit), read on this iPhone" |
| 11 | **`cluster` is not retired**: the demo pipeline enqueues it (reference) | open | N0-Q1d: `TaskRegistry.mapped["cluster"] = "qgroups"` |

### 1.3 Differential testing after the cut

| Tier | After the rewrite |
|---|---|
| C0 contracts | **keep** (260/260) |
| G1 pure | **keep**: every family, including the stats primitives (Garwood, Wilson, G², BH-FDR, logDice, Gries DP), variants, translit, winnow, minhash |
| G2 pipeline | **keep**: mini, ingest, demo, the Cipher slice (**the slice runs where the private family is present; its SKIP on this Mac is recorded, never PASS**), boilerplate; the STEMM slice at M3 |
| G3 read path | **keep**: search, expressions, timeline, tiles L0–L5, marks, passages, documents, KWIC, shelves, coverage, seams (m1r at M1c, m5r at M3) |
| G3 Compare | **keep exact**: multiplicity, coverage, composition, modality, prominence, frequency + CIs, seeded passages, collocates, keyness, gates, widening suggestions. **Masked**: `clusters`, `measures` (sense_share_jsd, neighbor_overlap, aligned_displacement) and `tone`, which the reference computes with methods that no longer exist. |
| G4 analysis | **cut entirely** |
| G5 display list | **keep** (passing) |
| G6 device = Mac | **keep for evidence and user tables**; analysis tables are excluded (Qwen outputs come back from the journal, not from recomputation) |
| G7 journey | **keep**, writes included; Compare responses inside the RF-3 journey mask `clusters`, `measures` and `tone` |
| G8 render parity | **keep** (passing) |
| **Q (new)** | Q1 runtime parity · Q2 determinism · Q3 truth · Q4 honesty · Q5 lifecycle · Q6 evaluation (§6.2) |

---

## 2. Architecture: `ScrollsQwen` and `ScrollsQwenKit`

### 2.1 Targets, the dependency rule, and alignment with the bring-up

```
ScrollsKit (SwiftPM; swift test-able; no third-party code)
  ScrollsCore/QwenVocab.swift ................................................ [N0]
  ScrollsStore/Qwen/{VectorCodec,RepresentationKey,QwenSQL}.swift,
    Resources/qwen-profile.sql, Atlas/Memory.swift (+ reserveModel) .......... [N0]
  ScrollsContracts/Qwen/** (Q1 value types) · ScrollsService/AtlasQwen.swift .. [N0]
  ScrollsQwen (pure; depends on Core, Contracts, Store, Jobs, Query) ......... [Q]
     Models/   ModelCatalog · ModelVerify
     Policy/   QwenBudgets · ModelAdmission · ResidencyPolicy · QwenPriority · YieldPolicy ·
               InteractionSignal · QwenThermalPolicy · GateThresholds · PrefillPlan · BatchPlan
     Read/     SamplePlanner · ContextWindow · EmbeddingTemplate · ReadContextsTask (qvec)
     Generate/ PromptLibrary · Schemas · PassageSet · StratifiedRetrieval · QuestionRouter ·
               Verifier · NumberGuard · ForbiddenWording · RefusalCopy · Tasks/{Label,Ask,Explain,Reuse,Draft,Tone,Stance,Allusion}
     Runtime/  protocol QwenRuntime · RecordedRuntime · RuntimeInfo · QwenProbeReport
     Resources/prompts/<task>@<n>.txt · schemas/<task>@<n>.json
  ScrollsAnalysis/{Groups,Assign,Concentration,Shift,Edges}/** + Tasks/Q*Task.swift  [N4]  (reads q_vector through QwenSQL)
  ScrollsService/LiveQwen{,+Models,+Read,+Label,+Explain,+Ask}.swift ......... [Q]   (runtime injected; no MLX import)

Native/ScrollsQwenKit (local package; built only by xcodebuild; MLX lives here) [Q; created by the bring-up]
  ScrollsQwenRuntime: MLXQwenRuntime · ModelManager (actor) · Embedder · Generator · GuidedRun ·
                      TransformersTokenizerLoader · QwenProbe
  scrolls-qwen (macOS executable): eval · vectors · demo-runs · bench ........ [Q; M2]

Scrolls (app): Scrolls/Qwen/{QwenHost,QwenProbeView,ModelSettingsView,QwenStatusModel,MachineReadingCard,
                MachineBadge,QwenCopy}.swift [Q] — QwenHost injects MLXQwenRuntime on the device,
                RecordedRuntime in the simulator and UI tests (-qwen recorded), nothing with -qwen off.
```

- **Why the split.** Every decision lives in `ScrollsQwen`, so `check.sh quick` tests it without MLX: sampling, windows, prompts, schemas, retrieval, verification, admission, residency and refusals. `ScrollsQwenKit` only moves tensors.
- **Chaining without an import cycle.** `qvec` (Q) → `qgroups` (N4) → `qlabel` (Q) are chained by job type through `JobQueue` `after:` dependencies. They share only `ScrollsStore/Qwen`.
- **Lint (N0, `LintTests`):**
  - `import MLX…` and `import Tokenizers` only under `Native/ScrollsQwenKit/` and `Scrolls/Qwen/`;
  - `HubClient`, `Downloader`, `#huggingFace…`, `URLSession` banned in both;
  - the tokens `closingBias:` and `kvBits:` banned in `ScrollsQwenKit`;
  - `GuidedGenerationLoop.run(` allowed only in `GuidedRun.swift`.
- **Alignment with the bring-up (M1a).** The bring-up creates `ScrollsQwenKit`, a pure `ScrollsQwen` target and the "Qwen on this iPhone" screen. The signatures below are the M1b target.
  - Where the bring-up has landed a different name or shape, **its code stands for M1a**.
  - Q adapts it to §2 in one task (M1b Q-0) and records each difference in `status/Q.md`.
  - A difference that changes behaviour (not just a name) goes to the lead.
  - The differences already known at 23:40 (names, the model folder, the thermal unload level, the probe's file names, the forced-k probe) are listed with their resolution in §7.3, "Alignment with the bring-up".

### 2.2 The pure layer (`ScrollsQwen`; `QwenVocab` in Core)

```swift
// ScrollsCore/QwenVocab.swift [N0]
public enum QwenVocab {
  public static let stages = ["qvec","qgroups","qassign","qshift","qedges","qlabel","qexplain","qask",
                              "qreuse","qdraft","qtone","qstance","qallusion"]
  public static let gates  = ["not_read","titles_only","language_not_evaluated","representation_mismatch",
                              "language_mismatch","model_absent","thin_evidence"]   // plus SPEC's no_cluster_structure etc.
  public static let gateDetails = ["no_stable_k","below_margin","below_floor"]       // inside no_cluster_structure
}

// ScrollsQwen/Models/ModelCatalog.swift [Q]
public enum ModelRole: String, Codable, Sendable, CaseIterable { case embedder, generator }
public struct ModelSpec: Codable, Sendable, Equatable {
  public var name: String           // "Qwen3-Embedding-0.6B-8bit"
  public var role: ModelRole
  public var sha256: String         // the model id sha (MODELS.json "model_sha256"); per-file sha256s in the pushed MANIFEST.json
  public var bytes: Int
  public var folder: String         // "<name>@<sha8>" under Library/Application Support/Models/
}
public enum ModelCatalog {
  public static let embedder: ModelSpec    // fe956e8d…, 649,088,604 B
  public static let generator: ModelSpec   // 2a73c6c2…, 2,263,022,417 B
  public static var all: [ModelSpec] { get }
}
public enum ModelVerify {
  /// Streams every file of the folder through CryptoKit SHA256 in 1 MiB reads against the pushed MANIFEST.json; never loads a model.
  public static func verify(folder: URL, spec: ModelSpec, progress: @Sendable (Double) -> Void) throws -> Bool
}

// ScrollsStore/Qwen/RepresentationKey.swift [N0]
public enum WindowRule: Codable, Sendable, Hashable { case words(Int), qwenTokens(Int), passage }
public struct RepresentationKey: Codable, Sendable, Hashable, CustomStringConvertible {
  public var model: String        // "qe06-q8"
  public var sha8: String         // "fe956e8d"
  public var template: String     // "occ-instr@1" | "doc@1"
  public var window: WindowRule   // .words(24)
  public var dims: Int            // 256
  public var description: String { get }   // "qe06-q8@fe956e8d/occ-instr@1/w24w/d256"
  public init?(_ string: String)
}

// ScrollsQwen/Read/ContextWindow.swift [Q]
public struct ContextWindow: Sendable, Equatable {
  public var passage: PassageID
  public var target: Range<Int32>          // UTF-16 offsets of the match (D4)
  public var left: String, mid: String, right: String   // whitespace collapsed
  public var contentTokens: Int            // engine tokens minus stop-words; < 8 = thin
  public static func make(passageText: String, passageStart: Int32, target: Range<Int32>,
                          rule: WindowRule) -> ContextWindow
}
public enum EmbeddingTemplate: String, Codable, Sendable {
  case occInstr1 = "occ-instr@1"   // "Instruct: Represent the meaning of the <word|expression> '<w>' in this passage\nQuery: <left><mid><right>"
  case doc1      = "doc@1"         // "<left><mid><right>" (document side of retrieval)
  case query1    = "query@1"       // "Instruct: Given a question, retrieve passages that answer the question\nQuery: <q>"
  public func render(_ w: ContextWindow, expression: String) -> String
  public static func renderQuery(_ question: String) -> String
}

// ScrollsQwen/Read/SamplePlanner.swift [Q]
public struct CellKey: Codable, Sendable, Hashable { public var decade: Int?; public var collection: Int64 }
public struct EligibleOccurrence: Sendable, Equatable {
  public var id: OccurrenceID; public var document: DocumentID; public var cell: CellKey; public var english: Bool
}
public struct SamplePlan: Codable, Sendable, Equatable {
  public enum Kind: String, Codable, Sendable { case firstLook, readAll, single }
  public var kind: Kind
  public var cap: Int                          // 600 · 5,000 per scope · 1
  public var perDocumentFitCap: Int            // 3: the fitted population, always
  public var seed: UInt32                      // mulberry32 seed = 42 ^ fnv1a32(expression key)
  public var cells: [CellKey: CellCount]       // N_cell (eligible) and n_cell (read)
}
public struct CellCount: Codable, Sendable, Equatable { public var eligible: Int; public var read: Int }
public enum SamplePlanner {
  /// ≤ cap, ∝ √N_cell, ≥ 1 per non-empty cell, ≤ 3 per document, seeded.
  public static func firstLook(_ e: [EligibleOccurrence], expressionKey: String, cap: Int = 600) -> (SamplePlan, [OccurrenceID])
  /// The rest, cell by cell in seeded order, ≤ capPerScope, skipping what is already read (resumable).
  public static func readAll(_ e: [EligibleOccurrence], alreadyRead: Set<OccurrenceID>, expressionKey: String,
                             capPerScope: Int = 5_000) -> (SamplePlan, [OccurrenceID])
  /// The capped fit population of a groups run: ≤ 3 per document, seeded, drawn from everything read.
  public static func fitPopulation(_ read: [EligibleOccurrence], expressionKey: String) -> [OccurrenceID]
  public static func designWeights(_ p: SamplePlan) -> [CellKey: Double]    // N_cell / n_cell
}

// ScrollsQwen/Policy/{BatchPlan,PrefillPlan}.swift [Q]
public struct BatchPlan: Codable, Sendable, Hashable {
  public var batchSize: Int                    // 8; 4 while the Scroll is visible
  public var sortByTokenLength: Bool           // true: stable order (length, input index)
  public var maxTokens: Int                    // 128 per window, instruction included
  public static let standard: BatchPlan        // b8, sorted, right padding
  public static let interactive: BatchPlan     // b4
  public var key: String { get }               // "b8/len/right/128": recorded on every qvec run
}
public enum PrefillPlan {
  /// 256 up to 1,024 prompt tokens, 128 above (lab §2.3). There is no default anywhere downstream.
  public static func step(promptTokens: Int) -> Int
  public static let promptCap = 1_024          // M1–M2; 2,048 only behind the S3 switch (§2.5)
}

// ScrollsQwen/Policy/{QwenBudgets,ModelAdmission}.swift [Q]
public struct ModelBudget: Codable, Sendable, Equatable {
  public var loadBytes: Int        // the resident delta after a load
  public var growthBytes: Int      // peak − resident delta for the planned work shape
  public var source: String        // "lab §2.2: Mac MLX 8 × 128" | "device qwen-probe 2026-…"
}
public struct QwenBudgets: Codable, Sendable, Equatable {
  public var embedder: ModelBudget
  public var generator: ModelBudget
  public var modelHeadroom: Int
  public static let provisional: QwenBudgets          // the values of §2.5
  public static func current(probe: QwenProbeReport?) -> QwenBudgets   // device values once M1a has run
}
public enum ModelAdmission {
  public enum Decision: Sendable, Equatable { case admit, refuse(needed: Int, available: Int) }
  /// Before a load: available − reservedByOthers ≥ load + growth + headroom.
  public static func canLoad(_ b: ModelBudget, available: Int, reservedByOthers: Int, headroom: Int) -> Decision
  /// After the load the weights already show in os_proc_available_memory(); hold only the growth,
  /// re-taken as max(b.growthBytes, measuredPeak − measuredResidentDelta).
  public static func heldAfterLoad(_ b: ModelBudget, measuredResidentDelta: Int, measuredPeak: Int?) -> Int
}

// ScrollsQwen/Policy/{Residency,Schedule,InteractionSignal}.swift [Q]
public enum UnloadReason: String, Codable, Sendable {
  case background, memoryWarning, memoryPressureCritical, thermalCritical, idle, roleSwitch, user
}
public struct ResidencyPolicy: Sendable, Equatable {
  public var idleEmbedder: Duration    // 30 s
  public var idleGenerator: Duration   // 90 s
  public static let standard: ResidencyPolicy
}
public enum QwenPriority: Int, Codable, Sendable, Comparable {
  case waiting = 0      // generation he is waiting for (Ask, a tapped explanation, a label he asked for)
  case reading = 1      // Read this occurrence; the first look of a strand he just opened
  case labels = 2       // labels for groups on screen (only when *Label groups automatically* is on)
  case readAll = 3      // Read all of a strand he opted in
}
public final class InteractionSignal: Sendable {
  public init()
  public func set(interacting: Bool, scrollVisible: Bool)              // from ScrollModel (N7) via QwenHost
  public var interacting: Bool { get }
  public var scrollVisible: Bool { get }
  /// Blocks the calling thread (never the main thread) while interacting, polling every 16 ms, for at most `limit`.
  public func waitWhileInteracting(limit: Duration)
}
public enum YieldPolicy {
  /// The batch plan to use now, or nil to wait: no new embedding batch starts while interacting; batch 4 while the Scroll is visible.
  public static func nextBatch(interacting: Bool, scrollVisible: Bool, thermal: ThermalLevel, lowPower: Bool,
                               priority: QwenPriority) -> BatchPlan?
}
public enum ThermalLevel: Int, Codable, Sendable { case nominal, fair, serious, critical }

// ScrollsQwen/Policy/GateThresholds.swift [Q]
public struct GateThresholds: Codable, Sendable, Equatable {
  public var minStability: Double      // 0.8
  public var minMargin: Double         // 0.03 (silhouette − reference)
  public var floor: Double             // 0.10
  public var provenance: String        // "rule_v2: 13 real-word runs read by one agent (QWEN-LAB §1.5); not calibrated on pseudo-words"
  public var provisional: Bool         // true until LQ-1/LQ-2 pass
  public static func forKey(_ k: RepresentationKey) -> GateThresholds?   // nil → gated `representation_mismatch`
}
```

### 2.3 The runtime: protocol (pure) and MLX implementation (`ScrollsQwenKit`)

```swift
// ScrollsQwen/Runtime/QwenRuntime.swift [Q]
public enum QTask: String, Codable, Sendable { case label, explain, ask, reuse, draft, tone, stance, allusion }
public enum BuiltOn: String, Codable, Sendable { case device, mac, recorded }
public struct RuntimeInfo: Codable, Sendable, Equatable {
  public var runtime: String     // "mlx-swift 0.32.3 · mlx-swift-lm 3.32.3 · xgrammar <vendored rev>" | "recorded"
  public var device: String      // hw.machine, e.g. "iPhone16,2"
  public var osBuild: String     // "iOS 27.2 (24C…)"
  public var builtOn: BuiltOn
}
public struct GenerateRequest: Codable, Sendable, Equatable {
  public var task: QTask
  public var promptID: String          // "label@1"
  public var system: String, user: String
  public var schema: String            // JSON Schema text → GrammarConstraint
  public var maxTokens: Int            // Schemas.outputCap(task): ≥ 2 × the measured maximum (§2.4)
  public var prefillStep: Int          // PrefillPlan.step(promptTokens:) — required; no default anywhere
  public var wallLimit: Duration       // 90 s
}
public struct GenerateResult: Codable, Sendable, Equatable {
  public enum Stop: String, Codable, Sendable { case accepted, incompleteOutput, prematureEOS, cancelled, wallLimit }
  public var raw: String
  public var stop: Stop
  public var tokensIn: Int, tokensOut: Int
  public var prefillMs: Int, decodeMs: Int, grammarCompileMs: Int
  public var peakFootprint: Int?
}
public enum GenerateProgress: Sendable { case loading, prefill(done: Int, total: Int), tokens(Int) }
public enum ModelEvent: Sendable, Equatable {
  case loading(ModelRole), resident(ModelRole, residentDelta: Int), unloaded(ModelRole, UnloadReason, footprintAfter: Int),
       paused(ThermalLevel), refused(ModelRole, needed: Int, available: Int), rate(windowsPerSecond: Double)
}
public protocol QwenRuntime: Sendable {
  var info: RuntimeInfo { get async }
  var events: AsyncStream<ModelEvent> { get }
  func installed() async -> [ModelStatus]
  func countTokens(_ texts: [String], role: ModelRole) async throws -> [Int]
  /// Unit vectors cut to `dims` and re-normalised, f16, in input order.
  func embed(_ texts: [String], plan: BatchPlan, dims: Int, priority: QwenPriority,
             progress: @escaping @Sendable (_ done: Int, _ total: Int) -> Void) async throws -> [[Float16]]
  func generate(_ r: GenerateRequest, priority: QwenPriority,
                progress: @escaping @Sendable (GenerateProgress) -> Void) async throws -> GenerateResult
  func unload(_ reason: UnloadReason) async
}
/// Answers from Resources/qwen-fixtures/*.json, keyed by (rep key, input sha256) or (task, prompt sha256, inputs sha256).
/// Every card it produces says "recorded". Selected by -qwen recorded (default in the simulator and UI tests).
public struct RecordedRuntime: QwenRuntime { public init(fixtures: URL) }
```

```swift
// Native/ScrollsQwenKit/Sources/ScrollsQwenRuntime/ [Q; created by the bring-up]
public final class MLXQwenRuntime: QwenRuntime {
  public init(modelsRoot: URL, budgets: QwenBudgets, residency: ResidencyPolicy,
              interaction: InteractionSignal, conditions: any DeviceConditionsSource)
}
public actor ModelManager {
  public enum State: Sendable, Equatable {
    case none, loading(ModelRole), resident(ModelRole, residentDelta: Int),
         paused(ThermalLevel), refused(needed: Int, available: Int)
  }
  public init(modelsRoot: URL, budgets: QwenBudgets, residency: ResidencyPolicy, interaction: InteractionSignal)
  public private(set) var state: State
  public nonisolated let events: AsyncStream<ModelEvent>
  /// Loads the role (unloading the other one first), runs `body`, restarts the idle timer.
  public func withEmbedder<R: Sendable>(priority: QwenPriority, _ body: @Sendable (Embedder) async throws -> R) async throws -> R
  public func withGenerator<R: Sendable>(priority: QwenPriority, _ body: @Sendable (Generator) async throws -> R) async throws -> R
  public func unloadNow(_ reason: UnloadReason) async
}
public final class Embedder: @unchecked Sendable {        // confined to ModelManager.withEmbedder
  public func tokenCounts(_ texts: [String]) -> [Int]
  public func embed(_ texts: [String], plan: BatchPlan, dims: Int,
                    shouldContinue: () -> Bool, progress: (Int) -> Void) throws -> [[Float16]]
}
public final class Generator: @unchecked Sendable {       // confined to ModelManager.withGenerator
  public func tokenCount(system: String, user: String) throws -> Int
  public func prewarm(schemas: [String]) throws            // compiles each GrammarConstraint once, off the main actor
  public func run(_ r: GenerateRequest, interaction: InteractionSignal,
                  progress: (GenerateProgress) -> Bool) throws -> GenerateResult
}
enum GuidedRun {   // the only caller of GuidedGenerationLoop.run (lint)
  static func run(input: LMInput, context: ModelContext, constraint: GrammarConstraint,
                  maxTokens: Int, vocabSize: Int, prefillStep: Int,
                  interaction: InteractionSignal, emit: (String) -> Bool) throws -> Int
}
public struct TransformersTokenizerLoader: TokenizerLoader {   // MLXLMCommon.TokenizerLoader over swift-transformers AutoTokenizer.from(modelFolder:)
  public init()
  public func load(from directory: URL) async throws -> any MLXLMCommon.Tokenizer
}
public enum QwenProbe {    // the "Qwen on this iPhone" screen's engine; writes Documents/Diagnostics/qwen-probe.json
  public static func run(_ runtime: MLXQwenRuntime, fixtures: URL, out: URL,
                         progress: @Sendable (String) -> Void) async -> QwenProbeReport
}
```

**Implementation rules (each one has a test or a device row):**
- **Loading.** `EmbedderModelFactory.shared.load(from:using: TransformersTokenizerLoader())` and `LLMModelFactory.shared.loadContainer(from:using:)`. No downloader exists. `Memory.cacheLimit` is 16 MB while the embedder is resident and 64 MB while the 4B is (est.; M1a measures). After an unload: drop references, then `Memory.clearCache()` (the AttentionMachine pattern).
- **Embedding.** Tokenise; append `<|endoftext|>`; cut the window symmetrically so the whole input is ≤ 128 tokens; sort by length; pad **on the right**. The mask is 1 for real tokens including the final `<|endoftext|>` and 0 for padding. Pool with `Pooling(strategy: .last)` and `normalize: true, applyLayerNorm: false`; cut to 256 dims and re-normalise; f16. Check `shouldContinue()` between batches.
- **Generation.** The Qwen3-2507 non-thinking chat template; `GrammarConstraint(tokenizer:jsonSchema:)` compiled from the task's schema and pre-warmed at load. `GuidedRun.run` calls `GuidedGenerationLoop.run(input:context:constraint:maxTokens:vocabSize:prefill:emit:)` with `prefill: PrefillParameters(stepSize: prefillStep, chunking: .balanced, progress: { _, _ in interaction.waitWhileInteracting(limit: .seconds(10)) })`. **It never passes `closingBias`, `kvBits` or `hardReserve`.**
  - The progress callback runs after each chunk is submitted, so blocking in it means **no new prefill chunk starts during interaction**. S8 verifies this on the device.
  - `emit` returns `false` on cancellation or at the wall limit. `GuidedGenerationError.incompleteOutput` becomes `stop = .incompleteOutput`, recorded as a failed run: "stopped at the output cap; nothing shown".
- **Cancellation** is acknowledged within 500 ms: between embedding batches, per token, and between prefill chunks (S7).

### 2.4 Prompts, schemas and caps

- **Prompts are data.** Each prompt is `ScrollsQwen/Resources/prompts/<task>@<n>.txt`, its sha256 recorded on the run. A change is a new version, never an edit.
  - Passages are listed `[P1]`…`[Pn]` with a **period slot** (`{A}`, `{B}`, … in date order, `{U}` undated), the source name, the field when it is not the body, and the title. The prompt states no date of its own.
  - Demo passages are introduced as "from a synthetic demonstration corpus (an invented town and invented people)" (lab §4.3).
- **`label@1`** is the lab's measured V1 prompt (QWEN-LAB §4.3) with two changes: the key `description` becomes `gloss`, and a `cites` field is added. Because it differs from what was measured, its quality is **re-measured through the Swift guided path** (EVAL.md) before auto-labelling can default on.
- **`ask@1`** is the lab's `slots2` prompt (rules version 2, QWEN-LAB §4.4), with ±32-word windows.
- **Schemas** (free text banned from holding digits: `\p{Nd}`; if XGrammar rejects `\p{Nd}` at S5, the generated equivalent class `ScrollsQwen/Generate/DigitClass.swift` — every Unicode `Nd` range — replaces it):

  ```json
  label@1: {"type":"object","additionalProperties":false,"required":["label","gloss","cites"],"properties":{
    "label":{"type":"string","maxLength":40,"pattern":"^[^\\p{Nd}\\s]+( [^\\p{Nd}\\s]+){0,4}$"},
    "gloss":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[^\\p{Nd}]*$"},
    "cites":{"type":"array","minItems":2,"maxItems":4,"uniqueItems":true,"items":{"enum":["P1","P2","P3","P4","P5"]}}}}

  ask@1: {"type":"object","additionalProperties":false,"required":["answerable","claims","reason"],"properties":{
    "answerable":{"type":"boolean"},
    "claims":{"type":"array","maxItems":4,"items":{"type":"object","additionalProperties":false,
      "required":["text","cites","quote","quote_from"],"properties":{
        "text":{"type":"string","maxLength":220,"pattern":"^[^\\p{Nd}]*$"},
        "cites":{"type":"array","minItems":1,"maxItems":3,"uniqueItems":true,"items":{"enum":["P1","P2","P3","P4","P5","P6"]}},
        "quote":{"type":"string","maxLength":160},
        "quote_from":{"enum":["P1","P2","P3","P4","P5","P6"]}}}},
    "reason":{"type":"string","maxLength":200,"pattern":"^[^\\p{Nd}]*$"}}}
  ```
  - The `enum` of ids is generated per call from the passages actually given.
  - Quotes are exempt from the digit pattern: they are matched verbatim against the atlas and rendered from it.
  - There is **no `kind` field** anywhere.
- **Caps.** Every output cap is **≥ 2 × the measured maximum** where one was measured, and otherwise ≥ the schema's bounded maximum. Every task also has a 90 s wall limit.

  | Task | Passages in | Window | Prompt cap | Output cap | Measured basis | Started |
  |---|---|---|---|---|---|---|
  | `qlabel` | 5 per group: the 3 members nearest the centroid + 2 seeded random members, ≤ 1 per document (§3.6); this group's distinctive words | ±25 words | 1,024 | **160** | V2: 483–577 in, 49–77 out (lab §3.3) | tap; automatically only once *Label groups automatically* is on |
  | `qask` | 6, ≤ 2 per document, stratified (§3.11) | ±32 words | 1,024 | **480** | 658–1,054 in at ±40 words, 16–229 out (lab §3.5) | Ask (M2) |
  | `qexplain` | 6 (3 per slice), stratified by group and period | ±32 words | 1,024 | 320 (gate: measured at M2) | none | tap (M2) |
  | `qreuse` | the Then and Now passages + the alignment facts | ±40 words | 1,024 | 192 (gate) | none | tap (M3) |
  | `qdraft` | ≤ 6 later uses in the group + the share trend | ±32 words | 1,024 | 160 (gate) | none | tap (M3) |
  | `qtone` / `qstance` | 8 paragraphs per call | ±32 words | 768 | 48 (gate) | none | M3, behind LAB-13 / LAB-11 |
  | `qallusion` | 2 passages | ±40 words | 768 | 96 (gate) | none | on request (M3) |

- **Timing (est., lab §2.7; replaced by live rates):**
  - one label ≈ 7–18 s per group, plus 3–8 s to load the 4B;
  - Ask ≈ 20–50 s;
  - 4B prefill 60–120 tok/s, decode 9–15 tok/s.

### 2.5 Memory budgets and admission

**Provisional budgets** (Mac MLX peaks, lab §2.2–§2.6). M1a's probe replaces each with the phone's `phys_footprint` value, and `QWEN.md` records the change.

| Model | Load (resident delta) | Growth reserved after load | Basis | Reservation before the load |
|---|---|---|---|---|
| Embedder, 8-bit, batch 8, ≤ 128 tokens per window | 633 MB | **887 MB** | 8 × 128 peaked at 1.520 GB; R1 windows (42–88 tokens) lie between 8 × 64 (1.249 GB) and 8 × 128. The critique's ≈ 1.3 GB is the expected R1 value (est.); admission uses the measured upper bound until M1a measures R1 at batch 8. | 1.52 GB + headroom |
| 4B, prompts ≤ 1,024 tokens, step 256 | 2,265 MB | **700 MB** | 2.938 GB at 1k/256 (growth 673 MB); 512 tokens 589 MB | 2.97 GB + headroom |
| 4B, prompts 1,025–2,048, step 128 | 2,265 MB | 700 MB | 2.964 GB at 2k/128 | **not used before M2**; only if S3 shows available memory ≥ load + growth + headroom + 400 MB |

- **Model headroom:** provisional 600 MB, set from M1a (never below 300 MB). The 600 MB engine headroom of IOS-SPEC §3.8 is unchanged for engine jobs.
- **The admission rule, without the double count** (critique P0-2):
  1. **Before a load:** `ModelAdmission.canLoad`: `os_proc_available_memory() − reservedByOthers ≥ load + growth + modelHeadroom`. Otherwise the model is refused with copy (§5.1).
  2. **During the load,** the reservation is `load + growth`.
  3. **After the load,** `ModelReservation.settle` keeps only `growth` (re-taken as max(budget, measured peak − measured resident delta)). The weights already show as lower `os_proc_available_memory()`, so holding them again would block every engine job.
  4. **Engine jobs** keep `MemoryBudget.reserve(bytes:headroom: 600 MB)` against the same ledger. With the 4B resident, a 256 MB engine job needs ≈ 0.7 + 0.256 + 0.6 ≈ 1.56 GB available (est.), not the 3.86 GB the old rule required.
- **In `phys_footprint` terms.** Every threshold is re-set from S3 and S4, measured with Scrolls' engine open (interactive budget ≤ 400 MB, SQLite caches, the Metal renderer). The critique's estimate for the whole app while the 4B labels a 600-token group is **3.2–3.5 GB** (est.).
- **Store change (N0, additive):**

  ```swift
  // ScrollsStore/Atlas/Memory.swift
  extension MemoryBudget {
    /// A model load: admits when available − reserved ≥ loadBytes + growthBytes + headroom; holds both until `settle`.
    public static func reserveModel(loadBytes: Int, growthBytes: Int, headroom: Int) throws -> ModelReservation
  }
  public final class ModelReservation: Sendable {
    public var heldBytes: Int { get }
    public func settle(growthBytes: Int)     // after the load: hold only the remaining growth
    public func release()
  }
  ```

- **Co-residency** ("keep both models loaded") is **not offered**. Both resident measured 3.6–3.8 GB on the Mac (lab §2.6). It returns only through §8's decision and a device measurement.

### 2.6 Scheduling, GPU yield, heat and background

- **The queue** (`QwenPriority`, §2.2). A higher priority preempts at the next batch, chunk or token boundary. All Qwen work runs through `JobQueue` as read-mostly jobs (`writes: false`, a guarded short commit), so the reserved interactive reader is never touched.
- **GPU submissions are long on the phone** (est., lab §2.7):
  - one embedding batch is 0.4–0.8 s at batch 8;
  - one prefill step is 2–4 s at 256 tokens (60–120 tok/s) and 1–2 s at 128;
  - only a decode step is short (≈ 70–110 ms).
- **Yield rules** (critique P1-16):
  - while the Scroll is **visible**, embed at **batch 4**;
  - while it is **interacting** (pan, pinch, momentum, Play), **no new embedding batch and no new prefill chunk starts** (`YieldPolicy`, `InteractionSignal.waitWhileInteracting`); decode steps continue;
  - S8 measures frame hitches during a pan with embedding running **and** with a prefill chunk in flight.
- **Thermal and power** (`DeviceConditionsSource`, bridged from LabKit as today):

  | Condition | Embedding | Generation |
  |---|---|---|
  | nominal | continuous | allowed |
  | fair | 20% rest after each batch | allowed |
  | serious | only `waiting` and `reading`, 2 s rest between batches | only `waiting`; copy "the phone is warm; Qwen is slower" |
  | critical | stops | stops; models unload; "paused — the phone is hot" |
  | Low Power Mode | no automatic Qwen work | explicit requests only |

- **Background.** Qwen work never starts or continues in the background. On `.background`, every Qwen job stops at its next boundary and the models unload inside `Lifecycle`'s `beginBackgroundTask`, before `suspendJobs`. The queue resumes when the scene is active.
  - M1a probes `BGTaskScheduler.supportedResources`. Only if `.gpu` is present may *Read all* continue under `BGContinuedProcessingTask` (M3, his opt-in).
- **Unload triggers:** background; `didReceiveMemoryWarning`; a `.critical` memory-pressure `DispatchSource` event; thermal `.critical`; idle (30 s embedder, 90 s 4B); **Unload now**; a role switch. After an unload the footprint must return to ≤ the pre-load baseline + 300 MB (Q5).

### 2.7 Storage: `qwen-profile.sql` (N0; create-only; applied after `device-profile.sql`; `meta.profile_qwen = 'qwen-1'`)

```sql
CREATE TABLE q_model (sha256 TEXT PRIMARY KEY, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('embedder','generator')),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),     -- files, sizes, sha256s, licence, upstream revision
  installed_at TEXT NOT NULL) STRICT;
CREATE TABLE q_representation (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE,  -- 'qe06-q8@fe956e8d/occ-instr@1/w24w/d256'
  model_sha256 TEXT NOT NULL, template_sha256 TEXT NOT NULL, window TEXT NOT NULL,
  dim INTEGER NOT NULL CHECK (dim IN (128,256,512,1024)), created_at TEXT NOT NULL) STRICT;
CREATE TABLE q_vector (rep_id INTEGER NOT NULL REFERENCES q_representation(id),
  passage_id INTEGER NOT NULL, start_off INTEGER NOT NULL, end_off INTEGER NOT NULL, -- target span (D4); (0,0) = passage window
  input_sha256 BLOB NOT NULL, vec BLOB NOT NULL,                     -- f16 unit vector, uncentred
  run_id INTEGER NOT NULL REFERENCES analysis_run(id),               -- the qvec run (device, runtime, batch plan)
  PRIMARY KEY (rep_id, passage_id, start_off, end_off)) STRICT, WITHOUT ROWID;
CREATE TABLE q_fit_member (run_id INTEGER NOT NULL REFERENCES analysis_run(id),     -- the qgroups run
  occurrence_id INTEGER NOT NULL REFERENCES occurrence(id), document_id INTEGER NOT NULL,
  PRIMARY KEY (run_id, occurrence_id)) STRICT, WITHOUT ROWID;         -- the capped fit population (≤ 3 per document)
CREATE TABLE q_group (cluster_id INTEGER PRIMARY KEY REFERENCES sense_cluster(id),
  centroid BLOB NOT NULL,                                            -- f16, in the centred space of its run
  flags_json TEXT NOT NULL CHECK (json_valid(flags_json)),           -- [{kind, key, group_share, strand_share, enrichment, n}]
  card_json TEXT NOT NULL CHECK (json_valid(card_json))) STRICT;     -- engine-chosen nearest + random member ids, seed
CREATE TABLE q_assignment (run_id INTEGER NOT NULL REFERENCES analysis_run(id),     -- a qassign run
  groups_run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  occurrence_id INTEGER NOT NULL REFERENCES occurrence(id),
  cluster_id INTEGER NOT NULL REFERENCES sense_cluster(id), cos REAL NOT NULL, margin REAL NOT NULL,
  PRIMARY KEY (groups_run_id, occurrence_id)) STRICT, WITHOUT ROWID;
CREATE TABLE q_output (run_id INTEGER PRIMARY KEY REFERENCES analysis_run(id),
  task TEXT NOT NULL CHECK (task IN ('label','explain','answer','reuse','hypothesis','tone','stance','allusion')),
  prompt_id TEXT NOT NULL, prompt_sha256 TEXT NOT NULL, grammar_sha256 TEXT NOT NULL,
  runtime_json TEXT NOT NULL CHECK (json_valid(runtime_json)),       -- device, iOS build, mlx versions, xgrammar, prefill step, caps, built_on
  inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),         -- [{pid, passage_id, start, end, text_sha256, slot}]
  selection_json TEXT NOT NULL CHECK (json_valid(selection_json)),   -- method, candidates, index lines dropped, groups and periods filled
  raw TEXT NOT NULL,                                                 -- the model's bytes, unedited
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),         -- per claim: tied | dropped(reason)
  verdict TEXT NOT NULL CHECK (verdict IN ('shown','partly_withheld','refused','failed')),
  stop TEXT NOT NULL CHECK (stop IN ('accepted','incomplete_output','premature_eos','cancelled','wall_limit','not_generated')),
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
        'language_mismatch','language_not_evaluated','representation_mismatch','not_read','not_run')),
  gate_detail_json TEXT NOT NULL, caveats_json TEXT NOT NULL DEFAULT '[]',
  CHECK (gate = 'ok' OR (value IS NULL AND ci_lo IS NULL AND ci_hi IS NULL AND null_percentile IS NULL))) STRICT;
```

- **Reused §3 tables** (schema untouched; N-05 holds):
  - `analysis_run`;
  - `sense_cluster` (`label_auto` = the computed distinctive words), `cluster_member` (**the fitted members only**), `cluster_share`, `time_window`, `cluster_transition`;
  - `annotation`: Qwen labels as `machine_gloss`, tone as `machine_tone`, stance as `machine_tag`, drafts as `hypothesis` with `is_machine = 1`, each with `method` and `run_id`;
  - `relationship`: `similar_contextual_usage` (`computed`, origin `algorithm`) and `proposed_allusion` (origin `machine_tagger`, `proposed`). The existing CHECKs already make a documented status impossible for both.
- **RowIDPolicy:** `q_vector`, `q_fit_member`, `q_group`, `q_assignment`, `q_model` and `q_representation` are *keyed*; `q_output` and `q_shift` are *entity* (local range).
- **dump-spec** skips `q_vector` and masks `wall_ms` and `runtime_json`.
- **Cost:** 512 B per vector, so 5,000 vectors are 2.6 MB and 100k are 51 MB. The cache is purgeable from Storage ("rebuildable").
- A `q_vector` row whose stored `input_sha256` differs from the recomputed input is recomputed.

### 2.8 Runs, reproducibility and the journal

- **Every Qwen step is an `analysis_run`:**
  - `stage` from `QwenVocab`; `pipeline_version` `qgroups@1` etc.;
  - `model` the model name; `model_version` = the weights sha256 + `mlx-swift-lm 3.32.3`;
  - `representation` the key; `seed` 42.
  - **`params_json`** holds the prompt id and sha, the grammar sha, the caps, the **prefill step**, the **batch plan**, the sample plan, the scope, the gate thresholds and their provenance, **and `RuntimeInfo`** (device, iOS build, mlx-swift / mlx-swift-lm / XGrammar versions, `built_on`). So `params_hash`, and with it the `RunKey`, covers all of them.
  - `input_fingerprint` covers the passage ids and their text sha256s, in order.
- **Reproducibility claims** (critique P1-19):
  - **byte identity only within one batch plan** on one device: right padding changes tensor shapes and therefore the floating-point reductions;
  - across plans (batch 8 against 4) the bar is cos ≥ 0.999;
  - against the Python reference, cos ≥ 0.999 with the same plan.
- **Reuse rule.** An identical `RunKey` is reused, never regenerated. **Regenerate** makes a new run; the old one stays visible as an earlier layer.
- **The journal op** (N0 freezes it; appended **from M1**; N6 replays it **from M2**):

  ```swift
  case machineRun(MachineRunOp)
  public struct MachineRunOp: Codable, Sendable, Equatable {
    public var stage: String            // a QwenVocab stage
    public var run: RunKey
    public var params: JSONValue        // as analysis_run.params_json
    public var builtOn: BuiltOn
    public var payload: MachineRunPayload
  }
  public enum MachineRunPayload: Codable, Sendable, Equatable {
    case groups(LZFSEBlob)        // {anchor key → group ordinal} for the fit population, centroids (f16), gate, flags, card members
    case assignments(LZFSEBlob)   // {anchor key → (ordinal, cos, margin)}
    case generation(GenerationPayload)   // q_output.raw + checks + inputs as D18 anchors + selection
    case shift([JSONValue])       // q_shift rows
    case edges(LZFSEBlob)         // endpoint anchor pairs + scores
  }
  ```
  - `qvec` is never journaled: vectors are a cache, and their absence costs only time.
  - A groups op is ≈ 30–60 KB for 2,000 members (est.).
  - **At M1 the op is written but not replayed:** the atlas survives a force quit by itself (M1c exit). Replay lands at M2, where restores, generations and as-saved views first need it.

### 2.9 `AtlasQwen` (Q1; protocol by N0, `LiveQwen` by Q)

```swift
public protocol AtlasQwen: Sendable {
  // models and the probe (M1a)
  func models() async -> [ModelStatus]                         // installed · in Inbox · missing (with the push command) · verifying %
  func installModels() async throws -> [ModelStatus]
  func unloadModels() async
  func probe() async throws -> QwenProbeReport
  // reading, groups, labels (M1b)
  func readContexts(_ r: ReadContextsRequest) async throws -> JobID
  func readingStatus(_ expr: ExpressionID, scope: ScopeRef) async throws -> ReadingStatus
  func startGroups(_ r: GroupsRequest) async throws -> StartRunResponse      // qgroups (N4); results through AtlasService.clusters
  func groupCard(_ cluster: ClusterID, asOf: Cutoffs?) async throws -> GroupCard
  func label(groupsRun: RunID, groups: [ClusterID]?) async throws -> JobID   // gate-ok, non-residual groups only
  func machineReadings(_ target: TargetRef, asOf: Cutoffs?) async throws -> [MachineReading]
  // Compare and Ask (M2)
  func explain(_ r: CompareRequest) -> AsyncThrowingStream<QwenEvent, Error>
  func ask(_ r: AskRequest) -> AsyncThrowingStream<QwenEvent, Error>
  // M3
  func similarUses(_ occ: OccurrenceID) async throws -> Gated<[SimilarUse]>
  func readReuse(then: PassageID, now: PassageID) -> AsyncThrowingStream<QwenEvent, Error>
  func draftHypothesis(_ r: DraftRequest) -> AsyncThrowingStream<QwenEvent, Error>
  func tone(_ r: CompareRequest) async throws -> Gated<ToneDistribution>
  func allusion(_ a: PassageID, _ b: PassageID) -> AsyncThrowingStream<QwenEvent, Error>
}
public struct ReadContextsRequest: Codable, Sendable, Equatable {
  public enum Plan: Codable, Sendable, Equatable { case firstLook, readAll(capPerScope: Int), occurrences([OccurrenceID]) }
  public var expression: ExpressionID; public var scope: ScopeRef; public var plan: Plan
}
public struct ReadingStatus: Codable, Sendable, Equatable {
  public var read: Int, eligible: Int, titlesExcluded: Int, notEnglish: Int, thin: Int
  public var plan: SamplePlan.Kind
  public var representation: String
  public var windowsPerSecond: Double?   // measured on this phone in this session
  public var eta: Duration?              // from windowsPerSecond; nil before a rate exists
  public var thermal: ThermalLevel
}
public struct CardMember: Codable, Sendable, Equatable {
  public var occurrence: OccurrenceID; public var passage: PassageID; public var cos: Double; public var margin: Double
  public var chosenAs: Chosen; public var citedByLabel: Bool
  public enum Chosen: String, Codable, Sendable { case nearest, random }
}
public enum GroupFlag: Codable, Sendable, Equatable {
  case oneDocument(title: String, groupShare: Double, strandShare: Double)
  case oneCollection(name: String, groupShare: Double, strandShare: Double)
  case oneSubject(tag: String, groupShare: Double, strandShare: Double)
  case subjectNotChecked(untaggedShare: Double)
  case tentative(jaccard: Double), residual
}
public struct GroupCard: Codable, Sendable, Equatable {
  public var cluster: ClusterID; public var run: RunID; public var representation: String
  public var humanLabel: String?; public var machineLabel: MachineReading?; public var distinctiveWords: [String]
  public var n: Int, documents: Int, stability: Double, silhouette: Double, reference: Double, margin: Double
  public var thresholds: GateThresholds                       // shown with its provenance and "provisional"
  public var flags: [GroupFlag]
  public var members: [CardMember]                            // engine-chosen; what the label prompt saw
  public var read: ReadDisclosure
  public var earliest: EarliestRead                            // §3.5 "first observed" rule
}
public struct MachineReading: Codable, Sendable, Equatable {
  public var run: RunID; public var task: QTask; public var badge: ModelBadge   // name · sha8 · runtime · built_on
  public var claims: [TiedClaim]                     // never "verified": the quote matches; the reading is the model's
  public var withheld: [WithheldNote]
  public var read: ReadDisclosure
  public var verdict: Verdict                        // shown · partlyWithheld · refused
  public var synthetic: Bool
}
public struct TiedClaim: Codable, Sendable, Equatable {
  public var text: String                            // the model's sentence; never rendered as a quotation
  public var citations: [Citation]                   // rendered from the atlas
  public var quote: Citation?                        // the matched span, at exact offsets
  public var citedSentence: Citation                 // shown inline under the claim
  public var fromOnePassage: Bool
}
public struct Citation: Codable, Sendable, Equatable {
  public var passage: PassageID; public var range: Range<Int32>; public var dateChip: DateChip; public var synthetic: Bool
}
public enum SelectionMethod: String, Codable, Sendable { case byGroupAndPeriod, byPeriodAndSimilarity, firstLook, readAll }
public struct ReadDisclosure: Codable, Sendable, Equatable {
  public var passagesRead: Int; public var ofOccurrences: Int; public var method: SelectionMethod
  public var sentence: String     // e.g. "Read 6 passages of 4,309 occurrences: at least one from each context group, spread over decades."
  public var modernDefaultCaveat: Bool   // true for byPeriodAndSimilarity (§3.11)
}
public enum QwenEvent: Sendable { case stage(name: String, done: Int?, total: Int?), tokens(Int), reading(MachineReading), refused(Refusal) }
public struct QwenProbeReport: Codable, Sendable, Equatable {
  public var at: String; public var info: RuntimeInfo; public var appBuild: String
  public var increasedMemoryEntitlement: Bool; public var availableAtLaunch: Int; public var footprintBaseline: Int
  public var bgGPUSupported: Bool
  public var embedder: EmbedProbe?; public var generator: GenerateProbe?
  public var footprintAfterUnload: Int
  public var rows: [ProbeCheck]                      // S1–S8: PASS / FAIL / PENDING_DEVICE with numbers
}
public struct EmbedProbe: Codable, Sendable, Equatable {
  public var loadSeconds: Double; public var residentDelta: Int; public var plan: String
  public var windows: Int; public var windowsPerSecond: Double; public var peakFootprint: Int
  public var cosVsPythonMin: Double?; public var cosVsPythonMean: Double?
}
public struct GenerateProbe: Codable, Sendable, Equatable {
  public var loadSeconds: Double; public var residentDelta: Int; public var promptTokens: Int; public var prefillStep: Int
  public var prefillTokensPerSecond: Double; public var decodeTokensPerSecond: Double; public var peakFootprint: Int
  public var outputTokens: Int; public var grammarCompileMs: Int; public var identicalTwice: Bool; public var stop: String
}
```

- `AtlasService.events` gains `.qwen(ModelEvent)` (additive).
- `-qwen recorded` (the default in the simulator and UI tests) answers from `RecordedRuntime`, and every card it produces says **"recorded"**. `-qwen off` hides every Qwen surface, which is also the state of a phone without models.

### 2.10 What ships

| Artefact | Where | Size | Notes |
|---|---|---|---|
| The two models | pushed: `Tools/models.sh push` → `Documents/Inbox/Models/<name>/` (devicectl) → streamed sha256 against the pushed `MANIFEST.json` → renamed into `Library/Application Support/Models/<name>@<sha8>/` (excluded from backup; `CompleteUntilFirstUserAuthentication`) | 2.26 GB + 0.65 GB | `SCROLLS_BUNDLE_MODELS=1` bundles them for a standalone build. **The app has no download code.** |
| The demo's Qwen runs | **M1b: computed live** on the phone. **M2:** a JSON resource built by `scrolls-qwen demo-runs` (or the Python reference, `runtime: 'mlx (Python) on Mac'`), **independent of the starter**, with `built_on: mac` and a parity check (40 demo windows re-read on the phone, cos ≥ 0.999) | ≈ 1 MB | The first minute never waits for Qwen: until the groups exist, the lanes show the strand and the chip "Qwen · reading 212 / 340". |
| Cipher and STEMM vectors | **not shipped**; read on the phone, lazily | — | A **measured switch**, recorded and never silent: if the median first look exceeds 3 min on the device, the lead may offer an optional vector pack built on the Mac with the same key and the same parity check. |

---

## 3. Methods (with UI copy)

All copy below is exact; it lives in `QwenCopy.swift` (app) and `RefusalCopy.swift` (pure), both linted (§5.9).

### 3.1 Reading occurrences

- **What is eligible.** The strand's counted occurrences, after the default exclusions (SPEC §13.9) and the proper-noun guard. Excluded and counted separately:
  - **titles**: a title has no usage context (`titles_only`);
  - **non-English passages at M1** (`language_not_evaluated`): counted and drawn, never read for groups.
- **Cells.** Decade × collection. Undated occurrences form their own cell: read, but kept out of windows and shares.
- **The fit cap is permanent.** The population a groups run *fits* holds at most **3 occurrences per document**, at the first look, after *Read all* and on every refit. Everything read beyond it is **assigned** to the nearest centroid (`qassign`), never fitted.
- **First look** (automatic when a strand is tracked, setting *Read contexts automatically when I track a word*, on):
  - ≤ 600 occurrences, allocated ∝ √N_cell, ≥ 1 per non-empty cell, ≤ 3 per document;
  - seeded with `mulberry32(42 ⊕ fnv1a32(expression key))`, so the sample is reproducible;
  - est. 30–60 s on the phone plus 2–6 s to load the embedder (lab §2.7).
- **Read all** (an explicit opt-in per strand, never automatic work):
  - ≤ **5,000 per scope** (a scope = one collection group: Cipher literature, STEMM text, OpenAlex, …);
  - seeded order within cells; resumable across sessions from the vector cache; foreground only; paused by the thermal table;
  - the button carries the live ETA and the thermal state.
- **Read this occurrence** (from Then): reads one occurrence and assigns it.
- **Design weights.** Each read occurrence carries N_cell / n_cell. Shares, centroids and estimated lane counts are weighted, and the run records the plan.

| Moment | Copy |
|---|---|
| disclosure, everywhere a result is shown | "Read 600 of 4,309 occurrences (first look: up to 3 per book, spread over decades and sources)." |
| Read all button, before a rate exists | "Read all 4,309 · about 4–7 min (estimate) · the phone may get warm" |
| Read all button, with a rate | "Read all 3,709 more · ≈ 4 min 12 s at 14.7 contexts/s on this phone · nominal" |
| above the cap | "Read 5,000 of 8,289 (the cap for one scope). The rest are counted but not read." |
| Read this occurrence, embedder resident | "Read this occurrence · ≈ 0.3 s" |
| Read this occurrence, embedder not resident | "Read this occurrence · ≈ 3–8 s (Qwen loads first)" — plus ", and Qwen3-4B unloads" when the 4B is resident |
| paused | "Reading paused at 2,140 of 4,309: the phone is warm. It resumes by itself." |

### 3.2 The occurrence representation (R1)

- **Template** `occ-instr@1` (the measured `instr` template; lab §4.1):

  ```
  Instruct: Represent the meaning of the <word|expression> '<expression>' in this passage
  Query: <left><mid><right>
  ```
- **Window:** ±24 words (engine `u61m-1` tokens) around the target span, clipped to the passage and never across it. The whole input is ≤ 128 Qwen tokens, cut symmetrically. The target span comes from the occurrence's UTF-16 offsets (D4).
- **Vectors:** last-token pooled on `<|endoftext|>`, right padding, unit-normalised, cut to 256 dims and re-normalised, stored f16 **uncentred**. Centring happens in `qgroups`.
- **Key:** `qe06-q8@fe956e8d/occ-instr@1/w24w/d256`. A change of model, template, window or width is a new key. Analyses never mix keys (ΔQ-8).
- **Retrieval vectors** for Ask use `doc@1` (the ±32-word window, no instruction) under `qe06-q8@fe956e8d/doc@1/w32w/d256`; questions use `query@1`.
- **The R1 gate:** LQ-3 measures the ±24-word window on *bank* (silver ARI ≥ 0.92, against 0.942 at ±32 Qwen tokens) and re-runs rule_v2 on the 13 lab runs under this key **before M1c freezes it**. If it fails, R1 uses ±32 Qwen tokens for English (key `…/w32t/…`).

### 3.3 Context groups (`qgroups`, N4)

- **Input.** The fit population's vectors in one key, f16 widened to f32, centred by their design-weighted mean and re-normalised.
- **Pre-gates.**
  - ≥ 60 fitted, non-thin occurrences (a thin window has < 8 content tokens) from ≥ 5 documents. Otherwise `insufficient_occurrences` / `insufficient_documents` with SPEC's copy, or `not_read` when more reading would pass.
  - English only at M1: `language_not_evaluated`.
- **Clustering.** Spherical k-means, k-means++, 10 restarts, ≤ 100 iterations, seeded; `cblas_sgemm` for the n × k cosines in f32. k ∈ {2 … min(8, ⌊n/20⌋)}.
- **Choosing k: rule_v2** (lab §1.5; `GateThresholds.forKey`):
  1. compute the mean cosine silhouette of every k (exact up to 2,000 points);
  2. in falling-silhouette order, take the **first k whose stability ≥ 0.8** (30 document-block subsamples of 80%, each the best of 3 restarts, mean ARI against the full fit);
  3. compute the **no-groups reference**: the silhouette of that k on a Gaussian with the sample's weighted mean and covariance, put on the sphere (seeded);
  4. **ok** only if silhouette − reference ≥ **0.03** and silhouette ≥ **0.10**.
  - Otherwise k = 1, gated `no_cluster_structure` with detail `no_stable_k`, `below_margin` or `below_floor`. There is no fallback to another k.
- **The thresholds are frozen per representation key** and recorded as provisional: "set on 13 real-word runs read by one agent, not calibrated on pseudo-words". They are **never lowered after real words are seen**. The cost is accepted and stated in HANDOFF: the finest senses the lab saw (*key*'s machine, telegraph and taxonomic senses; *cell*'s battery and prison senses) are gated.
- **Pseudo-word acceptance** (LQ-1, LQ-2; the ANALYSIS-AND-LIMITS §7 benchmark): mean ARI ≥ 0.302 on Cipher text and ≥ 0.502 on STEMM text, lowest pair ≥ 0.13 and ≥ 0.23 (the PPMI-SVD 1.1.0 figures). Until it passes, every group card carries the provisional note; if it fails, groups are labelled "experimental: below the reference method on the benchmark" and the lead decides with him.
- **Group status.** Groups smaller than max(10, 5% of n) are `residual` ("other contexts"). Per-group Jaccard stability < 0.5 is `unstable` ("tentative", dashed).
- **Members.** `cluster_member` holds the fitted members with their cosine and margin; centroids go to `q_group`. Later reads are **assigned without refitting**. A refit happens only on request ("Regroup with everything read"), redraws the capped fit population, and is a new run; the old one stays pinnable.

| State | Copy |
|---|---|
| ok, provisional | "2 context groups. They pass a provisional test (stability ≥ 0.8, silhouette 0.03 above a cloud without groups), set on 13 real words and not yet calibrated." |
| `below_margin` | "No reliable context groups: the best grouping (k = 2, silhouette 0.110) barely beats a cloud of the same shape without groups (0.104); it needs a margin of 0.03. Representation: Qwen3-Embedding-0.6B (8-bit), read on this iPhone." |
| `no_stable_k` | "No reliable context groups: no grouping stayed the same when books were left out (best stability 0.79; needs 0.8)." |
| `not_read` | "Read 41 of 312 occurrences; groups need 60 from 5 documents. [Read all · ≈ 40 s]" |
| `language_not_evaluated` | "Context groups are measured for English text only so far. Hindi, Gujarati, Spanish and French uses are counted and shown, but not grouped." |
| `titles_only` | "These matches are titles; a title has no usage context to read. Groups use running text." |
| `model_absent` | "Context groups need the on-device model (Qwen3-Embedding), which is not on this phone. On your Mac: Tools/models.sh push." |

### 3.4 Concentration: "one book's vocabulary", collection and subject

- **Population.** The group's **assigned** occurrences (fitted + `qassign`) against the strand's read occurrences.
- **Enrichment** for each document, collection and `doc_tag` subject x: **E = p(x | group) − p(x | strand)**. Absolute shares are never flagged.
- **Flags** (provisional thresholds, set by LQ-4's uncapped refit; the numbers are always shown):

  | Flag | Fires when | Copy |
  |---|---|---|
  | one book's vocabulary | E ≥ 0.25 and p(doc \| group) ≥ 0.40 | "This group may be one book's vocabulary: 46% of its occurrences come from *Elements of Physiology*, against 4% of the word's occurrences read." |
  | one collection | E ≥ 0.25 | "This group may be one collection's usage: 88% of its occurrences are STEMM science books, against 52% of the word's." |
  | one subject | E ≥ 0.25 and p(subject \| group) ≥ 0.50 | "This group may be one subject's vocabulary (61% of its documents are tagged Physiology, against 18% of the word's documents), not a separate use." |
  | subject not checked | > 50% of the group's documents have no subject tag | "Subject not checked: 71% of these documents have no subject tag." |

- **Subjects** come from `doc_tag`: Gutenberg subjects (LoC headings) and OpenAlex topics. The subject is the confound the lab actually saw: *cell*, *plant* and *spring* in STEMM text (lab §1.4).
- **At a first look** the document flag cannot fire, because the fit holds ≤ 3 per book. The card says so: "Checked on the occurrences read. A first look reads at most 3 per book, so a one-book group can only show after Read all."
- **The model is never asked.** There is no `kind` field. The flags sit above the Qwen label on the card and append to the lane chip ("⚑ one subject").
- **The same subject composition feeds `qshift`** (§3.7).

### 3.5 Windows, shares, lanes and "first observed"

- **Windows (SPEC §4.8, kept).** Decades, merged forward until each holds ≥ 30 read occurrences. An uncovered decade is never merged across. Items dated wider than the window are excluded and counted.
- **Shares** are design-weighted, with a document-block bootstrap 95% CI (1,000 draws; the existing `Stats/Bootstrap.swift`).
- **Lanes on the Scroll** (N3 `ClusterLanes`, N7):
  - for each (group, bin), the estimated count is Σ over cells of N_cell × the weighted share;
  - the bin is drawn **`estimated`** (stripes + ≈) unless every occurrence in it is read;
  - **a bin whose cells hold fewer than 5 read occurrences is not split**: its whole count goes to the lane "not split: fewer than 5 read here";
  - titles have their own lane, "titles — no usage context"; non-English uses at M1 have "not grouped (language not evaluated)";
  - **the lanes still partition the strand's count exactly** (the residual lane absorbs rounding), and the conservation tests stay.
  - Tap sentence: "estimated: 40 of 312 occurrences in this decade read by the model; the rest are shared out by the read ones."
- **Transitions** keep SPEC's definitions (emerge, vanish, split, merge; uncovered windows → `unknown_gap`), computed on per-window weighted centroids in the one space and drawn dashed. The ⑂/⑃ copy is unchanged: "a split in usage contexts, not a claim about speakers".
- **Convergence of two expressions** keeps SPEC's J(t) of collocates. Its C(t) becomes the cosine of their mean vectors in one key; different keys gate `representation_mismatch`.
- **"First observed"** (critique P2-23):
  - about the **word form**, from the data: "First observed in this corpus: {date chip}";
  - about a **group**, only after the strand is fully read: "First observed in this group: {date chip} (all 4,309 read)";
  - otherwise: "Earliest of the 600 read: {date chip}. Unread occurrences may be earlier."

### 3.6 Labels: computed words first, Qwen's label beside them

1. **Distinctive words (computed, deterministic; N4).** The top 4 context words per group by weighted log-odds with an informative Dirichlet prior (Monroe et al. 2008), from the engine's tokens within ±10 of the target, z ≥ 1.96, in-group f ≥ 3. They are stored in `sense_cluster.label_auto` and `distinctive_json`, and appear the moment groups exist: "machine label: river · along · water · stream".
2. **Qwen's label (`qlabel`, Q).** **One call per group** (lab §3.3–§3.4), only for **gate-ok, non-residual** groups. Every label of a strand runs in one 4B residency.
   - **The passages are chosen by the engine, not the model:** the 3 members nearest the centroid and 2 seeded random members, ≤ 1 per document, ±25 words. The random members let a mixed group show itself (mixed groups got confident single labels: *key* G1, Hindi *kal* group 1; lab §3.3–§3.4).
   - The prompt is `label@1` (§2.4); output cap 160; `cites` names 2–4 of the 5 passages.
   - Stored as `annotation(kind = 'machine_gloss', target cluster, is_machine = 1, method = 'qlabel@1', run_id, author = 'machine:qwen3-4b@2a73c6c2')`, with the citations in `evidence_refs_json`.
3. **His rename** is a `label` annotation, as in the reference.
   - Lane-chip precedence: his label, then "Qwen label: …" (with the machine glyph), then "machine label: …" (computed words). The two machine classes never share a prefix.
   - **The card always shows all three**, with "(editable)" beside the machine ones.
- ***Label groups automatically* is off** until he has judged ≈ 20 labels at the M1c device session (*bank*, *current*, *charge*, *carry the zero*) and the lead records his verdict in `EVAL.md` (§8 decision 3). Until then a group card offers **Label this group** and the lane menu **Label groups (2)**.

| Moment | Copy |
|---|---|
| label button | "Label 2 groups with Qwen3-4B · about 20–45 s (the model loads first)" — then from the live rate |
| gated strand | no label is offered: "Groups are not reliable here, so Qwen is not asked to name them." |
| stopped at the cap | "Qwen's label stopped at its length limit; nothing is shown. [Try again]" |

### 3.7 Shift between two slices, in one model space (`qshift`, N4; M2)

| Measure | What | Uncertainty / null | Gate per slice |
|---|---|---|---|
| (a) group-share shift | JSD (base 2) of design-weighted group shares; groups fitted on A ∪ B with the per-document cap | document-block bootstrap, 1,000 draws → 95% CI | ≥ 50 read, ≥ 5 documents, ≥ 3 authors, groups gate-ok |
| (b′) centroid displacement | 1 − cos(μ_A, μ_B), with μ the design-weighted means of the **uncentred** unit vectors | 500 permutations of **documents** between A and B (each slice keeps its document count) → percentile; a split-half self-baseline per slice | as (a) without the groups; the same language and the same key |

- **Verdict.** "Notable" only if (b′)'s percentile ≥ 100 − 5/k (the multiplicity from `compare_log`) **and**, when groups exist, (a)'s CI excludes 0. Otherwise "within typical variation". The wording is always *"estimated shift in usage contexts, read by one modern model"*.
- **Caveats and gates.**
  - The composition caveat fires at a composition JSD > 0.15, and (b′) is not reported above 0.4 (`composition_mismatch`).
  - **The subject-mix caveat** (new) uses the same rule on the slices' `doc_tag` subject distributions: "These periods draw on different subjects (Physiology 41% in A, Electricity 38% in B); part of this shift may be the subject mix."
  - `modality_mismatch`, `sampling_design` (OpenAlex cells) and the prominence caveat are unchanged. `language_mismatch` and `representation_mismatch` are new.
- **The fixed caveat on every shift card:** *"Both periods were read by the same 2025 model. It reads older spelling and register through today's language, so some 'shift' can be spelling, genre or subject."*

### 3.8 Similar-usage edges (`qedges`, N4; M3)

- For each read occurrence, its nearest neighbours by cosine among occurrences **in other documents by other authors**.
- An edge is made only for **mutual top-3** neighbours with cos ≥ τ, where τ = max(the run's p99 of different-document random-pair cosines, **0.85**) (LAB-12: *bank* p99 0.8517 at 256 d; recalibrated per key at M3). Each occurrence keeps ≤ 3 edges; a run makes ≤ 300.
- Stored as `relationship(rel_type = 'similar_contextual_usage', evidence_status = 'computed', origin = 'algorithm', method = 'qedges@1', run_id, score = cos, score_kind = 'similarity', directed = 0)`.
- Hidden in lineage by default, like `kindred`. Shown in Then's "similar uses elsewhere" with the fixed sentence "Similar usage contexts (computed). Not influence, ancestry or intent." Never an arc on the Scroll, never feedback.

### 3.9 Tone and stance (fallible annotations; M3, gated)

- **Tone (`qtone`)** is **off until LAB-13 passes**: κ ≥ 0.4 against his labels on ≥ 100 paragraphs. Then:
  - up to 2,000 paragraphs per slice (seeded), each classified `positive | negative | neutral | mixed`, 8 per call, stored as `machine_tone`;
  - shown **only as distributions per slice** with a document-block bootstrap CI, never as a label on one passage (SPEC §4.10 kept); gate ≥ 30 paragraphs per slice;
  - labelled *"Qwen3-4B tone reading — modern, fallible, anachronistic for historical text."*
- **Stance (`qstance`)** stays off unless κ ≥ 0.4 (LAB-11) **and** he turns it on. It suggests the `pragmatic_function` vocabulary plus `unclear`, as `machine_tag`, in the Notebook only, as "machine suggestion — confirm or reject"; its counts never mix with human counts.

### 3.10 Explaining a difference (`qexplain`; Compare, M2)

- **Input:** the engine's facts as data (slices as `{A}`/`{B}`, group labels, shares with CIs, the **ok** shift measures; a gated measure is passed as "not estimated", never as a number), the caveats that fired, and **6 passages, 3 per slice, stratified by context group and by period** (§3.11's selector, per slice).
- **Output:** comparative claims, each needing ≥ 1 citation in A **and** ≥ 1 in B; a one-sided claim is dropped.
- **Placement:** a collapsed machine card **below** the computed panels, never above, never replacing a number.

### 3.11 Ask the atlas (`qask`; M2; ships only on his judgement)

- **Scope** is explicit and shown as chips: *this strand* · *this range* · *this group* · *this view* · *all loaded text (keywords)*. Ask is never open-domain over 146.7 M tokens.
- **Routing before anything else** (`QuestionRouter`, pure):

  | Question | Route |
  |---|---|
  | "what does X mean …", "what is meant by X", "the meaning of X" | **the computed group card** when the strand has gate-ok groups; generation adds only the per-group glosses beside it |
  | "when did X start / first …", "who first …", "how many" | **from the data**: the "first observed" rule of §3.5, or counts from the engine; never the model |
  | what someone thought, felt or intended | the fixed refusal (§4 rule 24) |
  | anything else | generation |

- **Candidates.**
  - With *this strand / range / group*: the strand's occurrences in scope. With *all loaded text*: FTS5 `bm25`, ≤ 64 per (period × collection) stratum (S2 confirms `bm25` on the contentless `passage_fts`).
  - **Filters:** the engine's default exclusions plus **body ≥ 80 characters** (drops "Germ theory, 51, 98", "Horse Virus Vindicated, xvii", "Bank-cress, 327"; lab §3.5).
- **Selection** (`StratifiedRetrieval`; critique P0-6):
  - **with gate-ok groups:** each candidate's occurrence is assigned to its group (vectors computed if missing, ≤ 2 batches); **≥ 1 slot per group**, the rest in proportion to the design-weighted group shares; within a group, round-robin over periods, ranked by similarity to the question (`query@1` against `doc@1`); ≤ 2 per document; 6 slots. Method `byGroupAndPeriod`.
  - **without groups** (not read, gated, non-English, or no embedder): round-robin over periods, ranked by similarity. Method `byPeriodAndSimilarity`, and the caveat below is mandatory.
- **Refusal before generation:** fewer than **3 passages from 2 documents** → no model call: "Too little evidence in {scope}: {n} passages from {d} documents (needs 3 from 2). Nothing was generated."
- **Generation:** switch models (embedder → 4B); `ask@1`; prompt ≤ 1,024 tokens (6 × ±32 words; est. ≈ 530–850 tokens from the lab's 658–1,054 at ±40 words); output cap 480.
- **Verification:** §4 rules 20–25, then rendering.
- **The disclosure, always under the claims:**
  - `byGroupAndPeriod`: "Read 6 passages of 4,309 occurrences: at least one from each context group, spread over decades."
  - `byPeriodAndSimilarity`: "Read 6 passages of 4,309 occurrences, spread over decades and chosen by similarity to your question. **These passages were chosen by similarity to your question, which favours the most familiar modern use of the word; other uses may be missing.**"
- **Keep in notebook** stores the answer as a `machine_gloss` annotation on the scope target, with his question as his own `question` annotation.

### 3.12 Then / Now / Next

- **Then (M1).** A "Context group" row (computed: label precedence, cos to the centre, margin). "Machine annotations (fallible)" lists Qwen glosses touching this passage. An unread occurrence shows **Read this occurrence** (§3.1 copy).
- **Now (M3): a machine reading of a reuse (`qreuse`).** Input: the Then and Now passages, the engine's deterministic alignment and the relationship card's facts (type, status) as data. Every claim cites both passages. It can never change, upgrade or add a relationship.
- **Next (M3): Draft a hypothesis (`qdraft`).**
  - Offered only for a gate-ok group with ≥ 3 later passages from ≥ 2 documents.
  - Input: later uses in the same group (stratified by period) and the group's share trend as computed facts.
  - Output: one hypothesis (≤ 40 words, framed as a possibility) plus cited grounds; the change and cause words of rule 24 are withheld here too.
  - Stored as a **machine** `hypothesis` annotation and rendered as a machine card headed *"Hypothesis drafted by Qwen3-4B — not evidence"*. Never violet: violet is his reinterpretation.
  - **Make it mine** opens his editor prefilled; what he saves is his own (the dashed violet "Hypothesis — by you"), with `dimensions_json.drafted_from` = the machine annotation, which stays as a machine layer.
  - Off by default until he has judged ≈ 10 drafts (EVAL.md).
- **Allusion readings (`qallusion`, M3)** only from an edge card or a two-passage selection, on his request: `none | wording | idea | unclear` plus cited basis, shown as a reading. Only **Add as a proposed allusion** creates `proposed_allusion` (origin `machine_tagger`, `proposed`, `created_by = 'run:n'`).

### 3.13 What is disabled when evidence or models are missing (additions to SPEC §4.11)

| Feature | Gate | Copy |
|---|---|---|
| Groups, not read enough | `not_read` | §3.3 |
| Groups for titles | `titles_only` | §3.3 |
| Groups, non-English (M1) | `language_not_evaluated` | §3.3 |
| Groups, no structure | `no_cluster_structure` (+ detail) | §3.3 |
| Groups, no embedder | `model_absent` | "Context groups need the on-device model (Qwen3-Embedding), which is not on this phone. On your Mac: Tools/models.sh push." — and **no distinctive words are offered**, because without groups there are none |
| Labels | groups gated, residual or no 4B | gated: no label offered; no 4B: "Labels need Qwen3-4B, which is not on this phone." The computed distinctive words still show when groups exist |
| Shift | `language_mismatch`, `representation_mismatch` | "A is English, B is Hindi: one model reads both, but their uses are not comparable as a shift." / "A and B were read by different model versions; re-read B with the current model. [Read]" |
| Machine readings of gated results | — | not offered: the model is never asked about a gated measure |
| Ask | refusals (§4 rule 23), thin evidence (§3.11) | exact copy in §4 |
| Tone | LAB-13 not passed | "Tone readings are off until they agree with your own readings (needs κ ≥ 0.4 on 100 paragraphs)." |
| Stance suggestions | LAB-11 | "Off: machine stance agreed with human readers at κ = {κ} (needs 0.4)." / before measurement: "Off: not yet compared with human readers." |


---

## 4. Honesty rules for LLM output (SPEC §13, rules 19–34)

SPEC §13 rules 1–18 stay law. Rule 10 now covers Qwen labels and readings, and rule 11's words bind generated text through the Verifier (ΔQ-9). The rules below are added. **Reviewers reject code that breaks one.** `Verifier` (Q, pure) makes rules 20–25 mechanical, `CopyLintTests` (§5.9) makes the copy rules mechanical, and the Q4 tests (§6.2) feed both adversarial input.

19. **A machine reading is never evidence.** It never:
    - enters a count, a denominator, a share or a rate (group lanes are computed from vectors; only their *labels* may be machine text);
    - creates a `documented` or `computed` relationship (generation can only make `proposed_allusion`, origin `machine_tagger`, on his request; similar-usage edges are computed by the embedder's algorithm, never by generation);
    - sets or changes a date, a review or an evidence status;
    - appears as a mark on the Scroll.

    It renders only in the **machine card** style: opaque `bg-1`, a 1 pt dotted `ink-3` border, the machine glyph (SF Symbol `cpu`, `ink-3`, accessibility label "machine reading") and the chip **"machine reading"**. Never glass, and never amber, violet or cyan, which belong to history, reinterpretation and selection. Exports mark it `machine_reading: true`.
20. **Every claim cites passages it was given.**
    - Citations are `P`-ids from the prompt's own list (the grammar's `enum` is built per call). A claim whose citations are empty or outside the list is **dropped**.
    - The app renders each citation from the atlas: the text through `TextStore` at its UTF-16 offsets, the date chip from `date_assertion`, `SYN` when synthetic. **The model's text is never shown as a quotation.**
    - A comparative claim (`qexplain`) needs ≥ 1 citation in A **and** ≥ 1 in B, or it is dropped.
    - A claim that cites a single passage is shown with "from one passage".
21. **The quote gate is hard** (critique P0-7).
    - `quote_from` must be one of the claim's `cites`, and the `quote` must be found in that passage after NFC, quote-mark folding (‘ ’ ‚ ‛ “ ” „ « » → ' and "), whitespace collapse and case folding. A quote shorter than 3 words ties nothing and fails.
    - **If the quote is not found, the whole claim is dropped**, never kept on the strength of its citation. The lab's thin-evidence run kept a stitched quote ("the virus communicated by Jenner himself") that a soft gate would have shown (lab §3.5).
    - The span shown is the atlas text at the offsets where the match was found, highlighted inline.
22. **Dates and numbers come from the records, in depth** (critique P0-8).
    - **The grammar** bans `\p{Nd}` (every Unicode decimal digit, not only `[0-9]`) in every free-text field: `label`, `gloss`, claim `text`, `reason`. If XGrammar rejects `\p{Nd}` at S5, the generated class in `DigitClass.swift` replaces it (§2.4).
    - **The Verifier always runs `NumberGuard`**, whatever the grammar did, because a grammar can be bypassed (parse-then-validate fallback, §8 decision 9) or mis-scoped (the lab's Ask ban masked nothing: `masked_steps = 0`). In every free-text field it **drops** the claim (or withholds the label) on:
      - any `Nd` digit: ASCII, Devanagari ०–९, Gujarati ૦–૯, full-width ０–９, and the rest of the class;
      - cardinal number words from *two* upwards (*two … ninety, hundred, thousand, million, billion, dozen*), and *one* before *hundred / thousand / million / billion*;
      - Roman numerals: a token that parses as a strict Roman numeral of length ≥ 2 and is all capitals (*XVII*), follows *chapter, page, part, book, volume, vol., p.* or ends with a full stop, or is not an English word in the engine's lexicon (so *mix*, a valid numeral, passes as a word);
      - century and decade phrases (*nineteenth century*, *the eighteen-eighties*, *the eighties*, *the 1880s*) **unless** the phrase's interval contains the date interval of a cited passage (the period slot the model was shown).
    - Periods appear in prompts only as slot tokens (`{A}`, `{B}`, … in date order, `{U}` undated). The app fills them from the data.
    - The model is never asked "when", "who first" or "how many": `QuestionRouter` answers from the data (§3.11).
    - The cost is accepted: a label that would need a digit ("COVID-19") is written without it, and the computed distinctive words beside it show the original token.
    - **Adversarial device test (S5, §6.4):** the lab's question "What did 'virus' mean in the 1880s books?" through the Swift guided path on the phone. Pass = no digit and no unmatched decade phrase in any shown claim, and the Verifier's log shows the guard ran.
23. **Refusal is a first-class result.** Refusals are information, not errors: no red, no haptic. The copy is exact (`RefusalCopy.swift`):
    - (a) no candidates: *"No passages in {scope} match this question. Nothing was generated."*
    - (b) thin evidence, before generation (§3.11): *"Too little evidence in {scope}: {n} passages from {d} documents (needs 3 from 2). Nothing was generated."*
    - (c) a question about what someone thought, felt, believed or intended, before generation: *"Scrolls does not reconstruct what historical people thought, felt or intended. These passages use the words in your question:"* (then the passages, with no model call)
    - (d) "when / who first / how many", before generation: *"Dates and counts come from the records, not from the model. First observed in this corpus: {date chip}."* (§3.5's rule decides the wording when a group is named)
    - (e) the model said `answerable: false`: *"Qwen found no answer in the {n} passages it read."* followed by its reason as machine text, after rules 22 and 24 have run on it
    - (f) nothing survived the Verifier: *"Qwen's answer could not be tied to the passages it read (0 of {k} claims kept), so it is not shown. The {n} passages it read are below."*
    - (g) stopped at the output cap or the wall limit: *"Qwen's reading stopped at its length limit; nothing is shown. [Try again]"*
    - (h) a gated input: *"Not estimated here ({gate}), so Qwen is not asked about it."*
24. **No mental-state, change or cause stories** (critique P0-9). The Verifier runs `ForbiddenWording` over every generated sentence (claim text, label, gloss, reason, draft):
    - **mental state:** the existing `Copy.mentalStateVerbs` (SPEC's `MENTAL_STATE_VERBS`) about any person;
    - **origin:** *coined, born, first used, originated, began / begin / begins / begun*, and SPEC rule 11's *"meaning changed"*;
    - **change and cause:** *evolved / evolve(s, ing), shifted / shift(s, ing), became / become(s, ing), turned into / turn(s, ing) into, led to / lead(s, ing) to, because (of), influenced / influence(s, ing)*.
    - A matching sentence is **withheld**, never rewritten. One retry with a reminder appended to the prompt is allowed; both outputs are stored in `q_output`. Copy: *"1 sentence withheld: it described what a historical person thought or intended."* / *"1 sentence withheld: it told a story of change or cause. Scrolls shows how periods differ, not why."*
    - A label or gloss that trips the rule is withheld whole: *"Qwen's label was withheld: {reason}. The computed words stay."*
    - The cost is accepted and stated in the withheld note: a literal use ("the cargo shifted") is withheld too.
    - A question asking what someone thought or intended never reaches the model: refusal (c).
    - `qexplain` and `qdraft` prompts ask for the frame "In {A} …; in {B} …" and forbid saying why.
25. **Nothing generated is shown before the Verifier has run, and nothing is called "verified".**
    - While Qwen writes, the card shows a token counter only ("Writing · 41 tokens"). There is no streamed prose.
    - Each kept claim shows, **inline and not behind a tap**, its cited sentence from the atlas with the quote highlighted, so the reader can check it.
    - The words *verified, confirmed, fact-checked, proven, accurate* never appear in the UI (lint). The only status line a kept claim carries is *"quote matches the passage; the reading is the model's"*. In code, kept claims are `TiedClaim`.
    - Dropped and withheld claims are counted under the claims: *"2 claims kept · 1 dropped (its quotation did not match the passage) · 1 withheld (change or cause wording)"*.
26. **Every reading is reproducible and pinned** (critique P1-19).
    - Its run records the model sha256, the device model, the iOS build, the mlx-swift, mlx-swift-lm and XGrammar versions, `built_on`, the prompt id and sha256, the grammar sha256, the caps, the **prefill step**, the **batch plan**, the seed, its inputs (passage ids, offsets and text sha256s, in order), the selection method, the raw output and every Verifier decision (§2.7–§2.8).
    - Byte identity is claimed only within one batch plan on one device; across plans the claim is cos ≥ 0.999.
    - It is journaled verbatim (`machineRun`). Saved views pin it. It is never silently regenerated: **Regenerate** makes a new run and keeps the old one as an earlier layer.
27. **The modern reader is always named.** Every machine card ends with the footer:

    > *"Machine reading by Qwen3-4B (2025), on this iPhone — not evidence. A modern model's reading of these passages: it can be wrong, and it reads old text with today's sense of words. Quotes and dates come from the atlas, not the model."*

    The badge carries the model name and sha8, and "recorded" (`RecordedRuntime`) or "built on the Mac" where that applies. Group cards built from embeddings carry *"Context groups computed from Qwen3-Embedding-0.6B (8-bit) vectors, read on this iPhone."*
28. **Coverage and selection are disclosed** (critique P0-6). Every reading states what it read **and how it was chosen** (`ReadDisclosure`, §2.9): *"Read 6 passages of 4,309 occurrences: at least one from each context group, spread over decades."* Without groups, the modern-default caveat of §3.11 is mandatory. Answers speak of "the passages read", never of "the corpus".
29. **Gated means silent.** The model is never given a gated value and never asked to speculate about missing groups or shifts. Only gate-ok, non-residual groups are labelled (§3.6). A gated card stays a gate card, with no machine card under it.
30. **Concentration is computed, never asked.** The one-book, one-collection and one-subject flags come from enrichment on the assigned population (§3.4). No prompt asks the model whether a group is one source, and no schema has a `kind` field. The flags sit **above** the Qwen label on the group card.
31. **"First observed" is about the word form** (critique P2-23). A group-level first is shown only after the strand is fully read; otherwise *"Earliest of the {n} read: {date chip}. Unread occurrences may be earlier."* The model never states a first.
32. **Synthetic stays synthetic.** Prompts over demo material say it is synthetic (lab §4.3). Machine cards that cite demo passages carry `SYN` and the dashed demo frame, and SPEC's ribbon rules apply.
33. **Local, licensed, his.**
    - All inference runs in the app process. There is no download code and no network (ΔS-17; the lint bans `URLSession`, `HubClient` and `Downloader` in Qwen paths).
    - His annotations enter a prompt only when he selects them as inputs.
    - Readings that cite `export_text_allowed = 0` passages export citation ids and quote hashes, never the text.
    - Machine labels stay visible after he renames a group (rule 10, extended); the lane chip shows his label first.
34. **His judgement sets the defaults, not the lab's.**
    - *Label groups automatically* stays off until his verdict on ≈ 20 labels (§8 decision 3); Ask ships only on his semantic-support judgement (§8 decision 5); stance and tone stay off behind their κ gates.
    - No quality figure in the UI or in HANDOFF quotes the lab agent's judgements (86% labels, 7 of 8 answers) as the app's. Only Swift-guided-path measurements and his judgements in `EVAL.md` are quoted (§6.3).

**The Verifier's order** (`Verifier.check(_:given:task:) -> VerifiedReading`, pure; each step writes `checks_json`):

1. `stop` must be `accepted`; otherwise the run is `failed` and refusal (g) shows.
2. The output must parse against the task's schema. The grammar guarantees it; the parse-then-validate fallback re-checks it. Failure → `failed`.
3. `answerable == false` → refusal (e), after rules 22 and 24 have run on `reason`.
4. Each claim, in order, stopping at the first failure: citations (rule 20) → `quote_from` cited and quote found (rule 21) → `NumberGuard` (rule 22) → `ForbiddenWording` (rule 24) → new capitalised names absent from the cited passages and the question, skipping sentence-initial words (withheld: *"1 sentence withheld: it named someone or something the passages do not."*) → both sides cited (comparative tasks).
5. Verdict: `shown` (every claim kept), `partly_withheld` (≥ 1 kept, ≥ 1 dropped or withheld), `refused` (none kept: refusal (f)).

---

## 5. The iPhone experience: what changes

IOS-SPEC §4's principles hold: thumbs at the bottom, glass is chrome, nothing moves at rest, every count names its denominator, **never a spinner without a number**. Qwen appears as computed lanes with machine labels, as opaque machine cards, and in one status chip. The copy below is exact.

### 5.1 The status chip, loading, memory and thermal states

`QwenStatusModel` (Q) feeds the TopBar's trailing status chip from `AtlasService.events.qwen`. Every state has a number or a reason.

| State | Status chip | Elsewhere |
|---|---|---|
| reading | "Qwen · reading 312 / 600 · 14.7/s" with a progress ring | the strand's lane header: "read 312 of 4,309" |
| loading | "Qwen · loading Qwen3-4B (last load 4.2 s on this phone)"; before any load: "Qwen · loading Qwen3-4B (about 3–8 s)" | — |
| writing | "Qwen · writing · 41 tokens" | **Cancel** on the card (acknowledged ≤ 500 ms) |
| checking | "Qwen · checking quotes and wording" | — |
| paused (thermal serious) | "Qwen paused: the phone is warm" | Read all: "Reading paused at 2,140 of 4,309: the phone is warm. It resumes by itself." |
| stopped (thermal critical) | "Qwen stopped: the phone is hot. Models unloaded." | — |
| Low Power Mode | "Qwen: no automatic reading in Low Power Mode" | explicit requests still run |
| refused (admission, §2.5) | "Not enough memory to load Qwen3-4B (needs ≈ {needed} GB free; {available} GB free now). Nothing changed." | the card offers **[Try again]**; with an engine job running: "… Try again when 'Materialising Cipher' finishes." |
| unloaded | nothing (the chip disappears after 2 s) | Settings shows the reason: "Unloaded: idle 90 s" · "Unloaded: Scrolls went to the background" · "Unloaded: memory warning" |
| models absent | nothing | Settings → On-device model shows the push command (§5.7); Qwen surfaces are hidden, gate cards say `model_absent` (§3.3) |

- `{needed}` is `load + growth + headroom` of the model (provisional: Qwen3-4B ≈ 3.6 GB, the embedder ≈ 2.1 GB; §2.5), `{available}` is `os_proc_available_memory()` minus other reservations. Both are replaced by device values once M1a has measured.
- **Timing copy comes from the rate measured on this phone in this session.** Before a rate exists, the estimates of §2.4 and §3.1 are shown with "(estimate)". No timing copy quotes a Mac figure.

### 5.2 Context-group lanes and the group card (M1b)

- **Turning them on.** The Lanes chip's menu gains **Context groups (Qwen)**, and the strand chip's menu **Show context groups**. If the strand has not been read, choosing it starts the first look (or, for the demo, the whole strand), with the status chip running and the lanes showing the strand until groups exist.
- **Lane headers.** Precedence: his label ("your label: river side") · Qwen's label ("Qwen label: riverbank" + the machine glyph) · the computed words ("machine label: river · along · water · stream"). The two machine classes never share a prefix, and both carry the glyph. Flags append: "⚑ one subject". Tentative groups are dashed ("tentative"). The residual lane reads "other contexts".
- **Bins.** Estimated bins use the stripes + ≈ encoding; bins with fewer than 5 read occurrences go to the "not split: fewer than 5 read here" lane; titles and non-English uses have their own lanes (§3.5). Tap sentence: *"estimated: 40 of 312 occurrences in this decade read by the model; the rest are shared out by the read ones."*
- **The group card** (`SheetMode.groupCard`, half detent, large on drag), opened from a lane header, in this order:
  1. **Flags (computed)**, above everything the model wrote, with their numbers (§3.4). At a first look: *"Checked on the occurrences read. A first look reads at most 3 per book, so a one-book group can only show after Read all."*
  2. **Labels:** his label (if any); Qwen's label and gloss in a machine card with "(editable)" and the footer of rule 27; the computed words with "(editable)".
  3. **Passages chosen by the engine:** *"Nearest the centre (3) and chosen at random (2)"*, each row a date chip, the title and a KWIC line with the span highlighted, opening Then. The passages Qwen's label cited are marked "cited by Qwen's label" with the glyph. **The card never presents the label's citations as evidence that the label fits.**
  4. **Numbers:** *"n = 312 read of 4,309 · 141 documents · stability 0.99 · silhouette 0.237, 0.069 above a cloud without groups (needs 0.03) · thresholds provisional (set on 13 real words, not yet calibrated)"*; *"Representation: Qwen3-Embedding-0.6B (8-bit) · occ-instr@1 · ±24 words · 256 dims · run #41 · read on this iPhone"*.
  5. **Coverage:** the read disclosure of §3.1, and the earliest-read line of §3.5.
  6. **Actions:** **Rename** · **Label this group** (or **Regenerate label**) with its time · **Read all** with its ETA · **Regroup with everything read** · **Notes**.
- **A gated strand** shows its gate card (§3.3 copy) with **[Read all · ETA]** when more reading would pass, or **[Widen]**. No labels are offered.
- **Haptics:** `.select` when the card opens, as for any selection; nothing for Qwen events.

### 5.3 The inspector

- **Then (M1b).**
  - A "Context group" row (computed): *"Context group: riverbank (Qwen label) · cos 0.71 to the centre · margin 0.18"*.
  - An unread occurrence shows *"Not read by the model yet."* with **Read this occurrence** and the residency-dependent copy of §3.1 (≈ 0.3 s only when the embedder is resident).
  - "Machine annotations (fallible)" lists Qwen readings that cite this passage: *"Cited by Qwen's label for 'riverbank' (run #41)."*
- **Now and Next (M3):** §3.12.
- **The fixed footer stays:** "Then shows documents and their settings, not anyone's private thoughts."

### 5.4 Compare (M2)

IOS-SPEC §4.10's order holds; computed panels always come first.
- **Panel 6, Context groups:** design-weighted shares per slice with CIs, from `qgroups` fitted on A ∪ B with the per-document cap; the flags; a gate card when gated.
- **Panel 7, Estimated shift:** the (a) and (b′) lines with their nulls, the composition and **subject-mix** caveats and the fixed caveat of §3.7. Named "estimated shift in usage contexts, read by one modern model".
- **Panel 7½ (new), Machine reading of the difference:** a collapsed machine card, *"Ask Qwen to read 6 passages from A and B (≈ 20–50 s)"*. It runs only on tap, sits **below** panel 7 and never replaces a number. It is absent when every measure is gated (rule 29).
- **Panel 8, Tone (M3):** Qwen tone distributions per slice once LAB-13 passes (§3.9); until then its gate card. Apple NLTagger and the asset download are gone (ΔQ-7).

### 5.5 Ask the atlas (M2; off until his judgement)

- **No new tab and no modal.** Search's suggestion list gains a row **"Ask the atlas — machine reading"** when the query has ≥ 4 words or ends with "?". It sets `SheetMode.ask(session)` at the large detent.
- **The Ask panel** (Q's `AskPanel`), top to bottom:
  1. the question and the **scope chips** (*this strand · this range · this group · this view · all loaded text (keywords)*);
  2. a routing line when `QuestionRouter` answers without the model: *"This asks what the word means: the context groups answer that from the data. Qwen adds one gloss per group."* or refusals (c) and (d);
  3. the stage list, each with a number: *"Finding passages · 64 candidates"*, *"Dropping index and heading lines · 3 dropped"*, *"Choosing 6 passages: at least one per context group, spread over decades"*, *"Loading Qwen3-4B"*, *"Writing · 212 tokens"*, *"Checking quotes and wording"*; **Cancel** throughout;
  4. the kept claims: each the model's sentence (machine style), then its cited sentence inline with the quote highlighted, then citation chips (date chip from the data, `SYN` when synthetic), then *"quote matches the passage; the reading is the model's"*;
  5. the dropped and withheld counts (rule 25), the read disclosure with the selection method (rule 28), the footer (rule 27);
  6. **Passages read (6)**, each opening Then; **Keep in notebook**.
- **Until decision 5 (§8) is taken,** the suggestion row is absent and Settings shows *"Ask: off until you have judged the evaluation answers"*.

### 5.6 Notebook (M2)

- A **"Machine readings"** section groups Qwen layers by target: labels, explanations, kept answers, drafts. Each row: *"rev 1 · machine · Qwen3-4B@2a73c6c2 · run #41 · on this iPhone"*.
- Machine layers can be countered or rejected, never edited (IOS-SPEC §4.13). **Make it mine** copies a machine draft into his editor and records `drafted_from`; what he saves is his.

### 5.7 Settings → On-device model (Q); How Scrolls works; Legend

- **Per model:** name, size, sha8, status (*missing · in Inbox · checking files 41% · installed · resident*), the last load time and the measured footprint on this phone. The sha256 check is called "checked" in copy, never "verified" (§5.9).
- **Missing models** (exact): *"Qwen3-Embedding-0.6B (8-bit, 649 MB) is not on this phone. Context groups need it. On your Mac: Tools/models.sh push"* and *"Qwen3-4B-Instruct-2507 (4-bit, 2.26 GB) is not on this phone. Labels and answers need it. On your Mac: Tools/models.sh push"*.
- **Memory now:** available memory, what is reserved, and **Unload now**.
- **Toggles and defaults:**

  | Toggle | Default | Note |
  |---|---|---|
  | Machine readings (master) | on | off hides every Qwen surface (= `-qwen off`) |
  | Read contexts automatically when I track a word | on | the first look only (≤ 600); never Read all |
  | Label groups automatically | **off** | locked until §8 decision 3: *"Off until you have judged about 20 labels."* |
  | Machine stance suggestions | off, locked | *"Off: not yet compared with human readers."* (LAB-11) |
  | Tone readings | off, locked | LAB-13 copy (§3.13) |

  There is no "keep Qwen3-4B loaded" toggle (decision 12).
- **Qwen on this iPhone** (§5.10) is the last row.
- **How Scrolls works** gains: section 06 *"Machine readings: generated text about cited passages; never evidence"*, with the machine-card swatch and the rule-27 footer; section 07, the models row and *"Context groups are computed from vectors; Qwen only names them."*
- **The Legend** gains the machine-card row, the machine glyph, and the estimated and not-split bin rows.

### 5.8 First minute, tour, haptics, accessibility

- **The first minute is unchanged** (IOS-SPEC §4.17): community lanes, coach marks ①–③, Play. **No model loads in the first 60 s** unless he asks. At M1b the demo's groups are computed live only when he turns on context groups; prebuilt demo runs arrive at M2 (§2.10).
- **Your turn** (critique P0-9). The draft's *"Ask: why did 'carry the zero' turn ironic?"* is never built: it is a *why* question about a change of meaning that rule 24 refuses.
  - **M1b:** the chip *"See how Qwen groups 'carry the zero' (reads 340 uses on this phone, about 20–40 s)"*, which opens the strand with context-group lanes.
  - **M2, once Ask ships:** the descriptive chip *"Ask: how do the office memos use 'carry the zero' compared with the classroom primers?"*.
- **Tour step 5** (`tour.json` stays byte-equal; DV-Q1 records the divergence): the phone shows *"representation: Qwen3-Embedding-0.6B (8-bit), read on this iPhone"* instead of "representation: tfidf-hash-4096". **Step 11 (M4):** open a group card, compare Qwen's label with the computed words, rename it.
- **Haptics:** none for Qwen events. A refusal, like a gate card, is information.
- **Reduce Motion:** changes nothing here; there is no streamed text to animate.
- **VoiceOver:** every machine card's label starts "Machine reading:"; the glyph reads "machine reading"; citation chips are buttons ("Passage, 1911, Brennock's primer, synthetic"); the status chip announces start and completion once, never per token; dropped and withheld counts are read with the claims. Dynamic Type to AX5 keeps the cited sentence inline (it wraps; it never truncates).

### 5.9 Copy and its lint

- **Every Qwen string** lives in `QwenCopy.swift` and `AskCopy.swift` (app, Q) or `RefusalCopy.swift` (pure, Q). Placeholders are typed (`{n}`, `{scope}`, `{date chip}`); no copy carries a hard-coded measurement.
- **`CopyLintTests`** (N0's harness; Q owns the Qwen rules) fail the build on:
  - the words *verified, confirmed, fact-checked, proven, accurate* anywhere in app copy;
  - SPEC's mental-state verbs and the **verb forms** of rule 24's lists (*evolved, shifted, became, turned into, led to, influenced, first used, began, coined, born, meaning changed*) in any app-authored sentence. Allowed: the noun *shift*, which names the measure ("estimated shift in usage contexts" and its caveats, §3.7, §3.13); the fixed negation "Not influence, ancestry or intent" (§3.8); the withheld notes of rule 24;
  - a machine card view without the rule-27 footer (a UI test scans the rendered hierarchy, `QwenUITests`);
  - "the corpus" in any machine-reading copy (rule 28);
  - American spellings in the Qwen copy files.

### 5.10 The "Qwen on this iPhone" screen (M1a; the bring-up builds it)

- **Where:** Settings → On-device model → **Qwen on this iPhone**, and the launch argument `-qwen-demo`. A diagnostics screen, not part of the Scroll.
- **What it shows:** the model files and sha8s; load times; available memory and footprint before, during and after each model; the S-rows of §6.4 with PASS / FAIL / PENDING_DEVICE and their numbers; and a live runtime demonstration on ≈ 60 bundled public-domain passages containing *bank*.
- **Honesty of the demonstration.** It forces k = 2 on ≈ 60 passages and applies no gate, so it is **not** the app's grouping method (§3.3 needs ≥ 60 fitted occurrences from ≥ 5 documents and rule_v2). Its header reads (exact): *"Runtime check: two groups forced (k = 2) on 60 passages, with no reliability test. This shows that Qwen runs on this iPhone; it is not how Scrolls finds context groups."* Its labels are machine cards with the rule-27 footer, and the bring-up's line *"machine reading (Qwen3-4B, on this iPhone) — not evidence"*.
- **Outputs:** `Documents/qwen-selftest.json` (`-selftest qwen`) and `Documents/qwen-demo.png`, pulled to `Native/Reports/qwen-bringup/`.

---

## 6. Evaluation

### 6.1 Deterministic differential tests (kept)

- **The tier list is §1.3.** C0, G1, G2, G3 (read path and Compare's exact panels), G5, G6 (evidence and user tables), G7 and G8 stay exactly as IOS-SPEC §2 defines them. G4 is gone. Compare's `clusters`, `measures` and `tone` fields are masked in G3 and G7, because the reference computes them with methods that no longer exist.
- **A SKIP is never a PASS.** The four private families (`g2.cipher-slice-*`, `g2.demo-fts`, `g3.read-m1r`) SKIP on this Mac today; I-1c-0 generates them (`Tools/golden.sh` into `~/Developer/scrolls-golden/<ref>/private/`) before M1c can pass.
- **New deterministic tests** (exact, no model in the loop): `SamplePlanner` (seeded allocation, ≤ 3 per document, resumable Read all), `ContextWindow` (UTF-16 spans, clipping, Devanagari and Gujarati clusters), `PrefillPlan` (256 / 128 / cap), `ModelAdmission` (the double-count regression: with the 4B resident and 1.6 GB available, a 256 MB engine job is admitted), spherical k-means invariant to input order, `rule_v2` decisions on recorded vectors, log-odds distinctive words, concentration enrichment, the stratified selector, the Verifier, `QuestionRouter`.
- **`check.sh` stages:** `quick --wp Q` builds and tests `ScrollsQwen` (MLX-free) and runs Q3/Q4 on recorded vectors and outputs; `qwen` (Q) adds `Tools/check.d/qwen.sh`: `xcodebuild test` of `ScrollsQwenKit` on the Mac (Q1, Q2); `full` includes `qwen`; `device qwen` and `device qwen-soak` are new device suites (`device-check.sh`, N0).

### 6.2 The Q tiers

| Tier | Where | Pass when (thresholds from the labs) |
|---|---|---|
| **Q1 runtime parity** | `qwen` stage: `xcodebuild test` of ScrollsQwenKit on the Mac; S6 on the device | Swift embedder against the Python MLX reference (`Tools/qwen-ref.py`, the `cipher-llm` venv, no new installs) on 200 fixture windows (`Golden/qwen/windows.jsonl`: public-domain and demo text only): **min cos ≥ 0.999** with the same batch plan, right padding, last-token pooling and no LayerNorm. The reference reproduces the model card within 0.006 (lab §1.1). The 4B, unconstrained greedy, on 20 prompts against mlx-lm: ≥ 18 of 20 token-identical; each difference recorded with its first divergent token (this checks the chat template and tokenizer, not quality). |
| **Q2 determinism** | Mac and device | Same input, same batch plan → byte-identical vectors; batch 8 against batch 4 → cos ≥ 0.999; the same label request twice, and again after a relaunch → identical bytes (lab: 6 of 6 on the Mac, §3.3). |
| **Q3 truth** | `swift test` on recorded vectors (`Golden/qwen/recorded/`), `qwen-test` live, and the device | *carry the zero*: gate ok, **k = 4, ARI ≥ 0.8** against the planted senses (lab: 72 of 72 chose k = 4; ARI min 0.974, median 0.992). *flux up*: **ARI ≥ 0.8 against the 3 planted uses** (crew, teams, soldering); the 4-class ARI is recorded as information (lab 0.673–0.705) (ΔQ-16; the 3-class value is **not yet computed**: LQ-6 computes it from the cached vectors before this threshold freezes). ◉ *kiln eye* Compare gated `insufficient_occurrences`. **The lab's rule_v2 decisions are reproduced in Swift** from the cached vectors (`~/Developer/scrolls-lab-senses/cache`, exported as f16 256-d with occurrence ids, no text): *bank*, *charge* ×2, *current* ×2 ok; *cell* ×2, *plant* ×2, *key* ×2, *spring*/literature gated (lab §1.5). **Pseudo-words** (LQ-1, LQ-2), recorded per key: mean ARI ≥ 0.302 on Cipher and ≥ 0.502 on STEMM text, lowest pair ≥ 0.13 and ≥ 0.23 (PPMI-SVD 1.1.0); until they pass, the provisional note stays on every group card. *bank* on the device (M1c): gate ok, k = 2, **silver ARI ≥ 0.90** against `Golden/qwen/silver-bank.json` (the lab's silver labels: 274 of 600; lab 0.942 at ±32 Qwen tokens, 0.872 at ±64; LQ-3 records the ±24-word value). |
| **Q4 honesty** | `swift test` (`ScrollsQwenTests`, pure) and `QwenUITests` (RecordedRuntime) | Adversarial Verifier cases, each expecting a named disposition: invented `P`-ids; a quote one character off; **the lab's stitched quote** (dropped); a case-only difference (kept, rendered from the atlas); digits from each script (ASCII, ०–९, ૦–૯, ０–９); *two hundred*, *the nineteenth century*, *the eighteen-eighties*, *the 1880s*, *XVII*, *p. xvii* (dropped unless a cited slot covers the period); *mix* and *mid* (kept); every rule-24 word (withheld); a one-sided comparison (dropped); `answerable: false`. **Retrieval:** the lab's three index lines ("Germ theory, 51, 98", "Horse Virus Vindicated, xvii", "Bank-cress, 327") are never selected; a strand with two gate-ok groups always gets ≥ 1 passage from each; 2 passages from 1 document → refusal (b) with **zero runtime calls** (a spy runtime); "what does *bank* mean" routes to the group card. **Prompts:** a gated value never reaches a prompt; no schema has `kind`; the label output cap is ≥ 160; `PrefillPlan.step` is passed on every request. **Store:** no machine reading can create a `documented` or `computed` relationship (DDL + service); `q_output` rejects UPDATE and DELETE; exports carry `machine_reading`. **UI:** no "verified"; every machine card has its footer; `-qwen off` hides every surface. |
| **Q5 lifecycle** | device: `-selftest qwen` (S7), `-selftest qwen-soak` (§6.4) | Cancel acknowledged ≤ 500 ms between embedding batches, between prefill chunks and per token; background → every model unloaded and the footprint ≤ the pre-load baseline + 300 MB; memory warning → unload; `-fakeThermal 3` → stop and unload; no new prefill chunk starts while `InteractionSignal.interacting`. |
| **Q6 evaluation** | `EVAL.md`, through the Swift guided path (§6.3) | the label set and the Ask set, with his judgements; stance κ (LAB-11) and tone κ (LAB-13) at M3. |

### 6.3 The Qwen evaluation set, through the Swift guided path

The lab ran **without a grammar** (free JSON from mlx-lm), and its judgements are the lab agent's. Nothing from it is quoted as the app's quality. Every figure below is re-measured through `GuidedRun` (XGrammar), either on the device (`-selftest qwen-eval`, which writes `Documents/qwen-eval.json`) or on the Mac by `ScrollsQwenKit`'s macOS eval test (task Q-8) over a `cp -c` clone of m5r. Results and his verdicts go into `Native/Docs/EVAL.md`.

**Labels** (the ≈ 20 of §8 decision 3):

| Source | Groups | Where |
|---|---|---|
| *carry the zero* (demo) | 4 | device (M1b) |
| *bank* (Cipher literature) | 2 | device (M1c) |
| *current*, *charge* (Cipher literature) | 2 + 5 | device (M1c) |
| *current*, *charge* (STEMM text) | 3 + 4 | Mac, Swift guided path (STEMM is not on the phone before M3) |
| **total** | **20** | — |

| Measure | Bar | Lab reference (no grammar; lab agent's judgement) |
|---|---|---|
| schema-valid, `stop = accepted` at cap 160 | 20 / 20 | JSON 6/6; label a string 5/6 (V2) |
| digits or number words in label or gloss | 0 | 0 |
| withheld by rule 24 | recorded | — |
| **his verdict: acceptable / partly / wrong** | **≥ 16 acceptable and ≤ 1 wrong** turns *Label groups automatically* on (decision 3) | 12 of 14 acceptable, 1 partial, 1 wrong |

**Ask** (M2; decision 5):
- **The set:** 30 answerable and 20 unanswerable questions over Cipher and the demo. It includes the lab's 12 (A1–A12, U3–U8), the 1880s question, number baits ("In what year …", "How many …"), *why* and intent questions, "who first" questions, and the two collapse cases (*bank* in the novels, *banco* in the Spanish books).
- **Mechanical bars:** unanswerable refused ≥ 18 of 20 (by the router or the model); answerable with ≥ 1 kept claim ≥ 24 of 30; 0 digits or unmatched number phrases in shown claims; on strands with gate-ok groups, ≥ 1 passage from every group in ≥ 90% of answers; refusal (b) produced with zero model calls whenever it applies.
- **His semantic-support judgement** of every shown claim (fully / partly / not supported by its cited sentence). **Ask ships only if fully supported ≥ 80% and not supported ≤ 1 claim, and he says yes.** In the lab, 2 of 9 claims were only partly supported and passed every mechanical check (lab §3.5).

**Stance and tone (M3):** κ ≥ 0.4 against his labels on ≥ 50 passages (stance, LAB-11) and on ≥ 100 paragraphs (tone, LAB-13).

### 6.4 Device checks: the S-rows and the soak

**S-rows** (M1a; the bring-up's `-selftest qwen` and B3 session; every row records its numbers in `qwen-selftest.json` and `DEVICE-RUNS.md`):

| Row | What | Pass |
|---|---|---|
| **S1** build | the app with ScrollsQwenKit builds for the device and installs; build time; signing; the `increased-memory-limit` outcome | installed; the entitlement outcome recorded |
| **S2** models | pushed with `devicectl device copy to`, MB/s; sha256 of every file against the pushed manifest on the phone; `bm25` on the contentless `passage_fts` | the 2 shipped models match (a pushed 4-bit DWQ embedder is recorded and never used); bm25 answered |
| **S3** memory | `os_proc_available_memory()` and `phys_footprint` at launch with Scrolls' engine open; `BGTaskScheduler.supportedResources` (`.gpu`?) | recorded; `QwenBudgets.current(probe:)` replaces the provisional values of §2.5 |
| **S4** speed | embedder: load s, R1 windows/s at batch 4, 8 and 16 (64 windows each), peak footprint; 4B: load s, prefill tok/s at ≈ 550 tokens and at 1,024 tokens with step 256, decode tok/s, peak footprint; cold and after 5 min | recorded; ETAs and timing copy switch to these rates; **if the 4B peak footprint at 1,024 tokens leaves < 300 MB of headroom, the prompt cap drops to 768** (lead) |
| **S5** generation | `label@1` guided round trip; grammar compile ms; the same label twice → identical bytes; `\p{Nd}` accepted by XGrammar or the generated class used; **the 1880s question** (rule 22) | schema-valid; identical; no digit in any free-text field; the guard ran |
| **S6** parity | 40 of the 200 fixture windows embedded on the phone against the Python vectors | min cos ≥ 0.999 (same batch plan) |
| **S7** lifecycle | cancel during embedding, prefill and decode; background unload; the memory-warning handler (the self-test posts `UIApplication.didReceiveMemoryWarningNotification`); `-fakeThermal 2` and `3` | Q5's bars |
| **S8** interaction | a 10 s scripted pan of the Scroll while embedding at batch 4, then with a prefill chunk in flight | hitch counts recorded against IOS-SPEC §5's pan row; if exceeded, embedding pauses whenever the Scroll is visible (`YieldPolicy`, lead) |

**The soak** (`-selftest qwen-soak`, M1d 20 min and M4 60 min; AttentionMachine's `DeviceStabilityCheck` pattern; critique P1-18):
- **Work:** read and label *bank*, *current* and *spring* (Cipher literature; *spring* exercises the gate) in a loop, with a scripted pan every 60 s and a background/foreground cycle every 5 min.
- **Heartbeat:** `Documents/Diagnostics/qwen-soak-heartbeat.jsonl` every 2 s: time, footprint, available memory, thermal state, resident model, current job, last batch or chunk.
- **Classification after the run:** the JetsamEvent and crash reports of the period are pulled (Xcode's device logs, or `devicectl` where it can reach them) and every termination is classed as **jetsam** (a JetsamEvent naming `com.utkarsh.scrolls`, with its reason), **crash** (a crash report), **watchdog** (`0x8badf00d`), **detach** (a debugger or `devicectl` session ended: logged by the harness with its time) or **unknown** (the heartbeat stops with no report).
- **Pass:** 0 jetsam, 0 crash, 0 watchdog. An unknown termination blocks the pass until it is explained. **"Signal 9" alone is never classed as memory**: one of AttentionMachine's two came before any model load (Q-02).
- **Recorded:** peak footprint per model, time resident, unload count by reason, thermal time-in-state.

---

## 7. Build plan

### 7.1 Packages and exclusive file ownership

Additions and changes to IOS-SPEC §8.1. **Every other file keeps its owner, and no file has two owners.** Files the bring-up (I) creates during M1a pass to Q at the hand-over (§7.3); project and manifest edits it makes pass to N0.

```
Native/
├─ project.yml ...................................................... [N0]  + ScrollsQwenKit (path), mlx-swift 0.32.3, mlx-swift-lm 3.32.3,
│                                                                           swift-transformers 1.3.0, swift-collections 1.5.0 (exactVersion; first written by B2)
├─ Tools/build.sh, check.sh, device-check.sh, golden.sh ............. [N0]  + SCROLLS_BUILD_DIR default ~/Developer/scrolls-build/default (N0-Q0);
│                                                                           + modes qwen-test, qwen-eval; + suites qwen, qwen-soak
├─ Tools/models.sh, qwen-ref.py, check.d/qwen.sh .................... [Q]   push + verify models; the Python reference; the qwen stage
├─ Tools/check.d/soak.sh ............................................ [I]   pulls the heartbeat and device logs, classifies terminations
├─ Golden/qwen/ (MANIFEST.json, windows.jsonl, ref-vectors, recorded/, silver-bank.json, eval/) [Q]  no licensed text; vectors and ids only for Cipher
├─ ScrollsKit/Package.swift ......................................... [N0]  + ScrollsQwen target and ScrollsQwenTests (first written by B2)
├─ ScrollsKit/Sources/
│  ├─ ScrollsCore/QwenVocab.swift ................................... [N0]
│  ├─ ScrollsStore/Qwen/** · Resources/qwen-profile.sql · Atlas/Memory.swift (+ reserveModel) · Journal/JournalTypes.swift (+ machineRun) [N0]
│  ├─ ScrollsContracts/Qwen/** · ScrollsService/AtlasQwen.swift · ScrollsService/TaskRegistry.swift [N0]
│  ├─ ScrollsQwen/** ................................................ [Q]   (first files by B2)
│  ├─ ScrollsAnalysis/{Groups,Assign,Concentration,Shift,Edges}/** · Tasks/Q{Groups,Assign,Shift,Edges}Task.swift [N4]
│  ├─ ScrollsService/LiveAtlas+Clusters.swift ....................... [N4]
│  ├─ ScrollsService/LiveQwen{,+Models,+Read,+Label,+Explain,+Ask}.swift [Q]
│  ├─ ScrollsService/Pipelines/AdapterLoad.swift (DemoLoadTask) ..... [N2]
│  ├─ ScrollsProvenance/** (demo human layer, deferred rename, machineRun replay at M2, ViewCutoffResolver) [N6]
│  ├─ ScrollsQuery/**/ClusterLanes*.swift (estimated and not-split bins) [N3]
│  ├─ ScrollsScrollModel/**, ScrollsRender/** (lane chips, bins, InteractionSignal feed) [N7]
│  └─ ScrollsNL/** .................................................. deleted at M2 [N4, with N0's manifest change]
├─ ScrollsKit/Tests/ScrollsQwenTests/** [Q] · ScrollsAnalysisTests/{Groups,Concentration,Shift}* [N4]
├─ ScrollsQwenKit/ (Package.swift, Sources/ScrollsQwenRuntime/**, Tests/**; Sources/scrolls-qwen/** at M2) [Q; created by B2]
├─ Scrolls/Qwen/** (QwenHost, QwenProbeView, ModelSettingsView, QwenStatusModel, MachineReadingCard, MachineBadge, QwenCopy) [Q]
├─ Scrolls/Diagnostics/Steps/QSteps.swift ........................... [Q]   the suites qwen, qwen-eval, qwen-soak
├─ Scrolls/Diagnostics/{DiagnosticsView,SelfTestRunner}.swift ....... [N0]  + the "Qwen on this iPhone" entry and the suite registrations (B2's edits pass to N0)
├─ Scrolls/Ask/{AskPanel,AskModel,AskCopy}.swift .................... [Q; M2]
├─ Scrolls/Inspector/{SheetMode,GroupCard,ThenColumn}.swift (.groupCard, .ask; the Then row) [N8]
├─ Scrolls/Tour/{TourCopy,YourTurnView}.swift (step 5 phone copy, DV-Q1; the Your-turn chip; step 11 at M4) [N8]
├─ Scrolls/{Lanes/LanesSheet, Shell/TopBar, Shell/StrandChips, Settings/SettingsSheet, Settings/HowItWorks, Legend/LegendSheet}.swift [N8]
│                                                                           the entry points: Context groups (Qwen), the status-chip slot, the Settings row
│                                                                           to Q's ModelSettingsView, How Scrolls works 06/07, the Legend rows
├─ Scrolls/Compare/** (panels 6, 7, 7½; 8 at M3) .................... [N4]
├─ Scrolls/Notebook/** (machine section, Make it mine) .............. [N6; M2]
├─ Scrolls/Scroll/** ................................................ [N7]
├─ ScrollsAppTests/QwenUITests.swift [Q] · ScrollsUITests/FirstMinuteTests.swift [N8]
├─ Reports/qwen-bringup/** [I] · Reports/qwen-lab/** and its scripts [LQ] · Reports/progress/<task>.json [the task's owner]
└─ Docs/status/{Q,LQ}.md, Docs/{QWEN,EVAL}.md ....................... placeholders (§9)
```

- **The MLX import rule** (§2.1) applies to the bring-up's files too: a Diagnostics view that imports MLX moves into `Scrolls/Qwen/` or talks to `QwenRuntime` (Q-0).
- **Only Q and I build MLX.** Every other package builds against `RecordedRuntime` and never waits for an MLX compile.

### 7.2 Task rules (sessions end without warning)

1. **Short tasks.** Each task is ≤ 45 min of work. A task that will not fit splits itself (Q-3 → Q-3a, Q-3b) and records the split before continuing.
2. **A status row before and after.** In `Native/Docs/status/<pkg>.md`, before starting: *"2026-10-14 10:02 · N4-Q1 · started · resume: <command> · progress: Reports/progress/N4-Q1.json"*; after: *"… · done · evidence: <files> · commit <sha>"*, or *"… · blocked: <reason>"*.
3. **A progress file.** `Native/Reports/progress/<task>.json`: `{task, owner, milestone, started, build_dir, steps: [{name, state, evidence}], next, resume, status, blockers, commit}`. It is updated **before** every command longer than 2 min, so a reboot loses at most that command.
4. **A WIP commit at every boundary,** of the task's own paths only: `git -C "/path/to/developer/Documents/AI Stuff/Scrolls" add -- <owned paths> && git -C … commit -m "WIP <task>: <what>" -- <owned paths>`, ending with the attribution line. Never `add -A` while other agents run.
5. **Persistent build directories:** `SCROLLS_BUILD_DIR=$HOME/Developer/scrolls-build/<task-or-agent>`; xcodebuild uses `-derivedDataPath $SCROLLS_BUILD_DIR/dd`. Never `$TMPDIR`, never inside `~/Documents`.
6. **Long jobs resume from done-markers:** packs (by inputs key), phase B, the pseudo-word runs, the soak, Read all.
7. **One device operation at a time.** Before any install or launch: `pgrep -f "build.sh install"` and the lock `~/Developer/scrolls-build/.device.lock` (holder, task, started). A held lock means wait or record `PENDING_DEVICE`; **a pending row is never PASS**.
8. **IOS-SPEC §8.2 still holds:** one owner per file; contract changes through N0, additively; agents create no `.md` files; quick stays green; goldens regenerated only by N0 or I; SPEC §13 and §4 here bind every package.

### 7.3 Milestones: a working app on his phone at every one

| Milestone | What is on his phone at the end | Packages |
|---|---|---|
| **M0Q = M1a: Qwen on this iPhone** (in progress) | the current app, then the app with ScrollsQwenKit; the models pushed and verified; "Qwen on this iPhone" with S1–S8 | I (bring-up B1–B3), then Q-0 |
| **M1b: *carry the zero*, computed live** | context groups and Qwen labels for the demo strand, computed on the phone; the group card; the Then row | N0, Q, N2, N4, N6, N7, N8, I |
| **M1c: *bank* on Cipher** | Cipher full text; search, strand, passage at exact offsets; a first look, groups (or an honest gate) and labels for *bank*; his ≈ 20 labels judged | N2, N3, N4, Q, N8, I |
| **M1d: soak and gates** | the same app after a classified 20-min soak; budgets from the device; `native-M1` tagged | I, Q |
| **M2: Compare, Ask, views, import** | Compare with panels 6–7½; Ask (if decision 5); saved views with pinned machine runs; replay; import; prebuilt demo runs | all but N5 |
| **M3: full corpus, lineage, Qwen edges** | STEMM on the phone; lineage; similar-usage edges; Now's reuse reading; Next drafts; tone and stance behind their gates | all |
| **M4: polish and handoff** | the full tour; the constellation; audits; a 60-min soak; HANDOFF | all, I-M4 |

#### M0Q / M1a: Qwen on this iPhone (the bring-up; in progress)

| Task | Owner | State (23:40) | Done when |
|---|---|---|---|
| B1 make the tree build | I | **done** (`a27c498`) | sim build passes; quick green except the 8 recorded test issues |
| L-1 install the current app on the phone | lead | **running** (`~/Developer/scrolls-build/device`, 23:25) | installed; he can open it; the demo paints |
| B2 ScrollsQwen (pure) + ScrollsQwenKit + "Qwen on this iPhone" + `-selftest qwen` | I (bring-up) | **running** (started 23:25) | `swift test` of ScrollsQwen green; S6 on the Mac (cos ≥ 0.999, 200 windows); the screen in the simulator (`Reports/qwen-bringup/b2-sim.png`); committed |
| B3 the Qwen device session | I (bring-up) | waits for L-1 and B2 | S1–S8 recorded (PASS / FAIL with numbers, or PENDING_DEVICE); app and models left installed; DEVICE-RUNS and the "M0Q Qwen bring-up" section of VERIFICATION written |
| N0-T1 fix the 3 ScrollsJobsTests timing failures; N6-T1 fix the 5 ScrollsProvenanceTests failures | N0; N6 | open | quick fully green |
| **Q-0 hand-over and alignment** | Q | after B3 | the table below resolved; `status/Q.md` lists every remaining difference; `QWEN.md` records the device budgets from S3/S4 |

**Exit M1a:** S1–S7 PASS on the device (S8 recorded), the models installed and verified, he has opened "Qwen on this iPhone", and the device budgets are in `QWEN.md`.

**Alignment with the bring-up** (known at 23:40 from its brief; Q-0 resolves each and records the result in `status/Q.md`):

| The bring-up builds | This spec | Resolution |
|---|---|---|
| `ModelStore` (files + sha verification) | `ModelCatalog` + `ModelVerify` (§2.2) | rename or wrap at Q-0; no behaviour change |
| `QwenEmbedder`, `QwenGenerator` | `Embedder`, `Generator`, confined to `ModelManager.with…` (§2.3) | wrap at Q-0; the generator's prefill step becomes a required argument (P0-1) if it is not already |
| `QwenMemoryGuard`: one model resident; unloads on background, memory warning and thermal **serious**; 16 MB allocator cache | `ModelManager` + `ResidencyPolicy`; serious restricts, **critical** unloads (§2.6); cache 16 MB embedder / 64 MB 4B (est.) | keep the guard's stricter serious-unload until S7 and the soak have measured; changing it is a behaviour change → lead |
| models pushed to `Documents/Models/<name>/` | `Documents/Inbox/Models/` → verified → `Library/Application Support/Models/<name>@<sha8>/`, excluded from backup (§2.10) | **behaviour change, required at M1b:** 2.9 GB in Documents enters his device backups. Q-0 treats `Documents/Models` as the inbox and moves verified models out; `models.sh push` targets the inbox |
| `-selftest qwen` → `Documents/qwen-selftest.json`; `-qwen-demo` → `Documents/qwen-demo.png` | `QwenProbe` → `qwen-probe.json` (§2.3) | **keep the bring-up's names**; `QwenProbeReport` becomes the schema of `qwen-selftest.json` at Q-0; `device-check.sh` learns the suite `qwen` |
| the *bank* demo: k = 2 forced on ≈ 60 passages | groups only through §3.3 | kept as a diagnostics probe with §5.10's header; never on the Scroll |
| guided JSON if MLXGuidedGeneration builds, otherwise parse-then-validate | `GuidedRun` only (§2.3) | if B2 lands parse-then-validate, §8 decision 9 applies: labels may run, Ask stays off |
| a label schema + validator in the pure target | `Schemas` + `Verifier` (§2.4, §4) | Q-3 replaces it with `label@1` and the full Verifier |

#### M1b: *carry the zero*, computed live (no Cipher packs)

Tasks (each ≤ 45 min; dependencies in brackets):

| Task | Owner | What |
|---|---|---|
| N0-Q0 | N0 | `build.sh`/`check.sh` default `SCROLLS_BUILD_DIR` → `~/Developer/scrolls-build/default`; xcodebuild `-derivedDataPath`; the device lock (§7.2) |
| N0-Q1a | N0 | `QwenVocab`; `RepresentationKey`, `VectorCodec`, `QwenSQL`; `qwen-profile.sql` with RowIDPolicy and dump-spec rows |
| N0-Q1b | N0 | `MemoryBudget.reserveModel` + `ModelReservation` (the double-count fix, with its regression test); `JournalOp.machineRun` (append only) |
| N0-Q1c | N0 | `AtlasQwen` and the Q1 contract types (§2.9); `AtlasService.events.qwen` |
| N0-Q1d | N0 | `TaskRegistry`: `qvec`, `qgroups`, `qassign`, `qlabel`; `mapped["cluster"] = "qgroups"`; `retired`; the lint rules of §2.1 |
| Q-0 | Q | the hand-over and alignment (above) [B3] |
| Q-1 | Q | `SamplePlanner`, `ContextWindow`, `EmbeddingTemplate`, `BatchPlan`, `PrefillPlan`, `ModelAdmission` + tests [N0-Q1a, N0-Q1b] |
| Q-2 | Q | `ReadContextsTask` (`qvec`), `LiveQwen+Read`, the vector cache, rate events [Q-1, N0-Q1d] |
| Q-3a / Q-3b | Q | `label@1` prompt and schema, `Verifier` (rules 20–25), `NumberGuard`, `ForbiddenWording`; then `qlabel` and `LiveQwen+Label` [N0-Q1c] |
| Q-4 | Q | `QwenHost`, `QwenStatusModel`, `ModelSettingsView`, `MachineReadingCard`, `MachineBadge`, `QwenCopy` [Q-0] |
| Q-5 | Q | `RecordedRuntime` fixtures recorded on the device for the demo (for the simulator and UI tests) [B3] |
| N4-Q1 | N4 | spherical k-means, the reference cloud, stability, rule_v2, `GateThresholds.forKey`; Q3 on the exported lab vectors [N0-Q1a] |
| N4-Q2 | N4 | distinctive words (log-odds), concentration flags, `QGroupsTask`, `LiveAtlas+Clusters` [N4-Q1] |
| N2-1 | N2 | `DemoLoadTask` applies tracking and the pipeline runs (`cluster` → `qgroups`) instead of reporting them pending |
| N6-1 | N6 | the demo's human layer (Reader A/B reviews and revisions); the deferred rename re-targeted by anchors; `DemoRenameTests` |
| N7-Q1 | N7 | estimated and not-split bins; machine glyph on lane chips; `InteractionSignal` fed from the Scroll |
| N8-Q1a | N8 | `.groupCard`; the Then context-group row; the Lanes menu item **Context groups (Qwen)** |
| N8-Q1b | N8 | the status-chip slot in TopBar; the Settings row to `ModelSettingsView`; How Scrolls works 06/07; the Legend rows; tour step 5 (DV-Q1); the M1b Your-turn chip |
| I-1b | I | the device session |

**Exit M1b (on the device, with the models installed):**
1. The demo paints in ≤ 1.0 s with the coach marks; no model loads in the first 60 s; the tour's tracking and Reader A/B layer are applied (nothing "pending").
2. Lanes → Context groups on *carry the zero*: Qwen reads all 340 with a live rate and **Cancel** ≤ 500 ms → `qgroups` fits the capped population (≤ 3 per document) and assigns the rest → gate ok, **k = 4, ARI ≥ 0.8 over all 340** against the planted senses, on the phone's own vectors (Q3) → the computed words at once. (The lab's demo runs fitted all 340 uncapped; if the capped fit misses the bar, that is a finding for the lead, not a reason to drop the cap.)
3. **Label 4 groups:** one call each, cap 160, `stop = accepted` 4 of 4, nothing shown before the Verifier; times recorded against the estimate (7–18 s per group plus a 3–8 s load).
4. The group card in §5.2's order, with engine-chosen members.
5. Rename a group → both machine labels stay visible; the deferred rename lands on the hip-hop group.
6. Background → models unloaded, footprint rule.
7. **Gates:** quick green (ScrollsQwenTests Q4; Groups Q3 on recorded vectors); `app` stage green with `RecordedRuntime`; the first-minute UI test passes.

#### M1c: *bank* on Cipher

| Task | Owner | What |
|---|---|---|
| I-1c-0 | I | generate the private golden families on this Mac (`golden.sh`) so G2 Cipher slice and G3 m1r stop SKIPping |
| N2-2 | N2 | `packs.sh cipher-text` (Mac, resumable by inputs key), then bundle or push |
| N2-3 | N2 | phase B on the phone: within its bound, survives a kill (resumable) |
| N3-1 | N3 | G3 on m1r green (the read gate) |
| N3-Q1 | N3 | `ClusterLanes` with estimated bins, the not-split lane, the titles and non-English lanes; exports mark `machine_reading` |
| N4-Q3 | N4 | `QAssignTask` (`qassign`); Read all only assigns; *Regroup with everything read* |
| Q-6 | Q | Read all (opt-in, cap 5,000 per scope, resumable, live ETA) and **Read this occurrence** [N4-Q3] |
| Q-7 | Q | `-selftest qwen-eval` on the device and `EVAL.md`'s label table |
| Q-8 | Q | the macOS eval test in `ScrollsQwenKit` over a clone of m5r (the 7 STEMM labels) |
| LQ-3 | LQ | the R1 key's window on *bank* and the 13 runs (must finish before the key freezes) |
| I-1c | I | the device session, with his ≈ 20 labels |

**Exit M1c (on the device, from a fresh install with the models pushed):**
1. Phase A ≤ 60 s → **Switch to Cipher**; phase B completes within its bound and survives a kill.
2. Search *bank* (and *shunya* → शून्य/શૂન્ય) → strand → honest bars, shelves, coverage and the seam; tap a mark → the passage at exact offsets (20 of 20).
3. Context groups for *bank*: a first look (≤ 600) with the live rate and ETA → **gate ok, k = 2, silver ARI ≥ 0.90**, or an honest gate recorded as a finding for the lab (never hidden).
4. Labels for both groups within 60 s of the groups, the load included (est. 17–44 s).
5. Rename → force quit → relaunch: lanes, labels and rename restored identically. No journal replay is needed; the `machineRun` ops are present in the journal dump.
6. **Read this occurrence** from Then, with the residency-dependent copy.
7. **His ≈ 20 labels judged** (§6.3) and recorded in `EVAL.md`; decision 3 taken.
8. **Gates:** C0, G1, G2 (mini, ingest, demo, Cipher slice, boilerplate), **G3 on m1r**, G5, G8, Q1–Q4; quick and `qwen` green.

#### M1d: soak and gates

| Task | Owner | What |
|---|---|---|
| Q-9 | Q | `-selftest qwen-soak` (heartbeat, scripted work) |
| I-1d-1 | I | `Tools/check.d/soak.sh`: pull the heartbeat and device logs, classify every termination |
| I-1d-2 | I | the 20-min soak on the device; S8 re-run with the real Scroll |
| I-1d-3 | I | VERIFICATION M1 section; `QWEN.md` budgets as measured; tag `native-M1` |

**Exit M1d:** the soak passes (§6.4: 0 jetsam, 0 crash, 0 watchdog, no unexplained termination); every §2.5 budget carries a device value; `native-M1` tagged.

#### M2, M3, M4

| Milestone | Packages and work | Exit (device rows need him) |
|---|---|---|
| **M2: Compare, Ask, views, import** | N4 (Compare panels 6, 7, 7½; `qshift`; `ScrollsNL` deleted); Q (`qexplain`; Ask with `StratifiedRetrieval`, `QuestionRouter`, refusals; the macOS `scrolls-qwen` CLI; prebuilt demo runs as a JSON resource with the 40-window parity check); N6 (`machineRun` replay; views as-saved pinning Qwen runs; the Notebook's machine layer; Make it mine); N1 (import routes and wizard); N3 (exports); N8 (Ask entry) | Compare on the phone (coverage first, frequency with CIs, collocates, gates, groups, shift with its caveats, the machine reading on tap); **Ask on *bank* and *carry the zero* only if decision 5 says so**; save a view → force quit → reopen identical, machine readings included; `letters.csv` imports with exact counts; exports flag machine readings. Gates: G3 Compare exact on m1r, G7 on m1r, Q1–Q6. The 2,048-token path only if S3/S4 showed the headroom. |
| **M3: full corpus, lineage, Qwen edges** | N2 (STEMM pack, generations, swap); N5 (reuse index, lineage UI); N4 (`qedges`, tone); Q (`qreuse`, `qdraft`, `qtone`, `qstance`, `qallusion`; Read all under `BGContinuedProcessingTask` only if S3 found `.gpu` and he opts in); LQ-8 (non-English) | STEMM on the phone; G2 STEMM slice; G3 on m5r; G6 evidence phone = Mac; D17 across a load, a swap and a restore, **including machine readings replayed from the journal**; *Funky Drummer* 32/98/48; similar-usage edges hidden by default; Now's reuse reading; Next drafts; tone only after LAB-13; stance only after LAB-11 and his opt-in. |
| **M4: polish and handoff** | all, I-M4 | the full tour with step 11; the constellation (ΔQ-13); accessibility audits including machine cards and the Ask panel; every budget measured on the device; the 60-min soak; HANDOFF: what needs the models, what is machine output, which fine senses the gate hides, what is unfinished. |

### 7.4 LQ: the lab's follow-ups (Mac, resumable)

Each runs from `Native/Reports/qwen-lab/*-scripts/`, resumes from the done-markers in its `.jsonl`, needs no download, and logs in `status/LQ.md`. Results are appended to QWEN-LAB.md §6 by its owner.

| Task | Script | Decides | Needed by |
|---|---|---|---|
| LQ-1 | `run_pseudo.py scope=cipher-en gatecal=1` | the gate's calibration and Qwen against PPMI-SVD on Cipher (≥ 0.302, lowest ≥ 0.13) | the "provisional" note (any time) |
| LQ-2 | `run_pseudo.py scope=stemm-en gatecal=1` | the same on STEMM text (≥ 0.502, lowest ≥ 0.23) | M3 |
| LQ-3 | `rule_v2.py` with the window argument (±24 words, instr, 256 d) on the 13 runs + *bank* silver | the R1 key: `w24w`, or `w32t` if *bank* silver < 0.92 (§3.2) | **before M1c freezes the key** |
| LQ-4 | `run_words.py` uncapped (`per_doc` unbounded), *cell* and *spring* on STEMM | whether one-book groups appear; the one-book flag's thresholds (§3.4) | M1c |
| LQ-5 | `ask.py slots2` with the fixed processor | the Python digit ban, re-run (informational; S5 is binding) | M2 |
| LQ-6 | the cached demo vectors (or a re-read of the 125 occurrences, seconds on the Mac) | *flux up*'s 3-class ARI, before Q3's ≥ 0.8 freezes | M1b |
| LQ-7 | `rule_v2.py spring:stemm-en` | the 13th rule_v2 run | M1c |
| LQ-8 | `run_words.py` for Spanish, French, Hindi and Gujarati words | lifting `language_not_evaluated` per language | M3 |
| LQ-9 | `run_r3.py` | R3/R4 representations, only if LQ-1/LQ-2 fail | if needed |

### 7.5 Order and coordination

1. **Now (M1a):** the lead's install (L-1) → B2 (running in parallel on the Mac) → B3 on the phone. In parallel and MLX-free: N0-Q0, N0-Q1a…d, N0-T1, N6-T1, and LQ-3, LQ-6 on the Mac.
2. **M1b** starts per package as soon as its N0-Q1 slice lands; Q-0 waits for B3. N4, N6, N7 and N8 work against `RecordedRuntime` and never wait for the phone.
3. **M1c** needs `cipher-text` (N2-2), the private goldens (I-1c-0) and LQ-3's window decision.
4. **Device time is a resource:** agents never block on it; I batches device rows into one session per stage (I-1b, I-1c, I-1d), plus ad-hoc sessions whenever he is available. `Reports/device-queue.json` is the queue.
5. **The lab does not hold the build.** Every LQ result lands as a one-line change in `ScrollsQwen/Policy` or as a new representation key; a gate threshold is never lowered after real words are seen.
6. **Effort (est.):** Q ≈ 6–8k lines (pure 2.5k, runtime 2k, service and tasks 1.5k, UI 1.5k) plus ≈ 1.5k of tests; N4 ≈ +2.5k against ≈ 6k of statistics never written; N0 ≈ 1–1.5k.

### 7.6 Risks

| # | Risk | Evidence · likelihood | Mitigation | If it happens |
|---|---|---|---|---|
| QR1 | Jetsam with the 4B and the engine open | Mac peaks 2.94 GB at 1k/step 256; phone footprint ≈ 3.2–3.5 GB (est.); signal 9 in AttentionMachine is unexplained · medium | one model resident; explicit prefill step; cap 1,024; admission on remaining growth; unloads; the classified soak | cap 768; labels only; a smaller generator (decision 8) |
| QR2 | `increased-memory-limit` is not granted to his signing | unknown until S1/S3 · medium | measured at S3 | generation off; groups and computed words still work (decision 8) |
| QR3 | MLXGuidedGeneration does not build (unsafe flags in a versioned dependency, or XGrammar's C++ on Xcode-beta) | AttentionMachine did not use it · medium | B2 tries it first | a local path checkout of the cached 3.32.3 (no download); else parse-then-validate (decision 9) |
| QR4 | Qwen does not beat PPMI-SVD on pseudo-words | not measured · medium | LQ-1/LQ-2 | groups labelled "experimental: below the reference method on the benchmark"; the lead decides with him |
| QR5 | Too slow on the phone | est. 10–20 windows/s, prefill 60–120 tok/s · medium | live rates; Read all opt-in; first look 600 | a smaller first look; an optional Mac vector pack (decision 10) |
| QR6 | Heat throttles long reading | never measured · medium | the thermal table; foreground only | Read all resumes later from the cache |
| QR7 | GPU contention hitches the Scroll | batches 0.4–0.8 s, prefill chunks 2–4 s (est.) · medium | batch 4 while visible; no chunk starts during interaction; S8 | pause embedding whenever the Scroll is visible |
| QR8 | The gate hides real fine senses | *key*/STEMM, *cell*/STEMM gated by rule_v2 · certain | stated in HANDOFF | decision 2 |
| QR9 | MLX build time and reboots on the loaded Mac | 871 s for one quick at load ≈ 990; two reboots tonight · high | persistent build dirs; only Q and I build MLX | `RecordedRuntime` for everyone else |
| QR10 | Model or runtime updates change readings | certain over time · low | representation keys; pinned runs; journaled outputs | old readings stay as layers |

---

## 8. Open decisions for Utkarsh (one line each; the default applies until he answers)

1. **M1 order:** Compare, saved views and import move to M2 so that Qwen groups for *carry the zero* and *bank* reach his phone first (the brief's slice puts them before clustering) — *default: yes, staged M1a–M1d.*
2. **The gate:** fewer, honest groups (rule_v2, which hides *key*'s and *cell*'s fine senses) or also an "experimental groups" view, off and labelled — *default: rule_v2 only, no experimental view.*
3. **Label groups automatically:** turn it on after he judges the ≈ 20 labels of §6.3 (bar: ≥ 16 acceptable, ≤ 1 wrong) — *default: off until then; then on if the bar is met.*
4. **Read all:** an explicit opt-in per strand, ≤ 5,000 per scope, foreground, resumable, as what "every occurrence" means on the phone — *default: yes.*
5. **Ask:** ships only on his semantic-support judgement of the 30 + 20 set (§6.3) — *default: off until he says yes.*
6. **Stance suggestions:** off unless κ ≥ 0.4 and he opts in, or "never" as IOS-SPEC said — *default: off and gated; built at M3.*
7. **Model delivery:** pushed once from the Mac, bundled in the app, or later shared with AttentionMachine and Cipher through an App Group — *default: pushed from the Mac.*
8. **If S3/S4 show too little memory for the 4B:** generation off, or Qwen3-1.7B-4bit (≈ 1 GB, a download he must approve) — *default: generation off; groups and computed words stay.*
9. **If guided generation cannot be built:** parse-then-validate with one retry plus the full Verifier, labels only — *default: yes; Ask stays off until the guided path exists.*
10. **A Mac-built vector pack** if the median first look on the phone exceeds 3 min — *default: not built; offered only after the measurement.*
11. **Languages:** context groups for English only until LQ-8 measures Spanish, French, Hindi and Gujarati — *default: yes.*
12. **"Keep Qwen3-4B loaded while Scrolls is open":** not offered; idle unload after 90 s — *default: not offered.*
13. **Tone:** Qwen tone readings at M3 only after κ ≥ 0.4 on 100 of his paragraphs (≈ 20 min of his labelling), or cut — *default: gated at M3.*
14. **Read all in the background** (`BGContinuedProcessingTask`, only if S3 finds `.gpu`) — *default: off; offered at M3.*

---

## 9. Placeholder files the lead must pre-create

Agents cannot create `.md` files. Each placeholder starts with `<!-- OWNER: <package> — <purpose> -->` and a title line (IOS-SPEC §8.9's convention). IOS-SPEC §8.9's list still holds; these are added.

| File | Owner | Purpose |
|---|---|---|
| `Native/Docs/status/Q.md` | Q | progress rows (§7.2), evidence, pending device rows, contract requests, **the alignment table with the bring-up** (§7.3) |
| `Native/Docs/status/LQ.md` | LQ | the LQ tasks: started / resume / done, with their `.jsonl` markers |
| `Native/Docs/QWEN.md` | Q | models as installed (sha256, folder, size); the prompt and schema registry with sha256s; representation keys and gate thresholds as frozen; **budgets as measured on the device**, replacing §2.5's provisional values; the Verifier's rules as built |
| `Native/Docs/EVAL.md` | Q (his verdicts entered by the lead) | the label set and the Ask set through the Swift guided path, his judgements, and decisions 3 and 5 as taken |

**Existing files that gain sections** (no new file needed): `DEVICE-RUNS.md` and `VERIFICATION.md` (I: the "M0Q Qwen bring-up" section, then M1a–M1d) · `HANDOFF.md` (I: what needs the models, what is machine output, the gated fine senses) · `QWEN-LAB.md` (qwen-lab / LQ: §6 results) · `JOURNAL.md` (N6: the `machineRun` op) · `EXPERIENCE.md` (N8: Qwen copy decisions, first-minute timings with Qwen present) · `BUILD.md` (N0: MLX build notes, build directories) · `DIFFERENTIAL.md` (N0: G4 removed, the masks, the Q tiers).

---

*Guiding principle, kept: an expression carries its past into each new encounter. Qwen adds a reader from the present. Scrolls shows what that reader read, how the passages were chosen, which lines it leans on, and never lets it speak for the evidence.*
