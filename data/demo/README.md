<!-- OWNER: WP2 — the synthetic demonstration corpus (SPEC §9) -->
# Demo corpus — "carry the zero" (SYNTHETIC)

**Everything in this folder is invented**: the city of Quellhaven, its people, works, dates, passages, links,
liner notes and annotations. The phrase *carry the zero* exists in real English (and as real song titles); its
*history* here is made up. Every row the demo creates has `is_synthetic = 1`, every author name ends in
"(synthetic)", and every generated document's title starts with "(generated background)".

## Files

| File | What it is | Edited by |
|---|---|---|
| `anchors.jsonl` | 31 hand-written anchor documents (A1–A31 of SPEC §9.3), one JSON per line: `paragraphs` (verse stanzas keep their `\n`), `date.raw`, `community`, `planted` (expected counts) and `senses` (ground-truth sense per expression) | by hand |
| `generator.mjs` | the seeded background generator, `mulberry32(1994)` (SPEC §9.5); also the community labels and the occurrence finder used by checks and tests | by hand |
| `documents.jsonl` | anchors + generated documents as CanonicalDocuments (dates parsed against a fixed "today", 2026-10-04) | `npm run build:demo` |
| `relationships.jsonl` | the synthetic world's documented records (liner notes, works cited, a bibliography, an interview answering a review) and three human proposals by Reader A, one of them rejected by Reader B | `npm run build:demo` |
| `annotations.jsonl` | 18 pragmatic-function labels, Reader A's and Reader B's readings of A15 (Reader A's has a second revision), Reader B on A4, Reader A's hypothesis card, and two *deferred* items that wait for the pipeline | `npm run build:demo` |
| `tour.json` | the 10-step guided tour; ids and numbers are resolved by `GET /api/tour` at request time | by hand |

Run `npm run build:demo` after editing an anchor or the generator, then `node scripts/check-demo-names.mjs
--recordings`. The build refuses to write when a calibration number fails, when a generated document falls in
the 1940s or after the demo's "today", or when two documents share a run of ≥ 13 tokens or a sentence with ≥ 50%
of its word 3-shingles (other than the planted A11↔A4 and A20↔A3 runs) — so the quotation detectors can only
find what was planted.

## Calibration (asserted by `tests/demo.test.mjs`)

| Expression | Total | Planted senses (occurrences / documents / authors) |
|---|---|---|
| *carry the zero* (default inflections) | **340** in 92 documents | place value 90/24/12 (Classroom) · bureaucratic irony 70/18/9 (Office & Lab) · honoring the uncounted 110/30/16 (Hip-hop; the two Criticism anchors A16, A24 count here) · null placeholder 70/20/11 (Software) |
| *flux up* | 120 generated + 5 anchors | metallurgy 30/8 · electronics 30/8 · crew bonding 30/9 (inside Hip-hop documents) · merging teams 30/8 (inside Software documents) |
| *ghost in the margin* | 90 generated + 4 anchors | ledgers 20/6 · bit flips 35/10 · ghostwriting 35/11 |
| ◉ | 26 in 9 documents by 7 authors | 20 in six anchors, 6 in three generated documents |
| શૂન્ય ઉપાડ… (gu) / शून्य को साथ (hi) | 14/6/4 · 8/4/3 | |

Built-in conditions: no document anywhere in 1940–1949; 12 Hip-hop documents in 1984–1993 without *carry the
zero*; every date precision (day, month, year, decade, circa, early 20th century, Vikram Samvat, undated,
scheduled 2027); a referenced date (A15 → 1911); an English/Spanish verse (A20).

## Loading

`demo-load` (the boot waits ≤ 10 s; it takes ≈ 0.2 s) reads these files through the ordinary import path
(adapter `demo` → `adapter-load` → DocumentWriter), applies the human layer (Reader B's rejection, Reader A's
second revision), tracks the tour's four expressions (`origin = 'demo'`) and queues the real pipeline: one
`materialize` per expression, `reuse-index` over `demo-world`, `cluster` for *carry the zero* and *flux up*, and
finally `adapter-load {adapter: 'demo', apply: 'deferred'}`, which reviews the cue citation A13→A3 (Reader A
confirms, Reader B rejects → disputed) and renames the "counted · hold · ones" context group once those rows
exist. What the pipeline has not produced yet is reported as pending (meta `demo_deferred`), never invented.

## Departures from SPEC §9

- The demo is 228 documents / 1,437 passages / 98,417 tokens (SPEC: ≈ 191 / 1,300 / 64k): the plan's per-sense
  document counts plus 60 background documents need that many.
- The street and room names *Wharf Road* and *Room Six* collided with MusicBrainz recording titles and were
  renamed *Saltwharf Road* and *the Brennock Room*.
- §9.4's `contested` pragmatic function is not in the `pragmatic_function` enum (vocab `DIMENSIONS`): that label
  is stored as the tag `contested` with no enum value.
