<!-- OWNER: critic (Qwen rewrite, 2026-10-13). Replaces the lead's placeholder. An adversarial critique of Docs/ios-proposals/qwen-rewrite.md against the finished lab (Native/Reports/qwen-lab/*), IOS-SPEC §0/§1/§3/§4/§8, SPEC §13 and the code and status files on disk. The synthesiser folds §8 into Docs/IOS-SPEC-QWEN.md. -->
# Critique of the Qwen rewrite

**Verdict.** The architecture is right: one model resident at a time, a pure `ScrollsQwen` target split from the MLX runtime, machine readings as a fourth class, quotes rendered from the atlas, period slots instead of dates, immutable journaled outputs and representation keys. **About a dozen of its numbers and rules are now contradicted by the lab**, and five of them would hurt on the phone:
- the memory budgets;
- the admission arithmetic;
- the cluster gate;
- the one-call labeller;
- the Ask retrieval.

Two "evidence" claims rest on artefacts:
- "no group is one book" is forced by the sampling;
- "signal 9 means memory" is contradicted by one of the two kills.

M1 is too large for sessions that end without warning. It needs Cipher packs that have never been built, so it has to be cut into stages that land one at a time.

**Tags.** As in the draft: **(measured: where)** · **(read: file)** · **(est.)**. "Lab" means `Native/Reports/qwen-lab/<area>-summary.txt` and the `.jsonl` beside it. Every lab number is a **Mac** number (M1 Max, contended); nothing was measured on the iPhone.

---

## 1. iPhone feasibility

### 1.1 Memory: the draft's budgets against what was measured

| Draft says | Measured (lab, Mac MLX peak) | Consequence |
|---|---|---|
| 4B ≤ 3.0 GB at 2k prompts (ΔQ-4, LAB-9) | step 256: **3.126 GB at 2k** (fails), 2.938 GB at 1k. Step 128: 2.964 GB at 2k. **Step 512: 3.086 GB at 1k** (speed §2, §6) | The cap holds only with an explicit prefill step: 256 up to 1,024 tokens, 128 above. |
| "Prefill in 256-token steps" (§2.4) | mlx-swift-lm 3.32.3 defaults to **512**: `PrefillParameters.defaultStepSize = 512`, and `GuidedGenerationLoop.run(… prefill: .init(stepSize: PrefillParameters.defaultStepSize))` (read: PrefillParameters.swift, GuidedGenerationLoop.swift @3.32.3) | If the parameter is not passed, every generation runs at step 512 and breaks the budget at 1k. Make it a required argument, with a test. |
| `kvBits: 8` above 1,024 tokens (§2.4, §0.2) | Does **not** lower the peak (3.155 vs 3.126 GB at 2k): the peak is set during prefill. Prefill at 1k was also slower (75.7 tok/s, contended) (speed §2, R3) | Drop `kvBits` entirely. |
| Embedder ≤ 0.8 GB at 16 × 128, batch 16 (§2.3, LAB-9) | 8-bit: **1.537 GB** at 16 × 128; 1.594 GB at 16 × R1 windows; **1.249 GB at 8 × 64**. 4-bit: 0.895 GB at 8 × 64. The plateau is the same at batch 8 and 32 (speed §1, R2) | Batch 8. Reserve ≈ 1.3 GB for the 8-bit model (the R1 shape at batch 8 is unmeasured: est.). |
| (Ask) prompt cap 2,048, ≤ 10 passages | The generation lab's runs used Python's default single-chunk prefill and **peaked at 3.21 GB at ≤ 1,112 prompt tokens**. Six passages at ±40 words = 658–1,054 tokens (generation §2b, Part 3 item 6) | M1 needs no prompt above 1,024 tokens: a label is ≤ 577 tokens per group. Ask defaults to 6 passages at ±32 words with a 1,024 cap. The 2k path exists only if S3 shows headroom. |

**The admission rule double-counts the model (a design bug).** `MemoryBudget.reserve` admits when `os_proc_available_memory() − reservedBytes ≥ bytes + 600 MB` (read: `ScrollsStore/Atlas/Memory.swift`).
- Once the 4B's 2.26 GB of weights are resident, `os_proc_available_memory()` has already fallen by about that much, while the draft's 3.0 GB reservation is still subtracted.
- A 256 MB engine job (materialise, say) then needs about 3.86 GB available *after* the model has loaded, which means about 6.2 GB before loading.
- The draft intends "only jobs above 256 MB wait". In practice *every* engine job waits while the 4B is resident, unless the phone grants more than ≈ 6 GB.
- Before loading, the 4B itself needs ≥ 3.6 GB available, yet AttentionMachine ran the same model at a 2.662 GB footprint.

**Required:**
- A model's reservation is only its *not-yet-allocated* growth: the measured peak minus the measured resident delta, re-taken after the load.
- Thresholds are in `phys_footprint` terms and set from S3, not from Mac MLX peaks.
- The 600 MB headroom was designed for engine jobs. Restate it for models from S3.

**Mac MLX peaks are not the phone's footprint.**
- AttentionMachine's footprint peak, 2.662 GB at ≤ 95 prompt tokens, sits about 0.4 GB above the 2.265 GB of weights.
- Scrolls adds its own interactive budget (≤ 400 MB), SQLite caches and the Metal renderer.
- So the 4B labelling a 600-token group is ≈ 3.2–3.5 GB of `phys_footprint` (est.).
- S3 and S4 must measure exactly this, with Scrolls's engine open, before any budget is frozen.

### 1.2 Signal 9 is a hypothesis, not evidence of memory pressure

Q-02 and QR1 cite "two signal-9 terminations" in AttentionMachine as the reason memory is the central risk. AttentionMachine's QUALITY.md says one of the two came from a launch that "ended with signal 9 after its CPU benchmark and before its first model load" (read). The cause of both is unidentified, and AttentionMachine was built without `increased-memory-limit`.

**Required:** the soak (Q5, M1 exit 9) must **classify** every termination, not just count it:
- a heartbeat file with footprint and thermal state every 2 s;
- the device's JetsamEvent and crash reports pulled after the run (devicectl / Analytics data);
- a note whenever a debugger or `devicectl` session ended.

"No signal 9 in 20 min" is a weak bar if a kill cannot be told apart from a detach.

### 1.3 Embedding time per word on the phone

The rates are the speed lab's A17 Pro estimates (≈ 2× uncertainty): R1 windows at 10–20 windows/s, plus 2–6 s to load the embedder. **Sustained throttling was never measured.** If the GPU throttles like the CPU planning factor in IOS-SPEC §5 (0.6–0.7× after 2–3 min; an assumption), the longer rows grow by 40–70%.

| Strand | Occurrences read | Est. on the phone |
|---|---|---|
| *carry the zero* (demo, all read) | 340 | 17–34 s |
| first look, any word | 600 | 30–60 s |
| *bank*, Cipher literature, Read all | 4,309 | 3.6–7.2 min |
| typical Cipher word / typical STEMM word | 2,479 / 8,289 | 2.1–4.1 / 6.9–13.8 min |
| p90 word, all scopes | 18,580 | 15.5–31 min |
| the draft's 20,000 cap | 20,000 | 17–33 min |

The first look is a phone feature. *Read all* above ≈ 5,000 occurrences is a 10–30 minute foreground GPU job: hot, battery-hungry, and abandoned the moment he leaves the app.

**Required:**
- *Read all* is an explicit opt-in per strand, not automatic P3 work for every tracked expression.
- Its default cap is ≈ 5,000 per scope.
- It resumes across sessions from the vector cache.
- Its ETA comes from the rate measured on this phone in this session, with the thermal state shown.

### 1.4 GPU submissions are 4–40× longer than the draft assumes

The draft says one embedding batch is "≤ ≈ 100 ms" and "prefill in 256-token steps, so no single GPU submission is long" (§2.3, §2.7). At the lab's device estimates:
- one embedding batch is **0.4–0.8 s at batch 8** and 0.8–1.6 s at batch 16;
- one prefill step is **2–4 s at 256 tokens** (60–120 tok/s) and 1–2 s at 128;
- only a decode step is short (≈ 70–110 ms).

Qwen yields only at batch and prefill-chunk boundaries. A pan that starts mid-chunk therefore shares the GPU with that chunk for up to seconds.

**Required:**
- While the Scroll is on screen, embed at batch 4.
- Never *start* a prefill chunk during interaction.
- S8 measures frame hitches with a prefill chunk in flight, not only with embedding.
- Fix the "Read this occurrence (≈ 0.3 s)" copy: that holds only when the embedder is resident (≈ 0.1–0.3 s). Otherwise add 2–6 s for the load, plus a 4B unload if the 4B is resident.

### 1.5 Timings copy

The draft's LAB-6 guesses are too optimistic for the 4B (speed §5):
- prefill is 60–120 tok/s (est.), not 150–300;
- a label pass is 30–55 s, not 20–30. One call per group (§3.3 below) is ≈ 7–18 s per group (400–577 tokens in, 50–77 out) plus a 3–8 s load;
- Ask is 20–50 s.

*bank*'s two groups fit M1's "labels ≤ 60 s after the groups". A five-group word (*charge*) may not, so the exit row must name *bank*.

---

## 2. LLM honesty

### 2.1 Retrieval gives grounded but unrepresentative answers (the most serious honesty gap)

- **What the lab saw.** Ranking by cosine to the question gave only financial passages for *bank*. Yet the river group is the **larger** one in both the lab's quick clusters (137 vs 103) and the reference's PPMI run (2,256 vs 2,053). *banco* gave only "bank", while "bench" is 87 of 160 (generation §2d.1). So retrieval does not collapse onto the corpus's dominant use: it collapses onto **the modern model's default reading of the word**. That is anachronism built into the evidence selection.
- **Why the guards miss it.** Every claim was quote-verified and cited, so the verifier passes it.
- **What the draft does.** It stratifies by period only "when the question names two periods" (§3.9). It discloses "Read 12 passages of 4,309", which says nothing about *how* they were chosen.

**Required:**
1. When the strand has context groups that pass the gate, Ask (and `qexplain`) fill their slots **by group** (≥ 1 per group, in proportion otherwise) and by period/collection.
2. "What does X mean …" questions go to the **computed group card**. Generation adds only per-group glosses beside it.
3. Without groups (not read, gated, or no models), every answer carries the copy *"These passages were chosen by similarity to your question, which favours the most familiar modern use of the word; other uses may be missing."*
4. The disclosure names the selection method, not only the count.

### 2.2 Index lines, thin evidence and fabricated quotes

| Lab finding | Draft | Required |
|---|---|---|
| Index and heading lines took slots ("Germ theory, 51, 98", "Bank-cress, 327") | Groups exclude thin windows; Ask candidates have no such rule | Ask candidates go through the engine's default exclusions plus a ≥ 80-character body rule. A test uses the lab's three lines. |
| Weak evidence was answered, not refused: thin A4 got "financial institution" from one ambiguous line | Ask refuses only when nothing matches, the model says no, or no claim survives | Refuse **before generation** below ≥ 3 passages from ≥ 2 documents. A claim citing one passage is shown with "from one passage". |
| A stitched quote ("the virus communicated by Jenner himself") failed the check, yet `ask.py` kept the claim | Rule 21: the quote is removed and "the claim may stay if its citation holds" | **A hard gate.** A claim whose offered quote is not found in its cited passage is dropped. Matching is case-insensitive after NFC, quote folding and whitespace collapse. The atlas's text is rendered, never the model's. |
| Glosses beyond the passages ("conceptual starting point", "fundamental unit of life") passed every mechanical check: 2 of 9 claims were only partly supported | LAB-8 counts "≥ 1 verified claim", which is a mechanical metric | Ask ships only on **his** judgement of a semantic-support rate (fully / partly / not supported) on the 30 + 20 set. Each claim shows its cited sentence **inline**, not behind a tap, so the reader can check it. |

### 2.3 Words that let machine text pass as evidence

- **"verified".** The draft says "the verified claims" (§5.5) and "≥ 2 verified citations" for labels (M1 exit 6). Under a grammar, a label's citation is "verified" by construction: it only means *the passage was in the prompt*. Readers will take "verified" to mean fact-checked. **Never use "verified" in the UI.** Write "quote matches the passage; the reading is the model's", and in the code call these `tiedClaims`.
- **Label citations are the model's picks.** The group card's "4 cited passages" are the passages the model chose to support its label. They are not evidence that the label fits the group. The card shows the **engine's** representative members (nearest to the centre *plus* random members, so a mixture is visible), and marks the label's citations among them. The label prompt should include peripheral members too: the passages nearest the centroid hide mixture, and mixed groups got confident single labels (key G1; Hindi *kal* group 1).
- **Lane chips.** "Qwen label: financial institution" will be the most prominent text on the Scroll. The chip carries the machine glyph, and Qwen labels run only for groups that pass the gate (§3.1).

### 2.4 Dates and numbers: the digit ban leaks

1. **The ban was never exercised in Ask.** `masked_steps = 0` on all 12 runs. `ask.py` was fixed afterwards, but **no re-run is logged** in generation.jsonl. The label ban was real but never under pressure: no digit was ever the argmax.
2. **`^[^0-9]*$` covers ASCII digits only.**
   - It lets through Devanagari ०–९ and Gujarati ૦–૯ digits (the corpus has 825 such books), full-width digits and Roman numerals ("xvii" appeared as an index line).
   - It does not stop spelled-out dates and counts: "eighteen-eighties", "the nineteenth century", "two hundred".
   - A10 was literally about "nineteenth-century science books", and slots2 echoed "In the 1880s" from the question.

**Required, as defence in depth (the draft says the Verifier acts "instead" when the grammar fails; it must act *always*):**
- the grammar bans `\p{Nd}`;
- the Verifier rejects digits, number words, century and decade words and Roman numerals in every free-text field, unless the phrase matches the date slot of a cited passage;
- an adversarial device test asks the 1880s question.

### 2.5 Change, cause and mental-state wording

- **The forbidden list is too short.** Rule 24 forbids "meaning changed", "coined" and "born". `qexplain` exists to describe difference, so the Verifier also withholds: *evolved, shifted, became, turned (into), led to, because (of), influenced, first used, began*. In the lab, "first", "began" and "origin" were only caveated.
- **The first-minute chip.** The draft's *"Ask: why did 'carry the zero' turn ironic?"* (§5.8) is a *why* question about a change in meaning. The draft's own rules refuse it, or worse, it invites a causal story. Replace it with a descriptive comparison, for example *"How do the office memos use 'carry the zero' compared with the classroom primers?"*.
- **"First observed" answers.** A "when" question answered from the data is about the **word form only**. "First observed in group G" is honest only when the strand is fully read. After a first look it must say "earliest of the 600 occurrences read". *sample* (A1) shows the trap: the word long predates the sense asked about.

### 2.6 Reproducibility

- **Determinism holds only for one batch plan.** Mac greedy output was 6/6 byte-identical across two processes. Decoding is `argMax` (read: GuidedGenerationLoop.swift@3.32.3), so S5's "is it greedy" is answered. Q2's "same input twice → byte-identical vectors", however, holds only for the **same batch plan**: right padding changes tensor shapes and therefore the floating-point reductions. **Required:** byte identity per batch plan; cos ≥ 0.999 across plans. Group assignments are journaled, so a re-read never silently moves a published group.
- **The lab ran without a grammar.** Under XGrammar the output changes (forced key order, bounded strings). Re-measure label and Ask quality **through the Swift guided path** (`scrolls-qwen eval` or the device screen) before the lab's 86% / 7-of-8 figures are quoted as the app's.
- **The output cap must clear the measured outputs.** Single-group labels produced 42–77 tokens, and the draft's cap is "80 per group". `GuidedGenerationLoop.run` throws `incompleteOutput` at the cap (read). So set caps at ≥ 2× the measured maximum (labels ≥ 160 tokens). **Never pass `closingBias`.** With it, the loop bends tokens toward closing JSON from `maxTokens − completionReserve` (default 64), which turns truncated text into valid-looking JSON. MLXFoundationModels does this; Scrolls must not.
- **What the run records.** Each run records the device model, the iOS build, the XGrammar/mlx-swift-lm versions, the prefill step and the batch plan, besides the model, prompt and grammar sha256s the draft already lists.

---

## 3. Decisions that contradict the evidence

### 3.1 The cluster gate admits topic splits

The draft keeps "a stable k with mean ARI ≥ 0.6, a silhouette above the reference, and a 0.10 floor" (Q-04, §3.2). The senses lab's §4:

- **The floor does not separate anything.** At 256 dims **every** run passed the 0.10 floor, including *plant*/literature and *spring*/literature, whose margin over the no-groups reference is 0.0055.
- **Stability 0.6 admits topic splits.** In STEMM text it accepted k = 6–8 at stability 0.600–0.718. In every such run, one sense was split by **subject**: *cell* into neurology, embryology, lungs and botany; *plant* into seven botanical topics; *spring* into three season groups by genre.
- **The stricter rule on the cached vectors.** `rule_v2` takes the first k in falling-silhouette order with stability ≥ 0.8, and requires silhouette − reference ≥ 0.03 (senses.jsonl, `exp = rule_v2`, 12 runs). It:
  - **keeps** *bank* (silver ARI 0.872 at ±64), *charge* ×2 (0.463, 0.650) and *current* ×2 (0.501, 0.757);
  - **gates** *cell* ×2, *plant* ×2, *key* ×2 and *spring*/literature;
  - did not run *spring*/STEMM.

**Required:**
- Adopt `rule_v2` as the provisional gate, frozen per representation key (silhouettes run higher at 256 dims than at 1024 in 12/12 runs, so the thresholds are per key).
- Label it honestly: *set on 13 real-word runs read by one agent, not calibrated on pseudo-words*. The thresholds were read off the same words they now judge, so they are an overfit until the pseudo-word benchmark runs. `run_pseudo.py` exists and logged nothing; it is a short, resumable Mac task.
- Accept the cost and say so in HANDOFF: the finest real senses the lab saw (*key*/STEMM's machine, telegraph and taxonomic keys; *cell*/STEMM's battery and prison cells) are gated. The rewrite must not quietly lower the bar to win them back; the draft's own rule says "never lowered after real words are seen".

### 3.2 "Not one book's vocabulary" is a sampling artefact, and the real confound has no flag

- **What forced the result.** The lab sampled **at most 3 occurrences per document** (senses §0). In every group at 256 dims, the top document contributes exactly 2–3 occurrences: the top-document share equals 3/n or 2/n (for example 0.048 = 2/42 for the *spring* equinox group, and 0.009 = 3/340 for *bank*) (senses.jsonl `groups[].top_doc_share`). The finding "no group is one book" was therefore **forced by the design**. It says nothing about *Read all*, which in the draft "takes the rest in random order within cells" with **no per-document cap**: a physiology textbook with 200 *cell*s would then enter k-means with 200 votes.
- **The draft's flags.**
  - Top-document share > 0.5 can never fire on a capped fit.
  - "One collection holding > 80%" fires on **52 of the 54 groups** in the lab's runs, because each scope is essentially one collection (`top_collection_share` 0.64–1.0, above 0.8 in all but two). It is noise.
  - The model's `kind: one_source | register_or_spelling` was used sensibly **0 of 6** times (generation §1b).

**Required:**
1. **Every fit keeps the per-document cap** (≤ 3, as measured). Occurrences read beyond the cap are *assigned* to centroids, never fitted.
2. Concentration flags are computed on the **assigned** population, and expressed as **enrichment** against the strand's own mix (the group's share minus the strand's share for that document, collection or subject), not as absolute shares.
3. **A subject flag**, because subject is the confound that actually occurs: an enrichment test on `doc_tag` subjects where they exist (Gutenberg subjects, OpenAlex topics). Copy: *"This group may be one subject's vocabulary (61% of its documents are tagged Physiology, against 18% of the word's documents), not a separate use."* The same composition check feeds `qshift`: in STEMM, the subject groups differ in median year (air-cells 1858, battery 1885), so a group-share "shift" can be a change in subject mix.
4. Delete `kind` from the label schema.
5. One lab follow-up (short, Mac): re-fit two STEMM words *uncapped* to see whether one-book groups appear.

### 3.3 Other decisions the lab overturns

| Draft | Evidence | Required |
|---|---|---|
| `qlabel`: all groups in one call (`groups` array, ≤ 8) | One call per group was better: demo 3 correct + 1 partial against 2 + 1 partial + 1 wrong; real words 6/6 against 5/6. Without a grammar the label came back as an array 1–2 times in 6 (generation §1b, §1c) | One call per group (≤ 600 tokens). Schema: label is a string of ≤ 5 words, gloss a string, cites from the given ids. No `kind`. |
| R1 = the **marked** template "Represent how the marked expression is used…" | Every real-word result used the **instr** template ("Represent the meaning of the word '<w>' in this passage"). The marked style was measured only on the demo, where it was equal (senses §0, §1, §3) | R1 is the measured instr template, or the marked style is measured on *bank*, *current* and *charge* before its key is frozen. |
| LAB-1: ship 4-bit DWQ | q4 against q8: per-vector cos 0.952 (fails the draft's ≥ 0.98); not faster; demo ARI equal; *bank* silver 0.928 vs 0.942 (senses §5, speed R4) | **Ship 8-bit.** Fix the representation-key example (`qe06-q8@fe956e8d/…`). |
| LAB-4: 256 dims "within 0.02 ARI of 1024" | Not met on several words, in both directions (±0.07–0.09) | Keep 256 for storage. Drop the claim. Thresholds per key (§3.1). |
| LAB-3: ±32 Qwen tokens; hi/gu "flagged if quality drops" | Measured on *bank* only (±32 best: silver 0.942 vs 0.872 vs 0.818). At ≈ 4.75 / 8.86 tokens per word, ±32 tokens is ≈ ±7 Hindi and ±4 Gujarati words. *banco* (silhouette 0.089) and *kal* (0.058) fell below the gate; the Hindi label was wrong 1 time in 2 (generation §1d) | Windows are defined in **words** (≈ ±24) or per script. **M1 groups are English only**; hi/gu/es/fr get the gate `language_not_evaluated` until measured. |
| Q3: *flux up* ARI ≥ 0.7 against 4 planted senses | Max 0.705, median 0.695. The generator's *metal* and *electronics* are both "apply soldering flux": one sense in two eras. Qwen is right to merge them (senses §1) | Score *flux up* against the **3** uses the text actually plants (ARI ≥ 0.8) and record the 4-class ARI as information. Otherwise Q3 fails about half the time on a correct model. Check that no tour or demo copy promises a four-way split. |
| Admission 4B 3.0 GB + 600 MB; embedder 0.8 GB | §1.1 | §1.1 |

---

## 4. Scope: M1 on his phone, with sessions that end without warning

### 4.1 Why the draft's M1 will not land soon

- **Packs.** M1 exit 2–5 need Cipher packs that **have never been built**: `~/Developer/scrolls-packs/v1` holds only an empty `starter.json` (measured). They also need phase B, bounded at 20 min on the phone and never measured even on the Mac (DEVICE-DATA "pending"), and G3, which has never run.
- **Status records.** Packages N1 and N3–N7 have **empty** status files, so nothing records which of the "≈ 69k lines" compile or pass. The only full-tree compile attempt is the bring-up's, which started tonight (status/I.md, 22:30, after the reboot).
- **Lab "assumptions".** The draft's M0Q bundles eight spikes into one device session. Its §6.4 says "no agent waits for the lab", but the lab has finished, and its assumptions are now known to be wrong in places (§1, §3).
- **Build directories.** The Mac rebooted tonight and wiped every `$TMPDIR/scrolls-*` mirror (status/I.md). `build.sh` and `check.sh` still default to `${TMPDIR}/ScrollsBuild` (read), so MLX's large first compile will be lost at the next reboot.

### 4.2 Required: staged M1, each stage on the phone, each task short and resumable

| Stage | What is on his phone at the end | Needs | Defers |
|---|---|---|---|
| **M1a: Qwen on this iPhone** (what the bring-up is doing) | The app builds and installs with ScrollsQwenKit. Models pushed and sha-verified. The "Qwen on this iPhone" screen records, into `Documents/Diagnostics/qwen-probe.json`: <br>• `os_proc_available_memory()` at launch (entitlement signed or refused); <br>• embedder load, 64 R1 windows at batch 8 → windows/s and footprint, then unload; <br>• 4B load, one ≈ 550-token label prompt at step 256 → prefill and decode tok/s and the footprint peak, then unload; <br>• footprint back to baseline; <br>• the same label twice → identical bytes; <br>• the Swift vectors against `Golden/qwen` Python fixtures (cos ≥ 0.999). <br>This is S1–S5 and S7, plus S6 *on the device*. | the bring-up's targets only | the macOS `scrolls-qwen` CLI (not needed until prebuilt demo runs) |
| **M1b: *carry the zero*, live** | The demo generated at first launch (as today). Track *carry the zero* → read all 340 occurrences (≈ 20–40 s with the load) → `qgroups` → 4 groups → 4 labels, one call each → the group card. Runs stored in the atlas. | the demo, materialise, N4 Groups, Q read and label, N8 group card | Cipher packs; the starter rebuild; `machineRun` replay |
| **M1c: *bank*** | `packs.sh cipher-meta cipher-text` built (Mac, resumable by inputs key) and bundled; phases A and B on the phone; search *bank*; first look of 600; groups; labels; rename; force quit → restored | packs, phase B, N3 | Compare, saved views, import (M2, as the draft says) |
| **M1d: soak and gates** | the 20-min soak with classified terminations (§1.2); G3 on m1r; estimated bins | — | — |

Rules for these tasks (they belong in §6.4):
1. **Short tasks.** Each agent task is ≤ ≈ 30–45 min of work.
2. **A record before and after.** A task writes its status row *before* it starts ("started: …, resume by …") and *after*, with its evidence JSON.
3. **Commits.** A task commits WIP to `~/Developer/git/Scrolls.git` at its boundary, with the attribution lines.
4. **Persistent build directories.** `SCROLLS_BUILD_DIR` and the xcodebuild derived data live under `~/Developer/scrolls-build/<agent>/`, never `$TMPDIR`.
5. **Resumable jobs.** Long jobs (packs, phase B, the pseudo-word run, the soak) resume from done-markers, as `rule_v2.py` does.

- **Journal replay is deferred.** The atlas survives a force quit, so M1 exit 7 (rename → force quit → restored) needs **no journal replay**. Append `machineRun` from M1 so nothing is lost, and build replay at M2, where restores and generations first matter.
- **Demo Qwen runs.** M1b computes them live. Prebuilt runs (the draft's §2.8, so the first minute never waits) come at M2, as a JSON resource from `scrolls-qwen` or the Python reference, *independent of the starter pack*. The starter does not exist today, and the app generates the demo at first launch.

### 4.3 Demo integration gaps missing from the draft's §1.2

- **The human layer is not applied.** `DemoLoadTask` reports the tour's tracking, Reader A/B's reviews and revisions, and the pipeline runs as "pending" (read: `ScrollsService/Pipelines/AdapterLoad.swift`). The first minute's coach marks and the tour depend on them.
- **The rename matches TF-IDF words.** The reference's deferred rename finds the group whose `label_auto` contains ≥ 2 of *hold · mic · verse · block · counted* (read: `server/jobs/tasks/demo-load.mjs:161–166`; `annotations.jsonl:23`). Under the rewrite, `label_auto` comes from the new log-odds words. Test that it still matches, or re-target the rename by the planted anchors.
- **The tour names the old method.** Tour step 5's "see" text names *"representation: tfidf-hash-4096"* (demo `tour.json`, a byte-equal engine resource). That needs a recorded divergence and phone copy, or the tour describes a method that no longer exists.
- **`cluster` is not retired.** The demo pipeline enqueues `cluster` (reference), and the draft's `retired` set lists `vectors · align · drift · tone` but not `cluster`. Map `cluster` → `qgroups`, or retire it explicitly.

---

## 5. Existing code wrongly cut or kept

| Item | Draft | Verdict |
|---|---|---|
| PPMI-SVD, rSVD, era slices, Procrustes, TF-IDF-hash, exact k-means, the G4 tier | cut | **Right.** None of it exists (ScrollsAnalysis has no clustering code; ScrollsNL is 37 lines: read). The cut deletes plans. |
| A fallback when no models are present | §3.11: "model absent → distinctive words plus 'Qwen is not on this phone'" | **Wrong.** Distinctive words are per *group*, and without the embedder there are no groups. The copy must say "context groups need the on-device model". |
| `MemoryBudget.reserve` reused for models | kept as-is | **Wrong as wired** (§1.1, the double count). |
| `kind` enum, `kvBits: 8`, batch 16, 4-bit DWQ default, qlabel all-in-one, Q3 *flux up* 0.7, the 0.6 stability and 0.10 floor | kept from the pre-lab draft | **Replace** with the measured values (§1, §3). |
| The "mostly one source" flag (top document > 0.5, collection > 80%) | kept | **Replace** with enrichment flags plus the subject flag (§3.2). |
| Compare, saved views and import moved to M2 | moved | **Acceptable, but it reorders the brief.** Its vertical slice is import → search → timeline → evidence → compare → save view, then clustering. Compare's code (≈ 1,600 lines of UI plus the engine) stays hidden until G3 Compare passes, rather than shipping unverified CIs. He must confirm the reorder (the draft's question 7.2.4 should name the brief). |
| Ground truth §0.2: "G2 Cipher slice generated" | stated as evidence | **Weaker than stated.** `check.sh quick` SKIPs the Cipher-slice families on this Mac ("private family absent") (read: check-quick-20261013T201704Z.json). |
| §1.2 gaps 1, 2 and 4 (TaskRegistry empty; `BootstrapCipher.start`; the 3 `lowercased()` calls) | open | **Being fixed now** by the bring-up (uncommitted diff in `TaskRegistry.swift`, `LiveAtlas.swift`, `Snapshots.swift` and `LivePlatform.swift`). The synthesiser should mark them as done only once committed and gated. |

---

## 6. What the draft gets right (keep)

- One model resident at a time. Unload on background, memory warning and thermal critical. No GPU work in the background.
- `ScrollsQwen` (pure, `swift test`-able) split from `ScrollsQwenKit` (MLX, xcodebuild). The lint bans `HubClient` and downloaders; there is no network.
- Machine readings as a fourth class:
  - never counted, never a documented or computed relationship;
  - their own card style and footer;
  - quotes and date chips rendered from the atlas, never from the model's text.
- Period slots instead of dates in prompts. The slots2 run showed identical verdicts and better hedging.
- An immutable `q_output` with the raw bytes and the verification. Journaled outputs. Representation keys that never mix. Saved views pin runs.
- Titles are never read for sense. Design weights are disclosed. Gated means silent: the model is never handed a gated value.
- Ask's explicit scope chips. Refusal as a first-class result: the model refused 4/4 off-topic questions itself.
- Stance stays off unless κ ≥ 0.4 and he opts in.
- `RecordedRuntime` in the simulator, labelled "recorded".

---

## 7. Questions for Utkarsh (through the lead)

1. **The gate.** The stricter rule hides genuinely interesting fine senses (machine, telegraph and taxonomic *key*; battery and prison *cell*) because it cannot tell them from subject splits. Accept fewer, honest groups (recommended), or allow an "experimental groups" view that is off by default and labelled?
2. ***Read all*.** It is 10–30 min of foreground phone GPU for a typical STEMM word. Is an opt-in, resumable *Read all* capped at ≈ 5,000 per scope acceptable as what "every occurrence" means on the phone?
3. **Ten minutes of his judgement** at the M1 device session: about 20 labels (*bank*, *current*, *charge*, *carry the zero*), so that "label groups automatically" can default on. The lab's 86% was the lab agent's judgement, not his.

---

## 8. Prioritized required changes

**P0: blocks M1 on the phone, or breaks SPEC §13**

1. **Memory from the measurements.** Pass the prefill step explicitly (256 up to 1,024 tokens, 128 above), because mlx-swift-lm 3.32.3 defaults to 512, measured at 3.086 GB at 1k. Drop `kvBits`. Embedder batch 8, reserving ≈ 1.3 GB (8-bit), not 0.8. M1 prompt cap 1,024 tokens.
2. **Fix the admission double count.** A model's reservation is its remaining growth (the peak minus the resident delta, re-measured after load), in `phys_footprint` terms calibrated at S3.
3. **The gate is `rule_v2`:** stability ≥ 0.8 and silhouette − reference ≥ 0.03 (floor 0.10), per representation key, recorded as provisional and not calibrated. Run the pseudo-word benchmark as a resumable Mac task.
4. **Fits keep the per-document cap; *Read all* only assigns.** Concentration flags are computed as enrichment on the assigned population, plus a computed subject flag from `doc_tag`. Delete `kind`.
5. **Labels.** One call per group. Output cap ≥ 2× the measured maximum (≥ 160, against the draft's 80, which sits at the measured 77). Never pass `closingBias`. Label only gated-ok groups. The card shows engine-chosen representative and random members. Never "verified".
6. **Ask and qexplain retrieval** stratified by context group and period. Drop index and heading lines. 6 passages at ±32 words, cap 1,024. Refuse before generation below 3 passages from 2 documents. "What does X mean" goes to the group card. Disclose the selection method and the modern-default bias.
7. **A hard quote gate:** a failed quote drops the claim.
8. **Number and date guard, defence in depth:** `\p{Nd}` in the grammar, plus a Verifier that **always** rejects digits, number words, century and decade words and Roman numerals unless they match a cited slot. An adversarial device test with the 1880s question; the Ask ban was never exercised.
9. **More forbidden wording:** evolved, shifted, became, turned into, led to, because, influenced, first used, began. Replace the first-minute "why did … turn ironic?" chip with a descriptive comparison.
10. **Staged M1 (M1a–M1d)** with ≤ 45-min resumable tasks, status rows before and after, a WIP commit per task, and build directories in `~/Developer/scrolls-build/<agent>`. Defer the macOS CLI and `machineRun` replay (append the op from M1).

**P1: correctness of the spec**

11. R1 = the measured instr template (or measure the marked style first). Windows in words. Groups English-only at M1 (`language_not_evaluated`).
12. Ship the 8-bit embedder; fix the key examples.
13. Q3: *flux up* scored against its 3 real uses (ARI ≥ 0.8); 4-class ARI as information.
14. Demo gaps: human layer pending; rename matching on new distinctive words; tour step 5's "tfidf-hash" copy (a DV); `cluster` retired or mapped to `qgroups`.
15. Timing copy from LAB-6: about 7–18 s per label group plus the load; Ask 20–50 s; "Read this occurrence" depends on residency; ETAs from the live device rate.
16. GPU yield: batch 4 while the Scroll is visible; no prefill chunk starts during interaction; S8 with prefill in flight.
17. *Read all* opt-in, capped at ≈ 5,000 per scope, resumable. Bins with < 5 read occurrences in a cell are not extrapolated (drawn "not estimated").
18. The soak classifies terminations (JetsamEvent reports, a heartbeat, debugger events). "Signal 9 = memory" is not assumed.
19. Reproducibility fields: device, iOS build, XGrammar version, prefill step, batch plan. Byte identity per batch plan. Re-measure label and Ask quality through the Swift guided path.
20. "Model absent" copy: no groups without the embedder.
21. His judgement before "Label groups automatically" defaults on. Ask ships only on his semantic-support judgement, not on the mechanical "≥ 1 kept claim".

**P2: wording and ground truth**

22. UI never says "verified". Each claim shows its cited sentence inline. Lane chips carry the machine glyph.
23. "First observed" is word-level. Group-level only after a full read; otherwise "earliest of n read".
24. §0.2 corrections:
    - packs never built;
    - the G2 Cipher slice skipped in quick on this Mac;
    - the TaskRegistry, bootstrap and lint fixes in flight (bring-up, uncommitted).
25. The signal-9 citation in Q-02 is restated: one of AttentionMachine's two kills came before any model load.

*An answer that cites real passages can still mislead if the passages were chosen by a modern model's idea of the word. The atlas's job is to show what was read, how it was chosen, and what was left out.*
