<!-- OWNER: WP8 — handoff written at the final integration gate (SPEC §12.5), 2026-10-08; updated by the fix pass, 2026-10-09 -->
# Handoff

**State on 2026-10-09 (after the fix pass):** contract 1.3.0, `schema_version` 1. The suite passed twice after the fix pass's patches (1,124 tests, 1,122 pass, 0 fail, 2 skipped; then 1,125 / 1,123 / 0 / 2 inside `npm run verify`); two later runs after the last patches each had one timing failure under load in `jobs` (a cancel test's precondition, now fixed; then a health-latency check at load ≈ 790), and `jobs` passes 16 of 16 alone (VERIFICATION). `npm run verify` passed on the m1 snapshot (19 journey rows, 140 responses, 0 shape errors) and on the m5-stemm snapshot (19 rows, 141 responses, 0 shape errors).

**What the fix pass did.** Three adversarial reviews (honesty + acceptance, UX, data correctness) reported 57 findings after the final gate. Every one was reproduced against the current code; the high and medium ones are fixed at the root with a regression test, and most low ones too. The table finding → status is in [VERIFICATION.md](VERIFICATION.md#fix-pass-after-the-adversarial-reviews-2026-10-0809); what is still open is listed under *What remains unfinished* below.

The evidence is in [VERIFICATION.md](VERIFICATION.md): numbers, screenshots and the patches of the final gate and of the fix pass. The earlier gates are in [M1-GATE.md](M1-GATE.md) and [M5-GATE.md](M5-GATE.md).

**Git.** The last round and the first half of the fix pass are committed (`8f2e528`, "Final round (pre-fix-pass checkpoint)"); the rest of the fix pass is in the working tree, uncommitted.

Setup, first launch, imports and the keyboard are in the [README](../README.md).

## What works (verified on real data, in the browser at 1440 × 900 and 375 × 812)

**M1 — the vertical slice**
- **The demo** ("carry the zero", all synthetic and labelled so):
  - it opens at once (first contentful paint 236–472 ms headless);
  - its one-minute tour ends on "Your turn." at ≈ 50 s with *Switch to Cipher* (coach ③ waits about 20 s for Play, or until the play ends).
- **Cipher's first-launch import:** metadata first, then full text; it can be turned off.
- **Import wizard** for TXT/MD/CSV/TSV/JSON/JSONL: mapping, dry run with line and column problems and `problems.csv`, commit as a job, revert.
- **Search** for expressions (with variants), works, makers and themes.
- **The Scroll:**
  - a linear axis with tiers L0–L5, bars of observed bins, precision washes, Undated and Scheduled shelves and the coverage track;
  - the 1928 text→titles seam, minimap, playhead with vantage (strict or context) and reduced motion;
  - keyboard, touch sheets and the table alternative.
- **The conservation law** holds at every tier for every lane checked: Σ bins + washes + undated + scheduled = n.
- **Passages:** every mark opens its passage, with offsets exact to the original (20 of 20 in each verify run).
- **Compare:**
  - coverage, composition, modality, prominence, frequency with CIs, sampled passages and collocates;
  - multiplicity disclosure;
  - gate cards with widening suggestions, and never a numeral for a gated measure.
- **Saved views** are immutable (a re-save becomes `slug~2`), reopen byte-identical after a restart, and carry the as-saved banner.
  - As saved, they count what existed at the save even after a later revert (documents are only soft-deleted, D17), and the drift note names the revert.
  - They pin every member corpus's counting run of a Term trail, and the clustering run of context-group lanes (newer runs are listed as drift, never used).
  - The Scroll's arcs read the view's relationship and annotation revision cutoffs and its pinned runs.
- **Exports** (JSON/JSONL/CSV with a manifest, plus a portable HTML bundle) and PNG/SVG snapshots.

**M2 — lineage**
- The boilerplate pass: 0 `quality='ok'` passages keep the Gutenberg licence's "computer virus".
- The winnowing reuse index, near quotes, and attribution cues (proposed + CUE, never documented).
- The targeted trace, and the lineage explorer with hypothesis groups and chain of custody.
- **Genealogy** from Cipher's documented sampling relations (e.g. *Funky Drummer*: 32 / 98 / 48 works over 3 generations).
- Review actions as a layer that never changes the evidence line.
- Arcs with feedback arcs, halos and date conflicts.

**M3 — context groups**
- **Methods:** TF-IDF-hash fallback, pooled PPMI–SVD spaces, k-means with stability, labels, transitions and convergence.
- **Context-group lanes (C1)** on the Scroll: one lane per group plus a residual lane, sharing the expression's slice denominator, with the machine label always beside a reader's label.
  - Demo *carry the zero*: 4 groups, n 90/71/109/70, the hip-hop group renamed "honoring the uncounted".
  - Cipher *bank*: "money · account · notes · mr" (2,053 matches) and "river · along · water · stream" (2,256), both with stability 0.99, from a 46 s run started from the lane's own suggestion.

**M4 — constellation and notebook**
- **The constellation:** a stable layout with a two-period comparison, and labels that never clip.
- **The notebook:**
  - create, edit (revisions), reinterpret (the new reading supersedes the old one, which stays visible);
  - layers, dimensions and as-of (verified over the API to the second);
  - export of every revision.
- Then/Now/Next, and the Crossings card.

**M5 — STEMM and advanced**
- **The four STEMM adapters:** Gutenberg STEMM text (704 documents), OpenAlex (118,466 works, 381,800 documented citations), Wiktionary claims, and the Ngram baseline.
- **The Term trail (C2):** the virtual corpus `real` (cipher + stemm, never the demo) and 18 fixed lanes, each in its own unit.
  - Every lane equals the sum of the member corpora counted alone, checked for *virus, gene, algorithm, quantum, zero*.
  - The Crossings card gives first and last observed with their basis, the etymology bands, and the claims labelled as external.
- **OpenAlex share cells (C3):** k of n, a Wilson CI, and no share below n = 20; never a trend.
- **Arc summaries at STEMM scale (C4):** *gene*'s 21,490 citation arcs become 388 buckets plus 300 individual arcs between the lanes shown.
- **Etymology (C5):** each listed root once (*virus*: three PIE roots, one bracket).
- **Wiktionary claims** attach also to words tracked after the load.
- **Compare's ρ** against Google Books Ngram: Cipher *machine* gives 0.9 [0.29, 0.92] over 12 decades; too few decades gives a gate card and no ρ.
- **Era slices,** Procrustes alignment, neighbour overlap and aligned displacement with controls (a drift run).
- The folded deep-time overview.

**Operations**
- **`npm run verify`:** an acceptance journey on a snapshot clone, which never writes to the live data directory.
- **`/?selftest=1`:** an in-browser check.
- **A boot-time check of `originals/`,** reported in `/api/health` as `integrity`.
- **Job rows and interactive writes:**
  - job rows are inserted without waiting for a running job's write lock;
  - an interactive write is parked and re-run instead of failing after 5 s.
- **Chained loads** build the duplicate index once instead of once per chunk (OpenAlex chain 23.0 s → 4.1 s).

## What needs an optional component, a staged source or a run

| Feature | Needs | Without it |
|---|---|---|
| Machine tone (Compare), modern-reader neighbours (variant panel) | the Apple NaturalLanguage adapter: `npm run build:nl` (macOS, `swiftc`), giving `$SCROLLS_DATA/bin/scrolls-nl`. English and Italian only on this Mac | "Tone needs the optional on-device adapter (not installed)"; nothing else changes |
| Everything Cipher (books, Wikisource hi/gu, culture works, music relations, themes, roots) | the Cipher datasets at `SCROLLS_CIPHER_ROOT` (default `~/Documents/AI Stuff/Cipher`) | the demo and your own imports only |
| The STEMM corpus, the STEMM lanes of the Term trail, OpenAlex share cells and citation arcs | `node tools/fetch/gutenberg-stemm.mjs` and `openalex.mjs` (network, run by you), then Load on the Adapters page | the Term trail shows the Cipher lanes and lists the absent ones with their reason |
| Wiktionary claim markers | `node tools/fetch/wiktionary-coinage.mjs`, then Load | no claim markers |
| The Ngram baseline track and Compare ρ | `node tools/fetch/ngram-baseline.mjs` (read in place; no Load) | `available: false` with the reason; English single words only |
| Context-group lanes, Compare's context shares | a `cluster` run per expression: offered by the lane's "Run clustering" or the gate card's Start; 46 s for Cipher *bank* | `lane_state: 'not_run'` with the run to start |
| Neighbour overlap and aligned displacement | a `vectors` space (the English pooled space took 36 s) and a `drift` run (100 s at the M5 gate) | `not_run` with `suggestion.run` |
| The demo-name collision test against 40.4M recordings | the MusicBrainz tables (`npm run test:cipher`) | skipped with a message |

## What remains unfinished (honest and specific)

**Scheduling and writes**
- **Analysis jobs still take the writer slot.** cluster, vectors, drift, tone, collocations and layout stay `writes: true` in `vocab.JOB_TYPES`, so a long vectors or cluster run delays an import queued behind it.
  - The tasks are ready: they hold the lock only for their commits and refuse to store when their inputs changed (`E_INPUTS_CHANGED`).
  - The queue is not ready: it has no job dependencies, and the demo's pipeline (materialize → cluster → label rename) relies on serialization.
  - Next step: `enqueue(type, params, {after: [jobId]})`, then `writes: false`.
- **Interactive writes** (`ctx.withWrite`):
  - a second write inside one request is not parked; it keeps the 5 s busy wait;
  - job rows still pending at shutdown are lost if the final 5 s flush cannot take the lock (they are logged).

**Full Cipher bootstrap time.** Since the dedupe fix, every reconciliation count of the full bootstrap holds again under `test:cipher`. Its wall-time bound (≤ 10 min) failed at 3,449 s, measured at load 400–1,000; it needs a run on a quiet machine.

**Performance on a STEMM-loaded database** (all measured at load 300–1,000)

| Operation | Time | Bound |
|---|---|---|
| First search of a new word | 0.2–2.7 s | reading candidate documents |
| Counting (materializing) a new word | about 1–14 s | 54% of its CPU reads each candidate document's full text |
| First Term trail query on a cold server | about 9 s | its limit is 15 s |
| First constellation per read worker | once over 5 s | raised to 15 s at this gate |

- Passage-level text storage would fix the counting cost, but it is a schema change beyond `schema_version` 1.
- The bench was never run on a quiet machine, and only the `/api/corpora` gains are clear.
- **M1 budgets, not re-measured since M1:** cold tiles p95 618 ms (budget ≤ 300 ms) and bootstrap phase A 39 s (budget ≤ 30 s).

**Verification tooling**
- `/?selftest=journey` (the in-browser journey of SPEC §11) is not built. `/?selftest=1` runs read-only checks; the journey runs over HTTP in `npm run verify` and in `tests/acceptance.verify.test.mjs`.
- `tests/e2e/journey.md` and `tests/e2e.journey.test.mjs` (SPEC §12.5) were not created; `acceptance.verify` covers the same journey.

**UI**
- **Notebook:** the as-of slider has one stop per day, so two readings made on the same day cannot be told apart there. The API's `as_of` takes a timestamp.
- **Term trail and Crossings:**
  - With a mark selected (and on the phone sheet), the Crossings card sits above the passage; its toggle folds it.
  - Opening a lane's first passage from the card folds it automatically.
  - Lane `first` names the document and basis but no passage id; the card finds the first passage through `/api/kwic`.
  - The constellation of a Term trail defaults to the current decade (2020–2029), which is nearly empty for words that mostly occur in pre-1928 text.
- **Phone:** the narrow lane rail wraps labels at word boundaries; a word longer than the rail (10+ letters) is hyphenated.
- **At century zoom,** share boxes are 1–3 px; a mark under an emergence tick loses hover to the tick.
- **Not seen in a browser:** ⑂ / ⑃ split and merge glyphs are unit-tested only. The demo run has only emerge and vanish; Cipher *bank*'s one split was not opened in a browser.
- The `excluded` variant of the trace fixture is still canned.
- **As-saved views:** the timeline, arcs, lineage and notebook honour the pinned runs and cutoffs (fix pass: arcs too). **Fixed at `ref-freeze-1` (RF-2):** the inspector's counts, its Crossings card and Compare now honour them too (`Native/Docs/REFERENCE-CHANGES.md`).
- **The playhead's "as of" flag** sits on the ruler and can cover a year label while it moves (folded overview: '1950'); by design, not changed.
- **Arcs at STEMM scale:** individual arcs fade with their number (40 at full strength, then down to 18%, and to half that over a summary, whose counted ribbons carry the quantities); *gene* in STEMM (21,482 links) still shows a faint amber texture over 1950–2020, under which the bars read.

**Open findings of the adversarial reviews (fix pass, 2026-10-09; each reproduced, not fixed, with the reason)**
- **Fixed at `ref-freeze-1` (RF-1, `Native/Docs/REFERENCE-CHANGES.md`): English denominators included unidentified Latin text of other-language books** (data review, high; its Gujarati/Hindi case was fixed in the fix pass). The finding as reported: An 'und' passage (a heading, verse number or old spelling) of a Spanish or French book counts toward an English word's denominator and coverage documents: Cipher *machine* 1875–1899 lists 148 documents, 76 of them es/fr books that add only 166k 'und' tokens. Fixing it means gating 'und' rows by the document's text language in the slice cube, the SQL slice and Compare at once (a cube version bump and new oracles in the invariant tests): too wide for a fix pass.
- **Title Case scientific names are excluded as names** (data, low): rule (a) of the name guard flags *Influenza Virus*, *Vaccine Virus*, *Epstein-Barr Virus* (101 STEMM *virus* rows). They are excluded by default and counted under "excluded as names"; the names toggle or a per-match override includes them.
- **Translation flag on one French original** (data, low): Cipher declares Hugo's *Le Dernier Jour d'un Condamné* (pg:6838) `en`, its text is French, so it is stored as a translation. No local rule separates a wrong declaration from a real translation (*Candide* #19942, a real translation, lists no translator either). The title-only half of the finding is fixed (no translation claim from fewer than 20 tokens), for future loads.
- **Source byte ranges missing for relation endpoints and Wiktionary entries** (data, low): OpenAlex works and demo documents now point at their JSONL line (future loads); the 179,014 `cipher-music-relations` endpoints are aggregated from several JSON records and the 4 Wiktionary entry documents still carry no `source_file` pointer. Databases loaded before the fix keep no pointers (297,712 documents in m5-stemm).
- **Genealogy: Chic's *Good Times* (1979) as a cover of *Rapper's Delight*** (UX, low): Cipher's own `culture-works.tsv` row for *Rapper's Delight* says `4819:covered as:0.95:m`, and the same-title songs under it come from Cipher's title matching. Scrolls shows documented links as collected (§2.C2); checking work identity needs MusicBrainz online.
- **Duplicated demo relationship groups in the m5-stemm snapshot** (data, low): 11 groups written before the M5-gate writer fix. Relationships are never deleted (`rel_no_delete`), so no boot repair removes them; the snapshot README and this file disclose them. Use the m1 snapshot for demo checks.
- **8 ItwoFS coincidence-page links** (low): no longer loaded (fix pass), but a database loaded before keeps them as `inspired_by` (documented, undeletable); a reader can reject them in review.
- **Five Cipher books with a double BOM** keep offsets one below a standard UTF-8 decode in databases loaded before the fix (their stored text is self-consistent); new loads keep the second U+FEFF.
- **Search and the Term trail count different units:** Search's count is matches in every field; the trail counts OpenAlex titles and abstracts as works (C3), so the trail's `by_unit.matches` is not Search's total (*virus* in `real`: 562 matches · 789 works on the trail, 2,496 matches in Search). Both say their unit.

**Analysis** (details in ANALYSIS-AND-LIMITS)
- Context groups are usage-context hypotheses, not senses. Several real groups are one source's vocabulary or a dialect (e.g. 'poore · th · vnto · canst').
- TF-IDF hash vectors never found structure on real text (best silhouette 0.035 against the 0.10 gate); they remain the fallback for the demo and small imports.
- Baseline ρ intervals are wide with about 12 decades.
- The k-means worker pool showed no gain under this machine's load.

**Code**
- `server/aggregate/query.mjs` is about 960 lines and could be split (trail and cluster lane-set builders).

**Data caveat (snapshot only)**
- The m5-stemm snapshot holds demo duplicates written before a DocumentWriter fix, so its passage cards list machine labels from two demo clustering runs. Use the m1 snapshot for demo checks.

**Later, by design** (SPEC §14):
- PDF/EPUB import, multi-user and collaborative annotation;
- cross-language reuse detection;
- MusicBrainz full chains and date recovery for the 4,090 undated songs;
- a sense-level external baseline, a 2–5-gram baseline for phrases, and a random OpenAlex re-sample (which would allow cross-cell rates);
- a Wikidata date refresh for Cipher books;
- Hindi/Gujarati lemmatization and exact ISO-15919 transliteration;
- any embedding model beyond Apple NL.

## Node on this Mac (2026-10-09, 17:28): broken by a Homebrew upgrade
A `brew upgrade` run by another process upgraded `simdjson` (4.6.11 → 5.0.3) and `hdrhistogram_c` (0.11.10 → 0.12.0) without rebuilding `node` 26.10.0_1, so a new `node` process stops at once with `dyld: Library not loaded: …/libsimdjson.33.dylib`. Servers already running (the live one on port 3460) keep working until they are restarted. Scrolls itself is unaffected; the fix is yours to run: `brew reinstall node` (or `brew upgrade node` once a rebuilt bottle exists). Until then, while the old Cellar folders are still there, `DYLD_LIBRARY_PATH=/opt/homebrew/Cellar/simdjson/4.6.11/lib:/opt/homebrew/Cellar/hdrhistogram_c/0.11.10/lib node …` starts node (the fix pass's last test runs used it).

## Upgrading the live data directory
- The user's database at `~/Developer/scrolls-data` is an M1 database plus whatever its own server has loaded since. No migration is needed (`schema_version` 1).
- **At boot:**
  - an idempotent repair re-targets 1.1.0 hypothesis groups;
  - (fix pass) an idempotent repair switches off the English `-er/-ers` variants that tracking switched on by default before (20 on the m5-stemm clone);
  - the demo's stub-failed clustering jobs are queued once;
  - (lead fix, 2026-10-09) an idempotent repair flags gutenberg-stemm translations that language identification cannot see — books whose catalogue credits a translator, or whose estimated date is the life of an author who died before 1450 (`server/adapters/stemm/translation.mjs`). Before it, Bostock's English Pliny put English *virus* at "44–79 CE (estimated)" and Hoover's *De Re Metallica* at 1514–1555. On the live data directory it flagged **63** books; they are now dated as `original_publication` and kept out of text-language chronology by default (D8), like Cipher's translations. New loads get the same flag from the adapter (`W_TRANSLATION_CREDITED`, info). Test: `tests/stemm.translations.test.mjs`;
  - the originals check runs.
- **First requests:**
  - the slice cubes (version 5 since `ref-freeze-1`) and the corpus statistics rebuild once into `cache/`;
  - a corpus holding a Wiktionary collection recounts its tracked expressions once (their input fingerprint changes once);
  - (fix pass) every tracked expression is counted again once on its next use: a run now records the hash of the matching and name-guard code, and the guard changed (Cipher *gene*: 122 → 12 matches in the default view once *The Brimming Cup*'s 'Gene is excluded as a name). While a recount runs, the timeline answers with the previous run and `refreshing: true`.
- Chained loads write `cache/dup-index/<collection>.bin` (41.5 MB for OpenAlex).
- **Restart the live server after this gate.** A server started before it runs the M5 gate's relationship repeat-load check with a quadratic plan: 27.9 ms per link at 100k links of one type, about 5–6 CPU-hours over OpenAlex's 381,800 citations. That server was loading OpenAlex citations during this gate. If the load crawls:
  1. cancel it in the Jobs tray (committed chunks are kept);
  2. restart with this code;
  3. press Load again: links already written are skipped by the same check, now an index seek (0.023 ms).

## Import schema
Supported formats, field mapping, the date grammar, limits and every issue code are in [IMPORT-SCHEMA.md](IMPORT-SCHEMA.md).

## Analysis and its limits
Every computed measure, its gate and its failure modes are in [ANALYSIS-AND-LIMITS.md](ANALYSIS-AND-LIMITS.md). This covers Compare, collocations, spaces, context groups, drift, tone, the baseline ρ and the constellation. The honesty rules every package follows are SPEC §13.

## Data provenance and licences
Every collection carries its licence and selection note into lane headers, Compare and every export (`export_text_allowed = 0` is respected in every format). Counts below are from the m5-stemm clone.

| Collection | What | Licence and attribution |
|---|---|---|
| `demo-world` | 228 invented documents, the "carry the zero" world; names checked against 94k culture works and 3.0M MusicBrainz artists | CC0 (synthetic); labelled SYNTHETIC everywhere |
| `cipher-gutenberg` | 691 Project Gutenberg books (59.8M tokens) | Public domain in the USA |
| `cipher-wikisource-hi`, `-gu` | 450 Hindi and 375 Gujarati Wikisource books | CC BY-SA (Wikisource) |
| `cipher-culture-works` | 94,385 titles of songs, films, TV, books and channels (Wikidata, ranked by sitelinks: prominence-selected) | Wikidata CC0 |
| `cipher-music-relations` | 179,014 works at the ends of documented sample/cover/version links | MusicBrainz CC0; Wikipedia CC BY-SA; ItwoFS CC BY 2.5 (link-back required, kept on each row) |
| roots (etymon tables) | 54,989 families | Wiktionary via kaikki.org, CC BY-SA |
| `stemm-gutenberg` (+ `-restricted`) | 684 public-domain science, medicine and engineering books (62.2M tokens), plus 20 distributed with the rights holder's permission | Public domain in the USA; the 20: the copyright notice inside each text |
| `stemm-openalex` | 118,466 top-cited works per field × 5-year cell; 60,574 abstracts | CC0 metadata; abstracts are the publishers' text, for local research only, never exported |
| `stemm-wiktionary` | attestation claims as external markers (never occurrences) | CC BY-SA 4.0 / GFDL |
| Ngram baseline | Google Books 1-grams, English, 1500–2019, read in place | CC BY 3.0 |

Field labels on OpenAlex works come from a modern classifier, and its `year` may be a reprint year. Both are stated on the lanes and in Compare.
