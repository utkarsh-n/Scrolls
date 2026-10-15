<!-- OWNER: R — RF-1…RF-n and findings, each with its test and tag -->
# Reference changes

The web build (`server/`, `src/`, `tests/`, `scripts/`, `data/`) is the reference implementation of the native port (IOS-SPEC N-03). It is frozen at the git tag **`ref-freeze-1`**. After that tag it changes only through the finding protocol of IOS-SPEC §2.1:

1. fix the reference;
2. run `npm test` with the DYLD workaround;
3. tag `ref-freeze-<n+1>`;
4. add a row here.

N0 then regenerates the affected golden families.

Run the tests with:

```sh
DYLD_LIBRARY_PATH=/opt/homebrew/Cellar/simdjson/4.6.11/lib:/opt/homebrew/Cellar/hdrhistogram_c/0.11.10/lib \
  node --test tests/*.test.mjs
```

| Tag | Changes | Contract | Slice cube | Snapshots |
|---|---|---|---|---|
| `ref-freeze-1` = `839c3f1` | RF-1, RF-2, RF-3 | 1.3.0 (additive request and response fields only) | version 5 | `m1r`, `m5r` (RF-4) |

## RF-1 — unidentified text belongs to its document's language (high)

**Finding** (HANDOFF, data review, high). An unidentified passage of a Spanish or French book counted toward an English word's denominator and coverage. Such a passage is `und` (a heading, a verse number or an old spelling, no stop-word profile matched) or `und-Latn` (Latin text under 8 tokens). Cipher *machine* 1875–1899 listed 148 documents; 76 of them were es/fr books that added only 166k unidentified tokens. The same rule also let a Spanish word count the unidentified text of English books.

**Rule.** It lives in one module, `server/aggregate/langgate.mjs`: `langAdmits` in JS and `langAdmitsSql` in SQL.
- An unidentified row (`und`, `und-…`) of a document's own running text counts in a strand's languages only when the document's text language (`document.lang_text`) is one of those languages, or is itself unidentified. Running text means the field classes `text`, `abstract` and `apparatus`.
- Title rows keep the passage-level rule. They are the works unit, and a short label is `und-Latn` whatever its document's language. Cipher lists 11,955 Hindi films under English labels: the label *Zero* of a Hindi film still counts as an English title.
- Describing passages (catalogue notes, often written in another language than the work) keep the passage-level rule too.

**Where it applies, at once.** These are the places that read a strand's languages:

| Area | Files |
|---|---|
| Slice cube | `server/aggregate/cube.mjs`: **`CUBE_VERSION` 4 → 5**. Each row carries `dlang`, its document's language. The rule is applied in `slicePredicate`, so it covers denominators, coverage, range totals and the share cells. It is also applied in `cubeLastTextYear`, the seam's "full text in these languages". |
| SQL slice | `server/aggregate/query.mjs` `rowWhere`. It covers numerators, tiles, marks, washes, bins, KWIC, search and exports. The `other_language` bucket of `excludedCounts` follows it too. |
| Compare | `server/analysis/slices.mjs` (`spec.langOk(plang, fieldClass, docLang)`: coverage, frequency, strata, passages) · `compare.mjs` (within-cell shares) · `collocations.mjs` · `convergence.mjs` · `jobs/tasks/tone.mjs` |
| Clustering | `server/analysis/tfidf-hash.mjs`: the occurrence filter and the coverage index |

Materialization is unchanged, so no expression is recounted: `MATCHING_CODE_FILES` are untouched.

**Tests.**

| File | Test | What it checks |
|---|---|---|
| `tests/langgate.test.mjs` (new) | the rule, case by case | the rule case by case |
| `tests/langgate.test.mjs` | the SQL twin and the clustering filter | the SQL twin and `clusterFilter` agree with `langAdmits` on 6 strand sets × 6 passage languages × 5 field classes × 7 document languages |
| `tests/aggregate.corpus.mjs` | `buildGeneratedCorpus(db, {und: true})` | The test corpus now holds: unidentified paragraphs carrying *zero* in Spanish, French and Hindi books; a short `und-Latn` block; unidentified apparatus; an English book whose unidentified paragraph carries *cero*; a document with no identified passage; a French paper with an unidentified abstract; a Hindi film listed as *Zero*. The independent oracle `inSlice` states the rule on its own, without importing `langgate.mjs`. |
| `tests/aggregate.binning.test.mjs` | 60 random configs × 6 tiers | the conservation law and the denominators against that oracle; the suite runs on the `und` corpus |
| `tests/aggregate.cube.test.mjs` | 40 configs | cube = SQL on the `und` corpus; the last-text-year SQL oracle carries the rule |
| `tests/aggregate.invariants.test.mjs` | RF-1: an English word is not divided by … | the `language:und` and `language:und-Latn` coverage equals an SQL oracle; `other_language` equals an SQL oracle; no mark lies in a foreign book; the Hindi film's English label is still counted; search = timeline = concordance |
| `tests/aggregate.invariants.test.mjs` | RF-1: a Spanish word … | a Spanish word counts the unidentified paragraph of a Spanish book and of an unidentified document, never of an English book |
| `tests/aggregate.invariants.test.mjs` | RF-1: Compare divides by the same text … | Compare's tokens and documents per slice equal the oracle over `doc_tokens`; no sampled passage comes from a foreign book |

The new invariant tests and the binning oracle fail on the pre-RF-1 code (checked on a clean export of `7ce5521`) and pass after it.

**On real data** (two `cp -c` clones of `m5r`, one queried with the code of `7ce5521`, one with `ref-freeze-1`), Cipher *machine* (expression 5):

| Measure | before RF-1 | after RF-1 |
|---|---|---|
| Compare 1875–1899, documents | 150 | **80** |
| Compare 1875–1899, tokens | 6,168,569 | 6,001,418 (−167,151 unidentified tokens of other-language books) |
| Compare 1875–1899, `und` share of the slice | 2.89% | 0.24% |
| Compare 1875–1899, matches | 291 | 288 |
| Compare 1900–1928, documents | 252 | 235 |
| Rate ratio, B relative to A | 1.56 | 1.53 |
| Timeline (language lanes), `language:und` coverage | 630,227 tokens in 564 documents | 136,474 tokens in 341 documents |
| Timeline (language lanes), `language:und-Latn` coverage | 94,246 tokens in 596 documents | 42,434 tokens in 379 documents |
| Timeline (language lanes), `language:und-Latn~titles` | 92,296 works | 92,296 works (titles keep their own language) |
| Timeline (language lanes), total n | 1,826 | 1,822 |
| Timeline (language lanes), `other_language` | 586 | 590 |

## RF-2 — as saved everywhere a saved view shows a number (D17)

**Finding** (HANDOFF). A saved view opened as saved drew its Scroll, arcs, lineage and notebook from the pinned runs and cutoffs. The inspector's counts, its Crossings card and Compare still read current data: after a revert, a recount or a revised annotation, the numbers changed under the reader of a shared link.

**Change.**
- **`POST /api/compare`**
  - Optional `runs` (`{materialize: {<expr id>: <run id>}, cluster?}`) and `cutoffs` (`{import_batch?, at?, annotation_rev?}`), validated like the timeline query's (`slices.normalizeAsSaved`).
  - The comparison then reads:
    - the pinned counting runs (`resolveExpressions({pinned})`);
    - the documents of imports up to the cutoff, including those soft-deleted after the save (`loadScope({cutoffs})`, `scopeDocFilter`: the rule of `docWhere`);
    - the pinned clustering run, or else the newest one that had finished at the save (`drift.clusterRunFor({run, before, revCutoff})`);
    - readers' labels and human counts as they stood at the annotation cutoff (`annotations.annotationShownAt`, the rule of `GET /api/annotations?rev_cutoff=`).
  - Drift and tone runs started from such a comparison carry the pins and cutoffs. Their params hash differs from the current-data comparison (`driftRunParams`, `toneRunParams`, `routes/analysis.mjs`).
  - The response adds `as_saved: {runs, cutoffs, note}`.
  - `contracts.mjs` adds the optional `CompareRequest.runs`/`cutoffs` and `Compare.as_saved`.
- **`GET /api/kwic?expr=…`** takes `runs`, `import_batch` and `at` (`routes/kwic.mjs` `pinnedMaterializeRun`).
- **The page** reads `ui.savedView` in these places:
  - `panels/compare.mjs` (`compareAsSaved`, re-run on "Show as saved" ↔ "Show current data"; the `as_saved` note is shown);
  - `panels/inspector.mjs`: contemporary uses and any later use (KWIC), links and next (lineage with `rel_rev_cutoff` and `runs`), hypotheses (`rev_cutoff`), context group (the pinned run and `rev_cutoff`), reloaded when the view switches;
  - `panels/crossings.mjs` (the trail query with the pinned runs and cutoffs).
  - How a saved view opens moved from `main.mjs` into `src/ui/core/savedview.mjs` (`openedView`), which the verify journey shares.

**Tests** (`tests/views.as-saved.test.mjs`, describe "RF-2"):

| Test | What it checks |
|---|---|
| Compare as saved counts what the view counted … | After a revert, a recount and a revised plus a new annotation: the as-saved Compare has the same tokens, documents, matches, collections, seeded passages and human counts, and the pinned run in its provenance; current data moves on. |
| the concordance as saved … | the as-saved KWIC total equals the as-saved timeline; current data counts fewer |
| a pin that is not a counting run … | a bad pin is refused (400); normalization drops foreign pins and is idempotent; an as-saved drift run is its own comparison |
| the clustering run as saved … | the pinned run, else the newest finished at the save; labels as they stood; no pinned run of another medium |
| the UI sends the pins and cutoffs only as saved … | the Compare body, the inspector's KWIC and cluster params, the Crossings query (it counts what current data no longer has) |

## RF-3 — the verify journey for the phone, recorded as JSONL

**Change** (`scripts/verify-journey.mjs`, `scripts/verify.mjs`). The journey keeps every earlier step and adds the requests the phone journey needs:
- tracking, and tiles at **L0–L5** with the conservation law (L4/L5 from the extent's days, at most 64 tiles per request);
- Compare and a saved view of the imported text, reopened as saved at once (timeline, Compare and the inspector's KWIC equal current data at the save);
- a link review (G7's "review");
- after the restart: the import reverted, then the views **as saved**: the timeline equals the save, tiles at L0–L5 conserve, KWIC equals the timeline, lineage shows the review status of then, and current data counts fewer;
- **as-saved Compare** (RF-2), which equals the save for the imported and the demo views and differs from current data.

`createClient(url, {record})` records every request and response. `npm run verify` writes the record to `<work>/journey.jsonl`, or to `--record <file>`. The format is at the head of the script:
- a header line, then one object per request: `{seq, step, method, path, headers?, body? | raw? {base64, bytes, sha256}, poll?, status, response | text, ms}`;
- `{event: 'restart'}` where the server restarts;
- `poll: true` marks repeated reads.

The default snapshot is `m1r` when it exists.

**Tests.**
- `tests/acceptance.verify.test.mjs`, the journey over HTTP: every step passes with 0 shape errors. The six new steps are present, and every call is recorded in order with the restart event. The three uploads' bytes match their sha256. There is an as-saved Compare and tiles at L5, and polls are marked.
- `npm run verify` on `m1r` and `m5r` (RF-4).

## RF-4 — fresh snapshots `m1r`, `m5r`

Built on 2026-10-10 from the `ref-freeze-1` tree (a `git archive` export of `839c3f1`, not the working copy) by a full bootstrap on temp data directories, through the reference's own HTTP API. The full evidence and every run id are in each snapshot's `SNAPSHOT.json` and in `Native/Reports/R-ref-freeze-1.json`; how to use them is in `~/Developer/scrolls-snapshots/README.md`. The builder, `~/Developer/scrolls-snapshots/tools/build-snapshot.mjs`, drives the reference over HTTP like a reader would. It stays outside the frozen tree, so a fix to it never needs a new tag; a copy and its sha256 are stored in each snapshot.

**m1r** (5 min at load ≈ 13–30)
- **Built from:** the server's first launch, which loads the demo with its pipeline and runs the Cipher bootstrap (A 42 s, A2, B, the boilerplate pass), then every tracked count brought up to date.
- **Counts:** 275,134 documents, 1,529,862 passages, 702 originals stored inside.
- **Database:** `scrolls.db` 1.72 GB, sha256 `acc9cbe1…a7a2`, `quick_check` ok.
- **`npm run verify`:** PASS. npm test 1,143 / 1,141 / 0 fail / 2 skipped; journey 26/26 rows; 157 calls, 0 shape errors; 705 originals checked.

**m5r** (15 min)
- **Built from:**
  - a clone of m1r;
  - gutenberg-stemm (704 documents), OpenAlex (118,466) and Wiktionary (8 entries) loaded through the Adapters API, and Ngram answering `E_NOTHING_TO_LOAD` (it is read in place);
  - the M5-gate words tracked;
  - the English pooled space and its era slices (8 vectors runs);
  - the drift pair: run 35, overlap 0.8889, displacement 0.66, "within typical variation";
  - clustering: Cipher *bank* (run 38, 2 groups) and *zero* (run 39, 2 groups), with *virus* and *gene* honestly gated.
- **Counts:** 394,312 documents, 2,763,209 passages, 1,407 originals inside.
- **Database:** `scrolls.db` 3.64 GB, sha256 `c90cde16…7ca4`, `quick_check` ok.
- **`npm run verify`:** PASS, the same rows as m1r; 1,410 originals checked.

Both snapshots are in a steady state: no tracked expression is stale by the reference's own freshness rule (`SNAPSHOT.json` `counts.stale_expressions` = []).

**Found while building.** A first m1r build left the demo's four counts stale: the Cipher boilerplate pass bumps the database-wide `quality_version` after the demo is counted. A clone then recounted the demo on its first read, so the verify journey's highlights carried new occurrence ids. The builder now brings every tracked count up to date before it finishes, and both snapshots were rebuilt. This is reference behaviour (conservative and correct), not a change.

## Pending for the next freeze (found after `ref-freeze-1`; web UI only, no golden family affected)

These wait for the first differential finding, to land with it under one new tag. Fixing them in the working tree alone would make the tree differ from the tag that the generators record.

| # | Defect | Effect | Fix |
|---|---|---|---|
| P-1 | `src/ui/panels/inspector.mjs` `loadGroups`, as saved: the view's pinned clustering run is requested for the passage's expression even when that expression is not the view's strand. This happens with a passage opened from a search while a cluster-lane view is open as saved. | `GET /api/clusters` answers 404 ("not a clustering run of this expression"), and the inspector's context-group block shows an error card. No number is wrong. | Use the pinned run only when the view's single expression strand is the passage's expression; otherwise keep the membership rule of current data. |

## Known and by design (ported as is; IOS-SPEC §7.2)

| Finding | Decision |
|---|---|
| Title Case scientific names are excluded as names (rule (a) of the name guard; 101 STEMM *virus* rows) | Known, by design in v1: a policy with a reader override (the names toggle, per-match overrides). |
| Translation flag on Hugo's *Le Dernier Jour…* (pg:6838) | A data issue in Cipher's declaration; ported as is. |
| Source byte ranges missing for relation endpoints and Wiktionary entries | Ported as is; the metadata is kept verbatim, so "Original record" works without pointers. |
| Double-BOM offsets, duplicated demo relationship groups, ItwoFS coincidence links in old databases | Absent from `m1r`/`m5r`, which are built by the current rules. |
| A mark under an emergence tick loses hover to the tick | Web only; on the phone the ambiguity chooser lists both. |
| As saved without a pinned clustering run, the inspector's context group shows the run its passage belongs to | A run is immutable, so the groups shown never change. A newer run is named ("A newer analysis exists"). Compare's context groups as saved use the newest run that had finished at the save. |
