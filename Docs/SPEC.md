# Scrolls — A Living Atlas of Meaning · SPEC v1.0 (single source of truth)

Status: **final build specification**, 2026-10-03. Supersedes the three proposals in `Docs/proposals/`.
Base: the **Philologist** proposal (judged winner twice), with the named grafts from Cartographer and
Engineer, every judged fatal flaw fixed, and every "gap all missed" closed. Every number marked
**(measured)** was re-measured on disk on 2026-10-03 while writing this spec; the DDL in §3 was executed
verbatim on this machine (node v26.10.0, `node:sqlite` SQLite 3.53.4, ICU 78.3) and its CHECKs and
triggers were exercised.

**How implementation agents use this file.** §12 assigns every file in the repository to exactly one work
package. Read §0 (ground truth), §13 (honesty rules) and the sections your package owns. Where this spec
gives a number, use that number. Where it gives a name (file, function, column, endpoint, CSS token), use
that name. A contract change goes through the WP0 owner (§12.6).

The rule behind the design: **every pixel answers three questions — what is the evidence, how was it
obtained, and how much of the record did we look at?** Four invariants follow, and schema, API and
renderer each enforce all four:

- **I1 No continuity without observation.** Nothing is drawn across a bin with zero observations.
  "Looked and found none" and "no sources" look different.
- **I2 Every mark resolves to text** (or to a labelled statement of why no text exists). Every occurrence
  opens a passage with offsets into the original; every edge has evidence rows; every aggregate shows its
  denominator.
- **I3 Evidence status is set once.** `relationship.evidence_status` is immutable (DB trigger). Human
  review is a separate layer. Status is shown by line pattern + glyph + word, never by colour alone.
- **I4 Estimates are gated.** Anything beyond counting is computed only when its minimum-evidence gate
  passes; otherwise the UI shows the gate, what is missing, and a computed widening suggestion. A gated
  metric has **no value** (DB CHECK).

---

## 0. Ground truth and fixed decisions

### 0.1 What is on disk (verified; agents must not "re-discover" differently)

| Source | Fact | Consequence in this spec |
|---|---|---|
| Cipher Gutenberg (`$T/texts/gutenberg.json` + `gutenberg/<id>.txt`) | 693 entries, **691 unique files, none missing**: #1661 appears 3× (three QIDs, one text). Declared en 393 / fr 170 / es 130. **About 100 of the 170 `fr` books and about 10 of the 130 `es` books are English text** (two independent stop-word checks: 98/10 and ~100/9; e.g. #135 *Les Misérables*, #19942 *Candide*); 2 `en` books are French. 116 years equal author birth+40 (Cipher's `lifetime_year`). 31 files lack the exact `*** START OF` marker (28 `***START OF`, 3 old "SMALL PRINT"). Spot checks: *Pride and Prejudice* = 1800, *Ulysses* = 1914. | §6.3: `lang_declared` vs `lang_text`, `is_translation`; translations dated `original_publication` and excluded from text-language chronology by default; #1661 → 1 document + 2 aliases; three marker regexes; date card says "unverified". |
| Gutenberg licence | Under exact-marker stripping, 57 files contain *virus* and **29 of them only via the licence's "computer virus"** (judge-measured). | §4.6 boilerplate pass + the `virus` canary test (§11). |
| `culture-works.tsv` | 94,385 rows, **no header**, 16 columns (measured). Unknown year is the **empty string (8,227 rows)**; `0` never occurs (measured). **28 rows dated 2027–2038** (measured). Kinds: song 49,344 · film 22,838 · book 10,999 · tv 8,501 · sport 2,352 · channel 351. | `''` and `0` → undated; future → Scheduled shelf (`basis='announced'`). |
| Culture titles (token match, measured) | *virus* 2 films (*Virus* 1999, *Mickey Virus* 2013) · *viral* 4 (2 songs incl. romanized Tamil *Oru Viral Puratchi*, 2 films) · *hacker* 0, **with plural variant 1** (*Hackers*, film 1995) · *algorithm* 0, **with plural 1** (*Introduction to Algorithms*, book 1990) · *gene* 4 (≥1 is a personal name: *Drive (For Daddy Gene)*) · *quantum* 6 · *bug* 9 (+3 *bugs*) · *robot* 21 · *radio* 46 · *zero* 31. Summaries: *computer* 66 (mostly "computer-animated film"), *gene* 68 (mostly people named Gene). Substring search would also hit *Thackeray* for "hack" (trigram verified). | Counting is token-based with inflection variants; trigram is typeahead only; empty states are **computed, never hard-coded**; `proper_noun_guard`; summaries are `describes`. |
| Raw music relations `$T/songs/relations_*.json` | `relations_mb.json` **161,803** (cover 109,682 · version 28,496 · samples 17,833 · remix 4,459 · interpolates 1,333), each with a MusicBrainz recording URL in `page` and years on both ends; `relations_wiki.json` 9,581 (samples 6,380 · interpolates 2,373 · version 644 · inspired 182); `relations_itwofs.json` 428 (measured). culture-works `siblings` keep only pairs whose both ends are among the 94k. | §6.6 `cipher.relations` adapter + the **Genealogy** view (§2.C2): the documented sampling genealogy is first-class. |
| `roots.tsv` | 54,989 families; source languages la/sa/grc/ine-pro only. **2,225 families list >1 parent (measured): 704 mix a Sanskrit dhātu with a PIE root (a chain written flat), 351 are variant reconstructions (forms within edit distance 2, e.g. \*krews-/\*krows-), 1,170 unresolved (compounds such as θεοτόκος ← \*dʰeh₁- + \*tek-, and true alternatives such as *silva* ← \*sel-/\*swel-).** `la:signale` has **no** roots; `la:virus` lists \*weys-, \*dʰewb-, \*dʰewbʰ-. `sa:शून्य` (śūnyá "blank") → en *zero*, hi शून्य, gu શૂન્ય. | Multi-parent lists are **never** drawn as competing hypotheses or as a single parent: `etymon.parent_semantics` + a "listed roots" bracket (§1.7). |
| OpenAlex (`sources/openalex/`) | 118,466 works = **top 200 most-cited per (20 fields × 30 bins)**; FORMAT.md: "never compare raw counts between cells". 60,574 abstracts (~9.9M tokens), rebuilt from inverted indexes (74 with gaps >10%, 259 >1,000 tokens = body excerpts, 1,987 <10 tokens). 381,800 in-sample citations; **6,666 cite a later-dated work**. Field labels are a modern classifier's (Principia → "Theoretical Computer Science"). `year` may be a reprint year. ~13.2k German works. Abstracts: publishers' text, local research only. | Within-cell presence shares, no cross-cell trend claims (§10.4); date conflicts never feedback; `export_text_allowed=0`; `de` in language ID; gappy abstracts excluded from quotation detection. |
| Wiktionary coinage | 201,085 entries; **9,386 with a primary stated attestation** (7,639 with `subject_hint='headword'`) (measured). CC BY-SA. | Claims are hollow-diamond markers, never occurrences. |
| Ngram baseline | `ngram-eng-1.sqlite`: **1-grams only**, 146,193 folded types, 1500–2019; hyphenated words split (only *x-ray*, *hip-hop* kept); `hacker` dominated by capitalised *Hacker*. CC BY 3.0. | Multi-word expressions get "no external baseline (single words only)". |
| gutenberg-stemm | **Fetch in progress** on 2026-10-03 (catalogue rewritten as it runs; 205 texts on disk at 19:14; quotas ≈ 596 books + periodical issues). Earlier judge snapshot: 707 rows, 222 dated only by author-lifetime estimate, 61 undated, 50 after 1928. | Adapter imports whatever is on disk (sha256-checked), creates metadata-only documents for rows without text, and **reports** dated-by-evidence vs estimated vs undated counts in the coverage panel. |
| MusicBrainz tables `~/Developer/cipher-data/musicbrainz/tables` | artist (3.0M rows), recording (40.4M), l_recording_recording, l_work_work, `recording_years.u16` (measured). 7.6 GB dump kept. | v1 uses them only for the **demo-name collision test**; date recovery and full chains are "later" (§14). |
| FTS5 build (measured, 40 Cipher books, 2.72M tokens) | contentless `detail=full` index = **5.5 MB per million tokens**, build **0.37 s per million tokens**; vocab-instance count 0.1 ms; phrase query 0.4 ms. | Whole corpus ≈ 70M tokens → ≈ 390 MB index, ≈ 30 s FTS time. No prefix index. |
| Tokenizer | Default `unicode61` splits Devanagari/Gujarati words; `categories 'L* N* Co M* So'` keeps them whole and indexes emoji/symbols (verified). ⊙ (U+2299) is `Sm`, not `So` — the demo symbol is ◉ (U+25C9, `So`). JS-token ↔ FTS-instance parity verified on Latin+diacritics, Gujarati digits, emoji. | §4.3 tokenizer `u61m-1`. |
| Ports | spectra-lab 3002, orbital-atlas 3001. | Scrolls binds **127.0.0.1:3460**. |

### 0.2 Fixed decisions (do not re-litigate)

| # | Decision | Why (one line) |
|---|---|---|
| D1 | **4D = Time × Lane × Strand × Transmission.** The playhead is the *vantage* (reading) clock that moves along Time and gates Transmission; it is not a fifth axis. Rate, variety, coverage and evidence are quantities read on marks. | You navigate a dimension; you read a quantity. |
| D2 | **A bar is a maximal run of observed bins** at the current tier. Gaps are never bridged. A record counts in a bin only if its date interval fits that bin; otherwise it is a **precision wash**. | No false precision; integer counts keep Poisson CIs valid; conservation is testable. |
| D3 | **Linear time everywhere.** The only non-linear display is the **folded overview** (fixed linear regimes, labelled seams ×3.3/×8.9/×3.3, panning disabled) and the always-visible 28 px minimap. No log axis for time, ever. | Deep time and a single day are both readable without hidden scale tricks. |
| D4 | Offsets are **UTF-16 code units** into the decoded original string. | Node and browsers slice natively; round-trip tests prove it. |
| D5 | Time = integer **days since 1970-01-01**, proleptic Gregorian, **astronomical years** (1 BCE = 0); intervals inclusive `[lo_day, hi_day]`, plus `y_lo/y_hi`. | One integer line from PIE to a day in 2026; fits `rtree_i32`. |
| D6 | Aggregation base = **`expr_doc`** (exact counts per expression × document × passage language × field class) joined to **`doc_bin`** and **`doc_tokens`**. Occurrence rows are materialized lazily per tracked expression. | Tiles join ≤ ~460k rows; offsets only where evidence is shown. |
| D7 | **Evidence status ∈ {documented, computed, proposed}**, immutable. `documented` requires `origin='source_dataset'` (CHECK). An in-text attribution cue is stored as `proposed` + a `citation_cue` evidence row (CUE badge). Review status (confirmed/rejected/disputed) is a separate layer that never changes the line style. | Inferred lineage cannot be mistaken for documented citation, and human review never erases what the source claimed. |
| D8 | Translated texts are excluded from text-language chronology by default (toggle dates them by the original). | The English text of a French novel was not written in the novel's year. |
| D9 | Culture-work **titles** are dated with the work; summaries and Cipher glosses are `time_role='describes'` and excluded from frequency/drift by default. | A 2015 Wikidata sentence is not 1962 language. |
| D10 | First launch opens the **synthetic demo instantly** and **auto-starts a metadata-first Cipher import** (titles, relations, themes, etymology in ≤ 60 s); full text indexes in the background. `SCROLLS_NO_AUTO_IMPORT=1` disables it. | The user sees his own data within the first minute. |
| D11 | One writer at a time, WAL, **read-only worker pool** (3 workers) for heavy reads, SharedArrayBuffer cancel flags for jobs. | `node:sqlite` is synchronous; the HTTP loop must never block. |
| D12 | Server binds `127.0.0.1:3460`; Host/Origin checks against DNS rebinding; ETag `W/"<dataVersion>-<hash>"`. | Localhost only, safely. |
| D13 | STEMM adapters read **staged files only** (`$SCROLLS_DATA/sources/<name>/`, FORMAT.md + MANIFEST.json first). Network fetchers stay in `tools/fetch/` and are run by the user. | Adapters read what exists; the app never fetches by surprise. |
| D14 | OpenAlex lanes show **within-cell presence shares** (k of n sampled works mention the term) on OpenAlex's own 30 bins; cross-cell trend claims are refused (`sampling_design`). | The sample is top-cited per cell, not a random sample. |
| D15 | The **text→titles modality seam** (full text ends 1928) is a permanent labelled element of the axis; Compare refuses cross-modality comparisons by default (`modality_mismatch`). | A change of medium must not read as a change of meaning. |
| D16 | Query types: **expression · work · maker · theme**. A rapper can start from a record ("everything that sampled this") or an artist. | The Cipher rap layer is works, makers, themes and links — not lyrics. |
| D17 | Saved views are **immutable** (re-save → `slug~2`), pin data version, import cutoff, run ids, annotation and relationship revision cutoffs; documents are only soft-deleted. | A shared link must never change under its reader. |
| D18 | Annotations and evidence spans are anchored by `(doc_id, text sha256, field, start, end, quote, prefix, suffix)`, not by passage id alone. | Re-segmentation or an ICU upgrade must not orphan interpretations. |
| D19 | The demo is the **"carry the zero" world** (§9), all synthetic, names collision-checked against the 94k culture works, 3.0M MusicBrainz artists and 40.4M recording titles. | Most on-brand story for a multilingual rapper-engineer; no synthetic name may match a real one. |
| D20 | Zero npm dependencies. Node ≥ 26 (`node:sqlite`, `node:test`, `worker_threads`), vanilla ES modules, Canvas 2D + SVG/HTML, no CDN. | Same idiom as spectra-lab / orbital-atlas. |

Runtime data layout (outside iCloud; `SCROLLS_DATA` overrides `~/Developer/scrolls-data`):

```
scrolls-data/
  scrolls.db  scrolls.db-wal  scrolls.db-shm
  originals/ab/<sha256>                 verbatim bytes of every imported file (content-addressed, immutable)
  incoming/<importId>.part              uploads in progress
  derived/tokens/<lang>.u32|.pidx|.vocab.tsv   token-id streams per data version (analysis)
  derived/spaces/<spaceId>.f32|.vocab.tsv      PPMI-SVD spaces;  derived/align/<id>.f32
  derived/reuse/run-<id>/{units.bin,lsh.bin}   near-quote index;  derived/wiktionary/word-index.json
  sources/<name>/...                    staged STEMM sources (existing; read-only to the app)
  cache/  exports/  snapshots/  logs/scrolls.log
  bin/scrolls-nl                        optional compiled Swift adapter
```

`server/config.mjs` refuses to open a database whose path is under `~/Documents` or
`~/Library/Mobile Documents` (iCloud) and exits with `E_DB_IN_ICLOUD`.

---

## 1. The 4D gantt — "the Scroll"

*"Basically a 4D gantt chart you can infinitely scroll to see the evolution of linguistics."*

### 1.1 The four dimensions

| Dim | Name | What it is | Encoding | How you move through it |
|---|---|---|---|---|
| **D1** | **Time** | When the evidence was produced: the document's chronology interval `[lo_day, hi_day]` with precision, basis and role. Basis switch: *publication* (default) or *referenced* time (what a passage is about, when a record states it). | x, linear within any view. Intervals are spans, never points. | Infinite horizontal pan, semantic zoom, folded overview, minimap. |
| **D2** | **Lane** | A categorical partition of the evidence on a facet the user picks (§1.3). | Horizontal bands with a DOM header `label · unit · coverage`. No y-axis, no ticks, no gradient between lanes. | Pick facet / sub-facet, reorder, collapse, "+n more lanes". |
| **D3** | **Strand** | *What* is tracked inside a lane: an expression (with its variant group), a sense hypothesis, a theme, a work (works mode), or the external baseline. Up to **4 pinned** expression strands. | Sub-rows inside each lane, told apart by **start-cap glyph ● ■ ▲ ◆** and a label chip; strands are ivory, hue is reserved for roles. | Pin (`P`), unpin, expand a lane to see its strands. |
| **D4** | **Transmission** | How one occurrence or work became material for another: relationships (quotation, citation, sample, adaptation, reinterpretation, similarity). | Arcs: forward arcs **above** the strands (earlier → later), **feedback** arcs **below** (later → earlier, violet), date conflicts as red stubs. | Relation-family chips, evidence filter (`E`), open in Lineage / Genealogy. |

**The vantage clock (the playhead).** A second time on D1: *the time of reading*. It answers "what did
the record contain, and how had it been re-read, as of 1997?". Marks after the vantage are hidden
(*strict*) or ghosted at 15% (*context*); an arc appears only once both ends are ≤ vantage; a feedback
arc and the violet "re-read" halo appear only when the vantage reaches the later work. The notebook's
"as of" slider is the same clock applied to human interpretations (§2.F).

**Quantities read on marks (not dimensions):** rate (bar height, unit printed), contextual variety (4 px
variety strip), coverage (coverage track + lane underlay), evidence status (line pattern + glyph +
word), tone (optional overlay ticks, fallible). The header tooltip reads: *"An analytical model, not a
claim that meaning has four dimensions."* The brief's five occurrence coordinates map as: expression → D3;
document time → D1; context → D2 lanes and sense strands; affect/stance → optional overlay (fallible
machine tone, or human `stance` dimension); significance/interpretation → annotation pins + D4
reinterpretation arcs.

### 1.2 What a bar is (honest definition)

For a strand `g = (strand s, lane value ℓ)` at the current tier with bin width `b`:

1. `O_g` = the dated, non-excluded matches of `g` whose document interval **fits inside one bin**
   (`fits(y_lo, y_hi, level)`). Matches that do not fit become **precision washes** (§1.7).
2. `n_i` = count in bin `i` (tokens matched for text lanes; distinct works with ≥ 1 match for title
   lanes; distinct sampled works for OpenAlex cells). `denom_i` = the slice denominator for
   (ℓ, bin i, active filters, the strand's languages, the same field class): tokens, works or entries,
   counted over documents that also fit the bin.
3. Each bin has exactly one **state**:

   | State | Condition | Drawn as |
   |---|---|---|
   | `observed` | `n ≥ 1` | rect, height = rate |
   | `absent` | `n = 0` and `denom ≥ gate` (50,000 tokens · 30 works · 20 sampled works) | 1 px dotted baseline; tooltip "0 occurrences in 4.1M tokens — looked, found none" |
   | `low` | `0 < denom < gate` | rate suppressed; raw n as a hollow tick; underlay light hatch; tooltip "low coverage: n = 3 in 18k tokens" |
   | `uncovered` | `denom = 0` | nothing in the strand; lane underlay 45° hatch (6 px pitch) "no sources" |
   | `pending` | the collection is still indexing | lane underlay sparse dots "indexing — not yet looked" |

4. **A bar is a maximal run of consecutive `observed` bins.** It never bridges `absent`, `low`,
   `uncovered` or `pending`. Between bars nothing is drawn: no line, no fill, no interpolation.
5. **Caps.** A start cap carries the strand glyph (● ■ ▲ ◆) at the **exact first observed date** inside
   the bar (even when bins are coarse); the end cap is a 2 px tick at the exact last observed date.
   **Censoring:** if the first observation falls in the lane's **first covered bin**, the start cap is
   an open chevron `◁` ("may be older than our record"); `▷` likewise at the last covered bin.
6. **Height.** Linear in the lane's rate unit; max = 70% of the strand slot; any observed bin ≥ 2 px.
   The strand chip prints the scale ("height: per million tokens · full = 84/M"). One thickness scale
   **per unit** present, shown in the legend.
7. **Fill.** `n ≥ 5` solid ivory (88% opacity, 1 px lighter top edge). `1 ≤ n ≤ 4` *sparse*: 1 px
   outline + 25% fill. Superscript `¹` when ≥ 60% of the bin's n comes from one document
   ("single-source burst"). 3 px diagonal stripes + `≈` when > 50% of the bin's n comes from
   `basis='estimated'` dates. Synthetic material additionally carries the `--syn-stripe` overlay.
8. **Units never mix.** Text lanes: *per million tokens of that lane's slice*. Title lanes: *per 1,000
   works of that lane's slice*. OpenAlex lanes: *share of sampled works in the cell* (§10.4). External
   baseline: *per million (Google Books eng)*, its own track. A facet value whose evidence spans units
   (e.g. "English" covers book text and song titles) is split into sub-lanes "English · text" and
   "English · titles".
9. **Tooltip** (generated from the same numbers as the drawing): *"carry the zero · Hip-hop · first
   observed 1994 · last observed 2024 · observed in 19 of 31 covered years · 3 gaps · 212 matches
   (6 in washes, 1 undated) · per-million rates over 41.2k tokens · SYNTHETIC."*

**Works mode.** When the strand is a work, a maker or a work's genealogy (D16), participants are drawn as
**work marks**: a 6 px diamond at the work's date (bracketed span `⊢—⊣` when the work spans time, e.g.
a TV run), with relation arcs between them. Works mode never draws rates.

**Theme strands.** A theme strand (e.g. *hip hop*, *protest*) shows the share of works tagged with the
theme per bin (per 1,000 works of the lane), split into up to three sub-strands by tag provenance:
`documented_category` (solid), `machine_tag` (hatched, "machine tag — fallible"), `genre_heuristic`
(dotted). Its inspector lists NPMI neighbours from `culture-themes.tsv` labelled "computed by Cipher".

### 1.3 Lanes

| Facet | Meaning | Notes |
|---|---|---|
| `domain` | Etymology · Literature · STEMM · Culture · Imported · Demo | default for the real corpus |
| `community` | import field / demo community | default for the demo |
| `kind` | book · song · film · tv · sport · channel · paper · abstract · entry · user kinds | |
| `culture` | Cipher's country of origin | labelled **"country of origin (Wikidata)"**, never "community" |
| `language` | passage-level detected language | Latin-script titles are `und-Latn` (too short to identify) |
| `collection` | source | |
| `field` | STEMM field (§10.3) | |
| `modality` | text · titles · abstracts | diagnostic; shows the 1928 seam plainly |
| `cluster` | sense hypotheses of one expression | needs a clustering run (§4.8) |
| `date_basis` | stated · estimated · derived · announced | diagnostic |

- **Order rule**, always printed in the lane header row: `first_observed` (default) · `total n` ·
  `alphabetical` · `manual` (drag; saved with the view). Lane order is **never** derived from an
  embedding or projection.
- **Limits:** 10 lanes desktop, 5 narrow; the rest fold into a "+7 more lanes" row; ≤ 48 strands visible.
- **Header:** `label · unit · coverage`, e.g. "English · text · 12.4M tokens, 1823–1928", with a
  prominence note when the collection is `prominence_selected` ("selected by Wikipedia prominence").
- **Not a scale of meaning:** gridlines only between lanes; no tooltip mentions vertical position;
  equal lane heights per strand count; the legend always carries *"Lane order is a sorting choice
  (first observed), not a scale of meaning."*; cluster lanes say "machine label (editable)".
- **Presets:** *Domains* (Etymology / Literature / STEMM fields / Culture titles), *Term trail* (§10.5),
  *Community* (demo), *Languages*.

### 1.4 Geometry and visual layer (the gantt must be beautiful, not an instrument panel)

- Layout left→right: lane headers (168 px, DOM) · **UNDATED shelf** (88 px, pinned, label rotated
  "UNDATED · outside chronology", separated by a double rule) · timeline canvas · **SCHEDULED shelf**
  (64 px, past the "today 2026-10-03" line).
- Strand slot 24 px (compact 16, comfortable 36); a lane with one strand is 40 px tall; lane bands
  alternate `--bg-0`/`--bg-1`.
- Bars: rounded 2 px corners, ivory `--ink` at 88%, 1 px top highlight `rgba(255,255,255,.12)`.
  Washes: translucent band (opacity .18) with a 1 px top rule and a count label ("6 · dated to decade").
- Arcs: quadratic, 1.5 px, height = min(lane band, 0.25 × horizontal distance); amber/violet/ivory-2 by
  role, pattern by evidence (§8.6). Selection glow: cyan 2 px + 6 px 20% halo (no halo animation).
- Chips and badges are drawn **only on hover/selection or at ≥ 120 px of free room**; at rest the Scroll
  shows bars, caps, arcs and the coverage track — nothing else.
- Typography: UI `system-ui, -apple-system, "SF Pro Text", "Segoe UI", sans-serif` 13 px; passages
  `ui-serif, "New York", "Iowan Old Style", Georgia, "Noto Serif Devanagari", "Noto Serif Gujarati",
  serif` 17 px / 1.6, max 68ch; numbers `ui-monospace, "SF Mono", Menlo` tabular.

### 1.5 Time axis: infinite scroll, semantic zoom, folded overview

- **Viewport state:** `{mode:'linear', centerDay, daysPerPx}` or `{mode:'folded'}`. Pan domain
  [10000 BCE, 2100 CE]; zoom from 0.05 px/year (28,000 years across 1,400 px) to **40 px per day**.
- **Ruler:** major ticks "1850", "500 BCE", "Apr 1931"; footer caption "Bins: decades · 1 cm ≈ 12.5
  years" (CSS cm). Whenever the bin level changes, a pill "Now showing yearly bins" shows for 1.5 s (static
  text in reduced motion) and the live region says the same.
- **Folded overview** (`D` key, the Deep-time button, or zooming out past 0.05 px/yr with "Keep
  linear" off): four **fixed linear regimes**, each with a fixed share of the canvas width W:

  | Regime | Years | Share of W | Scale at W = 1,400 px | Bin in this regime |
  |---|---|---|---|---|
  | Deep time | 7000 BCE – 500 BCE | 15% | 1 px ≈ 31 years | millennium |
  | Classical–medieval | 500 BCE – 1500 | 15% | 1 px ≈ 9.5 years | century |
  | Early modern | 1500 – 1800 | 20% | 1 px ≈ 1.07 years | decade |
  | Modern | 1800 – 2030 | 50% | 1 px ≈ 0.33 years | decade |

  Regimes are joined by 10 px **zig-zag seams** labelled with the ratio of neighbouring scales computed
  at runtime (×3.3, ×8.9, ×3.3 at any W). Each regime has its own scale bar in the footer. Marks crossing
  a seam carry a break glyph; tooltips never report a distance across a seam. **Panning is disabled**;
  clicking a regime or brushing a range unfolds to linear centred there with the toast "Linear axis ·
  1 px = 0.11 yr".
- **Minimap** (always visible, 28 px, under the toolbar): the folded overview showing data density per
  lane group (one 3 px row each) plus the modality seam, with the current viewport as a **draggable cyan
  bracket**.
- **No log scale is ever used for time.** The coverage track uses a stated 5-class step scale (§1.7).

### 1.6 Level-of-detail tiers

The bin is the smallest calendar unit whose width ≥ 8 px. The server picks `mode: bins | occurrences`
per tile; the client never receives more than **4,000 occurrence marks or 20,000 bin cells** per
viewport. Users can force a coarser tier, never a finer one.

| Tier | px/year | Bin | Strands drawn as | Other layers |
|---|---|---|---|---|
| L0 Millennia | < 0.08 | 1000 y | presence bars (no heights) | language-period bands; coverage silhouette; arc bundles |
| L1 Centuries | 0.08–0.8 | 100 y | bins with heights | period bands; descent connectors; arcs ≤ 150 (else bundled) |
| L2 Decades | 0.8–8 | 10 y | bins | split/merge glyphs; all arc types ≤ 300; washes |
| L3 Years | 8–96 | 1 y | bins → individual marks when ≤ 4,000 visible | uncertainty brackets |
| L4 Months | 96–2,922 | month | occurrence marks | "dated only to the year" band at the top of the strand |
| L5 Days | ≥ 2,922 | day | occurrence marks; inline KWIC when ≥ 120 px free | coarser-dated band |

**Occurrence override:** whenever the viewport holds ≤ 4,000 dated matches, individual marks replace
bars at any tier (bars become a 20% backdrop) — sparse expressions show individual occurrences at every
zoom. Text matches are 1×8 px ticks, title matches 5 px diamonds, estimated dates hollow ticks. At L4/L5 a
year-precision item is **never drawn at 1 January**; it sits in the coarser-dated band ("41 items dated
only to 1997"). OpenAlex `-12-31` dates carry "⚠ possible placeholder date".

**Aggregate click:** clicking a bin opens the **bin drawer** (virtualized, 50 KWIC rows per page, sorted
by date, denominator line on top); each row opens its passage. Every visible quantity is ≤ 2 clicks from
text.

### 1.7 Coverage, uncertain dates, shelves, deep time

- **Coverage track** (24 px under the ruler) plus a 3 px underlay per lane. Grey **5-class step scale**
  with legend: 0 · <10k · <100k · <1M · ≥1M tokens (works: 0 · <10 · <100 · <1,000 · ≥1,000). Hatched =
  no coverage; dotted = pending. Header text: "coverage (step classes)".
- **Precision washes:** records whose interval does not fit the current bin are drawn as a translucent
  band across `[lo, hi]` in the strand slot, with a count label. **Washes are never added to bars or
  rates.** Circa intervals feather 10% at both ends. The **conservation law** holds at every tier and is
  tested: `Σ bin n + Σ wash n + undated + scheduled = total n` (same filters).
- **Uncertain-date brackets** at occurrence tiers: stated = solid bracket; estimated = dashed bracket +
  "≈"; derived (calendar conversion, e.g. Vikram Samvat) = solid bracket + "⇄"; period = hatched band;
  announced = open bracket on the Scheduled shelf.
- **Undated shelf:** per-lane counts ("UNDATED · 172"); click → virtualized searchable list. Undated
  items never enter bins, rates or denominators; their tokens appear as "undated coverage". If a lane's
  undated share of matches is ≥ 20%, the lane header shows "⚠ 34% of matches undated" and the inspector
  offers "compare undated vs dated" (composition by kind/collection/prominence of the two groups).
- **Scheduled shelf:** items with `chrono_status='scheduled'` (e.g. culture works dated 2027–2038).
- **Deep-time bands (etymology).** At L0–L2 the lane "Etymology — periods, not dates" appears whenever a
  pinned expression has `roots.tsv` ancestry (member word → etymon → roots). Each etymon/root is a
  translucent hatched band over its `language_period` (fuzzy ends), labelled e.g. *"Sanskrit śūnyá
  'blank' — period of the language, not a date for the word"*. Descent is a dotted amber connector from
  the band's right edge to the strand's first corpus observation, labelled "descends (Wiktionary via
  kaikki.org, undated)" — never anchored to a year.
- **Listed roots bracket.** When an etymon lists several parents, the bands are grouped under a bracket
  whose label comes from `parent_semantics`: `listed_chain` → "Wiktionary lists a Sanskrit root and a PIE
  root (likely a chain; not stated)"; `listed_variants` → "variant reconstructions of one root";
  `listed_unresolved` → "Wiktionary lists N roots; how they relate (components or alternatives) is not
  recorded". **Never** auto-drawn as competing hypotheses; a user may create a `hypothesis_group`.
- **No family → said so:** "No etymology family in Cipher's roots data (Latin, Greek, Sanskrit, PIE
  only)" — e.g. *bug*, *hacker*, *algorithm*.
- **Wiktionary claim marker:** a hollow amber diamond left of the strand: "Wiktionary: first attested
  1898 (external claim)". Never an occurrence; never moves the bar's start.
- **External baseline:** a thin line in its own 32 px track under the lane group, own axis, label
  "Google Books Ngram, English, 2020 edition — a different corpus (CC BY 3.0)". Multi-word expressions:
  "No external baseline: the Ngram store holds single words only."

### 1.8 Branches, convergence, lineage arcs, feedback

- **Split (branch)** — lanes = cluster and a `cluster_transition(kind='split')` exists: a 1.5 px dashed
  S-curve from the parent strand at the child's first-observed date into the child's lane, glyph `⑂`.
  Tooltip: *"Context group 3 'verse · counted · hold' emerges 1994. Nearest earlier group: 2 (centroid
  cosine 0.58). Run #14, k=4, stability 0.81, representation tfidf-hash-4096. **Computed: a split in
  usage contexts, not a claim about speakers.**"*
- **Convergence (merge)** — glyph `⑃`, dashed, between the strands of two pinned expressions when the
  convergence metric passes its gate (§4.8); tooltip shows J(t) values and the CI. An annotation that
  asserts convergence draws a violet dashed bracket labelled "annotated".
- **Lineage arcs** — above the strands, earlier → later, arrowhead at the later (derived) end. Colour =
  role (amber reference to earlier material; violet reinterpretation; ivory-2 similarity). Pattern =
  evidence status. **Budget:** ≤ 300 individual arcs per viewport, priority documented > computed >
  proposed, then evidence rows, then nearness to the vantage; beyond that arcs are **bundled** per (lane
  pair, bin pair) with width ∝ log₂(count+1) and a count label; "+212 more arcs (filtered)" chip.
  `kindred`, `counterpart` and rejected relationships are hidden by default.
- **Feedback arcs (later → earlier)** — only from (a) relationships whose `rel_type.feedback_capable=1`
  (reframes, answer_to, recontextualizes, parody_of) with status documented or proposed, or (b) human
  annotations with `dimensions.reframes_target = true`. Drawn **below** the strands in violet with the
  arrowhead on the **earlier** mark, visible once the vantage ≥ the later date; the earlier mark gains a
  violet halo "re-read after 1994 (1 documented, 2 annotated)". **Never generated from similarity.**
- **Date conflicts** — a `requires_precedence` relationship whose source is dated after its target is a
  dotted `--danger` stub with "⚠ date conflict" (e.g. the 6,666 OpenAlex pairs). Never a feedback arc.

### 1.9 Playhead, scrub, play, reduced motion

- **Playhead:** cyan vertical line with a 44×44 px handle on the ruler labelled "as of 1997".
- **Scrub:** drag the handle; `[` / `]` step one bin; `{` / `}` step ten bins. Values change discretely
  by bin; nothing is tweened between bins.
- **Play** (`Space`): advances one bin every 400 ms (0.25×–4×), auto-pans to keep the playhead at 70% of
  the width, bin level frozen during play. Marks fade in over 150 ms; an interval item appears dashed
  ("in progress") at `lo` and solid at `hi`. **Gaps:** when every visible lane ahead is uncovered, play
  pauses 600 ms with *"No coverage 1940–1949 in these lanes — skipping. Nothing is inferred."* then jumps.
  At the modality seam play pauses once with the seam caption (§1.10).
- **Strict vs context:** play runs strict (later evidence hidden); pausing switches to context (later
  marks ghosted at 15%); `V` toggles.
- **Reduced motion** (OS setting or `R`, remembered in localStorage inside try/catch): no fades, no arc
  draw-on, no inertia, no auto-pan easing (jump-pans); play steps every 1.2 s; **Step ▸** becomes the
  primary control; each step is announced via `aria-live=polite` (≤ 1/s).

### 1.10 The modality seam ("the 1928 cliff")

Full text for en/fr/es ends in 1928 (public domain); titles continue to 2026 and abstracts to 2026. For
every visible text collection the server computes `last_covered_year` (max `y_hi` of documents with
tokens); when visible lanes include both text and title/abstract modalities, a **permanent vertical
seam** is drawn at `last_covered_year + 1` across all lanes, with a ruler label *"Full text ends 1928 →
after this line the evidence is titles and abstracts: a change of medium, not of meaning."* It can be
collapsed to a ruler tick but not hidden. Compare refuses cross-modality comparisons by default (§4.9).

### 1.11 The first 60 seconds (scripted)

Coach marks are non-blocking, `Esc` dismisses them, and they never return unless the user clicks **Tour**
(state in localStorage, try/catch, fails safe to showing the tour).

| t | What the user sees | What it teaches |
|---|---|---|
| 0–1.2 s | Shell paints. A striped ribbon spans the top: **"SYNTHETIC DEMONSTRATION CORPUS — invented people, texts, dates and links."** The Scroll shows *carry the zero*, lanes = community, 1890–2030, decade bins, vantage 1925, bars stagger in left to right (skipped in reduced motion). A job chip at top right reads "Cipher: importing titles & relations · 12%". | One phrase across communities over time. |
| 2 s | Coach ① beside the 1911 Classroom bar: *"Bars span where 'carry the zero' was **observed**. Gaps are real: dotted = looked and found none; hatched = no sources."* | Bars are observations; absence has two kinds. |
| ~12 s | Coach ② at two arcs: solid amber `DOC` ("1994 liner notes cite Brennock's 1911 primer — a synthetic record") and dashed `CALC` ("1963 bulletin repeats 13 words of the primer — computed by text matching"). *"Line style = evidence. Click any mark to read its source."* | Documented ≠ computed, visibly. |
| ~25 s | The user clicks the 1994 Hip-hop mark. The inspector opens with the highlighted span at its offsets, the `SYN` badge and the date chip "17 May 1994 · stated · day". | Every mark opens its passage. |
| ~40 s | Coach ③: *"Press ▶ to watch the phrase acquire history."* Play runs 1925→2026 in ~8 s; the 1940s are hatched ("archive gap — synthetic"); 1986–93 dotted; at 2016 the 1911 primer gains a violet halo and a feedback arc. | Change over time, gaps preserved, later works re-read earlier ones. |
| 55–60 s | Final card: *"Your turn."* Search focused, chips `virus` · `zero` · `sample` · **Switch to Cipher (real data)** — enabled as soon as the metadata phase finishes ("Cipher titles, relations and etymology ready · full text 312 / 1,516 books indexing"). [Full tour (4 min)] | Where to go next, on his own data. |

---

## 2. Views B–F (interaction specifications)

All views share the TimeScale, the evidence styles (`src/shared/evidence-style.mjs`) and the selection
model. Every node, edge, mark and row opens text or a labelled "no text" statement.

### B. Meaning constellation (`K`)

- **Inputs:** pinned strands, period A (default: the bin containing the playhead at the current tier, or
  a minimap brush), optional period B, current filters.
- **Nodes (shape = type):** expression ○ · context group (sense hypothesis) ⬡ · work/document □ ·
  theme/motif ◇ (hollow + "machine tag" badge when provenance is `machine_tag`) · etymon ▽.
- **Node area** ∝ one **named quantity** chosen in a dropdown: *occurrences in period* (default) ·
  *documents in period* · *distinct authors*. The legend shows three reference circles with values and
  "area ∝ value (sqrt radius)".
- **Edges:** co-occurrence expression↔collocate (thickness = logDice in the period, only collocates
  passing §4.5 gates) · relationships (evidence styles) · membership expression→context group (thin
  ink-3) · theme↔theme NPMI from `culture-themes.tsv` ("computed by Cipher") · etymological family
  ("shared ancestry, not shared meaning", dotted amber).
- **Bounds:** ≤ 150 nodes, ≤ 400 edges, top-k by the size quantity; each node's "+n more" adds ≤ 20.
- **Stable layout:** positions are computed **once** per layout key `(corpus, strands, run ids, A∪B node
  set)` by deterministic Fruchterman–Reingold (300 iterations, seed = FNV-1a-32 of the key, then a
  collision pass) and cached in `layout_cache`. Changing period or comparing **never moves nodes**; a
  node absent from the shown period is a 20%-opacity outline. Expanding runs the layout with existing
  nodes pinned. **Re-layout** is an explicit button followed by the toast *"Positions recomputed —
  movement is not semantic."*
- **Two-period comparison** (A is always the earlier): *split* (A | B side by side ≥ 1,100 px, stacked
  below that) in identical coordinates, or *overlay*: A-only = hollow amber ring "present only in A";
  B-only = ivory dashed ring "new in B"; both = filled; size change = two-tone ring (inner A, outer B);
  a diff list "only in A / only in B / grew > 2×" with counts.
- **Clicks:** node → its supporting passages (KWIC, 20 per page, by date, with denominators); edge →
  card stating what the quantity is, how computed (run id + parameters), and its evidence passages (for
  co-occurrence: the passages where both terms occur).
- **Legend:** persistent (bottom-left), can collapse to a one-line summary, never closes; names every
  quantity, unit, domain and scale type.

### C. Lineage explorer — "chain of custody" (`G`)

- **Root:** a passage, span, document, expression or quotation. **Layout:** x = the same linear
  TimeScale as the Scroll (toggle "ordinal spacing — equal width per dated year", labelled as such);
  rows = generation (hop distance from the root), never meaning; undated nodes in a left gutter; root
  outlined cyan.
- **Edges:** pattern = evidence status; glyph + text label = type; colour = family (amber transmission,
  violet reinterpretation, ivory-2 similarity). Glyphs: `“ ” exact` · `≈“ ” near` · `⇋ shared wording`
  · `§ cites` · `⟲ adapts` · `◐ parody` · `↻ recontextualizes` · `↩ answers` · `↺ reframes` · `? allusion`
  · `∼ similar` · `♪ samples` · `♪≈ interpolates` · `⟲♪ cover/remix` · `⊂ part of` · `⤷ descends`.
- **Filters:** chips per relationship type; checkboxes per evidence status; **Documented only** (`E`
  cycles all → documented+computed → documented); show/hide rejected.
- **Bounded expansion:** opens at depth 2 both directions, ≤ 60 nodes; a node's **＋** expands one hop
  (≤ 30 nodes); hard cap 150, beyond which the view offers **Show as list** (paged table). The response's
  `truncated` block is printed ("showing 150 of 412 nodes").
- **Commonplaces:** text shared by > 25 documents (Bible verses, proverbs, licence text) collapses into
  one node **"widely shared text (n documents)"** instead of n² quotation edges.
- **Chain of custody:** select two nodes → least-evidence-cost path (documented 1, computed 3, proposed
  5; rejected excluded); shown as a vertical list of link cards whose header reports **chain strength =
  weakest link** (e.g. "PROPOSED").
- **Competing hypotheses:** a `hypothesis_group` holds a target and a question ("Where does Vyas's 2017
  line come from?") and gathers alternative parent edges, drawn as a fan with "⚖ 2 competing". The group
  card shows hypotheses side by side with evidence, authors and review status. Users can add a hypothesis
  (a `proposed` human relationship in the group). Nothing is ever deleted; a human may mark one confirmed,
  which leaves the others as they were (not auto-rejected).
- **Edge card:** type and direction · evidence status in words (+ `DOC*` "source not recorded" when
  `provenance_quality='source_unrecorded'`) · origin · method or annotator · run id + parameters · score
  with its kind ("similarity 0.71 — not a probability"; "Cipher heuristic weight — not a probability") ·
  external locator (new tab, labelled external) · supporting spans side by side with an aligned diff ·
  CUE badge with the quoted cue when present · revision history · review actions **Confirm / Reject /
  Dispute / Attach evidence** (each needs a note ≥ 10 characters) · the fixed sentence *"Shared wording or
  similar contexts can come from a common source; they do not establish influence or intent."*

### C2. Genealogy — the sampling family tree (works mode of the Lineage explorer)

The documented rap layer of Cipher is **who sampled, covered, interpolated, remixed or versioned
whom**. Genealogy is a works-as-bars gantt:

- **Entry:** search suggestion of type *work* ("Amen, Brother — song · 1969 · sampled by N
  (documented)"), a work mark on the Scroll, or the Then card of a title passage. A *maker* suggestion
  opens the same view seeded with all of that maker's works.
- **Layout:** one row per work; rows grouped by generation from the seed (gen 0 = seed; +1 = works that
  sample/cover/… it; −1 = what it sampled), sorted by date inside a generation. x = the Scroll's linear
  TimeScale. Each work is a 6 px diamond at its date (or a bracketed span); the row label is
  "title — maker (year · precision)". A density strip on top counts works per decade per generation.
- **Edges:** elbow connectors from parent row to child row at the child's date; glyph by type (`♪`,
  `♪≈`, `⟲♪`, `⟲`, `⊂`); evidence pattern as everywhere; locator per edge (Wikipedia article,
  MusicBrainz recording URL, ItwoFS page).
- **Defaults:** types {samples, interpolates, cover_of, remix_of, version_of}; documented only; depth ≤ 3
  each way; ≤ 150 rows, paged per generation ("+214 more samplers — 1990s: 88").
- **Honesty:** "Documented links from Wikipedia, MusicBrainz, Wikidata and ItwoFS as collected by Cipher.
  Absence of a link is not evidence of no sampling." Relation-endpoint works that are not among the 94k
  culture works come from collection `cipher-music-relations` (`rate_eligible=0`) and never enter title
  rates.

### D. Then / Now / Next inspector

Opens on any occurrence, passage or work. Desktop: three columns; narrow: tabs in a bottom sheet.

- **Header — Crossings card** (for the selected expression):

  ```
  zero   Etymology   Sanskrit śūnyá "blank" ← PIE *kewh₁- · period of the language, not a date (roots.tsv, CC BY-SA)
         Literature  first observed {year} · n={n} · {rate}/M tokens · {docs} docs     [per language: en hi gu]
         STEMM       first observed {year} · per field: Mathematics {n} · Computing {n}    (OpenAlex: top-cited sample)
         Culture     titles: {k} of 94,385 · e.g. "Zero Dark Thirty" (film, 2012)     (per 1,000 works)
         Claims      ◇ Wiktionary: {relation} {date} (external claim)
         Baseline    Google Books (different corpus): {curve sparkline} | "single words only"
         Caption: "First observation in THIS corpus is not the date of coinage, and not evidence of borrowing."
  ```
  Braces are filled by queries; rows with no evidence say so ("no titles contain 'hacker'; with plural
  variant: 1 — *Hackers* (film, 1995). 0 is an observation about this index, not about culture.").
- **THEN** (amber accents): document card (title, author, **date chip** = label · precision · basis ·
  role, plus "unverified" when the basis is a Cipher list year, and "translation — dated by the original"
  when relevant), collection, licence, `SYN` badge; the passage with the match highlighted at its offsets,
  ±1 neighbouring passage on request, **Open in reader** (virtualized full document); "refers to 1904"
  chip when a `referenced` date exists; **contemporary uses**: occurrences of the expression within
  W = max(10 y, 2 × date width), stratified ≤ 3 per lane, ≤ 9 total, with a denominator line ("n = 37 in
  1925–1945 · 6.1M tokens"); machine annotations under "Machine annotations (fallible)".
- **NOW** (violet accents): a later passage that reuses or reframes this one — default = related target
  with the strongest evidence; picker lists every later related passage plus "any later occurrence".
  Shows the relationship card; for quotations, side-by-side alignment (shared tokens ivory, substitutions
  violet underline, insertions dotted); **context shift**: top context words within ±10 tokens around
  each, as "only around Then / only around Now", labelled *"context words, not meanings"*. With no
  relationship: "No recorded relationship; these are separate uses of the same expression."
- **NEXT:** subsequent relationships from the Now passage (time-sorted, ≤ 20), a sparkline of later
  occurrences in the same context group with denominators, and **Add a hypothesis about later
  reinterpretation** → annotation of kind `hypothesis`, rendered as a dashed violet card *"Hypothesis — by
  you, 2026-10-03 — not evidence"*; it never feeds counts or lineage.
- **Fixed footer:** *"Then shows documents and their settings, not anyone's private thoughts."* The UI
  never applies mental-state verbs to historical people ("thought", "felt", "intended", "meant to",
  "wanted", "believed"); a test greps all UI strings (§11).

### E. Compare meanings (`C`)

Inputs: slices A and B, each `{years:[lo,hi], f:{facet filters}, collections}`, and one or two
expressions. Defaults come from a shift-drag range on the timeline plus `A` / `B`. Panels, top to bottom
— **coverage always first**:

0. **Multiplicity line:** *"Comparison #7 for 'virus' in this session; 1 of 7 crossed the notable
   threshold; with 7 comparisons, ~0.35 are expected by chance at the 95th percentile. Notable threshold
   is adjusted to the 99.3rd percentile."* (rule: threshold = 100 − 5/k percent; k from `compare_log`).
1. **Coverage & composition:** per slice tokens/works, documents, authors, date-basis mix, translation
   share, undated share, prominence terciles, and a stacked bar of kind × language × collection mix.
   Composition divergence JSD(mixA, mixB) (base 2): > 0.15 → amber caveat *"The slices differ in
   composition (JSD 0.31): B is 70% song titles, A is 100% novels. Differences below may reflect source
   mix."* and directly standardized rates (to pooled composition) shown beside raw rates. **Modality
   check:** if A's evidence is ≥ 80% one modality and B's ≥ 80% another → gate `modality_mismatch`
   ("A is book text, B is song titles: different media. Compare titles with titles [Apply]"). **Prominence
   check:** rate ratios per prominence tercile; if their directions disagree → caveat "result depends on
   prominence stratum".
2. **Frequency:** rate per slice in its unit with exact 95% Garwood (Poisson) CI (works: Wilson), rate
   ratio with CI (same unit only), document counts and Gries' DP.
3. **Representative passages:** 5 per slice, ≤ 1 per document, stratified by context group when a run
   exists; the sampling seed is printed; **reshuffle** draws again.
4. **Neighbouring terms:** collocates per slice (logDice; G² ≥ 10.83, f ≥ 5, q < .05) in shared /
   A-only / B-only columns; keyness log-ratio with Benjamini–Hochberg q < .05; "new uses" = collocate
   absent (f < 3) in A and significant in B; "declining" the reverse.
5. **Context groups:** share per slice with document-block bootstrap CIs; new (A < 2%, B ≥ 10%) and
   declining uses; needs a clustering run, else a gate card.
6. **Estimated displacement** (only when gates pass, §4.9): *"Context-share shift JSD 0.21 [0.14, 0.29]
   · n = 212 / 388 · 31 / 54 documents"*; *"Aligned displacement 0.37 · 97th percentile of 500
   frequency-matched controls · neighbour overlap 0.12 → notable"*; otherwise *"within typical
   variation"* or a gate card.
7. **Tone and stance:** machine tone needs the NL adapter (distribution + CI, label *"Apple NLTagger —
   modern reader model, fallible, anachronistic for historical text"*); stance only from human
   annotations (`stance` dimension) counted per slice; `pragmatic_function` (sincere / ironic / parodic /
   reclaimed) counts per slice.
8. **"How coverage could affect this"** — one generated paragraph listing every caveat that fired.

**Gate cards** always show `{gate, needed, have, suggestion}` and an **[Apply]** button for the
suggestion, e.g. *"Not estimated. A has 23 occurrences in 4 documents; this needs ≥ 50 in ≥ 5 documents
per slice. Widening A to 1840–1899 would give 61 in 9 documents. [Apply]"*. A gated payload renders no
numeral for the gated measure.

### F. Interpretation notebook (`N`)

- **Where:** right drawer, plus full-page mode. **Targets:** passage (optionally a sub-span), occurrence,
  document, expression, context group, relationship, hypothesis group, saved view, time window, another
  annotation (reply).
- **Kinds:** `interpretation` · `evidence_for` · `evidence_against` · `hypothesis` · `question` ·
  `correction` · `label` (renames a machine cluster; machine label stays visible in the tooltip).
  Machine kinds (`machine_tag`, `machine_tone`, `machine_gloss`) are listed separately under "Machine
  annotations (fallible)" and cannot be edited, only countered.
- **Dimensions:** built-in `lexical_sense`, `topic`, `referent`, `pragmatic_function` (sincere / ironic /
  parodic / reclaimed / pejorative / neutral), `tone`, `stance`, `social_association`, `perspective`
  ("reading as: 1995 critic / 2026 reader / community X"), `personal_reading`, `reframes_target` (bool);
  plus custom dimensions via `dimension_def` (`enum | scale | text | bool`).
- **Revisions:** editing appends an `annotation_revision` (UPDATE/DELETE blocked by triggers). Each card
  shows "rev 3 of 3", a revision scrubber and a word-level diff.
- **Reinterpret:** creates a *new* annotation with `supersedes`; the old one becomes `superseded` and stays
  as a visible layer: "Layer 'Reader A, 2026-10-03' — superseded 2026-11-12". Superseded layers show by
  default in the notebook; on the timeline only with "show superseded".
- **As-of slider:** shows which interpretations existed at a chosen date (the vantage clock for humans).
- **Confirm / reject / dispute inferred relationships:** note ≥ 10 characters; writes an annotation
  (`evidence_for` / `evidence_against`) + a `relationship_revision`; `review_status` is recomputed
  (confirmed if ≥ 1 confirm and 0 rejects; rejected if the reverse; disputed if both); **`evidence_status`
  never changes**.
- **Compare interpretations:** all active annotations on a target in columns grouped by layer or author,
  each with its supporting/contradicting evidence chips (amber = for, struck grey = against) that open the
  passages; shared evidence highlighted in both.
- **Search:** FTS over annotation bodies and tags + facets (kind, tag, author, dimension, has-contradiction,
  date). Export as JSONL with every revision.

---

## 3. Data model — SQLite DDL (`server/db/schema.sql`, schema_version 1)

Database: `$SCROLLS_DATA/scrolls.db` (default `~/Developer/scrolls-data/scrolls.db`). Originals are stored
verbatim and content-addressed under `originals/<sha[0:2]>/<sha256>`. The block below is the file
`server/db/schema.sql` **verbatim**; it was executed on node v26.10.0 / SQLite 3.53.4, and the following
were exercised: every CHECK on `relationship` (algorithm→documented, human→documented,
documented-without-locator, computed-without-run, tagger→computed all rejected), the immutability and
no-delete triggers, the drift gate CHECK, the annotation anchor CHECK, append-only revisions, saved-view
immutability (soft delete allowed), the `expression_variant` unique **index** (the proposal's
expression-in-UNIQUE bug is fixed), `rtree_i32` with BCE day numbers, Devanagari/Gujarati FTS tokens,
fts5vocab `instance` on a contentless table, contentless delete, and trigram typeahead.

**Contracts that the DDL cannot express (enforced in code + tests):**
- **Offsets:** UTF-16 code units. For `passage.field='body'` they index `document_text.original`; for any
  other field they index `document_field.value`. Invariant: `fold(slice(start,end))` equals a variant's
  norm for every occurrence; `passage.start_off ≤ occ.start_off < occ.end_off ≤ passage.end_off`.
- **Chronology:** `document.lo_day/hi_day/y_lo/y_hi/precision/basis/date_role` are copied from the single
  `date_assertion` with `is_chronology=1`. For translations the chronology assertion is
  `role='original_publication'` and default filters exclude `is_translation=1` from text-language lanes.
- **`doc_bin`:** a document has a row at level L (0 millennium, 1 century, 2 decade, 3 year) iff
  `floor(y_lo/w) = floor(y_hi/w)` for that level's width w; months/days use `lo_day/hi_day` directly
  with `precision IN ('day','month')`.
- **`doc_tokens`:** only `quality='ok'` passages count; written by DocumentWriter at commit and rewritten
  whenever passage quality changes (boilerplate pass).
- **`expr_doc.n`** excludes proper-noun-guard hits (`n_names` holds them); it includes matches in every
  quality='ok' passage even when occurrence rows are a sample.
- **Visibility rule:** every analysis query joins `analysis_run` and requires `status='succeeded'`, so a
  running or cancelled job never leaks partial rows; the `gc-runs` task deletes rows of cancelled/failed
  runs (the `rel_no_delete` trigger permits exactly that).
- **Synthetic:** `is_synthetic` is copied from the corpus onto every collection, document, passage,
  relationship, annotation and hypothesis group created in it (DocumentWriter enforces; test asserts).
- **data_version:** `meta.data_version` is bumped by every committed write job; analysis-run reuse uses
  `input_fingerprint` (per-collection max committed batch + quality version + upstream runs + tokenizer +
  segmenter), so an unrelated import does not invalidate a clustering run.

```sql
-- server/db/schema.sql — Scrolls schema_version 1 (executed verbatim by tests/db.schema.test.mjs)
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
-- keys: schema_version='1', data_version (decimal; bumped by every committed write job),
--       tokenizer_version='u61m-1', segmenter_version='seg-1', icu_version, created_at

-- ════════════ 1. Provenance spine ════════════
CREATE TABLE corpus (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,                 -- 'demo' | 'cipher' | 'stemm' | 'user'
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('real','synthetic','user')),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  description TEXT, license TEXT, created_at TEXT NOT NULL,
  CHECK ((kind = 'synthetic') = (is_synthetic = 1))
) STRICT;

CREATE TABLE source_adapter (
  id TEXT PRIMARY KEY,                       -- 'cipher.books','stemm.openalex','file.csv','demo'
  version TEXT NOT NULL, label TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('local-file','local-dataset','network')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  approved_at TEXT,                          -- explicit user opt-in time (network only)
  license TEXT, attribution TEXT,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  CHECK (access <> 'network' OR enabled = 0 OR approved_at IS NOT NULL)
) STRICT;

CREATE TABLE collection (
  id INTEGER PRIMARY KEY,
  corpus_id INTEGER NOT NULL REFERENCES corpus(id),
  adapter_id TEXT NOT NULL REFERENCES source_adapter(id),
  slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('literature','culture','stemm','etymology','imported','demo')),
  modality TEXT NOT NULL CHECK (modality IN ('text','titles','abstracts','lexical','baseline')),
  unit TEXT NOT NULL CHECK (unit IN ('tokens','works','entries','none')),   -- rate denominator
  sampling TEXT NOT NULL CHECK (sampling IN ('complete','prominence_selected','top_cited_per_cell',
                                             'relation_endpoints','curated','user')),
  rate_eligible INTEGER NOT NULL DEFAULT 1 CHECK (rate_eligible IN (0,1)),
  coverage_gate INTEGER,                     -- NULL = unit default (50,000 tokens · 30 works · 20 sampled works); demo 2,000
  export_text_allowed INTEGER NOT NULL DEFAULT 1 CHECK (export_text_allowed IN (0,1)),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  license TEXT, attribution TEXT,
  selection_note TEXT,                       -- e.g. 'chosen by Wikipedia sitelinks (prominence)'
  caveats_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(caveats_json)),   -- copied from MANIFEST.json
  source_uri TEXT, retrieved_at TEXT, created_at TEXT NOT NULL
) STRICT;

CREATE TABLE original_file (
  sha256 TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,                    -- originals/ab/<sha256>
  source_path TEXT,                          -- where it was read from (informational)
  byte_size INTEGER NOT NULL, encoding TEXT NOT NULL,
  had_bom INTEGER NOT NULL DEFAULT 0, stored_at TEXT NOT NULL
) STRICT;

CREATE TABLE import_batch (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER REFERENCES collection(id),
  adapter_id TEXT NOT NULL REFERENCES source_adapter(id),
  adapter_version TEXT NOT NULL,
  file_sha256 TEXT REFERENCES original_file(sha256),
  file_name TEXT,
  format TEXT NOT NULL CHECK (format IN ('txt','md','csv','tsv','json','jsonl','adapter')),
  mapping_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(mapping_json)),
  options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_json)),
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  status TEXT NOT NULL CHECK (status IN ('uploaded','previewed','validated','committing','committed',
                                         'failed','cancelled','reverted')),
  job_id INTEGER, created_at TEXT NOT NULL, committed_at TEXT
) STRICT;
CREATE UNIQUE INDEX import_once ON import_batch(collection_id, file_sha256) WHERE status = 'committed';

CREATE TABLE import_issue (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batch(id),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','rejected','fatal')),
  code TEXT NOT NULL,                        -- vocab.ISSUE_CODES
  line INTEGER, col INTEGER, field TEXT, value_excerpt TEXT,
  message TEXT NOT NULL, suggestion TEXT NOT NULL
) STRICT;
CREATE INDEX import_issue_batch ON import_issue(batch_id, severity);

-- ════════════ 2. Documents & text ════════════
CREATE TABLE document (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collection(id),
  import_batch_id INTEGER NOT NULL REFERENCES import_batch(id),
  ext_id TEXT NOT NULL,                      -- 'pg:1342','cw:4948','W2945914100','ws-hi:12','mb:<uuid>'
  kind TEXT NOT NULL,                        -- vocab.DOC_KINDS
  title TEXT, native_title TEXT, author TEXT,
  genre TEXT, community TEXT, culture TEXT, field TEXT,
  lang_declared TEXT, lang_text TEXT, lang_confidence REAL,
  is_translation INTEGER NOT NULL DEFAULT 0 CHECK (is_translation IN (0,1)),
  original_lang TEXT,
  has_full_text INTEGER NOT NULL DEFAULT 0 CHECK (has_full_text IN (0,1)),
  -- chronology, denormalized from the date_assertion with is_chronology = 1
  lo_day INTEGER, hi_day INTEGER, y_lo INTEGER, y_hi INTEGER,
  precision TEXT NOT NULL DEFAULT 'unknown', basis TEXT NOT NULL DEFAULT 'unknown', date_role TEXT,
  chrono_status TEXT NOT NULL CHECK (chrono_status IN ('dated','undated','scheduled')),
  date_label TEXT NOT NULL DEFAULT 'undated',
  source_url TEXT, license TEXT,
  source_file_sha256 TEXT REFERENCES original_file(sha256),
  source_byte_start INTEGER, source_byte_end INTEGER,
  original_meta_json TEXT NOT NULL CHECK (json_valid(original_meta_json)),  -- verbatim record
  text_sha256 TEXT, dup_of INTEGER REFERENCES document(id),
  token_count INTEGER NOT NULL DEFAULT 0, passage_count INTEGER NOT NULL DEFAULT 0,
  prominence REAL,                           -- source-specific; NEVER an evidence weight
  prominence_tercile INTEGER CHECK (prominence_tercile IS NULL OR prominence_tercile IN (1,2,3)),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  created_at TEXT NOT NULL, deleted_at TEXT, -- soft delete only
  UNIQUE (collection_id, ext_id),
  CHECK ((chrono_status = 'undated') = (lo_day IS NULL)),
  CHECK (lo_day IS NULL OR (hi_day IS NOT NULL AND lo_day <= hi_day))
) STRICT;
CREATE INDEX doc_time    ON document(y_lo, y_hi) WHERE deleted_at IS NULL;
CREATE INDEX doc_facets  ON document(collection_id, kind, lang_text, culture);
CREATE INDEX doc_textsha ON document(text_sha256);
CREATE INDEX doc_batch   ON document(import_batch_id);

CREATE TABLE document_text (                -- full text: decoded original, never normalized
  document_id INTEGER PRIMARY KEY REFERENCES document(id),
  original TEXT NOT NULL,
  body_start INTEGER NOT NULL, body_end INTEGER NOT NULL,   -- UTF-16 units (e.g. inside Gutenberg markers)
  original_sha256 TEXT NOT NULL,             -- sha256 of `original` (UTF-8 bytes): annotation anchor key
  decoder TEXT NOT NULL                      -- 'utf-8' | 'windows-1252' | 'pages-joined-ff'
) STRICT;

CREATE TABLE document_field (               -- short text fields of metadata documents (verbatim)
  document_id INTEGER NOT NULL REFERENCES document(id),
  field TEXT NOT NULL CHECK (field IN ('title','native_title','summary','abstract','gloss','entry')),
  value TEXT NOT NULL,
  PRIMARY KEY (document_id, field)
) STRICT, WITHOUT ROWID;

CREATE TABLE document_alias (
  document_id INTEGER NOT NULL REFERENCES document(id),
  ext_id TEXT NOT NULL, title TEXT, note TEXT,
  PRIMARY KEY (document_id, ext_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE doc_tag (                       -- catalogue / machine tags: NOT document text
  document_id INTEGER NOT NULL REFERENCES document(id),
  scheme TEXT NOT NULL CHECK (scheme IN ('theme','motif','mood','canon','locc','subject','field',
                                         'subfield','topic','keyword','maker')),
  value TEXT NOT NULL, weight REAL,
  provenance TEXT NOT NULL CHECK (provenance IN ('documented_category','machine_tag','genre_heuristic',
                                                 'catalog','adapter_machine')),
  method TEXT NOT NULL,
  run_id INTEGER REFERENCES analysis_run(id),
  PRIMARY KEY (document_id, scheme, value, provenance)
) STRICT, WITHOUT ROWID;
CREATE INDEX doc_tag_value ON doc_tag(scheme, value, provenance);

CREATE TABLE doc_minhash (document_id INTEGER PRIMARY KEY REFERENCES document(id), sig BLOB NOT NULL) STRICT;

-- ════════════ 3. Time ════════════
CREATE TABLE date_assertion (
  id INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('document','passage','expression','relationship')),
  subject_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('publication','creation','original_publication','publication_unspecified',
        'edition','release','recording','performance','referenced','authored_description','translation',
        'ingestion','language_period','first_attestation_claim','digitized')),
  lo_day INTEGER, hi_day INTEGER, lo_year INTEGER, hi_year INTEGER,
  precision TEXT NOT NULL CHECK (precision IN ('day','month','year','decade','century','millennium',
                                                'range','period','unknown')),
  basis TEXT NOT NULL CHECK (basis IN ('stated','estimated','derived','period','announced','unknown')),
  approx INTEGER NOT NULL DEFAULT 0 CHECK (approx IN (0,1)),      -- 'circa' qualifier
  raw TEXT, rule TEXT,                       -- verbatim input; grammar rule id
  asserted_by TEXT NOT NULL,                 -- 'adapter:cipher.books@1' | 'human:utkarsh' | 'import:17'
  is_chronology INTEGER NOT NULL DEFAULT 0 CHECK (is_chronology IN (0,1)),
  note TEXT,
  CHECK ((precision = 'unknown') = (lo_day IS NULL)),
  CHECK (lo_day IS NULL OR (hi_day IS NOT NULL AND lo_day <= hi_day))
) STRICT;
CREATE INDEX date_subject ON date_assertion(subject_type, subject_id, role);
CREATE UNIQUE INDEX one_chronology ON date_assertion(subject_type, subject_id) WHERE is_chronology = 1;
CREATE VIRTUAL TABLE date_rtree USING rtree_i32(id, lo_day, hi_day);   -- dated assertions only

CREATE TABLE language_period (
  lang TEXT PRIMARY KEY, label TEXT NOT NULL,
  lo_year INTEGER NOT NULL, hi_year INTEGER NOT NULL,
  core_lo INTEGER, core_hi INTEGER, fuzz_years INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, note TEXT NOT NULL
) STRICT;

-- precision-aware bin membership: a document appears at level L only if its interval fits ONE bin
CREATE TABLE doc_bin (
  level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 3),   -- 0 millennium, 1 century, 2 decade, 3 year
  bin INTEGER NOT NULL,                                    -- floor(year / width)
  document_id INTEGER NOT NULL REFERENCES document(id),
  PRIMARY KEY (level, bin, document_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX doc_bin_doc ON doc_bin(document_id);

CREATE TABLE doc_tokens (                    -- denominators: quality='ok' tokens per document × passage language × class
  document_id INTEGER NOT NULL REFERENCES document(id),
  plang TEXT NOT NULL,
  field_class TEXT NOT NULL CHECK (field_class IN ('text','title','abstract','describes','apparatus')),
  tokens INTEGER NOT NULL, passages INTEGER NOT NULL,
  PRIMARY KEY (document_id, plang, field_class)
) STRICT, WITHOUT ROWID;

-- ════════════ 4. Passages & search ════════════
CREATE TABLE passage (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES document(id),
  ord INTEGER NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('body','title','native_title','summary','abstract','gloss','entry')),
  field_class TEXT NOT NULL CHECK (field_class IN ('text','title','abstract','describes','apparatus')),
  time_role TEXT NOT NULL CHECK (time_role IN ('document','describes','apparatus')),
  unit TEXT NOT NULL CHECK (unit IN ('paragraph','stanza','sentence_group','page_paragraph','field')),
  quality TEXT NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','furniture','boilerplate','front_matter','low','gappy')),
  start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,  -- UTF-16 units into document_text.original (body)
                                                         -- or into document_field.value (other fields)
  page_no INTEGER,
  lang TEXT NOT NULL DEFAULT 'und', lang_confidence REAL,
  token_count INTEGER NOT NULL,
  y_lo INTEGER, y_hi INTEGER,                -- denormalized from document
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  UNIQUE (document_id, field, ord),
  CHECK (start_off <= end_off)
) STRICT;
CREATE INDEX passage_doc  ON passage(document_id, field, start_off);
CREATE INDEX passage_time ON passage(y_lo, lang, field_class);

-- contentless FTS over the JS-folded token string (tokens joined by ' '); rowid = passage.id
CREATE VIRTUAL TABLE passage_fts USING fts5(norm, content='', contentless_delete=1, detail=full,
  tokenize="unicode61 remove_diacritics 2 categories 'L* N* Co M*'");
CREATE VIRTUAL TABLE passage_vocab_row  USING fts5vocab(passage_fts, row);
CREATE VIRTUAL TABLE passage_vocab_inst USING fts5vocab(passage_fts, instance);

-- typeahead / substring over short labels only (titles, makers, expression surfaces, etymon forms, themes)
CREATE VIRTUAL TABLE label_tri USING fts5(label, kind UNINDEXED, ref UNINDEXED,
  tokenize="trigram remove_diacritics 1");

-- ════════════ 5. Expressions, occurrences, aggregation base ════════════
CREATE TABLE expression (
  id INTEGER PRIMARY KEY,
  corpus_id INTEGER REFERENCES corpus(id),   -- NULL = any corpus
  kind TEXT NOT NULL CHECK (kind IN ('word','phrase','quotation','symbol','motif','theme')),
  surface TEXT NOT NULL, norm TEXT NOT NULL, -- norm = folded tokens joined by ' '
  lang TEXT,                                 -- NULL = any language
  origin TEXT NOT NULL CHECK (origin IN ('user_query','demo','stemm_seed','import','tour')),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE UNIQUE INDEX expr_key ON expression(kind, IFNULL(lang,''), norm, IFNULL(corpus_id,0));

CREATE TABLE expression_variant (
  id INTEGER PRIMARY KEY,
  expression_id INTEGER NOT NULL REFERENCES expression(id),
  form TEXT NOT NULL, norm TEXT NOT NULL, lang TEXT,
  variant_type TEXT NOT NULL CHECK (variant_type IN ('identity','inflection','spelling','hyphenation',
                 'transliteration','translation','descendant','user')),
  rule TEXT NOT NULL,                        -- 'identity' | 'en-inflect@1' | 'hi-oblique@1' | 'nukta-fold@1' | 'roots.tsv' | 'user'
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('documented','computed','proposed')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1))
) STRICT;
-- fix of the proposal DDL: expressions are not allowed inside UNIQUE constraints, so this is an index
CREATE UNIQUE INDEX variant_key ON expression_variant(expression_id, IFNULL(lang,''), norm);

CREATE TABLE expression_state (
  expression_id INTEGER PRIMARY KEY REFERENCES expression(id),
  run_id INTEGER REFERENCES analysis_run(id),           -- materialize run behind current rows
  variants_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('none','previewing','materializing','ready','failed')),
  occ_total INTEGER, docs_total INTEGER,
  sampled INTEGER NOT NULL DEFAULT 0 CHECK (sampled IN (0,1)),
  names_excluded INTEGER NOT NULL DEFAULT 0,            -- proper_noun_guard exclusions
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE occurrence (
  id INTEGER PRIMARY KEY,
  expression_id INTEGER NOT NULL REFERENCES expression(id),
  variant_id INTEGER REFERENCES expression_variant(id),
  passage_id INTEGER NOT NULL REFERENCES passage(id),
  document_id INTEGER NOT NULL,
  start_off INTEGER NOT NULL, end_off INTEGER NOT NULL, -- same coordinate base as the passage
  tok_index INTEGER NOT NULL,
  name_flag INTEGER NOT NULL DEFAULT 0 CHECK (name_flag IN (0,1)),   -- proper_noun_guard hit (excluded by default)
  sampled INTEGER NOT NULL DEFAULT 0 CHECK (sampled IN (0,1)),
  run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  UNIQUE (run_id, passage_id, start_off, expression_id)
) STRICT;
CREATE INDEX occ_expr    ON occurrence(expression_id, run_id, document_id);
CREATE INDEX occ_passage ON occurrence(passage_id);

-- THE aggregation base: exact counts per expression × document × passage language × field class
CREATE TABLE expr_doc (
  expression_id INTEGER NOT NULL, document_id INTEGER NOT NULL,
  plang TEXT NOT NULL, field_class TEXT NOT NULL,
  n INTEGER NOT NULL, n_names INTEGER NOT NULL DEFAULT 0, n_passages INTEGER NOT NULL,
  first_off INTEGER, run_id INTEGER NOT NULL,
  PRIMARY KEY (expression_id, run_id, document_id, plang, field_class)
) STRICT, WITHOUT ROWID;

-- ════════════ 6. Etymology (deep time; roots.tsv) ════════════
CREATE TABLE etymon (
  key TEXT PRIMARY KEY,                      -- 'grc:γενεσις', 'ine-pro:*genh₁-', 'sa:शून्य'
  kind TEXT NOT NULL CHECK (kind IN ('etymon','root')),
  lang TEXT NOT NULL, form TEXT NOT NULL, roman TEXT, gloss TEXT,
  parent_semantics TEXT NOT NULL CHECK (parent_semantics IN
      ('none','single','listed_chain','listed_variants','listed_unresolved'))
) STRICT;
CREATE TABLE etymon_parent (
  key TEXT NOT NULL, parent_key TEXT NOT NULL, ord INTEGER NOT NULL,
  PRIMARY KEY (key, parent_key)
) STRICT, WITHOUT ROWID;
CREATE TABLE etymon_member (
  key TEXT NOT NULL, lang TEXT NOT NULL, word TEXT NOT NULL, norm TEXT NOT NULL, rank INTEGER NOT NULL,
  PRIMARY KEY (key, lang, word)
) STRICT, WITHOUT ROWID;
CREATE INDEX etymon_member_norm ON etymon_member(lang, norm);

-- ════════════ 7. Analysis ════════════
CREATE TABLE analysis_run (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL,                       -- vocab.STAGES
  pipeline_version TEXT NOT NULL,            -- 'cluster@1.0.0'
  code_hash TEXT NOT NULL,                   -- sha256 of the stage module files (computed at boot)
  params_json TEXT NOT NULL CHECK (json_valid(params_json)), params_hash TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  input_fingerprint TEXT NOT NULL,           -- sha256(scope + data_version + upstream runs + tokenizer + segmenter)
  data_version INTEGER NOT NULL,
  upstream_run_ids TEXT NOT NULL DEFAULT '[]',
  representation TEXT,                       -- 'ppmi-svd-pooled' | 'tfidf-hash-4096' | 'apple.NLEmbedding.en' | NULL
  model TEXT, model_version TEXT, seed INTEGER,
  tokenizer_version TEXT NOT NULL, segmenter_version TEXT NOT NULL, icu_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled','superseded')),
  gate_json TEXT NOT NULL DEFAULT '{}', metrics_json TEXT,
  job_id INTEGER, started_at TEXT NOT NULL, finished_at TEXT, notes TEXT
) STRICT;
CREATE INDEX run_reuse ON analysis_run(stage, params_hash, input_fingerprint, status);

CREATE TABLE time_window (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  label TEXT NOT NULL, lo_year INTEGER NOT NULL, hi_year INTEGER NOT NULL,
  scheme TEXT NOT NULL CHECK (scheme IN ('fixed','merged_for_min_n','slice','custom')),
  n_occ INTEGER, tokens INTEGER
) STRICT;

CREATE TABLE collocation (
  run_id INTEGER NOT NULL REFERENCES analysis_run(id), expression_id INTEGER NOT NULL,
  slice_key TEXT NOT NULL, collocate TEXT NOT NULL,
  f_xy INTEGER NOT NULL, f_x INTEGER NOT NULL, f_y INTEGER NOT NULL, n_tokens INTEGER NOT NULL,
  g2 REAL NOT NULL, q_value REAL NOT NULL, log_dice REAL NOT NULL, ppmi REAL NOT NULL,
  PRIMARY KEY (run_id, expression_id, slice_key, collocate)
) STRICT, WITHOUT ROWID;

CREATE TABLE vector_space (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  lang TEXT NOT NULL, lo_year INTEGER, hi_year INTEGER, pooled INTEGER NOT NULL CHECK (pooled IN (0,1)),
  collections_json TEXT NOT NULL, tokens INTEGER NOT NULL, docs INTEGER NOT NULL, authors INTEGER NOT NULL,
  vocab_size INTEGER NOT NULL, dim INTEGER NOT NULL,
  rel_path TEXT NOT NULL                     -- derived/spaces/<id>.f32 + .vocab.tsv
) STRICT;
CREATE TABLE space_alignment (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  from_space INTEGER NOT NULL REFERENCES vector_space(id), to_space INTEGER NOT NULL REFERENCES vector_space(id),
  method TEXT NOT NULL CHECK (method = 'orthogonal_procrustes'),
  anchors INTEGER NOT NULL, mean_anchor_cos REAL NOT NULL, rel_path TEXT NOT NULL
) STRICT;

CREATE TABLE sense_cluster (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  expression_id INTEGER NOT NULL REFERENCES expression(id), ord INTEGER NOT NULL,
  label_auto TEXT NOT NULL,                  -- 'machine label: column · digit · place'
  distinctive_json TEXT NOT NULL,            -- [{term, z, f_in, f_out}]
  size INTEGER NOT NULL, n_docs INTEGER NOT NULL, top_doc_share REAL NOT NULL,
  stability REAL, silhouette REAL, first_year INTEGER, last_year INTEGER,
  status TEXT NOT NULL DEFAULT 'hypothesis' CHECK (status IN ('hypothesis','unstable','residual'))
) STRICT;
CREATE TABLE cluster_member (
  cluster_id INTEGER NOT NULL REFERENCES sense_cluster(id),
  occurrence_id INTEGER NOT NULL REFERENCES occurrence(id),
  cos REAL NOT NULL, margin REAL NOT NULL,
  PRIMARY KEY (cluster_id, occurrence_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX cluster_member_occ ON cluster_member(occurrence_id);
CREATE TABLE cluster_share (
  cluster_id INTEGER NOT NULL REFERENCES sense_cluster(id), window_id INTEGER NOT NULL REFERENCES time_window(id),
  n INTEGER NOT NULL, share REAL NOT NULL, ci_lo REAL NOT NULL, ci_hi REAL NOT NULL,
  PRIMARY KEY (cluster_id, window_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE cluster_transition (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  kind TEXT NOT NULL CHECK (kind IN ('emerge','split','merge','vanish','unknown_gap','convergence')),
  from_cluster INTEGER, to_cluster INTEGER, window_id INTEGER NOT NULL REFERENCES time_window(id),
  score REAL, ci_lo REAL, ci_hi REAL, note TEXT
) STRICT;

CREATE TABLE drift_result (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  expression_id INTEGER NOT NULL,
  slice_a_json TEXT NOT NULL, slice_b_json TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('rate_ratio','sense_share_jsd','neighbor_overlap',
                                         'aligned_displacement','convergence')),
  value REAL, ci_lo REAL, ci_hi REAL, null_percentile REAL,
  n_a INTEGER, n_b INTEGER, docs_a INTEGER, docs_b INTEGER, authors_a INTEGER, authors_b INTEGER,
  gate TEXT NOT NULL CHECK (gate IN ('ok','insufficient_occurrences','insufficient_documents',
        'insufficient_authors','insufficient_coverage','single_source','unaligned','slice_too_small',
        'composition_mismatch','modality_mismatch','sampling_design','no_cluster_structure','not_run')),
  gate_detail_json TEXT NOT NULL, caveats_json TEXT NOT NULL DEFAULT '[]',
  CHECK (gate = 'ok' OR (value IS NULL AND ci_lo IS NULL AND ci_hi IS NULL AND null_percentile IS NULL))
) STRICT;

CREATE TABLE compare_log (                   -- discloses repeated slicing (multiplicity)
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, expression_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, measures_json TEXT NOT NULL,
  notable_count INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
) STRICT;
CREATE INDEX compare_log_key ON compare_log(session_id, expression_key);

-- ════════════ 8. Relationships ════════════
CREATE TABLE rel_type (
  code TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('quotation','citation','adaptation','parody','reinterpretation',
                                         'allusion','similarity','containment','etymology','sense')),
  label TEXT NOT NULL, inverse_label TEXT NOT NULL,
  directed INTEGER NOT NULL CHECK (directed IN (0,1)),
  requires_precedence INTEGER NOT NULL CHECK (requires_precedence IN (0,1)),
  implies_transmission INTEGER NOT NULL CHECK (implies_transmission IN (0,1)),
  feedback_capable INTEGER NOT NULL CHECK (feedback_capable IN (0,1)),
  glyph TEXT NOT NULL, description TEXT NOT NULL
) STRICT;

CREATE TABLE hypothesis_group (
  id INTEGER PRIMARY KEY, target_type TEXT NOT NULL, target_ref TEXT NOT NULL,
  question TEXT NOT NULL, created_by TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
) STRICT;

CREATE TABLE relationship (
  id INTEGER PRIMARY KEY,
  rel_type TEXT NOT NULL REFERENCES rel_type(code),
  src_type TEXT NOT NULL CHECK (src_type IN ('document','passage','occurrence','expression','etymon','cluster')),
  src_ref TEXT NOT NULL,                     -- canonical: the LATER / dependent item (decimal id or etymon key)
  dst_type TEXT NOT NULL CHECK (dst_type IN ('document','passage','occurrence','expression','etymon','cluster')),
  dst_ref TEXT NOT NULL,                     -- canonical: the EARLIER / source item
  directed INTEGER NOT NULL CHECK (directed IN (0,1)),
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('documented','computed','proposed')),
  origin TEXT NOT NULL CHECK (origin IN ('source_dataset','algorithm','machine_tagger','human')),
  source_dataset TEXT,                       -- 'wikipedia','wikidata','musicbrainz','itwofs','openalex','wiktionary',
                                             -- 'import:<collection>','demo-records'
  source_locator TEXT,
  provenance_quality TEXT NOT NULL DEFAULT 'complete'
      CHECK (provenance_quality IN ('complete','source_unrecorded')),
  method TEXT,
  run_id INTEGER REFERENCES analysis_run(id),
  created_by TEXT NOT NULL,                  -- 'adapter:cipher.works@1' | 'run:42' | 'human:utkarsh'
  review_status TEXT NOT NULL DEFAULT 'unreviewed'
      CHECK (review_status IN ('unreviewed','confirmed','rejected','disputed')),
  score REAL,
  score_kind TEXT CHECK (score_kind IN ('similarity','heuristic_strength','match_ratio','alignment_score',
                                        'classifier_score')),
  date_conflict INTEGER NOT NULL DEFAULT 0 CHECK (date_conflict IN (0,1)),
  src_year INTEGER, dst_year INTEGER,        -- denormalized for drawing
  hypothesis_group_id INTEGER REFERENCES hypothesis_group(id),
  license TEXT, attribution TEXT, provenance_note TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  current_rev INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  -- structural guarantees: inferred lineage can never be stored as documented
  CHECK (evidence_status <> 'documented' OR (origin = 'source_dataset' AND source_dataset IS NOT NULL
         AND (source_locator IS NOT NULL OR provenance_quality = 'source_unrecorded'))),
  CHECK (origin <> 'source_dataset' OR evidence_status = 'documented'),
  CHECK (evidence_status <> 'computed' OR origin = 'algorithm'),
  CHECK (origin <> 'algorithm' OR (run_id IS NOT NULL AND method IS NOT NULL)),
  CHECK (origin <> 'machine_tagger' OR (evidence_status = 'proposed' AND method IS NOT NULL)),
  CHECK (origin <> 'human' OR (evidence_status = 'proposed' AND created_by LIKE 'human:%')),
  CHECK (score IS NULL OR score_kind IS NOT NULL)
) STRICT;
CREATE INDEX rel_src   ON relationship(src_type, src_ref);
CREATE INDEX rel_dst   ON relationship(dst_type, dst_ref);
CREATE INDEX rel_kind  ON relationship(rel_type, evidence_status, review_status);
CREATE INDEX rel_group ON relationship(hypothesis_group_id) WHERE hypothesis_group_id IS NOT NULL;
CREATE TRIGGER rel_evidence_immutable
BEFORE UPDATE OF rel_type, src_type, src_ref, dst_type, dst_ref, directed, evidence_status, origin,
                 source_dataset, method, run_id ON relationship
BEGIN SELECT RAISE(ABORT, 'relationship evidence fields are immutable; create a new relationship'); END;
CREATE TRIGGER rel_no_delete BEFORE DELETE ON relationship
WHEN NOT EXISTS (SELECT 1 FROM analysis_run r WHERE r.id = OLD.run_id AND r.status IN ('cancelled','failed'))
BEGIN SELECT RAISE(ABORT, 'relationships are never deleted; reject them instead'); END;

CREATE TABLE relationship_evidence (
  id INTEGER PRIMARY KEY,
  relationship_id INTEGER NOT NULL REFERENCES relationship(id),
  passage_id INTEGER REFERENCES passage(id),
  role TEXT NOT NULL CHECK (role IN ('source_span','target_span','citation_cue','supporting',
                                     'contradicting','external_record')),
  start_off INTEGER, end_off INTEGER,
  anchor_json TEXT,                          -- {doc_id, sha256, field, start, end, quote, prefix, suffix}
  detail_json TEXT, added_by TEXT NOT NULL, added_at TEXT NOT NULL
) STRICT;
CREATE INDEX rel_ev ON relationship_evidence(relationship_id);

CREATE TABLE relationship_revision (
  id INTEGER PRIMARY KEY,
  relationship_id INTEGER NOT NULL REFERENCES relationship(id),
  rev INTEGER NOT NULL,
  actor TEXT NOT NULL, at TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','confirm','reject','dispute','add_evidence','regroup','retract')),
  before_json TEXT, after_json TEXT NOT NULL, reason TEXT,
  annotation_id INTEGER REFERENCES annotation(id),
  UNIQUE (relationship_id, rev)
) STRICT;
CREATE TRIGGER relrev_no_update BEFORE UPDATE ON relationship_revision
BEGIN SELECT RAISE(ABORT, 'relationship revisions are append-only'); END;
CREATE TRIGGER relrev_no_delete BEFORE DELETE ON relationship_revision
BEGIN SELECT RAISE(ABORT, 'relationship revisions are append-only'); END;

-- ════════════ 9. Interpretation ════════════
CREATE TABLE dimension_def (
  key TEXT PRIMARY KEY, label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('enum','scale','text','bool')),
  options_json TEXT, builtin INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL
) STRICT;

CREATE TABLE annotation (
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('passage','occurrence','document','expression','cluster',
        'relationship','hypothesis_group','saved_view','time_window','annotation')),
  target_ref TEXT NOT NULL,
  anchor_json TEXT,                          -- REQUIRED for passage/occurrence: {doc_id, sha256, field, start, end,
                                             --   quote, prefix(≤32), suffix(≤32)} — survives re-segmentation
  kind TEXT NOT NULL CHECK (kind IN ('interpretation','evidence_for','evidence_against','hypothesis','question',
        'correction','label','machine_tag','machine_tone','machine_gloss')),
  author TEXT NOT NULL,
  is_machine INTEGER NOT NULL CHECK (is_machine IN (0,1)),
  method TEXT, run_id INTEGER REFERENCES analysis_run(id),
  layer TEXT,
  supersedes INTEGER REFERENCES annotation(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','withdrawn')),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  current_rev INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  CHECK (is_machine = 0 OR method IS NOT NULL),
  CHECK (target_type NOT IN ('passage','occurrence') OR anchor_json IS NOT NULL)
) STRICT;
CREATE INDEX ann_target ON annotation(target_type, target_ref, status);

CREATE TABLE annotation_revision (
  id INTEGER PRIMARY KEY,
  annotation_id INTEGER NOT NULL REFERENCES annotation(id),
  rev INTEGER NOT NULL,
  body_md TEXT NOT NULL,
  stance TEXT CHECK (stance IN ('supports','contradicts','neutral','alternative')),
  dimensions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(dimensions_json)),
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs_json)),
  reason TEXT, author TEXT NOT NULL, at TEXT NOT NULL,
  UNIQUE (annotation_id, rev)
) STRICT;
CREATE TRIGGER annrev_no_update BEFORE UPDATE ON annotation_revision
BEGIN SELECT RAISE(ABORT, 'annotation revisions are append-only'); END;
CREATE TRIGGER annrev_no_delete BEFORE DELETE ON annotation_revision
BEGIN SELECT RAISE(ABORT, 'annotation revisions are append-only'); END;
CREATE VIRTUAL TABLE annotation_fts USING fts5(body, tags, content='', contentless_delete=1,
  tokenize="unicode61 remove_diacritics 2 categories 'L* N* Co M*'");   -- rowid = annotation_revision.id

-- ════════════ 10. App state, jobs, caches ════════════
CREATE TABLE saved_view (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,                 -- 'carry-the-zero-3f9a'; re-save → 'carry-the-zero-3f9a~2'
  parent_slug TEXT, name TEXT NOT NULL, description TEXT,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)), state_version INTEGER NOT NULL, state_hash TEXT NOT NULL,
  data_version INTEGER NOT NULL, max_import_batch INTEGER NOT NULL,
  run_ids_json TEXT NOT NULL CHECK (json_valid(run_ids_json)),
  annotation_rev_cutoff INTEGER NOT NULL,    -- max annotation_revision.id visible at save
  relationship_rev_cutoff INTEGER NOT NULL,  -- max relationship_revision.id visible at save
  comparisons_tried INTEGER NOT NULL DEFAULT 0,
  snapshot_svg TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
) STRICT;
CREATE TRIGGER view_immutable BEFORE UPDATE OF slug, state_json, state_hash, data_version, max_import_batch,
  run_ids_json, annotation_rev_cutoff, relationship_rev_cutoff ON saved_view
BEGIN SELECT RAISE(ABORT, 'saved views are immutable; save a new revision (slug~n)'); END;

CREATE TABLE job (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                        -- vocab.JOB_TYPES
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  writes INTEGER NOT NULL CHECK (writes IN (0,1)),   -- 1 = needs the single writer lock
  priority INTEGER NOT NULL DEFAULT 5,       -- 1 = interactive … 9 = background bootstrap
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelling','cancelled','interrupted')),
  progress REAL NOT NULL DEFAULT 0, phase TEXT, message TEXT, counts_json TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  run_id INTEGER REFERENCES analysis_run(id),
  result_json TEXT, error_json TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, heartbeat_at TEXT
) STRICT;
CREATE INDEX job_status ON job(status, priority, created_at);
CREATE TABLE job_event (
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id), at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  phase TEXT, progress REAL, message TEXT, data_json TEXT
) STRICT;
CREATE INDEX job_event_job ON job_event(job_id, id);

CREATE TABLE query_def (key TEXT PRIMARY KEY, def_json TEXT NOT NULL, created_at TEXT NOT NULL,
  last_used TEXT NOT NULL) STRICT;
CREATE TABLE tile_cache (key TEXT PRIMARY KEY,          -- queryKey|tier|tile|data_version
  body_gz BLOB NOT NULL, bytes INTEGER NOT NULL, last_used TEXT NOT NULL) STRICT;
CREATE TABLE layout_cache (key TEXT PRIMARY KEY, positions_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TABLE theme_assoc (theme TEXT NOT NULL, other TEXT NOT NULL, npmi REAL NOT NULL,
  PRIMARY KEY (theme, other)) STRICT, WITHOUT ROWID;
```

### 3.1 Seeded vocabulary (`server/db/seed-vocab.mjs`, idempotent)

**`rel_type`** — canonical direction is **src = later/dependent → dst = earlier/source**; Cipher's paired
labels ("samples"/"sampled by") collapse into one row. The brief's eight types are marked ★.

| code | family | directed | requires_precedence | implies_transmission | feedback_capable | glyph |
|---|---|---|---|---|---|---|
| exact_quotation ★ | quotation | 1 | 1 | 1 | 0 | “ ” |
| near_quotation ★ | quotation | 1 | 1 | 1 | 0 | ≈“ ” |
| shared_wording | similarity | 0 | 0 | 0 | 0 | ⇋ |
| samples | quotation | 1 | 1 | 1 | 0 | ♪ |
| interpolates | quotation | 1 | 1 | 1 | 0 | ♪≈ |
| explicit_citation ★ | citation | 1 | 1 | 1 | 0 | § |
| adaptation_of ★ | adaptation | 1 | 1 | 1 | 0 | ⟲ |
| remake_of | adaptation | 1 | 1 | 1 | 0 | ⟲ |
| cover_of | adaptation | 1 | 1 | 1 | 0 | ⟲♪ |
| version_of | adaptation | 1 | 0 | 1 | 0 | ⟲ |
| remix_of | adaptation | 1 | 1 | 1 | 0 | ⟲♪ |
| translation_of | adaptation | 1 | 1 | 1 | 0 | ⟲文 |
| parody_of ★ | parody | 1 | 1 | 1 | 1 | ◐ |
| recontextualizes ★ | reinterpretation | 1 | 1 | 1 | 1 | ↻ |
| answer_to | reinterpretation | 1 | 1 | 1 | 1 | ↩ |
| reframes | reinterpretation | 1 | 1 | 0 | 1 | ↺ |
| inspired_by | allusion | 1 | 1 | 1 | 0 | ✶ |
| homage_to | allusion | 1 | 1 | 1 | 0 | ✶ |
| proposed_allusion ★ | allusion | 1 | 1 | 1 | 0 | ? |
| similar_contextual_usage ★ | similarity | 0 | 0 | 0 | 0 | ∼ |
| kindred | similarity | 0 | 0 | 0 | 0 | ∼ |
| counterpart | similarity | 0 | 0 | 0 | 0 | ⇄ |
| part_of | containment | 1 | 0 | 0 | 0 | ⊂ |
| descends_from | etymology | 1 | 0 | 1 | 0 | ⤷ |
| sense_split | sense | 1 | 1 | 0 | 0 | ⑂ |
| sense_merge | sense | 0 | 0 | 0 | 0 | ⑃ |

**`language_period`** (astronomical years; label always ends "— period of the language, not a date"):

| lang | label | lo_year | hi_year | core | fuzz | note |
|---|---|---|---|---|---|---|
| ine-pro | Proto-Indo-European | −4499 | −2499 | — | 500 | reconstructed, not attested |
| sa | Sanskrit (Vedic → Classical) | −1499 | 1000 | −499…1000 | 300 | dhātus are grammatical roots |
| grc | Ancient Greek | −799 | 600 | — | 100 | |
| la | Latin (Old → Medieval; Wiktionary lemmas) | −699 | 1500 | −74…200 (Classical) | 100 | Wiktionary Latin includes Late/Medieval forms |

**`dimension_def` built-ins:** `lexical_sense` (text) · `topic` (text) · `referent` (text) ·
`pragmatic_function` (enum: sincere, ironic, parodic, reclaimed, pejorative, neutral) · `tone` (scale −2…2)
· `stance` (enum: endorses, opposes, neutral, mixed) · `social_association` (text) · `perspective`
(text) · `personal_reading` (text) · `reframes_target` (bool).

**`corpus` rows:** `demo` (synthetic) · `cipher` (real) · `stemm` (real) · `user` (user).

### 3.2 How a tile is computed (reference SQL, `server/aggregate/tiles.mjs`)

```sql
-- numerator: lane = passage language; decade level; one expression strand; text field class
SELECT e.plang AS lane, b.bin, SUM(e.n) AS n, COUNT(*) AS docs, COUNT(DISTINCT d.author) AS authors,
       MAX(e.n) AS top_doc_n
FROM expr_doc e
JOIN doc_bin b  ON b.document_id = e.document_id AND b.level = :level
JOIN document d ON d.id = e.document_id
WHERE e.expression_id = :expr AND e.run_id = :run AND e.field_class = 'text'
  AND b.bin BETWEEN :bin0 AND :bin1
  AND d.deleted_at IS NULL AND d.dup_of IS NULL AND d.is_translation = :translations
  AND d.collection_id IN (SELECT id FROM collection WHERE rate_eligible = 1 AND id IN (:collections))
GROUP BY lane, b.bin;
-- denominator: identical filters, restricted to the strand's variant languages
SELECT t.plang AS lane, b.bin, SUM(t.tokens) AS denom, COUNT(DISTINCT t.document_id) AS docs
FROM doc_tokens t
JOIN doc_bin b  ON b.document_id = t.document_id AND b.level = :level
JOIN document d ON d.id = t.document_id
WHERE t.field_class = 'text' AND t.plang IN (:strand_langs) AND b.bin BETWEEN :bin0 AND :bin1
  AND d.deleted_at IS NULL AND d.dup_of IS NULL AND d.is_translation = :translations
  AND d.collection_id IN (:collections)
GROUP BY lane, b.bin;
```

Title lanes use `COUNT(DISTINCT e.document_id)` as n and `COUNT(DISTINCT document)` of the slice as
denominator; washes use the same filters with `NOT EXISTS (doc_bin at :level)`; undated and scheduled use
`chrono_status`. Tiles are 64 bins wide; `tile = floor(bin / 64)`.

---

## 4. Analysis pipeline

Stages are interchangeable modules in `server/analysis/`, `server/lineage/` and `server/aggregate/`; each
has a pure core (unit-tested on arrays) and, when expensive, a job task in `server/jobs/tasks/`.
Analysis never imports UI code; the UI never computes statistics.

### 4.0 Runs and versions

Every stage execution writes one `analysis_run`: `pipeline_version` (semver per module, e.g.
`cluster@1.0.0`), `code_hash` (sha256 of the module's files, computed at boot), canonical params JSON
(sorted keys) + `params_hash`, `scope_json`, `input_fingerprint`, `data_version`, upstream run ids,
`representation`, model + version when any, `seed`, `tokenizer_version`, `segmenter_version`,
`icu_version` (`process.versions.icu`). A request with the same `(stage, params_hash,
input_fingerprint)` as a succeeded run **reuses** it. Saved views pin run ids; a newer run never
silently replaces an older one — the view shows *"A newer analysis exists (run #19) — [switch]"*.

### 4.1 Parse and validate → §5. 4.2 Preserve originals

Uploaded or adapter-read bytes are copied to `originals/` under their sha256 (`original_file`).
`document_text.original` is the decoded string with no newline or Unicode normalization (BOM stripped and
recorded). `original_meta_json` holds the full source record verbatim (bulk text replaced by a
`{"$text": "document_text"}` pointer). Rows larger than 64 KB keep `source_byte_start/end` instead of a copy.

### 4.3 Normalize, segment, tokenize, identify language

- **Decoding:** BOM → UTF-8 (fatal) → on failure windows-1252 with `W_ENCODING_FALLBACK` naming the first
  bad byte offset. The decoded string is the offset space; nothing is re-encoded.
- **Body bounds and regions** (adapters pass `regions[]` to DocumentWriter):
  Gutenberg markers — three regexes, case-insensitive: `\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n`
  / `\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG`, and `\*\*\*START\*\*THE SMALL PRINT` …
  `\*END\*THE SMALL PRINT[^\n]*\n`; fallback = whole file + `W_NO_GUTENBERG_MARKERS`. Paragraphs inside
  the body matching `/project gutenberg|gutenberg-tm|small print|this ebook is for the use of/i` →
  `quality='boilerplate'`. Wikisource pages joined with `\f` (page boundary = offset; `page_no` per
  passage).
- **Editorial apparatus** (gap fix: later editions dated with the original): a section whose heading in
  the first 15% or last 10% of the body matches `^(PREFACE|INTRODUCTION|EDITOR'?S NOTE|TRANSCRIBER'?S
  NOTES?|NOTES|BIOGRAPHICAL (NOTE|SKETCH)|PRÉFACE|AVANT-PROPOS|INTRODUCCIÓN|PRÓLOGO|NOTA DEL EDITOR)\b`
  **and** (names a person other than the document author in its first 3 lines, **or** contains a 4-digit
  year > `y_hi + 5`, **or** is a transcriber's note) → `time_role='apparatus'`, `field_class='apparatus'`;
  footnote blocks (`[Footnote …]`, `[1] …` at block start) containing a year > `y_hi + 5` likewise. Excluded
  from frequency by default ("editorial apparatus (heuristic): 14 passages — [include]"). Modernized
  orthography cannot be detected; the date card says "the transcribed edition may differ from the first
  edition".
- **Furniture:** `[Illustration…]`, short all-caps or roman-numeral headings → `quality='furniture'`;
  Wikisource lines repeated on > 30% of a book's pages, digit-only lines (any script), lines ≤ 3 chars,
  and the first 2 pages when they average < 30 tokens per line → `furniture` / `front_matter`. Never
  deleted, only flagged.
- **Passages** (`server/text/segment.mjs`, `SEGMENTER_VERSION='seg-1'`): split on blank lines; **verse
  mode** when ≥ 60% of a block's lines are < 60 chars and the block has ≥ 4 lines → stanzas ≤ 16 lines;
  long paragraphs split at the sentence boundary nearest 120 tokens (hard max 200) using
  `Intl.Segmenter(lang,{granularity:'sentence'})` plus `।` `॥`; blocks < 12 tokens merge forward until ≥ 40
  tokens, never across a heading, region or page; metadata documents: one passage per text field.
- **Tokenizer `u61m-1`** (`src/shared/tokenize.mjs`, single source of truth for counts): a token is a
  single `\p{So}` character **or** a maximal run of `[\p{L}\p{M}\p{N}\p{Co}]`, found over the **original**
  string with `[start,end)` UTF-16 offsets. Fold = `NFC → toLowerCase()` (locale-independent) → Devanagari
  digits U+0966–096F and Gujarati digits U+0AE6–0AEF → ASCII → remove U+200C, U+200D, U+00AD.
  `normString` = folded tokens joined by single spaces; FTS indexes it with
  `unicode61 remove_diacritics 2 categories 'L* N* Co M* So'`, so **FTS token i = JS token i** (FTS adds
  accent-insensitive search; analysis keeps accents). Hyphens and apostrophes split tokens (variants cover
  `cold-wire / cold wire / coldwire`).
- **Language ID** (`server/text/langid.mjs`): script first — Gujarati → `gu`; Devanagari → `hi` (unless the
  document declares `sa`/`mr`; confidence 0.6 when undeclared). Latin script: stop-word profile over
  en/fr/es/de/la/it/pt (60 function words each, `server/text/stopwords/*.json`); a language wins when its
  hits per token ≥ 0.15 and ≥ 1.5 × the runner-up over ≥ 8 tokens, else `und` (short Latin titles →
  `und-Latn`). Document `lang_text` = token-weighted majority. `is_translation=1` when `lang_declared ≠
  lang_text` and the majority covers ≥ 70% of tokens with confidence ≥ 0.6 (`W_LANG_MISMATCH`).
- **Coverage upkeep:** DocumentWriter writes `doc_tokens` and `doc_bin` at commit; quality changes
  rewrite them.

### 4.4 Indexes and context windows

`passage_fts` (contentless, `detail=full`, no prefix index; FTS automerge off during bulk load, then
`optimize`), `passage_vocab_row`, `passage_vocab_inst` (exact per-term positions), `label_tri` (trigram
over titles, native titles, makers, expression surfaces, etymon forms, themes — **typeahead only, never
counts**), `annotation_fts`. Windows, all clipped at passage boundaries: KWIC display ±12 tokens (computed at
request time from the original), collocations ±5, occurrence vectors ±10, space building ±4.

### 4.5 Variants, matching and the proper-noun guard (`server/text/variants.mjs`, `names.mjs`, `translit.mjs`)

- **Generated variants** (evidence `computed`, rule id stored, each shown with its own count and a toggle):
  en: `-s/-es`, `y→-ies`, `-ed`, `-ing` (e-drop, consonant doubling for CVC), `-er/-ers`, possessive;
  fr/es: plural `-s/-x/-es`, feminine `-e/-a/-as`; **hi** (oblique/plural): `-ा → -े/-ों/-ाओं`,
  `-ी → -ियाँ/-ियों`, consonant-final `+ों/+ें/+ाएँ`; **gu**: plural `-ઓ`, attached postpositions
  `-નો/-ની/-ના/-ને/-માં/-થી/-એ` and `-ઓ+postposition`; **orthographic** (hi/gu): nukta fold
  (क़→क, ख़→ख, ग़→ग, ज़→ज, फ़→फ, ड़/ढ़ kept), chandrabindu ↔ anusvara (ँ ↔ ं); hyphenation (`a-b`,
  `a b`, `ab`). hi/gu inflection and orthographic variants are **on by default** (otherwise hi/gu are
  systematically undercounted next to English); en/fr/es inflection on by default; all togglable.
- **Descendant variants** from `roots.tsv` members (evidence `documented`, Wiktionary) — off by default.
- **Transliteration variants** (`translit.mjs`, evidence `computed`, **off by default**, suggested in the
  variant panel): `romanKey(word)` maps Devanagari/Gujarati to a loose Latin skeleton (ISO-15919-lite:
  long/short vowels merged, `ś ṣ s → s`, `v w → v`, `z j → j`, aspirate `h` dropped after stops, schwa
  deletion at word end, anusvara → `n`) and folds Latin tokens with the same rules; a match needs equal keys
  and length ≥ 4 ("Shunya" ↔ शून्य). Code-switched Hinglish/romanized titles are therefore findable but
  never silently merged.
- **Translation variants:** user-added only (evidence `proposed`).
- **Proper-noun guard** (`names.mjs`): a match is flagged `name_flag=1` when the original token is
  capitalized and **not** sentence-initial and (the next or previous token is capitalized and not a
  stop-word), or when the token appears in the document's `author`/maker field. **Title passages
  (revised at the M1 gate, lead decision 2026-10-04):** Title Case is not evidence of a name; a title
  match is flagged only when the matched token lies inside a span that exactly equals a known
  maker/person name of ≥ 2 tokens, or when the whole title is a single-token name. *Zero Dark Thirty*,
  *Ground Zero*, *Zero Hour* and *Below Zero* are counted. Flagged matches are excluded from counts and
  listed as **"excluded as names (49)"** with an override per match ("Gene Kelly" → excluded; "The
  Selfish Gene" → counted).
  **Fix pass (2026-10-08/09, after the adversarial data review):** a whole title that merely equals *some* maker's
  one-word name is the word itself (the film *Virus* (1999) is not the band Virus); only a self-titled work (its own
  maker's name) is flagged. In body text a capitalized token after an elision apostrophe ("If 'Gene heard") is a
  clipped name; a possessive variant ("'Gene's") is guarded like the word; and **document consistency**: in a
  document whose body text never writes the word in lower case and where ≥ 3 occurrences are flagged names, every
  capitalized occurrence is the name, sentence-initial ones included (*The Brimming Cup*'s 'Gene). English `-er/-ers`
  forms are generated but **off** by default (*gene* → "gener" matched "De Gener." abbreviations). Every
  materialize run records the hash of the matching and guard modules, so a count made under older rules is stale.

### 4.6 Occurrences, frequency, dispersion, collocations

- **Materialization** (`server/aggregate/materialize.mjs`, job `materialize`, priority 1): expression +
  enabled variants → FTS `MATCH` (phrase query for multiword; variants OR-ed) → JS tokenization of each
  candidate passage → exact token-sequence match → occurrence rows with original offsets → `expr_doc`
  rows. While it runs, tiles show FTS passage-hit counts labelled **"preliminary: passages containing"**.
  Typical (≤ 20,000 candidate passages) finishes < 2 s; the UI shows "counting… 41%" (never a spinner
  without a number).
- **Very frequent expressions** (> 300,000 matches): single tokens get exact per-document counts from
  `passage_vocab_inst` (accent-insensitive; labelled "counts include accent variants"); phrases get exact
  counts by streaming candidates in a worker; occurrence rows are a **stratified sample** of ≤ 200 per
  (lane value, decade), `sampled=1`, and the drawer says "contexts sampled: 200 of 1,894 in this bin".
- **Rate:** `rate = n / denom × 10⁶` (tokens) or `× 10³` (works). The slice uses the same lane value and
  filters, the **same languages as the strand's variants** (a French variant is never divided by English
  tokens) and the same field class. 95% CI: exact Garwood interval (Poisson) for tokens; Wilson for works.
  **Gate:** denom ≥ 50,000 tokens / ≥ 30 works / ≥ 20 sampled works (OpenAlex cell); else state `low`.
- **Default exclusions** (each a filter toggle, each counted in the coverage tooltip): translations
  (text-language chronology), duplicates (`dup_of`), `describes` passages, `apparatus` passages,
  furniture/boilerplate/front matter/low/gappy passages, proper-noun-guard hits, `rate_eligible=0`
  collections (relation endpoints, baseline).
- **Dispersion:** per bin `docs`, `authors`, **Gries' DP** over documents (expected proportion = document
  share of slice tokens); `single_source` flag when the top document's share ≥ 0.6.
- **Collocations** (`collocations.mjs`, from token streams restricted to the slice's passages): window ±5;
  candidate needs f(x,y) ≥ 5 and f(y) ≥ 10; per-language stop-lists (150 words en/fr/es/de/la; hi/gu
  postpositions and auxiliaries) hidden by default; significance G² (Dunning) ≥ 10.83 and BH-FDR q < .05;
  strength **logDice = 14 + log₂(2·f_xy / (f_x + f_y))**, PPMI (α = 0.75) as a secondary column; ranked by
  logDice. **Gate:** target n ≥ 20 in the slice, else *"Too few occurrences (12; needs 20) to list
  collocates — showing KWIC only."*

### 4.7 Exact and near quotation detection; boilerplate (`server/lineage/`)

- **Token streams** (`tokstream` task, per data version per language): `derived/tokens/<lang>.u32` (one
  u32 id per token of `quality='ok'` passages), `.pidx` (passage id, offset), `.vocab.tsv`. ≈ 270 MB for
  the full corpus. Used by winnowing, collocations and PPMI.
- **Winnowing** (Schleimer et al. 2003) over token ids: k = 8-token shingles, window w = 6 →
  **guaranteed** detection of any shared run ≥ k + w − 1 = **13 tokens**; density ≈ 2/(w+1) ≈ 0.29
  fingerprints per token (≈ 20M for 70M tokens); hash = FNV-1a-32 over the 8 ids; records `(hash u32,
  passage u32, pos u16)` held in typed arrays in one worker (≈ 200 MB), **radix-sorted by hash**, then
  grouped. Never stored as SQLite rows.
- **Boilerplate vs commonplace** (`boilerplate` task, run by the bootstrap right after books load):
  groups whose hash occurs in > 25 distinct documents are *widespread*. A widespread group is
  **boilerplate** if ≥ 50% of its occurrences lie in the first 15% or last 15% of their documents' bodies
  **or** its text matches the licence lexicon (`project gutenberg|ebook|license|licence|donation|trademark|
  small print|computer virus|computer codes`); a passage with ≥ 50% of its fingerprints in boilerplate
  groups gets `quality='boilerplate'` (doc_tokens rewritten, data_version bumped). Other widespread groups
  are **commonplaces** (Bible verses, proverbs): counted normally, but collapsed into the "widely shared
  text" node in Lineage instead of generating pairs. **Canary:** after this pass no `quality='ok'` passage
  in `cipher-gutenberg` contains the licence sentence "computer virus, or computer codes that damage"
  (test §11).
- **Global reuse index** (`reuse-index` task, off by default, per collection set): candidate pairs =
  passages from different documents sharing ≥ 2 fingerprints within 40 tokens, in groups of 2–25
  documents, excluding `dup_of`/alias pairs and same-work editions (same folded author, title trigram
  similarity ≥ 0.6, document MinHash Jaccard ≥ 0.5 → `W_NEAR_DUP`, not a quotation); verification
  seed-and-extend over token arrays keeps maximal common runs ≥ 8 tokens. **Exact quotation** = verified
  identical run ≥ 13 folded tokens (global) or ≥ 8 (targeted trace).
- **Near quotation:** units = sentences (verse lines in verse mode) ≥ 6 tokens; MinHash 128 permutations
  over word 3-shingles; LSH 32 bands × 4 rows (threshold ≈ 0.42), stored in
  `derived/reuse/run-<id>/{units.bin,lsh.bin}`; verification token Smith–Waterman (+2/−1/−1), normalized
  score ≥ 0.75 of the shorter unit **and** 3-shingle Jaccard ≥ 0.5; both scores stored.
- **Targeted trace** (`POST /api/trace`, ≤ 1.5 s synchronous then continues as a job): for a span ≥ 4
  tokens: FTS phrase (exact), LSH lookup (near), `NEAR(…, 6)` permutations ("similar wording" — always
  computed similarity, never quotation).
- **Excluded inputs:** OpenAlex abstracts with `abstract_gaps` > 10% of tokens or > 1,000 tokens get
  `quality='gappy'` (KWIC labelled "reconstructed from an inverted index; positions missing") and are
  excluded from quotation detection; cross-language reuse is **not detected** (the trace panel says so).
- **From candidates to relationships** (all `origin='algorithm'`, `run_id` set, both spans stored as
  `relationship_evidence`):

  | Situation | rel_type | Direction | evidence_status |
  |---|---|---|---|
  | both dated and `A.hi_day < B.lo_day` | exact_quotation / near_quotation | B → A | `computed` (score_kind alignment_score / match_ratio) |
  | intervals overlap, or either undated | shared_wording | undirected, "direction unknown" | `computed` |
  | explicit attribution cue within ±30 tokens of B's span **and** A's author surname (or title tokens) in the cue | explicit_citation | B → A | **`proposed`** + `citation_cue` evidence row (CUE badge); only a human can confirm |
  | B matches A and also an earlier C that A matches | `hypothesis_group` "Source of B's wording?" with B→A and B→C | — | `computed` |

  **Cue patterns:** en `as X (said|wrote|put it|observed)`, `in X's words`, `X's (phrase|line)`, quotation
  marks around the span; fr `comme (l'a )?(dit|écrit) X`, `selon X`; es `como (dijo|escribió) X`,
  `según X`; hi `X ने कहा`, `X के शब्दों में`; gu `X એ કહ્યું`, `X ના શબ્દોમાં`.

### 4.8 Contextual representation (no paid APIs) and clustering

- **Pooled language space** (`vectors` task): one per language with ≥ 3M tokens, ≥ 10 documents, ≥ 5
  authors (translations excluded). Targets: types with f ≥ 20 (cap 50,000); contexts: top 10,000 types;
  window ±4 symmetric; co-occurrence counted in **typed-array open-addressing tables sharded by
  `targetId mod 8` across 8 workers** (2²³ slots each, key `target·10000+context` u32, value f32; a JS
  `Map` is forbidden above 1M entries — it fails near 16.7M); PPMI with context smoothing α = 0.75 → CSR;
  **randomized truncated SVD** (Halko): d = 256, oversampling 16, 2 power iterations, seed 42, sparse ×
  dense split by row block across workers via `SharedArrayBuffer`, Householder QR + one-sided Jacobi for the
  small SVD; `W = U·Σ^½`, rows L2-normalized; stored at `derived/spaces/<id>.f32`.
- **Era slice spaces:** per language, contiguous slices built greedily from the earliest year with
  preferred boundaries 1800 · 1850 · 1875 · 1900 · 1929, each needing ≥ 3M tokens, ≥ 10 documents, ≥ 5
  authors **after translations are removed**. Fewer than 2 eligible slices → drift disabled for that
  language with explicit copy (*"Aligned displacement unavailable for Spanish: one eligible slice
  (1825–1874 has 2.95M tokens; needs 3M)"*). The eligible list is computed at load and shown in the
  Compare coverage panel; no slice count is promised in advance.
- **Occurrence vectors** (Schütze 1998): second-order — IDF-weighted mean of pooled-space vectors over the
  ±10 context tokens with f ≥ 20, excluding stop-words and the target, L2-normalized. **Fallback** when no
  pooled space passes its gate (the demo, small imports, hi/gu if < 3M): **first-order TF-IDF context
  vectors hashed to 4,096 dimensions** (FNV-1a-32 mod 4096 with a sign bit, IDF from the slice).
  `context_thin` when < 3 usable context words (excluded from clustering, counted). The representation is
  recorded on the run and printed on every cluster card ("representation: tfidf-hash-4096").
- **Optional Apple NLEmbedding** (English only, static modern model) is used **only** to suggest
  "modern-reader neighbours" in the variant panel, labelled "modern reader model (Apple NLEmbedding en
  rev 1)"; never in clustering or drift.
- **Clustering** (`cluster` task) — scope: one expression + enabled same-language variants in one
  representation, so shares are comparable across time without alignment. **Gate:** ≥ 60 non-thin
  occurrences from ≥ 5 documents. Spherical k-means (cosine), k-means++ init, 10 restarts, ≤ 100 iterations;
  k ∈ {1 … min(8, ⌊n/20⌋)}; choose k by maximum mean cosine silhouette among *stable* k; best silhouette
  < 0.10 → k = 1, "no separable context groups". **Stability:** 30 subsamples of 80% **by document**;
  per-cluster stability = mean best-match Jaccard (Hennig 2007); < 0.5 → `unstable` (dashed lane
  outline, "tentative"); reject k if mean ARI vs the full clustering < 0.6. Clusters < max(10, 5% of n) →
  `residual` ("other contexts"). **Labels:** top 4 distinctive context words by weighted log-odds with an
  informative Dirichlet prior (Monroe et al. 2008), cluster vs rest, z ≥ 1.96, in-cluster f ≥ 3 → "machine
  label: column · digit · place"; user labels are annotation revisions; the machine label stays visible.
- **Windows and shares:** decades, merged forward until each has ≥ 30 occurrences; items whose date is
  wider than the window are excluded ("excluded: date too coarse (n)"); shares get a document-block
  bootstrap 95% CI (1,000 resamples).
- **Transitions** (all `computed`, drawn dashed): **emerge** = first window with share ≥ 10% and n ≥ 5;
  **vanish** = share < 2% across ≥ 2 *covered* windows (uncovered windows → `unknown_gap`); **split** =
  cluster B emerges at window t while its nearest older cluster A (centroid cosine ≥ 0.5) is present;
  **merge** = per-window centroids of two clusters move from cosine < 0.5 to ≥ 0.7.
- **Convergence of expressions X and Y:** per window, J(t) = Jaccard of their top-50 significant
  collocates (both must pass the collocation gate in that window) and C(t) = cosine of their mean
  occurrence vectors in the shared representation; reported (`cluster_transition.kind='convergence'`)
  when J rises by ≥ 0.15 between the first and last gated windows **and** the document-block bootstrap CI of
  the difference excludes 0.

### 4.9 Drift and displacement — three named measures, no "meaning score"

All three report n, documents and authors per slice; the UI always says *"estimated shift in usage
contexts"*, never "the meaning changed".

| Measure | What | Uncertainty / null | Gate (per slice) |
|---|---|---|---|
| (a) Context-share shift | JSD (base 2) between cluster-share distributions of A and B | document-block bootstrap 1,000 → 95% CI | ≥ 50 occurrences, ≥ 5 docs, ≥ 3 authors, top-doc share ≤ 0.5, clustering k ≥ 2 |
| (b) Neighbour overlap (no alignment) | 1 − Jaccard of top-25 neighbours in the two slice spaces | 500 frequency-matched controls (same frequency decile in both slices, top-100 stop-words excluded) → percentile | f ≥ 50, both slice spaces built |
| (c) Aligned displacement | 1 − cos(W_A[x], R·W_B[x]) after **orthogonal Procrustes** (R = UVᵀ from SVD of AᵀB) | same 500 controls → percentile | f ≥ 100, ≥ 20 docs, ≥ 5 authors; slices ≥ 3M tokens; ≥ 3,000 anchors (shared vocab f ≥ 100 in both, excluding the target and its top-20 neighbours, capped at 5,000); mean anchor cosine after alignment ≥ 0.5 |

- **Verdict rule:** "notable" only if (c)'s percentile ≥ the multiplicity-adjusted threshold
  (100 − 5/k, k = comparisons of this expression in the session; k = 1 → 95th) **and** (b) neighbour
  overlap Jaccard ≤ 0.2; otherwise "within typical variation". Unaligned spaces are refused (gate
  `unaligned`).
- **Composition:** composition JSD > 0.15 → caveat + standardized rates; > 0.4 → (c) not reported
  (`composition_mismatch`).
- **Modality:** cross-modality slices → `modality_mismatch` (default refusal, override "compare anyway,
  descriptive only" shows rates in their own units and no ratio, test or verdict).
- **OpenAlex:** comparisons across OpenAlex cells → `sampling_design` (descriptive within-cell shares
  only; no ratio, CI or test across cells).
- **Storage:** `drift_result` with `CHECK (gate='ok' OR value IS NULL …)` — a gated measure has no number.

### 4.10 Tone and stance (fallible annotations)

- **Machine tone:** optional Swift CLI `tools/nl-adapter` → `bin/scrolls-nl` (JSONL over stdio:
  `{"op":"sentiment","lang":"en","text":"…"}` → `{"score":-0.4}`; `{"op":"neighbors","lang":"en",
  "word":"virus","k":10}`; `{"op":"probe"}` → supported languages + macOS build). Runs only for languages
  the CLI reports (English verified). Stored as `annotation(kind='machine_tone', is_machine=1,
  method='apple-nltagger-sentimentScore', run_id)` with the macOS build as `model_version`. Shown as a
  distribution with a bootstrap CI of the mean, never a label on a single passage. Gate: adapter present,
  language supported, ≥ 30 paragraphs per slice.
- **Stance and irony:** human annotation only (`stance`, `pragmatic_function`). No automatic irony
  detection; the demo shows human counts per period and says so.

### 4.11 What is disabled when evidence is insufficient (and the exact UI copy)

| Feature | Gate code(s) | Gate | UI copy when failing |
|---|---|---|---|
| Rate in a bin | `insufficient_coverage` | denom ≥ 50k tokens / 30 works / 20 sampled works | "low coverage: n = 3 in 18k tokens" (hollow tick) |
| Collocates | `insufficient_occurrences` | target n ≥ 20; f(x,y) ≥ 5; q < .05 | "Too few occurrences (12; needs 20). Showing KWIC." |
| Context groups | `insufficient_occurrences`, `insufficient_documents`, `no_cluster_structure` | ≥ 60 non-thin occ., ≥ 5 docs; silhouette ≥ 0.10 | "Clustering unavailable: 41 occurrences in 3 documents." Lanes fall back to `language`. |
| Group shares per window | — | ≥ 30 per window | "Windows merged to reach n ≥ 30: 1850–1889" |
| Context-share shift | `insufficient_*`, `single_source` | §4.9 (a) | gate card + widening suggestion [Apply] |
| Neighbour overlap | `insufficient_occurrences`, `slice_too_small` | §4.9 (b) | "Word too rare in 1850–74 (31; needs 50)" |
| Aligned displacement | `unaligned`, `slice_too_small`, `composition_mismatch` | §4.9 (c) | "Not estimated: Spanish has one eligible slice (2.95M < 3M tokens)" |
| Cross-modality compare | `modality_mismatch` | same dominant modality | "A is book text, B is song titles. [Compare titles with titles]" |
| OpenAlex cross-cell | `sampling_design` | within-cell only | "OpenAlex is a top-cited sample per field × period; cells are not comparable as rates." |
| Tone | `not_run` | adapter, language, ≥ 30 paragraphs | "Tone needs the optional on-device adapter (not installed)" / "not available for Gujarati" |
| Deep-time band | — | ancestry in roots.tsv | "No etymology family in Cipher's roots data (Latin, Greek, Sanskrit, PIE only)" |
| External baseline | — | single word in the Ngram store | "No external baseline: the Ngram store holds single words only" |

Every gated response returns `{gate, needed, have, suggestion}`; suggestions are computed by widening the
failing slice in 10-year steps (up to the collection's coverage) or adding the nearest facet value until
the gate passes, reporting what it *would have*; when no widening passes, `suggestion=null` and the note
"no widening inside this corpus reaches the gate" is shown.

### 4.12 Jobs, concurrency and performance

- **Writer:** one job with `writes=1` at a time (queue in `server/jobs/queue.mjs`); interactive writes
  (annotations, reviews, views) run on the main connection in short `BEGIN IMMEDIATE` transactions with
  `busy_timeout=5000`. Bulk writers commit every 5,000 documents (or 50,000 rows).
- **Readers:** `server/db/readpool.mjs` — 3 worker threads, each with its own `readOnly` connection; heavy
  routes (`heavy:true`) run there. A read exceeding 5 s → worker terminated and respawned, response 503
  `QUERY_TIMEOUT` with a hint. Readers never hold transactions across requests.
- **WAL policy:** `wal_autocheckpoint=0` during bootstrap phases; `PRAGMA wal_checkpoint(TRUNCATE)` after
  each phase; if the WAL exceeds 1 GB the writer pauses its next batch until `wal_checkpoint(RESTART)`
  succeeds. Normal operation: autocheckpoint 1,000 pages.
- **Cancellation:** each job gets a `SharedArrayBuffer`-backed `Int32Array(1)` flag; `ctx.checkpoint()`
  (called at least every 200 ms of work) throws `CancelledError`; cancel is acknowledged ≤ 500 ms; the run
  becomes `cancelled`; no rows of it are visible (visibility rule) and `gc-runs` removes them.
- **Boot recovery:** jobs found `running` are marked `interrupted`; their runs `failed`.
- **Budgets (M-class Mac, measured by `scripts/bench.mjs`):** tile p95 warm ≤ 80 ms, cold ≤ 300 ms (L0–L3);
  marks ≤ 150 ms; search ≤ 120 ms; `/api/health` p95 < 50 ms during any job; metadata-first Cipher phase
  ≤ 60 s; full Cipher bootstrap ≤ 10 min; demo load ≤ 3 s.

---

## 5. Ingestion

Every source — user files, Cipher, STEMM, the demo — flows through **one** writer:
`server/store/document-writer.mjs` (WP0). Parsers (WP1) and adapters (WP2) only produce
`CanonicalDocument` / `CanonicalRelationship` / `CanonicalAnnotation` objects (§12.3 contracts).

### 5.1 Formats

| Format | Parsing rules |
|---|---|
| **TXT** | One document per file; title = file name. Leading `Title:` / `Author:` / `Date:` / `Language:` lines (Gutenberg style) or a `---` front-matter block become metadata (kept in the original). Option **line mode** (verse, transcripts): passages are stanzas. |
| **MD** | Front matter = YAML subset (scalars, inline lists, `- item` lists; dependency-free parser). Headings start passages; the original keeps its markup; markup characters are not tokens. |
| **CSV / TSV** | RFC 4180 state machine: quoted fields, embedded newlines, `""` escapes, BOM. Delimiter sniffed from `, \t ; \|` by field-count consistency over the first 50 records / 64 KB. Header required unless `header:false` with positional mapping. |
| **JSON** | An array of objects, or an object whose array is chosen by JSON Pointer (`/items`); files > 100 MB are streamed. |
| **JSONL** | One object per line; blank lines skipped; every error carries its line number. Array fields can be joined into text with a delimiter; `pages` joined with `\f` keep `page_no` (Cipher Wikisource uses this). |

Limits: 2 GB per file (streamed to `incoming/`), 20 MB per text field (`E_ROW_TOO_LARGE`), 5M rows per
import. A directory import is a series of single-file imports sharing one collection.

### 5.2 Field mapping — UI and server contract

**Canonical target fields:** `ext_id` · `title` · `text` · `author` · `date` · `date_end` ·
`date_precision` (override) · `referenced_date` · `language` · `kind` · `genre` · `community` · `culture`
· `field` · `collection` · `source_url` · `license` · `cites` (list of ext_ids → documented
`explicit_citation`, "as stated in your file") · `relations` (list of `{type, target_ext_id, evidence?:
'documented'|'proposed'}`) · `tags` (list) · `notes` · `meta.*` (passthrough; everything unmapped is
always preserved in `original_meta_json`).

**Sources:** a CSV header, a JSON Pointer, or a constant. **Transforms** (closed list): `trim`,
`join(delim)`, `split(delim)`, `lower`, `date(options)`, `zero_is_unknown`, `map({…})`,
`regex_extract(pattern, group)`.

**Wizard flow** (`src/ui/import/`): (1) **Upload** — drop a file; preview shows format, encoding,
delimiter and 20 sample rows. (2) **Map** — each target has a dropdown pre-filled from header synonyms
(`date|year|published|issued|pub_date|fecha|तारीख|તારીખ`; `text|body|content|lyrics_excerpt`; …) and
value sniffing (> 80% parse as dates → date; longest average string → text), plus a live parse panel
("date: 1,912 / 2,000 rows parse · 61 circa · 27 unknown · 0 invalid"; red cells show issues).
(3) **Validate** — dry run over all rows in a worker → projected summary. (4) **Commit** — a job with SSE
progress, then the summary with **Open in timeline**. Mappings are saved in `import_batch.mapping_json`
and offered for reuse.

```
POST /api/imports            raw body; headers X-Scrolls-Filename, X-Scrolls-Collection (URL-encoded JSON
                             {"slug","name","unit":"tokens"|"works","license"})
                             → {"import_batch_id":17,"preview":{…}}
GET  /api/imports/17/preview → {format, encoding, delimiter, header, columns:[{name, samples[5], inferred:
                               "text|date|number|id|url|lang|list"}], sample_rows[20], suggested_mapping, issues[]}
PUT  /api/imports/17/mapping  {mapping}   → {"validation": <ImportSummary, dry run>}
POST /api/imports/17/commit   {mapping}   → {"job":{"id":302}}
GET  /api/imports/17/problems.csv
POST /api/imports/17/revert               → soft-deletes the batch's documents, bumps data_version
```

```json
{ "format": "csv", "delimiter": ",", "header": true, "encoding": "utf-8",
  "collection": { "slug": "my-zines", "name": "Zines 1977–1999", "unit": "tokens", "license": "own" },
  "fields": {
    "ext_id": { "from": "id" },
    "title":  { "from": "Title", "transform": ["trim"] },
    "text":   { "from": "body" },
    "date":   { "from": "issued", "transform": [{ "date": { "circa_radius": 5, "two_digit_century": null } }] },
    "language": { "from": "lang", "transform": [{ "map": { "English": "en", "Hindi": "hi" } }] },
    "community": { "const": "east-side zine scene" },
    "cites":  { "from": "refs", "transform": [{ "split": ";" }] } },
  "options": { "dedupe": "flag", "detect_language": true, "on_bad_row": "skip_and_report", "line_mode": false } }
```

### 5.3 Date grammar (`src/shared/dates.mjs`, shared by server and browser)

`parseDate(raw, opts) → {lo_day, hi_day, lo_year, hi_year, precision, basis, approx, rule, raw, label,
warnings[]}` or `{issue:{code, message, suggestions[]}}`. Devanagari and Gujarati digits are mapped
first; matching is case-insensitive with en/fr/es/hi/gu month names.

| Input examples | rule | precision | basis | interval |
|---|---|---|---|---|
| `1931-04-07`, `7 April 1931`, `7 avril 1931`, `7 de abril de 1931`, ISO date-times | `iso_day` / `dmy_named` | day | stated | that day (invalid days such as `2019-02-30` → `E_DATE_INVALID`) |
| `1931-04`, `April 1931`, `avril 1931`, `abril de 1931` | `month` | month | stated | that month |
| `1931` | `year` | year | stated | the year |
| `c. 1931`, `ca. 1931`, `circa 1931`, `~1931`, `1931?`, `hacia 1931`, `vers 1931`, `around 1931` | `circa` | range | estimated, `approx=1` | ± `circa_radius` (default **5** years) |
| `1990s`, `the 1990s`, `années 1990`, `década de 1990` | `decade` | decade | stated | 1990–1999 |
| `the 1800s` (4 digits ending `00s`) | `hundreds` | century | stated | 1800–1899 + `W_AMBIGUOUS_HUNDREDS` ("write 1800–1809 for the decade") |
| `'90s`, `90s` | `decade_2digit` | — | — | `E_DATE_AMBIGUOUS` unless `two_digit_century` is set |
| `19th century`, `19th c.`, `XIXe siècle`, `siglo XIX`, `s. XIX` | `century` | century | stated | 1800–1899 (popular usage; it fits the century bin, and ±1 year is immaterial at century precision; staged sources that state `year_lo/hi` themselves are taken as given) |
| `early / mid / late 19th century` | `century_part` | range | stated | 1800–1833 / 1833–1866 / 1866–1899 |
| `1850–1855`, `1850-55`, `1850 to 1855`, `between 1850 and 1855`, `1850/1851` | `range` | range | stated | as given |
| `before 1850`, `after 1850`, `antes de 1850`, `avant 1850` | `open_range` | range | estimated | 50 years on the open side (`open_range_years`) |
| `500 BCE`, `500 BC`, `500 av. J.-C.`, `500 a. C.` | `bce` | year | stated | astronomical −499 |
| a bare negative year `-300` | `negative_year` | year | stated | per `negative_year_convention`: **historical** (default; −300 = 300 BCE = astronomical −299; Wikidata and people write it so) or `astronomical` |
| `2nd millennium BCE` | `millennium` | millennium | stated | −1999 … −1000 |
| `संवत 1987`, `સંવત ૧૯૮૭`, `VS 1987` | `vikram_samvat` | range | derived | CE = VS − 57 … VS − 56 (2-year span) |
| `शक 1850`, `Saka 1850` | `shaka_samvat` | range | derived | CE = Saka + 78 … Saka + 79 |
| `spring 1850`, `Easter 1850` | `season` | range | estimated | Mar–May / Mar–Apr + warning |
| `unknown`, `n.d.`, `s.d.`, `s.f.`, `sin fecha`, `sans date`, `?`, `''`, and `0` with `zero_is_unknown` | `unknown` | unknown | unknown | null |
| a date after the import time | `*`+`future` | as parsed | **announced** | Scheduled shelf + `W_DATE_FUTURE` |
| anything else | — | — | — | `E_DATE_UNPARSEABLE` with up to 3 suggested readings |

**Day arithmetic:** `dayFromYMD(y,m,d)` builds `new Date(0)` and calls `setUTCFullYear(y, m-1, d)` (never
`Date.UTC`, which maps years 0–99 to 1900+); tests cover years 0–99, −4499, leap years and 2026-10-03.
**Three kinds of time stay separate:** publication/creation (chronology); **referenced** time (what a
passage is about: a chip, and the x-basis in "referenced" mode only); **ingestion** time
(`import_batch.committed_at` + `date_assertion(role='ingestion')`, shown only in Imports/Jobs).

### 5.4 Duplicates

1. Same file sha256 already committed to the collection → whole import refused, `E_DUP_FILE` ("Already
   imported on 2026-10-03 as batch 12 — [open batch]").
2. Same `ext_id` twice in one import → second row rejected, `E_DUP_ID` citing both line numbers (option
   `upsert` replaces instead).
3. Same normalized body hash as an existing document → accepted with `dup_of`, excluded from counts by
   default, `W_DUP_CONTENT`.
4. Near-duplicate document (whole-document MinHash Jaccard ≥ 0.9, 128 perms over 5-shingles) → accepted,
   `W_NEAR_DUP`; resolved in the summary as "keep both" / "mark as duplicate".
5. Metadata-only near-duplicate (same folded title + author + year) → `W_DUP_METADATA`.
6. Cipher-specific: Gutenberg #1661 (three QIDs on one text) → one document with 2 `document_alias` rows.

### 5.5 Malformed input → actionable messages

Every issue: `{code, severity, line, col?, field?, value_excerpt, message, suggestion}` (stored in
`import_issue`, downloadable as CSV).

| Code | Example message — with suggestion |
|---|---|
| `E_ENCODING` / `W_ENCODING_FALLBACK` | "Line 418: bytes are not valid UTF-8 (0xE9 at byte 30,211). Re-save as UTF-8, or accept the Windows-1252 reading shown." |
| `E_CSV_QUOTE` | "An unclosed quote starts on line 77, column 14 and runs to the end of the file. Check for a stray \" in 'notes'." |
| `E_ROW_RAGGED` / `W_TRUNCATED_ROW` | "Row 57 has 9 fields, the header has 8: check for an unquoted comma in 'title'." |
| `E_JSON_PARSE` | "Line 7, column 112: unexpected '}'. The other 1,203 lines parsed; skip this line?" |
| `E_MISSING_TEXT` | "Row 55 has no text and no title. Map a text column or allow metadata-only rows." |
| `E_DATE_UNPARSEABLE` | "Row 9 date 'Spring-ish 1850': try 'spring 1850' (Mar–May 1850) or 'c. 1850'. Row imported as undated." |
| `E_DATE_AMBIGUOUS` | "Row 3 date '90s': which century? Set 'two-digit years → 19xx'." |
| `E_DATE_INVALID` | "Row 21 date 2019-02-30 does not exist; row imported as undated." |
| `E_FIELD_TYPE` | "Row 12 'cites' is an object; expected a list of ids." |
| `E_ROW_TOO_LARGE` | "Row 4 text is 31 MB (limit 20 MB). Split the file, or import it as TXT." |
| `E_DUP_FILE`, `E_DUP_ID` | as §5.4 |
| `W_LANG_MISMATCH` | "Declared French, but the text reads as English (stop-word score en 0.41 / fr 0.03). Marked as a translation." |
| `W_MIXED_LANGUAGE` | "Document 'Aarti Sangrah' has passages in hi (71%) and sa (29%)." |
| `W_DATE_FUTURE`, `W_AMBIGUOUS_HUNDREDS`, `W_DUP_CONTENT`, `W_NEAR_DUP`, `W_DUP_METADATA`, `W_NO_GUTENBERG_MARKERS` | as above |

`on_bad_row`: `skip_and_report` (default) or `abort`. Imports are transactional per batch: a fatal error
or `abort` leaves **zero** documents from the batch (batch `failed`).

### 5.6 Mixed languages

Language is detected per passage; the document language is the token-weighted majority (or the declared
one when given and confirmed). Lanes split by `passage.lang`; frequency denominators use tokens of the
matching language; Latin-script short titles are `und-Latn`. An unidentified passage (`und`, `und-Latn`) of a document's
running text (text, abstract, apparatus) belongs to the document's language: it counts for a strand only when that
language is one of the strand's, or is itself unidentified; title rows and describing passages keep their own language
(reference change RF-1, `ref-freeze-1`; `server/aggregate/langgate.mjs`).

### 5.7 Import summary object

```json
{ "import_batch_id": 17, "collection": "my-zines",
  "file": { "name": "zines.csv", "sha256": "9c1e…", "bytes": 4183022, "encoding": "utf-8", "format": "csv", "delimiter": "," },
  "rows": { "seen": 2000, "accepted": 1961, "accepted_with_warnings": 214, "rejected": 39 },
  "documents": { "created": 1958, "duplicates_flagged": 3, "metadata_only": 12, "translations": 4 },
  "passages": 15422, "tokens": 2310455,
  "dates": { "day": 120, "month": 301, "year": 1288, "decade": 140, "century": 9, "range": 30, "circa": 61,
             "unknown": 27, "scheduled": 0, "span": { "from": "1871", "to": "1999-08-02" } },
  "languages": { "en": 1801, "es": 102, "und": 55 },
  "relationships": { "documented": 88, "proposed": 4, "unresolved_targets": 2 },
  "mapping_decisions": [ { "target": "date", "from": "issued", "transform": "date(circa_radius=5)", "parse_rate": 0.986,
                           "reason": "92% of values parse as dates" } ],
  "problems": { "by_code": { "E_DATE_UNPARSEABLE": 21, "W_LANG_MISMATCH": 55 },
                "first": [ { "code": "E_DATE_UNPARSEABLE", "severity": "warning", "line": 9, "field": "issued",
                             "value_excerpt": "Spring-ish 1850", "message": "…", "suggestion": "…" } ],
                "download": "/api/imports/17/problems.csv" },
  "data_version": 48, "run_id": 88, "started_at": "…", "finished_at": "…", "duration_ms": 5210 }
```

---

## 6. Cipher mapping

### 6.1 Provenance and evidence vocabulary (closed; `src/shared/vocab.mjs`)

| Field | Values | Meaning |
|---|---|---|
| `evidence_status` | **documented** | An external record states the link (Wikipedia, Wikidata, MusicBrainz, ItwoFS, Wiktionary, an OpenAlex reference list, a user import's `cites` column, or — in the demo only — the synthetic world's records). Requires `origin='source_dataset'`, `source_dataset`, and a `source_locator` **or** `provenance_quality='source_unrecorded'` (badge `DOC*`: "documented upstream; source not recorded by Cipher"). |
| | **computed** | An algorithmic estimate with `run_id`, method and score: shared wording, quotations, kindred, cluster transitions, convergence. |
| | **proposed** | A hypothesis: tagging-pass siblings, title-match counterparts, attribution cues (+ CUE evidence), human-proposed allusions. |
| `origin` | `source_dataset` · `algorithm` · `machine_tagger` · `human` | CHECKs in §3 bind status to origin. |
| `review_status` | `unreviewed` · `confirmed` · `rejected` · `disputed` | The human layer; drawn as overlays ✓ ✕ ⚖, never as a different line style. |
| `created_by` | `adapter:<id>@<v>` · `run:<id>` · `human:<name>` | |
| `score_kind` | `similarity` · `heuristic_strength` · `match_ratio` · `alignment_score` · `classifier_score` | Every score says what kind of number it is; none is a probability. |
| `doc_tag.provenance` | `documented_category` · `machine_tag` · `genre_heuristic` · `catalog` · `adapter_machine` | Tags are never document text. |
| `is_synthetic` | 0/1 on every entity | Orthogonal to status: a synthetic link can be documented *within the demo world* and is still hatched + `SYN`. |

### 6.2 Collections and adapters (corpus `cipher`, kind `real`)

| Collection | Adapter | domain · modality · unit | sampling / selection note |
|---|---|---|---|
| `cipher-gutenberg` | `cipher.books` | literature · text · tokens | `prominence_selected`: "693 public-domain books chosen by Wikipedia sitelinks (prominence), en/fr/es" |
| `cipher-wikisource-hi`, `cipher-wikisource-gu` | `cipher.wikisource` | literature · text · tokens | `curated`: "Wikisource index books with transcribed pages" |
| `cipher-culture-works` | `cipher.works` | culture · titles · works | `prominence_selected`: "Wikidata works ranked by sitelinks and canon lists" |
| `cipher-music-relations` | `cipher.relations` | culture · titles · works | `relation_endpoints`, **`rate_eligible=0`**: "works that appear in documented sample/cover/version links" |
| (etymon tables) | `cipher.roots` | etymology · lexical · entries | Wiktionary via kaikki.org, CC BY-SA |
| (theme_assoc) | `cipher.themes` | — | computed NPMI by Cipher |

All `access='local-dataset'`, `uses no network`. Paths come from `server/config.mjs` (`CIPHER.*`).
Adapters copy each source file into `originals/` (sha256) before reading.

### 6.3 Gutenberg books (`gutenberg.json` + `texts/gutenberg/<id>.txt` + `pg_catalog.csv` row)

- **Documents:** 691; `ext_id = pg:<id>`; title/author from the JSON (author falls back to the catalogue);
  `kind=book`, `has_full_text=1`, `prominence=links`; `original_meta_json` = JSON entry + catalogue row
  (LoCC, Subjects, Issued, Authors with life dates). #1661 → one document + 2 aliases.
- **Language:** `lang_declared` from the JSON; `lang_text` detected; mismatch → `is_translation=1`,
  `original_lang = lang_declared` (expected ≈ 100 fr + ≈ 10 es; the exact count is reported).
- **Dates:** the JSON `year` → `role='original_publication'` if translation, else `publication`;
  `basis='estimated'`, `rule='cipher_lifetime_year'`, note "may coincide with the true date" when year =
  first author's birth + 40 per the catalogue (116 books); otherwise `basis='stated'`, note "Cipher list
  year (Wikidata-derived), unverified". `Issued` → `role='release'` (never chronology). 8 without year →
  undated.
- **Text:** body regions per §4.3 (markers, licence paragraphs, apparatus, furniture); `field` facet =
  STEMM field when LoCC is Q/R/T (5 books: *Flatland*, *Descent of Man*, *Wild Animals I Have Known*,
  *Principles of Scientific Management*, *Opticks*), else unset (domain literature).

### 6.4 Wikisource books (`wikisource-{hi,gu}.jsonl`)

450 hi + 375 gu documents; `ext_id = ws-<lang>:<index>`; pages joined with `\f` (`decoder =
'pages-joined-ff'`; the raw JSONL line is the `original_meta_json`); dates `role='publication_unspecified'`,
basis stated, note "Wikisource index year; may be an edition year" (e.g. *आज भी खरे हैं तालाब* = 2004, its 5th
edition); `null` → undated (hi 42, gu 172). First two pages are front-matter candidates.

### 6.5 Culture works (`culture-works.tsv`; no header; 16 columns; 0-based row = id)

Each row → one **metadata document**, `ext_id = cw:<row>`, `has_full_text=0`, collection unit works;
`source_byte_start/end` = the row's line in the original TSV.

| Column | Becomes | Provenance and handling |
|---|---|---|
| qid | `document_alias` + meta | Wikidata `Q…` or Cipher `S…` |
| kind | `document.kind` | |
| culture | `document.culture` | label "country of origin (Wikidata)" |
| year | chronology | `''` or `0` → undated; > 2026 → `chrono_status='scheduled'`, basis `announced`; negative → BCE (historical convention); else basis stated, precision year |
| weight | `prominence` (+ tercile per kind) | never an evidence weight |
| title, native title | `document_field` + passages (`field_class='title'`, `time_role='document'`) | **the only text dated with the work** |
| maker | `author` + `doc_tag(scheme='maker', provenance='catalog')` | |
| summary | `document_field` + passage `field_class='describes'`, `time_role='describes'` | + `date_assertion(role='authored_description', 2012–2026, precision range, basis estimated)`; excluded from frequency by default |
| canon | `doc_tag(scheme='canon', provenance='documented_category')` | |
| themes | `doc_tag(scheme='theme', weight)` | `machine_tag` if the theme appears in that work's batch in `$T/tags/*.jsonl`; `genre_heuristic` if weight is exactly 0.55 and it matches a genre category name; else `documented_category` |
| motifs | `doc_tag(scheme='motif', provenance='machine_tag')` | method "Cipher tagging pass (Claude sub-agent, Oct 2026)" |
| meaning | `annotation(kind='machine_gloss', is_machine=1)` | same method; **not document text** |
| mood | `doc_tag(scheme='mood')` | `genre_heuristic` when every value is at 0.50 (genre-derived half weight), else `machine_tag` |
| siblings | relationships | §6.6 |
| sampled_count | `original_meta_json` only | derived count, not evidence |

The **hip-hop subset** (~2,248 songs) is a saved filter, not a collection: theme ∈ {hip hop, hip-hop, rap,
pop rap, trap music, drill, grime, gangsta rap, conscious hip hop, …}, shown as "selected by themes
(mostly category-derived genre tags)".

### 6.6 Siblings and raw relation files → relationships

**Parsing:** `row:relation:strength[:source]` items separated by `|`; inverse pairs collapse into one
canonical row (src = later/dependent). Cipher `strength` → `score`, `score_kind='heuristic_strength'`,
labelled "Cipher heuristic weight — not a probability". **Locators:** for `w`/`m`/`i`, join the raw files
`$T/songs/relations_{wiki,mb,itwofs}.json` on (folded title, folded artist, year ±1) to fill
`source_locator` from `page`; otherwise `provenance_quality='source_unrecorded'`.

| Cipher relation [source] | rel_type | evidence_status · origin | method / note |
|---|---|---|---|
| samples / sampled by [w, m, d] | samples | documented · source_dataset | wikipedia-song-article / musicbrainz l_recording_recording / wikidata |
| interpolates / interpolated in [w, m, d] | interpolates | documented | per source |
| cover of / covered as [m, w] | cover_of | documented | per source |
| other version / version of [m, d, w] | version_of | documented | per source |
| remix of / remixed as [w, m, d] | remix_of | documented | per source |
| answer song to / answered by [w] | answer_to | documented | wikipedia |
| inspired / inspired by [i] | inspired_by | documented | itwofs (CC BY 2.5; attribution link required in exports) |
| inspired / inspired by [w, d] | inspired_by | documented | wikipedia / wikidata P941 |
| from film / features song / written for / song from [w, d] | part_of | documented | wikipedia soundtrack / wikidata |
| **kindred [-]** (26,001) | kindred | **computed** · algorithm | `cipher-theme-cosine (build_culture.py)`: rarity-weighted theme cosine ≥ 0.42, capped 0.7, cross-culture; `run_id` = a synthetic `analysis_run(stage='cipher_load')` recording that provenance; hidden by default |
| **counterpart [-]** (871) | counterpart | **proposed** · machine_tagger | "Cipher tagging pass or title match" |
| any other relation [-] (adapted as/based on, remake, inspired, homage, version, interpolates, samples, cover …) | as named | **proposed** · machine_tagger if the pair appears in either work's `$T/tags/*.jsonl` siblings (tagging pass, title ±2 y match); otherwise **documented** · source_dataset `wikidata-or-wikipedia` with `provenance_quality='source_unrecorded'`, note "Wikidata P144/P941/P4969, Wikipedia lead or remake/format table — source not recorded by Cipher" | |

**`cipher.relations` adapter** (the documented genealogy beyond the 94k): reads all three raw files;
each endpoint becomes a document in `cipher-music-relations` keyed by MusicBrainz recording id
(`mb:<uuid>` from `page`) or by `fold(title)|fold(artist)|year`; an endpoint matching a culture work
(folded title + folded artist, |Δyear| ≤ 1) is **aliased** to it instead (no duplicate document);
relationships documented with the `page` locator; dates `role='release'`, basis stated, rule
`cipher.relations.year`, note "year as recorded by Cipher from MusicBrainz/Wikipedia; may be a
first-release year"; duplicates of culture-works siblings merge into one relationship with an extra
`external_record` evidence row.

**Date conflicts:** any `requires_precedence` row whose src year < dst year gets `date_conflict=1` (drawn
⚠, §1.8).

### 6.7 Etymology (`roots.tsv`) and themes

- Each row → `etymon(key, kind, lang, form, roman, gloss, parent_semantics)`; `roots` →
  `etymon_parent` (ord kept); `members` → `etymon_member(lang, word, norm, rank)` (rank = "commonest
  first", a frequency heuristic). `parent_semantics`: `none` (0 parents), `single` (1), `listed_chain`
  (parents include both a `sa:` dhātu and an `ine-pro:` root — 704), `listed_variants` (all parent forms
  within edit distance 2 of the first — 351), `listed_unresolved` (rest — 1,170).
- Each `language_period` row gives the band; **words are not dated by etymology** — their timeline position
  comes only from corpus observations.
- Descent edges (`descends_from`, documented, source_dataset `wiktionary`, locator
  `https://en.wiktionary.org/wiki/Reconstruction:<lang>/<form>` for PIE, else the lemma page, CC BY-SA)
  are **virtual** (served from the etymon tables) until a user reviews or annotates one; then they are
  materialized as `relationship` rows.
- `culture-themes.tsv` → `theme_assoc` (computed NPMI, method "Cipher NPMI (build_culture.py)").
- **Derived files:** `culture-lines.tsv` is **not imported**; it is a test oracle (≥ 95% of 1,000 sampled
  lines must be locatable in imported passages; note its languages inherit the Gutenberg mislabel).
  `hinges.tsv` and Loom lines are not imported (derived without stored parameters).

### 6.8 Bootstrap (metadata first) and reconciliation

`scripts/bootstrap-cipher.mjs` / job `bootstrap-cipher` (auto-started on first server start when the
Cipher paths exist, unless `SCROLLS_NO_AUTO_IMPORT=1`), priority 9, phases:

| Phase | Steps | Target |
|---|---|---|
| **A · metadata** | works → siblings → themes → roots | ≤ 30 s → toast "Cipher titles, relations and etymology are ready" and the tour's *Switch to Cipher* chip enables |
| **A2 · genealogy** | `cipher.relations` (≈ 171k relations) | ≤ 60 s total from start |
| **B · full text** | Gutenberg books → Wikisource hi/gu → `boilerplate` pass → `fts optimize` | ≤ 10 min; text lanes show `pending` (dotted, "indexing — not yet looked") until done; progress "full text 312 / 1,516 books" |
| **C · STEMM (user-triggered)** | Adapters page → per adapter "Load" | §10 |

Reconciliation counts are written into the bootstrap run's `metrics_json` and asserted by
`tests/cipher-mapping.test.mjs`: 94,385 work documents · 8,227 undated works · 28 scheduled works ·
691 Gutenberg documents + 2 aliases · translations flagged: fr ≥ 90 and es ≥ 5 · Wikisource undated
42 / 172 · relationships by `(rel_type, evidence_status)` = parsed sibling pairs ÷ 2 (minus collapsed
inverse duplicates) · kindred count = computed `kindred` count · counterpart count = proposed `counterpart`
count · 0 `quality='ok'` passages containing the licence's "computer virus" sentence.

---

## 7. API (JSON over `node:http`, all under `/api`)

**Conventions.** Server binds `127.0.0.1:3460` only. `Host` must be `127.0.0.1:3460` or `localhost:3460`
(DNS-rebinding guard) and mutating requests need a same-origin `Origin` → else 403 `E_FORBIDDEN_ORIGIN`.
Errors: `{"error":{"code","message","hint","detail"}}` with the right status (400 validation, 403, 404,
409 conflict, 503 `QUERY_TIMEOUT`, 500). Every GET carries `ETag: W/"<dataVersion>-<hash>"` and honours
`If-None-Match`. Every list takes `limit` (≤ 200; marks ≤ 4,000) and an opaque `cursor`. Every data
response carries `provenance: {data_version, run_ids, tokenizer:"u61m-1", segmenter:"seg-1", synthetic,
collections:[…], licenses:[…]}`; every object that can be synthetic carries `synthetic: true|false`. The
client sends `X-Scrolls-Session: <random per tab>` (used only for the multiplicity log). Gates are not
errors: gated measures return 200 with `{gate, needed, have, suggestion, value:null}`.

**Filter grammar** (query string `f`): `lang:en,fr;kind:book,song;coll:cipher-gutenberg;culture:in;field:medicine;basis:-estimated;syn:1`
(`-` excludes). **Toggles:** `tr` translations (0), `ds` describes (0), `ap` apparatus (0), `dup` (0),
`nm` name-guard hits (0), `est` estimated dates (1), `bp` boilerplate (0).

### 7.1 Endpoint list (route file → owning package in §12)

| Method & path | Purpose | Heavy (read pool) | Route file |
|---|---|---|---|
| GET `/api/health` | version, contract, dataVersion, db bytes, jobs, adapters, read-pool load, Cipher bootstrap status | | health (WP0) |
| GET `/api/events` | SSE: `job`, `data` (dataVersion bump), `adapter`, `bootstrap` | | events (WP0) |
| GET `/api/jobs?status=` · GET `/api/jobs/:id` · GET `/api/jobs/:id/events` (SSE) · POST `/api/jobs/:id/cancel` | jobs | | jobs (WP0) |
| POST/GET/PUT `/api/imports…` | §5.2 | dry-run ✓ | imports (WP1) |
| GET `/api/corpora` · GET `/api/facets?f=` | corpora/collections with coverage, licences, status; facet values with counts | ✓ | corpora (WP2) |
| GET `/api/adapters` · POST `/api/adapters/:id/load` · POST `/api/adapters/:id/enable` | staged-source adapters (network ones need `{approve:true}`) | | adapters (WP2) |
| GET `/api/baseline?word=&from=&to=` | Ngram series or `{available:false, reason}` | ✓ | baseline (WP2) |
| GET `/api/tour` | demo tour with ids resolved | | tour (WP2) |
| GET `/api/search?q=&corpus=&scope=all\|text\|titles\|works\|makers\|themes\|etymology\|annotations&f=&limit=&cursor=` | typed suggestions + KWIC + titles | ✓ | search (WP3) |
| POST `/api/expressions` · GET `/api/expressions/:id` · PATCH `/api/expressions/:id/variants` | track an expression, variants, materialization state | | expressions (WP3) |
| POST `/api/timeline/query` | register a canonical query → `queryKey`, lanes, extent, totals, seams | ✓ | timeline (WP3) |
| GET `/api/timeline/tiles?q=&tier=&tiles=` | binned cells + washes + coverage per lane/strand | ✓ | timeline (WP3) |
| GET `/api/timeline/marks?q=&from=&to=&lane=&limit=4000` | individual matches | ✓ | timeline (WP3) |
| GET `/api/timeline/arcs?q=&from=&to=&vantage=&ev=&limit=300` | arcs + bundles + hidden counts | ✓ | timeline (WP3) |
| GET `/api/timeline/shelf?q=&which=undated\|scheduled\|washes&lane=&cursor=` | shelf lists | ✓ | timeline (WP3) |
| GET `/api/timeline/bin?q=&lane=&strand=&tier=&bin=&cursor=` | bin drawer (50 KWIC rows per page) | ✓ | timeline (WP3) |
| GET `/api/passages/:id?context=1` | passage + offsets + highlights + document | | passages (WP3) |
| GET `/api/documents/:id` · GET `/api/documents/:id/text?from=&to=` | metadata, tags, dates, aliases; ≤ 20k-char slice of the original | | documents (WP3) |
| GET `/api/kwic?expr=&from=&to=&lane=&sort=date\|spread&cursor=` | concordance | ✓ | kwic (WP3) |
| GET `/api/export?view=\|state=&what=&format=` · POST `/api/snapshots` · GET `/api/snapshots/:file` | exports and snapshots | ✓ | exports (WP3) |
| POST `/api/compare` | Compare payload (§2.E) | ✓ | compare (WP4) |
| GET `/api/collocations?expr=&slice=` | collocates or gate | ✓ | collocations (WP4) |
| GET `/api/clusters?expr=&run=` | sense hypotheses, shares, transitions, gates | | clusters (WP4) |
| POST `/api/analysis/runs` · GET `/api/analysis/runs?stage=&expr=` | start/list runs (cluster, vectors, drift, tone, reuse-index) | | analysis (WP4) |
| GET `/api/constellation?…` | nodes/edges with stable positions | ✓ | constellation (WP4) |
| GET `/api/lineage?root=&depth=&dir=&max_nodes=&types=&status=&rejected=` · GET `/api/lineage/path?from=&to=` | bounded lineage graph; least-evidence-cost path | ✓ | lineage (WP5) |
| GET `/api/genealogy?work=&dir=&depth=&types=&max=&cursor=` | works-as-bars genealogy | ✓ | genealogy (WP5) |
| GET `/api/relationships/:id` · POST `/api/relationships` · POST `/api/relationships/:id/review` · POST `/api/relationships/:id/evidence` | edge card, human-proposed edges, review, attach evidence | | relationships (WP5) |
| GET `/api/hypothesis-groups/:id` · POST `/api/hypothesis-groups` | competing hypotheses | | hypotheses (WP5) |
| POST `/api/trace` | targeted quotation trace (≤ 1.5 s sync, else `{job}`) | ✓ | trace (WP5) |
| GET/POST `/api/annotations` · PATCH `/api/annotations/:id` · POST `/api/annotations/:id/reinterpret` · POST `/api/annotations/:id/withdraw` · GET `/api/annotations/:id/revisions` | notebook (append-only) | | annotations (WP5) |
| POST `/api/views` · GET `/api/views` · GET `/api/views/:slug` · DELETE `/api/views/:slug` (soft) | saved views | | views (WP5) |

### 7.2 Key shapes

```jsonc
// GET /api/health
{ "ok": true, "version": "0.1.0", "contract": "1.0.0", "dataVersion": 47, "dbBytes": 1288490188,
  "jobs": { "running": 1, "queued": 0 }, "readPool": { "size": 3, "busy": 1 },
  "adapters": { "nl": "missing" },
  "cipher": { "status": "fulltext", "phase": "B", "progress": 0.21, "message": "full text 312 / 1,516 books" } }

// GET /api/corpora
[ { "slug": "demo", "name": "Synthetic demonstration — carry the zero", "kind": "synthetic", "synthetic": true,
    "collections": [ { "slug": "demo-world", "name": "Quellhaven (synthetic)", "domain": "demo", "modality": "text",
        "unit": "tokens", "sampling": "curated", "rate_eligible": true, "docs": 188, "tokens": 64210, "works": 0,
        "undated": 1, "scheduled": 1, "span": ["c. 1894", "2026"], "selection_note": "invented corpus",
        "caveats": [], "license": "CC0 (synthetic)", "status": "ready" } ] },
  { "slug": "cipher", "name": "Cipher corpus (public-domain texts + culture metadata; no lyrics)", "kind": "real",
    "synthetic": false, "collections": [ /* … */ ] } ]

// GET /api/search?q=hackers&corpus=cipher&scope=all
{ "query": { "surface": "hackers", "norm": "hackers", "tokens": ["hackers"], "kind": "word",
             "variants": [ { "form": "hacker", "type": "inflection", "rule": "en-inflect@1", "status": "computed" } ] },
  "suggestions": [ { "type": "work", "label": "Hackers — film · 1995", "ref": "document:61234", "count": null },
                   { "type": "expression", "label": "hackers (word, en)", "ref": "expression:new", "count": 1 } ],
  "expression": null,
  "hits": { "passages": 1, "documents": 1, "undated": 0, "names_excluded": 0, "preliminary": true },
  "kwic": [], "titles": [ { "document_id": 61234, "title": "Hackers", "kind": "film", "year": 1995, "synthetic": false } ],
  "empty_note": null,
  "provenance": { "data_version": 47, "run_ids": {}, "tokenizer": "u61m-1", "segmenter": "seg-1", "synthetic": false,
                  "collections": ["cipher-culture-works"], "licenses": ["Wikidata CC0"] } }

// POST /api/expressions  { "surface": "carry the zero", "lang": "en", "kind": "phrase", "corpus": "demo" }
{ "expression": { "id": 12, "surface": "carry the zero", "norm": "carry the zero", "kind": "phrase", "lang": "en", "synthetic": true },
  "variants": [ { "id": 31, "form": "carry the zero", "type": "identity", "status": "documented", "enabled": true, "n": null },
                { "id": 32, "form": "carries the zero", "type": "inflection", "rule": "en-inflect@1", "status": "computed", "enabled": true, "n": null } ],
  "state": { "status": "materializing", "job": 301 } }

// POST /api/timeline/query
{ "strands": [ { "type": "expression", "ref": 12 } ], "corpus": "demo",
  "lanes": { "facet": "community", "order": "first_observed", "max": 10, "run": null },
  "f": "syn:1", "toggles": { "tr": 0, "ds": 0, "ap": 0, "dup": 0, "nm": 0, "est": 1, "bp": 0 },
  "timeBasis": "publication" }
// →
{ "queryKey": "9f2c41aa07b3e1d0", "dataVersion": 47, "status": "ready", "job": null,
  "units": [ { "unit": "per_million_tokens", "lanes": ["community:classroom","community:hiphop","…"] } ],
  "lanes": [ { "key": "community:classroom", "label": "Classroom", "unit": "per_million_tokens", "modality": "text",
               "order_rule": "first_observed", "coverage": { "tokens": 18230, "docs": 31, "span": [1894, 1960] },
               "n": 41, "docs": 18, "first": { "label": "1911", "precision": "year" }, "last": { "label": "1957" },
               "undated": 0, "scheduled": 0, "undated_share": 0.0, "censor": { "left": false, "right": false }, "synthetic": true } ],
  "other": { "lanes": 0, "n": 0 },
  "extent": { "from": "1894", "to": "2026" },
  "totals": { "n": 340, "dated": 337, "undated": 1, "scheduled": 0, "names_excluded": 0, "sampled": false,
              "washes_by_tier": { "L1": 0, "L2": 3, "L3": 7 } },
  "seams": [],
  "gates": { "cluster": { "gate": "ok" } },
  "provenance": { "…": "…" } }

// GET /api/timeline/tiles?q=9f2c41aa07b3e1d0&tier=L2&tiles=3
// At L2 a bin is a decade: bin = floor(year/10); tile = floor(bin/64); tile 3 = bins 192–255 = years 1920–2559.
// Cell tuple: [binIndexInTile, n, docs, authors, denom, rate, ci_lo, ci_hi, state, flags, dp]
//   state: 1 observed · 2 absent · 3 low · 4 uncovered · 5 pending
//   flags: 1 sparse(n<5) · 2 single_source · 4 estimated_majority · 8 sampled · 16 synthetic · 32 names_excluded · 64 translations_included
// Cells are sent only for bins with n > 0 or denom > 0; a bin with neither is uncovered (or pending if the
// collection is indexing). The client takes absent/low/uncovered from the cell state, never infers them.
{ "queryKey": "9f2c41aa07b3e1d0", "tier": "L2", "binWidth": 10, "dataVersion": 47,
  "tiles": [ { "tile": 3, "bin0": 192,
      "lanes": { "community:classroom": { "strands": { "12": [ [ 3, 14, 6, 4, 38120, 367.3, 200.8, 616.3, 1, 16, 0.31 ] ] } },
                 "community:hiphop":    { "strands": { "12": [ [ 7, 0, 0, 0, 52000, 0, 0, 70.9, 2, 16, null ] ] } } },
      "coverage": { "community:classroom": [ [ 2, 0, 31, 18200, 3 ], [ 3, 0, 40, 38120, 3 ] ] },  // [idx, works, docs, tokens, stepClass 0–4]
      "washes": [ { "lane": "community:classroom", "strand": 12, "lo": "1900", "hi": "1933", "precision": "range",
                    "label": "early 20th century", "n": 1 } ] } ] }   // does not fit one decade → wash, never in bins

// GET /api/timeline/marks?q=…&from=1990&to=1999&limit=4000
{ "marks": [ { "occ": 55012, "passage": 901, "doc": 44, "lane": "community:hiphop", "strand": 12,
               "lo_day": 8902, "hi_day": 8902, "precision": "day", "basis": "stated", "kind": "text",
               "name_flag": false, "synthetic": true } ],
  "truncated": false, "total": 14 }

// GET /api/timeline/arcs?q=…&from=1900&to=2030&vantage=2026&ev=documented,computed,proposed
{ "total": 44, "returned": 3, "hidden": { "budget": 0, "kindred": 0, "rejected": 1 },
  "items": [ { "rel_id": 7781, "rel_type": "explicit_citation", "family": "citation", "evidence_status": "documented",
               "provenance_quality": "complete", "review_status": "unreviewed", "cue": false,
               "src": { "passage": 901, "y": 1994, "lane": "community:hiphop" },
               "dst": { "passage": 77, "y": 1911, "lane": "community:classroom" },
               "feedback": false, "date_conflict": false, "synthetic": true },
             { "rel_id": 7802, "rel_type": "reframes", "family": "reinterpretation", "evidence_status": "documented",
               "src": { "passage": 1402, "y": 2016 }, "dst": { "passage": 77, "y": 1911 }, "feedback": true, "synthetic": true } ],
  "bundles": [] }

// GET /api/passages/901?context=1
{ "id": 901, "field": "body", "start": 2110, "end": 2394,
  "text": "…original slice…",
  "before": { "passage": 900, "text": "…" }, "after": { "passage": 902, "text": "…" },
  "highlights": [ { "start": 212, "end": 226, "expr": 12, "occ": 55012, "variant": "carry the zero" } ],   // relative to text
  "lang": "en", "quality": "ok", "time_role": "document",
  "document": { "id": 44, "title": "Zero Holds the Place", "author": "MC Ledgerline (synthetic)", "kind": "song",
    "dates": [ { "role": "publication", "label": "17 May 1994", "precision": "day", "basis": "stated", "asserted_by": "demo", "is_chronology": true } ],
    "date_card": { "label": "17 May 1994", "precision": "day", "basis": "stated", "role": "publication", "notes": [] },
    "collection": "demo-world", "license": "CC0 (synthetic)", "is_translation": false, "synthetic": true },
  "anchor": { "doc_id": 44, "sha256": "3b1f…", "field": "body", "start": 2110, "end": 2394 },
  "machine": [ { "kind": "cluster", "cluster": 41, "label": "machine label: counted · hold · ones", "margin": 0.22 } ],
  "relationships": { "out": 3, "in": 1 }, "annotations": 2, "synthetic": true }

// GET /api/lineage?root=passage:77&depth=2&dir=both&max_nodes=60
{ "root": "passage:77",
  "nodes": [ { "id": "passage:77", "doc": 12, "title": "Brennock's Ready Arithmetic", "y": 1911, "label": "1911",
               "precision": "year", "kind": "book", "generation": 0, "undated": false, "synthetic": true, "expandable": 3 },
             { "id": "shared:9f3a", "type": "commonplace", "label": "widely shared text (31 documents)" } ],
  "edges": [ { "rel_id": 7790, "src": "passage:1630", "dst": "passage:77", "rel_type": "exact_quotation", "family": "quotation",
               "evidence_status": "computed", "review_status": "unreviewed", "score": { "value": 1.0, "kind": "match_ratio" },
               "method": "winnow k=8 w=6 + seed-extend", "run_id": 9, "hypothesis_group": null, "date_conflict": false, "synthetic": true } ],
  "groups": [ { "id": 4, "question": "Where does Vyas's 2017 line come from?", "edges": [7811, 7812] } ],
  "truncated": { "nodes": 0, "reason": null } }
// GET /api/lineage/path?from=passage:2210&to=passage:77 → { "path": [ /* edges */ ], "cost": 9, "weakest": "proposed" }

// GET /api/genealogy?work=document:61002&dir=forward&depth=3&types=samples,interpolates,cover_of,remix_of,version_of
{ "seed": { "doc": 61002, "title": "…", "maker": "…", "year": 1969 },
  "generations": [ { "gen": 1, "total": 312, "returned": 150, "by_decade": { "1980": 41, "1990": 88, "2000": 63 },
      "rows": [ { "doc": 70011, "title": "…", "maker": "…", "date": { "label": "1988", "precision": "year" },
                  "edges": [ { "rel_id": 90001, "rel_type": "samples", "evidence_status": "documented",
                               "source_dataset": "musicbrainz", "locator": "https://musicbrainz.org/recording/…" } ] } ] } ],
  "truncated": { "rows": 162, "cursor": "…" }, "note": "Absence of a link is not evidence of no sampling." }

// GET /api/relationships/7811
{ "id": 7811, "rel_type": "proposed_allusion", "family": "allusion", "directed": true, "evidence_status": "proposed",
  "origin": "human", "created_by": "human:Reader A (synthetic)", "method": null, "run_id": null,
  "source_dataset": null, "source_locator": null, "provenance_quality": "complete", "review_status": "disputed",
  "score": null, "hypothesis_group": 4, "date_conflict": false, "license": null, "attribution": null,
  "src": { "ref": "passage:2210", "doc": "…", "y": 2017 }, "dst": { "ref": "passage:901", "y": 1994 },
  "evidence": [ { "id": 1, "role": "supporting", "passage": 2210, "start": 0, "end": 48, "quote": "…" } ],
  "revisions": [ { "rev": 1, "action": "create", "actor": "human:Reader A (synthetic)", "at": "…" },
                 { "rev": 2, "action": "dispute", "actor": "human:Reader B (synthetic)", "reason": "…", "annotation_id": 220 } ],
  "annotations": [ 220 ], "caution": "Shared wording or similar contexts can come from a common source; they do not establish influence or intent.",
  "synthetic": true }
// POST /api/relationships { "src":"passage:950","dst":"passage:77","rel_type":"proposed_allusion",
//   "evidence":[{"passage":950,"start":10,"end":64,"role":"supporting"}],"note":"…","group":4 }
//   → created with evidence_status "proposed", origin "human" (server-forced; never documented)
// POST /api/relationships/7781/review { "action":"confirm|reject|dispute", "note":"≥ 10 chars" }
//   → { "review_status":"confirmed", "revision":3, "annotation_id":221 }   // evidence_status unchanged

// POST /api/trace { "passage": 77, "start": 0, "end": 96 }
{ "status": "done", "exact": [ { "passage": 1630, "start": 40, "end": 112, "tokens": 13 } ],
  "near": [ { "passage": 1999, "score": 0.81, "jaccard": 0.55 } ], "similar_wording": [ ],
  "created_relationships": [ 7790 ], "note": "Cross-language reuse is not detected." }

// GET /api/constellation?strands=12&a=1955-1985&b=1994-2026&size=occurrences&edges=cooc,rel,member&max_nodes=150
{ "nodes": [ { "id": "x:12", "type": "expression", "label": "carry the zero", "size": { "a": 61, "b": 122 },
               "pos": [0.41, 0.62], "present": { "a": true, "b": true } } ],
  "edges": [ { "s": "x:12", "t": "w:uncredited", "kind": "cooc", "weight": { "a": null, "b": 9.8 }, "measure": "logDice" } ],
  "legend": { "size": "occurrences in period (area, sqrt radius)", "edge": "logDice, co-occurrence ±5 tokens" },
  "layout": { "key": "fnv:3b91c2d0", "algorithm": "fruchterman-reingold-300", "pinned": true }, "truncated": { "nodes": 38 } }

// POST /api/compare
{ "expr": [12], "a": { "years": [1955, 1985], "f": "syn:1" }, "b": { "years": [1994, 2026], "f": "syn:1" },
  "measures": ["freq","collocates","clusters","sense_share_jsd","neighbor_overlap","aligned_displacement","tone"] }
// →
{ "multiplicity": { "k": 1, "notable_so_far": 0, "threshold_percentile": 95 },
  "coverage": { "a": { "tokens": 21400, "docs": 41, "authors": 19, "translations": 0, "undated_share": 0.0,
                       "mix": { "memo": 0.6, "bulletin": 0.4 }, "modality": { "text": 1.0 } },
                "b": { "tokens": 30100, "docs": 63, "authors": 27, "mix": { "song": 0.62, "blog": 0.21, "essay": 0.17 } },
                "composition_jsd": 0.48, "caveats": ["composition"], "modality_gate": "ok",
                "prominence": { "consistent": true } },
  "freq": { "a": { "n": 61, "rate": 2850.5, "ci": [2180.2, 3661.5], "unit": "per_million_tokens", "docs": 18, "dp": 0.41 },
            "b": { "n": 122, "rate": 4053.2, "ci": [3365.4, 4840.3] }, "rate_ratio": { "value": 1.42, "ci": [1.04, 1.96] },
            "standardized": { "a": 2790.0, "b": 4011.6 } },
  "passages": { "a": [ /* 5 */ ], "b": [ /* 5 */ ], "seed": 771 },
  "collocates": { "a": [ /* {term, f_xy, logDice, g2, q} */ ], "b": [], "shared": [], "keyness": [] },
  "clusters": { "run": 14, "representation": "tfidf-hash-4096",
                "shares": [ { "cluster": 40, "label": "machine label: auditors · forms · memo",
                              "a": { "share": 0.82, "ci": [0.70, 0.91] }, "b": { "share": 0.04, "ci": [0.01, 0.09] } } ] },
  "measures": [
    { "metric": "sense_share_jsd", "gate": "ok", "value": 0.71, "ci": [0.62, 0.79], "n": [61, 122], "docs": [18, 33] },
    { "metric": "neighbor_overlap", "gate": "slice_too_small", "value": null,
      "needed": { "tokens_per_slice": 3000000 }, "have": { "a": 21400, "b": 30100 }, "suggestion": null },
    { "metric": "aligned_displacement", "gate": "slice_too_small", "value": null, "needed": { "tokens_per_slice": 3000000 },
      "have": { "a": 21400, "b": 30100 }, "suggestion": null } ],
  "tone": { "gate": "not_run", "reason": "Tone needs the optional on-device adapter (not installed)" },
  "human": { "pragmatic_function": { "a": { "ironic": 7, "sincere": 1 }, "b": { "reclaimed": 9, "ironic": 3 } } },
  "coverage_note": "The slices differ in composition (JSD 0.48): A is memos and bulletins, B is mostly song text. …",
  "provenance": { "…": "…" } }

// annotations
POST  /api/annotations { "target": { "type": "passage", "ref": "901" },
                         "anchor": { "doc_id": 44, "sha256": "3b1f…", "field": "body", "start": 2110, "end": 2394,
                                     "quote": "the ones they never counted", "prefix": "…", "suffix": "…" },
                         "kind": "interpretation", "body_md": "…", "dimensions": { "pragmatic_function": "reclaimed" },
                         "tags": ["irony"], "evidence_refs": [ { "type": "passage", "id": 77, "start": 0, "end": 60, "role": "supporting" } ],
                         "layer": "Reading B" }            → { "id": 220, "rev": 1 }
PATCH /api/annotations/220 { "body_md": "…", "reason": "found the 1995 interview" }   → { "id": 220, "rev": 2 }
POST  /api/annotations/220/reinterpret { /* new annotation body */ }                 → { "id": 231, "supersedes": 220 }
GET   /api/annotations?target=passage:901&include=superseded&as_of=2026-11-01
GET   /api/annotations/220/revisions → [ { "rev", "body_md", "dimensions", "tags", "author", "at", "reason" } ]

// saved views (immutable)
POST /api/views { "name": "carry the zero: four uses", "state": { /* ViewState §8.2 */ }, "comparisons_tried": 2 }
→ { "slug": "carry-the-zero-four-uses-3f9a", "url": "/#v=carry-the-zero-four-uses-3f9a", "dataVersion": 47,
    "runIds": { "materialize": { "12": 31 }, "cluster": 14, "quotes": 9 } }
// saving again from that view creates "carry-the-zero-four-uses-3f9a~2" (parent_slug set)
GET /api/views/carry-the-zero-four-uses-3f9a
→ { "slug": "…", "state": { }, "savedAt": "…", "dataVersion": 47, "currentDataVersion": 52,
    "drift": { "dataChanged": true, "importsSince": [ { "batch": 43, "file": "letters.csv" } ], "asSavedAvailable": true,
               "newerRuns": [ { "stage": "cluster", "run": 19 } ],
               "message": "Corpus changed since this view was saved. 'As saved' restricts to imports ≤ #42 and the pinned runs." } }

// jobs: GET /api/jobs/303/events (SSE)
event: progress
data: {"job":303,"type":"cluster","phase":"bootstrap","fraction":0.42,"message":"subsample 13/30","counts":{"k":4}}
event: done
data: {"job":303,"status":"succeeded","run_id":19}
// POST /api/jobs/303/cancel → {"status":"cancelling"}  (acknowledged ≤ 500 ms; final "cancelled" via SSE)

// GET /api/adapters
[ { "id": "stemm.openalex", "version": "1.0.0", "access": "local-dataset", "staged": { "path": "~/Developer/scrolls-data/sources/openalex",
    "manifest_ok": true, "format_ok": true, "counts": { "works": 118466, "abstracts": 60574, "citations": 381800 } },
    "license": "CC0 metadata; abstracts publishers' (local research only)", "loaded": false, "last_load": null } ]
// POST /api/adapters/stemm.openalex/load { "fields": ["Medicine","Computer Science"], "abstracts": true } → { "job": { "id": 410 } }

// GET /api/baseline?word=virus
{ "available": true, "word": "virus", "top_form": "virus", "forms": 6, "label": "Google Books Ngram, English, 2020 edition: a different corpus",
  "attribution": "Google Books Ngram Viewer (http://books.google.com/ngrams), dataset version 20200217; Michel et al. 2011; Lin et al. 2012",
  "decades": [ { "decade": 1820, "per_million": 1.07, "volumes": 31233 } ], "caveats": ["case folding merges senses"] }
// GET /api/baseline?word=carry%20the%20zero → { "available": false, "reason": "single words only" }
```

### 7.3 Exports and snapshots

`GET /api/export?view=<slug>|state=<b64url>&what=occurrences|aggregates|passages|relationships|annotations|bundle&format=json|jsonl|csv|html`

- **Manifest first** (JSON top-level object; JSONL first line; CSV `#` comment lines): `{export_version,
  generated_at, view, state, data_version, run_ids (with params), filters, toggles, synthetic_included,
  licenses[], attributions[]}`. Attributions: Wiktionary CC BY-SA; ItwoFS CC BY 2.5 (link-back per row);
  Google Books Ngram CC BY 3.0 citation; OpenAlex CC0; Gutenberg public domain (US); Wikisource CC BY-SA.
- **Rows** always carry `evidence_status`, `review_status`, `origin`, `is_synthetic`, `date_label`,
  `date_precision`, `date_basis`, `date_role`, offsets, and `source_locator` where relevant.
- Collections with `export_text_allowed=0` (OpenAlex abstracts) export ids, offsets and locators only —
  never text.
- **Portable bundle** (`what=bundle&format=html`): one self-contained `.html` file that opens offline:
  the view's SVG snapshot (from the shared display list, §8.3), the manifest, the data subset (aggregates
  + ≤ 5,000 occurrences with KWIC where text export is allowed + relationships + annotations), and ≤ 8 KB
  of inline vanilla JS that renders sortable tables, the legend and the provenance/licence panel. No live
  re-query. The client first POSTs the snapshot, then downloads the bundle.
- `POST /api/snapshots {view, png:"data:image/png;base64,…", svg:"<svg…>"}` → stored under `snapshots/`
  and in `saved_view.snapshot_svg` when for a view; PNG = composite of the canvas layers + legend +
  caption ("Scrolls · view … · data v47 · run c14 · contains SYNTHETIC data") with a SYNTHETIC stamp when
  any synthetic item is visible.

---

## 8. Frontend architecture

No build step. `server/http/static.mjs` serves `public/` at `/`, `src/ui/**` at `/ui/*` and
`src/shared/**` at `/shared/*` (the same modules the server imports). `server/**` is never served. Every
UI module exports `mount(el, ctx) → { unmount() }` with `ctx = { store, api, keys, announce }`.

### 8.1 Modules

| Area | Modules (`src/ui/…`) | Owner |
|---|---|---|
| core | `main.mjs` (boot, error boundary, health poll), `registry.mjs` (imports every module, mounts regions), `core/store.mjs`, `core/url.mjs`, `core/api.mjs` (fetch, abort-on-supersede, error mapping, SSE helper), `core/sse.mjs`, `core/dom.mjs` (`h()`, focus trap), `core/keys.mjs` (scoped key registry), `core/announce.mjs` (polite live region, ≤ 1/s) | WP0 |
| shell | `shell/layout.mjs` (desktop/narrow regions, bottom sheet), `toolbar.mjs`, `search.mjs` (typed suggestions), `filters.mjs`, `lanes-menu.mjs`, `ribbon.mjs` (SYNTHETIC ribbon), `toasts.mjs`, `help.mjs` (`?` sheet), `jobs-chip.mjs` | WP6 |
| timeline | `timeline/viewport.mjs` (state ↔ px), `scale.mjs` (linear TimeScale, ticks, labels incl. BCE), `folded.mjs` (regimes, seams), `tiers.mjs`, `tiles-client.mjs` (LRU 512, prefetch ±1 viewport, debounce 120 ms), `model.mjs` (tiles → bars, caps, censoring, washes, unit scales, occurrence override), `display.mjs` (display list), `paint.mjs` (Canvas painter, 4 layers, DPR ≤ 2), `svg.mjs` (SVG serializer of the same display list), `hit.mjs`, `input.mjs` (pointer/wheel/keys → actions), `gestures.mjs` (touch), `playhead.mjs` (vantage, play loop, reduced motion), `arcs.mjs` (geometry, bundling, feedback-below routing), `shelves.mjs`, `seams.mjs` (modality seam), `minimap.mjs`, `coverage.mjs`, `legend.mjs`, `a11y-table.mjs`, `drawer.mjs` (bin drawer), `snapshot.mjs` (PNG composite + SVG), `perf.mjs` (`?perf=1` HUD) | WP6 |
| tour | `tour/tour.mjs`, `tour/coachmarks.mjs` | WP6 |
| panels | `panels/inspector.mjs` (Then/Now/Next), `passage-card.mjs`, `reader.mjs` (virtualized document reader), `date-chip.mjs`, `crossings.mjs`, `compare.mjs`, `gate-card.mjs`, `lineage.mjs`, `genealogy.mjs`, `constellation.mjs`, `layout.worker.mjs` (client relayout for expansions > 300 nodes), `edge-card.mjs`, `notebook.mjs`, `annotation-editor.mjs`, `revisions.mjs`, `views-menu.mjs`, `export-menu.mjs`, `jobs-tray.mjs`, `adapters.mjs` | WP7 |
| import | `import/wizard.mjs`, `mapping-table.mjs`, `summary.mjs` | WP1 |

Shared (`src/shared/`, WP0): `contracts.mjs`, `vocab.mjs`, `dates.mjs`, `tokenize.mjs`, `ids.mjs`,
`viewstate.mjs`, `format.mjs`, `evidence-style.mjs` — the **only** place evidence → style mapping exists;
timeline, lineage, genealogy, constellation, legend, SVG and PNG all import it.

### 8.2 State model and reproducible URL (`src/shared/viewstate.mjs`)

```js
ViewState = { v: 1,
  corpus: 'demo',
  strands: [ { type: 'expression', id: 12, variants: 'default', glyph: 'circle' } ],   // ≤ 4 expression strands
  lanes: { facet: 'community', sub: null, run: null, order: 'first_observed', manual: [], max: 10 },
  f: { lang: [], kind: [], coll: [], culture: [], field: [], community: [], basis: [], syn: 1 },
  toggles: { tr: 0, ds: 0, ap: 0, dup: 0, nm: 0, est: 1, bp: 0 },
  timeBasis: 'publication',                                   // | 'referenced'
  axis: { mode: 'linear', centerDay: -1234, daysPerPx: 9.1, keepLinear: false },   // | { mode: 'folded' }
  tier: 'auto',
  vantage: { day: 9861, strict: true },
  range: null,                                                 // [loDay, hiDay]
  evidence: { documented: 1, computed: 1, proposed: 1, rejected: 0, kindred: 0 },
  layers: { arcs: 1, feedback: 1, washes: 1, coverage: 1, etymology: 1, claims: 1, baseline: 0, variety: 0, tone: 0, superseded: 0 },
  selection: null,                                             // { type: 'occurrence'|'passage'|'cluster'|'relationship'|'document'|'bin', id }
  panels: { inspector: 'tnn', right: null },                   // right: lineage|genealogy|constellation|compare|notebook|import|adapters
  compare: null,                                               // { a: { years: [1955,1985], f: '' }, b: { … } }
  constellation: { layoutKey: null, size: 'occurrences', a: null, b: null },
  lineage: { root: null, depth: 2, types: [], status: [] },
  runs: { materialize: { 12: 31 }, cluster: 14, quotes: 9, vectors: null },
  asSaved: false, reducedMotion: 'system' }
```

**URL** (hash, readable, versioned, canonical key order, defaults omitted; written with `replaceState`
debounced 250 ms, `pushState` for selection/panel changes):
`#v=1&c=demo&s=e12&l=community:fo&f=syn:1&tg=tr0.ds0.ap0.dup0.nm0.est1.bp0&x=lin:-1234:9.1&t=9861s&ev=dcp&sel=occ:55012&p=tnn&cmp=1955-1985~1994-2026&r=c14.q9`.
A saved view is `#view=<slug>` (`&as=1` = "as saved": imports ≤ cutoff, pinned runs, annotation and
relationship revisions ≤ cutoffs). `decode(encode(s))` deep-equals `canonicalize(s)` (test).
`localStorage` (try/catch, per-viewer convenience only): last view hash, tour dismissed, reduced motion.

### 8.3 Canvas timeline rendering

- **Pipeline:** `tiles → model.mjs → display.mjs` produces a **display list** of primitives
  `{id, kind:'rect'|'tick'|'diamond'|'path'|'text'|'glyph'|'band'|'wash', x0,y0,x1,y1|points, style:
  token, openable:bool, ref}` with stable ids → `paint.mjs` (screen) or `svg.mjs` (snapshot/bundle). The
  snapshot is guaranteed to match the screen.
- **Layers:** `bg` (banding, hatches, period bands, coverage, seams) · `data` (bars, washes, marks,
  caps, glyphs) · `arcs` · `overlay` (playhead, hover, selection, brush, focus ring; redrawn every pointer
  frame). Lane labels, shelves, legend and coach marks are DOM.
- **Pan:** `bg` and `data` render into a 3× viewport-width backing canvas; panning blits with an offset
  and re-renders only the exposed strip; zoom re-renders. Typed arrays (`Float32Array` columns per lane:
  x0, x1, h, state, flags) are built once per (tier, viewport) change, never per frame. Hatch patterns are
  `CanvasPattern`s created once; arcs batched by dash pattern; one `fillRect` pass per fill style.
- **Level change:** the previous tier stays drawn (dimmed 40%) until new tiles arrive; never interpolated.
- **Budgets** (1440×900 @2× on an M-class Mac; `?perf=1` HUD logs p50/p95):

  | Item | Budget |
  |---|---|
  | data/arcs redraw during pan/zoom | ≤ 8 ms p95 |
  | overlay redraw | ≤ 2 ms |
  | rects + ticks per frame | ≤ 20,000 (individual occurrence marks ≤ 4,000; arcs ≤ 300; `fillText` ≤ 150) |
  | first meaningful paint, demo | ≤ 1.2 s after load |
  | cached tile → paint | ≤ 50 ms |
  | main-thread long tasks | none > 50 ms |
  | JS shipped | ≤ 400 KB unminified |

  If a frame's display list exceeds a budget, `display.mjs` steps to the next coarser tier and shows a
  `simplified` badge with the reason.

### 8.4 Hit-testing

A uniform 24 px spatial grid in content coordinates is built from the display list after layout or zoom
(never on pan; the pan offset is subtracted at query time). Entries `{id, kind, bbox, ref}`; arcs sampled
into 16 points, tolerance 5 px (touch 12 px). Priority on overlap: mark > arc > cap/fork > bin > wash >
band. Hover resolves ≤ 1 ms, at most once per animation frame. **Every primitive with `openable:true` has
a hit entry whose ref resolves through `/api/passages/:id` or a bin-drawer page** (test).

### 8.5 Keyboard map (scoped; `?` shows it)

| Key | Action | Key | Action |
|---|---|---|---|
| `/` | focus search | `Space` | play / pause |
| `[` `]` | vantage −/+ 1 bin | `{` `}` | vantage −/+ 10 bins |
| `←` `→` | pan 10% (`Shift` 50%); in the marks region: previous/next mark | `↑` `↓` | lane focus |
| `+`/`=` `-` | zoom at the playhead (or focused mark) | `0` | fit data |
| `1`–`6` | jump to tier L0–L5 | `D` | folded deep-time overview ↔ linear |
| `Home` / `End` | first / last observation in the focused lane | `Tab` / `Shift+Tab` | next / previous control in reading order: toolbar (left to right), minimap, lanes, marks, inspector (fix pass: DOM order = visual order) |
| `Enter` | open the focused mark / bin | `Esc` | close panel, clear selection, dismiss coach mark |
| `L` | cycle lane facet | `E` | evidence filter: all → documented+computed → documented |
| `V` | vantage strict ↔ context | `R` | reduced motion |
| `T` | table alternative | `P` | pin the searched expression as a strand |
| `A` / `B` | set Compare slice A / B from the range | `C` | Compare |
| `G` | Lineage of the selection (works: Genealogy) | `K` | Constellation |
| `N` | annotate the selection (Notebook) | `S` | save view |
| `X` | export menu | `?` | shortcut sheet |

Shift-drag on the ruler or coverage track selects a range.

### 8.6 Touch, narrow viewports, accessibility

- **Touch** (Pointer Events): one-finger horizontal drag pans (inertia off in reduced motion); vertical
  one-finger drag scrolls lanes; pinch zooms x only around the midpoint; tap selects; long-press 500 ms
  opens an action sheet (open, annotate, lineage, compare, pin); double-tap zooms in one tier; two-finger
  tap zooms out; playhead handle 44×44 px.
- **Narrow (< 720 px):** timeline in the top 55vh with ≤ 5 lanes (+ "more lanes" sheet); UNDATED shelf
  → chip `⊘ 4`, SCHEDULED → chip; minimap stays (20 px); inspector = bottom sheet (snap 30% / 60% /
  92%) with Then/Now/Next tabs; toolbar → bottom bar (Search · Play · Lanes · Filters · More); Lineage,
  Genealogy, Constellation, Compare and Notebook are full-screen sheets with a back button; Compare stacks
  A over B; legend → a "Legend" chip that opens the full legend. **The main flow (search → timeline →
  passage → compare → save) works without hover.**
- **Accessibility:** all text tokens meet WCAG AA on their backgrounds (§8.7; `--ink-3` only on
  `--bg-0`/`--bg-1` and ≥ 12 px); focus ring 2 px cyan + 2 px `--bg-0` offset; canvases have `role="img"`
  and `aria-describedby` a generated summary (*"Lane Classroom · text: 'carry the zero' observed 1905–1939
  and 1950–1960 in 2 bars; gap 1940–1949: no sources (archive gap, synthetic)."*); **`T` table
  alternative** = an accessible `<table>` per lane (bin, n, rate, CI, coverage, state, flags) plus a
  segment list, built from the **same typed arrays** the renderer uses (identity test); marks get roving
  focus through DOM proxies in the marks region; `forced-colors` swaps patterns to system colours (the
  evidence encoding never relies on colour); reduced motion honoured (§1.9).

### 8.7 Colour tokens and the evidence encoding (`public/styles/tokens.css`, `src/shared/evidence-style.mjs`)

```css
:root {
  --bg-0:#0E1013;  /* deep charcoal canvas */      --bg-1:#161A20; /* panels */
  --bg-2:#1F242C;  /* raised, popovers */          --bg-3:#2A303A; /* hover */
  --rule:#343A45;                                     /* non-text rules, lane banding edges */
  --ink:#EDE6D6;   /* warm ivory text, bars  15.3:1 on bg-0 */
  --ink-2:#BDB5A5; /* secondary text  9.4:1 */
  --ink-3:#8E887B; /* meta text 5.4:1 on bg-0, 4.95 on bg-1 — never on bg-2/bg-3 */
  --cyan:#4FD8E8;  /* selection & navigation: playhead, focus, selected marks, range, minimap bracket  11.2:1 */
  --amber:#E8A84A; /* historical reference: arcs to earlier material, THEN, deep-time bands, CUE  9.2:1 */
  --violet:#B59AF5;/* reinterpretation: feedback arcs, NOW, re-read halo, hypotheses  8.1:1 */
  --danger:#F2826F;/* date conflicts, errors, rejected  7.4:1 */
  --ok:#7BD389;    /* job success only */
  --syn:#D9CFB8;   /* SYNTHETIC ribbon/badges text 12.3:1 (deliberately not a semantic hue) */
  --syn-stripe: repeating-linear-gradient(135deg, rgba(217,207,184,.16) 0 3px, transparent 3px 8px);
  --hatch-none: repeating-linear-gradient(45deg, rgba(237,230,214,.10) 0 1px, transparent 1px 6px);
  --radius:6px; --gap:8px; --lane-h:40px; --slot-h:24px; --header-w:168px; --shelf-w:88px;
  --font-ui: system-ui, -apple-system, "SF Pro Text", "Segoe UI", sans-serif;
  --font-text: ui-serif, "New York", "Iowan Old Style", Georgia, "Noto Serif Devanagari", "Noto Serif Gujarati", serif;
  --font-num: ui-monospace, "SF Mono", Menlo, monospace;
}
body { background: var(--bg-0); color: var(--ink); font: 13px/1.45 var(--font-ui); }
```

Dark only (the brief asks for a dark observatory). Cyan, amber and violet differ in hue but only 1.1–1.2:1
in luminance from each other, so **hue is always backed by pattern and text**. Bars and marks are ivory;
hue is reserved for roles.

| Evidence status | Line | Endpoint | Badge (cards, legend, SVG) |
|---|---|---|---|
| documented | solid 1.5 px | filled dot ● | `DOC` + source name + locator; `DOC*` "source not recorded" when `provenance_quality='source_unrecorded'` |
| computed | dashed 6/4, 1.5 px | hollow square □ | `CALC` + method + run |
| proposed | dotted 1/3, 1.5 px | `?` | `PROP` + by whom; `PROP · CUE` when a `citation_cue` evidence row exists (quoted cue shown) |

| Overlay (independent of status) | Encoding |
|---|---|
| human-created | ✎ badge |
| review: confirmed / rejected / disputed | ✓ pin at the midpoint / ✕ + strike-through (hidden by default; 30% when shown) / ⚖ glyph — **the line pattern never changes** |
| synthetic | `--syn-stripe` overlay + `SYN` chip; dashed outer frame on panels showing synthetic material |
| date conflict | `--danger` dotted stub + ⚠ |
| role hue | amber = quotation, citation, sample, adaptation, descent (reference to earlier material); violet = parody, recontextualization, answer, reframes, hypotheses; ivory-2 = similarity, kindred, counterpart; cyan = current selection only |

A unit test asserts the three statuses produce three distinct (dash, endpoint, badge) triples and that no
two styles differ only in hue.

### 8.8 Empty, loading, error and low-evidence states

- **Empty search** (computed, never hard-coded): *"No occurrences of 'hacker' in the loaded corpus (68M
  tokens of full text to 1928; 94,385 titles). With the plural variant: 1 title — Hackers (film, 1995).
  0 is an observation about this index, not about culture."* + suggestions: variants, the etymology
  entry or "no family in roots data", STEMM adapters not yet loaded.
- **Loading:** lane skeleton + "counting… 41%" from SSE — **never a spinner without a number**; text lanes
  of collections still indexing show the `pending` pattern and "indexing — not yet looked".
- **Error:** server `message` + `hint` + Retry; QUERY_TIMEOUT suggests narrowing the range.
- **Low evidence:** gate cards (§2.E, §4.11) — never a numeral for a gated measure.

---

## 9. Demonstration corpus — "carry the zero" (all SYNTHETIC)

### 9.1 Labelling and shape

- Corpus `demo` (`kind='synthetic'`, `is_synthetic=1` on every row it creates — enforced by DocumentWriter
  and the corpus CHECK). One collection `demo-world` "Quellhaven (synthetic)", unit tokens, sampling
  `curated`, **coverage gate 2,000 tokens** (the legend says "demo setting; real collections use 50,000").
- Everything is invented: the city of Quellhaven, people, works, dates, passages, links, liner notes and
  annotations. Author names carry the suffix "(synthetic)" in every rendering, copy and export; the
  striped `SYNTHETIC DEMONSTRATION CORPUS` ribbon stays visible while any demo collection is in scope;
  panels showing demo material get a dashed outer frame; PNG snapshots get a SYNTHETIC stamp; exports a
  header warning and an `is_synthetic` column. The verse lines are written here, so the demo can show
  rap text **only because it is synthetic**; real Cipher songs stay metadata-only. The phrase "carry the
  zero" exists in real English (and as real song titles); its *history* here is invented.
- **Name collision rule:** every synthetic person, group, institution, place and work title is checked
  (folded) against the 94,385 culture-works titles/native titles/makers, the 3.0M MusicBrainz artist names
  and the 40.4M recording titles (`scripts/check-demo-names.mjs`, test `demo-names.test.mjs`). All names
  below passed on 2026-10-03; the candidates *Carry the Zero*, *Remainder*, *Uncredited*, *Placeholder*,
  *KLN* collided and were renamed.
- Files (WP2): `data/demo/anchors.jsonl` (hand-authored anchor documents, text below),
  `data/demo/generator.mjs` (seeded background generator), `data/demo/documents.jsonl` (anchors +
  generated, committed, regenerated by `scripts/build-demo.mjs`), `relationships.jsonl`,
  `annotations.jsonl`, `tour.json`, `README.md`. Loaded through the **ordinary import path**
  (`demo-load` task → DocumentWriter), then `reuse-index` and `cluster` runs execute on it at first boot so
  every computed element in the tour is produced by the real pipeline, not authored.
- **Size:** 31 anchor documents + 160 generated documents ≈ 191 documents, ≈ 1,300 passages, ≈ 64k
  tokens; languages en, es, gu, hi; dates 1894 … 2026 + 1 undated + 1 scheduled (2027).
- **Built-in test conditions:** a no-sources gap **1940–1949** in every lane (caveat: "the Quellhaven
  Board of Schools archive was 'lost in the 1951 flood' — synthetic"); a looked-and-found-none stretch
  **1984–1993** in the Hip-hop lane (12 zine/flyer documents, ≈ 9k tokens, no *carry the zero*); every
  date precision (day, month, year, decade, circa, early-20th-century range, Vikram Samvat, undated,
  scheduled); a translation variant; a referenced date.

### 9.2 Synthetic cast (four generations)

| Gen | Person / body (synthetic) | Community lane | Role |
|---|---|---|---|
| 0 | Quellhaven Potters' Union | Workshop & Radio | marks notice, c. 1894 |
| 0 | Tobias Wrexley (1861–1929) | Literature | novelist |
| 0 | Ada Brennock (1868–1940) | Classroom | teacher, primer author |
| 0 | Ratilal Mandaviwala (1879–1951) | Gujarati verse & school | Gujarati primer author |
| 0 | J. R. Ostlund (1880–1957) | Workshop & Radio | metallurgist |
| 1 | Harlan Edevane (1899–1971) | Workshop & Radio | radio engineer |
| 1 | Quellhaven Board of Schools | Classroom | educational records |
| 1 | Dr Ilse Varnhagen, Felmark Aeronautical Laboratory | Office & Lab | memo writer |
| 1 | Felmark *Bulletin* (staff) | Office & Lab | in-house bulletin |
| 1 | Wren Abernathy (1938–2011) | Office & Lab | programmer |
| 2 | Kilnmark Crew | Hip-hop | graffiti crew, zine *Kilnmark Notes* |
| 2 | MC Ledgerline (Dario Quell, b. 1972) | Hip-hop | rapper, album *Nothing Holds the Place* |
| 2 | Pim Ostrowe | Criticism | critic, *Signal & Noise Quarterly* |
| 2 | Lu Varga-Pinto | Hip-hop | rapper |
| 3 | Kestrel Nine (duo) | Hip-hop | rappers |
| 3 | Sol Etxeberria-Lund | Hip-hop (en/es) | rapper |
| 3 | Quellhaven Boards (forum) | Criticism | fan forum |
| 3 | Lowmere General Hospital | Hospital | newsletter |
| 3 | Priya Lindqvist-Rao | Criticism | essayist |
| 3 | MC Taru Vyas | Gujarati verse & school | Gujarati rapper |
| 3 | Rehan Qadri-Mehta | Hindi verse | Hindi poet-rapper |
| 3 | Nell Ifeoma-Strand | Software | data engineer, blogger |
| — | Reader A (synthetic), Reader B (synthetic) | — | annotators with competing readings |

### 9.3 Anchor documents (exact key lines; generated passages surround them)

| # | Document (synthetic) | Date (as written → precision · basis) | Lang | Key line(s) |
|---|---|---|---|---|
| A1 | Quellhaven Potters' Union, *On Marks* (notice) | "c. 1894" → range 1889–1899 · estimated | en | "A ◉ kiln eye pressed in the foot means the pot was fired true." |
| A2 | Anonymous broadside, *Rules of the Ledger Room* | "early 20th century" → 1900–1933 · stated | en | "Every figure carried, every zero kept." |
| A3 | Wrexley, *The Ledger House* (novel) | 1903 · year | en | "There is a ghost in the margin of every ledger, and it is always owed." |
| A4 | Brennock, *Brennock's Ready Arithmetic* | 1911 · year | en | "Carry the zero, children: it holds the place where nothing is, so that something can be counted." |
| A5 | Ostlund, *Handbook of Joining Metals* | 1922 · year | en | "Flux up the joint before the heat, or the seam will starve." |
| A6 | Mandaviwala, *ગણિત પોથી* (Ganit Pothi) | "સંવત ૧૯૮૭" → 1930–1931 · derived (Vikram Samvat) | gu | "શૂન્ય ઉપાડો, બાળકો — એ ખાલી જગ્યા સાચવે છે." |
| A7 | Workshop union newsletter | "1930s" → decade · stated | en | "flux up and hold the bead" |
| A8 | Edevane, *Field Manual for Wireless Operators* | 1936 · year | en | "When the trace closes into the kiln eye — as the potters called their mark — the signal is locked." (bibliography lists A1) |
| A9 | Board of Schools, *Counting Lesson No. 4* (educational record, transcript) | 1952 · year | en | narration: "Carry the zero. It holds the place where nothing is." |
| A10 | Varnhagen, memo | 1958-03-14 · day | en | "Half this department is carrying zeros for the auditors." |
| A11 | Felmark *Bulletin* | 1963-06 · month | en | "Carry the zero: it holds the place where nothing is, so that something can be counted — and file the form in triplicate." (13-token exact run with A4) |
| A12 | Ostlund (rev.), *Electronics Bench Manual* | 1966 · year | en | "flux up the pads before you seat the part" |
| A13 | Abernathy, lab notebook | 1971-08-02 · day | en | "Bit 7 flips on the third pass — as Wrexley put it, a ghost in the margin." (cue → proposed citation of A3) |
| A14 | Kilnmark Crew, *Kilnmark Notes* #3 (zine) | 1986-07 · month | en | "the ◉ kiln eye on the wall means we've been through the fire" |
| A15 | MC Ledgerline, "Zero Holds the Place", album *Nothing Holds the Place* | 1994-05-17 · day | en | verse: "the ones they never counted hold the place for the number / carry the zero, carry the block, carry my name"; liner note record: "for Mrs Brennock's book"; "contains a sample of *Counting Lesson No. 4*"; referenced date 1911 |
| A16 | Ostrowe, review in *Signal & Noise Quarterly* | 1995-02 · month | en | "'Carry the zero' sneers at every schoolroom that ever bored him." |
| A17 | MC Ledgerline, interview | 1995-04 · month | en | "It's a thank-you note, not a sneer. The zero is us." |
| A18 | Varga-Pinto, "Flux Up" | 1997 · year | en | "flux up with the block till the room holds" |
| A19 | Kestrel Nine, "Sneer or Prayer" | 2003 · year | en | "carry the zero — call it a sneer, call it a prayer" |
| A20 | Etxeberria-Lund, "Margin Ghosts (Fantasma)" | 2008 · year | en/es | "There is a ghost in the margin of every ledger, and it is always owed — fantasma en el margen, el escritor que nunca pagaron." (15-token exact run with A3) |
| A21 | Quellhaven Boards, thread "Is it mocking teachers?" | 2011-11-03 · day | en | "the argument over whether it mocks teachers is half the song now" |
| A22 | Lowmere General Hospital newsletter | 2013-02 · month | en | "the ◉ sticker means sterilized, through the fire" |
| A23 | Startup memo | 2014 · year | en | "flux up the two teams before the launch" |
| A24 | Lindqvist-Rao, "Ledgers of the Uncounted" (essay) | 2016 · year | en | "From the ghost in the margin to whoever carries the zero, the culture runs on uncredited labor. After Ledgerline, Brennock's primer reads as a lesson about who gets counted." (bibliography: A3, A4, A15) |
| A25 | MC Taru Vyas, verse | 2017 · year | gu | "શૂન્ય ઉપાડી ચાલ — જેને કોઈ ગણતું નથી એ જ જગ્યા રાખે છે" |
| A26 | Qadri-Mehta, verse | 2018 · year | hi | "शून्य को साथ ले चल, जिसे कोई नहीं गिनता वही जगह रखता है" |
| A27 | Ifeoma-Strand, blog "Nulls that hold the place" | 2019-09-30 · day | en | "Carry the zero: never drop a null that holds a place in the schema." |
| A28 | Fan post | 2022 · year | en | "◉ means survived" |
| A29 | MC Ledgerline, interview | 2024-03-09 · day | en | "Both readings are in the song now." |
| A30 | Kilnmark Crew flyer | "n.d." → undated | en | "◉ all city" (UNDATED shelf) |
| A31 | *Nothing Holds the Place* (30th Anniversary Reissue) notice | 2027 · year · announced | en | SCHEDULED shelf |

### 9.4 The seven phenomena

| # | Phenomenon | Expression | Evidence chain in the corpus | What the user sees |
|---|---|---|---|---|
| P1 | sincere → ironic | *carry the zero* | A4 1911 sincere → A10 1958 / A11 1963 bureaucratic irony; A11→A4 `exact_quotation` **computed** (13 tokens, found by the real reuse-index run) | sense lanes: "column · digit · place" → new group "auditors · forms · memo"; ⑂ split (dashed, computed); human `pragmatic_function` counts sincere → ironic |
| P2 | ironic → reclaimed sincerely | *carry the zero* | A15 1994 + liner-note `explicit_citation` A15→A4 **documented (synthetic record)**; `samples` A15→A9 **documented**; A24 2016 `reframes` A24→A4 **documented** | Hip-hop lane opens 1994 with "counted · hold · ones"; solid amber arc to 1911; violet feedback arc **below**, 2016 → 1911, and a violet halo on A4 once the vantage passes 2016 |
| P3 | a symbol across communities | ◉ *kiln eye* (symbol + variant phrase) | potters c.1894 → radio 1936 (`explicit_citation` A8→A1 **documented** via bibliography) → graffiti 1986 → hospital 2013 → fans 2022 → undated flyer | 5 community lanes but only **one** documented arc; Reader A's `proposed_allusion` A22→A14 is **rejected** by Reader B ("hospital usage comes from autoclave tape; no link to graffiti") — "similarity is not ancestry" |
| P4 | a remembered reference in a new context | *ghost in the margin* | A3 1903 → A13 1971 cue "as Wrexley put it" → `explicit_citation` **proposed + CUE** (Reader A confirms, Reader B rejects → ⚖ **disputed**) → A20 2008 verbatim `exact_quotation` **computed** (15 tokens), re-aimed at ghostwriting | three lanes (Literature → Office & Lab → Hip-hop), arcs of two evidence classes, review overlay never changes the line style |
| P5 | a term splitting | *flux up* | metallurgy 1922 → solder 1966 → crew bonding 1997 → merging teams 2014 | lanes = sense: 1 trunk splitting into 4 groups (stability shown; one may be "tentative") |
| P6 | two expressions converging | *carry the zero* + *ghost in the margin* | after 2008 both acquire {uncredited, unpaid, credit, writer, names, labor}; A24 cites both (**documented**) | ⑃ convergence glyph (J 0.02 → 0.31, CI excludes 0); in Constellation 1990–2005 vs 2010–2026 positions stay fixed while "uncredited" appears between them in B |
| P7 | a disagreement becoming inherited meaning | *carry the zero* | A16 review vs A17 interview (`answer_to` A17→A16 **documented**) → A19 2003 "sneer… prayer" → A21 2011 forum → A29 2024 interview | Notebook: Reader A ("mockery of schooling", rev 1 → rev 2 "ironic distance from schooling") vs Reader B ("tribute — the zero is the uncounted"); hypothesis group "Is Vyas 2017 from Ledgerline 1994 or from Mandaviwala's primer (VS 1987)?" with two `proposed_allusion` edges (⚖ 2 competing); later uses collocate with "sneer / prayer" |

**Demo annotations** (`annotations.jsonl`, all by "Reader A (synthetic)" / "Reader B (synthetic)"): 18
`pragmatic_function` labels across periods (1911 sincere ×2; 1958–1963 ironic ×6; 1994–2003 reclaimed ×4,
ironic ×2; 2011–2024 reclaimed ×3, contested ×1); A1 (Reader A, 2 revisions) and A2 (Reader B) on A15;
Reader B's `interpretation` on A4 with `reframes_target=true`; a `hypothesis` card in Next by Reader A:
*"By 2035 'carry the zero' may be mainly a data-engineering term outside hip-hop."*; a cluster `label`
rename "counted · hold · ones" → "honoring the uncounted" (machine label preserved); the review actions
of P3 and P4.

### 9.5 Background generator (`data/demo/generator.mjs`, deterministic)

`mulberry32(1994)`; per (community, decade) cell of the plan below it emits documents of 4–12 passages,
each 40–90 tokens of 6–9 sentences from per-community templates (subject · verb · object · setting) and
neutral filler; a target-bearing passage inserts the expression with 3–6 words from the **sense pool**
within ±10 tokens. Every generated document has `meta.generator = "demo-gen@1 seed 1994"` and title
"(generated background) …". Output is committed; tests assert exact counts.

| Expression · sense | Lane | Years | Occurrences | Docs | Authors | Sense pool (context words) |
|---|---|---|---|---|---|---|
| carry the zero · place value | Classroom | 1905–1939, 1950–1960 | 90 | 24 | 12 | column, digit, place, tens, units, sum, slate, lesson, children, ones, write, add |
| carry the zero · bureaucratic irony | Office & Lab | 1955–1985 | 70 | 18 | 9 | auditors, forms, memo, triplicate, ledger, quota, department, file, clerk, budget, report |
| carry the zero · honoring the uncounted | Hip-hop | 1994–2026 | 110 | 30 | 16 | counted, ones, hold, block, verse, mic, names, nobody, crew, beat; after 2008 also uncredited, unpaid, credit, labor |
| carry the zero · null placeholder | Software | 2012–2026 | 70 | 20 | 11 | null, schema, column, pipeline, field, migrate, record, drop, table, join |
| flux up · metallurgy | Workshop & Radio | 1918–1940 | 30 | 8 | 5 | joint, seam, heat, bead, iron, solder, starve, weld |
| flux up · electronics | Workshop & Radio | 1955–1980 | 30 | 8 | 5 | pads, board, part, iron, tin, lead, bench |
| flux up · crew bonding | Hip-hop | 1995–2026 | 30 | 9 | 6 | block, room, crew, hold, floor, together, heat |
| flux up · merging teams | Software | 2012–2026 | 30 | 8 | 5 | teams, launch, merge, org, roadmap, standup |
| ghost in the margin · ledgers | Literature | 1903–1939 | 20 | 6 | 4 | ledger, owed, clerk, ink, debt, account |
| ghost in the margin · bit flips | Office & Lab | 1965–1999 | 35 | 10 | 6 | bit, flips, pass, register, debug, core, tape |
| ghost in the margin · ghostwriting | Hip-hop + Criticism | 2000–2026 | 35 | 11 | 8 | writer, credit, uncredited, unpaid, verse, name, labor |
| ◉ kiln eye | 5 lanes | c.1894–2022 | 26 | 9 | 7 | (anchors only + 6 generated mentions) |
| gu/hi translation forms (`શૂન્ય ઉપાડ…`, `शून्य को साथ…`) | Gujarati / Hindi verse | 1930–2018 | 14 / 8 | 6 / 4 | 4 / 3 | ગણિત, જગ્યા, ગણતું / गिनती, जगह, साथ |
| background only (no targets) | all lanes | 1894–2026 except 1940–1949 | — | 60 | 40 | community vocabulary |

### 9.6 Calibration the tests assert (`tests/demo.test.mjs`)

- *carry the zero* (en, default variants): **n = 340** (+ anchors counted in), ≥ 90 documents; clustering
  with `tfidf-hash-4096` → k = 4, ARI ≥ 0.8 against the planted senses, stability ≥ 0.6 for every group.
- *flux up*: 120 + anchors, k = 4, ARI ≥ 0.7.
- Reuse index finds A11→A4 (13-token exact) and A20→A3 (15-token exact) as `computed` and creates **no
  documented** relationship.
- Cue detection produces A13→A3 `explicit_citation` with `evidence_status='proposed'` and a
  `citation_cue` evidence row.
- Compare *carry the zero* 1955–1985 vs 1994–2026: `sense_share_jsd` gate `ok`; `aligned_displacement`
  gate `slice_too_small`, `value=null`.
- Compare ◉ *kiln eye* 1890–1950 vs 1980–2026: gate `insufficient_occurrences`, `suggestion=null`, note
  "no widening inside this corpus reaches the gate".
- Convergence of *carry the zero* + *ghost in the margin* between windows 1990–2005 and 2010–2026: J
  rises ≥ 0.15 and the CI excludes 0.
- Every demo row `is_synthetic=1`; every demo API object `synthetic:true`; no demo name collides (§9.1).

### 9.7 Guided tour (`data/demo/tour.json`, served by `/api/tour`; 10 steps ≈ 4 minutes; steps 1–3 are the first 60 seconds)

| # | User action | What they see | What they learn |
|---|---|---|---|
| 1 | Opens the app | *carry the zero*, lanes = community, SYNTHETIC ribbon; hovering 1940–49 shows hatched "no sources (archive gap — synthetic)"; the 1980s Hip-hop bin shows a dotted baseline "0 in 6.2k tokens — looked, found none" | Bars are observations; absence has two kinds. |
| 2 | Clicks the 1994 Hip-hop mark | Inspector: highlighted span at its offsets, `SYN`, date chip "17 May 1994 · stated · day", "refers to 1911" chip | Every mark opens its passage. |
| 3 | Clicks the amber arc to 1911, then the dashed arc 1963→1911; presses `E` twice | `DOC` (synthetic liner record) vs `CALC` (13 shared tokens, run #9); with "documented only" the computed arc disappears | Evidence status is visible and filterable. |
| 4 | Presses ▶ (Step ▸ in reduced motion) | Vantage 1925 → 2026; pauses over the 1940s gap; at 2016 the 1911 primer gains a violet halo and a feedback arc appears below the lanes | Later works change how earlier ones are read — only where a documented or annotated link says so. |
| 5 | `L` → lanes = sense | 4 context groups with machine labels, ⑂ dashed splits, stability, "representation: tfidf-hash-4096"; renames one group (label annotation) | Groups are computed hypotheses with editable labels. |
| 6 | Selects A15, reads Then/Now/Next | Then = 1911 primer + 1958 memo (contemporaries with denominators); Now = 1994; Next = 2003, 2016, 2017 + Reader A's hypothesis card | Temporal layering without mind-reading. |
| 7 | Presses `A`/`B` on 1955–1985 and 1994–2026, then `C` | Coverage first (composition JSD 0.48 caveat), frequency with CIs, context shares with CIs (passes), displacement **refused** ("slices are 21k and 30k tokens; spaces need 3M") | The app computes what the evidence supports and refuses the rest. |
| 8 | Searches ◉, compares 1890–1950 vs 1980–2026 | Gate card: "A has 7 occurrences in 2 documents, B 15 in 5; context-share shift needs ≥ 50 per slice. No widening inside this corpus reaches the gate (◉ has 26 matches in all)." Frequency and KWIC still show. Lineage shows one `DOC` arc and Reader A's rejected allusion (struck, "show rejected") | Similarity is not ancestry; gates explain themselves. |
| 9 | Opens *ghost in the margin* lineage (`G`), then the Notebook (`N`) on A15, then `S` | ⚖ disputed cue citation (A13), the Vyas hypothesis group, chain strength "weakest link: PROPOSED"; Reader A vs Reader B layers with revision diff; saved view slug copied | Disagreement is preserved; views are reproducible. |
| 10 | "Now try real data" → **Cipher** → `zero` (or `virus`) | Real roots.tsv band *Sanskrit śūnyá 'blank' — period, not date*; hi/gu Wikisource lanes; 31 culture titles with *zero* (per 1,000 works); the **1928 modality seam** | The same honesty on his own corpus. |

---

## 10. STEMM integration

### 10.1 Source-adapter interface (`server/adapters/api.mjs`, frozen in WP0)

Every source — Cipher, STEMM, demo — is one adapter module; a new source is one file plus its entry in
`server/adapters/registry.mjs`; **nothing in the core changes**. Adapters never write SQL: the
`adapter-load` task (WP2) drives their iterators into DocumentWriter (WP0).

```js
/** @typedef {Object} SourceAdapter
 * @property {string} id                 'stemm.openalex'
 * @property {string} version            semver
 * @property {string} label
 * @property {'local-file'|'local-dataset'|'network'} access   // network adapters stay disabled until approved
 * @property {string} license
 * @property {string} attribution
 * @property {string|null} stagedDir     name under $SCROLLS_DATA/sources/ (STEMM) or null (Cipher reads CIPHER paths)
 * @property {CollectionSpec[]} collections   // {slug,name,domain,modality,unit,sampling,rate_eligible,export_text_allowed,coverage_gate,selection_note}
 * @property {(ctx:AdapterCtx) => Promise<ProbeResult>} probe
 *     // reads FORMAT.md + MANIFEST.json FIRST; ProbeResult = {available, reason?, manifest_ok, format_ok,
 *     //   counts:{…}, caveats:string[]}  — caveats are copied into collection.caveats_json
 * @property {(params:object, ctx:AdapterCtx) => Promise<{units:number}>} plan
 * @property {(params:object, ctx:AdapterCtx) => AsyncIterable<CanonicalDocument>} documents
 * @property {(params:object, ctx:AdapterCtx) => AsyncIterable<CanonicalRelationship>} [relationships]
 * @property {(params:object, ctx:AdapterCtx) => AsyncIterable<CanonicalAnnotation>} [annotations]
 * @property {(ctx:AdapterCtx) => ClaimsLookup} [claims]       // wiktionary: lookup(word) → Claim[]
 * @property {(ctx:AdapterCtx) => BaselineLookup} [baseline]   // ngram: series(word) → Series|null
 */
/** @typedef {{dataDir:string, stagedDir:string|null, signal:AbortSignal,
 *   progress:(done:number,total:number,msg?:string)=>void, warn:(code:string,msg:string,detail?:object)=>void,
 *   log:(level:string,msg:string,data?:object)=>void}} AdapterCtx */
```

**Rules:** adapters read staged files only; if a file is missing or `FORMAT.md`'s field list does not
match what the adapter expects, `probe` returns `{available:false, reason}` and the Adapters page shows
"unavailable: <reason>" instead of crashing. Network fetching lives only in `tools/fetch/*.mjs` (existing,
user-run, logged); the app's Adapters page shows the exact command to re-run a fetcher, never runs it.

### 10.2 The staged STEMM sources

| Adapter | Staged input | Becomes | Dates | Honesty rules |
|---|---|---|---|---|
| `stemm.gutenberg-stemm` | `catalog.jsonl`, `texts/<id>.txt`, `cipher-overlap.jsonl` | collection `stemm-gutenberg` (stemm · text · tokens · `curated`, note "LoCC Q/R/T shelf, balanced by field quotas and period bins; priority-scored by prominence"). Text = `bytes[body_start_byte, body_end_byte)` decoded per `encoding`, sha256 verified (mismatch → `W_SHA_MISMATCH`, row skipped). Rows without a file → metadata-only documents "text not downloaded". Ids present in `cipher-overlap.jsonl` → **alias** of the Cipher document (never duplicated). `field` → taxonomy; LoCC/subjects/bookshelves → `doc_tag(provenance='catalog')`. | primary `date_evidence`: `title-stated`, `gutenberg-marc906`, `wikidata-P577`, `wikidata-work-P577` → basis stated (precision as given); `author-lifetime-estimate` → **estimated range** (striped); `unknown` → undated. `date_disagreement_years > 5` → note "first publication vs edition differ by N years". `gutenberg_issued` → role `release`, never chronology. | Coverage panel prints "dated by evidence X · lifetime estimate Y · undated Z · after 1928 W" per load; estimated bins are striped. |
| `stemm.openalex` | `works.jsonl`, `citations.tsv`, `coverage.tsv`, `population.tsv`, `fields.json` | collection `stemm-openalex` (stemm · abstracts · works · **`top_cited_per_cell`**, `export_text_allowed=0`, coverage gate 20 sampled works). Each work → document: `title` passage (field_class title) + `abstract` passage (field_class abstract; `quality='gappy'` when gaps > 10% of tokens or > 1,000 tokens; `low` when < 10 tokens; text "Abstract" prefix kept). `field/subfield/topic/keywords` → `doc_tag(provenance='adapter_machine', method='OpenAlex classifier')`. Citations → `explicit_citation` **documented**, `source_dataset='openalex'`, locator `https://openalex.org/<id>`; `cited_year > citing_year` → `date_conflict=1`. | `publication_date` + the fetcher's `date_precision` (day/month/year); `-12-31` → note "possible placeholder date"; note on every OpenAlex date card: "OpenAlex year may be a reprint or digitisation year". | Lanes are labelled **"top-cited sample: 200 per field × period"**; tooltip adds population ("sample 200 of 14,516 works in OpenAlex for Mathematics 1875–99"); pre-1900 cells say "field label is a modern classifier's guess". Language detection decides `lang_text` (`de` included: ≈13.2k German works); OpenAlex's own code kept in meta. |
| `stemm.wiktionary` | `terms.jsonl` (+ `stats.json`) | On first load: `derived/wiktionary/word-index.json` (folded word → byte offsets; one 200 MB scan). For a **tracked** expression only: a document in `stemm-wiktionary` (etymology · lexical · entries, `rate_eligible=0`) whose `entry` field is the entry's `etymology_text` (≤ 800 chars, CC BY-SA), and a `date_assertion(subject='expression', role='first_attestation_claim', basis='stated', asserted_by='wiktionary')` with the `span` offsets as the highlight. | the attestation's own year / decade / century / range (+ qualifier) | Hollow amber diamond left of the strand, "Wiktionary: coined 1946 (external claim)"; opens the entry with the span highlighted. Shown by default only when `subject_hint='headword'` and not `sense_specific`; `unclear` shown dimmed ("subject unclear"); `other-language-context` never. Never an occurrence; never moves a bar. |
| `stemm.ngram` | `ngram-eng-1.sqlite` (ATTACHed read-only in a read worker; `meta.complete='1'` required) | No documents. `baseline(word)` → per-decade per-million rates (sum counts / sum totals, never averaged ratios) + `volumes` evidence base; served by `/api/baseline`. | year (Google metadata, stated) | Own track and axis; label "Google Books Ngram, English, 2020 edition — a different corpus"; attribution shown wherever values are; `top_form` capitalized → "proper-noun or sentence-initial uses may dominate this curve"; decades with < 500 volumes hatched; multi-word → "single words only"; hyphenated → "split by Google's tokenizer". Compare shows Spearman ρ between our decade rates and the baseline (≥ 5 decades where our rate gate passes): "Does our sample track a larger corpus? ρ = 0.62 (9 decades)". |

### 10.3 STEMM fields as lanes (`data/field-taxonomy.json`, one shared taxonomy)

| Lane | LoCC (Gutenberg) | gutenberg-stemm `field` | OpenAlex field ids (sampled) | Wiktionary `fields` |
|---|---|---|---|---|
| Mathematics | QA | mathematics | 26 Mathematics | mathematics |
| Computing | QA/T/TK + computing subjects | computing | 17 Computer Science | computing |
| Physical sciences | QB, QC, QD, TP | astronomy, physics, chemistry | 31 Physics & Astronomy, 16 Chemistry, 25 Materials Science | astronomy, physics, chemistry |
| Earth & environment | QE | earth-sciences | 19 Earth & Planetary Sciences, 23 Environmental Science | earth-sciences |
| Life sciences | QH, QK, QL, QM, QP, QR | biology | 13 Biochemistry, Genetics & Molecular Biology, 11 Agricultural & Biological Sciences, 24 Immunology & Microbiology, 28 Neuroscience | biology |
| Medicine & health | R, RA–RZ | medicine | 27 Medicine, 29 Nursing, 30 Pharmacology, 36 Health Professions, 35 Dentistry, 34 Veterinary | medicine |
| Engineering & technology | T, TA–TN, TR, TS | engineering-technology | 22 Engineering, 21 Energy, 15 Chemical Engineering | engineering-technology |
| General science | Q, AP science periodicals | general-science | — | — |
| *(not STEMM)* Literature & culture | Cipher books; non-QRT | — | — | — |

The source's own label is always kept in `doc_tag`. The **Domains** preset lays these out top to bottom:
Etymology (periods) · Literature (text) · STEMM fields (text / abstracts) · Culture titles (songs, films,
tv, books) · External baseline — so a term can be followed down the screen from science lanes to culture
lanes.

### 10.4 OpenAlex honesty: within-cell presence shares

OpenAlex lanes never use calendar bins: each lane shows **OpenAlex's own 30 cells** (1665–1799, 1800–49,
1850–74, 1875–99, then 5-year bins to 2020–24, 2025–26) as boxes spanning the cell's years. The quantity
is **k of n sampled works (title or abstract) mention the term**, with a Wilson CI and the abstract
availability ("k of 200 · abstracts for 143"). Cross-cell rate lines, rate ratios and drift across cells
are refused (`sampling_design`); Compare shows within-cell shares side by side, descriptively.
Citations to later-dated works are date conflicts. Abstract text is never exported.

### 10.5 Following terms from science into culture — honestly (the **Term trail** preset)

Term trail = track an expression with inflection and hyphenation variants (translation variants opt-in),
lanes = Domains, etymology band + listed-roots bracket on, Wiktionary claim marker on, Ngram baseline on,
Crossings card open. Six guardrails:

1. **Co-presence is not transmission.** If two lanes contain the term but no documented or computed edge
   joins them, the trail shows *"These lanes share a word. No link between them is recorded. [Propose a
   link]"* (creates a `proposed` human relationship with the user's evidence). There is **never** a
   "science → slang" arrow without a documented source.
2. **Titles, not lyrics.** Song and film lanes count titles per 1,000 works; summaries and Cipher glosses
   are excluded by default and shown greyed as "described later, by Wikidata or the Cipher tagging pass".
3. **Name collisions.** The proper-noun guard (§4.5) lists "excluded as names (n)" (*Gene Kelly*,
   *Drive (For Daddy Gene)*), overridable per match.
4. **Senses are separated, not assumed.** *virus/viral* clustering in a pooled space (Gutenberg + STEMM
   text + OpenAlex abstracts, per language) may separate poison/contagion, biological and computing
   contexts — reported only if the gates pass.
5. **Missing families are stated.** *bug*, *hacker*, *algorithm* have no Latin/Greek/Sanskrit/PIE family
   in roots.tsv; the band says so and offers the Wiktionary claim if one exists.
6. **The medium changes at 1928.** The modality seam (§1.10) is always visible on a Term trail.

**Worked expectations** (measured today on the Cipher files; everything else is computed at runtime):

| Term | Trail on real data |
|---|---|
| *virus* | `la:virus` "venom" band (Latin period) with a listed-roots bracket (\*weys- · \*dʰewb- · \*dʰewbʰ-, "relation not recorded") → Gutenberg figurative uses after the boilerplate pass removes the licence's "computer virus" (e.g. *Babbitt*'s "the virus of to-day's restlessness"); the English text of translated French books is excluded from 1840s English → OpenAlex medicine/biology cells (shares per cell) → culture titles: 2 films (*Virus* 1999, *Mickey Virus* 2013) → Ngram baseline line. |
| *viral* | 0 Gutenberg hits expected; 4 titles (2 songs incl. romanized Tamil *Oru Viral Puratchi* (`und-Latn`), 2 films 2013–2018); no link drawn between medical and "went viral" senses unless a method supports one. |
| *hacker* | 0 titles; with the plural variant 1 (*Hackers*, film 1995); OpenAlex/gutenberg-stemm (the Jargon File, LoCC TK, if downloaded) may add text; Ngram curve flagged "capitalized *Hacker* dominates". |
| *algorithm* | 0 titles; with plural 1 (*Introduction to Algorithms*, book 1990); no roots family; Wiktionary claim if present. |
| *gene / genetic* | `ine-pro:*ǵenh₁-` family (documented descent, "shared ancestry, not shared meaning" with *genre*, *genius*, *engineer*); 4 *gene* titles of which the guard excludes personal names; 68 summary matches are `describes` and mostly people named Gene. |
| *quantum* | `la:quantus` family; 6 titles (*Quantum Leap* tv 1989 and 2022, *Quantum of Solace* 2008, …); OpenAlex physics cells from 1900–04 on. |
| *zero* | `sa:शून्य` śūnyá "blank" band (Sanskrit period) → hi/gu Wikisource lanes (शून्य, શૂન્ય with oblique/postposition variants) → 31 culture titles → seam at 1928 for en/fr/es text. |

**Seed watch-list** (`expression.origin='stemm_seed'`, materialized in the background after phase B):
virus, viral, bug, algorithm, gene, genetic, quantum, hacker, hack, robot, atomic, radio, electric,
gravity, DNA, satellite, rocket, laser, cyber, network, feedback, signal, static, frequency, code, program,
glitch, sample, zero.

---

## 11. Test plan, mapped to the brief's acceptance criteria (§12 of the brief)

Runner: `node --test tests/*.test.mjs` (`npm test`). Every test uses `tests/helpers/tmpdata.mjs` (fresh
`SCROLLS_DATA` under the OS temp dir, migrated, seeded with the 12-document `tests/fixtures/mini/`
corpus in en/fr/es/hi/gu). Tests needing Cipher or staged STEMM files **skip with a message** when the
files are absent; `npm run test:cipher` runs them against a real bootstrap. `npm run bench` (not part of
pass/fail) writes timings into `Docs/VERIFICATION.md`.

| Brief criterion | Test file (owner) | What is asserted |
|---|---|---|
| A real uploaded corpus imports and is searchable | `ingest.*.test.mjs` (WP1), `adapters.cipher.test.mjs` (WP2), `search.test.mjs` (WP3) | CSV/TSV/JSON/JSONL/TXT/MD fixtures (BOM, quoted newlines, `;` delimiter, Devanagari, Gujarati) import with **exact** summary counts (e.g. `letters.csv` → accepted 37 / warnings 2 / rejected 1); FTS finds `अनुपम` and `ગુજરાતી` as whole tokens and a phrase in each format; a 3-book Gutenberg slice (ids 1342, 135, 1661) and 20 Wikisource pages import from the real files; `#1661` → 1 document + 2 aliases; `#135` flagged translation; search "Bennet" ≥ 1 hit with offsets. |
| Dates and unknown dates behave correctly | `dates.test.mjs` (WP0), `aggregate.binning.test.mjs` (WP3) | ≥ 90 grammar cases (ISO, named months en/fr/es/hi/gu, circa ±5, decade, "the 1800s" warning, century incl. Roman/fr/es, early/mid/late, ranges, open ranges, BCE, bare negatives historical vs astronomical, millennium, VS/Saka, Devanagari/Gujarati digits, `''`/`0` unknown, future → announced, `'90s` rejected, `2019-02-30` invalid); `dayFromYMD` for years 0–99, −4499, leap years; a decade-precision document is absent from year bins, present in its decade bin and counted in washes at year tier; **conservation** `Σ bins + Σ washes + undated + scheduled = total` for every tier on random filters; undated items appear only on the shelf; culture-works `''` → undated (8,227) and 28 scheduled. |
| Every displayed occurrence opens its original passage | `offsets.test.mjs` (WP3), `tokenize.test.mjs` (WP0), `ui.timeline.display.test.mjs` (WP6) | Property test over 5,000 random occurrences (en/fr/es/hi/gu, combining marks, ZWJ, `ſ`, emoji, CRLF, BOM, Gutenberg `_italics_`): `fold(original.slice(start,end))` equals a variant's norm and lies inside its passage; `/api/passages/:id` highlights slice to the same tokens; **tokenizer parity**: JS token count and order equal `passage_vocab_inst` on 10,000 passages; every `/api/timeline/marks` id resolves; every display-list primitive with `openable:true` has a hit entry whose ref resolves (passage or bin page); **culture-lines oracle** (`test:cipher`): ≥ 95% of 1,000 sampled lines are locatable. |
| Filters update visualizations and counts consistently | `aggregate.invariants.test.mjs` (WP3), `ui.a11y-table.test.mjs` (WP6) | For 50 random filter/toggle combinations: Σ tile n per lane = `/api/timeline/marks` total = Compare `freq.n` = export row count; denominators equal `doc_tokens` sums for the same slice; the "other" lane completes the sum; the a11y table and the painter read the **same** typed-array object (identity check); a filter change changes the `queryKey` and invalidates tiles. |
| Demo material clearly labelled | `demo.test.mjs`, `demo-names.test.mjs` (WP2), `ui.copy.test.mjs` (WP0) | Every demo row `is_synthetic=1` (and the corpus CHECK blocks a non-synthetic demo corpus); every API object derived from demo rows has `synthetic:true` (tiles flag 16, marks, passages, lineage, exports column + header); PNG/SVG snapshot display list contains the SYNTHETIC stamp; author names end with "(synthetic)"; **no demo name collides** with culture-works titles/makers or MusicBrainz artists/recordings (skips the MB part if tables are absent); §9.6 calibration numbers hold. |
| Inferred lineage cannot be mistaken for documented citation | `provenance.test.mjs` (WP5), `db.schema.test.mjs` (WP0), `ui.evidence-style.test.mjs` (WP0) | Executes `schema.sql` verbatim; INSERT `origin='algorithm'|'human'|'machine_tagger'` with `documented` fails; documented without locator/`source_unrecorded` fails; UPDATE of `evidence_status`/endpoints/method aborts; DELETE aborts except for cancelled runs; reviewing (confirm/reject/dispute) changes only `review_status` and appends a revision; a human-created edge is forced to `proposed`; cue citations are `proposed` + `citation_cue` row; Cipher mapping: kindred → computed, counterpart → proposed, `-`+tags → proposed, `-` otherwise → documented + `source_unrecorded`, `w/d/m/i` → documented with locator when the raw file matches; the three statuses have three distinct (dash, endpoint, badge) triples and no style differs only in hue; "documented only" filter excludes computed and proposed everywhere (timeline arcs, lineage, genealogy, exports). |
| Insufficient evidence never yields authoritative drift claims | `gates.test.mjs`, `analysis.*.test.mjs` (WP4), `ui.panels.compare.test.mjs` (WP7), `ui.copy.test.mjs` (WP0) | Boundary fixtures at 49/50 occurrences, 4/5 documents, 2/3 authors, top-doc share 0.51, 2.99M/3M tokens, 2,999/3,000 anchors: gate ≠ ok ⇒ `value=null` (and the DB CHECK rejects a gated row with a value); unaligned spaces refused; composition JSD > 0.4 suppresses aligned displacement; modality mismatch refused by default; OpenAlex cross-cell refused; verdict requires adjusted percentile **and** overlap ≤ 0.2; multiplicity threshold = 100 − 5/k; a gated payload renders **no numeral**; Procrustes recovers a known rotation (residual < 1e-4, cos > 0.999); planted demo clusters recovered (ARI ≥ 0.8); displacement for an unchanged control word lies inside the control distribution; UI strings contain no "meaning changed" and no mental-state verbs about historical people (`thought|felt|intended|meant to|wanted|believed`). |
| Saved views and annotations survive restart | `persistence.test.mjs`, `anchors.test.mjs` (WP5) | Spawn `server.mjs` on a temp data dir; create a view, an annotation with 3 revisions, a reinterpretation, a relationship review; **SIGKILL**; restart; every object is byte-identical through the API; revision UPDATE/DELETE abort; view UPDATE aborts and re-save makes `slug~2`; after a new import `GET /api/views/:slug` reports `dataChanged:true` and "as saved" counts equal the original; **re-anchoring migration**: re-segment a document with different parameters → every annotation and evidence span re-anchors by (sha256, offsets, quote) to a new passage, or is reported as orphaned (never silently dropped). |
| Malformed input gives actionable feedback | `ingest.malformed.test.mjs` (WP1) | Invalid UTF-8 (byte offset + fallback), ragged row 57 (field counts), unclosed quote (line/column), JSONL syntax error on line 7 (column), empty record, unparseable/ambiguous/invalid dates (row kept undated + suggestion), 31 MB field, duplicate file / duplicate id; each issue has `code`, `line`, `message`, non-empty `suggestion`; `abort` and a mid-commit fatal leave **zero** documents from the batch. |
| Main flow works on desktop and narrow viewport | `ui.layout.test.mjs` (WP6), `src/ui/selftest.mjs` + `tests/e2e/journey.md` (WP8) | Pure-function breakpoint tests; `/?selftest=journey` runs in the browser: load demo → search → Scroll paints → click a bin → open passage → compare two periods → save view → reload `#view=<slug>` → identical state hash; executed by WP8 in the Browser pane at 1440×900 and 375×812, with screenshots in `$SCROLLS_DATA/cache/verify/` and listed in `Docs/VERIFICATION.md`. |
| Expensive analysis does not freeze the UI | `jobs.test.mjs` (WP0), `analysis.responsiveness.test.mjs` (WP4) | During a clustering job on 50k synthetic occurrences and a `vectors` job on a generated 3M-token fixture: 50 concurrent `/api/health` p95 < 50 ms and 20 `/api/timeline/tiles` p95 < 300 ms; `monitorEventLoopDelay` p99 < 50 ms on the main thread; cancel acknowledged ≤ 500 ms, final `cancelled`, no rows of the run visible; a job running at SIGKILL is `interrupted` after restart; in the browser, `PerformanceObserver('longtask')` during play + pan reports no task > 50 ms (selftest). |
| Meaningful tests: ingestion, offsets, temporal aggregation, relationship provenance, persistence | all of the above + `lineage.*.test.mjs` (WP5), `cipher-mapping.test.mjs` (WP2) | Winnowing guarantee: an inserted 13-token run is always found; near-quote thresholds; cue detection in all 5 languages; **virus canary**: after the boilerplate pass no `quality='ok'` passage in `cipher-gutenberg` contains "computer virus, or computer codes that damage", and the 3-file fixture shows 0 licence hits; Cipher reconciliation counts (§6.8); OpenAlex: 6,666 date conflicts flagged, 0 drawn as feedback, abstract text absent from every export format. |
| Security and localhost | `security.test.mjs` (WP0) | Requests with a foreign `Host` or a cross-origin `Origin` on a mutation → 403; the server listens on 127.0.0.1 only; DB path under iCloud refused with `E_DB_IN_ICLOUD`. |

---

## 12. Build plan — 1 foundation package, 7 parallel packages, 1 integration package

### 12.1 Repository tree (owner in brackets; **no file has two owners**)

```
Scrolls/                                   iCloud folder, source only; gitdir ~/Developer/git/Scrolls.git
├─ package.json  server.mjs  .gitignore                                          [WP0]
├─ README.md                                                                     [WP8]
├─ Docs/ brief.md data-inventory.md proposals/ SPEC.md                           (read-only inputs)
│   ├─ API.md                                                                    [WP0]
│   ├─ IMPORT-SCHEMA.md                                                          [WP1]
│   ├─ CIPHER-MAPPING.md                                                         [WP2]
│   ├─ ANALYSIS-AND-LIMITS.md                                                    [WP4]
│   └─ HANDOFF.md  VERIFICATION.md                                               [WP8]
├─ server/
│   ├─ config.mjs                                                                [WP0]
│   ├─ db/ schema.sql open.mjs migrate.mjs seed-vocab.mjs readpool.mjs readworker.mjs           [WP0]
│   ├─ http/ app.mjs router.mjs security.mjs static.mjs sse.mjs errors.mjs etag.mjs mock.mjs     [WP0]
│   ├─ jobs/ queue.mjs worker.mjs context.mjs                                    [WP0]
│   │   └─ tasks/ _noop.mjs                                                      [WP0]
│   │            import.mjs revert.mjs                                           [WP1]
│   │            bootstrap-cipher.mjs adapter-load.mjs demo-load.mjs             [WP2]
│   │            materialize.mjs export.mjs                                      [WP3]
│   │            tokstream.mjs collocations.mjs vectors.mjs cluster.mjs drift.mjs tone.mjs layout.mjs [WP4]
│   │            boilerplate.mjs reuse-index.mjs trace.mjs gc-runs.mjs           [WP5]
│   ├─ store/ document-writer.mjs bins.mjs                                       [WP0]
│   ├─ text/  segment.mjs langid.mjs stopwords/{en,fr,es,de,la,it,pt,hi,gu}.json [WP0]
│   │         variants.mjs translit.mjs names.mjs kwic.mjs                       [WP3]
│   ├─ ingest/ sniff.mjs decode.mjs csv.mjs json.mjs jsonl.mjs txt.mjs md.mjs frontmatter.mjs
│   │          mapping.mjs suggest.mjs validate.mjs dedupe.mjs summary.mjs pipeline.mjs          [WP1]
│   ├─ adapters/ api.mjs registry.mjs                                            [WP0]
│   │   ├─ cipher/ books.mjs gutenberg-text.mjs wikisource.mjs works.mjs siblings.mjs
│   │   │          tags-provenance.mjs relations.mjs roots.mjs themes.mjs        [WP2]
│   │   ├─ stemm/  gutenberg-stemm.mjs openalex.mjs wiktionary.mjs ngram.mjs field-map.mjs       [WP2]
│   │   └─ demo/   demo.mjs                                                      [WP2]
│   ├─ aggregate/ query.mjs fts.mjs materialize.mjs exprdoc.mjs tiles.mjs washes.mjs marks.mjs arcs.mjs
│   │             coverage.mjs lanes.mjs rates.mjs stats.mjs seams.mjs shelf.mjs bin.mjs cache.mjs [WP3]
│   ├─ export/ manifest.mjs csv.mjs jsonl.mjs bundle-html.mjs                    [WP3]
│   ├─ analysis/ tokstream.mjs collocations.mjs keyness.mjs cooc.mjs ppmi.mjs linalg.mjs rsvd.mjs
│   │            procrustes.mjs occvec.mjs tfidf-hash.mjs kmeans.mjs stability.mjs labels.mjs
│   │            transitions.mjs convergence.mjs drift.mjs bootstrap.mjs gates.mjs compare.mjs
│   │            composition.mjs multiplicity.mjs tone.mjs layout.mjs           [WP4]
│   ├─ lineage/ winnow.mjs boilerplate.mjs minhash.mjs align.mjs cues.mjs classify.mjs trace.mjs
│   │           graph.mjs genealogy.mjs path.mjs commonplace.mjs hypotheses.mjs  [WP5]
│   ├─ provenance/ relationships.mjs reviews.mjs annotations.mjs anchors.mjs views.mjs          [WP5]
│   └─ routes/ health.mjs jobs.mjs events.mjs                                    [WP0]
│              imports.mjs                                                       [WP1]
│              corpora.mjs adapters.mjs tour.mjs baseline.mjs                    [WP2]
│              search.mjs expressions.mjs timeline.mjs passages.mjs documents.mjs kwic.mjs exports.mjs [WP3]
│              compare.mjs collocations.mjs clusters.mjs analysis.mjs constellation.mjs           [WP4]
│              lineage.mjs genealogy.mjs relationships.mjs hypotheses.mjs trace.mjs annotations.mjs views.mjs [WP5]
├─ src/
│   ├─ shared/ contracts.mjs vocab.mjs dates.mjs tokenize.mjs ids.mjs viewstate.mjs format.mjs evidence-style.mjs [WP0]
│   └─ ui/
│       ├─ main.mjs registry.mjs                                                 [WP0]
│       ├─ core/ store.mjs url.mjs api.mjs sse.mjs dom.mjs keys.mjs announce.mjs [WP0]
│       ├─ shell/ layout.mjs toolbar.mjs search.mjs filters.mjs lanes-menu.mjs ribbon.mjs toasts.mjs help.mjs jobs-chip.mjs [WP6]
│       ├─ timeline/ viewport.mjs scale.mjs folded.mjs tiers.mjs tiles-client.mjs model.mjs display.mjs paint.mjs svg.mjs
│       │            hit.mjs input.mjs gestures.mjs playhead.mjs arcs.mjs shelves.mjs seams.mjs minimap.mjs coverage.mjs
│       │            legend.mjs a11y-table.mjs drawer.mjs snapshot.mjs perf.mjs  [WP6]
│       ├─ tour/ tour.mjs coachmarks.mjs                                         [WP6]
│       ├─ panels/ inspector.mjs passage-card.mjs reader.mjs date-chip.mjs crossings.mjs compare.mjs gate-card.mjs
│       │          lineage.mjs genealogy.mjs constellation.mjs layout.worker.mjs edge-card.mjs notebook.mjs
│       │          annotation-editor.mjs revisions.mjs views-menu.mjs export-menu.mjs jobs-tray.mjs adapters.mjs [WP7]
│       ├─ import/ wizard.mjs mapping-table.mjs summary.mjs                      [WP1]
│       └─ selftest.mjs                                                          [WP8]
├─ public/ index.html icons.svg                                                  [WP0]
│   └─ styles/ tokens.css base.css [WP0] · shell.css timeline.css [WP6] · panels.css [WP7] · import.css [WP1]
├─ data/ field-taxonomy.json  demo/{anchors.jsonl,documents.jsonl,relationships.jsonl,annotations.jsonl,
│        generator.mjs,tour.json,README.md}                                      [WP2]
├─ scripts/ bootstrap-cipher.mjs build-demo.mjs check-demo-names.mjs [WP2] · bench.mjs [WP3] · verify.mjs [WP8]
├─ tools/ fetch/*.mjs  (existing; untouched by every package)
│         nl-adapter/ main.swift build.sh                                        [WP4]
└─ tests/
    ├─ helpers/ tmpdata.mjs server.mjs shape.mjs · contract/*.json · fixtures/mini/*                [WP0]
    ├─ db.schema · dates · tokenize · segment · langid · writer · jobs · security · viewstate ·
    │  ui.copy · ui.evidence-style  (.test.mjs)                                  [WP0]
    ├─ ingest.*.test.mjs · fixtures/ingest/*                                     [WP1]
    ├─ adapters.*.test.mjs · cipher-mapping · demo · demo-names (.test.mjs) · fixtures/cipher/*      [WP2]
    ├─ aggregate.*.test.mjs · offsets · search · exports (.test.mjs)             [WP3]
    ├─ analysis.*.test.mjs · gates.test.mjs                                      [WP4]
    ├─ lineage.*.test.mjs · provenance · persistence · anchors (.test.mjs)       [WP5]
    ├─ ui.timeline.*.test.mjs · ui.layout · ui.a11y-table (.test.mjs)            [WP6]
    ├─ ui.panels.*.test.mjs                                                      [WP7]
    └─ e2e/journey.md · e2e.journey.test.mjs · acceptance.*.test.mjs             [WP8]
```

**Mechanisms that keep ownership disjoint:** `server/http/app.mjs` auto-registers every
`server/routes/*.mjs` (each exports `routes`); `server/jobs/worker.mjs` imports
`tasks/<type>.mjs` for every type in `vocab.JOB_TYPES`; `src/ui/registry.mjs` statically imports every UI
module path; `server/adapters/registry.mjs` lists every adapter id → module; keyboard bindings register at
runtime (`keys.register`); stylesheets are separate files already linked from `index.html`. **WP0 writes a
stub for every file in the tree** (correct exports, signatures, placeholder bodies, `// OWNER: WPn`
header); after WP0 merges, each stub belongs to its package.

### 12.2 WP0 — FOUNDATION (one agent, first; critical path ≈ 3,500 LOC)

Owns every `[WP0]` path above. Delivers the schema, the shared modules, the server skeleton, jobs, the
writer, the text core, the frontend shell, contract fixtures, mock mode and all stubs. Exact exported
signatures (JSDoc in code; types named here are defined in `src/shared/contracts.mjs`):

```js
// ── server/config.mjs
export const VERSION;                                  // from package.json
export const PORT;                                     // Number(process.env.SCROLLS_PORT) || 3460
export const HOST = '127.0.0.1';
export function dataDir(): string;                     // $SCROLLS_DATA || ~/Developer/scrolls-data; throws E_DB_IN_ICLOUD under ~/Documents or ~/Library/Mobile Documents
export function paths(): { data, db, originals, incoming, derived, tokens, spaces, align, reuse, wiktionary, sources, cache, exports, snapshots, logs, bin };
export function ensureDirs(): void;
export const CIPHER: { root, resources, cultureWorks, cultureThemes, cultureLines, roots, gutenbergJson, gutenbergDir, pgCatalog,
                       wikisourceHi, wikisourceGu, tagsDir, relationsDir, musicbrainzTables };
export function cipherStatus(): { ok: boolean, missing: string[] };
export const FLAGS: { mock: boolean /*SCROLLS_MOCK=1*/, noAutoImport: boolean /*SCROLLS_NO_AUTO_IMPORT=1*/, readWorkers: 3, logLevel: 'info' };

// ── server/db/open.mjs
export function openDb({ path = paths().db, readOnly = false } = {}): DatabaseSync;   // pragmas of §3; readOnly for workers
export function tx(db, fn): any;                       // BEGIN IMMEDIATE … COMMIT; ROLLBACK + rethrow
export function getMeta(db, key): string | null;
export function setMeta(db, key, value): void;
export function dataVersion(db): number;
export function bumpDataVersion(db): number;           // call inside the committing tx
export function nowIso(): string;
// ── server/db/migrate.mjs
export function migrate(db): { from: number, to: number };       // executes schema.sql verbatim on a fresh DB
// ── server/db/seed-vocab.mjs
export function seedVocab(db): void;                   // rel_type, language_period, dimension_def, corpus rows (idempotent)
// ── server/db/readpool.mjs  (worker entry: readworker.mjs; each worker opens its own readOnly connection)
export function startReadPool({ size = FLAGS.readWorkers } = {}): ReadPool;
//   ReadPool = { run(moduleUrl: string, fnName: string, args: object, { timeoutMs = 5000 } = {}): Promise<any>,
//                stats(): { size, busy, queued }, close(): Promise<void> }
//   Heavy query functions everywhere have the signature  export function xxxQuery(db, args) → plain JSON.
//   On timeout the worker is terminated and respawned; the promise rejects with HttpError(503,'QUERY_TIMEOUT').

// ── server/http/app.mjs
export async function startServer({ port = PORT, host = HOST, mock = FLAGS.mock } = {}): Promise<{ server, url, close(): Promise<void> }>;
//   boot order: ensureDirs → openDb → migrate → seedVocab → registerAdapters → startReadPool → createJobQueue →
//   recoverInterrupted → enqueue('demo-load') if demo absent (await ≤ 10 s) → enqueue('bootstrap-cipher') if
//   cipherStatus().ok && !noAutoImport && not yet done → loadRoutes (or mockRoutes) → listen
// ── server/http/router.mjs
export function createRouter(): { add(route: Route): void, match(method, pathname): { route, params } | null, list(): Route[] };
export async function loadRoutes(router, dirUrl): Promise<number>;
//   Route    = { method, path /* '/api/passages/:id' */, heavy?: boolean, sse?: boolean, handler(req: SReq, ctx: RouteCtx): Promise<Resp> }
//   SReq     = { method, path, params, query, headers, body /* parsed JSON or null */, raw /* IncomingMessage */, sessionId }
//   RouteCtx = { db /* main connection */, pool: ReadPool, jobs: JobQueue, bus, dataVersion(): number, withWrite(fn: (db) => T): T }
//   Resp     = { status?, json?, body?, headers?, stream?: (res) => void, etag?: boolean /* default true for GET */ }
// ── server/http/security.mjs
export function checkRequest(req, { port }): void;     // throws HttpError(403,'E_FORBIDDEN_ORIGIN')
// ── server/http/errors.mjs
export class HttpError extends Error { constructor(status, code, message, hint = null, detail = null) }
export function toErrorBody(err): { error: { code, message, hint, detail } };
// ── server/http/etag.mjs
export function etagFor(dataVersion, body): string;    // W/"<dataVersion>-<fnv1a32 hex>"
// ── server/http/sse.mjs
export function openSse(res, { heartbeatMs = 15000 } = {}): { send(event, data): void, close(): void };
export const bus;                                      // EventEmitter: 'job' | 'data' | 'adapter' | 'bootstrap'
// ── server/http/static.mjs
export function serveStatic(req, res): boolean;        // public/ at /, src/ui at /ui, src/shared at /shared
// ── server/http/mock.mjs
export function mockRoutes(contractDirUrl): Route[];   // one route per tests/contract/<METHOD>__<path>.json

// ── server/jobs/queue.mjs
export function createJobQueue(db, { bus }): JobQueue;
//   JobQueue = { enqueue(type, params, { priority } = {}): number, cancel(jobId): 'cancelling'|'cancelled'|'finished'|'not_found',
//                get(jobId): JobRow, list({ status }): JobRow[], recoverInterrupted(): number, onEvent(fn): () => void }
//   At most one writes=1 job runs at a time; ≤ 2 read-only jobs concurrently; each job runs in a worker thread.
// ── server/jobs/context.mjs
export class CancelledError extends Error {}
export function makeTaskContext({ db, jobId, cancelFlag /* Int32Array over SharedArrayBuffer */, post }): TaskCtx;
//   TaskCtx = { db, paths, jobId, signal,
//     progress(fraction, phase?, message?, counts?): void,          // throttled to 4/s, persisted to job + job_event
//     checkpoint(): void,                                           // throws CancelledError when cancel was requested
//     startRun(stage, { pipelineVersion, params, scope, upstream = [], representation = null, model = null, modelVersion = null, seed = null }): number,
//     finishRun(runId, status, { metrics = null, gate = {} } = {}): void,
//     enqueue(type, params, opts): number, log(level, message, data?): void }
//   Task module contract (server/jobs/tasks/<type>.mjs):
//     export const type = 'cluster'; export const writes = true; export const priority = 3;
//     export async function run(ctx: TaskCtx, params): Promise<object /* result_json */>;

// ── server/store/document-writer.mjs
export function createDocumentWriter(db, { batchId, collection, corpus, options: { dedupe = 'flag', detectLanguage = true, onBadRow = 'skip_and_report' } }): DocumentWriter;
//   DocumentWriter = {
//     addDocument(doc: CanonicalDocument): { documentId: number | null, issues: Issue[] },
//         // decodes regions, segments (segment.mjs), tokenizes (tokenize.mjs), langid, inserts passage + passage_fts,
//         // date_assertion (+date_rtree), doc chronology, doc_bin, doc_tokens, document_field, aliases, doc_tag, label_tri;
//         // copies is_synthetic from the corpus; computes text_sha256 / dup_of / doc_minhash
//     addRelationship(rel: CanonicalRelationship): { pending: true },          // endpoints resolved by ext_id at finish()
//     addAnnotation(ann: CanonicalAnnotation): { pending: true },
//     addIssue(issue: Issue): void,
//     flush(): void,                                                          // auto every 5,000 documents
//     finish(): ImportCounts,                                                 // resolves pending, bumps data_version, returns counts
//     rollback(): void };                                                     // removes everything of this batch
export function resolveExt(db, { collectionSlug, extId }): number | null;
// ── server/store/bins.mjs
export function binsFor(yLo, yHi): Array<{ level: 0|1|2|3, bin: number }>;   // levels where the interval fits one bin
export function writeDocBins(db, documentId, yLo, yHi): void;
export function rewriteDocTokens(db, documentIds): void;                    // after passage quality changes

// ── server/text/segment.mjs
export const SEGMENTER_VERSION = 'seg-1';
export function segment(text, { mode = 'auto' /*|'prose'|'verse'|'field'*/, lang = null, regions = [], pageSep = '\f' } = {}):
  Array<{ start, end, unit, page_no, quality, time_role, field_class }>;
// ── server/text/langid.mjs
export function scriptOf(text): 'Latn' | 'Deva' | 'Gujr' | 'Other';
export function detectLang(text, { declared = null } = {}): { lang, confidence, scores };
export function documentLang(passages /* [{lang, tokens, confidence}] */, declared): { lang_text, confidence, is_translation };

// ── server/adapters/api.mjs   (typedefs of §10.1)
export function validateAdapter(mod): string[];       // [] when the module satisfies SourceAdapter
// ── server/adapters/registry.mjs
export const ADAPTER_MODULES: Record<string, string>;  // 'cipher.books' → './cipher/books.mjs', … (all ids of §6.2, §10.2, 'demo')
export async function loadAdapter(id): Promise<SourceAdapter>;
export function registerAdapters(db): void;            // upserts source_adapter rows from each module's metadata

// ── src/shared/dates.mjs
export function dayFromYMD(y, m = 1, d = 1): number;   // days since 1970-01-01, proleptic Gregorian, astronomical year; uses setUTCFullYear
export function ymdFromDay(day): { y, m, d };
export function parseDate(raw, { circaRadius = 5, openRangeYears = 50, twoDigitCentury = null, zeroIsUnknown = false,
                                 negativeYearConvention = 'historical', now = new Date() } = {}): DateParse | { issue: DateIssue };
//   DateParse = { lo_day, hi_day, lo_year, hi_year, precision, basis, approx, rule, raw, label, warnings: string[] }
export function fromInterval(loYear, hiYear, { precision, basis, rule = 'interval', raw = null, approx = 0 }): DateParse;
export function formatDateLabel(p): string;            // 'c. 1894', '1990s', 'Apr 1931', '500 BCE', 'early 20th century'
export function yearLabel(astroYear): string;          // -499 → '500 BCE'; 0 → '1 BCE'
export const LEVELS;                                   // [{level:0,name:'millennium',width:1000},…,{level:3,name:'year',width:1},{level:4,name:'month'},{level:5,name:'day'}]
export function binOf(year, level): number;            // Math.floor(year / width)
export function fits(yLo, yHi, level): boolean;
export function tierForPpy(ppy): 'L0'|'L1'|'L2'|'L3'|'L4'|'L5';
// ── src/shared/tokenize.mjs
export const TOKENIZER_VERSION = 'u61m-1';
export const FTS_TOKENIZE = "unicode61 remove_diacritics 2 categories 'L* N* Co M* So'";
export function foldToken(raw): string;
export function tokenize(text): { tokens: string[], starts: Int32Array, ends: Int32Array };
export function normString(text): string;              // folded tokens joined by ' '
export function findSequence(tokens, seq, from = 0): number;
export function ftsPhrase(seq): string;
export function isSentenceInitial(text, start): boolean;
// ── src/shared/ids.mjs
export function ref(type, id): string;  export function parseRef(s): { type, id };
export function slugify(s, max = 48): string;  export function shortHash(s, n = 4): string;
export function fnv1a32(input /* string | Uint32Array */): number;  export function mulberry32(seed): () => number;
export function canonicalJson(obj): string;  export async function sha256Hex(input): Promise<string>;
// ── src/shared/viewstate.mjs
export const VIEWSTATE_VERSION = 1;
export function defaultState(corpus = 'demo'): ViewState;
export function canonicalize(state): ViewState;
export function encode(state): string;                 // URL hash of §8.2
export function decode(hash): ViewState;               // validates, migrates, fills defaults; never throws (bad → default + warning)
export function stateHash(state): string;
// ── src/shared/format.mjs
export function formatCount(n): string; export function formatTokens(n): string /* '41.2k', '6.1M' */;
export function formatRate(rate, unit): string; export function formatCI(ci, unit): string; export function unitLabel(unit): string;
// ── src/shared/evidence-style.mjs
export function edgeStyle({ evidence_status, review_status, provenance_quality, family, cue, is_synthetic, date_conflict }):
  { dash: number[], width: number, endpoint: 'dot'|'square'|'question', badge: string, hue: 'amber'|'violet'|'ivory2'|'danger',
    opacity: number, strike: boolean, overlay: null|'check'|'cross'|'scales', synthetic: boolean };
export function binStyle({ state, flags }): { fill, outline, pattern: null|'hatch'|'stripes'|'dots'|'syn', superscript: null|'¹', opacity };
export const LEGEND_ROWS;  export const BADGES;
// ── src/shared/vocab.mjs     closed vocabularies (EVIDENCE_STATUS, REVIEW_STATUS, ORIGINS, REL_TYPES rows of §3.1,
//    REL_FAMILIES, DATE_ROLES, PRECISIONS, BASES, CHRONO_STATUS, DOC_KINDS, FIELD_CLASSES, TIME_ROLES, QUALITIES,
//    LANE_FACETS, STEMM_LANES, UNITS, MODALITIES, SAMPLINGS, JOB_TYPES {type: {writes, priority, owner}}, STAGES,
//    GATE_CODES, ISSUE_CODES {code: {severity, template}}, DIMENSIONS, SCORE_KINDS, MENTAL_STATE_VERBS)
// ── src/shared/contracts.mjs
export const CONTRACT_VERSION = '1.0.0';
export const SHAPES;                                   // minimal runtime schemas (required keys + types) for every §7 response and Canonical* input
export function check(shapeName, obj): string[];       // [] when valid; used by tests/helpers/shape.mjs and mock mode

// ── src/ui/core/store.mjs
export function createStore(initial /* ViewState */): { get(): AppState, dispatch(action): void, subscribe(selector, fn): () => void };
//   AppState = { view: ViewState, ui: { hover, toasts, jobs, coach, sheet } }  (only `view` goes to URL/saved views)
//   actions: SET_CORPUS PIN_STRAND UNPIN_STRAND SET_LANES SET_FILTER SET_TOGGLE SET_AXIS SET_TIER SET_VANTAGE SET_RANGE
//            SET_EVIDENCE SET_LAYER SELECT OPEN_PANEL CLOSE_PANEL SET_COMPARE SET_RUNS LOAD_STATE SET_REDUCED_MOTION UI_*
// ── src/ui/core/url.mjs        export function bindUrl(store): () => void;
// ── src/ui/core/api.mjs        export function createApi({ base = '/api', sessionId }): Api;
//   Api = { get(path, query?, { signal, key }?), post(path, body, opts?), put, patch, del, upload(path, file, headers, onProgress),
//           sse(path, handlers): () => void }   // `key` aborts the previous request with the same key; errors throw ApiError {status, code, message, hint}
// ── src/ui/core/keys.mjs       export function createKeys(): { register(scope, map): () => void, setScope(scope): void, handle(evt): boolean };
// ── src/ui/core/dom.mjs        export function h(tag, props, ...children): HTMLElement; export function clear(el); export function trapFocus(el): () => void;
// ── src/ui/core/announce.mjs   export function announce(text, { politeness = 'polite' } = {}): void;   // ≤ 1/s
// ── src/ui/registry.mjs        export const MODULES; export function mountApp(root, ctx): void;   // ctx = { store, api, keys, announce }
//   Every UI module: export function mount(el, ctx): { unmount(): void }
```

**`public/index.html`** mount points: `#ribbon #toolbar #minimap #lanes #shelf-undated #scroll
#shelf-scheduled #legend #inspector #panel #sheet #toasts #a11y #tour #jobs`; all six stylesheets linked;
one `<script type="module" src="/ui/main.mjs">`.

**WP0 also delivers:** `tests/contract/*.json` — a canned response for **every** endpoint of §7
(including gated, empty and error variants); `SCROLLS_MOCK=1 npm start` serves them (UI packages build
against them from day one; `tests/helpers/shape.mjs` validates real responses against the same shapes);
`tests/fixtures/mini/` (12 documents en/fr/es/hi/gu with known offsets and dates); `Docs/API.md` (§7 +
fixture index); `package.json` scripts `start`, `test`, `test:cipher`, `bench`, `bootstrap`, `build:nl`,
`build:demo`, `verify`.

**WP0 done when:** `npm test` passes the WP0 tests (schema executes verbatim and its CHECKs/triggers fire;
≥ 90 date cases; tokenizer parity on the mini corpus; DocumentWriter imports the mini corpus with offset
invariants and `doc_bin`/`doc_tokens` correct; `_noop` job cancels ≤ 500 ms; read-pool timeout respawns;
security 403s; viewstate round-trip; copy-rule scanner runs); `SCROLLS_MOCK=1 npm start` serves every
endpoint and the shell loads with no 404 and no console error.

### 12.3 Shared contracts every package consumes (frozen at WP0 merge; additive changes only, by the WP0 owner)

```js
/** CanonicalDocument — what parsers and adapters hand to DocumentWriter */
{ ext_id, kind, title?, native_title?, author?, genre?, community?, culture?, field?,
  lang_declared?, source_url?, license?, prominence?,
  text?: { original: string, decoder: 'utf-8'|'windows-1252'|'pages-joined-ff', body_start?, body_end?,
           regions?: [{ start, end, quality?, time_role?, field_class? }], mode?: 'auto'|'prose'|'verse' },
  fields?: { title?, native_title?, summary?, abstract?, gloss?, entry? },     // metadata text fields, verbatim
  field_roles?: { summary?: 'describes', abstract?: 'document' },              // time_role per field
  dates: [{ role, raw?, parsed?: DateParse, asserted_by, is_chronology?: boolean, note? }],
  aliases?: [{ ext_id, title?, note? }],
  tags?: [{ scheme, value, weight?, provenance, method }],
  original_meta: object,                 // verbatim source record (bulk text replaced by a pointer)
  source_file?: { sha256, byte_start, byte_end } }

/** CanonicalRelationship */
{ src: { collection?, ext_id } | { ref }, dst: { collection?, ext_id } | { ref },
  rel_type, evidence_status: 'documented'|'computed'|'proposed', origin: 'source_dataset'|'algorithm'|'machine_tagger'|'human',
  source_dataset?, source_locator?, provenance_quality?: 'complete'|'source_unrecorded', method?, run_id?, created_by,
  score?: { value, kind }, hypothesis_group?: { key, question }, evidence?: [{ role, ext_id?|passage?, start?, end?, quote? }],
  license?, attribution?, provenance_note? }

/** CanonicalAnnotation */
{ target: { type, ext_id? | ref? }, anchor?: { field, start, end, quote }, kind, author, is_machine, method?, run_id?,
  layer?, body_md, stance?, dimensions?, tags?, evidence_refs?, supersedes_key? }

/** Issue */  { code, severity: 'info'|'warning'|'rejected'|'fatal', line?, col?, field?, value_excerpt?, message, suggestion }
```

Also frozen: the schema (§3), the API shapes (§7 + fixtures), `vocab.mjs`, `dates.mjs`, `tokenize.mjs`,
`viewstate.mjs`, `evidence-style.mjs`, `tokens.css`, the offsets contract, the route/task/UI module
contracts above. A package that needs a contract change files it with the WP0 owner, who makes it
additively, bumps `CONTRACT_VERSION` (minor) and updates the fixtures in one commit.

### 12.4 Parallel packages (start together after WP0; each finishes its **P1** slice first)

| WP | Owns (see tree) | Consumes | P1 — vertical slice | P2 — after M1 | Own tests | Acceptance checks |
|---|---|---|---|---|---|---|
| **WP1 Ingestion** | `server/ingest/*`, `routes/imports.mjs`, `tasks/{import,revert}.mjs`, `src/ui/import/*`, `styles/import.css`, `tests/ingest.*`, `tests/fixtures/ingest/*`, `Docs/IMPORT-SCHEMA.md` | DocumentWriter, dates, tokenize, contracts, jobs, fixtures | TXT/MD/CSV/TSV/JSON/JSONL parsers, sniffing + decoding, mapping + suggestions, validate dry-run, commit job, summary, problems.csv, the 4-step wizard | revert, line mode, mapping reuse, 2 GB streaming | `ingest.formats`, `ingest.mapping`, `ingest.malformed`, `ingest.dupes` | §11 rows 1 and 9 pass; a 50 MB CSV dry run ≤ 10 s; the wizard renders every import fixture incl. errors |
| **WP2 Sources & demo** | `server/adapters/{cipher,stemm,demo}/*`, `routes/{corpora,adapters,tour,baseline}.mjs`, `tasks/{bootstrap-cipher,adapter-load,demo-load}.mjs`, `data/**`, `scripts/{bootstrap-cipher,build-demo,check-demo-names}.mjs`, `tests/{adapters.*,cipher-mapping,demo,demo-names}`, `Docs/CIPHER-MAPPING.md` | DocumentWriter, adapter API, dates, vocab | demo generator + anchors + loader (§9) and tour.json; `cipher.works`, `cipher.books` (+ `gutenberg-text.mjs`), `cipher.wikisource`, `cipher.roots`, `cipher.themes`, siblings mapping with tag provenance; bootstrap phases A + B; corpora/facets/tour routes | `cipher.relations` (genealogy), the four STEMM adapters + Adapters route + baseline route | `adapters.cipher`, `adapters.stemm`, `cipher-mapping`, `demo`, `demo-names` | reconciliation counts (§6.8); demo calibration (§9.6); phase A ≤ 30 s, full bootstrap ≤ 10 min; zero name collisions |
| **WP3 Search, aggregation & exports** | `server/text/{variants,translit,names,kwic}.mjs`, `server/aggregate/*`, `server/export/*`, `routes/{search,expressions,timeline,passages,documents,kwic,exports}.mjs`, `tasks/{materialize,export}.mjs`, `scripts/bench.mjs`, `tests/{aggregate.*,offsets,search,exports}` | schema, tokenize, dates, read pool | search with typed suggestions, expressions + variants (en/fr/es/hi/gu, orthographic), materialize + `expr_doc`, tiles/washes/marks/shelves/bin drawer/coverage/seams, passages, documents, KWIC, proper-noun guard, JSON/JSONL/CSV exports with manifest | arcs endpoint + bundling, transliteration, very-frequent path, portable HTML bundle, snapshot storage, bench | `aggregate.binning`, `aggregate.invariants`, `offsets`, `search`, `exports` | §11 rows 2–4 pass; conservation holds at every tier; tile p95 warm ≤ 80 ms on the full Cipher DB (bench) |
| **WP4 Analysis** | `server/analysis/*`, `routes/{compare,collocations,clusters,analysis,constellation}.mjs`, `tasks/{tokstream,collocations,vectors,cluster,drift,tone,layout}.mjs`, `tools/nl-adapter/*`, `tests/{analysis.*,gates}`, `Docs/ANALYSIS-AND-LIMITS.md` | expr_doc/occurrence tables (fixtures until WP3 lands), read pool, jobs | Compare endpoint (multiplicity, coverage/composition/modality/prominence, frequency + CIs, passages, gates with suggestions), collocations + keyness, token streams | TF-IDF fallback, PPMI + rSVD, era slices, Procrustes, occurrence vectors, clustering + stability + labels + transitions + convergence, drift measures, constellation + layout, NL adapter | `analysis.stats`, `analysis.cluster`, `analysis.vectors`, `gates`, `analysis.responsiveness` | §11 row 7 passes; demo clustering ARI ≥ 0.8; an en vectors run completes and cancels cleanly; no main-thread stall |
| **WP5 Lineage & provenance** | `server/lineage/*`, `server/provenance/*`, `routes/{lineage,genealogy,relationships,hypotheses,trace,annotations,views}.mjs`, `tasks/{boilerplate,reuse-index,trace,gc-runs}.mjs`, `tests/{lineage.*,provenance,persistence,anchors}` | schema, token streams (`analysis/tokstream.mjs` import), read pool, jobs | annotations (revisions, reinterpret, as-of, anchors), saved views (immutable, as-saved, drift report), relationship review + human proposals, hypothesis groups, **boilerplate pass** (needed by bootstrap phase B) | winnowing reuse index, near quotes, cues, targeted trace, lineage graph + path + commonplace node, genealogy | `provenance`, `persistence`, `anchors`, `lineage.winnow`, `lineage.cues`, `lineage.graph` | §11 rows 6, 8 and the canary pass; on the demo the detector finds A11→A4, A20→A3, A13→A3 (proposed + CUE) and creates no documented edge |
| **WP6 Timeline UI & shell** | `src/ui/{shell,timeline,tour}/*`, `styles/{shell,timeline}.css`, `tests/{ui.timeline.*,ui.layout,ui.a11y-table}` | core UI, shared modules, contract fixtures (mock mode) | shell (toolbar, search, filters, lanes menu, ribbon, toasts, help, jobs chip), the Scroll: linear axis, tiers, tiles client, model/display/paint, bars/caps/censoring, washes, shelves, coverage track, marks + override, hit-testing, playhead/play/reduced motion, keyboard, touch, a11y table, legend, bin drawer, minimap, modality seam | arcs + bundles + feedback, folded overview, split/merge glyphs, etymology bands + listed-roots bracket, claim diamonds, baseline track, PNG/SVG snapshot, tour + coach marks, perf HUD | `ui.timeline.model`, `ui.timeline.display`, `ui.timeline.scale`, `ui.layout`, `ui.a11y-table` | renders every timeline fixture incl. pending/low/uncovered; perf HUD ≤ 8 ms p95 at 20k rects on synthetic tiles; first paint ≤ 1.2 s (demo) |
| **WP7 Panels UI** | `src/ui/panels/*`, `styles/panels.css`, `tests/ui.panels.*` | core UI, shared modules, contract fixtures | passage card, Then/Now/Next inspector, date chip, reader, Compare view + gate cards, views menu (save, open, as-saved banner), jobs tray, export menu | lineage explorer, genealogy, constellation (+ worker), edge card + review actions, notebook + annotation editor + revisions, Crossings card, Adapters page | `ui.panels.inspector`, `ui.panels.compare`, `ui.panels.lineage`, `ui.panels.notebook` | every panel renders all fixtures incl. gated, empty and error; a gated payload renders no numeral; narrow-layout sheets work without hover |

### 12.5 WP8 — INTEGRATION (last; the WP0 agent may take it)

Owns `README.md`, `Docs/HANDOFF.md`, `Docs/VERIFICATION.md`, `scripts/verify.mjs`, `src/ui/selftest.mjs`,
`tests/e2e/*`, `tests/e2e.journey.test.mjs`, `tests/acceptance.*.test.mjs`. Runs the full journey on the
demo and on Cipher at 1440×900 and 375×812 in the Browser pane (screenshots to
`$SCROLLS_DATA/cache/verify/`), runs `npm test`, `npm run test:cipher`, `npm run bench`, and writes the
handoff: setup, supported import schema (link), analysis + limits (link), **what works / what needs the
optional NL adapter or a staged source / what is unfinished**. In this phase file ownership lapses: the
integrator may patch any file and records every patch (file, reason, test) in `Docs/VERIFICATION.md`.

### 12.6 Order, milestones, coordination

1. **Phase 0 — WP0 alone.** Exit: WP0 done criteria (§12.2).
2. **Phase 1 — WP1…WP7 in parallel, P1 first.** **M1 = the brief's vertical slice**: import a file →
   search → timeline with honest bars, washes, shelves, coverage and seam → open the passage (THEN column)
   → Compare with coverage + frequency + gates → save view → restart → reopen. Exit: §11 rows 1–5, 8, 9
   pass; the demo and Cipher phase A/B load.
3. **M2 lineage** (WP5 P2 + WP6 arcs + WP7 lineage/genealogy + WP2 `cipher.relations`) — exit: §11 row 6
   and lineage tests.
4. **M3 contextual clustering** (WP4 P2 clustering + WP6 cluster lanes/branches + WP7 Compare clusters).
5. **M4 constellation + notebook** (WP4 constellation, WP7 notebook/constellation).
6. **M5 STEMM + advanced** (WP2 STEMM adapters, WP4 vectors/drift/tone, WP6 baseline/claims) → **Phase 2
   — WP8.**

**Rules:** no package edits another package's files; packages communicate only through the schema, the
HTTP contracts, job types, the read-query function convention and the shared modules; a missing contract is
reported to the WP0 owner (additive fix + fixture); every package keeps `npm test` green for its own tests
and must not break others' (run the full suite before declaring done).

---

## 13. Honesty rules — checklist every package follows (reviewers reject code that breaks one)

1. **Never fabricate** passages, lyrics, citations, dates or links. Invented material exists only in the
   `demo` corpus, flagged `is_synthetic=1`, and is labelled in every rendering, copy, export and snapshot.
2. **Every mark resolves to text** (≤ 2 clicks) or to a labelled statement of why there is none; every
   aggregate prints its denominator, unit and coverage.
3. **Gaps are never bridged**: `absent` ≠ `low` ≠ `uncovered` ≠ `pending`; animation never interpolates.
4. **Fit-or-wash:** a record counts in a bin only if its interval fits; otherwise it is a wash; undated
   and scheduled items never enter rates; the conservation law holds.
5. **Evidence status is fixed at creation by origin.** `documented` only from an external record with a
   locator (or `source_unrecorded`, shown `DOC*`); human review is an overlay that never changes the line.
6. **Similarity never establishes** influence, ancestry, intent, feedback arcs or documented status;
   attribution cues are `proposed` + CUE.
7. **Gated metrics have no value** (DB CHECK); the UI shows gate, needed, have and a computed suggestion —
   never a numeral.
8. **No unaligned comparisons**, no cross-modality and no cross-cell (OpenAlex) rate claims by default;
   composition and prominence caveats fire automatically; repeated comparisons are disclosed and the
   notable threshold is adjusted (100 − 5/k).
9. **Default exclusions are visible:** translations, retrospective descriptions, editorial apparatus,
   boilerplate, furniture, duplicates and proper-noun-guard hits are excluded by default and counted.
10. **Machine output is a fallible annotation with its method** (tags, glosses, tone, cluster labels,
    OpenAlex topics); machine labels stay visible after a human renames them.
11. **Words:** "first observed in this corpus" (never "coined"/"born"); "estimated shift in usage contexts"
    (never "the meaning changed"); "context words, not meanings"; no mental-state verbs about historical
    people (`MENTAL_STATE_VERBS` scanned by `ui.copy.test.mjs`).
12. **Etymology is periods, not dates**; multi-parent root lists are never auto-drawn as competing
    hypotheses or as one parent.
13. **Empty states are computed**, with variants tried, and say "0 is an observation about this index".
14. **Selection is declared:** prominence-selected, curated, top-cited and relation-endpoint collections
    say so in lane headers and Compare.
15. **Licences travel with data:** `export_text_allowed=0` is respected in every format; attributions
    (Wiktionary CC BY-SA, ItwoFS CC BY 2.5 link-back, Ngram CC BY 3.0, OpenAlex CC0) appear wherever values
    do.
16. **Local only:** the app makes no network request; fetchers are user-run scripts; optional services
    are opt-in and labelled.
17. **Reproducibility:** every computed row has a run with versions (tokenizer, segmenter, ICU, params,
    data); saved views pin runs and never silently upgrade.
18. **Time arithmetic:** never `Date.UTC` for years 0–99; never draw a year-precision item at 1 January;
    BCE is astronomical internally and labelled historically.

---

## 14. v1 scope vs later

| Area | v1 (this build, in milestone order) | Later (stated as unfinished in HANDOFF) |
|---|---|---|
| **M1 vertical slice** | demo + Cipher metadata-first + full-text bootstrap; TXT/MD/CSV/TSV/JSON/JSONL import with mapping wizard; search (expression/work/maker/theme); the Scroll (linear axis, tiers, bars, washes, shelves, coverage, seam, minimap, playhead, reduced motion, keyboard, touch, a11y table); Then column + reader; Compare (coverage, composition, modality, prominence, frequency, passages, collocates, gates, multiplicity); saved views (immutable, as-saved); JSON/JSONL/CSV exports | PDF/EPUB import; multi-user |
| **M2 lineage** | boilerplate pass; winnowing reuse index; near quotes; attribution cues; targeted trace; lineage explorer with hypothesis groups, chain of custody and commonplace node; **genealogy** with `cipher.relations`; review actions; arcs + feedback + date conflicts on the Scroll | cross-language reuse detection; MusicBrainz `l_recording_recording` full chains and `recording_years` date recovery for the 4,090 undated songs (as non-chronology alternate assertions) |
| **M3 contextual clustering** | TF-IDF-hash fallback; pooled PPMI-SVD per language; spherical k-means with stability, labels, transitions, convergence; cluster lanes and branches | sense-level external baseline |
| **M4 constellation + notebook** | stable-layout constellation with two-period comparison; notebook with revisions, layers, as-of slider, dimensions, compare interpretations; Then/Now/Next Next column + hypotheses; Crossings card | collaborative annotation |
| **M5 advanced (optional parts)** | era slices + Procrustes displacement + neighbour overlap with controls; Apple NL adapter (tone, modern-reader neighbours); STEMM adapters: gutenberg-stemm, OpenAlex (within-cell shares), Wiktionary claims, Ngram baseline; folded overview; portable HTML bundle; PNG/SVG snapshots | Wikidata date refresh for Cipher books (network, opt-in); OpenAlex random re-sample (would allow cross-cell rates); 2–5-gram baseline for phrases; Hindi/Gujarati lemmatization and exact ISO-15919 transliteration; any embedding model beyond Apple NL |
| Never | automatic irony/stance detection; a single "meaning score"; feedback or influence from similarity; lyrics for real songs | — |

---

## Appendix A. Ambiguities in the brief, decided (one line each)

- **"4D"** = Time × Lane × Strand × Transmission; vantage is the reading clock on Time — reinterpretation needs a time of reading, not a fifth axis.
- **"Infinitely scroll"** = unbounded pan within 10000 BCE–2100 CE plus labelled zoom to 40 px/day; truly unbounded time only adds empty space.
- **A gantt bar** = a run of observed bins; first/last observation caps; gaps drawn as gaps — the only honest reading of "span".
- **"Expression"** is created lazily when a query is tracked; precomputing every type in 70M tokens is waste.
- **Offsets** are UTF-16 code units; both runtimes slice natively.
- **"19th century"** means 1800–1899 in user input; it fits the century bin and matches common usage.
- **"Community"** is not Cipher's `culture` (a country of origin); community is an import/demo facet.
- **Song "occurrences"** are title matches per 1,000 works; Cipher holds no lyrics.
- **Translations** are excluded from text-language chronology by default; their text was not written in the original's year.
- **Retrospective descriptions** (Wikidata summaries, Cipher glosses) are `describes` and excluded from frequency.
- **Attribution cues** are proposed, not observed: the span is verifiable, its referent is inferred.
- **The demo** may contain verse text only because it is synthetic; real Cipher songs stay metadata-only.
- **Coverage gates** are per collection (default 50,000 tokens; demo 2,000, declared in its legend) so a small synthetic corpus can show rates while saying how thin they are.
- **First launch** auto-imports Cipher metadata (local files only), because the user's own data must appear in the first minute; `SCROLLS_NO_AUTO_IMPORT=1` disables it.
- **Kindred and counterpart** are similarity edges hidden from lineage by default; neither is transmission.
- **OpenAlex citations to later-dated works** are date conflicts, not feedback.
- **Sense clusters** are per expression across all time in one representation, so shares are comparable without alignment.
- **Saved views are immutable**; a shared link must never change under its reader.
- **Port 3460, loopback only**, to stay clear of spectra-lab (3002) and orbital-atlas (3001).
- **Dark theme only**; the brief specifies a dark observatory.

## Appendix B. Judged flaws and gaps → where this spec fixes them

| Flaw / gap (judges) | Fix |
|---|---|
| fr/es Gutenberg books that are English | §0.1, §4.3 langid + `is_translation`, §6.3, default exclusion (D8) |
| Culture summaries counted as period usage | `time_role='describes'` (D9, §6.5) |
| Wrong hard-coded empty states (hacker/algorithm) | measured counts with variants (§0.1), computed empty states (§8.8), token not substring counting |
| Year rule ('' vs 0; dates after 2026) | §0.1, §5.3, §6.5, Scheduled shelf |
| OpenAlex abstracts exported | `export_text_allowed=0` (§7.3) |
| No strategy for very frequent expressions | vocab-instance counts + stratified samples (§4.6) |
| Philologist DDL `UNIQUE(… IFNULL …)` | unique index; whole DDL executed (§3) |
| "Thackeray" substring false positive | trigram for typeahead only (§4.4) |
| WP1/WP2/WP3 seam on passages.mjs; router collisions | segmentation in WP0; auto-registered routes/tasks; stubs (§12) |
| 16 px strands read as an instrument panel | visual layer §1.4 (40 px lanes, chips only on hover) |
| Engineer fabricated *signale* PIE roots; *virus* roots wrong | measured roots facts (§0.1); listed-roots semantics (§1.7, §6.7) |
| Engineer ignored staged STEMM files; wrong formats | adapters read FORMAT.md/MANIFEST first (§10) |
| "2 files missing" vs #1661 ×3 | 691 files, 1 doc + 2 aliases (§6.3) |
| `human_confirmed` overwrote evidence | immutable status + review layer (D7, §3 trigger) |
| Multi-parent roots assumed competing | `parent_semantics` measured classes (§6.7) |
| `observed` regex cues looked documented | cues are `proposed` + CUE (D7, §4.7) |
| Demo clustering vs space gate contradiction | TF-IDF-hash fallback, recorded on the card (§4.8) |
| Demo displacement "passes" falsely | tour shows displacement refused (§9.7 step 7) |
| Exact-marker stripping leaves licence "virus" | three regexes + boilerplate pass + canary (§4.3, §4.7, §11) |
| Heavy SQL on the main thread; JS Map > 16.7M | read pool + typed-array tables (§4.12, §4.8) |
| Engineer's documented guard incomplete | CHECKs bind `documented` to `source_dataset` (§3) |
| Gap: sampling genealogy view | Genealogy (§2.C2) + `cipher.relations` (§6.6) |
| Gap: start from artist/work/theme | query types (D16), theme strands (§1.2) |
| Gap: themes as strands | §1.2 theme strands by provenance |
| Gap: the 1928 cliff | modality seam (§1.10) + `modality_mismatch` gate |
| Gap: user's data in the first minute | metadata-first auto import (D10, §6.8) |
| Gap: OpenAlex cross-cell rates | within-cell shares, `sampling_design` (§10.4) |
| Gap: synthetic/real name collisions | collision check + test (§9.1) |
| Gap: romanized Indic, Hinglish | `und-Latn`, transliteration keys (§4.5) |
| Gap: unused MusicBrainz/relations data | `cipher.relations` (v1); MB tables (later, §14) |
| Gap: portable sharing | self-contained HTML bundle (§7.3) |
| Gap: Ngram 1-grams only | "single words only" state (§1.7, §10.2) |
| Gap: later editions/editorial text | apparatus detection (§4.3) |
| Gap: selection by prominence | `sampling`/`selection_note`, prominence terciles in Compare (§2.E) |
| Gap: thin STEMM data | gutenberg-stemm imports what exists and reports dated/estimated/undated (§10.2) |
| Gap: fragile annotation anchors | `anchor_json` + re-anchoring test (D18, §11) |
| Gap: repeated slicing | `compare_log`, multiplicity line and threshold (§2.E, §4.9) |
| Gap: flawed OpenAlex inputs | `gappy` quality, modern-classifier notes (§10.2) |
| Gap: Hindi/Gujarati morphology | oblique/postposition + orthographic variants on by default (§4.5) |
| Gap: WAL starvation, FTS size | WAL policy (§4.12); measured FTS size/time (§0.1) |
| Gap: undated share bias | ⚠ when ≥ 20% undated + undated-vs-dated composition (§1.7) |
