# Scrolls — A Living Atlas of Meaning
## Architecture proposal: the evidence-first cut ("philologist")

Status: proposal 1 of 3 · 2026-10-03 · covers everything needed to build v1 · no code written.

The rule behind this proposal: **every pixel has to answer three questions: what is the evidence, how was it obtained, and how much of the record did we look at?** Four invariants follow from that rule. The schema, the API and the renderer each enforce all four:

- **I1. No continuity without observation.** Nothing is drawn across a bin that has zero observations. "Looked and found none" and "no sources" look different from each other.
- **I2. Every mark resolves to text.** Every occurrence mark opens a passage with offsets into the original text. Every edge has evidence rows. Every aggregate shows its denominator.
- **I3. Evidence status is set once and stays visible.** A relationship's `evidence_status` is fixed when the relationship is created, and a database trigger blocks any later upgrade. Human review is a separate layer. Status is shown by line pattern, glyph and a word, never by colour alone.
- **I4. Estimates are gated.** Anything beyond counting is computed only when its minimum-evidence gate passes. Otherwise the UI shows the gate and what is missing.

---

## 0. What I checked on disk, and what it changes

All checks below ran on 2026-10-03 against the files the inventory names.

| Finding | Consequence in this design |
|---|---|
| **98 of the 170 Gutenberg books labelled `fr`, and 10 of the 130 labelled `es`, are English text.** I checked with a stop-word profile over the middle third of each book; examples are #135 *Les Misérables* and #19942 *Candide*. Two books labelled `en` are French (e.g. #56586 *Oliver Twist*). The `year` is the original work's year. `culture-lines.tsv` inherits the mislabel: the line "virus 1841 fr *Le Curé de village*" is an English sentence. | The schema stores `document.lang_declared` and `lang_text` (detected) separately, plus `is_translation`. The year becomes `role='original_publication'` and the translated text itself is **undated**. Translations are left out of text-language chronology by default; a toggle includes them, dated by the original. |
| **116 of 693 years equal author birth + 40** in `pg_catalog.csv`, which is Cipher's `lifetime_year` rule. Some coincide with the true year anyway (*Emma* 1815). | These get `basis='estimated'`, `rule='cipher_lifetime_year'` and the note "may coincide with the true date". They are drawn with dashed whiskers. |
| **Gutenberg #1661 appears 3× in `gutenberg.json`** (three Wikidata QIDs share one text). **31 files lack the exact `*** START OF` marker**: 28 have `***START OF` with no space, and 3 use the old "SMALL PRINT" header. | Duplicates are collapsed by text hash and recorded in `document_alias`. The header stripper uses three marker regexes, with a fallback and a warning. |
| **`culture-works.tsv` has no header row, and unknown years are the EMPTY string (8,227 rows), not `0`** as the inventory says. Years run from −300 to 2038. At least 10 rows are dated after today (the 2028 Olympics, *Shrek 5* in 2027). | The parser accepts both `''` and `0` as unknown. Future dates get `chrono_status='scheduled'`, `basis='announced'` and go on a right-hand Scheduled shelf. |
| **SQLite's default `unicode61` tokenizer breaks Devanagari and Gujarati words apart** (`अनुपम` becomes `अन` + `पम`). With `categories 'L* N* Co M*'` the words stay whole. I tested this in node:sqlite 3.53.4. | Every FTS table uses `unicode61 remove_diacritics 2 categories 'L* N* Co M*'`, and the JS tokenizer reproduces it exactly. A parity test enforces this (§11). |
| **The Wikisource `year` can be an edition year.** *आज भी खरे हैं तालाब* has year 2004, which is its 5th edition; the first-edition year (१९९३) is printed in Devanagari digits on page 1. hi has 42 undated books and gu has 172; dated books run 1683–2023. | These dates get `role='publication_unspecified'`. Devanagari and Gujarati digits are mapped to ASCII in normalized forms and in the date grammar. |
| **The unsourced (`-`) siblings come from five different code paths in `build_culture.py`:** Wikidata P144/P941/P4969 properties, Wikipedia lead parsing, Wikipedia remake/format tables, the Claude tagging pass (matched by title ±2 years), and "kindred" (rarity-weighted theme cosine ≥ 0.42, capped at 0.7). | Their provenance can be reconstructed. A `-` link that appears among the `siblings` in `$T/tags/*.jsonl` for either end is **proposed**. Kindred links are **computed**. The rest are **documented** with `locator_status='missing'`. |
| **The raw relation files carry a `page` field** (Wikipedia article, MusicBrainz recording URL, ItwoFS page). | These are joined back as `source_locator` for `w`/`m`/`i` links. |
| **`roots.tsv` has only four source languages:** la 28,927 · sa 9,788 · grc 9,183 · ine-pro 7,091. Members: en 58.7k · fr 17.1k · es 13.7k · hi 10.8k · gu 3.0k. | Words of Germanic, Arabic or unknown origin (*bug*, *hacker*, *algorithm*) have **no** deep-time band. The UI says so instead of guessing. |
| **OpenAlex is staged.** 118,466 works, which are the top 200 most-cited per cell over 20 fields × 30 time bins. 60,574 have abstracts (about 9.9M tokens). There are 381,800 in-sample citation pairs, and **6,666 of them cite a work dated later than the citing work**. About 13k works are German. The fetcher downgrades `-01-01` dates to year precision. | `population.tsv` is used as context and lanes are labelled "top-cited sample". Citations to later-dated works are drawn as **date conflicts**, never as feedback arcs. Abstracts are licensed for local research only, so they are left out of exports. Language ID must include `de`. |
| **Apple NLEmbedding is English-only** (dim 300, vocab 57k) and is a static modern model. | It is offered only as a "modern reader model" for neighbour suggestions, and never used for drift. |
| **Song themes and summaries are written later than the songs.** A Wikidata summary like "2009 film directed by …" is written by later editors, and `meaning`, `motifs` and `mood` were written by Claude in Oct 2026. "computer" matches 566 works, mostly via "computer-animated film". "gene" matches 71 works, mostly people named *Gene*. | Metadata passages carry a `time_role`. **Titles** are dated with the work. **Summaries and glosses** are retrospective descriptions and are left out of frequency and drift by default. Tag fields are machine annotations, not text. |

---

## 1. The 4D Gantt

### 1.1 The four dimensions

| Dim | Name | What it is | How it is encoded |
|---|---|---|---|
| **D1** | Document time | The interval in which the text was produced: `[t_lo, t_hi]` plus precision, basis and role. | x position. Intervals are drawn as spans, never as points. |
| **D2** | Lane | A categorical partition of the evidence, on a facet the user picks. | Horizontal bands. Each lane header shows label, unit and ordering rule. There is no y-axis. |
| **D3** | Strand | Which expression, variant group or sense hypothesis (up to 4 superposed). | Sub-rows inside each lane, each with a glyph (● ▲ ■ ◆), a letter A–D and a label chip, in ivory. |
| **D4** | Vantage time | The "as of" date: what the record contained by then, and how it had been reread. | The playhead. Marks after the vantage are hidden (strict) or ghosted at 15% (context). Edges and reinterpretations appear once both ends are ≤ vantage. |

**Why vantage is the fourth dimension:** the brief says later works change how earlier ones are read. Showing that needs a time of *reading* separate from the time of *writing*, and the playhead is that second clock.

Annotations have their own creation time. The notebook's "as of" slider (§2F) is the same D4 applied to human interpretation.

### 1.2 What a bar is

At a given zoom tier, a strand in a lane is a sequence of bins. Each bin is in one of four states:

- `observed`: n ≥ 1.
- `absent`: n = 0 and coverage meets the gate. The gate is ≥ 50,000 tokens for text lanes and ≥ 30 works for metadata lanes.
- `uncovered`: coverage is below the gate.
- `coarse-only`: every observation in the bin comes from a date interval wider than the bin (see §1.7).

**A bar is a maximal run of consecutive `observed` bins.** A bar never bridges an `absent` or `uncovered` bin.

- An `absent` bin draws a 1 px dotted baseline. Its tooltip reads "0 occurrences in 4.1M tokens".
- An `uncovered` bin draws nothing in the strand, and the whole lane shows a hatched coverage gap.

**Caps** mark where a bar starts and ends:
- A square cap is a first or last observation inside covered time.
- An open chevron `◁` means **left-censored**: the first observation falls in the lane's first covered bin, so the expression may be older than our record. `▷` is the same at the right-hand end.

**Height.** Each strand is at most 16 px tall. Height is linear in the lane's rate unit, and the strand chip prints the scale ("height: per-million rate; full = 84/M"). Any observed bin is at least 2 px tall.

**Fill:**
- Solid ivory when n ≥ 10.
- 40% fill plus a 1 px outline when 1 ≤ n ≤ 9 ("sparse").
- A superscript `¹` when 60% or more of the bin comes from a single document ("single-source burst").
- Diagonal hatching when 30% or more of the bin's mass is fractional, i.e. comes from intervals wider than the bin.

**Units never mix.**
- Text lanes use **per million tokens of that lane's slice**.
- Metadata lanes (titles) use **per 1,000 works of that lane's slice**.
- The external baseline uses **per million (Google Books eng)**.

If a facet value mixes units (for example "English" covering both book text and song titles), it is split into two sub-lanes, "English · text" and "English · titles".

**Works mode.** When the selection is a work rather than an expression (for example the lineage of a sampled song), the lineage participants appear as work marks: points, or bracketed spans when the work itself spans time, such as a TV run from 1994 to 2004. Their glyph is distinct from strands.

### 1.3 Lanes

**Facets** the user can lane by:

| Facet | Meaning | Notes |
|---|---|---|
| `cluster` | Sense hypotheses | Needs a clustering run. |
| `kind` | book · song · film · tv · sport · channel · paper · abstract · user | |
| `culture` | Cipher's country of origin | Labelled "country of origin (Wikidata)", **not** "community". |
| `community` | Import field | |
| `language` | Detected at passage level | |
| `collection` | Source | |
| `field` | STEMM field (§10) | |
| `date_basis` | stated / estimated / announced / period | A diagnostic lane. |

**Ordering rules**, always shown in the lane header:
- First observed (the default).
- Total n.
- Alphabetical.
- Manual drag, which is saved with the view.

**Limits.** At most 10 lanes are shown. The rest collapse into a "+7 more lanes" row.

**Headers.** Each header reads `label · unit · coverage`, for example "English · text · 12.4M tokens, 1823–1928".

**Avoiding a meaning scale.** Several rules stop the vertical position from reading as a scale of meaning:
- Gridlines are drawn only between lanes.
- No tooltip mentions vertical position.
- The legend carries the line *"Lane order is a sorting choice (first observed), not a scale of meaning."*
- Cluster lanes show "machine label (editable)".

### 1.4 Time axis, infinite scroll, semantic zoom

**Viewport state.** The state is `{mode:'linear', centerDay, daysPerPx}` or `{mode:'segmented', preset:'deep'}`. Days are counted from 1970-01-01, using the proleptic Gregorian calendar and astronomical year numbering, where 1 BCE is year 0.

**Linear is the default.**
- Pan is unbounded within [10,000 BCE, 2100 CE].
- Zoom runs from about 1,700 days/px (the whole of 4500 BCE–2026 at 1,400 px) down to 1/40 day/px (40 px per day).

**Ruler.**
- Major ticks are labelled "1850" or "500 BCE".
- The right-hand end shows a scale caption ("1 cm ≈ 12.5 years"), computed from CSS centimetres.
- Day and year arithmetic never uses `Date.UTC(y,…)` for years 0–99, because it maps them to 1900+. A shared helper uses `setUTCFullYear` instead (see §3, `dates.mjs`).

**Segmented "Deep time" preset.** Opened with the ⇤ button or the `D` key, this is the *only* non-linear axis, and it says so on screen. It has four segments:

| Segment | Span | Share of width | px/year at W = 1,400 |
|---|---|---|---|
| A | 5000 BCE – 500 BCE | 15% | 0.047 |
| B | 500 BCE – 1500 | 20% | 0.14 |
| C | 1500 – 1900 | 25% | 0.88 |
| D | 1900 – 2027 | 40% | 4.4 |

How the preset behaves:
- Segments are separated by a 12 px zig-zag break, with badges "scale ×3.0", "×6.3" and "×5.0".
- Each segment has its own ruler caption.
- Marks that cross a break carry a break glyph.
- Tooltips never report a distance across a break.
- Panning is disabled.
- Any zoom gesture returns to the linear axis, centred on the gesture point, with a toast "Linear axis restored".

**No log scale is ever used for time.**

### 1.5 Level-of-detail tiers

The bin size is the smallest calendar unit that is at least 8 px wide.

| Tier | px/year | Bin | Strands drawn as | Other layers |
|---|---|---|---|---|
| L0 Millennia | < 0.08 | 1000 y | Presence bars (no heights) | Language-period bands; coverage sparkline |
| L1 Centuries | 0.08–0.8 | 100 y | Bins with heights | Period bands; documented/observed arcs between documents (≤ 150) |
| L2 Decades | 0.8–8 | 10 y | Bins | Cluster branches and merges; all arc types (≤ 300) |
| L3 Years | 8–96 | 1 y | Bins, switching to individual occurrence marks when ≤ 4,000 are visible | Uncertainty whiskers |
| L4 Months | 96–2,922 | month | Occurrence marks | Coarser-dated band at the top of the strand |
| L5 Days | ≥ 2,922 | day | Occurrence marks | Coarser-dated band |

The server picks `mode: "bins" | "occurrences"` for each tile. The client never receives more than 4,000 occurrence marks or 20,000 bin cells per viewport.

At L4 and L5, an item with only year precision is **never drawn at 1 January**. It goes into the coarser-dated band as a 1-year span ("41 items dated only to 1997"). OpenAlex `-12-31` placeholder dates carry a ⚠ "possible placeholder date" badge.

### 1.6 Branches, convergence, lineage arcs, feedback arcs

**Branch (split).** Drawn only when the lanes are clusters and a `cluster_transition(kind='split')` exists. It is a 1.5 px dashed curve (the computed style) from the parent strand, at the child's emergence bin, into the child's lane, with the glyph `⑂`. Example tooltip:

> "Context group 3 'verse · flow · mic' emerges in the 1990s. Nearest earlier group: 1 (centroid cosine 0.58). Run #14, k=4, stability 0.81. **Computed: a split in usage contexts, not a claim about speakers.**"

**Convergence (merge).** The glyph `⑃`, dashed, drawn between the strands of two expressions in the same lane when the convergence metric passes its gate (§4.8). The tooltip shows the value and its confidence interval.

**Lineage arcs.** Quadratic arcs above the strands, from the earlier source mark to the later target mark.
- **Colour shows role:**
  - Amber: reference to earlier material (quotation, citation, sample, adaptation).
  - Violet: reinterpretation (recontextualization, parody, answer, annotated reframing).
  - Ivory-2: similarity.
- **Pattern shows evidence status** (§8.6).
- **Limit:** at most 300 arcs per viewport. Priority: documented > observed > computed > proposed, then the amount of evidence, then nearness to the vantage. Hidden arcs are counted in a "+212 more arcs (filtered)" chip.

**Feedback arcs (later → earlier).** These come only from two sources:
- Relationships of the reinterpretation family.
- Annotations of kind `interpretation` with `dimensions.reframes_target = true`.

They are drawn *below* the strands, in violet, with the arrowhead at the **earlier** mark, and appear once the vantage reaches the later work's date. The earlier mark then gains a violet halo: "re-read after 1997 (1 documented, 2 annotated)". **Feedback arcs are never generated from similarity.**

**Date conflicts.** An edge whose type requires precedence (cites, samples, quotes) but whose source is dated *after* its target is drawn as a dotted red stub marked "⚠ date conflict". It signals a dating problem, not feedback. The 6,666 OpenAlex pairs above are the main case.

### 1.7 Coverage track, uncertain dates, shelves, deep time

**Coverage track.**
- A 24 px track sits under the ruler. Grey intensity is log₁₀ of the tokens (or works) per bin, with an explicit legend: "coverage, **log scale**: 10k · 100k · 1M · 10M tokens". Bins with zero coverage are hatched.
- Each lane also has a 3 px coverage underlay.

**Uncertain dates.** Dates are intervals `[lo, hi]`.
- At occurrence tiers, an interval is drawn as a bracket `⊢—⊣`, with a dot only if its precision is no coarser than the bin.
- The bracket style shows the basis:
  - stated: solid bracket.
  - estimated: dashed bracket plus "≈".
  - period: hatched band.
  - announced: open bracket in the Scheduled shelf.
- Aggregates spread each interval uniformly over the bins it overlaps (fractional counting), and that fractional share drives the hatching.
- Clustering and drift windows **exclude** any item whose interval is wider than the window. Excluded items are counted as "excluded: date too coarse (n)".

**Shelves.**
- **Undated shelf.** An 88 px column pinned at the left shows per-lane counts ("UNDATED · 172"). Clicking it opens a virtualized, searchable list. Undated items never contribute to bins or rates; their tokens are reported as "undated coverage".
- **Scheduled shelf.** Pinned at the right, past the "today 2026-10-03" line. It holds items with `basis='announced'`.

**Deep-time bands (etymology).** At L0–L2 an extra lane, "Etymology — periods, not dates", appears whenever the tracked expression has `roots.tsv` ancestors.
- Each etymon or root is drawn as a translucent hatched band over its language period, from `language_period`: ine-pro 4500–2500 BCE · grc 800 BCE–600 CE · la 500 BCE–1500 CE (core 75 BCE–200 CE) · sa 1500 BCE–1500 CE.
- Each band is labelled, for example "PIE \*ǵenh₁- 'to beget' — period of the language, not a date for the word".
- Descent is drawn as a dotted connector from the band's right edge to the strand's first corpus observation, labelled "descends (Wiktionary, undated)". It is never anchored to a specific year.

### 1.8 Playhead, scrub, play, reduced motion

**Playhead.** A cyan vertical line with a 44×44 px drag handle on the ruler, labelled "as of 1997".

**Scrub.** Drag the handle. The `,` and `.` keys move one bin; `<` and `>` move ten.

**Play.**
- Advances the vantage one bin every 400 ms, at 0.25× to 4× speed.
- Auto-pans so the playhead stays at 70% of the width.
- Marks fade in over 150 ms. An interval item appears with an "in progress" dashed style once the vantage reaches `t_lo`, and becomes solid at `t_hi`.

**Gaps.** Playback never interpolates. When every visible lane is uncovered ahead, play pauses for 600 ms with the caption *"No coverage 1631–1659 in these lanes — skipping. Nothing is inferred."* and then jumps.

**Strict and context modes.** Play defaults to strict mode; pausing switches to context mode, where later marks are ghosted.

**Reduced motion.** Triggered by the OS setting or the `R` key, it changes three things:
- No fades and no arc draw-on.
- Play becomes a discrete step every 1.2 s, with jump-pans instead of easing.
- **Step ▸** becomes the primary control.

### 1.9 The first 60 seconds

| Time | What the user sees |
|---|---|
| 0 s | The demo corpus is loaded, with a persistent hatched ribbon: **"SYNTHETIC DEMONSTRATION CORPUS — invented texts, people, dates and links."** The query `coldwire` is preloaded, with lanes = cluster and vantage = 1925. |
| 0–10 s | Coach mark 1, on the first bar: "Bars span the first and last time 'coldwire' is observed. Gaps are real: dotted = looked and found none; hatched = no sources." |
| 10–25 s | Mark 2: "Press ▶." The vantage runs from 1925 to 2026. In the 1950s the *handler · drop · safehouse* lane branches off (dashed); in the 1990s *verse · flow · mic*; in the 2010s *deploy · branch · patch*. |
| 25–40 s | Mark 3: "Click any dot." The inspector opens with the offsets highlighted, a SYNTHETIC badge, and the date chip "1997 · stated · year". |
| 40–55 s | Mark 4: "Click the amber arc." A card reads "near quotation · **COMPUTED (≈)** · MinHash 0.71, alignment 0.83 · shared wording is not proof of influence." |
| 55–60 s | Mark 5: "Your turn." The search box is focused, with chips for `virus`, `genesis`, `sample` and **Switch to the Cipher corpus (real data)**. |

The tour can be skipped and is not shown again once dismissed. It remembers this in `localStorage` wrapped in try/catch, and fails safe to showing the tour.

---

## 2. Views B–F (interaction specifications)

### B. Meaning constellation

**Inputs:** one or more expressions, period A, an optional period B, and the current filters.

**Nodes** (shape shows type):
- Expression ○
- Context group (sense cluster) ⬡
- Work or document □
- Motif or theme ◇. Cipher tags carry a "machine tag" badge.

**Node size** is a required, named quantity chosen from a dropdown: *occurrences in period* (the default), *documents in period* or *distinct authors*. Area is proportional to the value. The legend shows three reference circles with their numeric values.

**Edges:**
- **Co-occurrence** between an expression and a collocate. Weight is logDice in the period, shown as thickness and named in the legend. Only collocates that pass the gates in §4.5 appear.
- **Relationships**, in evidence styles.
- **Membership** of an expression in a context group (thin lines).
- **Theme association** between themes, as NPMI from `culture-themes.tsv`, labelled "computed by Cipher".

**Limits:** at most 150 nodes and 400 edges, chosen top-k by the size quantity. Each node has a "+n more" expander that adds up to 20.

**Stable layout:**
- Positions are computed once per `(corpus, expressions, run ids, A∪B node set)` with a deterministic Fruchterman–Reingold layout (300 iterations, seed = FNV-1a of that key). They are stored in the view state.
- Changing period or comparing never moves nodes. A node absent from the shown period becomes a 20%-opacity ghost outline.
- Expanding a node runs the layout with all existing nodes pinned.
- **Re-layout** is an explicit button, and shows the toast *"Positions recomputed — movement is not semantic."*

**Two-period comparison.** A is always the earlier period.
- In **split** mode, A and B are drawn side by side in identical coordinates.
- In **overlay** mode:
  - A-only nodes get an amber ring.
  - B-only nodes get an ivory dashed ring.
  - Nodes present in both are filled.
  - Nodes whose size changed get a two-tone ring (inner A, outer B).

**Clicks:**
- A **node** opens its supporting passages: KWIC lines, 20 per page, sorted by date, with denominators.
- An **edge** opens a card explaining what the quantity is, how it was computed (run id and parameters), and its evidence passages. For co-occurrence, those are the passages where both terms occur.

The legend is persistent on desktop and collapses to a chip on narrow screens.

### C. Lineage explorer ("chain of custody")

**Layout:**
- The x-axis is **ordinal time**: each distinct dated year gets equal width. The header says so: "Ordinal: equal spacing per dated year — see the timeline for true spacing."
- The y-axis is document kind.
- Undated nodes sit in a gutter on the left.
- Nodes are documents, or passages when the evidence is at passage level.

**Edges:**
- Line pattern shows evidence status.
- Glyph and label show the relationship type: `“ ” exact` · `≈“ ” near` · `§ cites` · `⟲ adapts` · `◐ parody` · `↻ recontextualizes` · `? allusion` · `∼ similar` · `♪ samples` · `⊂ part of`.
- Colour shows the family: amber for transmission, violet for reinterpretation, ivory-2 for similarity.

**Filters:**
- Chips for each relationship type.
- Checkboxes for each evidence status.
- **Documented & observed only** (key `E`).
- Show/hide rejected.

**Bounded expansion:**
- The view opens at depth 2 in both directions, with at most 60 nodes.
- A node's **＋** expands one hop, adding at most 30 nodes.
- The hard cap is 150 nodes. Beyond that the view falls back to a paged table ("Show as list").

**Chain of custody:**
- Selecting two nodes finds the path that minimizes evidence cost. Costs per edge: documented 1, observed 1, computed 3, proposed 5; rejected edges are excluded.
- The path is shown as a vertical list of link cards.
- The list's header reports **chain strength = its weakest link** (for example "PROPOSED").

**Competing hypotheses:**
- A `hypothesis_group` holds a target and a question, for example "Where does the 1997 wording come from?", and gathers the alternative parent edges.
- These are drawn as a fan with a "⚖ 2 competing" badge.
- The group's card shows the hypotheses side by side, with their evidence and review status.
- Users can add a hypothesis, which creates a `proposed` relationship by a human in that group. Nothing is ever deleted.

**Disputed relationships.** When different annotators have both confirmed and rejected a relationship, its review status becomes `disputed` and both notes stay visible.

**Edge card:**
- Type and direction.
- Evidence status, in words.
- Method or annotator.
- Run id and parameters.
- Confidence, labelled with its kind, e.g. "similarity 0.71 — not a probability".
- External locator, opened in a new tab and labelled as external.
- Supporting passages side by side, with an aligned diff.
- Revision history.
- The fixed sentence *"Shared wording or similar contexts can come from a common source; they do not establish influence or intent."*

### D. Then / Now / Next inspector

The inspector opens on any occurrence or passage. On desktop it shows three columns; on narrow screens, tabs.

**THEN** (amber accents):
- A document card: title, author, a date chip with precision, basis and role, the collection, the licence, and a SYNTHETIC badge when relevant.
- The passage with the expression highlighted at its offsets. The neighbouring passage on each side can be expanded, and **Open in reader** opens a virtualized full-document reader.
- A chip such as "refers to 1904" when the passage has a `referenced` date.
- **Contemporary uses:** occurrences of the same expression within W = max(10 y, 2 × date width) of the passage. They are stratified by lane (at most 3 per lane, 9 in total), with a denominator line ("n = 37 in 1925–1945 · 6.1M tokens").
- **Machine annotations (fallible):** context-group membership with its margin, and tone if available.

**NOW** (violet accents):
- A later passage that reuses or reframes this one. The default is the related target with the strongest evidence. A picker lists every later related passage, plus "any later occurrence".
- The relationship card.
- For quotations, a side-by-side alignment: shared tokens in ivory, substitutions with a violet underline, insertions dotted.
- **Context shift:** the top context words within ±10 tokens of each occurrence, shown as two sets ("only around Then" / "only around Now") and labelled *"context words, not meanings"*.

**NEXT:**
- Subsequent relationships from the Now passage, time-sorted, at most 20.
- A sparkline of later occurrences in the same context group, with denominators.
- **Add a hypothesis about later reinterpretation**, which creates an annotation of kind `hypothesis`. It renders as a dashed violet card: "Hypothesis — by you, 2026-10-03 — not evidence."

**Copy rule.** The UI never applies mental-state verbs to historical people ("thought", "felt", "intended", "meant to"). A test greps the UI strings for them.

### E. Compare meanings

**Inputs:** slice A and slice B, each defined as `{years, facet filters, collections}`, and one or two expressions. The defaults come from a shift-drag range selection on the timeline plus the `A` and `B` keys.

Seven panels, top to bottom. **Coverage always comes first.**

1. **Coverage & composition.**
   - For each slice: tokens or works, documents, authors, date-basis mix, translation share, and a stacked bar of kind/genre mix.
   - Composition divergence is computed as JSD(mixA, mixB). Above 0.15, an amber caveat appears, for example: *"The slices differ in composition (JSD 0.31): B is 70% song titles, A is 100% novels. Differences below may reflect source mix."*
   - When the caveat fires, directly standardized rates (to the pooled composition) are shown next to the raw rates.

2. **Frequency.**
   - Per-million (or per-1,000-works) rates with exact 95% Poisson confidence intervals.
   - The rate ratio with its confidence interval.
   - Document counts and Gries' DP dispersion.

3. **Representative passages.** Five per slice, stratified so that at most one comes from any document. The sampling seed is printed, and a "reshuffle" button draws again.

4. **Neighbouring terms.**
   - Collocates per slice (logDice, with G² ≥ 10.83 and f ≥ 5), shown in shared / A-only / B-only columns.
   - Keyness of collocates between slices: log-ratio, with Benjamini–Hochberg FDR at q < 0.05.

5. **Context groups.**
   - Share per slice, with bootstrap confidence intervals.
   - "New" uses are those with A < 2% and B ≥ 10%; "declining" uses are the reverse.
   - This panel needs a clustering run; otherwise it shows a gate card.

6. **Estimated displacement.** Shown only when the gates pass (§4.9), for example:
   > "Context-share shift JSD 0.21 [0.14, 0.29] · n = 212 / 388 · 31 / 54 documents"
   > "Aligned displacement 0.37 · 97th percentile of 500 frequency-matched controls"

   Otherwise a gate card explains what is missing and offers a computed suggestion:
   > "Not estimated. A has 23 occurrences in 4 documents; this needs ≥ 50 in ≥ 5 documents per slice. Widening A to 1840–1899 would give 61 in 9 documents. [Apply]"

7. **Tone and stance.**
   - Machine tone requires the NL adapter (§4.10). It is shown as a distribution with a confidence interval, labelled *"Apple NLTagger — modern reader model, fallible, anachronistic for historical text."*
   - Stance comes only from human annotations (dimension `stance`), counted per slice.

### F. Interpretation notebook

**Where it lives:** a right-hand drawer, plus a full-page mode.

**Targets:** a passage (optionally a sub-span), an occurrence, a document, a context group, a relationship, a saved view, a time window, or another annotation (a reply).

**Kinds:** `interpretation`, `evidence_for`, `evidence_against`, `hypothesis`, `question`, `correction`, `label`.

**Dimensions:**
- **Built in**, following brief §4: `lexical_sense`, `topic`, `referent`, `pragmatic_function` (sincere / ironic / parodic / reclaimed / …), `tone`, `stance`, `social_association`, `personal_reading`, `reframes_target` (boolean).
- **Custom** dimensions, defined through `dimension_def` with type `enum | scale | text`.

**Revisions:**
- Editing appends a new `annotation_revision`. Database triggers forbid UPDATE and DELETE on revisions.
- Each card shows "rev 3 of 3", a revision scrubber, and a word-level diff.

**Reinterpreting:**
- **Reinterpret** creates a *new* annotation that `supersedes` the old one.
- The old one is marked `superseded` but stays visible as an earlier layer: "Layer 'reading of 2026-10-03' — superseded 2026-11-12".
- In the notebook, superseded layers are shown by default. In the timeline they appear only when "show superseded" is on.

**As-of slider.** A slider over annotation time shows which interpretations existed at a given date. This is the notebook's version of D4.

**Confirm and reject inferred relationships:**
- Both actions require a note of at least 10 characters.
- Each one writes an annotation (`evidence_for` or `evidence_against`) plus a `relationship_revision`.
- `review_status` is then recomputed: confirmed, rejected or disputed.
- **`evidence_status` never changes.**

**Compare interpretations.** All active annotations on a target, grouped by layer or author, each with its supporting and contradicting evidence lists.

**Search.** FTS over annotation bodies, plus facets for tags, kinds and dimensions.

---

## 3. Data model — SQLite DDL

The database is `~/Developer/scrolls-data/scrolls.db`, or `$SCROLLS_DATA/scrolls.db`. Original uploaded files are stored verbatim and content-addressed under `originals/<sha[0:2]>/<sha256>`.

**Offsets** are UTF-16 code units into the decoded original string. Node and the browser slice strings natively in UTF-16, and the tests assert `original.slice(s, e)` round-trips (one-line reason).

**Days** are counted from 1970-01-01, proleptic Gregorian, astronomical years.

```sql
PRAGMA journal_mode = WAL;  PRAGMA foreign_keys = ON;  PRAGMA synchronous = NORMAL;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- schema_version, tokenizer_version ('u61m-1'), created_at

-- ───────────── 1. Provenance spine ─────────────
CREATE TABLE corpus (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('real','synthetic','user')),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  description TEXT, license TEXT, created_at TEXT NOT NULL,
  CHECK (kind <> 'synthetic' OR is_synthetic = 1));

CREATE TABLE source_adapter (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
  uses_network INTEGER NOT NULL DEFAULT 0, license TEXT, attribution TEXT,
  config_json TEXT NOT NULL DEFAULT '{}', UNIQUE (name, version));

CREATE TABLE collection (
  id INTEGER PRIMARY KEY, corpus_id INTEGER NOT NULL REFERENCES corpus(id),
  adapter_id INTEGER REFERENCES source_adapter(id),
  slug TEXT NOT NULL, name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('tokens','works')),     -- frequency denominator
  sampling TEXT NOT NULL DEFAULT 'complete',                  -- 'complete'|'top_cited_per_cell'|'curated'|…
  source_uri TEXT, license TEXT, attribution TEXT, export_text_allowed INTEGER NOT NULL DEFAULT 1,
  retrieved_at TEXT, notes TEXT, UNIQUE (corpus_id, slug));

CREATE TABLE original_file (
  sha256 TEXT PRIMARY KEY, rel_path TEXT NOT NULL, byte_size INTEGER NOT NULL,
  encoding TEXT NOT NULL, had_bom INTEGER NOT NULL DEFAULT 0, first_seen_at TEXT NOT NULL);

CREATE TABLE import_batch (
  id INTEGER PRIMARY KEY, collection_id INTEGER NOT NULL REFERENCES collection(id),
  file_sha256 TEXT REFERENCES original_file(sha256), file_name TEXT,
  format TEXT NOT NULL CHECK (format IN ('txt','md','csv','tsv','json','jsonl','adapter')),
  mapping_json TEXT NOT NULL DEFAULT '{}', summary_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('previewed','validated','committing','committed','failed','cancelled','rolled_back')),
  job_id INTEGER REFERENCES job(id), created_at TEXT NOT NULL, committed_at TEXT);
CREATE UNIQUE INDEX import_once ON import_batch(collection_id, file_sha256) WHERE status = 'committed';

-- ───────────── 2. Documents & text ─────────────
CREATE TABLE document (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collection(id),
  import_batch_id INTEGER NOT NULL REFERENCES import_batch(id),
  ext_id TEXT NOT NULL,                       -- Gutenberg #, QID, culture row, OpenAlex W…, user id
  title TEXT, author TEXT, kind TEXT, genre TEXT, community TEXT, culture TEXT, field TEXT,
  lang_declared TEXT, lang_text TEXT, lang_confidence REAL,
  is_translation INTEGER NOT NULL DEFAULT 0, original_lang TEXT,
  has_full_text INTEGER NOT NULL DEFAULT 0,
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  -- chronology, denormalized from the date_assertion with is_chronology = 1
  t_lo INTEGER, t_hi INTEGER, y_lo INTEGER, y_hi INTEGER,
  t_precision TEXT NOT NULL DEFAULT 'unknown', t_basis TEXT NOT NULL DEFAULT 'unknown', t_role TEXT,
  chrono_status TEXT NOT NULL CHECK (chrono_status IN ('dated','undated','scheduled','period')),
  source_url TEXT, license TEXT,
  source_file_sha256 TEXT REFERENCES original_file(sha256), source_byte_start INTEGER, source_byte_end INTEGER,
  original_meta_json TEXT NOT NULL,           -- verbatim source record, including unmapped fields
  text_sha256 TEXT, dup_of INTEGER REFERENCES document(id),
  token_count INTEGER NOT NULL DEFAULT 0, passage_count INTEGER NOT NULL DEFAULT 0,
  prominence REAL,                            -- source-specific (Cipher weight); never used as evidence weight
  created_at TEXT NOT NULL,
  UNIQUE (collection_id, ext_id),
  CHECK ((chrono_status = 'undated') = (t_lo IS NULL)));
CREATE INDEX doc_time   ON document(y_lo, y_hi);
CREATE INDEX doc_facets ON document(collection_id, kind, lang_text, culture);
CREATE INDEX doc_textsha ON document(text_sha256);

CREATE TABLE document_text (
  document_id INTEGER PRIMARY KEY REFERENCES document(id),
  original TEXT NOT NULL,                     -- decoded source text, unmodified (BOM recorded in original_file)
  body_start INTEGER NOT NULL, body_end INTEGER NOT NULL,   -- e.g. inside the Gutenberg markers
  original_sha256 TEXT NOT NULL);

CREATE TABLE document_alias (
  document_id INTEGER NOT NULL REFERENCES document(id), ext_id TEXT NOT NULL,
  title TEXT, note TEXT, PRIMARY KEY (document_id, ext_id));

CREATE TABLE doc_tag (                       -- machine/catalogue tags: NOT document text
  document_id INTEGER NOT NULL REFERENCES document(id),
  scheme TEXT NOT NULL CHECK (scheme IN ('theme','motif','mood','canon','locc','subject','field','subfield','topic','keyword')),
  value TEXT NOT NULL, weight REAL,
  provenance TEXT NOT NULL CHECK (provenance IN ('documented_category','machine_tag','genre_heuristic','catalog','adapter_machine')),
  method TEXT NOT NULL, run_id INTEGER REFERENCES analysis_run(id),
  PRIMARY KEY (document_id, scheme, value, provenance));
CREATE INDEX doc_tag_value ON doc_tag(scheme, value);

-- ───────────── 3. Time ─────────────
CREATE TABLE date_assertion (
  id INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('document','passage','expression','relationship')),
  subject_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('publication','creation','original_publication','publication_unspecified',
        'edition','release','recording','performance','referenced','authored_description','translation',
        'ingestion','scheduled','language_period','first_attestation_claim')),
  lo_day INTEGER, hi_day INTEGER, lo_year INTEGER, hi_year INTEGER,
  precision TEXT NOT NULL CHECK (precision IN ('day','month','year','decade','century','millennium','range','period','unknown')),
  basis TEXT NOT NULL CHECK (basis IN ('stated','estimated','derived','period','announced','unknown')),
  raw TEXT, rule TEXT, asserted_by TEXT NOT NULL,       -- raw input; grammar rule id; source/adapter/human
  is_chronology INTEGER NOT NULL DEFAULT 0, note TEXT,
  CHECK ((precision = 'unknown') = (lo_day IS NULL)),
  CHECK (lo_day IS NULL OR lo_day <= hi_day));
CREATE INDEX date_subject ON date_assertion(subject_type, subject_id);
CREATE UNIQUE INDEX one_chronology ON date_assertion(subject_type, subject_id) WHERE is_chronology = 1;
CREATE VIRTUAL TABLE date_rtree USING rtree_i32(id, lo_day, hi_day);   -- interval-overlap queries

CREATE TABLE language_period (
  lang TEXT PRIMARY KEY, label TEXT NOT NULL, lo_year INTEGER NOT NULL, hi_year INTEGER NOT NULL,
  core_lo INTEGER, core_hi INTEGER, source TEXT NOT NULL, note TEXT);

-- ───────────── 4. Passages & search ─────────────
CREATE TABLE passage (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES document(id),
  ord INTEGER NOT NULL,
  field TEXT NOT NULL DEFAULT 'body',          -- body | title | native_title | summary | abstract | gloss
  time_role TEXT NOT NULL DEFAULT 'document' CHECK (time_role IN ('document','describes')),
  start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,  -- UTF-16 units into document_text.original (field='body')
                                                         -- or into json_extract(original_meta_json,'$.<field>')
  kind TEXT NOT NULL CHECK (kind IN ('paragraph','stanza','sentence_group','page','field','furniture')),
  page_no INTEGER, lang TEXT, lang_confidence REAL,
  token_count INTEGER NOT NULL,
  norm TEXT NOT NULL,                          -- folded tokens joined by ' ' (tokenizer u61m-1); FTS content
  y_lo INTEGER, y_hi INTEGER,                  -- denormalized chronology (own date if any, else document's)
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  UNIQUE (document_id, field, ord),
  CHECK (start_off <= end_off));
CREATE INDEX passage_doc  ON passage(document_id, start_off);
CREATE INDEX passage_time ON passage(y_lo, lang, field);

CREATE VIRTUAL TABLE passage_fts USING fts5(norm, content='passage', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2 categories 'L* N* Co M*'");
CREATE VIRTUAL TABLE passage_vocab_row  USING fts5vocab(passage_fts, row);
CREATE VIRTUAL TABLE passage_vocab_inst USING fts5vocab(passage_fts, instance);
CREATE VIRTUAL TABLE title_tri USING fts5(title, native_title, maker, content='',
  tokenize="trigram remove_diacritics 1");     -- rowid = document.id; substring search over titles/makers
-- triggers passage_ai/passage_ad keep passage_fts in sync (standard external-content pattern)

-- ───────────── 5. Expressions, occurrences, coverage ─────────────
CREATE TABLE expression (
  id INTEGER PRIMARY KEY, corpus_id INTEGER REFERENCES corpus(id),   -- NULL = shared (etymology)
  kind TEXT NOT NULL CHECK (kind IN ('word','phrase','quotation','symbol','motif','theme','etymon','root')),
  surface TEXT NOT NULL, norm TEXT NOT NULL, lang TEXT, roman TEXT, gloss TEXT,
  origin TEXT NOT NULL,                       -- user_query | roots.tsv | cipher.motif | import | demo
  is_synthetic INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL, meta_json TEXT);
CREATE UNIQUE INDEX expr_key ON expression(kind, IFNULL(lang,''), norm, IFNULL(corpus_id,0));

CREATE TABLE expression_variant (
  id INTEGER PRIMARY KEY, expression_id INTEGER NOT NULL REFERENCES expression(id),
  form TEXT NOT NULL, norm TEXT NOT NULL, lang TEXT,
  variant_type TEXT NOT NULL CHECK (variant_type IN ('identity','inflection','spelling','hyphenation',
                'transliteration','translation','descendant','user')),
  rule TEXT, evidence_status TEXT NOT NULL CHECK (evidence_status IN ('documented','observed','computed','proposed')),
  enabled INTEGER NOT NULL DEFAULT 1, UNIQUE (expression_id, IFNULL(lang,''), norm));

CREATE TABLE occurrence (
  id INTEGER PRIMARY KEY,
  expression_id INTEGER NOT NULL REFERENCES expression(id),
  variant_id INTEGER REFERENCES expression_variant(id),
  passage_id INTEGER NOT NULL REFERENCES passage(id),
  start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,   -- same coordinate base as the passage
  tok_index INTEGER NOT NULL,
  match TEXT NOT NULL CHECK (match IN ('exact','variant','phrase','field')),
  sampled INTEGER NOT NULL DEFAULT 0,          -- 1 when contexts are a stratified sample (very frequent terms)
  context_thin INTEGER NOT NULL DEFAULT 0,     -- < 3 usable context words for vectors
  -- denormalized facets for GROUP BY
  document_id INTEGER NOT NULL, collection_id INTEGER NOT NULL, y_lo INTEGER, y_hi INTEGER,
  t_precision TEXT, lang TEXT, kind TEXT, culture TEXT, field TEXT, time_role TEXT,
  is_translation INTEGER NOT NULL DEFAULT 0, is_dup INTEGER NOT NULL DEFAULT 0,
  run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  UNIQUE (run_id, passage_id, start_off, expression_id));
CREATE INDEX occ_agg ON occurrence(expression_id, run_id, y_lo, lang, kind);
CREATE INDEX occ_passage ON occurrence(passage_id);

CREATE TABLE occurrence_count (               -- exact counts when occurrence rows are sampled
  run_id INTEGER NOT NULL, expression_id INTEGER NOT NULL, collection_id INTEGER NOT NULL,
  lang TEXT NOT NULL, kind TEXT NOT NULL, culture TEXT NOT NULL DEFAULT '', field TEXT NOT NULL,
  y INTEGER NOT NULL, n REAL NOT NULL, n_docs INTEGER NOT NULL,
  PRIMARY KEY (run_id, expression_id, collection_id, lang, kind, culture, field, y));

CREATE TABLE coverage_year (                  -- denominators; fractional when a date spans years
  collection_id INTEGER NOT NULL, lang TEXT NOT NULL, kind TEXT NOT NULL, culture TEXT NOT NULL DEFAULT '',
  field TEXT NOT NULL, time_role TEXT NOT NULL, include_translations INTEGER NOT NULL,
  y INTEGER NOT NULL, tokens REAL NOT NULL, works REAL NOT NULL, docs REAL NOT NULL,
  coarse_tokens REAL NOT NULL,                -- from dates coarser than a year
  PRIMARY KEY (collection_id, lang, kind, culture, field, time_role, include_translations, y));
CREATE TABLE coverage_undated (
  collection_id INTEGER NOT NULL, lang TEXT NOT NULL, kind TEXT NOT NULL, field TEXT NOT NULL,
  tokens INTEGER NOT NULL, works INTEGER NOT NULL, docs INTEGER NOT NULL,
  PRIMARY KEY (collection_id, lang, kind, field));

-- ───────────── 6. Analysis ─────────────
CREATE TABLE analysis_run (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL,                        -- occurrences|collocations|reuse_index|quotes|space|cluster|drift|tone|cipher_load|…
  pipeline_version TEXT NOT NULL,             -- e.g. 'cluster@1.0.0'
  code_hash TEXT NOT NULL,                    -- sha256 of the stage's source files
  params_json TEXT NOT NULL, params_hash TEXT NOT NULL,
  scope_json TEXT NOT NULL,                   -- corpus/collections/expression/slices
  input_fingerprint TEXT NOT NULL,            -- sha256(collections + max import_batch + upstream runs + tokenizer)
  upstream_run_ids TEXT NOT NULL DEFAULT '[]',
  model TEXT, model_version TEXT, seed INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled','superseded')),
  started_at TEXT NOT NULL, finished_at TEXT, metrics_json TEXT, notes TEXT);
CREATE INDEX run_reuse ON analysis_run(stage, params_hash, input_fingerprint, status);

CREATE TABLE time_window (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  label TEXT NOT NULL, lo_year INTEGER NOT NULL, hi_year INTEGER NOT NULL,
  scheme TEXT NOT NULL CHECK (scheme IN ('fixed','equal_count','merged_for_min_n','custom')),
  n_occ INTEGER, tokens REAL);

CREATE TABLE collocation (
  run_id INTEGER NOT NULL REFERENCES analysis_run(id), expression_id INTEGER NOT NULL,
  slice_key TEXT NOT NULL, collocate TEXT NOT NULL,
  f_xy INTEGER NOT NULL, f_x INTEGER NOT NULL, f_y INTEGER NOT NULL, n_tokens INTEGER NOT NULL,
  g2 REAL NOT NULL, q_value REAL NOT NULL, log_dice REAL NOT NULL, ppmi REAL NOT NULL,
  PRIMARY KEY (run_id, expression_id, slice_key, collocate));

CREATE TABLE fingerprint (hash INTEGER NOT NULL, passage_id INTEGER NOT NULL, tok_pos INTEGER NOT NULL,
  run_id INTEGER NOT NULL);
CREATE INDEX fp_hash ON fingerprint(hash);
CREATE TABLE formula_hash (hash INTEGER PRIMARY KEY, n_docs INTEGER NOT NULL, run_id INTEGER NOT NULL);
CREATE TABLE minhash_unit (
  id INTEGER PRIMARY KEY, passage_id INTEGER NOT NULL, start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,
  n_tokens INTEGER NOT NULL, sig BLOB NOT NULL, run_id INTEGER NOT NULL);       -- 128 × uint32
CREATE TABLE lsh_bucket (band INTEGER NOT NULL, bucket INTEGER NOT NULL, unit_id INTEGER NOT NULL);
CREATE INDEX lsh_lookup ON lsh_bucket(band, bucket);

CREATE TABLE vector_space (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  lang TEXT NOT NULL, lo_year INTEGER, hi_year INTEGER, pooled INTEGER NOT NULL,
  collections_json TEXT NOT NULL, tokens INTEGER NOT NULL, vocab_size INTEGER NOT NULL, dim INTEGER NOT NULL,
  file_path TEXT NOT NULL);                   -- spaces/<id>.f32 + spaces/<id>.vocab.json
CREATE TABLE space_alignment (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, from_space INTEGER NOT NULL, to_space INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method = 'orthogonal_procrustes'), anchors INTEGER NOT NULL,
  mean_anchor_cos REAL NOT NULL, matrix_path TEXT NOT NULL);

CREATE TABLE sense_cluster (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  expression_id INTEGER NOT NULL REFERENCES expression(id), ord INTEGER NOT NULL,
  label_auto TEXT NOT NULL, label_user TEXT, distinctive_json TEXT NOT NULL,   -- [{term,log_ratio,f_in,f_out}]
  size INTEGER NOT NULL, n_docs INTEGER NOT NULL, stability REAL, silhouette REAL,
  first_year INTEGER, last_year INTEGER,
  status TEXT NOT NULL DEFAULT 'hypothesis' CHECK (status IN ('hypothesis','unstable','residual','confirmed','rejected')));
CREATE TABLE cluster_member (
  cluster_id INTEGER NOT NULL REFERENCES sense_cluster(id), occurrence_id INTEGER NOT NULL REFERENCES occurrence(id),
  cos REAL NOT NULL, margin REAL NOT NULL, PRIMARY KEY (cluster_id, occurrence_id));
CREATE TABLE cluster_share (
  cluster_id INTEGER NOT NULL, window_id INTEGER NOT NULL, n INTEGER NOT NULL,
  share REAL NOT NULL, ci_lo REAL NOT NULL, ci_hi REAL NOT NULL, PRIMARY KEY (cluster_id, window_id));
CREATE TABLE cluster_transition (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('emerge','split','merge','vanish','unknown_gap')),
  from_cluster INTEGER, to_cluster INTEGER, window_id INTEGER NOT NULL, score REAL, note TEXT);

CREATE TABLE drift_result (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id), expression_id INTEGER NOT NULL,
  slice_a_json TEXT NOT NULL, slice_b_json TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('rate_ratio','sense_share_jsd','neighbor_overlap','aligned_displacement','convergence')),
  value REAL, ci_lo REAL, ci_hi REAL, null_percentile REAL,
  n_a INTEGER, n_b INTEGER, docs_a INTEGER, docs_b INTEGER, authors_a INTEGER, authors_b INTEGER,
  gate TEXT NOT NULL CHECK (gate IN ('ok','insufficient_occurrences','insufficient_documents','insufficient_coverage',
                                     'unaligned','composition_mismatch','no_cluster_structure','not_run')),
  gate_detail_json TEXT NOT NULL, caveats_json TEXT NOT NULL DEFAULT '[]',
  CHECK (gate = 'ok' OR value IS NULL));          -- a gated metric has NO value: nothing to misread

-- ───────────── 7. Relationships ─────────────
CREATE TABLE rel_type (
  code TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('quotation','citation','adaptation','parody','reinterpretation',
                                         'allusion','similarity','containment','etymology','sense')),
  label TEXT NOT NULL, inverse_label TEXT NOT NULL, directed INTEGER NOT NULL,
  requires_precedence INTEGER NOT NULL,       -- source must be earlier than target (date-conflict check)
  implies_transmission INTEGER NOT NULL, glyph TEXT NOT NULL, description TEXT NOT NULL);

CREATE TABLE hypothesis_group (
  id INTEGER PRIMARY KEY, target_type TEXT NOT NULL, target_id INTEGER NOT NULL,
  question TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE relationship (
  id INTEGER PRIMARY KEY,
  src_type TEXT NOT NULL CHECK (src_type IN ('document','passage','occurrence','expression','cluster')),
  src_id INTEGER NOT NULL,                     -- canonical: the LATER / dependent item
  dst_type TEXT NOT NULL CHECK (dst_type IN ('document','passage','occurrence','expression','cluster')),
  dst_id INTEGER NOT NULL,                     -- canonical: the EARLIER / source item
  rel_type TEXT NOT NULL REFERENCES rel_type(code),
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('documented','observed','computed','proposed')),
  review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','confirmed','rejected','disputed')),
  method TEXT NOT NULL,                        -- 'musicbrainz:l_recording_recording', 'winnow k=8 w=6', 'human'
  created_by TEXT NOT NULL,                    -- 'adapter:cipher@1', 'run:42', 'human:utkarsh'
  run_id INTEGER REFERENCES analysis_run(id),
  source_locator TEXT,
  locator_status TEXT NOT NULL CHECK (locator_status IN ('present','missing','not_applicable')),
  confidence REAL, confidence_kind TEXT CHECK (confidence_kind IN ('similarity','heuristic_strength','match_ratio','alignment_score')),
  date_conflict INTEGER NOT NULL DEFAULT 0,
  hypothesis_group_id INTEGER REFERENCES hypothesis_group(id),
  license TEXT, attribution TEXT, provenance_note TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  current_rev INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  CHECK (evidence_status <> 'documented' OR locator_status IN ('present','missing')),
  CHECK (evidence_status <> 'computed' OR run_id IS NOT NULL),
  CHECK (confidence IS NULL OR confidence_kind IS NOT NULL));
CREATE INDEX rel_src ON relationship(src_type, src_id);
CREATE INDEX rel_dst ON relationship(dst_type, dst_id);
CREATE INDEX rel_kind ON relationship(rel_type, evidence_status, review_status);
CREATE TRIGGER rel_evidence_immutable BEFORE UPDATE OF evidence_status, rel_type, src_id, dst_id ON relationship
BEGIN SELECT RAISE(ABORT, 'evidence_status/type/endpoints are immutable; create a new relationship'); END;

CREATE TABLE relationship_evidence (
  id INTEGER PRIMARY KEY, relationship_id INTEGER NOT NULL REFERENCES relationship(id),
  passage_id INTEGER REFERENCES passage(id),
  role TEXT NOT NULL CHECK (role IN ('source_span','target_span','citation_cue','supporting','contradicting','external_record')),
  start_off INTEGER, end_off INTEGER, detail_json TEXT, added_by TEXT NOT NULL, added_at TEXT NOT NULL);
CREATE INDEX rel_ev ON relationship_evidence(relationship_id);

CREATE TABLE relationship_revision (
  id INTEGER PRIMARY KEY, relationship_id INTEGER NOT NULL REFERENCES relationship(id), rev INTEGER NOT NULL,
  actor TEXT NOT NULL, at TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','confirm','reject','dispute','add_evidence','regroup','retract')),
  before_json TEXT, after_json TEXT, reason TEXT, annotation_id INTEGER REFERENCES annotation(id),
  UNIQUE (relationship_id, rev));
CREATE TRIGGER relrev_append_only_u BEFORE UPDATE ON relationship_revision BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER relrev_append_only_d BEFORE DELETE ON relationship_revision BEGIN SELECT RAISE(ABORT,'append-only'); END;

-- ───────────── 8. Interpretation ─────────────
CREATE TABLE dimension_def (
  key TEXT PRIMARY KEY, label TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('enum','scale','text','bool')),
  options_json TEXT, builtin INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL);

CREATE TABLE annotation (
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('passage','occurrence','document','cluster','relationship',
                                   'expression','saved_view','time_window','annotation')),
  target_id INTEGER NOT NULL, span_start INTEGER, span_end INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('interpretation','evidence_for','evidence_against','hypothesis','question',
                                     'correction','label','machine_tag','machine_tone','machine_gloss')),
  author TEXT NOT NULL, is_machine INTEGER NOT NULL, method TEXT, run_id INTEGER REFERENCES analysis_run(id),
  layer TEXT, supersedes INTEGER REFERENCES annotation(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','withdrawn')),
  is_synthetic INTEGER NOT NULL DEFAULT 0, current_rev INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  CHECK (is_machine = 0 OR method IS NOT NULL));
CREATE INDEX ann_target ON annotation(target_type, target_id, status);

CREATE TABLE annotation_revision (
  id INTEGER PRIMARY KEY, annotation_id INTEGER NOT NULL REFERENCES annotation(id), rev INTEGER NOT NULL,
  body_md TEXT NOT NULL, stance TEXT CHECK (stance IN ('supports','contradicts','neutral','alternative')),
  dimensions_json TEXT NOT NULL DEFAULT '{}', tags_json TEXT NOT NULL DEFAULT '[]',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',     -- [{type:'passage',id,start,end}]
  author TEXT NOT NULL, at TEXT NOT NULL, UNIQUE (annotation_id, rev));
CREATE TRIGGER annrev_append_only_u BEFORE UPDATE ON annotation_revision BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER annrev_append_only_d BEFORE DELETE ON annotation_revision BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE VIRTUAL TABLE annotation_fts USING fts5(body, tags, content='',
  tokenize="unicode61 remove_diacritics 2 categories 'L* N* Co M*'");   -- rowid = annotation_revision.id

-- ───────────── 9. App state ─────────────
CREATE TABLE saved_view (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT,
  state_json TEXT NOT NULL, state_version INTEGER NOT NULL,
  run_ids_json TEXT NOT NULL,                 -- analysis versions the view depends on
  annotation_rev_cutoff INTEGER NOT NULL,     -- max annotation_revision.id at save time
  import_batch_cutoff INTEGER NOT NULL,       -- max committed import_batch.id at save time
  data_fingerprint TEXT NOT NULL, snapshot_path TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE job (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, params_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelling','cancelled','interrupted')),
  progress REAL NOT NULL DEFAULT 0, phase TEXT, message TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
  run_id INTEGER REFERENCES analysis_run(id), result_json TEXT, error_json TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, heartbeat_at TEXT);
CREATE TABLE job_event (
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id), at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')), phase TEXT, progress REAL, message TEXT, data_json TEXT);
CREATE INDEX job_event_job ON job_event(job_id, id);
```

**Visibility rule.** Every analysis query joins `analysis_run` and filters on `status = 'succeeded'`. A cancelled or running job therefore can never leak partial rows. Rows from cancelled runs are deleted by a garbage-collection pass that the user starts.

---

## 4. Analysis pipeline

### 4.0 Runs and versions

Every time a stage runs, it writes one `analysis_run` row recording:
- `pipeline_version`, a semver per stage module.
- `code_hash`, the sha256 of that module's files, computed at server start.
- Parameters as canonical JSON (sorted keys) and their hash.
- `input_fingerprint`, the sha256 of: collection ids, the max committed import batch per collection, upstream run ids, and `tokenizer_version`.

If a request has the same `(stage, params_hash, input_fingerprint)` as a succeeded run, the old run is reused. Saved views pin their run ids. A newer run never silently replaces an older one: when a newer run exists, the view shows the banner "A newer analysis exists — [switch]".

### 4.1 Parse and validate

See §5.

### 4.2 Preserve originals

- Uploaded bytes are copied to `originals/` under their content address.
- `document_text.original` holds the decoded string without newline or Unicode normalization.
- `original_meta_json` holds the full source record verbatim.
- Rows larger than 64 KB keep a byte-range locator (`source_byte_start/end`) instead of a copy.

### 4.3 Normalize and segment

**Decoding.** UTF-8 in fatal mode. On failure, fall back to windows-1252 with the warning `W_ENCODING_FALLBACK`. A BOM is stripped and recorded.

**Body bounds:**
- Gutenberg: three marker regexes: `\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG`, the `END` equivalent, and the old `\*\*\*START\*\*THE SMALL PRINT` / `\*END\*THE SMALL PRINT` pair.
- Wikisource: pages are joined with `\f` (form feed), so a page boundary is an offset.

**Furniture** is flagged as `kind='furniture'`, never deleted:
- Gutenberg: `[Illustration…]` blocks, transcriber notes, and short all-caps or roman-numeral headings.
- Wikisource: lines repeated on more than 30% of a book's pages; lines of only digits in any script; lines of 3 characters or fewer.

**Passages:**
- Split on blank lines.
- **Verse mode** applies when at least 60% of a block's lines are under 60 characters and the block has at least 4 lines. Passages are then stanzas of at most 16 lines.
- Long paragraphs are split at the sentence boundary nearest 120 tokens, with a hard maximum of 200. Sentence boundaries come from `Intl.Segmenter('sentence')` plus the danda characters `।` and `॥`.
- Blocks under 12 tokens are merged forward until they reach 40 tokens, but never across a heading.
- Metadata: one passage per text field (title, native title, summary, abstract).

**Tokenizer `u61m-1`.**
- This tokenizer is the single source of truth for counts. It mirrors the FTS configuration exactly.
- A token is a maximal run of `/[\p{L}\p{M}\p{N}\p{Co}]+/u` over the **original** string, emitted with its `[start, end)` offsets.
- The folded form of each token is `NFC → toLowerCase()` (locale-independent), then Devanagari digits U+0966–096F and Gujarati digits U+0AE6–0AEF are mapped to ASCII, then U+200C, U+200D and U+00AD are removed.
- `passage.norm` is the folded tokens joined by spaces, so FTS token *i* is JS token *i*. FTS adds diacritic-insensitivity for search; analysis keeps diacritics.
- Hyphens and apostrophes split tokens, as they do in FTS. The variant generator covers `cold-wire / cold wire / coldwire`.

**Language ID per passage:**
- By script first. Gujarati script gives `gu`. Devanagari gives `hi`, unless the document declares `sa` or `mr`; confidence is 0.6 when nothing is declared.
- Latin script uses a stop-word profile over en / fr / es / de / la, with 60 function words each. A language is chosen when its hits per token are ≥ 0.15 and at least 1.5× the runner-up; otherwise the result is `und`.
- A document's `lang_text` is the token-weighted majority of its passages.
- `is_translation` is set when `lang_declared ≠ lang_text`.

**Coverage.** After every commit, `coverage_year` is rebuilt for the affected collections, using fractional apportionment.

### 4.4 Indexes and KWIC

**Indexes:**
- `passage_fts` (external content).
- `passage_vocab_row` and `passage_vocab_inst`. Instance rows give token positions per passage, which feed exact count tables cheaply.
- `title_tri`, a trigram index over titles and makers only. That is about 3M characters; trigram over all 80M tokens would roughly triple the index for little gain.

**Context windows:**

| Use | Window |
|---|---|
| KWIC display | ±12 tokens, computed at request time from the original text |
| Collocations | ±5 tokens |
| Occurrence vectors | ±10 tokens |
| Space building (PPMI) | ±4 tokens |

All windows are clipped at passage boundaries, so results are reproducible and offsets stay local.

### 4.5 Occurrences, frequency, collocations

**Materialization** (in a worker):
1. Take the expression plus its enabled variants.
2. Run an FTS `MATCH`, as a phrase query when the expression is multiword.
3. Tokenize each candidate passage with `u61m-1`.
4. Match the exact token sequence.
5. Write occurrence rows with original offsets.

Up to 20k candidate passages this is interactive (under 2 s). Beyond that it becomes a job with progress.

**Very frequent terms.** Above 300,000 occurrences:
- Exact per-year counts go to `occurrence_count`.
- Occurrence rows are a stratified sample of at most 200 per (lane value, decade), flagged `sampled = 1`.
- The UI says so: "contexts sampled: 200 of 1,894 in this bin".

**Preview.** While materialization runs, the timeline shows FTS passage-hit counts, labelled "preliminary: passages containing".

**Rate:**
- `rate = n / tokens(slice) × 10⁶`. The slice uses the same lane value and filters, the same *languages as the variants*, and the same `time_role`. A French variant is never divided by English tokens.
- 95% CI: exact Garwood interval.
- Metadata lanes report per 1,000 works with a Wilson CI.
- **Gate:** tokens ≥ 50,000 (or works ≥ 30), otherwise the bin is marked "low coverage" and shows the raw n only.
- **Default exclusions** (each a toggle): translations (from text-language chronology), duplicates (`dup_of`), `describes` passages, and furniture.

**Dispersion.** For each bin: `n_docs`, `n_authors`, and Gries' DP over documents. A bin is flagged single-source when the largest document share is ≥ 0.6.

**Collocations:**
- Window ±5.
- A candidate needs f(x,y) ≥ 5 and f(y) ≥ 10.
- Per-language stop-lists of 150 words, toggleable.
- Significance: G² (Dunning) ≥ 10.83, i.e. p < .001, and BH-FDR q < .05 across candidates.
- Strength: logDice = 14 + log₂(2·f(x,y) / (f(x) + f(y))). PPMI (α = 0.75) is also reported.
- Significant collocates are ranked by logDice.
- **Gate:** the target needs ≥ 20 occurrences in the slice. Otherwise the panel says: "Too few occurrences (12; needs 20) to list collocates — showing KWIC only."

### 4.6 Exact and near quotation detection

**Global reuse index.** This is a job ("Index text reuse"), off by default, run per collection set.
- **Winnowing** (Schleimer et al. 2003) over the folded token stream:
  - k = 8-token shingles, window w = 6. This **guarantees** detection of any shared run of ≥ k + w − 1 = 13 tokens.
  - Density is about 2 / (w + 1) ≈ 0.29 fingerprints per token, roughly 23M rows for 80M tokens.
  - Hash: the low 53 bits of FNV-1a-64 over the tokens joined by U+001F.
- **Common-formula filter:** a hash seen in more than 25 distinct documents goes into `formula_hash` (Bible verses, licence text, refrains). These hashes are not used to propose pairs, and are reported as counts.
- **Candidate pairs:** passages from different documents that share at least 2 fingerprints. Pairs where either document is `dup_of` the other, or an alias of the same work, are excluded.
- **Verification:** seed-and-extend over token arrays to find maximal common runs, keeping runs of at least 8 tokens.
- **Exact quotation** is a verified identical run of ≥ 13 folded tokens in global discovery, or ≥ 8 in a targeted trace.

**Near quotation:**
- The unit is a sentence, or a line in verse, with at least 6 tokens.
- MinHash with 128 permutations over word 3-shingles.
- LSH with 32 bands × 4 rows, so the S-curve threshold is about (1/32)^(1/4) ≈ 0.42.
- **Verification:** token-level Smith–Waterman (match +2, mismatch −1, gap −1). The normalized score must be ≥ 0.75 of the shorter unit, **and** the 3-shingle Jaccard must be ≥ 0.5. Both scores are stored.

**Targeted trace** (Lineage explorer and Then/Now/Next). For a selected span of at least 4 tokens, three lookups run:
- An FTS phrase query (exact matches).
- An LSH lookup (near matches).
- `NEAR(…, 6)` permutations, which produce "similar wording" candidates. These are always computed similarity, never quotation.

**From candidates to relationships:**

| Situation | `rel_type` | Direction | `evidence_status` |
|---|---|---|---|
| Both ends dated and A.t_hi < B.t_lo | `exact_quotation` / `near_quotation` | B → A (later → earlier) | `computed` (`run_id` and scores; source and target spans stored as evidence rows) |
| Intervals overlap, or either end undated | `shared_wording` (undirected) | none ("direction unknown") | `computed` |
| An explicit citation cue is found (below) **and** the surname of A's author matches | `explicit_citation` | B → A | `observed` (the cue span is stored as `citation_cue` evidence) |
| B matches A, and also an earlier C that A itself matches | Creates a `hypothesis_group` "Source of B's wording" | B→A and B→C | `computed` |

**Citation cue patterns.** Searched within ±30 tokens of the target span:
- en: `as X (said|wrote|put it|observed)` · `in X's words` · `X's (phrase|line)` · quotation marks around the span
- fr: `comme (l'a )?(dit|écrit) X` · `selon X`
- es: `como (dijo|escribió) X` · `según X`
- hi: `X ने कहा` · `X के शब्दों में`
- gu: `X એ કહ્યું`

Every card carries the fixed caution text (§2C). No relationship name in this stage implies influence.

### 4.7 Contextual representations (no paid APIs)

**Spaces:** PPMI followed by truncated SVD, built in a worker in pure JS on Float32Arrays.
- **Targets:** types with frequency ≥ 20 in the slice, capped at 50,000.
- **Contexts:** the top 10,000 types.
- **Window:** ±4, symmetric.
- **PPMI** with context-distribution smoothing α = 0.75.
- **Randomized SVD** (Halko et al.): d = 300, oversampling 20, 2 power iterations, seed 42 (recorded).
- **Weighting:** W = U·Σ^0.5, rows L2-normalized.

**Slices:**
- en: 1800–49, 1850–74, 1875–99, 1900–28, plus a pooled space. Translations are excluded.
- fr and es: 50-year slices plus a pooled space.
- hi and gu: pooled only.
- OpenAlex: per field family, in 25-year slices plus a pooled space.
- A slice is built only if it has at least 2M tokens; otherwise the UI says "too small for a stable space".

**Occurrence vectors** (Schütze 1998):
- v(o) = Σ PPMI(target, c) · W[c], summed over context words c in ±10 that have frequency ≥ 20 and are not stop-words. The result is L2-normalized.
- An occurrence with fewer than 3 usable context words is marked `context_thin` and excluded from clustering, with a count shown.

**Optional adapter.** Apple NLEmbedding (English, modern) is used only to suggest "modern-reader neighbours" in the variant panel. It is never used in clustering or drift.

### 4.8 Clustering occurrences into sense hypotheses

**Scope:** one expression and its enabled same-language variants, in the **pooled** language space. Because every occurrence is in the same space, shares are comparable across time without any alignment.

**Gate:** at least 60 non-thin occurrences from at least 5 documents.

**Algorithm:**
- Spherical k-means (cosine), k-means++ initialization, 10 restarts, at most 100 iterations.
- Candidate k ∈ {1 … min(8, ⌊n/20⌋)}.
- k is chosen by maximum mean cosine silhouette among the stable values of k.
- If the best silhouette is below 0.10, then k = 1 and the UI reports "no separable context groups".

**Stability:**
- 30 subsamples of 80%.
- Per-cluster stability is the mean best-match Jaccard (Hennig 2007). A cluster below 0.5 is marked `unstable` and drawn with a dashed lane outline.
- A value of k is rejected if the mean ARI between the subsample clusterings and the full clustering is below 0.6.

**Residuals.** Clusters smaller than 10 members (or 5% of n) become "other contexts" (`residual`).

**Labels:**
- The top 4 distinctive context words by log-ratio, comparing within-cluster to outside-cluster frequency, with add-0.5 smoothing and in-cluster frequency ≥ 3.
- Shown as "machine label: verse · flow · mic · beat".
- A user label is stored separately and audited through an annotation revision. The machine label stays visible in the tooltip.

**Windows:**
- Decades, merged forward until each has at least 30 occurrences.
- Shares get a document-block bootstrap CI (1,000 resamples).
- Items whose date is wider than the window are excluded.

**Transitions** (all computed, all drawn dashed):
- **Emerge:** the first window where share ≥ 10% and n ≥ 5.
- **Vanish:** the share stays under 2% across at least 2 *covered* windows. If those windows are uncovered, the transition is `unknown_gap` instead.
- **Split:** cluster B emerges at window t while its nearest older cluster A (centroid cosine ≥ 0.5) was already present.
- **Merge:** the per-window centroids of two clusters move from cosine < 0.5 to ≥ 0.7.

**Convergence of two expressions X and Y.** Per window, compute:
- J(t): the Jaccard overlap of their top-50 significant collocates.
- C(t): the cosine of their mean occurrence vectors in the shared pooled space.

They are reported as converging when J rises by at least 0.15 between the first and last gated windows **and** the bootstrap CI of that difference excludes 0.

### 4.9 Drift and displacement

There are three named measures and no single "meaning change score". All three are reported with their n.

**(a) Context-share shift**
- **What:** JSD (base 2) between the cluster-share distributions of slices A and B.
- **Uncertainty:** a document-block bootstrap with 1,000 resamples gives a 95% CI.
- **Gate:** per slice, ≥ 50 occurrences, ≥ 5 documents and ≥ 3 authors, and the clustering result must not be k = 1.

**(b) Neighbour overlap** (needs no alignment)
- **What:** 1 − Jaccard of the top-25 neighbours in the two slice spaces.
- **Null:** 500 frequency-matched control words.
- **Gate:** frequency ≥ 50 per slice.

**(c) Aligned displacement**
- **Alignment:** orthogonal Procrustes, mapping B onto A.
  - Anchors are shared vocabulary with frequency ≥ 100 in both slices, excluding the target and its top-20 neighbours in either space, capped at the 5,000 most frequent.
  - The alignment needs ≥ 3,000 anchors and a post-alignment mean anchor cosine ≥ 0.5.
- **What:** 1 − cos(W_A[x], R·W_B[x]).
- **Null:** 500 controls matched by frequency decile. The result is reported as a percentile, and called "notable" only above the 95th percentile.
- **Gate:** frequency ≥ 100 per slice, slices of ≥ 2M tokens, and the spaces built.

**Unaligned spaces cannot be compared.** The compare endpoint refuses to compute vector metrics without a `space_alignment` id (gate `unaligned`).

**Composition:**
- If the slices' composition JSD is above 0.15, the result gets `caveats: ['composition']`.
- Above 0.4, measure (c) is not reported at all.

**Wording.** The UI always says "estimated shift in usage contexts", never "the meaning changed".

### 4.10 Tone and stance (fallible annotations)

- **Machine tone:** a Swift CLI, `tools/nl-adapter`, exposes `scrolls-nl sentiment`, a paragraph-level NLTagger `sentimentScore` from −1 to 1.
  - It runs only for languages the CLI reports as supported (English is verified).
  - Results are stored as `annotation(kind='machine_tone', method='apple-nltagger-sentiment', run_id)`, with the macOS build recorded as `model_version`.
  - The UI shows a distribution and a bootstrap CI of the mean, never a single label on a passage.
- **Stance:** human annotation only, via the `stance` dimension.
- **Irony:** no automatic detection. `pragmatic_function` (sincere / ironic / reclaimed) is a human dimension, and the demo shows its counts per period.

### 4.11 What is disabled, and how the UI says it

| Feature | Gate | What the UI shows when the gate fails |
|---|---|---|
| Rate in a bin | ≥ 50k tokens / ≥ 30 works | Hatched bin, "low coverage: n = 3 in 18k tokens" |
| Collocates | target n ≥ 20; f(x,y) ≥ 5; q < .05 | "Too few occurrences (12; needs 20). Showing KWIC." |
| Context groups | ≥ 60 non-thin occurrences, ≥ 5 documents | "Clustering unavailable: 41 occurrences in 3 documents." Lanes fall back to `language`. |
| Group shares per window | ≥ 30 per window (windows merged) | "Windows merged to reach n ≥ 30: 1850–1889" |
| Context-share shift | ≥ 50 occurrences, 5 documents, 3 authors per slice | Gate card plus a computed widening suggestion |
| Neighbour overlap | frequency ≥ 50 per slice | "Word too rare in 1850–74 (31; needs 50)" |
| Aligned displacement | frequency ≥ 100; ≥ 2M tokens; ≥ 3,000 anchors; aligned | "Not estimated: spaces not aligned" / "slice too small" |
| Tone | adapter present, language supported, ≥ 30 paragraphs | "Tone needs the optional on-device adapter (not installed)" / "not available for Gujarati" |
| Deep-time band | an ancestor exists in `roots.tsv` | "No etymology family in Cipher's roots data (Latin, Greek, Sanskrit, PIE only)" |

Every gated response returns `{gate, needed, have, suggestion}`. The schema check (`gate='ok' OR value IS NULL`) means a value can never be shown for a gated measure.

---

## 5. Ingestion

### 5.1 Formats

| Format | Parsing rules |
|---|---|
| **TXT** | One document per file. The title is the file name. Leading `Title:` / `Author:` / `Date:` / `Language:` lines (Gutenberg style) are auto-detected as metadata and kept in the original. |
| **MD** | YAML-subset front matter: scalars, inline lists, and `- item` lists (a dependency-free parser). Headings become passage boundaries. The original keeps its markup; tokens skip markup characters. |
| **CSV / TSV** | RFC 4180. The delimiter is sniffed from `, \t ; \|` over the first 64 KB. Quoted multiline fields are supported. The BOM is stripped. A header is required, unless `no_header: true` is set with positional mapping. |
| **JSON** | An array of objects, or an object containing an array chosen by JSON Pointer (`/items`). Streamed for files over 100 MB. |
| **JSONL** | One object per line. Array fields can be joined into text with a delimiter; pages joined with `\f` keep `page_no`. Cipher's Wikisource files use this route. |

**Limits:** 2 GB per file (streamed), 20 MB per text field, 5M rows per import.

### 5.2 Field mapping: UI and server contract

**Canonical target fields:**

| Group | Fields |
|---|---|
| Identity & content | `ext_id` · `title` · `text` |
| People & time | `author` · `date` · `date_end` · `date_precision` (optional override) · `referenced_date` |
| Classification | `language` · `genre` · `kind` · `community` · `culture` · `field` |
| Grouping & source | `collection` · `source_url` · `license` |
| Links & extras | `cites` (list of `ext_id`s) · `relations` (list of `{type, target_ext_id, evidence?}`) · `notes` · `meta.*` (passthrough) |

**Sources a field can map from:** a CSV header, a JSON Pointer, or a constant.

**Transforms** (a closed list):
- `trim`, `join(delim)`, `split(delim)`, `lower`
- `date(grammar options)`
- `zero_is_unknown`
- `map({…})`
- `regex_extract(pattern, group)`

**Mapping UI flow:**
1. Drop a file. The **preview** shows the detected format, encoding and delimiter, plus 20 sample rows in a grid.
2. Each target field has a dropdown pre-filled from header synonyms (e.g. `date|year|published|pub_date|fecha|तारीख`). Next to it is a live parse panel, for example "date: 1,912 / 2,000 rows parse · 61 circa · 27 unknown · 0 invalid".
3. **Validate** dry-runs the mapping over all rows in a worker and returns a projected summary.
4. **Commit** starts a job with SSE progress.

The mapping is saved in `import_batch.mapping_json` and can be reused on later imports.

```json
PUT /api/imports/17/mapping
{ "format": "csv", "delimiter": ",", "header": true, "encoding": "utf-8",
  "collection": { "slug": "my-zines", "name": "Zines 1977–1999", "unit": "tokens", "license": "own" },
  "fields": {
    "ext_id": { "from": "id" },
    "title":  { "from": "Title", "transform": ["trim"] },
    "text":   { "from": "body" },
    "date":   { "from": "issued", "transform": [{ "date": { "circa_radius": 10, "two_digit_century": null } }] },
    "language": { "from": "lang", "transform": [{ "map": { "English": "en", "Hindi": "hi" } }] },
    "community": { "const": "east-side zine scene" },
    "cites":  { "from": "refs", "transform": [{ "split": ";" }] }
  },
  "options": { "dedupe": "flag", "detect_language": true, "on_bad_row": "skip_and_report" } }
```

### 5.3 Date grammar

The grammar lives in `src/shared/dates.mjs` and is shared by the server and the browser. Each parse returns `{lo_day, hi_day, lo_year, hi_year, precision, basis, rule, raw, warnings[]}`. Digits in Devanagari and Gujarati are mapped first.

| Input examples | Rule id | Precision | Basis | Interval |
|---|---|---|---|---|
| `1931-04-07`, `7 April 1931`, `7 avril 1931`, `7 de abril de 1931`, ISO date-times | `iso_day` / `dmy_named` | day | stated | that day |
| `1931-04`, `April 1931`, `abril de 1931`, `avril 1931` | `month` | month | stated | that month |
| `1931` | `year` | year | stated | the year |
| `c. 1931`, `ca. 1931`, `circa 1931`, `~1931`, `1931?`, `hacia 1931`, `vers 1931` | `circa` | year | estimated | ±`circa_radius` (default 10 y) |
| `1990s`, `the 1990s`, `années 1990`, `década de 1990` | `decade` | decade | stated | 1990–1999 |
| `'90s`, `90s` | `decade_2digit` | — | — | **rejected** unless `two_digit_century` is set (`E_DATE_AMBIGUOUS`) |
| `19th century`, `19th c.`, `XIXe siècle`, `siglo XIX`, `s. XIX` | `century` | century | stated | 1800–1899 (popular usage; at century precision ±1 y is immaterial) |
| `early / mid / late 19th century` | `century_part` | century | stated | the first, middle or last third (1800–1833, 1833–1866, 1866–1899) |
| `1850–1855`, `1850-55`, `1850 to 1855`, `between 1850 and 1855`, `1850/1851` | `range` | range | stated | as given |
| `before 1850`, `after 1850`, `antes de 1850`, `avant 1850` | `open_range` | range | estimated | 50 y on the open side (`open_range_years`) |
| `500 BCE`, `500 BC`, `500 av. J.-C.`, `500 a. C.`, `-499` | `bce` | year | stated | astronomical year −499 for "500 BCE" |
| `2nd millennium BCE` | `millennium` | millennium | stated | −1999 to −1000 |
| `संवत 1950`, `સંવત ૧૯૫૦`, `VS 1950` | `vikram_samvat` | year | derived | CE = VS − 57 to −56, giving a 2-year span |
| `शक 1850`, `Saka 1850` | `shaka_samvat` | year | derived | CE = Saka + 78 to +79 |
| `unknown`, `n.d.`, `s.d.`, `s.f.`, `sin fecha`, `sans date`, `?`, `''`, and `0` with `zero_is_unknown` | `unknown` | unknown | unknown | null |
| A date after the import time | `*` + `future` | (as parsed) | announced | the item goes on the Scheduled shelf; warning `W_DATE_FUTURE` |
| `spring 1850`, `Easter 1850` | `season` | month-range | estimated | Mar–May / Mar–Apr, with a warning |
| Anything else | — | — | — | `E_DATE_UNPARSEABLE` with up to 3 suggested readings |

**Day arithmetic.** All conversions go through `dayFromYMD(y, m, d)`, which builds `new Date(0)` and calls `.setUTCFullYear(y, m-1, d)`. Tests cover years 0–99, −4500, and 2026-10-03.

**Three kinds of time stay separate:**
- **Publication or creation** (the chronology).
- **Referenced** time: what a passage talks about. It is mapped from `referenced_date` and shown as a chip, never used to place the passage.
- **Ingestion** time: `import_batch.committed_at`, plus a `date_assertion(role='ingestion')`.

### 5.4 Duplicates

1. **Same file sha256 committed before:** the whole import is refused with `E_DUP_FILE` ("Already imported on 2026-10-03 as batch 12 — [open batch]").
2. **Same `ext_id` twice in one import:** the second row is rejected with `E_DUP_ID`, citing both line numbers.
3. **Same normalized body hash as an existing document:** the row is accepted with `dup_of` set, excluded from counts by default, and warned with `W_DUP_CONTENT`.
4. **Near-duplicate document** (whole-document MinHash Jaccard ≥ 0.9): the row is accepted and flagged `W_NEAR_DUP`. The user resolves it in the summary as "keep both" or "mark as duplicate".
5. **Metadata-only near-duplicate** (same folded title + author + year): `W_DUP_METADATA`.
6. **Cipher-specific:** Gutenberg #1661 (three QIDs on one text) becomes one document with 2 aliases.

### 5.5 Malformed input gives actionable messages

Every problem record has the shape `{code, severity, line, column?, field?, value_excerpt, message, suggestion}`.

| Code | Example message, with its suggestion |
|---|---|
| `E_ENCODING` | "Line 418: bytes are not valid UTF-8 (0xE9 at byte 30,211). Re-save as UTF-8, or accept the Windows-1252 reading shown." |
| `E_CSV_QUOTE` | "An unclosed quote starts on line 77, column 14, and runs to the end of the file. Check for a stray `\"` in the 'notes' field." |
| `E_JSON_PARSE` | "Line 7: Unexpected token `}` at column 112. The other 1,203 lines parsed; skip this line?" |
| `E_MISSING_TEXT` | "Row 55 has no text and no title. Map a text column or allow metadata-only rows." |
| `E_DATE_UNPARSEABLE` | "Row 9 date 'Spring-ish 1850': try 'spring 1850' (Mar–May 1850) or 'c. 1850'." |
| `E_DATE_AMBIGUOUS` | "Row 3 date '90s': which century? Set 'two-digit years → 19xx'." |
| `E_FIELD_TYPE` | "Row 12 'cites' is an object; expected a list of ids." |
| `E_ROW_TOO_LARGE` | "Row 4 text is 31 MB (limit 20 MB). Split the file, or import as TXT." |
| `W_LANG_MISMATCH` | "Declared French, but the text reads as English (stop-word score en 0.41 / fr 0.03). Marked as a translation." |
| `W_MIXED_LANGUAGE` | "Document 'Aarti Sangrah' has passages in hi (71%) and sa (29%)." |
| `W_TRUNCATED_ROW` | "Row 88 has 14 of 16 columns; missing fields set to empty." |
| `W_DATE_FUTURE` | "Row 2 date 2028 is after the import date; placed on the Scheduled shelf." |
| `W_ENCODING_FALLBACK`, `W_DUP_CONTENT`, `W_NEAR_DUP`, `W_DUP_METADATA` | (as described above) |

The `on_bad_row` policy is either `skip_and_report` (the default) or `abort`. Imports are transactional per batch, so `abort` leaves no rows behind.

### 5.6 Mixed languages

- Language is detected per passage. The document's language is the token-weighted majority, or the declared language when one is given.
- Lanes split by `passage.lang`.
- Frequency denominators use the tokens of the matching language.

### 5.7 Import summary object

```json
{ "import_batch_id": 17, "collection": "my-zines", "file": { "name": "zines.csv", "sha256": "9c1e…", "bytes": 4183022, "encoding": "utf-8", "format": "csv" },
  "rows": { "seen": 2000, "accepted": 1961, "accepted_with_warnings": 214, "rejected": 39 },
  "documents": { "created": 1958, "duplicates_flagged": 3, "metadata_only": 12 },
  "passages": 15422, "tokens": 2310455,
  "dates": { "day": 120, "month": 301, "year": 1288, "decade": 140, "century": 9, "range": 30, "circa": 61, "unknown": 27, "scheduled": 0 },
  "languages": { "en": 1801, "es": 102, "und": 55 },
  "mapping_decisions": [ { "target": "date", "from": "issued", "transform": "date(circa_radius=10)", "parse_rate": 0.986 } ],
  "problems": { "by_code": { "E_DATE_UNPARSEABLE": 21, "E_JSON_PARSE": 0, "W_LANG_MISMATCH": 55 },
                "first": [ { "code": "E_DATE_UNPARSEABLE", "line": 9, "field": "issued", "value_excerpt": "Spring-ish 1850",
                             "message": "…", "suggestion": "…" } ], "download": "/api/imports/17/problems.csv" },
  "run_id": 88, "started_at": "…", "finished_at": "…" }
```

---

## 6. Cipher mapping

### 6.1 Evidence vocabulary (closed)

**Evidence status** (`relationship.evidence_status`, also used on `expression_variant`):

| Value | Meaning | Required fields |
|---|---|---|
| `documented` | An external authority states the link: Wikipedia, Wikidata, MusicBrainz, ItwoFS, Wiktionary, an OpenAlex reference list, or (in the demo) the synthetic world's own records. | `source_locator`, or `locator_status='missing'` plus a `provenance_note` |
| `observed` | Verifiable in our own text: an explicit attribution cue at stored offsets, or an occurrence at offsets. | evidence rows with offsets |
| `computed` | An algorithmic estimate: shared wording, near quotation, kindred, cluster transitions, convergence. | `run_id`, method, scores |
| `proposed` | A hypothesis without verifiable evidence: Cipher's tagging-pass "counterpart" and related siblings, a user's proposed allusion. | the proposer recorded in `created_by` |

**Review status** (a separate human layer): `unreviewed · confirmed · rejected · disputed`.

**Authorship:** the `created_by` prefix is `adapter:` / `run:` / `human:`.

**Synthetic:** `is_synthetic` is carried on every entity.

### 6.2 Relationship types (seeded into `rel_type`)

Canonical direction is **src = later/dependent → dst = earlier/source**. Cipher's paired labels ("samples" / "sampled by") collapse into one row.

| Code | Family | Directed | Requires precedence | Implies transmission | Glyph |
|---|---|---|---|---|---|
| exact_quotation | quotation | 1 | 1 | 1 | “ ” |
| near_quotation | quotation | 1 | 1 | 1 | ≈“ ” |
| shared_wording | similarity | 0 | 0 | 0 | ⇋ |
| samples | quotation | 1 | 1 | 1 | ♪ |
| interpolates | quotation | 1 | 1 | 1 | ♪≈ |
| explicit_citation | citation | 1 | 1 | 1 | § |
| cites (scholarly) | citation | 1 | 1 | 1 | § |
| adaptation_of (based on) | adaptation | 1 | 1 | 1 | ⟲ |
| remake_of | adaptation | 1 | 1 | 1 | ⟲ |
| cover_of | adaptation | 1 | 1 | 1 | ⟲♪ |
| version_of | adaptation | 1 | 0 | 1 | ⟲ |
| remix_of | adaptation | 1 | 1 | 1 | ⟲♪ |
| translation_of | adaptation | 1 | 1 | 1 | ⟲文 |
| parody_of | parody | 1 | 1 | 1 | ◐ |
| recontextualizes | reinterpretation | 1 | 1 | 1 | ↻ |
| answer_to | reinterpretation | 1 | 1 | 1 | ↩ |
| reframes (later work changes the reading of an earlier one) | reinterpretation | 1 | 1 | 0 | ↺ |
| inspired_by | allusion | 1 | 1 | 1 | ✶ |
| homage_to | allusion | 1 | 1 | 1 | ✶ |
| proposed_allusion | allusion | 1 | 1 | 1 | ? |
| similar_contextual_usage (incl. kindred) | similarity | 0 | 0 | 0 | ∼ |
| counterpart | similarity | 0 | 0 | 0 | ⇄ |
| part_of (features song / from film / written for / song from) | containment | 1 | 0 | 0 | ⊂ |
| descends_from (etymon → root, word → etymon) | etymology | 1 | 0 | 1 | ⤷ |
| sense_split / sense_merge | sense | 1 | 1 | 0 | ⑂ / ⑃ |

### 6.3 Files to entities

**Corpus:** `cipher` (kind `real`).

**Collections and their unit:**

| Collection | Unit |
|---|---|
| `cipher-gutenberg` | tokens |
| `cipher-wikisource-hi` | tokens |
| `cipher-wikisource-gu` | tokens |
| `cipher-culture-works` | works |
| `cipher-etymology` | n/a; produces expressions, not documents |

**Adapter:** `cipher@1`, with `uses_network = 0`.

#### Gutenberg books (`gutenberg.json` + `texts/gutenberg/<id>.txt`)

- **Documents:** 691 unique files.
  - `ext_id` = `pg:<id>`.
  - Title and author from the JSON. `kind` = `book`, `has_full_text` = 1.
  - `prominence` = `links`.
  - `original_meta_json` = the JSON entry plus the matching `pg_catalog.csv` row (LoCC, Subjects, Issued, Authors with life dates).
  - #1661's three entries become one document with 2 `document_alias` rows.
- **Language:** `lang_declared` from the JSON, `lang_text` detected. A mismatch sets `is_translation = 1` and `original_lang = lang_declared` (about 110 books).
- **Dates:**
  - The `year` becomes `role = original_publication` if `is_translation`, else `publication`.
  - Basis is `estimated` (`rule cipher_lifetime_year`) when year = birth + 40 per the catalogue Authors field (116 books); otherwise `stated`.
  - `Issued` becomes `role = release`, which is never used for chronology.
  - The 8 books without a year are undated.
  - A translated text is not dated in its text language: its chronology assertion is `original_publication`, and coverage counts it only when "include translations" is on.
- **Text:** body bounds from the markers; passages per §4.3; facet `field` = `Literature`, unless its LoCC is Q/R/T (§10).

#### Wikisource books (`wikisource-{hi,gu}.jsonl`)

- **Documents:** 450 hi + 375 gu.
  - `ext_id` = `ws-<lang>:<index>`. `title`, `author` and `kind=book` from the record.
  - `lang_declared` = the file's language; the detector confirms it per passage.
- **Text:** pages joined with `\f`, giving `page_no` per passage.
- **Dates:** `role = publication_unspecified`, basis `stated`, with the note "Wikisource index year; may be an edition year". `null` years are undated.
- **Front matter:** the first two pages are flagged as candidates for furniture detection.

#### Culture works (`culture-works.tsv`; no header, 16 columns, 0-based row = id)

Each row becomes a **metadata document**: `ext_id = cw:<row>`, `has_full_text = 0`, `unit = works`. The original line is kept in `original_meta_json` as `{qid, kind, culture, year, …}`.

Column by column:

| Column | Becomes | Provenance and handling |
|---|---|---|
| qid | ext ref | Wikidata `Q…`, or Cipher's own `S…` id |
| kind | `document.kind` | |
| culture | `document.culture` | Label: "country of origin" |
| year | chronology | `''` or `0` → undated; `> 2026` or after today → scheduled/announced; negative → BCE; basis `stated` |
| weight | `prominence` | Never an evidence weight |
| title, native title | passages, `field` title/native_title, `time_role=document` | **The only text dated with the work** |
| maker | `author` | |
| summary | passage, `field=summary`, `time_role=describes` | Plus `date_assertion(role='authored_description', 2012–2026, precision period, basis estimated)`. Excluded from frequency by default. |
| canon | `doc_tag(scheme='canon', provenance='documented_category')` | |
| themes | `doc_tag(scheme='theme', weight)` | Provenance `machine_tag` if the theme is in that work's tag batch; `genre_heuristic` if its weight is exactly 0.55 and it matches a genre category; else `documented_category` |
| motifs | `doc_tag(scheme='motif', provenance='machine_tag')` | Method "Cipher tagging pass (Claude sub-agent, Oct 2026)" |
| meaning | `annotation(kind='machine_gloss', is_machine=1)` | Same method. **Not document text.** |
| mood | `doc_tag(scheme='mood')` | `machine_tag`, or `genre_heuristic` when the value is the half-weight 0.50 pattern |
| siblings | `relationship` rows | See §6.4 |
| sampled_count | `original_meta_json` only | Derived count, not evidence |

The **hip-hop subset** is a saved filter, not a collection: theme ∈ {hip hop, hip-hop, rap, pop rap, trap music, drill, grime, gangsta rap, conscious hip hop, …}, about 2,248 songs. It is shown as "selected by themes (mostly category-derived genre tags)".

#### Etymology (`roots.tsv`)

- Each row becomes an `expression(kind = etymon | root, lang, surface = form, roman, gloss, origin = 'roots.tsv')`, with `date_assertion(role='language_period', precision period, basis period)` from `language_period`.
- `roots` → `descends_from` (etymon → root). Status `documented`; locator `https://en.wiktionary.org/wiki/Reconstruction:<lang>/<form>` for PIE, or the lemma page otherwise. Licence CC BY-SA 4.0 with attribution.
- `members` → word expressions (`lang` en/es/fr/hi/gu) plus `descends_from` (word → etymon), `documented`.
- The member order is "commonest first", which is a frequency heuristic and is stored as `meta.rank`.
- Words are **not dated** by this. Their timeline position comes only from corpus observations.

#### Derived files

- **`culture-lines.tsv`:** not imported as documents. It is loaded into a validation table used by a test: every line should be found in a §1 passage, and mismatches are reported. Its languages inherit the Gutenberg mislabel.
- **`hinges.tsv` and Loom lines:** not imported in v1. They are derived without stored method parameters.
- **`culture-themes.tsv`:** NPMI theme associations become `computed` theme–theme edges for the constellation, with method "Cipher NPMI (build_culture.py)".

### 6.4 Siblings → relationships

**Parsing.** Siblings are `row:relation:strength[:source]` items, separated by `|`.
- Inverse pairs are collapsed into one canonical row (src = later/dependent, dst = earlier/source; e.g. "sampled by" becomes `samples` from the other end).
- The Cipher `strength` is stored as `confidence` with `confidence_kind='heuristic_strength'` and the label "Cipher heuristic weight — not a probability".

**Locators.** For `w`, `m` and `i` sources, the raw relation files are joined on (title, artist, year ±1) to fill `source_locator` from `page`. If no match is found, the row gets `locator_status='missing'`.

| Cipher relation [source] | `rel_type` | `evidence_status` | method |
|---|---|---|---|
| samples / sampled by [w, m, d] | samples | documented | wikipedia-song-article / musicbrainz:l_recording_recording / wikidata |
| interpolates / interpolated in [w, m, d] | interpolates | documented | same |
| cover of / covered as [m, w] | cover_of | documented | musicbrainz / wikipedia |
| other version / version of [m, d, w] | version_of | documented | as source |
| remix of / remixed as [w, m, d] | remix_of | documented | as source |
| answer song to / answered by [w] | answer_to | documented | wikipedia |
| inspired / inspired by [i] | inspired_by | documented | itwofs (CC BY 2.5; attribution link required in exports) |
| inspired / inspired by [w, d] | inspired_by | documented | wikipedia / wikidata P941 |
| from film / features song / written for / song from [w, d] | part_of | documented | wikipedia soundtrack / wikidata |
| kindred [-] | similar_contextual_usage | **computed** | `cipher-theme-cosine` (rarity-weighted, threshold 0.42, capped 0.7, cross-culture only); `run_id` = the cipher_load run |
| counterpart [-] | counterpart | **proposed** | tagging pass, or Wikipedia format tables (see the next row) |
| adapted as / based on / remake of / remade as / inspired / homage / echoed / version of / other version / interpolates / samples / cover [-] | as named | **proposed** if the pair appears in `$T/tags/*.jsonl` siblings for either work (the Claude tagging pass, title ±2 y match); otherwise **documented**, with `locator_status='missing'` and the `provenance_note` "Wikidata P144/P941/P4969, Wikipedia lead or remake/format table — source not recorded by Cipher" | as above |

**Date conflicts.** Any `requires_precedence` row whose src year is earlier than its dst year gets `date_conflict = 1` and is drawn as ⚠ (see §1.6).

### 6.5 Load and reconciliation

`scripts/load-cipher.mjs` runs as one job with phases: `books → wikisource → works → relations → etymology → coverage → fts optimize`. When it finishes it writes reconciliation counts into `analysis_run.metrics_json`, and `tests/cipher-mapping.test.mjs` asserts them:
- 94,385 work documents.
- 8,227 undated works.
- Scheduled works = the number of rows with year > 2026.
- Relationship totals by (`rel_type`, `evidence_status`) equal the parsed sibling pairs ÷ 2.
- 691 Gutenberg documents plus 2 aliases.
- At least 100 translations flagged.
- Wikisource undated counts 42 / 172.

---

## 7. API

All endpoints are JSON under `/api`, served on localhost only and bound to 127.0.0.1. Errors have the shape `{error: {code, message, detail}}`. Every data response carries `provenance: {run_ids, tokenizer, corpus_fingerprint, synthetic: bool}`.

### 7.1 Discovery and search

```
GET /api/corpora → [{ "slug":"demo","name":"Synthetic demonstration","is_synthetic":true,
                      "collections":[{"slug":"demo-halvern","unit":"tokens","tokens":182340,"docs":96,"sampling":"curated"}]}]

GET /api/search?q=cold%20wire&corpus=demo&mode=phrase|words|prefix|title&variants=inflection,hyphenation&limit=20
→ { "query":{"norm":"cold wire","tokens":["cold","wire"],"variants":[{"form":"coldwire","type":"hyphenation"}]},
    "expression": {"id":12,"tracked":true} | null,
    "hits": {"passages_total": 131, "documents_total": 58, "undated": 4},
    "kwic": [{"passage_id":901,"doc":{"id":44,"title":"…","date":{"label":"1997","precision":"year","basis":"stated"}},
              "left":"… we keep the","match":"coldwire","right":"steady on the mic …","start":212,"end":220,"synthetic":true}],
    "titles":[{"document_id":5521,"title":"…","kind":"song","year":2014}] }

POST /api/expressions { "surface":"coldwire","lang":"en","kind":"word","variants":["cold wire","cold-wire"] }
→ { "expression":{"id":12}, "job":{"id":301,"kind":"materialize_occurrences"} }
```

### 7.2 Timeline tiles

```
GET /api/timeline?expr=12,15&lanes=cluster&run=14&tier=L2&from=1900&to=2030
    &f=collection:demo-halvern;lang:en&translations=0&describes=0&vantage=1997
→ { "tier":"L2","bin_years":10,"from":1900,"to":2030,"mode":"bins",
    "lanes":[{ "key":"cluster:41","label":"verse · flow · mic","label_kind":"machine_editable","unit":"per_million_tokens",
               "order_rule":"first_observed","stability":0.81,
               "coverage":[{"bin":1990,"tokens":38120,"docs":11,"state":"covered","coarse_share":0.0}],
               "strands":[{ "expr":12,"glyph":"circle",
                  "bins":[{"bin":1990,"n":14,"n_frac":14,"docs":6,"authors":4,"rate":367.3,"ci":[200.8,616.3],
                           "state":"observed","flags":[],"dp":0.31}],
                  "segments":[[1990,2029]],"censor":{"left":false,"right":true} }]}],
    "coarse":[{"lane":"cluster:41","label":"dated only to decade","count":2}],
    "undated":{"cluster:41":{"docs":1,"occ":1}}, "scheduled":{},
    "transitions":[{"kind":"split","from":"cluster:39","to":"cluster:41","bin":1990,"score":0.58,"evidence_status":"computed"}],
    "arcs":{"total":44,"returned":44,"items":[{"rel_id":7781,"rel_type":"near_quotation","family":"quotation",
             "evidence_status":"computed","review_status":"unreviewed","src":{"passage":901,"y":1997,"lane":"cluster:41"},
             "dst":{"passage":77,"y":1931,"lane":"cluster:39"},"feedback":false,"date_conflict":false}]},
    "etymology":[], "provenance":{"run_ids":[14,9],"tokenizer":"u61m-1","synthetic":true} }

GET /api/timeline/occurrences?expr=12&lane=cluster:41&from=1990&to=1999&cursor=…&limit=500
→ { "items":[{"occ":55012,"passage":901,"start":212,"end":220,"t":{"lo":"1997-01-01","hi":"1997-12-31","precision":"year"}}],
    "next_cursor":"…","total":14 }
```

**Server limits:** at most 4,000 occurrences or 20,000 bin cells per response, 300 arcs, and 300 KB gzipped.

### 7.3 Passages and documents

```
GET /api/passages/901?context=1
→ { "id":901,"document":{"id":44,"title":"Coldwire (Parity Kids, 1997)","author":"The Parity Kids","kind":"song",
     "dates":[{"role":"publication","label":"1997","precision":"year","basis":"stated","asserted_by":"demo"}],
     "collection":"demo-halvern","license":"synthetic, CC0","synthetic":true},
    "field":"body","start":2110,"end":2394,"text":"…original slice…",
    "before":{"passage":900,"text":"…"},"after":{"passage":902,"text":"…"},
    "highlights":[{"start":212,"end":220,"expr":12,"occ":55012}],   // relative to text
    "lang":"en","machine":[{"kind":"cluster","cluster":41,"label":"verse · flow · mic","margin":0.22}],
    "relationships":{"out":3,"in":1},"annotations":2 }
GET /api/documents/44            → metadata, original_meta_json, aliases, tags (with provenance), date assertions
GET /api/documents/44/text?from=0&to=20000   → slice of the original, for the virtualized reader
```

### 7.4 Lineage and relationships

```
GET /api/lineage?root=passage:77&depth=2&dir=both&max_nodes=60&types=all&status=documented,observed,computed,proposed&rejected=0
→ { "nodes":[{"id":"passage:77","doc":12,"title":"…","y":1931,"lane":"lecture","undated":false,"synthetic":true,"expandable":3}],
    "edges":[{"rel_id":7781,"src":"passage:901","dst":"passage:77","rel_type":"near_quotation","family":"quotation",
              "evidence_status":"computed","review_status":"unreviewed","confidence":{"value":0.83,"kind":"alignment_score"},
              "hypothesis_group":4,"date_conflict":false}],
    "groups":[{"id":4,"question":"Source of the 1997 wording?","edges":[7781,7790]}],
    "truncated":{"nodes":12,"reason":"max_nodes"} }
GET /api/lineage/path?from=passage:2210&to=passage:77      → { "path":[…edges], "weakest":"proposed" }
GET /api/relationships/7781      → full record + evidence[] (with passage text slices) + revisions[] + annotations[]
POST /api/relationships { "src":"passage:950","dst":"passage:77","rel_type":"proposed_allusion",
                          "evidence":[{"passage":950,"start":10,"end":64,"role":"supporting"}],"note":"…","group":4 }
     → created with evidence_status "proposed" (server-forced unless a locator or verifiable cue is attached)
POST /api/relationships/7781/review { "action":"confirm|reject|dispute","note":"…","author":"human:utkarsh" }
     → { "review_status":"confirmed","revision":3,"annotation_id":220 }   // evidence_status unchanged
```

### 7.5 Constellation and compare

```
GET /api/constellation?expr=12&a=1950-1979&b=1990-2026&size=occurrences&edges=cooc,rel&max_nodes=150&layout_key=…
→ { "nodes":[{"id":"x:12","type":"expression","label":"coldwire","size":{"a":31,"b":122},"pos":[0.41,0.62]}],
    "edges":[{"s":"x:12","t":"w:mic","kind":"cooc","weight":{"a":null,"b":9.8},"measure":"logDice"}],
    "legend":{"size":"occurrences in period","edge":"logDice (co-occurrence ±5 tokens)"},
    "layout":{"seed":"fnv:3b91…","algorithm":"fr-300","pinned":true}, "truncated":{"nodes":38} }

POST /api/compare { "expr":[12], "a":{"years":[1950,1979],"f":{"lang":["en"]}}, "b":{"years":[1990,2026],"f":{"lang":["en"]}},
                    "measures":["freq","collocates","clusters","sense_share_jsd","aligned_displacement","tone"] }
→ { "coverage":{"a":{"tokens":61200,"docs":18,"authors":11,"mix":{"novel":0.7,"zine":0.3}},"b":{…},"composition_jsd":0.31,
                "caveats":["composition"]},
    "freq":{"a":{"n":31,"rate":506.5,"ci":[344.1,719.0]},"b":{…},"rate_ratio":{"value":1.9,"ci":[1.3,2.8]},"standardized":{…}},
    "collocates":{"a":[…],"b":[…],"shared":[…],"keyness":[…]},
    "clusters":{"run":14,"shares":[{"cluster":41,"a":{"share":0.0,"ci":[0,0.06]},"b":{"share":0.52,"ci":[0.43,0.61]}}]},
    "measures":[{"metric":"sense_share_jsd","gate":"insufficient_occurrences","value":null,
                 "needed":{"n":50},"have":{"a":31,"b":122},
                 "suggestion":{"a":{"years":[1940,1985]},"would_have":{"a":54}}}],
    "passages":{"a":[…5],"b":[…5],"seed":771} }
```

### 7.6 Annotations and saved views

```
GET    /api/annotations?target=passage:901&include=superseded&as_of=2026-11-01
POST   /api/annotations { "target":"passage:901","kind":"interpretation","body_md":"…","dimensions":{"pragmatic_function":"ironic"},
                          "tags":["irony"],"evidence_refs":[{"type":"passage","id":77,"start":0,"end":60}],"layer":"Reading A" }
PATCH  /api/annotations/220 { "body_md":"…" }          → new revision (rev n+1); returns { "rev":2 }
POST   /api/annotations/220/reinterpret { … }          → new annotation with supersedes=220
GET    /api/annotations/220/revisions                  → [{rev, body_md, dimensions, author, at}]
POST   /api/views { "name":"coldwire splits","state":{…} }  → { "slug":"coldwire-splits-7f3a","url":"/#view=coldwire-splits-7f3a" }
GET    /api/views/coldwire-splits-7f3a                 → { state, run_ids, annotation_rev_cutoff, import_batch_cutoff,
                                                          data_fingerprint, "drift": {"data_changed":false,"newer_runs":[]} }
```

### 7.7 Imports, jobs and analysis

```
POST /api/imports (body: raw file stream; headers X-Filename, X-Collection) → { "import_batch_id":17, "preview":{…} }
GET  /api/imports/17/preview      → { format, encoding, delimiter, headers, sample_rows[20], suggested_mapping, field_stats }
PUT  /api/imports/17/mapping      → { "validation": <summary object, dry run> }
POST /api/imports/17/commit       → { "job":{"id":302} }
GET  /api/imports/17/problems.csv
POST /api/analysis/runs { "stage":"cluster","scope":{"expression":12,"lang":"en"},"params":{"k_max":8,"seed":7} } → { "job":{"id":303} }
GET  /api/jobs?status=running
GET  /api/jobs/303
GET  /api/jobs/303/events   (SSE)  → event: progress  data: {"phase":"bootstrap","progress":0.42,"message":"subsample 13/30"}
                                      event: done      data: {"status":"succeeded","run_id":19}
POST /api/jobs/303/cancel         → { "status":"cancelling" }   (acknowledged within ≤ 500 ms; final 'cancelled' via SSE)
GET  /api/adapters                → [{name, version, uses_network, staged:{path, manifest_ok}, last_load}]
POST /api/adapters/openalex/load  { "fields":["Medicine","Computer Science"], "abstracts":true } → { "job":{…} }
```

### 7.8 Exports

```
GET /api/export?view=<slug>|state=<b64>&what=occurrences|aggregates|relationships|annotations|bundle&format=json|jsonl|csv
```

- Every export carries a manifest: view state, run ids with parameters, fingerprints, row counts, the licence and attribution list (Wiktionary CC BY-SA; ItwoFS CC BY 2.5 link-back; OpenAlex CC0 attribution), and `synthetic` flags.
- In CSV, every row also has `evidence_status`, `review_status`, `is_synthetic`, `date_precision` and `date_basis` columns.
- Collections with `export_text_allowed = 0` (OpenAlex abstracts) export ids and offsets only.

```
POST /api/snapshots { "slug":"…","png":"data:image/png;base64,…","svg":"<svg…>" } → stored under snapshots/; returns path
```

---

## 8. Frontend architecture

There is no build step. Following the spectra-lab idiom, `server.mjs` serves `public/` at `/` and `src/ui/` and `src/shared/` at `/src/*`. Server code lives in `server/` and is never served.

### 8.1 Modules

**Shell and plumbing:**
- `src/ui/app.js`: bootstrap and layout.
- `store.js`: a single state object with reducers.
- `url-state.js`: encode/decode, versioned.
- `api.js`: fetch wrapper and SSE.
- `evidence.js`: the single source of evidence styles.
- `format.js`: dates, numbers and units.

**Timeline** (`src/ui/timeline/`):
- `viewport.js`: scales, segmented axis, tier selection.
- `tiles.js`: cache and prefetch.
- Renderers: `render-ruler.js`, `render-coverage.js`, `render-strands.js`, `render-arcs.js`, `render-overlay.js`.
- `hit.js`: spatial grid.
- `input.js`: pointer, touch and wheel.
- `playhead.js`: vantage, play and reduced motion.
- `shelves.js`: undated and scheduled.
- `legend.js`.
- `a11y-table.js`.

**Views** (`src/ui/views/`): `inspector.js` (Then/Now/Next), `reader.js`, `lineage.js`, `constellation.js` with `layout-worker.js`, `compare.js`, `notebook.js`, `import-wizard.js`, `jobs-tray.js`, `views-menu.js`, `export.js`.

**Other:** `src/ui/search.js`, `lanes.js`, `filters.js`, `tour.js`, `keyboard.js`.

**Shared with the server:** `src/shared/contracts.mjs`, `vocab.mjs` and `dates.mjs`.

### 8.2 State model and URL

```js
{ v:1, corpus:'demo', exprs:[{id:12, variants:['inflection','hyphenation']}],
  lanes:{facet:'cluster', run:14, order:'first_observed', manual:[]},
  filters:{collection:['demo-halvern'], lang:['en'], kind:[], translations:false, describes:false, dups:false},
  axis:{mode:'linear', centerDay:-1234, daysPerPx:9.1}, vantage:{day:9861, strict:true},
  evidence:{documented:true, observed:true, computed:true, proposed:true, rejected:false},
  selection:{type:'occurrence', id:55012}, compare:{a:[1950,1979], b:[1990,2026]},
  panels:{inspector:true, lineage:false, notebook:false}, runs:{cluster:14, quotes:9},
  constellation:{layoutKey:'fnv:3b91…'}, reducedMotion:'system' }
```

**URL encoding.** The state is written to the hash in a compact, versioned form that is readable and stable:

```
#v=1&c=demo&e=12:ih&l=cluster:14:fo&f=col:demo-halvern,lang:en&x=lin:-1234:9.1&t=9861s&ev=dock-p&sel=occ:55012&cmp=1950-1979,1990-2026&p=i
```

A saved view adds `#view=<slug>`. The server copy is authoritative and includes the annotation cutoff and run ids. `?asSaved=1` restricts the data to `import_batch ≤ cutoff`.

### 8.3 Canvas timeline

**Layers.** Four stacked canvases sized for devicePixelRatio:

| Canvas | Contents | Redrawn on |
|---|---|---|
| 1 | Ruler and coverage | viewport change |
| 2 | Strands and bars | viewport or data change |
| 3 | Arcs | viewport or data change |
| 4 | Overlay: playhead, hover, selection, focus ring | every animation frame |

**Rendering approach:**
- Tiles are 64 bins wide. Their data arrives as plain JSON, and on arrival is packed into `Float32Array`s (`x0, x1, h, state, flags`).
- Drawing is batched by style to minimize state changes: one `fillRect` pass per fill style.
- Hatch patterns are created once as `CanvasPattern`s.
- Arcs are quadratic Béziers batched by dash pattern.

**Performance budgets:**

| Item | Budget |
|---|---|
| Overlay frame | ≤ 4 ms |
| Full redraw | ≤ 12 ms at 20,000 bin rects + 300 arcs + 400 labels (M-class Mac) |
| Occurrence dots | ≤ 4,000 per frame |
| First paint, demo | ≤ 1.0 s |
| First paint, Cipher overview | ≤ 2.0 s (coverage cached) |
| Tile request | ≤ 80 ms server p95, warm |

**Zoom and fetch:**
- Requests are debounced by 120 ms.
- The previous tier stays drawn, rescaled, until new data arrives, so there are no blank flashes.
- The tile LRU holds 200 tiles, at most about 60 MB.
- Prefetch covers one tile on each side.

**Hit-testing.**
- A uniform 24 px grid is rebuilt with every redraw of canvas 2, mapping cells to mark indices.
- Arcs are sampled into 16 segments, with a 5 px tolerance.
- Hover resolves in under 1 ms.

### 8.4 Keyboard map

| Key | Action | Key | Action |
|---|---|---|---|
| `/` | Focus search | `Space` | Play / pause |
| `,` `.` | Vantage ±1 bin | `<` `>` | Vantage ±10 bins |
| `+` `−` | Zoom at playhead | `0` | Fit data |
| `D` | Deep-time preset | `L` | Cycle lane facet |
| `E` | Cycle evidence filter (all → documented+observed → documented) | `R` | Reduced motion |
| `T` | Text/table alternative | `A` / `B` | Set compare slice from range selection |
| `G` | Lineage of selection | `C` | Compare view |
| `N` | Annotate selection | `S` | Save view |
| `Tab` | Cycle regions (search → lanes → marks → inspector) | Arrows (marks region) | ← → previous/next mark in lane; ↑ ↓ lane |
| `Enter` | Open focused mark | `Esc` | Close panel / clear selection |
| `?` | Shortcut help | | |

### 8.5 Touch, narrow viewports and accessibility

**Touch:**
- One finger pans horizontally; a vertical one-finger drag scrolls the lanes.
- Pinch zooms on the x-axis only.
- Tap selects. A 450 ms long-press peeks a tooltip.
- Double-tap zooms in ×2; a two-finger tap zooms out.
- The playhead handle is 44×44 px.

**Narrow layout (< 720 px):**
- The timeline takes the top 55vh, with at most 5 lanes plus a "more lanes" sheet.
- The undated shelf becomes a chip.
- The inspector is a bottom sheet with Then/Now/Next tabs.
- Lineage, constellation, compare and notebook become full-screen tabs; compare stacks A over B.
- The legend becomes a chip.

**Accessibility:**
- All text meets WCAG AA. Ratios on `bg-0`: ivory 15.1:1, cyan 10.6, amber 8.8, violet 7.7. `ink-3` (5.25 on `bg-0`) is not used on `bg-3`, where it drops to 4.19.
- Focus rings are 2 px cyan with a 2 px offset.
- The canvas has `role="img"` with an `aria-describedby` live summary, for example: "Lane English · text: 'coldwire' observed 1912–1938 and 1951–2024 in 2 bars; gap 1939–1950: 1939–1945 no sources, 1946–1950 looked and found none (0 in 41k tokens)."
- **Press `T` for the table alternative:** an accessible `<table>` per lane (bin, n, rate, CI, coverage, state), built from the *same* typed arrays the renderer uses, so the two cannot disagree.
- Marks get roving focus in the "marks" region.
- Reduced motion is honoured (§1.8). `forced-colors` mode swaps patterns to system colours, and the evidence encodings still hold because they never rely on colour.

### 8.6 Colour tokens and evidence encoding

```css
:root{ --bg-0:#101215; --bg-1:#1A1D22; --bg-2:#23272E; --rule:#3A3F48;
  --ink:#EDE6D6; --ink-2:#BDB6A8; --ink-3:#8C877C;
  --cyan:#5CD3E3;   /* selection & navigation: playhead, focus, selected marks, range */
  --amber:#E5A64C;  /* historical reference: arcs to earlier material, deep-time bands, THEN */
  --violet:#B095FF; /* reinterpretation: feedback arcs, reframing, NOW, hypotheses */
  --danger:#FF7A70; /* date conflicts, errors */ }
```

Strands and occurrence marks are ivory. **Evidence is never encoded by colour.** It is encoded by line pattern, glyph and a word, all defined in `evidence.js`:

| Status | Line | Glyph | Word on cards |
|---|---|---|---|
| documented | solid 2 px | ▪ square cap | DOCUMENTED + source name + locator ("source not recorded" if missing) |
| observed | solid 2 px with double tick marks | ‖ | OBSERVED IN TEXT + cue/span |
| computed | dashed 6/4, 1.5 px | ≈ | COMPUTED + method + run |
| proposed | dotted 1/3, 1.5 px | ? | PROPOSED + by whom |

**Overlays** (independent of status):
- Human-created: ✎ badge.
- Confirmed by a human: ✓. Rejected: ✕, with the line struck through, hidden by default. Disputed: ⚖.
- Synthetic: a hatched "SYN" chip on every card, plus a dashed outer frame on panels that show synthetic material.

A unit test asserts that the four statuses produce four distinct (dash, glyph, word) triples, and that no style differs only in hue.

---

## 9. Demonstration corpus (all SYNTHETIC)

**Contents.** About 96 documents and 320 passages, from 1895 to 2026, in corpus `demo` with `is_synthetic=1` on every row. The data lives as authored JSONL in `data/demo/` and is loaded through the **ordinary import path**, so it also exercises ingestion.

**Deliberate test conditions built in:**
- A coverage gap from 1939 to 1945 in the engineering lane: "archive lost — synthetic".
- One undated document, one `c. 1890s`, one decade-precision `1970s`, one `संवत 2035` (1978) Hindi film-song title, and one future-dated "2027 reissue" for the Scheduled shelf.
- A Gujarati and a Hindi lane.
- The rap-scene lyrics are invented here, so the demo can show full-text verse **only because it is synthetic**. Real Cipher songs stay metadata-only.

**Every displayed name carries "(synthetic)" in its tooltip.**

### 9.1 Synthetic cast

| Name (synthetic) | Years | Role |
|---|---|---|
| Iolanthe Brask | 1889–1967 | Radio physicist, Halvern Institute |
| Halvern Electric Co-operative | pamphlets 1919–1958 | Civic engineering voice |
| Teodor Vass | 1921–1990 | Textbook author |
| Hollis Marr | 1927–1999 | Spy novelist |
| Kantilal Vora | 1918–1994 | Gujarati poet |
| Augustin Pell / Ruth Calloway | 1928–2003 / 1931–2019 | Critic vs. science educator (the 1974 dispute) |
| Lowmoor Chapel hymnal committee | 1956 | Hymn community |
| Mae "Relay" Odum-Hart | b. 1958 | DJ and producer, Wexford Street sound systems |
| The Parity Kids (Dov "Checksum" Ruiz, Sunny Qadri) | 1991–2004 | Rap crew |
| Priya Halloran-Mehta | b. 1987 | Coding-bootcamp founder |
| Jun-seo Albrecht | b. 1994 | Machine-learning researcher |
| Noor Castellan | b. 2001 | Rapper (2024 tracks) |
| Halvern Museum of Signals | 2022 | Wall texts |

### 9.2 Seven phenomena, seven expressions

1. **Sincere → ironic: "the future is wired."**
   - 1924, Co-operative pamphlet (sincere): *"The future is wired, and every farmhouse shall share in it."*
   - 1951, school reader (sincere).
   - 1979, zine *Static Weekly* (ironic): *"The future is wired — straight to the meter."*
   - 1998, a Parity Kids mixtape track "Future Is Wired (Collect Call)" (ironic).

   **What it demonstrates:** human annotations on `pragmatic_function` (9 of them, by 2 synthetic annotators) show sincere → ironic per period. The app says that **no machine irony detection exists**, which is the lesson.

2. **Ironic → reclaimed sincerely: "glitch kid."**
   - 1983, internal memo (pejorative): *"keep the glitch kids off the test bench."*
   - 1987, trade-letter self-mockery.
   - 1993, the Parity Kids' "Glitch Kid Anthem" (ironic swagger).
   - 2016, Halloran-Mehta's bootcamp manifesto (sincere): *"We are glitch kids: we learn by breaking things on purpose — as the Parity Kids put it, 'we broke it first.'"* This is an `explicit_citation`, **observed**.
   - 2023, a conference talk "Proud Glitch Kids".

3. **A symbol changing across communities: "the broken ring."**
   - Engineering, 1931: the open-circuit symbol, meaning danger.
   - Lowmoor hymnal, 1956: "mend the broken ring", meaning broken communion.
   - Sound-system flyers, 1989: "Broken Ring night", meaning an open floor where anyone can step in.
   - Vora's Gujarati poem *તૂટેલી વીંટી* (1962): separation.
   - Open-source README, 2020: "fork welcome".

   **What it demonstrates:** lanes = community show separate collocate sets. The constellation compares 1925–1965 with 1985–2026.

4. **A remembered reference gaining new context: Brask's line.** *"We do not discover the signal; we learn to stop drowning it out."*
   - 1931: the original lecture transcript.
   - 1962: Vass quotes it: *"As Brask said, …"* → exact quotation plus explicit citation, **observed**.
   - 1988: Odum-Hart's track "Stop Drowning It Out" samples the archival recording → `samples`, **documented** (synthetic liner notes as the locator).
   - 1997: a Parity Kids verse: *"we don't find the signal, we just stop drowning it out"*, about sirens on Wexford Street → `near_quotation`, **computed**, plus an annotated recontextualization.
   - 2021: Albrecht's paper abstract: *"in Brask's phrase, learning to stop drowning out the signal"* → near quotation, **computed**, plus an explicit citation, **observed**. A footnote reads *"after the 1997 Parity Kids verse, the line reads as being about who gets heard"*, which becomes a `reframes` relationship (2021 → 1931), **documented within the synthetic world**. It is the demo's **feedback arc**.
   - A **competing hypothesis**: the 1997 verse came either from the 1988 sample or from the 1962 textbook, as a `hypothesis_group` with 2 edges.

5. **A term splitting: "coldwire"** (96 occurrences; this is the clustering demo, and it passes the gate).
   - 1912–1938, telegraph and engineering: an unpowered line (*line, insulation, splice, voltage*).
   - 1951–1979, Marr's spy fiction: an untraceable contact (*handler, drop, safehouse*).
   - 1990–2026, rap: a cold, unbroken flow (*verse, flow, mic, beat*).
   - 2012–2026, software: a dormant code path (*deploy, branch, patch, flag*).
   - The Hindi film-song title *ठंडा तार* (VS 2035, i.e. 1978) is a `translation` variant, **proposed**. It is shown only when the user enables translation variants.
   - Expected result: k = 4, stability > 0.7, and three `split` transitions.

6. **Two expressions converging: "ghost mass" + "back-room hands."**
   - "Ghost mass": Brask-era physics (1933), inferred unseen mass.
   - "Back-room hands": 1940s labour slang for uncredited workers.
   - 2014: Castellan-precursor track "Ghost Mass (For the Back-Room Hands)".
   - 2019: an essay: *"ghost mass — the back-room hands of any scene."*
   - **What it demonstrates:** collocate Jaccard rises from 0.00 (1930–79) to 0.34 (2010–26), with a CI that excludes 0, so the `⑃` convergence glyph appears.

7. **A disagreement becoming inherited meaning: "loud science."**
   - 1969, science-fair pamphlet: "Make science loud!"
   - 1974, Pell's review: *"loud science is vulgarized science."* Calloway's reply, also 1974: *"loud science is science that finally lets everyone in."* They are linked by `answer_to`, **documented**.
   - 1996, a Parity Kids track: *"Pell called it vulgar, we call it ours."* This explicitly cites Pell (**observed**) and is annotated as siding with Calloway.
   - 2022, a museum wall text: *"'Loud science' has always carried the argument about who science is for."*
   - In the notebook, two synthetic annotators hold competing interpretations, with superseded revisions kept.

### 9.3 Guided tour (8 steps, about 4 minutes; content in `data/demo/tour.json`)

| # | User action | What they see and learn |
|---|---|---|
| 1 | Opens app → "Start tour" | SYNTHETIC ribbon; "coldwire" timeline. *Bars = observed spans.* |
| 2 | Hovers the 1939–45 region | Hatched "no sources (synthetic archive gap)" vs. dotted "looked, found none" in 1946–50. *Absence has two kinds.* |
| 3 | Presses ▶ (or Step with reduced motion) | Context groups branch in the 1950s, 1990s and 2010s (dashed = computed). *Splits are estimates with stability scores.* |
| 4 | Clicks a 1997 dot | Then/Now/Next: offsets highlighted; THEN shows 1990s contemporaries; date chip "year · stated". *Every mark opens its passage.* |
| 5 | Types the Brask line, then opens Lineage | “ ” observed citation (1962), ♪ documented sample (1988), ≈ computed near quotation (1997, 2021), ⚖ competing sources. Presses `E`: computed edges vanish. *Status is visible and filterable.* |
| 6 | Drags the vantage past 2021 | The 1931 passage gets a violet ring; a backward arc appears. *Later works change how earlier ones are read — only when a documented or annotated link says so.* |
| 7 | Compares "glitch kid" 1983–1990 vs 2010–2026 | Collocates differ; the context-share shift is **not estimated** ("12 vs 22 occurrences; needs 50"); annotated pragmatic function shows pejorative → reclaimed with n. *The app refuses to overclaim.* |
| 8 | Opens the Notebook on "loud science"; adds a note; presses `S` | Two interpretations, both kept; their revision history; a saved view link. *Interpretations accumulate in layers; views are reproducible.* Final card: "Now try real data: Cipher → `virus`." |

---

## 10. STEMM integration

### 10.1 Adapter interface

The interface lives in `src/shared/contracts.mjs`. Every source, including file imports, flows through `server/ingest/commit.mjs`.

```js
/** @typedef {{ ext_id:string, title?:string, text?:string, fields?:Record<string,string>,
 *   dates:{raw?:string, value?:object, role:string, basis?:string, asserted_by:string}[],
 *   lang_declared?:string, kind:string, field?:string, community?:string, culture?:string,
 *   author?:string, source_url?:string, license?:string, meta:object, tags?:{scheme,value,weight,provenance,method}[] }} CanonicalDocument */
/** @typedef {{ src_ext:string, dst_ext:string, rel_type:string, evidence_status:'documented'|'observed'|'computed'|'proposed',
 *   method:string, source_locator?:string, confidence?:{value:number, kind:string}, note?:string }} CanonicalRelationship */
export const AdapterShape = {
  name:'string', version:'semver', uses_network:'boolean', license:'string', attribution:'string',
  describe:'() => {collections:[{slug,name,unit,sampling,export_text_allowed}], facets:string[]}',
  plan:'async (params, ctx) => {units:number}',                     // for progress
  documents:'async function* (params, ctx) → CanonicalDocument',
  relationships:'async function* (params, ctx) → CanonicalRelationship',
  annotations:'async function* (params, ctx) → {target_ext, kind, method, body, dimensions}',
};
// ctx = { signal: AbortSignal, progress(done,total,msg), warn(code,msg,detail), stagedDir, dataDir }
```

**Rules every adapter follows:**
- Adapters read staged files from `~/Developer/scrolls-data/sources/<name>/`. **They read `FORMAT.md` and `MANIFEST.json` first** and copy the manifest's caveats into `collection.notes`.
- Network fetching lives only in `tools/fetch/*.mjs`. Those are opt-in, user-run and logged. The app itself never fetches unless the user presses "Fetch (network)" on the Adapters page, which shows the host, the rate limit and the licence first.

### 10.2 The four sources

| Adapter | Staged input | What becomes what | Dates | Evidence notes |
|---|---|---|---|---|
| `gutenberg-stemm` | `catalog.jsonl`, `texts/`, `cipher-overlap.jsonl` | Texts become full-text documents in collection `gutenberg-stemm` (unit tokens). LoCC goes into `doc_tag(locc)` and is mapped to a field (§10.3). | Wikidata P2034 → P577 gives `stated`; otherwise birth + 40 gives `estimated` (`rule lifetime`); otherwise undated. `Issued` gives `role=release`. | Overlap with Cipher's 693 is aliased, not duplicated. The Jargon File (TK) is dated by its own edition statements if present, else undated: never its 1992 release date. |
| `openalex` | `works.jsonl`, `citations.tsv`, `coverage.tsv`, `population.tsv` | Each work becomes a document (kind = `paper`/`book`/…; `field`; `title` passage dated with the work; `abstract` passage dated with the work; machine `topic`/`keyword` tags). Citations become `cites` relationships (**documented**, locator `https://openalex.org/W…`). `cited_year > citing_year` gives `date_conflict=1`. | Date as given by the fetcher's precision (`day`/`month`/year); `-12-31` gets the note "possible placeholder". | `sampling='top_cited_per_cell'`; `export_text_allowed=0` for abstracts. Lanes show "sample 200 of 14,516 works in OpenAlex for Mathematics 1875–99". OpenAlex machine language codes are kept but our detector decides `lang_text`. |
| `wiktionary-coinage` | `terms.jsonl`, `stats.json` | Each term's coinage or first-attestation statement becomes a `date_assertion(subject=expression, role='first_attestation_claim', basis='stated', asserted_by='wiktionary')` plus a `documented` locator. | As the statement gives it (year, century, "c. 1890"). | Drawn as a **hollow diamond on the strand's left**, labelled "Wiktionary: first attested 1898 (external claim)". It is never counted as an occurrence, and it never moves the bar's start. |
| `ngram-baseline` | `ngram-eng-1.sqlite` | No documents. It feeds an "External baseline (Google Books eng, CC BY 3.0)" lane with a thin line per tracked English word. | yearly | Unit "per million (Google Books)". Never summed with corpus counts. In Compare, it adds the Spearman ρ of decade rates between our corpus and the baseline: "Does our sample track a larger corpus?" |

### 10.3 STEMM fields as lanes

Facet `field` uses one shared taxonomy across sources, with the source's own label kept in `doc_tag`:

| Lane | LoCC | OpenAlex fields |
|---|---|---|
| Mathematics | QA | 26 |
| Physical sciences | QB, QC, QD | 31, 16, 25 |
| Earth & environment | QE, GB | 19, 23 |
| Life sciences | QH, QK, QL, QP, QR | 13, 11, 24, 28 |
| Medicine & health | R* | 27, 29, 30, 35, 36, 34 |
| Engineering & technology | T, TA–TX | 22, 15, 21 |
| Computing | QA75–76, TK51–TK7895 | 17 |
| Literature & culture | Cipher books; Gutenberg non-QRT | — |
| Song / film / TV titles | Cipher culture works, by `kind` | — |

The **"Domains"** lane preset uses exactly these rows, so a term can be followed down the screen from science lanes to culture lanes.

### 10.4 Following terms honestly

The **Term trail** preset tracks an expression with its inflection, hyphenation and (optionally) translation variants; sets lanes to Domains; and turns on the etymology band, the Wiktionary claim marker and the Ngram baseline. Five guardrails apply:

1. **Co-presence is not transmission.** If two lanes contain the term but no documented, observed or computed edge joins them, the trail shows a banner: *"These lanes share a word. No link between them is recorded. [Propose a link]"*. That button creates a `proposed` relationship with the user's evidence.
2. **Titles, not lyrics.** Song and film lanes count **titles** only, per 1,000 works. Summaries and glosses are excluded by default. A matching summary is shown greyed as "described later, by Wikidata or the Cipher tagging pass".
3. **Name collisions.** A `proper_noun_guard` flags capitalized matches that are not sentence-initial and are followed by a capitalized token ("Gene Kelly"). Flagged matches are excluded from counts and listed in "excluded as names (49)". The user can override.
4. **Senses are separated, not assumed.** For *virus* and *viral*, clustering in the OpenAlex + Gutenberg pooled space is expected to separate biological, computational and marketing contexts. It is reported only if the gates pass.
5. **Missing families are stated.** *bug*, *hacker* and *algorithm* have no Latin, Greek, Sanskrit or PIE family in `roots.tsv` (Germanic and Arabic origins are not covered). The band says so, and offers the Wiktionary claim if `wiktionary-coinage` has one.

**Worked expectations (from the data checked above):**

| Term | Expected trail |
|---|---|
| ***virus*** | `la:virus` "venom" period band → 1840s–1880s figurative uses in French books (the 1841 "Balzac" line is English **translated** text, so it is excluded from 1841 English) → OpenAlex: 1,104 works mention it → titles: 8 works. *viral* matches 89 works, mostly in summaries, which are excluded by default. |
| ***gene / engineer / genre / genius*** | Share PIE \*ǵenh₁- (**documented descent**). The constellation can show the family, labelled "etymological family — shared ancestry, not shared meaning". |
| ***quantum*** | `la:quantus` → OpenAlex physics, 1900s onward → 19 culture works ("Quantum Leap"). |
| ***hacker*** | 5 OpenAlex works, 2 films. "Too few observations for anything beyond listing" — and the UI lists them. |

---

## 11. Test plan, mapped to the brief's §12

The runner is `node --test tests/*.test.mjs`. Each test file starts a server on a temporary `SCROLLS_DATA` directory. Fixtures live in `tests/fixtures/`.

| Acceptance criterion | Test file(s) | What is asserted |
|---|---|---|
| A real uploaded corpus imports and is searchable | `ingest.test.mjs`, `cipher-mapping.test.mjs` | CSV/TSV/JSON/JSONL/TXT/MD fixtures, including Devanagari and Gujarati, import. FTS finds `अनुपम` and `ગુજરાતી` as whole tokens. A 3-book Gutenberg slice and 20 Wikisource pages from the real files import, and searching a known word finds known offsets. |
| Dates and unknown dates behave correctly | `dates.test.mjs`, `aggregation.test.mjs` | At least 80 grammar cases (BCE, circa, decade, century fr/es, VS/Saka, Devanagari digits, `''`/`0` unknown, future → scheduled, `'90s` rejected); `dayFromYMD` for years 0–99; undated items never land in bins but appear on the shelf; fractional bins sum to the totals within 1e-9. |
| Every displayed occurrence opens its original passage | `offsets.test.mjs` | Property test over 5,000 random occurrences: `original.slice(start, end)` folds to the variant. `/api/passages/:id` highlight slices equal the tokens. **Tokenizer parity**: JS token counts equal `passage_vocab_inst` counts on 10k passages. Every demo occurrence resolves. |
| Filters update visualizations and counts consistently | `aggregation.test.mjs` | For random filter combinations, the sum of tile bins equals `/api/timeline/occurrences` total, which equals the Compare `freq.n`. Coverage denominators match the documents. The a11y table and the renderer arrays come from the same object (identity check). |
| Demo material is clearly labelled | `demo.test.mjs` | Every demo row has `is_synthetic=1`. All API responses carry `synthetic:true`. CSV exports have an `is_synthetic` column. The manifest flags it. Snapshot footer text is checked. A DOM smoke test checks the SYNTHETIC ribbon and the badges. |
| Inferred lineage cannot be mistaken for documented citation | `provenance.test.mjs` | The trigger blocks an `evidence_status` UPDATE. Confirming a computed edge leaves it `computed`. A human-created edge without a locator or cue is forced to `proposed`. The "documented only" filter excludes computed and proposed. `evidence.js` styles are 4 distinct triples with no colour-only difference. The Cipher kindred count equals the computed count, and counterpart equals proposed. |
| Insufficient evidence never yields authoritative drift claims | `gates.test.mjs` | Small synthetic samples give `gate≠ok` and `value=null` (the DB CHECK as well). Unaligned spaces are refused. Composition JSD > 0.4 suppresses measure (c). The UI copy grep finds no "meaning changed". Mental-state verbs are absent from UI strings. |
| Saved views and annotations survive restart | `persistence.test.mjs` | Create a view, 3 annotation revisions and a relationship review; kill the server process (SIGKILL); restart; the state, revision chain and review status are identical. Revision UPDATE/DELETE is blocked. `?asSaved=1` reproduces counts after a later import. |
| Malformed input gives actionable feedback | `ingest.test.mjs` | Fixtures: unclosed quote, bad JSON on line 7, invalid UTF-8, unparseable date, 31 MB field, truncated row. Each asserts the code, line/column and a non-empty suggestion, and that `abort` leaves no rows behind. |
| Main flow works on desktop and narrow viewports | `e2e/journey.md` checklist, plus `ui-smoke.test.mjs` | Scripted in the Claude Browser pane at 1440×900 and 375×812: import → search → timeline → open evidence → compare → save view, with screenshots stored. `ui-smoke` fetches every ES module and checks there are no 404s and no syntax errors. |
| Expensive analysis does not freeze the UI | `jobs.test.mjs` | Start clustering on 50k synthetic occurrences; 50 parallel `/api/health` and `/api/timeline` calls stay under 50 ms p95. Cancel is acknowledged in under 500 ms, the final status is `cancelled`, and no rows of that run are visible. Restart marks running jobs `interrupted`. |
| Meaningful tests for ingestion, offsets, aggregation, provenance, persistence | (above) plus `quotes.test.mjs`, `cluster.test.mjs` | Winnowing guarantee: an inserted 13-token run is always found and a 12-token run is not required. Near-quote thresholds. Citation cue in each of the 5 languages. Planted demo clusters are recovered with ARI ≥ 0.8. Procrustes recovers a known rotation to cos > 0.999. |

---

## 12. Build plan: 8 work packages, exclusive file ownership

### 12.1 Target tree

```
Scrolls/                                   (iCloud; source only — git dir at ~/Developer/git/Scrolls.git)
├─ package.json  server.mjs  README.md
├─ Docs/ brief.md  data-inventory.md  proposals/  IMPORT-SCHEMA.md  ANALYSIS.md  CIPHER-MAPPING.md
├─ server/
│  ├─ db/ schema.sql  open.mjs  migrate.mjs  seed-vocab.mjs
│  ├─ http/ router.mjs  sse.mjs  static.mjs  errors.mjs
│  ├─ jobs/ runner.mjs  worker.mjs  query-pool.mjs
│  ├─ ingest/ sniff.mjs  csv.mjs  json.mjs  jsonl.mjs  txt.mjs  md.mjs  frontmatter.mjs  mapping.mjs
│  │          validate.mjs  dedupe.mjs  summary.mjs  commit.mjs
│  ├─ text/ tokenize.mjs  normalize.mjs  segment.mjs  langid.mjs  furniture.mjs  passages.mjs  fts.mjs
│  │        occurrences.mjs  coverage.mjs  aggregate.mjs  kwic.mjs  variants.mjs  stopwords/*.json
│  ├─ analysis/ collocations.mjs  keyness.mjs  stats.mjs  winnow.mjs  minhash.mjs  align-sw.mjs  quotes.mjs
│  │            cues.mjs  ppmi.mjs  svd.mjs  occvec.mjs  cluster.mjs  transitions.mjs  procrustes.mjs
│  │            drift.mjs  gates.mjs  tone-adapter.mjs
│  ├─ adapters/ registry.mjs  cipher-books.mjs  cipher-wikisource.mjs  cipher-works.mjs  cipher-relations.mjs
│  │            cipher-roots.mjs  gutenberg-stemm.mjs  openalex.mjs  wiktionary-coinage.mjs  ngram-baseline.mjs
│  │            field-taxonomy.json  language-periods.json
│  └─ api/ jobs.mjs  imports.mjs  search.mjs  timeline.mjs  passages.mjs  documents.mjs  lineage.mjs
│          relationships.mjs  constellation.mjs  compare.mjs  analysis.mjs  annotations.mjs  views.mjs
│          exports.mjs  adapters.mjs
├─ src/
│  ├─ shared/ contracts.mjs  vocab.mjs  dates.mjs
│  └─ ui/ app.js  store.js  url-state.js  api.js  evidence.js  format.js  search.js  lanes.js  filters.js
│         keyboard.js  tour.js
│         timeline/ viewport.js tiles.js render-ruler.js render-coverage.js render-strands.js render-arcs.js
│                   render-overlay.js hit.js input.js playhead.js shelves.js legend.js a11y-table.js
│         views/ inspector.js reader.js lineage.js constellation.js layout-worker.js compare.js notebook.js
│                import-wizard.js jobs-tray.js views-menu.js export.js
├─ public/ index.html  scrolls.css  icons.svg
├─ data/demo/ documents.jsonl  relationships.jsonl  annotations.jsonl  mapping.json  tour.json  README.md
├─ scripts/ load-cipher.mjs  load-demo.mjs  smoke.mjs
├─ tools/ fetch/*.mjs (existing)   nl-adapter/ main.swift  build.sh
└─ tests/ fixtures/…  *.test.mjs  e2e/journey.md
```

### 12.2 Packages

**WP0 — Foundation and contracts.** One agent, first, about 1 day. Everyone else waits on it.

*Owns:*
- `package.json`, `server.mjs`
- `server/db/*`, `server/http/*`, `server/jobs/*`, `server/api/jobs.mjs`
- `src/shared/contracts.mjs`, `src/shared/vocab.mjs` (evidence/relationship/date vocabularies, seeded into `rel_type` and `dimension_def` by `seed-vocab.mjs`), `src/shared/dates.mjs` (full grammar and day arithmetic)
- `tests/foundation.test.mjs`, `tests/dates.test.mjs`, `tests/jobs.test.mjs`
- `tests/fixtures/contracts/*.json`: canned responses for every endpoint in §7, so UI packages can build against them.

*Delivers:*
- The schema exactly as in §3.
- The router, SSE, and the worker runner with SharedArrayBuffer cancel flags.
- The query pool: 2 read-only workers, so heavy reads never block the event loop.
- `SCROLLS_DATA` resolution and the data-directory layout.

**WP1 — Ingestion.**
- *Owns:* `server/ingest/*`, `server/api/imports.mjs`, `src/ui/views/import-wizard.js`, `tests/ingest.test.mjs`, `tests/fixtures/ingest/*`, `Docs/IMPORT-SCHEMA.md`.
- *Depends on:* WP0 contracts (`CanonicalDocument`, the date grammar) and the WP3 `passages.mjs` interface (`segmentDocument(doc) → passages[]`, stubbed by WP0).

**WP2 — Text core and timeline API.**
- *Owns:* `server/text/*`, `server/api/{search,timeline,passages,documents}.mjs`, `tests/{offsets,aggregation}.test.mjs`.
- *Delivers:* the tokenizer with FTS parity, segmentation, language ID, furniture detection, occurrence materialization, coverage, tile aggregation and KWIC.

**WP3 — Cipher and STEMM adapters.**
- *Owns:* `server/adapters/*`, `server/api/adapters.mjs`, `scripts/load-cipher.mjs`, `tests/{cipher-mapping,adapters}.test.mjs`, `Docs/CIPHER-MAPPING.md`.
- *Depends on:* WP1 `commit.mjs` (via the adapter interface) and WP2 coverage rebuild.

**WP4 — Analysis.**
- *Owns:* `server/analysis/*`, `server/api/{lineage,relationships,constellation,compare,analysis}.mjs`, `tools/nl-adapter/*`, `tests/{quotes,cluster,gates,provenance}.test.mjs`, `Docs/ANALYSIS.md`.
- *Depends on:* WP2 tables (occurrences, passages) — it can start on synthetic fixtures straight away.

**WP5 — App shell and timeline UI.**
- *Owns:* `public/*`, `src/ui/{app,store,url-state,api,evidence,format,search,lanes,filters,keyboard,tour}.js`, `src/ui/timeline/*`, `tests/ui-smoke.test.mjs`.
- *Depends on:* WP0 contract fixtures only, until integration.

**WP6 — Views and notebook.**
- *Owns:* `src/ui/views/{inspector,reader,lineage,constellation,layout-worker,compare,notebook,jobs-tray,views-menu,export}.js`, `server/api/{annotations,views,exports}.mjs`, `tests/persistence.test.mjs`.
- *Depends on:* WP5 `evidence.js`, `store.js` and `api.js` (it imports them but does not edit them) and WP0 fixtures.

**WP7 — Demo corpus and tour content.**
- *Owns:* `data/demo/*`, `scripts/load-demo.mjs`, `tests/demo.test.mjs`.
- *Delivers:* the §9 content, authored to hit the gates (coldwire ≥ 96 occurrences across ≥ 20 documents), loaded through the WP1 import path.

**WP8 — Integration, QA and handoff** (last).
- *Owns:* `README.md`, `scripts/smoke.mjs`, `tests/e2e/*`.
- *Delivers:* runs the full journey on desktop and narrow viewports in the browser pane, records screenshots, writes the "what works / needs optional adapter / unfinished" section, and files bugs back to the owning packages. It edits no other package's files.

### 12.3 Order and milestones

1. **Day 0: WP0 merges.** The schema, contracts, fixtures, date grammar and job runner exist.
2. **M1, the vertical slice** (WP1, WP2, WP5 and WP7 in parallel; WP3 starts the Cipher books and works loaders):
   - Import demo and Cipher books → search → timeline with honest bars, shelves and coverage → open passage (inspector THEN column) → Compare with frequency and coverage only → save view.
   - Exit criterion: the persistence, offsets, aggregation and dates tests pass.
3. **M2, lineage** (WP4 quotes and relationships, WP3 relations, WP6 lineage):
   - The lineage explorer with evidence styles, review actions, hypothesis groups and Cipher siblings.
   - Exit criterion: the provenance tests pass.
4. **M3, context groups** (WP4 spaces and clustering, WP5 cluster lanes and branches, WP6 Compare clusters).
5. **M4, constellation and notebook** (WP6).
6. **M5, advanced** (WP4 displacement and the NL adapter, WP3 OpenAlex / Wiktionary / Ngram lanes), then **WP8**.

**Shared contracts every package codes against:**
- `contracts.mjs`: entity shapes, API request/response JSON shapes, the adapter interface, gate codes and job events.
- `vocab.mjs`: evidence and review statuses, `rel_type` rows, date roles, precisions and bases, the dimension list.
- `dates.mjs`: one implementation, imported by both server and UI.
- The fixtures in `tests/fixtures/contracts/`.

A change to any of these files goes through WP0's owner, who does it in a single commit that bumps `contracts.version`.

---

## Appendix A. Ambiguities in the brief, decided (one line each)

- **"Expression"** is created lazily when a query is tracked. Precomputing occurrences for every type in 80M tokens would be waste.
- **Offsets are UTF-16 code units.** Both runtimes slice natively, and round-trip tests prove it.
- **"19th century" means 1800–1899.** It matches popular usage, and ±1 year is immaterial at century precision.
- **"Community" is not Cipher's `culture`.** Cipher's `culture` is a country of origin, labelled as such; community is a user-import facet.
- **Translations are excluded from text-language chronology by default.** The English text of a French novel was not written in the novel's year.
- **Retrospective descriptions are excluded from frequency.** A 2015 Wikidata sentence is not 1962 language.
- **Song lanes count titles per 1,000 works and never share a scale with per-million-token lanes.** The denominators differ in kind.
- **Vantage is the fourth dimension**, not a "z axis of intensity". Reinterpretation needs a reading time.
- **The deep-time segmented axis is the only non-linear axis.** It is explicitly declared, and it disables panning so distances cannot be misread.
- **No automatic irony or stance detection.** Lexical methods cannot support it; human dimensions can.
- **Similarity never creates feedback arcs or influence edges.** The brief forbids establishing influence from similarity.
- **OpenAlex citations to later-dated works are date conflicts, not feedback.** That is what they are.
- **Synthetic lyrics are allowed in the demo only.** They are ours; Cipher's real songs stay metadata-only.
