<!-- OWNER: qwen-lab — measurements that ground the Qwen rewrite -->
# Qwen lab report

**What this is.** The evidence behind `Docs/IOS-SPEC-QWEN.md`, assembled on 2026-10-13 from the three lab areas that ran that evening:
- `Native/Reports/qwen-lab/senses-summary.txt` and `senses.jsonl` (194 lines);
- `Native/Reports/qwen-lab/speed-summary.txt` and `speed.jsonl` (42 lines);
- `Native/Reports/qwen-lab/generation-summary.txt` and `generation.jsonl` (25 lines).

The scripts are in the `*-scripts/` folders beside them. Everything was committed as `133b400`.

**Rules of this file.**
- Every number is copied from those files. Nothing was re-measured for this report.
- The few numbers the synthesiser **derived** from the `.jsonl` files (by counting) are marked **(derived)**, with the computation named.
- **Every measurement is a Mac measurement**: an M1 Max with 64 GB, MLX 0.32.3, mlx-lm 0.31.3, Python. **Nothing was measured on the iPhone.** The A17 Pro rows are estimates, marked **(est.)**.
- The Mac was shared with the other lab agents the whole time (load average 300–800, other MLX processes alive). Throughputs are lower bounds, and decode rates are unreliable.
- **Accuracy judgements are the lab agent's (Claude's), not Utkarsh's.** LAB-7 and LAB-8 ask for his judgement, and this file does not replace it.
- The lab ran **without a grammar** (free JSON from mlx-lm). The app decodes through XGrammar, so label and Ask quality must be re-measured through the Swift guided path (IOS-SPEC-QWEN §6.3).

**Contents.** §1 senses (LAB-1, 2, 2b, 3, 4, 5, 12) · §2 speed and memory (LAB-6, LAB-9, the speed half of LAB-1) · §3 generation (LAB-7, LAB-8, part of LAB-9 and LAB-10) · §4 the exact prompts · §5 slot by slot: the value and the decision it drives · §6 not done, as resumable tasks.

---

## 1. Senses: does Qwen3-Embedding-0.6B separate word senses in this corpus?

### 1.1 Method

| Item | Setting |
|---|---|
| Models | `q8` = Qwen3-Embedding-0.6B-8bit (sha256 `fe956e8d…`, 649,088,604 B); `q4` = Qwen3-Embedding-0.6B-4bit-DWQ (`3d773d5e…`, 351,233,351 B); both under `~/Developer/scrolls-models` |
| Pooling | last-token pooling on `<|endoftext|>`, right padding, batch 16, L2-normalised |
| Sanity check | The Hugging Face model-card example reproduces within 0.006 on q8: the card gives `[[0.7645,0.1414],[0.1355,0.6000]]`, the lab `[[0.7688,0.1419],[0.1386,0.6056]]`. q4 deviates by up to 0.065, and its per-vector cosine to q8 is 0.945–0.966. |
| Corpus | a `cp -c` clone of `~/Developer/scrolls-snapshots/m5r/scrolls.db`. Scopes: **cipher-en** = collections 2, 3, 4, English passages (Cipher literature text); **stemm-en** = collections 7, 8, English passages (Gutenberg STEMM text). |
| Sampling | every inflected form of the word; **at most 3 occurrences per document**, documents in random order, round robin, cap 600 |
| Inputs ("style") | `plain` = the window text alone; `instr` = the lab task's template; `mark` = the draft's R1 (exact text in §4.1) |
| Windows | ±32 or ±64 **Qwen tokens** around the target, clipped to the passage; `p` = the whole passage, capped at 512 tokens centred on the target |
| Analysis | optional Matryoshka cut (256 of 1024 dims) and re-normalisation; optional centring (subtract the expression's mean vector, re-normalise); spherical k-means, k = 2…8, 10 restarts |
| k rule (v1, the draft's) | falling-silhouette order; the first k whose stability (mean ARI over 30 document-subsamples of 80%) is ≥ 0.6; gate = silhouette ≥ 0.10 **and** above a Gaussian-on-sphere no-groups reference with the data's mean and covariance (`ref`). `marg` = sil − ref. |
| k rule (v2, re-applied on cached vectors) | falling-silhouette order; the first k with stability ≥ **0.8**; gate = sil − ref ≥ **0.03** and sil ≥ 0.10 (`senses-scripts/rule_v2.py`) |
| Silver labels (real words only) | an occurrence gets a sense label only when exactly one class of a hand-written cue list has a cue within ±10 content words (`silver.py`). These are the **easy** occurrences by construction, so silver ARI is an optimistic purity check, not ground truth. *spring* has no cue list. |

### 1.2 The demo's planted senses (target ARI ≥ 0.8)

144 runs: 2 models × 3 windows × 3 styles × 2 widths × centred yes/no.

| Expression | n | docs | Planted senses | Chosen k | ARI min / median / max | Silhouette range | Stability min |
|---|---|---|---|---|---|---|---|
| *carry the zero* | 340 | 92 | place 90, irony 70, honor 110, null 70 | k = 4 in 72/72 | 0.974 / **0.992** / 1.000 | 0.290–0.522 | 0.965 |
| *flux up* | 125 | 38 | crew 31, teams 31, metal 32, electronics 31 | k = 3 in 66/72 (k = 4 in 6) | 0.673 / **0.695** / 0.705 | 0.344–0.594 | 0.833 |

Every one of the 144 runs passed the gate (margins over the reference 0.23–0.28 on average).

**Factor means** (each value averages the other settings; silhouette / margin / ARI at the chosen k):

| Factor | Level | *carry the zero* | *flux up* |
|---|---|---|---|
| model | q8 | 0.399 / 0.256 / 0.991 | 0.457 / 0.254 / 0.693 |
| | q4 | 0.416 / 0.264 / 0.991 | 0.486 / 0.271 / 0.695 |
| window | ±32 | 0.365 / 0.231 / 0.994 | 0.438 / 0.242 / 0.698 |
| | ±64 | 0.427 / 0.274 / 0.990 | 0.485 / 0.273 / 0.691 |
| | passage | 0.430 / 0.276 / 0.989 | 0.491 / 0.273 / 0.691 |
| style | plain | 0.396 / 0.258 / 0.994 | 0.432 / 0.241 / 0.693 |
| | instr | 0.405 / 0.255 / 0.990 | 0.487 / 0.272 / 0.700 |
| | mark | 0.421 / 0.268 / 0.989 | 0.494 / 0.275 / 0.688 |
| dims | 1024 | 0.369 / 0.239 / 0.990 | 0.444 / 0.259 / 0.691 |
| | 256 | 0.445 / 0.282 / 0.992 | 0.499 / 0.266 / 0.696 |
| centred | no | 0.389 / 0.240 / 0.990 | 0.486 / 0.279 / 0.700 |
| | yes | 0.426 / 0.280 / 0.992 | 0.457 / 0.246 / 0.687 |

**Why *flux up* stops near 0.70** (`demo_flux_confusion`, 4 lines).
- At k = 3 the clusters are {crew}, {teams} and {metal + electronics}. For example, q8/±32/instr/256/centred puts all 31 metal and all 31 electronics occurrences in one cluster.
- The raw 1024-d centroid cosine of metal against electronics is 0.981–0.992 in all four checked configs, against 0.61–0.90 for every other pair.
- Forcing a second split of the merged cluster gives ARI 0.365 (instr), 0.373 (q4) and ≈ 0 (mark, passage).
- The demo generator plants both as literally "apply soldering flux": metal in a workshop lane 1918–1939, electronics in a radio lane 1955–1980. That is **one sense in two eras**. Qwen is right to merge them; the planted four-way label is a lane and era label, not a sense label.
- A three-class ARI (crew, teams, soldering) was **not computed** by the lab.

### 1.3 *bank* in Cipher literature text: the variables compared on real text

n = 600 sampled of 3,929 occurrences, 316 documents. Silver: 274 labelled (money 111, river 163).

| Config | Dims | Centred | k | sil | ref | marg | stab | Silver ARI | Embed s (600) | tok/s (Mac) |
|---|---|---|---|---|---|---|---|---|---|---|
| q8 ±32 instr | 256 | y | 2 | 0.2374 | 0.1691 | 0.0683 | 0.988 | **0.942** | 8.95 | 4,729 |
| q8 ±32 instr | 1024 | y | 2 | 0.1935 | 0.1394 | 0.0541 | 0.982 | 0.914 | 8.95 | 4,729 |
| q8 ±32 instr | 256 | n | 2 | 0.2523 | 0.1735 | 0.0788 | 0.992 | 0.942 | 8.95 | 4,729 |
| q4 ±32 instr | 256 | y | 2 | 0.1925 | 0.1415 | 0.0510 | 0.988 | 0.928 | 12.14 | 3,487 |
| q4 ±32 instr | 1024 | y | 2 | 0.1505 | 0.1125 | 0.0380 | 0.972 | 0.900 | 12.14 | 3,487 |
| q8 ±64 instr | 256 | y | 2 | 0.2430 | 0.1792 | 0.0638 | 0.986 | 0.872 | 20.89 | 3,027 |
| q8 ±64 instr | 1024 | y | 2 | 0.2033 | 0.1508 | 0.0525 | 0.987 | 0.845 | 20.89 | 3,027 |
| q8 passage instr | 256 | y | 2 | 0.2553 | 0.1795 | 0.0758 | 0.976 | 0.818 | 103.95 | 861 |

- **Groups (all configs agree):** {money, account, notes, note, take} against {river, along, water, stream, trees}. Snippets (q8 passage run): "…he [banked] the money under another name…", "…every farthing we have in the [bank]…" / "…all the trees on the [banks] were bent and broken…", "…near the [banks] of a small river…".
- Both groups span the same years (median 1903 against 1906–1908). Top-document share 0.009–0.012 (see §1.6 for why this number cannot be large).
- **Judgement (lab agent):** real senses (financial against river bank).
- **Window:** silhouette **rises** with the window (0.237 → 0.243 → 0.255) while silver ARI **falls** (0.942 → 0.872 → 0.818). Larger windows add topic signal that k-means likes but that is not the sense.
- **q8 against q4** (`real_word_extras`): per-vector cosine mean 0.9519, p5 0.9374, min 0.9161, share ≥ 0.98 = 0.0 (at 256 d: mean 0.9549). Partition agreement against q8/±32/256 (ARI): q4 0.896; 1024-d 0.909.
- **Different-document pairwise cosine** (uncentred): 256-d p50 0.6955, p90 0.7935, p99 0.8517; 1024-d p50 0.675, p90 0.7638, p99 0.8233.

### 1.4 Six more real words (q8, ±64 Qwen tokens, instr, centred; k rule v1)

`marg` = sil − ref. Silver ARI at the chosen k (labelled count in brackets).

| Word | Scope | Dims | n / total (docs) | k | sil | ref | marg | stab | Silver ARI | Gate (v1) | Embed s / tok/s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cell | cipher-en | 256 | 323 / 777 (159) | 2 | 0.1496 | 0.1321 | 0.0175 | 0.900 | 0.437 (74) | ok | 10.2 / 3,302 |
| cell | cipher-en | 1024 | | 2 | 0.1362 | 0.1214 | 0.0148 | 0.907 | 0.363 (74) | ok | |
| cell | stemm-en | 256 | 600 / 8,254 (296) | 6 | 0.1308 | 0.0549 | 0.0759 | 0.718 | 0.343 (197) | ok | 16.7 / 3,992 |
| cell | stemm-en | 1024 | | 7 | 0.1120 | 0.0406 | 0.0714 | 0.644 | 0.322 (197) | ok | |
| plant | cipher-en | 256 | 600 / 2,274 (309) | 2 | 0.1001 | 0.0946 | 0.0055 | 0.885 | 0.242 (185) | ok (barely) | 21.0 / 3,020 |
| plant | cipher-en | 1024 | | 2 | 0.0872 | 0.0822 | 0.0050 | 0.867 | 0.168 (185) | below_floor | |
| plant | stemm-en | 256 | 600 / 23,850 (441) | 8 | 0.1032 | 0.0532 | 0.0500 | 0.600 | 0.047 (184) | ok | 16.3 / 3,995 |
| plant | stemm-en | 1024 | | 5 | 0.0851 | 0.0460 | 0.0391 | 0.736 | 0.100 (184) | below_floor | |
| key | cipher-en | 256 | 600 / 2,486 (317) | 2 | 0.1219 | 0.1102 | 0.0117 | 0.932 | 0.307 (284) | ok | 15.6 / 3,895 |
| key | cipher-en | 1024 | | 2 | 0.1068 | 0.0981 | 0.0087 | 0.946 | 0.349 (284) | ok | |
| key | stemm-en | 256 | 600 / 2,932 (354) | 8 | 0.1257 | 0.0531 | 0.0726 | 0.616 | 0.163 (129) | ok | 30.2 / 2,118 |
| key | stemm-en | 1024 | | 2 | 0.0956 | 0.0876 | 0.0080 | 0.911 | 0.282 (129) | below_floor | |
| charge | cipher-en | 256 | 600 / 4,315 (358) | 5 | 0.1572 | 0.0783 | 0.0789 | 0.889 | 0.463 (184) | ok | 35.7 / 1,713 |
| charge | cipher-en | 1024 | | 5 | 0.1442 | 0.0646 | 0.0796 | 0.900 | 0.552 (184) | ok | |
| charge | stemm-en | 256 | 600 / 7,422 (454) | 4 | 0.1720 | 0.0890 | 0.0830 | 0.947 | 0.650 (204) | ok | 21.0 / 3,114 |
| charge | stemm-en | 1024 | | 4 | 0.1562 | 0.0744 | 0.0818 | 0.846 | 0.709 (204) | ok | |
| current | cipher-en | 256 | 588 / 1,519 (260) | 2 | 0.2137 | 0.1680 | 0.0457 | 0.942 | 0.501 (179) | ok | 18.4 / 3,436 |
| current | cipher-en | 1024 | | 2 | 0.2007 | 0.1583 | 0.0424 | 0.967 | 0.572 (179) | ok | |
| current | stemm-en | 256 | 600 / 13,669 (426) | 3 | 0.2022 | 0.1198 | 0.0824 | 0.956 | 0.757 (258) | ok | 12.5 / 5,256 |
| current | stemm-en | 1024 | | 4 | 0.1754 | 0.0766 | 0.0988 | 0.956 | 0.777 (258) | ok | |
| spring | cipher-en | 256 | 600 / 4,267 (369) | 2 | 0.1095 | 0.1039 | 0.0056 | 0.895 | — | ok (barely) | 17.9 / 3,419 |
| spring | cipher-en | 1024 | | 2 | 0.0876 | 0.0845 | 0.0031 | 0.870 | — | below_floor | |
| spring | stemm-en | 256 | 600 / 9,378 (492) | 8 | 0.1439 | 0.0569 | 0.0870 | 0.663 | — | ok | 10.8 / 5,976 |
| spring | stemm-en | 1024 | | 8 | 0.1283 | 0.0440 | 0.0843 | 0.712 | — | ok | |

Embedding times are for 600 windows of ±64 tokens on the Mac, q8, batch 16. Throughput varied 1.7k–6.0k tok/s with how much else was running.

**The groups at 256 dims, and the lab agent's judgement:**

| Word / scope | Groups (n) | Judgement |
|---|---|---|
| cell / cipher-en, k = 2 | g0 n = 128 ("…the brain-[cells] which store all impressions", "…builds her waxen [Cells]"); g1 n = 195 ("…the padlocks of his [cell]") | A real split (prison or enclosure against biological or honeycomb cell), but noisy: silver 0.437, margin 0.018. A "machine suggestion", not a confident result. |
| cell / stemm-en, k = 6 (stab 0.718) | nerve/brain/blood cells (104) · germ/egg/cytology (99) · battery/voltaic cells (108; 51 of the 55 silver "battery") · air-cells of the lungs (71) · hermit's/prison cell (90; prison 13 of 14) · plant-tissue cells (128) | Two genuine senses isolated (electrical, prison); the other four groups are **one sense split by subject** (neurology, embryology, respiration, botany). Year medians 1858–1899, overlapping IQRs. |
| plant / cipher-en, k = 2 | g0 n = 306 ("…I am [planted] squarely at last…"); g1 n = 294 ("…picturesque [plants]…") | Essentially **no sense structure** (margin 0.0055, silver 0.242, 1024-d fails the floor); closer to verb against noun. Should be reported as no groups. |
| plant / stemm-en, k = 8 (stab 0.600) | gardens/planting · plant-animal-mineral · industrial plant (85; 18 of 22 silver) · fossil remains · ecology · classification · pharmacy · physiology | One real sense split (industrial) and **seven topic groups** of the botanical sense. Silver 0.047. Topic clustering, not sense clustering. |
| key / cipher-en, k = 2 | g0 n = 277 (musical: "…in self-same [key]"); g1 n = 323 (door, locked) | The musical sense is pulled out (39 of 45), but g0 also takes 47 lock keys; margin 0.012. Too weak to show without "suggestion" framing. |
| key / stemm-en, k = 8 (stab 0.616) | mechanical key on a shaft (108) · telegraph keys (52) · identification key (99) · figurative "key to the mystery" (98) · door keys (76) · musical keys (47) · "Key West" + figurative (62) · "key players", answer key (58) | The most interesting result: several are dictionary-listed fine senses. But stability is 0.616 and the 1024-d run collapses to k = 2 below the floor: fragile. |
| charge / cipher-en, k = 5 (stab 0.889) | custody (164) · price/fee (103) · military charge (117) · accusation (132) · mixed (84; "charged with feminine tenderness") | Real senses. Silver 0.463 (256) / 0.552 (1024). |
| charge / stemm-en, k = 4 (stab 0.947) | in charge of (142) · price/fee (116) · legal accusation (117) · electric + explosive charge (225) | Real senses. Silver 0.650 / 0.709. Electric and explosive merged (42 + 14). |
| current / cipher-en, k = 2 | flow (293: "…in a [current] as swift as a mill-race") · present/prevailing (295) | Real senses. Silver 0.501 / 0.572. Electric current too rare in fiction to form a group. |
| current / stemm-en, k = 3 (stab 0.956) | electric (220) · water/sea (221) · present time (159) | Clean real senses. Silver 0.757 / 0.777. |
| spring / cipher-en, k = 2 | season (329) · leap (271) | From the snippets a real split, but margin 0.0056 and the 1024-d run fails the floor: "no reliable groups". |
| spring / stemm-en, k = 8 (stab 0.663) | mechanical (137) · water springs (82) · springs in nature, mixed with season (78) · season with plants (73) · "in the [spring] of 1903" (70) · equinox (42) · medical mix (57) · "springs from" = arises (61) | Four real senses (device, water source, season, arise), but the **season is split three ways by topic or genre**, and one group is a genre mix. No silver labels. |

### 1.5 The k rule and the gate on the real-word runs

**Findings of the senses area (summary §4):**
- **The 0.10 floor does not separate senses from nothing.** At 256 dims every run passed it, including *plant*/cipher (margin 0.0055) and *spring*/cipher (0.0056). At 1024 dims four runs fail it. Silhouette at 256 is higher than at 1024 in **12/12** runs, so a fixed floor means different things at different widths.
- **The margin is the more honest number for k = 2.** Ordered by margin at 256: *bank* 0.068 (silver 0.942), *current*/cipher 0.046 (0.501), *cell*/cipher 0.018 (0.437), *key*/cipher 0.012 (0.307), *spring*/cipher 0.006, *plant*/cipher 0.006 (0.242). A margin of about 0.03 keeps *bank* and *current* and drops the four weak ones. **This threshold was read off these points, not calibrated on pseudo-words.**
- **Stability 0.6 admits subject splits.** In STEMM text the silhouette curve is flat across k (for example *spring*/stemm at 256: 0.134, 0.123, 0.130, 0.132, 0.136, 0.144, 0.144 for k = 2…8), and the rule then takes a large k whose stability is just over 0.6 (0.600, 0.616, 0.663, 0.718). Those are the runs that split one sense by subject. The clean runs all chose k with stability ≥ 0.889.
- **256 against 1024 dims:** 1024 was better for *key*/cipher (+0.042), *charge*/cipher (+0.089), *charge*/stemm (+0.059), *current*/cipher (+0.071) and *current*/stemm (+0.020, k 3 against 4); 256 was better for *bank* (+0.028), *cell*/cipher (+0.074) and *cell*/stemm (+0.021, k 6 against 7). Neither wins; the draft's "within 0.02 ARI of 1024" test is **not met** on several words, in both directions.

**rule_v2 on the cached vectors** (`exp = rule_v2`, 12 runs; q8, ±64, instr, centred, 256 d; `*spring*/stemm-en` was not run):

| Word / scope | v1 k | v2 k | sil | ref | marg | stab | v2 gate | Silver ARI at v2 k |
|---|---|---|---|---|---|---|---|---|
| bank / cipher-en | 2 | 2 | 0.243 | 0.1792 | 0.0638 | 0.986 | **ok** | 0.872 |
| cell / cipher-en | 2 | 2 | 0.1496 | 0.1321 | 0.0175 | 0.900 | below_margin | 0.437 |
| cell / stemm-en | 6 | 2 | 0.116 | 0.0945 | 0.0215 | 0.902 | below_margin | 0.429 |
| plant / cipher-en | 2 | 2 | 0.1001 | 0.0946 | 0.0055 | 0.885 | below_margin | 0.242 |
| plant / stemm-en | 8 | 1 | — | — | — | — | no_stable_k | — |
| key / cipher-en | 2 | 2 | 0.1219 | 0.1102 | 0.0117 | 0.932 | below_margin | 0.307 |
| key / stemm-en | 8 | 2 | 0.1237 | 0.1128 | 0.0109 | 0.954 | below_margin | 0.179 |
| charge / cipher-en | 5 | 5 | 0.1572 | 0.0783 | 0.0789 | 0.889 | **ok** | 0.463 |
| charge / stemm-en | 4 | 4 | 0.172 | 0.089 | 0.083 | 0.947 | **ok** | 0.650 |
| current / cipher-en | 2 | 2 | 0.2137 | 0.168 | 0.0457 | 0.942 | **ok** | 0.501 |
| current / stemm-en | 3 | 3 | 0.2022 | 0.1198 | 0.0824 | 0.956 | **ok** | 0.757 |
| spring / cipher-en | 2 | 2 | 0.1095 | 0.1039 | 0.0055 | 0.895 | below_margin | — |

rule_v2 **keeps** *bank*, *charge* ×2 and *current* ×2, and **gates** *cell* ×2, *plant* ×2, *key* ×2 and *spring*/cipher. Its thresholds (0.8, 0.03) were read off the same 13 real-word runs they now judge: they are provisional until the pseudo-word benchmark runs (§6).

### 1.6 Concentration: what "no group is one book" can and cannot say

- **Senses summary:** at 256 dims no group's top document exceeds 4.8% of the group (max 0.048, the *spring*/stemm equinox group); at 1024 dims the maximum is 0.067 (a *cell*/stemm group). Literature groups have year medians 1899–1908; STEMM groups 1851–1898 with overlapping IQRs; some subject groups are older on average (*cell* air-cells 1858 against battery 1885).
- **(derived)** In **all 113 groups** of the 32 `real_word` runs, the top document contributes exactly **2 or 3** occurrences (67 groups with 2, 46 with 3: `round(top_doc_share × n)`). The sampling takes at most 3 per document, so the top-document share is always 2/n or 3/n. **"No group is one book" is forced by the sampling design.** It says nothing about fits without a per-document cap.
- **(derived)** `top_collection_share` > 0.8 in **52 of the 54** groups of the 13 word × scope runs at 256 d (q8, ±64, instr, centred), and in 111 of the 113 groups of all 32 runs (minimum 0.638). Each scope is essentially one collection, so a "one collection > 80%" flag would fire on almost every group.
- **What the lab did see:** the confound is **subject or genre** (*cell*, *plant*, *spring* in STEMM text), not book and not era.

### 1.7 Slots filled by the senses area

| Slot | Status | Evidence |
|---|---|---|
| LAB-1 (8-bit or 4-bit) | partial | per-vector cos q8 vs q4 mean 0.952, p5 0.937, min 0.916, share ≥ 0.98 = 0.0, which **fails** the draft's ≥ 0.98 condition. Demo ARI equal (0.991 / 0.991; 0.693 / 0.695). *bank* silver 0.942 (q8) vs 0.928 (q4). Pseudo-word ARI not measured. Verdict: ship q8. |
| LAB-2 (representation) | partial | instr, plain and mark measured on the demo only (ARI within 0.012; instr and mark +0.01–0.06 silhouette). **Every real-word result used instr.** Pseudo-words, R3 and R4 not run (`run_pseudo.py`, `run_r3.py` exist and logged nothing). |
| LAB-2b (centring) | measured | demo: *carry the zero* 0.990 → 0.992, *flux up* 0.700 → 0.687; *bank*: silhouette 0.237 centred vs 0.252 uncentred, silver identical (0.942). Neutral; kept (anisotropy confirmed: different-document p50 cosine 0.68–0.70). |
| LAB-3 (window) | *bank* only | ±32 silver 0.942, ±64 0.872, passage 0.818. Hindi, Gujarati, Spanish and French words not run in this area. |
| LAB-4 (width) | 256 vs 1024 only | not within 0.02 on several words, both directions (§1.5). 128 and 512 not run. |
| LAB-5 (floor and margin) | **not calibrated** | real-word evidence suggests margin ≈ 0.03 plus stability ≈ 0.8 (rule_v2); a suggestion, not a calibration. |
| LAB-12 (similar-usage τ) | *bank* only | different-document cosine, uncentred, 256 d: p50 0.6955, p90 0.7935, p99 0.8517 (1024 d: 0.675, 0.764, 0.823). |

---

## 2. Speed and memory

### 2.1 Conditions

- **Host:** Apple M1 Max, 64 GB, 32-core GPU; mlx 0.32.3, mlx-lm 0.31.3 (Python).
- **Corpus:** an APFS clone of `m5r/scrolls.db` at `~/Developer/scrolls-lab-speed/scrolls.db` (read-only).
- **Contention:** load averages 300–800 with other MLX processes alive (each `speed.jsonl` line records them). Every Mac throughput is a lower bound for an idle M1 Max. Embedding is reported as "best" (least-contended batch), "median" and "sustained" (whole run). Decode varied 7–32 tok/s purely from contention; prefill was steadier. Load times were measured with a warm file cache (0.9–6.8 s).
- **Memory** is MLX's peak (`mx.get_peak_memory`), not `phys_footprint`. The device must re-measure with `os_proc_available_memory()` and the footprint.

### 2.2 The embedder (last-token pooled, L2, cut to 256 dims, f16)

Weights resident after load: **8-bit 633 MB**, 4-bit DWQ 335 MB. Load 1.7–5.9 s (8-bit), 1.8 s (4-bit), warm cache.

**Fixed 64-token windows** of Cipher literature text, right-padded. Windows/s (tokens/s). "run2" = per-batch timing; "run1" = 3 whole-run trials.

| Model | Batch | run2 best | run2 median | run2 sustained | run1 best | Peak mem | Peak − weights |
|---|---|---|---|---|---|---|---|
| 8-bit | 1 | 58.2 (3,727) | 11.4 (731) | 8.2 | 44.1 (2,820) | 0.853 GB | 220 MB |
| 8-bit | 8 | 82.6 (5,284) | 52.5 (3,363) | 45.9 | 85.7 (5,487) | **1.249 GB** | 616 MB |
| 8-bit | 32 | 87.2 (5,579) | 53.8 (3,445) | 50.1 | 65.3 (4,177) | 1.531 GB | 898 MB |
| 8-bit | 64 | 82.2 (5,260) | 44.6 (2,853) | 45.3 | 65.0 (4,162) | 1.539 GB | 906 MB |
| 4-bit | 1 | 38.1 (2,435) | 17.2 (1,102) | 16.0 | — | 0.557 GB | 222 MB |
| 4-bit | 8 | 69.1 (4,424) | 50.1 (3,208) | 27.8 | — | 0.895 GB | 559 MB |
| 4-bit | 32 | 45.1 (2,888) | 36.5 (2,335) | 35.3 | — | 1.247 GB | 912 MB |
| 4-bit | 64 | 55.4 (3,546) | 31.5 (2,016) | 29.8 | — | 1.253 GB | 917 MB |

**128-token windows** (the draft's LAB-9 shape):

| Model | Batch | Best w/s (tok/s) | Median w/s | Sustained w/s | Peak mem |
|---|---|---|---|---|---|
| 8-bit | 8 | 35.3 (4,514) | 15.3 | 13.9 | **1.520 GB** |
| 8-bit | 16 | 26.5 (3,397) | 20.6 | 14.9 | 1.537 GB |
| 8-bit | 32 | 52.2 (6,675) | 28.4 | 27.4 | 1.539 GB |
| 4-bit | 8 | 26.4 (3,385) | 15.5 | 12.3 | 1.313 GB |
| 4-bit | 16 | 36.2 (4,628) | 18.5 | 18.2 | 1.247 GB |
| 4-bit | 32 | 25.6 (3,279) | 17.1 | 17.1 | 1.252 GB |

**The real R1 input** (instruction + ±32 Qwen tokens around Cipher *bank* occurrences + `<|endoftext|>`): 640 windows, length min 42 / median 85 / p90 87 / max 88 tokens (18 of them instruction), sorted by length.

| Model | Batch | Best w/s | Median w/s | Sustained w/s | Peak mem |
|---|---|---|---|---|---|
| 8-bit | 16 | 32.4 | 21.8 | 22.5 | 1.594 GB |
| 8-bit | 32 | 30.1 | 26.3 | 24.1 | 1.699 GB |
| 4-bit | 16 | 52.5 | 27.4 | 8.3 (heavy contention) | 1.354 GB |

**Observations:**
- Batch 1 wastes the GPU; batch 8–32 is the plateau. On the Mac batch 8 and batch 32 give the same best throughput (83–87 w/s at 64 tokens); larger batches only raise peak memory.
- **4-bit DWQ is not faster** (best 69 against 83 w/s at batch 8): it is compute-bound and pays for dequantisation. Its win is memory: −298 MB of weights, −290 MB of peak at 16 × 128.
- Peak minus weights plateaus at ≈ 0.90–0.92 GB for any batch ≥ 32 × 64 or ≥ 16 × 128 on both models; ≈ 0.22 GB at batch 1; 0.56–0.62 GB at batch 8 × 64.
- **The draft's gate "embedder ≤ 0.8 GB at 16 × 128" fails for both models** (8-bit 1.537 GB, 4-bit 1.247 GB). Only batch 1 × 64 on 4-bit (0.557 GB) is under 0.8 GB.
- The R1 shape **at batch 8** was not measured. It lies between 8 × 64 (1.249 GB) and 8 × 128 (1.520 GB).

### 2.3 The generator: Qwen3-4B-Instruct-2507 4-bit (mlx-lm `generate_step`, 64 new tokens)

Weights resident after load: **2,264,693,768 B (2.265 GB)**. Load 6.8 s / 3.4 s / 0.9 s (three loads, warm cache, tokenizer included).

| Prompt tokens | Prefill step | KV | Prefill s | Prefill tok/s | Decode tok/s | Peak mem | Peak − weights |
|---|---|---|---|---|---|---|---|
| 128 | 256 | f16 | 0.753 | 170.0 | 23.1 | 2.633 GB | 368 MB |
| 512 | 256 | f16 | 2.640 | 193.9 | 32.4 | 2.854 GB | 589 MB |
| 1,024 | 256 | f16 | 4.422 | 231.6 | 9.3 | **2.938 GB** | 673 MB |
| 2,048 | 256 | f16 | 7.493 | 273.3 | 12.6 | 3.126 GB | 861 MB |
| 1,024 | **512** | f16 | 5.384 | 190.2 | 7.3 | **3.086 GB** | 821 MB |
| 1,024 | 256 | 8-bit | 13.520 | 75.7 (contended) | 13.9 | 2.865 GB | 601 MB |
| 2,048 | 256 | 8-bit | 13.811 | 148.3 | 23.0 | 3.155 GB | 890 MB |

- Peak grows ≈ 0.257 MB per prompt token (128 → 2,048), ≈ 1.7× the f16 KV size from the config (147,456 B per token): the KV cache grows in 256-token steps by concatenation, so it is briefly held twice. Intercept ≈ 0.34 GB = one 256-token prefill chunk's working set.
- **Prefill step 512 costs +148 MB of peak at 1k and was not faster.**
- **`kvBits 8` did not lower the peak** at 2k (3.155 against 3.126 GB): the peak is set during prefill, not by the stored KV.
- **The draft's gate "4B ≤ 3.0 GB at 2k" fails by 0.126 GB at step 256** (3.126 GB) and passes at step 128 (2.964 GB, from the joint run in §2.6). At 1k, step 256 passes (2.938 GB).
- Decode on the Mac is unreliable here (7–32 tok/s). Prefill grows with prompt length (170 → 273 tok/s), because larger chunks use the GPU better.

### 2.4 Corpus facts (m5r clone; "tokens" = the atlas tokenizer's word tokens, not Qwen tokens)

| Collection | Passages | Tokens |
|---|---|---|
| cipher-gutenberg | 980,948 | 60,228,765 |
| stemm-gutenberg | 1,008,337 | 63,914,036 |
| stemm-openalex | 211,389 | 11,551,765 |
| cipher-wikisource-hi | 84,302 | 4,971,711 |
| cipher-wikisource-gu | 78,423 | 3,395,231 |
| cipher-culture-works | 205,747 | 1,024,761 |
| cipher-music-relations | 179,005 | 687,066 |
| stemm-gutenberg-restricted | 13,613 | 792,825 |
| demo-world | 1,437 | 98,417 |
| **Total** | **2,763,209** | **146,664,878** (quality ok: 2,573,438 / 145,197,762) |

- Cipher English literature passages: n 656,481; tokens median 53, mean 67, p90 129, p99 189.
- Vocabulary (FTS5 vocab, alphabetic, length ≥ 3): 274,350 terms with count ≥ 5; 67,016 with ≥ 60; 14,604 with ≥ 600; 2,525 with ≥ 5,000; 555 with ≥ 20,000. Rank bands (occurrences): ranks 1–100 median 162,521; 101–1,000 median 20,183; 1,001–5,000 median 4,160; 5,001–20,000 median 739; 20,001–50,000 median 171; 50,001–100,000 median 49.
- The 15 polysemous words of ANALYSIS-AND-LIMITS §7 (all collections, FTS occurrences): median 8,760, p90 18,580, min 861 (*bug*), max 41,280 (*power*); *bank* 5,691, *cell* 12,765, *current* 18,155, *plant* 17,115, *charge* 10,742, *spring* 12,975, *key* 7,938.
- Per scope (clustered n after exclusions, copied from ANALYSIS-AND-LIMITS §7): Cipher literature median 2,479, p90 5,012, max 12,462 (*bank* 4,309); STEMM text median 8,289, p90 28,675, max 28,695; OpenAlex median 2,621, p90 8,122, max 19,836.
- Pseudo-word bases: church 11,882, ocean 9,216, horse 14,160, doctor 11,201, kitchen 3,849, winter 12,467.
- The Qwen-tokens-per-word ratio for en/fr/es was **not measured** (the query timed out at 270 s); 1.3–1.5 is an assumption. Hindi 4.75 and Gujarati 8.86 per word are the draft's reported figures. The generation area measured Spanish at 1.54–1.60 and Hindi at 4.03–4.56 Qwen tokens per word (§3.4).

### 2.5 The device anchor: AttentionMachine on his iPhone 15 Pro Max (A17 Pro, iOS 27.2, MLX Swift, the same 4B 4-bit)

- `DeviceValidation.json` / `MODEL.md`: capture plus generation, excluding the load, 16 generated tokens. 24 prompt tokens: 5.147 s (first run), 1.735 s, 2.057 s; 14 prompt tokens: 1.607 s.
- Peak resident memory was **not** measured by that validation (`peakResidentMemoryMeasured = false`). (The draft's 2.662 GB footprint peak comes from AttentionMachine's QUALITY.md, not from this file.)
- Mac replica of the same work (`gen_bench.py am_replica`): 24 tokens best 0.809 s, median 1.162 s; 14 tokens best 0.510 s, median 0.565 s; 95 tokens median 0.848 s. Device/Mac time ratio 1.5–3.2×.
- **A hard device bound:** 15 decode forwards fit inside 1.607–1.735 s, so warm decode on the A17 Pro is **≥ 8.6–9.3 tok/s** at short context (measured, not estimated).

### 2.6 Memory budget (Mac MLX peaks)

| State | 8-bit embedder | 4-bit DWQ embedder |
|---|---|---|
| embedder alone, idle (weights) | 0.633 GB | 0.335 GB |
| embedder alone, batch 16 × ≈ 80–128 tokens, peak | 1.54–1.59 GB | 1.25–1.35 GB |
| 4B alone, idle (weights) | 2.265 GB | 2.265 GB |
| 4B alone, 1k prompt, peak | 2.938 GB | 2.938 GB |
| 4B alone, 2k prompt, peak | 3.126 GB | 3.126 GB |
| **one at a time, worst peak** | **3.13 GB** | 3.13 GB |
| both resident, idle | 2.898 GB (measured) | 2.60 GB (est.) |
| both resident, embedder 16 × 128 running, peak | 3.795 GB (measured) | ≈ 3.5 GB (est.) |
| both resident, 4B 2k prompt step 256, peak | 3.763 GB (measured) | ≈ 3.46 GB (est.) |
| both resident, 4B 2k prompt step 128, peak | 3.597 GB (measured) | ≈ 3.30 GB (est.) |
| both resident, both working at once | ≈ 4.0–4.1 GB (est.) | ≈ 3.7–3.8 GB (est.) |

**The joint measurement** (`both_resident.py`, one process, 8-bit embedder, load ≈ 790):
- 4B active 2,264,693,768 B; both idle 2,897,804,296 B (exactly the sum: no shared overhead);
- the embedder at 16 × 128 with the 4B resident: 0.547 s, peak 3.795 GB (both weights + 0.898 GB);
- the 4B at 2,048 tokens with the embedder resident: step 256 → 5.353 s prefill (382.6 tok/s), peak 3.763 GB; step 128 → 6.825 s (300.1 tok/s), peak 3.597 GB.
- Subtracting the embedder's weights, the 4B alone at 2k with step 128 peaks at **2.964 GB**. Step 128 cost ≈ 22% of prefill speed in this single contended run.
- Loading both models: 11.7 s (warm, contended).

The generation area's runs used Python's default single-chunk prefill and peaked at **2.97–3.21 GB** at 395–1,112 prompt tokens (§3).

### 2.7 A17 Pro estimates (est.)

**Assumptions, as the speed area stated them:**
- the device/Mac ratio for the 4B's latency-bound work is the measured 1.5–3.2×;
- compute-bound work (prefill, batched embedding) scales worse, by roughly the GPU size ratio (6-core A17 Pro against the 32-core M1 Max, ≈ 5× against an idle M1 Max);
- A17 Pro memory bandwidth ≈ 51 GB/s (a spec-level figure, not measured) caps 4B decode at ≈ 22 tok/s.

| Quantity | Mac measured | A17 Pro (est.) |
|---|---|---|
| embedder, R1 windows (≈ 80 tokens), batch 16 | 22–32 w/s (8-bit) | **10–20 w/s** (800–1,600 tok/s) |
| embedder, 64-token windows, batch 8–32 | 83–87 w/s best, 46–50 sustained | 15–30 w/s |
| 4B prefill | 170–273 tok/s | **60–120 tok/s** |
| 4B decode | 7–32 tok/s (contended) | **9–15 tok/s** (≥ 8.6 measured) |
| 4B load (warm) | 0.9–6.8 s | 3–8 s |

The draft's LAB-6 guesses: embedder 600–2,000 tok/s (consistent); 4B prefill 150–300 tok/s (**too high**: 60–120); decode 12–20 tok/s (somewhat high: 9–15).

**Time to embed** (R1 windows at 10–20 w/s, load excluded):

| Work | Occurrences | Est. on the phone |
|---|---|---|
| first look | 600 | 30–60 s |
| *bank*, Cipher literature | 4,309 | 3.6–7.2 min |
| typical word, Cipher literature | 2,479 | 2.1–4.1 min |
| typical word, STEMM text | 8,289 | 6.9–13.8 min |
| typical word, all scopes | 8,760 | 7.3–14.6 min |
| p90 word | 18,580 | 15.5–31 min |
| the draft's 20,000 cap | 20,000 | 17–33 min |

- **Whole corpus, for contrast:** one pass over every passage ≈ 233–261 M Qwen tokens (assumption) at 800–1,600 tok/s = 1.7–3.8 days of GPU. R1 windows for every word occurrence (146.7 M windows × ≈ 80 tokens): 85–170 days.
- **4B tasks** (prefill 60–120 tok/s, decode 10–15 tok/s): a label pass of 1.8k in + 250 out takes 32–55 s; Ask at 2,048 in + 160 out 28–50 s; Ask at 1,024 in + 160 out 19–33 s.
- **Sustained GPU throttling on the phone was never measured.**

### 2.8 The speed area's recommendations (verbatim in substance)

| # | Recommendation |
|---|---|
| R1 | One model resident at a time. The pipeline is sequential anyway; a swap costs a few seconds; the worst case stays ≈ 3.0 GB (4B, 2k, step 128) instead of the measured 3.6–3.8 GB with both resident. |
| R2 | Embedder batch 8: the same throughput plateau on the Mac, and peak at 8 × 64 is 0.62 GB over the weights against 0.90 GB at 32. A smaller batch also cancels faster. Use 16 only if the device shows batch 8 under-filling its GPU. |
| R3 | Raise the LAB-9 budgets: embedder 1.3 GB (4-bit) / 1.6 GB (8-bit) at 16 × 128, or ≈ 0.9 / 1.25 GB at 8 × 64. The 4B keeps a 3.0 GB peak and a 2,048 cap only with prefill step 128 above 1,024 tokens; step 256 up to 1,024 (2.938 GB). No `kvBits 8` for peak reasons. |
| R4 | 4-bit DWQ saves 0.30 GB of weights and ≈ 0.29 GB of peak but is not faster; pick it only on quality parity (the senses area says it is not at parity). |
| R5 | Keep the first look at 600 (30–60 s est.). Revise the 4B timing copy: label pass 30–55 s, Ask 20–50 s; plan the 1,024-token, 6-passage Ask as the default. |
| R6 | "Every occurrence" stays per tracked expression: minutes per word, days to months for the whole corpus. |
| R7 | Re-measure on the phone (S4): embedder w/s at batch 8/16 on R1 windows, 4B prefill at 1k/2k, decode, and `phys_footprint` peaks. The Mac numbers carry ≈ 2× uncertainty for the device. |

---

## 3. Generation: Qwen3-4B as labeller (LAB-7) and grounded answerer (LAB-8)

### 3.1 Setup

- Model `Qwen3-4B-Instruct-2507-4bit` through mlx-lm 0.31.3, **greedy decoding (temperature 0), no grammar**. Embedder for clusters and re-ranking: Qwen3-Embedding-0.6B-8bit.
- Corpus: a read-only clone of `m5r/scrolls.db`, FTS5 through `/usr/bin/sqlite3 -readonly` (Python's bundled SQLite cannot open the `contentless_delete` FTS table).
- Timings are Mac numbers under shared load, not phone numbers.

### 3.2 Labels: the groups that were labelled

A quick build, not the senses method: FTS5 hits → 240 windows of 40 words → Qwen3-Embedding-0.6B-8bit with the instr instruction, centred → spherical k-means, k = 2 (20 restarts, best inertia).

| Word | FTS passages | Sizes | Silhouette (centred cos) | Top words of each group |
|---|---|---|---|---|
| bank | 4,659 | 103 / 137 | 0.191 | england work banknotes notes money · river along above miles side |
| cell | 2,635 | 147 / 93 | 0.213 | cells nucleus ovary zinc placed · come door window night day |
| key | 3,725 | 113 / 127 | 0.132 | keynote manner minor line use · door pocket hand took locked |

*key* group 0 is genuinely mixed (keynote, musical key, telegraph key, keyboard key, key edge); *cell* group 0 mixes biological and galvanic cells.

### 3.3 Label prompt variants (6 groups; the prompts are in §4.3)

| Variant | JSON parsed | Label is a string | Sense acceptable | Digits / years in output | Prompt tokens | Output tokens |
|---|---|---|---|---|---|---|
| V1: words + 5 passages | 6/6 | 4/6 | 6/6 | 0 / 0 | 395–476 | 42–70 |
| V2: V1 + title, author, year | 6/6 | 5/6 | 6/6 | 0 / 0 | 483–577 | 49–77 |
| V2ban: V2 + the 28 digit-bearing tokens banned | 6/6 | 5/6 | 6/6 | 0 / 0 | 483–577 | 49–77 |
| V3: both groups in one call, with cites and a `kind` enum | 3/3 calls | 3/3 | 5/6 | 0 / 0 | 671–689 | 146–160 |

- **Labels produced (V2):** *bank* → "financial institution" / "riverbank"; *cell* → "biological cell" / "prison chamber"; *key* → `["central","level","control","important","essential"]` (an array: a schema violation, though the description honestly lists the mixed senses) / "object used to open something".
- **Schema:** without a grammar, the label came back as a JSON **array** in 2/6 (V1) and 1/6 (V2) groups, both times on a mixed group. A grammar is needed, not a prompt.
- **Metadata did not leak:** 0 digits, 0 years, 0 new names with title, author and year in the prompt.
- **The digit ban changed nothing:** V2 and V2ban are byte-identical 6/6 (no digit was ever the argmax).
- **V3 (one call for both groups):** citations valid and inside the right group 23/23, but the mixed *key* group was labelled "musical pitch" while citing a telegraph key and a keyboard key, and **the `kind` enum was used sensibly 0/6 times**.
- **Invented facts** (24 outputs checked): 0 names, dates or places not in the passages. 2 descriptions added general knowledge ("fundamental unit of life"); 1 misreading (botanical "ovary 2-celled" read as "ovary cells").
- **Determinism (Mac):** V1 run twice in two processes → 6/6 byte-identical.
- **Measured cost** (`labels_V1`…`labels_V3` summaries): Mac wall 1.86–9.97 s per single-group call; MLX peak 2.989 GB (V1), 3.04 GB (V2, V2ban), 3.066 GB (V3).

### 3.4 The demo's *carry the zero* (4 planted senses; groups are the planted senses, so the label can be judged objectively)

| Prompt | place value | bureaucratic irony | honoring the uncounted | null placeholder | Score |
|---|---|---|---|---|---|
| one group per call | "maintain place value in addition" | "bear a minor responsibility" (the duty, not the irony) | "acknowledge unseen contributions" | "preserve null values" | **3 correct + 1 partial** |
| all four groups in one call | "mathematical procedure" | "office protocol" (partial) | "performance duty" (wrong or vague) | "data handling" | 2 + 1 partial + 1 wrong |

Single-group prompts: 381–509 tokens in, 54–60 out. Four-in-one: 982 in, 251 out, 12/12 valid citation ids. 0 digits, 0 years, 0 real-world names imported into the invented town.

**Multilingual check** (5 passages of ±25 words, prompt in English; the "native" variant also asks for the label in the passage's language):

| Word | Group (top words) | Label (EN prompt) | Label (native variant) | Judgement |
|---|---|---|---|---|
| banco (es) | piedra sentado madera plaza | "bench or seat" | "bench or seat" / "banco o asiento" | correct |
| banco (es) | billetes acciones dinero madrid | "bank" | "bank" / "banco de dinero" | correct |
| kal (hi) | future-tense context | "next day" | "next day" / "agla din" | correct for 4/5 (the 5th is *kal* = machine) |
| kal (hi) | past / mixed context | "next day" | "future, tomorrow" | **wrong**: the group mixes *kal-naad*, "yesterday" and "aaj kal" |

- Spanish 2/2, Hindi 1/2. Both clusters had silhouettes **below the 0.10 gate** (es 0.089, hi 0.058), so the app would have gated them. The Hindi failure shows the model projecting the dictionary sense onto a mixed group instead of saying it is mixed.
- Token cost: Spanish 1.54–1.60 Qwen tokens per word; Hindi 4.03–4.56. Prompts: Spanish 432–625 tokens; Hindi 776–1,112 tokens for the same 5 passages (≈ 2.5× the budget).

**LAB-7 as measured** (lab agent's judgement, one-group-per-call prompts): real words 6/6, demo 3/4 + 1 partial, multilingual 3/4 → **12 of 14 groups acceptable (86%)**, 1 partial, 1 wrong. Citation ids valid 23/23 (V3) and 12/12 (demo), without a grammar. Prompt size per group 395–577 tokens (EN), 432–625 (es), 776–1,112 (hi). **His judgement is still owed.**

### 3.5 Grounded answers (LAB-8)

**Pipeline** (`retrieve.py` + `ask.py`, prompt `dated2`):
1. FTS5 `bm25`, ≤ 64 candidates per scope stratum;
2. Qwen3-Embedding re-rank of ±60-word windows against the instructed question;
3. the top 6, ≤ 2 per document;
4. the 4B sees each passage as `[P1]`…`[P6]` with its date label, source and a ±40-word window, and returns `{"answerable", "claims": [{text, cites, quote, quote_from}] (≤ 4), "reason"}`;
5. the verifier (`ask.py verify`): cites must be given ids; every year or decade in a claim must overlap a cited passage's dates; the quote is checked verbatim (NFC, quote marks and whitespace normalised); mental-state verbs withhold the claim; new capitalised names, origin and change words, and other digits are flagged.

Retrieval took 0.1–5.3 s per question on the Mac. 4–6 passages were given. Index-line filtering (`GEN_MIN_BODY_CHARS = 80`) was **not** used in this run.

**The 12-question run (8 expected answerable, 4 expected unanswerable):**

| Id | Question | Verdict | Kept claims | Judgement (lab agent) |
|---|---|---|---|---|
| A1 | When did 'sample' start to mean a piece of a recording? | refused | 0 | right on this evidence (only a title record and "send for free sample"); a "when did it start" question |
| A2 | What did 'virus' mean in the 1880s books? | shown | 1 | supported |
| A3 | How is 'zero' used in song titles compared with books? | shown | 3 | 1 supported, 2 partly (reads an artist credit as a song title; adds glosses not in the passages) |
| A4 | What does 'bank' mean in the novels? | shown | 1 | supported but incomplete: **financial only** |
| A6 | What is a 'key' used for in telegraphy? | shown | 1 | supported |
| A8 | What does 'carry the zero' mean in the classroom documents? | shown | 1 | supported (planted sense recovered) |
| A10 | What did 'germ' mean in nineteenth-century science books? | shown | 1 | supported |
| A12 | What does 'banco' mean in the Spanish books? | shown | 1 | supported but incomplete: **bank only, no bench** |
| U3 | What did the 1880s books say about computer viruses? | refused | 0 | correct |
| U4 | Who first used 'bank' to mean a place that keeps money? | refused | 0 | correct |
| U5 | What is the population of Quellhaven? | refused | 0 | correct |
| U8 | In what year was the Bank of England founded? | refused | 0 | correct; two passages held years beside "Bank of England", and no year was written |

| Totals | Count |
|---|---|
| JSON parsed | 12/12 (no grammar) |
| answerable with ≥ 1 verified claim | 7/8 (A1 refused, correctly on its evidence) |
| unanswerable refused | 4/4, all by the model itself |
| claims / kept by the verifier / dropped / withheld | 9 / 9 / 0 / 0 |
| quotes verbatim | 9/9 |
| years in claim text · invented names · uncited claims | 0 · 0 · 0 |
| claims fully / partly / not supported (lab agent's reading) | **7 / 2 / 0** of 9 |
| prompt tokens | 658–1,054 (median 844.5); output 16–229 |
| Mac wall time per answer; peak memory | 1.6–4.0 s; **3.212 GB** |

**Thin evidence** (`make_thin.py`: every passage a kept claim cited is removed, and the question is asked again):

| Id | Removed / left | Verdict | What happened |
|---|---|---|---|
| A2 | 1 / 3 | shown | **Stitched quote:** "the virus communicated by Jenner himself" (the passage reads "The original virus communicated by Jenner himself!"). `ask.py` marked it not_found **but kept the claim**. |
| A3 | 5 / 1 | refused | correct |
| A4 | 2 / 4 | shown | overreach: "financial institution" from one ambiguous line |
| A6 | 1 / 5 | shown | still well supported |
| A8 | 1 / 5 | shown | still well supported |
| A10 | 1 / 5 | shown | supported; the quote differs only in case |

Truly thin only for A2, A3 and A4: the model refused 1/3, answered from weak evidence 1/3 and fabricated a quote 1/3. Its own refusals are good when a question is clearly off-topic (4/4), but not when the evidence is merely weak.

**Period slots instead of dates** (prompt `slots2`, same 12 questions and passages; `{A}`, `{B}`, … one per decade in date order, `{U}` undated):

| | dated2 | slots2 |
|---|---|---|
| answerable with ≥ 1 verified claim | 7/8 | 7/8 (A1 refused in both) |
| unanswerable refused by the model | 4/4 | 4/4 |
| claims / kept / quotes verbatim | 9 / 9 / 9 | 13 / 13 / 13 |
| claims fully / partly / not supported | 7 / 2 / 0 | 11 / 2 / 0 |
| claims containing digits | 0 | **1** (A2 "In the 1880s", echoed from the question) |
| prompt tokens | 658–1,054 | 690–1,091 |
| Mac wall time per answer | 1.6–4.0 s | 3.4–37.3 s (heavier load at that moment) |

- Verdicts were identical on all 12 questions. slots2 wrote more claims and hedged better ("In some novels").
- **The digit ban was not exercised:** `masked_steps = 0` on all 12. In mlx-lm 0.31.3 a logits processor receives a token history that starts at the last prefill chunk, so `ask.py`'s slice at the full prompt length was always empty. `ask.py` was fixed afterwards; **no re-run is logged.** The label-lab ban (`gen.py`, an unconditional mask) was unaffected and real.
- The name heuristic falsely flagged sentence-initial "Pressing" and "Releasing".

**Failure modes seen:**
1. **Retrieval collapses onto one sense.** Top-6 by cosine to the question gave only the financial sense of *bank*, although the river group is the larger one in the quick clusters (137 against 103); and only "bank" for *banco*, although "bench" is 87 of 160. The answer is grounded but unrepresentative.
2. **Index and heading lines take passage slots:** "Germ theory, 51, 98", "Horse Virus Vindicated, xvii", "Bank-cress, 327".
3. **Glosses beyond the passages** ("conceptual starting point") pass every mechanical check.
4. **Stitched or case-changed quotes** (thin run): 1 not found, 1 case-only.
5. **Field confusion:** an artist credit read as a title (A3).
6. **Answering from weak evidence** instead of refusing (thin A4).

Not seen: invented years, invented names, uncited claims, mental-state claims, truncated output (`finish = length` 0 times).

**LAB-8 as measured:** unanswerable refused 4/4; answerable with ≥ 1 verified claim 7/8 (88%). Both of the draft's thresholds are met on this set, but n = 12 (the draft asked for 30 + 20), and the thin-evidence run shows the gap the verifier must close.

### 3.6 The generation area's recommended guards (in substance)

1. Grammar-constrained JSON for both tasks. Labels: `label` a string of ≤ 5 words, `description` a string, no `kind` enum. Ask: cites from the enum of given ids, ≤ 4 claims.
2. A deterministic Swift verifier decides what is shown:
   - every cite is a given id, else drop;
   - **a hard quote gate:** the quote must occur in `quote_from` (which must be cited) after NFC, quote folding and whitespace collapse, compared case-insensitively; not found → drop the claim;
   - every year or decade must overlap a cited passage's dates, else drop, or ban digits in free text (free: identical outputs);
   - capitalised names not in the passages or the question → withhold (skipping sentence-initial words); mental-state verbs → withhold; origin and change words → caveat;
   - a grammar digit ban must know where the prompt ends; test it with a question that invites a year (the 1880s question);
   - each kept claim shows its quote highlighted at its exact offset, labelled machine output.
3. Refuse before the model when FTS returns 0 passages; otherwise let the model refuse.
4. **Retrieval:** when the expression has context groups, fill the 6 slots stratified by group (≥ 1 per group) and by period; drop body passages under 80 characters.
5. **Labels:** one call per group; always show the distinctive words beside the machine label.
6. **Prompt budget:** Ask with 6 passages at ±40 words = 658–1,054 tokens, so a 1,024 cap fails 2 of 12 (A8 1,054; slots A8 1,091): use ±32 words or a 1,280 cap. Labels ≤ 577 tokens per English group; Hindi needs ≤ 4 passages or ±16 words to stay under 1,024.
7. **Peak memory on the Mac** (MLX, cache included): 2.97–3.21 GB at 395–1,112 prompt tokens.

---

## 4. The exact prompts and templates the lab used

### 4.1 Embedding inputs (`senses-scripts/common.py` `fmt`; `generation-scripts/build_clusters.py`; `retrieve.py`)

`<left>`, `<mid>` and `<right>` are the window's text around the target span (whitespace collapsed); `<kind>` is `word`, or `expression` when the target contains a space. The tokenizer's post-processor appends `<|endoftext|>`, and the vector is the hidden state of that last token.

```
plain:  <left><mid><right>
instr:  Instruct: Represent the meaning of the <kind> '<w>' in this passage
        Query: <left><mid><right>
mark:   Instruct: Represent how the marked expression is used in this passage.
        Query: <left>«<mid>»<right>
```

- `build_clusters.py` (the generation area's quick groups) used `instr` over a ±40-word window.
- **Ask retrieval, query side:** `Instruct: Given a question, retrieve passages that answer the question\nQuery: <question>`. Document side: the ±60-word window with no instruction, truncated to 320 tokens, plus `<|endoftext|>`, batch 8.

### 4.2 Pseudo-word benchmark (prepared, **not run**)

`run_pseudo.py`: six words (church, ocean, horse, doctor, kitchen, winter), all 15 pairs, 400 sampled occurrences of each, Cipher literature and STEMM text; the target masked by one shared nonce ("blicket", keeping plural, possessive and capitalisation); centred if the analysis says so; k = 2; ARI against the true word. Yardstick: PPMI-SVD 1.1.0, Cipher mean 0.302 (lowest 0.13), STEMM text 0.502 (lowest 0.23). Configs `base` (q8, ±32, instr), `q4`, `w64`, `wp`, `plain`, `mark`; analyses 256/1024 × centred yes/no; `gatecal=1` also runs the full k rule on each pair and each single word. Resumable from `senses.jsonl`.

### 4.3 Labels (`generation-scripts/labels.py`, `demo_labels.py`, `ml_labels.py`)

**System** (all label variants):
```
You label groups of uses of one word, found by a computer in a corpus of old books and other texts. Use only the passages given. Do not add names, dates, places, events or facts that are not in the passages. Reply with JSON only.
```
For the demo, the system message gains: ` The passages come from a synthetic demonstration corpus (an invented town and invented people).`

**User, one group per call (V1; V2 adds `(<title>; <author or "unknown author">; <year or range or "undated">) ` before each passage):**
```
Word: "<w>"
Words that often appear near "<w>" in this group (computed): <top 10 words, comma-separated>
Five passages from this group:
[P1] <±25 words around the match, "… " / " …" where cut>
…
[P5] …
Return JSON: {"label": "<at most 5 words naming the sense of '<w>' in this group>", "description": "<one sentence describing how '<w>' is used in these passages>"}
```
The demo uses `Expression: "carry the zero"` and the same lines (passages ±25/+27 words, 120 output tokens max). The multilingual prompt writes `Word: "<w>" (<language name>)`; its native variant asks for `"label"` (at most 5 English words), `"label_native"` (the same label in the language, at most 5 words) and an English `"description"`.

**User, all groups in one call (V3):**
```
Word: "<w>". A computer split its uses into <n> groups. For each group: the words that often appear near "<w>" in that group (computed), then example passages with ids.

Group G1. Nearby words: <top words>
[P1] …   (4 passages per group, ids running across groups)

Return JSON: {"groups": [{"group": "G1", "label": "<at most 5 words, no digits>", "gloss": "<one sentence, no digits>", "cites": ["<2 to 4 passage ids from this group>"], "kind": "usage | one_source | register_or_spelling | unclear"}, ...]}. Use "unclear" if a group mixes different senses.
```

### 4.4 Ask (`generation-scripts/ask.py`, rules version 2)

**System** (`<when>` = "its date from the library record" for `dated2`, "its period slot" for `slots2`):
```
You answer questions about how words are used in a collection of texts, using ONLY the numbered passages given to you. Each passage comes with its id, <when>, its source and its text.
Rules:
1. Every claim must cite the ids of the passages that support it.
2. Each claim must include one short quote (at most 20 words) copied exactly, character for character, from one of the passages it cites, and name that passage in quote_from.
3. Do not use any knowledge that is not in the passages: no outside facts, names, places or dates.
4. [dated2] Mention a year only if it is the date of a passage you cite.
   [slots2] Passages carry a period slot such as {A} instead of a date; {A} is the earliest period, {B} the next, and so on; {U} means undated. Never write digits in a claim. Refer to a period only by its slot, and only the slot of a passage you cite.
5. Do not say what any person thought, felt, believed, wanted or intended.
6. If the passages do not answer the question, set "answerable" to false, return an empty claims list and give the reason.
7. A question about what a word means or how it is used is answered by describing how the passages use it, with quotes; a passage does not need to define the word. Use the passages that are relevant and ignore the others.
8. Set "answerable" to false only when no passage uses the words of the question in the sense the question asks about, or when the question asks for something the passages cannot show: who was first, when something began, how many, or what someone thought.
9. Keep each claim under 30 words and each quote under 20 words.
Reply with JSON only.
```

**User:**
```
Question: <question>

Passages:
[P1] date: <date label or "undated">  |  [slots2: period: {A}] | source: <source> [(<field> field)] | title: <title>
text: <±40 words around the first match>
…

Return JSON only, in this shape: {"answerable": true or false, "claims": [{"text": "<one sentence>", "cites": ["P1"], "quote": "<exact words copied from one cited passage>", "quote_from": "P1"}], "reason": "<one sentence: why the passages do not answer the question, or empty>"}. At most 4 claims.
```
Source names: "book (Project Gutenberg)", "science book (Project Gutenberg)", "scientific paper record (OpenAlex)", "record of a film, song or other work", "song record (sampling links)", "synthetic demonstration corpus", "Hindi Wikisource text", "Gujarati Wikisource text". Decoding: greedy, `max_tokens` 320.

---

## 5. Slot by slot: the measured value and the decision it drives

The decisions are adopted in `Docs/IOS-SPEC-QWEN.md` (§0.4 there repeats this table with the spec's section numbers).

| Slot | Draft's assumption | Measured (Mac) | Decision |
|---|---|---|---|
| LAB-1 embedder | 4-bit DWQ if ARI within 0.02 and cos ≥ 0.98 | cos 0.952 (fails); not faster; demo ARI equal; *bank* silver 0.942 vs 0.928 | **ship 8-bit** (`fe956e8d`) |
| LAB-2 representation | R1 = `mark` template | real words all measured with `instr`; demo: styles equal within 0.012 ARI; R3/R4 and pseudo-words not run | **R1 = `instr`** template; pseudo-word acceptance still owed (gate) |
| LAB-2b centring | yes | neutral (demo ±0.013 ARI; *bank* silver equal) | yes |
| LAB-3 window | ±32 Qwen tokens | *bank* only: ±32 best (0.942 > 0.872 > 0.818) | ±32-token equivalent, defined in words; English only at M1 |
| LAB-4 width | 256 within 0.02 of 1024 | not met, both directions (±0.02–0.09) | 256 for storage; claim dropped; thresholds per key |
| LAB-5 gate | floor 0.10, above the reference, stability 0.6 | floor 0.10 passes everything at 256; stability 0.6 admits subject splits; rule_v2 sorts the 12 runs as the lab agent judged them | **rule_v2**, provisional, frozen per key; pseudo-word calibration owed |
| LAB-6 throughput | embedder 600–2,000 tok/s; prefill 150–300; decode 12–20 | est. 800–1,600 tok/s; prefill **60–120**; decode **9–15** (≥ 8.6 measured on the phone) | timing copy and ETAs from the live device rate |
| LAB-7 labels | ≥ 80% acceptable to him | 12/14 (86%) by the lab agent; one call per group better | one call per group; his judgement on ≈ 20 labels before auto-labelling defaults on |
| LAB-8 Ask | ≥ 90% refusal; ≥ 1 kept claim on ≥ 80% | 4/4; 7/8 on 12 questions; 2/9 claims only partly supported; stitched quote; one-sense retrieval | hard quote gate; stratified retrieval; Ask ships only on his semantic-support judgement |
| LAB-9 memory | 4B ≤ 3.0 GB at 2k; embedder ≤ 0.8 GB at 16 × 128 | 4B 2.938 GB at 1k/step 256, 3.126 at 2k/256, 2.964 at 2k/128, 3.086 at 1k/512; embedder 1.249 GB at 8 × 64, 1.520 at 8 × 128, 1.537 at 16 × 128 | step 256 ≤ 1,024 tokens, 128 above; M1 cap 1,024; embedder batch 8; no `kvBits` |
| LAB-10 determinism | byte-identical; Swift = Python cos ≥ 0.999 | Mac greedy 6/6 byte-identical across two processes; no Swift parity yet | byte identity per batch plan; cos ≥ 0.999 across plans and against Python |
| LAB-11 stance κ | κ ≥ 0.4 | not measured | stance stays off |
| LAB-12 τ | per-run p99 + floor | *bank* only: p99 0.8517 (256 d) | M3; recalibrated per key |

---

## 6. Not done: follow-ups as short, resumable Mac tasks

Each is a task of `Docs/IOS-SPEC-QWEN.md` §7 (the `LQ-n` rows there), resumes from done-markers in its `.jsonl`, and needs no download.

| Follow-up | Script | Why it matters |
|---|---|---|
| pseudo-word benchmark and gate calibration | `run_pseudo.py scope=cipher-en gatecal=1`, then `scope=stemm-en` | the only calibration of the gate (LAB-5) and Qwen against PPMI-SVD (LAB-2) |
| rule_v2 on the R1 key (±32-token equivalent, instr, 256 d) | `rule_v2.py` with the window argument | the gate's thresholds were read at ±64 tokens; the app's key is different |
| *spring* / stemm-en under rule_v2 | `rule_v2.py spring:stemm-en` | the 13th run is missing |
| uncapped refit of two STEMM words (*cell*, *spring*) | `run_words.py` with `per_doc` unbounded | whether one-book groups appear without the per-document cap |
| the Ask digit ban, re-run | `ask.py slots2` with the fixed processor | the ban was never exercised (`masked_steps = 0`) |
| R3 / R4 representations | `run_r3.py` | optional; only if pseudo-words fail R1 |
| Spanish, French, Hindi and Gujarati words in the senses area | `run_words.py` | groups stay English-only until measured |
| everything on the phone | the M1a probe (IOS-SPEC-QWEN §7) | every number above is a Mac number |
