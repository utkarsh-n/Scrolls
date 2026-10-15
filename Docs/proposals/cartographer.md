# Scrolls — A Living Atlas of Meaning
## Proposal "Cartographer" (experience-first architecture)

*One of three independent architectures. Written 2026-10-03 against `Docs/brief.md` and
`Docs/data-inventory.md`. Grounding checks were run on the real files (numbers quoted below
were measured, not guessed). No code was written.*

The idea in one line: Scrolls is an observatory with one main instrument, **the Scroll** (the
4D gantt), four lenses (Constellation, Lineage, Then/Now/Next, Compare) and a logbook (the
Notebook). Every mark on every screen leads back, in at most two clicks, to a passage of
original text, or to a labeled statement saying why no passage exists.

---

## 0. Decisions at a glance (ambiguities resolved)

| # | Decision | Why (one line) |
|---|---|---|
| D1 | **4D = Time × Lane × Strand (sense) × Transmission (arcs).** Frequency, variety, coverage and evidence are *encodings on marks*, not dimensions. | You navigate a dimension; you read a quantity. |
| D2 | **A gantt bar is a set of observed segments plus two end caps.** It is never one continuous bar from first to last observation. | "Must not invent continuity across gaps." |
| D3 | **Deep time uses a *folded* axis:** linear segments joined by visible, labeled seams. There is no log axis anywhere. | Both 6,500 years and 35 days must be readable, with no hidden scale tricks. |
| D4 | **On first launch the app opens the synthetic demo.** Importing Cipher is one button that starts a background job taking about 6–10 minutes. | The first 60 seconds can't wait for ~400 MB to be ingested. |
| D5 | **Offsets are UTF-8 byte offsets into an immutable, content-addressed original file.** | Works the same for every script, and a passage can be read without loading the whole book. |
| D6 | **An occurrence counts in a time bucket only when its whole date interval fits inside that bucket.** Otherwise it's drawn as a *precision wash* over its interval. | No false precision, and the counts can be checked (they must add up). |
| D7 | **A plain negative integer year means BCE** (−300 = 300 BCE = astronomical −299). | Matches Cipher (`culture-works` books at −300 … −100) and what people type. |
| D8 | **`culture-lines.tsv`, `hinges.tsv` and Loom lines aren't imported as documents.** `culture-lines` is used as a *test oracle* for segmentation and offsets. | They're derived from §1 of the inventory, so importing them would count the same text twice. |
| D9 | **Cipher `kindred` (26,001 computed theme similarities) is imported but hidden by default** and never drawn as lineage. | It's similarity, not transmission. |
| D10 | **The Google Ngram baseline is a reference curve, never "occurrences".** It has no passage to open, and the UI says so. | "Every displayed occurrence opens its original passage." |
| D11 | **Sense clusters are computed once per expression across all time** (one shared sense inventory). Periods are then compared by their *share* of each sense. | Senses stay comparable across periods without aligning separate vector spaces. |
| D12 | **Apple NLEmbedding (English only, a modern model) is labeled "modern reader model"** and is never used to measure drift. | The inventory (§8) notes it is anachronistic for older text. |
| D13 | **Default lanes:** real corpus by `domain` (Etymology / Literature / STEMM / Culture / Imported); demo corpus by `community`. | The main question is "how does a word cross worlds?" |
| D14 | **Server on `127.0.0.1:3030`.** Data lives in `$SCROLLS_DATA` (default `~/Developer/scrolls-data`). | Localhost only, and no database inside iCloud. |

**A Devanagari/Gujarati bug found and fixed during grounding.** FTS5's default `unicode61`
tokenizer treats combining marks (matras, virama) as separators. In a live test against
SQLite 3.53.4, `शून्य` was indexed as `श`, `न`, `य`. Adding
`categories 'L* N* Co M*'` fixes it (`शून्य`, `શૂન્ય` index as whole words; Latin diacritic
folding still works). Every FTS5 table below uses that tokenizer string.

---

## 1. The 4D gantt — "the Scroll"

### 1.1 The four dimensions

| Dim | Name | What it means | Encoding | How you move through it |
|---|---|---|---|---|
| **D1** | Time (x) | Document time: publication by default; the basis can be switched to *referenced time* | Horizontal position, linear within each axis segment | Infinite pan, semantic zoom, playhead |
| **D2** | Lane (y) | A categorical slice: who, where, what kind | Equal-height bands in a stated order | Choose facet, sub-facet, reorder, collapse |
| **D3** | Strand (depth inside a lane) | Which expression and which sense hypothesis | Thin strands stacked inside a lane; folded until the lane is expanded | Expand a lane ("unfold"), pin up to 6 expressions |
| **D4** | Transmission | How one occurrence became material for another | Arcs between strands: forward arcs above, feedback arcs below | Toggle relation families and evidence classes; open in the Lineage explorer |

The brief lists five occurrence coordinates. Two of them, *affect/stance* and
*significance/interpretation*, are optional **overlays**, not axes: tone ticks (fallible,
from an adapter) and annotation pins. The header tooltip says: "A model for analysis, not a
claim that meaning has four dimensions."

```
┌ Scrolls  [⌕ carry the zero ×][+ pin]  Corpus: ▓DEMO·SYNTHETIC▓ ▾  Lanes: community ▾ by first-seen  [⏵] 1994-05 ───── [Save] [⋯]┐
│ MINIMAP  ┊deep time 1px=31yr┊×3┊classical 1px=9.5yr┊×9┊early-modern 1px=1.1yr┊×3┊modern 1px=0.33yr [▕═══viewport═══▏]        │
├──────────────┬──────────────────────────────────────────────────────────────────────┬──────────┬───────┤
│ LANES ⓘ      │1900     1920     1940     1960     1980     2000     2020          │ NEXT     │UNDATED│
│ Classroom    │ ⌐▆▆▅▃ ▂   ¬            ·                                         ┆ hypo-    │   1   │
│ Lab & Eng.   │        ▂▃▅  ░░░░░  ▃▅▆▅▃ ▂ ¬                                     ┆ theses   │   0   │
│ Hip-hop    ▸ │              ░░░░░            ⌐▅▇█▆▅▅▆▆▅▄¬  ╭──╮                ┆  ◇       │   2   │
│ Criticism    │              ░░░░░             ⌐▃▂ ▂   ▂¬                       ┆ only     │   0   │
│ coverage ▁▃▅ │ ▁▂▃▃▃▂▂▁  ░░░░░  ▂▃▄▅▅▆▆▇▇▇▇▇▇▇                                 ┆          │       │
└──────────────┴───── bins: years · thickness = per million tokens (lane) · hollow = n<5 ┴──────────┴───────┘
  Inspector:  THEN (1911 primer) │ NOW (1994 verse) │ NEXT (2003, 2016, 2017 + 1 hypothesis)
```

### 1.2 What a bar is (honest definition)

For a strand key `g = (expression e, lane value ℓ, sense s or *)`, at the current tier with
bucket width `b`:

1. `O_g` = the dated occurrences of `g` whose date interval **fits** a single bucket (D6).
   Occurrences that don't fit become *washes* (§1.7).
2. `c_i` = the count in bucket `i`. `cov_i` = the denominator for (ℓ, bucket i, active
   filters): tokens for full-text collections, works for metadata collections, entries for
   lexical collections.
3. **Segments** are the maximal runs of consecutive buckets where `c_i > 0`. Each segment is
   drawn as a row of per-bucket rectangles. Height = rate `r_i = c_i / cov_i`, scaled per
   unit: per million tokens, per 10,000 works, or per 1,000 entries. Max height is 70% of the
   strand slot. Overflow gets a 2 px cap tick.
4. **End caps** `⌐` and `¬` mark the first and last observed buckets. Nothing is drawn
   between segments: no line, no fill, no interpolation.
5. **A gap means one of two things, and the lane underlay shows which:**
   - *Observed absence*: the lane has coverage (`cov_i ≥ cov_min`) but `c_i = 0`. The
     underlay is plain lane color, so you can see the corpus is present and the expression
     is not.
   - *No evidence*: `cov_i < cov_min`. The underlay is 45° hatching
     (`--hatch`, 6 px pitch).

   `cov_min` is 50,000 tokens, 50 works or 50 entries per bucket.
6. **Thin evidence:** a bucket with `c_i < 5` is drawn as a hollow outline (1 px), not a
   solid fill.
7. Tooltip, generated from the same numbers: *"carry the zero · Hip-hop · first observed
   1994 · last observed 2024 · observed in 19 of 31 covered years · 3 gaps · 212
   occurrences (6 imprecise) · per-million rates use 41.2 M tokens."*

Rates are compared only between lanes with the same unit. The lane header carries a unit
badge (`tok`, `works`, `entr`), and the legend shows one thickness scale per unit present.

### 1.3 Lanes

- **Facets** (`shared/facets.js`): `domain`, `community`, `language`, `kind`, `collection`
  (source), `stemm_field`, `genre`, `sense` (needs a cluster run) and `none`. There is one
  optional sub-facet (two levels, e.g. `domain › language`). `sense` can only be the last
  level.
- **Order rule**, always printed in the lane header ("Lanes: community · ordered by first
  observation"). Options: `first_observed` (default), `volume`, `alpha`, `custom` (by
  drag). Lane order is **never** derived from an embedding or projection.
- **Vertical position is never meaning.** Lanes are equal height (min 36 px desktop,
  32 px narrow), with banding at 3% luminance difference and no y-axis ticks. The first
  time a user opens the lane menu, the ⓘ explains: "Lanes are categories. Distance between
  lanes means nothing."
- **Budget:** at most 12 lanes visible on desktop and 6 on narrow screens. The rest fold
  into an `Other (n lanes)` lane that expands on click. At most 48 strands are visible.
- **Strands inside a lane:** one per pinned expression × sense, ordered by first
  observation. Inline labels sit at each strand's first segment. Pinned expressions are told
  apart by **end-cap glyph** (● ■ ▲ ◆ ✚ ⬢) and label, not by hue. Hue is reserved (§8.6).

### 1.4 Time axis: infinite scroll, semantic zoom, folded deep time

- **Time model:** integer Julian Day Numbers (JDN), proleptic Gregorian, for every date
  (BCE included; 4500 BCE ≈ JDN 77,000, which fits `rtree_i32`). Bucketing uses
  astronomical years.
- **Domain:** −7000 to 2026-12-31. To the right of *today* there is a **Next zone** (up to
  +50 years) with a violet dashed border labeled "Hypotheses only — no corpus evidence".
- **Explore mode (linear)** is the default whenever the visible span is ≤ 800 years. Panning
  is infinite in both directions (with inertia; clamped to the domain plus 10%). Zoom ranges
  from 1 px = 0.57 years (an 800-year span at 1,400 px) down to **1 day = 40 px**.
- **Overview mode (folded)** turns on when you zoom out past 800 years, or with the `Deep
  time` button. The axis becomes four **fixed, linear regimes**, each with a fixed share of
  the width:

  | Regime | Years | Width share | Scale at W = 1,400 px |
  |---|---|---|---|
  | Deep time | −7000 … −500 | 15% | 1 px = 31 yr |
  | Classical–medieval | −500 … 1500 | 15% | 1 px = 9.5 yr |
  | Early modern | 1500 … 1800 | 20% | 1 px = 1.07 yr |
  | Modern | 1800 … 2030 | 50% | 1 px = 0.33 yr |

  Regimes are separated by a 10 px **seam**: a zigzag glyph labeled with the ratio of the
  neighboring scales (`scale ×3`, `×9`, `×3`). A per-regime scale bar sits in the footer. Clicking a
  regime or brushing a range zooms in and unfolds the axis to linear. A toast reports the new
  scale ("Linear scale · 1 px = 0.11 yr"). A `Keep linear` toggle turns off auto-folding.
  Panning is disabled in folded mode: it's an overview, not a place.
- **Minimap** (always visible, 28 px): the folded overview showing data density per lane
  group, with the viewport as a cyan bracket you can drag.

### 1.5 Level-of-detail tiers

The tier is picked automatically from px-per-year (`ppy`). It's shown in the footer as
"bins: decades". Users can force a coarser tier, never a finer one.

| Tier | Selected when | Bucket | What is drawn |
|---|---|---|---|
| **T0 millennium/century** | folded, or `ppy < 0.5` | 100 yr | Language-period bands (etymology), century bars per lane, coverage by century, arc **bundles** between century cells (width 1–6 px = count; the legend says so), no individual marks |
| **T1 decade** | `0.5 ≤ ppy < 6` | 10 yr | Decade bars; strands when a lane is expanded; ◆ first-observation glyph; arc bundles; split/merge glyphs |
| **T2 year** | `6 ≤ ppy < 60` | 1 yr | Year bars; individual arcs (≤ 300 visible, otherwise bundled); occurrence ticks when visible n ≤ 4,000 |
| **T3 month** | `60 ≤ ppy < 730` | 1 month | Month bars from month/day-precise data only; year-precise data appear as washes with brackets |
| **T4 occurrence/day** | `ppy ≥ 730` (≥ 2 px/day) | 1 day | Every occurrence is a mark; inline KWIC labels when there's ≥ 120 px of room |

**Occurrence mode override:** whenever the visible dated occurrences in the viewport number
≤ 4,000, individual marks are drawn whatever the tier. Bars become a faint backdrop. So
close zoom always shows individual occurrences, and sparse expressions show them at every
zoom.

**Aggregate click:** clicking a bucket opens the **bucket drawer**, a virtualized list (50
per page) of that bucket's occurrences with KWIC. Each row opens its passage. Every visible
quantity is therefore two clicks from text.

### 1.6 Branches, convergence, lineage arcs, feedback

- **Split (branch):** sense *B* of expression *e* is first observed in bucket *t* in lane ℓ
  while sense *A* already has a segment there. A **fork glyph** joins the strands at *t*,
  drawn dotted (computed). Parent = the earlier-observed sense whose centroid is nearest to
  B's (cosine ≥ 0.30). If none qualifies, there is no fork: B simply starts. Hover text:
  "Computed split (cluster run c14): a new distinguishable usage appears here. This doesn't
  establish descent."
- **Convergence (merge):** two strands (different expressions, or senses of different
  expressions) get a **confluence bracket** in window *w* when their context-centroid cosine
  is ≥ 0.60 in *w* and < 0.30 in an earlier window, with n ≥ 20 occurrences per strand per
  window. Computed convergence is dotted and neutral ivory. A convergence asserted by an
  annotation is solid violet.
- **Forward lineage arcs** run from an earlier occurrence to a later one. They're drawn
  *above* the strands as quadratic curves. Height = min(lane band, 0.25 × horizontal
  distance). The arrowhead is at the derived end.
- **Feedback arcs** (relation family `reception`: "the later work changes how the earlier
  is read") are drawn *below* the strands, from later back to earlier. They're violet,
  always human or proposed, and labeled `re-reads`. They are never computed.
- **Hypothesis groups:** competing lineages for the same target share a `⑂ 2 competing`
  marker. Selecting one dims the others to 40%. Neither is ever drawn as preferred unless a
  human resolves the group.
- **Arc budget:** by default only arcs touching the selection or a pinned expression are
  drawn; at most 300 individual arcs, otherwise they're bundled. `kindred` and `rejected`
  relations are hidden by default.

### 1.7 Coverage, gaps, uncertain dates, undated shelf

- **Coverage track** (28 px, above the axis): one 3 px row per visible lane. It uses a
  **stated 5-class step scale** (0 · <10k · <100k · <1M · ≥1M tokens; the works and entries
  units have their own classes) with a legend. It's a step scale, not a log scale. Hatched
  where there is no coverage.
- **Precision washes:** occurrences whose interval doesn't fit a bucket are drawn as a
  translucent band across `[lo, hi]` in their strand slot (opacity 0.18, 1 px top rule),
  with a count label: "6 · dated to decade". Washes are never added to bars or rates.
- **Circa** feathers the wash ends: 10% gradient fade outside the interval.
- **Estimated** dates (author lifetime + 40, etc.) are drawn with a 3 px diagonal-stripe
  fill and an `est.` badge. A footer filter `☐ include estimated dates` is on by default
  and counted in the warnings strip.
- **Language-period bands** (etymology) are soft-edged gradient bands. The fuzz (±500 years
  for PIE, ±100 for Latin, etc.) comes from `time_window.fuzzy_*`. Label: "Latin · ≈75 BCE–
  200 CE · *period of the language, not a dated attestation*."
- **Undated shelf:** a 64 px column docked at the right edge, aligned to the lanes, showing
  counts. It sits outside the time axis behind a 12 px gutter. Clicking opens a list.
  Undated items are excluded from rates and denominators and counted in the lane tooltip
  ("+4 undated").
- **Referenced-time basis:** the `Time: publication ▾` menu switches x to *referenced
  time*. Only items with a `referenced` time assertion are placed; everything else moves to
  the shelf, which is relabeled "No referenced time". Ingestion time never appears on the
  main axis. It's shown in the Imports and Jobs views.

### 1.8 Playhead, scrubbing, play, reduced motion

- The **playhead** is a cyan vertical rule with a 44 × 44 px handle. It sets an **as-of
  time** `t*` used everywhere: Then/Now/Next anchors to it, the Constellation defaults to the
  bucket containing it, and the Notebook can filter "interpretations visible as of t*".
- To the right of `t*`, content dims to 25% opacity (future relative to the playhead).
- **Scrub:** drag the handle or press `[` / `]` to step one bucket at the current tier.
  Values change *discretely* by bucket. Nothing is tweened between buckets.
- **Play:** advances one bucket every 600 ms (0.5×–4×). The view auto-pans to keep `t*` at
  66% of the width. When the playhead enters a no-coverage bucket, a caption appears for
  that step: "No coverage for this lane 1940–1949 — absence of evidence, not of use." Play
  never interpolates across gaps.
- **New strands** fade in over 150 ms. Arcs draw in over 200 ms when their target bucket
  is reached.
- **Reduced motion** (OS `prefers-reduced-motion`, or the in-app `R` toggle, saved in
  localStorage) means no auto-pan (the playhead moves and the view stays), no fades or
  draw-ins, and instant steps. The step interval rises to 1,200 ms, and an aria-live caption
  announces each step instead.

### 1.9 The first 60 seconds (scripted)

| t | What the user sees | What it teaches |
|---|---|---|
| 0–1.5 s | The shell paints. A **striped `SYNTHETIC DEMONSTRATION`** ribbon spans the top. The Scroll shows `carry the zero` by community, 1890–2030, decade tier. Bars stagger in left to right (skipped in reduced motion). | It's a timeline of one phrase across communities. |
| 2 s | Coach mark ① sits beside the 1911 Classroom bar: "Each bar shows *where this phrase was observed*. Gaps are real gaps; hatching means we have no texts there." [Next] [Skip tour] | Bars are observations, and gaps are honest. |
| ~12 s | Coach mark ② points at two arcs. The solid amber one is labeled `DOC`, the dotted ivory one `CALC`: "Solid = documented (the 1994 liner notes cite the 1911 primer). Dotted = computed text match. Click any mark to read its source." | Line style = evidence. |
| ~25 s | The user clicks the 1994 Hip-hop bar. The bucket drawer opens, then the passage opens in the inspector with the phrase highlighted, the byte range shown, and a `SYN` badge. | Every mark leads to text. |
| ~40 s | Coach mark ③: "Press ⏵ to watch the meaning accumulate." Play runs 1900→2026 in about 8 s at decade tier. The playhead passes the hatched 1940s; "Then / Now / Next" fills in. | Change over time, with gaps preserved. |
| 60 s | The final card: "Try it on real data → Search Cipher corpus" (if imported; otherwise "Import Cipher corpus · ~8 min · runs in background"). [Take the full tour (3 min)] | Where to go next. |

Coach marks never block input. `Esc` dismisses them, and they don't come back unless the
user clicks `Tour`.

---

## 2. Views B–F (interaction specs)

### B. Meaning Constellation

- **Content:** a node-link view for the window `[t0, t1]`. By default the window is the
  playhead's bucket at the current tier; brushing the minimap sets a custom window.
- **Node types:**
  - expression: circle
  - sense hypothesis: circle with a ring
  - source work: square
  - motif/theme: diamond, shown only when the user turns on "machine tags", and drawn
    hollow because the tags are machine-generated
- **Named quantities only.** Node *area* ∝ a selectable quantity (`occurrences in window`,
  default; `documents in window`; `supporting passages`). Edge *width* ∝ logDice (7–14) for
  collocation edges, or support count for relationship edges. Edge *dash* = evidence class
  (§8.6). The **legend is persistent** (bottom-left, can't be closed, only collapsed to a
  one-line summary). It always names the quantity, unit, domain and scale type ("area ∝
  occurrences, sqrt-radius; 1–240").
- **Stable layout.** Positions come from an **anchor layout** computed once per (corpus
  scope, analysis run) over the *union* graph across all windows. The algorithm is a
  deterministic force layout: seed = hash of the scope key, 400 iterations, then a
  collision pass. Positions are stored in `layout_position`. When you change windows, nodes
  only appear, disappear or resize. **Positions never change.** A layout recompute happens
  only on a new analysis run, and is announced by a toast: "Layout recomputed for run c15 —
  positions changed; this is not semantic change."
- **Two-period comparison:** `Compare periods` splits the view A | B (side by side ≥ 1,100
  px, stacked when narrower) with identical positions. A-only nodes are hollow amber ring
  ("present only in A"), B-only nodes are filled with a violet ring ("new in B"), and nodes
  in both are neutral. A `Diff overlay` toggle draws both in one view, with radius delta
  rings.
- **Bounds:** ≤ 150 nodes and ≤ 400 edges. Each node's context menu has `+N more neighbors`,
  which expands at most 20 per click.
- **Clicks:** a node opens its supporting passages (paged, KWIC) in the inspector. An edge
  opens a **relationship card**: type, direction, evidence status, origin, method or
  annotator, run, confidence and its meaning, supporting passages, revision history, and
  `Confirm / Reject / Dispute`.

### C. Lineage Explorer ("chain of custody")

- **Layout:** x = time (the same `TimeScale` module, linear). Rows are assigned by
  generation (topological depth from the root), never by meaning. Root nodes are outlined
  cyan.
- **Relationship types**, each with its own glyph. The default 8 from the brief come first;
  Cipher and STEMM types are grouped into families:

  | Type | Family | Directed | Glyph | Typical origin |
  |---|---|---|---|---|
  | exact_quotation | quotation | yes if dates ordered | ═ double line | algorithm (winnowing) |
  | near_quotation | quotation | same | ≈ line with tilde | algorithm (MinHash + alignment) |
  | explicit_citation | citation | yes | ⟦ bracket tick | text citation, OpenAlex, human |
  | adaptation | derivation | yes | ▸ block arrow | Wikidata via Cipher |
  | parody | reframing | yes | zigzag | human / proposed |
  | recontextualization | reframing | yes | ↻ tick | human / proposed |
  | proposed_allusion | hypothesis | yes | ? tick, long dash | human / tagger |
  | similar_contextual_usage | association | **no arrowhead** | ∿ dotted | algorithm |
  | sample, interpolation, cover, version, remake, remix, answer_record | derivation (music) | yes | ▸ variants | Wikipedia/Wikidata/MusicBrainz/ItwoFS |
  | inspired_by | hypothesis or derivation | yes | ✧ | documented when the source code is w/d/i |
  | counterpart, kindred_theme | association | no | ∿ | tagger / computed |
  | soundtrack_member | context (not lineage) | no | ○ | Wikipedia/Wikidata |
  | etymological_descent | etymology | yes | ⇣ | Wiktionary (kaikki) |
  | rereading | reception (feedback) | yes, later→earlier | ↶ | human / proposed |

- **Evidence status is a separate channel from type:** line pattern plus a text badge (`DOC`,
  `CALC`, `PROP`, `✓ HUMAN`, `✗ REJECTED`, `≠ DISPUTED`). Hue indicates role: amber for
  references to earlier material, violet for reframing or reception, ivory for association.
- **Disputed and competing hypotheses:** relationships in a `hypothesis_group` are drawn
  side by side with a `⑂` marker. The group card lists each hypothesis with its supporters,
  evidence and annotator, and there is a `Resolve…` action that only a human can take. A
  resolved group keeps the losing hypotheses as `rejected` with a rationale. They're never
  deleted.
- **Guardrail copy** appears on every computed edge card: "Similarity alone doesn't
  establish influence, ancestry or intent." Non-directional types never get arrowheads.
- **Bounded expansion:** depth ≤ 3 hops each way, ≤ 60 nodes, ≤ 120 edges. The truncation
  frontier is shown as `+14 not shown` stubs you can click.

### D. Then / Now / Next inspector

Selecting a passage or occurrence opens three columns on desktop, or three swipeable tabs
in a bottom sheet on narrow screens. Each column shows its anchor date in its header.

- **Then:**
  - the passage, read from the original bytes, with the highlight
  - document metadata
  - all time assertions (publication, referenced, estimated flags)
  - **contemporaneous uses:** other occurrences of the expression within the same bucket
    (T2: ±5 years) and lane, up to 5, as KWIC
  - the *documented setting*: other metadata only (collection notes, canon, culture code)
- **Now:** a later passage that reuses this one. It's picked from outgoing relationships,
  the playhead, or a manual `Pick later passage…` that searches later occurrences. It shows
  the relationship card and, for quotations, an **aligned diff**: matched tokens underlined
  amber, substitutions violet.
- **Next:**
  - subsequent documented and computed uses: outgoing relationships from *Now* plus later
    occurrences in any lane, up to 8, with evidence badges
  - the user's **Hypothesis cards** (kind `hypothesis`), drawn violet dashed and anchored in
    the Next zone. The `+ Hypothesis` button creates one.
- **Fixed footer copy:** "Then shows documents and their settings, not anyone's private
  thoughts."

### E. Compare meanings

There are two slices, A and B. Each is time range + filters (lanes, languages, kinds,
collections). The view opens **coverage first**:

1. **Coverage & composition panel:**
   - tokens, documents, passages and undated count per slice
   - stacked bars of composition by kind, language and collection
   - **composition divergence** = Jensen–Shannon divergence (base 2) of the kind × language
     mix. If JSD > 0.20, an amber banner: "A and B are built from different kinds of
     sources (JSD 0.31). Differences below may reflect source mix, not meaning."
   - a `Match composition` action that reweights B to A's mix (post-stratification weights,
     with weights shown)
2. **Relative frequency:**
   - rate per million with a 95% exact Poisson CI per slice
   - log₂ ratio and G² (shown when n ≥ 5 in each slice; otherwise "too few: A n=3")
3. **Neighboring terms:** three columns (shared / A only / B only) of collocates ranked by
   logDice, each showing f_xy. "New uses" and "declining uses" use the keyness rules in §4.
4. **Contextual clusters:** share of each sense hypothesis in A and B, with document-level
   bootstrap 95% CIs (B = 200), plus the JSD between share distributions with its CI. Gated
   (§4.9).
5. **Representative passages:** 3 per sense per slice, the medoids nearest each centroid.
   Each opens its passage.
6. **Estimated semantic displacement:** gated. Shown as a **percentile against control
   words** (e.g. "more displaced than 91% of 200 frequency-matched controls, CI 84–96%"),
   never as a bare cosine. The neighbor-overlap measure (no alignment needed) is shown
   beside it.
7. **Tone:** gated, adapter-dependent, plotted as a distribution with n. Label: "fallible
   annotation by a modern model".

### F. Interpretation Notebook

- **Attach targets:** passage (optionally a byte span), occurrence, document, expression,
  sense, relationship, saved view, time window, or another annotation (replies).
- **Kinds:** interpretation, evidence_note, correction, hypothesis, label (renames a machine
  cluster), question, tag. Each revision has a stance (`supports | contradicts | neutral |
  proposes`), tags, **custom dimensions** (free key/value, e.g. `register: ironic`,
  `audience: critics`) and evidence passages with roles.
- **Revisions are append-only.** Editing creates rev n+1. `Supersede` creates a new
  annotation linked by `supersedes_id`. The old one becomes status `superseded` and stays
  visible as a **stratum**.
- The **Layers view** stacks a target's interpretations chronologically by authored time,
  oldest at the bottom (sediment). Each layer shows author, date, stance and an expandable
  diff against the previous revision.
- **Reviewing inferred relationships:** `Confirm / Reject / Dispute / Retype` write a
  `relationship_revision`. They change `evidence_status` but never `origin` or `method`.
  Rejected edges stay queryable and are hidden by default.
- **Multiple interpretations side by side:** "Reader A says mockery / Reader B says tribute"
  is shown as two columns, with shared evidence highlighted in both.
- **Notebook index:** a filterable list by target type, kind, author, tag, dimension and
  as-of time. Full-text search runs over `annotation_fts`.

---

## 3. Data model — SQLite DDL (`server/db/schema.sql`)

The database is `$SCROLLS_DATA/scrolls.db`. Originals are stored at
`$SCROLLS_DATA/originals/ab/cd/<sha256>.txt`, immutable and content-addressed. Caches go in
`$SCROLLS_DATA/cache/`.

This DDL was executed as written on Node 26 `node:sqlite` (SQLite 3.53.4) in memory. It
creates cleanly, including the FTS5, trigram, fts5vocab and `rtree_i32` virtual tables. The
provenance CHECK rejects `origin='algorithm', evidence_status='documented'`. A Devanagari
annotation body is found by FTS.

```sql
PRAGMA journal_mode = WAL;  PRAGMA synchronous = NORMAL;  PRAGMA foreign_keys = ON;
PRAGMA mmap_size = 1073741824;  PRAGMA cache_size = -262144;  PRAGMA temp_store = MEMORY;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;  -- schema_version, created_at

-- ── sources ─────────────────────────────────────────────────────────────────
CREATE TABLE source_adapter (
  id TEXT PRIMARY KEY,                 -- 'cipher.gutenberg','openalex','import.csv','demo'
  version TEXT NOT NULL, display_name TEXT NOT NULL, license TEXT,
  requires_network INTEGER NOT NULL DEFAULT 0 CHECK (requires_network IN (0,1)),
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json))
) STRICT;

CREATE TABLE corpus (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  description TEXT, created_at TEXT NOT NULL
) STRICT;

CREATE TABLE collection (
  id INTEGER PRIMARY KEY,
  corpus_id INTEGER NOT NULL REFERENCES corpus(id),
  slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  adapter_id TEXT NOT NULL REFERENCES source_adapter(id),
  content_kind TEXT NOT NULL CHECK (content_kind IN ('fulltext','metadata','lexical','aggregate')),
  unit TEXT NOT NULL CHECK (unit IN ('tokens','works','entries')),   -- rate denominator
  domain TEXT NOT NULL CHECK (domain IN ('etymology','literature','stemm','culture','imported','demo')),
  license TEXT, attribution TEXT, provenance_note TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE import_batch (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER REFERENCES collection(id),
  adapter_id TEXT NOT NULL REFERENCES source_adapter(id),
  file_name TEXT, file_sha256 TEXT, file_bytes INTEGER,
  format TEXT CHECK (format IN ('txt','md','csv','tsv','json','jsonl','adapter')),
  mapping_json TEXT CHECK (mapping_json IS NULL OR json_valid(mapping_json)),
  status TEXT NOT NULL CHECK (status IN ('staged','previewed','committing','committed','failed','cancelled')),
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  job_id INTEGER, created_at TEXT NOT NULL, finished_at TEXT
) STRICT;

-- ── documents, time, passages ───────────────────────────────────────────────
CREATE TABLE document (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collection(id),
  import_batch_id INTEGER REFERENCES import_batch(id),
  external_id TEXT NOT NULL,                     -- 'pg:1342', 'cw:row:4948', 'W2741809807'
  title TEXT, author TEXT,
  language TEXT NOT NULL DEFAULT 'und',          -- BCP-47; 'mul' when mixed
  kind TEXT NOT NULL,                            -- book_text|song|film|book|tv|sport|channel|abstract|entry|note|post
  genre TEXT NOT NULL DEFAULT '', community TEXT NOT NULL DEFAULT '', stemm_field TEXT NOT NULL DEFAULT '',
  source_url TEXT, file_ref TEXT, license_note TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  original_sha256 TEXT,                          -- NULL for pure-metadata docs w/o text file
  original_bytes INTEGER,
  original_join_rule TEXT,                       -- e.g. 'wikisource pages joined by "\n\f\n"'
  original_meta_json TEXT NOT NULL CHECK (json_valid(original_meta_json)),  -- verbatim source record
  token_count INTEGER NOT NULL DEFAULT 0,
  -- primary chronological anchor, denormalised from time_assertion(is_primary=1)
  t_lo INTEGER, t_hi INTEGER, year_lo INTEGER, year_hi INTEGER,
  precision TEXT NOT NULL DEFAULT 'unknown', basis TEXT NOT NULL DEFAULT 'unknown',
  dup_of INTEGER REFERENCES document(id),        -- exact duplicate (kept, excluded from counts)
  flags INTEGER NOT NULL DEFAULT 0,              -- 1 near-duplicate warning, 2 ocr-noisy
  ingested_at TEXT NOT NULL,
  UNIQUE (collection_id, external_id)
) STRICT;
CREATE INDEX document_time ON document(collection_id, year_lo);
CREATE VIRTUAL TABLE document_title_tri USING fts5(title, author, content='document', content_rowid='id',
  tokenize='trigram remove_diacritics 1');

CREATE TABLE time_assertion (
  id INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('document','passage','expression','relationship','annotation')),
  subject_id INTEGER NOT NULL,
  time_kind TEXT NOT NULL CHECK (time_kind IN
    ('publication','composition','release','referenced','attestation_claim','language_period','ingestion')),
  is_primary INTEGER NOT NULL DEFAULT 0,
  t_lo INTEGER, t_hi INTEGER,                   -- JDN inclusive; NULL iff precision='unknown'
  year_lo INTEGER, year_hi INTEGER,             -- astronomical years
  precision TEXT NOT NULL CHECK (precision IN
    ('day','month','year','decade','century','millennium','range','period','unknown')),
  basis TEXT NOT NULL CHECK (basis IN ('stated','estimated','period','unknown')),
  approx INTEGER NOT NULL DEFAULT 0,            -- 'circa' qualifier
  original_label TEXT,                          -- verbatim: 'c. 1890s', '0', 'संवत् 1977'
  method TEXT,                                  -- 'gutenberg.json year', 'lifetime_year birth+40', 'wikidata P577'
  evidence_passage_id INTEGER,                  -- e.g. the Wiktionary sentence making a coinage claim
  source_note TEXT,
  CHECK ((precision = 'unknown') = (t_lo IS NULL))
) STRICT;
CREATE INDEX ta_subject ON time_assertion(subject_type, subject_id, time_kind);

CREATE TABLE passage (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('paragraph','verse','page','title','native_title','summary','abstract','entry','line','note')),
  start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL CHECK (end_byte > start_byte),  -- into original
  page_no INTEGER,
  language TEXT NOT NULL,                        -- may differ from document (mixed-language)
  token_count INTEGER NOT NULL,
  text_norm TEXT NOT NULL,                       -- normalised search text; display text = original slice
  flags INTEGER NOT NULL DEFAULT 0,              -- 1 ocr-noise suspected, 2 front matter, 4 boilerplate
  -- denormalised for aggregation without joins
  collection_id INTEGER NOT NULL, domain TEXT NOT NULL, kind_facet TEXT NOT NULL,
  community TEXT NOT NULL, genre TEXT NOT NULL, stemm_field TEXT NOT NULL,
  t_lo INTEGER, t_hi INTEGER, year_lo INTEGER, year_hi INTEGER,
  precision TEXT NOT NULL, basis TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  UNIQUE (document_id, seq)
) STRICT;
CREATE INDEX passage_slice ON passage(collection_id, language, year_lo);
CREATE VIRTUAL TABLE passage_fts USING fts5(text_norm, content='passage', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2 categories 'L* N* Co M*'", prefix='2 3', detail=full);
CREATE VIRTUAL TABLE passage_vocab USING fts5vocab(passage_fts, 'row');

-- ── expressions & occurrences ──────────────────────────────────────────────
CREATE TABLE expression (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('word','phrase','quotation','symbol','motif','title','etymon','root','name')),
  canonical TEXT NOT NULL, norm_key TEXT NOT NULL,     -- norm_key = normalised tokens joined by ' '
  language TEXT,                                       -- NULL = any language
  gloss TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('user_search','curated','etymology','import','demo','stemm_seed','attestation')),
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  tracked INTEGER NOT NULL DEFAULT 0,                  -- occurrences materialised?
  created_at TEXT NOT NULL,
  UNIQUE (norm_key, language, kind)
) STRICT;
CREATE VIRTUAL TABLE expression_tri USING fts5(canonical, gloss, content='expression', content_rowid='id',
  tokenize='trigram remove_diacritics 1');

CREATE TABLE expression_variant (
  id INTEGER PRIMARY KEY,
  expression_id INTEGER NOT NULL REFERENCES expression(id) ON DELETE CASCADE,
  form TEXT NOT NULL, norm_key TEXT NOT NULL, language TEXT,
  variant_kind TEXT NOT NULL CHECK (variant_kind IN
    ('canonical','inflection','spelling','translation','transliteration','descendant','abbreviation','user')),
  included INTEGER NOT NULL DEFAULT 1,                 -- user can exclude from counts
  method TEXT NOT NULL,                                -- 'suffix-rules-en@1','roots.tsv members','user'
  evidence_status TEXT NOT NULL DEFAULT 'documented'
    CHECK (evidence_status IN ('documented','computed','proposed','confirmed','rejected')),
  UNIQUE (expression_id, norm_key, language)
) STRICT;

CREATE TABLE etymology_member (                        -- roots.tsv members, kept verbatim
  family_expression_id INTEGER NOT NULL REFERENCES expression(id),
  language TEXT NOT NULL, word TEXT NOT NULL, rank INTEGER NOT NULL,
  member_expression_id INTEGER REFERENCES expression(id),
  PRIMARY KEY (family_expression_id, language, word)
) STRICT, WITHOUT ROWID;

CREATE TABLE occurrence (
  id INTEGER PRIMARY KEY,
  expression_id INTEGER NOT NULL REFERENCES expression(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES expression_variant(id),
  passage_id INTEGER NOT NULL REFERENCES passage(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL,
  start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,   -- absolute into original file
  token_index INTEGER NOT NULL,                              -- position in passage token stream
  extraction_run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  collection_id INTEGER NOT NULL, domain TEXT NOT NULL, language TEXT NOT NULL, kind_facet TEXT NOT NULL,
  community TEXT NOT NULL, genre TEXT NOT NULL, stemm_field TEXT NOT NULL,
  t_lo INTEGER, t_hi INTEGER, year_lo INTEGER, year_hi INTEGER, precision TEXT NOT NULL, basis TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  UNIQUE (expression_id, passage_id, start_byte)
) STRICT;
CREATE INDEX occ_expr_time ON occurrence(expression_id, year_lo, collection_id);
CREATE INDEX occ_passage ON occurrence(passage_id);
CREATE VIRTUAL TABLE occurrence_rt USING rtree_i32(id, t_lo, t_hi, +expression_id);  -- dated only

-- ── coverage (denominators) ────────────────────────────────────────────────
CREATE TABLE coverage_cell (
  collection_id INTEGER NOT NULL, language TEXT NOT NULL, kind_facet TEXT NOT NULL,
  community TEXT NOT NULL, genre TEXT NOT NULL, stemm_field TEXT NOT NULL,
  year INTEGER NOT NULL,                       -- astronomical; cells only for year-or-finer docs
  precision_class TEXT NOT NULL CHECK (precision_class IN ('year_or_finer','decade','century','period','range')),
  span_lo INTEGER NOT NULL, span_hi INTEGER NOT NULL,   -- for coarse docs: their full interval
  tokens INTEGER NOT NULL, works INTEGER NOT NULL, passages INTEGER NOT NULL,
  PRIMARY KEY (collection_id, language, kind_facet, community, genre, stemm_field, year, precision_class, span_lo)
) STRICT, WITHOUT ROWID;
CREATE TABLE coverage_undated (
  collection_id INTEGER NOT NULL, language TEXT NOT NULL, kind_facet TEXT NOT NULL, community TEXT NOT NULL,
  tokens INTEGER NOT NULL, works INTEGER NOT NULL,
  PRIMARY KEY (collection_id, language, kind_facet, community)
) STRICT, WITHOUT ROWID;
CREATE TABLE baseline_series (                 -- e.g. Ngram; NOT occurrences
  source TEXT NOT NULL, term TEXT NOT NULL, year INTEGER NOT NULL,
  match_count INTEGER NOT NULL, volume_count INTEGER, total_count INTEGER NOT NULL,
  PRIMARY KEY (source, term, year)
) STRICT, WITHOUT ROWID;   -- populated lazily from the ATTACHed read-only ngram DB

-- ── time windows & facets ──────────────────────────────────────────────────
CREATE TABLE time_window (
  id INTEGER PRIMARY KEY,
  scheme TEXT NOT NULL CHECK (scheme IN ('century','decade','year','custom','language_period','corpus_era')),
  label TEXT NOT NULL, t_lo INTEGER NOT NULL, t_hi INTEGER NOT NULL,
  year_lo INTEGER NOT NULL, year_hi INTEGER NOT NULL,
  fuzzy_lo_years INTEGER NOT NULL DEFAULT 0, fuzzy_hi_years INTEGER NOT NULL DEFAULT 0,
  language TEXT, source_note TEXT,
  UNIQUE (scheme, label)
) STRICT;
CREATE TABLE facet_value (facet TEXT NOT NULL, value TEXT NOT NULL, label TEXT NOT NULL, sort_key TEXT,
  PRIMARY KEY (facet, value)) STRICT, WITHOUT ROWID;
CREATE TABLE stemm_map (scheme TEXT NOT NULL CHECK (scheme IN ('locc','openalex_field')), code TEXT NOT NULL,
  stemm_group TEXT NOT NULL CHECK (stemm_group IN ('S','T','E','M','Med','adjacent')), label TEXT NOT NULL,
  PRIMARY KEY (scheme, code)) STRICT, WITHOUT ROWID;

-- ── analysis runs (every computed artefact points here) ───────────────────
CREATE TABLE analysis_run (
  id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('ingest','segment','occurrences','collocations','quotes_exact',
    'quotes_near','space','occvec','cluster','drift','tone','layout','import_relations','coverage')),
  pipeline_version TEXT NOT NULL,          -- semver of Scrolls pipeline
  code_ref TEXT NOT NULL,                  -- sha256 of the stage module source (git-free)
  algorithm TEXT NOT NULL,                 -- 'winnow-k8-w4', 'spherical-kmeans++', 'ppmi-rsvd'
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),   -- canonical (sorted keys)
  model_ref TEXT,                          -- 'apple.NLEmbedding.en.r1' | NULL
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  input_fingerprint TEXT NOT NULL,         -- sha256(sorted doc ids + original sha + parent runs)
  parent_run_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled','superseded')),
  metrics_json TEXT, job_id INTEGER, started_at TEXT NOT NULL, finished_at TEXT
) STRICT;
CREATE INDEX run_stage ON analysis_run(stage, status);

CREATE TABLE collocation (
  run_id INTEGER NOT NULL REFERENCES analysis_run(id), expression_id INTEGER NOT NULL,
  scope_key TEXT NOT NULL, window_id INTEGER NOT NULL, collocate TEXT NOT NULL,
  f_xy INTEGER NOT NULL, f_x INTEGER NOT NULL, f_y INTEGER NOT NULL, n_tokens INTEGER NOT NULL,
  logdice REAL NOT NULL, ppmi REAL NOT NULL, g2 REAL NOT NULL,
  PRIMARY KEY (run_id, expression_id, scope_key, window_id, collocate)
) STRICT, WITHOUT ROWID;

CREATE TABLE quote_fingerprint (run_id INTEGER NOT NULL, hash INTEGER NOT NULL, passage_id INTEGER NOT NULL,
  token_pos INTEGER NOT NULL, PRIMARY KEY (run_id, hash, passage_id, token_pos)) STRICT, WITHOUT ROWID;
CREATE TABLE quote_df (run_id INTEGER NOT NULL, hash INTEGER NOT NULL, df INTEGER NOT NULL,
  PRIMARY KEY (run_id, hash)) STRICT, WITHOUT ROWID;
CREATE TABLE minhash_band (run_id INTEGER NOT NULL, band INTEGER NOT NULL, bucket INTEGER NOT NULL,
  passage_id INTEGER NOT NULL, PRIMARY KEY (run_id, band, bucket, passage_id)) STRICT, WITHOUT ROWID;

CREATE TABLE vector_space (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  kind TEXT NOT NULL CHECK (kind IN ('ppmi_svd','nl_embedding')),
  language TEXT NOT NULL, scope_key TEXT NOT NULL, era_window_id INTEGER,   -- NULL = pooled all-time
  dim INTEGER NOT NULL, vocab_size INTEGER NOT NULL, tokens INTEGER NOT NULL,
  aligned_to_space_id INTEGER REFERENCES vector_space(id), alignment_json TEXT  -- Procrustes R, anchors
) STRICT;
CREATE TABLE term_vector (space_id INTEGER NOT NULL REFERENCES vector_space(id), term TEXT NOT NULL,
  count INTEGER NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (space_id, term)) STRICT, WITHOUT ROWID;
CREATE TABLE occurrence_vector (run_id INTEGER NOT NULL, occurrence_id INTEGER NOT NULL, vec BLOB,  -- NULL = unrepresentable
  context_terms INTEGER NOT NULL, PRIMARY KEY (run_id, occurrence_id)) STRICT, WITHOUT ROWID;

CREATE TABLE sense_hypothesis (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  expression_id INTEGER NOT NULL REFERENCES expression(id),
  scope_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
  machine_label TEXT NOT NULL,                       -- 'ledger · ink · owed'
  label_annotation_id INTEGER,                       -- current human label (revisioned annotation)
  distinctive_terms_json TEXT NOT NULL,              -- [{term, z, count}]
  size INTEGER NOT NULL, documents INTEGER NOT NULL,
  dominant_document_share REAL NOT NULL,             -- >0.5 => 'single-source cluster'
  stability_jaccard REAL NOT NULL,
  stability_class TEXT NOT NULL CHECK (stability_class IN ('stable','pattern','unstable')),
  first_year INTEGER, last_year INTEGER,
  parent_sense_id INTEGER REFERENCES sense_hypothesis(id),   -- computed split parent, may be NULL
  centroid BLOB NOT NULL, medoid_occurrence_ids_json TEXT NOT NULL
) STRICT;
CREATE TABLE occurrence_sense (
  run_id INTEGER NOT NULL, occurrence_id INTEGER NOT NULL REFERENCES occurrence(id) ON DELETE CASCADE,
  sense_id INTEGER REFERENCES sense_hypothesis(id),  -- NULL = unassigned / unrepresentable
  cos_to_centroid REAL, PRIMARY KEY (run_id, occurrence_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX occsense_sense ON occurrence_sense(sense_id);
CREATE TABLE sense_window_share (
  run_id INTEGER NOT NULL, sense_id INTEGER NOT NULL, window_id INTEGER NOT NULL,
  n INTEGER NOT NULL, share REAL NOT NULL, ci_lo REAL NOT NULL, ci_hi REAL NOT NULL,
  PRIMARY KEY (run_id, sense_id, window_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE drift_result (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES analysis_run(id),
  expression_id INTEGER NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('cluster_share_jsd','procrustes_displacement','neighbor_overlap')),
  slice_a_json TEXT NOT NULL, slice_b_json TEXT NOT NULL,
  value REAL, ci_lo REAL, ci_hi REAL, control_percentile REAL,
  n_a INTEGER NOT NULL, n_b INTEGER NOT NULL, docs_a INTEGER NOT NULL, docs_b INTEGER NOT NULL,
  gate_ok INTEGER NOT NULL, gate_reasons_json TEXT NOT NULL
) STRICT;

CREATE TABLE machine_score (            -- tone etc.; fallible, presented as annotations
  run_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL,
  dimension TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY (run_id, target_type, target_id, dimension)
) STRICT, WITHOUT ROWID;

CREATE TABLE machine_tag (              -- Cipher themes/motifs/mood/meaning; fallible annotations
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL CHECK (dimension IN ('theme','motif','mood','meaning','canon')),
  value TEXT NOT NULL, weight REAL,
  method TEXT NOT NULL,                  -- 'Cipher tagging pass (Claude sub-agent, Oct 2026)' | 'Wikidata/Wikipedia categories' | 'genre→mood heuristic'
  PRIMARY KEY (document_id, dimension, value)
) STRICT, WITHOUT ROWID;
CREATE INDEX machine_tag_value ON machine_tag(dimension, value);

-- ── relationships ──────────────────────────────────────────────────────────
CREATE TABLE rel_type (
  code TEXT PRIMARY KEY, family TEXT NOT NULL, label TEXT NOT NULL, inverse_label TEXT,
  directed INTEGER NOT NULL, is_lineage INTEGER NOT NULL, glyph TEXT NOT NULL
) STRICT;
CREATE TABLE hypothesis_group (
  id INTEGER PRIMARY KEY, question TEXT NOT NULL, created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  is_synthetic INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE relationship (
  id INTEGER PRIMARY KEY,
  rel_type TEXT NOT NULL REFERENCES rel_type(code),
  source_type TEXT NOT NULL CHECK (source_type IN ('passage','document','expression','sense','occurrence')),
  source_id INTEGER NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('passage','document','expression','sense','occurrence')),
  target_id INTEGER NOT NULL,
  directed INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('source_dataset','text_citation','algorithm','machine_tagger','human')),
  evidence_status TEXT NOT NULL CHECK (evidence_status IN
    ('documented','computed','proposed','confirmed','rejected','disputed')),
  provenance_quality TEXT NOT NULL DEFAULT 'complete' CHECK (provenance_quality IN ('complete','source_unrecorded')),
  source_dataset TEXT,          -- 'wikipedia','wikidata','musicbrainz','itwofs','openalex','wiktionary'
  external_ref TEXT, attribution TEXT,
  method TEXT, run_id INTEGER REFERENCES analysis_run(id), annotator TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  confidence_kind TEXT,         -- 'alignment_identity' | 'cosine' | NULL — what the number means
  heuristic_strength REAL,      -- Cipher sibling strength: NOT a probability
  hypothesis_group_id INTEGER REFERENCES hypothesis_group(id),
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  source_year INTEGER, target_year INTEGER,          -- denormalised for drawing
  current_rev INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  -- structural guarantees: inferred lineage can never be stored as documented
  CHECK (evidence_status <> 'documented' OR origin IN ('source_dataset','text_citation')),
  CHECK (origin <> 'source_dataset' OR source_dataset IS NOT NULL),
  CHECK (origin <> 'algorithm' OR (method IS NOT NULL AND run_id IS NOT NULL)),
  CHECK (origin <> 'human' OR annotator IS NOT NULL),
  CHECK (origin <> 'machine_tagger' OR method IS NOT NULL),
  UNIQUE (rel_type, source_type, source_id, target_type, target_id, origin, method)
) STRICT;
CREATE INDEX rel_source ON relationship(source_type, source_id);
CREATE INDEX rel_target ON relationship(target_type, target_id);
CREATE INDEX rel_status ON relationship(evidence_status, rel_type);

CREATE TABLE relationship_evidence (
  relationship_id INTEGER NOT NULL REFERENCES relationship(id) ON DELETE CASCADE,
  passage_id INTEGER NOT NULL REFERENCES passage(id),
  role TEXT NOT NULL CHECK (role IN ('source_side','target_side','citation_text','context','contradicting')),
  start_byte INTEGER, end_byte INTEGER, note TEXT,
  PRIMARY KEY (relationship_id, passage_id, role)
) STRICT, WITHOUT ROWID;
CREATE TABLE relationship_revision (
  relationship_id INTEGER NOT NULL REFERENCES relationship(id),
  rev INTEGER NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('create','confirm','reject','dispute','retype','reopen','annotate')),
  before_json TEXT, after_json TEXT NOT NULL, rationale TEXT,
  author TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (relationship_id, rev)
) STRICT, WITHOUT ROWID;

-- ── annotations ────────────────────────────────────────────────────────────
CREATE TABLE annotation (
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('passage','occurrence','document','expression','sense',
    'relationship','saved_view','time_window','annotation','hypothesis_group')),
  target_id INTEGER NOT NULL,
  target_span_json TEXT,                    -- {"start_byte":..,"end_byte":..} within a passage
  kind TEXT NOT NULL CHECK (kind IN ('interpretation','evidence_note','correction','hypothesis','label','question','tag')),
  author TEXT NOT NULL, is_synthetic INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retracted')),
  supersedes_id INTEGER REFERENCES annotation(id),
  current_rev INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
) STRICT;
CREATE INDEX annotation_target ON annotation(target_type, target_id);
CREATE TABLE annotation_revision (
  annotation_id INTEGER NOT NULL REFERENCES annotation(id), rev INTEGER NOT NULL,
  body_md TEXT NOT NULL,
  stance TEXT CHECK (stance IN ('supports','contradicts','neutral','proposes')),
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  dimensions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(dimensions_json)),
  rationale TEXT, author TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (annotation_id, rev)
) STRICT, WITHOUT ROWID;
CREATE TABLE annotation_evidence (
  annotation_id INTEGER NOT NULL, rev INTEGER NOT NULL, passage_id INTEGER NOT NULL REFERENCES passage(id),
  role TEXT NOT NULL CHECK (role IN ('supporting','contradicting','context')),
  start_byte INTEGER, end_byte INTEGER,
  PRIMARY KEY (annotation_id, rev, passage_id, role)
) STRICT, WITHOUT ROWID;
CREATE VIRTUAL TABLE annotation_fts USING fts5(body_md, content='', contentless_delete=1,
  tokenize="unicode61 remove_diacritics 2 categories 'L* N* Co M*'");   -- rowid = annotation_id*1000+rev

-- ── views, layout, jobs, caches ────────────────────────────────────────────
CREATE TABLE saved_view (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT,
  current_rev INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE saved_view_revision (
  view_id INTEGER NOT NULL REFERENCES saved_view(id), rev INTEGER NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),        -- shared/view-state.js schema
  state_version INTEGER NOT NULL,
  run_pins_json TEXT NOT NULL,                                   -- {"occurrences":3,"cluster":14,...}
  annotation_pins_json TEXT NOT NULL,                            -- [[annotation_id, rev], ...] visible at save
  corpus_fingerprint TEXT NOT NULL,                              -- sha of collection ids + batch ids
  snapshot_png BLOB, created_at TEXT NOT NULL,
  PRIMARY KEY (view_id, rev)
) STRICT, WITHOUT ROWID;
CREATE TABLE layout (id INTEGER PRIMARY KEY, run_id INTEGER, scope_key TEXT NOT NULL, algorithm TEXT NOT NULL,
  seed INTEGER NOT NULL, params_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TABLE layout_position (layout_id INTEGER NOT NULL REFERENCES layout(id), node_key TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, PRIMARY KEY (layout_id, node_key)) STRICT, WITHOUT ROWID;
CREATE TABLE job (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, params_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelling','cancelled')),
  progress REAL NOT NULL DEFAULT 0, stage TEXT, done INTEGER, total INTEGER,
  result_json TEXT, error_json TEXT, run_id INTEGER,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
) STRICT;
CREATE TABLE query_registry (qkey TEXT PRIMARY KEY, spec_json TEXT NOT NULL, created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL) STRICT;
CREATE TABLE tile_cache (qkey TEXT NOT NULL, tier TEXT NOT NULL, tile INTEGER NOT NULL,
  body_gz BLOB NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (qkey, tier, tile)) STRICT, WITHOUT ROWID;
```

**Seeded rows** (`server/db/seed.sql`):

- `rel_type`: the 21 codes from the §2C table.
- `stemm_map`, two schemes:
  - **LoCC:** Q, QB, QC, QD, QE, QH, QK, QL, QM, QP, QR → S; QA → M; T, TK → T;
    TA, TC, TJ, TL, TS → E; TX → T, labeled "home economics"; R, RA, RC, RM… → Med.
  - **OpenAlex fields** (from the 26 fields in `cache/openalex-tmp/fields.json`):
    - S: 31 Physics, 16 Chemistry, 19 Earth, 11 Agri/Bio, 13 Biochem/Genetics, 23 Env,
      28 Neuro, 24 Immunology/Micro
    - T: 17 Computer Science, 21 Energy
    - E: 22 Engineering, 25 Materials, 15 Chem Eng
    - M: 26 Mathematics, 18 Decision Sciences
    - Med: 27 Medicine, 36 Health Prof., 29 Nursing, 30 Pharmacology, 35 Dentistry,
      34 Veterinary
    - adjacent (not STEMM): 32 Psychology, 33, 12, 20, 14
- `time_window` language periods, each with its fuzz:

  | Period | Years | Fuzz |
  |---|---|---|
  | PIE | −4500…−2500 | ±500 |
  | Vedic Sanskrit | −1500…−500 | ±300 |
  | Classical Sanskrit | −500…1000 | ±200 |
  | Ancient Greek | −800…600 | ±100 |
  | Old Latin | −700…−75 | ±100 |
  | Classical Latin | −75…200 | ±50 |
  | Late/Medieval Latin | 200…1500 | ±100 |

  These cover the only source languages present in `roots.tsv` (la 28.9k, sa 9.8k, grc 9.2k,
  ine-pro 7.1k).

---

## 4. Analysis pipeline

Every stage is a pure module, `server/analysis/<stage>.js`, with the signature
`run(db, scope, params, ctx) → run_id`. It executes in a worker thread. Every output row
carries `run_id`. Re-running never mutates an old run: the old one becomes `superseded`. Runs
pinned by saved views are kept until the user explicitly prunes them, and pruning refuses to
remove a pinned run.

**4.1 Parse & validate; preserve originals.**
- Adapters and importers yield records. The core writes the original bytes to
  `originals/<sha256>.txt` (fsync, then rename) **before** anything else, and records
  `original_meta_json` verbatim.
- For non-text sources:
  - **Wikisource pages:** the canonical original is pages joined with `"\n\f\n"`.
  - **Culture rows:** `title\nnative_title\nsummary`, with field byte spans.
  - **OpenAlex abstracts:** reconstructed from the inverted index.

  The join rule is stored in `document.original_join_rule`, and the raw record is kept
  verbatim in JSON.

**4.2 Normalize & segment** (`server/text/`).
- **Unicode:** NFC. Gutenberg boilerplate is cut at the `*** START OF` / `*** END OF`
  markers. The original is kept whole; boilerplate just isn't segmented.
- **Search key only** (display always uses original bytes):
  - lowercase with `toLocaleLowerCase(lang)`
  - Latin diacritics folded (the FTS option)
  - Gutenberg `_italics_` underscores stripped
  - curly quotes and dashes → ASCII
  - ZWJ/ZWNJ removed
  - nukta sequences composed (NFC)
  - Devanagari/Gujarati digits mapped to ASCII
  - danda `।` and `॥` treated as sentence punctuation
- **Tokens:** `Intl.Segmenter(lang, {granularity:'word'})`, keeping `isWordLike`. Verified
  on Node 26 for `gu` and `hi` (`શૂન્ય ઉપાડો` → 2 tokens).
- **Offset map:** `normalizeWithMap(origBytes) → {norm, tokens:[{n, ob, oe}]}` records
  original byte spans per token. It's deterministic, so offsets can be recomputed from the
  original at any time.
- **Passages:**
  - prose: paragraph = blank-line-separated block, split at sentence boundaries
    (`Intl.Segmenter` sentence) when longer than 400 tokens
  - verse: consecutive short lines (< 12 tokens), grouped up to 40 tokens
  - Wikisource: per page first, then paragraphs; `page_no` kept
- **Flags:**
  - OCR noise: letter ratio < 0.6, or < 20 tokens of mostly digits
  - front matter: first 3 pages with ToC or edition patterns ("संस्करण", "आवृत्ति", ISBN)

  Flagged passages are searchable but **excluded from rates by default**. The filter is
  shown.
- **Language per passage:**
  - script ratio first: Gujarati block → `gu`; Devanagari → `hi`, labeled `hi?` when the
    document is not hi, since it could be Marathi or Sanskrit
  - Latin script: stopword-profile scoring over en/fr/es (top 60 function words each); it
    needs a 1.5× margin, otherwise the document language is kept

**4.3 Search & KWIC.**
- FTS5 phrase queries: `"carry the zero"`, prefix `virus*`, and `NEAR(a b, 5)`.
- KWIC = ±12 tokens (adjustable 5–40), computed from original bytes via the offset map, so
  highlights are exact byte spans.
- Variants (inflections from small en/fr/es suffix rules, spelling variants,
  translations/descendants) are **listed and individually toggleable**. There's no silent
  stemming.

**4.4 Occurrences & frequency.**
- Tracking an expression starts an `occurrences` job:
  FTS candidates → exact match on normalized token sequences → byte offsets.
- Throughput target: about 150k occurrences per minute in one worker.
- Rate = `c / denominator × 10^6` (tokens), ×10^4 (works) or ×10^3 (entries), from
  `coverage_cell` for the same slice (time bucket × lane value × active filters).
- CI: exact Poisson (Garwood) on `c`.
- Thin coverage: denominator < 50k tokens / 50 works.
- `kindred`/tag matches are never occurrences. Motif/theme hits are a separate "machine tag
  matches" overlay.

**4.5 Collocations.**
- Window ±5 tokens inside a passage. Stopwords (shipped lists for en/fr/es/hi/gu, about 150
  each) and tokens shorter than 2 characters (Latin script) are removed.
- Thresholds: `f_xy ≥ 5`, `f_y ≥ 20` in the slice.
- Primary rank: **logDice** = 14 + log₂(2·f_xy / (f_x + f_y)), which is stable across
  slice sizes. Also stored: PPMI (α = 0.75) and G².
- Keyness between slices (new/declining uses): Δ logDice ≥ 2 **and** G² ≥ 10.83
  (p < .001), with `f_xy ≥ 5` in the higher slice.
- "New in B" requires `f_xy(A) = 0` **and** n_A ≥ 50. Otherwise the label is "not observed
  in A (A is thin: n=12)".

**4.6 Quotation detection** (`quotes_exact`, `quotes_near`).
- **Exact:** token 8-gram shingles over normalized tokens (stopwords kept), FNV-1a 32-bit
  pairs combined into 53-bit integers, then **winnowing with window w = 4**. Every shared run
  of ≥ 11 tokens (k + w − 1) is guaranteed to be caught; runs of 8–10 usually are.
  - Candidate pair = ≥ 2 shared fingerprints in different documents.
  - Verify: the longest common token run is ≥ 8 tokens. Record the aligned byte spans on
    both sides.
  - **Commonplaces:** fingerprints with df > 25 documents (Bible verses, proverbs) produce
    no pairwise edges. They're collected into one "widely shared text" node listing its
    documents, which keeps the graph bounded.
- **Near:** MinHash with 64 permutations over word 5-gram shingles; LSH 16 bands × 4 rows
  (50% catch at Jaccard ≈ 0.50). Verify with token Smith–Waterman (+2 / −1 / gap −2): keep
  alignments ≥ 12 tokens with identity ≥ 0.80.
  - Runs **on scope**: a search's result passages (≤ 20,000) or chosen collections.
  - The global background run over the 1,518 Cipher books is exact-only. It produces about
    24M fingerprints (~400 MB), which is acceptable on this machine.
- **Becoming relationships:**
  - `rel_type` = exact_ or near_quotation; `origin = 'algorithm'`;
    `evidence_status = 'computed'`; `method = 'winnow-k8w4@1'` or `'minhash64-b16r4+sw@1'`
  - `confidence` = alignment identity, with `confidence_kind = 'alignment_identity'`
  - two `relationship_evidence` rows with byte spans
  - `directed = 1` only if `source.t_hi < target.t_lo`; otherwise non-directional,
    labeled "shared text, order unknown"
  - The card text: "Shared text detected. The match is observed; who borrowed from whom,
    and why, is not established."
  - Only a human can move it to `confirmed`. Nothing algorithmic can ever be `documented`:
    this is enforced by a DDL CHECK.
- **Explicit citations** come from sources (OpenAlex references, imported citation fields,
  demo-authored text citations with a `citation_text` evidence span). Pattern-based citation
  mining ("as X wrote") is deferred to v1.1 and, when added, writes `proposed`.

**4.7 Contextual representations without paid APIs.**
- **PPMI-SVD spaces** (`space`), per language × scope (× era for drift):
  - vocabulary = the top 30k terms with count ≥ 20
  - symmetric window ±4; context-distribution smoothing α = 0.75
  - **randomized SVD** (Halko): d = 100, oversampling 10, 3 power iterations, on a CSR
    matrix in `Float32Array`s (Gram–Schmidt QR, Jacobi SVD of the small core)
  - embedding = U·Σ^0.5, rows L2-normalized
  - cost: about 20M nnz → ~30 s per space in a worker
- **Occurrence vectors** (Schütze-style): the idf-weighted mean of pooled-space vectors of
  context terms within ±10 tokens, excluding stopwords and the expression's own tokens, then
  L2-normalized.
  - Needs ≥ 3 in-vocabulary context terms; otherwise the occurrence is `unrepresentable`
    (counted and shown).
  - Titles have no context, so **metadata collections never get sense lanes**. The UI says:
    "Senses need surrounding text; titles have none."
- **Optional adapter:** Apple `NLEmbedding.sentenceEmbedding(.english)` (512-d). It's
  stored as a separate `vector_space(kind='nl_embedding')` labeled "modern reader model
  (Apple NLEmbedding en rev 1)". It may be offered as an alternative clustering basis for
  English, and is **never** compared with PPMI spaces or used for drift.

**4.8 Clustering into sense hypotheses.**
- Scope: an expression × language (pooled all-time). If there are more than 5,000
  representable occurrences, take a stratified sample of ≤ 600 per decade. The rest are
  assigned to the nearest centroid if cos ≥ 0.20, otherwise `unassigned`.
- **Spherical k-means++** (cosine), 10 restarts, ≤ 100 iterations, k = 1…8.
- **k selection:** the k that maximizes mean cosine silhouette (on a sample ≤ 2,000). Use
  k = 1 ("no distinguishable uses") if that maximum is below 0.10, or if any cluster falls
  under max(10, 3% n).
- **Stability:** 20 bootstrap subsamples (80%), clusterwise Jaccard (Hennig).
  - ≥ 0.75 → `stable` (solid strand)
  - 0.60–0.75 → `pattern` (strand with dashed outline)
  - < 0.60 → `unstable` (not drawn; listed as "1 unstable grouping not shown")
- **Single-source guard:** if one document supplies more than 50% of a cluster, the label is
  suffixed "· mostly from *Title*".
- **Labels:** the top 3–5 context terms by weighted log-odds with an informative Dirichlet
  prior (Monroe et al. 2008), cluster versus the other clusters, z ≥ 1.96 → "ledger · ink ·
  owed". The label is editable; the edit is stored as a `label` annotation with revisions,
  and the machine label is kept.
- **Gate:** n ≥ 40 representable occurrences from ≥ 5 documents.
- **Window shares:** stored with document-bootstrap CIs.
- **Emergence:** a sense *emerges* in window *w* when its share lower CI > 0.05 in *w*, and
  its upper CI < 0.05 in every earlier window with n ≥ 20.

**4.9 Drift / displacement (gated).**

| Metric | Method | Gate (all must hold) | When the gate fails, the UI says |
|---|---|---|---|
| Cluster-share divergence | JSD of sense shares A vs B; document-level bootstrap B = 200 → 95% CI | n ≥ 30 per slice from ≥ 5 docs; clusters `stable` or `pattern`; ≥ 2 senses | "Not computed: slice B has 23 occurrences from 3 documents (needs 30 from 5)." |
| Embedding displacement | Era spaces A, B (same language, same collection family). **Orthogonal Procrustes** on anchors (shared terms with count ≥ 50 in both, excluding the top-100 most frequent and the target). Displacement = 1 − cos(v_A, R·v_B). Reported as a **percentile vs 200 frequency-matched controls** (±20% frequency); document-bootstrap B = 20 for the CI | target count ≥ 50 in each; each era space ≥ 1M tokens; ≥ 2,000 anchors; anchor Procrustes residual ≤ 0.6 | "Displacement unavailable: era space 1925–1950 (gu) has 0.6 M tokens (needs 1 M)." |
| Neighbor overlap | Jaccard of top-20 neighbors in A vs B (no alignment needed) | same count gates | shown beside displacement as "local neighborhood change" |

There is **no direct comparison of independent spaces** without the Procrustes step. Raw
cosine is never shown alone. Era spaces for books are only defined where they pass the
1M-token gate: en/fr/es 1800–1849, 1850–1874, 1875–1899, 1900–1928; hi/gu 1875–1924,
1925–1950 (computed at ingest; failing eras are listed).

**4.10 Tone/stance as fallible annotation.**
- The optional `scrolls-nl` Swift CLI (stdin JSONL `{id, text, lang}` → stdout
  `{id, score}`) runs `NLTagger(.sentimentScore)` per passage. Languages where it returns nil
  are marked unavailable.
- Stored in `machine_score(dimension='tone')`. Shown only as per-slice distributions (mean
  and bootstrap CI, n), labeled "modern reader model · fallible · not the author's stance".
- Stance (pro/contra) is never computed. It exists only as a human annotation dimension.

**4.11 What is disabled when evidence is insufficient.** Every gated control renders a
**reason chip** (ivory on charcoal, ⓘ) instead of a value:

| Feature | Disabled when | Chip copy (example) |
|---|---|---|
| sense lanes | no cluster run, or the gate fails | "Senses unavailable · 18 occurrences (needs 40)" |
| fork/merge glyphs | parent cosine < 0.30, n < 20 | hidden; "no computed split" in the strand tooltip |
| rate bars | denominator < `cov_min` | hatched bucket, n shown, rate "—" |
| frequency ratio | n < 5 either side | "too few to compare" |
| displacement | §4.9 gates | as above |
| tone | adapter off, or language unsupported | "Tone unavailable — local NaturalLanguage adapter not enabled" |
| near-quote | scope > 20,000 passages | "Narrow the scope to run near-quotation detection" |

---

## 5. Ingestion

**Formats.**
- **TXT / MD:** one document per file. MD front matter (`---` YAML-like `key: value` lines,
  parsed with a 40-line parser) becomes metadata. Headings are passage boundaries.
- **CSV / TSV:** RFC 4180 parser (quoted fields, CRLF, BOM). Delimiter sniffed from
  `, \t ; |` by consistent column count over the first 50 lines.
- **JSON:** an array of objects, or `{records:[…]}`.
- **JSONL:** one object per line; bad lines are reported by line number.
- **Encoding:** UTF-8 (BOM stripped). A non-UTF-8 file → decode with `fatal:true` fails →
  try `windows-1252` → "File decoded as Windows-1252 — check accented characters in the
  preview."

**Field mapping** (server contract, `POST /api/imports/:id/preview`):

```json
{ "mapping": {
    "id": "song_id", "text": "body", "title": "title", "author": "artist",
    "date": "released", "date_kind": "publication", "referenced_date": null,
    "language": "lang", "kind": {"const": "note"}, "genre": "genre", "community": "scene",
    "collection": {"const": "my-notes"}, "source_url": "url", "license": "license",
    "citations": {"field": "cites", "split": "|", "match_on": "external_id", "rel_type": "explicit_citation"},
    "text_join": {"field": "pages", "sep": "\n\n"},
    "extra_to_metadata": true },
  "options": { "zero_year_is_unknown": true, "reject_invalid_dates": false,
               "dedupe": "exact_text", "default_language": "detect" } }
```

JSON paths use dots (`meta.date`, `pages`). Arrays are joined with `text_join`. Unmapped
fields are kept in `original_meta_json`.

**Mapping UI.**
- **Left:** detected columns, each with its inferred type (text, date-like, language-like,
  id-like, url) and three sample values.
- **Right:** target fields as dropdowns, with auto-suggestions from header names (en/es/fr
  synonyms).
- **Bottom:** a **live preview of the first 25 rows** as they will be stored: parsed date
  label, precision, basis, language, and an issue icon. The date column gets a format
  histogram: "YYYY 88% · c. YYYY 8% · unparseable 4% (3 rows)".
- `Commit` is disabled until text or title is mapped.

**Date grammar** (`shared/dates.js`; returns `{t_lo, t_hi, year_lo, year_hi, precision,
basis, approx, original_label, warnings[]}`):

```
date      := unknown | range | circa? point era?
unknown   := "" | "unknown" | "n.d." | "s.d." | "s.f." | "?" | "0"(only if zero_year_is_unknown)
point     := iso_day | iso_month | month_name_date | year | decade | century | millennium
iso_day   := YYYY "-" MM "-" DD                       → day
iso_month := YYYY "-" MM                              → month
month_name_date := [DD] MONTH ["de"] YYYY             → day|month  (MONTH: en/fr/es names, abbreviations)
year      := ["-"]DIGITS(1-4) | DIGITS era            → year   (negative = BCE: −300 → 300 BCE → astro −299)
decade    := YYY"0s" | "the "YYY"0s" | "'"Y"0s"(rejected: ambiguous)   → decade [YYY0, YYY9]
            special: YY"00s" → century [YY00, YY99] + warning "1800s read as 1800–1899"
century   := ORD " century" | ROMAN " century" | "siglo " ROMAN | ROMAN "e siècle" | "शताब्दी"-forms
            with optional "early|mid|late" → thirds (e.g. early 19th = 1800–1833)
millennium:= ORD " millennium" era
range     := point ("–"|"-"|" to "|"/"|"between … and …") point   → range [lo(first), hi(second)]
circa     := "c." | "ca." | "circa" | "~" | "approx." | "vers" | "hacia" | trailing "?"
            → approx=1, widen: year ±5, decade ±5, century ±25
era       := "BCE"|"BC"|"B.C."|"av. J.-C."|"a. C." | "CE"|"AD"|"A.D."|"ap. J.-C."|"d. C."
indic     := Devanagari/Gujarati digits → ASCII; "संवत्|સંવત N" → Vikram Samvat: year = N − 57,
            precision year, warning "converted from Vikram Samvat; may be off by one year"
two-digit years ('94) → rejected: "‘94’ is ambiguous — write 1994".
```

**Duplicates.**
- Exact: same sha256 of normalized text within the corpus → `dup_of` set. The row is
  kept, excluded from counts, and listed.
- Near: MinHash Jaccard ≥ 0.9 → `flags |= 1` and a warning, never merged.
- Same `external_id` twice → the later row is rejected with `DUPLICATE_ID`.

**Malformed rows.** Every problem is
`{row|line, column, value(≤80 chars), code, message, suggestion, action}`. Codes:

- `EMPTY_TEXT` (reject)
- `JSON_PARSE` (reject the line, keep going)
- `RAGGED_ROW` (accept, padded, warn)
- `DATE_UNPARSEABLE` (accept as undated, warn, unless `reject_invalid_dates`)
- `DATE_AMBIGUOUS` (accept with the stated interpretation)
- `ENCODING_FALLBACK`
- `LANG_UNKNOWN`
- `DUPLICATE_ID`
- `DUPLICATE_TEXT`
- `CITATION_UNRESOLVED` (kept in metadata, no relationship)
- `TOO_LARGE` (> 200 MB per file → "Split the file or use the adapter CLI")

Example message: *"Row 118, column ‘released’: couldn't read ‘Spring '94’ as a date. Kept as
undated. Try ‘1994’ (year) or ‘1994-03’ (month)."*

**Mixed languages:** the document language comes from the mapping, otherwise from
detection. Passage language overrides it for tokenization and lanes. `mul` is used when
passages disagree by more than 20%.

**Import summary object** (stored in `import_batch.summary_json`, rendered as a card):

```json
{ "import_id": 7, "collection": "my-notes", "adapter": "import.csv@1",
  "file": {"name":"notes.csv","sha256":"9f…","bytes":48213,"format":"csv","encoding":"utf-8","delimiter":","},
  "mapping_decisions": [
    {"field":"date","decision":"'0' treated as unknown (option zero_year_is_unknown)"},
    {"field":"language","decision":"not mapped → detected per passage"}],
  "counts": {"rows":1200,"accepted":1174,"accepted_with_warnings":61,"rejected":26,
             "duplicates_exact":9,"near_duplicate_warnings":4,"undated":44},
  "dates": {"day":10,"month":30,"year":900,"decade":120,"century":20,"range":50,"unknown":44,"estimated":0,"approx":37},
  "languages": {"en":1000,"es":150,"und":24},
  "passages": 3210, "tokens": 512340,
  "warnings": [{"code":"DATE_AMBIGUOUS","count":3,"examples":[{"row":44,"value":"1800s","message":"read as 1800–1899"}]}],
  "rejected": [{"row":17,"code":"EMPTY_TEXT","message":"Row has no text or title — nothing to index. Map a text column or remove the row."}],
  "ingested_at": "2026-10-03T19:12:04Z", "started_at": "…", "finished_at": "…" }
```

**Three times kept apart:**
- publication/composition: `time_assertion` with `is_primary`
- referenced: `time_kind='referenced'`, a separate mapping field
- ingestion: `document.ingested_at` plus a `time_assertion(kind='ingestion')`

---

## 6. Cipher mapping

Abbreviations as in the inventory (C, R, T).

**Collections** (corpus `cipher`):

| Collection slug | Adapter | content_kind / unit / domain |
|---|---|---|
| `cipher-gutenberg` | `cipher.gutenberg` | fulltext / tokens / literature |
| `cipher-wikisource-hi` | `cipher.wikisource` | fulltext / tokens / literature |
| `cipher-wikisource-gu` | `cipher.wikisource` | fulltext / tokens / literature |
| `cipher-culture` | `cipher.culture` | metadata / works / culture |
| `cipher-etymology` | `cipher.etymology` | lexical / entries / etymology |

1. **Books → documents and passages.**
   - **Gutenberg:** `$T/texts/gutenberg.json` (693) plus `<id>.txt` →
     `document(external_id='pg:<id>', kind='book_text', language, author, title)`. The
     `q` QID and `links` go into `original_meta_json`.
     - **Date basis:** join `pg_catalog.csv` by Text#. If `year == author_birth + 40`
       (Cipher's `lifetime_year` rule), use `basis='estimated'` and
       `method='Cipher lifetime_year (author birth + 40)'`. This flags **116 of 691**
       matched books (measured). Otherwise use `basis='stated'` and
       `method='gutenberg.json year (Wikidata via Cipher)'`.
     - The 8 null years → unknown.
     - The Gutenberg `Issued` date is stored as `time_kind='release'` and never as primary.
     - LoCC goes into metadata. The 5 Q/R/T-classed books (Opticks 1704, Descent of Man
       1871, Flatland 1884, Lobo 1898, Principles of Scientific Management 1911) also get
       `stemm_field`.
   - **Wikisource:** each JSONL line → a document (`external_id='ws-hi:<index>'`,
     `title`, `author`). The year (if any) uses `basis='stated'` and
     `method='Wikisource index year (may be edition year)'`; null → unknown (hi 42,
     gu 172). Pages → passages, with `page_no` (hi 18,614 pages, gu 16,524 pages).
     OCR/front-matter flags apply.
2. **Culture works → metadata documents.**
   - Each of the 94,385 rows → `document(external_id='cw:<row>', kind=<kind>,
     community=<culture code>, title, author=<maker>)`. All 16 columns are kept verbatim in
     `original_meta_json`.
   - Document text = `title \n native_title \n summary` → passages of kind `title`,
     `native_title` and `summary`. **No lyrics exist and none are created.**
   - `year 0` → unknown (song 4,090, book 2,525, …). Negative years → BCE (4 books).
   - Precision is `year`; basis is `stated`; `method='culture-works.tsv year (Wikidata)'`.
   - `canon` → `machine_tag(dimension='canon', method='Cipher canon lists')`, plus a filter
     facet.
   - `weight` and `sampled_count` → metadata. `weight` is offered as a filter, never as a
     visual quantity.
3. **Siblings → relationships.** Parse `row:relation:strength[:source]`. **Mirror pairs**
   (e.g. `samples` on A plus `sampled by` on B) are **deduplicated into one directed row**,
   oriented *material → derived*:

   | Cipher relation | rel_type | source → target | evidence_status by source code |
   |---|---|---|---|
   | samples / sampled by | sample | sampled → sampler | w/d/m: `documented` (`origin='source_dataset'`) |
   | interpolates / interpolated in | interpolation | original → interpolator | w/m: documented |
   | cover of / covered as | cover | original → cover | m/w: documented |
   | version of / other version | version | original → version; `other version` = non-directional | m/d/w: documented; [-] `documented` + `provenance_quality='source_unrecorded'` |
   | remake of / remade as | remake | original → remake | [-]: documented, `source_unrecorded` (Wikidata-derived per inventory) |
   | based on / adapted as | adaptation | source → adaptation | [-]: documented, `source_unrecorded`, note "Wikidata P144/P737 via build_culture.py" |
   | remix of / remixed as | remix | original → remix | per code |
   | inspired / inspired by | inspired_by | inspiration → work | w/i: documented (ItwoFS: `attribution` = link-back, CC BY 2.5); [-]: **proposed**, `origin='machine_tagger'` (it can't be told apart from tagging) |
   | answered by | answer_record | original → answer | code present: documented; else proposed |
   | from film / features song; written for / song from | soundtrack_member | film → song, non-lineage | w/d: documented |
   | counterpart | counterpart | non-directional | **proposed**, `origin='machine_tagger'`, `method='Cipher tagging pass (Claude sub-agent, Oct 2026) or title match'` |
   | kindred | kindred_theme | non-directional | **computed**, `origin='algorithm'`, `method='Cipher theme similarity (build_culture.py)'`, linked to a synthetic `analysis_run(stage='import_relations')` recording that provenance; hidden by default |

   `strength` → `heuristic_strength`, and the card says "heuristic weight, not a
   probability". MusicBrainz MBIDs, where `relations_mb.json` has them, go into
   `external_ref`.
4. **Tags → machine annotations.**
   - Split `themes` (`phrase:weight`) by provenance. If the phrase appears in that QID's
     `$T/tags/*.jsonl` batch: `method='Cipher tagging pass (Claude sub-agent, Oct 2026)'`.
     Otherwise: `method='Wikidata/Wikipedia categories (via Cipher)'`.
   - `motifs`, `meaning`, `mood` → the tagging-pass method, except moods at weight 0.50
     with no tag-batch entry, which get `method='genre→mood heuristic (half weight)'`.
   - All go into `machine_tag`. The UI shows them as hollow diamonds and dashed chips
     labeled "machine tag".
5. **Roots → expression lineage across language periods.**
   - Each family row → `expression(kind='etymon'|'root', language=la|grc|sa|ine-pro,
     canonical=form, gloss)`, plus a `time_assertion(kind='language_period',
     basis='period')` pointing at the language's `time_window`.
   - The `roots` column → `relationship(etymological_descent, root → etymon,
     origin='source_dataset', source_dataset='wiktionary', attribution='Wiktionary via
     kaikki.org, CC BY-SA')`.
   - `members` → `etymology_member` (≈103k member links: en 58.7k, fr 17.1k, es 13.7k,
     hi 10.8k, gu 3.0k) plus lazily created `expression(kind='word')` rows and
     `etymological_descent` relationships (etymon → modern word).
   - Rendered as **period bands**, never as points.
6. **Culture-lines → derived, not primary.** It isn't imported. It's used in
   `tests/offsets.test.mjs`: 500 sampled lines from Gutenberg/Wikisource sources must be
   found by FTS in a passage of the same title, with the original byte slice equal to the
   line after normalization.

**Provenance / evidence vocabulary** (`shared/evidence.js`, the only source of truth):

- `origin` ∈ `source_dataset | text_citation | algorithm | machine_tagger | human`
- `evidence_status` ∈ `documented | computed | proposed | confirmed | rejected | disputed`
- `provenance_quality` ∈ `complete | source_unrecorded`
- **Visual class** (derived):
  - `human` if the status is confirmed, rejected or disputed, or the origin is human
  - otherwise `documented` / `computed` / `proposed` by status

  This produces the four classes the brief requires, plus `rejected` as a hidden sub-class.

---

## 7. API (JSON over `node:http`; all under `/api`)

The pattern is to **register a query, then fetch cacheable tiles**:

```
POST /api/timeline/query       body {exprs:[12,40], lanes:{by:"domain",sub:null,order:"first_observed"},
                                     filters:{language:["en","es"],kind:[],collection:[],exclude_flags:3,
                                              include_estimated:true, include_synthetic:false},
                                     basis:"publication", runs:{occurrences:3, cluster:14}}
→ { "qkey":"q_7f3a9c", "synthetic": false,
    "exprs":[{"id":12,"canonical":"virus","variants":[{"id":5,"form":"viruses","kind":"inflection","included":true}],
              "total":2311,"dated":2290,"undated":21,"tracked":true}],
    "lanes":[{"key":"literature","label":"Literature (PD books)","unit":"tokens","order":0,
              "first_year":1704,"n":1290,"undated":8}],
    "lane_rule":"domain · ordered by first observation",
    "extent":{"first":{"year":-74,"precision":"period"},"last":{"year":2024,"precision":"year"}},
    "warnings":[{"code":"ESTIMATED_DATES","n":112,"text":"112 occurrences come from books dated by author lifetime"}],
    "baselines":[{"source":"ngram-eng-1","term":"virus","available":true}],
    "runs":{"occurrences":3} }

GET /api/timeline/tile?qkey=q_7f3a9c&tier=decade&tile=29        (tile = 64 buckets; bucket 0 = year 0)
→ { "qkey":"q_7f3a9c","tier":"decade","tile":29,"bucket_from":1856,"bucket_years":10,
    "cells":[{"lane":"literature","strand":"e12","b":1890,"n":14,"rate":3.2,"unit":"tokens",
              "denom":4400000,"ci":[1.75,5.37],"thin":false}],
    "coverage":[{"lane":"literature","b":1890,"denom":4400000,"class":4}],
    "washes":[{"lane":"literature","strand":"e12","lo_year":1885,"hi_year":1895,"n":2,"precision":"year","approx":true}],
    "marks":null,
    "arc_bundles":[{"from":{"lane":"literature","b":1890},"to":{"lane":"culture","b":1990},
                    "n":3,"visual_class":"documented","family":"derivation"}],
    "split_merge":[{"type":"split","lane":"literature","b":1890,"parent":"s31","child":"s34","run":14}] }

GET /api/timeline/marks?qkey=…&from=1990-01-01&to=1999-12-31&lanes=culture&limit=4000
→ { "marks":[{"occ":8812,"passage":55120,"lane":"culture","strand":"e12","t_lo":2451180,"t_hi":2451544,
              "precision":"year","basis":"stated","synthetic":false}], "truncated":false }

GET /api/occurrences?qkey=…&lane=culture&from=1990&to=1999&cursor=…&limit=50
→ { "items":[{"occ":8812,"passage":55120,"kwic":{"left":"…","match":"Virus","right":"…"},
              "doc":{"id":27641,"title":"Virus","kind":"film","year":1999}}], "next_cursor":"…", "total":2 }
```

| Method & path | Request | Response (abridged) |
|---|---|---|
| `GET /api/health` | – | `{ok, schema_version, data_dir, db_bytes, adapters:[{id,available}]}` |
| `GET /api/corpora` | – | `{corpora:[{slug,name,is_synthetic,collections:[{slug,unit,domain,documents,tokens,year_range,undated}]}]}` |
| `GET /api/search?q=&lang=&scope=all|expressions|passages&limit=20` | – | `{expressions:[{id?,canonical,norm_key,language,kind,tracked,counts:{passages,documents}}], suggestions:[{canonical,score}], passages:[{passage_id,doc:{id,title,author,year,precision,synthetic},kwic:{left,match,right},match_bytes:[s,e]}], total_passages}` |
| `POST /api/expressions` | `{form, language?, kind?, variants?:[…], include_inflections?:false}` | `{expression, job_id?}` (starts the occurrences job if not tracked) |
| `GET /api/expressions/:id` | – | `{expression, variants, etymology:{families:[…],periods:[…]}, attestation_claims:[…], counts, runs}` |
| `PATCH /api/expressions/:id/variants/:vid` | `{included}` | `{variant}` + new `qkey` hint |
| `GET /api/passages/:id?context=1` | – | `{id, kind, document:{id,title,author,language,kind,collection,license_note,is_synthetic,original_meta}, time:[{kind,label,precision,basis,approx,method}], text, start_byte, end_byte, highlights:[{start,end,occurrence_id,expression_id}], prev_id, next_id, original:{sha256,file_ref,byte_range:[s,e]}, flags, relationships:[{id,rel_type,direction,other:{type,id,title,year},visual_class}], annotation_count}` (`text` is decoded from the original bytes; `start/end` in highlights are UTF-16 indices *into `text`* for the browser) |
| `GET /api/documents/:id` | – | `{document, passages_page, time_assertions, machine_tags:[{dimension,value,weight,method}]}` |
| `GET /api/lineage?root=passage:123&dir=both&depth=2&types=&status=&max_nodes=60` | – | `{nodes:[{key,type,title,year,precision,lane,synthetic}], edges:[{id,source,target,rel_type,family,directed,evidence_status,origin,visual_class,method,annotator,confidence,confidence_kind,support_count,hypothesis_group}], groups:[{id,question,status,members:[edge ids]}], truncated:{nodes_omitted,frontier:[keys]}}` |
| `GET /api/relationships/:id` | – | `{relationship, evidence:[{passage_id,role,kwic,bytes}], revisions:[…], guardrail_text}` |
| `POST /api/relationships` | `{rel_type, source, target, evidence:[…], rationale, annotator, hypothesis_group_id?}` | `{relationship}` (origin forced to `human`; status `proposed`) |
| `POST /api/relationships/:id/review` | `{action:"confirm"|"reject"|"dispute"|"retype"|"reopen", rationale, author, rel_type?}` | `{relationship, revision}` |
| `GET /api/constellation?qkey=&from=&to=&cmp_from=&cmp_to=&size=occurrences&max_nodes=150` | – | `{layout_id, nodes:[{key,type,label,x,y,a:{value,n},b:{value,n},presence}], edges:[{key,source,target,kind,quantity,a,b,visual_class}], legend:{node_size:{quantity,unit,scale:"area",domain},edge_width:{quantity:"logDice",domain:[7,14]}}}` |
| `POST /api/compare` | `{expr, a:{from,to,filters}, b:{…}, runs?}` | `{coverage:{a,b,composition_jsd,warning}, frequency:{a:{n,rate,ci},b,log2_ratio,g2,gate}, neighbors:{shared,a_only,b_only}, new_uses, declining_uses, clusters:{gate,shares:[{sense_id,label,a:{share,ci},b}],jsd:{value,ci}}, representative:{a:[passage refs],b}, displacement:{gate:{ok,reasons},value,ci,control_percentile,neighbor_overlap}, tone:{available,reason?,a?,b?}}` |
| `GET /api/clusters?expr=&run=` / `PATCH /api/senses/:id/label` | `{label, author, rationale}` | `{senses:[…]}` / `{sense, annotation, revision}` |
| `POST /api/analysis/:stage` | `{scope, params}` | `{job_id}` (stages: occurrences, collocations, quotes_exact, quotes_near, space, cluster, drift, tone, layout) |
| `GET /api/runs?stage=` / `GET /api/runs/:id` | – | `{runs:[{id,stage,algorithm,params,model_ref,status,pinned_by_views}]}` |
| `GET /api/annotations?target=passage:123&include=layers` | – | `{annotations:[{id,kind,author,status,supersedes_id,current_rev,revisions:[…],evidence:[…]}]}` |
| `POST /api/annotations` | `{target:{type,id,span?}, kind, body_md, stance?, tags?, dimensions?, evidence?:[{passage_id,role}], author}` | `{annotation, revision:1}` |
| `PATCH /api/annotations/:id` | `{body_md?, stance?, tags?, dimensions?, evidence?, rationale, author}` | `{annotation, revision:n+1}` (old revisions preserved) |
| `POST /api/annotations/:id/supersede` | same as create | `{new_annotation, superseded_id}` |
| `GET /api/views` / `GET /api/views/:slug[?rev=]` | – | `{view:{slug,title,rev,state,run_pins,annotation_pins,corpus_fingerprint,drift:{runs_superseded:[…],annotations_changed:n}}}` |
| `POST /api/views` / `PUT /api/views/:slug` | `{title, state, snapshot_png_b64?}` | `{slug, rev, url:"/v/<slug>"}` (server fills pins) |
| `POST /api/imports` | raw body + headers `X-Filename`, `Content-Type`; or `{path}` (local file) | `{import_id, format, encoding, delimiter?, columns:[{name,inferred,samples}], suggested_mapping, rows_sampled}` |
| `POST /api/imports/:id/preview` | `{mapping, options}` | `{rows:[{row, stored:{title,date:{label,precision,basis},language,…}, issues:[…]}], counts:{ok,warn,reject}, date_formats:[{pattern,share}]}` |
| `POST /api/imports/:id/commit` | `{mapping, options, collection:{slug,name,corpus}}` | `{job_id}` → the result is the import summary object (§5) |
| `GET /api/adapters` / `POST /api/adapters/:id/run` | `{collections?}` | `{adapters:[{id,version,license,available,problems,requires_network}]}` / `{job_id}` |
| `GET /api/jobs` / `GET /api/jobs/:id` | – | `{job:{id,kind,status,progress,stage,done,total,eta_s,result,error}}` |
| `GET /api/jobs/:id/events` (SSE) | – | `event: progress` `data:{"pct":0.42,"stage":"segment","done":291,"total":693,"eta_s":38}` · `event: log` · `event: done` `data:{result}` · `event: error` `data:{code,message}` |
| `POST /api/jobs/:id/cancel` | – | `{status:"cancelling"}`. The worker polls a `SharedArrayBuffer` flag between batches (≤ 200 ms); partial runs → `cancelled`, and their outputs are deleted in one transaction |
| `GET /api/export?view=<slug>|qkey=…&what=occurrences|relationships|annotations|passages|all&format=json|jsonl|csv` | – | Streamed. The first JSONL record (and the CSV's commented header lines) = `{export_version, generated_at, view, runs, filters, synthetic_included, licenses:[…], attribution:[…]}`. Rows carry `is_synthetic`, `evidence_status`, `origin`, `method`, byte offsets |
| `POST /api/export/snapshot` | `{format:"png"|"svg", body}` | stores into `saved_view_revision.snapshot_png` or returns a download (the snapshot itself is rendered client-side, §8.3) |

Errors are always `{error:{code, message, hint?, field?}}` with 4xx/5xx status codes. The
server binds `127.0.0.1` and refuses non-local `Host` headers.

---

## 8. Frontend architecture

### 8.1 Modules (vanilla ES modules, no build)

```
public/index.html        shell + fixed mount points (#toolbar #minimap #scroll #lanes #shelf #inspector
                         #panel #sheet #legend #toasts #a11y #tour #ribbon)
public/tokens.css        color/typography/spacing tokens (WP0)
public/shell.css, timeline.css (WP6) · panels.css (WP7) · tour.css (WP8)
src/app.js               boot, panel registry, error boundary, health check
src/state.js             store: immutable state, reducers, subscribe(selector), history (undo for view changes)
src/api.js               fetch wrappers, tile LRU (256 tiles), SSE helper, ?mock=1 fixtures
src/router.js            hash <-> state (uses shared/view-state.js codec); /v/<slug> loader
src/timeline/scale.js    TimeScale: linear + folded regimes, JDN<->px, ticks per regime, seams
src/timeline/layout.js   lanes, sub-lanes, strands, y-slots, "Other" folding, order rules
src/timeline/model.js    tile merge -> segments, end caps, washes, rate scales per unit, occurrence-mode switch
src/timeline/display.js  builds a display list (rect/path/text/glyph primitives with ids + style tokens)
src/timeline/paint.js    Canvas painter for display lists (4 layers, DPR aware)
src/timeline/svg.js      SVG serializer for the same display list (snapshots)
src/timeline/arcs.js     arc geometry, bundling, feedback-below routing, hypothesis-group dimming
src/timeline/hit.js      spatial hash for hit-testing
src/timeline/axis.js     tick generation per tier/regime; labels incl. BCE, centuries, months
src/timeline/coverage.js coverage track + hatch patterns
src/timeline/playhead.js playhead, play loop, reduced-motion policy
src/timeline/minimap.js  folded overview + viewport bracket
src/timeline/a11y.js     screen-reader table + summary + live announcements
src/timeline/controller.js pointer/touch/keyboard -> state actions; inertia
src/ui/search.js filters.js toolbar.js drawer.js toast.js keyboard.js gestures.js ribbon.js snapshot.js
src/views/inspector.js lineage.js constellation.js compare.js notebook.js legend.js   (WP7)
src/views/imports.js jobs.js tour.js selftest.js                                    (WP8)
shared/*.js              imported by both server and browser (served under /shared/)
```

### 8.2 State model & reproducible URL

```js
// shared/view-state.js — version 1
{ v: 1,
  corpus: ["cipher"],                       // corpus slugs
  exprs: [12, 40],                          // pinned expression ids (≤ 6)
  lanes: { by: "domain", sub: null, order: "first_observed", custom: [] },
  time: { from: "1880", to: "2026", mode: "linear", keepLinear: false, basis: "publication" },
  tier: "auto", playhead: "1994-05",
  filters: { language: [], kind: [], collection: [], community: [], stemm: [],
             evidence: ["documented","computed","proposed","human"], showRejected: false,
             includeEstimated: true, includeSynthetic: true, excludeFlags: 3 },
  layers: { arcs: true, feedback: true, washes: true, coverage: true, kindred: false, machineTags: false, baseline: false },
  selection: { type: "passage", id: 55120 },
  panels: { inspector: "tnn", right: null },   // tnn|lineage|constellation|compare|notebook
  compare: { a: { from: 1950, to: 1970, f: {} }, b: { from: 1990, to: 2010, f: {} } },
  runs: { occurrences: 3, cluster: 14, quotes: 9, layout: 2 } }
```

**URL (canonical, stable key order):**
`#/scroll?e=12,40&c=cipher&l=domain&lo=first&t=1880..2026&b=pub&ph=1994-05&f=lang:en.es;kind:song&ev=doc.calc.prop.hum&sel=p55120&p=tnn&cmp=1950..1970~1990..2010&r=o3.c14.q9.y2&ly=arcs.fb.wash.cov`

- Defaults are omitted.
- `shared/view-state.js` exports `encode`, `decode` and `migrate(v0→v1)`. The round trip is
  tested.
- **Saved views** (`/v/<slug>`) store the state plus the server-filled run pins, annotation
  pins and corpus fingerprint.
- When you open a view whose runs have been superseded, a banner reads: "Showing pinned
  analysis c14 (newer c15 available) · 2 annotations revised since saving [show current]."
  Reproducing the view never silently upgrades it.

### 8.3 Canvas timeline rendering

- **Four stacked canvases:**
  - `bg`: banding, hatching, period bands, coverage underlay
  - `data`: bars, strands, washes, marks, glyphs
  - `arcs`
  - `overlay`: hover, selection, playhead, brush

  Lane labels are **DOM** (focusable, readable). Axis labels are canvas.
- **Pipeline:** `tiles → model.js → display.js` (display list with stable ids) →
  `paint.js` for screen, or `svg.js` for snapshots. The snapshot is guaranteed to match the
  screen.
- **Pan:** `bg` and `data` are rendered into a 3× viewport-width backing canvas. Panning
  blits with an offset and re-renders only the exposed strip. Zoom re-renders. `overlay`
  redraws on every pointer frame.
- **Budgets** (MacBook-class, 1,440 × 900, DPR 2):

  | Item | Budget |
  |---|---|
  | frame | ≤ 8 ms paint (60 fps) |
  | aggregate rects | ≤ 20,000 |
  | individual marks | ≤ 4,000 |
  | individual arcs | ≤ 300 |
  | canvas text labels | ≤ 200 |
  | first meaningful Scroll paint | ≤ 1.2 s after load (demo) |
  | cached tile fetch → paint | ≤ 50 ms |
  | cold tile p95 | ≤ 800 ms |
  | main-thread long tasks | none > 50 ms |

  If a frame's display list goes over budget, `display.js` steps to the next coarser tier
  and shows a `simplified` badge with the reason.
- **Snapshot:** PNG = composite of the four layers plus legend, caption, view URL, date
  generated and a **`SYNTHETIC` stamp** if any synthetic item is visible (`canvas.toBlob`).
  SVG = `svg.js` (≤ 20k elements, otherwise aggregated).

### 8.4 Hit-testing

- A uniform **spatial hash** (24 px cells) in content coordinates is built from the display
  list after layout or zoom, never on pan; the pan offset is subtracted at query time.
- Each entry is `{id, kind:'bucket'|'mark'|'wash'|'arc'|'cap'|'fork'|'band', bbox,
  payload}`. Arcs are sampled into 12 points with 4 px tolerance.
- Priority on overlap: mark > arc > fork/cap > bucket > wash > band.
- Hover runs at most once per `requestAnimationFrame`. Every drawn primitive with
  `openable:true` has a hit entry; a test checks this (§11).

### 8.5 Keyboard, touch, narrow viewport, accessibility

**Keyboard map:**

| Key | Action |
|---|---|
| `/` | Focus search |
| `←` / `→` | Pan 10% (`Shift`: 50%) |
| `+` / `-` | Zoom around the playhead |
| `0` | Fit data |
| `Shift+0` | Deep-time overview |
| `Space` | Play/pause |
| `[` / `]` | Step one bucket |
| `↑` / `↓` | Lane focus |
| `Enter` | Expand lane / open the focused item |
| `Tab` / `Shift+Tab` | Next/previous mark in the focused lane, in time order |
| `L` / `C` / `T` / `G` / `N` | Lineage / Constellation / Then-Now-Next / Compare / Notebook |
| `A` | Annotate the selection |
| `S` | Save view |
| `E` | Export |
| `R` | Reduced motion |
| `H` | Toggle the screen-reader table view |
| `?` | Shortcut sheet |
| `Esc` | Close panel / clear selection |

**Touch:**

| Gesture | Action |
|---|---|
| one-finger horizontal drag | Pan (with inertia) |
| pinch | Zoom time only, centered on the midpoint |
| two-finger vertical | Scroll lanes |
| tap | Select |
| long-press (500 ms) | Action sheet (open, annotate, lineage, pin) |
| double-tap | Zoom in one tier |
| playhead | Drag its 44 px handle |

**Narrow viewport (< 720 px):**
- The Scroll takes the top 55% and the inspector is a bottom sheet (peek 30%, full 90%).
- Up to 6 lanes, with labels as overlay chips. The undated shelf collapses to a `⊘ 4`
  chip.
- The toolbar becomes a bottom bar: Search · Play · Lanes · Filters · More.
- Then/Now/Next become swipeable tabs. Lineage, Constellation, Compare and Notebook are
  full-screen sheets. Compare stacks A over B.

**Accessibility:**
- All text tokens meet ≥ 4.5:1 contrast (measured, §8.6). Focus ring: 2 px cyan + 2 px
  charcoal offset.
- Evidence status is never encoded by color alone: pattern + badge text.
- **Screen-reader alternative** (`#a11y`, also visible with `H`): a `role=grid` table built
  from the *same tile data*. Rows are lanes, columns are visible buckets, and each cell
  reads "1890s · Literature · 14 occurrences · 3.2 per million tokens · coverage 4.4 M
  tokens · 2 imprecise". It's preceded by a generated summary: "virus: first observed in
  this corpus 1704 (Literature); also in Etymology as Latin *virus* 'venom' (language
  period, not dated); last observed 2013 (Culture). 3 documented, 5 computed
  relationships."
- Playhead steps announce through `aria-live=polite`, throttled to one per second.

### 8.6 Color tokens and evidence styling

| Token | Hex | Contrast on `--bg-0` | Use |
|---|---|---|---|
| `--bg-0` | `#0E1013` | — | deep charcoal canvas |
| `--bg-1` | `#161A20` | — | panels |
| `--bg-2` | `#1F242C` | — | raised, popovers |
| `--line` | `#343A45` | 1.67 (non-text) | rules, lane banding |
| `--ink` | `#EDE6D6` | 15.3 | warm ivory text, neutral marks |
| `--ink-2` | `#BDB5A5` | 9.4 | secondary text |
| `--ink-3` | `#8E887B` | 5.4 (4.4 on bg-2: **not used on bg-2**) | tertiary/meta |
| `--cyan` | `#4FD8E8` | 11.2 | selection, navigation, playhead, focus |
| `--amber` | `#E8A84A` | 9.2 | historical references (material from earlier) |
| `--violet` | `#B59AF5` | 8.1 | reinterpretation, reframing, reception, hypotheses |
| `--danger` | `#F2826F` | 7.4 | errors, rejected |
| `--synthetic` | `#D9CFB8` on a 45° stripe | 12.3 | SYNTHETIC ribbon/badges (deliberately not a semantic hue) |

Cyan, amber and violet differ by hue but barely in luminance (1.1–1.2:1 between each
other). So **hue is always backed by pattern and text**:

| Visual class | Line | Endpoint | Badge | Default opacity |
|---|---|---|---|---|
| documented | solid 1.5 px | filled dot | `DOC` (`DOC*` when `source_unrecorded`) | 100% |
| computed | dotted 2/3 | hollow dot | `CALC` | 85% |
| proposed | long dash 8/4 | hollow diamond | `PROP` | 85% |
| human (confirmed) | solid + ⌖ pin at midpoint | filled pin | `✓ HUMAN` | 100% |
| disputed | dash-dot | ≠ glyph | `≠ DISPUTED` | 100% |
| rejected | thin solid with × at midpoint | none | `✗` | hidden by default (30% when shown) |

Hue by role:
- **amber**: quotation, citation, derivation, etymology (pointing at earlier material)
- **violet**: parody, recontextualization, rereading, hypotheses
- **ivory**: association/similarity
- **cyan**: only the current selection

Type: system UI sans for chrome; a serif for passages (`ui-serif, "New York",
"Iowan Old Style", Georgia, "Noto Serif Devanagari", "Noto Serif Gujarati", serif`, 17 px /
1.6, max 68ch).

---

## 9. Demonstration corpus — "Placeholder" (all synthetic)

**Labeling.** Corpus `demo-placeholder` has `is_synthetic=1` on the corpus, collections,
documents, passages, relationships, annotations and hypothesis groups.

- Every rendering of a synthetic item carries a striped `SYN` badge, and the corpus ribbon
  stays visible while any demo collection is in scope.
- Exports carry the `is_synthetic` column and a header warning. Snapshots get a stamp.
- People, places, publications and dates are invented. Fictional organizations use names
  checked to be generic (Stourmouth, Corran, Static Quarterly).

**Size.**
- **64 hand-authored anchor passages** that carry the narrative.
- **1,536 template-generated background passages**, from a seeded generator
  (mulberry32, seed 1994) drawing on sense-specific vocabulary pools. These give the
  statistics real mass: about 340 occurrences of *carry the zero* across 4 senses.
- A deliberate **no-coverage gap 1940–1949** and thin coverage in the 1920s demonstrate
  gaps.
- **Dates** cover every precision: day, month, year, "1930s", "c. 1894", "early 20th
  century", and 1 undated flyer.
- **Languages:** en, es, gu, hi.

**Cast** (synthetic, four generations):

| Gen | Person / body (all fictional) | Work (date, precision) | Role |
|---|---|---|---|
| 0 | Stourmouth Potters' Union | Notice on marks (c. 1894) | ⊙ "kiln eye" = "fired true" |
| 0 | Tobias Vell, novelist (1861–1929) | *The Ledger House* (1903) | "There is a ghost in the margin of every ledger, and it is always owed." |
| 0 | Ada Merriwether, teacher (1868–1940) | *Merriwether's Ready Arithmetic* (1911) | "Carry the zero, children: it holds the place where nothing is, so that something can be counted." |
| 0 | J. R. Ostrander | *Handbook of Joining Metals* (1922) | "flux up the joint before the heat" |
| 1 | Harlan Okafor | *Field Manual for Wireless Operators* (1936) | "when the trace closes into the kiln eye — as the potters called their mark — the signal is locked" |
| 1 | Dr Imogen Sato-Reyes, Corran Aeronautical Laboratory | memo (1958-03-14) | "Half this department is carrying zeros for the auditors." |
| 1 | Corran *Bulletin* | (1963-06) | "carry the zero, it holds the place where nothing is — and file the form in triplicate" |
| 1 | Wren Calloway, programmer | lab notebook (1971-08-02) | "ghost in the margin again — bit 7 flips on the third pass. Vell had it right." |
| 1 | Ostrander rev. | *Electronics Bench Manual* (1966) | "flux up the pads" (solder) |
| 2 | KLN crew | zine *Burner Notes* #3 (1986-07) | "the kiln eye on the wall means we've been through the fire" |
| 2 | MC Quill Haddad (b. 1972) | "Carry the Zero", album *Placeholder* (1994-05-17); liner note "for Mrs Merriwether's book" | "the ones they never counted hold the place for the number" |
| 2 | Dana Ilves, critic | *Static Quarterly* review (1995-02) | "sneers at every schoolroom that ever bored him" |
| 2 | Quill Haddad | interview (1995-04) | "It's a thank-you note, not a sneer. The zero is us." |
| 2 | Lu Arce | "Flux Up" (1997) | "flux up with the block" (crew bonding) |
| 3 | Kestrel & Nine | "Remainder" (2003) | "carry the zero — call it a sneer, call it a prayer" |
| 3 | Sol Mendoza-Price | "Ghost in the Margin" (2008, en/es) | quotes Vell's line verbatim, then "fantasma en el margen — the writer they never paid" |
| 3 | forum thread (2011-11-03) | post | "the argument over whether it mocks teachers is half the song now" |
| 3 | St. Brennan Hospital newsletter (2013-02) | | ⊙ sticker = "sterilized, through the fire" |
| 3 | Priya Lindqvist, essayist | "Uncredited" (2016) | "From the ghost in the margin to whoever carries the zero, the culture runs on uncredited labor." |
| 3 | MC Tara Vyas (Ahmedabad) | Gujarati verse (2017) | "શૂન્ય ઉપાડી ચાલ — જેને કોઈ ગણતું નથી એ જ જગ્યા રાખે છે" |
| 3 | Natvarlal Bhatt | Gujarati primer *Ganit Pothi* (1931) | "શૂન્ય ઉપાડો" (school usage) |
| 3 | Rehan Qadri | Hindi verse (2018) | "शून्य को साथ ले चल" |
| 3 | Nell Okonjo, engineer | blog (2019-09-30) | "carry the zero: never drop a null that holds a place in the schema" |
| 3 | startup memo (2014) | | "flux up the two teams" (merge orgs) |
| 3 | fan post (2022) | | ⊙ as "survived" |
| 3 | Quill Haddad | interview (2024-03-09) | "Both readings are in the song now." |
| ? | KLN flyer | (undated) | ⊙ "all city" (on the undated shelf) |

**How the seven phenomena are encoded:**

| # | Phenomenon | Expression | Evidence in the corpus | What the user sees |
|---|---|---|---|---|
| P1 | sincere → ironic | *carry the zero* | 1911 sincere; 1958/1963 bureaucratic irony; `exact_quotation` 1911→1963 (computed, 12 shared tokens) | sense strand "column · digit · place" → new strand "auditors · forms · memo"; fork glyph (computed) |
| P2 | ironic → reclaimed sincerely | *carry the zero* | 1994 verse + liner `explicit_citation` (documented, text citation) + `recontextualization` 1911→1994 (human ✓) | Hip-hop lane opens with strand "counted · ones · hold"; solid amber arc to 1911; violet `re-reads` feedback arc below, 1994→1911 |
| P3 | symbol across communities | ⊙ *kiln eye* | potters c.1894; radio 1936 (documented citation of the potters); KLN 1986; hospital 2013; fans 2022 | 5 community lanes; only ONE documented arc (1936→1894); the others are unlinked or `proposed` (Reader A) — "similarity is not ancestry" |
| P4 | remembered reference in a new context | *ghost in the margin* | 1903 novel; 1971 notebook cites "Vell" (documented); 2008 exact quote (computed) re-aimed at ghostwriting | 3 lanes (Literature → Computing → Hip-hop) with arcs of two evidence classes |
| P5 | term splitting | *flux up* | metallurgy 1922 → solder 1966 → crew bonding 1997 → org merging 2014 | lane-by-sense shows 1 strand forking into 3 (stability: 2 stable, 1 pattern) |
| P6 | two expressions converging | *carry the zero* + *ghost in the margin* | both acquire "uncredited / unpaid / writer" collocates after 2008; Lindqvist 2016 cites both (documented) | confluence bracket (computed, cos 0.31 → 0.66); in Constellation 1990s vs 2010s the two nodes keep their positions while a shared neighbor "uncredited" appears in B |
| P7 | disagreement → inherited meaning | *carry the zero* | 1995 review vs 1995 interview; 2003 "sneer… prayer", 2011 forum, 2024 interview | notebook shows Reader A (mockery) and Reader B (tribute) layers; hypothesis group "Is Vyas 2017 from Haddad 1994 or from Bhatt 1931?" with two `proposed_allusion` edges, `≠ DISPUTED`; later uses carry "sneer/prayer" collocates |

**Demo annotations** (synthetic authors "Reader A", "Reader B"):

- A1 (Reader A, rev 1 → rev 2): "mockery of schooling" → "ironic distance from schooling".
- A2 (Reader B): "tribute — the zero is the uncounted".
- A3: a hypothesis card in the Next zone: "By 2035 'carry the zero' may be mainly a
  data-engineering term outside hip-hop".
- A4: a `correction` rejecting a computed similarity between Okonjo 2019 and Haddad 1994:
  "shared phrase, unrelated sense".
- A5: a cluster label rename, "place · counted · ones" → "honoring the uncounted", with the
  machine label preserved.

**Guided tour** (`demo/tour.json`; 9 steps, about 3 minutes; steps 1–3 are the 60-second
coach marks):

1. **"Watch it acquire history."** State: `carry the zero`, lanes = community. Click ⏵. You
   learn that bars are observations and the 1940s hatching is missing coverage.
2. **"Open the evidence."** Click the 1911 Classroom bar, then the row. The passage opens
   with its byte range and file. You learn that every mark traces to text.
3. **"Sincere → ironic."** Switch lanes to *sense*. Hover the fork. Click the 1911→1963 arc.
   You learn: a computed exact quotation (dotted, `CALC`) versus the documented 1994 liner
   citation (solid amber, `DOC`).
4. **"Ironic → reclaimed."** Select the 1994 verse. Then/Now/Next: Then = 1911 primer +
   1958 memo; Now = 1994; Next = 2003, 2016, 2017 + hypothesis A3. You learn temporal
   layering.
5. **"A disagreement becomes inheritance."** Press `N`: Reader A vs Reader B, A1's revision
   diff. Then `L`: the disputed hypothesis group for Vyas 2017 (⑂ 2 competing). Click
   `Confirm` on neither. You learn that disagreement is preserved, not resolved by the
   machine.
6. **"A symbol across communities."** Search ⊙. Lanes by community. Open the Lineage
   explorer: one `DOC` edge, other links missing or `PROP`. You learn that similarity is not
   ancestry.
7. **"A term splits."** Search *flux up*, lanes = sense. You learn what a computed split
   is, and to read the stability classes.
8. **"Two expressions converge."** Pin *ghost in the margin*. Press `C` and compare
   1990–1999 with 2010–2019: positions stay fixed and "uncredited" appears. Then `G`: the
   coverage panel first, then cluster shares with CIs, then displacement (passes the gate
   on the synthetic mass, with the caption "computed on synthetic text").
9. **"Your turn."** `S` saves the view and the URL is copied. "Switch to Cipher corpus" with
   suggested searches: *virus*, *feedback*, *bug*, *radio*, *gravity*.

---

## 10. STEMM integration

**Adapter interface** (`server/adapters/<id>.js`). Adapters only read *staged files*. Fetchers
live in `tools/fetch/` and are run by the user. Adapters never write to the database.

```js
export default {
  id: "openalex", version: "1.0.0", displayName: "OpenAlex works (CC0)", license: "CC0",
  requiresNetwork: false, domain: "stemm",
  collections: [{ slug: "openalex", name: "OpenAlex sample", content_kind: "fulltext", unit: "tokens" }],
  detect(dataDir) { /* → {available, files, manifest, problems:[{code:'FORMAT_MISMATCH', message}]} */ },
  async *documents(ctx) { /* yield NormalizedDocument */ },
  async *relationships(ctx) { /* yield RelationshipInput (by external ids) */ },
  async *expressions(ctx) { /* optional: etymology / attestation claims */ },
  async *tags(ctx) { /* optional machine tags */ },
  baseline(ctx) { /* optional: {attach: path, query(term) → [{year, match_count, total}] } */ },
};
// ctx = { dataDir, signal (AbortSignal), progress(done,total,label), warn(problem) }
// NormalizedDocument = { external_id, title, author, language, kind, genre, community, stemm_field,
//   source_url, license_note, is_synthetic, original:{text|path, join_rule?}, original_meta,
//   times:[{time_kind, label, is_primary, basis?, method}], passages?:[{kind,start_byte,end_byte,page_no}] }
```

The core (WP1) validates, stores originals, segments, indexes and updates coverage. Every
adapter's `detect` reads `MANIFEST.json` and `FORMAT.md`. If the files are missing or the
format doesn't match, `detect` reports the problem and the adapter shows "unavailable"
instead of crashing.

**The four STEMM sources** (approved per inventory §9; staged under
`$SCROLLS_DATA/sources/<name>/`; the field names below are expected and are confirmed
against each `FORMAT.md` at implementation time):

| Adapter | Files | Becomes | Time basis | Lanes |
|---|---|---|---|---|
| `gutenberg-stemm` | `catalog.jsonl`, `texts/`, `cipher-overlap.jsonl` | full-text documents (`kind='book_text'`, `domain='stemm'`); ids in `cipher-overlap` are skipped as duplicates of Cipher books and linked with `dup_of` | Wikidata P577 → `stated`; author-lifetime → `estimated` (striped) | `stemm_field` = LoCC → S/T/E/M/Med |
| `openalex` | `works.jsonl`, `citations.tsv`, `coverage.tsv` | abstract documents (`kind='abstract'`; original = reconstructed abstract, join rule noted); `citations.tsv` → `explicit_citation` **documented** (`source_dataset='openalex'`) only when both ends are in the sample, otherwise a dangling count | `publication_year` stated | OpenAlex field → S/T/E/M/Med |
| `wiktionary-coinage` | `terms.jsonl`, `stats.json` | each claim → `document(kind='entry')` + passage = the claim sentence (CC BY-SA) + `time_assertion(kind='attestation_claim', subject=expression, evidence_passage_id)` | the claim's own date; the entry's own time = unknown/ingestion | Etymology lane, as ◇ "attestation claim" markers |
| `ngram-baseline` | `ngram-eng-1.sqlite` | `ATTACH … AS ngram` **read-only**; `baseline_series` filled lazily per term | year | thin reference sparkline under a lane group, labeled "Google Books Ngram (CC BY 3.0) — external aggregate; no passages" |

**Sampling honesty for OpenAlex.** `coverage.tsv` gives the population count per field-year.
The coverage track shows *sampled* vs *population* works. Rates are per million *sampled
abstract tokens*, and the lane header says "stratified sample (n per field-year), not
the whole literature".

**How STEMM appears.**
- Lanes by `domain` show *Etymology · Literature · STEMM · Culture* (default for the real
  corpus).
- Sub-lanes by `stemm_field` split STEMM into S/T/E/M/Med, with an expandable LoCC or
  OpenAlex subfield level.
- A domain-colored left rule on each lane header uses ink tints, not semantic hues.

**Following terms honestly** — the **Crossings card** in the inspector header, for an
expression:

```
virus   Etymology   Latin vīrus "venom, poisonous secretion" · language period ≈75 BCE–200 CE ← PIE *weys- (period)
                    source: roots.tsv (Wiktionary via kaikki, CC BY-SA) — no attestation date
        Literature  first observed {year} · n={n} · {rate} pm tokens · top sense "{label}"
        STEMM       first observed {year} · per field: Medicine {n} · Immunology {n} · Computer Science {n}
        Culture     titles: "Virus" (film, 1999), "Mickey Virus" (film, 2013) — 2 of 94,385 titles
        Claims      ◇ Wiktionary attestation claims (separate from occurrences)
        Caption: "First observation in THIS corpus is not the date of coinage, and not evidence of borrowing."
```

The braces are filled by queries. Only the Etymology and Culture lines contain values
already measured on disk.

**Cross-domain arcs** are drawn only when they're documented (e.g. a film `based_on` a
book; OpenAlex citations) or computed and *labeled as similarity* (non-directional
`similar_contextual_usage` between sense centroids, cos ≥ 0.6, n ≥ 20 each). There is
**never** a "science → slang" arrow without a documented source.

**Seed watch-list** (`demo` excluded; `expression.origin='stemm_seed'`; materialized after
the Cipher import as a background job): virus, viral, bug, algorithm, gene, genetic,
quantum, hacker, hack, robot, atomic, radio, electric, gravity, DNA, satellite, rocket,
laser, cyber, network, **feedback**, signal, static, frequency, code, program, glitch, sample.

Measured title counts in culture-works (for honest expectations):
- radio: 33 songs
- telephone: 12 songs
- electric: 9 songs
- rocket: 8 songs
- gravity: 8 songs
- virus: 2 films
- bug: 3 songs + 4 films
- quantum: 3 tv + 2 films
- hacker: **0**
- algorithm: **0**

Empty states say so: "No titles in the culture index (94,385) contain ‘hacker’. 0 is an
observation about this index, not about culture."

**Senses across STEMM and culture.** Sense clustering runs per language over pooled
full-text slices (Literature + STEMM). Culture titles carry no context, so they appear as
occurrences in the Culture lane without senses. Summaries (Wikidata descriptions, about 8
words) may qualify when ≥ 3 context terms are present.

---

## 11. Test plan (`node --test tests/*.test.mjs` + in-browser selftest)

| Brief §12 criterion | Tests (file → what is asserted) |
|---|---|
| Real uploaded corpus imports and is searchable | `ingest.test` → CSV/TSV/JSON/JSONL/TXT/MD fixtures import; summary counts exact; FTS finds a phrase in each. `adapters.test` → cipher-gutenberg on 3 real books (subset), cipher-wikisource on 2 hi + 2 gu lines, cipher-culture on a 200-row sample: docs/passages/relationships counts match hand-computed expectations. `journey.test` → HTTP: import a CSV → search → passage with correct bytes. |
| Dates and unknown dates behave correctly | `dates.test` → ~90 grammar cases (ISO day/month, month names en/fr/es, year, −300 → astro −299, "1990s", "1800s" + warning, centuries incl. Roman/fr/es, early/mid/late, ranges, circa widening, Vikram Samvat, Devanagari/Gujarati digits, '94 rejected, "0" with/without option). `aggregate.test` → undated never in cells or denominators, always in shelf counts; **conservation**: Σcells + Σwashes + undated = total for every tier; a `c. 1890` occurrence is a wash at decade tier and counted at century tier. |
| Every displayed occurrence opens its original passage | `offsets.test` → 2,000 random occurrences across en/fr/es/hi/gu: decode(original[start:end]) normalizes to a variant of the expression; CRLF, BOM, combining marks, Gutenberg `_italics_`; **culture-lines oracle** (500 lines). `client-timeline.test` → every display-list primitive with `openable` has a hit entry whose id resolves via `/api/passages` or a bucket drawer page. |
| Filters update visualizations and counts consistently | `aggregate.test` → for 20 random filter combos: Σ tile cells for lane L = `/api/occurrences` total = export row count. `client-state.test` → a filter change changes `qkey` and invalidates tiles; the a11y table totals equal the canvas model totals. |
| Demonstration material is clearly labeled | `demo.test` → every demo row has `is_synthetic=1` (DB CHECK query); every API payload touching it has `synthetic:true`; exports include the column + header warning. `selftest` → ribbon visible, `SYN` badge in the inspector, `SYNTHETIC` stamp present in the PNG snapshot's display list. |
| Inferred lineage cannot be mistaken for documented citation | `provenance.test` → INSERT with `origin='algorithm', evidence_status='documented'` fails on CHECK; Cipher `kindred` → computed, `counterpart` → proposed, `[-] inspired` → proposed, `w/d/m/i` → documented; mirror pairs deduped; `visual_class` mapping table-driven; the display list for a computed arc has the dotted dash + `CALC` badge; legend contains all classes; review actions never change `origin`/`method`. |
| Insufficient evidence never yields authoritative drift claims | `analysis.test` → fixtures below each gate return `value:null`, `gate_ok:false` and reasons; above the gates return CIs + control percentile; small-n synthetic slice → "too few"; Procrustes on a rotated copy of a space recovers R (residual < 1e-4); displacement for an unchanged word lies inside the control distribution. |
| Saved views & annotations survive restart | `persistence.test` → spawn the server on a temp `SCROLLS_DATA`, create view + annotation rev 1→2 + relationship review, SIGTERM, restart, GET equals; `decode(encode(state))` deep-equals; reopening a view reproduces the same `qkey`. |
| Malformed input gives actionable feedback | `ingest.test` → fixtures: invalid UTF-8, ragged CSV, JSONL with a broken line 37, unparseable/ambiguous dates, empty text, duplicate id, oversized file; each yields `{code,row,message,suggestion}` and the right accept/reject action. |
| Main flow on desktop + narrow viewport | `selftest.js` (`/?selftest=journey`), run in the Browser pane at 1,440×900 and 390×844 (`resize_window`): load demo → search → Scroll paints → click a bucket → open passage → compare two periods → save view → reload `/v/<slug>` → same state. Screenshots kept in `$SCROLLS_DATA/cache/verify/`. |
| Expensive analysis does not freeze the UI | `jobs.test` → during a cluster job on 20k vectors, `monitorEventLoopDelay` p99 < 50 ms on the main server thread; cancel → `cancelled` within 1 s and no partial rows. `selftest` → a `PerformanceObserver('longtask')` during play + panning reports no task > 50 ms. |

The **"meaningful tests" areas from the brief** are covered by: ingestion (`ingest`,
`adapters`), offsets (`offsets`), temporal aggregation (`aggregate`, `dates`), relationship
provenance (`provenance`), persistence (`persistence`).

---

## 12. Build plan (parallel, file-owned)

### 12.1 Target repository tree

```
Scrolls/
├── package.json  server.mjs  README.md                     (WP0; README by WP8)
├── shared/  dates.js tiers.js evidence.js facets.js view-state.js shapes.js      (WP0, frozen after Phase 0)
├── server/
│   ├── config.js  db/{schema.sql,seed.sql,open.js,migrate.js}                   (WP0)
│   ├── http/{router.js,respond.js,sse.js,static.js}  jobs/{queue.js,worker.js,cancel.js}   (WP0)
│   ├── routes/index.js health.js jobs.js                                         (WP0)
│   ├── text/{normalize.js,segment.js,tokenize.js,langdetect.js,originals.js}     (WP1)
│   ├── ingest/{parse-txt.js,parse-md.js,parse-csv.js,parse-json.js,mapping.js,validate.js,
│   │           dedupe.js,store.js,coverage.js,summary.js,import-job.js}           (WP1)
│   ├── routes/imports.js                                                         (WP1)
│   ├── adapters/{registry.js,cipher-gutenberg.js,cipher-wikisource.js,cipher-culture.js,
│   │             cipher-etymology.js,gutenberg-stemm.js,openalex.js,wiktionary-coinage.js,
│   │             ngram-baseline.js,demo.js}  routes/adapters.js  tools/import-cipher.mjs   (WP2)
│   ├── search/{fts.js,kwic.js,expressions.js,occurrences.js}
│   ├── aggregate/{query.js,tiles.js,coverage-read.js,cache.js}
│   ├── routes/{search.js,timeline.js,passages.js,documents.js,expressions.js}   (WP3)
│   ├── analysis/{collocations.js,quotes-exact.js,quotes-near.js,align.js,linalg.js,ppmi-svd.js,
│   │             occvec.js,cluster.js,stability.js,labels.js,drift.js,tone.js,layout.js,runs.js,
│   │             stopwords/{en,fr,es,hi,gu}.txt}
│   ├── routes/{analysis.js,compare.js,constellation.js,clusters.js,runs.js}      (WP4)
│   ├── lineage/{relationships.js,graph.js,review.js}  notebook/{annotations.js,views.js,export.js}
│   └── routes/{lineage.js,relationships.js,annotations.js,views.js,export.js}   (WP5)
├── native/nl-adapter/{main.swift,build.sh}                                       (WP4)
├── public/{index.html,tokens.css}(WP0)  {shell.css,timeline.css}(WP6)  panels.css(WP7)  tour.css(WP8)
├── src/{app.js,state.js,api.js,router.js}  src/timeline/*  src/ui/*              (WP6)
├── src/views/{inspector.js,lineage.js,constellation.js,compare.js,notebook.js,legend.js}   (WP7)
├── src/views/{imports.js,jobs.js,tour.js,selftest.js}  src/views/index.js(WP0 registry)  (WP8)
├── demo/{anchors.jsonl,generator.mjs,relationships.jsonl,annotations.jsonl,tour.json,README.md}  (WP8)
├── tests/foundation.test.mjs dates.test.mjs  tests/fixtures/api/*.json            (WP0)
│   ingest.test.mjs offsets.test.mjs tests/fixtures/import/*                       (WP1)
│   adapters.test.mjs tests/fixtures/cipher/*                                      (WP2)
│   aggregate.test.mjs search.test.mjs                                             (WP3)
│   analysis.test.mjs jobs.test.mjs                                                (WP4)
│   provenance.test.mjs persistence.test.mjs                                       (WP5)
│   client-state.test.mjs client-timeline.test.mjs                                 (WP6)
│   client-views.test.mjs                                                          (WP7)
│   demo.test.mjs journey.test.mjs                                                 (WP8)
└── Docs/{brief.md,data-inventory.md,proposals/,API.md(WP0),IMPORT-SCHEMA.md(WP1),ANALYSIS.md(WP4)}
```

`tools/fetch/*.mjs` already belongs to the source-fetching effort. No WP here touches it.

### 12.2 Work packages

| WP | Owner scope | Depends on (contracts) | Done when |
|---|---|---|---|
| **WP0 Foundation** (first, alone) | package.json, server.mjs, shared/*, server/db/*, http/*, jobs/*, routes/{index,health,jobs}, public/index.html + tokens.css, **stub files** for every module path above (owners overwrite after Phase 0), Docs/API.md, `tests/fixtures/api/*.json` (one example response per endpoint) | — | `npm test` green; server boots on :3030 with `$SCROLLS_DATA`; schema migrates; a job can be started/cancelled with SSE progress; fixtures validate against `shared/shapes.js` |
| **WP1 Ingestion & text core** | server/text/*, server/ingest/*, routes/imports.js, Docs/IMPORT-SCHEMA.md | dates.js, schema, jobs | §5 complete; coverage cells written; offsets round-trip |
| **WP2 Source adapters** | server/adapters/*, routes/adapters.js, tools/import-cipher.mjs | adapter interface (§10), WP1's `store.js` API (frozen signature in shapes.js) | Cipher import completes in ≤ 10 min with progress; mapping table §6 enforced; STEMM adapters report `unavailable` cleanly until data is staged |
| **WP3 Search & aggregation** | server/search/*, server/aggregate/*, routes/{search,timeline,passages,documents,expressions} | tiers.js, facets.js, schema | tile endpoints meet budgets; conservation tests pass |
| **WP4 Analysis** | server/analysis/*, native/nl-adapter/*, routes/{analysis,compare,constellation,clusters,runs}, Docs/ANALYSIS.md | evidence.js, runs schema, jobs | gates enforced; runs versioned; quotes → computed relationships |
| **WP5 Lineage, notebook, views, export** | server/lineage/*, server/notebook/*, routes/{lineage,relationships,annotations,views,export} | evidence.js, view-state.js | provenance + persistence tests pass |
| **WP6 The Scroll (frontend core)** | src/{app,state,api,router}.js, src/timeline/*, src/ui/*, public/{shell,timeline}.css | view-state.js, tiers.js, API fixtures | §1 + §8 on fixtures, then live; budgets met |
| **WP7 Lenses & notebook (frontend)** | src/views/{inspector,lineage,constellation,compare,notebook,legend}.js, public/panels.css | API fixtures, evidence.js | §2 B–F specs; mounts via the registry contract `mount(el, ctx) / update(state, prev)` |
| **WP8 Demo, tour, docs, verification** | demo/*, src/views/{imports,jobs,tour,selftest}.js, public/tour.css, README.md, tests/{demo,journey}.test.mjs | adapter interface (`demo.js` is WP2's thin loader of WP8's files), all APIs | §9 corpus + tour; journey passes at both viewports; README with setup, import schema, analysis limits, a "what works / needs adapter / unfinished" table |

**Shared-contract rules:**
- `shared/*`, `schema.sql` and `Docs/API.md` change only through WP0's owner, who becomes
  the integrator after Phase 0.
- A change request bumps `shared/shapes.js` `CONTRACT_VERSION`, and fixtures are
  regenerated.
- No two WPs write the same file.
- Cross-WP calls go through exported functions declared in `shared/shapes.js` typedefs.
  Examples: WP1 `ingest/store.js: storeDocument(db, NormalizedDocument) → {document_id,
  passages}`; WP3 `search/occurrences.js: materialize(db, expressionId, ctx) → run_id`.

### 12.3 Order

1. **Phase 0 (WP0, ~0.5 day):** contracts, schema, skeleton, stubs, fixtures. Gate: the
   foundation tests pass.
2. **Phase 1 — vertical slice (all WPs in parallel, about 2 days).** Priority targets: WP1
   CSV/TXT import, WP2 `demo` + `cipher-gutenberg`, WP3 search + tiles, WP6 Scroll on live
   tiles, WP7 inspector + basic Compare (frequency + coverage only), WP5 saved views, WP8
   demo anchors + generator. **Gate V:** import → search → timeline → open evidence →
   compare periods → save view → restart → reopen, at both viewports.
3. **Phase 2 (parallel, about 2–3 days), in the brief's order:**
   1. quotation lineage (WP4 quotes + WP5 graph + WP7 lineage explorer)
   2. clustering (WP4 + WP6 sense lanes/forks)
   3. constellation (WP4 layout + WP7)
   4. notebook (WP5 + WP7)
   5. advanced: drift, NL adapter, the remaining Cipher adapters, STEMM adapters as data
      lands
4. **Phase 3 (integration, about 1 day):** WP8 runs the journey and selftest in the Browser
   pane (desktop + 390 px), fixes go to owners, and the README states exactly what works,
   what needs an optional adapter, and what is unfinished.

---

*Guiding principle, kept literal in the UI's About sheet: "An expression carries its past
into each new encounter. Let the user see what survives, what changes, and what evidence
connects the two."*
