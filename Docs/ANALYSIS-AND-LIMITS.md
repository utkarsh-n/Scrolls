<!-- OWNER: WP4 — what Scrolls computes, how, and when it refuses to (SPEC §2.E, §4.6–4.12, §10.4, §13); P2 text of WP4a + WP4b merged at the M5 gate -->
# Analysis and its limits

Scrolls counts before it estimates, and it estimates only when a gate says the evidence is enough. A measure that fails its gate has **no value**: the API returns `{gate, needed, have, suggestion, value: null, ci: null}` and the UI shows the gate card, never a number (SPEC I4, §13 rule 7). The database enforces the same rule for stored drift results (`drift_result` CHECK). Change is always called an **"estimated shift in usage contexts"**; neighbouring words are **"context words, not meanings"**.

| Part | State | Where |
|---|---|---|
| Compare: multiplicity, coverage, composition, modality, prominence, frequency + exact CIs, passages, collocates + keyness, gates with widening suggestions | built | `analysis/compare.mjs`, `POST /api/compare` |
| Collocations endpoint and stored collocation runs; token streams | built | `collocations.mjs`, `tokstream.mjs`, jobs `collocations`, `tokstream` |
| PPMI–SVD spaces: pooled per language and era slices, Procrustes alignment of neighbouring eras | built | `cooc.mjs`, `ppmi.mjs`, `rsvd.mjs`, `linalg.mjs`, `occvec.mjs`, job `vectors` |
| Occurrence vectors (for context groups) | built | `occvec.mjs` (`occurrenceVectors`, `occurrenceTokens`, `pooledSpaceFor`) |
| Context groups (clustering, stability, labels, windows, shares, transitions, convergence) | built; on real data 35 of 45 PPMI-SVD runs of 15 polysemous words found groups (§7) | `cluster.mjs` + `kmeans.mjs`, `kmeans-pool.mjs`, `stability.mjs`, `labels.mjs`, `transitions.mjs`, `convergence.mjs`, `tfidf-hash.mjs`; job `cluster`; `GET /api/clusters` |
| Constellation (stable layout, two periods) | built | `layout.mjs`, job `layout`, `GET /api/constellation` |
| Drift (a) context-share shift | built: computed in Compare from a clustering run | `drift.mjs`, `compare.mjs` |
| Drift (b) neighbour overlap and (c) aligned displacement, controls, verdict | built: computed by a `drift` run, read by Compare | `drift.mjs`, `procrustes.mjs`, job `drift` |
| Machine tone through the optional on-device adapter | built (the adapter is optional) | `tone.mjs`, job `tone`, `tools/nl-adapter/` |
| OpenAlex within-cell presence shares in Compare | built | `compare.mjs` (`within_cell`) |
| External baseline ρ in Compare (§10.2) | built (needs the staged Ngram store) | `baseline-rho.mjs`, `compare.mjs` (`baseline_rho`) |
| Analysis jobs write only at the end, in short retried transactions, and refuse to store when their inputs changed | built; running them outside the writer slot needs the `JOB_TYPES` change in §6 | `commit.mjs`, every WP4 task |

Start any run with `POST /api/analysis/runs {stage, params}`:
- `vectors` takes `{lang, corpora? | collections?, scope?: 'all'|'pooled'|'era'}`; `collections` builds a space from named collections only (e.g. `["stemm-openalex"]`).
- `drift` and `tone` take the Compare request (`{expr, a, b, toggles?, corpus?}`).
- `cluster` takes `{expr | expressionId, representation?: 'auto'|'tfidf-hash-4096'|'ppmi-svd-pooled', with?, collections?}`; `collections` (slugs of one medium) chooses what is clustered (§7).
- `tokstream`, `collocations`, `layout` and `reuse-index` pass through to their tasks.

When a gate's evidence passes but its run is missing, the card carries `suggestion.run = {stage, params}`, which is exactly the body to post.

## 1. Slices and what counts
- **Fit-or-wash.** A document is in a slice only if its whole date interval lies inside the slice's years. One that overlaps without fitting is a *wash*: it is left out and counted. Undated and scheduled documents never enter a slice; the undated share of the documents matching the filters is reported.
- **Counts** are `expr_doc.n` of the expression's current materialize run (`expression_state.run_id`, read only when that run succeeded). They exclude proper-noun-guard hits unless `nm=1` and count only `quality='ok'` passages.
- **Denominators** are `doc_tokens` of the same documents, field classes and languages. The strand's languages are its variants' languages plus the unidentified buckets of their script: `und` and `und-Latn` for Latin script, `und` for scripts without a language profile, and none for Devanagari and Gujarati, which language ID always identifies by script (fix pass: a Gujarati word was divided by the unidentified tokens of Latin-script books — 40% of Compare's slice A for શૂન્ય, and false "absent" cells on the Scroll). Compare reads the timeline's own rule (`materialize.strandLanguages`), so its `freq.n` and denominators equal the tiles'. **Limit:** for Latin script, 'und' passages of other-language books (headings, verse numbers, old spellings in es/fr books) still count toward an English word's denominator and coverage documents (Cipher *machine* 1875–1899: 76 of 148 coverage documents are es/fr books adding 166k 'und' tokens).
- **Field classes:** text → `text`; titles → `title`; abstracts → `abstract` + `title`. `describes` and `apparatus` are excluded unless `ds=1`/`ap=1`, and their matches are counted.
- **Default exclusions, each counted:** translations (`tr=0`), duplicates (`dup=0`), estimated dates (only when `est=0`), washes, names, other media, and collections that are not rate-eligible. `bp=1` cannot add boilerplate back.
- With two expressions, counts pool both. Context groups and the drift measures need one expression.

## 2. Compare, panel by panel
**0. Multiplicity.** `compare_log` has one row per distinct comparison per session and expression set; reshuffling does not count. With *k* comparisons the notable threshold is the **(100 − 5/k)th percentile**, disclosed with the §2.E sentence. A comparison whose aligned displacement is "notable" is logged as notable, so later comparisons say how many crossed the threshold.

**1. Coverage and composition.**
- **Per slice:** tokens or works, documents, authors, translations and translation share, undated share, date-basis mix, prominence terciles, kind/language/collection mix and stack, media present, exclusions, declared selection (§13 rule 14).
- **Composition JSD** (base 2, kind × language × collection, denominator-weighted): above 0.15 it fires the caveat and adds directly standardized rates (pooled stratum weights over the strata both slices cover, with the covered weight reported). Above 0.4 it suppresses aligned displacement.
- **Modality:** each slice's dominant medium holds ≥ 80% of its matches (or of its documents when there are no matches). Different dominant media → `modality_mismatch`, refused by default. `override: "descriptive"` shows each rate in its own unit with no ratio, test or verdict.
- **Prominence:** a tercile points up or down when its exact rate-ratio CI excludes 1. Terciles pointing both ways fire 'result depends on prominence stratum'.
- **Slice spaces** (`coverage.spaces`) list:
  - the strand language's pooled space, if one was built;
  - whether the language could have one (`pooled_gate`), with a suggestion to build it;
  - its era slices, computed now from the corpus (§3);
  - the §4.8 sentence when fewer than two slices are eligible, e.g. "Aligned displacement unavailable for English: no eligible slice (1889–2026 has 94.2k tokens; needs 3M)".

**2. Frequency.**
- **Rates:** tokens per million with the exact Garwood interval; works per 1,000 with Wilson. Also Gries' DP, documents and authors with a match, and the top-document share.
- **Coverage gate:** 50,000 tokens / 30 works / 20 sampled works, or the strictest `coverage_gate` among the slice's collections ('low coverage: n = 3 in 18k tokens').
- **Rate ratio** (B over A, same unit only): exact conditional (Clopper–Pearson on n_B of n_A + n_B). With n_A = 0 it is unbounded.
- Token counts a slice *has* are printed without rounding up ("2.99M tokens; needs 3M").

**OpenAlex (top-cited samples, §10.4).**
- Cross-cell rates, ratios and drift are refused (`sampling_design`): "OpenAlex is a top-cited sample per field × period; cells are not comparable as rates."
- Instead `within_cell` lists, for every OpenAlex cell (field × OpenAlex's own period bin) whose bin fits a slice:
  - k of n sampled works whose title or abstract mention the expression;
  - the share, with a Wilson 95% CI;
  - how many of the n have an abstract ("3 of 3 · abstracts for 2").
- The cell comes from the work's `sample_cell`, which the adapter stores. Without it, the cell is the document's field plus the bin of its year.
- Shares are shown side by side, never as a rate, ratio or trend across cells. On the Scroll, OpenAlex lanes carry counts without rates (contract 1.2.0).

**External baseline (`baseline_rho`, §10.2).** "Does our sample track a larger corpus?" Spearman ρ between the strand's per-decade rate in the compared running text and the Google Books Ngram rate per million over the same decades.
- **Only** one English single-word strand, running text on both sides (not titles, not OpenAlex cells), decades up to 2019. Otherwise `{available: false, reason}` (e.g. "the Ngram store holds single words only").
- **Decades:** the calendar decades lying wholly inside the span of the two slices. With the same filter on both slices every such decade is measured under it; with different filters a decade is measured under the slice it lies in, and decades between the slices are skipped.
- **A decade counts** when our slice text there meets the rate gate (50,000 tokens, or the collections' own gate) **and** Google's decade rests on ≥ 500 books. A decade below our gate shows its count and tokens and no rate.
- **Gate:** ≥ 8 such decades, else `insufficient_coverage` with no ρ ("Not compared: 5 decades between 1875 and 1928 have enough text here and in Google Books (needs 8)"). A rate that is the same in every decade has no ρ either (`insufficient_occurrences`).
- **Forms:** our counts pool the strand's enabled English variants, so the baseline sums the same word forms (matches of each form over the same yearly totals); forms missing from the store are listed.
- **Interval:** moving-block bootstrap (blocks of 3 decades, 1,000 resamples, seed 42; Künsch 1989), 95% percentile interval — neighbouring decades are not independent.
- Every value carries the series, the label and attribution of the store (CC BY 3.0) and the note *"Different corpus, different composition"*. ρ says whether the two series rise and fall together; it is a check of our sample, not evidence about meaning or influence.
- **Payload** (`baseline_rho`): `{available: true, gate, value, ci, n_bins, span, series[{decade, slice, n, tokens, rate, low_coverage, baseline_per_million, volumes, thin, shared}], forms, forms_missing, unit, label, attribution, license, method, note, text}`; gated: the same with `value: null, ci: null` and `{needed, have, suggestion}`; impossible (a phrase, another language, titles, OpenAlex cells, no store): `{available: false, reason, note}`.
- **Measured on the STEMM clone** (Gutenberg text only, slices meeting at the boundary year, k = 1):
  - Cipher *machine*, 1800–1874 vs 1875–1928: ρ = 0.90 [0.29, 0.92], 12 decades (1800–1919).
  - Cipher *bank*, 1800–1859 vs 1860–1928: ρ = 0.32 [−0.76, 0.41], 12 decades.
  - Cipher *war*, 1700–1849 vs 1850–1928: ρ = −0.17 [−0.71, 0.28], 19 decades (three decades of the 1730s–1770s are below our rate gate and are not counted).
  - Gutenberg STEMM *current*, 1800–1879 vs 1880–1928: ρ = 0.61 [−0.01, 0.94]; *virus*: ρ = 0.25 [−0.37, 0.75] (its 1880s rate rests on a few books).
  - Cipher *machine*, 1900–1914 vs 1915–1928: gate card, "2 decades … (needs 8)".
  - With 12 decades and blocks of 3 the intervals are wide; only *machine* clearly tracks the larger corpus.

**3. Passages.** At most 5 per slice and 1 per document, drawn with a printed seed; a new seed reshuffles. KWIC ±12 tokens. Not stratified by context group.

**4. Neighbouring terms — context words, not meanings.**
- **Window:** ±5 tokens, clipped at the passage; flagged names have no window.
- **Significance:** f(x,y) ≥ 5, f(y) ≥ 10, G² ≥ 10.83, BH q < .05, attraction only. logDice ranks; PPMI (α 0.75) is a second column.
- **Stop-words** are hidden and counted (`stop=1` shows them).
- **Output:** A-only, B-only and shared columns; keyness (Hardie log ratio, G², BH); new and declining uses.
- **Gate:** ≥ 20 matches per slice.
- **Sources:** current token streams; else on-the-fly tokenization up to 2M tokens; else `not_run` with `suggestion.run = {stage: 'tokstream'}`. That decision is now made from the denominators, before any passage is read.

**5. Context groups** (how they are computed: §7).
- **Gate:** ≥ 60 occurrences in ≥ 5 documents over all of the expression's matches, for one expression.
- **With a succeeded clustering run of the expression** (the `cluster` job stores `sense_cluster` + `cluster_member`), Compare shows:
  - each group's machine label, with any human rename next to it;
  - its share of the grouped occurrences per slice, with a **document-block bootstrap 95% CI** (1,000 resamples, seed 42);
  - "new uses" (A < 2%, B ≥ 10%) and "declining" ones.
- **Without a run:** `not_run`, with the run suggestion.

**6. Estimated displacement.** Three named measures, each reported with n, documents and authors per slice.

- **(a) Context-share shift:** JSD (base 2) between the two slices' context-group share distributions, with a document-block bootstrap 95% CI (each slice resampled by document).
  - Evidence gate per slice: ≥ 50 occurrences, ≥ 5 documents, ≥ 3 authors, top document ≤ 50%.
  - Then a clustering run with ≥ 2 non-residual groups (else `no_cluster_structure`).
  - Then ≥ 50 *grouped* occurrences per slice. Occurrences with fewer than 3 usable context words are not grouped.
  - Example: "Context-share shift JSD 0.21 [0.14, 0.29] · n = 212 / 388 · 31 / 54 documents — an estimated shift in usage contexts."
- **(b) Neighbour overlap:** the word's top-25 neighbours (cosine) in each slice space, both searched among the words the two spaces share. The value is 1 − Jaccard; the Jaccard itself is also reported.
  - Evidence gate: ≥ 50 occurrences per slice and ≥ 3M running-text tokens per slice (translations removed).
  - The drift run adds: the word has f ≥ 50 in both slice spaces, and there are ≥ 50 controls.
- **(c) Aligned displacement:** 1 − cos(W_A[x], R·W_B[x]), with R = UVᵀ from the SVD of AᵀB over anchor words (orthogonal Procrustes).
  - Evidence gate: ≥ 3M tokens, ≥ 100 occurrences, ≥ 20 documents and ≥ 5 authors per slice, and composition JSD ≤ 0.4.
  - The drift run adds:
    - f ≥ 100 in both spaces;
    - **≥ 3,000 anchors**: shared words with f ≥ 100 in both slices, excluding the target and its top-20 neighbours in either space, at most the 5,000 most frequent;
    - a **mean anchor cosine ≥ 0.5** after rotation.
  - Otherwise the result is `unaligned`.
- **Controls:**
  - up to 500 words in the same frequency decile as the target in both slices (deciles by rank among the shared words);
  - never among either slice's 100 most frequent words;
  - at least the measure's minimum frequency;
  - chosen with a fixed seed.
  - (b) and (c) report the target's percentile among them.
  - For (c), every control is measured **out of sample**: the controls are split into 5 folds, and each fold is aligned on anchors that exclude it (and the target and its neighbours).
- **Verdict:** "notable" only when (c)'s percentile ≥ 100 − 5/k **and** (b)'s Jaccard ≤ 0.2; otherwise "within typical variation". There is no verdict when either measure is gated. Example: "Aligned displacement 0.37 · 97th percentile of 500 frequency-matched controls · neighbour overlap 0.12 → notable · n = … — an estimated shift in usage contexts."
- **Where the values come from:**
  - (a) is computed by Compare at request time.
  - (b) and (c) need two slice spaces, which take minutes, so a `drift` run builds them: one space per slice, from exactly the slice's documents in the compared medium, translations removed. Each needs ≥ 3M tokens, ≥ 10 documents and ≥ 5 authors, else `slice_too_small`. The run computes the measures and stores every one, gated or not, as `drift_result` rows.
  - Compare shows a stored result only when both of these match the current request:
    - the run's parameters equal this comparison: expressions, both slices with their filters, toggles, corpus;
    - its input fingerprint equals the current data: the slices' collections' committed imports, the quality version, the tokenizer, and the expressions' materialize runs.
  - Otherwise the measure is `not_run`, with the suggestion to start the run.
  - Compare computes the verdict with the session's k.
  - Only single-word expressions have a row in a word space. A phrase gets `not_run`, with that reason.

**7. Tone and stance.**
- Machine tone needs the optional adapter (§5).
  - Without it: "Tone needs the optional on-device adapter (not installed)".
  - For a language its probe does not list: "Tone is not available for Gujarati".
- Otherwise a `tone` run scores every paragraph (passage) holding a counted occurrence in either slice: at most 2,000 per slice, with a seeded sample beyond that.
- Compare shows per slice:
  - n paragraphs and documents;
  - the mean, with a **document-block bootstrap 95% CI**;
  - SD, median and a 10-bin histogram over −1…1;
  - the label "Apple NLTagger — modern reader model, fallible, anachronistic for historical text".
- Fewer than 30 scored paragraphs in a slice → `insufficient_occurrences`, with no numeral.
- Stance and pragmatic function are counted from human annotations only. Nothing infers irony.

**Widening suggestions.** The failing slice grows in 10-year steps: first the end away from the other slice, then the end toward it, then both. It never grows into the other slice or past the collections' dated coverage, and the suggestion reports what the slice would have. When nothing passes: `suggestion: null` and 'no widening inside this corpus reaches the gate'.

**8. coverage_note** lists every caveat that fired: composition, mixed media, low coverage, undated ≥ 20%, washes, translations, names, estimated dates, selection, prominence, OpenAlex sampling (with the within-cell sentence), overlapping slices, pooled expressions, synthetic data.

## 3. Vector spaces (job `vectors`, §4.8)
- **What a space is built from:** running text (`text` and `abstract` field classes, `time_role='document'`, `quality='ok'`) of one passage language. Documents must not be deleted, translations or duplicates.
  - The pooled space uses every such document of the chosen corpora (default: every corpus that is not synthetic), or of the named collections (`collections`: a per-collection space, e.g. OpenAlex abstracts alone).
  - Which pooled space a scope uses: one built from exactly the scope's collections, else the smallest one that holds all of them, else the newest that holds any (`pooledSpaceFor`).
  - An era slice uses the dated documents whose interval fits its years.
  - A Compare slice uses exactly that slice's documents.
  - A space is identified by its document set, so an era slice and an identical Compare slice share one run.
- **Gate** (the pooled space and every slice): ≥ 3M tokens, ≥ 10 documents, ≥ 5 authors, translations removed. The pooled space and the era list are reported even when they fail, with what they have.
- **Era slices** are contiguous and built greedily from the earliest dated year. A slice ends the year before the first preferred boundary (1800 · 1850 · 1875 · 1900 · 1929, then the last dated year) at which it passes the gate.
  - A remainder that never passes is listed as not eligible with its numbers, not merged.
  - Fewer than two eligible slices → "Aligned displacement unavailable for Spanish: one eligible slice (1825–1874 has 2.95M tokens; needs 3M)".
  - No slice count is promised in advance.
- **Vocabulary:** targets are the types with f ≥ 20 in the selection (at most the 50,000 most frequent); contexts are the 10,000 most frequent types. Stop-words are included; PPMI down-weights them.
- **Counting:**
  - Window ±4, symmetric, clipped at passage boundaries, over the token-id stream (`derived/tokens/<lang>.u32`). The stream is rebuilt first when it is older than the data.
  - Pairs are counted in typed-array open-addressing tables sharded by target mod 8 (u32 key target·C + context + 1, exact u32 counts). Tables start at 2²³ slots and double past 70% load.
  - Up to 8 worker threads share the ids through a SharedArrayBuffer. The same workers turn their rows into PPMI and write them into one shared CSR.
- **PPMI:** max(0, log(n(t,c)·Σf(c')^α / (f(t)·f(c)^α))), with α = 0.75 and margins from the counted table.
- **Randomized SVD** (Halko et al.): d = 256, oversampling 16, 2 power iterations, seed 42.
  - The range finder runs on Aᵀ (contexts are the small side), so every power-iteration QR is contexts × 272.
  - Then C = A·Q, a Householder QR of C, and a one-sided Jacobi SVD of its R.
  - The sparse products are split by row block (balanced by non-zeros) across worker threads. Results agree with a single thread to rounding and repeat exactly for a given thread count.
  - **W = U·Σ^½**, with rows L2-normalized.
- **Storage:**
  - `derived/spaces/<id>.f32` holds the vectors.
  - `<id>.vocab.tsv` holds row, word, frequency and passage document frequency.
  - `<id>.json` is the manifest: language, years, corpora, collections, tokens, passages, documents, authors, parameters, singular values, data version, `synthetic`.
  - There is one `vector_space` row per space, under a succeeded `vectors` run. Rows of other runs are never read.
  - Neighbouring eras are aligned: `align` runs, `space_alignment` rows with anchors and mean anchor cosine, and R in `derived/align/<id>.f32`.
  - Identical runs are reused.
- **Occurrence vectors** (Schütze 1998; used by context groups):
  - the IDF-weighted (log passages/df) mean of the pooled-space vectors of the ±10 context tokens (clipped at the passage) that are in the space, excluding stop-words and the target;
  - L2-normalized;
  - fewer than 3 usable tokens → `context_thin`, no vector;
  - representation `ppmi-svd-pooled`.
  - With no pooled space for the language (the demo, small imports), clustering falls back to TF-IDF-hash vectors.
- **Measured on the Cipher snapshot** (this Mac, while other processes held the load average between 400 and 900):
  - English pooled space: 36.0M tokens from 470 documents by 249 authors → 37,022 targets, 20.6M distinct pairs, 13.9M non-zero PPMI cells, built in 76 s.
  - Era slices: 1500–1799 3.45M · 1800–1849 4.16M · 1850–1874 3.72M · 1875–1899 5.98M · 1900–1928 18.3M tokens. 1929–2019 has 16k tokens and is not eligible.
  - The whole job (pooled space, five era slices, four alignments) took 5 min 0 s.
  - Anchor counts between neighbouring eras: 1,955 / 2,532 / 2,823 / 4,162, with mean anchor cosine 0.52–0.57. With whole-corpus anchors only 1875–1899 vs 1900–1928 reaches 3,000, so most aligned displacements between the small early eras will be `unaligned`.
  - Cancels were acknowledged as `cancelled` 215–245 ms after the request, during counting and during the SVD. No space row or file of a cancelled run remains.
  - M5 gate: on a fresh clone with the token stream current, the pooled-only English run (`corpora: ['cipher']`) took 36 s. A run cancelled during counting was `cancelled` 79 ms after the request, with no row or file left.
  - Per-collection STEMM spaces (this round, on the m5-stemm clone, load average 600–900): OpenAlex abstracts alone 9.36M tokens, 53,223 works, 18,445 targets, built in about 3 min; Gutenberg STEMM text (with its restricted part) 54.2M tokens, 644 documents, 420 authors, 48,648 targets, about 3 min.
- **Examples of computed results** (not claims about meaning): 'machine', 1875–1899 vs 1900–1928, Cipher text.
  - WP4b, Cipher text:
    - neighbour overlap: Jaccard 0.19 (1 − J = 0.81), 51st percentile of 500 controls;
    - aligned displacement: 0.71, 98th percentile of 500 controls, 4,139 anchors, mean anchor cosine 0.57 → "notable" at k = 1;
    - the drift run (two slice spaces of 6.0M and 18.3M tokens, after first rebuilding the English token stream) took 7 min.
  - M5 gate, Gutenberg filter only, k = 2:
    - Jaccard 0.136 (71st percentile);
    - displacement 0.605 (85th percentile, 4,142 anchors, mean anchor cosine 0.571) → "within typical variation";
    - drift run 100 s.

## 4. Token streams
- **Files:** `derived/tokens/<lang>.u32` (ids in passage order), `.pidx` (passage id, offset), `.vocab.tsv` (id = frequency rank, token, count), and a `.json` manifest (data version, tokenizer, byte order, counts, run id).
- Tokens are exactly those of `src/shared/tokenize.mjs` over the original text.
- A stream is fresh while the passages it holds are unchanged: its manifest records a content signature (highest passage id, import batches by status, the passage-quality version, tokenizer and segmenter). Counting an expression bumps the data version but changes no passage, so it no longer makes every stream stale (before, the first Compare collocates, convergence check or vectors run after any count asked for a 110M-token rebuild). Streams written before signatures fall back to the data-version rule once. The vectors and drift jobs rebuild a stale stream first.
- Files are renamed into place, so a cancelled build leaves the old stream intact.
- `openTokenStream(lang, {dir, ids})` is the lineage package's reader.

## 5. The optional on-device NL adapter (§4.10)
- **Build:** `npm run build:nl` (`tools/nl-adapter/build.sh`) compiles `main.swift` with `swiftc` into `$SCROLLS_DATA/bin/scrolls-nl` and writes its probe to `bin/scrolls-nl.probe.json`. macOS only; Scrolls works without it.
- **Protocol:** one JSON object per line on stdin and on stdout; an `id` in a request is echoed.
  - `{"op":"probe"}` → the languages with sentiment and word embeddings, the macOS build, and the embedding size.
  - `{"op":"sentiment","lang":"en","text":"…"}` → `{"score":-0.4}` (NLTagger `.sentimentScore` on the passage as one paragraph, −1…1).
  - `{"op":"neighbors","lang":"en","word":"virus","k":10}` → `{"neighbors":[{"word","distance"}…]}`.
  - Errors answer `{"error":"…"}`, and the adapter keeps reading.
  - Nothing leaves the machine.
- **On this Mac** (macOS 27.2, build 26B5091g):
  - the probe lists sentiment and word embeddings for **en** and **it** only;
  - the English word embedding has 300 dimensions, revision 1, and 57,171 words;
  - building takes about 3 s;
  - scoring 1,410 Cipher paragraphs took 33 s.
- **Storage:** every score is stored as an annotation:
  - `kind='machine_tone'`, `is_machine=1`, `method='apple-nltagger-sentimentScore'`;
  - the run's `model_version` is the macOS build;
  - the annotation is anchored to its passage by document, sha256, offsets and quote;
  - `dimensions.machine_tone` holds the score.
  - These annotations are listed with the machine annotations: fallible, not editable.
- It is a static, modern model, so using it on 1850s text is anachronistic, and the label says so every time.
- The neighbours operation exists for the "modern reader neighbours" of the variant panel; it is never used in clustering or drift.

## 6. Runs and responsiveness
- Every computed row belongs to an `analysis_run` (versions, parameters, scope, input fingerprint, seed). Identical requests reuse a succeeded run, and rows of runs that did not succeed are never read.
- Compare and collocations run in the read-pool workers; over 5 s → 503 QUERY_TIMEOUT.
- The vectors, drift and tone jobs run in job worker threads. Counting and sparse products run in up to 8 further workers, and the dense steps check for cancellation after every column. The cluster job runs its k-means fits in up to 8 further workers (`kmeans-pool.mjs`); every fit has its own seed, so any thread count gives the same clustering (tested).
- **How analysis jobs write.** The cluster, vectors, drift, tone, collocations, layout and tokstream tasks read and compute first and write their rows at the end. Each write — opening the run, the result rows in one transaction, closing the run — is retried while another connection holds the write lock (`commit.mjs`: retry on SQLITE_BUSY for up to 2 min, a cancellation checkpoint between attempts), so none of them needs to hold the lock while it computes.
- **The writer slot.** The queue still runs them one at a time with every other writing job, because `vocab.JOB_TYPES` declares cluster, vectors, drift, tone, collocations and layout `writes: true` and the queue takes that flag from the vocabulary, never from a task (a task cannot declare itself read-only, and `enqueue(..., {writes})` can only make a job exclusive). That is a contract change for the foundation owner: with `writes: false` for these six types the queue would run them as read-only jobs (≤ 2 at a time, beside any writer), holding the lock only for their commits — as the measurement below did. Nothing in the tasks has to change for it. **Final gate (2026-10-08): not changed.** The queue has no job dependencies, and pipelines rely on writer serialization for their order: the demo queues materialize (priority 1) → cluster (3) → the deferred label rename (9). As read-only jobs a cluster could start before its expression's count had finished, and the rename could run before any group existed. Declared dependencies (`enqueue(type, params, {after: [jobId]})`) must come first.
- **Inputs guard.** Beside other writers a job reads its inputs in several statements, so an import could commit between two of them. Inside the transaction that stores a run's rows, the cluster, vectors, drift, tone and collocations tasks first check that the run's input fingerprint (its collections' newest committed imports, the quality version, its upstream runs) is still the one it started on; otherwise nothing is stored and the job fails with `E_INPUTS_CHANGED` ("start the run again"). Under today's queue no import can commit while an analysis job runs, so the guard never fires; it is what makes `writes: false` safe (tested: an import into another collection passes, one into the run's own collection is refused).
- **Measured** (STEMM clone, load average about 870 from other processes): a `cluster` run (Cipher *bank*, PPMI-SVD, 3 fit threads) computed beside a bulk writer that took the write lock in 1.5 s transactions 100 ms apart (91 transactions; the lock was held about 94% of the time, as an import committing batches holds it). The run succeeded (k = 2) in 147 s. Its own writes waited for the writer's gaps (the step that opens the run and the store step took 1.3 s each, waits included), and the longest the writer ever waited for the lock was **181 ms** (median 0): the job held the lock only for its commits. Run as today's writer job, the same 147 s would have kept every import, materialization and adapter load queued.
- In tests, during six concurrent comparisons and during a vectors job on a generated 3M-token fixture:
  - /api/health p95 and event-loop delay p99 stay under 50 ms on an unloaded machine (on a CPU-starved machine the tests judge them against an idle probe, tests/helpers/latency.mjs);
  - a cancelled vectors job is `cancelled` within 500 ms, with no rows or files of its run left.

## 7. Context groups (sense hypotheses), transitions, convergence and the constellation

**What is clustered.** One expression with its enabled same-language variants, its counted occurrences (its succeeded materialize run, with the default exclusions: names, translations, duplicates, describes/apparatus passages, non-`ok` passages, other languages, collections that are not rate-eligible, each counted), **in one medium** and one representation, so shares are comparable across time without alignment. Job `cluster` (pipeline `cluster@1.1.0`); a request with the same params and input fingerprint reuses the succeeded run.
- **One medium per run.** The ±10-token context of a word in a novel, in a paper abstract and in a song title are different kinds of evidence; one model over all three groups them by medium, and the group shares would then follow the 1928 seam. A run clusters the medium holding most of the expression's occurrences and counts the rest as excluded (`other_modality`), with a note naming them; `params.collections` (slugs of one medium) chooses another, e.g. `["stemm-openalex"]`. The run's `scope` (modality, collections, sampled) is stored and returned by `GET /api/clusters`.
- **Top-cited samples (OpenAlex).** A scope holding a `top_cited_per_cell` collection gets context groups over the sample as a whole, but no windows, shares, transitions or convergence: those would compare separate field × period samples (`windows_gate: sampling_design`, §10.4).

**Representation.**
- **Context:** the ±10 tokens around the match, clipped at the passage, without stop-words, the expression's own words, tokens with no letter and — since 1.1.0 — the pieces the tokenizer leaves of English contractions (*don · t*, *i · ll*, *you · re*: not words, and markers of dialogue rather than of any use of the target). Fewer than 3 usable words → `context_thin` (excluded, counted).
- **`ppmi-svd-pooled`:** used when a pooled PPMI-SVD space of the language fits the run's collections (§3); occurrence vectors come from it. Since 1.1.0 each context word is weighted **idf × (1 + PPMI with the target)** (`weighting: 'idf-assoc'`): PPMI = max(0, ln((f(w near the target)/W) / (f(w)/T))) over the clustered contexts themselves, for words seen ≥ 3 times near the target. Every context word still counts; the words that co-occur with the target more than chance — Schütze's (1998) "local" features — count more. The evaluation behind the change is below.
- **`tfidf-hash-4096`:** used otherwise. FNV-1a-32 of the term mod 4,096, the sign from the hash's top bit, IDF ln((1+N)/(1+df))+1 over the clustered contexts, L2-normalized.
- The representation used is stored on the run and printed on every card. When a request could not be honoured, `representation_note` says why.

**Gate.** At least 60 non-thin occurrences in at least 5 documents, else `insufficient_occurrences` / `insufficient_documents`: "Clustering unavailable: 41 occurrences in 3 documents." The run succeeds with no group, and lanes fall back to language. Neither this gate nor the silhouette (0.10) and stability (mean ARI 0.6) gates below changed in 1.1.0; one criterion was added (the reference).

**Clustering and k.** Spherical k-means (cosine), greedy k-means++ initialisation, the best of 10 restarts, ≤ 100 iterations, seeded. k ∈ {1 … min(8, ⌊n/20⌋)}. For every k ≥ 2 Scrolls measures:
- the mean cosine silhouette (exact up to 2,000 points, else on a seeded sample of 2,000);
- stability over 30 subsamples of 80% of the documents, each re-clustered with the best of 3 restarts: per group, the mean best-match Jaccard (Hennig 2007); per k, the mean adjusted Rand index against the full clustering.

How k is chosen and what is kept:
- A k with mean ARI < 0.6 is rejected. Among the rest the largest silhouette wins.
- A best silhouette below 0.10, or no stable k, gives k = 1 and the gate `no_cluster_structure` ("No separable context groups: …").
- **Stability only where the rule needs it** (1.1.0). Every k is fitted and its silhouette measured; stability (90 re-clusterings) is then measured in order of falling silhouette, stopping at the first stable k — the rule's winner — or as soon as the silhouettes left are below 0.10, when no k can pass. The choice is exactly the exhaustive rule's (tested against it); a k never measured carries `stability_skipped` with the reason. *war* (Cipher, 5,000 fitted occurrences): the stability phase took 364 s with every k measured and 31 s now (whole run 375 s → 44 s, load average 700–900); the M5 gate's 210 s was the same work on a quieter machine. With this round's convergence and coverage changes the whole *war* run took 49.8 s with 4 fit threads while three other clustering batches ran (load average about 900): fits at every k 18 s (no stability needed: every silhouette is below 0.10), reference 3 s, convergence with 6 partner expressions 22 s.
- **Convergence and windows, this round.** A CPU profile of *current* (Cipher, 1,514 occurrences, 6 partner expressions) showed half of a 24 s run outside the clustering: the convergence step read the token stream one passage at a time and opened and closed the file for every read (4.9 s in `open` alone), counted every slice token by string, and the coverage index was read twice with a query the planner drove through every dated document of every corpus. Now a lazily read stream keeps its file open until `close()`, convergence counts slice frequencies on stream ids over runs of contiguous passages (tested equal to the text path), and the coverage index is read once, driven by the collections (same rows; 0.8 → 0.2 s on Cipher, 0.6 s → 6 ms on Gutenberg STEMM text). Convergence on *current* went from 12.6 s to 4.9 s under a heavier load (load average 999 against 541); the clustering itself is unchanged.
- **The fits run in worker threads** (up to 8, `kmeans-pool.mjs`); each subsample draws its documents and its k-means++ starts from seeds derived from (seed, subsample), so the result does not depend on the thread count (tested bit for bit; on real data four OpenAlex runs — *bank, board, virus, culture* — gave identical groups, silhouettes, stabilities and references with 1 and with 3 threads, on two clones). Under this round's load (load average 600–1000 on 10 cores) the pool brought no gain — choosing k for 1,500 × 256 synthetic points took 23 s in one thread and 31 s with six; it is meant for an idle multi-core Mac and was not measured on one.
- **Reference (1.1.0, a gate criterion added, none lowered).** k-means finds a positive silhouette in any elongated cloud, groups or not. The chosen k must also beat the silhouette the same k reaches on a cloud of the same shape without groups: for dense (PPMI-SVD) vectors a Gaussian with the data's mean and covariance put on the unit sphere (`gaussianReference`), for sparse TF-IDF vectors the coordinates shuffled independently across the points (`shuffledReference`, a floor). Otherwise `no_cluster_structure`: "k = 3 reaches silhouette 0.11, but a cloud of the same shape without groups reaches 0.12." The reference is stored on every run (`selection.reference`).
- Above 5,000 usable occurrences, the model is fitted on a seeded sample of 5,000 and every occurrence is assigned to its nearest centroid.
- Each member keeps its cosine to the centroid and its margin over the runner-up.
- Groups smaller than max(10, 5% of n) are `residual` ("other contexts"); stability below 0.5 is `unstable` ("tentative", dashed).

**Why the representation changed (cluster@1.1.0), and how it was checked.** Before 1.1.0 no real word had context groups: TF-IDF hash vectors never reach a silhouette of 0.03 on real text, and *war* in the pooled PPMI-SVD space stayed at 0.074. The gates were not touched. The representation was changed one step at a time, each step measured on the same evidence:
- **Pseudo-words** (Gale, Church & Yarowsky 1992; Schütze 1998): the occurrences of two different words are merged into one expression, clustered at k = 2, and the clustering is scored against the true word (ARI). Six words (*church, ocean, horse, doctor, kitchen, winter*), all 15 pairs, 400 sampled occurrences of each word, in two corpora with their own pooled spaces: Cipher literature text (the Cipher space) and Gutenberg STEMM text (the space built from it alone). "Reference" is the silhouette at k = 2 of the same vectors with every coordinate shuffled across the points. All rows were re-measured this round with the final context extraction (fragments are now dropped when contexts are read, so the "1.0.0" row is the 1.0.0 weighting on today's contexts; the first evaluation, with fragments, gave 0.194 there).

| Occurrence vectors (PPMI-SVD, ±10 unless said) | Cipher: mean ARI | lowest | kept | silhouette / reference | STEMM text: mean ARI | lowest | kept | silhouette / reference |
|---|---|---|---|---|---|---|---|---|
| idf-weighted mean (the 1.0.0 weighting) | 0.218 | 0.01 | 100% | 0.084 / 0.054 | 0.460 | 0.05 | 100% | 0.101 / 0.047 |
| only words with PPMI > 0 with the target (f ≥ 3), PPMI-weighted | 0.281 | 0.07 | 77% | 0.125 / 0.052 | 0.482 | 0.26 | 79% | 0.144 / 0.039 |
| only significant associates (G² ≥ 10.83, f ≥ 5) | 0.267 | 0.01 | 19% | 0.187 / 0.045 | 0.381 | −0.05 | 26% | 0.234 / 0.048 |
| **idf × (1 + PPMI with the target) (chosen, 1.1.0)** | **0.302** | **0.13** | **100%** | 0.106 / 0.057 | **0.502** | **0.23** | **100%** | 0.132 / 0.044 |
| the same, mean-centred | 0.314 | 0.15 | 100% | 0.108 / 0.054 | 0.523 | 0.23 | 100% | 0.134 / 0.042 |
| idf × (1 + PPMI)² | 0.287 | 0.12 | 100% | 0.116 / 0.053 | 0.464 | 0.23 | 100% | 0.141 / 0.039 |
| idf-weighted mean, window ±5 | 0.262 | 0.00 | 98% | 0.076 / 0.045 | 0.488 | 0.15 | 98% | 0.089 / 0.038 |
| idf × (1 + PPMI), window ±5 | 0.278 | 0.08 | 98% | 0.096 / 0.047 | 0.455 | 0.05 | 98% | 0.111 / 0.037 |
| idf-weighted mean, capitalized (name-like) words dropped | 0.169 | 0.00 | 100% | 0.090 / 0.058 | 0.443 | 0.11 | 100% | 0.098 / 0.044 |
| frequent words down-weighted: SIF a/(a + p(w)), a = 10⁻³ (Arora et al. 2017) | 0.188 | 0.00 | 100% | 0.091 / 0.057 | 0.441 | 0.04 | 100% | 0.102 / 0.048 |
| idf × min(1, √(10⁻⁴/p(w))) (word2vec-style subsampling as a weight) | 0.216 | 0.03 | 100% | 0.078 / 0.052 | 0.466 | 0.07 | 100% | 0.102 / 0.045 |
| SIF × (1 + PPMI with the target) | 0.273 | 0.04 | 100% | 0.110 / 0.058 | 0.481 | 0.23 | 100% | 0.131 / 0.044 |
| idf × (1 + PPMI) × subsampling weight | 0.301 | 0.01 | 100% | 0.100 / 0.055 | 0.488 | 0.06 | 100% | 0.134 / 0.043 |

- **What was chosen and why.** The association weighting raises the recovery of a known split in both corpora (0.218 → 0.302 and 0.460 → 0.502) and lifts the worst pair (0.01 → 0.13, 0.05 → 0.23) while keeping every occurrence; keeping only significant associates leaves 74–81% of occurrences `context_thin`. The margin over the shuffled reference grew (0.030 → 0.049, 0.054 → 0.087), so the higher silhouettes are not just a more elongated cloud.
- **What was tried and not taken.** Down-weighting very frequent words (SIF, word2vec-style subsampling), alone or with the association weight, adds nothing beyond IDF, which already does it, and lowers the worst pair (0.13 → 0.01 and 0.23 → 0.06 with the subsampling weight). A squared boost, a ±5 window with the association weight, and dropping capitalized words give less on both corpora. Mean-centring gives a little more on average (0.314 and 0.523) but not consistently: pair by pair it wins 10 of 15 pairs on Cipher and 8 of 15 (one tie) on STEMM text, so the evidence does not justify another change of the representation.
- **What the remaining errors are.** At k = 2 the strongest split in prose is often register — dialogue against narration (*horse + doctor*: "says · well · know" against "rode · road · turned") — not the merged words. That is a usage-context difference, and the machine labels show it.
- **On real words** the pooled-space runs with the chosen weighting found groups for words with very different contexts (*current*: "theory · political · wages · economy" against "river · stream · swift · water", silhouette 0.17, reference 0.13, stability 0.96/0.97), and none for others in Cipher (*charge*, *sample*), with the same gates as before. The full table follows.
- **Per-collection spaces.** The Cipher pooled space has no STEMM text and no abstracts in it, so STEMM runs use spaces built from their own collections (§3): Gutenberg STEMM text, and OpenAlex abstracts alone.

**Real context groups (this round).** Fifteen genuinely polysemous words — *cell, current, plant, charge, bug, virus, culture, sample, board, record, field, power, bank, spring, key* — clustered in each eligible scope with both representations: 90 runs on a clone of the STEMM snapshot, every one made by the final code (cluster@1.1.0, seed 42, default toggles; the 45 PPMI-SVD runs carry a different code hash only because one comment line in tfidf-hash.mjs changed while the TF-IDF half was queued), none reused. Each scope uses the pooled space built from its own collections (§3). The gates are the §4.8 gates: silhouette ≥ 0.10, a stable k (mean ARI ≥ 0.6), and above the no-groups reference.
- **PPMI-SVD:** context groups in 35 of 45 runs — Cipher literature text 10 of 15, Gutenberg STEMM text 13, OpenAlex abstracts 12. `no_cluster_structure`: Cipher *charge, sample, power, spring*; STEMM text *plant, record*; OpenAlex *plant, sample*. `insufficient_occurrences`: *virus* in Cipher (16 occurrences) and *bug* in OpenAlex (39).
- **TF-IDF hash:** no groups in any of the 45 runs. The best silhouette anywhere is 0.035 (OpenAlex *bank*, k = 7); the gate is 0.10.
- **Time:** 3,865 s of run time for all 90 (PPMI-SVD median 53 s, longest 305 s for STEMM *current* with 14,760 occurrences; TF-IDF median 10 s), 27 min wall with three batches running at once (3 fit threads each) at load average 800–950. The previous attempt's identical batch, before the convergence and coverage changes, took 5,795 s at a similar load.
- Columns: n = occurrences clustered (documents); silhouette / reference = the chosen k's mean cosine silhouette and the no-groups reference at that k; stability = per-group mean best-match Jaccard ("tentative" below 0.5); a gated run shows its best silhouette and no group.

**Cipher literature text (Gutenberg + Wikisource, English passages; Cipher pooled space)**

| Word | n (docs) | PPMI-SVD: k · silhouette / reference · mean ARI | Groups: machine label (n, stability) | PPMI-SVD gate | TF-IDF: best silhouette (k) / reference · gate | Time PPMI / TF-IDF |
|---|---|---|---|---|---|---|
| cell | 749 (159) | k = 6 · 0.100 / 0.040 · 0.68 | poore · th · vnto · canst (48, 0.87); prison · prisoner · prisoners · dungeon (139, 0.75); door · narrow · doors · bars (187, 0.76); no distinctive context words (232, 0.73); gray · little · grey · mon (80, 0.58); brain · nerve · body · cerebral (63, 0.79) | ok | 0.009 (k = 8) / 0.008 · no_cluster_structure | 104 s / 6 s |
| current | 1514 (261) | k = 2 · 0.167 / 0.130 · 0.93 | theory · political · wages · economy (636, 0.96); river · stream · swift · water (878, 0.97) | ok | 0.007 (k = 8) / 0.006 · no_cluster_structure | 77 s / 7 s |
| plant | 2505 (316) | k = 8 · 0.108 / 0.038 · 0.72 | trees · flowers · leaves · flower (594, 0.72); shortlands · norton · know · asked (384, 0.75); growth · entire · power · practically (314, 0.64); corn · seed · seeds · wheat (361, 0.90); southern · north · bayou · river (218, 0.44, tentative); feet · firmly · legs · back (397, 0.76); animals · vol · domestication · variation (128, 0.91); other contexts (109, 0.80, residual) | ok | 0.008 (k = 7) / 0.005 · no_cluster_structure | 115 s / 8 s |
| charge | 4368 (367) | best 0.093 (k = 3) / 0.061 | — | no_cluster_structure | 0.006 (k = 8) / 0.008 · no_cluster_structure | 214 s / 9 s |
| bug | 331 (86) | k = 2 · 0.115 / 0.098 · 0.69 | de · goole · dat · massa (53, 0.71); no distinctive context words (278, 0.89) | ok | 0.030 (k = 8) / 0.010 · no_cluster_structure | 63 s / 4 s |
| virus | 16 (15) | — | — | insufficient_occurrences | insufficient_occurrences | 1 s / 0 s |
| culture | 1041 (156) | k = 2 · 0.119 / 0.108 · 0.79 | refinement (645, 0.91); predatory · barbarian · pecuniary · race (396, 0.85) | ok | 0.010 (k = 8) / 0.008 · no_cluster_structure | 41 s / 6 s |
| sample | 287 (125) | best 0.088 (k = 8) / 0.042 | — | no_cluster_structure | 0.006 (k = 7) / 0.004 · no_cluster_structure | 14 s / 5 s |
| board | 3836 (312) | k = 5 · 0.116 / 0.052 · 0.94 | get · asked · come · know (960, 0.93); ship · boat · vessel · captain (888, 0.99); dollars · five · week · thirty (335, 0.92); floor · fence · black · pine (1013, 0.96); school · trade · president · trustees (640, 0.91) | ok | 0.006 (k = 8) / 0.006 · no_cluster_structure | 69 s / 13 s |
| record | 2230 (293) | k = 2 · 0.110 / 0.068 · 0.68 | no distinctive context words (1906, 0.86); plates · nephi · bear · behold (324, 0.70) | ok | 0.008 (k = 8) / 0.007 · no_cluster_structure | 31 s / 18 s |
| field | 5012 (358) | k = 2 · 0.108 / 0.089 · 0.95 | work · battle · worker · science (2605, 0.98); across · corn · green · road (2407, 0.98) | ok | 0.006 (k = 8) / 0.005 · no_cluster_structure | 122 s / 25 s |
| power | 12462 (389) | best 0.085 (k = 2) / 0.073 | — | no_cluster_structure | 0.008 (k = 8) / 0.007 · no_cluster_structure | 96 s / 109 s |
| bank | 4309 (326) | k = 2 · 0.177 / 0.145 · 0.99 | money · account · notes · mr (2053, 0.99); river · along · water · stream (2256, 0.99) | ok | 0.006 (k = 8) / 0.007 · no_cluster_structure | 34 s / 19 s |
| spring | 4190 (369) | best 0.086 (k = 8) / 0.039 | — | no_cluster_structure | 0.006 (k = 8) / 0.006 · no_cluster_structure | 35 s / 14 s |
| key | 2479 (317) | k = 2 · 0.157 / 0.132 · 0.96 | words · word · note · many (1194, 0.98); door · lock · locked · pocket (1285, 0.98) | ok | 0.011 (k = 8) / 0.011 · no_cluster_structure | 14 s / 12 s |

**Gutenberg STEMM text (its own pooled space)**

| Word | n (docs) | PPMI-SVD: k · silhouette / reference · mean ARI | Groups: machine label (n, stability) | PPMI-SVD gate | TF-IDF: best silhouette (k) / reference · gate | Time PPMI / TF-IDF |
|---|---|---|---|---|---|---|
| cell | 8843 (329) | k = 6 · 0.188 / 0.069 · 0.82 | walled · layer · layers · thick (2265, 0.82); germ · division · life · animal (1584, 0.87); bee · bees · honey · water (1549, 0.77); nerve · blood · epithelial · atrophy (1608, 0.87); ovary · fruit · anthers · ovules (982, 0.78); battery · current · daniell · zinc (855, 0.97) | ok | 0.011 (k = 8) / 0.007 · no_cluster_structure | 253 s / 13 s |
| current | 14760 (468) | k = 3 · 0.220 / 0.091 · 0.85 | sea · lava · ocean · tides (2423, 0.75); air · gas · blood · hydrogen (4530, 0.74); electric · wire · electricity · circuit (7807, 0.97) | ok | 0.011 (k = 8) / 0.009 · no_cluster_structure | 305 s / 15 s |
| plant | 28675 (491) | best 0.088 (k = 2) / 0.085 | — | no_cluster_structure | 0.006 (k = 8) / 0.005 · no_cluster_structure | 123 s / 15 s |
| charge | 8289 (500) | k = 3 · 0.151 / 0.082 · 0.97 | mr · free · work · cost (3296, 0.99); powder · water · acid · furnace (2787, 0.97); electricity · negative · positive · electric (2206, 0.98) | ok | 0.007 (k = 8) / 0.007 · no_cluster_structure | 54 s / 12 s |
| bug | 611 (94) | k = 2 · 0.201 / 0.160 · 0.87 | beetles · bed · water · species (323, 0.94); next · previous · node · compatible (288, 0.91) | ok | 0.021 (k = 8) / 0.009 · no_cluster_structure | 77 s / 22 s |
| virus | 544 (65) | k = 7 · 0.213 / 0.072 · 0.63 | effects (79, 0.62); sig · see · virtual · computer (68, 0.76); cuticle (71, 0.42, tentative); venereal · mercury · circulating · fluids (60, 0.65); cowpox · jenner · vaccine · vaccination (161, 0.67); disease · syphilitic · syphilis · enter (55, 0.38, tentative); rabies · rabbits · virulence · heels (50, 0.58) | ok | 0.019 (k = 8) / 0.008 · no_cluster_structure | 82 s / 17 s |
| culture | 1494 (247) | k = 4 · 0.135 / 0.062 · 0.72 | intellectual · physical · education · psychology (717, 0.81); plant · soil · vine · cane (362, 0.80); hacker · information · languages · la (254, 0.76); bacillus · agar · pure · blood (161, 0.76) | ok | 0.007 (k = 8) / 0.007 · no_cluster_structure | 45 s / 10 s |
| sample | 2040 (247) | k = 2 · 0.114 / 0.105 · 0.86 | sent · analysis · send · new (1173, 0.94); per · acid · cent · water (867, 0.92) | ok | 0.009 (k = 7) / 0.006 · no_cluster_structure | 35 s / 11 s |
| board | 5430 (442) | k = 5 · 0.177 / 0.060 · 0.76 | placed · cut · side · fixed (2156, 0.80); lodging · week · chess · game (1013, 0.64); ship · tender · boat · rock (892, 0.87); report · visitors · royal · trade (991, 0.83); bulletin · 8vo · systems · price (378, 0.71) | ok | 0.009 (k = 8) / 0.005 · no_cluster_structure | 50 s / 18 s |
| record | 9233 (523) | best 0.095 (k = 2) / 0.075 | — | no_cluster_structure | 0.007 (k = 8) / 0.005 · no_cluster_structure | 34 s / 12 s |
| field | 10262 (548) | k = 5 · 0.165 / 0.060 · 0.88 | corn · woods · gardens · cultivated (2447, 0.87); work · science · research · new (3459, 0.94); view · stars · telescope · dark (1747, 0.79); coal · mines · south · basin (1017, 0.89); magnetic · force · magnet · electric (1592, 0.98) | ok | 0.007 (k = 8) / 0.007 · no_cluster_structure | 56 s / 16 s |
| power | 28695 (579) | k = 7 · 0.107 / 0.042 · 0.81 | reasoning · observation · selection · mathematical (6105, 0.84); conducting · force · electricity · motive (5125, 0.82); human · infinite · god · man (4778, 0.88); horse · steam · engine · per (4161, 0.94); medicinal · possessed · iii · acid (3206, 0.68); sensorial · accumulation · muscular · association (3122, 0.90); magnifying · refractive · illuminating · telescope (2198, 0.68) | ok | 0.005 (k = 7) / 0.005 · no_cluster_structure | 176 s / 14 s |
| bank | 4452 (383) | k = 2 · 0.212 / 0.142 · 0.94 | river · streams · sand · near (3202, 0.98); money · notes · trial · england (1250, 0.95) | ok | 0.007 (k = 8) / 0.007 · no_cluster_structure | 28 s / 11 s |
| spring | 10645 (535) | k = 4 · 0.149 / 0.067 · 0.93 | life · suddenly · experiment · us (2815, 0.91); water · hot · tides · waters (2650, 0.97); winter · summer · autumn · early (2251, 0.92); balance · steel · spiral · lever (2929, 0.98) | ok | 0.007 (k = 7) / 0.005 · no_cluster_structure | 28 s / 16 s |
| key | 3000 (387) | k = 7 · 0.138 / 0.046 · 0.73 | lock · hole · lever · shaft (756, 0.69); science · nature · true · mystery (543, 0.84); note · notes · ash · compass (453, 0.46, tentative); driven · machine · action · comptometer (373, 0.72); hit · keyboard · alt · control (428, 0.92); circuit · current · battery · telegraph (341, 0.79); other contexts (106, 0.82, residual) | ok | 0.009 (k = 8) / 0.006 · no_cluster_structure | 31 s / 14 s |

**OpenAlex abstracts (top-cited sample; its own pooled space)**

| Word | n (docs) | PPMI-SVD: k · silhouette / reference · mean ARI | Groups: machine label (n, stability) | PPMI-SVD gate | TF-IDF: best silhouette (k) / reference · gate | Time PPMI / TF-IDF |
|---|---|---|---|---|---|---|
| cell | 19836 (6614) | k = 2 · 0.125 / 0.113 · 0.98 | solar · fuel · membrane · wall (10462, 0.99); immune · tumor · antigen · cd4 (9374, 0.99) | ok | 0.006 (k = 8) / 0.005 · no_cluster_structure | 133 s / 11 s |
| current | 5002 (3576) | k = 2 · 0.190 / 0.133 · 0.99 | density · electric · voltage · cm (2206, 1.00); review · future · research · knowledge (2796, 1.00) | ok | 0.007 (k = 8) / 0.005 · no_cluster_structure | 109 s / 8 s |
| plant | 5796 (2530) | best 0.098 (k = 8) / 0.042 | — | no_cluster_structure | 0.020 (k = 8) / 0.010 · no_cluster_structure | 133 s / 9 s |
| charge | 2109 (1227) | k = 2 · 0.106 / 0.090 · 0.96 | space · density · field · atomic (1276, 0.98); transfer · separation · recombination · transport (833, 0.98) | ok | 0.010 (k = 8) / 0.007 · no_cluster_structure | 92 s / 4 s |
| bug | 39 (31) | — | — | insufficient_occurrences | insufficient_occurrences | 1 s / 1 s |
| virus | 1929 (767) | k = 8 · 0.139 / 0.046 · 0.84 | particles · particle · electron · microscope (256, 0.83); influenza · cov · sars · respiratory (264, 0.92); rabies · rabbits · inoculation · vaccine (344, 0.88); cells · leukemia · murine · cell (260, 0.83); human · immunodeficiency · hiv · htlv (378, 0.89); bacteria · fungi · resistant · protozoa (172, 0.82); dna · rna · polymerase · promoter (179, 0.71); other contexts (76, 0.94, residual) | ok | 0.015 (k = 8) / 0.010 · no_cluster_structure | 118 s / 3 s |
| culture | 2722 (1492) | k = 4 · 0.125 / 0.059 · 0.96 | research · information · organizational · health (437, 0.94); positive · strains · broth · filtrates (737, 0.97); medium · growth · grown · light (668, 0.95); cells · cell · human · tissue (880, 0.98) | ok | 0.009 (k = 7) / 0.009 · no_cluster_structure | 44 s / 4 s |
| sample | 5437 (2987) | best 0.099 (k = 2) / 0.089 | — | no_cluster_structure | 0.007 (k = 8) / 0.007 · no_cluster_structure | 53 s / 6 s |
| board | 164 (131) | k = 3 · 0.160 / 0.097 · 0.60 | health · medical (79, 0.75); two · stress · cats · week (47, 0.59); data · charger · circuit · systems (38, 0.60) | ok | 0.031 (k = 8) / 0.009 · no_cluster_structure | 5 s / 2 s |
| record | 2621 (1918) | k = 5 · 0.102 / 0.045 · 0.82 | observations · paper · cases · experiments (735, 0.89); ice · sea · climate · marine (371, 0.93); medical · health · electronic · patient (606, 0.85); values · spectra · speed · frequency (619, 0.79); potentials · activity · neurons · nerve (290, 0.81) | ok | 0.007 (k = 8) / 0.006 · no_cluster_structure | 25 s / 3 s |
| field | 8122 (4869) | k = 2 · 0.163 / 0.127 · 0.99 | magnetic · electric · force · electromagnetic (4589, 0.99); research · applications · future · review (3533, 0.99) | ok | 0.008 (k = 8) / 0.006 · no_cluster_structure | 29 s / 5 s |
| power | 3076 (1997) | k = 4 · 0.112 / 0.055 · 0.95 | statistical · tests · sample · test (725, 0.96); law · spectrum · series · rotatory (837, 0.96); blood · reducing · bactericidal · assay (721, 0.94); energy · conversion · solar · efficiency (793, 0.97) | ok | 0.008 (k = 7) / 0.005 · no_cluster_structure | 106 s / 6 s |
| bank | 183 (114) | k = 8 · 0.290 / 0.072 · 0.66 | along · river · water (53, 0.71); linda · teller (10, 0.36, tentative); milk · breast · fed · infants (17, 0.42, tentative); data · protein (36, 0.56); sulcus · superior (10, 0.68); filter · multirate · wavelet · wavelets (29, 0.86); seed · types · vegetation · persistent (19, 0.89); other contexts (9, 0.59, residual) | ok | 0.035 (k = 7) / 0.007 · no_cluster_structure | 10 s / 2 s |
| spring | 378 (270) | k = 8 · 0.188 / 0.048 · 0.66 | possible (60, 0.65); water · waters (51, 0.46, tentative); connected · force · stiffness · model (61, 0.69); sheep (53, 0.50); verlag · berlin · york (31, 0.69); summer · winter · autumn · early (89, 0.90); hot · iceland (25, 0.49, tentative); other contexts (8, 0.60, residual) | ok | 0.017 (k = 8) / 0.008 · no_cluster_structure | 15 s / 2 s |
| key | 2570 (2221) | k = 2 · 0.139 / 0.113 · 0.98 | role · signaling · pathway · immune (862, 0.98); challenges · research · applications · data (1708, 0.99) | ok | 0.012 (k = 8) / 0.005 · no_cluster_structure | 44 s / 6 s |

How to read these groups — they are usage-context hypotheses, not senses:
- **Where a word's uses really differ, the groups follow them:** *bank* (money · account against river · water, stability 0.99 in Cipher), *key* (door · lock against words · note), *current* (economy against river in Cipher; electric against sea and against gas in STEMM text; electric against "current research" in abstracts), *field*, *spring* (seasons, water, steel spirals), *cell* in STEMM text (cell walls, bees, nerves, ovaries, batteries), *virus* in abstracts (influenza and SARS, HIV and HTLV, rabies, leukaemia, microscopy) and in STEMM text (cowpox and vaccination, rabies, venereal disease, and a computing group "sig · see · virtual · computer").
- **Many groups are one source's vocabulary or a register:** Cipher *cell* "poore · th · vnto · canst" (Early Modern spelling), *plant* "shortlands · norton · know · asked" (one novel's characters), *record* "plates · nephi · bear · behold" (one scripture), *bug* "de · goole · dat · massa" (a dialect rendering); "no distinctive context words" marks the remainder. In abstracts the groups often split research topics (*cell*: solar and fuel cells against immunology), and *key* splits "key role" from "key challenges" — topics, not senses.
- **Small samples give many small groups:** OpenAlex *bank* (183 occurrences) and *spring* (378) reach k = 8 with tentative groups; *sample* in STEMM text passes the reference by 0.009 only.
- A text scope's groups get windows, shares and transitions (see *Windows and shares* below); an OpenAlex scope's groups describe the sample as a whole (`windows_gate: sampling_design`).

**Labels — context words, not meanings.**
- A machine label is the top 4 context words of a group by weighted log-odds with an informative Dirichlet prior (Monroe, Colaresi & Quinn 2008), group vs the rest, with the pooled context counts as prior. A word must reach z ≥ 1.96 and in-group f ≥ 3. Example: "machine label: lesson · write · tapped · digit".
- A human label is a notebook annotation of kind `label` on the cluster. `GET /api/clusters` returns it as `human_label` beside the machine label, which stays visible.
- `rev_cutoff` (a saved view) hides later renames.

**Windows and shares.** Windows are built from decades, from the first to the last decade holding a dated member:
- A decade without coverage is an `uncovered` window and is never merged across.
- Inside a covered stretch, decades merge forward until each window holds ≥ 30 members; a remainder joins the previous window; a stretch that never reaches 30 is `thin` and gets no shares.
- A member counts only when its document's whole interval fits the window; otherwise it is "date too coarse" and counted.

Shares per measured window carry a document-block bootstrap 95% CI (1,000 resamples).

**Transitions.** All are computed and drawn dashed; none is a claim about speakers.
- *emerge*: the first window where a group has share ≥ 10% and n ≥ 5. A group already there in the first measured window is present from the start of the record, not an emergence.
- *split*: the group emerges while its nearest older group (global centroid cosine ≥ 0.5) is present (share ≥ 2%). Otherwise it is an emergence, and the nearest cosine is printed.
- *vanish*: share < 2% in two measured windows after the group was present.
- *unknown_gap*: an uncovered window right after a window where the group was present.
- *merge*: the per-window centroids of two groups (≥ 5 members each) move from cosine < 0.5 to ≥ 0.7.

Example sentence: "Context group 2 'auditors · clerk · department · quota' emerges in 1950–1969 (first observed 1955). Nearest earlier group: 1 (centroid cosine 0.05; a split needs ≥ 0.5). Run #5, k=4, stability 0.99, representation tfidf-hash-4096. Computed from usage contexts."

**Convergence of two expressions.** Each clustering run evaluates convergence against `with`, or else against up to 6 other counted expressions of the same corpus and language (the number evaluated is disclosed), whatever the clustering gate says. Joint windows are decades merged forward until both expressions have ≥ 20 occurrences, never across an uncovered decade. Per window:
- J(t) = the Jaccard of the two expressions' top-50 significant collocates (the §4.6 rules; both must pass the collocation gate there);
- C(t) = the cosine of their mean occurrence vectors in one shared representation (descriptive only).

Reporting and storage:
- Convergence is reported (⑃, `cluster_transition.kind='convergence'`) only when J rises by ≥ 0.15 between the first and last gated windows **and** the document-block bootstrap 95% CI of that rise (1,000 resamples) excludes 0.
- Every evaluation is stored as a `drift_result` row with metric `convergence`.
- Gated rows have no value. The gates: fewer than two gated windows; or windows over 2M tokens without current token streams, which give `not_run` with a token-stream suggestion.
- Shared context words are not shared meanings, and not evidence of influence.

**Constellation (`GET /api/constellation`).**
- **Nodes:** expression ○, context group ⬡ (the strand's newest or pinned clustering run), context word (a significant collocate), document □, etymon ▽.
- **Size:** node area ∝ the chosen quantity per period: occurrences, documents or distinct authors in the period. A context word is sized by its co-occurrences within ±5 tokens, and only where it is a significant collocate. An etymon is not sized.
- **Edges:**
  - `cooc`: logDice in the period;
  - `member`: share of the period's clustered occurrences; ≥ 30 needed, else gated with no value;
  - `occurs`: occurrences in the document;
  - `rel`: relationships between the documents. Line pattern = evidence status; rejected, kindred and counterpart are hidden; never derived from similarity;
  - `etym`: "shared ancestry, not shared meaning".
- **Bounds:** ≤ 150 nodes and ≤ 400 edges, ranked by type and then by the size quantity. `expand=<expression node>` adds ≤ 20 collocates and documents.
- **Two periods:** A is always the earlier (swapped, and said so). Presence is given per period, plus a diff: only in A, only in B, grew > 2×.
- **Stable layout:**
  - A deterministic Fruchterman–Reingold layout: 300 iterations in the unit square, gravity toward the centre, then a collision pass.
  - The seed is FNV-1a-32 of the layout key (corpus, strands, materialize and cluster run ids) and its generation.
  - Positions are cached in `layout_cache`. Every cached node is pinned when new nodes are placed, so changing or comparing periods never moves a node.
  - `relayout=1` recomputes all positions (a new generation) and says "Positions recomputed — movement is not semantic."
  - Read workers cannot write: the route stores new positions on the main connection, or through a `layout` job when the writer is busy.
- The relationship lookup keeps the matched ids as its outer loop (`CROSS JOIN`). With OpenAlex's 381,800 citations loaded, the planner otherwise scanned about 600k relationships (M5 gate: a 503 became 48 ms).

## 8. Known limits
- **Job scheduling.** The cluster, vectors, drift, tone, collocations and layout jobs only write at the end and retry their short commits (§6), but `vocab.JOB_TYPES` still declares them `writes: true`, so the queue runs them one at a time with every other writing job: a 5-minute vectors run delays a materialize or import queued behind it. Running them as read-only jobs needs `writes: false` for those six types *and* declared job dependencies in the queue (the final gate kept them writers: the demo pipeline materialize → cluster → label rename relies on writer serialization for its order); the tasks are ready for it: they hold the lock only for their commits (measured in §6) and refuse to store a run whose inputs changed meanwhile (`E_INPUTS_CHANGED`).
- **Drift scope.** (b) and (c) are computed only for single-word expressions, and only through a drift run. A stored result is shown only for the identical comparison on the same data, so any change of slices, filters or toggles, or a new import, asks for a new run. Because each slice space needs ≥ 3M tokens, drift between small eras is often `slice_too_small` or `unaligned` (see the measured anchor counts).
- **Controls** are matched by frequency decile only. The target's 20 neighbours are excluded from its anchors, but the controls' own neighbours are not excluded from theirs.
- **Neighbour search** is restricted to the words both slice spaces share.
- **Context groups.**
  - Context-share shift needs a clustering run; Compare reads `sense_cluster`/`cluster_member` as the schema defines them. Context groups and (a) need a single expression.
  - TF-IDF hash vectors find no structure on real prose or abstracts (45 runs, every best silhouette below 0.035, §7); they remain the fallback for the demo and small imports. Only PPMI-SVD runs found context groups on real data, and only for some words (§7).
  - Occurrence vectors average ±10 context words, so the strongest variation they carry is often register or topic (dialogue against narration, one book's characters) rather than a word's senses: on pseudo-words (two different words merged) the chosen weighting recovers the true split with a mean ARI of 0.30 on Cipher text and 0.50 on Gutenberg STEMM text only (§7). Groups are usage-context hypotheses with machine labels, never senses.
  - The no-groups reference (§7) is a Gaussian of the same mean and covariance for PPMI-SVD vectors and a coordinate shuffle for TF-IDF vectors; a cloud that is curved but has no groups can still beat either, so the stability gate remains the main guard.
  - Human labels attach to cluster ids, so a newer run does not inherit an earlier rename (the pinned older run still shows it).
- **Timeline lanes by context group** are contract 1.3.0 C1 (built by the aggregation owner from these runs). A run's `scope` says which medium and collections its groups describe; a top-cited-per-cell scope has no windows, so its lanes can only show per-cell shares (C3), never rates or transitions across cells.
- **Demo calibration.** On the demo, the planted convergence of *carry the zero* + *ghost in the margin* (§9.6) is not reported: in 1990–2005 *ghost in the margin* has 17 counted occurrences (< 20), so those windows are gated; with the pipeline's joint windows J rises 0 → 0.17, but the CI includes 0. The demo's §9.4 P1 split is computed as an emergence (centroid cosine 0.05 < 0.5).
- **Convergence cost.** Every clustering run evaluates convergence with up to 6 other counted expressions, and a joint window needs the frequencies of every token of its slice: on long runs this is now the largest single step (*war*: 22 of 50 s), more so when a slice's token stream is out of date and its passages are tokenized from text (or `not_run` above 2M tokens).
- **Constellation.** Theme ◇ nodes and theme–theme NPMI edges are not drawn. Expansion works on expression nodes only. Node and edge cards use the existing KWIC and passage endpoints.
- **Machine tone** covers only the languages the adapter's probe lists (English and Italian here). Apple's sentiment score is coarse (many paragraphs score exactly 0) and modern. Paragraphs are capped at 2,000 per slice.
- **OpenAlex.** Within-cell shares use the loaded works only, with no population denominators from `population.tsv`. Cells without `sample_cell` fall back to field + year bin. Context groups over OpenAlex abstracts describe the sample as a whole; their shares are never compared across cells.
- **Compare speed on Cipher.** Most of a Cipher Compare goes to loading the corpus scope (≈95k culture-works rows plus their denominators and counts). Under heavy machine load the first comparisons can reach the 5 s read-pool limit.
- **Compare and the Term trail.** A comparison reads one corpus: `corpus: 'real'` (contract 1.3.0 C2) is refused with a 400 that says to compare the expression in one member corpus. Pooling Cipher and STEMM in one comparison would mix collections, media and selection rules that the trail keeps in separate lanes.
- **External baseline ρ** needs the staged Ngram store, an English single word, running text, and slices that together span at least 8 decades with enough text in each (so a typical 25-year comparison gets the gate card, not a value). It compares decade series of two different corpora and says nothing about why they agree or differ. With about 12 decades and blocks of 3 the bootstrap intervals are wide (*bank*: 0.32 [−0.76, 0.41]).
- **Other gaps.** Widening is by years only; facet-value widening is not built. Stop-lists have 106–142 words. Compare's clustering gate uses slice A's filters. The prominence check needs document prominence.
