<!-- OWNER: WP2 — how the Cipher datasets become Scrolls rows (SPEC §6), what was measured, and where the build departs from the spec -->
# Cipher mapping

Scrolls reads the Cipher datasets **in place, read-only** (paths in `server/config.mjs` `CIPHER`; `SCROLLS_CIPHER_ROOT`
overrides the root). Every file an adapter reads is first copied into `originals/<sha[0:2]>/<sha256>` and each
document points at its bytes (`source_file_sha256`, `source_byte_start/end`: the TSV row, the JSONL line, or the whole
Gutenberg file). Adapters never write SQL; `server/jobs/tasks/adapter-load.mjs` drives their iterators into
DocumentWriter, and writes the two non-document tables (etymology, theme associations) itself.

Nothing here is ever fabricated: Cipher holds **no lyrics**, and none are created. Song "text" is the title.

## Collections (corpus `cipher`, kind `real`)

| Collection | Adapter | domain · modality · unit | sampling (lane header) |
|---|---|---|---|
| `cipher-culture-works` | `cipher.works` | culture · titles · works | prominence_selected — "Wikidata works ranked by sitelinks and canon lists" |
| `cipher-gutenberg` | `cipher.books` | literature · text · tokens | prominence_selected — "693 public-domain books chosen by Wikipedia sitelinks (prominence), en/fr/es" |
| `cipher-wikisource-hi`, `-gu` | `cipher.wikisource` | literature · text · tokens | curated — "Wikisource index books with transcribed pages" |
| (etymon tables) | `cipher.roots` | — | Wiktionary via kaikki.org, CC BY-SA |
| (`theme_assoc`) | `cipher.themes` | — | computed by Cipher |
| `cipher-music-relations` | `cipher.relations` | culture · titles · works, `rate_eligible = 0` | relation_endpoints — "works that appear in documented sample/cover/version links" |

Each collection's load status is meta `collection_status:<slug>`: `pending` (created, phase B has not reached it),
`indexing` (loading), `ready`. `/api/corpora` reports it; the timeline's `pending` cell state ("indexing — not yet
looked") should read it too.

## Culture works — `culture-works.tsv` (94,385 rows, no header, 16 columns, row = id)

One metadata document per row, `ext_id = cw:<row>`, `has_full_text = 0`.

| Column | Becomes |
|---|---|
| qid | `document_alias` (`Q…` Wikidata item or Cipher `S…` stub id) + `original_meta_json` |
| kind, culture | `document.kind`; `document.culture` (label "country of origin (Wikidata)" — never "community") |
| year | chronology `role = publication` through the date grammar: `''` (8,227 rows; `0` never occurs) → an explicit *unknown* chronology (undated); > today → basis `announced`, `chrono_status = scheduled` (28 rows, 2027–2038); negative → BCE (historical convention, 4 rows) |
| weight | `prominence` (+ `prominence_tercile` per kind, NTILE(3)); never an evidence weight |
| title, native title | `document_field` + passages, `field_class = title`, `time_role = document` — **the only text dated with the work** |
| maker | `author`, and one `doc_tag(maker, catalog)` per maker (Cipher joins several with ", "; a trailing "Jr." stays) |
| summary | `document_field` + passage `field_class = describes`, `time_role = describes`, plus `date_assertion(authored_description, 2012–2026, range, estimated)`; excluded from frequency by default |
| canon | `doc_tag(canon, documented_category)` |
| themes | `doc_tag(theme, weight)`: **machine_tag** when the theme is in the work's tagging batch (`$T/tags/*.jsonl`, matched on the folded phrase); **genre_heuristic** at weight exactly 0.55; otherwise **documented_category** |
| motifs | `doc_tag(motif, machine_tag)`, method "Cipher tagging pass (Claude sub-agent, Oct 2026)" |
| meaning | `annotation(kind = machine_gloss, is_machine = 1)` on the document, same method — not document text (2,950) |
| mood | `doc_tag(mood)`: genre_heuristic when every value is at 0.50, else machine_tag |
| siblings | relationships (below) |
| sampled_count | `original_meta_json` only |

**Why weight 0.55 is "a genre category name".** In Cipher's `build_culture.py` (`themes_from`) and `build_songs.py`
the only code path that writes 0.55 is the Wikidata genre (P136) label (subjects 1.0, "about" categories 0.9/0.8,
genre categories 0.6, settings 0.45, tagging-pass themes 1.0 − 0.08·position, film songs 0.35·w). Measured: 73,257
themes at 0.55, 1,829 distinct values — *drama, comedy, pop music, action, indian film music, …*.

Tag `method` strings are short because they are stored on ≈ 600k rows; their long forms are
`tags-provenance.mjs` `METHOD_NOTES`.

## Siblings → relationships (§6.6)

`row:relation:strength[:source]` items (76,447 measured). Cipher writes a link on both rows (the forward label on
one, the backward label on the other) and keeps each row's top 8, so a pair appears once or twice (69,936 items
have their reverse; 6,511 do not). Each label maps to a rel_type and a direction (src = later/dependent):

| Cipher label (row R, sibling S) | rel_type | src → dst |
|---|---|---|
| samples / sampled by | samples | R→S / S→R |
| interpolates / interpolated in | interpolates | R→S / S→R |
| cover of / covered as | cover_of | R→S / S→R |
| version of / other version | version_of | R→S / S→R |
| remix of / remixed as | remix_of | R→S / S→R |
| answer song to / answered by | answer_to | R→S / S→R |
| inspired by / inspired | inspired_by | R→S / S→R |
| from film, written for / features song, song from | part_of | R→S / S→R (the song is the part) |
| based on / adapted as | adaptation_of | R→S / S→R |
| remake of / remade as | remake_of | R→S / S→R |
| homage to / echoed by | homage_to | R→S / S→R |
| kindred, counterpart | kindred, counterpart (undirected; canonical src = the higher row) | — |

Items with the same (rel_type, src, dst, source code) collapse into one relationship (34,502 collapsed → 41,945
relationships). Evidence status is set once, by the source code:

| Source | evidence_status · origin | source_dataset · locator |
|---|---|---|
| `w` | documented · source_dataset | `wikipedia` · the article of the matching `relations_wiki.json` record (`https://<en|fr|es>.wikipedia.org/wiki/<page>`), else `source_unrecorded` |
| `m` | documented | `musicbrainz` · the `page` URL of the matching `relations_mb.json` record, else `source_unrecorded` |
| `i` | documented | `itwofs` (CC BY 2.5, link-back attribution on the row) · the matching `relations_itwofs.json` page, else `source_unrecorded` |
| `d` | documented | `wikidata` · `source_unrecorded` (Cipher did not record which item holds the statement) |
| kindred `-` | **computed** · algorithm | method `cipher-theme-cosine (build_culture.py)`, `run_id` = a synthetic `analysis_run(stage = 'cipher_load')` that records the provenance |
| counterpart `-` | **proposed** · machine_tagger | method "Cipher tagging pass or title match" |
| any other `-` | **proposed** · machine_tagger when the pair is named in either work's tagging batch (folded title or native title, year ±2 — `build_culture.py find()`); else **documented** · `wikidata-or-wikipedia` with `provenance_quality = source_unrecorded` and the note "Wikidata P144/P941/P4969, Wikipedia lead or remake/format table — source not recorded by Cipher" | |

**Locator join.** Title folded after removing "(…)", "[…]" and "feat. …" (as `build_songs.py norm()` does), at least
one shared credited artist on each end, years within ±1 where both are known (an unknown year does not block a
match — the raw `b` ends often have none). Measured: 2,085 of the 17,492 w/m/i relationships get a locator; the rest are
`DOC*` (most `from film [w]` links come from soundtrack crawls that are not in the three raw files).

Every score is `{value: strength, kind: heuristic_strength}` ("Cipher heuristic weight — not a probability").
`date_conflict = 1` when a precedence-requiring link points from an earlier to a later work (615 measured).

## Music relations — the documented genealogy (`cipher.relations`, phase A2)

`songs/relations_{mb,wiki,itwofs}.json` (161,803 + 9,581 + 428 records, 198,098 distinct endpoints). An endpoint is
keyed by its MusicBrainz recording (`mb:<uuid>`), its Wikidata item (`wd:Q…`) or `t:<fold title>|<fold artist>|<year>`.
An endpoint that **is** a culture work — the same Wikidata item, or folded title (no "(…)"/"feat.") + a shared credited
artist with years ±1 (an unknown year does not block; two candidate works = ambiguous, not aliased) — becomes an
**alias** of that work (19,084), never a second document; the other 179,014 endpoints are metadata documents in
`cipher-music-relations` (title passage, `release` date with rule `cipher.relations.year`, note "year as recorded by
Cipher from MusicBrainz/Wikipedia; may be a first-release year"). Each record → one relationship, **documented** by
its own `page` (`source_dataset` musicbrainz / wikipedia / itwofs, CC BY 2.5 link-back for ItwoFS); 169,302 created.
The 8 ItwoFS rows of `itwofs.com/coincidence.html` are left out (fix pass, §13 rules 5–6): Cipher's scraper labels every
ItwoFS row "inspired by" (the coincidence rows alone with strength 0.4), but that page lists songs that sound alike by
coincidence, so it states a resemblance, not an inspiration; the probe counts them (`left_out`). A database loaded before
this rule keeps those 8 `inspired_by` rows (relationships are never deleted, §3); a reader can reject them in review.
A record that restates a culture-works sibling link (same rel_type, ends and source) does not make a second
relationship: the sibling relationship gains an `external_record` evidence row and an `add_evidence` revision (2,439).
Measured: phase A2 ≈ 58 s (179k documents + 169k relationships through DocumentWriter).

## Gutenberg books (§6.3)

693 JSON entries, **691 documents**: #1661 is listed three times (three Wikidata items, one text) → one document
(the most-linked entry, *The Adventures of Sherlock Holmes*) + 2 aliases `wd:Q265546`, `wd:Q1151748`.

- **Body bounds** (`gutenberg-text.mjs`): `*** START OF (THE|THIS) PROJECT GUTENBERG…` with or without the space
  after `***` (660 + 28 files); the old "SMALL PRINT" header (`***START**THE SMALL PRINT` … `*END*THE SMALL PRINT…*END*`,
  3 files: #1619, #2316, #3420) whose body ends before the last "End of [the|this] Project Gutenberg Etext" line;
  no marker → whole file + `W_NO_GUTENBERG_MARKERS` (0 files). The BOM (187 files) is stripped; all 691 decode as UTF-8.
- **Regions:** paragraphs inside the body matching `project gutenberg|gutenberg-tm|small print|this ebook is for the
  use of`, plus the old licence's "etext" and the canary phrase "computer virus, or computer codes" → `quality =
  boilerplate` (509 passages). Editorial apparatus (PREFACE, INTRODUCTION, TRANSCRIBER'S NOTE… in the first 15% /
  last 10% of the body that name another person in their first lines, carry a year > y_hi + 5, or are a
  transcriber's note; footnotes with such a year) → `time_role = field_class = apparatus` (4,227 passages; e.g.
  Saintsbury's 1894 preface to *Pride and Prejudice*).
- **Language:** `lang_declared` from the JSON; DocumentWriter detects `lang_text` and marks `is_translation` when
  ≥ 70% of tokens read as another language with confidence ≥ 0.6. Measured: **101 fr, 2 es, 2 en** books flagged.
- **Dates:** the JSON year with `role = publication` (DocumentWriter turns it into `original_publication` for a
  translation): `basis = estimated`, `rule = cipher_lifetime_year`, note "Cipher's author-lifetime estimate … it may
  coincide with the true date" when year = first catalogue author's birth + 40 (**116** books); otherwise `basis =
  stated`, note "Cipher list year (Wikidata-derived), unverified". 8 books have no year → explicit unknown chronology.
  The catalogue's `Issued` → `role = release`, `is_chronology = 0` (it would otherwise be picked as chronology).
- **Tags and field:** LoCC classes and subjects → `doc_tag(locc|subject, catalog)`; `field` = the STEMM lane of the
  first Q/R/T class (`data/field-taxonomy.json`): *Flatland* (QA → mathematics), *Opticks* (QC → physical-sciences),
  *The Descent of Man* (QH) and *Lobo, the King of Currumpaw* (QL) → life-sciences, *The Principles of Scientific
  Management* (T) → engineering-technology.

## Wikisource (§6.4)

`ext_id = ws-<lang>:<index>`; pages joined with `\f` (`decoder = pages-joined-ff`), `page_no` per passage; the JSONL
line (pages replaced by a pointer) is `original_meta_json`. Dates `role = publication_unspecified`, basis stated,
note "Wikisource index year; may be an edition year"; `null` → undated (hi 42, gu 172). 132 hi and 133 gu records
have no transcribed pages: metadata-only documents; 6 of the hi ones have no title either and take the index file
name as title (with an issue saying so). The first two pages are `front_matter` when together they average < 30
tokens per non-blank line (SPEC §4.3 wording; hi 1,086 and gu 1,726 passages).

## Etymology and themes (§6.7)

`roots.tsv` → `etymon` (54,989), `etymon_parent` (19,315, `ord` kept), `etymon_member` (103,252; rank = Cipher's
"commonest first" order), `label_tri(kind = etymon)`. `parent_semantics`: none 38,558 · single 14,206 ·
**listed_chain 704** (a `sa:` dhātu and an `ine-pro:` root) · **listed_variants 351** (all forms within edit distance 2
of the first) · **listed_unresolved 1,170** — exactly the measured classes of SPEC §0.1. Words are never dated by
etymology. Descent edges stay virtual (Wiktionary locator from `roots.mjs wiktionaryLocator`).

`culture-themes.tsv` → `theme_assoc` (26,640 pairs) + `label_tri(kind = theme)` (4,213). The stored value is Cipher's
association strength, **NPMI shrunk by a shared-count factor** (`min(1, npmi·(0.6 + 0.4·min(1, ln shared/ln 40)))`,
pairs sharing ≥ 3 works with npmi ≥ 0.2), i.e. computed by Cipher, not raw NPMI. `culture-lines.tsv`, `hinges.tsv`
and Loom lines are not imported.

## Bootstrap (§6.8) — `bootstrap-cipher`

| Step | Contents | Measured (this Mac, real files, temp data dir) |
|---|---|---|
| A · metadata | works (+ siblings, glosses) → themes → roots, one job | **≈ 37 s** (target ≤ 30 s — not met, see below) |
| A2 · genealogy | relation endpoints in ≈ 20 s chunks, then aliases + relationships | ≈ 58 s (target: A + A2 ≤ 60 s — not met) |
| B · full text | Gutenberg → Wikisource hi → gu in ≈ 20 s chunks (one job each in the server), then WP5's `boilerplatePass`, then FTS `optimize` | ≈ 2 min |
| total | | **≈ 3 min 45 s** with A2 (target ≤ 10 min) |

In the server each step is its own job (the next one is enqueued at the end), so interactive writers (materialize,
imports) get the single writer lock between chunks; `npm run bootstrap` (`scripts/bootstrap-cipher.mjs --data <dir>`)
runs every step in one process and prints timings and the reconciliation. Every step is resumable (it reads what is
committed; records the writer refuses are remembered and not retried). Phases are reported as `A · metadata` and
`B · full text` (health maps them to `metadata` / `fulltext`), with the toast message "Cipher titles, relations and
etymology are ready" at the end of A. Cancellation is checked between records and rolls the current batch back.

**Reconciliation** (written into the `metrics_json` of an `analysis_run(stage = 'bootstrap-cipher')`, asserted by
`tests/cipher-mapping.test.mjs`): 94,385 works · 8,227 undated · 28 scheduled · 691 Gutenberg + 2 aliases · 116
lifetime estimates · fr translations 101 · Wikisource 450 / 375, undated 42 / 172 · relationships by (rel_type,
evidence_status) equal the parsed and collapsed sibling pairs (`match: true`) · kindred 14,728 computed ·
counterpart 476 proposed · **0** `quality = ok` passages with the licence sentence (canary) · 54,989 etymons.

## Departures from the spec, and why

1. **Phase A ≈ 37 s, not ≤ 30 s.** 94,385 documents × ≈ 35 inserts each through DocumentWriter (document, fields,
   passages + FTS, 3 date assertions + R-tree, 4 bins, tokens, alias, ≈ 7 tags, trigram labels). Profiled: ≈ 29 s
   are inside the writer (one `db.exec('SAVEPOINT …')`/`RELEASE` per document ≈ 5 s, contract validation ≈ 1.5 s).
   This package already disables automatic WAL checkpoints during phase A (−4 s). Reaching 30 s needs writer
   changes (WP0).
2. **es translations: 2, not ≥ 5.** Five more Spanish-declared books are bilingual school editions (Spanish text
   with English notes, e.g. *La moza de cántaro* en 0.53 / es 0.32); the 70% majority rule leaves them as mixed-
   language documents, and passage-level language keeps their English apart anyway.
3. **Phase A2 ≈ 58 s**, so A + A2 ≈ 95 s against "≤ 60 s total from start" — the same writer cost, 179k documents.
4. **Wikisource front matter** follows the §4.3 wording literally (< 30 tokens per line over the first two pages).

## STEMM adapters (staged sources, phase C — user-triggered)

Each reads `MANIFEST.json` and `FORMAT.md` first and, when a file or a described field is missing, reports
`{available: false, reason}` (the Adapters page shows the fetch command; nothing here fetches). The four sources were
revised after audits on 2026-10-04 (gutenberg-stemm: `pg_rights`/`text_export_allowed`, body offsets, residue flags;
wiktionary-coinage: selector/extractor v2, `field_evidence`, `alternatives`, revised derivations); the adapters follow
the revised formats.

### Loading (the Adapters page): chained jobs, progress, cancel, resume

`POST /api/adapters/:id/load` queues `adapter-load`. The two document sources (gutenberg-stemm, OpenAlex) load as a
**chain**: each job loads ≈ 20 s of documents (one import batch), or ≤ 20,000 OpenAlex citations (one batch, resolved
in one transaction), then queues the next job — the bootstrap's pattern, so the single writer lock is never held for
minutes and materialize/import jobs run between chunks. The chain's state is meta `adapter_load:<id>` (`root` job,
`part`, `phase` documents → relationships → done, per-collection resume cursors, accumulated counts, coverage);
`GET /api/adapters` returns it as `load` plus the live `job`, and every chunk emits an `adapter` SSE event
`{id, loaded, staged, message, job, progress}` naming the next job. A second Load while a chain is live answers with
the live job. **Cancel** (`POST /api/jobs/:id/cancel` on the current chunk) rolls that chunk's batch back (batch status
`cancelled`), stops the chain and keeps the committed chunks (load status `cancelled`, collections `partial`); a
failed or interrupted chain is reported the same way. **Load again** starts a new chain that skips every committed
ext_id (and, for citations, every pair already written), so nothing is ever duplicated. Collections are `indexing`
while a chain runs and `ready` at its end (meta `collection_status:<slug>`, read by `/api/corpora` and the timeline's
pending lanes). Wiktionary loads in one job; the Ngram store has nothing to load.

| Adapter | Becomes | Honesty rules as built |
|---|---|---|
| `stemm.gutenberg-stemm` | `stemm-gutenberg` (684 public-domain texts) and `stemm-gutenberg-restricted` (the 20 texts Gutenberg marks *Copyrighted* in `pg_rights`; `text_export_allowed` false → collection `export_text_allowed = 0`: readable and searchable here, never exported); `ext_id = pgs:<id>`; periodical issues are `kind = periodical` | The original is the whole decoded file; `body_start_byte`/`body_end_byte` become UTF-16 body bounds (D4). sha256 checked (mismatch → `W_SHA_MISMATCH`, row skipped); a row without a file → metadata-only document. **Residue** the catalogue's bounds leave in the body is flagged, never deleted (`cipher/gutenberg-text.mjs`, shared with Cipher books): producer credits and Distributed Proofreaders lines in the first 5% → `boilerplate`; bracketed `[Transcriber's Note: …]` (anywhere, nested brackets counted), a "Transcriber's Note(s)" heading with the note-like blocks under it (to the body end in the last 10%, or to an explicit "[End Transcriber's notes]"), ASCII boxes about the e-text, and transcription-convention notes ("Text printed in italics has been transcribed between _underscores_", "Images of the original pages are available through Internet Archive") near either end → `apparatus`. Measured on the shelf: all 207 `credits-at-start` files get a credits region; 788 transcriber regions in 452 files, 0.08% of body characters; the author's text after a short note is never swallowed. **Dates by basis**: title-stated / MARC 906 / Wikidata P577 / work P577 → `stated` at their precision (a whole decade → `decade`; a two-month issue → its two months, noted); author-lifetime estimate → `estimated` range (striped), noted "estimated from the first author's life dates … not evidence"; `unknown` → undated; historical years → astronomical (#64207: −6 … 50 → −5 … 50); `gutenberg_issued` → `release`, never chronology; `date_disagreement_years > 5` → note. Over the catalogue the bases equal MANIFEST `by_basis` exactly (stated 417 · estimated 227 · undated 60). The **coverage line** of what is loaded ("dated by evidence X · lifetime estimate Y · undated Z · after 1928 W") is written into the collection's caveats at the end of each load; `/api/corpora` also gives every collection `dating` counts. The 5 Cipher books on the STEMM shelf (`cipher-overlap.jsonl` `stemm: true`) become aliases `pgs:<id>` of the Cipher document, never duplicates. |
| `stemm.openalex` | `stemm-openalex` (works, `top_cited_per_cell`, coverage gate 20 sampled works, `export_text_allowed = 0`); `ext_id = oa:W…` | **Within-cell sampling design (§10.4):** a work's cell is its OpenAlex field (the `field` doc_tag, provenance `adapter_machine`) × the one of OpenAlex's own 30 bins holding its year (`openalex.mjs` `BINS`, `cellOf`) — equal to the fetcher's `sample_cell` for all 118,466 works (tested); `original_meta.sample_cell` keeps it. At the end of a load the 600 cells of `coverage.tsv` (field, bin, `population` = the denominator OpenAlex reports, `fetched`, `with_abstract`) are written to meta `stemm-openalex.cells`, so lanes can say "sample 200 of 14,516 works in OpenAlex for Mathematics 1875–99". Cross-cell rates stay refused downstream (`sampling_design`). **Abstracts** are the body with `field_class = abstract`: `gappy` when index gaps exceed 10% of tokens (74 works) or the "abstract" runs over 1,000 tokens (259 body excerpts), `low` under 10 tokens (junk such as "Volume: 4"); gappy and low passages are excluded from counts and from quotation detection; the text is publishers' — `export_text_allowed = 0`. The writer runs with `dedupe = off` for this source: every work is a distinct sampled work, and flagging an identical abstract as a duplicate would drop it from its cell's share. `field/subfield/topic` → `doc_tag(adapter_machine)` with method "OpenAlex classifier" ("… a modern classifier's guess for a pre-1900 work" before 1900); keywords "OpenAlex keywords (machine-derived)". **Citations** between loaded works → `explicit_citation`, documented, `source_dataset = openalex`, locator `https://openalex.org/<citing>`; 381,800 pairs in the file, 6,666 citing a later-dated work → `date_conflict = 1` and a note "a date conflict, not feedback" (never a feedback arc). Dates: `publication_date` at the fetcher's `date_precision`; every date note "OpenAlex year may be a reprint or digitisation year"; 31 December → "possible placeholder date". `lang_declared` is left empty so detection decides `lang_text` (`de` included); OpenAlex's own code stays in meta. Load params: `fields`, `years`, `abstracts`. |
| `stemm.wiktionary` | claims on tracked expressions; one `stemm-wiktionary` document per distinct etymology text of their entries | Load = build `derived/wiktionary/word-index.json` (one scan of the 208 MB `terms.jsonl`, ≈ 3.5 s; sidecar `word-index.source.json`) and attach claims to every tracked **real** word/phrase expression (synthetic and demo expressions never get external claims), or to one (`{expressionId}`) or to given `{words}`. A claim is one date statement, stated once even when a noun and a verb share the etymology (`entry_ids` lists both), labelled "Wiktionary: <relation> <date> (external claim)" ("… (one of these) …" for `alternatives`; BCE kept astronomical inside). **Display:** `default` only for a statement about the headword (`subject_hint = headword`), not sense-specific (nor a span such as "First use in the computer context …"), on an entry spelled like the query that is not a proper noun, whose sentence names no other language first; `dimmed` otherwise, with its reasons; `other-language-context` never. A coinage template's year argument is a `dimmed` claim, dropped when the prose shows it dates another language's word (genome ← German *Genom* 1920). Written as `date_assertion(subject = expression, role = first_attestation_claim, basis = stated, asserted_by = wiktionary, is_chronology = 0)` whose note is the claim's JSON (`claimNote`, read back by `claimFromAssertion`), with the entry document and passage; statements with an open bound ("before 1900") are not written (an interval needs both ends) but the lookup lists them. Entry documents: the `entry` field (verbatim etymology text, ≤ 800 UTF-16 units, CC BY-SA) is their only passage (`describes`, excluded from frequency; no title passage, so the headword is never an occurrence), undated chronology plus an `authored_description` range 2002–dump year; field tags say sense-level or "entry-level (weaker: page-wide)". `GET /api/adapters/stemm.wiktionary/claims?expr=<id>` returns the written claims with `highlight {passage, start, end}` when the span lies in the stored excerpt; `?word=&lang=` looks a word up in the index. Never an occurrence; never moves a bar. |
| `stemm.ngram` | no documents; `GET /api/baseline?word=&from=&to=&lang=` | Read-only store, `meta.complete = '1'` required. Blobs decode as raw DEFLATE of 520 little-endian u32 (FORMAT.md). Per decade: Σ counts / Σ corpus tokens × 10⁶ (never averaged ratios), corpus books as the evidence base, decades under 500 books flagged `thin`; capitalised `top_form` → "proper-noun or sentence-initial uses may dominate this curve"; multi-word → "single words only"; a hyphenated row (`x-ray`, `hip-hop`) → "split by Google's tokenizer …"; decades before 1800 → OCR caveat (+ long s for words with *s*); another `lang` → "The Ngram store holds English words only."; `first_year` is never a coinage date. Checked: *virus* 1820s = 1.07 per million, as SPEC §7.2. |

### Measured loads (2026-10-04, a private copy of the M1 snapshot: demo + full Cipher; machine load average ≈ 600–1,000)

| Load | Result | Time |
|---|---|---|
| gutenberg-stemm | 704 documents (684 + 20 restricted), 1,021,950 passages, 64.7M tokens; dated by evidence 417 · lifetime estimate 227 · undated 60 · after 1928 42; 0 translations (en 626 · fr 69 · es 9, as declared); 270 + 157 boilerplate passages, 14,858 apparatus passages; 5 aliases on Cipher books; 2 `W_MIXED_LANGUAGE` | 35 chunks, 760 s (an earlier run at load ≈ 20: 15 chunks, 304 s) |
| OpenAlex | 118,466 works (57,892 without an abstract = FORMAT.md), 211,389 passages (3,926 `gappy`, 1,863 `low`), 9.9M abstract tokens; 381,800 documented citations in 20 batches, **6,666 with `date_conflict = 1`**; 600 cells in meta; lang_text en 77,930 · `und-Latn` 28,539 (titles too short to identify) · de 6,080 · fr 1,394 | 20 chunks (16 document, 4 citation), 404 s; Load again: 0 added, 16 s |
| Wiktionary | word index ≈ 1.3–3.5 s; tracked *virus* → 1 entry document (noun and verb share it), 1 claim "Wiktionary: first used 1972 (external claim)", **dimmed** ("dates one sense or use, not the word": the span is "First use in the computer context …") | 1.3 s |
| Ngram | nothing to load; `/api/baseline` ≈ 20 ms | — |

With `dedupe = flag`, the writer reloads every near-duplicate signature and metadata key of the collection at the start of each batch: OpenAlex chunks fell from ≈ 5,300 to ≈ 330 works per 20 s by 70,000 works, and a cancel could not be honoured inside that synchronous load: after its 10 s grace the queue terminated the worker, whose write lock then stayed held until the server was killed (a DocumentWriter/queue issue reported to WP0). `dedupe = off` for OpenAlex removed both symptoms for this source.
